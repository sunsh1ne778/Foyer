package foyer

import (
	"strings"
	"testing"
)

func TestConfigArgsPassesGiBAndYes(t *testing.T) {
	got := strings.Join(ConfigArgs(Config{MetaURL: "redis://redis:6379/1"}, 1024), " ")
	want := "config redis://redis:6379/1 --capacity 1024 --yes"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

// 已设配额时不许覆盖：运维手动调过的值优先。
func TestEnsureCapacityLeavesExistingQuotaAlone(t *testing.T) {
	bin := writeFakeJuiceUsage(t, 1024, true, 4096)
	r := Runner{Bin: bin}
	out, err := EnsureCapacity(Config{MetaURL: "redis://x", JuiceFSBin: bin}, r, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if out.Applied {
		t.Fatalf("已有配额不应被覆盖: %+v", out)
	}
	if !strings.Contains(out.Skipped, "已设配额") {
		t.Fatalf("skipped reason: %q", out.Skipped)
	}
}

// 硬限制安全闸：目标低于卷当前已用会让全卷写入 ENOSPC，必须只告警不设。
func TestEnsureCapacityRefusesToBrickVolume(t *testing.T) {
	// 已用 2 GiB，目标只给 1 GiB —— 元数据导入场景的典型形状。
	bin := writeFakeJuiceUsage(t, 2<<30, false, 0)
	r := Runner{Bin: bin}
	out, err := EnsureCapacity(Config{MetaURL: "redis://x", JuiceFSBin: bin}, r, 1)
	if err != nil {
		t.Fatal(err)
	}
	if out.Applied {
		t.Fatalf("目标低于当前已用时绝不能设: %+v", out)
	}
	if !strings.Contains(out.Skipped, "低于当前已用") {
		t.Fatalf("skipped reason: %q", out.Skipped)
	}
}

func TestEnsureCapacityAppliesWhenSafe(t *testing.T) {
	bin := writeFakeJuiceUsage(t, 1024, false, 0)
	r := Runner{Bin: bin}
	out, err := EnsureCapacity(Config{MetaURL: "redis://x", JuiceFSBin: bin}, r, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if !out.Applied || out.CapacityGB != 4096 {
		t.Fatalf("%+v", out)
	}
}
