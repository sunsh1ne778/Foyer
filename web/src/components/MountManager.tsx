import React, { useState } from 'react';
import {
  HardDrive,
  Cloud,
  Server,
  Layers,
  Plus,
  RefreshCcw,
  Activity,
  CheckCircle2,
  AlertTriangle,
  Trash2,
  ExternalLink,
  Shield,
  Zap,
  Sliders,
  Check,
  X,
  FileCheck
} from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';
import { isMetadataImport } from '../api/mounts';
import { Mount, DriverType, DriverCaps } from '../types';
import { formatBytes, formatDate, getDriverColor } from '../utils/formatters';

export const MountManager: React.FC = () => {
  const {
    mounts,
    addMount,
    removeMount,
    probeMount,
    resyncMount,
    setIsNewMountOpen,
    navigateTo
  } = useFileStore();

  const [probingId, setProbingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<{ id: string; success: boolean } | null>(null);

  const handleProbe = async (m: Mount) => {
    setProbingId(m.id);
    setProbeResult(null);
    const ok = await probeMount(m.id);
    setProbingId(null);
    setProbeResult({ id: m.id, success: ok });
    setTimeout(() => setProbeResult(null), 3000);
  };

  const handleDelete = async (m: Mount) => {
    const ok = window.confirm(
      `从挂载表移除 ${m.name}: ？\n\n` +
        '只移除目录项，不会删除 JuiceFS 中已导入的文件（内容只读，删除需在挂载点用 rmr）。'
    );
    if (!ok) return;
    setBusyId(m.id);
    try {
      await removeMount(m.id);
    } finally {
      setBusyId(null);
    }
  };

  const handleResync = async (m: Mount) => {
    setBusyId(m.id);
    try {
      const res = await resyncMount(m.id);
      setProbeResult({ id: m.id, success: true });
      window.alert(
        `增量同步完成：新增 ${res.imported}，已存在跳过 ${res.skipped}，扫描 ${res.scanned}\n` +
        `保留原始修改时间 ${res.mtime_kept} 个（缺失 ${res.mtime_missing}），目录时间 ${res.dir_mtime_kept} 个，` +
        `权限 ${res.mode_kept} 个，属主 ${res.owner_kept} 个`
      );
    } catch {
      setProbeResult({ id: m.id, success: false });
    } finally {
      setBusyId(null);
      setTimeout(() => setProbeResult(null), 3000);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-slate-50 text-slate-800 font-sans">
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6 border-b border-slate-200 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-slate-900 tracking-tight">存储挂载表 (MountTable)</h1>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-100 font-medium">
              JuiceFS
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1 max-w-2xl">
            添加本地目录时默认「仅导入元数据」。文件出现在统一路径 <code className="text-indigo-600 font-mono font-medium">name:/</code>，经 S3 网关给 Web 访问。
          </p>
        </div>

        <button
          onClick={() => setIsNewMountOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>添加新挂载源</span>
        </button>
      </div>

      {/* Mounts Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {mounts.map(m => {
          const colors = getDriverColor(m.type);
          const isProbing = probingId === m.id;
          const thisProbeResult = probeResult?.id === m.id ? probeResult : null;
          const usedBytes = m.stats?.total_bytes || 0;

          return (
            <div
              key={m.id}
              className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between hover:border-slate-300 hover:shadow-xs transition-all"
            >
              <div>
                {/* Header */}
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`w-9 h-9 rounded-lg flex items-center justify-center border ${colors.bg} ${colors.text} ${colors.border}`}
                    >
                      {m.type === 'local' ? (
                        <HardDrive className="w-4 h-4" />
                      ) : m.type === 'fastdfs' ? (
                        <Server className="w-4 h-4" />
                      ) : (
                        <Cloud className="w-4 h-4" />
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono font-bold text-sm text-slate-900">{m.name}:</span>
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-medium border ${colors.bg} ${colors.text} ${colors.border}`}
                        >
                          {colors.label}
                        </span>
                        {isMetadataImport(m) && (
                          <span
                            className="inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.2 rounded bg-amber-50 text-amber-700 border border-amber-100 font-medium"
                            title="仅导入元数据：内容只读，删除只去元数据，不搬数据"
                          >
                            <FileCheck className="w-3 h-3" />
                            只读导入
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-slate-400 font-mono">
                        {m.spec.bucket || m.spec.base_dir || m.spec.group_name || '默认存储桶'}
                      </span>
                    </div>
                  </div>

                  {/* Status indicator */}
                  <span
                    className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full ${
                      m.status === 'active'
                        ? 'bg-emerald-50 text-emerald-700'
                        : m.status === 'reconciling'
                        ? 'bg-amber-50 text-amber-700 animate-pulse'
                        : 'bg-rose-50 text-rose-700'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        m.status === 'active' ? 'bg-emerald-500' : m.status === 'reconciling' ? 'bg-amber-500' : 'bg-rose-500'
                      }`}
                    />
                    <span>{m.status === 'active' ? '正常' : m.status === 'reconciling' ? '对账中' : '离线'}</span>
                  </span>
                </div>

                {/* Storage Metrics */}
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-150 grid grid-cols-2 gap-2 text-xs mb-3">
                  <div>
                    <span className="text-slate-400 text-[11px] block">已索引对象</span>
                    <span className="font-bold text-slate-800 font-mono">{m.stats?.node_count || 0} 个</span>
                  </div>
                  <div>
                    <span className="text-slate-400 text-[11px] block">占用空间</span>
                    <span className="font-bold text-slate-800 font-mono">{formatBytes(usedBytes)}</span>
                  </div>
                </div>

                {isMetadataImport(m) && (
                  <p className="text-[11px] text-slate-400 font-mono mb-3 truncate" title={m.spec.root}>
                    来源 {m.spec.root || '—'} → dest {m.spec.dest || `/${m.name}`}
                  </p>
                )}

                {/* Capability Matrix Pills */}
                <div className="space-y-1.5 mb-4">
                  <span className="text-[11px] text-slate-400 font-medium block">驱动能力特性 (Driver.Caps)</span>
                  <div className="flex flex-wrap gap-1">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                      m.caps.presign ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-slate-100 text-slate-400'
                    }`}>
                      {m.caps.presign ? '✓ 307直传' : '✕ 无Presign'}
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                      m.caps.copy ? 'bg-indigo-50 text-indigo-700 border border-indigo-100' : 'bg-slate-100 text-slate-400'
                    }`}>
                      {m.caps.copy ? '✓ 原生Copy' : '✕ 流式拷贝'}
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                      m.caps.directory ? 'bg-amber-50 text-amber-700 border border-amber-100' : 'bg-slate-100 text-slate-400'
                    }`}>
                      {m.caps.directory ? '✓ 真实目录' : '✕ 扁平Prefix'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Bottom Actions */}
              <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                <button
                  onClick={() => handleProbe(m)}
                  disabled={isProbing}
                  className="flex items-center gap-1 text-slate-600 hover:text-slate-900 font-medium"
                >
                  <Activity className={`w-3.5 h-3.5 ${isProbing ? 'animate-spin text-indigo-600' : ''}`} />
                  <span>{isProbing ? '探测中...' : '驱动探活'}</span>
                </button>

                <div className="flex items-center gap-2">
                  {isMetadataImport(m) && (
                    <button
                      onClick={() => handleResync(m)}
                      disabled={busyId === m.id}
                      className="flex items-center gap-1 text-slate-600 hover:text-emerald-600 font-medium disabled:text-slate-300"
                    >
                      <RefreshCcw className={`w-3.5 h-3.5 ${busyId === m.id ? 'animate-spin' : ''}`} />
                      <span>增量同步</span>
                    </button>
                  )}

                  <button
                    onClick={() => navigateTo(m.name, '/')}
                    className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition-colors"
                  >
                    浏览文件
                  </button>

                  <button
                    onClick={() => handleDelete(m)}
                    disabled={busyId === m.id}
                    className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:text-slate-200 transition-colors"
                    title="从挂载表移除（不删除已导入文件）"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
