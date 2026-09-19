# 报告：挂载生命周期 + 导入闭环（第二期）端到端验证

Plan: `docs/superpowers/plans/2026-09-18-foyer-mount-lifecycle-import.md`
Branch: `feat/foyer-mount-lifecycle-import`

## Status

**DONE_WITH_CONCERNS**（全部通过，含 1 个新发现并修复的真 bug；2 条上游用例在本环境 hang，已用 A/B 证明与本改动无关）

## 覆盖测试

| 套件 | 命令 | 结果 |
|------|------|------|
| foyer 单测 | `cd server && go test ./internal/foyer/` | **PASS** `ok filestore/internal/foyer 9.019s` |
| foyer vet | `go vet ./internal/foyer/` | 无输出 |
| overlay 专项 | Docker `golang:1.23-bookworm`，`-run` 保真/stat/compat | **PASS** 19/19（见下表） |
| cmd 全量 | `-skip <FUSE 用例>` | **PASS** `ok .../cmd 0.142s` |
| pkg/vfs 全量 | `-skip 'TestBackup\|TestReadDirBatch'` | **22 PASS / 0 FAIL**，随后 `TestReaddir` 上游 hang |
| TestBackup 单跑 | `-run '^TestBackup$'` | **PASS** `--- PASS: TestBackup (0.13s)` |
| pkg/object | `-run 'TestFastDFS\|TestParseFastDFS'` | **PASS** `ok .../pkg/object 0.053s` |
| Web 单测 | `cd web && npx vitest run` | **PASS** 21/21（5 文件） |
| Web 类型 | `cd web && npx tsc --noEmit` | **PASS** exit 0 |

overlay 专项 19 条（全绿）：

```
cmd:      TestMetadataForKeepsMtimeModeAndOwner / TestMetadataForZeroMtimeIsAbsent
          TestHasSourceMtimeRejectsZeroAndEpoch / TestMetadataForTreatsEpochAsMissing
          TestMetadataForUnresolvableOwnerSkipsChown / TestMetadataForStripsWriteAndSpecialBits
          TestImportDirPathTrimsTrailingSlash / TestDirKeyFromObject
          TestNormalizeVolumePath / TestStatTypeString / TestStatResultOfCarriesDirectoryMtime
          TestStatResultJSONKeysAreStable / TestStatResultErrorShape
pkg/vfs:  TestSkipInternalKey / TestIsInternalKeyDoesNotSkipUserDirs / TestJoinImportPath
          TestSkipInternalDirKey / TestObjectFileReader / TestOpenStorageURIFile
```

## 端到端保真验证（核心验收点）

源树用特征时间戳构造（`E:\foyer-e2e-src`，含空目录 `empty/`），经
`POST /foyer/import` 做 metadata-only 导入到 `/e2e`，再用
`GET /foyer/stat?path=...` 读回真值。

源侧（Windows，+08:00）与读回值（epoch → UTC）逐条精确一致：

| 路径 | 类型 | 源 LastWriteTime | stat mtime | 换算 UTC |
|------|------|------------------|-----------|----------|
| `/e2e`（根） | directory | 2019-12-31 23:59:58 | 1577807998 | 2019-12-31T15:59:58Z |
| `/e2e/sub` | directory | 2023-04-05 06:07:09 | 1680646029 | 2023-04-04T22:07:09Z |
| `/e2e/empty` | directory | 2024-05-06 07:08:09 | 1714950489 | 2024-05-05T23:08:09Z |
| `/e2e/hello.jpg` | file | 2020-01-02 03:04:05 | 1577905445 | 2020-01-01T19:04:05Z |
| `/e2e/run.sh` | file | 2021-02-03 04:05:06 | 1612296306 | 2021-02-02T20:05:06Z |
| `/e2e/data.txt` | file | 2022-03-04 05:06:07 | 1646341567 | 2022-03-03T21:06:07Z |
| `/e2e/sub/nested.txt` | file | 2023-04-05 06:07:08 | 1680646028 | 2023-04-04T22:07:08Z |

这同时证实了此前实测的两条缺陷已修：**根目录时间**与**空目录 `empty/` 被建出且带真实时间**。

网关侧（UI 实际走的路径）`LastModified` 同样正确：

```
$ aws --endpoint-url http://foyer:9002 s3api list-objects-v2 --bucket foyer --prefix e2e/
| e2e/data.txt       | 2022-03-03T21:06:07+00:00 |  10 |
| e2e/empty/         | 2024-05-05T23:08:09+00:00 |  0  |
| e2e/hello.jpg      | 2020-01-01T19:04:05+00:00 |   8 |
| e2e/run.sh         | 2021-02-02T20:05:06+00:00 |  17 |
| e2e/sub/nested.txt | 2023-04-04T22:07:08+00:00 |   6 |
```

导入回执（`POST /foyer/import`）：`scanned=4 imported=4 mtime_kept=4 mtime_missing=0 mode_kept=4 owner_kept=4 dir_mtime_kept=3`；
重复导入（增量）：`imported=0 skipped=4`。

## 挂载生命周期端点

| 操作 | 期望 | 实测 |
|------|------|------|
| 预检 `dry_run:true` | 不落挂载表 | 无新记录 ✔ |
| `PATCH /foyer/mounts/e2e` `{"status":"unmounted"}` | 改为 unmounted | ✔ |
| `PATCH` 非法 status | 400 | `HTTP 400` ✔ |
| `POST /foyer/mounts/e2e/resync` | 幂等，全 skip | `imported=0 skipped=4` ✔ |
| `DELETE /foyer/mounts/e2e` | 204 | `HTTP 204` ✔ |
| 删除后读文件 | 只删目录项，数据仍在 | `s3 cp s3://foyer/e2e/hello.jpg -` → `JPEGDATA` ✔ |

## 本轮发现并修复的 bug（新增）

**`created_at` 被重复导入抹成空串。** `mountStore.upsert` 的更新分支整体替换记录，
调用方构造的 `MountRecord` 不含 `CreatedAt`，零值覆盖了已落表的创建时间；
另外新增分支补时间戳后仍回显调用方入参，首次响应也是空串。

修复（TDD：先写 `TestMountStoreUpsertPreservesCreatedAt` 复现 `"2026-09-19T04:57:11Z" -> ""`，再改）：

- `server/internal/foyer/mounts.go`：`upsert` 返回落盘后的规范记录；更新分支保留原 `CreatedAt`。
- `server/internal/foyer/health.go`：`/foyer/import` 用 `upsert` 的返回值回显。
- `server/internal/foyer/mounts_test.go`：新增回归测试。

真实栈复验：首次导入 `created_at="2026-09-19T05:32:04Z"`；重复导入仍为该值；落盘一致。

## 上游既有问题（非本改动引入，附证据）

### 1. `TestReadDirBatch` / `TestReaddir` 在 sqlite3 引擎 hang

A/B 对照（同机、同缓存、同 redis，只跑 `-run '^TestReadDirBatch$'`）：

| 树 | 到达的引擎 | 结果 |
|----|-----------|------|
| A = overlay 树 | memkv, memkv, sqlite3, sqlite3 | `test timed out after 10m0s`，`running tests: TestReadDirBatch (10m0s)` |
| B = 上游 pristine（`git archive HEAD`，673 个 `.go`，无 `compat.go`/`stat.go`，`reader.go` 无 `tryOpenCompat`） | memkv, memkv, sqlite3 | **同样卡死**（120s 时在 `futex_wait_queue` 抓到） |

卡住时进程持有：`/pristine/pkg/vfs/?_journal=WAL&_timeout=5000&cache=shared`（DSN 查询串被当作**文件名**）。
`TestReaddir` 同因超时（`running tests: TestReaddir (10m46s)`）。

结论：上游 `sqlite3://` 引擎在 `DirBatchNum=4096` 的大批量目录路径上 hang。本改动只涉及
xattr 读路径与目录时间回写，未触及目录分批读。

### 2. `TestBackup` 泄漏后台 goroutine，拖慢其后的全部用例

`pkg/vfs/backup_test.go:72` 起了一个永不退出的 `go Backup(v.Meta, blob, 100*time.Millisecond, false)`；
`backup.go:50` 的 `Backup` 是 `for {}`，把上次备份时间存成 `time.RFC3339`（**秒级**），
判断却是 `now.Sub(last) >= interval`（100ms）——同一秒内差值恒 ≥ 100ms，于是每轮循环都触发一次备份。

实测影响：一次运行内出现 **127,289 条** `backup metadata succeed`（≈ 每秒上百次，而设计意图是 10 次/秒），
且要 dump 越来越大（`TestReadDirBatch` 建 2 万 inode 后）→ 该用例从数秒恶化到分钟级。
处置：全量跑时 `-skip TestBackup`，单跑确认 `--- PASS: TestBackup (0.13s)`。

## 未覆盖 / 已知限制

- **`mode` 保真在 Windows 源上无法复现**：Windows bind mount 经 9p/virtiofs 呈现的权限位恒为
  `0777`（容器内 `ls -la /mnt/e/...` 实测全为 `rwxrwxrwx`，`uid=gid=0`）。因此方案 Step 11 第 6 条
  （源 `0755` → 落 `r-xr-xr-x`）需要 Linux 源才能验证；Windows 上 `mode_kept=4` 记录的是
  "对源提供的 mode 做了写入"（源提供 0777），不是"拿到了 POSIX 位"。属平台限制，非缺陷。
- **FUSE 相关 cmd 用例**在本环境跳过（容器无 `fuse` 设备）：`TestMount`、`TestUmount`、`TestBench*`、
  `TestIntegration`、`TestGc`、`TestFsck` 等；它们与本期改动无关。
- `go vet ./pkg/object/` 报 `object_storage_test.go:527: call to (*testing.T).Fatalf from a non-test goroutine`，
  该文件为上游未修改文件（overlay 只新增 `fastdfs.go`/`fastdfs_test.go`）。

## 环境

- 分支 `feat/foyer-mount-lifecycle-import`
- overlay 重新应用（`scripts/apply-juicefs-overlay.ps1`），`cmdImport(),`/`cmdStat(),` 已注册于 `main.go`
- foyer 镜像重建两次（第二次含 `created_at` 修复）；compose 栈 `deploy_*` 全部 running
- Docker 数据盘已迁至 `G:`（`C:\...\Docker\wsl\disk` → junction → `G:\DockerData\disk`），C: 可用空间 9.3GB → 24GB
