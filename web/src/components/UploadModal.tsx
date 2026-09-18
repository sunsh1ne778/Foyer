import React, { useState } from 'react';
import {
  X,
  UploadCloud,
  File,
  CheckCircle2,
  AlertCircle,
  Zap,
  Server,
  Layers,
  Database
} from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';
import { formatBytes } from '../utils/formatters';

export const UploadModal: React.FC = () => {
  const {
    isUploadOpen,
    setIsUploadOpen,
    currentMount,
    currentPath,
    getCurrentMountObj,
    uploadFile,
    writeSessions
  } = useFileStore();

  const [filesToUpload, setFilesToUpload] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  if (!isUploadOpen) return null;

  const mountObj = getCurrentMountObj();
  const isPresignMode = mountObj?.caps.presign;

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const list = Array.from(e.target.files);
      setFilesToUpload(list);
    }
  };

  const handleStartUpload = async () => {
    if (filesToUpload.length === 0) return;
    setIsUploading(true);
    for (const file of filesToUpload) {
      await uploadFile(file);
    }
    setIsUploading(false);
    setFilesToUpload([]);
    setIsUploadOpen(false);
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-lg overflow-hidden shadow-xl">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            <UploadCloud className="w-5 h-5 text-indigo-600" />
            <h3 className="font-semibold text-sm text-slate-900">上传文件到存储</h3>
          </div>
          <button
            onClick={() => setIsUploadOpen(false)}
            disabled={isUploading}
            className="p-1 rounded-md hover:bg-slate-200/70 text-slate-400 hover:text-slate-700 transition-colors disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-xs font-sans">
          {/* Target Ref */}
          <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 font-mono">
            <div className="text-slate-500 text-[11px] font-sans">目标统一路径 (mount:path):</div>
            <div className="text-indigo-700 font-bold mt-0.5">
              {currentMount}:{currentPath === '/' ? '/' : currentPath + '/'}
            </div>
          </div>

          {/* VFS Write Protocol Strategy Explanation */}
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-slate-700">
              <Zap className="w-3.5 h-3.5 text-amber-500" />
              <span>传输策略调度 (Driver.Caps.Presign):</span>
            </div>
            <div className="text-[11px] text-slate-500 leading-relaxed">
              当前存储驱动为 <strong className="text-slate-800 font-mono">{mountObj?.type}</strong>。
              {isPresignMode ? (
                <span className="text-emerald-600">
                  {' '}支持预签名直传 (307 Redirect) — 客户端直连云存储分片直传，零网关带宽损耗。
                </span>
              ) : (
                <span className="text-blue-600">
                  {' '}无预签名能力 (Stream Proxy) — 客户端通过 API 网关管道分块流式上传。
                </span>
              )}
            </div>
          </div>

          {/* File Selection Box */}
          <div className="border-2 border-dashed border-slate-250 hover:border-indigo-500 rounded-xl p-6 text-center cursor-pointer transition-colors bg-slate-50/50 hover:bg-indigo-50/30 relative">
            <input
              type="file"
              multiple
              disabled={isUploading}
              onChange={handleFileSelect}
              className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
            />
            <UploadCloud className="w-8 h-8 mx-auto mb-2 text-indigo-500" />
            <p className="text-xs text-slate-700 font-medium">
              点击选择或拖拽文件到此区域
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              支持任意文件类型，上传完成后写透 PostgreSQL 投影索引
            </p>
          </div>

          {/* Selected Files List */}
          {filesToUpload.length > 0 && (
            <div className="space-y-1.5 max-h-36 overflow-y-auto">
              <div className="text-slate-500 text-[11px]">待上传文件 ({filesToUpload.length}):</div>
              {filesToUpload.map((f, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between p-2 rounded bg-slate-50 border border-slate-200 text-slate-700"
                >
                  <div className="flex items-center gap-2 truncate font-medium text-xs">
                    <File className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="truncate">{f.name}</span>
                  </div>
                  <span className="text-slate-500 shrink-0 text-[11px] font-mono">{formatBytes(f.size)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-200 bg-slate-50/50 flex items-center justify-between">
          <span className="text-[11px] text-slate-400 font-mono">
            {filesToUpload.length > 0 ? `已选 ${filesToUpload.length} 个文件` : '未选择文件'}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsUploadOpen(false)}
              disabled={isUploading}
              className="px-3 py-1.5 rounded-lg border border-slate-250 hover:bg-slate-100 text-slate-700 text-xs font-medium transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleStartUpload}
              disabled={isUploading || filesToUpload.length === 0}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors disabled:opacity-50"
            >
              <UploadCloud className="w-3.5 h-3.5" />
              <span>{isUploading ? '正在写入...' : '开始上传'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
