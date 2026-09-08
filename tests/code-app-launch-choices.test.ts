import { describe, expect, test } from 'bun:test';
import {
  projectConversationLaunchCommand,
  recentProjectConversationNote,
  visibleProjectConversationChoices,
} from '../src/codeAppLaunchChoices';

describe('project code-app launch choices', () => {
  test('Codex fresh launch remains available while recent history is being checked or unavailable', () => {
    expect(visibleProjectConversationChoices('codex', 'checking')).toEqual(['new']);
    expect(visibleProjectConversationChoices('codex', 'none')).toEqual(['new']);
    expect(visibleProjectConversationChoices('codex', 'unavailable')).toEqual(['new']);
  });

  test('Codex recent launch appears only after an exact project match is confirmed', () => {
    expect(visibleProjectConversationChoices('codex', 'found')).toEqual(['new', 'recent']);
  });

  test('Hermes Desktop offers app-open independently and adds recent only after an exact match', () => {
    expect(visibleProjectConversationChoices('hermes', 'checking', true)).toEqual([]);
    expect(visibleProjectConversationChoices('hermes', 'none', true)).toEqual(['open-app']);
    expect(visibleProjectConversationChoices('hermes', 'unavailable', true)).toEqual(['open-app']);
    expect(visibleProjectConversationChoices('hermes', 'found', true)).toEqual(['open-app', 'recent']);

    for (const recentState of ['checking', 'none', 'unavailable', 'found'] as const) {
      expect(visibleProjectConversationChoices('hermes', recentState, false)).toEqual([]);
    }
  });

  test('launch commands keep desktop app and CLI/Orca semantics separate', () => {
    expect(projectConversationLaunchCommand('codex', 'new')).toEqual({
      agent: 'codex', mode: 'new', surface: 'desktop-app',
    });
    expect(projectConversationLaunchCommand('codex', 'recent')).toEqual({
      agent: 'codex', mode: 'reopen', surface: 'desktop-app',
    });
    expect(projectConversationLaunchCommand('hermes', 'recent')).toEqual({
      agent: 'hermes', mode: 'reopen', surface: 'desktop-app',
    });
    expect(projectConversationLaunchCommand('hermes', 'open-app')).toEqual({
      agent: 'hermes', mode: 'open', surface: 'desktop-app',
    });
    expect(projectConversationLaunchCommand('hermes', 'new')).toBeNull();
    expect(projectConversationLaunchCommand('codex', 'open-app')).toBeNull();
  });

  test('fallback copy names the separate Hermes CLI action instead of silently invoking it', () => {
    expect(recentProjectConversationNote('codex', 'unavailable')).toContain('새 Codex 앱 대화');
    expect(recentProjectConversationNote('hermes', 'none', true)).toContain('별도의 Hermes CLI 버튼');
    expect(recentProjectConversationNote('hermes', 'unavailable', true)).toContain('앱 자체는 열 수 있으며');
    expect(recentProjectConversationNote('hermes', 'none', false)).toContain('Hermes CLI 설치 상태와는 별개');
  });

  test('desktop project cards route through the chooser and fresh Codex mode', async () => {
    const source = await Bun.file(new URL('../src/App.tsx', import.meta.url)).text();
    expect(source).toContain("chooseProjectConversation('codex', item)");
    expect(source).toContain("chooseProjectConversation('codex', sel)");
    expect(source).toContain('projectConversationLaunchCommand(choice.agent, selectedChoice)');
    expect(source).toContain('openProjectCodeApp(command.agent, choice.item, choice.worktreePath, command.mode)');
    expect(source).toContain('data-testid="project-conversation-open-new"');
    expect(source).toContain('data-testid="project-conversation-open-app"');
    expect(source).toContain('data-testid="project-conversation-open-recent"');
  });

  test('the app chooser cannot call the Hermes CLI or Orca fallback', async () => {
    const source = await Bun.file(new URL('../src/App.tsx', import.meta.url)).text();
    const start = source.indexOf('const launchProjectConversationChoice = async');
    const end = source.indexOf('const openClaudeMain = async', start);
    const handler = source.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain('projectConversationLaunchCommand');
    expect(handler).not.toContain('openHermesMain');
    expect(source).not.toContain('새 Hermes 앱 작업 열기');
  });

  test('portal action inventory removes unverified recent buttons but keeps fresh actions', async () => {
    const source = await Bun.file(new URL('../api-server.ts', import.meta.url)).text();
    expect(source).toContain('filterUnavailableRemoteRecentConversationActions(registeredTargets)');
    expect(source).toContain("action !== 'app.codex' || availability?.codex === true");
    expect(source).toContain("action !== 'app.hermes' || availability?.hermes === true");
    expect(source).toContain("'codex.thread.start'");
  });
});
