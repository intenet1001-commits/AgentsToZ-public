import { AiTerminalServerResponseError } from './aiTerminalClient';
import { requestWorkroomHistory, pendingWorkroomResumes, savePendingWorkroomResume, clearPendingWorkroomResume, type PendingWorkroomResume } from './workroomConversationClient';
import { WORKROOM_HISTORY_VERSION, type WorkroomRestartOffer, type WorkroomRestartRow } from './workroomConversationProtocol';
import type { RestartBatchAdapter } from './workroomRestartBatch';

/**
 * The banner's view of this Mac's history (w14). Every call is the local history path (`/api/agent-runtime/terminals/
 * history`); a sidecar older than this window refuses the new operations and the banner then shows nothing.
 */
export interface WorkroomRestartSource {
  list(): Promise<{ storeInstanceId: string; offer: WorkroomRestartOffer | null }>;
  /** Closes it for every window and phone; answers what is current afterwards (null when nothing is). */
  dismiss(storeInstanceId: string, offer: WorkroomRestartOffer): Promise<WorkroomRestartOffer | null>;
  settle(storeInstanceId: string, row: WorkroomRestartRow): Promise<void>;
  batch(storeInstanceId: string): RestartBatchAdapter;
  /** A resume request this page kept before sending (sessionStorage), still waiting for its outcome. */
  pending(storeInstanceId: string, conversationId: string): PendingWorkroomResume | null;
  status(receipt: PendingWorkroomResume): Promise<'completed' | 'unknown' | 'rejected' | 'not-recorded'>;
}
const storage = () => { try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; } };
const forget = (receipt: PendingWorkroomResume) => { const s = storage(); if (s) try { clearPendingWorkroomResume(s, receipt); } catch { /* the saved list keeps showing it */ } };

export const localWorkroomRestart: WorkroomRestartSource = {
  async list() {
    const result = await requestWorkroomHistory({ protocolVersion: WORKROOM_HISTORY_VERSION, operation: 'restart.list' });
    if (result.restart === undefined) throw new Error('이어 열기 안내를 확인하지 못했습니다.');
    return { storeInstanceId: result.storeInstanceId, offer: result.restart };
  },
  async dismiss(storeInstanceId, offer) {
    const result = await requestWorkroomHistory({ protocolVersion: WORKROOM_HISTORY_VERSION, operation: 'restart.dismiss', storeInstanceId, offerId: offer.offerId, expectedRevision: offer.revision, requestId: crypto.randomUUID() });
    return result.restart ?? null;
  },
  async settle(storeInstanceId, row) {
    const result = await requestWorkroomHistory({ protocolVersion: WORKROOM_HISTORY_VERSION, operation: 'resume.settle', storeInstanceId, conversationId: row.id, expectedRevision: row.revision, requestId: crypto.randomUUID() });
    if (!result.record) throw new Error('확인 결과를 받지 못했습니다. 목록을 다시 확인하세요.');
    const s = storage(); if (s) try { for (const receipt of pendingWorkroomResumes(s)) if (receipt.conversationId === row.id && receipt.storeInstanceId === storeInstanceId) clearPendingWorkroomResume(s, receipt); } catch { /* best effort */ }
  },
  pending(storeInstanceId, conversationId) {
    const s = storage(); if (!s) return null;
    try { return pendingWorkroomResumes(s).find(r => r.storeInstanceId === storeInstanceId && r.conversationId === conversationId) ?? null; } catch { return null; }
  },
  async status(receipt) {
    const result = await requestWorkroomHistory({ protocolVersion: WORKROOM_HISTORY_VERSION, operation: 'resume.status', storeInstanceId: receipt.storeInstanceId, requestId: receipt.requestId });
    const state = result.resume?.state ?? 'unknown';
    if (state !== 'unknown') forget(receipt);
    return state;
  },
  batch(storeInstanceId): RestartBatchAdapter {
    return {
      async review(row) {
        const result = await requestWorkroomHistory({ protocolVersion: WORKROOM_HISTORY_VERSION, operation: 'resume.review', storeInstanceId, conversationId: row.id, expectedRevision: row.revision });
        if (!result.review || result.storeInstanceId !== storeInstanceId) throw new Error('대화 재개 검토를 확인하지 못했습니다.');
        return result.review;
      },
      remember(row, requestId) {
        // Kept before sending, like the saved list: a lost answer is checked with status after a reload, never resent.
        const s = storage(); if (!s) throw new Error('이 창에 재개 요청을 기록하지 못했습니다. 저장된 대화에서 하나씩 이어 여세요.');
        savePendingWorkroomResume(s, { storeInstanceId, conversationId: row.id, requestId });
      },
      async execute(row, review, requestId) {
        const receipt = { storeInstanceId, conversationId: row.id, requestId };
        try {
          const result = await requestWorkroomHistory({ protocolVersion: WORKROOM_HISTORY_VERSION, operation: 'resume.execute', storeInstanceId, conversationId: row.id,
            expectedRevision: review.revision, reviewId: review.id, requestId, cols: 100, rows: 30 });
          const state = result.resume?.state ?? 'unknown';
          if (state === 'completed' || state === 'rejected') forget(receipt);
          return { kind: 'answer', state, ...(result.resume?.session ? { sessionId: result.resume.session.id } : {}) };
        } catch (error) {
          // The host answered with a refusal before reserving anything (a changed revision, another window first).
          if (error instanceof AiTerminalServerResponseError) { forget(receipt); return { kind: 'refused', message: error.message }; }
          return { kind: 'lost', message: '재개 응답을 받지 못했습니다. 결과 확인으로 같은 요청을 조회하세요. 다시 보내지 않았습니다.' };
        }
      },
    };
  },
};
