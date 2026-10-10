/**
 * VOC 스크린샷 첨부 — 순수 규칙(한도·형식·요청 본문)과 브라우저 파일 읽기.
 *
 * 첨부는 두 갈래로 들어온다.
 *   - 브라우저·붙여넣기·파일 선택 → `File` → base64로 읽어 `images`에 싣는다.
 *   - 앱(Tauri)에서 Finder 드롭 → 웹뷰에 HTML drop이 오지 않으므로 `onDragDropEvent`의
 *     절대경로를 `imagePaths`에 싣고, 파일은 Mac의 사이드카가 직접 읽는다.
 * 합쳐서 최대 5장이다(서버도 같은 한도를 강제한다).
 */

import { VOC_IMAGE_MIMES, VOC_MAX_ATTACHMENTS, VOC_MAX_IMAGE_BYTES, type VocImageMime } from '../vocAttachments';

// 한도는 휴대폰·사이드카와 같은 정본(src/vocAttachments.ts)을 쓴다 — 표면마다 숫자를 따로 두지 않는다.
export { VOC_IMAGE_MIMES, VOC_MAX_ATTACHMENTS, VOC_MAX_IMAGE_BYTES, type VocImageMime };
export const VOC_DOWNSCALE_LONG_EDGE = 2400;
export const VOC_DOWNSCALE_JPEG_QUALITY = 0.85;
export const VOC_IMAGE_ACCEPT = VOC_IMAGE_MIMES.join(',');

export interface VocImagePayload { dataBase64: string; mime: VocImageMime; name?: string }

export type VocAttachment =
  | { kind: 'data'; key: string; name: string; mime: VocImageMime; dataBase64: string; bytes: number }
  | { kind: 'path'; key: string; name: string; path: string };

export function isVocImageMime(value: string | undefined | null): value is VocImageMime {
  return !!value && (VOC_IMAGE_MIMES as readonly string[]).includes(value);
}

/** Tauri 드롭은 경로만 준다. 확장자로 이미지만 고른다(대소문자 무시). */
export function isVocImagePath(path: string): boolean {
  return /\.(png|jpe?g|webp)$/i.test(path.trim());
}

export function fileNameOfPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * 새 후보를 한도 안에서만 붙인다. 같은 경로를 두 번 떨어뜨리면 한 번만 담는다.
 * `rejected`는 한도 때문에 버린 개수 — 조용히 버리면 사용자는 첨부가 된 줄 안다.
 */
export function appendVocAttachments(
  current: readonly VocAttachment[],
  incoming: readonly VocAttachment[],
  max = VOC_MAX_ATTACHMENTS,
): { next: VocAttachment[]; rejected: number } {
  const next = [...current];
  let rejected = 0;
  for (const item of incoming) {
    if (item.kind === 'path' && next.some(existing => existing.kind === 'path' && existing.path === item.path)) continue;
    if (next.length >= max) { rejected += 1; continue; }
    next.push(item);
  }
  return { next, rejected };
}

/** POST /api/voc 본문의 첨부 부분. 비어 있으면 키 자체를 싣지 않는다(옛 사이드카 호환). */
export function buildVocAttachmentPayload(attachments: readonly VocAttachment[]): { images?: VocImagePayload[]; imagePaths?: string[] } {
  const limited = attachments.slice(0, VOC_MAX_ATTACHMENTS);
  const images = limited.flatMap(item => item.kind === 'data'
    ? [{ dataBase64: item.dataBase64, mime: item.mime, name: item.name }]
    : []);
  const imagePaths = limited.flatMap(item => item.kind === 'path' ? [item.path] : []);
  return {
    ...(images.length ? { images } : {}),
    ...(imagePaths.length ? { imagePaths } : {}),
  };
}

/**
 * 브라우저 이미지를 어떻게 올릴지.
 *   - PNG 8MB 이하 → 그대로 (스크린샷 글자가 JPEG로 뭉개지지 않게)
 *   - 그 밖에는 8MB 이하이고 긴 변 2400px 이하면 그대로
 *   - 나머지는 긴 변 2400px JPEG 0.85로 줄인다. 줄인 뒤에도 8MB를 넘으면 거절.
 */
export function planVocImageUpload(input: { mime: string; bytes: number; width: number; height: number }): 'as-is' | 'downscale' | 'reject' {
  if (!isVocImageMime(input.mime)) return 'reject';
  if (input.mime === 'image/png' && input.bytes <= VOC_MAX_IMAGE_BYTES) return 'as-is';
  const longEdge = Math.max(input.width, input.height);
  if (input.bytes <= VOC_MAX_IMAGE_BYTES && longEdge <= VOC_DOWNSCALE_LONG_EDGE) return 'as-is';
  return 'downscale';
}

export function scaledSize(width: number, height: number, longEdge = VOC_DOWNSCALE_LONG_EDGE): { width: number; height: number } {
  const edge = Math.max(width, height);
  if (edge <= longEdge || edge <= 0) return { width, height };
  const ratio = longEdge / edge;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

export function base64ByteLength(dataBase64: string): number {
  const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0;
  return Math.floor(dataBase64.length * 3 / 4) - padding;
}

function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('파일을 읽지 못했습니다.'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('이미지를 열지 못했습니다.'));
    image.src = url;
  });
}

let attachmentSeq = 0;
export function nextVocAttachmentKey(prefix: string): string {
  attachmentSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${attachmentSeq}`;
}

/** 브라우저 File → 첨부. 규칙에 맞지 않으면 사용자에게 보여 줄 문구로 던진다. */
export async function readVocImageFile(file: File): Promise<VocAttachment> {
  const name = file.name || 'screenshot.png';
  if (!isVocImageMime(file.type)) throw new Error(`「${name}」은 PNG·JPEG·WebP 이미지가 아닙니다.`);
  const dataUrl = await readAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const plan = planVocImageUpload({ mime: file.type, bytes: file.size, width: image.naturalWidth, height: image.naturalHeight });
  if (plan === 'reject') throw new Error(`「${name}」은 첨부할 수 없는 형식입니다.`);
  if (plan === 'as-is') {
    return { kind: 'data', key: nextVocAttachmentKey('img'), name, mime: file.type, dataBase64: dataUrlToBase64(dataUrl), bytes: file.size };
  }
  const size = scaledSize(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(`「${name}」을 줄이지 못했습니다.`);
  context.drawImage(image, 0, 0, size.width, size.height);
  const dataBase64 = dataUrlToBase64(canvas.toDataURL('image/jpeg', VOC_DOWNSCALE_JPEG_QUALITY));
  const bytes = base64ByteLength(dataBase64);
  if (bytes > VOC_MAX_IMAGE_BYTES) throw new Error(`「${name}」은 줄여도 8MB를 넘습니다.`);
  return { kind: 'data', key: nextVocAttachmentKey('img'), name: name.replace(/\.(png|webp|jpe?g)$/i, '') + '.jpg', mime: 'image/jpeg', dataBase64, bytes };
}

export function pathVocAttachment(path: string): VocAttachment {
  return { kind: 'path', key: nextVocAttachmentKey('path'), name: fileNameOfPath(path), path };
}

/** 저장 응답(`POST /api/voc`)에서 워크룸 인계에 필요한 것만 꺼낸다. */
export interface VocSubmitResult { file: string; id?: string; attachments: string[] }

export function normalizeVocSubmitResponse(data: unknown): VocSubmitResult {
  const record = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  return {
    file: typeof record.file === 'string' ? record.file : '',
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    attachments: Array.isArray(record.attachments) ? record.attachments.filter((p): p is string => typeof p === 'string') : [],
  };
}
