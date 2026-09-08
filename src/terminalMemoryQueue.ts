import { memorySaveDispatchRetryable } from './memorySaveDispatcher';
import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AiTerminalAgent } from './aiTerminalProtocol';

export interface TerminalMemoryJob { sessionId: string; targetId: string; cwd: string; agent: AiTerminalAgent }
export type TerminalMemoryState = 'pending' | 'saving' | 'saved' | 'unchanged' | 'unavailable'
  | 'backup-pending' | 'failed' | 'retrying' | 'recovery-required';
export type TerminalMemorySaveResult = 'saved' | 'unchanged' | 'unavailable' | 'backup-pending' | 'pending';
export type TerminalMemoryStatus = Pick<TerminalMemoryJob, 'sessionId' | 'targetId'> & { state: TerminalMemoryState };
export interface TerminalMemoryPage {
  jobs: TerminalMemoryStatus[];
  total: number;
  unresolved: number;
  offset: number;
  nextOffset: number | null;
}
export const TERMINAL_MEMORY_COMPLETED_HISTORY_LIMIT = 128;
export const TERMINAL_MEMORY_STATUS_LIMIT = 256;
export const TERMINAL_MEMORY_BUSY_RETRY_MS = 30_000;
const LEGACY_MAX_BYTES = 8 * 1024 * 1024;
const STATES = new Set<TerminalMemoryState>([
  'pending', 'saving', 'saved', 'unchanged', 'unavailable', 'backup-pending', 'failed', 'retrying', 'recovery-required',
]);
type StoredJob = TerminalMemoryJob & { state: TerminalMemoryState; retryAt: number; sequence: number };
const completed = (state: TerminalMemoryState) => state === 'saved' || state === 'unchanged';

function validJob(raw: unknown): raw is TerminalMemoryJob {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const job = raw as TerminalMemoryJob;
  return typeof job.sessionId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(job.sessionId)
    && typeof job.targetId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(job.targetId)
    && typeof job.cwd === 'string' && job.cwd.length > 0 && job.cwd.length <= 4096 && !/[\0\r\n]/.test(job.cwd)
    && ['codex', 'claude', 'hermes', 'agy'].includes(job.agent);
}

/** Unresolved jobs stay on disk; only one job and a bounded status page are read.
 * A crashed in-flight save is ambiguous and requires review, never blind replay. */
export class TerminalMemoryQueue {
  #initialized = false;
  #busy = false;
  #activeSessionId: string | null = null;
  readonly #databasePath: string;
  constructor(
    private file: string,
    private save: (job: TerminalMemoryJob) => Promise<TerminalMemorySaveResult>,
    private now: () => number = Date.now,
  ) {
    this.#databasePath = `${file}.sqlite`;
  }

  #initialize(db: Database): void {
    if (this.#initialized) return;
    const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) throw new Error('워크룸 저장 대기열은 더 최신 앱이 필요합니다. 기존 기록은 보존했습니다.');
    db.transaction(() => {
      db.run(`CREATE TABLE IF NOT EXISTS jobs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL UNIQUE, targetId TEXT NOT NULL, cwd TEXT NOT NULL, agent TEXT NOT NULL,
        state TEXT NOT NULL, retryAt INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0, turn INTEGER NOT NULL DEFAULT 0
      )`);
      db.run('CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(state, retryAt, turn, sequence)');
      db.run('CREATE INDEX IF NOT EXISTS jobs_status ON jobs(completed, sequence DESC)');
      db.run('CREATE INDEX IF NOT EXISTS jobs_turn ON jobs(turn)');
      // Minimal idempotency fences survive pruning of successful display history.
      db.run('CREATE TABLE IF NOT EXISTS completed_sessions (sessionId TEXT PRIMARY KEY)');
      if (version === 0) this.#importLegacy(db);
      // Process exit cannot prove whether the AI committed before the receipt.
      db.run("UPDATE jobs SET state='recovery-required' WHERE state='saving'");
      this.#pruneCompleted(db);
      db.run('PRAGMA user_version=1');
    })();
    this.#initialized = true;
  }

  #importLegacy(db: Database): void {
    let fd: number;
    try { fd = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error: any) { if (error?.code === 'ENOENT') return; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > LEGACY_MAX_BYTES) throw new Error('legacy size or file type');
      const rows: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (!Array.isArray(rows)) throw new Error('legacy shape');
      const insert = db.query('INSERT INTO jobs(sessionId,targetId,cwd,agent,state,completed) VALUES (?,?,?,?,?,?)');
      const fence = db.query('INSERT OR IGNORE INTO completed_sessions VALUES (?)');
      for (const row of rows) {
        if (!validJob(row) || !('state' in row) || !STATES.has(row.state as TerminalMemoryState)) throw new Error('legacy row');
        const state = row.state as TerminalMemoryState;
        insert.run(row.sessionId, row.targetId, row.cwd, row.agent, state, Number(completed(state)));
        if (completed(state)) fence.run(row.sessionId);
      }
      // Keep the exact legacy file as a recoverable migration input. user_version
      // is committed with the imported rows so restarts never re-import it.
    } finally { closeSync(fd); }
  }

  #withDatabase<T>(operation: (db: Database) => T): T {
    let db: Database | null = null;
    try {
      mkdirSync(dirname(this.#databasePath), { recursive: true, mode: 0o700 });
      const path = join(realpathSync(dirname(this.#databasePath)), basename(this.#databasePath));
      db = new Database(path, sqliteConstants.SQLITE_OPEN_READWRITE | sqliteConstants.SQLITE_OPEN_CREATE | sqliteConstants.SQLITE_OPEN_NOFOLLOW);
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      db.run('PRAGMA busy_timeout=100');
      db.run('PRAGMA cache_size=-256');
      this.#initialize(db);
      return operation(db);
    } catch {
      throw new Error('워크룸 저장 대기열을 처리하지 못했습니다. 기존 기록은 보존했으며 확인이 필요합니다.');
    } finally { db?.close(); }
  }

  #pruneCompleted(db: Database): void {
    db.query('DELETE FROM jobs WHERE completed=1 AND sequence NOT IN (SELECT sequence FROM jobs WHERE completed=1 ORDER BY sequence DESC LIMIT ?)')
      .run(TERMINAL_MEMORY_COMPLETED_HISTORY_LIMIT);
  }

  enqueue(job: TerminalMemoryJob): void {
    if (!validJob(job)) throw new Error('워크룸 저장 작업이 올바르지 않습니다.');
    this.#withDatabase(db => {
      db.query(`INSERT OR IGNORE INTO jobs(sessionId,targetId,cwd,agent,state)
        SELECT ?,?,?,?,'pending' WHERE NOT EXISTS (SELECT 1 FROM completed_sessions WHERE sessionId=?)`)
        .run(job.sessionId, job.targetId, job.cwd, job.agent, job.sessionId);
    });
  }

  /** Host-verified document, journal and baseline completion, bound to the original job. */
  recordRecoveredLocalSave(job: TerminalMemoryJob, backupPending: boolean): void {
    if (!validJob(job)) throw new Error('워크룸 저장 작업이 올바르지 않습니다.');
    this.#withDatabase(db => db.transaction(() => {
      const state = backupPending ? 'backup-pending' : 'saved';
      // A repeated local receipt cannot undo an already verified backup result.
      const changed = db.query(`UPDATE jobs SET state=CASE WHEN state='saved' THEN state ELSE ? END,
        completed=CASE WHEN state='saved' THEN 1 ELSE ? END,retryAt=0
        WHERE sessionId=? AND targetId=? AND cwd=? AND agent=? AND state IN ('saving','recovery-required','failed','backup-pending','saved')`)
        .run(state,Number(!backupPending),job.sessionId,job.targetId,job.cwd,job.agent).changes;
      if (changed !== 1) throw new Error('워크룸 저장 신원이 일치하지 않습니다.');
      if (!backupPending) db.query('INSERT OR IGNORE INTO completed_sessions VALUES (?)').run(job.sessionId);
      this.#pruneCompleted(db);
    })());
  }

  statusPage(offset = 0, limit = TERMINAL_MEMORY_STATUS_LIMIT): TerminalMemoryPage {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > TERMINAL_MEMORY_STATUS_LIMIT) {
      throw new Error('저장 상태 페이지 요청이 올바르지 않습니다.');
    }
    return this.#withDatabase(db => {
      const total = (db.query('SELECT count(*) AS count FROM jobs').get() as { count: number }).count;
      const unresolved = (db.query('SELECT count(*) AS count FROM jobs WHERE completed=0').get() as { count: number }).count;
      const jobs = db.query('SELECT sessionId,targetId,state FROM jobs ORDER BY completed ASC,sequence DESC LIMIT ? OFFSET ?')
        .all(limit, offset) as TerminalMemoryStatus[];
      for (const row of jobs) {
        if (row.state === 'saving' && row.sessionId !== this.#activeSessionId) row.state = 'recovery-required';
      }
      return { jobs, total, unresolved, offset, nextOffset: offset + jobs.length < total ? offset + jobs.length : null };
    });
  }

  status(): TerminalMemoryStatus[] { return this.statusPage().jobs; }

  async tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const job = this.#withDatabase(db => db.transaction(() => {
        const candidate = db.query(`SELECT sequence,sessionId,targetId,cwd,agent,state,retryAt FROM jobs
          WHERE state IN ('pending','retrying') AND retryAt<=? ORDER BY turn,sequence LIMIT 1`).get(this.now()) as StoredJob | null;
        if (candidate) db.query("UPDATE jobs SET state='saving' WHERE sequence=?").run(candidate.sequence);
        return candidate;
      })());
      if (!job) return;
      this.#activeSessionId = job.sessionId;
      let state: TerminalMemoryState;
      try {
        state = await this.save({ sessionId: job.sessionId, targetId: job.targetId, cwd: job.cwd, agent: job.agent });
        if (!['saved', 'unchanged', 'unavailable', 'backup-pending', 'pending'].includes(state)) state = 'failed';
      } catch (error: any) {
        state = (error?.code === 'WORKSPACE_LEASE_BUSY' || memorySaveDispatchRetryable(error)) ? 'retrying'
          : ['WORKSPACE_LEASE_RECOVERY_REQUIRED','PROJECT_MEMORY_SESSION_RECOVERY_REQUIRED','PROJECT_MEMORY_DOCUMENT_RECOVERY_REQUIRED'].includes(error?.code) ? 'recovery-required' : 'failed';
      }
      this.#withDatabase(db => db.transaction(() => {
        const turn = (db.query('SELECT COALESCE(MAX(turn),0)+1 AS value FROM jobs').get() as { value: number }).value;
        // onLocalSaved may have durably completed the local save before a later
        // host receipt/backup step throws. Only backup success can advance that
        // result; stale failures or deferrals must never replay the memory model.
        const changed = db.query(`UPDATE jobs SET state=?,retryAt=?,completed=?,turn=? WHERE sequence=?
          AND (state='saving' OR (state='backup-pending' AND ?='saved'))`)
          .run(state, state === 'retrying' ? this.now() + TERMINAL_MEMORY_BUSY_RETRY_MS : 0, Number(completed(state)), turn, job.sequence, state).changes;
        if (changed === 1 && completed(state)) db.query('INSERT OR IGNORE INTO completed_sessions VALUES (?)').run(job.sessionId);
        this.#pruneCompleted(db);
      })());
    } finally { this.#activeSessionId = null; this.#busy = false; }
  }
}
