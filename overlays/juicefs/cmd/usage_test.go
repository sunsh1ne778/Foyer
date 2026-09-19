package cmd

import (
	"encoding/json"
	"testing"

	"github.com/juicedata/juicefs/pkg/meta"
)

// Inodes 必须与 `juicefs quota get` 的 IUsed 同口径：目录本身也算一个 inode。
func TestPathUsageOfCountsDirsAsInodes(t *testing.T) {
	got := pathUsageOf("/photos/", meta.Summary{Size: 2048000, Length: 1999000, Files: 12, Dirs: 3})
	if got.Path != "/photos" {
		t.Fatalf("path = %q, want /photos", got.Path)
	}
	if got.Inodes != 15 {
		t.Fatalf("inodes = %d, want 15 (files+dirs)", got.Inodes)
	}
	if got.Size != 2048000 || got.Files != 12 || got.Dirs != 3 {
		t.Fatalf("%+v", got)
	}
}

// Capacity 的真值只能来自 Format.Capacity。StatFS 的 totalspace 在未设配额时是
// 合成值（1<<50 起翻倍），拿它当容量会让进度条分母变成一个假的大数。
func TestVolumeUsageOfUsesFormatCapacityNotStatFS(t *testing.T) {
	// total=1<<50 是 StatFS 在未设配额时合成的量，used 由 total-avail 反推。
	got := volumeUsageOf(meta.Format{Capacity: 0}, 1<<50, (1<<50)-1024, 7, 10)
	if got.Capacity != 0 || got.CapacitySet {
		t.Fatalf("未设配额时应报 capacity=0/capacity_set=false: %+v", got)
	}
	if got.Used != 1024 || got.UsedInodes != 7 {
		t.Fatalf("used/used_inodes 必须来自 StatFS 计数: %+v", got)
	}

	set := volumeUsageOf(meta.Format{Capacity: 2 << 40}, 2<<40, (2<<40)-4096, 9, 11)
	if set.Capacity != 2<<40 || !set.CapacitySet {
		t.Fatalf("设了配额应原样带出: %+v", set)
	}
	if set.Avail != (2<<40)-4096 || set.AvailInodes != 11 {
		t.Fatalf("设了配额时 avail 才有意义: %+v", set)
	}
}

func TestUsageResultJSONKeysAreStable(t *testing.T) {
	b, err := json.Marshal(usageResult{
		Volume:    volumeUsageOf(meta.Format{Capacity: 1 << 40}, 1<<40, 1<<39, 5, 6),
		Summaries: []pathUsage{pathUsageOf("/a", meta.Summary{Size: 1, Files: 1})},
	})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"volume", "summaries"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing key %q in %s", k, b)
		}
	}
	var vol map[string]json.RawMessage
	if err := json.Unmarshal(m["volume"], &vol); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"capacity", "capacity_set", "used", "avail", "used_inodes", "avail_inodes"} {
		if _, ok := vol[k]; !ok {
			t.Fatalf("missing volume key %q in %s", k, b)
		}
	}
}
