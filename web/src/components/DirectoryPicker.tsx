import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Folder, HardDrive, ArrowUp, ChevronRight, Loader2, ShieldAlert } from 'lucide-react';
import { foyerBrowse } from '../api/jfs';
import type { FoyerBrowseEntry, FoyerBrowseResult } from '../api/jfs';
import { hostPathSegments } from '../utils/hostPath';

type Props = {
  open: boolean;
  initialPath?: string;
  onSelect: (hostPath: string) => void;
  onClose: () => void;
};

/**
 * load 的三态结果。必须区分「真的失败」与「被更新的请求取代 / 组件已卸载」：
 * 前者才该触发盘符列表回退，后者回退会吞掉用户点击、或对已卸载组件继续发请求。
 */
type LoadResult = 'ok' | 'failed' | 'stale';

export const DirectoryPicker: React.FC<Props> = ({ open, initialPath, onSelect, onClose }) => {
  const [path, setPath] = useState('');
  const [data, setData] = useState<FoyerBrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // 请求令牌 + 存活标记：既防止迟到的旧响应覆盖新目录，也保证卸载后不再 setState。
  const aliveRef = useRef(true);
  const reqRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async (target: string): Promise<LoadResult> => {
    // 卸载后连请求都不该发：这里在执行任何 setState 之前就退出。
    if (!aliveRef.current) return 'stale';
    const req = ++reqRef.current;
    setLoading(true);
    setError('');
    try {
      const res = await foyerBrowse(target);
      if (!aliveRef.current || req !== reqRef.current) return 'stale';
      setData(res);
      setPath(res.path);
      return 'ok';
    } catch (err) {
      if (!aliveRef.current || req !== reqRef.current) return 'stale';
      setError(err instanceof Error ? err.message : '读取目录失败');
      return 'failed';
    } finally {
      if (aliveRef.current && req === reqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const start = (initialPath || '').trim();
    void (async () => {
      const first = await load(start);
      // 只有「真的失败」才回退到盘符列表。'stale'（被取代或已卸载）不回退：
      // 否则会 supersede 掉用户刚点的目录，甚至在卸载后再发一次请求。
      if (start && first === 'failed' && active) await load('');
    })();
    return () => {
      active = false;
    };
  }, [open, initialPath, load]);

  // Esc 关闭；与背景点击一致。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const crumbs = hostPathSegments(path);
  const entries: FoyerBrowseEntry[] = data?.entries || [];
  const drives = data?.drives || [];
  const currentDrive = drives.find(d => path.toUpperCase().startsWith(d.toUpperCase()));

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-[60] animate-in fade-in duration-150 font-sans"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-lg overflow-hidden shadow-xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            <Folder className="w-5 h-5 text-indigo-600" />
            <h3 className="font-semibold text-sm text-slate-900">选择宿主机目录</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md hover:bg-slate-200/70 text-slate-400 hover:text-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Nav：盘符列表层级没有路径可拆，面包屑整个不出现；加载失败时不渲染，
            避免把上一个目录的面包屑/盘符留在屏幕上误导用户。 */}
        {path && !error && (
          <div className="px-4 py-2 border-b border-slate-200 bg-white space-y-2">
            <div className="flex flex-wrap items-center gap-1">
              {drives.map(d => (
                <button
                  key={d}
                  type="button"
                  disabled={loading}
                  onClick={() => void load(d)}
                  className={`text-[11px] font-mono px-2 py-0.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    currentDrive === d
                      ? 'bg-indigo-50 border-indigo-300 text-indigo-700 font-bold'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <button
                type="button"
                disabled={loading}
                onClick={() => void load(data?.parent || '')}
                className="p-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                title="上级目录"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <div className="flex items-center gap-0.5 flex-wrap font-mono text-slate-600">
                {crumbs.map((c, i) => (
                  <span key={c.value} className="flex items-center gap-0.5">
                    {i > 0 && <ChevronRight className="w-3 h-3 text-slate-300" />}
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void load(c.value)}
                      className="hover:text-indigo-600 hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
                    >
                      {c.label}
                    </button>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-2 min-h-48">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-slate-400 text-xs">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>读取中…</span>
            </div>
          )}

          {!loading && error && (
            <div className="m-2 p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && !path && (
            <div>
              <p className="px-2 py-1.5 text-[11px] text-slate-400">选择要挂载的磁盘：</p>
              {drives.length === 0 && (
                <p className="px-2 py-3 text-xs text-amber-700">
                  没有检测到已绑定的盘符，请用 scripts/run-foyer.ps1 重建容器。
                </p>
              )}
              {drives.map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => void load(d)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs text-slate-700 hover:bg-indigo-50 hover:text-indigo-800"
                >
                  <HardDrive className="w-4 h-4 text-slate-400" />
                  <span className="font-mono">{d}</span>
                </button>
              ))}
            </div>
          )}

          {!loading && !error && path && (
            <div>
              {entries.length === 0 && (
                <p className="px-2 py-3 text-xs text-slate-400">该目录下没有子目录。</p>
              )}
              {entries.map(e => (
                <button
                  key={e.path}
                  type="button"
                  onClick={() => void load(e.path)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs text-slate-700 hover:bg-indigo-50 hover:text-indigo-800"
                >
                  <Folder className="w-4 h-4 text-indigo-400 shrink-0" />
                  <span className="truncate">{e.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-slate-200 bg-slate-50/50 space-y-2">
          <div className="text-[11px] font-mono text-slate-500 truncate" title={path}>
            {path || '（未选择盘符）'}
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!path || loading || !!error}
              onClick={() => onSelect(path)}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors disabled:bg-slate-300"
            >
              选择此目录
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
