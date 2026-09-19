# Task 6 Report: Docker image + compose profile `juicefs`

## Status

**DONE_WITH_CONCERNS.** Image `deploy-foyer` built; `foyer` service starts on profile `juicefs` only. Health curl on host `8092` returned `"ok":true`. No commit.

## Files

| File | Role |
|------|------|
| `deploy/foyer/Dockerfile` | Multi-stage: overlay + JuiceFS CGO build + foyer supervisor |
| `scripts/run-foyer.ps1` | Submodule init + `docker compose --profile juicefs up --build` |
| `deploy/compose.yml` | `rustfs-init` creates `jfs`; `foyer` on profile `juicefs` |

`scripts/run-api.ps1` unchanged. Profile `app` services (`api`, `api-2`, `worker`) still `profiles: ["app"]`.

## Dockerfile adaptations (brief fallbacks)

- **CGO/fuse:** `CGO_ENABLED=0` failed (`sqlite3` undefined + CGO-only packages). Applied brief fallback: `gcc`, `libfuse3-dev`, `CGO_ENABLED=1`. Did **not** pass `-tags nogateway`.
- **GOPROXY:** `proxy.golang.org` zip downloads hit `unexpected EOF`. Set `GOPROXY=https://goproxy.cn,direct`.
- **Go version:** `server/go.mod` requires `go 1.25.0`; brief image is `golang:1.23-bookworm`. Set `GOTOOLCHAIN=auto` for foyer only (downloaded `go1.25.0`).
- **Base images:** first Hub token fetch timed out; tagged local `golang:1.23` (Debian 12) as `golang:1.23-bookworm`; `debian:bookworm-slim` pulled on retry.

## Docker command summaries

### `git submodule update --init --recursive`

Exit **0**. Already initialized; no extra clone output.

### `docker compose -f deploy/compose.yml --profile juicefs build foyer`

**Attempt 1:** failed Hub metadata (`auth.docker.io` connect timeout).

**Attempt 2 (CGO=0):** modules downloaded; compile failed sqlite3/`CGO`.

**Attempt 3 (CGO=1 + goproxy):** juicefs `go build` **OK** (~83s compile after deps); foyer failed `go.mod requires go >= 1.25.0 (running go 1.23.12)`.

**Attempt 4 (GOTOOLCHAIN=auto):** **EXIT=0**. JuiceFS layer cached. Foyer built with downloaded go1.25.0 (~18s). Image `deploy-foyer:latest` (`sha256:4760190a9b73…`).

PowerShell records docker progress on stderr as `NativeCommandError`; compose exit code was 0.

### `docker compose -f deploy/compose.yml --profile juicefs up -d foyer`

**EXIT=0.** `service_completed_successfully` on `rustfs-init` **worked** (no compose fallback).

- redis: already Running → Healthy
- rustfs: already Running
- rustfs-init: Recreated → Started → Exited
- foyer: Created → Started

### `curl.exe http://127.0.0.1:8092/foyer/health`

**Worked.** HTTP body:

```json
{"gateway":"0.0.0.0:9002","meta":"redis://redis:6379/1","ok":true,"volume":"foyer"}
```

## Gateway behavior (for Task 7)

First start: `juicefs status` logged `<FATAL>: database is not formatted` (expected probe), then `format` succeeded, then gateway:

- Endpoint `http://0.0.0.0:9002` (host `19002:9002`)
- `IAM initialization complete`
- Object storage path logged as `minio://http://rustfs:9000/jfs/jfs/foyer/`
- Redis AOF-not-enabled warning (data-loss risk if Redis dies uncleanly)
- Gateway S3 identity from env: `MINIO_ROOT_USER=foyerak`, `MINIO_ROOT_PASSWORD=foyersecret`

## Commits

None.

## Concerns

- Dockerfile diverges from the brief’s exact `CGO_ENABLED=0` block (required fallback) plus GOPROXY and GOTOOLCHAIN.
- Runtime image is `debian:bookworm-slim` + `ca-certificates` only; CGO juicefs is dynamically linked (fuse/sqlite). Gateway started without extra runtime libs this run; other hosts may need `libfuse3`/`libc` packages if the binary is not fully static.
- `juicefs status` prints FATAL on first boot before format; health still became `ok`.
- Hub/apt/goproxy were flaky; rebuilds may need retries.

## Whole-branch review fixes (2026-09-18)

Status: **DONE_WITH_CONCERNS.** No commit. Docker image not rebuilt.

Covering tests:

```
cd server && go test ./internal/foyer -count=1
```

Result: **PASS** — `ok filestore/internal/foyer 2.261s` (exit 0).

Changes:

- `deploy/compose.yml`: named volume `redis-data` on `/data`; `redis-server --appendonly yes`. `pg-data` unchanged.
- `server/cmd/foyer/main.go`: `EnsureVolume` first; admin `ListenAndServe` error is `log.Fatal`; gateway still blocks after.
- Repo-root `.dockerignore`: allow `third_party/juicefs`, `overlays/juicefs`, `server`; exclude `web/`, hello txt, `*.exe`, `.git`.
- Removed submodule overlay copies `third_party/juicefs/pkg/object/fastdfs.go` and `fastdfs_test.go` (overlay remains under `overlays/juicefs`).
- Deleted repo-root `hello.txt`, `hello-back.txt`, `hello-back-native.txt`. Left `server/foyer.exe` alone.

Remaining concerns: existing Redis containers without `redis-data` will recreate and lose in-memory data; AOF + new volume only apply after recreate. Admin `log.Fatal` from a goroutine still `os.Exit`s the process (desired). Docker context ignore was not verified with a rebuild.
