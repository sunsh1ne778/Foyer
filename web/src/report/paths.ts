/**
 * 报表用的路径工具。全部是纯函数：不碰网络、不碰 localStorage，
 * 因此可以在 vitest 的 node 环境直接单测。
 */

/** 拼接子路径：`childPath('/', 'a') -> '/a'`，`childPath('/a', 'b') -> '/a/b'`。 */
export function childPath(parent: string, name: string): string {
  const base = parent.replace(/\/+$/, '');
  return base === '' ? `/${name}` : `${base}/${name}`;
}

/** 父目录路径。根目录的父仍是它自己，保证 `parent_path` 永远不是空串。 */
export function parentOf(path: string): string {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/') return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** 取 basename；根目录返回 `''`，由调用方决定回退成什么名字。 */
export function baseName(path: string): string {
  const p = path.replace(/\/+$/, '');
  if (p === '') return '';
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * 取扩展名：小写、不含点。
 * 目录、无后缀文件、dotfile（`.gitignore`）、尾点（`weird.`）一律返回 `""`。
 */
export function deriveExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}
