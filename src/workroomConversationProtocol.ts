import { normalizeAiTerminalResponse, type AiTerminalAgent, type AiTerminalSummary } from './aiTerminalProtocol';
import { cliAccountId } from './cliAccountProtocol';

export const WORKROOM_HISTORY_PATH = '/api/agent-runtime/terminals/history';
export const WORKROOM_HISTORY_VERSION = 'workroom-history-v1' as const;
export const WORKROOM_HISTORY_PAGE_SIZE = 50;
export interface WorkroomConversation {
  id: string;
  targetId: string;
  agent: AiTerminalAgent;
  accountId: string;
  accountLabel: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  archived: boolean;
  state: 'running' | 'ended' | 'detached';
  sessionId: string;
  binding: 'verified' | 'unverified';
}
/**
 * Whether a conversation can be opened again (w14), one closed list for the Mac rows, the restart offer and the phone.
 * ready: the provider conversation is proven · check: an id exists or can be derived, review decides · in-flight: a resume
 * runs now · pending: a resume's outcome is unknown · running: open again (resumed here, or alive in another sidecar) ·
 * open-elsewhere: another running session holds that conversation · unsupported: Hermes/agy · unsaved: ended before a
 * saved first request · ambiguous: several Codex conversations fit · legacy: a record from before the boot table cannot be
 * narrowed · project-changed / account-changed: the folder or CLI sign-in differs from when it ran · unprepared: this Mac
 * cannot prepare its project or CLI account now (unregistered, removed, moved).
 * `ready` is said only after this Mac checked the saved conversation and the project and account fingerprints (w14 review).
 */
export const WORKROOM_RESTART_AVAILABILITY = ['ready','check','in-flight','pending','running','open-elsewhere','unsupported','unsaved','ambiguous','legacy','project-changed','account-changed','unprepared'] as const;
export type WorkroomRestartAvailability = typeof WORKROOM_RESTART_AVAILABILITY[number];
/** Counted on the button: what one press can open. */
export const workroomRestartRunnable = (availability: WorkroomRestartAvailability) => availability === 'ready' || availability === 'check';
/** Something a person still has to do: open it, wait for it, or confirm an unknown outcome. */
export const workroomRestartActionable = (availability: WorkroomRestartAvailability) => workroomRestartRunnable(availability) || availability === 'in-flight' || availability === 'pending';
export interface WorkroomRestartRow {
  id: string; targetId: string; agent: AiTerminalAgent; title: string; accountLabel: string; createdAt: string; updatedAt: string; revision: number;
  availability: WorkroomRestartAvailability;
  /** The last session ran with the approval bypass (true), without (false), or it was recorded before this was kept (null). */
  bypass: boolean | null;
}
export interface WorkroomRestartOffer { offerId: string; revision: number; createdAt: string; update: boolean; more: boolean; rows: WorkroomRestartRow[] }
/** The review reason of a conversation whose earlier resume has an unknown outcome; the Mac offers 「확인했음」 on it. */
export const WORKROOM_RESUME_UNSETTLED_REASON = '앞서 보낸 이어 열기의 결과를 확인하지 못했습니다. 세션 목록에서 이 대화가 열려 있지 않은지 확인한 뒤 「확인했음」을 누르세요.';
export type WorkroomHistoryRequest = { protocolVersion: typeof WORKROOM_HISTORY_VERSION } & (
  /** `detail` (w14): the answer also says, per row, whether it can be opened (`availability`). An older sidecar refuses
   *  the flag; the new panel then asks without it. */
  | { operation: 'list'; archived: boolean; before?: string; detail?: true }
  | { operation: 'restart.list' }
  | { operation: 'restart.dismiss'; storeInstanceId: string; offerId: string; expectedRevision: number; requestId: string }
  | { operation: 'resume.settle'; storeInstanceId: string; conversationId: string; expectedRevision: number; requestId: string }
  | { operation: 'rename' | 'archive' | 'unarchive'; storeInstanceId: string; conversationId: string; expectedRevision: number; requestId: string; title?: string }
  | { operation: 'resume.review'; storeInstanceId: string; conversationId: string; expectedRevision: number }
  | { operation: 'resume.execute'; storeInstanceId: string; conversationId: string; expectedRevision: number; reviewId: string; requestId: string; cols: number; rows: number }
  | { operation: 'resume.status'; storeInstanceId: string; requestId: string }
);
export interface WorkroomHistoryResult {
  protocolVersion: typeof WORKROOM_HISTORY_VERSION;
  storeInstanceId: string;
  records?: WorkroomConversation[];
  nextBefore?: string | null;
  record?: WorkroomConversation;
  review?: { id: string; expiresAt: number; available: boolean; reason: string; revision: number };
  resume?: { state: 'completed' | 'unknown' | 'rejected' | 'not-recorded'; session?: AiTerminalSummary };
  /** Only on `restart.list` / `restart.dismiss` (new operations): an old client never asks, so never sees it. */
  restart?: WorkroomRestartOffer | null;
  /** Only on `list` with `detail`: whether each listed conversation can be opened, from what this Mac already knows. */
  availability?: Record<string, WorkroomRestartAvailability>;
}
const id = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(x);
const positive = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
export function workroomHistoryErrorMessage(error: unknown): string {
  return error instanceof Error && !error.name.includes('Syntax') && !(error as Error & {code?:unknown}).code
    && error.message.length<=500 && /[가-힣]/.test(error.message) && !/[\/\\\x00-\x1f]/.test(error.message)
    ? error.message : '대화 기록 요청을 처리하지 못했습니다. 기존 기록은 유지됩니다.';
}
export function workroomTitle(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && [...value].length <= 96 && !/[\x00-\x1f\x7f]/.test(value);
}
export function normalizeWorkroomHistoryRequest(value: unknown): WorkroomHistoryRequest {
  const r = value as WorkroomHistoryRequest;
  const fields: Record<string, string[]> = {
    list: ['archived', 'before', 'detail'],
    rename: ['conversationId', 'expectedRevision', 'requestId', 'storeInstanceId', 'title'],
    archive: ['conversationId', 'expectedRevision', 'requestId', 'storeInstanceId'],
    unarchive: ['conversationId', 'expectedRevision', 'requestId', 'storeInstanceId'],
    'resume.review': ['conversationId', 'expectedRevision', 'storeInstanceId'],
    'resume.execute': ['conversationId', 'expectedRevision', 'storeInstanceId', 'reviewId', 'requestId', 'cols', 'rows'],
    'resume.status': ['storeInstanceId', 'requestId'],
    'restart.list': [],
    'restart.dismiss': ['storeInstanceId', 'offerId', 'expectedRevision', 'requestId'],
    'resume.settle': ['conversationId', 'expectedRevision', 'storeInstanceId', 'requestId'],
  };
  if (!r || typeof r !== 'object' || Array.isArray(r) || r.protocolVersion !== WORKROOM_HISTORY_VERSION
    || !Object.hasOwn(fields, r.operation) || Object.keys(r).some(k => !['operation', 'protocolVersion', ...fields[r.operation]!].includes(k))) throw new Error('대화 기록 요청 형식을 확인하세요.');
  if (r.operation === 'list') {
    if (typeof r.archived !== 'boolean' || r.before !== undefined && (!id(r.before)) || r.detail !== undefined && r.detail !== true) throw new Error('대화 기록 페이지를 확인하세요.');
  } else if (r.operation === 'restart.list') {
    // No fields: the host decides what was running before the restart.
  } else if (r.operation === 'restart.dismiss') {
    if (!id(r.storeInstanceId) || !id(r.offerId) || !positive(r.expectedRevision) || !id(r.requestId)) throw new Error('이어 열기 안내 요청을 확인하세요.');
  } else {
    if (!id(r.storeInstanceId) || r.operation !== 'resume.status' && (!id((r as any).conversationId) || !positive((r as any).expectedRevision))
      || r.operation !== 'resume.review' && !id((r as any).requestId)) throw new Error('대화 기록의 소유와 요청을 다시 확인하세요.');
    if (r.operation === 'rename' && !workroomTitle(r.title)) throw new Error('대화 제목은 96자까지 입력할 수 있습니다.');
    if (r.operation === 'resume.execute' && (!id(r.reviewId) || !Number.isInteger(r.cols) || r.cols < 20 || r.cols > 300 || !Number.isInteger(r.rows) || r.rows < 5 || r.rows > 150)) throw new Error('대화 재개 요청을 확인하세요.');
  }
  return { ...r };
}
export function normalizeWorkroomConversation(value: unknown): WorkroomConversation {
  const r = value as WorkroomConversation;
  const keys = ['id','targetId','agent','accountId','accountLabel','title','createdAt','updatedAt','revision','archived','state','sessionId','binding'];
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !keys.includes(k))
    || !id(r.id) || !id(r.targetId) || !id(r.sessionId) || !['codex','claude','hermes','agy'].includes(r.agent)
    || !cliAccountId(r.accountId) || typeof r.accountLabel !== 'string' || r.accountLabel.length > 64
    || !workroomTitle(r.title) || !positive(r.revision) || typeof r.archived !== 'boolean'
    || !['running','ended','detached'].includes(r.state) || !['verified','unverified'].includes(r.binding)
    || ![r.createdAt,r.updatedAt].every(t => typeof t === 'string' && t.length <= 40 && Number.isFinite(Date.parse(t)))) throw new Error('대화 기록 응답을 확인하세요.');
  return { ...r };
}

export function normalizeWorkroomHistoryResult(value: unknown): WorkroomHistoryResult {
  const r=value as WorkroomHistoryResult;
  if(!r||typeof r!=='object'||Array.isArray(r)||r.protocolVersion!==WORKROOM_HISTORY_VERSION||!id(r.storeInstanceId)
    ||Object.keys(r).some(k=>!['protocolVersion','storeInstanceId','records','nextBefore','record','review','resume','restart','availability'].includes(k)))throw new Error('대화 기록 응답을 확인하세요.');
  if(r.restart!==undefined&&r.restart!==null)normalizeWorkroomRestartOffer(r.restart);
  if(r.availability!==undefined&&(!r.availability||typeof r.availability!=='object'||Array.isArray(r.availability)||Object.keys(r.availability).length>WORKROOM_HISTORY_PAGE_SIZE
    ||Object.entries(r.availability).some(([key,value])=>!id(key)||!(WORKROOM_RESTART_AVAILABILITY as readonly string[]).includes(value as string))))throw new Error('대화 기록 응답을 확인하세요.');
  if(r.records!==undefined&&(!Array.isArray(r.records)||r.records.length>WORKROOM_HISTORY_PAGE_SIZE))throw new Error('대화 기록 페이지를 확인하세요.');
  if(r.nextBefore!==undefined&&r.nextBefore!==null&&!id(r.nextBefore))throw new Error('대화 기록 페이지를 확인하세요.');
  if(r.review){const v=r.review;
    if(Object.keys(v).some(k=>!['id','expiresAt','available','reason','revision'].includes(k))||!id(v.id)||!Number.isSafeInteger(v.expiresAt)
      ||typeof v.available!=='boolean'||typeof v.reason!=='string'||v.reason.length>500||!positive(v.revision))throw new Error('대화 재개 검토를 확인하세요.');
  }
  if(r.resume){const v=r.resume;
    if(Object.keys(v).some(k=>!['state','session'].includes(k))||!['completed','unknown','rejected','not-recorded'].includes(v.state))throw new Error('대화 재개 결과를 확인하세요.');
    if(v.session)normalizeAiTerminalResponse({session:v.session});
  }
  return {...r,...(r.records?{records:r.records.map(normalizeWorkroomConversation)}:{}),...(r.record?{record:normalizeWorkroomConversation(r.record)}:{})};
}

const RESTART_ROW_KEYS = ['id','targetId','agent','title','accountLabel','createdAt','updatedAt','revision','availability','bypass'];
const RESTART_OFFER_KEYS = ['offerId','revision','createdAt','update','more','rows'];
/** Closed key sets and a closed availability list: no path, session id, provider id or account root ever rides this. */
export function normalizeWorkroomRestartOffer(value: unknown): WorkroomRestartOffer {
  const o = value as WorkroomRestartOffer;
  const time = (t: unknown) => typeof t === 'string' && t.length <= 40 && Number.isFinite(Date.parse(t));
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some(k => !RESTART_OFFER_KEYS.includes(k)) || !id(o.offerId) || !positive(o.revision)
    || !time(o.createdAt) || typeof o.update !== 'boolean' || typeof o.more !== 'boolean' || !Array.isArray(o.rows) || o.rows.length > 64) throw new Error('이어 열기 안내 응답을 확인하세요.');
  for (const row of o.rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(k => !RESTART_ROW_KEYS.includes(k)) || !id(row.id) || !id(row.targetId)
      || !['codex','claude','hermes','agy'].includes(row.agent) || !workroomTitle(row.title) || typeof row.accountLabel !== 'string' || row.accountLabel.length > 64
      || !time(row.createdAt) || !time(row.updatedAt) || !positive(row.revision) || !(WORKROOM_RESTART_AVAILABILITY as readonly string[]).includes(row.availability)
      || !(row.bypass === null || typeof row.bypass === 'boolean')) throw new Error('이어 열기 안내 응답을 확인하세요.');
  }
  return { ...o, rows: o.rows.map(row => ({ ...row })) };
}
