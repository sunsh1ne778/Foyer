import React, { useState } from 'react';
import {
  Terminal,
  Code,
  Copy,
  Check,
  Play,
  ShieldCheck,
  Zap,
  Layers,
  ArrowRight,
  Database,
  ExternalLink
} from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';

export const CliPlaybook: React.FC = () => {
  const { currentMount, currentPath, currentRef } = useFileStore();

  const [activeTab, setActiveTab] = useState<'terminal' | 'routes' | 'principles'>('terminal');
  const [terminalInput, setTerminalInput] = useState<string>('filestore ls photos:/');
  const [terminalOutput, setTerminalOutput] = useState<string>(
    `$ filestore ls photos:/
NAME                          SIZE       ETAG                   MTIME
2026/                         -          -                      2026-03-16 14:30:00
branding/                     -          -                      2026-03-10 11:00:00
banner_spring_launch.png      4.66 MB    "9f7c32e18b0a887d"     2026-03-15 09:12:00
product_catalog_v3.pdf        13.55 MB   "3b8c4d1190aef481"     2026-03-14 16:20:00`
  );
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1800);
  };

  const handleRunCommand = (cmd: string) => {
    setTerminalInput(cmd);
    const trimmed = cmd.trim();

    if (trimmed.startsWith('filestore ls')) {
      setTerminalOutput(`$ ${cmd}
[OpenAPI GET /v1/fs/list?p=...] 查询 PostgreSQL 投影索引 fs_nodes
NAME                          SIZE       ETAG                   MTIME
2026/                         -          -                      2026-03-16 14:30:00
branding/                     -          -                      2026-03-10 11:00:00
banner_spring_launch.png      4.66 MB    "9f7c32e18b0a887d"     2026-03-15 09:12:00
product_catalog_v3.pdf        13.55 MB   "3b8c4d1190aef481"     2026-03-14 16:20:00
2 directories, 2 files listed.`);
    } else if (trimmed.startsWith('filestore stat')) {
      setTerminalOutput(`$ ${cmd}
[OpenAPI GET /v1/fs/stat?p=...]
Ref:        ${currentMount}:/banner_spring_launch.png
Kind:       s3 (AWS S3)
Size:       4,892,010 Bytes (4.66 MB)
ETag:       "9f7c32e18b0a887d12f1"
Mode:       redirect (307)
Overlay:    tags=["营销", "HeroBanner"], custom={resolution="3840x2160"}`);
    } else if (trimmed.startsWith('filestore get')) {
      setTerminalOutput(`$ ${cmd}
[OpenAPI GET /v1/fs?p=...]
HTTP/1.1 307 Temporary Redirect
Location: https://prod-team-photos-2026.s3.us-west-2.amazonaws.com/assets/banner_spring_launch.png?X-Amz-Signature=...
CLI Follow 307 ➔ 直连 S3 存储下载完成 (4.66 MB, 耗时 120ms)
数据流未经过 API 网关，完全控制面/数据面分离！`);
    } else if (trimmed.startsWith('filestore cp')) {
      setTerminalOutput(`$ ${cmd}
[OpenAPI POST /v1/fs/copy]
检测到跨后端挂载 (s3 ➔ local)，两端驱动无直接原生拷贝能力。
HTTP/1.1 202 Accepted
{"job_id": "job-copy-9021", "status": "queued", "message": "已交由 Asynq Worker 执行"}
后台 Worker 正流式传输数据并写透目标 PG 索引...`);
    } else if (trimmed.startsWith('filestore mount')) {
      setTerminalOutput(`$ ${cmd}
[OpenAPI GET /v1/mounts]
NAME             TYPE       STATUS       CAPS(Presign/Multi/Dir)   NODES    BYTES
photos           s3         active       [✓, ✓, ✕]                 320      4.28 GB
oss-media        oss        active       [✓, ✓, ✕]                 85       18.4 GB
nas-backup       local      active       [✕, ✕, ✓]                 1420     84.9 GB
fastdfs-store    fastdfs    active       [✕, ✕, ✕]                 410      2.31 GB
minio-cold       minio      reconciling  [✓, ✓, ✕]                 5600     120.0 GB`);
    } else {
      setTerminalOutput(`$ ${cmd}
命令已由 VFS 内核执行响应:
Ref: ${currentRef}
Status: 200 OK`);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-slate-50 text-slate-800 font-sans">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6 border-b border-slate-200 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-slate-900 tracking-tight">统一门面契约 (CLI / OpenAPI / S3)</h1>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100 font-medium">
              Cobra & S3 Gateway
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1 max-w-2xl">
            平台坚持<strong>「一功能一通道」</strong>原则，无论是命令行、Web 管理控制台还是 S3 Gateway，全部对齐相同动词语义与路径规范。
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 mb-6 gap-6 text-xs font-medium text-slate-500">
        <button
          onClick={() => setActiveTab('terminal')}
          className={`pb-2.5 transition-colors ${
            activeTab === 'terminal'
              ? 'border-b-2 border-indigo-600 text-indigo-600 font-semibold'
              : 'hover:text-slate-800'
          }`}
        >
          CLI 交互终端与常用动词
        </button>
        <button
          onClick={() => setActiveTab('routes')}
          className={`pb-2.5 transition-colors ${
            activeTab === 'routes'
              ? 'border-b-2 border-indigo-600 text-indigo-600 font-semibold'
              : 'hover:text-slate-800'
          }`}
        >
          OpenAPI 动词契约对齐表
        </button>
        <button
          onClick={() => setActiveTab('principles')}
          className={`pb-2.5 transition-colors ${
            activeTab === 'principles'
              ? 'border-b-2 border-indigo-600 text-indigo-600 font-semibold'
              : 'hover:text-slate-800'
          }`}
        >
          内核设计准则
        </button>
      </div>

      {/* Content */}
      {activeTab === 'terminal' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Preset Buttons */}
          <div className="lg:col-span-4 space-y-3">
            <div className="text-xs font-semibold text-slate-700">预置测试命令</div>
            <div className="space-y-2 text-xs">
              {[
                { cmd: `filestore ls ${currentMount}:/`, desc: '列出挂载根目录 (查 PG 索引)' },
                { cmd: `filestore stat ${currentMount}:/banner_spring_launch.png`, desc: '获取元数据与标签' },
                { cmd: `filestore get ${currentMount}:/banner_spring_launch.png`, desc: '下载 (307 直传演示)' },
                { cmd: 'filestore cp photos:/a.jpg nas-backup:/b.jpg', desc: '跨源复制 (异步队列)' },
                { cmd: 'filestore mount list', desc: '查看系统所有挂载表' }
              ].map((item, i) => (
                <button
                  key={i}
                  onClick={() => handleRunCommand(item.cmd)}
                  className="w-full text-left p-2.5 rounded-lg bg-white border border-slate-200 hover:border-indigo-300 hover:shadow-xs transition-all group"
                >
                  <div className="font-mono text-xs text-indigo-700 group-hover:text-indigo-900 font-medium">
                    {item.cmd}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">{item.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Terminal Display */}
          <div className="lg:col-span-8 bg-slate-900 rounded-xl overflow-hidden shadow-lg border border-slate-800 flex flex-col h-96">
            <div className="bg-slate-950 px-4 py-2 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400 font-mono">
              <div className="flex items-center gap-2">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                </div>
                <span className="ml-2 text-slate-300">filestore-cli (v1.0.0)</span>
              </div>
              <button
                onClick={() => handleCopy(terminalOutput, 'term')}
                className="hover:text-slate-200 flex items-center gap-1"
              >
                {copied === 'term' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied === 'term' ? '已复制' : '复制'}</span>
              </button>
            </div>

            <pre className="flex-1 p-4 text-xs font-mono text-emerald-400 overflow-y-auto whitespace-pre-wrap leading-relaxed">
              {terminalOutput}
            </pre>

            <form
              onSubmit={e => {
                e.preventDefault();
                handleRunCommand(terminalInput);
              }}
              className="bg-slate-950 p-2.5 border-t border-slate-800 flex items-center gap-2 text-xs font-mono"
            >
              <span className="text-slate-400 font-bold">$</span>
              <input
                type="text"
                value={terminalInput}
                onChange={e => setTerminalInput(e.target.value)}
                className="flex-1 bg-transparent text-slate-100 focus:outline-none placeholder-slate-600"
                placeholder="输入命令回车执行..."
              />
              <button
                type="submit"
                className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-sans transition-colors"
              >
                执行
              </button>
            </form>
          </div>
        </div>
      )}

      {activeTab === 'routes' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden font-mono text-xs">
          <table className="w-full text-left">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px]">
              <tr>
                <th className="px-4 py-2.5 font-medium">统一动词</th>
                <th className="px-4 py-2.5 font-medium">OpenAPI Endpoint</th>
                <th className="px-4 py-2.5 font-medium">CLI 语法</th>
                <th className="px-4 py-2.5 font-medium font-sans">处理机制</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              <tr className="hover:bg-slate-50/50">
                <td className="px-4 py-3 font-bold text-slate-900">List</td>
                <td className="px-4 py-3 text-blue-600">GET /v1/fs/list?p=mount:path</td>
                <td className="px-4 py-3 text-slate-600">filestore ls &lt;ref&gt;</td>
                <td className="px-4 py-3 font-sans text-slate-600">命中 PostgreSQL 投影索引，零穿透后端</td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-4 py-3 font-bold text-slate-900">Get</td>
                <td className="px-4 py-3 text-blue-600">GET /v1/fs?p=mount:path</td>
                <td className="px-4 py-3 text-slate-600">filestore get &lt;ref&gt;</td>
                <td className="px-4 py-3 font-sans text-slate-600">307 直连重定向或流式代理传输</td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-4 py-3 font-bold text-slate-900">Copy</td>
                <td className="px-4 py-3 text-emerald-600">POST /v1/fs/copy</td>
                <td className="px-4 py-3 text-slate-600">filestore cp &lt;src&gt; &lt;dst&gt;</td>
                <td className="px-4 py-3 font-sans text-slate-600">同源原生执行；跨源入 Asynq 队列</td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-4 py-3 font-bold text-slate-900">Delete</td>
                <td className="px-4 py-3 text-rose-600">DELETE /v1/fs?p=mount:path</td>
                <td className="px-4 py-3 text-slate-600">filestore rm &lt;ref&gt;</td>
                <td className="px-4 py-3 font-sans text-slate-600">写透底层存储 + 软删除 PG 记录</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'principles' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-2">
            <div className="flex items-center gap-2 font-semibold text-slate-900 text-xs">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>控制面与数据面分离</span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              API 网关主要负责鉴权、元数据检索与签名颁发；大文件传输直接由客户端与云存储直连完成，杜绝网关成为瓶颈。
            </p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-2">
            <div className="flex items-center gap-2 font-semibold text-slate-900 text-xs">
              <Zap className="w-4 h-4 text-amber-600" />
              <span>统一契约无业务入侵</span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              全站统一使用 <code className="text-indigo-600 font-mono font-medium">mount:path</code> 路由体系，业务系统无需关心底层是 AWS S3、Aliyun OSS 还是本地 NAS。
            </p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-2">
            <div className="flex items-center gap-2 font-semibold text-slate-900 text-xs">
              <Database className="w-4 h-4 text-blue-600" />
              <span>PG 投影与异步对账</span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              查询性能由 PostgreSQL 关系索引保障；通过后台 Asynq 定期对账消除外部直存与索引库的不一致。
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
