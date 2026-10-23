/**
 * The phone half of Workroom attachments (w13 step B): what the phone does between a pick and a ready `wa_` id.
 * Everything runs against an in-memory storage bucket and a scripted Mac; nothing reaches a network.
 */
import { describe, expect, test } from 'bun:test';
import {
  RemoteWorkroomAttachments, remoteAttachAvailability, remoteAttachSummary, sanitizeRemoteAttachName,
  type RemoteAttachContext,
} from '../src/remoteWorkroomAttachments';
import {
  normalizeWorkroomAttachmentRequest, WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES, WORKROOM_ATTACH_FEATURE,
  type WorkroomAttachmentItemResult, type WorkroomAttachmentReceive,
} from '../src/workroomRemoteAttachmentProtocol';
import { decryptTransitBlob, sha256Hex } from '../src/vocAttachments';
import { workroomAttachmentMessage } from '../src/workroomImageAttachments';
import type { MobileWorkspaceRequest, MobileWorkspaceResult } from '../src/mobileWorkspaceProtocol';

const HOST = '11111111-2222-4333-8444-555555555555';
const UID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TARGET = 'C'.repeat(43);
const OTHER = 'D'.repeat(43);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const id = (n: number) => 'wa_' + String(n).padStart(32, 'A');
const held = (code: string) => Object.assign(new Error(code), { code });

/** An in-memory transit bucket with the storage-js shape the phone uses. */
function fakeStorage() {
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const tokens = new Map<string, string>();
  let signed = 0;
  const bucket = {
    upload: async (path: string, body: Blob): Promise<{ error: { message: string } | null }> => { calls.push('upload:' + path); objects.set(path, new Uint8Array(await body.arrayBuffer())); return { error: null }; },
    createSignedUrl: async (path: string) => {
      calls.push('sign:' + path);
      const token = `tok.${String(++signed).padStart(24, '0')}.sig`;
      tokens.set(path, token);
      return { data: { signedUrl: `https://x.supabase.co/storage/v1/object/sign/portmgr-voc-transit/${path}?token=${token}` }, error: null };
    },
    remove: async (paths: string[]) => { calls.push('remove:' + paths.join(',')); for (const path of paths) objects.delete(path); return { error: null }; },
    list: async () => ({ data: [], error: null }),
  };
  const client = { auth: { getSession: async () => ({ data: { session: { user: { id: UID } } } }) }, storage: { from: () => bucket } };
  return { objects, calls, tokens, client };
}

/** A scripted Mac: `receive` answers per item, `status` answers later. Every request is checked by the real normalizer. */
function fakeMac(script: { receive?: (request: WorkroomAttachmentReceive, call: number) => WorkroomAttachmentItemResult[] | Error;
  status?: (receiveId: string, call: number) => WorkroomAttachmentItemResult[] | Error;
  rebind?: (ids: string[], targetId: string, call: number) => WorkroomAttachmentItemResult[] | Error } = {}) {
  const sent: MobileWorkspaceRequest[] = [];
  let receives = 0, statuses = 0, rebinds = 0;
  /** id → the project the Mac has it bound to; released ids. */
  const bound = new Map<string, string>(), released: string[] = [];
  const ready = (n: number, kind: 'image' | 'file' = 'file', removed = true): WorkroomAttachmentItemResult => ({ state: 'ready', id: id(n), kind, bytes: 10, lineBytes: 70 + n, expiresInMs: 3_600_000, removed });
  const send = async (request: MobileWorkspaceRequest): Promise<MobileWorkspaceResult> => {
    sent.push(structuredClone(request));
    const action = request.workspace.action;
    if (action === 'attachments.receive') {
      const body = normalizeWorkroomAttachmentRequest('attachments.receive', request.workspace.attachments);
      const answer = script.receive ? script.receive(body, receives++) : body.items.map((item, index) => ready(index + 1, item.kind));
      if (answer instanceof Error) throw answer;
      for (const entry of answer) if (entry.state === 'ready') bound.set(entry.id, request.targetId);
      return { kind: 'workspace', action, workroomAttachments: { receiveId: body.receiveId, items: answer } };
    }
    if (action === 'attachments.rebind') {
      const body = normalizeWorkroomAttachmentRequest('attachments.rebind', request.workspace.attachments);
      const answer = script.rebind ? script.rebind(body.ids, request.targetId, rebinds++)
        : body.ids.map(name => bound.has(name) ? { state: 'ready' as const, id: name, kind: 'file' as const, bytes: 10, lineBytes: 77, expiresInMs: 3_000_000, removed: true }
          : { state: 'failed' as const, code: 'WORKROOM_ATTACH_NOT_FOUND', message: 'Mac에서 이 첨부를 찾지 못했습니다. 다시 넣어 주세요.', removed: true });
      if (answer instanceof Error) throw answer;
      for (const entry of answer) if (entry.state === 'ready') bound.set(entry.id, request.targetId);
      return { kind: 'workspace', action, workroomAttachments: { receiveId: body.receiveId, items: answer } };
    }
    if (action === 'attachments.release') {
      const body = normalizeWorkroomAttachmentRequest('attachments.release', request.workspace.attachments);
      for (const name of body.ids) { released.push(name); bound.delete(name); }
      return { kind: 'workspace', action, workroomAttachments: { receiveId: body.receiveId, items: body.ids.map(() => ({ state: 'failed' as const, code: 'WORKROOM_ATTACH_RELEASED', message: '첨부를 뺐습니다.', removed: true })) } };
    }
    if (action === 'attachments.status') {
      const body = normalizeWorkroomAttachmentRequest('attachments.status', request.workspace.attachments);
      const answer = script.status ? script.status(body.receiveId, statuses++) : [];
      if (answer instanceof Error) throw answer;
      for (const entry of answer) if (entry.state === 'ready') bound.set(entry.id, request.targetId);
      return { kind: 'workspace', action, workroomAttachments: { receiveId: body.receiveId, items: answer } };
    }
    throw new Error('unexpected ' + action);
  };
  return { sent, send, ready, bound, released, receives: () => sent.filter(r => r.workspace.action === 'attachments.receive'),
    rebinds: () => sent.filter(r => r.workspace.action === 'attachments.rebind') };
}

function setup(options: { mac?: ReturnType<typeof fakeMac>; online?: { value: boolean }; now?: { value: number } } = {}) {
  const storage = fakeStorage();
  const mac = options.mac ?? fakeMac();
  const online = options.online ?? { value: true };
  const clock = options.now ?? { value: 1_000_000 };
  const context: RemoteAttachContext = { availability: 'ready', supabase: storage.client as never, hostId: HOST, send: mac.send };
  const attach = new RemoteWorkroomAttachments({
    context: () => context, targetId: TARGET, online: () => online.value, now: () => clock.value,
    sleep: async ms => { clock.value += ms; await Promise.resolve(); },
    // createImageBitmap is not in bun: a photo is "prepared" as it is.
    preparePhoto: async file => ({ bytes: new Uint8Array(await file.arrayBuffer()), mime: 'image/png' }),
    objectUrl: () => undefined,
  });
  return { storage, mac, online, clock, attach, context };
}
const file = (bytes: Uint8Array, name: string, type: string) => new File([bytes as BlobPart], name, { type });
const settle = async (attach: RemoteWorkroomAttachments) => { for (let i = 0; i < 200 && attach.moving(); i++) await new Promise(r => setTimeout(r, 0)); };

describe('remote attachments: availability', () => {
  test('the flag decides; null features or a probe in flight is still checking', () => {
    expect(remoteAttachAvailability(null, false)).toBe('checking');
    expect(remoteAttachAvailability(['workspace-v1'], true)).toBe('checking');
    expect(remoteAttachAvailability(['workspace-v1'], false)).toBe('update-required');
    expect(remoteAttachAvailability(['workspace-v1', WORKROOM_ATTACH_FEATURE], false)).toBe('ready');
    expect(remoteAttachAvailability([WORKROOM_ATTACH_FEATURE], true)).toBe('ready');
  });
});

describe('remote attachments: the transit, in the VOC order', () => {
  test('encrypt → upload → sign, then one receive whose key opens exactly what was uploaded', async () => {
    const { storage, mac, attach } = setup();
    attach.add([file(PDF, '견적서.pdf', 'application/pdf')], 'file');
    await settle(attach);
    const upload = storage.calls.findIndex(c => c.startsWith('upload:')), sign = storage.calls.findIndex(c => c.startsWith('sign:'));
    expect(upload).toBeGreaterThanOrEqual(0);
    expect(sign).toBeGreaterThan(upload);
    const [receive] = mac.receives();
    expect(receive!.targetId).toBe(TARGET);
    const item = (receive!.workspace.attachments as WorkroomAttachmentReceive).items[0]!;
    expect(item.path.startsWith(`${HOST}/${UID}/`)).toBe(true);
    expect(item.token).toBe(storage.tokens.get(item.path)!);
    expect(item.kind).toBe('file');
    expect(item.name).toBe('견적서.pdf');
    const ciphertext = storage.objects.get(item.path)!;
    expect(Buffer.from(ciphertext).includes(Buffer.from(PDF))).toBe(false);
    expect(await decryptTransitBlob(ciphertext, item.key, WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES)).toEqual(PDF);
    expect(item.sha256).toBe(await sha256Hex(PDF));
    expect(attach.snapshot()[0]!.state).toBe('ready');
    expect(attach.ready().ids).toEqual([id(1)]);
  });

  test('a file over 10,485,732 bytes is refused before any storage call', async () => {
    const { storage, mac, attach } = setup();
    const big = new Uint8Array(WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES + 1);
    const notes = attach.add([file(big, 'big.zip', 'application/zip')], 'file');
    await settle(attach);
    expect(notes.join(' ')).toContain('big.zip — 파일 하나는 10MB까지 넣을 수 있습니다');
    expect(storage.calls).toEqual([]);
    expect(mac.sent).toEqual([]);
    expect(attach.snapshot()).toEqual([]);
    // The cap itself still goes through.
    attach.add([file(new Uint8Array(WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES), 'edge.bin', '')], 'file');
    await settle(attach);
    expect(storage.calls.filter(c => c.startsWith('upload:'))).toHaveLength(1);
  });

  test('picks go in batches of at most five, each one a valid receive under 10,000 bytes', async () => {
    const { mac, attach } = setup();
    attach.add(Array.from({ length: 7 }, (_, i) => file(PDF, `${'가'.repeat(60)}-${i}.pdf`, 'application/pdf')), 'file');
    await settle(attach);
    const receives = mac.receives();
    expect(receives.map(r => (r.workspace.attachments as WorkroomAttachmentReceive).items.length)).toEqual([5, 2]);
    for (const r of receives) {
      const body = r.workspace.attachments as WorkroomAttachmentReceive;
      expect(new TextEncoder().encode(JSON.stringify(normalizeWorkroomAttachmentRequest('attachments.receive', body))).length).toBeLessThanOrEqual(10_000);
    }
  });

  test('more than six photos or ten files are refused with their names, nothing uploaded for them', async () => {
    const { storage, attach } = setup();
    const notes = attach.add(Array.from({ length: 8 }, (_, i) => file(PNG, `p${i}.png`, 'image/png')), 'image');
    await settle(attach);
    expect(attach.snapshot()).toHaveLength(6);
    expect(notes.join(' ')).toContain('p6.png');
    expect(storage.calls.filter(c => c.startsWith('upload:'))).toHaveLength(6);
  });

  test('a name with a control or bidi character never reaches the wire', () => {
    expect(sanitizeRemoteAttachName('../../etc/\u202Epasswd\nx.txt')).toBe('passwdx.txt');
    expect(sanitizeRemoteAttachName('\u0000')).toBeUndefined();
    expect(Array.from(sanitizeRemoteAttachName('가'.repeat(200) + '.pdf')!).length).toBe(80);
  });
});

describe('remote attachments: what the Mac answers', () => {
  test('pending, then ready on status; removed:false → the phone deletes the transit object itself', async () => {
    const mac = fakeMac({
      receive: body => body.items.map(() => ({ state: 'pending' })),
      status: (_, call) => call === 0 ? [{ state: 'pending' }] : [{ state: 'ready', id: id(9), kind: 'image', bytes: 16, lineBytes: 90, expiresInMs: 3_600_000, removed: false }],
    });
    const { storage, attach } = setup({ mac });
    attach.add([file(PNG, 'shot.png', 'image/png')], 'image');
    await settle(attach);
    expect(attach.snapshot()[0]!.state).toBe('ready');
    const path = (mac.receives()[0]!.workspace.attachments as WorkroomAttachmentReceive).items[0]!.path;
    expect(storage.calls).toContain('remove:' + path);
    expect(mac.sent.filter(r => r.workspace.action === 'attachments.status')).toHaveLength(2);
  });

  test('one failed item of three: the summary says so, the other two are ready', async () => {
    const mac = fakeMac({ receive: body => body.items.map((item, index) => index === 1
      ? { state: 'failed', code: 'WORKROOM_ATTACH_HASH_MISMATCH', message: '파일이 전달 중에 손상되었습니다. 다시 넣어 주세요.', removed: false }
      : { state: 'ready', id: id(index + 1), kind: item.kind, bytes: 10, lineBytes: 80, expiresInMs: 3_600_000, removed: true }) });
    const { storage, attach } = setup({ mac });
    attach.add([file(PDF, 'a.pdf', 'application/pdf'), file(PDF, 'b.pdf', 'application/pdf'), file(PDF, 'c.pdf', 'application/pdf')], 'file');
    await settle(attach);
    const chips = attach.snapshot();
    expect(chips.map(c => c.state)).toEqual(['ready', 'failed', 'ready']);
    expect(chips[1]!.error).toBe('파일이 전달 중에 손상되었습니다. 다시 넣어 주세요.');
    expect(chips[1]!.retryable).toBe(true);
    expect(remoteAttachSummary(3, 1, 2)).toBe('첨부 3개 중 1개를 전달하지 못했습니다 — 보내면 글과 나머지 2개만 갑니다');
    expect(remoteAttachSummary(1, 1, 0)).toBe('첨부 1개 중 1개를 전달하지 못했습니다 — 보내면 글만 갑니다');
    expect(attach.ready().ids).toEqual([id(1), id(3)]);
    // The failed one's object is the phone's to delete.
    const failedPath = (mac.receives()[0]!.workspace.attachments as WorkroomAttachmentReceive).items[1]!.path;
    expect(storage.calls).toContain('remove:' + failedPath);
  });

  test('a whole-call refusal fails the batch with the Mac message (without its code) and deletes what was uploaded', async () => {
    const mac = fakeMac({ receive: () => new Error('오늘 이 기기에서 보낼 수 있는 첨부 용량(256MB)을 다 썼습니다. 내일 다시 넣어 주세요 (WORKROOM_ATTACH_QUOTA)') });
    const { storage, attach } = setup({ mac });
    attach.add([file(PDF, 'a.pdf', 'application/pdf')], 'file');
    await settle(attach);
    const chip = attach.snapshot()[0]!;
    expect(chip.state).toBe('failed');
    expect(chip.error).toBe('오늘 이 기기에서 보낼 수 있는 첨부 용량(256MB)을 다 썼습니다. 내일 다시 넣어 주세요');
    expect(storage.objects.size).toBe(0);
  });

  test('an answer that cannot be read is asked again with the same receiveId at most three times, then 「전달 못 함」', async () => {
    const mac = fakeMac({ receive: () => held('REMOTE_CONTROL_RESULT_UNREACHABLE') });
    const { storage, attach } = setup({ mac });
    attach.add([file(PDF, 'a.pdf', 'application/pdf')], 'file');
    await settle(attach);
    const receives = mac.receives();
    expect(receives).toHaveLength(4);
    expect(new Set(receives.map(r => JSON.stringify(r.workspace.attachments))).size).toBe(1);
    expect(attach.snapshot()[0]!.state).toBe('failed');
    expect(storage.objects.size).toBe(0);
  });

  test('held on the phone: the objects stay, and after reconnecting the same receive is asked again', async () => {
    let first = true;
    const mac = fakeMac({ receive: body => {
      if (first) { first = false; return held('REMOTE_CONTROL_REQUEST_UNSENT'); }
      return body.items.map((item, index) => ({ state: 'ready', id: id(index + 1), kind: item.kind, bytes: 10, lineBytes: 70, expiresInMs: 3_600_000, removed: true }));
    } });
    const online = { value: true };
    const { storage, attach } = setup({ mac, online });
    // The controller holds the request because the network went away while it was being sent.
    const holding = attach.add([file(PDF, 'a.pdf', 'application/pdf')], 'file');
    expect(holding).toEqual([]);
    for (let i = 0; i < 50 && mac.receives().length < 1; i++) await new Promise(r => setTimeout(r, 0));
    online.value = false;
    for (let i = 0; i < 50 && attach.snapshot()[0]!.state !== 'held'; i++) await new Promise(r => setTimeout(r, 0));
    expect(attach.snapshot()[0]!.state).toBe('held');
    expect(storage.calls.some(c => c.startsWith('remove:'))).toBe(false);
    expect(storage.objects.size).toBe(1);
    online.value = true;
    attach.kick();
    await settle(attach);
    const receives = mac.receives();
    expect(receives).toHaveLength(2);
    expect(JSON.stringify(receives[1]!.workspace.attachments)).toBe(JSON.stringify(receives[0]!.workspace.attachments));
    expect(attach.snapshot()[0]!.state).toBe('ready');
  });

  test('offline: a pick waits with no storage or relay request until the phone is online', async () => {
    const online = { value: false };
    const { storage, mac, attach } = setup({ online });
    attach.add([file(PDF, 'a.pdf', 'application/pdf')], 'file');
    await settle(attach);
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    expect(attach.snapshot()[0]!.state).toBe('waiting');
    expect(storage.calls).toEqual([]);
    expect(mac.sent).toEqual([]);
    online.value = true;
    attach.kick();
    await settle(attach);
    expect(attach.snapshot()[0]!.state).toBe('ready');
  });
});

describe('remote attachments: a network that drops while the phone says online', () => {
  test('an upload that fails like a dropped fetch waits (no tight retry loop) and goes on at the next nudge', async () => {
    const { storage, attach } = setup();
    const bucket = storage.client.storage.from();
    const upload = bucket.upload;
    let failing = true, attempts = 0;
    bucket.upload = async (path: string, body: Blob) => { attempts += 1; return failing ? { error: { message: 'Load failed' } } : upload(path, body); };
    attach.add([file(PDF, 'a.pdf', 'application/pdf')], 'file');
    for (let i = 0; i < 50; i++) await new Promise(r => setTimeout(r, 0));
    expect(attach.snapshot()[0]!.state).toBe('waiting');
    expect(attempts).toBe(1);
    failing = false;
    attach.kick();
    await settle(attach);
    expect(attach.snapshot()[0]!.state).toBe('ready');
    expect(attempts).toBe(2);
  });
});

describe('remote attachments: the request around them', () => {
  test('the 24,000-byte budget counts the host block from lineBytes', async () => {
    const mac = fakeMac({ receive: body => body.items.map((item, index) => ({ state: 'ready', id: id(index + 1), kind: item.kind, bytes: 10, lineBytes: index === 0 ? 120 : 95, expiresInMs: 3_600_000, removed: true })) });
    const { attach } = setup({ mac });
    attach.add([file(PNG, 'a.png', 'image/png')], 'image');
    await settle(attach);
    attach.add([file(PDF, 'b.pdf', 'application/pdf')], 'file');
    await settle(attach);
    const text = '이 두 파일을 보고 고쳐 주세요';
    const expected = new TextEncoder().encode(workroomAttachmentMessage(text, ['x'.repeat(120)], ['x'.repeat(120)])).length + 1;
    // Each batch's first item answers lineBytes 120 in this script.
    expect(attach.requestBytes(text)).toBe(expected);
    expect(attach.requestBytes('')).toBe(new TextEncoder().encode(workroomAttachmentMessage('', ['x'.repeat(120)], ['x'.repeat(120)])).length + 1);
  });

  test('a ready id the Mac will have dropped is marked failed (retryable) before it is sent', async () => {
    const clock = { value: 1_000_000 };
    const { attach } = setup({ now: clock });
    attach.add([file(PDF, 'a.pdf', 'application/pdf')], 'file');
    await settle(attach);
    expect(attach.ready().ids).toHaveLength(1);
    clock.value += 3_600_000;
    expect(attach.ready().ids).toEqual([]);
    const chip = attach.snapshot()[0]!;
    expect(chip.state).toBe('failed');
    expect(chip.retryable).toBe(true);
  });

  test('another project: a ready id follows with one rebind (no upload, no receive); retry re-sends a failed one', async () => {
    let fail = true;
    const mac = fakeMac({ receive: body => body.items.map((item, index) => fail
      ? { state: 'failed', code: 'WORKROOM_ATTACH_DOWNLOAD_FAILED', message: 'Mac이 파일을 내려받지 못했습니다. 잠시 뒤 다시 시도하세요.', removed: true }
      : { state: 'ready', id: id(index + 5), kind: item.kind, bytes: 10, lineBytes: 70, expiresInMs: 3_600_000, removed: true }) });
    const { storage, attach } = setup({ mac });
    attach.add([file(PDF, 'a.pdf', 'application/pdf')], 'file');
    await settle(attach);
    expect(attach.snapshot()[0]!.state).toBe('failed');
    fail = false;
    attach.retry(attach.snapshot()[0]!.key);
    await settle(attach);
    expect(attach.snapshot()[0]!.state).toBe('ready');
    attach.retarget(OTHER);
    await settle(attach);
    expect(mac.receives().at(-1)!.targetId).toBe(TARGET);
    expect(mac.rebinds().map(r => [r.targetId, (r.workspace.attachments as { ids: string[] }).ids])).toEqual([[OTHER, [id(5)]]]);
    expect(storage.calls.filter(c => c.startsWith('upload:'))).toHaveLength(2);
    expect(attach.snapshot()[0]!.state).toBe('ready');
    expect(attach.ready().ids).toEqual([id(5)]);
  });

  test('a removed chip is gone from the snapshot and from what is sent', async () => {
    const { attach } = setup();
    attach.add([file(PDF, 'a.pdf', 'application/pdf'), file(PDF, 'b.pdf', 'application/pdf')], 'file');
    await settle(attach);
    attach.remove(attach.snapshot()[0]!.key);
    expect(attach.snapshot().map(c => c.name)).toEqual(['b.pdf']);
    expect(attach.ready().ids).toHaveLength(1);
  });
});

describe('review w13: projects, removal and disposal never leave ids or objects behind', () => {
  /** Every object the phone uploaded was either named in a receive to a Mac or deleted by the phone. */
  const orphans = (storage: ReturnType<typeof fakeStorage>, mac: ReturnType<typeof fakeMac>) => {
    const named = new Set(mac.receives().flatMap(r => (r.workspace.attachments as WorkroomAttachmentReceive).items.map(item => item.path)));
    const removed = new Set(storage.calls.filter(c => c.startsWith('remove:')).flatMap(c => c.slice('remove:'.length).split(',')));
    return storage.calls.filter(c => c.startsWith('upload:')).map(c => c.slice('upload:'.length)).filter(path => !named.has(path) && !removed.has(path));
  };
  const tick = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
  /** A file whose bytes arrive only when `release()` is called (a slow read from Files/iCloud). */
  const slowFile = (name: string) => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    return { file: { name, type: 'application/octet-stream', size: 4, arrayBuffer: async () => { await gate; return new Uint8Array([9, 9, 9, 9]).buffer; } }, release };
  };

  test('flipping projects five times: one receive, one rebind per switch, the same id — and removal releases it', async () => {
    const { storage, mac, attach } = setup();
    attach.add([file(PDF, 'a.pdf', 'application/pdf'), file(PNG, 'b.png', 'image/png')], 'file');
    await settle(attach);
    const first = attach.ready().ids;
    expect(first).toHaveLength(2);
    for (const target of [OTHER, TARGET, OTHER, TARGET, OTHER]) { attach.retarget(target); await settle(attach); }
    expect(mac.receives()).toHaveLength(1);
    expect(storage.calls.filter(c => c.startsWith('upload:'))).toHaveLength(2);
    expect(mac.rebinds().map(r => r.targetId)).toEqual([OTHER, TARGET, OTHER, TARGET, OTHER]);
    expect(attach.ready().ids).toEqual(first);
    for (const name of first) expect(mac.bound.get(name)).toBe(OTHER);
    attach.remove(attach.snapshot()[0]!.key);
    attach.clear();
    await tick();
    expect(mac.released.sort()).toEqual([...first].sort());
    expect(orphans(storage, mac)).toEqual([]);
  });

  test('a rebind the Mac answers failed (expired, consumed) sends the kept bytes again for the new project', async () => {
    const mac = fakeMac({ rebind: ids => ids.map(() => ({ state: 'failed', code: 'WORKROOM_ATTACH_CONSUMED', message: '이미 보낸 요청에 쓰인 첨부입니다. 다시 넣어 주세요.', removed: true })) });
    const { storage, attach } = setup({ mac });
    attach.add([file(PDF, 'a.pdf', 'application/pdf')], 'file');
    await settle(attach);
    attach.retarget(OTHER);
    await settle(attach);
    expect(mac.receives().map(r => r.targetId)).toEqual([TARGET, OTHER]);
    expect(storage.calls.filter(c => c.startsWith('upload:'))).toHaveLength(2);
    expect(attach.snapshot()[0]!.state).toBe('ready');
  });

  test('a switch while the Mac is still receiving: the id follows once it is ready', async () => {
    const mac = fakeMac({ receive: body => body.items.map(() => ({ state: 'pending' })),
      status: (_, call) => call < 2 ? [{ state: 'pending' }] : [{ state: 'ready', id: id(3), kind: 'file', bytes: 10, lineBytes: 70, expiresInMs: 3_600_000, removed: true }] });
    const { attach } = setup({ mac });
    attach.add([file(PDF, 'a.pdf', 'application/pdf')], 'file');
    for (let i = 0; i < 60 && mac.receives().length < 1; i++) await new Promise(r => setTimeout(r, 0));
    attach.retarget(OTHER);
    await settle(attach);
    expect(mac.receives().map(r => r.targetId)).toEqual([TARGET]);
    expect(mac.rebinds().map(r => r.targetId)).toEqual([OTHER]);
    expect(attach.ready().ids).toEqual([id(3)]);
  });

  test('retarget(): an upload not yet handed to a Mac goes to the new project — never left in the bucket, never uploaded twice', async () => {
    const { storage, mac, attach } = setup();
    const slow = slowFile('b.bin');
    attach.add([file(PDF, 'a.bin', 'application/octet-stream'), slow.file], 'file');
    await tick();
    expect(storage.calls.filter(c => c.startsWith('upload:'))).toHaveLength(1);
    expect(mac.receives()).toHaveLength(0);
    attach.retarget(OTHER);
    slow.release();
    await settle(attach);
    expect(mac.receives().map(r => r.targetId)).toEqual([OTHER]);
    expect(storage.calls.filter(c => c.startsWith('upload:'))).toHaveLength(2);
    expect(orphans(storage, mac)).toEqual([]);
  });

  test('dispose(): an upload not yet handed to a Mac is deleted, a ready id released, a receive in flight deletes what it did not settle', async () => {
    const { storage, mac, attach } = setup();
    attach.add([file(PDF, 'ready.pdf', 'application/pdf')], 'file');
    await settle(attach);
    const [readyId] = attach.ready().ids;
    const slow = slowFile('b.bin');
    attach.add([file(PDF, 'a.bin', 'application/octet-stream'), slow.file], 'file');
    await tick();
    const staged = storage.calls.filter(c => c.startsWith('upload:')).map(c => c.slice('upload:'.length)).at(-1)!;
    attach.dispose();
    slow.release();
    await tick(200);
    expect(storage.calls).toContain('remove:' + staged);
    expect(mac.released).toEqual([readyId!]);
    expect(orphans(storage, mac)).toEqual([]);
  });

  test('a chip removed while the Mac is still receiving: the id the Mac then makes ready is released', async () => {
    const mac = fakeMac({ receive: body => body.items.map(() => ({ state: 'pending' })),
      status: (_, call) => call < 1 ? [{ state: 'pending' }] : [{ state: 'ready', id: id(4), kind: 'file', bytes: 10, lineBytes: 70, expiresInMs: 3_600_000, removed: true }] });
    const { attach } = setup({ mac });
    attach.add([file(PDF, 'a.pdf', 'application/pdf')], 'file');
    for (let i = 0; i < 60 && mac.receives().length < 1; i++) await new Promise(r => setTimeout(r, 0));
    attach.remove(attach.snapshot()[0]!.key);
    expect(attach.moving()).toBe(false);
    await tick(200);
    expect(mac.released).toEqual([id(4)]);
  });

  test('ids the Mac refused at begin are failed (retryable) and released, so its room comes back', async () => {
    const { mac, attach } = setup();
    attach.add([file(PDF, 'a.pdf', 'application/pdf')], 'file');
    await settle(attach);
    const { ids, keys } = attach.ready();
    attach.invalidate(keys, '다른 프로젝트용으로 넣은 첨부입니다');
    await tick();
    expect(attach.snapshot()[0]!.state).toBe('failed');
    expect(attach.snapshot()[0]!.retryable).toBe(true);
    expect(mac.released).toEqual(ids);
  });

  test('chip names and notices never carry a control or bidi character (an RLO would reverse them)', async () => {
    const { attach } = setup({ online: { value: false } });
    const notes = attach.add([file(PDF, 'invoice\u202efdp.exe', 'application/octet-stream')], 'file');
    const big = attach.add([{ name: 'big\u202efdp.exe', type: 'application/octet-stream', size: WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) }], 'file');
    const chip = attach.snapshot()[0]!;
    expect(notes).toEqual([]);
    expect(chip.name).toBe('invoicefdp.exe');
    expect(big.join(' ')).toBe('bigfdp.exe — 파일 하나는 10MB까지 넣을 수 있습니다');
    const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
    expect(unsafe.test(chip.name)).toBe(false);
    expect(attach.add([{ name: '\u202e', type: 'application/octet-stream', size: WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) }], 'file').join(' '))
      .toBe('이름에 제어·방향 문자가 있는 항목 — 파일 하나는 10MB까지 넣을 수 있습니다');
  });

  test('back online after the three-minute window: a fresh status is asked first and a ready item is kept', async () => {
    const online = { value: true };
    const clock = { value: 1_000_000 };
    let macDone = false;
    const mac = fakeMac({ receive: body => body.items.map(() => ({ state: 'pending' })),
      status: (_, call) => {
        // The network goes away right after the Mac admitted the receive.
        if (call === 0) { online.value = false; return held('REMOTE_CONTROL_PHONE_OFFLINE'); }
        if (!online.value) return held('REMOTE_CONTROL_PHONE_OFFLINE');
        return macDone ? [{ state: 'ready', id: id(8), kind: 'file', bytes: 10, lineBytes: 70, expiresInMs: 3_600_000, removed: true }] : [{ state: 'pending' }];
      } });
    const { attach } = setup({ mac, online, now: clock });
    attach.add([file(PDF, 'a.pdf', 'application/pdf')], 'file');
    for (let i = 0; i < 200 && attach.snapshot()[0]?.state !== 'waiting'; i++) await new Promise(r => setTimeout(r, 0));
    // While the status is refused offline the chip says it waits for the network, not that the Mac is receiving.
    expect(attach.snapshot()[0]!.state).toBe('waiting');
    // Four minutes pass offline; the Mac finished meanwhile.
    clock.value += 4 * 60_000;
    macDone = true;
    const asked = mac.sent.filter(r => r.workspace.action === 'attachments.status').length;
    online.value = true;
    attach.kick();
    await settle(attach);
    expect(mac.sent.filter(r => r.workspace.action === 'attachments.status').length).toBeGreaterThan(asked);
    expect(attach.snapshot()[0]!.state).toBe('ready');
    expect(attach.ready().ids).toEqual([id(8)]);
  });

  test('a fresh status after the window that still says pending fails only that item', async () => {
    const clock = { value: 1_000_000 };
    const mac = fakeMac({ receive: body => body.items.map(() => ({ state: 'pending' })), status: () => [{ state: 'pending' }] });
    const { attach } = setup({ mac, now: clock });
    attach.add([file(PDF, 'a.pdf', 'application/pdf')], 'file');
    await settle(attach);
    expect(attach.snapshot()[0]!.state).toBe('failed');
    expect(attach.snapshot()[0]!.error).toBe('Mac이 제때 받지 못했습니다. 다시 시도하세요.');
  });
});

