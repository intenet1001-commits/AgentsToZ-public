import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {ControlProfileStore, readControlProfileAccess, type ControlProfileCandidate} from '../src/controlProfileStore';
import {CONTROL_PROFILE_MARKER} from '../src/controlProfileContract';

// The OPS folder is renamed on disk (AgentsToZ-Control → AgentsToZ-OPS). The profile identity
// never moves: profile, memory and access key stay; only the bound root follows the folder, and
// the old root is kept as history.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });

async function boundFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'control-relocate-'));
  dirs.push(dir);
  const from = join(dir, 'AgentsToZ-Control'), to = join(dir, 'AgentsToZ-OPS'), memoryId = randomUUID();
  mkdirSync(from);
  const memories = new Map<string, {memoryId: string; document: string; savedAt: string}>();
  memories.set(from, {memoryId, document: '# Operating memory\n', savedAt: '2026-09-29T00:00:00Z'});
  let candidates: ControlProfileCandidate[] = [{root: from, memoryId, projectId: 'ops-id'}];
  const deps = {
    candidates: async () => candidates, seed: async () => null,
    restore: async () => { throw new Error('offline'); },
    initialize: async () => {},
    snapshot: (root: string) => { const memory = memories.get(root); if (!memory) throw new Error('missing'); return {...memory, root}; },
    save: async () => {},
    register: async () => 'ops-id',
  };
  const store = new ControlProfileStore(dir, deps);
  expect((await store.prepare()).state).toBe('ready');
  const moveOnDisk = () => { renameSync(from, to); memories.set(to, memories.get(from)!); memories.delete(from); candidates = [{root: to, memoryId, projectId: 'ops-id'}]; };
  return {dir, from, to, memoryId, memories, store, deps, moveOnDisk};
}

describe('Control profile relocation', () => {
  test('follows a renamed folder without touching the profile, memory or access key', async () => {
    const f = await boundFixture();
    const before = f.store.status(), access = readControlProfileAccess(f.dir)!;
    f.moveOnDisk();
    const moved = await f.store.relocate(f.from, f.to);
    expect(moved.state).toBe('ready');
    expect(moved.profileId).toBe(before.profileId);
    expect(moved.memoryId).toBe(f.memoryId);
    expect(moved.projectId).toBe('ops-id');
    expect(f.store.read().binding.root).toBe(f.to);
    expect(f.store.boundLocation()).toMatchObject({state: 'ready', backend: 'control-folder', root: f.to, legacyRoots: [f.from]});
    expect(readControlProfileAccess(f.dir)).toEqual(access);
    expect(f.store.authorize(access.token)).toBe(true);
    expect(JSON.parse(readFileSync(join(f.to, CONTROL_PROFILE_MARKER), 'utf8')).memoryId).toBe(f.memoryId);
    // A restart and a later preparation keep the relocated binding.
    const restarted = new ControlProfileStore(f.dir, f.deps);
    expect((await restarted.prepare()).state).toBe('ready');
    expect(restarted.read().binding.root).toBe(f.to);
  });

  test('is idempotent: a repeated relocation changes nothing and records the old root once', async () => {
    const f = await boundFixture();
    f.moveOnDisk();
    await f.store.relocate(f.from, f.to);
    const binding = readFileSync(join(f.dir, 'control-profile', 'binding.json'), 'utf8');
    expect((await f.store.relocate(f.from, f.to)).state).toBe('ready');
    expect(readFileSync(join(f.dir, 'control-profile', 'binding.json'), 'utf8')).toBe(binding);
    expect(f.store.boundLocation()?.legacyRoots).toEqual([f.from]);
  });

  test('refuses a destination whose marker or memory does not prove the same profile', async () => {
    const missing = await boundFixture();
    mkdirSync(missing.to); missing.memories.set(missing.to, missing.memories.get(missing.from)!);
    await expect(missing.store.relocate(missing.from, missing.to)).rejects.toThrow('표식');
    expect(missing.store.read().binding.root).toBe(missing.from);

    const otherMarker = await boundFixture();
    otherMarker.moveOnDisk();
    writeFileSync(join(otherMarker.to, CONTROL_PROFILE_MARKER), JSON.stringify({schemaVersion: 1, profileId: randomUUID(), memoryId: otherMarker.memoryId}));
    await expect(otherMarker.store.relocate(otherMarker.from, otherMarker.to)).rejects.toThrow('표식');
    expect(otherMarker.store.boundLocation()?.root).toBe(otherMarker.from);

    const otherMemory = await boundFixture();
    otherMemory.moveOnDisk();
    otherMemory.memories.get(otherMemory.to)!.memoryId = randomUUID();
    await expect(otherMemory.store.relocate(otherMemory.from, otherMemory.to)).rejects.toThrow();
    expect(otherMemory.store.boundLocation()?.root).toBe(otherMemory.from);
  });

  test('refuses when the binding points somewhere else, and for a local-only profile', async () => {
    const f = await boundFixture();
    f.moveOnDisk();
    await expect(f.store.relocate(join(f.dir, 'elsewhere'), f.to)).rejects.toThrow();
    expect(f.store.boundLocation()?.root).toBe(f.from);
    await expect(f.store.relocate('relative', f.to)).rejects.toThrow();

    const local = mkdtempSync(join(tmpdir(), 'control-relocate-local-'));
    dirs.push(local);
    const memories = new Map<string, {memoryId: string; document: string; savedAt: string}>();
    const store = new ControlProfileStore(local, {
      candidates: async () => [], seed: async () => null, restore: async () => { throw new Error('offline'); },
      initialize: async (root: string, memoryId: string) => { memories.set(root, {memoryId, document: '# local\n', savedAt: '2026-09-29'}); },
      snapshot: (root: string) => ({...memories.get(root)!, root}), save: async () => {},
    });
    const ready = await store.prepare();
    expect(ready.backend).toBe('app-data');
    await expect(store.relocate(store.read().binding.root, join(local, 'moved'))).rejects.toThrow();
  });

  test('an interrupted attach is finished before any relocation', async () => {
    const f = await boundFixture();
    f.moveOnDisk();
    writeFileSync(join(f.dir, 'control-profile', 'attach-transition.json'), '{}', {mode: 0o600});
    await expect(f.store.relocate(f.from, f.to)).rejects.toThrow();
    expect(f.store.boundLocation()?.root).toBe(f.from);
  });

  // Area C keeps voice records made before the move reviewable only through legacyRoots, so every
  // path that moves the binding must record where it was — not only a relocation that finds it at `from`.
  test('preparation that re-finds a moved folder records the old root', async () => {
    const f = await boundFixture();
    f.moveOnDisk();
    expect((await f.store.prepare()).state).toBe('ready');
    expect(f.store.boundLocation()).toMatchObject({root: f.to, legacyRoots: [f.from]});
  });

  test('a relocation that finds the binding already at the new root still records the old root once', async () => {
    const f = await boundFixture();
    f.moveOnDisk();
    // An older app re-found the folder during preparation without keeping the old root.
    const path = join(f.dir, 'control-profile', 'binding.json');
    writeFileSync(path, JSON.stringify({...JSON.parse(readFileSync(path, 'utf8')), root: f.to, legacyRoots: []}));
    expect((await f.store.relocate(f.from, f.to)).state).toBe('ready');
    expect(f.store.boundLocation()).toMatchObject({root: f.to, legacyRoots: [f.from]});
    const recorded = readFileSync(path, 'utf8');
    expect((await f.store.relocate(f.from, f.to)).state).toBe('ready');
    expect(readFileSync(path, 'utf8')).toBe(recorded);
  });

  test('a binding re-found under the real path of the new root is the same folder, not a changed binding', async () => {
    // Preparation stores the candidate's realpath (/private/var/… on macOS) while the migration passes
    // the literal path it renamed to (/var/…). The two name one folder.
    const f = await boundFixture();
    f.moveOnDisk();
    const path = join(f.dir, 'control-profile', 'binding.json');
    const real = realpathSync(f.to);
    f.memories.set(real, f.memories.get(f.to)!);
    writeFileSync(path, JSON.stringify({...JSON.parse(readFileSync(path, 'utf8')), root: real, legacyRoots: []}));
    expect((await f.store.relocate(f.from, f.to)).state).toBe('ready');
    expect(f.store.boundLocation()).toMatchObject({root: real, legacyRoots: [f.from]});
  });

  test('a binding already at the new root records nothing when the folder there is another profile', async () => {
    const f = await boundFixture();
    f.moveOnDisk();
    const path = join(f.dir, 'control-profile', 'binding.json');
    writeFileSync(path, JSON.stringify({...JSON.parse(readFileSync(path, 'utf8')), root: f.to, legacyRoots: []}));
    writeFileSync(join(f.to, CONTROL_PROFILE_MARKER), JSON.stringify({schemaVersion: 1, profileId: randomUUID(), memoryId: f.memoryId}));
    await f.store.relocate(f.from, f.to);
    expect(JSON.parse(readFileSync(path, 'utf8')).legacyRoots).toEqual([]);
  });

  test('older bindings without history stay valid; malformed history is refused', async () => {
    const f = await boundFixture();
    expect(f.store.boundLocation()?.legacyRoots).toEqual([]);
    const path = join(f.dir, 'control-profile', 'binding.json');
    const binding = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({...binding, legacyRoots: ['relative/path']}));
    expect(f.store.status().state).toBe('needs-attention');
    expect(f.store.boundLocation()).toBeNull();
    expect(existsSync(path)).toBe(true);
  });
});
