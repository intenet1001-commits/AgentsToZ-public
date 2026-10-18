import { Database } from 'bun:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { normalizeWorkroomConversation, WORKROOM_HISTORY_PAGE_SIZE, type WorkroomConversation } from './workroomConversationProtocol';
import type { WorkroomSessionContext } from './workroomConversationHost';
import type {StoredSubmission} from './workroomSubmissions';
import type {CorrectionTaskExposure} from './projectMemoryCorrectionContext';

export interface StoredWorkroomConversation extends WorkroomConversation {
  bootId: string;
  targetFingerprint: string;
  accountFingerprint: string;
  providerConversationId: string | null;
  exitedAt: string | null;
  restricted: boolean;
  pendingResumeId: string | null;
}
export interface WorkroomResumeReceipt {
  requestId: string;
  conversationId: string;
  digest: string;
  state: 'prepared' | 'completed' | 'unknown' | 'rejected';
  sessionId: string | null;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** A boot (one sidecar process) is alive while it has not closed, its pid answers and it was seen within this window. */
export const WORKROOM_BOOT_STALE_MS = 150_000;
/** An offer covers sessions last alive within this window and expires after it. */
export const WORKROOM_RESTART_OFFER_TTL_MS = 72 * 3600_000;
export const WORKROOM_RESTART_OFFER_MAX_ROWS = 64;
/** Rows a single open or list converts from `running` to `detached`; the rest follow on the next check. */
export const WORKROOM_DETACH_BATCH = 512;
export type WorkroomBindingCheck = 'none' | 'ambiguous' | 'legacy';
/** The refusal of a resume whose provider conversation another row already holds (running or being opened). */
export const WORKROOM_PROVIDER_BUSY = '같은 대화가 다른 작업 세션에서 열려 있거나 여는 중입니다. 작업 세션 목록을 먼저 확인하세요.';
export interface WorkroomJournalOptions {
  /** This build (build-number.json); a previous boot with another build makes the offer an update. */
  build?: string;
  pid?: number;
  /** Whether a process still answers (default: `process.kill(pid, 0)`). Injectable for tests. */
  alive?: (pid: number) => boolean;
}
export interface WorkroomRestartOfferRecord {
  offerId: string; bootId: string; createdAt: string; revision: number;
  state: 'open' | 'dismissed' | 'done' | 'superseded' | 'expired';
  conversationIds: string[]; more: boolean; update: boolean;
}
export interface WorkroomBootRecord { bootId: string; pid: number; build: string; openedAt: string; lastSeenAt: string; closedAt: string | null }
export function workroomProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; }
}
// Side tables of w14 (resume after an update). Created when missing, with no workroom_meta version bump and no new
// key in a conversation body: an older app after a rollback still opens this file and ignores them.
const RESTART_TABLES = `
  CREATE TABLE IF NOT EXISTS workroom_boots(boot_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, build TEXT NOT NULL,
    opened_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, closed_at TEXT);
  CREATE TABLE IF NOT EXISTS workroom_restart_offers(offer_id TEXT PRIMARY KEY, boot_id TEXT NOT NULL, created_at TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0), state TEXT NOT NULL CHECK(state IN ('open','dismissed','done','superseded','expired')),
    conversation_ids TEXT NOT NULL, more INTEGER NOT NULL CHECK(more IN (0,1)), update_flag INTEGER NOT NULL CHECK(update_flag IN (0,1)), dismiss_request TEXT);
  CREATE INDEX IF NOT EXISTS workroom_restart_offer_state ON workroom_restart_offers(state,created_at);
  CREATE TABLE IF NOT EXISTS workroom_session_facts(session_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, bypass INTEGER NOT NULL CHECK(bypass IN (0,1)));
  CREATE TABLE IF NOT EXISTS workroom_binding_checks(conversation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('none','ambiguous','unsaved','legacy')), checked_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS workroom_session_inputs(session_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
    had_input INTEGER NOT NULL CHECK(had_input IN (0,1)));
`;
/** Old-boot 'prepared' submissions older than this (or with no preparedAt) are aged into 'rejected' when the journal opens. */
export const WORKROOM_SUBMISSION_PREPARED_AGE_MS = 7 * 24 * 3600_000;
/** How far back `recentSubmissions` looks: an unsettled receipt older than this is no longer offered for recovery. */
export const WORKROOM_SUBMISSION_RECENT_WINDOW_MS = 24 * 3600_000;
/** Rows that still answer for a request (every state but 'rejected'); a new submission is refused at this many. */
export const WORKROOM_SUBMISSION_OPEN_LIMIT = 20_000;
/** Every row, rejected included: rejected rows stay as dedupe records, so the table needs its own ceiling. */
export const WORKROOM_SUBMISSION_TOTAL_LIMIT = 40_000;
const WORKROOM_SUBMISSION_AGING_BATCH = 5_000;
const stamp = (path: string, directory: boolean, privateRoot = false) => {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)
    || process.platform !== 'win32' && (s.uid !== process.getuid?.() || (s.mode & (directory && !privateRoot ? 0o022 : 0o077)) !== 0)) throw new Error('대화 기록 저장소의 접근 권한을 확인하세요.');
  return `${s.dev}:${s.ino}`;
};
export function publicWorkroomConversation(r: StoredWorkroomConversation): WorkroomConversation {
  const { id, targetId, agent, accountId, accountLabel, title, createdAt, updatedAt, revision, archived, state, sessionId, binding } = r;
  return normalizeWorkroomConversation({ id, targetId, agent, accountId, accountLabel, title, createdAt, updatedAt, revision, archived, state, sessionId, binding });
}
/** Host metadata only. No transcript, prompt, credential, environment or absolute path. */
export class WorkroomConversationJournal {
  readonly storeInstanceId: string;
  readonly bootId: string;
  readonly #db: Database;
  readonly #path: string;
  readonly #root: string;
  readonly #parent: string;
  readonly #identity: string;
  readonly #rootIdentity: string;
  readonly #parentIdentity: string;
  readonly #build: string;
  readonly #alive: (pid: number) => boolean;
  #closed = false;
  constructor(appDataDir: string, private readonly now = () => new Date().toISOString(), bootId: string = randomUUID(), options: WorkroomJournalOptions = {}) {
    if (!isAbsolute(appDataDir)) throw new Error('대화 기록 저장 위치를 확인하세요.');
    stamp(appDataDir, true);
    this.#parent = realpathSync(appDataDir);
    this.#parentIdentity = stamp(this.#parent, true);
    this.#root = join(this.#parent, 'workroom-history-v1');
    try { lstatSync(this.#root); } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      mkdirSync(this.#root, { mode: 0o700 });
    }
    this.#rootIdentity = stamp(this.#root, true, true);
    this.#path = join(this.#root, 'history.sqlite');
    let fresh = false;
    try { lstatSync(this.#path); } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      const fd = openSync(this.#path, 'wx', 0o600); closeSync(fd); fresh = true;
    }
    this.#identity = stamp(this.#path, false);
    this.#db = new Database(this.#path, { create: false, strict: true });
    this.bootId = bootId;
    this.#build = typeof options.build === 'string' ? options.build.slice(0, 40) : '';
    this.#alive = options.alive ?? workroomProcessAlive;
    try {
      this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=100; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-2048;');
      if (fresh) this.#db.exec(`
        CREATE TABLE workroom_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, instance_id TEXT NOT NULL);
        CREATE TABLE workroom_conversations(
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
          archived INTEGER NOT NULL CHECK(archived IN (0,1)), revision INTEGER NOT NULL CHECK(revision>0),
          boot_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX workroom_list ON workroom_conversations(archived,created_at DESC,id DESC);
        CREATE INDEX workroom_boot ON workroom_conversations(state,boot_id);
        CREATE TABLE workroom_segments(
          session_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES workroom_conversations(id),
          boot_id TEXT NOT NULL, created_at TEXT NOT NULL, ended_at TEXT, state TEXT NOT NULL);
        CREATE INDEX workroom_segment_boot ON workroom_segments(state,boot_id);
        CREATE TABLE workroom_requests(
          request_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES workroom_conversations(id),
          digest TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','completed','unknown','rejected')), session_id TEXT);
        CREATE INDEX workroom_request_state ON workroom_requests(kind,state);
      `);
      if (fresh) this.#db.query('INSERT INTO workroom_meta VALUES(1,1,?)').run(randomUUID());
      const meta = this.#db.query('SELECT version,instance_id FROM workroom_meta WHERE singleton=1').get() as { version: number; instance_id: string } | null;
      if (!meta || ![1,2].includes(meta.version) || !/^[A-Za-z0-9_-]{8,160}$/.test(meta.instance_id)) throw new Error('지원되지 않거나 손상된 대화 기록입니다. 원본은 유지합니다.');
      this.storeInstanceId = meta.instance_id;
      this.#transaction(() => {
        if(meta.version===1){
          this.#db.exec("CREATE TABLE workroom_submissions(key TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('prepared','write_started','written','unknown','rejected')), boot_id TEXT NOT NULL, target_id TEXT NOT NULL, body TEXT NOT NULL); CREATE INDEX workroom_submission_state ON workroom_submissions(state,boot_id); CREATE INDEX workroom_submission_target ON workroom_submissions(target_id); UPDATE workroom_meta SET version=2 WHERE singleton=1;");
        }
        this.#db.query("UPDATE workroom_submissions SET state='unknown' WHERE state='write_started' AND boot_id!=?").run(bootId);
        // A 'prepared' row from an earlier boot can never commit (its payload lived in that process) and provably never
        // started writing — write_started is recorded before the PTY write. Once it is old it becomes 'rejected': still a
        // dedupe record for its id, no longer holding a slot as an open question. Bounded per boot; never touches
        // write_started or unknown rows. A row stored before preparedAt existed cannot be dated; being an old-boot
        // 'prepared' row it is just as uncommittable, so it is aged on the first open regardless of its real age.
        const agedBefore = new Date(Date.parse(now()) - WORKROOM_SUBMISSION_PREPARED_AGE_MS).toISOString();
        this.#db.query("UPDATE workroom_submissions SET state='rejected' WHERE rowid IN (SELECT rowid FROM workroom_submissions WHERE state='prepared' AND boot_id!=? AND (json_extract(body,'$.preparedAt') IS NULL OR json_extract(body,'$.preparedAt')<?) LIMIT ?)").run(bootId, agedBefore, WORKROOM_SUBMISSION_AGING_BATCH);
        this.#db.exec(RESTART_TABLES);
        const opened = now();
        this.#db.query('INSERT OR REPLACE INTO workroom_boots VALUES(?,?,?,?,?,NULL)').run(bootId, options.pid ?? process.pid, this.#build, opened, opened);
        // Only a boot that is gone gives up its running rows. Another sidecar on the same data folder (`bun api-server.ts`
        // beside the app) keeps its live sessions; they are detached by a later check once that boot is gone.
        this.#detachStale();
        const pending = this.#db.query("SELECT conversation_id,request_id FROM workroom_requests WHERE kind='resume' AND state='prepared'").all() as { conversation_id: string; request_id: string }[];
        this.#db.query("UPDATE workroom_requests SET state='unknown' WHERE kind='resume' AND state='prepared'").run();
        for (const request of pending) {
          const r = this.get(request.conversation_id);
          this.#save({ ...r, pendingResumeId: request.request_id, revision: r.revision + 1, updatedAt: now() });
        }
      });
    } catch (error) { this.#db.close(); throw error; }
  }
  submission(key:string):StoredSubmission|null {
    this.#validate();
    const row=this.#db.query('SELECT state,body FROM workroom_submissions WHERE key=?').get(key) as {state:StoredSubmission['state'];body:string}|null;
    if(!row)return null;
    if(row.body.length>4096)throw Error('제출 기록을 확인하지 못했습니다.');
    const value=JSON.parse(row.body) as StoredSubmission;
    if(value.key!==key||!['prepared','write_started','written','unknown','rejected'].includes(row.state))throw Error('제출 기록을 확인하지 못했습니다.');
    return {...value,state:row.state};
  }
  prepareSubmission(value:StoredSubmission):StoredSubmission {
    return this.#transaction(()=>{
      const previous=this.submission(value.key);
      if(previous){if(previous.fingerprint!==value.fingerprint)throw Error('같은 제출 ID의 내용 또는 입력 상태가 변경되었습니다.');return previous;}
      // Rejected rows (aged or refused) no longer hold an open slot; the total ceiling still bounds the table.
      const count=this.#db.query("SELECT COUNT(*) AS n, COALESCE(SUM(state!='rejected'),0) AS open FROM workroom_submissions").get() as {n:number;open:number};
      if(count.open>=WORKROOM_SUBMISSION_OPEN_LIMIT||count.n>=WORKROOM_SUBMISSION_TOTAL_LIMIT)throw Error('제출 기록 저장 한도에 도달했습니다. 기존 미확정 기록은 유지합니다.');
      const stored={...value,preparedAt:value.preparedAt??this.now()};
      this.#db.query('INSERT INTO workroom_submissions VALUES(?,?,?,?,?)').run(stored.key,stored.state,stored.bootId,stored.targetId,JSON.stringify(stored));
      return stored;
    });
  }
  transitionSubmission(key:string,from:StoredSubmission['state'],to:StoredSubmission['state'],exposure?:CorrectionTaskExposure) {
    this.#transaction(()=>{
      const record=this.submission(key);
      if(!record||record.state!==from||record.bootId!==this.bootId)throw Error('제출 상태가 변경되었습니다. 자동으로 다시 보내지 않습니다.');
      // Metadata times ride inside the body JSON — no new column and no workroom_meta version bump, so a v2 reader that
      // only checks key and state still opens a stamped record after a rollback.
      const stamps=from==='prepared'&&to==='write_started'?{startedAt:this.now()}:to==='written'?{writtenAt:this.now()}:{};
      const body=JSON.stringify({...record,...stamps,...(exposure?{exposure}:{})});if(body.length>4096)throw Error('제출 근거의 크기 한도를 초과했습니다.');
      // The exposure becomes visible only now, so the row takes the next rowid: an outcome observer reading by rowid
      // cursor must not have already passed it. Without this, a submission prepared earlier but committed after a later
      // one sat below the cursor and its exposure was never read. Rows are never deleted, so MAX(rowid)+1 only grows.
      const reorder=exposure&&from==='prepared'?',rowid=(SELECT MAX(rowid)+1 FROM workroom_submissions)':'';
      this.#db.query(`UPDATE workroom_submissions SET state=?,body=?${reorder} WHERE key=? AND state=?`).run(to,body,key,from);
    });
  }
  /**
   * Submissions that carried a correction exposure, after a rowid cursor. Metadata only — the body holds no payload.
   * A row is moved to the next rowid when its exposure is attached (transitionSubmission), so rowid order is the order
   * in which exposures became visible and an advancing cursor never skips one.
   * Bounded by the caller's limit (at most 256) so an outcome observer can ingest incrementally.
   */
  correctionExposureUnits(afterRowid:number,limit:number){
    this.#validate();
    if(!Number.isSafeInteger(afterRowid)||afterRowid<0||!Number.isSafeInteger(limit)||limit<1||limit>256)throw Error('교정 노출 기록 조회 범위를 확인하세요.');
    const rows=this.#db.query(`SELECT rowid,state,body FROM workroom_submissions WHERE rowid>? AND body LIKE '%"exposure":%' ORDER BY rowid LIMIT ?`).all(afterRowid,limit) as {rowid:number;state:StoredSubmission['state'];body:string}[];
    return rows.map(row=>{
      if(row.body.length>4096)throw Error('제출 기록 크기를 확인하세요.');
      const value=JSON.parse(row.body) as StoredSubmission;
      return {rowid:row.rowid,key:value.key,state:row.state,targetId:value.targetId,sessionId:value.sessionId,
        startedAt:value.startedAt??null,writtenAt:value.writtenAt??null,exposure:value.exposure??null};
    });
  }
  /** Unsettled receipts (write_started · unknown, and prepared of this boot — an older boot's prepared row is «held» and
   *  can never be written) of one owner digest in one key scope (a session id, or the
   *  launch scope), newest first, prepared within the last day. Bounded; never returns payloads (rows hold none). */
  recentSubmissions(ownerDigest:string,scope:string,limit:number):StoredSubmission[] {
    this.#validate();
    const since=new Date(Date.parse(this.now())-WORKROOM_SUBMISSION_RECENT_WINDOW_MS).toISOString();
    const rows=this.#db.query("SELECT state,body FROM workroom_submissions WHERE (state IN ('write_started','unknown') OR state='prepared' AND boot_id=?) AND json_extract(body,'$.owner')=? AND COALESCE(json_extract(body,'$.scope'),json_extract(body,'$.sessionId'))=? AND json_extract(body,'$.preparedAt')>=? ORDER BY rowid DESC LIMIT ?").all(this.bootId,ownerDigest,scope,since,Math.max(1,Math.min(32,limit))) as {state:StoredSubmission['state'];body:string}[];
    return rows.map(row=>{
      if(row.body.length>4096)throw Error('제출 기록을 확인하지 못했습니다.');
      const value=JSON.parse(row.body) as StoredSubmission;
      if(value.owner!==ownerDigest)throw Error('제출 기록을 확인하지 못했습니다.');
      return {...value,state:row.state};
    });
  }
  correctionTaskSummary(targetId:string,memoryId:string){
    this.#validate();
    const rows=this.#db.query('SELECT state,body FROM workroom_submissions WHERE target_id=? ORDER BY rowid DESC LIMIT 129').all(targetId) as {state:string;body:string}[];
    let delivered=0,uncertain=0,withheld=0;
    for(const row of rows.slice(0,128)){
      if(row.body.length>4096)throw Error('제출 기록 크기를 확인하세요.');
      const record=JSON.parse(row.body) as StoredSubmission;
      if(record.targetId!==targetId||record.exposure?.memoryId!==memoryId)continue;
      if(record.exposure.sourceWithheld){withheld++;continue;}
      if(row.state==='written')delivered++;else if(['write_started','unknown'].includes(row.state))uncertain++;
    }
    return {delivered,uncertain,withheld,awaitingIndependentOutcome:delivered,efficacyVerified:false as const,truncated:rows.length>128,scope:'recent-local-submissions' as const};
  }
  #validate() {
    if (this.#closed || stamp(this.#parent, true) !== this.#parentIdentity || stamp(this.#root, true, true) !== this.#rootIdentity || stamp(this.#path, false) !== this.#identity) throw new Error('대화 기록 저장소가 변경되었거나 닫혔습니다.');
  }
  #decode(body: string): StoredWorkroomConversation {
    if (body.length > 4096) throw new Error('대화 기록 크기를 확인하세요.');
    const r = JSON.parse(body) as StoredWorkroomConversation;
    publicWorkroomConversation(r);
    if (Object.keys(r).some(k=>!['id','targetId','agent','accountId','accountLabel','title','createdAt','updatedAt','revision','archived','state','sessionId','binding','bootId','targetFingerprint','accountFingerprint','providerConversationId','exitedAt','restricted','pendingResumeId'].includes(k))
      || typeof r.bootId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(r.bootId) || !/^[a-f0-9]{64}$/.test(r.targetFingerprint) || !/^[a-f0-9]{64}$/.test(r.accountFingerprint)
      || !(r.providerConversationId === null || typeof r.providerConversationId === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(r.providerConversationId))
      || r.binding==='verified'&&!r.providerConversationId || typeof r.restricted !== 'boolean' || !(r.pendingResumeId === null || typeof r.pendingResumeId === 'string'&&/^[A-Za-z0-9_-]{8,160}$/.test(r.pendingResumeId))
      || !(r.exitedAt === null || typeof r.exitedAt === 'string' && Number.isFinite(Date.parse(r.exitedAt)))) throw new Error('대화 연결 기록을 확인하세요.');
    return r;
  }
  #transaction<T>(operation: () => T): T {
    this.#validate(); this.#db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.#validate(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #save(r: StoredWorkroomConversation) {
    this.#decode(JSON.stringify(r));
    this.#db.query('INSERT INTO workroom_conversations VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,archived=excluded.archived,revision=excluded.revision,boot_id=excluded.boot_id,state=excluded.state,body=excluded.body')
      .run(r.id, r.sessionId, r.createdAt, r.archived ? 1 : 0, r.revision, r.bootId, r.state, JSON.stringify(r));
  }
  get(id: string): StoredWorkroomConversation {
    this.#validate();
    const row = this.#db.query('SELECT body FROM workroom_conversations WHERE id=?').get(id) as { body: string } | null;
    if (!row) throw new Error('원래 대화 기록을 찾지 못했습니다.');
    return this.#decode(row.body);
  }
  forSession(sessionId: string): StoredWorkroomConversation | null {
    this.#validate();
    const row = this.#db.query('SELECT c.body FROM workroom_segments s JOIN workroom_conversations c ON c.id=s.conversation_id WHERE s.session_id=?').get(sessionId) as { body: string } | null;
    return row ? this.#decode(row.body) : null;
  }
  list(archived: boolean, before?: string) {
    this.#validate();
    const cursor = before ? this.get(before) : null;
    if (cursor && cursor.archived !== archived) throw new Error('대화 기록 필터가 변경되었습니다. 첫 페이지부터 확인하세요.');
    const rows = this.#db.query('SELECT body FROM workroom_conversations WHERE archived=? AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(archived ? 1 : 0, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, WORKROOM_HISTORY_PAGE_SIZE + 1) as { body: string }[];
    const page = rows.slice(0, WORKROOM_HISTORY_PAGE_SIZE).map(row => this.#decode(row.body));
    return { records: page, nextBefore: rows.length > WORKROOM_HISTORY_PAGE_SIZE ? page.at(-1)!.id : null };
  }
  /** One project's records, newest first, keyset paged like `list`. Host-only: used for a phone's history list. */
  listTarget(targetId: string, archived: boolean, before: string | undefined, limit: number) {
    this.#validate();
    const cursor = before ? this.get(before) : null;
    if (cursor && (cursor.archived !== archived || cursor.targetId !== targetId)) throw new Error('대화 기록 필터가 변경되었습니다. 첫 페이지부터 확인하세요.');
    const size = Math.max(1, Math.min(limit, WORKROOM_HISTORY_PAGE_SIZE));
    const rows = this.#db.query("SELECT body FROM workroom_conversations WHERE archived=? AND json_extract(body,'$.targetId')=? AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?")
      .all(archived ? 1 : 0, targetId, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, size + 1) as { body: string }[];
    const page = rows.slice(0, size).map(row => this.#decode(row.body));
    return { records: page, nextBefore: rows.length > size ? page.at(-1)!.id : null };
  }
  started(context: WorkroomSessionContext, logicalId?: string) {
    return this.#transaction(() => {
      const s = context.summary;
      const old = logicalId ? this.get(logicalId) : this.forSession(s.id);
      if (old && (old.targetId !== s.targetId || old.agent !== s.agent || old.accountId !== (s.accountId ?? 'host-default')
        || old.targetFingerprint !== context.targetFingerprint || old.accountFingerprint !== context.accountFingerprint)) throw new Error('원래 대화의 계정 또는 프로젝트가 변경되었습니다.');
      const now = this.now();
      const r: StoredWorkroomConversation = {
        id: old?.id ?? randomUUID(), targetId: s.targetId, agent: s.agent, accountId: s.accountId ?? 'host-default',
        accountLabel: s.accountLabel ?? '현재 CLI 계정', title: old?.title ?? '', createdAt: old?.createdAt ?? s.createdAt,
        updatedAt: now, revision: (old?.revision ?? 0) + 1, archived: old?.archived ?? false, state: s.state === 'running' ? 'running' : 'ended',
        sessionId: s.id, binding: old?.binding ?? 'unverified', bootId: this.bootId,
        targetFingerprint: context.targetFingerprint, accountFingerprint: context.accountFingerprint,
        // Claude's launch ID is known before its first turn is saved. Retain it as unverified evidence
        // so an abrupt host exit does not lose the only way to inspect that exact conversation.
        providerConversationId: old?.providerConversationId ?? (s.agent==='claude'?context.providerConversationId??null:null), exitedAt: context.exitedAt ?? null,
        restricted: context.restricted, pendingResumeId: old?.pendingResumeId ?? null,
      };
      this.#save(r);
      this.#db.query('INSERT INTO workroom_segments VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING')
        .run(s.id,r.id,this.bootId,s.createdAt,context.exitedAt??null,r.state);
      // Host-only facts of this session: kept beside the body so the body keys (and an older reader) stay unchanged.
      if (typeof context.bypass === 'boolean') this.#db.query('INSERT OR IGNORE INTO workroom_session_facts VALUES(?,?,?)').run(s.id, r.id, context.bypass ? 1 : 0);
      // Whether the CLI ever got input (a first request, a submission, a keystroke). A Codex row that got none wrote no
      // rollout, so a later derivation never gives it one — nor lets it compete with the row that did (w14 review).
      if (typeof context.submitted === 'boolean') this.#db.query('INSERT INTO workroom_session_inputs VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET had_input=MAX(had_input,excluded.had_input)')
        .run(s.id, r.id, context.submitted ? 1 : 0);
      this.#heartbeat(now);
      return r;
    });
  }
  observe(context: WorkroomSessionContext, providerId: string | null) {
    return this.#transaction(() => {
      const r = this.forSession(context.summary.id);
      if (!r) return null;
      const state: WorkroomConversation['state'] = context.summary.state === 'running' ? 'running' : 'ended';
      this.#db.query('UPDATE workroom_segments SET state=?,ended_at=? WHERE session_id=?').run(state,context.exitedAt??null,context.summary.id);
      if (r.sessionId !== context.summary.id) return r;
      if (r.state === 'ended' && state === 'running') return r;
      if (r.targetFingerprint !== context.targetFingerprint || r.accountFingerprint !== context.accountFingerprint) providerId = null;
      if (state === r.state && (providerId === null || providerId === r.providerConversationId && r.binding==='verified')) return r;
      const updated = { ...r, state, exitedAt: context.exitedAt ?? r.exitedAt, providerConversationId: providerId ?? r.providerConversationId,
        binding: providerId ? 'verified' as const : r.binding, updatedAt: this.now(), revision: r.revision + 1 };
      this.#save(updated); return updated;
    });
  }
  receipt(requestId: string, fingerprint?: string): WorkroomResumeReceipt | null {
    this.#validate();
    const row = this.#db.query("SELECT * FROM workroom_requests WHERE request_id=? AND kind='resume'").get(requestId) as any;
    if (!row) return null;
    if (fingerprint && row.digest !== fingerprint) throw new Error('같은 요청 ID에 다른 대화 재개를 보낼 수 없습니다.');
    return { requestId, conversationId: row.conversation_id, digest: row.digest, state: row.state, sessionId: row.session_id };
  }
  prepareResume(id: string, revision: number, requestId: string, input: unknown) {
    const fingerprint = digest(input);
    return this.#transaction(() => {
      const old = this.receipt(requestId, fingerprint); if (old) return old;
      const r = this.get(id);
      if (r.revision !== revision || r.pendingResumeId !== null || r.state === 'running') throw new Error('대화 상태가 변경되었거나 다른 재개가 진행 중입니다. 다시 확인하세요.');
      // In the same transaction as the reservation: another row of the same provider conversation already holds it.
      if (r.providerConversationId && this.providerBusy(r.providerConversationId, r.id)) throw new Error(WORKROOM_PROVIDER_BUSY);
      this.#db.query("INSERT INTO workroom_requests VALUES(?,?,?,'resume','prepared',NULL)").run(requestId, id, fingerprint);
      this.#save({ ...r, pendingResumeId: requestId, revision: r.revision + 1, updatedAt: this.now() });
      return this.receipt(requestId)!;
    });
  }
  finishResume(requestId: string, state: 'completed' | 'unknown' | 'rejected', sessionId: string | null = null) {
    return this.#transaction(() => {
      const request = this.receipt(requestId); if (!request || request.state !== 'prepared') return;
      this.#db.query('UPDATE workroom_requests SET state=?,session_id=? WHERE request_id=?').run(state, sessionId, requestId);
      if (state !== 'unknown') {
        const r = this.get(request.conversationId);
        if (r.pendingResumeId === requestId) this.#save({ ...r, pendingResumeId: null, revision: r.revision + 1, updatedAt: this.now() });
      }
    });
  }
  mutate(id: string, revision: number, requestId: string, operation: 'rename' | 'archive' | 'unarchive', title?: string) {
    const fingerprint = digest([id, revision, operation, title ?? null]);
    return this.#transaction(() => {
      const old = this.#db.query('SELECT digest FROM workroom_requests WHERE request_id=?').get(requestId) as { digest: string } | null;
      if (old) { if (old.digest !== fingerprint) throw new Error('같은 요청 ID의 대화 변경 내용이 다릅니다.'); return this.get(id); }
      const r = this.get(id);
      if (r.revision !== revision || r.pendingResumeId) throw new Error('대화 기록이 변경되었습니다. 다시 확인하세요.');
      const changed = { ...r, ...(operation === 'rename' ? { title: title! } : { archived: operation === 'archive' }), revision: r.revision + 1, updatedAt: this.now() };
      this.#save(changed);
      this.#db.query("INSERT INTO workroom_requests VALUES(?,?,?,?,'completed',NULL)").run(requestId, id, fingerprint, operation);
      return changed;
    });
  }
  // ── Resume after an update (w14) ───────────────────────────────────────────────────────────────────────────
  #heartbeat(at = this.now()) { this.#db.query('UPDATE workroom_boots SET last_seen_at=? WHERE boot_id=?').run(at, this.bootId); }
  /** This boot is still alive: a second sidecar on the same folder keeps its running rows while this is fresh. */
  heartbeat() { this.#validate(); this.#heartbeat(); }
  boot(bootId: string): WorkroomBootRecord | null {
    this.#validate();
    const row = this.#db.query('SELECT * FROM workroom_boots WHERE boot_id=?').get(bootId) as any;
    return row ? { bootId: row.boot_id, pid: row.pid, build: row.build, openedAt: row.opened_at, lastSeenAt: row.last_seen_at, closedAt: row.closed_at ?? null } : null;
  }
  /** When the next sidecar opened after `at` (another boot than `exceptBootId`): a session of an earlier boot ended by then. */
  bootOpenedAfter(at: string, exceptBootId: string): string | null {
    this.#validate();
    const row = this.#db.query('SELECT MIN(opened_at) AS opened FROM workroom_boots WHERE boot_id!=? AND opened_at>=?').get(exceptBootId, at) as { opened: string | null } | null;
    return row?.opened ?? null;
  }
  #bootAlive(bootId: string, nowMs: number) {
    const row = this.#db.query('SELECT pid,last_seen_at,closed_at FROM workroom_boots WHERE boot_id=?').get(bootId) as { pid: number; last_seen_at: string; closed_at: string | null } | null;
    // A boot from before this table existed cannot prove it is alive; it is treated as gone, as every boot was before.
    if (!row || row.closed_at) return false;
    const seen = Date.parse(row.last_seen_at);
    if (!Number.isFinite(seen) || nowMs - seen > WORKROOM_BOOT_STALE_MS) return false;
    try { return this.#alive(row.pid); } catch { return false; }
  }
  /** Rows still `running` under a boot that is gone become `detached` (bounded per call), and they become one offer. */
  detachStale() { return this.#transaction(() => this.#detachStale()); }
  #detachStale(): number {
    const at = this.now(), nowMs = Date.parse(at);
    const boots = (this.#db.query("SELECT DISTINCT boot_id FROM workroom_conversations WHERE state='running' AND boot_id!=? LIMIT 256").all(this.bootId) as { boot_id: string }[])
      .map(row => row.boot_id).filter(id => !this.#bootAlive(id, nowMs));
    if (!boots.length) return 0;
    const marks = boots.map(() => '?').join(',');
    const rows = this.#db.query(`SELECT body FROM workroom_conversations WHERE state='running' AND boot_id IN (${marks}) ORDER BY created_at DESC,id DESC LIMIT ?`).all(...boots, WORKROOM_DETACH_BATCH) as { body: string }[];
    const converted: { record: StoredWorkroomConversation; lastSign: string }[] = [];
    for (const row of rows) {
      const r = this.#decode(row.body);
      if (r.state !== 'running' || r.bootId === this.bootId) continue;
      // The last sign of life: the boot's heartbeat, or the row itself for a boot from before the boot table.
      const lastSign = (this.#db.query('SELECT last_seen_at FROM workroom_boots WHERE boot_id=?').get(r.bootId) as { last_seen_at: string } | null)?.last_seen_at ?? r.updatedAt;
      this.#save({ ...r, state: 'detached', revision: r.revision + 1, updatedAt: at });
      converted.push({ record: r, lastSign });
    }
    this.#db.query(`UPDATE workroom_segments SET state='detached' WHERE state='running' AND boot_id IN (${marks})`).run(...boots);
    this.#offerFrom(converted, boots, at);
    return converted.length;
  }
  #offerFrom(converted: { record: StoredWorkroomConversation; lastSign: string }[], deadBoots: string[], at: string) {
    const nowMs = Date.parse(at);
    this.#expireOffers(nowMs);
    const fresh = converted.filter(x => !x.record.archived && !x.record.restricted && nowMs - Date.parse(x.lastSign) <= WORKROOM_RESTART_OFFER_TTL_MS).map(x => x.record.id);
    if (!fresh.length) return;
    // An earlier offer nobody handled (two updates in a row) hands over its rows that are still detached.
    const open = this.#db.query("SELECT * FROM workroom_restart_offers WHERE state='open'").all() as any[];
    const carried: string[] = [];
    for (const offer of open) for (const id of JSON.parse(offer.conversation_ids) as string[]) {
      const row = this.#db.query('SELECT body FROM workroom_conversations WHERE id=?').get(id) as { body: string } | null;
      if (!row) continue;
      const r = this.#decode(row.body);
      if (r.state === 'detached' && !r.archived && !r.restricted) carried.push(id);
    }
    const ids = [...new Set([...fresh, ...carried])];
    const builds = (deadBoots.length ? this.#db.query(`SELECT build FROM workroom_boots WHERE boot_id IN (${deadBoots.map(() => '?').join(',')})`).all(...deadBoots) as { build: string }[] : []).map(r => r.build);
    const update = !!this.#build && builds.some(build => !!build && build !== this.#build) || open.some(offer => offer.update_flag === 1);
    for (const offer of open) this.#db.query("UPDATE workroom_restart_offers SET state='superseded',revision=revision+1 WHERE offer_id=? AND state='open'").run(offer.offer_id);
    this.#db.query("INSERT INTO workroom_restart_offers VALUES(?,?,?,1,'open',?,?,?,NULL)")
      .run(randomUUID(), this.bootId, at, JSON.stringify(ids.slice(0, WORKROOM_RESTART_OFFER_MAX_ROWS)), ids.length > WORKROOM_RESTART_OFFER_MAX_ROWS ? 1 : 0, update ? 1 : 0);
  }
  #expireOffers(nowMs: number) {
    const before = new Date(nowMs - WORKROOM_RESTART_OFFER_TTL_MS).toISOString();
    this.#db.query("UPDATE workroom_restart_offers SET state='expired',revision=revision+1 WHERE state='open' AND created_at<?").run(before);
  }
  #offerRecord(row: any): WorkroomRestartOfferRecord {
    const ids = JSON.parse(row.conversation_ids);
    if (!Array.isArray(ids) || ids.length > WORKROOM_RESTART_OFFER_MAX_ROWS || !ids.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(id))) throw new Error('재시작 기록을 확인하지 못했습니다.');
    return { offerId: row.offer_id, bootId: row.boot_id, createdAt: row.created_at, revision: row.revision, state: row.state, conversationIds: ids, more: row.more === 1, update: row.update_flag === 1 };
  }
  /** The newest open offer, or null. An offer older than 72 h expires here. Read-only otherwise. */
  restartOffer(): WorkroomRestartOfferRecord | null {
    return this.#transaction(() => {
      this.#expireOffers(Date.parse(this.now()));
      const row = this.#db.query("SELECT * FROM workroom_restart_offers WHERE state='open' ORDER BY created_at DESC LIMIT 1").get();
      return row ? this.#offerRecord(row) : null;
    });
  }
  offer(offerId: string): WorkroomRestartOfferRecord | null {
    this.#validate();
    const row = this.#db.query('SELECT * FROM workroom_restart_offers WHERE offer_id=?').get(offerId);
    return row ? this.#offerRecord(row) : null;
  }
  /**
   * Shared by every window and phone (it lives here). Idempotent by request id. A person who closes an offer that a newer
   * restart has since superseded (a second sidecar on this folder ended meanwhile) closed exactly the rows they saw: those
   * are taken out of the newer offer, which carried them over — they never come back (w14 review). Other closed offers
   * are left alone.
   */
  dismissOffer(offerId: string, expectedRevision: number, requestId: string) {
    this.#transaction(() => {
      const row = this.#db.query('SELECT * FROM workroom_restart_offers WHERE offer_id=?').get(offerId) as any;
      if (!row) throw new Error('이어 열기 안내를 찾지 못했습니다. 목록을 다시 확인하세요.');
      if (row.dismiss_request === requestId) return;
      if (row.state === 'superseded') {
        const closed = new Set(this.#offerRecord(row).conversationIds);
        for (const open of this.#db.query("SELECT * FROM workroom_restart_offers WHERE state='open'").all() as any[]) {
          const left = this.#offerRecord(open).conversationIds.filter(id => !closed.has(id));
          if (left.length === this.#offerRecord(open).conversationIds.length) continue;
          this.#db.query("UPDATE workroom_restart_offers SET conversation_ids=?,revision=revision+1,state=? WHERE offer_id=? AND state='open'")
            .run(JSON.stringify(left), left.length ? 'open' : 'dismissed', open.offer_id);
        }
        this.#db.query('UPDATE workroom_restart_offers SET dismiss_request=? WHERE offer_id=?').run(requestId, offerId);
        return;
      }
      if (row.state !== 'open') return;
      if (row.revision !== expectedRevision) throw new Error('이어 열기 안내가 변경되었습니다. 다시 확인하세요.');
      this.#db.query("UPDATE workroom_restart_offers SET state='dismissed',revision=revision+1,dismiss_request=? WHERE offer_id=? AND state='open'").run(requestId, offerId);
    });
  }
  /** Nothing in the offer can be opened any more (resumed, or never resumable): it is finished, not shown again. */
  finishOffer(offerId: string) {
    this.#transaction(() => { this.#db.query("UPDATE workroom_restart_offers SET state='done',revision=revision+1 WHERE offer_id=? AND state='open'").run(offerId); });
  }
  /** The session got its first input now (kept once; a session started before this was recorded stays unknown). */
  markInput(sessionId: string) {
    this.#transaction(() => { this.#db.query('UPDATE workroom_session_inputs SET had_input=1 WHERE session_id=? AND had_input=0').run(sessionId); });
  }
  /** Whether the session ever got input: true · false · null (recorded by a build from before this was kept). */
  sessionHadInput(sessionId: string): boolean | null {
    this.#validate();
    const row = this.#db.query('SELECT had_input FROM workroom_session_inputs WHERE session_id=?').get(sessionId) as { had_input: number } | null;
    return row ? row.had_input === 1 : null;
  }
  /**
   * Codex rows of one project and CLI account that never learned their thread, newest first, started no later than
   * `startedBefore`. The rows a derived rollout could belong to (w14 review: a derivation is joint, never per row).
   */
  unboundCodexRows(targetId: string, accountId: string, startedBefore: string, limit = 256): StoredWorkroomConversation[] {
    this.#validate();
    const rows = this.#db.query("SELECT body FROM workroom_conversations WHERE created_at<=? AND json_extract(body,'$.agent')='codex' AND json_extract(body,'$.targetId')=? AND json_extract(body,'$.accountId')=? AND json_extract(body,'$.providerConversationId') IS NULL ORDER BY created_at DESC,id DESC LIMIT ?")
      .all(startedBefore, targetId, accountId, Math.max(1, Math.min(512, limit))) as { body: string }[];
    return rows.map(row => this.#decode(row.body));
  }
  /**
   * Whether another conversation that names this provider conversation holds it now: running, or with a resume of its
   * own in flight or unsettled. Exactly once is per provider conversation, not only per row (w14 review): two rows can
   * name one conversation (a Codex `/resume` inside a session), and a reservation of one must refuse the other.
   */
  providerBusy(providerId: string, exceptId: string): boolean {
    this.#validate();
    const rows = this.#db.query("SELECT body FROM workroom_conversations WHERE json_extract(body,'$.providerConversationId')=? AND id!=? LIMIT 16").all(providerId, exceptId) as { body: string }[];
    for (const row of rows) {
      const other = this.#decode(row.body);
      if (other.state === 'running') return true;
      if (other.pendingResumeId) { const state = this.receipt(other.pendingResumeId)?.state; if (state === 'prepared' || state === 'unknown') return true; }
    }
    return false;
  }
  sessionBypass(sessionId: string): boolean | null {
    this.#validate();
    const row = this.#db.query('SELECT bypass FROM workroom_session_facts WHERE session_id=?').get(sessionId) as { bypass: number } | null;
    return row ? row.bypass === 1 : null;
  }
  bindingCheck(conversationId: string): { revision: number; outcome: 'unsaved' | 'ambiguous' | 'legacy' } | null {
    this.#validate();
    const row = this.#db.query('SELECT revision,outcome FROM workroom_binding_checks WHERE conversation_id=?').get(conversationId) as { revision: number; outcome: string } | null;
    return row ? { revision: row.revision, outcome: row.outcome === 'none' || row.outcome === 'unsaved' ? 'unsaved' : row.outcome as 'ambiguous' | 'legacy' } : null;
  }
  /** A negative outcome holds for this revision only; any change of the row asks again. */
  recordBindingCheck(conversationId: string, revision: number, outcome: 'unsaved' | 'ambiguous' | 'legacy') {
    this.#transaction(() => { this.#db.query('INSERT OR REPLACE INTO workroom_binding_checks VALUES(?,?,?,?)').run(conversationId, revision, outcome, this.now()); });
  }
  /** Whether another conversation already names this provider conversation (as evidence, or running). */
  providerClaimed(providerId: string, exceptId: string, runningOnly = false): boolean {
    this.#validate();
    return !!this.#db.query(`SELECT 1 FROM workroom_conversations WHERE json_extract(body,'$.providerConversationId')=? AND id!=?${runningOnly ? " AND state='running'" : ''} LIMIT 1`).get(providerId, exceptId);
  }
  /** Binds a conversation proven afterwards (a saved transcript, or exactly one Codex rollout). CAS on the revision. */
  bindDerived(id: string, revision: number, providerId: string) {
    return this.#transaction(() => {
      const r = this.get(id);
      if (r.revision !== revision || r.state === 'running' || r.pendingResumeId) throw new Error('대화 상태가 변경되었습니다. 다시 확인하세요.');
      if (r.providerConversationId && r.providerConversationId !== providerId) throw new Error('다른 대화로 확인된 기록입니다.');
      if (this.providerClaimed(providerId, id)) throw new Error('이 대화는 다른 기록에 이미 연결되어 있습니다.');
      const bound = { ...r, providerConversationId: providerId, binding: 'verified' as const, revision: r.revision + 1, updatedAt: this.now() };
      this.#save(bound); return bound;
    });
  }
  /**
   * A person checked the session list and says a resume whose outcome is unknown did not leave the conversation open.
   * Clears that hold so the conversation can be reviewed again. Never while the resume may still be running in this boot
   * (`prepared`); the receipt itself stays as the dedupe record of its request id. Idempotent by request id.
   */
  settleResume(id: string, revision: number, requestId: string) {
    const fingerprint = digest([id, revision, 'settle']);
    return this.#transaction(() => {
      const old = this.#db.query('SELECT digest FROM workroom_requests WHERE request_id=?').get(requestId) as { digest: string } | null;
      if (old) { if (old.digest !== fingerprint) throw new Error('같은 요청 ID의 확인 내용이 다릅니다.'); return this.get(id); }
      const r = this.get(id);
      if (r.revision !== revision) throw new Error('대화 기록이 변경되었습니다. 다시 확인하세요.');
      if (!r.pendingResumeId) throw new Error('결과 확인이 필요한 이어 열기가 없습니다.');
      if (this.receipt(r.pendingResumeId)?.state !== 'unknown') throw new Error('이 대화를 아직 여는 중입니다. 잠시 후 결과를 다시 확인하세요.');
      const settled = { ...r, pendingResumeId: null, revision: r.revision + 1, updatedAt: this.now() };
      this.#save(settled);
      this.#db.query("INSERT INTO workroom_requests VALUES(?,?,?,'settle','completed',NULL)").run(requestId, id, fingerprint);
      return settled;
    });
  }
  close() {
    if (this.#closed) return;
    // A boot that closed is gone for every later open: its running rows become this restart's offer at once.
    try { const at = this.now(); this.#db.query('UPDATE workroom_boots SET closed_at=?,last_seen_at=? WHERE boot_id=?').run(at, at, this.bootId); } catch { /* closing anyway */ }
    this.#closed = true; this.#db.close();
  }
}
