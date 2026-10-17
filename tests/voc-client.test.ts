import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createVocClient, vocDeliveryMessage, type VocFetch, type VocNotifyKind } from '../src/voc/vocClient';

type Call = { url: string; init?: RequestInit };
function harness(respond: (call: Call) => { status?: number; body?: unknown } | Error) {
  const calls: Call[] = [];
  const notes: Array<{ message: string; kind: VocNotifyKind }> = [];
  const fetchImpl: VocFetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const r = respond(call);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? 'not json' : JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  const client = createVocClient({ notify: (message, kind) => notes.push({ message, kind }), fetchImpl, apiOrigin: 'http://sidecar' });
  return { client, calls, notes };
}

describe('vocDeliveryMessage — 전송 결과 문구', () => {
  test('상태별 문구와 종류', () => {
    expect(vocDeliveryMessage({ status: 'sent', remaining: 7 })).toEqual({ message: '개선 요청을 전송했습니다 · 오늘 7회 남음', kind: 'success' });
    expect(vocDeliveryMessage({ status: 'sent', unlimited: true }).message).toBe('관리자 VOC로 전송했습니다 · 한도 없음');
    expect(vocDeliveryMessage({ status: 'rate_limited', dailyLimit: 10 }).message).toContain('오늘 전송 한도 10회');
    expect(vocDeliveryMessage({ status: 'disabled' }).kind).toBe('success');
    expect(vocDeliveryMessage({ status: 'blocked' }).kind).toBe('error');
    expect(vocDeliveryMessage({ status: 'failed' }).kind).toBe('error');
    expect(vocDeliveryMessage(undefined)).toEqual({ message: '개선 요청을 로컬에 저장했습니다', kind: 'success' });
  });
});

describe('createVocClient', () => {
  test('submit은 첨부·탭·버전을 담아 POST하고 결과를 정리해 돌려준다', async () => {
    const { client, calls, notes } = harness(() => ({ body: { success: true, file: 'a.json', id: 'x', attachments: ['/p/1.jpg', 3], delivery: { status: 'failed' } } }));
    const result = await client.submit({ anchor: { testId: 't' }, comment: '고쳐 주세요', sendRemote: true, attachments: [] }, { tab: 'workroom-popout', appVersion: 'v1 2026.9.27' });
    expect(result).toEqual({ file: 'a.json', id: 'x', attachments: ['/p/1.jpg'] });
    expect(calls[0]!.url).toBe('http://sidecar/api/voc');
    expect(calls[0]!.init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toMatchObject({ comment: '고쳐 주세요', sendRemote: true, tab: 'workroom-popout', appVersion: 'v1 2026.9.27' });
    expect(notes).toEqual([{ message: '로컬에 저장했습니다 · 개발자 전송은 네트워크 문제로 실패했습니다', kind: 'error' }]);
  });

  test('submit 실패는 false와 오류 알림', async () => {
    const { client, notes } = harness(() => ({ status: 500, body: { success: false, error: '디스크 가득' } }));
    expect(await client.submit({ anchor: {}, comment: 'x', sendRemote: false, attachments: [] }, { tab: 't', appVersion: 'v' })).toBe(false);
    expect(notes).toEqual([{ message: '개선 요청 저장 실패: 디스크 가득', kind: 'error' }]);
    const offline = harness(() => new Error('offline'));
    expect(await offline.client.submit({ anchor: {}, comment: 'x', sendRemote: false, attachments: [] }, { tab: 't', appVersion: 'v' })).toBe(false);
    expect(offline.notes[0]!.message).toBe('개선 요청 저장 실패: offline');
  });

  test('수정·삭제는 PATCH/DELETE와 결과 알림', async () => {
    const { client, calls, notes } = harness(call => call.init?.method === 'DELETE' ? { status: 404, body: { error: '없음' } } : { body: { success: true } });
    expect(await client.updateInboxItem('a.json', '새 글')).toBe(true);
    expect(calls[0]!.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ file: 'a.json', comment: '새 글' });
    expect(await client.deleteInboxItem('a.json')).toBe(false);
    expect(calls[1]!.init?.method).toBe('DELETE');
    expect(notes).toEqual([
      { message: '개선 요청을 수정했습니다', kind: 'success' },
      { message: '개선 요청 삭제 실패: 없음', kind: 'error' },
    ]);
  });

  test('목록 읽기 실패는 던진다(오버레이가 표시한다)', async () => {
    const { client } = harness(() => ({ status: 500, body: { error: '읽기 실패' } }));
    await expect(client.loadInbox()).rejects.toThrow('읽기 실패');
    const ok = harness(() => ({ body: { items: [] } }));
    expect(await ok.client.loadInbox()).toEqual([]);
    expect(ok.calls[0]!.init?.cache).toBe('no-store');
  });

  test('포털 오류는 처리되지 않은 것만, 실패는 던진다', async () => {
    const { client, calls } = harness(() => ({ body: { items: [{ id: '1', resolved: true }, { id: '2' }] } }));
    expect((await client.loadPortalErrors()).map(item => (item as { id: string }).id)).toEqual(['2']);
    expect(calls[0]!.url).toBe('http://sidecar/api/client-errors');
    await expect(harness(() => ({ status: 503, body: {} })).client.loadPortalErrors()).rejects.toThrow('(503)');
  });

  test('접근 확인은 fail-open', async () => {
    expect(await harness(() => new Error('down')).client.loadAccess()).toEqual({ appBlock: null, remoteUnlimited: false });
    expect(await harness(() => ({ body: { blocked: true, scope: 'voc' } })).client.loadAccess()).toEqual({ appBlock: null, remoteUnlimited: false });
    expect(await harness(() => ({ body: { blocked: true, scope: 'app', expiresAt: 'soon', unlimited: true, identity: 'receiver_admin' } })).client.loadAccess())
      .toEqual({ appBlock: { expiresAt: 'soon' }, remoteUnlimited: true });
    expect((await harness(() => ({ body: { unlimited: true, identity: 'someone' } })).client.loadAccess()).remoteUnlimited).toBe(false);
  });
});

describe('워크룸 팝아웃의 VOC 연결', () => {
  const popout = readFileSync(new URL('../src/WorkroomPopoutApp.tsx', import.meta.url), 'utf8');
  test('단축키는 window capture로, 오버레이는 최상위 모달에 붙인다', () => {
    expect(popout).toContain('if (!isVocShortcut(e)) return;');
    expect(popout).toContain("window.addEventListener('keydown', onKey, true)");
    expect(popout).toContain('useOverlayHost(vocMode)');
    expect(popout).toContain('overlayHost ?? document.body');
  });
  test('메인 창과 같은 vocClient를 쓰고, 워크룸 처리는 초안만 채운다', () => {
    expect(popout).toContain('createVocClient(');
    expect(popout).toContain('onOpenWorkroom={openVocInWorkroom}');
    // entry에 prompt만 싣는다 — start 요청을 보내지 않는다.
    expect(popout).toMatch(/setEntry\(\{nonce: \+\+entryNonce\.current, targetId: devTargetId, title, prompt\}\)/);
    expect(popout).not.toMatch(/operation:\s*'start'/);
  });
});
