import { DriverCaps, DriverType } from '../types';

/** 与 server/internal/driver 各实现的 Caps() 对齐，供 UI 展示能力标签 */
const CAPS_BY_TYPE: Record<DriverType, DriverCaps> = {
  s3: {
    list: true,
    mkdir: true,
    copy: true,
    move: false,
    multipart: true,
    presign: true,
    directory: false,
  },
  minio: {
    list: true,
    mkdir: true,
    copy: true,
    move: false,
    multipart: true,
    presign: true,
    directory: false,
  },
  oss: {
    list: true,
    mkdir: true,
    copy: true,
    move: false,
    multipart: true,
    presign: true,
    directory: false,
  },
  local: {
    list: true,
    mkdir: true,
    copy: true,
    move: true,
    multipart: true,
    presign: false,
    directory: true,
  },
  fastdfs: {
    list: true,
    mkdir: false,
    copy: false,
    move: false,
    multipart: false,
    presign: false,
    directory: false,
  },
};

export function capsForDriver(type: string): DriverCaps {
  return CAPS_BY_TYPE[type as DriverType] ?? CAPS_BY_TYPE.s3;
}
