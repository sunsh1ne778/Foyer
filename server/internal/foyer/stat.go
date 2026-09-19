package foyer

import (
	"fmt"
	"strings"
)

// StatResult mirrors one JSON line printed by `juicefs stat`. On failure only
// Path and Error are set (Error is omitted when the path resolved).
//
// This exists because the S3 data plane cannot carry directory timestamps:
// with a delimiter directories only show up in CommonPrefixes (no LastModified),
// and HeadObject on a directory key returns 404. The control plane therefore has
// to read directory attributes straight from the volume metadata.
type StatResult struct {
	Path      string `json:"path"`
	Error     string `json:"error,omitempty"`
	Inode     uint64 `json:"inode"`
	Type      string `json:"type,omitempty"`
	Mode      uint16 `json:"mode"`
	Uid       uint32 `json:"uid"`
	Gid       uint32 `json:"gid"`
	Size      uint64 `json:"size"`
	Nlink     uint32 `json:"nlink"`
	Mtime     int64  `json:"mtime"`
	Mtimensec uint32 `json:"mtimensec"`
}

// StatArgs builds `juicefs stat META PATH [PATH...]`. Read-only: never mutates
// metadata. Several paths go into one argv on purpose — a directory listing needs
// the mtime of every subdirectory, and one process per path does not scale.
func StatArgs(cfg Config, paths []string) []string {
	return append([]string{"stat", cfg.MetaURL}, paths...)
}

// parseStatResults decodes one StatResult per JSON line, preserving order.
// Lines that do not decode (JuiceFS log lines interleave on the same stream) are
// skipped; it is an error only if no line decoded at all.
func parseStatResults(text string) ([]StatResult, error) {
	out := make([]StatResult, 0, strings.Count(text, "\n")+1)
	for _, line := range strings.Split(text, "\n") {
		if res, ok := decodeJSONLine[StatResult](line); ok {
			out = append(out, res)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no JSON stat in juicefs output: %s", truncate(text, 200))
	}
	return out, nil
}
