# Task final fix report: JuiceFS distro phase 1 review items

## Status

**DONE_WITH_CONCERNS.** Five Important review items applied. No commit. Docker image not rebuilt.

## Covering tests

Command:

```
cd server && go test ./internal/foyer -count=1
```

Result: **PASS**

```
ok  	filestore/internal/foyer	2.261s
```

Exit code 0.

## Files changed

| File | Change |
|------|--------|
| `deploy/compose.yml` | Redis named volume `redis-data` → `/data`; `command: redis-server --appendonly yes`. Postgres `pg-data` untouched. |
| `server/cmd/foyer/main.go` | Start admin after `EnsureVolume`. Admin `ListenAndServe` failure is `log.Fatal`. Gateway still blocks on `r.Gateway`. |
| `.dockerignore` | Repo-root ignore: include juicefs source, overlay, `server`; exclude `web/`, hello txt, `*.exe`, `.git`. Compose context remains `..`. |
| `third_party/juicefs/pkg/object/fastdfs.go` | Deleted (was overlay copy in submodule). |
| `third_party/juicefs/pkg/object/fastdfs_test.go` | Deleted (was overlay copy in submodule). |
| `hello.txt`, `hello-back.txt`, `hello-back-native.txt` | Deleted. |

Not deleted: `server/foyer.exe` (gitignored). Overlay still at `overlays/juicefs/pkg/object/fastdfs.go` and `fastdfs_test.go`.

## Remaining concerns

- Recreating Redis to pick up AOF + `redis-data` drops any previous in-container (non-volume) Redis data.
- `log.Fatal` in the admin goroutine exits the whole process (intended if bind/serve fails).
- `.dockerignore` not proven with a Docker rebuild this pass.
- JuiceFS kernel and quota were not changed (out of scope).
