package foyer

import (
	"strings"
	"testing"
)

func TestUsageArgsOmitsPathsWhenNone(t *testing.T) {
	got := strings.Join(UsageArgs(Config{MetaURL: "redis://redis:6379/1"}, nil), " ")
	if got != "usage redis://redis:6379/1" {
		t.Fatalf("got %q", got)
	}
	got = strings.Join(UsageArgs(Config{MetaURL: "redis://x"}, []string{"/a", "/b"}), " ")
	if got != "usage redis://x /a /b" {
		t.Fatalf("got %q", got)
	}
}

func TestParseUsageSkipsLogLines(t *testing.T) {
	text := "2026/09/19 08:33:31 juicefs[656] <INFO>: Ping redis latency: 51.779µs\n" +
		`{"volume":{"capacity":0,"capacity_set":false,"used":1919472140288,"used_inodes":2538,"avail":0,"avail_inodes":0},` +
		`"summaries":[{"path":"/dtest2","size":24576,"length":20480,"files":4,"dirs":2,"inodes":6}]}` + "\n"
	got, err := parseUsage(text)
	if err != nil {
		t.Fatal(err)
	}
	if got.Volume.Used != 1919472140288 || got.Volume.CapacitySet {
		t.Fatalf("volume: %+v", got.Volume)
	}
	if len(got.Summaries) != 1 || got.Summaries[0].Inodes != 6 || got.Summaries[0].Size != 24576 {
		t.Fatalf("summaries: %+v", got.Summaries)
	}
}

func TestParseUsageFailsWithoutJSON(t *testing.T) {
	if _, err := parseUsage("lookup nope: no such file or directory"); err == nil {
		t.Fatal("expected error")
	}
}

func TestRunnerUsageParsesFakeBin(t *testing.T) {
	r := Runner{Bin: writeFakeJuice(t, true)}
	res, err := r.Usage(Config{MetaURL: "redis://x"}, []string{"/photos/a"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Volume.Used != 1919472140288 {
		t.Fatalf("volume: %+v", res.Volume)
	}
	if len(res.Summaries) != 1 || res.Summaries[0].Path != "/photos/a" {
		t.Fatalf("%+v", res.Summaries)
	}
}

// 容量解析规则只应有一处：配额优先，否则物理盘总量。
func TestBuildUsageResponsePrefersQuotaOverDisk(t *testing.T) {
	disk := DiskSpace{Total: 1000, Used: 400, Free: 600}

	// 未设配额 -> 用物理盘总量当分母。
	unset := BuildUsageResponse(VolumeUsage{Used: 10, UsedInodes: 3}, disk, true, nil)
	if !unset.Volume.CapacitySet || unset.Volume.Capacity != 1000 {
		t.Fatalf("未设配额应回退物理盘总量: %+v", unset.Volume)
	}
	if unset.Volume.DiskTotal != 1000 || unset.Volume.DiskUsed != 400 {
		t.Fatalf("物理盘数字必须原样带出: %+v", unset.Volume)
	}

	// 设了配额 -> 配额优先，且 capacity_set 为真。
	set := BuildUsageResponse(VolumeUsage{Capacity: 2048, CapacitySet: true, Used: 10}, disk, true, nil)
	if !set.Volume.CapacitySet || set.Volume.Capacity != 2048 {
		t.Fatalf("设了配额应优先: %+v", set.Volume)
	}
}

// 物理盘读不到时不能编一个分母。
func TestBuildUsageResponseWithoutDiskLeavesCapacityZero(t *testing.T) {
	got := BuildUsageResponse(VolumeUsage{Used: 10}, DiskSpace{}, false, nil)
	if got.Volume.Capacity != 0 || got.Volume.CapacitySet {
		t.Fatalf("读不到物理盘时应诚实报 0: %+v", got.Volume)
	}
}
