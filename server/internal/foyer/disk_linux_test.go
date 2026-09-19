//go:build linux

package foyer

import (
	"testing"
)

func TestStatDiskReportsRealCapacity(t *testing.T) {
	got, err := StatDisk(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if got.Total == 0 {
		t.Fatal("total must be non-zero on a mounted filesystem")
	}
	if got.Used > got.Total || got.Free > got.Total {
		t.Fatalf("used/free must fit inside total: %+v", got)
	}
}

func TestStatDiskRejectsMissingPath(t *testing.T) {
	if _, err := StatDisk("/definitely/not/here/foyer"); err == nil {
		t.Fatal("expected error for missing path")
	}
}
