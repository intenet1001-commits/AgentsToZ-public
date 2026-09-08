import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, fstatSync, linkSync, mkdirSync,
  openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MEMORY_DOCUMENT_PENDING = '.agent-memory/backups/.pending-document-write.json';
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 128;

export interface MemoryDocumentRecoveryStatus {
  state: 'none' | 'ready' | 'conflict' | 'invalid';
  transactionId: string | null;
  fileCount: number;
  appliedFiles: number;
}
export interface MemoryDocumentContext {
  root: string;
  memoryId: string | null;
  primaryPath: string;
  sessionState?: boolean;
  /** Resolves a project-relative path and rejects every symlink component. */
  safePath(relativePath: string): string;
}
interface Entry { path: string; before: string | null; after: string | null }
export interface MemoryDocumentManifest { version: 1; id: string; root: string; memoryId: string | null; primaryPath: string; entries: Entry[] }

export class MemoryDocumentRecoveryError extends Error {
  readonly code = 'PROJECT_MEMORY_DOCUMENT_RECOVERY_REQUIRED';
  constructor(message = '중단된 기억 문서 저장을 먼저 복구해야 합니다.') { super(message); }
}
function hash(text: string | null): string | null {
  return text === null ? null : createHash('sha256').update(text).digest('hex');
}
function allowed(context: MemoryDocumentContext, path: string): boolean {
  return (context.sessionState === true && ['.agent-memory/config.json', '.agent-memory/state.json'].includes(path)) || path === context.primaryPath || path === '.agent-memory/notes/manifest.json'
    || /^\.agent-memory\/notes\/[^/\\\x00]+\.md$/u.test(path);
}
function readBounded(path: string, max = MAX_FILE_BYTES): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > max) throw new MemoryDocumentRecoveryError('기억 복구 파일의 형식 또는 크기가 올바르지 않습니다.');
    const buffer = Buffer.alloc(info.size + 1);
    let size = 0, count = 0;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    const bytes = buffer.subarray(0, size);
    if (size !== info.size || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new MemoryDocumentRecoveryError();
    return bytes.toString('utf8');
  } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  // Windows does not support opening a directory with these POSIX flags.
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableWrite(context: MemoryDocumentContext, relative: string, content: string, exclusive = false): void {
  const target = context.safePath(relative);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  for (let directory = dirname(target); ; directory = dirname(directory)) {
    syncDirectory(directory);
    if (directory === context.root) break;
    if (dirname(directory) === directory) throw new MemoryDocumentRecoveryError();
  }
  const temporary = context.safePath(`${relative}.tmp-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    context.safePath(relative);
    if (exclusive) linkSync(temporary, target); // Publish complete evidence without replacing another writer's manifest.
    else renameSync(temporary, target);
    syncDirectory(dirname(target));
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function load(context: MemoryDocumentContext): MemoryDocumentManifest | null {
  const text = readBounded(context.safePath(MEMORY_DOCUMENT_PENDING), MAX_BYTES);
  if (text === null) return null;
  return validateManifest(context, JSON.parse(text));
}
function validateManifest(context: MemoryDocumentContext, manifest: MemoryDocumentManifest): MemoryDocumentManifest {
  if (!manifest || Buffer.byteLength(JSON.stringify(manifest)) > MAX_BYTES) throw new MemoryDocumentRecoveryError();

  if (manifest.version !== 1 || !/^[0-9a-f-]{36}$/u.test(manifest.id)
    || manifest.root !== context.root || manifest.memoryId !== context.memoryId
    || manifest.primaryPath !== context.primaryPath || !Array.isArray(manifest.entries)
    || manifest.entries.length < 1 || manifest.entries.length > MAX_FILES) throw new MemoryDocumentRecoveryError();
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    if (typeof entry.path !== 'string' || !allowed(context, entry.path) || seen.has(entry.path)
      || ![entry.before, entry.after].every(value => value === null || (typeof value === 'string' && Buffer.byteLength(value) <= MAX_FILE_BYTES))) {
      throw new MemoryDocumentRecoveryError();
    }
    context.safePath(entry.path); seen.add(entry.path);
  }
  return manifest;
}
function scan(context: MemoryDocumentContext, manifest: MemoryDocumentManifest): MemoryDocumentRecoveryStatus {
  let appliedFiles = 0, conflict = false;
  for (const entry of manifest.entries) {
    const actual = hash(readBounded(context.safePath(entry.path)));
    if (actual === hash(entry.after)) appliedFiles++;
    else if (actual !== hash(entry.before)) conflict = true;
  }
  return { state: conflict ? 'conflict' : 'ready', transactionId: manifest.id,
    fileCount: manifest.entries.length, appliedFiles };
}
export function memoryDocumentRecoveryStatus(context: MemoryDocumentContext): MemoryDocumentRecoveryStatus {
  try {
    const manifest = load(context);
    return manifest ? scan(context, manifest) : { state: 'none', transactionId: null, fileCount: 0, appliedFiles: 0 };
  } catch { return { state: 'invalid', transactionId: null, fileCount: 0, appliedFiles: 0 }; }
}
export function assertMemoryDocumentReady(context: MemoryDocumentContext): void {
  if (readBounded(context.safePath(MEMORY_DOCUMENT_PENDING), MAX_BYTES) !== null) throw new MemoryDocumentRecoveryError();
}
function apply(context: MemoryDocumentContext, manifest: MemoryDocumentManifest, afterFile?: (index: number) => void): void {
  if (scan(context, manifest).state !== 'ready') throw new MemoryDocumentRecoveryError('저장 이후 다른 수정이 발견되었습니다. 현재 파일과 복구 기록을 보존했습니다.');
  for (const [index, entry] of manifest.entries.entries()) {
    const current = hash(readBounded(context.safePath(entry.path)));
    if (current !== hash(entry.after)) {
      if (current !== hash(entry.before)) throw new MemoryDocumentRecoveryError('기억 파일이 복구 도중 변경되었습니다.');
      if (entry.after === null) {
        unlinkSync(context.safePath(entry.path)); syncDirectory(dirname(context.safePath(entry.path)));
      } else durableWrite(context, entry.path, entry.after);
    }
    afterFile?.(index);
  }
  if (scan(context, manifest).appliedFiles !== manifest.entries.length) throw new MemoryDocumentRecoveryError();
  const pending = load(context);
  if (!pending || JSON.stringify(pending) !== JSON.stringify(manifest)) throw new MemoryDocumentRecoveryError();
  unlinkSync(context.safePath(MEMORY_DOCUMENT_PENDING));
  syncDirectory(dirname(context.safePath(MEMORY_DOCUMENT_PENDING)));
}

export function prepareMemoryDocumentTransaction(context: MemoryDocumentContext,
  changes: { path: string; content: string | null }[]): MemoryDocumentManifest | null {
  assertMemoryDocumentReady(context);
  if (changes.length > MAX_FILES) throw new MemoryDocumentRecoveryError('한 번에 저장할 기억 파일 수 제한을 초과했습니다.');
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let size = 0;
  for (const change of changes) {
    if (!allowed(context, change.path) || seen.has(change.path)) throw new MemoryDocumentRecoveryError();
    seen.add(change.path);
    const before = readBounded(context.safePath(change.path));
    if (change.content !== null && Buffer.byteLength(change.content) > MAX_FILE_BYTES) throw new MemoryDocumentRecoveryError();
    size += Buffer.byteLength(before ?? '') + Buffer.byteLength(change.content ?? '');
    if (size > MAX_BYTES) throw new MemoryDocumentRecoveryError('기억 복구 기록의 크기 제한을 초과했습니다.');
    if (before !== change.content) entries.push({ path: change.path, before, after: change.content });
  }
  if (!entries.length) return null;
  const manifest: MemoryDocumentManifest = { version: 1, id: randomUUID(), root: context.root,
    memoryId: context.memoryId, primaryPath: context.primaryPath, entries };
  const text = JSON.stringify(manifest);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new MemoryDocumentRecoveryError();
  return manifest;
}

export function assertPreparedMemoryDocumentCompatible(context: MemoryDocumentContext, manifest: MemoryDocumentManifest | null): void {
  if (!manifest) return;
  validateManifest(context, manifest);
  if (scan(context, manifest).state !== 'ready') throw new MemoryDocumentRecoveryError('저장 대상에 다른 수정이 발견됐습니다.');
}

/** A host-owned manifest remains authoritative after the project marker disappears. */
export function applyPreparedMemoryDocumentTransaction(context: MemoryDocumentContext, manifest: MemoryDocumentManifest | null,
  options: { afterFile?: (index: number) => void } = {}): void {
  if (!manifest) { assertMemoryDocumentReady(context); return; }
  validateManifest(context, manifest);
  if (manifest.root !== context.root || manifest.memoryId !== context.memoryId || manifest.primaryPath !== context.primaryPath) throw new MemoryDocumentRecoveryError();
  const pending = load(context);
  if (pending && JSON.stringify(pending) !== JSON.stringify(manifest)) throw new MemoryDocumentRecoveryError();
  if (scan(context, manifest).state !== 'ready') throw new MemoryDocumentRecoveryError('기억 파일에 다른 수정이 발견됐습니다.');
  if (!pending) durableWrite(context, MEMORY_DOCUMENT_PENDING, JSON.stringify(manifest), true);
  apply(context, manifest, options.afterFile);
}

export function writeMemoryDocumentTransaction(context: MemoryDocumentContext, changes: { path: string; content: string | null }[],
  options: { afterFile?: (index: number) => void } = {}): void {
  applyPreparedMemoryDocumentTransaction(context, prepareMemoryDocumentTransaction(context, changes), options);
}

export function recoverMemoryDocumentTransaction(context: MemoryDocumentContext, expectedId: string): void {
  const manifest = load(context);
  if (!manifest || manifest.id !== expectedId) throw new MemoryDocumentRecoveryError('복구 대상이 변경되었습니다. 상태를 다시 확인하세요.');
  apply(context, manifest);
}
