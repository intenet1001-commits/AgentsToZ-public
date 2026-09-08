import { describe, expect, test } from 'bun:test';
import { buildCodeAppDeepLink } from '../code-app-links';

describe('buildCodeAppDeepLink', () => {
  test('opens a Codex local task with the exact absolute workspace path', () => {
    expect(buildCodeAppDeepLink('codex', '/Users/test/My Project')).toEqual({
      url: 'codex://threads/new?path=%2FUsers%2Ftest%2FMy%20Project',
      confirmationRequired: false,
    });
  });

  test('preserves a Windows workspace path through URL encoding', () => {
    expect(buildCodeAppDeepLink('codex', 'C:\\Projects\\Agent App')).toEqual({
      url: 'codex://threads/new?path=C%3A%5CProjects%5CAgent%20App',
      confirmationRequired: false,
    });
  });

  test('can prefill a fixed prompt without losing the exact project path', () => {
    expect(buildCodeAppDeepLink('codex', '/Users/test/My Project', {
      prompt: '준비됐습니다. & 확인',
    })).toEqual({
      url: 'codex://threads/new?path=%2FUsers%2Ftest%2FMy%20Project&prompt=%EC%A4%80%EB%B9%84%EB%90%90%EC%8A%B5%EB%8B%88%EB%8B%A4.%20%26%20%ED%99%95%EC%9D%B8',
      confirmationRequired: false,
    });
  });

  test('does not keep the discarded Claude folder deep-link contract in source', async () => {
    const source = await Bun.file(new URL('../code-app-links.ts', import.meta.url)).text();
    expect(source).not.toContain('claude://code/new?folder=');
    expect(source).toContain('remote-control');
  });

  test('routes desktop and mobile Claude project opens through one verified session manager', async () => {
    const [api, app, rust] = await Promise.all([
      Bun.file(new URL('../api-server.ts', import.meta.url)).text(),
      Bun.file(new URL('../src/App.tsx', import.meta.url)).text(),
      Bun.file(new URL('../src-tauri/src/lib.rs', import.meta.url)).text(),
    ]);
    expect(api.match(/openVerifiedClaudeProjectConversation\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(api).toContain('reusedActiveSession: opened.reusedActiveSession');
    // Only Codex may use the legacy string-returning Tauri bridge. Claude and
    // Hermes keep the sidecar's structured verification result intact.
    expect(app).toContain("if (isTauri() && mode === 'reopen' && agent === 'codex')");
    expect(app).toContain("await API.openCodeApp('codex', guide.folderPath, 'new')");
    expect(rust).toContain('&serde_json::json!({ "agent": agent, "folderPath": folder_path })');
    expect(rust).not.toContain('claude://code/new?folder=');
  });

  test('keeps new Codex creation separate from exact recent-thread reopening', async () => {
    const [api, rust] = await Promise.all([
      Bun.file(new URL('../api-server.ts', import.meta.url)).text(),
      Bun.file(new URL('../src-tauri/src/lib.rs', import.meta.url)).text(),
    ]);
    expect(api).toContain("if (mode === 'new')");
    expect(api).toContain('findLatestProjectCodexThread(resolvedFolderPath)');
    expect(api).toContain('openChatGptDeepLink(`codex://threads/${latest.sessionId}`)');
    expect(api).toContain("code: 'CODEX_PROJECT_SESSION_NOT_FOUND'");
    expect(rust).toContain('All three app routes go through the localhost sidecar');
    expect(rust).not.toContain('codex://threads/new?path=');
  });
});
