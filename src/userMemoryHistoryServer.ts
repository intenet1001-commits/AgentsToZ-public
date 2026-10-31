import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { userMemoryRange, UserMemoryHistoryCursorError, type UserMemoryHistoryOrigin } from './userMemoryRecall';

export { UserMemoryHistoryCursorError };

/** Counts from the start of the range through the current page; the cursor carries them forward. */
interface HistoryTotals { rows: number; inRange: number; returned: number; filtered: number; truncated: number; skipped: number; inconsistent: boolean; collectionUnknown: boolean; collectionPartial: boolean; collectionOutdated: boolean; retentionUnknown: boolean; retentionExpired: boolean; clockUnknown: boolean; clockReversed: boolean }
/**
 * Where the traversal is. New captures always get a seq above every existing
 * row, so rows captured during a traversal are read by a later segment that
 * starts at the newest row and ends at the highest seq already read.
 */
interface HistoryPosition {
  /** Exclusive upper bound of the next read; null reads from the newest row. */
  beforeSeq: string | null;
  /** Rows at or below this were read by an earlier segment; null in the first segment. */
  floor: string | null;
  /** Highest seq read so far; null until a row is read. */
  covered: string | null;
  /** The newest row seen when this segment started; it must be read, or be gone, before the traversal moves on. */
  target: string | null;
  /** This segment is finished; the next step looks for rows captured since. */
  segmentDone: boolean;
  /** Unconsumed row body. The upper sequence bound advances only after its final part. */
  partial: { seq: string; offset: number; hash: string } | null;
  revision: string | null;
  /** Earliest active-row expiry observed since this traversal began. */
  expiryAt: string | null;
  /** Last observed wall time; a backward jump can make expired rows visible again. */
  clockAt: number;
}
type StopReason = 'end' | 'hit-budget' | 'scan-budget' | 'deadline' | 'inconsistent';
type HistoryRow = { id: string; seq?: string; memoryId?: string | null; recordedAt: string; text: string; promptOrigin?: string; agent?: string };
type HistoryPage = {
  items: readonly HistoryRow[];
  hasMore: boolean; nextBeforeSeq?: string | null;
  scan?: { complete?: boolean; unreadable?: number; withheld?: number; revision?: string; scannedThrough?: string | null; historicalWithheld?: number; nextExpiryAt?: string | null; mutationChanged?: boolean; clockGuard?: 'guarded' | 'unknown' | 'reversed'; observedAt?: number } | null;
  capture?: { lastCaptureAt?: string | null } | null;
};

/** Keep the earliest expiry observed around a list read and fail closed on mutation. */
export function bracketUserMemoryHistoryScan<T extends { revision: string; unreadable: number; withheld: number; nextExpiryAt: string | null; observedAt?: number }>(before: T | null, after: T | null) {
  const nextExpiryAt = [before?.nextExpiryAt, after?.nextExpiryAt].filter((value): value is string => typeof value === 'string').sort()[0] ?? null;
  const clockGuard = !Number.isSafeInteger(before?.observedAt) || !Number.isSafeInteger(after?.observedAt) ? 'unknown' as const
    : after!.observedAt! < before!.observedAt! ? 'reversed' as const : 'guarded' as const;
  if (before?.revision !== after?.revision) return { ...after, complete: false, mutationChanged: true, unreadable: after?.unreadable ?? 0, withheld: after?.withheld ?? 0, nextExpiryAt, clockGuard };
  return after ? { ...after, nextExpiryAt, clockGuard } : null;
}

/**
 * Storage order is not timestamp order, so a dated range can only be found by
 * reading rows. One call reads several list pages under a row, call and time
 * budget and returns only in-range hits under a hit and byte budget, so a
 * sparse range does not cost many empty round trips.
 */
export const USER_MEMORY_HISTORY_LIMITS = Object.freeze({ rows: 400, listPage: 100, calls: 8, hits: 20, hitBytes: 12_288, deadlineMs: 2_500 });
/** Every reason a page can give for not claiming the whole range; `unavailable` is the failed-read state. */
export const USER_MEMORY_HISTORY_INCOMPLETE_REASONS = Object.freeze(['more-pages', 'changed-or-out-of-order', 'newest-row-unverified', 'truncated-excerpts',
  'skipped-rows', 'collection-unknown', 'collection-partial', 'collection-outdated', 'retention-unknown', 'retention-expired', 'clock-unknown', 'clock-reversed', 'unavailable'] as const);
type IncompleteReason = typeof USER_MEMORY_HISTORY_INCOMPLETE_REASONS[number];
export type UserMemoryHistoryLimits = { rows: number; listPage: number; calls: number; hits: number; hitBytes: number; deadlineMs: number };

const historyCursorKey = randomBytes(32);
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
const seqOrNull = (value: unknown) => value === null || typeof value === 'string' && DECIMAL.test(value);
const higher = (left: string | null, right: string) => left === null || BigInt(right) > BigInt(left) ? right : left;
// Older hosts may omit this timestamp; malformed or timezone-free values do not prove a boundary.
function receiptTime(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const calendar = new Date(Date.UTC(year, month - 1, day)), instant = Date.parse(value);
  return year >= 100 && calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1
    && calendar.getUTCDate() === day && Number.isFinite(instant) ? instant : null;
}

function historyCursor(memoryId: string, start: string, end: string, origin: UserMemoryHistoryOrigin, position: HistoryPosition, totals: HistoryTotals): string {
  const body = Buffer.from(JSON.stringify({ memoryId, start, end, origin, position, totals })).toString('base64url');
  const mac = createHmac('sha256', historyCursorKey).update(body).digest('base64url');
  return `umh1_${body}.${mac}`;
}
function decodeHistoryCursor(cursor: string, memoryId: string, start: string, end: string, origin: UserMemoryHistoryOrigin | undefined) {
  const [body, signature] = cursor.slice(5).split('.');
  if (!body || !signature) throw new UserMemoryHistoryCursorError();
  const expected = createHmac('sha256', historyCursorKey).update(body).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.toString('base64url') !== signature || received.length !== expected.length || !timingSafeEqual(received, expected)) throw new UserMemoryHistoryCursorError();
  const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const { totals, position } = value ?? {};
  const count = (key: keyof HistoryTotals) => Number.isSafeInteger(totals?.[key]) && totals[key] >= 0;
  if (value.memoryId !== memoryId || value.start !== start || value.end !== end
    || (value.origin !== 'all' && value.origin !== 'human') || (origin !== undefined && value.origin !== origin)
    || !(['rows', 'inRange', 'returned', 'filtered', 'truncated', 'skipped'] as const).every(count) || totals.inconsistent !== false
    || typeof totals.collectionUnknown !== 'boolean' || typeof totals.collectionPartial !== 'boolean' || typeof totals.collectionOutdated !== 'boolean'
    || typeof totals.retentionUnknown !== 'boolean' || totals.retentionExpired !== false
    || typeof totals.clockUnknown !== 'boolean' || totals.clockReversed !== false
    || !(['beforeSeq', 'floor', 'covered', 'target'] as const).every(key => seqOrNull(position?.[key])) || typeof position.segmentDone !== 'boolean'
    || !(position.revision === null || typeof position.revision === 'string' && position.revision.length <= 160)
    || !(position.expiryAt === null || receiptTime(position.expiryAt) !== null)
    || !Number.isSafeInteger(position.clockAt) || position.clockAt < 0
    || !(position.partial === null || position.partial && typeof position.partial.seq === 'string' && DECIMAL.test(position.partial.seq)
      && Number.isSafeInteger(position.partial.offset) && position.partial.offset > 0 && /^[a-f0-9]{64}$/.test(position.partial.hash))) {
    throw new UserMemoryHistoryCursorError();
  }
  return { origin: value.origin as UserMemoryHistoryOrigin, position: { ...position } as HistoryPosition, totals: { ...totals } as HistoryTotals };
}

function historyExcerpt(text: string, offset: number): { excerpt: string; nextOffset: number } {
  let excerpt = '', bytes = 0;
  for (const char of text.slice(offset)) {
    const size = jsonBytes(char) - 2;
    if (bytes + size > 2048) break;
    excerpt += char; bytes += size;
  }
  return { excerpt, nextOffset: offset + excerpt.length };
}

/** One bounded local page of a dated range, in storage order. Timestamps may be out of order. */
export async function listUserInstructionHistory(input: {
  memoryId: string; start: string; end: string; cursor?: string; origin?: UserMemoryHistoryOrigin;
  list: (request: { memoryIds: string[]; limit: number; source: 'local'; beforeSeq?: string }) => Promise<HistoryPage>;
  limits?: UserMemoryHistoryLimits; now?: () => number;
}) {
  const range = userMemoryRange(input.start, input.end, input.cursor, input.origin);
  const resumed = range.cursor ? decodeHistoryCursor(range.cursor, input.memoryId, range.start, range.end, range.origin) : null;
  const origin = resumed?.origin ?? range.origin ?? 'all';
  const limits = input.limits ?? USER_MEMORY_HISTORY_LIMITS, now = input.now ?? Date.now;
  const observedStart = now(), startedAt = Number.isSafeInteger(observedStart) && observedStart >= 0 ? observedStart : 0;
  const from = Date.parse(range.start), until = Date.parse(range.end), deadline = startedAt + limits.deadlineMs;
  const totals: HistoryTotals = resumed?.totals ?? { rows: 0, inRange: 0, returned: 0, filtered: 0, truncated: 0, skipped: 0, inconsistent: false, collectionUnknown: false, collectionPartial: false, collectionOutdated: false, retentionUnknown: false, retentionExpired: false, clockUnknown: false, clockReversed: false };
  const previouslyReturned = totals.returned;
  const position: HistoryPosition = resumed?.position ?? { beforeSeq: null, floor: null, covered: null, target: null, segmentDone: false, partial: null, revision: null, expiryAt: null, clockAt: startedAt };
  let rows = 0, calls = 0, hitBytes = 0, exhausted = false, unverified = false, stoppedBy: StopReason = 'end';
  let lastPage: HistoryPage | null = null;
  let mutationChanged = false;
  const hits: Array<Record<string, unknown>> = [];
  const halt = () => { totals.inconsistent = true; stoppedBy = 'inconsistent'; };
  const checkExpiry = () => {
    const observed = now();
    if (!Number.isSafeInteger(observed) || observed < 0) totals.clockUnknown = true;
    else if (observed < position.clockAt) { totals.clockReversed = true; halt(); }
    else position.clockAt = observed;
    if (position.expiryAt !== null && observed >= Date.parse(position.expiryAt)) {
      totals.retentionExpired = true; halt();
    }
  };
  // A later healthy page cannot erase an earlier incomplete scan, including across cursor resumptions.
  const recordCollection = (page: HistoryPage) => {
    if (page.scan?.clockGuard === 'reversed') { totals.clockReversed = true; halt(); }
    else if (page.scan?.clockGuard !== 'guarded' || !Number.isSafeInteger(page.scan.observedAt) || page.scan.observedAt! < 0) totals.clockUnknown = true;
    else if (page.scan.observedAt! < position.clockAt) { totals.clockReversed = true; halt(); }
    else position.clockAt = page.scan.observedAt!;
    if (!page.scan || !Object.hasOwn(page.scan, 'nextExpiryAt')) totals.retentionUnknown = true;
    else if (page.scan.nextExpiryAt !== null) {
      const expiry = receiptTime(page.scan.nextExpiryAt);
      if (expiry === null) totals.retentionUnknown = true;
      else if (position.expiryAt === null || expiry < Date.parse(position.expiryAt)) position.expiryAt = new Date(expiry).toISOString();
    }
    checkExpiry();
    if (page.scan?.mutationChanged === true) { mutationChanged = true; halt(); }
    if (page.scan?.revision) {
      if (position.revision !== null && position.revision !== page.scan.revision) { mutationChanged = true; halt(); }
      position.revision = page.scan.revision;
    }
    if (typeof page.scan?.complete !== 'boolean') totals.collectionUnknown = true;
    else if (!page.scan.complete || page.scan.unreadable || page.scan.withheld) totals.collectionPartial = true;
    else {
      const scannedThrough = receiptTime(page.scan.scannedThrough);
      if (scannedThrough === null) totals.collectionUnknown = true;
      else if (scannedThrough < until) totals.collectionOutdated = true;
    }
  };
  try {
    // Check the first wall-clock observation against the signed prior page.
    if (!Number.isSafeInteger(observedStart) || observedStart < 0) totals.clockUnknown = true;
    else if (observedStart < position.clockAt) { totals.clockReversed = true; halt(); }
    pages: for (;;) {
      checkExpiry();
      if (totals.inconsistent) break;
      // The look for newer rows reads one row, so only the call and time budgets apply to it.
      if (calls >= limits.calls || !position.segmentDone && rows >= limits.rows) { stoppedBy = 'scan-budget'; break; }
      if (calls > 0 && now() >= deadline) { stoppedBy = 'deadline'; break; }
      if (position.segmentDone) {
        const missed = position.target !== null && (position.covered === null || BigInt(position.covered) < BigInt(position.target));
        const probe = await input.list({ memoryIds: [input.memoryId], limit: 1, source: 'local' });
        calls += 1; lastPage = probe; recordCollection(probe);
        if (totals.inconsistent) break;
        const newest = probe.items[0]?.seq;
        if (newest === undefined) { unverified = probe.hasMore; exhausted = true; break; }
        if (typeof newest !== 'string' || !DECIMAL.test(newest)) { halt(); break; }
        // A segment that never read the newest row it started from may end only if that row is gone (deleted
        // meanwhile); a row still listed above everything read but not above that target went unread.
        if (missed && BigInt(newest) <= BigInt(position.target!) && (position.covered === null || BigInt(newest) > BigInt(position.covered))) { halt(); break; }
        if (position.covered !== null && BigInt(newest) <= BigInt(position.covered)) { exhausted = true; break; }
        Object.assign(position, { beforeSeq: null, floor: position.covered, target: newest, segmentDone: false });
        continue;
      }
      const readBefore = position.partial ? (BigInt(position.partial.seq) + 1n).toString() : position.beforeSeq;
      // Continuations can consume only this one retained row: the list
      // endpoint also reads an adjacent row to establish hasMore. Fetching a
      // full page here repeatedly decrypts unrelated entries for every part.
      const pageLimit = position.partial ? 1 : Math.min(limits.listPage, limits.rows - rows);
      const page = await input.list({ memoryIds: [input.memoryId], limit: pageLimit, source: 'local', ...(readBefore ? { beforeSeq: readBefore } : {}) });
      calls += 1; lastPage = page; recordCollection(page);
      if (totals.inconsistent) break;
      if (position.partial && page.items[0]?.seq !== position.partial.seq) { halt(); break; }
      const pageStart = position.beforeSeq;
      for (const row of page.items) {
        // Each row must lie strictly below the position already read, or a cursor could skip or repeat rows.
        if (typeof row.seq !== 'string' || !DECIMAL.test(row.seq) || (position.beforeSeq !== null && BigInt(row.seq) >= BigInt(position.beforeSeq))) { halt(); break pages; }
        if (position.floor !== null && BigInt(row.seq) <= BigInt(position.floor)) { position.segmentDone = true; continue pages; }
        const rowHash = () => createHash('sha256').update(JSON.stringify(row)).digest('hex');
        if (position.partial && (row.seq !== position.partial.seq || rowHash() !== position.partial.hash)) { halt(); break pages; }
        let inRange = false;
        const at = Date.parse(row.recordedAt);
        if (row.memoryId !== input.memoryId || !Number.isFinite(at)) totals.skipped += 1;
        else if (at >= from && at < until) {
          inRange = true;
          const promptOrigin = row.promptOrigin === 'human' || row.promptOrigin === 'agentstoz' ? row.promptOrigin : 'unknown';
          if (origin === 'all' || promptOrigin === origin) {
            let offset = position.partial?.offset ?? 0;
            const sha256 = createHash('sha256').update(row.text).digest('hex');
            do {
              const { excerpt, nextOffset } = historyExcerpt(row.text, offset);
              const multipart = offset > 0 || nextOffset < row.text.length;
              const hit = { source: 'user-instruction', authority: 'historical-evidence', memoryId: input.memoryId, id: row.id.slice(0, 160),
                recordedAt: row.recordedAt.slice(0, 64), agent: row.agent?.slice(0, 40) ?? null, promptOrigin, excerpt, excerptTruncated: false, caution: true,
                ...(multipart ? { textPart: { offset, nextOffset, totalChars: row.text.length, sha256 } } : {}) };
              const size = jsonBytes(hit);
              // Leave the row unconsumed until all of its body has been delivered. A signed cursor
              // binds each continuation to the same row, body and offset, including between calls.
              if (hits.length >= limits.hits || hitBytes + size > limits.hitBytes) { stoppedBy = 'hit-budget'; break pages; }
              hits.push(hit); hitBytes += size;
              if (nextOffset === row.text.length) { position.partial = null; totals.returned += 1; break; }
              position.partial = { seq: row.seq, offset: nextOffset, hash: rowHash() };
              offset = nextOffset;
            } while (true);
          } else totals.filtered += 1;
        }
        rows += 1; totals.rows += 1; position.beforeSeq = row.seq; position.covered = higher(position.covered, row.seq);
        if (inRange) totals.inRange += 1;
      }
      if (!page.hasMore) { position.segmentDone = true; continue; }
      const next = page.nextBeforeSeq;
      // The next position may skip rows the store did not list (withheld, deleted), but never move back.
      const bound = position.beforeSeq === pageStart ? (pageStart === null ? undefined : BigInt(pageStart) - 1n) : BigInt(position.beforeSeq!);
      if (typeof next !== 'string' || !DECIMAL.test(next) || (bound !== undefined && BigInt(next) > bound)) { halt(); break; }
      position.beforeSeq = next;
      if (position.floor !== null && BigInt(next) <= BigInt(position.floor) + 1n) position.segmentDone = true;
    }
  } catch {
    return { state: 'unavailable' as const, scope: 'project-local' as const, memoryId: input.memoryId, hits: [], nextCursor: null, complete: false, incomplete: ['unavailable'] as IncompleteReason[],
      coverage: { collection: 'unknown' as const, endBoundary: 'unconfirmed' as const, retentionGuard: 'unknown' as const, clockGuard: 'unknown' as const, historical: 'unknown' as const, deviceScope: 'local-device' as const } };
  }
  checkExpiry();
  if (totals.retentionExpired || totals.clockReversed || mutationChanged) { hits.length = 0; totals.returned = previouslyReturned; }
  const page = lastPage;
  const nextCursor = exhausted || totals.inconsistent ? null : historyCursor(input.memoryId, range.start, range.end, origin, position, totals);
  const collection = totals.collectionPartial ? 'partial' as const
    : totals.collectionUnknown || !page ? 'unknown' as const : 'reported-complete' as const;
  // Why this traversal cannot yet claim the whole range; empty only when it can.
  const incomplete: IncompleteReason[] = [
    ...(nextCursor ? ['more-pages' as const] : []),
    ...(totals.inconsistent ? ['changed-or-out-of-order' as const] : []),
    ...(unverified ? ['newest-row-unverified' as const] : []),
    ...(totals.truncated ? ['truncated-excerpts' as const] : []),
    ...(totals.skipped ? ['skipped-rows' as const] : []),
    ...(collection === 'reported-complete' ? [] : [`collection-${collection}` as const]),
    ...(totals.collectionOutdated ? ['collection-outdated' as const] : []),
    ...(totals.retentionUnknown ? ['retention-unknown' as const] : []),
    ...(totals.retentionExpired ? ['retention-expired' as const] : []),
    ...(totals.clockUnknown ? ['clock-unknown' as const] : []),
    ...(totals.clockReversed ? ['clock-reversed' as const] : []),
  ];
  return { state: 'ready' as const, scope: 'project-local' as const, memoryId: input.memoryId, range: { start: range.start, end: range.end }, origin, hits,
    nextCursor,
    // The rows must all be read and the collection receipt must reach the requested end.
    complete: exhausted && incomplete.length === 0,
    incomplete,
    traversal: { rows: totals.rows, inRange: totals.inRange, returned: totals.returned, filtered: totals.filtered,
      truncated: totals.truncated, skipped: totals.skipped, inconsistent: totals.inconsistent, stoppedBy: exhausted ? 'end' as const : stoppedBy },
    coverage: { collection, endBoundary: collection === 'reported-complete' && !totals.collectionOutdated ? 'confirmed' as const : 'unconfirmed' as const,
      retentionGuard: totals.retentionExpired ? 'expired' as const : totals.retentionUnknown ? 'unknown' as const : 'guarded' as const,
      clockGuard: totals.clockReversed ? 'reversed' as const : totals.clockUnknown ? 'unknown' as const : 'guarded' as const,
      scannedThrough: receiptTime(page?.scan?.scannedThrough) === null ? null : page!.scan!.scannedThrough!,
      lastCaptureAt: typeof page?.capture?.lastCaptureAt === 'string' ? page.capture.lastCaptureAt.slice(0, 64) : null,
      historical: 'unknown' as const, historicalWithheld: page?.scan?.historicalWithheld ?? null, deviceScope: 'local-device' as const, order: 'storage' as const } };
}
