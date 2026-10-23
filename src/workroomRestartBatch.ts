import type { WorkroomRestartRow } from './workroomConversationProtocol';

/**
 * 「N개 이어 열기」 (w14): one press reopens the offered conversations, one after another, each through the existing
 * review → execute path (journal CAS on the revision, a durable receipt, the grant re-checked at launch). Exactly once:
 * two windows pressing at once launch each conversation once — the second reservation fails. A response that never came
 * back stops the batch at that row: it is checked with status, never sent again by itself. Nothing opens a window.
 */
export interface RestartReview { id: string; available: boolean; reason: string; revision: number; expiresAt: number }
export type RestartExecuteOutcome =
  | { kind: 'answer'; state: 'completed' | 'unknown' | 'rejected' | 'not-recorded'; sessionId?: string }
  /** The host answered with a refusal: nothing ran for this request id. */
  | { kind: 'refused'; message: string }
  /** No answer came back: it may have run. */
  | { kind: 'lost'; message: string };
export interface RestartBatchAdapter {
  review(row: WorkroomRestartRow): Promise<RestartReview>;
  /** Keeps the request id before it is sent (so a reload can still ask for its outcome). Throwing stops the batch. */
  remember?(row: WorkroomRestartRow, requestId: string): void;
  execute(row: WorkroomRestartRow, review: RestartReview, requestId: string): Promise<RestartExecuteOutcome>;
  newRequestId?(): string;
}
export interface RestartBatchResult {
  opened: { row: WorkroomRestartRow; sessionId?: string }[];
  skipped: { row: WorkroomRestartRow; reason: string }[];
  /** The row whose outcome is unknown; the rows after it were not tried. */
  stopped: { row: WorkroomRestartRow; reason: string; requestId: string } | null;
}
export async function resumeRestartRows(rows: readonly WorkroomRestartRow[], adapter: RestartBatchAdapter,
  onProgress?: (done: number, total: number, row: WorkroomRestartRow) => void): Promise<RestartBatchResult> {
  const result: RestartBatchResult = { opened: [], skipped: [], stopped: null };
  let done = 0;
  for (const row of rows) {
    onProgress?.(done, rows.length, row);
    let review: RestartReview;
    try { review = await adapter.review(row); }
    catch (error) { result.skipped.push({ row, reason: error instanceof Error ? error.message : String(error) }); done++; continue; }
    if (!review.available) { result.skipped.push({ row, reason: review.reason }); done++; continue; }
    const requestId = adapter.newRequestId?.() ?? crypto.randomUUID();
    try { adapter.remember?.(row, requestId); }
    catch (error) { result.stopped = { row, reason: error instanceof Error ? error.message : String(error), requestId }; break; }
    const outcome = await adapter.execute(row, review, requestId)
      .catch((error: unknown): RestartExecuteOutcome => ({ kind: 'lost', message: error instanceof Error ? error.message : String(error) }));
    done++;
    if (outcome.kind === 'refused') { result.skipped.push({ row, reason: outcome.message }); continue; }
    if (outcome.kind === 'lost') { result.stopped = { row, reason: outcome.message, requestId }; break; }
    if (outcome.state === 'completed') { result.opened.push({ row, ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}) }); continue; }
    if (outcome.state === 'rejected') { result.skipped.push({ row, reason: 'CLI를 실행하기 전에 중단됐습니다. 다시 검토할 수 있습니다.' }); continue; }
    // unknown, or a receipt that is not there: never retried — the person checks it.
    result.stopped = { row, reason: '이어 열기 결과를 확인하지 못했습니다. 요청을 다시 보내지 않았습니다.', requestId }; break;
  }
  if (rows.length) onProgress?.(done, rows.length, rows[rows.length - 1]!);
  return result;
}
