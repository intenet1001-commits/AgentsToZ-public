import type {AiTerminalAgent} from './aiTerminalProtocol';
import type {WorkroomEffortLevel} from './workroomEffortPolicy';
import {TEAM_LAUNCH_SURFACES, teamLaunchSummary, teamReportProvenance, type TeamDelivery, type TeamLaunchOptions, type TeamLaunchSurface} from './teamLaunchPlan';
import type {Team, TeamMemberGit, TeamMemberState, TeamView, WorkroomTeamService} from './workroomTeam';
import {TEAM_SESSION_ID} from './workroomTeamInstruction';

/**
 * 팀 현황 (the Workroom's team status strip, src/WorkroomTeamStatus.tsx). The panel asks with the session it shows and gets
 * the teams that session leads or belongs to — the same ledger the agentstoz_use team tools read, without local paths.
 * Management-gated like every Workroom route: only this Mac's own windows reach it, never a phone or a peer.
 */
export const WORKROOM_TEAM_PANEL_PATH = '/api/agent-runtime/workroom-teams';
export const TEAM_PANEL_MAX_TEAMS = 3;
// The same rule everywhere a session is named (src/workroomTeamInstruction.ts).
const SESSION_ID = TEAM_SESSION_ID;

/** `git: false` reads the ledger and live sessions only, so the strip can look every few seconds without spawning Git. */
export interface TeamPanelRequest { sessionId: string; git: boolean }
export interface TeamPanelMember {
  id: string; name: string; agent: AiTerminalAgent; model?: string; provider?: string; effort?: WorkroomEffortLevel; role?: 'reviewer'; attached?: true; task: string; branch: string;
  /**
   * The surface this member was asked for and the one actually reached, so every member is visible in 팀 현황 — not only
   * the Workroom ones. `launch` is the same choice as one neutral line ('cmux · tmux'), so the strip needs no new copy.
   * `owned` says whether 팀 정리 may end it; `delivery` and `manual` say how its brief arrived and what a person
   * confirmed by hand. The opaque runtime handle is deliberately absent: the strip names a member, it never drives it.
   */
  surface?: TeamLaunchSurface; effectiveSurface?: TeamLaunchSurface; launchOptions?: TeamLaunchOptions; launch?: string;
  owned?: boolean; delivery?: TeamDelivery; manual?: {confirmed: 'started' | 'delivered'; at: string}; note?: string;
  state: TeamMemberState; sessionId: string | null; session: 'running' | 'exited' | 'missing' | null; lastOutputAt: number | null;
  /** `provenance: 'manual'` is a person's transcription, never presented as the member AI's own verified report. */
  report?: {status: 'done' | 'blocked'; summary: string; at: string; provenance: 'member' | 'manual'}; error?: string; git: TeamMemberGit | null;
}
export interface TeamPanelTeam {
  id: string; title: string; goal: string; state: 'active' | 'closed'; role: 'leader' | 'member'; memberId: string | null;
  leader: {sessionId: string | null; agent: AiTerminalAgent | null}; settled: number; createdAt: string; updatedAt: string; members: TeamPanelMember[];
}
export interface TeamPanelResult { teams: TeamPanelTeam[] }

export function parseTeamPanelRequest(input: unknown): TeamPanelRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('팀 현황 요청 형식이 올바르지 않습니다.');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== 'sessionId' && key !== 'git')) throw new Error('팀 현황 요청에 허용되지 않은 값이 있습니다.');
  if (typeof body.sessionId !== 'string' || !SESSION_ID.test(body.sessionId)) throw new Error('세션을 확인하지 못했습니다.');
  if (body.git !== undefined && typeof body.git !== 'boolean') throw new Error('팀 현황 요청 형식이 올바르지 않습니다.');
  return {sessionId: body.sessionId, git: body.git !== false};
}

const involves = (team: Team, sessionId: string) => team.leader.sessionId === sessionId || team.members.some(member => member.sessionId === sessionId);

/** Active teams first, then the latest; a session belongs to few teams, so three is the whole story. */
export async function teamsForSession(service: WorkroomTeamService, request: TeamPanelRequest): Promise<TeamPanelResult> {
  const order = (team: Team) => (team.state === 'active' ? 1 : 0) * 1e15 + Date.parse(team.updatedAt);
  const all = service.store.all();
  // Local session/continuation evidence only, before selecting by session ID. Otherwise the first strip poll after
  // 「다시 시작」 would filter out the team before view() could update its binding, until an unrelated MCP read did so.
  for (const team of all) service.refreshMembers(team);
  const teams = all.filter(team => involves(team, request.sessionId)).sort((a, b) => order(b) - order(a)).slice(0, TEAM_PANEL_MAX_TEAMS);
  return {teams: await Promise.all(teams.map(async team => teamPanelView(await service.view(team, {git: request.git}), request.sessionId)))};
}

/** The view without the checkout paths (primaryPath, worktreePath, baseCheckout) and targets: the strip names, it never opens folders. */
export function teamPanelView(view: TeamView, sessionId: string): TeamPanelTeam {
  const own = view.members.find(member => member.sessionId === sessionId);
  return {id: view.id, title: view.title, goal: view.goal, state: view.state, role: own ? 'member' : 'leader', memberId: own?.id ?? null,
    leader: {sessionId: view.leader.sessionId, agent: view.leader.agent}, settled: view.settled, createdAt: view.createdAt, updatedAt: view.updatedAt,
    members: view.members.map(member => {
      const external = member.execution?.kind === 'external' ? member.execution : null;
      return {id: member.id, name: member.name, agent: member.agent, ...(member.model ? {model: member.model} : {}),
        ...(member.provider ? {provider: member.provider} : {}), ...(member.effort ? {effort: member.effort} : {}), ...(member.role === 'reviewer' ? {role: 'reviewer' as const} : {}), ...(member.attached ? {attached: true as const} : {}), task: member.task, branch: member.branch,
        // The chosen surface travels; the handle never does.
        ...(member.surface ? {surface: member.surface, launch: teamLaunchSummary({surface: member.surface, ...(member.launchOptions ? {options: member.launchOptions} : {})})} : {}),
        ...(member.launchOptions ? {launchOptions: member.launchOptions} : {}),
        ...(external?.effectiveSurface ? {effectiveSurface: external.effectiveSurface} : {}),
        ...(external ? {owned: external.owned} : {}), ...(member.delivery ? {delivery: member.delivery} : {}),
        ...(member.manual ? {manual: member.manual} : {}), ...(member.note ? {note: member.note} : {}),
        state: member.state, sessionId: member.sessionId, session: member.session, lastOutputAt: member.lastOutputAt,
        ...(member.report ? {report: {...member.report, provenance: teamReportProvenance(member.report)}} : {}), ...(member.error ? {error: member.error} : {}), git: member.git};
    })};
}

/**
 * What the strip shows: a member whose session ended without a report (`exited`, or a live row whose session is gone)
 * is neither working nor done — 「끝남 · 보고 없음」. `unknown` is a member from an earlier run of the app.
 */
export type TeamMemberDisplay = Exclude<TeamMemberState, 'exited'> | 'ended';
export function teamMemberDisplay(member: Pick<TeamPanelMember, 'state' | 'session'>): TeamMemberDisplay {
  if (member.state === 'exited') return 'ended';
  if (member.state !== 'starting' && member.state !== 'working') return member.state;
  return member.session === 'exited' || member.session === 'missing' ? 'ended' : member.state;
}
/** An external member waiting on its surface or on a person: pending work, never success and never a failure. */
export const teamMemberAwaiting = (member: Pick<TeamPanelMember, 'state'>): boolean =>
  member.state === 'awaiting-connection' || member.state === 'awaiting-manual-join' || member.state === 'awaiting-ack';

const AGENTS = new Set<string>(['claude', 'codex', 'hermes', 'agy']);
const STATES = new Set<string>(['starting', 'awaiting-connection', 'awaiting-manual-join', 'awaiting-ack', 'working', 'reported', 'blocked', 'failed', 'exited', 'unknown', 'closed']);
const SURFACES = new Set<string>(TEAM_LAUNCH_SURFACES);
const DELIVERIES = new Set<string>(['verified', 'manual', 'unknown', 'not-sent']);
/** Only the shapes this core produces: an option or a value it does not know is dropped, so the strip never invents one. */
function launchOptionsFrom(raw: unknown): TeamLaunchOptions | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>, options: TeamLaunchOptions = {};
  if (Object.keys(o).some(key => !['bgMode', 'tmuxMode', 'reuse', 'appMode'].includes(key))) return null;
  if (o.bgMode !== undefined) { if (typeof o.bgMode !== 'boolean') return null; options.bgMode = o.bgMode; }
  if (o.tmuxMode !== undefined) { if (typeof o.tmuxMode !== 'boolean') return null; options.tmuxMode = o.tmuxMode; }
  if (o.reuse !== undefined) { if (o.reuse !== 'new' && o.reuse !== 'reuse-or-new') return null; options.reuse = o.reuse; }
  if (o.appMode !== undefined) { if (o.appMode !== 'new' && o.appMode !== 'reopen' && o.appMode !== 'open') return null; options.appMode = o.appMode; }
  return options;
}
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : null;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function memberFrom(raw: unknown): TeamPanelMember | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const id = text(m.id, 40), name = text(m.name, 80), task = text(m.task, 4000), branch = text(m.branch, 200);
  if (!id || !name || task === null || branch === null || !AGENTS.has(m.agent as string) || !STATES.has(m.state as string)) return null;
  const session = m.session === 'running' || m.session === 'exited' || m.session === 'missing' ? m.session : null;
  const report = m.report && typeof m.report === 'object' ? m.report as Record<string, unknown> : null;
  const git = m.git && typeof m.git === 'object' ? m.git as Record<string, unknown> : null;
  const gitCounts = git ? [count(git.commits), count(git.files), count(git.insertions), count(git.deletions)] : null;
  const launchOptions = m.launchOptions === undefined ? undefined : launchOptionsFrom(m.launchOptions);
  if (launchOptions === null) return null;
  const manual = m.manual && typeof m.manual === 'object' ? m.manual as Record<string, unknown> : null;
  const surface = m.surface === undefined ? undefined : SURFACES.has(m.surface as string) ? m.surface as TeamLaunchSurface : null;
  const effectiveSurface = m.effectiveSurface === undefined ? undefined : SURFACES.has(m.effectiveSurface as string) ? m.effectiveSurface as TeamLaunchSurface : null;
  if (surface === null || effectiveSurface === null) return null;
  if (m.delivery !== undefined && !DELIVERIES.has(m.delivery as string)) return null;
  if (m.owned !== undefined && typeof m.owned !== 'boolean') return null;
  return {id, name, agent: m.agent as AiTerminalAgent, ...(text(m.model, 80) ? {model: m.model as string} : {}), ...(text(m.provider, 80) ? {provider: m.provider as string} : {}),
    ...(m.effort === 'low' || m.effort === 'medium' || m.effort === 'high' ? {effort: m.effort} : {}), ...(m.role === 'reviewer' ? {role: 'reviewer' as const} : {}), ...(m.attached === true ? {attached: true as const} : {}), task, branch, state: m.state as TeamMemberState,
    ...(surface ? {surface, launch: teamLaunchSummary({surface, ...(launchOptions ? {options: launchOptions} : {})})} : {}),
    ...(launchOptions ? {launchOptions} : {}), ...(effectiveSurface ? {effectiveSurface} : {}),
    ...(typeof m.owned === 'boolean' ? {owned: m.owned} : {}), ...(m.delivery !== undefined ? {delivery: m.delivery as TeamDelivery} : {}),
    ...(manual && (manual.confirmed === 'started' || manual.confirmed === 'delivered') && text(manual.at, 40)
      ? {manual: {confirmed: manual.confirmed, at: manual.at as string}} : {}),
    ...(text(m.note, 300) ? {note: m.note as string} : {}),
    sessionId: text(m.sessionId, 160), session, lastOutputAt: count(m.lastOutputAt),
    // An older sidecar sends a report without provenance; that is a member's own report, not a dropped row.
    ...(report && (report.status === 'done' || report.status === 'blocked') && text(report.summary, 4000) !== null && text(report.at, 40)
      && (report.provenance === undefined || report.provenance === 'member' || report.provenance === 'manual')
      ? {report: {status: report.status, summary: report.summary as string, at: report.at as string, provenance: report.provenance === 'manual' ? 'manual' as const : 'member' as const}} : {}),
    ...(text(m.error, 600) ? {error: m.error as string} : {}),
    git: git && gitCounts!.every(value => value !== null) && typeof git.merged === 'boolean'
      ? {commits: gitCounts![0]!, files: gitCounts![1]!, insertions: gitCounts![2]!, deletions: gitCounts![3]!, merged: git.merged} : null};
}
/** The client's check of the sidecar's answer: a team or member it cannot read is dropped, not guessed. */
export function normalizeTeamPanelResult(raw: unknown): TeamPanelResult {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as {teams?: unknown}).teams) ? (raw as {teams: unknown[]}).teams : [];
  const teams: TeamPanelTeam[] = [];
  for (const item of list.slice(0, TEAM_PANEL_MAX_TEAMS)) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>, leader = t.leader && typeof t.leader === 'object' ? t.leader as Record<string, unknown> : {};
    const id = text(t.id, 40), title = text(t.title, 200), goal = text(t.goal, 8000), settled = count(t.settled);
    const members = Array.isArray(t.members) ? t.members.map(memberFrom) : [];
    if (!id || title === null || goal === null || settled === null || (t.state !== 'active' && t.state !== 'closed') || (t.role !== 'leader' && t.role !== 'member')
      || !text(t.createdAt, 40) || !text(t.updatedAt, 40) || members.some(member => !member)) continue;
    teams.push({id, title, goal, state: t.state, role: t.role, memberId: text(t.memberId, 40), settled,
      leader: {sessionId: text(leader.sessionId, 160), agent: AGENTS.has(leader.agent as string) ? leader.agent as AiTerminalAgent : null},
      createdAt: t.createdAt as string, updatedAt: t.updatedAt as string, members: members as TeamPanelMember[]});
  }
  return {teams};
}
