import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireOwnedFileLock, portalFileLockOwnerProcessAlive, type OwnedFileLockRelease } from './portalFileLock';
import {
  createProductionPromptGuideKeyProvider, promptGuideDirectory, readPromptGuideFile,
  PromptGuideError, syncPromptGuideDirectory, type PromptGuideKeyProvider,
} from './promptGuideKeyProvider';
import {
  normalizeUserProfileSave, normalizeUserProfileSnapshot, normalizeUserProfileRecallRequest, selectUserProfileRecall,
  UserProfileError, type UserProfileSave, type UserProfileSnapshot, type UserProfileRecall, type UserProfileRecallRequest,
} from './userProfileContract';
export { UserProfileError } from './userProfileContract';

export const USER_PROFILE_FILE = 'user-profile.v1.enc';
export const USER_PROFILE_BACKUP = USER_PROFILE_FILE + '.bak';
export const USER_PROFILE_EVIDENCE = 'user-profile.v1.initialized';
export const USER_PROFILE_LOCK = 'user-profile.v1.lock';
export const USER_PROFILE_KEY_NAMESPACE = Object.freeze({
  keychainService: 'com.portmanager.portmanager.user-profile.v1', keychainAccount: 'user-profile-v1',
  dpapiFile: 'user-profile.v1.key.dpapi', dpapiEntropy: 'agentstoz-user-profile-v1',
});
// Covers the bounded 64 entries, including JSON escaping, without a growing history.
const MAX_PLAINTEXT_BYTES = 768 * 1024;
const MAX_ENVELOPE_BYTES = Math.ceil(MAX_PLAINTEXT_BYTES * 4 / 3) + 1024;
const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fail(code: string): never { throw new UserProfileError(code); }
function rethrow(error: unknown): never {
  if (error instanceof UserProfileError) throw error;
  if (error instanceof PromptGuideError && /^PROMPT_GUIDES_(PATH_UNSAFE|FILE_TOO_LARGE|KEY_MISSING|KEY_MALFORMED|KEY_UNAVAILABLE|KEY_UNSUPPORTED)$/.test(error.code)) {
    fail(error.code.replace('PROMPT_GUIDES_', 'USER_PROFILE_'));
  }
  fail('USER_PROFILE_UNAVAILABLE');
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) fail('USER_PROFILE_CORRUPT');
  return value as Record<string, unknown>;
}
function keyIsValid(key: Buffer | null): asserts key is Buffer {
  if (!key) fail('USER_PROFILE_KEY_MISSING');
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('USER_PROFILE_KEY_MALFORMED');
}
function binary(value: unknown, max: number, length?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length > Math.ceil(max * 4 / 3) + 4) fail('USER_PROFILE_CORRUPT');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value || buffer.length > max || (length !== undefined && buffer.length !== length)) fail('USER_PROFILE_CORRUPT');
  return buffer;
}
const aad = (revision: string) => Buffer.from(`agentstoz-user-profile-v1\0${revision}`, 'utf8');
function decrypt(bytes: Buffer, key: Buffer): UserProfileSnapshot {
  let plaintext: Buffer | undefined;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.schemaVersion) && parsed.schemaVersion > 1) fail('USER_PROFILE_SCHEMA_UNSUPPORTED');
    const envelope = exact(parsed, ['schemaVersion', 'revision', 'nonce', 'ciphertext', 'tag']);
    if (envelope.schemaVersion !== 1 || typeof envelope.revision !== 'string' || !REVISION.test(envelope.revision)) fail('USER_PROFILE_CORRUPT');
    const cipher = createDecipheriv('aes-256-gcm', key, binary(envelope.nonce, 12, 12));
    cipher.setAAD(aad(envelope.revision));
    cipher.setAuthTag(binary(envelope.tag, 16, 16));
    plaintext = Buffer.concat([cipher.update(binary(envelope.ciphertext, MAX_PLAINTEXT_BYTES)), cipher.final()]);
    const payload = exact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)), ['entries']);
    return normalizeUserProfileSnapshot({ revision: envelope.revision, entries: payload.entries });
  } catch (error) {
    if (error instanceof UserProfileError && error.code === 'USER_PROFILE_SCHEMA_UNSUPPORTED') throw error;
    return fail('USER_PROFILE_CORRUPT');
  } finally { plaintext?.fill(0); }
}
function encrypt(snapshot: UserProfileSnapshot, key: Buffer): Buffer {
  const plaintext = Buffer.from(JSON.stringify({ entries: snapshot.entries }), 'utf8');
  try {
    if (plaintext.length > MAX_PLAINTEXT_BYTES) fail('USER_PROFILE_LIMIT_EXCEEDED');
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(snapshot.revision));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({ schemaVersion: 1, revision: snapshot.revision, nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }) + '\n');
  } finally { plaintext.fill(0); }
}
function relevant(name: string): boolean {
  return name === USER_PROFILE_FILE || name === USER_PROFILE_BACKUP || name === USER_PROFILE_EVIDENCE
    || name === USER_PROFILE_KEY_NAMESPACE.dpapiFile || name === USER_PROFILE_LOCK
    || [USER_PROFILE_FILE, USER_PROFILE_BACKUP, USER_PROFILE_EVIDENCE].some(prefix => name.startsWith(prefix + '.tmp-'))
    || name.startsWith(USER_PROFILE_LOCK + '.coordinator-v1.sqlite');
}
function hasEvidence(directory: string): boolean {
  return readdirSync(directory).some(name => relevant(name) && name !== USER_PROFILE_FILE && name !== USER_PROFILE_LOCK
    && !name.startsWith(USER_PROFILE_LOCK + '.coordinator-v1.sqlite'));
}
function canRecoverOwner(directory: string, owner: string): boolean {
  if (!/^v3:[1-9][0-9]{0,9}:[0-9a-f]{32}:guarded$/.test(owner) || portalFileLockOwnerProcessAlive(owner)) return false;
  try {
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
      || (process.platform !== 'win32' && typeof process.geteuid === 'function' && directoryInfo.uid !== process.geteuid())) return false;
    let count = 0;
    for (const name of readdirSync(directory).filter(relevant)) {
      if (++count > 512) return false;
      const info = lstatSync(join(directory, name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || (process.platform !== 'win32' && ((typeof process.geteuid === 'function' && info.uid !== process.geteuid()) || (info.mode & 0o022) !== 0))
        || info.size > (name.startsWith(USER_PROFILE_LOCK + '.coordinator-v1.sqlite') ? 8 * 1024 * 1024 : MAX_ENVELOPE_BYTES)) return false;
    }
    return true;
  } catch { return false; }
}
function atomicWrite(directory: string, name: string, bytes: Buffer, commit = false): void {
  const path = join(directory, name);
  readPromptGuideFile(path, MAX_ENVELOPE_BYTES);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined, owner: { dev: number; ino: number } | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const info = fstatSync(fd); owner = { dev: info.dev, ino: info.ino };
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    try { syncPromptGuideDirectory(directory); }
    catch (error) { if (commit) fail('USER_PROFILE_RESULT_UNCERTAIN'); throw error; }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (owner) {
      try { const info = lstatSync(temporary); if (info.isFile() && !info.isSymbolicLink() && info.dev === owner.dev && info.ino === owner.ino) unlinkSync(temporary); } catch {}
    }
  }
}

/** One local encrypted profile. No raw history, cloud, AI, collection or common-memory linkage. */
export class UserProfileStore {
  readonly #keys: PromptGuideKeyProvider;
  constructor(readonly options: {
    appDataDir: string;
    keyProvider?: PromptGuideKeyProvider;
    /** Host revalidates current registered project scopes after credential awaits, before any data commit. */
    beforeCommit?: (save: UserProfileSave) => Promise<void>;
  }) {
    this.#keys = options.keyProvider ?? createProductionPromptGuideKeyProvider({ appDataDir: options.appDataDir, namespace: USER_PROFILE_KEY_NAMESPACE });
  }
  async #load(directory: string, retainKey = false): Promise<{ snapshot: UserProfileSnapshot; bytes: Buffer | null; key?: Buffer }> {
    const bytes = readPromptGuideFile(join(directory, USER_PROFILE_FILE), MAX_ENVELOPE_BYTES);
    if (!bytes) {
      if (hasEvidence(directory)) fail('USER_PROFILE_RECOVERY_REQUIRED');
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
  async read(): Promise<UserProfileSnapshot> {
    try {
      const directory = promptGuideDirectory(this.options.appDataDir);
      return directory ? (await this.#load(directory)).snapshot : { revision: '0', entries: [] };
    } catch (error) { return rethrow(error); }
  }
  async recall(request: UserProfileRecallRequest): Promise<UserProfileRecall> {
    const input = normalizeUserProfileRecallRequest(request);
    return selectUserProfileRecall(await this.read(), input);
  }
  async save(value: unknown): Promise<UserProfileSnapshot> {
    const input = normalizeUserProfileSave(value);
    let release: OwnedFileLockRelease | undefined, key: Buffer | null = null;
    try {
      const directory = promptGuideDirectory(this.options.appDataDir, true)!;
      let recoveryDenied = false;
      try {
        release = await acquireOwnedFileLock(join(directory, USER_PROFILE_LOCK), {
          label: 'user-profile', deadOwnerRecoveryClass: 'guarded',
          canRecoverDeadOwner(owner) { const safe = canRecoverOwner(directory, owner); if (!safe) recoveryDenied = true; return safe; },
        });
      } catch (error) {
        if (recoveryDenied || (error as { code?: string })?.code === 'FILE_LOCK_RECOVERY_REQUIRED') fail('USER_PROFILE_RECOVERY_REQUIRED');
        fail('USER_PROFILE_LOCKED');
      }
      const current = await this.#load(directory, true);
      key = current.key ?? null;
      if (current.snapshot.revision !== input.expectedRevision) fail('USER_PROFILE_CONFLICT');
      if (JSON.stringify(current.snapshot.entries) === JSON.stringify(input.entries)) {
        if (current.bytes) { try { syncPromptGuideDirectory(directory); } catch { fail('USER_PROFILE_RESULT_UNCERTAIN'); } }
        return current.snapshot;
      }
      if (!key) key = await this.#keys.read();
      if (!key && current.bytes !== null) fail('USER_PROFILE_KEY_MISSING');
      if (!key) key = await this.#keys.create();
      keyIsValid(key);
      const next: UserProfileSnapshot = { revision: randomUUID(), entries: input.entries };
      const encrypted = encrypt(next, key);
      // Detach the hook argument so even a host callback cannot mutate the validated data being committed.
      await this.options.beforeCommit?.(normalizeUserProfileSave(input));
      if (!release.refresh()) fail('USER_PROFILE_LOCK_LOST');
      if (current.bytes === null) atomicWrite(directory, USER_PROFILE_EVIDENCE, Buffer.from('user-profile-initialized-v1\n'));
      if (current.bytes !== null) atomicWrite(directory, USER_PROFILE_BACKUP, current.bytes);
      atomicWrite(directory, USER_PROFILE_FILE, encrypted, true);
      return next;
    } catch (error) { return rethrow(error); }
    finally { key?.fill(0); if (release) { try { release(); } catch {} } }
  }
}
