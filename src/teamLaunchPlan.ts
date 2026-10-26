/**
 * 팀 작전 — the launch surface and options a team member is started on, and the binding its execution is read back
 * through. One canonical core contract for 팀 UI and MCP: a member keeps the surface and options the user chose
 * (`/tmp/agentstoz-team-launch-contract.json` v1), and a surface is never quietly substituted with a Workroom.
 *
 * This module holds the strict normalizer and the injected runtime interface only. It starts nothing: `internal` stays
 * on the app's own Workroom PTY (src/workroomTeamHost.ts), and every external surface is reached through
 * `TeamExternalRuntime`, which src/teamExternalRuntime.ts implements and the host wiring injects.
 *
 * The browser-safe catalog and strict parser live in src/teamLaunchOptions.ts. This module only delegates to them
 * and defines the injected runtime binding; UI and create requests cannot drift into separate launch policies.
 */
import type {AiTerminalAgent} from './aiTerminalProtocol';
import {parseTeamMemberSelection, type TeamLaunchOptions, type TeamLaunchSurface} from './teamLaunchOptions';
export {TEAM_LAUNCH_SURFACES, TEAM_LAUNCH_OPTION_KEYS, type TeamLaunchOptions, type TeamLaunchSurface} from './teamLaunchOptions';

export type TeamExternalSurface = Exclude<TeamLaunchSurface, 'internal'>;
export const isExternalTeamSurface = (surface: TeamLaunchSurface): surface is TeamExternalSurface => surface !== 'internal';
export interface TeamLaunchPlan { surface: TeamLaunchSurface; options?: TeamLaunchOptions }

/** The catalog's strict parser is shared with the builder and MCP; no second surface policy lives here. */
export function normalizeTeamLaunch(input: {agent: AiTerminalAgent; surface?: unknown; launchOptions?: unknown}): TeamLaunchPlan {
  const member = parseTeamMemberSelection(input);
  return {surface: member.surface ?? 'internal', ...(member.launchOptions ? {options: member.launchOptions} : {})};
}

/** Legacy reports without an explicit provenance remain member reports. Browser-safe: no ledger imports. */
export const teamReportProvenance = (report: {provenance?: 'member' | 'manual'} | undefined): 'member' | 'manual' => report?.provenance === 'manual' ? 'manual' : 'member';

/**
 * What a member's work is actually reached through. `workroom` keeps the legacy `sessionId` so every existing team,
 * including an attached open session, reads and closes exactly as before. `external` is an opaque host-side handle:
 * nothing here is a credential, a local path or a command, because this travels into the ledger and the 팀 현황 view.
 */
export type TeamExecutionRef =
  | {kind: 'workroom'; sessionId: string}
  | {
      kind: 'external';
      surface: TeamExternalSurface;
      /** The surface actually reached, when the runtime had to fall back within the same choice (never another surface). */
      effectiveSurface?: TeamExternalSurface;
      /** The runtime that owns the handle (e.g. 'orca', 'cmux'), for reading it back after a restart. */
      runtime: string;
      /** Opaque to the core: a terminal handle, workspace id or app conversation id. Never a secret or a path. */
      handle: string;
      /** True only when this team started the process: a surface the user already had open is never closed by the team. */
      owned: boolean;
      /** What the runtime proved it can do on this handle, so the ledger never implies a read it cannot make. */
      evidence?: {send?: boolean; read?: boolean};
    };

/** How a member's brief actually arrived. `unknown` is kept as unknown: it is never retried and never read as delivered. */
export type TeamDelivery = 'verified' | 'manual' | 'unknown' | 'not-sent';
/** A state a member can be parked in while the user's chosen surface is not yet usable or not yet confirmed. */
export const TEAM_AWAITING_STATES = ['awaiting-connection', 'awaiting-manual-join', 'awaiting-ack'] as const;
export type TeamAwaitingState = (typeof TEAM_AWAITING_STATES)[number];

export interface TeamExternalLaunch {
  teamId: string; memberId: string; memberName: string; agent: AiTerminalAgent;
  plan: TeamLaunchPlan;
  /** The team's own member worktree, the one cwd an external launch may use. */
  cwd: string;
  /** The registered worktree target of that cwd, re-resolved by the runtime before any write. */
  targetId: string | null;
  prompt: string;
  /** Idempotency for the surface: one launch per member, never a second terminal after an unclear result. */
  requestId: string;
  model?: string; provider?: string; accountId?: string; bypassPermissions?: true;
  effort: {pinned: string} | {requestText: string};
}
export interface TeamExternalStarted {
  ref: Extract<TeamExecutionRef, {kind: 'external'}>;
  /**
   * `working` only when the runtime saw the member's own process with the brief delivered. Opening a window, filling a
   * prompt or copying a brief is not work: that is `awaiting-ack` (sent, not acknowledged), `awaiting-manual-join`
   * (the user must start or confirm it) or `awaiting-connection` (the runtime is not reachable yet).
   */
  state: 'working' | 'unknown' | TeamAwaitingState;
  delivery: TeamDelivery;
  /** One short line for the team status, in the user's language. No secrets, paths, commands or environment. */
  note?: string;
}
export interface TeamExternalObserved {
  state: 'working' | 'exited' | 'unknown' | TeamAwaitingState;
  lastOutputAt?: number | null;
  delivery?: TeamDelivery;
  note?: string;
}

/**
 * The injected external runtime (src/teamExternalRuntime.ts). Every method is optional except `start`, so a host that
 * has no runtime, or a runtime that cannot read a surface yet, is reported honestly instead of being guessed at.
 */
export interface TeamExternalRuntime {
  start(input: TeamExternalLaunch): Promise<TeamExternalStarted>;
  observe?(ref: Extract<TeamExecutionRef, {kind: 'external'}>): Promise<TeamExternalObserved>;
  /** One submission of one text. A result the runtime is unsure of must come back as `unknown`, never as sent. */
  send?(ref: Extract<TeamExecutionRef, {kind: 'external'}>, text: string, requestId: string): Promise<{delivery: TeamDelivery; note?: string}>;
  /** Only ever called for `owned` handles. `unknown` keeps the member's worktree, because its process may still run. */
  close?(ref: Extract<TeamExecutionRef, {kind: 'external'}>): Promise<{closed: 'closed' | 'not-running' | 'unknown'; note?: string}>;
}

/** A line of the member's own state for the team status: what was asked for, and what actually happened. */
export const teamLaunchSummary = (plan: TeamLaunchPlan): string => {
  const options = plan.options ?? {};
  const parts = [plan.surface, ...(options.bgMode !== undefined ? [options.bgMode ? 'bg' : 'bg off'] : []), ...(options.tmuxMode !== undefined ? [options.tmuxMode ? 'tmux' : 'tmux off'] : []),
    ...(options.reuse ? [options.reuse] : []), ...(options.appMode ? [options.appMode] : [])];
  return parts.join(' · ');
};
