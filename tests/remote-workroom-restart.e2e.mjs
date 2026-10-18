// 「업데이트 전 실행 중이던 작업 세션 N개 이어 열기」 on the phone portal (w14, Build B). Drives the real portal bundle with a
// real E2EE fake Mac behind a fake relay, in WebKit and Chromium:
//   - layout, at 390×844, 375×667, 926×428 and 844×390: the first running session row's box is the same with the banner
//     (a Mac advertising `workroom-restart-v1`) and without it (a Mac that does not — and is never asked); the folded
//     banner is one ≥44px button with 16px text, after the rows, with no horizontal scroll; open, every row and button is
//     ≥44px;
//   - at 390×844: a double tap on 「N개 이어 열기」 sends nothing and leaves a confirmation that is not under the finger; a
//     deliberate confirm sends review → execute once per openable row (never for an unsupported one), shows a summary
//     and the banner goes away; 「대화 기록」 shows one phrase per row instead of a bare 「이어 열 수 없음」;
//   - without the resume grant: the sentence that says so, no button that opens anything, and 「이 휴대폰에서 숨기기」
//     hides it on this phone (still hidden after a reload, never asked to close it on the Mac);
//   - 「닫기」 sends one dismiss and the banner is gone.
//   Review (w14): the folded label counts every session; whether the phone may close it is the Mac's word (`closable`);
//   a phone without ‘워크룸 대화 기록 보기’ is told how many and which permission, never which sessions; two sessions of one
//   project and AI are told apart by their start time; one row's 「이어 열기」 opens that session's view, and after
//   「N개 이어 열기」 the sessions are listed at once (no view opens by itself).
//
// Isolated: a portal build with fixture VITE_* values, every request routed by Playwright; no network, no 3001, no Mac.
// Build: VITE_SUPABASE_URL=https://fixture-offline.supabase.co VITE_SUPABASE_ANON_KEY=<jwt-shaped> \
//          ./node_modules/.bin/vite build --config vite.portal.config.ts --outDir <dir>
// Run:   bun tests/remote-workroom-restart.e2e.mjs <dir> [screenshotDir]
//        RESTART_E2E_ENGINES=webkit narrows the engines; RESTART_E2E_SIZES=390x844 narrows the layout matrix.
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
const engines = (process.env.RESTART_E2E_ENGINES || 'webkit,chromium').split(',');
const sizes = (process.env.RESTART_E2E_SIZES || '390x844,375x667,926x428,844x390').split(',').map(size => { const [width, height] = size.split('x').map(Number); return { width, height }; });

const PAGE = 'https://portal.test';
const SUPABASE = 'fixture-offline.supabase.co';
const ids = { host: '11111111-1111-4111-8111-111111111111', pairing: '22222222-2222-4222-8222-222222222222',
  session: '33333333-3333-4333-8333-333333333333', controller: '44444444-4444-4444-8444-444444444444' };
const encoder = new TextEncoder(), decoder = new TextDecoder();
const DAY = 86_400_000;
const now = () => new Date().toISOString();
const cid = c => c.repeat(42) + '1';
const OPS = cid('O'), BLOG = cid('B'), SHOP = cid('S');
const projects = [
  { controlId: OPS, name: 'AgentsToZ-OPS', role: 'ops', kind: 'main', status: 'unknown', port: null, branch: 'main', actions: ['folder.open'] },
  { controlId: BLOG, name: '블로그', kind: 'main', status: 'stopped', port: 5173, branch: 'main', actions: ['folder.open'] },
  { controlId: SHOP, name: '쇼핑몰', kind: 'main', status: 'stopped', port: 3000, branch: 'main', actions: ['folder.open'] },
];
const BASE_FEATURES = ['workspace-v1', 'workroom-history-v1', 'voc-v1', 'voc-inbox-v1', 'terminal-refs-v1', 'tester-v1', 'terminal-submission-v1', 'terminal-start-submission-v1'];
const SESS = { blog: '55555555-5555-4555-8555-555555555551', ops: '55555555-5555-4555-8555-555555555552' };
const CONV = { blog: 'conv_restart_blog_0000000001', shop: 'conv_restart_shop_0000000002', hermes: 'conv_restart_hermes_000000003' };

/** `restart`: whether the Mac advertises workroom-restart-v1; `grant`: the phone has ‘저장된 대화 이어 열기’; `read`: it has
 *  ‘워크룸 대화 기록 보기’ (without it the Mac answers a count only); `twins`: two sessions of one project and AI. */
async function fixtureMac({ restart = true, grant = true, read = true, twins = false } = {}) {
  const keys = await generateRemoteControlRelayKeyPair();
  const hostPublicKey = await exportRemoteControlRelayPublicKey(keys.publicKey);
  const state = { hostSequence: 0, deliveries: [], accepted: new Set(), actions: [], resumed: new Set(), dismissed: false, started: [] };
  const offerRows = () => (twins ? [
    { id: CONV.blog, project: SHOP, title: '', agent: 'codex', bypass: false, startedAgo: 7_200_000 },
    { id: CONV.shop, project: SHOP, title: '', agent: 'codex', bypass: false, startedAgo: 1_800_000 },
  ] : [
    { id: CONV.blog, project: BLOG, title: '블로그 글 목록 페이지 정리', agent: 'claude', bypass: true, startedAgo: 3_600_000 },
    { id: CONV.shop, project: SHOP, title: '', agent: 'codex', bypass: false, startedAgo: 1_800_000 },
    { id: CONV.hermes, project: OPS, title: 'Hermes 채널 점검', agent: 'hermes', bypass: null, startedAgo: 900_000 },
  ]).map(({ startedAgo, ...row }) => ({ ...row, revision: 3, createdAt: new Date(Date.now() - startedAgo).toISOString(), updatedAt: new Date(Date.now() - 600_000).toISOString(),
    availability: row.agent === 'hermes' ? 'unsupported' : state.resumed.has(row.id) ? 'running' : grant ? 'ready' : 'grant' }));
  const offer = () => {
    if (state.dismissed) return null;
    const rows = offerRows();
    // Like the Mac: nothing left to open (resumed or never resumable) finishes the offer.
    if (!rows.some(row => ['ready', 'check', 'grant'].includes(row.availability))) return null;
    const base = { offerId: '66666666-6666-4666-8666-666666666666', revision: 2, update: true, more: false };
    // Without the read grant the Mac says how many, never which.
    if (!read) return { ...base, complete: false, closable: false, unlisted: rows.length, rows: [] };
    return { ...base, complete: true, closable: grant, unlisted: 0, rows };
  };
  const sessions = () => [
    { id: SESS.blog, targetId: BLOG, agent: 'claude', state: 'running', createdAt: new Date(Date.now() - 3_600_000).toISOString(), exitCode: null, cols: 100, rows: 28 },
    { id: SESS.ops, targetId: OPS, agent: 'codex', state: 'running', createdAt: new Date(Date.now() - 600_000).toISOString(), exitCode: null, cols: 100, rows: 28 },
    ...state.started,
  ];
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
        projects, projectCount: projects.length, nextPage: null });
    }
    if (message.type === 'action.request') {
      const base = { type: 'action.result', actionId: message.actionId };
      if (message.action === 'protocol.capabilities.extended') return reply({ ...base, ok: true, supportedFeatures: restart ? [...BASE_FEATURES, 'workroom-restart-v1'] : BASE_FEATURES });
      if (message.action === 'protocol.capabilities') return reply({ ...base, ok: true, supportedFeatures: BASE_FEATURES });
      if (message.action === 'projects.list') return reply({ ...base, ok: true, projects, page: 0, projectCount: projects.length, nextPage: null });
      if (message.action === 'workspace-roots.list') return reply({ ...base, ok: true, workspaceRoots: [] });
      if (message.action === 'ops.status') return reply({ ...base, ok: true, ops: { state: 'ready', backend: 'app-data', pendingCount: 0, lastSavedAt: null, syncState: null } });
      return reply({ ...base, ok: false, error: { code: 'ACTION_NOT_ALLOWED', message: '이 테스트 Mac에는 없는 동작입니다.' } });
    }
    if (message.type === 'terminal.request') {
      const req = message.request; const op = req.operation;
      const ok = body => reply({ type: 'terminal.result', requestId: req.requestId, ok: true, body });
      const fail = error => reply({ type: 'terminal.result', requestId: req.requestId, ok: false, error });
      if (op === 'list') return ok(req.capabilities ? { sessions: sessions(), features: ['terminal-submission-v1', 'terminal-start-submission-v1'] } : { sessions: sessions() });
      if (op === 'read') return ok({ session: sessions().find(s => s.id === req.sessionId) ?? sessions()[0], chunks: [], nextCursor: req.after ?? 0, truncated: false, hasMore: false });
      if (op === 'submission') return req.submission.phase === 'recent' ? ok({ submissions: [] }) : fail('이 테스트 Mac에는 없는 요청입니다.');
      if (op === 'workspace') {
        const action = req.workspace.action, history = req.workspace.history;
        state.actions.push({ action, targetId: req.targetId, conversationId: history?.conversationId, detail: history?.detail });
        const ws = extra => ok({ kind: 'workspace', action, ...extra });
        if (action === 'workroom.status') return ws({ workroom: { sessionId: req.workspace.sessionId, initialized: true, lastSavedAt: null, context: null,
          save: { requestId: null, state: 'idle', localSaved: false, backupSaved: false, message: '' } } });
        if (action === 'community.status' || action === 'community.read') return ws({ community: { inside: false, roomId: null, unread: 0, members: [], devices: [], messages: [], nextSeq: 1 } });
        if (action === 'voc.inbox') return ws({ vocInbox: { total: 0, unreadable: 0, items: [] } });
        if (!restart && (action.startsWith('history.restart') || history?.detail)) return fail('대화 기록 요청 형식이 올바르지 않습니다.');
        if (action === 'history.restart') return ws({ history: { restart: offer() } });
        if (action === 'history.restart.dismiss') { state.dismissed = true; return ws({ history: { restart: null } }); }
        if (action === 'history.list') {
          const rows = [
            { id: CONV.blog, title: '블로그 글 목록 페이지 정리', agent: 'claude', state: 'detached', resumable: grant && !state.resumed.has(CONV.blog), updatedAt: now(), revision: 3 },
            { id: CONV.hermes, title: 'Hermes 채널 점검', agent: 'hermes', state: 'detached', resumable: false, updatedAt: now(), revision: 3 },
            { id: 'conv_restart_unsaved_00000004', title: '첫 요청 전에 끝난 작업', agent: 'codex', state: 'detached', resumable: false, updatedAt: now(), revision: 2 },
          ];
          const why = { [CONV.blog]: grant ? null : 'grant', [CONV.hermes]: 'unsupported', conv_restart_unsaved_00000004: 'unsaved' };
          return ws({ history: { records: rows.map(row => history?.detail ? { ...row, why: row.resumable ? null : why[row.id] } : row), nextBefore: null } });
        }
        if (action === 'history.resume.review') return ws({ history: { review: { id: 'review_' + crypto.randomUUID().replaceAll('-', ''), expiresAt: Date.now() + 60_000, available: true, reason: '', revision: 4 } } });
        if (action === 'history.resume.execute') {
          state.resumed.add(history.conversationId);
          const id = `55555555-5555-4555-8555-5555555556${String(state.started.length).padStart(2, '0')}`;
          state.started.push({ id, targetId: req.targetId, agent: 'claude', state: 'running', createdAt: now(), exitCode: null, cols: 100, rows: 30 });
          return ws({ history: { resume: { state: 'completed', sessionId: id } } });
        }
        return fail('이 테스트 Mac에는 없는 요청입니다.');
      }
      return fail('이 테스트 Mac에는 없는 요청입니다.');
    }
  };
  const rpc = {
    portmgr_is_member: () => true,
    portmgr_prompt_guides_read: () => ({ success: true, revision: 'r1', entries: [] }),
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

function installProbe() {
  window.__probe = {
    shown(el) {
      if (!el || !el.isConnected || el.closest('[hidden]')) return false;
      const r = el.getBoundingClientRect(); return r.width > 0.5 && r.height > 0.5;
    },
    firstRunningRow() {
      const row = [...document.querySelectorAll('.remote-workroom-content .ai-terminal-session-list [role=tab]')].find(el => this.shown(el) && el.textContent.includes('실행 중'));
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height, bottom: r.bottom + scrollY };
    },
    docWidth: () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    small(selector) {
      const out = [];
      for (const el of document.querySelectorAll(`${selector} button, ${selector} li`)) {
        if (!this.shown(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 43.5 || el.tagName === 'BUTTON' && r.width < 43.5) out.push(`${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? ''}] ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    },
  };
}

async function openPortal(browser, engineName, viewport, fixture) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: true, isMobile: engineName === 'chromium', serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [], foreign = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => void dialog.accept());
  await page.addInitScript(installProbe);
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
      if (rpcName && mac.rpc[rpcName]) return route.fulfill({ json: await mac.rpc[rpcName](route.request().postDataJSON() ?? {}) });
      return route.fulfill({ json: [] });
    }
    foreign.push(url.origin); return route.abort();
  });
  await page.goto(mac.pairingUrl('?tab=workroom'));
  await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 30_000 });
  await page.locator('.remote-workroom-content .ai-terminal-session-list [role=tab]').first().waitFor({ timeout: 20_000 });
  return { context, page, errors, foreign, mac };
}

const failures = [], notes = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (check, timeout) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return true; await sleep(100); } return false; };
const BANNER = '[data-testid="remote-workroom-restart"]';
const sent = (mac, prefix) => mac.state.actions.filter(a => a.action.startsWith(prefix));

for (const engineName of engines) {
  const browser = await (engineName === 'webkit' ? webkit : chromium).launch();
  try {
    for (const viewport of sizes) {
      const where = `${engineName} ${viewport.width}×${viewport.height}`;
      const fail = message => failures.push(`${where}: ${message}`);
      // Without the feature: the reference box of the first running row, and not one restart request.
      const plain = await openPortal(browser, engineName, viewport, { restart: false });
      await sleep(1500);
      await plain.page.evaluate(() => window.scrollTo(0, 0));
      const without = await plain.page.evaluate(() => window.__probe.firstRunningRow());
      if (await plain.page.locator(BANNER).count()) fail('a Mac without workroom-restart-v1 shows the banner');
      if (sent(plain.mac, 'history.restart').length) fail(`a Mac without the feature was asked ${sent(plain.mac, 'history.restart').length} restart requests`);
      if (plain.errors.length) fail(`page errors (no feature): ${plain.errors.join(' | ')}`);
      await plain.context.close();

      const { context, page, errors, foreign, mac } = await openPortal(browser, engineName, viewport, {});
      try {
        const banner = page.locator(BANNER);
        await banner.waitFor({ timeout: 15_000 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(300);
        const withBanner = await page.evaluate(() => window.__probe.firstRunningRow());
        const same = without && withBanner && ['left', 'top', 'width', 'height'].every(k => Math.abs(without[k] - withBanner[k]) <= 0.5);
        if (!same) fail(`the first running row moved with the banner: ${JSON.stringify(without)} → ${JSON.stringify(withBanner)}`);
        notes.push(`${where}: first running row ${Math.round(withBanner?.top)}–${Math.round(withBanner?.bottom)}px, same with and without the banner`);
        const m = await page.evaluate(sel => {
          const toggle = document.querySelector(`${sel} [data-testid="remote-workroom-restart-toggle"]`);
          const r = toggle.getBoundingClientRect(), b = document.querySelector(sel).getBoundingClientRect();
          const rows = [...document.querySelectorAll('.remote-workroom-content .ai-terminal-session-list [role=tab]')].filter(el => window.__probe.shown(el));
          const lastRow = rows.at(-1)?.getBoundingClientRect();
          return { height: r.height, font: parseFloat(getComputedStyle(toggle).fontSize), text: toggle.textContent, bannerTop: b.top, lastRowBottom: lastRow?.bottom ?? 0,
            docWidth: window.__probe.docWidth(), width: innerWidth };
        }, BANNER);
        if (m.height < 43.5) fail(`the folded banner is ${m.height}px tall`);
        if (m.font < 16) fail(`the folded banner's text is ${m.font}px`);
        // Every session it lists (review: it said 2 beside 3 rows); the button says how many open.
        if (!/업데이트 전 작업 세션 3개 · 이어 열기/.test(m.text)) fail(`the folded banner says 「${m.text}」`);
        if (m.bannerTop < m.lastRowBottom - 0.5) fail('the banner sits above a session row');
        if (m.docWidth > viewport.width + 0.5) fail(`the page is ${m.docWidth}px wide on a ${viewport.width}px screen`);
        await banner.getByTestId('remote-workroom-restart-toggle').click();
        await banner.getByTestId('remote-workroom-restart-row').first().waitFor();
        const small = await page.evaluate(sel => window.__probe.small(sel), BANNER);
        if (small.length) fail(`tap targets under 44px in the banner: ${small.join(' · ')}`);
        const wide = await page.evaluate(() => window.__probe.docWidth());
        if (wide > viewport.width + 0.5) fail(`the open banner makes the page ${wide}px wide`);
        const rowFont = await banner.locator('.workroom-restart-row-text strong').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
        if (rowFont < 16) fail(`a row's title is ${rowFont}px`);
        if (shots) await page.screenshot({ path: `${shots}/${engineName}-${viewport.width}x${viewport.height}-restart-open.png`, fullPage: engineName === 'webkit' }).catch(() => {});

        if (viewport.width === 390 && viewport.height === 844) {
          // A double tap on 「2개 이어 열기」 sends nothing and leaves a confirmation that is not under the finger.
          const openAll = banner.getByTestId('remote-workroom-restart-open-all');
          await openAll.scrollIntoViewIfNeeded();
          const box = await openAll.boundingBox();
          const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          await page.mouse.click(point.x, point.y, { clickCount: 2, delay: 40 });
          await sleep(700);
          if (sent(mac, 'history.resume').length) fail(`a double tap sent ${JSON.stringify(sent(mac, 'history.resume'))}`);
          const confirm = banner.getByTestId('remote-workroom-restart-confirm');
          await confirm.waitFor({ timeout: 3_000 });
          if (!/2개 대화를 다시 엽니다 · 권한 우회 없음/.test(await confirm.innerText())) fail(`the confirmation says 「${await confirm.innerText()}」`);
          const at = await banner.getByTestId('remote-workroom-restart-confirm-open').boundingBox();
          if (point.x >= at.x && point.x <= at.x + at.width && point.y >= at.y && point.y <= at.y + at.height) fail('the confirm button sits under the finger that armed it');
          // 취소 disarms; armed again, a confirm inside the guard is ignored; a deliberate one opens each openable row once,
          // the Hermes row never.
          await banner.getByTestId('remote-workroom-restart-confirm-cancel').click();
          if (await confirm.count()) fail('취소 left the confirmation');
          await openAll.click();
          await confirm.waitFor({ timeout: 3_000 });
          await banner.getByTestId('remote-workroom-restart-confirm-open').evaluate(el => el.click());
          await sleep(100);
          if (sent(mac, 'history.resume').length) fail('a confirm within 500 ms of arming was taken');
          await sleep(600);
          await banner.getByTestId('remote-workroom-restart-confirm-open').click();
          await page.getByTestId('remote-workroom-restart-summary').waitFor({ timeout: 20_000 });
          const executes = sent(mac, 'history.resume.execute');
          if (executes.length !== 2 || new Set(executes.map(e => e.conversationId)).size !== 2) fail(`executes: ${JSON.stringify(executes)}`);
          if (executes.some(e => e.conversationId === CONV.hermes)) fail('the Hermes row was sent');
          if (JSON.stringify(executes.map(e => e.targetId).sort()) !== JSON.stringify([BLOG, SHOP].sort())) fail(`each row did not go through its own project: ${JSON.stringify(executes)}`);
          const summary = await page.getByTestId('remote-workroom-restart-summary').innerText();
          if (!/2개를 다시 열었습니다/.test(summary)) fail(`summary: 「${summary}」`);
          // The sessions it points to are listed at once (review: ~4 s later), and no session view opened by itself.
          const listed = await until(async () => (await page.locator('.remote-workroom-content .ai-terminal-session-list [role=tab]').count()) >= 4, 2_500);
          if (!listed) fail('the reopened sessions were not listed within 2.5 s');
          if (await page.getByTestId('workroom-session-view').count()) fail('a session view opened by itself after 「N개 이어 열기」');
          if (!(await until(async () => !(await banner.getByTestId('remote-workroom-restart-toggle').count()), 10_000))) fail('the offer did not go away after both rows were opened');
          if (shots) await page.screenshot({ path: `${shots}/${engineName}-restart-done.png`, fullPage: engineName === 'webkit' }).catch(() => {});
          // 「대화 기록」 says why in one phrase.
          await page.locator('[data-testid="remote-workroom-history"] > summary').click();
          await page.getByTestId('remote-workroom-history-row').first().waitFor({ timeout: 15_000 });
          const whys = await page.getByTestId('remote-workroom-history-why').allInnerTexts();
          if (!whys.includes('이 AI는 이어 열기를 지원하지 않음') || !whys.includes('첫 요청 전에 끝나 저장된 대화 없음')) fail(`history reasons: ${JSON.stringify(whys)}`);
          if (!mac.state.actions.some(a => a.action === 'history.list' && a.detail)) fail('the history list did not ask for reasons');
          const rowText = await page.getByTestId('remote-workroom-history-row').first().innerText();
          if (!/앱 재시작으로 끊김/.test(rowText)) fail(`a detached row reads 「${rowText}」`);
        }
        if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
        if (foreign.length) fail(`requests left the page: ${[...new Set(foreign)].join(', ')}`);
        console.log(`${where}: checked`);
      } catch (error) {
        fail(`step failed — ${String(error.message).split('\n')[0]}`);
        if (shots) await page.screenshot({ path: `${shots}/${engineName}-${viewport.width}x${viewport.height}-failed.png` }).catch(() => {});
      } finally { await context.close(); }
    }

    // Without the resume grant: the sentence, no button that opens, and a hide that holds on this phone only.
    {
      const where = `${engineName} no-grant`;
      const fail = message => failures.push(`${where}: ${message}`);
      const { context, page, errors, mac } = await openPortal(browser, engineName, { width: 390, height: 844 }, { grant: false });
      try {
        const banner = page.locator(BANNER);
        await banner.waitFor({ timeout: 15_000 });
        await banner.getByTestId('remote-workroom-restart-toggle').click();
        await banner.getByTestId('remote-workroom-restart-grant').waitFor();
        for (const id of ['remote-workroom-restart-open-all', 'remote-workroom-restart-row-open', 'remote-workroom-restart-dismiss'])
          if (await banner.getByTestId(id).count()) fail(`${id} is shown without the resume grant`);
        if (shots) await page.screenshot({ path: `${shots}/${engineName}-restart-no-grant.png`, fullPage: engineName === 'webkit' }).catch(() => {});
        await banner.getByTestId('remote-workroom-restart-hide').click();
        await banner.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => fail('「이 휴대폰에서 숨기기」 did not hide it'));
        if (sent(mac, 'history.restart.dismiss').length) fail('hiding on the phone closed it on the Mac');
        await page.reload();
        await page.locator('.remote-workroom-content .ai-terminal-session-list [role=tab]').first().waitFor({ timeout: 20_000 });
        await sleep(2_000);
        if (await page.locator(BANNER).count()) fail('the hidden offer came back after a reload');
        if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
        console.log(`${where}: checked`);
      } catch (error) { fail(`step failed — ${String(error.message).split('\n')[0]}`); }
      finally { await context.close(); }
    }

    // Review: without ‘워크룸 대화 기록 보기’ the banner is not silent — how many, which permission, and hide on this phone.
    {
      const where = `${engineName} no-read`;
      const fail = message => failures.push(`${where}: ${message}`);
      const { context, page, errors, mac } = await openPortal(browser, engineName, { width: 390, height: 844 }, { read: false, grant: false });
      try {
        const banner = page.locator(BANNER);
        await banner.waitFor({ timeout: 15_000 });
        const label = await banner.getByTestId('remote-workroom-restart-toggle').innerText();
        if (!/업데이트 전 작업 세션 3개 · 보기/.test(label)) fail(`the folded banner says 「${label}」`);
        await banner.getByTestId('remote-workroom-restart-toggle').click();
        const sentence = await banner.getByTestId('remote-workroom-restart-read').innerText();
        if (!/워크룸 대화 기록 보기/.test(sentence)) fail(`the read sentence says 「${sentence}」`);
        if (await banner.getByTestId('remote-workroom-restart-row').count()) fail('rows are shown without the read grant');
        for (const id of ['remote-workroom-restart-open-all', 'remote-workroom-restart-dismiss']) if (await banner.getByTestId(id).count()) fail(`${id} is shown`);
        if (!(await banner.getByTestId('remote-workroom-restart-hide').count())) fail('no 「이 휴대폰에서 숨기기」');
        if (/블로그 글 목록|Hermes 채널/.test(await banner.innerText())) fail('a title reached a phone that may not read history');
        if (shots) await page.screenshot({ path: `${shots}/${engineName}-restart-no-read.png`, fullPage: engineName === 'webkit' }).catch(() => {});
        if (sent(mac, 'history.resume').length) fail('something was sent');
        if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
        console.log(`${where}: checked`);
      } catch (error) { fail(`step failed — ${String(error.message).split('\n')[0]}`); }
      finally { await context.close(); }
    }

    // Review: two sessions of one project and AI are told apart; one row's 「이어 열기」 opens that session's view.
    {
      const where = `${engineName} one-row`;
      const fail = message => failures.push(`${where}: ${message}`);
      const { context, page, errors, mac } = await openPortal(browser, engineName, { width: 390, height: 844 }, { twins: true });
      try {
        const banner = page.locator(BANNER);
        await banner.waitFor({ timeout: 15_000 });
        await banner.getByTestId('remote-workroom-restart-toggle').click();
        await banner.getByTestId('remote-workroom-restart-row').first().waitFor();
        const lines = await banner.locator('.workroom-restart-row-text small').allInnerTexts();
        if (new Set(lines).size !== 2 || !lines.every(text => /^\d+월 \d+일 \d\d:\d\d 시작 · 이어 열 수 있음$/.test(text))) fail(`twin rows: ${JSON.stringify(lines)}`);
        if (shots) await page.screenshot({ path: `${shots}/${engineName}-restart-twins.png`, fullPage: engineName === 'webkit' }).catch(() => {});
        await banner.getByTestId('remote-workroom-restart-row-open').nth(1).click();
        const confirm = banner.getByTestId('remote-workroom-restart-confirm');
        await confirm.waitFor({ timeout: 3_000 });
        if (!/「쇼핑몰 · Codex CLI \(.+ 시작\)」 대화를 다시 엽니다/.test(await confirm.innerText())) fail(`the confirmation says 「${await confirm.innerText()}」`);
        await sleep(600);
        await banner.getByTestId('remote-workroom-restart-confirm-open').click();
        const opened = await until(async () => (await page.getByTestId('workroom-session-view').count()) > 0, 15_000);
        if (!opened) fail('the reopened session did not open its view');
        const executes = sent(mac, 'history.resume.execute');
        if (executes.length !== 1 || executes[0].conversationId !== CONV.shop) fail(`executes: ${JSON.stringify(executes)}`);
        if (shots) await page.screenshot({ path: `${shots}/${engineName}-restart-one-row-opened.png` }).catch(() => {});
        if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
        console.log(`${where}: checked`);
      } catch (error) { fail(`step failed — ${String(error.message).split('\n')[0]}`); }
      finally { await context.close(); }
    }

    // 「닫기」: one dismiss, and it is gone.
    {
      const where = `${engineName} dismiss`;
      const fail = message => failures.push(`${where}: ${message}`);
      const { context, page, errors, mac } = await openPortal(browser, engineName, { width: 390, height: 844 }, {});
      try {
        const banner = page.locator(BANNER);
        await banner.waitFor({ timeout: 15_000 });
        await banner.getByTestId('remote-workroom-restart-toggle').click();
        await banner.getByTestId('remote-workroom-restart-dismiss').click();
        await banner.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => fail('「닫기」 did not close it'));
        if (sent(mac, 'history.restart.dismiss').length !== 1) fail(`dismiss requests: ${sent(mac, 'history.restart.dismiss').length}`);
        if (sent(mac, 'history.resume').length) fail('closing opened something');
        if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
        console.log(`${where}: checked`);
      } catch (error) { fail(`step failed — ${String(error.message).split('\n')[0]}`); }
      finally { await context.close(); }
    }
  } finally { await browser.close(); }
}

for (const note of notes) console.log('  ' + note);
if (failures.length) { console.error(`remote workroom restart FAIL (${failures.length})`); for (const failure of failures) console.error('  - ' + failure); process.exit(1); }
console.log('remote workroom restart PASS');
