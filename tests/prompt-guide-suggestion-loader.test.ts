import { describe, expect, test } from 'bun:test';
import { loadPromptGuideSuggestions } from '../src/promptGuideSuggestionLoader';
import type { promptGuideClient } from '../src/promptGuideClient';
import {analyzePromptGuideSuggestions, PROMPT_GUIDE_LIMITS} from '../src/promptGuideSuggestions';

type Page = Awaited<ReturnType<typeof promptGuideClient.humanPage>>;
type Item = Page['items'][number];
const instruction = '변경한 내용을 검토하고 필요한 테스트 결과를 정리해줘.';
const item = (id: string, overrides: Partial<Item> = {}): Item => ({
  id, seq: '1', recordedAt: '2026-09-09T01:02:03.000Z', agent: 'codex', projectId: 'project-fixture',
  memoryId: 'memory-fixture', projectName: 'Private fixture project', text: instruction,
  deviceId: 'device-fixture', deviceName: 'Private fixture device', promptOrigin: 'human', storage: 'local',
  ...overrides,
});
const page = (items: Item[] = [], overrides: Partial<Page> = {}): Page => ({
  items, nextBeforeSeq: null, hasMore: false, source: 'local', scan: null, capture: null, ...overrides,
});
function sequence(pages: Page[]) {
  const calls: Array<string | undefined> = [];
  return { calls, async read(cursor?: string): Promise<Page> {
    calls.push(cursor);
    const next = pages[calls.length - 1];
    if (!next) throw new Error('Unexpected extra page request');
    return next;
  } };
}

describe('bounded prompt-guide suggestion sampling with injected pages only', () => {
  test('follows protected-list cursors and reports source/count without leaking record metadata', async () => {
    const source = sequence([
      page([item('one')], { source: 'supabase', hasMore: true, nextBeforeSeq: 'wisr1_20' }),
      page([item('two')], { source: 'supabase' }),
    ]);
    const result = await loadPromptGuideSuggestions(undefined, source.read);
    expect(source.calls).toEqual([undefined, 'wisr1_20']);
    expect(result.sample).toMatchObject({ source: 'supabase', fetched: 2, hasMore: false });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ body: instruction, count: 2, kind: 'repeat' });
    expect(JSON.stringify(result)).not.toContain('Private fixture');
    expect(JSON.stringify(result)).not.toContain('device-fixture');
    expect(JSON.stringify(result)).not.toContain('project-fixture');
  });

  test.each([['local', 'supabase'], ['supabase', 'local']] as const)('rejects a source transition from %s to %s', async (first, second) => {
    const source = sequence([
      page([item('one')], { source: first, hasMore: true, nextBeforeSeq: 'cursor-1' }),
      page([item('two')], { source: second, hasMore: true, nextBeforeSeq: 'cursor-2' }),
    ]);
    await expect(loadPromptGuideSuggestions(undefined, source.read)).rejects.toThrow('기록 저장소가 바뀌었습니다');
    expect(source.calls).toEqual([undefined, 'cursor-1']);
  });

  test.each([null, ''])('rejects hasMore with a missing/empty next cursor (%s)', async cursor => {
    const source = sequence([page([item('one')], { hasMore: true, nextBeforeSeq: cursor })]);
    await expect(loadPromptGuideSuggestions(undefined, source.read)).rejects.toThrow('다음 페이지를 확인하지 못했습니다');
    expect(source.calls).toHaveLength(1);
  });

  test('rejects an unchanged cursor without issuing a third request', async () => {
    const source = sequence([
      page([item('one')], { hasMore: true, nextBeforeSeq: 'same' }),
      page([item('two')], { hasMore: true, nextBeforeSeq: 'same' }),
    ]);
    await expect(loadPromptGuideSuggestions(undefined, source.read)).rejects.toThrow('다음 페이지를 확인하지 못했습니다');
    expect(source.calls).toEqual([undefined, 'same']);
  });

  test('rejects a cursor cycle across different pages', async () => {
    const source = sequence([
      page([], { hasMore: true, nextBeforeSeq: 'first' }),
      page([], { hasMore: true, nextBeforeSeq: 'second' }),
      page([], { hasMore: true, nextBeforeSeq: 'first' }),
    ]);
    await expect(loadPromptGuideSuggestions(undefined, source.read)).rejects.toThrow('다음 페이지를 확인하지 못했습니다');
    expect(source.calls).toEqual([undefined, 'first', 'second']);
  });

  test('rejects a page with more than 100 rows before collecting another page', async () => {
    const source = sequence([page(Array.from({ length: 101 }, (_, i) => item(String(i))), { hasMore: true, nextBeforeSeq: 'unused' })]);
    await expect(loadPromptGuideSuggestions(undefined, source.read)).rejects.toThrow('표본 범위를 확인하지 못했습니다');
    expect(source.calls).toHaveLength(1);
  });

  test('stops at five 100-row pages and explicitly reports an incomplete 500-row sample', async () => {
    const source = sequence(Array.from({ length: 6 }, (_, index) => page(
      Array.from({ length: 100 }, (_, offset) => item(`event-${index * 100 + offset}`)),
      { source: 'supabase', hasMore: true, nextBeforeSeq: `page-${index + 1}` },
    )));
    const result = await loadPromptGuideSuggestions(undefined, source.read);
    expect(source.calls).toEqual([undefined, 'page-1', 'page-2', 'page-3', 'page-4']);
    expect(result.sample).toMatchObject({ source: 'supabase', fetched: 500, hasMore: true });
    expect(result.stats.receivedEntries).toBe(500);
    expect(result.stats.inspectedEntries).toBe(500);
    expect(result.stats.excludedByReason['entry-limit']).toBe(0);
    expect(result.candidates[0]).toMatchObject({ kind: 'repeat', body: instruction, count: 500 });
  });

  test('validates the final bounded page cursor even though a sixth page will not be read', async () => {
    const source = sequence(Array.from({ length: 5 }, (_, i) => page([], {
      hasMore: true, nextBeforeSeq: i === 4 ? null : `page-${i + 1}`,
    })));
    await expect(loadPromptGuideSuggestions(undefined, source.read)).rejects.toThrow('다음 페이지를 확인하지 못했습니다');
    expect(source.calls).toHaveLength(5);
  });

  test('an empty terminal page is an empty result, with no invented candidates or extra reads', async () => {
    const source = sequence([page()]);
    const result = await loadPromptGuideSuggestions(undefined, source.read);
    expect(source.calls).toEqual([undefined]);
    expect(result.sample).toMatchObject({ source: 'local', fetched: 0, hasMore: false });
    expect(result.candidates).toEqual([]);
    expect(result.stats.receivedEntries).toBe(0);
    expect(result.stats.sampledEntries).toBe(0);
  });

  test('an empty page with an advancing cursor does not hide later matching prompts', async () => {
    const source = sequence([
      page([], { hasMore: true, nextBeforeSeq: 'next' }),
      page([item('one'), item('two')], { hasMore: false, nextBeforeSeq: 'ignored-terminal-cursor' }),
    ]);
    const result = await loadPromptGuideSuggestions(undefined, source.read);
    expect(source.calls).toEqual([undefined, 'next']);
    expect(result.sample).toMatchObject({ source: 'local', fetched: 2, hasMore: false });
    expect(result.candidates[0]?.count).toBe(2);
  });

  test('an already-aborted request never reads a page', async () => {
    const controller = new AbortController(); controller.abort();
    const source = sequence([page([item('one')])]);
    await expect(loadPromptGuideSuggestions(controller.signal, source.read)).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.calls).toEqual([]);
  });

  test('abort while awaiting a page ignores its late result and never asks for the next page', async () => {
    const controller = new AbortController();
    let resolvePage!: (value: Page) => void;
    let calls = 0;
    const pending = loadPromptGuideSuggestions(controller.signal, async () => {
      calls++;
      return await new Promise<Page>(resolve => { resolvePage = resolve; });
    });
    expect(calls).toBe(1);
    controller.abort();
    resolvePage(page([item('one'), item('two')], { hasMore: true, nextBeforeSeq: 'never-read' }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  test('abort on a later page returns no partial suggestions and prevents further sampling', async () => {
    const controller = new AbortController(); const calls: Array<string | undefined> = [];
    await expect(loadPromptGuideSuggestions(controller.signal, async cursor => {
      calls.push(cursor);
      if (calls.length === 2) controller.abort();
      return page([item(`event-${calls.length}`)], { hasMore: true, nextBeforeSeq: String(calls.length) });
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([undefined, '1']);
  });

  test('a page failure after valid input does not return partial candidates', async () => {
    const failure = new Error('Synthetic protected-list failure'); let calls = 0;
    await expect(loadPromptGuideSuggestions(undefined, async () => {
      calls++;
      if (calls === 2) throw failure;
      return page([item('one'), item('two')], { hasMore: true, nextBeforeSeq: 'next' });
    })).rejects.toBe(failure);
    expect(calls).toBe(2);
  });

  test('miner still excludes duplicates, nonhuman provenance and unsafe/unusable text across pages', async () => {
    const source = sequence([
      page([item('same'), item('auto', { promptOrigin: 'agentstoz' })], { hasMore: true, nextBeforeSeq: 'next' }),
      page([
        item('same'), item('same', { memoryId: 'other-memory' }), item('unknown', { promptOrigin: 'unknown' }),
        item('sensitive', { text: '비밀번호를 사용해서 서버를 설정해줘.' }),
        item('code', { text: '```ts\nconst value = 1;\n```' }),
        item('boilerplate', { text: 'English translation: review these changes before saving.' }),
        item('short', { text: '진행해' }),
      ]),
    ]);
    const result = await loadPromptGuideSuggestions(undefined, source.read);
    expect(result.sample.fetched).toBe(9);
    expect(result.stats.sampledEntries).toBe(2);
    expect(result.stats.excludedByReason).toMatchObject({
      'duplicate-identity': 1, 'not-human': 2, sensitive: 1, 'quoted-or-code': 1, 'app-boilerplate': 1, short: 1,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ body: instruction, count: 2 });
    expect(JSON.stringify(result)).not.toContain('비밀번호');
    expect(JSON.stringify(result)).not.toContain('English translation:');
  });

  test('passes the caller abort signal into the active page request', async () => {
    const controller = new AbortController(); let calls = 0;
    const pending = loadPromptGuideSuggestions(controller.signal, async (_cursor, signal) => {
      calls++; expect(signal).toBe(controller.signal);
      return await new Promise<Page>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), {once: true}));
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(calls).toBe(1);
  });

  test('uses observed scan maxima instead of summing repeated local source restrictions', async () => {
    const source = sequence([
      page([item('one')], {hasMore: true, nextBeforeSeq: 'next', scan: {complete: false, unreadable: 3, withheld: 5}}),
      page([item('two')], {hasMore: true, nextBeforeSeq: 'last', scan: {complete: false, unreadable: 3, withheld: 5}}),
      page([], {scan: null}),
    ]);
    const result = await loadPromptGuideSuggestions(undefined, source.read);
    expect(result.sample).toEqual({source: 'local', fetched: 2, hasMore: false, pages: 3, recordedRange: {newest: '2026-09-09T01:02:03.000Z', oldest: '2026-09-09T01:02:03.000Z'},
      scan: {complete: false, unreadableMax: 3, withheldMax: 5, unknownPages: 1}});
  });

  test('distinguishes wholly known scan completion from unknown source coverage', async () => {
    const known = await loadPromptGuideSuggestions(undefined, sequence([page([], {scan: {complete: true, unreadable: 0, withheld: 0}})]).read);
    expect(known.sample.scan).toEqual({complete: true, unreadableMax: 0, withheldMax: 0, unknownPages: 0});
    const unknown = await loadPromptGuideSuggestions(undefined, sequence([page()]).read);
    expect(unknown.sample.scan).toEqual({complete: null, unreadableMax: 0, withheldMax: 0, unknownPages: 1});
  });

  test('streamed pages use the exact array classifier and budget without collecting raw history', async () => {
    const rows: Item[] = Array.from({length: 300}, (_, index) => item(`large-${index}`, {text: `작업 ${String.fromCharCode(0xac00 + index % 20)} 결과를 확인해줘. `.repeat(20)}));
    rows[1] = item('large-0');
    rows[2] = item('oversized', {text: instruction.repeat(200)});
    rows[3] = item('sensitive', {text: 'password=fixture ' + instruction.repeat(5)});
    rows[4] = item('automatic', {promptOrigin: 'agentstoz'});
    const source = sequence([0, 1, 2].map(index => page(rows.slice(index * 100, index * 100 + 100),
      {hasMore: index < 2, nextBeforeSeq: index < 2 ? `page-${index + 1}` : null})));
    const {sample, ...analysis} = await loadPromptGuideSuggestions(undefined, source.read);
    expect(analysis).toEqual(analyzePromptGuideSuggestions(rows.map(row => ({id: row.id, memoryId: row.memoryId, text: row.text, promptOrigin: row.promptOrigin, recordedAt: row.recordedAt})), {includeRecent: true}));
    expect(sample.fetched).toBe(300);
    expect(analysis.stats.analyzedTextBytes).toBeLessThanOrEqual(PROMPT_GUIDE_LIMITS.inputTextBytes);
    expect(analysis.stats.excludedByReason).toMatchObject({'duplicate-identity': 1, 'too-long': 1, sensitive: 1, 'not-human': 1});
    expect(analysis.stats.excludedByReason['text-budget']).toBeGreaterThan(0);
    expect(analysis.stats.receivedEntries).toBe(analysis.stats.sampledEntries + analysis.stats.excludedEntries);
  });

  test('does not mine the normal-looking prefix of any 64KiB source entry', async () => {
    let calls = 0;
    const result = await loadPromptGuideSuggestions(undefined, async () => {
      const offset = calls++ * 100;
      return page(Array.from({length: 100}, (_, index) => item(`raw-${offset + index}`, {text: instruction + 'x'.repeat(65_000)})),
        {hasMore: true, nextBeforeSeq: `next-${calls}`});
    });
    expect(calls).toBe(5); expect(result.sample.fetched).toBe(500);
    expect(result.stats.excludedByReason['too-long']).toBe(500);
    expect(result.stats.analyzedTextBytes).toBe(0); expect(result.candidates).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(instruction);
  });
});
