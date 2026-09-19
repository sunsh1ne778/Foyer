export { ApiError } from './errors';
import { ApiError } from './errors';
import { applyUsage, mergeMounts, mountVolumePath } from './mounts';
import * as jfs from './jfs';

export function getToken(): string {
  return jfs.getToken();
}

export function hasToken(): boolean {
  return jfs.hasToken();
}

export function storedUser(): string {
  return jfs.storedUser();
}

export function logout(): void {
  jfs.logout();
}

export function joinRef(mount: string, path: string): string {
  return jfs.joinRef(mount, path);
}

function unsupported(op: string): never {
  throw new ApiError(`${op} 在 JuiceFS 模式下不可用`, 501);
}

export async function login(username: string, password: string) {
  jfs.saveCreds(username.trim(), password);
  try {
    await jfs.headBucket();
  } catch (err) {
    jfs.logout();
    throw err;
  }
  return { username: username.trim() };
}

export async function health(): Promise<{ ok: boolean; error?: string }> {
  try {
    return await jfs.foyerHealth();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type ApiMountStats = {
  /** 该挂载的逻辑用量（字节，DirStats 口径） */
  total_bytes: number;
  /** 该挂载的 inode 数 */
  node_count: number;
  /**
   * 该挂载所依赖存储池的实时占用。三项**要么都有、要么都没有**：
   * 缺席表示读不到池，此时不画进度条（不要退化成 0% 或 100%）。
   */
  pool_total_bytes?: number;
  pool_used_bytes?: number;
  pool_free_bytes?: number;
};

export type ApiMount = {
  id: string;
  name: string;
  type: string;
  spec?: Record<string, string>;
  status?: string;
  last_error?: string;
  created_at?: string;
  updated_at?: string;
  stats?: ApiMountStats;
};

export async function listMounts(): Promise<{ mounts: ApiMount[] }> {
  await jfs.headBucket();
  let extra: ApiMount[] = [];
  try {
    extra = await jfs.foyerMounts();
  } catch {
    /* foyer 目录暂时不可用时仍暴露卷挂载 */
  }
  const merged = mergeMounts(extra);
  // 真实用量是加分项：控制面读不到时保留挂载列表，stats 缺席，UI 不画进度条。
  try {
    const paths = merged.filter(m => m.name !== jfs.JFS_MOUNT).map(mountVolumePath);
    applyUsage(merged, await jfs.foyerUsage(paths));
  } catch {
    /* ignore */
  }
  return { mounts: merged };
}

export async function createMount(body: {
  id?: string;
  name: string;
  type: string;
  spec: Record<string, string>;
}): Promise<ApiMount> {
  if (body.type !== 'local') {
    unsupported('该驱动尚未接到 JuiceFS');
  }
  const mode = body.spec.mode || 'metadata';
  if (mode !== 'metadata') {
    throw new ApiError('目前只支持「仅导入元数据」', 501);
  }
  const name = body.name.trim();
  const dest = `/${name}`;
  const out = await jfs.foyerImport({
    src: body.spec.root || body.spec.path || '',
    dest,
    name,
    mode: 'metadata',
  });
  const rec = out.mount;
  return {
    id: rec?.id || name,
    name: rec?.name || name,
    type: 'local',
    spec: rec?.spec || { ...body.spec, dest, mode },
    status: rec?.status || 'mounted',
    created_at: rec?.created_at,
  };
}

export async function patchMount(
  id: string,
  body: { name?: string; type?: string; spec?: Record<string, string>; status?: string }
): Promise<ApiMount> {
  const m = await jfs.foyerPatchMount(id, { name: body.name, spec: body.spec, status: body.status });
  return {
    id: m.id || id,
    name: m.name || id,
    type: m.type || 'local',
    spec: m.spec,
    status: m.status || 'mounted',
    created_at: m.created_at,
  };
}

export async function deleteMount(id: string): Promise<void> {
  await jfs.foyerDeleteMount(id);
}

export async function probeMount(_id: string): Promise<{ ok: boolean }> {
  await jfs.headBucket();
  return { ok: true };
}

export async function unmount(id: string): Promise<Record<string, unknown>> {
  return (await jfs.foyerPatchMount(id, { status: 'unmounted' })) as unknown as Record<string, unknown>;
}

export async function remount(_id: string): Promise<Record<string, unknown>> {
  await jfs.headBucket();
  return { ok: true };
}

export async function resyncMount(id: string): Promise<jfs.FoyerImportResult> {
  const out = await jfs.foyerResyncMount(id);
  await jfs.headBucket();
  return out;
}

export async function previewLocalImport(name: string, root: string): Promise<jfs.FoyerImportResult> {
  const out = await jfs.foyerImport({
    src: root,
    dest: `/${name}`,
    name,
    mode: 'metadata',
    dry_run: true,
  });
  if (!out.result) throw new ApiError('预检未返回结果', 502);
  return out.result;
}

export async function reconcileMount(_id: string): Promise<{ ok?: boolean; job_id?: string }> {
  unsupported('对账');
}

export type ListEntry = jfs.ListEntry;

export async function listFiles(p: string): Promise<{ entries: ListEntry[]; cursor?: string }> {
  const key = jfs.refToKey(p);
  const colon = p.indexOf(':');
  const mount = colon >= 0 ? p.slice(0, colon) : jfs.JFS_MOUNT;
  const entries = await jfs.listPrefix(key);
  return {
    entries: entries.map(e => ({
      ...e,
      key: jfs.keyRelativeToMount(e.key, mount),
    })),
  };
}

export async function statFile(p: string) {
  const entries = await jfs.listPrefix(jfs.refToKey(p).replace(/\/[^/]+$/, ''));
  const name = jfs.refToKey(p).split('/').pop();
  const hit = entries.find(e => e.name === name);
  if (!hit) throw new ApiError('not found', 404);
  return hit;
}

export async function mkdir(p: string) {
  await jfs.putEmptyDir(jfs.refToKey(p));
  return { ok: true };
}

export async function deletePath(p: string): Promise<void> {
  await jfs.removeKey(jfs.refToKey(p));
}

export async function downloadFile(p: string, filename: string): Promise<void> {
  const blob = await jfs.getObjectBlob(jfs.refToKey(p));
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function uploadFile(
  file: File,
  dest: string,
  onProgress?: (ratio: number) => void
): Promise<void> {
  await jfs.putFile(jfs.refToKey(dest), file, onProgress);
}

export async function copyPath(src: string, dst: string, _asyncMode = true) {
  await jfs.copyKey(jfs.refToKey(src), jfs.refToKey(dst));
  return { ok: true as const, job_id: undefined as string | undefined };
}

export async function movePath(src: string, dst: string, _asyncMode = true) {
  await jfs.copyKey(jfs.refToKey(src), jfs.refToKey(dst));
  await jfs.removeKey(jfs.refToKey(src));
  return { ok: true as const, job_id: undefined as string | undefined };
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

export async function getJob(_id: string): Promise<ApiJob> {
  unsupported('任务查询');
}
