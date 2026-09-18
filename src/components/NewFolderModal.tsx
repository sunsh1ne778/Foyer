import React, { useState } from 'react';
import { X, FolderPlus, Info } from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';

export const NewFolderModal: React.FC = () => {
  const { isNewFolderOpen, setIsNewFolderOpen, currentMount, currentPath, createFolder } = useFileStore();
  const [folderName, setFolderName] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  if (!isNewFolderOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (!folderName.trim()) {
      setErrorMsg('目录名称不能为空');
      return;
    }

    const ok = createFolder(folderName.trim());
    if (!ok) {
      setErrorMsg('同名目录已存在或包含非法字符');
      return;
    }

    setFolderName('');
    setIsNewFolderOpen(false);
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden shadow-xl">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            <FolderPlus className="w-5 h-5 text-indigo-600" />
            <h3 className="font-semibold text-sm text-slate-900">新建目录</h3>
          </div>
          <button
            onClick={() => setIsNewFolderOpen(false)}
            className="p-1 rounded-md hover:bg-slate-200/70 text-slate-400 hover:text-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs font-sans">
          <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 font-mono">
            <span className="text-slate-500 text-[11px] block font-sans">所在路径:</span>
            <span className="text-indigo-700 font-bold">{currentMount}:{currentPath}</span>
          </div>

          <div className="space-y-1.5">
            <label className="text-slate-700 font-medium block">目录名称:</label>
            <input
              type="text"
              required
              autoFocus
              placeholder="例如: archive, 2026_q3, raw_clips"
              value={folderName}
              onChange={e => setFolderName(e.target.value)}
              className="w-full bg-white border border-slate-250 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 font-mono"
            />
            {errorMsg && <p className="text-rose-600 text-[11px]">{errorMsg}</p>}
          </div>

          <div className="text-[11px] text-slate-500 flex items-start gap-2 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
            <Info className="w-3.5 h-3.5 text-indigo-600 shrink-0 mt-0.5" />
            <span>
              若挂载存储具备 Directory 原生能力 (如 NAS/本地磁盘)，将创建物理真实目录；若为对象存储 (S3/OSS)，则在 PG 索引中投影目录节点。
            </span>
          </div>

          <div className="pt-2 border-t border-slate-200 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsNewFolderOpen(false)}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>确认创建</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
