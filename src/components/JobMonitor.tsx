import React, { useState } from 'react';
import {
  Activity,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  StopCircle,
  ArrowRight
} from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';
import { formatDate } from '../utils/formatters';

export const JobMonitor: React.FC = () => {
  const { jobs, cancelJob, retryJob, mounts, triggerReconcile } = useFileStore();
  const [filterType, setFilterType] = useState<'all' | 'running' | 'completed'>('all');
  const [selectedMountForRecon, setSelectedMountForRecon] = useState<string>(mounts[0]?.name || 'photos');

  const filteredJobs = jobs.filter(j => {
    if (filterType === 'running') return j.status === 'running' || j.status === 'queued';
    if (filterType === 'completed') return j.status === 'completed' || j.status === 'failed';
    return true;
  });

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-slate-50 text-slate-800 font-sans">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6 border-b border-slate-200 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-slate-900 tracking-tight">异步作业调度与对账队列</h1>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-100 font-medium">
              Asynq Worker Pool
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1 max-w-2xl">
            跨挂载流式复制与存储全量对账均通过 Asynq 队列由后台 Worker 无状态消费。
          </p>
        </div>

        {/* Quick trigger reconcile */}
        <div className="flex items-center gap-2 bg-white p-1.5 rounded-lg border border-slate-200 shadow-xs">
          <span className="text-xs text-slate-500 pl-1">快速对账:</span>
          <select
            value={selectedMountForRecon}
            onChange={e => setSelectedMountForRecon(e.target.value)}
            className="bg-slate-50 text-slate-800 font-mono text-xs px-2 py-1 rounded border border-slate-200 focus:outline-none"
          >
            {mounts.map(m => (
              <option key={m.name} value={m.name}>
                {m.name}: ({m.type})
              </option>
            ))}
          </select>
          <button
            onClick={() => triggerReconcile(selectedMountForRecon)}
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium shadow-xs transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>发起对账</span>
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 mb-4 bg-slate-200/60 p-0.5 rounded-lg w-fit text-xs font-medium">
        <button
          onClick={() => setFilterType('all')}
          className={`px-3 py-1 rounded transition-colors ${
            filterType === 'all'
              ? 'bg-white text-slate-900 shadow-xs font-semibold'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          全部作业 ({jobs.length})
        </button>
        <button
          onClick={() => setFilterType('running')}
          className={`px-3 py-1 rounded transition-colors ${
            filterType === 'running'
              ? 'bg-white text-slate-900 shadow-xs font-semibold'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          进行中 ({jobs.filter(j => j.status === 'running').length})
        </button>
        <button
          onClick={() => setFilterType('completed')}
          className={`px-3 py-1 rounded transition-colors ${
            filterType === 'completed'
              ? 'bg-white text-slate-900 shadow-xs font-semibold'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          已完成 ({jobs.filter(j => j.status === 'completed').length})
        </button>
      </div>

      {/* Jobs List */}
      <div className="space-y-3">
        {filteredJobs.length === 0 ? (
          <div className="p-8 text-center text-slate-400 bg-white rounded-xl border border-slate-200 text-xs">
            暂无相关作业任务
          </div>
        ) : (
          filteredJobs.map(job => {
            const isRunning = job.status === 'running';
            const isCompleted = job.status === 'completed';
            const isFailed = job.status === 'failed';

            return (
              <div
                key={job.id}
                className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div className="p-2 rounded-lg bg-slate-50 border border-slate-200 shrink-0 mt-0.5">
                    {isRunning ? (
                      <RefreshCw className="w-4 h-4 text-indigo-600 animate-spin" />
                    ) : isCompleted ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-600" />
                    )}
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono font-bold text-xs text-slate-900">{job.id}</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 border border-slate-200">
                        {job.type === 'copy_async' ? '跨挂载复制' : job.type === 'move_async' ? '异步移动' : '全量对账修复'}
                      </span>
                    </div>

                    <div className="text-xs text-slate-600 font-mono flex items-center gap-1.5 truncate">
                      <span>{job.src_ref || job.mount_name}</span>
                      {job.dst_ref && (
                        <>
                          <ArrowRight className="w-3 h-3 text-slate-400 shrink-0" />
                          <span>{job.dst_ref}</span>
                        </>
                      )}
                    </div>

                    {isRunning && (
                      <div className="mt-2 w-64 max-w-full">
                        <div className="flex justify-between text-[11px] text-slate-500 mb-1 font-mono">
                          <span>进度: {Math.round(job.progress)}%</span>
                          <span>{job.speed || '传输中'}</span>
                        </div>
                        <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-indigo-600 rounded-full transition-all duration-300"
                            style={{ width: `${job.progress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right metadata & actions */}
                <div className="flex items-center justify-between md:justify-end gap-3 text-xs shrink-0">
                  <div className="text-right text-[11px] text-slate-400 font-mono">
                    <div>启动: {formatDate(job.started_at)}</div>
                    {isFailed && job.message && <div className="text-rose-500 font-sans">{job.message}</div>}
                  </div>

                  {isRunning && (
                    <button
                      onClick={() => cancelJob(job.id)}
                      className="px-2.5 py-1 rounded bg-slate-100 hover:bg-rose-50 text-slate-600 hover:text-rose-600 font-medium transition-colors"
                    >
                      取消
                    </button>
                  )}

                  {isFailed && (
                    <button
                      onClick={() => retryJob(job.id)}
                      className="px-2.5 py-1 rounded bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-medium transition-colors"
                    >
                      重试
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
