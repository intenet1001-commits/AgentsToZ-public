import {randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, sep} from 'node:path';
import {WORKROOM_IMAGE_MAX_BYTES, type WorkroomCaptureMode, type WorkroomImageAttachment} from './workroomImageAttachments';

/**
 * Images for a Workroom request (VOC 2026-10-02: "캡쳐해서 넣기"). A pasted image or a screen capture is saved
 * here, on the Mac that runs the CLI, and the request names its absolute path: Claude Code reads it with its
 * Read tool and Codex with view_image, so no CLI-specific attachment protocol is needed.
 *
 * Files live in the app data folder, not in the user's project (no repository noise), one folder per day,
 * and folders older than WORKROOM_IMAGE_RETENTION_DAYS are removed on the next save.
 */
export const WORKROOM_IMAGE_DIR = 'workroom-images';
export const WORKROOM_IMAGE_RETENTION_DAYS = 14;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type WorkroomImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'heic';
/** Decided by the bytes, never by a name or a MIME type the page claims. */
export function workroomImageKind(bytes: Uint8Array): WorkroomImageKind | null {
  const at = (i: number, ...values: number[]) => values.every((value, k) => bytes[i + k] === value);
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'jpeg';
  if (bytes.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return 'gif';
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  if (bytes.length >= 12 && at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (['heic', 'heix', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (now: Date) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const stampOf = (now: Date) => `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

export function workroomImageRoot(appDataDir: string): string { return join(appDataDir, WORKROOM_IMAGE_DIR); }

/** A fresh path for today's next image; the folder exists, the file does not. */
export function newWorkroomImagePath(appDataDir: string, extension: string, now = new Date()): string {
  const dir = join(workroomImageRoot(appDataDir), dayOf(now));
  mkdirSync(dir, {recursive: true, mode: 0o700});
  return join(dir, `${stampOf(now)}-${randomBytes(4).toString('hex')}.${extension}`);
}

/** Removes day folders older than the retention; anything else in the root is left alone. */
export function pruneWorkroomImages(appDataDir: string, now = new Date()): number {
  const root = workroomImageRoot(appDataDir);
  if (!existsSync(root)) return 0;
  const oldest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - WORKROOM_IMAGE_RETENTION_DAYS);
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!DAY.test(name) || name >= dayOf(oldest)) continue;
    try { rmSync(join(root, name), {recursive: true, force: true}); removed++; } catch { /* next save retries */ }
  }
  return removed;
}

/** Only files this module made: a day folder directly under the root. */
export function isWorkroomImagePath(appDataDir: string, path: string): boolean {
  const root = workroomImageRoot(appDataDir) + sep;
  if (!path.startsWith(root)) return false;
  const rest = path.slice(root.length).split(sep);
  return rest.length === 2 && DAY.test(rest[0]!) && /^\d{6}-[0-9a-f]{8}\.(png|jpeg|gif|webp|heic)$/.test(rest[1]!);
}

export function saveWorkroomImage(appDataDir: string, bytes: Uint8Array, now = new Date()): {path: string; kind: WorkroomImageKind} {
  if (bytes.byteLength < 1 || bytes.byteLength > WORKROOM_IMAGE_MAX_BYTES) throw new Error('이미지는 15MB 이하만 넣을 수 있습니다.');
  const kind = workroomImageKind(bytes);
  if (!kind) throw new Error('PNG·JPEG·GIF·WebP·HEIC 이미지만 넣을 수 있습니다.');
  pruneWorkroomImages(appDataDir, now);
  const path = newWorkroomImagePath(appDataDir, kind, now);
  writeFileSync(path, bytes, {mode: 0o600, flag: 'wx'});
  return {path, kind};
}

/**
 * `screencapture` for each mode. `-x` keeps it silent. Region starts in selection mode (Space switches to a
 * window), window starts in window mode without the shadow, and screen captures the main display only
 * (several displays would need one file each).
 */
export function workroomCaptureArgs(mode: WorkroomCaptureMode, path: string): string[] {
  const flags = mode === 'region' ? ['-i'] : mode === 'window' ? ['-i', '-W', '-o'] : ['-m'];
  return ['/usr/sbin/screencapture', '-x', ...flags, path];
}

export interface WorkroomImageHost {
  appDataDir: string;
  /** Runs a command to completion; resolves its exit code. */
  run?: (argv: string[], timeoutMs: number) => Promise<number>;
  now?: () => Date;
}

async function runCommand(argv: string[], timeoutMs: number): Promise<number> {
  const child = Bun.spawn(argv, {stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'});
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* exited */ } }, timeoutMs);
  try { return await child.exited; } finally { clearTimeout(timer); }
}

/** A small JPEG preview for the composer chip. Optional: without one the chip shows only its name. */
async function thumbnail(host: WorkroomImageHost, path: string): Promise<string | undefined> {
  const out = `${path}.thumb.jpg`;
  try {
    const code = await (host.run ?? runCommand)(['/usr/bin/sips', '-Z', '240', '-s', 'format', 'jpeg', path, '--out', out], 10_000);
    if (code !== 0 || !existsSync(out) || statSync(out).size > 200_000) return undefined;
    return `data:image/jpeg;base64,${readFileSync(out).toString('base64')}`;
  } catch {
    return undefined;
  } finally {
    rmSync(out, {force: true});
  }
}

function attachment(path: string, bytes: number, preview: string | undefined): WorkroomImageAttachment {
  return {path, name: path.split(sep).pop()!, bytes, ...(preview ? {thumbnail: preview} : {})};
}

export async function storeWorkroomImage(host: WorkroomImageHost, data: string): Promise<WorkroomImageAttachment> {
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length > Math.ceil(WORKROOM_IMAGE_MAX_BYTES / 3) * 4) {
    throw new Error('이미지는 15MB 이하만 넣을 수 있습니다.');
  }
  const bytes = Buffer.from(data, 'base64');
  const saved = saveWorkroomImage(host.appDataDir, bytes, host.now?.());
  return attachment(saved.path, bytes.byteLength, await thumbnail(host, saved.path));
}

/** null: the person cancelled (Esc) or nothing was captured. */
export async function captureWorkroomImage(host: WorkroomImageHost, mode: WorkroomCaptureMode): Promise<WorkroomImageAttachment | null> {
  if (process.platform !== 'darwin') throw new Error('화면 캡처는 macOS에서만 지원합니다.');
  pruneWorkroomImages(host.appDataDir, host.now?.());
  const path = newWorkroomImagePath(host.appDataDir, 'png', host.now?.());
  // A selection waits for the person; give up after five minutes instead of holding the request forever.
  const code = await (host.run ?? runCommand)(workroomCaptureArgs(mode, path), 300_000);
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  if (code !== 0 || workroomImageKind(bytes) !== 'png') { rmSync(path, {force: true}); throw new Error('화면을 캡처하지 못했습니다. 시스템 설정 → 개인정보 보호 및 보안 → 화면 기록에서 이 앱을 허용했는지 확인하세요.'); }
  return attachment(path, bytes.byteLength, await thumbnail(host, path));
}

export async function handleWorkroomImageRequest(host: WorkroomImageHost, body: unknown): Promise<WorkroomImageAttachment | {cancelled: true}> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('이미지 요청이 올바르지 않습니다.');
  const r = body as Record<string, unknown>;
  if (r.operation === 'save' && Object.keys(r).every(key => key === 'operation' || key === 'data')) return storeWorkroomImage(host, r.data as string);
  if (r.operation === 'capture' && Object.keys(r).every(key => key === 'operation' || key === 'mode')
    && (r.mode === 'region' || r.mode === 'window' || r.mode === 'screen')) {
    return (await captureWorkroomImage(host, r.mode)) ?? {cancelled: true};
  }
  throw new Error('이미지 요청이 올바르지 않습니다.');
}
