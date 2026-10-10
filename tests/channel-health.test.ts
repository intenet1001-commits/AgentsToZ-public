import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHANNEL_HEALTH_LABEL,
  CHANNEL_PROBE_FRESH_MS,
  classifyChannelHealth,
  describeStaleMcpProcesses,
  findAgentsToZUseMcpProcesses,
  parsePsElapsed,
  type ChannelProbeResult,
} from '../src/channelHealth';
import { CHANNEL_PROBE_TOOL, probeAgentsToZUseMcp } from '../src/channelHealthProbe';
import { agentsToZUseMcpServerVersion } from '../src/agentstozUseMcpVersion';

const NOW = Date.parse('2026-09-25T10:00:00.000Z');
const configured = { agent: 'codex' as const, state: 'configured' as const, profiles: 1, message: 'ok' };
const probe = (overrides: Partial<ChannelProbeResult> = {}): ChannelProbeResult => ({
  ok: true, checkedAt: new Date(NOW - 60_000).toISOString(), serverVersion: agentsToZUseMcpServerVersion(514), projectCount: 3, error: null, ...overrides,
});
const mcp = (connection: any, probeResult: ChannelProbeResult | null = null) =>
  classifyChannelHealth({ kind: 'mcp', agent: 'codex', connection, probe: probeResult, now: NOW, currentBuild: 514 });

describe('MCP channel health', () => {
  test('uses the five beginner-facing labels', () => {
    expect(Object.values(CHANNEL_HEALTH_LABEL)).toEqual([
      '연결됨 · 확인됨', '설정됨 · 아직 확인 안 됨', '설정됨 · 응답 없음', '설치 안 됨', '확인할 수 없음',
    ]);
  });

  test('a registered entry alone is only configured, never verified', () => {
    expect(mcp(configured)).toMatchObject({ state: 'configured-unverified', label: '설정됨 · 아직 확인 안 됨', canProbe: true });
  });

  test('a fresh successful probe verifies; a failed one is unresponsive', () => {
    expect(mcp(configured, probe())).toMatchObject({ state: 'verified', label: '연결됨 · 확인됨' });
    expect(mcp(configured, probe({ ok: false, error: '응답 없음' }))).toMatchObject({ state: 'configured-unresponsive' });
  });

  test('an old probe no longer counts as evidence', () => {
    const old = probe({ checkedAt: new Date(NOW - CHANNEL_PROBE_FRESH_MS - 1).toISOString() });
    expect(mcp(configured, old).state).toBe('configured-unverified');
  });

  test('a response from another build is flagged as information', () => {
    const health = mcp(configured, probe({ serverVersion: agentsToZUseMcpServerVersion(500) }));
    expect(health.state).toBe('verified');
    expect(health.notes.join(' ')).toContain('v500');
  });

  test('missing CLI or entry is not installed; unreadable or conflicting config is unknown', () => {
    expect(mcp({ ...configured, state: 'unavailable' }).state).toBe('not-installed');
    expect(mcp({ ...configured, state: 'not-configured' }).state).toBe('not-installed');
    expect(mcp({ ...configured, state: 'needs-attention' })).toMatchObject({ state: 'unknown', canProbe: false });
    expect(mcp(null).state).toBe('unknown');
  });
});

describe('Telegram channel health', () => {
  const telegram = (profile: Partial<{ gatewayRunning: boolean; telegramConfigured: boolean; telegramState: string }>) =>
    classifyChannelHealth({ kind: 'telegram', profile: { name: 'default', gatewayRunning: false, telegramConfigured: false, telegramState: 'not-configured', ...profile } });

  test('connected needs a running gateway', () => {
    expect(telegram({ gatewayRunning: true, telegramConfigured: true, telegramState: 'connected' }).state).toBe('verified');
    expect(telegram({ gatewayRunning: false, telegramConfigured: true, telegramState: 'gateway-stopped' }).state).toBe('configured-unresponsive');
  });

  test('a token without a running gateway is configured but unverified', () => {
    expect(telegram({ telegramConfigured: true }).state).toBe('configured-unverified');
  });

  test('a running gateway that does not report Telegram is unresponsive', () => {
    expect(telegram({ gatewayRunning: true, telegramConfigured: true, telegramState: 'error' }).state).toBe('configured-unresponsive');
  });

  test('unresponsive details speak Korean instead of raw Hermes state words', () => {
    const lateToken = telegram({ gatewayRunning: true, telegramConfigured: true, telegramState: 'not-configured' });
    expect(lateToken.state).toBe('configured-unresponsive');
    expect(lateToken.detail).toContain('다시 시작');
    expect(lateToken.detail).not.toContain('not-configured');
    expect(telegram({ gatewayRunning: true, telegramConfigured: true, telegramState: 'disconnected' }).detail).toContain('연결 끊김');
    // No token in .env but a recorded platform state: do not claim a token exists.
    expect(telegram({ telegramConfigured: false, telegramState: 'disconnected' }).detail).not.toContain('봇 토큰은 설정돼');
  });

  test('no token is not installed; an unreadable state file is unknown', () => {
    expect(telegram({}).state).toBe('not-installed');
    expect(telegram({ telegramState: 'unknown' }).state).toBe('unknown');
  });
});

describe('running MCP processes (information only)', () => {
  const exe = '/Applications/AgentsToZ.app/Contents/MacOS/agentstoz-use-mcp';
  test('parses ps elapsed time', () => {
    expect(parsePsElapsed('05:07')).toBe(307);
    expect(parsePsElapsed('02:05:07')).toBe(7507);
    expect(parsePsElapsed('3-02:05:07')).toBe(3 * 86_400 + 7507);
    expect(parsePsElapsed('bogus')).toBeNull();
  });

  test('flags processes started before the executable was replaced, and other copies', () => {
    const ps = [
      `  101     2-00:00:00 ${exe}`,
      `  102          00:30 ${exe}`,
      `  103          10:00 /Volumes/AgentsToZ/AgentsToZ.app/Contents/MacOS/agentstoz-use-mcp`,
      `  104          10:00 /usr/bin/vim agentstoz-use-mcp-notes.txt`,
      `  105          10:00 bun /repo/agentstoz-use-mcp-server.ts`,
    ].join('\n');
    const processes = findAgentsToZUseMcpProcesses(ps, { executablePath: exe, executableMtimeMs: NOW - 3_600_000, nowMs: NOW, excludePids: [] });
    expect(processes.map(process => [process.pid, process.staleReason])).toEqual([
      [101, 'replaced-after-start'], [102, null], [103, 'other-executable'], [105, null],
    ]);
    const text = describeStaleMcpProcesses(processes)!;
    expect(text).toContain('2개');
    expect(text).toContain('종료하지 않습니다');
    expect(describeStaleMcpProcesses(processes.filter(process => process.staleReason === null))).toBeNull();
  });

  test('an executable path containing a space is still recognised', () => {
    const spaced = '/Applications/My Apps/AgentsToZ.app/Contents/MacOS/agentstoz-use-mcp';
    const ps = [`  201     2-00:00:00 ${spaced}`, `  202          00:30 ${spaced}`].join('\n');
    const processes = findAgentsToZUseMcpProcesses(ps, { executablePath: spaced, executableMtimeMs: NOW - 3_600_000, nowMs: NOW });
    expect(processes.map(process => [process.pid, process.staleReason])).toEqual([[201, 'replaced-after-start'], [202, null]]);
  });
});

describe('probe runs the registered MCP with read-only list_projects only', () => {
  const servers: Array<{ stop: (force?: boolean) => void }> = [];
  afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
  const mcpServer = join(import.meta.dir, '..', 'agentstoz-use-mcp-server.ts');

  test('a real MCP round trip verifies and reports the build version', async () => {
    const actions: unknown[] = [];
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => {
      actions.push(await req.json());
      return Response.json({ success: true, performed: true, action: 'list-projects', projects: [{ id: 'a' }, { id: 'b' }] });
    } });
    servers.push(server);
    const home = mkdtempSync(join(tmpdir(), 'channel-probe-'));
    const result = await probeAgentsToZUseMcp({
      command: [process.execPath, mcpServer], cwd: home, timeoutMs: 15_000,
      env: { PATH: process.env.PATH ?? '', HOME: home, APP_DATA_DIR: home, AGENTSTOZ_CONTROLLER_PORT_ID: 'ctrl-1',
        AGENTSTOZ_USE_ENDPOINT: `http://127.0.0.1:${server.port}/api/agentstoz-use/action` },
    });
    expect(result).toMatchObject({ ok: true, projectCount: 2, error: null });
    expect(result.serverVersion).toMatch(/\+build\.\d+$/);
    expect(CHANNEL_PROBE_TOOL).toBe('agentstoz_use_list_projects');
    expect(actions).toEqual([{ action: 'list-projects', controllerPortId: 'ctrl-1' }]);
  }, 20_000);

  test('an API refusal is reported as unresponsive with the reason', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () =>
      Response.json({ success: false, error: '프로필 연결을 다시 확인하세요.' }, { status: 403 }) });
    servers.push(server);
    const home = mkdtempSync(join(tmpdir(), 'channel-probe-'));
    const result = await probeAgentsToZUseMcp({
      command: [process.execPath, mcpServer], cwd: home, timeoutMs: 15_000,
      env: { PATH: process.env.PATH ?? '', HOME: home, APP_DATA_DIR: home, AGENTSTOZ_CONTROLLER_PORT_ID: 'ctrl-1',
        AGENTSTOZ_USE_ENDPOINT: `http://127.0.0.1:${server.port}/api/agentstoz-use/action` },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('프로필 연결을 다시 확인하세요');
  }, 20_000);

  test('a process that exits or hangs is not reported as connected', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'channel-probe-'));
    const exited = await probeAgentsToZUseMcp({ command: ['/usr/bin/false'], cwd, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5_000 });
    expect(exited.ok).toBe(false);
    const hung = await probeAgentsToZUseMcp({ command: ['/bin/sleep', '30'], cwd, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 300 });
    expect(hung).toMatchObject({ ok: false });
    expect(hung.error).toContain('응답이 없었습니다');
  }, 15_000);
});

describe('channel health report', () => {
  test('keeps each channel honest when a source fails', async () => {
    const { buildChannelHealthReport } = await import('../src/channelHealth');
    const report = await buildChannelHealthReport({
      listConnections: async () => { throw new Error('codex hung'); },
      hermesProfiles: () => [{ name: 'default', gatewayRunning: true, telegramConfigured: true, telegramState: 'connected' }],
      listProcesses: async () => null,
      executablePath: null, executableMtimeMs: null, probes: new Map(),
      currentBuild: 514, appMcpVersion: agentsToZUseMcpServerVersion(514), now: NOW,
    });
    expect(report.channels.map(channel => [channel.id, channel.state])).toEqual([
      ['mcp:codex', 'unknown'], ['mcp:claude', 'unknown'], ['mcp:hermes', 'unknown'], ['mcp:agy', 'unknown'],
      ['telegram:default', 'verified'],
    ]);
    expect(report.mcpProcesses).toBeNull();
  });
});
