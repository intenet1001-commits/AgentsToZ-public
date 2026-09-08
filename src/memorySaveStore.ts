import {automaticMemoryObservationBoundary,migrateAutomaticMemoryPolicy,readAutomaticMemoryPolicy,changeAutomaticMemoryPolicy,assertLegacyAttemptAllowed,checkAutomaticMemoryAdmission,reserveAutomaticMemoryAdmission,type AutomaticMemoryPolicyInput} from './memorySaveAutomaticPolicy';
import { Database, constants } from 'bun:sqlite';
import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {canonicalMemoryProviderBinding,type MemoryProviderBinding} from './memorySaveProviderContract';
import type {MemoryInputBinding} from './memorySaveInputStore';
import {MEMORY_INPUT_TTL} from './memorySaveInputStore';
import { canonicalSaveSource, memorySaveSourceKey, MEMORY_SAVE_PAGE_LIMIT, MemorySaveError,
  saveDigest, saveHash, saveInteger, saveToken, type MemorySaveSource, type MemorySaveJob,
  type MemorySaveCommitReceipt, type MemorySaveAttemptIntent, type MemorySaveHostBinding } from './memorySaveContract';

type SourceRow = { sourceKey: string; payload: string; saveId: string | null };
const jobProjection = 'sequence,saveId,memoryId,policyEpoch,coverageDigest,phase,attemptId';
export interface MemoryInputExpiryCursor {createdAt:number;sequence:number}
export const MEMORY_INPUT_EXPIRY_TIE_SQL = `SELECT sequence,saveId,createdAt FROM save_input_bindings
  WHERE expired=0 AND createdAt=? AND sequence>?
  ORDER BY sequence LIMIT 9`;
export const MEMORY_INPUT_EXPIRY_PAGE_SQL = `SELECT sequence,saveId,createdAt FROM save_input_bindings
  WHERE expired=0 AND createdAt>? AND createdAt<=?
  ORDER BY createdAt,sequence LIMIT ?`;

/** V2 host persistence only. No timers, model execution, automatic policy activation or legacy migration.
 * beginAutomaticAttempt adds durable consent/quota admission. The future single
 * dispatcher must still verify fresh source/registration, lease, disk budgets and
 * provider readiness; this store grants no process execution authority.
 * commitLocal is called only after host manifest verification.
 * Reopening never replays or resets an ambiguous attempt, including while another owner lives. */
export class MemorySaveStore {
  constructor(readonly path: string, private now:()=>number=Date.now) {}
  #db<T>(fn: (db: Database) => T): T {
    let db: Database | undefined;
    try {
      mkdirSync(dirname(this.path), {recursive:true,mode:0o700});
      const path = join(realpathSync(dirname(this.path)),basename(this.path));
      db = new Database(path,constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_NOFOLLOW);
      if (process.platform !== 'win32') chmodSync(path,0o600);
      db.run('PRAGMA busy_timeout=100');
      db.run('PRAGMA synchronous=FULL');
      db.run('PRAGMA cache_size=-256');
      const version = (db.query('PRAGMA user_version').get() as {user_version:number}).user_version;
      if (version > 7) throw new MemorySaveError('UNSUPPORTED_VERSION');
      if (version === 0) db.transaction(() => {
        db!.run(`CREATE TABLE save_sources (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, sourceKey TEXT NOT NULL UNIQUE,
          agent TEXT NOT NULL, instanceId TEXT NOT NULL, sessionId TEXT NOT NULL, turnId TEXT NOT NULL,
          startByte INTEGER NOT NULL, endByte INTEGER NOT NULL, memoryId TEXT NOT NULL,
          policyEpoch INTEGER NOT NULL, payload TEXT NOT NULL, saveId TEXT
        )`);
        db!.run('CREATE INDEX sources_overlap ON save_sources(agent,instanceId,sessionId,turnId,startByte,endByte)');
        db!.run('CREATE INDEX sources_pending ON save_sources(memoryId,policyEpoch,saveId,sequence)');
        db!.run(`CREATE TABLE save_jobs (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, saveId TEXT NOT NULL UNIQUE,
          memoryId TEXT NOT NULL, policyEpoch INTEGER NOT NULL, coverageDigest TEXT NOT NULL,
          phase TEXT NOT NULL, attemptId TEXT, intent TEXT, receipt TEXT
        )`);
        db!.run("CREATE UNIQUE INDEX jobs_open_root ON save_jobs(memoryId) WHERE phase <> 'local-saved'");
        db!.run('CREATE TABLE save_job_sources (saveId TEXT NOT NULL, sourceKey TEXT NOT NULL UNIQUE, PRIMARY KEY(saveId,sourceKey))');
        db!.run(`CREATE TABLE backup_outbox (saveId TEXT NOT NULL UNIQUE, memoryId TEXT NOT NULL,
          localRevisionId TEXT NOT NULL, destination TEXT NOT NULL, state TEXT NOT NULL,
          PRIMARY KEY(memoryId,localRevisionId,destination))`);
        db!.run('PRAGMA user_version=1');
      }).immediate();
      if (version < 2) db.transaction(() => {
        db!.run("ALTER TABLE save_sources ADD COLUMN coverageKind TEXT NOT NULL DEFAULT 'fragment'");
        db!.run("CREATE UNIQUE INDEX sources_complete_turn ON save_sources(agent,instanceId,sessionId,turnId) WHERE coverageKind='complete-turn'");
        db!.run('PRAGMA user_version=2');
      }).immediate();
      if(version<3)db.transaction(()=>{migrateAutomaticMemoryPolicy(db!);db!.run('PRAGMA user_version=3');}).immediate();
      if(version<4)db.transaction(()=>{db!.run('CREATE TABLE save_host_sessions (saveId TEXT PRIMARY KEY, sessionPlanId TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)');db!.run('PRAGMA user_version=4');}).immediate();
      if(version<5)db.transaction(()=>{
        db!.run('CREATE TABLE save_provider_binding (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL)');
        db!.run('CREATE TABLE save_input_bindings (sequence INTEGER PRIMARY KEY AUTOINCREMENT, saveId TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, expired INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL)');
        db!.run('CREATE INDEX inputs_expiry ON save_input_bindings(expired,sequence)');
        db!.run('ALTER TABLE backup_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
        db!.run('ALTER TABLE backup_outbox ADD COLUMN retryAt INTEGER NOT NULL DEFAULT 0');
        db!.run('CREATE INDEX backup_outbox_ready ON backup_outbox(state,retryAt)');
        db!.run('CREATE INDEX backup_memory_state ON backup_outbox(memoryId,state)');
        db!.run('CREATE INDEX jobs_memory_sequence ON save_jobs(memoryId,sequence)');
        db!.run('PRAGMA user_version=5');
      }).immediate();
      if(version<6)db.transaction(()=>{
        db!.run('DROP INDEX inputs_expiry');
        db!.run('CREATE INDEX inputs_expiry ON save_input_bindings(expired,createdAt,sequence)');
        db!.run('DROP INDEX backup_outbox_ready');
        db!.run('CREATE INDEX backup_outbox_ready ON backup_outbox(state,retryAt,saveId)');
        db!.run('PRAGMA user_version=6');
      }).immediate();
      if(version<7)db.transaction(()=>{
        // Older binaries must reject this database rather than ignore a project scope.
        const row=db!.query('SELECT payload FROM save_auto_policy WHERE singleton=1').get() as {payload:string};
        const policy=JSON.parse(row.payload);
        db!.query('UPDATE save_auto_policy SET payload=? WHERE singleton=1').run(JSON.stringify({...policy,scopeMemoryId:policy.scopeMemoryId??null,scopeTargetId:policy.scopeTargetId??null}));
        db!.run('PRAGMA user_version=7');
      }).immediate();
      return fn(db);
    } catch (error) {
      if (error instanceof MemorySaveError) throw error;
      throw new MemorySaveError('STORAGE_UNAVAILABLE');
    } finally { db?.close(); }
  }

  observe(raw: MemorySaveSource): string {
    return this.observeBatch([raw])[0]!;
  }

  /** One bounded transaction avoids opening/fsyncing the database for every observed turn. */
  observeBatch(raw: readonly MemorySaveSource[]): string[] {
    if (!Array.isArray(raw) || raw.length>MEMORY_SAVE_PAGE_LIMIT) throw new MemorySaveError('INVALID_INPUT');
    const sources=raw.map(canonicalSaveSource);
    if (!sources.length) return [];
    return this.#db(db => db.transaction(() => sources.map(source=>this.#observe(db,source))).immediate());
  }

  #observe(db:Database, source:MemorySaveSource): string {
    const sourceKey = memorySaveSourceKey(source);
    const payload = JSON.stringify(source);
      const existing = db.query('SELECT payload FROM save_sources WHERE sourceKey=?').get(sourceKey) as {payload:string}|null;
      if (existing) {
        if (JSON.stringify(canonicalSaveSource(JSON.parse(existing.payload))) !== payload) throw new MemorySaveError('SOURCE_CONFLICT');
        return sourceKey;
      }
      // Re-segmenting a previously observed range must not bypass its execution fence.
      if (db.query(`SELECT 1 FROM save_sources WHERE agent=? AND instanceId=? AND sessionId=? AND turnId=?
        AND (coverageKind='complete-turn' OR ?='complete-turn' OR (startByte < ? AND endByte > ?)) LIMIT 1`)
        .get(source.agent,source.instanceId,source.sessionId,source.turnId,source.coverageKind!,source.endByte,source.startByte)) {
        throw new MemorySaveError('SOURCE_CONFLICT');
      }
      db.query(`INSERT INTO save_sources(sourceKey,agent,instanceId,sessionId,turnId,startByte,endByte,memoryId,policyEpoch,payload,coverageKind)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(sourceKey,source.agent,source.instanceId,source.sessionId,source.turnId,source.startByte,source.endByte,source.memoryId,source.policyEpoch,payload,source.coverageKind!);
      return sourceKey;
  }

  pending(memoryId: string, policyEpoch: number, after = 0, limit = MEMORY_SAVE_PAGE_LIMIT) {
    if (!saveToken(memoryId) || !saveInteger(policyEpoch)) throw new MemorySaveError('INVALID_INPUT');
    this.#pageInput(after,limit);
    return this.#db(db => {
      const rows = db.query(`SELECT sequence,sourceKey FROM save_sources WHERE memoryId=? AND policyEpoch=?
        AND saveId IS NULL AND sequence>? ORDER BY sequence LIMIT ?`).all(memoryId,policyEpoch,after,limit+1) as {sequence:number;sourceKey:string}[];
      const items = rows.slice(0,limit);
      return {items,nextCursor:rows.length>limit ? items.at(-1)!.sequence : null};
    });
  }

  /** Bounded metadata scan, not a success watermark. The host revisits from the
   * consent boundary on later cycles; missing/oversized sources remain pending. */
  automaticPending(memoryId:string,policyEpoch:number,revision:number,after=0,limit=MEMORY_SAVE_PAGE_LIMIT) {
    if(!saveToken(memoryId)||!saveInteger(policyEpoch)||!saveInteger(revision))throw new MemorySaveError('INVALID_INPUT');
    this.#pageInput(after,limit);
    return this.#db(db=>{
      const boundary=automaticMemoryObservationBoundary(db,revision);
      const rows=db.query(`SELECT sequence,sourceKey,CASE WHEN length(payload)<=4096 THEN payload ELSE NULL END AS payload
        FROM save_sources WHERE memoryId=? AND policyEpoch=? AND saveId IS NULL AND sequence>?
        ORDER BY sequence LIMIT ?`).all(memoryId,policyEpoch,Math.max(after,boundary.afterSequence),limit+1) as {sequence:number;sourceKey:string;payload:string|null}[];
      const scanned=rows.slice(0,limit);
      const items=scanned.flatMap(row=>{
        if(!row.payload)throw new MemorySaveError('STORAGE_UNAVAILABLE');
        const source=canonicalSaveSource(JSON.parse(row.payload));
        if(source.memoryId!==memoryId||source.policyEpoch!==policyEpoch||memorySaveSourceKey(source)!==row.sourceKey)throw new MemorySaveError('SOURCE_CONFLICT');
        return source.coverageKind==='complete-turn'&&source.completedAt>boundary.enabledAt&&source.completedAt<=this.now()
          ? [{sequence:row.sequence,sourceKey:row.sourceKey,source}] : [];
      });
      return {items,nextCursor:rows.length>limit?scanned.at(-1)!.sequence:null};
    });
  }

  reserve(memoryId: string, policyEpoch: number, keys: readonly string[]): MemorySaveJob {
    if (!saveToken(memoryId) || !saveInteger(policyEpoch) || !Array.isArray(keys) || keys.length<1
      || keys.length>MEMORY_SAVE_PAGE_LIMIT || !keys.every(saveHash) || new Set(keys).size!==keys.length) throw new MemorySaveError('INVALID_INPUT');
    const sorted = [...keys].sort();
    return this.#db(db => db.transaction(() => {
      const rows = sorted.map(key => db.query('SELECT sourceKey,payload,saveId FROM save_sources WHERE sourceKey=?').get(key) as SourceRow|null);
      if (rows.some(row => !row)) throw new MemorySaveError('SOURCE_CONFLICT');
      const sources = rows.map(row => canonicalSaveSource(JSON.parse(row!.payload)));
      if (sources.some(source => source.memoryId !== memoryId || source.policyEpoch !== policyEpoch)) throw new MemorySaveError('SOURCE_CONFLICT');
      const coverageDigest = saveDigest(rows.map((row,index) => [row!.sourceKey,sources[index]!.sourceDigest]));
      const reserved = new Set(rows.flatMap(row => row!.saveId ? [row!.saveId] : []));
      if (reserved.size) {
        if (reserved.size!==1 || rows.some(row => !row!.saveId)) throw new MemorySaveError('COVERAGE_RESERVED');
        const existing = this.#job(db,[...reserved][0]!);
        if (existing.coverageDigest!==coverageDigest) throw new MemorySaveError('COVERAGE_RESERVED');
        return existing;
      }
      if (db.query("SELECT 1 FROM save_jobs WHERE memoryId=? AND phase<>'local-saved'").get(memoryId)) throw new MemorySaveError('COVERAGE_RESERVED');
      const saveId = randomUUID();
      db.query("INSERT INTO save_jobs(saveId,memoryId,policyEpoch,coverageDigest,phase) VALUES (?,?,?,?,'prepared')").run(saveId,memoryId,policyEpoch,coverageDigest);
      for (const key of sorted) {
        db.query('INSERT INTO save_job_sources VALUES (?,?)').run(saveId,key);
        if (db.query('UPDATE save_sources SET saveId=? WHERE sourceKey=? AND saveId IS NULL').run(saveId,key).changes!==1) throw new MemorySaveError('COVERAGE_RESERVED');
      }
      return this.#job(db,saveId);
    }).immediate());
  }

  get(saveId:string){if(!saveToken(saveId))throw new MemorySaveError('INVALID_INPUT');return this.#db(db=>this.#job(db,saveId));}
  openJob(memoryId:string):MemorySaveJob|null {
    if(!saveToken(memoryId))throw new MemorySaveError('INVALID_INPUT');
    return this.#db(db=>db.query(`SELECT ${jobProjection} FROM save_jobs WHERE memoryId=? AND phase<>'local-saved' LIMIT 1`).get(memoryId) as MemorySaveJob|null);
  }
  /** Read-only early admission. The actual attempt repeats this atomically. */
  checkAutomaticSources(memoryId:string,policyEpoch:number,keys:readonly string[],revision:number,providerBindingDigest:string):void {
    if(!saveToken(memoryId)||!saveInteger(policyEpoch)||!saveInteger(revision)||!saveHash(providerBindingDigest)
      ||!keys.length||keys.length>128||!keys.every(saveHash)||new Set(keys).size!==keys.length)throw new MemorySaveError('INVALID_INPUT');
    this.#db(db=>{
      const rows=keys.map(key=>db.query('SELECT sequence,payload,saveId FROM save_sources WHERE sourceKey=?').get(key) as {sequence:number;payload:string;saveId:string|null}|null);
      if(rows.some(row=>!row||row.saveId!==null))throw new MemorySaveError('COVERAGE_RESERVED');
      checkAutomaticMemoryAdmission(db,{memoryId,policyEpoch},revision,{providerBindingDigest},rows as {sequence:number;payload:string}[],this.now());
    });
  }
  hostBinding(saveId:string):MemorySaveHostBinding|null {
    if(!saveToken(saveId))throw new MemorySaveError('INVALID_INPUT');
    return this.#db(db=>{const row=db.query('SELECT payload FROM save_host_sessions WHERE saveId=?').get(saveId) as {payload:string}|null;return row?JSON.parse(row.payload):null;});
  }
  bindHostSession(saveId:string,attemptId:string,raw:MemorySaveHostBinding):void {
    this.#attemptInput(saveId,attemptId);
    if(!raw||!saveToken(raw.sessionPlanId)||![raw.planDigest,raw.rootDigest,raw.beforeHash,raw.afterHash].every(saveHash)||typeof raw.backupRequested!=='boolean')throw new MemorySaveError('INVALID_INPUT');
    const backup=raw.backup;
    if(backup&&(!raw.backupRequested||!saveToken(backup.memoryId)||backup.contentHash!==raw.afterHash||!saveHash(backup.destinationHash)
      ||(backup.parentRevisionId!==null&&!saveToken(backup.parentRevisionId))))throw new MemorySaveError('INVALID_INPUT');
    const payload=JSON.stringify({sessionPlanId:raw.sessionPlanId,planDigest:raw.planDigest,rootDigest:raw.rootDigest,beforeHash:raw.beforeHash,afterHash:raw.afterHash,backupRequested:raw.backupRequested,
      ...(backup?{backup:{memoryId:backup.memoryId,contentHash:backup.contentHash,destinationHash:backup.destinationHash,parentRevisionId:backup.parentRevisionId}}:{})});
    this.#db(db=>db.transaction(()=>{
      const job=this.#job(db,saveId);if(job.attemptId!==attemptId||backup&&backup.memoryId!==job.memoryId)throw new MemorySaveError('REVISION_CONFLICT');
      const prior=db.query('SELECT payload FROM save_host_sessions WHERE saveId=?').get(saveId) as {payload:string}|null;
      if(prior){if(prior.payload!==payload)throw new MemorySaveError('REVISION_CONFLICT');return;}
      if(!['summarizing','recovery-required'].includes(job.phase))throw new MemorySaveError('RECOVERY_REQUIRED');
      const row=db.query('SELECT intent FROM save_jobs WHERE saveId=?').get(saveId) as {intent:string|null};
      if(!row.intent||JSON.parse(row.intent).beforeHash!==raw.beforeHash)throw new MemorySaveError('REVISION_CONFLICT');
      db.query('INSERT INTO save_host_sessions VALUES (?,?,?)').run(saveId,raw.sessionPlanId,payload);
    }).immediate());
  }

  automaticPolicy(){return this.#db(db=>readAutomaticMemoryPolicy(db));}
  providerBinding():MemoryProviderBinding|null {
    return this.#db(db=>{const row=db.query('SELECT CASE WHEN length(payload)<=4096 THEN payload ELSE NULL END AS payload FROM save_provider_binding WHERE singleton=1').get() as {payload:string|null}|null;
      if(!row)return null;if(!row.payload)throw new MemorySaveError('STORAGE_UNAVAILABLE');return canonicalMemoryProviderBinding(JSON.parse(row.payload));});
  }
  setProviderBinding(raw:MemoryProviderBinding):void {
    const payload=JSON.stringify(canonicalMemoryProviderBinding(raw));
    this.#db(db=>db.transaction(()=>{
      if(readAutomaticMemoryPolicy(db).enabled)throw new MemorySaveError('POLICY_CHANGED');
      db.query('INSERT INTO save_provider_binding VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload').run(payload);
    }).immediate());
  }
  bindInput(saveId:string,raw:MemoryInputBinding):void {
    if(!raw||raw.saveId!==saveId||![raw.inputDigest,raw.beforeHash,raw.providerBindingDigest,raw.coverageDigest].every(saveHash))throw new MemorySaveError('INVALID_INPUT');
    const b={saveId:raw.saveId,memoryId:raw.memoryId,policyEpoch:raw.policyEpoch,coverageDigest:raw.coverageDigest,inputDigest:raw.inputDigest,beforeHash:raw.beforeHash,providerBindingDigest:raw.providerBindingDigest};
    this.#db(db=>db.transaction(()=>{
      const job=this.#job(db,saveId);if(job.memoryId!==b.memoryId||job.policyEpoch!==b.policyEpoch||job.coverageDigest!==b.coverageDigest)throw new MemorySaveError('SOURCE_CONFLICT');
      const payload=JSON.stringify(b),prior=db.query('SELECT payload FROM save_input_bindings WHERE saveId=?').get(saveId) as {payload:string}|null;
      if(prior){if(prior.payload!==payload)throw new MemorySaveError('REVISION_CONFLICT');return;}
      if(job.phase!=='prepared')throw new MemorySaveError('RECOVERY_REQUIRED');
      db.query('INSERT INTO save_input_bindings(saveId,payload,createdAt) VALUES (?,?,?)').run(saveId,payload,this.now());
    }).immediate());
  }
  inputBinding(saveId:string):MemoryInputBinding|null {
    if(!saveToken(saveId))throw new MemorySaveError('INVALID_INPUT');
    return this.#db(db=>{const row=db.query('SELECT CASE WHEN length(payload)<=4096 THEN payload ELSE NULL END AS payload FROM save_input_bindings WHERE saveId=?').get(saveId) as {payload:string|null}|null;
      if(!row)return null;if(!row.payload)throw new MemorySaveError('STORAGE_UNAVAILABLE');const b=JSON.parse(row.payload) as MemoryInputBinding;
      const job=this.#job(db,saveId);if(b.saveId!==saveId||b.memoryId!==job.memoryId||b.policyEpoch!==job.policyEpoch||b.coverageDigest!==job.coverageDigest||![b.inputDigest,b.beforeHash,b.providerBindingDigest].every(saveHash))throw new MemorySaveError('SOURCE_CONFLICT');
      return b;});
  }
  expiryPage(after:MemoryInputExpiryCursor|null=null){
    if(after!==null&&(!saveInteger(after?.createdAt)||!saveInteger(after?.sequence)))throw new MemorySaveError('INVALID_INPUT');
    const now=this.now();if(!saveInteger(now))throw new MemorySaveError('INVALID_INPUT');
    return this.#db(db=>{
      // The deadline index skips all recent inputs. The advisory tuple resumes
      // past failed rows too, so they cannot starve the remaining expiry work.
      const cutoff=now-MEMORY_INPUT_TTL;
      // SQLite can scan every earlier tie for a (createdAt, rowid) tuple range.
      // Seek the equal timestamp by sequence first, then at most the remaining
      // nine rows at later timestamps. Both seeks use the same deadline index.
      const rows=(after&&after.createdAt<=cutoff
        ?db.query(MEMORY_INPUT_EXPIRY_TIE_SQL).all(after.createdAt,after.sequence):[]) as {sequence:number;saveId:string;createdAt:number}[];
      if(rows.length<9)rows.push(...db.query(MEMORY_INPUT_EXPIRY_PAGE_SQL)
        .all(after?.createdAt??-1,cutoff,9-rows.length) as typeof rows);
      const items=rows.slice(0,8),last=items.at(-1);
      return {items,nextCursor:rows.length>8&&last?{createdAt:last.createdAt,sequence:last.sequence}:null};
    });
  }
  markInputExpired(saveId:string){
    if(!saveToken(saveId))throw new MemorySaveError('INVALID_INPUT');
    this.#db(db=>{db.query('UPDATE save_input_bindings SET expired=1 WHERE saveId=?').run(saveId);});
  }
  setAutomaticPolicy(expectedRevision:number,input:AutomaticMemoryPolicyInput){
    return this.#db(db=>db.transaction(()=>changeAutomaticMemoryPolicy(db,expectedRevision,input,this.now())).immediate());
  }
  beginAutomaticAttempt(saveId:string,expectedCoverage:string,expectedPolicyRevision:number,intent:MemorySaveAttemptIntent):string {
    if(!saveInteger(expectedPolicyRevision))throw new MemorySaveError('INVALID_INPUT');
    return this.#beginAttempt(saveId,expectedCoverage,intent,expectedPolicyRevision);
  }

  /** Returns a new attempt only once. Even the same caller must not spawn again on retry. */
  beginAttempt(saveId: string, expectedCoverage: string, raw: MemorySaveAttemptIntent): string {
    return this.#beginAttempt(saveId,expectedCoverage,raw);
  }
  #beginAttempt(saveId: string, expectedCoverage: string, raw: MemorySaveAttemptIntent,automaticRevision?:number): string {
    if (!saveToken(saveId) || !saveHash(expectedCoverage) || !raw
      || ![raw.inputDigest,raw.beforeHash,raw.providerBindingDigest].every(saveHash)) throw new MemorySaveError('INVALID_INPUT');
    const intent = JSON.stringify({inputDigest:raw.inputDigest,beforeHash:raw.beforeHash,providerBindingDigest:raw.providerBindingDigest});
    return this.#db(db => db.transaction(() => {
      const job = this.#job(db,saveId);
      if (job.coverageDigest!==expectedCoverage) throw new MemorySaveError('REVISION_CONFLICT');
      if (job.phase!=='prepared') throw new MemorySaveError('RECOVERY_REQUIRED');
      const attemptId = randomUUID();
      if(automaticRevision===undefined)assertLegacyAttemptAllowed(db,job.memoryId);
      else reserveAutomaticMemoryAdmission(db,job,automaticRevision,raw,attemptId,this.now());
      if (db.query("UPDATE save_jobs SET phase='summarizing',attemptId=?,intent=? WHERE saveId=? AND phase='prepared'").run(attemptId,intent,saveId).changes!==1) throw new MemorySaveError('RECOVERY_REQUIRED');
      return attemptId;
    }).immediate());
  }

  requireRecovery(saveId: string, attemptId: string): void {
    this.#attemptInput(saveId,attemptId);
    this.#db(db => {
      if (db.query("UPDATE save_jobs SET phase='recovery-required' WHERE saveId=? AND attemptId=? AND phase IN ('summarizing','recovery-required')").run(saveId,attemptId).changes!==1) throw new MemorySaveError('REVISION_CONFLICT');
    });
  }

  /** Host-verified file application receipt + backup intent commit in one transaction.
   * No Markdown write or remote success is inferred from these metadata alone. */
  commitLocal(saveId: string, attemptId: string, raw: MemorySaveCommitReceipt, backupRequested: boolean): void {
    this.#attemptInput(saveId,attemptId);
    if (!raw || ![raw.manifestDigest,raw.beforeHash,raw.afterHash].every(saveHash)
      || !saveToken(raw.localRevisionId) || typeof backupRequested!=='boolean') throw new MemorySaveError('INVALID_INPUT');
    const receipt = JSON.stringify({manifestDigest:raw.manifestDigest,beforeHash:raw.beforeHash,afterHash:raw.afterHash,localRevisionId:raw.localRevisionId,backupRequested});
    this.#db(db => db.transaction(() => {
      const job = this.#job(db,saveId);
      const bindingRow=db.query('SELECT payload FROM save_host_sessions WHERE saveId=?').get(saveId) as {payload:string}|null;
      if(bindingRow){const b=JSON.parse(bindingRow.payload) as MemorySaveHostBinding;
        if(b.planDigest!==raw.manifestDigest||b.beforeHash!==raw.beforeHash||b.afterHash!==raw.afterHash||b.sessionPlanId!==raw.localRevisionId||b.backupRequested!==backupRequested)throw new MemorySaveError('REVISION_CONFLICT');}
      const prior = db.query('SELECT receipt,intent FROM save_jobs WHERE saveId=?').get(saveId) as {receipt:string|null;intent:string|null};
      if (job.attemptId!==attemptId) throw new MemorySaveError('REVISION_CONFLICT');
      if (!prior.intent || JSON.parse(prior.intent).beforeHash !== raw.beforeHash) throw new MemorySaveError('REVISION_CONFLICT');
      if (job.phase==='local-saved') {
        if (prior.receipt!==receipt) throw new MemorySaveError('REVISION_CONFLICT');
        return;
      }
      if (!['summarizing','recovery-required'].includes(job.phase)) throw new MemorySaveError('REVISION_CONFLICT');
      db.query("UPDATE save_jobs SET phase='local-saved',receipt=? WHERE saveId=?").run(receipt,saveId);
      if (backupRequested) db.query("INSERT INTO backup_outbox(saveId,memoryId,localRevisionId,destination,state) VALUES (?,?,?,'supabase','pending')").run(saveId,job.memoryId,raw.localRevisionId);
    }).immediate());
  }

  page(after = 0, limit = MEMORY_SAVE_PAGE_LIMIT) {
    this.#pageInput(after,limit);
    return this.#db(db => {
      const rows = db.query(`SELECT ${jobProjection} FROM save_jobs WHERE sequence>? ORDER BY sequence LIMIT ?`).all(after,limit+1) as MemorySaveJob[];
      const items = rows.slice(0,limit);
      return {items,nextCursor:rows.length>limit ? items.at(-1)!.sequence : null};
    });
  }

  /** Reserve a bounded backup-only try before transport. A crash retries only
   * the same immutable guard; it never re-enters model execution. */
  nextBackup(){return this.#db(db=>db.transaction(()=>{
    const row=db.query("SELECT saveId,memoryId,localRevisionId,attempts FROM backup_outbox WHERE state='pending' AND retryAt<=? ORDER BY retryAt,saveId LIMIT 1").get(this.now()) as {saveId:string;memoryId:string;localRevisionId:string;attempts:number}|null;
    if(!row)return null;
    if(!saveInteger(row.attempts)||row.attempts>=20){db.query("UPDATE backup_outbox SET state='blocked' WHERE saveId=?").run(row.saveId);return null;}
    db.query('UPDATE backup_outbox SET attempts=attempts+1,retryAt=? WHERE saveId=? AND attempts=?')
      .run(this.now()+Math.min(3600_000,30_000*2**row.attempts),row.saveId,row.attempts);
    return {...row,attempts:row.attempts+1};
  }).immediate());}
  finishBackup(saveId:string,attempt:number,state:'complete'|'blocked'){
    if(!saveToken(saveId)||!saveInteger(attempt)||!['complete','blocked'].includes(state))throw new MemorySaveError('INVALID_INPUT');
    this.#db(db=>{db.query("UPDATE backup_outbox SET state=? WHERE saveId=? AND attempts=? AND state='pending'").run(state,saveId,attempt);});
  }
  backupSummary(memoryId:string){
    if(!saveToken(memoryId))throw new MemorySaveError('INVALID_INPUT');
    return this.#db(db=>{
      const rows=db.query("SELECT state FROM backup_outbox WHERE memoryId=? AND state IN ('pending','blocked') LIMIT 129").all(memoryId) as {state:string}[];
      return {pending:rows.slice(0,128).filter(r=>r.state==='pending').length,blocked:rows.slice(0,128).filter(r=>r.state==='blocked').length,hasMore:rows.length>128};
    });
  }
  latestJob(memoryId:string):MemorySaveJob|null {
    if(!saveToken(memoryId))throw new MemorySaveError('INVALID_INPUT');
    return this.#db(db=>db.query(`SELECT ${jobProjection} FROM save_jobs WHERE memoryId=? ORDER BY sequence DESC LIMIT 1`).get(memoryId) as MemorySaveJob|null);
  }
  #job(db: Database, saveId: string): MemorySaveJob {
    const row = db.query(`SELECT ${jobProjection} FROM save_jobs WHERE saveId=?`).get(saveId) as MemorySaveJob|null;
    if (!row) throw new MemorySaveError('REVISION_CONFLICT');
    return row;
  }
  #attemptInput(saveId: string, attemptId: string) {
    if (![saveId,attemptId].every(saveToken)) throw new MemorySaveError('INVALID_INPUT');
  }
  #pageInput(after: number, limit: number) {
    if (!saveInteger(after) || !Number.isSafeInteger(limit) || limit<1 || limit>MEMORY_SAVE_PAGE_LIMIT) throw new MemorySaveError('INVALID_INPUT');
  }
}
