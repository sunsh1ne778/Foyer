# Host-directory-picker — final fix pass report

Branch: current working tree (`E:/workspace-dev/Foyer`).
Scope: the 8 concrete defects from the whole-branch review. No refactors, no features,
no public-behavior changes beyond what was specified. `entries[].mtime` untouched
(still in the Go struct, JSON, and per-entry `Info()` call).

## Item 1 — Windows-only junction regression test for the bind-root escape guard

- Added `TestBrowseRejectsJunctionEscapeWindows` in
  `server/internal/foyer/browse_test.go:148`.
  - Guarded with `if runtime.GOOS != "windows" { t.Skipf(...) }`.
  - Creates the link with `exec.Command("cmd", "/c", "mklink", "/J", link, target)`,
    capturing stdout and stderr separately.
  - Checks **both** the exit code (`cmd.Run()` error) and `stderr.Len() > 0`; if
    either is bad it `t.Skipf`s with the observed err/stderr (never fakes success).
  - Adds a non-vacuity guard: `os.Stat(filepath.Join(link, "sub"))` must succeed,
    otherwise the two rejection assertions could pass merely because the path does
    not exist.
  - Asserts the same two things as the symlink test: `Browse(cfg, G:\link)` is
    rejected and `Browse(cfg, G:\link\sub)` is rejected.
- The two existing symlink tests (`TestBrowseSkipsSymlink`,
  `TestBrowseRejectsSymlinkEscape`) were left **exactly as they were**; they still
  run on Linux and still `t.Skipf` on this Windows box (no privilege for `os.Symlink`).
- New imports in the test file: `bytes`, `os/exec`, `runtime`.

### Result — it RAN (not skipped) and PASSED on this Windows machine

```
=== RUN   TestBrowseRejectsJunctionEscapeWindows
--- PASS: TestBrowseRejectsJunctionEscapeWindows (0.03s)
PASS
ok  	filestore/internal/foyer	0.789s
```

The full run confirms the two symlink tests still skip on Windows and the junction
test runs:

```
=== RUN   TestBrowseSkipsSymlink
    browse_test.go:111: symlink unsupported here: ... A required privilege is not held by the client.
--- SKIP: TestBrowseSkipsSymlink (0.00s)
=== RUN   TestBrowseRejectsSymlinkEscape
    browse_test.go:133: symlink unsupported here: ... A required privilege is not held by the client.
--- SKIP: TestBrowseRejectsSymlinkEscape (0.00s)
=== RUN   TestBrowseRejectsJunctionEscapeWindows
--- PASS: TestBrowseRejectsJunctionEscapeWindows (0.03s)
```

Notes on how the two rejections actually fire on this Go/Windows version: the
junction's `Lstat` reports a reparse point with `IsDir()==false` (so `G:\link` is
rejected by the `!fi.IsDir()` branch), and `G:\link\sub` is rejected by the
`filepath.EvalSymlinks` real-path containment check (`path escapes the allowed
root`). The assertion is the same as the symlink variant: both requests must error.

## Item 2 — stale doc comment

`server/internal/foyer/path.go:112`: changed the `DetectHostDrives` doc comment from
`形如 "C:\\"` to `形如 "C:\"` (single backslash), matching the actual return
`strings.ToUpper(n) + ":\"`.

## Item 3 — test comment contradicted the assertion

`server/internal/foyer/browse_test.go:213`: rewrote the comment on the `Z:\nope`
case to state what is actually asserted — `MapHostPath` maps it to `<base>/z/nope`,
that directory does not exist, so `Browse` errors. It no longer claims the test
establishes an "unbound drive maps to an empty directory" precondition. The
assertion (`err == nil` => fatal) was not weakened.

## Item 4 — HTTP error classification + missing `Allow` header

- `server/internal/foyer/browse.go:18`: added exported sentinel
  `var ErrBrowseBadPath = errors.New("browse: invalid path")` (new `errors` import).
- Wrapped with `%w` on the client-error paths:
  - `:56` `MapHostPath` failure (see choice below)
  - `:65` path outside the allowed root
  - `:72` no such directory (see choice below)
  - `:77` refusing to follow a symlink
  - `:80` not a directory
  - `:95` resolved path escapes the allowed root
- `server/internal/foyer/health.go:86-101`: `/foyer/browse` now returns `400` only
  when `errors.Is(err, ErrBrowseBadPath)`, otherwise `500`; and sets
  `Allow: GET` before the `405`.
- Route tests in `browse_test.go` (`TestBrowseRoute`):
  - `/etc` -> 400 (kept).
  - `Z:\nope` -> 400 (new; a requested-but-missing path is classified client error).
  - a path that passes the client-error checks but fails the server-side reverse
    mapping (`<mountBase>/zz`) -> 500 (new; `browse_test.go:271`).
  - `POST` -> 405 **and** `Allow: GET` asserted (new header assertion at `:280`).

### Item 4 choices (and why)

- **`no such directory` -> client error (400), wrapped.** The request names a path
  that does not exist, i.e. the failure is a property of the request content, which
  is the HTTP definition of a client error. It also keeps the pre-change behavior
  (was 400). This is the "judge it a client error" branch the task left open.
- **`MapHostPath` failure -> client error (400), wrapped (extra, justified).**
  These errors are all client input-validation failures ("use a Windows path like
  E:\data", "not under FOYER_HOST_DATA", bad `file:` URI). They were 400 before the
  change; leaving them unwrapped would silently flip them to 500, i.e. an
  unrequested public behavior change, so wrapping them preserves behavior.
- Consequence: only genuine server-side failures (Lstat non-not-exist / permission,
  `EvalSymlinks`, reverse mapping, `os.ReadDir`) now produce 500.

### 500-test caveat (see "Could not verify" below)

The 500 route assertion drives a deterministic server-side reverse-mapping failure
rather than an actual `os.ReadDir`/permission failure, because an OS read failure
cannot be induced portably in a unit test. It still exercises exactly the same
branch (`err` is not `ErrBrowseBadPath` -> 500).

## Item 5 — frontend fail-open default

`web/src/api/jfs.ts:436`: `ok: data.ok ?? true` -> `ok: data.ok ?? false`.

Chosen: **fail closed** (`?? false`). Nothing currently reads `FoyerBrowseResult.ok`
(the picker only uses `entries`/`drives`/`path`/`parent`), but `ok` is part of the
public return type and a 200 body that explicitly says `ok: false` must never be
coerced to success for a future consumer. `?? false` keeps the declared `boolean`
type without a cast; "drop the default entirely" would either break the type or
require an unsafe cast for no benefit.

## Item 6 — strengthen two under-asserting frontend tests

- `web/src/api/browse.test.ts:14`: `stubFetch`'s `text` now returns a plain string
  when the payload is a string (`typeof payload === 'string' ? payload : JSON.stringify(payload)`),
  modelling the raw text body Go's `http.Error` sends. The failure test
  (`surfaces the server message on failure`) therefore proves the raw server
  message surfaces instead of a JSON-quoted one.
- `web/src/api/browse.test.ts:35`: the empty-string case now captures the call and
  asserts `calls[0] === '/foyer/browse'`, i.e. **no `path` param**.
- `web/src/utils/hostPath.test.ts:22`: added a trailing-separator case
  (`G:\20260619\`) asserting the same round-trip values as without the separator.
- `web/src/utils/hostPath.test.ts:29`: added a deeper-than-two-levels case
  (`G:\20260619\#整理完成\sub`) asserting the full accumulated segment list.

## Item 7 — stale nav while loading / after a failed load

`web/src/components/DirectoryPicker.tsx`:
- `:115`: nav block now renders only `{path && !error && ( ... )}` — after a failed
  load the previous directory's breadcrumbs / drive pills / "up" control are gone.
- `:122`, `:137`, `:150`: drive pills, "up" control and breadcrumb buttons are
  `disabled={loading}` (plus `disabled:opacity-50 disabled:cursor-not-allowed`,
  and `disabled:no-underline` for crumbs).
- `:236`: 「选择此目录」 is now `disabled={!path || loading || !!error}`, so a stale
  path displayed after a failed load cannot be committed.

Interaction with the tri-state `load` guard: none required. The requested/out-of-order
protection is `reqRef`/`aliveRef` inside `load` and is unchanged. Disabling the nav
while `loading` only removes duplicate clicks at the DOM level; it does not change
what the guard has to handle (a click can still race a pending request through other
paths, and the guard still supersedes it). The state rendering stays distinguishable:
`loading` -> spinner, `error` -> error panel with no nav, otherwise -> list.

## Item 8 — document `FOYER_HOST_MOUNT_BASE`

`deploy/compose.yml:86-88`, inside the `foyer` service `environment:` block next to
the other `FOYER_*` variables:

```yaml
      FOYER_HOST_MOUNT: /host
      # 盘符绑定根：scripts/gen-host-drives.ps1 把 G:/ 挂成 /mnt/g，目录选择器
      # 在此根下列出 <letter> 子目录当盘符。默认 /mnt，须与生成的挂载点一致。
      FOYER_HOST_MOUNT_BASE: /mnt
      FOYER_HOST_DATA: ${FOYER_HOST_DATA:-}
```

Where the repo documents service configuration: there is **no** env/config reference
in `README.md` (it never lists `FOYER_*` variables; its only mention is an incidental
`FOYER_VOLUME`), and `configs/env.example` only documents `FILESTORE_*`. The de-facto
reference for `FOYER_*` is the `foyer` service environment block in
`deploy/compose.yml`, so the variable + default + a short comment were added there.
`compose.yml` was re-parsed with a YAML parser to confirm it is still valid.

## Verification contract — commands and output

### 1. `cd server && go test ./internal/foyer/ -count=1` — PASS

```
ok  	filestore/internal/foyer	9.266s
```

Junction test: **RAN and PASSED** (see Item 1). The two symlink tests SKIPPED on
Windows as before (they run on Linux).

### 2. `cd web && npx tsc --noEmit` — clean

```
(no output, exit code 0)
```

### 3. `cd web && npm test` (vitest run) — PASS

```
 ✓ src/report/paths.test.ts (12 tests)
 ✓ src/report/format.test.ts (14 tests)
 ✓ src/report/walk.test.ts (13 tests)
 ✓ src/utils/hostPath.test.ts (7 tests)
 ✓ src/cli/parse.test.ts (5 tests)
 ✓ src/api/browse.test.ts (4 tests)
 ✓ src/api/mounts.test.ts (5 tests)
 ✓ src/api/jfs.test.ts (2 tests)
 ✓ src/report/live.list.test.ts (1 test)
 ✓ src/report/build.test.ts (14 tests)
 ✓ src/report/live.test.ts (6 tests)
 ✓ src/api/stat.test.ts (4 tests)
 ✓ src/cli/run.test.ts (5 tests)

 Test Files  13 passed (13)
      Tests  92 passed (92)
```

## Could not verify / concerns

- The 500 route test uses a server-side reverse-mapping failure
  (`<mountBase>/zz`) rather than a real `os.ReadDir` permission failure. An
  `os.ReadDir`/permission failure cannot be reproduced portably in a unit test
  (Windows ignores `chmod` for directory listing; ACL manipulation is
  non-deterministic in CI). The assertion nevertheless exercises the exact branch
  that any non-`ErrBrowseBadPath` error takes (`code = 500`), so the 400-vs-500
  split is genuinely asserted.
- Wrapping `MapHostPath` errors and the `no such directory` case are judgment
  calls beyond the four enumerated paths (both documented above). If the reviewer
  intended `no such directory` to be a 500, the only change needed is to un-wrap
  `browse.go:72` and flip the `Z:\nope` route assertion to 500.
- Nothing else was left unverified; no test was silenced with a skip and no
  assertion was weakened.
