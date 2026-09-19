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

---

# Final review fix round — 揭示意图的悬挂：限定生命周期

## Finding（整支分支终审的 Important 项）

`pendingReveal` 只在**成功消费**、显式 `exitDeepSearch`、新的 `revealHit`、`logout` 四处被清空。若用户点「跳转」进入某目录，而该目录的 entries 到位后**不含**该 key，揭示会一直保持上膛，日后某次无关的手动进入同一 mount/path 时被自动选中——这正是设计 spec 点名的「悬挂」，spec 要求避免。

## 决策与理由（人类已定，未再审）

- **不在「停在目标层但未命中」时清空。** `listPrefix`（`web/src/api/jfs.ts:133`）只发**一次** `ListObjectsV2`，没有 continuation-token 循环，任何目录列表都被截在 1000 条；本卷 `/av_20260619` 挂载已有 800 条。命中可能根本不在这一页的 `nodes` 里，若在 `!hit` 处清空，跳转会对这种大目录**静默失效**。
- **改为限定生命周期。** 保留目标层的上膛状态，但用户一旦导航**离开**目标目录立即清空。于是揭示的有效窗口恰好是「一次点击 → 到达目标目录」，既不会悬挂过久，也不会因分页截断而误清。

## 改动

**1. `web/src/context/FileStoreContext.tsx:343-353`**（消费 effect 之后、`setPathInput` effect 之前）新增封口 effect：

```tsx
  // 揭示意图的生命周期封口：用户一旦导航离开目标目录，这次点击就过期了，清掉——
  // 否则它会一直上膛，日后某次手动进入同一目录时被自动选中（spec 要避免的「悬挂」）。
  // 刻意**不**在「停在目标目录但本层没有该 key」时清空：目录列表被 listPrefix 的单次
  // ListObjectsV2 截在 1000 条（web/src/api/jfs.ts:133，无 continuation-token 循环），
  // 大目录里的命中可能不在本层 nodes 里，清空会让跳转静默失效。
  useEffect(() => {
    const reveal = pendingReveal.current;
    if (!reveal) return;
    if (reveal.mount === currentMount && reveal.parent === currentPath) return;
    pendingReveal.current = null;
  }, [currentMount, currentPath]);
```

消费 effect（`:328-342`）的 `!hit` 早退逻辑与 `nodesOwnerRef` 守卫均未改动。该文件其它内容未动。

**2. `docs/superpowers/plans/2026-09-19-deep-search.md`** Task 6 Step 3：在 `:1786` 附近的代码块里，消费 effect 之后原样插入同一段封口 effect（`:1772-1782`）；并把其下的 blockquote（原 `:1772-1776`）改写为：两个守卫仍缺一不可；`!hit` 故意不清空并给出 `listPrefix` 单次 `ListObjectsV2` / 1000 条上限、`/av_20260619` 已 800 条的理由；「避免悬挂」改由限定生命周期满足（窗口 = 一次点击 → 到达目标目录，任何一次离开即清）。

**3. `docs/superpowers/specs/2026-09-19-deep-search-design.md:170`**：把「若本层加载完成但未命中（目标已不在），也清空，避免悬挂。」替换为「若停在目标目录但本层未命中，**不清空**——`listPrefix` 只发一次 `ListObjectsV2`、单目录列表被截在 1000 条，命中可能不在这一页里，清空会让跳转静默失效。「避免悬挂」由**限定生命周期**保证：揭示只在『一次点击 → 到达目标目录』这一窗口内有效，用户一旦导航离开目标目录即清空。」该节其余内容未动。

## 验证合同

工作目录 `e:/workspace-dev/Foyer/web`。命令用 `;` 串联、逐条回显退出码：

```
npx tsc --noEmit; "TSC_EXIT=$LASTEXITCODE"; npx vitest run; "VITEST_EXIT=$LASTEXITCODE"
```

输出（逐字）：

```
TSC_EXIT=0

 RUN  v3.2.7 E:/workspace-dev/Foyer/web

 ✓ src/report/format.test.ts (15 tests) 5ms
 ✓ src/report/paths.test.ts (12 tests) 4ms
 ✓ src/utils/hostPath.test.ts (7 tests) 5ms
 ✓ src/cli/parse.test.ts (5 tests) 4ms
 ✓ src/api/hostDir.test.ts (5 tests) 5ms
 ✓ src/api/mappers.test.ts (3 tests) 6ms
 ✓ src/report/walk.test.ts (17 tests) 13ms
 ✓ src/api/browse.test.ts (4 tests) 6ms
 ✓ src/api/search.fetch.test.ts (5 tests) 8ms
 ✓ src/api/search.test.ts (15 tests) 9ms
 ✓ src/api/mounts.test.ts (11 tests) 8ms
 ✓ src/report/live.list.test.ts (1 test) 4ms
 ✓ src/report/build.test.ts (14 tests) 8ms
 ✓ src/report/live.test.ts (6 tests) 9ms
 ✓ src/cli/run.test.ts (5 tests) 31ms
 ✓ src/utils/capacity.test.ts (2 tests) 3ms
 ✓ src/api/stat.test.ts (4 tests) 5ms
 ✓ src/api/jfs.test.ts (2 tests) 3ms

 Test Files  18 passed (18)
      Tests  133 passed (133)
   Start at  22:43:24
   Duration  1.11s (transform 2.79s, setup 0ms, collect 5.37s, tests 137ms, environment 3ms, prepare 2.43s)

VITEST_EXIT=0
```

- `npx tsc --noEmit`：退出码 **0**，无输出（clean）。
- `npx vitest run`：退出码 **0**，**Test Files 18 passed (18)，Tests 133 passed (133)**，无失败、无 skipped，与 fix 前一致（无回归）。

**诚实说明（与 Task 6 / Fix round 1 相同）：** 本仓库 context 层没有可执行的测试设施——vitest 运行在 node 环境、只 include `src/**/*.test.ts`，没有 jsdom / react-testing-library。因此本次改动由**类型检查 + 代码阅读**验证，**不是**运行 UI 验证；下面四条序列是基于 React 提交/依赖数组语义的精确追踪，不是被测试执行的运行时证据。未新增任何测试依赖。

## 序列追踪与 effect 顺序

关键前提：同一组件内 effect 按**声明顺序**在同一次 commit 后依次执行。封口 effect 声明在消费 effect（`:328`）之后（`:348`），故在一次提交内**消费先于封口**运行。封口 effect 只读 `currentMount`/`currentPath`（不依赖 `nodes`/`revealTick`），且不调用 setState（只写 ref），不会引发二次渲染，对消费结果无干扰。

记目标为 `{mount: M, parent: P, key: K}`。

**序列 1 — 跳到「非当前」的目标目录 → 不清空，消费命中。**
1. `revealHit`：`pendingReveal={M,P,K}`，`revealTick++`，清 deepSearch，`navigateTo(M,P)` 与上述 state 在**同一批次**提交 → `currentMount=M`、`currentPath=P`。
2. commit 后 effect 依次跑：消费 effect 因 `nodesOwnerRef` 仍指向旧目录（`owner != {M,P}`）而返回；封口 effect 读到 `currentMount/Path == M/P == reveal 的目标` → **不清空**。
3. 目标目录 `refreshDirectory` 回填：`nodesOwnerRef={M,P}`、`setNodes(P 的 entries)`。
4. `nodes` 变化触发消费 effect：两道守卫通过、`nodes.find(K)` 命中 → 清 `pendingReveal`、`setSelectedNode(hit)`。封口 effect 因 `currentMount/Path` 未变不重跑。**正确。**

**序列 2 — 已经停在目标目录时点跳转 → 不清空，靠 `revealTick` 消费。**
1. `revealHit`：`pendingReveal={M,P,K}`，`revealTick++`，`navigateTo(M,P)` 写入的是**原值** → React 对 `currentMount`/`currentPath` bail out，但 `revealTick` 已变，仍产生一次渲染/commit。
2. 消费 effect（deps 含 `revealTick`）跑：`owner` 早已是 `{M,P}`、`currentMount/Path` 匹配、`nodes.find(K)` 命中 → 清 `pendingReveal`、选中。
3. 封口 effect 的 deps（`currentMount`,`currentPath`）**未变化**，不重跑；即使因任何原因跑一次，也读到位置 == 目标 → **不清空**。**正确。**

**序列 3 — 跳入 >1000 条目、`K` 不在本页 `nodes` 里 → 消费在 `!hit` 返回 → 不清空（有意）。**
1. `revealHit` → `navigateTo(M,P)`，`currentMount/Path = M/P`。
2. 消费 effect：`owner` 待目标请求回填后变为 `{M,P}`、位置守卫通过、`nodes.find(K)` **不命中** → 在 `!hit` 早退，`pendingReveal` **保留**。
3. 封口 effect：位置 == 目标 → **不清空**（正是决策所要求的：分页截断下不能视为「目标不存在」）。
4. 若此后目标页被重载或 `nodes` 变化，消费 effect 会再次尝试；若 `K` 始终不在本页，揭示保持上膛，等待序列 4 的离开或后续命中。**符合设计。**

**序列 4 — 从序列 3 导航到任意其它目录 → 立即清空；之后手动返回不再误选。**
1. 用户 `navigateTo(M2,P2)`（或 `navigateUp` 等，最终都落在 `setCurrentMount`/`setCurrentPath`）→ `currentMount/Path != M/P`。
2. 封口 effect deps 变化 → 跑：位置 != 目标 → `pendingReveal.current = null`。**清空。**
3. 稍后用户手动回到 `M/P`：`pendingReveal` 已为 null，消费 effect 第一行 `if (!reveal) return;` 直接退出 → **不会**自动选中 `K`。**悬挂消除。**

**序列 3→4 的陈旧选中确认：** 封口把 `pendingReveal.current` 置 null 后，消费 effect 的 `const reveal = pendingReveal.current; if (!reveal) return;` 使任何**迟到**到达的目标目录响应（`owner` 变为 `{M,P}`、`nodes` 含 `K`）都无法选中任何东西——消费的唯一来源就是 `pendingReveal`，它已空。因此不会出现「离开后又被迟到响应选中」的陈旧选中。

## 结论

- 决策落地：不清空目标层的 miss，改为在离开目标目录时封口。
- `npx tsc --noEmit` clean；`npx vitest run` 133/133，无回归。
- 上下文层无 DOM 测试设施，验证 = 类型检查 + 阅读/追踪，非运行 UI。

## 本轮变更文件

- `web/src/context/FileStoreContext.tsx`（仅新增 `:343-353` 封口 effect）
- `docs/superpowers/plans/2026-09-19-deep-search.md`（Task 6 Step 3 代码块 + blockquote 与实现对齐）
- `docs/superpowers/specs/2026-09-19-deep-search-design.md`（Context 节第 170 行，悬挂规则改为限定生命周期）
- `.superpowers/sdd/search-task-6-report.md`（本报告）

## 本轮剩余关注

原 Fix round 1 的 Concern 第 2 条（目标目录列表请求失败时揭示会保留）依旧：请求失败没有产生 `nodes`，封口 effect 也不会触发（位置没变），揭示会保留到用户离开该目录为止。因生命周期已被限定，风险进一步降低；仍未按个人判断改动。

