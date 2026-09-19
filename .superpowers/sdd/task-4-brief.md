### Task 4: `foyer` supervisor binary

**Files:**
- Create: `server/cmd/foyer/main.go`

**Interfaces:**
- Consumes: `LoadConfig`, `NewHealthMux`, `Runner.EnsureVolume`, `Runner.Gateway`
- Produces: command `go build -o foyer ./cmd/foyer` from `server/`

Before `Gateway`, set (if unset in the process env, still set from Config so the child sees them):

- `MINIO_ROOT_USER` = `cfg.GatewayRootUser`
- `MINIO_ROOT_PASSWORD` = `cfg.GatewayRootPass`

Start `http.ListenAndServe(cfg.AdminListen, NewHealthMux(cfg))` in a goroutine. Then `EnsureVolume` then `Gateway`. If `EnsureVolume` fails, `os.Exit(1)`. `Gateway` returning is fatal (`os.Exit(1)`).

- [ ] **Step 1: Write main**

`server/cmd/foyer/main.go`:

```go
package main

import (
	"log"
	"net/http"
	"os"

	"filestore/internal/foyer"
)

func main() {
	cfg := foyer.LoadConfig()
	go func() {
		log.Printf("foyer admin on %s", cfg.AdminListen)
		if err := http.ListenAndServe(cfg.AdminListen, foyer.NewHealthMux(cfg)); err != nil {
			log.Printf("admin server: %v", err)
		}
	}()
	_ = os.Setenv("MINIO_ROOT_USER", cfg.GatewayRootUser)
	_ = os.Setenv("MINIO_ROOT_PASSWORD", cfg.GatewayRootPass)
	r := foyer.Runner{Bin: cfg.JuiceFSBin}
	if err := r.EnsureVolume(cfg); err != nil {
		log.Fatal(err)
	}
	log.Printf("foyer gateway %s volume=%s", cfg.GatewayListen, cfg.Volume)
	if err := r.Gateway(cfg); err != nil {
		log.Fatal(err)
	}
}
```

- [ ] **Step 2: Compile supervisor (juicefs binary may be missing; that is OK)**

```powershell
cd server
go build -o foyer.exe ./cmd/foyer
```

Expected: exit 0, `foyer.exe` created. Do not run it yet without juicefs.

- [ ] **Step 3: Commit (optional)**

```powershell
git add server/cmd/foyer/main.go
git commit -m "feat: add foyer supervisor command"
```

---

