import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireOwnedFileLock, portalFileLockOwnerProcessAlive, type OwnedFileLockRelease } from './portalFileLock';
import { PROMPT_GUIDES_LOCK } from './promptGuideStore';
import {
  createProductionPromptGuideKeyProvider, promptGuideDirectory, readPromptGuideFile,
  syncPromptGuideDirectory, PromptGuideError, type PromptGuideKeyProvider,
} from './promptGuideKeyProvider';
import { assertReadToolJson } from './readToolBundle';
import { parseWorkPackDefinition, inspectWorkPackDefinition, type WorkPackDefinition, type WorkPackGuideSource } from './workPack';

export const WORK_PACKS_FILE = 'work-packs.v1.enc';
export const WORK_PACKS_BACKUP = WORK_PACKS_FILE + '.bak';
export const WORK_PACKS_EVIDENCE = 'work-packs.v1.initialized';
export const WORK_PACKS_MAX_BYTES = 256 * 1024;
export const WORK_PACKS_MAX_DEFINITIONS = 100;
export const WORK_PACKS_MAX_DEFINITION_BYTES = 16 * 1024;
export const WORK_PACKS_KEY_NAMESPACE = Object.freeze({
  keychainService: 'com.portmanager.portmanager.work-packs.v1',
  keychainAccount: 'user-work-packs-v1', dpapiFile: 'work-packs.v1.key.dpapi',
  dpapiEntropy: 'agentstoz-work-packs-key-v1',
});
// The disk envelope and plaintext are both bounded; base64 overhead reduces usable payload capacity.
const MAX_ENVELOPE_BYTES = WORK_PACKS_MAX_BYTES;
const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type WorkPackSourceBinding = WorkPackDefinition['source'];
export type WorkPackCurrentSource = WorkPackGuideSource;
/** Reader must prove current incarnation/provenance; guide ID and body equality alone cannot prove absence of reimport. */
export type WorkPackSourceReader = (source: WorkPackSourceBinding) => Promise<WorkPackCurrentSource>;
export interface WorkPackSnapshot { revision: string; definitions: WorkPackDefinition[] }
export interface WorkPackSave {
  expectedRevision: string;
  /** Null means no definition for this exact library/account/guide exists. */
  expectedDefinitionRevision: string | null;
  definition: WorkPackDefinition;
}
export class WorkPackStoreError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'WorkPackStoreError'; }
}
function fail(code: string): never { throw new WorkPackStoreError(code); }
function fixedError(error: unknown): never {
  if (error instanceof WorkPackStoreError) throw error;
  if (error instanceof PromptGuideError) fail(error.code.replace(/^PROMPT_GUIDES_/, 'WORK_PACKS_'));
  fail('WORK_PACKS_UNAVAILABLE');
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) fail('WORK_PACKS_INVALID_INPUT');
  return value as Record<string, unknown>;
}
function scope(source: WorkPackSourceBinding): string { return JSON.stringify([source.sourceLibraryId, source.accountId, source.guideId]); }
function definition(value: unknown): WorkPackDefinition {
  try {
    assertReadToolJson(value, WORK_PACKS_MAX_DEFINITION_BYTES);
    const parsed = parseWorkPackDefinition(value);
    if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > WORK_PACKS_MAX_DEFINITION_BYTES) fail('WORK_PACKS_LIMIT_EXCEEDED');
    return parsed;
  } catch (error) {
    if (error instanceof WorkPackStoreError) throw error;
    if ((error as { code?: string })?.code === 'READ_TOOL_LIMIT') fail('WORK_PACKS_LIMIT_EXCEEDED');
    fail('WORK_PACKS_INVALID_INPUT');
  }
}
function definitions(value: unknown): WorkPackDefinition[] {
  if (!Array.isArray(value) || value.length > WORK_PACKS_MAX_DEFINITIONS) fail('WORK_PACKS_LIMIT_EXCEEDED');
  const parsed = value.map(definition), identities = new Set<string>();
  for (const item of parsed) { const identity = scope(item.source); if (identities.has(identity)) fail('WORK_PACKS_INVALID_INPUT'); identities.add(identity); }
  if (Buffer.byteLength(JSON.stringify({ definitions: parsed }), 'utf8') > WORK_PACKS_MAX_BYTES) fail('WORK_PACKS_LIMIT_EXCEEDED');
  return parsed;
}
function validRevision(value: unknown): value is string { return typeof value === 'string' && (value === '0' || REVISION.test(value)); }
function keyIsValid(key: Buffer | null): asserts key is Buffer {
  if (!key) fail('WORK_PACKS_KEY_MISSING');
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('WORK_PACKS_KEY_MALFORMED');
}
function aad(revision: string): Buffer { return Buffer.from(`agentstoz-work-packs-v1\0${revision}`, 'utf8'); }
function binary(value: unknown, max: number, length?: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('WORK_PACKS_CORRUPT');
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value || result.length > max || (length !== undefined && result.length !== length)) fail('WORK_PACKS_CORRUPT');
  return result;
}
function decrypt(bytes: Buffer, key: Buffer): WorkPackSnapshot {
  let plaintext: Buffer | undefined;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (parsed && Number.isInteger(parsed.schemaVersion) && parsed.schemaVersion > 1) fail('WORK_PACKS_SCHEMA_UNSUPPORTED');
    const envelope = exact(parsed, ['schemaVersion', 'revision', 'nonce', 'ciphertext', 'tag']);
    if (envelope.schemaVersion !== 1 || !validRevision(envelope.revision) || envelope.revision === '0') fail('WORK_PACKS_CORRUPT');
    const cipher = createDecipheriv('aes-256-gcm', key, binary(envelope.nonce, 12, 12));
    cipher.setAAD(aad(envelope.revision)); cipher.setAuthTag(binary(envelope.tag, 16, 16));
    plaintext = Buffer.concat([cipher.update(binary(envelope.ciphertext, WORK_PACKS_MAX_BYTES)), cipher.final()]);
    const payload = exact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)), ['definitions']);
    return { revision: envelope.revision, definitions: definitions(payload.definitions) };
  } catch (error) {
    if (error instanceof WorkPackStoreError && error.code === 'WORK_PACKS_SCHEMA_UNSUPPORTED') throw error;
    return fail('WORK_PACKS_CORRUPT');
  } finally { plaintext?.fill(0); }
}
function encrypt(snapshot: WorkPackSnapshot, key: Buffer): Buffer {
  const plaintext = Buffer.from(JSON.stringify({ definitions: snapshot.definitions }), 'utf8');
  try {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(snapshot.revision));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({ schemaVersion: 1, revision: snapshot.revision, nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }) + '\n');
  } finally { plaintext.fill(0); }
}
function privatePath(path: string, directory = false): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
    || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0
      || (typeof process.geteuid === 'function' && info.uid !== process.geteuid())))) fail('WORK_PACKS_PATH_UNSAFE');
}
function readFile(directory: string, name: string): Buffer | null {
  const bytes = readPromptGuideFile(join(directory, name), MAX_ENVELOPE_BYTES);
  if (bytes) privatePath(join(directory, name));
  return bytes;
}
function hasEvidence(directory: string): boolean {
  return readdirSync(directory).some(name => name === WORK_PACKS_BACKUP || name === WORK_PACKS_EVIDENCE
    || name === WORK_PACKS_KEY_NAMESPACE.dpapiFile || name.startsWith(WORK_PACKS_FILE + '.tmp-')
    || name.startsWith(WORK_PACKS_BACKUP + '.tmp-') || name.startsWith(WORK_PACKS_EVIDENCE + '.tmp-'));
}
/** Same private-temp/fsync/rename/directory-fsync pattern as PromptGuideStore; its helper is deliberately private. */
function atomicWrite(directory: string, name: string, bytes: Buffer, commit = false): void {
  readFile(directory, name);
  const path = join(directory, name), temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined, owner: { dev: number; ino: number } | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const info = fstatSync(fd); owner = { dev: info.dev, ino: info.ino };
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    try { syncPromptGuideDirectory(directory); } catch (error) { if (commit) fail('WORK_PACKS_RESULT_UNCERTAIN'); throw error; }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (owner) try { const info = lstatSync(temporary); if (info.isFile() && !info.isSymbolicLink() && info.dev === owner.dev && info.ino === owner.ino) unlinkSync(temporary); } catch {}
  }
}
function canRecoverOwner(directory: string, owner: string): boolean {
  if (!/^v3:[1-9][0-9]{0,9}:[0-9a-f]{32}:guarded$/.test(owner) || portalFileLockOwnerProcessAlive(owner)) return false;
  try {
    privatePath(directory, true);
    const artifacts = readdirSync(directory).filter(name => /^(prompt-guides|work-packs)\.v1\./.test(name));
    if (artifacts.length > 512) return false;
    for (const name of artifacts) {
      privatePath(join(directory, name));
      if (lstatSync(join(directory, name)).size > (name.includes('.coordinator-v1.sqlite') ? 8 * 1024 * 1024 : 2 * 1024 * 1024)) return false;
    }
    return true;
  } catch { return false; }
}

/** Local-only metadata. Never writes a guide, shared library, transcript, or source lifecycle record. */
export class WorkPackStore {
  readonly #keys: PromptGuideKeyProvider;
  constructor(readonly options: { appDataDir: string; sourceReader: WorkPackSourceReader; keyProvider?: PromptGuideKeyProvider }) {
    this.#keys = options.keyProvider ?? createProductionPromptGuideKeyProvider({ appDataDir: options.appDataDir, namespace: WORK_PACKS_KEY_NAMESPACE });
  }
  async #load(directory: string, retainKey = false): Promise<{ snapshot: WorkPackSnapshot; bytes: Buffer | null; key?: Buffer }> {
    privatePath(directory, true);
    const bytes = readFile(directory, WORK_PACKS_FILE);
    if (!bytes) {
      if (hasEvidence(directory)) fail('WORK_PACKS_RECOVERY_REQUIRED');
      return { snapshot: { revision: '0', definitions: [] }, bytes: null };
    }
    const key = await this.#keys.read(); let retained = false;
    try { keyIsValid(key); const snapshot = decrypt(bytes, key); retained = retainKey; return { snapshot, bytes, ...(retainKey ? { key } : {}) }; }
    finally { if (!retained) key?.fill(0); }
  }
  async read(): Promise<WorkPackSnapshot> {
    try { const directory = promptGuideDirectory(this.options.appDataDir); return directory ? (await this.#load(directory)).snapshot : { revision: '0', definitions: [] }; }
    catch (error) { return fixedError(error); }
  }
  /** Admission/execute callers must call again immediately before using a reviewed definition. No source mutation. */
  async readBound(source: WorkPackSourceBinding) {
    try {
      const snapshot = await this.read();
      const found = snapshot.definitions.find(item => scope(item.source) === scope(source));
      if (!found) return { revision: snapshot.revision, definition: null, inspection: null };
      const current = await this.options.sourceReader(structuredClone(source));
      return { revision: snapshot.revision, definition: found, inspection: inspectWorkPackDefinition(found, current) };
    } catch (error) { return fixedError(error); }
  }
  async save(value: WorkPackSave): Promise<WorkPackSnapshot> {
    try { assertReadToolJson(value, WORK_PACKS_MAX_DEFINITION_BYTES + 1024); }
    catch (error) { fail((error as { code?: string })?.code === 'READ_TOOL_LIMIT' ? 'WORK_PACKS_LIMIT_EXCEEDED' : 'WORK_PACKS_INVALID_INPUT'); }
    const row = exact(value, ['expectedRevision', 'expectedDefinitionRevision', 'definition']);
    if (!validRevision(row.expectedRevision) || (row.expectedDefinitionRevision !== null && (typeof row.expectedDefinitionRevision !== 'string' || !row.expectedDefinitionRevision))) fail('WORK_PACKS_INVALID_INPUT');
    const input = { expectedRevision: row.expectedRevision, expectedDefinitionRevision: row.expectedDefinitionRevision, definition: definition(row.definition) };
    let release: OwnedFileLockRelease | undefined, key: Buffer | null = null;
    try {
      const directory = promptGuideDirectory(this.options.appDataDir, true)!; privatePath(directory, true);
      let recoveryDenied = false;
      try { release = await acquireOwnedFileLock(join(directory, PROMPT_GUIDES_LOCK), { label: 'work-packs', deadOwnerRecoveryClass: 'guarded',
        canRecoverDeadOwner(owner) { const safe = canRecoverOwner(directory, owner); if (!safe) recoveryDenied = true; return safe; } }); }
      catch (error) { if (recoveryDenied || (error as { code?: string })?.code === 'FILE_LOCK_RECOVERY_REQUIRED') fail('WORK_PACKS_RECOVERY_REQUIRED'); fail('WORK_PACKS_LOCKED'); }
      const current = await this.#load(directory, true); key = current.key ?? null;
      if (current.snapshot.revision !== input.expectedRevision) fail('WORK_PACKS_CONFLICT');
      const index = current.snapshot.definitions.findIndex(item => scope(item.source) === scope(input.definition.source));
      const existing = index < 0 ? null : current.snapshot.definitions[index]!;
      if ((existing?.definitionRevision ?? null) !== input.expectedDefinitionRevision) fail('WORK_PACKS_CONFLICT');
      // Resolve inside the local guide lock, using exact external library revision for shared sources.
      const live = await this.options.sourceReader(structuredClone(input.definition.source));
      const source = input.definition.source;
      if (live.libraryRevision !== source.libraryRevision || live.sourceLibraryId !== source.sourceLibraryId || live.accountId !== source.accountId
        || live.guideId !== source.guideId || live.commandBodyHash !== source.commandBodyHash || live.sourceRevision !== source.sourceRevision) fail('WORK_PACKS_SOURCE_CONFLICT');
      const inspection = inspectWorkPackDefinition(input.definition, live);
      if (!['draft', 'reviewed', 'disabled'].includes(inspection.state)) fail('WORK_PACKS_SOURCE_CONFLICT');
      if (existing && JSON.stringify(existing) === JSON.stringify(input.definition)) {
        try { syncPromptGuideDirectory(directory); } catch { fail('WORK_PACKS_RESULT_UNCERTAIN'); }
        return current.snapshot;
      }
      if (existing?.definitionRevision === input.definition.definitionRevision) fail('WORK_PACKS_CONFLICT');
      const nextDefinitions = [...current.snapshot.definitions];
      if (index < 0) nextDefinitions.push(input.definition); else nextDefinitions[index] = input.definition;
      const next: WorkPackSnapshot = { revision: randomUUID(), definitions: definitions(nextDefinitions) };
      if (!key) key = await this.#keys.read();
      if (!key && current.bytes !== null) fail('WORK_PACKS_KEY_MISSING');
      if (!key) key = await this.#keys.create(); keyIsValid(key);
      const encrypted = encrypt(next, key);
      if (encrypted.length > MAX_ENVELOPE_BYTES) fail('WORK_PACKS_LIMIT_EXCEEDED');
      // Keychain/DPAPI can await. Shared sources are outside this lock: revalidate, never claim a two-store transaction.
      const latest = await this.options.sourceReader(structuredClone(source));
      if (['sourceLibraryId', 'accountId', 'libraryRevision', 'guideId', 'commandBodyHash', 'sourceRevision', 'kind', 'presence', 'virtual', 'provenance', 'supported']
        .some(field => latest[field as keyof WorkPackCurrentSource] !== live[field as keyof WorkPackCurrentSource])) fail('WORK_PACKS_SOURCE_CONFLICT');
      inspectWorkPackDefinition(input.definition, latest);
      if (!release.refresh()) fail('WORK_PACKS_LOCK_LOST');
      // Initialization evidence prevents partial first writes from being mistaken for a fresh store.
      if (!current.bytes) atomicWrite(directory, WORK_PACKS_EVIDENCE, Buffer.from('work-packs-initialized-v1\n'));
      if (current.bytes) atomicWrite(directory, WORK_PACKS_BACKUP, current.bytes);
      atomicWrite(directory, WORK_PACKS_FILE, encrypted, true); return next;
    } catch (error) { return fixedError(error); }
    finally { key?.fill(0); if (release) try { release(); } catch {} }
  }
}
