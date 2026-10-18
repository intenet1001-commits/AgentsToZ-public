import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { vocFileName, type VocAnchor, type VocRecord } from './vocAnchor';
import { isPendingVocFileName } from './vocFileAccess';
import { detectVocImageMime, sha256Hex, VOC_MAX_ATTACHMENTS, VOC_MAX_IMAGE_BYTES, vocImageExtension, type VocImageMime } from './vocAttachments';

/**
 * VOC 한 건 = `voc/<이름>.json` + (사진이 있으면) `voc/attachments/<이름>/1.jpg …`.
 *
 * 세트는 원자적으로 생긴다: 사진을 임시 폴더에 다 쓴 뒤 폴더를 제자리로 옮기고, **JSON을 가장
 * 마지막에** 쓴다. 그래서 목록(GET /api/voc)에 보이는 VOC는 언제나 첨부까지 다 있는 VOC다.
 * 사진은 처리 전까지만 필요하다 — JSON이 최상위에서 사라지면(done/으로 이동·삭제) 첨부 폴더도
 * 지운다(`sweepVocAttachments`).
 */

export const VOC_ATTACHMENTS_DIR = 'attachments';
const TEMP_PREFIX = '.incoming-';
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

export interface VocImageInput { bytes: Uint8Array }

export interface VocAttachmentMeta { file: string; mime: VocImageMime; bytes: number; sha256: string }

export interface SavedVoc { file: string; id: string; attachmentPaths: string[] }

export type StoredVocRecord = VocRecord & {
  source?: string;
  reportedError?: { code: string; message: string; detail?: string | null; surface?: string | null };
  context?: Record<string, string>;
  attachments?: VocAttachmentMeta[];
};

export function vocAttachmentDir(appDataDir: string, vocFile: string): string {
  if (!isPendingVocFileName(vocFile)) throw new Error('VOC_FILE_INVALID');
  return join(appDataDir, 'voc', VOC_ATTACHMENTS_DIR, vocFile.replace(/\.json$/, ''));
}

/** 바이트를 검사해 이미지인지·크기가 맞는지 확인한다. 선언된 mime은 믿지 않는다. */
export async function inspectVocImage(bytes: Uint8Array): Promise<{ mime: VocImageMime; sha256: string }> {
  if (bytes.byteLength < 1 || bytes.byteLength > VOC_MAX_IMAGE_BYTES) throw new Error('VOC_IMAGE_TOO_LARGE');
  const mime = detectVocImageMime(bytes);
  if (!mime) throw new Error('VOC_IMAGE_MIME_INVALID');
  return { mime, sha256: await sha256Hex(bytes) };
}

export async function saveVocRecord(input: {
  appDataDir: string;
  comment: string;
  anchor: VocAnchor;
  tab: string;
  appVersion: string;
  images?: readonly VocImageInput[];
  source?: string;
  reportedError?: StoredVocRecord['reportedError'];
  context?: Record<string, string>;
  now?: Date;
  id?: string;
}): Promise<SavedVoc & { record: StoredVocRecord; path: string }> {
  const images = input.images ?? [];
  if (images.length > VOC_MAX_ATTACHMENTS) throw new Error('VOC_TOO_MANY_ATTACHMENTS');
  const inspected = await Promise.all(images.map(image => inspectVocImage(image.bytes)));
  const record: StoredVocRecord = {
    id: input.id ?? randomUUID(),
    createdAt: (input.now ?? new Date()).toISOString(),
    appVersion: input.appVersion,
    tab: input.tab,
    anchor: input.anchor,
    comment: input.comment,
    status: 'open',
    ...(input.source ? { source: input.source } : {}),
    ...(input.reportedError ? { reportedError: input.reportedError } : {}),
    ...(input.context && Object.keys(input.context).length ? { context: input.context } : {}),
  };
  const dir = join(input.appDataDir, 'voc');
  mkdirSync(dir, { recursive: true });
  const name = vocFileName(record);
  let file = name;
  // 같은 분·같은 요소에 두 번 남겨도 덮어쓰지 않는다. 남아 있는 첨부 폴더와도 겹치지 않게 한다.
  for (let n = 2; existsSync(join(dir, file)) || existsSync(vocAttachmentDir(input.appDataDir, file)); n += 1) {
    file = name.replace(/\.json$/, `-${n}.json`);
  }
  const attachmentPaths: string[] = [];
  if (images.length) {
    const root = join(dir, VOC_ATTACHMENTS_DIR);
    mkdirSync(root, { recursive: true });
    const temp = join(root, `${TEMP_PREFIX}${randomUUID()}`);
    mkdirSync(temp, { mode: 0o700 });
    try {
      const metas: VocAttachmentMeta[] = [];
      images.forEach((image, index) => {
        const meta = inspected[index]!;
        const fileName = `${index + 1}.${vocImageExtension(meta.mime)}`;
        writeFileSync(join(temp, fileName), image.bytes, { mode: 0o600, flag: 'wx' });
        metas.push({ file: `${VOC_ATTACHMENTS_DIR}/${file.replace(/\.json$/, '')}/${fileName}`, mime: meta.mime, bytes: image.bytes.byteLength, sha256: meta.sha256 });
      });
      const finalDir = vocAttachmentDir(input.appDataDir, file);
      renameSync(temp, finalDir);
      for (const meta of metas) attachmentPaths.push(join(dir, meta.file));
      record.attachments = metas;
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      throw error;
    }
  }
  const path = join(dir, file);
  try {
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    // JSON이 없으면 VOC도 없다 — 방금 옮긴 첨부를 남기지 않는다.
    if (images.length) rmSync(vocAttachmentDir(input.appDataDir, file), { recursive: true, force: true });
    throw error;
  }
  return { file, id: record.id, attachmentPaths, record, path };
}

/** 첨부 절대경로 목록 (목록 API·워크룸 프롬프트용). 폴더 밖을 가리키는 기록은 무시한다. */
export function vocAttachmentPaths(appDataDir: string, vocFile: string, record: { attachments?: unknown }): string[] {
  if (!Array.isArray(record.attachments) || !isPendingVocFileName(vocFile)) return [];
  const prefix = `${VOC_ATTACHMENTS_DIR}/${vocFile.replace(/\.json$/, '')}/`;
  return record.attachments
    .map(item => (item && typeof item === 'object' ? (item as { file?: unknown }).file : null))
    .filter((f): f is string => typeof f === 'string' && f.startsWith(prefix) && /^[0-9]{1,2}\.(jpg|png|webp)$/.test(f.slice(prefix.length)))
    .map(f => join(appDataDir, 'voc', f))
    .filter(p => existsSync(p));
}

/** VOC 하나의 첨부 폴더를 지운다(없으면 아무 일도 하지 않는다). 심볼릭 링크는 따라가지 않는다. */
export function deleteVocAttachments(appDataDir: string, vocFile: string): void {
  const dir = vocAttachmentDir(appDataDir, vocFile);
  if (!existsSync(dir)) return;
  if (lstatSync(dir).isSymbolicLink()) { rmSync(dir, { force: true }); return; }
  rmSync(dir, { recursive: true, force: true });
}

/**
 * 처리 완료: JSON을 원본 이름 그대로 `voc/done/`으로 옮기고 그 VOC의 사진을 지운다.
 * 사진은 처리할 때까지만 필요하다는 약속이 여기서 지켜진다.
 */
export function completeVoc(appDataDir: string, vocFile: string, pendingPath: string): { doneFile: string } {
  const doneDir = join(appDataDir, 'voc', 'done');
  mkdirSync(doneDir, { recursive: true });
  let target = join(doneDir, vocFile);
  for (let n = 2; existsSync(target); n += 1) target = join(doneDir, vocFile.replace(/\.json$/, `-${n}.json`));
  renameSync(pendingPath, target);
  deleteVocAttachments(appDataDir, vocFile);
  return { doneFile: target.slice(doneDir.length + 1) };
}

/**
 * 주인 없는 첨부를 정리한다: 최상위에 같은 이름의 JSON이 없는 첨부 폴더(=처리됐거나 지워진 VOC)와
 * 오래된 임시 폴더. AI가 API 대신 파일을 직접 done/으로 옮겨도 사진은 여기서 지워진다.
 */
export function sweepVocAttachments(appDataDir: string, now = Date.now()): { removed: string[] } {
  const root = join(appDataDir, 'voc', VOC_ATTACHMENTS_DIR);
  const removed: string[] = [];
  if (!existsSync(root)) return { removed };
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (name.startsWith(TEMP_PREFIX)) {
      let age = Infinity;
      try { age = now - statSync(full).mtimeMs; } catch { /* 사라졌으면 그만 */ }
      if (age > TEMP_MAX_AGE_MS) { rmSync(full, { recursive: true, force: true }); removed.push(name); }
      continue;
    }
    if (!existsSync(join(appDataDir, 'voc', `${name}.json`))) {
      rmSync(full, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return { removed };
}
