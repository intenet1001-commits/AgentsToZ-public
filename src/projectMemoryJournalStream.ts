import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { ProjectMemoryJournalRecallEntry } from './projectMemoryJournalRecall';

export const MAX_JOURNAL_RECORD_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
export interface JournalStreamMetrics { bytesRead: number; records: number; maxBufferedBytes: number }
export class JournalReadIncompleteError extends Error {
  readonly code = 'PROJECT_MEMORY_JOURNAL_READ_INCOMPLETE';
}
const hashEntry = (entry: Pick<ProjectMemoryJournalRecallEntry, 'headCommit' | 'summary' | 'body'>) =>
  createHash('sha256').update([entry.headCommit ?? '', entry.summary, entry.body].join('\n')).digest('hex').slice(0, 16);

/** Bounded line storage, including a newline-free corrupt tail. Never rewrites it. */
function* lines(fd: number, size: number, metrics: JournalStreamMetrics, chunkBytes: number): Generator<string> {
  const chunk = Buffer.allocUnsafe(chunkBytes);
  let offset = 0, bytes = 0;
  let parts: Buffer[] = [];
  while (offset < size) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (!count) throw new JournalReadIncompleteError('읽는 도중 일지 파일이 짧아졌습니다. 다시 시도하세요.');
    offset += count; metrics.bytesRead += count;
    let start = 0;
    for (let at = 0; at <= count; at++) {
      if (at < count && chunk[at] !== 10) continue;
      const length = at - start;
      if (bytes + length > MAX_JOURNAL_RECORD_BYTES) throw new JournalReadIncompleteError('일지 한 기록의 읽기 예산을 초과했습니다. 원본을 보존했습니다.');
      if (length) { parts.push(Buffer.from(chunk.subarray(start, at))); bytes += length; }
      metrics.maxBufferedBytes = Math.max(metrics.maxBufferedBytes, bytes);
      if (at < count) {
        yield Buffer.concat(parts, bytes).toString('utf8');
        parts = []; bytes = 0;
      }
      start = at + 1;
    }
  }
  if (bytes) yield Buffer.concat(parts, bytes).toString('utf8');
}

function parseV2(line: string): ProjectMemoryJournalRecallEntry | null {
  const match = /^<!-- entry-v2:([A-Za-z0-9_-]+) -->\r?$/.exec(line);
  if (!match) return null;
  try {
    const e = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8'));
    if (e.version !== 2 || typeof e.entryHash !== 'string' || !/^[0-9a-f]{16}$/.test(e.entryHash)
      || typeof e.recordedAt !== 'string' || Number.isNaN(Date.parse(e.recordedAt))
      || (e.agent !== null && e.agent !== 'claude' && e.agent !== 'codex')
      || (e.headCommit !== null && typeof e.headCommit !== 'string')
      || typeof e.summary !== 'string' || typeof e.body !== 'string' || hashEntry(e) !== e.entryHash) return null;
    return { entryHash: e.entryHash, recordedAt: e.recordedAt, agent: e.agent,
      headCommit: e.headCommit, summary: e.summary.slice(0, 300), body: e.body, integrity: 'verified' };
  } catch { return null; }
}
const marker = /^<!-- entry:([0-9a-f]+) -->$/;
const heading = /^## (\d{4}-\d{2}-\d{2}T[^\n]*)$/;

/** Compatibility with heading-first v149-v151 files; bounded one-line lookahead. */
function* normalizeLegacy(input: Iterable<string>): Generator<string> {
  let pending: string | undefined;
  for (const line of input) {
    if (pending !== undefined && heading.test(pending) && marker.test(line)) {
      yield line; yield pending; pending = undefined;
    } else {
      if (pending !== undefined) yield pending;
      pending = line;
    }
  }
  if (pending !== undefined) yield pending;
}
function parseLegacy(hash: string, headline: string, lines: string[]): ProjectMemoryJournalRecallEntry | null {
  const [recordedAt, ...meta] = headline.split(' · ').map(part => part.trim());
  if (!recordedAt || Number.isNaN(Date.parse(recordedAt))) return null;
  const metadata = lines.slice(0, 3).find(line => /^<!-- summary:[A-Za-z0-9_-]* -->$/.test(line));
  const stored = metadata === undefined ? null : Buffer.from(metadata.slice('<!-- summary:'.length, -' -->'.length), 'base64url').toString('utf8').slice(0, 300);
  const body = lines.filter(line => line !== metadata).join('\n').trim();
  const summary = stored ?? body.split('\n')[0]?.slice(0, 300) ?? '';
  const headCommit = meta.find(part => /^[0-9a-f]{7,}$/.test(part)) ?? null;
  if (stored && hashEntry({ headCommit, summary, body }) !== hash) return null;
  return { entryHash: hash, recordedAt, headCommit, summary, body,
    agent: meta.includes('claude') ? 'claude' : meta.includes('codex') ? 'codex' : null,
    integrity: stored ? 'verified' : 'legacy-unverified' };
}
function* legacyEntries(input: Iterable<string>, metrics: JournalStreamMetrics): Generator<ProjectMemoryJournalRecallEntry> {
  let pending: string | undefined, active: { hash: string; headline: string } | undefined;
  let block: string[] = [], bytes = 0;
  const add = (line: string) => {
    if (!active) return;
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > MAX_JOURNAL_RECORD_BYTES) throw new JournalReadIncompleteError('이전 형식 일지의 한 기록이 읽기 예산을 초과했습니다. 원본을 보존했습니다.');
    metrics.maxBufferedBytes = Math.max(metrics.maxBufferedBytes, bytes);
    block.push(line);
  };
  for (const line of normalizeLegacy(input)) {
    const m = pending === undefined ? null : marker.exec(pending);
    const h = m ? heading.exec(line) : null;
    if (m && h) {
      if (active) { const entry = parseLegacy(active.hash, active.headline, block); if (entry) yield entry; }
      active = { hash: m[1]!, headline: h[1]! }; block = []; bytes = 0; pending = undefined;
    } else {
      if (pending !== undefined) add(pending);
      pending = line;
    }
  }
  if (pending !== undefined) add(pending);
  if (active) { const entry = parseLegacy(active.hash, active.headline, block); if (entry) yield entry; }
}

/**
 * Emits v2 then legacy entries, matching historical per-file dedup precedence.
 * Normal v2 files require one pass; mixed/legacy files use a second bounded pass.
 * Consumers must finish iteration before publishing a complete generation: a
 * concurrent file change throws at the end. Neither sorting nor dedup retains
 * the whole history here; those are the consuming index's responsibilities.
 */
export function* streamProjectMemoryJournalFile(path: string, options: {
  metrics?: JournalStreamMetrics; chunkBytes?: number;
} = {}): Generator<ProjectMemoryJournalRecallEntry> {
  const metrics = options.metrics ?? { bytesRead: 0, records: 0, maxBufferedBytes: 0 };
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > CHUNK_BYTES) throw new Error('Invalid journal chunk size');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new JournalReadIncompleteError('일지 파일 형식이 올바르지 않습니다.');
    let hasLegacy = false;
    for (const line of lines(fd, Number(before.size), metrics, chunkBytes)) {
      if (marker.test(line)) hasLegacy = true;
      const entry = parseV2(line);
      if (entry) { metrics.records++; yield entry; }
    }
    if (hasLegacy) {
      for (const entry of legacyEntries(lines(fd, Number(before.size), metrics, chunkBytes), metrics)) {
        metrics.records++; yield entry;
      }
    }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (named.isSymbolicLink() || [after, named].some(s => s.dev !== before.dev || s.ino !== before.ino
      || s.size !== before.size || s.mtimeNs !== before.mtimeNs || s.ctimeNs !== before.ctimeNs)) {
      throw new JournalReadIncompleteError('읽는 도중 일지 파일이 변경되었습니다. 다시 시도하세요.');
    }
  } finally { closeSync(fd); }
}
