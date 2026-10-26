import {describe, expect, test} from 'bun:test';
import {aiTerminalLaunchArgs} from '../src/aiTerminalLaunchArgs';
import {createTeamProjectLauncher, teamProjectTmuxSessionName, type TeamProjectLauncherDeps} from '../src/teamProjectLauncher';
import type {TeamExternalTerminalLaunchPlan} from '../src/teamExternalHost';
import type {TeamExternalRequested, TeamExternalScope} from '../src/teamExternalRuntime';

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
function plan(surface: TeamExternalScope['surface'] = 'iterm', agent: TeamExternalScope['agent'] = 'codex', requested: TeamExternalRequested = {}): TeamExternalTerminalLaunchPlan {
  const scope: TeamExternalScope = {executionId: 'execution-1', hostInstanceId: 'host-1', teamId: 'team-1', memberId: 'member-1', targetId: 'target-1',
    cwd: "/owned/team member's worktree", generation: 3, agent, surface};
  const executable = `/fixture/bin/${agent}`, initialPrompt = "검토만 해 주세요. 'quoted' $(do-not-run) `literal`\n두 번째 줄";
  const argv = aiTerminalLaunchArgs(agent, 'session-00000001', initialPrompt, requested.bypassPermissions === true, null, null, false,
    requested.effort, requested.model ? {model: requested.model, ...(requested.provider ? {provider: requested.provider} : {})} : null);
  return {scope, requested, title: "팀 작업 '검토'", executable, argv, initialPrompt,
    command: `cd -- ${quote(scope.cwd)} && exec ${[executable, ...argv].map(quote).join(' ')}`};
}
function fixture(overrides: Partial<TeamProjectLauncherDeps> = {}) {
  const terminals: unknown[][] = [], orca: {args: readonly string[]; options: unknown}[] = [], windows: unknown[] = [], cmux: unknown[] = [];
  let next = 0;
  const deps: TeamProjectLauncherDeps = {platform: 'darwin', isCurrent: () => true,
    async openTerminalWithCmd(...args) {terminals.push(args); return {verified: true};},
    resolveOrcaCli: () => '/fixture/orca',
    async runOrca(_executable, args, options) {
      orca.push({args, options});
      return {ok: true, _meta: {runtimeId: 'orca-runtime-1'}, result: {terminal: {handle: `terminal-${++next}`,
        worktreeId: args.includes('id:global-floating-terminal') ? 'global-floating-terminal' : 'worktree-1', incarnationId: `incarnation-${next}`, connected: true}}};
    },
    async openWindowsTerminal(input) {windows.push(input); return {opened: true, surface: input.surface};},
    async openCmuxTerminal(input) {cmux.push(input); return {opened: true, surface: 'cmux'};},
    ...overrides};
  return {launcher: createTeamProjectLauncher(deps), terminals, orca, windows, cmux};
}

describe('team project launcher exact terminal surface', () => {
  for (const surface of ['iterm', 'terminal'] as const) for (const agent of ['codex', 'claude', 'hermes', 'agy'] as const) {
    test(`${surface}/${agent}: delegates the member cwd and complete brief without shell interpolation`, async () => {
      const f = fixture(), p = plan(surface, agent, {launchOptions: {reuse: 'new'}});
      expect(f.launcher.supportsManualLaunch(p)).toBe(true);
      expect(await f.launcher.openTerminal(p)).toEqual({opened: true, surface});
      expect(f.terminals).toEqual([[p.command, null, p.title, surface]]);
      expect(f.terminals[0]![0]).toContain(quote(p.initialPrompt!));
      expect(f.orca.length + f.windows.length + f.cmux.length).toBe(0);
    });
  }
  test('Claude --bg is added before options and the positional brief, while false adds nothing', async () => {
    for (const bgMode of [true, false]) {
      const f = fixture(), p = plan('terminal', 'claude', {launchOptions: {bgMode, reuse: 'new'}});
      await f.launcher.openTerminal(p);
      const command = String(f.terminals[0]![0]);
      expect(command.includes("'--bg'")).toBe(bgMode);
      if (bgMode) expect(command).toContain("exec '/fixture/bin/claude' '--bg' '--session-id'");
      expect(command.split(quote(p.initialPrompt!))).toHaveLength(2);
      expect(command).not.toContain('tmux');
      expect(p.argv).not.toContain('--bg');
    }
  });
  test('host-compiled model/provider/effort and permission args are preserved without reading an account environment', async () => {
    const f = fixture(), p = plan('iterm', 'hermes', {model: 'model-1', provider: 'provider-1', effort: 'low', bypassPermissions: true});
    await f.launcher.openTerminal(p);
    expect(f.terminals[0]![0]).toBe(p.command);
    for (const argument of ['model-1', 'provider-1', '--reasoning', 'low', '--yolo']) expect(p.argv).toContain(argument);
    expect(p.argv.filter(arg => arg === 'chat')).toHaveLength(1);
    expect(p.argv.at(-1)).toBe(p.initialPrompt);
  });
  test('an unverified terminal open remains opened:false', async () => {
    const f = fixture({openTerminalWithCmd: async () => ({verified: false, warning: 'not confirmed'})});
    expect(await f.launcher.openTerminal(plan())).toEqual({opened: false, surface: 'iterm'});
  });
});

describe('team-only tmux identity and reuse', () => {
  test('identity includes team, member, execution, target, host, generation, agent and cwd', () => {
    const scope = plan().scope, name = teamProjectTmuxSessionName(scope);
    expect(name).toMatch(/^atz-team-[a-f0-9]{64}$/);
    expect(teamProjectTmuxSessionName(structuredClone(scope))).toBe(name);
    for (const key of ['hostInstanceId', 'teamId', 'memberId', 'executionId', 'targetId', 'cwd'] as const) {
      expect(teamProjectTmuxSessionName({...scope, [key]: `${scope[key]}-other`})).not.toBe(name);
    }
    expect(teamProjectTmuxSessionName({...scope, generation: scope.generation + 1})).not.toBe(name);
    expect(teamProjectTmuxSessionName({...scope, agent: 'claude'})).not.toBe(name);
  });
  for (const reuse of ['new', 'reuse-or-new'] as const) test(`${reuse} never kills or attaches an unowned tmux session`, async () => {
    const f = fixture(), p = plan('terminal', 'codex', {launchOptions: {tmuxMode: true, reuse}});
    await f.launcher.openTerminal(p);
    const command = String(f.terminals[0]![0]), name = teamProjectTmuxSessionName(p.scope);
    expect(command).toContain(`tmux has-session -t '=${name}'`);
    expect(command).toContain(`tmux new-session -d -s '${name}'`);
    expect(command).toContain(`tmux set-option -t '=${name}' @agentstoz-team`);
    expect(command).toContain(quote(p.command));
    expect(command).not.toMatch(/kill-session|send-keys|set-option -g|attach-session -d|new-session -A/);
    if (reuse === 'reuse-or-new') {
      expect(command).toContain(`tmux show-options -qv -t '=${name}' @agentstoz-team`);
      expect(command).toContain(`then exec tmux attach-session -t '=${name}'; else exit 1; fi`);
    } else expect(command).toContain('2>/dev/null; then exit 1; else tmux new-session');
  });
});

describe('atomic Orca launch and owned-handle reuse', () => {
  for (const surface of ['orca-floating', 'orca-worktree'] as const) test(`${surface} uses one exact terminal create with the complete command`, async () => {
    const f = fixture(), p = plan(surface);
    expect(await f.launcher.openTerminal(p)).toEqual({opened: true, surface});
    expect(f.orca).toEqual([{args: ['terminal', 'create', '--worktree', surface === 'orca-floating' ? 'id:global-floating-terminal' : `path:${p.scope.cwd}`,
      '--title', p.title, '--command', p.command, '--json'], options: {cwd: '/', timeoutMs: 15_000, attempts: 1}}]);
    expect(f.terminals).toHaveLength(0);
  });
  test('Claude floating bg is an actual --bg command, not an AI-launch or terminal-send API', async () => {
    const f = fixture(); await f.launcher.openTerminal(plan('orca-floating', 'claude', {launchOptions: {bgMode: true}}));
    const command = f.orca[0]!.args[f.orca[0]!.args.indexOf('--command') + 1]!;
    expect(command).toContain("exec '/fixture/bin/claude' '--bg' '--session-id'");
    expect(f.orca).toHaveLength(1);
    expect(f.orca[0]!.args.slice(0, 2)).toEqual(['terminal', 'create']);
  });
  test('uncertain/create selector errors never retry or fall back to floating/iTerm', async () => {
    const calls: readonly string[][] = [];
    const mutable = calls as string[][];
    const f = fixture({async runOrca(_cli, args) {mutable.push([...args]); return {ok: false, error: {code: 'selector_not_found'}};}});
    await expect(f.launcher.openTerminal(plan('orca-worktree'))).rejects.toThrow('TEAM_PROJECT_ORCA_UNCERTAIN');
    expect(calls).toHaveLength(1); expect(calls[0]).toContain(`path:${plan().scope.cwd}`);
    expect(f.terminals).toHaveLength(0);
  });
  test('reuse only reveals the same handle/runtime/incarnation created by this helper', async () => {
    const calls: string[][] = [];
    const terminal = {handle: 'owned-1', worktreeId: 'global-floating-terminal', incarnationId: 'incarnation-1', connected: true};
    const f = fixture({async runOrca(_cli, args) {calls.push([...args]); return {ok: true, _meta: {runtimeId: 'runtime-1'}, result: {terminal}};}});
    const p = plan('orca-floating', 'codex', {launchOptions: {reuse: 'reuse-or-new'}});
    await f.launcher.openTerminal(p); await f.launcher.openTerminal(p);
    expect(calls.map(args => args.slice(0, 2))).toEqual([['terminal', 'create'], ['terminal', 'show'], ['terminal', 'switch']]);
    expect(calls[1]).toEqual(['terminal', 'show', '--terminal', 'owned-1', '--json']);
    expect(calls[2]).toEqual(['terminal', 'switch', '--terminal', 'owned-1', '--json']);
    const other = structuredClone(p); other.scope.teamId = 'other-team';
    await f.launcher.openTerminal(other);
    expect(calls.at(-1)!.slice(0, 2)).toEqual(['terminal', 'create']);
    expect(calls.flat()).not.toContain('list');
  });
  test('a recycled handle/native generation is never switched to', async () => {
    const calls: string[][] = [];
    const f = fixture({async runOrca(_cli, args) {
      calls.push([...args]); return {ok: true, _meta: {runtimeId: 'runtime-1'}, result: {terminal: {handle: 'same-handle',
        worktreeId: 'global-floating-terminal', incarnationId: args[1] === 'show' ? 'foreign-incarnation' : 'ours', connected: true}}};
    }});
    const p = plan('orca-floating', 'codex', {launchOptions: {reuse: 'reuse-or-new'}});
    await f.launcher.openTerminal(p); await f.launcher.openTerminal(p);
    expect(calls.map(args => args[1])).toEqual(['create', 'show', 'create']);
  });
  test('new is always create even when this helper remembers a handle', async () => {
    const f = fixture(), p = plan('orca-floating', 'codex', {launchOptions: {reuse: 'new'}});
    await f.launcher.openTerminal(p); await f.launcher.openTerminal(p);
    expect(f.orca.map(call => call.args[1])).toEqual(['create', 'create']);
  });
  test('an unknown raw result is not treated as opened', async () => {
    const f = fixture({runOrca: async () => ({ok: true, result: {accepted: true}})});
    await expect(f.launcher.openTerminal(plan('orca-floating'))).rejects.toThrow('TEAM_PROJECT_ORCA_UNCERTAIN');
  });
  test('a worktree create response that substituted floating or a different checkout is rejected', async () => {
    for (const terminal of [{handle: 'h', worktreeId: 'global-floating-terminal'}, {handle: 'h', worktreeId: 'worktree-1', worktreePath: '/foreign'}]) {
      const f = fixture({runOrca: async () => ({ok: true, result: {terminal}})});
      await expect(f.launcher.openTerminal(plan('orca-worktree'))).rejects.toThrow('TEAM_PROJECT_ORCA_UNCERTAIN');
      expect(f.terminals).toHaveLength(0);
    }
  });
});

describe('readiness, typed platform delegation and refusal', () => {
  test('owned registry capacity rejects before create and retains the original reusable binding', async () => {
    const calls: string[][] = [], terminal = {handle: 'ours', worktreeId: 'global-floating-terminal', incarnationId: 'original', connected: true};
    const f = fixture({maxOwnedHandles: 1, async runOrca(_cli, args) {calls.push([...args]); return {ok: true, _meta: {runtimeId: 'runtime'}, result: {terminal}};}});
    const p = plan('orca-floating', 'codex', {launchOptions: {reuse: 'reuse-or-new'}});
    await f.launcher.openTerminal(p);
    const other = structuredClone(p); other.scope.memberId = 'other';
    expect(f.launcher.supportsManualLaunch(other)).toBe(false);
    await expect(f.launcher.openTerminal(other)).rejects.toThrow('TEAM_PROJECT_OWNED_CAPACITY');
    expect(calls).toHaveLength(1);
    expect(f.launcher.supportsManualLaunch(p)).toBe(true);
    await f.launcher.openTerminal(p);
    expect(calls.map(args => args[1])).toEqual(['create', 'show', 'switch']);
  });
  test('a pending create reserves capacity before another async launch can write', async () => {
    let release!: (value: unknown) => void, entered!: () => void;
    const started = new Promise<void>(resolve => {entered = resolve;}), pending = new Promise<unknown>(resolve => {release = resolve;});
    const calls: string[][] = [], f = fixture({maxOwnedHandles: 1, async runOrca(_cli, args) {calls.push([...args]); entered(); return pending;}});
    const p = plan('orca-floating'), first = f.launcher.openTerminal(p); await started;
    const other = structuredClone(p); other.scope.memberId = 'concurrent';
    await expect(f.launcher.openTerminal(other)).rejects.toThrow('TEAM_PROJECT_OWNED_CAPACITY');
    expect(calls).toHaveLength(1);
    release({ok: true, result: {terminal: {handle: 'ours', worktreeId: 'global-floating-terminal'}}});
    await first;
    expect(f.launcher.supportsManualLaunch(p)).toBe(false);
    await expect(f.launcher.openTerminal(p)).rejects.toThrow('TEAM_PROJECT_ORCA_UNCERTAIN');
    expect(calls).toHaveLength(1);
  });
  test('unknown launches retain capacity and are never automatically retried', async () => {
    let calls = 0;
    const f = fixture({maxOwnedHandles: 1, async runOrca() {calls++; throw Error('unknown transport outcome');}}), p = plan('orca-floating');
    await expect(f.launcher.openTerminal(p)).rejects.toThrow('TEAM_PROJECT_ORCA_UNCERTAIN');
    await expect(f.launcher.openTerminal(p)).rejects.toThrow('TEAM_PROJECT_ORCA_UNCERTAIN');
    const other = structuredClone(p); other.scope.memberId = 'other';
    await expect(f.launcher.openTerminal(other)).rejects.toThrow('TEAM_PROJECT_OWNED_CAPACITY');
    expect(calls).toBe(1);
  });
  test('runner diagnostics cannot leak the private argv or initial brief into a launcher error', async () => {
    const p = plan();
    const f = fixture({openTerminalWithCmd: async () => {throw Error(p.command);}});
    try {await f.launcher.openTerminal(p); throw Error('expected refusal');}
    catch (error) {expect((error as Error).message).toBe('TEAM_PROJECT_LAUNCH_UNCERTAIN'); expect((error as Error).message).not.toContain(p.initialPrompt!);}
    const g = fixture({runOrca: async () => {throw Error(p.command);}});
    await expect(g.launcher.openTerminal(plan('orca-floating'))).rejects.toThrow('TEAM_PROJECT_ORCA_UNCERTAIN');
    const synchronous = fixture({openTerminalWithCmd: () => {throw Error(p.command);}});
    await expect(synchronous.launcher.openTerminal(p)).rejects.toThrow('TEAM_PROJECT_LAUNCH_UNCERTAIN');
  });
  test('the hard budget is bounded and host disposal disables launch without closing manual terminals', async () => {
    for (const maxOwnedHandles of [0, -1, 257, Infinity, 1.5]) expect(() => fixture({maxOwnedHandles})).toThrow('TEAM_PROJECT_CAPACITY_INVALID');
    const f = fixture({maxOwnedHandles: 256}); f.launcher.dispose();
    expect(f.launcher.supportsManualLaunch(plan())).toBe(false);
    await expect(f.launcher.openTerminal(plan())).rejects.toThrow('TEAM_PROJECT_LAUNCHER_DISPOSED');
    expect(f.terminals.length + f.orca.length + f.cmux.length + f.windows.length).toBe(0);
  });
  test('stale scope and staleness during CLI resolution perform no external write', async () => {
    const f = fixture({isCurrent: () => false});
    expect(f.launcher.supportsManualLaunch(plan())).toBe(false);
    await expect(f.launcher.openTerminal(plan())).rejects.toThrow('TEAM_PROJECT_GENERATION_STALE');
    expect(f.terminals).toHaveLength(0);
    let current = true;
    const g = fixture({isCurrent: () => current, async resolveOrcaCli() {current = false; return '/orca';}});
    await expect(g.launcher.openTerminal(plan('orca-floating'))).rejects.toThrow('TEAM_PROJECT_GENERATION_STALE');
    expect(g.orca).toHaveLength(0);
  });
  test('missing runtime/launcher never falls back to an available surface', async () => {
    for (const [surface, overrides] of [['cmux', {openCmuxTerminal: undefined}], ['iterm', {openTerminalWithCmd: undefined}],
      ['orca-floating', {runOrca: undefined}]] as const) {
      const f = fixture(overrides), p = plan(surface);
      expect(f.launcher.supportsManualLaunch(p)).toBe(false);
      await expect(f.launcher.openTerminal(p)).rejects.toThrow('TEAM_PROJECT_LAUNCH_UNAVAILABLE');
      expect(f.terminals.length + f.orca.length + f.cmux.length + f.windows.length).toBe(0);
    }
  });
  test('PowerShell/WSL cannot execute on this Mac even when a Windows callback exists', async () => {
    for (const surface of ['powershell', 'wsl'] as const) {
      const f = fixture(), p = plan(surface);
      expect(f.launcher.supportsManualLaunch(p)).toBe(false);
      await expect(f.launcher.openTerminal(p)).rejects.toThrow('TEAM_PROJECT_PLATFORM_UNSUPPORTED');
      expect(f.windows.length + f.terminals.length).toBe(0);
    }
  });
  test('the Windows host receives typed original argv/cwd and an owned tmux spec, never a POSIX command', async () => {
    const f = fixture({platform: 'win32'}), p = plan('wsl', 'claude', {launchOptions: {tmuxMode: true, reuse: 'reuse-or-new'}});
    await f.launcher.openTerminal(p);
    expect(f.windows).toHaveLength(1);
    expect(f.windows[0]).toMatchObject({surface: 'wsl', scope: p.scope, executable: p.executable, argv: p.argv,
      tmux: {sessionName: teamProjectTmuxSessionName(p.scope), reuse: 'reuse-or-new'}});
    expect(f.windows[0]).not.toHaveProperty('command');
    expect(f.terminals).toHaveLength(0);
  });
  test('connected cmux delegates exactly and rejects a substituted result', async () => {
    const f = fixture(), p = plan('cmux', 'claude', {launchOptions: {bgMode: true}});
    expect(f.launcher.supportsManualLaunch(p)).toBe(true);
    expect(await f.launcher.openTerminal(p)).toEqual({opened: true, surface: 'cmux'});
    expect(f.cmux[0]).toMatchObject({scope: p.scope, argv: ['--bg', ...p.argv]});
    const g = fixture({openCmuxTerminal: async () => ({opened: true, surface: 'terminal'})});
    await expect(g.launcher.openTerminal(p)).rejects.toThrow('TEAM_PROJECT_SURFACE_SUBSTITUTED');
  });
  test('unknown or unsupported options, missing brief and extra shell input all fail before delegation', async () => {
    const mutations: Array<(p: any) => void> = [p => p.requested.launchOptions = {mystery: true}, p => p.requested.unknown = true,
      p => p.requested.launchOptions = {reuse: 'reuse-or-new'}, p => p.requested.launchOptions = {appMode: 'new'},
      p => p.requested.accountId = 'account-not-verified', p => p.requested.launchOptions = {bgMode: true},
      p => p.argv.push('--unknown-option'), p => p.command = 'env SECRET=not-allowed ' + p.command,
      p => delete p.initialPrompt, p => p.env = {SECRET: 'never-read'}, p => p.scope.generation = -1];
    for (const mutate of mutations) {
      const f = fixture(), p = plan(); mutate(p);
      expect(f.launcher.supportsManualLaunch(p)).toBe(false);
      await expect(f.launcher.openTerminal(p)).rejects.toThrow();
      expect(f.terminals.length + f.orca.length + f.cmux.length + f.windows.length).toBe(0);
    }
    const f = fixture(), p = plan('iterm', 'claude', {launchOptions: {bgMode: true, tmuxMode: true}});
    expect(f.launcher.supportsManualLaunch(p)).toBe(false);
    await expect(f.launcher.openTerminal(p)).rejects.toThrow('TEAM_PROJECT_OPTIONS_INVALID');
    await expect(f.launcher.openTerminal(plan('orca-worktree', 'codex', {launchOptions: {reuse: 'reuse-or-new'}}))).rejects.toThrow('TEAM_PROJECT_OPTIONS_INVALID');
  });
});
