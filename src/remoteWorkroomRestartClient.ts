import { REMOTE_HISTORY_NOT_RECORDED, callRemoteHistory, resumeRemoteHistory, type RemoteHistoryTransport } from './remoteWorkroomHistoryClient';
import { phoneIsOnline } from './phoneNetwork';
import {
  remoteRestartRunnable, type PendingRemoteHistoryResume, type RemoteHistoryRow, type RemoteRestartOffer, type RemoteRestartRow,
} from './workroomHistoryRemoteProtocol';

/**
 * Phone side of `workroom-restart-v1` (w14): the offer of the last restart, closing it, and 「N개 이어 열기」.
 *
 * Exactly once is the existing per-row path: each row is `resumeRemoteHistory` (review → the request remembered on this
 * phone → execute), one after another. A row whose outcome is unknown stops the batch: it is then checked with status,
 * never sent again by itself, and the rows after it are not tried. Nothing here opens a session view by itself.
 */
type Storage2 = Pick<Storage, 'getItem' | 'setItem'>;

/** The offer for this phone, asked through any one of its projects (the Mac answers for all of them). */
export async function listRemoteRestart(transport: RemoteHistoryTransport, controlId: string): Promise<RemoteRestartOffer | null> {
  return (await callRemoteHistory(transport, controlId, 'history.restart', {})).restart ?? null;
}
/** Closes the offer for the Mac and every other window; answers what is current afterwards (null when nothing is). */
export async function dismissRemoteRestart(transport: RemoteHistoryTransport, controlId: string, offer: Pick<RemoteRestartOffer, 'offerId' | 'revision'>,
  dismissRequestId: string = globalThis.crypto.randomUUID()): Promise<RemoteRestartOffer | null> {
  return (await callRemoteHistory(transport, controlId, 'history.restart.dismiss', { offerId: offer.offerId, expectedRevision: offer.revision, dismissRequestId })).restart ?? null;
}

/** What one press may open: rows the Mac can open for this phone, minus those this phone already sent and has not settled. */
export function remoteRestartRunnableRows(offer: Pick<RemoteRestartOffer, 'rows'>, pending: readonly PendingRemoteHistoryResume[]): RemoteRestartRow[] {
  const waiting = new Set(pending.map(entry => entry.conversationId));
  return offer.rows.filter(row => remoteRestartRunnable(row.availability) && !waiting.has(row.id));
}

export interface RemoteRestartBatchResult {
  opened: { row: RemoteRestartRow; sessionId?: string }[];
  skipped: { row: RemoteRestartRow; reason: string }[];
  /** The row the batch stopped at. `sent`: its execute left this phone (outcome unknown, kept for 「결과 확인」);
   *  otherwise nothing ran for it (offline, a refusal on this phone or on the way). */
  stopped: { row: RemoteRestartRow; reason: string; sent: boolean } | null;
}
const OFFLINE = '휴대폰이 오프라인이라 멈췄습니다. 나머지는 다시 연결된 뒤 이어 여세요.';
const UNKNOWN = '이어 열기 결과를 확인하지 못했습니다. 요청을 다시 보내지 않았습니다.';
const UNPROVEN = 'Mac의 결과를 이 연결로 확인하지 못했습니다. 요청을 다시 보내지 않았습니다.';
const historyRow = (row: RemoteRestartRow): RemoteHistoryRow => ({ id: row.id, title: row.title, agent: row.agent, state: 'detached', resumable: true, updatedAt: row.updatedAt, revision: row.revision });

/**
 * 「N개 이어 열기」: one row at a time through its own project. Rows that cannot be opened from here are not sent.
 * `online` is asked before each row (default: the device's network state) — an offline phone sends nothing more.
 */
export async function resumeRemoteRestartRows(input: {
  transport: RemoteHistoryTransport; storage: Storage2; host: string;
  /** This phone's current pairing with the Mac (`remoteHistoryPairing`); null when it cannot be named. */
  pairing?: string | null;
  rows: readonly RemoteRestartRow[]; cols: number; height: number;
  online?: () => boolean;
  onProgress?: (done: number, total: number, row: RemoteRestartRow) => void;
}): Promise<RemoteRestartBatchResult> {
  const rows = input.rows.filter(row => remoteRestartRunnable(row.availability));
  const online = input.online ?? (() => phoneIsOnline());
  const result: RemoteRestartBatchResult = { opened: [], skipped: [], stopped: null };
  let done = 0;
  for (const row of rows) {
    input.onProgress?.(done, rows.length, row);
    if (!online()) { result.stopped = { row, reason: OFFLINE, sent: false }; break; }
    let outcome: Awaited<ReturnType<typeof resumeRemoteHistory>>;
    try {
      outcome = await resumeRemoteHistory({ transport: input.transport, storage: input.storage, host: input.host, controlId: row.project,
        pairing: input.pairing ?? null, row: historyRow(row), cols: input.cols, rows: input.height });
    } catch (error) {
      // Thrown before the execute left (a review refused, the pending list full, the relay unreachable): nothing ran for
      // this row. The batch stops — what refused this row would very likely refuse the next one too.
      result.stopped = { row, reason: error instanceof Error ? error.message : String(error), sent: false }; break;
    }
    done++;
    if (outcome.kind === 'completed') { result.opened.push({ row, ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}) }); continue; }
    if (outcome.kind === 'unavailable') { result.skipped.push({ row, reason: outcome.reason }); continue; }
    if (outcome.kind === 'rejected') { result.skipped.push({ row, reason: 'CLI를 실행하기 전에 중단됐습니다. 다시 이어 열 수 있습니다.' }); continue; }
    if (outcome.kind === 'not-recorded') { result.skipped.push({ row, reason: REMOTE_HISTORY_NOT_RECORDED }); continue; }
    // unknown or unproven: never retried by itself; the person checks it.
    result.stopped = { row, reason: outcome.kind === 'unproven' ? UNPROVEN : UNKNOWN, sent: true }; break;
  }
  if (rows.length) input.onProgress?.(done, rows.length, rows[rows.length - 1]!);
  return result;
}

const firstSentence = (text: string) => (text.split(/(?<=[.!?])\s/)[0] ?? text).replace(/[.。]\s*$/, '');
/** 「1개를 다시 열었습니다 — 작업 세션 목록에서 여세요 · 1개는 첫 요청을 보내기 전에 끝나 저장된 대화가 없습니다.」 Never asks to
 *  run anything again. */
export function remoteRestartBatchSummary(result: RemoteRestartBatchResult, label: (row: RemoteRestartRow) => string): string {
  const parts: string[] = [];
  if (result.opened.length) parts.push(`${result.opened.length}개를 다시 열었습니다 — 작업 세션 목록에서 여세요`);
  const reasons = new Map<string, number>();
  for (const skipped of result.skipped) { const reason = firstSentence(skipped.reason); reasons.set(reason, (reasons.get(reason) ?? 0) + 1); }
  for (const [reason, count] of reasons) parts.push(`${count}개는 ${reason}`);
  if (result.stopped) parts.push(result.stopped.sent
    ? `${label(result.stopped.row)}의 결과를 확인하지 못해 멈췄습니다. 요청을 다시 보내지 않았습니다 — 「결과 확인」을 누르세요`
    : `${label(result.stopped.row)}에서 멈췄습니다: ${firstSentence(result.stopped.reason)}`);
  return parts.length ? parts.join(' · ') + '.' : '다시 열 대화가 없었습니다.';
}

/** 「이 휴대폰에서 숨기기」: per viewer, per Mac and offer, in this browser only. A storage that throws hides nothing. */
const HIDDEN_KEY = 'agentstoz.remote.workroom-restart.hidden.v1';
const HIDDEN_MAX = 16;
const hiddenKey = (host: string, offer: Pick<RemoteRestartOffer, 'offerId'>) => host + '\0' + offer.offerId;
function readHidden(storage: Pick<Storage, 'getItem'>): string[] {
  try {
    const raw = storage.getItem(HIDDEN_KEY); if (!raw || raw.length > 8000) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.length <= HIDDEN_MAX && list.every(item => typeof item === 'string' && item.length <= 400) ? list : [];
  } catch { return []; }
}
export function remoteRestartOfferHidden(storage: Pick<Storage, 'getItem'>, host: string, offer: Pick<RemoteRestartOffer, 'offerId'>): boolean {
  return readHidden(storage).includes(hiddenKey(host, offer));
}
export function hideRemoteRestartOffer(storage: Storage2, host: string, offer: Pick<RemoteRestartOffer, 'offerId'>): void {
  try {
    const list = readHidden(storage).filter(item => item !== hiddenKey(host, offer));
    storage.setItem(HIDDEN_KEY, JSON.stringify([...list, hiddenKey(host, offer)].slice(-HIDDEN_MAX)));
  } catch { /* A blocked storage cannot remember it: the banner then simply stays. */ }
}
