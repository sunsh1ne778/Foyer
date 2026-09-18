import React, { useState } from 'react';
import {
  X,
  HardDrive,
  Cloud,
  Server,
  Plus,
  Info,
  ShieldAlert
} from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';
import { DriverType, DriverCaps } from '../types';

export const NewMountModal: React.FC = () => {
  const { isNewMountOpen, setIsNewMountOpen, addMount, mounts } = useFileStore();

  const [mountName, setMountName] = useState('');
  const [driverType, setDriverType] = useState<DriverType>('s3');
  const [errorMsg, setErrorMsg] = useState('');

  // S3 / MinIO spec
  const [endpoint, setEndpoint] = useState('https://s3.us-west-2.amazonaws.com');
  const [bucket, setBucket] = useState('');
  const [region, setRegion] = useState('us-west-2');
  const [prefix, setPrefix] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [pathStyle, setPathStyle] = useState('false');

  // Local / NAS spec
  const [localRoot, setLocalRoot] = useState('/mnt/storage/data');

  // FastDFS spec
  const [fdfsTracker, setFdfsTracker] = useState('192.168.1.100:22122');
  const [fdfsGroup, setFdfsGroup] = useState('group1');

  if (!isNewMountOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

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
      spec = {
        root: localRoot.trim(),
        prefix: prefix.trim()
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

    try {
      await addMount({ name: cleanName, type: driverType, spec });
      setIsNewMountOpen(false);
    } catch {
      setErrorMsg('创建挂载失败，请检查 spec 与后端日志');
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150 font-sans">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-xl overflow-hidden shadow-xl">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            <HardDrive className="w-5 h-5 text-indigo-600" />
            <h3 className="font-semibold text-sm text-slate-900">新增存储挂载 (POST /v1/mounts)</h3>
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
                onChange={e => setMountName(e.target.value)}
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
                <label className="text-[11px] text-slate-600">Host / NAS 根路径 (root):</label>
                <input
                  type="text"
                  required
                  value={localRoot}
                  onChange={e => setLocalRoot(e.target.value)}
                  className="w-full bg-white border border-slate-250 rounded-lg px-2.5 py-1.5 text-slate-800 mt-0.5 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  NAS 或宿主机已挂载的真实目录。Local 驱动具备 Directory 原生目录能力。
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

          {/* Architecture Reminder */}
          <div className="text-[11px] text-slate-500 flex items-start gap-2 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
            <Info className="w-3.5 h-3.5 text-indigo-600 shrink-0 mt-0.5" />
            <span>
              挂载信息将写入 PostgreSQL <code className="text-slate-800 font-mono font-medium">mounts</code> 表，API 实例通过 NOTIFY 监听热加载，挂载完成后系统自动启动一次全量对账。
            </span>
          </div>

          {/* Footer */}
          <div className="pt-2 border-t border-slate-200 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsNewMountOpen(false)}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>确认挂载并对账</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
