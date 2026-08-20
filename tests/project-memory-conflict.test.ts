import { describe, expect, test } from 'bun:test';
import {
  projectMemoryConflictFromResult,
  projectMemoryConflictSummary,
} from '../src/projectMemoryConflict';

const payload = {
  conflict: true,
  remoteRevisionId: 'remote-revision',
  remoteCreatedAt: '2026-08-08T00:00:00.000Z',
  remoteContentHash: 'remote-hash',
  remoteContent: '# remote',
  localContentHash: 'local-hash',
  localContent: '# local',
};

describe('project-memory conflict payload', () => {
  test('keeps a preflight conflict distinct from a saved-local post-update race', () => {
    const preflight = projectMemoryConflictFromResult({
      ...payload,
      preflightConflict: true,
      localSaved: false,
    }, 'session');
    expect(preflight?.origin).toBe('session-preflight');
    expect(preflight?.localSaved).toBe(false);
    expect(projectMemoryConflictSummary(preflight!)).toContain('시작되지 않았습니다');

    const postUpdate = projectMemoryConflictFromResult({
      localSaved: true,
      remote: payload,
    }, 'session');
    expect(postUpdate?.origin).toBe('session-post-update');
    expect(postUpdate?.localSaved).toBe(true);
    expect(projectMemoryConflictSummary(postUpdate!)).toContain('로컬 세션 기억은 저장됐고');
  });

  test('retains both versions and revision guards for a safe resolver call', () => {
    const conflict = projectMemoryConflictFromResult(payload, 'push');
    expect(conflict).toMatchObject({
      origin: 'push',
      remoteRevisionId: 'remote-revision',
      remoteContentHash: 'remote-hash',
      localContentHash: 'local-hash',
      localContent: '# local',
      remoteContent: '# remote',
    });
  });
});
