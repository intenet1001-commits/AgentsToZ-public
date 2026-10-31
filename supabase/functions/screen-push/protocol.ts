// The push relay for AgentsToZ Screen (DESIGN 「알림·원격 차단」): notifications to a Mac's other registered devices
// and remote-stop commands from them. Pure: no Deno, no environment, no network of its own — index.ts wires it up and
// tests/screen-push-protocol.test.ts runs it under bun.
//
// The relay is not trusted with authority. Every message is signed by a key it does not hold and checked by whoever
// acts on it: the Mac checks commands against its own registry, the phone checks results and events against the Mac
// key it pinned. The relay still checks every signature itself, so nobody without the key can spend a Mac's or a
// device's rate budget, read its pending commands, or have Apple push in its name. Messages are the length-prefixed
// layouts of native/screen-control/Sources/ScreenControlCore/PushCommands.swift.

export type Bytes = Uint8Array<ArrayBuffer>;

const BASE = 'agentstoz.screen-control/v1';
export const LABELS = {
  register: `${BASE} push register`,
  notify: `${BASE} push notify`,
  fetch: `${BASE} push fetch`,
  command: `${BASE} remote command`,
  result: `${BASE} remote command result`,
  /** A weekly AI allowance alert the main AgentsToZ app handed to AgentsToZ Screen (src/weeklyUsagePushHost.ts). Its own
   * label, so a signature over one never passes as a screen event; kinds 1–4 keep their layout byte for byte. */
  usage: `${BASE} push weekly usage`,
} as const;

export const WIRE = { nonce: 16, key: 65, id: 32, signature: 64, maxDevices: 16, maxMessage: 4096, result: 32 + 1 + 64 } as const;

/** How far a request's own time may be from the relay's. The Mac's requests are machine-made and checked tightly; the
 * phone's follow a person (Face ID, then the network) and get longer. Each nonce is remembered at least this long. */
export const FRESHNESS = { mac: 120_000, device: 600_000 } as const;

/** Requests allowed per key (a Mac, a device, a command) in a window, after the signature checks. */
export const RATE_LIMITS = {
  register: { windowSeconds: 3600, limit: 10 },
  unregister: { windowSeconds: 3600, limit: 20 },
  notify: { windowSeconds: 600, limit: 20 },
  fetch: { windowSeconds: 600, limit: 40 },
  command: { windowSeconds: 600, limit: 10 },
  result: { windowSeconds: 600, limit: 40 },
  /** Weekly allowance alerts have a budget of their own, so they can never use up the screen notifications' (a connection or
   * a new registration is a security notice). A week has at most 10 per provider; AgentsToZ Screen caps itself the same. */
  usage: { windowSeconds: 3600, limit: 12 },
} as const;
export type RequestKind = keyof typeof RATE_LIMITS;

/** Seconds after it was sent that the Mac still acts on each action (RemoteStopAction.maxAge). */
export const ACTION_MAX_AGE: Record<number, number> = { 1: 600, 2: 600, 3: 7 * 86400, 4: 7 * 86400 };

export class ProtocolError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
const malformed = () => new ProtocolError('malformed', 400);

// MARK: bytes

const encoder = new TextEncoder();
const strictText = new TextDecoder('utf-8', { fatal: true });

export const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export function fromHex(text: string): Bytes | null {
  if (!/^(?:[0-9a-f]{2})*$/.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export function fromBase64(text: unknown, max = 8192): Bytes | null {
  if (typeof text !== 'string' || text.length > max || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  try { return Uint8Array.from(atob(text), c => c.charCodeAt(0)); } catch { return null; }
}
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data.slice()));
}

/** 4-byte big-endian length before each field (LengthPrefixed in Encoding.swift). */
export function encodeFields(fields: Uint8Array[]): Bytes {
  return concat(...fields.flatMap(field => {
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, field.length);
    return [length, field];
  }));
}

/** Exactly `count` fields after `label`; anything short, long or trailing is malformed. */
export function decodeFields(data: Uint8Array, label: string, count: number): Bytes[] {
  if (data.length > WIRE.maxMessage) throw malformed();
  const fields: Bytes[] = [];
  let at = 0;
  while (at < data.length) {
    if (fields.length >= count + 1 || data.length - at < 4) throw malformed();
    const length = new DataView(data.buffer, data.byteOffset + at, 4).getUint32(0);
    at += 4;
    if (data.length - at < length) throw malformed();
    fields.push(data.slice(at, at + length));
    at += length;
  }
  if (fields.length !== count + 1 || !equal(fields[0]!, encoder.encode(label))) throw malformed();
  return fields.slice(1);
}

const field = (fields: Bytes[], index: number) => fields[index] ?? (() => { throw malformed(); })();
const isKey = (key: Uint8Array) => key.length === WIRE.key && key[0] === 0x04;
const byte = (data: Uint8Array) => { if (data.length !== 1) throw malformed(); return data[0]!; };
function uint64(data: Uint8Array): number {
  if (data.length !== 8) throw malformed();
  const value = new DataView(data.buffer, data.byteOffset, 8).getBigUint64(0);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed();
  return Number(value);
}
function ids(data: Uint8Array): Bytes[] {
  if (data.length % WIRE.id !== 0 || data.length / WIRE.id > WIRE.maxDevices) throw malformed();
  const list = Array.from({ length: data.length / WIRE.id }, (_, i) => data.slice(i * WIRE.id, (i + 1) * WIRE.id));
  if (new Set(list.map(hex)).size !== list.length) throw malformed();
  return list;
}
function nonce(data: Uint8Array): Bytes {
  if (data.length !== WIRE.nonce) throw malformed();
  return data.slice();
}
/** A name the Mac already checked (isDisplaySafeName); the relay refuses control and format characters again, since it
 * puts the name in a banner. */
function name(data: Uint8Array): string {
  if (data.length < 1 || data.length > 64) throw malformed();
  let text: string;
  try { text = strictText.decode(data); } catch { throw malformed(); }
  if (/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u.test(text)) throw malformed();
  return text;
}

// MARK: messages

export interface Registration { macKey: Bytes; deviceKey: Bytes; token: Bytes; environment: 'sandbox' | 'production'; topic: string; issuedAt: number; nonce: Bytes }
export interface ScreenEvent { macKey: Bytes; kind: 'connected' | 'registered' | 'controllerConnected' | 'controllerRegistered'; eventAt: number; macName: string; actorID: Bytes; actorName: string; recipients: Bytes[]; issuedAt: number; nonce: Bytes }
export interface CommandResult { commandID: Bytes; outcome: number; signature: Bytes; encoded: Bytes }
export interface MacFetch { macKey: Bytes; deviceIDs: Bytes[]; results: CommandResult[]; issuedAt: number; nonce: Bytes }
export interface RemoteCommand { macFingerprint: Bytes; deviceKey: Bytes; action: number; target: Bytes; issuedAt: number; nonce: Bytes }

export function decodeRegistration(data: Uint8Array): Registration {
  const f = decodeFields(data, LABELS.register, 7);
  const [macKey, deviceKey, token, topicBytes] = [field(f, 0), field(f, 1), field(f, 2), field(f, 4)];
  const environment = byte(field(f, 3));
  const topic = new TextDecoder().decode(topicBytes);
  if (!isKey(macKey) || !isKey(deviceKey) || token.length < 8 || token.length > 100 || environment > 1
    || !/^[A-Za-z0-9.-]{1,100}$/.test(topic) || encoder.encode(topic).length !== topicBytes.length) throw malformed();
  return { macKey, deviceKey, token, environment: environment === 1 ? 'production' : 'sandbox', topic, issuedAt: uint64(field(f, 5)), nonce: nonce(field(f, 6)) };
}

export function decodeEvent(data: Uint8Array): ScreenEvent {
  const f = decodeFields(data, LABELS.notify, 9);
  const macKey = field(f, 0), kind = byte(field(f, 1)), actorID = field(f, 4), recipients = ids(field(f, 6));
  if (!isKey(macKey) || (kind !== 1 && kind !== 2 && kind !== 3 && kind !== 4) || actorID.length !== WIRE.id || recipients.some(id => equal(id, actorID))) throw malformed();
  return {
    macKey, kind: kind === 1 ? 'connected' : kind === 2 ? 'registered' : kind === 3 ? 'controllerConnected' : 'controllerRegistered', eventAt: uint64(field(f, 2)), macName: name(field(f, 3)), actorID,
    actorName: name(field(f, 5)), recipients, issuedAt: uint64(field(f, 7)), nonce: nonce(field(f, 8)),
  };
}

export function decodeResult(data: Uint8Array): CommandResult {
  if (data.length !== WIRE.result || data[32]! < 1 || data[32]! > 4) throw malformed();
  return { commandID: data.slice(0, 32), outcome: data[32]!, signature: data.slice(33), encoded: data.slice() };
}

export function decodeFetch(data: Uint8Array): MacFetch {
  const f = decodeFields(data, LABELS.fetch, 5);
  const macKey = field(f, 0), resultBytes = field(f, 2);
  if (!isKey(macKey) || resultBytes.length % WIRE.result !== 0 || resultBytes.length / WIRE.result > WIRE.maxDevices) throw malformed();
  const results = Array.from({ length: resultBytes.length / WIRE.result }, (_, i) => decodeResult(resultBytes.slice(i * WIRE.result, (i + 1) * WIRE.result)));
  return { macKey, deviceIDs: ids(field(f, 1)), results, issuedAt: uint64(field(f, 3)), nonce: nonce(field(f, 4)) };
}

export function decodeCommand(data: Uint8Array): RemoteCommand {
  const f = decodeFields(data, LABELS.command, 6);
  const macFingerprint = field(f, 0), deviceKey = field(f, 1), action = byte(field(f, 2)), target = field(f, 3);
  const targetOK = action === 3 ? target.length === WIRE.id : target.length === 0;
  if (macFingerprint.length !== WIRE.id || !isKey(deviceKey) || action < 1 || action > 4 || !targetOK) throw malformed();
  return { macFingerprint, deviceKey, action, target, issuedAt: uint64(field(f, 4)), nonce: nonce(field(f, 5)) };
}

// MARK: weekly allowance alerts

/** Provider byte → name, as src/weeklyUsage.ts spells it. */
export const USAGE_PROVIDERS = { 1: 'claude', 2: 'codex', 3: 'agy' } as const;
export type UsageProvider = typeof USAGE_PROVIDERS[keyof typeof USAGE_PROVIDERS];
/** What a banner calls each provider: the names of the Mac dock and the phone Home card. */
export const USAGE_PROVIDER_NAMES: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };
/** 90…10: remaining went under that boundary; 0: 소진 (src/weeklyUsageAlerts.ts `WeeklyUsageAlertMark` without 100). */
export const USAGE_MARKS: readonly number[] = [90, 80, 70, 60, 50, 40, 30, 20, 10, 0];
/** The weekly window: the reset time keyed to the hour, or the ISO week when there is no reset time. */
export const USAGE_WINDOW = /^(?:r\d{1,9}|w\d{4}-W\d{2})$/;
/** How long after the main app saw it an alert is still news. AgentsToZ Screen drops older hand-offs unsent. */
export const USAGE_MAX_AGE_MS = 2 * 3600_000;

export interface WeeklyUsageEvent { macKey: Bytes; macName: string; provider: UsageProvider; mark: number; windowKey: string; observedAt: number; recipients: Bytes[]; issuedAt: number; nonce: Bytes }

/** label ‖ Mac key ‖ Mac name ‖ provider ‖ mark ‖ window ‖ observed at ‖ recipients ‖ issued at ‖ nonce
 * (WeeklyUsageEvent in PushCommands.swift). Nothing about the account: no name, email, token or exact figure. */
export function decodeWeeklyUsage(data: Uint8Array): WeeklyUsageEvent {
  const f = decodeFields(data, LABELS.usage, 9);
  const macKey = field(f, 0), provider = USAGE_PROVIDERS[byte(field(f, 2)) as keyof typeof USAGE_PROVIDERS], mark = byte(field(f, 3));
  const windowBytes = field(f, 4), windowKey = new TextDecoder().decode(windowBytes);
  if (!isKey(macKey) || !provider || !USAGE_MARKS.includes(mark) || !USAGE_WINDOW.test(windowKey)
    || encoder.encode(windowKey).length !== windowBytes.length) throw malformed();
  return {
    macKey, macName: name(field(f, 1)), provider, mark, windowKey, observedAt: uint64(field(f, 5)), recipients: ids(field(f, 6)),
    issuedAt: uint64(field(f, 7)), nonce: nonce(field(f, 8)),
  };
}

/** `<provider>:<windowKey>:<mark>`: the main app's alert key (src/weeklyUsageAlerts.ts), one per boundary per window. */
export const weeklyUsageKey = (usage: Pick<WeeklyUsageEvent, 'provider' | 'windowKey' | 'mark'>) => `${usage.provider}:${usage.windowKey}:${usage.mark}`;

/** What the Mac signs for a result: label ‖ Mac fingerprint ‖ command ID ‖ outcome (RemoteCommandResult.signedData). */
export const resultSignedData = (macFingerprint: Uint8Array, result: CommandResult) =>
  encodeFields([encoder.encode(LABELS.result), macFingerprint, result.commandID, new Uint8Array([result.outcome])]);

/** A raw r ‖ s P-256 signature (CryptoKit's rawRepresentation, WebCrypto's ECDSA format) over exactly `message`. */
export async function verifySignature(key: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  if (!isKey(key) || signature.length !== WIRE.signature) return false;
  try {
    const imported = await crypto.subtle.importKey('raw', key.slice(), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, signature.slice(), message.slice());
  } catch { return false; }
}

export const isFresh = (issuedAt: number, now: number, skew: number) => Math.abs(now - issuedAt) <= skew;

// MARK: notifications

export interface PushTarget { deviceID: string; token: string; environment: 'sandbox' | 'production'; topic: string }

/** Who gets the push: devices the Mac named in its signed event, holding a token for that Mac, for an app this relay
 * pushes to — never the device that acted, each once, at most 16. */
export function pushTargets(rows: PushTarget[], event: { recipients: Uint8Array[]; actorID?: Uint8Array }, allowedTopics: readonly string[]): PushTarget[] {
  const named = new Set(event.recipients.map(hex));
  const actor = event.actorID ? hex(event.actorID) : null;
  const seen = new Set<string>();
  return rows.filter(row => row.deviceID !== actor && named.has(row.deviceID) && allowedTopics.includes(row.topic)
    && /^[0-9a-f]{16,200}$/.test(row.token) && !seen.has(row.deviceID + row.token) && seen.add(row.deviceID + row.token))
    .slice(0, WIRE.maxDevices);
}

/** The banner, from the Mac-signed fields only: no screen content, codes or keys. */
export function notificationText(event: ScreenEvent): { title: string; body: string } {
  const actor = event.kind === 'controllerConnected' || event.kind === 'controllerRegistered'
    ? `Mac 컨트롤러 ‘${event.actorName}’` : `‘${event.actorName}’`;
  return {
    title: 'AgentsToZ Screen',
    body: event.kind === 'connected' || event.kind === 'controllerConnected'
      ? `${actor}이(가) ‘${event.macName}’ 화면에 연결했습니다.`
      : `${actor}이(가) ‘${event.macName}’에 새 기기로 등록되었습니다.`,
  };
}

/** The APNs body: the banner and the signed event, so the app can offer 「이 기기 해지」 only for what the Mac said. */
export function apnsPayload(event: ScreenEvent, message: Uint8Array, signature: Uint8Array): string {
  return JSON.stringify({ aps: { alert: notificationText(event), sound: 'default' }, screen: { m: base64(message), s: base64(signature) } });
}

/** A weekly allowance banner, from the Mac-signed fields only: the Mac's name, the provider and the boundary. It says the
 * figure is what that Mac read, since the CLI account there may differ from the one open elsewhere. */
export function weeklyUsageText(usage: Pick<WeeklyUsageEvent, 'macName' | 'provider' | 'mark'>): { title: string; body: string } {
  const provider = USAGE_PROVIDER_NAMES[usage.provider];
  return {
    title: `${provider} 주간 사용량`,
    body: usage.mark === 0
      ? `‘${usage.macName}’에서 확인한 ${provider} 주간 사용량을 모두 썼습니다.`
      : `‘${usage.macName}’에서 확인한 ${provider} 주간 잔여가 ${usage.mark}% 미만입니다.`,
  };
}

/** The APNs body for a weekly alert: the banner only. No `screen` part, so the phone never offers a remote stop for it. */
export function weeklyUsagePayload(usage: WeeklyUsageEvent): string {
  return JSON.stringify({ aps: { alert: weeklyUsageText(usage), sound: 'default', 'thread-id': 'weekly-usage' } });
}

export interface ApnsResult { status: number; reason?: string }
export interface ApnsSender { send(target: PushTarget, payload: string, expiresAt: number, collapseID: string): Promise<ApnsResult> }

/** A token APNs says is gone for good: drop it. */
export const isDeadToken = (result: ApnsResult) =>
  result.status === 410 || (result.status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(result.reason ?? ''));

const base64url = (bytes: Uint8Array) => base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The provider token: ES256 over {alg, kid} . {iss, iat}, with the team's .p8 key (PKCS#8 PEM). */
export async function apnsJwt(keyP8: string, keyID: string, teamID: string, nowSeconds: number): Promise<string> {
  const der = fromBase64(keyP8.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, ''), 4096);
  if (!der || !/^[A-Z0-9]{10}$/.test(keyID) || !/^[A-Z0-9]{10}$/.test(teamID)) throw new ProtocolError('not_configured', 503);
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = base64url(encoder.encode(JSON.stringify({ alg: 'ES256', kid: keyID })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: teamID, iat: nowSeconds })));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(`${head}.${claims}`));
  return `${head}.${claims}.${base64url(new Uint8Array(signature))}`;
}

/** APNs over HTTP/2 (the runtime's fetch negotiates it). The provider token is reused for 40 minutes, as Apple asks,
 * and made again after APNs refuses it. */
export function createApnsSender(options: { keyP8: string; keyID: string; teamID: string; fetch: typeof fetch; now?: () => number }): ApnsSender {
  const now = options.now ?? Date.now;
  let cached: { jwt: string; at: number } | null = null;
  return {
    async send(target, payload, expiresAt, collapseID) {
      if (!cached || now() - cached.at > 40 * 60_000) {
        cached = { jwt: await apnsJwt(options.keyP8, options.keyID, options.teamID, Math.floor(now() / 1000)), at: now() };
      }
      const host = target.environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
      const response = await options.fetch(`https://${host}/3/device/${target.token}`, {
        method: 'POST', signal: AbortSignal.timeout(10_000), body: payload,
        headers: {
          authorization: `bearer ${cached.jwt}`, 'apns-topic': target.topic, 'apns-push-type': 'alert', 'apns-priority': '10',
          'apns-expiration': String(Math.floor(expiresAt / 1000)), 'apns-collapse-id': collapseID, 'content-type': 'application/json',
        },
      });
      let reason: string | undefined;
      if (response.status !== 200) {
        try { reason = String(((await response.json()) as { reason?: unknown }).reason ?? ''); } catch { reason = undefined; }
        if (response.status === 403) cached = null;
      }
      return { status: response.status, reason };
    },
  };
}

// MARK: the handler

export interface ScreenPushDeps {
  /** A PostgREST RPC with the service key. Throws when the call fails. */
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Null when the APNs secrets are not set: notify answers not_configured. */
  apns: ApnsSender | null;
  /** The app bundle IDs this relay pushes to (APNS_TOPICS). */
  allowedTopics: readonly string[];
  now?: () => number;
  randomHex?: (bytes: number) => string;
}

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const fail = (code: string, status: number) => json({ error: code }, status);

const ADMIT_STATUS: Record<string, [string, number] | undefined> = {
  replayed: ['replayed', 409], rate_limited: ['rate_limited', 429], busy: ['rate_limited', 429],
};
const RPC_STATUS: Record<string, number> = { not_ready: 409, not_registered: 409, unknown_device: 409, queue_full: 429 };

/** Bound untrusted bytes while reading, before allocating or parsing an entire request. Content-Length is optional
 * and cannot protect chunked uploads. Cancel as soon as the bound is crossed so the relay stops consuming them. */
async function requestText(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        await reader.cancel().catch(() => {});
        throw malformed();
      }
      if (value.byteLength) chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return strictText.decode(bytes);
  } finally { reader.releaseLock(); }
}

export function createScreenPushHandler(deps: ScreenPushDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const randomHex = deps.randomHex ?? ((n: number) => hex(crypto.getRandomValues(new Uint8Array(n))));

  /** Replay and rate limit, in one transaction: a nonce seen before or too many requests stop here. */
  async function admit(key: string, kind: RequestKind, nonceHex: string) {
    const { windowSeconds, limit } = RATE_LIMITS[kind];
    const verdict = await deps.rpc('portmgr_screen_push_admit', { p_key: key, p_kind: kind, p_nonce: nonceHex, p_window_seconds: windowSeconds, p_limit: limit });
    const refusal = ADMIT_STATUS[String(verdict)];
    if (refusal) throw new ProtocolError(...refusal);
    if (verdict !== 'ok') throw new ProtocolError('unavailable', 503);
  }

  async function signed(body: Record<string, unknown>) {
    const message = fromBase64(body.message), signature = fromBase64(body.signature, 128);
    if (!message || !signature) throw malformed();
    return { message, signature };
  }

  async function verified(key: Uint8Array, message: Uint8Array, signature: Uint8Array) {
    if (!(await verifySignature(key, message, signature))) throw new ProtocolError('bad_signature', 401);
  }

  function fresh(issuedAt: number, skew: number) {
    if (!isFresh(issuedAt, now(), skew)) throw new ProtocolError('expired', 400);
  }

  /** One APNs request per target; a token APNs calls dead is dropped. Returns how many Apple accepted. */
  async function deliver(mac: string, targets: PushTarget[], payload: string, expiresAt: number, collapseID: string): Promise<number> {
    if (encoder.encode(payload).length > 4096) throw malformed();
    const results = await Promise.all(targets.map(async target => {
      try {
        const result = await deps.apns!.send(target, payload, expiresAt, collapseID);
        if (isDeadToken(result)) await deps.rpc('portmgr_screen_push_drop_token', { p_mac: mac, p_device: target.deviceID, p_token: target.token });
        return result.status === 200;
      } catch { return false; }
    }));
    return results.filter(Boolean).length;
  }

  const routes: Record<string, (body: Record<string, unknown>) => Promise<Response>> = {
    async register(body) {
      const { message, signature } = await signed(body);
      const registration = decodeRegistration(message);
      await verified(registration.deviceKey, message, signature);
      fresh(registration.issuedAt, FRESHNESS.device);
      if (!deps.allowedTopics.includes(registration.topic)) throw new ProtocolError('bad_topic', 400);
      const deviceID = hex(await sha256(registration.deviceKey));
      await admit(deviceID, 'register', hex(registration.nonce));
      const verdict = String(await deps.rpc('portmgr_screen_push_register', {
        p_mac: hex(await sha256(registration.macKey)), p_device: deviceID, p_device_key: hex(registration.deviceKey),
        p_token: hex(registration.token), p_environment: registration.environment, p_topic: registration.topic,
      }));
      return verdict === 'ok' ? json({ ok: true }) : fail(verdict, RPC_STATUS[verdict] ?? 503);
    },

    async unregister(body) {
      const [mac, device, token] = [body.macFingerprint, body.deviceID, body.token].map(v => typeof v === 'string' ? v : '');
      if (!/^[0-9a-f]{64}$/.test(mac!) || !/^[0-9a-f]{64}$/.test(device!) || !/^[0-9a-f]{16,200}$/.test(token!)) throw malformed();
      await admit(hex(await sha256(encoder.encode(token!))), 'unregister', randomHex(16));
      await deps.rpc('portmgr_screen_push_unregister', { p_mac: mac, p_device: device, p_token: token });
      // The same answer whether or not it was there: it tells nobody which tokens exist.
      return json({ ok: true });
    },

    async notify(body) {
      if (!deps.apns) throw new ProtocolError('not_configured', 503);
      const { message, signature } = await signed(body);
      const event = decodeEvent(message);
      await verified(event.macKey, message, signature);
      fresh(event.issuedAt, FRESHNESS.mac);
      const mac = hex(await sha256(event.macKey));
      await admit(mac, 'notify', hex(event.nonce));
      const rows = (await deps.rpc('portmgr_screen_push_targets', { p_mac: mac, p_devices: event.recipients.map(hex) })) as PushTarget[];
      const targets = pushTargets(Array.isArray(rows) ? rows : [], event, deps.allowedTopics);
      const payload = apnsPayload(event, message, signature);
      const collapseID = `screen-${event.kind}-${hex(event.actorID).slice(0, 16)}`;
      return json({ ok: true, sent: await deliver(mac, targets, payload, event.eventAt + 3600_000, collapseID) });
    },

    /** A weekly allowance alert: signed by the Mac key like a screen event, for the devices the Mac named, under its own
     * budget. The collapse ID is the main app's alert key, so a device shows each boundary of a window once. */
    async 'weekly-usage'(body) {
      if (!deps.apns) throw new ProtocolError('not_configured', 503);
      const { message, signature } = await signed(body);
      const usage = decodeWeeklyUsage(message);
      await verified(usage.macKey, message, signature);
      fresh(usage.issuedAt, FRESHNESS.mac);
      // Seen by the main app before AgentsToZ Screen signed it, and not long before: an old hand-off is not news.
      if (usage.observedAt > usage.issuedAt + FRESHNESS.mac || usage.issuedAt - usage.observedAt > USAGE_MAX_AGE_MS) throw new ProtocolError('expired', 400);
      const mac = hex(await sha256(usage.macKey));
      await admit(mac, 'usage', hex(usage.nonce));
      const rows = (await deps.rpc('portmgr_screen_push_targets', { p_mac: mac, p_devices: usage.recipients.map(hex) })) as PushTarget[];
      const targets = pushTargets(Array.isArray(rows) ? rows : [], { recipients: usage.recipients }, deps.allowedTopics);
      const sent = await deliver(mac, targets, weeklyUsagePayload(usage), usage.observedAt + 6 * 3600_000, `weekly-${weeklyUsageKey(usage)}`);
      return json({ ok: true, sent });
    },

    async fetch(body) {
      const { message, signature } = await signed(body);
      const poll = decodeFetch(message);
      await verified(poll.macKey, message, signature);
      fresh(poll.issuedAt, FRESHNESS.mac);
      const macFingerprint = await sha256(poll.macKey);
      const mac = hex(macFingerprint);
      await admit(mac, 'fetch', hex(poll.nonce));
      // Only results this Mac signed are kept, so the phone never waits on one it will refuse.
      const results = [];
      for (const result of poll.results) {
        if (await verifySignature(poll.macKey, resultSignedData(macFingerprint, result), result.signature)) {
          results.push({ command_id: hex(result.commandID), result: base64(result.encoded) });
        }
      }
      const commands = await deps.rpc('portmgr_screen_push_sync', { p_mac: mac, p_devices: poll.deviceIDs.map(hex), p_results: results });
      return json({ ok: true, commands: Array.isArray(commands) ? commands.slice(0, WIRE.maxDevices) : [] });
    },

    async command(body) {
      const { message, signature } = await signed(body);
      const command = decodeCommand(message);
      await verified(command.deviceKey, message, signature);
      fresh(command.issuedAt, FRESHNESS.device);
      const device = hex(await sha256(command.deviceKey));
      await admit(device, 'command', hex(command.nonce));
      const verdict = String(await deps.rpc('portmgr_screen_push_queue', {
        p_command_id: hex(await sha256(message)), p_mac: hex(command.macFingerprint), p_device: device,
        p_message: base64(message), p_signature: base64(signature),
        p_expires_at: new Date(command.issuedAt + (ACTION_MAX_AGE[command.action]! + 120) * 1000).toISOString(),
      }));
      return verdict === 'ok' ? json({ ok: true }) : fail(verdict, RPC_STATUS[verdict] ?? 503);
    },

    async result(body) {
      const commandID = typeof body.commandID === 'string' ? body.commandID : '';
      if (!/^[0-9a-f]{64}$/.test(commandID)) throw malformed();
      await admit(commandID, 'result', randomHex(16));
      const result = await deps.rpc('portmgr_screen_push_status', { p_command_id: commandID });
      return json({ ok: true, result: typeof result === 'string' && result ? result : null });
    },
  };

  return async request => {
    if (request.method !== 'POST') return fail('method_not_allowed', 405);
    let body: Record<string, unknown>;
    try {
      const text = await requestText(request);
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('malformed', 400);
      body = parsed as Record<string, unknown>;
    } catch { return fail('malformed', 400); }
    const route = typeof body.type === 'string' && Object.hasOwn(routes, body.type) ? routes[body.type] : undefined;
    if (!route) return fail('malformed', 400);
    try {
      return await route(body);
    } catch (error) {
      if (error instanceof ProtocolError) return fail(error.code, error.status);
      return fail('unavailable', 503);
    }
  };
}
