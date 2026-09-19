package foyer

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

func RedactMetaURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return raw
	}
	if _, has := u.User.Password(); !has {
		return raw
	}
	u.User = url.UserPassword(u.User.Username(), "***")
	out := u.String()
	return strings.ReplaceAll(out, "%2A%2A%2A", "***")
}

func HealthJSON(cfg Config) []byte {
	b, _ := json.Marshal(map[string]any{
		"ok":          true,
		"volume":      cfg.Volume,
		"gateway":     cfg.GatewayListen,
		"meta":        RedactMetaURL(cfg.MetaURL),
		"host_data":   cfg.HostData,
		"host_mount":  cfg.HostMount,
		"host_drives": DetectHostDrives(hostMountBase(cfg)),
	})
	return b
}

type importRequest struct {
	Src    string `json:"src"`
	Dest   string `json:"dest"`
	Name   string `json:"name"`
	Mode   string `json:"mode"`
	DryRun bool   `json:"dry_run"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func NewHealthMux(cfg Config) http.Handler {
	store := newMountStore(cfg.MountsFile)
	run := Runner{Bin: cfg.JuiceFSBin}
	mux := http.NewServeMux()
	mux.HandleFunc("/foyer/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(HealthJSON(cfg))
	})
	mux.HandleFunc("/foyer/stat", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		// 支持重复的 ?path=，一次调用解析全部路径：目录列表要为每个子目录取
		// 真实 mtime，逐个请求会把进程启动开销乘上去。
		var paths []string
		for _, p := range r.URL.Query()["path"] {
			if p = strings.TrimSpace(p); p != "" {
				paths = append(paths, p)
			}
		}
		if len(paths) == 0 {
			http.Error(w, "path required", http.StatusBadRequest)
			return
		}
		res, err := run.Stat(cfg, paths)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "stats": res})
	})
	mux.HandleFunc("/foyer/usage", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var paths []string
		for _, p := range r.URL.Query()["path"] {
			if p = strings.TrimSpace(p); p != "" {
				paths = append(paths, p)
			}
		}
		res, err := run.Usage(cfg, paths)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		disk, derr := StatDisk(cfg.DataDisk)
		// 每个路径的分母来自它自己依赖的盘：现场 statfs，不缓存、不落库。
		// 同一个来源盘只 statfs 一次（多个挂载可能同盘）。
		mounts, _ := store.list()
		byDest := poolPathFor(mounts)
		pools := map[string]DiskSpace{}
		seen := map[string]DiskSpace{}
		for _, p := range paths {
			src, ok := byDest[cleanVolumePath(p)]
			if !ok {
				continue
			}
			d, cached := seen[src]
			if !cached {
				var err error
				if d, err = StatDisk(src); err != nil {
					continue
				}
				seen[src] = d
			}
			pools[cleanVolumePath(p)] = d
		}
		writeJSON(w, http.StatusOK, BuildUsageResponse(res.Volume, disk, derr == nil, res.Summaries, pools))
	})
	mux.HandleFunc("/foyer/search", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		keyword := strings.TrimSpace(r.URL.Query().Get("q"))
		if keyword == "" {
			http.Error(w, "q required", http.StatusBadRequest)
			return
		}
		// path 缺省由 SearchArgs 收敛成 "/"：从卷根遍历一次即覆盖所有挂载，
		// 天然避免嵌套挂载被重复遍历。
		res, err := run.Search(cfg, r.URL.Query().Get("path"), keyword,
			r.URL.Query().Get("case") == "1", cfg.SearchMaxResults)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, http.StatusOK, BuildSearchResponse(res))
	})
	mux.HandleFunc("/foyer/browse", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		res, err := Browse(cfg, r.URL.Query().Get("path"))
		if err != nil {
			// 只有明确的客户端路径错误才是 400；os.ReadDir/权限/解析失败等
			// 服务端故障必须报 500，不能被压成客户端错误。
			code := http.StatusInternalServerError
			if errors.Is(err, ErrBrowseBadPath) {
				code = http.StatusBadRequest
			}
			http.Error(w, err.Error(), code)
			return
		}
		writeJSON(w, http.StatusOK, res)
	})
	mux.HandleFunc("/foyer/mounts", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		list, err := store.list()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if list == nil {
			list = []MountRecord{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"mounts": list})
	})
	mux.HandleFunc("/foyer/mounts/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/foyer/mounts/"), "/")
		if rest == "" {
			http.NotFound(w, r)
			return
		}
		if id, ok := strings.CutSuffix(rest, "/resync"); ok {
			if r.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			resyncMount(w, cfg, store, run, id)
			return
		}
		switch r.Method {
		case http.MethodDelete:
			deleteMount(w, store, rest)
		case http.MethodPatch:
			patchMount(w, r, store, rest)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/foyer/import", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var req importRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Src) == "" {
			http.Error(w, "src required", http.StatusBadRequest)
			return
		}
		mode := strings.TrimSpace(req.Mode)
		if mode == "" {
			mode = "metadata"
		}
		if mode != "metadata" {
			http.Error(w, "only metadata import is implemented", http.StatusNotImplemented)
			return
		}
		container, err := MapHostPath(cfg, req.Src)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		name := strings.TrimSpace(req.Name)
		dest := strings.TrimSpace(req.Dest)
		if dest == "" && name != "" {
			dest = "/" + name
		}
		if dest == "" {
			dest = "/imported"
		}
		if !strings.HasPrefix(dest, "/") {
			dest = "/" + dest
		}
		srcURI := FileURI(container)
		res, err := run.Import(cfg, srcURI, dest, req.DryRun)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		if req.DryRun {
			// 预检不落挂载表。
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": res})
			return
		}
		if name == "" {
			name = strings.Trim(dest, "/")
		}
		rec := MountRecord{
			ID:     name,
			Name:   name,
			Type:   "local",
			Status: "mounted",
			Spec: map[string]string{
				"root":      req.Src,
				"container": container,
				"dest":      dest,
				"mode":      mode,
			},
		}
		if dir := filepath.Dir(cfg.MountsFile); dir != "." && dir != "" {
			_ = os.MkdirAll(dir, 0755)
		}
		// 用落盘后的规范值回显：CreatedAt 是 upsert 补的，入参里没有。
		rec, err = store.upsert(rec)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mount": rec, "result": res})
	})
	return mux
}

func deleteMount(w http.ResponseWriter, store *mountStore, id string) {
	if _, ok, err := store.get(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	} else if !ok {
		http.Error(w, "mount not found", http.StatusNotFound)
		return
	}
	if err := store.remove(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func patchMount(w http.ResponseWriter, r *http.Request, store *mountStore, id string) {
	var in struct {
		Name   *string           `json:"name"`
		Spec   map[string]string `json:"spec"`
		Status *string           `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if in.Status != nil && *in.Status != "mounted" && *in.Status != "unmounted" {
		http.Error(w, "status must be mounted or unmounted", http.StatusBadRequest)
		return
	}
	rec, ok, err := store.update(id, func(m *MountRecord) {
		if in.Name != nil && strings.TrimSpace(*in.Name) != "" {
			m.Name = strings.TrimSpace(*in.Name)
		}
		if in.Spec != nil {
			m.Spec = in.Spec
		}
		if in.Status != nil {
			m.Status = *in.Status
		}
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "mount not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mount": rec})
}

func resyncMount(w http.ResponseWriter, cfg Config, store *mountStore, run Runner, id string) {
	rec, ok, err := store.get(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "mount not found", http.StatusNotFound)
		return
	}
	dest := strings.TrimSpace(rec.Spec["dest"])
	if dest == "" {
		dest = "/" + rec.Name
	}
	container := strings.TrimSpace(rec.Spec["container"])
	if container == "" {
		container, err = MapHostPath(cfg, rec.Spec["root"])
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	// 重复导入是幂等的：importOne 遇到 EEXIST 会跳过并计入 skipped。
	res, err := run.Import(cfg, FileURI(container), dest, false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": res})
}
