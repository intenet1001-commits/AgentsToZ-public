import type {WorkroomEffortMode} from './workroomEffortMode';
import type {AiTerminalAgent} from './aiTerminalProtocol';
import {cliInfoFromScreen} from './workroomCliCommands';
import {
  WORKROOM_EFFORT_SUPPORT,
  classifyWorkroomEffort,
  workroomEffortLevel,
  workroomEffortRank,
  workroomEffortRequestText,
  type WorkroomEffortLevel,
  type WorkroomEffortReason,
  type WorkroomEffortTier,
} from './workroomEffortPolicy';

/**
 * Host-only 「에포트 자동」 state of one Workroom session (w16). It never rides `AiTerminalSummary` — phone normalizers
 * reject unknown keys — and is read only through the local `effort` operation.
 */

/** Why auto passed no flag at launch. */
export type WorkroomEffortSkip =
  | 'recommend' // recommendations only; never changes the CLI
  | 'off' // the Mac setting is off
  | 'no-request' // started without a first request (「새 터미널」), or a restart of such a session
  | 'unclassified' // the first request was a CLI command, a skill or a shell escape
  | 'unsupported' // Antigravity: effort is coupled to its model choice
  | 'restricted' // a restricted (CS duty) launch keeps its own rules
  | 'history-resume' // a conversation reopened from history
  | 'env-override' // CLAUDE_CODE_EFFORT_LEVEL in the launch environment wins over the flag
  | 'model-unknown' // Codex: the model is not proven to offer the level (src/codexEffortModel.ts)
  | 'manual'; // legacy peers may still report a manual pause

export interface WorkroomEffortAdvice {tier: WorkroomEffortTier; reason: WorkroomEffortReason; at: string}
export interface WorkroomEffortState {
  /** What the first request needed (also kept when no flag could be passed). */
  tier?: WorkroomEffortTier;
  reason?: WorkroomEffortReason;
  /** The level applied at launch or by a confirmed session-only runtime change. */
  level?: WorkroomEffortLevel;
  origin?: 'launch' | 'restart' | 'runtime';
  skipped?: WorkroomEffortSkip;
  /** The effort the CLI shows on its screen, when read (Claude footer, Codex banner). It may differ: a CLI clamps. */
  seen?: string;
  /** A native selection was observed. Auto mode re-evaluates it at the next whole request. */
  manual: boolean;
  /** A later whole request needs another level; recommendations and unsupported runtime paths expose advice. */
  advice?: WorkroomEffortAdvice;
  /** Effort-change lines on the last rows read — the baseline for noticing a new one. Host-only, never reported. */
  phraseLines?: string[];
  /** Host-only: sampler must not mistake our confirmed control writes for a manual override. */
  automaticPending?: boolean;
  runtimeStatus?: 'applied' | 'deferred' | 'unsupported' | 'unconfirmed';
}
export type WorkroomEffortRecord = Omit<WorkroomEffortState, 'phraseLines' | 'automaticPending'> & {sessionId: string; agent: AiTerminalAgent};

export interface WorkroomEffortPlanInput {
  agent: AiTerminalAgent;
  /** The person's first request as sent (before `#` references are added). */
  prompt?: string;
  auto: boolean;
  mode?: WorkroomEffortMode;
  restricted: boolean;
  historyResume: boolean;
  /** 「다시 시작」: the state of the session it replaces. */
  previous?: WorkroomEffortState;
  /** Claude only: CLAUDE_CODE_EFFORT_LEVEL is set in the launch environment. */
  envOverride: boolean;
  /** Codex only, asked lazily: the levels its model is proven to offer, or null when unproven. */
  codexAllowed?: () => readonly string[] | null;
}

/** The launch decision. `level` present ⇔ a flag is passed. */
export function planWorkroomEffort(input: WorkroomEffortPlanInput): WorkroomEffortState {
  if (input.restricted) return {manual: false, skipped: 'restricted'};
  if (input.historyResume) return {manual: false, skipped: 'history-resume'};
  if (WORKROOM_EFFORT_SUPPORT[input.agent] !== 'launch') return {manual: false, skipped: 'unsupported'};
  if ((input.mode ?? (input.auto ? 'auto' : 'off')) === 'off') return {manual: false, skipped: 'off'};
  const restart = !!input.previous;
  let decision: {tier: WorkroomEffortTier; reason: WorkroomEffortReason} | null;
  if (restart) {
    // The tier of the replaced launch; the CLI-side checks below run again (the environment or config may have changed).
    const previous = input.previous!;
    decision = previous.tier && previous.reason ? {tier: previous.tier, reason: previous.reason} : null;
    if (!decision) return {manual: false, skipped: previous.skipped === 'unclassified' ? 'unclassified' : 'no-request'};
  } else {
    if (input.prompt === undefined) return {manual: false, skipped: 'no-request'};
    decision = classifyWorkroomEffort(workroomEffortRequestText(input.prompt));
    if (!decision) return {manual: false, skipped: 'unclassified'};
  }
  const chosen = {...decision, manual: false} as WorkroomEffortState;
  if (input.mode === 'recommend') return {...chosen, skipped: 'recommend', advice: {...decision, at: new Date().toISOString()}};
  if (input.agent === 'claude' && input.envOverride) return {...chosen, skipped: 'env-override'};
  const allowed = input.agent === 'codex' ? input.codexAllowed?.() ?? null : undefined;
  if (allowed === null) return {...chosen, skipped: 'model-unknown'};
  const level = workroomEffortLevel(input.agent, decision.tier, allowed);
  if (!level) return {...chosen, skipped: 'model-unknown'};
  return {...chosen, level, origin: restart ? 'restart' : 'launch'};
}

/** The CLI's own effort or model picker, typed by the person (or a composer/footer button). */
const MANUAL_COMMANDS: Partial<Record<AiTerminalAgent, RegExp>> = {
  claude: /^\/(?:effort|model)(?:\s|$)/,
  codex: /^\/model(?:\s|$)/,
  hermes: /^\/(?:reasoning|model|omh-model)(?:\s|$)/,
};
export function workroomEffortInputIsManual(agent: AiTerminalAgent, text: string): boolean {
  const command = MANUAL_COMMANDS[agent];
  return !!command && command.test(text.replace(/[\r\n]+$/, '').trim().toLowerCase());
}

/**
 * Lines a CLI prints when its effort or model changed (Claude 2.1.301, Codex 0.162.1). A line that was not there on
 * the previous read means the person changed it — the first read is only the baseline, so a resumed transcript that
 * still shows an old change does not count. (Codex can also change effort with a key chord, which never reaches
 * the input path; its banner effort changing is caught by `seen` below.)
 */
const CHANGE_LINES: Partial<Record<AiTerminalAgent, RegExp>> = {
  claude: /^(?:⎿\s*)?(?:Set effort level to|Kept effort level as|Effort level set to auto|Set model to)\b/,
  codex: /^(?:•\s*)?Model changed to\b/,
};
const PHRASE_LINES_KEPT = 16;

/** Called by the activity sampler with rows it already read (only after new output). */
export function observeWorkroomEffortScreen(state: WorkroomEffortState, agent: AiTerminalAgent, rows: readonly string[]): void {
  if (state.automaticPending) return;
  const change = CHANGE_LINES[agent];
  if (change) {
    const lines = rows.map(row => row.trim()).filter(row => change.test(row));
    if (state.phraseLines && lines.some(line => !state.phraseLines!.includes(line))) state.manual = true;
    state.phraseLines = lines.slice(-PHRASE_LINES_KEPT);
  }
  if (agent === 'claude' || agent === 'codex' || agent === 'hermes') {
    const effort = cliInfoFromScreen(agent, rows).effort;
    if (effort) {
      // The first effort shown is the CLI's answer to the launch flag (a clamp is shown, not «fixed»); a later
      // different one outside automaticPending is recorded as a native selection.
      if (state.seen !== undefined && state.seen !== effort) state.manual = true;
      state.seen = effort;
    }
  }
  if (state.manual) state.advice = undefined;
}

/**
 * Advice on a whole-request submission: record the tier this request seems to need when it differs from what the
 * session runs at (`seen`, else the launch level). A CLI command keeps the advice as it was; a request that fits
 * clears it. Auto ON also re-evaluates a previous manual or higher level. Unknown current level: advise only low/high.
 */
export function noteWorkroomEffortRequest(state: WorkroomEffortState, agent: AiTerminalAgent, text: string, auto: boolean, at: string): void {
  if (WORKROOM_EFFORT_SUPPORT[agent] !== 'launch') return;
  if (!auto) { state.advice = undefined; return; }
  const decision = classifyWorkroomEffort(workroomEffortRequestText(text));
  if (!decision) return;
  state.manual = false;
  const current = workroomEffortRank(state.seen ?? state.level);
  const need = workroomEffortRank(decision.tier)!;
  const differs = current === null ? decision.tier !== 'medium' : need !== current;
  state.advice = differs ? {tier: decision.tier, reason: decision.reason, at} : undefined;
}

export function workroomEffortRecord(sessionId: string, agent: AiTerminalAgent, state: WorkroomEffortState | undefined): WorkroomEffortRecord {
  const {phraseLines: _baseline, automaticPending: _pending, ...rest} = state ?? {manual: false};
  return {sessionId, agent, ...rest, ...(rest.advice ? {advice: {...rest.advice}} : {})};
}
