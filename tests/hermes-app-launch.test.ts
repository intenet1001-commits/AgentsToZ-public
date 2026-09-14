import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

describe('Hermes desktop project launch', () => {
  test('is shown beside the Claude and Codex desktop app actions', () => {
    expect(appSource).toContain('data-testid="detail-hermes-app"');
    expect(appSource).toContain('data-testid="worktree-hermes-app"');
    expect(appSource).toContain("chooseProjectConversation('hermes', sel)");
    expect(appSource).toContain('Hermes 앱에서 열기');
  });

  test('opens Hermes Desktop directly and conditionally requests the exact recent project session', () => {
    expect(apiSource).toContain("agent !== 'hermes'");
    expect(apiSource).toContain("mode?: 'reopen' | 'new' | 'open'");
    expect(apiSource).toContain("if (mode === 'open' && agent !== 'hermes')");
    expect(apiSource).toContain("if (mode !== 'open')");
    expect(apiSource).toContain('readLatestHermesProjectSession(resolvedFolderPath)');
    expect(apiSource).toContain('...(recentSession ? [hermesSessionDeepLink(recentSession.id)] : [])');
    expect(apiSource).toContain("code: 'HERMES_PROJECT_SESSION_NOT_FOUND'");
    expect(apiSource).toContain("const target = recentSession ? 'latest-project-session' : 'project-app'");
    expect(apiSource).toContain("mode: recentSession ? 'reopened' : 'opened'");
    expect(rustSource).toContain('agent != "hermes"');
    expect(rustSource).toContain('local_api_post_json(');
    expect(rustSource).toContain('"/api/open-code-app"');
  });

  test('AgentsToZ USE opens Hermes Desktop without requiring a recent session', () => {
    const useStart = apiSource.indexOf('if (request.action === "open-code-app")');
    const useEnd = apiSource.indexOf('throw new AgentsToZUseControlError(', useStart);
    const useRoute = apiSource.slice(useStart, useEnd);
    expect(useRoute).toContain('...(request.agent === "hermes" ? { mode: "open" } : {})');
  });

  test('falls back to Terminal when iTerm is not installed', () => {
    expect(apiSource).toContain("const effectiveTerminalApp: 'iterm' | 'terminal' = terminalApp === 'iterm' && !existsSync('/Applications/iTerm.app')");
    expect(apiSource).toContain("? 'terminal'\n          : terminalApp === 'terminal' ? 'terminal' : 'iterm';");
  });

  test('routes Hermes CLI through the selected Orca surface', () => {
    expect(appSource).toContain("agent: 'claude' | 'codex' | 'agy' | 'hermes' | 'agents' | 'terminal'");
    expect(appSource).toContain("if (terminalApp === 'orca')");
    expect(appSource).toContain("const msg = await callOrca('hermes', item, context.worktreePath, isNew);");
    expect(apiSource).toContain("hermes: { agentName: 'hermes', label: 'Hermes' }");
    expect(rustSource).toContain('"hermes" => ("Hermes", "hermes")');
    expect(rustSource).toContain('"hermes" => agent_cmd("hermes", "")');
  });

  test('routes Hermes CLI through the selected cmux surface in browser and Tauri', () => {
    expect(appSource).toContain("'open_cmux_hermes'");
    expect(appSource).toContain("'/api/open-cmux-hermes'");
    expect(appSource).toContain("callCmux('open_cmux_hermes', '/api/open-cmux-hermes'");
    expect(apiSource).toContain('url.pathname === "/api/open-cmux-hermes"');
    expect(apiSource).toContain("agentCli('hermes', false)");
    expect(rustSource).toContain('fn open_cmux_hermes(');
    for (const agent of ['hermes', 'codex', 'agy']) {
      expect(rustSource).toContain(`let agent_bin = resolve_agent_bin("${agent}");`);
    }
    expect(rustSource).toContain('cmux_agent_command(&agent_bin, "")');
    expect(rustSource).toContain('CLI 실행 파일을 찾을 수 없습니다.');
    expect(rustSource).toContain('open_cmux_hermes,');
  });

  test('offers Hermes Desktop app-open plus an optional verified recent conversation', () => {
    expect(appSource).toContain('data-testid="project-hermes-app"');
    expect(appSource).toContain("chooseProjectConversation('hermes', item)");
    expect(appSource).toContain('data-testid="project-conversation-open-app"');
    expect(appSource).toContain('프로젝트 전용 Hermes Desktop 열기');
    expect(appSource).toContain('최근 {appLabel} 대화 열기');
    expect(appSource).toContain('이 기기에서 Hermes Desktop 실행 파일을 찾을 수 없습니다.');
    expect(appSource).toContain('Hermes Desktop 설치 상태를 확인하지 못해 실행을 막았습니다.');
    expect(appSource).not.toContain('새 Hermes 앱 작업 열기');
    const chooserStart = appSource.indexOf('const launchProjectConversationChoice = async');
    const chooserEnd = appSource.indexOf('const openClaudeMain = async', chooserStart);
    expect(appSource.slice(chooserStart, chooserEnd)).not.toContain('openHermesMain');
  });

  test('keeps Hermes Desktop availability independent from Hermes CLI availability', () => {
    const appOpenStart = appSource.indexOf('const openProjectCodeApp = async');
    const appOpenEnd = appSource.indexOf('const openBuzzProject =', appOpenStart);
    const cliOpenStart = appSource.indexOf('const openHermesMain = async');
    const cliOpenEnd = appSource.indexOf('const closeProjectConversationChoice =', cliOpenStart);
    expect(appOpenStart).toBeGreaterThan(-1);
    expect(appOpenEnd).toBeGreaterThan(appOpenStart);
    expect(cliOpenStart).toBeGreaterThan(-1);
    expect(cliOpenEnd).toBeGreaterThan(cliOpenStart);
    expect(appSource.slice(appOpenStart, appOpenEnd)).not.toContain('blockedByMissingHermesCli');
    expect(appSource.slice(cliOpenStart, cliOpenEnd)).toContain('blockedByMissingHermesCli()');
    expect(apiSource).toContain("const appAvailable = agent === 'hermes'");
    expect(apiSource).toContain('installedHermesDesktopExecutable() !== null');
  });

  test('does not claim the recent conversation was selected without a positive renderer acknowledgement', () => {
    expect(appSource).toContain('result.selectionVerified === true');
    expect(appSource).toContain('앱에서 대화 선택을 확인하세요');
    expect(apiSource).toContain('selectionVerified: false');
    expect(rustSource).toContain('selectionVerified');
  });

  test('verifies a project-scoped Hermes receiver against Hermes actual ready-file contract', () => {
    expect(apiSource).toContain('verifyHermesDesktopRunning');
    expect(apiSource).toContain('runningHermesDesktopForUserData');
    expect(apiSource).toContain("join(projectUserData, 'project-dir.json')");
    expect(apiSource).toContain("JSON.stringify({ dir: resolvedFolderPath }, null, 2)");
    expect(apiSource).toContain('HERMES_DESKTOP_READY_FILE: readyFile');
    expect(apiSource).toContain("target: 'latest-project-session'");
    expect(apiSource).toContain('hermesDashboardReadyPort(JSON.parse');
    expect(apiSource).toContain('/api/status');
    expect(apiSource).toContain('deliveryExitCode === 0');
    expect(apiSource).toContain('deliveryRequested: recentSession !== null');
    expect(apiSource).toContain('selectionVerified: false');
    expect(apiSource).not.toContain('receipt.schemaVersion === 1');
    expect(apiSource).toContain('Hermes Desktop 실행 또는 딥링크 전달 프로세스를 확인하지 못했습니다.');
  });
});
