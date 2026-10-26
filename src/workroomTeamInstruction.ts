/**
 * Browser-safe half of 팀 작전 (src/workroomTeam.ts): the model-name rule shared by the launch arguments and the team
 * builder, the agent labels, the model and effort choices the builder offers, and the leader instruction a person
 * sends to whichever AI should lead.
 */
import type {AiTerminalAgent} from './aiTerminalProtocol';
import type {WorkroomEffortLevel} from './workroomEffortPolicy';
import {parseTeamSelectionBlock,teamEffortSupported, teamLaunchText, teamSelectionBlock, teamSurfaceName, type TeamMemberRole, type TeamMemberSelection, type TeamLaunchSurface} from './teamLaunchOptions';

// The member rules now live with the launch choices (src/teamLaunchOptions.ts); every existing import keeps working from here.
export {LAUNCH_MODEL_NAME, launchModelError, TEAM_EFFORT_LEVELS, teamEffortError, teamEffortSupported, TEAM_MAX_MEMBERS, TEAM_SESSION_ID, type AiTerminalLaunchModel, type TeamMemberRole} from './teamLaunchOptions';

export const TEAM_AGENT_LABEL: Record<AiTerminalAgent, string> = {claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes', agy: 'Antigravity'};

export interface TeamModelChoice { model: string; label: string; provider?: string }
/**
 * What the builder lists per CLI (2026-10-25, read from the installed CLIs): Claude Code 2.1.309 model names; the
 * models codex-cli 0.164.0 shows in its picker (each in CODEX_EFFORT_CATALOG, so an effort can be proven for it);
 * Hermes on its Anthropic and OpenAI Codex providers; `agy models` for this account. 「직접 입력」 covers anything newer.
 */
export const TEAM_MODEL_CHOICES: Readonly<Record<AiTerminalAgent, readonly TeamModelChoice[]>> = {
  claude: [
    {model: 'claude-opus-5-5', label: 'Opus 5.5'}, {model: 'claude-sonnet-5-5', label: 'Sonnet 5.5'},
    {model: 'claude-fable-5-1', label: 'Fable 5.1'}, {model: 'claude-haiku-5-5', label: 'Haiku 5.5'},
  ],
  codex: [
    {model: 'gpt-6.1-sol', label: 'GPT-6.1-Sol'}, {model: 'gpt-6-astra', label: 'GPT-6-Astra'}, {model: 'gpt-6-sol', label: 'GPT-6-Sol'},
    {model: 'gpt-6-luna', label: 'GPT-6-Luna'}, {model: 'gpt-5.6-sol', label: 'GPT-5.6-Sol'}, {model: 'gpt-5.6-terra', label: 'GPT-5.6-Terra'},
    {model: 'gpt-5.6-luna', label: 'GPT-5.6-Luna'}, {model: 'gpt-5.5', label: 'GPT-5.5'},
  ],
  hermes: [
    {provider: 'anthropic', model: 'claude-opus-5-5', label: 'Anthropic · Opus 5.5'}, {provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Anthropic · Sonnet 5.5'},
    {provider: 'anthropic', model: 'claude-haiku-5-5', label: 'Anthropic · Haiku 5.5'},
    {provider: 'openai-codex', model: 'gpt-6.1-sol', label: 'OpenAI Codex · GPT-6.1-Sol'}, {provider: 'openai-codex', model: 'gpt-6-astra', label: 'OpenAI Codex · GPT-6-Astra'},
  ],
  agy: [
    {model: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)'}, {model: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)'},
    {model: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)'}, {model: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)'},
    {model: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)'}, {model: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)'},
    {model: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)'}, {model: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)'},
    {model: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)'}, {model: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)'},
    {model: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)'}, {model: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)'},
    {model: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)'},
  ],
};

/**
 * `attached`: an open session that joined — it keeps its own model and effort, so neither is named. `surface`: where the
 * member runs (absent is the Workroom); outside the Workroom nothing chooses a model or an effort, so the label claims neither.
 */
type TeamMemberLabelInput = {agent: AiTerminalAgent; model?: string; provider?: string; effort?: WorkroomEffortLevel; role?: TeamMemberRole; attached?: boolean; surface?: TeamLaunchSurface};
export const teamModelLabel = (member: TeamMemberLabelInput) =>
  `${TEAM_AGENT_LABEL[member.agent]}${member.model ? ` (${member.provider ? `${member.provider}/` : ''}${member.model})` : ''}`;
/** Model plus effort (or where it runs), as the leader and the members read it. */
export const teamMemberLabel = (member: TeamMemberLabelInput) => {
  const surface = member.surface ?? 'internal';
  const body = member.attached ? `${TEAM_AGENT_LABEL[member.agent]} · 열린 세션`
    : surface !== 'internal' ? `${teamModelLabel(member)} · ${teamSurfaceName(surface, member.agent)}`
    : `${teamModelLabel(member)}${teamEffortSupported(member.agent) ? ` · 에포트 ${member.effort ? `고정 ${member.effort}` : '자동'}` : ''}`;
  return `${body}${member.role === 'reviewer' ? ' · 검토 담당' : ''}`;
};

/** A member as the builder hands it over: its selection (src/teamLaunchOptions.ts) plus the names a person reads. */
export type TeamLeaderMember = TeamMemberSelection & {sessionLabel?: string; accountLabel?: string};

/** Read an existing builder draft before treating anything in it as a new goal. Never nest old selection authority. */
export function readTeamBuilderDraft(text:string):{goal:string;members?:TeamMemberSelection[]} {
  if(!text.includes('```agentstoz-team-selection'))return {goal:text};
  const selection=parseTeamSelectionBlock(text);
  const normalized=text.replace(/\r\n/g,'\n');
  const prefix='[AgentsToZ 팀 작전 · 리더]\n당신이 이 작업의 리더입니다. agentstoz-team 스킬의 순서를 따르세요.\n\n목표:\n';
  const end=normalized.indexOf('\n\n팀 구성:\n',prefix.length);
  if(!normalized.startsWith(prefix)||end<0||normalized.indexOf('\n\n팀 구성:\n',end+1)>=0)throw Error('기존 팀 지시문의 목표를 확인하지 못했습니다. 목표를 다시 입력해 주세요.');
  return {goal:normalized.slice(prefix.length,end),members:selection.members};
}

/**
 * The instruction a person sends to whichever AI should lead (Workroom composer or a work thread). Each member's line says
 * everything chosen for it, and the same choice follows as a versioned selection block (teamSelectionBlock) — what the host
 * and the leader read, instead of trusting an AI to restate it. Invalid members throw: the builder checks them first.
 */
export function teamLeaderInstruction(input: {goal: string; members: TeamLeaderMember[]}): string {
  const block = teamSelectionBlock(input.members.map(({sessionLabel: _label, accountLabel: _account, ...member}) => member));
  // An open session is named by its tab label for the person and by its sessionId for create_team.
  const who = (member: TeamLeaderMember) => {
    if (member.sessionId) return `열린 세션 「${member.sessionLabel ?? TEAM_AGENT_LABEL[member.agent]}」 · ${TEAM_AGENT_LABEL[member.agent]} · sessionId ${member.sessionId}${member.role === 'reviewer' ? ' · 검토 담당' : ''}`;
    // Only what differs from a plain Workroom is added, so a legacy member's line reads exactly as before.
    const launch = teamLaunchText(member, member.accountLabel), surface = member.surface ?? 'internal';
    const base = surface === 'internal' ? teamMemberLabel({...member, role: undefined}) : teamModelLabel(member);
    return `${base}${launch ? ` · ${launch}` : ''}${member.role === 'reviewer' ? ' · 검토 담당' : ''}`;
  };
  const members = input.members.map((member, index) => `- 팀원 ${index + 1}: ${who(member)}${member.task?.trim() ? ` — ${member.task.trim()}` : member.role === 'reviewer' ? ' — 검토 범위는 리더가 정함' : ' — 작업은 리더가 배분'}`).join('\n');
  const joined = input.members.some(member => member.sessionId)
    ? ' 「열린 세션」 팀원은 새 워크룸 대신 그 세션이 합류합니다: agent와 sessionId만 넣고 model·effort는 넣지 않습니다(작업 팀원은 그 세션의 워크트리 브랜치에서 일하고, 정리 때 그 세션·워크트리·브랜치는 그대로 둡니다).'
    : '';
  const reviewers = input.members.some(member => member.role === 'reviewer'), workers = input.members.some(member => member.role !== 'reviewer');
  // A reviewer reads, it never edits: with workers it reviews their branches; alone it reviews the leader's own work.
  const reviewCreate = reviewers ? ' 「검토 담당」 팀원은 role "reviewer"로 넣고, 그 task에 검토 범위와 기준을 적습니다' + (workers ? '.' : '(작업 팀원이 없으면 이 체크아웃의 어느 변경을 볼지 — 커밋 범위나 파일).') : '';
  const reviewMerge = reviewers ? (workers ? ' 검토 담당의 보고를 받은 뒤 병합하고, 지적은 해당 팀원에게 고치게 하거나 직접 고칩니다.' : ' 검토 담당의 지적을 사실 확인한 뒤 이 체크아웃에서 고칩니다.') : '';
  // Where and how each member runs is the person's choice: never another surface, account or permission, never a Workroom instead.
  const launched = input.members.some(member => !member.sessionId && (member.surface && member.surface !== 'internal' || member.accountId || member.bypassPermissions));
  const launchRules = launched ? `

실행 위치·옵션:
- 팀원마다 고른 실행 위치·계정·권한 우회·실행 옵션을 그대로 지킵니다. 다른 값으로 바꾸거나 워크룸으로 대신 시작하지 않습니다.
- create_team이 어느 값을 거절하면 그 팀원을 바꾸지 말고, 거절 내용과 함께 사람에게 보고합니다.
- 「자동 관리」 팀원만 지시와 보고가 자동으로 오갑니다. 「연결 대기」는 연결이 확인된 뒤에, 「수동 합류」는 사람이 시작을 확인한 뒤에야 작업 중으로 셉니다. 열기·입력칸 채우기·복사는 작업 시작이 아닙니다.` : '';
  const instruction=`[AgentsToZ 팀 작전 · 리더]
당신이 이 작업의 리더입니다. agentstoz-team 스킬의 순서를 따르세요.

목표:
${input.goal.trim()}

팀 구성:
${members}${launchRules}

진행:
1. 코드를 읽고 계획을 세운 뒤, 파일이 겹치지 않는 작업으로 나눕니다(팀원 수는 위 구성을 따릅니다).
2. 팀원은 지금 체크아웃의 HEAD에서 시작하므로, 시작 전에 필요한 변경을 커밋합니다.
3. agentstoz_use_create_team으로 팀원을 각자의 워크트리와 고른 실행 위치에서 시작합니다. 모델은 위 구성대로 model(Hermes는 provider도)에 넣고, 「에포트 고정 <값>」인 팀원만 effort에 그 값을 넣습니다(「에포트 자동」은 effort를 비웁니다).${joined}${reviewCreate} 팀원 값은 아래 선택 블록의 members를 그대로 쓰고, 비어 있는 task·name만 채웁니다.
4. agentstoz_use_wait_team과 agentstoz_use_read_team으로 보고를 기다립니다. 막힌 팀원에게는 agentstoz_use_team_member의 read/send/reveal을 teamId/memberId로 사용합니다. 자동 입력을 지원하지 않는 외부 팀원은 실제 화면을 확인하고 수동 확인·옮긴 보고로 기록하며, 워크룸 지시로 대신 보내지 않습니다.
5. 각 브랜치의 diff를 검토하고 이 체크아웃에 병합한 뒤 검사합니다. 충돌은 리더가 해결합니다.${reviewMerge}
6. agentstoz_use_close_team으로 정리하고, 팀원별 결과와 검사 결과를 보고합니다. push는 하지 않습니다.

선택 블록(구성기가 고른 그대로입니다. 고치지 마세요):
${block}`;
  parseTeamSelectionBlock(instruction); // Validate the complete text: a block hidden in the goal/task must not survive.
  return instruction;
}
