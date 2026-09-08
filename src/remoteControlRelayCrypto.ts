import {
  REMOTE_CONTROL_RELAY_NONCE_BYTES,
  REMOTE_CONTROL_RELAY_P256_PUBLIC_KEY_BYTES,
  type RemoteControlRelayEnvelope,
  type RemoteControlRelayEnvelopeMetadata,
  canonicalRemoteControlRelayAad,
  decodeRemoteControlRelayBase64Url,
  encodeRemoteControlRelayBase64Url,
  isRemoteControlRelayExpired,
  normalizeRemoteControlRelayId,
  parseRemoteControlRelayEnvelope,
  parseRemoteControlRelayEnvelopeMetadata,
} from './remoteControlRelayContract';

export const REMOTE_CONTROL_RELAY_CURVE = 'P-256' as const;
export const REMOTE_CONTROL_RELAY_MAX_PLAINTEXT_BYTES = 11_000;
export const REMOTE_CONTROL_RELAY_HKDF_HASH = 'SHA-256' as const;

const HKDF_SALT_DOMAIN = 'agentstoz.remote-control.relay/hkdf-salt/v1';
const HKDF_INFO_DOMAIN = 'agentstoz.remote-control.relay/hkdf-info/v1';
const AES_KEY_LENGTH = 256;
const AES_GCM_TAG_LENGTH = 128;
const textEncoder = new TextEncoder();

export type RemoteControlRelayDirection = 'controller-to-host' | 'host-to-controller';
export type RemoteControlRelayAesUsage = 'encrypt' | 'decrypt';

export interface RemoteControlRelaySessionKeyInput {
  privateKey: CryptoKey;
  peerPublicKey: CryptoKey;
  sessionId: string;
  controllerId: string;
  direction: RemoteControlRelayDirection;
  usages?: readonly RemoteControlRelayAesUsage[];
}

export interface EncryptRemoteControlRelayEnvelopeInput {
  key: CryptoKey;
  metadata: RemoteControlRelayEnvelopeMetadata;
  plaintext: Uint8Array;
  now?: number;
}

export interface DecryptRemoteControlRelayEnvelopeInput {
  key: CryptoKey;
  envelope: unknown;
  now?: number;
  expected?: Partial<Pick<RemoteControlRelayEnvelopeMetadata,
    'messageId' | 'sessionId' | 'controllerId' | 'sequence'>>;
}

export class RemoteControlRelayCryptoError extends Error {
  constructor(
    readonly code: string,
    message = '외부 원격제어 암호화 처리를 완료하지 못했습니다.',
  ) {
    super(message);
    this.name = 'RemoteControlRelayCryptoError';
  }
}

function fail(code: string, message?: string): never {
  throw new RemoteControlRelayCryptoError(code, message);
}

function webCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== 'function') {
    return fail('WEBCRYPTO_UNAVAILABLE', '이 환경은 WebCrypto를 지원하지 않습니다.');
  }
  return globalThis.crypto;
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function isP256EcdhKey(key: CryptoKey, type: 'private' | 'public'): boolean {
  const algorithm = key.algorithm as EcKeyAlgorithm;
  return key.type === type
    && algorithm.name === 'ECDH'
    && algorithm.namedCurve === REMOTE_CONTROL_RELAY_CURVE;
}

function requireAesGcmKey(key: CryptoKey, usage: RemoteControlRelayAesUsage): void {
  if (!isRemoteControlRelaySessionKey(key, usage)) {
    fail('INVALID_SESSION_KEY', `AES-256-GCM ${usage} 세션 키가 필요합니다.`);
  }
}

export function isRemoteControlRelaySessionKey(
  value: unknown,
  usage: RemoteControlRelayAesUsage,
): value is CryptoKey {
  if (typeof CryptoKey === 'undefined' || !(value instanceof CryptoKey)) return false;
  const key = value;
  const algorithm = key.algorithm as AesKeyAlgorithm;
  return key.type === 'secret'
    && key.extractable === false
    && algorithm.name === 'AES-GCM'
    && algorithm.length === AES_KEY_LENGTH
    && key.usages.length === 1
    && key.usages[0] === usage;
}

function normalizeUsages(value: readonly RemoteControlRelayAesUsage[] | undefined): RemoteControlRelayAesUsage[] {
  const usages: RemoteControlRelayAesUsage[] = value ? [...value] : ['encrypt', 'decrypt'];
  if (usages.length < 1
    || usages.length > 2
    || usages.some(usage => usage !== 'encrypt' && usage !== 'decrypt')
    || new Set(usages).size !== usages.length) {
    return fail('INVALID_KEY_USAGE', '세션 키 용도는 encrypt/decrypt 중 하나 이상이어야 합니다.');
  }
  return usages;
}

function normalizeDirection(value: unknown): RemoteControlRelayDirection {
  if (value !== 'controller-to-host' && value !== 'host-to-controller') {
    return fail('INVALID_DIRECTION', '릴레이 암호화 방향이 올바르지 않습니다.');
  }
  return value;
}

export async function generateRemoteControlRelayKeyPair(): Promise<CryptoKeyPair> {
  const generated = await webCrypto().subtle.generateKey(
    { name: 'ECDH', namedCurve: REMOTE_CONTROL_RELAY_CURVE },
    false,
    ['deriveBits'],
  );
  if (!('publicKey' in generated)
    || !isP256EcdhKey(generated.publicKey, 'public')
    || !isP256EcdhKey(generated.privateKey, 'private')) {
    return fail('KEY_GENERATION_FAILED');
  }
  return generated;
}

export async function exportRemoteControlRelayPublicKey(publicKey: CryptoKey): Promise<string> {
  if (!isP256EcdhKey(publicKey, 'public')) return fail('INVALID_PUBLIC_KEY');
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await webCrypto().subtle.exportKey('raw', publicKey));
  } catch {
    return fail('PUBLIC_KEY_EXPORT_FAILED');
  }
  if (bytes.byteLength !== REMOTE_CONTROL_RELAY_P256_PUBLIC_KEY_BYTES || bytes[0] !== 0x04) {
    return fail('INVALID_PUBLIC_KEY');
  }
  return encodeRemoteControlRelayBase64Url(bytes);
}

export async function importRemoteControlRelayPublicKey(encoded: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try {
    bytes = decodeRemoteControlRelayBase64Url(encoded, 'P-256 public key');
  } catch {
    return fail('INVALID_PUBLIC_KEY');
  }
  if (bytes.byteLength !== REMOTE_CONTROL_RELAY_P256_PUBLIC_KEY_BYTES || bytes[0] !== 0x04) {
    return fail('INVALID_PUBLIC_KEY');
  }
  try {
    return await webCrypto().subtle.importKey(
      'raw',
      copyBuffer(bytes),
      { name: 'ECDH', namedCurve: REMOTE_CONTROL_RELAY_CURVE },
      true,
      [],
    );
  } catch {
    return fail('INVALID_PUBLIC_KEY');
  }
}

export const REMOTE_CONTROL_RELAY_P256_SCALAR_BYTES = 32;
const REMOTE_CONTROL_RELAY_HOST_KEY_GENERATION_ATTEMPTS = 3;

/**
 * A host key pair whose private scalar can be written down once, then re-imported
 * as a NON-extractable key.
 *
 * `generateRemoteControlRelayKeyPair` is deliberately non-extractable, which is
 * right for a key that only has to live as long as the process. The internet
 * host is the opposite case: if its key dies with the process, every app restart
 * makes the Mac a different host and every paired phone has to scan a new QR.
 *
 * So the scalar is exported exactly once, at generation, and the caller persists
 * it. The handle returned here — and the one `importRemoteControlRelayHostKeyPair`
 * returns — is non-extractable, so nothing downstream can export the key again;
 * the only copy outside the process is the one the caller chose to store.
 */
export async function generateRemoteControlRelayHostKeyPair(): Promise<{
  keyPair: CryptoKeyPair;
  privateScalar: string;
  publicKey: string;
}> {
  // Bun's WebCrypto has occasionally rejected a freshly generated P-256 JWK
  // during its immediate non-extractable re-import. At this point no identity
  // has been registered or persisted, so discarding that fresh ephemeral pair
  // is safe. Persisted keys still use `importRemoteControlRelayHostKeyPair`
  // directly and remain fail-closed on every malformed or failed import.
  for (let attempt = 0; attempt < REMOTE_CONTROL_RELAY_HOST_KEY_GENERATION_ATTEMPTS; attempt += 1) {
    let extractable: CryptoKeyPair;
    try {
      extractable = await webCrypto().subtle.generateKey(
        { name: 'ECDH', namedCurve: REMOTE_CONTROL_RELAY_CURVE },
        true,
        ['deriveBits'],
      ) as CryptoKeyPair;
    } catch {
      return fail('KEY_GENERATION_FAILED');
    }
    if (!('publicKey' in extractable)
      || !isP256EcdhKey(extractable.publicKey, 'public')
      || !isP256EcdhKey(extractable.privateKey, 'private')) {
      return fail('KEY_GENERATION_FAILED');
    }
    let jwk: JsonWebKey;
    try {
      jwk = await webCrypto().subtle.exportKey('jwk', extractable.privateKey);
    } catch {
      return fail('KEY_GENERATION_FAILED');
    }
    if (typeof jwk.d !== 'string' || !jwk.d) return fail('KEY_GENERATION_FAILED');
    const publicKey = await exportRemoteControlRelayPublicKey(extractable.publicKey);
    try {
      // Re-import so the pair actually used for derivation cannot be exported.
      const keyPair = await importRemoteControlRelayHostKeyPair(jwk.d, publicKey);
      return { keyPair, privateScalar: jwk.d, publicKey };
    } catch (error) {
      if (!(error instanceof RemoteControlRelayCryptoError)
        || error.code !== 'INVALID_PRIVATE_KEY'
        || attempt + 1 >= REMOTE_CONTROL_RELAY_HOST_KEY_GENERATION_ATTEMPTS) {
        throw error;
      }
    }
  }
  return fail('KEY_GENERATION_FAILED');
}

/** Rebuild a stored host key pair. The private handle is non-extractable. */
export async function importRemoteControlRelayHostKeyPair(
  privateScalar: string,
  encodedPublicKey: string,
): Promise<CryptoKeyPair> {
  let scalar: Uint8Array;
  try {
    scalar = decodeRemoteControlRelayBase64Url(privateScalar, 'P-256 private scalar');
  } catch {
    return fail('INVALID_PRIVATE_KEY');
  }
  if (scalar.byteLength !== REMOTE_CONTROL_RELAY_P256_SCALAR_BYTES) return fail('INVALID_PRIVATE_KEY');
  let point: Uint8Array;
  try {
    point = decodeRemoteControlRelayBase64Url(encodedPublicKey, 'P-256 public key');
  } catch {
    return fail('INVALID_PUBLIC_KEY');
  }
  if (point.byteLength !== REMOTE_CONTROL_RELAY_P256_PUBLIC_KEY_BYTES || point[0] !== 0x04) {
    return fail('INVALID_PUBLIC_KEY');
  }
  const publicKey = await importRemoteControlRelayPublicKey(encodedPublicKey);
  let privateKey: CryptoKey;
  try {
    privateKey = await webCrypto().subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: REMOTE_CONTROL_RELAY_CURVE,
        d: encodeRemoteControlRelayBase64Url(scalar),
        x: encodeRemoteControlRelayBase64Url(point.slice(1, 33)),
        y: encodeRemoteControlRelayBase64Url(point.slice(33, 65)),
        ext: false,
        key_ops: ['deriveBits'],
      },
      { name: 'ECDH', namedCurve: REMOTE_CONTROL_RELAY_CURVE },
      false,
      ['deriveBits'],
    );
  } catch {
    return fail('INVALID_PRIVATE_KEY');
  }
  if (!isP256EcdhKey(privateKey, 'private')) return fail('INVALID_PRIVATE_KEY');
  return { privateKey, publicKey };
}

/** Stable, non-secret fingerprint for the explicit Mac/controller approval UI. */
export async function fingerprintRemoteControlRelayPublicKey(encoded: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = decodeRemoteControlRelayBase64Url(encoded, 'P-256 public key');
  } catch {
    return fail('INVALID_PUBLIC_KEY');
  }
  if (bytes.byteLength !== REMOTE_CONTROL_RELAY_P256_PUBLIC_KEY_BYTES || bytes[0] !== 0x04) {
    return fail('INVALID_PUBLIC_KEY');
  }
  await importRemoteControlRelayPublicKey(encoded);
  const digest = await webCrypto().subtle.digest('SHA-256', copyBuffer(bytes));
  return encodeRemoteControlRelayBase64Url(new Uint8Array(digest));
}

export async function deriveRemoteControlRelaySessionKey(
  input: RemoteControlRelaySessionKeyInput,
): Promise<CryptoKey> {
  if (!isP256EcdhKey(input.privateKey, 'private')
    || !input.privateKey.usages.includes('deriveBits')
    || !isP256EcdhKey(input.peerPublicKey, 'public')) {
    return fail('INVALID_ECDH_KEY');
  }
  const sessionId = normalizeRemoteControlRelayId(input.sessionId, 'sessionId');
  const controllerId = normalizeRemoteControlRelayId(input.controllerId, 'controllerId');
  const direction = normalizeDirection(input.direction);
  const usages = normalizeUsages(input.usages);
  const subtle = webCrypto().subtle;
  let sharedBytes: Uint8Array;
  try {
    sharedBytes = new Uint8Array(await subtle.deriveBits(
      { name: 'ECDH', public: input.peerPublicKey },
      input.privateKey,
      AES_KEY_LENGTH,
    ));
  } catch {
    return fail('KEY_AGREEMENT_FAILED');
  }

  try {
    const hkdfBase = await subtle.importKey('raw', copyBuffer(sharedBytes), 'HKDF', false, ['deriveKey']);
    const salt = await subtle.digest(
      REMOTE_CONTROL_RELAY_HKDF_HASH,
      copyBuffer(textEncoder.encode(`${HKDF_SALT_DOMAIN}\0${sessionId}`)),
    );
    const info = copyBuffer(textEncoder.encode(`${HKDF_INFO_DOMAIN}\0${sessionId}\0${controllerId}\0${direction}`));
    return await subtle.deriveKey(
      {
        name: 'HKDF',
        hash: REMOTE_CONTROL_RELAY_HKDF_HASH,
        salt,
        info,
      },
      hkdfBase,
      { name: 'AES-GCM', length: AES_KEY_LENGTH },
      false,
      usages,
    );
  } catch {
    return fail('KEY_DERIVATION_FAILED');
  } finally {
    sharedBytes.fill(0);
  }
}

function normalizedMetadata(value: RemoteControlRelayEnvelopeMetadata): RemoteControlRelayEnvelopeMetadata {
  return parseRemoteControlRelayEnvelopeMetadata({
    schemaVersion: value.schemaVersion,
    messageId: value.messageId,
    sessionId: value.sessionId,
    controllerId: value.controllerId,
    sequence: value.sequence,
    expiresAt: value.expiresAt,
  });
}

export async function encryptRemoteControlRelayEnvelope(
  input: EncryptRemoteControlRelayEnvelopeInput,
): Promise<RemoteControlRelayEnvelope> {
  requireAesGcmKey(input.key, 'encrypt');
  const metadata = normalizedMetadata(input.metadata);
  if (isRemoteControlRelayExpired(metadata, input.now ?? Date.now())) {
    return fail('ENVELOPE_EXPIRED', '이미 만료된 릴레이 메시지는 암호화할 수 없습니다.');
  }
  if (!(input.plaintext instanceof Uint8Array)
    || input.plaintext.byteLength > REMOTE_CONTROL_RELAY_MAX_PLAINTEXT_BYTES) {
    return fail('PLAINTEXT_TOO_LARGE', '릴레이 평문은 11,000바이트를 넘을 수 없습니다.');
  }
  const nonce = webCrypto().getRandomValues(new Uint8Array(REMOTE_CONTROL_RELAY_NONCE_BYTES));
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await webCrypto().subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: copyBuffer(nonce),
        additionalData: copyBuffer(canonicalRemoteControlRelayAad(metadata)),
        tagLength: AES_GCM_TAG_LENGTH,
      },
      input.key,
      copyBuffer(input.plaintext),
    );
  } catch {
    return fail('ENCRYPTION_FAILED');
  }
  return parseRemoteControlRelayEnvelope({
    ...metadata,
    nonce: encodeRemoteControlRelayBase64Url(nonce),
    ciphertext: encodeRemoteControlRelayBase64Url(new Uint8Array(ciphertext)),
  });
}

function enforceExpectedMetadata(
  envelope: RemoteControlRelayEnvelope,
  expected: DecryptRemoteControlRelayEnvelopeInput['expected'],
): void {
  if (!expected) return;
  for (const field of ['messageId', 'sessionId', 'controllerId', 'sequence'] as const) {
    if (expected[field] !== undefined && expected[field] !== envelope[field]) {
      fail('ENVELOPE_CONTEXT_MISMATCH', '예상한 릴레이 세션과 메시지 메타데이터가 다릅니다.');
    }
  }
}

export async function decryptRemoteControlRelayEnvelope(
  input: DecryptRemoteControlRelayEnvelopeInput,
): Promise<Uint8Array> {
  requireAesGcmKey(input.key, 'decrypt');
  const envelope = parseRemoteControlRelayEnvelope(input.envelope);
  if (isRemoteControlRelayExpired(envelope, input.now ?? Date.now())) {
    return fail('ENVELOPE_EXPIRED', '만료된 릴레이 메시지입니다.');
  }
  enforceExpectedMetadata(envelope, input.expected);
  try {
    const plaintext = await webCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: copyBuffer(decodeRemoteControlRelayBase64Url(envelope.nonce, 'nonce')),
        additionalData: copyBuffer(canonicalRemoteControlRelayAad(envelope)),
        tagLength: AES_GCM_TAG_LENGTH,
      },
      input.key,
      copyBuffer(decodeRemoteControlRelayBase64Url(envelope.ciphertext, 'ciphertext')),
    );
    return new Uint8Array(plaintext);
  } catch (error) {
    if (error instanceof RemoteControlRelayCryptoError) throw error;
    return fail('DECRYPTION_FAILED', '릴레이 암호문 인증에 실패했습니다.');
  }
}
