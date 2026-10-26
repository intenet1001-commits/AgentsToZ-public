import {expect, test} from 'bun:test';
import {mkdtempSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTeamOrcaCheckout, createTeamOrcaCheckoutJournal, type TeamOrcaCheckoutDeps, type TeamOrcaCheckoutGit,
  type TeamOrcaCheckoutInput, type TeamOrcaCheckoutRecord} from '../src/teamOrcaCheckout';

const copy = <T>(value: T): T => structuredClone(value);
const input = (extra: Partial<TeamOrcaCheckoutInput> = {}): TeamOrcaCheckoutInput => ({requestId: 'checkout-request-one', teamId: 'team_123456789abc', memberId: 'm1',
  primaryPath: '/repo/primary', baseCommit: 'a'.repeat(40), ...extra});
function fixture(extra: Partial<TeamOrcaCheckoutDeps> = {}) {
  const records = new Map<string, TeamOrcaCheckoutRecord>(), calls: string[][] = [];
  const state = {current: true, branch: 'atz-team_123456789abc-m1', path: '/orca/workspaces/actual-member', lost: false};
  const before: TeamOrcaCheckoutGit = {primaryPath: '/repo/primary', checkoutPath: '/repo/primary', primaryCommonDir: '/repo/primary/.git', checkoutCommonDir: '/repo/primary/.git',
    head: 'b'.repeat(40), branch: 'main', worktrees: [{path: '/repo/primary', branch: 'main'}], branches: ['main']};
  const after = (): TeamOrcaCheckoutGit => ({...copy(before), checkoutPath: state.path, head: 'a'.repeat(40), branch: state.branch,
    worktrees: [...copy(before.worktrees), {path: state.path, branch: state.branch}], branches: [...before.branches, state.branch]});
  const deps: TeamOrcaCheckoutDeps = {journal: {read: async key => copy(records.get(key) ?? null), compareAndSet: async (key, revision, next) => {
    if ((records.get(key)?.revision ?? null) !== revision) return false; records.set(key, copy(next)); return true;
  }}, isCurrent: () => state.current, resolveOrcaCli: () => '/verified/orca',
    inspectGit: async (_primary, path) => path === before.primaryPath ? copy(before) : after(),
    runOrca: async (_executable, argv, settings) => {
      expect(settings).toEqual({cwd: '/', timeoutMs: 30_000, attempts: 1}); calls.push([...argv]);
      expect((await deps.journal.read('team_123456789abc:m1'))?.state).toBe('reserved');
      if (state.lost) throw new Error('transport lost with private shell details');
      return {ok: true, result: {worktree: {path: state.path, branch: `refs/heads/${state.branch}`}}, _meta: {runtimeId: 'orca-one'}};
    }, ...extra};
  return {deps, create: createTeamOrcaCheckout(deps), records, calls, state, before, after};
}

test('creates an Orca-managed checkout with an exact SHA, no setup/agent/prompt/activation, and returns the actual path and branch', async () => {
  const fake = fixture(); const result = await fake.create(input());
  expect(result).toEqual({path: '/orca/workspaces/actual-member', branch: 'atz-team_123456789abc-m1'});
  expect(fake.calls).toEqual([['worktree', 'create', '--repo', 'path:/repo/primary', '--name', 'atz-team_123456789abc-m1',
    '--base-branch', 'a'.repeat(40), '--setup', 'skip', '--no-parent', '--json']]);
  expect(fake.calls[0]).not.toContain('--agent'); expect(fake.calls[0]).not.toContain('--prompt'); expect(fake.calls[0]).not.toContain('--activate');
  expect(fake.records.get('team_123456789abc:m1')).toMatchObject({state: 'created', result, revision: 2});
  expect(await fake.create(input())).toEqual(result); expect(fake.calls).toHaveLength(1);
});

test('an unknown transport result never retries, including under a fresh requestId', async () => {
  const fake = fixture(); fake.state.lost = true;
  await expect(fake.create(input())).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_UNKNOWN'});
  expect(fake.records.get('team_123456789abc:m1')).toMatchObject({state: 'unknown', reason: 'ORCA_TEAM_CHECKOUT_OUTCOME_UNKNOWN'});
  await expect(fake.create(input())).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_UNKNOWN'});
  await expect(fake.create(input({requestId: 'new-id-cannot-retry'}))).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_CONFLICT'});
  expect(fake.calls).toHaveLength(1);
  expect(JSON.stringify(fake.records.get('team_123456789abc:m1'))).not.toContain('private shell details');
});

test('missing or unfamiliar result fields never fall back to the requested Git path or a guessed branch', async () => {
  for (const result of [{ok: true, result: {path: '/wrong-shape', branch: 'guessed'}}, {ok: true, result: {worktree: {path: '/orca/new'}}},
    {ok: false, result: {worktree: {path: '/orca/new', branch: 'candidate'}}}]) {
    const fake = fixture(); fake.deps.runOrca = async (_cli, argv) => {fake.calls.push([...argv]); return result;};
    await expect(fake.create(input())).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_UNKNOWN'});
    expect(fake.records.get('team_123456789abc:m1')?.state).toBe('unknown'); expect(fake.calls).toHaveLength(1);
    await expect(fake.create(input())).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_UNKNOWN'}); expect(fake.calls).toHaveLength(1);
  }
});

test('wrong HEAD, repository, canonical path or primary relationship preserves an unknown candidate without cleanup', async () => {
  for (const change of [{head: 'c'.repeat(40)}, {checkoutCommonDir: '/other/.git'}, {primaryCommonDir: '/other/.git'},
    {primaryPath: '/other/primary'}, {checkoutPath: '/other/checkout'}, {branch: 'other-branch'}]) {
    const fake = fixture(); fake.deps.inspectGit = async (_primary, path) => path === '/repo/primary' ? copy(fake.before) : {...fake.after(), ...change};
    await expect(fake.create(input())).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_UNKNOWN'});
    expect(fake.records.get('team_123456789abc:m1')).toMatchObject({state: 'unknown', candidate: {path: fake.state.path, branch: fake.state.branch}});
    expect(fake.calls).toHaveLength(1); expect(fake.calls[0]?.slice(0, 2)).toEqual(['worktree', 'create']);
  }
});

test('an existing checkout/branch or duplicate checkout of the returned branch is never adopted', async () => {
  const existingPath = fixture(); existingPath.before.worktrees.push({path: existingPath.state.path, branch: 'already-used'});
  await expect(existingPath.create(input())).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_UNKNOWN'});
  const existingBranch = fixture(); existingBranch.before.branches.push(existingBranch.state.branch);
  await expect(existingBranch.create(input())).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_UNKNOWN'});
  const duplicate = fixture(); duplicate.deps.inspectGit = async (_primary, path) => path === '/repo/primary' ? copy(duplicate.before)
    : {...duplicate.after(), worktrees: [...duplicate.after().worktrees, {path: '/someone-else/checkout', branch: duplicate.state.branch}]};
  await expect(duplicate.create(input())).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_UNKNOWN'});
});

test('unsafe returned branch names fail closed rather than being rewritten into a different branch', async () => {
  for (const branch of ['--force', 'topic..main', 'topic/.hidden', 'topic.lock', 'HEAD', 'topic//nested']) {
    const fake = fixture(); fake.state.branch = branch;
    await expect(fake.create(input())).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_UNKNOWN'});
    expect(fake.records.get('team_123456789abc:m1')?.result).toBeUndefined(); expect(fake.calls).toHaveLength(1);
  }
});

test('two creator instances share the durable reservation and only one invokes the CLI', async () => {
  let finish!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;}); const reply = new Promise<unknown>(resolve => {finish = resolve;});
  const fake = fixture(); fake.deps.runOrca = async (_cli, argv) => {fake.calls.push([...argv]); entered(); return reply;};
  const first = fake.create(input()); await started;
  await expect(createTeamOrcaCheckout(fake.deps)(input())).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_UNKNOWN'});
  expect(fake.calls).toHaveLength(1);
  finish({ok: true, result: {worktree: {path: fake.state.path, branch: fake.state.branch}}});
  expect(await first).toEqual({path: fake.state.path, branch: fake.state.branch});
});

test('invalid preflight, a missing CLI, stale scope or failed reservation prevents every create side effect', async () => {
  const invalid = fixture(); invalid.before.checkoutCommonDir = '/other/.git';
  await expect(invalid.create(input())).rejects.toMatchObject({code: 'ORCA_TEAM_PRIMARY_UNVERIFIED'}); expect(invalid.calls).toHaveLength(0);
  const missing = fixture({resolveOrcaCli: () => null});
  await expect(missing.create(input())).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_NOT_CONNECTED'}); expect(missing.calls).toHaveLength(0);
  const stale = fixture(); stale.state.current = false;
  await expect(stale.create(input())).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_STALE'}); expect(stale.calls).toHaveLength(0);
  const disk = fixture({journal: {read: async () => null, compareAndSet: async () => {throw new Error('disk unavailable');}}});
  await expect(disk.create(input())).rejects.toThrow('disk unavailable'); expect(disk.calls).toHaveLength(0);
});

test('a member superseded while Orca responds keeps its actual candidate and is never automatically removed or recreated', async () => {
  const fake = fixture(); const run = fake.deps.runOrca;
  fake.deps.runOrca = async (...args) => {const result = await run(...args); fake.state.current = false; return result;};
  await expect(fake.create(input())).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_UNKNOWN'});
  expect(fake.records.get('team_123456789abc:m1')).toMatchObject({state: 'unknown', reason: 'ORCA_TEAM_CHECKOUT_STALE', candidate: {path: fake.state.path}});
  await expect(fake.create(input())).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_UNKNOWN'}); expect(fake.calls).toHaveLength(1);
});

test('durable SQLite journal is 0600, survives restart and CAS never drops active/unknown or created dedupe receipts', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'team-orca-checkout-')), 'receipts.sqlite');
  const journal = createTeamOrcaCheckoutJournal(file, {maxRecords: 1}); const fake = fixture({journal});
  const result = await fake.create(input()); expect(statSync(file).mode & 0o777).toBe(0o600); journal.close();
  const reopened = createTeamOrcaCheckoutJournal(file, {maxRecords: 1}); const restarted = createTeamOrcaCheckout({...fake.deps, journal: reopened});
  expect(await restarted(input())).toEqual(result); expect(fake.calls).toHaveLength(1);
  const existing = (await reopened.read('team_123456789abc:m1'))!;
  expect(await reopened.compareAndSet(existing.key, 1, {...existing, revision: 2})).toBe(false);
  const other: TeamOrcaCheckoutRecord = {...copy(existing), key: 'team_123456789abc:m2', revision: 1, state: 'reserved'};
  await expect(reopened.compareAndSet(other.key, null, other)).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_JOURNAL_CAPACITY'});
  expect((await reopened.read(existing.key))?.state).toBe('created'); reopened.close();
});

test('input cannot inject CLI flags, arbitrary refs, commands, setup hooks or a relative repository', async () => {
  for (const changed of [{baseCommit: 'main'}, {teamId: undefined}, {memberId: undefined}, {teamId: 'team --agent codex'}, {primaryPath: 'relative/repo'}, {command: 'arbitrary'}, {setup: 'run'}]) {
    const fake = fixture(); await expect(fake.create({...input(), ...changed} as TeamOrcaCheckoutInput)).rejects.toMatchObject({code: 'ORCA_TEAM_CHECKOUT_INPUT_INVALID'});
    expect(fake.calls).toHaveLength(0); expect(fake.records.size).toBe(0);
  }
});
