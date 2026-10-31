/**
 * Relay wire protocol v1 — strict schema only.
 *
 * This file knows nothing about the encrypted screen protocol it carries. Every binary message is
 * one opaque native frame whose bytes this server must preserve exactly (contract §12).
 *
 * Contract: /tmp/agentstoz-screen-relay-contract-20261026.md
 */

export const RELAY_PATH = "/screen-relay";
export const PROTOCOL_VERSION = 1;
/** Version 2 adds a host-admission acknowledgement. Version 1 peers keep their exact original response sequence. */
export const LATEST_PROTOCOL_VERSION = 2;

export type Purpose = "screen" | "registration";
export type Role = "host" | "controller";

/** The only error codes the wire defines (contract §14). */
export type ErrorCode =
  | "malformed"
  | "unauthorized"
  | "offline"
  | "busy"
  | "limited"
  | "expired";

export const PURPOSES: readonly Purpose[] = ["screen", "registration"];

/** 32 random bytes, base64url, no padding. */
export const NONCE_BYTES = 32;
export const NONCE_LENGTH = 43;
/** 16 random bytes, base64url, no padding. */
export const PEER_ID_BYTES = 16;
/** SHA-256 of the Mac's x963 P-256 signing public key, lowercase hex. */
export const ROOM_FINGERPRINT_LENGTH = 64;
/** 32 random bytes of routing capability, base64url, no padding. */
export const ROOM_CAPABILITY_LENGTH = 43;
/** Uncompressed x963 P-256 point. */
export const PUBLIC_KEY_BYTES = 65;
/** Raw r‖s ECDSA signature, as CryptoKit's `rawRepresentation` produces. */
export const SIGNATURE_BYTES = 64;
/** 65 and 64 bytes both encode to 88 standard-base64 characters. */
const STANDARD_B64_88 = 88;

export const HOST_SIGNATURE_LABEL = "agentstoz.screen-relay/v1 host";

/**
 * What the host signs: label, purpose, room and this socket's challenge nonce, newline separated.
 * The nonce is the base64url text exactly as it was sent, so both ends sign the same bytes without
 * re-encoding. Binding the room and purpose stops a signature for one room being replayed into another.
 */
export function hostSignatureMessage(purpose: Purpose, room: string, nonce: string, version = PROTOCOL_VERSION): Uint8Array {
  return new TextEncoder().encode(`agentstoz.screen-relay/v${version} host\n${purpose}\n${room}\n${nonce}`);
}

const ROOM_PATTERN = new RegExp(
  `^[0-9a-f]{${ROOM_FINGERPRINT_LENGTH}}\\.[A-Za-z0-9_-]{${ROOM_CAPABILITY_LENGTH}}$`,
);
const STANDARD_B64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export interface ParsedRoom {
  /** Lowercase hex SHA-256 of the host public key. */
  readonly fingerprint: string;
  /**
   * Private routing capability. Never put this in a URL, a log line or an error body
   * (contract §7) — `roomLabel` exists so diagnostics can name a room without it.
   */
  readonly capability: string;
}

export function parseRoom(value: unknown): ParsedRoom | null {
  if (typeof value !== "string" || !ROOM_PATTERN.test(value)) return null;
  const dot = value.indexOf(".");
  return { fingerprint: value.slice(0, dot), capability: value.slice(dot + 1) };
}

/**
 * A room name safe to count or report: the fingerprint's first bytes only. The capability never
 * appears, so no log or error can leak transport admission.
 */
export function roomLabel(room: ParsedRoom): string {
  return `${room.fingerprint.slice(0, 12)}…`;
}

/** Random bytes as base64url with no padding. */
export function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

export function base64urlEncode(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Strict standard-base64 of an exact byte length. Length, charset and decoded size are all checked,
 * so a field cannot be padded, truncated or re-encoded into something else.
 */
export function decodeStandardBase64(value: unknown, expectedBytes: number): Uint8Array | null {
  if (typeof value !== "string" || value.length !== STANDARD_B64_88) return null;
  if (!STANDARD_B64_PATTERN.test(value)) return null;
  let raw: string;
  try {
    raw = atob(value);
  } catch {
    return null;
  }
  if (raw.length !== expectedBytes) return null;
  const bytes = new Uint8Array(expectedBytes);
  for (let i = 0; i < expectedBytes; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export interface HostJoin {
  readonly version: number;
  readonly role: "host";
  readonly purpose: Purpose;
  readonly room: ParsedRoom;
  readonly rawRoom: string;
  readonly publicKey: Uint8Array;
  readonly signature: Uint8Array;
}

export interface ControllerJoin {
  readonly version: number;
  readonly role: "controller";
  readonly purpose: Purpose;
  readonly room: ParsedRoom;
  readonly rawRoom: string;
}

export type Join = HostJoin | ControllerJoin;

const HOST_KEYS = ["type", "version", "role", "purpose", "room", "publicKey", "signature"] as const;
const CONTROLLER_KEYS = ["type", "version", "role", "purpose", "room"] as const;

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.length) return false;
  return expected.every((key) => Object.hasOwn(value, key));
}

/**
 * The join frame, or the code to answer with. Exact key sets: an extra or missing field is
 * malformed, so no field can be smuggled past this schema (contract §8-§10).
 */
export function parseJoin(text: string): { ok: true; join: Join } | { ok: false; code: ErrorCode } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: "malformed" };
  }
  const body = parsed as Record<string, unknown>;
  if (body.type !== "join" || (body.version !== PROTOCOL_VERSION && body.version !== LATEST_PROTOCOL_VERSION)) return { ok: false, code: "malformed" };
  const version = body.version;
  if (!PURPOSES.includes(body.purpose as Purpose)) return { ok: false, code: "malformed" };
  const purpose = body.purpose as Purpose;
  const room = parseRoom(body.room);
  if (!room) return { ok: false, code: "malformed" };
  const rawRoom = body.room as string;

  if (body.role === "host") {
    if (!hasExactKeys(body, HOST_KEYS)) return { ok: false, code: "malformed" };
    const publicKey = decodeStandardBase64(body.publicKey, PUBLIC_KEY_BYTES);
    const signature = decodeStandardBase64(body.signature, SIGNATURE_BYTES);
    if (!publicKey || !signature) return { ok: false, code: "malformed" };
    // Uncompressed points only; a compressed or infinity point is not this protocol's key.
    if (publicKey[0] !== 0x04) return { ok: false, code: "malformed" };
    return { ok: true, join: { version, role: "host", purpose, room, rawRoom, publicKey, signature } };
  }
  if (body.role === "controller") {
    if (!hasExactKeys(body, CONTROLLER_KEYS)) return { ok: false, code: "malformed" };
    return { ok: true, join: { version, role: "controller", purpose, room, rawRoom } };
  }
  return { ok: false, code: "malformed" };
}

/** `{"type":"authenticated"}` and nothing else: the host's budget signal (contract §13). */
export function isAuthenticatedFrame(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const body = parsed as Record<string, unknown>;
  return body.type === "authenticated" && Object.keys(body).length === 1;
}

export function challengeFrame(nonce: string): string {
  return JSON.stringify({ type: "challenge", nonce });
}

export function pairedFrame(peerId: string): string {
  return JSON.stringify({ type: "paired", peerId });
}

export function errorFrame(code: ErrorCode): string {
  return JSON.stringify({ type: "error", code });
}
