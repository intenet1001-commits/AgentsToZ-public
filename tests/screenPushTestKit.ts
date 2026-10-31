// Test-side writer for the screen push messages: what the Mac and the phone send (PushCommands.swift), built
// independently of the relay's reader in supabase/functions/screen-push/protocol.ts.
import { PGlite } from '@electric-sql/pglite';
import { createECDH } from 'node:crypto';
import { SCREEN_PUSH_SQL } from '../src/screenPushSql';
import { encodeFields, fromHex, hex, LABELS, sha256, type Bytes } from '../supabase/functions/screen-push/protocol';

/** A database with the relay's SQL, `auth.role()` read from the `test.role` setting. */
export async function screenPushDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create function auth.role() returns text language sql as $$ select current_setting('test.role', true) $$;`);
  await db.exec(SCREEN_PUSH_SQL);
  return db;
}

export interface TestKey { scalar: Bytes; publicKey: Bytes; fingerprint: Bytes; sign(data: Uint8Array): Promise<Bytes> }

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const text = (value: string) => new TextEncoder().encode(value);
export const u64 = (value: number) => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, BigInt(value)); return out; };

/** A P-256 key from a fixed scalar, signing raw r ‖ s like CryptoKit's rawRepresentation. */
export async function testKey(scalar: Uint8Array | string): Promise<TestKey> {
  const d = typeof scalar === 'string' ? await sha256(text(scalar)) : new Uint8Array(scalar);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(d));
  const publicKey = new Uint8Array(ecdh.getPublicKey());
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(publicKey.slice(1, 33)), y: b64url(publicKey.slice(33)),
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return {
    scalar: d, publicKey, fingerprint: await sha256(publicKey),
    sign: async data => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data.slice())),
  };
}

export const registration = (o: { mac: TestKey; device: TestKey; token: Uint8Array; production: boolean; topic: string; issuedAt: number; nonce: Uint8Array }) =>
  encodeFields([text(LABELS.register), o.mac.publicKey, o.device.publicKey, o.token, new Uint8Array([o.production ? 1 : 0]), text(o.topic), u64(o.issuedAt), o.nonce]);

export const event = (o: { mac: TestKey; kind: 1 | 2 | 3 | 4; eventAt: number; macName: string; actorID: Uint8Array; actorName: string; recipients: Uint8Array[]; issuedAt: number; nonce: Uint8Array }) =>
  encodeFields([text(LABELS.notify), o.mac.publicKey, new Uint8Array([o.kind]), u64(o.eventAt), text(o.macName), o.actorID, text(o.actorName),
    new Uint8Array(o.recipients.flatMap(r => [...r])), u64(o.issuedAt), o.nonce]);

export const command = (o: { macFingerprint: Uint8Array; device: TestKey; action: 1 | 2 | 3 | 4; target?: Uint8Array; issuedAt: number; nonce: Uint8Array }) =>
  encodeFields([text(LABELS.command), o.macFingerprint, o.device.publicKey, new Uint8Array([o.action]), o.target ?? new Uint8Array(), u64(o.issuedAt), o.nonce]);

/** A weekly allowance alert as AgentsToZ Screen signs it (WeeklyUsageEvent in PushCommands.swift). Provider 1 claude, 2 codex, 3 agy. */
export const weeklyUsage = (o: { mac: TestKey; macName: string; provider: number; mark: number; windowKey: string; observedAt: number; recipients: Uint8Array[]; issuedAt: number; nonce: Uint8Array }) =>
  encodeFields([text(LABELS.usage), o.mac.publicKey, text(o.macName), new Uint8Array([o.provider]), new Uint8Array([o.mark]), text(o.windowKey),
    u64(o.observedAt), new Uint8Array(o.recipients.flatMap(r => [...r])), u64(o.issuedAt), o.nonce]);

export async function result(mac: TestKey, commandID: Uint8Array, outcome: number): Promise<Bytes> {
  const signed = encodeFields([text(LABELS.result), mac.fingerprint, commandID, new Uint8Array([outcome])]);
  const out = new Uint8Array(97);
  out.set(commandID, 0);
  out[32] = outcome;
  out.set(await mac.sign(signed), 33);
  return out;
}

export const fetchMessage = (o: { mac: TestKey; deviceIDs: Uint8Array[]; results: Uint8Array[]; issuedAt: number; nonce: Uint8Array }) =>
  encodeFields([text(LABELS.fetch), o.mac.publicKey, new Uint8Array(o.deviceIDs.flatMap(r => [...r])), new Uint8Array(o.results.flatMap(r => [...r])), u64(o.issuedAt), o.nonce]);

export const nonceOf = (n: number) => Uint8Array.from({ length: 16 }, (_, i) => (n * 16 + i) & 0xff);
export const bytes = (h: string) => fromHex(h) ?? (() => { throw Error('bad hex ' + h); })();
export { hex };
