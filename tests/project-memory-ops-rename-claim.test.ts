import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {claimProjectMemoryIdentity, detectProjectMemory, initializeProjectMemory, registeredProjectRepositoryKey} from '../project-memory-server';
import {canonicalProjectRepositoryKey, proposedMemoryIdForRepository} from '../src/projectMemoryIdentity';

// Review findings 1 and 2. The registry maps memory_id (PK) ↔ canonical_repo_key (UNIQUE). An OPS clone
// whose origin already names the renamed repository (AgentsToZ-OPS) but carries no pin presents the new
// key: for a memory registered under the legacy key the claim's insert collides on memory_id (every
// push, pull and profile sync fails), and a fresh clone of the new URL opens a second OPS lineage.
// The claim asks the registry first and pins the legacy key it finds.
const LEGACY_URL = 'https://github.com/test-owner/AgentsToZ-Control.git';
const RENAMED_URL = 'https://github.com/test-owner/AgentsToZ-OPS.git';
const LEGACY_KEY = 'https://github.com/test-owner/agentstoz-control';
const RENAMED_KEY = 'https://github.com/test-owner/agentstoz-ops';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });
const git = (args: string[], cwd: string) => Bun.spawnSync(['git', ...args], {cwd, stdout: 'pipe', stderr: 'pipe'});
const pinnedKey = (root: string) => git(['config', '--local', '--get', 'agentstoz.repositoryKey'], root).stdout.toString().trim();

function clone(origin: string) {
  const root = mkdtempSync(join(tmpdir(), 'ops-rename-claim-'));
  dirs.push(root);
  git(['init', '-q'], root);
  git(['remote', 'add', 'origin', origin], root);
  initializeProjectMemory({folderPath: root, projectName: 'AgentsToZ', agent: 'codex', autoBackup: false});
  return root;
}

type Row = {memory_id: string; canonical_repo_key: string};
/** The registry as the service-role memory client sees it, with portmgr_claim_project_memory's semantics. */
function registry(initial: Row[], options: {selectError?: boolean} = {}) {
  const rows = initial.map(row => ({...row}));
  const calls = {selects: [] as Array<{table: string; filters: Array<[string, string, unknown]>}>, claims: [] as string[]};
  const query = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    const result = () => {
      calls.selects.push({table, filters: [...filters]});
      if (table !== 'portmgr_project_memories') return {data: [], error: null};
      if (options.selectError) return {data: null, error: {code: '42501', message: 'permission denied for table portmgr_project_memories'}};
      const data = rows.filter(row => filters.every(([op, column, value]) => op === 'eq'
        ? (row as Record<string, unknown>)[column] === value
        : (value as unknown[]).includes((row as Record<string, unknown>)[column])));
      return {data: data.map(row => ({...row})), error: null};
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => { filters.push(['eq', column, value]); return builder; },
      in: (column: string, values: unknown[]) => { filters.push(['in', column, values]); return builder; },
      limit: () => builder,
      maybeSingle: async () => { const r = result(); return {data: r.data?.[0] ?? null, error: r.error}; },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  };
  const sb = {
    from: (table: string) => query(table),
    rpc: async (name: string, args: {p_repository_key: string; p_proposed_memory_id: string}) => {
      if (name !== 'portmgr_claim_project_memory') return {data: null, error: {message: `unexpected ${name}`}};
      const key = canonicalProjectRepositoryKey(args.p_repository_key)!;
      calls.claims.push(key);
      const existing = rows.find(row => row.canonical_repo_key === key);
      if (existing) return {data: [{memory_id: existing.memory_id, claimed: false}], error: null};
      // insert … on conflict (canonical_repo_key) do nothing: the memory_id primary key still conflicts.
      if (rows.some(row => row.memory_id === args.p_proposed_memory_id)) {
        return {data: null, error: {code: '23505', message: 'duplicate key value violates unique constraint "portmgr_project_memories_pkey"'}};
      }
      rows.push({memory_id: args.p_proposed_memory_id, canonical_repo_key: key});
      return {data: [{memory_id: args.p_proposed_memory_id, claimed: true}], error: null};
    },
  };
  return {sb, rows, calls};
}
const configOf = (root: string) => detectProjectMemory(root).config!;

describe('an OPS clone whose origin already follows the rename keeps its lineage', () => {
  test('a memory registered under the legacy key: the claim pins that key instead of colliding', async () => {
    // Created and backed up under the legacy name; origin then switched by hand, before any pin.
    const root = clone(LEGACY_URL);
    const memoryId = configOf(root).memoryId;
    const {sb, rows, calls} = registry([{memory_id: memoryId, canonical_repo_key: LEGACY_KEY}]);
    git(['remote', 'set-url', 'origin', RENAMED_URL], root);
    const identity = await claimProjectMemoryIdentity(sb, root, configOf(root));
    expect(identity).toEqual({memoryId, repositoryKey: LEGACY_KEY});
    expect(calls.claims).toEqual([LEGACY_KEY]);
    expect(pinnedKey(root)).toBe(LEGACY_KEY);
    expect(rows).toEqual([{memory_id: memoryId, canonical_repo_key: LEGACY_KEY}]);
    // Later claims read the pin; the registry is not asked again.
    const selects = calls.selects.length;
    expect(await claimProjectMemoryIdentity(sb, root, configOf(root))).toEqual({memoryId, repositoryKey: LEGACY_KEY});
    expect(calls.selects.filter(call => call.table === 'portmgr_project_memories')).toHaveLength(
      calls.selects.slice(0, selects).filter(call => call.table === 'portmgr_project_memories').length);
  });

  test('a fresh clone of the new URL on another Mac joins the existing OPS lineage instead of forking it', async () => {
    const lineage = proposedMemoryIdForRepository(LEGACY_KEY);
    const root = clone(RENAMED_URL);
    const proposed = configOf(root).memoryId;
    expect(proposed).toBe(proposedMemoryIdForRepository(RENAMED_KEY));
    const {sb, rows} = registry([{memory_id: lineage, canonical_repo_key: LEGACY_KEY}]);
    const identity = await claimProjectMemoryIdentity(sb, root, configOf(root));
    expect(identity).toEqual({memoryId: lineage, repositoryKey: LEGACY_KEY, canonicalizedFrom: proposed});
    expect(JSON.parse(readFileSync(join(root, '.agent-memory', 'config.json'), 'utf8')).memoryId).toBe(lineage);
    expect(pinnedKey(root)).toBe(LEGACY_KEY);
    expect(rows).toEqual([{memory_id: lineage, canonical_repo_key: LEGACY_KEY}]);
  });
});

describe('the registry lookup changes nothing else', () => {
  test('a lineage registered under the new name stays the answer', async () => {
    const root = clone(RENAMED_URL);
    const opsLineage = 'ops-lineage-created-under-the-new-name';
    const {sb, calls} = registry([{memory_id: opsLineage, canonical_repo_key: RENAMED_KEY}, {memory_id: 'older', canonical_repo_key: LEGACY_KEY}]);
    const identity = await claimProjectMemoryIdentity(sb, root, configOf(root));
    expect(identity.memoryId).toBe(opsLineage);
    expect(identity.repositoryKey).toBe(RENAMED_KEY);
    expect(calls.claims).toEqual([RENAMED_KEY]);
    expect(pinnedKey(root)).toBe('');
  });

  test('an OPS created under the new name asks the registry once, then reads its pin', async () => {
    // Every new user's OPS is AgentsToZ-OPS from the start. Its key is the new one; once the registry
    // confirms that for this memory, the pin (equal to the origin key) spares every later claim a lookup.
    const root = clone(RENAMED_URL);
    const {sb, calls} = registry([]);
    const lookups = () => calls.selects.filter(call => call.table === 'portmgr_project_memories').length;
    const first = await claimProjectMemoryIdentity(sb, root, configOf(root));
    expect(first.repositoryKey).toBe(RENAMED_KEY);
    expect(pinnedKey(root)).toBe('');
    expect((await claimProjectMemoryIdentity(sb, root, configOf(root))).repositoryKey).toBe(RENAMED_KEY);
    expect(pinnedKey(root)).toBe(RENAMED_KEY);
    const afterPin = lookups();
    expect((await claimProjectMemoryIdentity(sb, root, configOf(root))).repositoryKey).toBe(RENAMED_KEY);
    expect(lookups()).toBe(afterPin);
    expect(calls.claims).toEqual([RENAMED_KEY, RENAMED_KEY, RENAMED_KEY]);
  });

  test('a memory registered under an unrelated key, another owner\'s legacy repository, or no legacy lineage: no pin', async () => {
    const unrelated = clone(RENAMED_URL);
    const own = configOf(unrelated).memoryId;
    await claimProjectMemoryIdentity(registry([{memory_id: own, canonical_repo_key: 'https://github.com/test-owner/elsewhere'}]).sb, unrelated, configOf(unrelated)).catch(() => undefined);
    expect(pinnedKey(unrelated)).toBe('');

    const otherOwner = clone(RENAMED_URL);
    const other = registry([{memory_id: 'someone-else', canonical_repo_key: 'https://github.com/another-owner/agentstoz-control'}]);
    const identity = await claimProjectMemoryIdentity(other.sb, otherOwner, configOf(otherOwner));
    expect(identity.repositoryKey).toBe(RENAMED_KEY);
    expect(pinnedKey(otherOwner)).toBe('');

    const nothing = clone(RENAMED_URL);
    expect((await claimProjectMemoryIdentity(registry([]).sb, nothing, configOf(nothing))).repositoryKey).toBe(RENAMED_KEY);
    expect(pinnedKey(nothing)).toBe('');
  });

  test('a registry that cannot be read leaves the claim exactly as before', async () => {
    const root = clone(RENAMED_URL);
    const {sb, calls} = registry([{memory_id: 'lineage', canonical_repo_key: LEGACY_KEY}], {selectError: true});
    const identity = await claimProjectMemoryIdentity(sb, root, configOf(root));
    expect(identity.repositoryKey).toBe(RENAMED_KEY);
    expect(calls.claims).toEqual([RENAMED_KEY]);
    expect(pinnedKey(root)).toBe('');
  });

  test('other repositories never query the registry, and a legacy origin needs no lookup', async () => {
    const plain = clone('https://github.com/test-owner/some-app.git');
    const first = registry([]);
    await claimProjectMemoryIdentity(first.sb, plain, configOf(plain));
    expect(first.calls.selects.filter(call => call.table === 'portmgr_project_memories')).toEqual([]);
    const legacy = clone(LEGACY_URL);
    const second = registry([]);
    expect((await claimProjectMemoryIdentity(second.sb, legacy, configOf(legacy))).repositoryKey).toBe(LEGACY_KEY);
    expect(second.calls.selects.filter(call => call.table === 'portmgr_project_memories')).toEqual([]);
  });

  test('a guarded backup presents the registered legacy key but never adopts another lineage', async () => {
    // The auto-backup path fixes its identity up front, so it may only learn the key of its own memory.
    const registered = clone(LEGACY_URL);
    const memoryId = configOf(registered).memoryId;
    git(['remote', 'set-url', 'origin', RENAMED_URL], registered);
    const known = registry([{memory_id: memoryId, canonical_repo_key: LEGACY_KEY}]);
    expect(await registeredProjectRepositoryKey(known.sb, registered, memoryId, null, false)).toBe(LEGACY_KEY);
    expect(pinnedKey(registered)).toBe(LEGACY_KEY);

    const fresh = clone(RENAMED_URL);
    const other = registry([{memory_id: 'the-other-lineage', canonical_repo_key: LEGACY_KEY}]);
    expect(await registeredProjectRepositoryKey(other.sb, fresh, configOf(fresh).memoryId, null, false)).toBe(RENAMED_KEY);
    expect(pinnedKey(fresh)).toBe('');
    expect(other.calls.selects.filter(call => call.filters.some(([op]) => op === 'in'))).toEqual([]);
  });

  test('a joined memory is never re-keyed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ops-rename-claim-joined-'));
    dirs.push(root);
    git(['init', '-q'], root);
    git(['remote', 'add', 'origin', RENAMED_URL], root);
    initializeProjectMemory({folderPath: root, projectName: 'AgentsToZ', agent: 'codex', autoBackup: false, memoryId: '9b8e2c1a-3d4f-4a5b-8c6d-7e8f9a0b1c2d'});
    const {sb, calls} = registry([{memory_id: 'lineage', canonical_repo_key: LEGACY_KEY}]);
    expect(await claimProjectMemoryIdentity(sb, root, configOf(root))).toEqual({memoryId: '9b8e2c1a-3d4f-4a5b-8c6d-7e8f9a0b1c2d', repositoryKey: null});
    expect(calls.claims).toEqual([]);
    expect(pinnedKey(root)).toBe('');
  });
});
