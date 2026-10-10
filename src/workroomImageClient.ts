/**
 * Puts an image into a Workroom request: a paste (⌘V) or a screen capture, saved by this Mac's sidecar
 * (src/workroomImages.ts). Mac only — a phone cannot hand its photos to the Mac's CLI this way.
 */
import {terminalLocalRequest} from './aiTerminalClient';
import {AI_TERMINAL_PREFIX} from './aiTerminalProtocol';
import {isTauri} from './lib/env';
import {WORKROOM_IMAGE_ENDPOINT_SUFFIX, WORKROOM_IMAGE_MAX_BYTES, blobToBase64, type WorkroomCaptureMode, type WorkroomImageAttachment} from './workroomImageAttachments';

const ENDPOINT = AI_TERMINAL_PREFIX + WORKROOM_IMAGE_ENDPOINT_SUFFIX;

/** null for a cancelled capture; anything malformed is an error rather than a broken chip. */
export function normalizeWorkroomImageResponse(value: unknown): WorkroomImageAttachment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('이미지 응답 형식이 올바르지 않습니다.');
  const r = value as Record<string, unknown>;
  if (r.cancelled === true && Object.keys(r).length === 1) return null;
  if (typeof r.path !== 'string' || !r.path.startsWith('/') || /[\r\n]/.test(r.path) || r.path.length > 1024
    || typeof r.name !== 'string' || r.name.length > 200 || typeof r.bytes !== 'number' || !Number.isFinite(r.bytes)
    || (r.thumbnail !== undefined && (typeof r.thumbnail !== 'string' || !r.thumbnail.startsWith('data:image/jpeg;base64,')))) {
    throw new Error('이미지 응답 형식이 올바르지 않습니다.');
  }
  return {path: r.path, name: r.name, bytes: r.bytes, ...(typeof r.thumbnail === 'string' ? {thumbnail: r.thumbnail} : {})};
}

export async function saveWorkroomImageBlob(blob: Blob): Promise<WorkroomImageAttachment> {
  if (blob.size > WORKROOM_IMAGE_MAX_BYTES) throw new Error('이미지는 15MB 이하만 넣을 수 있습니다.');
  const image = normalizeWorkroomImageResponse(await terminalLocalRequest(ENDPOINT, {operation: 'save', data: await blobToBase64(blob)}));
  if (!image) throw new Error('이미지를 저장하지 못했습니다.');
  return image;
}

async function setAppHidden(hidden: boolean): Promise<boolean> {
  if (!isTauri()) return false;
  const {invoke} = await import('@tauri-apps/api/core');
  await invoke('workroom_capture_hide_app', {hidden});
  return true;
}

/**
 * The app steps aside (every window, like ⌘H) so the person can select what is behind it, then returns.
 * Hiding is a convenience: if it fails the capture still runs over whatever is on screen.
 */
export async function captureWorkroomScreen(mode: WorkroomCaptureMode): Promise<WorkroomImageAttachment | null> {
  const hidden = await setAppHidden(true).catch(() => false);
  try {
    // Let the windows leave the screen before a full-screen capture is taken.
    if (hidden) await new Promise(resolve => setTimeout(resolve, 200));
    return normalizeWorkroomImageResponse(await terminalLocalRequest(ENDPOINT, {operation: 'capture', mode}));
  } finally {
    if (hidden) await setAppHidden(false).catch(() => { /* the Dock still brings it back */ });
  }
}
