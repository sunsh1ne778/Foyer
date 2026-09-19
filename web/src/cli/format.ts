import { formatBytes, formatDate } from '../utils/formatters';
import type { ApiMount, ListEntry } from '../api/client';

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

export function formatLsTable(entries: ListEntry[]): string {
  const rows = (entries || []).map(e => ({
    name: e.is_dir ? `${e.name}/` : e.name,
    size: e.is_dir ? '-' : formatBytes(e.size ?? 0),
    etag: e.etag ? `"${e.etag}"` : '-',
    mtime: e.mtime ? formatDate(e.mtime) : '-',
  }));
  const headers = ['NAME', 'SIZE', 'ETAG', 'MTIME'];
  const widths = [
    Math.max(headers[0].length, ...rows.map(r => r.name.length), 4),
    Math.max(headers[1].length, ...rows.map(r => r.size.length), 4),
    Math.max(headers[2].length, ...rows.map(r => r.etag.length), 4),
    Math.max(headers[3].length, ...rows.map(r => r.mtime.length), 4),
  ];
  const head = `${pad(headers[0], widths[0])}  ${pad(headers[1], widths[1])}  ${pad(headers[2], widths[2])}  ${headers[3]}`;
  if (rows.length === 0) return `${head}\n(empty)`;
  const body = rows.map(
    r => `${pad(r.name, widths[0])}  ${pad(r.size, widths[1])}  ${pad(r.etag, widths[2])}  ${r.mtime}`
  );
  return [head, ...body].join('\n');
}

export function formatMountTable(mounts: ApiMount[]): string {
  const rows = (mounts || []).map(m => ({
    name: m.name || '-',
    type: m.type || '-',
    status: m.status || '-',
    id: m.id || '-',
  }));
  const headers = ['NAME', 'TYPE', 'STATUS', 'ID'];
  const widths = [
    Math.max(headers[0].length, ...rows.map(r => r.name.length), 4),
    Math.max(headers[1].length, ...rows.map(r => r.type.length), 4),
    Math.max(headers[2].length, ...rows.map(r => r.status.length), 4),
    Math.max(headers[3].length, ...rows.map(r => r.id.length), 4),
  ];
  const head = `${pad(headers[0], widths[0])}  ${pad(headers[1], widths[1])}  ${pad(headers[2], widths[2])}  ${headers[3]}`;
  if (rows.length === 0) return `${head}\n(empty)`;
  const body = rows.map(
    r => `${pad(r.name, widths[0])}  ${pad(r.type, widths[1])}  ${pad(r.status, widths[2])}  ${r.id}`
  );
  return [head, ...body].join('\n');
}

export function formatKv(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj);
  const w = Math.max(0, ...keys.map(k => k.length));
  return keys
    .map(k => {
      const v = obj[k];
      const text = v === undefined || v === null ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `${pad(k, w)}  ${text}`;
    })
    .join('\n');
}
