import {describe, expect, test} from 'bun:test';
import {chmodSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  AGENTSTOZ_USE_MCP_LAUNCHER_WAIT_STEPS,
  agentsToZUseMcpCommandNeedsUpgrade,
  agentsToZUseMcpLauncherPath,
  agentsToZUseMcpLauncherScript,
  isAgentsToZUseMcpCommand,
} from '../src/agentsToZUseMcpLauncher';

const BUNDLED = '/Applications/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-use-mcp';

describe('MCP 명령은 앱 교체를 견뎌야 한다 (2026-10-06)', () => {
  // 실측: Codex 세션이 13:33에 「해당 도구를 사용할 수 없다」고 했고, 그때 설치된 앱 바이너리의
  // mtime 이 13:34였다 — 앱을 통째로 지웠다 복사하는 창에 걸린 세션은 서버를 아예 못 띄운다.
  test('설정에는 홈 아래 고정 경로를 적는다', () => {
    expect(agentsToZUseMcpLauncherPath('/Users/x', 'darwin')).toBe('/Users/x/.agentstoz/bin/agentstoz-use-mcp');
    expect(agentsToZUseMcpLauncherPath('/Users/x', 'win32')).toBe('/Users/x/.agentstoz/bin/agentstoz-use-mcp.cmd');
  });

  test('우리가 적은 옛 모양은 조용히 올리고, 남의 연결은 건드리지 않는다', () => {
    const launcher = agentsToZUseMcpLauncherPath('/Users/x', 'darwin');
    expect(isAgentsToZUseMcpCommand(BUNDLED, launcher, BUNDLED)).toBe(true);
    expect(agentsToZUseMcpCommandNeedsUpgrade(BUNDLED, launcher, BUNDLED)).toBe(true);
    // 설치 위치가 달라도 우리 것이다(사용자가 앱을 다른 곳에 두었을 수 있다).
    expect(agentsToZUseMcpCommandNeedsUpgrade('/Users/x/Apps/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-use-mcp', launcher, BUNDLED)).toBe(true);
    // 이미 런처면 그대로 둔다.
    expect(agentsToZUseMcpCommandNeedsUpgrade(launcher, launcher, BUNDLED)).toBe(false);
    // 남의 명령은 우리 것이 아니다 — 충돌로 보고해야 한다.
    expect(isAgentsToZUseMcpCommand('npx', launcher, BUNDLED)).toBe(false);
    expect(isAgentsToZUseMcpCommand('/usr/local/bin/some-other-mcp', launcher, BUNDLED)).toBe(false);
    expect(isAgentsToZUseMcpCommand(undefined, launcher, BUNDLED)).toBe(false);
  });

  test('런처는 진짜 바이너리를 실행하고 인자와 종료 코드를 그대로 넘긴다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-launcher-'));
    const bundled = join(root, 'real-mcp');
    writeFileSync(bundled, '#!/bin/sh\necho "args:$*"\nexit 7\n');
    chmodSync(bundled, 0o755);
    const launcher = join(root, 'launcher');
    writeFileSync(launcher, agentsToZUseMcpLauncherScript({bundled}), {mode: 0o755});
    chmodSync(launcher, 0o755);
    const result = Bun.spawnSync([launcher, '--flag', 'value']);
    expect(result.stdout.toString().trim()).toBe('args:--flag value');
    expect(result.exitCode).toBe(7);
  });

  test('앱이 교체되는 동안에는 기다렸다가 실행한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-launcher-wait-'));
    const bundled = join(root, 'appears-later');
    const launcher = join(root, 'launcher');
    writeFileSync(launcher, agentsToZUseMcpLauncherScript({bundled}), {mode: 0o755});
    chmodSync(launcher, 0o755);
    const child = Bun.spawn([launcher], {stdout: 'pipe'});
    // 설치가 끝나 바이너리가 생기는 상황.
    await Bun.sleep(900);
    writeFileSync(bundled, '#!/bin/sh\necho ready\n');
    chmodSync(bundled, 0o755);
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(text.trim()).toBe('ready');
  }, 30_000);

  test('개발 소스로 떨어질 수 있지만, 영원히 매달리지는 않는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-launcher-dev-'));
    const dev = join(root, 'dev-mcp');
    writeFileSync(dev, '#!/bin/sh\necho dev\n');
    chmodSync(dev, 0o755);
    const script = agentsToZUseMcpLauncherScript({bundled: join(root, 'missing'), dev});
    expect(script).toContain(String(AGENTSTOZ_USE_MCP_LAUNCHER_WAIT_STEPS));
    expect(script).toContain('AGENTSTOZ_USE_MCP_PATH');
    expect(script).toContain('exec "$BIN" "$@"');
  });

  test('경로에 작은따옴표가 있어도 셸이 깨지지 않는다', () => {
    const script = agentsToZUseMcpLauncherScript({bundled: "/Users/x/It's Here/agentstoz-use-mcp"});
    expect(script).toContain(`'/Users/x/It'\\''s Here/agentstoz-use-mcp'`);
  });
});
