import {closeSync, existsSync, openSync, readSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import type {AiTerminalAgent} from './aiTerminalProtocol';
import {claudeProjectSlugCandidates} from './sessionTranscript';

/**
 * 「다시 시작」 (VOC 2026-10-02): a Workroom session whose CLI is stuck or ended opens again with the same
 * project and AI, continuing its conversation when that conversation can be proven to be this session's.
 *
 * - Claude: the id it was started with (`--session-id`, or the one it resumed). Resuming without
 *   `--fork-session` appends to the same transcript, so 「내가 한 말」 does not capture its prompts twice.
 * - Codex: the thread whose writer lock the running process group holds. For a process that already
 *   ended, only a rollout that cannot belong to another session (exactly one candidate) counts.
 *
 * Nothing is resumed unless the CLI has already saved that conversation: both CLIs exit at once when
 * asked to resume a conversation with no saved turn, which would replace a session with a dead one.
 * A guess is worse than a fresh start, so every uncertainty answers null.
 */
export interface AiTerminalResume {agent: 'claude' | 'codex'; conversationId: string}

export interface AiTerminalResumeSource {
  agent: AiTerminalAgent;
  cwd: string;
  createdAt: string;
  exitedAt?: string;
  /** Claude: known from launch. Codex: known once a previous restart resumed it. */
  conversationId?: string;
  /** The running CLI's process group (each Workroom CLI leads its own). */
  processGroup?: number;
}

export interface AiTerminalResumeEnvironment {
  home: string;
  codexHome?: string;
  claudeConfigDir?: string;
  /** Absolute paths the process group holds open. */
  openFiles?: (processGroup: number) => Promise<string[]>;
  now?: () => number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAUDE_ID = /^[A-Za-z0-9_-]{8,160}$/;
/** A Codex rollout's first line carries its model instructions (measured up to ~48 KB). */
const ROLLOUT_HEAD_BYTES = 256 * 1024;
const CLAUDE_SCAN_BYTES = 4 * 1024 * 1024;
/** Codex creates its thread as the process starts; allow clock and spawn latency around that. */
const ROLLOUT_START_SLACK_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function readHead(path: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** The transcript holds at least one user turn, so `claude --resume` has something to open. */
export function claudeConversationSaved(cwd: string, conversationId: string, env: AiTerminalResumeEnvironment): boolean {
  if (!CLAUDE_ID.test(conversationId)) return false;
  const root = join(env.claudeConfigDir ?? join(env.home, '.claude'), 'projects');
  for (const slug of claudeProjectSlugCandidates(cwd)) {
    const path = join(root, slug, `${conversationId}.jsonl`);
    if (existsSync(path) && /"type"\s*:\s*"user"/.test(readHead(path, CLAUDE_SCAN_BYTES))) return true;
  }
  return false;
}

/**
 * The thread a Codex process group is writing (its `thread-writer-locks/<id>.lock`);
 * null unless exactly one.
 *
 * Separators are normalised because the two sides disagree: `lsof` reports POSIX
 * paths while `join(codexHome, …)` produces backslashes on Windows, so the old
 * `join(...) + '/'` prefix could never match there. The prefix is also compared
 * case-insensitively, since a Windows path may be spelled with a different drive
 * or directory case than the one we built. The id is sliced from the original
 * string so its own case still has to satisfy the (lowercase) UUID pattern.
 */
export function codexThreadFromOpenFiles(paths: readonly string[], codexHome: string): string | null {
  const slashes = /[\\/]+/g;
  const prefix = (join(codexHome, 'thread-writer-locks') + '/').replace(slashes, '/').toLowerCase();
  const ids = new Set<string>();
  for (const path of paths) {
    const normalized = path.replace(slashes, '/');
    if (!normalized.toLowerCase().startsWith(prefix) || !normalized.toLowerCase().endsWith('.lock')) continue;
    const id = normalized.slice(prefix.length, -'.lock'.length);
    if (UUID.test(id)) ids.add(id);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

/** Day folders Codex may have filed a rollout under (it uses local dates; UTC is checked too). */
export function codexRolloutDayDirs(codexHome: string, fromMs: number, untilMs: number): string[] {
  const dirs = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, '0');
  for (let t = fromMs - DAY_MS; t <= untilMs + DAY_MS; t += DAY_MS) {
    const d = new Date(t);
    dirs.add(join(codexHome, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
    dirs.add(join(codexHome, 'sessions', String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())));
  }
  return [...dirs];
}

function rolloutFiles(dirs: readonly string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) if (name.startsWith('rollout-') && name.endsWith('.jsonl')) files.push(join(dir, name));
  }
  return files;
}

export interface CodexRolloutMeta {id: string; cwd: string; timestamp: string; interactiveCli: boolean}
export function codexRolloutMeta(path: string): CodexRolloutMeta | null {
  const head = readHead(path, ROLLOUT_HEAD_BYTES);
  const newline = head.indexOf('\n');
  if (newline < 0) return null;
  try {
    const record = JSON.parse(head.slice(0, newline));
    const p = record?.payload;
    if (record?.type !== 'session_meta' || !p || typeof p.id !== 'string' || !UUID.test(p.id)
      || typeof p.cwd !== 'string' || typeof p.timestamp !== 'string') return null;
    return {id: p.id, cwd: p.cwd, timestamp: p.timestamp, interactiveCli: p.source === 'cli' || p.originator === 'codex-tui'};
  } catch {
    return null;
  }
}

/**
 * Whether Codex saved this thread. A resumed thread keeps appending to its first rollout, which can sit in
 * any older day folder, so this walks every day folder newest first instead of a window around the session.
 */
export function codexThreadSaved(codexHome: string, id: string): boolean {
  if (!UUID.test(id)) return false;
  const root = join(codexHome, 'sessions');
  const desc = (dir: string) => { try { return readdirSync(dir).filter(name => /^\d+$/.test(name)).sort().reverse(); } catch { return []; } };
  for (const year of desc(root)) for (const month of desc(join(root, year))) for (const day of desc(join(root, year, month))) {
    const dir = join(root, year, month, day);
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    const name = names.find(n => n.startsWith('rollout-') && n.endsWith(`-${id}.jsonl`));
    if (name) return codexRolloutMeta(join(dir, name))?.id === id;
  }
  return false;
}

async function resolveCodex(source: AiTerminalResumeSource, env: AiTerminalResumeEnvironment): Promise<string | null> {
  const codexHome = env.codexHome ?? join(env.home, '.codex');
  const created = Date.parse(source.createdAt);
  if (!Number.isFinite(created)) return null;
  const until = source.exitedAt ? Date.parse(source.exitedAt) : (env.now ?? Date.now)();
  const days = codexRolloutDayDirs(codexHome, created, Number.isFinite(until) ? until : created);
  const saved = (id: string) => codexThreadSaved(codexHome, id);
  if (source.conversationId) return saved(source.conversationId) ? source.conversationId : null;
  if (source.processGroup !== undefined && env.openFiles) {
    let thread: string | null = null;
    try { thread = codexThreadFromOpenFiles(await env.openFiles(source.processGroup), codexHome); } catch { thread = null; }
    // The running process named its thread: that answer is final. No rollout yet means nothing was said.
    if (thread) return saved(thread) ? thread : null;
  }
  const from = created - ROLLOUT_START_SLACK_MS, to = (Number.isFinite(until) ? until : created) + ROLLOUT_START_SLACK_MS;
  const candidates = new Set<string>();
  for (const path of rolloutFiles(days)) {
    const meta = codexRolloutMeta(path);
    if (!meta || !meta.interactiveCli || meta.cwd !== source.cwd) continue;
    const at = Date.parse(meta.timestamp);
    if (Number.isFinite(at) && at >= from && at <= to) candidates.add(meta.id);
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
}

export async function resolveAiTerminalResume(source: AiTerminalResumeSource, env: AiTerminalResumeEnvironment): Promise<AiTerminalResume | null> {
  if (source.agent === 'claude') {
    const id = source.conversationId;
    return id && claudeConversationSaved(source.cwd, id, env) ? {agent: 'claude', conversationId: id} : null;
  }
  if (source.agent === 'codex') {
    const id = await resolveCodex(source, env);
    return id ? {agent: 'codex', conversationId: id} : null;
  }
  return null;
}

/**
 * `lsof -Fn -g <pgid>`: the names of every file the process group holds open.
 *
 * Windows answers with nothing, on purpose. There is no process-group concept
 * and no lsof, and the alternatives do not pay for themselves: the thread lock
 * is taken by `LockFileEx`, which leaves the file openable, so detecting it
 * needs a real HANDLE through FFI (Bun's descriptors are not CRT descriptors --
 * `_get_osfhandle` returns INVALID_HANDLE_VALUE for them, measured). And it
 * would buy nothing: a live Codex sitting at its composer has **no** lock file
 * yet (measured -- the directory was unchanged through startup, the hooks prompt
 * and the composer), so a lock exists only once a message has been sent, which
 * is exactly when a rollout exists too. Returning nothing here falls through to
 * the rollout match on cwd and time window -- the same evidence the POSIX path
 * uses for a session that already ended, with the same rule that anything
 * ambiguous resumes nothing.
 */
export async function processGroupOpenFiles(processGroup: number): Promise<string[]> {
  if (process.platform === 'win32') return [];
  if (!Number.isInteger(processGroup) || processGroup <= 1) return [];
  const child = Bun.spawn(['/usr/sbin/lsof', '-n', '-P', '-Fn', '-g', String(processGroup)], {stdout: 'pipe', stderr: 'ignore'});
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* exited */ } }, 3_000);
  try {
    const text = await new Response(child.stdout).text();
    await child.exited;
    return text.split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1));
  } finally {
    clearTimeout(timer);
  }
}
