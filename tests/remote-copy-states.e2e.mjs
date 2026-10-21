// What the phone says in states that are not errors and not "all good" (production audit 2026-10-16).
// Each case drives the real portal bundle with a real E2EE fake Mac behind a fake relay, as
// tests/remote-phone-offline.e2e.mjs does, and checks the words and tones on the screen:
//   silent-mac       — a Mac that stopped answering is not 「연결됨」 with a green check, and the stale-pairing card
//                      names a control that exists (the tab × went away in 7e1642e2)
//   list-loading     — the workroom does not say 「실행 중인 작업 세션이 없습니다」 before the first list answers, nor
//                      「…확인하고 있습니다」 when no list is being asked (no Mac)
//   community-states — no 「Mac 앱 업데이트 필요」 when no Mac is connected, or while the Mac's features are unknown
//   member-timeout   — a slow membership check is the network's card (no raw code, no migrations) and recovers;
//                      a verified page is kept through it
//   action-copy      — confirms and notices are sentences per action, not 「Pull 기능을 실행할까요?」/「Pull 요청을 완료」
//   ops-dates        — one Korean date format, also on an English-region phone
//   korean-labels    — no 「MAC APPROVAL REQUIRED」 or 「PROJECT」 badge
//
// Isolated: a portal build with fixture VITE_* values, every request routed by Playwright; no real
// network, no 3001, no live Supabase.
// Build: VITE_SUPABASE_URL=https://fixture-offline.supabase.co VITE_SUPABASE_ANON_KEY=<jwt-shaped> \
//          ./node_modules/.bin/vite build --config vite.portal.config.ts --outDir <dir>
// Run:   bun tests/remote-copy-states.e2e.mjs <dir> [chromium|webkit] [case] [screenshotDir]
import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { REMOTE_CONTROL_PROTOCOL_VERSION } from '../src/remoteControlProtocol.ts';
import { buildRemoteControlRelayPairingUrl, REMOTE_CONTROL_RELAY_SCHEMA_VERSION } from '../src/remoteControlRelayContract.ts';
import {
  decryptRemoteControlRelayEnvelope, deriveRemoteControlRelaySessionKey, encryptRemoteControlRelayEnvelope,
  exportRemoteControlRelayPublicKey, fingerprintRemoteControlRelayPublicKey, generateRemoteControlRelayKeyPair,
  importRemoteControlRelayPublicKey,
} from '../src/remoteControlRelayCrypto.ts';

// On a phone the 원격 작업 pane buttons sit behind 「더 보기」 after the sessions (w11): opened first when closed.
const openMore = async page => {
  const toggle = page.getByTestId('remote-workroom-more-toggle');
  if (await toggle.count() && await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
};

const root = resolve(process.argv[2] || 'dist-portal');
const ENGINE = process.argv[3] === 'webkit' ? webkit : chromium;
const ONLY = process.argv[4] || '';
const shots = process.argv[5] || '';
const PAGE = 'https://portal.test';
const SUPABASE = 'fixture-offline.supabase.co';
const ids = { host: '11111111-1111-4111-8111-111111111111', pairing: '22222222-2222-4222-8222-222222222222',
  session: '33333333-3333-4333-8333-333333333333', controller: '44444444-4444-4444-8444-444444444444' };
const encoder = new TextEncoder(), decoder = new TextDecoder();
const DAY = 86_400_000;
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function project(extra = {}) {
  return { controlId: 'C'.repeat(43), name: '테스트 프로젝트', port: 4317, kind: 'main', status: 'stopped',
    actions: ['start', 'folder.open', 'localhost.open', 'git.pull'], ...extra };
}

async function fixtureMac(opt = {}) {
  const keys = await generateRemoteControlRelayKeyPair();
  const hostPublicKey = await exportRemoteControlRelayPublicKey(keys.publicKey);
  const proj = project(opt.project);
  const projects = [proj];
  const state = { hostSend: null, hostReceive: null, hostSequence: 0, deliveries: [], accepted: new Map(), messages: [],
    approval: opt.approval ?? 'approved', hostLastSeenAt: () => new Date().toISOString(), listDelayMs: 0,
    capabilityFailures: opt.capabilityFailures ?? 0, memberHangMs: 0, memberChecks: 0 };
  const reply = async message => {
    state.hostSequence += 1;
    const seq = state.hostSequence;
    state.deliveries.push({ relaySequence: seq, envelope: await encryptRemoteControlRelayEnvelope({
      key: state.hostSend,
      metadata: { schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, messageId: crypto.randomUUID(), sessionId: ids.session,
        controllerId: ids.controller, sequence: seq, expiresAt: new Date(Date.now() + 9 * 60_000).toISOString() },
      plaintext: encoder.encode(JSON.stringify(message)),
    }) });
  };
  // Replies keep their order: a delayed reply holds the ones behind it, like the Mac answering one at a time.
  let chain = Promise.resolve();
  const later = (ms, message) => { chain = chain.then(() => sleep(ms)).then(() => reply(message)); return chain; };
  const now = message => { chain = chain.then(() => reply(message)); return chain; };
  const run = async message => {
    state.messages.push(message);
    if (message.type === 'controller.pair') {
      return now({ type: 'session.ready', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, sessionToken: 'T'.repeat(43), hostName: '테스트 Mac',
        expiresAt: new Date(Date.now() + 29 * DAY).toISOString(), idleExpiresAt: new Date(Date.now() + 29 * DAY).toISOString(),
        projects, projectCount: projects.length, nextPage: null });
    }
    if (message.type === 'action.request') {
      const base = { type: 'action.result', actionId: message.actionId };
      // A probe that fails on the Mac's side (not 「unsupported」) leaves the features unknown on the phone.
      if (message.action.startsWith('protocol.capabilities') && state.capabilityFailures > 0) {
        state.capabilityFailures -= 1;
        return now({ ...base, ok: false, error: { code: 'RATE_LIMITED', message: '잠시 뒤 다시 시도하세요.' } });
      }
      if (message.action === 'protocol.capabilities') return now({ ...base, ok: true, supportedFeatures: opt.features ?? [] });
      if (message.action === 'projects.list') return now({ ...base, ok: true, projects, page: message.page ?? 0, projectCount: projects.length, nextPage: null });
      if (message.action === 'workspace-roots.list') return now({ ...base, ok: true, workspaceRoots: [] });
      if (message.action === 'ops.status') return now({ ...base, ok: true, ops: opt.ops ?? { state: 'ready', backend: 'app-data', pendingCount: 0, lastSavedAt: null, syncState: null } });
      if (message.action === 'ops.memory.pending') return now({ ...base, ok: true, opsCandidates: opt.opsCandidates });
      if (['start', 'folder.open', 'localhost.open', 'git.pull'].includes(message.action)) return now({ ...base, ok: true, project: proj });
      return now({ ...base, ok: false, error: { code: 'ACTION_NOT_ALLOWED', message: '이 테스트 Mac에는 없는 동작입니다.' } });
    }
    if (message.type === 'terminal.request') {
      const op = message.request.operation;
      const ok = body => ({ type: 'terminal.result', requestId: message.request.requestId, ok: true, body });
      if (op === 'list') {
        const body = ok({ sessions: opt.withSession ? [{ id: SESSION_ID, targetId: proj.controlId, agent: 'claude', state: 'running',
          createdAt: new Date(Date.now() - 60_000).toISOString(), exitCode: null, cols: 80, rows: 24 }] : [] });
        if (state.listDelayMs) { void later(state.listDelayMs, body); return; }
        return now(body);
      }
      if (opt.withSession && op === 'read') return now(ok({ chunks: [], nextCursor: message.request.after ?? 0 }));
      if (opt.withSession && (op === 'resize' || op === 'input')) return now(ok({}));
      return now({ type: 'terminal.result', requestId: message.request.requestId, ok: false, error: '이 테스트 Mac에는 없는 요청입니다.' });
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
    portmgr_remote_control_session_status: () => [{ session_id: ids.session, controller_id: ids.controller, approval_state: state.approval,
      host_enabled: true, host_expires_at: new Date(Date.now() + 29 * DAY).toISOString(), session_expires_at: new Date(Date.now() + 29 * DAY).toISOString(),
      revoked_at: null, host_last_seen_at: state.hostLastSeenAt() }],
    portmgr_remote_control_controller_send_message: async args => {
      const envelope = { schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, messageId: args.p_message_id, sessionId: args.p_session_id,
        controllerId: args.p_controller_id, sequence: Number(args.p_sender_sequence), expiresAt: args.p_envelope_expires_at,
        nonce: args.p_nonce, ciphertext: args.p_ciphertext };
      if (state.accepted.has(envelope.messageId)) return [{ accepted: true }];
      state.accepted.set(envelope.messageId, envelope);
      await run(JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({ key: state.hostReceive, envelope }))));
      return [{ accepted: true }];
    },
    portmgr_remote_control_controller_receive_messages: args => state.deliveries
      .filter(d => d.relaySequence > Number(args.p_after_relay_seq))
      .map(({ relaySequence, envelope }) => ({ relay_seq: String(relaySequence), message_id: envelope.messageId, session_id: envelope.sessionId,
        controller_id: envelope.controllerId, sender_sequence: String(envelope.sequence), envelope_expires_at: envelope.expiresAt,
        nonce: envelope.nonce, ciphertext: envelope.ciphertext })),
    portmgr_remote_control_controller_ack_messages: () => 0,
  };
  const pairingUrl = query => buildRemoteControlRelayPairingUrl(`${PAGE}/remote/`, {
    schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, hostId: ids.host, pairingId: ids.pairing,
    pairingSecret: Buffer.alloc(32, 7).toString('base64url'), hostPublicKey, expiresAt: new Date(Date.now() + DAY).toISOString(),
  }).replace('/remote/#', `/remote/${query}#`);
  return { state, rpc, pairingUrl, noPairing: !!opt.noPairing };
}

async function openPortal(browser, mac, { locale = 'ko-KR' } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale, timezoneId: 'Asia/Seoul' });
  const page = await context.newPage();
  const errors = [], dialogs = [];
  let answer = 'accept';
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { dialogs.push({ type: d.type(), message: d.message() }); await (answer === 'accept' ? d.accept() : d.dismiss()); });
  await page.addInitScript(() => {
    const b = v => btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const exp = Math.floor(Date.now() / 1000) + 86_400;
    const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
    const token = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub: user.id, role: 'authenticated', exp, email: user.email })}.c2ln`;
    if (!localStorage.getItem('portmgr-auth')) localStorage.setItem('portmgr-auth', JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: 86_400, expires_at: exp, refresh_token: 'fixture-refresh', user }));
  });
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
      if (name === 'portmgr_is_member' && mac.state.memberHangMs) {
        mac.state.memberChecks += 1;
        await sleep(mac.state.memberHangMs);
        return route.fulfill({ json: true }).catch(() => {});
      }
      if (name && mac.rpc[name]) return route.fulfill({ json: await mac.rpc[name](route.request().postDataJSON() ?? {}) });
      if (url.pathname === '/auth/v1/user') return route.fulfill({ json: { id: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com', aud: 'authenticated', role: 'authenticated' } });
      return route.fulfill({ json: [] });
    }
    return route.abort();
  });
  await page.goto(mac.noPairing ? `${PAGE}/remote/?tab=workroom` : mac.pairingUrl('?tab=workroom'));
  return { context, page, errors, dialogs, answer: value => { answer = value; } };
}

const text = async l => (await l.textContent())?.trim() ?? '';
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
const connected = page => page.waitForFunction(() => document.querySelector('[data-testid="remote-connection-state"]')?.textContent === '연결됨', null, { timeout: 20_000 });

const results = [];
async function scenario(name, body) {
  if (ONLY && ONLY !== name) return;
  const started = Date.now();
  try { await body(); results.push({ name, ok: true, ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: String(error?.message ?? error) }); console.log(`FAIL ${name}\n  ${String(error?.message ?? error).split('\n').join('\n  ')}`); }
}

const browser = await ENGINE.launch();
try {
  await scenario('silent-mac', async () => {
    const mac = await fixtureMac();
    const { page, context, dialogs, answer, errors } = await openPortal(browser, mac);
    try {
      await connected(page);
      const pill = page.getByTestId('remote-connection-state');
      const liveness = page.getByTestId('remote-host-liveness');
      assert.match(await pill.getAttribute('class'), /remote-state--online/);
      // The Mac stops stamping the relay (asleep, quit, or this phone holds an old host identity).
      mac.state.hostLastSeenAt = () => new Date(Date.now() - 10 * 60_000).toISOString();
      await page.waitForFunction(() => /응답 없음/.test(document.querySelector('[data-testid="remote-host-liveness"]')?.textContent ?? ''), null, { timeout: 15_000 });
      await page.getByTestId('remote-stale-pairing').waitFor();
      const pillText = await text(pill);
      assert.notEqual(pillText, '연결됨', 'the pill does not say 연결됨 beside 「10분째 응답 없음」');
      assert.match(pillText, /응답 없음/);
      assert.match(await pill.getAttribute('class'), /remote-state--mac-silent/);
      assert.match(await page.locator('.remote-host-dot').first().getAttribute('class'), /remote-host-dot--mac-silent/);
      assert.equal(await page.getByTestId(`remote-host-tab-${ids.host}`).getAttribute('title'), `테스트 Mac · ${pillText}`);
      assert.match(await text(page.getByTestId('remote-host-tab-mac-silent')), /응답 없음/);
      assert.equal(await liveness.getAttribute('data-reach'), 'mac-silent', 'the liveness line is the warning tone');
      assert.doesNotMatch(await page.locator('[data-testid="remote-host-liveness"] svg').getAttribute('class'), /circle-check/, 'no green check beside 「응답 없음」');
      // The card names controls that exist: the tab × was removed (7e1642e2).
      const card = page.getByTestId('remote-stale-pairing');
      assert.doesNotMatch(await text(card), /×/);
      assert.equal(await page.locator('.remote-host-tab button').count(), 1, 'the tab still has only its select chip');
      const disconnect = card.getByTestId('remote-stale-pairing-disconnect');
      await disconnect.waitFor();
      answer('dismiss');
      await disconnect.click();
      await sleep(300);
      const asked = dialogs.at(-1)?.message ?? '';
      assert.match(asked, /연결만 해제할까요/, `the card's button asks first: ${asked}`);
      assert.equal(await page.locator('.remote-host-tab').count(), 1, 'declining keeps the Mac');
      // The settings summary names where the QR comes from: the Mac, not 「이 기기」 (this phone).
      const summary = await text(page.getByTestId('remote-connection-settings'));
      assert.doesNotMatch(summary, /이 기기에서 새 QR/);
      assert.match(summary, /Mac에서 새 QR/);
      await shot(page, `silent-mac-${ENGINE.name()}`);
      // Back to answering: back to 연결됨.
      mac.state.hostLastSeenAt = () => new Date().toISOString();
      await connected(page);
      assert.equal(await liveness.getAttribute('data-reach'), 'checked');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await scenario('list-loading', async () => {
    for (const withSession of [true, false]) {
      const mac = await fixtureMac({ withSession });
      // ?tab=workroom opens the Workroom itself (w11): its first list is slow from the start.
      mac.state.listDelayMs = 3_000;
      const { page, context } = await openPortal(browser, mac);
      try {
        await connected(page);
        await openMore(page);
        await page.getByRole('button', { name: '워크룸 이어가기', exact: true }).click();
        const seen = [];
        for (let i = 0; i < 40; i += 1) {
          const noSessions = await page.getByTestId('workroom-remote-no-sessions').count();
          const loading = await page.getByTestId('workroom-remote-sessions-loading').count();
          const tabs = await page.locator('.ai-terminal-tab').count();
          seen.push({ noSessions, loading, tabs });
          if (tabs || (!withSession && noSessions)) break;
          if (i === 3) await shot(page, `list-loading-${ENGINE.name()}`);
          await sleep(250);
        }
        assert.ok(seen.length > 4, 'the list reply really was slow');
        const before = seen.slice(0, -1);
        assert.ok(before.every(s => s.noSessions === 0), `no 「실행 중인 작업 세션이 없습니다」 before the first list answers: ${JSON.stringify(before.slice(0, 4))}`);
        assert.ok(before.some(s => s.loading === 1), 'a loading line is shown meanwhile');
        if (withSession) {
          assert.equal(seen.at(-1).tabs, 1, 'the running session appears');
        } else {
          assert.equal(seen.at(-1).noSessions, 1, 'an empty answer then says there are none');
          assert.match(await text(page.getByTestId('workroom-remote-no-sessions')), /실행 중인 작업 세션이 없습니다/);
        }
        assert.equal(await page.getByTestId('workroom-remote-sessions-loading').count(), 0, 'and the loading line is gone');
      } finally { await context.close(); }
    }
    // No Mac paired: the panel sends no list, so it must not say it is checking one (review 2026-10-16: the line
    // stayed up forever above 「작업할 기기를 연결하세요」).
    {
      const mac = await fixtureMac({ noPairing: true });
      const { page, context } = await openPortal(browser, mac);
      try {
        await openMore(page);
        await page.getByRole('button', { name: '워크룸 이어가기', exact: true }).click();
        await page.getByTestId('remote-view-only').waitFor({ timeout: 10_000 });
        await sleep(2_500);
        assert.equal(await page.getByTestId('workroom-remote-sessions-loading').count(), 0,
          'no 「…작업 세션을 확인하고 있습니다」 when nothing is being checked');
        assert.equal(await page.getByTestId('workroom-remote-no-sessions').count(), 0, 'nor 「없습니다」 — nothing was listed');
        await shot(page, `list-loading-no-mac-${ENGINE.name()}`);
      } finally { await context.close(); }
    }
  });

  await scenario('community-states', async () => {
    // No Mac paired: not 「Mac 앱 업데이트 필요」.
    {
      const mac = await fixtureMac({ noPairing: true });
      const { page, context } = await openPortal(browser, mac);
      try {
        await openMore(page);
        await page.getByTestId('remote-community-toggle').click();
        await page.getByTestId('remote-community-offline').waitFor({ timeout: 15_000 });
        assert.equal(await page.getByTestId('remote-community-update-required').count(), 0);
        assert.match(await text(page.getByTestId('remote-community-offline')), /Mac에 연결하면/);
        await shot(page, `community-no-mac-${ENGINE.name()}`);
      } finally { await context.close(); }
    }
    // Connected, but the features probe did not get an answer: checking, not 「update required」.
    {
      const mac = await fixtureMac({ capabilityFailures: 4, features: [] });
      const { page, context } = await openPortal(browser, mac);
      try {
        await connected(page);
        await openMore(page);
        await page.getByTestId('remote-community-toggle').click();
        await page.getByTestId('remote-community-checking').waitFor({ timeout: 5_000 }).catch(async error => {
          throw new Error(`${error.message}\n${(await page.locator('[data-testid^="remote-community"]').allTextContents()).join(' | ')}`);
        });
        assert.equal(await page.getByTestId('remote-community-update-required').count(), 0, 'unknown is not old');
      } finally { await context.close(); }
    }
    // A Mac that answered without the workspace feature is the one to update.
    {
      const mac = await fixtureMac({ features: [] });
      const { page, context } = await openPortal(browser, mac);
      try {
        await connected(page);
        await openMore(page);
        await page.getByTestId('remote-community-toggle').click();
        await page.getByTestId('remote-community-update-required').waitFor({ timeout: 10_000 });
        assert.equal(await page.getByTestId('remote-community-checking').count(), 0);
      } finally { await context.close(); }
    }
  });

  await scenario('member-timeout', async () => {
    // Cold load on a slow network: the network card, no raw code, no migrations — and it recovers by itself.
    {
      const mac = await fixtureMac();
      mac.state.memberHangMs = 14_000;
      const { page, context } = await openPortal(browser, mac);
      try {
        await page.waitForSelector('[data-testid="remote-membership-error"], [data-testid="remote-membership-network"]', { timeout: 30_000 });
        assert.equal(await page.getByTestId('remote-membership-error').count(), 0, 'a slow answer is not the locked card');
        const card = page.getByTestId('remote-membership-network');
        const cardText = await text(card);
        assert.doesNotMatch(cardText, /PORTAL_AUTH_|마이그레이션/, cardText);
        assert.doesNotMatch(cardText, /이 기기 로그인 초기화/);
        await shot(page, `member-timeout-${ENGINE.name()}`);
        mac.state.memberHangMs = 0;
        await connected(page).catch(async () => { throw new Error(`no recovery after the network got fast: ${await page.locator('main').innerText()}`); });
      } finally { await context.close(); }
    }
    // A verified page: a slow re-check keeps it.
    {
      const mac = await fixtureMac();
      const { page, context } = await openPortal(browser, mac);
      try {
        await connected(page);
        mac.state.memberHangMs = 14_000;
        const before = mac.state.memberChecks;
        await page.evaluate(() => new BroadcastChannel('portmgr-auth').postMessage({ event: 'SIGNED_IN', session: JSON.parse(localStorage.getItem('portmgr-auth')) }));
        for (let i = 0; i < 50 && mac.state.memberChecks === before; i += 1) await sleep(100);
        assert.ok(mac.state.memberChecks > before, 'the re-check really ran');
        await sleep(12_000);
        assert.equal(await page.getByTestId('remote-membership-error').count(), 0, 'a verified page is not thrown out for a slow answer');
        assert.equal(await page.getByTestId('remote-connection-state').count(), 1);
      } finally { await context.close(); }
    }
  });

  await scenario('action-copy', async () => {
    const mac = await fixtureMac();
    const { page, context, dialogs } = await openPortal(browser, mac);
    try {
      await connected(page);
      await openMore(page);
      await page.getByRole('button', { name: '프로젝트 관리', exact: true }).click();
      await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
      const checks = [
        { label: 'Pull', confirm: /git pull/, done: /git pull/ },
        { label: 'Finder', confirm: /Finder에서/, done: /Finder에서 .*열었습니다/ },
        { label: '브라우저', confirm: /브라우저에서/, done: /브라우저에서 .*열었습니다/ },
      ];
      for (const check of checks) {
        const button = page.locator('button', { hasText: new RegExp(`^\\s*${check.label}\\s*$`) }).first();
        await button.waitFor({ timeout: 10_000 });
        const asked = dialogs.length;
        await button.click();
        for (let i = 0; i < 40 && dialogs.length === asked; i += 1) await sleep(50);
        const question = dialogs.at(-1)?.message ?? '';
        assert.doesNotMatch(question, /기능을 실행할까요/, `confirm for ${check.label}: ${question}`);
        assert.match(question, check.confirm, `confirm for ${check.label}: ${question}`);
        await page.waitForFunction(() => /습니다/.test(document.querySelector('.remote-notice')?.textContent ?? '') && !/기다리는 중/.test(document.querySelector('.remote-notice')?.textContent ?? ''), null, { timeout: 10_000 });
        const notice = await text(page.locator('.remote-notice').first());
        assert.doesNotMatch(notice, /요청을 완료했습니다/, `notice for ${check.label}: ${notice}`);
        assert.match(notice, check.done, `notice for ${check.label}: ${notice}`);
      }
      await shot(page, `action-copy-${ENGINE.name()}`);
    } finally { await context.close(); }
  });

  await scenario('ops-dates', async () => {
    for (const locale of ['ko-KR', 'en-US']) {
      const created = '2026-10-15T23:40:00.000Z';
      const mac = await fixtureMac({
        ops: { state: 'ready', backend: 'app-data', pendingCount: 2, lastSavedAt: '2026-10-16T05:04:05.000Z', syncState: 'current' },
        opsCandidates: { revision: 'a'.repeat(64), candidates: [
          { id: 'cand-1', title: '휴대폰 원격 제어 결정', body: '`bun test`를 커밋 전에 돌린다.', evidence: '세션', baseRevision: 'b'.repeat(64), createdAt: created },
        ] },
      });
      const { page, context } = await openPortal(browser, mac, { locale });
      try {
        await connected(page);
        await openMore(page);
        await page.getByRole('button', { name: '프로젝트 관리', exact: true }).click();
        await page.getByTestId('remote-ops-controls').waitFor({ timeout: 30_000 });
        await page.getByTestId('remote-ops-review').click();
        await page.getByTestId('remote-ops-memory-candidates').waitFor({ timeout: 15_000 });
        const status = await text(page.getByTestId('remote-ops-status'));
        // 2026-10-16T05:04:05Z is 14:04 in Seoul; the year is this year's, so it is left out.
        const year = new Date().getFullYear() === 2026 ? '' : '2026년 ';
        assert.ok(status.endsWith(`마지막 저장 ${year}10월 16일 14:04`), `${locale}: ${status}`);
        const candidate = await text(page.locator('.remote-ops-candidate summary small').first());
        assert.equal(candidate, `${year}10월 16일 08:40`, `${locale}: ${candidate}`);
        await shot(page, `ops-dates-${locale}-${ENGINE.name()}`);
      } finally { await context.close(); }
    }
  });

  await scenario('korean-labels', async () => {
    {
      const mac = await fixtureMac({ approval: 'pending' });
      const { page, context } = await openPortal(browser, mac);
      try {
        await page.getByTestId('internet-remote-approval').waitFor({ timeout: 20_000 });
        const approval = await text(page.getByTestId('internet-remote-approval'));
        assert.doesNotMatch(approval, /APPROVAL|REQUIRED/, approval);
        assert.match(approval, /Mac 승인 필요/);
      } finally { await context.close(); }
    }
    {
      const mac = await fixtureMac();
      const { page, context } = await openPortal(browser, mac);
      try {
        await connected(page);
        await openMore(page);
        await page.getByRole('button', { name: '프로젝트 관리', exact: true }).click();
        const badge = page.locator('.remote-project-title span').first();
        await badge.waitFor({ timeout: 10_000 });
        assert.equal(await text(badge), '프로젝트');
      } finally { await context.close(); }
    }
  });
} finally {
  await browser.close();
}
const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({ engine: ENGINE.name(), passed: results.length - failed.length, failed: failed.length }, null, 0));
if (failed.length) process.exit(1);
