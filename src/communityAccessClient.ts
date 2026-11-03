/** Public-key-only client. All private signing stays in the purpose-limited native broker. */
export const COMMUNITY_ACCESS_OPERATIONS = ['owner-delegation-set', 'owner-recovery-request', 'owner-recovery-poll', 'owner-recovery-publish', 'owner-recovery-list', 'owner-recovery-approve', 'owner-recovery-result', 'owner-recovery-status', 'screen-safety-subscribe', 'receiver-safety-poll', 'screen-safety-stop', 'screen-safety-result', 'receiver-safety-event', 'screen-safety-state', 'prepare', 'recover-registration', 'status', 'receipt', 'list', 'review', 'approve', 'review-management', 'approve-management',
  'authorization', 'directory', 'session-open', 'session-status', 'activity', 'session-close', 'relay-ticket',
  'receiver-status', 'receiver-directory', 'receiver-ticket', 'receiver-session',
  'component-status', 'component-directory', 'component-ticket', 'component-session'] as const;
export type CommunityAccessOperation = typeof COMMUNITY_ACCESS_OPERATIONS[number];
export const COMMUNITY_MOBILE_RELAY_PURPOSES=['mobile-agent','mobile-teams','mobile-agent-settings','mobile-browser'] as const;
export const COMMUNITY_RELAY_PURPOSES=['screen','agent','teams','agent-settings','browser',...COMMUNITY_MOBILE_RELAY_PURPOSES] as const;
export type CommunityMobileRelayPurpose=typeof COMMUNITY_MOBILE_RELAY_PURPOSES[number];
export type CommunityRelayPurpose=typeof COMMUNITY_RELAY_PURPOSES[number];
export function communityComponentSessionArgs(value:{communityId:string;purpose:CommunityMobileRelayPurpose;mobileEnrollmentId:string;sessionId:string}):readonly [string,CommunityMobileRelayPurpose,string,string]{
  if(![value.communityId,value.mobileEnrollmentId,value.sessionId].every(communityId)||!COMMUNITY_MOBILE_RELAY_PURPOSES.includes(value.purpose))return fail('INVALID_REQUEST');
  return Object.freeze([value.communityId,value.purpose,value.mobileEnrollmentId,value.sessionId] as const);
}
export interface CommunityAccessEnvelope { payload: string; signature: string }
export type CommunityAccessFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface CommunityAccessRequest {
  operation: CommunityAccessOperation; requestId: string; observedAt: number; nonce: string;
  actor: string | null; args: readonly unknown[];
}
export interface CommunityAccessSigner {
  readonly publicKey: string;
  /** Native implementation validates the typed operation, own identity and allowed purpose before signing. */
  signAccessRequest(request: Readonly<CommunityAccessRequest>): Promise<CommunityAccessEnvelope>;
}
export interface CommunityRelayTicketBody {
  version: 1; ticketId: string; communityId: string; enrollmentId: string; deviceId: string;
  deviceKind: 'desktop' | 'mobile'; connectionId: string; publicKey: string; purpose: CommunityRelayPurpose;
  role: 'host' | 'client'; sessionId: string | null; revision: number;
  issuedAt: number; expiresAt: number; leaseExpiresAt: number;
}
export class CommunityAccessClientError extends Error {
  constructor(readonly code: string, readonly outcome: 'refused' | 'unknown' = 'refused') {
    super(code); this.name = 'CommunityAccessClientError';
  }
}
const fail = (code: string): never => { throw new CommunityAccessClientError(code); };
const encoder = new TextEncoder();
const RESPONSE_DOMAIN = encoder.encode('agentstoz.community-access.response/v2\0');
const REQUEST_DOMAIN = encoder.encode('agentstoz.community-access.request/v2\0');
const verifiedReplies = new WeakSet<CommunityAccessReply>(), verifiedTickets = new WeakSet<CommunityRelayTicket>();
function immutableJSON(value: unknown): void {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) immutableJSON(child); }
}
function comparableJSON(value: unknown): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, child]) => [k, sorted(child)])) : v;
  return JSON.stringify(sorted(value));
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const communityId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
export function communityBase64(bytes: Uint8Array): string {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function communityBytes(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(maximum * 4 / 3)) return fail('INVALID_ENCODING');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
  catch { return fail('INVALID_ENCODING'); }
  if (bytes.length > maximum || communityBase64(bytes) !== value) return fail('INVALID_ENCODING');
  return bytes;
}
export function communityObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || !keys.every(k => Object.hasOwn(value, k))) return fail('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function publicPoint(value: unknown): value is string {
  const bytes = communityBytes(value, 65); if (bytes.length !== 65 || bytes[0] !== 4) return fail('INVALID_PUBLIC_KEY'); return true;
}
function envelope(value: unknown): CommunityAccessEnvelope {
  const obj = communityObject(value, ['payload', 'signature']);
  if (typeof obj.payload !== 'string' || typeof obj.signature !== 'string') return fail('INVALID_RESPONSE');
  return {payload: obj.payload, signature: obj.signature};
}
/** A verified response is not an execution receipt and its payload still needs operation-specific validation. */
export class CommunityAccessReply {
  private constructor(readonly kind: string, readonly requestId: string | null, readonly issuedAt: number,
    readonly payload: unknown, readonly envelope: CommunityAccessEnvelope) {}
  static isVerified(value: CommunityAccessReply): boolean { return verifiedReplies.has(value); }
  static async verify(value: unknown, issuerPublicKey: string, requestId: string, now = Date.now()): Promise<CommunityAccessReply> {
    const wrapped = envelope(value), bytes = communityBytes(wrapped.payload, 48_000), signature = communityBytes(wrapped.signature, 64);
    if (signature.length !== 64 || !publicPoint(issuerPublicKey)) return fail('INVALID_ISSUER');
    const input = new Uint8Array(RESPONSE_DOMAIN.length + bytes.length); input.set(RESPONSE_DOMAIN); input.set(bytes, RESPONSE_DOMAIN.length);
    try {
      const key = await crypto.subtle.importKey('raw', new Uint8Array(communityBytes(issuerPublicKey, 65)).buffer,
        {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']);
      if (!await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, key, new Uint8Array(signature).buffer, input.buffer)) return fail('INVALID_ISSUER');
    } catch { return fail('INVALID_ISSUER'); }
    let fields: unknown;
    try { fields = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); } catch { return fail('INVALID_RESPONSE'); }
    if (!Array.isArray(fields) || fields.length !== 5 || fields[0] !== 2 || typeof fields[1] !== 'string'
      || fields[2] !== requestId || !integer(fields[3]) || fields[3] > now + 5_000 || fields[3] < now - 60_000) return fail('STALE_RESPONSE');
    immutableJSON(fields[4]);
    const reply = new CommunityAccessReply(fields[1], fields[2], fields[3], fields[4], Object.freeze(wrapped));
    verifiedReplies.add(reply); return Object.freeze(reply);
  }
}
/** Only issuer-verified ticket replies can construct this credential. The envelope is short-lived and single-use. */
export class CommunityRelayTicket {
  private constructor(readonly body: Readonly<CommunityRelayTicketBody>, readonly envelope: CommunityAccessEnvelope) {}
  static fromReply(reply: CommunityAccessReply, expected: {
    communityId: string; enrollmentId: string; deviceId: string; connectionId: string;
    publicKey: string; purpose: CommunityRelayPurpose; role: 'host' | 'client'; sessionId: string | null;
  }, now = Date.now()): CommunityRelayTicket {
    if (!verifiedReplies.has(reply) || reply.kind !== 'ticket') return fail('INVALID_TICKET');
    const t = communityObject(reply.payload, ['version', 'ticketId', 'communityId', 'enrollmentId', 'deviceId', 'deviceKind', 'connectionId',
      'publicKey', 'purpose', 'role', 'sessionId', 'revision', 'issuedAt', 'expiresAt', 'leaseExpiresAt']);
    if (t.version !== 1 || !['ticketId', 'communityId', 'enrollmentId', 'deviceId', 'connectionId'].every(k => communityId(t[k]))
      || t.ticketId !== reply.requestId || t.issuedAt !== reply.issuedAt || !publicPoint(t.publicKey)
      || !['desktop', 'mobile'].includes(t.deviceKind as string) || !COMMUNITY_RELAY_PURPOSES.includes(t.purpose as CommunityRelayPurpose)
      || !['host', 'client'].includes(t.role as string) || !(t.sessionId === null || communityId(t.sessionId))
      || !integer(t.revision) || !integer(t.issuedAt) || !integer(t.expiresAt) || !integer(t.leaseExpiresAt)
      || t.issuedAt > now || t.expiresAt <= now || t.expiresAt > t.issuedAt + 30_000 || t.leaseExpiresAt < t.expiresAt
      || t.leaseExpiresAt > t.issuedAt + 90_000 || (t.deviceKind === 'mobile' ? t.role !== 'client' || t.sessionId === null : t.sessionId !== null)
      || (COMMUNITY_MOBILE_RELAY_PURPOSES.includes(t.purpose as CommunityMobileRelayPurpose) ? t.role !== (t.deviceKind === 'mobile' ? 'client' : 'host') : t.deviceKind === 'mobile' && t.purpose !== 'screen')
      || !Object.entries(expected).every(([k, v]) => t[k] === v)) return fail('INVALID_TICKET');
    const ticket = new CommunityRelayTicket(Object.freeze({...t}) as unknown as CommunityRelayTicketBody, reply.envelope);
    verifiedTickets.add(ticket); return Object.freeze(ticket);
  }
  static isVerified(value: CommunityRelayTicket): boolean { return verifiedTickets.has(value); }
}
export function communityAuthority(origin: string): URL {
  let url: URL; try { url = new URL(origin); } catch { return fail('INVALID_AUTHORITY'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return fail('INVALID_AUTHORITY');
  return url;
}
export function communityRequestBytes(r: Readonly<CommunityAccessRequest>): Uint8Array {
  if (!COMMUNITY_ACCESS_OPERATIONS.includes(r.operation) || !communityId(r.requestId) || !integer(r.observedAt)
    || !(r.actor === null || communityId(r.actor)) || communityBytes(r.nonce, 32).length !== 32
    || !Array.isArray(r.args) || r.args.length > (r.operation === 'approve-management' ? 6 : 5)) return fail('INVALID_REQUEST');
  const result = encoder.encode(JSON.stringify([2, r.operation, r.requestId, r.observedAt, r.nonce, r.actor, r.args]));
  if (result.length > 24_000) return fail('REQUEST_TOO_LARGE'); return result;
}
export class CommunityAccessClient {
  readonly origin: string;
  constructor(origin: string, private readonly issuerPublicKey: string, private readonly signer: CommunityAccessSigner,
    private readonly fetcher: CommunityAccessFetch = fetch, private readonly clock = Date.now) {
    this.origin = communityAuthority(origin).origin; publicPoint(issuerPublicKey); publicPoint(signer.publicKey);
  }
  /** No retry or journal reset. Caller persists mutating intent before this call and recovers its original request ID on uncertainty. */
  async exchange(request: Readonly<CommunityAccessRequest>): Promise<CommunityAccessReply> {
    // Freeze a canonical copy before native approval so JS mutation cannot change the signed dispatch.
    const bytes = communityRequestBytes(request), fields = JSON.parse(new TextDecoder().decode(bytes)) as unknown[];
    const snapshot: CommunityAccessRequest = {operation: fields[1] as CommunityAccessOperation, requestId: fields[2] as string,
      observedAt: fields[3] as number, nonce: fields[4] as string, actor: fields[5] as string | null, args: fields[6] as unknown[]};
    immutableJSON(snapshot);
    // Preserve native JSON bytes. Swift and JS may serialize object keys in different orders for the same typed intent.
    const proof = envelope(await this.signer.signAccessRequest(snapshot)), nativeBytes = communityBytes(proof.payload, 24_000), signature = communityBytes(proof.signature, 64);
    let nativeFields: unknown;
    try { nativeFields = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(nativeBytes)); } catch { return fail('INVALID_NATIVE_PROOF'); }
    if (signature.length !== 64 || comparableJSON(nativeFields) !== comparableJSON(fields)) return fail('INVALID_NATIVE_PROOF');
    const input = new Uint8Array(REQUEST_DOMAIN.length + nativeBytes.length); input.set(REQUEST_DOMAIN); input.set(nativeBytes, REQUEST_DOMAIN.length);
    try {
      const key = await crypto.subtle.importKey('raw', new Uint8Array(communityBytes(this.signer.publicKey, 65)).buffer,
        {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']);
      if (!await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, key, new Uint8Array(signature).buffer, input.buffer)) return fail('INVALID_NATIVE_PROOF');
    } catch { return fail('INVALID_NATIVE_PROOF'); }
    const body = JSON.stringify(proof);
    if (encoder.encode(body).length > 32_768) return fail('REQUEST_TOO_LARGE');
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 12_000);
    let rejection: CommunityAccessClientError | undefined;
    try {
      const response = await this.fetcher(`${this.origin}/v2`, {method: 'POST', headers: {'content-type': 'application/json'}, body,
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: abort.signal});
      if (response.status !== 200 && response.status !== 400) throw new CommunityAccessClientError('SERVICE_UNAVAILABLE', 'unknown');
      const reader = response.body?.getReader(); if (!reader) throw new CommunityAccessClientError('INVALID_RESPONSE', 'unknown');
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) { const next = await reader.read(); if (next.done) break; length += next.value.length;
        if (length > 70_000) { await reader.cancel(); throw new CommunityAccessClientError('RESPONSE_TOO_LARGE', 'unknown'); } chunks.push(next.value); }
      const joined = new Uint8Array(length); let cursor = 0; for (const chunk of chunks) { joined.set(chunk, cursor); cursor += chunk.length; }
      const reply = await CommunityAccessReply.verify(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(joined)), this.issuerPublicKey, snapshot.requestId, this.clock());
      if (reply.kind === 'error') {
        const error = communityObject(reply.payload, ['code']); if (typeof error.code !== 'string' || !/^[A-Z_]{1,64}$/.test(error.code)) return fail('INVALID_RESPONSE');
        rejection = new CommunityAccessClientError(error.code, ['SERVICE_UNAVAILABLE', 'UNAVAILABLE', 'REQUEST_CONFLICT'].includes(error.code) ? 'unknown' : 'refused');
        throw rejection;
      }
      const kinds: Record<CommunityAccessOperation, readonly string[]> = {
        'owner-delegation-set':['owner-delegation'],'owner-recovery-request':['owner-recovery'],'owner-recovery-poll':['owner-recovery-round'],
        'owner-recovery-publish':['owner-recovery'],'owner-recovery-list':['owner-recovery-list'],'owner-recovery-approve':['owner-recovery'],
        'owner-recovery-result':['owner-recovery'],'owner-recovery-status':['owner-recovery','owner-recovery-absent'],
        'screen-safety-subscribe':['safety-subscribed'],'receiver-safety-poll':['safety-round'],'screen-safety-stop':['safety-result'],'screen-safety-result':['safety-result'],'receiver-safety-event':['safety-event'],'screen-safety-state':['safety-state'],
        prepare: ['prepared'], status: ['prepared', 'authorization'], receipt: ['receipt'], list: ['pending-list'], review: ['review'], approve: ['authorization'],
        'recover-registration': ['prepared', 'authorization', 'registration-absent'], 'review-management': ['management-review'], 'approve-management': ['authorization'],
        authorization: ['authorization'], directory: ['directory'], 'session-open': ['session'], 'session-status': ['session'], activity: ['session'],
        'session-close': ['session-closed'], 'relay-ticket': ['ticket'],
        'receiver-status': ['authorization'], 'receiver-directory': ['directory'], 'receiver-ticket': ['ticket'],
        'receiver-session': ['session'], 'component-status': ['authorization'], 'component-directory': ['directory'], 'component-ticket': ['ticket'], 'component-session': ['session'],
      };
      if (!kinds[snapshot.operation].includes(reply.kind)) throw new CommunityAccessClientError('UNEXPECTED_RESPONSE', 'unknown');
      return reply;
    } catch (error) {
      if (rejection !== undefined && error === rejection || error instanceof CommunityAccessClientError && error.outcome === 'unknown') throw error;
      // Only an issuer-signed, operation-bound rejection proves refusal. Invalid/unsigned replies remain uncertain.
      throw new CommunityAccessClientError('RESPONSE_UNCONFIRMED', 'unknown');
    } finally { clearTimeout(timer); }
  }
}
