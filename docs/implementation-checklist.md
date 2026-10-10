# Implementation Checklist: portmanagement Refactor

> Branch: `feat/port-manager-sync-session`
> Stack: Tauri 2 + React + TypeScript + Bun
> Test runner: `bun test`

---

## Environment Setup

- [ ] Confirm `bun test` runs without errors before starting
- [ ] Create a git snapshot branch: `git checkout -b refactor/cleanup-$(date +%Y%m%d)`
- [ ] Confirm Tauri dev still starts: `bun run tauri:dev`

---

## Phase 1 (P1-1) — Fix Mutex `unwrap()` in lib.rs

**File**: `src-tauri/src/lib.rs`

**Risk**: Poisoned mutex panics the entire Tauri process. The current `unwrap()` on lock acquisition is unsound. The correct recovery is `unwrap_or_else(|e| e.into_inner())` — this recovers the inner data even when a previous thread panicked while holding the lock.

**Exact locations**:
| Line | Context |
|------|---------|
| 340 | `execute_command` — registers new PID after spawn |
| 356 | `stop_command` — removes PID from map |
| 536 | `force_restart_command` — removes PID from map before restart |
| 663 | `force_restart_command` — inserts new PID after respawn |

**RED — write test first**
- [ ] In `src-tauri/src/lib.rs` (or a `#[cfg(test)]` block at bottom of file), add a unit test that simulates a poisoned `Mutex<HashMap<String,u32>>` and asserts `unwrap_or_else(|e| e.into_inner())` returns the inner value without panicking
  ```rust
  #[cfg(test)]
  mod tests {
      use std::sync::Mutex;
      use std::collections::HashMap;
      #[test]
      fn poisoned_mutex_recovers() {
          let m = Mutex::new(HashMap::<String, u32>::new());
          // poison the mutex
          let _ = std::panic::catch_unwind(|| {
              let _g = m.lock().unwrap();
              panic!("intentional poison");
          });
          // must not panic
          let guard = m.lock().unwrap_or_else(|e| e.into_inner());
          assert!(guard.is_empty());
      }
  }
  ```
- [ ] Run `cargo test -p portmanagement-lib 2>&1` (or equivalent) and confirm test compiles but the current `unwrap()` approach does not protect against poison (document this observation)

**GREEN — minimal fix**
- [ ] Line 340: replace `state.processes.lock().unwrap()` with `state.processes.lock().unwrap_or_else(|e| e.into_inner())`
- [ ] Line 356: same replacement
- [ ] Line 536: same replacement
- [ ] Line 663: same replacement
- [ ] Run `cargo build -p portmanagement-lib` — must compile with zero errors/warnings introduced

**REFACTOR**
- [ ] Extract a helper macro or inline function `fn lock_processes(state: &AppState) -> std::sync::MutexGuard<HashMap<String,u32>>` that encapsulates the pattern, then use it at all four call sites
- [ ] Re-run `cargo test` — all tests still pass
- [ ] Run `bun run tauri:dev` briefly to confirm no regression

**Verification**
- [ ] `grep -n "\.unwrap()" src-tauri/src/lib.rs` returns zero results on the Mutex lock lines

---

## Phase 1 (P1-2) — Extract `ensure_app_data_dir` Rust helper

**File**: `src-tauri/src/lib.rs`

**Risk**: Low — pure refactor. The `app_data_dir` resolution + `create_dir_all` block is copy-pasted in at least 8 commands. A bug in that block must currently be fixed 8 times.

**Identify all repetitions** (confirm before starting):
- [ ] Run `grep -n "app_data_dir" src-tauri/src/lib.rs` and list every line number
  - Expected hits: `load_ports` (~41), `save_ports` (~66), `execute_command` (~231), `force_restart_command` (~556), `open_log`, `build_app`, `install_app_to_applications`, `load_portal` / `save_portal`

**RED**
- [ ] Add a `#[cfg(test)]` test asserting `ensure_app_data_dir` returns a path ending in the bundle identifier when given a mock `AppHandle` — or at minimum write the function signature and confirm it does not compile yet

**GREEN**
- [ ] Define the helper above the first `#[tauri::command]`:
  ```rust
  fn ensure_app_data_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
      let dir = app_handle.path().app_data_dir()
          .map_err(|e| e.to_string())?;
      if !dir.exists() {
          fs::create_dir_all(&dir)
              .map_err(|e| format!("Failed to create app data directory: {}", e))?;
      }
      Ok(dir)
  }
  ```
- [ ] Replace the first repetition (in `load_ports`, lines 41-48) with `let app_data_dir = ensure_app_data_dir(&app_handle)?;`
- [ ] `cargo build` — green
- [ ] Replace remaining 7 repetitions one at a time, building after each

**REFACTOR**
- [ ] Confirm `grep -n "app_handle.path().app_data_dir()" src-tauri/src/lib.rs` returns zero results (all replaced)
- [ ] Run `bun run tauri:dev` smoke test

**Verification**
- [ ] `cargo build` exits 0
- [ ] `grep -c "ensure_app_data_dir" src-tauri/src/lib.rs` >= 8 (all call sites replaced)

---

## Phase 1 (P1-3) — Extract `spawn_command` Rust private helper

**File**: `src-tauri/src/lib.rs`

**Risk**: Medium — the spawn logic contains `unsafe { cmd.pre_exec(...) }`. Must not change behavior, only extract.

**Duplicated block locations**:
- `execute_command`: lines ~280–344 (PATH construction → chmod → spawn → PID insert)
- `force_restart_command`: lines ~600–665 (identical block, different log prefix)

**RED**
- [ ] Write a test that calls the extracted helper with a known-safe command (e.g., `echo hello`) and asserts the returned PID is non-zero:
  ```rust
  #[cfg(test)]
  #[test]
  fn spawn_echo_returns_pid() {
      // requires actual file system; mark #[ignore] for CI if needed
      let pid = spawn_command("echo".to_string(), "/tmp".to_string(), "test-id".to_string()).unwrap();
      assert!(pid > 0);
  }
  ```
- [ ] Confirm test fails (function does not exist yet)

**GREEN**
- [ ] Define signature:
  ```rust
  fn spawn_command(
      port_id: &str,
      command_path: &str,
      logs_dir: &std::path::Path,
      state: &AppState,
  ) -> Result<u32, String>
  ```
- [ ] Move the shared block (chmod, PATH construction, `unsafe pre_exec`, `cmd.spawn()`, PID HashMap insert) into this function
- [ ] Replace the block in `execute_command` with `spawn_command(&port_id, &command_path, &logs_dir, &state)?`
- [ ] Replace the block in `force_restart_command` with the same call
- [ ] `cargo build` — green

**REFACTOR**
- [ ] Verify log prefixes: pass a `label: &str` parameter (`"ExecuteCommand"` vs `"ForceRestart"`) so println! output stays distinguishable
- [ ] Remove the duplicate `use std::os::unix::process::CommandExt;` import (keep one at top of file)
- [ ] Run `bun run tauri:dev` — start/stop a server to confirm PIDs are tracked

**Verification**
- [ ] `cargo build` exits 0
- [ ] Manually test: start a `.command` file, confirm it appears in port status, stop it

---

## Phase 1 (P1-4) — Extract `usePortManager` hook from App.tsx

**File**: `src/App.tsx` → new file `src/hooks/usePortManager.ts`

**Risk**: Medium — touches primary state. Extract state + handlers for port CRUD and process control only. Leave Supabase sync, build, and workspace state in App.tsx for now (extracted in P1-5 / P2).

**State and handlers to extract**:
- State: `ports`, `setPorts`, `isRefreshing`, `setIsRefreshing`, form fields (`name`, `port`, `commandPath`, `terminalCommand`, `folderPath`, `deployUrl`, `githubUrl`, `worktreePath`, `category`, `description`), edit fields (`editingId`, `editName`, etc.)
- Refs: `hasInitiallyLoaded`, `skipNextSave`
- Handlers: `addPort`, `deletePort`, `startEdit`, `cancelEdit`, `saveEdit`, `executeCommand`, `stopCommand`, `forceRestartCommand`, `handleExportPorts`, `handleImportPorts`, `handleRefresh`, `matchesSearch`, `displayedPorts` (useMemo)
- Effects: initial load (lines ~799–1059), save-on-change (search for `useEffect` that calls `API.savePorts`), focus-reload effect (lines ~1040–1058)

**RED**
- [ ] Create `src/hooks/usePortManager.test.ts`
- [ ] Write test: `usePortManager_initialLoad_returnsPorts` — mock `API.loadPorts` to return a fixture, render hook with `renderHook`, assert `ports.length > 0` after await
- [ ] Write test: `usePortManager_addPort_appendsToList`
- [ ] Write test: `usePortManager_deletePort_removesById`
- [ ] Run `bun test src/hooks/usePortManager.test.ts` — all fail (file does not exist)

**GREEN**
- [ ] Create `src/hooks/` directory
- [ ] Create `src/hooks/usePortManager.ts` with the hook skeleton returning `{ ports, setPorts, addPort, deletePort, ... }`
- [ ] Move state declarations and handlers listed above into the hook
- [ ] In `App.tsx`, replace the extracted state/handlers with `const { ports, setPorts, ... } = usePortManager();`
- [ ] `bun run dev` — UI must render identically to before
- [ ] Run tests — green

**REFACTOR**
- [ ] Ensure the hook does not import anything from `App.tsx` (no circular deps)
- [ ] Add explicit return type annotation to the hook
- [ ] Confirm `displayedPorts` is returned from the hook (it depends on `ports`, `searchQuery` etc. — pass search/filter/sort params as arguments or keep co-located state in the hook)

**Verification**
- [ ] `bun test` passes
- [ ] `bun run build` exits 0 (TypeScript strict mode)
- [ ] Add port, delete port, edit port — all work in browser

---

## Phase 1 (P1-5) — Extract `useSupabaseSync` hook from App.tsx

**File**: `src/App.tsx` → new file `src/hooks/useSupabaseSync.ts`

**Risk**: Low-Medium — Supabase logic is self-contained. Depends on `ports` and `setPorts` which come from `usePortManager`.

**State and handlers to extract**:
- State: `isRestoring`, `isPushingPorts`, `autopullSucceeded` ref, `portalConfigRef`
- Helpers already at module level: `getPortalCredentials`, `getSupabaseClient`, `mergePorts` (keep as module-level in the hook file)
- Handlers: `handleRestoreFromSupabase`, `handlePushToSupabase`, auto-pull effect on initial load (the Supabase pull block inside `loadPortsData` useEffect, lines ~848–???), `autoPushTimerRef` debounce effect

**RED**
- [ ] Create `src/hooks/useSupabaseSync.test.ts`
- [ ] Write test: `useSupabaseSync_push_callsUpsert` — mock `createClient` to return a jest/bun mock supabase, call `handlePushToSupabase`, assert `from('ports').upsert(...)` was called
- [ ] Write test: `useSupabaseSync_pull_mergesWithLocal`
- [ ] Run `bun test` — fail

**GREEN**
- [ ] Create `src/hooks/useSupabaseSync.ts`
- [ ] Signature:
  ```ts
  export function useSupabaseSync(
    ports: PortInfo[],
    setPorts: React.Dispatch<React.SetStateAction<PortInfo[]>>,
    showToast: (msg: string, type?: 'success' | 'error') => void,
  )
  ```
- [ ] Move Supabase state, refs, and handlers into the hook
- [ ] In `App.tsx`, replace with `const { isRestoring, isPushingPorts, handleRestoreFromSupabase, handlePushToSupabase } = useSupabaseSync(ports, setPorts, showToast);`
- [ ] `bun run dev` — Push/Pull buttons must work

**REFACTOR**
- [ ] Move `mergePorts`, `getSupabaseClient`, `getPortalCredentials` into the hook file (they have no dependency on React state)
- [ ] Verify `App.tsx` no longer imports `createClient` directly (it goes through the hook)

**Verification**
- [ ] `bun test` passes
- [ ] Manual: Push to Supabase, Pull from Supabase — data round-trips correctly

---

## Phase 2 (P2-1) — Collapse `handleBuildApp`/`handleBuildDmg` into `handleBuild(type)`

**File**: `src/App.tsx` (lines 1584–1694)

**Risk**: Low — pure deduplication of two nearly-identical functions. The only differences are the `buildType` string, initial log message, and `API.buildApp('app')` vs `API.buildDmg()`.

**Current duplication**:
- `handleBuildApp` (lines 1584–1638): sets `buildType('app')`, calls `API.buildApp('app')`, polls `/api/build-status`
- `handleBuildDmg` (lines 1640–1694): sets `buildType('dmg')`, calls `API.buildDmg()`, polls same endpoint

**RED**
- [ ] Write test: `handleBuild_app_callsBuildAppApi` — assert `API.buildApp` called with `'app'` when type is `'app'`
- [ ] Write test: `handleBuild_dmg_callsBuildDmgApi` — assert `API.buildDmg` called when type is `'dmg'`

**GREEN**
- [ ] Create unified `handleBuild(type: 'app' | 'dmg')` function:
  ```ts
  const handleBuild = async (type: 'app' | 'dmg') => {
    if (isBuilding) return;
    setBuildType(type);
    setBuildLogs([`${type === 'dmg' ? 'DMG' : 'App'} 빌드를 시작합니다...`]);
    lastLogIndexRef.current = 0;
    setShowBuildLog(true);
    setIsBuilding(true);
    try {
      const message = type === 'dmg' ? await API.buildDmg() : await API.buildApp(type);
      // ... shared poll logic
    } catch (error) { ... }
  };
  ```
- [ ] Delete `handleBuildApp` and `handleBuildDmg`
- [ ] Update call sites: `handleBuildApp` → `handleBuild('app')`, `handleBuildDmg` → `handleBuild('dmg')` (lines 2320, 2324)

**REFACTOR**
- [ ] Confirm `handleBuildWindows` remains separate (it uses GitHub Actions, fundamentally different flow)
- [ ] Verify `buildType` state still correctly drives the UI labels (lines 2089, 2095, 2321–2326)

**Verification**
- [ ] `bun run build` exits 0
- [ ] Click "앱 빌드" → build log modal opens, type label shows "App"
- [ ] Click "DMG 빌드" → type label shows "DMG"

---

## Phase 2 (P2-2) — Replace `getSearchFiltered()` calls with `displayedPorts`

**File**: `src/App.tsx`

**Risk**: Low. `displayedPorts` (useMemo at line 1976) already computes search+filter+sort. The `getSearchFiltered()` calls at lines 2582 and 2628 are computing a search-only subset (without port-type filter or category filter) for badge counts. This is a subtle difference — the fix must preserve the correct semantics.

**Clarify semantics before touching code**:
- [ ] Read line 2582 context: the filter tab count badges (`전체`, `포트 있음`, `포트 없음`) call `getSearchFiltered()` to get search-only results, then filter by port presence. This is intentional: the counts should reflect search but NOT the active port-type filter (otherwise selecting "포트 있음" makes "포트 없음" show 0).
- [ ] Read line 2628 context: the project count badge uses `getSearchFiltered().length` to show how many match the search — this should show search-only count, not also filtered by port type.

**Correct fix**: `getSearchFiltered()` is NOT the same as `displayedPorts`. It is `ports.filter(p => matchesSearch(p, q))` — search only, no port-type/category filter.

**RED**
- [ ] Write test: `searchOnlyCount_ignoresPortTypeFilter` — given ports `[{port:3000}, {port:undefined}]`, searchQuery `''`, filterType `'with-port'`, assert search-only count = 2 (not 1)

**GREEN**
- [ ] Define a `searchFilteredPorts` derived value (useMemo) that applies only the text search (not port-type or category filter):
  ```ts
  const searchFilteredPorts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return q ? ports.filter(p => matchesSearch(p, q)) : ports;
  }, [ports, searchQuery]);
  ```
- [ ] Replace `getSearchFiltered()` at line 2582 with `searchFilteredPorts`
- [ ] Replace `getSearchFiltered()` at line 2628 with `searchFilteredPorts`
- [ ] If `getSearchFiltered` is defined as a function elsewhere in App.tsx, delete it

**REFACTOR**
- [ ] Confirm `displayedPorts` is still used for rendering the port list (it should be, look for `.map(item => ...)` in the port list render)
- [ ] Confirm filter tab counts still correctly reflect search-without-port-type-filter

**Verification**
- [ ] Type "next" in search → badge shows "N/total" correctly
- [ ] Select "포트 있음" filter → badge counts update, "포트 없음" tab still shows correct count

---

## Phase 2 (P2-3) — Cancel build timeout on completion (store handle in ref)

**File**: `src/App.tsx` (inside `handleBuild` after P2-1, or inside `handleBuildApp`/`handleBuildDmg` before P2-1)

**Risk**: Low. Currently the 10-minute `setTimeout` (line 1627, line 1683) holds a closure over `isBuilding` state which is stale at callback time. Also the timeout is never cleared when the build finishes early.

**Current code** (lines 1626–1633 in `handleBuildApp`):
```ts
setTimeout(() => {
  clearInterval(pollInterval);
  if (isBuilding) {          // <-- stale closure: always the value at setup time
    setIsBuilding(false);
    setBuildLogs(prev => [...prev, '⚠️ 빌드 타임아웃 (10분 초과)']);
  }
}, 600000);
```

**RED**
- [ ] Write test: `handleBuild_completesEarly_timeoutDoesNotFire` — mock poll to return `isBuilding: false` after 100ms, advance fake timers, assert timeout callback was cancelled (i.e., `setIsBuilding` not called a second time after completion)

**GREEN**
- [ ] Add `const buildTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);` to component state (near `lastLogIndexRef`)
- [ ] In `handleBuild`: replace bare `setTimeout(...)` with `buildTimeoutRef.current = setTimeout(...)`
- [ ] In the `pollInterval` callback, when `!status.isBuilding`: add `if (buildTimeoutRef.current) { clearTimeout(buildTimeoutRef.current); buildTimeoutRef.current = null; }` before `clearInterval(pollInterval)`
- [ ] Fix stale closure: replace `if (isBuilding)` inside the timeout callback with `if (buildTimeoutRef.current !== null)` as a proxy, or use a `isBuildingRef` mirroring the state

**REFACTOR**
- [ ] Apply the same fix to `handleBuildWindows` (line ~1854 has a 30-minute timeout with the same stale-closure issue)
- [ ] Confirm `buildTimeoutRef.current` is cleared on component unmount via `useEffect` cleanup

**Verification**
- [ ] Trigger a build that completes in < 10 minutes → no spurious "타임아웃" message appears
- [ ] `bun run build` exits 0

---

## Phase 2 (P2-4) — Parallelize stop-command PID loop in api-server.ts

**File**: `api-server.ts` (lines 338–368)

**Risk**: Low — affects web mode only (Tauri uses Rust). The sequential `for...of` loop sends SIGTERM to each PID, waits 200ms, checks, then proceeds to the next. For N processes this takes N×200ms minimum.

**Current code** (lines 338–367):
```ts
for (const pid of pids) {
  const termProc = spawn({ cmd: ["kill", "-15", pid], ... });
  await termProc.exited;
  await new Promise(resolve => setTimeout(resolve, 200));  // sequential wait
  const checkProc = spawn({ cmd: ["kill", "-0", pid], ... });
  await checkProc.exited;
  if (checkProc.exitCode === 0) {
    spawn({ cmd: ["kill", "-9", pid], ... });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  killedPids.push(pid);
}
```

**RED**
- [ ] Write test in `api-server.test.ts`: mock `spawn` to resolve immediately, assert that stopping 3 PIDs completes in under 250ms (not 3×200ms = 600ms)

**GREEN**
- [ ] Replace sequential loop with `Promise.all`:
  ```ts
  const killOnePid = async (pid: string): Promise<void> => {
    const termProc = spawn({ cmd: ["kill", "-15", pid], stdout: "pipe", stderr: "pipe" });
    await termProc.exited;
    await new Promise(r => setTimeout(r, 200));
    const checkProc = spawn({ cmd: ["kill", "-0", pid], stdout: "pipe", stderr: "pipe" });
    await checkProc.exited;
    if (checkProc.exitCode === 0) {
      spawn({ cmd: ["kill", "-9", pid], stdout: "inherit", stderr: "inherit" });
      await new Promise(r => setTimeout(r, 100));
    }
    killedPids.push(pid);
  };
  await Promise.all(pids.map(killOnePid));
  ```
- [ ] Note: `killedPids.push(pid)` inside concurrent callbacks is safe because JS is single-threaded (no mutex needed)

**REFACTOR**
- [ ] Apply the same parallel pattern to the force-restart-command PID kill loop (lines 444–447) — though that loop already uses fire-and-forget `spawn(...)` without await, so it may already be effectively parallel
- [ ] Consider extracting `killOnePid` as a module-level helper for reuse

**Verification**
- [ ] `bun api-server.ts` starts without error
- [ ] Stop a port that has multiple PIDs — all are killed within ~300ms
- [ ] `bun test` passes

---

## Phase 3 (P3-1) — Extract API adapter to `src/lib/api.ts`

**File**: `src/App.tsx` (lines 21–372, the `const API = { ... }` object)

**Risk**: Very low — pure file split, no logic change.

**RED**
- [ ] Write test: `api_loadPorts_inTauriMode_callsInvoke` — mock `isTauri()` to return true, mock `invoke`, assert `invoke('load_ports')` is called
- [ ] Write test: `api_loadPorts_inWebMode_callsFetch`

**GREEN**
- [ ] Create `src/lib/` directory
- [ ] Create `src/lib/api.ts` — cut the entire `API` object from `App.tsx` and paste here, along with `isTauri()`, `isWindows()`, `execFileExt()`, `isHtmlFile()`
- [ ] In `App.tsx`: `import { API } from './lib/api';`
- [ ] `bun run build` exits 0

**REFACTOR**
- [ ] Export `isTauri` from `api.ts` as a named export (currently used in many places in `App.tsx`)
- [ ] Consider exporting `PortInfo` interface from a separate `src/types.ts` rather than defining it in `App.tsx`

**Verification**
- [ ] `bun run build` exits 0
- [ ] All API calls work in both Tauri and web modes

---

## Phase 3 (P3-2) — Add config constants file

**File**: new `src/lib/constants.ts`

**Risk**: Very low.

**GREEN** (no test needed for constants)
- [ ] Create `src/lib/constants.ts`:
  ```ts
  export const APP_BUNDLE_ID = 'com.portmanager.portmanager';
  export const BUILD_POLL_INTERVAL_MS = 1000;
  export const BUILD_TIMEOUT_MS = 600_000;       // 10 minutes
  export const WINDOWS_BUILD_TIMEOUT_MS = 1_800_000; // 30 minutes
  export const SIGTERM_WAIT_MS = 200;
  export const SIGKILL_CONFIRM_WAIT_MS = 100;
  export const FORCE_RESTART_WAIT_MS = 500;
  export const API_SERVER_PORT = 3001;
  ```
- [ ] Replace magic numbers in `App.tsx` with imports from `constants.ts`
- [ ] Replace `APP_DATA_DIR` construction in `api-server.ts` using `APP_BUNDLE_ID`

**REFACTOR**
- [ ] Do the same for the Rust side: add `const APP_DATA_SUBDIR: &str = "com.portmanager.portmanager";` if any hardcoded strings remain

**Verification**
- [ ] `bun run build` exits 0
- [ ] `grep -r "600000\|600_000\|1800000" src/` returns zero results (replaced by constants)

---

## Final Definition of Done

### Functionality (must all pass)
- [ ] `bun run tauri:dev` launches without Rust compile errors
- [ ] Start a `.command` server → `isRunning: true` state reflected
- [ ] Stop the server → `isRunning: false` state reflected
- [ ] Force-restart → server restarts with new PID
- [ ] Export ports → valid JSON file written
- [ ] Import ports → new entries merged without duplicates
- [ ] Push to Supabase → data visible in dashboard
- [ ] Pull from Supabase → local data merged (Model B: remote wins for known IDs)
- [ ] Build modal opens for App and DMG build types
- [ ] Search → badge count updates; filter tabs show correct per-type counts
- [ ] `bun run build` exits 0 (Vite + TypeScript strict)
- [ ] `cargo build` exits 0 (no warnings on Mutex lines)

### Code Quality
- [ ] Zero `unwrap()` calls on `Mutex::lock()` in `lib.rs`
- [ ] `ensure_app_data_dir` used at all 8+ call sites
- [ ] `spawn_command` private helper covers both `execute_command` and `force_restart_command`
- [ ] `handleBuildApp` and `handleBuildDmg` no longer exist — replaced by `handleBuild(type)`
- [ ] `getSearchFiltered()` no longer called anywhere — replaced by `searchFilteredPorts` useMemo
- [ ] Build timeout `setTimeout` handle stored in ref and cleared on early completion
- [ ] Stop-command PID loop is parallel (`Promise.all`)
- [ ] `src/lib/api.ts` exists and `App.tsx` no longer defines the `API` object inline

### Test Coverage
- [ ] `bun test` passes with zero failures
- [ ] Each new hook has at minimum: initial load test, mutation test, error path test

---

## Quick Reference

```bash
# Run all tests
bun test

# Watch mode during development
bun test --watch

# TypeScript check only
bun run build

# Rust compile check only (fast, no linking)
cargo check --manifest-path src-tauri/Cargo.toml

# Run with hot reload
bun run tauri:dev

# Check for remaining unwrap() on mutex lines
grep -n "lock().unwrap()" src-tauri/src/lib.rs

# Check getSearchFiltered still referenced
grep -n "getSearchFiltered" src/App.tsx

# Confirm handleBuildApp/handleBuildDmg removed
grep -n "handleBuildApp\|handleBuildDmg" src/App.tsx
```

---

## Risk Notes Per Item

| Item | Risk | Notes |
|------|------|-------|
| P1-1 Mutex fix | Low | Pure substitution, behavior identical in non-poisoned case |
| P1-2 ensure_app_data_dir | Low | Pure refactor, function is deterministic |
| P1-3 spawn_command | Medium | Contains `unsafe` block — verify setsid behavior unchanged |
| P1-4 usePortManager | Medium | Largest surface area; test with full add/edit/delete cycle |
| P1-5 useSupabaseSync | Medium | Auto-pull on startup order must be preserved (sets `hasInitiallyLoaded` after pull) |
| P2-1 handleBuild collapse | Low | 3 callers in JSX, straightforward |
| P2-2 getSearchFiltered | Low-Medium | Semantics differ from `displayedPorts` — read carefully before replacing |
| P2-3 timeout ref | Low | Stale closure bug fix; does not change happy path |
| P2-4 parallel stop | Low | Web mode only; Rust path unaffected |
| P3-1 api.ts extract | Very Low | File split only |
| P3-2 constants | Very Low | No logic |
