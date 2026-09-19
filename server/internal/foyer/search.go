package foyer

import (
	"fmt"
	"strconv"
	"strings"
)

// SearchResult mirrors the JSON printed by `juicefs find` (overlays/juicefs/cmd/find.go).
type SearchResult struct {
	Keyword   string          `json:"keyword"`
	Matches   []SearchMatch   `json:"matches"`
	Scanned   uint64          `json:"scanned"`
	Truncated bool            `json:"truncated"`
	Errors    []SearchFailure `json:"errors,omitempty"`
}

// SearchMatch 是一条命中；Path 是卷内绝对路径，Name 是最后一段。
// Size 对目录是元数据长度（通常 4096），与 `juicefs stat` 同口径。
type SearchMatch struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Size      uint64 `json:"size"`
	Mtime     int64  `json:"mtime"`
	Mtimensec uint32 `json:"mtimensec"`
}

// SearchFailure 记一棵读失败的子树；整体检索仍然是成功的。
type SearchFailure struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// SearchResponse 是 GET /foyer/search 的载荷：CLI 结果外加 ok 标记。
type SearchResponse struct {
	OK        bool            `json:"ok"`
	Keyword   string          `json:"keyword"`
	Matches   []SearchMatch   `json:"matches"`
	Scanned   uint64          `json:"scanned"`
	Truncated bool            `json:"truncated"`
	Errors    []SearchFailure `json:"errors,omitempty"`
}

// SearchArgs builds `juicefs find META PATH --name KW [--case-sensitive] [--limit N]`.
// root 为空时用 "/"；limit 为 0 时不下发 --limit（=`juicefs find` 的不限语义）。
//
// juicefs 的 main.go 会用 reorderOptions 把命令级 flag 提到位置参数之前，
// 所以这里的参数顺序（先把 META 与 PATH 放前面）是安全的。
func SearchArgs(cfg Config, root, keyword string, caseSensitive bool, limit uint64) []string {
	root = strings.TrimSpace(root)
	if root == "" {
		root = "/"
	}
	args := []string{"find", cfg.MetaURL, root, "--name", keyword}
	if caseSensitive {
		args = append(args, "--case-sensitive")
	}
	if limit > 0 {
		args = append(args, "--limit", strconv.FormatUint(limit, 10))
	}
	return args
}

func (r Runner) Search(cfg Config, root, keyword string, caseSensitive bool, limit uint64) (SearchResult, error) {
	c := r.cmd(SearchArgs(cfg, root, keyword, caseSensitive, limit)...)
	c.Stdout = nil
	c.Stderr = nil
	out, err := c.CombinedOutput()
	text := string(out)
	if err != nil {
		if msg := strings.TrimSpace(text); msg != "" {
			return SearchResult{}, fmt.Errorf("juicefs find: %s", lastLine(msg))
		}
		return SearchResult{}, fmt.Errorf("juicefs find: %w", err)
	}
	res, perr := parseSearch(text)
	if perr != nil {
		return SearchResult{}, fmt.Errorf("juicefs find: %w", perr)
	}
	return res, nil
}

func parseSearch(text string) (SearchResult, error) {
	res, err := parseJSONLine[SearchResult](text)
	if err != nil {
		return SearchResult{}, fmt.Errorf("no JSON search in juicefs output: %s", truncate(text, 200))
	}
	return res, nil
}

// BuildSearchResponse 把 CLI 结果包成 API 载荷。纯函数：唯一的加工是确保
// matches 不为 null（前端按数组消费）。Errors 刻意原样透传——它是 omitempty，
// 「缺席」表示这次检索没有子树失败，消费方据此区分干净与有失败。
func BuildSearchResponse(res SearchResult) SearchResponse {
	out := SearchResponse{
		OK:        true,
		Keyword:   res.Keyword,
		Matches:   res.Matches,
		Scanned:   res.Scanned,
		Truncated: res.Truncated,
		Errors:    res.Errors,
	}
	if out.Matches == nil {
		out.Matches = []SearchMatch{}
	}
	return out
}
