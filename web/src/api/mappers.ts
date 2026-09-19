import * as api from './client';
import { capsForDriver } from '../utils/driverCaps';
import {
  Mount,
  MountStatus,
  FSNode,
  VFSJob,
  JobStatus,
  JobType,
} from '../types';

export function mapMountStatus(status?: string): MountStatus {
  switch (status) {
    case 'mounted':
    case 'active':
      return 'active';
    case 'reconciling':
      return 'reconciling';
    case 'unmounted':
      return 'unmounted';
    case 'error':
      return 'error';
    default:
      return 'active';
  }
}

export function mapMount(raw: api.ApiMount): Mount {
  const type = raw.type as Mount['type'];
  return {
    id: raw.id,
    name: raw.name,
    type,
    status: mapMountStatus(raw.status),
    last_error: raw.last_error || '',
    spec: raw.spec || {},
    caps: capsForDriver(type),
    created_at: raw.created_at || new Date().toISOString(),
    updated_at: raw.updated_at || new Date().toISOString(),
  };
}

export function mapListEntry(entry: api.ListEntry, mount: Mount): FSNode {
  const key = entry.key.startsWith('/') ? entry.key : `/${entry.key}`;
  return {
    mount_id: mount.id,
    mount_name: mount.name,
    key,
    name: entry.name,
    is_dir: entry.is_dir,
    size: entry.size ?? 0,
    etag: entry.etag,
    mtime: entry.mtime || '',
    updated_at: entry.mtime || '',
    tags: [],
    custom_meta: {},
  };
}

export function mapJob(raw: api.ApiJob, mountName?: string): VFSJob {
  const statusMap: Record<string, JobStatus> = {
    pending: 'queued',
    running: 'running',
    completed: 'completed',
    failed: 'failed',
  };
  let type: JobType = 'copy_async';
  if (raw.type === 'reconcile') type = 'reconcile';
  else if (raw.type === 'move') type = 'move_async';
  else if (raw.type === 'copy') type = 'copy_async';

  const status = statusMap[raw.status] || 'running';
  let progress = 40;
  if (status === 'completed') progress = 100;
  else if (status === 'queued') progress = 5;
  else if (status === 'failed') progress = 100;

  return {
    id: raw.id,
    type,
    mount_name: mountName,
    src_ref: raw.src,
    dst_ref: raw.dst,
    status,
    progress,
    message: raw.error || `${raw.type} · ${raw.status}`,
    started_at: new Date().toISOString(),
    completed_at: status === 'completed' || status === 'failed' ? new Date().toISOString() : undefined,
  };
}
