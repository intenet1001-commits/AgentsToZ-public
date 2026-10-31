import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  base64, createScreenPushHandler, decodeEvent, decodeWeeklyUsage, hex, LABELS, RATE_LIMITS, sha256, USAGE_MAX_AGE_MS, verifySignature,
  weeklyUsageKey, weeklyUsagePayload, weeklyUsageText, type ApnsSender, type PushTarget, type ScreenPushDeps,
} from '../supabase/functions/screen-push/protocol';
import * as kit from './screenPushTestKit';

// The weekly allowance alert through the push relay (docs/claude/remote-control.md 「문턱 알림 푸시」): the main app decides
// (src/weeklyUsageAlerts.ts), AgentsToZ Screen signs with the Mac key the phone pinned, the relay checks that signature and
// pushes a banner built only from the signed fields. Screen events (kinds 1–4) keep their layout and budget unchanged.
const vectors = JSON.parse(readFileSync(new URL('../native/screen-control/Tests/PushContract/vectors.json', import.meta.url), 'utf8'));
const b = kit.bytes;
const TOPIC = 'com.intenet.agentstoz.mobile.testflight';
const NOW = 1_800_000_000_000;

interface Call { name: string; args: Record<string, any> }
function relay(answers: Record<string, unknown> = {}, apns: ApnsSender | null = null) {
  const calls: Call[] = [];
  const deps: ScreenPushDeps = {
    rpc: async (name, args) => { calls.push({ name, args }); return name in answers ? answers[name] : 'ok'; },
    apns, allowedTopics: [TOPIC], now: () => NOW, randomHex: n => '0'.repeat(n * 2),
  };
  return { calls, handler: createScreenPushHandler(deps) };
}
const post = (body: unknown) => new Request('https://relay.invalid/screen-push', { method: 'POST', body: JSON.stringify(body) });
const signedBody = async (type: string, message: Uint8Array, signer: kit.TestKey) =>
  ({ type, message: base64(message), signature: base64(await signer.sign(message)) });
function recordingApns(status = 200) {
  const sent: { target: PushTarget; payload: string; expiresAt: number; collapseID: string }[] = [];
  const apns: ApnsSender = { send: async (target, payload, expiresAt, collapseID) => { sent.push({ target, payload, expiresAt, collapseID }); return { status }; } };
  return { sent, apns };
}

test('the relay reads the Swift weekly-usage layout and CryptoKit-compatible signature (contract vector)', async () => {
  const pair = vectors.weeklyUsage;
  const usage = decodeWeeklyUsage(b(pair.message));
  expect([hex(usage.macKey), usage.macName, usage.provider, usage.mark, usage.windowKey, usage.observedAt, usage.issuedAt, hex(usage.nonce)])
    .toEqual([vectors.macPublic, vectors.macName, 'codex', pair.mark, pair.windowKey, vectors.eventAt, vectors.issuedAt, vectors.nonce]);
  expect(usage.recipients.map(hex)).toEqual([hex(await sha256(b(vectors.devicePublic))), hex(await sha256(b(vectors.otherPublic)))]);
  expect(await verifySignature(usage.macKey, b(pair.message), b(pair.signature))).toBe(true);
  expect(await verifySignature(b(vectors.devicePublic), b(pair.message), b(pair.signature))).toBe(false);
  expect(weeklyUsageKey(usage)).toBe('codex:r498056:30');
});

test('the weekly-usage reader is strict and never crosses with a screen event', async () => {
  const mac = await kit.testKey('usage strict mac'), phone = await kit.testKey('usage strict phone');
  const base = { mac, macName: 'Mac', provider: 1, mark: 30, windowKey: 'r498056', observedAt: NOW, recipients: [phone.fingerprint], issuedAt: NOW, nonce: kit.nonceOf(1) };
  expect(decodeWeeklyUsage(kit.weeklyUsage(base)).provider).toBe('claude');
  expect(decodeWeeklyUsage(kit.weeklyUsage({ ...base, provider: 3, mark: 0, windowKey: 'w2026-W44' }))).toMatchObject({ provider: 'agy', mark: 0, windowKey: 'w2026-W44' });
  for (const bad of [
    { provider: 0 }, { provider: 4 }, { mark: 35 }, { mark: 100 }, { mark: 5 },
    { windowKey: 'r' }, { windowKey: 'r1234567890' }, { windowKey: 'x123' }, { windowKey: 'w2026-W4' }, { windowKey: 'r12\n' }, { windowKey: 'ｒ12' },
    { macName: '' }, { macName: 'Mac‮koob' }, { macName: 'x'.repeat(65) },
    { recipients: [phone.fingerprint, phone.fingerprint] }, { recipients: Array.from({ length: 17 }, (_, n) => new Uint8Array(32).fill(n + 1)) },
  ]) expect(() => decodeWeeklyUsage(kit.weeklyUsage({ ...base, ...bad }))).toThrow('malformed');
  expect(() => decodeWeeklyUsage(new Uint8Array([...kit.weeklyUsage(base), 0]))).toThrow('malformed');
  // A signature for one kind never passes as another: different labels, different layouts.
  expect(() => decodeEvent(kit.weeklyUsage(base))).toThrow('malformed');
  const screen = kit.event({ mac, kind: 2, eventAt: NOW, macName: 'Mac', actorID: phone.fingerprint, actorName: 'iPad', recipients: [], issuedAt: NOW, nonce: kit.nonceOf(2) });
  expect(() => decodeWeeklyUsage(screen)).toThrow('malformed');
  expect(decodeEvent(screen).kind).toBe('registered');
  expect(LABELS.usage).not.toBe(LABELS.notify);
});

test('the banner is built from the signed fields only: Mac name, provider and boundary', () => {
  expect(weeklyUsageText({ macName: '사무실 Mac', provider: 'codex', mark: 30 }))
    .toEqual({ title: 'Codex 주간 사용량', body: '‘사무실 Mac’에서 확인한 Codex 주간 잔여가 30% 미만입니다.' });
  expect(weeklyUsageText({ macName: '사무실 Mac', provider: 'agy', mark: 0 }))
    .toEqual({ title: 'Antigravity 주간 사용량', body: '‘사무실 Mac’에서 확인한 Antigravity 주간 사용량을 모두 썼습니다.' });
  const usage = decodeWeeklyUsage(b(vectors.weeklyUsage.message));
  const payload = JSON.parse(weeklyUsagePayload(usage));
  // No `screen` part (the phone offers no remote stop for it), no recipients, keys or figures beyond the boundary.
  expect(payload).toEqual({ aps: { alert: weeklyUsageText(usage), sound: 'default', 'thread-id': 'weekly-usage' } });
  expect(JSON.stringify(payload)).not.toMatch(/@|token|account|이메일/);
});

test('weekly-usage: checked like a screen event, its own budget, only the named devices, collapse ID from the alert key', async () => {
  const mac = await kit.testKey('usage mac'), phone = await kit.testKey('usage phone'), ipad = await kit.testKey('usage ipad');
  const stranger = await kit.testKey('usage stranger');
  const usage = kit.weeklyUsage({ mac, macName: '사무실 Mac', provider: 2, mark: 30, windowKey: 'r498056', observedAt: NOW - 30_000,
    recipients: [phone.fingerprint, ipad.fingerprint], issuedAt: NOW, nonce: kit.nonceOf(1) });
  const targets = [phone, ipad, stranger].map(k => ({ deviceID: hex(k.fingerprint), token: 'ab'.repeat(32), environment: 'production', topic: TOPIC }));
  const { sent, apns } = recordingApns();
  let { calls, handler } = relay({ portmgr_screen_push_targets: targets }, apns);
  let response = await handler(post(await signedBody('weekly-usage', usage, mac)));
  expect([response.status, await response.json()]).toEqual([200, { ok: true, sent: 2 }]);
  expect(calls[0]).toEqual({ name: 'portmgr_screen_push_admit', args: {
    p_key: hex(mac.fingerprint), p_kind: 'usage', p_nonce: hex(kit.nonceOf(1)), p_window_seconds: 3600, p_limit: 12 } });
  expect(RATE_LIMITS.notify).toEqual({ windowSeconds: 600, limit: 20 }); // the screen notifications' budget is untouched
  expect(calls[1]).toEqual({ name: 'portmgr_screen_push_targets', args: { p_mac: hex(mac.fingerprint), p_devices: [hex(phone.fingerprint), hex(ipad.fingerprint)] } });
  expect(sent.map(s => s.target.deviceID)).toEqual([hex(phone.fingerprint), hex(ipad.fingerprint)]);
  expect(new Set(sent.map(s => s.collapseID))).toEqual(new Set(['weekly-codex:r498056:30']));
  expect(sent[0]!.expiresAt).toBe(NOW - 30_000 + 6 * 3600_000);
  expect(JSON.parse(sent[0]!.payload).aps.alert.body).toBe('‘사무실 Mac’에서 확인한 Codex 주간 잔여가 30% 미만입니다.');

  // Signed by another key, changed, stale, from the future or long after the main app saw it: refused before any database call.
  const at = (o: Partial<{ observedAt: number; issuedAt: number }>, n: number) => kit.weeklyUsage({ mac, macName: 'Mac', provider: 2, mark: 30,
    windowKey: 'r498056', observedAt: NOW, recipients: [phone.fingerprint], issuedAt: NOW, nonce: kit.nonceOf(n), ...o });
  const changed = usage.slice(); changed[60]! ^= 1;
  for (const [body, status, code] of [
    [await signedBody('weekly-usage', usage, phone), 401, 'bad_signature'],
    [{ ...(await signedBody('weekly-usage', usage, mac)), message: base64(changed) }, 401, 'bad_signature'],
    [await signedBody('weekly-usage', at({ issuedAt: NOW - 121_000, observedAt: NOW - 121_000 }, 2), mac), 400, 'expired'],
    [await signedBody('weekly-usage', at({ observedAt: NOW - USAGE_MAX_AGE_MS - 1 }, 3), mac), 400, 'expired'],
    [await signedBody('weekly-usage', at({ observedAt: NOW + 121_000 }, 4), mac), 400, 'expired'],
    [await signedBody('notify', usage, mac), 400, 'malformed'], // a weekly alert is not a screen event
    [await signedBody('weekly-usage', kit.event({ mac, kind: 1, eventAt: NOW, macName: 'Mac', actorID: phone.fingerprint, actorName: 'iPad', recipients: [], issuedAt: NOW, nonce: kit.nonceOf(5) }), mac), 400, 'malformed'],
  ] as const) {
    ({ calls, handler } = relay({}, apns));
    response = await handler(post(body));
    expect([response.status, (await response.json()).error, calls]).toEqual([status, code, []]);
  }
  // Exactly two hours old still goes; replays and the budget are the database's answer.
  ({ calls, handler } = relay({ portmgr_screen_push_targets: [] }, apns));
  expect((await handler(post(await signedBody('weekly-usage', at({ observedAt: NOW - USAGE_MAX_AGE_MS }, 6), mac)))).status).toBe(200);
  for (const [verdict, status] of [['replayed', 409], ['rate_limited', 429]] as const) {
    ({ calls, handler } = relay({ portmgr_screen_push_admit: verdict }, apns));
    expect((await handler(post(await signedBody('weekly-usage', usage, mac)))).status).toBe(status);
    expect(calls.map(c => c.name)).toEqual(['portmgr_screen_push_admit']);
  }
  // Without the APNs secrets nothing is read or sent.
  ({ calls, handler } = relay({}, null));
  response = await handler(post(await signedBody('weekly-usage', usage, mac)));
  expect([response.status, calls.length]).toEqual([503, 0]);
});

test('screen events keep their bytes, budget, collapse ID and signed payload', async () => {
  const mac = await kit.testKey('compat mac'), phone = await kit.testKey('compat phone'), ipad = await kit.testKey('compat ipad');
  const event = kit.event({ mac, kind: 2, eventAt: NOW, macName: 'Mac', actorID: ipad.fingerprint, actorName: 'iPad', recipients: [phone.fingerprint], issuedAt: NOW, nonce: kit.nonceOf(1) });
  const { sent, apns } = recordingApns();
  const { calls, handler } = relay({ portmgr_screen_push_targets: [phone, ipad].map(k => ({ deviceID: hex(k.fingerprint), token: 'ab'.repeat(32), environment: 'production', topic: TOPIC })) }, apns);
  expect(await (await handler(post(await signedBody('notify', event, mac)))).json()).toEqual({ ok: true, sent: 1 });
  expect(calls[0]!.args).toMatchObject({ p_kind: 'notify', p_window_seconds: 600, p_limit: 20 });
  expect(sent[0]!.collapseID).toBe(`screen-registered-${hex(ipad.fingerprint).slice(0, 16)}`);
  expect(sent[0]!.expiresAt).toBe(NOW + 3600_000);
  const payload = JSON.parse(sent[0]!.payload);
  expect(payload.aps).toEqual({ alert: { title: 'AgentsToZ Screen', body: '‘iPad’이(가) ‘Mac’에 새 기기로 등록되었습니다.' }, sound: 'default' });
  expect(base64(event)).toBe(payload.screen.m);
});
