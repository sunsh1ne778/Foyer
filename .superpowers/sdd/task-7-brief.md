### Task 7: README verification (aws/mc)

**Files:**
- Modify: `README.md` (new section after 本地开发, do not remove existing API/Web instructions)

**Interfaces:**
- Consumes: ports `19002` / `8092`, keys `foyerak` / `foyersecret`
- Produces: documented put/get that matches the success criterion

- [ ] **Step 1: Append this section verbatim (adjust only if a port in compose differs)**

```markdown
## JuiceFS 发行版（第一期）

源码：`third_party/juicefs`（submodule，v1.3.0）。进程：`foyer` 监督官方 `juicefs gateway`。旧 `/v1` API 不变。

```powershell
git submodule update --init --recursive
.\scripts\run-foyer.ps1
```

或：`docker compose -f deploy/compose.yml --profile juicefs up --build`

| 用途 | 地址 |
|------|------|
| S3 Gateway | http://127.0.0.1:19002 |
| 管理健康检查 | http://127.0.0.1:8092/foyer/health |
| Gateway AK/SK | foyerak / foyersecret |

验证（AWS CLI）：

```powershell
$env:AWS_ACCESS_KEY_ID = "foyerak"
$env:AWS_SECRET_ACCESS_KEY = "foyersecret"
$env:AWS_DEFAULT_REGION = "us-east-1"
echo hello | Out-File -Encoding ascii hello.txt
aws --endpoint-url http://127.0.0.1:19002 s3 mb s3://foyer
aws --endpoint-url http://127.0.0.1:19002 s3 cp hello.txt s3://foyer/hello.txt
aws --endpoint-url http://127.0.0.1:19002 s3 cp s3://foyer/hello.txt hello-back.txt
Get-Content hello-back.txt
```

成功：读回内容含 `hello`。JuiceFS 默认桶名与 `FOYER_VOLUME`（`foyer`）一致；若 `mb` 报已存在，直接 `cp`。

`mc` 等价：`mc alias set foyer http://127.0.0.1:19002 foyerak foyersecret` 然后 `mc cp hello.txt foyer/foyer/hello.txt`。
```

Note: JuiceFS gateway `--bucket-name` defaults to volume name `foyer`. The `s3 mb s3://foyer` may be unnecessary if the gateway already exposes that bucket; if `mb` fails with “already exists” or “invalid”, document `cp` to `s3://foyer/hello.txt` only. Implementer: run once and keep the README matching actual gateway behavior.

- [ ] **Step 2: Run the aws commands against a live stack; paste the working variant into README if `mb` differs.**

- [ ] **Step 3: Commit (optional)**

```powershell
git add README.md
git commit -m "docs: JuiceFS gateway local verify steps"
```

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| submodule pin | 1 |
| `foyer` starts gateway + `/foyer/health` | 2, 4 |
| compose Redis meta + RustFS | 6 |
| idempotent format | 3 |
| FastDFS Register skeleton, not in compose | 5, 6 |
| README aws/mc | 7 |
| ports 19002 / 8092 | 6 |
| env names | 2, 6 |
| old API profile unchanged | 6 (foyer on `juicefs` profile only) |
| no vfs rewrite / no FUSE / no quota | Global Constraints |

## Handoff

Plan saved to `docs/superpowers/plans/2026-09-18-juicefs-distro.md`.
