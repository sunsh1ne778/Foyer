import React, { useState } from 'react';
import { FolderTree, LogIn, AlertCircle } from 'lucide-react';
import { useFileStore } from '../context/FileStoreContext';

export const LoginScreen: React.FC = () => {
  const { login, authError } = useFileStore();
  const [username, setUsername] = useState('foyerak');
  const [password, setPassword] = useState('foyersecret');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    setSubmitting(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  };

  const err = localError || authError;

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-lg overflow-hidden">
        <div className="px-6 py-8 bg-gradient-to-br from-indigo-600 to-indigo-700 text-white">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center">
              <FolderTree className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Foyer 控制台</h1>
              <p className="text-indigo-100 text-xs mt-0.5">通过 JuiceFS S3 Gateway 连接卷 foyer</p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {err && (
            <div className="flex items-start gap-2 text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{err}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700">Access Key</label>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-500"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700">Secret Key</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-500"
            />
          </div>

          <p className="text-[11px] text-slate-500">
            与 compose 中 <code className="font-mono text-indigo-600">MINIO_ROOT_USER</code> /{' '}
            <code className="font-mono">MINIO_ROOT_PASSWORD</code> 相同（默认 foyerak / foyersecret）。先起{' '}
            <code className="font-mono">.\\scripts\\run-foyer.ps1</code>。
          </p>

          <button
            type="submit"
            disabled={submitting || !password}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            <LogIn className="w-4 h-4" />
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
};
