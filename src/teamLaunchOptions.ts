/**
 * 팀원 실행 선택의 공통 정본 — 팀 실행 계약 v1 (2026-10-25, 사용자 확정: 「워크룸 팀 구성창과 MCP가 같은 실행 엔진으로 같은 옵션을
 * 쓴다」 · 「프로젝트 열기의 모든 실행 표면을 팀원으로 남긴다 — 워크룸으로 대신 열지 않는다」).
 *
 * - 규칙: 팀원 수·모델 이름·에포트·세션 ID (src/workroomTeamInstruction.ts가 같은 이름으로 다시 내보낸다 — 기존 import는 그대로).
 * - 실행 위치 9종과 그 위치에서 프로젝트 열기가 실제로 받는 옵션. 판정은 기존 정본을 다시 쓴다: 터미널 선택지·Claude --bg·tmux
 *   (src/terminalDefaults.ts), 재사용(src/agentLaunchPolicy.ts), 권한 우회(src/opsLaunchOptions.ts), 앱 대화(src/codeAppLaunchChoices.ts),
 *   계정(src/cliAccountProtocol.ts), 에포트(src/workroomEffortPolicy.ts).
 * - 엄격한 팀원 파서와 버전이 붙은 선택 블록: 구성기가 고른 값을 자연어 재서술에 맡기지 않고 그대로 실어 나른다.
 *
 * 브라우저 안전·말단 모듈이다. 「Hermes · Claude/Codex」 변형은 여기서 따로 다루지 않는다 — 계약상 그 변형은 top-level
 * model + provider다(src/hermesVariants.ts가 그 값을 정한다). 기본 Hermes의 `hermesVariant: 'default'`는 JSON 선택 표식으로만
 * 검증하고 canonical 멤버에서 생략한다. hermesVariants는 workroomTeamInstruction을 가져오므로, 이 모듈이 그 둘을 가져오면 순환이 생긴다.
 */
import {AI_TERMINAL_AGENTS, type AiTerminalAgent} from './aiTerminalProtocol';
import {describeAgentLaunchPolicy} from './agentLaunchPolicy';
import {CLI_ACCOUNT_AGENTS, cliAccountId} from './cliAccountProtocol';
import {projectConversationLaunchCommand, visibleProjectConversationChoices} from './codeAppLaunchChoices';
import {opsLaunchBypassSupported} from './opsLaunchOptions';
import {isClaudeBgAvailable, terminalAppChoices, terminalOptionDefaults, tmuxReach, type OrcaLaunchSurface, type TerminalApp} from './terminalDefaults';
import {WORKROOM_APP_NAMES} from './workroomAppRoute';
import {WORKROOM_EFFORT_AUTO_LEVELS, WORKROOM_EFFORT_SUPPORT, type WorkroomEffortLevel} from './workroomEffortPolicy';
import {teamEffortLevels} from './teamEffortCatalog';

export const TEAM_MAX_MEMBERS = 6;
/** Host-only model choice for one launch (src/aiTerminalLaunchArgs.ts). Hermes alone also takes a provider. */
export interface AiTerminalLaunchModel { model: string; provider?: string }
export const LAUNCH_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,79}$/;
export function launchModelError(agent: AiTerminalAgent, choice: AiTerminalLaunchModel): string | null {
  if (!LAUNCH_MODEL_NAME.test(choice.model)) return '모델 이름은 영문·숫자와 . _ : / @ - 로 80자까지 씁니다.';
  if (choice.provider !== undefined && (agent !== 'hermes' || !LAUNCH_MODEL_NAME.test(choice.provider))) return 'provider는 Hermes에서만, 모델 이름과 같은 글자로 씁니다.';
  return null;
}

/**
 * A member's effort: absent is 「자동」 — this Mac's 에포트 자동 decides from the member's task, as for any Workroom (w16) —
 * and a level pins it for that member's session. The selected model limits explicit levels separately from auto;
 * agy's fixed level selects a known variant of the same model family.
 */
/** Superset for protocol schemas; use teamEffortLevels for a specific model. */
export const TEAM_EFFORT_LEVELS: readonly WorkroomEffortLevel[] = [...WORKROOM_EFFORT_AUTO_LEVELS, 'xhigh', 'max', 'ultra'];
export const teamEffortSupported = (agent: AiTerminalAgent) => WORKROOM_EFFORT_SUPPORT[agent] === 'launch' || agent === 'agy';
export function teamEffortError(agent: AiTerminalAgent, effort: unknown, model?: string, surface?: TeamLaunchSurface, provider?: string): string | null {
  if (!(teamEffortLevels(agent, model, surface, provider) as readonly unknown[]).includes(effort)) return '선택한 모델에서 확인된 에포트를 고르거나 비웁니다(자동).';
  if (agent === 'agy' && !model?.endsWith(`-${effort}`)) return 'Antigravity 모델 변형과 에포트가 일치해야 합니다.';
  return null;
}

/**
 * A Workroom session id, as the terminal itself accepts it (the `id` rule in src/aiTerminalProtocol.ts). 팀 작전 names
 * sessions in two places — create_team's `sessionId` and 팀 현황's request — and both must agree with the submission
 * path, or a brief is refused halfway through its own submission instead of at the request.
 */
export const TEAM_SESSION_ID = /^[A-Za-z0-9_-]{8,160}$/;
/** `reviewer`: a read-only member — it reads the others' branches (or the scope in its task) and reports findings, never commits. */
export type TeamMemberRole = 'worker' | 'reviewer';
/** create_team's member name and task bounds (src/workroomTeam.ts). */
export const TEAM_MEMBER_NAME = /^[a-z][a-z0-9-]{0,23}$/;
export const TEAM_MEMBER_TASK_MAX = 4_000;

/** Where 「프로젝트 열기」 can run an AI. `internal` is the Workroom; `app` is the provider's desktop app (`/api/open-code-app`). */
export const TEAM_LAUNCH_SURFACES = ['internal', 'orca-floating', 'orca-worktree', 'cmux', 'iterm', 'terminal', 'powershell', 'wsl', 'app'] as const;
export type TeamLaunchSurface = typeof TEAM_LAUNCH_SURFACES[number];
export const TEAM_LAUNCH_REUSE = ['new', 'reuse-or-new'] as const;
export type TeamLaunchReuse = typeof TEAM_LAUNCH_REUSE[number];
export const TEAM_APP_MODES = ['new', 'reopen', 'open'] as const;
export type TeamAppMode = typeof TEAM_APP_MODES[number];
export interface TeamLaunchOptions { bgMode?: boolean; tmuxMode?: boolean; reuse?: TeamLaunchReuse; appMode?: TeamAppMode }

/** The instruction's (Korean) name of each surface; product names stay as they are. */
export const TEAM_SURFACE_NAME: Readonly<Record<TeamLaunchSurface, string>> = {
  internal: '워크룸', 'orca-floating': 'Orca 플로팅', 'orca-worktree': 'Orca 사이드바', cmux: 'cmux', iterm: 'iTerm', terminal: 'Terminal',
  powershell: 'PowerShell', wsl: 'WSL', app: '데스크톱 앱',
};
/** A surface as a person reads it for one AI: the desktop app is that AI's own app. */
export const teamSurfaceName = (surface: TeamLaunchSurface, agent: AiTerminalAgent) => surface === 'app' ? WORKROOM_APP_NAMES[agent] : TEAM_SURFACE_NAME[surface];

/** The header's terminal choice behind a surface (src/terminalDefaults.ts). The desktop app is no terminal. */
export function teamSurfaceTerminal(surface: TeamLaunchSurface): {app: TerminalApp; orca?: OrcaLaunchSurface} | null {
  if (surface === 'app') return null;
  if (surface === 'orca-floating') return {app: 'orca', orca: 'floating'};
  if (surface === 'orca-worktree') return {app: 'orca', orca: 'worktree'};
  return {app: surface};
}
export const teamSurfaceOf = (app: TerminalApp, orca: OrcaLaunchSurface = 'floating'): TeamLaunchSurface =>
  app === 'orca' ? (orca === 'worktree' ? 'orca-worktree' : 'orca-floating') : app;

/**
 * The surfaces this platform offers: the header's terminal list plus the desktop apps. The Workroom is always there for a
 * team — the builder lives inside one, so this host runs it — even where the header leaves it out (terminalDefaults.ts
 * still says Windows has no Workroom PTY, while aiTerminalService.ts spawns node-pty there).
 */
export function teamLaunchSurfacesFor(windows: boolean): TeamLaunchSurface[] {
  const terminals = terminalAppChoices(windows).flatMap((app): TeamLaunchSurface[] => app === 'orca' ? ['orca-floating', 'orca-worktree'] : [teamSurfaceOf(app)]);
  return TEAM_LAUNCH_SURFACES.filter(surface => surface === 'internal' || surface === 'app' || terminals.includes(surface));
}

/** What project open takes on a surface for an AI. False is «no such option there» — never a hidden default. */
export interface TeamLaunchSupport {
  /** Host-only model (and Hermes provider) and a pinned effort ride a Workroom start (src/aiTerminalLaunchArgs.ts); Claude on
   * Orca also takes a model and an effort, as a request whose application is not verified (src/teamExternalHost.ts). */
  model: boolean; provider: boolean; effort: boolean;
  /** A CLI account profile: Workroom start of Codex or Claude. */
  account: boolean;
  bypass: boolean;
  /** Claude --bg (Agent View) and tmux: the external terminal routes that have them. */
  bg: boolean; tmux: boolean;
  /** Whether `reuse` applies at all (external terminal routes); `reuse-or-new` also needs teamLaunchReuseAvailable. */
  reuse: boolean;
  appModes: readonly TeamAppMode[];
}
const route = (surface: TeamLaunchSurface) => surface === 'internal' ? null : teamSurfaceTerminal(surface);
// The desktop app's conversation choices, as the project page offers them (new/recent for Codex, open/recent for Hermes Desktop).
function appModesOf(agent: AiTerminalAgent): TeamAppMode[] {
  if (agent !== 'codex' && agent !== 'hermes') return [];
  const app = agent;
  return visibleProjectConversationChoices(app, 'found').flatMap(choice => projectConversationLaunchCommand(app, choice)?.mode ?? []);
}
export function teamLaunchSupport(surface: TeamLaunchSurface, agent: AiTerminalAgent): TeamLaunchSupport {
  const internal = surface === 'internal', terminal = route(surface);
  // Orca's public CLI starts this exact Claude argv in the member checkout. Its actual
  // session setting is still unverified until observed, especially with env overrides.
  const orcaClaude = agent === 'claude' && (surface === 'orca-floating' || surface === 'orca-worktree');
  return {
    model: internal || orcaClaude, provider: internal && agent === 'hermes', effort: (internal && teamEffortSupported(agent)) || orcaClaude,
    account: internal && (CLI_ACCOUNT_AGENTS as readonly string[]).includes(agent),
    // Every Workroom CLI has a bypass flag (src/aiTerminalLaunchArgs.ts). The terminal routes pass it for Claude, Codex and agy;
    // Hermes' cmux and terminal launches never do (App.tsx openHermesMain). Orca and the Claude app: src/opsLaunchOptions.ts.
    bypass: internal || (surface === 'app' || surface === 'orca-floating' || surface === 'orca-worktree' ? opsLaunchBypassSupported(agent, surface) : agent !== 'hermes'),
    bg: agent === 'claude' && !!terminal && isClaudeBgAvailable(terminal.app, terminal.orca),
    // Hermes has no tmux launch, and cmux routes only Claude through tmux (App.tsx openCodexMain·openAntigravityMain·openHermesMain).
    tmux: !!terminal && tmuxReach(terminal.app, false, terminal.orca) !== 'none' && agent !== 'hermes' && (surface !== 'cmux' || agent === 'claude'),
    reuse: !!terminal,
    appModes: surface === 'app' ? appModesOf(agent) : [],
  };
}

/** What a launch actually uses: Claude --bg returns before the tmux branch (App.tsx openClaudeMain), so bg wins for Claude. */
function effectiveOptions(surface: TeamLaunchSurface, agent: AiTerminalAgent, options: TeamLaunchOptions) {
  const support = teamLaunchSupport(surface, agent), bg = support.bg && options.bgMode === true;
  return {bg, tmux: support.tmux && options.tmuxMode === true && !bg};
}
/** `reuse-or-new` only where the surface can find the member's window again (src/agentLaunchPolicy.ts). */
export function teamLaunchReuseAvailable(surface: TeamLaunchSurface, agent: AiTerminalAgent, options: TeamLaunchOptions = {}): boolean {
  const terminal = route(surface);
  if (!terminal) return false;
  const {bg, tmux} = effectiveOptions(surface, agent, options);
  return !bg && describeAgentLaunchPolicy({terminalApp: terminal.app, orcaLaunchMode: terminal.orca, tmuxMode: tmux}).reuse === 'reuse-or-new';
}

/**
 * The options a member starts with when the person picks a surface: project open's own defaults for that terminal
 * (terminalOptionDefaults), a fresh window, and the app's first conversation choice. Permission bypass is not among them —
 * a member runs without approval only when the person turns it on for that member.
 */
export function teamLaunchDefaults(surface: TeamLaunchSurface, agent: AiTerminalAgent): TeamLaunchOptions {
  const support = teamLaunchSupport(surface, agent), terminal = route(surface), defaults = terminal ? terminalOptionDefaults(terminal.app, terminal.orca) : null;
  return normalizeTeamLaunchOptions(surface, agent, {
    ...(support.bg && defaults ? {bgMode: defaults.bgMode} : {}), ...(support.tmux && defaults ? {tmuxMode: defaults.tmuxMode} : {}),
    ...(support.reuse ? {reuse: 'new' as const} : {}), ...(support.appModes[0] ? {appMode: support.appModes[0]} : {}),
  });
}
/**
 * Options the surface takes, with the combinations the parser refuses repaired the way project open resolves them: a Claude
 * with --bg drops tmux, a window that cannot be found again is always new, an unknown app mode is the app's first.
 */
export function normalizeTeamLaunchOptions(surface: TeamLaunchSurface, agent: AiTerminalAgent, options: TeamLaunchOptions): TeamLaunchOptions {
  const support = teamLaunchSupport(surface, agent);
  const bgMode = support.bg && options.bgMode !== undefined ? options.bgMode : undefined;
  const tmuxMode = support.tmux && options.tmuxMode !== undefined ? options.tmuxMode && bgMode !== true : undefined;
  const reuse = support.reuse ? (options.reuse === 'reuse-or-new' && teamLaunchReuseAvailable(surface, agent, {bgMode, tmuxMode}) ? 'reuse-or-new' : 'new') : undefined;
  const appMode = options.appMode && support.appModes.includes(options.appMode) ? options.appMode : support.appModes[0];
  return {...(bgMode !== undefined ? {bgMode} : {}), ...(tmuxMode !== undefined ? {tmuxMode} : {}), ...(reuse ? {reuse} : {}), ...(appMode ? {appMode} : {})};
}

/**
 * How a member on this surface is run once started — the three states the team shows:
 * - `managed` 자동 관리: the host instructs it and reads its results (the Workroom; Orca through its CLI send/read).
 * - `awaiting-connection` 연결 대기: a control path exists but must be confirmed first (cmux's control socket).
 * - `manual` 수동 합류: the launcher only opens it — a terminal window, a desktop app (Codex fills its composer, unsent),
 *   or Claude --bg (a fixed start prompt, status only). A person confirms the start and reports for it.
 * Opening, prefilling or copying never counts as working.
 */
export type TeamLaunchManagement = 'managed' | 'awaiting-connection' | 'manual';
export type TeamLaunchManagementReason = 'workroom' | 'orca-cli' | 'cmux-control' | 'claude-bg' | 'app-prefill' | 'app-open' | 'terminal';
export function teamLaunchManagement(surface: TeamLaunchSurface, agent: AiTerminalAgent, options: TeamLaunchOptions = {}): {management: TeamLaunchManagement; reason: TeamLaunchManagementReason} {
  if (surface === 'internal') return {management: 'managed', reason: 'workroom'};
  if (effectiveOptions(surface, agent, options).bg) return {management: 'manual', reason: 'claude-bg'};
  if (surface === 'orca-floating' || surface === 'orca-worktree') return {management: 'managed', reason: 'orca-cli'};
  if (surface === 'cmux') return {management: 'awaiting-connection', reason: 'cmux-control'};
  if (surface === 'app') return {management: 'manual', reason: agent === 'codex' ? 'app-prefill' : 'app-open'};
  return {management: 'manual', reason: 'terminal'};
}

/**
 * One member as the builder selects it and create_team receives it (contract v1): the legacy top-level fields plus
 * `accountId`, `bypassPermissions`, `surface` and `launchOptions`. Parsed members are canonical — `surface` is absent for
 * the Workroom (legacy absence means `internal`), `bypassPermissions` appears only as `true`, empty values are dropped —
 * so the same choice always reads and fingerprints the same.
 *
 * `computerUseApprovals` (desktop app members only, appears only as `true`): the person let the leader answer this app
 * member's one-time approvals (folder trust for the team's own worktree, run once) with an application-scoped computer
 * session. It is a leader permission, not a launch option: it starts nothing and never covers always-allow, bypass,
 * network/full access, login or macOS system prompts, which stay with the person.
 */
export interface TeamMemberSelection {
  agent: AiTerminalAgent; task?: string; name?: string; model?: string; provider?: string; effort?: WorkroomEffortLevel; role?: 'reviewer'; sessionId?: string;
  accountId?: string; bypassPermissions?: boolean; surface?: TeamLaunchSurface; launchOptions?: TeamLaunchOptions; computerUseApprovals?: boolean;
}
export const TEAM_MEMBER_SELECTION_KEYS = ['agent', 'task', 'name', 'model', 'provider', 'hermesVariant', 'effort', 'role', 'sessionId', 'accountId', 'bypassPermissions', 'surface', 'launchOptions', 'computerUseApprovals'] as const;
export const TEAM_LAUNCH_OPTION_KEYS = ['bgMode', 'tmuxMode', 'reuse', 'appMode'] as const;
const unknownKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).filter(key => !keys.includes(key));
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Strict: an unknown field, a value a surface does not take, or a combination project open would not run is refused, never dropped. */
export function parseTeamMemberSelection(raw: unknown, index = 0): TeamMemberSelection {
  const fail = (message: string): never => { throw new Error(`팀원 ${index + 1}: ${message}`); };
  if (!isRecord(raw)) return fail('객체가 필요합니다.');
  const extra = unknownKeys(raw, TEAM_MEMBER_SELECTION_KEYS);
  if (extra.length) fail(`알 수 없는 필드: ${extra.join(', ')}`);
  if (!AI_TERMINAL_AGENTS.includes(raw.agent as AiTerminalAgent)) fail(`AI는 ${AI_TERMINAL_AGENTS.join('·')} 중 하나입니다.`);
  const agent = raw.agent as AiTerminalAgent;
  // This raw selection marker confirms plain Hermes; provider presets remain model + provider from the shared mapper.
  if (Object.hasOwn(raw, 'hermesVariant') && (agent !== 'hermes' || raw.hermesVariant !== 'default' || Object.hasOwn(raw, 'model') || Object.hasOwn(raw, 'provider')))
    fail("hermesVariant는 모델·provider를 지정하지 않은 Hermes의 'default' 표식만 받습니다.");
  if (raw.task !== undefined && (typeof raw.task !== 'string' || new TextEncoder().encode(raw.task.trim()).length > TEAM_MEMBER_TASK_MAX)) fail(`작업은 UTF-8 ${TEAM_MEMBER_TASK_MAX}바이트까지의 글입니다.`);
  if (typeof raw.task === 'string' && /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw.task.trim())) fail('작업에 제어 문자를 쓸 수 없습니다.');
  if (raw.name !== undefined && (typeof raw.name !== 'string' || !TEAM_MEMBER_NAME.test(raw.name))) fail('이름은 영문 소문자로 시작하고 a-z·0-9·- 로 24자까지 씁니다.');
  if (raw.role !== undefined && raw.role !== 'worker' && raw.role !== 'reviewer') fail(`role은 'worker' 또는 'reviewer'입니다.`);
  const task = typeof raw.task === 'string' ? raw.task.trim() : '';
  const base: TeamMemberSelection = {agent, ...(task ? {task} : {}), ...(raw.name !== undefined ? {name: raw.name as string} : {})};
  const role = raw.role === 'reviewer' ? {role: 'reviewer' as const} : {};
  if (raw.sessionId !== undefined) {
    if (typeof raw.sessionId !== 'string' || !TEAM_SESSION_ID.test(raw.sessionId)) fail('sessionId가 올바르지 않습니다.');
    // An open session joins with the settings it runs with: a fresh launch choice would silently not apply.
    const launch = ['model', 'provider', 'hermesVariant', 'effort', 'accountId', 'bypassPermissions', 'launchOptions', 'computerUseApprovals'].filter(key => raw[key] !== undefined);
    if (raw.surface !== undefined && raw.surface !== 'internal') launch.push('surface');
    if (launch.length) fail(`열린 세션(sessionId)은 그 세션의 설정 그대로 합류합니다. ${launch.join('·')}를 빼세요.`);
    return {...base, ...role, sessionId: raw.sessionId as string};
  }
  const surface = (raw.surface === undefined ? 'internal' : raw.surface) as TeamLaunchSurface;
  if (!TEAM_LAUNCH_SURFACES.includes(surface)) fail(`실행 위치는 ${TEAM_LAUNCH_SURFACES.join('·')} 중 하나입니다.`);
  const support = teamLaunchSupport(surface, agent), where = teamSurfaceName(surface, agent);
  let model: AiTerminalLaunchModel | null = null;
  if (raw.model !== undefined) {
    if (!support.model) fail(`${where}에서는 모델을 고르지 않습니다(워크룸과 Orca의 Claude에서만).`);
    if (typeof raw.model !== 'string' || raw.provider !== undefined && typeof raw.provider !== 'string') fail('model·provider는 글자입니다.');
    model = {model: raw.model as string, ...(raw.provider !== undefined ? {provider: raw.provider as string} : {})};
    const error = launchModelError(agent, model);
    if (error) fail(error);
  } else if (raw.provider !== undefined) fail('provider는 model과 함께 씁니다.');
  if (raw.effort !== undefined) {
    if (!support.effort) fail(`${where}에서는 에포트를 고르지 않습니다.`);
    const error = teamEffortError(agent, raw.effort, model?.model, surface, model?.provider);
    if (error) fail(error);
  }
  if (raw.accountId !== undefined) {
    if (!support.account) fail(surface === 'internal' ? 'CLI 계정은 Codex·Claude만 고릅니다.' : `${where}에서는 계정을 고르지 않습니다(워크룸에서만).`);
    if (!cliAccountId(raw.accountId)) fail('accountId가 올바르지 않습니다.');
  }
  if (raw.bypassPermissions !== undefined && typeof raw.bypassPermissions !== 'boolean') fail('bypassPermissions는 true 또는 false입니다.');
  if (raw.bypassPermissions === true && !support.bypass) fail(`${where}의 ${agent}는 권한 우회를 받지 않습니다.`);
  if (raw.computerUseApprovals !== undefined && typeof raw.computerUseApprovals !== 'boolean') fail('computerUseApprovals는 true 또는 false입니다.');
  if (raw.computerUseApprovals === true && surface !== 'app') fail('컴퓨터 유즈 1회성 승인은 데스크톱 앱 팀원에만 켭니다(터미널 팀원은 키 입력으로 답합니다).');
  const launchOptions = raw.launchOptions === undefined ? {} : parseTeamLaunchOptions(raw.launchOptions, surface, agent, fail);
  return {...base, ...(model ?? {}), ...(raw.effort !== undefined ? {effort: raw.effort as WorkroomEffortLevel} : {}), ...role,
    ...(raw.accountId !== undefined ? {accountId: raw.accountId as string} : {}), ...(raw.bypassPermissions === true ? {bypassPermissions: true} : {}),
    ...(surface !== 'internal' ? {surface} : {}), ...(Object.keys(launchOptions).length ? {launchOptions} : {}),
    ...(raw.computerUseApprovals === true ? {computerUseApprovals: true} : {})};
}

function parseTeamLaunchOptions(raw: unknown, surface: TeamLaunchSurface, agent: AiTerminalAgent, fail: (message: string) => never): TeamLaunchOptions {
  if (!isRecord(raw)) return fail('launchOptions는 객체입니다.');
  const extra = unknownKeys(raw, TEAM_LAUNCH_OPTION_KEYS);
  if (extra.length) fail(`알 수 없는 실행 옵션: ${extra.join(', ')}`);
  const support = teamLaunchSupport(surface, agent), where = teamSurfaceName(surface, agent);
  for (const key of ['bgMode', 'tmuxMode'] as const) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') fail(`${key}는 true 또는 false입니다.`);
  if (raw.bgMode !== undefined && !support.bg) fail(`Claude --bg는 Claude의 지원 터미널 경로에서만 씁니다(${where}의 ${agent}는 없음).`);
  if (raw.tmuxMode !== undefined && !support.tmux) fail(`tmux는 그 AI가 tmux로 뜨는 터미널 경로에서만 씁니다(${where}의 ${agent}는 없음).`);
  if (raw.bgMode === true && raw.tmuxMode === true) fail('Claude --bg는 tmux를 거치지 않습니다. 둘 중 하나만 켜세요.');
  const options = {bgMode: raw.bgMode as boolean | undefined, tmuxMode: raw.tmuxMode as boolean | undefined};
  if (raw.reuse !== undefined) {
    if (!TEAM_LAUNCH_REUSE.includes(raw.reuse as TeamLaunchReuse)) fail(`reuse는 ${TEAM_LAUNCH_REUSE.join('·')} 중 하나입니다.`);
    if (!support.reuse) fail(`reuse는 외부 터미널 경로에서만 씁니다(${where}는 없음).`);
    if (raw.reuse === 'reuse-or-new' && !teamLaunchReuseAvailable(surface, agent, options)) fail(`${where}에서는 이 팀원의 창을 다시 찾을 수 없어 항상 새 창입니다.`);
  }
  if (raw.appMode !== undefined) {
    if (!TEAM_APP_MODES.includes(raw.appMode as TeamAppMode)) fail(`appMode는 ${TEAM_APP_MODES.join('·')} 중 하나입니다.`);
    if (!support.appModes.includes(raw.appMode as TeamAppMode)) fail(support.appModes.length ? `${where}의 대화 선택은 ${support.appModes.join('·')} 중 하나입니다.` : `${where}은(는) 대화 선택을 받지 않습니다.`);
  }
  return {...(options.bgMode !== undefined ? {bgMode: options.bgMode} : {}), ...(options.tmuxMode !== undefined ? {tmuxMode: options.tmuxMode} : {}),
    ...(raw.reuse !== undefined ? {reuse: raw.reuse as TeamLaunchReuse} : {}), ...(raw.appMode !== undefined ? {appMode: raw.appMode as TeamAppMode} : {})};
}

/**
 * The builder's selection as data (contract v1 `draft`): a versioned block in the composed instruction that the host and the
 * leader read with parseTeamSelectionBlock instead of trusting an AI to restate the choices. Its members are create_team's.
 */
export const TEAM_SELECTION_KIND = 'agentstoz-team-selection';
export const TEAM_SELECTION_VERSION = 1;
export interface TeamSelection { kind: typeof TEAM_SELECTION_KIND; version: typeof TEAM_SELECTION_VERSION; members: TeamMemberSelection[] }
export function parseTeamSelection(raw: unknown): TeamSelection {
  if (!isRecord(raw)) throw new Error('팀 선택은 객체입니다.');
  const extra = unknownKeys(raw, ['kind', 'version', 'members']);
  if (extra.length) throw new Error(`팀 선택에 알 수 없는 필드: ${extra.join(', ')}`);
  if (raw.kind !== TEAM_SELECTION_KIND) throw new Error(`팀 선택 종류는 ${TEAM_SELECTION_KIND}입니다.`);
  if (raw.version !== TEAM_SELECTION_VERSION) throw new Error(`팀 선택 버전 ${String(raw.version)}은(는) 이 앱이 읽지 못합니다(지원: ${TEAM_SELECTION_VERSION}).`);
  if (!Array.isArray(raw.members) || raw.members.length < 1 || raw.members.length > TEAM_MAX_MEMBERS) throw new Error(`팀원은 1명부터 ${TEAM_MAX_MEMBERS}명까지입니다.`);
  const members = raw.members.map((member, index) => parseTeamMemberSelection(member, index));
  const joined = members.flatMap(member => member.sessionId ? [member.sessionId] : []);
  if (new Set(joined).size !== joined.length) throw new Error('같은 열린 세션을 두 팀원으로 넣을 수 없습니다.');
  return {kind: TEAM_SELECTION_KIND, version: TEAM_SELECTION_VERSION, members};
}

const FENCE = '```';
/** A fenced JSON block, one member per line. Fresh choices explicitly confirm their surface and plain Hermes default;
 * canonical parsing still omits those defaults. Backticks are written as \u0060 so a task can never close the fence early. */
export function teamSelectionBlock(members: readonly unknown[]): string {
  const selection = parseTeamSelection({kind: TEAM_SELECTION_KIND, version: TEAM_SELECTION_VERSION, members});
  const explicit = selection.members.map(member => member.sessionId ? member : {...member, surface: member.surface ?? 'internal',
    ...(member.agent === 'hermes' && member.model === undefined && member.provider === undefined ? {hermesVariant: 'default'} : {})});
  const json = `{"kind":${JSON.stringify(selection.kind)},"version":${selection.version},"members":[\n${explicit.map(member => JSON.stringify(member)).join(',\n')}\n]}`;
  return `${FENCE}${TEAM_SELECTION_KIND}\n${json.replace(/`/g, '\\u0060')}\n${FENCE}`;
}
/** Exactly one block, or an error: none and two are both ambiguous about what the person chose. */
export function parseTeamSelectionBlock(text: string): TeamSelection {
  const blocks = [...text.matchAll(new RegExp(`^${FENCE}${TEAM_SELECTION_KIND}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n${FENCE}[ \\t]*$`, 'gm'))];
  if (blocks.length !== 1) throw new Error(blocks.length ? '팀 선택 블록이 둘 이상입니다.' : '팀 선택 블록이 없습니다.');
  let raw: unknown;
  try { raw = JSON.parse(blocks[0]![1]!); } catch { throw new Error('팀 선택 블록의 JSON을 읽지 못했습니다.'); }
  return parseTeamSelection(raw);
}

export const TEAM_LAUNCH_MANAGEMENT_NAME: Readonly<Record<TeamLaunchManagement, string>> = {managed: '자동 관리', 'awaiting-connection': '연결 대기', manual: '수동 합류'};
const MANAGEMENT_REASON: Readonly<Record<TeamLaunchManagementReason, string>> = {
  workroom: '워크룸이 지시와 보고를 맡습니다', 'orca-cli': 'Orca CLI로 지시하고 화면을 읽습니다',
  'cmux-control': 'cmux 제어 연결이 확인된 뒤에 지시합니다', 'claude-bg': 'Claude --bg는 고정 문구로 시작하고 상태만 보입니다',
  'app-prefill': 'Codex 앱 입력칸에 채우기만 하고 보내지 않습니다', 'app-open': '앱은 열리지만 작업을 받지 않습니다',
  terminal: '터미널 창에는 지시·결과 연결이 없습니다',
};
const APP_MODE_NAME: Readonly<Record<TeamAppMode, string>> = {new: '새 대화', reopen: '최근 대화 다시 열기', open: '앱 열기'};
/**
 * The launch part of a member's line in the leader instruction: only what differs from a plain Workroom, so a legacy member's
 * line reads exactly as before. `accountLabel` names the account for the person; the id is what create_team takes.
 */
export function teamLaunchText(member: TeamMemberSelection, accountLabel?: string): string {
  if (member.sessionId) return '';
  const surface = member.surface ?? 'internal', options = member.launchOptions ?? {}, parts: string[] = [];
  if (surface !== 'internal') parts.push(`실행 위치 ${teamSurfaceName(surface, member.agent)}(${surface})`);
  if (surface !== 'internal' && member.effort) parts.push(`에포트 ${member.effort} 요청 · 실제 적용 확인 필요`);
  if (member.accountId) parts.push(`계정 ${accountLabel ? `「${accountLabel}」` : ''}(accountId ${member.accountId})`);
  if (member.bypassPermissions) parts.push('권한 우회');
  if (options.bgMode !== undefined) parts.push(options.bgMode ? 'Claude --bg' : 'Claude --bg 끔');
  if (options.tmuxMode !== undefined) parts.push(options.tmuxMode ? 'tmux' : 'tmux 끔');
  if (options.reuse) parts.push(options.reuse === 'reuse-or-new' ? '기존 창 재사용' : '새 창');
  if (options.appMode) parts.push(APP_MODE_NAME[options.appMode]);
  if (member.computerUseApprovals) parts.push('리더가 1회성 승인만 컴퓨터 유즈로 응답 가능');
  if (surface !== 'internal') {
    const {management, reason} = teamLaunchManagement(surface, member.agent, options);
    parts.push(`${TEAM_LAUNCH_MANAGEMENT_NAME[management]}: ${MANAGEMENT_REASON[reason]}`);
  }
  return parts.join(' · ');
}
