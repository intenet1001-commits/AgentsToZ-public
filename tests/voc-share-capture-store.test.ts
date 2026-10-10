import { describe, expect, test } from 'bun:test';
import { memoryVocShareBackend, vocShareCaptureFromDetail, VocShareCaptureStore } from '../src/vocShareCaptureStore';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const detail = (id: string, extra: Record<string, unknown> = {}) => ({
  id, createdAt: '2026-09-27T01:00:00Z', comment: '버튼이 겹쳐요', images: [{ name: '1.jpg', mime: 'image/jpeg', dataBase64: b64(JPEG) }], ...extra,
});
const ID1 = '11111111-2222-4333-8444-555555555555';
const ID2 = '11111111-2222-4333-8444-666666666666';

describe('보내지 않은 캡처 보관소', () => {
  test('담은 뒤에만 ack할 수 있고, 같은 항목을 다시 받아도 하나만 남는다', async () => {
    const store = new VocShareCaptureStore(memoryVocShareBackend());
    const first = await store.take(detail(ID1));
    expect(first.status).toBe('stored');
    const again = await store.take(detail(ID1, { comment: '다른 내용' }));
    expect(again.status).toBe('duplicate');
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.comment).toBe('버튼이 겹쳐요');
    expect(Array.from(list[0]!.images[0]!.bytes)).toEqual(Array.from(JPEG));
  });

  test('이미지가 아닌 바이트·잘못된 id는 담지 않는다(선언된 mime은 믿지 않는다)', async () => {
    const store = new VocShareCaptureStore(memoryVocShareBackend());
    expect((await store.take(detail(ID1, { images: [{ mime: 'image/jpeg', dataBase64: b64(new Uint8Array([1, 2, 3])) }] }))).status).toBe('invalid');
    expect((await store.take(detail('../x'))).status).toBe('invalid');
    expect(vocShareCaptureFromDetail(null)).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });

  test('가득 차면 담지 않는다 — 호출자는 ack하지 않아 App Group 보관함에 남는다', async () => {
    const store = new VocShareCaptureStore(memoryVocShareBackend(), 1);
    expect((await store.take(detail(ID1))).status).toBe('stored');
    expect((await store.take(detail(ID2))).status).toBe('full');
    expect((await store.list()).map(c => c.id)).toEqual([ID1]);
  });

  test('보내지 않고 닫으면 고친 내용과 남긴 사진을 기억하고, 다 비우면 지운다', async () => {
    const store = new VocShareCaptureStore(memoryVocShareBackend());
    await store.take(detail(ID1));
    const kept = await store.keep(ID1, { comment: '고친 내용', images: [] as never[] });
    expect(kept?.comment).toBe('고친 내용');
    expect(kept?.images).toHaveLength(0);
    expect(await store.keep(ID1, { comment: '  ', images: [] })).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });

  test('삭제는 사진 바이트까지 보관소에서 없앤다', async () => {
    const store = new VocShareCaptureStore(memoryVocShareBackend());
    await store.take(detail(ID1));
    await store.take(detail(ID2, { createdAt: '2026-09-27T02:00:00Z' }));
    expect((await store.list()).map(c => c.id)).toEqual([ID2, ID1]);
    await store.remove(ID1);
    expect(await store.get(ID1)).toBeNull();
    expect((await store.list()).map(c => c.id)).toEqual([ID2]);
  });
});
