import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { listUserInstructionHistory } from '../src/userMemoryHistoryServer';

const start = '2026-10-22T00:00:00Z', end = '2026-10-29T00:00:00Z';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

test('dated history delivers maximum supported escaped and multibyte requests without loss within the existing page budget', async () => {
  for (const text of ['\u0000'.repeat(65_536), '가😀\\"\n'.repeat(4_096), 'x'.repeat(65_536)]) {
    let cursor: string | undefined, assembled = '', last: any;
    const positions = new Set<string>();
    for (let page = 0; page < 250; page++) {
      last = await listUserInstructionHistory({ memoryId: 'm', start, end, cursor, origin: 'human', list: async request => ({
        items: request.beforeSeq && BigInt(request.beforeSeq) <= 10n ? [] : [{ id: 'long', seq: '10', memoryId: 'm', recordedAt: start, text, promptOrigin: 'human' }],
        hasMore: false, scan: { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, observedAt: Date.now(), scannedThrough: end },
      }) });
      expect(Buffer.byteLength(JSON.stringify(last))).toBeLessThan(16_384);
      for (const hit of last.hits) {
        expect(hit.excerptTruncated).toBe(false);
        expect(hit.textPart).toMatchObject({ offset: assembled.length, totalChars: text.length, sha256: digest(text) });
        assembled += hit.excerpt;
        expect(hit.textPart.nextOffset).toBe(assembled.length);
      }
      if (!last.nextCursor) break;
      expect(positions.has(last.nextCursor)).toBe(false); positions.add(last.nextCursor); cursor = last.nextCursor;
    }
    expect(assembled).toBe(text);
    expect(last).toMatchObject({ complete: true, nextCursor: null, incomplete: [], traversal: { rows: 1, returned: 1, truncated: 0, skipped: 0 } });
  }
});

test('a changed or deleted request between body parts cannot yield a complete result', async () => {
  for (const changed of [true, false]) {
    let reads = 0;
    const list = async () => ({ items: ++reads === 1 || changed
      ? [{ id: 'long', seq: '10', memoryId: 'm', recordedAt: start, text: (reads === 1 ? 'a' : 'b').repeat(65_536), promptOrigin: 'human' }] : [], hasMore: false, scan: { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, observedAt: Date.now(), scannedThrough: end } });
    const first = await listUserInstructionHistory({ memoryId: 'm', start, end, list });
    expect(first.nextCursor).toBeString();
    const next = await listUserInstructionHistory({ memoryId: 'm', start, end, list, cursor: first.nextCursor! });
    expect(next).toMatchObject({ complete: false, nextCursor: null, incomplete: ['changed-or-out-of-order'] });
  }
});

test('a changed collection policy or source revision during cursor traversal requires a new traversal', async () => {
  let revision = 'first';
  const list = async (request: { beforeSeq?: string }) => ({
    items: request.beforeSeq && BigInt(request.beforeSeq) <= 10n ? [] : [{ id: 'long', seq: '10', memoryId: 'm', recordedAt: start, text: 'a'.repeat(65_536), promptOrigin: 'human' }],
    hasMore: false, scan: { complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, observedAt: Date.now(), revision, scannedThrough: end },
  });
  const first = await listUserInstructionHistory({ memoryId: 'm', start, end, list });
  expect(first.nextCursor).toBeString(); revision = 'second';
  const next = await listUserInstructionHistory({ memoryId: 'm', start, end, list, cursor: first.nextCursor! });
  expect(next).toMatchObject({ complete: false, nextCursor: null, incomplete: ['changed-or-out-of-order'] });
});

test('multipart continuation reads only its retained row and then resumes the remaining sequence without loss', async () => {
  const long = '가😀\\"\n'.repeat(7_000);
  const rows = Array.from({length: 201}, (_, index) => ({
    id: `event-${201 - index}`, seq: String(201 - index), memoryId: 'm', recordedAt: start,
    text: index === 0 ? long : `short-${index}`, promptOrigin: index % 3 === 0 ? 'human' : 'unknown',
  }));
  const requests: Array<{limit: number; beforeSeq?: string}> = [];
  const list = async (request: {limit: number; beforeSeq?: string}) => {
    requests.push({limit: request.limit, beforeSeq: request.beforeSeq});
    const candidates = rows.filter(row => !request.beforeSeq || BigInt(row.seq) < BigInt(request.beforeSeq));
    const items = candidates.slice(0, request.limit);
    const hasMore = candidates.length > items.length;
    return {items, hasMore, nextBeforeSeq: hasMore ? items.at(-1)?.seq : null,
      scan: {complete: true, nextExpiryAt: null, clockGuard: 'guarded' as const, observedAt: Date.now(), scannedThrough: end}};
  };
  let cursor: string | undefined, partial = false, assembled = '', last: any;
  const seen = new Set<string>();
  for (let n = 0; n < 300; n++) {
    const before = requests.length;
    last = await listUserInstructionHistory({memoryId:'m',start,end,cursor,origin:'all',list});
    if (partial) expect(requests[before]).toMatchObject({limit:1,beforeSeq:'202'});
    partial = false;
    for (const hit of last.hits) {
      if (hit.textPart) {
        expect(hit.id).toBe('event-201');
        expect(hit.textPart).toMatchObject({offset:assembled.length,totalChars:long.length,sha256:digest(long)});
        assembled += hit.excerpt;
        if (hit.textPart.nextOffset < hit.textPart.totalChars) partial = true;
        else {expect(assembled).toBe(long); expect(seen.has(hit.id)).toBe(false); seen.add(hit.id); partial = false;}
      } else { expect(seen.has(hit.id)).toBe(false); seen.add(hit.id); }
    }
    if (!last.nextCursor) break;
    cursor = last.nextCursor;
  }
  expect(seen.size).toBe(rows.length);
  expect(last).toMatchObject({complete:true,incomplete:[],traversal:{rows:201,returned:201,inconsistent:false}});
  expect(requests.filter(request => request.beforeSeq === '202').length).toBeGreaterThan(1);
});
