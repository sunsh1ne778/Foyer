import type { ApiMount } from './client';
import type { FoyerSearchMatch } from './jfs';
import { JFS_MOUNT, mtimeISO } from './jfs';
import { mountVolumePath } from './mounts';
import type { SearchHit } from '../types';

/** 每页条数。仓库没有虚拟滚动依赖，分页是纯函数切片，可单测。 */
export const SEARCH_PAGE_SIZE = 100;

/**
 * 挂载在卷内的根路径。
 *
 * 卷挂载（foyer）的 spec 里没有 dest，直接套 mountVolumePath 会得到 `/foyer`——
 * 那是桶名不是卷内路径，会让卷挂载永远匹配不上任何命中。必须显式视作 `/`。
 */
export function mountRoot(m: { name: string; spec?: Record<string, string> }): string {
  if (m.name === JFS_MOUNT) return '/';
  return mountVolumePath(m);
}

/**
 * 段边界对齐的前缀判断。
 *
 * 不能用裸 startsWith：`/av` 会匹配 `/av_20260619`，把命中错划给另一个挂载。
 * 只有相等、或以 `dest + '/'` 开头才算同一条路径下。
 */
export function matchesDest(volumePath: string, dest: string): boolean {
  if (dest === '/') return true;
  return volumePath === dest || volumePath.startsWith(`${dest}/`);
}

/**
 * 把卷内绝对路径的命中归到挂载上。纯函数：路径→挂载的对应关系只在这一处。
 *
 * 取**最长**的 dest 胜出，所以嵌套挂载（`/av` 与 `/av_20260619`）里更具体的那条
 * 赢，与 mounts 列表顺序无关。不在任何 dest 下的路径落到卷挂载。
 */
export function attributeMatches(mounts: ApiMount[], matches: FoyerSearchMatch[]): SearchHit[] {
  const roots = mounts.map(m => ({ name: m.name, root: mountRoot(m) }));
  const out: SearchHit[] = [];
  for (const m of matches) {
    if (!m || !m.path) continue;
    let best: { name: string; root: string } | undefined;
    for (const r of roots) {
      if (!matchesDest(m.path, r.root)) continue;
      if (!best || r.root.length > best.root.length) best = r;
    }
    if (!best) continue; // 不在任何挂载下：宁可丢弃，也不冒充归属
    const key = best.root === '/' ? m.path : m.path.slice(best.root.length) || '/';
    out.push({
      mount: best.name,
      key,
      name: m.name,
      isDir: m.type === 'directory',
      size: m.size,
      mtime: mtimeISO(m.mtime, m.mtimensec),
      volumePath: m.path,
    });
  }
  return out;
}

/** 挂载内路径的父目录；在挂载根上返回 `/` 而不是空串。 */
export function parentKey(key: string): string {
  const clean = key.startsWith('/') ? key : `/${key}`;
  const i = clean.lastIndexOf('/');
  if (i <= 0) return '/';
  return clean.slice(0, i);
}

/**
 * 取第 page 页。越界页夹紧到有效范围（而不是返回空），这样翻页按钮的
 * disabled 判定与显示的总页数不会互相矛盾。空列表也报 1 页。
 */
export function pageSlice<T>(
  items: T[],
  page: number,
  pageSize = SEARCH_PAGE_SIZE
): { items: T[]; page: number; totalPages: number } {
  const size = pageSize > 0 ? pageSize : SEARCH_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const wanted = Number.isFinite(page) ? Math.floor(page) : 1;
  const p = Math.min(Math.max(1, wanted || 1), totalPages);
  return { items: items.slice((p - 1) * size, p * size), page: p, totalPages };
}
