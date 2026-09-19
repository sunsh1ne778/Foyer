import type { ApiMount } from './client';
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
