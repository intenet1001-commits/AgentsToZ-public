/**
 * Whether 「공통 테스터 승격 후보」 counts toward the header 「업데이트 N」 badge.
 *
 * Collecting candidates changes nothing in any project, and its usual answer is «none yet» (every
 * candidate is waiting for `runs<3`). Counting it anyway left 「업데이트 1」 lit after the user had just
 * collected and been told there was nothing to do (VOC 2026-10-06): a badge that cannot be cleared
 * reads as an error. So an empty answer is remembered, per device, for the same set of projects, and
 * the item stops counting until that set changes or a week passes (runs accumulate; blockers lift).
 * The row itself stays in the popover — the user can still collect again.
 */
export interface TesterPromotionMemo {signature: string; ready: number; at: number}

export const TESTER_PROMOTION_MEMO_KEY = 'agentstoz-tester-promotion-last';
export const TESTER_PROMOTION_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

/** Order-independent and short: the projects that have their own checks right now. */
export function testerPromotionSignature(folderPaths: readonly string[]): string {
  let hash = 5381;
  for (const ch of [...folderPaths].sort().join('\n')) hash = ((hash * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `${folderPaths.length}:${hash.toString(36)}`;
}

export function testerPromotionCounts(folderPaths: readonly string[], memo: TesterPromotionMemo | null, now: number): boolean {
  if (folderPaths.length === 0) return false;
  if (!memo || memo.ready > 0) return true;
  if (memo.signature !== testerPromotionSignature(folderPaths)) return true;
  return now - memo.at >= TESTER_PROMOTION_RECHECK_MS;
}

export function readTesterPromotionMemo(): TesterPromotionMemo | null {
  try {
    const raw = JSON.parse(localStorage.getItem(TESTER_PROMOTION_MEMO_KEY) ?? 'null');
    if (raw && typeof raw.signature === 'string' && Number.isFinite(raw.ready) && Number.isFinite(raw.at)) return raw;
  } catch { /* a broken value just means «not collected yet» */ }
  return null;
}

export function writeTesterPromotionMemo(memo: TesterPromotionMemo): void {
  try { localStorage.setItem(TESTER_PROMOTION_MEMO_KEY, JSON.stringify(memo)); } catch { /* per-device convenience */ }
}
