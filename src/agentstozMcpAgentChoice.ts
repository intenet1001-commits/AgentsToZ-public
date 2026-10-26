/** MCP preparation only: no launch, host read, account lookup or inferred selection. */
import {AI_TERMINAL_AGENTS, type AiTerminalAgent} from './aiTerminalProtocol';
import {hermesVariantModel, launchChoiceLabel, launchChoiceTarget, workroomLaunchChoices, type HermesVariant} from './hermesVariants';
import {TEAM_LAUNCH_SURFACES, TEAM_MAX_MEMBERS, parseTeamMemberSelection, teamLaunchSurfacesFor, teamLaunchSupport, teamSurfaceName, type AiTerminalLaunchModel, type TeamLaunchSupport, type TeamLaunchSurface} from './teamLaunchOptions';
import {workroomAppConfirmMessage} from './workroomAppRoute';

export const AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE = 'Missing agent/surface/Hermes(default/Claude/Codex): agentstoz_use_prepare_agent_launch, ask and wait. Keep explicit choices/buttons/blocks. Infer nothing from current AI/tool names/defaults. Choose only on explicit delegation. Preparation never executes.';

type AgentChoice = {agent: AiTerminalAgent; label: string};
export interface McpAgentChoiceRequired {
  success: false; performed: false; selectionRequired: true; stage: 'agent'; effect: 'agent-selection-required';
  question: string; agents: AgentChoice[];
  /** Zero-based positions only; [] means that no team members were supplied. No member identity is invented. */
  missingMemberIndices?: number[];
}
type McpPreflightScope = {scope: 'launch'; toolName: 'agentstoz_use_start_workroom_session' | 'agentstoz_use_open_code_app'}
  | {scope: 'team'; toolName: 'agentstoz_use_create_team'}
  | {scope: 'team-member'; toolName: 'agentstoz_use_create_team'; memberIndex: number};
export type McpAgentChoicePreflight = (McpAgentChoiceRequired | McpAgentLaunchPreparation) & McpPreflightScope;
const scoped = (result: McpAgentChoiceRequired | McpAgentLaunchPreparation, scope: McpPreflightScope): McpAgentChoicePreflight => ({...result, ...scope});
const isRecord = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
  && (Object.getPrototypeOf(raw) === Object.prototype || Object.getPrototypeOf(raw) === null);
const isAgent = (raw: unknown): raw is AiTerminalAgent => typeof raw === 'string' && (AI_TERMINAL_AGENTS as readonly string[]).includes(raw);
const isSurface = (raw: unknown): raw is TeamLaunchSurface => typeof raw === 'string' && (TEAM_LAUNCH_SURFACES as readonly string[]).includes(raw);
const isVariant = (raw: unknown): raw is McpHermesVariant => raw === 'default' || raw === 'claude' || raw === 'codex';
const validExplicitChoices = (raw: Record<string, unknown>) => (raw.agent === undefined || isAgent(raw.agent))
  && (raw.surface === undefined || isSurface(raw.surface)) && (raw.hermesVariant === undefined || isVariant(raw.hermesVariant))
  && !(raw.agent !== undefined && raw.agent !== 'hermes' && raw.hermesVariant !== undefined);
const agentChoices = (): AgentChoice[] => workroomLaunchChoices().flatMap(choice => {
  const target = launchChoiceTarget(choice);
  return target.variant ? [] : [{agent: target.agent, label: launchChoiceLabel(choice)}];
});

/**
 * An omission preflight for existing execution tools. Invalid explicit agents and malformed teams still go through
 * their existing strict parser. The client must show the question and wait for the user's answer before executing.
 * Choosing a tool name is not evidence that a person selected its surface; natural-language ambiguity uses prepare.
 */
export function agentstozMcpAgentChoice(toolName: string, rawArgs: unknown, windows = false): McpAgentChoicePreflight | null {
  if (!isRecord(rawArgs)) return null;
  if (toolName === 'agentstoz_use_start_workroom_session' || toolName === 'agentstoz_use_open_code_app') {
    if (!validExplicitChoices(rawArgs)) return null; // Preserve strict validation of malformed explicit values.
    const scope: McpPreflightScope = {scope: 'launch', toolName}, surface = rawArgs.surface;
    if (surface !== undefined && !(toolName === 'agentstoz_use_start_workroom_session' ? surface === 'internal' : ['app', 'orca-floating', 'orca-worktree'].includes(surface as string))) {
      return scoped(refused('선택한 실행 위치는 이 실행 도구에서 지원하지 않습니다. 지원되는 실행 경로를 명시적으로 다시 골라 주세요.'), scope);
    }
    if (rawArgs.agent === undefined) return scoped({success: false, performed: false, selectionRequired: true, stage: 'agent', effect: 'agent-selection-required',
      question: '어떤 AI로 실행할까요? Codex, Claude Code, Hermes, Antigravity 중에서 골라 주세요.', agents: agentChoices()}, scope);
    const result = prepareMcpAgentLaunch({agent: rawArgs.agent, ...(surface !== undefined ? {surface} : {}), ...(rawArgs.hermesVariant !== undefined ? {hermesVariant: rawArgs.hermesVariant} : {})}, windows);
    return result.ready ? null : scoped(result, scope);
  }
  if (toolName !== 'agentstoz_use_create_team') return null;
  const members = rawArgs.members;
  if (members === undefined) return scoped({success: false, performed: false, selectionRequired: true, stage: 'agent', effect: 'agent-selection-required',
    question: '팀원을 어떤 AI들로 구성할까요? 각 팀원의 AI를 골라 주세요.', agents: agentChoices(), missingMemberIndices: []}, {scope: 'team', toolName});
  if (!Array.isArray(members) || !members.length || members.length > TEAM_MAX_MEMBERS
    || Array.from(members).some(member => !potentialMember(member, windows))) return null;
  for (const [memberIndex, member] of members.entries()) {
    if (member.agent === 'hermes' && member.surface !== undefined && member.hermesVariant !== undefined && member.hermesVariant !== 'default'
      && !teamLaunchSupport(member.surface as TeamLaunchSurface, 'hermes').provider) {
      return scoped(refused('이 실행 위치는 Hermes Claude·Codex 모델 지정을 지원하지 않습니다. 기본 설정을 고르거나 실행 위치를 명시적으로 다시 선택해 주세요.'), {scope: 'team-member', toolName, memberIndex});
    }
  }
  const missingMemberIndices = members.flatMap((member, index) => member.agent === undefined ? [index] : []);
  if (missingMemberIndices.length) return scoped({success: false, performed: false, selectionRequired: true, stage: 'agent', effect: 'agent-selection-required',
    question: `팀원 ${missingMemberIndices.map(index => index + 1).join(', ')}의 AI를 각각 골라 주세요.`, agents: agentChoices(), missingMemberIndices}, {scope: 'team-member', toolName, memberIndex: missingMemberIndices[0]!});
  // A joined Workroom keeps its current settings. Fresh members need the raw explicit selection markers: the
  // canonical parser deliberately removes internal/default markers, so its output cannot establish user intent.
  for (const stage of ['surface', 'variant'] as const) for (const [memberIndex, member] of members.entries()) {
    if (member.sessionId !== undefined || (stage === 'surface' ? member.surface !== undefined : member.agent !== 'hermes'
      || member.hermesVariant !== undefined || member.model !== undefined)) continue;
    const result = prepareMcpAgentLaunch({agent: member.agent, ...(member.surface !== undefined ? {surface: member.surface} : {}), ...(member.hermesVariant !== undefined ? {hermesVariant: member.hermesVariant} : {})}, windows);
    if (result.selectionRequired) return scoped({...result, question: `팀원 ${memberIndex + 1}: ${result.question}`}, {scope: 'team-member', toolName, memberIndex});
  }
  return null;
}

/** Validate explicit fields with the shared strict parser, without choosing a missing value. Candidate combinations
 * are used only to avoid hiding an invalid field behind a question; none is returned, persisted or executed. */
function potentialMember(raw: unknown, windows: boolean): raw is Record<string, unknown> {
  if (!isRecord(raw) || !validExplicitChoices(raw)) return false;
  const attached = raw.sessionId !== undefined, variant = raw.hermesVariant;
  if (variant !== undefined && (attached || raw.model !== undefined || raw.provider !== undefined)) return false;
  const agents = raw.agent !== undefined ? [raw.agent as AiTerminalAgent] : [...AI_TERMINAL_AGENTS];
  const surfaces = attached ? [raw.surface] : raw.surface !== undefined ? [raw.surface] : teamLaunchSurfacesFor(windows);
  for (const agent of agents) for (const surface of surfaces) {
    if (variant !== undefined && agent !== 'hermes') continue;
    const {hermesVariant: _variant, ...fields} = raw;
    try {
      parseTeamMemberSelection({...fields, agent, ...(surface !== undefined ? {surface} : {}),
        // An otherwise valid explicit external preset is refused by the preflight above, not sent to the host.
        // Validate its remaining external fields here; do not disguise malformed fields as a support refusal.
        ...(variant && variant !== 'default' && surface === 'internal' ? hermesVariantModel(variant as HermesVariant) : {})});
      return true;
    } catch { /* No compatible strict parse means the execution parser must report the original invalid input. */ }
  }
  return false;
}

export type McpHermesVariant = 'default' | HermesVariant;
export type McpAgentExecutionRoute = 'agentstoz_use_start_workroom_session' | 'agentstoz_use_open_code_app' | 'agentstoz_use_create_team';
export interface McpAgentLaunchDraft {agent?: AiTerminalAgent; surface?: TeamLaunchSurface; hermesVariant?: McpHermesVariant}
type Unchecked = {performed: false; preparationOnly: true; readiness: 'choices-only'; installation: 'not-checked'; credentials: 'not-checked'};
type AgentQuestion = {stage: 'agent'; effect: 'agent-selection-required'; choices: AgentChoice[]};
type SurfaceQuestion = {stage: 'surface'; effect: 'surface-selection-required'; choices: Array<{surface: TeamLaunchSurface; label: string; support: TeamLaunchSupport; executionRoutes: McpAgentExecutionRoute[]; singleLaunch: boolean; hermesVariantSupported?: boolean}>};
type VariantQuestion = {stage: 'variant'; effect: 'hermes-variant-selection-required'; executionRoutes: McpAgentExecutionRoute[]; choices: Array<{hermesVariant: McpHermesVariant; label: string; supported: boolean; unsupportedReason?: string}>};
export type McpAgentLaunchPreparation = Unchecked & (
  | ({success: false; ready: false; selectionRequired: true; question: string; draft: McpAgentLaunchDraft} & (AgentQuestion | SurfaceQuestion | VariantQuestion))
  | {success: true; ready: true; selectionRequired: false; effect: 'agent-launch-prepared'; note: string; draft: Required<Pick<McpAgentLaunchDraft, 'agent' | 'surface'>> & Pick<McpAgentLaunchDraft, 'hermesVariant'>; support: TeamLaunchSupport; executionRoutes: McpAgentExecutionRoute[]; singleLaunch: boolean; launchModel?: AiTerminalLaunchModel}
  | {success: false; ready: false; selectionRequired: false; effect: 'agent-launch-refused'; error: string}
);
const unchecked: Unchecked = {performed: false, preparationOnly: true, readiness: 'choices-only', installation: 'not-checked', credentials: 'not-checked'};
const refused = (error: string): McpAgentLaunchPreparation => ({...unchecked, success: false, ready: false, selectionRequired: false, effect: 'agent-launch-refused', error});
const executionRoutes = (surface: TeamLaunchSurface): McpAgentExecutionRoute[] => surface === 'internal'
  ? ['agentstoz_use_start_workroom_session', 'agentstoz_use_create_team']
  : surface === 'app' || surface === 'orca-floating' || surface === 'orca-worktree'
    ? ['agentstoz_use_open_code_app', 'agentstoz_use_create_team'] : ['agentstoz_use_create_team'];
const singleLaunch = (surface: TeamLaunchSurface) => executionRoutes(surface).some(route => route !== 'agentstoz_use_create_team');

/**
 * Resolve only explicit selections against project-open's shared static catalog. Missing choices produce questions;
 * complete choices produce an unexecuted draft. This function never probes installation, provider credentials or the
 * current session. A Hermes provider preset is a Workroom-only model pin; other surfaces are never substituted.
 */
export function prepareMcpAgentLaunch(rawArgs: unknown, windows = false): McpAgentLaunchPreparation {
  const raw = rawArgs === undefined ? {} : rawArgs;
  if (!isRecord(raw) || Object.keys(raw).some(key => !['agent', 'surface', 'hermesVariant'].includes(key))) return refused('agent, surface, hermesVariant만 받는 실행 선택 객체가 필요합니다.');
  if (raw.agent !== undefined && !isAgent(raw.agent)) return refused('AI는 codex, claude, hermes, agy 중에서 골라 주세요.');
  const surfaces = teamLaunchSurfacesFor(windows);
  if (raw.surface !== undefined && (typeof raw.surface !== 'string' || !(surfaces as readonly string[]).includes(raw.surface))) return refused('이 플랫폼의 실행 위치 목록에서 골라 주세요.');
  if (raw.hermesVariant !== undefined && raw.hermesVariant !== 'default' && raw.hermesVariant !== 'claude' && raw.hermesVariant !== 'codex') return refused('Hermes 변형은 default, claude, codex 중에서 골라 주세요.');
  const agent = raw.agent as AiTerminalAgent | undefined, surface = raw.surface as TeamLaunchSurface | undefined, hermesVariant = raw.hermesVariant as McpHermesVariant | undefined;
  const draft: McpAgentLaunchDraft = {...(agent ? {agent} : {}), ...(surface ? {surface} : {}), ...(hermesVariant ? {hermesVariant} : {})};
  if (!agent) return {...unchecked, success: false, ready: false, selectionRequired: true, stage: 'agent', effect: 'agent-selection-required', draft,
    question: '어떤 AI로 실행할까요? Codex, Claude Code, Hermes, Antigravity 중에서 골라 주세요.', choices: agentChoices()};
  if (agent !== 'hermes' && hermesVariant !== undefined) return refused('Hermes 변형은 Hermes를 선택했을 때만 지정할 수 있습니다.');
  if (!surface) return {...unchecked, success: false, ready: false, selectionRequired: true, stage: 'surface', effect: 'surface-selection-required', draft,
    question: `${launchChoiceLabel(agent)}를 어디에서 실행할까요? 실행 위치를 골라 주세요.`,
    choices: surfaces.map(where => {const support = teamLaunchSupport(where, agent); return {surface: where, label: teamSurfaceName(where, agent), support, executionRoutes: executionRoutes(where), singleLaunch: singleLaunch(where),
      ...(agent === 'hermes' && hermesVariant && hermesVariant !== 'default' ? {hermesVariantSupported: support.model && support.provider} : {})};})};
  const support = teamLaunchSupport(surface, agent);
  if (agent === 'hermes' && hermesVariant === undefined) return {...unchecked, success: false, ready: false, selectionRequired: true, stage: 'variant', effect: 'hermes-variant-selection-required', draft, executionRoutes: executionRoutes(surface),
    question: support.model && support.provider ? `${teamSurfaceName(surface, agent)}에서 Hermes의 기본 설정, Claude, Codex 중 무엇으로 실행할까요?`
      : `${teamSurfaceName(surface, agent)}에서 Hermes 기본 설정(현재 CLI·앱 설정 그대로)으로 실행할까요? 이 위치는 Claude·Codex 모델 지정을 지원하지 않습니다.`,
    choices: workroomLaunchChoices(['hermes']).map(choice => {const {variant} = launchChoiceTarget(choice), supported = !variant || support.model && support.provider;
      return {hermesVariant: variant ?? 'default', label: variant ? launchChoiceLabel(choice) : `${launchChoiceLabel(choice)} · 기본 설정(현재 CLI·앱 설정 그대로)`, supported,
        ...(!supported ? {unsupportedReason: '이 실행 위치는 Hermes 모델·provider 지정을 지원하지 않습니다. 실행 위치를 바꾸지 않습니다.'} : {})};})};
  if (agent === 'hermes' && hermesVariant && hermesVariant !== 'default' && !(support.model && support.provider)) return refused('이 실행 위치는 Hermes Claude·Codex 모델 지정을 지원하지 않습니다. 기본 설정을 고르거나 실행 위치를 명시적으로 다시 선택해 주세요.');
  return {...unchecked, success: true, ready: true, selectionRequired: false, effect: 'agent-launch-prepared', draft: {...draft, agent, surface}, support, executionRoutes: executionRoutes(surface), singleLaunch: singleLaunch(surface),
    note: '선택 준비만 끝났으며 실행·요청 전달은 하지 않았습니다.' + (surface === 'app' ? ` 앱 기능 안내(실행 전): ${workroomAppConfirmMessage(agent, '선택한 프로젝트', '요청')}` : ''),
    ...(agent === 'hermes' && hermesVariant && hermesVariant !== 'default' ? {launchModel: hermesVariantModel(hermesVariant)} : {})};
}
