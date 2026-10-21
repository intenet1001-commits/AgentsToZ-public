/**
 * Workroom image attachments, the browser half (the host half is src/workroomImages.ts).
 * An image is saved on the Mac that runs the CLI; the request names its absolute path so every CLI can open it.
 */
import {isAbsoluteAttachmentPath} from './workroomAttachmentRules';
export const WORKROOM_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
/** Per request; more is usually a sign that the wrong files were pasted. */
export const WORKROOM_IMAGE_MAX_ATTACHMENTS = 6;
export const WORKROOM_IMAGE_ENDPOINT_SUFFIX = '/images';

export type WorkroomCaptureMode = 'region' | 'window' | 'screen';
/**
 * One composer attachment. `kind` is absent for an image (every record before S3 was one); `file` is any other
 * file or a folder (`directory`), named in the request's second block. A later phone wave stores its uploaded
 * bytes through the same host functions and gets the same record back (src/workroomFiles.ts).
 */
export interface WorkroomImageAttachment {path: string; name: string; bytes: number; thumbnail?: string; kind?: 'image' | 'file'; directory?: boolean}

export const WORKROOM_CAPTURE_LABELS: Record<WorkroomCaptureMode, string> = {region: '영역 캡처', window: '창 캡처', screen: '전체 화면'};
/**
 * In the Workroom only (the app is in front): ⌥⌘ + the digit of macOS's own ⇧⌘ capture keys, so it does not
 * collide with them or with Shottr's global keys. Region ⌥⌘4 (like ⇧⌘4), window ⌥⌘5, full screen ⌥⌘3 (like ⇧⌘3).
 */
export const WORKROOM_CAPTURE_SHORTCUTS: Record<WorkroomCaptureMode, {code: string; label: string}> = {
  region: {code: 'Digit4', label: '⌥⌘4'},
  window: {code: 'Digit5', label: '⌥⌘5'},
  screen: {code: 'Digit3', label: '⌥⌘3'},
};
export function workroomCaptureShortcut(event: {code: string; metaKey: boolean; altKey: boolean; shiftKey: boolean; ctrlKey: boolean}): WorkroomCaptureMode | null {
  if (!event.metaKey || !event.altKey || event.shiftKey || event.ctrlKey) return null;
  for (const mode of Object.keys(WORKROOM_CAPTURE_SHORTCUTS) as WorkroomCaptureMode[]) if (WORKROOM_CAPTURE_SHORTCUTS[mode].code === event.code) return mode;
  return null;
}

const IMAGE_HEADER = (count: number) => `[첨부 이미지 ${count}개 — 각 파일을 열어 확인하세요]`;
const FILE_HEADER = (count: number) => `[첨부 파일 ${count}개 — 각 파일을 열어 확인하세요]`;
/**
 * The text a CLI receives: the request, then one absolute path per line under a header that tells the AI to
 * open them — images first, then other files and folders. Paths contain no newline (the host names or checks
 * them), so each stays one line.
 */
export function workroomAttachmentMessage(text: string, imagePaths: readonly string[], filePaths: readonly string[] = []): string {
  const blocks: string[] = [];
  if (imagePaths.length) blocks.push(`${IMAGE_HEADER(imagePaths.length)}\n${imagePaths.join('\n')}`);
  if (filePaths.length) blocks.push(`${FILE_HEADER(filePaths.length)}\n${filePaths.join('\n')}`);
  if (!blocks.length) return text;
  const body = text.replace(/\s+$/, '');
  return `${body ? body + '\n\n' : ''}${blocks.join('\n\n')}`;
}
export function workroomImageMessage(text: string, paths: readonly string[]): string {
  return workroomAttachmentMessage(text, paths, []);
}
/** The composer's attachments in request order: images block, then files block. */
export function workroomAttachmentsMessage(text: string, attachments: readonly {path: string; kind?: 'image' | 'file'}[]): string {
  return workroomAttachmentMessage(text, attachments.filter(item => item.kind !== 'file').map(item => item.path), attachments.filter(item => item.kind === 'file').map(item => item.path));
}

const ATTACHMENT_HEADER=/^\[첨부 (이미지|파일) (\d+)개 — 각 파일을 열어 확인하세요\]$/;
function lastHeader(lines: readonly string[], end: number): {index: number; kind: 'image' | 'file'; count: number} | null {
  for (let i = end - 1; i >= 0; i--) {
    const match = lines[i]!.match(ATTACHMENT_HEADER);
    if (match) return {index: i, kind: match[1] === '파일' ? 'file' : 'image', count: Number(match[2])};
  }
  return null;
}
/**
 * The trailing blocks workroomAttachmentMessage wrote: a header, then exactly as many path lines as it counts —
 * an image block, a file block, or both in that order. Only blocks that rebuild byte for byte are recognised, so
 * a request that merely quotes a header is not mistaken for one. `files` is present only when there are files.
 */
export function splitWorkroomAttachmentBlock(message: string): {text: string; paths: string[]; files?: string[]} | null {
  const lines = message.split('\n');
  const last = lastHeader(lines, lines.length);
  if (!last) return null;
  let images: string[] = [], files: string[] = [], end = last.index;
  const tail = lines.slice(last.index + 1);
  if (tail.length !== last.count || !tail.length) return null;
  if (last.kind === 'file') {
    files = tail;
    const before = end >= 2 && lines[end - 1] === '' ? lastHeader(lines, end - 1) : null;
    if (before?.kind === 'image') {
      const candidate = lines.slice(before.index + 1, end - 1);
      if (candidate.length === before.count && candidate.length) { images = candidate; end = before.index; }
    }
  } else images = tail;
  if ([...images, ...files].some(path => !isAbsoluteAttachmentPath(path))) return null;
  const text = end === 0 ? '' : lines.slice(0, end - 1).join('\n');
  if (workroomAttachmentMessage(text, images, files) !== message) return null;
  return {text, paths: images, ...(files.length ? {files} : {})};
}
/**
 * Adds a host suffix (`#` references, a correction note) to the end of the request text — before the attachment
 * blocks, so it never lands on a path line, and before the final Enter when there is one.
 */
export function withSuffixBeforeWorkroomAttachments(data: string, suffix: string): string {
  const enter = data.length > 1 && data.endsWith('\r') ? '\r' : '';
  const body = enter ? data.slice(0, -1) : data;
  const block = splitWorkroomAttachmentBlock(body);
  if (!block) return body + suffix + enter;
  return workroomAttachmentMessage(block.text ? block.text + suffix : suffix.trimStart(), block.paths, block.files ?? []) + enter;
}

/** Image files on a paste or a drop, in order; anything else stays text. */
export function workroomImageFiles(items: ArrayLike<{type: string}> | null | undefined): number[] {
  const indexes: number[] = [];
  if (!items) return indexes;
  for (let i = 0; i < items.length; i++) if (/^image\/(png|jpeg|gif|webp|heic|heif)$/.test(items[i]!.type)) indexes.push(i);
  return indexes;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('이미지를 읽지 못했습니다.'));
    reader.onload = () => {
      const value = String(reader.result ?? '');
      const comma = value.indexOf(',');
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.readAsDataURL(blob);
  });
}
