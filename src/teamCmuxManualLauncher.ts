/** Private host adapter for a connected cmux. CLI acceptance is a manual launch, never agent/runtime verification. */
import {isAbsolute} from 'node:path';
import type {TeamProjectLauncherDeps} from './teamProjectLauncher';
import type {TeamExternalScope} from './teamExternalRuntime';
import type {TeamExternalManualLaunchResult} from './teamExternalHost';

export interface TeamCmuxRunResult {exitCode: number | null; stdout: string}
export type TeamCmuxManualLaunch = Parameters<NonNullable<TeamProjectLauncherDeps['openCmuxTerminal']>>[0];
export interface TeamCmuxManualLauncherDeps {
  platform?: NodeJS.Platform;
  resolveCmuxCli(): string | null | Promise<string | null>;
  /** The host's existing runner owns its environment; this interface accepts no caller environment or socket path. */
  run(cli: string, argv: readonly string[], options: {cwd: '/'; timeoutMs: number; attempts: 1}): TeamCmuxRunResult | Promise<TeamCmuxRunResult>;
  isCurrent(scope: TeamExternalScope): boolean;
}
export class TeamCmuxManualLauncherError extends Error {
  constructor(readonly code: string) {super(code);}
}
const fail = (code: string): never => {throw new TeamCmuxManualLauncherError(code);};
const clean = (value: unknown): value is string => typeof value === 'string' && !!value && !/[\x00-\x1f\x7f]/.test(value);
function checked(raw: TeamCmuxManualLaunch): TeamCmuxManualLaunch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !['scope', 'title', 'command', 'executable', 'argv'].includes(key))) return fail('TEAM_CMUX_PLAN_INVALID');
  const plan = structuredClone(raw), scope = plan.scope;
  if (!scope || scope.surface !== 'cmux' || !Number.isSafeInteger(scope.generation) || scope.generation < 0
    || ![scope.executionId, scope.hostInstanceId, scope.teamId, scope.memberId, scope.targetId, scope.cwd, plan.title, plan.executable].every(clean)
    || !isAbsolute(scope.cwd) || !['codex', 'claude', 'hermes', 'agy'].includes(scope.agent)
    || typeof plan.command !== 'string' || !plan.command.trim() || plan.command.includes('\0')
    || !Array.isArray(plan.argv) || !plan.argv.every(arg => typeof arg === 'string' && !arg.includes('\0'))) return fail('TEAM_CMUX_PLAN_INVALID');
  return plan;
}

export function createTeamCmuxManualLauncher(deps: TeamCmuxManualLauncherDeps) {
  const platform = deps.platform ?? process.platform;
  const current = (scope: TeamExternalScope) => {if (!deps.isCurrent(structuredClone(scope))) fail('TEAM_CMUX_GENERATION_STALE');};
  async function resolve(): Promise<string> {
    if (platform !== 'darwin') return fail('TEAM_CMUX_PLATFORM_UNSUPPORTED');
    let cli: string | null;
    try {cli = await deps.resolveCmuxCli();} catch {return fail('TEAM_CMUX_CONNECTION_REQUIRED');}
    if (!clean(cli) || !isAbsolute(cli)) return fail('TEAM_CMUX_CONNECTION_REQUIRED');
    return cli;
  }
  async function connected(): Promise<boolean> {
    try {
      const cli = await resolve(), result = await deps.run(cli, ['ping'], {cwd: '/', timeoutMs: 2_000, attempts: 1});
      return result?.exitCode === 0 && typeof result.stdout === 'string' && result.stdout.trim() === 'PONG';
    } catch {return false;}
  }
  async function openCmuxTerminal(raw: TeamCmuxManualLaunch): Promise<TeamExternalManualLaunchResult> {
    // Only the private project launcher supplies this already-validated full command, including bg/tmux and the brief.
    // It is not accepted from a wire API. Never send a command to an existing/active terminal after creating a window.
    const plan = checked(raw); current(plan.scope);
    const cli = await resolve(); current(plan.scope);
    let result: TeamCmuxRunResult;
    try {result = await deps.run(cli, ['new-workspace', '--cwd', plan.scope.cwd, '--command', plan.command, '--name', plan.title],
      {cwd: '/', timeoutMs: 8_000, attempts: 1});}
    catch {return fail('TEAM_CMUX_LAUNCH_UNCERTAIN');}
    current(plan.scope);
    if (result?.exitCode !== 0 || typeof result.stdout !== 'string') return fail('TEAM_CMUX_LAUNCH_UNCERTAIN');
    // Do not expose stdout: it can contain socket/local process information. Exit 0 proves CLI acceptance only.
    return {opened: true, surface: 'cmux'};
  }
  return {connected, openCmuxTerminal};
}
