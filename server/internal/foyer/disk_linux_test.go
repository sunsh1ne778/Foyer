//go:build linux

package foyer

import (
	"syscall"
	"testing"
)

// 占用口径必须和 `df` 对齐：Used = Blocks-Bfree（文件真实占用），Free = Bavail
// （非 root 可写余量）。断言直接和 syscall.Statfs 的真值逐字段比对。
func TestStatDiskMatchesStatfsAccounting(t *testing.T) {
	dir := t.TempDir()
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		t.Fatal(err)
	}
	bs := uint64(st.Bsize)
	wantTotal := uint64(st.Blocks) * bs
	wantFree := uint64(st.Bavail) * bs
	wantUsed := wantTotal - uint64(st.Bfree)*bs

	got, err := StatDisk(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Total == 0 {
		t.Fatal("total must be non-zero on a mounted filesystem")
	}
	if got.Total != wantTotal {
		t.Fatalf("total: got %d want %d", got.Total, wantTotal)
	}
	if got.Free != wantFree {
		t.Fatalf("free: got %d want %d (Bavail)", got.Free, wantFree)
	}
	if got.Used != wantUsed {
		t.Fatalf("used: got %d want %d (Total-Bfree)", got.Used, wantUsed)
	}
}

// 保留块回归哨兵：Used+Free 一般小于 Total，差额是 ext4 的保留块，不是已用。
// 若有人把 Used 改回 Total-Free（把保留块算成已用），这里在 Bfree != Bavail 的
// 文件系统上就会失败。
func TestStatDiskLeavesReservedBlockGap(t *testing.T) {
	dir := t.TempDir()
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		t.Fatal(err)
	}
	got, err := StatDisk(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Used+got.Free > got.Total {
		t.Fatalf("used+free must not exceed total (reserved blocks belong to neither): %+v", got)
	}
	if st.Bfree != st.Bavail && got.Used+got.Free >= got.Total {
		t.Fatalf("with reserved blocks (Bfree=%d != Bavail=%d) used+free must be < total: %+v",
			st.Bfree, st.Bavail, got)
	}
}

func TestStatDiskRejectsMissingPath(t *testing.T) {
	if _, err := StatDisk("/definitely/not/here/foyer"); err == nil {
		t.Fatal("expected error for missing path")
	}
}
