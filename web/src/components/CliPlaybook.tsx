import React, { useMemo, useRef, useState } from 'react';
import { Copy, Check, ShieldCheck, Zap, Database } from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';
import { runCli, type RunResult } from '../cli/run';
import { joinRef } from '../api/client';

type HistItem = { id: number; cmd: string; text: string; kind: RunResult['kind'] };

export const CliPlaybook: React.FC = () => {
  const { currentMount, currentRef, selectedNode, refreshDirectory, refreshMounts } = useFileStore();

  const [activeTab, setActiveTab] = useState<'terminal' | 'routes' | 'principles'>('terminal');
  const [terminalInput, setTerminalInput] = useState<string>(`ls ${currentRef || `${currentMount}:/` || ''}`);
  const [history, setHistory] = useState<HistItem[]>([]);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const seq = useRef(0);
  const scroller = useRef<HTMLPreElement>(null);

  const statRef = selectedNode ? joinRef(currentMount, selectedNode.key) : currentRef;

  const presets = useMemo(
    () => [
      { cmd: `ls ${currentMount ? `${currentMount}:/` : currentRef}`, desc: '列出挂载根目录' },
      { cmd: `stat ${statRef}`, desc: '当前路径或选中项的元数据' },
      { cmd: 'mount ls', desc: '查看挂载表' },
      { cmd: 'help', desc: '已支持动词' },
    ],
    [currentMount, currentRef, statRef]
  );

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1800);
  };

  const handleRunCommand = async (cmd: string) => {
    const line = cmd.trim();
    setTerminalInput(cmd);
    if (!line || running) return;
    setRunning(true);
    try {
      const result = await runCli(line);
      if (result.kind === 'clear') {
        setHistory([]);
        return;
      }
      seq.current += 1;
      setHistory(prev => [...prev, { id: seq.current, cmd: line, text: result.text, kind: result.kind }]);
      if (result.refresh === 'directory') await refreshDirectory();
      if (result.refresh === 'mounts') await refreshMounts();
      requestAnimationFrame(() => {
        if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
      });
    } finally {
      setRunning(false);
    }
  };

  const copyBlob = history.map(h => `$ ${h.cmd}\n${h.text}`).join('\n\n') || '(empty)';

  const kindClass = (kind: HistItem['kind']) => {
    if (kind === 'error') return 'text-rose-400';
    if (kind === 'usage' || kind === 'unsupported') return 'text-amber-300';
    return 'text-emerald-400';
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-slate-50 text-slate-800 font-sans">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6 border-b border-slate-200 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-slate-900 tracking-tight">统一门面契约 (CLI / OpenAPI / S3)</h1>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100 font-medium">
              Cobra & S3 Gateway
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1 max-w-2xl">
            平台坚持<strong>「一功能一通道」</strong>原则。此终端用当前登录会话调用 <code className="font-mono">/v1</code>
            ，与本机 <code className="font-mono">filestore</code> 同一套动词。
          </p>
        </div>
      </div>

      <div className="flex border-b border-slate-200 mb-6 gap-6 text-xs font-medium text-slate-500">
        <button
          type="button"
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
          type="button"
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
          type="button"
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

      {activeTab === 'terminal' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-4 space-y-3">
            <div className="text-xs font-semibold text-slate-700">预置测试命令</div>
            <div className="space-y-2 text-xs">
              {presets.map((item, i) => (
                <button
                  key={i}
                  type="button"
                  disabled={running}
                  onClick={() => void handleRunCommand(item.cmd)}
                  className="w-full text-left p-2.5 rounded-lg bg-white border border-slate-200 hover:border-indigo-300 hover:shadow-xs transition-all group disabled:opacity-60"
                >
                  <div className="font-mono text-xs text-indigo-700 group-hover:text-indigo-900 font-medium">
                    {item.cmd}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">{item.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="lg:col-span-8 bg-slate-900 rounded-xl overflow-hidden shadow-lg border border-slate-800 flex flex-col h-96">
            <div className="bg-slate-950 px-4 py-2 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400 font-mono">
              <div className="flex items-center gap-2">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                </div>
                <span className="ml-2 text-slate-300">filestore-cli (web)</span>
              </div>
              <button type="button" onClick={() => handleCopy(copyBlob, 'term')} className="hover:text-slate-200 flex items-center gap-1">
                {copied === 'term' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied === 'term' ? '已复制' : '复制'}</span>
              </button>
            </div>

            <pre ref={scroller} className="flex-1 p-4 text-xs font-mono overflow-y-auto whitespace-pre-wrap leading-relaxed">
              {history.length === 0 && (
                <span className="text-slate-500">输入 filestore 动词后回车。会话已登录。put/get 请用本机 CLI。</span>
              )}
              {history.map(h => (
                <div key={h.id} className="mb-3 last:mb-0">
                  <div className="text-slate-300">$ {h.cmd}</div>
                  <div className={kindClass(h.kind)}>{h.text}</div>
                </div>
              ))}
            </pre>

            <form
              onSubmit={e => {
                e.preventDefault();
                void handleRunCommand(terminalInput);
              }}
              className="bg-slate-950 p-2.5 border-t border-slate-800 flex items-center gap-2 text-xs font-mono"
            >
              <span className="text-slate-400 font-bold">$</span>
              <input
                type="text"
                value={terminalInput}
                disabled={running}
                onChange={e => setTerminalInput(e.target.value)}
                className="flex-1 bg-transparent text-slate-100 focus:outline-none placeholder-slate-600 disabled:opacity-50"
                placeholder="输入命令回车执行..."
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="submit"
                disabled={running}
                className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-sans transition-colors disabled:opacity-50"
              >
                {running ? '执行中' : '执行'}
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
                <td className="px-4 py-3 font-sans text-slate-600">命中 PostgreSQL 投影索引</td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-4 py-3 font-bold text-slate-900">Stat</td>
                <td className="px-4 py-3 text-blue-600">GET /v1/fs/stat?p=mount:path</td>
                <td className="px-4 py-3 text-slate-600">filestore stat &lt;ref&gt;</td>
                <td className="px-4 py-3 font-sans text-slate-600">节点元数据</td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-4 py-3 font-bold text-slate-900">Copy</td>
                <td className="px-4 py-3 text-emerald-600">POST /v1/fs/copy</td>
                <td className="px-4 py-3 text-slate-600">filestore cp &lt;src&gt; &lt;dst&gt;</td>
                <td className="px-4 py-3 font-sans text-slate-600">同源原生；跨源 Asynq</td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-4 py-3 font-bold text-slate-900">Delete</td>
                <td className="px-4 py-3 text-rose-600">DELETE /v1/fs?p=mount:path</td>
                <td className="px-4 py-3 text-slate-600">filestore rm &lt;ref&gt;</td>
                <td className="px-4 py-3 font-sans text-slate-600">写透存储并更新索引</td>
              </tr>
              <tr className="hover:bg-slate-50/50">
                <td className="px-4 py-3 font-bold text-slate-900">Get / Put</td>
                <td className="px-4 py-3 text-blue-600">GET /v1/fs · POST /v1/fs/writes</td>
                <td className="px-4 py-3 text-slate-600">filestore get/put（本机）</td>
                <td className="px-4 py-3 font-sans text-slate-600">浏览器 CLI 第一期不执行，请用本机二进制</td>
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
