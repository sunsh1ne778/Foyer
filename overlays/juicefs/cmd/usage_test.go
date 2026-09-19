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
	// 未设配额时 StatFS 的 avail/iavail 都是合成值，必须一起压掉而不是带出去。
	if got.Avail != 0 || got.AvailInodes != 0 {
		t.Fatalf("未设配额时 avail/avail_inodes 必须为 0，不得带出合成值: %+v", got)
	}

	set := volumeUsageOf(meta.Format{Capacity: 2 << 40, Inodes: 100}, 2<<40, (2<<40)-4096, 9, 11)
	if set.Capacity != 2<<40 || !set.CapacitySet {
		t.Fatalf("设了配额应原样带出: %+v", set)
	}
	if set.Avail != (2<<40)-4096 || set.AvailInodes != 11 {
		t.Fatalf("两种配额都设了时 avail/avail_inodes 才有意义: %+v", set)
	}
}

// 空间与 inode 配额各自独立：StatFS 对未设的那一侧会合成一个随用量翻倍的值，
// 把它当成真余量就是假数据。avail 只看 Capacity，avail_inodes 只看 Inodes。
func TestVolumeUsageOfGatesAvailAndAvailInodesSeparately(t *testing.T) {
	// 只设空间配额：avail 真实，iavail 是 10<<20 起翻倍的合成值，必须压成 0。
	spaceOnly := volumeUsageOf(meta.Format{Capacity: 1 << 40}, 1<<40, 1<<39, 5, 10<<20)
	if spaceOnly.Avail != 1<<39 {
		t.Fatalf("设了空间配额时 avail 应带出: %+v", spaceOnly)
	}
	if spaceOnly.AvailInodes != 0 {
		t.Fatalf("未设 inode 配额时 avail_inodes 必须为 0: %+v", spaceOnly)
	}

	// 只设 inode 配额：avail_inodes 真实，avail 是 1<<50 起翻倍的合成值，必须压成 0。
	inodeOnly := volumeUsageOf(meta.Format{Inodes: 1000}, 1<<50, (1<<50)-2048, 40, 960)
	if inodeOnly.Capacity != 0 || inodeOnly.CapacitySet {
		t.Fatalf("未设空间配额时 capacity 必须为 0: %+v", inodeOnly)
	}
	if inodeOnly.Avail != 0 {
		t.Fatalf("未设空间配额时 avail 必须为 0: %+v", inodeOnly)
	}
	if inodeOnly.AvailInodes != 960 {
		t.Fatalf("设了 inode 配额时 avail_inodes 应带出: %+v", inodeOnly)
	}
}

func TestUsageResultJSONKeysAreStable(t *testing.T) {
	b, err := json.Marshal(usageResult{
		Volume: volumeUsageOf(meta.Format{Capacity: 1 << 40, Inodes: 100}, 1<<40, 1<<39, 5, 6),
		Summaries: []pathUsage{
			pathUsageOf("/a", meta.Summary{Size: 1, Files: 1}),
			{Path: "/b", Error: "lookup b: ENOENT"},
		},
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
	// summaries[] 的键名是跨任务解析契约，拼错也能编译通过，必须逐个钉住。
	var sums []map[string]json.RawMessage
	if err := json.Unmarshal(m["summaries"], &sums); err != nil {
		t.Fatal(err)
	}
	if len(sums) != 2 {
		t.Fatalf("summaries length = %d, want 2 in %s", len(sums), b)
	}
	for _, k := range []string{"path", "error", "size", "length", "files", "dirs", "inodes"} {
		if _, ok := sums[1][k]; !ok {
			t.Fatalf("missing summaries key %q in %s", k, b)
		}
	}
	for _, k := range []string{"path", "size", "length", "files", "dirs", "inodes"} {
		if _, ok := sums[0][k]; !ok {
			t.Fatalf("missing summaries key %q in %s", k, b)
		}
	}
	// error 是 omitempty：成功项不带该键，失败项必须带。
	if _, ok := sums[0]["error"]; ok {
		t.Fatalf("成功项不应带 error 键: %s", b)
	}
}
