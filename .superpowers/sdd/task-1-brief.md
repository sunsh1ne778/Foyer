### Task 1: JuiceFS submodule at v1.3.0

**Files:**
- Create: `.gitmodules`
- Create: `third_party/juicefs/` (submodule checkout)
- Modify: `.gitignore` only if it currently ignores `third_party/`

**Interfaces:**
- Consumes: nothing
- Produces: directory `third_party/juicefs` with `go.mod` module `github.com/juicedata/juicefs` and tag `v1.3.0`

- [ ] **Step 1: Confirm third_party is not gitignored**

Run from repo root (PowerShell):

```powershell
Select-String -Path .gitignore -Pattern "third_party" -ErrorAction SilentlyContinue
```

Expected: no rule that ignores `third_party/`. If there is, delete that line.

- [ ] **Step 2: Add submodule pinned to v1.3.0**

```powershell
git submodule add -b v1.3.0 https://github.com/juicedata/juicefs.git third_party/juicefs
cd third_party/juicefs
git checkout v1.3.0
cd ../..
```

If `add` fails because the folder exists, remove the empty folder first. Expected: `.gitmodules` contains `path = third_party/juicefs` and `url = https://github.com/juicedata/juicefs.git`.

- [ ] **Step 3: Verify the pin**

```powershell
git -C third_party/juicefs describe --tags
```

Expected: `v1.3.0` (or `v1.3.0-0-g…` equivalent).

- [ ] **Step 4: Commit (optional)**

```powershell
git add .gitmodules third_party/juicefs
git commit -m "chore: vendor JuiceFS v1.3.0 as submodule"
```

---

