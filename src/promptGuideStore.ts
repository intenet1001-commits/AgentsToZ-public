import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireOwnedFileLock, portalFileLockOwnerProcessAlive, type OwnedFileLockRelease } from './portalFileLock';
import {
  createProductionPromptGuideKeyProvider, promptGuideDirectory, readPromptGuideFile,
  PromptGuideError, PROMPT_GUIDES_DPAPI_FILE, type PromptGuideKeyProvider,
  syncPromptGuideDirectory,
} from './promptGuideKeyProvider';
export { PromptGuideError } from './promptGuideKeyProvider';

export const PROMPT_GUIDES_FILE = 'prompt-guides.v1.enc';
export const PROMPT_GUIDES_BACKUP = PROMPT_GUIDES_FILE + '.bak';
export const PROMPT_GUIDES_EVIDENCE = 'prompt-guides.v1.initialized';
export const PROMPT_GUIDES_LOCK = 'prompt-guides.v1.lock';
export const PROMPT_GUIDES_MAX_BYTES = 1024 * 1024;
const MAX_ENVELOPE_BYTES = Math.ceil(PROMPT_GUIDES_MAX_BYTES * 4 / 3) + 1024;
const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface PromptGuideEntry { id: string; title: string; body: string; pinned: boolean; updatedAt: string }
export interface PromptGuideSnapshot { revision: string; entries: PromptGuideEntry[] }
export interface PromptGuideSave { expectedRevision: string; entries: PromptGuideEntry[] }

function fail(code: string): never { throw new PromptGuideError(code); }
function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) fail('PROMPT_GUIDES_INVALID_INPUT');
  return value as Record<string, unknown>;
}
function entries(value: unknown): PromptGuideEntry[] {
  if (!Array.isArray(value) || value.length > 100) fail('PROMPT_GUIDES_INVALID_INPUT');
  const seen = new Set<string>();
  const result = value.map(item => {
    const row = exactObject(item, ['id', 'title', 'body', 'pinned', 'updatedAt']);
    if (typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.id) || seen.has(row.id)
      || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 120 || /[\x00-\x1f\x7f]/.test(row.title)
      || typeof row.body !== 'string' || !row.body.trim() || row.body.length > 16_384 || Buffer.byteLength(row.body, 'utf8') > 64 * 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(row.body)
      || typeof row.pinned !== 'boolean' || typeof row.updatedAt !== 'string'
      || !Number.isFinite(Date.parse(row.updatedAt)) || new Date(row.updatedAt).toISOString() !== row.updatedAt) fail('PROMPT_GUIDES_INVALID_INPUT');
    seen.add(row.id);
    return { id: row.id, title: row.title, body: row.body, pinned: row.pinned, updatedAt: row.updatedAt } as PromptGuideEntry;
  });
  if (Buffer.byteLength(JSON.stringify({ entries: result }), 'utf8') > PROMPT_GUIDES_MAX_BYTES) fail('PROMPT_GUIDES_LIMIT_EXCEEDED');
  return result;
}
export function normalizePromptGuideSave(value: unknown): PromptGuideSave {
  const input = exactObject(value, ['expectedRevision', 'entries']);
  if (typeof input.expectedRevision !== 'string' || (input.expectedRevision !== '0' && !REVISION.test(input.expectedRevision))) fail('PROMPT_GUIDES_INVALID_INPUT');
  return { expectedRevision: input.expectedRevision, entries: entries(input.entries) };
}
function aad(revision: string): Buffer { return Buffer.from(`agentstoz-prompt-guides-v1\0${revision}`, 'utf8'); }
function keyIsValid(key: Buffer | null): asserts key is Buffer {
  if (!key) fail('PROMPT_GUIDES_KEY_MISSING');
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('PROMPT_GUIDES_KEY_MALFORMED');
}
function binary(value: unknown, max: number, exact?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length > Math.ceil(max * 4 / 3) + 4) fail('PROMPT_GUIDES_CORRUPT');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length > max || (exact !== undefined && bytes.length !== exact)) fail('PROMPT_GUIDES_CORRUPT');
  return bytes;
}
function decrypt(bytes: Buffer, key: Buffer): PromptGuideSnapshot {
  let plaintext: Buffer | undefined;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.schemaVersion) && parsed.schemaVersion > 1) fail('PROMPT_GUIDES_SCHEMA_UNSUPPORTED');
    const envelope = exactObject(parsed, ['schemaVersion', 'revision', 'nonce', 'ciphertext', 'tag']);
    if (envelope.schemaVersion !== 1 || typeof envelope.revision !== 'string' || !REVISION.test(envelope.revision)) fail('PROMPT_GUIDES_CORRUPT');
    const cipher = createDecipheriv('aes-256-gcm', key, binary(envelope.nonce, 12, 12));
    cipher.setAAD(aad(envelope.revision));
    cipher.setAuthTag(binary(envelope.tag, 16, 16));
    plaintext = Buffer.concat([cipher.update(binary(envelope.ciphertext, PROMPT_GUIDES_MAX_BYTES)), cipher.final()]);
    const payload = exactObject(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)), ['entries']);
    return { revision: envelope.revision, entries: entries(payload.entries) };
  } catch (error) {
    if (error instanceof PromptGuideError && error.code === 'PROMPT_GUIDES_SCHEMA_UNSUPPORTED') throw error;
    return fail('PROMPT_GUIDES_CORRUPT');
  } finally { plaintext?.fill(0); }
}
function encrypt(snapshot: PromptGuideSnapshot, key: Buffer): Buffer {
  const plaintext = Buffer.from(JSON.stringify({ entries: snapshot.entries }), 'utf8');
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(snapshot.revision));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({ schemaVersion: 1, revision: snapshot.revision,
      nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }) + '\n');
  } finally { plaintext.fill(0); }
}

function hasEvidence(directory: string): boolean {
  // A partial initial write is not proof of a fresh installation. Keep all recovery evidence.
  return readdirSync(directory).some(name => name === PROMPT_GUIDES_BACKUP || name === PROMPT_GUIDES_EVIDENCE
    || name === PROMPT_GUIDES_DPAPI_FILE
    || name.startsWith(PROMPT_GUIDES_FILE + '.tmp-') || name.startsWith(PROMPT_GUIDES_BACKUP + '.tmp-')
    || name.startsWith(PROMPT_GUIDES_EVIDENCE + '.tmp-'));
}
function canRecoverGuideOwner(directory: string, owner: string): boolean {
  // Existing manual/legacy owners are not silently upgraded to this recovery policy.
  if (!/^v3:[1-9][0-9]{0,9}:[0-9a-f]{32}:guarded$/.test(owner) || portalFileLockOwnerProcessAlive(owner)) return false;
  let artifacts = 0;
  try {
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
      || (process.platform !== 'win32' && typeof process.geteuid === 'function' && directoryInfo.uid !== process.geteuid())) return false;
    for (const name of readdirSync(directory)) {
      const known = name === PROMPT_GUIDES_FILE || name === PROMPT_GUIDES_BACKUP || name === PROMPT_GUIDES_EVIDENCE
        || name === PROMPT_GUIDES_DPAPI_FILE || name === PROMPT_GUIDES_LOCK
        || name.startsWith(PROMPT_GUIDES_FILE + '.tmp-') || name.startsWith(PROMPT_GUIDES_BACKUP + '.tmp-')
        || name.startsWith(PROMPT_GUIDES_EVIDENCE + '.tmp-') || name.startsWith(PROMPT_GUIDES_LOCK + '.coordinator-v1.sqlite');
      if (!known) continue;
      if (++artifacts > 512) return false;
      const info = lstatSync(join(directory, name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || (process.platform !== 'win32' && ((typeof process.geteuid === 'function' && info.uid !== process.geteuid()) || (info.mode & 0o022) !== 0))) return false;
      const max = name.startsWith(PROMPT_GUIDES_LOCK + '.coordinator-v1.sqlite') ? 8 * 1024 * 1024 : MAX_ENVELOPE_BYTES;
      if (info.size > max) return false;
    }
    return true;
  } catch { return false; }
}
function atomicWrite(directory: string, name: string, bytes: Buffer, commit = false): void {
  const path = join(directory, name);
  // Validate the destination even though rename would replace, rather than follow, a symlink.
  readPromptGuideFile(path, MAX_ENVELOPE_BYTES);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  let owner: { dev: number; ino: number } | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const info = fstatSync(fd); owner = { dev: info.dev, ino: info.ino };
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    try { syncPromptGuideDirectory(directory); }
    catch (error) {
      // The new revision is already visible. Callers must reread, never assume a failed write.
      if (commit) fail('PROMPT_GUIDES_RESULT_UNCERTAIN');
      throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (owner) {
      try { const info = lstatSync(temporary); if (info.isFile() && !info.isSymbolicLink() && info.dev === owner.dev && info.ino === owner.ino) unlinkSync(temporary); } catch {}
    }
  }
}

/** Local user-authored guide authority. It never reads/transmits What I Said history. */
export class PromptGuideStore {
  readonly #keys: PromptGuideKeyProvider;
  constructor(readonly options: { appDataDir: string; keyProvider?: PromptGuideKeyProvider }) {
    this.#keys = options.keyProvider ?? createProductionPromptGuideKeyProvider({ appDataDir: options.appDataDir });
  }
  async #load(directory: string, retainKey = false): Promise<{ snapshot: PromptGuideSnapshot; bytes: Buffer | null; key?: Buffer }> {
    const bytes = readPromptGuideFile(join(directory, PROMPT_GUIDES_FILE), MAX_ENVELOPE_BYTES);
    if (!bytes) {
      if (hasEvidence(directory)) fail('PROMPT_GUIDES_RECOVERY_REQUIRED');
      return { snapshot: { revision: '0', entries: [] }, bytes: null };
    }
    const key = await this.#keys.read();
    let retained = false;
    try {
      keyIsValid(key);
      const snapshot = decrypt(bytes, key);
      retained = retainKey;
      return { snapshot, bytes, ...(retainKey ? { key } : {}) };
    } finally { if (!retained) key?.fill(0); }
  }
  async read(): Promise<PromptGuideSnapshot> {
    try {
      const directory = promptGuideDirectory(this.options.appDataDir);
      return directory ? (await this.#load(directory)).snapshot : { revision: '0', entries: [] };
    } catch (error) { if (error instanceof PromptGuideError) throw error; return fail('PROMPT_GUIDES_UNAVAILABLE'); }
  }
  async save(value: PromptGuideSave): Promise<PromptGuideSnapshot> {
    // Detach and validate user data before awaiting another writer or touching credentials.
    const input = normalizePromptGuideSave(value);
    let release: OwnedFileLockRelease | undefined;
    let key: Buffer | null = null;
    try {
      const directory = promptGuideDirectory(this.options.appDataDir, true)!;
      // The lock uses the same cross-process authority as existing app-data mutations.
      let recoveryDenied = false;
      try { release = await acquireOwnedFileLock(join(directory, PROMPT_GUIDES_LOCK), {
        label: 'prompt-guides', deadOwnerRecoveryClass: 'guarded',
        canRecoverDeadOwner(owner) {
          const safe = canRecoverGuideOwner(directory, owner);
          if (!safe) recoveryDenied = true;
          return safe;
        },
      }); }
      catch (error) {
        if (recoveryDenied || (error as { code?: string })?.code === 'FILE_LOCK_RECOVERY_REQUIRED') fail('PROMPT_GUIDES_RECOVERY_REQUIRED');
        fail('PROMPT_GUIDES_LOCKED');
      }
      const current = await this.#load(directory, true);
      key = current.key ?? null;
      if (current.snapshot.revision !== input.expectedRevision) fail('PROMPT_GUIDES_CONFLICT');
      if (JSON.stringify(current.snapshot.entries) === JSON.stringify(input.entries)) {
        // A retry can acknowledge a previous rename whose directory flush was uncertain.
        if (current.bytes) {
          try { syncPromptGuideDirectory(directory); }
          catch { fail('PROMPT_GUIDES_RESULT_UNCERTAIN'); }
        }
        return current.snapshot;
      }
      if (!key) key = await this.#keys.read();
      if (!key && current.bytes !== null) fail('PROMPT_GUIDES_KEY_MISSING');
      if (!key) key = await this.#keys.create();
      keyIsValid(key);
      const next: PromptGuideSnapshot = { revision: randomUUID(), entries: input.entries };
      const encrypted = encrypt(next, key);
      if (!release.refresh()) fail('PROMPT_GUIDES_LOCK_LOST');
      // Evidence precedes the first ciphertext commit. An interrupted initialization
      // cannot silently recreate an empty library on the next launch.
      if (current.bytes === null) atomicWrite(directory, PROMPT_GUIDES_EVIDENCE, Buffer.from('prompt-guides-initialized-v1\n'));
      if (current.bytes !== null) atomicWrite(directory, PROMPT_GUIDES_BACKUP, current.bytes);
      atomicWrite(directory, PROMPT_GUIDES_FILE, encrypted, true);
      // Final rename plus supported directory durability has been acknowledged.
      return next;
    } catch (error) { if (error instanceof PromptGuideError) throw error; return fail('PROMPT_GUIDES_UNAVAILABLE'); }
    finally { key?.fill(0); if (release) { try { release(); } catch {} } }
  }
}
