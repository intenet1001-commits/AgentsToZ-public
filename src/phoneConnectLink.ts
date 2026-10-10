import {isPublicSupabaseClientKey} from './onboardingHandoff';

/**
 * 「폰 연결 링크」 — step ① of phone onboarding: tell the iPhone app WHICH Supabase project to use,
 * so it can sign in (email code) and show the synced data without standing in front of the Mac.
 *
 * It carries only public, non-secret values: the portal origin the Mac's QRs are issued for, the
 * Supabase project URL, its PUBLIC anon/publishable key and a display label for the Mac. It never
 * carries a pairing secret, host key or session — a link can NEVER grant control of a Mac. Control
 * (step ②) stays the QR + 6-digit SAS approval on the Mac.
 *
 *   agentstoz://connect#<base64url(JSON {v, portal, supabaseUrl, anonKey, hostName})>
 *
 * The iPhone parses the same format in `AgentsToZCore/PhoneConnectLink.swift`; both implementations
 * read `tests/fixtures/phone-connect-link-golden.json`. Change the format there first.
 */
export const PHONE_CONNECT_LINK_VERSION = 1;
export const PHONE_CONNECT_LINK_PREFIX = 'agentstoz://connect#';
const PAYLOAD_KEYS = ['anonKey', 'hostName', 'portal', 'supabaseUrl', 'v'];
const MAX_PAYLOAD_CHARS = 4096;
const MAX_HOST_NAME_BYTES = 128;
const HOST_NAME_CHARS = 40;

export interface PhoneConnectLink {
  portalOrigin: string;
  supabaseUrl: string;
  anonKey: string;
  hostName: string;
}

export class PhoneConnectLinkError extends Error {
  constructor(message: string) { super(message); this.name = 'PhoneConnectLinkError'; }
}
const fail = (message: string): never => { throw new PhoneConnectLinkError(message); };

/** `https://<lowercase host>` exactly: no port, path, query, fragment or credentials. */
export function isPhoneConnectHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256) return false;
  const match = /^https:\/\/([a-z0-9.-]+)$/.exec(value);
  if (!match) return false;
  try { return new URL(value).origin === value; } catch { return false; }
}

function isAllowedKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 1024 && value === value.trim()
    && isPublicSupabaseClientKey(value);
}

// C0/C1 controls and bidi overrides/isolates: a label is shown in a confirmation, so it must not be
// able to reorder or hide the Supabase host printed next to it.
const UNSAFE_LABEL_CHAR = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/u;
const utf8Length = (value: string) => new TextEncoder().encode(value).length;

function isAllowedHostName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && utf8Length(value) <= MAX_HOST_NAME_BYTES && !UNSAFE_LABEL_CHAR.test(value);
}

/** A label the Mac may put in the link: unsafe characters dropped, trimmed, shortened, never empty. */
export function phoneConnectHostLabel(raw: unknown): string {
  const cleaned = typeof raw === 'string' ? raw.replace(new RegExp(UNSAFE_LABEL_CHAR.source, 'gu'), '').trim() : '';
  let label = Array.from(cleaned).slice(0, HOST_NAME_CHARS).join('').trim();
  while (label && utf8Length(label) > MAX_HOST_NAME_BYTES) label = Array.from(label).slice(0, -1).join('').trim();
  return label || 'Mac';
}

const toBase64Url = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
};

function fromBase64Url(value: string): Uint8Array | null {
  if (!value || value.length > MAX_PAYLOAD_CHARS || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch { return null; }
}

/**
 * Builds the link on the Mac. Refuses anything that is not a public key (a service_role JWT or an
 * `sb_secret_` key throws) — the same guard as `pairingSupabaseConfig`, re-applied here so a caller
 * that forgets it still cannot put a secret in a message the user will paste into a chat.
 */
/** Only buildPhoneConnectLink makes this type, so a component that copies it cannot be handed
 *  the QR's pairing URL (which carries the one-time secret) by mistake. */
export type PhoneConnectLinkText = string & {readonly __phoneConnectLink: true};

export function buildPhoneConnectLink(input: {portalOrigin: string; supabaseUrl: string; anonKey: string; hostName?: unknown}, serviceRoleKey?: string | null): PhoneConnectLinkText {
  if (!isPhoneConnectHttpsOrigin(input.portalOrigin)) fail('포털 주소는 경로 없는 HTTPS 주소여야 합니다.');
  if (!isPhoneConnectHttpsOrigin(input.supabaseUrl)) fail('Supabase 주소는 경로 없는 HTTPS 주소여야 합니다.');
  if (!isAllowedKey(input.anonKey) || (serviceRoleKey && input.anonKey === serviceRoleKey.trim())) {
    fail('공개(anon/publishable) 키만 링크에 넣을 수 있습니다. service_role 키는 넣지 않습니다.');
  }
  const payload = {v: PHONE_CONNECT_LINK_VERSION, portal: input.portalOrigin, supabaseUrl: input.supabaseUrl, anonKey: input.anonKey, hostName: phoneConnectHostLabel(input.hostName)};
  return (PHONE_CONNECT_LINK_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))) as PhoneConnectLinkText;
}

/** The first `agentstoz://connect#…` in pasted text (a chat message may wrap it in other words). */
export function extractPhoneConnectLink(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > 16384) return null;
  const at = text.indexOf(PHONE_CONNECT_LINK_PREFIX);
  if (at < 0) return null;
  const rest = text.slice(at + PHONE_CONNECT_LINK_PREFIX.length);
  const payload = /^[A-Za-z0-9_-]*/.exec(rest)![0];
  return PHONE_CONNECT_LINK_PREFIX + payload;
}

/** Strict parse of one exact link. Pasted text goes through `extractPhoneConnectLink` first. */
export function parsePhoneConnectLink(link: unknown): PhoneConnectLink {
  if (typeof link !== 'string' || !link.startsWith(PHONE_CONNECT_LINK_PREFIX)) fail('AgentsToZ 폰 연결 링크가 아닙니다.');
  const bytes = fromBase64Url((link as string).slice(PHONE_CONNECT_LINK_PREFIX.length));
  if (!bytes) fail('연결 링크가 잘렸거나 손상되었습니다.');
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes!)); } catch { fail('연결 링크를 읽지 못했습니다.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('연결 링크를 읽지 못했습니다.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== PAYLOAD_KEYS.join(',')) fail('연결 링크 형식이 올바르지 않습니다.');
  if (value.v !== PHONE_CONNECT_LINK_VERSION) fail('지원하지 않는 연결 링크 버전입니다. 앱을 업데이트하세요.');
  if (!isPhoneConnectHttpsOrigin(value.portal)) fail('연결 링크의 포털 주소가 올바르지 않습니다.');
  if (!isPhoneConnectHttpsOrigin(value.supabaseUrl)) fail('연결 링크의 Supabase 주소가 올바르지 않습니다.');
  if (!isAllowedKey(value.anonKey)) fail('연결 링크의 키가 공개(anon/publishable) 키가 아닙니다.');
  if (!isAllowedHostName(value.hostName)) fail('연결 링크의 Mac 이름이 올바르지 않습니다.');
  return {portalOrigin: value.portal as string, supabaseUrl: value.supabaseUrl as string, anonKey: value.anonKey as string, hostName: value.hostName as string};
}

/**
 * Inside the app's bundled portal, which is pinned to one Supabase project (from a link or a QR):
 * a QR for ANOTHER project cannot be used from this page — it would pair against the wrong project.
 * The QR wins, but only the app's own scanner can switch projects, so say how. Null when it matches
 * or the QR (older Mac) names no project.
 */
export function bundledQrSupabaseMismatch(qrSupabaseUrl: string | null | undefined, currentSupabaseUrl: string): string | null {
  if (!qrSupabaseUrl || qrSupabaseUrl === currentSupabaseUrl) return null;
  const host = (value: string) => value.replace(/^https:\/\//u, '');
  return `이 QR은 다른 Supabase 프로젝트(${host(qrSupabaseUrl)})용입니다. 지금 연결은 ${host(currentSupabaseUrl)}입니다. `
    + 'QR의 설정으로 바꾸려면 이 화면을 닫고 앱 첫 화면의 「기기 연결 · QR 스캔」으로 다시 찍으세요.';
}
