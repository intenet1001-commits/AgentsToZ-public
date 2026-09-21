import { describe, expect, test } from 'bun:test';
import {
  parseChatGptThreadMetadata,
  parseChatGptThreadTitles,
  parseClaudeSessionMetadata,
} from '../src/contextSessionMetadata';

const sessionId = '019fe107-3f62-7781-8d28-0f9bcb119c7a';
const scratchPath = '/Users/gwanli/Documents/Codex/2026-08-08/realtime-voice-chat-6';
const shadowLoopPath = '/Users/gwanli/product_2026/ShadowLoop';

describe('context session title and project metadata', () => {
  test('prefers a real ChatGPT thread title over the initial generic voice title', () => {
    const titles = parseChatGptThreadTitles([
      JSON.stringify({ id: sessionId, thread_name: 'New voice chat' }),
      JSON.stringify({ id: sessionId, thread_name: 'ShadowLoop 실행 오류 점검' }),
      '{partial row',
    ].join('\n'));

    expect(titles.get(sessionId)).toBe('ShadowLoop 실행 오류 점검');
  });

  test('joins ChatGPT local-project assignment with pending workspace relocation', () => {
    const metadata = parseChatGptThreadMetadata({
      'thread-project-assignments': {
        [sessionId]: {
          projectKind: 'local',
          projectId: 'shadowloop-project',
          path: shadowLoopPath,
          cwd: shadowLoopPath,
          pendingCoreUpdate: true,
        },
      },
      'local-projects': {
        'shadowloop-project': { name: 'ShadowLoop', rootPaths: [shadowLoopPath] },
      },
      'electron-persisted-atom-state': {
        [`thread-workspace-state-v1:${sessionId}`]: {
          applied: { cwd: scratchPath },
          pending: { cwd: shadowLoopPath },
        },
      },
    }, new Map([[sessionId, 'ShadowLoop 실행 오류 점검']]));

    expect(metadata.get(sessionId)).toEqual({
      threadTitle: 'ShadowLoop 실행 오류 점검',
      projectHint: {
        name: 'ShadowLoop',
        assignedPath: shadowLoopPath,
        path: shadowLoopPath,
        source: 'chatgpt-local-project',
        moveState: 'pending',
        appliedPath: scratchPath,
        pendingPath: shadowLoopPath,
      },
    });
  });

  test('reads only Claude title/relocation events and ignores conversation rows', () => {
    const metadata = parseClaudeSessionMetadata([
      JSON.stringify({ type: 'user', message: { content: 'do not treat this as a title' } }),
      JSON.stringify({ type: 'ai-title', aiTitle: '배포 오류 추적' }),
      JSON.stringify({ type: 'relocated', relocatedCwd: shadowLoopPath }),
      JSON.stringify({ type: 'assistant', message: { content: 'also ignored' } }),
    ].join('\n'));

    expect(metadata).toEqual({
      threadTitle: '배포 오류 추적',
      projectHint: {
        name: null,
        path: shadowLoopPath,
        source: 'claude-relocated',
        moveState: 'relocated',
        appliedPath: null,
        pendingPath: shadowLoopPath,
      },
    });
  });
});
