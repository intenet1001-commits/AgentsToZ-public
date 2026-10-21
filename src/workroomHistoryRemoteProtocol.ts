/**
 * Phone access to this Mac's Workroom conversation history (S3-7).
 *
 * Browser-safe: the portal imports these normalizers. The Mac answers through `src/workroomHistoryRemoteHost.ts`.
 *
 * - Advertised as `workroom-history-v1` only in `protocol.capabilities.extended` (the legacy answer stays at 8).
 * - Permission lives in its own versioned grant field `historyScopes`, never in `MOBILE_WORKSPACE_SCOPES` — old
 *   readers reject unknown workspace scopes, and they ignore an unknown key. Off by default; only a person in the
 *   Mac dialog grants it, so existing pairings get nothing.
 * - Action names stay outside the `workroom.` prefix so the community control path, which allows `workroom.*`,
 *   can never reach them by accident.
 * - Rows carry opaque ids, a title, a state and a resumable flag. Never provider thread ids, paths, session ids,
 *   target ids or CLI account names.
 */
import { projectCreationIntentFingerprint } from './projectLaunchIntent';
export const WORKROOM_HISTORY_REMOTE_FEATURE = 'workroom-history-v1';
export const REMOTE_HISTORY_SCOPES = ['history.read', 'history.resume'] as const;
export type RemoteHistoryScope = typeof REMOTE_HISTORY_SCOPES[number];
export const REMOTE_HISTORY_SCOPE_LABELS: Record<RemoteHistoryScope, string> = {
  'history.read': '워크룸 대화 기록 보기',
  'history.resume': '저장된 대화 이어 열기',
};
/**
 * 「업데이트 전 실행 중이던 작업 세션 이어 열기」 on the phone (w14): `history.restart` / `history.restart.dismiss` and the
 * `detail` flag of `history.list`. Advertised only in `protocol.capabilities.extended` and only with history — an older
 * Mac's strict request normaliser refuses both the actions and the flag, so a phone sends them only to a Mac that says so.
 */
export const WORKROOM_RESTART_REMOTE_FEATURE = 'workroom-restart-v1';
export const REMOTE_HISTORY_ACTIONS = ['history.list', 'history.resume.review', 'history.resume.execute', 'history.resume.status', 'history.restart', 'history.restart.dismiss'] as const;
export type RemoteHistoryAction = typeof REMOTE_HISTORY_ACTIONS[number];
/** Rows per page. Bounded below the local page (50) so a page of 96-character Korean titles fits the 8,500-byte reply. */
export const REMOTE_HISTORY_PAGE_LIMIT = 20;
/** The host trims a page to this many bytes of JSON and continues from the last row it kept. */
export const REMOTE_HISTORY_RESULT_BYTES = 7000;
export const REMOTE_HISTORY_ROW_KEYS = ['id', 'title', 'agent', 'state', 'resumable', 'updatedAt', 'revision'] as const;
/** Present only when the phone asked `detail` (a Mac advertising `workroom-restart-v1`): why a row cannot be opened. */
export const REMOTE_HISTORY_ROW_DETAIL_KEY = 'why';
/**
 * Whether an offered conversation can be opened, as the phone is told: the Mac's own answer (`WorkroomRestartAvailability`,
 * a closed list) plus two of the phone's own — `grant` (no ‘저장된 대화 이어 열기’) and `account` (another CLI account,
 * no account selection). Written out, not imported: a value the Mac adds later must be mapped by the Mac, never reach
 * an older phone whose normaliser would refuse the whole answer.
 */
export const REMOTE_RESTART_AVAILABILITY = ['ready', 'check', 'in-flight', 'pending', 'running', 'open-elsewhere', 'unsupported', 'unsaved', 'ambiguous',
  'legacy', 'project-changed', 'account-changed', 'unprepared', 'grant', 'account'] as const;
export type RemoteRestartAvailability = typeof REMOTE_RESTART_AVAILABILITY[number];
/** A row's reason in the history list: every availability but the two that can be opened. */
export const REMOTE_HISTORY_WHY = ['in-flight', 'pending', 'running', 'open-elsewhere', 'unsupported', 'unsaved', 'ambiguous', 'legacy',
  'project-changed', 'account-changed', 'unprepared', 'grant', 'account'] as const;
export type RemoteHistoryWhy = typeof REMOTE_HISTORY_WHY[number];
export const remoteRestartRunnable = (availability: RemoteRestartAvailability) => availability === 'ready' || availability === 'check';
export const REMOTE_RESTART_ROW_KEYS = ['id', 'project', 'title', 'agent', 'availability', 'bypass', 'revision', 'createdAt', 'updatedAt'] as const;
const REMOTE_RESTART_OFFER_KEYS = ['offerId', 'revision', 'update', 'more', 'complete', 'closable', 'unlisted', 'rows'];
/** The Mac offers at most 64 conversations per restart; the phone's answer is also cut to the reply budget. */
export const REMOTE_RESTART_MAX_ROWS = 64;
/** A phone that cannot see every row of the restart may hide it on itself, never close it for the Mac and other phones. */
export const REMOTE_RESTART_PARTIAL_DISMISS = '이 안내에는 이 휴대폰에서 볼 수 없는 프로젝트의 작업 세션도 있어 Mac에서만 닫을 수 있습니다. 이 휴대폰에서는 숨길 수 있습니다.';
export const REMOTE_HISTORY_COMMUNITY_REFUSAL = '대화 기록은 연결한 Mac에서만 볼 수 있습니다. 다른 기기의 기록은 그 기기에 직접 연결하세요.';

export interface RemoteHistoryRequest {
  before?: string;
  conversationId?: string;
  expectedRevision?: number;
  reviewId?: string;
  resumeRequestId?: string;
  cols?: number;
  rows?: number;
  /** `history.list` only, and only to a Mac with `workroom-restart-v1`: rows then carry `why`. */
  detail?: true;
  offerId?: string;
  dismissRequestId?: string;
}
export interface RemoteHistoryRow {
  id: string;
  title: string;
  agent: 'codex' | 'claude' | 'hermes' | 'agy';
  state: 'running' | 'ended' | 'detached';
  resumable: boolean;
  updatedAt: string;
  revision: number;
  /** Only when asked (`detail`): why it cannot be opened, or null when it can. */
  why?: RemoteHistoryWhy | null;
}
/** One conversation the last restart ended, as this phone sees it. `project` is the phone's own control id. */
export interface RemoteRestartRow {
  id: string;
  project: string;
  title: string;
  agent: 'codex' | 'claude' | 'hermes' | 'agy';
  availability: RemoteRestartAvailability;
  /** The session ran with the approval bypass (true), without (false), or it was recorded before this was kept (null). */
  bypass: boolean | null;
  revision: number;
  /** When that session started: two sessions of one project and AI are told apart by it (w14 review). */
  createdAt: string;
  updatedAt: string;
}
/**
 * The restart offer for this phone. `complete`: no row was left out because this phone may not see its project.
 * `closable`: this phone may close it for the Mac and every other window — the Mac says so (it may resume and sees every
 * row); a phone never infers it from the rows (w14 review). `unlisted`: rows of this phone's projects it is not shown
 * because it may not read history (then `rows` is empty and the banner says which permission is missing).
 * `more`: the Mac or this answer cut the list; the rest are in 「저장된 대화」.
 */
export interface RemoteRestartOffer { offerId: string; revision: number; update: boolean; more: boolean; complete: boolean; closable: boolean; unlisted: number; rows: RemoteRestartRow[] }
export type RemoteHistoryResumeState = 'completed' | 'unknown' | 'rejected' | 'not-recorded';
export interface RemoteHistoryResult {
  records?: RemoteHistoryRow[];
  nextBefore?: string | null;
  review?: { id: string; expiresAt: number; available: boolean; reason: string; revision: number };
  resume?: { state: RemoteHistoryResumeState; sessionId?: string };
  /** `history.restart` / `history.restart.dismiss`: the current offer for this phone, or null. */
  restart?: RemoteRestartOffer | null;
}

const opaque = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(x);
const positive = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function isRemoteHistoryAction(value: unknown): value is RemoteHistoryAction {
  return typeof value === 'string' && (REMOTE_HISTORY_ACTIONS as readonly string[]).includes(value);
}
/** Which history permission an action needs. Status reads one's own receipt, so reading is enough. Closing the restart
 *  offer for the Mac (and every other window) needs resume, like opening it. */
export function remoteHistoryScopeFor(action: RemoteHistoryAction): RemoteHistoryScope {
  return action === 'history.resume.review' || action === 'history.resume.execute' || action === 'history.restart.dismiss' ? 'history.resume' : 'history.read';
}
/** The two restart actions are about all of the phone's projects; the project they are asked through is only a channel. */
export function isRemoteRestartAction(action: unknown): action is 'history.restart' | 'history.restart.dismiss' {
  return action === 'history.restart' || action === 'history.restart.dismiss';
}
export function normalizeHistoryScopes(value: unknown): RemoteHistoryScope[] {
  if (!Array.isArray(value) || value.length > REMOTE_HISTORY_SCOPES.length || value.some(s => !(REMOTE_HISTORY_SCOPES as readonly unknown[]).includes(s))
    || new Set(value).size !== value.length) throw new Error('대화 기록 권한을 확인하세요.');
  if (value.includes('history.resume') && !value.includes('history.read')) throw new Error('대화 이어 열기에는 기록 보기 권한도 필요합니다.');
  return [...value];
}

/** The grant request carries history only when a person ticked it — an unticked dialog sends the same body as before. */
export function historyGrantFields(scopes: readonly RemoteHistoryScope[]): { historyScopes?: RemoteHistoryScope[] } {
  const value = normalizeHistoryScopes([...scopes]);
  return value.length ? { historyScopes: value } : {};
}
/** Dialog checkbox rule: resume implies read; removing read removes resume. */
export function toggleHistoryScope(current: readonly RemoteHistoryScope[], scope: RemoteHistoryScope, enabled: boolean): RemoteHistoryScope[] {
  const next = new Set(current.filter(s => (REMOTE_HISTORY_SCOPES as readonly string[]).includes(s)));
  if (enabled) { next.add(scope); if (scope === 'history.resume') next.add('history.read'); }
  else { next.delete(scope); if (scope === 'history.read') next.delete('history.resume'); }
  return REMOTE_HISTORY_SCOPES.filter(s => next.has(s));
}

const REQUEST_FIELDS: Record<RemoteHistoryAction, readonly string[]> = {
  'history.list': ['before', 'detail'],
  'history.resume.review': ['conversationId', 'expectedRevision'],
  'history.resume.execute': ['conversationId', 'expectedRevision', 'reviewId', 'resumeRequestId', 'cols', 'rows'],
  'history.resume.status': ['resumeRequestId'],
  'history.restart': [],
  'history.restart.dismiss': ['offerId', 'expectedRevision', 'dismissRequestId'],
};
export function normalizeRemoteHistoryRequest(action: RemoteHistoryAction, value: unknown): RemoteHistoryRequest {
  const fail = (): never => { throw new Error('대화 기록 요청 형식이 올바르지 않습니다.'); };
  if (!isRemoteHistoryAction(action) || !plain(value) || Object.keys(value).some(k => !REQUEST_FIELDS[action].includes(k))) return fail();
  const r = value as RemoteHistoryRequest;
  if (action === 'history.list') {
    if (r.before !== undefined && !opaque(r.before) || r.detail !== undefined && r.detail !== true) return fail();
    return { ...(r.before !== undefined ? { before: r.before } : {}), ...(r.detail ? { detail: true as const } : {}) };
  }
  if (action === 'history.restart') return {};
  if (action === 'history.restart.dismiss') {
    if (!opaque(r.offerId) || !positive(r.expectedRevision) || !opaque(r.dismissRequestId)) return fail();
    return { offerId: r.offerId, expectedRevision: r.expectedRevision, dismissRequestId: r.dismissRequestId };
  }
  if (action === 'history.resume.status') { if (!opaque(r.resumeRequestId)) return fail(); return { resumeRequestId: r.resumeRequestId }; }
  if (!opaque(r.conversationId) || !positive(r.expectedRevision)) return fail();
  if (action === 'history.resume.review') return { conversationId: r.conversationId, expectedRevision: r.expectedRevision };
  if (!opaque(r.reviewId) || !opaque(r.resumeRequestId) || !Number.isInteger(r.cols) || r.cols! < 20 || r.cols! > 300
    || !Number.isInteger(r.rows) || r.rows! < 5 || r.rows! > 150) return fail();
  return { conversationId: r.conversationId, expectedRevision: r.expectedRevision, reviewId: r.reviewId, resumeRequestId: r.resumeRequestId, cols: r.cols, rows: r.rows };
}

const titleText = (x: unknown): x is string => typeof x === 'string' && [...x].length <= 96 && !/[\x00-\x1f\x7f]/.test(x);
const timeText = (x: unknown): x is string => typeof x === 'string' && x.length <= 40 && Number.isFinite(Date.parse(x));
const agentName = (x: unknown) => typeof x === 'string' && ['codex', 'claude', 'hermes', 'agy'].includes(x);
function normalizeRow(value: unknown): RemoteHistoryRow {
  const r = value as RemoteHistoryRow;
  // Seven keys, or eight with `why` — which only a phone that asked for `detail` ever receives.
  const keys = plain(r) ? Object.keys(r) : [];
  const detailed = keys.includes(REMOTE_HISTORY_ROW_DETAIL_KEY);
  if (!plain(r) || keys.length !== REMOTE_HISTORY_ROW_KEYS.length + (detailed ? 1 : 0)
    || keys.some(k => k !== REMOTE_HISTORY_ROW_DETAIL_KEY && !(REMOTE_HISTORY_ROW_KEYS as readonly string[]).includes(k))
    || !opaque(r.id) || !titleText(r.title) || !agentName(r.agent) || !['running', 'ended', 'detached'].includes(r.state)
    || typeof r.resumable !== 'boolean' || !positive(r.revision) || !timeText(r.updatedAt)
    || detailed && r.why !== null && !(REMOTE_HISTORY_WHY as readonly unknown[]).includes(r.why)) throw new Error('대화 기록 응답을 확인하세요.');
  return { ...r };
}
/** Closed key sets and a closed availability list: no runtime id, session id, path, provider id or account name rides this. */
export function normalizeRemoteRestartOffer(value: unknown): RemoteRestartOffer {
  const fail = (): never => { throw new Error('이어 열기 안내 응답을 확인하세요.'); };
  const o = value as RemoteRestartOffer;
  if (!plain(o) || Object.keys(o).length !== REMOTE_RESTART_OFFER_KEYS.length || Object.keys(o).some(k => !REMOTE_RESTART_OFFER_KEYS.includes(k))
    || !opaque(o.offerId) || !positive(o.revision) || typeof o.update !== 'boolean' || typeof o.more !== 'boolean' || typeof o.complete !== 'boolean'
    || typeof o.closable !== 'boolean' || !Number.isSafeInteger(o.unlisted) || o.unlisted < 0 || o.unlisted > REMOTE_RESTART_MAX_ROWS
    || !Array.isArray(o.rows) || o.rows.length > REMOTE_RESTART_MAX_ROWS || !o.rows.length && !o.unlisted || o.rows.length && o.unlisted) return fail();
  const rows = o.rows.map(row => {
    const r = row as RemoteRestartRow;
    if (!plain(r) || Object.keys(r).length !== REMOTE_RESTART_ROW_KEYS.length || Object.keys(r).some(k => !(REMOTE_RESTART_ROW_KEYS as readonly string[]).includes(k))
      || !opaque(r.id) || !opaque(r.project) || !titleText(r.title) || !agentName(r.agent) || !(REMOTE_RESTART_AVAILABILITY as readonly unknown[]).includes(r.availability)
      || !(r.bypass === null || typeof r.bypass === 'boolean') || !positive(r.revision) || !timeText(r.createdAt) || !timeText(r.updatedAt)) return fail();
    return { ...r };
  });
  return { ...o, rows };
}
export function normalizeRemoteHistoryResult(action: RemoteHistoryAction, value: unknown): RemoteHistoryResult {
  const fail = (): never => { throw new Error('대화 기록 응답을 확인하세요.'); };
  if (!isRemoteHistoryAction(action) || !plain(value)) return fail();
  const r = value as RemoteHistoryResult;
  const allowed = action === 'history.list' ? ['records', 'nextBefore'] : action === 'history.resume.review' ? ['review']
    : isRemoteRestartAction(action) ? ['restart'] : ['resume'];
  if (Object.keys(r).some(k => !allowed.includes(k))) return fail();
  if (isRemoteRestartAction(action)) {
    if (r.restart === undefined) return fail();
    return { restart: r.restart === null ? null : normalizeRemoteRestartOffer(r.restart) };
  }
  if (action === 'history.list') {
    if (!Array.isArray(r.records) || r.records.length > REMOTE_HISTORY_PAGE_LIMIT || !(r.nextBefore === null || opaque(r.nextBefore))) return fail();
    return { records: r.records.map(normalizeRow), nextBefore: r.nextBefore };
  }
  if (action === 'history.resume.review') {
    const v = r.review;
    if (!plain(v) || Object.keys(v).some(k => !['id', 'expiresAt', 'available', 'reason', 'revision'].includes(k)) || !opaque(v.id)
      || !Number.isSafeInteger(v.expiresAt) || typeof v.available !== 'boolean' || typeof v.reason !== 'string' || v.reason.length > 500
      || !positive(v.revision)) return fail();
    return { review: { ...v } };
  }
  const v = r.resume;
  if (!plain(v) || Object.keys(v).some(k => !['state', 'sessionId'].includes(k)) || !['completed', 'unknown', 'rejected', 'not-recorded'].includes(v.state)
    || v.sessionId !== undefined && (!opaque(v.sessionId) || v.state !== 'completed')) return fail();
  return { resume: { ...v } };
}

/** Phone-side record of a resume whose outcome is not yet known: identities, the project control id it was sent to, the
 *  pairing it was sent over and when. Never titles, prompts or paths. `controlId`/`requestedAt` are absent only in rows of
 *  the first release; `pairing` also when the phone could not name its pairing then. */
export interface PendingRemoteHistoryResume { host: string; conversationId: string; resumeRequestId: string; controlId?: string; pairing?: string; requestedAt?: string }
/**
 * The phone's name for one pairing with a Mac. The Mac keeps resume receipts by the asking pairing
 * (`device:<host>:<controller>`), and every QR claim gives the phone a new relay controller id, so a receipt written over
 * one pairing is invisible to the next. A fingerprint, not the controller id itself: this only tells two pairings apart.
 */
export function remoteHistoryPairing(controllerId: string): string {
  return 'p' + projectCreationIntentFingerprint('agentstoz-remote-history-pairing-v1\0' + controllerId).slice(0, 40);
}
/** A request sent over a pairing this phone no longer uses: the Mac cannot answer for it through the current one. */
export function remoteHistorySentEarlier(entry: Pick<PendingRemoteHistoryResume, 'pairing'>, pairing: string | null | undefined): boolean {
  return !!entry.pairing && !!pairing && entry.pairing !== pairing;
}
/** Said on this page after a surface saved or cleared unsettled resumes, so the other one (the restart banner and the
 *  folded 「대화 기록」) reads them again. Same-page localStorage writes fire no `storage` event. */
export const REMOTE_HISTORY_PENDING_EVENT = 'agentstoz-remote-history-pending';
export function announceRemoteHistoryPending(): void {
  try { if (typeof window !== 'undefined') window.dispatchEvent(new Event(REMOTE_HISTORY_PENDING_EVENT)); } catch { /* nothing listens */ }
}
/** Rows of the first release (exactly the three identities). Read and cleared, never written again. */
const LEGACY_PENDING_KEY = 'agentstoz.remote.workroom-history.pending-resumes.v1';
/** A separate key: a page from before `controlId` rejects a list holding a row it does not know and would then overwrite
 *  it on its next save. It reads only the legacy key, so it neither drops nor overwrites these rows. `controlId` and
 *  `pairing` arrived in the same release as this key, so no page reads it without knowing both. */
const PENDING_KEY = 'agentstoz.remote.workroom-history.pending-resumes.v2';
/** Unsettled resumes kept for one Mac. Past it a new resume is refused, pointing to the panel's cleanup list. */
export const REMOTE_HISTORY_PENDING_PER_HOST = 32;
const PENDING_TOTAL = 64;
export const REMOTE_HISTORY_PENDING_FULL = `결과 확인이 필요한 이어 열기 요청이 이 Mac에 ${REMOTE_HISTORY_PENDING_PER_HOST}건 있어 새 요청을 보내지 않았습니다. 「대화 기록」의 「결과 확인이 필요한 요청」에서 결과를 확인하거나 정리하세요.`;
const PENDING_TOTAL_FULL = '다른 Mac에도 결과 확인이 필요한 이어 열기 요청이 많아 새 요청을 보내지 않았습니다. 그 Mac을 골라 「대화 기록」의 「결과 확인이 필요한 요청」에서 정리하세요. 이 휴대폰에 연결되어 있지 않은 Mac의 요청은 어느 Mac의 「대화 기록」에서나 정리할 수 있습니다.';
const IDENTITY_KEYS = ['host', 'conversationId', 'resumeRequestId'] as const;
const validLegacyPending = (v: unknown): v is PendingRemoteHistoryResume => plain(v) && Object.keys(v).length === 3
  && IDENTITY_KEYS.every(k => opaque((v as Record<string, unknown>)[k]));
const validPending = (v: unknown): v is PendingRemoteHistoryResume => {
  if (!plain(v) || Object.keys(v).some(k => ![...IDENTITY_KEYS, 'controlId', 'pairing', 'requestedAt'].includes(k)) || !IDENTITY_KEYS.every(k => opaque(v[k]))) return false;
  return (v.controlId === undefined || opaque(v.controlId)) && (v.pairing === undefined || opaque(v.pairing))
    && (v.requestedAt === undefined || typeof v.requestedAt === 'string' && v.requestedAt.length <= 40 && Number.isFinite(Date.parse(v.requestedAt)));
};
function readKey(storage: Pick<Storage, 'getItem'>, key: string, valid: (v: unknown) => v is PendingRemoteHistoryResume, max: number, maxChars: number): PendingRemoteHistoryResume[] {
  try {
    const raw = storage.getItem(key); if (!raw) return [];
    if (raw.length > maxChars) return [];
    const rows = JSON.parse(raw);
    return Array.isArray(rows) && rows.length <= max && rows.every(valid) ? rows : [];
  } catch { return []; }
}
const readLegacy = (storage: Pick<Storage, 'getItem'>) => readKey(storage, LEGACY_PENDING_KEY, validLegacyPending, 32, 20000);
const readCurrent = (storage: Pick<Storage, 'getItem'>) => readKey(storage, PENDING_KEY, validPending, PENDING_TOTAL, 40000);
function readPending(storage: Pick<Storage, 'getItem'>): PendingRemoteHistoryResume[] {
  const seen = new Set<string>(), rows: PendingRemoteHistoryResume[] = [];
  for (const row of [...readLegacy(storage), ...readCurrent(storage)]) {
    const key = row.host + '\0' + row.resumeRequestId;
    if (!seen.has(key)) { seen.add(key); rows.push(row); }
  }
  return rows;
}
export function pendingRemoteHistoryResumes(storage: Pick<Storage, 'getItem'>, host: string): PendingRemoteHistoryResume[] {
  return readPending(storage).filter(r => r.host === host);
}
/** Unsettled resumes of Macs this phone no longer holds (forgotten, or back under a new host identity). No status can
 *  reach them, but they still count toward the overall cap, so every Mac's history lists them for a confirmed dismiss. */
export function orphanedRemoteHistoryResumes(storage: Pick<Storage, 'getItem'>, knownHosts: readonly string[]): PendingRemoteHistoryResume[] {
  return readPending(storage).filter(r => !knownHosts.includes(r.host));
}
/** Room for one more unsettled resume on `host`; throws the message that points to the cleanup list. */
export function assertPendingRemoteHistoryRoom(storage: Pick<Storage, 'getItem'>, host: string) {
  const rows = readPending(storage);
  if (rows.filter(r => r.host === host).length >= REMOTE_HISTORY_PENDING_PER_HOST) throw new Error(REMOTE_HISTORY_PENDING_FULL);
  if (rows.length >= PENDING_TOTAL) throw new Error(PENDING_TOTAL_FULL);
}
export function savePendingRemoteHistoryResume(storage: Pick<Storage, 'getItem' | 'setItem'>, row: PendingRemoteHistoryResume) {
  if (!validPending(row)) throw new Error('대화 재개 요청을 확인하세요.');
  const all = readPending(storage);
  // An earlier request for the same conversation may still have opened it; replacing it would lose the only handle.
  if (all.some(r => r.host === row.host && r.conversationId === row.conversationId)) throw new Error('이 대화의 이전 이어 열기 요청 결과를 먼저 확인하세요.');
  assertPendingRemoteHistoryRoom(storage, row.host);
  storage.setItem(PENDING_KEY, JSON.stringify([...readCurrent(storage), row]));
}
export function clearPendingRemoteHistoryResume(storage: Pick<Storage, 'getItem' | 'setItem'>, row: Pick<PendingRemoteHistoryResume, 'host' | 'resumeRequestId'>) {
  const keep = (r: PendingRemoteHistoryResume) => r.host !== row.host || r.resumeRequestId !== row.resumeRequestId;
  for (const [key, rows] of [[LEGACY_PENDING_KEY, readLegacy(storage)], [PENDING_KEY, readCurrent(storage)]] as const) {
    const left = rows.filter(keep);
    if (left.length !== rows.length) storage.setItem(key, JSON.stringify(left));
  }
}
