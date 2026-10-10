import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChannelHealthList } from '../src/components/ChannelHealthDialog';
import { classifyChannelHealth, type ChannelHealthReport } from '../src/channelHealth';

const NOW = Date.parse('2026-09-25T10:00:00.000Z');
const report: ChannelHealthReport = {
  appMcpVersion: '1.20.0+build.514',
  channels: [
    classifyChannelHealth({ kind: 'mcp', agent: 'codex', now: NOW, currentBuild: 514, probe: null,
      connection: { agent: 'codex', state: 'configured', profiles: 1, message: '' } }),
    classifyChannelHealth({ kind: 'mcp', agent: 'agy', now: NOW, currentBuild: 514, probe: null,
      connection: { agent: 'agy', state: 'unavailable', profiles: 0, message: '' } }),
    classifyChannelHealth({ kind: 'telegram', profile: { name: 'default', gatewayRunning: false, telegramConfigured: true, telegramState: 'gateway-stopped' } }),
  ],
  mcpProcesses: { running: 2, stale: 1, message: '이전 버전 제어 도구 프로세스 1개가 아직 실행 중입니다(PID 101). 앱은 이 프로세스를 종료하지 않습니다.' },
};

describe('채널 연동 상태 panel', () => {
  const html = renderToStaticMarkup(<ChannelHealthList report={report} busyId={null} onProbe={() => {}} />);

  test('shows honest Korean states for each channel', () => {
    expect(html).toContain('설정됨 · 아직 확인 안 됨');
    expect(html).toContain('설치 안 됨');
    expect(html).toContain('설정됨 · 응답 없음');
    expect(html).not.toContain('연결됨 · 확인됨');
    expect(html).toContain('data-state="configured-unverified"');
  });

  test('offers a probe only where a configured entry exists', () => {
    expect(html).toContain('data-testid="channel-health-probe-mcp:codex"');
    expect(html).not.toContain('channel-health-probe-mcp:agy');
    expect(html).not.toContain('channel-health-probe-telegram:default');
    expect(html).toContain('지금 확인');
  });

  test('shows stale MCP processes as information only', () => {
    expect(html).toContain('data-testid="channel-health-stale-processes"');
    expect(html).toContain('종료하지 않습니다');
  });

  test('says when there are no Hermes profiles instead of an empty box', () => {
    const empty = renderToStaticMarkup(<ChannelHealthList report={{ ...report, channels: report.channels.filter(channel => channel.kind === 'mcp'), mcpProcesses: null }} busyId={null} onProbe={() => {}} />);
    expect(empty).toContain('이 컴퓨터에는 Hermes 프로필이 없습니다.');
    expect(empty).not.toContain('channel-health-stale-processes');
  });

  test('is reachable from 「도구 및 설정」 and uses no hex color literals', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const tools = app.slice(app.indexOf("<WorkspaceTools label={lang === 'ko' ? '도구 및 설정'"), app.indexOf('</WorkspaceTools>', app.indexOf("'도구 및 설정'")));
    expect(tools).toContain('data-testid="btn-channel-health"');
    expect(tools).toContain('setShowChannelHealth(true)');
    expect(app).toContain('<ChannelHealthDialog');
    const dialog = readFileSync(new URL('../src/components/ChannelHealthDialog.tsx', import.meta.url), 'utf8');
    expect(dialog).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(\d/);
  });
});
