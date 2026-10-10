/**
 * Workroom image attachments, the browser half (the host half is src/workroomImages.ts).
 * An image is saved on the Mac that runs the CLI; the request names its absolute path so every CLI can open it.
 */
export const WORKROOM_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
/** Per request; more is usually a sign that the wrong files were pasted. */
export const WORKROOM_IMAGE_MAX_ATTACHMENTS = 6;
export const WORKROOM_IMAGE_ENDPOINT_SUFFIX = '/images';

export type WorkroomCaptureMode = 'region' | 'window' | 'screen';
export interface WorkroomImageAttachment {path: string; name: string; bytes: number; thumbnail?: string}

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

/**
 * The text a CLI receives: the request, then one absolute path per line under a header that tells the AI to
 * open them. Paths contain no newline (the host names them), so each stays one line.
 */
export function workroomImageMessage(text: string, paths: readonly string[]): string {
  if (!paths.length) return text;
  const body = text.replace(/\s+$/, '');
  return `${body ? body + '\n\n' : ''}[첨부 이미지 ${paths.length}개 — 각 파일을 열어 확인하세요]\n${paths.join('\n')}`;
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
