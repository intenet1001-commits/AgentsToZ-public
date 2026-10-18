/**
 * Exact turn ends from the CLI's own transcript (S8), tailed by the activity sampler.
 *
 * - Claude: `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<slug>/<conversationId>.jsonl`. The Workroom starts Claude with
 *   `--session-id <workroom id>` (or resumes a known id), so the file name is known; only its slug is probed.
 * - Codex: the rollout of the thread the running process group writes (its `thread-writer-locks/<id>.lock`, read with
 *   lsof on macOS/Linux — src/aiTerminalResume.ts), or on Windows a rollout matched by cwd and time window when exactly
 *   one candidate exists. A resumed thread keeps appending to its first rollout in whatever day folder that is, so a
 *   known thread id is looked up across every day folder. The binding is cached once found.
 * - Hermes, agy and restricted (CS duty) sessions are never tailed: they stay on the screen tier.
 *
 * Reads are bounded: one poll reads at most `maxBytes`, and the sampler gives every running session together one sweep
 * budget (`WORKROOM_TRANSCRIPT_TICK_BYTES`). Every byte read — the tail and, on Windows, the rollout heads it matches —
 * is counted against it. A file that grew more is read from its newest window (only the latest turn end matters); a
 * replaced or truncated file is read again from its newest window on the next poll. Files are opened without following
 * symbolic links and without blocking (a FIFO swapped in never stalls the sidecar), and the opened file must be the
 * regular file that was stat'ed (same dev/inode).
 */
import {closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, type Stats} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {claudeProjectSlugCandidates} from './sessionTranscript';
import {codexRolloutDayDirs, codexRolloutPathById, codexThreadFromOpenFiles, parseCodexRolloutMetaHead} from './aiTerminalResume';
import {parseWorkroomTurnCompletions, type WorkroomTurnCompletion} from './aiTerminalActivity';

/** Per-sweep read budget across every running session (S8). */
export const WORKROOM_TRANSCRIPT_TICK_BYTES = 512 * 1024;
/** How often an unbound Codex session asks lsof again when no request was sent since the last try. */
export const WORKROOM_TRANSCRIPT_LOCATE_RETRY_MS = 15_000;
/** Windows rollout matching reads rollout heads; it runs less often. */
export const WORKROOM_TRANSCRIPT_ROLLOUT_MATCH_RETRY_MS = 30_000;
/** A rollout's first line (`session_meta`) carries the model instructions; it is read in steps up to this much. */
const ROLLOUT_HEAD_MAX_BYTES = 256 * 1024;
const ROLLOUT_HEAD_STEP_BYTES = 16 * 1024;
const ROLLOUT_START_SLACK_MS = 10_000;

export interface WorkroomTranscriptSession {
  sessionId: string;
  agent: string;
  cwd: string;
  env: Record<string, string | undefined>;
  createdAt: string;
  /** Claude: the launch or resumed id. Codex: only after a resume. */
  conversationId?: string;
  processGroup?: number;
  /** Restricted (CS duty) sessions are never read. */
  restricted: boolean;
  lastSubmitAt: number | null;
}

export interface WorkroomTurnSignals {
  /** New turn ends since the previous call for this session; `bytes` counts everything read (≤ `maxBytes`). */
  poll(session: WorkroomTranscriptSession, maxBytes: number): Promise<{completions: WorkroomTurnCompletion[]; bytes: number}>;
  forget(sessionId: string): void;
}

interface Binding {path: string | null; dev: number; ino: number; offset: number; carry: string; lastLocateAt: number; agent: 'claude' | 'codex'}
/** What one poll may still read, and what it has read. */
interface Budget {left: number; used: number; onRead?: (bytes: number) => void}
const charge = (budget: Budget | undefined, bytes: number) => {
  if (!budget || bytes <= 0) return;
  budget.left -= bytes; budget.used += bytes; budget.onRead?.(bytes);
};

/**
 * Opens `path` if it is still the regular file `lstat` saw: no symbolic link is followed and the open never blocks
 * (`O_NONBLOCK` — a FIFO swapped in after the stat would otherwise wait for a writer on the sidecar's only thread).
 */
function openRegular(path: string, hooks?: {afterStat?: () => void}): {fd: number; stat: Stats} | null {
  let stat: Stats;
  try { stat = lstatSync(path); } catch { return null; }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  hooks?.afterStat?.();
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { return null; }
  try {
    const opened = fstatSync(fd);
    if (opened.isFile() && opened.dev === stat.dev && opened.ino === stat.ino) return {fd, stat: opened};
  } catch { /* closed below */ }
  try { closeSync(fd); } catch { /* already closed */ }
  return null;
}

/**
 * The bytes of a regular, non-symlinked transcript from `offset` (≤ `maxBytes`, newest window when it grew more).
 * Exported for the race regression test (`hooks.afterStat` runs between the stat and the open).
 */
export function readWorkroomTranscriptAppended(path: string, offset: number, maxBytes: number, hooks?: {afterStat?: () => void; onRead?: (bytes: number) => void}):
  {data: Buffer; size: number; dev: number; ino: number; start: number} | null {
  const opened = openRegular(path, hooks);
  if (!opened) return null;
  try {
    const size = opened.stat.size;
    const start = size - offset > maxBytes ? size - maxBytes : Math.min(offset, size);
    const length = Math.max(0, Math.min(maxBytes, size - start));
    const data = Buffer.alloc(length);
    const read = length ? readSync(opened.fd, data, 0, length, start) : 0;
    if (read) hooks?.onRead?.(read);
    return {data: data.subarray(0, read), size, dev: opened.stat.dev, ino: opened.stat.ino, start};
  } catch {
    return null;
  } finally {
    try { closeSync(opened.fd); } catch { /* already closed */ }
  }
}

/** A rollout's first line, read in steps until its newline; every byte read is charged. Null when out of budget. */
function readFirstLine(path: string, budget: Budget): string | null {
  const opened = openRegular(path);
  if (!opened) return null;
  try {
    const chunks: Buffer[] = [];
    for (let position = 0; position < Math.min(opened.stat.size, ROLLOUT_HEAD_MAX_BYTES);) {
      const length = Math.min(ROLLOUT_HEAD_STEP_BYTES, ROLLOUT_HEAD_MAX_BYTES - position, opened.stat.size - position);
      if (length > budget.left) return null;
      const chunk = Buffer.alloc(length);
      const read = readSync(opened.fd, chunk, 0, length, position);
      charge(budget, read);
      if (!read) break;
      chunks.push(chunk.subarray(0, read));
      position += read;
      if (chunk.subarray(0, read).includes(0x0a)) break;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    try { closeSync(opened.fd); } catch { /* already closed */ }
  }
}

function regularFile(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
}

function claudeTranscript(session: WorkroomTranscriptSession): string | null {
  const id = session.conversationId;
  if (!id || !/^[A-Za-z0-9_-]{8,160}$/.test(id)) return null;
  const home = session.env.CLAUDE_CONFIG_DIR || join(session.env.HOME || homedir(), '.claude');
  for (const slug of claudeProjectSlugCandidates(session.cwd)) {
    const path = join(home, 'projects', slug, `${id}.jsonl`);
    if (regularFile(path)) return path;
  }
  return null;
}

function codexRolloutById(codexHome: string, id: string, fromMs: number, untilMs: number): string | null {
  for (const dir of codexRolloutDayDirs(codexHome, fromMs, untilMs)) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    const name = names.find(n => n.startsWith('rollout-') && n.endsWith(`-${id}.jsonl`));
    if (name && regularFile(join(dir, name))) return join(dir, name);
  }
  return null;
}

/**
 * Windows: exactly one interactive rollout for this folder in the session's time window. Only rollouts written since
 * the session started are opened (a stat, no read), newest first, and each head read is charged to the budget; when
 * the budget runs out before every candidate was seen the answer is «not yet» (null), never a guess.
 */
function codexRolloutByMatch(codexHome: string, cwd: string, createdMs: number, untilMs: number, budget: Budget): string | null {
  const touched: {path: string; mtime: number}[] = [];
  for (const dir of codexRolloutDayDirs(codexHome, createdMs, untilMs)) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      let stat: Stats;
      try { stat = lstatSync(path); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs < createdMs - ROLLOUT_START_SLACK_MS) continue;
      touched.push({path, mtime: stat.mtimeMs});
    }
  }
  touched.sort((a, b) => b.mtime - a.mtime);
  let found: string | null = null;
  for (const {path} of touched) {
    const head = readFirstLine(path, budget);
    if (head === null) {
      if (budget.left <= 0 || regularFile(path)) return null; // out of budget: try again on a later sweep
      continue;
    }
    const meta = parseCodexRolloutMetaHead(head);
    if (!meta || !meta.interactiveCli || meta.cwd !== cwd) continue;
    const at = Date.parse(meta.timestamp);
    if (!Number.isFinite(at) || at < createdMs - ROLLOUT_START_SLACK_MS || at > untilMs + ROLLOUT_START_SLACK_MS) continue;
    if (found) return null;
    found = path;
  }
  return found;
}

export function createWorkroomTranscriptSignals(options: {
  /** lsof of a process group (src/aiTerminalResume.ts `processGroupOpenFiles`); never called on Windows. */
  openFiles?: (processGroup: number) => Promise<string[]>;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Measurement hook (tests): every byte read from a transcript or rollout. */
  onRead?: (bytes: number) => void;
} = {}): WorkroomTurnSignals {
  const now = options.now ?? Date.now, platform = options.platform ?? process.platform;
  const bindings = new Map<string, Binding>();
  const locate = async (session: WorkroomTranscriptSession, binding: Binding, budget: Budget): Promise<string | null> => {
    if (binding.agent === 'claude') return claudeTranscript(session);
    const codexHome = session.env.CODEX_HOME || join(session.env.HOME || homedir(), '.codex');
    const created = Date.parse(session.createdAt), until = now();
    if (!Number.isFinite(created)) return null;
    const resumed = session.conversationId && /^[0-9a-f-]{36}$/.test(session.conversationId) ? session.conversationId : null;
    // A resumed thread appends to its first rollout, in whichever day folder that is (src/aiTerminalResume.ts).
    if (resumed) {
      const path = codexRolloutById(codexHome, resumed, created, until) ?? codexRolloutPathById(codexHome, resumed);
      return path && regularFile(path) ? path : null;
    }
    let id: string | null = null;
    if (platform !== 'win32' && session.processGroup !== undefined && options.openFiles) {
      try { id = codexThreadFromOpenFiles(await options.openFiles(session.processGroup), codexHome); } catch { id = null; }
    }
    if (id) return codexRolloutById(codexHome, id, created, until);
    return platform === 'win32' ? codexRolloutByMatch(codexHome, session.cwd, created, until, budget) : null;
  };
  return {
    forget(sessionId) { bindings.delete(sessionId); },
    async poll(session, maxBytes) {
      if (session.restricted || (session.agent !== 'claude' && session.agent !== 'codex') || maxBytes <= 0) return {completions: [], bytes: 0};
      const budget: Budget = {left: maxBytes, used: 0, onRead: options.onRead};
      let binding = bindings.get(session.sessionId);
      if (!binding) { binding = {path: null, dev: 0, ino: 0, offset: 0, carry: '', lastLocateAt: Number.NEGATIVE_INFINITY, agent: session.agent}; bindings.set(session.sessionId, binding); }
      if (!binding.path) {
        const retry = binding.agent === 'claude' ? 0 : platform === 'win32' ? WORKROOM_TRANSCRIPT_ROLLOUT_MATCH_RETRY_MS : WORKROOM_TRANSCRIPT_LOCATE_RETRY_MS;
        // Codex writes no thread lock or rollout before the first request (measured), so an unasked Codex is not probed.
        if (binding.agent === 'codex' && session.lastSubmitAt === null && !session.conversationId) return {completions: [], bytes: 0};
        const submitted = session.lastSubmitAt !== null && session.lastSubmitAt > binding.lastLocateAt;
        if (!submitted && now() - binding.lastLocateAt < retry) return {completions: [], bytes: 0};
        binding.lastLocateAt = now();
        const found = await locate(session, binding, budget);
        if (!found) return {completions: [], bytes: budget.used};
        // Start at the newest window: earlier turns are history (the reducer also ignores ends before the open request).
        binding.path = found; binding.offset = Number.MAX_SAFE_INTEGER; binding.carry = '';
        if (budget.left <= 0) return {completions: [], bytes: budget.used};
      }
      const firstRead = binding.offset === Number.MAX_SAFE_INTEGER;
      const read = readWorkroomTranscriptAppended(binding.path, firstRead ? 0 : binding.offset, budget.left, {onRead: bytes => charge(budget, bytes)});
      if (!read) { binding.path = null; return {completions: [], bytes: budget.used}; }
      if (!firstRead && (read.dev !== binding.dev || read.ino !== binding.ino || read.size < binding.offset)) {
        // Replaced or truncated: what was read belongs to no known position. The next poll reads the new file's newest
        // window, inside its own budget, instead of reading a second time now.
        binding.offset = Number.MAX_SAFE_INTEGER; binding.carry = ''; binding.dev = read.dev; binding.ino = read.ino;
        return {completions: [], bytes: budget.used};
      }
      const skipped = firstRead || read.start > binding.offset;
      let text = (skipped ? '' : binding.carry) + read.data.toString('utf8');
      // A window that does not start at the first byte may begin mid-line: drop that partial line.
      if (skipped && read.start > 0) { const newline = text.indexOf('\n'); text = newline < 0 ? '' : text.slice(newline + 1); }
      const lastNewline = text.lastIndexOf('\n');
      const complete = lastNewline < 0 ? '' : text.slice(0, lastNewline + 1);
      const rest = lastNewline < 0 ? text : text.slice(lastNewline + 1);
      binding.carry = rest.length > maxBytes ? '' : rest;
      binding.offset = read.start + read.data.length; binding.dev = read.dev; binding.ino = read.ino;
      return {completions: parseWorkroomTurnCompletions(binding.agent, complete), bytes: budget.used};
    },
  };
}
