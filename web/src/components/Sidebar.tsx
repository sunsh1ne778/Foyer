import React from 'react';
import {
  HardDrive,
  Cloud,
  Server,
  Plus,
  RefreshCw,
  Database,
  Layers,
  CheckCircle2,
  FolderTree,
  Clock,
  ExternalLink
} from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';
import { formatBytes, getDriverColor } from '../utils/formatters';
import { usagePercent } from '../utils/capacity';
import { DriverType } from '../types';

export const Sidebar: React.FC = () => {
  const {
    mounts,
    currentMount,
    navigateTo,
    currentTab,
    setCurrentTab,
    setIsNewMountOpen,
    triggerReconcile,
    clusterInfo
  } = useFileStore();

  const getDriverIcon = (type: DriverType) => {
    switch (type) {
      case 's3':
      case 'minio':
      case 'oss':
        return <Cloud className="w-3.5 h-3.5" />;
      case 'local':
        return <HardDrive className="w-3.5 h-3.5" />;
      case 'fastdfs':
        return <Server className="w-3.5 h-3.5" />;
      default:
        return <Layers className="w-3.5 h-3.5" />;
    }
  };

  return (
    <aside className="w-60 bg-slate-50 border-r border-slate-200 flex flex-col h-[calc(100vh-56px)] shrink-0 select-none">
      {/* Storage Mounts Section */}
      <div className="p-3 border-b border-slate-200/80 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <HardDrive className="w-4 h-4 text-slate-500" />
          <span className="text-xs font-semibold text-slate-700">存储挂载源</span>
          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-slate-200 text-slate-600 font-medium">
            {mounts.length}
          </span>
        </div>
        <button
          onClick={() => setIsNewMountOpen(true)}
          title="新增存储挂载 (POST /v1/mounts)"
          className="p-1 rounded-md hover:bg-slate-200/70 text-slate-500 hover:text-slate-900 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Mounts List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {mounts.map(m => {
          const isSelected = currentMount === m.name;
          const colors = getDriverColor(m.type);
          const usedBytes = m.stats?.total_bytes || 0;
          // 真实分母来自控制面（配额优先，否则物理数据盘总量）；拿不到就不画进度条。
          const capacityBytes = m.stats?.capacity_bytes || 0;
          const pct = usagePercent(usedBytes, capacityBytes);

          return (
            <div
              key={m.id}
              onClick={() => {
                navigateTo(m.name, '/');
                if (currentTab !== 'files') setCurrentTab('files');
              }}
              className={`group p-2 rounded-lg cursor-pointer transition-all border ${
                isSelected
                  ? 'bg-white border-indigo-200 text-slate-900 shadow-xs ring-1 ring-indigo-500/10'
                  : 'bg-transparent hover:bg-slate-100/80 border-transparent text-slate-700'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className={`w-6 h-6 rounded flex items-center justify-center shrink-0 border ${colors.bg} ${colors.text} ${colors.border}`}
                  >
                    {getDriverIcon(m.type)}
                  </div>
                  <span className="font-mono font-semibold text-xs truncate">
                    {m.name}:
                  </span>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {m.status === 'reconciling' ? (
                    <RefreshCw className="w-3 h-3 text-amber-500 animate-spin" />
                  ) : (
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        m.status === 'active' ? 'bg-emerald-500' : 'bg-red-500'
                      }`}
                    />
                  )}
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      triggerReconcile(m.name);
                    }}
                    title="对账修复索引"
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-700 transition-opacity"
                  >
                    <RefreshCw className="w-2.5 h-2.5" />
                  </button>
                </div>
              </div>

              {/* Usage & Driver label */}
              <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono">
                <span>{colors.label}</span>
                <span
                  title={
                    capacityBytes > 0
                      ? `${formatBytes(usedBytes)} / ${formatBytes(capacityBytes)}（${pct}%）`
                      : '控制面未返回用量'
                  }
                >
                  {m.stats ? formatBytes(usedBytes) : '—'}
                </span>
              </div>

              {/* 只有拿到真实容量才画进度条；没有分母时宁可不画。 */}
              {capacityBytes > 0 && (
                <div className="w-full h-1 bg-slate-200 rounded-full mt-1.5 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${isSelected ? 'bg-indigo-600' : 'bg-slate-400'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Discreet Architecture Status Widget */}
      <div className="p-3 border-t border-slate-200 bg-white/70 text-slate-500 text-xs">
        <div className="flex items-center justify-between mb-1 text-[11px] font-medium text-slate-600">
          <span>VFS 投影内核</span>
          <span className="text-emerald-600 font-mono font-medium flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> 就绪
          </span>
        </div>
        <p className="text-[10px] text-slate-400 leading-tight">
          List 唯走 PG 投影表，大文件直传 (307 卸载)，无业务侵入。
        </p>
      </div>
    </aside>
  );
};
