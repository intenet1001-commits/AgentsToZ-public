import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeUserProfileSave, normalizeUserProfileRecallRequest, selectUserProfileRecall, UserProfileError,
  type UserProfileEntry, type UserProfileSnapshot,
} from '../src/userProfileContract';
import {
  UserProfileStore, USER_PROFILE_FILE, USER_PROFILE_BACKUP, USER_PROFILE_EVIDENCE, USER_PROFILE_LOCK, USER_PROFILE_KEY_NAMESPACE,
} from '../src/userProfileStore';
import { __setPromptGuideDurabilityFaultForTests, PromptGuideError, type PromptGuideKeyProvider } from '../src/promptGuideKeyProvider';
import { PromptGuideStore, PROMPT_GUIDES_FILE } from '../src/promptGuideStore';

const directories: string[] = [];
const projectA = randomUUID(), projectB = randomUUID();
afterEach(() => {
  __setPromptGuideDurabilityFaultForTests(null);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function entry(overrides: Partial<UserProfileEntry> = {}): UserProfileEntry {
  return { id: randomUUID(), title: '직접 확인한 선호', body: '답변은 간결하게 작성해 주세요.', scope: 'all-projects', projectMemoryId: null,
    state: 'active', updatedAt: '2026-10-25T01:02:03.000Z', origin: 'user-confirmed', ...overrides };
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-user-profile-')); directories.push(root);
  const appDataDir = join(root, 'app-data');
  let storedKey: Buffer | null = null, reads = 0, creates = 0;
  const issued: Buffer[] = [];
  const issue = () => { const key = storedKey ? Buffer.from(storedKey) : null; if (key) issued.push(key); return key; };
  const keyProvider: PromptGuideKeyProvider = {
    async read() { reads++; return issue(); },
    async create() { creates++; storedKey ??= Buffer.alloc(32, 19); return issue()!; },
  };
  return {
    root, appDataDir, keyProvider, issued, store: new UserProfileStore({ appDataDir, keyProvider }),
    get reads() { return reads; }, get creates() { return creates; },
    loseKey() { storedKey = null; }, wrongKey() { storedKey = Buffer.alloc(32, 27); },
    file: () => join(appDataDir, USER_PROFILE_FILE), backup: () => join(appDataDir, USER_PROFILE_BACKUP),
  };
}
async function deadOwner(): Promise<string> {
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', 'process.exit(0)'], { stdout: 'ignore', stderr: 'ignore' });
  await child.exited;
  return `v3:${child.pid}:${'b'.repeat(32)}:guarded`;
}

describe('local user-confirmed profile contract and recall', () => {
  test('strict entry/save keys, identities, scope and user-confirmed origin are validated before effects', async () => {
    const f = setup(), good = entry();
    const invalid: unknown[] = [
      null, [], { expectedRevision: '0', entries: [good], confirmed: true },
      { expectedRevision: 'expired', entries: [good] },
      ...[
        { extra: true }, { id: 'profile-1' }, { title: '' }, { title: 'a'.repeat(121) }, { title: 'line\nbreak' },
        { body: ' ' }, { body: 'a'.repeat(4_001) }, { body: '\ud800' }, { body: 'bad\0body' },
        { scope: 'project', projectMemoryId: 'project-path' }, { scope: 'project', projectMemoryId: null },
        { scope: 'all-projects', projectMemoryId: projectA }, { state: 'deleted' }, { origin: 'ai-inferred' },
        { updatedAt: '2026-10-25' }, { updatedAt: 'not-a-date' }, { sourceWhatISaidId: randomUUID() },
      ].map(change => ({ expectedRevision: '0', entries: [{ ...good, ...change }] })),
      { expectedRevision: '0', entries: [good, { ...good, id: good.id.toUpperCase() }] },
      { expectedRevision: '0', entries: Array.from({ length: 65 }, () => entry()) },
    ];
    for (const input of invalid) await expect(f.store.save(input)).rejects.toMatchObject({ code: 'USER_PROFILE_INVALID_INPUT' });
    expect(existsSync(f.appDataDir)).toBe(false); expect(f.reads).toBe(0); expect(f.creates).toBe(0);
    const input = { expectedRevision: '0', entries: [good] }, normalized = normalizeUserProfileSave(input);
    good.body = 'changed after normalization';
    expect(normalized.entries[0]?.body).not.toBe(good.body);
  });

  test('UTF-8 body and Unicode title boundaries round-trip without splitting characters', async () => {
    const f = setup(), good = entry({ title: '😀'.repeat(120), body: '😀'.repeat(1_000) });
    const first = await f.store.save({ expectedRevision: '0', entries: [good] });
    expect(await f.store.read()).toEqual(first);
    await expect(f.store.save({ expectedRevision: first.revision, entries: [{ ...good, body: good.body + 'a' }] }))
      .rejects.toMatchObject({ code: 'USER_PROFILE_INVALID_INPUT' });
  });

  test('recall excludes inactive and other-project entries and never invents a project scope', async () => {
    const f = setup(), common = entry(), own = entry({ scope: 'project', projectMemoryId: projectA }),
      other = entry({ scope: 'project', projectMemoryId: projectB }), inactive = entry({ state: 'inactive' });
    const saved = await f.store.save({ expectedRevision: '0', entries: [common, own, other, inactive] });
    expect(await f.store.recall({ projectMemoryId: projectA })).toEqual({ revision: saved.revision, entries: [common, own], truncated: false });
    expect((await f.store.recall({ projectMemoryId: null })).entries).toEqual([common]);
    for (const request of [{ projectMemoryId: 'not-uuid' }, { projectMemoryId: null, rawHistory: true }, { projectMemoryId: null, query: 'x'.repeat(1_025) }]) {
      expect(() => normalizeUserProfileRecallRequest(request)).toThrow(UserProfileError);
    }
  });

  test('narrow queries use normalized lexical matches, rank relevant titles first and return no unrelated entry', () => {
    const general = entry({ title: '답변 방식', body: 'Codex에서는 간단히 써 주세요.' }),
      titled = entry({ title: 'Codex 선호', body: '짧은 한국어 문장' }), unrelated = entry({ title: '식사', body: '매운맛을 좋아합니다.' });
    const snapshot = { revision: randomUUID(), entries: [general, unrelated, titled] };
    const request = normalizeUserProfileRecallRequest({ projectMemoryId: null, query: '  Ｃｏｄｅｘ  ' });
    expect(request.query).toBe('Codex');
    expect(selectUserProfileRecall(snapshot, request).entries).toEqual([titled, general]);
    expect(selectUserProfileRecall(snapshot, { projectMemoryId: null, query: '없는항목' }).entries).toEqual([]);
  });

  test('recall keeps at most five whole entries and its complete JSON stays within 8000 UTF-8 bytes', () => {
    const small = Array.from({ length: 7 }, () => entry({ body: '짧은 선호' }));
    const snapshot: UserProfileSnapshot = { revision: randomUUID(), entries: small };
    const five = selectUserProfileRecall(snapshot, { projectMemoryId: null });
    expect(five.entries).toEqual(small.slice(0, 5)); expect(five.truncated).toBe(true);
    const large = entry({ body: '😀'.repeat(1_000) }), escaped = entry({ body: '\\'.repeat(4_000) });
    const limited = selectUserProfileRecall({ ...snapshot, entries: [escaped, large, entry({ body: large.body }), small[0]!] }, { projectMemoryId: null });
    expect(Buffer.byteLength(JSON.stringify(limited), 'utf8')).toBeLessThanOrEqual(8_000);
    expect(limited.entries).toEqual([large, small[0]!]); expect(limited.truncated).toBe(true);
    expect(limited.entries[0]?.body).toBe(large.body);
  });
});

describe('encrypted user profile authority', () => {
  test('initial read/recall create no folder or key; only explicit nonempty save prepares the key', async () => {
    const f = setup();
    expect(await f.store.read()).toEqual({ revision: '0', entries: [] });
    expect(await f.store.recall({ projectMemoryId: null })).toEqual({ revision: '0', entries: [], truncated: false });
    expect(existsSync(f.appDataDir)).toBe(false); expect(f.reads).toBe(0); expect(f.creates).toBe(0);
    const saved = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    expect(await f.store.read()).toEqual(saved); expect(f.creates).toBe(1);
    expect(f.issued.every(key => key.every(byte => byte === 0))).toBe(true);
  });

  test('archive and restore preserve the exact entry ID/body; ciphertext/backup are private and no plaintext temp remains', async () => {
    const f = setup(), original = entry();
    const first = await f.store.save({ expectedRevision: '0', entries: [original] }), firstBytes = readFileSync(f.file());
    const archived = await f.store.save({ expectedRevision: first.revision, entries: [{ ...original, state: 'inactive' }] });
    expect((await f.store.recall({ projectMemoryId: null })).entries).toEqual([]);
    expect(readFileSync(f.backup())).toEqual(firstBytes);
    const restored = await f.store.save({ expectedRevision: archived.revision, entries: [original] });
    expect(restored.entries).toEqual(first.entries); expect((await f.store.recall({ projectMemoryId: null })).entries).toEqual([original]);
    for (const path of [f.file(), f.backup()]) {
      const bytes = readFileSync(path, 'utf8');
      expect(bytes).not.toContain(original.title); expect(bytes).not.toContain(original.body); expect(bytes).not.toContain(original.id);
      if (process.platform !== 'win32') expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(f.appDataDir).filter(name => name.includes('.tmp-'))).toEqual([]);
    expect(f.issued.every(key => key.every(byte => byte === 0))).toBe(true);
  });

  test('concurrent writers re-read under the owned lock and only one stale revision commits', async () => {
    const f = setup(), first = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    const other = new UserProfileStore({ appDataDir: f.appDataDir, keyProvider: f.keyProvider });
    const attempts = await Promise.allSettled([
      f.store.save({ expectedRevision: first.revision, entries: [entry({ body: 'first writer' })] }),
      other.save({ expectedRevision: first.revision, entries: [entry({ body: 'second writer' })] }),
    ]);
    const passed = attempts.filter(result => result.status === 'fulfilled'), failed = attempts.filter(result => result.status === 'rejected');
    expect(passed).toHaveLength(1); expect(failed).toHaveLength(1);
    expect(failed[0]?.status === 'rejected' && failed[0].reason.code).toBe('USER_PROFILE_CONFLICT');
    const winner = passed[0];
    if (!winner || winner.status !== 'fulfilled') throw Error('one writer must commit');
    expect(await f.store.read()).toEqual(winner.value);
  });

  test('same-current no-op does not rewrite and stale same-content retries remain conflicts', async () => {
    const f = setup(), saved = await f.store.save({ expectedRevision: '0', entries: [entry()] }), bytes = readFileSync(f.file());
    expect(await f.store.save({ expectedRevision: saved.revision, entries: saved.entries })).toEqual(saved);
    await expect(f.store.save({ expectedRevision: '0', entries: saved.entries })).rejects.toMatchObject({ code: 'USER_PROFILE_CONFLICT' });
    expect(readFileSync(f.file())).toEqual(bytes); expect(existsSync(f.backup())).toBe(false);
  });

  test('key loss, wrong key and locked credentials preserve existing ciphertext and never provision a replacement', async () => {
    const f = setup(), saved = await f.store.save({ expectedRevision: '0', entries: [entry()] }), bytes = readFileSync(f.file());
    f.loseKey();
    await expect(f.store.read()).rejects.toMatchObject({ code: 'USER_PROFILE_KEY_MISSING' });
    await expect(f.store.save({ expectedRevision: saved.revision, entries: [] })).rejects.toMatchObject({ code: 'USER_PROFILE_KEY_MISSING' });
    f.wrongKey();
    await expect(f.store.read()).rejects.toMatchObject({ code: 'USER_PROFILE_CORRUPT' });
    await expect(f.store.save({ expectedRevision: saved.revision, entries: [] })).rejects.toMatchObject({ code: 'USER_PROFILE_CORRUPT' });
    const locked = new UserProfileStore({ appDataDir: f.appDataDir, keyProvider: {
      async read() { throw new PromptGuideError('PROMPT_GUIDES_KEY_UNAVAILABLE'); }, async create() { throw Error('must not create'); },
    } });
    await expect(locked.read()).rejects.toMatchObject({ code: 'USER_PROFILE_KEY_UNAVAILABLE' });
    expect(f.creates).toBe(1); expect(readFileSync(f.file())).toEqual(bytes);
  });

  test.each(['broken-json', 'future-schema', 'revision-tamper', 'tag-tamper'] as const)('%s fails closed without replacing or downgrading the file', async kind => {
    const f = setup(), first = await f.store.save({ expectedRevision: '0', entries: [entry()] });
    const envelope = JSON.parse(readFileSync(f.file(), 'utf8'));
    if (kind === 'future-schema') envelope.schemaVersion = 2;
    if (kind === 'revision-tamper') envelope.revision = randomUUID();
    if (kind === 'tag-tamper') envelope.tag = Buffer.alloc(16, 9).toString('base64');
    const damaged = kind === 'broken-json' ? '{bad' : JSON.stringify(envelope);
    writeFileSync(f.file(), damaged);
    const code = kind === 'future-schema' ? 'USER_PROFILE_SCHEMA_UNSUPPORTED' : 'USER_PROFILE_CORRUPT';
    await expect(f.store.read()).rejects.toMatchObject({ code });
    await expect(f.store.save({ expectedRevision: first.revision, entries: [] })).rejects.toMatchObject({ code });
    expect(readFileSync(f.file(), 'utf8')).toBe(damaged); expect(f.creates).toBe(1);
  });

  test.each([USER_PROFILE_BACKUP, USER_PROFILE_EVIDENCE, USER_PROFILE_FILE + '.tmp-interrupted', USER_PROFILE_KEY_NAMESPACE.dpapiFile])('missing main plus %s evidence is never treated as fresh', async name => {
    const f = setup(); mkdirSync(f.appDataDir);
    writeFileSync(join(f.appDataDir, name), 'preserve interrupted evidence', { mode: 0o600 });
    await expect(f.store.read()).rejects.toMatchObject({ code: 'USER_PROFILE_RECOVERY_REQUIRED' });
    await expect(f.store.save({ expectedRevision: '0', entries: [entry()] })).rejects.toMatchObject({ code: 'USER_PROFILE_RECOVERY_REQUIRED' });
    expect(f.creates).toBe(0); expect(existsSync(f.file())).toBe(false);
    expect(readFileSync(join(f.appDataDir, name), 'utf8')).toBe('preserve interrupted evidence');
  });

  test('no-follow rejects symlinked directory/main/backup and hard-linked main without changing their target', async () => {
    const f = setup(), victim = join(f.root, 'victim'); mkdirSync(victim);
    symlinkSync(victim, f.appDataDir, 'dir');
    await expect(f.store.read()).rejects.toMatchObject({ code: 'USER_PROFILE_PATH_UNSAFE' });
    unlinkSync(f.appDataDir); mkdirSync(f.appDataDir);
    const target = join(victim, 'data'); writeFileSync(target, 'keep'); symlinkSync(target, f.file());
    await expect(f.store.save({ expectedRevision: '0', entries: [entry()] })).rejects.toMatchObject({ code: 'USER_PROFILE_PATH_UNSAFE' });
    unlinkSync(f.file()); const first = await f.store.save({ expectedRevision: '0', entries: [entry()] }), bytes = readFileSync(f.file());
    symlinkSync(target, f.backup());
    await expect(f.store.save({ expectedRevision: first.revision, entries: [entry()] })).rejects.toMatchObject({ code: 'USER_PROFILE_PATH_UNSAFE' });
    expect(readFileSync(target, 'utf8')).toBe('keep'); expect(readFileSync(f.file())).toEqual(bytes);
    unlinkSync(f.backup()); linkSync(f.file(), join(f.root, 'hard-link'));
    await expect(f.store.read()).rejects.toMatchObject({ code: 'USER_PROFILE_PATH_UNSAFE' });
  });

  test('lost lease before first commit preserves a replacement owner and writes no profile/evidence', async () => {
    const f = setup(), replacement = 'replacement-owner';
    const store = new UserProfileStore({ appDataDir: f.appDataDir, keyProvider: {
      async read() { return null; }, async create() { writeFileSync(join(f.appDataDir, USER_PROFILE_LOCK), replacement); return Buffer.alloc(32, 4); },
    } });
    await expect(store.save({ expectedRevision: '0', entries: [entry()] })).rejects.toMatchObject({ code: 'USER_PROFILE_LOCK_LOST' });
    expect(existsSync(f.file())).toBe(false); expect(existsSync(join(f.appDataDir, USER_PROFILE_EVIDENCE))).toBe(false);
    expect(readFileSync(join(f.appDataDir, USER_PROFILE_LOCK), 'utf8')).toBe(replacement);
  });

  test('a dead guarded writer can recover only after artifact safety checks and never discards pending evidence', async () => {
    const f = setup(), first = await f.store.save({ expectedRevision: '0', entries: [entry()] }), bytes = readFileSync(f.file());
    const pending = f.file() + '.tmp-interrupted'; writeFileSync(pending, bytes, { mode: 0o600 });
    writeFileSync(join(f.appDataDir, USER_PROFILE_LOCK), await deadOwner(), { mode: 0o600 });
    const next = await f.store.save({ expectedRevision: first.revision, entries: [entry()] });
    expect(await f.store.read()).toEqual(next); expect(readFileSync(pending)).toEqual(bytes);
    const owner = await deadOwner(), target = join(f.root, 'unsafe'); writeFileSync(target, 'preserve');
    symlinkSync(target, f.file() + '.tmp-unsafe'); writeFileSync(join(f.appDataDir, USER_PROFILE_LOCK), owner, { mode: 0o600 });
    await expect(f.store.save({ expectedRevision: next.revision, entries: [] })).rejects.toMatchObject({ code: 'USER_PROFILE_RECOVERY_REQUIRED' });
    expect(readFileSync(join(f.appDataDir, USER_PROFILE_LOCK), 'utf8')).toBe(owner); expect(readFileSync(target, 'utf8')).toBe('preserve');
  }, 10_000);

  test.skipIf(process.platform === 'win32')('post-rename durability uncertainty preserves the committed revision and requires read before retry', async () => {
    const f = setup(), first = await f.store.save({ expectedRevision: '0', entries: [entry()] }), original = readFileSync(f.file());
    __setPromptGuideDurabilityFaultForTests(phase => {
      if (phase === 'directory' && JSON.parse(readFileSync(f.file(), 'utf8')).revision !== first.revision) throw Error('synthetic flush failure');
    });
    await expect(f.store.save({ expectedRevision: first.revision, entries: [entry()] })).rejects.toMatchObject({ code: 'USER_PROFILE_RESULT_UNCERTAIN' });
    const visible = await f.store.read(); expect(visible.revision).not.toBe(first.revision); expect(readFileSync(f.backup())).toEqual(original);
    __setPromptGuideDurabilityFaultForTests(null);
    await expect(f.store.save({ expectedRevision: first.revision, entries: visible.entries })).rejects.toMatchObject({ code: 'USER_PROFILE_CONFLICT' });
    expect(await f.store.save({ expectedRevision: visible.revision, entries: visible.entries })).toEqual(visible);
    const committedBytes = readFileSync(f.file()); f.loseKey();
    await expect(f.store.save({ expectedRevision: visible.revision, entries: [] })).rejects.toMatchObject({ code: 'USER_PROFILE_KEY_MISSING' });
    expect(readFileSync(f.file())).toEqual(committedBytes); expect(f.creates).toBe(1);
  });

  test.skipIf(process.platform === 'win32')('interrupted first-save evidence remains authoritative even when no ciphertext or key is recoverable', async () => {
    const f = setup(); mkdirSync(f.appDataDir, { mode: 0o700 });
    __setPromptGuideDurabilityFaultForTests(phase => { if (phase === 'directory') throw Error('synthetic first-save flush failure'); });
    await expect(f.store.save({ expectedRevision: '0', entries: [entry()] })).rejects.toMatchObject({ code: 'USER_PROFILE_UNAVAILABLE' });
    __setPromptGuideDurabilityFaultForTests(null);
    expect(existsSync(f.file())).toBe(false); expect(existsSync(join(f.appDataDir, USER_PROFILE_EVIDENCE))).toBe(true);
    f.loseKey();
    await expect(f.store.read()).rejects.toMatchObject({ code: 'USER_PROFILE_RECOVERY_REQUIRED' });
    await expect(f.store.save({ expectedRevision: '0', entries: [entry()] })).rejects.toMatchObject({ code: 'USER_PROFILE_RECOVERY_REQUIRED' });
    expect(f.creates).toBe(1);
  });

  test.skipIf(process.platform === 'win32')('failed backup flush keeps the previous main and does not report a committed revision', async () => {
    const f = setup(), first = await f.store.save({ expectedRevision: '0', entries: [entry()] }), bytes = readFileSync(f.file());
    __setPromptGuideDurabilityFaultForTests(phase => { if (phase === 'directory') throw Error('synthetic backup flush failure'); });
    await expect(f.store.save({ expectedRevision: first.revision, entries: [entry()] })).rejects.toMatchObject({ code: 'USER_PROFILE_UNAVAILABLE' });
    expect(readFileSync(f.file())).toEqual(bytes); expect(readFileSync(f.backup())).toEqual(bytes);
    __setPromptGuideDurabilityFaultForTests(null);
    expect(await f.store.read()).toEqual(first);
  });

  test('host scope is revalidated after credential preparation and before commit; invalid scopes do not modify ciphertext', async () => {
    const f = setup(), first = await f.store.save({ expectedRevision: '0', entries: [entry()] }), bytes = readFileSync(f.file());
    let checked = false;
    const store = new UserProfileStore({ appDataDir: f.appDataDir, keyProvider: f.keyProvider, beforeCommit: async save => {
      checked = true; expect(save.expectedRevision).toBe(first.revision); expect(f.issued.at(-1)?.some(byte => byte !== 0)).toBe(true);
      throw new UserProfileError('USER_PROFILE_PROJECT_UNAVAILABLE');
    } });
    await expect(store.save({ expectedRevision: first.revision, entries: [entry({ scope: 'project', projectMemoryId: projectA })] }))
      .rejects.toMatchObject({ code: 'USER_PROFILE_PROJECT_UNAVAILABLE' });
    expect(checked).toBe(true); expect(readFileSync(f.file())).toEqual(bytes); expect(existsSync(f.backup())).toBe(false);
    expect(f.issued.every(key => key.every(byte => byte === 0))).toBe(true);
  });

  test('profile encryption cannot read another local library even when a fake provider supplies the same key', async () => {
    const f = setup(), guides = new PromptGuideStore({ appDataDir: f.appDataDir, keyProvider: f.keyProvider });
    await guides.save({ expectedRevision: '0', entries: [{ id: 'guide', title: 'Guide', body: 'different authority', pinned: false, updatedAt: entry().updatedAt }] });
    const guideBytes = readFileSync(join(f.appDataDir, PROMPT_GUIDES_FILE)); writeFileSync(f.file(), guideBytes, { mode: 0o600 });
    await expect(f.store.read()).rejects.toMatchObject({ code: 'USER_PROFILE_CORRUPT' });
    expect(readFileSync(join(f.appDataDir, PROMPT_GUIDES_FILE))).toEqual(guideBytes); expect(f.creates).toBe(1);
  });

  test('untrusted credential exceptions never expose raw messages or create a replacement key', async () => {
    const f = setup(); let creates = 0;
    const store = new UserProfileStore({ appDataDir: f.appDataDir, keyProvider: {
      async read() { throw Error('private synthetic credential/path must stay internal'); },
      async create() { creates++; return Buffer.alloc(32); },
    } });
    await expect(store.save({ expectedRevision: '0', entries: [entry()] })).rejects.toMatchObject({ message: 'USER_PROFILE_UNAVAILABLE' });
    expect(creates).toBe(0); expect(existsSync(f.file())).toBe(false);
  });
});
