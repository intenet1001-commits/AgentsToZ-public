import {isWorkroomEffortMode,type WorkroomEffortMode} from './workroomEffortMode';
import {AI_TERMINAL_AGENTS, AI_TERMINAL_REQUEST_INVALID_CODE, AI_TERMINAL_UNKNOWN_REQUEST_ERROR, type AiTerminalAgent} from './aiTerminalProtocol';
import type {WorkroomEffortLevel, WorkroomEffortReason, WorkroomEffortTier} from './workroomEffortPolicy';
import type {WorkroomEffortRecord, WorkroomEffortSkip} from './workroomEffortSession';

/**
 * 「에포트 자동」 on screen (w16 Build B). One view of the Mac setting and one session's record, the same on every Workroom
 * screen: this Mac's main window and pop-outs, a phone (the 「새 작업」 sheet and the full-screen session view) and another
 * community Mac. It rides only the `workroom.effort` workspace action (src/mobileWorkspaceProtocol.ts) — never
 * `AiTerminalSummary`, whose phone normalizer rejects unknown keys. Browser-safe: no node imports.
 */
export interface WorkroomEffortSessionView {
  agent: AiTerminalAgent;
  mode?: WorkroomEffortMode;
  tier?: WorkroomEffortTier;
  reason?: WorkroomEffortReason;
  level?: WorkroomEffortLevel;
  origin?: 'launch' | 'restart' | 'runtime';
  skipped?: WorkroomEffortSkip;
  seen?: string;
  manual: boolean;
  runtimeStatus?: 'applied' | 'deferred' | 'unsupported' | 'unconfirmed';
  advice?: {tier: WorkroomEffortTier; reason: WorkroomEffortReason};
}
export interface WorkroomEffortView {auto: boolean; mode?: WorkroomEffortMode; session?: WorkroomEffortSessionView}

const TIERS: readonly WorkroomEffortTier[] = ['low', 'medium', 'high'];
const REASONS: readonly WorkroomEffortReason[] = ['concurrency', 'security', 'migration', 'unclear-failure', 'design-review', 'typo', 'wording', 'rename', 'translate', 'format', 'standard'];
const SKIPS: readonly WorkroomEffortSkip[] = ['recommend', 'off', 'no-request', 'unclassified', 'unsupported', 'restricted', 'history-resume', 'env-override', 'model-unknown', 'manual'];
/** An effort word a CLI printed (`cliInfoFromScreen`): short, lowercase. Anything else is not vouched for and is dropped. */
const SEEN = /^[a-z][a-z0-9-]{0,15}$/;

/** What a community Mac is told when it tries to change another Mac's setting (src/agentDialogueControl.ts). */
export const WORKROOM_EFFORT_COMMUNITY_REFUSAL = '다른 기기의 에포트 자동 설정은 그 기기 화면에서만 바꿀 수 있습니다.';
/** Shown in place of the mode selector on a panel driving another community Mac. */
export const WORKROOM_EFFORT_ELSEWHERE = '다른 Mac의 설정입니다 — 그 Mac 화면에서 바꿉니다. 여기서 여는 작업도 그 Mac의 설정을 따릅니다.';

export const WORKROOM_EFFORT_TIER_LABELS: Readonly<Record<WorkroomEffortTier, string>> = {low: '낮음', medium: '보통', high: '높음'};
export const WORKROOM_EFFORT_REASON_LABELS: Readonly<Record<Exclude<WorkroomEffortReason, 'standard'>, string>> = {
  concurrency: '동시성', security: '보안·권한', migration: '데이터 마이그레이션', 'unclear-failure': '원인 불명 실패', 'design-review': '설계·리뷰',
  typo: '오타', wording: '문구', rename: '이름 바꾸기', translate: '번역', format: '서식',
};
const SKIP_TEXT: Readonly<Record<Exclude<WorkroomEffortSkip, 'manual'>, string>> = {
  recommend: '에포트 추천제공',
  off: '에포트 미선택 · CLI 기본값',
  'no-request': '에포트 자동 · 첫 요청이 없어 CLI 기본값',
  unclassified: '에포트 자동 · 명령으로 시작해 CLI 기본값',
  unsupported: '에포트 자동 · Antigravity는 지원 안 함',
  restricted: '에포트 자동 · 대직 세션은 적용 안 함',
  'history-resume': '에포트 자동 · 기록에서 이어 열어 CLI 기본값',
  'env-override': '에포트 자동 · CLAUDE_CODE_EFFORT_LEVEL 설정이 우선',
  'model-unknown': '에포트 자동 · 모델을 확인하지 못해 CLI 기본값',
};
const MANUAL_TEXT = '에포트 직접 설정 · 다음 요청에서 자동 판단';
/** How each CLI changes effort itself while it runs — the advice says it; nothing is typed for the person. */
const CHANGE_HINT: Readonly<Partial<Record<AiTerminalAgent, string>>> = {
  claude: '바꾸려면 「에포트 변경」', codex: '바꾸려면 「모델·에포트 변경」', hermes: '바꾸려면 터미널에서 /reasoning',
};

const reasonSuffix = (reason: WorkroomEffortReason | undefined) => reason && reason !== 'standard' ? ` (${WORKROOM_EFFORT_REASON_LABELS[reason]})` : '';
const levelWord = (level: string) => (TIERS as readonly string[]).includes(level) ? WORKROOM_EFFORT_TIER_LABELS[level as WorkroomEffortTier] : level;

/** The receipt next to the model/effort the CLI shows; null when the session has no decision to report. */
export function workroomEffortBadgeText(session: WorkroomEffortSessionView | undefined): string | null {
  if (!session) return null;
  // A level without a tier is one the person pinned at launch (a 팀 작전 member): the Mac's mode does not apply to it.
  if (session.level && !session.tier) {
    if (session.manual) return '에포트 직접 설정';
    const requested = `에포트 요청 · ${levelWord(session.level)}`;
    return session.seen ? `${requested} · CLI 표시 ${levelWord(session.seen)}` : `${requested} · 적용 확인 전`;
  }
  if (session.mode === 'off') return '에포트 미선택 · CLI 설정 사용';
  if (session.mode === 'recommend') return '에포트 추천제공';
  if (session.manual || session.skipped === 'manual') return MANUAL_TEXT;
  if (session.runtimeStatus === 'unconfirmed') return '에포트 자동 변경 · 확인 필요';
  if (session.runtimeStatus === 'deferred') return '에포트 자동 변경 · 입력 대기';
  // Auto ON and the last request left the CLI at its current effort (neither pending nor unconfirmed): say the change was
  // not made, never the earlier level as if Auto had just set it (2026-10-30). An override that forbids it keeps its reason.
  if (notAdjusted(session) && session.skipped !== 'env-override') return '에포트 자동 · 이번 요청은 변경 안 함';
  if (session.level) {
    const seen = session.seen && session.seen !== session.level ? ` · CLI 표시 ${session.seen}` : '';
    return `에포트 자동${session.origin === 'runtime' ? ' 변경' : ''} · ${levelWord(session.level)}${reasonSuffix(session.reason)}${seen}`;
  }
  return session.skipped ? SKIP_TEXT[session.skipped] : null;
}

/** Auto ON and advice left by the last request that is neither pending nor unconfirmed: Auto did not change the level. */
const notAdjusted = (session: WorkroomEffortSessionView) => session.mode === 'auto' && !!session.advice && session.runtimeStatus !== 'deferred' && session.runtimeStatus !== 'unconfirmed';

/** A later whole request seemed to need another level. Advice only: the CLI is never switched for the person. */
export function workroomEffortAdviceText(session: WorkroomEffortSessionView | undefined): string | null {
  if (!session?.advice || session.manual || session.mode === 'off' || session.level && !session.tier) return null;
  const hint = CHANGE_HINT[session.agent];
  if (!hint) return null;
  const current = session.seen ?? session.level;
  // Under Auto this states the effort only — whether the request itself was typed is its submission receipt's to say.
  if (notAdjusted(session)) return `에포트는 지금${current ? ` ${levelWord(current)}` : ''} 그대로입니다 · 이번 요청의 권장 ${WORKROOM_EFFORT_TIER_LABELS[session.advice.tier]}${reasonSuffix(session.advice.reason)}으로 바꾸지 않았습니다 · ${hint}`;
  return `이번 요청은 ${WORKROOM_EFFORT_TIER_LABELS[session.advice.tier]}이 맞아 보입니다${reasonSuffix(session.advice.reason)}${current ? ` · 지금 ${levelWord(current)}` : ''} · ${hint}`;
}

/** Appended to the launch-options button once the Mac has answered (`supported` true). */
export function workroomEffortOptionsSuffix(supported: boolean | null, auto: boolean | null): string {
  return supported === true && auto !== null ? (auto ? ' · 에포트 자동' : ' · 에포트 자동 꺼짐') : '';
}

/** The host side: the record without what stays on the Mac (session id, advice time, the change-line baseline). */
export function workroomEffortView(auto: boolean, record?: WorkroomEffortRecord, mode?: WorkroomEffortMode, extended = false): WorkroomEffortView {
  if (!record) return {auto, ...(mode ? {mode} : {})};
  const session: WorkroomEffortSessionView = {agent: record.agent, manual: !!record.manual, ...(mode ? {mode} : {})};
  if (record.tier) session.tier = record.tier;
  if (record.reason) session.reason = record.reason;
  // Both legacy and v2 peers have strict low/medium/high readers. Until a newer protocol
  // capability is negotiated, preserve their schema; the team status carries the exact pin.
  if (record.level && (extended || (TIERS as readonly string[]).includes(record.level))) session.level = record.level;
  // An older phone has a strict reader: only the explicitly negotiated v2 response may carry new fields/enums.
  if (record.origin && (mode || record.origin !== 'runtime')) session.origin = record.origin;
  if (mode && record.runtimeStatus) session.runtimeStatus = record.runtimeStatus;
  if (record.skipped && (mode || record.skipped !== 'recommend')) session.skipped = record.skipped;
  if (typeof record.seen === 'string' && SEEN.test(record.seen)) session.seen = record.seen;
  if (record.advice) session.advice = {tier: record.advice.tier, reason: record.advice.reason};
  // Key order fixed so the same record always serializes the same way.
  const ordered = {agent: session.agent, ...(mode ? {mode} : {}), ...(session.tier ? {tier: session.tier} : {}), ...(session.reason ? {reason: session.reason} : {}),
    ...(session.level ? {level: session.level} : {}), ...(session.origin ? {origin: session.origin} : {}), ...(session.skipped ? {skipped: session.skipped} : {}),
    ...(session.runtimeStatus ? {runtimeStatus: session.runtimeStatus} : {}), ...(session.seen ? {seen: session.seen} : {}), manual: session.manual, ...(session.advice ? {advice: session.advice} : {})} as WorkroomEffortSessionView;
  return {auto, ...(mode ? {mode} : {}), session: ordered};
}

/** Strict reader for what a Mac answers: exactly these keys and values (an unknown key rejects the whole answer). */
export function normalizeWorkroomEffortView(value: unknown): WorkroomEffortView {
  const fail = (): never => { throw new Error('에포트 자동 응답 형식이 올바르지 않습니다.'); };
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!plain(value) || Object.keys(value).some(k => k !== 'auto' && k !== 'session' && k !== 'mode') || typeof value.auto !== 'boolean') return fail();
  if (value.mode !== undefined && (!isWorkroomEffortMode(value.mode) || value.auto !== (value.mode === 'auto'))) return fail();
  const mode = isWorkroomEffortMode(value.mode) ? value.mode : undefined;
  if (value.session === undefined) return {auto: value.auto, ...(mode ? {mode} : {})};
  const s = value.session;
  if (!plain(s) || Object.keys(s).some(k => !['agent', 'mode', 'tier', 'reason', 'level', 'origin', 'skipped', 'seen', 'manual', 'advice', 'runtimeStatus'].includes(k))) return fail();
  if (s.mode !== undefined && (!isWorkroomEffortMode(s.mode) || s.mode !== mode)) return fail();
  if (!(AI_TERMINAL_AGENTS as readonly unknown[]).includes(s.agent) || typeof s.manual !== 'boolean') return fail();
  if (s.tier !== undefined && !(TIERS as readonly unknown[]).includes(s.tier)) return fail();
  if (s.level !== undefined && !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(s.level as string)) return fail();
  if (s.reason !== undefined && !(REASONS as readonly unknown[]).includes(s.reason)) return fail();
  if (s.skipped !== undefined && !(SKIPS as readonly unknown[]).includes(s.skipped)) return fail();
  if (s.origin !== undefined && s.origin !== 'launch' && s.origin !== 'restart' && s.origin !== 'runtime') return fail();
  if (s.runtimeStatus !== undefined && !['applied','deferred','unsupported','unconfirmed'].includes(s.runtimeStatus as string)) return fail();
  if (s.seen !== undefined && (typeof s.seen !== 'string' || !SEEN.test(s.seen))) return fail();
  if (s.advice !== undefined) {
    const a = s.advice;
    if (!plain(a) || Object.keys(a).some(k => k !== 'tier' && k !== 'reason') || !(TIERS as readonly unknown[]).includes(a.tier) || !(REASONS as readonly unknown[]).includes(a.reason)) return fail();
  }
  return {auto: value.auto, ...(mode ? {mode} : {}), session: s as unknown as WorkroomEffortSessionView};
}

/**
 * The refusal of a Mac (or sidecar, or forwarding Mac) that predates `workroom.effort`: its strict request check rejects the
 * action. The screen then hides the option and the receipt instead of showing an error. A network failure is not this.
 */
const OLDER_HOST_MESSAGES = new Set([
  '모바일 작업 요청 형식이 올바르지 않습니다.', '지원하지 않는 모바일 작업입니다.', '원격 터미널 요청이 올바르지 않습니다.',
  '터미널 요청 형식이 올바르지 않습니다.', AI_TERMINAL_UNKNOWN_REQUEST_ERROR,
]);
export function workroomEffortUnsupported(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as {code?: unknown; message?: unknown};
  return value.code === AI_TERMINAL_REQUEST_INVALID_CODE || (typeof value.message === 'string' && OLDER_HOST_MESSAGES.has(value.message));
}
