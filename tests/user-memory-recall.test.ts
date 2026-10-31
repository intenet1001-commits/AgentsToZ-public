import { describe, expect, test } from 'bun:test';
import { recallUserInstructions, userMemoryQuery, userMemoryRange } from '../src/userMemoryRecall';
import { listUserInstructionHistory, UserMemoryHistoryCursorError } from '../src/userMemoryHistoryServer';
import { join } from 'node:path';

const row = (id = 'one', text = '지난 요청 원문', memoryId = 'memory-one') => ({ id, text, memoryId, recordedAt: '2026-10-22T00:00:00Z', agent: 'codex', promptOrigin: 'human' });
describe('explicit user instruction recall', () => {
  test('validates the actual normalized UTF-8 search budget before a store read', () => {
    expect(userMemoryQuery('  검증\n 요청  ')).toBe('검증 요청');
    expect(userMemoryQuery('a'.repeat(1024))).toHaveLength(1024);
    for (const query of ['', 'a'.repeat(1025), '한'.repeat(342), '\ufdfa'.repeat(50)]) expect(()=>userMemoryQuery(query)).toThrow();
  });
  test('queries only one exact memory locally and preserves provenance as historical evidence', async () => {
    const result = await recallUserInstructions({memoryId:'memory-one',query:'지난 요청',list: async request => {
      expect(request).toEqual({memoryIds:['memory-one'],query:'지난 요청',limit:5,source:'local'});
      return {items:[row()],hasMore:false,scan:{complete:true}};
    }});
    expect(result.state).toBe('ready'); expect(result.complete).toBe(true);
    expect(result.coverage).toEqual({collection:'reported-complete',lastCaptureAt:null,historical:'unknown',deviceScope:'local-device',queryMatch:'literal-substring'});
    expect(result.hits[0]).toMatchObject({source:'user-instruction',authority:'historical-evidence',memoryId:'memory-one',id:'one',recordedAt:'2026-10-22T00:00:00Z',promptOrigin:'human',caution:true});
  });
  test('never claims a complete search after a scope mismatch, scan failure or withheld data', async () => {
    for (const page of [
      {items:[row('other','다른 프로젝트','other-memory')],hasMore:false},
      {items:[],hasMore:false}, {items:[],hasMore:false,scan:null},
      {items:[row()],hasMore:false,scan:{}},
      {items:[row()],hasMore:true}, {items:[row()],hasMore:false,scan:{complete:false}},
      {items:[row()],hasMore:false,scan:{complete:true,unreadable:1}},
      {items:[row()],hasMore:false,scan:{complete:true,withheld:1}},
    ]) {
      const result=await recallUserInstructions({memoryId:'memory-one',query:'요청',list:async()=>page});
      expect(result.complete).toBe(false);expect(result.hits.every(hit=>hit.memoryId==='memory-one')).toBe(true);
    }
  });
  test('distinguishes missing collection evidence from a reported partial scan and retains freshness', async () => {
    const recall = (page: any) => recallUserInstructions({memoryId:'memory-one',query:'요청',list:async()=>page});
    const missing=await recall({items:[],hasMore:false,scan:null,capture:null});
    expect(missing.complete).toBe(false);
    expect(missing.coverage).toEqual({collection:'unknown',lastCaptureAt:null,historical:'unknown',deviceScope:'local-device',queryMatch:'literal-substring'});
    const partial=await recall({items:[row()],hasMore:false,scan:{complete:false},capture:{lastCaptureAt:'2026-10-27T01:00:00Z'}});
    expect(partial.complete).toBe(false);
    expect(partial.coverage).toEqual({collection:'partial',lastCaptureAt:'2026-10-27T01:00:00Z',historical:'unknown',deviceScope:'local-device',queryMatch:'literal-substring'});
  });
  test('bounds hits, UTF-8 and escaped JSON without splitting Korean or emoji', async () => {
    for (const text of ['한글😀'.repeat(2000),'\u0001'.repeat(5000)]) {
      const result=await recallUserInstructions({memoryId:'memory-one',query:'요청',list:async()=>({items:Array.from({length:10},(_,i)=>row(String(i),text)),hasMore:true})});
      expect(result.hits).toHaveLength(5);expect(result.complete).toBe(false);
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(16_384);
      expect(result.hits.every(hit=>!hit.excerpt.includes('\ufffd')&&hit.excerptTruncated)).toBe(true);
    }
  });
  test('returns an unavailable read without leaking a provider error or retrying', async () => {
    let calls=0;
    const result=await recallUserInstructions({memoryId:'memory-one',query:'요청',list:async()=>{calls++;throw Error('/private/key-provider secret');}});
    expect(calls).toBe(1);expect(result).toEqual({state:'unavailable',scope:'project-local',memoryId:'memory-one',hits:[],complete:false,coverage:{collection:'unknown',lastCaptureAt:null,historical:'unknown',deviceScope:'local-device',queryMatch:'literal-substring'}});
  });
});

describe('dated local user instruction history', () => {
  const start = '2026-10-24T00:00:00Z', end = '2026-10-28T00:00:00Z';
  type FakeRow = { seq: number; recordedAt: string; origin?: string; text?: string; memoryId?: string; hidden?: boolean };
  // Lists visible rows below beforeSeq in descending seq order, as the local What I Said list does.
  // Hidden (withheld) rows are scanned but not listed, so nextBeforeSeq can fall below the last item.
  const fakeStore = (rows: FakeRow[], scan: any = { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, scannedThrough: end, observedAt: Date.now() }, observe: () => number = Date.now) => {
    const calls: string[] = [];
    const list = async (request: { memoryIds: string[]; limit: number; source: 'local'; beforeSeq?: string }) => {
      calls.push(`${request.beforeSeq ?? 'top'}:${request.limit}`);
      const before = request.beforeSeq === undefined ? Infinity : Number(request.beforeSeq);
      const scanned = rows.filter(row => row.seq < before).sort((left, right) => right.seq - left.seq);
      const items: any[] = [];
      let lastScanned: number | null = null;
      for (const row of scanned) {
        if (items.length === request.limit) break;
        lastScanned = row.seq;
        if (!row.hidden) items.push({ id: `row-${row.seq}`, seq: String(row.seq), memoryId: row.memoryId ?? 'memory-one',
          recordedAt: row.recordedAt, text: row.text ?? `요청 ${row.seq}`, agent: 'codex', promptOrigin: row.origin ?? 'human' });
      }
      const hasMore = lastScanned !== null && scanned.some(row => row.seq < lastScanned!);
      return { items, hasMore, nextBeforeSeq: hasMore ? String(lastScanned) : null,
        scan: scan?.clockGuard === 'guarded' ? { ...scan, observedAt: observe() } : scan };
    };
    return { list, calls, rows };
  };
  const traverse = async (list: any, options: Record<string, unknown> = {}, between: (index: number) => void = () => {}) => {
    const pages: any[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 2000; index += 1) {
      const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, cursor, list, ...options });
      pages.push(page);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      between(index);
    }
    return pages;
  };
  const ids = (pages: any[]) => pages.flatMap(page => page.hits.filter((hit: any) => !hit.textPart || hit.textPart.nextOffset === hit.textPart.totalChars).map((hit: any) => hit.id));
  const expectedIds = (rows: FakeRow[], keep: (row: FakeRow) => boolean) => rows.filter(keep).sort((left, right) => right.seq - left.seq).map(row => `row-${row.seq}`);
  const inRange = (seq: number) => `2026-10-2${4 + (seq % 4)}T0${seq % 10}:00:00Z`;
  const outside = (seq: number) => `2026-10-1${seq % 10}T00:00:00Z`;
  const limits = (overrides: Record<string, number>) => ({ rows: 400, listPage: 100, calls: 8, hits: 20, hitBytes: 12_288, deadlineMs: 2_500, ...overrides });

  test('does not claim the requested interval was collected when the receipt stops before its end', async () => {
    const page: any = await listUserInstructionHistory({
      memoryId: 'memory-one', start, end,
      list: fakeStore([{ seq: 1, recordedAt: inRange(1) }], { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, scannedThrough: '2026-10-27T23:58:45Z' }).list,
    });
    expect(page).toMatchObject({ complete: false, incomplete: ['collection-outdated'],
      traversal: { returned: 1, truncated: 0, skipped: 0, stoppedBy: 'end' },
      coverage: { collection: 'reported-complete', scannedThrough: '2026-10-27T23:58:45Z', endBoundary: 'unconfirmed' } });
  });

  test('requires a valid receipt through the exclusive end, accepting equal or later timestamps', async () => {
    const row = [{ seq: 1, recordedAt: inRange(1) }];
    for (const timestamp of [end, '2026-10-28T09:00:00+09:00', '2026-10-28T00:00:00.001Z']) {
      const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end,
        list: fakeStore(row, { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, scannedThrough: timestamp }).list });
      expect(page).toMatchObject({ complete: true, incomplete: [], coverage: { endBoundary: 'confirmed' } });
    }
    for (const timestamp of [undefined, null, '', '2026-10-28', '2026-02-30T00:00:00Z', '/private/secret']) {
      const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end,
        list: fakeStore(row, { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, scannedThrough: timestamp }).list });
      expect(page).toMatchObject({ complete: false, incomplete: ['collection-unknown'],
        coverage: { collection: 'unknown', endBoundary: 'unconfirmed', scannedThrough: null } });
      expect(JSON.stringify(page)).not.toContain('/private/secret');
    }
    const before: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end,
      list: fakeStore(row, { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, scannedThrough: '2026-10-27T23:59:59.999Z' }).list });
    expect(before).toMatchObject({ complete: false, incomplete: ['collection-outdated'], coverage: { endBoundary: 'unconfirmed' } });
  });

  test('preserves an earlier unconfirmed collection boundary across cursor resumptions', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ seq: 4 - i, recordedAt: inRange(i) }));
    const { list } = fakeStore(rows);
    let calls = 0;
    const varyingList: typeof list = async request => ({ ...await list(request),
      scan: { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, observedAt: Date.now(), scannedThrough: ++calls === 1 ? '2026-10-27T23:58:45Z' : end } });
    const pages = await traverse(varyingList, { limits: limits({ rows: 2, listPage: 2 }) });
    expect(pages.length).toBeGreaterThan(1);
    expect(ids(pages)).toHaveLength(4);
    expect(pages.at(-1)).toMatchObject({ complete: false, nextCursor: null, incomplete: ['collection-outdated'],
      coverage: { collection: 'reported-complete', endBoundary: 'unconfirmed' } });
  });

  test('halts a resumed history before exposing a page after an observed row expires', async () => {
    let clock = Date.parse('2026-10-27T12:00:00Z');
    const expiry = new Date(clock + 5_000).toISOString();
    const rows = Array.from({ length: 4 }, (_, i) => ({ seq: 4 - i, recordedAt: inRange(i) }));
    const store = fakeStore(rows, { complete: true, scannedThrough: end, nextExpiryAt: expiry, clockGuard: 'guarded' as const }, () => clock);
    const first: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, list: store.list,
      now: () => clock, limits: limits({ rows: 2, listPage: 2 }) });
    expect(first.hits).toHaveLength(2); expect(first.nextCursor).toBeString();
    const calls = store.calls.length; clock += 5_000;
    const next: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, cursor: first.nextCursor,
      list: store.list, now: () => clock });
    expect(store.calls).toHaveLength(calls);
    expect(next).toMatchObject({ complete: false, nextCursor: null, hits: [], coverage: { retentionGuard: 'expired' } });
    expect(next.incomplete).toContain('changed-or-out-of-order');
    expect(next.incomplete).toContain('retention-expired');
  });

  test('discards a page if an observed expiry passes while its storage read is in flight', async () => {
    let clock = Date.parse('2026-10-27T12:00:00Z');
    const expiry = new Date(clock + 1_000).toISOString();
    const store = fakeStore([{ seq: 1, recordedAt: inRange(1) }], { complete: true, scannedThrough: end, nextExpiryAt: expiry, clockGuard: 'guarded' as const }, () => clock);
    const list: typeof store.list = async request => { const page = await store.list(request); clock += 1_000; return page; };
    const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, list, now: () => clock });
    expect(page).toMatchObject({ complete: false, nextCursor: null, hits: [],
      incomplete: ['changed-or-out-of-order', 'retention-expired'], coverage: { retentionGuard: 'expired' } });
  });

  test('does not infer retention consistency from a legacy host missing the expiry bound', async () => {
    const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end,
      list: fakeStore([{ seq: 1, recordedAt: inRange(1) }], { complete: true, scannedThrough: end, clockGuard: 'guarded' as const }).list });
    expect(page).toMatchObject({ complete: false, incomplete: ['retention-unknown'], coverage: { retentionGuard: 'unknown' } });
  });

  test('stops before rereading if the clock moves backwards across signed history pages', async () => {
    const expiry = Date.parse('2026-10-27T12:00:00Z'); let clock = expiry + 1_000, calls = 0;
    const list = async (request: { beforeSeq?: string }) => {
      calls += 1;
      const ids = [2, ...(clock < expiry ? [1] : [])].filter(seq => !request.beforeSeq || seq < Number(request.beforeSeq));
      return { items: ids.slice(0, 1).map(seq => ({ id: `row-${seq}`, seq: String(seq), memoryId: 'memory-one',
        recordedAt: inRange(seq), text: 'fixture', promptOrigin: 'human' })), hasMore: false,
        scan: { complete: true, scannedThrough: end, nextExpiryAt: null, clockGuard: 'guarded' as const, observedAt: clock } };
    };
    const first: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, list,
      now: () => clock, limits: limits({ rows: 1, listPage: 1, calls: 1 }) });
    expect(first.hits.map((hit: any) => hit.id)).toEqual(['row-2']); expect(first.nextCursor).toBeString();
    const callsBefore = calls; clock = expiry - 1_000;
    const second: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, cursor: first.nextCursor,
      list, now: () => clock });
    expect(calls).toBe(callsBefore);
    expect(second).toMatchObject({ complete: false, nextCursor: null, hits: [], coverage: { clockGuard: 'reversed' } });
    expect(second.incomplete).toContain('changed-or-out-of-order'); expect(second.incomplete).toContain('clock-reversed');
  });

  test('does not infer clock consistency from a legacy host missing clock observations', async () => {
    const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end,
      list: fakeStore([{ seq: 1, recordedAt: inRange(1) }], { complete: true, scannedThrough: end, nextExpiryAt: null }).list });
    expect(page).toMatchObject({ complete: false, incomplete: ['clock-unknown'], coverage: { clockGuard: 'unknown' } });
  });

  test('rejects a clock rollback between the API last observation and the history caller', async () => {
    const base = Date.parse('2026-10-27T12:00:00Z'); let clock = base + 1_000;
    const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, now: () => clock,
      list: async () => {
        const observedAt = base + 13_000;
        clock = base + 11_000; // A prior expired row could now appear below the same newest seq.
        return { items: [{ id: 'newest', seq: '2', memoryId: 'memory-one', recordedAt: inRange(2), text: 'fixture' }],
          hasMore: false, scan: { complete: true, scannedThrough: end, nextExpiryAt: null, clockGuard: 'guarded', observedAt } };
      } });
    expect(page).toMatchObject({ complete: false, nextCursor: null, hits: [], coverage: { clockGuard: 'reversed' } });
    expect(page.incomplete).toContain('clock-reversed');
  });

  test('discards unreturned hits when the row mutation revision changes within one response', async () => {
    const rows = [{ seq: 3, recordedAt: inRange(3) }, { seq: 2, recordedAt: inRange(2) }, { seq: 1, recordedAt: inRange(1) }];
    const store = fakeStore(rows);
    let calls = 0;
    const list: typeof store.list = async request => ({ ...await store.list(request),
      scan: { complete: true, scannedThrough: end, nextExpiryAt: null, clockGuard: 'guarded' as const, observedAt: Date.now(), revision: ++calls === 1 ? 'before' : 'after' } });
    const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, list, limits: limits({ listPage: 1 }) });
    expect(page).toMatchObject({ complete: false, nextCursor: null, hits: [],
      incomplete: ['changed-or-out-of-order'], traversal: { returned: 0, inconsistent: true } });
  });

  test('reads several stored pages in one call so a sparse range needs no empty round trips', async () => {
    // 300 newer out-of-range rows hide two in-range rows; the 1.63 pager needed 61 calls to reach them.
    const rows: FakeRow[] = [{ seq: 1, recordedAt: inRange(1) }, { seq: 2, recordedAt: inRange(2) }];
    for (let seq = 3; seq <= 302; seq += 1) rows.push({ seq, recordedAt: outside(seq) });
    const store = fakeStore(rows);
    const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, list: store.list });
    expect(page.hits.map((hit: any) => hit.id)).toEqual(['row-2', 'row-1']);
    expect(page.nextCursor).toBeNull(); expect(page.complete).toBe(true); expect(page.incomplete).toEqual([]);
    expect(page.traversal).toEqual({ rows: 302, inRange: 2, returned: 2, filtered: 0, truncated: 0, skipped: 0, inconsistent: false, stoppedBy: 'end' });
    // Four list pages, then one look from the top for rows captured meanwhile.
    expect(store.calls).toEqual(['top:100', '203:100', '103:100', '3:100', 'top:1']);
    expect(page.coverage).toMatchObject({ collection: 'reported-complete', historical: 'unknown', deviceScope: 'local-device', order: 'storage' });
  });

  test('returns every in-range row exactly once across hit, byte and scan budgets', async () => {
    for (const [count, size] of [[57, 10], [130, 900], [45, 2600], [401, 40]] as const) {
      const rows: FakeRow[] = [];
      for (let seq = 1; seq <= count; seq += 1) rows.push({ seq, recordedAt: seq % 3 ? inRange(seq) : outside(seq), text: '가'.repeat(size) });
      const pages = await traverse(fakeStore(rows).list);
      const expected = expectedIds(rows, row => row.seq % 3 !== 0);
      expect(ids(pages)).toEqual(expected);
      for (const page of pages) {
        expect(page.hits.length).toBeLessThanOrEqual(20);
        expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThan(16_384);
      }
      const last = pages.at(-1);
      expect(last.traversal).toMatchObject({ rows: count, inRange: expected.length, returned: expected.length, stoppedBy: 'end' });
      expect(last.complete).toBe(true);
      expect(last.incomplete).toEqual([]);
    }
  });

  test('reads rows captured while the traversal is in progress before claiming completeness', async () => {
    // Capture assigns a higher seq to every new row, even to an old prompt found by backfill.
    const rows: FakeRow[] = [];
    for (let seq = 1; seq <= 900; seq += 1) rows.push({ seq, recordedAt: inRange(seq) });
    const store = fakeStore(rows);
    let next = 901;
    const pages = await traverse(store.list, {}, index => {
      if (index % 7 === 0) rows.push({ seq: next++, recordedAt: '2026-10-22T00:00:00Z' });
      if (index % 5 === 0) rows.push({ seq: next++, recordedAt: inRange(next) });
    });
    const last = pages.at(-1);
    expect(ids(pages).sort()).toEqual(expectedIds(rows, row => Date.parse(row.recordedAt) >= Date.parse(start)).sort());
    expect(new Set(ids(pages)).size).toBe(ids(pages).length);
    expect(last).toMatchObject({ complete: true, incomplete: [], traversal: { rows: rows.length, stoppedBy: 'end' } });
    expect(next).toBeGreaterThan(901);
  });

  test('a row the look from the top keeps listing but the read never returns stops instead of claiming completeness', async () => {
    const rows: FakeRow[] = [];
    for (let seq = 1; seq <= 30; seq += 1) rows.push({ seq, recordedAt: inRange(seq) });
    const store = fakeStore(rows);
    let probes = 0;
    const list = async (request: any) => {
      const page = await store.list(request);
      // Only the look from the top lists row 31; the segment read skips it.
      if (request.limit !== 1 || request.beforeSeq) return page;
      probes += 1;
      return { ...page, items: [{ ...page.items[0], id: 'row-31', seq: '31' }] };
    };
    const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, list, limits: limits({ hits: 50 }) });
    expect(page).toMatchObject({ nextCursor: null, complete: false, incomplete: ['changed-or-out-of-order'], traversal: { inconsistent: true } });
    expect(probes).toBe(2);
  });

  test('a newest row deleted between the look from the top and the read neither stops nor repeats the traversal', async () => {
    const rows: FakeRow[] = [];
    for (let seq = 1; seq <= 30; seq += 1) rows.push({ seq, recordedAt: inRange(seq) });
    const store = fakeStore(rows);
    let probes = 0;
    const list = async (request: any) => {
      const page = await store.list(request);
      // Row 31 is captured, seen by the first look from the top, then deleted before the segment reads it.
      if (request.limit === 1 && !request.beforeSeq && probes++ === 0) return { ...page, items: [{ ...page.items[0], id: 'row-31', seq: '31' }] };
      return page;
    };
    const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, list, limits: limits({ hits: 50 }) });
    expect(ids([page])).toEqual(expectedIds(rows, () => true));
    expect(page).toMatchObject({ nextCursor: null, complete: true, incomplete: [], traversal: { inconsistent: false, stoppedBy: 'end' } });

    let state = 4242;
    const random = (limit: number) => { state = (state * 1103515245 + 12345) % 2147483648; return state % limit; };
    for (let round = 0; round < 200; round += 1) {
      const rows: FakeRow[] = [];
      let seq = 0;
      for (let count = random(80); count > 0; count -= 1) { seq += 1 + random(3); rows.push({ seq, recordedAt: random(3) ? inRange(seq) : outside(seq), hidden: random(9) === 0 }); }
      const store = fakeStore(rows);
      const deleted = new Set<string>();
      const list = async (request: any) => {
        const page = await store.list(request);
        // Half the time, the row a look from the top just found is deleted before anything else reads it.
        if (request.limit === 1 && !request.beforeSeq && page.items.length && random(2) === 0) {
          const target = Number(page.items[0].seq);
          rows.splice(rows.findIndex(row => row.seq === target), 1);
          deleted.add(`row-${target}`);
        }
        return page;
      };
      const pages = await traverse(list, { limits: limits({ rows: 1 + random(30), listPage: 1 + random(10), calls: 1 + random(6), hits: 1 + random(8) }) }, index => {
        if (index < 30 && random(3) === 0) { seq += 1; rows.push({ seq, recordedAt: inRange(seq) }); }
      });
      const returned = ids(pages), kept = expectedIds(rows, row => !row.hidden && Date.parse(row.recordedAt) >= Date.parse(start));
      expect(new Set(returned).size).toBe(returned.length);
      expect(kept.filter(id => !returned.includes(id))).toEqual([]);
      expect(returned.filter(id => !kept.includes(id) && !deleted.has(id))).toEqual([]);
      const last = pages.at(-1);
      expect(last).toMatchObject({ nextCursor: null, traversal: { inconsistent: false, stoppedBy: 'end' } });
      expect(last.complete).toBe(last.incomplete.length === 0);
    }
  });

  test('random stores, budgets and concurrent captures still return each in-range row once', async () => {
    let state = 20261027;
    const random = (limit: number) => { state = (state * 1103515245 + 12345) % 2147483648; return state % limit; };
    for (let round = 0; round < 250; round += 1) {
      const rows: FakeRow[] = [];
      let seq = 0;
      for (let count = random(140); count > 0; count -= 1) {
        seq += 1 + random(3);
        rows.push({ seq, recordedAt: random(3) ? inRange(seq) : outside(seq), origin: ['human', 'unknown', 'agentstoz'][random(3)], hidden: random(9) === 0, text: '나'.repeat(1 + random(700)) });
      }
      const store = fakeStore(rows);
      const origin = random(2) ? 'human' : 'all';
      const pages = await traverse(store.list, { origin, limits: limits({ rows: 1 + random(60), listPage: 1 + random(20), calls: 2 + random(6), hits: 1 + random(8), hitBytes: 2_900 + random(9_000) }) }, index => {
        if (index < 30 && random(4) === 0) { seq += 1; rows.push({ seq, recordedAt: inRange(seq), origin: 'human' }); }
      });
      expect(pages.at(-1).nextCursor).toBeNull();
      const keep = (row: FakeRow) => !row.hidden && Date.parse(row.recordedAt) >= Date.parse(start) && (origin === 'all' || row.origin === 'human');
      expect(ids(pages)).toEqual(ids(pages).filter((id, index, all) => all.indexOf(id) === index));
      expect([...ids(pages)].sort()).toEqual(expectedIds(rows, keep).sort());
      const last = pages.at(-1);
      expect(last.traversal.rows).toBe(rows.filter(row => !row.hidden).length);
      expect(last.complete).toBe(last.incomplete.length === 0);
      expect(last.incomplete).toEqual([]);
    }
  });

  test('filters by prompt origin, counts the excluded prompts and keeps the cursor on that origin', async () => {
    const rows: FakeRow[] = [];
    for (let seq = 1; seq <= 60; seq += 1) rows.push({ seq, recordedAt: inRange(seq), origin: seq % 4 === 0 ? 'human' : seq % 4 === 1 ? 'agentstoz' : seq % 4 === 2 ? 'unknown' : 'odd' });
    const store = fakeStore(rows);
    const first: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, origin: 'human', limits: limits({ rows: 20, listPage: 7 }), list: store.list });
    expect(first).toMatchObject({ origin: 'human', traversal: { stoppedBy: 'scan-budget' } });
    // A continuation without origin keeps the cursor's origin; a different origin is refused.
    const pages = [first, ...await traverse(store.list, { cursor: undefined })].slice(0, 1);
    let cursor = first.nextCursor;
    while (cursor) {
      const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, cursor, limits: limits({ rows: 20, listPage: 7 }), list: store.list });
      expect(page.origin).toBe('human');
      pages.push(page); cursor = page.nextCursor;
    }
    expect(ids(pages)).toEqual(expectedIds(rows, row => row.origin === 'human'));
    expect(pages.at(-1).traversal).toMatchObject({ rows: 60, inRange: 60, returned: 15, filtered: 45 });
    await expect(listUserInstructionHistory({ memoryId: 'memory-one', start, end, cursor: first.nextCursor, origin: 'all', list: async () => { throw Error('must not read'); } }))
      .rejects.toBeInstanceOf(UserMemoryHistoryCursorError);
    expect(() => userMemoryRange(start, end, undefined, 'unknown')).toThrow();
  });

  test('stops at the deadline after a read and resumes from the last consumed row', async () => {
    const rows: FakeRow[] = [];
    for (let seq = 1; seq <= 250; seq += 1) rows.push({ seq, recordedAt: seq % 10 ? outside(seq) : inRange(seq) });
    let clock = 0;
    const store = fakeStore(rows, undefined, () => clock);
    const list = async (request: any) => { clock += 3_000; return store.list(request); };
    const pages = await traverse(list, { now: () => clock });
    expect(store.calls).toEqual(['top:100', '151:100', '51:100', 'top:1']);
    expect(pages.map(page => page.traversal.stoppedBy)).toEqual(['deadline', 'deadline', 'deadline', 'end']);
    expect(ids(pages)).toEqual(expectedIds(rows, row => row.seq % 10 === 0));
  });

  test('refuses to continue past rows that are out of order or a cursor that does not advance', async () => {
    const backwards = async (request: any) => ({ items: request.beforeSeq ? [{ id: 'again', seq: '9', memoryId: 'memory-one', recordedAt: inRange(1), text: '다시', promptOrigin: 'human' }]
      : [{ id: 'first', seq: '9', memoryId: 'memory-one', recordedAt: inRange(1), text: '처음', promptOrigin: 'human' }], hasMore: true, nextBeforeSeq: '9', scan: { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, scannedThrough: end, observedAt: Date.now() } });
    const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, list: backwards });
    expect(page.hits.map((hit: any) => hit.id)).toEqual(['first']);
    expect(page).toMatchObject({ nextCursor: null, complete: false, incomplete: ['changed-or-out-of-order'], traversal: { inconsistent: true, stoppedBy: 'inconsistent' } });
    let calls = 0;
    const stalled: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, list: async () => { calls += 1; return { items: [], hasMore: true, nextBeforeSeq: '50', scan: { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, scannedThrough: end, observedAt: Date.now() } }; } });
    expect(calls).toBe(2);
    expect(stalled).toMatchObject({ nextCursor: null, complete: false, traversal: { inconsistent: true } });
    const unnumbered: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, list: async () => ({ items: [{ id: 'x', memoryId: 'memory-one', recordedAt: inRange(1), text: '번호 없음' }], hasMore: false, scan: { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, scannedThrough: end, observedAt: Date.now() } }) });
    expect(unnumbered).toMatchObject({ hits: [], nextCursor: null, complete: false });
  });

  test('names every reason a fully read range is still not complete', async () => {
    const rows: FakeRow[] = [{ seq: 1, recordedAt: inRange(1) }, { seq: 2, recordedAt: inRange(2), memoryId: 'other-memory' }];
    for (let seq = 3; seq <= 30; seq += 1) rows.push({ seq, recordedAt: inRange(seq), text: seq === 30 ? '한'.repeat(3000) : undefined });
    const pages = await traverse(fakeStore(rows).list, { limits: limits({ rows: 10, listPage: 10 }) });
    expect(pages.length).toBe(4); // Lossless body parts can use the hit budget before the row budget.
    expect(pages[0].hits[0]).toMatchObject({ id: 'row-30', excerptTruncated: false, textPart: { offset: 0, totalChars: 3000 } });
    expect(pages.flatMap(page => page.hits).filter(hit => hit.id === 'row-30').map(hit => hit.excerpt).join('')).toBe('한'.repeat(3000));
    expect(pages.at(-1)).toMatchObject({ nextCursor: null, complete: false, incomplete: ['skipped-rows'], traversal: { truncated: 0, skipped: 1, rows: 30, stoppedBy: 'end' } });
    // Without a durable capture receipt the summary remains unknown: the read is whole, the collection is not proven.
    for (const [scan, reason] of [[null, 'collection-unknown'], [{ complete: false, nextExpiryAt: null, clockGuard: 'guarded' as const }, 'collection-partial'], [{ complete: true, unreadable: 1, nextExpiryAt: null, clockGuard: 'guarded' as const }, 'collection-partial']] as const) {
      const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, list: fakeStore([{ seq: 1, recordedAt: inRange(1) }], scan).list });
      expect(page).toMatchObject({ complete: false, incomplete: scan === null ? [reason, 'retention-unknown', 'clock-unknown'] : [reason], traversal: { stoppedBy: 'end' } });
    }
    const hiddenTop: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, list: async (request: any) =>
      request.limit === 1 ? { items: [], hasMore: true, nextBeforeSeq: '5', scan: { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, scannedThrough: end, observedAt: Date.now() } } : { items: [], hasMore: false, scan: { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, scannedThrough: end, observedAt: Date.now() } } });
    expect(hiddenTop).toMatchObject({ complete: false, incomplete: ['newest-row-unverified'] });
  });

  test('separates an expired, foreign or malformed cursor from an invalid range and treats an empty cursor as the start', async () => {
    const rows: FakeRow[] = [];
    for (let seq = 1; seq <= 30; seq += 1) rows.push({ seq, recordedAt: inRange(seq) });
    const store = fakeStore(rows);
    const first: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, cursor: '', limits: limits({ rows: 10, listPage: 10 }), list: store.list });
    expect(store.calls[0]).toBe('top:10');
    const tampered = first.nextCursor.replace(/\.[A-Za-z0-9_-]+$/, '.' + 'A'.repeat(43));
    for (const [memoryId, rangeEnd, cursor] of [['other', end, first.nextCursor], ['memory-one', '2026-10-29T00:00:00Z', first.nextCursor], ['memory-one', end, tampered], ['memory-one', end, 'umh1_bad'], ['memory-one', end, 'umh1_' + 'a'.repeat(2050) + '.b']]) {
      await expect(listUserInstructionHistory({ memoryId, start, end: rangeEnd, cursor, list: async () => { throw Error('must not read'); } }))
        .rejects.toBeInstanceOf(UserMemoryHistoryCursorError);
    }
    expect(new UserMemoryHistoryCursorError().message).toStartWith('USER_MEMORY_CURSOR_EXPIRED');
    const invalid = await listUserInstructionHistory({ memoryId: 'memory-one', start: end, end: start, list: store.list }).catch(error => error);
    expect(invalid).toBeInstanceOf(Error); expect(invalid).not.toBeInstanceOf(UserMemoryHistoryCursorError);
    for (const args of [[end, start], [start, '2026-10-28']]) expect(() => userMemoryRange(...args as [string, string])).toThrow();
    expect(userMemoryRange(start, end, null)).toEqual({ start: '2026-10-24T00:00:00.000Z', end: '2026-10-28T00:00:00.000Z' });
  });

  test('retains earlier incomplete collection evidence through subsequent healthy pages and cursor resume', async () => {
    for (const firstScan of [{ complete: true, unreadable: 1, nextExpiryAt: null, clockGuard: 'guarded' as const }, undefined]) {
      const rows = Array.from({ length: 4 }, (_, i) => ({ seq: 4 - i, recordedAt: '2026-10-25T00:00:00Z' }));
      const { list } = fakeStore(rows);
      let calls = 0;
      const varyingList: typeof list = async request => {
        const page = await list(request);
        calls += 1;
        return { ...page, scan: calls === 1 ? firstScan : { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, scannedThrough: end, observedAt: Date.now() } };
      };
      const pages = await traverse(varyingList, { limits: { rows: 2, listPage: 2, calls: 4, hits: 20, hitBytes: 12288, deadlineMs: 2500 } });
      expect(pages.length).toBeGreaterThan(1);
      const last = pages.at(-1)!;
      expect(last.nextCursor).toBeNull();
      expect(last.complete).toBe(false);
      expect(last.incomplete).toContain(firstScan ? 'collection-partial' : 'collection-unknown');
    }
  });

  test('returns an unavailable page without leaking a store error', async () => {
    const page: any = await listUserInstructionHistory({ memoryId: 'memory-one', start, end, list: async () => { throw Error('/private/secret/path locked'); } });
    expect(page).toMatchObject({ state: 'unavailable', hits: [], nextCursor: null, complete: false, incomplete: ['unavailable'] });
    expect(JSON.stringify(page)).not.toContain('secret');
  });
});

test('shared control contract remains browser-bundle safe', async () => {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, '../src/agentstozUseControl.ts')], target: 'browser' });
  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
});
