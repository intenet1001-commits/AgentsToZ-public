# Implementation Plan: portmanagement Refactor

> Generated from codebase review findings. Addresses P1/P2 issues across Architecture, Quality, Performance, and Safety dimensions.

## Quick Start

```bash
# 1. Read this file to understand the full scope
# 2. Follow phases in order — each phase is independently shippable
# 3. Run tests after each phase: bun test
# 4. The full refactor is ~3–4 hours of focused work
```

---

## Summary of Changes

| Phase | Items | Effort | Risk |
|-------|-------|--------|------|
| **Phase 1** — Safety fixes (Rust) | 2 items | ~30 min | Low |
| **Phase 2** — Rust DRY + helpers | 2 items | ~45 min | Medium (unsafe block) |
| **Phase 3** — React hook extraction | 3 hooks | ~90 min | Medium |
| **Phase 4** — React P2 fixes | 4 items | ~30 min | Low |
| **Phase 5** — API server | 1 item | ~15 min | Low |
| **Phase 6** — Add tests | 64 tests | ~60 min | Low |

**Total estimated time: ~5 hours**

---

## Phase 1 — Safety Fixes (Rust) ✦ Do First

These are correctness bugs. No refactoring, pure mechanical fixes.

### 1a. Mutex Poison Recovery (`lib.rs`)

**Problem:** `.lock().unwrap()` at lines 340, 356, 536, 663. If any thread panics while holding the lock, all subsequent callers crash the Tauri process.

**Fix:** Replace all 4 occurrences:
```rust
// BEFORE
state.processes.lock().unwrap()

// AFTER
state.processes.lock().unwrap_or_else(|e| e.into_inner())
```

Files: `src-tauri/src/lib.rs:340, 356, 536, 663`

**Verification:** `cargo test` passes; no compile errors.

---

### 1b. Extract `ensure_app_data_dir` Helper (`lib.rs`)

**Problem:** The `app_data_dir()` + `create_dir_all()` pattern is copied 8 times across `load_ports`, `save_ports`, `execute_command`, `force_restart_command`, and portal/log commands.

**New private function:**
```rust
fn ensure_app_data_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    Ok(data_dir)
}
```

Then replace each inline occurrence with `let data_dir = ensure_app_data_dir(&app_handle)?;`

**Verification:** All 8 callers compile and behave identically; `bun run tauri:dev` launches.

---

## Phase 2 — Rust Spawn Helper

### 2a. Extract `spawn_command` Private Helper (`lib.rs`)

**Problem:** ~80-line block is duplicated verbatim in `execute_command` (lines ~280–344) and `force_restart_command` (lines ~600–665). Includes an `unsafe` block (`pre_exec`/`setsid`).

**New private function signature:**
```rust
fn spawn_command(
    port_id: &str,
    command_path: &str,
    app_handle: &tauri::AppHandle,
    state: &tauri::State<AppState>,
) -> Result<u32, String>
```

**Contains:**
- PATH construction (9 entries: cargo, bun, homebrew, nvm, etc.)
- `chmod +x` (for file paths)
- `is_file_path` branching (direct exec vs bash wrapper)
- Log file setup via `ensure_app_data_dir`
- `unsafe { cmd.pre_exec(|| { libc::setsid(); Ok(()) }) }`
- `cmd.spawn()` + PID HashMap insert

**After extraction:**
```rust
#[tauri::command]
async fn execute_command(port_id: String, command_path: String, ...) -> Result<u32, String> {
    spawn_command(&port_id, &command_path, &app_handle, &state)
}

#[tauri::command]
async fn force_restart_command(port_id: String, port: u16, command_path: String, ...) -> Result<String, String> {
    // Step 1: Kill all PIDs
    // Step 2: Sleep 500ms
    // Step 3: Delegate to spawn_command
    let new_pid = spawn_command(&port_id, &command_path, &app_handle, &state)?;
    Ok(format!("Restarted with PID {}", new_pid))
}
```

**Verification:** Both execute and force-restart work end-to-end via UI; log files created; PID tracked.

---

## Phase 3 — React Hook Extraction (Biggest Change)

Extract 4 hooks from `App.tsx` (currently 3,084 lines → target ~750 lines).

### New file structure:
```
src/
  hooks/
    usePortManager.ts     (~600 lines extracted)
    useSupabaseSync.ts    (~200 lines extracted)
    useBuildManager.ts    (~120 lines extracted)
    useToast.ts           (~15 lines extracted)
  App.tsx                 (~750 lines remaining)
```

### 3a. Extract `useToast` (start here — zero dependencies)

**Extracts from App.tsx:**
- `toasts` useState
- `showToast` function

```typescript
// src/hooks/useToast.ts
export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);
  return { toasts, showToast };
}
```

### 3b. Extract `usePortManager`

**Extracts from App.tsx (~L565–1582):**
- All port-related useState: `ports`, `editingId`, form fields (name/port/commandPath/terminalCommand/folderPath/deployUrl/githubUrl/worktreePath/category/description), edit fields, filter/sort state
- `handleAddPort`, `handleDeletePort`, `startEdit`, `cancelEdit`, `handleSaveEdit`
- `executeCommand`, `stopCommand`, `forceRestartCommand`
- `handleRefresh`, `handleImport`, `handleExport`
- `loadPortsFromAPI` initial load effect
- `displayedPorts` useMemo
- `searchFilteredPorts` useMemo (for badge counts — distinct from displayedPorts)

**Interface:**
```typescript
export function usePortManager(showToast: (msg: string, type: 'success'|'error') => void) {
  // ... returns:
  return {
    ports, displayedPorts, searchFilteredPorts,
    addPort, deletePort, startEdit, cancelEdit, saveEdit,
    executeCommand, stopCommand, forceRestartCommand,
    handleRefresh, handleImport, handleExport,
    editingId, formState, setFormState,
    filterType, setFilterType, filterCategory, setFilterCategory,
    searchQuery, setSearchQuery,
    sortBy, setSortBy, sortOrder, setSortOrder,
    isLoading,
  };
}
```

### 3c. Extract `useSupabaseSync`

**Extracts from App.tsx (~Supabase sections):**
- `handlePushToSupabase`, `handleRestoreFromSupabase`
- Auto-push 3s debounce effect
- `portalConfigRef`
- Startup auto-pull logic
- `isSyncing`, `lastSyncTime` state

**Interface:**
```typescript
export function useSupabaseSync(
  ports: PortInfo[],
  setPorts: (ports: PortInfo[]) => void,
  showToast: (msg: string, type: 'success'|'error') => void
) {
  return {
    handlePushToSupabase,
    handleRestoreFromSupabase,
    isSyncing,
    lastSyncTime,
  };
}
```

### 3d. Extract `useBuildManager`

**Extracts from App.tsx:**
- `handleBuildApp` + `handleBuildDmg` collapsed into `handleBuild(type: 'app'|'dmg')`
- `isBuilding`, `buildLogs`, `buildType`, `showBuildModal` state
- Poll interval + timeout ref (with proper cleanup)

**Interface:**
```typescript
export function useBuildManager(showToast: ...) {
  return {
    handleBuild,   // (type: 'app' | 'dmg' | 'windows') => void
    isBuilding,
    buildLogs,
    buildType,
    showBuildModal,
    setShowBuildModal,
  };
}
```

---

## Phase 4 — React P2 Quick Fixes

These are all small, independent changes in `App.tsx`.

### 4a. Fix `searchFilteredPorts` for badge counts (App.tsx:2582, 2628)

**Problem:** `getSearchFiltered()` is called raw in JSX (bypasses memoization). Also, it computes search-only results — intentionally different from `displayedPorts` which applies all filters.

**Fix:** Add a second useMemo in `usePortManager` (or App.tsx):
```typescript
const searchFilteredPorts = useMemo(
  () => ports.filter(p => matchesSearch(p, searchQuery)),
  [ports, searchQuery]
);
```
Replace `getSearchFiltered()` calls at lines 2582, 2628 with `searchFilteredPorts`.

### 4b. Cancel build timeout on completion (App.tsx)

**Problem:** 10-minute `setTimeout` holds stale `isBuilding` closure in memory after build completes.

**Fix:**
```typescript
const buildTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

// Inside poll: on completion
clearInterval(pollInterval);
if (buildTimeoutRef.current) clearTimeout(buildTimeoutRef.current);

// The timeout:
buildTimeoutRef.current = setTimeout(() => { ... }, 600_000);
```

### 4c. Remove `handleCreateProjectFolder` duplicate branch (App.tsx)

Both Tauri and web branches execute identical code. Remove `if (isTauri())` wrapper — `API.createFolder` already handles the split.

### 4d. Remove 15 silent `catch {}` blocks

Replace empty catches with at minimum:
```typescript
catch (e) { console.debug('[context]', e); }
```
For user-visible failures (Chrome open, path check): call `showToast`.

---

## Phase 5 — API Server: Parallel PID Stop

**File:** `api-server.ts` lines 338–368 (`/api/stop-command` handler)

**Problem:** Sequential `for...of` loop — 3 PIDs = 600ms minimum wait.

**Fix:**
```typescript
// BEFORE (sequential)
for (const pid of pids) {
  await Bun.spawn(['kill', '-15', pid]).exited;
  await new Promise(r => setTimeout(r, 200));
  const check = Bun.spawn(['kill', '-0', pid]);
  await check.exited;
  if (check.exitCode === 0) await Bun.spawn(['kill', '-9', pid]).exited;
}

// AFTER (parallel)
await Promise.all(pids.map(async (pid) => {
  await Bun.spawn(['kill', '-15', String(pid)]).exited;
  await new Promise(r => setTimeout(r, 200));
  const check = Bun.spawn(['kill', '-0', String(pid)]);
  await check.exited;
  if (check.exitCode === 0) {
    await Bun.spawn(['kill', '-9', String(pid)]).exited;
  }
}));
```

Result: Stop latency = `~200ms` for any number of PIDs (instead of `N × 200ms`).

---

## Phase 6 — Add Tests

**Test file locations:**
```
src/
  __tests__/
    mergePorts.test.ts           (8 tests — pure function)
    detectPortFromContent.test.ts (6 tests — pure function)
    applyFiltersAndSort.test.ts  (11 tests — includes RED test for .sort() mutation bug)
    usePortManager.test.ts       (13 tests — hook behavior)
    useSupabaseSync.test.ts      (6 tests — merge + push column mapping)
src-tauri/src/
  tests.rs                       (10 Rust unit tests)
tests/
  api-server.test.ts             (8 integration tests against real Bun.serve)
```

**Prerequisites before writing tests:**
1. Export `mergePorts` from App.tsx (or the new hook file)
2. Extract `detectPortFromContent(content: string)` from api-server route handler
3. Extract `applyFiltersAndSort(ports, opts)` from useMemo body — also fixes `.sort()` mutation bug
4. Export `getSessionName` helper

**Run tests:**
```bash
bun test                    # all tests
bun test src/__tests__      # React unit tests only
bun test tests/api-server   # integration tests only
```

---

## Definition of Done

- [ ] `cargo test` passes (Rust)
- [ ] `bun test` passes (TypeScript)
- [ ] `bun run tauri:dev` launches without errors
- [ ] Port start/stop/force-restart works end-to-end
- [ ] Supabase push/pull works end-to-end
- [ ] Build modal works for both app and DMG
- [ ] App.tsx is under 1,000 lines
- [ ] `lib.rs` has no `.lock().unwrap()` calls
- [ ] `lib.rs` has `spawn_command` and `ensure_app_data_dir` helpers
- [ ] No duplicate `handleBuildApp`/`handleBuildDmg` functions

---

## Files Created by This Plan

```
docs/
  PLAN.md                      ← This file (quick start guide)
  domain-analysis.md           ← Bounded contexts, entities, use cases
  architecture.md              ← Clean Architecture layers + interfaces
  tdd-strategy.md              ← 64 test cases, Given/When/Then
  implementation-checklist.md  ← 121 checkboxes, Red-Green-Refactor per item
```

## Detailed References

- For exact line numbers and checkbox tracking → `implementation-checklist.md`
- For test case specs (Given/When/Then) → `tdd-strategy.md`
- For interface definitions and file structure → `architecture.md`
- For domain concepts and bounded contexts → `domain-analysis.md`
