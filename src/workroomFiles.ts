import {randomBytes} from 'node:crypto';
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, sep} from 'node:path';
import {
  WORKROOM_FILE_MAX_ATTACHMENTS, WORKROOM_FILE_MAX_BYTES, WORKROOM_TYPED_PATHS_MAX, attachmentBaseName, attachmentPathProblem,
  displayAttachmentName, sanitizeWorkroomFileName, workroomTypedPathsText,
} from './workroomAttachmentRules';
import {WORKROOM_IMAGE_MAX_ATTACHMENTS, type WorkroomImageAttachment} from './workroomImageAttachments';
import {workroomImageKind, saveWorkroomImage, thumbnailWorkroomImage, type WorkroomImageHost} from './workroomImages';

/**
 * Workroom file attachments, the host half (S3, 2026-10-16). Two ways in:
 *   - A path the Mac already has (a Finder drop, a picked file): referenced in place — no copy. An image found
 *     that way is imported into workroom-images like a pasted one, so it keeps its thumbnail.
 *   - Bytes without a path (a web-build drop, a pasted non-image file): saved under <appData>/workroom-files.
 * Each path is checked again right before the request is written (assertWorkroomFileAttachments).
 *
 * These functions take paths or bytes and return the composer's opaque attachment record; a later phone wave
 * decrypts its upload and stores it through saveWorkroomFile, getting the same record back.
 */
export const WORKROOM_FILE_DIR = 'workroom-files';
export const WORKROOM_FILE_RETENTION_DAYS = 14;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A refusal with a stable code for tests and logs; the message is what the person reads. */
export class WorkroomAttachmentError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (now: Date) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const stampOf = (now: Date) => `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

export function workroomFileRoot(appDataDir: string): string { return join(appDataDir, WORKROOM_FILE_DIR); }

/** Removes day folders older than the retention, like workroom-images. */
export function pruneWorkroomFiles(appDataDir: string, now = new Date()): number {
  const root = workroomFileRoot(appDataDir);
  if (!existsSync(root)) return 0;
  const oldest = dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - WORKROOM_FILE_RETENTION_DAYS));
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!DAY.test(name) || name >= oldest) continue;
    try { rmSync(join(root, name), {recursive: true, force: true}); removed++; } catch { /* next save retries */ }
  }
  return removed;
}

export function saveWorkroomFile(appDataDir: string, bytes: Uint8Array, name: unknown, now = new Date()): WorkroomImageAttachment {
  if (bytes.byteLength < 1) throw new WorkroomAttachmentError('WORKROOM_FILE_EMPTY', '빈 파일은 넣을 수 없습니다.');
  if (bytes.byteLength > WORKROOM_FILE_MAX_BYTES) throw new WorkroomAttachmentError('WORKROOM_FILE_TOO_LARGE', '경로 없이 넣는 파일은 15MB 이하만 됩니다. 더 큰 파일은 Finder에서 끌어 놓거나 「파일 첨부」로 고르세요.');
  pruneWorkroomFiles(appDataDir, now);
  const dir = join(workroomFileRoot(appDataDir), dayOf(now));
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const safe = sanitizeWorkroomFileName(name);
  const path = join(dir, `${stampOf(now)}-${randomBytes(4).toString('hex')}-${safe}`);
  writeFileSync(path, bytes, {mode: 0o600, flag: 'wx'});
  return {kind: 'file', path, name: safe, bytes: bytes.byteLength};
}

/**
 * A path the host may name in a request, checked now: absolute, no control or bidi characters, exists, and a
 * regular file or a directory (a socket or a device is refused). The returned name is what the chip shows.
 */
export function inspectWorkroomReferencePath(path: unknown): {path: string; name: string; bytes: number; directory: boolean} {
  const problem = attachmentPathProblem(path);
  if (problem) throw new WorkroomAttachmentError('WORKROOM_FILE_PATH_INVALID', problem);
  const value = path as string;
  let info;
  try { info = statSync(value); } catch { throw new WorkroomAttachmentError('WORKROOM_FILE_MISSING', `파일을 찾지 못했습니다: ${attachmentBaseName(value)}`); }
  if (!info.isFile() && !info.isDirectory()) throw new WorkroomAttachmentError('WORKROOM_FILE_KIND', `일반 파일이나 폴더만 첨부할 수 있습니다: ${attachmentBaseName(value)}`);
  return {path: value, name: attachmentBaseName(value), bytes: info.isFile() ? info.size : 0, directory: info.isDirectory()};
}

/**
 * A whole-request submission names files by path. Each is checked again right before anything is written —
 * a file deleted or swapped for a socket since it was attached is refused, and the draft stays.
 */
export function assertWorkroomFileAttachments(paths: readonly string[]): void {
  if (!paths.length || paths.length > WORKROOM_FILE_MAX_ATTACHMENTS) throw new Error('첨부 파일 목록을 확인하지 못했습니다. 작성 내용은 유지했습니다.');
  for (const path of paths) {
    try { inspectWorkroomReferencePath(path); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : '첨부 파일을 확인하지 못했습니다.'} 파일을 다시 넣어 주세요. 작성 내용은 유지했습니다.`); }
  }
}

function headBytes(path: string): Uint8Array {
  const fd = openSync(path, 'r');
  try { const buffer = new Uint8Array(16); const read = readSync(fd, buffer, 0, 16, 0); return buffer.subarray(0, read); }
  finally { closeSync(fd); }
}

/**
 * Paths dropped or picked on this Mac, in order. An image (by its bytes, ≤ 15 MB) is copied into workroom-images
 * with a thumbnail; anything else is referenced where it is. A path that cannot be used is reported by name and
 * the rest still attach — one bad item must not lose the others.
 */
export async function importWorkroomAttachmentPaths(host: WorkroomImageHost, paths: unknown): Promise<{attachments: WorkroomImageAttachment[]; refused: {name: string; reason: string}[]}> {
  if (!Array.isArray(paths) || !paths.length || paths.length > WORKROOM_IMAGE_MAX_ATTACHMENTS + WORKROOM_FILE_MAX_ATTACHMENTS) {
    throw new WorkroomAttachmentError('WORKROOM_FILE_IMPORT_INVALID', `한 번에 ${WORKROOM_IMAGE_MAX_ATTACHMENTS + WORKROOM_FILE_MAX_ATTACHMENTS}개까지 넣을 수 있습니다.`);
  }
  const attachments: WorkroomImageAttachment[] = [];
  const refused: {name: string; reason: string}[] = [];
  for (const raw of paths) {
    try {
      const item = inspectWorkroomReferencePath(raw);
      if (!item.directory && item.bytes > 0 && item.bytes <= WORKROOM_FILE_MAX_BYTES && workroomImageKind(headBytes(item.path))) {
        const bytes = readFileSync(item.path);
        const saved = saveWorkroomImage(host.appDataDir, bytes, host.now?.());
        const preview = await thumbnailWorkroomImage(host, saved.path);
        attachments.push({path: saved.path, name: item.name, bytes: bytes.byteLength, ...(preview ? {thumbnail: preview} : {})});
        continue;
      }
      attachments.push({kind: 'file', path: item.path, name: item.name, bytes: item.bytes, ...(item.directory ? {directory: true} : {})});
    } catch (error) {
      refused.push({name: typeof raw === 'string' ? displayAttachmentName(raw) : '?', reason: error instanceof Error ? error.message : '첨부하지 못했습니다.'});
    }
  }
  return {attachments, refused};
}

/** What a typed-path drop needs from the terminal host; tested without a PTY. */
export interface WorkroomPathTypingTerminal {
  /** The live session's visible rows, or null when there is no running session to read. */
  screenRows(sessionId: string, targetId: string): Promise<readonly string[] | null>;
  bracketedPaste(sessionId: string, targetId: string): Promise<boolean>;
  write(sessionId: string, data: string): Promise<void>;
}

/**
 * A drop on the terminal in direct input mode types the dropped paths at the CLI's prompt — quoted, no Enter.
 * Refused while the screen waits for an answer: a path's characters would choose a menu item or answer y/n.
 * Wrapped as one bracketed paste when the CLI turned DECSET 2004 on, so it arrives as text, not keystrokes.
 */
export async function typeWorkroomDroppedPaths(terminal: WorkroomPathTypingTerminal, awaitsAnswer: (rows: readonly string[]) => boolean, request: {sessionId: string; targetId: string; paths: unknown}): Promise<{typed: number}> {
  if (!Array.isArray(request.paths) || !request.paths.length) throw new WorkroomAttachmentError('WORKROOM_FILE_IMPORT_INVALID', '입력할 경로가 없습니다.');
  if (request.paths.length > WORKROOM_TYPED_PATHS_MAX) {
    throw new WorkroomAttachmentError('WORKROOM_TYPED_PATHS_TOO_MANY', `한 번에 ${WORKROOM_TYPED_PATHS_MAX}개까지 입력할 수 있습니다 — 나눠서 끌어 놓거나 입력칸에 놓아 첨부하세요.`);
  }
  const paths = request.paths.map(path => inspectWorkroomReferencePath(path).path);
  const rows = await terminal.screenRows(request.sessionId, request.targetId);
  if (!rows) throw new WorkroomAttachmentError('WORKROOM_TERMINAL_UNAVAILABLE', '실행 중인 터미널 화면을 읽지 못해 경로를 입력하지 않았습니다.');
  if (awaitsAnswer(rows)) throw new WorkroomAttachmentError('WORKROOM_TERMINAL_AWAITS_ANSWER', 'AI가 답을 기다리는 화면이라 경로를 입력하지 않았습니다 — 먼저 질문에 답한 뒤 다시 끌어 놓거나, 입력칸에 놓아 첨부하세요.');
  const text = workroomTypedPathsText(paths, process.platform === 'win32');
  const data = (await terminal.bracketedPaste(request.sessionId, request.targetId)) ? `\x1b[200~${text}\x1b[201~` : text;
  if (new TextEncoder().encode(data).length > 4096) throw new WorkroomAttachmentError('WORKROOM_TYPED_PATHS_TOO_LONG', '경로가 너무 길어 한 번에 입력할 수 없습니다. 입력칸에 놓아 첨부하세요.');
  await terminal.write(request.sessionId, data);
  return {typed: paths.length};
}

/** Only files this module saved: a day folder directly under the root. */
export function isWorkroomFilePath(appDataDir: string, path: string): boolean {
  const root = workroomFileRoot(appDataDir) + sep;
  if (!path.startsWith(root)) return false;
  const rest = path.slice(root.length).split(sep);
  return rest.length === 2 && DAY.test(rest[0]!) && /^\d{6}-[0-9a-f]{8}-.+$/.test(rest[1]!);
}
