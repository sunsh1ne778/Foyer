# 挂载本地目录时选择目录 设计

日期：2026-09-19
状态：已确认（2026-09-19）

## 问题

「新增存储挂载」选 `Local / NAS` 后，「宿主机目录」只能**手填**绝对路径（`web/src/components/NewMountModal.tsx` 的 `localRoot`）。手填易错：盘符大小写、中文目录名、路径里的 `#` 等特殊字符，任何一个笔误都会让导入落到错误位置——`#` 那次的教训已经证明了代价（路径被截断到父目录，且已导入的内容不会自动回滚）。

需要提供「选目录」而不是「猜目录」。

## 约束：为什么不能调系统原生文件夹对话框

这不是实现偏好，是硬约束：

1. `foyer` 控制面跑在**容器**里（`deploy/compose.yml` 的 `foyer` 服务），宿主机盘符是以只读方式绑定进容器的：`G:/` → `/mnt/g`（`scripts/gen-host-drives.ps1`）。
2. 浏览器的 File System Access API（`showDirectoryPicker()`）返回的是**浏览器内部句柄**，不暴露真实宿主机路径，也无法序列化后传给后端。选完拿不到 `G:\...` 这样的字符串。

因此**不存在**「Web 端调起系统文件夹对话框并拿到路径」的可行路径。目录选择器必须由应用自己实现：后端负责列目录，前端负责呈现。

> 若将来确实要原生对话框，只能把 Web UI 换成 Electron/Tauri 桌面壳。本设计明确不做。

## 方案总览

保留手填，新增浏览。输入框不动（仍可手填/粘贴），右侧加「浏览…」按钮，点开应用内目录选择器，选完把**宿主机形式**路径回填到输入框。

| 单元 | 职责 | 依赖 |
|---|---|---|
| `server/internal/foyer/browse.go` | `Browse(cfg, hostPath)`：列子目录、算 parent、给盘符列表 | `path.go` |
| `server/internal/foyer/path.go` | 新增反向映射 `HostPathFromContainer`；`DetectHostDrives` 支持传入 base | 无 |
| `server/internal/foyer/health.go` | 新增路由 `GET /foyer/browse` | 上列 |
| `server/internal/foyer/config.go` | 新增 `HostMountBase`（`FOYER_HOST_MOUNT_BASE`，默认 `/mnt`） | 无 |
| `web/src/api/jfs.ts` | `foyerBrowse(path?)` + 类型 | `ApiError` |
| `web/src/components/DirectoryPicker.tsx` | 选择器弹窗，单一路径状态 | 上列 |
| `web/src/components/NewMountModal.tsx` | 「浏览…」按钮 + 回填 | 上列 |

## 后端：`GET /foyer/browse`

### 请求

```
GET /foyer/browse                       # 只取盘符列表
GET /foyer/browse?path=G:\20260619\#整理完成
```

`path` 是**宿主机形式**（与 `spec.root` 同语义），不是容器路径。前端必须用 `URLSearchParams` 构造 query，使 `#` 编码为 `%23`——否则会被当成 fragment 吃掉，重演同类截断。

### 响应

```json
{
  "ok": true,
  "path": "G:\\20260619\\#整理完成",
  "parent": "G:\\20260619",
  "drives": ["C:\\", "G:\\"],
  "entries": [
    { "name": "已归档", "path": "G:\\20260619\\#整理完成\\已归档", "mtime": "2026-06-19T02:00:00.000Z" }
  ]
}
```

盘符列表层级（`path` 省略时）：

```json
{ "ok": true, "path": "", "parent": "", "drives": ["C:\\", "G:\\"], "entries": [] }
```

### 字段

| 字段 | 说明 |
|---|---|
| `path` | 当前目录的宿主机路径；盘符列表层级为 `""` |
| `parent` | 上级的宿主机路径；`""` 表示「上级是盘符列表」（盘符根即为 `""`） |
| `drives` | 已绑定的盘符，形如 `G:\`，复用 `DetectHostDrives` |
| `entries` | 当前目录的**子目录**，非递归 |
| `entries[].name` | 目录名 |
| `entries[].path` | 该子目录的宿主机完整路径，前端直接使用（前端不做路径拼接） |
| `entries[].mtime` | ISO-8601 UTC，best-effort；取不到则省略。用于同名目录消歧 |

### 规则

- **只列目录**。文件不出现在结果里。
- **跳过符号链接 / junction**。`DirEntry.IsDir()` 在大多数平台上已排除链接，仍显式检查 `ModeSymlink`：链接可能指向允许根之外，跟随会让「限制在已绑定盘符内」的约束失效。
- 排序：按 `name` 大小写不敏感升序，同名保持稳定顺序，保证同一目录重复请求结果一致。
- `entries[].path` 由反向映射生成，不由前端拼接——避免分隔符与特殊字符处理出现两套实现。

### 越界防护（必须有）

`MapHostPath` 对 `/etc/passwd` 这类输入会**原样放行**（`cfg.HostData` 为空且输入以 `/` 开头时直接 `path.Clean` 返回），所以只靠 `MapHostPath` 拦不住。`Browse` 必须在读目录前自己校验：

1. `MapHostPath(cfg, path)` 得到容器路径。
2. 容器路径必须落在**允许根**之内：`cfg.HostMountBase`（默认 `/mnt`）。否则 400。
3. 对目标做 `os.Lstat`，是符号链接则 400（避免通过链接跳出允许根）。
4. `path.Clean` 已折叠 `..`，`/mnt/g/../../etc` 会变成 `/etc` 并在第 2 步被拒。

> **为什么允许根只有一个。** `MapHostPath` 的盘符分支写在 `FOYER_HOST_DATA` 分支之前，所以 `E:\photos\raw` 一律映射到 `/mnt/e/photos/raw`——`/host` 那套只接非盘符路径（如 UNC），在选择器里根本不会出现。硬要支持它就得为 `/host` 单写一条反向映射，而那条反向映射产出的路径回喂 `MapHostPath` 会落到 `/mnt/...`，是个静默错误。因此选择器只支持**盘符绑定**；用户给 `/host` 下的路径会收到明确的 400，而不是拿到错误的目录列表。

### 错误

一律 400 + 纯文本消息（与现有 `/foyer/import` 的 `http.Error` 风格一致）：

| 场景 | 消息示例 |
|---|---|
| 盘符未绑定 | `drive X: is not mounted into the container; run scripts/run-foyer.ps1 to rebind` |
| 路径不存在 | `no such directory: G:\nope` |
| 目标是文件 | `not a directory: G:\a.txt` |
| 越界 | `path is outside the allowed root (/mnt)` |
| 无权限 | 透传 `os` 的错误文本 |

## 后端：反向映射 `HostPathFromContainer`

`MapHostPath` 盘符分支的逆运算，只覆盖盘符绑定：

| 容器路径 | 结果 |
|---|---|
| `/mnt/g` | `G:\` |
| `/mnt/g/20260619/#整理完成` | `G:\20260619\#整理完成` |
| `/mnt/d/photos/raw` | `D:\photos\raw` |
| `/mnt`（绑定根自身） | error |
| 其他 | error |

要求：`HostPathFromContainer(MapHostPath(p))` 对**盘符形式**的 `p` 是恒等（除尾斜杠规范化），这是回填值能被 `spec.root` 接受、并在 resync 时被 `MapHostPath` 还原的前提。必须有表驱动测试覆盖 `#`、中文、空格。

## 后端：可测试性改造

- `DetectHostDrives()` 改为 `DetectHostDrives(base string)`（唯一调用点是 `HealthJSON`，传 `cfg.HostMountBase`）。
- `Config` 新增 `HostMountBase`（env `FOYER_HOST_MOUNT_BASE`，默认 `/mnt`），让路由测试能指向 `t.TempDir()` 造假盘符，不必依赖容器环境。

## 前端：`DirectoryPicker.tsx`

交互（单击即进入，无「选中」态——当前目录即选中项）：

- 顶部：盘符 chips（`C:\` `G:\` …），点击跳到该盘根
- 面包屑：`G:\ › 20260619 › #整理完成`，每段可点击回跳；首段 `G:\` 回该盘根
- 「↑ 上级」：跳到 `parent`。当 `parent` 为 `""`（当前是盘符根）时，上级即盘符列表，跳到盘符列表。该按钮只在盘符列表层级禁用（此时没有上级）
- 主体：`entries` 列表，**单击即进入该目录**
- 底部：当前 `path` 只读展示 + `[取消] [选择此目录]`
- 「选择此目录」在盘符列表层级（`path === ""`）禁用
- 加载中显示 spinner；错误在弹窗内展示，不关闭
- 面包屑在盘符列表层级不显示（没有路径可拆）

状态只有 `path / entries / drives / parent / loading / error`，无选中集合。

打开时机：若输入框已有值，用它作为初始 `path`（后端校验失败则退回盘符列表）；为空则从盘符列表开始。

`NewMountModal.tsx` 改动限于：一个 `isPickerOpen` state、输入框旁的按钮、`onSelect` 回填 `setLocalRoot(p)` 并 `setPreview(null)`（路径变了，旧预检结果作废）。表单其余逻辑不动。

范围：本次**只覆盖新增挂载弹窗**；挂载管理里的编辑/重设来源目录入口留待后续。

## 测试

Go（`server/internal/foyer/`）：

- `HostPathFromContainer` 表驱动往返测试：盘符根、多级、`#`、中文、空格；`HostData` 形式；非法输入报错。
- `Browse` 单元测试（`t.TempDir()` 当假盘符 base）：只列目录不列文件、排序确定性、符号链接被跳过、`mtime` 可取到时输出 ISO 串、目录含大量子目录时全部返回（不设上限）。
- `Browse` 越界：`/etc`、`/mnt/g/../../etc`、指向外部目录的链接，均报错。
- 路由测试：`GET /foyer/browse` 无参返回盘符列表；带 `path` 返回 `entries`/`parent`；越界返回 400。

前端（vitest，node 环境，无 DOM）：

- `foyerBrowse` 的 URL 构造：`#` → `%23`、中文正确编码、无 `path` 时不带 query。
- 响应映射：缺 `entries` 字段时降级为空数组。

手工：对真实盘符打开选择器，选中 `G:\20260619\#整理完成`，确认回填值与预检结果正常，且导入的 `container` 是完整子目录而非父目录（即本次修复的回归场景）。

## 明确不做

- 系统原生文件夹对话框（不可行，见约束）。
- Electron/Tauri 桌面壳。
- 文件选择（只选目录）。
- 通过 browse 做任何写操作。
- 挂载管理页的编辑/重设来源目录入口（下一期）。
- 修改 `8092` 端口绑定——**刻意留白**，见风险。

## 风险

`/foyer/browse` 会暴露宿主机目录**名字**（只读，且限定在已绑定盘符内）。这与现有信任模型一致：`/foyer/import` 本来就接受任意宿主机路径并真的去读它。`deploy/compose.yml` 里 `8092:8092` 当前对外可达。本次不改绑定，评审时可决定是否收紧为 `127.0.0.1:8092:8092`。

## 已确认的决定

1. **不设条目上限**——`entries` 返回当前目录全部子目录。实现上仍应避免在无谓的地方重复 `Info()`。
2. **保留 `entries[].mtime`**——用 `DirEntry.Info()` 逐项取，可帮用户在大量同名目录里消歧。这是有意的性能取舍：Docker Desktop 的盘符绑定挂载上每项一次 stat，目录很大时会变慢。
3. **交互为单击即进入**（无「选中」态，当前目录即选中项）。
4. **本期只覆盖新增挂载弹窗**。
5. **不改 `8092` 端口绑定**——刻意留白，见风险。
