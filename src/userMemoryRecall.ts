/** Explicit, project-scoped historical lookup. Never imports prompts or changes capture policy. */
export function userMemoryQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw Error('사용자 기억 검색어를 짧게 입력하세요.');
  const query = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().normalize('NFKC');
  if (!query || new TextEncoder().encode(query).length > 1024) throw Error('사용자 기억 검색어는 정규화 후 UTF-8 1,024 bytes 이내여야 합니다.');
  return query;
}

export async function recallUserInstructions(input: {
  memoryId: string;
  query: string;
  list: (request: { memoryIds: string[]; query: string; limit: number; source: 'local' }) => Promise<{
    items: readonly { id: string; memoryId?: string | null; recordedAt: string; text: string; promptOrigin?: string; agent?: string }[];
    hasMore: boolean;
    scan?: { complete?: boolean; unreadable?: number; withheld?: number } | null;
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
    return {
      state: 'ready' as const, scope: 'project-local' as const, memoryId: input.memoryId, hits,
      complete: !page.hasMore && page.scan?.complete !== false && !page.scan?.unreadable && !page.scan?.withheld
        && page.items.length === hits.length && !truncated,
    };
  } catch {
    // Never expose the error: it may contain local paths, ciphertext or key-provider details.
    return { state: 'unavailable' as const, scope: 'project-local' as const, memoryId: input.memoryId, hits: [], complete: false };
  }
}
