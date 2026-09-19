# Task 5 Report: FastDFS JuiceFS overlay

## Status

**Complete.** FastDFS storage stub overlay added under `overlays/juicefs`, apply script copies sources into `third_party/juicefs`, and `TestFastDFSRegisteredNotImplemented` passes in the JuiceFS v1.3.0 submodule. No commit (per instructions).

## Files

| File | Role |
|------|------|
| `overlays/juicefs/pkg/object/fastdfs.go` | `Register("fastdfs", newFastDFS)`; constructor returns not-implemented error |
| `overlays/juicefs/pkg/object/fastdfs_test.go` | Asserts `CreateStorage("fastdfs", …)` returns expected error |
| `scripts/apply-juicefs-overlay.ps1` | Copies `fastdfs.go` and `fastdfs_test.go` into `third_party/juicefs/pkg/object/` |

## Apply overlay

```powershell
Set-Location e:/workspace-dev/Foyer
.\scripts\apply-juicefs-overlay.ps1
```

Result: **exit 0** — `overlay applied`.

## Tests (from `third_party/juicefs`)

| Command | Result |
|---------|--------|
| `go test ./pkg/object -count=1 -run TestFastDFSRegisteredNotImplemented` | **PASS** (`ok github.com/juicedata/juicefs/pkg/object`, ~0.5s after deps cached) |
| `go test ./pkg/object -count=1 -run DoesNotExist` | **PASS** — compile OK, `[no tests to run]` |

Full `./pkg/object` suite was **not** run (may require cloud credentials); stub compiles with the package and the targeted test passes.

## Commits

None.

## Git hygiene

- Overlay and script are untracked under repo root (`overlays/`, `scripts/apply-juicefs-overlay.ps1`).
- Copied files live inside the JuiceFS submodule working tree; not `git add`’d from Foyer root (submodule gitlink unchanged).

## Concerns

- **Re-apply before build:** Any JuiceFS build or test that needs FastDFS registration must run `apply-juicefs-overlay.ps1` first; submodule checkout alone has no stub.
- **Docker/build pipelines:** Task 6+ should invoke the same overlay step (plan references `COPY overlays/...` in image build).
- **Stub only:** `fastdfs` is registered but always errors; compose and gateway must not select it until a real implementation exists.
