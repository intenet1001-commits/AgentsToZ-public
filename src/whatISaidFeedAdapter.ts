import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import contract from '../context-api-contract.json';

const feedContract = contract.whatISaidFeedAuth;
const ACCESS_KEY = /^[0-9a-f]{64}$/;
const CHALLENGE = /^[0-9a-f]{64}$/;
const RESPONSE_PROOF = /^v1:([0-9a-f]{64}):([0-9a-f]{64})$/;

function validRequestTarget(value: string): boolean {
  return value === '/api/what-i-said/feed'
    || value.startsWith('/api/what-i-said/feed?');
}

function derivedKey(accessKey: string): Buffer {
  return createHash('sha256').update(accessKey, 'utf8').digest();
}

function requestSignature(
  accessKey: string,
  challenge: string,
  requestTarget: string,
): string {
  const key = derivedKey(accessKey);
  try {
    return createHmac('sha256', key)
      .update(feedContract.requestProofDomain, 'utf8')
      // The challenge remains lowercase-hex text. It is not decoded to 32 bytes.
      .update(challenge, 'utf8')
      .update('\0GET\0', 'utf8')
      .update(requestTarget, 'utf8')
      .digest('hex');
  } finally {
    key.fill(0);
  }
}

function responseSignature(
  accessKey: string,
  challenge: string,
  requestTarget: string,
  responseBody: Uint8Array,
): string {
  const key = derivedKey(accessKey);
  const bodyHash = createHash('sha256').update(responseBody).digest('hex');
  try {
    return createHmac('sha256', key)
      .update(feedContract.responseProofDomain, 'utf8')
      .update(challenge, 'utf8')
      .update('\0GET\0', 'utf8')
      .update(requestTarget, 'utf8')
      .update('\0', 'utf8')
      // The body digest is lowercase-hex UTF-8 text, not decoded digest bytes.
      .update(bodyHash, 'utf8')
      .digest('hex');
  } finally {
    key.fill(0);
  }
}

/**
 * Creates the only credential value a compatible external-app adapter sends
 * to the feed.
 * The one-time access key stays inside the adapter; never place it in a URL,
 * Bearer header, request body, log, or browser-facing state.
 */
export function createWhatISaidAdapterAuthorization(input: {
  accessKey: string;
  challenge: string;
  requestTarget: string;
}): string {
  if (!ACCESS_KEY.test(input.accessKey)
    || !CHALLENGE.test(input.challenge)
    || !validRequestTarget(input.requestTarget)) {
    throw new Error('WHAT_I_SAID_FEED_AUTH_INPUT_INVALID');
  }
  const signature = requestSignature(input.accessKey, input.challenge, input.requestTarget);
  return `${feedContract.scheme} v${feedContract.version}:${input.challenge}:${signature}`;
}

/**
 * Verifies the proof over the exact response bytes before JSON parsing. Passing
 * a parsed-and-reserialized body is intentionally unsupported because even an
 * equivalent JSON value can have different authenticated bytes.
 */
export function verifyWhatISaidAdapterResponse(input: {
  accessKey: string;
  challenge: string;
  requestTarget: string;
  responseBody: Uint8Array;
  responseProof: string | null | undefined;
}): boolean {
  if (!ACCESS_KEY.test(input.accessKey)
    || !CHALLENGE.test(input.challenge)
    || !validRequestTarget(input.requestTarget)) return false;
  const received = typeof input.responseProof === 'string'
    ? RESPONSE_PROOF.exec(input.responseProof)
    : null;
  if (!received || received[1] !== input.challenge) return false;
  const expected = Buffer.from(responseSignature(
    input.accessKey,
    input.challenge,
    input.requestTarget,
    input.responseBody,
  ), 'hex');
  const actual = Buffer.from(received[2]!, 'hex');
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}
