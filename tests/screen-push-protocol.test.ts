import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import {
  apnsJwt, base64, createApnsSender, createScreenPushHandler, decodeCommand, decodeEvent, decodeFetch, decodeRegistration, decodeResult,
  fromBase64, hex, notificationText, pushTargets, resultSignedData, sha256, verifySignature, type ApnsSender, type PushTarget, type ScreenPushDeps,
} from '../supabase/functions/screen-push/protocol';
import * as kit from './screenPushTestKit';
import { screenPushDatabase } from './screenPushTestKit';

// The push relay (supabase/functions/screen-push): it reads the bytes the Mac and the phone write, checks every
// signature before anything else, sends a notification only to the devices the Mac named and never to the one that
// acted, and leaves authority with the Mac. DESIGN 「알림·원격 차단」.
const vectors = JSON.parse(readFileSync(new URL('../native/screen-control/Tests/PushContract/vectors.json', import.meta.url), 'utf8'));
const b = kit.bytes;
const flip = (data: Uint8Array, at: number) => { const out = data.slice(); out[at]! ^= 1; return out; };
const TOPIC = 'com.intenet.agentstoz.mobile.testflight';

// Test keys exist only for this run; use the standard encoder rather than a checked-in PEM fixture.
const privateKeyPem = (pkcs8: ArrayBuffer): string => createPrivateKey({
  key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8',
}).export({ format: 'pem', type: 'pkcs8' }).toString();

test('the relay reads the Swift layouts and CryptoKit signatures (contract vectors)', async () => {
  const register = decodeRegistration(b(vectors.register.message));
  expect(hex(register.macKey)).toBe(vectors.macPublic);
  expect(hex(register.deviceKey)).toBe(vectors.devicePublic);
  expect([hex(register.token), register.environment, register.topic, register.issuedAt, hex(register.nonce)])
    .toEqual([vectors.token, 'production', vectors.topic, vectors.issuedAt, vectors.nonce]);
  expect(await verifySignature(register.deviceKey, b(vectors.register.message), b(vectors.register.signature))).toBe(true);
  expect(await verifySignature(register.macKey, b(vectors.register.message), b(vectors.register.signature))).toBe(false);
  expect(await verifySignature(register.deviceKey, flip(b(vectors.register.message), 100), b(vectors.register.signature))).toBe(false);

  const event = decodeEvent(b(vectors.notify.message));
  expect([event.kind, event.eventAt, event.macName, event.actorName]).toEqual(['connected', vectors.eventAt, vectors.macName, vectors.actorName]);
  expect(hex(event.actorID)).toBe(hex(await sha256(b(vectors.devicePublic))));
  expect(event.recipients.map(hex)).toEqual([hex(await sha256(b(vectors.otherPublic)))]);
  expect(await verifySignature(event.macKey, b(vectors.notify.message), b(vectors.notify.signature))).toBe(true);

  const command = decodeCommand(b(vectors.command.message));
  expect([command.action, hex(command.target), hex(command.macFingerprint)])
    .toEqual([3, hex(await sha256(b(vectors.otherPublic))), hex(await sha256(b(vectors.macPublic)))]);
  expect(hex(await sha256(b(vectors.command.message)))).toBe(vectors.command.id);
  expect(await verifySignature(command.deviceKey, b(vectors.command.message), b(vectors.command.signature))).toBe(true);

  const poll = decodeFetch(b(vectors.fetch.message));
  expect(poll.deviceIDs).toHaveLength(2);
  expect(hex(poll.results[0]!.encoded)).toBe(vectors.result);
  const macFingerprint = await sha256(poll.macKey);
  expect(await verifySignature(poll.macKey, resultSignedData(macFingerprint, poll.results[0]!), poll.results[0]!.signature)).toBe(true);
  expect(await verifySignature(poll.macKey, resultSignedData(macFingerprint, { ...poll.results[0]!, outcome: 4 }), poll.results[0]!.signature)).toBe(false);
});

test('the reader is strict: labels, lengths, trailing bytes, names and the actor', async () => {
  const mac = await kit.testKey('strict mac'), device = await kit.testKey('strict device');
  const message = b(vectors.register.message);
  expect(() => decodeRegistration(new Uint8Array([...message, 0]))).toThrow('malformed');
  expect(() => decodeCommand(message)).toThrow('malformed'); // a signature for one kind never passes as another
  expect(() => decodeEvent(b(vectors.command.message))).toThrow('malformed');
  expect(() => decodeResult(b(vectors.result).slice(1))).toThrow('malformed');
  const base = { mac, kind: 1 as const, eventAt: 1, macName: 'Mac', actorID: device.fingerprint, actorName: 'iPad', issuedAt: 1, nonce: kit.nonceOf(2) };
  expect(() => decodeEvent(kit.event({ ...base, recipients: [mac.fingerprint, device.fingerprint] }))).toThrow('malformed');
  expect(() => decodeEvent(kit.event({ ...base, recipients: [mac.fingerprint, mac.fingerprint] }))).toThrow('malformed');
  expect(() => decodeEvent(kit.event({ ...base, recipients: Array.from({ length: 17 }, (_, n) => new Uint8Array(32).fill(n + 100)) }))).toThrow('malformed');
  expect(() => decodeEvent(kit.event({ ...base, recipients: [], macName: 'Mac‮koob' }))).toThrow('malformed');
  expect(() => decodeEvent(kit.event({ ...base, recipients: [], actorName: 'x'.repeat(65) }))).toThrow('malformed');
  expect(() => decodeCommand(kit.command({ macFingerprint: mac.fingerprint, device, action: 1, target: device.fingerprint, issuedAt: 1, nonce: kit.nonceOf(1) }))).toThrow('malformed');
  expect(() => decodeCommand(kit.command({ macFingerprint: mac.fingerprint, device, action: 3, issuedAt: 1, nonce: kit.nonceOf(1) }))).toThrow('malformed');
  expect(() => decodeRegistration(kit.registration({ mac, device, token: new Uint8Array(32), production: true, topic: 'com.example/app', issuedAt: 1, nonce: kit.nonceOf(1) }))).toThrow('malformed');
});

test('notifications go only to the devices the Mac named, never the one that acted', async () => {
  const actor = new Uint8Array(32).fill(1), a = new Uint8Array(32).fill(2), stranger = new Uint8Array(32).fill(3);
  const row = (id: Uint8Array, topic = TOPIC, token = 'ab'.repeat(32)): PushTarget => ({ deviceID: hex(id), token, environment: 'production', topic });
  const event = { recipients: [a], actorID: actor } as any;
  expect(pushTargets([row(a), row(actor), row(stranger), row(a)], event, [TOPIC]).map(t => t.deviceID)).toEqual([hex(a)]);
  // Even if the Mac's list named the actor (its own decoder refuses that), the actor is never pushed.
  expect(pushTargets([row(actor)], { recipients: [actor], actorID: actor } as any, [TOPIC])).toEqual([]);
  expect(pushTargets([row(a, 'com.other.app')], event, [TOPIC])).toEqual([]);
  expect(pushTargets([row(a, TOPIC, 'not hex')], event, [TOPIC])).toEqual([]);
});

interface Call { name: string; args: Record<string, any> }
function fakeDeps(answers: Record<string, unknown> = {}, apns: ApnsSender | null = null, now = 1_800_000_000_000) {
  const calls: Call[] = [];
  const deps: ScreenPushDeps = {
    rpc: async (name, args) => { calls.push({ name, args }); return name in answers ? answers[name] : 'ok'; },
    apns, allowedTopics: [TOPIC], now: () => now, randomHex: n => '0'.repeat(n * 2),
  };
  return { calls, handler: createScreenPushHandler(deps) };
}
const post = (body: unknown) => new Request('https://relay.invalid/screen-push', { method: 'POST', body: JSON.stringify(body) });
const signedBody = async (type: string, message: Uint8Array, signer: kit.TestKey) =>
  ({ type, message: base64(message), signature: base64(await signer.sign(message)) });

test('Mac controller notifications use distinct signed kinds and only the named phone receives them', async () => {
  const now = 1_800_000_000_000;
  const mac = await kit.testKey('controller event mac'), phone = await kit.testKey('controller event phone');
  const controller = await kit.testKey('controller event controller'), stranger = await kit.testKey('controller event stranger');
  const targets = [phone, controller, stranger].map(k => ({ deviceID: hex(k.fingerprint), token: 'ab'.repeat(32), environment: 'production', topic: TOPIC }));
  for (const [kind, expected] of [[3, 'controllerConnected'], [4, 'controllerRegistered']] as const) {
    const eventBytes = kit.event({ mac, kind, eventAt: now, macName: '대상 Mac', actorID: controller.fingerprint,
      actorName: '보는 Mac', recipients: [phone.fingerprint], issuedAt: now, nonce: kit.nonceOf(kind) });
    const event = decodeEvent(eventBytes);
    expect(event.kind).toBe(expected);
    expect(notificationText(event).body).toContain('Mac 컨트롤러 ‘보는 Mac’');
    const sent: { target: PushTarget; payload: string }[] = [];
    const apns: ApnsSender = { send: async (target, payload) => { sent.push({ target, payload }); return { status: 200 }; } };
    const { calls, handler } = fakeDeps({ portmgr_screen_push_targets: targets }, apns, now);
    const response = await handler(post(await signedBody('notify', eventBytes, mac)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sent: 1 });
    expect(sent.map(s => s.target.deviceID)).toEqual([hex(phone.fingerprint)]);
    expect(JSON.parse(sent[0]!.payload).aps.alert.body).toContain('Mac 컨트롤러');
    expect(calls[1]!.args.p_devices).toEqual([hex(phone.fingerprint)]);
    const forged = await handler(post(await signedBody('notify', eventBytes, controller)));
    expect(forged.status).toBe(401);
  }
  const unknown = kit.event({ mac, kind: 5 as 3, eventAt: now, macName: 'Mac', actorID: controller.fingerprint,
    actorName: 'Mac', recipients: [], issuedAt: now, nonce: kit.nonceOf(8) });
  expect(() => decodeEvent(unknown)).toThrow('malformed');
});

test('oversized streamed requests are cancelled before the rest of the body is read', async () => {
  const { calls, handler } = fakeDeps();
  let pulls = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(16_385).fill(32));
      if (pulls === 2) controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const response = await handler(new Request('https://relay.invalid/screen-push', { method: 'POST', body }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'malformed' });
  expect(cancelled).toBe(true);
  expect(pulls).toBe(1);
  expect(calls).toEqual([]);
});

test('every signature is checked before a rate budget, a nonce or Apple is touched', async () => {
  const now = 1_800_000_000_000;
  const mac = await kit.testKey('handler mac'), device = await kit.testKey('handler device'), other = await kit.testKey('handler other');
  const sent: PushTarget[] = [];
  const apns: ApnsSender = { send: async target => { sent.push(target); return target.deviceID === hex(other.fingerprint) ? { status: 200 } : { status: 410 } } };
  const event = kit.event({ mac, kind: 1, eventAt: now, macName: 'Mac', actorID: device.fingerprint, actorName: 'iPad', recipients: [other.fingerprint], issuedAt: now, nonce: kit.nonceOf(1) });
  const targets = [device, other].map(k => ({ deviceID: hex(k.fingerprint), token: 'cd'.repeat(32), environment: 'sandbox', topic: TOPIC }));

  // A valid notify: admitted under the Mac's fingerprint, sent to the named device only.
  let { calls, handler } = fakeDeps({ portmgr_screen_push_targets: targets }, apns, now);
  let response = await handler(post(await signedBody('notify', event, mac)));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, sent: 1 });
  expect(calls[0]).toEqual({ name: 'portmgr_screen_push_admit', args: { p_key: hex(mac.fingerprint), p_kind: 'notify', p_nonce: hex(kit.nonceOf(1)), p_window_seconds: 600, p_limit: 20 } });
  expect(calls[1]!.args.p_devices).toEqual([hex(other.fingerprint)]);
  expect(sent.map(t => t.deviceID)).toEqual([hex(other.fingerprint)]);

  // Signed by another key, changed after signing, or too old: refused before any database call.
  for (const [body, status, code] of [
    [await signedBody('notify', event, other), 401, 'bad_signature'],
    [{ ...(await signedBody('notify', event, mac)), message: base64(flip(event, 60)) }, 401, 'bad_signature'],
    [await signedBody('notify', kit.event({ mac, kind: 1, eventAt: now, macName: 'Mac', actorID: device.fingerprint, actorName: 'iPad', recipients: [], issuedAt: now - 121_000, nonce: kit.nonceOf(2) }), mac), 400, 'expired'],
    [{ type: 'notify', message: 'not base64!', signature: '' }, 400, 'malformed'],
  ] as const) {
    ({ calls, handler } = fakeDeps({}, apns, now));
    response = await handler(post(body));
    expect([response.status, (await response.json()).error]).toEqual([status, code]);
    expect(calls).toEqual([]);
  }

  // Replays and rate limits are the database's answer, passed on.
  for (const [verdict, status, code] of [['replayed', 409, 'replayed'], ['rate_limited', 429, 'rate_limited'], ['busy', 429, 'rate_limited']] as const) {
    ({ calls, handler } = fakeDeps({ portmgr_screen_push_admit: verdict }, apns, now));
    response = await handler(post(await signedBody('notify', event, mac)));
    expect([response.status, (await response.json()).error]).toEqual([status, code]);
    expect(calls.map(c => c.name)).toEqual(['portmgr_screen_push_admit']);
  }

  // A token APNs calls dead is dropped; without APNs secrets nothing is sent at all.
  sent.length = 0;
  ({ calls, handler } = fakeDeps({ portmgr_screen_push_targets: [{ ...targets[1]!, token: 'ef'.repeat(32) }] }, { send: async () => ({ status: 400, reason: 'BadDeviceToken' }) }, now));
  await handler(post(await signedBody('notify', event, mac)));
  expect(calls.at(-1)).toEqual({ name: 'portmgr_screen_push_drop_token', args: { p_mac: hex(mac.fingerprint), p_device: hex(other.fingerprint), p_token: 'ef'.repeat(32) } });
  ({ calls, handler } = fakeDeps({}, null, now));
  response = await handler(post(await signedBody('notify', event, mac)));
  expect([response.status, calls.length]).toEqual([503, 0]);

  // Registration: signed by the device key it names, for an app this relay pushes to.
  const registration = kit.registration({ mac, device, token: new Uint8Array(32).fill(7), production: false, topic: TOPIC, issuedAt: now - 500_000, nonce: kit.nonceOf(3) });
  ({ calls, handler } = fakeDeps({}, apns, now));
  expect((await handler(post(await signedBody('register', registration, device)))).status).toBe(200);
  expect(calls[1]).toEqual({ name: 'portmgr_screen_push_register', args: {
    p_mac: hex(mac.fingerprint), p_device: hex(device.fingerprint), p_device_key: hex(device.publicKey), p_token: '07'.repeat(32), p_environment: 'sandbox', p_topic: TOPIC } });
  ({ calls, handler } = fakeDeps({}, apns, now));
  expect((await handler(post(await signedBody('register', registration, other)))).status).toBe(401);
  const elsewhere = kit.registration({ mac, device, token: new Uint8Array(32), production: true, topic: 'com.example.app', issuedAt: now, nonce: kit.nonceOf(4) });
  expect(await (await handler(post(await signedBody('register', elsewhere, device)))).json()).toEqual({ error: 'bad_topic' });
  expect(calls).toEqual([]);

  // A poll keeps only results the Mac signed.
  const real = await kit.result(mac, new Uint8Array(32).fill(9), 1), forged = await kit.result(other, new Uint8Array(32).fill(8), 1);
  const poll = kit.fetchMessage({ mac, deviceIDs: [device.fingerprint], results: [real, forged], issuedAt: now, nonce: kit.nonceOf(5) });
  ({ calls, handler } = fakeDeps({ portmgr_screen_push_sync: [{ message: 'bQ==', signature: 'cw==' }] }, apns, now));
  response = await handler(post(await signedBody('fetch', poll, mac)));
  expect(await response.json()).toEqual({ ok: true, commands: [{ message: 'bQ==', signature: 'cw==' }] });
  expect(calls[1]!.args).toEqual({ p_mac: hex(mac.fingerprint), p_devices: [hex(device.fingerprint)], p_results: [{ command_id: '09'.repeat(32), result: base64(real) }] });
  // Only the Mac reads its commands or changes its device list: a poll signed by anyone else touches nothing.
  ({ calls, handler } = fakeDeps({ portmgr_screen_push_sync: [{ message: 'bQ==', signature: 'cw==' }] }, apns, now));
  response = await handler(post(await signedBody('fetch', poll, other)));
  expect([response.status, (await response.json()).error, calls]).toEqual([401, 'bad_signature', []]);

  // A command: named by the hash of its message, kept as long as the Mac would still act on it.
  const stop = kit.command({ macFingerprint: mac.fingerprint, device, action: 4, issuedAt: now, nonce: kit.nonceOf(6) });
  ({ calls, handler } = fakeDeps({}, apns, now));
  expect((await handler(post(await signedBody('command', stop, device)))).status).toBe(200);
  expect(calls[1]!.args.p_command_id).toBe(hex(await sha256(stop)));
  expect(calls[1]!.args.p_expires_at).toBe(new Date(now + (7 * 86400 + 120) * 1000).toISOString());
  ({ calls, handler } = fakeDeps({ portmgr_screen_push_queue: 'unknown_device' }, apns, now));
  response = await handler(post(await signedBody('command', stop, device)));
  expect([response.status, (await response.json()).error]).toEqual([409, 'unknown_device']);
  // Signed by a key other than the one it names, or older than a person's Face ID and network allow: nothing queued.
  const stale = kit.command({ macFingerprint: mac.fingerprint, device, action: 4, issuedAt: now - 601_000, nonce: kit.nonceOf(7) });
  for (const [body, status, code] of [
    [await signedBody('command', stop, other), 401, 'bad_signature'],
    [await signedBody('command', stale, device), 400, 'expired'],
  ] as const) {
    ({ calls, handler } = fakeDeps({}, apns, now));
    response = await handler(post(body));
    expect([response.status, (await response.json()).error, calls]).toEqual([status, code, []]);
  }

  // Plain requests: wrong method, broken JSON, unknown kind.
  ({ calls, handler } = fakeDeps({}, apns, now));
  expect((await handler(new Request('https://relay.invalid/', { method: 'GET' }))).status).toBe(405);
  expect((await handler(new Request('https://relay.invalid/', { method: 'POST', body: '{' }))).status).toBe(400);
  expect((await handler(post({ type: 'toString' }))).status).toBe(400);
  expect((await handler(post({ type: 'result', commandID: 'nothex' }))).status).toBe(400);
  expect(calls).toEqual([]);
});

test('APNs: an ES256 provider token, the right host, and a fresh token after a refusal', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pem = privateKeyPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const jwt = await apnsJwt(pem, 'ABCDEFGHIJ', 'TEAMID1234', 1_800_000_000);
  const [head, claims, signature] = jwt.split('.');
  const json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString());
  expect(json(head!)).toEqual({ alg: 'ES256', kid: 'ABCDEFGHIJ' });
  expect(json(claims!)).toEqual({ iss: 'TEAMID1234', iat: 1_800_000_000 });
  expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, Buffer.from(signature!, 'base64url'), new TextEncoder().encode(`${head}.${claims}`))).toBe(true);
  await expect(apnsJwt(pem, 'short', 'TEAMID1234', 1)).rejects.toThrow('not_configured');

  const requests: { url: string; headers: Record<string, string> }[] = [];
  let status = 403, clock = 1_800_000_000_000;
  const sender = createApnsSender({
    keyP8: pem, keyID: 'ABCDEFGHIJ', teamID: 'TEAMID1234', now: () => clock,
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ reason: status === 200 ? undefined : 'ExpiredProviderToken' }), { status });
    }) as unknown as typeof fetch,
  });
  const target = (environment: 'sandbox' | 'production'): PushTarget => ({ deviceID: 'd', token: 'ab'.repeat(32), environment, topic: TOPIC });
  expect(await sender.send(target('production'), '{}', clock + 3600_000, 'c')).toEqual({ status: 403, reason: 'ExpiredProviderToken' });
  status = 200;
  clock += 1000; // a second later, but the refused token is not reused
  await sender.send(target('sandbox'), '{}', clock + 3600_000, 'c');
  await sender.send(target('sandbox'), '{}', clock + 3600_000, 'c');
  expect(requests.map(r => new URL(r.url).host)).toEqual(['api.push.apple.com', 'api.sandbox.push.apple.com', 'api.sandbox.push.apple.com']);
  expect(requests[0]!.headers['apns-topic']).toBe(TOPIC);
  expect(requests[0]!.headers['apns-push-type']).toBe('alert');
  expect(requests[1]!.headers.authorization).not.toBe(requests[0]!.headers.authorization);
  expect(requests[2]!.headers.authorization).toBe(requests[1]!.headers.authorization);
  expect(new URL(requests[0]!.url).pathname).toBe(`/3/device/${'ab'.repeat(32)}`);
});

test('end to end through PostgreSQL: register, notify, remote stop and the Mac\'s signed answer', async () => {
  const db = await screenPushDatabase();
  const globals = globalThis as any, oldDeno = globals.Deno, oldFetch = globalThis.fetch;
  try {
    await db.exec(`set test.role = 'service_role'`);
    const casts: Record<string, string> = { p_devices: '::text[]', p_results: '::jsonb', p_expires_at: '::timestamptz', p_window_seconds: '::integer', p_limit: '::integer' };
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const keys = Object.keys(args);
      const values = keys.map(k => Array.isArray(args[k]) && k === 'p_devices' ? `{${(args[k] as string[]).join(',')}}` : k === 'p_results' ? JSON.stringify(args[k]) : args[k]);
      return (await db.query<any>(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}${casts[k] ?? ''}`).join(', ')}) as v`, values)).rows[0].v;
    };
    // The deployed entry point, with Deno stood in: same handler, service key only upstream.
    let handler: (request: Request) => Promise<Response> = async () => { throw Error('not served'); };
    const pushed: { url: string; body: string }[] = [];
    const env: Record<string, string> = { SUPABASE_URL: 'https://project.supabase.co', PORTMGR_SERVICE_SECRET_KEY: 'service-secret-fixture', APNS_TOPICS: TOPIC };
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    env.APNS_KEY_P8 = privateKeyPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    env.APNS_KEY_ID = 'ABCDEFGHIJ';
    env.APNS_TEAM_ID = 'TEAMID1234';
    globals.Deno = { env: { get: (name: string) => env[name] }, serve: (value: typeof handler) => { handler = value; } };
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (String(url).startsWith('https://api.')) { pushed.push({ url: String(url), body: String(init.body) }); return new Response(null, { status: 200 }); }
      const headers = new Headers(init.headers);
      expect(headers.get('apikey')).toBe('service-secret-fixture');
      const name = new URL(String(url)).pathname.split('/').at(-1)!;
      return Response.json(await rpc(name, JSON.parse(String(init.body))));
    }) as unknown as typeof fetch;
    const entry = '../supabase/functions/screen-push/index.ts?screen-push-e2e';
    await import(entry);

    const mac = await kit.testKey('e2e mac'), phone = await kit.testKey('e2e phone'), ipad = await kit.testKey('e2e ipad');
    let n = 10;
    const now = () => Date.now();
    const call = async (body: unknown) => { const r = await handler(post(body)); const text = await r.text(); expect(text).not.toContain('service-secret-fixture'); return { status: r.status, body: JSON.parse(text) }; };
    const poll = async (results: Uint8Array[] = []) => call(await signedBody('fetch', kit.fetchMessage({ mac, deviceIDs: [phone.fingerprint, ipad.fingerprint], results, issuedAt: now(), nonce: kit.nonceOf(n++) }), mac));

    expect((await poll()).body).toEqual({ ok: true, commands: [] });
    for (const [device, fill] of [[phone, 1], [ipad, 2]] as const) {
      const registration = kit.registration({ mac, device, token: new Uint8Array(32).fill(fill), production: true, topic: TOPIC, issuedAt: now(), nonce: kit.nonceOf(n++) });
      expect((await call(await signedBody('register', registration, device))).body).toEqual({ ok: true });
    }

    // The iPad connects: the phone hears about it, the iPad does not.
    const event = kit.event({ mac, kind: 1, eventAt: now(), macName: '사무실 Mac', actorID: ipad.fingerprint, actorName: '아이패드', recipients: [phone.fingerprint], issuedAt: now(), nonce: kit.nonceOf(n++) });
    const notifyBody = await signedBody('notify', event, mac);
    expect((await call(notifyBody)).body).toEqual({ ok: true, sent: 1 });
    expect(pushed.map(p => p.url)).toEqual([`https://api.push.apple.com/3/device/${'01'.repeat(32)}`]);
    const payload = JSON.parse(pushed[0]!.body);
    expect(payload.aps.alert.body).toBe('‘아이패드’이(가) ‘사무실 Mac’ 화면에 연결했습니다.');
    expect(fromBase64(payload.screen.m)).toEqual(event); // the app checks the Mac's signature itself
    expect(await call(notifyBody)).toEqual({ status: 409, body: { error: 'replayed' } });

    // A weekly allowance alert (kind weekly-usage): the 'usage' rate kind exists in the table, both devices hear it once.
    const usage = kit.weeklyUsage({ mac, macName: '사무실 Mac', provider: 1, mark: 0, windowKey: 'w2026-W44', observedAt: now() - 60_000,
      recipients: [phone.fingerprint, ipad.fingerprint], issuedAt: now(), nonce: kit.nonceOf(n++) });
    const usageBody = await signedBody('weekly-usage', usage, mac);
    pushed.length = 0;
    expect((await call(usageBody)).body).toEqual({ ok: true, sent: 2 });
    expect(pushed.map(p => JSON.parse(p.body).aps.alert.body)).toEqual(Array(2).fill('‘사무실 Mac’에서 확인한 Claude 주간 사용량을 모두 썼습니다.'));
    expect(await call(usageBody)).toEqual({ status: 409, body: { error: 'replayed' } });

    // The phone stops it: queued, handed to the Mac, answered with the Mac's signature, read back by the phone.
    const stop = kit.command({ macFingerprint: mac.fingerprint, device: phone, action: 1, issuedAt: now(), nonce: kit.nonceOf(n++) });
    expect((await call(await signedBody('command', stop, phone))).body).toEqual({ ok: true });
    const commandID = hex(await sha256(stop));
    expect((await call({ type: 'result', commandID })).body).toEqual({ ok: true, result: null });
    const waiting = (await poll()).body.commands;
    expect(waiting).toEqual([{ message: base64(stop), signature: expect.any(String) }]);
    const answer = await kit.result(mac, await sha256(stop), 1);
    expect((await poll([answer])).body.commands).toEqual([]);
    expect((await call({ type: 'result', commandID })).body).toEqual({ ok: true, result: base64(answer) });

    // A device the Mac never listed cannot queue a stop.
    const stranger = await kit.testKey('e2e stranger');
    const foreign = kit.command({ macFingerprint: mac.fingerprint, device: stranger, action: 4, issuedAt: now(), nonce: kit.nonceOf(n++) });
    expect(await call(await signedBody('command', foreign, stranger))).toEqual({ status: 409, body: { error: 'unknown_device' } });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDeno === undefined) delete globals.Deno; else globals.Deno = oldDeno;
    await db.close();
  }
}, 30_000);
