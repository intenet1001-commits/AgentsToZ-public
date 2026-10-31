/** Explicit, project-scoped historical lookup. Never imports prompts or changes capture policy. */
export function userMemoryQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw Error('사용자 기억 검색어를 짧게 입력하세요.');
  const query = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().normalize('NFKC');
  if (!query || new TextEncoder().encode(query).length > 1024) throw Error('사용자 기억 검색어는 정규화 후 UTF-8 1,024 bytes 이내여야 합니다.');
  return query;
}

export type UserMemoryHistoryOrigin = 'all' | 'human';

/** A history continuation this host cannot use: malformed, expired by a restart, or made for other inputs. */
export class UserMemoryHistoryCursorError extends Error {
  readonly code = 'USER_MEMORY_CURSOR_EXPIRED';
  constructor() { super('USER_MEMORY_CURSOR_EXPIRED: the continuation is expired or belongs to other inputs; read the range again from the start.'); }
}

/** Dated history inputs. An absent, null or empty cursor starts the range; an absent origin is taken from the cursor. */
export function userMemoryRange(start: unknown, end: unknown, cursor?: unknown, origin?: unknown) {
  const parse = (value: unknown) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw Error('Invalid date');
    const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (year < 100 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) throw Error('Invalid date');
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw Error('Invalid date');
    return new Date(time).toISOString();
  };
  const from = parse(start), until = parse(end);
  if (from >= until) throw Error('Invalid date range');
  const resume = cursor === null || cursor === '' ? undefined : cursor;
  if (origin !== undefined && origin !== null && origin !== 'all' && origin !== 'human') throw Error('Invalid origin');
  if (resume !== undefined && (typeof resume !== 'string' || resume.length > 2048 || !/^umh1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(resume))) throw new UserMemoryHistoryCursorError();
  return { start: from, end: until, ...(resume === undefined ? {} : { cursor: resume as string }),
    ...(origin === undefined || origin === null ? {} : { origin: origin as UserMemoryHistoryOrigin }) };
}

export async function recallUserInstructions(input: {
  memoryId: string;
  query: string;
  list: (request: { memoryIds: string[]; query: string; limit: number; source: 'local' }) => Promise<{
    items: readonly { id: string; memoryId?: string | null; recordedAt: string; text: string; promptOrigin?: string; agent?: string }[];
    hasMore: boolean;
    scan?: { complete?: boolean; unreadable?: number; withheld?: number } | null;
    capture?: { lastCaptureAt?: string | null } | null;
  }>;
}) {
  try {
    if (!input.memoryId || input.memoryId.length > 200 || !input.query.trim()) throw Error('A scoped query is required');
    const page = await input.list({ memoryIds: [input.memoryId], query: userMemoryQuery(input.query), limit: 5, source: 'local' });
    let truncated = false;
    const hits = page.items.filter(row => row.memoryId === input.memoryId).slice(0, 5).flatMap(row => {
      // Slice by Unicode character, within a UTF-8 byte budget, without splitting a character.
      let excerpt = '', bytes = 0;
      for (const char of row.text) {
        const size = new TextEncoder().encode(JSON.stringify(char)).length - 2;
        if (bytes + size > 2048) break;
        excerpt += char; bytes += size;
      }
      const excerptTruncated = excerpt.length < row.text.length;
      truncated ||= excerptTruncated;
      const hit = {
        source: 'user-instruction' as const, authority: 'historical-evidence' as const,
        memoryId: input.memoryId, id: row.id.slice(0, 160), recordedAt: row.recordedAt.slice(0, 64),
        agent: row.agent?.slice(0, 40) ?? null,
        promptOrigin: row.promptOrigin === 'human' || row.promptOrigin === 'agentstoz' ? row.promptOrigin : 'unknown',
        excerpt, excerptTruncated, caution: true,
      };
      // Include escaped metadata in the bound, even for malformed legacy rows.
      if (new TextEncoder().encode(JSON.stringify(hit)).length > 2800) { truncated = true; return []; }
      return [hit];
    });
    // The in-memory scan summary can be absent after a restart or when no
    // store exists. Neither case proves that all conversations were captured.
    const scanKnown = page.scan?.complete === true;
    const collection = typeof page.scan?.complete !== 'boolean' ? 'unknown' as const
      : scanKnown && !page.scan.unreadable && !page.scan.withheld ? 'reported-complete' as const
        : 'partial' as const;
    const lastCaptureAt = typeof page.capture?.lastCaptureAt === 'string'
      ? page.capture.lastCaptureAt.slice(0, 64) : null;
    return {
      state: 'ready' as const, scope: 'project-local' as const, memoryId: input.memoryId, hits,
      // This flag concerns the bounded lookup, not whether historical
      // conversations from this or another device were ever collected.
      complete: !page.hasMore && collection === 'reported-complete'
        && page.items.length === hits.length && !truncated,
      coverage: { collection, lastCaptureAt, historical: 'unknown' as const,
        deviceScope: 'local-device' as const, queryMatch: 'literal-substring' as const },
    };
  } catch {
    // Never expose the error: it may contain local paths, ciphertext or key-provider details.
    return {
      state: 'unavailable' as const, scope: 'project-local' as const, memoryId: input.memoryId, hits: [], complete: false,
      coverage: { collection: 'unknown' as const, lastCaptureAt: null, historical: 'unknown' as const,
        deviceScope: 'local-device' as const, queryMatch: 'literal-substring' as const },
    };
  }
}
