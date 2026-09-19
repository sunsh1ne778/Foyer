export type HostPathSegment = { label: string; value: string };

const DRIVE_RE = /^[A-Za-z]:$/;

/**
 * 把宿主机路径拆成面包屑。首段是盘符根（G:\），后续逐级累加。
 *
 * 盘符列表层级（空串）与非盘符路径都返回空数组——调用方据此不渲染面包屑。
 * 不做任何 URL 编码：这里的值会作为 query 参数交给 URLSearchParams 处理，
 * 手工编码会双重转义。
 */
export function hostPathSegments(path: string): HostPathSegment[] {
  const trimmed = (path || '').trim();
  if (!trimmed) return [];

  const parts = trimmed.replace(/\\+$/, '').split('\\');
  const drive = parts[0];
  if (!DRIVE_RE.test(drive)) return [];

  const out: HostPathSegment[] = [{ label: `${drive}\\`, value: `${drive}\\` }];
  let acc = `${drive}\\`;
  for (const seg of parts.slice(1)) {
    if (!seg) continue;
    acc += `${seg}\\`;
    out.push({ label: seg, value: acc.replace(/\\+$/, '') });
  }
  return out;
}
