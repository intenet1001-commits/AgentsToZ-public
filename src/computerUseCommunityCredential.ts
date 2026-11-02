import {createPublicKey, ECDH, verify} from 'node:crypto';

/**
 * Independent enrollment-authority certificate verification. This is not connected to the v1 mailbox and is not an
 * admission decision: an authenticated exchange, online membership lease and the receiver's own policy are also needed.
 * The issuer key MUST come from the signed application or a verified trust-root rotation, never from the mailbox.
 */
export interface ComputerUseCommunityCredential {
  version: 1;
  purpose: 'agentstoz-computer-use-device';
  issuer: string;
  profileId: string;
  deviceId: string;
  enrollmentId: string;
  keyEpoch: number;
  membershipRevision: number;
  issuedAt: number;
  expiresAt: number;
  identityPublicKey: string;
}

const keys = ['version', 'purpose', 'issuer', 'profileId', 'deviceId', 'enrollmentId', 'keyEpoch',
  'membershipRevision', 'issuedAt', 'expiresAt', 'identityPublicKey'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const issuerPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_VALIDITY_MS = 24 * 60 * 60 * 1000;
const DOMAIN = 'agentstoz.computer-use.enrollment-credential/v1';

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function point(encoded: unknown): Buffer {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(encoded)) throw Error('invalid public key');
  const data = Buffer.from(encoded, 'base64url');
  if (data.length !== 65 || data[0] !== 4 || data.toString('base64url') !== encoded) throw Error('invalid public key');
  const checked = ECDH.convertKey(data, 'prime256v1', undefined, undefined, 'uncompressed');
  if (!Buffer.isBuffer(checked) || !checked.equals(data)) throw Error('invalid public key');
  return data;
}

function p256PublicKey(encoded: string) {
  const data = point(encoded);
  return createPublicKey({format: 'jwk', key: {kty: 'EC', crv: 'P-256',
    x: data.subarray(1, 33).toString('base64url'), y: data.subarray(33).toString('base64url')}});
}

function frame(fields: readonly string[]): Buffer {
  return Buffer.concat(fields.flatMap(value => {
    const data = Buffer.from(value, 'utf8'), length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return [length, data];
  }));
}

/** A strict, deterministic signature input; rejects extensions instead of silently leaving a field unsigned. */
export function computerUseCommunityCredentialBytes(value: unknown): Buffer {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
    throw Error('invalid credential fields');
  if (value.version !== 1 || value.purpose !== 'agentstoz-computer-use-device'
    || typeof value.issuer !== 'string' || !issuerPattern.test(value.issuer)
    || typeof value.profileId !== 'string' || !uuid.test(value.profileId)
    || typeof value.deviceId !== 'string' || !uuid.test(value.deviceId)
    || typeof value.enrollmentId !== 'string' || !uuid.test(value.enrollmentId)) throw Error('invalid credential binding');
  for (const field of ['keyEpoch', 'membershipRevision', 'issuedAt', 'expiresAt'] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 1) throw Error('invalid credential number');
  }
  const issuedAt = value.issuedAt as number, expiresAt = value.expiresAt as number;
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) throw Error('invalid credential lifetime');
  point(value.identityPublicKey);
  return frame([DOMAIN, '1', value.purpose, value.issuer, value.profileId, value.deviceId, value.enrollmentId,
    String(value.keyEpoch), String(value.membershipRevision), String(issuedAt), String(expiresAt), value.identityPublicKey as string]);
}

/**
 * Returns the validated credential only for an exact expected subject and trusted issuer. Certificates are public;
 * this function does not assert current community membership or protect against subsequent revocation.
 */
export function verifyComputerUseCommunityCredential(input: {credential: unknown; signature: unknown;
  trustedIssuers: ReadonlyMap<string, string>; profileId: string; deviceId: string; now: number;
  minimumKeyEpoch: number; minimumMembershipRevision: number}): ComputerUseCommunityCredential | null {
  try {
    const c = input.credential;
    const bytes = computerUseCommunityCredentialBytes(c);
    if (!plain(c) || typeof c.issuer !== 'string' || typeof c.issuedAt !== 'number' || typeof c.expiresAt !== 'number'
      || typeof c.keyEpoch !== 'number' || typeof c.membershipRevision !== 'number') return null;
    if (!uuid.test(input.profileId) || !uuid.test(input.deviceId) || c.profileId !== input.profileId || c.deviceId !== input.deviceId
      || !Number.isSafeInteger(input.now) || input.now < c.issuedAt || input.now >= c.expiresAt
      || !Number.isSafeInteger(input.minimumKeyEpoch) || input.minimumKeyEpoch < 1 || c.keyEpoch < input.minimumKeyEpoch
      || !Number.isSafeInteger(input.minimumMembershipRevision) || input.minimumMembershipRevision < 1
      || c.membershipRevision < input.minimumMembershipRevision) return null;
    const trusted = input.trustedIssuers.get(c.issuer);
    if (!trusted || typeof input.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(input.signature)) return null;
    const signature = Buffer.from(input.signature, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== input.signature) return null;
    if (!verify('sha256', bytes, {key: p256PublicKey(trusted), dsaEncoding: 'ieee-p1363'}, signature)) return null;
    return {...c} as unknown as ComputerUseCommunityCredential;
  } catch { return null; }
}
