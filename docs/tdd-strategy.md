# TDD Strategy: portmanagement Refactoring

## Overview

The portmanagement app (Tauri 2 + React + TypeScript + Bun) currently has zero tests.
The refactoring targets are ordered by risk and testability:

- **P1a** `mergePorts` — pure function, highest ROI, test first
- **P1b** `detectPortFromContent` — pure parsing logic extracted from api-server route
- **P1c** `displayedPorts` filter+sort logic — pure, currently in useMemo
- **P1d** `usePortManager` hook — CRUD state management
- **P1e** `useSupabaseSync` hook — merge + push/pull orchestration
- **P1f** Rust `spawn_command` helper extraction — integration tests via `bun test` spawning the compiled binary
- **P1g** Rust Mutex poison recovery in `execute_command` / `stop_command`
- **P2a** `handleBuildApp` / `handleBuildDmg` — build state machine
- **P2b** `ensure_app_data_dir` Rust helper (extracted from 4 duplicated callsites)
- **P2c** `displayedPorts` memoization dep correctness
- **P2d** Parallel PID stop logic in `api-server.ts`

**Approach**: Bottom-up (pure functions → hooks → integration). All tests use `bun test`.
Side-effect boundaries (filesystem, Tauri invoke, Supabase) are kept out of unit tests via
Fake/stub injection.

---

## Test Pyramid Distribution

| Layer | Count (target) | Tooling |
|-------|---------------|---------|
| Unit (pure functions) | 28 | `bun test` |
| Unit (hooks via `@testing-library/react-hooks` or renderHook) | 18 | `bun test` |
| Rust unit tests (`#[cfg(test)]`) | 10 | `cargo test` |
| Integration (api-server routes via `fetch` against real Bun.serve) | 8 | `bun test` |
| E2E (Playwright/Tauri driver) | 0 — deferred | — |
| **Total** | **64** | |

---

## Mock / Fake Strategy

| Dependency | Strategy | Reason |
|-----------|---------|--------|
| `API.loadPorts` / `API.savePorts` | Fake (in-memory array closure) | Deterministic, no disk I/O |
| `API.checkPortStatus` | Stub returning `true`/`false` | Avoid real `lsof` in unit tests |
| `API.executeCommand` / `stopCommand` | Mock (jest-compatible spy via `bun test`) | Verify call count / args |
| Supabase client (`createClient`) | Fake object `{ from: () => fakeChain }` | No network, full control |
| `withTimeout` wrapper | Pass through in tests (short timeout) | Avoid flakiness |
| `localStorage` | Real `globalThis.localStorage` stub (jsdom) | Sort persistence tests |
| Rust `AppState.processes` Mutex | Direct struct construction in `#[cfg(test)]` | Test poison recovery inline |
| `lsof` / `kill` OS commands | Real — integration tests only (macOS CI) | Cannot mock OS process table |
| File system (`Bun.file`, `fs::write`) | Temp dir fixture (`mkdtemp`) in integration tests | Isolation |

---

## Test Case List (TDD Execution Order)

---

### Phase 1: Pure Function Unit Tests

**File: `tests/unit/mergePorts.test.ts`**

---

**Test 1: `mergePorts_emptyLocalAndRemote_returnsEmpty`**
```
Given: local = [], remote = []
When:  mergePorts(local, remote)
Then:  returns []
```
> Hint: trivial base case, but important to nail the return type contract.

---

**Test 2: `mergePorts_localOnly_preservesAllLocalRows`**
```
Given: local = [portA, portB], remote = []
When:  mergePorts(local, remote)
Then:  returns [portA, portB] (unchanged, same references)
```
> Hint: verifies local-only rows survive when remote is empty.

---

**Test 3: `mergePorts_remoteOnly_appendsNewRows`**
```
Given: local = [], remote = [portC, portD]
When:  mergePorts(local, remote)
Then:  returns [portC, portD]
```
> Hint: new-from-remote branch (`newFromRemote`).

---

**Test 4: `mergePorts_sharedId_remoteWinsForSyncedFields`**
```
Given:
  local  = [{ id: '1', name: 'old-name', port: 3000, isRunning: true, aiName: undefined }]
  remote = [{ id: '1', name: 'new-name', port: 4000, isRunning: false, aiName: undefined }]
When:  mergePorts(local, remote)
Then:
  result[0].name === 'new-name'   // remote wins
  result[0].port === 4000         // remote wins
  result[0].isRunning === true    // local wins (live process state)
```
> Hint: core "Model B merge" contract. `isRunning` must survive the spread.

---

**Test 5: `mergePorts_sharedId_localAiNamePreservedWhenRemoteHasNone`**
```
Given:
  local  = [{ id: '1', name: 'proj', aiName: 'port manager' }]
  remote = [{ id: '1', name: 'proj', aiName: undefined }]
When:  mergePorts(local, remote)
Then:  result[0].aiName === 'port manager'
```
> Hint: `r.aiName ?? p.aiName` — Supabase `ports` table has no `ai_name` column in some setups.

---

**Test 6: `mergePorts_sharedId_remoteAiNameWinsWhenPresent`**
```
Given:
  local  = [{ id: '1', aiName: 'old alias' }]
  remote = [{ id: '1', aiName: 'new alias' }]
When:  mergePorts(local, remote)
Then:  result[0].aiName === 'new alias'
```

---

**Test 7: `mergePorts_preservesOrderLocalFirstThenNewRemote`**
```
Given:
  local  = [{ id: '1' }, { id: '2' }]
  remote = [{ id: '2' }, { id: '3' }]  // id:3 is new
When:  mergePorts(local, remote)
Then:  result.map(p => p.id) deep-equals ['1', '2', '3']
```
> Hint: merged local array comes first, `newFromRemote` appended at end.

---

**Test 8: `mergePorts_doesNotMutateInputArrays`**
```
Given:
  local  = [{ id: '1', name: 'A' }]
  remote = [{ id: '1', name: 'B' }]
  (capture references before call)
When:  mergePorts(local, remote)
Then:
  local[0].name === 'A'   // original unchanged
  remote[0].name === 'B'  // original unchanged
```
> Hint: pure function contract — no side effects.

---

**File: `tests/unit/detectPortFromContent.test.ts`**

This tests the extracted pure parser (to be extracted from the `api-server.ts` route body
at lines 169-178 into a standalone function `detectPortFromContent(content: string): number | null`).

---

**Test 9: `detectPortFromContent_localhostPattern_returnsPort`**
```
Given: content = 'open http://localhost:3000'
When:  detectPortFromContent(content)
Then:  returns 3000
```

---

**Test 10: `detectPortFromContent_portEqualsPattern_returnsPort`**
```
Given: content = 'PORT=9005 bun run dev'
When:  detectPortFromContent(content)
Then:  returns 9005
```

---

**Test 11: `detectPortFromContent_lowercasePortPattern_returnsPort`**
```
Given: content = 'port=8080'
When:  detectPortFromContent(content)
Then:  returns 8080
```

---

**Test 12: `detectPortFromContent_noPattern_returnsNull`**
```
Given: content = 'echo hello world'
When:  detectPortFromContent(content)
Then:  returns null
```

---

**Test 13: `detectPortFromContent_localhostTakesPrecedenceOverPortEquals`**
```
Given: content = 'PORT=9000\nopen http://localhost:3001'
When:  detectPortFromContent(content)
Then:  returns 3001  // localhost match is checked first
```

---

**Test 14: `detectPortFromContent_emptyString_returnsNull`**
```
Given: content = ''
When:  detectPortFromContent(content)
Then:  returns null
```

---

**File: `tests/unit/displayedPorts.test.ts`**

Tests the extracted `applyFiltersAndSort` pure function (to be extracted from the `useMemo`
body at App.tsx lines 1976-2009).

Signature:
```ts
applyFiltersAndSort(
  ports: PortInfo[],
  opts: { searchQuery: string; filterType: FilterType; filterCategory: string; sortBy: SortType; sortOrder: 'asc' | 'desc' }
): PortInfo[]
```

---

**Test 15: `applyFiltersAndSort_emptyQuery_returnsAll`**
```
Given: ports = [A, B, C], searchQuery = ''
When:  applyFiltersAndSort(ports, { searchQuery: '', filterType: 'all', ... })
Then:  returns all 3 ports
```

---

**Test 16: `applyFiltersAndSort_searchByName_filtersCorrectly`**
```
Given: ports = [{ name: 'my-server' }, { name: 'other' }], searchQuery = 'my'
When:  applyFiltersAndSort(...)
Then:  returns only [{ name: 'my-server' }]
```

---

**Test 17: `applyFiltersAndSort_searchByAiName_matches`**
```
Given: ports = [{ name: 'proj', aiName: 'port manager' }], searchQuery = 'manager'
When:  applyFiltersAndSort(...)
Then:  returns the port
```

---

**Test 18: `applyFiltersAndSort_searchByPort_matches`**
```
Given: ports = [{ name: 'x', port: 3001 }], searchQuery = '300'
When:  applyFiltersAndSort(...)
Then:  returns the port (port.toString().includes('300'))
```

---

**Test 19: `applyFiltersAndSort_filterWithPort_excludesPortless`**
```
Given: ports = [{ port: 3000 }, { port: undefined }]
When:  applyFiltersAndSort(..., { filterType: 'with-port' })
Then:  returns only the port with port === 3000
```

---

**Test 20: `applyFiltersAndSort_filterWithoutPort_excludesPorted`**
```
Given: ports = [{ port: 3000 }, { port: undefined }]
When:  applyFiltersAndSort(..., { filterType: 'without-port' })
Then:  returns only the port with port === undefined
```

---

**Test 21: `applyFiltersAndSort_sortByName_ascOrder`**
```
Given: ports = [{ name: 'Z' }, { name: 'A' }, { name: 'M' }]
When:  applyFiltersAndSort(..., { sortBy: 'name', sortOrder: 'asc' })
Then:  result.map(p => p.name) deep-equals ['A', 'M', 'Z']
```

---

**Test 22: `applyFiltersAndSort_sortByName_descOrder`**
```
Given: ports = [{ name: 'Z' }, { name: 'A' }]
When:  applyFiltersAndSort(..., { sortBy: 'name', sortOrder: 'desc' })
Then:  result.map(p => p.name) deep-equals ['Z', 'A']
```

---

**Test 23: `applyFiltersAndSort_sortByPort_ascOrder`**
```
Given: ports = [{ port: 9000 }, { port: 3000 }, { port: undefined }]
When:  applyFiltersAndSort(..., { sortBy: 'port', sortOrder: 'asc' })
Then:  result[0].port === undefined (0) or 3000 — undefined treated as 0 per (a.port ?? 0)
```
> Hint: `undefined` ports sort to front when ascending (`?? 0`). Document this behavior.

---

**Test 24: `applyFiltersAndSort_filterCategory_uncategorized`**
```
Given: ports = [{ category: 'web' }, { category: undefined }]
When:  applyFiltersAndSort(..., { filterCategory: 'uncategorized' })
Then:  returns only the port with no category
```

---

**Test 25: `applyFiltersAndSort_doesNotMutateInputArray`**
```
Given: ports = [{ name: 'B' }, { name: 'A' }]  (original order captured)
When:  applyFiltersAndSort(..., { sortBy: 'name', sortOrder: 'asc' })
Then:  original ports array order is unchanged  // spread [...filtered].reverse() must not modify in place
```
> Hint: Current code does `[...filtered].reverse()` for desc which is safe, but `filtered.sort()` mutates `filtered`.
> This test will FAIL (RED) until the sort is wrapped: `[...filtered].sort(...)`.

---

**File: `tests/unit/getSessionName.test.ts`**

---

**Test 26: `getSessionName_withFolderPath_returnsBasename`**
```
Given: item = { name: 'My Project', folderPath: '/Users/me/projects/my-app' }
When:  getSessionName(item)
Then:  returns 'my-app'
```

---

**Test 27: `getSessionName_noFolderPath_returnsNameWithHyphens`**
```
Given: item = { name: 'My Project', folderPath: undefined }
When:  getSessionName(item)
Then:  returns 'My-Project'
```

---

**Test 28: `getSessionName_trailingSlashInFolderPath_handledCorrectly`**
```
Given: item = { name: 'X', folderPath: '/Users/me/projects/my-app/' }
When:  getSessionName(item)
Then:  returns 'my-app'  // trailing slash stripped via replace(/\/$/, '')
```

---

### Phase 2: Hook Unit Tests

**File: `tests/unit/usePortManager.test.ts`**

Uses `renderHook` from `@testing-library/react`.
All `API.*` calls are replaced by injected fake implementations.

---

**Test 29: `usePortManager_initialState_isLoadingTrue`**
```
Given: hook renders with fakeAPI.loadPorts = async () => []
When:  hook mounts
Then:  isLoading === true initially, then false after load
```

---

**Test 30: `usePortManager_loadPorts_populatesPorts`**
```
Given: fakeAPI.loadPorts returns [portA, portB]
When:  hook mounts and load completes
Then:  ports === [portA, portB]
```

---

**Test 31: `usePortManager_addPort_withName_appendsPort`**
```
Given: hook loaded with []
When:  addPort({ name: 'test', port: 3000 })
Then:
  ports.length === 1
  ports[0].name === 'test'
  ports[0].port === 3000
  ports[0].id is a non-empty string
  ports[0].isRunning === false
```

---

**Test 32: `usePortManager_addPort_withoutName_doesNotAdd`**
```
Given: hook loaded with []
When:  addPort({ name: '', port: 3000 })
Then:  ports.length === 0
```

---

**Test 33: `usePortManager_addPort_commandPathSet_autoExtractsFolderPath`**
```
Given: addPort called with { name: 'p', commandPath: '/a/b/c/start.command', folderPath: '' }
When:  port is added
Then:  ports[0].folderPath === '/a/b/c'
```

---

**Test 34: `usePortManager_deletePort_removesCorrectPort`**
```
Given: ports = [{ id: '1' }, { id: '2' }]
When:  deletePort('1')
Then:  ports.length === 1, ports[0].id === '2'
```

---

**Test 35: `usePortManager_saveEdit_updatesFields`**
```
Given: ports = [{ id: '1', name: 'Old', port: 3000 }]
When:  startEdit(ports[0]); then saveEdit({ name: 'New', port: 4000 })
Then:  ports[0].name === 'New', ports[0].port === 4000
```

---

**Test 36: `usePortManager_saveEdit_emptyName_doesNotSave`**
```
Given: ports = [{ id: '1', name: 'Original' }]
When:  startEdit(ports[0]); saveEdit({ name: '' })
Then:  ports[0].name === 'Original'
```

---

**Test 37: `usePortManager_cancelEdit_clearsEditState`**
```
Given: startEdit called with portA
When:  cancelEdit()
Then:  editingId === null, editName === ''
```

---

**Test 38: `usePortManager_executeCommand_setsIsRunningTrue`**
```
Given: ports = [{ id: '1', isRunning: false, commandPath: '/run.command' }]
       fakeAPI.executeCommand resolves successfully
When:  executeCommand(ports[0])
Then:  ports[0].isRunning === true
```

---

**Test 39: `usePortManager_executeCommand_noRunTarget_showsErrorToast`**
```
Given: ports = [{ id: '1', isRunning: false, commandPath: undefined, terminalCommand: undefined }]
When:  executeCommand(ports[0])
Then:
  fakeAPI.executeCommand was NOT called
  toasts contains an error toast
```

---

**Test 40: `usePortManager_stopCommand_setsIsRunningFalse`**
```
Given: ports = [{ id: '1', isRunning: true, port: 3000 }]
       fakeAPI.stopCommand resolves successfully
When:  stopCommand(ports[0])
Then:  ports[0].isRunning === false
```

---

**Test 41: `usePortManager_stopCommand_apiThrows_showsErrorToast`**
```
Given: fakeAPI.stopCommand rejects with Error('network error')
When:  stopCommand(ports[0])
Then:  ports[0].isRunning === true (unchanged), toasts contains error
```

---

**File: `tests/unit/useSupabaseSync.test.ts`**

---

**Test 42: `useSupabaseSync_pull_mergesRemoteIntoLocal`**
```
Given:
  local = [{ id: '1', name: 'local-name', isRunning: true }]
  fakeSupabase.from('ports').select() returns [{ id: '1', name: 'remote-name', is_running: false }]
When:  pull() called
Then:
  merged[0].name === 'remote-name'   // remote wins
  merged[0].isRunning === true       // local wins
```

---

**Test 43: `useSupabaseSync_pull_noCredentials_throwsOrToastsError`**
```
Given: supabaseUrl = '', supabaseAnonKey = ''
When:  pull()
Then:  fakeSupabase was NOT called, error toast shown
```

---

**Test 44: `useSupabaseSync_pull_emptyRemote_doesNotOverwriteLocal`**
```
Given: local = [portA, portB], fakeSupabase returns []
When:  pull()
Then:  local state unchanged (portA, portB still present)
```

---

**Test 45: `useSupabaseSync_push_callsUpsertWithCorrectMapping`**
```
Given:
  local = [{ id: '1', name: 'proj', port: 3000, commandPath: '/a.command',
             terminalCommand: 'bun run dev', folderPath: '/a',
             deployUrl: 'https://app.com', githubUrl: 'https://github.com/x' }]
When:  push()
Then:  fakeSupabase.upsert was called with row:
  { id: '1', name: 'proj', port: 3000, command_path: '/a.command',
    terminal_command: 'bun run dev', folder_path: '/a',
    deploy_url: 'https://app.com', github_url: 'https://github.com/x' }
  // NOTE: worktree_path must NOT be included (causes 400)
```

---

**Test 46: `useSupabaseSync_push_deletesStaleRemoteIds`**
```
Given:
  local = [{ id: '2' }]   // id:1 was deleted locally
  fakeSupabase.from('ports').select('id') returns [{ id: '1' }, { id: '2' }]
  autopullSucceeded = true
When:  push()
Then:  fakeSupabase.delete().in('id', ['1']) was called
```

---

**Test 47: `useSupabaseSync_push_skipsDeleteWhenAutopullNotSucceeded`**
```
Given: autopullSucceeded = false
When:  push()
Then:  fakeSupabase.delete was NOT called
```
> Hint: Fix P2g gate. Critical regression guard.

---

### Phase 3: Rust Unit Tests

**File: `src-tauri/src/lib.rs` (inside `#[cfg(test)]` module)**

---

**Test 48: `ensure_app_data_dir_creates_missing_dir`**
```
Given: temp dir that does not exist at path
When:  ensure_app_data_dir(&path)
Then:  directory now exists on disk
```
> Hint: Extract `ensure_app_data_dir(path: &Path) -> Result<(), String>` from all 4 duplicated blocks.

---

**Test 49: `ensure_app_data_dir_idempotent_when_already_exists`**
```
Given: directory already exists
When:  ensure_app_data_dir(&path)
Then:  returns Ok(()) without error
```

---

**Test 50: `spawn_command_helper_filePath_returnsChildPid`**
```
Given: a valid shell script that sleeps 1 second
When:  spawn_command("/path/to/sleep.sh", &log_path, &home)
Then:  returns Ok(pid) where pid > 0
       child process is running (kill -0 pid succeeds)
```
> Hint: Extract `spawn_command(command: &str, is_file_path: bool, log_file: &Path, home: &str) -> Result<u32, String>`.

---

**Test 51: `spawn_command_helper_rawCommand_echoes`**
```
Given: raw_command = "echo hello"
When:  spawn_command_raw("echo hello", &log_path, &home)
Then:  returns Ok(pid), log file eventually contains "hello"
```

---

**Test 52: `spawn_command_helper_nonexistentFile_returnsErr`**
```
Given: command_path = "/nonexistent/path.command", is_file_path = true
When:  spawn_command(...)
Then:  returns Err containing "Command file not found"
```

---

**Test 53: `processes_mutex_poisonRecovery_continuesAfterPanic`**
```
Given:
  state = AppState { processes: Mutex::new(HashMap::new()) }
  a thread panics while holding the lock
When:  state.processes.lock() is called from another thread
Then:  poison error is recovered via .unwrap_or_else(|e| e.into_inner())
       operation continues without panic
```
> Hint: Current code: `.lock().unwrap()` — will propagate panic on poison.
> Fix: `.lock().unwrap_or_else(|e| e.into_inner())`.

---

**Test 54: `stop_command_noProcessOnPort_returnsAlreadyStopped`**
```
Given: port 59999 has no process listening (guaranteed in test)
When:  stop_command("test-id", 59999, &state)
Then:  returns Ok("No process running on port 59999 (already stopped)")
       does not panic or return Err
```

---

**Test 55: `stop_command_emptyPortZero_doesNotCallLsof`**
```
Given: port = 0, state.processes = empty
When:  stop_command("id", 0, &state)
Then:  returns Ok (no crash on port 0)
```
> Hint: `lsof -ti :0` on macOS returns nothing — test ensures graceful handling.

---

**Test 56: `load_ports_missingFile_returnsEmptyVec`**
```
Given: ports.json does not exist in temp app_data_dir
When:  load_ports_from_dir(&temp_dir)
Then:  returns Ok(vec![])
```
> Hint: Extract `load_ports_from_dir(dir: &Path)` helper for testability.

---

**Test 57: `save_then_load_roundtrip_preservesAllFields`**
```
Given: a PortInfo with all optional fields populated
When:  save_ports_to_dir(&dir, &[port_info]) then load_ports_from_dir(&dir)
Then:  loaded[0] == original (all fields match including Option fields)
```

---

### Phase 4: Integration Tests

**File: `tests/integration/api-server.test.ts`**

Starts a real `Bun.serve` instance on a random port. Tests hit the HTTP API directly.
Uses a temp directory for `APP_DATA_DIR` via env override.

---

**Test 58: `GET /api/ports_emptyDataDir_returns200EmptyArray`**
```
Given: APP_DATA_DIR points to empty temp dir, server running
When:  fetch('GET /api/ports')
Then:  status 200, body = []
```

---

**Test 59: `POST /api/ports_validArray_persistsAndReturnsSuccess`**
```
Given: server running with temp data dir
When:  fetch('POST /api/ports', body=[{ id:'1', name:'test', port:3000 }])
Then:
  response = { success: true }
  subsequent GET /api/ports returns [{ id:'1', ... }]
```

---

**Test 60: `POST /api/detect-port_localhostPattern_returnsPort`**
```
Given: temp .command file containing 'open http://localhost:5173'
When:  fetch('POST /api/detect-port', { filePath })
Then:  response.detectedPort === 5173, response.folderPath === dirname(filePath)
```

---

**Test 61: `POST /api/detect-port_missingFile_returns404`**
```
Given: filePath = '/nonexistent/file.command'
When:  fetch('POST /api/detect-port', { filePath })
Then:  status 404
```

---

**Test 62: `POST /api/stop-command_missingPortId_returns400`**
```
Given: request body = { port: 3000 }  // portId missing
When:  fetch('POST /api/stop-command', body)
Then:  status 400, body.error contains 'Missing portId'
```

---

**Test 63: `POST /api/stop-command_noProcessOnPort_returns200WithKilledPids`**
```
Given: port with no process (e.g., 59998)
When:  fetch('POST /api/stop-command', { portId: 'x', port: 59998 })
Then:  status 200, response.killedPids = [] or response.success = true
       (does not error on idle port)
```

---

**Test 64: `POST /api/execute-command_thenStop_processLifecycle`**
```
Given: a real .command file that starts a long-running process (e.g., 'sleep 10')
When:
  1. POST /api/execute-command -> starts process, records in executableProcesses map
  2. POST /api/stop-command -> kills process
Then:
  After stop: kill -0 <pid> returns non-zero (process is dead)
  Response from stop: success = true
```
> This is a true integration test — runs real processes. macOS-only (CI flag: `if (process.platform !== 'darwin') skip`).

---

## Edge Case List

| Case | Description | Expected Behavior |
|------|-------------|------------------|
| `mergePorts` with duplicate IDs in `remote` | Remote has two rows with same ID | Last one wins (Map construction behavior — document as known) |
| `mergePorts` local has `isRunning: undefined` | Not explicitly set | Treated as falsy — remote value ignored, undefined preserved |
| `detectPortFromContent` with port > 65535 | e.g., `localhost:99999` | Returns 99999 (no validation in parser — caller's responsibility) |
| `applyFiltersAndSort` with `sortBy: 'recent'` | Default insertion order | Returns filtered array in original order (no sort applied) |
| `applyFiltersAndSort` both `filterType` and `filterCategory` active | Compound filter | Filters are AND-ed (filterCategory applied after filterType) |
| `addPort` with `port: '0'` | Parsed as `parseInt('0')` = 0 | Port stored as 0, not undefined — should be treated as "no port" |
| `stop_command` Rust with port = 0 | `lsof -ti :0` | Returns empty, no crash |
| Mutex poison in `execute_command` | Thread panics mid-lock | Currently panics (`.unwrap()`). P1g fix: use `.unwrap_or_else` |
| `handleBuildApp` called while `isBuilding` is true | Guard at top of handler | Second invocation is a no-op (early return) |
| `withTimeout` expiry during auto-pull | 10s elapsed, Supabase slow | Catches rejection, shows toast, sets `hasInitiallyLoaded = true` |
| Supabase push `worktree_path` field inclusion | Column does not exist in `ports` table | Must NOT be included in push rows (causes 400) |
| `displayedPorts` sort mutation | `filtered.sort()` mutates array | Currently mutates `filtered` which is a `.filter()` result (new array) but see Test 25 |

---

## Test Data Strategy

| Type | Valid Example | Invalid / Edge Example |
|------|--------------|----------------------|
| `PortInfo.id` | `'1706000000000'` (timestamp string), `crypto.randomUUID()` | `''` (empty — never generated but guard in mergePorts) |
| `PortInfo.port` | `3000`, `9005`, `undefined` | `0` (treated as no-port), `99999` (no OS validation) |
| `PortInfo.commandPath` | `'/Users/me/project/start.command'`, `'bun run dev'` (raw) | `''` (empty string → treated as falsy) |
| `.command file content` | `'open http://localhost:3000'`, `'PORT=9005 bun run start'` | `'echo hello'` (no port), `''` (empty) |
| `searchQuery` | `'my-app'`, `'3001'`, `'manager'` | `'  '` (whitespace — trimmed to empty → no filter) |
| Supabase credentials | `{ supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'eyJ...' }` | `{ supabaseUrl: '', supabaseAnonKey: '' }` → no-op |
| `sortBy` | `'name'`, `'port'`, `'recent'` | Unknown string → falls to `default:` (no sort, treated as `recent`) |
| Rust `port: u16` | `3000u16`, `9005u16` | `0u16` (lsof edge case), `65535u16` |
| Rust `command_path` is-file-path heuristic | `'/absolute/path.command'` starts with `/` | `'~'` prefix, `'bun run dev'` (raw command, no file check) |

---

## Recommended File Layout

```
portmanagement/
  tests/
    unit/
      mergePorts.test.ts          # Tests 1-8
      detectPortFromContent.test.ts  # Tests 9-14
      applyFiltersAndSort.test.ts # Tests 15-25
      getSessionName.test.ts      # Tests 26-28
      usePortManager.test.ts      # Tests 29-41
      useSupabaseSync.test.ts     # Tests 42-47
    integration/
      api-server.test.ts          # Tests 58-64
  src-tauri/src/
    lib.rs                        # Tests 48-57 inside #[cfg(test)] mod tests { }
```

## Refactoring Prerequisites (functions to extract before writing tests)

Before Phase 1 tests can run, the following extractions must happen:

1. **`detectPortFromContent(content: string): number | null`**
   Extract from `api-server.ts` route handler (lines 169-178). Pure function, no I/O.

2. **`applyFiltersAndSort(ports, opts): PortInfo[]`**
   Extract from `App.tsx` `useMemo` body (lines 1977-2008). Wrap `filtered.sort()` in `[...filtered].sort()`.

3. **`getSessionName(item: PortInfo): string`**
   Already a standalone function (App.tsx line 489). Just export it.

4. **`mergePorts`**
   Already a standalone function (App.tsx line 510). Just export it.

5. **Rust `ensure_app_data_dir(path: &Path) -> Result<(), String>`**
   Extract from the 4 duplicated `if !app_data_dir.exists() { fs::create_dir_all... }` blocks.

6. **Rust `spawn_command(cmd: &str, is_file_path: bool, log: &Path, home: &str) -> Result<u32, String>`**
   Extract shared body of `execute_command` and `force_restart_command` (currently ~40 duplicated lines).

7. **Rust Mutex poison fix**
   Replace all `.lock().unwrap()` with `.lock().unwrap_or_else(|e| e.into_inner())`.
