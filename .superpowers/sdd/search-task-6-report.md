# Task 6 报告：Context 接线 —— 检索状态与跳转选中

## Status

DONE_WITH_CONCERNS（实现与 brief 完全一致，仅记录一个由 brief 既定设计带来的边界行为）

## What I implemented

严格按 brief 的 Step 1–4 逐字实现，未做任何结构性改动。

### `web/src/types.ts`
- 在文件末尾、`SearchHit` 之后追加 `DeepSearchState` 接口（`active` / `keyword` / `loading` / `scanned` / `truncated` / `error` / `hits` / `page`）。
- 未触碰已存在的 `SearchHit`。

### `web/src/context/FileStoreContext.tsx`
1. 新增 import：
   - `import { attributeMatches, parentKey } from '../api/search';`
   - 类型 import 列表补 `DeepSearchState`、`SearchHit`。
2. `interface FileStoreContextType` 中 `clearSelection` 之后按 brief 顺序新增 `deepSearch`、`runDeepSearch`、`exitDeepSearch`、`setDeepSearchPage`、`revealHit`。
3. 在 `FileStoreContext` 定义之前新增 `EMPTY_DEEP_SEARCH` 常量。
4. 在 `selectedKeys` 的 `useState` 之后新增 `deepSearch` state 与 `pendingReveal` ref（带 `mount` / `parent` / `key`）。
5. 在 `clearSelection` 之后按 brief 顺序新增 `runDeepSearch`（固定 `api.searchFiles(kw, '/')`，成功走 `attributeMatches(mountsRef.current, res.matches)`，失败只写结果视图 error）、`exitDeepSearch`、`setDeepSearchPage`、`revealHit`（`useCallback` 依赖数组保持 `[navigateTo]`，未包裹 `navigateTo`）。
6. `refreshDirectory` 中：原样保留「保留仍然存在的选中」remap，其后消费 `pendingReveal`，并以 `reveal.mount === mountName && reveal.parent === currentPath` 双重校验后才清除并 `setSelectedNode(hit)`。未改动 `useCallback` 依赖数组。
7. provider `value` 在 `clearSelection` 之后按 brief 顺序插入五个键。
8. `logout()` 锚定 `setSelectedNode(null);`（避免误改卸载清理里同名 `pollTimers.current.clear()`），在其后插入 `pendingReveal.current = null;` 与 `setDeepSearch(EMPTY_DEEP_SEARCH);`。

### 与 brief 的唯一偏差（有意）
brief 的 Step 6 只 `git add web/src/context/FileStoreContext.tsx`，但 Step 1 明确要求在 `web/src/types.ts` 追加 `DeepSearchState`，且任务文件列表同时列出两个文件。因此提交时两个文件都 add，否则 `types.ts` 的改动会丢失。

## Verification

命令（工作目录 `e:/workspace-dev/Foyer/web`）：

- `npx tsc --noEmit` → 退出码 0，无输出（clean）。
- `npx vitest run` → 退出码 0：**Test Files 18 passed (18)，Tests 133 passed (133)**，无失败、无 skipped。

`package.json` 的 `lint` 脚本即 `tsc --noEmit`，与上面第一条等价。

提交：`48aff1a feat(web): wire deep search state and hit reveal into the store`（2 files changed, 99 insertions(+)）。

### 关于执行验证的诚实说明

**context 层在本仓库没有被 DOM 测试覆盖。** vitest 运行在 node 环境且只 include `*.test.ts`，仓库没有 jsdom/react-testing-library。按 brief 要求未新增任何测试依赖。因此：

- 已执行验证：TypeScript 类型层面 provider value 的键与 `FileStoreContextType` 逐字段对齐、`DeepSearchState`/`SearchHit` 类型正确、全量既有测试无回归。
- **未执行验证**：`runDeepSearch` / `exitDeepSearch` / `setDeepSearchPage` / `revealHit` 的运行时行为，`pendingReveal` 的消费时机，以及 `refreshDirectory` 中 reveal 分支在真实渲染下的触发，均为阅读代码得出的结论，未被任何测试实际执行。

## Files changed

- `web/src/types.ts`（追加 `DeepSearchState`）
- `web/src/context/FileStoreContext.tsx`（state、回调、refreshDirectory 消费、provider value、logout 清理）

## Self-review findings

- 所有 brief 命名的锚点替换前都逐个确认了上下文，均与 brief 假设一致；`logout` 的 `pollTimers.current.clear()` 二义性通过保留 `setSelectedNode(null);` 前缀规避。
- `revealHit` 中 `navigateTo` 定义于其之前（源文件顺序），`useCallback([navigateTo])` 可正常引用。
- 未加入 brief 之外的 `deepSearch` 重置；仅 `exitDeepSearch`、`revealHit`、`logout` 三处清理（`logout` 为 brief Step 4 要求）。
- 未重构文件，未新增依赖，未改动 `SearchHit`。

## Concerns

1. **同一目录内的 reveal 不会立即选中（brief 既定设计的边界情况，非实现偏差）。** `revealHit` 通过 `navigateTo(mount, parentKey)` 触发目录重载；当目标父目录恰好就是当前 `currentMount`/`currentPath` 时，React 对相同 state 值 bail out，目录加载 effect（依赖 `[isAuthenticated, currentMount, currentPath, refreshDirectory]`）不会重跑，`pendingReveal` 不会被消费，行也不会被选中；该待揭示状态会一直保留，直到用户之后导航到同 mount/path 时才被消费。我没有按自己的判断修改这一逻辑，因为它完全来自 brief 指定的实现，且超出本任务范围。若 Task 7 的交互中「在命中所在目录中发起检索并点开该目录的命中」是常见路径，建议后续任务评估是否需要在 `revealHit` 中显式触发一次刷新。
2. 若目标目录的列表请求失败，`pendingReveal` 不会被清除（保留到下次匹配成功）；同样来自 brief 指定逻辑，风险很低。

## Report file

`e:/workspace-dev/Foyer/.superpowers/sdd/search-task-6-report.md`

---

# Fix round 1 — 同一目录内 reveal 不触发选中

## 根因

`revealHit` 记下 `pendingReveal` 后调用 `navigateTo(hit.mount, parentKey(hit.key))`。当目标的父目录正是用户当前所在目录时，`navigateTo` 把 `currentMount`/`currentPath` 设为原值，React 对相同 state bail out，于是这个 effect 不重跑：

```ts
void refreshDirectory();
}, [isAuthenticated, currentMount, currentPath, refreshDirectory]);
```

而揭示的消费原本写在 `refreshDirectory` 内，因此根本到不了：退出检索视图却没有选中任何行。检索本身不改变当前目录，所以「停在命中所在目录里搜索、然后点该目录的命中」是常见路径，必现。

## 选择的机制

把揭示的消费从 `refreshDirectory` 内提出来，改成一个独立 effect，并用两样东西驱动它：

1. **`revealTick` 状态计数器**（`FileStoreContext.tsx:161`），在 `revealHit` 里 `setRevealTick(t => t + 1)`（`:453`）。目标目录已是当前目录时它强制一次渲染，让 effect 一定被触发。
2. **`nodesOwnerRef`**（`:158`），记录「当前 `nodes` 是哪个 mount/path 的条目」，在 `refreshDirectory` 产出 entries 的同一处写入 `{ mount: mountName, path: currentPath }`（`:227`，`:216` 处置 null）。它保存的正是产出这次 nodes 的那次请求的**闭包值**，因此完整保留了原先闭包守卫的语义——在途的旧目录（甚至别的挂载）请求即使命中同名 key 也无法提前消费。这是对你约束 1 的落实：没有退化成「任何 `setNodes` 之后读最新 `currentMount`/`currentPath`」的无守卫判断。

消费 effect（`:326-341`）：

```ts
useEffect(() => {
  const reveal = pendingReveal.current;
  if (!reveal) return;
  const owner = nodesOwnerRef.current;
  if (!owner || owner.mount !== reveal.mount || owner.path !== reveal.parent) return;
  if (reveal.mount !== currentMount || reveal.parent !== currentPath) return;
  const hit = nodes.find(n => n.key === reveal.key);
  if (!hit) return;
  pendingReveal.current = null;
  setSelectedNode(hit);
}, [revealTick, nodes, currentMount, currentPath]);
```

deps 里 `revealTick` 覆盖「无加载」路径，`nodes` 覆盖「加载回填」路径；`currentMount`/`currentPath` 保证用户仍停在目标目录。`refreshDirectory` 内原来的消费块已删除，其「保留仍然存在的选中」remap 原样保留。`navigateTo` 未改成 `useCallback`，未加依赖，未重构，未引入 DOM 测试设施。

`logout` 里一并把 `nodesOwnerRef.current = null`（`:369`），与 `pendingReveal` 同生命周期。

## 两条路径的追踪

记 `nodesOwnerRef.current = owner`。

**(a) 命中在不同目录**（当前 `A:/x`，命中 `A:/y/f`）：
1. `revealHit`：`pendingReveal = {A, /y, /y/f}`，`setRevealTick++`，清空 deepSearch，`navigateTo(A, /y)` → `currentPath=/y`，`selectedNode=null`。
2. 渲染后 effect 跑（deps：revealTick 变、path 变）。`owner` 仍是 `{A,/x}`（`/y` 的请求未回）→ 第一道守卫失败 → 不消费。**旧目录请求无法提前吃掉揭示。**
3. `/y` 的 `refreshDirectory` 完成：`nodesOwnerRef.current = {A,/y}`（闭包值），`setNodes(/y 的 entries)`，remap 对 `selectedNode=null` 返回 null。
4. effect 因 `nodes` 变化重跑：`owner` 匹配 reveal、`currentMount`/`currentPath` 匹配、`nodes.find('/y/f')` 命中 → 清 `pendingReveal`、`setSelectedNode(hit)`。**选中生效。**

**(b) 命中在已当前目录**（当前 `A:/x`，命中 `A:/x/f`）：
1. `revealHit`：`pendingReveal = {A, /x, /x/f}`，`setRevealTick++`，`navigateTo(A, /x)` 把 state 设为原值 → React bail out，那条目录加载 effect 不跑（这是原 bug 的条件）。
2. 但 `revealTick` 已变，组件仍重渲染 → effect 跑。`owner` 仍为 `{A,/x}`（用户就在此目录，nodes 早已加载）→ 第一道守卫通过；`currentMount`/`currentPath` 通过；`nodes.find('/x/f')` 命中 → 消费并选中。**无需任何目录加载即生效。**
3. 若该目录此刻仍在首屏加载中（`nodes=[]`），第一次 effect 因找不到 key 而返回；加载完成 `setNodes` 后 effect 重跑并选中，行为正确。

**跨挂载陈旧条目的边界**：若 `navigateTo` 把 `currentMount` 从 A 改成 B、而 A 的旧请求随后回填 `nodes`，`owner={A,'/'}` 与 reveal 的 `{B,'/'}` 在 `owner.mount` 上不等，effect 不会用 A 的同名 entry 误选——这正是保留闭包守卫的价值。

## 验证（Fix round 1）

工作目录 `e:/workspace-dev/Foyer/web`：

- `npx tsc --noEmit` → 退出码 0，无输出（clean）。
- `npx vitest run` → 退出码 0：**Test Files 18 passed (18)，Tests 133 passed (133)**，无失败、无 skipped，与 fix 前一致（无回归）。

**仍未执行验证**：context 层无 DOM 测试设施（vitest 为 node 环境、只 include `*.test.ts`，无 jsdom/RTL），因此上面两条路径是**基于代码的精确追踪，不是被测试执行的运行时证据**。未按要求新增任何测试依赖。

## Fix round 1 变更文件与行

- `web/src/context/FileStoreContext.tsx`
  - `:151` 注释更新；`:158` 新增 `nodesOwnerRef`；`:161` 新增 `revealTick` state
  - `:216` 无 mount 时 `nodesOwnerRef.current = null`；`:227` 记录 nodes 归属
  - `:326-341` 新增揭示消费 effect
  - `:369` `logout` 重置 `nodesOwnerRef`
  - `:453` `revealHit` 中 `setRevealTick(t => t + 1)`
  - 删除 `refreshDirectory` 内原揭示消费块（remap 原样保留）
- 无其它文件改动。

## Fix round 1 剩余关注

原 Concerns 第 1 条已由本轮修复解决。第 2 条仍旧：目标目录列表请求失败时 `pendingReveal` 保留到下一次同 mount/path 的匹配（仍不清除），风险低，未按个人判断改动。

