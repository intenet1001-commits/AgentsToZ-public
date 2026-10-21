import type { WorkroomRestartAvailability } from './workroomConversationProtocol';
import type { RestartBatchResult } from './workroomRestartBatch';
import type { RemoteHistoryWhy, RemoteRestartAvailability } from './workroomHistoryRemoteProtocol';
import { phoneDateTime } from './phoneTime';

/**
 * Words of 「업데이트 전 실행 중이던 작업 세션 이어 열기」 (w14), one place for the Mac directory, the pop-out and the
 * saved list. Glossary (docs/ui-glossary.md): 워크룸 · 작업 세션 · 승인 없이 실행 (권한 우회).
 */
/** A confirmation armed this recently ignores a press (a double click lands on the confirm button that replaced it). */
export const WORKROOM_RESTART_CONFIRM_GUARD_MS = 500;
/** `count` is every session of the offer (w14 review: the title says how many were running; the button how many open). */
export function restartOfferTitle(count: number, update: boolean): string {
  return update ? `업데이트 전 실행 중이던 작업 세션 ${count}개` : `앱을 다시 열기 전 실행 중이던 작업 세션 ${count}개`;
}
export const RESTART_OFFER_SENTENCE = '앱이 다시 시작되며 함께 끝난 작업 세션입니다. 저장된 대화를 이 Mac에서 이어서 엽니다.';
/** When nothing in the offer can be opened now (Hermes, agy, nothing saved): said once, until a person closes it. */
export const RESTART_OFFER_NONE_SENTENCE = '앱이 다시 시작되며 함께 끝난 작업 세션입니다. 지금 이어 열 수 있는 세션은 없습니다 — 목록에서 이유를 확인하세요.';
/** 「10월 16일 14:04 시작」: when the session started (two sessions of one project and AI are told apart by it). */
export const restartRowStarted = (createdAt: string) => { const at = phoneDateTime(createdAt); return at ? `${at} 시작` : ''; };
/**
 * A row's name: its title, or 「project · AI」. When two rows of the offer share that name, the start time follows it
 * (w14 review: two sessions of one project and AI were indistinguishable, and a summary could not say which one stopped).
 */
export function restartRowLabeler<R extends { id: string; createdAt: string }>(rows: readonly R[], base: (row: R) => string): (row: R) => string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(base(row), (counts.get(base(row)) ?? 0) + 1);
  return row => { const name = base(row), started = restartRowStarted(row.createdAt); return (counts.get(name) ?? 0) > 1 && started ? `${name} (${started})` : name; };
}
/** One short phrase per row: why it can or cannot be opened. */
export const RESTART_AVAILABILITY_PHRASE: Record<WorkroomRestartAvailability, string> = {
  ready: '이어 열 수 있음',
  check: '열기 전에 저장된 대화를 확인함',
  'in-flight': '여는 중',
  pending: '이어 열기 결과 확인 필요',
  running: '다시 열림',
  'open-elsewhere': '다른 작업 세션에서 열려 있음',
  unsupported: '이 AI는 이어 열기를 지원하지 않음',
  unsaved: '첫 요청 전에 끝나 저장된 대화 없음',
  ambiguous: '같은 시간대 대화가 여럿이라 고를 수 없음',
  legacy: '이전 버전 기록이라 대화를 특정할 수 없음',
  'project-changed': '프로젝트 폴더가 바뀜',
  'account-changed': 'CLI 로그인 상태가 바뀜',
  unprepared: '프로젝트·CLI 계정을 찾지 못함',
};
export const RESTART_BYPASS_LINE = '승인 없이 실행 (권한 우회)으로 열었던 세션도 우회 없이 열립니다.';
export const RESTART_ROW_BYPASS = '승인 없이 실행 (권한 우회)이었음 · 우회 없이 열림';
export const RESTART_DISMISS_HINT = '닫아도 저장된 대화에서 이어 열 수 있습니다.';
export const RESTART_SETTLE_WARNING = '작업 세션 목록에서 이 대화가 열려 있지 않은 것을 확인했다면 누르세요. 이미 열려 있는데 누르면 같은 대화가 두 번 열릴 수 있습니다.';
export const RESTART_SETTLE_DONE = '확인했습니다. 이 대화를 다시 이어 열 수 있습니다.';
export const restartConfirmText = (count: number) => `이 Mac에서 ${count}개 대화를 다시 엽니다 · 권한 우회 없음`;
/** One row's 「이어 열기」 confirms like the batch (w14 review): which conversation, here, without the bypass. */
export const restartConfirmOneText = (label: string) => `이 Mac에서 「${label}」 대화를 다시 엽니다 · 권한 우회 없음`;
export const restartProgressText = (done: number, total: number) => `${Math.min(done + 1, total)}/${total} 여는 중`;
const firstSentence = (text: string) => (text.split(/(?<=[.!?])\s/)[0] ?? text).replace(/[.。]\s*$/, '');
/** 「2개를 다시 열었습니다 · 1개는 첫 요청 전에 끝나 저장된 대화가 없습니다」. */
export function restartBatchSummary(result: RestartBatchResult, label: (row: RestartBatchResult['opened'][number]['row']) => string): string {
  const parts: string[] = [];
  if (result.opened.length) parts.push(`${result.opened.length}개를 다시 열었습니다 — 작업 세션 목록에서 여세요`);
  const reasons = new Map<string, number>();
  for (const skipped of result.skipped) { const reason = firstSentence(skipped.reason); reasons.set(reason, (reasons.get(reason) ?? 0) + 1); }
  for (const [reason, count] of reasons) parts.push(`${count}개는 ${reason}`);
  if (result.stopped) parts.push(`${label(result.stopped.row)}의 결과를 확인하지 못해 멈췄습니다. 요청을 다시 보내지 않았습니다`);
  return parts.length ? parts.join(' · ') + '.' : '다시 열 대화가 없었습니다.';
}

/* ── The phone (w14, Build B) ─────────────────────────────────────────────────────────────────────────────────────── */
/** One phrase per row on the phone: the Mac's, plus what this phone may not do. `pending` is settled on the Mac. */
export const REMOTE_RESTART_AVAILABILITY_PHRASE: Record<RemoteRestartAvailability, string> = {
  ...RESTART_AVAILABILITY_PHRASE,
  pending: 'Mac에서 이어 열기 결과 확인 필요',
  grant: '이어 열기 권한 없음',
  account: '다른 CLI 계정 · 계정 선택 권한 필요',
};
/** The reason a saved conversation cannot be opened from the phone, instead of a bare 「이어 열 수 없음」. */
export function remoteHistoryWhyPhrase(why: RemoteHistoryWhy): string {
  return why === 'running' ? '실행 중 · 작업 세션 목록에서 여세요' : REMOTE_RESTART_AVAILABILITY_PHRASE[why];
}
/** Folded, the banner is one button: 「업데이트 전 작업 세션 3개 · 이어 열기」. `count` is every session it lists. */
export function remoteRestartCollapsedLabel(count: number, update: boolean, runnable: boolean): string {
  return `${update ? '업데이트 전' : '앱을 다시 열기 전'} 작업 세션 ${count}개 · ${runnable ? '이어 열기' : '보기'}`;
}
export const REMOTE_RESTART_OFFER_SENTENCE = '앱이 다시 시작되며 함께 끝난 작업 세션입니다. 저장된 대화를 연결한 Mac에서 이어서 엽니다.';
/** Nothing here opens from this phone: the sentence that follows says why (a permission, or each row's phrase). */
export const REMOTE_RESTART_OFFER_NONE_SENTENCE = '앱이 다시 시작되며 함께 끝난 작업 세션입니다.';
export const REMOTE_RESTART_NONE_REASON = '지금 이 휴대폰에서 이어 열 수 있는 세션은 없습니다 — 목록에서 이유를 확인하세요.';
export const REMOTE_RESTART_GRANT_SENTENCE = '이어 열기 권한이 없습니다 · Mac의 외부 인터넷 QR 원격제어에서 ‘저장된 대화 이어 열기’를 허용하세요';
/** A phone without ‘워크룸 대화 기록 보기’: it is told how many, never which (w14 review — the banner was silent). */
export const REMOTE_RESTART_READ_SENTENCE = '대화 기록 권한이 없어 어떤 세션인지 보이지 않습니다 · Mac의 외부 인터넷 QR 원격제어에서 ‘워크룸 대화 기록 보기’와 ‘저장된 대화 이어 열기’를 허용하세요';
export const REMOTE_RESTART_DISMISS_HINT = '닫으면 Mac과 다른 기기에서도 사라집니다. 저장된 대화에서 이어 열 수 있습니다.';
export const REMOTE_RESTART_HIDE_HINT = '이 휴대폰에서만 숨깁니다. Mac과 다른 기기에는 그대로 남습니다.';
export const REMOTE_RESTART_MORE_HINT = '일부만 보입니다. 나머지는 「대화 기록」이나 Mac에서 열 수 있습니다.';
