/**
 * A frozen copy of the phone-history request normaliser as it shipped with `workroom-history-v1` (before w14).
 * Macs on that release run exactly this: it proves a new phone must not send `detail` (or the restart actions) to a Mac
 * that does not advertise `workroom-restart-v1` — the request would be refused. Do not update it with the live file.
 */
type Action = 'history.list' | 'history.resume.review' | 'history.resume.execute' | 'history.resume.status';
const ACTIONS: readonly string[] = ['history.list', 'history.resume.review', 'history.resume.execute', 'history.resume.status'];
const opaque = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(x);
const positive = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const REQUEST_FIELDS: Record<Action, readonly string[]> = {
  'history.list': ['before'],
  'history.resume.review': ['conversationId', 'expectedRevision'],
  'history.resume.execute': ['conversationId', 'expectedRevision', 'reviewId', 'resumeRequestId', 'cols', 'rows'],
  'history.resume.status': ['resumeRequestId'],
};
export function normalizeRemoteHistoryRequestV1(action: string, value: unknown): Record<string, unknown> {
  const fail = (): never => { throw new Error('대화 기록 요청 형식이 올바르지 않습니다.'); };
  if (!ACTIONS.includes(action) || !plain(value) || Object.keys(value).some(k => !REQUEST_FIELDS[action as Action].includes(k))) return fail();
  const r = value as Record<string, any>;
  if (action === 'history.list') { if (r.before !== undefined && !opaque(r.before)) return fail(); return { ...(r.before !== undefined ? { before: r.before } : {}) }; }
  if (action === 'history.resume.status') { if (!opaque(r.resumeRequestId)) return fail(); return { resumeRequestId: r.resumeRequestId }; }
  if (!opaque(r.conversationId) || !positive(r.expectedRevision)) return fail();
  return { ...r };
}
