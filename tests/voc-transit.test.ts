import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decryptVocImage,
  encryptVocImage,
  normalizeRemoteVocSubmission,
  sha256Hex,
  VOC_MAX_ATTACHMENTS,
  vocTransitObjectPath,
} from '../src/vocAttachments';
import { completeVoc, saveVocRecord, sweepVocAttachments } from '../src/vocStore.server';
import { receiveRemoteVoc, resetRemoteVocReceipts, sweepVocTransit, vocTransitDownloadUrl } from '../src/vocRemoteReceive.server';
import { normalizeMobileWorkspaceRequest, normalizeMobileWorkspaceResult, workspaceScope } from '../src/mobileWorkspaceProtocol';
import { createMobileWorkspaceGateway } from '../src/mobileWorkspaceGateway';
import { sendRemoteVoc, type VocDraftImage } from '../src/remoteVoc';

const HOST = '11111111-2222-4333-8444-555555555555';
const UID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SUPABASE = 'https://example-project.supabase.co';
// Smallest real PNG header + body is enough: the store checks magic bytes, not decodability.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9, 9]);

let appData: string;
beforeEach(() => { appData = mkdtempSync(join(tmpdir(), 'voc-transit-')); resetRemoteVocReceipts(); });
afterEach(() => rmSync(appData, { recursive: true, force: true }));

async function sealed(bytes: Uint8Array, objectId: string) {
  const e = await encryptVocImage(bytes);
  return { e, path: vocTransitObjectPath(HOST, UID, objectId) };
}

function submission(attachments: unknown[], extra: Record<string, unknown> = {}) {
  return normalizeRemoteVocSubmission({
    vocId: crypto.randomUUID(), comment: '저장 버튼이 안 보여요', source: 'phone-share',
    context: { screen: '원격 작업', appVersion: 'web v1' }, attachments, ...extra,
  });
}

describe('VOC 사진 암호화', () => {
  test('사진마다 새 키로 암호화하고 같은 키로만 풀린다', async () => {
    const a = await encryptVocImage(PNG);
    const b = await encryptVocImage(PNG);
    expect(a.key).not.toBe(b.key);
    expect(Buffer.from(a.ciphertext).includes(Buffer.from(PNG))).toBe(false);
    expect(await decryptVocImage(a.ciphertext, a.key)).toEqual(PNG);
    await expect(decryptVocImage(a.ciphertext, b.key)).rejects.toThrow();
    expect(a.sha256).toBe(await sha256Hex(PNG));
  });
});

describe('원격 VOC 요청 검증', () => {
  test('모르는 키·6장 이상·다른 모양의 경로·빈 내용을 거절한다', async () => {
    const { e, path } = await sealed(PNG, crypto.randomUUID());
    const good = { path, token: 'x'.repeat(40), key: e.key, sha256: e.sha256, mime: 'image/png', bytes: e.bytes };
    expect(submission([good]).attachments).toHaveLength(1);
    expect(() => submission([{ ...good, url: 'https://evil.example' }])).toThrow('VOC_FIELD_UNKNOWN');
    expect(() => submission(Array.from({ length: VOC_MAX_ATTACHMENTS + 1 }, (_, i) => ({ ...good, path: vocTransitObjectPath(HOST, UID, crypto.randomUUID()), sha256: String(i).padStart(64, '0') })))).toThrow();
    expect(() => submission([{ ...good, path: `${HOST}/../${UID}/x.bin` }])).toThrow('VOC_ATTACHMENT_PATH_INVALID');
    expect(() => submission([], { comment: '   ' })).toThrow('VOC_COMMENT_REQUIRED');
    expect(() => submission([], { comment: '가'.repeat(1501) })).toThrow('VOC_FIELD_TOO_LONG');
  });

  test('워크스페이스 채널: voc.submit은 기능 권한 없이 프로젝트 범위만 요구한다', async () => {
    expect(workspaceScope('voc.submit')).toBeNull();
    const request = { operation: 'workspace', requestId: crypto.randomUUID(), targetId: 'target-dev-1', workspace: { action: 'voc.submit', voc: submission([]) } };
    expect(normalizeMobileWorkspaceRequest(request).workspace.action).toBe('voc.submit');
    expect(() => normalizeMobileWorkspaceRequest({ ...request, workspace: { action: 'voc.submit', voc: { nope: 1 } } })).toThrow();
    const result = normalizeMobileWorkspaceResult({ kind: 'workspace', action: 'voc.submit', voc: { vocId: crypto.randomUUID(), file: 'a.json', attachmentPaths: ['/x/1.jpg'], transitDeleted: true } });
    expect(result.voc?.file).toBe('a.json');
    expect(() => normalizeMobileWorkspaceResult({ kind: 'workspace', action: 'voc.submit', voc: { file: 'a.json' } })).toThrow();

    const performed: string[] = [];
    const gateway = createMobileWorkspaceGateway({
      terminal: async () => { throw new Error('not used'); },
      active: () => true,
      resolve: async () => [{ controlId: 'target-dev-1', runtimeTargetId: 'runtime-dev' }],
      consent: async () => ({ targetIds: new Set(['runtime-dev']), workspaceScopes: [], isActive: () => true, requestOwner: 'device:h:c' }),
      perform: async request => { performed.push(request.workspace.action); return { kind: 'workspace', action: 'voc.submit', voc: { vocId: crypto.randomUUID(), file: 'a.json', attachmentPaths: [], transitDeleted: true } }; },
    });
    await gateway(request as never, [], 'internet:s1');
    expect(performed).toEqual(['voc.submit']);
    const outside = createMobileWorkspaceGateway({
      terminal: async () => { throw new Error('not used'); }, active: () => true,
      resolve: async () => [{ controlId: 'target-dev-1', runtimeTargetId: 'runtime-dev' }],
      consent: async () => ({ targetIds: new Set(['other']), workspaceScopes: [], isActive: () => true, requestOwner: 'device:h:c' }),
      perform: async () => { throw new Error('must not run'); },
    });
    await expect(outside(request as never, [], 'internet:s2')).rejects.toThrow('프로젝트 범위');
  });
});

describe('Mac 수신: 한 세트로만 저장한다', () => {
  test('전부 받아 검증되면 JSON + 첨부 폴더를 저장하고, 다운로드 주소는 이 Mac의 Supabase로 만든다', async () => {
    const one = await sealed(PNG, crypto.randomUUID());
    const two = await sealed(JPEG, crypto.randomUUID());
    const objects = new Map([[one.path, one.e.ciphertext], [two.path, two.e.ciphertext]]);
    const fetched: string[] = [];
    const removed: string[][] = [];
    const sub = submission([
      { path: one.path, token: 'tok-one-000000000000000', key: one.e.key, sha256: one.e.sha256, mime: 'image/png', bytes: one.e.bytes },
      { path: two.path, token: 'tok-two-000000000000000', key: two.e.key, sha256: two.e.sha256, mime: 'image/jpeg', bytes: two.e.bytes },
    ]);
    const receipt = await receiveRemoteVoc({
      appDataDir: appData, submission: sub, hostId: HOST, supabaseUrl: SUPABASE,
      transit: { remove: async paths => { removed.push(paths); return true; } },
      fetchImpl: (async (url: string) => {
        fetched.push(url);
        const path = decodeURIComponent(new URL(url).pathname.split('/portmgr-voc-transit/')[1]!);
        return new Response(objects.get(path) as BodyInit);
      }) as typeof fetch,
    });
    expect(fetched.every(url => url.startsWith(`${SUPABASE}/storage/v1/object/sign/portmgr-voc-transit/${HOST}/`))).toBe(true);
    expect(receipt.transitDeleted).toBe(true);
    expect(removed).toEqual([[one.path, two.path]]);
    expect(receipt.attachmentPaths).toHaveLength(2);
    expect(readFileSync(receipt.attachmentPaths[0]!)).toEqual(Buffer.from(PNG));
    const record = JSON.parse(readFileSync(join(appData, 'voc', receipt.file), 'utf8'));
    expect(record.comment).toBe('저장 버튼이 안 보여요');
    expect(record.source).toBe('phone-share');
    expect(record.attachments.map((a: { file: string }) => a.file)).toEqual([
      `attachments/${receipt.file.replace(/\.json$/, '')}/1.png`,
      `attachments/${receipt.file.replace(/\.json$/, '')}/2.jpg`,
    ]);
    // 결과가 불확실해 같은 VOC를 다시 보내도 두 번 저장하지 않는다.
    const again = await receiveRemoteVoc({ appDataDir: appData, submission: sub, hostId: HOST, supabaseUrl: SUPABASE, transit: null, fetchImpl: (async () => { throw new Error('no'); }) as never });
    expect(again.file).toBe(receipt.file);
    expect(readdirSync(join(appData, 'voc')).filter(n => n.endsWith('.json'))).toHaveLength(1);
  });

  test('한 장이라도 손상되면 VOC를 저장하지 않고 올린 객체를 지운다', async () => {
    const one = await sealed(PNG, crypto.randomUUID());
    const two = await sealed(JPEG, crypto.randomUUID());
    const removed: string[][] = [];
    const sub = submission([
      { path: one.path, token: 'tok-one-000000000000000', key: one.e.key, sha256: one.e.sha256, mime: 'image/png', bytes: one.e.bytes },
      { path: two.path, token: 'tok-two-000000000000000', key: two.e.key, sha256: '0'.repeat(64), mime: 'image/jpeg', bytes: two.e.bytes },
    ]);
    await expect(receiveRemoteVoc({
      appDataDir: appData, submission: sub, hostId: HOST, supabaseUrl: SUPABASE,
      transit: { remove: async paths => { removed.push(paths); return true; } },
      fetchImpl: (async (url: string) => new Response((url.includes(one.path) ? one.e.ciphertext : two.e.ciphertext) as BodyInit)) as typeof fetch,
    })).rejects.toThrow('VOC_HASH_MISMATCH');
    expect(existsSync(join(appData, 'voc')) ? readdirSync(join(appData, 'voc')).filter(n => n.endsWith('.json')) : []).toHaveLength(0);
    expect(removed).toEqual([[one.path, two.path]]);
  });

  test('다른 Mac의 경로나 설정 없는 Supabase로는 내려받지 않는다', async () => {
    const one = await sealed(PNG, crypto.randomUUID());
    const foreign = vocTransitObjectPath('99999999-2222-4333-8444-555555555555', UID, crypto.randomUUID());
    const sub = submission([{ path: foreign, token: 'tok-one-000000000000000', key: one.e.key, sha256: one.e.sha256, mime: 'image/png', bytes: one.e.bytes }]);
    await expect(receiveRemoteVoc({ appDataDir: appData, submission: sub, hostId: HOST, supabaseUrl: SUPABASE, transit: null, fetchImpl: (async () => { throw new Error('must not fetch'); }) as never }))
      .rejects.toThrow('VOC_ATTACHMENT_PATH_INVALID');
    expect(() => vocTransitDownloadUrl('ftp://x', one.path, 't')).toThrow();
  });
});

describe('로컬 VOC 사진은 처리되면 지워진다', () => {
  test('completeVoc는 JSON을 done/으로 옮기고 첨부 폴더를 지운다', async () => {
    const saved = await saveVocRecord({ appDataDir: appData, comment: 'x', anchor: { tag: 'div', text: '제목', path: [] }, tab: 'projects', appVersion: '1', images: [{ bytes: PNG }] });
    expect(existsSync(saved.attachmentPaths[0]!)).toBe(true);
    const result = completeVoc(appData, saved.file, saved.path);
    expect(existsSync(join(appData, 'voc', 'done', result.doneFile))).toBe(true);
    expect(existsSync(saved.attachmentPaths[0]!)).toBe(false);
  });

  test('AI가 JSON을 직접 옮겨도 다음 정리에서 사진이 지워진다', async () => {
    const saved = await saveVocRecord({ appDataDir: appData, comment: 'x', anchor: { tag: 'div', text: '제목', path: [] }, tab: '', appVersion: '1', images: [{ bytes: JPEG }] });
    mkdirSync(join(appData, 'voc', 'done'), { recursive: true });
    renameSync(saved.path, join(appData, 'voc', 'done', saved.file));
    expect(sweepVocAttachments(appData).removed).toEqual([saved.file.replace(/\.json$/, '')]);
    expect(existsSync(saved.attachmentPaths[0]!)).toBe(false);
  });

  test('이미지가 아닌 바이트와 6장 이상은 저장하지 않는다', async () => {
    await expect(saveVocRecord({ appDataDir: appData, comment: 'x', anchor: { tag: 'div', text: 'a', path: [] }, tab: '', appVersion: '', images: [{ bytes: new TextEncoder().encode('#!/bin/sh') }] })).rejects.toThrow('VOC_IMAGE_MIME_INVALID');
    await expect(saveVocRecord({ appDataDir: appData, comment: 'x', anchor: { tag: 'div', text: 'a', path: [] }, tab: '', appVersion: '', images: Array.from({ length: 6 }, () => ({ bytes: PNG })) })).rejects.toThrow('VOC_TOO_MANY_ATTACHMENTS');
    expect(existsSync(join(appData, 'voc')) ? readdirSync(join(appData, 'voc')).filter(n => n.endsWith('.json')) : []).toHaveLength(0);
  });
});

describe('Storage 경유지 정리', () => {
  test('24시간 넘은 객체만, 이 Mac 경로 안에서만 지운다', async () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    const old = `${crypto.randomUUID()}.bin`, fresh = `${crypto.randomUUID()}.bin`;
    const removed: string[][] = [];
    const storage = {
      list: async (path: string) => path === HOST
        ? { data: [{ name: UID, id: null }], error: null }
        : { data: [{ name: old, id: 'x', created_at: '2026-09-26T10:00:00Z' }, { name: fresh, id: 'y', created_at: '2026-09-27T11:00:00Z' }], error: null },
      remove: async (paths: string[]) => { removed.push(paths); return { error: null }; },
    };
    expect((await sweepVocTransit(storage, HOST, now)).removed).toBe(1);
    expect(removed).toEqual([[`${HOST}/${UID}/${old}`]]);
  });

  test('마이그레이션: 비공개 버킷, 멤버·업로더 uid 폴더로만, 덮어쓰기 없음', () => {
    const sql = readFileSync(new URL('../supabase/migrations/20260927010000_voc_transit_storage.sql', import.meta.url), 'utf8');
    expect(sql).toContain("values ('portmgr-voc-transit', 'portmgr-voc-transit', false, 10485760, array['application/octet-stream'])");
    for (const policy of ['portmgr_voc_transit_insert', 'portmgr_voc_transit_select', 'portmgr_voc_transit_delete']) expect(sql).toContain(`create policy ${policy} on storage.objects`);
    expect(sql.match(/portmgr_is_member\(\)/g)?.length).toBe(3);
    expect(sql.match(/\(storage\.foldername\(name\)\)\[2\] = \(select auth\.uid\(\)\)::text/g)?.length).toBe(3);
    expect(sql).not.toMatch(/for update/);
    expect(sql).not.toMatch(/to anon|to public/);
  });
});

describe('휴대폰 전송: 사진을 먼저 다 올린 뒤에만 VOC 메시지를 보낸다', () => {
  function fakeSupabase(options: { failUpload?: boolean } = {}) {
    const calls: string[] = [];
    const bucket = {
      upload: async (path: string) => { calls.push('upload:' + path); return options.failUpload ? { error: { message: 'Bucket not found' } } : { error: null }; },
      createSignedUrl: async (path: string) => ({ data: { signedUrl: `/object/sign/portmgr-voc-transit/${path}?token=signed-token-0123456789` }, error: null }),
      remove: async (paths: string[]) => { calls.push('remove:' + paths.length); return { error: null }; },
      list: async () => ({ data: [], error: null }),
    };
    return { calls, client: { auth: { getSession: async () => ({ data: { session: { user: { id: UID } } } }) }, storage: { from: () => bucket } } as never };
  }
  const image = (): VocDraftImage => ({ id: 'i', previewUrl: '', bytes: PNG, mime: 'image/png' });

  test('업로드 → 전송 순서, Mac이 못 지웠으면 휴대폰이 지운다', async () => {
    const { calls, client } = fakeSupabase();
    const receipt = await sendRemoteVoc({
      supabase: client, hostId: HOST, targetId: 'dev', comment: '고쳐 주세요', source: 'phone', context: {}, images: [image(), image()],
      send: async request => {
        calls.push('send:' + (request.workspace.voc?.attachments.length ?? 0));
        expect(request.workspace.voc?.attachments[0]?.token).toBe('signed-token-0123456789');
        return { kind: 'workspace', action: 'voc.submit', voc: { vocId: request.workspace.voc!.vocId, file: 'f.json', attachmentPaths: ['/a/1.png', '/a/2.png'], transitDeleted: false } };
      },
    });
    expect(receipt.file).toBe('f.json');
    expect(calls.filter(c => c.startsWith('upload:'))).toHaveLength(2);
    expect(calls.indexOf('send:2')).toBeGreaterThan(calls.findLastIndex(c => c.startsWith('upload:')));
    expect(calls.at(-1)).toBe('remove:2');
  });

  test('업로드가 실패하면 VOC 메시지를 보내지 않고 이유를 알린다', async () => {
    const { calls, client } = fakeSupabase({ failUpload: true });
    let sent = false;
    await expect(sendRemoteVoc({ supabase: client, hostId: HOST, targetId: 'dev', comment: 'x', source: 'phone', context: {}, images: [image()],
      send: async () => { sent = true; throw new Error('no'); } })).rejects.toThrow('마이그레이션');
    expect(sent).toBe(false);
    expect(calls).not.toContain('send:1');
  });

  test('휴대폰에 보관된 전송(REMOTE_CONTROL_REQUEST_UNSENT)은 사진을 지우지 않고 코드를 그대로 알린다', async () => {
    // 다시 연결되면 같은 voc.submit이 한 번 간다 — 사진을 지우면 Mac이 그것을 거절하고, 새로 보내면 VOC가 둘이 된다.
    const { calls, client } = fakeSupabase();
    const failure = await sendRemoteVoc({ supabase: client, hostId: HOST, targetId: 'dev', comment: 'x', source: 'phone', context: {}, images: [image()],
      send: async () => { throw Object.assign(new Error('held'), { code: 'REMOTE_CONTROL_REQUEST_UNSENT' }); } }).catch(error => error);
    expect(failure.code).toBe('REMOTE_CONTROL_REQUEST_UNSENT');
    expect(failure.message).toContain('다시 보내지 마세요');
    expect(calls.some(c => c.startsWith('remove:'))).toBe(false);
  });

  test('Mac이 거절하면 올린 사진을 지운다', async () => {
    const { calls, client } = fakeSupabase();
    await expect(sendRemoteVoc({ supabase: client, hostId: HOST, targetId: 'dev', comment: 'x', source: 'phone', context: {}, images: [image()],
      send: async () => { throw new Error('사진이 전송 중 손상되어 VOC를 저장하지 않았습니다.'); } })).rejects.toThrow('손상');
    expect(calls.at(-1)).toBe('remove:1');
  });
});
