import type { AiTerminalAgent, AiTerminalSummary } from './aiTerminalProtocol';
import type { MobileWorkspaceRequest, MobileWorkspaceResult } from './mobileWorkspaceProtocol';
import {
  assertPendingRemoteHistoryRoom, clearPendingRemoteHistoryResume, normalizeRemoteHistoryResult, remoteHistorySentEarlier, savePendingRemoteHistoryResume,
  type PendingRemoteHistoryResume, type RemoteHistoryAction, type RemoteHistoryRequest, type RemoteHistoryResult, type RemoteHistoryRow,
} from './workroomHistoryRemoteProtocol';

/** Phone side of `workroom-history-v1`. A resume executes at most once from here: once the execute request has left,
 *  every later step is a status read — a lost response, a reload and an `unknown` outcome all end in «결과 확인». */
export type RemoteHistoryTransport = (request: MobileWorkspaceRequest) => Promise<MobileWorkspaceResult>;
type Storage2 = Pick<Storage, 'getItem' | 'setItem'>;
const uuid = () => globalThis.crypto.randomUUID();

/** One history request through one of the phone's projects; the answer is normalised (closed keys) before use. */
export async function callRemoteHistory(transport: RemoteHistoryTransport, controlId: string, action: RemoteHistoryAction, history: RemoteHistoryRequest): Promise<RemoteHistoryResult> {
  const result = await transport({ operation: 'workspace', requestId: uuid(), targetId: controlId, workspace: { action, history } });
  if (result.action !== action) throw new Error('대화 기록 응답이 요청과 다릅니다.');
  return normalizeRemoteHistoryResult(action, result.history);
}

/** `detail` asks the Mac to say why a row cannot be opened (`why`) — only for a Mac advertising `workroom-restart-v1`;
 *  an older Mac refuses the flag. */
export async function listRemoteHistory(transport: RemoteHistoryTransport, controlId: string, before?: string, detail = false) {
  const page = await callRemoteHistory(transport, controlId, 'history.list', { ...(before ? { before } : {}), ...(detail ? { detail: true as const } : {}) });
  return { records: page.records ?? [], nextBefore: page.nextBefore ?? null };
}

export type RemoteHistoryOutcome =
  | { kind: 'completed'; sessionId?: string }
  | { kind: 'unknown' }
  | { kind: 'rejected' }
  | { kind: 'not-recorded' }
  /** The Mac found no receipt, but it was asked through another pairing or project than the request used: no proof. */
  | { kind: 'unproven'; earlierConnection: boolean }
  | { kind: 'unavailable'; reason: string };

/**
 * «not-recorded» lets the phone drop its only handle and say the conversation never opened. The Mac can say it only for
 * the pairing that asks (its receipts are kept by pairing) and — on a Mac before the whole-grant answer — only for the
 * project asked. So it is proof only when both are the ones the request was sent with; anything else keeps the row.
 */
function settle(storage: Storage2, pending: PendingRemoteHistoryResume, resume: RemoteHistoryResult['resume'], pairing: string | null | undefined, asked: string): RemoteHistoryOutcome {
  const state = resume?.state ?? 'unknown';
  if (state === 'unknown') return { kind: 'unknown' };
  if (state === 'not-recorded' && !(pending.pairing && pairing && pending.pairing === pairing && pending.controlId === asked))
    return { kind: 'unproven', earlierConnection: remoteHistorySentEarlier(pending, pairing) };
  clearPendingRemoteHistoryResume(storage, pending);
  return state === 'completed' ? { kind: 'completed', ...(resume?.sessionId ? { sessionId: resume.sessionId } : {}) } : { kind: state };
}

export async function resumeRemoteHistory(input: { transport: RemoteHistoryTransport; storage: Storage2; host: string; controlId: string;
  /** This phone's current pairing with the Mac (`remoteHistoryPairing`); null when it cannot be named. */
  pairing?: string | null; row: RemoteHistoryRow; cols: number; rows: number }): Promise<RemoteHistoryOutcome> {
  // A full list refuses before anything is sent, with the message that points to the cleanup list.
  assertPendingRemoteHistoryRoom(input.storage, input.host);
  const review = (await callRemoteHistory(input.transport, input.controlId, 'history.resume.review', { conversationId: input.row.id, expectedRevision: input.row.revision })).review!;
  if (!review.available) return { kind: 'unavailable', reason: review.reason || '지금은 이 대화를 이어 열 수 없습니다.' };
  // The project it goes to is remembered too: a later status check must ask that project, whatever the picker shows then.
  const pending: PendingRemoteHistoryResume = { host: input.host, conversationId: input.row.id, resumeRequestId: uuid(), controlId: input.controlId,
    ...(input.pairing ? { pairing: input.pairing } : {}), requestedAt: new Date().toISOString() };
  // Remember the request before it leaves: without it a lost answer could only be retried, which might launch twice.
  savePendingRemoteHistoryResume(input.storage, pending);
  let resume: RemoteHistoryResult['resume'];
  try {
    resume = (await callRemoteHistory(input.transport, input.controlId, 'history.resume.execute', {
      conversationId: input.row.id, expectedRevision: review.revision, reviewId: review.id, resumeRequestId: pending.resumeRequestId,
      cols: Math.min(300, Math.max(20, Math.round(input.cols))), rows: Math.min(150, Math.max(5, Math.round(input.rows))),
    })).resume;
  } catch {
    // The request may have run on the Mac. Only a status check may follow.
    return { kind: 'unknown' };
  }
  return settle(input.storage, pending, resume, input.pairing, input.controlId);
}

/**
 * Status of a pending resume. It asks the project the request was sent to — whether or not the phone has loaded the page
 * of projects that lists it. Only when the Mac refuses that project (reissued, or gone from this connection) is `controlId`
 * asked once more: a status read runs nothing, and the new Mac answers from the device's whole grant. A «not-recorded»
 * from that other project proves nothing (see `settle`). When both are refused, the first refusal is reported.
 */
export async function checkRemoteHistoryResume(input: { transport: RemoteHistoryTransport; storage: Storage2; controlId: string;
  /** This phone's current pairing with the Mac; null when it cannot be named. */
  pairing?: string | null; pending: PendingRemoteHistoryResume }): Promise<RemoteHistoryOutcome> {
  const status = (controlId: string) => callRemoteHistory(input.transport, controlId, 'history.resume.status', { resumeRequestId: input.pending.resumeRequestId });
  const first = input.pending.controlId ?? input.controlId;
  let asked = first, result: RemoteHistoryResult;
  try { result = await status(first); }
  catch (error) {
    if (first === input.controlId) throw error;
    asked = input.controlId;
    try { result = await status(asked); } catch { throw error; }
  }
  return settle(input.storage, input.pending, result.resume, input.pairing, asked);
}

/** This request left no record on the Mac: it opened nothing. The conversation itself may be open all the same — the Mac
 *  (or another window) may have opened it with a press of its own — so nothing is said about the conversation. */
export const REMOTE_HISTORY_NOT_RECORDED = 'Mac에 이 요청이 기록되지 않았습니다. 이 요청으로는 대화가 열리지 않았습니다. 작업 세션 목록을 확인하세요.';
/** The text a person reads for an outcome. Never asks to run the resume again. */
export function remoteHistoryOutcomeText(outcome: RemoteHistoryOutcome): string {
  switch (outcome.kind) {
    case 'completed': return '이 Mac에서 대화를 다시 열었습니다. 워크룸 세션 목록에서 선택하세요.';
    case 'unknown': return '결과를 아직 확인하지 못했습니다. 다시 실행하지 말고 「결과 확인」을 누르세요.';
    case 'rejected': return 'Mac이 이 대화를 열지 않았습니다. 목록을 새로 고친 뒤 다시 확인하세요.';
    // About this request only: the same conversation may be open from another window's or the Mac's own press (w14 review).
    case 'not-recorded': return REMOTE_HISTORY_NOT_RECORDED;
    case 'unproven': return outcome.earlierConnection
      ? '이 요청은 이전 연결로 보냈습니다. 지금 연결로는 Mac의 결과를 확인할 수 없고, Mac이 이미 대화를 열었을 수 있습니다. 워크룸 세션 목록을 확인한 뒤 「목록에서 지우기」로 정리하세요.'
      : 'Mac이 이 요청의 기록을 찾지 못했지만, 요청을 보낸 연결·프로젝트로 확인하지 못해 열리지 않았다고 단정할 수 없습니다. 워크룸 세션 목록을 확인한 뒤 「목록에서 지우기」로 정리하세요.';
    case 'unavailable': return outcome.reason;
  }
}
/** After a completed resume the phone Workroom selects the new session itself (`select` answers whether it could);
 *  when it cannot — the list does not hold it yet, or the lookup failed — the person is told to pick it. */
export async function remoteHistoryOutcomeMessage(outcome: RemoteHistoryOutcome, select?: (sessionId: string) => Promise<boolean>): Promise<string> {
  if (outcome.kind === 'completed' && outcome.sessionId && select) {
    let selected = false;
    try { selected = await select(outcome.sessionId); } catch { selected = false; }
    if (selected) return '이 Mac에서 대화를 다시 열었고 워크룸에서 그 세션을 골랐습니다.';
  }
  return remoteHistoryOutcomeText(outcome);
}
/** The Workroom entry for a resumed session, from the phone's own session list (control ids, not the Mac's runtime id).
 *  The session id is the same on both sides. Null when the list does not hold it. */
export function resumedSessionEntry(sessions: readonly Pick<AiTerminalSummary, 'id' | 'targetId' | 'agent'>[], sessionId: string): { targetId: string; sessionId: string; agent: AiTerminalAgent } | null {
  const session = sessions.find(s => s.id === sessionId);
  return session ? { targetId: session.targetId, sessionId: session.id, agent: session.agent } : null;
}
/** Selects a resumed session in the Workroom of the Mac it was resumed on, and only while that Mac is still the one shown
 *  (integration review w4, finding 2). A resume or check started on Mac A can finish after the phone switched to Mac B:
 *  A's session is not B's, and the portal's Workroom entry is not keyed by Mac. False → the person picks it themselves. */
export async function selectResumedSessionOn(input: {
  hostId: string | null;
  currentHostId: () => string | null;
  sessionId: string;
  list: () => Promise<readonly Pick<AiTerminalSummary, 'id' | 'targetId' | 'agent'>[]>;
  apply: (entry: { targetId: string; sessionId: string; agent: AiTerminalAgent }) => void;
}): Promise<boolean> {
  if (!input.hostId || input.currentHostId() !== input.hostId) return false;
  const sessions = await input.list();
  if (input.currentHostId() !== input.hostId) return false;
  const entry = resumedSessionEntry(sessions, input.sessionId);
  if (!entry) return false;
  input.apply(entry);
  return true;
}
