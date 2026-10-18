// Phone Workroom attachments (w13 step B), end to end in the real portal bundle: a real E2EE fake Mac behind a fake relay and
// a Playwright-routed transit bucket kept in memory. The fake Mac DECRYPTS what the phone uploaded with the key the phone
// relayed and checks size and sha256 (and that a photo is an image) before it answers ready — the same checks the real Mac
// makes — and every relay request it receives goes through the real wire normalizers.
//
// Cases (WebKit and Chromium):
//   - the session view has exactly two file inputs: 사진 (`accept="image/*"`) and 파일 (no accept); 「+」 opens a menu whose rows
//     open them;
//   - a PNG and a PDF become a thumbnail chip and a name chip, then ready; the uploaded bodies hold neither `\x89PNG` nor `%PDF`;
//     send → the Mac's submission names both ids, written, the chips go;
//   - the Mac fails one of two → 「첨부 2개 중 1개를 전달하지 못했습니다 …」, send stays enabled, one id goes;
//   - an older Mac (no workroom-attach-v1) → 「+」 says 「Mac 앱 업데이트 필요」 and no file chooser opens;
//   - the 「새 작업」 sheet: 사진 첨부 + start → the launch names the id and the new session opens full screen;
//   - offline (Chromium — Playwright's WebKit keeps navigator.onLine true): a pick waits as 「연결되면 전달」 with zero storage
//     requests until the phone is online;
//   - an iPad (1180×820, coarse pointer): a PNG dropped on the docked composer becomes a chip;
//   - another AgentsToZ's session (a community device): 「+」 is disabled with the reason;
//   - 320/390/428/926×428: 「+」 and the menu rows are ≥44px, the composer is 16px, the page never scrolls sideways.
//   Review w13 (each failed before its fix):
//   - a launch whose answer was lost and later settles as written takes its chips with it (no second CLI with the same ids);
//   - the Mac refusing the ids at begin (nothing prepared) leaves the text sendable, in the session and in the sheet;
//   - three failed files and a refusal keep the terminal at least half of what it had (320×568, 926×428); with a (simulated)
//     keyboard up the top bar, the composer, send and 「+」 stay inside the view;
//   - a refusal notice goes with a written send and has a 44px close button;
//   - offline, send says 「연결되면 첨부를 전달합니다」, not that a transfer is under way;
//   - a desktop browser's inline 「+」 is 44px wide; a sheet closed with only attachments says so on 「새 작업」.
//
// Isolated: a portal build with fixture VITE_* values; no network, no 3001, no live Supabase, no Mac.
// Build: VITE_SUPABASE_URL=https://fixture-offline.supabase.co VITE_SUPABASE_ANON_KEY=<jwt-shaped> \
//          ./node_modules/.bin/vite build --config vite.portal.config.ts --outDir <dir>
// Run:   bun tests/remote-workroom-attach.e2e.mjs <dir> [screenshotDir]
//        ATTACH_E2E_ENGINES=webkit narrows the engines; ATTACH_E2E_CASES=send,partial runs only those cases.
import { chromium, webkit } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { REMOTE_CONTROL_PROTOCOL_VERSION } from '../src/remoteControlProtocol.ts';
import { buildRemoteControlRelayPairingUrl, REMOTE_CONTROL_RELAY_SCHEMA_VERSION } from '../src/remoteControlRelayContract.ts';
import {
  decryptRemoteControlRelayEnvelope, deriveRemoteControlRelaySessionKey, encryptRemoteControlRelayEnvelope,
  exportRemoteControlRelayPublicKey, fingerprintRemoteControlRelayPublicKey, generateRemoteControlRelayKeyPair,
  importRemoteControlRelayPublicKey,
} from '../src/remoteControlRelayCrypto.ts';
import { decryptTransitBlob, sha256Hex } from '../src/vocAttachments.ts';
import { normalizeMobileWorkspaceRequest } from '../src/mobileWorkspaceProtocol.ts';
import { normalizeWorkroomSubmission } from '../src/workroomSubmissionProtocol.ts';
import { WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES } from '../src/workroomRemoteAttachmentProtocol.ts';

const root = resolve(process.argv[2] || 'dist-portal');
const shots = process.argv[3] || '';
if (shots) mkdirSync(shots, { recursive: true });
const engines = (process.env.ATTACH_E2E_ENGINES || 'webkit,chromium').split(',');
const only = process.env.ATTACH_E2E_CASES ? process.env.ATTACH_E2E_CASES.split(',') : null;

const PAGE = 'https://portal.test';
const SUPABASE = 'fixture-offline.supabase.co';
const BUCKET = 'portmgr-voc-transit';
const ids = { host: '11111111-1111-4111-8111-111111111111', pairing: '22222222-2222-4222-8222-222222222222',
  session: '33333333-3333-4333-8333-333333333333', controller: '44444444-4444-4444-8444-444444444444' };
const encoder = new TextEncoder(), decoder = new TextDecoder();
const DAY = 86_400_000;
const now = () => new Date().toISOString();
const cid = c => c.repeat(42) + '1';
const DEV = cid('D'), BLOG = cid('B'), OPS = cid('O'), REMOTE_PROJECT = cid('R');
// The OPS project is what the portal reads the community (and so the device tabs) through.
const projects = [
  { controlId: OPS, name: 'AgentsToZ-OPS', role: 'ops', kind: 'main', status: 'unknown', port: null, branch: 'main', actions: ['folder.open'] },
  { controlId: DEV, name: 'AgentsToZ_byCS', role: 'dev', kind: 'main', status: 'running', port: 4317, branch: 'main', actions: ['stop', 'folder.open'] },
  { controlId: BLOG, name: '블로그', kind: 'main', status: 'stopped', port: 5173, branch: 'main', actions: ['start', 'folder.open'] },
];
const ATTACH = 'workroom-attach-v1';
const BASE_FEATURES = ['workspace-v1', 'voc-v1', 'terminal-refs-v1', 'terminal-submission-v1', 'terminal-start-submission-v1'];
const SESSION = '55555555-5555-4555-8555-555555555551';
const DEVICE_REF = '0123456789abcdef';
const DEVICE_SESSION = '55555555-5555-4555-8555-555555555599';

// ── bytes ─────────────────────────────────────────────────────────────────────────────────────────────
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
/** A real, decodable 8×8 RGB PNG: createImageBitmap has to read it. */
function png() {
  const w = 8, h = 8, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 200; raw[o + 1] = x * 30; raw[o + 2] = y * 30; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png();
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const isImage = bytes => (bytes[0] === 0xff && bytes[1] === 0xd8) || (bytes[0] === 0x89 && bytes[1] === 0x50);
/** The file part of a storage-js multipart upload (name "", filename "blob"). */
function multipartFile(body, contentType) {
  const boundary = /boundary=([^;]+)/.exec(contentType || '')?.[1];
  if (!boundary) return body;
  const marker = Buffer.from('--' + boundary);
  let at = 0;
  for (;;) {
    const start = body.indexOf(marker, at);
    if (start < 0) return null;
    const headEnd = body.indexOf('\r\n\r\n', start);
    if (headEnd < 0) return null;
    const head = body.subarray(start, headEnd).toString();
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), marker]), headEnd);
    if (/filename=/.test(head)) return body.subarray(headEnd + 4, next);
    at = next;
  }
}

// ── the fake Mac ──────────────────────────────────────────────────────────────────────────────────────
async function fixtureMac({ features = [...BASE_FEATURES, ATTACH], failAttach = null, community = false, launchUncertain = false, refuseIds = false } = {}) {
  const keys = await generateRemoteControlRelayKeyPair();
  const hostPublicKey = await exportRemoteControlRelayPublicKey(keys.publicKey);
  const state = { hostSequence: 0, deliveries: [], accepted: new Set(), started: [], inputs: [], receipts: new Map(), submissions: [],
    objects: new Map(), tokens: new Map(), uploads: [], deletes: [], storageCalls: [], jobs: new Map(), issues: [], received: [], minted: 0, sent: new Map(),
    consumed: new Set(), bound: new Map(), rebinds: [], releases: [] };
  const reply = async message => {
    state.hostSequence += 1;
    state.deliveries.push({ relaySequence: state.hostSequence, envelope: await encryptRemoteControlRelayEnvelope({
      key: state.hostSend,
      metadata: { schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, messageId: crypto.randomUUID(), sessionId: ids.session,
        controllerId: ids.controller, sequence: state.hostSequence, expiresAt: new Date(Date.now() + 9 * 60_000).toISOString() },
      plaintext: encoder.encode(JSON.stringify(message)),
    }) });
  };
  const session = (id, targetId, agent = 'claude') => ({ id, targetId, agent, state: 'running', createdAt: new Date(Date.now() - 600_000).toISOString(), exitCode: null, cols: 100, rows: 28 });
  const run = async message => {
    if (message.type === 'controller.pair') {
      return reply({ type: 'session.ready', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, sessionToken: 'T'.repeat(43), hostName: '아젠투지1호 MacBook Pro',
        expiresAt: new Date(Date.now() + 29 * DAY).toISOString(), idleExpiresAt: new Date(Date.now() + 29 * DAY).toISOString(), projects, projectCount: projects.length, nextPage: null });
    }
    if (message.type === 'action.request') {
      const base = { type: 'action.result', actionId: message.actionId };
      if (message.action === 'protocol.capabilities' || message.action === 'protocol.capabilities.extended') return reply({ ...base, ok: true, supportedFeatures: features });
      if (message.action === 'projects.list') return reply({ ...base, ok: true, projects, page: message.page ?? 0, projectCount: projects.length, nextPage: null });
      if (message.action === 'workspace-roots.list') return reply({ ...base, ok: true, workspaceRoots: [] });
      if (message.action === 'ops.status') return reply({ ...base, ok: true, ops: { state: 'ready', backend: 'app-data', pendingCount: 0, lastSavedAt: null, syncState: null } });
      return reply({ ...base, ok: false, error: { code: 'ACTION_NOT_ALLOWED', message: '이 테스트 Mac에는 없는 동작입니다.' } });
    }
    if (message.type !== 'terminal.request') return;
    const req = message.request, op = req.operation;
    const ok = body => reply({ type: 'terminal.result', requestId: req.requestId, ok: true, body });
    const fail = error => reply({ type: 'terminal.result', requestId: req.requestId, ok: false, error });
    // Another AgentsToZ's session, reached through this Mac.
    if (message.device) {
      const remote = [session(DEVICE_SESSION, REMOTE_PROJECT)];
      if (op === 'list') return ok(req.capabilities ? { sessions: remote, features: ['terminal-submission-v1'] } : { sessions: remote });
      if (op === 'read') return ok({ session: remote[0], chunks: [], nextCursor: req.after ?? 0, truncated: false, hasMore: false });
      return ok({ session: remote[0] });
    }
    const all = [session(SESSION, DEV), ...state.started];
    if (op === 'list') return ok(req.capabilities ? { sessions: all, features: ['terminal-submission-v1', 'terminal-start-submission-v1'] } : { sessions: all });
    if (op === 'read') return ok({ session: all.find(s => s.id === req.sessionId) ?? all[0], chunks: req.after ? [] : [{ seq: 1, text: '› 준비됨\r\n' }], nextCursor: 1, truncated: false, hasMore: false });
    if (op === 'resize' || op === 'input') { if (op === 'input') state.inputs.push(req.data); return ok({ session: all.find(s => s.id === req.sessionId) ?? all[0] }); }
    if (op === 'submission') {
      let sub;
      try { sub = normalizeWorkroomSubmission(req.submission); } catch (error) { state.issues.push('submission refused by the wire normalizer: ' + error.message); return fail('제출 내용을 확인하지 못했습니다.'); }
      const receipt = (id, extra = {}) => ({ id, storeId: 'store-fixture1', epoch: 'epoch-fixture1', revision: 1, state: 'written', ...extra });
      if (sub.phase === 'recent') return ok({ submissions: [] });
      if (sub.phase === 'status') { state.statusCalls = (state.statusCalls ?? 0) + 1; const found = state.receipts.get(sub.id); return found ? ok({ submission: found }) : fail('같은 호스트 저장소의 제출 기록을 확인하지 못했습니다. 자동 재전송하지 않습니다.'); }
      if (sub.phase !== 'single') return fail('이 테스트 Mac에는 없는 요청입니다.');
      // The Mac refuses the ids at begin (its own sentence, src/workroomRemoteAttachments.server.ts): nothing is prepared.
      if (refuseIds && (sub.attachments ?? []).length) { state.refused = (state.refused ?? 0) + 1; return fail('첨부 1개를 찾을 수 없거나 만료되었습니다 — 첨부를 다시 넣어 주세요. 작성 내용은 유지했습니다.'); }
      // Single use, as on the real Mac: a new request naming an id another written request consumed is refused.
      const reused = (sub.attachments ?? []).filter(name => state.consumed.has(name));
      if (reused.length && !state.receipts.has(sub.id)) return fail(`첨부 ${reused.length}개를 찾을 수 없거나 만료되었습니다 — 첨부를 다시 넣어 주세요. 작성 내용은 유지했습니다.`);
      const known = (sub.attachments ?? []).filter(id => [...state.jobs.values()].some(job => job.items.some(item => item.id === id)));
      if (known.length !== (sub.attachments ?? []).length) state.issues.push('a submission named an id this Mac never issued');
      state.submissions.push({ id: sub.id, launch: sub.launch ?? null, text: Buffer.from(sub.data, 'base64').toString(), attachments: sub.attachments ?? [] });
      for (const name of sub.attachments ?? []) state.consumed.add(name);
      if (sub.launch) {
        const created = session(`55555555-5555-4555-8555-5555555556${String(state.started.length).padStart(2, '0')}`, sub.launch.targetId, sub.launch.agent);
        state.started.push(created);
        const done = receipt(sub.id, { sessionId: created.id, targetId: created.targetId, agent: created.agent });
        // The first launch ran (its CLI is listed) but its answer was lost; its receipt still says write_started.
        if (launchUncertain && state.started.length === 1) { state.receipts.set(sub.id, { ...done, state: 'write_started' }); state.uncertainId = sub.id; return fail('터미널 응답을 확인하지 못했습니다. 입력은 전달되었을 수 있으므로 화면을 확인한 뒤 다시 시도하세요.'); }
        state.receipts.set(sub.id, done);
        return ok({ submission: done });
      }
      const done = receipt(sub.id);
      state.receipts.set(sub.id, done);
      return ok({ submission: done });
    }
    if (op === 'workspace') {
      try { normalizeMobileWorkspaceRequest(req); } catch (error) { state.issues.push(`${req.workspace?.action} refused by the wire normalizer: ${error.message}`); return fail('모바일 작업 요청 형식이 올바르지 않습니다.'); }
      const action = req.workspace.action;
      const ws = extra => ok({ kind: 'workspace', action, ...extra });
      if (action === 'workroom.status') return ws({ workroom: { sessionId: req.workspace.sessionId ?? SESSION, initialized: true, lastSavedAt: null, context: { usedPercent: null, observedAt: null, source: 'unavailable' }, save: { requestId: null, state: 'idle', localSaved: false, backupSaved: false, message: '' } } });
      if (action === 'history.list') return ws({ history: { records: [], nextBefore: null } });
      if (action === 'community.status' || action === 'community.read') return ws({ community: { inside: community, roomId: '66666666-6666-4666-8666-666666666666', unread: 0,
        members: [{ name: '아젠투지1호 MacBook Pro', kind: 'ops', self: true }], devices: community ? [{ ref: DEVICE_REF, name: '아젠투지2호 Windows 데스크톱', kind: 'ops' }] : [], messages: [], nextSeq: 1 } });
      if (action === 'community.projects') return ws({ communityProjects: { deviceName: '아젠투지2호 Windows 데스크톱', opsTargetId: null, projects: [{ targetId: REMOTE_PROJECT, label: '원격 프로젝트' }], page: 0, hasMore: false, total: 1 } });
      if (action === 'attachments.receive') {
        const body = req.workspace.attachments;
        if (!projects.some(project => project.controlId === req.targetId)) state.issues.push('a receive for a project this Mac does not have');
        const job = { targetId: req.targetId, items: [] };
        for (const item of body.items) {
          const stored = state.objects.get(item.path);
          const issue = text => state.issues.push(`${item.name ?? item.kind}: ${text}`);
          if (!item.path.startsWith(ids.host + '/')) issue('the transit path is not under this Mac\'s host id');
          if (state.tokens.get(item.path) !== item.token) issue('the relayed token is not the one the bucket signed');
          let plain = null;
          if (!stored) issue('nothing was uploaded at that path');
          else { try { plain = Buffer.from(await decryptTransitBlob(stored, item.key, WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES)); } catch { issue('the relayed key does not open the upload'); } }
          if (plain && await sha256Hex(plain) !== item.sha256) issue('sha256 mismatch');
          if (plain && plain.length !== item.bytes) issue('size mismatch');
          if (plain && item.kind === 'image' && !isImage(plain)) issue('a photo that is not an image');
          state.received.push({ kind: item.kind, name: item.name ?? null, plain });
          job.items.push({ kind: item.kind, name: item.name, plain, failed: !!failAttach && (item.name ?? '') === failAttach });
        }
        state.jobs.set(body.receiveId, job);
        return ws({ workroomAttachments: { receiveId: body.receiveId, items: body.items.map(() => ({ state: 'pending' })) } });
      }
      if (action === 'attachments.status') {
        const job = state.jobs.get(req.workspace.attachments.receiveId);
        if (!job) return fail('첨부 전달 기록을 찾지 못했습니다 — 첨부를 다시 넣어 주세요 (WORKROOM_ATTACH_NOT_FOUND)');
        return ws({ workroomAttachments: { receiveId: req.workspace.attachments.receiveId, items: job.items.map(item => {
          if (item.failed || !item.plain) return { state: 'failed', code: 'WORKROOM_ATTACH_HASH_MISMATCH', message: '파일이 전달 중에 손상되었습니다. 다시 넣어 주세요.', removed: false };
          if (!item.id) { item.id = 'wa_' + String(++state.minted).padStart(32, 'Z'); state.bound.set(item.id, job.targetId); }
          // removed:false — this fake Mac has no service_role: the phone deletes the transit object itself.
          return { state: 'ready', id: item.id, kind: item.kind, bytes: item.plain.length, lineBytes: 72, expiresInMs: 3_600_000, removed: false };
        }) } });
      }
      if (action === 'attachments.rebind') {
        const body = req.workspace.attachments;
        state.rebinds.push({ targetId: req.targetId, ids: body.ids });
        return ws({ workroomAttachments: { receiveId: body.receiveId, items: body.ids.map(name => {
          if (!state.bound.has(name) || state.consumed.has(name)) return { state: 'failed', code: 'WORKROOM_ATTACH_NOT_FOUND', message: 'Mac에서 이 첨부를 찾지 못했습니다. 다시 넣어 주세요.', removed: true };
          state.bound.set(name, req.targetId);
          return { state: 'ready', id: name, kind: 'file', bytes: 10, lineBytes: 72, expiresInMs: 3_600_000, removed: true };
        }) } });
      }
      if (action === 'attachments.release') {
        const body = req.workspace.attachments;
        for (const name of body.ids) { state.releases.push(name); state.bound.delete(name); }
        return ws({ workroomAttachments: { receiveId: body.receiveId, items: body.ids.map(() => ({ state: 'failed', code: 'WORKROOM_ATTACH_RELEASED', message: '첨부를 뺐습니다.', removed: true })) } });
      }
      return fail('이 테스트 Mac에는 없는 요청입니다.');
    }
    return fail('이 테스트 Mac에는 없는 요청입니다.');
  };
  const rpc = {
    portmgr_is_member: () => true,
    portmgr_remote_control_claim_pairing: async args => {
      const peer = await importRemoteControlRelayPublicKey(args.p_controller_public_key);
      state.hostReceive = await deriveRemoteControlRelaySessionKey({ privateKey: keys.privateKey, peerPublicKey: peer,
        sessionId: ids.session, controllerId: ids.controller, direction: 'controller-to-host', usages: ['decrypt'] });
      state.hostSend = await deriveRemoteControlRelaySessionKey({ privateKey: keys.privateKey, peerPublicKey: peer,
        sessionId: ids.session, controllerId: ids.controller, direction: 'host-to-controller', usages: ['encrypt'] });
      return [{ session_id: ids.session, controller_id: ids.controller, host_id: ids.host, host_name: '아젠투지1호 MacBook Pro', host_public_key: hostPublicKey,
        host_public_key_fingerprint: await fingerprintRemoteControlRelayPublicKey(hostPublicKey), approval_state: 'pending', expires_at: new Date(Date.now() + 29 * DAY).toISOString() }];
    },
    portmgr_remote_control_session_status: () => [{ session_id: ids.session, controller_id: ids.controller, approval_state: 'approved', host_enabled: true,
      host_expires_at: new Date(Date.now() + 29 * DAY).toISOString(), session_expires_at: new Date(Date.now() + 29 * DAY).toISOString(), revoked_at: null, host_last_seen_at: now() }],
    portmgr_remote_control_controller_send_message: async args => {
      const envelope = { schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, messageId: args.p_message_id, sessionId: args.p_session_id,
        controllerId: args.p_controller_id, sequence: Number(args.p_sender_sequence), expiresAt: args.p_envelope_expires_at, nonce: args.p_nonce, ciphertext: args.p_ciphertext };
      if (state.accepted.has(envelope.messageId)) return [{ accepted: true }];
      state.accepted.add(envelope.messageId);
      await run(JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({ key: state.hostReceive, envelope }))));
      return [{ accepted: true }];
    },
    portmgr_remote_control_controller_receive_messages: args => state.deliveries.filter(d => d.relaySequence > Number(args.p_after_relay_seq))
      .map(({ relaySequence, envelope }) => ({ relay_seq: String(relaySequence), message_id: envelope.messageId, session_id: envelope.sessionId,
        controller_id: envelope.controllerId, sender_sequence: String(envelope.sequence), envelope_expires_at: envelope.expiresAt, nonce: envelope.nonce, ciphertext: envelope.ciphertext })),
    portmgr_remote_control_controller_ack_messages: () => 0,
  };
  /** The transit bucket, in memory: upload, sign, delete, list. */
  const storage = async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    state.storageCalls.push(`${method} ${url.pathname}`);
    const sign = `/storage/v1/object/sign/${BUCKET}/`, object = `/storage/v1/object/${BUCKET}/`;
    if (method === 'POST' && url.pathname.startsWith(sign)) {
      const path = decodeURIComponent(url.pathname.slice(sign.length));
      const token = `fixture.${crypto.randomUUID().replaceAll('-', '')}.sig`;
      state.tokens.set(path, token);
      return route.fulfill({ json: { signedURL: `/object/sign/${BUCKET}/${path}?token=${token}` } });
    }
    if (method === 'POST' && url.pathname.startsWith(object)) {
      const path = decodeURIComponent(url.pathname.slice(object.length));
      // Playwright leaves a multipart Blob out of postData: the page's own copy of what it sent (below) is the body.
      const body = state.sent.get(path) ?? multipartFile(request.postDataBuffer() ?? Buffer.alloc(0), request.headers()['content-type']);
      state.objects.set(path, body);
      state.uploads.push({ path, body });
      return route.fulfill({ json: { Key: `${BUCKET}/${path}`, Id: crypto.randomUUID() } });
    }
    if (method === 'DELETE' && url.pathname === `/storage/v1/object/${BUCKET}`) {
      const prefixes = request.postDataJSON()?.prefixes ?? [];
      for (const path of prefixes) { state.objects.delete(path); state.deletes.push(path); }
      return route.fulfill({ json: prefixes.map(name => ({ name })) });
    }
    if (method === 'POST' && url.pathname === `/storage/v1/object/list/${BUCKET}`) return route.fulfill({ json: [] });
    return route.fulfill({ status: 400, json: { message: 'unexpected storage call' } });
  };
  const pairingUrl = query => buildRemoteControlRelayPairingUrl(`${PAGE}/remote/`, {
    schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, hostId: ids.host, pairingId: ids.pairing,
    pairingSecret: Buffer.alloc(32, 7).toString('base64url'), hostPublicKey, expiresAt: new Date(Date.now() + DAY).toISOString(),
  }).replace('/remote/#', `/remote/${query}#`);
  return { rpc, storage, pairingUrl, state };
}

async function openPortal(browser, engineName, viewport, { touch = true, fixture = {} } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: touch, isMobile: touch && engineName === 'chromium', serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [], foreign = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => void dialog.accept());
  await page.addInitScript(() => {
    const b = v => btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const exp = Math.floor(Date.now() / 1000) + 86_400;
    const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
    const token = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub: user.id, role: 'authenticated', exp, email: user.email })}.c2ln`;
    if (!localStorage.getItem('portmgr-auth')) localStorage.setItem('portmgr-auth', JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: 86_400, expires_at: exp, refresh_token: 'fixture-refresh', user }));
  });
  const mac = await fixtureMac(fixture);
  // What the page actually uploads: Playwright does not expose a multipart Blob in postData, so the page hands the bytes it is
  // about to send (the FormData's Blob, as is) to the test before the request leaves. The request itself still goes out.
  await page.exposeFunction('__transitUpload', (pathname, b64) => { mac.state.sent.set(decodeURIComponent(pathname.replace(/^\/storage\/v1\/object\/portmgr-voc-transit\//, '')), Buffer.from(b64, 'base64')); });
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async function (input, init) {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const body = init?.body;
        if (/\/storage\/v1\/object\/portmgr-voc-transit\//.test(url) && !/\/object\/sign\//.test(url) && body instanceof FormData) {
          for (const [, value] of body.entries()) if (value instanceof Blob && value.size) {
            const bytes = new Uint8Array(await value.arrayBuffer());
            let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            await window.__transitUpload(new URL(url).pathname, btoa(text));
          }
        }
      } catch { /* a test instrument never stops the page */ }
      return original.apply(this, arguments);
    };
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    // A blob: URL carries the page's origin; it is the photo thumbnail, served by the browser itself.
    if (url.protocol === 'blob:' || url.protocol === 'data:') return route.continue();
    if (url.origin === PAGE) {
      const path = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
      if (!path.startsWith(root + '/')) return route.abort();
      const file = Bun.file(path);
      return await file.exists() ? route.fulfill({ body: Buffer.from(await file.arrayBuffer()), contentType: file.type }) : route.fulfill({ status: 404, body: '' });
    }
    if (url.hostname === SUPABASE) {
      if (url.pathname.startsWith('/storage/v1/')) return mac.storage(route);
      const rpcName = url.pathname.startsWith('/rest/v1/rpc/') ? url.pathname.slice('/rest/v1/rpc/'.length) : '';
      if (url.pathname === '/auth/v1/user') return route.fulfill({ json: { id: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com', aud: 'authenticated', role: 'authenticated' } });
      if (rpcName && mac.rpc[rpcName]) return route.fulfill({ json: await mac.rpc[rpcName](route.request().postDataJSON() ?? {}) });
      return route.fulfill({ json: [] });
    }
    foreign.push(url.origin); return route.abort();
  });
  await page.goto(mac.pairingUrl('?tab=workroom'));
  await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 30_000 });
  return { context, page, errors, foreign, mac };
}

const failures = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (check, timeout) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return true; await sleep(100); } return false; };
const press = locator => locator.evaluate(el => el.click());
const ROWS = '.remote-workroom-content .ai-terminal-session-list [role=tab]';
const VIEW = '[data-testid="workroom-session-view"]';
const openSession = async (page, id = SESSION) => {
  await page.locator(ROWS).first().waitFor({ timeout: 20_000 });
  await press(page.locator(`${ROWS}[data-session-id="${id}"]`));
  await page.locator(`${VIEW} textarea[aria-label="워크룸 입력"]`).waitFor({ timeout: 15_000 });
};
/** 「+」 → 사진 첨부 / 파일 첨부 → the file chooser the row opens. */
const pick = async (page, row, files) => {
  const plus = page.getByTestId('workroom-remote-attach');
  if ((await plus.getAttribute('aria-expanded')) !== 'true') await plus.click();
  const chooser = page.waitForEvent('filechooser', { timeout: 5_000 });
  await page.getByTestId(row).click();
  const opened = await chooser;
  await opened.setFiles(files);
  return opened;
};
const chips = page => page.locator('[data-testid="workroom-remote-attach-chips"] [data-chip-state]');
const states = async page => chips(page).evaluateAll(list => list.map(el => el.getAttribute('data-chip-state')));
const noPlain = (mac, fail) => {
  for (const upload of mac.state.uploads) {
    if (upload.body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) fail(`the upload at ${upload.path} holds a plaintext PNG header`);
    if (upload.body.includes(Buffer.from('%PDF'))) fail(`the upload at ${upload.path} holds a plaintext PDF header`);
  }
};

const cases = [];
const attachCase = (name, viewport, options, run) => cases.push({ name, viewport, options, run });

attachCase('inputs', { width: 390, height: 844 }, {}, async ({ page, fail }) => {
  await openSession(page);
  const inputs = await page.locator(`${VIEW} input[type=file]`).evaluateAll(list => list.map(el => ({ accept: el.getAttribute('accept'), multiple: el.multiple, testid: el.dataset.testid })));
  if (inputs.length !== 2) fail(`the session view has ${inputs.length} file inputs, not 2 (${JSON.stringify(inputs)})`);
  if (!inputs.some(i => i.accept === 'image/*' && i.multiple)) fail('no 사진 input with accept="image/*" multiple');
  if (!inputs.some(i => i.accept === null && i.multiple)) fail('no 파일 input without accept');
  const plus = page.getByTestId('workroom-remote-attach');
  if ((await plus.getAttribute('aria-label')) !== '첨부') fail(`「+」 aria-label is ${await plus.getAttribute('aria-label')}`);
  await plus.click();
  const rows = await page.locator('[data-testid="workroom-remote-attach-menu"] [role=menuitem]').allInnerTexts();
  if (!rows.some(text => text.includes('사진 첨부') && text.includes('사진 보관함·카메라'))) fail(`menu rows: ${JSON.stringify(rows)}`);
  if (!rows.some(text => text.includes('파일 첨부') && text.includes('10MB까지'))) fail(`menu rows: ${JSON.stringify(rows)}`);
  const photo = page.waitForEvent('filechooser', { timeout: 5_000 });
  await page.getByTestId('workroom-remote-attach-photo').click();
  const chooser = await photo;
  if (!chooser.isMultiple()) fail('the 사진 chooser does not allow several files');
  const accept = await chooser.element().getAttribute('accept');
  if (accept !== 'image/*') fail(`사진 opened the input with accept=${accept}`);
  await chooser.setFiles([]);
  // Escape closes the menu and gives focus back to 「+」.
  await plus.click();
  await page.keyboard.press('Escape');
  if (await page.getByTestId('workroom-remote-attach-menu').count()) fail('Escape did not close the menu');
  if (!(await plus.evaluate(el => el === document.activeElement))) fail('focus did not return to 「+」 after Escape');
});

attachCase('send', { width: 390, height: 844 }, {}, async ({ page, mac, fail }) => {
  await openSession(page);
  await pick(page, 'workroom-remote-attach-photo', [{ name: 'shot.png', mimeType: 'image/png', buffer: PNG }]);
  await pick(page, 'workroom-remote-attach-file', [{ name: '사양서.pdf', mimeType: 'application/pdf', buffer: PDF }]);
  if (!(await until(async () => JSON.stringify(await states(page)) === '["ready","ready"]', 20_000))) fail(`chips never became ready: ${JSON.stringify(await states(page))}`);
  const thumbs = await page.locator('[data-testid="workroom-remote-attach-chips"] .ai-terminal-image-chip img').evaluateAll(list => list.map(img => ({ src: img.src.slice(0, 5), loaded: img.complete && img.naturalWidth > 0 })));
  if (thumbs.length !== 1) fail(`expected one photo thumbnail, found ${thumbs.length}`);
  else if (!thumbs[0].loaded) fail(`the photo thumbnail did not load (${thumbs[0].src}…)`);
  const names = await page.locator('[data-testid="workroom-remote-attach-chips"] .ai-terminal-file-chip').allInnerTexts();
  if (!names.some(text => text.includes('사양서.pdf'))) fail(`the file chip does not name 사양서.pdf (${JSON.stringify(names)})`);
  noPlain(mac, fail);
  if (mac.state.received.length !== 2) fail(`the Mac received ${mac.state.received.length} items`);
  if (!mac.state.received.some(item => item.kind === 'file' && item.name === '사양서.pdf' && item.plain?.equals(PDF))) fail('the Mac did not get the PDF bytes back');
  if (!mac.state.received.some(item => item.kind === 'image' && item.plain && isImage(item.plain))) fail('the Mac did not get an image for the photo');
  // removed:false → the phone deletes what the Mac could not.
  if (!(await until(async () => mac.state.deletes.length >= 2, 5_000))) fail(`the phone deleted ${mac.state.deletes.length} transit objects, not 2`);
  const composer = page.locator(`${VIEW} textarea[aria-label="워크룸 입력"]`);
  await composer.fill('이 사진과 문서를 확인해 주세요');
  const send = page.locator(`${VIEW} .ai-terminal-command-field .ai-terminal-start`);
  if (await send.isDisabled()) fail('send is disabled with two ready attachments');
  await send.click();
  if (!(await until(async () => mac.state.submissions.length === 1, 10_000))) { fail('no submission reached the Mac'); return; }
  const [sent] = mac.state.submissions;
  if (sent.attachments.length !== 2) fail(`the submission named ${sent.attachments.length} attachment ids`);
  if (sent.text !== '이 사진과 문서를 확인해 주세요\r') fail(`the submission text was ${JSON.stringify(sent.text)} (the Mac appends the block itself)`);
  if (!(await until(async () => (await chips(page).count()) === 0, 5_000))) fail('the chips stayed after a written submission');
  if (await composer.inputValue()) fail('the composer kept the sent text');
});

attachCase('partial', { width: 390, height: 844 }, { fixture: { failAttach: 'broken.pdf' } }, async ({ page, mac, fail }) => {
  await openSession(page);
  await pick(page, 'workroom-remote-attach-file', [{ name: 'broken.pdf', mimeType: 'application/pdf', buffer: PDF }, { name: 'good.pdf', mimeType: 'application/pdf', buffer: PDF }]);
  if (!(await until(async () => (await states(page)).sort().join() === 'failed,ready', 20_000))) fail(`chips: ${JSON.stringify(await states(page))}`);
  const summary = page.getByTestId('workroom-remote-attach-summary');
  const text = await summary.innerText().catch(() => '');
  if (!text.includes('첨부 2개 중 1개를 전달하지 못했습니다')) fail(`summary: ${JSON.stringify(text)}`);
  if ((await summary.getAttribute('role')) !== 'status') fail('the summary is not a status line');
  const send = page.locator(`${VIEW} .ai-terminal-command-field .ai-terminal-start`);
  if (await send.isDisabled()) fail('send is disabled although the text and one attachment can go');
  await page.locator(`${VIEW} textarea[aria-label="워크룸 입력"]`).fill('된 것만 보내요');
  await send.click();
  if (!(await until(async () => mac.state.submissions.length === 1, 10_000))) { fail('no submission reached the Mac'); return; }
  if (mac.state.submissions[0].attachments.length !== 1) fail(`the submission named ${mac.state.submissions[0].attachments.length} ids, not the one ready`);
});

attachCase('old-mac', { width: 390, height: 844 }, { fixture: { features: BASE_FEATURES } }, async ({ page, mac, fail }) => {
  await openSession(page);
  const plus = page.getByTestId('workroom-remote-attach');
  await plus.waitFor({ timeout: 10_000 });
  if (!(await until(async () => (await plus.getAttribute('aria-label')) === '첨부 · Mac 앱 업데이트 필요', 8_000))) fail(`「+」 aria-label is ${await plus.getAttribute('aria-label')}`);
  if ((await plus.getAttribute('aria-disabled')) !== 'true') fail('「+」 is not aria-disabled on an older Mac');
  let opened = 0;
  page.on('filechooser', () => { opened += 1; });
  // aria-disabled is not "enabled" to Playwright's click; a finger taps it anyway.
  await press(plus);
  const menu = page.getByTestId('workroom-remote-attach-menu');
  const message = await menu.innerText().catch(() => '');
  if (!message.includes('Mac 앱 업데이트 필요')) fail(`the menu does not say why: ${JSON.stringify(message)}`);
  for (const row of ['workroom-remote-attach-photo', 'workroom-remote-attach-file']) {
    const el = page.getByTestId(row);
    if (!(await el.isDisabled())) fail(`${row} is enabled on an older Mac`);
    await el.click({ force: true }).catch(() => {});
  }
  await sleep(1_000);
  if (opened) fail(`${opened} file chooser(s) opened on an older Mac`);
  if (mac.state.storageCalls.length) fail(`storage was called: ${mac.state.storageCalls.join(', ')}`);
});

attachCase('sheet', { width: 390, height: 844 }, {}, async ({ page, mac, fail }) => {
  await page.locator(ROWS).first().waitFor({ timeout: 20_000 });
  await press(page.getByTestId('workroom-new-task'));
  const sheet = page.getByTestId('workroom-new-task-sheet');
  await sheet.waitFor({ timeout: 5_000 });
  const chooser = page.waitForEvent('filechooser', { timeout: 5_000 });
  await sheet.getByTestId('workroom-remote-attach-photo').click();
  await (await chooser).setFiles([{ name: 'screen.png', mimeType: 'image/png', buffer: PNG }]);
  if (!(await until(async () => JSON.stringify(await states(page)) === '["ready"]', 20_000))) fail(`sheet chip: ${JSON.stringify(await states(page))}`);
  await sheet.locator('textarea[aria-label="터미널에 전달할 작업"]').fill('이 화면을 보고 고쳐 주세요');
  await sheet.getByTestId('workroom-new-task-start').click();
  if (!(await until(async () => mac.state.submissions.length === 1, 10_000))) { fail('no launch reached the Mac'); return; }
  const [launch] = mac.state.submissions;
  if (!launch.launch) fail('the start was not a launch submission');
  if (launch.attachments.length !== 1) fail(`the launch named ${launch.attachments.length} ids`);
  if (launch.text !== '이 화면을 보고 고쳐 주세요\r') fail(`launch text ${JSON.stringify(launch.text)}`);
  if (!(await until(async () => await page.locator(VIEW).count() === 1 && (await page.locator(VIEW).getAttribute('data-session-id')) === mac.state.started[0]?.id, 10_000))) fail('the new session did not open full screen');
  if (await sheet.count()) fail('the sheet stayed open after the start');
});

// Chromium only, like tests/remote-phone-offline.e2e.mjs: Playwright's WebKit keeps navigator.onLine true under setOffline.
attachCase('offline', { width: 390, height: 844 }, { engines: ['chromium'] }, async ({ page, context, mac, fail }) => {
  await openSession(page);
  await context.setOffline(true);
  const before = mac.state.storageCalls.length;
  await pick(page, 'workroom-remote-attach-file', [{ name: 'later.pdf', mimeType: 'application/pdf', buffer: PDF }]);
  if (!(await until(async () => JSON.stringify(await states(page)) === '["waiting"]', 5_000))) fail(`offline chip: ${JSON.stringify(await states(page))}`);
  const label = await chips(page).first().innerText();
  if (!label.includes('연결되면 전달')) fail(`the waiting chip says ${JSON.stringify(label)}`);
  await sleep(1_500);
  if (mac.state.storageCalls.length !== before) fail(`storage was called while offline: ${mac.state.storageCalls.slice(before).join(', ')}`);
  await context.setOffline(false);
  if (!(await until(async () => JSON.stringify(await states(page)) === '["ready"]', 20_000))) fail(`after reconnecting: ${JSON.stringify(await states(page))}`);
});

attachCase('ipad-drop', { width: 1180, height: 820 }, {}, async ({ page, fail }) => {
  await openSession(page);
  const dock = page.getByTestId('workroom-session-view-dock');
  await dock.evaluate(async (el, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }));
    const at = el.getBoundingClientRect();
    for (const type of ['dragenter', 'dragover']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientX: at.left + 20, clientY: at.top + 20 }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__overlay = !!document.querySelector('[data-testid="workroom-remote-attach-drop"]');
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientX: at.left + 20, clientY: at.top + 20 }));
  }, [...PNG]);
  if (!(await page.evaluate(() => window.__overlay))) fail('no 「여기에 놓으면 첨부합니다」 overlay while dragging a file');
  if (!(await until(async () => JSON.stringify(await states(page)) === '["ready"]', 20_000))) fail(`dropped chip: ${JSON.stringify(await states(page))}`);
  // A text drag is not an attachment.
  await page.locator(`${VIEW} textarea[aria-label="워크룸 입력"]`).evaluate(el => {
    const data = new DataTransfer(); data.setData('text/plain', '그냥 글');
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await sleep(300);
  if ((await chips(page).count()) !== 1) fail('a text drop became an attachment');
});

attachCase('community', { width: 390, height: 844 }, { fixture: { community: true } }, async ({ page, fail }) => {
  await page.locator(ROWS).first().waitFor({ timeout: 20_000 });
  const tab = page.getByTestId('remote-workroom-device-tab-' + DEVICE_REF);
  await tab.waitFor({ timeout: 15_000 });
  await press(tab);
  await page.locator(`${ROWS}[data-session-id="${DEVICE_SESSION}"]`).waitFor({ timeout: 20_000 });
  await openSession(page, DEVICE_SESSION);
  const plus = page.getByTestId('workroom-remote-attach');
  if ((await plus.getAttribute('aria-disabled')) !== 'true') fail('「+」 is not disabled in another AgentsToZ\'s session');
  await press(plus);
  const text = await page.getByTestId('workroom-remote-attach-menu').innerText().catch(() => '');
  if (!text.includes('다른 아젠투지의 세션에는 아직 첨부할 수 없습니다')) fail(`the reason is missing: ${JSON.stringify(text)}`);
});

for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 428, height: 926 }, { width: 926, height: 428 }]) {
  attachCase(`layout-${size.width}x${size.height}`, size, {}, async ({ page, fail }) => {
    await openSession(page);
    await page.locator(`${VIEW} [data-testid="workroom-remote-attach-file-input"]`).setInputFiles([{ name: '아주긴파일이름_snake_case_without_any_break_0123456789abcdef.pdf', mimeType: 'application/pdf', buffer: PDF }]);
    await until(async () => JSON.stringify(await states(page)) === '["ready"]', 20_000);
    const plus = page.getByTestId('workroom-remote-attach');
    await plus.click();
    const m = await page.evaluate(W => {
      const box = el => el ? el.getBoundingClientRect() : null;
      const small = [...document.querySelectorAll('[data-testid="workroom-remote-attach"], [data-testid="workroom-remote-attach-menu"] [role=menuitem], [data-testid="workroom-remote-attach-chips"] button')]
        .map(el => ({ id: el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20), r: box(el) }))
        .filter(({ r }) => r && r.width > 0 && (r.width < 43.5 || r.height < 43.5)).map(({ id, r }) => `${id} ${Math.round(r.width)}x${Math.round(r.height)}`);
      const composer = document.querySelector('[data-testid="workroom-session-view"] textarea[aria-label="워크룸 입력"]');
      const menu = box(document.querySelector('[data-testid="workroom-remote-attach-menu"]'));
      return { small, font: parseFloat(getComputedStyle(composer).fontSize), doc: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        menu, vh: innerHeight, vw: W };
    }, size.width);
    if (m.small.length) fail(`targets under 44px: ${m.small.join(', ')}`);
    if (m.font < 16) fail(`the composer is ${m.font}px (iOS zooms below 16)`);
    if (m.doc > size.width + 1) fail(`the page is ${m.doc}px wide on a ${size.width}px screen`);
    if (!m.menu || m.menu.top < 0 || m.menu.bottom > m.vh + 1 || m.menu.left < 0 || m.menu.right > size.width + 1) fail(`the menu is off screen: ${JSON.stringify(m.menu)}`);
  });
}


// ── review w13 ────────────────────────────────────────────────────────────────────────────────────────
const sheetChips = page => page.locator('[data-testid="workroom-new-task-sheet"] [data-testid="workroom-remote-attach-chips"] [data-chip-state]');
const sheetStates = async page => sheetChips(page).evaluateAll(list => list.map(el => el.getAttribute('data-chip-state')));
const openSheet = async page => {
  if (await page.getByTestId('workroom-new-task-sheet').count()) return;
  if (await page.locator(VIEW).count()) { await press(page.getByTestId('workroom-session-view-back')); await sleep(400); }
  await press(page.getByTestId('workroom-new-task'));
  await page.getByTestId('workroom-new-task-sheet').waitFor({ timeout: 5_000 });
};
const sheetPhoto = async (page, name = 'screen.png') => {
  const sheet = page.getByTestId('workroom-new-task-sheet');
  const chooser = page.waitForEvent('filechooser', { timeout: 5_000 });
  await sheet.getByTestId('workroom-remote-attach-photo').click();
  await (await chooser).setFiles([{ name, mimeType: 'image/png', buffer: PNG }]);
};

attachCase('launch-settled-later', { width: 390, height: 844 }, { fixture: { launchUncertain: true } }, async ({ page, mac, fail }) => {
  await page.locator(ROWS).first().waitFor({ timeout: 20_000 });
  await openSheet(page);
  await sheetPhoto(page);
  if (!(await until(async () => JSON.stringify(await sheetStates(page)) === '["ready"]', 20_000))) { fail(`sheet chip never ready: ${JSON.stringify(await sheetStates(page))}`); return; }
  const sheet = page.getByTestId('workroom-new-task-sheet');
  await sheet.locator('textarea[aria-label="터미널에 전달할 작업"]').fill('이 화면을 보고 고쳐 주세요');
  await sheet.getByTestId('workroom-new-task-start').click();
  if (!(await until(async () => mac.state.started.length === 1 && (mac.state.statusCalls ?? 0) >= 1 && await page.getByTestId('workroom-launch-recovery').count() > 0, 15_000))) { fail('the lost launch did not leave its recovery banner'); return; }
  // Let the start finish with its uncertain answer (its own read-only status included) before the receipt changes.
  if (!(await until(async () => !(await page.getByTestId('workroom-new-task-start').innerText()).includes('시작 중'), 10_000))) fail('the start never finished');
  await sleep(1_500);
  // The CLI did start with the attachment block; now its receipt reads written.
  mac.state.receipts.get(mac.state.uncertainId).state = 'written';
  await press(page.getByTestId('workroom-launch-check').first());
  if (!(await until(async () => (await page.getByTestId('workroom-launch-recovery').count()) === 0, 10_000))) { fail('the launch never settled as written'); return; }
  await sleep(600);
  await openSheet(page);
  const left = await sheetStates(page);
  if (left.length) fail(`after the launch settled as written ${left.length} attachment chip(s) stayed ${JSON.stringify(left)}`);
  const start = page.getByTestId('workroom-new-task-start');
  if (!(await start.isDisabled())) {
    await start.click().catch(() => {});
    await sleep(1_500);
  }
  if (mac.state.submissions.filter(s => s.launch).length !== 1) fail(`a second launch went: ${JSON.stringify(mac.state.submissions.map(s => ({ text: s.text, attachments: s.attachments })))}`);
});

attachCase('ids-refused-at-begin', { width: 390, height: 844 }, { fixture: { refuseIds: true } }, async ({ page, mac, fail }) => {
  await openSession(page);
  await pick(page, 'workroom-remote-attach-file', [{ name: 'spec.pdf', mimeType: 'application/pdf', buffer: PDF }]);
  if (!(await until(async () => JSON.stringify(await states(page)) === '["ready"]', 20_000))) { fail(`chip never ready: ${JSON.stringify(await states(page))}`); return; }
  const composer = page.locator(`${VIEW} textarea[aria-label="워크룸 입력"]`);
  await composer.fill('이 문서를 확인해 주세요');
  const send = page.locator(`${VIEW} .ai-terminal-command-field .ai-terminal-start`);
  await send.click();
  if (!(await until(async () => (mac.state.refused ?? 0) === 1, 10_000))) { fail('the refusal never happened'); return; }
  if (!(await until(async () => JSON.stringify(await states(page)) === '["failed"]', 5_000))) fail(`the refused chip did not turn failed: ${JSON.stringify(await states(page))}`);
  await press(page.getByTestId('workroom-remote-attach-summary').getByRole('button', { name: '빼기' }));
  await sleep(500);
  if (await page.getByTestId('workroom-submission-recovery').count()) fail('a definitive begin refusal left the submission recovery banner');
  if (await composer.inputValue() !== '이 문서를 확인해 주세요') fail('the text was not kept');
  if (await send.isDisabled()) { fail('the kept text cannot be sent after the refused attachment was taken out'); return; }
  await send.click();
  if (!(await until(async () => mac.state.submissions.length === 1, 10_000))) fail('the text alone did not go');
  else if (mac.state.submissions[0].attachments.length) fail('the text went with attachments');
});

attachCase('launch-ids-refused', { width: 390, height: 844 }, { fixture: { refuseIds: true } }, async ({ page, mac, fail }) => {
  await page.locator(ROWS).first().waitFor({ timeout: 20_000 });
  await openSheet(page);
  await sheetPhoto(page);
  if (!(await until(async () => JSON.stringify(await sheetStates(page)) === '["ready"]', 20_000))) { fail('sheet chip never ready'); return; }
  const sheet = page.getByTestId('workroom-new-task-sheet');
  await sheet.locator('textarea[aria-label="터미널에 전달할 작업"]').fill('이 화면을 보고 고쳐 주세요');
  await sheet.getByTestId('workroom-new-task-start').click();
  if (!(await until(async () => (mac.state.refused ?? 0) === 1, 10_000))) { fail('the refusal never happened'); return; }
  if (!(await until(async () => JSON.stringify(await sheetStates(page)) === '["failed"]', 5_000))) fail(`the refused chip did not turn failed: ${JSON.stringify(await sheetStates(page))}`);
  await press(sheet.getByTestId('workroom-remote-attach-summary').getByRole('button', { name: '빼기' }));
  await sleep(500);
  const start = page.getByTestId('workroom-new-task-start');
  if (await page.getByTestId('workroom-new-task-blocked').count()) fail('a definitive refusal (nothing started) still blocks the start');
  if (await start.isDisabled()) { fail('start stays disabled although nothing started'); return; }
  await start.click();
  if (!(await until(async () => mac.state.started.length === 1, 10_000))) fail('the text alone did not start a session');
});

/** The session view's parts, measured; `reach` says whether a tap at an element's centre lands on it inside the view. */
const viewGeometry = page => page.evaluate(() => {
  const view = document.querySelector('[data-testid="workroom-session-view"]');
  const vb = view.getBoundingClientRect();
  const box = el => el ? el.getBoundingClientRect() : null;
  const reach = el => {
    if (!el) return 'missing';
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (y > vb.bottom || y < vb.top) return `clipped (centre ${Math.round(y)} outside ${Math.round(vb.top)}..${Math.round(vb.bottom)})`;
    const at = document.elementFromPoint(x, y); return at === el || el.contains(at) ? 'ok' : `covered by ${at?.className}`;
  };
  const q = s => view.querySelector(s);
  return { view: Math.round(vb.height), terminal: Math.round(box(q('[data-testid="workroom-session-view-scroll"]'))?.height ?? 0), dock: Math.round(box(q('[data-testid="workroom-session-view-dock"]'))?.height ?? 0),
    back: reach(q('[data-testid="workroom-session-view-back"]')), composer: reach(q('textarea[aria-label="워크룸 입력"]')), send: reach(q('.ai-terminal-command-field .ai-terminal-start')), plus: reach(q('[data-testid="workroom-remote-attach"]')) };
});
const keyboardUp = async (page, H, portrait) => {
  await page.getByLabel('워크룸 입력').focus();
  const height = H - Math.round(H * (portrait ? (H < 700 ? 0.46 : 0.42) : 0.49));
  await page.evaluate(h => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => h });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 0 });
    vv.dispatchEvent(new Event('resize')); vv.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize'));
  }, height);
  await page.waitForFunction(h => Math.abs((document.querySelector('[data-testid="workroom-session-view"]')?.getBoundingClientRect().height ?? 0) - h) < 1, height, { timeout: 5_000 }).catch(() => {});
  await sleep(300);
  return height;
};
for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 926, height: 428 }]) {
  attachCase(`dock-${size.width}x${size.height}`, size, { fixture: { failAttach: 'broken.pdf' } }, async ({ page, fail }) => {
    await openSession(page);
    const before = await viewGeometry(page);
    const input = page.locator(`${VIEW} [data-testid="workroom-remote-attach-file-input"]`);
    await input.setInputFiles([1, 2, 3].map(() => ({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: PDF })).concat([{ name: 'too-big-recording.mov', mimeType: 'video/quicktime', buffer: Buffer.alloc(11 * 1024 * 1024, 1) }]));
    await until(async () => (await states(page)).join() === 'failed,failed,failed', 20_000);
    await page.getByTestId('workroom-remote-attach-notice').waitFor({ timeout: 5_000 }).catch(() => {});
    await sleep(300);
    const after = await viewGeometry(page);
    if (after.terminal < before.terminal * 0.5) fail(`keyboard down: three failed files and a refusal leave the terminal ${after.terminal}px of the ${before.terminal}px it had (dock ${before.dock} → ${after.dock}px)`);
    // One failed and one ready with the keyboard up: the whole session view stays usable.
    // Folded in landscape (no role match for a hidden button): the summary's own 「빼기」, pressed directly.
    await page.locator('[data-testid="workroom-remote-attach-summary"] .ai-terminal-btn').filter({ hasText: '빼기' }).evaluate(el => el.click());
    await input.setInputFiles([{ name: 'broken.pdf', mimeType: 'application/pdf', buffer: PDF }, { name: 'good.pdf', mimeType: 'application/pdf', buffer: PDF }]);
    await until(async () => (await states(page)).sort().join() === 'failed,ready', 20_000);
    const visual = await keyboardUp(page, size.height, size.width < size.height);
    const kb = await viewGeometry(page);
    for (const key of ['back', 'composer', 'send', 'plus']) if (kb[key] !== 'ok') fail(`keyboard up (${visual}px visible): ${key} ${kb[key]} — dock ${kb.dock}px in a ${kb.view}px view`);
    if (kb.dock > kb.view * 0.75) fail(`keyboard up: the dock takes ${kb.dock}px of a ${kb.view}px view`);
  });
}

for (const size of [{ width: 320, height: 568 }, { width: 926, height: 428 }]) {
  attachCase(`keyboard-ready-${size.width}x${size.height}`, size, {}, async ({ page, fail }) => {
    await openSession(page);
    await keyboardUp(page, size.height, size.width < size.height);
    const before = await viewGeometry(page);
    // Ready chips while typing: nothing to act on, so they take no row of their own (「+」 carries the count).
    await page.locator(`${VIEW} [data-testid="workroom-remote-attach-file-input"]`).setInputFiles([{ name: 'a.pdf', mimeType: 'application/pdf', buffer: PDF }, { name: 'b.pdf', mimeType: 'application/pdf', buffer: PDF }]);
    await until(async () => JSON.stringify(await states(page)) === '["ready","ready"]', 20_000);
    await sleep(300);
    const after = await viewGeometry(page);
    if (after.terminal < before.terminal - 1) fail(`keyboard up: two ready chips took the terminal from ${before.terminal}px to ${after.terminal}px`);
    const label = await page.getByTestId('workroom-remote-attach').getAttribute('aria-label');
    if (!label?.includes('2')) fail(`「+」 does not say how many are attached: ${label}`);
  });
}

attachCase('notice-goes-with-the-send', { width: 390, height: 844 }, {}, async ({ page, mac, fail }) => {
  await openSession(page);
  const input = page.locator(`${VIEW} [data-testid="workroom-remote-attach-file-input"]`);
  await input.setInputFiles([{ name: 'ok.pdf', mimeType: 'application/pdf', buffer: PDF }]);
  await until(async () => JSON.stringify(await states(page)) === '["ready"]', 20_000);
  await input.setInputFiles([{ name: 'too-big-recording.mov', mimeType: 'video/quicktime', buffer: Buffer.alloc(11 * 1024 * 1024, 1) }]);
  const notice = page.getByTestId('workroom-remote-attach-notice');
  await notice.waitFor({ timeout: 5_000 });
  // It can be closed by hand, with a 44px target.
  const close = page.getByTestId('workroom-remote-attach-notice-close');
  const box = await close.boundingBox().catch(() => null);
  if (!box) fail('the refusal notice has no close button');
  else if (box.width < 43.5 || box.height < 43.5) fail(`the notice close button is ${Math.round(box.width)}x${Math.round(box.height)}`);
  // And it goes with a written send.
  await page.locator(`${VIEW} textarea[aria-label="워크룸 입력"]`).fill('보냅니다');
  await page.locator(`${VIEW} .ai-terminal-command-field .ai-terminal-start`).click();
  await until(async () => mac.state.submissions.length === 1, 10_000);
  await until(async () => (await chips(page).count()) === 0, 5_000);
  await sleep(800);
  if (await notice.count()) fail(`after the request was written the dock still says 「${await notice.innerText()}」`);
  // A refusal with no chip left: the close button clears it.
  await input.setInputFiles([{ name: 'too-big-recording.mov', mimeType: 'video/quicktime', buffer: Buffer.alloc(11 * 1024 * 1024, 1) }]);
  await notice.waitFor({ timeout: 5_000 });
  await press(page.getByTestId('workroom-remote-attach-notice-close'));
  await sleep(300);
  if (await notice.count()) fail('the close button did not clear the notice');
});

attachCase('offline-send-label', { width: 390, height: 844 }, { engines: ['chromium'] }, async ({ page, context, fail }) => {
  await openSession(page);
  await context.setOffline(true);
  await page.locator(`${VIEW} [data-testid="workroom-remote-attach-file-input"]`).setInputFiles([{ name: 'later.pdf', mimeType: 'application/pdf', buffer: PDF }]);
  await until(async () => JSON.stringify(await states(page)) === '["waiting"]', 5_000);
  await sleep(400);
  const send = page.locator(`${VIEW} .ai-terminal-command-field .ai-terminal-start`);
  const label = (await send.innerText()).replace(/\s+/g, ' ').trim();
  if (/전달하는 중/.test(label)) fail(`offline, the chip waits for the network but send says 「${label}」`);
  if (!label.includes('연결되면')) fail(`offline send label: 「${label}」`);
  await context.setOffline(false);
});

attachCase('desktop-inline-plus', { width: 1280, height: 800 }, { touch: false }, async ({ page, fail }) => {
  await page.locator(ROWS).first().waitFor({ timeout: 20_000 });
  await press(page.locator(`${ROWS}[data-session-id="${SESSION}"]`));
  const plus = page.getByTestId('workroom-remote-attach');
  await plus.waitFor({ timeout: 15_000 });
  const box = await plus.boundingBox();
  if (!box || box.width > 48) fail(`the inline 「+」 is ${box ? Math.round(box.width) : '?'}px wide`);
});

attachCase('sheet-marker', { width: 390, height: 844 }, {}, async ({ page, fail }) => {
  await page.locator(ROWS).first().waitFor({ timeout: 20_000 });
  await openSheet(page);
  await sheetPhoto(page);
  await until(async () => JSON.stringify(await sheetStates(page)) === '["ready"]', 20_000);
  await press(page.getByTestId('workroom-new-task-close'));
  await sleep(400);
  const opener = await page.getByTestId('workroom-new-task').innerText();
  if (!(await page.getByTestId('workroom-new-task-draft').count())) fail(`the closed sheet kept a photo but 「새 작업」 says only 「${opener.trim()}」`);
});

for (const engineName of engines) {
  const browser = await (engineName === 'webkit' ? webkit : chromium).launch();
  try {
    for (const item of cases) {
      if (only && !only.some(prefix => item.name.startsWith(prefix))) continue;
      if (item.options.engines && !item.options.engines.includes(engineName)) continue;
      const where = `${engineName} ${item.name}`;
      const fail = message => failures.push(`${where}: ${message}`);
      const portal = await openPortal(browser, engineName, item.viewport, item.options);
      try {
        await item.run({ ...portal, fail });
        if (portal.mac.state.issues.length) fail(`the fake Mac saw: ${portal.mac.state.issues.join(' | ')}`);
        if (portal.errors.length) fail(`page errors: ${portal.errors.join(' | ')}`);
        if (portal.foreign.length) fail(`requests left the page: ${[...new Set(portal.foreign)].join(', ')}`);
        if (shots) await portal.page.screenshot({ path: `${shots}/${engineName}-${item.name}.png` });
        console.log(`${where}: checked`);
      } catch (error) {
        fail(`step failed — ${String(error.message).split('\n')[0]}`);
        if (shots) await portal.page.screenshot({ path: `${shots}/${engineName}-${item.name}-failed.png` }).catch(() => {});
      } finally { await portal.context.close(); }
    }
  } finally { await browser.close(); }
}

if (failures.length) {
  console.error(`\n${failures.length} attachment failure(s):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('remote workroom attachments: all checks passed');
