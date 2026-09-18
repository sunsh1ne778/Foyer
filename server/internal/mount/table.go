package mount

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"filestore/internal/driver"
)

type Record struct {
	ID        string
	Name      string
	Type      string
	Spec      map[string]string
	Status    string
	LastError string
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (r Record) PublicSpec() map[string]string {
	out := map[string]string{}
	for k, v := range r.Spec {
		lk := strings.ToLower(k)
		if strings.Contains(lk, "secret") || strings.Contains(lk, "password") || lk == "secret_key" {
			if v != "" {
				out[k] = "******"
			}
			continue
		}
		out[k] = v
	}
	return out
}

type loaded struct {
	rec Record
	drv driver.Driver
}

type Table struct {
	pool *pgxpool.Pool
	log  *zap.Logger
	mu   sync.RWMutex
	byID map[string]*loaded
	byNm map[string]*loaded
}

func NewTable(pool *pgxpool.Pool, log *zap.Logger) *Table {
	return &Table{
		pool: pool,
		log:  log,
		byID: map[string]*loaded{},
		byNm: map[string]*loaded{},
	}
}

func (t *Table) Start(ctx context.Context) error {
	if err := t.LoadAll(ctx); err != nil {
		return err
	}
	go t.poll(ctx)
	return nil
}

func (t *Table) poll(ctx context.Context) {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if err := t.LoadAll(ctx); err != nil {
				t.log.Warn("mount reload", zap.Error(err))
			}
		}
	}
}

func (t *Table) LoadAll(ctx context.Context) error {
	rows, err := t.pool.Query(ctx, `SELECT id, name, type, spec_json, status, last_error, created_at, updated_at FROM mounts`)
	if err != nil {
		return err
	}
	defer rows.Close()
	want := map[string]Record{}
	for rows.Next() {
		var r Record
		var spec []byte
		if err := rows.Scan(&r.ID, &r.Name, &r.Type, &spec, &r.Status, &r.LastError, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return err
		}
		r.Spec = map[string]string{}
		_ = json.Unmarshal(spec, &r.Spec)
		want[r.ID] = r
	}
	if err := rows.Err(); err != nil {
		return err
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	for id, cur := range t.byID {
		rec, ok := want[id]
		if !ok || rec.Status != "mounted" || specChanged(cur.rec, rec) {
			_ = cur.drv.Close()
			delete(t.byID, id)
			delete(t.byNm, cur.rec.Name)
			t.log.Info("driver closed", zap.String("id", id), zap.String("name", cur.rec.Name))
		}
	}
	for id, rec := range want {
		if rec.Status != "mounted" {
			continue
		}
		if _, ok := t.byID[id]; ok {
			t.byID[id].rec = rec
			t.byNm[rec.Name] = t.byID[id]
			continue
		}
		drv, err := driver.Open(rec.Type, rec.ID, rec.Spec)
		if err != nil {
			t.log.Warn("driver open", zap.String("id", id), zap.Error(err))
			_, _ = t.pool.Exec(ctx, `UPDATE mounts SET status='error', last_error=$2, updated_at=now() WHERE id=$1`, id, err.Error())
			continue
		}
		if err := drv.Health(ctx); err != nil {
			_ = drv.Close()
			t.log.Warn("driver health", zap.String("id", id), zap.Error(err))
			_, _ = t.pool.Exec(ctx, `UPDATE mounts SET status='error', last_error=$2, updated_at=now() WHERE id=$1`, id, err.Error())
			continue
		}
		item := &loaded{rec: rec, drv: drv}
		t.byID[id] = item
		t.byNm[rec.Name] = item
		t.log.Info("driver loaded", zap.String("id", id), zap.String("name", rec.Name), zap.String("type", rec.Type))
	}
	return nil
}

func specChanged(a, b Record) bool {
	if a.Type != b.Type || a.Name != b.Name {
		return true
	}
	if len(a.Spec) != len(b.Spec) {
		return true
	}
	for k, v := range a.Spec {
		if b.Spec[k] != v {
			return true
		}
	}
	return false
}

func (t *Table) Get(ref string) (Record, driver.Driver, error) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if item, ok := t.byID[ref]; ok {
		return item.rec, item.drv, nil
	}
	if item, ok := t.byNm[ref]; ok {
		return item.rec, item.drv, nil
	}
	return Record{}, nil, fmt.Errorf("mount %q not loaded", ref)
}

func (t *Table) GetRecord(ctx context.Context, idOrName string) (Record, error) {
	r, err := scanOne(t.pool.QueryRow(ctx, `SELECT id, name, type, spec_json, status, last_error, created_at, updated_at FROM mounts WHERE id=$1 OR name=$1`, idOrName))
	if err != nil {
		return Record{}, err
	}
	return r, nil
}

func (t *Table) List(ctx context.Context) ([]Record, error) {
	rows, err := t.pool.Query(ctx, `SELECT id, name, type, spec_json, status, last_error, created_at, updated_at FROM mounts ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Record
	for rows.Next() {
		var r Record
		var spec []byte
		if err := rows.Scan(&r.ID, &r.Name, &r.Type, &spec, &r.Status, &r.LastError, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		r.Spec = map[string]string{}
		_ = json.Unmarshal(spec, &r.Spec)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (t *Table) Attach(ctx context.Context, rec Record) error {
	if rec.ID == "" || rec.Name == "" || rec.Type == "" {
		return fmt.Errorf("id, name, type required")
	}
	if rec.Spec == nil {
		rec.Spec = map[string]string{}
	}
	spec, _ := json.Marshal(rec.Spec)
	now := time.Now().UTC()
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = now
	}
	rec.UpdatedAt = now
	if rec.Status == "" {
		rec.Status = "mounted"
	}
	_, err := t.pool.Exec(ctx, `
		INSERT INTO mounts (id, name, type, spec_json, status, last_error, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, type=EXCLUDED.type, spec_json=EXCLUDED.spec_json,
			status=EXCLUDED.status, last_error=EXCLUDED.last_error, updated_at=EXCLUDED.updated_at`,
		rec.ID, rec.Name, rec.Type, spec, rec.Status, rec.LastError, rec.CreatedAt, rec.UpdatedAt)
	if err != nil {
		return err
	}
	return t.LoadAll(ctx)
}

func (t *Table) Update(ctx context.Context, id string, name, typ *string, spec map[string]string, status *string) error {
	cur, err := t.GetRecord(ctx, id)
	if err != nil {
		return err
	}
	if name != nil {
		cur.Name = *name
	}
	if typ != nil {
		cur.Type = *typ
	}
	if spec != nil {
		if cur.Spec == nil {
			cur.Spec = map[string]string{}
		}
		for k, v := range spec {
			if v == "******" {
				continue
			}
			cur.Spec[k] = v
		}
	}
	if status != nil {
		cur.Status = *status
	}
	cur.UpdatedAt = time.Now().UTC()
	b, _ := json.Marshal(cur.Spec)
	_, err = t.pool.Exec(ctx, `UPDATE mounts SET name=$2, type=$3, spec_json=$4, status=$5, updated_at=$6 WHERE id=$1`,
		cur.ID, cur.Name, cur.Type, b, cur.Status, cur.UpdatedAt)
	if err != nil {
		return err
	}
	return t.LoadAll(ctx)
}

func (t *Table) Detach(ctx context.Context, id string) error {
	_, err := t.pool.Exec(ctx, `UPDATE mounts SET status='unmounted', updated_at=now() WHERE id=$1 OR name=$1`, id)
	if err != nil {
		return err
	}
	return t.LoadAll(ctx)
}

func (t *Table) Delete(ctx context.Context, id string) error {
	_, err := t.pool.Exec(ctx, `DELETE FROM mounts WHERE id=$1 OR name=$1`, id)
	if err != nil {
		return err
	}
	return t.LoadAll(ctx)
}

func (t *Table) Probe(ctx context.Context, typ string, spec map[string]string) error {
	drv, err := driver.Open(typ, "probe", spec)
	if err != nil {
		return err
	}
	defer drv.Close()
	return drv.Health(ctx)
}

func (t *Table) Close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for id, cur := range t.byID {
		_ = cur.drv.Close()
		delete(t.byID, id)
	}
	t.byNm = map[string]*loaded{}
}

func scanOne(row pgx.Row) (Record, error) {
	var r Record
	var spec []byte
	if err := row.Scan(&r.ID, &r.Name, &r.Type, &spec, &r.Status, &r.LastError, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return Record{}, err
	}
	r.Spec = map[string]string{}
	_ = json.Unmarshal(spec, &r.Spec)
	return r, nil
}
