import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTestApiServer } from './startTestApiServer';

test('channel health API reports honest states and the probe runs only list_projects', async () => {
  // realpath: the app resolves its MCP executable with realpathSync (/var → /private/var).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'channel-health-http-')));
  const bin = join(root, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const claude = join(bin, 'claude');
  writeFileSync(claude, '#!/bin/sh\nexit 0\n');
  chmodSync(claude, 0o755);
  // The "installed" MCP executable: the real server source, run by Bun.
  const mcp = join(root, 'agentstoz-use-mcp');
  writeFileSync(mcp, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, '..', 'agentstoz-use-mcp-server.ts')}"\n`);
  chmodSync(mcp, 0o755);
  writeFileSync(join(root, '.claude.json'), JSON.stringify({ mcpServers: { agentstoz_use: { command: mcp, args: [] } } }));
  // Hermes default profile: CRLF token, gateway recorded "connected" but its PID is dead.
  const hermes = join(root, '.hermes');
  mkdirSync(join(hermes, 'profiles', 'work'), { recursive: true });
  writeFileSync(join(hermes, 'config.yaml'), 'model: x\n');
  writeFileSync(join(hermes, '.env'), 'A=1\r\nTELEGRAM_BOT_TOKEN=123:abc\r\n');
  writeFileSync(join(hermes, 'gateway_state.json'), JSON.stringify({ pid: 2_147_483_000, platforms: { telegram: { state: 'connected' } } }));
  writeFileSync(join(hermes, 'profiles', 'work', '.env'), '# TELEGRAM_BOT_TOKEN=off\n');
  writeFileSync(join(hermes, 'profiles', 'work', 'SOUL.md'), 'soul\n');

  let child: Bun.Subprocess | undefined;
  try {
    const started = await startTestApiServer({ cwd: join(import.meta.dir, '..'), env: {
      ...process.env,
      HOME: root, USERPROFILE: root, APP_DATA_DIR: join(root, 'data'), APPDATA: join(root, 'roaming'), XDG_CONFIG_HOME: join(root, '.config'),
      AGENTSTOZ_USE_MCP_PATH: mcp, HERMES_HOME: hermes,
      AGENTSTOZ_SKIP_HERMES_SYNC: '1', AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1',
    } });
    child = started.child;
    const health = await (await fetch(`${started.baseUrl}/api/channels/health`)).json() as any;
    expect(health.success).toBe(true);
    const byId = (report: any, id: string) => report.channels.find((channel: any) => channel.id === id);
    expect(byId(health, 'mcp:claude')).toMatchObject({ state: 'configured-unverified', label: '설정됨 · 아직 확인 안 됨', canProbe: true });
    expect(byId(health, 'telegram:default')).toMatchObject({ state: 'configured-unresponsive', label: '설정됨 · 응답 없음' });
    expect(byId(health, 'telegram:work')).toMatchObject({ state: 'not-installed' });
    expect(health.appMcpVersion).toMatch(/\+build\.\d+$/);

    const bad = await fetch(`${started.baseUrl}/api/channels/health/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'bogus' }) });
    expect(bad.status).toBe(400);

    const probed = await fetch(`${started.baseUrl}/api/channels/health/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'claude' }) });
    expect(probed.status).toBe(200);
    const body = await probed.json() as any;
    // No profile and no controller pin: the real MCP starts and answers initialize,
    // but list_projects is refused — exactly what Claude itself would see.
    expect(body.probe.ok).toBe(false);
    expect(body.probe.error).toContain('운영 프로필');
    expect(body.probe.serverVersion).toBe(health.appMcpVersion);
    expect(byId(body, 'mcp:claude')).toMatchObject({ state: 'configured-unresponsive', label: '설정됨 · 응답 없음' });
    // The probe result is remembered for the next read-only GET.
    const again = await (await fetch(`${started.baseUrl}/api/channels/health`)).json() as any;
    expect(byId(again, 'mcp:claude').state).toBe('configured-unresponsive');
  } finally {
    child?.kill();
    await child?.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
