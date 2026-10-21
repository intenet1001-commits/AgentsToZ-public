/**
 * The Workroom's PTY on Windows.
 *
 * `aiTerminalService` already takes its spawn as an injectable dependency whose
 * whole surface is `{ pid, terminal: { write, resize, close }, exited, kill }`,
 * so this file only has to produce that shape from node-pty. Why node-pty, why
 * from disk, and why input bypasses its socket are all in `windowsPtyRuntime.ts`.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  WINDOWS_PTY_ENTRY,
  isConinPipePath,
  windowsPtyRuntimeSearchPaths,
  windowsTreeKillArgs,
} from './windowsPtyRuntime';

export interface WindowsPtyHandle {
  write(data: string): number;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface WindowsPtyChild {
  pid: number;
  terminal: WindowsPtyHandle;
  exited: Promise<number>;
  kill(signal?: number | string): void;
}

export interface WindowsPtySpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  terminal: {
    cols: number;
    rows: number;
    exit(): void;
    data(pty: WindowsPtyHandle, data: Uint8Array): void;
  };
}

/** The slice of node-pty this adapter uses. */
interface NodePtyModule {
  spawn(file: string, args: readonly string[], options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  }): NodePty;
}
interface NodePty {
  pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

type Loaded = { pty: NodePtyModule; fs: typeof import('node:fs') };

let loaded: Loaded | null | undefined;

/**
 * Loads node-pty from the first search path that has it.
 *
 * The `fs` handed back is the one node-pty's own `require` resolves, because
 * that is the object whose `openSync` has to be observed to learn the conin
 * descriptor. Patching the ESM `node:fs` namespace cannot work -- its properties
 * are read-only under Bun -- and patching a differently-rooted `require('fs')`
 * would be a no-op; both were measured.
 */
function loadRuntime(): Loaded | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  for (const root of windowsPtyRuntimeSearchPaths({
    execPath: process.execPath,
    moduleDir: import.meta.dir,
  })) {
    try {
      // `createRequire` needs a file inside the directory, not the directory.
      const require = createRequire(join(root, 'agentstoz-pty-loader.cjs'));
      const pty = require(`./${WINDOWS_PTY_ENTRY.split('\\').join('/')}`) as NodePtyModule;
      if (typeof pty?.spawn !== 'function') continue;
      loaded = { pty, fs: require('fs') as typeof import('node:fs') };
      break;
    } catch {
      // Missing or unusable in this location; try the next one. A Workroom that
      // cannot find its runtime reports that, it does not crash the sidecar.
    }
  }
  return loaded;
}

/** Whether a Windows Workroom session can be started at all. */
export function windowsPtyAvailable(): boolean {
  return process.platform === 'win32' && loadRuntime() !== null;
}

/** Forgets the cached runtime. Tests only. */
export function resetWindowsPtyRuntimeCache(): void {
  loaded = undefined;
}

export const WINDOWS_PTY_RUNTIME_MISSING =
  'Windows 워크룸 터미널 런타임을 찾지 못했습니다. 앱을 다시 설치하거나 업데이트해 주세요.';

/**
 * Starts one PTY session. `args[0]` is the executable, as in the POSIX path.
 */
export function spawnWindowsPty(
  args: readonly string[],
  options: WindowsPtySpawnOptions,
): WindowsPtyChild {
  const runtime = loadRuntime();
  if (!runtime) throw new Error(WINDOWS_PTY_RUNTIME_MISSING);
  const [file, ...rest] = args;
  if (!file) throw new Error('워크룸 실행 파일이 비어 있습니다.');

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env[key] = value;

  // node-pty opens conin exactly once, inside spawn. Observe only that call and
  // restore immediately, so no unrelated file operation is ever routed through
  // this wrapper.
  const fs = runtime.fs as { openSync: typeof import('node:fs').openSync };
  const realOpenSync = fs.openSync;
  let coninFd: number | undefined;
  let child: NodePty;
  try {
    fs.openSync = ((path: never, ...tail: never[]) => {
      const fd = (realOpenSync as (...a: never[]) => number)(path, ...tail);
      if (isConinPipePath(path)) coninFd = fd;
      return fd;
    }) as typeof import('node:fs').openSync;
    child = runtime.pty.spawn(file, rest, {
      name: 'xterm-256color',
      cols: options.terminal.cols,
      rows: options.terminal.rows,
      cwd: options.cwd,
      env,
    });
  } finally {
    fs.openSync = realOpenSync;
  }

  let closed = false;
  let exitedAlready = false;
  const encoder = new TextEncoder();
  const handle: WindowsPtyHandle = {
    write(data: string): number {
      if (closed || coninFd === undefined) return 0;
      try {
        return runtime.fs.writeSync(coninFd, data);
      } catch {
        // The session is gone; the caller learns that from the exit fence, not
        // from a throw in the middle of a keystroke.
        return 0;
      }
    },
    resize(cols: number, rows: number): void {
      if (closed) return;
      child.resize(cols, rows);
    },
    close(): void {
      if (closed) return;
      closed = true;
      // The caller closes the terminal from its exit handler too, and node-pty's
      // kill queries the console process list on the way out -- on a process
      // that has already gone that writes "AttachConsole failed" to stderr,
      // which would land in the sidecar log on every single session close.
      if (exitedAlready) return;
      // node-pty owns the descriptor it opened; closing it here would make its
      // own teardown write to a freed fd.
      try { child.kill(); } catch { /* already exited */ }
    },
  };

  let settle!: (code: number) => void;
  const exited = new Promise<number>(resolve => { settle = resolve; });
  child.onData(chunk => { options.terminal.data(handle, encoder.encode(chunk)); });
  child.onExit(({ exitCode }) => {
    exitedAlready = true;
    options.terminal.exit();
    settle(exitCode);
  });

  return {
    pid: child.pid,
    terminal: handle,
    exited,
    kill(signal?: number | string): void {
      windowsSignalTree(child.pid, typeof signal === 'string' ? signal : 'SIGTERM');
    },
  };
}

/**
 * Signals a PTY session's whole tree. Fire and forget: the caller already polls
 * for exit and escalates, and a blocking wait here would stall the sidecar.
 */
export function windowsSignalTree(pid: number, signal: string): void {
  try {
    Bun.spawn(windowsTreeKillArgs(pid, signal) as string[], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    });
  } catch {
    // Nothing to stop, or taskkill is unavailable; exit detection still applies.
  }
}
