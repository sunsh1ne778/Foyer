/**
 * 宿主机侧能力：让「选择目录」弹出真正的 Windows 原生对话框，并拿回绝对路径。
 *
 * 这个端点由 Vite 开发服务器提供（见 `web/vite-plugin-pick-dir.ts`），不是 foyer
 * 后端——`/foyer/*` 跑在 Linux 容器里，弹不出 Windows 对话框。
 *
 * 为什么不能只用浏览器自带的目录选择器：它故意不吐真实路径。`<input
 * webkitdirectory>` 的 `value` 恒为 `C:\fakepath\<名字>`，File 对象没有 `path`
 * 属性；`showDirectoryPicker()` 的 handle 只有 `name`。而挂载要把 `G:\20260619`
 * 写进 spec.root，所以必须由宿主机进程弹框并回报路径。
 */

export type PickHostDirResult =
  | { status: 'picked'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable' };

/**
 * 弹出本机原生目录选择框。
 *
 * - `picked`：用户选了目录，`path` 是宿主机绝对路径（如 `G:\20260619\#整理完成`）。
 * - `cancelled`：用户主动关掉了对话框——调用方什么都不该做。
 * - `unavailable`：这台机器弹不了（生产构建、非 Windows、远端浏览器、接口 403/501）
 *   ——调用方应退回网页内目录选择器。
 */
export async function foyerPickHostDir(): Promise<PickHostDirResult> {
  let res: Response;
  try {
    res = await fetch('/__foyer/pick-dir');
  } catch {
    return { status: 'unavailable' };
  }
  if (!res.ok) return { status: 'unavailable' };

  // 契约：能弹框时响应体恒为 {"path": "..."}，取消时 path 为空串。任何别的形状
  // （HTML fallback、错误页、字段缺失）都算"这台机器弹不了"，不能让调用方误以为
  // 用户取消了——那会静默吞掉一次本可退回网页内选择器的机会。
  let data: { path?: unknown } | null = null;
  try {
    data = (await res.json()) as { path?: unknown };
  } catch {
    return { status: 'unavailable' };
  }
  if (!data || typeof data.path !== 'string') return { status: 'unavailable' };

  const path = data.path.trim();
  return path ? { status: 'picked', path } : { status: 'cancelled' };
}
