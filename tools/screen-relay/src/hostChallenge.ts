/**
 * Host challenge verification.
 *
 * The room's prefix is SHA-256 of the host's x963 public key, so a controller who scanned the room
 * cannot squat as host: it would have to produce a key hashing to that prefix and a signature over
 * this socket's fresh nonce (contract §9).
 *
 * WebCrypto verifies ECDSA P-256 over SHA-256 with a raw r‖s signature, which is exactly what
 * CryptoKit's `ECDSASignature.rawRepresentation` produces. No DER conversion is involved.
 */

import { hostSignatureMessage, type HostJoin, type ParsedRoom } from "./protocol.ts";

const HEX = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 15];
  return out;
}

/** Lowercase hex SHA-256, as the room prefix encodes it. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

/**
 * Constant-time string comparison for the fingerprint check. Both values are public (a hash and a
 * room name the peer supplied), so this is defence in depth rather than a secret comparison.
 */
function equalText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether this host join really comes from the Mac the room names.
 *
 * Both conditions must hold:
 *  1. SHA-256(publicKey) equals the room fingerprint — the key is the room's own Mac;
 *  2. the signature over (label ‖ purpose ‖ room ‖ nonce) verifies under that key — the holder is
 *     live now and is answering this socket's one-use challenge.
 *
 * Any WebCrypto rejection (a point off the curve, a malformed key) is a failed verification, never
 * an exception that could skip the check.
 */
export async function verifyHostJoin(join: HostJoin, nonce: string): Promise<boolean> {
  const fingerprint = await sha256Hex(join.publicKey);
  if (!equalText(fingerprint, join.room.fingerprint)) return false;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      join.publicKey as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return false;
  }

  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      join.signature as BufferSource,
      hostSignatureMessage(join.purpose, join.rawRoom, nonce, join.version) as BufferSource,
    );
  } catch {
    return false;
  }
}

/** The key identifying a room's pair: a room name is per-purpose (contract §11). */
export function pairKey(room: ParsedRoom, purpose: string): string {
  return `${room.fingerprint}.${room.capability}\u0000${purpose}`;
}
