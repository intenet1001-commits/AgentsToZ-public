import { Database, constants } from 'bun:sqlite';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { MemoryDocumentManifest } from './memoryDocumentTransaction';
import type { TerminalMemoryJob } from './terminalMemoryQueue';
import type { MemoryBackupGuard } from './memoryBackupContract';
import type { ProjectMemoryJournalEntry } from '../project-memory-server';

export type MemorySessionPhase = 'document' | 'journal' | 'state' | 'outcome';
export interface MemorySessionPlan {
  version: 1;
  id: string;
  root: string;
  memoryId: string;
  sourcePath: string;
  afterHash: string;
  document: MemoryDocumentManifest | null;
  state: MemoryDocumentManifest | null;
  journal: ProjectMemoryJournalEntry;
  automaticSaveId?: string;
  saveV2?: {saveId:string;attemptId:string};
  workroomJob?: TerminalMemoryJob;
  backup?: MemoryBackupGuard;
  backupRequested: boolean;
}
export interface MemorySessionPending { plan: MemorySessionPlan; phase: MemorySessionPhase }
export class MemorySessionRecoveryError extends Error {
  readonly code = 'PROJECT_MEMORY_SESSION_RECOVERY_REQUIRED';
  constructor(message = '중단된 세션 저장을 먼저 복구해 주세요.') { super(message); }
}

/** Host-owned proposals. One unresolved local writer per root; never evict it. */
export class MemorySessionStore {
  constructor(readonly path: string) {}
  #db<T>(fn: (db: Database) => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const path = join(realpathSync(dirname(this.path)), basename(this.path));
    const db = new Database(path, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_NOFOLLOW);
    try {
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      db.run('PRAGMA busy_timeout=100');
      db.run('PRAGMA synchronous=FULL');
      db.run('PRAGMA cache_size=-256');
      const version = (db.query('PRAGMA user_version').get() as {user_version: number}).user_version;
      if (version > 2) throw new MemorySessionRecoveryError('세션 복구 기록은 더 최신 앱이 필요합니다.');
      if (version === 0) db.transaction(() => {
      db.run('CREATE TABLE IF NOT EXISTS pending (root TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, phase TEXT NOT NULL, payload TEXT NOT NULL)');
      db.run('CREATE TABLE IF NOT EXISTS completed (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, root TEXT NOT NULL, after_hash TEXT NOT NULL, memory_id TEXT NOT NULL)');
      db.run('PRAGMA user_version=1');
      })();
      // Older hosts must not apply/retire a V2-bound plan without its save receipt.
      // Rows stay compatible; raising the schema fences their legacy writer.
      if (version < 2) db.run('PRAGMA user_version=2');
      return fn(db);
    } finally { db.close(); }
  }
  get(root: string): MemorySessionPending | null {
    return this.#db(db => {
      const row = db.query('SELECT id,phase,payload FROM pending WHERE root=?').get(root) as {id:string;phase:MemorySessionPhase;payload:string}|null;
      if (!row) return null;
      if (Buffer.byteLength(row.payload) > 20 * 1024 * 1024) throw new MemorySessionRecoveryError();
      const plan = JSON.parse(row.payload) as MemorySessionPlan;
      if (plan.version !== 1 || plan.root !== root || plan.id !== row.id
        || !['document','journal','state','outcome'].includes(row.phase)) throw new MemorySessionRecoveryError();
      return { plan, phase: row.phase };
    });
  }
  status(root: string, options: {readOnly?:boolean} = {}): { id: string; phase: MemorySessionPhase } | null {
    if(options.readOnly){
      let stamp;
      try{stamp=lstatSync(this.path);}catch(error:any){if(error?.code==='ENOENT')return null;throw new MemorySessionRecoveryError();}
      if(!stamp.isFile()||stamp.isSymbolicLink())throw new MemorySessionRecoveryError();
      let db:Database|undefined;
      try{
        db=new Database(join(realpathSync(dirname(this.path)),basename(this.path)),constants.SQLITE_OPEN_READONLY|constants.SQLITE_OPEN_NOFOLLOW);
        db.run('PRAGMA busy_timeout=100');db.run('PRAGMA cache_size=-256');
        const version=(db.query('PRAGMA user_version').get() as {user_version:number}).user_version;
        if(version<1||version>2)throw new MemorySessionRecoveryError();
        const row=db.query('SELECT CASE WHEN length(id)<=128 THEN id ELSE NULL END AS id, CASE WHEN length(phase)<=16 THEN phase ELSE NULL END AS phase FROM pending WHERE root=?').get(root) as {id:string|null;phase:MemorySessionPhase|null}|null;
        if(!row)return null;
        if(typeof row.id!=='string'||!/^[a-zA-Z0-9_.:-]{1,128}$/.test(row.id)||!row.phase||!['document','journal','state','outcome'].includes(row.phase))throw new MemorySessionRecoveryError();
        return {id:row.id,phase:row.phase};
      }catch{throw new MemorySessionRecoveryError();}finally{db?.close();}
    }
    return this.#db(db => db.query('SELECT id,phase FROM pending WHERE root=?').get(root) as {id:string;phase:MemorySessionPhase}|null);
  }
  assertReady(root: string): void { if (this.status(root)) throw new MemorySessionRecoveryError(); }
  prepare(plan: MemorySessionPlan): void {
    const payload = JSON.stringify(plan);
    if (Buffer.byteLength(payload) > 20 * 1024 * 1024) throw new MemorySessionRecoveryError('세션 복구 기록 크기 제한을 초과했습니다.');
    this.#db(db => {
      if (db.query('INSERT OR IGNORE INTO pending VALUES (?,?,?,?)').run(plan.root, plan.id, 'document', payload).changes !== 1) throw new MemorySessionRecoveryError();
    });
  }
  advance(root: string, id: string, from: MemorySessionPhase, to: MemorySessionPhase): void {
    this.#db(db => {
      if (db.query('UPDATE pending SET phase=? WHERE root=? AND id=? AND phase=?').run(to, root, id, from).changes !== 1) throw new MemorySessionRecoveryError();
    });
  }
  completed(root: string, id: string): {after_hash:string;memory_id:string}|null {
    return this.#db(db=>db.query('SELECT after_hash,memory_id FROM completed WHERE root=? AND id=?').get(root,id) as {after_hash:string;memory_id:string}|null);
  }
  finish(root: string, id: string): void {
    this.#db(db => db.transaction(() => {
      const row = db.query("SELECT payload FROM pending WHERE root=? AND id=? AND phase='outcome'").get(root,id) as {payload:string}|null;
      if (!row) throw new MemorySessionRecoveryError();
      const plan = JSON.parse(row.payload) as MemorySessionPlan;
      db.query('INSERT OR IGNORE INTO completed (id,root,after_hash,memory_id) VALUES (?,?,?,?)').run(id,root,plan.afterHash,plan.memoryId);
      db.query('DELETE FROM pending WHERE root=? AND id=?').run(root,id);
      db.run('DELETE FROM completed WHERE sequence NOT IN (SELECT sequence FROM completed ORDER BY sequence DESC LIMIT 128)');
    })());
  }
}
