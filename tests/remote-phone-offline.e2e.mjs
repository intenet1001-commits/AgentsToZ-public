// The phone loses its own network (2026-10-10, iPhone 13 with Wi‑Fi off ~40 s): the web portal kept
// saying 「연결됨」, the workroom blamed the Mac for a request that never left the phone, and the
// membership card advised checking database migrations. This drives the real portal bundle with a
// real E2EE fake Mac behind a fake relay, and switches the browser context offline and back.
//
// Isolated: a portal build with fixture VITE_* values, every request routed by Playwright; no real
// network, no 3001, no live Supabase.
// Build: VITE_SUPABASE_URL=https://fixture-offline.supabase.co VITE_SUPABASE_ANON_KEY=<jwt-shaped> \
//          ./node_modules/.bin/vite build --config vite.portal.config.ts --outDir <dir>
// Run:   bun tests/remote-phone-offline.e2e.mjs <dir> [screenshotDir]
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
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
const PAGE = 'https://portal.test';
const SUPABASE = 'fixture-offline.supabase.co';
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const anon = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'anon', iss: 'supabase' })}.c2lnbmF0dXJlc2lnbmF0dXJl`;
const ids = { host: '11111111-1111-4111-8111-111111111111', pairing: '22222222-2222-4222-8222-222222222222',
  session: '33333333-3333-4333-8333-333333333333', controller: '44444444-4444-4444-8444-444444444444' };
const encoder = new TextEncoder(), decoder = new TextDecoder();
const DAY = 86_400_000;
const project = { controlId: 'C'.repeat(43), name: '테스트 프로젝트', port: 4317, kind: 'main', status: 'stopped', actions: ['start'] };

const SESSION_ID = '55555555-5555-4555-8555-555555555555';
/**
 * One fake Mac behind one fake relay. `phoneOffline`/`relayDown` decide which fetches fail.
 * `withSession` — the Mac has one running claude workroom session (for typing into the workroom).
 */
async function fixtureMac({ withSession = false } = {}) {
  const keys = await generateRemoteControlRelayKeyPair();
  const hostPublicKey = await exportRemoteControlRelayPublicKey(keys.publicKey);
  const state = {
    hostPublicKey, phoneOffline: false, relayDown: false, hostLastSeenAt: () => new Date().toISOString(),
    hostReceive: null, hostSend: null, hostSequence: 0, deliveries: [], accepted: new Map(), executed: new Map(),
    messages: [], memberChecks: 0, memberChecksWhileOffline: 0, failedSupabase: 0,
    // Relay calls (not the membership check) attempted while the phone was offline, and every send the
    // network swallowed — the held envelope must later arrive as exactly these bytes.
    relayCallsWhileOffline: 0, abortedSends: [], statusCalls: [],
    // The stored access token's refresh: `tokenDown` aborts it (DNS not up yet) even while the phone is "online".
    tokenCalls: 0, tokenOk: 0, tokenDown: false,
    // `refuseStart` — the Mac refuses 「실행」 (a real answer, not the network); `inputs` — what the workroom typed.
    refuseStart: false, inputs: [],
    // `memberDown` — only the membership RPC fails on the network while navigator says online (no 'online' event).
    memberDown: false,
  };
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
    state.messages.push(message);
    if (message.type === 'controller.pair') {
      return reply({ type: 'session.ready', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, sessionToken: 'T'.repeat(43), hostName: '테스트 Mac',
        expiresAt: new Date(Date.now() + 29 * DAY).toISOString(), idleExpiresAt: new Date(Date.now() + 29 * DAY).toISOString(),
        projects: [project], projectCount: 1, nextPage: null });
    }
    if (message.type === 'action.request') {
      const base = { type: 'action.result', actionId: message.actionId };
      if (message.action === 'protocol.capabilities') return reply({ ...base, ok: true, supportedFeatures: [] });
      if (message.action === 'projects.list') return reply({ ...base, ok: true, projects: [project], page: message.page ?? 0, projectCount: 1, nextPage: null });
      if (message.action === 'workspace-roots.list') return reply({ ...base, ok: true, workspaceRoots: [] });
      if (message.action === 'start' && state.refuseStart) return reply({ ...base, ok: false, error: { code: 'ACTION_NOT_ALLOWED', message: 'Mac이 이 실행을 거절했습니다(테스트).' } });
      if (message.action === 'start') return reply({ ...base, ok: true, project: { ...project, status: 'running', actions: ['stop'] } });
      if (message.action === 'ops.status') return reply({ ...base, ok: true, ops: { state: 'ready', backend: 'app-data', pendingCount: 0, lastSavedAt: null, syncState: null } });
      return reply({ ...base, ok: false, error: { code: 'ACTION_NOT_ALLOWED', message: '이 테스트 Mac에는 없는 동작입니다.' } });
    }
    if (message.type === 'terminal.request') {
      const op = message.request.operation;
      const ok = body => reply({ type: 'terminal.result', requestId: message.request.requestId, ok: true, body });
      if (op === 'list') return ok({ sessions: withSession ? [{ id: SESSION_ID, targetId: project.controlId, agent: 'claude', state: 'running',
        createdAt: new Date(Date.now() - 60_000).toISOString(), exitCode: null, cols: 80, rows: 24 }] : [] });
      if (withSession && op === 'read') return ok({ chunks: [], nextCursor: message.request.after ?? 0 });
      if (withSession && op === 'resize') return ok({});
      if (withSession && op === 'input') { state.inputs.push(message.request.data); return ok({}); }
      return reply({ type: 'terminal.result', requestId: message.request.requestId, ok: false, error: '이 테스트 Mac에는 없는 요청입니다.' });
    }
  };
  const rpc = {
    portmgr_is_member: () => { state.memberChecks += 1; return true; },
    portmgr_remote_control_claim_pairing: async args => {
      const peer = await importRemoteControlRelayPublicKey(args.p_controller_public_key);
      state.hostReceive = await deriveRemoteControlRelaySessionKey({ privateKey: keys.privateKey, peerPublicKey: peer,
        sessionId: ids.session, controllerId: ids.controller, direction: 'controller-to-host', usages: ['decrypt'] });
      state.hostSend = await deriveRemoteControlRelaySessionKey({ privateKey: keys.privateKey, peerPublicKey: peer,
        sessionId: ids.session, controllerId: ids.controller, direction: 'host-to-controller', usages: ['encrypt'] });
      return [{ session_id: ids.session, controller_id: ids.controller, host_id: ids.host, host_name: '테스트 Mac', host_public_key: hostPublicKey,
        host_public_key_fingerprint: await fingerprintRemoteControlRelayPublicKey(hostPublicKey), approval_state: 'pending',
        expires_at: new Date(Date.now() + 29 * DAY).toISOString() }];
    },
    // Approved at once: the SAS step is not what this test is about.
    portmgr_remote_control_session_status: () => [{ session_id: ids.session, controller_id: ids.controller, approval_state: 'approved',
      host_enabled: true, host_expires_at: new Date(Date.now() + 29 * DAY).toISOString(), session_expires_at: new Date(Date.now() + 29 * DAY).toISOString(),
      revoked_at: null, host_last_seen_at: state.hostLastSeenAt() }],
    portmgr_remote_control_controller_send_message: async args => {
      const envelope = { schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, messageId: args.p_message_id, sessionId: args.p_session_id,
        controllerId: args.p_controller_id, sequence: Number(args.p_sender_sequence), expiresAt: args.p_envelope_expires_at,
        nonce: args.p_nonce, ciphertext: args.p_ciphertext };
      const previous = state.accepted.get(envelope.messageId);
      if (previous) {
        // Like the real relay: an id may come again only as the exact same bytes.
        assert.deepEqual(previous, envelope, 'a retried message id must be byte-identical');
        return [{ accepted: true }];
      }
      state.accepted.set(envelope.messageId, envelope);
      state.executed.set(envelope.messageId, (state.executed.get(envelope.messageId) ?? 0) + 1);
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
  return { state, rpc, pairingUrl };
}

const freshSession = expiresAt => {
  const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, role: 'authenticated', exp: expiresAt, email: user.email })}.c2ln`;
  return { access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: expiresAt, refresh_token: 'fixture-refresh-2', user };
};

/** `expiredSession` — the stored access token expired an hour ago, so reading the session needs a token refresh. */
async function openPortal(browser, mac, { offlineFromStart = false, expiredSession = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 402, height: 874 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [], foreign = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(expired => {
    const b = v => btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const exp = Math.floor(Date.now() / 1000) + (expired ? -3_600 : 86_400);
    const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
    const token = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub: user.id, role: 'authenticated', exp, email: user.email })}.c2ln`;
    if (!localStorage.getItem('portmgr-auth')) localStorage.setItem('portmgr-auth', JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: 86_400, expires_at: exp, refresh_token: 'fixture-refresh', user }));
  }, expiredSession);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === PAGE) {
      const path = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
      if (!path.startsWith(root + '/')) return route.abort();
      const file = Bun.file(path);
      return await file.exists() ? route.fulfill({ body: Buffer.from(await file.arrayBuffer()), contentType: file.type }) : route.fulfill({ status: 404, body: '' });
    }
    if (url.hostname === SUPABASE) {
      const name = url.pathname.startsWith('/rest/v1/rpc/') ? url.pathname.slice('/rest/v1/rpc/'.length) : '';
      if (name === 'portmgr_is_member' && mac.state.phoneOffline) mac.state.memberChecksWhileOffline += 1;
      if (name.startsWith('portmgr_remote_control_') && mac.state.phoneOffline) mac.state.relayCallsWhileOffline += 1;
      if (name === 'portmgr_remote_control_session_status') mac.state.statusCalls.push(Date.now());
      if (name === 'portmgr_remote_control_controller_send_message' && (mac.state.phoneOffline || mac.state.relayDown)) {
        mac.state.abortedSends.push(route.request().postDataJSON());
      }
      if (url.pathname === '/auth/v1/token') {
        mac.state.tokenCalls += 1;
        if (mac.state.phoneOffline || mac.state.tokenDown) { mac.state.failedSupabase += 1; return route.abort('internetdisconnected'); }
        mac.state.tokenOk += 1;
        return route.fulfill({ json: freshSession(Math.floor(Date.now() / 1000) + 3_600) });
      }
      // A phone without network: every fetch fails the way WebKit/Chromium fail it.
      if (mac.state.phoneOffline || (mac.state.relayDown && name.startsWith('portmgr_remote_control_'))
        || (mac.state.memberDown && name === 'portmgr_is_member')) {
        mac.state.failedSupabase += 1;
        return route.abort('internetdisconnected');
      }
      if (name && mac.rpc[name]) {
        const args = route.request().postDataJSON() ?? {};
        return route.fulfill({ json: await mac.rpc[name](args) });
      }
      if (url.pathname === '/auth/v1/user') return route.fulfill({ json: { id: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com', aud: 'authenticated', role: 'authenticated' } });
      return route.fulfill({ json: [] });
    }
    foreign.push(url.origin); return route.abort();
  });
  if (offlineFromStart) {
    // Assets are served by the route above; only the app's own requests fail.
    mac.state.phoneOffline = true;
  }
  await page.goto(mac.pairingUrl('?tab=workroom'));
  if (offlineFromStart) await context.setOffline(true);
  return { context, page, errors, foreign };
}

const text = async locator => (await locator.textContent())?.trim() ?? '';
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
const workroomError = page => page.locator('.ai-terminal-error');

const browser = await chromium.launch();
try {
  // ── An online session loses the phone's network and gets it back ──────────────────────────────
  {
    const mac = await fixtureMac();
    const { context, page, errors, foreign } = await openPortal(browser, mac);
    const pill = page.getByTestId('remote-connection-state');
    const liveness = page.getByTestId('remote-host-liveness');
    await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 20_000 });
    await page.getByRole('button', { name: '워크룸 이어가기', exact: true }).click();
    await page.getByTestId('workroom-remote-no-sessions').waitFor({ timeout: 15_000 });
    assert.match(await text(liveness), /응답 중/);
    assert.equal(await page.locator('.remote-alert').count(), 0, `a clean start: ${await page.locator('.remote-alert').allTextContents()}`);

    // Control: a Mac that really went quiet (with this phone online) is still called that.
    mac.state.hostLastSeenAt = () => new Date(Date.now() - 10 * 60_000).toISOString();
    await page.waitForFunction(() => /응답 없음/.test(document.querySelector('[data-testid="remote-host-liveness"]')?.textContent ?? ''), null, { timeout: 10_000 });
    await page.getByTestId('remote-stale-pairing').waitFor();

    // ── The phone goes offline (the Mac's stamp stays frozen and old) ──
    mac.state.phoneOffline = true;
    await context.setOffline(true);
    await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '휴대폰 오프라인', null, { timeout: 5_000 });
    await page.getByTestId('remote-phone-offline').waitFor();
    assert.match(await text(page.getByTestId('remote-phone-offline')), /휴대폰이 인터넷에 연결되어 있지 않습니다/);
    // Offline, the 1 s poll and the workroom ask nothing of the relay (a request already in flight at the
    // switch may still fail, so count from here).
    await page.waitForTimeout(300);
    const relayCallsAtOffline = mac.state.relayCallsWhileOffline;
    assert.equal(await text(page.getByTestId(`remote-host-tab-phone-offline`)), '휴대폰 오프라인', 'host tab names the phone');
    assert.match(await text(liveness), /휴대폰 오프라인/);
    assert.doesNotMatch(await text(liveness), /응답 없음|절전/, 'the outage is not the Mac sleeping');
    assert.equal(await page.getByTestId('remote-stale-pairing').count(), 0, 'no 「QR 다시 스캔」 for the phone\'s own outage');
    // The workroom's next poll is refused on the phone, and says so.
    await workroomError(page).waitFor({ timeout: 12_000 });
    const workroomText = await text(workroomError(page));
    assert.match(workroomText, /휴대폰/, `workroom error names the phone: ${workroomText}`);
    assert.doesNotMatch(workroomText, /결과를 Mac이 아직 보내지 않았습니다|Load failed|Failed to fetch/);
    // auth-js re-emits SIGNED_IN (another tab, a recovered session); offline, the membership re-check
    // that follows fails — and must not lock the page. Sent the way auth-js's own tabs send it.
    const checksBefore = mac.state.memberChecksWhileOffline;
    const failedBefore = mac.state.failedSupabase;
    await page.evaluate(() => new BroadcastChannel('portmgr-auth').postMessage({ event: 'SIGNED_IN', session: JSON.parse(localStorage.getItem('portmgr-auth')) }));
    for (let wait = 0; wait < 50 && mac.state.memberChecksWhileOffline === checksBefore; wait += 1) await page.waitForTimeout(100);
    await page.waitForTimeout(1_000);
    assert.ok(mac.state.memberChecksWhileOffline > checksBefore, 'the membership re-check really ran while offline');
    assert.equal(await page.getByTestId('remote-membership-error').count(), 0, 'no migration card');
    assert.equal(await page.getByTestId('remote-membership-network').count(), 0, 'a verified page stays verified through the outage');
    assert.equal(await page.getByText(/마이그레이션/).count(), 0);
    assert.equal(await text(pill), '휴대폰 오프라인');
    // The yellow banner already says it; a red alert beside it for a request that was never sent is noise.
    assert.equal(await page.locator('.remote-alert').count(), 0, `no red alert while offline: ${await page.locator('.remote-alert').allTextContents()}`);
    assert.equal(await liveness.getAttribute('data-reach'), 'phone-offline', 'the liveness line is the warning tone, not the green check');
    assert.equal(mac.state.relayCallsWhileOffline, relayCallsAtOffline, `no relay request while offline (${mac.state.relayCallsWhileOffline - relayCallsAtOffline} made)`);
    await shot(page, 'phone-offline');

    // ── The network returns ──
    mac.state.hostLastSeenAt = () => new Date().toISOString();
    mac.state.phoneOffline = false;
    const checksAtReturn = mac.state.memberChecks;
    const statusCallsAtReturn = mac.state.statusCalls.length;
    const returnedAt = Date.now();
    await context.setOffline(false);
    await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 5_000 });
    await page.waitForFunction(() => /응답 중/.test(document.querySelector('[data-testid="remote-host-liveness"]')?.textContent ?? ''), null, { timeout: 5_000 });
    assert.equal(await page.getByTestId('remote-phone-offline').count(), 0);
    assert.equal(await page.getByTestId('remote-stale-pairing').count(), 0);
    // 'online' refreshes at once; the 1 s interval alone would usually be later (checked again below, three times).
    assert.ok(mac.state.statusCalls[statusCallsAtReturn] - returnedAt < 400, `first status read ${mac.state.statusCalls[statusCallsAtReturn] - returnedAt} ms after 'online'`);
    // The workroom re-reads on 'online' too: its offline sentence goes at once, not at the next list poll.
    await workroomError(page).waitFor({ state: 'detached', timeout: 2_500 });
    await page.getByTestId('workroom-remote-no-sessions').waitFor();
    await page.waitForFunction(() => true);
    for (let wait = 0; wait < 50 && mac.state.memberChecks === checksAtReturn; wait += 1) await page.waitForTimeout(100);
    assert.ok(mac.state.memberChecks > checksAtReturn, 'membership is checked again once the network is back');
    assert.equal(await page.locator('.remote-alert').count(), 0, `no leftover alert: ${await page.locator('.remote-alert').allTextContents()}`);
    await shot(page, 'phone-back-online');

    // Immediate refresh on 'online', measured three more times: a 1 s interval tick lands within 400 ms by chance
    // about 40% of the time, all three times about 6%.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      mac.state.phoneOffline = true;
      await context.setOffline(true);
      await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '휴대폰 오프라인', null, { timeout: 5_000 });
      await page.waitForTimeout(1_300 + cycle * 170);
      mac.state.phoneOffline = false;
      const before = mac.state.statusCalls.length;
      const at = Date.now();
      await context.setOffline(false);
      for (let wait = 0; wait < 40 && mac.state.statusCalls.length === before; wait += 1) await page.waitForTimeout(25);
      assert.ok(mac.state.statusCalls[before] - at < 400, `cycle ${cycle}: first status read ${mac.state.statusCalls[before] - at} ms after 'online'`);
      await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 5_000 });
    }

    // ── navigator says online, but requests fail (captive Wi‑Fi): the failed send decides the words ──
    // Sends swallowed at the earlier offline switches were held and delivered already; count this phase only.
    mac.state.abortedSends.length = 0;
    mac.state.relayDown = true;
    await page.waitForFunction(() => /휴대폰 네트워크|릴레이에 연결하지 못함/.test(document.querySelector('[data-testid="remote-host-liveness"]')?.textContent ?? ''), null, { timeout: 5_000 });
    // A read already on its way when the relay went down may first report its unread answer (that sentence names
    // the phone too); the next poll is the one held on the phone.
    await page.waitForFunction(() => /휴대폰 네트워크/.test(document.querySelector('.ai-terminal-error')?.textContent ?? ''), null, { timeout: 15_000 });
    const unsent = await text(workroomError(page));
    assert.match(unsent, /휴대폰 네트워크/, `unsent request names the phone network: ${unsent}`);
    assert.match(unsent, /한 번만/, 'and says the request is sent once later');
    assert.doesNotMatch(unsent, /결과를 Mac이 아직 보내지 않았습니다/);
    // navigator.onLine is true, so not 「휴대폰 오프라인」 — but not 「연결됨」 either, beside a line that says the relay is out of reach.
    await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '휴대폰 네트워크 확인', null, { timeout: 5_000 });
    assert.equal(await liveness.getAttribute('data-reach'), 'relay-unreachable');
    assert.equal(await page.getByTestId('remote-stale-pairing').count(), 0);
    const held = [...new Set(mac.state.abortedSends.map(args => args.p_message_id))];
    assert.equal(held.length, 1, `one envelope held on the phone, retried only as itself: ${held}`);
    const firstAttempt = mac.state.abortedSends.find(args => args.p_message_id === held[0]);
    mac.state.relayDown = false;
    await workroomError(page).waitFor({ state: 'detached', timeout: 15_000 });
    // The kept request itself — not any later one — was delivered, byte for byte, and ran once.
    const delivered = mac.state.accepted.get(held[0]);
    assert.ok(delivered, 'the held envelope was delivered after the relay came back');
    assert.equal(delivered.nonce, firstAttempt.p_nonce);
    assert.equal(delivered.ciphertext, firstAttempt.p_ciphertext);
    assert.equal(delivered.sequence, Number(firstAttempt.p_sender_sequence));
    assert.equal(mac.state.executed.get(held[0]), 1);
    // Exactly once: every message the phone ever sent ran once on the Mac.
    for (const [messageId, count] of mac.state.executed) assert.equal(count, 1, `message ${messageId} ran ${count} times`);

    assert.deepEqual(foreign, []);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`ok online → offline → online (${mac.state.messages.length} messages, each executed once; ${mac.state.failedSupabase} failed fetches)`);
  }

  // ── A cold load with no network never shows the app as verified, and recovers by itself ──────
  {
    const mac = await fixtureMac();
    const { context, page, errors } = await openPortal(browser, mac, { offlineFromStart: true });
    const card = page.getByTestId('remote-membership-network');
    await card.waitFor({ timeout: 20_000 });
    assert.match(await text(card), /네트워크에 연결되지 않아/);
    assert.doesNotMatch(await text(card), /마이그레이션/);
    assert.equal(await page.getByTestId('remote-membership-error').count(), 0);
    assert.equal(await page.getByTestId('remote-host-liveness').count(), 0, 'nothing of the signed-in app is shown');
    assert.equal(await text(page.getByTestId('remote-connection-state')), '휴대폰 오프라인');
    await page.getByTestId('remote-phone-offline').waitFor();
    await shot(page, 'cold-offline');
    mac.state.phoneOffline = false;
    await context.setOffline(false);
    await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 20_000 });
    assert.equal(await card.count(), 0);
    assert.ok(mac.state.memberChecks >= 1, 'membership was verified before the app was shown');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('ok cold offline load → network card → verified after reconnect');
  }

  // ── A tap while offline, and a tap while the relay is out of reach (navigator online) ─────────────────────
  {
    const mac = await fixtureMac();
    const { context, page, errors } = await openPortal(browser, mac);
    const dialogs = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
    await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 20_000 });
    await page.getByRole('button', { name: '프로젝트 관리', exact: true }).click();
    const start = page.locator('[data-action="start"]').first();
    await start.waitFor({ timeout: 15_000 });

    // Offline: this tap is not sent and is not waiting anywhere — and the page says so, without asking to confirm.
    mac.state.phoneOffline = true;
    await context.setOffline(true);
    await page.getByTestId('remote-phone-offline').waitFor();
    await start.click();
    const notice = page.locator('.remote-notice');
    await notice.waitFor({ timeout: 3_000 });
    assert.match(await text(notice), /실행 요청은 보내지 않았습니다/);
    assert.doesNotMatch(await text(notice), /요청을 보냈습니다/);
    assert.equal(dialogs.length, 0, 'no confirm for a tap that cannot be sent');
    await page.waitForTimeout(500);
    assert.equal(mac.state.messages.filter(message => message.action === 'start').length, 0);

    mac.state.phoneOffline = false;
    await context.setOffline(false);
    await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 5_000 });
    // 「휴대폰이 오프라인입니다」 is present tense: it goes with the outage (review 2026-10-10).
    await page.waitForFunction(() => !/휴대폰이 오프라인입니다/.test(document.querySelector('.remote-notice')?.textContent ?? ''), null, { timeout: 3_000 });

    const alert = page.locator('.remote-alert');
    // A held tap the Mac then refuses: the refusal replaces the 「한 번만」 alert and stays — the next 1 s poll
    // clears status.error, and the outcome used to vanish with it (review 2026-10-10).
    mac.state.refuseStart = true;
    mac.state.relayDown = true;
    await start.click();
    await alert.waitFor({ timeout: 5_000 });
    assert.match(await text(alert), /한 번만/);
    mac.state.relayDown = false;
    await page.waitForFunction(() => /거절했습니다\(테스트\)/.test(document.querySelector('.remote-alert')?.textContent ?? ''), null, { timeout: 10_000 });
    await page.waitForTimeout(3_000);
    assert.match(await text(alert), /거절했습니다\(테스트\)/, `the Mac's refusal of the held tap is still shown 3 s later: ${await text(alert)}`);
    assert.equal(mac.state.messages.filter(message => message.action === 'start').length, 1, 'the refused tap reached the Mac once');
    mac.state.refuseStart = false;
    mac.state.abortedSends.length = 0;

    // The relay is out of reach (captive Wi‑Fi): the tap is held on the phone, and the alert that says so is not
    // replaced by the 1 s poll's bare 「네트워크가 잠시 끊겼습니다」.
    mac.state.relayDown = true;
    await start.click();
    await alert.waitFor({ timeout: 5_000 });
    assert.match(await text(alert), /한 번만/, `the held request's alert: ${await text(alert)}`);
    await page.waitForTimeout(4_000);
    const later = await text(alert);
    assert.match(later, /한 번만/, `still the held request's alert 4 s later: ${later}`);
    assert.doesNotMatch(later, /잠시 끊겼습니다/);
    assert.equal(await text(page.getByTestId('remote-connection-state')), '휴대폰 네트워크 확인');
    await shot(page, 'relay-unreachable-held');
    const heldId = mac.state.abortedSends.find(args => args.p_message_id)?.p_message_id;
    assert.ok(heldId);

    mac.state.relayDown = false;
    for (let wait = 0; wait < 100 && !mac.state.executed.get(heldId); wait += 1) await page.waitForTimeout(100);
    assert.equal(mac.state.executed.get(heldId), 1, 'the held tap ran once after the relay came back');
    assert.equal(mac.state.messages.filter(message => message.action === 'start').length, 2);
    // Once the request has left the phone, its alert goes — and says what happened instead of nothing.
    await alert.waitFor({ state: 'detached', timeout: 6_000 });
    await page.waitForFunction(() => /보관했던 요청을 다시 연결된 뒤 Mac에 한 번 보냈습니다/.test(document.querySelector('.remote-notice')?.textContent ?? ''), null, { timeout: 3_000 });
    await page.waitForTimeout(2_500);
    assert.match(await text(page.locator('.remote-notice')), /한 번 보냈습니다/, 'the outcome outlasts the next polls');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('ok offline tap refused with its own notice; held taps kept their alert, ran once, and left their outcome');
  }

  // ── Typing into the workroom while offline keeps the text; the offline sentence goes with the outage ──────
  {
    const mac = await fixtureMac({ withSession: true });
    const { context, page, errors } = await openPortal(browser, mac);
    await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 20_000 });
    await page.getByRole('button', { name: '워크룸 이어가기', exact: true }).click();
    await page.locator('.ai-terminal-tab').first().waitFor({ timeout: 20_000 });
    await page.locator('.ai-terminal-tab').first().click();
    const composer = page.getByLabel('워크룸 입력');
    await composer.waitFor({ timeout: 20_000 });
    mac.state.phoneOffline = true;
    await context.setOffline(true);
    await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '휴대폰 오프라인', null, { timeout: 5_000 });
    await composer.fill('긴 작업 지시: 테스트 문장');
    await composer.press('Enter');
    await workroomError(page).waitFor({ timeout: 3_000 });
    assert.match(await text(workroomError(page)), /입력을 보내지 않았습니다.*그대로 두었습니다/);
    assert.equal(await composer.inputValue(), '긴 작업 지시: 테스트 문장', 'the typed text is still in the box');
    assert.deepEqual(mac.state.inputs, []);
    mac.state.phoneOffline = false;
    await context.setOffline(false);
    await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 8_000 });
    // The header says 「연결됨」; the workroom must not keep saying the opposite.
    await page.waitForFunction(() => !/연결되어 있지 않/.test(document.querySelector('.ai-terminal-error')?.textContent ?? ''), null, { timeout: 4_000 });
    await composer.press('Enter');
    for (let wait = 0; wait < 60 && !mac.state.inputs.length; wait += 1) await page.waitForTimeout(100);
    assert.ok(mac.state.inputs.join('').includes('긴 작업 지시: 테스트 문장'), `the kept text went once it could: ${JSON.stringify(mac.state.inputs)}`);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('ok workroom input offline kept in the box; its notice cleared on reconnect; sent afterwards');
  }

  // ── navigator online, the membership check fails on the network: no 'online' event comes, the page retries ──
  {
    const mac = await fixtureMac();
    mac.state.memberDown = true;
    const { context, page, errors } = await openPortal(browser, mac);
    const card = page.getByTestId('remote-membership-network');
    await card.waitFor({ timeout: 20_000 });
    assert.match(await text(card), /회원 권한을/);
    assert.match(await text(card), /잠시 뒤 저절로 다시 확인합니다/);
    assert.doesNotMatch(await text(card), /마이그레이션/);
    mac.state.memberDown = false;
    // Recovered by the bounded retry timer (every 10 s), without a click.
    await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 25_000 });
    assert.deepEqual(errors, []);
    await context.close();
    console.log('ok membership check failing online retried by itself, no click');
  }

  // ── A verified page whose session read fails on the network still hears a sign-out ─────────────────────────
  {
    const mac = await fixtureMac();
    const { context, page, errors } = await openPortal(browser, mac);
    const signedOut = page.getByRole('heading', { name: '내 개인 배포본으로 로그인' });
    await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 20_000 });
    mac.state.phoneOffline = true;
    await context.setOffline(true);
    await page.getByTestId('remote-phone-offline').waitFor();
    // An offline re-check (auth-js re-emits SIGNED_IN) leaves a re-verify pending...
    const before = mac.state.memberChecksWhileOffline;
    await page.evaluate(() => new BroadcastChannel('portmgr-auth').postMessage({ event: 'SIGNED_IN', session: JSON.parse(localStorage.getItem('portmgr-auth')) }));
    for (let wait = 0; wait < 50 && mac.state.memberChecksWhileOffline === before; wait += 1) await page.waitForTimeout(100);
    // ...the access token expires, and 'online' fires before the network works, then the phone drops again: the
    // session read (a token refresh) fails on the network and the page keeps its verified account.
    await page.evaluate(() => { const stored = JSON.parse(localStorage.getItem('portmgr-auth')); stored.expires_at = Math.floor(Date.now() / 1000) - 60; localStorage.setItem('portmgr-auth', JSON.stringify(stored)); });
    mac.state.tokenDown = true;
    await context.setOffline(false);
    await page.waitForTimeout(400);
    await context.setOffline(true);
    await page.waitForTimeout(12_000);
    assert.equal(await page.getByTestId('remote-host-liveness').count(), 1, 'the verified page is kept through the network failure');
    assert.equal(await page.getByTestId('remote-membership-error').count(), 0);
    assert.equal(await page.getByTestId('remote-membership-network').count(), 0);
    assert.ok(mac.state.tokenCalls >= 1, 'the session read did try a token refresh');
    // Another tab signs out (the way auth-js tabs broadcast it): the page must follow (review 2026-10-10).
    await page.evaluate(() => { localStorage.removeItem('portmgr-auth'); new BroadcastChannel('portmgr-auth').postMessage({ event: 'SIGNED_OUT', session: null }); });
    await signedOut.waitFor({ timeout: 5_000 });
    assert.equal(await page.getByTestId('remote-host-liveness').count(), 0, 'nothing of the signed-in app stays after a sign-out');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('ok a verified page kept through a session-read network failure still follows a sign-out');
  }

  // ── A cold offline load with an expired session: the network card, then recovery without a click ───────────
  {
    const mac = await fixtureMac();
    const loadedAt = Date.now();
    const { context, page, errors } = await openPortal(browser, mac, { offlineFromStart: true, expiredSession: true });
    const card = page.getByTestId('remote-membership-network');
    await card.waitFor({ timeout: 20_000 });
    // The session read failed (not the membership RPC): it says so, never migrations, never 「로그인 초기화」.
    assert.match(await text(card), /로그인 상태를/);
    assert.doesNotMatch(await text(card), /마이그레이션/);
    assert.equal(await page.getByTestId('remote-membership-error').count(), 0);
    assert.equal(await page.getByText('이 기기 로그인 초기화').count(), 0);
    assert.equal(await page.getByTestId('remote-host-liveness').count(), 0, 'nothing of the signed-in app is shown');
    // Long enough for auth-js to give up its refresh retries and hold the failure for 60 s.
    await page.waitForTimeout(Math.max(0, 40_000 - (Date.now() - loadedAt)));
    assert.equal(await page.getByTestId('remote-membership-error').count(), 0);
    mac.state.phoneOffline = false;
    const onlineAt = Date.now();
    await context.setOffline(false);
    await page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 100_000 });
    assert.ok(mac.state.tokenOk >= 1 && mac.state.memberChecks >= 1, 'a refreshed session and a membership check came before the app');
    assert.equal(await card.count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`ok cold offline load with an expired session recovered ${Math.round((Date.now() - onlineAt) / 1000)} s after 'online', no click`);
  }
} finally {
  await browser.close();
}
