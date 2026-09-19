import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ApiError } from './errors';

const TOKEN_KEY = 'fs_token';
const USER_KEY = 'fs_user';
const SECRET_KEY = 'fs_secret';

export const JFS_BUCKET = 'foyer';
export const JFS_MOUNT = 'foyer';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function getSecret(): string {
  return localStorage.getItem(SECRET_KEY) || '';
}

export function hasToken(): boolean {
  return Boolean(getToken() && getSecret());
}

export function storedUser(): string {
  return localStorage.getItem(USER_KEY) || '';
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SECRET_KEY);
  localStorage.removeItem(USER_KEY);
}

export function saveCreds(accessKey: string, secretKey: string): void {
  localStorage.setItem(TOKEN_KEY, accessKey);
  localStorage.setItem(SECRET_KEY, secretKey);
  localStorage.setItem(USER_KEY, accessKey);
}

export function joinRef(mount: string, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${mount}:${p}`;
}

export function refToKey(ref: string): string {
  const i = ref.indexOf(':');
  const mount = i >= 0 ? ref.slice(0, i) : JFS_MOUNT;
  const rest = (i >= 0 ? ref.slice(i + 1) : ref).replace(/^\/+/, '').replace(/\/+$/, '');
  if (!mount || mount === JFS_MOUNT) return rest;
  return rest ? `${mount}/${rest}` : mount;
}

export function keyRelativeToMount(fullKey: string, mount: string): string {
  let k = fullKey.replace(/^\/+/, '');
  if (mount && mount !== JFS_MOUNT) {
    const prefix = `${mount}/`;
    if (k === mount) return '/';
    if (k.startsWith(prefix)) k = k.slice(prefix.length);
  }
  return k ? `/${k}` : '/';
}

function s3(): S3Client {
  const accessKeyId = getToken();
  const secretAccessKey = getSecret();
  if (!accessKeyId || !secretAccessKey) {
    throw new ApiError('未登录', 401);
  }
  return new S3Client({
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:19002',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function wrapS3Error(err: unknown): never {
  const e = err as {
    name?: string;
    message?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const code = e.Code || e.name || 'Error';
  const status = e.$metadata?.httpStatusCode;
  throw new ApiError(`JuiceFS 网关: ${code}: ${e.message || err}${status ? ` (${status})` : ''}`, status);
}

export async function headBucket(): Promise<void> {
  try {
    const out = await s3().send(new ListBucketsCommand({}));
    const names = (out.Buckets || []).map(b => b.Name).filter(Boolean) as string[];
    if (!names.includes(JFS_BUCKET)) {
      throw new ApiError(`网关没有卷桶 ${JFS_BUCKET}（现有: ${names.join(', ') || '无'}）`, 404);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    wrapS3Error(err);
  }
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

export interface ListPrefixOptions {
  /**
   * 是否顺带把本层子目录的 mtime 从控制面补上（`attachDirMtimes`）。
   *
   * 默认 true——文件管理器依赖它。导出报表这条链上必须传 false：`walk` 会自己
   * 按 500/批 stat 全部目录，若这里也补一次，每个目录会被查两遍同一个元数据
   * 引擎（N 个目录约提交 2N 条路径）。而 `attachDirMtimes` 没有分批，宽目录
   * （上万子目录）有 `juicefs stat` argv 超限的风险，所以不能反过来只留它。
   */
  withDirMtimes?: boolean;
}

export async function listPrefix(dirPath: string, opts: ListPrefixOptions = {}): Promise<ListEntry[]> {
  const prefixRaw = dirPath.replace(/^\/+/, '');
  const prefix = prefixRaw && !prefixRaw.endsWith('/') ? `${prefixRaw}/` : prefixRaw;
  const out = await s3().send(
    new ListObjectsV2Command({
      Bucket: JFS_BUCKET,
      Prefix: prefix || undefined,
      Delimiter: '/',
    })
  );
  const entries: ListEntry[] = [];
  const dirs: { pref: string; entry: ListEntry }[] = [];
  for (const p of out.CommonPrefixes || []) {
    const pref = p.Prefix || '';
    const name = pref.replace(prefix, '').replace(/\/$/, '');
    if (!name) continue;
    const entry: ListEntry = {
      name,
      key: `/${pref.replace(/\/$/, '')}`,
      is_dir: true,
    };
    entries.push(entry);
    dirs.push({ pref, entry });
  }
  for (const obj of out.Contents || []) {
    const k = obj.Key || '';
    if (!k || k === prefix) continue;
    if (k.endsWith('/')) continue;
    const name = k.slice(prefix.length);
    if (!name || name.includes('/')) continue;
    entries.push({
      name,
      key: `/${k}`,
      is_dir: false,
      size: obj.Size,
      etag: obj.ETag?.replace(/"/g, ''),
      mtime: obj.LastModified?.toISOString(),
    });
  }
  if (opts.withDirMtimes !== false) await attachDirMtimes(dirs);
  return entries;
}

/**
 * 为目录补齐真实 mtime。
 *
 * S3 列表里的目录只出现在 CommonPrefixes，天然没有时间；控制面 `/foyer/stat`
 * 才有。失败时（控制面不可用、目录刚被删等）刻意留空，让上层显示 '-'，
 * 绝不用当前时间冒充——那正是「文件夹时间不是真实的」的成因。
 */
async function attachDirMtimes(dirs: { pref: string; entry: ListEntry }[]): Promise<void> {
  if (dirs.length === 0) return;
  let stats: Map<string, FoyerStatResult>;
  try {
    stats = await foyerStat(dirs.map(d => `/${d.pref.replace(/\/$/, '')}`));
  } catch {
    return;
  }
  const times = dirMtimesFromStats(stats);
  for (const { entry } of dirs) {
    const iso = times.get(entry.key);
    if (iso) entry.mtime = iso;
  }
}

/**
 * 把 `/foyer/stat` 的结果折成「目录 key -> ISO 时间」。
 * error 条目与缺 mtime 的条目直接不出现，调用方据此保留空时间而不是编造。
 */
export function dirMtimesFromStats(stats: Map<string, FoyerStatResult>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, s] of stats) {
    if (!s || s.error || typeof s.mtime !== 'number') continue;
    out.set(key, mtimeISO(s.mtime, s.mtimensec));
  }
  return out;
}

/** 把 JuiceFS 的秒 + 纳秒折成 ISO 串，与 S3 LastModified 的形态保持一致。 */
export function mtimeISO(seconds: number, nanos = 0): string {
  return new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString();
}

export async function putEmptyDir(dirKey: string): Promise<void> {
  const key = dirKey.replace(/^\/+/, '').replace(/\/?$/, '/');
  await s3().send(new PutObjectCommand({ Bucket: JFS_BUCKET, Key: key, Body: '' }));
}

export async function putFile(fileKey: string, file: File, onProgress?: (ratio: number) => void): Promise<void> {
  const key = fileKey.replace(/^\/+/, '');
  await s3().send(
    new PutObjectCommand({
      Bucket: JFS_BUCKET,
      Key: key,
      Body: file,
      ContentType: file.type || 'application/octet-stream',
    })
  );
  onProgress?.(1);
}

export async function removeKey(fileKey: string): Promise<void> {
  const key = fileKey.replace(/^\/+/, '');
  await s3().send(new DeleteObjectCommand({ Bucket: JFS_BUCKET, Key: key }));
}

export async function copyKey(srcKey: string, dstKey: string): Promise<void> {
  const src = srcKey.replace(/^\/+/, '');
  const dst = dstKey.replace(/^\/+/, '');
  await s3().send(
    new CopyObjectCommand({
      Bucket: JFS_BUCKET,
      Key: dst,
      CopySource: `/${JFS_BUCKET}/${src}`,
    })
  );
}

export async function getObjectBlob(fileKey: string): Promise<Blob> {
  const key = fileKey.replace(/^\/+/, '');
  const res = await s3().send(new GetObjectCommand({ Bucket: JFS_BUCKET, Key: key }));
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes) throw new ApiError('空对象', 404);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy]);
}

export async function foyerHealth(): Promise<{
  ok: boolean;
  host_data?: string;
  host_mount?: string;
  host_drives?: string[];
  volume?: string;
}> {
  const res = await fetch('/foyer/health');
  if (!res.ok) throw new ApiError('健康检查失败', res.status);
  return (await res.json()) as {
    ok: boolean;
    host_data?: string;
    host_mount?: string;
    host_drives?: string[];
    volume?: string;
  };
}

export type FoyerMount = {
  id: string;
  name: string;
  type: string;
  status?: string;
  spec?: Record<string, string>;
  created_at?: string;
};

export async function foyerMounts(): Promise<FoyerMount[]> {
  const res = await fetch('/foyer/mounts');
  if (!res.ok) throw new ApiError('读取挂载表失败', res.status);
  const data = (await res.json()) as { mounts?: FoyerMount[] };
  return data.mounts || [];
}

export type FoyerImportResult = {
  dry_run: boolean;
  dest: string;
  scanned: number;
  imported: number;
  skipped: number;
  mtime_kept: number;
  mtime_missing: number;
  mode_kept: number;
  owner_kept: number;
  dir_mtime_kept: number;
  objects?: string[];
};

export async function foyerImport(body: {
  src: string;
  dest?: string;
  name?: string;
  mode?: string;
  dry_run?: boolean;
}): Promise<{ ok: boolean; mount?: FoyerMount; result?: FoyerImportResult }> {
  const res = await fetch('/foyer/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(text || '导入失败', res.status);
  }
  try {
    return JSON.parse(text) as { ok: boolean; mount?: FoyerMount; result?: FoyerImportResult };
  } catch {
    return { ok: true };
  }
}

export type FoyerStatResult = {
  path: string;
  /** 该路径解析失败时才有值；此时其余字段无意义。 */
  error?: string;
  type?: string;
  inode?: number;
  mode?: number;
  uid?: number;
  gid?: number;
  size?: number;
  nlink?: number;
  mtime?: number;
  mtimensec?: number;
};

/**
 * 读取卷内路径的真实元数据。
 *
 * 存在的理由：S3 数据面不携带目录时间。带分隔符列目录时目录只出现在
 * CommonPrefixes（没有 LastModified），对目录键 HeadObject 还会 404，
 * 所以目录时间只能从控制面拿。一次请求带上全部子目录路径，避免为每个目录
 * 起一个 juicefs 进程。
 */
export async function foyerStat(paths: string[]): Promise<Map<string, FoyerStatResult>> {
  const out = new Map<string, FoyerStatResult>();
  if (paths.length === 0) return out;
  const qs = new URLSearchParams();
  for (const p of paths) qs.append('path', p);
  const res = await fetch(`/foyer/stat?${qs.toString()}`);
  if (!res.ok) {
    throw new ApiError((await res.text()) || '读取元数据失败', res.status);
  }
  const body = (await res.json()) as { ok?: boolean; stats?: FoyerStatResult[] };
  for (const s of body.stats || []) {
    if (s && s.path) out.set(s.path, s);
  }
  return out;
}

export async function foyerDeleteMount(id: string): Promise<void> {
  const res = await fetch(`/foyer/mounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new ApiError((await res.text()) || '删除挂载失败', res.status);
  }
}

export async function foyerPatchMount(
  id: string,
  patch: { name?: string; spec?: Record<string, string>; status?: string }
): Promise<FoyerMount> {
  const res = await fetch(`/foyer/mounts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(text || '更新挂载失败', res.status);
  const data = JSON.parse(text) as { mount: FoyerMount };
  return data.mount;
}

export async function foyerResyncMount(id: string): Promise<FoyerImportResult> {
  const res = await fetch(`/foyer/mounts/${encodeURIComponent(id)}/resync`, { method: 'POST' });
  const text = await res.text();
  if (!res.ok) throw new ApiError(text || '增量同步失败', res.status);
  const data = JSON.parse(text) as { ok: boolean; result: FoyerImportResult };
  return data.result;
}

export type FoyerBrowseEntry = {
  name: string;
  path: string;
  mtime?: string;
};

export type FoyerBrowseResult = {
  ok: boolean;
  path: string;
  parent: string;
  drives: string[];
  entries: FoyerBrowseEntry[];
};

/**
 * 列出宿主机目录下的子目录。path 必须是宿主机形式（如 G:\20260619）；
 * 省略表示只要盘符列表。
 *
 * query 绝对不能手工拼：路径里的 # 会被下游读成 fragment 分隔符，导致列到
 * 父目录——这正是之前导入路径被截断成 G:\20260619 的同一个坑。交给
 * URLSearchParams 编码成 %23 后，服务端 URL.Query() 能还原出原值。
 */
export async function foyerBrowse(path?: string): Promise<FoyerBrowseResult> {
  const p = (path || '').trim();
  const qs = new URLSearchParams();
  if (p) qs.set('path', p);
  const q = qs.toString();
  const res = await fetch(`/foyer/browse${q ? `?${q}` : ''}`);
  if (!res.ok) {
    throw new ApiError((await res.text()) || '读取目录失败', res.status);
  }
  const data = (await res.json()) as Partial<FoyerBrowseResult>;
  return {
    // 失败关闭：响应体显式说 ok:false 时绝不能当成功。当前无调用方读 ok，
    // 但类型暴露给未来消费者，默认 true 会把 false 静默吞掉。
    ok: data.ok ?? false,
    path: data.path || '',
    parent: data.parent || '',
    drives: data.drives || [],
    entries: data.entries || [],
  };
}

export type FoyerUsageVolume = {
  used: number;
  used_inodes: number;
  disk_total: number;
  disk_used: number;
  disk_free: number;
};

export type FoyerUsageSummary = {
  path: string;
  error?: string;
  size: number;
  length: number;
  files: number;
  dirs: number;
  inodes: number;
  /** 该路径所依赖存储池的实时占用；读不到池时三项整体缺席（不是 0） */
  disk_total?: number;
  disk_used?: number;
  disk_free?: number;
};

export type FoyerUsage = {
  volume: FoyerUsageVolume;
  summaries: FoyerUsageSummary[];
};

/**
 * 读卷与各挂载子树的真实用量。一次请求带上全部路径：控制面要为每个 `juicefs usage`
 * 起一个进程，逐个请求会把进程启动开销乘上去。
 *
 * 用 URLSearchParams 拼 query：卷内路径可能含 `#`/空格/CJK（如
 * `/av_20260619` 的来源目录名），手工拼串会被下游读成 fragment。
 */
export async function foyerUsage(paths: string[] = []): Promise<FoyerUsage> {
  const qs = new URLSearchParams();
  for (const p of paths) qs.append('path', p);
  const q = qs.toString();
  const res = await fetch(`/foyer/usage${q ? `?${q}` : ''}`);
  if (!res.ok) throw new ApiError((await res.text()) || '读取用量失败', res.status);
  return (await res.json()) as FoyerUsage;
}
