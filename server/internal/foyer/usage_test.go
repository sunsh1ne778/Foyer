package foyer

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
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
	jsonLine := `{"volume":{"capacity":0,"capacity_set":false,"used":1919472140288,"used_inodes":2538,"avail":0,"avail_inodes":0},` +
		`"summaries":[{"path":"/dtest2","size":24576,"length":20480,"files":4,"dirs":2,"inodes":6}]}`

	for _, tc := range []struct {
		name string
		text string
	}{
		{
			name: "leading log line",
			text: "2026/09/19 08:33:31 juicefs[656] <INFO>: Ping redis latency: 51.779µs\n" + jsonLine + "\n",
		},
		{
			name: "trailing log line",
			text: jsonLine + "\n2026/09/19 08:33:31 juicefs[656] <INFO>: flush done\n",
		},
		{
			name: "log lines on both sides",
			text: "2026/09/19 08:33:31 juicefs[656] <INFO>: Ping redis latency: 51.779µs\n" +
				jsonLine + "\n2026/09/19 08:33:31 juicefs[656] <INFO>: flush done\n",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseUsage(tc.text)
			if err != nil {
				t.Fatal(err)
			}
			if got.Volume.Used != 1919472140288 || got.Volume.CapacitySet {
				t.Fatalf("volume: %+v", got.Volume)
			}
			if len(got.Summaries) != 1 || got.Summaries[0].Inodes != 6 || got.Summaries[0].Size != 24576 {
				t.Fatalf("summaries: %+v", got.Summaries)
			}
		})
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

// 物理盘可读时三个 disk 字段必须原样带出：分母来自实时采样，不是配置额度。
func TestBuildUsageResponseCarriesDiskFields(t *testing.T) {
	disk := DiskSpace{Total: 1000, Used: 400, Free: 600}
	got := BuildUsageResponse(VolumeUsage{Used: 10, UsedInodes: 3}, disk, true, nil, nil)
	if got.Volume.DiskTotal != 1000 || got.Volume.DiskUsed != 400 || got.Volume.DiskFree != 600 {
		t.Fatalf("disk fields must be carried verbatim: %+v", got.Volume)
	}
}

// 读不到物理盘就没有分母：三个 disk 字段一律 0，不编数、不回退。
func TestBuildUsageResponseWithoutDiskLeavesDiskFieldsZero(t *testing.T) {
	got := BuildUsageResponse(VolumeUsage{Used: 10, UsedInodes: 3}, DiskSpace{}, false, nil, nil)
	if got.Volume.DiskTotal != 0 || got.Volume.DiskUsed != 0 || got.Volume.DiskFree != 0 {
		t.Fatalf("no live sample -> no denominator, disk fields must be 0: %+v", got.Volume)
	}
}

// 逻辑用量与 diskOK 无关，始终透传。
func TestBuildUsageResponseAlwaysPassesVolumeUsage(t *testing.T) {
	for _, diskOK := range []bool{true, false} {
		got := BuildUsageResponse(VolumeUsage{Used: 1919472140288, UsedInodes: 2538}, DiskSpace{Total: 1}, diskOK, nil, nil)
		if got.Volume.Used != 1919472140288 || got.Volume.UsedInodes != 2538 {
			t.Fatalf("diskOK=%v: volume usage must pass through: %+v", diskOK, got.Volume)
		}
	}
	if got := BuildUsageResponse(VolumeUsage{}, DiskSpace{}, false, nil, nil); got.Summaries == nil {
		t.Fatal("summaries must never be null in JSON")
	}
}

// 载荷里不能再出现 capacity/capacity_set：留着它就是在邀请下一个人拿它当分母。
func TestUsagePayloadHasNoCapacityKeys(t *testing.T) {
	resp := BuildUsageResponse(
		VolumeUsage{Capacity: 4096, CapacitySet: true, Used: 7, UsedInodes: 2},
		DiskSpace{Total: 1000, Used: 400, Free: 600}, true,
		[]PathUsage{{Path: "/photos"}}, nil)
	b, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(b, &top); err != nil {
		t.Fatal(err)
	}
	var vol map[string]json.RawMessage
	if err := json.Unmarshal(top["volume"], &vol); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"capacity", "capacity_set"} {
		if _, ok := vol[key]; ok {
			t.Fatalf("payload must not expose %q: %s", key, b)
		}
	}
}

func TestUsageRouteReturnsDiskFields(t *testing.T) {
	if runtime.GOOS != "linux" {
		// StatDisk 在非 linux 上失败关闭；这条断言只在 Linux CI/容器里真跑。
		t.Skip("statfs assertions are linux-only")
	}
	cfg := Config{MetaURL: "redis://x", JuiceFSBin: writeFakeJuice(t, true), DataDisk: t.TempDir()}
	mux := NewHealthMux(cfg)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/usage?path=/photos/a&path=/photos/b", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var got UsageResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Volume.Used != 1919472140288 || got.Volume.UsedInodes != 2538 {
		t.Fatalf("volume usage: %+v", got.Volume)
	}
	// 物理盘可读 -> disk_total 必须来自实时采样（非 0）。
	if got.Volume.DiskTotal == 0 {
		t.Fatalf("物理盘可读时 disk_total 必须是实时采样: %+v", got.Volume)
	}
	if len(got.Summaries) != 2 || got.Summaries[0].Path != "/photos/a" {
		t.Fatalf("summaries: %+v", got.Summaries)
	}
}

// 读不到盘不能炸接口：仍返回 200，且三个 disk 字段都是 0（消费方据此不画进度条）。
func TestUsageRouteSurvivesStatDiskFailure(t *testing.T) {
	cfg := Config{
		MetaURL:    "redis://x",
		JuiceFSBin: writeFakeJuice(t, true),
		DataDisk:   filepath.Join(t.TempDir(), "definitely-missing"),
	}
	mux := NewHealthMux(cfg)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/usage", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var got UsageResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Volume.DiskTotal != 0 || got.Volume.DiskUsed != 0 || got.Volume.DiskFree != 0 {
		t.Fatalf("读不到盘时三个 disk 字段都必须是 0: %+v", got.Volume)
	}
	if got.Volume.Used != 1919472140288 {
		t.Fatalf("卷用量仍须透传: %+v", got.Volume)
	}
}

func TestUsageRouteRejectsNonGet(t *testing.T) {
	cfg := Config{MetaURL: "redis://x", JuiceFSBin: writeFakeJuice(t, true), DataDisk: "/"}
	mux := NewHealthMux(cfg)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/foyer/usage", nil))
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status %d", rr.Code)
	}
}

// 命中池的 summary 带上实时采样；未命中时三个 disk 键在 JSON 里**彻底缺席**，
// 而不是 0——消费方靠键的存在性区分「不知道这块盘」与「真占了 0 字节」。
func TestBuildUsageResponseAppliesPoolOnlyWhenPresent(t *testing.T) {
	pool := DiskSpace{Total: 1000, Used: 400, Free: 600}
	got := BuildUsageResponse(
		VolumeUsage{Used: 10, UsedInodes: 3},
		DiskSpace{Total: 7, Used: 1, Free: 6}, true,
		[]PathUsage{{Path: "/photos"}, {Path: "/host"}},
		map[string]DiskSpace{"/photos": pool},
	)
	if got.Summaries[0].DiskTotal != 1000 || got.Summaries[0].DiskUsed != 400 || got.Summaries[0].DiskFree != 600 {
		t.Fatalf("命中的池必须原样带出: %+v", got.Summaries[0])
	}
	// 卷级 disk_* 仍只由 diskOK 决定，与本路径池无关。
	if got.Volume.DiskTotal != 7 || got.Volume.DiskUsed != 1 || got.Volume.DiskFree != 6 {
		t.Fatalf("卷级 disk_* 只由 diskOK 决定: %+v", got.Volume)
	}
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var top struct {
		Summaries []map[string]json.RawMessage `json:"summaries"`
	}
	if err := json.Unmarshal(b, &top); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"disk_total", "disk_used", "disk_free"} {
		if _, ok := top.Summaries[0][key]; !ok {
			t.Fatalf("命中的 summary 必须带 %q: %s", key, b)
		}
		if _, ok := top.Summaries[1][key]; ok {
			t.Fatalf("未命中的 summary 不能出现 %q（缺席=不知道，不能退化成 0）: %s", key, b)
		}
	}
}

// Error 是路径解析失败，此时谈它背后的盘没有意义：即使 pools 里恰好有它的键也不能填。
func TestBuildUsageResponseNeverAppliesPoolToErrorSummary(t *testing.T) {
	got := BuildUsageResponse(
		VolumeUsage{}, DiskSpace{}, false,
		[]PathUsage{{Path: "/photos", Error: "lookup photos: no such file or directory"}},
		map[string]DiskSpace{"/photos": {Total: 1000, Used: 400, Free: 600}},
	)
	if got.Summaries[0].DiskTotal != 0 || got.Summaries[0].DiskUsed != 0 || got.Summaries[0].DiskFree != 0 {
		t.Fatalf("Error summary 绝不能带 disk_*: %+v", got.Summaries[0])
	}
}

// 请求侧必须按 overlay 回报的形状归一，否则 /photos/ 与 /photos 会查不到同一个池。
func TestCleanVolumePathMatchesOverlayShape(t *testing.T) {
	for in, want := range map[string]string{
		"/photos":   "/photos",
		"/photos/":  "/photos",
		"//photos":  "/photos",
		" /photos ": "/photos",
		"/a/./b":    "/a/b",
		"/a/../b":   "/b",
		"/":         "/",
		"":          "/",
	} {
		if got := cleanVolumePath(in); got != want {
			t.Fatalf("cleanVolumePath(%q) = %q, want %q", in, got, want)
		}
	}
}

// 卷内路径 -> 容器内来源路径：container 优先，退化 root；空 dest/空来源跳过；
// dest 归一后同名只保留第一次出现的来源（同盘只 statfs 一次的前提）。
func TestPoolPathFor(t *testing.T) {
	got := poolPathFor([]MountRecord{
		{Spec: map[string]string{"dest": "/photos", "container": "/mnt/g/photos", "root": "/loses"}},
		{Spec: map[string]string{"dest": "/rootonly", "root": "/mnt/e/rootonly"}},
		{Spec: map[string]string{"dest": "/nosrc", "container": "  "}},
		{Spec: map[string]string{"container": "/mnt/f/nodest"}},
		{Spec: map[string]string{"dest": "/x/", "container": "/mnt/g/first"}},
		{Spec: map[string]string{"dest": "/x", "container": "/mnt/g/second"}},
	})
	want := map[string]string{
		"/photos":   "/mnt/g/photos",
		"/rootonly": "/mnt/e/rootonly",
		"/x":        "/mnt/g/first",
	}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("got[%q] = %q, want %q (all: %v)", k, got[k], v, got)
		}
	}
}

// Linux-only 集成：把一条 metadata 挂载写进临时 mounts.json，请求 /foyer/usage 时
// 该 summary 必须带上其来源盘的实时采样；没有挂载记录的路径则三个 disk 键缺席。
// Windows 上 StatDisk 走 disk_other.go 一律报错、池必然为空，故跳过。
func TestUsageRouteCarriesPerPathPool(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("statfs assertions are linux-only")
	}
	src := t.TempDir()
	recs, err := json.Marshal([]MountRecord{{
		ID: "m1", Name: "photos", Type: "import", Status: "ready",
		Spec: map[string]string{"dest": "/photos", "container": src, "mode": "metadata"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	mountsFile := filepath.Join(t.TempDir(), "mounts.json")
	if err := os.WriteFile(mountsFile, recs, 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := Config{
		MetaURL:    "redis://x",
		JuiceFSBin: writeFakeJuice(t, true),
		DataDisk:   t.TempDir(),
		MountsFile: mountsFile,
	}
	mux := NewHealthMux(cfg)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/foyer/usage?path=/photos&path=/host", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var top struct {
		Summaries []map[string]json.RawMessage `json:"summaries"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &top); err != nil {
		t.Fatal(err)
	}
	if len(top.Summaries) != 2 {
		t.Fatalf("summaries: %s", rr.Body.String())
	}
	var got UsageResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	// /photos 有挂载记录 -> 实时采样非 0，且 used 不超过 total。
	if got.Summaries[0].DiskTotal == 0 {
		t.Fatalf("有挂载记录的路径必须带实时池采样: %s", rr.Body.String())
	}
	if got.Summaries[0].DiskUsed > got.Summaries[0].DiskTotal {
		t.Fatalf("disk_used 不能超过 disk_total: %+v", got.Summaries[0])
	}
	// /host 没有挂载记录（真实环境里 /host 也不在容器内）-> 键缺席，不画进度条。
	for _, key := range []string{"disk_total", "disk_used", "disk_free"} {
		if _, ok := top.Summaries[1][key]; ok {
			t.Fatalf("无池路径不能带 %q: %s", key, rr.Body.String())
		}
	}
}
