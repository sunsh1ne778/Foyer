import * as defaultClient from '../api/client';
import { ApiError, type ApiJob, type ApiMount, type ListEntry } from '../api/client';
import { formatJson, formatKv, formatLsTable, formatMountTable } from './format';
import { parseLine } from './parse';

export type RefreshKind = 'directory' | 'mounts';

export type RunResult = {
  text: string;
  kind: 'ok' | 'error' | 'usage' | 'unsupported' | 'clear';
  refresh?: RefreshKind;
};

export type CliApi = {
  listFiles: (p: string) => Promise<{ entries: ListEntry[]; cursor?: string }>;
  statFile: (p: string) => Promise<Record<string, unknown>>;
  mkdir: (p: string) => Promise<Record<string, unknown>>;
  deletePath: (p: string) => Promise<void>;
  copyPath: (src: string, dst: string, asyncMode?: boolean) => Promise<{ ok?: boolean; job_id?: string }>;
  movePath: (src: string, dst: string, asyncMode?: boolean) => Promise<{ ok?: boolean; job_id?: string }>;
  getJob: (id: string) => Promise<ApiJob>;
  listMounts: () => Promise<{ mounts: ApiMount[] }>;
  createMount: (body: { name: string; type: string; spec: Record<string, string> }) => Promise<ApiMount>;
  deleteMount: (id: string) => Promise<void>;
  probeMount: (id: string) => Promise<{ ok: boolean }>;
  unmount: (id: string) => Promise<Record<string, unknown>>;
  remount: (id: string) => Promise<Record<string, unknown>>;
};

const HELP = `verbs:
  ls <mount:path>                 list directory
  stat <mount:path>               show metadata
  mkdir <mount:path>              create directory
  rm <mount:path>                 delete path
  cp <src> <dst>                  copy (async)
  mv <src> <dst>                  move (async)
  job <id>                        show job
  mount ls|list                   list mounts
  mount add <name> --type T [--spec k=v]
  mount rm|probe|unmount|mount <id>
  help                            this text
  clear                           clear terminal history

put/get are not available in the browser CLI; use the native filestore binary.
Global flag: --json`;

const PUT_GET = `put/get 需要本机路径，浏览器 CLI 第一期不支持。
请使用本机:
  filestore put <local> <mount:path>
  filestore get <mount:path> <local>`;

function usage(s: string): RunResult {
  return { text: `usage: ${s}`, kind: 'usage' };
}

function parseFlags(rest: string[]): { flags: Record<string, string[]>; error?: string; leftover: string[] } {
  const flags: Record<string, string[]> = {};
  const leftover: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (!t.startsWith('--')) {
      leftover.push(t);
      continue;
    }
    const key = t.slice(2);
    const val = rest[i + 1];
    if (!val || val.startsWith('--')) {
      return { flags, leftover, error: `missing value for --${key}` };
    }
    i++;
    if (!flags[key]) flags[key] = [];
    flags[key].push(val);
  }
  return { flags, leftover };
}

function parseSpec(values: string[] | undefined): { spec: Record<string, string>; error?: string } {
  const spec: Record<string, string> = {};
  for (const v of values || []) {
    const eq = v.indexOf('=');
    if (eq <= 0) return { spec, error: 'spec must be key=value' };
    spec[v.slice(0, eq)] = v.slice(eq + 1);
  }
  return { spec };
}

function dumpOr(json: boolean, value: unknown, text: string): string {
  return json ? formatJson(value) : text;
}

function transferLine(op: string, src: string, dst: string, res: { ok?: boolean; job_id?: string }): string {
  if (res.job_id) return `queued ${op} job_id=${res.job_id}`;
  return `${op} ${src} -> ${dst} ok`;
}

async function dispatch(argv: string[], json: boolean, api: CliApi): Promise<RunResult> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '-h') {
    return { text: HELP, kind: 'ok' };
  }
  const verb = argv[0];

  if (verb === 'clear') {
    if (argv.length > 1) return usage('clear');
    return { text: '', kind: 'clear' };
  }
  if (verb === 'login') {
    return { text: '已在控制台登录，会话 JWT 会随命令发送。无需 filestore login。', kind: 'ok' };
  }
  if (verb === 'put' || verb === 'get') {
    return { text: PUT_GET, kind: 'unsupported' };
  }

  if (verb === 'ls') {
    if (argv.length !== 2) return usage('ls <mount:path>');
    const data = await api.listFiles(argv[1]);
    return { text: dumpOr(json, data, formatLsTable(data.entries || [])), kind: 'ok' };
  }
  if (verb === 'stat') {
    if (argv.length !== 2) return usage('stat <mount:path>');
    const data = await api.statFile(argv[1]);
    return { text: dumpOr(json, data, formatKv(data)), kind: 'ok' };
  }
  if (verb === 'mkdir') {
    if (argv.length !== 2) return usage('mkdir <mount:path>');
    const data = await api.mkdir(argv[1]);
    return { text: dumpOr(json, data, `created ${argv[1]}`), kind: 'ok', refresh: 'directory' };
  }
  if (verb === 'rm') {
    if (argv.length !== 2) return usage('rm <mount:path>');
    await api.deletePath(argv[1]);
    return { text: dumpOr(json, { ok: true, p: argv[1] }, `removed ${argv[1]}`), kind: 'ok', refresh: 'directory' };
  }
  if (verb === 'cp') {
    if (argv.length !== 3) return usage('cp <src> <dst>');
    const data = await api.copyPath(argv[1], argv[2], true);
    return {
      text: dumpOr(json, data, transferLine('copy', argv[1], argv[2], data)),
      kind: 'ok',
      refresh: 'directory',
    };
  }
  if (verb === 'mv') {
    if (argv.length !== 3) return usage('mv <src> <dst>');
    const data = await api.movePath(argv[1], argv[2], true);
    return {
      text: dumpOr(json, data, transferLine('move', argv[1], argv[2], data)),
      kind: 'ok',
      refresh: 'directory',
    };
  }
  if (verb === 'job') {
    if (argv.length !== 2) return usage('job <id>');
    const data = await api.getJob(argv[1]);
    return { text: dumpOr(json, data, formatKv(data as unknown as Record<string, unknown>)), kind: 'ok' };
  }
  if (verb === 'mount') {
    return mountCmd(argv.slice(1), json, api);
  }

  return { text: `unknown command: ${verb}\n\n${HELP}`, kind: 'usage' };
}

async function mountCmd(argv: string[], json: boolean, api: CliApi): Promise<RunResult> {
  const sub = argv[0];
  if (!sub || sub === 'ls' || sub === 'list') {
    if (argv.length > 1) return usage('mount ls');
    const data = await api.listMounts();
    return { text: dumpOr(json, data, formatMountTable(data.mounts || [])), kind: 'ok' };
  }
  if (sub === 'add') {
    const parsed = parseFlags(argv.slice(1));
    if (parsed.error) return usage(`mount add <name> --type T [--spec k=v] (${parsed.error})`);
    if (parsed.leftover.length !== 1) return usage('mount add <name> --type T [--spec k=v]');
    const unknown = Object.keys(parsed.flags).filter(k => k !== 'type' && k !== 'spec');
    if (unknown.length) return usage(`mount add: unknown flag --${unknown[0]}`);
    const spec = parseSpec(parsed.flags.spec);
    if (spec.error) return usage(`mount add --spec key=value`);
    const type = parsed.flags.type?.[0] || 'local';
    const data = await api.createMount({ name: parsed.leftover[0], type, spec: spec.spec });
    return { text: dumpOr(json, data, formatKv(data as unknown as Record<string, unknown>)), kind: 'ok', refresh: 'mounts' };
  }
  if (sub === 'rm' || sub === 'probe' || sub === 'unmount' || sub === 'mount') {
    if (argv.length !== 2) return usage(`mount ${sub} <id>`);
    const id = argv[1];
    if (sub === 'rm') {
      await api.deleteMount(id);
      return { text: dumpOr(json, { ok: true, id }, `removed mount ${id}`), kind: 'ok', refresh: 'mounts' };
    }
    if (sub === 'probe') {
      const data = await api.probeMount(id);
      return { text: dumpOr(json, data, formatKv(data as unknown as Record<string, unknown>)), kind: 'ok' };
    }
    if (sub === 'unmount') {
      const data = await api.unmount(id);
      return { text: dumpOr(json, data, formatKv(data)), kind: 'ok', refresh: 'mounts' };
    }
    const data = await api.remount(id);
    return { text: dumpOr(json, data, formatKv(data)), kind: 'ok', refresh: 'mounts' };
  }
  return usage('mount ls|add|rm|probe|unmount|mount');
}

const liveApi: CliApi = {
  listFiles: defaultClient.listFiles,
  statFile: defaultClient.statFile,
  mkdir: defaultClient.mkdir,
  deletePath: defaultClient.deletePath,
  copyPath: defaultClient.copyPath,
  movePath: defaultClient.movePath,
  getJob: defaultClient.getJob,
  listMounts: defaultClient.listMounts,
  createMount: defaultClient.createMount,
  deleteMount: defaultClient.deleteMount,
  probeMount: defaultClient.probeMount,
  unmount: defaultClient.unmount,
  remount: defaultClient.remount,
};

export async function runCli(line: string, api: CliApi = liveApi): Promise<RunResult> {
  try {
    const { json, argv } = parseLine(line);
    return await dispatch(argv, json, api);
  } catch (err) {
    if (err instanceof ApiError) {
      const status = err.status ? ` (${err.status})` : '';
      return { text: `error: ${err.message}${status}`, kind: 'error' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `error: ${msg}`, kind: 'error' };
  }
}
