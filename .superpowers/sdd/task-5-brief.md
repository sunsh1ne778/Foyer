### Task 5: FastDFS overlay (compiled into juicefs, not used in compose)

**Files:**
- Create: `overlays/juicefs/pkg/object/fastdfs.go`
- Create: `scripts/apply-juicefs-overlay.ps1`

**Interfaces:**
- Consumes: JuiceFS v1.3.0 `pkg/object.Register` and `Creator` (`func(bucket, accessKey, secretKey, token string) (ObjectStorage, error)`)
- Produces: storage name `fastdfs`. Constructor returns `(nil, fmt.Errorf("fastdfs storage is not implemented"))`.

- [ ] **Step 1: Overlay source**

`overlays/juicefs/pkg/object/fastdfs.go`:

```go
package object

import "fmt"

func init() {
	Register("fastdfs", newFastDFS)
}

func newFastDFS(endpoint, accessKey, secretKey, token string) (ObjectStorage, error) {
	return nil, fmt.Errorf("fastdfs storage is not implemented")
}
```

- [ ] **Step 2: Apply script**

`scripts/apply-juicefs-overlay.ps1`:

```powershell
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "overlays\juicefs"
$dst = Join-Path $root "third_party\juicefs"
if (-not (Test-Path $dst)) { throw "missing submodule $dst" }
Copy-Item -Path (Join-Path $src "pkg\object\fastdfs.go") -Destination (Join-Path $dst "pkg\object\fastdfs.go") -Force
Write-Host "overlay applied"
```

- [ ] **Step 3: Apply and test Register inside JuiceFS module**

```powershell
.\scripts\apply-juicefs-overlay.ps1
cd third_party\juicefs
go test ./pkg/object -count=1 -run DoesNotExist
```

Expected: `no tests to run` or `PASS` (package still compiles). Then:

```powershell
go test ./pkg/object -count=1 -c -o NUL
```

If `-c -o NUL` is awkward on Windows:

```powershell
go test ./pkg/object -count=1
```

Expected: existing JuiceFS object tests pass **or** fail only for missing cloud credentials; they must **compile**. If `fastdfs.go` breaks build, fix types to match v1.3.0 `Creator`.

Add a tiny test in overlay copied as `overlays/juicefs/pkg/object/fastdfs_test.go`:

```go
package object

import "testing"

func TestFastDFSRegisteredNotImplemented(t *testing.T) {
	_, err := CreateStorage("fastdfs", "http://x", "", "", "")
	if err == nil || err.Error() != "fastdfs storage is not implemented" {
		t.Fatalf("err=%v", err)
	}
}
```

Copy it in `apply-juicefs-overlay.ps1` as well. Re-run:

```powershell
cd third_party\juicefs
go test ./pkg/object -count=1 -run TestFastDFSRegisteredNotImplemented
```

Expected: `PASS`.

Do not `git add` files under `third_party/juicefs` except the submodule gitlink from Task 1. Overlay files live only in `overlays/` and scripts.

- [ ] **Step 4: Commit overlay (optional)**

```powershell
git add overlays/juicefs/pkg/object/fastdfs.go overlays/juicefs/pkg/object/fastdfs_test.go scripts/apply-juicefs-overlay.ps1
git commit -m "feat: add FastDFS JuiceFS storage stub overlay"
```

---

