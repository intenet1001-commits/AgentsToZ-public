/**
 * Workroom attachments, the page half of the host operations (src/workroomAttachmentHost.ts). Mac only: the
 * composer of a remote Workroom never calls these.
 */
import {terminalLocalRequest} from './aiTerminalClient';
import {AI_TERMINAL_PREFIX} from './aiTerminalProtocol';
import {isWindowsClient} from './clientPlatform';
import {isTauri} from './lib/env';
import {
  WORKROOM_FILE_MAX_BYTES, WORKROOM_LEGACY_IMAGE_REQUEST_ERROR, displayAttachmentName, workroomAttachCopy,
} from './workroomAttachmentRules';
import {WORKROOM_IMAGE_ENDPOINT_SUFFIX, blobToBase64, type WorkroomImageAttachment} from './workroomImageAttachments';
import {normalizeWorkroomImageResponse} from './workroomImageClient';

const ENDPOINT = AI_TERMINAL_PREFIX + WORKROOM_IMAGE_ENDPOINT_SUFFIX;

/** An older Mac sidecar knows only `save` and `capture`; say so instead of showing its generic refusal. */
async function request(body: Record<string, unknown>): Promise<unknown> {
  try { return await terminalLocalRequest(ENDPOINT, body); }
  catch (error) {
    if (error instanceof Error && error.message === WORKROOM_LEGACY_IMAGE_REQUEST_ERROR) throw new Error(workroomAttachCopy(isWindowsClient()).legacy);
    throw error;
  }
}

export function normalizeWorkroomAttachment(value: unknown): WorkroomImageAttachment {
  const image = normalizeWorkroomImageResponse(value);
  if (!image) throw new Error('첨부 응답 형식이 올바르지 않습니다.');
  return image;
}

/** A file the page has only as bytes (web-build drop, pasted non-image file). */
export async function saveWorkroomFileBlob(file: Blob & {name?: string}): Promise<WorkroomImageAttachment> {
  if (file.size < 1) throw new Error(`빈 파일은 넣을 수 없습니다${file.name ? `: ${file.name}` : ''}.`);
  if (file.size > WORKROOM_FILE_MAX_BYTES) throw new Error(`경로 없이 넣는 파일은 15MB 이하만 됩니다${file.name ? `: ${file.name}` : ''}. 더 큰 파일은 「파일 첨부」로 고르세요.`);
  return normalizeWorkroomAttachment(await request({operation: 'save-file', data: await blobToBase64(file), name: (file.name || 'file').slice(0, 200)}));
}

export interface ImportedAttachments {attachments: WorkroomImageAttachment[]; refused: {name: string; reason: string}[]}
/** Paths this Mac has (Finder drop, picker): images are copied with a thumbnail, other files referenced. */
export async function importWorkroomAttachmentPaths(paths: readonly string[]): Promise<ImportedAttachments> {
  const value = await request({operation: 'import', paths: [...paths]});
  if (!value || typeof value !== 'object' || !Array.isArray((value as ImportedAttachments).attachments) || !Array.isArray((value as ImportedAttachments).refused)) {
    throw new Error('첨부 응답 형식이 올바르지 않습니다.');
  }
  const r = value as ImportedAttachments;
  return {
    attachments: r.attachments.map(normalizeWorkroomAttachment),
    // Shown in the error line: an older host may still echo raw control or bidi characters.
    refused: r.refused.map(item => ({name: displayAttachmentName(String(item?.name ?? '?')), reason: Array.from(String(item?.reason ?? '첨부하지 못했습니다.')).slice(0, 300).join('')})),
  };
}

/** A drop on the terminal in direct input mode: the host types the quoted paths (or refuses at a question). */
export async function typeWorkroomDroppedPaths(sessionId: string, targetId: string, paths: readonly string[]): Promise<void> {
  await request({operation: 'type-paths', sessionId, targetId, paths: [...paths]});
}

/** What a pick or a drop handed over: the usable paths, and how many items there were in all. */
export interface PickedPaths {paths: string[]; total: number}

/** `{paths, total}` from Rust; a bare list (no total) counts as complete. Anything else is not a pick. */
export function normalizePickedPaths(value: unknown): PickedPaths | null {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as PickedPaths).paths) ? (value as PickedPaths).paths : null;
  if (!list) return null;
  const paths = list.filter((path): path is string => typeof path === 'string');
  const total = !Array.isArray(value) && typeof (value as PickedPaths).total === 'number' && Number.isFinite((value as PickedPaths).total) ? (value as PickedPaths).total : list.length;
  return {paths, total: Math.max(total, paths.length)};
}

/**
 * The native picker from Rust (real paths, image filter). null when it is not available — the web build, or an
 * app without the command — so the caller falls back to `<input type=file>`. No paths and total 0 means the
 * person cancelled; a total above the paths is what Rust could not hand over (beyond its cap, or not UTF-8).
 */
export async function pickWorkroomAttachmentPaths(kind: 'image' | 'file'): Promise<PickedPaths | null> {
  if (!isTauri()) return null;
  try {
    const {invoke} = await import('@tauri-apps/api/core');
    return normalizePickedPaths(await invoke<unknown>('workroom_pick_attachments', {kind}));
  } catch {
    return null;
  }
}
