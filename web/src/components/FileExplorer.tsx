import React, { useState } from 'react';
import {
  Folder,
  File,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  FileCode,
  Download,
  Trash2,
  Copy,
  Move,
  Info,
  Search,
  LayoutGrid,
  List,
  Upload,
  FolderPlus,
  Tag,
  CheckSquare,
  Square,
  ArrowUpDown,
  MoreHorizontal
} from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';
import { FSNode } from '../types';
import { formatBytes, formatDate, getFileExtension } from '../utils/formatters';

export const FileExplorer: React.FC = () => {
  const {
    currentMount,
    currentPath,
    listCurrentNodes,
    navigateTo,
    viewMode,
    setViewMode,
    selectedNode,
    setSelectedNode,
    deleteNode,
    deleteBatch,
    selectedKeys,
    toggleSelectKey,
    selectAllKeys,
    clearSelection,
    setIsUploadOpen,
    setIsNewFolderOpen,
    setIsCopyMoveOpen,
    setCopyMoveTarget,
    setIsCopyMoveMoveMode,
    getCurrentMountObj,
    uploadFile,
    searchQuery,
    setSearchQuery,
    downloadNode,
    isLoadingDirectory,
  } = useFileStore();

  const [sortField, setSortField] = useState<'name' | 'size' | 'mtime'>('name');
  const [sortAsc, setSortAsc] = useState(true);
  const [isDragging, setIsDragging] = useState(false);

  const mountObj = getCurrentMountObj();
  const allNodes = listCurrentNodes();

  // Filter with search query if present
  const filteredNodes = allNodes.filter(n => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      n.name.toLowerCase().includes(q) ||
      n.tags.some(t => t.toLowerCase().includes(q)) ||
      (n.etag && n.etag.toLowerCase().includes(q))
    );
  });

  // Sort nodes: folders first, then by chosen field
  const sortedNodes = [...filteredNodes].sort((a, b) => {
    if (a.is_dir && !b.is_dir) return -1;
    if (!a.is_dir && b.is_dir) return 1;

    let comparison = 0;
    if (sortField === 'name') {
      comparison = a.name.localeCompare(b.name);
    } else if (sortField === 'size') {
      comparison = a.size - b.size;
    } else if (sortField === 'mtime') {
      comparison = new Date(a.mtime).getTime() - new Date(b.mtime).getTime();
    }
    return sortAsc ? comparison : -comparison;
  });

  const getFileIcon = (node: FSNode) => {
    if (node.is_dir) {
      return <Folder className="w-5 h-5 text-amber-500 fill-amber-500/20" />;
    }
    const ext = getFileExtension(node.name);
    switch (ext) {
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'svg':
      case 'webp':
      case 'dng':
        return <FileImage className="w-5 h-5 text-blue-500" />;
      case 'mp4':
      case 'mov':
      case 'mkv':
        return <FileVideo className="w-5 h-5 text-purple-500" />;
      case 'wav':
      case 'mp3':
      case 'flac':
        return <FileAudio className="w-5 h-5 text-pink-500" />;
      case 'zip':
      case 'tar':
      case 'gz':
      case 'zst':
        return <FileArchive className="w-5 h-5 text-amber-600" />;
      case 'ts':
      case 'js':
      case 'py':
      case 'go':
      case 'json':
      case 'sql':
        return <FileCode className="w-5 h-5 text-emerald-500" />;
      case 'pdf':
      case 'doc':
      case 'md':
      case 'txt':
        return <FileText className="w-5 h-5 text-rose-500" />;
      default:
        return <File className="w-5 h-5 text-slate-400" />;
    }
  };

  const handleNodeClick = (node: FSNode) => {
    if (node.is_dir) {
      navigateTo(currentMount, node.key);
    } else {
      setSelectedNode(node);
    }
  };

  const handleDownload = (node: FSNode) => {
    void downloadNode(node);
  };

  const handleOpenCopyMove = (node: FSNode, isMove: boolean) => {
    setCopyMoveTarget(node);
    setIsCopyMoveMoveMode(isMove);
    setIsCopyMoveOpen(true);
  };

  const allKeys = sortedNodes.map(n => n.key);
  const isAllSelected = allKeys.length > 0 && allKeys.every(k => selectedKeys.has(k));
  const hasSelection = selectedKeys.size > 0;

  // Drag & drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        await uploadFile(e.dataTransfer.files[i]);
      }
    }
  };

  if (!currentMount) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-white">
        <p className="text-sm text-slate-600 mb-3">尚未配置存储挂载，请先在「挂载」页添加 mount。</p>
        <p className="text-xs text-slate-400 font-mono">POST /v1/mounts</p>
      </div>
    );
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`flex-1 flex flex-col h-[calc(100vh-56px)] overflow-hidden bg-white relative transition-colors ${
        isDragging ? 'bg-indigo-50/40 ring-2 ring-indigo-400 ring-inset' : ''
      }`}
    >
      {isLoadingDirectory && (
        <div className="absolute top-2 right-4 z-10 text-[11px] text-indigo-600 bg-indigo-50 px-2 py-1 rounded border border-indigo-100">
          加载目录中…
        </div>
      )}
      {/* Explorer Clean Toolbar */}
      <div className="h-12 px-4 border-b border-slate-200 flex items-center justify-between gap-4 bg-white shrink-0">
        {/* Left: Item counts & Selected Batch Toolbar */}
        <div className="flex items-center gap-3 text-xs">
          {hasSelection ? (
            <div className="flex items-center gap-2 bg-indigo-50 text-indigo-900 px-2.5 py-1 rounded-md border border-indigo-200 font-medium animate-in fade-in duration-100">
              <span>已选 {selectedKeys.size} 项</span>
              <button
                onClick={() => deleteBatch(Array.from(selectedKeys))}
                className="text-rose-600 hover:text-rose-700 hover:underline text-xs flex items-center gap-1 font-sans"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>批量删除</span>
              </button>
              <button
                onClick={clearSelection}
                className="text-slate-500 hover:text-slate-800 text-xs ml-1"
              >
                取消
              </button>
            </div>
          ) : (
            <span className="text-slate-500 font-medium">
              共 <strong className="text-slate-800 font-mono">{sortedNodes.length}</strong> 个对象
            </span>
          )}
        </div>

        {/* Center: Clean Search Bar */}
        <div className="flex-1 max-w-sm">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="搜索文件名或标签..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-8 pr-3 py-1 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:bg-white transition-all font-sans"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-700"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Right: Sorting & View Mode Toggle */}
        <div className="flex items-center gap-2">
          <div className="flex items-center text-xs text-slate-600 bg-slate-100 p-0.5 rounded-lg border border-slate-200 font-medium">
            <button
              onClick={() => {
                if (sortField === 'name') setSortAsc(!sortAsc);
                else { setSortField('name'); setSortAsc(true); }
              }}
              className={`px-2 py-0.5 rounded ${sortField === 'name' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'}`}
            >
              名称 {sortField === 'name' && (sortAsc ? '↑' : '↓')}
            </button>
            <button
              onClick={() => {
                if (sortField === 'size') setSortAsc(!sortAsc);
                else { setSortField('size'); setSortAsc(false); }
              }}
              className={`px-2 py-0.5 rounded ${sortField === 'size' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'}`}
            >
              大小 {sortField === 'size' && (sortAsc ? '↑' : '↓')}
            </button>
            <button
              onClick={() => {
                if (sortField === 'mtime') setSortAsc(!sortAsc);
                else { setSortField('mtime'); setSortAsc(false); }
              }}
              className={`px-2 py-0.5 rounded ${sortField === 'mtime' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'}`}
            >
              时间 {sortField === 'mtime' && (sortAsc ? '↑' : '↓')}
            </button>
          </div>

          <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
            <button
              onClick={() => setViewMode('table')}
              title="表格列表视图"
              className={`p-1 rounded ${viewMode === 'table' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500 hover:text-slate-900'}`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('grid')}
              title="网格卡片视图"
              className={`p-1 rounded ${viewMode === 'grid' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500 hover:text-slate-900'}`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto">
        {sortedNodes.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-400">
            <div className="w-14 h-14 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center mb-3 text-slate-400">
              <Folder className="w-7 h-7" />
            </div>
            <h3 className="text-sm font-semibold text-slate-700 mb-1">目录为空</h3>
            <p className="text-xs text-slate-400 max-w-sm mb-4">
              拖拽文件到此处，或点击下方按钮新建或上传
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsNewFolderOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium transition-colors"
              >
                <FolderPlus className="w-3.5 h-3.5 text-amber-600" />
                <span>新建子目录</span>
              </button>
              <button
                onClick={() => setIsUploadOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>上传文件</span>
              </button>
            </div>
          </div>
        ) : viewMode === 'table' ? (
          /* Clean, Breathable Table View */
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-slate-500 font-medium">
                <th className="w-10 px-4 py-2.5 text-center">
                  <button
                    onClick={() => (isAllSelected ? clearSelection() : selectAllKeys(allKeys))}
                    className="text-slate-400 hover:text-slate-700"
                  >
                    {isAllSelected ? (
                      <CheckSquare className="w-4 h-4 text-indigo-600" />
                    ) : (
                      <Square className="w-4 h-4" />
                    )}
                  </button>
                </th>
                <th className="px-4 py-2.5 font-medium">名称</th>
                <th className="w-32 px-4 py-2.5 font-medium">大小</th>
                <th className="w-44 px-4 py-2.5 font-medium hidden sm:table-cell">修改时间</th>
                <th className="w-32 px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sortedNodes.map(node => {
                const isSelected = selectedKeys.has(node.key);
                const isInspected = selectedNode?.key === node.key;

                return (
                  <tr
                    key={node.key}
                    onClick={() => handleNodeClick(node)}
                    className={`cursor-pointer transition-colors group ${
                      isInspected
                        ? 'bg-indigo-50/70 text-slate-900'
                        : isSelected
                        ? 'bg-slate-50 text-slate-900'
                        : 'hover:bg-slate-50/80 text-slate-700'
                    }`}
                  >
                    <td
                      className="px-4 py-3 text-center"
                      onClick={e => {
                        e.stopPropagation();
                        toggleSelectKey(node.key);
                      }}
                    >
                      {isSelected ? (
                        <CheckSquare className="w-4 h-4 text-indigo-600" />
                      ) : (
                        <Square className="w-4 h-4 text-slate-300 group-hover:text-slate-500" />
                      )}
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {getFileIcon(node)}
                        <div className="min-w-0">
                          <span className="font-medium text-slate-900 group-hover:text-indigo-600 transition-colors">
                            {node.name}
                          </span>
                          {node.tags.length > 0 && (
                            <div className="flex items-center gap-1 mt-0.5">
                              {node.tags.map((tag, idx) => (
                                <span
                                  key={idx}
                                  className="text-[10px] px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 border border-slate-200/80 font-sans"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>

                    <td className="px-4 py-3 text-slate-500 font-mono">
                      {node.is_dir ? <span className="text-slate-300">-</span> : formatBytes(node.size)}
                    </td>

                    <td className="px-4 py-3 text-slate-500 text-[11px] font-mono hidden sm:table-cell">
                      {formatDate(node.mtime)}
                    </td>

                    <td className="px-4 py-3 text-right">
                      <div
                        className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={e => e.stopPropagation()}
                      >
                        {!node.is_dir && (
                          <button
                            onClick={() => handleDownload(node)}
                            title="下载 (307重定向直传 / 流式)"
                            className="p-1 rounded hover:bg-slate-200/70 text-slate-500 hover:text-emerald-600 transition-colors"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                        )}

                        <button
                          onClick={() => handleOpenCopyMove(node, false)}
                          title="复制 (同源直接拷贝 / 跨源异步队列)"
                          className="p-1 rounded hover:bg-slate-200/70 text-slate-500 hover:text-amber-600 transition-colors"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={() => setSelectedNode(node)}
                          title="查看详细属性与 CLI 契约"
                          className="p-1 rounded hover:bg-slate-200/70 text-slate-500 hover:text-indigo-600 transition-colors"
                        >
                          <Info className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={() => deleteNode(node.key)}
                          title="删除节点"
                          className="p-1 rounded hover:bg-rose-50 text-slate-400 hover:text-rose-600 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          /* Clean Grid View */
          <div className="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {sortedNodes.map(node => {
              const isSelected = selectedKeys.has(node.key);
              const isInspected = selectedNode?.key === node.key;

              return (
                <div
                  key={node.key}
                  onClick={() => handleNodeClick(node)}
                  className={`group relative p-3 rounded-xl border cursor-pointer transition-all ${
                    isInspected
                      ? 'bg-indigo-50/80 border-indigo-300 ring-2 ring-indigo-200'
                      : isSelected
                      ? 'bg-slate-50 border-slate-300'
                      : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-xs'
                  }`}
                >
                  <div
                    onClick={e => {
                      e.stopPropagation();
                      toggleSelectKey(node.key);
                    }}
                    className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    {isSelected ? (
                      <CheckSquare className="w-4 h-4 text-indigo-600" />
                    ) : (
                      <Square className="w-4 h-4 text-slate-400" />
                    )}
                  </div>

                  <div className="w-10 h-10 mx-auto my-2 rounded-lg bg-slate-50 flex items-center justify-center">
                    {getFileIcon(node)}
                  </div>

                  <div className="text-center mt-2">
                    <span className="font-medium text-xs text-slate-900 block truncate" title={node.name}>
                      {node.name}
                    </span>
                    <span className="text-[11px] text-slate-500 font-mono block mt-0.5">
                      {node.is_dir ? '目录' : formatBytes(node.size)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
