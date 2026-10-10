/**
 * Where the Workroom's Windows PTY lives, and how it is driven.
 *
 * Bun has no Windows PTY of its own: `Bun.spawn({ terminal })` fails with
 * "terminal option is not supported on this platform" (measured on 1.3.12), so
 * the Workroom refused to start a session there at all. ConPTY driven straight
 * through `bun:ffi` got as far as a live HPCON that accepted `ResizePseudoConsole`
 * and an attribute list that `CreateProcessW` provably consumed, yet the child
 * never attached to the pseudoconsole across seven variants (handle inheritance
 * on and off, structures in JS memory and in VirtualAlloc pages, FreeConsole
 * first, our handle copies closed and kept, the HPCON passed by value and by
 * address). That is unexplained, so the PTY comes from node-pty, which is the
 * ConPTY wrapper Windows terminals already rely on.
 *
 * Two Windows-only facts shape everything here, both measured:
 *
 *  1. **node-pty's input socket is dead under Bun.** It opens the conin pipe with
 *     `fs.openSync` -- that works, and the pipe reports EBUSY to anyone else,
 *     proving a live handle -- then wraps the descriptor in `net.Socket({ fd })`.
 *     Writing to that socket throws ERR_SOCKET_CLOSED while the socket still
 *     reports `writable: true`. Output, resize and exit all work. So input must
 *     bypass the socket and go to the descriptor with `fs.writeSync`, which means
 *     observing the one `openSync` that opens conin.
 *
 *  2. **A compiled binary cannot carry the addon.** `bun build --compile` bundles
 *     node-pty's JavaScript happily and then fails at runtime with "Cannot find
 *     module './prebuilds/win32-x64//conpty.node'", because node-pty resolves the
 *     addon relative to its own module and the compiled module lives at a virtual
 *     path. So node-pty is loaded from disk beside the executable instead, where
 *     its own relative resolution still works.
 *
 * Everything in this module is a pure decision so it can be checked off Windows;
 * `windowsPty.ts` is the part that touches the process.
 */

import { join, win32 } from 'node:path';

/** Directory beside the sidecar executable that holds the on-disk PTY runtime. */
export const WINDOWS_PTY_RUNTIME_DIR = 'pty-runtime';

/** Entry node-pty is loaded through. A real path, so its relative requires resolve. */
export const WINDOWS_PTY_ENTRY = join('node-pty', 'lib', 'index.js');

/**
 * Addons that must ship. `conpty.node` is the ConPTY binding, `pty.node` carries
 * the shared exports node-pty's index pulls in, and `conpty_console_list.node`
 * backs the console-process list it queries while tearing a session down.
 *
 * Deliberately absent: `conpty/OpenConsole.exe`, `conpty/conpty.dll`,
 * `winpty.dll` and `winpty-agent.exe`. The session measured here reported
 * `_useConptyDll: false`, meaning it drove the **operating system's** ConPTY, and
 * the full round trip passed with only the three files below present (999KB with
 * node-pty's `lib`, against 2.5MB including Microsoft's console host). Shipping
 * no third-party executable also keeps the signing surface unchanged. winpty is
 * the pre-1809 fallback, which this app's supported Windows versions never need.
 */
export const WINDOWS_PTY_NATIVE_FILES = Object.freeze([
  'conpty.node',
  'conpty_console_list.node',
  'pty.node',
] as const);

/** Subdirectory node-pty looks in, keyed by platform and architecture. */
export function windowsPtyPrebuildDir(platform: string = process.platform, arch: string = process.arch): string {
  return join('prebuilds', `${platform}-${arch}`);
}

const PACKAGED_API_NAME_RE = /^agentstoz-api-sidecar(?:\.exe)?$/i;

/**
 * Directories to look for the runtime in, most specific first.
 *
 * A packaged sidecar finds it beside itself. A source run (`bun api-server.ts`,
 * `bun run dev`) finds the installed package under `node_modules`, so the same
 * code path serves both without a build step.
 */
export function windowsPtyRuntimeSearchPaths(input: {
  execPath: string;
  moduleDir: string;
}): readonly string[] {
  // These are Windows paths: build them with Windows rules on every host so the decision stays checkable off
  // Windows (on Windows `node:path` already is win32, so nothing changes there).
  const { dirname, join: winJoin } = win32;
  const paths: string[] = [];
  const packaged = PACKAGED_API_NAME_RE.test(basenameOf(input.execPath));
  if (packaged) paths.push(winJoin(dirname(input.execPath), WINDOWS_PTY_RUNTIME_DIR));
  // A compiled binary under another name (a test fixture, a renamed copy) still
  // gets the adjacent directory as a candidate; it is only ever read.
  const adjacent = winJoin(dirname(input.execPath), WINDOWS_PTY_RUNTIME_DIR);
  if (!paths.includes(adjacent)) paths.push(adjacent);
  paths.push(winJoin(input.moduleDir, '..', 'node_modules'));
  return Object.freeze(paths);
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * The conin pipe node-pty opens for a ConPTY session.
 *
 * Matched rather than reconstructed: the name carries a high-resolution id
 * (`conpty-6659701.1242703805-in`) that is not derivable from anything node-pty
 * exposes -- `agent._pty` was `1` for that session. The prefix is deliberately
 * anchored at the pipe namespace so an unrelated `openSync` during spawn, or a
 * project path that merely contains the word, can never be mistaken for it.
 */
export function isConinPipePath(path: unknown): path is string {
  return typeof path === 'string' && /^\\\\[.?]\\pipe\\conpty-[^\\/]*-in$/.test(path);
}

/**
 * Tree termination for a PTY session.
 *
 * The POSIX path signals the process group with `process.kill(-pid, …)`, which
 * Windows has no equivalent for: a negative pid is simply not a Windows concept,
 * so the CLI's own children (an agent's helpers, a spawned shell) would survive.
 * `taskkill /T` is the native tree kill. The graceful/forceful split is kept so
 * the caller's SIGTERM-then-SIGKILL escalation still means something: without
 * `/F` a console process is asked to close, with it the tree is terminated.
 */
export function windowsTreeKillArgs(pid: number, signal: string): readonly string[] {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid for tree kill: ${pid}`);
  const forceful = signal === 'SIGKILL' || signal === 'SIGQUIT';
  return Object.freeze([
    'taskkill.exe',
    ...(forceful ? ['/F'] : []),
    '/T',
    '/PID',
    String(pid),
  ]);
}
