import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PromptGuideStore, PROMPT_GUIDES_FILE, PROMPT_GUIDES_BACKUP, PROMPT_GUIDES_EVIDENCE, PROMPT_GUIDES_LOCK,
  type PromptGuideEntry,
} from '../src/promptGuideStore';
import { __setPromptGuideDurabilityFaultForTests, PROMPT_GUIDES_DPAPI_FILE, type PromptGuideKeyProvider } from '../src/promptGuideKeyProvider';

const directories: string[] = [];
afterEach(() => { __setPromptGuideDurabilityFaultForTests(null); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function deadOwner(recovery: 'guarded' | 'manual' = 'guarded'): Promise<string> {
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', 'process.exit(0)'], { stdout: 'ignore', stderr: 'ignore' });
  await child.exited;
  return `v3:${child.pid}:${'b'.repeat(32)}:${recovery}`;
}
const entry = (id = 'guide-1', body = 'A private fixture instruction'): PromptGuideEntry => ({
  id, title: 'Fixture title', body, pinned: true, updatedAt: '2026-09-09T01:02:03.000Z',
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-guide-store-')); directories.push(root);
  const appDataDir = join(root, 'app-data');
  let storedKey: Buffer | null = null;
  let reads = 0, creates = 0;
  const issued: Buffer[] = [];
  const issue = () => { const key = storedKey ? Buffer.from(storedKey) : null; if (key) issued.push(key); return key; };
  const keyProvider: PromptGuideKeyProvider = {
    async read() { reads++; return issue(); },
    async create() { creates++; storedKey ??= Buffer.alloc(32, 23); return issue()!; },
  };
  return {
    root, appDataDir, keyProvider, store: new PromptGuideStore({ appDataDir, keyProvider }), issued,
    get reads() { return reads; }, get creates() { return creates; },
    loseKey() { storedKey = null; }, wrongKey() { storedKey = Buffer.alloc(32, 42); },
    file: () => join(appDataDir, PROMPT_GUIDES_FILE), backup: () => join(appDataDir, PROMPT_GUIDES_BACKUP),
  };
}

describe('encrypted local prompt guide authority', () => {
  test('first read is side-effect free; only an explicit nonempty save provisions a key', async () => {
    const f = setup();
    expect(await f.store.read()).toEqual({ revision: '0', entries: [] });
    expect(existsSync(f.appDataDir)).toBe(false);
    expect(f.reads).toBe(0); expect(f.creates).toBe(0);
    const saved = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    expect(saved.revision).not.toBe('0'); expect(f.creates).toBe(1);
    expect(await f.store.read()).toEqual(saved);
    expect(f.issued.every(key => key.every(byte => byte === 0))).toBe(true);
  });

  test('title/body/pin are encrypted, one ciphertext backup is kept, and no plaintext temp files remain', async () => {
    const f = setup();
    const first = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    const firstBytes = readFileSync(f.file(), 'utf8');
    const second = await f.store.save({ expectedRevision: first.revision, entries: [{ ...entry(), body: 'Changed private instruction', pinned: false }] });
    const secondBytes = readFileSync(f.file(), 'utf8');
    expect(second.revision).not.toBe(first.revision);
    expect(JSON.parse(secondBytes).nonce).not.toBe(JSON.parse(firstBytes).nonce);
    expect(readFileSync(f.backup(), 'utf8')).toBe(firstBytes);
    for (const filename of [f.file(), f.backup()]) {
      const raw = readFileSync(filename, 'utf8');
      expect(raw).not.toContain('Fixture title'); expect(raw).not.toContain('private'); expect(raw).not.toContain('pinned');
      if (process.platform !== 'win32') expect(lstatSync(filename).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(f.appDataDir).filter(name => name.includes('.tmp-'))).toEqual([]);
    expect(await f.store.read()).toEqual(second);
  });

  test('two stale writers serialize and only one can commit', async () => {
    const f = setup();
    const first = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    const other = new PromptGuideStore({ appDataDir: f.appDataDir, keyProvider: f.keyProvider });
    const attempts = await Promise.allSettled([
      f.store.save({ expectedRevision: first.revision, entries: [entry('one')] }),
      other.save({ expectedRevision: first.revision, entries: [entry('two')] }),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    const failed = attempts.find(result => result.status === 'rejected');
    expect(failed?.status === 'rejected' ? failed.reason.code : null).toBe('PROMPT_GUIDES_CONFLICT');
    const succeeded = attempts.find(result => result.status === 'fulfilled');
    if (!succeeded || succeeded.status !== 'fulfilled') throw new Error('one commit must succeed');
    expect(await f.store.read()).toEqual(succeeded.value);
  });

  test('replay with current revision does not rewrite; stale revision never becomes an upsert', async () => {
    const f = setup();
    const first = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    const bytes = readFileSync(f.file(), 'utf8');
    expect(await f.store.save({ expectedRevision: first.revision, entries: first.entries })).toEqual(first);
    expect(readFileSync(f.file(), 'utf8')).toBe(bytes);
    expect(existsSync(f.backup())).toBe(false);
    await expect(f.store.save({ expectedRevision: '0', entries: [entry('another')] })).rejects.toMatchObject({ code: 'PROMPT_GUIDES_CONFLICT' });
    expect(readFileSync(f.file(), 'utf8')).toBe(bytes);
  });

  test('an update reuses the key that actually decrypted its baseline, clearing it after the commit', async () => {
    const f = setup();
    const first = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    const reads = f.reads;
    await f.store.save({ expectedRevision: first.revision, entries: [entry('updated')] });
    expect(f.reads - reads).toBe(1);
    expect(f.issued.every(key => key.every(byte => byte === 0))).toBe(true);
  });

  test('lost lease aborts before ciphertext/evidence commit and cannot delete a replacement owner', async () => {
    const f = setup();
    const replacement = 'different-live-owner';
    const provider: PromptGuideKeyProvider = {
      async read() { return null; },
      async create() {
        writeFileSync(join(f.appDataDir, PROMPT_GUIDES_LOCK), replacement);
        return Buffer.alloc(32, 5);
      },
    };
    const store = new PromptGuideStore({ appDataDir: f.appDataDir, keyProvider: provider });
    await expect(store.save({ expectedRevision: '0', entries: [entry()] })).rejects.toMatchObject({ code: 'PROMPT_GUIDES_LOCK_LOST' });
    expect(existsSync(f.file())).toBe(false);
    expect(existsSync(join(f.appDataDir, PROMPT_GUIDES_EVIDENCE))).toBe(false);
    expect(readFileSync(join(f.appDataDir, PROMPT_GUIDES_LOCK), 'utf8')).toBe(replacement);
  });

  test('a definitively dead new guide owner is recovered, then current ciphertext and CAS are revalidated', async () => {
    const f = setup();
    const first = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    const original = readFileSync(f.file());
    const pending = f.file() + '.tmp-interrupted';
    writeFileSync(pending, original, { mode: 0o600 });
    const lock = join(f.appDataDir, PROMPT_GUIDES_LOCK);
    writeFileSync(lock, await deadOwner(), { mode: 0o600 });
    const restarted = new PromptGuideStore({ appDataDir: f.appDataDir, keyProvider: f.keyProvider });
    const next = await restarted.save({ expectedRevision: first.revision, entries: [entry('restart')] });
    expect(next.entries[0]?.id).toBe('restart');
    expect(await restarted.read()).toEqual(next);
    expect(readFileSync(pending)).toEqual(original);
    expect(readFileSync(f.backup())).toEqual(original);
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, await deadOwner(), { mode: 0o600 });
    await expect(restarted.save({ expectedRevision: first.revision, entries: [entry('stale')] }))
      .rejects.toMatchObject({ code: 'PROMPT_GUIDES_CONFLICT' });
    expect(await restarted.read()).toEqual(next);
  });

  test('recovered dead ownership never promotes interrupted initialization into an empty library', async () => {
    const f = setup(); mkdirSync(f.appDataDir, { mode: 0o700 });
    const evidence = join(f.appDataDir, PROMPT_GUIDES_EVIDENCE);
    writeFileSync(evidence, 'interrupted fixture', { mode: 0o600 });
    writeFileSync(join(f.appDataDir, PROMPT_GUIDES_LOCK), await deadOwner(), { mode: 0o600 });
    await expect(f.store.save({ expectedRevision: '0', entries: [entry()] }))
      .rejects.toMatchObject({ code: 'PROMPT_GUIDES_RECOVERY_REQUIRED' });
    expect(readFileSync(evidence, 'utf8')).toBe('interrupted fixture');
    expect(existsSync(f.file())).toBe(false); expect(f.creates).toBe(0);
  });

  test('stale mtime cannot reclaim a live guide writer', async () => {
    const f = setup(); mkdirSync(f.appDataDir, { mode: 0o700 });
    const lock = join(f.appDataDir, PROMPT_GUIDES_LOCK);
    const owner = `v3:${process.pid}:${'a'.repeat(32)}:guarded`;
    writeFileSync(lock, owner, { mode: 0o600 }); utimesSync(lock, 1, 1);
    await expect(f.store.save({ expectedRevision: '0', entries: [entry()] }))
      .rejects.toMatchObject({ code: 'PROMPT_GUIDES_LOCKED' });
    expect(readFileSync(lock, 'utf8')).toBe(owner); expect(f.creates).toBe(0);
  }, 10_000);

  test('existing manual owner still requires explicit recovery after its process dies', async () => {
    const f = setup(); mkdirSync(f.appDataDir, { mode: 0o700 });
    const lock = join(f.appDataDir, PROMPT_GUIDES_LOCK); const owner = await deadOwner('manual');
    writeFileSync(lock, owner, { mode: 0o600 });
    await expect(f.store.save({ expectedRevision: '0', entries: [entry()] }))
      .rejects.toMatchObject({ code: 'PROMPT_GUIDES_RECOVERY_REQUIRED' });
    expect(readFileSync(lock, 'utf8')).toBe(owner); expect(f.creates).toBe(0);
  }, 10_000);

  test('unsafe guide artifacts deny dead-owner recovery without removing the owner or evidence', async () => {
    const f = setup(); mkdirSync(f.appDataDir, { mode: 0o700 });
    const victim = join(f.root, 'victim'); writeFileSync(victim, 'preserve');
    const pending = f.file() + '.tmp-unsafe'; symlinkSync(victim, pending);
    const lock = join(f.appDataDir, PROMPT_GUIDES_LOCK); const owner = await deadOwner();
    writeFileSync(lock, owner, { mode: 0o600 });
    await expect(f.store.save({ expectedRevision: '0', entries: [entry()] }))
      .rejects.toMatchObject({ code: 'PROMPT_GUIDES_RECOVERY_REQUIRED' });
    expect(readFileSync(lock, 'utf8')).toBe(owner); expect(lstatSync(pending).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim, 'utf8')).toBe('preserve'); expect(f.creates).toBe(0);
  }, 10_000);

  test.skipIf(process.platform === 'win32')('directory flush failure after final rename reports uncertainty and preserves the visible new revision', async () => {
    const f = setup(); const first = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    const original = readFileSync(f.file());
    __setPromptGuideDurabilityFaultForTests((phase) => {
      if (phase === 'directory' && JSON.parse(readFileSync(f.file(), 'utf8')).revision !== first.revision) throw Error('fixture directory flush failure');
    });
    await expect(f.store.save({ expectedRevision: first.revision, entries: [entry('visible')] }))
      .rejects.toMatchObject({ code: 'PROMPT_GUIDES_RESULT_UNCERTAIN' });
    const visible = await f.store.read();
    expect(visible.revision).not.toBe(first.revision); expect(visible.entries[0]?.id).toBe('visible');
    expect(readFileSync(f.backup())).toEqual(original);
    __setPromptGuideDurabilityFaultForTests(null);
    expect(await f.store.save({ expectedRevision: visible.revision, entries: visible.entries })).toEqual(visible);
    await expect(f.store.save({ expectedRevision: first.revision, entries: [entry('retry-old')] }))
      .rejects.toMatchObject({ code: 'PROMPT_GUIDES_CONFLICT' });
    expect(await f.store.read()).toEqual(visible);
  });

  test.skipIf(process.platform === 'win32')('failed backup directory flush leaves the original main intact', async () => {
    const f = setup(); const first = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    const original = readFileSync(f.file());
    __setPromptGuideDurabilityFaultForTests(phase => { if (phase === 'directory') throw Error('fixture backup flush failure'); });
    await expect(f.store.save({ expectedRevision: first.revision, entries: [entry('not-committed')] }))
      .rejects.toMatchObject({ code: 'PROMPT_GUIDES_UNAVAILABLE' });
    expect(readFileSync(f.file())).toEqual(original); expect(readFileSync(f.backup())).toEqual(original);
    expect(await f.store.read()).toEqual(first);
  });

  test('saving an empty list after an explicit delete keeps durable version/evidence and backup', async () => {
    const f = setup();
    const first = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    const empty = await f.store.save({ expectedRevision: first.revision, entries: [] });
    expect(empty.entries).toEqual([]); expect(empty.revision).not.toBe('0');
    expect(await f.store.read()).toEqual(empty);
    expect(existsSync(join(f.appDataDir, PROMPT_GUIDES_EVIDENCE))).toBe(true);
    expect(existsSync(f.backup())).toBe(true);
  });

  test.each(['backup', 'evidence', 'temporary', 'dpapi'] as const)('missing main with %s evidence is never reinitialized', async kind => {
    const f = setup(); mkdirSync(f.appDataDir);
    const filename = kind === 'backup' ? PROMPT_GUIDES_BACKUP : kind === 'evidence' ? PROMPT_GUIDES_EVIDENCE
      : kind === 'dpapi' ? PROMPT_GUIDES_DPAPI_FILE : PROMPT_GUIDES_FILE + '.tmp-interrupted';
    writeFileSync(join(f.appDataDir, filename), 'recovery fixture');
    await expect(f.store.read()).rejects.toMatchObject({ code: 'PROMPT_GUIDES_RECOVERY_REQUIRED' });
    await expect(f.store.save({ expectedRevision: '0', entries: [entry()] })).rejects.toMatchObject({ code: 'PROMPT_GUIDES_RECOVERY_REQUIRED' });
    expect(f.creates).toBe(0); expect(existsSync(f.file())).toBe(false);
    expect(readFileSync(join(f.appDataDir, filename), 'utf8')).toBe('recovery fixture');
  });

  test('key loss or replacement cannot turn an existing store into empty data or a new key', async () => {
    const f = setup();
    const first = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    const bytes = readFileSync(f.file(), 'utf8');
    f.loseKey();
    await expect(f.store.read()).rejects.toMatchObject({ code: 'PROMPT_GUIDES_KEY_MISSING' });
    await expect(f.store.save({ expectedRevision: first.revision, entries: [] })).rejects.toMatchObject({ code: 'PROMPT_GUIDES_KEY_MISSING' });
    f.wrongKey();
    await expect(f.store.read()).rejects.toMatchObject({ code: 'PROMPT_GUIDES_CORRUPT' });
    await expect(f.store.save({ expectedRevision: first.revision, entries: [] })).rejects.toMatchObject({ code: 'PROMPT_GUIDES_CORRUPT' });
    expect(f.creates).toBe(1); expect(readFileSync(f.file(), 'utf8')).toBe(bytes);
  });

  test.each(['broken-json', 'future-version', 'revision-tamper', 'ciphertext-tamper'] as const)('fails closed for %s without changing encrypted files', async kind => {
    const f = setup();
    const first = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    const envelope = JSON.parse(readFileSync(f.file(), 'utf8'));
    if (kind === 'future-version') envelope.schemaVersion = 999;
    if (kind === 'revision-tamper') envelope.revision = crypto.randomUUID();
    if (kind === 'ciphertext-tamper') envelope.ciphertext = Buffer.alloc(64, 12).toString('base64');
    const corrupted = kind === 'broken-json' ? '{broken' : JSON.stringify(envelope);
    writeFileSync(f.file(), corrupted);
    const code = kind === 'future-version' ? 'PROMPT_GUIDES_SCHEMA_UNSUPPORTED' : 'PROMPT_GUIDES_CORRUPT';
    await expect(f.store.read()).rejects.toMatchObject({ code });
    await expect(f.store.save({ expectedRevision: first.revision, entries: [] })).rejects.toMatchObject({ code });
    expect(readFileSync(f.file(), 'utf8')).toBe(corrupted); expect(f.creates).toBe(1);
  });

  test('invalid full batches and resource limits fail before storage or credentials are touched', async () => {
    const f = setup();
    const invalid = [
      { expectedRevision: '0', entries: [entry(), entry()] },
      { expectedRevision: '0', entries: [{ ...entry(), extra: 'not allowed' }] },
      { expectedRevision: '0', entries: [{ ...entry(), updatedAt: 'invalid' }] },
      { expectedRevision: '0', entries: Array.from({ length: 101 }, (_, i) => entry(String(i))) },
      { expectedRevision: '0', entries: [entry('one', 'a'.repeat(16_385))] },
      { expectedRevision: 'bad-revision', entries: [entry()] },
    ];
    for (const value of invalid) await expect(f.store.save(value as any)).rejects.toMatchObject({ code: 'PROMPT_GUIDES_INVALID_INPUT' });
    await expect(f.store.save({ expectedRevision: '0', entries: Array.from({ length: 65 }, (_, i) => entry(String(i), 'a'.repeat(16_384))) }))
      .rejects.toMatchObject({ code: 'PROMPT_GUIDES_LIMIT_EXCEEDED' });
    expect(existsSync(f.appDataDir)).toBe(false); expect(f.reads).toBe(0); expect(f.creates).toBe(0);
  });

  test('matches the frontend 16,384 UTF-16-unit body boundary for ASCII and multibyte emoji', async () => {
    const f = setup();
    const ascii = 'a'.repeat(16_384);
    const first = await f.store.save({ expectedRevision: '0', entries: [entry('ascii', ascii)] });
    expect((await f.store.read()).entries[0]?.body).toBe(ascii);
    await expect(f.store.save({ expectedRevision: first.revision, entries: [entry('too-long', ascii + 'a')] }))
      .rejects.toMatchObject({ code: 'PROMPT_GUIDES_INVALID_INPUT' });
    expect((await f.store.read()).revision).toBe(first.revision);
    const emoji = '😀'.repeat(8_192);
    expect(emoji.length).toBe(16_384);
    expect(Buffer.byteLength(emoji, 'utf8')).toBe(32_768);
    const second = await f.store.save({ expectedRevision: first.revision, entries: [entry('emoji', emoji)] });
    expect((await f.store.read()).entries[0]?.body).toBe(emoji);
    expect(second.entries[0]?.body.length).toBe(16_384);
  });

  test('symlinked app data, main and backup cannot redirect any read/write', async () => {
    const f = setup(); const victim = join(f.root, 'victim'); mkdirSync(victim);
    symlinkSync(victim, f.appDataDir, 'dir');
    await expect(f.store.read()).rejects.toMatchObject({ code: 'PROMPT_GUIDES_PATH_UNSAFE' });
    await expect(f.store.save({ expectedRevision: '0', entries: [entry()] })).rejects.toMatchObject({ code: 'PROMPT_GUIDES_PATH_UNSAFE' });
    unlinkSync(f.appDataDir); mkdirSync(f.appDataDir);
    const victimFile = join(victim, 'preserve'); writeFileSync(victimFile, 'preserve'); symlinkSync(victimFile, f.file());
    await expect(f.store.read()).rejects.toMatchObject({ code: 'PROMPT_GUIDES_PATH_UNSAFE' });
    unlinkSync(f.file());
    const first = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    const firstBytes = readFileSync(f.file(), 'utf8');
    symlinkSync(victimFile, f.backup());
    await expect(f.store.save({ expectedRevision: first.revision, entries: [entry('second')] })).rejects.toMatchObject({ code: 'PROMPT_GUIDES_PATH_UNSAFE' });
    expect(readFileSync(f.file(), 'utf8')).toBe(firstBytes); expect(readFileSync(victimFile, 'utf8')).toBe('preserve');
  });

  test('untrusted credential exceptions are converted to fixed codes without secret/server text', async () => {
    const f = setup();
    const provider: PromptGuideKeyProvider = {
      async read() { throw new Error('synthetic credential details must never be returned'); },
      async create() { throw new Error('must not create'); },
    };
    const store = new PromptGuideStore({ appDataDir: f.appDataDir, keyProvider: provider });
    await expect(store.save({ expectedRevision: '0', entries: [entry()] })).rejects.toMatchObject({ message: 'PROMPT_GUIDES_UNAVAILABLE' });
    expect(existsSync(f.file())).toBe(false);
  });
});
