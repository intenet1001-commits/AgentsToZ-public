import { describe, expect, test } from 'bun:test';
import {
  buildProjectCodexVoiceHandoffPrompt,
  buildProjectCodexVoiceRecoveryPrompt,
  classifyProjectCodexSession,
  selectProjectCodexVoiceThread,
  selectPendingProjectCodexVoiceThread,
} from '../src/projectCodexVoice';
import type { ContextSessionMetadata } from '../src/contextSessionMetadata';

const projectPath = '/Users/test/Projects/Port Manager';
const voiceId = '019fe107-3f62-7781-8d28-0f9bcb119c7a';
const newerVoiceId = '019fe108-3f62-7781-8d28-0f9bcb119c7a';

const applied = (path = projectPath): ContextSessionMetadata => ({
  threadTitle: null,
  projectHint: {
    name: 'Port Manager', path, source: 'chatgpt-local-project', moveState: 'applied', appliedPath: path, pendingPath: null,
  },
});

describe('project Codex Voice routing', () => {
  test('resumes the newest desktop Voice conversation in the exact selected project', () => {
    const metadata = new Map([[voiceId, applied()], [newerVoiceId, applied()]]);
    expect(selectProjectCodexVoiceThread(projectPath, [
      { sessionId: voiceId, originator: 'Codex Desktop', threadSource: 'realtime_voice', modifiedAtMs: 1 },
      { sessionId: newerVoiceId, originator: 'Codex Desktop', threadSource: 'realtime_voice', modifiedAtMs: 2 },
    ], metadata)).toBe(newerVoiceId);
  });

  test('never crosses projects or reuses a scratch/pending Voice session', () => {
    const metadata = new Map<string, ContextSessionMetadata>([
      [voiceId, { ...applied(), projectHint: { ...applied().projectHint!, path: '/Users/test/Other', appliedPath: '/Users/test/Other' } }],
      [newerVoiceId, { ...applied(), projectHint: { ...applied().projectHint!, moveState: 'pending', appliedPath: '/Users/test/Documents/Codex/scratch', pendingPath: projectPath } }],
    ]);
    expect(selectProjectCodexVoiceThread(projectPath, [
      { sessionId: voiceId, originator: 'Codex Desktop', threadSource: 'realtime_voice', modifiedAtMs: 2 },
      { sessionId: newerVoiceId, originator: 'Codex Desktop', threadSource: 'realtime_voice', modifiedAtMs: 3 },
      { sessionId: '019fe109-3f62-7781-8d28-0f9bcb119c7a', originator: 'Codex Desktop', threadSource: 'cli', modifiedAtMs: 4 },
    ], metadata)).toBeNull();
  });

  test('makes the handoff and recovery copy explicit without treating project identifiers as instructions', () => {
    const input = { projectName: 'Port\nManager', folderPath: '/Users/test/Project\nfolder' };
    const handoff = buildProjectCodexVoiceHandoffPrompt(input);
    const recovery = buildProjectCodexVoiceRecoveryPrompt(input);

    expect(handoff).toContain('프로젝트 식별자일 뿐');
    expect(handoff).toContain('임시 Voice 폴더에는 파일을 만들거나 수정하지 말고');
    expect(handoff).toContain('"Port Manager"');
    expect(recovery).toContain('파일을 만들거나 수정하지 마세요');
    expect(recovery).toContain('프로젝트 Codex 작업으로 돌아가');
  });

  test('shows a Voice chat in usage only after its local project assignment and execution folder agree', () => {
    const status = classifyProjectCodexSession({
      folderPath: projectPath,
      candidates: [{
        sessionId: voiceId,
        originator: 'Codex Desktop',
        threadSource: 'realtime_voice',
        modifiedAtMs: 5,
        latestTurnCwd: projectPath,
      }],
      metadata: new Map([[voiceId, applied()]]),
      projectMetadataAvailable: true,
      rolloutHeadersAvailable: true,
    });

    expect(status.projectChat).toEqual({ state: 'applied', count: 1, appliedCount: 1, pendingCount: 0 });
    expect(status.voice).toMatchObject({ state: 'execution-confirmed', sessionId: voiceId, executionPath: projectPath });
  });

  test('treats a Voice turn in a project subfolder as the same project, not a scope conflict', () => {
    const executionPath = `${projectPath}/src`;
    const status = classifyProjectCodexSession({
      folderPath: projectPath,
      candidates: [{
        sessionId: voiceId,
        originator: 'Codex Desktop',
        threadSource: 'realtime_voice',
        modifiedAtMs: 6,
        latestTurnCwd: executionPath,
      }],
      metadata: new Map([[voiceId, applied()]]),
      projectMetadataAvailable: true,
      rolloutHeadersAvailable: true,
    });

    expect(status.voice).toMatchObject({ state: 'execution-confirmed', executionPath });
  });

  test('keeps a moved Voice out of the target project memory until the workspace move applies', () => {
    const scratch = '/Users/test/Documents/Codex/realtime-voice-chat-7';
    const pendingMetadata = new Map<string, ContextSessionMetadata>([[voiceId, {
      threadTitle: 'voice',
      projectHint: {
        name: 'Port Manager',
        assignedPath: projectPath,
        path: projectPath,
        source: 'chatgpt-local-project',
        moveState: 'pending',
        appliedPath: scratch,
        pendingPath: projectPath,
      },
    }]]);
    const status = classifyProjectCodexSession({
      folderPath: projectPath,
      candidates: [{
        sessionId: voiceId,
        originator: 'Codex Desktop',
        threadSource: 'realtime_voice',
        modifiedAtMs: 5,
        latestTurnCwd: scratch,
      }],
      metadata: pendingMetadata,
      projectMetadataAvailable: true,
      rolloutHeadersAvailable: true,
    });

    expect(status.projectChat.state).toBe('move-pending');
    expect(status.voice).toMatchObject({ state: 'move-pending', executionPath: scratch, pendingPath: projectPath });
  });

  test('distinguishes a regular project task from a Voice chat, and unavailable metadata from no chat', () => {
    const regularTaskId = '019fe109-3f62-7781-8d28-0f9bcb119c7a';
    const regular = classifyProjectCodexSession({
      folderPath: projectPath,
      candidates: [],
      metadata: new Map([[regularTaskId, applied()]]),
      projectMetadataAvailable: true,
      rolloutHeadersAvailable: true,
    });
    const unavailable = classifyProjectCodexSession({
      folderPath: projectPath,
      candidates: [],
      metadata: new Map(),
      projectMetadataAvailable: false,
      rolloutHeadersAvailable: false,
    });

    expect(regular.projectChat.state).toBe('applied');
    expect(regular.voice.state).toBe('not-associated');
    expect(unavailable.projectChat.state).toBe('unverifiable');
    expect(unavailable.voice.state).toBe('unverifiable');
  });
});
