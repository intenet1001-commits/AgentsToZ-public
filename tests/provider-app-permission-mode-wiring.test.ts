import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

function section(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing start marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `missing end marker: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

// VOC 2026-09-11: 실행 옵션의 권한 우회는 범용 설정인데, 상세 패널의
// "Claude 앱에서 열기"는 이를 무시하고 항상 기본 권한으로 대화를 시작했다.
describe('provider app buttons honor the launch-options bypass toggle', () => {
  test('the desktop sends the current bypass toggle with every code-app open', () => {
    const client = section(app, 'async openCodeApp(', 'async codeAppLaunchOptions(');
    expect(client).toContain('bypass');
    expect(client).toContain('JSON.stringify({ agent, folderPath, mode, bypass })');
    const opener = section(app, 'const openProjectCodeApp = async (', 'const openBuzzProject = ');
    expect(opener).toContain('API.openCodeApp(agent, targetPath, mode, bypassPermissions)');
  });

  test('the server turns the toggle into a Claude permission mode and reports a mismatch as 409', () => {
    const handler = section(api, 'url.pathname === "/api/open-code-app"', 'if (agent === \'hermes\')');
    expect(handler).toContain("bypass === true ? 'bypassPermissions' : 'default'");
    expect(handler).toContain('CLAUDE_REMOTE_SESSION_PERMISSION_MODE_MISMATCH');
    const opener = section(api, 'async function openVerifiedClaudeProjectConversation(', 'process.once(\'exit\'');
    expect(opener).toContain('permissionMode');
  });

  test('Codex and Hermes app opens say plainly that the toggle cannot reach them', () => {
    const opener = section(app, 'const openProjectCodeApp = async (', 'const openBuzzProject = ');
    expect(opener).toContain('권한 우회는 적용되지 않습니다');
  });

  test('the provider app group shows when bypass is on', () => {
    const group = section(app, 'data-testid="detail-provider-apps"', '</summary>');
    expect(group).toContain('bypassPermissions');
    expect(group).toContain('data-testid="detail-provider-apps-bypass"');
  });
});
