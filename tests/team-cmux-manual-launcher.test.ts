import {describe, expect, test} from 'bun:test';
import {createTeamCmuxManualLauncher, type TeamCmuxManualLaunch, type TeamCmuxManualLauncherDeps} from '../src/teamCmuxManualLauncher';
import {createTeamProjectLauncher} from '../src/teamProjectLauncher';
import {aiTerminalLaunchArgs} from '../src/aiTerminalLaunchArgs';

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
function plan(): TeamCmuxManualLaunch {
  return {scope: {executionId: 'execution-1', teamId: 'team-1', memberId: 'member-1', hostInstanceId: 'host-1', targetId: 'target-1',
    generation: 4, cwd: "/owned/member's tree", agent: 'claude', surface: 'cmux'}, title: '팀원 검토', executable: '/fixture/claude',
    argv: ['--', '실제 팀원 작업'], command: "cd -- '/owned/member'\"'\"'s tree' && exec '/fixture/claude' '--' '실제 팀원 작업'"};
}
function fixture(overrides: Partial<TeamCmuxManualLauncherDeps> = {}) {
  const calls: {cli: string; args: readonly string[]; options: unknown}[] = [];
  const deps: TeamCmuxManualLauncherDeps = {platform: 'darwin', resolveCmuxCli: () => '/fixture/cmux', isCurrent: () => true,
    run(cli, args, options) {calls.push({cli, args, options}); return {exitCode: 0, stdout: args[0] === 'ping' ? 'PONG\n' : 'OK workspace:new'};}, ...overrides};
  return {host: createTeamCmuxManualLauncher(deps), calls};
}

describe('cmux manual connection and exact launch', () => {
  test('connection needs both exit zero and the exact PONG reply', async () => {
    const f = fixture(); expect(await f.host.connected()).toBe(true);
    expect(f.calls).toEqual([{cli: '/fixture/cmux', args: ['ping'], options: {cwd: '/', timeoutMs: 2_000, attempts: 1}}]);
    for (const result of [{exitCode: 1, stdout: 'PONG'}, {exitCode: null, stdout: 'PONG'}, {exitCode: 0, stdout: ''},
      {exitCode: 0, stdout: 'OK'}, {exitCode: 0, stdout: 'PONG socket:/private/path'}, {exitCode: 0, stdout: 'pong'}]) {
      expect(await fixture({run: () => result}).host.connected()).toBe(false);
    }
  });
  test('missing CLI, unsupported platform and resolution/transport errors stay disconnected without opening an app', async () => {
    for (const overrides of [{resolveCmuxCli: () => null}, {resolveCmuxCli: () => 'cmux'}, {platform: 'win32' as const},
      {resolveCmuxCli: () => {throw Error('private details');}}]) {
      const f = fixture(overrides); expect(await f.host.connected()).toBe(false); expect(f.calls).toHaveLength(0);
    }
    expect(await fixture({run: () => {throw Error('private socket');}}).host.connected()).toBe(false);
  });
  test('one new-workspace argv carries the exact member cwd, command and title atomically', async () => {
    const f = fixture(), p = plan(), original = structuredClone(p);
    expect(await f.host.openCmuxTerminal(p)).toEqual({opened: true, surface: 'cmux'});
    expect(f.calls).toEqual([{cli: '/fixture/cmux', args: ['new-workspace', '--cwd', p.scope.cwd, '--command', p.command, '--name', p.title],
      options: {cwd: '/', timeoutMs: 8_000, attempts: 1}}]);
    expect(p).toEqual(original);
    expect(Object.keys(f.host).sort()).toEqual(['connected', 'openCmuxTerminal']);
  });
  test('the private project launcher supplies actual --bg argv and the full quoted brief to cmux', async () => {
    const f = fixture(), p = plan(), initialPrompt = "검토 'only' $(literal)\n두 번째 줄";
    const argv = aiTerminalLaunchArgs('claude', 'session-0001', initialPrompt);
    const terminal = createTeamProjectLauncher({platform: 'darwin', isCurrent: () => true, openCmuxTerminal: f.host.openCmuxTerminal});
    await terminal.openTerminal({...p, argv, initialPrompt, requested: {launchOptions: {bgMode: true}},
      command: `cd -- ${quote(p.scope.cwd)} && exec ${[p.executable, ...argv].map(quote).join(' ')}`});
    expect(f.calls).toHaveLength(1);
    const command = f.calls[0]!.args[4]!;
    expect(command).toContain("exec '/fixture/claude' '--bg' '--session-id'");
    expect(command).toContain(quote(initialPrompt));
    expect(f.calls[0]!.args[2]).toBe(p.scope.cwd);
  });
  test('stale generation before resolution prevents any external write', async () => {
    let resolves = 0;
    const f = fixture({isCurrent: () => false, resolveCmuxCli() {resolves++; return '/cmux';}});
    await expect(f.host.openCmuxTerminal(plan())).rejects.toThrow('TEAM_CMUX_GENERATION_STALE');
    expect(resolves).toBe(0); expect(f.calls).toHaveLength(0);
  });
  test('a generation changed while resolving the CLI cannot launch', async () => {
    let current = true;
    const f = fixture({isCurrent: () => current, resolveCmuxCli() {current = false; return '/cmux';}});
    await expect(f.host.openCmuxTerminal(plan())).rejects.toThrow('TEAM_CMUX_GENERATION_STALE');
    expect(f.calls).toHaveLength(0);
  });
  test('a late successful CLI return cannot attest a new generation', async () => {
    let current = true, calls = 0;
    const f = fixture({isCurrent: () => current, run() {calls++; current = false; return {exitCode: 0, stdout: 'accepted'};}});
    await expect(f.host.openCmuxTerminal(plan())).rejects.toThrow('TEAM_CMUX_GENERATION_STALE'); expect(calls).toBe(1);
  });
  test('nonzero, timeout/unknown and thrown outcomes never retry and never echo the brief or socket', async () => {
    for (const result of [{exitCode: 1, stdout: plan().command}, {exitCode: null, stdout: 'private socket'}, null]) {
      let calls = 0;
      const f = fixture({run() {calls++; if (!result) throw Error(plan().command); return result;}});
      try {await f.host.openCmuxTerminal(plan()); throw Error('expected refusal');}
      catch (error) {expect((error as Error).message).toBe('TEAM_CMUX_LAUNCH_UNCERTAIN');}
      expect(calls).toBe(1);
    }
  });
  test('a vanished connection does not trigger app launch, configuration or another terminal', async () => {
    const f = fixture({resolveCmuxCli: () => null});
    await expect(f.host.openCmuxTerminal(plan())).rejects.toThrow('TEAM_CMUX_CONNECTION_REQUIRED'); expect(f.calls).toHaveLength(0);
    await expect(fixture({platform: 'linux'}).host.openCmuxTerminal(plan())).rejects.toThrow('TEAM_CMUX_PLATFORM_UNSUPPORTED');
  });
  test('wrong surface, relative cwd, unknown caller fields and malformed command are rejected before CLI resolution', async () => {
    for (const mutate of [(p: any) => p.scope.surface = 'terminal', (p: any) => p.scope.cwd = 'relative',
      (p: any) => p.command = 'bad\0command', (p: any) => p.env = {TOKEN: 'forbidden'}, (p: any) => p.scope.generation = -1]) {
      const f = fixture(), p = plan(); mutate(p);
      await expect(f.host.openCmuxTerminal(p)).rejects.toThrow('TEAM_CMUX_PLAN_INVALID'); expect(f.calls).toHaveLength(0);
    }
  });
});
