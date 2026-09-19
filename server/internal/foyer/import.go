package foyer

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ImportResult mirrors the JSON summary printed by `juicefs import --json`.
type ImportResult struct {
	DryRun       bool     `json:"dry_run"`
	Dest         string   `json:"dest"`
	Scanned      int      `json:"scanned"`
	Imported     int      `json:"imported"`
	Skipped      int      `json:"skipped"`
	MtimeKept    int      `json:"mtime_kept"`
	MtimeMissing int      `json:"mtime_missing"`
	ModeKept     int      `json:"mode_kept"`
	OwnerKept    int      `json:"owner_kept"`
	DirMtimeKept int      `json:"dir_mtime_kept"`
	Objects      []string `json:"objects,omitempty"`
}

// ImportArgs builds `juicefs import --json [--dry-run] META SRC DEST`.
func ImportArgs(cfg Config, src, dest string, dryRun bool) []string {
	args := []string{"import", "--json"}
	if dryRun {
		args = append(args, "--dry-run")
	}
	return append(args, cfg.MetaURL, src, dest)
}

// errNoJSONLine 表示输出里没有可解析的 JSON 行；调用方补上各自的上下文。
var errNoJSONLine = errors.New("no JSON line in juicefs output")

// decodeJSONLine 尝试把一行解码成 T。JuiceFS 把日志和 JSON 打同一个流，
// 日志行也可能含花括号，所以必须先看行首和能否解码，不能直接当 JSON 用。
func decodeJSONLine[T any](line string) (T, bool) {
	var out T
	s := strings.TrimSpace(line)
	if !strings.HasPrefix(s, "{") {
		return out, false
	}
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return out, false
	}
	return out, true
}

// parseJSONLine 从输出末尾往前找第一条能解码成 T 的 JSON 行（取最后一条，
// 因为日志可能出现在结果之后）。
func parseJSONLine[T any](text string) (T, error) {
	lines := strings.Split(text, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if out, ok := decodeJSONLine[T](lines[i]); ok {
			return out, nil
		}
	}
	var zero T
	return zero, errNoJSONLine
}

// parseImportSummary scans output lines from the end and returns the first one
// that decodes as an ImportResult.
func parseImportSummary(text string) (ImportResult, error) {
	res, err := parseJSONLine[ImportResult](text)
	if err != nil {
		return ImportResult{}, fmt.Errorf("no JSON summary in import output: %s", truncate(text, 200))
	}
	return res, nil
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
