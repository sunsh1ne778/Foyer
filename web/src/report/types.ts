/**
 * 导出元数据报表的数据模型。
 *
 * 这是**只读清单报表**，不是 `juicefs dump` 备份：不能 `load` 回来，不含
 * blob/chunks 映射、xattr/ACL、对象存储凭据。字段集刻意保持扁平，便于进
 * Excel / BI。
 */

/** schema 标识。格式发生任何不兼容变更时必须换版本号，解析方据此分流。 */
export const REPORT_SCHEMA = 'foyer.metadata-report/v1' as const;

/**
 * 生成器标识。version 与 web/package.json 的 version 手动保持一致：
 * 页面构建不注入 package 元数据，为此改 vite 配置不值得，发版时同步即可。
 */
export const REPORT_GENERATOR_NAME = 'foyer-web';
export const REPORT_GENERATOR_VERSION = '0.0.0';

export type ReportScopeKind = 'mount' | 'directory';
export type ReportDetail = 'basic';
/** mtime 的出处，用于审计：'s3' 来自数据面列表，'stat' 来自控制面，'none' 表示源没提供。 */
export type MtimeSource = 's3' | 'stat' | 'none';

export interface ReportScope {
  kind: ReportScopeKind;
  mount: string;
  /** 挂载内绝对路径，以 / 开头；kind='mount' 时固定为 '/'。 */
  path: string;
  ref: string;
  recursive: boolean;
  include_dirs: boolean;
  detail: ReportDetail;
}

export interface ReportGenerator {
  name: string;
  version: string;
  operator: string;
}

export interface ReportSource {
  volume: string;
  driver: string;
  mount_spec: Record<string, string>;
}

export interface ReportEntry {
  ref: string;
  path: string;
  parent_path: string;
  name: string;
  type: 'file' | 'dir';
  /** 小写、不含点；目录与无后缀文件为 ""。 */
  ext: string;
  size: number;
  etag: string | null;
  /** ISO-8601 UTC；源没提供就是 null。 */
  mtime: string | null;
  mtime_source: MtimeSource;
  /** 预留：标签持久化落地前恒为 []。 */
  tags: string[];
  /** 预留：标签持久化落地前恒为 {}。 */
  custom_meta: Record<string, string>;
}

export interface ReportError {
  path: string;
  stage: 'list' | 'stat';
  message: string;
}

export interface ExtensionBucket {
  ext: string;
  count: number;
  bytes: number;
}

export interface ReportSummary {
  entry_count: number;
  file_count: number;
  dir_count: number;
  total_bytes: number;
  by_extension: ExtensionBucket[];
  mtime_range: { min: string; max: string } | null;
  error_count: number;
  truncated: boolean;
}

export interface MetadataReport {
  schema: typeof REPORT_SCHEMA;
  generated_at: string;
  generator: ReportGenerator;
  scope: ReportScope;
  source: ReportSource;
  summary: ReportSummary;
  entries: ReportEntry[];
  errors: ReportError[];
}

/** walk 收集到的原始项；ref / ext / 汇总由 build 负责补。 */
export interface WalkItem {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size: number;
  etag: string | null;
  mtime: string | null;
  mtime_source: MtimeSource;
}
