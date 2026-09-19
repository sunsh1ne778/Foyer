# Task 3 Report: JuiceFS exec runner (format skip + gateway argv)

## Status

**Complete.** Added `exec.go` and `exec_test.go` under `server/internal/foyer/`. No `github.com/juicedata/juicefs` import. No `cmd/foyer`. No commit (per instructions).

## Files

| File | Role |
|------|------|
| `server/internal/foyer/exec.go` | `Runner`, `FormatArgs`, `GatewayArgs`, `Status`, `Format`, `Gateway`, `EnsureVolume` |
| `server/internal/foyer/exec_test.go` | Argv tests, `EnsureVolume` with fake binary, missing-bin `Status` |

## TDD: RED

Command:

```powershell
Set-Location e:/workspace-dev/Foyer/server
go test ./internal/foyer -count=1
```

Output:

```
FAIL	filestore/internal/foyer [build failed]
FAIL
# filestore/internal/foyer [filestore/internal/foyer.test]
internal\foyer\exec_test.go:19:21: undefined: FormatArgs
internal\foyer\exec_test.go:23:8: undefined: GatewayArgs
internal\foyer\exec_test.go:96:7: undefined: Runner
internal\foyer\exec_test.go:108:7: undefined: Runner
internal\foyer\exec_test.go:123:7: undefined: Runner
```

## Implementation

Implemented `exec.go` per task brief (argv layout, `EnsureVolume` = status-then-format, gateway/format error wrapping, stdout/stderr inherited on child).

## TDD: GREEN

Command:

```powershell
Set-Location e:/workspace-dev/Foyer/server
go test ./internal/foyer -count=1 -v
```

Output:

```
=== RUN   TestLoadConfigDefaults
--- PASS: TestLoadConfigDefaults (0.00s)
=== RUN   TestLoadConfigEnv
--- PASS: TestLoadConfigEnv (0.00s)
=== RUN   TestFormatAndGatewayArgs
--- PASS: TestFormatAndGatewayArgs (0.00s)
=== RUN   TestEnsureVolumeSkipsFormatWhenStatusOK
--- PASS: TestEnsureVolumeSkipsFormatWhenStatusOK (0.87s)
=== RUN   TestEnsureVolumeFormatsWhenStatusFails
--- PASS: TestEnsureVolumeFormatsWhenStatusFails (0.89s)
=== RUN   TestRunnerUsesConfiguredBin
--- PASS: TestRunnerUsesConfiguredBin (0.01s)
=== RUN   TestRedactMetaURL
--- PASS: TestRedactMetaURL (0.00s)
=== RUN   TestHealthJSONAndRoute
--- PASS: TestHealthJSONAndRoute (0.00s)
PASS
ok  	filestore/internal/foyer	2.536s
```

## Test summary

| Test | Result |
|------|--------|
| `TestFormatAndGatewayArgs` | PASS |
| `TestEnsureVolumeSkipsFormatWhenStatusOK` | PASS |
| `TestEnsureVolumeFormatsWhenStatusFails` | PASS |
| `TestRunnerUsesConfiguredBin` | PASS |
| Task 2 tests (config + health) | PASS |

**Total:** 8 tests, all PASS (`go test ./internal/foyer -count=1`).

## Commits

None (explicitly skipped).

## Concerns

- **Windows fake binary:** Used `go build` of a small `main` in `t.TempDir()` (`writeFakeJuiceGo`) instead of `juicefs.cmd`, per brief fallback. Ensures reliable `status`/`format` and `out.txt` assertions on Windows without the brief’s Windows-only early return on format output.
- **`Runner` vs `Config.JuiceFSBin`:** Tests pass an explicit `Runner{Bin: …}`; wiring `LoadConfig().JuiceFSBin` into a default `Runner` is left for a later task (e.g. `cmd/foyer`).
- **`Gateway` not tested:** By design (blocking long-running process); only argv helpers and `EnsureVolume` are covered.
