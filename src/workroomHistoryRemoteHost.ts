import { createHash } from 'node:crypto';
import { HOST_CLI_ACCOUNT_ID } from './cliAccountProtocol';
import { WORKROOM_HISTORY_VERSION, WORKROOM_RESTART_AVAILABILITY, workroomHistoryErrorMessage, workroomRestartRunnable, type WorkroomHistoryResult, type WorkroomRestartAvailability, type WorkroomRestartOffer } from './workroomConversationProtocol';
import type { StoredWorkroomConversation, WorkroomResumeReceipt } from './workroomConversationJournal';
import {
  REMOTE_HISTORY_PAGE_LIMIT, REMOTE_HISTORY_RESULT_BYTES, REMOTE_RESTART_PARTIAL_DISMISS, isRemoteHistoryAction, normalizeRemoteHistoryRequest, normalizeRemoteHistoryResult,
  type RemoteHistoryResult, type RemoteHistoryRow, type RemoteHistoryWhy, type RemoteRestartAvailability, type RemoteRestartOffer, type RemoteRestartRow,
} from './workroomHistoryRemoteProtocol';

// Compile-time: every availability the Mac can answer has a phone name (the phone's list is written out on purpose).
const MAC_AVAILABILITY_ON_PHONE: readonly RemoteRestartAvailability[] = WORKROOM_RESTART_AVAILABILITY;
void MAC_AVAILABILITY_ON_PHONE;

/** The host-only face of `WorkroomConversationService` this module needs. */
export interface RemoteHistoryService {
  storeId(): string;
  listTarget(targetId: string, before: string | undefined, limit: number): Promise<{ records: StoredWorkroomConversation[]; nextBefore: string | null }>;
  record(id: string): StoredWorkroomConversation | null;
  resumeReceipt(requestId: string): WorkroomResumeReceipt | null;
  perform(value: unknown, options?: { allowed?: () => boolean }): Promise<WorkroomHistoryResult>;
  /** The Mac's own answer (w14): one test for the Mac rows, the restart offer and this list. Absent: the old rule. */
  availability?(record: StoredWorkroomConversation): WorkroomRestartAvailability;
  /** An offer's state and the projects of its rows, even after a newer restart superseded it (who may close it). */
  restartOfferTargets?(offerId: string): { state: string; targetIds: string[] } | null;
}
export interface RemoteHistoryAccess {
  canResume: boolean; accountSelect: boolean; allowed: () => boolean;
  /** False only for a phone without ‘워크룸 대화 기록 보기’ asking for the restart offer: it learns how many sessions of
   *  its projects a restart ended (no titles, no rows) and which permission would show them (w14 review). */
  canRead?: boolean;
  /** Host-only, never on the wire: the runtime targets this device may use now. A status read names one project, but the
   *  device's own receipt may belong to another of its projects (the picker moved, or the controlIds were reissued). */
  targets?: ReadonlySet<string>;
  /** Host-only, never on the wire: this device's own control id for each runtime target it may use. The restart offer
   *  names its rows by these, and a row whose project is not here is left out (w14). */
  controlIds?: ReadonlyMap<string, string>;
}

const NOT_FOUND = '이 기기에 허용된 프로젝트의 대화 기록을 찾지 못했습니다. 목록을 다시 확인하세요.';
const REVIEW_STALE = '대화 재개 검토가 만료되었거나 변경되었습니다. 다시 확인하세요.';
const RESUME_NOT_PREPARED = '이 Mac에서 대화를 이어 열 준비를 하지 못했습니다. 원래 프로젝트 폴더와 CLI 설정을 이 Mac에서 확인하세요.';
const HISTORY_FAILED = '이 Mac에서 대화 기록 요청을 처리하지 못했습니다. 기존 기록은 유지됩니다.';
const READ_REQUIRED = 'Mac에서 이 기기의 ‘워크룸 대화 기록 보기’ 권한을 허용하세요.';
/** Errors leave this Mac only as Korean text without a path, code or provider detail. `prepareHistoryContext` alone can
 *  throw Node's `ENOENT: … realpath '<absolute project path>'`; the relay would carry that message to the phone verbatim. */
function publicHistoryError(error: unknown, action: unknown): Error {
  const safe = workroomHistoryErrorMessage(error);
  if (error instanceof Error && safe === error.message) return new Error(safe);
  return new Error(action === 'history.resume.execute' || action === 'history.resume.review' ? RESUME_NOT_PREPARED : HISTORY_FAILED);
}

/**
 * Phone history requests answered by this Mac. Every call names one authorized project (`targetId` is the runtime id
 * the gateway already checked against the grant); a conversation of any other project is "not found", whatever id the
 * phone sends. Resume reuses the local review → execute → status path unchanged — no bypass, no new launch path, and
 * an unknown outcome is answered with status only. Receipts are namespaced by the requesting owner
 * (`device:<host>:<controller>`), so a resume request id from one phone means nothing to another. The owner is one
 * pairing, not one phone: a new QR claim is a new relay controller, so the same phone paired again asks under a new owner.
 */
export function createRemoteWorkroomHistoryHost(service: RemoteHistoryService, now: () => number = Date.now) {
  const reviews = new Map<string, { owner: string; targetId: string; conversationId: string; expires: number }>();
  // Executes of this process still on their way to (or through) the receipt, by host request id.
  const running = new Map<string, number>();
  const hostRequestId = (owner: string, id: string) => 'rh_' + createHash('sha256').update(owner + '\0' + id).digest('base64url').slice(0, 43);
  const ownRecord = (id: string | undefined, targetId: string) => {
    const record = id ? service.record(id) : null;
    if (!record || record.targetId !== targetId || record.restricted) throw new Error(NOT_FOUND);
    return record;
  };
  const accountAllowed = (record: StoredWorkroomConversation, access: RemoteHistoryAccess) => record.accountId === HOST_CLI_ACCOUNT_ID || access.accountSelect;
  const requireResume = (record: StoredWorkroomConversation, access: RemoteHistoryAccess) => {
    if (!access.canResume) throw new Error('Mac에서 이 기기의 ‘저장된 대화 이어 열기’ 권한을 허용하세요.');
    if (!accountAllowed(record, access)) throw new Error('이 대화는 다른 CLI 계정으로 열렸습니다. Mac에서 이 기기의 CLI 계정 선택 권한을 허용해야 이어 열 수 있습니다.');
  };
  // `resumable` is the Mac's own answer (R3): a Claude row the sidecar ended before its exit capture is opened by the Mac
  // review from its saved transcript, so the phone no longer says 「이어 열 수 없음」 for it. A tap still goes through review.
  const openable = (r: StoredWorkroomConversation) => {
    if (service.availability) { try { return workroomRestartRunnable(service.availability(r)); } catch { return false; } }
    return r.binding === 'verified' && r.state !== 'running' && r.pendingResumeId === null && (r.agent === 'codex' || r.agent === 'claude');
  };
  const macAvailability = (r: StoredWorkroomConversation): WorkroomRestartAvailability | null => {
    if (!service.availability) return null;
    try { return service.availability(r); } catch { return null; }
  };
  /** One phone answer for a row (w14): the Mac's own unless it could open — then the phone's grant decides. */
  const phoneAvailability = (r: StoredWorkroomConversation, mac: WorkroomRestartAvailability, access: RemoteHistoryAccess): RemoteRestartAvailability =>
    !workroomRestartRunnable(mac) ? mac : !access.canResume ? 'grant' : !accountAllowed(r, access) ? 'account' : mac;
  const row = (r: StoredWorkroomConversation, access: RemoteHistoryAccess, detail = false): RemoteHistoryRow => {
    const resumable = access.canResume && accountAllowed(r, access) && openable(r);
    const listed: RemoteHistoryRow = { id: r.id, title: r.title, agent: r.agent, state: r.state, updatedAt: r.updatedAt, revision: r.revision, resumable };
    if (!detail) return listed;
    // Only a phone that asked (it saw `workroom-restart-v1`) gets the eighth key; an old phone's normaliser counts seven.
    const mac = macAvailability(r);
    if (!mac) return listed;
    if (resumable) return { ...listed, why: null };
    const why = phoneAvailability(r, mac, access);
    // Not openable here, yet the Mac's answer says it could be (a state between two reads): say nothing rather than guess.
    return why === 'ready' || why === 'check' ? listed : { ...listed, why: why as RemoteHistoryWhy };
  };
  /**
   * The restart offer as this phone may see it: rows of projects it may use, named by its own control ids. Cut to the
   * reply budget from the end (`more`); `complete` says no row was left out for permission. `closable` is the Mac's
   * answer whether this phone may close it for everyone (it may resume and sees every row). A phone that may not read
   * history learns only how many sessions of its projects there are (`unlisted`), never their titles.
   */
  const restartFor = (offer: WorkroomRestartOffer | null | undefined, access: RemoteHistoryAccess): RemoteRestartOffer | null => {
    if (!offer) return null;
    const rows: RemoteRestartRow[] = [];
    let complete = true, unlisted = 0;
    for (const offered of offer.rows) {
      const project = access.controlIds?.get(offered.targetId), record = service.record(offered.id);
      if (!project || !record || record.targetId !== offered.targetId) { complete = false; continue; }
      if (access.canRead === false) { unlisted++; continue; }
      rows.push({ id: offered.id, project, title: offered.title, agent: offered.agent, availability: phoneAvailability(record, offered.availability, access),
        bypass: offered.bypass, revision: offered.revision, createdAt: offered.createdAt, updatedAt: offered.updatedAt });
    }
    if (access.canRead === false) return unlisted ? { offerId: offer.offerId, revision: offer.revision, update: offer.update, more: false, complete: false, closable: false, unlisted, rows: [] } : null;
    if (!rows.length) return null;
    const answer: RemoteRestartOffer = { offerId: offer.offerId, revision: offer.revision, update: offer.update, more: offer.more, complete,
      closable: access.canResume && complete, unlisted: 0, rows };
    while (answer.rows.length > 1 && new TextEncoder().encode(JSON.stringify({ restart: answer })).length > REMOTE_HISTORY_RESULT_BYTES) {
      answer.rows.pop(); answer.more = true;
    }
    return answer;
  };
  const currentOffer = async () => (await service.perform({ protocolVersion: WORKROOM_HISTORY_VERSION, operation: 'restart.list' })).restart;
  // The new session's id comes from the durable receipt, so a status read after a restart still names it.
  const resumeOf = (result: WorkroomHistoryResult, requestId: string): RemoteHistoryResult => {
    const state = result.resume?.state ?? 'unknown', sessionId = state === 'completed' ? service.resumeReceipt(requestId)?.sessionId : null;
    return { resume: { state, ...(sessionId ? { sessionId } : {}) } };
  };
  // «not-recorded» lets the phone forget its only handle and say the conversation never opened, so it is said only when
  // this Mac can prove it for the asking pairing: no durable receipt for this owner and id, and no execute of it still
  // running here. Receipts are never deleted. Anything this Mac cannot tell is «unknown», which the phone keeps and never
  // re-executes. This Mac cannot see a request sent over an earlier pairing of the same phone — the phone keeps the
  // pairing in its pending row and does not believe «not-recorded» across pairings (remoteWorkroomHistoryClient.ts).
  const statusFor = async (owner: string, targetId: string, resumeRequestId: string, access: RemoteHistoryAccess): Promise<RemoteHistoryResult> => {
    const id = hostRequestId(owner, resumeRequestId), receipt = service.resumeReceipt(id);
    if (!receipt) return { resume: { state: running.has(id) ? 'unknown' : 'not-recorded' } };
    // The receipt is this device's own. Its state is told only for a project the device may use now; a conversation the
    // journal cannot read at the moment (`record()` swallows its errors) is not evidence of anything.
    const record = service.record(receipt.conversationId);
    if (!record || record.targetId !== targetId && !access.targets?.has(record.targetId)) return { resume: { state: 'unknown' } };
    return resumeOf(await service.perform({ protocolVersion: WORKROOM_HISTORY_VERSION, operation: 'resume.status', storeInstanceId: service.storeId(), requestId: id }), id);
  };

  const answer = async (value: { action: unknown; history: unknown }, targetId: string, owner: string, access: RemoteHistoryAccess): Promise<RemoteHistoryResult> => {
    const action = value.action;
    if (!isRemoteHistoryAction(action)) throw new Error('지원하지 않는 대화 기록 요청입니다.');
    const request = normalizeRemoteHistoryRequest(action, value.history);
    for (const [id, review] of reviews) if (review.expires <= now()) reviews.delete(id);
    if (!access.allowed()) throw new Error('대화 기록 권한이 변경되었습니다.');
    if (access.canRead === false && action !== 'history.restart') throw new Error(READ_REQUIRED);

    if (action === 'history.list') {
      if (request.before) ownRecord(request.before, targetId);
      const page = await service.listTarget(targetId, request.before, REMOTE_HISTORY_PAGE_LIMIT);
      const records = page.records.map(r => row(r, access, request.detail === true));
      let nextBefore = page.nextBefore;
      // Long titles are three bytes a character; keep the page within the reply and continue from the last row kept.
      while (records.length > 1 && new TextEncoder().encode(JSON.stringify({ records, nextBefore })).length > REMOTE_HISTORY_RESULT_BYTES) {
        records.pop(); nextBefore = records.at(-1)!.id;
      }
      return normalizeRemoteHistoryResult(action, { records, nextBefore });
    }
    if (action === 'history.resume.status') return normalizeRemoteHistoryResult(action, await statusFor(owner, targetId, request.resumeRequestId!, access));
    // The restart offer (w14) is about all of this device's projects, whichever one the request came through.
    if (action === 'history.restart') return normalizeRemoteHistoryResult(action, { restart: restartFor(await currentOffer(), access) });
    if (action === 'history.restart.dismiss') {
      if (!access.canResume) throw new Error('Mac에서 이 기기의 ‘저장된 대화 이어 열기’ 권한을 허용하세요.');
      const current = await currentOffer();
      // Closing is for every window and phone, so a phone that cannot see every row it closes may not do it. An offer a
      // newer restart superseded closes the rows it carried into that one (the rows this phone saw) — nothing else.
      let targets: readonly string[];
      if (current && current.offerId === request.offerId) targets = current.rows.map(r => r.targetId);
      else {
        const stale = service.restartOfferTargets?.(request.offerId!);
        // Already gone (closed, finished, expired): nothing is closed, and the phone is told what is current.
        if (!stale || stale.state !== 'superseded') return normalizeRemoteHistoryResult(action, { restart: restartFor(current, access) });
        targets = stale.targetIds;
      }
      if (targets.some(id => !access.controlIds?.has(id))) throw new Error(REMOTE_RESTART_PARTIAL_DISMISS);
      const result = await service.perform({ protocolVersion: WORKROOM_HISTORY_VERSION, operation: 'restart.dismiss', storeInstanceId: service.storeId(),
        offerId: request.offerId, expectedRevision: request.expectedRevision, requestId: hostRequestId(owner, request.dismissRequestId!) });
      return normalizeRemoteHistoryResult(action, { restart: restartFor(result.restart, access) });
    }

    if (action === 'history.resume.review') {
      const record = ownRecord(request.conversationId, targetId);
      requireResume(record, access);
      const result = await service.perform({ protocolVersion: WORKROOM_HISTORY_VERSION, operation: 'resume.review', storeInstanceId: service.storeId(),
        conversationId: record.id, expectedRevision: request.expectedRevision });
      const review = result.review!;
      for (const [id, entry] of reviews) if (entry.owner === owner && entry.conversationId === record.id) reviews.delete(id);
      if (review.available) {
        if (reviews.size >= 256) throw new Error('대화 재개 검토가 너무 많습니다. 잠시 후 다시 확인하세요.');
        reviews.set(review.id, { owner, targetId, conversationId: record.id, expires: review.expiresAt });
      }
      return normalizeRemoteHistoryResult(action, { review });
    }

    // history.resume.execute
    const id = hostRequestId(owner, request.resumeRequestId!);
    running.set(id, (running.get(id) ?? 0) + 1);
    try { return await execute(request, id, targetId, owner, access); }
    finally { const left = running.get(id)! - 1; if (left > 0) running.set(id, left); else running.delete(id); }
  };
  const execute = async (request: ReturnType<typeof normalizeRemoteHistoryRequest>, id: string, targetId: string, owner: string, access: RemoteHistoryAccess): Promise<RemoteHistoryResult> => {
    const record = ownRecord(request.conversationId, targetId);
    if (!service.resumeReceipt(id)) {
      // First attempt: the review must be this device's, for this project and conversation, and still fresh.
      requireResume(record, access);
      const review = reviews.get(request.reviewId!);
      if (!review || review.owner !== owner || review.targetId !== targetId || review.conversationId !== record.id || review.expires <= now()) throw new Error(REVIEW_STALE);
    } else if (service.resumeReceipt(id)!.conversationId !== record.id) throw new Error(NOT_FOUND);
    // A replay (same device, same request id) is answered from the durable receipt: the service never launches twice.
    const result = await service.perform({ protocolVersion: WORKROOM_HISTORY_VERSION, operation: 'resume.execute', storeInstanceId: service.storeId(),
      conversationId: record.id, expectedRevision: request.expectedRevision, reviewId: request.reviewId, requestId: id, cols: request.cols, rows: request.rows },
      { allowed: access.allowed });
    return normalizeRemoteHistoryResult('history.resume.execute', resumeOf(result, id));
  };
  return async (value: { action: unknown; history: unknown }, targetId: string, owner: string, access: RemoteHistoryAccess): Promise<RemoteHistoryResult> => {
    try { return await answer(value, targetId, owner, access); }
    catch (error) { throw publicHistoryError(error, value.action); }
  };
}
