import {afterEach, describe, expect, test} from 'bun:test';
import * as nodeFs from 'node:fs';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {
  OPS_FOLDER_IN_USE_CHECKS, OPS_FOLDER_MIGRATION_PHASES, createOpsGit, normalizeOpsGithubUrl, topUpOpsTrust, followUpOpsRepositoryOrigin, opsFolderMigrationAllowed, opsFolderMigrationLogLine, opsGitEnvironment,
  opsOriginFollowUpLogLine, parseLsofCwdOutput, readOpsFolderMigrationRecord, runOpsFolderBoot,
  runOpsFolderMigration, type OpsFolderMigrationDeps, type OpsFolderMigrationPhase,
} from '../src/opsFolderMigration';
import {rebasePath} from '../src/opsFolderName';
import {CONTROL_PROFILE_MARKER} from '../src/controlProfileContract';
import {createControlProfileHost} from '../control-profile-server';
import {initializeProjectMemory, projectRepositoryKey} from '../project-memory-server';

// AgentsToZ-Control → AgentsToZ-OPS on disk, at sidecar boot, before the profile is prepared.
// Every precondition failure is a skip that retries next boot; an interrupted run rolls forward
// from its journal; an inconsistent disk stops for a person and never deletes or merges.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });

class SimulatedCrash extends Error {}
const run = (argv: string[], cwd: string) => Bun.spawnSync(argv, {cwd, stdout: 'pipe', stderr: 'pipe'});
const gitText = (args: string[], cwd: string) => run(['git', ...args], cwd).stdout.toString().trim();
const LEGACY_URL = 'https://github.com/test-owner/AgentsToZ-Control.git';

type FixtureOptions = {
  crashAfter?: OpsFolderMigrationPhase; reachable?: boolean; lsof?: {exitCode: number; stdout: string} | null;
  leaseBusy?: boolean; folderName?: string; origin?: string | null;
  /** The folder is registered and bound through a symlinked parent directory. */
  viaLink?: boolean;
  /** `git ls-remote` listings per URL; both default to the same repository's refs. */
  refs?: {legacy?: string; renamed?: string};
  /** A fake `gh`; absent means gh is not installed. */
  gh?: (args: string[]) => {exitCode: number; stdout: string} | null;
};
const REFS = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\tHEAD\na1b2c3d4e5f60718293a4b5c6d7e8f9012345678\trefs/heads/main\n';
const RENAMED_URL = 'https://github.com/test-owner/AgentsToZ-OPS.git';
const LEGACY_KEY = 'https://github.com/test-owner/agentstoz-control';

function fixture(options: FixtureOptions = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ops-migration-')));
  dirs.push(dir);
  const appData = join(dir, 'app-data'), home = join(dir, 'home'), realParent = join(dir, 'product');
  const parent = options.viaLink ? join(dir, 'product-link') : realParent;
  mkdirSync(join(appData, 'control-profile'), {recursive: true});
  mkdirSync(home);
  mkdirSync(realParent);
  if (options.viaLink) symlinkSync(realParent, parent);
  const from = join(parent, options.folderName ?? 'AgentsToZ-Control'), to = join(parent, 'AgentsToZ-OPS');
  const profileId = randomUUID(), memoryId = randomUUID();
  mkdirSync(join(from, '.agent-memory'), {recursive: true});
  run(['git', 'init', '-q'], from);
  if (options.origin !== null) run(['git', 'remote', 'add', 'origin', options.origin ?? LEGACY_URL], from);
  writeFileSync(join(from, CONTROL_PROFILE_MARKER), JSON.stringify({schemaVersion: 1, profileId, memoryId}));
  writeFileSync(join(from, '.agent-memory', 'config.json'), JSON.stringify({version: 9, memoryId, sourcePath: '.agent-memory/CORE.md'}));
  writeFileSync(join(from, 'CONTROL.md'), '# Control Center\n');
  const binding: any = {state: 'ready', backend: 'control-folder', root: from, projectId: 'ops-id', profileId, memoryId, legacyRoots: []};
  writeFileSync(join(appData, 'control-profile', 'binding.json'), JSON.stringify({schemaVersion: 1, ...binding}));
  const portsFile = join(appData, 'ports.json');
  writeFileSync(portsFile, JSON.stringify([
    {id: 'ops-id', name: 'AgentsToZ-Control', folderPath: from, commandPath: join(from, 'run.command'), category: '프로젝트', favorite: true},
    {id: 'other', name: 'other', folderPath: join(parent, 'other')},
  ]));
  const calls = {relocate: 0, prepare: 0, leases: [] as string[], references: [] as Array<ReadonlyArray<readonly [string, string]>>, lsRemote: [] as string[], saves: 0, events: [] as string[]};
  const deps: OpsFolderMigrationDeps = {
    appDataDir: appData, homeDir: home, pid: process.pid, now: () => Date.parse('2026-09-29T01:02:03.004Z'),
    readBinding: () => ({...binding}),
    relocateBinding: async (a, b) => {
      calls.relocate++;
      if (binding.root === b) return;
      if (binding.root !== a) throw new Error('binding moved elsewhere');
      const marker = JSON.parse(readFileSync(join(b, CONTROL_PROFILE_MARKER), 'utf8'));
      if (marker.memoryId !== binding.memoryId) throw new Error('marker mismatch');
      binding.legacyRoots = [...binding.legacyRoots, a];
      binding.root = b;
    },
    loadPorts: async () => JSON.parse(readFileSync(portsFile, 'utf8')),
    savePorts: async request => { calls.saves++; writeFileSync(portsFile, JSON.stringify(request.ports)); },
    git: async (args, cwd) => {
      if (args[0] === 'ls-remote') {
        const url = args.at(-1)!;
        calls.lsRemote.push(url);
        calls.events.push(`ls-remote ${url}`);
        if (options.reachable === false) return {exitCode: 128, stdout: ''};
        return {exitCode: 0, stdout: (/AgentsToZ-OPS/.test(url) ? options.refs?.renamed : options.refs?.legacy) ?? REFS};
      }
      const result = run(['git', ...args], cwd);
      return {exitCode: result.exitCode ?? 1, stdout: result.stdout.toString()};
    },
    ...(options.gh ? {gh: async (args: string[]) => { calls.events.push(`gh ${args.join(' ')}`); return options.gh!(args); }} : {}),
    lsof: async () => options.lsof === undefined ? {exitCode: 0, stdout: `p1\nfcwd\nn/\np${process.pid}\nfcwd\nn${from}\n`} : options.lsof,
    sleep: async () => {},
    withLease: async (root, operation) => { calls.leases.push(root); if (options.leaseBusy) throw new Error('WORKSPACE_LEASE_BUSY'); return operation(); },
    relocateReferences: async aliases => { calls.references.push(aliases); },
    prepare: async () => { calls.prepare++; calls.events.push('prepare'); },
    onPhase: phase => { if (phase === options.crashAfter) throw new SimulatedCrash(phase); },
  };
  const journal = join(appData, 'control-profile', 'ops-folder-rename.json');
  const ports = () => JSON.parse(readFileSync(portsFile, 'utf8'));
  return {dir, appData, home, parent, realParent, from, to, profileId, memoryId, binding, deps, calls, journal, ports, portsFile};
}

function expectMigrated(f: ReturnType<typeof fixture>) {
  expect(existsSync(f.from)).toBe(false);
  expect(JSON.parse(readFileSync(join(f.to, CONTROL_PROFILE_MARKER), 'utf8')).memoryId).toBe(f.memoryId);
  expect(readFileSync(join(f.to, 'CONTROL.md'), 'utf8')).toBe('# Control Center\n');
  const [ops, other] = f.ports();
  expect(ops).toMatchObject({id: 'ops-id', name: 'AgentsToZ-OPS', role: 'ops', folderPath: f.to, commandPath: join(f.to, 'run.command'), favorite: true});
  expect(other).toEqual({id: 'other', name: 'other', folderPath: join(f.parent, 'other')});
  expect(f.binding.root).toBe(f.to);
  expect(f.binding.legacyRoots).toEqual([f.from]);
  expect(f.calls.references.at(-1)).toEqual([[f.from, f.to]]);
  expect(gitText(['config', '--local', '--get', 'agentstoz.repositoryKey'], f.to)).toBe('https://github.com/test-owner/agentstoz-control');
  expect(existsSync(f.journal)).toBe(false);
}

describe('OPS folder rename migration', () => {
  test('happy path: renames, rewrites the registration, relocates the profile, pins identity and follows the rename', async () => {
    const f = fixture();
    writeFileSync(join(f.from, 'uncommitted.txt'), 'a dirty tree is allowed\n');
    const result = await runOpsFolderMigration(f.deps);
    // The migration only pins the key; the renamed repository is probed and followed after the profile
    // is prepared (followUpOpsRepositoryOrigin), so a slow network never delays preparation. This used
    // to report origin 'updated' after an ls-remote that ran before preparation (review finding 12).
    expect(result).toMatchObject({status: 'migrated', from: f.from, to: f.to, origin: 'pending', prepared: true});
    expectMigrated(f);
    expect(readFileSync(join(f.to, 'uncommitted.txt'), 'utf8')).toBe('a dirty tree is allowed\n');
    expect(gitText(['remote', 'get-url', 'origin'], f.to)).toBe(LEGACY_URL);
    expect(f.calls.lsRemote).toEqual([]);
    expect(f.calls.leases).toEqual([f.from]);
    expect(await followUpOpsRepositoryOrigin(f.deps)).toBe('updated');
    expect(gitText(['remote', 'get-url', 'origin'], f.to)).toBe(RENAMED_URL);
    // Without gh, the two URLs had to list the same refs before origin moved.
    expect(f.calls.lsRemote).toEqual([LEGACY_URL, RENAMED_URL]);
    expect(f.calls.events.indexOf('prepare')).toBeLessThan(f.calls.events.findIndex(event => event.startsWith('ls-remote')));
    expect(f.calls.prepare).toBe(1);
    expect(f.calls.leases).toEqual([f.from, f.to]);
    const backups = readdirSync(f.appData).filter(name => name.startsWith('ports.json.before-ops-folder-rename-'));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(f.appData, backups[0]!), 'utf8'))[0].folderPath).toBe(f.from);
    expect(readdirSync(join(f.appData, 'control-profile')).some(name => name.startsWith('binding.json.before-ops-folder-rename-'))).toBe(true);
    expect(opsFolderMigrationLogLine(result)).toContain('AgentsToZ-OPS');
  });

  test('an unreachable renamed repository keeps origin and pins identity; a later boot follows the rename', async () => {
    const f = fixture({reachable: false});
    const result = await runOpsFolderMigration(f.deps);
    expect(result).toMatchObject({status: 'migrated', origin: 'pending'});
    expectMigrated(f);
    expect(gitText(['remote', 'get-url', 'origin'], f.to)).toBe(LEGACY_URL);
    expect(await followUpOpsRepositoryOrigin(f.deps)).toBe('pending');
    // Both URLs now answer with the same refs. (An empty listing no longer counts: it proves nothing.)
    const later = {...f.deps, git: async (args: string[], cwd: string) => args[0] === 'ls-remote' ? {exitCode: 0, stdout: REFS} : f.deps.git(args, cwd)};
    expect(await followUpOpsRepositoryOrigin(later)).toBe('updated');
    expect(gitText(['remote', 'get-url', 'origin'], f.to)).toBe('https://github.com/test-owner/AgentsToZ-OPS.git');
    expect(await followUpOpsRepositoryOrigin(later)).toBe('unchanged');
  });

  test('the remote format is preserved and other remotes or a non-GitHub origin are never touched', async () => {
    const ssh = fixture({origin: 'git@github.com:test-owner/AgentsToZ-Control.git'});
    run(['git', 'remote', 'add', 'backup', LEGACY_URL], ssh.from);
    expect((await runOpsFolderMigration(ssh.deps)).status).toBe('migrated');
    expect(await followUpOpsRepositoryOrigin(ssh.deps)).toBe('updated');
    expect(gitText(['remote', 'get-url', 'origin'], ssh.to)).toBe('git@github.com:test-owner/AgentsToZ-OPS.git');
    expect(gitText(['remote', 'get-url', 'backup'], ssh.to)).toBe(LEGACY_URL);

    const local = fixture({origin: null});
    expect(await runOpsFolderMigration(local.deps)).toMatchObject({status: 'migrated', origin: 'unchanged'});
    expect(gitText(['config', '--local', '--get', 'agentstoz.repositoryKey'], local.to)).toBe('');
    expect(local.calls.lsRemote).toEqual([]);
  });

  test('a preparation problem after the move is the profile\'s own state, not a failed rename', async () => {
    const f = fixture();
    f.deps.prepare = async () => { throw new Error('profile needs attention'); };
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'migrated', prepared: false});
    expectMigrated(f);
  });

  test('a rerun is idempotent: the renamed folder is current and nothing is touched again', async () => {
    const f = fixture();
    await runOpsFolderMigration(f.deps);
    const ports = readFileSync(f.portsFile, 'utf8');
    expect(await runOpsFolderMigration(f.deps)).toEqual({status: 'current'});
    expect(readFileSync(f.portsFile, 'utf8')).toBe(ports);
    expect(f.calls.prepare).toBe(1);
    expect(f.calls.relocate).toBe(1);
  });

  const skipCases: Array<[string, (f: ReturnType<typeof fixture>) => void | FixtureOptions, string]> = [
    ['no binding', f => { f.deps.readBinding = () => null; }, 'no-binding'],
    ['a local-only profile', f => { f.binding.backend = 'app-data'; }, 'not-control-folder'],
    ['a profile still preparing', f => { f.binding.state = 'preparing'; }, 'binding-not-ready'],
    ['the target already exists', f => { mkdirSync(f.to); }, 'target-exists'],
    ['a marker for another profile', f => { writeFileSync(join(f.from, CONTROL_PROFILE_MARKER), JSON.stringify({schemaVersion: 1, profileId: randomUUID(), memoryId: f.memoryId})); }, 'marker-mismatch'],
    ['a memory for another lineage', f => { writeFileSync(join(f.from, '.agent-memory', 'config.json'), JSON.stringify({memoryId: randomUUID()})); }, 'memory-mismatch'],
    ['no registration', f => { writeFileSync(f.portsFile, JSON.stringify([f.ports()[1]])); }, 'registration-mismatch'],
    ['a profile bound to no project', f => { f.binding.projectId = null; }, 'registration-mismatch'],
    ['a registration that names the folder only through another spelling', f => {
      // Same folder by realpath, but its stored path could not be rebased literally after the move.
      symlinkSync(f.parent, join(f.dir, 'product-link'));
      const rows = f.ports(); rows[0].folderPath = join(f.dir, 'product-link', 'AgentsToZ-Control'); writeFileSync(f.portsFile, JSON.stringify(rows));
    }, 'registration-mismatch'],
    ['two registrations with the bound id', f => { writeFileSync(f.portsFile, JSON.stringify([f.ports()[0], f.ports()[0]])); }, 'registration-mismatch'],
    ['a registration pointing elsewhere', f => { const rows = f.ports(); rows[0].folderPath = join(f.parent, 'other'); mkdirSync(rows[0].folderPath); writeFileSync(f.portsFile, JSON.stringify(rows)); }, 'registration-mismatch'],
    ['a linked worktree', f => {
      run(['git', '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'init'], f.from);
      run(['git', 'worktree', 'add', '-q', join(f.parent, 'ops-feature')], f.from);
    }, 'linked-worktrees'],
    ['an unavailable process check', f => { f.deps.lsof = async () => null; }, 'process-check-unavailable'],
    ['a failing process check', f => { f.deps.lsof = async () => ({exitCode: 1, stdout: ''}); }, 'process-check-unavailable'],
    ['another process inside the folder', f => { f.deps.lsof = async () => ({exitCode: 0, stdout: `p${process.pid}\nfcwd\nn/\np424242\nfcwd\nn${join(f.from, 'docs')}\n`}); }, 'folder-in-use'],
    ['a busy workspace lease', f => { f.deps.withLease = async () => { throw new Error('WORKSPACE_LEASE_BUSY'); }; }, 'workspace-busy'],
    ['an interrupted profile attach', f => { writeFileSync(join(f.appData, 'control-profile', 'attach-transition.json'), '{}'); }, 'attach-pending'],
  ];
  for (const [name, arrange, reason] of skipCases) {
    test(`skips and retries next boot: ${name}`, async () => {
      const f = fixture();
      arrange(f);
      const ports = readFileSync(f.portsFile, 'utf8');
      const result = await runOpsFolderMigration(f.deps);
      expect(result).toMatchObject({status: 'skipped', reason});
      expect(existsSync(f.from)).toBe(true);
      expect(readFileSync(f.portsFile, 'utf8')).toBe(ports);
      expect(existsSync(f.journal)).toBe(false);
      expect(f.calls.prepare).toBe(0);
      // A profile without a Control folder is a steady state, not news worth a line every boot.
      const line = opsFolderMigrationLogLine(result);
      if (reason === 'no-binding' || reason === 'not-control-folder') expect(line).toBeNull();
      else expect(line).toContain(reason);
    });
  }

  test('a custom folder name or an already renamed folder is left alone', async () => {
    const custom = fixture({folderName: 'My-Operations'});
    expect(await runOpsFolderMigration(custom.deps)).toMatchObject({status: 'skipped', reason: 'custom-folder-name'});
    expect(existsSync(custom.from)).toBe(true);
    expect(opsFolderMigrationLogLine({status: 'skipped', reason: 'custom-folder-name', from: custom.from})).toBeNull();
    const current = fixture({folderName: 'AgentsToZ-OPS'});
    expect(await runOpsFolderMigration(current.deps)).toEqual({status: 'current'});
    expect(opsFolderMigrationLogLine({status: 'current'})).toBeNull();
  });

  for (const phase of OPS_FOLDER_MIGRATION_PHASES) {
    test(`an interruption after «${phase}» rolls forward on the next boot`, async () => {
      const f = fixture({crashAfter: phase});
      const interrupted = await runOpsFolderMigration(f.deps);
      expect(interrupted.status).toBe('failed');
      expect(existsSync(f.journal)).toBe(true);
      expect(JSON.parse(readFileSync(f.journal, 'utf8')).phase).toBe(phase);
      expect(f.calls.prepare).toBe(0);
      f.deps.onPhase = undefined;
      const resumed = await runOpsFolderMigration(f.deps);
      expect(resumed).toMatchObject({status: 'migrated', from: f.from, to: f.to, prepared: true});
      expectMigrated(f);
      // A resumed run is still a migrating boot: no network before preparation (review finding 12).
      expect(f.calls.lsRemote).toEqual([]);
      expect(await followUpOpsRepositoryOrigin(f.deps)).toBe('updated');
      expect(gitText(['remote', 'get-url', 'origin'], f.to)).toBe(RENAMED_URL);
      expect(f.calls.prepare).toBe(1);
    });
  }

  test('a rename the file system refuses moves nothing, and the next boot starts over', async () => {
    const f = fixture();
    f.deps.fs = {...nodeFs, renameSync: (a: nodeFs.PathLike, b: nodeFs.PathLike) => {
      if (String(a) === f.from) throw Object.assign(new Error('EACCES'), {code: 'EACCES'});
      nodeFs.renameSync(a, b);
    }};
    expect(await runOpsFolderMigration(f.deps)).toEqual({status: 'failed', code: 'EACCES'});
    expect(existsSync(f.from)).toBe(true);
    expect(existsSync(f.to)).toBe(false);
    expect(JSON.parse(readFileSync(f.journal, 'utf8')).phase).toBe('planned');
    expect(f.binding.root).toBe(f.from);
    f.deps.fs = undefined;
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'migrated'});
    expectMigrated(f);
  });

  test('a rename that keeps failing keeps one backup per file: the one taken right before the latest attempt', async () => {
    const f = fixture();
    f.deps.fs = {...nodeFs, renameSync: (a: nodeFs.PathLike, b: nodeFs.PathLike) => {
      if (String(a) === f.from) throw Object.assign(new Error('EACCES'), {code: 'EACCES'});
      nodeFs.renameSync(a, b);
    }};
    let clock = Date.parse('2026-09-29T01:02:03.004Z');
    f.deps.now = () => clock;
    const backups = () => ({
      ports: readdirSync(f.appData).filter(name => name.startsWith('ports.json.before-ops-folder-rename-')),
      binding: readdirSync(join(f.appData, 'control-profile')).filter(name => name.startsWith('binding.json.before-ops-folder-rename-')),
    });
    for (let boot = 0; boot < 3; boot += 1) {
      expect(await runOpsFolderMigration(f.deps)).toEqual({status: 'failed', code: 'EACCES'});
      clock += 60_000;
    }
    expect(backups()).toEqual({
      ports: ['ports.json.before-ops-folder-rename-2026-09-29T01-04-03-004Z'],
      binding: ['binding.json.before-ops-folder-rename-2026-09-29T01-04-03-004Z'],
    });
    f.deps.fs = undefined;
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'migrated'});
    expect(backups()).toEqual({
      ports: ['ports.json.before-ops-folder-rename-2026-09-29T01-05-03-004Z'],
      binding: ['binding.json.before-ops-folder-rename-2026-09-29T01-05-03-004Z'],
    });
    expect(JSON.parse(readFileSync(join(f.appData, backups().ports[0]!), 'utf8'))[0].folderPath).toBe(f.from);
  });

  test('an interruption before the rename starts over with every precondition checked again', async () => {
    const f = fixture({crashAfter: 'planned'});
    await runOpsFolderMigration(f.deps);
    f.deps.onPhase = undefined;
    f.deps.lsof = async () => ({exitCode: 0, stdout: `p424242\nfcwd\nn${f.from}\n`});
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'skipped', reason: 'folder-in-use'});
    expect(existsSync(f.from)).toBe(true);
    expect(existsSync(f.journal)).toBe(false);
  });

  test('both folders present after an interruption stops for a person and deletes or merges nothing', async () => {
    const f = fixture({crashAfter: 'ports'});
    await runOpsFolderMigration(f.deps);
    f.deps.onPhase = undefined;
    mkdirSync(f.from);
    writeFileSync(join(f.from, 'new-work.md'), 'someone wrote here\n');
    const result = await runOpsFolderMigration(f.deps);
    expect(result).toMatchObject({status: 'needs-attention', code: 'OPS_FOLDER_MIGRATION_BOTH_EXIST'});
    expect(readFileSync(join(f.from, 'new-work.md'), 'utf8')).toBe('someone wrote here\n');
    expect(readFileSync(join(f.to, 'CONTROL.md'), 'utf8')).toBe('# Control Center\n');
    expect(existsSync(f.journal)).toBe(true);
    expect(f.binding.root).toBe(f.from);
    expect(opsFolderMigrationLogLine(result)).toContain('OPS_FOLDER_MIGRATION_BOTH_EXIST');
  });

  test('both folders missing or a foreign folder at the target also stop for a person', async () => {
    const missing = fixture({crashAfter: 'renamed'});
    await runOpsFolderMigration(missing.deps);
    missing.deps.onPhase = undefined;
    rmSync(missing.to, {recursive: true});
    expect(await runOpsFolderMigration(missing.deps)).toMatchObject({status: 'needs-attention', code: 'OPS_FOLDER_MIGRATION_FOLDER_MISSING'});

    const foreign = fixture({crashAfter: 'renamed'});
    await runOpsFolderMigration(foreign.deps);
    foreign.deps.onPhase = undefined;
    writeFileSync(join(foreign.to, CONTROL_PROFILE_MARKER), JSON.stringify({schemaVersion: 1, profileId: randomUUID(), memoryId: randomUUID()}));
    expect(await runOpsFolderMigration(foreign.deps)).toMatchObject({status: 'needs-attention', code: 'OPS_FOLDER_MIGRATION_TARGET_MISMATCH'});
  });

  test('a corrupt journal is reported and kept', async () => {
    const f = fixture();
    writeFileSync(f.journal, '{"schemaVersion":1,"from":"relative"}');
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'needs-attention', code: 'OPS_FOLDER_MIGRATION_JOURNAL_INVALID'});
    expect(existsSync(f.from)).toBe(true);
    expect(readFileSync(f.journal, 'utf8')).toContain('relative');
  });

  test('journal aliases other than the renamed folder (and its real path) are refused before any row moves', async () => {
    const tampered = (f: ReturnType<typeof fixture>, aliases: unknown) => {
      const journal = JSON.parse(readFileSync(f.journal, 'utf8'));
      writeFileSync(f.journal, JSON.stringify({...journal, aliases}));
    };
    for (const aliases of [
      (f: ReturnType<typeof fixture>) => [[f.from, f.to], [join(f.parent, 'other'), f.to]],
      (f: ReturnType<typeof fixture>) => [[join(f.parent, 'other'), f.to]],
      (f: ReturnType<typeof fixture>) => [[f.from, join(f.parent, 'elsewhere')]],
      (f: ReturnType<typeof fixture>) => [[f.from, f.to], [join(f.dir, 'AgentsToZ-Control'), join(f.dir, 'AgentsToZ-OPS')]],
    ]) {
      const f = fixture({crashAfter: 'renamed'});
      await runOpsFolderMigration(f.deps);
      f.deps.onPhase = undefined;
      tampered(f, aliases(f));
      const ports = readFileSync(f.portsFile, 'utf8');
      expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'needs-attention', code: 'OPS_FOLDER_MIGRATION_JOURNAL_INVALID'});
      expect(readFileSync(f.portsFile, 'utf8')).toBe(ports);
      expect(f.binding.root).toBe(f.from);
    }
  });

  test('re-review L1: a real-path alias that differs only in letter case still resumes', async () => {
    // macOS volumes are case-insensitive and realpath returns the on-disk case.
    const f = fixture({crashAfter: 'renamed'});
    await runOpsFolderMigration(f.deps);
    f.deps.onPhase = undefined;
    const journal = JSON.parse(readFileSync(f.journal, 'utf8'));
    const realParent = realpathSync(dirname(f.from));
    writeFileSync(f.journal, JSON.stringify({...journal, aliases: [[f.from, f.to], [join(realParent, 'agentstoz-control'), join(realParent, 'AgentsToZ-OPS')]]}));
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'migrated', from: f.from, to: f.to});
  });

  test('a folder reached through a symlinked parent resumes with its real-path alias and rebases both spellings', async () => {
    const f = fixture({crashAfter: 'renamed', viaLink: true});
    await runOpsFolderMigration(f.deps);
    const journal = JSON.parse(readFileSync(f.journal, 'utf8'));
    expect(journal.aliases).toEqual([[f.from, f.to], [join(f.realParent, 'AgentsToZ-Control'), join(f.realParent, 'AgentsToZ-OPS')]]);
    f.deps.onPhase = undefined;
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'migrated', from: f.from, to: f.to});
    expect(f.calls.references.at(-1)).toEqual(journal.aliases);
    expect(f.ports()[0]).toMatchObject({folderPath: f.to, name: 'AgentsToZ-OPS'});
  });

  test('a second run while one is in progress stops at the migration lock instead of rolling forward beside it', async () => {
    const f = fixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const relocate = f.deps.relocateBinding;
    const first = runOpsFolderMigration({...f.deps, relocateBinding: async (a, b) => { entered(); await gate; return relocate(a, b); }});
    await inside;
    // A second sidecar sees the journal of a moved folder; resuming now would race the first.
    const second = await runOpsFolderMigration(f.deps);
    expect(second).toMatchObject({status: 'skipped', reason: 'migration-busy'});
    expect(opsFolderMigrationLogLine(second)).toContain('migration-busy');
    release();
    expect(await first).toMatchObject({status: 'migrated'});
    expectMigrated(f);
    expect(f.calls.relocate).toBe(1);
    expect(f.calls.prepare).toBe(1);
    // The lock is released: a later boot runs normally.
    expect(await runOpsFolderMigration(f.deps)).toEqual({status: 'current'});
  });
});

const pinnedKey = (root: string) => gitText(['config', '--local', '--get', 'agentstoz.repositoryKey'], root);

describe('the OPS row\'s GitHub link follows the renamed repository (display only)', () => {
  const opsRow = (f: ReturnType<typeof fixture>) => f.ports().find((row: any) => row.id === 'ops-id');
  const withLink = (f: ReturnType<typeof fixture>, githubUrl: string) =>
    writeFileSync(f.portsFile, JSON.stringify(f.ports().map((row: any) => row.id === 'ops-id' ? {...row, githubUrl} : row)));
  test('after the move, a legacy link of the same owner becomes the AgentsToZ-OPS link, once', async () => {
    const f = fixture();
    withLink(f, 'https://github.com/test-owner/AgentsToZ-Control');
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'migrated'});
    run(['git', 'remote', 'set-url', 'origin', RENAMED_URL], f.to);
    expect(await normalizeOpsGithubUrl(f.deps)).toBe('updated');
    expect(opsRow(f).githubUrl).toBe('https://github.com/test-owner/AgentsToZ-OPS');
    expect(await normalizeOpsGithubUrl(f.deps)).toBe('unchanged');
  });
  test('the repository list follows too, even after githubUrl alone was already renamed (2026-10-02)', async () => {
    // A row left as githubUrl: AgentsToZ-OPS + githubUrls: [AgentsToZ-Control] stopped auto upload for every project.
    const f = fixture();
    await runOpsFolderMigration(f.deps);
    run(['git', 'remote', 'set-url', 'origin', RENAMED_URL], f.to);
    writeFileSync(f.portsFile, JSON.stringify(f.ports().map((row: any) => row.id === 'ops-id'
      ? {...row, githubUrl: 'https://github.com/test-owner/AgentsToZ-OPS', githubUrls: ['https://github.com/test-owner/AgentsToZ-Control', 'https://github.com/test-owner/AgentsToZ-OPS']}
      : row)));
    expect(await normalizeOpsGithubUrl(f.deps)).toBe('updated');
    expect(opsRow(f).githubUrls).toEqual(['https://github.com/test-owner/AgentsToZ-OPS']);
    expect(await normalizeOpsGithubUrl(f.deps)).toBe('unchanged');
  });
  test('nothing changes while origin is still legacy, or when the link is another repository or owner', async () => {
    const f = fixture();
    withLink(f, 'https://github.com/test-owner/AgentsToZ-Control');
    await runOpsFolderMigration(f.deps);
    run(['git', 'remote', 'set-url', 'origin', LEGACY_URL], f.to);
    expect(await normalizeOpsGithubUrl(f.deps)).toBe('unchanged');
    run(['git', 'remote', 'set-url', 'origin', RENAMED_URL], f.to);
    for (const link of ['https://github.com/someone-else/AgentsToZ-Control', 'https://github.com/test-owner/other-repo']) {
      withLink(f, link);
      expect(await normalizeOpsGithubUrl(f.deps)).toBe('unchanged');
      expect(opsRow(f).githubUrl).toBe(link);
    }
  });
});

describe('a boot-time git child in the folder is not a user holding it', () => {
  // Live 2026-09-29: the first v542 boot deferred with folder-in-use because the sidecar's own boot
  // work had a short-lived `git` process inside the OPS folder at the instant of the lsof check.
  test('a blocker that disappears within the re-check window does not defer the rename', async () => {
    const f = fixture();
    let calls = 0;
    f.deps.lsof = async () => ({exitCode: 0, stdout: ++calls <= 2 ? `p3009\ncgit\nfcwd\nn${f.from}\n` : ''});
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'migrated', from: f.from, to: f.to});
    expect(calls).toBe(3);
  });

  test('a blocker that stays (an open Workroom) still defers, after a bounded number of checks', async () => {
    const f = fixture();
    let calls = 0; const waits: number[] = [];
    f.deps.lsof = async () => { calls++; return {exitCode: 0, stdout: `p81510\ncagy\nfcwd\nn${f.from}\n`}; };
    f.deps.sleep = async ms => { waits.push(ms); };
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'skipped', reason: 'folder-in-use', blocking: [{pid: 81510, command: 'agy'}]});
    expect(existsSync(f.from)).toBe(true);
    expect(calls).toBe(OPS_FOLDER_IN_USE_CHECKS);
    expect(waits).toHaveLength(OPS_FOLDER_IN_USE_CHECKS - 1);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(3_000);
  });
});

describe('the lineage key is pinned whatever the rename waits for', () => {
  // Review finding 1: git's «repository moved» hint or `gh repo rename` can switch origin before this
  // Mac migrates (an open OPS Workroom keeps the folder in use), and an unpinned claim then presents a
  // new key for the same memory_id — every push, pull and profile sync fails on the registry.
  test('a rename that must wait still pins the key while origin is the legacy URL', async () => {
    const f = fixture();
    f.deps.lsof = async () => ({exitCode: 0, stdout: `p424242\nfcwd\nn${f.from}\n`});
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'skipped', reason: 'folder-in-use'});
    expect(existsSync(f.from)).toBe(true);
    expect(pinnedKey(f.from)).toBe(LEGACY_KEY);
    run(['git', 'remote', 'set-url', 'origin', RENAMED_URL], f.from);
    expect(projectRepositoryKey(f.from)).toBe(LEGACY_KEY);
  });

  test('any bound OPS whose origin is still legacy is pinned, whatever else holds the rename', async () => {
    // Restored under the new name by a newer app, origin still the seed URL.
    const current = fixture({folderName: 'AgentsToZ-OPS'});
    expect(await runOpsFolderMigration(current.deps)).toEqual({status: 'current'});
    expect(pinnedKey(current.from)).toBe(LEGACY_KEY);
    const busy = fixture({leaseBusy: true});
    expect(await runOpsFolderMigration(busy.deps)).toMatchObject({status: 'skipped', reason: 'workspace-busy'});
    expect(pinnedKey(busy.from)).toBe(LEGACY_KEY);
    const preparing = fixture();
    preparing.binding.state = 'preparing';
    expect(await runOpsFolderMigration(preparing.deps)).toMatchObject({status: 'skipped', reason: 'binding-not-ready'});
    expect(pinnedKey(preparing.from)).toBe(LEGACY_KEY);
  });

  test('nothing else is pinned: a renamed or foreign origin, a local profile, or an existing pin', async () => {
    // Origin already follows the rename: which key the lineage has is the registry's answer (claim time).
    const renamed = fixture({origin: RENAMED_URL});
    expect(await runOpsFolderMigration(renamed.deps)).toMatchObject({status: 'migrated', origin: 'unchanged'});
    expect(pinnedKey(renamed.to)).toBe('');
    const foreign = fixture({origin: 'https://gitlab.com/test-owner/AgentsToZ-Control.git'});
    foreign.deps.lsof = async () => ({exitCode: 0, stdout: `p424242\nfcwd\nn${foreign.from}\n`});
    await runOpsFolderMigration(foreign.deps);
    expect(pinnedKey(foreign.from)).toBe('');
    const local = fixture();
    local.binding.backend = 'app-data';
    expect(await runOpsFolderMigration(local.deps)).toMatchObject({status: 'skipped', reason: 'not-control-folder'});
    expect(pinnedKey(local.from)).toBe('');
    const pinned = fixture();
    run(['git', 'config', '--local', 'agentstoz.repositoryKey', 'https://github.com/test-owner/older-name'], pinned.from);
    pinned.deps.lsof = async () => ({exitCode: 0, stdout: `p424242\nfcwd\nn${pinned.from}\n`});
    await runOpsFolderMigration(pinned.deps);
    expect(pinnedKey(pinned.from)).toBe('https://github.com/test-owner/older-name');
  });
});

describe('origin follows the rename only to the same repository', () => {
  // Review finding 3: an answering `<owner>/AgentsToZ-OPS` is not proof — the user may have created a
  // new repository under that name, or another Mac's OPS may own one.
  const view = (id: string, url: string) => ({exitCode: 0, stdout: JSON.stringify({id, url})});
  async function migrated(options: FixtureOptions) {
    const f = fixture(options);
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'migrated', origin: 'pending'});
    return f;
  }

  test('gh: the legacy path resolves to the renamed URL (GitHub followed the rename)', async () => {
    const f = await migrated({gh: args => args[2] === 'test-owner/AgentsToZ-Control' ? view('R_1', 'https://github.com/test-owner/AgentsToZ-OPS') : null});
    expect(await followUpOpsRepositoryOrigin(f.deps)).toBe('updated');
    expect(gitText(['remote', 'get-url', 'origin'], f.to)).toBe(RENAMED_URL);
    expect(f.calls.lsRemote).toEqual([]);
  });

  test('gh: both names are one node id', async () => {
    const f = await migrated({gh: args => args[2] === 'test-owner/AgentsToZ-Control'
      ? view('R_1', 'https://github.com/test-owner/AgentsToZ-Control')
      : view('R_1', 'https://github.com/test-owner/AgentsToZ-OPS')});
    expect(await followUpOpsRepositoryOrigin(f.deps)).toBe('updated');
    expect(gitText(['remote', 'get-url', 'origin'], f.to)).toBe(RENAMED_URL);
  });

  test('gh: two different repositories keep origin and say so; the key stays pinned', async () => {
    const f = await migrated({gh: args => args[2] === 'test-owner/AgentsToZ-Control'
      ? view('R_1', 'https://github.com/test-owner/AgentsToZ-Control')
      : view('R_2', 'https://github.com/test-owner/AgentsToZ-OPS')});
    const origin = await followUpOpsRepositoryOrigin(f.deps);
    expect(origin).toBe('unverified');
    expect(opsOriginFollowUpLogLine(origin)).toContain('origin');
    expect(gitText(['remote', 'get-url', 'origin'], f.to)).toBe(LEGACY_URL);
    expect(pinnedKey(f.to)).toBe(LEGACY_KEY);
    expect(f.calls.lsRemote).toEqual([]);
  });

  test('gh: a renamed repository that does not answer yet leaves origin for a later boot', async () => {
    const f = await migrated({gh: args => args[2] === 'test-owner/AgentsToZ-Control' ? view('R_1', 'https://github.com/test-owner/AgentsToZ-Control') : {exitCode: 1, stdout: ''}});
    expect(await followUpOpsRepositoryOrigin(f.deps)).toBe('pending');
    expect(gitText(['remote', 'get-url', 'origin'], f.to)).toBe(LEGACY_URL);
  });

  test('without gh (or when it cannot answer), both URLs must list the same non-empty refs', async () => {
    const offline = await migrated({gh: () => ({exitCode: 1, stdout: ''})});
    expect(await followUpOpsRepositoryOrigin(offline.deps)).toBe('updated');
    expect(offline.calls.lsRemote).toEqual([LEGACY_URL, RENAMED_URL]);
    const other = await migrated({refs: {renamed: 'ffffffffffffffffffffffffffffffffffffffff\tHEAD\nffffffffffffffffffffffffffffffffffffffff\trefs/heads/main\n'}});
    expect(await followUpOpsRepositoryOrigin(other.deps)).toBe('unverified');
    expect(gitText(['remote', 'get-url', 'origin'], other.to)).toBe(LEGACY_URL);
    const empty = await migrated({refs: {legacy: '', renamed: ''}});
    expect(await followUpOpsRepositoryOrigin(empty.deps)).toBe('unverified');
    expect(gitText(['remote', 'get-url', 'origin'], empty.to)).toBe(LEGACY_URL);
    expect(opsOriginFollowUpLogLine('pending')).toBeNull();
    expect(opsOriginFollowUpLogLine('updated')).toContain('origin');
  });
});

describe('trust follows the folder, additively', () => {
  test('Codex and Antigravity gain the new path only when the old one was trusted; Claude settings are never edited', async () => {
    const f = fixture();
    mkdirSync(join(f.home, '.codex'));
    const codex = `model = "gpt-5"\n\n[projects."${f.from}"]\ntrust_level = "trusted"\n\n[projects."/elsewhere"]\ntrust_level = "untrusted"\n`;
    writeFileSync(join(f.home, '.codex', 'config.toml'), codex);
    mkdirSync(join(f.home, '.gemini', 'antigravity-cli'), {recursive: true});
    writeFileSync(join(f.home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({theme: 'dark', trustedWorkspaces: [f.from, '/elsewhere'], nested: {keep: true}}, null, 2));
    const claude = JSON.stringify({projects: {[f.from]: {hasTrustDialogAccepted: true}}});
    writeFileSync(join(f.home, '.claude.json'), claude);
    const result = await runOpsFolderMigration(f.deps);
    expect(result).toMatchObject({status: 'migrated', trust: {codex: 'added', antigravity: 'added'}});
    const codexAfter = readFileSync(join(f.home, '.codex', 'config.toml'), 'utf8');
    expect(codexAfter.startsWith(codex)).toBe(true);
    expect(codexAfter.slice(codex.length)).toBe(`\n[projects."${f.to}"]\ntrust_level = "trusted"\n`);
    const antigravity = JSON.parse(readFileSync(join(f.home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
    expect(antigravity).toEqual({theme: 'dark', trustedWorkspaces: [f.from, '/elsewhere', f.to], nested: {keep: true}});
    expect(readFileSync(join(f.home, '.claude.json'), 'utf8')).toBe(claude);
    expect(opsFolderMigrationLogLine(result)).toContain('Claude');
  });

  test('nothing is written when the old path was not trusted, the new one already is, or the files are absent', async () => {
    const untrusted = fixture();
    mkdirSync(join(untrusted.home, '.codex'));
    const codex = `[projects."${untrusted.from}"]\ntrust_level = "untrusted"\n`;
    writeFileSync(join(untrusted.home, '.codex', 'config.toml'), codex);
    expect(await runOpsFolderMigration(untrusted.deps)).toMatchObject({status: 'migrated', trust: {codex: 'unchanged', antigravity: 'unchanged'}});
    expect(readFileSync(join(untrusted.home, '.codex', 'config.toml'), 'utf8')).toBe(codex);
    expect(existsSync(join(untrusted.home, '.gemini'))).toBe(false);

    const both = fixture();
    mkdirSync(join(both.home, '.codex'));
    const already = `[projects.'${both.from}']\ntrust_level = "trusted"\n[projects."${both.to}"]\ntrust_level = "trusted"`;
    writeFileSync(join(both.home, '.codex', 'config.toml'), already);
    expect(await runOpsFolderMigration(both.deps)).toMatchObject({status: 'migrated', trust: {codex: 'unchanged'}});
    expect(readFileSync(join(both.home, '.codex', 'config.toml'), 'utf8')).toBe(already);
  });

  // Live 2026-09-29 (v543): Codex keys hook approval by path too ([hooks.state."<root>/.codex/hooks.json:…"]),
  // so an OPS Workroom at the new path stopped at 「Hooks need review」 although the project was trusted.
  test('Codex hook approvals follow the folder (same file, same hash), additively and once', async () => {
    const f = fixture();
    mkdirSync(join(f.home, '.codex'));
    const hook = (root: string) => `[hooks.state."${root}/.codex/hooks.json:user_prompt_submit:0:0"]\ntrusted_hash = "sha256:abc123"\n`;
    const codex = `[projects."${f.from}"]\ntrust_level = "trusted"\n\n${hook(f.from)}\n[hooks.state."/elsewhere/.codex/hooks.json:x:0:0"]\ntrusted_hash = "sha256:zzz"\n`;
    writeFileSync(join(f.home, '.codex', 'config.toml'), codex);
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'migrated', trust: {codex: 'added'}});
    const after = readFileSync(join(f.home, '.codex', 'config.toml'), 'utf8');
    expect(after.startsWith(codex)).toBe(true);
    expect(after).toContain(`[projects."${f.to}"]\ntrust_level = "trusted"`);
    expect(after).toContain(`[hooks.state."${f.to}/.codex/hooks.json:user_prompt_submit:0:0"]\ntrusted_hash = "sha256:abc123"`);
    expect(after).not.toContain('/elsewhere/.codex/hooks.json:x:0:0"]\ntrusted_hash = "sha256:zzz"\n\n[hooks.state."/elsewhere');
    expect(after.split(`[hooks.state."${f.to}/`).length).toBe(2);
  });

  test('a Mac that already moved gets the missing hook approval at the next boot, and never twice', async () => {
    const f = fixture();
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'migrated'});
    // The v543 state: project trust copied, hook approval only under the old path.
    mkdirSync(join(f.home, '.codex'));
    const hook = (root: string) => `[hooks.state."${root}/.codex/hooks.json:user_prompt_submit:0:0"]\ntrusted_hash = "sha256:abc123"\n`;
    const codex = `[projects."${f.from}"]\ntrust_level = "trusted"\n\n${hook(f.from)}\n[projects."${f.to}"]\ntrust_level = "trusted"\n`;
    writeFileSync(join(f.home, '.codex', 'config.toml'), codex);
    const moved = {...f.deps, readBinding: () => ({state: 'ready', backend: 'control-folder', root: f.to, projectId: 'ops-id', profileId: 'p', memoryId: 'm', legacyRoots: [f.from]} as any)};
    expect(await topUpOpsTrust(moved)).toMatchObject({codex: 'added'});
    const after = readFileSync(join(f.home, '.codex', 'config.toml'), 'utf8');
    expect(after).toBe(`${codex}\n${hook(f.to)}`);
    expect(await topUpOpsTrust(moved)).toMatchObject({codex: 'unchanged'});
    expect(readFileSync(join(f.home, '.codex', 'config.toml'), 'utf8')).toBe(after);
  });

  // A second [projects."<to>"] table is a TOML error that breaks Codex's whole config, so any
  // existing definition of the new path — however it is spelled — means nothing is appended.
  test('the new path is never defined twice in Codex config, whatever spelling defines it already', async () => {
    for (const existing of [
      (to: string) => `[projects."${to}"] # added by hand\ntrust_level = "trusted"\n`,
      (to: string) => `[ projects . "${to}" ]\ntrust_level = "untrusted"\n`,
      (to: string) => `projects."${to}".trust_level = "trusted"\n`,
      (to: string) => `[projects]\n"${to}" = { trust_level = "trusted" }\n`,
    ]) {
      const f = fixture();
      mkdirSync(join(f.home, '.codex'));
      const codex = `${existing(f.to)}\n[projects."${f.from}"]\ntrust_level = "trusted"\n`;
      writeFileSync(join(f.home, '.codex', 'config.toml'), codex);
      expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'migrated', trust: {codex: 'unchanged'}});
      expect(readFileSync(join(f.home, '.codex', 'config.toml'), 'utf8')).toBe(codex);
    }
  });

  test('an old path whose header carries a comment or spacing still counts as trusted', async () => {
    const f = fixture();
    mkdirSync(join(f.home, '.codex'));
    const codex = `[ projects."${f.from}" ] # the OPS folder\ntrust_level = "trusted"\n`;
    writeFileSync(join(f.home, '.codex', 'config.toml'), codex);
    expect(await runOpsFolderMigration(f.deps)).toMatchObject({status: 'migrated', trust: {codex: 'added'}});
    expect(readFileSync(join(f.home, '.codex', 'config.toml'), 'utf8')).toBe(`${codex}\n[projects."${f.to}"]\ntrust_level = "trusted"\n`);
  });
});

describe('the migration with the real profile store', () => {
  test('relocates the binding and prepares ready at AgentsToZ-OPS', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ops-migration-host-')));
    dirs.push(dir);
    const from = join(dir, 'AgentsToZ-Control'), to = join(dir, 'AgentsToZ-OPS'), data = join(dir, 'data');
    mkdirSync(from);
    run(['git', 'init', '-q'], from);
    writeFileSync(join(from, 'CONTROL.md'), 'Control');
    initializeProjectMemory({folderPath: from, projectName: 'Control', agent: 'codex', autoBackup: false});
    let rows: any[] = [{id: 'ops-id', name: 'AgentsToZ-Control', folderPath: from}];
    const host = createControlProfileHost({appDataDir: data, portalDataFile: join(dir, 'portal.json'), gitPath: 'git', ghPath: 'gh',
      registered: async () => rows, register: async () => 'ops-id', lease: async (_root, _label, operation) => operation()});
    const before = await host.prepare();
    expect(before.state).toBe('ready');
    const result = await runOpsFolderMigration({
      appDataDir: data, homeDir: join(dir, 'home'), pid: process.pid,
      readBinding: () => host.store.boundLocation(), relocateBinding: (a, b) => host.store.relocate(a, b),
      loadPorts: async () => rows, savePorts: async request => { rows = request.ports; },
      git: async (args, cwd) => { const result = run(['git', ...args], cwd); return {exitCode: result.exitCode ?? 1, stdout: result.stdout.toString()}; },
      lsof: async () => ({exitCode: 0, stdout: ''}), withLease: async (_root, operation) => operation(),
      relocateReferences: async () => {}, prepare: () => host.prepare(),
    });
    expect(result).toMatchObject({status: 'migrated', prepared: true});
    const after = host.store.status();
    expect(after).toMatchObject({state: 'ready', profileId: before.profileId, memoryId: before.memoryId, projectId: 'ops-id', backend: 'control-folder'});
    expect(host.store.read().binding.root).toBe(to);
    expect(host.store.boundLocation()?.legacyRoots).toEqual([from]);
    expect(rows[0]).toMatchObject({name: 'AgentsToZ-OPS', role: 'ops', folderPath: to});
    expect(host.recall('anything').profile.state).toBe('ready');
  });

  test('a relocation refused once still ends with the old root in the history', async () => {
    // The review's probe: the binding step fails once (its lock was busy) after the registration was
    // rewritten, the same boot's preparation re-finds the folder at its new path, and the next boot
    // finishes the rename. Voice records made at the old path depend on legacyRoots keeping it.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ops-migration-host-')));
    dirs.push(dir);
    const from = join(dir, 'AgentsToZ-Control'), to = join(dir, 'AgentsToZ-OPS'), data = join(dir, 'data');
    mkdirSync(from);
    run(['git', 'init', '-q'], from);
    writeFileSync(join(from, 'CONTROL.md'), 'Control');
    initializeProjectMemory({folderPath: from, projectName: 'Control', agent: 'codex', autoBackup: false});
    let rows: any[] = [{id: 'ops-id', name: 'AgentsToZ-Control', folderPath: from}];
    const host = createControlProfileHost({appDataDir: data, portalDataFile: join(dir, 'portal.json'), gitPath: 'git', ghPath: 'gh',
      registered: async () => rows, register: async () => 'ops-id', lease: async (_root, _label, operation) => operation()});
    expect((await host.prepare()).state).toBe('ready');
    let refuse = true;
    const deps: OpsFolderMigrationDeps = {
      appDataDir: data, homeDir: join(dir, 'home'), pid: process.pid,
      readBinding: () => host.store.boundLocation(),
      relocateBinding: async (a, b) => { if (refuse) { refuse = false; throw new Error('prepare.lock busy'); } return host.store.relocate(a, b); },
      loadPorts: async () => rows, savePorts: async request => { rows = request.ports; },
      git: async (args, cwd) => { const result = run(['git', ...args], cwd); return {exitCode: result.exitCode ?? 1, stdout: result.stdout.toString()}; },
      lsof: async () => ({exitCode: 0, stdout: ''}), withLease: async (_root, operation) => operation(),
      relocateReferences: async () => {}, prepare: () => host.prepare(),
    };
    expect((await runOpsFolderMigration(deps)).status).toBe('failed');
    expect((await host.prepare()).state).toBe('ready');
    expect(await runOpsFolderMigration(deps)).toMatchObject({status: 'migrated', prepared: true});
    expect(host.store.boundLocation()).toMatchObject({root: to, legacyRoots: [from]});
  });
});

describe('boot: the migration belongs to the packaged app, and preparation always runs', () => {
  // Review finding 4: a source or worktree server (`bun api-server.ts` for the smoke tests,
  // `API_PORT=… bun api-server.ts`) shares the real app data, so unreleased code performed the one-way
  // rename of the user's real OPS folder. Only the packaged sidecar migrates unless a server opts in.
  test('the gate: a packaged sidecar, or a source server that opts in explicitly', () => {
    expect(opsFolderMigrationAllowed({bundledSidecar: true, env: {}})).toBe(true);
    expect(opsFolderMigrationAllowed({bundledSidecar: false, env: {}})).toBe(false);
    expect(opsFolderMigrationAllowed({bundledSidecar: false, env: {AGENTSTOZ_OPS_FOLDER_MIGRATION: '1'}})).toBe(true);
    for (const value of ['0', 'true', 'yes', ''])
      expect(opsFolderMigrationAllowed({bundledSidecar: false, env: {AGENTSTOZ_OPS_FOLDER_MIGRATION: value}})).toBe(false);
  });

  test('a source server without the opt-in prepares the profile and touches nothing else', async () => {
    const f = fixture();
    const logs: string[] = [];
    let prepared = 0;
    await runOpsFolderBoot({migrationAllowed: false, deps: f.deps, prepare: async () => { prepared += 1; }, log: line => logs.push(line)});
    expect(prepared).toBe(1);
    expect(existsSync(f.from)).toBe(true);
    expect(existsSync(f.to)).toBe(false);
    expect(pinnedKey(f.from)).toBe('');
    expect(f.calls.leases).toEqual([]);
    expect(f.calls.lsRemote).toEqual([]);
    expect(logs).toEqual([]);
  });

  test('the packaged boot migrates, prepares once, and only then follows the renamed repository', async () => {
    const f = fixture();
    const logs: string[] = [], results: unknown[] = [];
    await runOpsFolderBoot({
      migrationAllowed: true, deps: f.deps, prepare: async () => { f.calls.events.push('boot prepare'); },
      log: line => logs.push(line), report: result => results.push(result),
    });
    expectMigrated(f);
    expect(results).toEqual([expect.objectContaining({status: 'migrated', origin: 'pending', prepared: true})]);
    // The migration prepared the profile itself; the boot does not prepare a second time.
    expect(f.calls.events.filter(event => event.endsWith('prepare'))).toEqual(['prepare']);
    const firstNetwork = f.calls.events.findIndex(event => event.startsWith('ls-remote') || event.startsWith('gh '));
    expect(firstNetwork).toBeGreaterThan(f.calls.events.indexOf('prepare'));
    expect(gitText(['remote', 'get-url', 'origin'], f.to)).toBe(RENAMED_URL);
    expect(logs).toEqual([expect.stringContaining('AgentsToZ-OPS로 옮겼습니다'), expect.stringContaining('origin을 이름이 바뀐')]);
  });

  test('every packaged boot records its outcome for 아젠투지 설정; a later boot replaces it', async () => {
    const f = fixture();
    f.deps.lsof = async () => ({exitCode: 0, stdout: `p${process.pid}\ncbun\nfcwd\nn${f.from}\np4242\ncagy\nfcwd\nn${join(f.from, 'docs')}\np5151\nfcwd\nn${f.from}\n`});
    await runOpsFolderBoot({migrationAllowed: true, deps: f.deps, prepare: async () => {}, log: () => {}});
    expect(readOpsFolderMigrationRecord(f.appData)).toEqual({
      status: 'skipped', reason: 'folder-in-use', blocking: [{pid: 4242, command: 'agy'}, {pid: 5151}], at: '2026-09-29T01:02:03.004Z',
    });
    // The workroom closed: the next boot migrates and the waiting notice goes away with its record.
    f.deps.lsof = async () => ({exitCode: 0, stdout: ''});
    await runOpsFolderBoot({migrationAllowed: true, deps: f.deps, prepare: async () => {}, log: () => {}});
    expect(readOpsFolderMigrationRecord(f.appData)).toEqual({status: 'migrated', at: '2026-09-29T01:02:03.004Z'});
    // A source server without the opt-in neither runs nor records anything.
    const source = fixture();
    await runOpsFolderBoot({migrationAllowed: false, deps: source.deps, prepare: async () => {}, log: () => {}});
    expect(readOpsFolderMigrationRecord(source.appData)).toBeNull();
  });

  test('the recorded outcome is read back only when it is well formed', () => {
    const f = fixture();
    const path = join(f.appData, 'control-profile', 'ops-folder-rename-last.json');
    for (const [value, expected] of [
      [{status: 'needs-attention', reason: 'OPS_FOLDER_MIGRATION_BOTH_EXIST', at: 'x'}, {status: 'needs-attention', reason: 'OPS_FOLDER_MIGRATION_BOTH_EXIST', at: 'x'}],
      [{status: 'launched', at: 'x'}, null],
      [{status: 'skipped', reason: 7, at: 'x'}, null],
      [{status: 'skipped', reason: 'folder-in-use', blocking: [{pid: 'one'}], at: 'x'}, null],
      [{status: 'skipped', reason: 'folder-in-use', blocking: Array.from({length: 40}, (_, pid) => ({pid: pid + 1})), at: 'x'}, null],
      ['not an object', null],
    ] as const) {
      writeFileSync(path, JSON.stringify(value));
      expect(readOpsFolderMigrationRecord(f.appData)).toEqual(expected as any);
    }
    writeFileSync(path, 'x'.repeat(64 * 1024));
    expect(readOpsFolderMigrationRecord(f.appData)).toBeNull();
  });

  test('a rename that waits still leaves the profile prepared, before any network', async () => {
    const f = fixture();
    f.deps.lsof = async () => ({exitCode: 0, stdout: `p424242\nfcwd\nn${f.from}\n`});
    const results: unknown[] = [];
    await runOpsFolderBoot({
      migrationAllowed: true, deps: f.deps, prepare: async () => { f.calls.events.push('boot prepare'); },
      log: () => {}, report: result => results.push(result),
    });
    expect(results).toEqual([expect.objectContaining({status: 'skipped', reason: 'folder-in-use'})]);
    expect(f.calls.events).toEqual(['boot prepare']);
  });
});

describe('git never prompts, and the user\'s own SSH command is kept', () => {
  // Review finding 10: a default GIT_SSH_COMMAND overrode the user's core.sshCommand (multi-account
  // SSH), so ls-remote failed and origin stayed «pending» with a network probe on every boot.
  const BATCH = 'ssh -o BatchMode=yes -o ConnectTimeout=10';
  test('BatchMode is added only for a network command, and only when the user has no SSH command', () => {
    const base = {PATH: '/usr/bin', HOME: '/home/someone'};
    expect(opsGitEnvironment(base, null)).toEqual({...base, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'});
    expect(opsGitEnvironment(base, {coreSshCommand: null})).toEqual({...base, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: BATCH});
    expect(opsGitEnvironment(base, {coreSshCommand: '   '}).GIT_SSH_COMMAND).toBe(BATCH);
    expect(opsGitEnvironment({...base, GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work'}, {coreSshCommand: null}).GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/work');
    expect(opsGitEnvironment({...base, GIT_SSH: '/usr/local/bin/my-ssh'}, {coreSshCommand: null}).GIT_SSH_COMMAND).toBeUndefined();
    expect(opsGitEnvironment(base, {coreSshCommand: 'ssh -i ~/.ssh/work\n'}).GIT_SSH_COMMAND).toBeUndefined();
  });

  function sshFixture() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ops-git-ssh-')));
    dirs.push(dir);
    const repo = join(dir, 'repo'), bin = join(dir, 'bin'), called = join(dir, 'called');
    mkdirSync(repo);
    mkdirSync(bin);
    run(['git', 'init', '-q'], repo);
    // Records how it was invoked and fails, so nothing ever reaches the network.
    const fake = (name: string) => { const path = join(bin, name); writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${called}"\nexit 1\n`, {mode: 0o755}); return path; };
    fake('ssh');
    // No global or system git config: only what the test sets can decide.
    const env = {PATH: `${bin}:${process.env.PATH}`, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'};
    const git = createOpsGit('git', async (argv, cwd, childEnv) => {
      const result = Bun.spawnSync(argv, {cwd, env: childEnv, stdout: 'pipe', stderr: 'pipe'});
      return {exitCode: result.exitCode ?? 1, stdout: result.stdout.toString()};
    }, env);
    return {repo, called, fake, git};
  }

  test('a repository whose core.sshCommand picks the account reaches GitHub through that command', async () => {
    const f = sshFixture();
    run(['git', 'config', '--local', 'core.sshCommand', f.fake('work-ssh')], f.repo);
    expect((await f.git(['ls-remote', 'ssh://git@github.com/test-owner/AgentsToZ-OPS.git'], f.repo)).exitCode).not.toBe(0);
    const calls = readFileSync(f.called, 'utf8');
    expect(calls).toContain('work-ssh');
    expect(calls).not.toContain('BatchMode');
  });

  test('without an SSH command of the user\'s own, the batch-mode default never prompts', async () => {
    const f = sshFixture();
    await f.git(['ls-remote', 'ssh://git@github.com/test-owner/AgentsToZ-OPS.git'], f.repo);
    expect(readFileSync(f.called, 'utf8')).toContain('ssh -o BatchMode=yes -o ConnectTimeout=10');
  });
});

describe('sidecar boot wiring', () => {
  const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
  const boot = api.slice(api.indexOf('function opsFolderMigrationDeps'));
  // The order migrate → prepare → follow-up now lives in runOpsFolderBoot and is tested by behavior
  // above; these checks only pin how the sidecar calls it (they used to grep for that order here).
  test('the boot runs only in non-test servers, never blocks boot, and migrates only in the packaged sidecar', () => {
    const guard = boot.indexOf("process.env.NODE_ENV !== 'test'");
    const call = boot.indexOf('runOpsFolderBoot({');
    expect(guard).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(guard);
    expect(boot.slice(guard)).toContain('queueMicrotask(');
    expect(boot.slice(call)).toContain('migrationAllowed: opsFolderMigrationAllowed({ bundledSidecar: IS_BUNDLED_API_SIDECAR, env: process.env })');
    expect(boot.slice(call)).toContain('prepare: () => controlProfileHost.prepare()');
    expect(boot).not.toContain('await runOpsFolderMigration(');
  });
  test('the real stores, lease, lsof and a non-prompting git that keeps the user\'s SSH setup are wired in', () => {
    for (const wiring of [
      'controlProfileHost.store.boundLocation()', 'controlProfileHost.store.relocate(from, to)', 'savePortsData(request)',
      // -Fcn (was -Fn): the command field names the processes that keep a rename waiting (finding 7).
      "withManagedWorkspaceLease(root, 'OPS folder rename', operation)", "['/usr/sbin/lsof', '/usr/bin/lsof']", "[lsofPath, '-a', '-d', 'cwd', '-Fcn']",
      'relocateOrcaFloatingTerminalRoots(aliases)', 'terminalMemoryQueue.relocatePendingCwd(aliases)',
      'relocateProjectMemoryThreadBindings(PROJECT_MEMORY_THREAD_BINDINGS_FILE, aliases)', 'git: createOpsGit(GIT_PATH,',
    ]) expect(boot).toContain(wiring);
    expect(boot).not.toContain('GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ??');
  });
});

describe('helpers', () => {
  test('lsof cwd records, including escaped non-ASCII names, are parsed', () => {
    const escaped = '/Users/me/\\xed\\x95\\x9c\\xea\\xb8\\x80/AgentsToZ-Control';
    expect(parseLsofCwdOutput(`p12\nfcwd\nn/\np34\nfcwd\nn${escaped}\n\np56\nfcwd\n`)).toEqual([
      {pid: 12, cwd: '/'}, {pid: 34, cwd: '/Users/me/한글/AgentsToZ-Control'},
    ]);
  });

  test('the command field names each process, and never carries over to the next one', () => {
    expect(parseLsofCwdOutput('p12\ncagy\nfcwd\nn/a\np34\nfcwd\nn/b\np56\ncnode\nfcwd\nn/c\n')).toEqual([
      {pid: 12, command: 'agy', cwd: '/a'}, {pid: 34, cwd: '/b'}, {pid: 56, command: 'node', cwd: '/c'},
    ]);
  });

  test('paths are rebased only when they are the folder or inside it', () => {
    const aliases = [['/a/AgentsToZ-Control', '/a/AgentsToZ-OPS']] as const;
    expect(rebasePath('/a/AgentsToZ-Control', aliases)).toBe('/a/AgentsToZ-OPS');
    expect(rebasePath('/a/AgentsToZ-Control/', aliases)).toBe('/a/AgentsToZ-OPS/');
    expect(rebasePath('/a/AgentsToZ-Control/run.command', aliases)).toBe('/a/AgentsToZ-OPS/run.command');
    expect(rebasePath('/a/AgentsToZ-Control-backup', aliases)).toBeNull();
    expect(rebasePath('/b/AgentsToZ-Control', aliases)).toBeNull();
    expect(rebasePath(undefined, aliases)).toBeNull();
  });
});
