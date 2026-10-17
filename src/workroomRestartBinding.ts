import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { codexRolloutDayDirs, parseCodexRolloutMetaHead } from './aiTerminalResume';

/**
 * Which Codex conversation a Workroom row ran, when the row never learned its thread id (w14, R2): the sidecar ended
 * before it could ask the running CLI (a crash, the shutdown ceiling, every Windows quit). The only evidence left is the
 * rollouts Codex wrote: an interactive CLI rollout of exactly this folder whose start falls in the row's lifetime.
 * Exactly one candidate is an answer; none or several are not — a guess would open somebody else's conversation.
 * Reads only the first line of each rollout (the `session_meta` record), in 16 KiB steps, within a byte budget.
 */
export interface CodexRolloutSearch {
  codexHome: string;
  cwd: string;
  fromMs: number;
  toMs: number;
  /** Bytes of rollout heads read at most in one search (default 8 MiB). */
  budgetBytes?: number;
}
/** `rollouts`: each candidate with the start time its `session_meta` names (a joint derivation compares other rows' lifetimes). */
export interface CodexRolloutCandidates { ids: string[]; rollouts: { id: string; at: number }[]; complete: boolean; bytes: number }

const STEP = 16 * 1024;
/** A `session_meta` line carries the model instructions; measured up to ~48 KB (aiTerminalResume.ts reads 256 KB). */
const HEAD_LIMIT = 256 * 1024;
/** The rollout name carries the start time (local, as Codex names day folders); either zone is accepted. */
const NAME_TIME = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/;
const NAME_SLACK_MS = 120_000;

function nameTimes(name: string): number[] | null {
  const m = NAME_TIME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  return [new Date(y!, mo! - 1, d!, h!, mi!, s!).getTime(), Date.UTC(y!, mo! - 1, d!, h!, mi!, s!)];
}

/** The first line of a regular file (no link), read in steps; null when there is none within the limit. */
function firstLine(path: string, budget: { left: number }): string | null {
  let fd: number | undefined;
  try {
    const s = lstatSync(path);
    if (!s.isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== s.dev || opened.ino !== s.ino) return null;
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < Math.min(opened.size, HEAD_LIMIT); offset += STEP) {
      if (budget.left <= 0) throw new BudgetExceeded();
      const buffer = Buffer.alloc(Math.min(STEP, HEAD_LIMIT - offset));
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      budget.left -= read;
      if (read <= 0) break;
      const part = buffer.subarray(0, read), newline = part.indexOf(0x0a);
      if (newline >= 0) { chunks.push(part.subarray(0, newline + 1)); return Buffer.concat(chunks).toString('utf8'); }
      chunks.push(part);
    }
    return null;
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    return null;
  } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}
class BudgetExceeded extends Error {}

export function codexRolloutCandidates(search: CodexRolloutSearch): CodexRolloutCandidates {
  const budget = { left: search.budgetBytes ?? 8 * 1024 * 1024 }, start = budget.left;
  const found = new Map<string, number>();
  const answer = (complete: boolean) => ({ ids: [...found.keys()], rollouts: [...found].map(([id, at]) => ({ id, at })), complete, bytes: start - budget.left });
  if (!Number.isFinite(search.fromMs) || !Number.isFinite(search.toMs) || search.toMs < search.fromMs) return answer(true);
  try {
    for (const dir of codexRolloutDayDirs(search.codexHome, search.fromMs, search.toMs)) {
      let names: string[];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const times = nameTimes(name);
        if (times && !times.some(t => t >= search.fromMs - NAME_SLACK_MS && t <= search.toMs + NAME_SLACK_MS)) continue;
        const line = firstLine(join(dir, name), budget);
        const meta = line ? parseCodexRolloutMetaHead(line.endsWith('\n') ? line : line + '\n') : null;
        if (!meta || !meta.interactiveCli || meta.cwd !== search.cwd) continue;
        const at = Date.parse(meta.timestamp);
        if (Number.isFinite(at) && at >= search.fromMs && at <= search.toMs && !found.has(meta.id)) found.set(meta.id, at);
      }
    }
  } catch (error) {
    if (error instanceof BudgetExceeded) return answer(false);
    throw error;
  }
  return answer(true);
}
