/** Host-only team launcher. The existing project launchers remain unchanged; every write uses the member's exact surface. */
import {createHash} from 'node:crypto';
import {isAbsolute, win32} from 'node:path';
import {aiTerminalLaunchArgs} from './aiTerminalLaunchArgs';
import {normalizeCodeAppTask} from './codeAppTask';
import {teamLaunchReuseAvailable, teamLaunchSupport} from './teamLaunchOptions';
import type {TeamExternalScope} from './teamExternalRuntime';
import type {TeamExternalManualLaunchResult, TeamExternalOrcaRunner, TeamExternalTerminalLaunchPlan} from './teamExternalHost';

export interface TeamProjectTerminalOutcome {verified: boolean; warning?: string}
/** Windows owns quoting/path conversion. A Mac must never substitute iTerm for PowerShell or WSL. */
export interface TeamProjectWindowsLaunch {
  surface: 'powershell' | 'wsl'; scope: TeamExternalScope; executable: string; argv: string[]; title: string;
  tmux?: {sessionName: string; ownership: string; reuse: 'new' | 'reuse-or-new'};
}
export interface TeamProjectLauncherDeps {
  platform?: NodeJS.Platform;
  /** Host-instance registry budget: default 128, hard maximum 256, including pending/uncertain/retired launches. */
  maxOwnedHandles?: number;
  /** The team's current generation and checkout ownership, checked again after every awaited resolution. */
  isCurrent(scope: TeamExternalScope): boolean;
  resolveOrcaCli?(): string | null | Promise<string | null>;
  runOrca?: TeamExternalOrcaRunner;
  openTerminalWithCmd?(command: string, folderPath: null, title: string, surface: 'iterm' | 'terminal'): Promise<TeamProjectTerminalOutcome>;
  /** Only an already connected cmux adapter may provide this. It must return the same exact surface. */
  openCmuxTerminal?(input: {scope: TeamExternalScope; title: string; command: string; executable: string; argv: string[]}): Promise<TeamExternalManualLaunchResult>;
  openWindowsTerminal?(input: TeamProjectWindowsLaunch): Promise<TeamExternalManualLaunchResult>;
}
export class TeamProjectLauncherError extends Error {
  constructor(readonly code: string) {super(code);}
}
const fail = (code: string): never => {throw new TeamProjectLauncherError(code);};
async function privateOutcome<T>(call: () => Promise<T>, code: string): Promise<T> {
  try {return await call();} catch {return fail(code);}
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const extra = (value: object, allowed: readonly string[]) => Object.keys(value).some(key => !allowed.includes(key));
const clean = (value: unknown): value is string => typeof value === 'string' && !!value && !/[\x00-\x1f\x7f]/.test(value);
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const baseCommand = (plan: TeamExternalTerminalLaunchPlan, argv = plan.argv) =>
  `cd -- ${quote(plan.scope.cwd)} && exec ${[plan.executable, ...argv].map(quote).join(' ')}`;
const scopeKey = (scope: TeamExternalScope) => digest([scope.hostInstanceId, scope.teamId, scope.memberId, scope.executionId,
  scope.targetId, scope.generation, scope.cwd, scope.agent, scope.surface]);
/** A full digest avoids leaf-name, sanitized-name and old-generation collisions. Never a global project session. */
export const teamProjectTmuxSessionName = (scope: TeamExternalScope) => `atz-team-${scopeKey(scope)}`;

function validated(raw: TeamExternalTerminalLaunchPlan, deps: TeamProjectLauncherDeps): TeamExternalTerminalLaunchPlan {
  if (!record(raw) || extra(raw, ['scope', 'requested', 'title', 'executable', 'argv', 'command', 'initialPrompt'])
    || !record(raw.scope) || extra(raw.scope, ['executionId', 'hostInstanceId', 'teamId', 'memberId', 'targetId', 'cwd', 'generation', 'agent', 'surface'])
    || !record(raw.requested) || extra(raw.requested, ['model', 'provider', 'accountId', 'effort', 'bypassPermissions', 'launchOptions'])) return fail('TEAM_PROJECT_PLAN_INVALID');
  const plan = structuredClone(raw), {scope, requested} = plan, platform = deps.platform ?? process.platform;
  if (![scope.executionId, scope.hostInstanceId, scope.teamId, scope.memberId, scope.targetId, scope.cwd, plan.title, plan.executable].every(clean)
    || !Number.isSafeInteger(scope.generation) || scope.generation < 0 || !['codex', 'claude', 'hermes', 'agy'].includes(scope.agent)
    || !(isAbsolute(scope.cwd) || platform === 'win32' && win32.isAbsolute(scope.cwd))
    || !Array.isArray(plan.argv) || !plan.argv.every(arg => typeof arg === 'string' && !arg.includes('\0'))) return fail('TEAM_PROJECT_PLAN_INVALID');
  // Manual plans must carry the actual brief. Managed cmux's separate-submit plan does not enter this helper.
  if (!plan.initialPrompt || normalizeCodeAppTask(plan.initialPrompt) !== plan.initialPrompt) return fail('TEAM_PROJECT_PROMPT_MISSING');
  if (requested.accountId !== undefined) return fail('TEAM_PROJECT_ACCOUNT_ENV_UNVERIFIED');
  if (requested.bypassPermissions !== undefined && typeof requested.bypassPermissions !== 'boolean') return fail('TEAM_PROJECT_OPTIONS_INVALID');
  const options = requested.launchOptions ?? {};
  if (!record(options) || extra(options, ['bgMode', 'tmuxMode', 'reuse', 'appMode'])) return fail('TEAM_PROJECT_OPTIONS_INVALID');
  const support = teamLaunchSupport(scope.surface, scope.agent);
  for (const key of ['bgMode', 'tmuxMode'] as const) {
    if (options[key] !== undefined && (typeof options[key] !== 'boolean' || !(key === 'bgMode' ? support.bg : support.tmux))) return fail('TEAM_PROJECT_OPTIONS_INVALID');
  }
  if (options.appMode !== undefined || options.bgMode === true && options.tmuxMode === true
    || options.reuse !== undefined && !['new', 'reuse-or-new'].includes(options.reuse)
    || options.reuse === 'reuse-or-new' && !teamLaunchReuseAvailable(scope.surface, scope.agent, options)) return fail('TEAM_PROJECT_OPTIONS_INVALID');
  // A private plan is not a shell-input API. Unknown argv, extra shell prefixes and environment assignments fail closed.
  const sessionId = scope.agent === 'claude' && plan.argv[0] === '--session-id' ? plan.argv[1] : '';
  if (scope.agent === 'claude' && (!sessionId || !/^[a-zA-Z0-9_-]{8,160}$/.test(sessionId))) return fail('TEAM_PROJECT_PLAN_INVALID');
  let expected: string[];
  try {expected = aiTerminalLaunchArgs(scope.agent, sessionId ?? '', plan.initialPrompt, requested.bypassPermissions === true,
    null, null, false, requested.effort, requested.model ? {model: requested.model, ...(requested.provider ? {provider: requested.provider} : {})} : null);}
  catch {return fail('TEAM_PROJECT_OPTIONS_INVALID');}
  if (requested.provider && !requested.model || requested.effort && scope.agent === 'agy'
    || JSON.stringify(expected) !== JSON.stringify(plan.argv) || plan.command !== baseCommand(plan)) return fail('TEAM_PROJECT_PLAN_INVALID');
  switch (scope.surface) {
    case 'iterm': case 'terminal':
      if (platform !== 'darwin') return fail('TEAM_PROJECT_PLATFORM_UNSUPPORTED');
      if (!deps.openTerminalWithCmd) return fail('TEAM_PROJECT_LAUNCH_UNAVAILABLE');
      break;
    case 'orca-floating': case 'orca-worktree':
      if (platform === 'win32') return fail('TEAM_PROJECT_PLATFORM_UNSUPPORTED');
      if (!deps.resolveOrcaCli || !deps.runOrca) return fail('TEAM_PROJECT_LAUNCH_UNAVAILABLE');
      break;
    case 'cmux':
      if (platform !== 'darwin') return fail('TEAM_PROJECT_PLATFORM_UNSUPPORTED');
      if (!deps.openCmuxTerminal) return fail('TEAM_PROJECT_LAUNCH_UNAVAILABLE');
      break;
    case 'powershell': case 'wsl':
      if (platform !== 'win32') return fail('TEAM_PROJECT_PLATFORM_UNSUPPORTED');
      if (!deps.openWindowsTerminal) return fail('TEAM_PROJECT_LAUNCH_UNAVAILABLE');
      break;
    default: return fail('TEAM_PROJECT_SURFACE_UNSUPPORTED');
  }
  return plan;
}

/** No kill, global tmux option or active-target shortcut. A found session needs this exact team's ownership marker. */
function tmuxCommand(plan: TeamExternalTerminalLaunchPlan, command: string): string {
  const name = teamProjectTmuxSessionName(plan.scope), target = quote(`=${name}`), owner = quote(scopeKey(plan.scope));
  const attach = `exec tmux attach-session -t ${target}`;
  const existing = plan.requested.launchOptions?.reuse === 'reuse-or-new'
    ? `if [ "$(tmux show-options -qv -t ${target} @agentstoz-team)" = ${owner} ]; then ${attach}; else exit 1; fi`
    : 'exit 1';
  return `if tmux has-session -t ${target} 2>/dev/null; then ${existing}; else `
    + `tmux new-session -d -s ${quote(name)} -n ${quote(plan.title)} -c ${quote(plan.scope.cwd)} ${quote(command)} && `
    + `tmux set-option -t ${target} @agentstoz-team ${owner} && ${attach}; fi`;
}

interface OrcaOwned {handle: string; worktreeId: string; runtimeId: string; incarnationId: string}
interface OrcaOwnershipRecord {scopeKey: string; state: 'pending' | 'unknown' | 'retired' | 'live'; native?: OrcaOwned}
function orcaBody(raw: unknown): {body: Record<string, unknown>; runtimeId: string | null} {
  if (!record(raw) || raw.ok !== true || !record(raw.result)) return fail('TEAM_PROJECT_ORCA_UNCERTAIN');
  return {body: raw.result, runtimeId: record(raw._meta) && clean(raw._meta.runtimeId) ? raw._meta.runtimeId : null};
}
export function createTeamProjectLauncher(deps: TeamProjectLauncherDeps) {
  const maximum = deps.maxOwnedHandles ?? 128;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) return fail('TEAM_PROJECT_CAPACITY_INVALID');
  // This host helper owns only bounded binding metadata, not terminal lifetime. Reserve before writes, retain unknowns,
  // and never evict old handles to admit another launch. The durable external journal remains the execution authority.
  // Explicit host disposal releases metadata and disables this helper; it never closes a person's manual terminal.
  const owned = new Map<number, OrcaOwnershipRecord>();
  let sequence = 0, disposed = false;
  const current = (scope: TeamExternalScope) => {
    if (disposed) fail('TEAM_PROJECT_LAUNCHER_DISPOSED');
    if (!deps.isCurrent(structuredClone(scope))) fail('TEAM_PROJECT_GENERATION_STALE');
  };
  const latest = (key: string): OrcaOwnershipRecord | undefined => {
    let result: OrcaOwnershipRecord | undefined;
    for (const value of owned.values()) if (value.scopeKey === key) result = value;
    return result;
  };
  const supportsManualLaunch = (plan: TeamExternalTerminalLaunchPlan): boolean => {
    try {
      const checked = validated(plan, deps); current(checked.scope);
      if (checked.scope.surface.startsWith('orca-')) {
        const prior = latest(scopeKey(checked.scope));
        if (prior?.state === 'pending' || prior?.state === 'unknown') return false;
        if (owned.size >= maximum && !(prior?.state === 'live' && checked.requested.launchOptions?.reuse === 'reuse-or-new')) return false;
      }
      return true;
    } catch {return false;}
  };
  async function openTerminal(raw: TeamExternalTerminalLaunchPlan): Promise<TeamExternalManualLaunchResult> {
    const plan = validated(raw, deps), {scope} = plan, options = plan.requested.launchOptions ?? {};
    current(scope);
    // --bg is an actual CLI argument before '--'/the prompt, not an applied-option label alone.
    const argv = options.bgMode === true ? ['--bg', ...plan.argv] : [...plan.argv];
    let command = baseCommand(plan, argv);
    if (options.tmuxMode === true) command = tmuxCommand(plan, command);
    if (scope.surface === 'iterm' || scope.surface === 'terminal') {
      const surface = scope.surface;
      const outcome = await privateOutcome(() => deps.openTerminalWithCmd!(command, null, plan.title, surface), 'TEAM_PROJECT_LAUNCH_UNCERTAIN');
      return {opened: outcome.verified === true, surface: scope.surface};
    }
    if (scope.surface === 'cmux') {
      const outcome = await privateOutcome(() => deps.openCmuxTerminal!({scope: structuredClone(scope), title: plan.title, command, executable: plan.executable, argv}), 'TEAM_PROJECT_LAUNCH_UNCERTAIN');
      if (outcome.surface !== scope.surface) return fail('TEAM_PROJECT_SURFACE_SUBSTITUTED');
      return outcome;
    }
    if (scope.surface === 'powershell' || scope.surface === 'wsl') {
      const surface = scope.surface;
      const outcome = await privateOutcome(() => deps.openWindowsTerminal!({surface, scope: structuredClone(scope), title: plan.title, executable: plan.executable, argv,
        ...(options.tmuxMode === true ? {tmux: {sessionName: teamProjectTmuxSessionName(scope), ownership: scopeKey(scope), reuse: options.reuse ?? 'new'}} : {})}), 'TEAM_PROJECT_LAUNCH_UNCERTAIN');
      if (outcome.surface !== scope.surface) return fail('TEAM_PROJECT_SURFACE_SUBSTITUTED');
      return outcome;
    }
    const cli = await deps.resolveOrcaCli!(); current(scope);
    if (!cli) return fail('TEAM_PROJECT_LAUNCH_UNAVAILABLE');
    const call = async (args: string[]) => {
      current(scope);
      // Raw runner errors can echo argv/the brief. Only a fixed outcome code may leave this private launcher.
      return orcaBody(await privateOutcome(() => deps.runOrca!(cli, [...args, '--json'], {cwd: '/', timeoutMs: 15_000, attempts: 1}), 'TEAM_PROJECT_ORCA_UNCERTAIN'));
    };
    const key = scopeKey(scope), previous = latest(key);
    if (previous?.state === 'pending' || previous?.state === 'unknown') return fail('TEAM_PROJECT_ORCA_UNCERTAIN');
    const prior = options.reuse === 'reuse-or-new' && previous?.state === 'live' ? previous.native : undefined;
    if (prior) {
      // No lookup of foreign titles, project markers or an active tab. Only handles created by this helper are eligible.
      const live = await call(['terminal', 'show', '--terminal', prior.handle]); current(scope);
      const terminal = live.body.terminal;
      if (record(terminal) && terminal.handle === prior.handle && terminal.worktreeId === prior.worktreeId
        && live.runtimeId === prior.runtimeId && terminal.incarnationId === prior.incarnationId && terminal.connected === true) {
        await call(['terminal', 'switch', '--terminal', prior.handle]);
        return {opened: true, surface: scope.surface};
      }
      previous!.state = 'retired';
    }
    if (owned.size >= maximum) return fail('TEAM_PROJECT_OWNED_CAPACITY');
    const reservation: OrcaOwnershipRecord = {scopeKey: key, state: 'pending'};
    owned.set(++sequence, reservation);
    const selector = scope.surface === 'orca-floating' ? 'id:global-floating-terminal' : `path:${scope.cwd}`;
    let created: ReturnType<typeof orcaBody>;
    try {created = await call(['terminal', 'create', '--worktree', selector, '--title', plan.title, '--command', command]);}
    catch (error) {reservation.state = 'unknown'; throw error;}
    reservation.state = 'unknown';
    const terminal = created.body.terminal;
    if (!record(terminal) || !clean(terminal.handle) || !clean(terminal.worktreeId)
      || scope.surface === 'orca-floating' && terminal.worktreeId !== 'global-floating-terminal'
      || scope.surface === 'orca-worktree' && (terminal.worktreeId === 'global-floating-terminal'
        || terminal.worktreePath !== undefined && terminal.worktreePath !== scope.cwd)) return fail('TEAM_PROJECT_ORCA_UNCERTAIN');
    if (created.runtimeId && clean(terminal.incarnationId)) {
      reservation.state = 'live';
      reservation.native = {handle: terminal.handle, worktreeId: terminal.worktreeId, runtimeId: created.runtimeId, incarnationId: terminal.incarnationId};
    }
    return {opened: true, surface: scope.surface};
  }
  return {supportsManualLaunch, openTerminal, dispose() {disposed = true; owned.clear();}};
}
