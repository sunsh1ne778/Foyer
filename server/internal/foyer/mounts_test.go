package foyer

import (
	"path/filepath"
	"testing"
)

func TestMountStoreGetAndUpdate(t *testing.T) {
	s := newMountStore(filepath.Join(t.TempDir(), "mounts.json"))
	if _, err := s.upsert(MountRecord{
		ID: "photos", Name: "photos", Type: "local", Status: "mounted",
		Spec: map[string]string{"root": `E:\photos`, "dest": "/photos", "mode": "metadata"},
	}); err != nil {
		t.Fatal(err)
	}

	got, ok, err := s.update("photos", func(m *MountRecord) { m.Status = "unmounted" })
	if err != nil || !ok {
		t.Fatalf("update ok=%v err=%v", ok, err)
	}
	if got.Status != "unmounted" {
		t.Fatalf("status %s", got.Status)
	}

	// update 必须落盘，而不是只改内存。
	again, ok, err := s.get("photos")
	if err != nil || !ok {
		t.Fatalf("get ok=%v err=%v", ok, err)
	}
	if again.Status != "unmounted" {
		t.Fatalf("persisted status %s", again.Status)
	}
}

func TestMountStoreUpsertPreservesCreatedAt(t *testing.T) {
	s := newMountStore(filepath.Join(t.TempDir(), "mounts.json"))
	first, err := s.upsert(MountRecord{ID: "e2e", Name: "e2e", Type: "local", Status: "mounted"})
	if err != nil {
		t.Fatal(err)
	}
	if first.CreatedAt == "" {
		t.Fatal("upsert 返回的规范值必须带 created_at（调用方入参不含它）")
	}
	onDisk, ok, err := s.get("e2e")
	if err != nil || !ok {
		t.Fatalf("get ok=%v err=%v", ok, err)
	}
	if onDisk.CreatedAt != first.CreatedAt {
		t.Fatalf("落盘 created_at %q 与返回值 %q 不一致", onDisk.CreatedAt, first.CreatedAt)
	}

	// 重复导入同一个 name 会走 upsert 的更新分支。调用方构造的记录没有
	// created_at，零值不能把已落表的创建时间抹掉。
	second, err := s.upsert(MountRecord{ID: "e2e", Name: "e2e", Type: "local", Status: "mounted"})
	if err != nil {
		t.Fatal(err)
	}
	if second.CreatedAt != first.CreatedAt {
		t.Fatalf("更新分支把 created_at 抹掉了: %q -> %q", first.CreatedAt, second.CreatedAt)
	}
	after, ok, err := s.get("e2e")
	if err != nil || !ok {
		t.Fatalf("get ok=%v err=%v", ok, err)
	}
	if after.CreatedAt != first.CreatedAt {
		t.Fatalf("更新后落盘 created_at %q，期望 %q", after.CreatedAt, first.CreatedAt)
	}
}

func TestMountStoreMatchesByIDOrName(t *testing.T) {
	s := newMountStore(filepath.Join(t.TempDir(), "mounts.json"))
	if _, err := s.upsert(MountRecord{ID: "uuid-1", Name: "photos", Type: "local", Status: "mounted"}); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.get("photos"); !ok {
		t.Fatal("lookup by name should hit")
	}
	if _, ok, _ := s.get("nope"); ok {
		t.Fatal("unknown id should miss")
	}
}
