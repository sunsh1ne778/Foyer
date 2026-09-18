export type DriverType = 'local' | 's3' | 'minio' | 'oss' | 'fastdfs';

export interface DriverCaps {
  list: boolean;
  mkdir: boolean;
  copy: boolean;
  move: boolean;
  multipart: boolean;
  presign: boolean;
  directory: boolean; // true for real directory (POSIX/NAS), false for object key prefix (S3/OSS)
}

export type MountStatus = 'active' | 'reconciling' | 'unmounted' | 'error';

export interface Mount {
  id: string;
  name: string; // unique identifier, e.g. "photos", "backup", "raw-logs"
  type: DriverType;
  status: MountStatus;
  last_error: string;
  spec: Record<string, string>; // e.g. endpoint, bucket, region, root, prefix, etc.
  caps: DriverCaps;
  created_at: string;
  updated_at: string;
  stats?: {
    total_bytes: number;
    node_count: number;
    last_reconciled?: string;
  };
}

export interface FSNode {
  mount_id: string;
  mount_name: string;
  key: string; // POSIX path starting with /, e.g., "/2026/photo.jpg"
  name: string;
  is_dir: boolean;
  size: number;
  etag?: string;
  mtime: string;
  updated_at: string;
  tags: string[];
  custom_meta: Record<string, string>;
}

export interface ParsedRef {
  mount: string;
  path: string;
  raw: string; // "photos:/2026/photo.jpg"
}

export type TransferMode = 'redirect' | 'stream';

export interface ReadResult {
  mode: TransferMode;
  url?: string; // 307 Location for direct backend presigned URL
  headers?: Record<string, string>;
  body?: string;
}

export interface WriteSession {
  id: string;
  ref: string;
  mode: TransferMode;
  filename: string;
  size: number;
  parts_total: number;
  parts_completed: number;
  created_at: string;
  status: 'uploading' | 'completed' | 'aborted';
}

export type JobType = 'reconcile' | 'copy_async' | 'move_async' | 'bulk_delete';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface VFSJob {
  id: string;
  type: JobType;
  mount_name?: string;
  src_ref?: string;
  dst_ref?: string;
  status: JobStatus;
  progress: number; // 0-100
  speed?: string;
  message: string;
  started_at: string;
  completed_at?: string;
}

export interface SystemClusterInfo {
  apiNodes: number;
  workerNodes: number;
  postgresStatus: 'healthy' | 'degraded';
  redisStatus: 'healthy' | 'degraded';
  activeSessions: number;
  indexCount: number;
}
