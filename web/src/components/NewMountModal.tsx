import React, { useEffect, useState } from 'react';
import {
  X,
  HardDrive,
  Cloud,
  Server,
  Plus,
  Info,
  ShieldAlert,
  FileCheck,
  FolderOpen,
  Loader2
} from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';
import { DriverType, DriverCaps } from '../types';
import { foyerHealth } from '../api/jfs';
import { DirectoryPicker } from './DirectoryPicker';

export const NewMountModal: React.FC = () => {
  const { isNewMountOpen, setIsNewMountOpen, addMount, mounts, previewLocalImport } = useFileStore();

  const [mountName, setMountName] = useState('');
  const [driverType, setDriverType] = useState<DriverType>('local');
  const [errorMsg, setErrorMsg] = useState('');
  const [ingestMode, setIngestMode] = useState<'metadata' | 'copy' | 'empty'>('metadata');
  const [hostHint, setHostHint] = useState<{ host_data?: string; host_mount?: string; host_drives?: string[] }>({});
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  // S3 / MinIO spec
  const [endpoint, setEndpoint] = useState('https://s3.us-west-2.amazonaws.com');
  const [bucket, setBucket] = useState('');
  const [region, setRegion] = useState('us-west-2');
  const [prefix, setPrefix] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [pathStyle, setPathStyle] = useState('false');

  // Local / NAS spec
  const [localRoot, setLocalRoot] = useState('');
  const [preview, setPreview] = useState<{
    scanned: number;
    objects: string[];
    dest: string;
    mtime_kept: number;
    mtime_missing: number;
    dir_mtime_kept: number;
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // FastDFS spec
  const [fdfsTracker, setFdfsTracker] = useState('192.168.1.100:22122');
  const [fdfsGroup, setFdfsGroup] = useState('group1');

  useEffect(() => {
    if (!isNewMountOpen) return;
    setIsPickerOpen(false);
    foyerHealth()
      .then(h => {
        setHostHint({
          host_data: h.host_data,
          host_mount: h.host_mount || '/host',
          host_drives: h.host_drives,
        });
        if (h.host_drives && h.host_drives.length > 0) {
          setLocalRoot(prev => prev || h.host_drives![0]);
        }
      })
      .catch(() => {
        /* keep defaults */
      });
  }, [isNewMountOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    if (preview && driverType !== 'local') setPreview(null);

    const cleanName = mountName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!cleanName) {
      setErrorMsg('挂载名称不能为空，且仅支持小写字母、数字与横线下划线');
      return;
    }

    if (mounts.some(m => m.name === cleanName)) {
      setErrorMsg(`挂载名 "${cleanName}" 已存在，名称必须全局唯一`);
      return;
    }

    let spec: Record<string, string> = {};
    let caps: DriverCaps = {
      list: true,
      mkdir: false,
      copy: true,
      move: true,
      multipart: true,
      presign: true,
      directory: false
    };

    if (driverType === 's3' || driverType === 'minio') {
      if (!bucket.trim()) {
        setErrorMsg('Bucket 桶名称不能为空');
        return;
      }
      spec = {
        endpoint: endpoint.trim(),
        bucket: bucket.trim(),
        region: region.trim(),
        prefix: prefix.trim(),
        path_style: pathStyle,
        auto_create: 'false',
        access_key: accessKey.trim() || 'AKIA***',
        secret_key: secretKey.trim() || '******'
      };
      caps = {
        list: true,
        mkdir: false,
        copy: true,
        move: true,
        multipart: true,
        presign: true,
        directory: false
      };
    } else if (driverType === 'oss') {
      if (!bucket.trim()) {
        setErrorMsg('OSS Bucket 桶名称不能为空');
        return;
      }
      spec = {
        endpoint: endpoint.trim() || 'https://oss-cn-hangzhou.aliyuncs.com',
        bucket: bucket.trim(),
        region: region.trim() || 'cn-hangzhou',
        prefix: prefix.trim(),
        auto_create: 'false',
        access_key: accessKey.trim() || 'LTAI***',
        secret_key: secretKey.trim() || '******'
      };
      caps = {
        list: true,
        mkdir: false,
        copy: true,
        move: true,
        multipart: true,
        presign: true,
        directory: false
      };
    } else if (driverType === 'local') {
      if (!localRoot.trim()) {
        setErrorMsg('本地根目录 root 路径不能为空');
        return;
      }
      if (ingestMode !== 'metadata') {
        setErrorMsg('目前只支持「仅导入元数据」，复制入库与空卷写入后续开放');
        return;
      }
      spec = {
        root: localRoot.trim(),
        prefix: prefix.trim(),
        mode: ingestMode,
      };
      caps = {
        list: true,
        mkdir: true,
        copy: true,
        move: true,
        multipart: false,
        presign: false,
        directory: true
      };
    } else if (driverType === 'fastdfs') {
      spec = {
        tracker: fdfsTracker.trim(),
        group: fdfsGroup.trim()
      };
      caps = {
        list: false,
        mkdir: false,
        copy: false,
        move: false,
        multipart: false,
        presign: false,
        directory: false
      };
    }

    // 本地「仅导入元数据」走两步：先预检，再确认。
    if (driverType === 'local' && ingestMode === 'metadata' && !preview) {
      setPreviewing(true);
      try {
        const res = await previewLocalImport(cleanName, localRoot.trim());
        setPreview({
          scanned: res.scanned,
          objects: res.objects || [],
          dest: res.dest,
          mtime_kept: res.mtime_kept,
          mtime_missing: res.mtime_missing,
          dir_mtime_kept: res.dir_mtime_kept,
        });
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : '预检失败，请检查路径与 JuiceFS 日志');
      } finally {
        setPreviewing(false);
      }
      return;
    }

    try {
      await addMount({ name: cleanName, type: driverType, spec });
      setIsNewMountOpen(false);
      setPreview(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '创建挂载失败，请检查 spec 与后端日志');
    }
  };

  if (!isNewMountOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150 font-sans">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-xl overflow-hidden shadow-xl">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            <HardDrive className="w-5 h-5 text-indigo-600" />
            <h3 className="font-semibold text-sm text-slate-900">新增存储挂载</h3>
          </div>
          <button
            onClick={() => setIsNewMountOpen(false)}
            className="p-1 rounded-md hover:bg-slate-200/70 text-slate-400 hover:text-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {errorMsg && (
            <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Mount Name */}
          <div className="space-y-1">
            <label className="text-slate-700 font-medium">挂载名称 (mount name):</label>
            <div className="flex items-center gap-1.5 font-mono">
              <input
                type="text"
                required
                placeholder="例如: raw-media, archive-data"
                value={mountName}
                onChange={e => { setMountName(e.target.value); setPreview(null); }}
                className="flex-1 bg-white border border-slate-250 rounded-lg px-3 py-1.5 text-indigo-700 font-bold focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100"
              />
              <span className="text-slate-400">:/</span>
            </div>
            <p className="text-[11px] text-slate-400">
              后续将以此作为统一路径前缀：<code className="text-indigo-600 font-mono">{mountName || 'name'}:/path</code>
            </p>
          </div>

          {/* Driver Selection */}
          <div className="space-y-1.5">
            <label className="text-slate-700 font-medium">底层驱动协议 (Driver Kind):</label>
            <div className="grid grid-cols-4 gap-2">
              <button
                type="button"
                onClick={() => { setDriverType('s3'); setEndpoint('https://s3.us-west-2.amazonaws.com'); }}
                className={`p-2 rounded-lg border text-center transition-all ${
                  driverType === 's3'
                    ? 'bg-indigo-50 border-indigo-300 text-indigo-700 font-bold shadow-xs'
                    : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                <Cloud className="w-4 h-4 mx-auto mb-1 text-indigo-600" />
                <span>AWS S3</span>
              </button>

              <button
                type="button"
                onClick={() => { setDriverType('oss'); setEndpoint('https://oss-cn-hangzhou.aliyuncs.com'); }}
                className={`p-2 rounded-lg border text-center transition-all ${
                  driverType === 'oss'
                    ? 'bg-blue-50 border-blue-300 text-blue-700 font-bold shadow-xs'
                    : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                <Cloud className="w-4 h-4 mx-auto mb-1 text-blue-600" />
                <span>Aliyun OSS</span>
              </button>

              <button
                type="button"
                onClick={() => setDriverType('local')}
                className={`p-2 rounded-lg border text-center transition-all ${
                  driverType === 'local'
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-700 font-bold shadow-xs'
                    : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                <HardDrive className="w-4 h-4 mx-auto mb-1 text-emerald-600" />
                <span>Local / NAS</span>
              </button>

              <button
                type="button"
                onClick={() => setDriverType('fastdfs')}
                className={`p-2 rounded-lg border text-center transition-all ${
                  driverType === 'fastdfs'
                    ? 'bg-purple-50 border-purple-300 text-purple-700 font-bold shadow-xs'
                    : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                <Server className="w-4 h-4 mx-auto mb-1 text-purple-600" />
                <span>FastDFS</span>
              </button>
            </div>
          </div>

          {/* Dynamic Spec fields */}
          {(driverType === 's3' || driverType === 'oss' || driverType === 'minio') && (
            <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-3 font-sans">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-slate-600">Endpoint 接入点:</label>
                  <input
                    type="text"
                    value={endpoint}
                    onChange={e => setEndpoint(e.target.value)}
                    className="w-full bg-white border border-slate-250 rounded-lg px-2.5 py-1.5 text-slate-800 mt-0.5 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-600">Bucket 存储桶:</label>
                  <input
                    type="text"
                    required
                    placeholder="my-bucket-name"
                    value={bucket}
                    onChange={e => setBucket(e.target.value)}
                    className="w-full bg-white border border-slate-250 rounded-lg px-2.5 py-1.5 text-slate-800 mt-0.5 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-slate-600">Region 区域:</label>
                  <input
                    type="text"
                    value={region}
                    onChange={e => setRegion(e.target.value)}
                    className="w-full bg-white border border-slate-250 rounded-lg px-2.5 py-1.5 text-slate-800 mt-0.5 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-600">Prefix 隔离前缀 (可选):</label>
                  <input
                    type="text"
                    placeholder="可选，如 assets/"
                    value={prefix}
                    onChange={e => setPrefix(e.target.value)}
                    className="w-full bg-white border border-slate-250 rounded-lg px-2.5 py-1.5 text-slate-800 mt-0.5 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-slate-600">Access Key:</label>
                  <input
                    type="text"
                    placeholder="AKIA..."
                    value={accessKey}
                    onChange={e => setAccessKey(e.target.value)}
                    className="w-full bg-white border border-slate-250 rounded-lg px-2.5 py-1.5 text-slate-800 mt-0.5 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-600">Secret Key:</label>
                  <input
                    type="password"
                    placeholder="******"
                    value={secretKey}
                    onChange={e => setSecretKey(e.target.value)}
                    className="w-full bg-white border border-slate-250 rounded-lg px-2.5 py-1.5 text-slate-800 mt-0.5 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                  />
                </div>
              </div>
            </div>
          )}

          {driverType === 'local' && (
            <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-3 font-sans">
              <div>
                <label className="text-[11px] text-slate-600">接入策略:</label>
                <div className="grid grid-cols-3 gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => setIngestMode('metadata')}
                    className={`p-2 rounded-lg border text-center ${
                      ingestMode === 'metadata'
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-bold'
                        : 'bg-white border-slate-200 text-slate-600'
                    }`}
                  >
                    仅导入元数据
                  </button>
                  <button
                    type="button"
                    disabled
                    title="后续实现"
                    className="p-2 rounded-lg border border-slate-100 bg-slate-100 text-slate-400 cursor-not-allowed"
                  >
                    复制入库
                  </button>
                  <button
                    type="button"
                    disabled
                    title="后续实现"
                    className="p-2 rounded-lg border border-slate-100 bg-slate-100 text-slate-400 cursor-not-allowed"
                  >
                    空卷写入
                  </button>
                </div>
              </div>
              <div>
                <label className="text-[11px] text-slate-600">宿主机目录:</label>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <input
                    type="text"
                    required
                    placeholder="E:\data\photos"
                    value={localRoot}
                    onChange={e => { setLocalRoot(e.target.value); setPreview(null); }}
                    className="flex-1 bg-white border border-slate-250 rounded-lg px-2.5 py-1.5 text-slate-800 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setIsPickerOpen(true)}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-250 bg-white hover:bg-slate-50 text-slate-700 font-medium shrink-0"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-indigo-600" />
                    <span>浏览…</span>
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  填本机绝对路径，或点「浏览…」从已绑定盘符里逐级选。启动时会把本机已有盘符绑进容器
                  {hostHint.host_drives && hostHint.host_drives.length
                    ? `（当前：${hostHint.host_drives.join(' ')}）`
                    : '；若列表为空请用 scripts/run-foyer.ps1 重建'}
                  。
                </p>
              </div>
            </div>
          )}

          {driverType === 'fastdfs' && (
            <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-3 font-sans">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-slate-600">Tracker 地址:</label>
                  <input
                    type="text"
                    required
                    value={fdfsTracker}
                    onChange={e => setFdfsTracker(e.target.value)}
                    className="w-full bg-white border border-slate-250 rounded-lg px-2.5 py-1.5 text-slate-800 mt-0.5 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-600">存储组 (Group):</label>
                  <input
                    type="text"
                    required
                    value={fdfsGroup}
                    onChange={e => setFdfsGroup(e.target.value)}
                    className="w-full bg-white border border-slate-250 rounded-lg px-2.5 py-1.5 text-slate-800 mt-0.5 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                  />
                </div>
              </div>
            </div>
          )}

          {preview && driverType === 'local' && (
            <div className="bg-emerald-50/60 p-3.5 rounded-xl border border-emerald-200 space-y-2">
              <div className="flex items-center gap-1.5 text-emerald-800 font-medium">
                <FileCheck className="w-4 h-4" />
                <span>预检完成：将导入 {preview.scanned} 个对象到 {preview.dest}</span>
              </div>
              {preview.scanned === 0 ? (
                <p className="text-[11px] text-amber-700">
                  该目录下没有可导入的对象，请确认路径与容器挂载（当前盘符列表见上方提示）。
                </p>
              ) : (
                <>
                  <ul className="text-[11px] font-mono text-slate-600 space-y-0.5 max-h-32 overflow-y-auto">
                    {preview.objects.slice(0, 10).map(k => (
                      <li key={k} className="truncate">{`${preview.dest}/${k}`}</li>
                    ))}
                  </ul>
                  {preview.scanned > 10 && (
                    <p className="text-[11px] text-slate-400">…等共 {preview.scanned} 个（列表只显示前 10 个）</p>
                  )}
                  <p className="text-[11px] text-slate-500">
                    其中 {preview.mtime_kept} 个对象可保留原始修改时间
                    {preview.mtime_missing > 0 && `，${preview.mtime_missing} 个源未提供时间（将显示为导入时刻）`}
                  </p>
                  {preview.dir_mtime_kept > 0 && (
                    <p className="text-[11px] text-slate-500">
                      含 {preview.dir_mtime_kept} 个目录会保留原始修改时间（源里的空目录也会一并建出）
                    </p>
                  )}
                  <p className="text-[11px] text-slate-500">
                    确认后只写元数据，不复制文件内容；重复导入会跳过已存在的对象。
                  </p>
                </>
              )}
            </div>
          )}

          {/* Architecture Reminder */}
          <div className="text-[11px] text-slate-500 flex items-start gap-2 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
            <Info className="w-3.5 h-3.5 text-indigo-600 shrink-0 mt-0.5" />
            <span>
              仅导入元数据：不拷贝文件。JuiceFS 网关按原路径读取，删除只去元数据。复制入库 / 空卷写入后续开放。
            </span>
          </div>

          {/* Footer */}
          <div className="pt-2 border-t border-slate-200 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                if (preview) {
                  setPreview(null);
                  return;
                }
                setIsNewMountOpen(false);
              }}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"
            >
              {preview ? '返回修改' : '取消'}
            </button>
            <button
              type="submit"
              disabled={previewing || (preview !== null && preview.scanned === 0)}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors disabled:bg-slate-300"
            >
              {previewing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>预检中…</span>
                </>
              ) : preview ? (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>确认导入 {preview.scanned} 个对象</span>
                </>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  <span>预检并导入</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      <DirectoryPicker
        open={isPickerOpen}
        initialPath={localRoot}
        onSelect={p => {
          setLocalRoot(p);
          setPreview(null); // 路径变了，旧预检结果作废
          setIsPickerOpen(false);
        }}
        onClose={() => setIsPickerOpen(false)}
      />
    </div>
  );
};
