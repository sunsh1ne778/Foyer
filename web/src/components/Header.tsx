import React, { useEffect, useRef, useState } from 'react';
import {
  FolderTree,
  ChevronRight,
  ArrowUp,
  Copy,
  Check,
  RefreshCw,
  Activity,
  UploadCloud,
  Download,
  FolderPlus,
  BookOpen,
  HardDrive,
  ChevronDown,
  LogOut,
  User,
  Terminal,
} from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';

export const Header: React.FC = () => {
  const {
    currentMount,
    currentPath,
    currentRef,
    pathInput,
    setPathInput,
    navigateTo,
    navigateToRef,
    navigateUp,
    searchQuery,
    setSearchQuery,
    mounts,
    jobs,
    setIsUploadOpen,
    setIsNewFolderOpen,
    setIsNewMountOpen,
    setCurrentTab,
    currentTab,
    triggerReconcile,
    clusterInfo,
    username,
    logout,
    refreshDirectory,
    setIsExportOpen,
  } = useFileStore();

  const [isEditingPath, setIsEditingPath] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isMountDropdownOpen, setIsMountDropdownOpen] = useState(false);
  const pathScrollRef = useRef<HTMLDivElement>(null);

  // 路径变化时把面包屑自动滚到最右，保证当前目录始终可见。
  useEffect(() => {
    const el = pathScrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [currentMount, currentPath]);

  // Active running jobs
  const runningJobsCount = jobs.filter(j => j.status === 'running').length;

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigateToRef(pathInput);
    setIsEditingPath(false);
  };

  const handleCopyRef = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(currentRef);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  // Build breadcrumbs for current path
  const pathSegments = currentPath.split('/').filter(Boolean);

  return (
    <header className="bg-white text-slate-800 border-b border-slate-200 sticky top-0 z-30 select-none">
      <div className="h-14 px-4 flex items-center justify-between gap-4">
        {/* Left: Brand + Quick Health Status */}
        <div className="flex items-center gap-3 shrink-0">
          <div
            onClick={() => setCurrentTab('files')}
            className="flex items-center gap-2.5 cursor-pointer group"
          >
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-sm transition-transform group-hover:scale-105">
              <FolderTree className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-slate-900 tracking-tight text-sm">FileStore</span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 font-medium border border-indigo-100">
                  VFS
                </span>
              </div>
            </div>
          </div>

          {/* Calm health status dot */}
          <div
            className="hidden xl:flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-50 border border-slate-250 text-[11px] text-slate-500 font-mono"
            title={`/v1/health · PG ${clusterInfo.postgresStatus} · Redis ${clusterInfo.redisStatus}`}
          >
            <span
              className={`w-2 h-2 rounded-full ring-4 ${
                clusterInfo.postgresStatus === 'healthy'
                  ? 'bg-emerald-500 ring-emerald-100'
                  : 'bg-amber-500 ring-amber-100'
              }`}
            />
            <span>{clusterInfo.postgresStatus === 'healthy' ? 'API 就绪' : 'API 异常'}</span>
          </div>
        </div>

        {/* Center: Clean mount:path Breadcrumb & Address Bar */}
        <div className="flex-1 max-w-xl mx-auto flex items-center gap-2">
          {/* Back to parent */}
          <button
            onClick={navigateUp}
            disabled={currentPath === '/'}
            title="返回上一层"
            className="p-1.5 rounded-md hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent text-slate-500 transition-colors shrink-0"
          >
            <ArrowUp className="w-4 h-4" />
          </button>

          {/* Reconcile */}
          <button
            onClick={() => {
              if (currentMount) void triggerReconcile(currentMount);
            }}
            disabled={!currentMount}
            title="对账此挂载 (POST /v1/mounts/{id}/reconcile)"
            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-indigo-600 transition-colors shrink-0 disabled:opacity-30"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => void refreshDirectory()}
            disabled={!currentMount}
            title="刷新目录 (GET /v1/fs/list)"
            className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-indigo-600 transition-colors shrink-0 disabled:opacity-30"
          >
            <RefreshCw className="w-4 h-4 rotate-180" />
          </button>

          {/* Interactive Path pill */}
          <div className="flex-1 min-w-0 relative">
            {isEditingPath ? (
              <form onSubmit={handlePathSubmit} className="flex items-center w-full">
                <input
                  type="text"
                  value={pathInput}
                  onChange={e => setPathInput(e.target.value)}
                  onBlur={() => setIsEditingPath(false)}
                  autoFocus
                  placeholder="例如 photos:/2026/sub/"
                  className="w-full bg-slate-50 text-slate-900 font-mono text-xs px-3 py-1.5 rounded-lg border border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 shadow-xs"
                />
              </form>
            ) : (
              <div
                onClick={() => setIsEditingPath(true)}
                title="点击直接编辑 mount:path 路径"
                className="flex items-center gap-1.5 font-mono text-xs pl-2.5 pr-1 py-1.5 bg-slate-50 border border-slate-200 rounded-lg hover:border-slate-300 hover:bg-white cursor-text transition-all group text-slate-700 min-w-0"
              >
                {/* Scrollable breadcrumb body: 单行裁切，超长路径内部横向滚动而不是撑大整条 header */}
                <div
                  ref={pathScrollRef}
                  className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto no-scrollbar whitespace-nowrap"
                >
                {/* Mount Selector / Pill with dropdown */}
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      setIsMountDropdownOpen(!isMountDropdownOpen);
                    }}
                    className="flex items-center gap-1 font-semibold text-indigo-700 hover:text-indigo-900 bg-indigo-50 px-1.5 py-0.5 rounded text-[11px] border border-indigo-100 shrink-0"
                  >
                    <span>{currentMount}:</span>
                    <ChevronDown className="w-2.5 h-2.5 opacity-60" />
                  </button>

                  {isMountDropdownOpen && (
                    <div
                      onClick={e => e.stopPropagation()}
                      className="absolute left-0 top-full mt-1.5 w-48 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-40 text-xs font-sans animate-in fade-in duration-100"
                    >
                      <div className="px-3 py-1 text-[10px] text-slate-400 font-medium uppercase font-mono">
                        切换挂载源
                      </div>
                      {mounts.map(m => (
                        <button
                          key={m.id}
                          onClick={() => {
                            navigateTo(m.name, '/');
                            setIsMountDropdownOpen(false);
                          }}
                          className={`w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-slate-50 transition-colors ${
                            currentMount === m.name ? 'text-indigo-600 font-medium bg-indigo-50/50' : 'text-slate-700'
                          }`}
                        >
                          <span className="font-mono">{m.name}:</span>
                          <span className="text-[10px] text-slate-400 font-mono uppercase">{m.type}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Root slash */}
                <span
                  onClick={e => {
                    e.stopPropagation();
                    navigateTo(currentMount, '/');
                  }}
                  className="hover:text-indigo-600 hover:underline cursor-pointer text-slate-500 shrink-0"
                >
                  /
                </span>

                {/* Segments */}
                {pathSegments.map((seg, idx) => {
                  const subPath = '/' + pathSegments.slice(0, idx + 1).join('/');
                  const isLast = idx === pathSegments.length - 1;
                  return (
                    <React.Fragment key={subPath}>
                      <span
                        onClick={e => {
                          e.stopPropagation();
                          navigateTo(currentMount, subPath);
                        }}
                        title={seg}
                        className={`shrink-0 max-w-[16rem] truncate hover:text-indigo-600 hover:underline cursor-pointer ${
                          isLast ? 'text-slate-900 font-medium' : 'text-slate-500'
                        }`}
                      >
                        {seg}
                      </span>
                      {!isLast && <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" />}
                    </React.Fragment>
                  );
                })}
                </div>

                {/* Quick copy Ref */}
                <button
                  type="button"
                  onClick={handleCopyRef}
                  title="复制路径 (mount:path)"
                  className="text-slate-400 hover:text-slate-700 p-0.5 rounded hover:bg-slate-200/60 shrink-0"
                >
                  {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right: Section Tabs & Primary Actions */}
        <div className="flex items-center gap-3 shrink-0">
          {/* Top Tabs Switcher */}
          <nav className="flex items-center bg-slate-100 p-1 rounded-lg border border-slate-200 text-xs font-medium">
            <button
              onClick={() => setCurrentTab('files')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all ${
                currentTab === 'files'
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FolderTree className="w-3.5 h-3.5 text-indigo-600" />
              <span>文件</span>
            </button>

            <button
              onClick={() => setCurrentTab('mounts')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all ${
                currentTab === 'mounts'
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <HardDrive className="w-3.5 h-3.5 text-amber-600" />
              <span>挂载</span>
            </button>

            <button
              onClick={() => setCurrentTab('jobs')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all ${
                currentTab === 'jobs'
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Activity className="w-3.5 h-3.5 text-emerald-600" />
              <span>任务</span>
              {runningJobsCount > 0 && (
                <span className="w-4 h-4 rounded-full bg-amber-500 text-white font-mono text-[10px] font-bold flex items-center justify-center">
                  {runningJobsCount}
                </span>
              )}
            </button>

            <button
              onClick={() => setCurrentTab('cli')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all ${
                currentTab === 'cli'
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Terminal className="w-3.5 h-3.5 text-blue-600" />
              <span>CLI</span>
            </button>

            <button
              onClick={() => setCurrentTab('docs')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md transition-all ${
                currentTab === 'docs'
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5 text-indigo-600" />
              <span>API</span>
            </button>
          </nav>

          {/* Quick Primary Actions */}
          <div className="hidden md:flex items-center gap-1.5 text-[11px] text-slate-500 px-2 py-1 rounded-lg bg-slate-50 border border-slate-200">
            <User className="w-3 h-3" />
            <span className="font-mono">{username || 'admin'}</span>
            <button
              type="button"
              onClick={logout}
              title="退出登录"
              className="p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-rose-600"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>

          {currentTab === 'files' && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsExportOpen(true)}
                disabled={!currentMount}
                title="把当前分区或当前目录的元数据导出为报表"
                className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-250 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors disabled:opacity-40"
              >
                <Download className="w-3.5 h-3.5 text-slate-500" />
                <span>导出元数据</span>
              </button>

              <button
                onClick={() => setIsNewFolderOpen(true)}
                className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-250 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors"
              >
                <FolderPlus className="w-3.5 h-3.5 text-slate-500" />
                <span>新建目录</span>
              </button>

              <button
                onClick={() => setIsUploadOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                <span>上传文件</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
