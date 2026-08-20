import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const linkSource = readFileSync(new URL('../code-app-links.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const launchSource = readFileSync(new URL('../src/projectCodexVoiceLaunch.ts', import.meta.url), 'utf8');

const chatGptCli = '/Applications/ChatGPT.app/Contents/Resources/codex';
const legacyCodexCli = '/Applications/Codex.app/Contents/Resources/codex';

describe('ChatGPT desktop Codex integration', () => {
  test('prefers the new ChatGPT-bundled Codex CLI and keeps the legacy fallback', () => {
    for (const source of [apiSource, rustSource]) {
      expect(source).toContain(chatGptCli);
      expect(source).toContain(legacyCodexCli);
      expect(source.indexOf(chatGptCli)).toBeLessThan(source.indexOf(legacyCodexCli));
    }
  });

  test('keeps the codex deep link registered by the ChatGPT desktop app', () => {
    expect(linkSource).toContain('codex://threads/new?path=');
    expect(rustSource).toContain('codex://threads/new?path={}');
  });

  test('opens an empty project task, invokes only its exact Voice control, and verifies the resulting rollout', () => {
    expect(appSource).toContain('openProjectCodexVoiceChat');
    expect(appSource).toContain('API.openProjectCodexVoice');
    expect(apiSource).toContain('/api/open-project-codex-voice');
    expect(apiSource).toContain('selectProjectCodexVoiceThread');
    expect(apiSource).toContain('codex://threads/${sessionId}');
    expect(apiSource).toContain("buildCodeAppDeepLink('codex', folderPath).url");
    expect(apiSource).toContain('waitForChatGptProjectReady(folderPath, existingProjectTaskIds)');
    expect(apiSource).toContain('isChatGptSelectedProject(folderPath)');
    expect(apiSource).toContain('await startChatGptVoice(CHATGPT_NEW_VOICE_START_LABELS, {');
    expect(apiSource).toContain('attempts: 12');
    expect(apiSource).not.toContain('useDesktopCommandShortcut: true');
    expect(apiSource).toContain('await startChatGptVoice(CHATGPT_RESUME_VOICE_START_LABELS)');
    expect(apiSource).toContain('waitForChatGptVoiceLaunch(existingVoiceStamps, startedAtMs)');
    expect(apiSource).toContain("code: 'VOICE_START_NOT_CONFIRMED'");
    expect(apiSource).toContain("? (projectState.projectBound ? 'started-project' : 'started-unbound')");
    expect(apiSource).toContain("'resumed-unbound'");
    expect(apiSource).toContain("voiceThreadCreated: voiceLaunch.kind === 'created'");
    expect(apiSource).toContain('chatGptVoiceAutomationInFlight');
    expect(apiSource).toContain("projectBound: voiceLaunch.kind === 'created' && projectState.projectBound");
    expect(apiSource).not.toContain('PROJECT_VOICE_SESSION_NOT_FOUND');
    expect(launchSource).toContain('CHATGPT_NEW_VOICE_START_LABELS');
    expect(launchSource).toContain('CHATGPT_RESUME_VOICE_START_LABELS');
    expect(launchSource).toContain('CHATGPT_GLOBAL_VOICE_START_LABELS');
    expect(launchSource).not.toContain('composer.startVoiceMode');
    expect(appSource).not.toContain('project-codex-voice-app');
    expect(appSource).toContain('started-unbound');
    expect(appSource).toContain('resumed-unbound');
    expect(appSource).not.toContain('PROJECT_VOICE_SESSION_NOT_FOUND');
    expect(appSource).not.toContain("mode === 'needs-project-task'");
    expect(linkSource).not.toContain('voice=true');
  });

  test('keeps global Voice start explicit and never labels it project-bound', () => {
    expect(apiSource).toContain('/api/start-global-codex-voice');
    expect(apiSource).toContain("surface: 'global'");
    expect(apiSource).toContain('CHATGPT_GLOBAL_VOICE_START_LABELS');
    expect(apiSource).toContain("mode: voiceLaunch.kind === 'created' ? 'started-global' : 'resumed-global'");
    expect(apiSource).toContain('projectBound: false');
    expect(appSource).toContain('API.startGlobalCodexVoice');
    expect(appSource).not.toContain('project-codex-voice-start-global');
    expect(apiSource).toContain('/api/open-chatgpt-voice');
    expect(appSource).toContain('project-codex-voice-open-chatgpt');
    expect(appSource).toContain('ChatGPT Voice 열기');
  });

  test('keeps a recorded-but-unapplied project move blocked before any fresh Voice start', () => {
    const endpointStart = apiSource.indexOf('if (url.pathname === "/api/open-project-codex-voice"');
    const endpointEnd = apiSource.indexOf('// ── Terminal/tmux helper', endpointStart);
    const endpoint = apiSource.slice(endpointStart, endpointEnd);

    expect(endpointStart).toBeGreaterThan(-1);
    expect(endpoint).toContain('if (found?.movePending)');
    expect(endpoint).toContain("code: 'PROJECT_VOICE_MOVE_PENDING'");
    expect(endpoint.indexOf('if (found?.movePending)'))
      .toBeLessThan(endpoint.indexOf('await startChatGptVoice(CHATGPT_NEW_VOICE_START_LABELS, {'));
    expect(appSource).toContain("result.mode === 'move-pending'");
  });
});
