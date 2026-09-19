import React, { useRef, useState } from 'react';
import { Download, FileJson, FileSpreadsheet, Loader2, X } from 'lucide-react';
import { JFS_BUCKET } from '../api/jfs';
import { useFileStore } from '../context/FileStoreContext';
import { reportFileName, toCSV, toJSON } from '../report/format';
import type { ReportFormat } from '../report/format';
import { downloadReport, runExport } from '../report/live';
import { REPORT_SCHEMA } from '../report/types';
import type { ReportScope, ReportSource } from '../report/types';

type ScopeKind = 'mount' | 'directory';

export const ExportReportModal: React.FC = () => {
  const { isExportOpen, setIsExportOpen, currentMount, currentPath, mounts, username } = useFileStore();

  const [kind, setKind] = useState<ScopeKind>('directory');
  const [format, setFormat] = useState<ReportFormat>('json');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const cancelRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  if (!isExportOpen) return null;

  const close = () => {
    // 关窗即取消：组件仍然挂载，不置位的话在飞的导出会在关窗后把报表悄悄下载下来。
    if (busy) cancelRef.current = true;
    setError('');
    setDone('');
    setIsExportOpen(false);
  };

  const mountObj = mounts.find(m => m.name === currentMount);
  const path = kind === 'mount' ? '/' : currentPath || '/';
  const ref = `${currentMount}:${path}`;

  const handleExport = async () => {
    if (!currentMount) return;
    cancelRef.current = false;
    setStopping(false);
    setProgress(0);
    setBusy(true);
    setError('');
    setDone('');
    try {
      const scope: ReportScope = {
        kind,
        mount: currentMount,
        path,
        ref,
        recursive: true,
        include_dirs: true,
        detail: 'basic',
      };
      // 已知取舍（已与用户确认）：整个 spec 照搬进报表，不做脱敏。今天不可能漏凭据——
      // client.ts 拒绝创建非 local 挂载，spec 里只有宿主路径；但 /foyer/mounts 本身不红敏，
      // 日后若支持对象存储挂载，access/secret 这类键会随报表带出。届时时改白名单过滤。
      const source: ReportSource = {
        volume: JFS_BUCKET,
        driver: mountObj?.type || '',
        mount_spec: { ...(mountObj?.spec || {}) },
      };

      const { report, cancelled } = await runExport({
        scope,
        source,
        operator: username || 'admin',
        onProgress: p => setProgress(p.entries),
        isCancelled: () => cancelRef.current,
      });
      if (cancelled) {
        setDone('已取消，未生成报表');
        return;
      }
      const text = format === 'json' ? toJSON(report) : toCSV(report);
      if (cancelRef.current) {
        // 取消发生在最后一批 stat 在飞的过程中（或全部批已完成）时，上面的
        // isCancelled 已经没有下一次机会被询问；这里再确认一次，让「取消/关窗」
        // 成为一个严格的「绝不下载」保证。
        setDone('已取消，未生成报表');
        return;
      }
      downloadReport(reportFileName(currentMount, format, report.generated_at), text, format);

      const s = report.summary;
      setDone(
        `已导出 ${s.entry_count} 条：文件 ${s.file_count} / 目录 ${s.dir_count}，` +
          `${s.error_count} 条读取失败${s.truncated ? '，已达上限被截断' : ''}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setBusy(false);
      setStopping(false);
      setProgress(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-indigo-600" />
            <span className="font-semibold text-sm text-slate-900">导出元数据报表</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">
              {REPORT_SCHEMA.replace('foyer.metadata-report/', '')}
            </span>
          </div>
          <button
            onClick={close}
            className="p-1 rounded-md hover:bg-slate-200/70 text-slate-400 hover:text-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 text-xs text-slate-700">
          <div>
            <div className="font-medium text-slate-800 mb-1.5">导出范围</div>
            <label className="flex items-start gap-2 p-2 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer">
              <input
                type="radio"
                name="export-scope"
                checked={kind === 'mount'}
                onChange={() => setKind('mount')}
                className="mt-0.5"
              />
              <span>
                <span className="font-mono font-semibold">{currentMount}:</span>
                <span className="block text-[11px] text-slate-500">整个分区（递归整棵子树）</span>
              </span>
            </label>
            <label className="flex items-start gap-2 p-2 mt-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer">
              <input
                type="radio"
                name="export-scope"
                checked={kind === 'directory'}
                onChange={() => setKind('directory')}
                className="mt-0.5"
              />
              <span>
                <span className="font-mono font-semibold">{currentMount}:{currentPath || '/'}</span>
                <span className="block text-[11px] text-slate-500">当前目录（递归该目录）</span>
              </span>
            </label>
          </div>

          <div>
            <div className="font-medium text-slate-800 mb-1.5">输出格式</div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setFormat('json')}
                className={`flex items-center justify-center gap-1.5 py-2 rounded-lg border transition-colors ${
                  format === 'json'
                    ? 'border-indigo-300 bg-indigo-50 text-indigo-700 font-medium'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <FileJson className="w-3.5 h-3.5" />
                <span>JSON（规范格式）</span>
              </button>
              <button
                type="button"
                onClick={() => setFormat('csv')}
                className={`flex items-center justify-center gap-1.5 py-2 rounded-lg border transition-colors ${
                  format === 'csv'
                    ? 'border-indigo-300 bg-indigo-50 text-indigo-700 font-medium'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>CSV（表格）</span>
              </button>
            </div>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-[11px] text-slate-500 leading-relaxed">
            <div>
              目标：<span className="font-mono text-slate-700">{ref}</span>
            </div>
            <div className="mt-1">
              只读清单报表：含路径、大小、ETag、修改时间（含出处）与扩展名汇总。
              不含文件内容、权限/属主，也<strong>不能</strong>用于恢复元数据。
            </div>
            <div className="mt-1">导出会递归读取该范围内的全部对象，大目录可能较慢。</div>
          </div>

          {error && (
            <div className="bg-rose-50 border border-rose-200 rounded-lg p-2.5 text-[11px] text-rose-700">
              {error}
            </div>
          )}
          {done && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 text-[11px] text-emerald-800">
              {done}
            </div>
          )}
        </div>

        <div className="p-3.5 border-t border-slate-200 flex items-center justify-end gap-2 bg-slate-50/40">
          <button
            type="button"
            onClick={close}
            className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"
          >
            关闭
          </button>
          {busy && (
            <button
              type="button"
              onClick={() => {
                cancelRef.current = true;
                setStopping(true);
              }}
              disabled={stopping}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-rose-600 hover:bg-rose-50 transition-colors disabled:text-slate-400 disabled:hover:bg-transparent"
            >
              {stopping ? '正在停止…' : '取消'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={busy || !currentMount}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors disabled:bg-slate-300"
          >
            {busy ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>导出中…（已读取 {progress ?? 0} 条）</span>
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                <span>导出 {format.toUpperCase()}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
