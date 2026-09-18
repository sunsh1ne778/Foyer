package overlay

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Meta struct {
	Tags   []string
	Custom map[string]any
}

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) Get(ctx context.Context, mountID, key string) (Meta, error) {
	var tagsRaw, customRaw []byte
	err := s.pool.QueryRow(ctx, `SELECT tags, custom FROM overlay_meta WHERE mount_id=$1 AND key=$2`, mountID, key).
		Scan(&tagsRaw, &customRaw)
	if err == pgx.ErrNoRows {
		return Meta{Tags: []string{}, Custom: map[string]any{}}, nil
	}
	if err != nil {
		return Meta{}, err
	}
	m := Meta{Tags: []string{}, Custom: map[string]any{}}
	_ = json.Unmarshal(tagsRaw, &m.Tags)
	_ = json.Unmarshal(customRaw, &m.Custom)
	return m, nil
}

func (s *Store) Set(ctx context.Context, mountID, key string, m Meta) error {
	if m.Tags == nil {
		m.Tags = []string{}
	}
	if m.Custom == nil {
		m.Custom = map[string]any{}
	}
	tags, _ := json.Marshal(m.Tags)
	custom, _ := json.Marshal(m.Custom)
	_, err := s.pool.Exec(ctx, `
		INSERT INTO overlay_meta (mount_id, key, tags, custom) VALUES ($1,$2,$3,$4)
		ON CONFLICT (mount_id, key) DO UPDATE SET tags=EXCLUDED.tags, custom=EXCLUDED.custom`,
		mountID, key, tags, custom)
	return err
}
