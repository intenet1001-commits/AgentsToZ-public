import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const panelSource = readFileSync(new URL('../src/components/AiUsagePanel.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

describe('AI usage session rows', () => {
  test('each session is one card, so the list segments per chat', () => {
    expect(panelSource).toContain('data-testid={`context-session-card-${s.sessionId}`}');
    expect(panelSource).toContain('borderRadius: 10,');
  });

  test('the card separates by surface, not by a coloured bar down its edge', () => {
    // The agent already speaks through its badge; repeating it as a stripe added
    // a decorative edge that carried no extra meaning.
    expect(panelSource).not.toContain('borderLeft: `3px solid');
    const card = panelSource.slice(panelSource.indexOf('data-testid={`context-session-card-'));
    expect(card.slice(0, 600)).toContain("background: 'rgba(255,255,255,0.032)'");
    expect(card.slice(0, 600)).toContain("border: '1px solid rgba(255,255,255,0.075)'");
  });

  test('the memory notice stays subordinate to the card that contains it', () => {
    // A bordered box inside the card competed with the card's own boundary and
    // read as the start of the next session.
    expect(panelSource).not.toContain('memoryBorder');
    const notice = panelSource.slice(panelSource.indexOf('background: memoryBackground'));
    expect(notice.slice(0, 200)).not.toContain('border:');
  });

  test('the row shows a separately labeled project and chat/window title', () => {
    const header = panelSource.slice(panelSource.indexOf("data-testid={`context-session-card-"));
    // Project, freshness and percent on one line; the chat/window title follows.
    expect(header.slice(0, 1400)).toContain("alignItems: 'baseline'");
    expect(header.slice(0, 1400)).toContain('fontSize: 12.5');
    expect(header.slice(0, 3600)).toContain('프로젝트: {projectDisplayName}');
    expect(header.slice(0, 3600)).toContain('대화/창: {conversationName}');
    expect(header.slice(0, 3600)).toContain('context-session-project-name-${s.sessionId}');
    expect(header.slice(0, 3600)).toContain('context-session-thread-title-${s.sessionId}');
  });

  test('surfaces voice-chat and project move state without treating a scratch cwd as the project', () => {
    expect(panelSource).toContain("s.threadSource === 'realtime_voice'");
    expect(panelSource).toContain('Codex 보이스 채팅');
    expect(panelSource).toContain('프로젝트 변경 적용 대기');
    expect(panelSource).toContain('프로젝트 이동 감지');
    expect(panelSource).toContain('resolveContextSessionProjectBinding(contextProjectCandidates, projectPath)');
  });

  test('keeps Codex Voice rows visible even when ChatGPT did not write token usage', () => {
    expect(apiSource).toContain('const chatGptVoiceSnapshot = readChatGptVoiceCandidateSnapshot();');
    expect(apiSource).toContain('if (!hasUsageReading && !isDesktopVoice) continue;');
    expect(apiSource).toContain('A project-bound Voice conversation can be older than the recent 96');
    expect(apiSource).toContain('addedProjectVoiceRows');
    expect(panelSource).toContain('Voice는 토큰 수치 없이도 표시');
    expect(panelSource).toContain('컨텍스트 수치 없음');
    expect(panelSource).toContain('voiceBindingBadge(s.voiceBindingState)');
  });

  test('does not attach pending or conflicting Voice execution to the target project memory', () => {
    expect(panelSource).toContain("session.voiceBindingState === 'move-pending'");
    expect(panelSource).toContain("session.voiceBindingState === 'scope-conflict'");
    expect(panelSource).toContain('대상 프로젝트 장기기억에 연결하지 않음');
    expect(panelSource).toContain('const voiceProjectMemoryIsBlocked');
    expect(panelSource).toContain("session.voiceBindingState !== 'execution-confirmed'");
    expect(panelSource).toContain("session.voiceBindingState !== 'assigned-awaiting-execution'");
    expect(panelSource).toContain('장기기억 연결 대기');
    expect(panelSource).toContain("? 'unavailable'");
    expect(apiSource).toContain("chatGptThreadMetadataSnapshot.availability !== 'fresh'");
  });

  test('retains project-bound Voice history for the memory handoff after ordinary usage rows expire', () => {
    expect(panelSource).toContain('const projectVoiceHistory = (ctx.sessions ?? [])');
    expect(panelSource).toContain('const displayedSessions = [...visibleSessions, ...projectVoiceHistory];');
    expect(panelSource).toContain('프로젝트에 연결된 이전 Codex Voice 기록도 장기기억 연결을 위해 함께 표시합니다.');
    expect(panelSource).toContain('const retainedProjectVoice = session.state === \'stale\'');
  });
});
