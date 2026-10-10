import type { VocAnchor } from './vocAnchor';
import {
  decryptVocImage,
  detectVocImageMime,
  isVocTransitObjectPath,
  sha256Hex,
  VOC_MAX_CIPHERTEXT_BYTES,
  VOC_TRANSIT_BUCKET,
  VOC_TRANSIT_MAX_AGE_MS,
  type RemoteVocReceipt,
  type RemoteVocSubmission,
} from './vocAttachments';
import { saveVocRecord } from './vocStore.server';

/**
 * 휴대폰 VOC 받기 (Mac 쪽).
 *
 * 1) 첨부를 전부 내려받아 복호화하고 sha256·실제 이미지 형식을 확인한다.
 * 2) 하나라도 실패하면 VOC를 **저장하지 않고** 실패를 돌려준다 — 반쪽 VOC는 없다.
 * 3) 전부 통과해야 JSON + 첨부 폴더를 한 세트로 저장한다.
 * 4) Storage 객체는 받은 즉시 지운다(이 Mac에 service_role이 있을 때). 없으면 휴대폰이 결과를
 *    받은 즉시 자기 객체를 지운다 — `transitDeleted:false`가 그 신호다.
 *
 * 다운로드 URL은 휴대폰이 준 문자열이 아니라 **이 Mac에 설정된 Supabase 주소**로 다시 만든다.
 * 휴대폰은 서명 token만 준다. 그래서 VOC 요청으로 Mac이 임의 주소에 접속하게 만들 수 없다.
 */

export class RemoteVocError extends Error {
  constructor(readonly code: string, message?: string) { super(message ?? code); }
}

export interface RemoteVocTransit {
  /** 가능하면 Storage 객체를 지운다. 지웠으면 true. */
  remove(paths: string[]): Promise<boolean>;
}

const receipts = new Map<string, { at: number; receipt: RemoteVocReceipt }>();
const RECEIPT_TTL_MS = 60 * 60 * 1000;

export function vocTransitDownloadUrl(supabaseUrl: string, path: string, token: string): string {
  const base = new URL(supabaseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname))) {
    throw new RemoteVocError('VOC_SUPABASE_URL_INVALID');
  }
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `${base.origin}/storage/v1/object/sign/${VOC_TRANSIT_BUCKET}/${encodedPath}?token=${encodeURIComponent(token)}`;
}

async function readBounded(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > max) throw new RemoteVocError('VOC_DOWNLOAD_TOO_LARGE');
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); throw new RemoteVocError('VOC_DOWNLOAD_TOO_LARGE'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

export async function receiveRemoteVoc(input: {
  appDataDir: string;
  submission: RemoteVocSubmission;
  hostId: string;
  supabaseUrl: string | null;
  transit: RemoteVocTransit | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): Promise<RemoteVocReceipt> {
  const now = input.now ?? Date.now;
  for (const [id, entry] of receipts) if (now() - entry.at > RECEIPT_TTL_MS) receipts.delete(id);
  // 결과가 불확실해 휴대폰이 같은 VOC를 다시 보내도 두 번 저장하지 않는다.
  const previous = receipts.get(input.submission.vocId);
  if (previous) return previous.receipt;

  const { submission } = input;
  const paths = submission.attachments.map(a => a.path);
  if (paths.some(path => !isVocTransitObjectPath(path, input.hostId))) throw new RemoteVocError('VOC_ATTACHMENT_PATH_INVALID');
  const fetchImpl = input.fetchImpl ?? fetch;
  let images: Uint8Array[] = [];
  try {
    if (submission.attachments.length) {
      if (!input.supabaseUrl) throw new RemoteVocError('VOC_SUPABASE_URL_MISSING');
      images = await Promise.all(submission.attachments.map(async attachment => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 45_000);
        try {
          const response = await fetchImpl(vocTransitDownloadUrl(input.supabaseUrl!, attachment.path, attachment.token), {
            redirect: 'error', signal: controller.signal,
          });
          if (!response.ok) throw new RemoteVocError(response.status === 404 || response.status === 400 ? 'VOC_DOWNLOAD_NOT_FOUND' : 'VOC_DOWNLOAD_FAILED');
          const ciphertext = await readBounded(response, VOC_MAX_CIPHERTEXT_BYTES);
          let plain: Uint8Array;
          try { plain = await decryptVocImage(ciphertext, attachment.key); } catch { throw new RemoteVocError('VOC_DECRYPT_FAILED'); }
          if (plain.byteLength !== attachment.bytes || await sha256Hex(plain) !== attachment.sha256) throw new RemoteVocError('VOC_HASH_MISMATCH');
          if (detectVocImageMime(plain) !== attachment.mime) throw new RemoteVocError('VOC_MIME_MISMATCH');
          return plain;
        } catch (error) {
          if (error instanceof RemoteVocError) throw error;
          throw new RemoteVocError('VOC_DOWNLOAD_FAILED');
        } finally {
          clearTimeout(timer);
        }
      }));
    }
  } catch (error) {
    // 저장하지 않는다. 올린 객체는 가능하면 지금 지우고, 못 지우면 휴대폰이 지운다.
    await input.transit?.remove(paths).catch(() => false);
    throw error;
  }

  const anchor: VocAnchor = {
    tag: 'phone',
    text: (submission.context.screen ?? (submission.source === 'phone-share' ? '사진 공유' : '휴대폰')).slice(0, 80),
    path: submission.context.project ? [submission.context.project.slice(0, 80)] : [],
  };
  const saved = await saveVocRecord({
    appDataDir: input.appDataDir,
    comment: submission.comment,
    anchor,
    tab: submission.context.screen ?? '',
    appVersion: submission.context.appVersion ?? '',
    images: images.map(bytes => ({ bytes })),
    source: submission.source,
    reportedError: submission.error,
    context: { ...submission.context } as Record<string, string>,
  });
  const transitDeleted = paths.length === 0 ? true : await (input.transit?.remove(paths).catch(() => false) ?? Promise.resolve(false));
  const receipt: RemoteVocReceipt = { vocId: submission.vocId, file: saved.file, attachmentPaths: saved.attachmentPaths, transitDeleted };
  receipts.set(submission.vocId, { at: now(), receipt });
  return receipt;
}

/** 테스트 전용 */
export function resetRemoteVocReceipts(): void { receipts.clear(); }

interface StorageLike {
  list(path: string, options?: { limit?: number; offset?: number }): Promise<{ data: { name: string; created_at?: string | null; id?: string | null }[] | null; error: unknown }>;
  remove(paths: string[]): Promise<{ error: unknown }>;
}

/**
 * 전달되지 못한 사진(휴대폰이 올린 뒤 끊김 등)의 정리. 이 Mac의 host 경로 아래에서
 * `VOC_TRANSIT_MAX_AGE_MS`보다 오래된 객체만 지운다. service_role이 있는 Mac에서만 돈다.
 */
export async function sweepVocTransit(storage: StorageLike, hostId: string, now = Date.now()): Promise<{ removed: number }> {
  const uploaders = await storage.list(hostId, { limit: 100 });
  if (uploaders.error || !uploaders.data) return { removed: 0 };
  const stale: string[] = [];
  for (const folder of uploaders.data) {
    if (folder.id) continue; // 폴더가 아니라 파일 — 이 경로 규칙에는 없다
    const files = await storage.list(`${hostId}/${folder.name}`, { limit: 100 });
    if (files.error || !files.data) continue;
    for (const file of files.data) {
      const created = Date.parse(file.created_at ?? '');
      const path = `${hostId}/${folder.name}/${file.name}`;
      if (Number.isFinite(created) && now - created > VOC_TRANSIT_MAX_AGE_MS && isVocTransitObjectPath(path, hostId)) stale.push(path);
    }
  }
  if (!stale.length) return { removed: 0 };
  const { error } = await storage.remove(stale);
  return { removed: error ? 0 : stale.length };
}
