// Phone layout of the remote portal (production audit 2026-10-16). Drives the real portal bundle with a real E2EE
// fake Mac behind a fake relay, in WebKit and Chromium at 320/390/428 portrait, 926×428 landscape and an iPad in landscape
// (1180×820 — a touch screen whose Workroom panel is wider than 760px), and checks:
//   - no surface makes the page wider than the DEVICE (Chromium's mobile emulation widens innerWidth to fit
//     overflowing content, which would hide exactly this bug, so the device width is the yardstick);
//   - 홈: a recent project with a long unbroken name (snake_case folder) stays inside its card;
//   - the QR scanner is the top layer: its buttons are hit where they are drawn and the voice dock cannot be tapped
//     through it;
//   - 원격 작업: every session tab is reachable without a hidden inner scroll box;
//   - tap targets on a phone (≤640px, or a coarse pointer = iPhone landscape, iPad) are at least 44px — the workroom panel,
//     the draft vault, the device tabs, the header VOC button, the pinned prompt chips, the error buttons;
//   - in landscape the terminal fits the screen above the bottom navigation;
//   - 「저장된 Codex 대화」 notices sit inside the card, not on its border;
//   - the 프로젝트 tab's device picker stays on screen and never covers the bottom navigation.
// Full-screen session view (w7, 2026-10-16) on a phone or touch screen (≤640px or a coarse pointer):
//   - the 원격 작업 overview lists the sessions as rows and never shows a terminal or a session composer inline;
//   - tapping a row opens the session over the whole viewport (above the portal header, the Mac tabs, the bottom
//     navigation and the voice dock), the terminal takes ≥55% of a portrait screen, the composer is docked at the bottom
//     and stays inside the visual viewport while a (simulated) keyboard shrinks it;
//   - 「←」, the browser back and Escape (outside the composer and the terminal) return to the overview with the session
//     still running and focus back on its row; opening twice adds one history entry, closing pops it, a tab switch
//     replaces it; 「작업 시작」 opens the new session the same way;
//   - offline, the view says so itself (it covers the portal's banner) and stays open;
//   - review fixes (w7 review): its buttons keep touch-action: manipulation; in landscape the terminal is no shorter than the
//     inline card was; input with the keyboard up claims the rows the view has without it and 원본 터미널 keeps the prompt in
//     sight; the @ menu stays inside the view with the keyboard up; Escape in the 「세션 종료」 dialog closes only the dialog;
//     forward after 「←」 reopens the view; and three separate cases — an automatic project-sweep retry keeps the open view,
//     a held input's error leaves the list once a list succeeds, and a 600px desktop window widened and narrowed again
//     closes the next view with one back;
//   - on a desktop browser (1280×900, a fine pointer) nothing changes: the terminal stays inline, no overlay, no history entry.
//
// Isolated: a portal build with fixture VITE_* values, every request routed by Playwright; no network, no 3001,
// no live Supabase, no Mac.
// Build: VITE_SUPABASE_URL=https://fixture-offline.supabase.co VITE_SUPABASE_ANON_KEY=<jwt-shaped> \
//          ./node_modules/.bin/vite build --config vite.portal.config.ts --outDir <dir>
// Run:   bun tests/remote-phone-layout.e2e.mjs <dir> [screenshotDir]
//        PHONE_LAYOUT_ENGINES=webkit PHONE_LAYOUT_SIZES=320x568,926x428 narrows the matrix (`none` skips it);
//        PHONE_LAYOUT_DESKTOP=0 skips the desktop case; PHONE_LAYOUT_REVIEW=0 skips the review cases and
//        PHONE_LAYOUT_REVIEW=held-input,sweep-retry runs only those.
import { chromium, webkit } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { REMOTE_CONTROL_PROTOCOL_VERSION } from '../src/remoteControlProtocol.ts';
import { buildRemoteControlRelayPairingUrl, REMOTE_CONTROL_RELAY_SCHEMA_VERSION } from '../src/remoteControlRelayContract.ts';
import {
  decryptRemoteControlRelayEnvelope, deriveRemoteControlRelaySessionKey, encryptRemoteControlRelayEnvelope,
  exportRemoteControlRelayPublicKey, fingerprintRemoteControlRelayPublicKey, generateRemoteControlRelayKeyPair,
  importRemoteControlRelayPublicKey,
} from '../src/remoteControlRelayCrypto.ts';

const root = resolve(process.argv[2] || 'dist-portal');
const shots = process.argv[3] || '';
if (shots) mkdirSync(shots, { recursive: true });
const engines = (process.env.PHONE_LAYOUT_ENGINES || 'webkit,chromium').split(',');
const sizes = (process.env.PHONE_LAYOUT_SIZES || '320x568,390x844,428x926,926x428,1180x820').split(',').filter(size => size !== 'none')
  .map(size => { const [width, height] = size.split('x').map(Number); return { width, height }; });

const PAGE = 'https://portal.test';
const SUPABASE = 'fixture-offline.supabase.co';
const ids = { host: '11111111-1111-4111-8111-111111111111', pairing: '22222222-2222-4222-8222-222222222222',
  session: '33333333-3333-4333-8333-333333333333', controller: '44444444-4444-4444-8444-444444444444' };
const encoder = new TextEncoder(), decoder = new TextDecoder();
const DAY = 86_400_000;
const now = () => new Date().toISOString();
const cid = c => c.repeat(42) + '1';
const OPS = cid('O'), LONG = cid('L'), BLOG = cid('B'), UNBROKEN = cid('U');
// The first four projects are the 홈 tab's recent rows; the unbroken snake_case name is the one that widened the page.
const projects = [
  { controlId: OPS, name: 'AgentsToZ-OPS', role: 'ops', kind: 'main', status: 'unknown', port: null, branch: 'main',
    actions: ['folder.open', 'agent.claude', 'agent.codex'] },
  { controlId: LONG, name: 'AgentsToZ_byCS · 휴대폰워크룸레이아웃점검용아주긴프로젝트이름', role: 'dev', kind: 'main', status: 'running',
    port: 4317, branch: 'codex/remote-workroom-layout_0123456789abcdef', actions: ['stop', 'folder.open', 'agent.claude', 'agent.codex'] },
  { controlId: BLOG, name: '블로그', kind: 'main', status: 'stopped', port: 5173, branch: 'main', actions: ['start', 'folder.open', 'agent.claude'] },
  { controlId: UNBROKEN, name: 'ExampleRepo_ab_super_long_unbreakable_identifier_0123456789abcdefghijklmnop', kind: 'main', status: 'stopped',
    port: 3000, actions: ['start', 'folder.open'] },
];
// Without `conversations-v1` the 「저장된 Codex 대화」 card shows its permanent 'Mac 앱 업데이트' notice.
const FEATURES = ['workspace-v1', 'workroom-history-v1', 'voc-v1', 'voc-inbox-v1', 'terminal-refs-v1', 'tester-v1', 'terminal-submission-v1', 'terminal-start-submission-v1'];
const SESS = { long: '55555555-5555-4555-8555-555555555551', ops: '55555555-5555-4555-8555-555555555552', blog: '55555555-5555-4555-8555-555555555553' };
const sessions = () => [
  { id: SESS.long, targetId: LONG, agent: 'claude', state: 'running', createdAt: new Date(Date.now() - 3_600_000).toISOString(), exitCode: null, cols: 100, rows: 28 },
  { id: SESS.ops, targetId: OPS, agent: 'codex', state: 'running', createdAt: new Date(Date.now() - 600_000).toISOString(), exitCode: null, cols: 100, rows: 28 },
  // An ended session keeps 「종료된 세션 보기」 in the list, as it does on a real Mac until dismissed.
  { id: SESS.blog, targetId: BLOG, agent: 'agy', state: 'exited', createdAt: new Date(Date.now() - 7_200_000).toISOString(), exitCode: 0, cols: 100, rows: 28 },
];
const screen = '> 휴대폰 화면에서 워크룸 레이아웃을 확인합니다.\r\n\r\n'
  + Array.from({ length: 18 }, (_, i) => `  line ${i + 1}: 출력 내용 ${'가나다라마바사 '.repeat(3)}\r\n`).join('') + '\r\n› ';
const community = () => ({ inside: true, roomId: '66666666-6666-4666-8666-666666666666', unread: 0,
  members: [{ name: '아젠투지1호 MacBook Pro', kind: 'ops', self: true }, { name: '아젠투지2호 Windows 데스크톱', kind: 'ops', self: false }],
  devices: [{ ref: '0123456789abcdef', name: '아젠투지2호 Windows 데스크톱', kind: 'ops' }, { ref: 'fedcba9876543210', name: '아젠투지3호 Mac mini 거실', kind: 'ops' }],
  messages: [], nextSeq: 1 });
const workroomStatus = sessionId => ({ sessionId, initialized: true, lastSavedAt: null, context: { usedPercent: 42, observedAt: now(), source: 'claude-statusline' },
  save: { requestId: null, state: 'idle', localSaved: false, backupSaved: false, message: '' } });

/** `pagedProjects`: the Mac lists two projects first and its second page fails once (RATE_LIMITED), then answers 3 s late —
 *  the portal's automatic sweep retries that page while a session may be open (w7 review). */
async function fixtureMac({ pagedProjects = false } = {}) {
  const keys = await generateRemoteControlRelayKeyPair();
  const hostPublicKey = await exportRemoteControlRelayPublicKey(keys.publicKey);
  // `failSend`: the relay send RPC fails at the network level (the phone keeps the request and sends it once later).
  // w11: `chunks` — the terminal output (a test appends to it); `exited` — sessions the Mac reports as ended;
  // `launchHide` — how many list answers after a launch leave the new session out; `submissionDelayMs` — a whole-request
  // submission answered late; `dropSubmission` — its answer is lost (the receive RPC fails from then on, `failReceive`).
  const state = { hostSequence: 0, deliveries: [], accepted: new Set(), started: [], inputs: [], reads: 0, resizes: [], failSend: false, page1: 0,
    chunks: [{ seq: 1, text: screen }], exited: new Set(), launchHide: 0, submissionDelayMs: 0, dropSubmission: false, failReceive: false,
    receipts: new Map(), submissions: [], hidden: new Map() };
  const reply = async message => {
    state.hostSequence += 1;
    state.deliveries.push({ relaySequence: state.hostSequence, envelope: await encryptRemoteControlRelayEnvelope({
      key: state.hostSend,
      metadata: { schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, messageId: crypto.randomUUID(), sessionId: ids.session,
        controllerId: ids.controller, sequence: state.hostSequence, expiresAt: new Date(Date.now() + 9 * 60_000).toISOString() },
      plaintext: encoder.encode(JSON.stringify(message)),
    }) });
  };
  const run = async message => {
    if (message.type === 'controller.pair') {
      return reply({ type: 'session.ready', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, sessionToken: 'T'.repeat(43), hostName: '아젠투지1호 MacBook Pro',
        expiresAt: new Date(Date.now() + 29 * DAY).toISOString(), idleExpiresAt: new Date(Date.now() + 29 * DAY).toISOString(),
        projects: pagedProjects ? projects.slice(0, 2) : projects, projectCount: projects.length, nextPage: pagedProjects ? 1 : null });
    }
    if (message.type === 'action.request') {
      const base = { type: 'action.result', actionId: message.actionId };
      if (message.action === 'protocol.capabilities' || message.action === 'protocol.capabilities.extended') return reply({ ...base, ok: true, supportedFeatures: FEATURES });
      if (message.action === 'projects.list' && pagedProjects) {
        if ((message.page ?? 0) === 0) return reply({ ...base, ok: true, projects: projects.slice(0, 2), page: 0, projectCount: projects.length, nextPage: 1 });
        state.page1 += 1;
        if (state.page1 === 1) return reply({ ...base, ok: false, error: { code: 'RATE_LIMITED', message: '잠시 뒤 다시 시도하세요.' } });
        setTimeout(() => void reply({ ...base, ok: true, projects: projects.slice(2), page: 1, projectCount: projects.length, nextPage: null }), 3_000);
        return;
      }
      if (message.action === 'projects.list') return reply({ ...base, ok: true, projects, page: message.page ?? 0, projectCount: projects.length, nextPage: null });
      if (message.action === 'workspace-roots.list') return reply({ ...base, ok: true, workspaceRoots: [] });
      if (message.action === 'ops.status') return reply({ ...base, ok: true, ops: { state: 'ready', backend: 'app-data', pendingCount: 0, lastSavedAt: null, syncState: null } });
      // 「실행」 is refused: the red alert with 「오류 정보 복사」 and the two VOC buttons is what is measured.
      return reply({ ...base, ok: false, error: { code: 'ACTION_NOT_ALLOWED', message: '이 테스트 Mac에는 없는 동작입니다.' } });
    }
    if (message.type === 'terminal.request') {
      const req = message.request; const op = req.operation;
      const ok = body => reply({ type: 'terminal.result', requestId: req.requestId, ok: true, body });
      const fail = error => reply({ type: 'terminal.result', requestId: req.requestId, ok: false, error });
      const all = [...sessions(), ...state.started].map(item => state.exited.has(item.id) ? { ...item, state: 'exited', exitCode: 0 } : item);
      const hiding = id => { const left = state.hidden.get(id) ?? 0; if (left > 0) state.hidden.set(id, left - 1); return left > 0; };
      const list = op === 'list' ? all.filter(item => !hiding(item.id)) : all;
      if (op === 'start') {
        // 「작업 시작」 without a request: a plain start, answered with the new session.
        const created = { id: `55555555-5555-4555-8555-5555555555${String(state.started.length).padStart(2, '0')}`, targetId: req.targetId, agent: req.agent,
          state: 'running', createdAt: now(), exitCode: null, cols: req.cols ?? 100, rows: req.rows ?? 28 };
        state.started.push(created);
        return ok({ session: created });
      }
      if (op === 'input') { state.inputs.push(req.data); return ok({ session: list.find(item => item.id === req.sessionId) ?? list[0] }); }
      if (op === 'list') return ok(req.capabilities ? { sessions: list, features: ['terminal-submission-v1', 'terminal-start-submission-v1'] } : { sessions: list });
      if (op === 'read') {
        state.reads += 1;
        const session = list.find(item => item.id === req.sessionId) ?? list[0];
        const chunks = state.chunks.filter(chunk => chunk.seq > (req.after ?? 0));
        return ok({ session, chunks, nextCursor: Math.max(req.after ?? 0, state.chunks.at(-1).seq), truncated: false, hasMore: false });
      }
      if (op === 'submission') {
        const sub = req.submission;
        const receipt = (id, extra = {}) => ({ id, storeId: 'store-fixture1', epoch: 'epoch-fixture1', revision: 1, state: 'written', ...extra });
        if (sub.phase === 'recent') return ok({ submissions: [] });
        if (sub.phase === 'status') { const found = state.receipts.get(sub.id); return found ? ok({ submission: found }) : fail('같은 호스트 저장소의 제출 기록을 확인하지 못했습니다. 자동 재전송하지 않습니다.'); }
        if (sub.phase !== 'single') return fail('이 테스트 Mac에는 없는 요청입니다.');
        state.submissions.push({ id: sub.id, launch: sub.launch ?? null, text: Buffer.from(sub.data, 'base64').toString() });
        if (sub.launch) {
          // A launch receipt names the new session; the answer carries no `session` (the panel finds it by listing).
          const created = { id: `55555555-5555-4555-8555-5555555556${String(state.started.length).padStart(2, '0')}`, targetId: sub.launch.targetId, agent: sub.launch.agent,
            state: 'running', createdAt: now(), exitCode: null, cols: sub.launch.cols, rows: sub.launch.rows };
          state.started.push(created);state.hidden.set(created.id, state.launchHide);
          const done = receipt(sub.id, { sessionId: created.id, targetId: created.targetId, agent: created.agent });
          state.receipts.set(sub.id, done);
          return ok({ submission: done });
        }
        const done = receipt(sub.id);
        state.receipts.set(sub.id, done);
        if (state.dropSubmission) { state.failReceive = true; return; }
        if (state.submissionDelayMs) { setTimeout(() => void ok({ submission: done }), state.submissionDelayMs); return; }
        return ok({ submission: done });
      }
      if (op === 'resize') { state.resizes.push({ sessionId: req.sessionId, cols: req.cols, rows: req.rows }); return ok({ session: list.find(item => item.id === req.sessionId) ?? list[0] }); }
      if (op === 'workspace') {
        const action = req.workspace.action;
        const ws = extra => ok({ kind: 'workspace', action, ...extra });
        if (action === 'workroom.status') return ws({ workroom: workroomStatus(req.workspace.sessionId ?? SESS.long) });
        if (action === 'history.list') return ws({ history: { records: [], nextBefore: null } });
        if (action === 'community.status' || action === 'community.read') return ws({ community: community() });
        if (action === 'voc.inbox') return ws({ vocInbox: { total: 0, unreadable: 0, items: [] } });
        return fail('이 테스트 Mac에는 없는 요청입니다.');
      }
      return fail('이 테스트 Mac에는 없는 요청입니다.');
    }
  };
  const rpc = {
    portmgr_is_member: () => true,
    // Four pinned prompts: three chips and 「+1」, with two short titles that must stay readable.
    portmgr_prompt_guides_read: () => ({ success: true, revision: 'r1', entries: [
      { id: 'g1', title: 'VOC 처리', body: 'VOC를 처리해 주세요', pinned: true, updatedAt: now() },
      { id: 'g2', title: '깃허브 최신화 후 테스트까지 한번에 진행하는 아주 긴 프롬프트 제목', body: '최신화', pinned: true, updatedAt: now() },
      { id: 'g3', title: '세션 기억하기', body: '기억', pinned: true, updatedAt: now() },
      { id: 'g4', title: '리뷰', body: '리뷰해 주세요', pinned: true, updatedAt: now() },
    ] }),
    portmgr_remote_control_claim_pairing: async args => {
      const peer = await importRemoteControlRelayPublicKey(args.p_controller_public_key);
      state.hostReceive = await deriveRemoteControlRelaySessionKey({ privateKey: keys.privateKey, peerPublicKey: peer,
        sessionId: ids.session, controllerId: ids.controller, direction: 'controller-to-host', usages: ['decrypt'] });
      state.hostSend = await deriveRemoteControlRelaySessionKey({ privateKey: keys.privateKey, peerPublicKey: peer,
        sessionId: ids.session, controllerId: ids.controller, direction: 'host-to-controller', usages: ['encrypt'] });
      return [{ session_id: ids.session, controller_id: ids.controller, host_id: ids.host, host_name: '아젠투지1호 MacBook Pro', host_public_key: hostPublicKey,
        host_public_key_fingerprint: await fingerprintRemoteControlRelayPublicKey(hostPublicKey), approval_state: 'pending',
        expires_at: new Date(Date.now() + 29 * DAY).toISOString() }];
    },
    // Approved at once: the SAS step is not what this test is about.
    portmgr_remote_control_session_status: () => [{ session_id: ids.session, controller_id: ids.controller, approval_state: 'approved',
      host_enabled: true, host_expires_at: new Date(Date.now() + 29 * DAY).toISOString(), session_expires_at: new Date(Date.now() + 29 * DAY).toISOString(),
      revoked_at: null, host_last_seen_at: now() }],
    portmgr_remote_control_controller_send_message: async args => {
      const envelope = { schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, messageId: args.p_message_id, sessionId: args.p_session_id,
        controllerId: args.p_controller_id, sequence: Number(args.p_sender_sequence), expiresAt: args.p_envelope_expires_at,
        nonce: args.p_nonce, ciphertext: args.p_ciphertext };
      if (state.accepted.has(envelope.messageId)) return [{ accepted: true }];
      state.accepted.add(envelope.messageId);
      await run(JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({ key: state.hostReceive, envelope }))));
      return [{ accepted: true }];
    },
    portmgr_remote_control_controller_receive_messages: args => state.deliveries
      .filter(delivery => delivery.relaySequence > Number(args.p_after_relay_seq))
      .map(({ relaySequence, envelope }) => ({ relay_seq: String(relaySequence), message_id: envelope.messageId, session_id: envelope.sessionId,
        controller_id: envelope.controllerId, sender_sequence: String(envelope.sequence), envelope_expires_at: envelope.expiresAt,
        nonce: envelope.nonce, ciphertext: envelope.ciphertext })),
    portmgr_remote_control_controller_ack_messages: () => 0,
  };
  const pairingUrl = query => buildRemoteControlRelayPairingUrl(`${PAGE}/remote/`, {
    schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, hostId: ids.host, pairingId: ids.pairing,
    pairingSecret: Buffer.alloc(32, 7).toString('base64url'), hostPublicKey, expiresAt: new Date(Date.now() + DAY).toISOString(),
  }).replace('/remote/#', `/remote/${query}#`);
  return { rpc, pairingUrl, state };
}

// The 프로젝트 tab reads synced tables; one device, no selection yet, so its device picker opens by itself.
const DEVICE = '77777777-7777-4777-8777-777777777777';
const tables = {
  portmgr_devices: [{ id: DEVICE, name: '아젠투지1호 MacBook Pro', last_push_at: now() }],
  portmgr_ports: [
    { id: 'p1', device_id: DEVICE, device_name: '아젠투지1호 MacBook Pro', name: '블로그', port: 5173, folder_path: '/Users/x/blog', favorite: false },
    { id: 'p2', device_id: DEVICE, device_name: '아젠투지1호 MacBook Pro', name: 'ExampleRepo_ab_super_long_unbreakable_identifier_0123456789abcdefghijklmnop', port: null, folder_path: '/Users/x/ExampleRepo', favorite: false },
  ],
  portmgr_portal_items: [], portmgr_portal_categories: [],
};

/** In-page measurements, installed before the app runs. Everything is measured against the device's own width
 *  (`W`), never innerWidth. */
function installLayoutProbe() {
  const shown = el => {
    if (!el.isConnected || el.closest('[hidden]')) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect(); return r.width > 0.5 && r.height > 0.5;
  };
  const name = el => {
    if (!el) return 'nothing';
    const id = el.getAttribute?.('data-testid');
    const text = (el.innerText || el.getAttribute?.('aria-label') || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 32);
    return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''}${text ? ` "${text}"` : ''}`;
  };
  const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const hitsSelf = el => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { ok: !!hit && (hit === el || el.contains(hit) || (el.labels && [...el.labels].some(label => label.contains(hit)))), hit: name(hit) };
  };
  const VIEW = '[data-testid="workroom-session-view"]';
  /** Where `selector` is drawn, what a finger at its centre hits: 'covered' (the session view), 'absent'/'hidden', or the
   *  element that took the tap. */
  const coveredBy = selector => {
    const el = [...document.querySelectorAll(selector)].find(shown);
    if (!el) return document.querySelector(selector) ? 'hidden' : 'absent';
    const r = el.getBoundingClientRect();
    const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    return hit?.closest(VIEW) ? 'covered' : name(hit);
  };
  window.__layout = {
    name, box, shown, hitsSelf, coveredBy,
    /** The session view and what it leaves of the page. */
    sessionView() {
      const view = document.querySelector(VIEW);
      if (!view) return null;
      const surface = view.querySelector('.ai-terminal-surface');
      const composer = view.querySelector('textarea[aria-label="워크룸 입력"]');
      return {
        view: box(view), surface: surface ? box(surface) : null, composer: composer && shown(composer) ? box(composer) : null,
        role: view.getAttribute('role'), modal: view.getAttribute('aria-modal'), title: view.querySelector('.ai-terminal-current-label')?.textContent ?? '',
        focusInside: view.contains(document.activeElement),
        header: coveredBy('.remote-header'), hostTabs: coveredBy('.remote-host-tabs'), nav: coveredBy('nav.workspace-navigation'), dock: coveredBy('[data-testid="voice-dock-call"]'),
      };
    },
    /** What the 원격 작업 overview shows of a session: rows, and no terminal or session composer of its own. */
    overview() {
      const content = document.querySelector('.remote-workroom-content');
      const rows = [...document.querySelectorAll('.remote-workroom-content .ai-terminal-session-list [role=tab]')].map(row => ({
        id: row.getAttribute('data-session-id'), text: row.textContent.replace(/\s+/g, ' ').trim(), height: row.getBoundingClientRect().height,
        focused: row === document.activeElement }));
      return { rows, active: name(document.activeElement), surface: !!content?.querySelector('.ai-terminal-surface'), xterm: document.querySelectorAll('.xterm').length,
        composer: document.querySelectorAll('textarea[aria-label="워크룸 입력"]').length, view: !!document.querySelector(VIEW) };
    },
    docWidth: () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    /** Controls under `selectors` smaller than 44px. A checkbox counts through its label (the label is what a finger
     *  hits); a native-looking select in desktop WebKit ignores min-height (iOS honours it), so it is only noted. */
    smallTargets(selectors, webkitEngine) {
      const small = [], noted = [];
      const seen = new Set();
      for (const scope of selectors.flatMap(selector => [...document.querySelectorAll(selector)])) {
        for (const el of scope.querySelectorAll('button, select, summary, [role=tab], input[type=checkbox], input[type=radio], a[href]')) {
          if (seen.has(el) || !shown(el) || el.matches('.sr-only, .xterm-helper-textarea')) continue;
          seen.add(el);
          if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') continue;
          const r = el.getBoundingClientRect();
          if (el.matches('input[type=checkbox], input[type=radio]')) {
            const label = el.closest('label');
            const l = label?.getBoundingClientRect();
            if (!l || l.height < 43.5 || r.width < 19.5) small.push(`${name(el)} ${Math.round(r.width)}x${Math.round(r.height)} in a ${l ? Math.round(l.height) : 0}px label`);
            continue;
          }
          if (webkitEngine && el.tagName === 'SELECT') {
            const style = getComputedStyle(el);
            if ((style.appearance || style.webkitAppearance) !== 'none') { noted.push(`${name(el)} ${Math.round(r.height)}px (native select)`); continue; }
          }
          if (r.height < 43.5 || r.width < 43.5) small.push(`${name(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      return { small, noted };
    },
  };
}

async function openPortal(browser, engineName, viewport, { touch = true, fixture = {} } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: touch, isMobile: touch && engineName === 'chromium', serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [], foreign = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => void dialog.accept());
  await page.addInitScript(installLayoutProbe);
  await page.addInitScript(() => {
    const b = v => btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const exp = Math.floor(Date.now() / 1000) + 86_400;
    const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
    const token = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub: user.id, role: 'authenticated', exp, email: user.email })}.c2ln`;
    if (!localStorage.getItem('portmgr-auth')) localStorage.setItem('portmgr-auth', JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: 86_400, expires_at: exp, refresh_token: 'fixture-refresh', user }));
  });
  const mac = await fixtureMac(fixture);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === PAGE) {
      const path = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
      if (!path.startsWith(root + '/')) return route.abort();
      const file = Bun.file(path);
      return await file.exists() ? route.fulfill({ body: Buffer.from(await file.arrayBuffer()), contentType: file.type }) : route.fulfill({ status: 404, body: '' });
    }
    if (url.hostname === SUPABASE) {
      const rpcName = url.pathname.startsWith('/rest/v1/rpc/') ? url.pathname.slice('/rest/v1/rpc/'.length) : '';
      if (url.pathname === '/auth/v1/user') return route.fulfill({ json: { id: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com', aud: 'authenticated', role: 'authenticated' } });
      if (rpcName === 'portmgr_remote_control_controller_send_message' && mac.state.failSend) return route.abort('failed');
      if (rpcName === 'portmgr_remote_control_controller_receive_messages' && mac.state.failReceive) return route.abort('failed');
      if (rpcName && mac.rpc[rpcName]) return route.fulfill({ json: await mac.rpc[rpcName](route.request().postDataJSON() ?? {}) });
      const table = url.pathname.startsWith('/rest/v1/') ? url.pathname.slice('/rest/v1/'.length) : '';
      if (route.request().method() === 'GET' && tables[table]) return route.fulfill({ json: tables[table] });
      return route.fulfill({ json: [] });
    }
    foreign.push(url.origin); return route.abort();
  });
  await page.goto(mac.pairingUrl('?tab=workroom'));
  await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 30_000 });
  return { context, page, errors, foreign, mac };
}

const failures = [], notes = [];
const press = locator => locator.evaluate(el => el.click());
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (check, timeout) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return true; await sleep(100); } return false; };
const ROWS = '.remote-workroom-content .ai-terminal-session-list [role=tab]';
/** On a phone the pane switches and the frequent prompts sit behind the overview's 「더 보기」 (w11): opens it when closed. */
const openMore = async page => {
  const toggle = page.getByTestId('remote-workroom-more-toggle');
  if (await toggle.count() && await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) === 'false') await press(toggle);
};
/** The 원격 작업 overview with its session rows: ?tab=workroom opens it by itself (w11); older builds needed the pane button. */
const enterWorkroom = async page => {
  try { await page.locator(ROWS).first().waitFor({ timeout: 8_000 }); return; } catch { /* an older build: the pane button */ }
  await openMore(page);
  await press(page.getByRole('button', { name: '워크룸 이어가기', exact: true }));
  await page.locator(ROWS).first().waitFor({ timeout: 20_000 });
};
/** The one start control: the 「새 작업」 sheet's (w11), else — an older build — the toolbar's with its request box. */
const openNewTask = async page => {
  const entry = page.getByTestId('workroom-new-task');
  if (await entry.count()) {
    await press(entry);
    const sheet = page.getByTestId('workroom-new-task-sheet');
    await sheet.waitFor({ timeout: 5_000 });
    return { scope: sheet, start: sheet.locator('.ai-terminal-start') };
  }
  const scope = page.locator('.remote-workroom-content');
  return { scope, start: scope.locator('.ai-terminal-toolbar .ai-terminal-start'), legacy: true };
};

for (const engineName of engines) {
  const browser = await (engineName === 'webkit' ? webkit : chromium).launch();
  try {
    for (const viewport of sizes) {
      const W = viewport.width, H = viewport.height;
      const where = `${engineName} ${W}×${H}`;
      const { context, page, errors, foreign, mac } = await openPortal(browser, engineName, viewport);
      const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
      const phone = W <= 640 || coarse;
      const fail = message => failures.push(`${where}: ${message}`);
      const VIEW = '[data-testid="workroom-session-view"]';
      const view = page.locator(VIEW);
      // WebKit captures the whole page; Chromium the viewport (its full-page capture re-applies device metrics).
      const shot = async step => { if (shots) await page.screenshot({ path: `${shots}/${engineName}-${W}x${H}-${step}.png`, fullPage: engineName === 'webkit' && !(await view.count()) }); };
      // A close-up of one region for a human look (WebKit only — a Chromium element capture drops the touch emulation).
      const region = async (step, selector) => {
        if (!shots || engineName !== 'webkit') return;
        const target = page.locator(selector).last();
        if (await target.count()) await target.screenshot({ path: `${shots}/${engineName}-${W}x${H}-${step}-region.png` }).catch(() => {});
      };
      const pageWidth = async step => {
        const width = await page.evaluate(() => window.__layout.docWidth());
        if (width > W + 0.5) fail(`${step}: the page is ${width}px wide on a ${W}px screen`);
      };
      const targets = async (step, selectors) => {
        if (!phone) return;
        const { small, noted } = await page.evaluate(([list, webkitEngine]) => window.__layout.smallTargets(list, webkitEngine), [selectors, engineName === 'webkit']);
        if (small.length) fail(`${step}: tap targets under 44px: ${small.join(' · ')}`);
        for (const item of noted) if (!notes.includes(`${engineName} ${item}`)) notes.push(`${engineName} ${item}`);
      };
      const step = async (label, run) => {
        try { await run(); }
        catch (error) { fail(`${label}: step failed — ${String(error.message).split('\n')[0]}`); }
        await shot(label).catch(() => {});
      };

      await step('inbox-first', async () => {
        // ?tab=workroom opens the Workroom panel itself (w11, S4.2): its session rows come without a tap.
        try { await page.locator(ROWS).first().waitFor({ timeout: 15_000 }); }
        catch { fail('inbox-first: ?tab=workroom did not open the Workroom (no session rows without a tap)'); return; }
        if (!phone) return;
        // Inbox first (w11, critique 34): the running sessions come right under the Mac tabs, then one 「새 작업」; everything
        // else is folded behind 「더 보기」. They started 2.3 screens down under ~30 controls.
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(600);
        const m = await page.evaluate(sel => {
          const row = [...document.querySelectorAll(sel)].find(el => window.__layout.shown(el) && el.textContent.includes('실행 중'));
          const r = row?.getBoundingClientRect();
          const navTop = document.querySelector('nav.workspace-navigation')?.getBoundingClientRect().top ?? innerHeight;
          const starts = [...document.querySelectorAll('.remote-workroom-content .ai-terminal-start')].filter(window.__layout.shown).length;
          const entries = [...document.querySelectorAll('[data-testid="workroom-new-task"]')].filter(window.__layout.shown).length;
          const hit = row ? window.__layout.hitsSelf(row) : { ok: false, hit: 'no row' };
          return { top: r ? r.top + scrollY : null, bottom: r ? r.bottom + scrollY : null, navTop, starts, entries, hit };
        }, ROWS);
        notes.push(`${where} inbox-first: first running row ${Math.round(m.top)}–${Math.round(m.bottom)}px (navigation from ${Math.round(m.navTop)}px)`);
        if (W === 390 && H === 844) {
          if (m.top === null || m.bottom > m.navTop) fail(`inbox-first: the first running session row is at ${Math.round(m.top)}–${Math.round(m.bottom)}px, not on the first screen above the navigation (${Math.round(m.navTop)}px)`);
          else if (!m.hit.ok) fail(`inbox-first: the first running session row is covered by ${m.hit.hit}`);
        }
        if (m.starts) fail(`inbox-first: the overview shows ${m.starts} start buttons (the 「새 작업」 sheet holds the only one)`);
        if (m.entries !== 1) fail(`inbox-first: ${m.entries} 「새 작업」 entries in the overview (one expected)`);
        await shot('inbox-first');
      });

      await step('header', async () => {
        if (phone) await openMore(page);
        await page.getByTestId('prompt-guide-pinned-copy').first().waitFor({ timeout: 15_000 });
        await pageWidth('header');
        await targets('header', ['.remote-header', '.workspace-prompt-guides']);
        await region('header', '.workspace-prompt-guides');
        // Pinned chips keep short titles whole and stay tappable (they used to shrink evenly to 「V…」).
        const chips = await page.evaluate(() => [...document.querySelectorAll('[data-testid="prompt-guide-pinned-copy"]')].map(el => {
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const r = el.getBoundingClientRect();
          return { title: el.getAttribute('aria-label').replace(/ 프롬프트 복사$/, ''), width: Math.round(r.width), truncated: el.scrollWidth > el.clientWidth + 1, hit: window.__layout.hitsSelf(el) };
        }));
        for (const chip of chips) {
          if (chip.title.length <= 8 && chip.truncated) fail(`header: the pinned chip 「${chip.title}」 is cut to ${chip.width}px`);
          if (!chip.hit.ok) fail(`header: the pinned chip 「${chip.title}」 is covered by ${chip.hit.hit}`);
        }
      });

      await step('alert', async () => {
        if (phone) await openMore(page);
        await press(page.getByRole('button', { name: '프로젝트 관리', exact: true }));
        const card = page.getByTestId('remote-project-card').filter({ hasText: '블로그' });
        await card.waitFor({ timeout: 15_000 });
        await press(card.getByRole('button', { name: '실행', exact: true }));
        await page.locator('.remote-alert').waitFor({ timeout: 15_000 });
        await page.getByTestId('error-voc-compose').first().waitFor();
        await pageWidth('alert');
        await targets('alert', ['.remote-alert']);
        await region('alert', '.remote-alert');
      });

      await step('workroom', async () => {
        await press(page.getByRole('button', { name: '워크룸 이어가기', exact: true }));
        await page.locator('.ai-terminal-session-list [role=tab]').nth(1).waitFor({ timeout: 15_000 });
        await page.getByTestId('remote-conversation-host-update-required').waitFor({ timeout: 15_000 });
        await page.getByTestId('remote-workroom-device-tab-0123456789abcdef').waitFor({ timeout: 15_000 });
        await page.waitForTimeout(800);
        await pageWidth('workroom');
        await targets('workroom', ['.remote-workroom-content']);
        // Every session tab can be seen and tapped without a scroll box inside the page (it was capped at 160px).
        const list = await page.evaluate(() => {
          const el = document.querySelector('.ai-terminal-session-list'); const r = el.getBoundingClientRect();
          const tabs = [...el.querySelectorAll('[role=tab]')].map(tab => ({ name: window.__layout.name(tab), inside: tab.getBoundingClientRect().bottom <= r.bottom + 0.5 }));
          return { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, tabs };
        });
        if (list.scrollHeight > list.clientHeight + 1) fail(`workroom: the session list scrolls inside itself (${list.clientHeight}px shown of ${list.scrollHeight}px)`);
        for (const tab of list.tabs) if (!tab.inside) fail(`workroom: ${tab.name} is cut off by the session list`);
        // 「저장된 Codex 대화」: its notice's text reads inside the card, not on the card's border and rounded corners
        // (the text's own boxes, not the paragraph's, which may carry the padding).
        const inset = await page.evaluate(() => {
          const card = document.querySelector('[data-testid="remote-codex-conversation-console"]').getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(document.querySelector('[data-testid="remote-conversation-host-update-required"]'));
          const note = range.getBoundingClientRect();
          return { left: Math.round(note.left - card.left), right: Math.round(card.right - note.right), bottom: Math.round(card.bottom - note.bottom) };
        });
        if (Math.min(inset.left, inset.right, inset.bottom) < 8) fail(`workroom: the Codex card notice touches the card (inset ${JSON.stringify(inset)})`);
        await region('workroom', '.ai-terminal-session-list');
        await region('codex-card', '[data-testid="remote-codex-conversation-console"]');
      });

      const portrait = H > W;
      const firstRow = page.locator(ROWS).first();

      await step('new-task', async () => {
        if (!phone) return;
        // One 「새 작업」 sheet (w11, S4.5): project, AI, bypass, the first request and exactly ONE start button; hints behind 「?」.
        const entry = page.getByTestId('workroom-new-task');
        if (!(await entry.count())) { fail('new-task: no 「새 작업」 entry in the overview'); return; }
        await press(entry);
        const sheet = page.getByTestId('workroom-new-task-sheet');
        await sheet.waitFor({ timeout: 5_000 });
        await page.waitForTimeout(400);
        const starts = () => page.evaluate(() => [...document.querySelectorAll('.ai-terminal-start')].filter(window.__layout.shown).map(window.__layout.name));
        const hints = () => page.evaluate(() => { const el = document.querySelector('[data-testid="workroom-new-task-sheet"]');
          return { panel: !!el.querySelector('[data-testid="workroom-new-task-hints"]'), text: /IME|바이트|\$ 스킬|로 시작합니다/.test(el.innerText) }; });
        let list = await starts();
        if (list.length !== 1) fail(`new-task: ${list.length} start buttons on screen with the sheet open (${list.join(' · ')}), one expected`);
        let h = await hints();
        if (h.panel || h.text) fail('new-task: hints are shown before 「?」 is tapped');
        // w11 review: the voice dock is under the sheet, so the OPS line says to close the sheet before 「아젠투지 호출」.
        const opsOption = sheet.locator('[data-testid="ai-terminal-project-ops"]');
        if (await opsOption.count()) {
          await sheet.getByLabel('터미널 프로젝트').selectOption(await opsOption.getAttribute('value'));
          const opsLine = sheet.getByTestId('workroom-ops-input-hint');
          const text = await opsLine.count() ? await opsLine.innerText() : '';
          if (!text) fail('new-task: no OPS line in the sheet with the OPS project chosen');
          else if (/아젠투지 호출/.test(text) && !/이 창을 닫고/.test(text)) fail(`new-task: the sheet's OPS line points at 「아젠투지 호출」, which the sheet covers: ${text}`);
        } else fail('new-task: no OPS project to choose in the sheet');
        for (const label of ['터미널 프로젝트', '터미널 AI', '터미널에 전달할 작업']) if (!(await sheet.getByLabel(label).count())) fail(`new-task: the sheet has no 「${label}」`);
        if (!(await sheet.getByTestId('workroom-launch-options').count())) fail('new-task: the sheet has no bypass chip');
        // The fixture Mac lists no CLI accounts: the account picker is not shown (only with more than one account).
        if (await sheet.getByTestId('cli-account-picker').count()) fail('new-task: the account picker shows without a second account');
        await sheet.getByLabel('터미널에 전달할 작업').fill('새 작업 요청');
        list = await starts();
        if (list.length !== 1) fail(`new-task: with a request typed there are ${list.length} start buttons (${list.join(' · ')})`);
        await pageWidth('new-task');
        await targets('new-task', ['[data-testid="workroom-new-task-sheet"]']);
        // iOS zooms a page when a field under 16px is focused; the sheet is outside .remote-shell and restates the floor.
        const small = await page.evaluate(() => [...document.querySelectorAll('[data-testid="workroom-new-task-sheet"] :is(input, select, textarea)')]
          .filter(window.__layout.shown).filter(el => parseFloat(getComputedStyle(el).fontSize) < 16).map(el => `${window.__layout.name(el)} ${getComputedStyle(el).fontSize}`));
        if (small.length) fail(`new-task: fields under 16px (iOS zooms on focus): ${small.join(' · ')}`);
        // The sheet is a layer over the portal: the header, the bottom navigation and the voice dock are under it.
        const covered = await page.evaluate(() => ['.remote-header', 'nav.workspace-navigation', '[data-testid="voice-dock-call"]'].map(sel => {
          const el = [...document.querySelectorAll(sel)].find(window.__layout.shown); if (!el) return null;
          const r = el.getBoundingClientRect(); const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
          const hit = document.elementFromPoint(x, y); return hit?.closest('[data-testid="workroom-new-task-sheet"]') ? null : `${sel} (a tap hits ${window.__layout.name(hit)})`; }).filter(Boolean));
        for (const item of covered) fail(`new-task: the sheet does not cover ${item}`);
        await shot('new-task-open');
        await press(sheet.getByTestId('workroom-new-task-help'));
        h = await hints();
        if (!h.panel) fail('new-task: 「?」 did not show the hints');
        await shot('new-task-help');
        await sheet.getByLabel('터미널에 전달할 작업').fill('');
        await press(sheet.getByTestId('workroom-new-task-close'));
        await sheet.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => fail('new-task: the sheet did not close'));
      });

      await step('new-task-back', async () => {
        if (!phone) return;
        // w11 review: the sheet takes one history entry like the session view — the web portal's back (Safari's edge swipe)
        // closes it and stays on 원격 작업 with the draft kept; 「닫기」 pops the entry.
        const tabNow = () => page.evaluate(() => document.querySelector('main[data-workspace-tab]')?.getAttribute('data-workspace-tab'));
        const { scope: sheet } = await openNewTask(page);
        const field = sheet.getByLabel('터미널에 전달할 작업');
        await field.fill('뒤로 가도 남는 초안');
        if (!(await page.evaluate(() => !!history.state?.workroomNewTask))) fail('new-task-back: opening the sheet took no history entry');
        await page.goBack({ waitUntil: 'commit' });
        try { await sheet.waitFor({ state: 'detached', timeout: 5_000 }); } catch { fail('new-task-back: back did not close the sheet'); }
        await sleep(400);
        if ((await tabNow()) !== 'workroom') fail(`new-task-back: back left 원격 작업 for ${await tabNow()}`);
        const again = (await openNewTask(page)).scope;
        const kept = await again.getByLabel('터미널에 전달할 작업').inputValue();
        if (kept !== '뒤로 가도 남는 초안') fail(`new-task-back: the draft did not survive the back (${JSON.stringify(kept)})`);
        await again.getByLabel('터미널에 전달할 작업').fill('');
        await press(again.getByTestId('workroom-new-task-close'));
        await again.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => fail('new-task-back: 「닫기」 did not close the sheet'));
        await sleep(400);
        if (await page.evaluate(() => !!history.state?.workroomNewTask)) fail('new-task-back: 「닫기」 left the sheet entry current');
        if ((await tabNow()) !== 'workroom') fail(`new-task-back: 「닫기」 left 원격 작업 for ${await tabNow()}`);
      });

      await step('dock-clear', async () => {
        if (!phone) return;
        // Outside the session view the voice dock and the bottom navigation float over the page (critique 35): whatever the
        // page scrolls to the bottom edge (a focus, a scrollIntoView) must land above them, never under them.
        const blocked = await page.evaluate(async () => {
          const out = [];
          const targets = [...document.querySelectorAll('.remote-workroom-content .ai-terminal-session-list [role=tab], [data-testid="workroom-new-task"], [data-testid="remote-workroom-more-toggle"]')].filter(window.__layout.shown);
          for (const el of targets) {
            el.scrollIntoView({ block: 'end' });
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const r = el.getBoundingClientRect();
            for (const fx of [0.1, 0.5, 0.9]) {
              const hit = document.elementFromPoint(r.left + r.width * fx, Math.min(innerHeight - 1, r.top + r.height / 2));
              if (!hit || !(hit === el || el.contains(hit))) { out.push(`${window.__layout.name(el)} @${fx} under ${window.__layout.name(hit)}`); break; }
            }
          }
          window.scrollTo(0, 0);
          return out;
        });
        for (const item of blocked) fail(`dock-clear: ${item}`);
      });
      // Counts this page's own history calls (a browser back is not one of them).
      await page.evaluate(() => {
        const calls = window.__historyCalls = { push: 0, replace: 0, back: 0 };
        const push = history.pushState.bind(history), replace = history.replaceState.bind(history), back = history.back.bind(history);
        history.pushState = (...args) => { calls.push += 1; return push(...args); };
        history.replaceState = (...args) => { calls.replace += 1; return replace(...args); };
        history.back = () => { calls.back += 1; return back(); };
      });
      const historyCalls = () => page.evaluate(() => ({ ...window.__historyCalls, state: history.state }));
      const viewClosed = async (label, timeout = 5_000) => {
        try { await view.waitFor({ state: 'detached', timeout }); return true; }
        catch { fail(`${label}: the session view did not close`); return false; }
      };

      await step('session', async () => {
        if (!phone) return;
        const before = await historyCalls();
        // A real tap: the row is on top and takes it.
        await firstRow.click({ timeout: 10_000 });
        await view.waitFor({ timeout: 10_000 });
        await page.getByTestId('workroom-command-composer').waitFor({ timeout: 15_000 });
        await page.waitForTimeout(800);
        await pageWidth('session');
        await targets('session', [VIEW]);
        const g = await page.evaluate(() => window.__layout.sessionView());
        if (Math.abs(g.view.left) > 0.5 || Math.abs(g.view.top) > 0.5 || Math.abs(g.view.width - W) > 0.5 || Math.abs(g.view.height - H) > 0.5)
          fail(`session: the session view spans ${JSON.stringify(g.view)}, not the ${W}×${H} screen`);
        if (g.role !== 'dialog' || g.modal !== 'true') fail(`session: the session view is role=${g.role} aria-modal=${g.modal}`);
        if (!g.focusInside) fail('session: focus did not move into the session view');
        if (!g.title.trim()) fail('session: the session view does not name its session');
        for (const [part, hit] of [['the portal header', g.header], ['the Mac tabs', g.hostTabs], ['the bottom navigation', g.nav], ['the voice dock', g.dock]])
          if (!['covered', 'absent', 'hidden'].includes(hit)) fail(`session: ${part} is not covered (a tap there hits ${hit})`);
        if (!g.surface) fail('session: no terminal in the session view');
        // ≥55% of a portrait phone from 375pt up; the 320pt SE keeps two bar rows and the dock in 568pt, so ≥50% there.
        else if (portrait && g.surface.height < (W >= 375 ? 0.55 : 0.5) * H) fail(`session: the terminal is ${Math.round(g.surface.height)}px of a ${H}px screen (under ${W >= 375 ? 55 : 50}%)`);
        // Landscape: no less than the inline card it replaced (248px of a 428pt iPhone, 400px on an iPad) — w7 review.
        else if (!portrait && g.surface.height < Math.min(Math.round(0.58 * H), 400)) fail(`session: the terminal is ${Math.round(g.surface.height)}px tall in landscape (under ${Math.min(Math.round(0.58 * H), 400)}px)`);
        // The view is outside .remote-shell: its buttons keep `touch-action: manipulation`, or iOS reads a fast second
        // tap on a key (↓ ↓, Enter Enter) as a double-tap zoom and drops it (w7 review).
        const zoomable = await page.evaluate(sel => [...document.querySelectorAll(`${sel} button`)].filter(window.__layout.shown)
          .filter(el => getComputedStyle(el).touchAction !== 'manipulation').map(el => window.__layout.name(el)), VIEW);
        if (zoomable.length) fail(`session: ${zoomable.length} buttons allow double-tap zoom (touch-action is not manipulation): ${zoomable.slice(0, 5).join(' · ')}`);
        if (!g.composer) fail('session: no composer in the session view');
        else {
          if (g.composer.top < -0.5 || g.composer.bottom > H + 0.5) fail(`session: the composer is off screen (${Math.round(g.composer.top)}–${Math.round(g.composer.bottom)} of ${H})`);
          if (g.surface && g.composer.top < g.surface.bottom - 0.5) fail('session: the composer is not docked below the terminal');
        }
        const after = await historyCalls();
        if (after.push - before.push !== 1) fail(`session: opening pushed ${after.push - before.push} history entries (one expected)`);
        if (!after.state?.workroomSessionView) fail('session: the open view has no history entry of its own');
        if (mac.state.reads === 0) fail('session: the open session view never read the terminal');
        // The composer's IME and @/# notes sit behind one 「?」 (w11, S4.5).
        if (/IME/.test(await view.innerText())) fail('session: the IME hint is shown before 「?」 is tapped');
        const help = view.getByTestId('workroom-command-help');
        if (!(await help.count())) fail('session: no 「?」 for the composer hints');
        else {
          await press(help);
          if (!/IME/.test(await view.innerText())) fail('session: 「?」 did not show the IME hint');
          await press(help);
        }
        await region('session', VIEW);
      });

      await step('session-tools-reach', async () => {
        if (!phone) return;
        // On the narrowest phone, the action used to squeeze into vertical text and make the toolbar taller than the
        // terminal. The row can scroll, but every action still has to be usable by a real pointer, including its popup.
        const unfinished = view.getByTestId('workroom-unfinished-work');
        const settings = view.getByTestId('workroom-settings');
        const field = view.getByLabel('워크룸 입력');
        if (!(await unfinished.count()) || !(await settings.count())) { fail('session-tools-reach: expected session actions are missing'); return; }
        const submissionsBefore = mac.state.submissions.length;
        try {
          await unfinished.scrollIntoViewIfNeeded();
          const box = await unfinished.evaluate(el => {
            const r = el.getBoundingClientRect(), parent = el.closest('.ai-terminal-view-controls').getBoundingClientRect();
            return { left: r.left, right: r.right, parentLeft: parent.left, parentRight: parent.right, whiteSpace: getComputedStyle(el).whiteSpace };
          });
          if (box.left < box.parentLeft - 1 || box.right > box.parentRight + 1 || box.whiteSpace !== 'nowrap')
            fail(`session-tools-reach: unfinished action is clipped or wraps after scrolling (${JSON.stringify(box)})`);
          await unfinished.click({ timeout: 5_000 });
          if (!(await field.inputValue()).trim()) fail('session-tools-reach: tapping unfinished work did not prepare a draft');
          if (mac.state.submissions.length !== submissionsBefore) fail('session-tools-reach: preparing a draft sent a request');
          await field.fill('');
          await field.blur();
          await settings.locator('summary').scrollIntoViewIfNeeded();
          await settings.locator('summary').click({ timeout: 5_000 });
          const panel = settings.locator('.workroom-settings-body');
          await panel.waitFor({ state: 'visible', timeout: 5_000 });
          const hit = await panel.evaluate(el => window.__layout.hitsSelf(el));
          if (!hit.ok) fail(`session-tools-reach: settings popup is clipped or covered by ${hit.hit}`);
          await settings.locator('summary').click({ timeout: 5_000 });
          if (await settings.evaluate(el => el.open)) fail('session-tools-reach: tapping settings again did not close it');
          if (!(await view.isVisible())) fail('session-tools-reach: closing settings also closed the session');
          // A hardware Escape immediately after opening the popover must close that popover, not the Workroom.
          await settings.locator('summary').click({ timeout: 5_000 });
          await page.keyboard.press('Escape');
          if (!(await view.isVisible())) {
            fail('session-tools-reach: immediate Escape closed the session instead of only settings');
            await firstRow.click({ timeout: 5_000 });
            await view.waitFor({ timeout: 5_000 });
          } else if (await settings.evaluate(el => el.open)) {
            fail('session-tools-reach: immediate Escape left settings open');
            await settings.evaluate(el => { el.open = false; });
          }
          // iOS touch can leave the composer focused while the native summary opens. Dispatch in one turn, before
          // the details toggle's deferred React effect can install its document listener.
          await page.waitForTimeout(50);
          const inputsBefore = mac.state.inputs.length;
          const outsideFocus = await view.evaluate(el => {
            const details = el.querySelector('.workroom-settings'), input = el.querySelector('textarea[aria-label="워크룸 입력"]');
            input.focus();
            details.querySelector('summary').click();
            const wasOpen = details.open, focusStayed = document.activeElement === input;
            const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            input.dispatchEvent(key);
            return { wasOpen, focusStayed, stillOpen: details.open, prevented: key.defaultPrevented };
          });
          await page.waitForTimeout(50);
          if (!outsideFocus.wasOpen || !outsideFocus.focusStayed || outsideFocus.stillOpen || !outsideFocus.prevented || !(await view.isVisible()))
            fail(`session-tools-reach: Escape with composer focus did not close only settings (${JSON.stringify(outsideFocus)})`);
          if (mac.state.inputs.length !== inputsBefore) fail('session-tools-reach: Escape with settings open reached the CLI');
          await settings.evaluate(el => { el.open = false; }).catch(() => {});
          await page.waitForTimeout(50);
          const composing = await view.evaluate(el => {
            const details = el.querySelector('.workroom-settings'), input = el.querySelector('textarea[aria-label="워크룸 입력"]');
            input.focus();
            details.querySelector('summary').click();
            const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true });
            input.dispatchEvent(key);
            const result = { stillOpen: details.open, prevented: key.defaultPrevented };
            details.open = false;
            return result;
          });
          if (!composing.stillOpen || composing.prevented) fail(`session-tools-reach: composing Escape was intercepted (${JSON.stringify(composing)})`);
        } catch (error) {
          fail(`session-tools-reach: action or settings popup was unreachable (${String(error.message).split('\n')[0]})`);
          await settings.evaluate(el => { el.open = false; }).catch(() => {});
          await field.fill('').catch(() => {});
        }
      });

      await step('readable-bottom', async () => {
        if (!phone) return;
        // 읽기 보기 sticks to the bottom (w11, S4.1): within 40px of it new output follows; scrolled up, a 「새 출력 ↓」 pill
        // appears and tapping it scrolls down.
        const pre = view.getByTestId('workroom-readable-screen');
        try { await pre.waitFor({ timeout: 5_000 }); } catch { fail('readable-bottom: no 읽기 보기'); return; }
        await page.waitForFunction(sel => !document.querySelector(sel)?.textContent.includes('불러오는 중'), `${VIEW} [data-testid="workroom-readable-screen"]`, { timeout: 5_000 }).catch(() => {});
        const metrics = () => pre.evaluate(el => ({ top: el.scrollTop, client: el.clientHeight, height: el.scrollHeight, text: el.textContent }));
        // What a person has to see: the last line that actually says something — the prompt, or the newest output — inside
        // the box. The remote screen is a fixed grid, so its text ends with blank rows; scrolling to the raw bottom would
        // show those instead of the prompt, and asserting the implementation's own number would prove nothing about
        // what is visible. This measures the real range of the last non-whitespace character.
        const lastLineInView = () => pre.evaluate(el => {
          const node = el.firstChild, text = node?.textContent ?? '', end = text.search(/\s*$/u);
          if (!node || node.nodeType !== 3 || end <= 0) return { ok: true, why: 'the screen has no text yet' };
          const range = el.ownerDocument.createRange();
          range.setStart(node, end - 1); range.setEnd(node, end);
          const line = range.getBoundingClientRect(), box = el.getBoundingClientRect();
          const tail = text.slice(Math.max(0, end - 24), end).replace(/\s+/gu, ' ').trim();
          return { ok: line.bottom <= box.bottom + 2 && line.top >= box.top - 2, tail,
            line: Math.round(line.top) + '–' + Math.round(line.bottom), box: Math.round(box.top) + '–' + Math.round(box.bottom) };
        });
        const inView = async what => { const v = await lastLineInView(); if (!v.ok) fail(`readable-bottom: ${what} — 「${v.tail}」 sits at ${v.line}, outside the view ${v.box}`); return v.ok; };
        const push = () => { const seq = mac.state.chunks.length + 1; mac.state.chunks.push({ seq, text: Array.from({ length: 4 }, (_, i) => `\r\n  new ${seq}-${i + 1}: 새 출력 ${'라마바사아자 '.repeat(5)}`).join('') + '\r\n\r\n› ' }); };
        const changed = async before => until(async () => (await metrics()).text !== before, 8_000);
        // Enough output to scroll: a bigger font when the screen is roomy (iPad).
        let bigger = 0;
        for (; bigger < 6 && (await metrics()).height <= (await metrics()).client + 60; bigger++) { await press(view.getByTestId('workroom-font-increase')); await page.waitForTimeout(150); }
        let m = await metrics();
        if (m.height <= m.client + 60) { notes.push(`${where} readable-bottom: the screen does not scroll at this size`); return; }
        await inView('읽기 보기 opened without its last line in sight');
        push();
        if (!(await changed(m.text))) { fail('readable-bottom: new output never reached 읽기 보기'); return; }
        await page.waitForTimeout(150);
        m = await metrics();
        await inView('new output arrived while at the bottom, and its last line is not in sight');
        await pre.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
        await page.waitForTimeout(150);
        push();
        if (!(await changed(m.text))) { fail('readable-bottom: the second output never arrived'); return; }
        await page.waitForTimeout(150);
        m = await metrics();
        if (m.top > 4) fail(`readable-bottom: scrolled up, new output moved the view to ${Math.round(m.top)}`);
        const pill = view.getByTestId('workroom-readable-new-output');
        if (!(await pill.count())) fail('readable-bottom: no 「새 출력 ↓」 pill after new output while scrolled up');
        else {
          const hit = await pill.evaluate(el => window.__layout.hitsSelf(el));
          if (!hit.ok) fail(`readable-bottom: the pill is covered by ${hit.hit}`);
          await shot('readable-pill');
          await pill.click({ timeout: 5_000 });
          await page.waitForTimeout(400);
          await inView('tapping 「새 출력 ↓」 did not bring the newest output into sight');
          if (await pill.count()) fail('readable-bottom: the pill stayed after it scrolled down');
        }
        for (let i = 0; i < bigger; i++) await press(view.getByTestId('workroom-font-decrease'));
      });

      await step('session-keyboard', async () => {
        if (!phone) return;
        // Playwright has no on-screen keyboard: the visual viewport is shrunk as iOS does when the keyboard opens
        // (offsetTop > 0 is iOS scrolling the layout viewport to keep the focused field in view).
        const composer = page.getByLabel('워크룸 입력');
        // The rows the view's terminal has without a keyboard: the size a phone input should claim (w7 review).
        const restingRows = await page.evaluate(sel => document.querySelector(`${sel} .xterm-rows`)?.children.length ?? 0, VIEW);
        await composer.focus();
        // An iPhone keyboard with its suggestion bar: ~40% of a portrait screen, ~46% of the 568pt SE, ~half in landscape.
        const keyboard = Math.round(H * (portrait ? (H < 700 ? 0.46 : 0.42) : 0.49));
        for (const offsetTop of [0, 24]) {
          const height = H - keyboard - offsetTop;
          await page.evaluate(([height, top]) => {
            const vv = window.visualViewport;
            Object.defineProperty(vv, 'height', { configurable: true, get: () => height });
            Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => top });
            vv.dispatchEvent(new Event('resize')); vv.dispatchEvent(new Event('scroll'));
          }, [height, offsetTop]);
          await page.waitForFunction(([height, top]) => {
            const r = document.querySelector('[data-testid="workroom-session-view"]')?.getBoundingClientRect();
            return !!r && Math.abs(r.height - height) < 1 && Math.abs(r.top - top) < 1;
          }, [height, offsetTop], { timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(200);
          const g = await page.evaluate(() => window.__layout.sessionView());
          const top = offsetTop, bottom = offsetTop + height;
          if (Math.abs(g.view.top - top) > 1 || Math.abs(g.view.bottom - bottom) > 1)
            fail(`session-keyboard: with a ${keyboard}px keyboard the visible area is ${top}–${bottom}, the view spans ${Math.round(g.view.top)}–${Math.round(g.view.bottom)}`);
          if (!g.composer || g.composer.top < top - 0.5 || g.composer.bottom > bottom + 0.5)
            fail(`session-keyboard: the focused composer (${g.composer ? `${Math.round(g.composer.top)}–${Math.round(g.composer.bottom)}` : 'missing'}) is outside the visible ${top}–${bottom}`);
          if (!(await composer.evaluate(el => el === document.activeElement))) fail('session-keyboard: the composer lost focus');
          // Typing @ (always with the keyboard up) opens the project menu above the composer: it stays inside the view and
          // its first candidate can be tapped (in landscape it used to start above the screen — w7 review).
          await composer.fill('@');
          try {
            await page.locator(`${VIEW} [data-testid="workroom-mention-menu"] [role=option]`).first().waitFor({ timeout: 5_000 });
            const m = await page.evaluate(sel => {
              const view = document.querySelector(sel).getBoundingClientRect();
              const menu = document.querySelector(`${sel} [data-testid="workroom-mention-menu"]`).getBoundingClientRect();
              return { top: menu.top, bottom: menu.bottom, viewTop: view.top, first: window.__layout.hitsSelf(document.querySelector(`${sel} [data-testid="workroom-mention-menu"] [role=option]`)) };
            }, VIEW);
            if (m.top < m.viewTop - 0.5) fail(`session-keyboard: with a ${keyboard}px keyboard the @ menu starts at ${Math.round(m.top)}, above the view's top ${Math.round(m.viewTop)}`);
            if (!m.first.ok) fail(`session-keyboard: the first @ candidate cannot be tapped (a tap there hits ${m.first.hit})`);
            await shot(`session-keyboard-menu-${offsetTop}`);
          } catch (error) { fail(`session-keyboard: typing @ did not open the project menu (${String(error.message).split('\n')[0]})`); }
          await composer.fill('');
          await shot(`session-keyboard-${offsetTop}`);
        }
        // Input with the keyboard up claims the view's size WITHOUT the keyboard: a claim taken from the shrunken view left the
        // Mac's CLI at ~12 rows, and the readable view then showed 12 host rows in a full screen (w7 review). The first input of
        // this run (a key) makes the claim.
        const resizes = mac.state.resizes.length;
        await press(view.locator('.ai-terminal-key').filter({ hasText: /^1$/ }));
        const claimed = await (async () => { for (let i = 0; i < 50; i++) { if (mac.state.resizes.length > resizes) return mac.state.resizes.at(-1); await page.waitForTimeout(100); } return null; })();
        if (!claimed) fail('session-keyboard: input with the keyboard up claimed no size');
        else if (claimed.rows < restingRows) fail(`session-keyboard: input with the keyboard up claimed ${claimed.cols}×${claimed.rows}, fewer rows than the view's ${restingRows} without the keyboard`);
        // 원본 터미널 keeps that size; the rows under the keyboard are clipped from the top, so the prompt stays in sight.
        await press(view.getByTestId('workroom-readable-toggle'));
        await page.waitForTimeout(400);
        const prompt = await page.evaluate(sel => {
          const view = document.querySelector(sel), screen = view.querySelector('.ai-terminal-screen').getBoundingClientRect();
          const row = [...view.querySelectorAll('.xterm-rows > div')].reverse().find(r => r.textContent.includes('›'))?.getBoundingClientRect();
          return row ? { top: row.top, bottom: row.bottom, screenTop: screen.top, screenBottom: screen.bottom } : null;
        }, VIEW);
        if (!prompt) fail('session-keyboard: 원본 터미널 shows no prompt row');
        else if (prompt.top < prompt.screenTop - 1 || prompt.bottom > prompt.screenBottom + 1) fail(`session-keyboard: in 원본 터미널 with the keyboard up the prompt row (${Math.round(prompt.top)}–${Math.round(prompt.bottom)}) is outside the terminal (${Math.round(prompt.screenTop)}–${Math.round(prompt.screenBottom)})`);
        await shot('session-keyboard-original');
        await press(view.getByTestId('workroom-readable-toggle'));
        // 터미널 직접 입력 is a toggle of its own (the only key with aria-pressed). The number keys send a choice and
        // nothing else — they never switch the session into direct input — so turn it on here, check the state the
        // person sees, and turn it back off, because the steps below type in the composer again.
        const rawToggle = view.locator('.ai-terminal-key[aria-pressed]');
        if ((await rawToggle.getAttribute('aria-pressed')) !== 'false') fail('session-keyboard: the number key left 터미널 직접 입력 on');
        await press(rawToggle);
        if ((await rawToggle.getAttribute('aria-pressed')) !== 'true') fail('session-keyboard: 터미널 직접 입력 did not turn on');
        else if (!/직접 입력 끄기/.test((await rawToggle.innerText()).trim())) fail(`session-keyboard: direct input is on but the key still says 「${(await rawToggle.innerText()).trim()}」`);
        await press(rawToggle);
        if ((await rawToggle.getAttribute('aria-pressed')) !== 'false') fail('session-keyboard: 직접 입력 끄기 did not turn direct input off');
        await page.evaluate(() => { const vv = window.visualViewport; delete vv.height; delete vv.offsetTop; vv.dispatchEvent(new Event('resize')); vv.dispatchEvent(new Event('scroll')); });
        await page.waitForFunction(H => Math.abs(document.querySelector('[data-testid="workroom-session-view"]').getBoundingClientRect().height - H) < 1, H, { timeout: 5_000 })
          .catch(() => fail('session-keyboard: the view did not grow back when the keyboard closed'));
        await composer.blur();
      });

      await step('session-offline', async () => {
        if (!phone) return;
        // The view covers the portal's offline banner, so it says it itself; the CLI and the view stay.
        await context.setOffline(true);
        await page.evaluate(() => window.dispatchEvent(new Event('offline')));
        try { await page.getByTestId('workroom-session-view-offline').waitFor({ timeout: 5_000 }); }
        catch { fail('session-offline: the session view does not say the phone is offline'); }
        await shot('session-offline-shown');
        await context.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        try { await page.getByTestId('workroom-session-view-offline').waitFor({ state: 'detached', timeout: 5_000 }); }
        catch { fail('session-offline: the offline line stayed after the network came back'); }
        if (!(await view.count())) fail('session-offline: going offline closed the session view');
      });

      await step('draft-vault', async () => {
        await page.getByTestId('workroom-draft-vault-settings').evaluate(el => { el.open = true; });
        await page.getByTestId('workroom-draft-vault-toggle').waitFor();
        await targets('draft-vault', ['[data-testid="workroom-draft-queue"]']);
        await region('draft-vault', '[data-testid="workroom-draft-queue"]');
      });

      await step('session-escape', async () => {
        if (!phone) return;
        if (!(await view.count())) { fail('session-escape: the session view is not open'); return; }
        const switcher = view.getByTestId('workroom-session-switcher');
        if (await switcher.count()) {
          await switcher.focus();
          await page.keyboard.press('Escape');
          if (!(await view.count())) { fail('session-escape: Escape in the session select closed the view'); return; }
        }
        // Escape in the 「세션 종료」 dialog (a hardware keyboard) closes that dialog only, not the whole view (w7 review).
        await press(view.getByRole('button', { name: '세션 종료', exact: true }));
        const exitDialog = page.locator('dialog.workroom-exit-dialog[open]');
        try {
          await exitDialog.waitFor({ timeout: 5_000 });
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
          if (await exitDialog.count()) fail('session-escape: Escape did not close the 「세션 종료」 dialog');
          if (!(await view.count())) {
            fail('session-escape: Escape in the 「세션 종료」 dialog closed the whole session view');
            await firstRow.click({ timeout: 10_000 }); await view.waitFor({ timeout: 10_000 });
          }
        } catch (error) { fail(`session-escape: the 「세션 종료」 dialog did not open (${String(error.message).split('\n')[0]})`); }
        // Escape while typing goes to the CLI (it stops a running turn) and keeps the view.
        const composer = page.getByLabel('워크룸 입력');
        await composer.focus();
        const inputs = mac.state.inputs.length;
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);
        if (!(await view.count())) fail('session-escape: Escape in the composer closed the view');
        if (!mac.state.inputs.slice(inputs).includes('\x1b')) fail('session-escape: Escape in the composer did not reach the CLI');
        // Escape anywhere else in the view closes it, and focus goes back to the session's row.
        await view.focus();
        await page.keyboard.press('Escape');
        if (!(await viewClosed('session-escape'))) return;
        // Focus moves on the frame after the view closes.
        await page.waitForFunction(() => window.__layout.overview().rows.some(row => row.focused), null, { timeout: 2_000 }).catch(() => {});
        const o = await page.evaluate(() => window.__layout.overview());
        if (!o.rows.some(row => row.focused)) fail(`session-escape: focus did not return to the session row (focus is on ${o.active})`);
      });

      await step('session-back', async () => {
        if (!phone) return;
        await firstRow.click({ timeout: 10_000 });
        await view.waitFor({ timeout: 10_000 });
        const before = await historyCalls();
        await page.getByTestId('workroom-session-view-back').click({ timeout: 5_000 });
        if (!(await viewClosed('session-back'))) return;
        await page.waitForTimeout(300);
        const o = await page.evaluate(() => ({ ...window.__layout.overview(), state: history.state }));
        const after = await historyCalls();
        if (o.surface || o.xterm || o.composer) fail(`session-back: the overview shows a terminal or a session composer (${JSON.stringify({ surface: o.surface, xterm: o.xterm, composer: o.composer })})`);
        const row = o.rows.find(item => item.id === SESS.long);
        if (!row || !row.text.includes('실행 중')) fail(`session-back: the session is not listed as running (${JSON.stringify(o.rows)})`);
        if (!row?.focused) fail(`session-back: focus did not return to the session row (focus is on ${o.active})`);
        if (after.back - before.back !== 1 || after.push !== before.push) fail(`session-back: 「←」 made ${after.back - before.back} back and ${after.push - before.push} push calls (one back expected)`);
        if (o.state?.workroomSessionView) fail('session-back: the view\'s history entry is still the current one');
        // The overview asks only for the session list: no terminal reads while no session is open.
        const reads = mac.state.reads;
        await page.waitForTimeout(2_500);
        if (mac.state.reads !== reads) fail(`session-back: the overview kept reading the terminal (${mac.state.reads - reads} reads in 2.5s)`);
        await pageWidth('overview');
        await targets('overview', ['.remote-workroom-content']);
        await shot('overview');
      });

      await step('session-forward', async () => {
        if (!phone) return;
        // Forward after 「←」 lands on the view's own entry: the view opens again on it, not a step that shows nothing (w7 review).
        const length = await page.evaluate(() => history.length);
        await page.goForward({ waitUntil: 'commit' }).catch(() => page.evaluate(() => history.forward()));
        try { await view.waitFor({ timeout: 5_000 }); }
        catch { fail('session-forward: forward after 「←」 changed nothing on screen (the view stayed closed on its own entry)'); return; }
        const s = await page.evaluate(() => ({ length: history.length, state: history.state, id: document.querySelector('[data-testid="workroom-session-view"]')?.getAttribute('data-session-id') }));
        if (s.id !== SESS.long) fail(`session-forward: forward opened ${s.id}, not the session that was closed`);
        if (s.length !== length) fail(`session-forward: forward added history entries (${length} → ${s.length})`);
        if (!s.state?.workroomSessionView) fail('session-forward: the reopened view is not on its own entry');
        await page.goBack({ waitUntil: 'commit' }).catch(() => page.evaluate(() => history.back()));
        await viewClosed('session-forward');
      });

      await step('session-history', async () => {
        if (!phone) return;
        await firstRow.click({ timeout: 10_000 });
        await view.waitFor({ timeout: 10_000 });
        const opened = await historyCalls();
        // Opening again (the switcher picks the other running session) adds no entry.
        await page.getByTestId('workroom-session-switcher').selectOption(SESS.ops);
        await page.waitForFunction(id => document.querySelector('[data-testid="workroom-session-view"]')?.getAttribute('data-session-id') === id, SESS.ops, { timeout: 5_000 })
          .catch(() => fail('session-history: the switcher did not open the other session'));
        const switched = await historyCalls();
        if (switched.push !== opened.push) fail(`session-history: switching sessions pushed ${switched.push - opened.push} more history entries`);
        // The browser back (Safari or Chrome on the web portal) closes the view and stays on 원격 작업. The iOS app's
        // WKWebView has no back gesture (allowsBackForwardNavigationGestures = false): there only 「←」 and Escape close it.
        await page.goBack({ waitUntil: 'commit' }).catch(() => page.evaluate(() => history.back()));
        if (!(await viewClosed('session-history'))) return;
        const tab = await page.evaluate(() => document.querySelector('main[data-workspace-tab]')?.getAttribute('data-workspace-tab'));
        if (tab !== 'workroom') fail(`session-history: back from the session view left 원격 작업 (now ${tab})`);
        const o = await page.evaluate(() => window.__layout.overview());
        if (!o.rows.some(row => row.id === SESS.ops && row.text.includes('실행 중'))) fail('session-history: the session is not listed as running after back');
        if (o.surface || o.composer) fail('session-history: the overview shows a terminal after back');
      });

      await step('session-tab-switch', async () => {
        if (!phone) return;
        await firstRow.click({ timeout: 10_000 });
        await view.waitFor({ timeout: 10_000 });
        // A tab change while the view is open (a voice command, a link): the view closes and its entry gives way to the tab.
        await press(page.locator('nav.workspace-navigation [data-workspace-tab="home"]'));
        if (!(await viewClosed('session-tab-switch'))) return;
        const state = await page.evaluate(() => history.state);
        if (state?.workroomSessionView) fail('session-tab-switch: the new tab\'s history entry carries the session view');
        if (state?.workspaceTab !== 'home') fail(`session-tab-switch: the tab is ${state?.workspaceTab}`);
        await page.goBack({ waitUntil: 'commit' }).catch(() => page.evaluate(() => history.back()));
        await page.waitForFunction(() => document.querySelector('main[data-workspace-tab]')?.getAttribute('data-workspace-tab') === 'workroom', null, { timeout: 5_000 })
          .catch(() => fail('session-tab-switch: back from 홈 did not return to 원격 작업'));
        await page.waitForTimeout(300);
        if (await view.count()) fail('session-tab-switch: back from 홈 reopened the session view');
      });

      await step('session-start', async () => {
        if (!phone) return;
        const { start } = await openNewTask(page);
        await start.click({ timeout: 10_000 });
        try { await view.waitFor({ timeout: 10_000 }); } catch { fail('session-start: 「작업 시작」 did not open the new session full screen'); return; }
        const started = mac.state.started.at(-1);
        const shown = await view.getAttribute('data-session-id');
        if (!started || shown !== started.id) fail(`session-start: the view shows ${shown}, not the started session ${started?.id}`);
        await shot('session-start');
        await page.getByTestId('workroom-session-view-back').click({ timeout: 5_000 });
        await viewClosed('session-start');
        // The view took the sheet's entry: back from the new session lands on the list, never on the sheet again.
        await sleep(400);
        if (await page.getByTestId('workroom-new-task-sheet').count()) fail('session-start: closing the new session reopened the 새 작업 sheet');
        if (await page.evaluate(() => !!history.state?.workroomNewTask)) fail('session-start: a 새 작업 entry is current after closing the new session');
      });

      await step('scanner', async () => {
        await page.locator('.workspace-connection-details').evaluate(el => { el.open = true; });
        await press(page.getByTestId('remote-portal-scan-more'));
        await page.locator('.portal-qr-scanner').waitFor({ timeout: 10_000 });
        await page.waitForTimeout(1_200);
        await pageWidth('scanner');
        const hits = await page.evaluate(() => {
          const out = [];
          for (const el of document.querySelectorAll('.portal-qr-scanner button')) {
            if (!window.__layout.shown(el)) continue;
            el.scrollIntoView({ block: 'nearest' });
            const hit = window.__layout.hitsSelf(el);
            if (!hit.ok) out.push(`${window.__layout.name(el)} is covered by ${hit.hit}`);
          }
          // The dock must not be tappable through the scanner, wherever it is drawn.
          const dock = document.querySelector('[data-testid="voice-dock-call"]');
          if (dock && window.__layout.shown(dock)) {
            const r = dock.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + r.height / 2;
            if (y > 0 && y < innerHeight) {
              const hit = document.elementFromPoint(x, y);
              if (hit?.closest('.az-voice-dock')) out.push(`the voice dock (${window.__layout.name(hit)}) can be tapped over the scanner`);
            }
          }
          return out;
        });
        for (const message of hits) fail(`scanner: ${message}`);
        await shot('scanner-open');
        await press(page.getByRole('button', { name: 'QR 스캐너 닫기' }));
        await page.locator('.portal-qr-scanner').waitFor({ state: 'detached', timeout: 5_000 });
      });

      await step('home', async () => {
        await press(page.locator('nav.workspace-navigation [data-workspace-tab="home"]'));
        await page.locator('.workspace-recent-project').nth(3).waitFor({ timeout: 10_000 });
        await pageWidth('home');
        const rows = await page.evaluate(W => [...document.querySelectorAll('.workspace-recent-project')].map(row => {
          const r = row.getBoundingClientRect();
          const outside = [...row.children].filter(child => { const c = child.getBoundingClientRect(); return c.right > r.right + 0.5 || c.left < r.left - 0.5; }).map(window.__layout.name);
          return { name: window.__layout.name(row), right: Math.round(r.right), offScreen: r.right > W + 0.5 || r.left < -0.5, outside };
        }), W);
        for (const row of rows) {
          if (row.offScreen) fail(`home: ${row.name} ends at ${row.right}px on a ${W}px screen`);
          if (row.outside.length) fail(`home: ${row.outside.join(', ')} stick out of ${row.name}`);
        }
        await region('home', '.workspace-home');
      });

      await step('projects', async () => {
        await press(page.locator('nav.workspace-navigation [data-workspace-tab="projects"]'));
        // The picker is rendered in more than one place (header copies hide by breakpoint); wait for the shown one.
        const pickerShown = () => page.waitForFunction(() => [...document.querySelectorAll('span')]
          .some(el => el.textContent === '어떤 기기의 프로젝트를 볼까요?' && window.__layout.shown(el)), null, { timeout: 8_000 });
        try { await pickerShown(); }
        catch { await press(page.locator('.portal-catalog-toolbar button').filter({ hasText: '기기 선택' }).first()); await pickerShown(); }
        await page.waitForTimeout(500);
        await pageWidth('projects');
        const picker = await page.evaluate(W => {
          const label = [...document.querySelectorAll('span')].find(el => el.textContent === '어떤 기기의 프로젝트를 볼까요?' && window.__layout.shown(el));
          let popover = label; while (popover && !['absolute', 'fixed'].includes(getComputedStyle(popover).position)) popover = popover.parentElement;
          const r = popover.getBoundingClientRect();
          const out = [];
          if (r.left < -0.5 || r.right > W + 0.5) out.push(`the device picker spans ${Math.round(r.left)}–${Math.round(r.right)}px of ${W}px`);
          // The bottom navigation stays on top and tappable while the picker is open.
          for (const button of document.querySelectorAll('nav.workspace-navigation button')) {
            const hit = window.__layout.hitsSelf(button);
            if (!hit.ok) out.push(`the navigation's ${window.__layout.name(button)} is covered by ${hit.hit}`);
          }
          // And the picker's last row can still be reached by scrolling the page.
          const manage = [...popover.querySelectorAll('button')].find(el => el.textContent.trim().startsWith('+ 기기 관리'));
          if (manage) {
            manage.scrollIntoView({ block: 'center' });
            const hit = window.__layout.hitsSelf(manage);
            if (!hit.ok) out.push(`「+ 기기 관리」 cannot be reached (covered by ${hit.hit})`);
            window.scrollTo(0, 0);
          }
          return out;
        }, W);
        for (const message of picker) fail(`projects: ${message}`);
      });

      if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
      if (foreign.length) fail(`requests left the page: ${[...new Set(foreign)].join(', ')}`);
      console.log(`${where}: checked (pointer ${coarse ? 'coarse' : 'fine'})`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

// Review cases (w7 review, 2026-10-16), each at one size in every engine. PHONE_LAYOUT_REVIEW=0 skips them.
const reviewCase = async (name, viewport, options, run) => {
  const only = process.env.PHONE_LAYOUT_REVIEW;
  if (only === '0' || (only && !only.split(',').some(prefix => name.startsWith(prefix)))) return;
  for (const engineName of engines) {
    const browser = await (engineName === 'webkit' ? webkit : chromium).launch();
    const where = `${engineName} ${name}`;
    const fail = message => failures.push(`${where}: ${message}`);
    try {
      const portal = await openPortal(browser, engineName, viewport, options);
      try {
        await enterWorkroom(portal.page);
        const rows = portal.page.locator(ROWS);
        await run({ ...portal, rows, view: portal.page.locator('[data-testid="workroom-session-view"]'), fail });
        if (portal.errors.length) fail(`page errors: ${portal.errors.join(' | ')}`);
        if (portal.foreign.length) fail(`requests left the page: ${[...new Set(portal.foreign)].join(', ')}`);
        console.log(`${where}: checked`);
      } catch (error) {
        fail(`step failed — ${String(error.message).split('\n')[0]}`);
        if (shots) await portal.page.screenshot({ path: `${shots}/${engineName}-${name}-failed.png` }).catch(() => {});
      } finally { await portal.context.close(); }
    } finally { await browser.close(); }
  }
};

// w11 review: the resting overview — first load of ?tab=workroom, scrollY 0, nothing tapped — on the phones people hold,
// portrait and landscape. The voice dock floats there at rest, so the first running row and 「새 작업」 must be on the first
// screen, above the bottom navigation and clear of the dock: a tap on them (left, middle, right) hits them, not the dock.
// (Before the review the row was 509–628px on a 375×667 SE under the dock, and the dock took the right half of 「새 작업」.)
for (const size of (process.env.PHONE_LAYOUT_REST_SIZES || '320x568,375x667,390x844,393x852,428x926,926x428,844x390').split(',').filter(Boolean)) {
  const [width, height] = size.split('x').map(Number);
  await reviewCase(`rest-${size}`, { width, height }, {}, async ({ page, rows, fail }) => {
    await rows.first().waitFor({ timeout: 15_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);
    const m = await page.evaluate(sel => {
      const navTop = document.querySelector('nav.workspace-navigation')?.getBoundingClientRect().top ?? innerHeight;
      // In a short landscape screen the dock floats over the right end of the first row (its start time and chevron); the
      // row is one tap target, so its left and middle must be clear. In portrait all of it is.
      const landscape = innerWidth > innerHeight && innerHeight <= 500;
      const probe = (el, whole) => { if (!el) return null; const r = el.getBoundingClientRect(); const misses = [];
        for (const fx of whole || !landscape ? [0.1, 0.5, 0.9] : [0.1, 0.5]) { const x = r.left + r.width * fx, y = r.top + r.height / 2;
          const hit = y >= 0 && y < innerHeight ? document.elementFromPoint(x, y) : null;
          if (!hit || !(hit === el || el.contains(hit))) misses.push(`@${fx} ${hit ? window.__layout.name(hit) : 'off screen'}`); }
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), misses }; };
      const row = [...document.querySelectorAll(sel)].find(el => window.__layout.shown(el) && el.textContent.includes('실행 중'));
      const entry = [...document.querySelectorAll('[data-testid="workroom-new-task"]')].find(window.__layout.shown);
      return { navTop: Math.round(navTop), row: probe(row, false), entry: probe(entry, true) };
    }, ROWS);
    notes.push(`rest ${size}: first running row ${m.row?.top}–${m.row?.bottom}px, 「새 작업」 ${m.entry?.top}–${m.entry?.bottom}px, navigation from ${m.navTop}px`);
    if (!m.row) fail('no running session row on the overview');
    else if (m.row.bottom > m.navTop) fail(`the first running row (${m.row.top}–${m.row.bottom}px) is not on the first screen above the navigation (${m.navTop}px)`);
    else if (m.row.misses.length) fail(`the first running row is covered at rest: ${m.row.misses.join(' · ')}`);
    if (!m.entry) fail('no 「새 작업」 on the overview');
    else if (m.entry.bottom > m.navTop || m.entry.misses.length) fail(`「새 작업」 (${m.entry.top}–${m.entry.bottom}px) is covered at rest: ${m.entry.misses.join(' · ') || 'under the navigation'}`);
    if (shots) await page.screenshot({ path: `${shots}/${page.context().browser().browserType().name()}-rest-${size}.png` }).catch(() => {});
  });
}

// The Mac's projects come in pages; one page fails and the portal's automatic sweep retries it ~5 s later, hiding the panel
// while it loads. A session opened meanwhile stays open: loading is not leaving the Workroom (it closed and did not reopen).
await reviewCase('sweep-retry-390x844', { width: 390, height: 844 }, { fixture: { pagedProjects: true } }, async ({ page, mac, rows, view, fail }) => {
  await rows.first().click({ timeout: 10_000 });
  await view.waitFor({ timeout: 10_000 });
  const opened = await page.evaluate(() => ({ length: history.length, state: history.state }));
  const closedAt = [];
  for (let t = 0; t < 12_000; t += 250) { if (!(await view.count())) closedAt.push(t); await page.waitForTimeout(250); }
  if (mac.state.page1 < 2) fail(`the sweep did not retry its failed page (page-1 requests: ${mac.state.page1}) — the case did not run`);
  if (closedAt.length) fail(`the automatic project-sweep retry closed the open session view (closed at ${closedAt[0]}–${closedAt.at(-1)} ms)`);
  const after = await page.evaluate(() => ({ length: history.length, state: history.state }));
  if (after.length !== opened.length || after.state?.workroomSessionView !== opened.state?.workroomSessionView) fail(`the sweep moved history (${JSON.stringify(opened)} → ${JSON.stringify(after)})`);
  if (await view.count()) await view.locator('.ai-terminal-surface').waitFor({ timeout: 5_000 }).catch(() => fail('the view did not show its terminal again after the sweep'));
});

// An input the phone could not send (the relay send fails at the network level) is held and says so. After 「←」 the list
// polls only `list`; once the held input has gone out, a successful list clears that error (it stayed until a tap).
await reviewCase('held-input-390x844', { width: 390, height: 844 }, {}, async ({ page, mac, rows, view, fail }) => {
  await rows.first().click({ timeout: 10_000 });
  await view.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1_500);
  mac.state.failSend = true;
  // The key's first request is the size claim; it is the one held, and the input behind it is refused (held ahead).
  const delivered = () => mac.state.inputs.length + mac.state.resizes.length, before = delivered();
  await press(view.locator('.ai-terminal-key').filter({ hasText: /^Enter$/ }));
  // Both held errors (the claim's REQUEST_UNSENT, the input's …_AHEAD) say the request has not reached the Mac yet.
  const HELD = '아직 Mac';
  const alert = page.locator('[data-testid="workroom-session-view"] .ai-terminal-launch-error').filter({ hasText: HELD });
  if (!(await until(async () => (await alert.count()) > 0, 15_000))) { fail('the held input showed no error in the session view — the case did not run'); return; }
  await page.waitForTimeout(2_000);
  await press(page.getByTestId('workroom-session-view-back'));
  await view.waitFor({ state: 'detached', timeout: 5_000 });
  mac.state.failSend = false;
  if (!(await until(() => delivered() > before, 60_000))) { fail(`the held request never reached the Mac — the case did not run (relay accepted ${mac.state.accepted.size})`); return; }
  const stale = () => page.evaluate(text => [...document.querySelectorAll('.remote-workroom-content .ai-terminal-launch-error')].map(el => el.textContent).find(t => t.includes(text)) ?? '', HELD);
  if (!(await until(async () => !(await stale()), 15_000))) fail(`the list still says 「${(await stale()).slice(0, 60)}…」 15 s after the held request reached the Mac`);
});

// w11 (S4.2 + critique 17): back where you were. A reload — as iOS does when it reclaims the page's WebContent process —
// reopens the session that was open, full screen, without growing history; a session that has exited since stays a row.
await reviewCase('reload-390x844', { width: 390, height: 844 }, {}, async ({ page, mac, rows, view, fail, errors }) => {
  // WebKit reports a relay request the reload cancels as a page error ("… due to access control checks"): the page that
  // made it is gone. Only that one is set aside, at the end.
  const reloads = () => { for (let i = errors.length - 1; i >= 0; i--) if (/due to access control checks/.test(errors[i])) errors.splice(i, 1); };
  await rows.first().click({ timeout: 10_000 });
  await view.waitFor({ timeout: 10_000 });
  const id = await view.getAttribute('data-session-id');
  await page.waitForTimeout(800);
  const before = await page.evaluate(() => history.length);
  await page.reload();
  if (!(await until(async () => (await view.count()) > 0, 25_000))) { fail('a reload with a running session open came back to the list, not to that session'); return; }
  if ((await view.getAttribute('data-session-id')) !== id) fail(`the reload reopened ${await view.getAttribute('data-session-id')}, not ${id}`);
  await page.waitForTimeout(1_500);
  const after = await page.evaluate(() => ({ length: history.length, state: history.state }));
  if (after.length > before) fail(`reopening after the reload added history entries (${before} → ${after.length})`);
  if (!after.state?.workroomSessionView) fail('the reopened view is not on a history entry of its own');
  if (!(await view.count())) fail('the reopened view closed by itself');
  await page.getByTestId('workroom-session-view-back').click({ timeout: 5_000 });
  await view.waitFor({ state: 'detached', timeout: 5_000 });
  // 「←」 forgets it: the next reload shows the list.
  await page.reload();
  await page.locator(ROWS).first().waitFor({ timeout: 25_000 });
  await page.waitForTimeout(2_500);
  if (await view.count()) fail('a reload after 「←」 reopened the session');
  // The session ends while it is open: the reload shows the list.
  await page.locator(ROWS).first().click({ timeout: 10_000 });
  await view.waitFor({ timeout: 10_000 });
  mac.state.exited.add(await view.getAttribute('data-session-id'));
  await page.reload();
  await page.locator(ROWS).first().waitFor({ timeout: 25_000 });
  await page.waitForTimeout(3_000);
  if (await view.count()) fail('a reload reopened a session that has exited');
  reloads();
});

// w11 (S4.3): an honest sending state. A send that is merely slow says 「보내는 중…」 and never the recovery banner; only an
// unknown outcome (the answer was lost) shows the banner, whose two buttons are 44px on a phone.
await reviewCase('sending-390x844', { width: 390, height: 844 }, {}, async ({ page, mac, rows, view, fail }) => {
  await rows.first().click({ timeout: 10_000 });
  await view.waitFor({ timeout: 10_000 });
  const composer = view.getByLabel('워크룸 입력');
  await composer.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1_500);
  const banner = page.getByTestId('workroom-submission-recovery');
  mac.state.submissionDelayMs = 2_500;
  await composer.fill('첫 번째 요청');
  await press(view.locator('.ai-terminal-command-field .ai-terminal-start'));
  let bannerSeen = 0, sendingSeen = 0;
  for (const end = Date.now() + 2_200; Date.now() < end; await sleep(100)) {
    if (await banner.count()) bannerSeen++;
    if (/보내는 중…/.test(await view.innerText())) sendingSeen++;
  }
  if (bannerSeen) fail('the recovery banner showed while a send was merely in flight');
  if (!sendingSeen) fail('no 「보내는 중…」 while the request was in flight');
  if (!(await until(async () => (await composer.inputValue()) === '', 10_000))) fail('the delayed send never settled');
  if (await banner.count()) fail('the recovery banner stayed after a written receipt');
  if (!mac.state.submissions.some(item => item.text === '첫 번째 요청\r')) fail('the delayed request did not reach the Mac once');
  // A lost answer: the outcome is unknown.
  mac.state.submissionDelayMs = 0; mac.state.dropSubmission = true;
  await composer.fill('두 번째 요청');
  await press(view.locator('.ai-terminal-command-field .ai-terminal-start'));
  const shown = await until(async () => (await banner.count()) > 0, 20_000);
  mac.state.dropSubmission = false; mac.state.failReceive = false;
  if (!shown) { fail('no recovery banner after the answer was lost'); return; }
  const sizes = await banner.evaluate(el => [...el.querySelectorAll('button')].map(b => ({ name: b.textContent, h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width })));
  if (sizes.length !== 2) fail(`the recovery banner has ${sizes.length} buttons`);
  for (const b of sizes) if (b.h < 43.5 || b.w < 43.5) fail(`the recovery button 「${b.name}」 is ${Math.round(b.w)}x${Math.round(b.h)}`);
  if (shots) await page.screenshot({ path: `${shots}/sending-recovery-${Date.now()}.png` }).catch(() => {});
});

// w11 (S4.4): a launch whose answer names the new session only in its receipt (no `session`) still selects it — the panel
// lists until it is there (it read a stale list and silently did nothing) — and the start button stays disabled meanwhile.
const launchCase = (name, hide, expectNotice) => reviewCase(name, { width: 390, height: 844 }, {}, async ({ page, mac, view, fail }) => {
  await page.waitForTimeout(1_500);
  mac.state.launchHide = hide;
  const { scope, start, legacy } = await openNewTask(page);
  await scope.getByLabel('터미널 프로젝트').selectOption(LONG);
  if (legacy) await scope.getByTestId('workroom-composer-toggle').first().click();
  await scope.getByLabel('터미널에 전달할 작업').fill('새 세션 첫 요청');
  const button = legacy ? scope.locator('.ai-terminal-prompt .ai-terminal-start') : start;
  await button.click({ timeout: 10_000 });
  const notice = page.getByText('새 세션이 열렸습니다 — 목록을 확인하세요');
  let enabledEarly = 0;
  const settled = await until(async () => {
    if ((await view.count()) || (await notice.count())) return true;
    if ((await button.count()) && await button.isEnabled().catch(() => false)) enabledEarly++;
    return false;
  }, 15_000);
  const launches = mac.state.submissions.filter(item => item.launch);
  if (launches.length !== 1) fail(`${launches.length} launches reached the Mac (one expected)`);
  if (!settled) { fail(expectNotice ? 'neither the new session nor 「새 세션이 열렸습니다 — 목록을 확인하세요」 showed' : 'the launched session was never selected (the start did nothing)'); return; }
  if (enabledEarly) fail('the start button was enabled again before the new session or the notice showed');
  if (expectNotice) {
    if (!(await notice.count())) fail('no 「새 세션이 열렸습니다 — 목록을 확인하세요」 when the new session is not listed');
    if (await view.count()) fail('a session view opened although the new session was never listed');
  } else if ((await view.getAttribute('data-session-id')) !== mac.state.started.at(-1)?.id) fail(`the view shows ${await view.getAttribute('data-session-id')}, not the launched ${mac.state.started.at(-1)?.id}`);
});
await launchCase('launch-unlisted-once-390x844', 1, false);
await launchCase('launch-never-listed-390x844', 99, true);

// A desktop browser window at 600px (a fine pointer) opens sessions full screen too. Widening it closes the view; after
// narrowing again, one browser back closes the next view (the back of the widening was not counted and swallowed one).
await reviewCase('narrow-window-600x900', { width: 600, height: 900 }, { touch: false }, async ({ page, rows, view, fail }) => {
  await rows.nth(0).click({ timeout: 10_000 });
  await view.waitFor({ timeout: 10_000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  if (!(await until(async () => !(await view.count()), 5_000))) { fail('widening the window did not close the session view'); return; }
  await page.waitForTimeout(500);
  await page.setViewportSize({ width: 600, height: 900 });
  await page.waitForTimeout(500);
  await rows.nth(1).click({ timeout: 10_000 });
  await view.waitFor({ timeout: 10_000 });
  await page.goBack({ waitUntil: 'commit' }).catch(() => page.evaluate(() => history.back()));
  if (!(await until(async () => !(await view.count()), 3_000))) fail('one browser back did not close the session view after the window was widened and narrowed again');
  const state = await page.evaluate(() => history.state);
  if (state?.workroomSessionView) fail('back left the page on a session view entry');
});

// A desktop browser (a fine pointer, 1280×900): the Workroom is unchanged — the terminal stays inline, nothing covers
// the page and opening a session does not touch history.
if (process.env.PHONE_LAYOUT_DESKTOP !== '0') for (const engineName of engines) {
  const browser = await (engineName === 'webkit' ? webkit : chromium).launch();
  const where = `${engineName} desktop 1280×900`;
  const fail = message => failures.push(`${where}: ${message}`);
  try {
    const { context, page, errors, foreign } = await openPortal(browser, engineName, { width: 1280, height: 900 }, { touch: false });
    try {
      const pointer = await page.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches, narrow: matchMedia('(max-width: 640px)').matches }));
      if (pointer.coarse || pointer.narrow) fail(`the desktop context is not a desktop (${JSON.stringify(pointer)})`);
      // ?tab=workroom opens the Workroom itself (w11): the rows come without the pane button.
      const row = page.locator(ROWS).first();
      try { await row.waitFor({ timeout: 15_000 }); }
      catch { fail('?tab=workroom did not open the Workroom'); await press(page.getByRole('button', { name: '워크룸 이어가기', exact: true })); await row.waitFor({ timeout: 15_000 }); }
      const length = await page.evaluate(() => history.length);
      await row.click();
      await page.locator('.remote-workroom-content [data-testid="workroom-command-composer"]').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(800);
      const d = await page.evaluate(() => ({
        view: !!document.querySelector('[data-testid="workroom-session-view"]'), back: !!document.querySelector('[data-testid="workroom-session-view-back"]'),
        surface: !!document.querySelector('.remote-workroom-content .ai-terminal-surface'), xterm: document.querySelectorAll('.remote-workroom-content .xterm').length,
        length: history.length, state: history.state, nav: window.__layout.hitsSelf(document.querySelector('nav.workspace-navigation button')).ok,
      }));
      if (d.view || d.back) fail('a desktop browser opened the full-screen session view');
      if (!d.surface || !d.xterm) fail('the terminal is no longer inline on a desktop browser');
      if (d.length !== length || d.state?.workroomSessionView) fail('opening a session on a desktop browser touched history');
      if (!d.nav) fail('the bottom navigation is covered on a desktop browser');
      if (shots) await page.screenshot({ path: `${shots}/${engineName}-desktop-1280x900-session.png`, fullPage: engineName === 'webkit' });
      if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
      if (foreign.length) fail(`requests left the page: ${[...new Set(foreign)].join(', ')}`);
      console.log(`${where}: checked (pointer fine)`);
    } catch (error) {
      fail(`step failed — ${String(error.message).split('\n')[0]}`);
    } finally { await context.close(); }
  } finally { await browser.close(); }
}

for (const note of notes) console.log(`note: ${note}`);
if (failures.length) {
  console.error(`\n${failures.length} layout failure(s):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('remote phone layout: all checks passed');
