/** Read the authenticated common catalog, including legacy device-tagged rows.
 * No writes or URL-based deduplication: different IDs remain distinct bookmarks.
 */
export async function readCommonBookmarkRows<T extends { id: string }>(
  readPage: (from: number, to: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [], ids = new Set<string>();
  let bytes = 0;
  for (let from = 0; from <= 10000; from += 500) {
    const page = await readPage(from, from + 499);
    if (!Array.isArray(page) || page.length > 500) throw new Error('북마크 조회 결과를 확인하세요.');
    for (const row of page) {
      if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('북마크 목록이 변경되었습니다. 다시 새로고침하세요.');
      ids.add(row.id);
      bytes += new TextEncoder().encode(JSON.stringify(row)).byteLength;
      if (ids.size > 10000 || bytes > 8 * 1024 * 1024) throw new Error('북마크 조회 한도를 초과했습니다. 기존 목록은 유지합니다.');
      rows.push(row);
    }
    if (page.length < 500) return rows;
  }
  throw new Error('북마크 전체 조회를 완료하지 못했습니다.');
}
