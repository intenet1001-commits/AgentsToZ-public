import * as nodeFs from 'node:fs';
import {basename, dirname, isAbsolute, join, sep} from 'node:path';
import {CONTROL_PROFILE_MARKER} from './controlProfileContract';
import {withOwnedPortalFileLock} from './portalFileLock';
import {PINNED_REPOSITORY_KEY_CONFIG, canonicalProjectRepositoryKey, pinnedProjectRepositoryKey} from './projectMemoryIdentity';
import {OPS_FOLDER_NAME, isLegacyOpsFolderName, isOpsFolderName, legacyOpsGitHubRemotes, rebasePath, renamedOpsGitHubRemote} from './opsFolderName';
import {gitHubRepositoryPath} from './githubUrls';
import type {OpsFolderMigrationRecord} from './opsFolderMigrationNotice';

export type {OpsFolderMigrationRecord};

/**
 * Renames the bound OPS folder AgentsToZ-Control → AgentsToZ-OPS at sidecar boot, before the
 * profile is prepared, so every later reader sees the final path.
 *
 * It never blocks boot and never guesses. A precondition that does not hold is a skip with a
 * reason code and the next boot tries again. Once the folder has moved, a journal records each
 * committed step and an interrupted run rolls forward idempotently. A disk that contradicts the
 * journal (both folders, neither, a foreign folder at the target) stops for a person: nothing is
 * deleted or merged.
 */
export const OPS_FOLDER_MIGRATION_JOURNAL = 'ops-folder-rename.json';
/** How often a folder that looks in use is re-checked before the rename is deferred (~2 s in all). */
export const OPS_FOLDER_IN_USE_CHECKS = 8;
export const OPS_FOLDER_IN_USE_RECHECK_MS = 250;
export const OPS_FOLDER_MIGRATION_PHASES = ['planned', 'renamed', 'ports', 'binding', 'references', 'git', 'trust'] as const;
export type OpsFolderMigrationPhase = typeof OPS_FOLDER_MIGRATION_PHASES[number];
export type OpsFolderMigrationSkipReason =
  | 'no-binding' | 'not-control-folder' | 'binding-not-ready' | 'custom-folder-name' | 'root-missing' | 'root-not-directory'
  | 'target-exists' | 'attach-pending' | 'marker-mismatch' | 'memory-mismatch' | 'registration-mismatch'
  | 'linked-worktrees' | 'git-unavailable' | 'process-check-unavailable' | 'folder-in-use' | 'workspace-busy' | 'migration-busy';
/**
 * updated: origin now names the renamed repository. pending: not yet decidable (the migration defers
 * the network step until after preparation, or a repository did not answer). unverified: both names
 * answered but are not proven to be one repository, so origin stays. unchanged: nothing to follow.
 */
export type OpsOriginFollowUp = 'updated' | 'pending' | 'unverified' | 'unchanged';
export type OpsTrustCopy = 'added' | 'unchanged';
export type OpsFolderBlockingProcess = {pid: number; command?: string};
export type OpsFolderMigrationResult =
  | {status: 'current'}
  | {status: 'skipped'; reason: OpsFolderMigrationSkipReason; from?: string; blocking?: OpsFolderBlockingProcess[]}
  | {status: 'migrated'; from: string; to: string; origin: OpsOriginFollowUp; trust: {codex: OpsTrustCopy; antigravity: OpsTrustCopy}; prepared: boolean}
  | {status: 'needs-attention'; code: string; from?: string; to?: string}
  | {status: 'failed'; code: string};

export type OpsBindingLocation = {
  state: 'preparing' | 'ready'; backend: 'control-folder' | 'app-data'; root: string;
  projectId: string | null; profileId: string; memoryId: string;
};
export type OpsPortRow = {id: string} & Record<string, unknown>;
type PathAliases = ReadonlyArray<readonly [string, string]>;
type MigrationFs = Pick<typeof nodeFs,
  'existsSync' | 'lstatSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'copyFileSync' | 'unlinkSync' | 'appendFileSync' | 'realpathSync' | 'statSync' | 'readdirSync'>;

export type OpsFolderMigrationDeps = {
  appDataDir: string;
  /** Home of the user whose AI trust settings follow the folder (injected so tests use a temp dir). */
  homeDir: string;
  /** This sidecar; its own cwd never blocks the rename. */
  pid: number;
  now?: () => number;
  /** Waits between folder-in-use re-checks (injected so tests do not sleep). */
  sleep?: (ms: number) => Promise<void>;
  fs?: MigrationFs;
  readBinding(): OpsBindingLocation | null;
  relocateBinding(from: string, to: string): Promise<unknown>;
  loadPorts(): Promise<OpsPortRow[]>;
  /** The existing three-way ports save: `basePorts` is what was loaded, `ports` the edited copy. */
  savePorts(request: {basePorts: OpsPortRow[]; ports: OpsPortRow[]; source: string}): Promise<unknown>;
  git(args: string[], cwd: string): Promise<{exitCode: number; stdout: string}>;
  /** The GitHub CLI; null (or absent) when it is not installed. Used only to prove a renamed repository's identity. */
  gh?(args: string[], cwd: string): Promise<{exitCode: number; stdout: string} | null>;
  /** `lsof -a -d cwd -Fcn` output, or null when it cannot run. Without it the folder is never moved. */
  lsof(): Promise<{exitCode: number; stdout: string} | null>;
  withLease<T>(root: string, operation: () => Promise<T>): Promise<T>;
  /** Other app-data references (Orca terminals, pending Workroom memory jobs, chat bindings). */
  relocateReferences(aliases: PathAliases): Promise<unknown>;
  prepare(): Promise<unknown>;
  /** Test hook, called right after a phase is durably recorded. */
  onPhase?: (phase: OpsFolderMigrationPhase) => void;
};

type Journal = {
  schemaVersion: 1; from: string; to: string; aliases: Array<[string, string]>;
  projectId: string; profileId: string; memoryId: string; phase: OpsFolderMigrationPhase;
  startedAt: string; updatedAt: string; origin?: OpsOriginFollowUp; trust?: {codex: OpsTrustCopy; antigravity: OpsTrustCopy};
};

class MigrationStop extends Error {
  constructor(readonly result: OpsFolderMigrationResult) { super(result.status); }
}
const skip = (reason: OpsFolderMigrationSkipReason, from?: string): never => { throw new MigrationStop({status: 'skipped', reason, ...(from ? {from} : {})}); };
const attention = (code: string, journal?: Journal): never => {
  throw new MigrationStop({status: 'needs-attention', code, ...(journal ? {from: journal.from, to: journal.to} : {})});
};

const MAX_BLOCKING_PROCESSES = 8;
const PORT_PATH_FIELDS = ['folderPath', 'commandPath', 'worktreePath', 'manualPath'] as const;
const within = (path: string, root: string) => path === root || path.startsWith(root + '/') || path.startsWith(root + sep);
const trimmedPath = (value: unknown) => typeof value === 'string' ? value.trim().replace(/[/\\]+$/, '') : '';

/**
 * Parses `lsof -Fcn` records (`-Fn` output parses too, without commands); lsof escapes bytes it cannot
 * print as \xNN, so UTF-8 names are rebuilt. A command belongs to its own process record only.
 */
export function parseLsofCwdOutput(stdout: string): Array<{pid: number; command?: string; cwd: string}> {
  const records: Array<{pid: number; command?: string; cwd: string}> = [];
  const unescaped = (value: string) => value.replace(/(?:\\x[0-9a-fA-F]{2})+/g, run => Buffer.from(run.replace(/\\x/g, ''), 'hex').toString('utf8'));
  let pid = 0, command: string | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); command = undefined; }
    else if (line.startsWith('c')) command = unescaped(line.slice(1)).slice(0, 64) || undefined;
    else if (line.startsWith('n') && Number.isSafeInteger(pid) && pid > 0) records.push({pid, ...(command ? {command} : {}), cwd: unescaped(line.slice(1))});
  }
  return records;
}

/** One log line for outcomes worth reporting; null for the quiet steady states. */
export function opsFolderMigrationLogLine(result: OpsFolderMigrationResult): string | null {
  switch (result.status) {
    case 'current': return null;
    case 'skipped':
      return ['no-binding', 'not-control-folder', 'custom-folder-name'].includes(result.reason) ? null
        : `[AgentsToZ] OPS 운영 폴더 이름 변경(${OPS_FOLDER_NAME})을 다음 실행으로 미뤘습니다: ${result.reason}`;
    case 'migrated':
      return `[AgentsToZ] OPS 운영 폴더를 ${OPS_FOLDER_NAME}로 옮겼습니다 (origin ${result.origin}, Codex 신뢰 ${result.trust.codex}, Antigravity 신뢰 ${result.trust.antigravity}). Claude Code는 새 경로에서 폴더 신뢰를 한 번 다시 묻습니다.`;
    case 'needs-attention': return `[AgentsToZ] OPS 운영 폴더 이름 변경 확인 필요: ${result.code} (아무것도 지우거나 합치지 않았습니다)`;
    case 'failed': return `[AgentsToZ] OPS 운영 폴더 이름 변경을 끝내지 못했습니다 — 다음 실행에서 이어갑니다: ${result.code}`;
  }
}

/** One log line for the origin follow-up; null for the quiet outcomes. Never prints a URL (it may carry credentials). */
export function opsOriginFollowUpLogLine(origin: OpsOriginFollowUp): string | null {
  if (origin === 'updated') return '[AgentsToZ] OPS 운영 폴더의 origin을 이름이 바뀐 GitHub 저장소로 맞췄습니다.';
  if (origin === 'unverified') return '[AgentsToZ] OPS 운영 폴더의 origin을 그대로 두었습니다: 새 이름의 GitHub 저장소가 같은 저장소인지 확인되지 않았습니다.';
  return null;
}

/**
 * Every mutation this module makes — a fresh rename, a roll-forward from the journal, the origin
 * follow-up — runs under this one owned lock. The workspace lease alone could not serialize them:
 * a fresh run leases the old path and a resumed one the new path, so two sidecars could roll the
 * same journal forward side by side (and append the same Codex table twice).
 */
async function withMigrationLock<T>(deps: Pick<OpsFolderMigrationDeps, 'appDataDir'>, operation: () => Promise<T>): Promise<{entered: false} | {entered: true; value: T}> {
  let entered = false;
  try {
    const value = await withOwnedPortalFileLock(join(deps.appDataDir, 'control-profile', `${OPS_FOLDER_MIGRATION_JOURNAL}.lock`), () => {
      entered = true;
      return operation();
    }, {attempts: 2, label: 'OPS folder rename'});
    return {entered: true, value};
  } catch (error) {
    if (!entered) return {entered: false};
    throw error;
  }
}

/** The explicit opt-in for a source or worktree server; see opsFolderMigrationAllowed. */
export const OPS_FOLDER_MIGRATION_OPT_IN_ENV = 'AGENTSTOZ_OPS_FOLDER_MIGRATION';

/**
 * Only the packaged app's sidecar owns the user's real OPS folder. A source or worktree server
 * (`bun api-server.ts` for the smoke tests, `API_PORT=… bun api-server.ts` in a worktree) shares the
 * same app data, and unreleased code must not perform the one-way rename or rewrite ports, binding,
 * origin and trust files from there. Such a server migrates only when told to.
 */
export function opsFolderMigrationAllowed(input: {bundledSidecar: boolean; env: Record<string, string | undefined>}): boolean {
  return input.bundledSidecar || input.env[OPS_FOLDER_MIGRATION_OPT_IN_ENV] === '1';
}

export type OpsFolderBootOptions = {
  migrationAllowed: boolean;
  deps: OpsFolderMigrationDeps;
  /** Profile preparation. It runs on every boot, with or without the migration. */
  prepare(): Promise<unknown>;
  log(line: string): void;
  /** Receives the migration's outcome (the status surface keeps the last one). */
  report?(result: OpsFolderMigrationResult): void;
};

/** The last boot's outcome, which the desktop control-profile status carries (never the remote ops.status DTO). */
export const OPS_FOLDER_MIGRATION_RECORD = 'ops-folder-rename-last.json';
const RECORD_STATUSES: ReadonlySet<string> = new Set(['current', 'skipped', 'migrated', 'needs-attention', 'failed']);

export function opsFolderMigrationRecord(result: OpsFolderMigrationResult, at: Date): OpsFolderMigrationRecord {
  const reason = result.status === 'skipped' ? result.reason : result.status === 'needs-attention' || result.status === 'failed' ? result.code : undefined;
  return {
    status: result.status, ...(reason ? {reason} : {}),
    ...(result.status === 'skipped' && result.blocking?.length ? {blocking: result.blocking} : {}), at: at.toISOString(),
  };
}

/** Best effort: the record only informs a person, so failing to write it never touches the boot. */
export function writeOpsFolderMigrationRecord(appDataDir: string, record: OpsFolderMigrationRecord): void {
  const path = join(appDataDir, 'control-profile', OPS_FOLDER_MIGRATION_RECORD), temporary = `${path}.${process.pid}.tmp`;
  try {
    nodeFs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, {mode: 0o600});
    nodeFs.renameSync(temporary, path);
  } catch {
    try { nodeFs.unlinkSync(temporary); } catch { /* nothing was written */ }
  }
}

/** The recorded outcome when it is a small, well-formed record; null for anything else. */
export function readOpsFolderMigrationRecord(appDataDir: string): OpsFolderMigrationRecord | null {
  try {
    const path = join(appDataDir, 'control-profile', OPS_FOLDER_MIGRATION_RECORD), stat = nodeFs.lstatSync(path);
    if (!stat.isFile() || stat.size > 8 * 1024) return null;
    const value = JSON.parse(nodeFs.readFileSync(path, 'utf8')) as Partial<OpsFolderMigrationRecord> | null;
    if (!value || typeof value !== 'object' || !RECORD_STATUSES.has(value.status as string) || typeof value.at !== 'string' || value.at.length > 64) return null;
    if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 200)) return null;
    const blocking = value.blocking;
    if (blocking !== undefined && (!Array.isArray(blocking) || blocking.length > MAX_BLOCKING_PROCESSES
      || !blocking.every(entry => entry && Number.isSafeInteger(entry.pid) && entry.pid > 0 && (entry.command === undefined || (typeof entry.command === 'string' && entry.command.length <= 64))))) return null;
    return {
      status: value.status as OpsFolderMigrationRecord['status'], ...(value.reason !== undefined ? {reason: value.reason} : {}),
      ...(blocking?.length ? {blocking: blocking.map(({pid, command}) => ({pid, ...(command !== undefined ? {command} : {})}))} : {}), at: value.at,
    };
  } catch {
    return null;
  }
}

/**
 * The sidecar's boot order: rename (which prepares on success) → preparation when it did not →
 * following a renamed repository. Every network probe comes after preparation. Each allowed boot
 * records its outcome, replacing the last one, so a notice disappears once the rename is done.
 */
export async function runOpsFolderBoot(options: OpsFolderBootOptions): Promise<void> {
  if (!options.migrationAllowed) {
    await options.prepare();
    return;
  }
  const migration = await runOpsFolderMigration(options.deps);
  writeOpsFolderMigrationRecord(options.deps.appDataDir, opsFolderMigrationRecord(migration, new Date((options.deps.now ?? Date.now)())));
  options.report?.(migration);
  const line = opsFolderMigrationLogLine(migration);
  if (line) options.log(line);
  if (migration.status !== 'migrated' || !migration.prepared) await options.prepare();
  const originLine = opsOriginFollowUpLogLine(await followUpOpsRepositoryOrigin(options.deps));
  if (originLine) options.log(originLine);
  if (await normalizeOpsGithubUrl(options.deps) === 'updated') options.log('[AgentsToZ] OPS 운영 프로젝트의 GitHub 링크를 AgentsToZ-OPS 저장소로 맞췄습니다.');
  const topUp = await topUpOpsTrust(options.deps);
  if (topUp.codex === 'added' || topUp.antigravity === 'added') options.log(`[AgentsToZ] 옮긴 OPS 운영 폴더의 신뢰 설정을 보충했습니다 (Codex ${topUp.codex}, Antigravity ${topUp.antigravity}).`);
}

type GitEnvironment = Record<string, string | undefined>;
const BATCH_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=10';

/**
 * The migration's git never prompts. For a network command it also must not hang on an SSH prompt,
 * but a default GIT_SSH_COMMAND overrides the user's own SSH setup (GIT_SSH_COMMAND, GIT_SSH or
 * core.sshCommand — a multi-account host alias, a specific key), and ls-remote then fails every boot.
 * BatchMode is added only when the user has none of those.
 */
export function opsGitEnvironment(env: GitEnvironment, network: {coreSshCommand: string | null} | null): GitEnvironment {
  const quiet = {...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'};
  if (!network) return quiet;
  const own = [env.GIT_SSH_COMMAND, env.GIT_SSH, network.coreSshCommand].some(value => typeof value === 'string' && value.trim() !== '');
  return own ? quiet : {...quiet, GIT_SSH_COMMAND: BATCH_SSH_COMMAND};
}

export type OpsGitRun = (argv: string[], cwd: string, env: GitEnvironment) => Promise<{exitCode: number; stdout: string}>;

/** The `git` dependency: quiet, and for ls-remote it first asks git (repo, global, system) for the user's SSH command. */
export function createOpsGit(gitPath: string, run: OpsGitRun, env: GitEnvironment = process.env): OpsFolderMigrationDeps['git'] {
  return async (args, cwd) => {
    if (args[0] !== 'ls-remote') return run([gitPath, ...args], cwd, opsGitEnvironment(env, null));
    const configured = await run([gitPath, 'config', '--get', 'core.sshCommand'], cwd, opsGitEnvironment(env, null));
    return run([gitPath, ...args], cwd, opsGitEnvironment(env, {coreSshCommand: configured.exitCode === 0 ? configured.stdout : null}));
  };
}

export async function runOpsFolderMigration(deps: OpsFolderMigrationDeps): Promise<OpsFolderMigrationResult> {
  const fs = deps.fs ?? nodeFs;
  const journalPath = join(deps.appDataDir, 'control-profile', OPS_FOLDER_MIGRATION_JOURNAL);
  // No profile directory means no binding and no journal; taking the lock would only create it.
  if (!fs.existsSync(dirname(journalPath))) return {status: 'skipped', reason: 'no-binding'};
  try {
    const locked = await withMigrationLock(deps, async () => {
      await pinBoundOpsRepositoryKey(deps, fs);
      const journal = readJournal(fs, journalPath);
      if (journal) {
        const resumed = await resume(deps, fs, journalPath, journal);
        if (resumed) return resumed;
      }
      return await fresh(deps, fs, journalPath);
    });
    return locked.entered ? locked.value : {status: 'skipped', reason: 'migration-busy'};
  } catch (error) {
    if (error instanceof MigrationStop) return error.result;
    const code = typeof (error as {code?: unknown})?.code === 'string' ? (error as {code: string}).code : 'OPS_FOLDER_MIGRATION_FAILED';
    return {status: 'failed', code};
  }
}

/**
 * The journal decides which paths are rebased, so its aliases must be exactly what `fresh` writes:
 * [from, to], and optionally the same folder by its real path (a symlinked parent). Anything else —
 * an unrelated folder, another target, a pair under a different parent — could move unrelated rows.
 */
function journalAliasesValid(fs: MigrationFs, journal: Journal): boolean {
  const [first, second, ...rest] = journal.aliases;
  if (rest.length || !first || first[0] !== journal.from || first[1] !== journal.to) return false;
  if (!second) return true;
  const [realFrom, realTo] = second;
  // macOS volumes are case-insensitive and realpath returns the on-disk case of the folder name.
  if (realFrom === journal.from || basename(realFrom).toLowerCase() !== basename(journal.from).toLowerCase() || realTo !== join(dirname(realFrom), OPS_FOLDER_NAME)) return false;
  try { return fs.realpathSync(dirname(journal.from)) === dirname(realFrom); } catch { return false; }
}

function readJournal(fs: MigrationFs, path: string): Journal | null {
  if (!fs.existsSync(path)) return null;
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('journal file');
    const value = JSON.parse(fs.readFileSync(path, 'utf8')) as Journal;
    const valid = value?.schemaVersion === 1
      && typeof value.from === 'string' && isAbsolute(value.from) && isLegacyOpsFolderName(basename(value.from))
      && value.to === join(dirname(value.from), OPS_FOLDER_NAME)
      && Array.isArray(value.aliases) && value.aliases.length >= 1 && value.aliases.length <= 2
      && value.aliases.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(path => typeof path === 'string' && isAbsolute(path)))
      && journalAliasesValid(fs, value)
      && [value.projectId, value.profileId, value.memoryId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)
      && (OPS_FOLDER_MIGRATION_PHASES as readonly string[]).includes(value.phase);
    if (!valid) throw new Error('journal shape');
    return value;
  } catch {
    return attention('OPS_FOLDER_MIGRATION_JOURNAL_INVALID');
  }
}

function writeJournal(deps: OpsFolderMigrationDeps, fs: MigrationFs, path: string, journal: Journal, phase: OpsFolderMigrationPhase) {
  journal.phase = phase;
  journal.updatedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const temporary = `${path}.${deps.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, {mode: 0o600});
  fs.renameSync(temporary, path);
  deps.onPhase?.(phase);
}

/** Resume a recorded run. Returns null when nothing had moved yet, so the caller starts over. */
async function resume(deps: OpsFolderMigrationDeps, fs: MigrationFs, journalPath: string, journal: Journal): Promise<OpsFolderMigrationResult | null> {
  const present = (path: string) => { try { fs.lstatSync(path); return true; } catch { return false; } };
  const fromPresent = present(journal.from), toPresent = present(journal.to);
  if (fromPresent && toPresent) attention('OPS_FOLDER_MIGRATION_BOTH_EXIST', journal);
  if (!fromPresent && !toPresent) attention('OPS_FOLDER_MIGRATION_FOLDER_MISSING', journal);
  if (fromPresent) {
    // Only the journal and backups exist. Start over so every precondition is checked again.
    if (journal.phase !== 'planned') attention('OPS_FOLDER_MIGRATION_INCONSISTENT', journal);
    fs.unlinkSync(journalPath);
    return null;
  }
  if (!markerMatches(fs, journal.to, journal.profileId, journal.memoryId)) attention('OPS_FOLDER_MIGRATION_TARGET_MISMATCH', journal);
  let entered = false;
  try {
    await deps.withLease(journal.to, async () => { entered = true; await rollForward(deps, fs, journalPath, journal); });
  } catch (error) {
    if (!entered) skip('workspace-busy', journal.from);
    throw error;
  }
  return finish(deps, journal);
}

async function fresh(deps: OpsFolderMigrationDeps, fs: MigrationFs, journalPath: string): Promise<OpsFolderMigrationResult> {
  const binding = deps.readBinding();
  if (!binding) return skip('no-binding');
  if (binding.backend !== 'control-folder') return skip('not-control-folder');
  if (binding.state !== 'ready') return skip('binding-not-ready');
  const from = binding.root, leaf = basename(from);
  if (isOpsFolderName(leaf) && !isLegacyOpsFolderName(leaf)) return {status: 'current'};
  if (!isLegacyOpsFolderName(leaf)) return skip('custom-folder-name', from);
  const to = join(dirname(from), OPS_FOLDER_NAME);
  let stat: nodeFs.Stats;
  try { stat = fs.lstatSync(from); } catch { return skip('root-missing', from); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return skip('root-not-directory', from);
  const targetPresent = () => { try { fs.lstatSync(to); return true; } catch { return false; } };
  if (targetPresent()) return skip('target-exists', from);
  if (fs.existsSync(join(deps.appDataDir, 'control-profile', 'attach-transition.json'))) return skip('attach-pending', from);
  if (!markerMatches(fs, from, binding.profileId, binding.memoryId)) return skip('marker-mismatch', from);
  if (memoryIdAt(fs, from) !== binding.memoryId) return skip('memory-mismatch', from);
  const realFrom = fs.realpathSync(from);
  const aliases: Array<[string, string]> = [[from, to]];
  if (realFrom !== from) aliases.push([realFrom, join(dirname(realFrom), OPS_FOLDER_NAME)]);
  const projectId = binding.projectId;
  if (!projectId) return skip('registration-mismatch', from);
  const bound = (await deps.loadPorts()).filter(row => row?.id === projectId);
  const boundPath = trimmedPath(bound[0]?.folderPath);
  // The registration must name this folder literally (not only by realpath) so its paths can be rebased.
  const registered = bound.length === 1 && aliases.some(([alias]) => alias === boundPath)
    && (() => { try { return fs.realpathSync(boundPath) === realFrom; } catch { return false; } })();
  if (!registered) return skip('registration-mismatch', from);
  const worktrees = await deps.git(['worktree', 'list', '--porcelain'], from);
  if (worktrees.exitCode !== 0) { if (fs.existsSync(join(from, '.git'))) return skip('git-unavailable', from); }
  else if (worktrees.stdout.split('\n').filter(line => line.startsWith('worktree ')).length > 1) return skip('linked-worktrees', from);

  const journal: Journal = {
    schemaVersion: 1, from, to, aliases, projectId, profileId: binding.profileId, memoryId: binding.memoryId,
    phase: 'planned', startedAt: new Date((deps.now ?? Date.now)()).toISOString(), updatedAt: '',
  };
  let entered = false;
  try {
    await deps.withLease(from, async () => {
      entered = true;
      // Inside the lease so no managed writer can start between this check and the rename. Boot work
      // runs beside this migration, so a short-lived `git` of our own can sit in the folder at the
      // instant of one check (live 2026-09-29): re-check a few times before calling it «in use». A
      // person's open Workroom or terminal stays for the whole window and still defers the rename.
      const roots = [from, realFrom];
      const blocking = new Map<number, OpsFolderBlockingProcess>();
      const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
      for (let check = 1; check <= OPS_FOLDER_IN_USE_CHECKS; check++) {
        const listing = await deps.lsof();
        if (!listing || listing.exitCode !== 0) skip('process-check-unavailable', from);
        blocking.clear();
        for (const process of parseLsofCwdOutput(listing!.stdout)) {
          if (process.pid === deps.pid || !roots.some(root => within(process.cwd, root)) || blocking.has(process.pid)) continue;
          blocking.set(process.pid, {pid: process.pid, ...(process.command ? {command: process.command} : {})});
        }
        if (!blocking.size || check === OPS_FOLDER_IN_USE_CHECKS) break;
        await sleep(OPS_FOLDER_IN_USE_RECHECK_MS);
      }
      // The person who must close them sees these processes in 아젠투지 설정.
      if (blocking.size) throw new MigrationStop({status: 'skipped', reason: 'folder-in-use', from, blocking: [...blocking.values()].slice(0, MAX_BLOCKING_PROCESSES)});
      if (targetPresent()) skip('target-exists', from);
      writeJournal(deps, fs, journalPath, journal, 'planned');
      backup(deps, fs, join(deps.appDataDir, 'ports.json'));
      backup(deps, fs, join(deps.appDataDir, 'control-profile', 'binding.json'));
      fs.renameSync(from, to);
      writeJournal(deps, fs, journalPath, journal, 'renamed');
      await rollForward(deps, fs, journalPath, journal);
    });
  } catch (error) {
    if (!entered) return skip('workspace-busy', from);
    // A precondition that failed inside the lease leaves nothing behind but its bookkeeping.
    if (error instanceof MigrationStop && error.result.status === 'skipped' && journal.phase === 'planned' && fs.existsSync(from)) {
      try { fs.unlinkSync(journalPath); } catch { /* absent: the stop happened before the journal */ }
    }
    throw error;
  }
  return finish(deps, journal);
}

/**
 * One backup per file, taken right before the attempt that may rename. An attempt that keeps
 * failing before the rename changes nothing, so earlier copies are only older views of the same
 * state; keeping each of them grew app data by two files per boot.
 */
function backup(deps: OpsFolderMigrationDeps, fs: MigrationFs, path: string) {
  if (!fs.existsSync(path)) return;
  const stamp = new Date((deps.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
  const prefix = `${basename(path)}.before-ops-folder-rename-`, target = join(dirname(path), `${prefix}${stamp}`);
  if (!fs.existsSync(target)) fs.copyFileSync(path, target, nodeFs.constants.COPYFILE_EXCL);
  for (const name of fs.readdirSync(dirname(path))) {
    if (!name.startsWith(prefix) || join(dirname(path), name) === target) continue;
    try { fs.unlinkSync(join(dirname(path), name)); } catch { /* a leftover is retried by the next attempt */ }
  }
}

function markerMatches(fs: MigrationFs, root: string, profileId: string, memoryId: string): boolean {
  try {
    const path = join(root, CONTROL_PROFILE_MARKER), stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.size > 4096) return false;
    const marker = JSON.parse(fs.readFileSync(path, 'utf8'));
    return marker?.schemaVersion === 1 && marker.profileId === profileId && marker.memoryId === memoryId;
  } catch { return false; }
}

function memoryIdAt(fs: MigrationFs, root: string): string | null {
  try {
    const config = JSON.parse(fs.readFileSync(join(root, '.agent-memory', 'config.json'), 'utf8'));
    return typeof config?.memoryId === 'string' ? config.memoryId : null;
  } catch { return null; }
}

const phaseIndex = (phase: OpsFolderMigrationPhase) => OPS_FOLDER_MIGRATION_PHASES.indexOf(phase);

/** Steps after the rename. Each one checks its own before/after state, so a repeat is harmless. */
async function rollForward(deps: OpsFolderMigrationDeps, fs: MigrationFs, journalPath: string, journal: Journal) {
  if (phaseIndex(journal.phase) < phaseIndex('ports')) {
    const rows = await deps.loadPorts();
    const next = rows.map(row => rebasedPortRow(row, journal));
    if (next.some((row, index) => row !== rows[index])) await deps.savePorts({basePorts: rows, ports: next, source: 'ops-folder-rename'});
    writeJournal(deps, fs, journalPath, journal, 'ports');
  }
  if (phaseIndex(journal.phase) < phaseIndex('binding')) {
    await deps.relocateBinding(journal.from, journal.to);
    writeJournal(deps, fs, journalPath, journal, 'binding');
  }
  if (phaseIndex(journal.phase) < phaseIndex('references')) {
    await deps.relocateReferences(journal.aliases);
    writeJournal(deps, fs, journalPath, journal, 'references');
  }
  if (phaseIndex(journal.phase) < phaseIndex('git')) {
    // Local only: pin the key now. Probing and following the renamed repository is network work and
    // waits until the profile is prepared (followUpOpsRepositoryOrigin), so it never delays preparation.
    journal.origin = await pinLegacyOrigin(deps, journal.to) ? 'pending' : 'unchanged';
    writeJournal(deps, fs, journalPath, journal, 'git');
  }
  if (phaseIndex(journal.phase) < phaseIndex('trust')) {
    journal.trust = copyTrust(deps, fs, journal.aliases);
    writeJournal(deps, fs, journalPath, journal, 'trust');
  }
  fs.unlinkSync(journalPath);
}

async function finish(deps: OpsFolderMigrationDeps, journal: Journal): Promise<OpsFolderMigrationResult> {
  // The move is complete once the journal is gone; a preparation problem is the profile's own
  // needs-attention state, not a failed rename. The caller prepares again when this did not.
  let prepared = true;
  try { await deps.prepare(); } catch { prepared = false; }
  return {
    status: 'migrated', from: journal.from, to: journal.to, origin: journal.origin ?? 'unchanged',
    trust: journal.trust ?? {codex: 'unchanged', antigravity: 'unchanged'}, prepared,
  };
}

function rebasedPortRow(row: OpsPortRow, journal: Journal): OpsPortRow {
  let next: OpsPortRow | null = null;
  for (const field of PORT_PATH_FIELDS) {
    const moved = rebasePath(row[field], journal.aliases);
    if (moved !== null && moved !== row[field]) (next ??= {...row})[field] = moved;
  }
  if (row.id === journal.projectId) {
    if (isLegacyOpsFolderName(row.name)) (next ??= {...row}).name = OPS_FOLDER_NAME;
    if (row.role === undefined) (next ??= {...row}).role = 'ops';
  }
  return next ?? row;
}

type LegacyOrigin = {current: string; renamed: string; pinned: boolean};

/**
 * The OPS memory lineage is registered under the key of the URL it was pushed with. While origin is
 * a legacy OPS GitHub URL that key is the current one, so pin it now (unless something is already
 * pinned): the same key keeps being presented once origin names the renamed repository. Null for
 * any other origin — other remotes and non-GitHub origins are never touched.
 */
async function pinLegacyOrigin(deps: Pick<OpsFolderMigrationDeps, 'git'>, root: string): Promise<LegacyOrigin | null> {
  const origin = await deps.git(['remote', 'get-url', 'origin'], root);
  if (origin.exitCode !== 0) return null;
  const current = origin.stdout.trim(), renamed = renamedOpsGitHubRemote(current), key = canonicalProjectRepositoryKey(current);
  if (!renamed || !key) return null;
  const existing = await deps.git(['config', '--local', '--get', PINNED_REPOSITORY_KEY_CONFIG], root);
  if (pinnedProjectRepositoryKey(existing.exitCode === 0 ? existing.stdout : null)) return {current, renamed, pinned: true};
  return {current, renamed, pinned: (await deps.git(['config', '--local', PINNED_REPOSITORY_KEY_CONFIG, key], root)).exitCode === 0};
}

/**
 * Every boot, whatever the rename's preconditions say: a bound OPS whose origin is still legacy gets
 * its key pinned. Git's «repository moved» hint or `gh repo rename` may switch origin before this Mac
 * migrates (an open OPS Workroom keeps the folder in use for days), and an unpinned claim would then
 * present a new key for the same memory_id and fail on the registry. The pin equals the current key,
 * so it changes nothing until origin does.
 */
async function pinBoundOpsRepositoryKey(deps: OpsFolderMigrationDeps, fs: MigrationFs): Promise<void> {
  try {
    const binding = deps.readBinding();
    if (!binding || binding.backend !== 'control-folder' || !fs.lstatSync(binding.root).isDirectory()) return;
    await pinLegacyOrigin(deps, binding.root);
  } catch { /* the pin never blocks the rename or the boot; the next boot tries again */ }
}

type RepositoryView = {id: string; url: string};
function repositoryView(result: {exitCode: number; stdout: string} | null | undefined): RepositoryView | null {
  if (!result || result.exitCode !== 0) return null;
  try {
    const value = JSON.parse(result.stdout) as Partial<RepositoryView>;
    return typeof value?.id === 'string' && value.id && typeof value.url === 'string' ? {id: value.id, url: value.url} : null;
  } catch { return null; }
}

/**
 * Whether `renamed` names the repository origin already points at. An answering `<owner>/AgentsToZ-OPS`
 * is not proof: the user may have created a new repository under that name, or another Mac's OPS may
 * own one. GitHub decides first — the legacy path resolves to the renamed URL (GitHub followed the
 * rename, as restore also checks) or both names are one node id. Without a gh answer, both URLs must
 * list the same, non-empty refs.
 */
async function renamedRepositoryProof(deps: Pick<OpsFolderMigrationDeps, 'git' | 'gh'>, legacy: LegacyOrigin, cwd: string): Promise<'same' | 'different' | 'unreachable'> {
  const legacyPath = gitHubRepositoryPath(legacy.current), renamedPath = gitHubRepositoryPath(legacy.renamed);
  if (deps.gh && legacyPath && renamedPath) {
    const before = repositoryView(await deps.gh(['repo', 'view', legacyPath, '--json', 'id,url'], cwd).catch(() => null));
    if (before) {
      if (canonicalProjectRepositoryKey(before.url) === canonicalProjectRepositoryKey(legacy.renamed)) return 'same';
      const after = repositoryView(await deps.gh(['repo', 'view', renamedPath, '--json', 'id,url'], cwd).catch(() => null));
      if (!after) return 'unreachable';
      return after.id === before.id ? 'same' : 'different';
    }
  }
  const [a, b] = [await deps.git(['ls-remote', legacy.current], cwd), await deps.git(['ls-remote', legacy.renamed], cwd)];
  if (a.exitCode !== 0 || b.exitCode !== 0) return 'unreachable';
  const refs = (stdout: string) => stdout.split('\n').map(line => line.trim()).filter(Boolean).sort().join('\n');
  return refs(a.stdout) !== '' && refs(a.stdout) === refs(b.stdout) ? 'same' : 'different';
}

/**
 * Pin the key FIRST, then follow the GitHub rename only to a proven same repository; otherwise origin
 * stays and a later boot looks again.
 */
async function followRenamedOrigin(deps: Pick<OpsFolderMigrationDeps, 'git' | 'gh'>, root: string): Promise<OpsOriginFollowUp> {
  const legacy = await pinLegacyOrigin(deps, root);
  if (!legacy) return 'unchanged';
  if (!legacy.pinned) return 'pending';
  const proof = await renamedRepositoryProof(deps, legacy, root);
  if (proof === 'unreachable') return 'pending';
  if (proof === 'different') return 'unverified';
  return (await deps.git(['remote', 'set-url', 'origin', legacy.renamed], root)).exitCode === 0 ? 'updated' : 'pending';
}

/**
 * Later boots: the folder is already AgentsToZ-OPS (renamed here, or restored by an update) but
 * origin may still be the legacy URL because the new one did not answer yet. Runs after the
 * profile is prepared so a slow network never delays it.
 */
/**
 * Display only: once origin is the renamed OPS repository, the OPS row's GitHub link (which still
 * names AgentsToZ-Control after a move) is pointed at the same owner's AgentsToZ-OPS. The memory
 * registry key never comes from this field (it is pinned in git config). Idempotent, runs each boot.
 */
export async function normalizeOpsGithubUrl(deps: OpsFolderMigrationDeps): Promise<'updated' | 'unchanged'> {
  try {
    const binding = deps.readBinding();
    if (!binding || binding.backend !== 'control-folder' || binding.state !== 'ready') return 'unchanged';
    const leaf = basename(binding.root);
    if (!isOpsFolderName(leaf) || isLegacyOpsFolderName(leaf)) return 'unchanged';
    const origin = await deps.git(['remote', 'get-url', 'origin'], binding.root);
    const originUrl = origin.exitCode === 0 ? origin.stdout.trim() : '';
    if (!legacyOpsGitHubRemotes(originUrl).length) return 'unchanged';
    const ports = await deps.loadPorts();
    const row = ports.find(candidate => candidate.id === binding.projectId);
    if (!row) return 'unchanged';
    // Both repository fields follow the rename. Only `githubUrl` used to, so a row kept
    // `githubUrls: [AgentsToZ-Control]` beside `githubUrl: AgentsToZ-OPS`, and auto upload stopped on
    // the 「GitHub 저장소」 difference for every project (2026-10-02). A URL is renamed only when the new
    // one is this clone's origin.
    const follow = (url: unknown): unknown => {
      const renamed = renamedOpsGitHubRemote(url);
      return renamed && canonicalProjectRepositoryKey(renamed) === canonicalProjectRepositoryKey(originUrl) ? renamed : url;
    };
    const githubUrl = follow(row.githubUrl);
    const listed = Array.isArray(row.githubUrls) ? row.githubUrls : null;
    const githubUrls = listed ? [...new Set(listed.map(follow))] : null;
    const changed = githubUrl !== row.githubUrl || (listed !== null && JSON.stringify(githubUrls) !== JSON.stringify(listed));
    if (!changed) return 'unchanged';
    await deps.savePorts({basePorts: ports, ports: ports.map(candidate => candidate === row ? {...candidate, githubUrl, ...(githubUrls ? {githubUrls} : {})} : candidate), source: 'ops-folder-github-url'});
    return 'updated';
  } catch {
    return 'unchanged';
  }
}

export async function followUpOpsRepositoryOrigin(deps: OpsFolderMigrationDeps): Promise<OpsOriginFollowUp> {
  const fs = deps.fs ?? nodeFs;
  try {
    const binding = deps.readBinding();
    if (!binding || binding.backend !== 'control-folder' || binding.state !== 'ready') return 'unchanged';
    const leaf = basename(binding.root);
    if (!isOpsFolderName(leaf) || isLegacyOpsFolderName(leaf)) return 'unchanged';
    const locked = await withMigrationLock(deps, async () => {
      if (fs.existsSync(join(deps.appDataDir, 'control-profile', OPS_FOLDER_MIGRATION_JOURNAL))) return 'unchanged' as const;
      return deps.withLease(binding.root, () => followRenamedOrigin(deps, binding.root));
    });
    return locked.entered ? locked.value : 'pending';
  } catch {
    return 'pending';
  }
}

function copyTrust(deps: OpsFolderMigrationDeps, fs: MigrationFs, aliases: PathAliases): {codex: OpsTrustCopy; antigravity: OpsTrustCopy} {
  // Claude Code keeps trust in ~/.claude.json with other state; it is never edited here.
  // Claude asks once at the new path.
  const safely = (copy: () => OpsTrustCopy): OpsTrustCopy => { try { return copy(); } catch { return 'unchanged'; } };
  return {codex: safely(() => copyCodexTrust(deps, fs, aliases)), antigravity: safely(() => copyAntigravityTrust(deps, fs, aliases))};
}

const tomlBasicString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** `[projects."<path>"]` or `[projects.'<path>']`, with the spacing and trailing comment TOML allows. */
const CODEX_PROJECT_HEADER = /^\s*\[\s*projects\s*\.\s*("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')\s*\]\s*(?:#.*)?$/;
function codexHeaderPath(line: string): string | null {
  const quoted = CODEX_PROJECT_HEADER.exec(line)?.[1];
  if (!quoted) return null;
  if (quoted.startsWith("'")) return quoted.slice(1, -1);
  // TOML basic strings share JSON's escapes for anything a path holds; an unparsable key matches nothing.
  try { return JSON.parse(quoted) as string; } catch { return null; }
}
function codexProjectSection(text: string, path: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => codexHeaderPath(line) === path);
  if (start < 0) return null;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length && !/^\s*\[/.test(lines[index]!); index += 1) body.push(lines[index]!);
  return body.join('\n');
}
/**
 * Whether the config already says anything about `path`: a header in any spelling, a dotted key or
 * an inline table under [projects]. Appending a second definition is a TOML error that breaks the
 * whole Codex config, so any mention — even an unrelated one — means nothing is appended.
 */
function codexMentionsProject(text: string, path: string): boolean {
  if (codexProjectSection(text, path) !== null) return true;
  return text.includes(tomlBasicString(path)) || (!path.includes("'") && text.includes(`'${path}'`));
}

/**
 * Appends a trusted section for the new path when the old one was trusted. Other sections are never
 * rewritten. Runs under the migration lock and re-reads the file there, so a repeat or a second
 * sidecar finds the section it would add and adds nothing.
 */
function copyCodexTrust(deps: OpsFolderMigrationDeps, fs: MigrationFs, aliases: PathAliases): OpsTrustCopy {
  const path = join(deps.homeDir, '.codex', 'config.toml');
  if (!fs.existsSync(path)) return 'unchanged';
  const text = fs.readFileSync(path, 'utf8');
  const targets = new Set<string>();
  for (const [from, to] of aliases) {
    if (/[\u0000-\u001f\u007f]/.test(to) || targets.has(to) || codexMentionsProject(text, to)) continue;
    if (/^\s*trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$/m.test(codexProjectSection(text, from) ?? '')) targets.add(to);
  }
  // Codex also keys hook approval by path ([hooks.state."<root>/.codex/hooks.json:<event>:…"]). The hook
  // file moved with the folder, so its recorded hash still holds; without the copy an OPS Workroom at
  // the new path stops at 「Hooks need review」 (live 2026-09-29, v543).
  const hooks: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const [from, to] of aliases) {
    if (/[\u0000-\u001f\u007f]/.test(to)) continue;
    lines.forEach((line, index) => {
      const key = codexHookStateKey(line);
      if (!key || !key.startsWith(`${from}/`)) return;
      const moved = to + key.slice(from.length);
      if (hooks.some(section => section.startsWith(`\n[hooks.state.${tomlBasicString(moved)}]`)) || codexMentionsKey(text, moved)) return;
      const body: string[] = [];
      for (let next = index + 1; next < lines.length && !/^\s*\[/.test(lines[next]!); next += 1) body.push(lines[next]!);
      while (body.length && !body.at(-1)!.trim()) body.pop();
      hooks.push(`\n[hooks.state.${tomlBasicString(moved)}]\n${body.join('\n')}\n`);
    });
  }
  if (!targets.size && !hooks.length) return 'unchanged';
  const sections = [...targets].map(to => `\n[projects.${tomlBasicString(to)}]\ntrust_level = "trusted"\n`).join('') + hooks.join('');
  fs.appendFileSync(path, `${text.endsWith('\n') || !text ? '' : '\n'}${sections}`);
  return 'added';
}

const CODEX_HOOK_STATE_HEADER = /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')\s*\]\s*(?:#.*)?$/;
function codexHookStateKey(line: string): string | null {
  const quoted = CODEX_HOOK_STATE_HEADER.exec(line)?.[1];
  if (!quoted) return null;
  if (quoted.startsWith("'")) return quoted.slice(1, -1);
  try { return JSON.parse(quoted) as string; } catch { return null; }
}
/** Any existing spelling of a hook-state key: appending a second table would break the whole config. */
function codexMentionsKey(text: string, key: string): boolean {
  return text.includes(tomlBasicString(key)) || (!key.includes("'") && text.includes(`'${key}'`));
}

/**
 * Each boot: trust that should have followed an earlier move is added now (a Mac that migrated with a
 * build that did not copy some entry). Additive only, from binding.legacyRoots to the current root.
 */
export async function topUpOpsTrust(deps: OpsFolderMigrationDeps): Promise<{codex: OpsTrustCopy; antigravity: OpsTrustCopy}> {
  const unchanged = {codex: 'unchanged' as OpsTrustCopy, antigravity: 'unchanged' as OpsTrustCopy};
  const fs = deps.fs ?? nodeFs;
  try {
    const binding = deps.readBinding() as (OpsBindingLocation & {legacyRoots?: unknown}) | null;
    if (!binding || binding.backend !== 'control-folder' || binding.state !== 'ready') return unchanged;
    const leaf = basename(binding.root);
    if (!isOpsFolderName(leaf) || isLegacyOpsFolderName(leaf) || !Array.isArray(binding.legacyRoots)) return unchanged;
    const aliases = binding.legacyRoots
      .filter((root): root is string => typeof root === 'string' && isAbsolute(root) && root !== binding.root)
      .map(root => [root, binding.root] as const);
    if (!aliases.length) return unchanged;
    const locked = await withMigrationLock(deps, async () => copyTrust(deps, fs, aliases));
    return locked.entered ? locked.value : unchanged;
  } catch {
    return unchanged;
  }
}

/** Adds the new path next to the old one in Antigravity's trusted workspaces; other keys are kept. */
function copyAntigravityTrust(deps: OpsFolderMigrationDeps, fs: MigrationFs, aliases: PathAliases): OpsTrustCopy {
  const path = join(deps.homeDir, '.gemini', 'antigravity-cli', 'settings.json');
  if (!fs.existsSync(path)) return 'unchanged';
  const target = fs.realpathSync(path), text = fs.readFileSync(target, 'utf8');
  const settings = JSON.parse(text) as Record<string, unknown>;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !Array.isArray(settings.trustedWorkspaces)) return 'unchanged';
  const trusted = [...settings.trustedWorkspaces as unknown[]];
  for (const [from, to] of aliases) if (trusted.includes(from) && !trusted.includes(to)) trusted.push(to);
  if (trusted.length === (settings.trustedWorkspaces as unknown[]).length) return 'unchanged';
  const indent = /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? 2;
  const temporary = `${target}.ops-folder-rename-${deps.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({...settings, trustedWorkspaces: trusted}, null, indent)}${text.endsWith('\n') ? '\n' : ''}`, {mode: fs.statSync(target).mode & 0o777});
  fs.renameSync(temporary, target);
  return 'added';
}
