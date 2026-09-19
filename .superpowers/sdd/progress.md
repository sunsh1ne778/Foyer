# SDD ledger — 挂载源真实用量与容量

Plan: docs/superpowers/plans/2026-09-19-mount-real-usage-capacity.md
Branch: feat/foyer-mount-lifecycle-import（非 main，可直接在工作树实现）
BASE at start: 795c9da

环境决议（controller 预检，非规格冲突）：
- 本机 `bash` 指向未配置的 WSL，`sh` 不可用 → overlay 用 `scripts/apply-juicefs-overlay.ps1` 落地；
  `.sh` 版本同步改，供 Dockerfile 构建期使用。
- `third_party/juicefs` 的 cmd 包在 Windows 编译不了（CGO_ENABLED=0，sqlite3/lz4/zstd
  的 build constraints 排除全部文件）。overlay 测试一律在 Docker `golang:1.23-bookworm`
  + gcc + libfuse3-dev 里跑，与 juicefs distro 任务的既有约定一致。
- server 与 web 测试照常在本机跑（Windows）。

## Tasks

Task 1: complete (commits 8e44660..b31a685, review clean after 1 fix round — spec ✅, quality Approved)
  overlay 新增 `juicefs usage`（DirStats/GetSummary 读 size+inodes，StatFS+Format.Capacity 读卷用量）。
  Fix round 1（reviewer Important）：`avail_inodes` 原本跟 `format.Capacity` 走，会漏出合成值
  （base.go:862-872 在 `format.Inodes==0` 时伪造 `iavail = 10<<20`）。改为按字段各自开关：
  `avail` 看 `Capacity`，`avail_inodes` 看 `Inodes`。计划文本已同步。
  计划偏差：`m.Load` 返回 `*Format`，`volumeUsageOf` 签名改为指针 —— 计划文本已修正。
  ✅ reviewer 的「stdout 是否只有一行干净 JSON」已由 controller 用真实卷关闭：stdout 恰好 1 行、
    `cat -A` 无游离 CR/控制字符、juicefs 日志全走 stderr、`/nope` 走 per-path `error` 字段且退出码 0。
    实测值 `used=1856445624320`（~1.69 TiB）、`used_inodes=2519`、`capacity_set=false`。
  Minors（留给最终评审分诊）：
  - `avail_inodes == 0` 无法区分「没配额」与「配额用尽」（只有 `capacity_set`）；文档已说明，
    但 `usage.go` 的注释措辞过度承诺了可区分性。
  - `usagePaths` 的「单路径失败不炸整个命令」路径没有测试（缺 `meta.Meta` 接缝）。
  - 纯空白路径参数被静默丢弃，`summaries` 可能比入参个数少。
  - 整包 `go test ./cmd/` 在本机跑不绿：既有 `TestBench`/`TestCompact` 需要真 FUSE，
    与本任务无关。回归用 overlay 专项集合（23/23）。
Task 2: complete (commits a509165..715fcf6, review clean after 1 fix round + 1 plan reconciliation — spec ✅, quality Approved)
  server 侧 `UsageArgs`/`Runner.Usage`/`parseUsage` + `DiskSpace`/`UsageVolume`/`UsageResponse`/`BuildUsageResponse`。
  Fix round 1（reviewer Important，计划自相矛盾，由计划所有者裁决）：brief 的**实现**把
  `CapacitySet` 原样透传（正确），brief 的**测试**却断言 fallback 时 `CapacitySet=true`，实现者只能二选一。
  裁决：`UsageVolume.CapacitySet` 保持 CLI 契约语义「卷配置了容量配额吗」，即透传；
  「分母是否可用」看 `Capacity != 0`。计划文本的 Task 2 测试、Task 3 测试、Task 5 fixture 已同步一致。
  计划偏差：无（本任务按 brief 实现，唯一改动来自上述裁决）。
  Minors（留给最终评审分诊）：
  - `usage.go` 注释里的中英混排 `它 NOT 表示` 措辞别扭（纯文案）。
  - fallback 触发条件用 `Capacity == 0` 而非 `!CapacitySet`；契约下不可达，仅信息性。
Task 3: complete (commits 715fcf6..804ce5a, review clean — spec ✅, quality Approved)
  `StatDisk`（disk_linux.go 用 `syscall.Statfs`；disk_other.go 失败关闭）、`Config.DataDisk`（默认 `/`）、
  `Config.VolumeCapacityGB`（默认 0）、`envUint64`、`GET /foyer/usage` 端点。
  ✅ reviewer 的「statfs 数学与 /foyer/usage 路由在本机（Windows）跑不到」已由 controller 在 Linux
  容器（golang:1.23-bookworm，GOTOOLCHAIN=auto 拉 go1.25）关闭：5/5 PASS
  （TestStatDiskReportsRealCapacity、TestStatDiskRejectsMissingPath、TestUsageRouteReturnsResolvedCapacity、
  TestUsageRouteWithoutDiskReportsZeroCapacity、TestUsageRouteRejectsNonGet）。
  Minors（留给最终评审分诊）：
  - `envUint64` 与两个新 Config 默认值缺测试（reviewer: 不阻塞，建议随 Task 4 一并补，实际未补）。
Task 4: complete (commits 804ce5a..b5cf358, review clean — spec ✅, quality Approved)
  `ConfigArgs`/`Runner.Config`（`--capacity` 单位 GiB）、`EnsureCapacity`（安全闸）、
  `EnsureVolumeCapacity`（启动期，失败只告警）、main.go 接线、compose env。
  安全闸的必要性经 controller 预检确认：`format.Capacity` 是硬限制（quota.go:262），而 `sanitize()`
  的自动上调只管目录 `Quota` 对象（quota.go:87-88），不管 `format.Capacity`。本卷逻辑已用 ~1.69 TiB
  > 物理盘 ~1.0 TiB ⇒ 预期线上结果是「跳过：低于当前已用」，属设计内成功路径：配额不设、网关照常
  启动、`/foyer/usage` 回退用物理盘总量当分母，前端进度条仍是真实磁盘占用。
  reviewer 独立复算：边界方向与等号、GiB 单位、三条 skip 路径均返回 nil error、0-GiB 退化盘不会
  设出 0 配额；自建临时用例 4/4 PASS 后已删除。
  计划偏差：brief Step 7 的 `git add` 漏了 `exec_test.go`，但 Step 1 要改它且 `capacity_test.go` 依赖
  其中的 `writeFakeJuiceUsage`，不 stage 则测试包编译不过 —— 实现者补 stage，判断正确。
  Minors（留给最终评审分诊）：
  - 等号边界（`used == target`）未被已提交测试钉住；代码正确（严格 `>` 才跳过），仅缺回归护栏。
  - `EnsureVolumeCapacity` 同步调用无超时（`Runner.cmd` 用 `exec.Command` 而非 `CommandContext`；
    与既有 `EnsureVolume`/`Status` 同形，非本任务引入，但仍构成「juicefs usage 挂住则网关不启动」）。
  - `desiredGB<<30` 对荒谬的 env 值无上界。
  - main.go 注释「音量配额」应为「容量配额」（把 volume 误译成音量）。
Task 5: complete (commits b5cf358..4c22cf0, review clean — spec ✅, quality Approved)
  `jfs.foyerUsage`（URLSearchParams 拼 query，`#`/空格/CJK 安全）、`mountVolumePath`、`applyUsage`、
  `ApiMount.stats`、`listMounts` 贴 stats（控制面失败不影响挂载列表）、`mapMount` 透传、`types.ts` 补 `capacity_bytes?`。
  关键性质经 reviewer 独立验证（7+2 个临时用例，跑完即删）：无数据时 `stats` 为 `undefined` 而非零填充；
  带 `error` 的 summary 即使 size 非零也不贴；`capacity_bytes` 原样拷贝服务端已解析的 `capacity`，
  前端不做二次回退。全量 108 例通过、`tsc --noEmit` 干净。
  计划偏差：brief 自相矛盾 —— Step 1 的测试调用 `mountVolumePath({id,name,spec})`，Step 4 的签名只有
  `{name,spec?}`，tsc 报 TS2353。实现者保住 brief 的测试原样、把参数加宽为 `{id?:string;name;spec?}`，
  是最小且向后兼容的修法。计划文本已同步。
  已修计划文案：fixture 注释「/av_20260619 = 596 GiB」有误导 —— `size`/`total_bytes` 单位是**字节**
  （DirStats 对齐字节：实测 9 字节内容 → `size` 28672 = 7 inode × 4 KiB）。数字原样保留（纯透传断言），
  注释已改为字节，避免 Task 6 按 GiB 误渲染。
  Minors（留给最终评审分诊）：
  - `mountVolumePath` 不做归一化（只 trim + 补前导 `/`），而 overlay 会 `path.Clean` 每个回显路径
    （stat.go:120-124）。`spec.dest` 带尾斜杠或 `//`（仅手改 mounts 能造出）会静默错过 summary →
    stats 缺席。失败方向安全（绝不零填充）。
  - `listMounts` 的 try/catch + 排除卷挂载、`foyerUsage` 的 query 编码都只有 reviewer 的临时用例覆盖，
    未沉淀为仓库测试；将来把 `filter(m => m.name !== JFS_MOUNT)` 删掉或改回字符串拼接不会红。
  - 卷挂载分支无条件贴 `stats`，后端真返回全 0 时会得到 `{0,0,0}`（与「0 = 拿不到 / 不画进度条」
    约定一致，非 bug）；Task 6 需以 `capacity_bytes > 0` 作为画进度条的判据，不能靠 `m.stats` 真假。
Task 6: complete (commits 4c22cf0..500ba91, review clean — spec ✅, quality Approved)
  新增 `web/src/utils/capacity.ts` 的 `usagePercent`（容量 0/负/NaN 一律返回 0，不设假地板）；
  Sidebar 删掉硬编码 `2TB simulated capacity` 与 `Math.max(pct, 4)`；MountManager 的「已索引对象/占用空间」
  在无数据时显示 `—`；两处进度条都以 `capacity_bytes > 0` 为唯一判据，并以 `discard`-proof 的
  `m.stats?.capacity_bytes || 0` 取值。全量 110 例通过、`tsc --noEmit` 干净。
  计划偏差（controller 决定）：brief Step 4 让 Sidebar 的用量行无条件渲染 `formatBytes(usedBytes)`，
  无 stats 的挂载会显示 `0 B` —— 与被修的是同一类假数据。已改为
  `{m.stats ? formatBytes(usedBytes) : '—'}`，与 Step 5 给 MountManager 加 `—` 的意图对齐。计划文本已同步。
  reviewer 独立验证：两处判据都是 `capacity_bytes > 0` 而非 `m.stats` 真假（卷挂载分支会无条件贴 stats，
  故 `m.stats` 真 + `capacity_bytes === 0` 是可达状态），无数据时两栏都渲染 `—` 且不画条；
  `2TB` 字面量与可执行的 `Math.max(pct, 4)` 全仓库已无（仅剩 brief 要求保留的注释）；
  自建 `usagePercent` 边界用例 5/5 通过后删除。
  ⚠️ 两处组件改动**无法执行验证**：仓库 vitest 为 node 环境且只 include `*.test.ts`，没有 DOM 测试设施。
  结论仅由 `tsc --noEmit` + 阅读代码得出，Task 7 的线上跑一次是唯一能看见真实渲染的机会。
  Minors（留给最终评审分诊）：
  - `capacity.test.ts` 未钉住 `Infinity` 容量、非有限/负的 `used`、小数进位边界（行为本身正确）。
  - `Sidebar.tsx:132` 的 tooltip 在 `stats` 存在但 `capacity_bytes === 0` 时文案为「控制面未返回用量」
    （brief 规定文案；条件本身正确）。
Task 7: complete (docs commit 89d11fe；本任务未改代码)
  在真实容器上端到端验证。**先抓到一个「假成功」**：运行中的 `deploy-foyer:latest` 早于 Task 3/4
  （`grep -ac 'foyer/usage' /usr/local/bin/foyer` = 0、`GET /foyer/usage` 404），因为用户在 Task 3 提交
  （17:32:41）前后跑了 `run-foyer.ps1`，构建在源码落盘前就把 `COPY server` 做了。重建后同一检查
  `foyer/usage`=2、`capacity: `=4，端点恢复。**教训：改后端后要验证镜像真的重建，不能只看容器在跑。**
  实测：启动日志按设计**跳过**设配额（逻辑已用 2266 GiB > 物理盘 1006 GiB，照设会让全卷写 ENOSPC）；
  `GET /foyer/usage` 200 且多路径形状与前端 `listMounts` 一致；写探针 PUT→LS(15B,可见)→RM 全通过，
  卷没被写死。实测值、未验证项与「逻辑 vs 物理」的后果已回填计划 `## Verification Notes` 与 `## 已知取舍`。
  ⚠️ **重大发现（待用户决策）**：卷挂载进度条 = 逻辑已用 2266 GiB ÷ 物理盘 1006 GiB = 225% → 钳成 100%，
  而真实磁盘占用只有 7.3%（73.8/1006.9 GiB）。分子分母量纲不同（元数据逻辑大小 vs 物理容量），
  「仅导入元数据」时该比值不成立，不满足用户原话「进度条反应真实磁盘占用」。
  `/av_20260619` = 537.2/1006.9 = 53%；`/host`、`/dtest2` ≈ 0%。
  未验证：UI 渲染未在浏览器核对（无浏览器工具 + 仓库 vitest 无 DOM 设施），上列百分比系手算。

---

## 修订（2026-09-19 20:30）：进度条改用实时池占用，取消额度

用户否决「配置的额度当分母」：
> 挂载的本地目录会受到同一磁盘盘下其他目录的挤压，剩余可用空间是动态的，并不是固定的。
> 所以我们记录了额度也没有什么意义
额度是静态快照，而挂载依赖的是共享且动态的磁盘资源；实测 `/dtest2` 逻辑用量近乎 0，
但它依赖的 `E:` 已 87% 满，静态口径完全看不见这件事。
**新口径（用户拍板）：进度条 = 该挂载所依赖存储池的实时占用率，每次请求现场采样，不记录额度、不设配额。**

Task 8: complete (commit 11fabfc, review clean — spec ✅, quality Approved)
  前置修正：① `StatDisk.Used` 改为与 `df` 同口径（`Total - Bfree*bs`，`Free = Bavail*bs`）；
  `Used+Free ≠ Total` 的差额是 ext4 保留块，注释已写明「是正确行为，勿改回」。旧实现
  `Total - Bavail*bs` 把保留块算成已用，`/` 上多报 ~51.2 GiB。② 拆掉全部配额机器：
  删 `capacity.go`/`capacity_test.go`、`ConfigArgs`/`Runner.Config`、`VolumeCapacityGB`/`envUint64`、
  main.go 启动调用、compose 的 `FOYER_VOLUME_CAPACITY_GB`、`writeFakeJuiceUsage`；API 载荷去掉
  `capacity`/`capacity_set`（`VolumeUsage` 的 CLI 镜像字段刻意保留，那是 overlay 的契约）。
  reviewer 独立复算：`Total-Bfree*bs = 24,303,673,344` = df 的 Used；旧口径 = 79,296,028,672。
  自建临时用例证明 `StatDisk("/").Used == Total-Bfree*bs` 且 ≠ 旧值（差 54,992,355,328 B）；
  tmpfs `/dev/shm` 上 `Bfree==Bavail`（两口径重合）。
  Minors（留给最终评审分诊）：
  - `TestStatDiskLeavesReservedBlockGap` 的严格断言只在 `Bfree != Bavail` 时成立（overlay 成立、
    tmpfs 不成立）；真正可移植的回归护栏是 `TestStatDiskMatchesStatfsAccounting`。
  - `Bfree > Blocks` 下溢守卫无单测（正常文件系统不可达）。
  - 跨任务提醒：`web/src/api/mounts.ts:56` 仍读已删除的 `volume.capacity`，进度条在 Task 10 落地前
    不渲染（计划内交接状态，不是 Task 8 缺陷）。
Task 9: complete (commit b48a904, review clean — spec ✅, quality Approved)
  `PathUsage` 加 `disk_total/disk_used/disk_free`（`omitempty`，缺席 = 读不到池 = 不画条）；
  `cleanVolumePath` 与 overlay 的 `normalizeVolumePath` 字节等价；`poolPathFor` 建 dest→container 映射；
  handler 现场 statfs（同源盘只算一次），`store.list()` 失败只丢池信息、不改接口行为。
  reviewer 独立验证三个核心契约：无池时 JSON 里三个键**整体缺席**（不是 0/null）；
  `Error != ""` 的 summary 即使 `pools` 里有键也不被贴（代码在该分支直接 continue）；
  `cleanVolumePath` 在含 CJK 与 `#` 的边界上与 overlay 归一结果一致。
  容器里真跑的用例：`TestUsageRouteCarriesPerPathPool`、
  `TestBuildUsageResponseAppliesPoolOnlyWhenPresent`、
  `TestBuildUsageResponseNeverAppliesPoolToErrorSummary`、`TestCleanVolumePathMatchesOverlayShape`、
  `TestPoolPathFor`（无静默 skip，集成用例显示 `--- PASS`）。
  计划偏差（已接受）：brief 原要求集成用例放 `//go:build linux` 新文件，但 build tag 是文件级、
  而 brief 又把 `git add` 限死在三个文件，实现者改用仓库既有的 `runtime.GOOS != "linux"` skip，
  功能等价。
  Minors（留给最终评审分诊）：
  - `spec.root` 那条退化分支对 host 路径实际无用（`/host` 在容器里不存在），属多余兜底。
  - dedupe 注释写「每个盘只算一次」，实际按来源路径去重，措辞过头。
  - 单字段 `omitempty` 在「池恰好满」时语义含糊（`disk_free=0` 会把该键吃掉）。
  - dest→池是**精确匹配**：请求挂载的子路径（如 `/av_20260619/sub`）拿不到池。前端只请求挂载根，
    当前无影响，但接口是通用的 —— 属未文档化的限制。
Task 10: complete (commit 6b77376, review clean — spec ✅, quality Approved)
  前端切到池口径：`ApiMountStats` 用 `pool_total_bytes`/`pool_used_bytes`/`pool_free_bytes`
  （三项同进同退，缺席即不画条），`applyUsage` 分别从 `volume` / summary 的 `disk_*` 取值；
  两处进度条改用 `usagePercent(poolUsed, poolTotal)`，并把条标注为**所依赖磁盘的占用**
  且显示池自己的已用/总量（避免逻辑量 2.21 TiB 与条上 2.2% 被读成互相矛盾）。
  无池时显示 `—` 且不画条；「有逻辑用量但没池」与「完全没 stats」两种状态都被测试钉住。
  全量 113 例通过、`tsc --noEmit` 干净。
  reviewer 独立验证：无池时绝不退化成 0%/100%（判据是 `poolTotal > 0`）；`poolOf` 三项同进同退
  （自建临时用例证明**部分** `disk_*` 载荷不会拼出可用的池）；条上的文字只出现 `池占用 x%` +
  `磁盘 poolUsed/poolTotal`，从不出现逻辑量。自建用例 4/4 通过后删除。
  Minors（留给最终评审分诊）：
  - `UsageVolume.disk_*` 没有 `omitempty`，所以「卷的池未知」会以**零值**到达前端，
    `poolOf` 因而会贴出 `pool_*=0`；目前安全仅因为两处都靠 `poolTotal > 0` 兜住。
  - Sidebar 的逻辑用量没有可见标签（只有 tooltip），与 MountManager 的「占用空间」不一致。
  - 提交是 8 个文件而非 brief 列的 9 个：`mappers.ts` 已是 `stats` 透传、无需改动（reviewer 已核实）。
Task 11: complete (docs commit 69b6fbc 前后，本任务未改代码)
  在真实容器上验证修订后的口径（重建镜像后实测）。
  **关键证据：API 的 `disk_used` 与容器内 `df -B1` 的 Used 逐字节相等** ——
  卷 `/` 与 `/dtest2`（`E:`）与 `/av_20260619`（`G:`）三处全部一致，口径修正得证。
  启动日志里的配额告警两行已随配额机器一起消失（只剩 gateway/admin 两行）。
  `/host` 不带 `disk_*`（未绑进容器）→ 不画条，而其逻辑用量（size=12288、inodes=3）照常显示 ——
  诚实退化符合设计，也是「有逻辑用量但没池」这一合法状态的线上实证。
  UI 将渲染的条：卷 **2%**（23.0/1006.9 GiB）、`/dtest2` **87%**（1545.8/1772.9 GiB）、
  `/av_20260619` **46%**（858.5/1863.0 GiB）、`/host` 不画条。
  `/dtest2` 一行正是旧口径看不见的：逻辑用量近乎 0，但依赖的 `E:` 已 87% 满、只剩 227 GiB。
  计划文本已回填 `## Verification Notes`（新增 21:00 一节；旧 17:53 一节标注为「已被否决的额度设计」）
  与 `## 已知取舍`（量纲分离、不记录额度、df 口径、metadata-only 假设、子路径精确匹配限制）。
  ⚠️ UI 渲染仍未在浏览器核对：无浏览器工具 + 仓库 vitest 无 DOM 设施；上表百分比系手算。

---

# SDD ledger — host dir picker（挂载本地目录选择器）

Plan: docs/superpowers/plans/2026-09-19-host-dir-picker.md
Spec: docs/superpowers/specs/2026-09-19-host-dir-picker-design.md
Branch: feat/foyer-mount-lifecycle-import（非 main，可直接在工作树实现）
BASE at start: 38b11b1

## Tasks

Task 1: complete (commits 38b11b1..ff93aa7, review clean — spec ✅, quality Approved)
  Minors (for final review triage):
  - path.go:112 文档注释仍写 `C:\\`（两个反斜杠），应为 `C:\`；会误导后续任务。
  - slashTrim 对输入 `/` 返回 ""（默认值在去尾斜杠之前判断），使 hostMountBase/HostMountRoot 与文档不符；实际配置不会出现。
  - HostMountBase 为 Windows 绝对路径时，"已是容器路径"短路会把它当容器路径原样放行；不影响本任务测试。
  - health.go 在 HEAD 处即 gofmt 不洁（既有 map 对齐），本任务未引入。
  决议：实现者发现我计划中 `` `:\\` `` 与测试 `G:\` 自相矛盾，按 spec（`/mnt/g` ↔ `G:\`）取一个反斜杠。
  /foyer/health 的 host_drives 输出随之从 `G:\\` 变为 `G:\`；评审已确认无消费方做精确串比较。计划文本已同步修正。
Task 2: complete (commit 3fae3d5, review clean — spec ✅, quality Approved)
  `search.go`：`SearchArgs`/`Runner.Search`/`parseSearch`/`BuildSearchResponse` +
  `SearchResult`/`SearchMatch`/`SearchFailure`/`SearchResponse`。`exec_test.go` 的 fake juicefs
  两个 GOOS 分支都加了 `find`。7/7 定向用例 PASS，go vet 与 gofmt 干净。
  reviewer 独立核对 JSON 键名与已提交的生产者 `overlays/juicefs/cmd/find.go` 逐字符一致（含
  `errors,omitempty` 的「缺席 vs 空数组」契约，且刻意只归一化 `matches`、不碰 `errors`）。
  计划偏差（已接受）：brief 的 Windows `case "find"` 片段用了反引号 raw string，但它是内联进
  `writeFakeJuiceGo` 的 ``src := `package main...``` 里的——嵌套反引号会提前终止外层 raw string，
  整个文件编译不过。实现者改用转义双引号字符串（与既有 import/stat/usage 三个 case 同形）。
  计划文本已同步。
  reviewer ⚠️ 一项由 controller 关闭：POSIX sh 分支在 Windows 上跑不到。已用真 Linux 容器执行
  `go test ./internal/foyer/`（go.mod `go 1.25.0` + GOTOOLCHAIN=auto）→ **7/7 PASS**，其中
  `TestRunnerSearchParsesFakeBin` 正是走 POSIX sh 分支的那条，属执行验证而非推演。
  Minors（留给最终评审分诊）：
  - 两个 fake 分支都忽略 `os.Args`，所以 `TestRunnerSearchParsesFakeBin` 即使 `Runner.Search`
    不再转发 keyword/root 也照样绿；argv 的正确性靠 `TestSearchArgsDefaultsRootAndOmitsZeroLimit` 兜住。
  - `Runner.Search` 原样转发空 keyword（空串在 overlay 侧 `strings.Contains(name,"")` 恒真）——
    属 Task 3 handler 的校验职责（对空 `q` 返 400），本任务不越界。
  - Go 的 `omitempty` 对「零长切片」与「nil」一视同仁，理论上生产者若发 `"errors":[]` 重编码会变成
    键缺席；已提交的生产者从不发 `[]`（只 append），当前无实际影响。
Task 3: complete (commit 6e73688, review clean — spec ✅, quality Approved)
  `health.go` 插入 `GET /foyer/search`（405+Allow / 400 空 q（走 http.Error，与 /foyer/stat 同形）/
  502 runner 失败 / 200 writeJSON）；`config.go` 加 `Config.SearchMaxResults` + `envUint64`；
  `deploy/compose.yml` 加 `${FOYER_SEARCH_MAX_RESULTS:-0}`。4 个新 handler 用例，包内 11/11，
  `go test ./...` 全绿，go vet + gofmt 干净。既有 7 个 Task 2 用例未动。
  reviewer 两个具名风险均已核实：① 路由确实注册在 `NewHealthMux` 内部（health.go:128），
  闭包捕获的是函数局部 `run`/`cfg`，不是包级符号；② `envUint64` 全包只此一处声明，
  空串/空白串/负数/非数字/溢出都回退默认值，无 panic 路径。
  关键契约在**路由边界**被端到端断言（不是只在单测里）：干净结果序列化后 `errors` 键必须缺席，
  用 `map[string]json.RawMessage` 直接检查键的存在性。
  计划偏差：无。gofmt 因 `SearchMaxResults` 成为最长键而重排了整个 `LoadConfig` 字面量
  （config.go 显示 56 行变更但语义增量很小），属格式后果，非实现偏差。
  reviewer ⚠️ 一项由 controller 关闭：`path` 缺省收敛成 `/` 发生在 Task 2 的 `SearchArgs`（本任务
  diff 里看不到），已由 Task 2 的 `TestSearchArgsDefaultsRootAndOmitsZeroLimit` 钉住并在其评审中核实。
  Minors（留给最终评审分诊）：
  - `envUint64` 无单测：空/纯空白/负数/非数字/溢出的分支行为只在报告里推理，未落为断言。
    brief 也未要求。建议补一个表驱动用例钉住「坏配置不 panic」。
  - 上限链路无端到端覆盖：4 个路由用例都用 `Config{}`（`SearchMaxResults == 0`），所以
    `envUint64 → cfg.SearchMaxResults → run.Search(..., cfg.SearchMaxResults)` 这条缝从未以非零值跑过。
    Task 2 覆盖了 limit 的格式化，缺的是「配置→handler」这一跳（仅一行透传）。
Task 3: complete (commits 41e512c..ce22012, review clean after 1 fix round — spec ✅, quality Approved)
  Important fixed: 中间路径段为符号链接/junction 时可越过绑定根（underRoot 只做词法比较，
  Lstat 只拒最后一段）。修法：Lstat 之后加 EvalSymlinks 真实路径包含性检查，失败即关闭；
  plus containerStyle 归一化守卫两侧、修正关于 IsDir() 的错误注释、新增 TestBrowseRejectsSymlinkEscape。
  评审复核确认：Linux 走 underRoot 比较拒绝；Windows 上 EvalSymlinks 不解析 junction 而报错，
  走错误分支失败关闭。Windows 上两个链接测试均 skip（无 symlink 权限），Linux CI 才真跑。
  Minors（留给最终评审分诊）：
  - browse_test.go 的安全回归测试在 Windows 不执行；可用 `cmd /c mklink /J` 做 junction 变体。
  - EvalSymlinks 检查与 ReadDir 之间存在 TOCTOU（需本地写权限，低危）。
  - browse_test.go `Z:\nope` 那条注释与断言不符（`Z:\nope` 因目标不存在而报错，非"未绑定盘符"）。
  - health.go 把所有 Browse 错误映射为 400（内部 I/O 失败会被误标为客户端错误）；405 缺 `Allow: GET`。
  - path.go 错误串打印归一化后的 base（`/C:/data/mnt`），日志里略有误导。
Task 4: complete (commit 5641dbd, review clean — spec ✅, quality Approved)
  `jfs.foyerSearch`（URLSearchParams 拼 query；`path` trim 后为空则**不下发**该参数）+
  `FoyerSearchMatch`/`FoyerSearchFailure`/`FoyerSearchResult` 类型 + `client.searchFiles` 包装。
  5 个新用例，web 全量 118/118，`tsc --noEmit` 干净。既有文件未动。
  reviewer 两个具名风险均已核实：① 类型与已提交的服务端 JSON 逐字段一致（含 `errors` 可选性，
    且刻意不把 `ok` 也建模进去）；② 新测试文件的 fetch 打桩写法与仓库既有惯例相同。
  ⚠️ 修正：我在派发里指错了参照文件 —— `jfs.test.ts` 其实不含 fetch 打桩，真正的惯例在
    `browse.test.ts` / `hostDir.test.ts`（`vi.stubGlobal('fetch', ...)` + `afterEach(unstubAllGlobals)`）。
    reviewer 自己找到了正确的参照并确认新文件同形。
  reviewer ⚠️ 一项由 controller 关闭：`client.searchFiles` 只透传 `(keyword, path?)`，不暴露
    `caseSensitive`。这与设计一致 —— 设计的前端数据流本来就直调 `jfs.foyerSearch(keyword, path)`，
    UI 也没有大小写开关。非缺口。
  Minors（留给最终评审分诊）：
  - `errors` 键本身无测试：既没断言「缺席时为 undefined（不是 []）」，也没断言「存在时原样透传」。
    全局约束专门点了这个键，两行断言就能锁定。
  - `search.fetch.test.ts` 的「抛 ApiError」用例只断言 message（与既有 browse.test.ts 同惯例），
    没有 `toBeInstanceOf(ApiError)` —— 少了真正验证「复用既有类」的那半句。
  - `client.searchFiles` 把 `path` 默认成 `'/'`，所以无路径调用总是发 `path=%2F`，而
    `jfs.foyerSearch` 是省略该参数。在 Task 3 契约下两者等价（`path=/` 有用例覆盖），仅信息性。
Task 4: complete (commits ce22012..dc631f2, review clean — spec ✅, quality Approved)
  文件：web/src/utils/hostPath.ts（新）、web/src/utils/hostPath.test.ts（新）、web/src/api/browse.test.ts（新）、web/src/api/jfs.ts、web/src/types.ts 未改。
  注：类型按 brief 放在 jfs.ts 而非 types.ts；`HostPathSegment` 字段为 `value`（控制器派发文案里笔误成 `path`，实现者按 brief 实现，正确）。
  Minors（留给最终评审分诊）：
  - jfs.ts `ok: data.ok ?? true` 失败关闭方向不对（仅 200 且 body.ok=false 时才会误判，后端只用非 2xx 报错）。
  - `path=''` 的用例断言了调用但未断言 URL；trailing separator 与 >2 层未直接测（人工推演正确）。
  - hostPath.ts 对整串 `.trim()`，带前导空格的目录名无法往返（Windows 上非法，属边缘）。
Task 5: complete (commit 1a78ac4, review clean after 1 reconciliation — spec ✅, quality Approved)
  `web/src/api/search.ts`（6 个导出：`SEARCH_PAGE_SIZE`、`mountRoot`、`matchesDest`、`attributeMatches`、
  `parentKey`、`pageSlice`）+ `types.ts` 加 `SearchHit`。15 个新用例，web 全量 133/133，
  `tsc --noEmit` 干净。Task 4 的 `search.fetch.test.ts` 未动，`DeepSearchState` 未提前加。
  实现者报 DONE_WITH_CONCERNS（测试字面量绑定为 `ApiMount` 常量以绕开 TS2353 多余属性检查）：
  核实为忠实修正 —— 值相同、断言相同，仅把对象字面量绑成有类型的常量。计划文本已同步。
  计划偏差（已接受）：上述 TS2353 一处（与 Task 4 同类的「字面量传给窄形参」笔误）。
  **重要：一次 controller 自伤**。Task 5 的评审员报了两条 Important（`parentKey` 在挂载根应返 `''`
  而非 `/`；应有 `pageCount` 且空列表返 0），判 `Needs fixes` —— 但这两条**都是我派发时把约束抄错了**
  （凭空写的，任何已批准产物里都没有）。查证权威文本：设计 spec:159 明确 `/a/b/c → /a/b；/a → /`，
  计划 1412-1418 断言 `parentKey('/') === '/'`；计划的 `pageSlice` 签名为 `{items,page,totalPages}`
  （1571-1579，`Math.max(1, …)`），1445-1447 显式钉住空列表 `totalPages: 1`，且 Task 7 消费的正是这个
  签名（1834、1931-1946）。即实现与设计/计划完全一致，两条 Important 不成立。
  处置：未改任何代码；把更正后的约束回给**同一评审员**复核，其改判 spec ✅ / Approved，并确认
  Minor #3–#6 不变。教训：派发里的「全局约束」必须逐字摘自设计/计划，不能凭记忆复述。
  Minors（留给最终评审分诊）：
  - `spec.dest` 带尾斜杠会让归属静默失效：`mountVolumePath` 原样返回 `dest`（mounts.ts:44-46），
    于是 `matchesDest('/av/x', '/av/')` 为 false，该挂载的命中被丢掉。仅手工改 mounts 能造出；
    **与 usage 计划已记的同一条 Minor 同源**，两处一起看。
  - 「与列表顺序无关」只钉了一半：用例断言了 `[probe, photos]` 没有断言 `[photos, probe]`。
  - 等长 root 平局按列表顺序裁决（`search.ts:46` 用严格 `>`）：两个挂载 `dest` 相同时先列出的赢。
    退化输入，但这是「顺序无关」唯一不严格成立的地方。
  - `pageSize <= 0` 的回退分支与 `wanted || 1` 的冗余（已被 `Math.max(1, …)` 覆盖）无测试，纯装饰。
Task 5: complete (commits dc631f2..4d2e844, review clean after 1 fix round — spec ✅, quality Approved)
  计划偏差：brief 的组件片段缺了任务约束自身要求的 Escape 关闭、遮罩关闭、卸载/竞态安全，
  实现者补上了；计划文本已同步。
  Important fixed: `initialPath` 回退把「真实失败」与「响应被更新请求取代」混为一谈（load 返回 bool），
  会在初始加载期间点击盘符/面包屑时静默丢弃用户的点击，并在卸载后 setState + 多发一次请求。
  修法：load 改三态 'ok'|'failed'|'stale'，回退仅 'failed'；load 入口加存活检查；effect 加 active 取消标志。
  复核确认两个场景都关闭，且「初始路径无效 → 回退盘符列表」的行为保留。
  注：组件交互无自动化覆盖（仓库 vitest 为 node 环境且只 include *.test.ts，既定约束）；
  本次修复的验证是 tsc --noEmit + 全量 82 例回归 + 代码审阅，属已知无执行验证的部分。
  Minors（留给最终评审分诊）：
  - 加载中导航栏仍显示上一个目录（`path &&` 未按 loading 门控）；给按钮加 disabled={loading} 可缩小点击窗口。
  - 盘符高亮用前缀匹配（:88），若一个盘符串是另一个的前缀会高亮错；当前 `C:\` 形状不会触发。
  - 无焦点管理，Escape 是 window 级监听 —— Task 6 需确认嵌套进 NewMountModal 后同一次 Escape/遮罩点击不会两边都关。
Task 6: complete (commits 4d2e844..a493b96, review clean — spec ✅, quality Approved)
  注：手工验证（brief Step 6）无法执行，无可交互运行环境。Escape/遮罩嵌套风险经查不存在
  （NewMountModal 既无 keydown 监听也无遮罩 onClick，外层 overlay 无 onClick）。
  Minors：重置时机是「打开时」而非「关闭时」（功能等价）；initialPath 在 health 回填前可能为 ''。

Final review (整支, base 38b11b1~1 → a493b96, 9 commits, 12 files, +989/-25):
  Ready to merge? **With fixes**。无 Critical。
  Strengths：`#`/`%`/空格/CJK 的往返经 JuiceFS 自身 `url.Parse`+`u.Path` 链路独立验证；
  反向映射刻意不覆盖 /host 是正确的；browse 越界防护三层失败关闭；前后端类型逐字段对齐；
  `parent == ""` 两侧语义一致；go 与 web 两套测试均通过。
  Important 1（待用户决策）：`entries[].mtime` 每项都 `Info()` 取回并返回 JSON，
  但前端只渲染 `e.name`，全仓库无消费者 —— 付出的 stat 代价没有换来用户可见价值。
  spec 是用户明确要求「保留 mtime」，但 spec 的前端章节从未提到要显示它。属规格缺口。
  Important 2（无需用户决策，可修）：唯一的安全回归测试在 Windows 上 skip，
  本平台从未真正执行过 EvalSymlinks 守卫。建议加 `cmd /c mklink /J` 变体（无需权限）。
  Reviewer 明确判断：不是合并阻塞项，但在被描述为「已证明」之前需在真实环境确认一次。
  Minor 分诊：无 must-fix-before-merge。Follow-up：DetectHostDrives 注释 `C:\\`、
  `Z:\nope` 用例注释与断言不符、所有错误→400 且 405 缺 Allow、`ok ?? true` 失败方向、
  `path=''` 未断言 URL、导航未按 loading/error 门控、FOYER_HOST_MOUNT_BASE 未写入 compose/README、
  json 错误体测试未模拟真实 http.Error 文本、手工冒烟测试未做。
  Fine as-is：slashTrim("/")、Windows 绝对 base、TOCTOU（:ro 绑定）、错误串 wording、
  前导空格目录名、盘符高亮前缀匹配、无焦点管理、重置时机、空 initialPath、组件无 DOM 测试。
  建议：考虑把 8092 收紧为 127.0.0.1:8092（设计已显式延后）。

---

# SDD ledger — juicefs distro（已完成，历史保留）

Branch: main (working in place; user asked to execute, no isolated worktree)
HEAD at start: bb546cd584e42ba5bf8281e21b18af28620bb42a
Commits: disabled unless user asks (parent repo git rule).

## Tasks

Task 1: complete (working tree gitlink 30190ca, review clean; no commit). Note: `git submodule add -b v1.3.0` fails because v1.3.0 is a tag.
Task 2: complete (no commit, review clean). Minors: RedactMetaURL %2A workaround; default table not fully asserted.
Task 3: complete (no commit, review clean). Minors: argv tests loose; Env replaces whole environ.
Task 4: complete (no commit, review clean). Note: server/foyer.exe is a local build artifact.
Task 5: complete (no commit; overlay matches brief; FastDFS test PASS). Controller spot-checked fastdfs.go + apply script.
Task 7: complete (aws put/get hello via s3://foyer; README section).
Final review: no Critical. Important fixed: redis volume+AOF, admin Fatal, .dockerignore, submodule overlay dirt, hello leftovers.
Tests: go test ./internal/foyer PASS.

---

# SDD ledger — 跨文件夹深度关键词检索

Plan: docs/superpowers/plans/2026-09-19-deep-search.md
Spec: docs/superpowers/specs/2026-09-19-deep-search-design.md
Branch: feat/foyer-mount-lifecycle-import（非 main，可直接在工作树实现）
BASE at start: 802fb26

预检（controller）：
- 脏工作树里的在途 `unflag` 特性按用户决定单独提交为 c511ee6（干净基线），以免被 Task 1 的
  `git add scripts/apply-juicefs-overlay.*` 卷进提交与评审 diff。容器内已验证 13/13 PASS。
- 计划预检发现并已修（提交 802fb26）两处实现级缺陷：`find.go` 有个未使用的 `fmt` import
  （Go 编译直接失败）；符号链接用例的第二条断言不可达且无鉴别力（其子条目名不含关键词，
  跟随与否都只命中 1 条）。已改为子条目名含关键词 + 断言 `scanned == 1`。
- overlay 测试环境**已验证可用**：Docker golang:1.23-bookworm + gcc + libfuse3-dev，
  挂 foyer-gomodcache/foyer-gocache 两个卷，含 apt-get 约 106s。
- 未决：终端 12 正在跑 run-foyer.ps1（用户选择让它跑完，Task 8 再重建镜像时验证）。
- 遗留 FYI：`datas/第五章 技术需求书.docx` 处于「已删除未提交」状态（用户未答复是否误删）。

## Tasks

Task 1: complete (commits 802fb26..8c05f88, review clean — spec ✅, quality Approved)
  overlay `juicefs find`：BFS 遍历 + `matchName` + `dirReader` 接缝；两份 apply 脚本注册 `cmdFind`。
  9/9 定向用例 PASS（Docker，golang:1.23-bookworm）；`juicefs find --help` 退出 0 证明注册生效；
  实现者另外验证了 .sh 路径。overlay 更大定向集 32/32。
  reviewer ⚠️ 两项由 controller 关闭，均非缺口：
    ① `FOYER_SEARCH_MAX_RESULTS` 不在 overlay 里读是**设计如此**——overlay 只暴露 `--limit`，
       由 Task 3 把该配置当 `--limit` 透传；
    ② server 侧 `parseJSONLine` 消费者是 Task 2 的范围，本任务只负责输出形状，且键名已被
       `TestSearchResultJSONKeysAreStable` 逐个钉住。
  计划偏差（已接受）：brief 的 `TestWalkFindSkipsDotAndDotDot` 自相矛盾——关键词 "." 配 fixture
    "a.dng" 在子串语义下必然命中，却断言 0 命中。实现者按原意最小修正：该 fixture 改名 "notes"，
    断言不放宽、`scanned == 2` 不变。计划文本已同步（commit 见下）。
  Minors（留给最终评审分诊）：
  - `--name ""` 只要 flag 出现即通过（cli 的 `Required` 只管存在性），空关键词会匹配全部条目 →
    整卷遍历。设计文档写的是「`--name` 必填；空值报错」，实现没做这层。HTTP 路径不受影响
    （Task 3 对空 `q` 返 400），仅直接 CLI 调用可触发。
  - `Truncated` 在命中数恰好等于 limit 时就置真，即使其后已无命中可找。与设计文档「命中数达到 N
    时置 truncated=true 并停止」字面一致，属过度报告（纯展示问题）。
  - `[regex]::Replace($m,$pat,$repl,1)` 的第 4 个参数不是「替换次数」：PowerShell 把它绑成
    RegexOptions.IgnoreCase（reviewer 实测 `[regex]::Replace('aA aA','a','X',1)` → `'XX XX'`），
    即替换全部而非一次。既有 4 处 + 本任务新增 1 处都这么写；因为每个 hook site 唯一且有
    `$m2 -eq $m` 守卫兜底，无害。真要限定一次应写 `([regex]$pat).Replace($m,$repl,1)`。
  - 未覆盖（brief 也未要求）：多个 PATH 根的 break-on-limit 路径；根 `lookupPathAttr` 失败的
    `errors` 记账。
  - 整包 `go test ./cmd/` 有既存红灯（有用例拨 redis://127.0.0.1:6379/11），与本任务无关；
    定向集干净。
  - 计划文档 fixture 矛盾已修（controller）：见下一条 commit。
Task 2: complete (commit 3fae3d5, review clean — spec ✅, quality Approved)
  `search.go`：`SearchArgs`/`Runner.Search`/`parseSearch`/`BuildSearchResponse` +
  `SearchResult`/`SearchMatch`/`SearchFailure`/`SearchResponse`。`exec_test.go` 的 fake juicefs
  两个 GOOS 分支都加了 `find`。7/7 定向用例 PASS，go vet 与 gofmt 干净。
  reviewer 独立核对 JSON 键名与已提交的生产者 `overlays/juicefs/cmd/find.go` 逐字符一致（含
  `errors,omitempty` 的「缺席 vs 空数组」契约，且刻意只归一化 `matches`、不碰 `errors`）。
  计划偏差（已接受）：brief 的 Windows `case "find"` 片段用了反引号 raw string，但它是内联进
  `writeFakeJuiceGo` 的 ``src := `package main...``` 里的——嵌套反引号会提前终止外层 raw string，
  整个文件编译不过。实现者改用转义双引号字符串（与既有 import/stat/usage 三个 case 同形）。
  计划文本已同步。
  reviewer ⚠️ 一项由 controller 关闭：POSIX sh 分支在 Windows 上跑不到。已用真 Linux 容器执行
  `go test ./internal/foyer/`（go.mod `go 1.25.0` + GOTOOLCHAIN=auto）→ **7/7 PASS**，其中
  `TestRunnerSearchParsesFakeBin` 正是走 POSIX sh 分支的那条，属执行验证而非推演。
  Minors（留给最终评审分诊）：
  - 两个 fake 分支都忽略 `os.Args`，所以 `TestRunnerSearchParsesFakeBin` 即使 `Runner.Search`
    不再转发 keyword/root 也照样绿；argv 的正确性靠 `TestSearchArgsDefaultsRootAndOmitsZeroLimit` 兜住。
  - `Runner.Search` 原样转发空 keyword（空串在 overlay 侧 `strings.Contains(name,"")` 恒真）——
    属 Task 3 handler 的校验职责（对空 `q` 返 400），本任务不越界。
  - Go 的 `omitempty` 对「零长切片」与「nil」一视同仁，理论上生产者若发 `"errors":[]` 重编码会变成
    键缺席；已提交的生产者从不发 `[]`（只 append），当前无实际影响。
Task 3: complete (commit 6e73688, review clean — spec ✅, quality Approved)
  `health.go` 插入 `GET /foyer/search`（405+Allow / 400 空 q（走 http.Error，与 /foyer/stat 同形）/
  502 runner 失败 / 200 writeJSON）；`config.go` 加 `Config.SearchMaxResults` + `envUint64`；
  `deploy/compose.yml` 加 `${FOYER_SEARCH_MAX_RESULTS:-0}`。4 个新 handler 用例，包内 11/11，
  `go test ./...` 全绿，go vet + gofmt 干净。既有 7 个 Task 2 用例未动。
  reviewer 两个具名风险均已核实：① 路由确实注册在 `NewHealthMux` 内部（health.go:128），
  闭包捕获的是函数局部 `run`/`cfg`，不是包级符号；② `envUint64` 全包只此一处声明，
  空串/空白串/负数/非数字/溢出都回退默认值，无 panic 路径。
  关键契约在**路由边界**被端到端断言（不是只在单测里）：干净结果序列化后 `errors` 键必须缺席，
  用 `map[string]json.RawMessage` 直接检查键的存在性。
  计划偏差：无。gofmt 因 `SearchMaxResults` 成为最长键而重排了整个 `LoadConfig` 字面量
  （config.go 显示 56 行变更但语义增量很小），属格式后果，非实现偏差。
  reviewer ⚠️ 一项由 controller 关闭：`path` 缺省收敛成 `/` 发生在 Task 2 的 `SearchArgs`（本任务
  diff 里看不到），已由 Task 2 的 `TestSearchArgsDefaultsRootAndOmitsZeroLimit` 钉住并在其评审中核实。
  Minors（留给最终评审分诊）：
  - `envUint64` 无单测：空/纯空白/负数/非数字/溢出的分支行为只在报告里推理，未落为断言。
    brief 也未要求。建议补一个表驱动用例钉住「坏配置不 panic」。
  - 上限链路无端到端覆盖：4 个路由用例都用 `Config{}`（`SearchMaxResults == 0`），所以
    `envUint64 → cfg.SearchMaxResults → run.Search(..., cfg.SearchMaxResults)` 这条缝从未以非零值跑过。
    Task 2 覆盖了 limit 的格式化，缺的是「配置→handler」这一跳（仅一行透传）。
Task 4: complete (commit 5641dbd, review clean — spec ✅, quality Approved)
  `jfs.foyerSearch`（URLSearchParams 拼 query；`path` trim 后为空则**不下发**该参数）+
  `FoyerSearchMatch`/`FoyerSearchFailure`/`FoyerSearchResult` 类型 + `client.searchFiles` 包装。
  5 个新用例，web 全量 118/118，`tsc --noEmit` 干净。既有文件未动。
  reviewer 两个具名风险均已核实：① 类型与已提交的服务端 JSON 逐字段一致（含 `errors` 可选性，
    且刻意不把 `ok` 也建模进去）；② 新测试文件的 fetch 打桩写法与仓库既有惯例相同。
  ⚠️ 修正：我在派发里指错了参照文件 —— `jfs.test.ts` 其实不含 fetch 打桩，真正的惯例在
    `browse.test.ts` / `hostDir.test.ts`（`vi.stubGlobal('fetch', ...)` + `afterEach(unstubAllGlobals)`）。
    reviewer 自己找到了正确的参照并确认新文件同形。
  reviewer ⚠️ 一项由 controller 关闭：`client.searchFiles` 只透传 `(keyword, path?)`，不暴露
    `caseSensitive`。这与设计一致 —— 设计的前端数据流本来就直调 `jfs.foyerSearch(keyword, path)`，
    UI 也没有大小写开关。非缺口。
  Minors（留给最终评审分诊）：
  - `errors` 键本身无测试：既没断言「缺席时为 undefined（不是 []）」，也没断言「存在时原样透传」。
    全局约束专门点了这个键，两行断言就能锁定。
  - `search.fetch.test.ts` 的「抛 ApiError」用例只断言 message（与既有 browse.test.ts 同惯例），
    没有 `toBeInstanceOf(ApiError)` —— 少了真正验证「复用既有类」的那半句。
  - `client.searchFiles` 把 `path` 默认成 `'/'`，所以无路径调用总是发 `path=%2F`，而
    `jfs.foyerSearch` 是省略该参数。在 Task 3 契约下两者等价（`path=/` 有用例覆盖），仅信息性。
Task 5: complete (commit 1a78ac4, review clean after 1 reconciliation — spec ✅, quality Approved)
  `web/src/api/search.ts`（6 个导出：`SEARCH_PAGE_SIZE`、`mountRoot`、`matchesDest`、`attributeMatches`、
  `parentKey`、`pageSlice`）+ `types.ts` 加 `SearchHit`。15 个新用例，web 全量 133/133，
  `tsc --noEmit` 干净。Task 4 的 `search.fetch.test.ts` 未动，`DeepSearchState` 未提前加。
  实现者报 DONE_WITH_CONCERNS（测试字面量绑定为 `ApiMount` 常量以绕开 TS2353 多余属性检查）：
  核实为忠实修正 —— 值相同、断言相同，仅把对象字面量绑成有类型的常量。计划文本已同步。
  计划偏差（已接受）：上述 TS2353 一处（与 Task 4 同类的「字面量传给窄形参」笔误）。
  **重要：一次 controller 自伤**。Task 5 的评审员报了两条 Important（`parentKey` 在挂载根应返 `''`
  而非 `/`；应有 `pageCount` 且空列表返 0），判 `Needs fixes` —— 但这两条**都是我派发时把约束抄错了**
  （凭空写的，任何已批准产物里都没有）。查证权威文本：设计 spec:159 明确 `/a/b/c → /a/b；/a → /`，
  计划 1412-1418 断言 `parentKey('/') === '/'`；计划的 `pageSlice` 签名为 `{items,page,totalPages}`
  （1571-1579，`Math.max(1, …)`），1445-1447 显式钉住空列表 `totalPages: 1`，且 Task 7 消费的正是这个
  签名（1834、1931-1946）。即实现与设计/计划完全一致，两条 Important 不成立。
  处置：未改任何代码；把更正后的约束回给**同一评审员**复核，其改判 spec ✅ / Approved，并确认
  Minor #3–#6 不变。教训：派发里的「全局约束」必须逐字摘自设计/计划，不能凭记忆复述。
  Minors（留给最终评审分诊）：
  - `spec.dest` 带尾斜杠会让归属静默失效：`mountVolumePath` 原样返回 `dest`（mounts.ts:44-46），
    于是 `matchesDest('/av/x', '/av/')` 为 false，该挂载的命中被丢掉。仅手工改 mounts 能造出；
    **与 usage 计划已记的同一条 Minor 同源**，两处一起看。
  - 「与列表顺序无关」只钉了一半：用例断言了 `[probe, photos]` 没有断言 `[photos, probe]`。
  - 等长 root 平局按列表顺序裁决（`search.ts:46` 用严格 `>`）：两个挂载 `dest` 相同时先列出的赢。
    退化输入，但这是「顺序无关」唯一不严格成立的地方。
  - `pageSize <= 0` 的回退分支与 `wanted || 1` 的冗余（已被 `Math.max(1, …)` 覆盖）无测试，纯装饰。
Task 6: complete (commits 48aff1a + 1874489, review clean after 1 fix round — spec ✅, quality Approved)
  `types.ts` 加 `DeepSearchState`；`FileStoreContext.tsx` 加 `deepSearch` 状态与
  `runDeepSearch`/`exitDeepSearch`/`setDeepSearchPage`/`revealHit`、provider value 接线、`logout` 清理。
  `tsc --noEmit` 干净，web 全量 133/133 无回归。context 层无 DOM 测试设施，属**无法执行验证**的层。
  跨任务缺口（controller 发现并修计划）：计划原先把 `DeepSearchState` 划给 Task 5，但我在派发 Task 5 时
    错误地口头要求「只加 SearchHit，DeepSearchState 是 Task 6 的」——于是该类型全仓库无人定义，
    Task 6 会因 import 失败而编译不过。已把定义连同 `web/src/types.ts` 一起移入 Task 6 的文件清单与 Step 1。
  修正轮 1（实现者自报 → controller 确认为**真 bug** 后派发）：
    `revealHit` 调 `navigateTo(mount, parentKey(key))`，若目标目录**就是用户当前所在目录**，
    `setCurrentMount`/`setCurrentPath` 拿到的值与现状相同 → React bail out → 驱动 `refreshDirectory`
    的 effect（deps `[isAuthenticated, currentMount, currentPath, refreshDirectory]`）不再跑 →
    揭示永不被消费，点命中只退出检索视图、什么都不选中。检索本身不改当前目录，所以「停在命中所在
    目录再检索」是常规路径而非边角。修法：`revealTick` 计数强制一次渲染 + 独立揭示 effect；
    `nodesOwnerRef` 记录产出当前 `nodes` 的那次请求属于哪个目录，从而**保住**原闭包守卫语义
    （在途旧目录请求不能用同名 key 提前吃掉）。计划文本已按实现重写。
  reviewer 独立逐态推演了四个场景（改目录 / 同目录 bail-out / 在途旧请求 / 早退与重置），
    确认揭示「恰好消费一次」或「不消费」，无一错误；并核对了 provider value 与接口逐字段对齐、
    `setNodes` 全部调用点上 `nodesOwnerRef` 与 `nodes` 同层的不变量成立。实现者自报的修复与
    reviewer 的独立推演一致。
  Minors（留给最终评审分诊）：
  - `pendingReveal` 只在「成功消费 / 显式退出 / 新揭示 / 登出」时清空。若目标目录**加载失败**
    （refreshDirectory 的 catch）或目标 key 不在 entries 里，揭示会保持上膛，可能在日后某次
    访问同一 mount/parent 时触发。目录正常都含该命中，影响低；在失败路径清空可封住生命周期。
  - 重置不对称：`!mountName` 早退分支会把 `nodesOwnerRef` 置 null，但 `!mountObj` 分支既不改
    `nodes` 也不改 owner，留下陈旧 owner。今天不会造成揭示 bug，但对下一个读者是一处不一致。
  - `runDeepSearch` 无请求序号/取消：连续两次提交可能乱序返回，旧响应覆盖新的。brief 未要求；
    若 UI 在 loading 时禁用提交则基本不会发生，但 context 层没有护栏。
  - 既存（非本任务引入）：`refreshDirectory` 没有请求版本号，慢的旧目录响应可能覆盖 `nodes`，
    进而让 remap 丢掉已经揭示好的选中。留给整支评审。
Task 7: complete (commits 15de794 + 6949441, review clean after 1 fix round — spec ✅, quality Approved)
  `SearchResults.tsx`（新，无 props，读 `deepSearch`/`setDeepSearchPage`/`exitDeepSearch`/`revealHit`，
  `pageSlice` 客户端分页，loading/error/empty/truncated 四态 + 表格 + 上一页/下一页）；
  `FileExplorer.tsx` 六处定点改：导入结果视图、解构 deepSearch/runDeepSearch/exitDeepSearch、
  `handleDrop` 结果视图直接返回、工具条左侧切「命中 N 项 · 已扫描 M 项」、搜索框改 `<form>`
  （回车触发 `runDeepSearch`，✕ 兼 `exitDeepSearch`）、列表区域按 `deepSearch.active` 切换。
  `tsc --noEmit` 干净，web 全量 133/133 无回归。
  reviewer 确认两条自报 concern：① Step 4 grep 的两条命中是**说明性注释**（`capacity.ts:5`、
    `capacity.test.ts:12`，基线 945c9d1 即存在），非假数据，无需处理（计划文本已同步纠正期望）；
    ② `handleDragOver` 在结果视图仍会给拖放高亮 —— **真缺口**（假示能：高亮承诺了一次
    `handleDrop` 早已拦掉的上传）。修法：`handleDragOver` 在翻 `isDragging` 前加同一条
    `deepSearch.active` 守卫，`handleDragLeave` 不动。复核：`tsc` 干净、133/133、代码已读。
  ⚠️ 组件层仍**无法执行验证**（vitest node 环境 + 只 include `*.test.ts`，无 DOM 设施）；
  上述结论来自 tsc + 阅读，未在浏览器跑过。Task 8 的浏览器实测是唯一能看见真实渲染的机会。
  Minors（留给最终评审分诊）：
  - `SearchResults` 的「跳转」按钮不区分「已在目标目录」，靠 Task 6 的 `revealTick` 兜住；
    组件自身无 disable/loading 态。
  - 分页切页不重置滚动位置（结果区不滚动，影响低）。
Task 8: complete with one unverifiable item (commit b0d947f 之后，本任务只改文档)
  重建镜像后实测。**先确认镜像真的重建**（上一轮用量任务踩过的坑）：源文件最后提交 22:25:59 < 镜像
  构建 22:30:10；`juicefs find --help` 退出 0；`grep -ac 'foyer/search' /usr/local/bin/foyer` = 2
  （旧镜像 0）。juicefs `1.3.0+unknown`。
  Step 2（CLI，含 flag 重排）：`--name host` → 2 条、`scanned 2502`、`truncated false`；
    `--limit 1` → 1 条、`truncated true`、`scanned 3`（批量 Readdir + 命中处提前退出，「已访问」非全量）；
    `--name HOST --case-sensitive` → 0 条（不敏感时 2 条），大小写开关生效。
  Step 3（端点）：`q=host` 200 且 `errors` 键**缺席**；`q=%23` 200 且读出 5 条含 `#` 的路径（query 未被
    截断）；无 `q` → 400。
  Step 4：`scanned 2502` vs 卷级 `used_inodes 3323`，同量级（回收站/根/`.`/`..` 不计）；另按前端
    `listMounts` 的形状带 `path` 再取一次，`summaries[].path` 与各挂载 `spec.dest` 逐字一致
    （`/host`、`/dtest2`、`/av_20260619`），即 `attributeMatches` 的输入契约成立。
  补充（替代不了浏览器）：用真实控制面输出喂真实的 `foyerSearch`+`mergeMounts`+`attributeMatches`
    /`parentKey`/`pageSlice`（`npx tsx` 一次性脚本，跑完即删）。`host` 2 命中→2 归到 host 挂载；
    `#` 5 命中→4 归 `foyer`（卷内孤立目录兜底）+1 归 `av_20260619`，且 `/20260619/#整理完成` **未**被
    误归 `/av_20260619`（段边界生效）；空结果 `totalPages 1`；越界页夹紧；空 `q` → `ApiError` 400
    `q required`。**关键订正**：`mergeMounts` 把隐式卷挂载插到首位是「孤立命中落到 `/`」成立的前提，
    单喂 `/foyer/mounts` 原始列表会让这批命中被静默丢弃（我的第一版探针就复现了这一点）。
  ⚠️ **未验证**：Step 5 的全部渲染断言（结果视图切换/分页/跳转选中/拖放无高亮/返回目录）**没有执行过** ——
    本会话无任何浏览器类工具，仓库 vitest 是 node 环境无 DOM 设施。vite dev 已在
    `http://localhost:3000` 运行（200，`/foyer`→8092 代理生效），已在计划里留了一份 7 步人工核对清单
    （含「停在目标目录再跳转」这条最容易复现 bug 的场景）。
  观察（非缺陷）：卷内存在上一轮导入实验留下的孤立目录（`/20260619/#整理完成`、`/gav/#整理完成`），
    无对应 dest，按设计落卷挂载 `foyer`；`/foyer/usage` 不带 `path` 时 `summaries` 恒为 `[]`（按设计）。

Final review (整支, base 802fb26 → 9dd3191, 17 commits, 评审包 `.superpowers/sdd/search-final-review.diff`):
  Ready to merge? **With fixes** → 两项均在本轮关闭。无 Critical。
  Strengths：overlay 的 `.`/`..`/回收站/symlink 三处跳过都有鉴别力测试（symlink 用例特意在链接下种了
  含关键词的子项，并靠 EIO-on-second-visit 把「漏跳」变成明确失败而不是挂住）；JSON 契约在**生产者**与
  **HTTP 边界**两侧分别钉住（含 `errors` 的「缺席 vs 空数组」）；前端纯函数在段边界/最长前缀/卷挂载兜底
  上正确，且 reviewer 独立核对 `mergeMounts` 总会插入隐式卷挂载、`mapMount` 保留 `spec.dest`，证明 `/`
  兜底在真实数据路径上成立（与我在 Task 8 探针里踩到并订正的那点一致）；揭示机制的两个守卫与
  `revealTick` 经逐态推演无误；`handleDragOver` 去高亮是真修而非美化。测试：Go `ok`、web 133/133、
  `tsc`/`vet` 干净。
  Important 1（**已修**，commit `9dd3191`）：`pendingReveal` 在「目标目录已加载、但本层 `nodes` 里没有
    该 key」时永不清空 → 日后手动进入同一路径会被自动选中，违反 spec 的「避免悬挂」。
    ⚠️ 但计划文本（controller 自己写的，任务 6 Step 3）**明文要求「`!hit` 时故意不清空」**，与 spec
    直接冲突 —— 按流程这属计划级矛盾，**交用户裁决**而非自行修。
    查证计划当年的理由成立且**可达**：`listPrefix`（`web/src/api/jfs.ts:133-173`）只发一次
    `ListObjectsV2`、没有 continuation-token 循环 ⇒ 单目录列表上限 1000 条，而本卷 `/av_20260619` 已
    800 条（578 文件 + 222 目录）⇒ 目标层未命中不能推出「目标已不在」，清空会让跳转静默失效。
    用户裁决：**折中（限定生命周期）** —— 目标层未命中时继续上膛（容忍截断列表），但用户一旦导航离开
    目标目录即清空。实现：新增封口 effect（`FileStoreContext.tsx:343-353`，deps `[currentMount,
    currentPath]`），声明在消费 effect 之后（同一次 commit 内消费先跑）；消费 effect 与 `!hit` 早退
    **未动**。计划 Task 6 Step 3 与 spec:170 已同步改写为「限定生命周期」口径（三方一致）。
    ⚠️ 此改动**无自动化覆盖**（context 层无 DOM 设施）：结论来自 `tsc --noEmit` + 阅读 + 四序列推演。
  Important 2（用户决定**跳过**，如实收尾）：交互/渲染层（`SearchResults` 渲染、`FileExplorer` 列表区域
    切换、跳转选中、拖放去高亮、返回目录）**从未执行过**：本会话无任何浏览器类工具，仓库 vitest 为
    node 环境且只 include `*.test.ts`。计划里已留 7 步人工核对清单，用户选择不跑。
  Minors 分诊：reviewer 判定 **must-fix-before-merge 为零**，全部为后续项。分组：
    - 缺覆盖三处：`envUint64` 无单测、`Config.SearchMaxResults → run.Search` 这一跳从未以非零值跑过、
      前端 `errors` 键无断言。
    - 空 `--name` 未拒（spec 字面偏差「空值报错」，`cli.Required` 只管存在性）：HTTP 侧已有 400 兜住，
      仅直接 CLI 调用可触发，但会整卷遍历并匹配全部条目。
    - `truncated` 在命中数恰等于 limit 时过度上报（设计字面如此，纯展示）。
    - PowerShell `[regex]::Replace($m,$pat,$repl,1)` 第 4 参数是 `RegexOptions.IgnoreCase` 而非次数
      （替换全部）；`.sh` 侧用的是 `re.subn(count=1)`，**两个脚本行为其实不同**，靠 hook site 唯一 + 守卫兜住。
    - `errors` 服务端与 `foyerSearch` 都透传了，但**没有任何 UI 读它**：子树读取失败时用户只看到
      `scanned` 偏小，没有「N 个子目录读取失败」提示。
    - 等长 dest 平局按列表顺序裁决；`runDeepSearch` 无请求序号（连点两次可能旧响应覆盖新的）。
    - 既存（非本次引入）：`refreshDirectory` 无请求版本号，慢的旧响应可能覆盖 `nodes` 并丢掉已揭示的选中。
    - UI 打磨：跳转按钮在「已在目标目录」时无 disabled/loading；翻页不复位滚动位置。
    - `PATH=/.trash` 作为根可绕过回收站跳过（只过滤枚举出的条目，不过滤根本身）；前端永远用 `/`，不可达。