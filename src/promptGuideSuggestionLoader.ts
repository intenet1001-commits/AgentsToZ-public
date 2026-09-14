import {promptGuideClient, type PromptGuideHumanPage} from './promptGuideClient';
import {createPromptGuideSuggestionAnalyzer, type PromptGuideAnalysis} from './promptGuideSuggestions';

export interface PromptGuideSuggestionSample {
  source: 'local' | 'supabase';
  fetched: number;
  hasMore: boolean;
  pages: number;
  recordedRange: {newest: string | null; oldest: string | null};
  scan: {complete: boolean | null; unreadableMax: number; withheldMax: number; unknownPages: number};
}
export type PromptGuideSuggestionResult = PromptGuideAnalysis & {sample: PromptGuideSuggestionSample};
export async function loadPromptGuideSuggestions(signal?: AbortSignal,
  readPage: (cursor?: string, signal?: AbortSignal) => Promise<PromptGuideHumanPage> = promptGuideClient.humanPage,
  options: {includeShortRepeats?: boolean} = {},
): Promise<PromptGuideSuggestionResult> {
  const analyzer = createPromptGuideSuggestionAnalyzer({...options, includeRecent: true});
  const cursors = new Set<string>();
  let cursor: string | undefined, source: 'local' | 'supabase' | undefined, hasMore = false, fetched = 0, pages = 0;
  let incomplete = false, unreadableMax = 0, withheldMax = 0, unknownPages = 0;
  let newest = -Infinity, oldest = Infinity;
  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    signal?.throwIfAborted();
    const page = await readPage(cursor, signal);
    signal?.throwIfAborted();
    if (source && page.source !== source) throw new Error('조회 중 기록 저장소가 바뀌었습니다. 다시 추천을 요청해 주세요.');
    source = page.source;
    if (page.items.length > 100) throw new Error('입력 기록의 표본 범위를 확인하지 못했습니다.');
    pages += 1; fetched += page.items.length;
    // Consume each page immediately. The collector retains at most 128KiB of
    // eligible source text and excludes oversized entries whole, never prefixes.
    for (const item of page.items) {
      const timestamp = Date.parse(item.recordedAt);
      if (Number.isFinite(timestamp)) {newest = Math.max(newest, timestamp); oldest = Math.min(oldest, timestamp);}
      analyzer.add({id: item.id, memoryId: item.memoryId, text: item.text, promptOrigin: item.promptOrigin, recordedAt: item.recordedAt});
    }
    if (!page.scan) unknownPages += 1;
    else {
      incomplete ||= !page.scan.complete;
      // Local summaries can recur on every page: these are observed maxima,
      // not counts to add up and claim as distinct missing source entries.
      unreadableMax = Math.max(unreadableMax, page.scan.unreadable);
      withheldMax = Math.max(withheldMax, page.scan.withheld);
    }
    hasMore = page.hasMore;
    if (!hasMore) break;
    const next = page.nextBeforeSeq;
    if (!next || next === cursor || cursors.has(next)) throw new Error('입력 기록의 다음 페이지를 확인하지 못했습니다. 다시 추천을 요청해 주세요.');
    cursors.add(next); cursor = next;
  }
  signal?.throwIfAborted();
  return {...analyzer.finish(), sample: {source: source ?? 'local', fetched, hasMore, pages,
    recordedRange: {newest: Number.isFinite(newest) ? new Date(newest).toISOString() : null, oldest: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null},
    scan: {complete: incomplete ? false : unknownPages ? null : true, unreadableMax, withheldMax, unknownPages}}};
}
