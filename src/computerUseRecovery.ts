import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {chmodSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {parseComputerUseScope,type ComputerUseScope} from './computerUseScopeProtocol';

export interface ComputerUseRecoveryEntry {
  bundleId: string; windowId: number; operation: 'press' | 'set-value' | 'click'; requestId: string; sessionId: string; lane: string;
}
export interface ComputerUseRecoveryRecord extends ComputerUseRecoveryEntry {
  id: string; state: 'unknown' | 'reviewed'; createdAt: number; reviewedAt: number | null;
}
/** What the host needs from the ledger. `exclude`: rows the calling host itself has in flight (see `begin`). */
export interface ComputerUseRecoveryStore {
  begin(entry: ComputerUseRecoveryEntry, exclude?: Iterable<string>): string;
  settle(id: string): void;
  unresolved(bundleId: string): ComputerUseRecoveryRecord[];
  blockedByScope?(bundleId:string):boolean;
}
export type ScopedRecoveryOperation='scope-click'|'scope-type-text'|'scope-key'|'scope-scroll'|'scope-drag'|'scope-focus-app';
export interface ScopedRecoveryEntry {scope:ComputerUseScope;operation:ScopedRecoveryOperation;requestId:string;sessionId:string;lane:string}
export interface ScopedRecoveryRecord {id:string;scopeKind:'desktop'|'application';bundleId:string|null;operation:ScopedRecoveryOperation;requestId:string;sessionId:string;lane:string;state:'unknown'|'reviewed';createdAt:number;reviewedAt:number|null}
export const COMPUTER_USE_RECOVERY_LIMITS = {rows: 128, reviewedRetentionMs: 30 * 86_400_000} as const;
const L = COMPUTER_USE_RECOVERY_LIMITS;
const token = (v: unknown, max: number) => typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_.-]+$/.test(v);
const COLUMNS = 'id,bundleId,windowId,operation,requestId,sessionId,lane,state,createdAt,reviewedAt';
/**
 * Durable ledger of native actions whose result nobody knows. A row is written `unknown` (FULL sync) before the
 * action is sent and deleted once the worker answers definitely, so only a lost answer, a crash or a restart leaves
 * one. While any unknown row names an app, nobody gets a new grant for it or sends it another action until a person
 * reviews the row. Local metadata only: no typed values, labels, element text, window titles, secrets or approvals.
 * Reviewed rows stay 30 days as the person's history. Unknown rows never expire by themselves: a full ledger refuses
 * new actions instead of evicting them.
 */
export class ComputerUseRecovery implements ComputerUseRecoveryStore {
  private db: Database;
  constructor(path: string, private readonly options: {now?: () => number} = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.db = new Database(path, {create: true});
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;`);
    try { this.db.transaction(() => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS computer_use_actions(id TEXT PRIMARY KEY, bundleId TEXT NOT NULL, windowId INTEGER NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('press','set-value','click')), requestId TEXT NOT NULL, sessionId TEXT NOT NULL,
        lane TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('unknown','reviewed')), createdAt INTEGER NOT NULL, reviewedAt INTEGER);`);
      const table = this.db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='computer_use_actions'").get() as {sql: string};
      const legacy = /CHECK\s*\(\s*operation\s+IN\s*\(\s*'press'\s*,\s*'set-value'\s*\)\s*\)/i;
      const current = /CHECK\s*\(\s*operation\s+IN\s*\(\s*'press'\s*,\s*'set-value'\s*,\s*'click'\s*\)\s*\)/i;
      if (legacy.test(table.sql)) {
        const columns = this.db.query('PRAGMA table_info(computer_use_actions)').all() as {name:string}[];
        const expected = COLUMNS.split(',');
        if (columns.length !== expected.length || columns.some((column, i) => column.name !== expected[i])) {
          throw Error('알 수 없는 복구 기록 열이 있어 안전하게 갱신할 수 없습니다.');
        }
        const renamed = table.sql.replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?computer_use_actions["`\]]?/i,
          'CREATE TABLE computer_use_actions_migrating').replace(legacy, "CHECK(operation IN ('press','set-value','click'))");
        if (renamed === table.sql || !renamed.startsWith('CREATE TABLE computer_use_actions_migrating')) throw Error('복구 기록 스키마를 안전하게 갱신할 수 없습니다.');
        const dependent = this.db.query("SELECT sql FROM sqlite_master WHERE tbl_name='computer_use_actions' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name").all() as {sql:string}[];
        this.db.exec(renamed);
        this.db.exec(`INSERT INTO computer_use_actions_migrating(${COLUMNS}) SELECT ${COLUMNS} FROM computer_use_actions;
          DROP TABLE computer_use_actions; ALTER TABLE computer_use_actions_migrating RENAME TO computer_use_actions;`);
        for (const row of dependent) this.db.exec(row.sql);
      } else if (!current.test(table.sql)) throw Error('알 수 없는 복구 기록 스키마입니다.');
      this.db.exec('CREATE INDEX IF NOT EXISTS computer_use_actions_app ON computer_use_actions(bundleId, state)');
      this.db.exec(`CREATE TABLE IF NOT EXISTS computer_use_scope_actions(id TEXT PRIMARY KEY,scopeKind TEXT NOT NULL CHECK(scopeKind IN ('desktop','application')),bundleId TEXT,
        operation TEXT NOT NULL CHECK(operation IN ('scope-click','scope-type-text','scope-key','scope-scroll','scope-drag','scope-focus-app')),
        requestId TEXT NOT NULL,sessionId TEXT NOT NULL,lane TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('unknown','reviewed')),createdAt INTEGER NOT NULL,reviewedAt INTEGER,
        CHECK((scopeKind='desktop' AND bundleId IS NULL) OR (scopeKind='application' AND bundleId IS NOT NULL)));
        CREATE INDEX IF NOT EXISTS computer_use_scope_actions_overlap ON computer_use_scope_actions(scopeKind,bundleId,state);`);
      const scopeColumns=this.db.query('PRAGMA table_info(computer_use_scope_actions)').all() as {name:string}[];
      const expectedScope=['id','scopeKind','bundleId','operation','requestId','sessionId','lane','state','createdAt','reviewedAt'];
      if(scopeColumns.length!==expectedScope.length||scopeColumns.some((column,index)=>column.name!==expectedScope[index]))throw Error('알 수 없는 범위 복구 기록 열이 있어 안전하게 열 수 없습니다.');
    }).immediate(); } catch (error) { this.db.close(); throw error; }
  }
  private now() {return (this.options.now ?? Date.now)();}
  private count() {return (this.db.query('SELECT COUNT(*) AS n FROM computer_use_actions').get() as {n: number}).n;}
  /**
   * Records an action as unknown before it is sent. Throws, and nothing may be sent, when it cannot.
   *
   * Admission is atomic per app: the check for another unknown row of the same app and the insert run in one
   * `BEGIN IMMEDIATE` writer transaction, so two hosts (or processes) sharing this ledger that both pre-checked an
   * empty app cannot both admit an action for it. The refusal carries `code: 'unresolved'`. Apps stay independent.
   * `exclude` lists only rows the calling host is itself sending right now (it serializes its own work per process);
   * another host cannot tell such a row from an abandoned one and is refused.
   */
  begin(entry: ComputerUseRecoveryEntry, exclude: Iterable<string> = []): string {
    if (!token(entry?.bundleId, 200) || !Number.isSafeInteger(entry.windowId) || entry.windowId <= 0
      || !['press', 'set-value', 'click'].includes(entry.operation) || !token(entry.requestId, 128)
      || !token(entry.sessionId, 160) || !token(entry.lane, 64)) throw Error('복구 기록 항목이 올바르지 않습니다.');
    const own = [...exclude];
    if (own.length > 64 || own.some(v => typeof v !== 'string' || !/^[a-f0-9-]{36}$/.test(v))) throw Error('복구 기록 항목이 올바르지 않습니다.');
    const id = randomUUID(), now = this.now(), bundle = entry.bundleId.toLowerCase();
    this.db.transaction(() => {
      this.db.query(`DELETE FROM computer_use_actions WHERE state='reviewed' AND reviewedAt<=?`).run(now - L.reviewedRetentionMs);
      const open = (this.db.query(`SELECT COUNT(*) AS n FROM computer_use_actions WHERE bundleId=? AND state='unknown'
        ${own.length ? `AND id NOT IN (${own.map(() => '?').join(',')})` : ''}`).get(bundle, ...own) as {n: number}).n;
      if (open > 0 || this.blockedByScope(bundle)) throw Object.assign(Error('이 앱에 결과를 모르는 작업이 이미 있어 기록하지 않았습니다.'), {code: 'unresolved'});
      const excess = this.count() - L.rows + 1;
      if (excess > 0) this.db.query(`DELETE FROM computer_use_actions WHERE id IN (SELECT id FROM computer_use_actions
        WHERE state='reviewed' ORDER BY reviewedAt LIMIT ?)`).run(excess);
      if (this.count() >= L.rows) throw Error('결과를 확인하지 못한 컴퓨터 제어 작업이 너무 많습니다. 사람이 먼저 확인해야 합니다.');
      this.db.query(`INSERT INTO computer_use_actions(${COLUMNS}) VALUES(?,?,?,?,?,?,?,'unknown',?,NULL)`)
        .run(id, bundle, entry.windowId, entry.operation, entry.requestId, entry.sessionId, entry.lane, now);
    }).immediate();
    return id;
  }
  /** The worker answered definitely (done, refused or delivered): nothing is left to review. */
  settle(id: string) {this.db.query(`DELETE FROM computer_use_actions WHERE id=? AND state='unknown'`).run(id);}
  unresolved(bundleId: string): ComputerUseRecoveryRecord[] {
    return this.db.query(`SELECT ${COLUMNS} FROM computer_use_actions WHERE bundleId=? AND state='unknown' ORDER BY createdAt LIMIT 32`)
      .all(String(bundleId).toLowerCase()) as ComputerUseRecoveryRecord[];
  }
  /** A broad unknown action blocks a legacy action for every overlapping app, including after restart. */
  blockedByScope(bundleId:string):boolean {
    return !!this.db.query("SELECT 1 FROM computer_use_scope_actions WHERE state='unknown' AND (scopeKind='desktop' OR bundleId=?) LIMIT 1").get(String(bundleId).toLowerCase());
  }
  /** Whether an earlier unknown v1 or v2 action overlaps this requested scope. */
  unresolvedScope(value:ComputerUseScope):boolean {
    const scope=parseComputerUseScope(value),desktop=scope.kind==='desktop',bundle=desktop?'':scope.application.bundleId.toLowerCase();
    const legacy=desktop?this.db.query("SELECT 1 FROM computer_use_actions WHERE state='unknown' LIMIT 1").get():this.db.query("SELECT 1 FROM computer_use_actions WHERE state='unknown' AND bundleId=? LIMIT 1").get(bundle);
    if(legacy)return true;
    return !!(desktop?this.db.query("SELECT 1 FROM computer_use_scope_actions WHERE state='unknown' LIMIT 1").get():this.db.query("SELECT 1 FROM computer_use_scope_actions WHERE state='unknown' AND (scopeKind='desktop' OR bundleId=?) LIMIT 1").get(bundle));
  }
  /** One immediate transaction checks both v1 and v2 ledgers before recording the scoped dispatch. */
  beginScope(entry:ScopedRecoveryEntry):string {
    const scope=parseComputerUseScope(entry?.scope);
    if(!['scope-click','scope-type-text','scope-key','scope-scroll','scope-drag','scope-focus-app'].includes(entry.operation)||!token(entry.requestId,128)||!token(entry.sessionId,160)||!token(entry.lane,64))throw Error('복구 기록 항목이 올바르지 않습니다.');
    const id=randomUUID(),now=this.now(),bundle=scope.kind==='application'?scope.application.bundleId.toLowerCase():null;
    this.db.transaction(()=>{
      this.db.query("DELETE FROM computer_use_scope_actions WHERE state='reviewed' AND reviewedAt<=?").run(now-L.reviewedRetentionMs);
      if(this.unresolvedScope(scope))throw Object.assign(Error('이 범위에 결과를 모르는 작업이 이미 있습니다.'),{code:'unresolved'});
      const count=()=>Number((this.db.query('SELECT COUNT(*) AS n FROM computer_use_scope_actions').get() as {n:number}).n);
      const excess=count()-L.rows+1;if(excess>0)this.db.query("DELETE FROM computer_use_scope_actions WHERE id IN (SELECT id FROM computer_use_scope_actions WHERE state='reviewed' ORDER BY reviewedAt LIMIT ?)").run(excess);
      if(count()>=L.rows)throw Error('결과를 확인하지 못한 컴퓨터 제어 작업이 너무 많습니다.');
      this.db.query("INSERT INTO computer_use_scope_actions(id,scopeKind,bundleId,operation,requestId,sessionId,lane,state,createdAt,reviewedAt) VALUES(?,?,?,?,?,?,?,'unknown',?,NULL)")
        .run(id,scope.kind,bundle,entry.operation,entry.requestId,entry.sessionId,entry.lane,now);
    }).immediate();return id;
  }
  settleScope(id:string){this.db.query("DELETE FROM computer_use_scope_actions WHERE id=? AND state='unknown'").run(id);}
  pendingScope():ScopedRecoveryRecord[]{return this.db.query(`SELECT id,scopeKind,bundleId,operation,requestId,sessionId,lane,state,createdAt,reviewedAt FROM computer_use_scope_actions WHERE state='unknown' ORDER BY createdAt LIMIT ${L.rows}`).all() as ScopedRecoveryRecord[];}
  reviewScope(id:string){return this.db.query("UPDATE computer_use_scope_actions SET state='reviewed',reviewedAt=? WHERE id=? AND state='unknown'").run(this.now(),id).changes===1;}
  /** For the person's review screen: every action whose result is unknown, oldest first. */
  pending(): ComputerUseRecoveryRecord[] {
    return this.db.query(`SELECT ${COLUMNS} FROM computer_use_actions WHERE state='unknown' ORDER BY createdAt LIMIT ${L.rows}`).all() as ComputerUseRecoveryRecord[];
  }
  /** A person checked the app and accepts its current state. Only a human-facing management path may call this. */
  review(id: string) {
    return this.db.query(`UPDATE computer_use_actions SET state='reviewed', reviewedAt=? WHERE id=? AND state='unknown'`)
      .run(this.now(), id).changes === 1;
  }
  close() {this.db.close();}
}
