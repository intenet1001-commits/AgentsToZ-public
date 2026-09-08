import { execFile, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { isWorktreePortCandidate } from './worktreePortScheme';

export const WORKTREE_LSOF_TIMEOUT_MS = 2_000;
export const WORKTREE_LSOF_OUTPUT_BYTES = 1024 * 1024;
export const WORKTREE_LSOF_MAX_PIDS = 2_048;
export const WORKTREE_LSOF_MAX_PORTS = 16_384;

type DiscoveryErrorCode = 'WORKTREE_PORT_DISCOVERY_TIMEOUT' | 'WORKTREE_PORT_DISCOVERY_OUTPUT_LIMIT'
  | 'WORKTREE_PORT_DISCOVERY_FAILED' | 'WORKTREE_PORT_DISCOVERY_INVALID_OUTPUT';
class WorktreePortDiscoveryError extends Error {
  constructor(readonly code: DiscoveryErrorCode) {
    super(code);
  }
}

/** Bounded, shell-free child execution. Only this probe's child is ever killed. */
export function runWorktreeLsof(
  executable: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxBufferBytes?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? WORKTREE_LSOF_TIMEOUT_MS;
  const maxBuffer = options.maxBufferBytes ?? WORKTREE_LSOF_OUTPUT_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxBuffer) || maxBuffer < 1) {
    return Promise.reject(new WorktreePortDiscoveryError('WORKTREE_PORT_DISCOVERY_FAILED'));
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    let settled = false;
    const finish = (error: WorktreePortDiscoveryError | null, output = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(hardStop);
      if (error) reject(error); else resolve(output);
    };
    // execFile normally settles after SIGKILL. Still close owned pipes and
    // release callers if an abnormal descendant retains a pipe descriptor.
    const hardStop = setTimeout(() => {
      child?.kill('SIGKILL');
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      finish(new WorktreePortDiscoveryError('WORKTREE_PORT_DISCOVERY_TIMEOUT'));
    }, timeoutMs + 250);
    try {
      child = execFile(executable, [...args], {
        encoding: 'buffer', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer,
        // macOS lsof hex-escapes Korean bytes under the C locale, even in -F0.
        env: { ...process.env, LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8' },
      }, (error, stdout, stderr) => {
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          finish(new WorktreePortDiscoveryError('WORKTREE_PORT_DISCOVERY_OUTPUT_LIMIT'));
        } else if (error && !(error.code === 1 && stdout.length === 0 && stderr.length === 0)) {
          finish(new WorktreePortDiscoveryError(error.killed
            ? 'WORKTREE_PORT_DISCOVERY_TIMEOUT' : 'WORKTREE_PORT_DISCOVERY_FAILED'));
        } else {
          try { finish(null, new TextDecoder('utf-8', { fatal: true }).decode(stdout)); }
          catch { finish(new WorktreePortDiscoveryError('WORKTREE_PORT_DISCOVERY_INVALID_OUTPUT')); }
        }
      });
      child.stdin?.end();
    } catch {
      finish(new WorktreePortDiscoveryError('WORKTREE_PORT_DISCOVERY_FAILED'));
    }
  });
}

function fields(output: string): string[] {
  if (Buffer.byteLength(output) > WORKTREE_LSOF_OUTPUT_BYTES) {
    throw new WorktreePortDiscoveryError('WORKTREE_PORT_DISCOVERY_OUTPUT_LIMIT');
  }
  // -F0 uses NUL field terminators and a newline between process/file records.
  // Do not trim field values: spaces/newlines may be part of a directory name.
  if (output && !/\0\n*$/.test(output)) throw new WorktreePortDiscoveryError('WORKTREE_PORT_DISCOVERY_INVALID_OUTPUT');
  return output.split('\0').map(field => field.replace(/^\n+/, '')).filter(Boolean);
}

function pid(value: string): string | null {
  return /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2_147_483_647 ? value : null;
}

function listeningPorts(output: string): Map<string, Set<number>> {
  const byPid = new Map<string, Set<number>>();
  let currentPid: string | null = null;
  let ports = 0;
  for (const field of fields(output)) {
    if (field[0] === 'p') currentPid = pid(field.slice(1));
    if (field[0] !== 'n' || !currentPid || field.includes('->')) continue;
    const match = /:(\d{1,5})$/.exec(field.slice(1));
    const port = match ? Number(match[1]) : 0;
    if (port < 10001 || port > 59999) continue;
    const values = byPid.get(currentPid) ?? new Set<number>();
    if (!values.has(port)) ports++;
    values.add(port);
    byPid.set(currentPid, values);
    if (byPid.size > WORKTREE_LSOF_MAX_PIDS || ports > WORKTREE_LSOF_MAX_PORTS) {
      throw new WorktreePortDiscoveryError('WORKTREE_PORT_DISCOVERY_OUTPUT_LIMIT');
    }
  }
  return byPid;
}

function processDirectories(output: string, expected: ReadonlyMap<string, unknown>): Map<string, string> {
  const result = new Map<string, string>();
  let currentPid: string | null = null;
  let descriptor: string | null = null;
  for (const field of fields(output)) {
    if (field[0] === 'p') { currentPid = pid(field.slice(1)); descriptor = null; }
    else if (field[0] === 'f') descriptor = field.slice(1);
    else if (field[0] === 'n' && currentPid && expected.has(currentPid) && descriptor === 'cwd') {
      const cwd = field.slice(1);
      if (isAbsolute(cwd) && !cwd.endsWith(' (deleted)')) result.set(currentPid, cwd);
    }
  }
  return result;
}

export function createWorktreePortDiscovery(input: {
  executable: string;
  run?: (args: readonly string[]) => Promise<string>;
}) {
  const run = input.run ?? ((args: readonly string[]) => runWorktreeLsof(input.executable, args));
  const capture = async () => {
    const ports = listeningPorts(await run(['-nP', '-iTCP:10001-59999', '-sTCP:LISTEN', '-F0pn']));
    const directories = ports.size === 0 ? new Map<string, string>() : processDirectories(
      await run(['-nP', '-a', '-p', [...ports.keys()].join(','), '-d', 'cwd', '-F0pfn']), ports,
    );
    return { ports, directories };
  };
  let inFlight: ReturnType<typeof capture> | null = null;
  return {
    async findPort(folderPath: string, mainPort?: number | null): Promise<number | null> {
      if (!isAbsolute(folderPath)) return null;
      if (!inFlight) {
        const pending = capture().finally(() => { if (inFlight === pending) inFlight = null; });
        inFlight = pending;
      }
      const snapshot = await inFlight;
      for (const [processId, ports] of snapshot.ports) {
        const cwd = snapshot.directories.get(processId);
        if (!cwd || !(cwd === folderPath || cwd.startsWith(folderPath + '/'))) continue;
        // A PID can listen on both an MCP port and a worktree development port.
        for (const port of ports) if (isWorktreePortCandidate(port, mainPort)) return port;
      }
      return null;
    },
  };
}
