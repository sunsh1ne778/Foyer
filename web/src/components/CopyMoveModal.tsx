import React, { useState } from 'react';
import { X, Copy, Move, ArrowRight, Zap, Layers, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';

export const CopyMoveModal: React.FC = () => {
  const {
    isCopyMoveOpen,
    setIsCopyMoveOpen,
    copyMoveTarget,
    isCopyMoveMoveMode,
    mounts,
    executeCopyMove
  } = useFileStore();

  const [targetMount, setTargetMount] = useState<string>(mounts[0]?.name || 'photos');
  const [targetDirectory, setTargetDirectory] = useState<string>('/');

  if (!isCopyMoveOpen || !copyMoveTarget) return null;

  const srcRef = `${copyMoveTarget.mount_name}:${copyMoveTarget.key}`;
  const isCrossMount = copyMoveTarget.mount_name !== targetMount;
  const srcMountObj = mounts.find(m => m.name === copyMoveTarget.mount_name);
  const dstMountObj = mounts.find(m => m.name === targetMount);

  const canNativeCopy = !isCrossMount && (isCopyMoveMoveMode ? srcMountObj?.caps.move : srcMountObj?.caps.copy);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let cleanDir = targetDirectory.trim();
    if (!cleanDir.startsWith('/')) cleanDir = '/' + cleanDir;
    if (cleanDir.endsWith('/') && cleanDir.length > 1) cleanDir = cleanDir.slice(0, -1);

    const dstKey = cleanDir === '/' ? `/${copyMoveTarget.name}` : `${cleanDir}/${copyMoveTarget.name}`;
    const dstRef = `${targetMount}:${dstKey}`;

    await executeCopyMove(srcRef, dstRef, isCopyMoveMoveMode);
    setIsCopyMoveOpen(false);
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-lg overflow-hidden shadow-xl font-sans">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            {isCopyMoveMoveMode ? (
              <Move className="w-5 h-5 text-indigo-600" />
            ) : (
              <Copy className="w-5 h-5 text-indigo-600" />
            )}
            <h3 className="font-semibold text-sm text-slate-900">
              {isCopyMoveMoveMode ? '移动文件' : '复制文件'}
            </h3>
          </div>
          <button
            onClick={() => setIsCopyMoveOpen(false)}
            className="p-1 rounded-md hover:bg-slate-200/70 text-slate-400 hover:text-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {/* Source Node */}
          <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 font-mono">
            <span className="text-slate-500 text-[11px] font-sans block">源节点:</span>
            <span className="text-indigo-700 font-bold">{srcRef}</span>
          </div>

          {/* Destination Selection */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-slate-700 font-medium block mb-1">目标存储挂载:</label>
              <select
                value={targetMount}
                onChange={e => setTargetMount(e.target.value)}
                className="w-full bg-white border border-slate-250 rounded-lg px-2.5 py-1.5 text-slate-800 font-mono focus:outline-none focus:border-indigo-500"
              >
                {mounts.map(m => (
                  <option key={m.name} value={m.name}>
                    {m.name}: ({m.type})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-slate-700 font-medium block mb-1">目标目录前缀:</label>
              <input
                type="text"
                value={targetDirectory}
                onChange={e => setTargetDirectory(e.target.value)}
                placeholder="/ 或 /archive"
                className="w-full bg-white border border-slate-250 rounded-lg px-2.5 py-1.5 text-slate-800 font-mono focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Result preview */}
          <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 flex items-center justify-between text-xs font-mono">
            <span className="text-[11px] text-slate-500 font-sans">目标结果:</span>
            <span className="text-emerald-700 font-bold">
              {targetMount}:{targetDirectory === '/' ? '' : targetDirectory}/{copyMoveTarget.name}
            </span>
          </div>

          {/* Architecture Strategy Banner */}
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-slate-700 text-xs">
              <Zap className="w-3.5 h-3.5 text-amber-500" />
              <span>VFS 调度执行策略:</span>
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              {canNativeCopy ? (
                <span className="text-emerald-700">
                  同存储挂载且具备驱动原生能力 (Caps.Copy=true)，底层直接快速拷贝，接口同步返回 200 OK。
                </span>
              ) : (
                <span className="text-amber-700">
                  {isCrossMount ? '跨挂载存储操作' : '驱动无直接原生拷贝能力'}。请求将自动投递至 Asynq 队列，接口返回 202 Accepted + job_id，由后台 Worker 执行流式传输。
                </span>
              )}
            </p>
          </div>

          {/* Footer */}
          <div className="pt-2 border-t border-slate-200 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsCopyMoveOpen(false)}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors"
            >
              {isCopyMoveMoveMode ? <Move className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{isCopyMoveMoveMode ? '执行移动' : '执行复制'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
