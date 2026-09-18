package index

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"filestore/internal/driver"
	pathx "filestore/internal/path"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) Upsert(ctx context.Context, mountID string, info driver.Info) error {
	mtime := info.ModTime
	if mtime.IsZero() {
		mtime = time.Now().UTC()
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO fs_nodes (mount_id, key, is_dir, size, etag, mtime, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,now())
		ON CONFLICT (mount_id, key) DO UPDATE SET
			is_dir=EXCLUDED.is_dir, size=EXCLUDED.size, etag=EXCLUDED.etag, mtime=EXCLUDED.mtime, updated_at=now()`,
		mountID, info.Key, info.IsDir, info.Size, info.ETag, mtime)
	return err
}

func (s *Store) Delete(ctx context.Context, mountID, key string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM fs_nodes WHERE mount_id=$1 AND key=$2`, mountID, key)
	return err
}

func (s *Store) DeletePrefix(ctx context.Context, mountID, prefix string) error {
	if prefix == "" {
		_, err := s.pool.Exec(ctx, `DELETE FROM fs_nodes WHERE mount_id=$1`, mountID)
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM fs_nodes WHERE mount_id=$1 AND (key=$2 OR key LIKE $3)`,
		mountID, prefix, prefix+"/%")
	return err
}

func (s *Store) Stat(ctx context.Context, mountID, key string) (driver.Info, error) {
	var info driver.Info
	err := s.pool.QueryRow(ctx, `SELECT key, is_dir, size, COALESCE(etag,''), mtime FROM fs_nodes WHERE mount_id=$1 AND key=$2`,
		mountID, key).Scan(&info.Key, &info.IsDir, &info.Size, &info.ETag, &info.ModTime)
	if err != nil {
		return driver.Info{}, err
	}
	return info, nil
}

func (s *Store) ListChildren(ctx context.Context, mountID, dir string, rec driver.ListRec) (driver.ListPage, error) {
	limit := rec.Limit
	if limit <= 0 {
		limit = 500
	}
	parent := stringsTrim(dir)
	if rec.Recursive {
		if parent == "" {
			q := `SELECT key, is_dir, size, COALESCE(etag,''), mtime FROM fs_nodes WHERE mount_id=$1 ORDER BY key LIMIT $2`
			return s.scan(ctx, q, mountID, limit)
		}
		q := `SELECT key, is_dir, size, COALESCE(etag,''), mtime FROM fs_nodes WHERE mount_id=$1 AND (key=$2 OR key LIKE $3) ORDER BY key LIMIT $4`
		return s.scan(ctx, q, mountID, parent, parent+"/%", limit)
	}
	q := `SELECT key, is_dir, size, COALESCE(etag,''), mtime FROM fs_nodes
		WHERE mount_id=$1 AND key <> $2 AND CASE
			WHEN $2 = '' THEN position('/' in key) = 0
			ELSE regexp_replace(key, '/[^/]+$', '') = $2
		END
		ORDER BY is_dir DESC, key LIMIT $3`
	return s.scan(ctx, q, mountID, parent, limit)
}

func (s *Store) ReplaceMount(ctx context.Context, mountID string, infos []driver.Info) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM fs_nodes WHERE mount_id=$1`, mountID); err != nil {
		return err
	}
	for _, info := range infos {
		mtime := info.ModTime
		if mtime.IsZero() {
			mtime = time.Now().UTC()
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO fs_nodes (mount_id, key, is_dir, size, etag, mtime, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,now())`,
			mountID, info.Key, info.IsDir, info.Size, info.ETag, mtime); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) scan(ctx context.Context, q string, args ...any) (driver.ListPage, error) {
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return driver.ListPage{}, err
	}
	defer rows.Close()
	var page driver.ListPage
	for rows.Next() {
		var info driver.Info
		if err := rows.Scan(&info.Key, &info.IsDir, &info.Size, &info.ETag, &info.ModTime); err != nil {
			return driver.ListPage{}, err
		}
		page.Entries = append(page.Entries, info)
	}
	return page, rows.Err()
}

func stringsTrim(dir string) string {
	return pathx.Join("", dir)
}
