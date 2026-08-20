import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/components/AiUsagePanel.tsx', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('../src/components/aiUsageMemoryState.ts', import.meta.url), 'utf8');

describe('AI usage session-memory action', () => {
  test('keeps a stable entry point for the usage-panel workflow', () => {
    const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(appSource).toContain('data-testid="btn-ai-usage"');
    expect(appSource).toContain('onClose={() => setShowAiUsage(false)}');
    expect(appSource).toContain('canOpenProject={canOpenContextProject}');
    expect(appSource).toContain('onOpenProject={openContextProject}');
  });

  test('keeps the context warning separate from whether project memory still needs saving', () => {
    expect(source).toContain('const REMEMBER_THRESHOLD = 75');
    expect(source).toContain('data-testid={`context-session-remember-${s.sessionId}`}');
    expect(source).toContain("'세션 기억하기 필요'");
    expect(source).toContain('onClick={() => { void rememberContextSession(s, projectDisplayName, memoryFolderPath); }}');
    expect(source).toContain('sessionMemoryAction(memoryFolderPath, memoryState)');
    expect(source).toContain("warn || memoryAction !== 'unavailable'");
    expect(source).toContain('세션 기억 완료');
    expect(stateSource).toContain('status.activity.needsRemember');
    expect(source).toContain('projectMemoryApi.remoteStatus');
    expect(source).toContain('Supabase Push 필요');
    expect(source).toContain('context-session-open-project-${s.sessionId}');
  });

  test('uses the session agent without replacing project preferences, avoids redundant AI calls, and reports the actual backup result', () => {
    expect(source).toContain('projectMemoryApi.detect');
    expect(source).toContain('projectMemoryApi.sessionEnd');
    expect(source).toContain('const agent = session.sourceAgent;');
    expect(source).toContain('preservePreferredAgent: true');
    expect(source).toContain('프로젝트 영역의 기본 에이전트');
    expect(source).toContain('status.config?.autoBackup');
    expect(source).toContain('이미 최신 장기기억입니다');
    expect(source).toContain('result.remoteBackedUp');
    expect(source).toContain('result.backupError');
    expect(source).toContain('await refreshMemoryStatus(folderPath)');
  });
});
