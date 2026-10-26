/**
 * 팀 작전 (team operation): any Workroom AI leads, splits its plan, and runs each member — another AI, optionally
 * on a chosen model — in its own git worktree and branch, then reviews, merges and closes. The host owns only what
 * the leader cannot do safely by itself: identical base commits, one worktree and branch per member, launching the
 * member Workroom with a brief, a durable ledger of who does what, member reports, and cleanup that never drops
 * uncommitted or unmerged work. Merging stays with the leader (an AI with a shell resolves conflicts better than a
 * button), and nothing here pushes. Exactly once: a create requestId replays its team and never starts more members.
 */
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import type {AiTerminalAgent} from './aiTerminalProtocol';
import {parseTeamMemberSelection} from './teamLaunchOptions';
import {startsWithShellEscape} from './workroomOrchestration';
import {isExternalTeamSurface, teamLaunchSummary, type TeamDelivery, type TeamExecutionRef, type TeamExternalRuntime, type TeamExternalObserved, type TeamLaunchOptions, type TeamLaunchPlan, type TeamLaunchSurface} from './teamLaunchPlan';
export {TEAM_LAUNCH_SURFACES, type TeamExternalLaunch, type TeamExternalRuntime, type TeamExternalStarted, type TeamLaunchPlan, type TeamLaunchSurface} from './teamLaunchPlan';
import {TEAM_AGENT_LABEL as AGENT_LABEL, TEAM_MAX_MEMBERS, TEAM_SESSION_ID, teamMemberLabel as modelLabel, type AiTerminalLaunchModel} from './workroomTeamInstruction';
import type {WorkroomEffortLevel} from './workroomEffortPolicy';
export {teamLeaderInstruction, TEAM_MAX_MEMBERS} from './workroomTeamInstruction';

export const TEAM_WAIT_MAX_MS = 50_000;
const TEAM_KEEP = 40;
const EXTERNAL_OBSERVE_MAX_MS = 1_500;
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** `effort` absent = 「자동」 (this Mac's 에포트 자동 decides from the task); a level pins that member's session. */
/** `role` 'reviewer' (absent = a worker): a read-only member that reviews the workers' branches and reports findings. */
/**
 * `sessionId`: an open Workroom on this Mac joins instead of a new one — no worktree is made, its brief is typed into that
 * session, and it keeps its own model and effort. A worker must already run in its own linked worktree of this repository.
 *
 * `accountId`: which registered CLI account (Codex, Claude) this member's Workroom starts with — the same selection the
 * app's own start takes (`AiTerminalRequest.accountId`), validated by the same `cliAccountId`/`cliAccountAgent` rules.
 * It never changes a global login or a project's account binding; it only names an existing profile for this launch.
 * `bypassPermissions`: that member's CLI starts without its approval prompts. Only an explicit `true` does anything
 * (absent or false = the ordinary approval mode), and it is a host-only launch option, as in every Workroom start.
 */
export interface TeamMemberInput {
  agent: AiTerminalAgent; task: string; name?: string; model?: string; provider?: string; effort?: WorkroomEffortLevel; role?: 'reviewer'; sessionId?: string; accountId?: string; bypassPermissions?: boolean;
  /**
   * `surface`/`launchOptions`: the project launch the user picked for this member (src/teamLaunchPlan.ts). Absent is
   * `internal`, the Workroom this team has always started, so every existing caller keeps its behaviour. An external
   * surface is started through the injected runtime and is never substituted with a Workroom.
   */
  surface?: TeamLaunchSurface; launchOptions?: TeamLaunchOptions;
}
/** A member is addressed through its team binding, including external members without a Workroom sessionId. */
export type WorkroomTeamMemberRequest = {op: 'member'; teamId: string; memberId: string} & (
  | {operation: 'read'; cursor?: string; limit: number}
  | {operation: 'send'; requestId: string; text: string}
  | {operation: 'reveal'; requestId: string}
);
export type WorkroomTeamRequest =
  | WorkroomTeamMemberRequest
  | {op: 'create'; portId: string; requestId: string; title: string; goal: string; members: TeamMemberInput[]}
  | {op: 'read'; teamId?: string; portId?: string}
  /**
   * afterSettled: the settled count the leader last saw (a cursor), so a report that landed before the wait still counts.
   * afterCursor: the `settledCursor` of the view the leader last saw — its own place in the settle events, which no other
   * caller's read or wait moves. Either, both or neither may be given.
   */
  | {op: 'wait'; teamId: string; timeoutMs: number; until: 'any' | 'all'; afterSettled?: number; afterCursor?: string}
  | {op: 'report'; teamId: string; memberId: string; status: 'done' | 'blocked'; summary: string; manual?: true}
  /**
   * The leader's own confirmation for a member on a surface the host cannot read: `started` says the user saw it
   * running, `delivered` says the user saw the brief arrive. It records a manual provenance — it never claims the
   * member's AI said anything.
   */
  | {op: 'confirm'; teamId: string; memberId: string; confirm: 'started' | 'delivered'}
  | {op: 'close'; teamId: string; deleteMergedBranches: boolean};

/**
 * The three `awaiting-` states are the honest middle of an external launch: `awaiting-connection` (its runtime is not
 * reachable — cmux offline), `awaiting-manual-join` (the surface was opened or prefilled and the user must start or
 * confirm it), `awaiting-ack` (the brief was sent and nothing has acknowledged it). None of them is 「working」 and none
 * settles a wait, so a team never reads as finished because a window opened.
 */
export type TeamMemberState = 'starting' | 'awaiting-connection' | 'awaiting-manual-join' | 'awaiting-ack' | 'working' | 'reported' | 'blocked' | 'failed' | 'exited' | 'unknown' | 'closed';
export interface TeamMember {
  id: string; name: string; agent: AiTerminalAgent; model?: string; provider?: string; effort?: WorkroomEffortLevel; role?: 'reviewer'; task: string;
  /**
   * The launch options this member's own Workroom was started with. Kept in the ledger so a retry's fingerprint, the
   * leader's own read and a later restart describe the same session; never part of the 팀 현황 route's projection
   * (src/workroomTeamPanel.ts allowlists its fields), so a security option does not reach another device.
   */
  accountId?: string; bypassPermissions?: true;
  /**
   * `attached`: an open Workroom that joined (TeamMemberInput.sessionId). The team did not make its session, checkout or
   * branch, so close never ends, removes or deletes them. `branch` is its checkout's branch for a worker, '' for a
   * reviewer. `behindBase`: that branch did not contain the base commit when it joined.
   */
  attached?: true; behindBase?: true;
  /**
   * What the user asked for, kept whatever happened next: `surface` is omitted for a Workroom member so an existing
   * ledger row is unchanged. `execution` is how this member is actually reached — the legacy `sessionId` stays for a
   * Workroom (and for an attached open session), and an external surface carries its own opaque binding instead.
   * `delivery` is how the brief arrived; `unknown` stays unknown and is never resent.
   */
  surface?: TeamLaunchSurface; launchOptions?: TeamLaunchOptions; execution?: TeamExecutionRef; delivery?: TeamDelivery;
  /** One short line of the runtime's own words for the team status: no secret, path, command or environment. */
  note?: string;
  /** Last bounded runtime observation; it does not establish task completion. */
  observedOutputAt?: number;
  /** What the user confirmed by hand on a surface the host cannot read, and when. Never read as the member's own word. */
  manual?: {confirmed: 'started' | 'delivered'; at: string};
  branch: string; worktreePath: string; targetId: string | null; sessionId: string | null; state: TeamMemberState;
  /**
   * `provenance`: `member` is the member's own report through its own MCP call; `manual` is the leader writing down
   * what it saw on a surface the host cannot read. A manual report is never presented as the member AI's report.
   */
  error?: string; report?: {status: 'done' | 'blocked'; summary: string; at: string; provenance?: 'member' | 'manual'};
}
export {teamReportProvenance} from './teamLaunchPlan';
export interface Team {
  id: string; requestId: string; fingerprint: string; projectId: string; projectName: string; primaryPath: string;
  title: string; goal: string; baseCommit: string; baseBranch: string | null; baseCheckout: string;
  /**
   * `targetId`: the target the leader's own Workroom ran in, recorded only when the actual calling session gave one. With
   * it the leader is followed into the session its exact 「다시 시작」 lineage continues in (host.continuation), as a member
   * is; a ledger without it (written before) keeps the recorded session only. Never another session opened on the target.
   */
  leader: {sessionId: string | null; agent: AiTerminalAgent | null; targetId?: string};
  state: 'active' | 'closed'; createdAt: string; updatedAt: string; members: TeamMember[];
}
/** The calling Workroom (a hint, workroomCaller.ts). Its target lets the base follow a leader working in a linked worktree. */
export interface TeamCaller { sessionId: string; agent: AiTerminalAgent; targetId?: string }
export interface TeamMemberGit { commits: number; files: number; insertions: number; deletions: number; merged: boolean }
/**
 * Which checkouts a team's Git questions belong to: member worktrees and branches live under the primary, but what
 * counts as merged is the **leader's own checkout** — the one the team was cut from. Judging it in the primary told a
 * leader working in a linked worktree that its own merge had not happened, and kept every branch as unmerged.
 */
export interface TeamGitScope { primaryPath: string; baseCheckout: string }
export const teamGitScope = (team: Team): TeamGitScope => ({primaryPath: team.primaryPath, baseCheckout: team.baseCheckout || team.primaryPath});
export interface TeamCloseOutcome {
  memberId: string;
  /**
   * `kept`: a session the team does not end — an attached member's (its session, checkout and branch were never the
   * team's), or another Workroom still running in a member's checkout, which then keeps that checkout and branch too.
   */
  session: 'closed' | 'not-running' | 'kept';
  /** `kept-error`: cleanup could not finish for this member, so its worktree and branch are left as they are. */
  worktree: 'removed' | 'kept-dirty' | 'missing' | 'kept-error' | 'kept';
  branch: 'deleted' | 'kept-unmerged' | 'kept' | 'missing' | 'kept-error';
  error?: string;
}

/** The machine side, injected so the rules are tested without Git, PTYs or the app. */
export interface WorkroomTeamHost {
  resolveProject(portId: string): Promise<{projectId: string; projectName: string; canonicalPath: string}>;
  /**
   * The repository's primary checkout (where member worktrees live) and the base checkout: the leader's own checkout when
   * its Workroom runs in a worktree of this same repository, else the primary. HEAD, branch and changes come from the base.
   */
  primary(canonicalPath: string, leaderTargetId: string | null): Promise<{path: string; base: string; head: string; branch: string | null; trackedChanges: string[]; untracked: number}>;
  /** A surface may create its own managed checkout; its verified actual location replaces the planned one before start. */
  addWorktree(primaryPath: string, path: string, branch: string, base: string, surface?: TeamLaunchSurface): Promise<void | {path: string; branch: string}>;
  worktreeTargetId(projectId: string, path: string): string;
  /** `effort`: a pinned level, else the text 에포트 자동 classifies (the member's task, not the brief's boilerplate). */
  /**
   * `accountId`/`bypassPermissions` are the app's own start options (src/aiTerminalProtocol.ts), passed through
   * unchanged. Host-only, like `model` and `effort`: a remote request can never carry them.
   */
  start(input: {targetId: string; agent: AiTerminalAgent; prompt: string; requestId: string; model?: AiTerminalLaunchModel; accountId?: string; bypassPermissions?: true;
    effort: {pinned: WorkroomEffortLevel} | {requestText: string}}): Promise<{sessionId: string}>;
  session(sessionId: string, targetId: string): {state: 'running' | 'exited' | 'missing'; lastOutputAt: number | null};
  /**
   * The latest session that continues `sessionId` through the Workroom's own 「다시 시작」 (its exact `resumeFrom`
   * lineage) on that target. Another session merely opened on the same target is never one. Absent or null: none known.
   */
  continuation?(sessionId: string, targetId: string): {sessionId: string} | null;
  /**
   * The external launch surfaces, as one optional callback set. A host without them starts only `internal`, and a
   * member that asked for another surface fails with that reason stated — it is never quietly started as a Workroom.
   */
  external?: TeamExternalRuntime;
  /**
   * A running Workroom on that worktree target — and, given the member's `checkout`, one opened under any other target
   * whose folder is that checkout or inside it (the folder registered as a project of its own). Close keeps the checkout for it.
   */
  sessionForTarget(targetId: string, checkout?: string): Promise<{sessionId: string} | null>;
  /**
   * An open Workroom on this Mac that may join: its AI, target and checkout, and where that checkout stands against this
   * team's repository (`sameRepository`: its primary is `primaryPath`; `linked`: a linked worktree, not the primary).
   * `cwd` is that session's **checkout root**, not the folder its Workroom was registered in — a registered project may
   * sit in a subdirectory of its repository, and every rule here is about the checkout that commits.
   * Null when that session is not running here.
   */
  attachable(sessionId: string, team: {primaryPath: string; baseCheckout: string; baseCommit: string}): Promise<{
    agent: AiTerminalAgent; targetId: string; cwd: string; sameRepository: boolean; linked: boolean; baseCheckout: boolean; branch: string | null; containsBase: boolean;
  } | null>;
  /** Types a member's brief into an open Workroom once, under a host receipt: never typed again, `unknown` is reported as such. */
  instruct(input: {sessionId: string; prompt: string; requestId: string}): Promise<'written' | 'unknown'>;
  close(sessionId: string): Promise<void>;
  /** `merged`: already an ancestor of the base checkout's HEAD — where the leader merges. */
  branchGit(scope: TeamGitScope, base: string, branch: string): Promise<TeamMemberGit | null>;
  /** Removes a clean worktree only; uncommitted work is never discarded. */
  removeWorktree(primaryPath: string, path: string): Promise<'removed' | 'dirty' | 'missing'>;
  /** `git branch -d` in the base checkout: only a branch already merged where the leader merges. */
  deleteMergedBranch(scope: TeamGitScope, branch: string): Promise<'deleted' | 'unmerged' | 'missing'>;
}

export class WorkroomTeamError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400, readonly details?: Record<string, unknown>) { super(message); }
}
const invalid = (message: string) => new WorkroomTeamError(message, 'WORKROOM_TEAM_REQUEST_INVALID');
const text = (value: unknown, field: string, max: number, min = 1): string => {
  if (typeof value !== 'string') throw invalid(`${field}이(가) 필요합니다.`);
  const trimmed = value.trim();
  if (trimmed.length < min || bytes(trimmed) > max) throw invalid(`${field}은(는) ${min}자 이상, UTF-8 ${max}바이트 이하로 씁니다.`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) throw invalid(`${field}에 제어 문자를 쓸 수 없습니다.`);
  return trimmed;
};
const id = (value: unknown, field: string, pattern: RegExp) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid(`${field}가 올바르지 않습니다.`);
  return value;
};
const TEAM_ID = /^team_[0-9a-f]{12}$/;
const SESSION_ID = TEAM_SESSION_ID;
const MEMBER_ID = /^m[1-6]$/;
/** `<this run's team record>.<settle event>`: opaque to callers, and a cursor from another run or team is told apart. */
const SETTLED_CURSOR = /^[0-9a-f]{8}\.(0|[1-9][0-9]{0,8})$/;
const exact = (value: Record<string, unknown>, keys: string[]) => {
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) throw invalid(`알 수 없는 필드: ${extra.join(', ')}`);
};

export function parseWorkroomTeamRequest(input: unknown): WorkroomTeamRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('팀 작전 요청 객체가 필요합니다.');
  const value = input as Record<string, unknown>;
  switch (value.op) {
    case 'create': {
      exact(value, ['op', 'portId', 'requestId', 'title', 'goal', 'members']);
      if (!Array.isArray(value.members) || value.members.length < 1 || value.members.length > TEAM_MAX_MEMBERS) throw invalid(`팀원은 1명부터 ${TEAM_MAX_MEMBERS}명까지입니다.`);
      const members = value.members.map((raw, index): TeamMemberInput => {
        let selected: ReturnType<typeof parseTeamMemberSelection>;
        try { selected = parseTeamMemberSelection(raw, index); }
        catch (error) { throw invalid(error instanceof Error ? error.message : `팀원 ${index + 1}을 확인하세요.`); }
        // Drafts may leave task blank for the leader to divide; an actual create must supply it.
        return {...selected, task: text(selected.task, `팀원 ${index + 1}의 작업`, 4_000)};
      });
      const joined = members.flatMap(member => member.sessionId ? [member.sessionId] : []);
      if (new Set(joined).size !== joined.length) throw invalid('같은 열린 세션을 두 팀원으로 넣을 수 없습니다.');
      return {op: 'create', portId: id(value.portId, 'portId', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/), requestId: id(value.requestId, 'requestId', /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        title: text(value.title, '팀 제목', 240), goal: text(value.goal, '팀 목표', 6_000), members};
    }
    case 'read':
      exact(value, ['op', 'teamId', 'portId']);
      if ((value.teamId === undefined) === (value.portId === undefined)) throw invalid('teamId 또는 portId 중 하나로 읽습니다.');
      return value.teamId !== undefined ? {op: 'read', teamId: id(value.teamId, 'teamId', TEAM_ID)} : {op: 'read', portId: id(value.portId, 'portId', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)};
    case 'wait': {
      exact(value, ['op', 'teamId', 'timeoutMs', 'until', 'afterSettled', 'afterCursor']);
      const timeoutMs = value.timeoutMs === undefined ? 45_000 : Number(value.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > TEAM_WAIT_MAX_MS) throw invalid(`timeoutMs는 1000–${TEAM_WAIT_MAX_MS}입니다.`);
      if (value.until !== undefined && value.until !== 'any' && value.until !== 'all') throw invalid("until은 'any' 또는 'all'입니다.");
      if (value.afterSettled !== undefined && (!Number.isInteger(value.afterSettled) || (value.afterSettled as number) < 0 || (value.afterSettled as number) > TEAM_MAX_MEMBERS)) throw invalid(`afterSettled는 0–${TEAM_MAX_MEMBERS}입니다.`);
      if (value.afterCursor !== undefined) id(value.afterCursor, 'afterCursor', SETTLED_CURSOR);
      return {op: 'wait', teamId: id(value.teamId, 'teamId', TEAM_ID), timeoutMs, until: (value.until as 'any' | 'all' | undefined) ?? 'any',
        ...(value.afterSettled !== undefined ? {afterSettled: value.afterSettled as number} : {}), ...(value.afterCursor !== undefined ? {afterCursor: value.afterCursor as string} : {})};
    }
    case 'report':
      exact(value, ['op', 'teamId', 'memberId', 'status', 'summary', 'manual']);
      if (value.status !== 'done' && value.status !== 'blocked') throw invalid("status는 'done' 또는 'blocked'입니다.");
      // `manual: true` is the leader writing down what it read on a surface the host cannot read for itself.
      if (value.manual !== undefined && value.manual !== true) throw invalid('manual은 true만 쓸 수 있습니다. 팀원 자신의 보고에는 빼세요.');
      return {op: 'report', teamId: id(value.teamId, 'teamId', TEAM_ID), memberId: id(value.memberId, 'memberId', MEMBER_ID), status: value.status, summary: text(value.summary, '보고 요약', 8_000), ...(value.manual === true ? {manual: true as const} : {})};
    case 'confirm':
      exact(value, ['op', 'teamId', 'memberId', 'confirm']);
      if (value.confirm !== 'started' && value.confirm !== 'delivered') throw invalid("confirm은 'started' 또는 'delivered'입니다.");
      return {op: 'confirm', teamId: id(value.teamId, 'teamId', TEAM_ID), memberId: id(value.memberId, 'memberId', MEMBER_ID), confirm: value.confirm};
    case 'member': {
      const base = {op: 'member' as const, teamId: id(value.teamId, 'teamId', TEAM_ID), memberId: id(value.memberId, 'memberId', MEMBER_ID)};
      if (value.operation === 'read') {
        exact(value, ['op', 'teamId', 'memberId', 'operation', 'cursor', 'limit']);
        const limit = value.limit === undefined ? 4_000 : value.limit;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 8_000) throw invalid('limit는 1–8000 정수입니다.');
        if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length === 0 || bytes(value.cursor) > 512 || /[\x00-\x1f\x7f]/.test(value.cursor))) throw invalid('cursor를 확인하세요.');
        return {...base, operation: 'read', limit, ...(value.cursor !== undefined ? {cursor: value.cursor as string} : {})};
      }
      if (value.operation === 'send') {
        exact(value, ['op', 'teamId', 'memberId', 'operation', 'requestId', 'text']);
        const instruction = text(value.text, 'text', 20_000);
        if (startsWithShellEscape(instruction)) throw invalid('작업 지시는 !로 시작할 수 없습니다.');
        return {...base, operation: 'send', requestId: id(value.requestId, 'requestId', /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/), text: instruction};
      }
      if (value.operation === 'reveal') {
        exact(value, ['op', 'teamId', 'memberId', 'operation', 'requestId']);
        return {...base, operation: 'reveal', requestId: id(value.requestId, 'requestId', /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/)};
      }
      throw invalid('operation은 read·send·reveal 중 하나입니다.');
    }
    case 'close':
      exact(value, ['op', 'teamId', 'deleteMergedBranches']);
      if (value.deleteMergedBranches !== undefined && typeof value.deleteMergedBranches !== 'boolean') throw invalid('deleteMergedBranches는 true/false입니다.');
      return {op: 'close', teamId: id(value.teamId, 'teamId', TEAM_ID), deleteMergedBranches: value.deleteMergedBranches !== false};
    default: throw invalid("op는 create·read·wait·report·confirm·member·close 중 하나입니다.");
  }
}

/** External agents leave their report in the exact terminal the leader reads; they do not claim a verified Workroom report. */
function externalMemberReport(team: Team, member: TeamMember, summary: string): string | null {
  if (!member.surface || !isExternalTeamSurface(member.surface)) return null;
  return `현재 터미널에 teamId ${team.id}, memberId ${member.id}, status "done"과 summary(${summary})를 적습니다.
   막히면 같은 터미널에 status "blocked"와 질문을 적습니다. 리더는 팀원 통합 read로 이 출력을 확인하고 manual: true인 옮긴 보고로 수집합니다.
   자동으로 검증된 AI 보고라고 표시하지 않으며, 리더 워크룸에 직접 입력하지 않습니다.`;
}

/** The launch prompt a member Workroom starts with. The host writes it, so every model gets the same rules. */
export function teamMemberBrief(team: Team, member: TeamMember): string {
  if (member.role === 'reviewer') return reviewerBrief(team, member);
  const others = team.members.filter(other => other.id !== member.id).map(other => `- ${other.id} ${modelLabel(other)}: ${other.task.slice(0, 200)}`).join('\n') || '- (없음)';
  const reviewers = team.members.filter(other => other.role === 'reviewer').map(other => other.id);
  const base = team.baseCommit.slice(0, 12);
  return `[AgentsToZ 팀 작전 · 팀원 ${member.id}]
팀: ${team.title} (teamId ${team.id}, memberId ${member.id})
리더: ${team.leader.agent ? AGENT_LABEL[team.leader.agent] : '외부'} 워크룸 — 결과는 리더가 검토·병합합니다.${member.attached ? `
이 세션은 사람이 열어 둔 세션이고, 지금 이 팀에 합류했습니다. 하던 작업이 있으면 먼저 커밋해 두고 아래 작업을 시작합니다.` : ''}

전체 목표:
${team.goal.slice(0, 3_000)}

당신의 작업:
${member.task}

다른 팀원(겹치지 않게):
${others}

작업 위치: 이 워크트리(${member.worktreePath})와 브랜치 ${member.branch}만 씁니다. 기준 커밋 ${base}${team.baseBranch ? ` (리더의 ${team.baseBranch})` : ''}.${member.behindBase ? `
이 브랜치에는 기준 커밋이 없습니다. 작업 전에 \`git merge ${base}\`로 받고, 충돌은 이 브랜치에서 해결합니다.` : ''}
규칙:
1. 이 워크트리 밖의 파일을 고치지 않습니다. main이나 다른 팀원 브랜치에 병합하지 않고 push하지 않습니다.
2. 의존성(node_modules 등)은 워크트리마다 따로입니다. 필요하면 이 워크트리에서 설치합니다.
3. 의미 있는 단위마다 이 브랜치에 커밋합니다. 끝나면 관련 검사를 돌리고 결과를 사실대로 적습니다.${reviewers.length ? `
   검토 담당(${reviewers.join(', ')})이 이 브랜치를 읽습니다. 보고에 커밋과 검사 결과를 정확히 적습니다.` : ''}
4. 끝나면 ${externalMemberReport(team, member, '바꾼 것·커밋·검사 결과·남은 위험') ?? `agentstoz_use_report_team_task를 한 번 호출합니다(teamId ${team.id}, memberId ${member.id}, status "done", summary: 바꾼 것·커밋·검사 결과·남은 위험).
   막히면 status "blocked"와 리더에게 물을 질문을 보냅니다. 리더 워크룸에 직접 입력하지 않습니다.`}`;
}

/**
 * A reviewer reads and reports; it never edits or commits. With workers it waits for their reports and reviews each
 * branch against the base; with none it reviews the scope its task names in the base checkout's history.
 */
function reviewerBrief(team: Team, member: TeamMember): string {
  const base = team.baseCommit.slice(0, 12);
  const workers = team.members.filter(other => other.role !== 'reviewer');
  const targets = workers.map(other => `- ${other.id} ${modelLabel(other)} · 브랜치 ${other.branch}: ${other.task.slice(0, 200)}`).join('\n');
  // Its own checkout belongs to the session that joined (maybe the primary or the leader's): reading never moves it.
  const checkout = member.attached
    ? `3. 이 체크아웃은 이 세션의 것이라 브랜치를 바꾸지 않습니다(git checkout·switch 금지). 직접 돌려 볼 검사가 있으면 보고에 「리더가 돌릴 검사」로 적습니다.`
    : `3. 검사를 직접 돌려 보려면 이 워크트리에서 \`git checkout --detach <브랜치>\`로 받아 돌리고, 끝나면 \`git checkout --detach ${base}\`로 돌아옵니다.`;
  return `[AgentsToZ 팀 작전 · 검토 담당 ${member.id}]
팀: ${team.title} (teamId ${team.id}, memberId ${member.id})
리더: ${team.leader.agent ? AGENT_LABEL[team.leader.agent] : '외부'} 워크룸 — 당신의 지적을 받아 리더가 고치거나 병합합니다.${member.attached ? `
이 세션은 사람이 열어 둔 세션이고, 지금 이 팀에 검토 담당으로 합류했습니다.` : ''}

전체 목표:
${team.goal.slice(0, 3_000)}

검토 범위와 기준:
${member.task}

${workers.length ? `검토할 팀원:
${targets}` : `작업 팀원이 없습니다. 위 검토 범위를 기준 커밋 ${base}${team.baseBranch ? ` (리더의 ${team.baseBranch})` : ''}의 기록에서 읽습니다.`}

작업 위치: ${member.attached ? '이 체크아웃' : '이 워크트리'}(${member.worktreePath}) — 읽기 전용입니다. 기준 커밋 ${base}.
규칙:
1. 파일을 고치거나 커밋하지 않습니다. 병합·push하지 않습니다. 고칠 점은 파일:줄, 이유, 제안으로만 적습니다.
${workers.length ? `2. agentstoz_use_wait_team(teamId ${team.id}, until "any", afterCursor = 마지막으로 본 팀 화면의 settledCursor)으로 작업 팀원의 보고를 기다리고,
   끝난 팀원의 브랜치마다 \`git log ${base}..<브랜치>\`와 \`git diff ${base}...<브랜치>\`로 읽습니다. 보고는 증거가 아닙니다 — diff와 검사로 확인합니다.
${checkout}
4. 작업 팀원이 모두 끝나면(보고·막힘·실패·종료)` : `2. 필요한 검사를 이 워크트리에서 돌려 봅니다. 파일은 고치지 않습니다.
3. 검토 범위가 모호하면 먼저 status "blocked"로 리더에게 묻습니다.
4. 검토가 끝나면`} ${externalMemberReport(team, member, '심각도 순 발견 사항 — 위치, 근거, 돌린 검사와 실제 결과. 문제가 없으면 무엇을 확인했는지') ?? `agentstoz_use_report_team_task를 한 번 호출합니다(teamId ${team.id}, memberId ${member.id}, status "done",
   summary: 심각도 순 발견 사항 — 위치, 근거, 돌린 검사와 실제 결과. 문제가 없으면 무엇을 확인했는지).
   검토를 진행할 수 없으면 status "blocked"와 질문을 보냅니다. 리더 워크룸에 직접 입력하지 않습니다.`}`;
}

/**
 * The ledger file. `retiredRequestIds`: the create requestIds of teams pruned to make room — a dropped team can no
 * longer be replayed, so its id must never silently start a second team. An older build reads `teams` and ignores it.
 */
type TeamFile = {version: 1; teams: Team[]; retiredRequestIds?: string[]};
const TEAM_RETIRED_KEEP = 400;
/** A small JSON ledger in the app data folder (0600, atomic rename). Briefs live in the member Workrooms, not here. */
export class WorkroomTeamStore {
  #teams: Team[];
  #retired: string[];
  #earlier: Set<string>;
  constructor(readonly file: string | null) {
    let teams: Team[] = [], retired: string[] = [];
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as TeamFile;
        if (parsed?.version === 1 && Array.isArray(parsed.teams)) {
          teams = parsed.teams;
          if (Array.isArray(parsed.retiredRequestIds)) retired = parsed.retiredRequestIds.filter(id => typeof id === 'string');
        }
      } catch { teams = []; retired = []; }
    }
    this.#teams = teams; this.#retired = retired;
    this.#earlier = new Set(teams.map(team => team.id));
  }
  all(): Team[] { return this.#teams; }
  get(teamId: string): Team | undefined { return this.#teams.find(team => team.id === teamId); }
  byRequest(requestId: string): Team | undefined { return this.#teams.find(team => team.requestId === requestId); }
  /** Written by an earlier run of the app: its member Workrooms cannot be observed from this process any more. */
  fromEarlierRun(teamId: string): boolean { return this.#earlier.has(teamId); }
  /** This create requestId belonged to a team the ledger has dropped; replaying it would start a second team. */
  isRetired(requestId: string): boolean { return this.#retired.includes(requestId); }
  save(team: Team): void {
    const index = this.#teams.findIndex(item => item.id === team.id);
    if (index >= 0) this.#teams[index] = team; else this.#teams.push(team);
    // Closed teams go first; an active team is never dropped to make room.
    while (this.#teams.length > TEAM_KEEP) {
      const drop = this.#teams.findIndex(item => item.state === 'closed');
      if (drop < 0) break;
      const [dropped] = this.#teams.splice(drop, 1);
      if (!dropped) break;
      this.#earlier.delete(dropped.id);
      if (!this.#retired.includes(dropped.requestId)) this.#retired.push(dropped.requestId);
    }
    while (this.#retired.length > TEAM_RETIRED_KEEP) this.#retired.shift();
    if (!this.file) return;
    mkdirSync(dirname(this.file), {recursive: true});
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({version: 1, teams: this.#teams, ...(this.#retired.length ? {retiredRequestIds: this.#retired} : {})} satisfies TeamFile), {mode: 0o600});
    renameSync(temp, this.file);
  }
}

export interface TeamMemberView extends Omit<TeamMember, 'task'> { task: string; session: 'running' | 'exited' | 'missing' | null; lastOutputAt: number | null; git: TeamMemberGit | null }
export interface TeamView extends Omit<Team, 'members' | 'fingerprint'> {
  members: TeamMemberView[]; settled: number;
  /**
   * This view's place in the team's settle events, for a wait's `afterCursor`. Taken before the members are read, so it
   * never covers an event the view might not show: at worst the next wait answers once more.
   */
  settledCursor: string;
}
const settledState = (member: TeamMember) =>
  member.state === 'reported' || member.state === 'blocked' || member.state === 'failed' || member.state === 'exited' || member.state === 'unknown' || member.state === 'closed';

/**
 * Whether `sessionId` is this team's leader: its recorded session, or the one that session's exact 다시 시작 lineage
 * continues in when the leader's target was recorded — before any read has moved the ledger there. A team created
 * without a caller has no leader session, and one recorded before targets were kept follows no lineage.
 */
export function leadsTeam(team: Team, sessionId: string, host: Pick<WorkroomTeamHost, 'continuation'>): boolean {
  const {sessionId: recorded, targetId} = team.leader;
  if (!recorded) return false;
  return recorded === sessionId || !!targetId && host.continuation?.(recorded, targetId)?.sessionId === sessionId;
}

export class WorkroomTeamService {
  #chain: Promise<unknown> = Promise.resolve();
  #waiters = new Set<() => void>();
  #revision = new WeakMap<Team, number>();
  #closing = new Set<string>();
  #externalFlights = new WeakMap<TeamMember, {ref: TeamExecutionRef; result: Promise<TeamExternalObserved | null>}>();
  /**
   * Settle events of a team in this run: a member entering a settled state, or bringing a new report. The `settled`
   * count can go back down — a slow external read makes a member `unknown`, the next read finds it working — so a wait
   * that compared counts alone missed a report that only brought the count back to the leader's cursor. Each view
   * carries its own place in these events (`settledCursor`), which a wait takes back as `afterCursor`. For a count-only
   * cursor (`afterSettled`) `handed` keeps, per count, the earliest event a read gave out since a wait last answered with
   * that count (#handOut): another caller's read never moves it past an event. Two waiters on one count can still take
   * an event from each other there — only `afterCursor` is each caller's own.
   */
  #settles = new WeakMap<Team, {nonce: string; seq: number; seen: Map<string, string>; handed: Map<number, number>}>();
  constructor(readonly host: WorkroomTeamHost, readonly store: WorkroomTeamStore, readonly now: () => number = Date.now, readonly pollMs = 1_000) {}
  /** Ledger writes run one at a time so a report never overwrites a member start that finished meanwhile. */
  #serial<T>(work: () => Promise<T>): Promise<T> { const run = this.#chain.then(work, work); this.#chain = run.catch(() => {}); return run; }
  #touch(team: Team) { this.#revision.set(team, (this.#revision.get(team) ?? 0) + 1); team.updatedAt = new Date(this.now()).toISOString(); this.store.save(team); for (const wake of [...this.#waiters]) wake(); }
  #team(teamId: string): Team {
    const team = this.store.get(teamId);
    if (!team) throw new WorkroomTeamError('팀을 찾지 못했습니다. agentstoz_use_read_team(portId)로 목록을 확인하세요.', 'WORKROOM_TEAM_NOT_FOUND', 404);
    return team;
  }

  /** `git: false` skips the branch summary (4 Git spawns a member) for a reader that polls, the Workroom's 팀 현황. */
  async view(team: Team, {git: withGit = true, observeTimeoutMs = EXTERNAL_OBSERVE_MAX_MS}: {git?: boolean; observeTimeoutMs?: number} = {}): Promise<TeamView> {
    await this.#observeExternal(team, observeTimeoutMs);
    this.#observe(team);
    const settledCursor = `${this.#settleRecord(team).nonce}.${this.#settleSeq(team)}`;
    const scope = teamGitScope(team);
    const members = await Promise.all(team.members.map(async member => {
      const live = member.sessionId && member.targetId ? this.host.session(member.sessionId, member.targetId) : null;
      // Asked for every member: a branch left behind by a member that never reported must still be visible.
      const git = withGit && member.branch ? await this.host.branchGit(scope, team.baseCommit, member.branch).catch(() => null) : null;
      return {...member, session: live?.state ?? null, lastOutputAt: live?.lastOutputAt ?? member.observedOutputAt ?? null, git} satisfies TeamMemberView;
    }));
    const {fingerprint: _fingerprint, ...rest} = team;
    return {...rest, members, settled: members.filter(member => settledState(member)).length, settledCursor};
  }

  /**
   * The ledger follows what can still be seen, so a member is never reported as 「working」 forever:
   * `exited` — its Workroom ended without reporting; `unknown` — it belongs to an earlier run of the app, which can no
   * longer be observed (its branch and worktree are still there to check). Both settle a wait. A member Workroom that
   * 「다시 시작」 continued under a new session id is followed there first (#rebind), so it is not read as ended.
   */
  #observe(team: Team): void {
    if (team.state !== 'active') return;
    const earlier = this.store.fromEarlierRun(team.id);
    let changed = this.#rebind(team);
    for (const member of team.members) {
      if (member.state !== 'starting' && member.state !== 'working') continue;
      // An external surface is not a Workroom: only its own runtime may say what it sees (#observeExternal).
      if (member.execution?.kind === 'external') continue;
      const live = member.sessionId && member.targetId ? this.host.session(member.sessionId, member.targetId).state : null;
      // A member still 「starting」 in an earlier run never got its Workroom: that create did not reach it.
      const next = !member.sessionId ? (earlier ? 'unknown' as const : null)
        : live === 'exited' ? 'exited' as const
        : live === 'missing' ? (earlier ? 'unknown' as const : 'exited' as const)
        : null;
      if (next) { member.state = next; changed = true; }
    }
    if (changed) this.#touch(team);
  }
  /**
   * Moves a Workroom member to the session its 「다시 시작」 started, only through that exact lineage (host.continuation).
   * Another session opened on the same target — after an app restart, or a second one beside it — is never taken as
   * the member: close keeps its checkout instead. A member read as `exited` before its continuation was known is
   * working again. The leader's own Workroom is followed the same way when its target was recorded (Team.leader).
   * Returns whether anything changed; the caller writes the ledger.
   */
  #rebind(team: Team): boolean {
    if (team.state !== 'active' || !this.host.continuation) return false;
    let changed = false;
    const leader = team.leader.sessionId && team.leader.targetId ? this.host.continuation(team.leader.sessionId, team.leader.targetId) : null;
    if (leader && leader.sessionId !== team.leader.sessionId) { team.leader.sessionId = leader.sessionId; changed = true; }
    for (const member of team.members) {
      if (member.execution?.kind === 'external' || !member.sessionId || !member.targetId || member.state === 'closed') continue;
      const next = this.host.continuation(member.sessionId, member.targetId);
      if (!next || next.sessionId === member.sessionId) continue;
      member.sessionId = next.sessionId;
      if (member.execution?.kind === 'workroom') member.execution = {kind: 'workroom', sessionId: next.sessionId};
      if (member.state === 'exited') member.state = 'working';
      changed = true;
    }
    return changed;
  }
  /** The ledger brought up to date with what can be seen now, for an operation that reads one member's session. */
  refreshMembers(team: Team): void { this.#observe(team); }
  /** Whether `sessionId` is this team's leader (leadsTeam). */
  leads(team: Team, sessionId: string): boolean { return leadsTeam(team, sessionId, this.host); }
  /**
   * Whether `sessionId` is this member's Workroom: its recorded session, or the one that session's exact 다시 시작 lineage
   * continues in — whatever the member's state and before any read has moved the ledger there. Only ever used to refuse
   * a caller: a caller hint is never made into authority.
   */
  #holds(member: TeamMember, sessionId: string): boolean {
    if (!member.sessionId) return false;
    if (member.sessionId === sessionId) return true;
    return member.execution?.kind !== 'external' && !!member.targetId && this.host.continuation?.(member.sessionId, member.targetId)?.sessionId === sessionId;
  }

  create(request: Extract<WorkroomTeamRequest, {op: 'create'}>, caller: TeamCaller | null): Promise<{team: TeamView; replayed: boolean; untracked: number}> {
    return this.#serial(async () => {
      const fingerprint = JSON.stringify([request.portId, request.title, request.goal, request.members]);
      const existing = this.store.byRequest(request.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new WorkroomTeamError('이 requestId는 다른 팀 요청에 이미 쓰였습니다. 새 requestId로 요청하세요.', 'WORKROOM_TEAM_REQUEST_ID_CONFLICT', 409);
        // A retry replays the team it made; members that failed or never started are not started again.
        return {team: this.#handOut(existing, await this.view(existing)), replayed: true, untracked: 0};
      }
      // Its team was dropped to make room, so this id can no longer be replayed — and must not start a second team.
      if (this.store.isRetired(request.requestId)) throw new WorkroomTeamError(
        '이 requestId의 팀은 장부에서 정리되어 다시 재생할 수 없습니다. 같은 작업을 새로 시작하려면 새 requestId로 요청하세요.', 'WORKROOM_TEAM_REQUEST_ID_RETIRED', 409);
      const project = await this.host.resolveProject(request.portId);
      const primary = await this.host.primary(project.canonicalPath, caller?.targetId ?? null);
      if (primary.trackedChanges.length) throw new WorkroomTeamError(
        `커밋되지 않은 변경 ${primary.trackedChanges.length}개가 있습니다. 팀원은 HEAD에서 시작하므로 먼저 커밋하세요.`, 'WORKROOM_TEAM_SOURCE_DIRTY', 409, {changedPaths: primary.trackedChanges.slice(0, 12)});
      // Open sessions that join are checked before anything is written: a refusal leaves no team and no worktree behind.
      const joining = new Map<string, NonNullable<Awaited<ReturnType<WorkroomTeamHost['attachable']>>>>();
      // Which checkout each joined member works in, so one working tree never holds two writers.
      const checkouts: Array<{index: number; root: string; worker: boolean}> = [];
      for (const [index, input] of request.members.entries()) {
        if (!input.sessionId) continue;
        const refuse = (reason: string) => new WorkroomTeamError(`팀원 ${index + 1}: ${reason}`, 'WORKROOM_TEAM_ATTACH_REFUSED', 409, {sessionId: input.sessionId});
        // Without a caller the host could not tell the leader's own session from a member's, so 「not the leader」 would
        // go unchecked and a leader could type the brief into itself. A team of new Workrooms still needs no caller.
        if (!caller?.sessionId) throw refuse('열린 세션 합류는 리더 워크룸에서 요청합니다. 이 Mac이 어느 워크룸이 리더인지 확인하지 못했습니다.');
        if (caller.sessionId === input.sessionId) throw refuse('리더 자신의 세션은 팀원이 될 수 없습니다.');
        // Any member of an open team, not only one still working: a blocked member is waiting for that leader's answer
        // and a reported one may still be asked to fix something. The leader closes that team first.
        const busy = this.store.all().find(team => team.state === 'active' && team.members.some(member => member.state !== 'closed' && this.#holds(member, input.sessionId!)));
        if (busy) throw refuse(`그 세션은 다른 진행 중 팀(${busy.id})의 팀원입니다. 그 팀을 먼저 close한 뒤 합류시키세요.`);
        const info = await this.host.attachable(input.sessionId, {primaryPath: primary.path, baseCheckout: primary.base, baseCommit: primary.head});
        if (!info) throw refuse('그 세션이 이 Mac에서 실행 중이 아닙니다.');
        if (info.agent !== input.agent) throw refuse(`그 세션의 AI는 ${AGENT_LABEL[info.agent]}입니다.`);
        if (!info.sameRepository) throw refuse('그 세션은 이 프로젝트의 저장소 밖에서 실행 중입니다.');
        // A worker commits; in the primary or the leader's own checkout that would be the leader's branch, not its own.
        if (input.role !== 'reviewer' && (!info.linked || info.baseCheckout)) throw refuse('작업 팀원으로 합류하려면 그 세션이 자기 워크트리에서 실행 중이어야 합니다. 주 체크아웃이나 리더의 체크아웃에 있는 세션은 검토 담당으로만 합류합니다.');
        if (input.role !== 'reviewer' && !info.branch) throw refuse('그 세션의 워크트리가 브랜치에 있지 않습니다(detached HEAD).');
        // One working tree, one writer: two sessions of the same worktree (the Workroom's 「새 작업」 opens a second one)
        // would commit over each other on one branch, and a reviewer would be reading a tree being rewritten under it.
        const worker = input.role !== 'reviewer';
        const shared = checkouts.find(other => other.root === info.cwd && (worker || other.worker));
        if (shared) throw refuse(`팀원 ${shared.index + 1}이(가) 같은 체크아웃(${info.cwd})에서 일합니다. 작업 팀원은 체크아웃마다 한 명입니다.`);
        checkouts.push({index, root: info.cwd, worker});
        joining.set(input.sessionId, info);
      }
      const teamId = `team_${randomBytes(6).toString('hex')}`, short = teamId.slice(5, 11);
      const at = new Date(this.now()).toISOString();
      const team: Team = {id: teamId, requestId: request.requestId, fingerprint, projectId: project.projectId, projectName: project.projectName, primaryPath: primary.path,
        title: request.title, goal: request.goal, baseCommit: primary.head, baseBranch: primary.branch, baseCheckout: primary.base,
        leader: {sessionId: caller?.sessionId ?? null, agent: caller?.agent ?? null, ...(caller?.sessionId && caller.targetId ? {targetId: caller.targetId} : {})}, state: 'active', createdAt: at, updatedAt: at,
        members: request.members.map((input, index) => {
          const memberId = `m${index + 1}`, name = input.name ?? `${memberId}-${input.agent}`;
          const joined = input.sessionId ? joining.get(input.sessionId)! : null;
          const base = {id: memberId, name, agent: input.agent, ...(input.model ? {model: input.model} : {}), ...(input.provider ? {provider: input.provider} : {}), ...(input.effort ? {effort: input.effort} : {}), ...(input.role ? {role: input.role} : {}),
            // Launch options belong to a Workroom this team starts; a joined session runs with its own (the parser refuses them there).
            ...(input.sessionId ? {} : {...(input.accountId ? {accountId: input.accountId} : {}), ...(input.bypassPermissions ? {bypassPermissions: true as const} : {}),
              // The chosen surface is kept as asked, whatever its runtime does next. Absent = the Workroom, as before.
              ...(input.surface && input.surface !== 'internal' ? {surface: input.surface} : {}), ...(input.launchOptions ? {launchOptions: input.launchOptions} : {})}),
            task: input.task, state: 'starting' as const};
          // Joined: its own checkout and branch (a reviewer has none to merge), and its session from the start.
          return joined
            ? {...base, attached: true as const, ...(input.role !== 'reviewer' && !joined.containsBase ? {behindBase: true as const} : {}),
              branch: input.role === 'reviewer' ? '' : joined.branch!, worktreePath: joined.cwd, targetId: joined.targetId, sessionId: input.sessionId!}
            : {...base, branch: `team/${short}/${name}`, worktreePath: `${primary.path}/worktrees/team-${short}-${name}`, targetId: null, sessionId: null};
        })};
      if (new Set(team.members.map(member => member.name)).size !== team.members.length) throw invalid('팀원 이름이 겹칩니다.');
      // No two members may land on one branch — a joined session's own branch included, and never on the base branch.
      const branches = team.members.map(member => member.branch).filter(Boolean);
      if (new Set(branches).size !== branches.length) throw new WorkroomTeamError('두 팀원이 같은 브랜치에서 일할 수 없습니다.', 'WORKROOM_TEAM_ATTACH_REFUSED', 409);
      const onBase = team.members.find(member => member.attached && member.branch && team.baseBranch && member.branch === team.baseBranch);
      if (onBase) throw new WorkroomTeamError(`${onBase.id}: 그 세션은 리더가 병합할 브랜치(${team.baseBranch})에서 일하고 있습니다. 작업 팀원은 자기 브랜치에서 일해야 합니다.`, 'WORKROOM_TEAM_ATTACH_REFUSED', 409);
      // Written before any side effect: a crash mid-start leaves a team whose unstarted members read as 「starting」, never a hidden worktree.
      this.#touch(team);
      for (const member of team.members) {
        try {
          if (member.attached) {
            // Typed once under a host receipt. An outcome it cannot confirm is said so, and never typed a second time.
            const typed = await this.host.instruct({sessionId: member.sessionId!, prompt: teamMemberBrief(team, member), requestId: `team-${team.id}-${member.id}`})
              .catch((error: unknown) => {
                // The Workroom's own refusal speaks to a person at its composer (「작성 내용은 유지했으니…」); a team brief has
                // no composer and no kept draft, so only its first sentence — the reason — is passed on.
                const reason = error instanceof Error ? error.message.split(/(?<=[.!?。])\s/)[0]!.slice(0, 300) : '';
                throw new Error(`열린 세션에 팀원 지시문을 입력하지 못했습니다${reason ? ` — ${reason}` : '.'} 보관된 지시문은 없고 다시 입력하지 않습니다. 그 세션이 입력을 받을 준비가 되면 agentstoz_use_send_workroom_instruction으로 직접 보내세요.`);
              });
            member.execution = {kind: 'workroom', sessionId: member.sessionId!};
            member.delivery = typed === 'written' ? 'verified' : 'unknown';
            if (typed === 'written') member.state = 'working';
            else { member.state = 'failed'; member.error = '열린 세션에 지시문이 입력됐는지 확인하지 못했습니다. 다시 입력하지 않습니다 — 그 세션 화면을 읽고, 받지 못했으면 agentstoz_use_send_workroom_instruction으로 직접 보내세요.'; }
            this.#touch(team);
            continue;
          }
          // Preserve the four-argument host contract for existing Workroom members. Orca may choose its own managed
          // path/branch; record those before target derivation or any launch, including if the next step fails.
          const checkout = member.surface
            ? await this.host.addWorktree(team.primaryPath, member.worktreePath, member.branch, team.baseCommit, member.surface)
            : await this.host.addWorktree(team.primaryPath, member.worktreePath, member.branch, team.baseCommit);
          if (checkout) {
            member.worktreePath = checkout.path; member.branch = checkout.branch;
            this.#touch(team);
          }
          member.targetId = this.host.worktreeTargetId(team.projectId, member.worktreePath);
          // Durable before the Workroom starts: from here on the worktree exists, so a crash must leave a ledger row
          // that still names it — otherwise close reads 「missing」 and that worktree and branch are never cleaned up.
          this.#touch(team);
          const prompt = teamMemberBrief(team, member), requestId = `team-${team.id}-${member.id}`;
          const launch = {...(member.model ? {model: member.model} : {}), ...(member.provider ? {provider: member.provider} : {}),
            ...(member.accountId ? {accountId: member.accountId} : {}), ...(member.bypassPermissions ? {bypassPermissions: true as const} : {}),
            effort: member.effort ? {pinned: member.effort} : {requestText: member.task}};
          if (member.surface && isExternalTeamSurface(member.surface)) {
            // The user's surface is never replaced: without a runtime this member fails saying so, and a Workroom is
            // not started in its place. The runtime's own honest state is taken as given — opening is not working.
            if (!this.host.external) throw new Error(`${member.surface} 실행 런타임이 이 호스트에 연결되지 않았습니다. 워크룸으로 대신 시작하지 않습니다 — 연결한 뒤 다시 만드세요.`);
            const external = await this.host.external.start({teamId: team.id, memberId: member.id, memberName: member.name, agent: member.agent,
              plan: {surface: member.surface, ...(member.launchOptions ? {options: member.launchOptions} : {})},
              cwd: member.worktreePath, targetId: member.targetId, prompt, requestId, ...launch});
            member.execution = external.ref; member.state = external.state; member.delivery = external.delivery;
            if (external.note) member.note = external.note.slice(0, 300);
          } else {
            const started = await this.host.start({targetId: member.targetId, agent: member.agent, prompt, requestId,
              ...(member.model ? {model: {model: member.model, ...(member.provider ? {provider: member.provider} : {})}} : {}),
              ...(member.accountId ? {accountId: member.accountId} : {}), ...(member.bypassPermissions ? {bypassPermissions: true} : {}),
              effort: launch.effort});
            member.sessionId = started.sessionId; member.execution = {kind: 'workroom', sessionId: started.sessionId};
            member.state = 'working'; member.delivery = 'verified';
          }
        } catch (error) {
          member.state = 'failed'; member.error = error instanceof Error ? error.message.slice(0, 600) : '팀원 시작 실패';
        }
        this.#touch(team);
      }
      return {team: this.#handOut(team, await this.view(team)), replayed: false, untracked: primary.untracked};
    });
  }

  async read(request: Extract<WorkroomTeamRequest, {op: 'read'}>): Promise<{team?: TeamView; teams?: TeamView[]}> {
    if (request.teamId) { const team = this.#team(request.teamId); return {team: this.#handOut(team, await this.view(team))}; }
    const project = await this.host.resolveProject(request.portId!);
    const teams = this.store.all().filter(team => team.projectId === project.projectId).slice(-10).reverse();
    return {teams: await Promise.all(teams.map(async team => this.#handOut(team, await this.view(team))))};
  }

  /**
   * The external surfaces, asked through their own runtime. A runtime that cannot read a handle changes nothing: the
   * member keeps the honest state its start produced (`awaiting-ack` and friends never settle a wait), and a team from
   * an earlier run of the app that nothing can observe becomes `unknown` rather than 「working」 forever.
   */
  async #externalObservation(member: TeamMember, ref: Extract<TeamExecutionRef, {kind: 'external'}>, timeoutMs: number): Promise<TeamExternalObserved | null> {
    let flight = this.#externalFlights.get(member);
    if (!flight || flight.ref !== ref) {
      const result = Promise.resolve().then(() => this.host.external!.observe!(ref)).catch(() => null);
      flight = {ref, result}; this.#externalFlights.set(member, flight);
      const current = flight;
      void result.finally(() => { if (this.#externalFlights.get(member) === current) this.#externalFlights.delete(member); });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([flight.result, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  async #observeExternal(team: Team, timeoutMs = EXTERNAL_OBSERVE_MAX_MS): Promise<void> {
    if (team.state !== 'active' || this.#closing.has(team.id) || timeoutMs <= 0) return;
    const pending = team.members.filter(member => member.execution?.kind === 'external'
      && (member.state === 'starting' || member.state === 'working' || member.state === 'unknown' || member.state === 'awaiting-connection' || member.state === 'awaiting-manual-join' || member.state === 'awaiting-ack'));
    if (pending.length === 0) return;
    const revision = this.#revision.get(team) ?? 0, earlier = this.store.fromEarlierRun(team.id);
    const snapshots = pending.map(member => ({member, ref: member.execution as Extract<TeamExecutionRef, {kind: 'external'}>, state: member.state, manual: member.manual, report: member.report}));
    // Parallel and bounded, with one underlying read per member. A timed-out read never applies later or launches anything.
    const results = this.host.external?.observe
      ? await Promise.all(snapshots.map(({member, ref}) => this.#externalObservation(member, ref, Math.min(EXTERNAL_OBSERVE_MAX_MS, timeoutMs))))
      : snapshots.map(() => undefined);
    if (team.state !== 'active' || this.#closing.has(team.id) || this.store.get(team.id) !== team || (this.#revision.get(team) ?? 0) !== revision) return;
    let changed = false;
    snapshots.forEach(({member, ref, state, manual, report}, index) => {
      if (!team.members.includes(member) || member.execution !== ref || member.state !== state || member.manual !== manual || member.report !== report) return;
      const seen = results[index];
      if (!seen) {
        // No observer in this run preserves the manual state; a failed/timed-out probe cannot claim ongoing work.
        if ((seen === null || earlier && !manual) && member.state !== 'unknown') { member.state = 'unknown'; changed = true; }
        return;
      }
      const waiting = seen.state === 'awaiting-connection' || seen.state === 'awaiting-manual-join' || seen.state === 'awaiting-ack';
      if (!(manual && waiting) && seen.state !== member.state) { member.state = seen.state; changed = true; }
      if (seen.delivery && !(manual?.confirmed === 'delivered' && seen.delivery !== 'verified') && seen.delivery !== member.delivery) { member.delivery = seen.delivery; changed = true; }
      if (seen.note && seen.note.slice(0, 300) !== member.note) { member.note = seen.note.slice(0, 300); changed = true; }
      if (Number.isSafeInteger(seen.lastOutputAt) && seen.lastOutputAt! >= 0 && seen.lastOutputAt! <= this.now() + 60_000 && seen.lastOutputAt !== member.observedOutputAt) {
        member.observedOutputAt = seen.lastOutputAt!; changed = true;
      }
    });
    if (changed) this.#touch(team);
  }

  /** Ledger states and live sessions only — no Git — so a wait can look every second. */
  async #settled(team: Team, timeoutMs = EXTERNAL_OBSERVE_MAX_MS): Promise<number> {
    await this.#observeExternal(team, timeoutMs);
    this.#observe(team);
    return team.members.filter(member => settledState(member)).length;
  }
  #settleRecord(team: Team) {
    let record = this.#settles.get(team);
    if (!record) this.#settles.set(team, record = {nonce: randomBytes(4).toString('hex'), seq: 0, seen: new Map(), handed: new Map()});
    return record;
  }
  #settleSeq(team: Team): number {
    const record = this.#settleRecord(team);
    for (const member of team.members) {
      const mark = settledState(member) ? `${member.state}:${member.report?.at ?? ''}` : '';
      if (mark && mark !== record.seen.get(member.id)) record.seq++;
      record.seen.set(member.id, mark);
    }
    return record.seq;
  }
  /** A view given to a caller, whose `settled` may come back as a count-only cursor. `answered`: a wait's own answer. */
  #handOut(team: Team, view: TeamView, answered = false): TeamView {
    const seq = Number(view.settledCursor.split('.')[1]), handed = this.#settleRecord(team).handed, earlier = handed.get(view.settled);
    handed.set(view.settled, answered || earlier === undefined ? seq : Math.min(earlier, seq));
    return view;
  }
  /** Returns when a member settles (`any`) or all have (`all`), or at the timeout — never later than the MCP bound. */
  async wait(request: Extract<WorkroomTeamRequest, {op: 'wait'}>): Promise<{team: TeamView; timedOut: boolean}> {
    const deadline = this.now() + request.timeoutMs;
    const team = this.#team(request.teamId), total = team.members.length, first = request.afterSettled ?? await this.#settled(team, Math.max(0, deadline - this.now()));
    // Events after the caller's own view (afterCursor). One from another run or team cannot say what it saw, so it is
    // answered at once with a view it can wait from. A count this run never gave out, or no cursor, counts from now.
    const record = this.#settleRecord(team), [nonce, at] = request.afterCursor?.split('.') ?? [];
    const since = request.afterCursor !== undefined ? (nonce === record.nonce ? Math.min(Number(at), this.#settleSeq(team)) : -1)
      : (request.afterSettled === undefined ? undefined : record.handed.get(request.afterSettled)) ?? this.#settleSeq(team);
    const done = (settled: number) => settled === total || request.until === 'any' && (settled > first || this.#settleSeq(this.#team(request.teamId)) > since);
    let timedOut = false;
    while (!done(await this.#settled(this.#team(request.teamId), Math.max(0, deadline - this.now())))) {
      const remaining = deadline - this.now();
      if (remaining <= 0) { timedOut = true; break; }
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); this.#waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, Math.min(this.pollMs, remaining)); this.#waiters.add(wake);
      });
    }
    const waited = this.#team(request.teamId);
    return {team: this.#handOut(waited, await this.view(waited, {observeTimeoutMs: Math.max(0, deadline - this.now())}), true), timedOut};
  }

  /**
   * Not queued behind the ledger chain: a member's report is its only way to reach the leader, and waiting for a create
   * that is still starting six Workrooms ran past the MCP client's own timeout. Nothing is awaited between reading the
   * team and writing it, so this still cannot interleave with another ledger write.
   */
  async report(request: Extract<WorkroomTeamRequest, {op: 'report'}>, caller: TeamCaller | null): Promise<{team: TeamView}> {
    const team = this.#team(request.teamId);
    if (team.state !== 'active') throw new WorkroomTeamError('이미 정리된 팀입니다.', 'WORKROOM_TEAM_CLOSED', 409);
    const member = team.members.find(item => item.id === request.memberId);
    if (!member) throw new WorkroomTeamError('그 memberId는 이 팀에 없습니다.', 'WORKROOM_TEAM_MEMBER_NOT_FOUND', 404);
    // A hint, not authority (workroomCaller.ts): it only stops one member from reporting as another — also from the
    // session a 다시 시작 continued that member in, before any read has moved the ledger there.
    if (this.#rebind(team)) this.#touch(team);
    const otherMember = caller && team.members.some(item => item.id !== member.id && this.#holds(item, caller.sessionId));
    if (otherMember) throw new WorkroomTeamError('다른 팀원의 보고는 그 팀원 워크룸에서만 보냅니다.', 'WORKROOM_TEAM_REPORT_DENIED', 403);
    /**
     * A caller hint is not authority (workroomCaller.ts), so it is never widened into one. What it can do is tell a
     * report apart: a member on an external surface has no Workroom session to be recognised by, so a report for it
     * must say `manual: true` and is recorded as the leader's own words — never as that AI's verified report.
     */
    const external = member.execution?.kind === 'external' || !!member.surface && isExternalTeamSurface(member.surface);
    if (external && !request.manual) {
      throw new WorkroomTeamError(`${member.id}은(는) ${member.surface ?? '외부'} 표면에서 실행 중이어서 그 팀원의 보고를 호스트가 확인할 수 없습니다. 화면에서 읽은 내용을 manual: true로 보내면 「사람이 옮긴 보고」로 기록합니다.`,
        'WORKROOM_TEAM_REPORT_UNVERIFIED', 409);
    }
    if (request.manual && (team.leader.sessionId ? !caller || !this.leads(team, caller.sessionId) : caller !== null)) throw new WorkroomTeamError('수동 보고는 이 팀의 리더가 합니다.', 'WORKROOM_TEAM_REPORT_DENIED', 403);
    if (request.manual && !external) throw new WorkroomTeamError(`${member.id}은(는) 워크룸 팀원이라 자기 보고를 그대로 씁니다. manual을 빼고 그 워크룸에서 보고하세요.`, 'WORKROOM_TEAM_REPORT_DENIED', 403);
    if (member.report?.status === request.status && member.report.summary === request.summary && (member.report.provenance ?? 'member') === (request.manual ? 'manual' : 'member')) return {team: await this.view(team)};
    member.report = {status: request.status, summary: request.summary, at: new Date(this.now()).toISOString(), provenance: request.manual ? 'manual' : 'member'};
    member.state = request.status === 'done' ? 'reported' : 'blocked';
    this.#touch(team);
    return {team: await this.view(team)};
  }

  /**
   * The leader's own confirmation for a surface the host cannot read. `started` leaves the member working with a manual
   * provenance; `delivered` says the brief itself was seen to arrive. It writes no report and claims nothing about what
   * the member produced — a result still needs an explicit manual report.
   */
  async confirm(request: Extract<WorkroomTeamRequest, {op: 'confirm'}>, caller: TeamCaller | null): Promise<{team: TeamView}> {
    const team = this.#team(request.teamId);
    if (team.state !== 'active') throw new WorkroomTeamError('이미 정리된 팀입니다.', 'WORKROOM_TEAM_CLOSED', 409);
    const member = team.members.find(item => item.id === request.memberId);
    if (!member) throw new WorkroomTeamError('그 memberId는 이 팀에 없습니다.', 'WORKROOM_TEAM_MEMBER_NOT_FOUND', 404);
    if (member.execution?.kind !== 'external') {
      throw new WorkroomTeamError(`${member.id}은(는) 워크룸 팀원이라 호스트가 직접 확인합니다. 수동 확인은 외부 표면 팀원에만 씁니다.`, 'WORKROOM_TEAM_CONFIRM_DENIED', 409);
    }
    if (team.leader.sessionId ? !caller || !this.leads(team, caller.sessionId) : caller !== null) throw new WorkroomTeamError('수동 확인은 이 팀의 리더가 합니다.', 'WORKROOM_TEAM_CONFIRM_DENIED', 403);
    // Replaying an earlier confirmation is a no-op; started never replaces an already confirmed delivery.
    if (member.manual && (member.manual.confirmed === request.confirm || member.manual.confirmed === 'delivered')) return {team: await this.view(team)};
    // A member that already reported, failed or was closed is not moved back into work by a confirmation.
    if (settledState(member)) throw new WorkroomTeamError(`${member.id}은(는) 이미 ${member.state} 상태입니다.`, 'WORKROOM_TEAM_CONFIRM_DENIED', 409);
    const callerIsMember = caller && team.members.some(item => this.#holds(item, caller.sessionId));
    if (callerIsMember) throw new WorkroomTeamError('수동 확인은 리더가 합니다.', 'WORKROOM_TEAM_CONFIRM_DENIED', 403);
    member.manual = {confirmed: request.confirm, at: new Date(this.now()).toISOString()};
    member.state = 'working';
    if (request.confirm === 'delivered') member.delivery = 'manual';
    this.#touch(team);
    return {team: await this.view(team)};
  }

  /** The target a member worktree would have, for a ledger row whose own start never recorded one. */
  #derivedTarget(team: Team, member: TeamMember): string | null {
    if (member.targetId) return member.targetId;
    try { return this.host.worktreeTargetId(team.projectId, member.worktreePath); } catch { return null; }
  }

  close(request: Extract<WorkroomTeamRequest, {op: 'close'}>, caller: TeamCaller | null): Promise<{team: TeamView; outcomes: TeamCloseOutcome[]}> {
    return this.#serial(async () => {
      const team = this.#team(request.teamId);
      // A member continued by 「다시 시작」 is recognised, and closed, through the session it runs in now.
      if (this.#rebind(team)) this.#touch(team);
      if (caller && team.members.some(member => this.#holds(member, caller.sessionId))) throw new WorkroomTeamError('팀 정리는 리더가 합니다.', 'WORKROOM_TEAM_CLOSE_DENIED', 403);
      this.#closing.add(team.id);
      try {
      const scope = teamGitScope(team);
      const outcomes: TeamCloseOutcome[] = [];
      let unfinished = false;
      for (const member of team.members) {
        let session: 'closed' | 'not-running' = 'not-running';
        if (member.attached) {
          // Joined from an open session: the team made none of it, so it ends nothing, removes nothing and deletes nothing.
          if (member.state === 'starting' || member.state === 'working') member.state = 'closed';
          outcomes.push({memberId: member.id, session: 'kept', worktree: 'kept', branch: 'kept'});
          continue;
        }
        const ref = member.execution?.kind === 'external' ? member.execution : null;
        if (!ref && member.surface && isExternalTeamSurface(member.surface)) {
          // The launcher may have created a live process before its ref was persisted. Never treat it as a Workroom.
          unfinished = true; member.state = 'unknown';
          outcomes.push({memberId: member.id, session: 'kept', worktree: 'kept', branch: 'kept',
            error: '외부 팀원의 실행 기록을 확인하지 못해 워크트리를 그대로 두었습니다. 실행 결과를 먼저 확인하세요.'});
          continue;
        }
        if (ref) {
          try {
            /**
             * An external surface is the user's own window: only a handle this team started is ended, and only when the
             * runtime says it ended. Anything else — not owned, no close support, or a result it is unsure of — keeps
             * the process alone AND keeps the worktree, because work may still be running in it.
             */
            const ended = ref.owned && this.host.external?.close ? await this.host.external.close(ref) : {closed: 'unknown' as const};
            const confirmed = ended.closed === 'closed' || ended.closed === 'not-running';
            if (ended.note) member.note = ended.note.slice(0, 300);
            if (!confirmed) unfinished = true;
            const branch = await this.host.branchGit(scope, team.baseCommit, member.branch).catch(() => null) ? 'kept' as const : 'missing' as const;
            if (member.state !== 'reported' && member.state !== 'blocked' && !settledState(member)) member.state = confirmed ? 'closed' : 'unknown';
            outcomes.push({memberId: member.id, session: confirmed ? (ended.closed === 'closed' ? 'closed' : 'not-running') : 'kept', worktree: 'kept', branch,
              ...(confirmed ? {} : {error: `${ref.effectiveSurface ?? ref.surface} 실행이 끝났는지 확인하지 못해 워크트리를 그대로 두었습니다. 그 화면에서 직접 끝내고 다시 정리하세요.`})});
          } catch (error) {
            unfinished = true;
            outcomes.push({memberId: member.id, session: 'kept', worktree: 'kept-error', branch: 'kept-error',
              error: error instanceof Error ? error.message.slice(0, 600) : '외부 팀원 정리 실패'});
          }
          continue;
        }
        try {
          // What the worktree says, not what the ledger remembers: a crash between the worktree and the start leaves a
          // row with no target, and that worktree must still be cleaned up.
          const targetId = this.#derivedTarget(team, member);
          // Only the session this team recorded — followed through its exact 다시 시작 lineage — is the team's to end. A row
          // without one (its start failed or never answered) owns no Workroom, so one running there is kept below.
          const sessionId = member.sessionId;
          if (sessionId && targetId && this.host.session(sessionId, targetId).state === 'running') { await this.host.close(sessionId); session = 'closed'; }
          // Asked after this member's own session is closed: any Workroom still running in this checkout is not the team's
          // — reopened after an app restart, opened beside it by a person, or opened under another target for the same
          // folder. It keeps its folder and branch, and the team stays active until it is closed; removing the folder
          // would leave that CLI running in a directory that is gone.
          const other = targetId ? await this.host.sessionForTarget(targetId, member.worktreePath) : null;
          if (other) {
            unfinished = true;
            outcomes.push({memberId: member.id, session: session === 'closed' ? 'closed' : 'kept', worktree: 'kept', branch: 'kept',
              error: `다른 워크룸 세션(${other.sessionId.slice(0, 8)})이 아직 이 작업 폴더에서 실행 중이어서 작업 폴더와 브랜치를 그대로 두었습니다. 그 워크룸을 닫은 뒤 다시 정리하세요.`});
            continue;
          }
          const removed = await this.host.removeWorktree(team.primaryPath, member.worktreePath);
          const worktree = removed === 'dirty' ? 'kept-dirty' as const : removed;
          // A dirty worktree still has its branch checked out; never delete under it.
          const branch = !request.deleteMergedBranches || worktree === 'kept-dirty'
            ? (await this.host.branchGit(scope, team.baseCommit, member.branch).catch(() => null) ? 'kept' as const : 'missing' as const)
            : await this.host.deleteMergedBranch(scope, member.branch).then(result => result === 'unmerged' ? 'kept-unmerged' as const : result);
          if (member.state === 'starting' || member.state === 'working') member.state = 'closed';
          outcomes.push({memberId: member.id, session, worktree, branch});
        } catch (error) {
          // One member's cleanup never decides the others': everyone is tried, and what is left is said so.
          unfinished = true;
          outcomes.push({memberId: member.id, session, worktree: 'kept-error', branch: 'kept-error',
            error: error instanceof Error ? error.message.slice(0, 600) : '팀원 정리 실패'});
        }
      }
      // A team whose cleanup did not finish stays active so the leader can close it again; nothing was dropped.
      team.state = unfinished ? 'active' : 'closed';
      this.#touch(team);
      return {team: await this.view(team), outcomes};
      } finally { this.#closing.delete(team.id); }
    });
  }
}
