import { DriverType, ParsedRef } from '../types';

/**
 * Parses a path string according to the strict specification:
 * Syntax: mount:path (e.g. "photos:/2026/a.jpg" or "photos:a.jpg")
 * Path is always normalized to start with a leading slash and clean .. or //
 */
export function parseRef(s: string): ParsedRef {
  const trimmed = s.trim();
  const colonIndex = trimmed.indexOf(':');

  if (colonIndex === -1) {
    return {
      mount: trimmed || 'photos',
      path: '/',
      raw: `${trimmed || 'photos'}:/`
    };
  }

  const mount = trimmed.slice(0, colonIndex).trim();
  let rawPath = trimmed.slice(colonIndex + 1).trim();

  if (!rawPath.startsWith('/')) {
    rawPath = '/' + rawPath;
  }

  const segments = rawPath.split('/').filter(Boolean);
  const normalizedSegments: string[] = [];

  for (const seg of segments) {
    if (seg === '.') continue;
    if (seg === '..') {
      normalizedSegments.pop();
    } else {
      normalizedSegments.push(seg);
    }
  }

  const cleanPath = '/' + normalizedSegments.join('/');
  return {
    mount,
    path: cleanPath === '' ? '/' : cleanPath,
    raw: `${mount}:${cleanPath === '' ? '/' : cleanPath}`
  };
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function formatDate(dateString: string): string {
  if (!dateString) return '-';
  try {
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return dateString;
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  } catch {
    return dateString;
  }
}

export function getDriverColor(type: DriverType): { bg: string; text: string; border: string; label: string } {
  switch (type) {
    case 's3':
      return { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', label: 'AWS S3' };
    case 'oss':
      return { bg: 'bg-sky-50', text: 'text-sky-700', border: 'border-sky-200', label: 'Aliyun OSS' };
    case 'minio':
      return { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200', label: 'MinIO' };
    case 'local':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', label: 'Local / NAS' };
    case 'fastdfs':
      return { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', label: 'FastDFS' };
    default:
      return { bg: 'bg-slate-50', text: 'text-slate-700', border: 'border-slate-200', label: type };
  }
}

export function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop()?.toLowerCase() || '' : '';
}
