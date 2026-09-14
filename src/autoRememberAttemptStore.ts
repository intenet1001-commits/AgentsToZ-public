import { Database, constants } from 'bun:sqlite';
import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AutoRememberBackup, MemoryBackupStatus } from './memoryBackupContract';

export interface AutoRememberAttempt {
  turnId: string;
  threshold: number;
  retryAfterAt: string | null;
  terminalForTurn: boolean;
  message: string;
}

export interface AutoRememberReceipt {
  saveId?: string;
  localWarning?: string;
  completedThresholds: number[];
  lastCheckpointAt: string | null;
  lastCheckpointThreshold: number | null;
  projectId: string | null;
  projectName: string | null;
  backupWarning: string | null;
}

/** Durable duplicate fences, queried by session ID instead of loading all past
 * failures into a growing Map or discarding them at a 256-session boundary. */
export class AutoRememberAttemptStore {
  readonly #path: string;
  #legacy: Record<string, AutoRememberAttempt> | null;

  constructor(path: string, legacy: Record<string, AutoRememberAttempt>,
    readonly legacyReceipts: Record<string, AutoRememberReceipt> = {},
    readonly legacyEpoch = '') {
    this.#path = path;
    this.#legacy = legacy;
  }

  #initialize(db: Database): void {
    if (this.#legacy !== null) {
      const version = db.query('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version > 4) throw new Error('자동 저장 시도 기록은 더 최신 앱이 필요합니다.');
      db.transaction(() => {
        db.run('CREATE TABLE IF NOT EXISTS attempts (session_id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
        db.run('CREATE TABLE IF NOT EXISTS receipts (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, payload TEXT NOT NULL)');
        db.run('CREATE TABLE IF NOT EXISTS intents (session_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE)');
        if (version.user_version < 2) {
          const receipt = db.query('INSERT OR IGNORE INTO receipts VALUES (?, ?, ?)');
          for (const [id, value] of Object.entries(this.legacyReceipts)) {
            receipt.run(id, this.legacyEpoch, JSON.stringify(value));
          }
        }
        db.run('CREATE TABLE IF NOT EXISTS outcomes (session_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, epoch TEXT NOT NULL, receipt TEXT NOT NULL)');
        db.run(`CREATE TABLE IF NOT EXISTS backups (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL, epoch TEXT NOT NULL, checkpoint_at TEXT,
          payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0)`);
        db.run('CREATE INDEX IF NOT EXISTS backups_due ON backups(state, retry_at, sequence)');
        // The partial index serves both eligible states in due order without
        // sorting the accumulated pending queue for every LIMIT 1 poll.
        db.run("CREATE INDEX IF NOT EXISTS backups_ready ON backups(retry_at, sequence) WHERE state IN ('pending','retrying')");
        db.run('CREATE TABLE IF NOT EXISTS completion_contexts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, epoch TEXT NOT NULL, root TEXT NOT NULL, memory_id TEXT NOT NULL, receipt TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0)');
        db.run('PRAGMA user_version=4');
        const insert = db.query('INSERT OR IGNORE INTO attempts VALUES (?, ?)');
        for (const [id, attempt] of Object.entries(this.#legacy!)) insert.run(id, JSON.stringify(attempt));
      })();
      this.#legacy = null;
    }
  }

  #withDatabase<T>(operation: (db: Database) => T): T {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const path = join(realpathSync(dirname(this.#path)), basename(this.#path));
    const db = new Database(path, constants.SQLITE_OPEN_READWRITE
      | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_NOFOLLOW);
    try {
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      db.run('PRAGMA busy_timeout=100');
      db.run('PRAGMA cache_size=-256');
      this.#initialize(db);
      return operation(db);
    } finally { db.close(); }
  }

  get(sessionId: string): AutoRememberAttempt | undefined {
    return this.#withDatabase(db => {
      const row = db.query('SELECT payload FROM attempts WHERE session_id=?').get(sessionId) as { payload: string } | null;
      return row ? JSON.parse(row.payload) : undefined;
    });
  }

  set(sessionId: string, attempt: AutoRememberAttempt): void {
    this.#withDatabase(db => db.query('INSERT OR REPLACE INTO attempts VALUES (?, ?)')
      .run(sessionId, JSON.stringify(attempt)));
  }

  delete(sessionId: string): void {
    this.#withDatabase(db => db.query('DELETE FROM attempts WHERE session_id=?').run(sessionId));
  }

  clear(): void {
    this.#withDatabase(db => db.run('DELETE FROM attempts'));
  }

  receipt(sessionId: string, epoch: string): AutoRememberReceipt | undefined {
    return this.#withDatabase(db => {
      const row = db.query('SELECT payload FROM receipts WHERE session_id=? AND epoch=?')
        .get(sessionId, epoch) as { payload: string } | null;
      return row ? JSON.parse(row.payload) : undefined;
    });
  }

  setReceipt(sessionId: string, epoch: string, receipt: AutoRememberReceipt): void {
    this.#withDatabase(db => db.query('INSERT OR REPLACE INTO receipts VALUES (?, ?, ?)')
      .run(sessionId, epoch, JSON.stringify(receipt)));
  }

  hasIntent(sessionId: string): boolean {
    return this.#withDatabase(db => !!db.query('SELECT 1 FROM intents WHERE session_id=?').get(sessionId));
  }

  /** Must commit before invoking the provider. A crash leaves this fence intact,
   * including across opt-out/opt-in. No transcript or local path is stored. */
  begin(sessionId: string, intentId: string, epoch: string, expected: AutoRememberReceipt): boolean {
    return this.#withDatabase(db => db.transaction(() => {
      const current = db.query('SELECT payload FROM receipts WHERE session_id=? AND epoch=?')
        .get(sessionId, epoch) as { payload: string } | null;
      if (current ? current.payload !== JSON.stringify(expected) : expected.lastCheckpointAt !== null) return false;
      return db.query('INSERT OR IGNORE INTO intents VALUES (?, ?)')
        .run(sessionId, intentId).changes === 1;
    })());
  }

  finish(sessionId: string, intentId: string, epoch: string, receipt: AutoRememberReceipt): void {
    this.#withDatabase(db => db.transaction(() => {
      const owned = db.query('SELECT 1 FROM intents WHERE session_id=? AND intent_id=?').get(sessionId, intentId);
      if (!owned) {
        const current = db.query('SELECT payload FROM receipts WHERE session_id=?').get(sessionId) as { payload: string } | null;
        if (current && JSON.parse(current.payload).saveId === intentId) return;
        throw new Error('자동 저장 실행 기록이 일치하지 않습니다.');
      }
      db.query('INSERT OR REPLACE INTO receipts VALUES (?, ?, ?)').run(sessionId, epoch, JSON.stringify(receipt));
      db.query('DELETE FROM attempts WHERE session_id=?').run(sessionId);
      db.query('DELETE FROM intents WHERE session_id=? AND intent_id=?').run(sessionId, intentId);
      db.query('DELETE FROM outcomes WHERE session_id=? AND intent_id=?').run(sessionId, intentId);
      db.query("UPDATE completion_contexts SET completed=1,receipt='{}' WHERE id=?").run(intentId);
    })());
  }

  fail(sessionId: string, intentId: string | null, attempt: AutoRememberAttempt): void {
    this.#withDatabase(db => db.transaction(() => {
      db.query('INSERT OR REPLACE INTO attempts VALUES (?, ?)').run(sessionId, JSON.stringify(attempt));
      if (intentId) db.query('DELETE FROM intents WHERE session_id=? AND intent_id=?').run(sessionId, intentId);
    })());
  }

  recordOutcome(sessionId: string, intentId: string, epoch: string, receipt: AutoRememberReceipt,
    backup?: AutoRememberBackup): void {
    if (Buffer.byteLength(JSON.stringify(receipt)) > 16_384
      || (backup && Buffer.byteLength(JSON.stringify(backup)) > 16_384)) {
      throw new Error('자동 저장 영수증의 메타데이터 제한을 초과했습니다.');
    }
    this.#withDatabase(db => db.transaction(() => {
      if (!db.query('SELECT 1 FROM intents WHERE session_id=? AND intent_id=?').get(sessionId, intentId)) {
        throw new Error('자동 저장 실행 기록이 일치하지 않습니다.');
      }
      db.query('INSERT OR IGNORE INTO outcomes VALUES (?, ?, ?, ?)')
        .run(sessionId, intentId, epoch, JSON.stringify(receipt));
      if (backup) db.query('INSERT OR IGNORE INTO backups (id,session_id,epoch,checkpoint_at,payload) VALUES (?, ?, ?, ?, ?)')
        .run(intentId, sessionId, epoch, receipt.lastCheckpointAt, JSON.stringify(backup));
    })());
  }

  /** Only a host-confirmed local outcome may repair a receipt. An intent alone
   * is never proof, regardless of elapsed time, PID, policy, or current hash. */
  recoverOutcomes(): void {
    this.#withDatabase(db => db.transaction(() => {
      const rows = db.query(`SELECT o.* FROM outcomes o JOIN intents i
        ON o.session_id=i.session_id AND o.intent_id=i.intent_id LIMIT 24`).all() as
        { session_id: string; intent_id: string; epoch: string; receipt: string }[];
      for (const row of rows) {
        db.query('INSERT OR REPLACE INTO receipts VALUES (?, ?, ?)').run(row.session_id, row.epoch, row.receipt);
        db.query('DELETE FROM attempts WHERE session_id=?').run(row.session_id);
        db.query('DELETE FROM intents WHERE session_id=? AND intent_id=?').run(row.session_id, row.intent_id);
        db.query('DELETE FROM outcomes WHERE session_id=?').run(row.session_id);
        db.query("UPDATE completion_contexts SET completed=1,receipt='{}' WHERE id=?").run(row.intent_id);
      }
    })());
  }

  prepareCompletion(input: { id: string; sessionId: string; epoch: string; root: string; memoryId: string; receipt: AutoRememberReceipt }): void {
    if (Buffer.byteLength(JSON.stringify(input)) > 16_384) throw new Error('완료 근거 크기 제한을 초과했습니다.');
    this.#withDatabase(db => {
      if (!db.query('SELECT 1 FROM intents WHERE session_id=? AND intent_id=?').get(input.sessionId,input.id)) throw new Error('저장 실행 기록이 일치하지 않습니다.');
      db.query('INSERT INTO completion_contexts (id,session_id,epoch,root,memory_id,receipt) VALUES (?,?,?,?,?,?)').run(input.id,input.sessionId,input.epoch,input.root,input.memoryId,JSON.stringify(input.receipt));
    });
  }

  completeRecovered(id: string, root: string, memoryId: string, result: { backup?: AutoRememberBackup; backupWarning: string|null }): void {
    const context = this.#withDatabase(db => db.query('SELECT * FROM completion_contexts WHERE id=? AND root=? AND memory_id=?')
      .get(id,root,memoryId) as {session_id:string;epoch:string;receipt:string;completed:number}|null);
    if (!context) throw new Error('자동 저장의 호스트 완료 근거가 없습니다.');
    if (context.completed === 1) return;
    const receipt: AutoRememberReceipt = JSON.parse(context.receipt);
    receipt.backupWarning = result.backupWarning;
    if (this.receipt(context.session_id,context.epoch)?.saveId === id) return;
    this.recordOutcome(context.session_id,id,context.epoch,receipt,result.backup);
    this.recoverOutcomes();
  }

  claimBackup(now: number): { id: string; backup: AutoRememberBackup; attempt: number } | null {
    return this.#withDatabase(db => db.transaction(() => {
      const row = db.query(`SELECT id,payload,attempts FROM backups
        WHERE state IN ('pending','retrying') AND retry_at<=? ORDER BY retry_at,sequence LIMIT 1`)
        .get(now) as { id: string; payload: string; attempts: number } | null;
      if (!row) return null;
      if (row.attempts >= 8) {
        db.query("UPDATE backups SET state='blocked' WHERE id=?").run(row.id);
        return null;
      }
      // Persist backoff before networking; a restart cannot create a hot loop.
      const attempt = row.attempts + 1;
      db.query("UPDATE backups SET state='retrying',attempts=?,retry_at=? WHERE id=?")
        .run(attempt, now + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempt, 7)), row.id);
      return { id: row.id, backup: JSON.parse(row.payload), attempt };
    })());
  }

  finishBackup(id: string, state: 'complete' | 'blocked'): void {
    this.#withDatabase(db => db.transaction(() => {
      db.query('UPDATE backups SET state=? WHERE id=?').run(state, id);
      if (state === 'complete') {
        const job = db.query('SELECT session_id,epoch,checkpoint_at FROM backups WHERE id=?').get(id) as
          { session_id: string; epoch: string; checkpoint_at: string } | null;
        const row = job && db.query('SELECT payload FROM receipts WHERE session_id=? AND epoch=?')
          .get(job.session_id, job.epoch) as { payload: string } | null;
        if (row && job) {
          const receipt: AutoRememberReceipt = JSON.parse(row.payload);
          if (receipt.saveId === id) {
            receipt.backupWarning = receipt.localWarning ?? null;
            db.query('UPDATE receipts SET payload=? WHERE session_id=? AND epoch=?')
              .run(JSON.stringify(receipt), job.session_id, job.epoch);
          }
        }
        db.run("DELETE FROM backups WHERE state='complete' AND sequence NOT IN (SELECT sequence FROM backups WHERE state='complete' ORDER BY sequence DESC LIMIT 128)");
      }
    })());
  }

  deferBusyBackup(id: string, attempt: number, now: number): void {
    this.#withDatabase(db => db.query(`UPDATE backups SET attempts=attempts-1,retry_at=?
      WHERE id=? AND state='retrying' AND attempts=?`).run(now + 30_000, id, attempt));
  }

  backupStatus(): MemoryBackupStatus[] {
    return this.#withDatabase(db => {
      const rows = db.query("SELECT id,payload,state,attempts FROM backups WHERE state!='complete' ORDER BY sequence LIMIT 24").all() as
        { id: string; payload: string; state: MemoryBackupStatus['state']; attempts: number }[];
      return rows.map(row => ({ jobId: row.id, projectName: String(JSON.parse(row.payload).projectName ?? '').slice(0, 120),
        state: row.state, attempts: row.attempts }));
    });
  }
}
