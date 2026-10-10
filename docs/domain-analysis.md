# Domain Analysis: portmanagement Refactoring

## Overview

The portmanagement app is a macOS-native desktop application (Tauri 2 + React + TypeScript + Bun) that manages local development server processes. Its primary job is to register, start, stop, and monitor dev server processes identified by port number and launch scripts, with secondary capabilities for cross-device sync via Supabase, workspace folder management, Claude Code integration, and self-build/distribution.

The codebase review identified a **God Component problem**: one 3,084-line React component houses all state and logic that belongs to five distinct bounded contexts.

---

## Actors

| Actor | Role | Primary Use Cases |
|---|---|---|
| Developer (local) | Runs and monitors dev servers on their machine | Start/Stop/Restart server, View logs, Open in browser/terminal |
| Developer (multi-device) | Syncs project registry across Macs | Push ports to Supabase, Pull/merge from Supabase |
| Claude Code Agent | AI assistant reading/writing ports.json | Batch AI name generation (aiName field) |
| CI/Build System | Automated Tauri build pipeline | Build .app, Build DMG, Export DMG to Desktop |
| macOS (OS actor) | Process lifecycle, file system, shell | lsof, kill, osascript, iTerm, Terminal |

---

## Bounded Context Map

```
Port Management (Core)
  ← uses → Supabase Sync (Customer-Supplier: Sync consumes PortInfo)
  ← uses → Workspace Management (Conformist: Workspace provides folder paths)
  ← uses → Claude Integration (Supporting: reads PortInfo.folderPath, worktreePath)
  ← uses → Build System (Standalone: no dependency on other contexts)
```

---

## Bounded Context 1: Port Management (Core)

### Aggregate: Port

**Root Entity: `PortInfo`**

| Field | Type | Invariant |
|---|---|---|
| `id` | string | `Date.now().toString()` (→ should be `crypto.randomUUID()`) |
| `name` | string | Non-empty |
| `port` | number? | 1–65535 if present |
| `commandPath` | string? | Absolute path, mutually exclusive with `terminalCommand` at runtime |
| `terminalCommand` | string? | Non-empty shell command; takes precedence over `commandPath` |
| `folderPath` | string? | Absolute path; auto-derived from `commandPath` parent if absent |
| `deployUrl` | string? | https URL |
| `githubUrl` | string? | https URL |
| `worktreePath` | string? | Comma-separated git worktree paths |
| `category` | string? | User-defined label |
| `description` | string? | Free-form |
| `aiName` | string? | AI-generated 2–4 word alias; idempotent, never overwritten once set |
| `isRunning` | boolean | **Always device-local; never synced to Supabase; reset to false on load** |

**Aggregate: ProcessRegistry (Rust)**

- `processes: Mutex<HashMap<PortId, Pid>>` — in-memory PID tracking
- **P1 issue**: `.lock().unwrap()` at `lib.rs:340,356,536,663` → must use `.unwrap_or_else(|e| e.into_inner())`

### Domain Services

**ProcessSpawner** — encapsulates ~80-line spawn block. Used by both `execute_command` and `force_restart_command`.
- **P1 issue**: currently duplicated verbatim
- Target: `fn spawn_command(port_id, command_path, app_handle, state) -> Result<Pid, String>`

**PortScanner** — wraps `lsof -ti :port` to collect PIDs

**PathEnricher** — builds augmented PATH (cargo, bun, homebrew, etc.)

### Use Cases

1. **RegisterPort** — Add port entry, auto-derive folderPath
2. **EditPort** — Update metadata
3. **DeletePort** — Remove entry + auto-push
4. **ExecuteCommand** — chmod+x, spawn bash with setsid, redirect to log file, store PID
5. **StopCommand** — lsof PIDs → SIGTERM → 200ms → SIGKILL; **P2 issue**: sequential loop, should be `Promise.all`
6. **ForceRestartCommand** — SIGKILL all + 500ms wait + re-spawn
7. **CheckPortStatus** — `lsof -ti :port` → boolean
8. **RefreshPortStatuses** — reload disk + recheck all statuses
9. **OpenPortInBrowser** — `open -a "Google Chrome"` 
10. **OpenProjectFolder** — `open` in Finder
11. **ViewProcessLog** — Terminal.app `tail -f logs/{portId}.log`
12. **ImportPorts / ExportPorts** — JSON file dialog
13. **DetectPortFromCommandFile** — parse `localhost:N` / `PORT=N` patterns
14. **ScanCommandFiles** — list .command/.bat/.sh/.html in folder

### Repository Interface

```typescript
interface PortRepository {
  loadAll(): Promise<PortInfo[]>
  saveAll(ports: PortInfo[]): Promise<void>
  importFromFile(filePath: string): Promise<PortInfo[]>
  exportToFile(filePath: string, ports: PortInfo[]): Promise<void>
}
```

---

## Bounded Context 2: Supabase Sync

Customer-Supplier: consumes `PortInfo[]` and `WorkspaceRoot[]` from Port Management.

### Key Concepts

- `SyncCredentials { supabaseUrl, supabaseAnonKey, deviceId }` — stored in `portal.json`, cached in localStorage
- `RemotePortRow` — snake_case Supabase row (anti-corruption layer mapping)
- **Model B Merge**: remote wins for known IDs, except `isRunning` (always local) and `aiName` (local wins if remote absent); local-only rows always survive

### Domain Service: PortSyncService

- `push(ports, credentials)` — upsert all rows; delete stale remote IDs only when `autopullSucceeded = true`
- `pull(credentials) → MergeResult` — fetch + Model B merge
- `autoPushDebounced(ports, credentials, delayMs=3000)`

### Invariants

- Delete pass on remote rows **MUST NOT run** if auto-pull has never succeeded
- `isRunning` is never written to Supabase
- `aiName` local value wins when remote is null/absent

### Use Cases

15. **AutoPullOnStartup** — fetch remote, Model B merge, set `hasInitiallyLoaded = true`
16. **AutoPushOnPortChange** — 3s debounce push after ports mutation
17. **ManualPushToSupabase** — upsert + delete stale
18. **ManualPullFromSupabase** — fetch + merge
19. **LoadPortalCredentials** — read from portal.json, fallback to localStorage

---

## Bounded Context 3: Workspace Management

### Aggregate: WorkspaceRoot

| Field | Invariant |
|---|---|
| `id` | `crypto.randomUUID()` |
| `name` | Non-empty, derived from directory basename |
| `path` | **Must be absolute** (starts with `/`) in Tauri mode |

### Use Cases

20. **AddWorkspaceRoot** — Tauri: native folder dialog; Web: `/api/pick-folder` via osascript
21. **RemoveWorkspaceRoot** — remove from list + cleanup
22. **CreateProjectFolder** — create subdirectory + optionally register as PortInfo
23. **ScanWorkspaceRoot** — list .command files within root path

---

## Bounded Context 4: Build System (Standalone)

### Aggregate: BuildJob (implicit, in api-server.ts globals)

| Field | Type |
|---|---|
| `buildType` | `'app' \| 'dmg'` |
| `isBuilding` | boolean |
| `output` | string[] |
| `exitCode` | number \| null |

**P2 issue**: `handleBuildApp` and `handleBuildDmg` are 55-line duplicates → collapse to `handleBuild(type)`

### Use Cases

24. **BuildApp** — `bun run tauri:build`, stream logs, poll `/api/build-status` every 1s
25. **BuildDmg** — `bun run tauri:build:dmg`, same polling loop
26. **ExportDmgToDesktop** — copy DMG from cargo-targets to ~/Desktop
27. **InstallAppToApplications** — copy .app to /Applications/
28. **OpenBuildFolder** — Finder reveal

---

## Bounded Context 5: Claude Integration (Supporting)

### Domain Services

**ClaudeSessionLauncher**
- `openTmuxSession(item, mode: 'attach'|'fresh'|'bypass', worktreePaths)` — iTerm2 AppleScript
- `openTerminalSession(item, mode: 'normal'|'bypass', worktreePaths)`

**ClaudeAuthMonitor**
- `checkStatus() → { installed, authenticated, email }` — polls every 30s
- `copyAiNamePrompt()` — clipboard

---

## Refactoring Map: Issues to Bounded Contexts

| Issue | Context | Refactoring Action |
|---|---|---|
| P1-1: God Component (3,084 lines, 35+ useState) | All 5 contexts | Extract `usePortManager` + `useSupabaseSync` + `useBuildManager` + `useToast` hooks |
| P1-2: ~80-line spawn block duplicated in Rust | Port Management | Extract `fn spawn_command(...)` private helper |
| P1-3: `unwrap()` on Mutex lock × 4 | Port Management (ProcessRegistry) | `.unwrap_or_else(\|e\| e.into_inner())` at lib.rs:340,356,536,663 |
| P2-4: 55-line build handler duplicates | Build System | `handleBuild(type: 'app'\|'dmg')` |
| P2-5: `app_data_dir` ensure-dir × 8 | Port Mgmt + Workspace | `fn ensure_app_data_dir(app_handle)` |
| P2-6: `getSearchFiltered()` raw in JSX render | Port Management | New `searchFilteredPorts` useMemo (distinct from `displayedPorts`) |
| P2-7: Sequential PID stop loop | Port Management (ProcessRegistry) | `Promise.all(pids.map(...))` in api-server.ts |

---

## Ubiquitous Language Glossary

| Term | Meaning |
|---|---|
| Port | A registered dev server entry identified by TCP port number, launch script, and project metadata |
| PortInfo | The canonical data record for a Port |
| CommandPath | Absolute path to .command/.bat/.sh/.html launch file |
| TerminalCommand | Raw shell command string; takes precedence over CommandPath at runtime |
| FolderPath | Project root directory; auto-derived from CommandPath parent if absent |
| isRunning | Live OS process state; device-local, never persisted to Supabase |
| ProcessRegistry | Rust `HashMap<PortId, Pid>` tracking PIDs for current session |
| spawn_command | (proposed) Private Rust helper encapsulating full process spawn lifecycle |
| AutoPull | On-startup Supabase fetch + Model B merge into local state |
| AutoPush | Debounced (3s) Supabase upsert after any ports mutation |
| Model B Merge | Remote wins for known IDs; local-only survive; isRunning always local; aiName local-wins if remote absent |
| autopullSucceeded | Guard preventing stale-ID delete pass until successful pull |
| WorkspaceRoot | Top-level directory containing multiple sub-projects |
| aiName | AI-generated 2–4 word English alias; idempotent, never overwritten once set |
| BuildType | `'app' \| 'dmg'` — determines Tauri build command |
| ensure_app_data_dir | (proposed) Rust helper that resolves + creates app data directory |
