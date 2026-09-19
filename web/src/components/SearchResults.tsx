import React from 'react';
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, Crosshair, File, Folder } from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';
import { pageSlice } from '../api/search';
import { formatBytes, formatDate } from '../utils/formatters';

/**
 * 深度检索结果视图。复用 FileExplorer 的列表区域，不接管工具栏。
 *
 * 结果在服务端一次性完整返回，这里只做客户端分页切片——仓库没有虚拟滚动依赖，
 * 分页是纯函数且可单测。
 */
export const SearchResults: React.FC = () => {
  const { deepSearch, setDeepSearchPage, exitDeepSearch, revealHit } = useFileStore();
  const { items, page, totalPages } = pageSlice(deepSearch.hits, deepSearch.page);

  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-slate-600">
            深度检索 <span className="font-mono text-slate-900">“{deepSearch.keyword}”</span>
          </span>
          {deepSearch.loading ? (
            <span className="text-indigo-600">检索中…</span>
          ) : (
            <span className="text-slate-500">
              命中 <strong className="font-mono text-slate-800">{deepSearch.hits.length}</strong> 项 · 已扫描{' '}
              <strong className="font-mono text-slate-800">{deepSearch.scanned}</strong> 项
            </span>
          )}
          {deepSearch.truncated && (
            <span className="flex items-center gap-1 text-amber-600">
              <AlertTriangle className="w-3.5 h-3.5" />
              结果被服务端上限截断，不完整
            </span>
          )}
        </div>
        <button
          onClick={exitDeepSearch}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium shrink-0"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          返回目录
        </button>
      </div>

      {deepSearch.error && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700">
          检索失败：{deepSearch.error}
        </div>
      )}

      {!deepSearch.loading && !deepSearch.error && deepSearch.hits.length === 0 && (
        <div className="h-40 flex items-center justify-center text-xs text-slate-400">
          没有名称里含「{deepSearch.keyword}」的文件或目录
        </div>
      )}

      {items.length > 0 && (
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/70 text-slate-500 font-medium">
              <th className="px-3 py-2.5 font-medium">名称</th>
              <th className="w-28 px-3 py-2.5 font-medium">挂载</th>
              <th className="px-3 py-2.5 font-medium">挂载内路径</th>
              <th className="w-24 px-3 py-2.5 font-medium">大小</th>
              <th className="w-40 px-3 py-2.5 font-medium hidden sm:table-cell">修改时间</th>
              <th className="w-16 px-3 py-2.5 text-right font-medium">跳转</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map(hit => (
              <tr key={`${hit.mount}:${hit.key}`} className="hover:bg-slate-50/80 text-slate-700">
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    {hit.isDir ? (
                      <Folder className="w-4 h-4 text-amber-500 fill-amber-500/20" />
                    ) : (
                      <File className="w-4 h-4 text-slate-400" />
                    )}
                    <span className="font-medium text-slate-900">{hit.name}</span>
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-600 font-mono">
                    {hit.mount}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-slate-500 font-mono break-all">{hit.key}</td>
                <td className="px-3 py-2.5 text-slate-500 font-mono">
                  {hit.isDir ? <span className="text-slate-300">-</span> : formatBytes(hit.size)}
                </td>
                <td className="px-3 py-2.5 text-slate-500 text-[11px] font-mono hidden sm:table-cell">
                  {formatDate(hit.mtime)}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <button
                    onClick={() => revealHit(hit)}
                    title="跳到所在目录并选中"
                    className="p-1 rounded hover:bg-slate-200/70 text-slate-500 hover:text-indigo-600"
                  >
                    <Crosshair className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 py-3 text-xs text-slate-600">
          <button
            onClick={() => setDeepSearchPage(page - 1)}
            disabled={page <= 1}
            className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            上一页
          </button>
          <span className="font-mono">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setDeepSearchPage(page + 1)}
            disabled={page >= totalPages}
            className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40"
          >
            下一页
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
