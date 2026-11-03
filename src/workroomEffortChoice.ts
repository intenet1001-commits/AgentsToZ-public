import {createHash} from 'node:crypto';
import type {AiTerminalAgent} from './aiTerminalProtocol';
import {cliInfoFromScreen} from './workroomCliCommands';
import {teamCodexEffortLevels, teamHermesEffortLevels} from './teamEffortCatalog';
import type {WorkroomEffortLevel} from './workroomEffortPolicy';
import type {WorkroomEffortState} from './workroomEffortSession';

/**
 * A person's session-only effort choice for one running Workroom session (agentstoz_use_set_workroom_effort, MCP 1.81.0).
 *
 * What it is: the person (through the agent they talk to) picks one level from the levels this session's CLI and model
 * offer; the host changes it with the CLI's own session-only control (src/workroomEffortRuntime.ts — Claude's slider and
 * `s`, Codex's reasoning shortcuts, Hermes `/reasoning <level>` without --global) and reads the CLI's screen back.
 * What it is not: a desktop-app connector (Codex/Claude/Hermes/Antigravity apps stay unconnected — src/desktopEffortNative.ts),
 * a model, provider or account change, a global default, another conversation, or a new prompt.
 *
 * Priority and lifetime: a choice holds until the person releases it (`auto`), changes effort natively in that CLI (that
 * newer native choice wins), or the CLI process ends — a 「다시 시작」 goes back to the Mac's policy. While it holds, 「에포트
 * 자동」 neither changes the level nor advises. A level pinned when a 팀 작전 member started is the team builder's choice and
 * is not changed here. The Mac's mode (auto/recommend/off) does not hold an explicit choice back, as with a team pin.
 */
export {WORKROOM_EFFORT_CHOICE_LEVELS, type WorkroomEffortChoiceLevel} from './workroomEffortChoiceLevels';
import type {WorkroomEffortChoiceLevel} from './workroomEffortChoiceLevels';

/** Host-only: the person's choice and what it replaced (restored when it ends). Never reported — strict readers. */
export interface WorkroomEffortChosen {
  level: WorkroomEffortLevel;
  requestId: string;
  at: string;
  replaced: Pick<WorkroomEffortState, 'tier' | 'reason' | 'level' | 'origin' | 'skipped'>;
}

export type WorkroomEffortChoiceUnsupported =
  | 'not-running' // exited or closing
  | 'previous-outcome-unknown' // an earlier choice typed keys without a confirmed result: this CLI process takes no more
  | 'agy-model-variant' // Antigravity: effort is a model variant; changing it changes the model
  | 'restricted' // a restricted (CS duty) session keeps its own rules
  | 'team-pinned' // a 팀 작전 member's pinned level belongs to the team builder
  | 'env-override' // CLAUDE_CODE_EFFORT_LEVEL in its environment wins over any session change
  | 'cli-control-unavailable' // this CLI build has no session-only control (Claude picker, Codex default keys)
  | 'model-no-effort' // its model takes no reasoning level (Hermes · anthropic Haiku)
  | 'screen-unavailable' // no headless screen to read the effort back from
  | 'effort-not-shown'; // the CLI has not shown its effort: a change could not be counted from it or read back

export const WORKROOM_EFFORT_CHOICE_UNSUPPORTED_TEXT: Readonly<Record<WorkroomEffortChoiceUnsupported, string>> = {
  'not-running': '종료됐거나 종료 중인 세션입니다.',
  'previous-outcome-unknown': '이전 에포트 선택의 결과를 확인하지 못했습니다. 이 CLI에서는 더 바꾸지 않습니다 — 원본 워크룸 화면을 확인하고, 필요하면 CLI에서 직접 바꾸거나 「다시 시작」하세요.',
  'agy-model-variant': 'Antigravity는 에포트가 모델 변형과 묶여 있어 모델을 바꾸지 않고는 바꿀 수 없습니다.',
  restricted: '대직(제한 실행) 세션은 자기 규칙을 유지합니다.',
  'team-pinned': '팀 구성에서 고정한 강도입니다. 팀 구성에서 바꾸세요.',
  'env-override': 'CLAUDE_CODE_EFFORT_LEVEL 환경 변수가 세션 변경보다 우선합니다.',
  'cli-control-unavailable': '이 CLI 버전에는 세션 한정 에포트 변경 제어가 없습니다.',
  'model-no-effort': '이 모델은 추론 강도를 받지 않습니다.',
  'screen-unavailable': '세션 화면을 읽을 수 없어 적용 결과를 확인할 수 없습니다.',
  'effort-not-shown': 'CLI가 아직 현재 강도를 화면에 보여 주지 않아 바꾼 결과를 확인할 수 없습니다. 강도가 표시된 뒤 다시 조회하세요.',
};

export interface WorkroomEffortChoiceInput {
  sessionId: string;
  agent: AiTerminalAgent;
  /** The CLI's process id: another process (a restart is also another session id) never matches a binding. */
  pid: number;
  accountId?: string;
  launchModel?: {model: string; provider?: string};
  inputRevision: number;
  running: boolean;
  /** The current screen rows, or null when unreadable. */
  rows: readonly string[] | null;
  hasScreen: boolean;
  state?: WorkroomEffortState;
  restricted: boolean;
  /** Claude: CLAUDE_CODE_EFFORT_LEVEL is set in the session's environment. */
  envOverride: boolean;
  /** Claude: thinking is off (CLAUDE_CODE_DISABLE_THINKING=1 or MAX_THINKING_TOKENS=0) — xhigh/max end its turns. */
  thinkingOff: boolean;
  support: {claudeSessionPicker: boolean; codexDefaultKeys: boolean};
  /** Codex: the read-only config proof (src/codexEffortModel.ts) — which catalog model this session was launched on. */
  codexProof?: {model: string | null; allowed: readonly WorkroomEffortLevel[]};
  /** The requestId of an earlier choice whose typed keys were never confirmed on this CLI process. */
  outcomeUnknown?: string;
}

export interface WorkroomEffortChoiceView {
  sessionId: string;
  agent: AiTerminalAgent;
  supported: boolean;
  unsupportedReason?: WorkroomEffortChoiceUnsupported;
  unsupportedText?: string;
  /** The model the CLI shows, else the one chosen at launch. */
  model?: string;
  /** Only when chosen at launch (Hermes · provider presets); never inferred. */
  provider?: string;
  /** Opaque account id from list_workroom_accounts, when the session runs on a registered account. */
  accountId?: string;
  /** The effort the CLI shows: on its screen now, or last observed there (Claude hides its effort row after a turn). */
  current?: string;
  currentFrom?: 'screen' | 'last-observed';
  /** With previous-outcome-unknown: the requestId whose result to check. */
  originalRequestId?: string;
  /** The person's choice that is holding, if any. */
  chosen?: WorkroomEffortLevel;
  /** The levels to offer, in order. `auto` (release) is offered only while a choice holds. */
  choices: WorkroomEffortChoiceLevel[];
  inputRevision: number;
  /** Pass back unchanged with the chosen level: any change of process, account, model, effort, choice or input refuses. */
  binding: string;
}

const LMH: readonly WorkroomEffortLevel[] = ['low', 'medium', 'high'];
const ALL: readonly WorkroomEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Claude Code shows 「Opus 5.5 · Claude …」 or 「Set model to Sonnet 5.5 …」; ids come from a launch choice. */
const CLAUDE_FULL = /^(?:claude-(?:opus|sonnet|haiku)-5-5|claude-fable-5-1|(?:opus|sonnet|haiku)\s+5\.5|fable\s+5\.1)\b/i;

/** The levels a person may choose for this session's CLI and model — never a level the session cannot take. */
export function workroomEffortChoiceLevels(input: Pick<WorkroomEffortChoiceInput, 'agent' | 'launchModel' | 'thinkingOff' | 'codexProof'>, shownModel?: string): readonly WorkroomEffortLevel[] {
  if (input.agent === 'claude') {
    if (input.thinkingOff) return LMH;
    const model = shownModel ?? input.launchModel?.model;
    // The slider itself lists the model's levels and the runtime cancels a level it does not show; an unidentified
    // model offers only the levels every Claude model takes (the B11 rule for an unproven Workroom model).
    return model && CLAUDE_FULL.test(model.trim()) ? ALL : LMH;
  }
  if (input.agent === 'codex') {
    // Beyond low/medium/high only where Codex's own config proof names the very model the screen shows: a provider, base
    // URL, profile or in-session /model switch is unproven, and a level the model lacks would leave a shortcut half-done.
    const model = (shownModel ?? input.launchModel?.model)?.trim().toLowerCase();
    const proof = input.codexProof;
    return model && proof?.model && proof.model.toLowerCase() === model ? (teamCodexEffortLevels(proof.model) ?? LMH).filter(level => proof.allowed.includes(level)) : LMH;
  }
  if (input.agent === 'hermes') return teamHermesEffortLevels(input.launchModel?.model, input.launchModel?.provider);
  return [];
}

function unsupportedReason(input: WorkroomEffortChoiceInput, levels: readonly WorkroomEffortLevel[], current: string | undefined): WorkroomEffortChoiceUnsupported | undefined {
  if (!input.running) return 'not-running';
  if (input.outcomeUnknown) return 'previous-outcome-unknown';
  if (input.agent === 'agy') return 'agy-model-variant';
  if (input.restricted) return 'restricted';
  if (input.state?.pinned) return 'team-pinned';
  if (input.agent === 'claude' && input.envOverride) return 'env-override';
  if (input.agent === 'claude' && !input.support.claudeSessionPicker || input.agent === 'codex' && !input.support.codexDefaultKeys) return 'cli-control-unavailable';
  if (!levels.length) return 'model-no-effort';
  if (!input.hasScreen) return 'screen-unavailable';
  // Asked before the person picks: without a level to start from the runtime cannot count a change or prove it.
  if (!current) return 'effort-not-shown';
  return undefined;
}

const digest = (parts: readonly unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);

export function workroomEffortChoiceView(input: WorkroomEffortChoiceInput): WorkroomEffortChoiceView {
  const info = input.rows && input.agent !== 'agy' ? cliInfoFromScreen(input.agent, input.rows) : {};
  const shownModel = info.model?.trim() || undefined;
  const model = shownModel ?? input.launchModel?.model;
  const current = info.effort ?? input.state?.seen;
  const currentFrom = info.effort ? 'screen' as const : current ? 'last-observed' as const : undefined;
  const levels = workroomEffortChoiceLevels(input, shownModel);
  const reason = unsupportedReason(input, levels, current);
  const chosen = input.state?.chosen?.level;
  const choices: WorkroomEffortChoiceLevel[] = reason ? [] : [...levels, ...(chosen ? ['auto' as const] : [])];
  const provider = input.launchModel?.provider;
  return {
    sessionId: input.sessionId, agent: input.agent, supported: !reason,
    ...(reason ? {unsupportedReason: reason, unsupportedText: WORKROOM_EFFORT_CHOICE_UNSUPPORTED_TEXT[reason]} : {}),
    ...(reason === 'previous-outcome-unknown' ? {originalRequestId: input.outcomeUnknown} : {}),
    ...(model ? {model} : {}), ...(provider ? {provider} : {}), ...(input.accountId ? {accountId: input.accountId} : {}),
    ...(current ? {current, currentFrom} : {}), ...(chosen ? {chosen} : {}),
    choices, inputRevision: input.inputRevision,
    binding: digest(['workroom-effort-choice/1', input.sessionId, input.pid, input.agent, input.accountId ?? '', model ?? '', provider ?? '', current ?? '', chosen ?? '', input.inputRevision]),
  };
}

/** Record a confirmed choice: the record shows a level without a tier (as a pinned level), so no new key reaches a phone. */
export function holdWorkroomEffortChoice(state: WorkroomEffortState, level: WorkroomEffortLevel, requestId: string, at: string): void {
  const replaced = state.chosen?.replaced ?? {
    ...(state.tier ? {tier: state.tier} : {}), ...(state.reason ? {reason: state.reason} : {}), ...(state.level ? {level: state.level} : {}),
    ...(state.origin ? {origin: state.origin} : {}), ...(state.skipped ? {skipped: state.skipped} : {}),
  };
  state.chosen = {level, requestId, at, replaced};
  delete state.tier; delete state.reason; delete state.skipped; delete state.advice;
  state.level = level; state.origin = 'runtime'; state.seen = level; state.manual = false; state.runtimeStatus = 'applied';
}

/** End a choice and restore what it replaced. The CLI keeps the level it runs at; nothing is typed. */
export function releaseWorkroomEffortChoice(state: WorkroomEffortState): void {
  const chosen = state.chosen;
  if (!chosen) return;
  delete state.chosen;
  delete state.tier; delete state.reason; delete state.skipped; delete state.level; delete state.origin;
  Object.assign(state, chosen.replaced);
  delete state.runtimeStatus;
}

/** 「다시 시작」 starts a new CLI process: the choice ends there, and the restart is planned from what it replaced. */
export function workroomEffortRestartBase(state: WorkroomEffortState | undefined): WorkroomEffortState | undefined {
  if (!state?.chosen) return state;
  const copy: WorkroomEffortState = {...state};
  releaseWorkroomEffortChoice(copy);
  return copy;
}

/**
 * Why a choice was not applied. `typed` says whether any key reached the CLI: only OUTCOME_UNKNOWN has keys typed without a
 * confirmed result, and it stops further choices for that CLI process (the same requestId keeps answering it — never a replay).
 */
export type WorkroomEffortChoiceCode =
  | 'REQUEST_ID_CONFLICT' | 'BINDING_CHANGED' | 'UNSUPPORTED' | 'LEVEL_UNSUPPORTED'
  | 'NOT_READY' | 'NOT_APPLIED' | 'NOT_SENT' | 'OUTCOME_UNKNOWN' | 'BUSY';
export class WorkroomEffortChoiceError extends Error {
  constructor(readonly code: WorkroomEffortChoiceCode, message: string, readonly typed = false, readonly originalRequestId?: string) {
    super(message); this.name = 'WorkroomEffortChoiceError';
  }
}

export interface WorkroomEffortChoiceResult {
  /**
   * applied: the CLI's own control changed it and its screen shows the level now. held: it already ran at that level and
   * now holds it. released: the choice ended (the CLI keeps its current level; auto decides again at the next request).
   * not-held: `auto` asked when no choice held — nothing changed.
   */
  outcome: 'applied' | 'held' | 'released' | 'not-held';
  requested: WorkroomEffortChoiceLevel;
  /** The effort the CLI shows after the operation; `applied` is always proven on its screen by the runtime. */
  readback?: string;
  readbackFrom?: 'screen' | 'last-observed';
  view: WorkroomEffortChoiceView;
}
