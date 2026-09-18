import { Mount, FSNode, VFSJob } from './types';

export const INITIAL_MOUNTS: Mount[] = [
  {
    id: 'm-001',
    name: 'photos',
    type: 's3',
    status: 'active',
    last_error: '',
    spec: {
      endpoint: 'https://s3.us-west-2.amazonaws.com',
      bucket: 'prod-team-photos-2026',
      region: 'us-west-2',
      prefix: 'assets/',
      path_style: 'false',
      auto_create: 'false',
      access_key: 'AKIA***DEMO',
      secret_key: '******'
    },
    caps: {
      list: true,
      mkdir: false,
      copy: true,
      move: true,
      multipart: true,
      presign: true,
      directory: false
    },
    created_at: '2026-03-01T08:00:00Z',
    updated_at: '2026-03-15T10:30:00Z',
    stats: {
      total_bytes: 4285093840, // ~4.28 GB
      node_count: 320,
      last_reconciled: '2026-03-17T21:00:00Z'
    }
  },
  {
    id: 'm-002',
    name: 'oss-media',
    type: 'oss',
    status: 'active',
    last_error: '',
    spec: {
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      bucket: 'enterprise-video-cdn',
      region: 'cn-hangzhou',
      prefix: '',
      auto_create: 'false',
      access_key: 'LTAI***PROD',
      secret_key: '******'
    },
    caps: {
      list: true,
      mkdir: false,
      copy: true,
      move: true,
      multipart: true,
      presign: true,
      directory: false
    },
    created_at: '2026-02-18T14:20:00Z',
    updated_at: '2026-03-16T12:00:00Z',
    stats: {
      total_bytes: 18450912400, // ~18.4 GB
      node_count: 85,
      last_reconciled: '2026-03-17T18:30:00Z'
    }
  },
  {
    id: 'm-003',
    name: 'nas-backup',
    type: 'local',
    status: 'active',
    last_error: '',
    spec: {
      root: '/mnt/storage/enterprise-nas/backups',
      prefix: ''
    },
    caps: {
      list: true,
      mkdir: true,
      copy: true,
      move: true,
      multipart: false,
      presign: false, // Local/NAS has no Presign, VFS automatically uses Mode: stream
      directory: true
    },
    created_at: '2026-01-10T09:00:00Z',
    updated_at: '2026-03-17T04:15:00Z',
    stats: {
      total_bytes: 84930219400, // ~84.9 GB
      node_count: 1420,
      last_reconciled: '2026-03-17T22:00:00Z'
    }
  },
  {
    id: 'm-004',
    name: 'fastdfs-store',
    type: 'fastdfs',
    status: 'active',
    last_error: '',
    spec: {
      tracker: '192.168.10.201:22122',
      group: 'group1'
    },
    caps: {
      list: false, // FastDFS native has no hierarchical listing, index relies on PG projection!
      mkdir: false,
      copy: false,
      move: false,
      multipart: false,
      presign: false,
      directory: false
    },
    created_at: '2026-02-25T11:00:00Z',
    updated_at: '2026-03-14T09:40:00Z',
    stats: {
      total_bytes: 2310492100, // ~2.31 GB
      node_count: 410,
      last_reconciled: '2026-03-16T15:00:00Z'
    }
  },
  {
    id: 'm-005',
    name: 'minio-cold',
    type: 'minio',
    status: 'reconciling',
    last_error: '',
    spec: {
      endpoint: 'http://minio.internal:9000',
      bucket: 'cold-archive-data',
      path_style: 'true',
      auto_create: 'false',
      access_key: 'minioadmin',
      secret_key: '******'
    },
    caps: {
      list: true,
      mkdir: false,
      copy: true,
      move: true,
      multipart: true,
      presign: true,
      directory: false
    },
    created_at: '2026-03-10T16:00:00Z',
    updated_at: '2026-03-17T22:45:00Z',
    stats: {
      total_bytes: 120400192000, // ~120 GB
      node_count: 5600,
      last_reconciled: '正在执行对账...'
    }
  }
];

export const INITIAL_NODES: FSNode[] = [
  // --- photos:/ root and folders ---
  {
    mount_id: 'm-001',
    mount_name: 'photos',
    key: '/2026',
    name: '2026',
    is_dir: true,
    size: 0,
    mtime: '2026-03-16T14:30:00Z',
    updated_at: '2026-03-16T14:30:00Z',
    tags: ['年度归档'],
    custom_meta: { retention: '7y', department: 'design' }
  },
  {
    mount_id: 'm-001',
    mount_name: 'photos',
    key: '/branding',
    name: 'branding',
    is_dir: true,
    size: 0,
    mtime: '2026-03-10T11:00:00Z',
    updated_at: '2026-03-10T11:00:00Z',
    tags: ['品牌物料'],
    custom_meta: { public: 'true' }
  },
  {
    mount_id: 'm-001',
    mount_name: 'photos',
    key: '/banner_spring_launch.png',
    name: 'banner_spring_launch.png',
    is_dir: false,
    size: 4892010,
    etag: '"9f7c32e18b0a887d12f1"',
    mtime: '2026-03-15T09:12:00Z',
    updated_at: '2026-03-15T09:12:00Z',
    tags: ['营销', 'HeroBanner', 'HighRes'],
    custom_meta: { resolution: '3840x2160', author: 'chen' }
  },
  {
    mount_id: 'm-001',
    mount_name: 'photos',
    key: '/product_catalog_v3.pdf',
    name: 'product_catalog_v3.pdf',
    is_dir: false,
    size: 14209300,
    etag: '"3b8c4d1190aef4812301"',
    mtime: '2026-03-14T16:20:00Z',
    updated_at: '2026-03-14T16:20:00Z',
    tags: ['文档', '产品手册'],
    custom_meta: { version: '3.0.1' }
  },
  // inside /2026
  {
    mount_id: 'm-001',
    mount_name: 'photos',
    key: '/2026/summit_keynote.mp4',
    name: 'summit_keynote.mp4',
    is_dir: false,
    size: 320490200,
    etag: '"aa11bb22cc33dd44ee55"',
    mtime: '2026-03-16T18:00:00Z',
    updated_at: '2026-03-16T18:00:00Z',
    tags: ['峰会', '4K60fps'],
    custom_meta: { duration: '1820s' }
  },
  {
    mount_id: 'm-001',
    mount_name: 'photos',
    key: '/2026/group_photo_raw.dng',
    name: 'group_photo_raw.dng',
    is_dir: false,
    size: 48201940,
    etag: '"77c8d9e0f1a2b3c4d5e6"',
    mtime: '2026-03-16T18:40:00Z',
    updated_at: '2026-03-16T18:40:00Z',
    tags: ['RAW原片'],
    custom_meta: { camera: 'Sony A7R V' }
  },

  // --- oss-media:/ ---
  {
    mount_id: 'm-002',
    mount_name: 'oss-media',
    key: '/video_chunks',
    name: 'video_chunks',
    is_dir: true,
    size: 0,
    mtime: '2026-03-12T08:00:00Z',
    updated_at: '2026-03-12T08:00:00Z',
    tags: ['HLS切片'],
    custom_meta: { stream_id: 'live-091' }
  },
  {
    mount_id: 'm-002',
    mount_name: 'oss-media',
    key: '/commercial_ad_1080p.mov',
    name: 'commercial_ad_1080p.mov',
    is_dir: false,
    size: 890412000,
    etag: '"84a0d92ef1bc498a91c3"',
    mtime: '2026-03-11T15:20:00Z',
    updated_at: '2026-03-11T15:20:00Z',
    tags: ['广告片', 'CDN加速'],
    custom_meta: { bitrate: '12Mbps' }
  },
  {
    mount_id: 'm-002',
    mount_name: 'oss-media',
    key: '/trailer_audio_master.wav',
    name: 'trailer_audio_master.wav',
    is_dir: false,
    size: 64102900,
    etag: '"55f4e3d2c1b0a987890a"',
    mtime: '2026-03-10T19:30:00Z',
    updated_at: '2026-03-10T19:30:00Z',
    tags: ['无损音频'],
    custom_meta: { sample_rate: '96kHz/24bit' }
  },

  // --- nas-backup:/ ---
  {
    mount_id: 'm-003',
    mount_name: 'nas-backup',
    key: '/databases',
    name: 'databases',
    is_dir: true,
    size: 0,
    mtime: '2026-03-17T02:00:00Z',
    updated_at: '2026-03-17T02:00:00Z',
    tags: ['DB全量备份'],
    custom_meta: { engine: 'PostgreSQL 16' }
  },
  {
    mount_id: 'm-003',
    mount_name: 'nas-backup',
    key: '/databases/pg_filestore_prod_20260317.sql.gz',
    name: 'pg_filestore_prod_20260317.sql.gz',
    is_dir: false,
    size: 1840291000,
    etag: '"c239401bfd830182410a"',
    mtime: '2026-03-17T02:30:00Z',
    updated_at: '2026-03-17T02:30:00Z',
    tags: ['核心索引', '只读归档'],
    custom_meta: { md5: 'f9b4c8d1e0a29384756182938475a1b2' }
  },
  {
    mount_id: 'm-003',
    mount_name: 'nas-backup',
    key: '/system_configs.tar.zst',
    name: 'system_configs.tar.zst',
    is_dir: false,
    size: 4209100,
    etag: '"91823746192837461928"',
    mtime: '2026-03-16T23:50:00Z',
    updated_at: '2026-03-16T23:50:00Z',
    tags: ['配置快照'],
    custom_meta: { host: 'k8s-worker-pool-01' }
  },

  // --- fastdfs-store:/ ---
  {
    mount_id: 'm-004',
    mount_name: 'fastdfs-store',
    key: '/M00_00_01_wKgBZ2P432.png',
    name: 'M00_00_01_wKgBZ2P432.png',
    is_dir: false,
    size: 219400,
    etag: '"fastdfs-fid-01"',
    mtime: '2026-03-14T09:40:00Z',
    updated_at: '2026-03-14T09:40:00Z',
    tags: ['用户头像', 'FastDFS原生ID'],
    custom_meta: { group: 'group1', remote_path: 'M00/00/01/wKgBZ2P432.png' }
  },
  {
    mount_id: 'm-004',
    mount_name: 'fastdfs-store',
    key: '/M00_00_02_invoice_7781.pdf',
    name: 'M00_00_02_invoice_7781.pdf',
    is_dir: false,
    size: 1420900,
    etag: '"fastdfs-fid-02"',
    mtime: '2026-03-15T11:15:00Z',
    updated_at: '2026-03-15T11:15:00Z',
    tags: ['发票凭证'],
    custom_meta: { group: 'group1', remote_path: 'M00/00/02/invoice_7781.pdf' }
  }
];

export const INITIAL_JOBS: VFSJob[] = [
  {
    id: 'job-recon-881',
    type: 'reconcile',
    mount_name: 'minio-cold',
    status: 'running',
    progress: 68,
    speed: '450 nodes/s',
    message: '扫描底层 S3/MinIO 对象中，正在投影写入 PG fs_nodes 索引表...',
    started_at: '2026-03-17T22:45:00Z'
  },
  {
    id: 'job-copy-879',
    type: 'copy_async',
    src_ref: 'photos:/2026/summit_keynote.mp4',
    dst_ref: 'nas-backup:/archive/summit_keynote.mp4',
    status: 'running',
    progress: 84,
    speed: '48.2 MB/s',
    message: '跨挂载异步复制进行中 (Asynq queue: copy)，两端驱动无直接原生拷贝能力，Worker 正在执行流式传输',
    started_at: '2026-03-17T22:50:00Z'
  },
  {
    id: 'job-recon-870',
    type: 'reconcile',
    mount_name: 'photos',
    status: 'completed',
    progress: 100,
    message: '对账完成，与后端 320 个原生对象严格对齐，索引已是最新投影',
    started_at: '2026-03-17T21:00:00Z',
    completed_at: '2026-03-17T21:00:42Z'
  }
];
