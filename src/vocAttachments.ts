/**
 * VOC 사진 첨부 — 휴대폰과 Mac이 공유하는 계약 (브라우저·Bun 양쪽에서 쓴다, node 내장 모듈 금지).
 *
 * 사진은 E2E 릴레이 봉투(평문 11,000바이트)에 들어가지 않는다. 그래서 휴대폰은 사진마다 새
 * AES-256-GCM 키로 **암호화한 바이트만** 비공개 Storage 버킷에 잠깐 올리고, 릴레이에는 작은
 * VOC 메시지(고칠 내용 + 첨부마다 경로·서명 토큰·키·sha256·mime·크기)만 보낸다. Storage에는
 * 암호문만 있고 키는 E2E 봉투 안에만 있으므로, 버킷이 읽혀도 사진은 보이지 않는다.
 *
 * 한 VOC는 한 세트다: 첨부를 전부 받아 검증한 뒤에만 Mac이 VOC를 저장한다(반쪽 VOC 금지).
 */

export const VOC_TRANSIT_BUCKET = 'portmgr-voc-transit';
export const VOC_MAX_ATTACHMENTS = 5;
/** 평문 이미지 한 장의 상한. 휴대폰은 올리기 전에 긴 변 2400px JPEG로 줄인다. */
export const VOC_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 암호문 = nonce(12) + 평문 + tag(16). 버킷의 file_size_limit(10MB)보다 작다. */
export const VOC_MAX_CIPHERTEXT_BYTES = VOC_MAX_IMAGE_BYTES + 28;
/** 릴레이 VOC 메시지의 고칠 내용 상한 — 한글 3바이트 기준으로도 평문 예산 안에 든다. */
export const VOC_REMOTE_COMMENT_MAX = 1_500;
/** 릴레이 평문(11,000B) 안에 terminal.request 포장까지 들어가도록 잡은 VOC 요청 상한. */
export const VOC_REMOTE_REQUEST_MAX_BYTES = 10_400;
/** 올린 사진이 Mac에 전달되지 못했을 때 Storage에 남아 있을 수 있는 최대 시간. */
export const VOC_TRANSIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Mac이 원격 VOC를 지원하는지 알리는 기능 이름. */
export const REMOTE_VOC_FEATURE = 'voc-v1';

export type VocImageMime = 'image/jpeg' | 'image/png' | 'image/webp';
export const VOC_IMAGE_MIMES: readonly VocImageMime[] = ['image/jpeg', 'image/png', 'image/webp'];

export function vocImageExtension(mime: VocImageMime): 'jpg' | 'png' | 'webp' {
  return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
}

/** 확장자나 선언된 mime이 아니라 **바이트**로 판정한다. 이미지가 아니면 null. */
export function detectVocImageMime(bytes: Uint8Array): VocImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes)));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

export interface EncryptedVocImage {
  /** nonce(12) ‖ AES-GCM 암호문+tag */
  ciphertext: Uint8Array;
  /** 32바이트 키, base64url(43자). E2E 릴레이 봉투 안에만 싣는다. */
  key: string;
  sha256: string;
  bytes: number;
}

/** 사진마다 새 키. 키를 재사용하지 않으므로 nonce 충돌이 다른 사진의 비밀을 깨지 않는다. */
export async function encryptVocImage(plain: Uint8Array): Promise<EncryptedVocImage> {
  if (plain.byteLength < 1 || plain.byteLength > VOC_MAX_IMAGE_BYTES) throw new Error('VOC_IMAGE_TOO_LARGE');
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(rawKey), 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(nonce) }, key, toArrayBuffer(plain)));
  const ciphertext = new Uint8Array(nonce.length + sealed.length);
  ciphertext.set(nonce, 0);
  ciphertext.set(sealed, nonce.length);
  return { ciphertext, key: base64UrlEncode(rawKey), sha256: await sha256Hex(plain), bytes: plain.byteLength };
}

export async function decryptVocImage(ciphertext: Uint8Array, keyText: string): Promise<Uint8Array> {
  if (ciphertext.byteLength < 12 + 16 + 1 || ciphertext.byteLength > VOC_MAX_CIPHERTEXT_BYTES) throw new Error('VOC_CIPHERTEXT_SIZE');
  const rawKey = base64UrlDecode(keyText);
  if (rawKey.byteLength !== 32) throw new Error('VOC_KEY_INVALID');
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(rawKey), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(ciphertext.subarray(0, 12)) }, key, toArrayBuffer(ciphertext.subarray(12)));
  return new Uint8Array(plain);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** `<hostId>/<uploader uid>/<objectId>.bin` — RLS가 두 번째 조각을 업로더 uid와 대조한다. */
export function vocTransitObjectPath(hostId: string, uploaderId: string, objectId: string): string {
  if (!HOST_ID_RE.test(hostId) || !UUID_RE.test(uploaderId) || !UUID_RE.test(objectId)) throw new Error('VOC_TRANSIT_PATH_INVALID');
  return `${hostId}/${uploaderId}/${objectId}.bin`;
}

export function isVocTransitObjectPath(value: unknown, hostId?: string): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  if (parts.length !== 3) return false;
  const [host, uploader, file] = parts as [string, string, string];
  if (!HOST_ID_RE.test(host) || !UUID_RE.test(uploader) || !file.endsWith('.bin') || !UUID_RE.test(file.slice(0, -4))) return false;
  return hostId === undefined || host === hostId;
}

export interface RemoteVocAttachment {
  /** Storage 객체 경로 */
  path: string;
  /** createSignedUrl이 준 token 값만. Mac은 **자기 설정의** Supabase 주소로 URL을 다시 만든다(SSRF 방지). */
  token: string;
  key: string;
  sha256: string;
  mime: VocImageMime;
  bytes: number;
}

export interface RemoteVocContext {
  /** 어느 화면에서 남겼는지 (예: 워크룸, 프로젝트, 오류 팝업) */
  screen?: string;
  project?: string;
  appVersion?: string;
  protocolVersion?: string;
  hostName?: string;
}

export interface RemoteVocError { code: string; message: string; detail?: string | null; surface?: string | null }

export interface RemoteVocSubmission {
  vocId: string;
  comment: string;
  source: 'phone' | 'phone-share' | 'phone-error';
  context: RemoteVocContext;
  error?: RemoteVocError;
  attachments: RemoteVocAttachment[];
}

function bounded(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('VOC_FIELD_INVALID');
  const text = value.trim();
  if (text.length > max) throw new Error('VOC_FIELD_TOO_LONG');
  return text || undefined;
}

function exactKeys(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('VOC_FIELD_UNKNOWN');
}

/** 휴대폰에서 온 원격 VOC 요청을 엄격하게 검증한다. 모르는 키·범위 밖 값은 전부 거절한다. */
export function normalizeRemoteVocSubmission(value: unknown): RemoteVocSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VOC_SUBMISSION_INVALID');
  const raw = value as Record<string, unknown>;
  exactKeys(raw, ['vocId', 'comment', 'source', 'context', 'error', 'attachments']);
  if (typeof raw.vocId !== 'string' || !UUID_RE.test(raw.vocId)) throw new Error('VOC_ID_INVALID');
  const comment = bounded(raw.comment, VOC_REMOTE_COMMENT_MAX);
  if (!comment) throw new Error('VOC_COMMENT_REQUIRED');
  if (raw.source !== 'phone' && raw.source !== 'phone-share' && raw.source !== 'phone-error') throw new Error('VOC_SOURCE_INVALID');
  const ctxRaw = raw.context;
  if (!ctxRaw || typeof ctxRaw !== 'object' || Array.isArray(ctxRaw)) throw new Error('VOC_CONTEXT_INVALID');
  exactKeys(ctxRaw, ['screen', 'project', 'appVersion', 'protocolVersion', 'hostName']);
  const c = ctxRaw as Record<string, unknown>;
  const context: RemoteVocContext = {};
  for (const key of ['screen', 'project', 'appVersion', 'protocolVersion', 'hostName'] as const) {
    const text = bounded(c[key], 120);
    if (text) context[key] = text;
  }
  let error: RemoteVocError | undefined;
  if (raw.error !== undefined) {
    if (!raw.error || typeof raw.error !== 'object' || Array.isArray(raw.error)) throw new Error('VOC_ERROR_INVALID');
    exactKeys(raw.error, ['code', 'message', 'detail', 'surface']);
    const e = raw.error as Record<string, unknown>;
    const code = bounded(e.code, 120);
    const message = bounded(e.message, 600);
    if (!code || !message) throw new Error('VOC_ERROR_INVALID');
    error = { code, message, detail: bounded(e.detail, 400) ?? null, surface: bounded(e.surface, 60) ?? null };
  }
  if (!Array.isArray(raw.attachments) || raw.attachments.length > VOC_MAX_ATTACHMENTS) throw new Error('VOC_ATTACHMENTS_INVALID');
  const paths = new Set<string>();
  const attachments = raw.attachments.map((item): RemoteVocAttachment => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('VOC_ATTACHMENT_INVALID');
    exactKeys(item, ['path', 'token', 'key', 'sha256', 'mime', 'bytes']);
    const a = item as Record<string, unknown>;
    if (!isVocTransitObjectPath(a.path) || paths.has(a.path)) throw new Error('VOC_ATTACHMENT_PATH_INVALID');
    paths.add(a.path);
    if (typeof a.token !== 'string' || !/^[A-Za-z0-9_.-]{20,1200}$/.test(a.token)) throw new Error('VOC_ATTACHMENT_TOKEN_INVALID');
    if (typeof a.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(a.key)) throw new Error('VOC_ATTACHMENT_KEY_INVALID');
    if (typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256)) throw new Error('VOC_ATTACHMENT_HASH_INVALID');
    if (!VOC_IMAGE_MIMES.includes(a.mime as VocImageMime)) throw new Error('VOC_ATTACHMENT_MIME_INVALID');
    if (!Number.isSafeInteger(a.bytes) || (a.bytes as number) < 1 || (a.bytes as number) > VOC_MAX_IMAGE_BYTES) throw new Error('VOC_ATTACHMENT_SIZE_INVALID');
    return { path: a.path, token: a.token, key: a.key, sha256: a.sha256, mime: a.mime as VocImageMime, bytes: a.bytes as number };
  });
  const submission: RemoteVocSubmission = { vocId: raw.vocId, comment, source: raw.source, context, attachments, ...(error ? { error } : {}) };
  if (new TextEncoder().encode(JSON.stringify(submission)).byteLength > VOC_REMOTE_REQUEST_MAX_BYTES) throw new Error('VOC_SUBMISSION_TOO_LARGE');
  return submission;
}

/** Mac이 휴대폰에 돌려주는 결과. 경로는 E2E 봉투로 같은 소유자에게만 간다. */
export interface RemoteVocReceipt {
  vocId: string;
  file: string;
  attachmentPaths: string[];
  /** Mac이 Storage 객체를 직접 지웠는가. false면 휴대폰이 곧바로 지운다. */
  transitDeleted: boolean;
}

export function normalizeRemoteVocReceipt(value: unknown): RemoteVocReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VOC 응답 형식 오류');
  const r = value as Record<string, unknown>;
  exactKeys(r, ['vocId', 'file', 'attachmentPaths', 'transitDeleted']);
  if (typeof r.vocId !== 'string' || !UUID_RE.test(r.vocId) || typeof r.file !== 'string' || !/^[^/\\]{1,200}\.json$/.test(r.file)
    || !Array.isArray(r.attachmentPaths) || r.attachmentPaths.length > VOC_MAX_ATTACHMENTS
    || r.attachmentPaths.some(p => typeof p !== 'string' || p.length > 600) || typeof r.transitDeleted !== 'boolean') {
    throw new Error('VOC 응답 형식 오류');
  }
  return { vocId: r.vocId, file: r.file, attachmentPaths: r.attachmentPaths as string[], transitDeleted: r.transitDeleted };
}

/** 사용자가 읽는 한국어 사유. 코드 문자열을 그대로 보여 주지 않는다. */
export function describeVocFailure(code: string): string {
  if (code.includes('BUCKET') || /bucket not found/i.test(code)) return '사진 전송용 저장소가 아직 준비되지 않았습니다. Mac 관리자에게 Supabase 설정(VOC 사진 저장소 마이그레이션)을 요청하거나 사진 없이 보내 주세요.';
  if (code.includes('TOO_LARGE') || code.includes('SIZE')) return '사진이 너무 큽니다. 사진 수를 줄이거나 다른 사진을 골라 주세요.';
  if (code.includes('HASH') || code.includes('DECRYPT') || code.includes('MIME')) return '사진이 전송 중 손상되어 VOC를 저장하지 않았습니다. 다시 보내 주세요.';
  if (code.includes('DOWNLOAD')) return 'Mac이 사진을 받지 못해 VOC를 저장하지 않았습니다. 잠시 뒤 다시 보내 주세요.';
  if (code.includes('COMMENT')) return '고칠 내용을 입력해 주세요.';
  return 'VOC를 보내지 못했습니다.';
}
