import type { ApiMount } from './client';
import type { FoyerUsage } from './jfs';
import * as jfs from './jfs';

/** foyer 目录项的形状：type/status 允许缺省，由 mergeMounts 补默认值 */
export type FoyerMountLike = {
  id: string;
  name: string;
  type?: string;
  spec?: Record<string, string>;
  status?: string;
  created_at?: string;
};

/** 网关本身暴露的卷，永远排在挂载表第一位 */
export function volumeMount(): ApiMount {
  return {
    id: jfs.JFS_MOUNT,
    name: jfs.JFS_MOUNT,
    type: 's3',
    spec: { bucket: jfs.JFS_BUCKET, via: 'juicefs-gateway' },
    status: 'mounted',
  };
}

/** 仅导入元数据的挂载：内容只读，删除只去元数据 */
export function isMetadataImport(m: { spec?: Record<string, string> }): boolean {
  return (m.spec?.mode || '') === 'metadata';
}

/** 合并内置卷挂载与 foyer 目录项，保持卷在首位并跳过重名 */
export function mergeMounts(extra: FoyerMountLike[]): ApiMount[] {
  const out: ApiMount[] = [volumeMount()];
  for (const m of extra) {
    if (!m.name || m.name === jfs.JFS_MOUNT) continue;
    if (out.some(x => x.name === m.name)) continue;
    out.push({ ...m, type: m.type || 'local', status: m.status || 'mounted' });
  }
  return out;
}

/** 挂载在卷内的绝对路径：优先 spec.dest，否则 /name。 */
export function mountVolumePath(m: { id?: string; name: string; spec?: Record<string, string> }): string {
  const dest = (m.spec?.dest || '').trim();
  if (dest) return dest.startsWith('/') ? dest : `/${dest}`;
  return `/${m.name}`;
}

/**
 * 把 `/foyer/usage` 的结果贴到挂载列表上。纯函数：路径→stats 的对应关系只在这一处。
 *
 * 控制面报 error 的路径刻意**不**贴 stats：宁可让 UI 显示「无数据」，也不能拿 0
 * 冒充真实用量（那正是这次要修的 bug）。
 */
export function applyUsage(mounts: ApiMount[], usage: FoyerUsage): void {
  const cap = usage.volume.capacity;
  const byPath = new Map<string, FoyerUsage['summaries'][number]>();
  for (const s of usage.summaries || []) {
    if (s && s.path && !s.error) byPath.set(s.path, s);
  }
  for (const m of mounts) {
    if (m.name === jfs.JFS_MOUNT) {
      m.stats = {
        total_bytes: usage.volume.used,
        node_count: usage.volume.used_inodes,
        capacity_bytes: cap,
      };
      continue;
    }
    const s = byPath.get(mountVolumePath(m));
    if (s) m.stats = { total_bytes: s.size, node_count: s.inodes, capacity_bytes: cap };
  }
}
