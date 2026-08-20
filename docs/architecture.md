# Architecture Design: portmanagement Refactor

## Overview

The current codebase has two central problems:

1. **App.tsx god-component** — 1700+ lines mixing port CRUD state, Supabase sync logic, build polling, form state, and all event handlers in one React function component.
2. **lib.rs copy-paste duplication** — `execute_command` and `force_restart_command` share 60+ lines of identical spawn logic (log-file setup, PATH construction, `setsid` pre-exec, PID tracking) with no shared helper.

The refactor applies Clean Architecture separation: hooks extract stateful concerns from the render tree, and a private Rust helper eliminates the spawn duplication. No new external dependencies are introduced.

---

## Target File Structure

```
portmanagement/
├── src/
│   ├── hooks/
│   │   ├── usePortManager.ts          # P1-1: port CRUD + isRunning state
│   │   ├── useSupabaseSync.ts         # P1-2: push / pull / auto-sync
│   │   ├── useBuildManager.ts         # P2-5: unified build handler
│   │   └── useToast.ts                # extracted toast helper
│   ├── lib/
│   │   ├── api.ts                     # existing API object (unchanged, extract from App.tsx)
│   │   ├── supabaseClient.ts          # getSupabaseClient + getPortalCredentials
│   │   ├── portUtils.ts               # mergePorts, getSessionName, withTimeout, isTauri, isWindows
│   │   └── types.ts                   # PortInfo, WorkspaceRoot, WorktreeInfo, Toast, SortType
│   ├── components/
│   │   └── (existing: PortalManager, etc. — unchanged)
│   └── App.tsx                        # thin orchestrator: composes hooks, renders UI
│
└── src-tauri/src/
    └── lib.rs                         # Rust backend
        # Changes:
        #   + fn spawn_command(...)    # P1-3: private helper
        #   ~ execute_command()        # delegates spawn to helper
        #   ~ force_restart_command()  # delegates spawn to helper
        #   ~ ensure_app_data_dir()    # P2-6: extracted path helper
        #   ~ 4x .unwrap() → .unwrap_or_else()  # P1-4: Mutex poison safety
```

---

## Layer Separation

```
┌──────────────────────────────────────────────┐
│  App.tsx  (Presentation / Orchestration)      │  renders JSX, wires hooks together
├──────────────────────────────────────────────┤
│  hooks/  (Application State)                  │  stateful logic, side effects
│  usePortManager · useSupabaseSync             │
│  useBuildManager · useToast                   │
├──────────────────────────────────────────────┤
│  lib/  (Pure Logic / Adapters)                │  no React, no state
│  api.ts · supabaseClient.ts · portUtils.ts   │
├──────────────────────────────────────────────┤
│  src-tauri/src/lib.rs  (System)               │  Rust commands + helpers
└──────────────────────────────────────────────┘
```

Dependency direction: `App.tsx` → `hooks/` → `lib/` → (Tauri IPC / fetch). Nothing in `lib/` imports from `hooks/` or `App.tsx`.

---

## P1-1: `usePortManager` Hook

**Extracts from App.tsx lines 566–1582:**
- All `ports` state and derived values
- `addPort`, `deletePort`, `startEdit`, `cancelEdit`, `saveEdit`
- `executeCommand`, `stopCommand`, `forceRestartCommand`
- `handleRefresh`, `handleExportPorts`, `handleImportPorts`
- The `displayedPorts` memoization (P2-7)
- Initial load `useEffect` with retry logic and auto port-status check
- Persist-on-change `useEffect` (save to disk when ports mutates)
- Focus-reload `useEffect` (web mode only)

```typescript
// src/hooks/usePortManager.ts

interface UsePortManagerOptions {
  onAutoPull: (remoteRows: PortInfo[]) => void;  // called by useSupabaseSync after pull
  showToast: (msg: string, type: 'success' | 'error') => void;
}

interface UsePortManagerReturn {
  // State
  ports: PortInfo[];
  setPorts: React.Dispatch<React.SetStateAction<PortInfo[]>>;
  isLoading: boolean;
  isRefreshing: boolean;

  // Form state (add)
  addForm: AddPortForm;
  setAddForm: React.Dispatch<React.SetStateAction<AddPortForm>>;

  // Edit state
  editingId: string | null;
  editForm: EditPortForm;
  setEditForm: React.Dispatch<React.SetStateAction<EditPortForm>>;

  // Derived
  displayedPorts: PortInfo[];          // P2-7: memoized filtered+sorted list

  // Guards (used by useSupabaseSync)
  hasInitiallyLoaded: React.MutableRefObject<boolean>;
  autopullSucceeded: React.MutableRefObject<boolean>;
  skipNextSave: React.MutableRefObject<boolean>;

  // Handlers
  addPort: () => void;
  deletePort: (id: string) => void;
  startEdit: (item: PortInfo) => void;
  cancelEdit: () => void;
  saveEdit: () => void;
  executeCommand: (item: PortInfo) => Promise<void>;
  stopCommand: (item: PortInfo) => Promise<void>;
  forceRestartCommand: (item: PortInfo) => Promise<void>;
  handleRefresh: () => Promise<void>;
  handleExportPorts: () => Promise<void>;
  handleImportPorts: () => Promise<void>;
}

export function usePortManager(
  opts: UsePortManagerOptions,
  // Filter/sort params passed from App.tsx state
  sortBy: SortType,
  sortOrder: 'asc' | 'desc',
  filterType: 'all' | 'with-port' | 'without-port',
  filterCategory: string,
  searchQuery: string,
): UsePortManagerReturn
```

**Key design decisions:**
- `ports` and `setPorts` are owned here; App.tsx never calls `setPorts` directly — it uses the returned handler functions.
- `displayedPorts` is `useMemo([ports, sortBy, sortOrder, filterType, filterCategory, searchQuery])` — replaces the five inline `getSearchFiltered()` call sites in the render function (P2-7).
- `hasInitiallyLoaded`, `autopullSucceeded`, and `skipNextSave` are refs that `useSupabaseSync` reads via the returned object, keeping guard logic co-located with what it protects.

---

## P1-2: `useSupabaseSync` Hook

**Extracts from App.tsx lines 849–1015, 1347–1488:**
- `handleRestoreFromSupabase` (manual Pull)
- `handlePushToSupabase` (manual Push)
- Auto-push `useEffect` (3s debounce on `ports` change)
- Auto-pull called once at startup (wired from `usePortManager`'s load effect via `onAutoPull` callback)
- `getPortalCredentials`, `getSupabaseClient`, `mergePorts` moved to `lib/`

```typescript
// src/hooks/useSupabaseSync.ts

interface UseSupabaseSyncOptions {
  ports: PortInfo[];
  setPorts: React.Dispatch<React.SetStateAction<PortInfo[]>>;
  workspaceRoots: WorkspaceRoot[];
  setWorkspaceRoots: React.Dispatch<React.SetStateAction<WorkspaceRoot[]>>;
  hasInitiallyLoaded: React.MutableRefObject<boolean>;
  autopullSucceeded: React.MutableRefObject<boolean>;
  showToast: (msg: string, type: 'success' | 'error') => void;
}

interface UseSupabaseSyncReturn {
  isRestoring: boolean;
  isPushingPorts: boolean;
  handleRestoreFromSupabase: () => Promise<void>;
  handlePushToSupabase: () => Promise<void>;
  // Auto-push effect is internal — no return needed
}

export function useSupabaseSync(opts: UseSupabaseSyncOptions): UseSupabaseSyncReturn
```

**Key design decisions:**
- Auto-push effect lives entirely inside this hook. App.tsx has zero Supabase knowledge.
- `portalConfigRef` moves inside this hook — it is only read by sync logic, not by render.
- The pull-on-startup path is expressed as an exported async function `pullOnce()` called by `usePortManager`'s load effect via the `onAutoPull` callback, keeping startup sequencing (`hasInitiallyLoaded` gate, `autopullSucceeded` flag) in one place.

---

## P2-5: `useBuildManager` Hook

**Extracts from App.tsx lines 1584–1694:**
- `handleBuildApp` and `handleBuildDmg` collapsed into `handleBuild(type: 'app' | 'dmg' | 'windows')`
- Build polling interval and timeout logic
- `isBuilding`, `showBuildLog`, `buildLogs`, `buildType`, `lastLogIndexRef` state

```typescript
// src/hooks/useBuildManager.ts

interface UseBuildManagerReturn {
  isBuilding: boolean;
  showBuildLog: boolean;
  setShowBuildLog: React.Dispatch<React.SetStateAction<boolean>>;
  buildLogs: string[];
  buildType: 'app' | 'dmg' | 'windows';
  handleBuild: (type: 'app' | 'dmg' | 'windows') => Promise<void>;
}

export function useBuildManager(
  showToast: (msg: string, type: 'success' | 'error') => void
): UseBuildManagerReturn
```

**Collapsed handler — before vs after:**

Before (two nearly identical 50-line functions):
```typescript
handleBuildApp()  →  setBuildType('app'); ... API.buildApp('app'); poll...
handleBuildDmg()  →  setBuildType('dmg'); ... API.buildDmg();     poll...
```

After (one parameterized function):
```typescript
handleBuild(type: 'app' | 'dmg' | 'windows') {
  setBuildType(type);
  setBuildLogs([`${type.toUpperCase()} 빌드를 시작합니다...`]);
  lastLogIndexRef.current = 0;
  setShowBuildLog(true);
  setIsBuilding(true);
  const message = await API.buildApp(type);  // API.buildApp already accepts type string
  // single poll loop below — identical for all types
}
```

---

## `useToast` Hook

Small extraction to remove the `toasts` array and `showToast` closure from App.tsx:

```typescript
// src/hooks/useToast.ts

interface UseToastReturn {
  toasts: Toast[];
  showToast: (message: string, type?: 'success' | 'error') => void;
  dismissToast: (id: number) => void;
}

export function useToast(): UseToastReturn
```

---

## P1-3: Rust `spawn_command` Private Helper

**Problem:** `execute_command` (lib.rs:190–346) and `force_restart_command` (lib.rs:473–668) share:
- HTML-file early-return branch
- `ensure_app_data_dir` / log-file creation (P2-6)
- chmod logic
- PATH construction (9 entries)
- `setsid` pre-exec unsafe block
- `cmd.spawn()` + PID insertion into HashMap

```rust
// src-tauri/src/lib.rs

/// Private helper: spawn a bash command, redirect stdout+stderr to portId.log,
/// register PID in the process map, return the new PID.
///
/// `command_path` may be an absolute file path or a raw shell command string.
/// Caller is responsible for killing existing processes before calling this.
fn spawn_command(
    port_id: &str,
    command_path: &str,
    app_handle: &tauri::AppHandle,
    state: &State<AppState>,
) -> Result<u32, String> {
    // 1. Validate file path if absolute
    // 2. ensure_app_data_dir (P2-6) → get logs_dir
    // 3. Open log file (append mode) for stdout + stderr
    // 4. chmod +x (file path only)
    // 5. Build PATH with 9 standard additions
    // 6. cmd.pre_exec(setsid) + spawn
    // 7. state.processes.lock().unwrap_or_else(|e| e.into_inner()).insert(port_id, pid)
    // 8. Return pid
}
```

After extraction, the two public commands become:

```rust
#[tauri::command]
fn execute_command(port_id, command_path, state, app_handle) -> Result<String, String> {
    if command_path.ends_with(".html") { return open_html(&command_path); }
    let pid = spawn_command(&port_id, &command_path, &app_handle, &state)?;
    Ok(format!("Started process with PID: {}", pid))
}

#[tauri::command]
fn force_restart_command(port_id, port, command_path, state, app_handle) -> Result<String, String> {
    if command_path.ends_with(".html") { return open_html(&command_path); }
    kill_port_pids(port, &port_id, &state);          // existing kill logic
    std::thread::sleep(Duration::from_millis(500));
    let pid = spawn_command(&port_id, &command_path, &app_handle, &state)?;
    Ok(format!("Force restarted on port {} with new PID: {}", port, pid))
}
```

Lines saved: ~120 lines of duplication eliminated.

---

## P2-6: Rust `ensure_app_data_dir` Helper

**Problem:** Six commands repeat identical `app_data_dir` resolution + `create_dir_all` pattern:
`load_ports`, `save_ports`, `load_portal`, `save_portal`, `load_workspace_roots`, `save_workspace_roots`, `execute_command`, `force_restart_command`.

```rust
/// Returns the app data directory, creating it if absent.
fn ensure_app_data_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }
    Ok(dir)
}
```

Each of the eight call sites becomes one line:
```rust
let app_data_dir = ensure_app_data_dir(&app_handle)?;
```

---

## P1-4: Mutex Poison Safety

**Problem:** Four `.unwrap()` calls on `state.processes.lock()` at lines 340, 356, 536, 663. If any thread panics while holding the lock, all subsequent calls will also panic via lock poisoning.

**Fix:** Replace `.unwrap()` with `.unwrap_or_else(|e| e.into_inner())` — the poisoned guard still contains valid data, so recovery is always safe here (no invariant to uphold beyond PID tracking).

```rust
// Before (4 sites):
let mut processes = state.processes.lock().unwrap();

// After (all 4 sites):
let mut processes = state.processes.lock().unwrap_or_else(|e| e.into_inner());
```

Affected lines: 340 (`execute_command` insert), 356 (`stop_command` remove), 536 (`force_restart_command` remove), 663 (`force_restart_command` insert).

---

## P2-7: Memoized `displayedPorts`

**Problem:** The render function calls `getSearchFiltered()` (or inline filter+sort) at least 5 times inside JSX. Each call re-runs the full filter+sort pipeline on every render.

**Fix:** Inside `usePortManager`, compute once with `useMemo`:

```typescript
const displayedPorts = useMemo(() => {
  let result = ports;
  // 1. filterType (all / with-port / without-port)
  if (filterType !== 'all') {
    result = result.filter(p => filterType === 'with-port' ? !!p.port : !p.port);
  }
  // 2. filterCategory
  if (filterCategory !== 'all') {
    result = result.filter(p => p.category === filterCategory);
  }
  // 3. searchQuery (name, aiName, port, folderPath basename)
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    result = result.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.aiName?.toLowerCase().includes(q) ||
      String(p.port ?? '').includes(q) ||
      p.folderPath?.split('/').pop()?.toLowerCase().includes(q)
    );
  }
  // 4. sort
  result = [...result].sort((a, b) => {
    let cmp = 0;
    if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
    else if (sortBy === 'port') cmp = (a.port ?? 0) - (b.port ?? 0);
    else cmp = Number(a.id) - Number(b.id);  // 'recent' = insertion order
    return sortOrder === 'asc' ? cmp : -cmp;
  });
  return result;
}, [ports, sortBy, sortOrder, filterType, filterCategory, searchQuery]);
```

App.tsx render: replace all `getSortedPorts(...)` / `getSearchFiltered(...)` calls with the single `displayedPorts` reference.

---

## P2-8: Parallel PID Kill Loop in api-server.ts

**Problem:** `api-server.ts` stop-command handler (lines 338–367) processes PIDs sequentially with two sequential `await` calls per PID: `await termProc.exited` + 200ms sleep + `await checkProc.exited`.

For N PIDs this is O(N × 300ms).

**Fix:** Run all PID kill operations in parallel via `Promise.all`:

```typescript
// Before:
for (const pid of pids) {
  const termProc = spawn({ cmd: ["kill", "-15", pid], ... });
  await termProc.exited;
  await new Promise(resolve => setTimeout(resolve, 200));
  const checkProc = spawn({ cmd: ["kill", "-0", pid], ... });
  await checkProc.exited;
  if (checkProc.exitCode === 0) {
    spawn({ cmd: ["kill", "-9", pid], ... });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  killedPids.push(pid);
}

// After:
await Promise.all(pids.map(async (pid) => {
  const termProc = spawn({ cmd: ["kill", "-15", pid], stdout: "pipe", stderr: "pipe" });
  await termProc.exited;
  await new Promise(resolve => setTimeout(resolve, 200));
  const checkProc = spawn({ cmd: ["kill", "-0", pid], stdout: "pipe", stderr: "pipe" });
  await checkProc.exited;
  if (checkProc.exitCode === 0) {
    const killProc = spawn({ cmd: ["kill", "-9", pid], stdout: "pipe", stderr: "pipe" });
    await killProc.exited;
  }
  killedPids.push(pid);
}));
```

Same semantics (SIGTERM → wait → SIGKILL if alive), now O(max single PID latency) instead of O(N × latency).

---

## Refactored App.tsx Structure (after)

```typescript
function App() {
  // ── Primitive UI state (stays in App) ────────────────────────────────
  const [activeTab, setActiveTab] = useState<'ports' | 'portal'>('ports');
  const [sortBy, setSortBy] = useState<SortType>(...);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(...);
  const [filterType, setFilterType] = useState<...>('all');
  const [filterCategory, setFilterCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [bypassPermissions, setBypassPermissions] = useState(false);
  const [worktreePickerState, setWorktreePickerState] = useState<...>(null);
  const [apiServerOnline, setApiServerOnline] = useState<boolean | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<...>(null);
  const [workspaceRoots, setWorkspaceRoots] = useState<WorkspaceRoot[]>([]);

  // ── Hooks ─────────────────────────────────────────────────────────────
  const { toasts, showToast, dismissToast } = useToast();

  const portManager = usePortManager(
    { onAutoPull: ..., showToast },
    sortBy, sortOrder, filterType, filterCategory, searchQuery
  );

  const supabaseSync = useSupabaseSync({
    ports: portManager.ports,
    setPorts: portManager.setPorts,
    workspaceRoots, setWorkspaceRoots,
    hasInitiallyLoaded: portManager.hasInitiallyLoaded,
    autopullSucceeded: portManager.autopullSucceeded,
    showToast,
  });

  const buildManager = useBuildManager(showToast);

  // ── Render (JSX only) ─────────────────────────────────────────────────
  // Uses portManager.displayedPorts, supabaseSync.handlePushToSupabase, etc.
  return (...);
}
```

App.tsx drops from ~1700 lines to an estimated 700–800 lines (pure JSX + primitive UI state).

---

## SOLID Checklist

| Principle | Status | Evidence |
|-----------|--------|---------|
| **SRP** | Applied | `usePortManager` owns port state; `useSupabaseSync` owns remote sync; `useBuildManager` owns build pipeline. Each has one reason to change. |
| **OCP** | Applied | New sync provider (e.g. GitHub) = new hook alongside `useSupabaseSync`, no change to `usePortManager` or `App.tsx`. New build target = add `'windows'` to the type union in `useBuildManager`, no structural change. |
| **LSP** | Applied | `API` object already abstracts Tauri/web; hooks consume `API` methods without caring about the underlying transport. |
| **ISP** | Applied | `UsePortManagerReturn` does not expose sync methods; `UseSupabaseSyncReturn` does not expose port CRUD. App.tsx destructures only what it needs from each hook. |
| **DIP** | Applied | Hooks depend on the `API` abstraction (defined in `lib/api.ts`), not on `fetch` or `invoke` directly. The concrete transport is resolved inside `api.ts`. |

---

## Architecture Decision Records

| Decision | Choice | Reason |
|----------|--------|--------|
| Hook boundary: one hook per concern | `usePortManager` + `useSupabaseSync` + `useBuildManager` | Mirrors SRP; each hook has one clear change axis |
| `ports` state ownership | `usePortManager` owns `setPorts`; `useSupabaseSync` receives it as a prop | Sync is a consumer of port state, not an owner |
| `portalConfigRef` placement | Inside `useSupabaseSync` | Only sync logic reads it; removes App.tsx ref that existed solely for sync |
| Auto-pull wiring | `usePortManager` calls `pullOnce()` from `useSupabaseSync` via `onAutoPull` callback | Keeps startup sequencing (guard flags) in one hook while preserving dependency direction |
| `displayedPorts` memoization level | Inside `usePortManager`, not inline in App.tsx | Memoization co-located with the state it depends on; App.tsx render stays declarative |
| `spawn_command` as `fn` not `#[tauri::command]` | Private `fn` | Not exposed to frontend; only `execute_command` and `force_restart_command` are commands |
| `ensure_app_data_dir` as `fn` not `#[tauri::command]` | Private `fn` | Internal infrastructure, not a public command |
| Mutex poison recovery | `.unwrap_or_else(|e| e.into_inner())` | PID HashMap has no invariant; stale-but-intact data is always safe to recover |
| Stop-command parallelism | `Promise.all` in api-server.ts | Independent kill operations; no ordering dependency between PIDs |
| YAGNI: no Repository/Service layer | Direct API calls in hooks | Tauri app has no testable domain model needing mocking; extra abstraction would add indirection with no benefit |
