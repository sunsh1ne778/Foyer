export class ApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const TOKEN_KEY = 'fs_token';
const USER_KEY = 'fs_user';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function hasToken(): boolean {
  return Boolean(getToken());
}

export function storedUser(): string {
  return localStorage.getItem(USER_KEY) || '';
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

function authHeader(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function parseResponse(res: Response): Promise<Record<string, unknown>> {
  if (res.status === 204) return {};
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(String(data.error || res.statusText), res.status);
  }
  return data;
}

export function joinRef(mount: string, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${mount}:${p}`;
}

export async function login(username: string, password: string) {
  const res = await fetch('/v1/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await parseResponse(res);
  localStorage.setItem(TOKEN_KEY, String(data.token));
  localStorage.setItem(USER_KEY, String(data.username || username));
  return data;
}

export async function health(): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/v1/health');
  return parseResponse(res) as Promise<{ ok: boolean; error?: string }>;
}

export type ApiMount = {
  id: string;
  name: string;
  type: string;
  spec?: Record<string, string>;
  status?: string;
  last_error?: string;
  created_at?: string;
  updated_at?: string;
};

export async function listMounts(): Promise<{ mounts: ApiMount[] }> {
  return parseResponse(await fetch('/v1/mounts', { headers: authHeader() })) as Promise<{
    mounts: ApiMount[];
  }>;
}

export async function createMount(body: {
  id?: string;
  name: string;
  type: string;
  spec: Record<string, string>;
}): Promise<ApiMount> {
  return parseResponse(
    await fetch('/v1/mounts', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  ) as Promise<ApiMount>;
}

export async function patchMount(
  id: string,
  body: { name?: string; type?: string; spec?: Record<string, string>; status?: string }
): Promise<ApiMount> {
  return parseResponse(
    await fetch(`/v1/mounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  ) as Promise<ApiMount>;
}

export async function deleteMount(id: string): Promise<void> {
  await parseResponse(
    await fetch(`/v1/mounts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeader(),
    })
  );
}

export async function probeMount(id: string): Promise<{ ok: boolean }> {
  return parseResponse(
    await fetch(`/v1/mounts/${encodeURIComponent(id)}/probe`, {
      method: 'POST',
      headers: authHeader(),
    })
  ) as Promise<{ ok: boolean }>;
}

export async function reconcileMount(id: string): Promise<{ ok?: boolean; job_id?: string }> {
  const res = await fetch(`/v1/mounts/${encodeURIComponent(id)}/reconcile`, {
    method: 'POST',
    headers: authHeader(),
  });
  return parseResponse(res) as Promise<{ ok?: boolean; job_id?: string }>;
}

export type ListEntry = {
  name: string;
  key: string;
  is_dir: boolean;
  size?: number;
  etag?: string;
  mtime?: string;
  p?: string;
};

export async function listFiles(p: string): Promise<{ entries: ListEntry[]; cursor?: string }> {
  const qs = new URLSearchParams({ p });
  return parseResponse(await fetch(`/v1/fs/list?${qs}`, { headers: authHeader() })) as Promise<{
    entries: ListEntry[];
    cursor?: string;
  }>;
}

export async function statFile(p: string) {
  const qs = new URLSearchParams({ p });
  return parseResponse(await fetch(`/v1/fs/stat?${qs}`, { headers: authHeader() }));
}

export async function mkdir(p: string) {
  const qs = new URLSearchParams({ p });
  return parseResponse(
    await fetch(`/v1/fs/mkdir?${qs}`, { method: 'POST', headers: authHeader() })
  );
}

export async function deletePath(p: string): Promise<void> {
  const qs = new URLSearchParams({ p });
  await parseResponse(await fetch(`/v1/fs?${qs}`, { method: 'DELETE', headers: authHeader() }));
}

export async function downloadFile(p: string, filename: string): Promise<void> {
  const qs = new URLSearchParams({ p });
  const res = await fetch(`/v1/fs?${qs}`, { headers: authHeader(), redirect: 'follow' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(String((data as { error?: string }).error || '下载失败'), res.status);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type WriteInit = {
  id: string;
  mode?: string;
  part_size?: number;
  parts?: { n: number; url: string; headers?: Record<string, string>; size: number }[];
};

export async function uploadFile(
  file: File,
  dest: string,
  onProgress?: (ratio: number) => void
): Promise<void> {
  const init = (await parseResponse(
    await fetch('/v1/fs/writes', {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p: dest,
        size: file.size,
        mime: file.type || 'application/octet-stream',
      }),
    })
  )) as WriteInit;

  if (init.mode === 'redirect' && init.parts?.length) {
    let off = 0;
    for (const part of init.parts) {
      const blob = file.slice(off, off + part.size);
      const headers = { ...(part.headers || {}) };
      const res = await fetch(part.url, { method: 'PUT', headers, body: blob });
      if (!res.ok) throw new ApiError(`直传失败 ${res.status}`);
      off += part.size;
      onProgress?.(off / file.size);
    }
  } else {
    const partSize = init.part_size || 8 * 1024 * 1024;
    const total = Math.max(1, Math.ceil(file.size / partSize));
    for (let i = 0; i < total; i++) {
      const blob = file.slice(i * partSize, (i + 1) * partSize);
      await parseResponse(
        await fetch(`/v1/fs/writes/${init.id}/parts/${i + 1}`, {
          method: 'PUT',
          headers: authHeader(),
          body: blob,
        })
      );
      onProgress?.((i + 1) / total);
    }
  }

  await parseResponse(
    await fetch(`/v1/fs/writes/${init.id}/complete`, { method: 'POST', headers: authHeader() })
  );
}

export async function copyPath(src: string, dst: string, asyncMode = true) {
  const res = await fetch('/v1/fs/copy', {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ src, dst, async: asyncMode }),
  });
  return parseResponse(res) as Promise<{ ok?: boolean; job_id?: string }>;
}

export async function movePath(src: string, dst: string, asyncMode = true) {
  const res = await fetch('/v1/fs/move', {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ src, dst, async: asyncMode }),
  });
  return parseResponse(res) as Promise<{ ok?: boolean; job_id?: string }>;
}

export type ApiJob = {
  id: string;
  type: string;
  status: string;
  error?: string;
  src?: string;
  dst?: string;
  mount_id?: string;
};

export async function getJob(id: string): Promise<ApiJob> {
  return parseResponse(await fetch(`/v1/jobs/${encodeURIComponent(id)}`, { headers: authHeader() })) as Promise<
    ApiJob
  >;
}
