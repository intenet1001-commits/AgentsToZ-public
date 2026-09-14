import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const app = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf8');
const api = readFileSync(join(import.meta.dir, '..', 'api-server.ts'), 'utf8');

describe('project Codex Voice launch tells the truth about scope', () => {
  test('a missing project Voice session starts only the real project-composer Voice control', () => {
    expect(api).toContain('await startChatGptVoice(CHATGPT_NEW_VOICE_START_LABELS, {');
    expect(api).toContain("buildCodeAppDeepLink('codex', folderPath).url");
    expect(api).toContain('waitForChatGptProjectReady(folderPath, existingProjectTaskIds)');
    expect(api).toContain('waitForChatGptVoiceLaunch(existingVoiceStamps, startedAtMs)');
    expect(api).toContain('attempts: 12');
    expect(api).not.toContain('useDesktopCommandShortcut: true');
    expect(api).toContain("code: 'VOICE_START_NOT_CONFIRMED'");
    expect(api).not.toContain('PROJECT_VOICE_SESSION_NOT_FOUND');
    expect(app).toContain('started-unbound');
    expect(app).not.toContain('PROJECT_VOICE_SESSION_NOT_FOUND');
    expect(app).not.toContain("mode === 'needs-project-task'");
  });

  test('global Voice start is a separate explicit action and never inherits project scope', () => {
    expect(api).toContain('/api/start-global-codex-voice');
    expect(api).toContain('CHATGPT_GLOBAL_VOICE_START_LABELS');
    expect(api).toContain("surface: 'global'");
    expect(api).toContain("mode: voiceLaunch.kind === 'created' ? 'started-global' : 'resumed-global'");
    expect(api).toContain('projectBound: false');
    expect(app).toContain('startGlobalVoiceFromGuide');
    expect(app).toContain('전역 Voice 시작/재개');
    expect(api).toContain("code: globalControlUnavailable ? 'VOICE_GLOBAL_START_CONTROL_UNAVAILABLE' : automation.code");
    expect(api).toContain('/api/open-chatgpt-voice');
    expect(app).toContain('openChatGptVoiceFromGuide');
    expect(app).toContain('ChatGPT Voice 열기');
  });

  test('the app differentiates a created but unbound Voice thread from a project-bound one', () => {
    expect(api).toContain("? (projectState.projectBound ? 'started-project' : 'started-unbound')");
    expect(api).toContain("projectBound: voiceLaunch.kind === 'created' && projectState.projectBound");
    expect(api).toContain("voiceThreadCreated: voiceLaunch.kind === 'created'");
    expect(api).toContain('movePending: !!projectState.pending');
    expect(app).toContain('started-project');
    expect(app).toContain('started-unbound');
  });

  test('a global recent Voice resume is never mislabeled as the selected project Voice', () => {
    expect(api).toContain("mode: voiceLaunch.kind === 'created'");
    expect(api).toContain(": 'resumed-unbound'");
    expect(api).toContain("voiceThreadResumed: voiceLaunch.kind === 'resumed'");
    expect(app).toContain("result.mode === 'resumed-unbound'");
  });

  test('a pending project move remains a safety failure rather than being mistaken for a scoped chat', () => {
    const endpointStart = api.indexOf('if (url.pathname === "/api/open-project-codex-voice"');
    const endpointEnd = api.indexOf('// ── Terminal/tmux helper', endpointStart);
    const endpoint = api.slice(endpointStart, endpointEnd);

    expect(endpoint).toContain('if (found?.movePending)');
    expect(endpoint).toContain("code: 'PROJECT_VOICE_MOVE_PENDING'");
    expect(endpoint.indexOf('if (found?.movePending)'))
      .toBeLessThan(endpoint.indexOf('await startChatGptVoice(CHATGPT_NEW_VOICE_START_LABELS, {'));
    expect(app).toContain("result.mode === 'move-pending'");
  });

  // These three strings are the exact copy that sent the user through the same
  // failed procedure repeatedly: two promised the scope would follow, and the
  // third made a certainty sound conditional ("if it opens in a temp chat"),
  // which read as "so maybe it won't". Automating the Voice start does not make
  // any of them true again — a started thread is still unbound — so the guard
  // outlives the implementation that replaced the explanation.
  test('the copy that misled the user cannot come back', () => {
    expect(app).not.toContain('같은 프로젝트·폴더 범위가 유지됩니다');
    expect(app).not.toContain('먼저 “Start new voice chat”을 누른 뒤');
    expect(app).not.toContain('Voice가 별도 임시 대화로 열리면');
  });

  test('does not expose a Codex Voice start entry anywhere in the project UI', () => {
    expect(app).not.toContain('project-codex-voice-app');
    expect(app).not.toContain('worktree-codex-voice-app');
    expect(app).not.toContain('detail-codex-voice-app');
    expect(app).not.toContain('project-codex-voice-start-global');
    expect(app).not.toContain('Codex Voice 시작</button>');
  });

  test('gives every GitHub repository its own editable field and open action', () => {
    expect(app).toContain('data-testid="meta-add-github-url"');
    expect(app).toContain('GitHub 저장소 주소 ${index + 1}');
    expect(app).toContain('GitHub ${index + 1} 열기');
    expect(app).toContain('+ 주소 추가');
    expect(app).toContain('+ GitHub 주소 추가');
    expect(app).toContain('card-open-github');
    expect(app).toContain('data-testid="card-add-github"');
  });
});
