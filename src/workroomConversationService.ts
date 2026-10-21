import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WorkroomConversationJournal, publicWorkroomConversation, WORKROOM_PROVIDER_BUSY, type StoredWorkroomConversation } from './workroomConversationJournal';
import { normalizeWorkroomHistoryRequest, WORKROOM_HISTORY_VERSION, WORKROOM_RESUME_UNSETTLED_REASON, workroomHistoryErrorMessage, workroomRestartActionable,
  type WorkroomHistoryResult, type WorkroomRestartAvailability, type WorkroomRestartOffer, type WorkroomRestartRow } from './workroomConversationProtocol';
import { codexRolloutCandidates } from './workroomRestartBinding';
import { savedWorkroomConversation } from './workroomConversationIdentity';
import { processGroupOpenFiles, resolveAiTerminalResume } from './aiTerminalResume';
import type { WorkroomHistoryLaunch, WorkroomHistoryObserver, WorkroomSessionContext } from './workroomConversationHost';
import type { AiTerminalResponse } from './aiTerminalProtocol';

export interface WorkroomConversationDependencies {
  appDataDir: string;
  contexts(): WorkroomSessionContext[];
  prepare(record: StoredWorkroomConversation): Promise<WorkroomSessionContext>;
  launch(record: StoredWorkroomConversation, requestId: string, cols: number, rows: number, options: WorkroomHistoryLaunch): Promise<AiTerminalResponse>;
  assertNoWriter?(context: WorkroomSessionContext, providerId: string, savedPath: string): Promise<void>;
  resolveBinding?(context: WorkroomSessionContext): Promise<string | null>;
  journal?: WorkroomConversationJournal;
  platform?: string;
  now?: () => number;
  /** This app's build, recorded per boot: a previous boot with another build makes the restart offer an update. */
  build?: string;
  /** Whether a pid still answers (default `process.kill(pid, 0)`); tests inject it. */
  processAlive?: (pid: number) => boolean;
  /** The liveness tick (heartbeat, early verification). 0 disables the timer; tests call `tick()`. Default 60 s. */
  tickMs?: number;
}
/** Probes (account preparation, transcript or rollout reads) one `restart.list` may spend on unproven rows. */
const RESTART_PROBE_BUDGET = 8;
/** Rows a liveness tick may verify (each is at most one lsof) — the same bound as a history list. */
const TICK_CAPTURES = 4;
/** Probes one phone history page may spend (w14 review: a row is `resumable` only from a check, never from the row alone). */
const REMOTE_LIST_PROBE_BUDGET = 8;
/**
 * How long an answer that depends on this Mac's state now (the project and CLI account fingerprints, whether the project
 * can be prepared) is trusted without another probe. Persisted outcomes (unsaved · ambiguous · legacy) hold per revision.
 */
const PROBE_TTL_MS = 120_000;
const PROBE_MEMORY = 512;
/** Slack around a Codex rollout start when asking which other rows were alive then (the same as the row's own window). */
const ROLLOUT_SLACK_MS = 10_000;
/** Why a conversation cannot be opened, in one sentence a person can act on (the review reason). */
const AVAILABILITY_REASON: Partial<Record<WorkroomRestartAvailability, string>> = {
  unsupported: '이 AI는 저장된 대화 이어 열기를 지원하지 않습니다. 같은 프로젝트에서 새 대화를 시작하세요.',
  unsaved: '첫 요청을 보내기 전에 끝나 저장된 대화가 없습니다. 같은 프로젝트에서 새 대화를 시작하세요.',
  ambiguous: '같은 시간대에 이 프로젝트의 Codex 대화가 여럿이라 어느 대화인지 고를 수 없습니다. Codex를 직접 열어 resume 목록에서 고르세요.',
  legacy: '이전 버전의 기록이라 어느 대화였는지 확인할 수 없습니다. Codex를 직접 열어 resume 목록에서 고르세요.',
  'in-flight': '이 대화를 여는 중입니다. 잠시 후 결과를 다시 확인하세요.',
  pending: WORKROOM_RESUME_UNSETTLED_REASON,
  running: '이미 실행 중인 대화입니다. 작업 세션 목록에서 여세요.',
  'open-elsewhere': WORKROOM_PROVIDER_BUSY,
  'project-changed': '원래 대화의 프로젝트 폴더가 바뀌었습니다. 자동으로 다른 폴더에서 열지 않습니다.',
  // The fingerprint hashes the credentials file's metadata, so a login (or a token refresh) never brings it back: the
  // advice is what is true, not 「다시 로그인하세요」 (w14 review).
  'account-changed': '그때의 CLI 계정 로그인 상태가 바뀌어 이 화면에서는 이어 열 수 없습니다. 새 대화를 시작하거나 CLI에서 직접 resume 하세요.',
  unprepared: '원래 프로젝트나 CLI 계정을 이 Mac에서 준비하지 못했습니다. 프로젝트 등록과 CLI 계정을 확인하세요.',
};
async function assertNoSavedWriter(context: WorkroomSessionContext, id: string, path: string) {
  const paths = [path];
  if (context.summary.agent === 'codex') {
    const lock = join(context.providerHome,'thread-writer-locks',id+'.lock');
    if (existsSync(lock)) paths.push(lock);
  }
  await new Promise<void>((resolve,reject) => execFile('/usr/sbin/lsof',['-t','--',...paths],{timeout:3000,maxBuffer:4096},(error,stdout,stderr) => {
    if (stdout.trim()) reject(new Error('이 대화가 다른 CLI에서 열려 있습니다. 그 대화의 실행 상태를 먼저 확인하세요.'));
    else if (stderr.trim() || error && (error as any).code !== 1) reject(new Error('대화의 실행 소유자를 확인하지 못했습니다. 다시 확인하세요.'));
    else resolve();
  }));
}
/** Local history and explicit resume. Network controllers cannot call this service through terminal-v1. */
export class WorkroomConversationService implements WorkroomHistoryObserver {
  #journal: WorkroomConversationJournal | null;
  #storageError = false;
  #closed = false;
  #captures = new Map<string,{ at: number; promise: Promise<void> }>();
  #reviews = new Map<string,{ record: StoredWorkroomConversation; expires: number }>();
  #executions = new Map<string,Promise<WorkroomHistoryResult>>();
  #ticker: ReturnType<typeof setInterval> | undefined;
  #ticking: Promise<void> | null = null;
  /** Probe answers that depend on this Mac now (ready, a changed fingerprint, a project that cannot be prepared), by
   *  conversation and revision, trusted for PROBE_TTL_MS. Persisted outcomes live in the journal. */
  #probed = new Map<string, { outcome: WorkroomRestartAvailability; at: number }>();
  readonly #now: () => number;
  constructor(private readonly deps: WorkroomConversationDependencies) {
    this.#journal = deps.journal ?? null;
    this.#now = deps.now ?? Date.now;
  }
  #store() {
    if (this.#closed || this.#storageError) throw new Error('대화 기록 저장소를 이용할 수 없습니다. 실행 중인 터미널은 유지됩니다.');
    try { return this.#journal ??= new WorkroomConversationJournal(this.deps.appDataDir, undefined, undefined, {build: this.deps.build, alive: this.deps.processAlive}); }
    catch { this.#storageError = true; throw new Error('대화 기록 저장소를 확인하지 못했습니다. 기존 기록과 터미널은 유지됩니다.'); }
  }
  #startTicker() {
    const ms = this.deps.tickMs ?? 60_000;
    if (this.#ticker || this.#closed || ms <= 0) return;
    this.#ticker = setInterval(() => { void this.tick(); }, ms);
    (this.#ticker as { unref?: () => void }).unref?.();
  }
  /**
   * The liveness tick (w14): while sessions run, this boot says it is alive (a second sidecar must not detach its rows),
   * and up to four running sessions that have had input but no proven conversation are verified now — so a crash later
   * still knows which conversation each one was (R2). Nothing is launched; a quiet Mac spends nothing.
   */
  tick(): Promise<void> {
    if (this.#ticking) return this.#ticking;
    this.#ticking = (async () => {
      if (this.#closed || this.#storageError || !this.#journal) return;
      const running = this.deps.contexts().filter(c => !c.restricted && c.summary.state === 'running');
      if (!running.length) return;
      try { this.#journal.heartbeat(); } catch { return; }
      let budget = TICK_CAPTURES;
      for (const context of running) {
        if (budget <= 0 || this.#closed) break;
        if (!context.submitted || !['codex','claude'].includes(context.summary.agent)) continue;
        const row = this.#journal.forSession(context.summary.id);
        if (row && row.binding === 'verified') continue;
        budget--; await this.#capture(context);
      }
    })().catch(() => {}).finally(() => { this.#ticking = null; });
    return this.#ticking;
  }
  /** Same protected, versioned journal; submission payloads never enter it. */
  submissionJournal(){return this.#store();}
  correctionTaskSummary(targetId:string,memoryId:string){
    if(!this.#journal&&!existsSync(join(this.deps.appDataDir,'workroom-history-v1','history.sqlite')))return null;
    return this.#store().correctionTaskSummary(targetId,memoryId);
  }
  started(context: WorkroomSessionContext, logicalId?: string, previousSessionId?: string) {
    if(context.restricted){if(logicalId)throw new Error('제한 실행은 저장된 대화로 재개할 수 없습니다.');return;}
    try {
      const journal=this.#store(),prior=previousSessionId?journal.forSession(previousSessionId):null;
      const continued=prior?.providerConversationId&&prior.providerConversationId===context.providerConversationId
        &&prior.targetFingerprint===context.targetFingerprint&&prior.accountFingerprint===context.accountFingerprint;
      journal.started(context,logicalId??(continued?prior!.id:undefined));
      this.#startTicker();
    }
    catch (error) { if (logicalId) throw error; this.#storageError = true; }
  }
  async ended(context: WorkroomSessionContext) { await this.#capture(context,true); this.#captures.delete(context.summary.id); }
  /** The first input of a session (w14): a Codex row with none can never own a rollout (a joint derivation skips it). */
  input(sessionId: string) {
    if (this.#closed || this.#storageError || !this.#journal) return;
    try { this.#journal.markInput(sessionId); } catch { /* History is advisory; the terminal keeps running. */ }
  }
  async #capture(context: WorkroomSessionContext, force = false) {
    if (this.#closed || this.#storageError || context.restricted) return;
    const key = context.summary.id, old = this.#captures.get(key);
    if (old && !force && this.#now()-old.at < 15_000) return old.promise;
    if (!old && this.#captures.size >= 32) return;
    const promise = (async() => {
      const journal = this.#store();
      if (!journal.forSession(key)) journal.started(context);
      let providerId: string | null = null;
      // A Codex binding is durable evidence only from the thread lock a running process holds (or an id it was resumed
      // with). The folder and time-window match takes a neighbour's rollout when two Workrooms of one folder overlap and
      // only one spoke (w14 review); a row left unbound here is derived later, jointly with every row it could compete
      // with. Windows has no lsof: there a Codex row is left to that derivation too.
      const codexEvidence = context.summary.agent !== 'codex' || !!context.providerConversationId
        || context.processGroup !== undefined && (this.deps.platform ?? process.platform) !== 'win32';
      if (!context.restricted && ['codex','claude'].includes(context.summary.agent) && codexEvidence) {
        const binding = this.deps.resolveBinding ? await this.deps.resolveBinding(context)
          : (await resolveAiTerminalResume({agent:context.summary.agent,cwd:context.cwd,createdAt:context.summary.createdAt,
            ...(context.exitedAt?{exitedAt:context.exitedAt}:{}),...(context.providerConversationId?{conversationId:context.providerConversationId}:{}),
            ...(context.processGroup?{processGroup:context.processGroup}:{})},
            {home:homedir(),codexHome:context.providerHome,claudeConfigDir:context.providerHome,openFiles:processGroupOpenFiles,platform:this.deps.platform??process.platform}))?.conversationId ?? null;
        if (binding && savedWorkroomConversation(context.summary.agent,context.providerHome,context.cwd,binding)) providerId = binding;
      }
      if (!this.#closed) journal.observe(context,providerId);
    })().catch(() => { /* A failed binding probe never becomes verified evidence. */ });
    this.#captures.set(key,{at:this.#now(),promise});
    return promise;
  }
  async #validate(record: StoredWorkroomConversation, context: WorkroomSessionContext) {
    if (this.#closed || context.summary.targetId !== record.targetId || context.summary.agent !== record.agent
      || (context.summary.accountId??'host-default') !== record.accountId) throw new Error('원래 대화의 프로젝트 또는 CLI 계정 설정이 변경되었습니다.');
    // Said apart (R6): which of the two changed is what a person checks, and how often each happens is worth knowing.
    if (context.targetFingerprint !== record.targetFingerprint) throw new Error(AVAILABILITY_REASON['project-changed']!);
    if (context.accountFingerprint !== record.accountFingerprint) throw new Error(AVAILABILITY_REASON['account-changed']!);
    if (!record.restricted && !['codex','claude'].includes(record.agent)) throw new Error(AVAILABILITY_REASON.unsupported!);
    if (record.restricted || !record.providerConversationId) throw new Error('같은 대화의 저장된 기록을 아직 확인하지 못했습니다.');
    const path = savedWorkroomConversation(record.agent,context.providerHome,context.cwd,record.providerConversationId);
    if (!path) throw new Error('원래 프로젝트의 저장된 대화를 확인하지 못했습니다. 새 대화를 자동 시작하지 않습니다.');
    // Another row of the same provider conversation is running or being opened: exactly once per conversation.
    if (this.#store().providerBusy(record.providerConversationId,record.id)) throw new Error(WORKROOM_PROVIDER_BUSY);
    for (const current of this.deps.contexts()) {
      if (current.summary.state !== 'running' || current.summary.agent !== record.agent || current.accountFingerprint !== record.accountFingerprint) continue;
      const other = this.#store().forSession(current.summary.id);
      if (other?.providerConversationId === record.providerConversationId || !other?.providerConversationId && current.cwd === context.cwd) throw new Error('같은 프로젝트의 실행 중인 대화를 먼저 확인하세요. 기존 작업은 종료하지 않았습니다.');
    }
    await (this.deps.assertNoWriter ?? assertNoSavedWriter)(context,record.providerConversationId,path);
    if (this.#closed) throw new Error('대화 기록 관리가 종료 중입니다.');
  }
  #resumeResult(requestId: string): WorkroomHistoryResult {
    const journal = this.#store(), receipt = journal.receipt(requestId);
    if (!receipt) return {protocolVersion:WORKROOM_HISTORY_VERSION,storeInstanceId:journal.storeInstanceId,resume:{state:'not-recorded'}};
    const current = receipt.sessionId ? this.deps.contexts().find(c=>c.summary.id===receipt.sessionId) : undefined;
    return {protocolVersion:WORKROOM_HISTORY_VERSION,storeInstanceId:journal.storeInstanceId,
      resume:{state:receipt.state==='prepared'?'unknown':receipt.state,...(current?{session:current.summary}:{})}};
  }
  /** Host-only reads for the phone history surface (`workroomHistoryRemoteHost.ts`). */
  storeId() { return this.#store().storeInstanceId; }
  record(id: string): StoredWorkroomConversation | null { try { return this.#store().get(id); } catch { return null; } }
  resumeReceipt(requestId: string) { return this.#store().receipt(requestId); }
  /** A bound Community follow-up uses the same exact-conversation review, provider lease and durable receipt as history.
   * Never falls back to a new conversation or guesses the latest rollout of a folder. */
  async resumeThreadSession(sessionId:string,targetId:string,requestId:string,allowed:()=>boolean) {
    const journal=this.#store();
    await this.#reconcile(journal);
    const record=journal.forSession(sessionId);
    if(!record||record.sessionId!==sessionId||record.targetId!==targetId||!allowed())throw Error('원래 워크룸 대화와 프로젝트 권한을 확인하세요.');
    const old=journal.receipt(requestId);
    if(old)return this.#resumeResult(requestId).resume?.session;
    const base={protocolVersion:WORKROOM_HISTORY_VERSION,storeInstanceId:journal.storeInstanceId,conversationId:record.id,expectedRevision:record.revision};
    const reviewed=await this.perform({operation:'resume.review',...base},{allowed});
    if(!reviewed.review?.available)throw Error(reviewed.review?.reason||'원래 워크룸의 저장된 대화를 확인하지 못했습니다.');
    const result=await this.perform({operation:'resume.execute',...base,expectedRevision:reviewed.review.revision,reviewId:reviewed.review.id,requestId,cols:100,rows:28},{allowed});
    return result.resume?.state==='completed'?result.resume.session:undefined;
  }
  /**
   * One project's page for a phone. Rows that are not proven yet are checked first, within a bound (w14 review): a
   * phone says 「이어 열기」 from a check of the saved conversation, never from the row alone. A check may bind a row
   * (its revision moves), so the page is read again before it is answered.
   */
  async listTarget(targetId: string, before: string | undefined, limit: number) {
    const journal = this.#store();
    await this.#reconcile(journal);
    const page = journal.listTarget(targetId, false, before, limit);
    let probes = REMOTE_LIST_PROBE_BUDGET, moved = false;
    for (const record of page.records) {
      if (probes <= 0) break;
      if (this.availability(record) !== 'check') continue;
      probes--;
      try { await this.#probe(journal, record); } catch { /* a failed check proves nothing */ }
      moved = true;
    }
    return moved ? { records: page.records.map(record => this.record(record.id) ?? record), nextBefore: page.nextBefore } : page;
  }
  /** The ids of an offer and the projects they belong to (host-only): who may close it, even after a newer one. */
  restartOfferTargets(offerId: string): { state: string; targetIds: string[] } | null {
    const journal = this.#store(), offer = journal.offer(offerId);
    if (!offer) return null;
    return { state: offer.state, targetIds: offer.conversationIds.map(id => this.record(id)?.targetId).filter((id): id is string => !!id) };
  }
  async #reconcile(journal: WorkroomConversationJournal) {
    const contexts = this.deps.contexts().filter(c=>!c.restricted);
    // At most four provider probes per inventory, never all saved transcripts.
    let remaining = 4;
    for (const c of contexts) {
      if (!journal.forSession(c.summary.id)) journal.started(c);
      const current=journal.forSession(c.summary.id)!;
      if(current.sessionId===c.summary.id&&current.state!==(c.summary.state==='running'?'running':'ended')) journal.observe(c,null);
      if (remaining > 0 && journal.forSession(c.summary.id)?.binding !== 'verified') { remaining--; await this.#capture(c); }
    }
  }
  /** `allowed` (host-only, never on the wire) is re-checked right before a resume launches: a remote grant revoked
   *  between review and launch refuses the launch, and the receipt says 'rejected'. */
  async perform(value: unknown, options: { allowed?: () => boolean } = {}): Promise<WorkroomHistoryResult> {
    const r = normalizeWorkroomHistoryRequest(value), journal = this.#store();
    if (r.operation !== 'list' && r.operation !== 'restart.list' && r.storeInstanceId !== journal.storeInstanceId) throw new Error('대화 기록의 저장소가 달라졌습니다. 원래 기기의 기록을 다시 확인하세요.');
    const base = {protocolVersion:WORKROOM_HISTORY_VERSION,storeInstanceId:journal.storeInstanceId};
    if (r.operation === 'list') {
      await this.#reconcile(journal);
      const page = journal.list(r.archived,r.before);
      // `detail` (w14 review): each row says whether it can be opened, from what this Mac already knows — no probe (the
      // panel lists every 15 s). A row nobody checked yet reads `check`; its review checks it and keeps a negative answer.
      const availability = r.detail ? Object.fromEntries(page.records.map(record => [record.id, this.availability(record)])) : undefined;
      return {...base,records:page.records.map(publicWorkroomConversation),nextBefore:page.nextBefore,...(availability?{availability}:{})};
    }
    if (r.operation === 'resume.status') return this.#resumeResult(r.requestId);
    if (r.operation === 'rename' || r.operation === 'archive' || r.operation === 'unarchive') {
      return {...base,record:publicWorkroomConversation(journal.mutate(r.conversationId,r.expectedRevision,r.requestId,r.operation,r.title))};
    }
    if (r.operation === 'resume.review') {
      const record = journal.get(r.conversationId);
      if (record.revision !== r.expectedRevision) throw new Error('대화 상태가 변경되었습니다. 목록을 다시 확인하세요.');
      for (const [id,review] of this.#reviews) if (review.expires <= this.#now()) this.#reviews.delete(id);
      for (const [id,review] of this.#reviews) if (review.record.id===record.id) this.#reviews.delete(id);
      let reason = '', available = true, reviewed = record;
      try {
        if ((this.deps.platform??process.platform)!=='darwin') throw new Error('앱 재시작 후 이어 열기는 현재 Mac에서 지원합니다.');
        if (record.state==='running') throw new Error(AVAILABILITY_REASON.running!);
        if (record.pendingResumeId) throw new Error(journal.receipt(record.pendingResumeId)?.state==='prepared'?AVAILABILITY_REASON['in-flight']!:WORKROOM_RESUME_UNSETTLED_REASON);
        if (!record.restricted && !['codex','claude'].includes(record.agent)) throw new Error(AVAILABILITY_REASON.unsupported!);
        let context: WorkroomSessionContext;
        try { context = await this.deps.prepare(record); }
        catch (error) { this.#remember(record,'unprepared'); throw error; }
        // A Codex row that never learned its thread (R2): exactly one rollout of its folder and lifetime — and of no other
        // row that could own it — binds it now.
        if (!record.providerConversationId && record.agent==='codex' && !record.restricted) {
          const derived = await this.#deriveCodex(journal,record,context,Number.POSITIVE_INFINITY);
          if (derived !== 'ready') throw new Error(AVAILABILITY_REASON[derived] ?? '같은 대화의 저장된 기록을 아직 확인하지 못했습니다.');
          reviewed = journal.get(record.id);
        }
        // A saved conversation that is not there is kept as `unsaved` for this revision: the next list (Mac, phone, restart
        // offer) says why instead of offering 「이어 열기」 again (w14 review).
        if (reviewed.providerConversationId && !reviewed.restricted && context.targetFingerprint===reviewed.targetFingerprint && context.accountFingerprint===reviewed.accountFingerprint
          && !savedWorkroomConversation(reviewed.agent,context.providerHome,context.cwd,reviewed.providerConversationId)) journal.recordBindingCheck(reviewed.id,reviewed.revision,'unsaved');
        await this.#validate(reviewed,context);
        this.#remember(reviewed,'ready');
      } catch (error) { available = false; reason = workroomHistoryErrorMessage(error); }
      if (this.#reviews.size >= 64) throw new Error('대화 재개 검토가 너무 많습니다. 잠시 후 다시 확인하세요.');
      const id = randomUUID(), expires = this.#now()+60_000;
      if (available) this.#reviews.set(id,{record:reviewed,expires});
      return {...base,review:{id,expiresAt:expires,available,reason,revision:reviewed.revision}};
    }
    if (r.operation === 'restart.list') return {...base,restart:await this.#restartList(journal)};
    // Answers what is current afterwards: an offer a newer restart superseded had its rows taken out of that one, and what
    // is left of it (rows nobody closed) is shown — never the rows just closed (w14 review).
    if (r.operation === 'restart.dismiss') { journal.dismissOffer(r.offerId,r.expectedRevision,r.requestId); return {...base,restart:await this.#restartList(journal)}; }
    if (r.operation === 'resume.settle') return {...base,record:publicWorkroomConversation(journal.settleResume(r.conversationId,r.expectedRevision,r.requestId))};
    if (r.operation !== 'resume.execute') throw new Error('지원하지 않는 대화 기록 요청입니다.');
    const fingerprint = createHash('sha256').update(JSON.stringify(r)).digest('hex');
    const old = journal.receipt(r.requestId,fingerprint);
    if (old) return this.#executions.get(r.requestId) ?? this.#resumeResult(r.requestId);
    const review = this.#reviews.get(r.reviewId);
    if (!review || review.expires <= this.#now() || review.record.id !== r.conversationId || review.record.revision !== r.expectedRevision) throw new Error('대화 재개 검토가 만료되었거나 변경되었습니다. 다시 확인하세요.');
    await this.#validate(review.record,await this.deps.prepare(review.record));
    if(this.#reviews.get(r.reviewId)!==review||review.expires<=this.#now()) throw new Error('대화 재개 검토가 변경되었습니다. 다시 확인하세요.');
    if(options.allowed&&!options.allowed()) throw new Error('원격 대화 기록 권한이 변경되었습니다.');
    const raced = journal.receipt(r.requestId,fingerprint);
    if (raced) return this.#executions.get(r.requestId) ?? this.#resumeResult(r.requestId);
    // No await between this durable CAS reservation and retaining the in-flight promise.
    const request = journal.prepareResume(r.conversationId,r.expectedRevision,r.requestId,r);
    if (request.state !== 'prepared') return this.#resumeResult(r.requestId);
    let started = false;
    const operation = (async() => {
      try {
        await this.deps.launch(review.record,r.requestId,r.cols,r.rows,{
          logicalConversationId:review.record.id, resume:{agent:review.record.agent as 'codex'|'claude',conversationId:review.record.providerConversationId!},
          accountId:review.record.accountId,cwd:(await this.deps.prepare(review.record)).cwd,
          validate:async context=>{
            if(options.allowed&&!options.allowed()) throw new Error('원격 대화 기록 권한이 변경되었습니다.');
            await this.#validate(review.record,context);
            if(options.allowed&&!options.allowed()) throw new Error('원격 대화 기록 권한이 변경되었습니다.');
          },launching:()=>{started=true;},
        }).then(response=>{
          if (!response.session) throw new Error('재개한 터미널의 결과를 확인하지 못했습니다.');
          journal.finishResume(r.requestId,'completed',response.session.id);
        });
      } catch {
        journal.finishResume(r.requestId,started?'unknown':'rejected');
      } finally { this.#reviews.delete(r.reviewId); }
      return this.#resumeResult(r.requestId);
    })();
    this.#executions.set(r.requestId,operation);
    void operation.finally(()=>this.#executions.delete(r.requestId)).catch(()=>{});
    return operation;
  }
  /**
   * Whether a conversation can be opened again, from what this Mac already knows (no probe, no file read).
   * The phone's history rows and the restart offer read the same answer (R3: one test, not a stricter one per surface).
   * `ready` comes only from a check of this Mac now — the saved conversation and the project and CLI account fingerprints
   * (w14 review): a verified row whose credentials file was rewritten since must not be counted on 「N개 이어 열기」.
   */
  availability(record: StoredWorkroomConversation): WorkroomRestartAvailability {
    const journal = this.#store();
    if (!['codex','claude'].includes(record.agent)) return 'unsupported';
    if (record.pendingResumeId) return journal.receipt(record.pendingResumeId)?.state === 'prepared' ? 'in-flight' : 'pending';
    if (record.state === 'running') return 'running';
    if (record.providerConversationId && journal.providerBusy(record.providerConversationId, record.id)) return 'open-elsewhere';
    const cached = journal.bindingCheck(record.id);
    if (cached && cached.revision === record.revision) return cached.outcome;
    const probed = this.#probedOutcome(record);
    if (probed) return probed;
    if (record.providerConversationId) return 'check';
    return this.#codexBounds(journal, record) ? 'check' : 'legacy';
  }
  #probedOutcome(record: StoredWorkroomConversation): WorkroomRestartAvailability | null {
    const key = record.id + ':' + record.revision, entry = this.#probed.get(key);
    if (!entry) return null;
    if (this.#now() - entry.at > PROBE_TTL_MS) { this.#probed.delete(key); return null; }
    return entry.outcome;
  }
  #remember(record: Pick<StoredWorkroomConversation, 'id' | 'revision'>, outcome: WorkroomRestartAvailability) {
    const key = record.id + ':' + record.revision;
    this.#probed.delete(key); this.#probed.set(key, { outcome, at: this.#now() });
    while (this.#probed.size > PROBE_MEMORY) this.#probed.delete(this.#probed.keys().next().value!);
  }
  /** A review that is still valid holds its row's revision: no probe may move it before the execute (w14 review). */
  #liveReview(id: string) {
    for (const review of this.#reviews.values()) if (review.record.id === id && review.expires > this.#now()) return true;
    return false;
  }
  /**
   * The Codex search window of a row: its start to its exit (or its boot's last heartbeat + 60 s), never past the boot
   * that opened after it was last seen (a rollout begun then belongs to a session of that boot).
   */
  #codexBounds(journal: WorkroomConversationJournal, record: StoredWorkroomConversation) {
    if (record.agent !== 'codex') return null;
    const created = Date.parse(record.createdAt), boot = journal.boot(record.bootId);
    const upper = record.exitedAt ? Date.parse(record.exitedAt) : boot ? Date.parse(boot.lastSeenAt) + 60_000 : NaN;
    if (!Number.isFinite(created) || !Number.isFinite(upper)) return null;
    let to = upper + ROLLOUT_SLACK_MS;
    if (record.bootId !== journal.bootId) {
      const next = journal.bootOpenedAfter(boot?.lastSeenAt ?? record.exitedAt ?? record.updatedAt, record.bootId);
      if (next) to = Math.min(to, Date.parse(next));
    }
    return { from: created - ROLLOUT_SLACK_MS, to };
  }
  /**
   * Which Codex conversation a row ran, when it never learned its thread — derived jointly (w14 review). A rollout is this
   * row's only when it is the one candidate in this row's lifetime and no other Codex row of the project and CLI account
   * that never learned its thread (and may have had input) was alive when it began. Otherwise every row involved is
   * `ambiguous`: the one that sent the first request is never told it ended before one, and a row that never sent one never
   * takes another's conversation. A row whose session never got input is `unsaved` and competes with nobody.
   */
  async #deriveCodex(journal: WorkroomConversationJournal, record: StoredWorkroomConversation, context: WorkroomSessionContext, budgetBytes: number): Promise<WorkroomRestartAvailability> {
    if (journal.sessionHadInput(record.sessionId) === false) { journal.recordBindingCheck(record.id, record.revision, 'unsaved'); return 'unsaved'; }
    const bounds = this.#codexBounds(journal, record);
    if (!bounds) { journal.recordBindingCheck(record.id, record.revision, 'legacy'); return 'legacy'; }
    const found = codexRolloutCandidates({codexHome: context.providerHome, cwd: context.cwd, fromMs: bounds.from, toMs: bounds.to,
      ...(Number.isFinite(budgetBytes) ? {budgetBytes} : {budgetBytes: 32 * 1024 * 1024})});
    if (!found.complete) return 'check';
    const mine = found.rollouts.filter(rollout => !journal.providerClaimed(rollout.id, record.id));
    if (mine.length > 1) { journal.recordBindingCheck(record.id, record.revision, 'ambiguous'); return 'ambiguous'; }
    const only = mine[0];
    if (!only || !savedWorkroomConversation('codex', context.providerHome, context.cwd, only.id)) { journal.recordBindingCheck(record.id, record.revision, 'unsaved'); return 'unsaved'; }
    for (const other of journal.unboundCodexRows(record.targetId, record.accountId, new Date(only.at + ROLLOUT_SLACK_MS).toISOString())) {
      if (other.id === record.id || other.restricted || journal.sessionHadInput(other.sessionId) === false) continue;
      // A row with no boot record (before this release) is bounded by its last change: it was dead by then.
      const window = this.#codexBounds(journal, other) ?? { from: Date.parse(other.createdAt) - ROLLOUT_SLACK_MS, to: Date.parse(other.updatedAt) + ROLLOUT_SLACK_MS };
      if (only.at >= window.from && only.at <= window.to) { journal.recordBindingCheck(record.id, record.revision, 'ambiguous'); return 'ambiguous'; }
    }
    // Synchronous from the check to the bind: a review that started meanwhile keeps its revision.
    if (this.#liveReview(record.id)) return 'check';
    const bound = journal.bindDerived(record.id, record.revision, only.id);
    this.#remember(bound, 'ready');
    return 'ready';
  }
  /**
   * One bounded probe of a row not proven now: check this Mac can prepare its project and account, that both are the
   * ones it ran with, and that its conversation is saved — binding it when it was not yet. Never launches anything. A
   * row with a live review is left alone (binding would move the revision its execute names).
   */
  async #probe(journal: WorkroomConversationJournal, record: StoredWorkroomConversation): Promise<WorkroomRestartAvailability> {
    if (this.#liveReview(record.id)) return 'check';
    let context: WorkroomSessionContext;
    // Unregistered, a removed CLI account, a moved folder: not openable now — said, not counted (the offer can finish).
    try { context = await this.deps.prepare(record); } catch { this.#remember(record, 'unprepared'); return 'unprepared'; }
    const current = this.record(record.id);
    if (!current || current.revision !== record.revision) return 'check';
    if (context.targetFingerprint !== record.targetFingerprint) { this.#remember(record, 'project-changed'); return 'project-changed'; }
    if (context.accountFingerprint !== record.accountFingerprint) { this.#remember(record, 'account-changed'); return 'account-changed'; }
    if (!record.providerConversationId) return this.#deriveCodex(journal, record, context, 8 * 1024 * 1024);
    if (!savedWorkroomConversation(record.agent, context.providerHome, context.cwd, record.providerConversationId)) {
      journal.recordBindingCheck(record.id, record.revision, 'unsaved'); return 'unsaved';
    }
    if (record.binding === 'verified') { this.#remember(record, 'ready'); return 'ready'; }
    if (this.#liveReview(record.id)) return 'check';
    this.#remember(journal.bindDerived(record.id, record.revision, record.providerConversationId), 'ready');
    return 'ready';
  }
  /**
   * The offer of the last restart (w14): what was running when the previous sidecar ended, and whether each can be
   * opened. Rows of a boot that ended since the last look are detached first. It is finished once nothing in it can be
   * acted on and something in it was opened again. An offer of sessions none of which could be reopened (Hermes, agy,
   * nothing saved) stays until a person closes it, so they learn once why those sessions are gone.
   */
  async #restartList(journal: WorkroomConversationJournal): Promise<WorkroomRestartOffer | null> {
    journal.detachStale();
    // Cold resume is a Mac feature (the review refuses elsewhere): no banner that could only fail. The offer is kept.
    if ((this.deps.platform ?? process.platform) !== 'darwin') return null;
    const offer = journal.restartOffer();
    if (!offer) return null;
    let probes = RESTART_PROBE_BUDGET;
    const rows: WorkroomRestartRow[] = [];
    for (const id of offer.conversationIds) {
      let record = this.record(id);
      if (!record || record.archived || record.restricted) continue;
      let availability = this.availability(record);
      if (availability === 'check' && probes > 0) {
        probes--;
        try { availability = await this.#probe(journal, record); } catch { availability = 'check'; }
        record = this.record(id) ?? record;
      }
      rows.push({ id: record.id, targetId: record.targetId, agent: record.agent, title: record.title, accountLabel: record.accountLabel,
        createdAt: record.createdAt, updatedAt: record.updatedAt, revision: record.revision, availability, bypass: journal.sessionBypass(record.sessionId) });
    }
    const reopened = rows.some(row => row.availability === 'running' || row.availability === 'open-elsewhere');
    if (!rows.some(row => workroomRestartActionable(row.availability)) && (reopened || !rows.length)) { journal.finishOffer(offer.offerId); return null; }
    return { offerId: offer.offerId, revision: offer.revision, createdAt: offer.createdAt, update: offer.update, more: offer.more, rows };
  }
  async shutdown() {
    this.#closed = true;
    if (this.#ticker) { clearInterval(this.#ticker); this.#ticker = undefined; }
    await Promise.allSettled([...this.#captures.values()].map(c=>c.promise).concat([...this.#executions.values()].map(p=>p.then(()=>{}))));
    this.#reviews.clear(); this.#captures.clear(); this.#journal?.close();
  }
}
