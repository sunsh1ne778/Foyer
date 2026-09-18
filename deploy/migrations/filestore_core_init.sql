CREATE TABLE IF NOT EXISTS mounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  spec_json JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS fs_nodes (
  mount_id TEXT NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  is_dir BOOLEAN NOT NULL,
  size BIGINT NOT NULL DEFAULT 0,
  etag TEXT,
  mtime TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (mount_id, key)
);
CREATE INDEX IF NOT EXISTS fs_nodes_parent ON fs_nodes (mount_id, (regexp_replace(key, '/[^/]+$', '')));

CREATE TABLE IF NOT EXISTS overlay_meta (
  mount_id TEXT NOT NULL,
  key TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]',
  custom JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (mount_id, key)
);
