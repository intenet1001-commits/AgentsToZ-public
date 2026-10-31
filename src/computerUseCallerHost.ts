/**
 * Which app an MCP connection's AI runs in, for one purpose only: computer use never sends input into the caller's own
 * host app (the terminal, Orca, desktop app or AgentsToZ window it runs in). It is read from the connection's process
 * ancestry when the connection registers — the loopback peer port → the one other process holding that socket → its
 * parent chain → every enclosing `.app` bundle — never from a request field. It only ever refuses: knowing the host
 * authorizes nothing, and a host that cannot be read is `unknown`, which refuses application scopes and desktop input.
 */
import {execFile} from 'node:child_process';

export type ComputerCallerHost = {state: 'known'; bundleIds: readonly string[]} | {state: 'unknown'; reason: string};
export interface ComputerCallerOrigin {peerPort: number}
export type ComputerCallerHostResolver = (origin: ComputerCallerOrigin | null) => Promise<ComputerCallerHost>;

const BUNDLE_ID = /^[A-Za-z0-9.-]{1,200}$/;
const MAX_DEPTH = 64;
export const unknownCallerHost = (reason: string): ComputerCallerHost => ({state: 'unknown', reason});

/** Only a loopback TCP peer has a socket this Mac can trace; anything else has no origin. */
export function computerCallerOrigin(peer: {address?: string; port?: number} | null | undefined): ComputerCallerOrigin | null {
  if (!peer || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(peer.address))) return null;
  return Number.isSafeInteger(peer.port) && peer.port! > 0 && peer.port! < 65_536 ? {peerPort: peer.port!} : null;
}
/** `lsof -F p` field output: one `p<pid>` line per process. The server's own end of the socket is not the caller. */
export function lsofPeerPids(text: string, ownPid: number): number[] {
  const pids = new Set<number>();
  for (const line of text.split('\n')) {
    const match = /^p(\d{1,10})$/.exec(line.trim());
    if (match && Number(match[1]) !== ownPid && Number(match[1]) > 0) pids.add(Number(match[1]));
  }
  return [...pids];
}
/** `ps -A -o pid=,ppid=,comm=` rows; on macOS `comm` is the executable's full path and may contain spaces. */
export function psProcessTable(text: string): Map<number, {ppid: number; command: string}> {
  const table = new Map<number, {ppid: number; command: string}>();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d{1,10})\s+(\d{1,10})\s(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), {ppid: Number(match[2]), command: match[3]!.trim()});
  }
  return table;
}
/** The outermost bundle an executable lives in: a helper app nested inside another app belongs to that app. */
export function outermostAppPath(command: string): string | null {
  if (!command.startsWith('/')) return null;
  const end = command.indexOf('.app/');
  return end > 0 ? command.slice(0, end + 4) : null;
}
/** Every enclosing app from the caller up to launchd, nearest first. null: the chain could not be read to its end. */
export function callerAppPaths(pid: number, table: ReadonlyMap<number, {ppid: number; command: string}>): string[] | null {
  const paths: string[] = [], seen = new Set<number>();
  for (let current = pid, depth = 0; current > 1; depth++) {
    const row = table.get(current);
    if (!row || seen.has(current) || depth >= MAX_DEPTH) return null;
    seen.add(current);
    const app = outermostAppPath(row.command);
    if (app && !paths.includes(app)) paths.push(app);
    current = row.ppid;
  }
  return paths;
}

type Run = (file: string, args: readonly string[]) => Promise<string>;
const runFile: Run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], {timeout: 5_000, maxBuffer: 4 * 1024 * 1024, env: {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C'}},
    (error, stdout) => error && !stdout ? reject(error) : resolve(String(stdout)));
});

/**
 * The production resolver (macOS system tools only, fixed paths, no shell). Exactly one other process must hold the
 * peer socket; two or none is `unknown`, never a guess. tmux or another detached session ends at launchd without the
 * terminal app it is shown in, so its host reads as no app — a documented limit, not an authorization.
 */
export function createComputerCallerHostResolver(deps: {run?: Run; ownPid?: number; platform?: NodeJS.Platform} = {}): ComputerCallerHostResolver {
  const run = deps.run ?? runFile, ownPid = deps.ownPid ?? process.pid, platform = deps.platform ?? process.platform;
  return async origin => {
    if (platform !== 'darwin') return unknownCallerHost('unsupported-platform');
    if (!origin) return unknownCallerHost('origin-missing');
    let pids: number[];
    try {pids = lsofPeerPids(await run('/usr/sbin/lsof', ['-nP', `-iTCP@127.0.0.1:${origin.peerPort}`, '-sTCP:ESTABLISHED', '-Fp']), ownPid);}
    catch {return unknownCallerHost('peer-unreadable');}
    if (pids.length !== 1) return unknownCallerHost(pids.length ? 'peer-ambiguous' : 'peer-missing');
    let paths: string[] | null;
    try {paths = callerAppPaths(pids[0]!, psProcessTable(await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,comm='])));}
    catch {return unknownCallerHost('ancestry-unreadable');}
    if (!paths) return unknownCallerHost('ancestry-unreadable');
    const bundleIds: string[] = [];
    for (const path of paths) {
      let id: string;
      try {id = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', `${path}/Contents/Info.plist`])).trim();}
      catch {return unknownCallerHost('bundle-unreadable');}
      if (!BUNDLE_ID.test(id)) return unknownCallerHost('bundle-unreadable');
      if (!bundleIds.some(known => known.toLowerCase() === id.toLowerCase())) bundleIds.push(id);
    }
    return {state: 'known', bundleIds};
  };
}
/** Bundle ids compare case-insensitively, as Launch Services does. */
export function callerHostOwns(host: ComputerCallerHost, bundleId: string | null | undefined): boolean {
  return host.state === 'known' && !!bundleId && host.bundleIds.some(id => id.toLowerCase() === bundleId.toLowerCase());
}
