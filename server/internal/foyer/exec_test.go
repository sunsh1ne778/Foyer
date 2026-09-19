package foyer

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestFormatAndGatewayArgs(t *testing.T) {
	cfg := Config{
		Storage: "minio", Bucket: "http://rustfs:9000/jfs",
		AccessKey: "ak", SecretKey: "sk",
		MetaURL: "redis://redis:6379/1", Volume: "foyer",
		GatewayListen: "0.0.0.0:9002",
	}
	fa := strings.Join(FormatArgs(cfg), " ")
	if !strings.Contains(fa, "--storage minio") || !strings.Contains(fa, "foyer") {
		t.Fatal(fa)
	}
	ga := GatewayArgs(cfg)
	if len(ga) != 3 || ga[0] != "gateway" || ga[2] != "0.0.0.0:9002" {
		t.Fatalf("%v", ga)
	}
	ia := strings.Join(ImportArgs(cfg, "file:///data/in", "/photos", false), " ")
	if ia != "import --json redis://redis:6379/1 file:///data/in /photos" {
		t.Fatal(ia)
	}
}

func writeFakeJuice(t *testing.T, statusOK bool) string {
	t.Helper()
	dir := t.TempDir()
	if runtime.GOOS == "windows" {
		return writeFakeJuiceGo(t, dir, statusOK)
	}
	path := filepath.Join(dir, "juicefs")
	script := "#!/bin/sh\n"
	if statusOK {
		script += "if [ \"$1\" = status ]; then exit 0; fi\n"
	} else {
		script += "if [ \"$1\" = status ]; then exit 1; fi\n"
	}
	script += "if [ \"$1\" = format ]; then echo FORMAT \"$@\" > \"$(dirname \"$0\")/out.txt\"; exit 0; fi\n"
	script += "if [ \"$1\" = import ]; then printf '%s\\n' '{\"dry_run\":false,\"dest\":\"/photos\",\"scanned\":2,\"imported\":1,\"skipped\":1,\"mtime_kept\":1,\"mtime_missing\":0,\"mode_kept\":1,\"owner_kept\":0,\"dir_mtime_kept\":0}'; exit 0; fi\n"
	script += "if [ \"$1\" = stat ]; then shift 2; for p in \"$@\"; do printf '{\"path\":\"%s\",\"inode\":42,\"type\":\"directory\",\"mode\":493,\"uid\":0,\"gid\":0,\"size\":4096,\"nlink\":3,\"mtime\":1777690800,\"mtimensec\":123456789}\\n' \"$p\"; done; exit 0; fi\n"
	script += "if [ \"$1\" = usage ]; then shift 2; printf '%s' '{\"volume\":{\"capacity\":0,\"capacity_set\":false,\"used\":1919472140288,\"used_inodes\":2538,\"avail\":0,\"avail_inodes\":0},\"summaries\":['; first=1; for p in \"$@\"; do if [ $first -eq 0 ]; then printf ','; fi; first=0; printf '{\"path\":\"%s\",\"size\":24576,\"length\":20480,\"files\":4,\"dirs\":2,\"inodes\":6}' \"$p\"; done; printf ']}\\n'; exit 0; fi\n"
	if err := os.WriteFile(path, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeFakeJuiceGo(t *testing.T, dir string, statusOK bool) string {
	t.Helper()
	statusExit := "1"
	if statusOK {
		statusExit = "0"
	}
	src := `package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	if len(os.Args) < 2 {
		os.Exit(2)
	}
	switch os.Args[1] {
	case "status":
		os.Exit(` + statusExit + `)
	case "format":
		out := filepath.Join(filepath.Dir(os.Args[0]), "out.txt")
		_ = os.WriteFile(out, []byte("FORMAT "+strings.Join(os.Args[1:], " ")), 0644)
		os.Exit(0)
	case "import":
		fmt.Println("{\"dry_run\":false,\"dest\":\"/photos\",\"scanned\":2,\"imported\":1,\"skipped\":1,\"mtime_kept\":1,\"mtime_missing\":0,\"mode_kept\":1,\"owner_kept\":0,\"dir_mtime_kept\":0}")
		os.Exit(0)
	case "stat":
		for _, p := range os.Args[3:] {
			fmt.Printf("{\"path\":\"%s\",\"inode\":42,\"type\":\"directory\",\"mode\":493,\"uid\":0,\"gid\":0,\"size\":4096,\"nlink\":3,\"mtime\":1777690800,\"mtimensec\":123456789}\n", p)
		}
		os.Exit(0)
	case "usage":
		fmt.Print("{\"volume\":{\"capacity\":0,\"capacity_set\":false,\"used\":1919472140288,\"used_inodes\":2538,\"avail\":0,\"avail_inodes\":0},\"summaries\":[")
		for i, p := range os.Args[3:] {
			if i > 0 {
				fmt.Print(",")
			}
			fmt.Printf("{\"path\":\"%s\",\"size\":24576,\"length\":20480,\"files\":4,\"dirs\":2,\"inodes\":6}", p)
		}
		fmt.Println("]}")
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "unknown: %s\n", os.Args[1])
		os.Exit(2)
	}
}
`
	srcPath := filepath.Join(dir, "fakejuice.go")
	if err := os.WriteFile(srcPath, []byte(src), 0644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "juicefs.exe")
	cmd := exec.Command("go", "build", "-o", out, srcPath)
	cmd.Dir = dir
	if outBytes, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake juicefs: %v\n%s", err, outBytes)
	}
	return out
}

func TestEnsureVolumeSkipsFormatWhenStatusOK(t *testing.T) {
	bin := writeFakeJuice(t, true)
	r := Runner{Bin: bin}
	cfg := Config{MetaURL: "redis://x", Volume: "foyer", Storage: "minio", Bucket: "b", AccessKey: "a", SecretKey: "s"}
	if err := r.EnsureVolume(cfg); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(bin), "out.txt")); err == nil {
		t.Fatal("format should not run")
	}
}

func TestEnsureVolumeFormatsWhenStatusFails(t *testing.T) {
	bin := writeFakeJuice(t, false)
	r := Runner{Bin: bin}
	cfg := Config{MetaURL: "redis://x", Volume: "foyer", Storage: "minio", Bucket: "b", AccessKey: "a", SecretKey: "s"}
	if err := r.EnsureVolume(cfg); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(filepath.Dir(bin), "out.txt"))
	if err != nil || !strings.Contains(string(b), "FORMAT") {
		t.Fatalf("format output: %s %v", b, err)
	}
}

func TestRunnerUsesConfiguredBin(t *testing.T) {
	if _, err := exec.LookPath("this-bin-does-not-exist-foyer"); err == nil {
		t.Skip("unexpected")
	}
	r := Runner{Bin: "this-bin-does-not-exist-foyer"}
	if err := r.Status("redis://x"); err == nil {
		t.Fatal("expected error")
	}
}

func TestImportParsesSummary(t *testing.T) {
	bin := writeFakeJuice(t, true)
	r := Runner{Bin: bin}
	res, err := r.Import(Config{MetaURL: "redis://x"}, "file:///host/", "/photos", false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Imported != 1 || res.Skipped != 1 || res.Scanned != 2 {
		t.Fatalf("%+v", res)
	}
	if res.MtimeKept != 1 || res.MtimeMissing != 0 || res.ModeKept != 1 || res.OwnerKept != 0 || res.DirMtimeKept != 0 {
		t.Fatalf("fidelity not passed through: %+v", res)
	}
}

func TestImportReportsNonZeroExit(t *testing.T) {
	bin := writeFakeImport(t, "FATAL: bucket missing", 1)
	r := Runner{Bin: bin}
	_, err := r.Import(Config{MetaURL: "redis://x"}, "file:///host/", "/photos", false)
	if err == nil || !strings.Contains(err.Error(), "bucket missing") {
		t.Fatalf("got %v", err)
	}
}

func TestImportRejectsOutputWithoutSummary(t *testing.T) {
	bin := writeFakeImport(t, "imported 0, skipped 0, scanned 0 -> /photos", 0)
	r := Runner{Bin: bin}
	_, err := r.Import(Config{MetaURL: "redis://x"}, "file:///host/", "/photos", false)
	if err == nil || !strings.Contains(err.Error(), "no JSON summary") {
		t.Fatalf("got %v", err)
	}
}

func writeFakeImport(t *testing.T, stdout string, code int) string {
	t.Helper()
	// stdout 必须是不含引号的单行文本：Windows 分支把它内联进 Go 源码，
	// POSIX 分支把它内联进 shell 单引号。需要回显 JSON 的场景请用 writeFakeJuice。
	dir := t.TempDir()
	if runtime.GOOS != "windows" {
		path := filepath.Join(dir, "juicefs")
		script := "#!/bin/sh\nprintf '%s\\n' '" + stdout + "'\nexit " + strconv.Itoa(code) + "\n"
		if err := os.WriteFile(path, []byte(script), 0755); err != nil {
			t.Fatal(err)
		}
		return path
	}
	src := `package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Println("` + stdout + `")
	os.Exit(` + strconv.Itoa(code) + `)
}
`
	srcPath := filepath.Join(dir, "fakejuice.go")
	if err := os.WriteFile(srcPath, []byte(src), 0644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "juicefs.exe")
	cmd := exec.Command("go", "build", "-o", out, srcPath)
	cmd.Dir = dir
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake juicefs: %v\n%s", err, b)
	}
	return out
}

// writeFakeJuiceUsage 让 fake 回指定的卷用量与配额状态，并把 config 调用记到 config.txt。
func writeFakeJuiceUsage(t *testing.T, used uint64, capacitySet bool, capacity uint64) string {
	t.Helper()
	dir := t.TempDir()
	usageJSON := fmt.Sprintf(
		`{"volume":{"capacity":%d,"capacity_set":%t,"used":%d,"used_inodes":3,"avail":0,"avail_inodes":0},"summaries":[]}`,
		capacity, capacitySet, used)
	if runtime.GOOS == "windows" {
		src := `package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	switch os.Args[1] {
	case "usage":
		fmt.Println(` + "`" + usageJSON + "`" + `)
	case "config":
		out := filepath.Join(filepath.Dir(os.Args[0]), "config.txt")
		_ = os.WriteFile(out, []byte(strings.Join(os.Args[1:], " ")), 0644)
	}
	os.Exit(0)
}
`
		srcPath := filepath.Join(dir, "fakejuice.go")
		if err := os.WriteFile(srcPath, []byte(src), 0644); err != nil {
			t.Fatal(err)
		}
		out := filepath.Join(dir, "juicefs.exe")
		cmd := exec.Command("go", "build", "-o", out, srcPath)
		cmd.Dir = dir
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("build fake juicefs: %v\n%s", err, b)
		}
		return out
	}
	path := filepath.Join(dir, "juicefs")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" = usage ]; then printf '%s\\n' '" + usageJSON + "'; exit 0; fi\n" +
		"if [ \"$1\" = config ]; then echo \"$@\" > \"$(dirname \"$0\")/config.txt\"; exit 0; fi\n"
	if err := os.WriteFile(path, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	return path
}
