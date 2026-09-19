# Task 2 Report: Admin health JSON (no JuiceFS import)

## Status

**Complete.** All four files created under `server/internal/foyer/`. No `github.com/juicedata/juicefs` import. No commit (per instructions).

## Files

| File | Role |
|------|------|
| `server/internal/foyer/config.go` | `Config`, `LoadConfig`, env defaults |
| `server/internal/foyer/config_test.go` | Default and env override tests |
| `server/internal/foyer/health.go` | `RedactMetaURL`, `HealthJSON`, `NewHealthMux` |
| `server/internal/foyer/health_test.go` | Redaction, JSON, `/foyer/health` route tests |

## TDD: RED

Command:

```powershell
Set-Location e:/workspace-dev/Foyer/server
go test ./internal/foyer -count=1
```

Output:

```
# filestore/internal/foyer [filestore/internal/foyer.test]
internal\foyer\config_test.go:21:9: undefined: LoadConfig
internal\foyer\config_test.go:33:9: undefined: LoadConfig
internal\foyer\health_test.go:13:9: undefined: RedactMetaURL
internal\foyer\health_test.go:21:5: undefined: RedactMetaURL
internal\foyer\health_test.go:27:9: undefined: Config
internal\foyer\health_test.go:29:27: undefined: HealthJSON
internal\foyer\health_test.go:38:9: undefined: NewHealthMux
FAIL	filestore/internal/foyer [build failed]
FAIL
```

## Implementation

Implemented `config.go` and `health.go` per task brief. One deviation from the brief’s literal `health.go` snippet:

- **`RedactMetaURL`:** `url.UserPassword(..., "***")` followed by `u.String()` produces `%2A%2A%2A` in the password segment on Go’s URL encoder. `TestRedactMetaURL` requires literal `***`. Added `strings.ReplaceAll(out, "%2A%2A%2A", "***")` after `String()`.

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
=== RUN   TestRedactMetaURL
--- PASS: TestRedactMetaURL (0.00s)
=== RUN   TestHealthJSONAndRoute
--- PASS: TestHealthJSONAndRoute (0.00s)
PASS
ok  	filestore/internal/foyer	0.727s
```

## Verification

- Module: `filestore` (from `server/go.mod`)
- Package path: `filestore/internal/foyer`
- No JuiceFS SDK/exec/gateway wiring (Task 3 scope)

## Commits

None (explicitly skipped).

## Concerns

- **URL redaction encoding:** Relying on replacing `%2A%2A%2A` is correct for the fixed redaction value `***` but would not generalize if the redaction token changed. A hand-built userinfo string would avoid encoding quirks if requirements expand (e.g. username+password redaction).
- **`HealthJSON` errors ignored:** Matches brief (`b, _ := json.Marshal(...)`); marshal failures are unlikely for this map shape.
