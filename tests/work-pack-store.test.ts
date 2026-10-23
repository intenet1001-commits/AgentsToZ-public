import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkPackStore, WORK_PACKS_FILE, WORK_PACKS_BACKUP, WORK_PACKS_EVIDENCE, WORK_PACKS_KEY_NAMESPACE, type WorkPackCurrentSource, type WorkPackSourceBinding } from '../src/workPackStore';
import { parseWorkPackDefinition, reviewWorkPackDefinition, type WorkPackDefinition, type WorkPackInspection } from '../src/workPack';
import { PromptGuideStore, PROMPT_GUIDES_FILE, PROMPT_GUIDES_LOCK } from '../src/promptGuideStore';
import { __setPromptGuideDurabilityFaultForTests, type PromptGuideKeyProvider } from '../src/promptGuideKeyProvider';
import { acquireOwnedFileLock } from '../src/portalFileLock';

const directories: string[] = [];
afterEach(() => { __setPromptGuideDurabilityFaultForTests(null); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const source = (): WorkPackSourceBinding => ({ sourceLibraryId: 'local-library', accountId: 'owner-1', libraryRevision: 'library-r1', guideId: 'command-1', commandBodyHash: 'a'.repeat(64), sourceRevision: 'incarnation-1' });
const live = (): WorkPackCurrentSource => ({ ...source(), kind: 'command', presence: 'present', virtual: false, provenance: 'verified', supported: true });
function pack(binding = source(), revision = 'definition-r1'): WorkPackDefinition {
  return parseWorkPackDefinition({ schemaVersion: 1, source: binding, definitionRevision: revision, inputs: [],
    plan: { steps: [{ id: 'status', input: { operation: 'tester.status.read' } }] }, inputBindings: [],
    conditions: [{ kind: 'step-completed', stepId: 'status' }], review: { state: 'draft' } });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-work-pack-')); directories.push(root);
  const appDataDir = join(root, 'app-data');
  let savedKey: Buffer | null = null, creates = 0, reads = 0;
  const issued: Buffer[] = [];
  const issue = () => { const key = savedKey ? Buffer.from(savedKey) : null; if (key) issued.push(key); return key; };
  const keyProvider: PromptGuideKeyProvider = { async read() { reads++; return issue(); }, async create() { creates++; savedKey ??= Buffer.alloc(32, 27); return issue()!; } };
  let current: WorkPackCurrentSource = live();
  const store = new WorkPackStore({ appDataDir, keyProvider, sourceReader: async () => current });
  return { root, appDataDir, store, keyProvider, issued,
    file: () => join(appDataDir, WORK_PACKS_FILE), backup: () => join(appDataDir, WORK_PACKS_BACKUP),
    setCurrent(value: WorkPackCurrentSource) { current = value; },
    loseKey() { savedKey = null; }, wrongKey() { savedKey = Buffer.alloc(32, 66); },
    get creates() { return creates; }, get reads() { return reads; },
    save(definition = pack(), expectedRevision = '0', expectedDefinitionRevision: string | null = null) { return store.save({ definition, expectedRevision, expectedDefinitionRevision }); },
  };
}

describe('bounded encrypted local work pack adapter (inactive)', () => {
  test('read creates no directory, key or lock; only explicit first save creates key', async () => {
    const f = fixture();
    expect(await f.store.read()).toEqual({ revision: '0', definitions: [] });
    expect(await f.store.readBound(source())).toEqual({ revision: '0', definition: null, inspection: null });
    expect(existsSync(f.appDataDir)).toBe(false); expect(f.reads).toBe(0); expect(f.creates).toBe(0);
    const first = await f.save();
    expect(await f.store.read()).toEqual(first); expect(f.creates).toBe(1);
    expect(f.issued.every(key => key.every(byte => byte === 0))).toBe(true);
    const raw = readFileSync(f.file(), 'utf8');
    for (const secret of ['local-library', 'command-1', 'definition-r1', 'tester.status.read']) expect(raw).not.toContain(secret);
    if (process.platform !== 'win32') { expect(lstatSync(f.file()).mode & 0o777).toBe(0o600); expect(lstatSync(f.appDataDir).mode & 0o777).toBe(0o700); }
    expect(readdirSync(f.appDataDir).filter(name => name.includes('.tmp-'))).toEqual([]);
  });

  test('T16 workpack_manifest_scope_cas_body_binding', async () => {
    const f = fixture(); const first = await f.save(); const before = readFileSync(f.file());
    for (const [expectedRevision, expectedDefinitionRevision] of [['0', 'definition-r1'], [first.revision, null], [first.revision, 'wrong']] as const) {
      await expect(f.save(pack(source(), 'definition-r2'), expectedRevision, expectedDefinitionRevision)).rejects.toMatchObject({ code: 'WORK_PACKS_CONFLICT' });
    }
    await expect(f.save(pack(), first.revision, 'definition-r1')).resolves.toEqual(first);
    for (const field of ['sourceLibraryId', 'accountId', 'guideId', 'commandBodyHash', 'sourceRevision', 'libraryRevision'] as const) {
      f.setCurrent({ ...live(), [field]: field === 'commandBodyHash' ? 'b'.repeat(64) : 'changed' });
      await expect(f.save(pack(source(), 'definition-r2'), first.revision, 'definition-r1')).rejects.toMatchObject({ code: 'WORK_PACKS_SOURCE_CONFLICT' });
      expect(readFileSync(f.file())).toEqual(before);
    }
    f.setCurrent(live());
    const attempts = await Promise.allSettled([f.save(pack(source(), 'definition-r2'), first.revision, 'definition-r1'), f.save(pack(source(), 'definition-r3'), first.revision, 'definition-r1')]);
    expect(attempts.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(x => x.status === 'rejected')).toHaveLength(1);
    expect(readFileSync(f.backup())).toEqual(before);
  });

  test('T17 workpack_legacy_guides_roundtrip_preserves_meaning', async () => {
    const f = fixture();
    // Different provider/namespace: no body duplication or overwrite of the existing authority.
    const guides = new PromptGuideStore({ appDataDir: f.appDataDir, keyProvider: { async read() { return Buffer.alloc(32, 12); }, async create() { return Buffer.alloc(32, 12); } } });
    const entries = [undefined, 'command', 'simple'].map((kind, n) => ({ id: `guide-${n}`, title: `Title ${n}`, body: `Private original body ${n}`, pinned: n === 0, updatedAt: '2026-10-24T01:02:03.000Z', ...(kind ? { kind } : {}) }));
    const original = await guides.save({ expectedRevision: '0', entries: entries as never });
    const bytes = readFileSync(join(f.appDataDir, PROMPT_GUIDES_FILE));
    await f.save();
    expect(readFileSync(join(f.appDataDir, PROMPT_GUIDES_FILE))).toEqual(bytes);
    expect(await guides.read()).toEqual(original);
    expect(JSON.stringify(await f.store.read())).not.toContain('Private original body');
    // Sidecar participates in the exact existing lock, rather than its own competing authority.
    const release = await acquireOwnedFileLock(join(f.appDataDir, PROMPT_GUIDES_LOCK));
    let finished = false;
    const waiting = f.save(pack(source(), 'definition-r2'), (await f.store.read()).revision, 'definition-r1').then(() => { finished = true; });
    await Bun.sleep(50); expect(finished).toBe(false); release(); await waiting;
  });

  test('T18 workpack_source_edits_deletes_reimports_need_review', async () => {
    const f = fixture();
    await f.save(reviewWorkPackDefinition(pack(), live()));
    expect((await f.store.readBound(source())).inspection?.state).toBe('reviewed');
    const changes: [Partial<WorkPackCurrentSource>, WorkPackInspection['state']][] = [
      [{ commandBodyHash: 'b'.repeat(64) }, 'stale'], [{ kind: 'simple' }, 'stale'], [{ presence: 'deleted' }, 'orphan'],
      [{ provenance: 'reimported' }, 'stale'], [{ sourceRevision: 'incarnation-2' }, 'stale'], [{ accountId: 'owner-2' }, 'stale'],
      [{ provenance: 'unknown' }, 'unsupported'], [{ virtual: true }, 'unsupported'], [{ supported: false }, 'unsupported'],
    ];
    const before = readFileSync(f.file());
    for (const [patch, state] of changes) { f.setCurrent({ ...live(), ...patch }); expect((await f.store.readBound(source())).inspection?.state).toBe(state); }
    f.setCurrent({ ...live(), libraryRevision: 'title-pin-reorder-r2' });
    expect((await f.store.readBound(source())).inspection?.state).toBe('reviewed');
    expect(readFileSync(f.file())).toEqual(before); expect(f.creates).toBe(1);
  });

  test('T19 workpack_storage_keys_future_schema_preserved', async () => {
    for (const failure of ['lost', 'wrong', 'future', 'corrupt', 'aad'] as const) {
      const f = fixture(); const saved = await f.save();
      if (failure === 'lost') f.loseKey();
      if (failure === 'wrong') f.wrongKey();
      if (failure === 'future') { const raw = JSON.parse(readFileSync(f.file(), 'utf8')); raw.schemaVersion = 2; writeFileSync(f.file(), JSON.stringify(raw), { mode: 0o600 }); }
      if (failure === 'corrupt') writeFileSync(f.file(), '{corrupt', { mode: 0o600 });
      if (failure === 'aad') { const raw = JSON.parse(readFileSync(f.file(), 'utf8')); raw.revision = '11111111-1111-4111-8111-111111111111'; writeFileSync(f.file(), JSON.stringify(raw), { mode: 0o600 }); }
      const before = readFileSync(f.file());
      const code = failure === 'lost' ? 'WORK_PACKS_KEY_MISSING' : failure === 'future' ? 'WORK_PACKS_SCHEMA_UNSUPPORTED' : 'WORK_PACKS_CORRUPT';
      await expect(f.store.read()).rejects.toMatchObject({ code });
      await expect(f.save(pack(source(), 'definition-r2'), saved.revision, 'definition-r1')).rejects.toMatchObject({ code });
      expect(readFileSync(f.file())).toEqual(before); expect(f.creates).toBe(1);
    }
    for (const evidence of [WORK_PACKS_BACKUP, WORK_PACKS_EVIDENCE, WORK_PACKS_KEY_NAMESPACE.dpapiFile, WORK_PACKS_FILE + '.tmp-interrupted']) {
      const f = fixture(); mkdirSync(f.appDataDir, { mode: 0o700 }); writeFileSync(join(f.appDataDir, evidence), 'preserve', { mode: 0o600 });
      await expect(f.store.read()).rejects.toMatchObject({ code: 'WORK_PACKS_RECOVERY_REQUIRED' });
      await expect(f.save()).rejects.toMatchObject({ code: 'WORK_PACKS_RECOVERY_REQUIRED' });
      expect(f.creates).toBe(0); expect(readFileSync(join(f.appDataDir, evidence), 'utf8')).toBe('preserve');
    }
  });

  test('unsafe symlinks, hardlinks and public modes fail without overwriting originals', async () => {
    for (const unsafe of ['symlink', 'hardlink', 'file-mode', 'directory-mode'] as const) {
      const f = fixture(); await f.save();
      const target = join(f.root, 'preserve'); writeFileSync(target, 'victim', { mode: 0o600 });
      if (unsafe === 'symlink' || unsafe === 'hardlink') { unlinkSync(f.file()); if (unsafe === 'symlink') symlinkSync(target, f.file()); else linkSync(target, f.file()); }
      if (unsafe === 'file-mode') { if (process.platform === 'win32') continue; chmodSync(f.file(), 0o644); }
      if (unsafe === 'directory-mode') { if (process.platform === 'win32') continue; chmodSync(f.appDataDir, 0o755); }
      await expect(f.store.read()).rejects.toMatchObject({ code: 'WORK_PACKS_PATH_UNSAFE' });
      await expect(f.save()).rejects.toMatchObject({ code: 'WORK_PACKS_PATH_UNSAFE' });
      expect(readFileSync(target, 'utf8')).toBe('victim');
    }
  });

  test('source mutation while key provisioning awaits aborts before ciphertext commit', async () => {
    const f = fixture();
    // Explicit mutable source for a shared library outside the local lock.
    let current = live();
    const changed = new WorkPackStore({ appDataDir: f.appDataDir, keyProvider: { async read() { return null; }, async create() { current = { ...live(), libraryRevision: 'r2' }; return Buffer.alloc(32, 9); } }, sourceReader: async () => current });
    await expect(changed.save({ expectedRevision: '0', expectedDefinitionRevision: null, definition: pack() })).rejects.toMatchObject({ code: 'WORK_PACKS_SOURCE_CONFLICT' });
    expect(existsSync(f.file())).toBe(false);
  });

  test('invalid/oversized definitions reject before credentials or source reads; namespaces cannot decrypt guides', async () => {
    const f = fixture();
    for (const definition of [{ ...pack(), body: 'copy forbidden' }, { ...pack(), unexpected: 'x'.repeat(17 * 1024) }]) {
      await expect(f.save(definition as WorkPackDefinition)).rejects.toMatchObject({ code: Object.hasOwn(definition, 'unexpected') ? 'WORK_PACKS_LIMIT_EXCEEDED' : 'WORK_PACKS_INVALID_INPUT' });
    }
    expect(f.creates).toBe(0); expect(f.reads).toBe(0); expect(existsSync(f.appDataDir)).toBe(false);
    const guides = new PromptGuideStore({ appDataDir: f.appDataDir, keyProvider: f.keyProvider });
    await guides.save({ expectedRevision: '0', entries: [{ id: 'command-1', title: 'fixture', body: 'private', pinned: true, updatedAt: '2026-10-24T01:02:03.000Z', kind: 'command' }] });
    writeFileSync(f.file(), readFileSync(join(f.appDataDir, PROMPT_GUIDES_FILE)), { mode: 0o600 });
    await expect(f.store.read()).rejects.toMatchObject({ code: 'WORK_PACKS_CORRUPT' });
  });

  test('100-definition and total plaintext byte limits are independent and preserve the last revision', async () => {
    const f = fixture();
    const keyProvider: PromptGuideKeyProvider = { async read() { return Buffer.alloc(32, 22); }, async create() { return Buffer.alloc(32, 22); } };
    const store = new WorkPackStore({ appDataDir: f.appDataDir, keyProvider, sourceReader: async binding => ({ ...live(), ...binding }) });
    let revision = '0';
    for (let n = 0; n < 100; n++) {
      const next = await store.save({ expectedRevision: revision, expectedDefinitionRevision: null, definition: pack({ ...source(), guideId: `guide-${n}` }) });
      revision = next.revision;
    }
    const before = readFileSync(f.file());
    await expect(store.save({ expectedRevision: revision, expectedDefinitionRevision: null, definition: pack({ ...source(), guideId: 'guide-100' }) })).rejects.toMatchObject({ code: 'WORK_PACKS_LIMIT_EXCEEDED' });
    expect(readFileSync(f.file())).toEqual(before); expect((await store.read()).definitions).toHaveLength(100);
    // Each definition is valid and below 16 KiB, while their combined plaintext exceeds 256 KiB.
    const large = parseWorkPackDefinition({ ...pack(), inputs: Array.from({ length: 3 }, (_, n) => ({ name: `choice${n}`, type: 'enum', required: false, options: Array.from({ length: 16 }, (_, m) => `option-${m}-` + 'x'.repeat(90)) })) });
    let changed = 0;
    for (let n = 0; n < 100; n++) {
      const previous = readFileSync(f.file());
      try {
        const next = await store.save({ expectedRevision: revision, expectedDefinitionRevision: 'definition-r1', definition: { ...large, source: { ...source(), guideId: `guide-${n}` }, definitionRevision: 'definition-r2' } });
        revision = next.revision; changed++;
      } catch (error) {
        expect(error).toMatchObject({ code: 'WORK_PACKS_LIMIT_EXCEEDED' });
        expect(readFileSync(f.file())).toEqual(previous); break;
      }
    }
    expect(changed).toBeGreaterThan(0); expect(changed).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify({ definitions: (await store.read()).definitions }))).toBeLessThanOrEqual(256 * 1024);
    expect(readFileSync(f.file()).length).toBeLessThanOrEqual(256 * 1024);
  }, 30000);

  test('failed final directory fsync returns uncertain, preserves committed bytes and supports reread', async () => {
    const f = fixture(); const first = await f.save();
    const previous = readFileSync(f.file()); let flushes = 0;
    __setPromptGuideDurabilityFaultForTests((phase, path) => { if (phase === 'directory' && path === realpathSync(f.appDataDir) && ++flushes === 2) throw new Error('synthetic'); });
    await expect(f.save(pack(source(), 'definition-r2'), first.revision, 'definition-r1')).rejects.toMatchObject({ code: 'WORK_PACKS_RESULT_UNCERTAIN' });
    __setPromptGuideDurabilityFaultForTests(null);
    const actual = await f.store.read(); expect(actual.definitions[0]?.definitionRevision).toBe('definition-r2');
    expect(readFileSync(f.backup())).toEqual(previous);
    expect(await f.save(pack(source(), 'definition-r2'), actual.revision, 'definition-r2')).toEqual(actual);
  });

  test('accessors and toJSON are rejected without invoking caller code', async () => {
    const f = fixture(); let calls = 0;
    const accessor = Object.defineProperty({ ...pack() }, 'source', { enumerable: true, get() { calls++; return source(); } });
    await expect(f.save(accessor)).rejects.toMatchObject({ code: 'WORK_PACKS_INVALID_INPUT' });
    await expect(f.save({ ...pack(), toJSON() { calls++; return pack(); } } as WorkPackDefinition)).rejects.toMatchObject({ code: 'WORK_PACKS_INVALID_INPUT' });
    expect(calls).toBe(0); expect(f.creates).toBe(0); expect(existsSync(f.appDataDir)).toBe(false);
  });


  test('lost owned lock aborts before evidence/rename and cannot release a replacement owner', async () => {
    const f = fixture(); const replacement = `v2:${process.pid}:` + 'b'.repeat(32);
    const store = new WorkPackStore({ appDataDir: f.appDataDir, sourceReader: async () => live(), keyProvider: {
      async read() { return null; }, async create() {
        unlinkSync(join(f.appDataDir, PROMPT_GUIDES_LOCK));
        writeFileSync(join(f.appDataDir, PROMPT_GUIDES_LOCK), replacement, { mode: 0o600 });
        return Buffer.alloc(32, 42);
      },
    } });
    await expect(store.save({ expectedRevision: '0', expectedDefinitionRevision: null, definition: pack() })).rejects.toMatchObject({ code: 'WORK_PACKS_LOCK_LOST' });
    expect(existsSync(f.file())).toBe(false); expect(existsSync(join(f.appDataDir, WORK_PACKS_EVIDENCE))).toBe(false);
    expect(readFileSync(join(f.appDataDir, PROMPT_GUIDES_LOCK), 'utf8')).toBe(replacement);
  });

  test('guarded dead owner recovery revalidates current ciphertext and CAS', async () => {
    const f = fixture(); const first = await f.save();
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', 'process.exit(0)'], { stdout: 'ignore', stderr: 'ignore' });
    await child.exited;
    writeFileSync(join(f.appDataDir, PROMPT_GUIDES_LOCK), `v3:${child.pid}:` + 'b'.repeat(32) + ':guarded', { mode: 0o600 });
    const next = await f.save(pack(source(), 'definition-r2'), first.revision, 'definition-r1');
    expect(next.definitions[0]?.definitionRevision).toBe('definition-r2');
    expect(await f.store.read()).toEqual(next); expect(existsSync(join(f.appDataDir, PROMPT_GUIDES_LOCK))).toBe(false);
  });


  test('same guide ID remains isolated by exact source library and account', async () => {
    const f = fixture(); let revision = '0';
    const bindings = [source(), { ...source(), accountId: 'owner-2' }, { ...source(), sourceLibraryId: 'shared-library' }];
    for (const binding of bindings) {
      f.setCurrent({ ...live(), ...binding });
      const next = await f.save(pack(binding), revision); revision = next.revision;
    }
    expect((await f.store.read()).definitions).toHaveLength(3);
    for (const binding of bindings) {
      f.setCurrent({ ...live(), ...binding });
      expect((await f.store.readBound(binding)).definition?.source).toEqual(binding);
    }
  });

});
