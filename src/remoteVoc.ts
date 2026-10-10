import type { SupabaseClient } from '@supabase/supabase-js';
import type { MobileWorkspaceRequest, MobileWorkspaceResult } from './mobileWorkspaceProtocol';
import {
  encryptVocImage,
  normalizeRemoteVocSubmission,
  REMOTE_VOC_FEATURE,
  VOC_MAX_ATTACHMENTS,
  VOC_MAX_IMAGE_BYTES,
  VOC_TRANSIT_BUCKET,
  VOC_TRANSIT_MAX_AGE_MS,
  vocTransitObjectPath,
  detectVocImageMime,
  type RemoteVocAttachment,
  type RemoteVocContext,
  type RemoteVocError,
  type RemoteVocReceipt,
  type RemoteVocSubmission,
  type VocImageMime,
} from './vocAttachments';

/**
 * 휴대폰에서 VOC 한 세트(고칠 내용 + 사진 최대 5장)를 Mac으로 보낸다.
 *
 * 순서가 곧 원자성이다: ① 사진을 전부 암호화해 비공개 경유 버킷에 올린다 → ② 그다음에만 E2E
 * 릴레이로 VOC 메시지 하나(키·해시 포함)를 보낸다 → ③ Mac이 전부 받아 검증해야 저장한다.
 * 어느 단계든 실패하면 올린 객체를 지우고 실패를 그대로 알린다 — 반쪽 VOC는 없다.
 */

export interface VocDraftImage {
  id: string;
  /** 미리보기용 object URL 또는 data URL */
  previewUrl: string;
  bytes: Uint8Array;
  mime: VocImageMime;
}

export interface RemoteVocSendInput {
  supabase: SupabaseClient;
  hostId: string;
  targetId: string;
  comment: string;
  source: RemoteVocSubmission['source'];
  context: RemoteVocContext;
  error?: RemoteVocError;
  images: readonly VocDraftImage[];
  send: (request: MobileWorkspaceRequest) => Promise<MobileWorkspaceResult>;
  onProgress?: (label: string) => void;
  randomUuid?: () => string;
}

/** Same string as the relay controller's REMOTE_CONTROL_REQUEST_UNSENT (kept literal: this module stays light). */
export const VOC_HELD_ON_PHONE = 'REMOTE_CONTROL_REQUEST_UNSENT';
export const VOC_HELD_ON_PHONE_MESSAGE = '휴대폰 네트워크가 끊겨 VOC를 아직 Mac에 보내지 못했을 수 있습니다. 이 화면이 다시 연결되면 같은 VOC를 한 번만 보냅니다 — 다시 보내지 마세요. 처음 보낸 지 약 10분이 지나면 보내지 않으니, 그때는 「쌓인 VOC」에서 들어갔는지 확인하세요.';

export class RemoteVocSendError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const MAX_EDGE = 2400;

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 사진을 보낼 수 있는 모양으로 만든다: 긴 변 2400px 이하 JPEG(0.85). 메타데이터(위치 등)는
 * 다시 그리면서 사라진다. 이미 작은 JPEG는 그대로 둔다.
 */
export async function prepareVocImage(source: Blob): Promise<{ bytes: Uint8Array; mime: VocImageMime }> {
  const original = await blobToBytes(source);
  const detected = detectVocImageMime(original);
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    if (detected && original.byteLength <= VOC_MAX_IMAGE_BYTES) return { bytes: original, mime: detected };
    throw new RemoteVocSendError('VOC_IMAGE_UNREADABLE', '이 사진을 읽지 못했습니다. 다른 사진을 골라 주세요.');
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (detected === 'image/jpeg' && scale === 1 && original.byteLength <= 3 * 1024 * 1024) {
    bitmap.close();
    return { bytes: original, mime: 'image/jpeg' };
  }
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) { bitmap.close(); throw new RemoteVocSendError('VOC_IMAGE_UNREADABLE', '이 기기에서 사진을 줄이지 못했습니다.'); }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new RemoteVocSendError('VOC_IMAGE_UNREADABLE', '사진을 변환하지 못했습니다.');
  const bytes = await blobToBytes(blob);
  if (bytes.byteLength > VOC_MAX_IMAGE_BYTES) throw new RemoteVocSendError('VOC_IMAGE_TOO_LARGE', '사진이 너무 큽니다.');
  return { bytes, mime: 'image/jpeg' };
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data.replace(/^data:[^,]*,/, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function hostSupportsRemoteVoc(features: readonly string[] | null | undefined): boolean {
  return !!features?.includes(REMOTE_VOC_FEATURE);
}

function friendlyStorageError(error: unknown): RemoteVocSendError {
  const message = error && typeof error === 'object' && 'message' in error ? String((error as { message?: unknown }).message ?? '') : String(error ?? '');
  if (/bucket not found|not found/i.test(message)) {
    return new RemoteVocSendError('VOC_TRANSIT_BUCKET_MISSING', '사진 전송용 저장소가 아직 준비되지 않았습니다. Supabase에 VOC 사진 저장소 마이그레이션을 적용해야 합니다. 사진을 빼면 지금 보낼 수 있습니다.');
  }
  if (/row-level security|unauthorized|jwt|403|401/i.test(message)) {
    return new RemoteVocSendError('VOC_TRANSIT_FORBIDDEN', '사진을 올릴 권한이 없습니다. 포털에 다시 로그인한 뒤 보내 주세요.');
  }
  if (/payload too large|exceeded|413/i.test(message)) {
    return new RemoteVocSendError('VOC_IMAGE_TOO_LARGE', '사진이 너무 큽니다. 사진 수를 줄여 주세요.');
  }
  return new RemoteVocSendError('VOC_UPLOAD_FAILED', '사진을 올리지 못했습니다. 인터넷 연결을 확인한 뒤 다시 보내 주세요.');
}

async function removeQuietly(supabase: SupabaseClient, paths: string[]): Promise<void> {
  if (!paths.length) return;
  try { await supabase.storage.from(VOC_TRANSIT_BUCKET).remove(paths); } catch { /* Mac의 24시간 정리가 남은 것을 지운다 */ }
}

export async function sendRemoteVoc(input: RemoteVocSendInput): Promise<RemoteVocReceipt> {
  const randomUuid = input.randomUuid ?? (() => crypto.randomUUID());
  if (input.images.length > VOC_MAX_ATTACHMENTS) throw new RemoteVocSendError('VOC_TOO_MANY_ATTACHMENTS', `사진은 ${VOC_MAX_ATTACHMENTS}장까지 보낼 수 있습니다.`);
  const uploaded: string[] = [];
  const attachments: RemoteVocAttachment[] = [];
  try {
    if (input.images.length) {
      const { data } = await input.supabase.auth.getSession();
      const uid = data.session?.user?.id;
      if (!uid) throw new RemoteVocSendError('VOC_LOGIN_REQUIRED', '사진을 보내려면 포털 로그인이 필요합니다. 다시 로그인해 주세요.');
      void sweepOwnVocTransit(input.supabase, input.hostId, uid);
      const bucket = input.supabase.storage.from(VOC_TRANSIT_BUCKET);
      for (const [index, image] of input.images.entries()) {
        input.onProgress?.(`사진 암호화·업로드 ${index + 1}/${input.images.length}`);
        const sealed = await encryptVocImage(image.bytes);
        const path = vocTransitObjectPath(input.hostId, uid, randomUuid());
        const upload = await bucket.upload(path, new Blob([sealed.ciphertext as BlobPart], { type: 'application/octet-stream' }), {
          contentType: 'application/octet-stream', upsert: false, cacheControl: '0',
        });
        if (upload.error) throw friendlyStorageError(upload.error);
        uploaded.push(path);
        // 서명 URL은 Mac이 한 번 내려받을 동안만 유효하면 된다. Mac에는 token만 넘긴다.
        const signed = await bucket.createSignedUrl(path, 15 * 60);
        const token = signed.data?.signedUrl ? new URL(signed.data.signedUrl, 'https://placeholder.invalid').searchParams.get('token') : null;
        if (signed.error || !token) throw friendlyStorageError(signed.error ?? 'sign failed');
        attachments.push({ path, token, key: sealed.key, sha256: sealed.sha256, mime: image.mime, bytes: sealed.bytes });
      }
    }
    let submission: RemoteVocSubmission;
    try {
      submission = normalizeRemoteVocSubmission({
        vocId: randomUuid(),
        comment: input.comment,
        source: input.source,
        context: input.context,
        ...(input.error ? { error: input.error } : {}),
        attachments,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'VOC_SUBMISSION_INVALID';
      throw new RemoteVocSendError(code, code === 'VOC_COMMENT_REQUIRED' ? '고칠 내용을 입력해 주세요.'
        : code === 'VOC_FIELD_TOO_LONG' ? '고칠 내용이 너무 깁니다. 1,500자 이하로 줄여 주세요.'
        : code === 'VOC_SUBMISSION_TOO_LARGE' ? '내용이 너무 길어 한 번에 보낼 수 없습니다. 고칠 내용을 줄여 주세요.'
        : 'VOC 내용을 확인해 주세요.');
    }
    input.onProgress?.(input.images.length ? 'Mac이 사진을 받아 확인하는 중…' : 'Mac으로 보내는 중…');
    const result = await input.send({
      operation: 'workspace',
      requestId: randomUuid(),
      targetId: input.targetId,
      workspace: { action: 'voc.submit', voc: submission },
    });
    if (result.action !== 'voc.submit' || !result.voc) throw new RemoteVocSendError('VOC_RESULT_INVALID', 'Mac의 응답을 확인하지 못했습니다.');
    if (!result.voc.transitDeleted) await removeQuietly(input.supabase, uploaded);
    return result.voc;
  } catch (error) {
    // Held on the phone (the relay controller's REMOTE_CONTROL_REQUEST_UNSENT): that exact voc.submit goes out once
    // when the screen reconnects and still needs its photos. Deleting them made the Mac refuse it; a fresh send made a
    // second VOC. Keep both the photos (the hourly/24-hour transit sweeps clean leftovers) and the code.
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === VOC_HELD_ON_PHONE) {
      throw new RemoteVocSendError(VOC_HELD_ON_PHONE, VOC_HELD_ON_PHONE_MESSAGE);
    }
    await removeQuietly(input.supabase, uploaded);
    if (error instanceof RemoteVocSendError) throw error;
    throw new RemoteVocSendError('VOC_SEND_FAILED', error instanceof Error ? error.message : 'VOC를 보내지 못했습니다.');
  }
}

const sweptOwners = new Set<string>();

/** 이 휴대폰이 예전에 올렸지만 전달되지 못한 객체(24시간 초과)를 지운다. 세션당 한 번. */
export async function sweepOwnVocTransit(supabase: SupabaseClient, hostId: string, uid: string, now = Date.now()): Promise<number> {
  const key = hostId + '/' + uid;
  if (sweptOwners.has(key)) return 0;
  sweptOwners.add(key);
  try {
    const { data, error } = await supabase.storage.from(VOC_TRANSIT_BUCKET).list(key, { limit: 100 });
    if (error || !data) return 0;
    const stale = data
      .filter(file => { const created = Date.parse(file.created_at ?? ''); return Number.isFinite(created) && now - created > VOC_TRANSIT_MAX_AGE_MS; })
      .map(file => `${key}/${file.name}`);
    await removeQuietly(supabase, stale);
    return stale.length;
  } catch {
    return 0;
  }
}
