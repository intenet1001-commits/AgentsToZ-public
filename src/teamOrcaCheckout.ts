/** An Orca sidebar terminal requires an Orca-created checkout; an ordinary git worktree cannot be silently adopted. */
import {createHash} from 'node:crypto';
import {closeSync, existsSync, lstatSync, mkdirSync, openSync} from 'node:fs';
import {dirname, isAbsolute} from 'node:path';
import {Database} from 'bun:sqlite';
import type {TeamExternalOrcaRunner} from './teamExternalHost';

export interface TeamOrcaCheckoutInput {requestId: string; teamId: string; memberId: string; primaryPath: string; baseCommit: string}
export interface TeamOrcaCheckoutResult {path: string; branch: string}
export interface TeamOrcaCheckoutGit {
  /** Canonical paths and Git common-dir from actual Git/realpath inspection, not copies of the requested values. */
  primaryPath: string; checkoutPath: string; primaryCommonDir: string; checkoutCommonDir: string;
  head: string; branch: string | null; worktrees: Array<{path: string; branch: string | null}>; branches: string[];
}
export interface TeamOrcaCheckoutRecord {
  version: 1; key: string; revision: number; fingerprint: string; input: TeamOrcaCheckoutInput;
  state: 'reserved' | 'created' | 'unknown'; result?: TeamOrcaCheckoutResult;
  /** Unverified candidate is retained for reconciliation, never treated as an owned/verified checkout. */
  candidate?: Partial<TeamOrcaCheckoutResult>; reason?: string;
}
/** Durable atomic CAS. TeamStore can implement this in its own transaction instead of using the supplied SQLite factory. */
export interface TeamOrcaCheckoutJournal {
  read(key: string): Promise<TeamOrcaCheckoutRecord | null>;
  compareAndSet(key: string, revision: number | null, next: TeamOrcaCheckoutRecord): Promise<boolean>;
}
export interface TeamOrcaCheckoutDeps {
  journal: TeamOrcaCheckoutJournal;
  resolveOrcaCli(): string | null | Promise<string | null>;
  runOrca: TeamExternalOrcaRunner;
  /** Called before creation with newPath=primaryPath, then with the actual result.worktree.path. Must be read-only. */
  inspectGit(primaryPath: string, newPath: string): Promise<TeamOrcaCheckoutGit>;
  /** Caller additionally holds the existing workspace lease. No new checkout is created for a superseded member. */
  isCurrent?(input: TeamOrcaCheckoutInput): boolean;
}
export class TeamOrcaCheckoutError extends Error {
  constructor(readonly code: string, readonly receipt?: TeamOrcaCheckoutRecord) {super(code);}
}
const copy = <T>(value: T): T => structuredClone(value);
const fail = (code: string, receipt?: TeamOrcaCheckoutRecord): never => {throw new TeamOrcaCheckoutError(code, receipt ? copy(receipt) : undefined);};
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): value is string => typeof value === 'string' && !!value && !/[\x00-\x20\x7f]/.test(value);
const path = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const branchName = (value: string) => value.replace(/^refs\/heads\//, '');
function safeBranch(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(value) && value !== 'HEAD' && value !== '@' && !value.includes('..') && !value.includes('@{')
    && !value.endsWith('.') && !value.endsWith('/') && value.split('/').every(part => !!part && !part.startsWith('.') && !part.endsWith('.lock'));
}
const fingerprint = (input: TeamOrcaCheckoutInput) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
function normalize(raw: TeamOrcaCheckoutInput): TeamOrcaCheckoutInput {
  if (!raw || Object.keys(raw).some(key => !['requestId', 'teamId', 'memberId', 'primaryPath', 'baseCommit'].includes(key))
    || !text(raw.requestId) || raw.requestId.length > 200 || !text(raw.teamId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(raw.teamId)
    || !text(raw.memberId) || !/^[a-zA-Z0-9_-]{1,24}$/.test(raw.memberId) || !path(raw.primaryPath) || !text(raw.baseCommit)
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(raw.baseCommit)) fail('ORCA_TEAM_CHECKOUT_INPUT_INVALID');
  return {requestId: raw.requestId, teamId: raw.teamId, memberId: raw.memberId, primaryPath: raw.primaryPath, baseCommit: raw.baseCommit.toLowerCase()};
}
function assertPrimary(facts: TeamOrcaCheckoutGit, primary: string): void {
  if (facts.primaryPath !== primary || facts.checkoutPath !== primary || !path(facts.primaryCommonDir) || facts.primaryCommonDir !== facts.checkoutCommonDir
    || facts.worktrees.filter(entry => entry.path === primary).length !== 1) fail('ORCA_TEAM_PRIMARY_UNVERIFIED');
}
function verify(before: TeamOrcaCheckoutGit, after: TeamOrcaCheckoutGit, input: TeamOrcaCheckoutInput, result: TeamOrcaCheckoutResult): void {
  const branch = branchName(after.branch ?? '');
  if (after.primaryPath !== input.primaryPath || after.primaryCommonDir !== before.primaryCommonDir || after.checkoutCommonDir !== before.primaryCommonDir
    || after.checkoutPath !== result.path || result.path === input.primaryPath || before.worktrees.some(entry => entry.path === result.path)
    || after.head.toLowerCase() !== input.baseCommit || !safeBranch(result.branch) || branch !== result.branch
    || before.branches.some(existing => branchName(existing) === result.branch)
    || after.worktrees.filter(entry => entry.path === result.path && branchName(entry.branch ?? '') === result.branch).length !== 1
    || after.worktrees.filter(entry => branchName(entry.branch ?? '') === result.branch).length !== 1
    || after.worktrees.filter(entry => entry.path === result.path).length !== 1
    || after.worktrees.filter(entry => entry.path === input.primaryPath).length !== 1) fail('ORCA_TEAM_CHECKOUT_GIT_UNVERIFIED');
}

export function createTeamOrcaCheckout(deps: TeamOrcaCheckoutDeps) {
  const current = (input: TeamOrcaCheckoutInput) => !deps.isCurrent || deps.isCurrent(copy(input));
  return async function create(raw: TeamOrcaCheckoutInput): Promise<TeamOrcaCheckoutResult> {
    const input = normalize(raw), key = `${input.teamId}:${input.memberId}`, hash = fingerprint(input);
    const previous = await deps.journal.read(key);
    if (previous) {
      if (previous.fingerprint !== hash) return fail('ORCA_TEAM_CHECKOUT_CONFLICT', previous);
      if (previous.state === 'created' && previous.result) return copy(previous.result);
      return fail('ORCA_TEAM_CHECKOUT_UNKNOWN', previous);
    }
    if (!current(input)) return fail('ORCA_TEAM_CHECKOUT_STALE');
    const cli = await deps.resolveOrcaCli();
    if (!cli) return fail('ORCA_TEAM_CHECKOUT_NOT_CONNECTED');
    const before = copy(await deps.inspectGit(input.primaryPath, input.primaryPath));
    assertPrimary(before, input.primaryPath);
    if (!current(input)) return fail('ORCA_TEAM_CHECKOUT_STALE');
    const reserved: TeamOrcaCheckoutRecord = {version: 1, key, revision: 1, fingerprint: hash, input, state: 'reserved'};
    if (!await deps.journal.compareAndSet(key, null, copy(reserved))) return create(input);
    let candidate: Partial<TeamOrcaCheckoutResult> | undefined;
    try {
      if (!current(input)) return fail('ORCA_TEAM_CHECKOUT_STALE');
      const rawResult = await deps.runOrca(cli, ['worktree', 'create', '--repo', `path:${input.primaryPath}`, '--name', `atz-${input.teamId}-${input.memberId}`,
        '--base-branch', input.baseCommit, '--setup', 'skip', '--no-parent', '--json'], {cwd: '/', timeoutMs: 30_000, attempts: 1});
      const envelope = object(rawResult), body = object(envelope?.result), worktree = object(body?.worktree);
      candidate = {...(path(worktree?.path) ? {path: worktree.path} : {}), ...(text(worktree?.branch) ? {branch: branchName(worktree.branch)} : {})};
      if (envelope?.ok !== true || !candidate.path || !candidate.branch || !safeBranch(candidate.branch)) return fail('ORCA_TEAM_CHECKOUT_RESULT_UNVERIFIED');
      const result = {path: candidate.path, branch: candidate.branch};
      const after = copy(await deps.inspectGit(input.primaryPath, result.path));
      verify(before, after, input, result);
      if (!current(input)) return fail('ORCA_TEAM_CHECKOUT_STALE');
      const settled: TeamOrcaCheckoutRecord = {...reserved, revision: 2, state: 'created', result};
      if (!await deps.journal.compareAndSet(key, 1, settled)) return fail('ORCA_TEAM_CHECKOUT_PERSISTENCE_UNKNOWN');
      return copy(result);
    } catch (cause) {
      const unknown: TeamOrcaCheckoutRecord = {...reserved, revision: 2, state: 'unknown', ...(candidate ? {candidate} : {}),
        reason: cause instanceof TeamOrcaCheckoutError ? cause.code : 'ORCA_TEAM_CHECKOUT_OUTCOME_UNKNOWN'};
      // Never re-run the CLI or remove a possibly-created checkout to repair an uncertain response/persistence write.
      await deps.journal.compareAndSet(key, 1, unknown).catch(() => false);
      return fail('ORCA_TEAM_CHECKOUT_UNKNOWN', unknown);
    }
  };
}

/** Bounded, durable exactly-once tombstones. No active, unknown or created record is evicted; capacity fails closed. */
export function createTeamOrcaCheckoutJournal(file: string, limits: {maxRecords?: number; maxBytes?: number} = {}): TeamOrcaCheckoutJournal & {close(): void} {
  const maxRecords = limits.maxRecords ?? 2_048, maxBytes = limits.maxBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('ORCA_TEAM_CHECKOUT_JOURNAL_CAPACITY_INVALID');
  mkdirSync(dirname(file), {recursive: true, mode: 0o700});
  if (!existsSync(file)) {try {closeSync(openSync(file, 'wx', 0o600));} catch (cause) {if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;}}
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail('ORCA_TEAM_CHECKOUT_JOURNAL_UNSAFE');
  const db = new Database(file, {create: true});
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250; CREATE TABLE IF NOT EXISTS team_orca_checkout_receipts (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, record_json TEXT NOT NULL)');
  const get = db.query('SELECT revision, record_json FROM team_orca_checkout_receipts WHERE key = ?');
  function stored(key: string): TeamOrcaCheckoutRecord | null {
    const row = get.get(key) as {revision: number; record_json: string} | null;
    if (!row) return null;
    const parsed = object(JSON.parse(row.record_json));
    if (parsed?.version !== 1 || parsed.key !== key || parsed.revision !== row.revision || !['reserved', 'created', 'unknown'].includes(String(parsed.state))) return fail('ORCA_TEAM_CHECKOUT_JOURNAL_CORRUPT');
    return parsed as unknown as TeamOrcaCheckoutRecord;
  }
  const cas = db.transaction((key: string, revision: number | null, next: TeamOrcaCheckoutRecord) => {
    const previous = stored(key);
    if ((previous?.revision ?? null) !== revision) return false;
    if (next.version !== 1 || next.key !== key || next.revision !== (revision ?? 0) + 1 || previous && previous.fingerprint !== next.fingerprint) return fail('ORCA_TEAM_CHECKOUT_JOURNAL_REVISION_INVALID');
    const size = db.query('SELECT count(*) AS count, coalesce(sum(length(CAST(record_json AS BLOB))),0) AS bytes FROM team_orca_checkout_receipts').get() as {count: number; bytes: number};
    const data = JSON.stringify(next), oldBytes = previous ? Buffer.byteLength(JSON.stringify(previous)) : 0;
    if (!previous && size.count >= maxRecords || size.bytes - oldBytes + Buffer.byteLength(data) > maxBytes) return fail('ORCA_TEAM_CHECKOUT_JOURNAL_CAPACITY');
    db.query('INSERT INTO team_orca_checkout_receipts (key, revision, record_json) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision, record_json=excluded.record_json').run(key, next.revision, data);
    return true;
  });
  return {read: async key => copy(stored(key)), compareAndSet: async (key, revision, next) => cas.immediate(key, revision, copy(next)), close: () => db.close()};
}
