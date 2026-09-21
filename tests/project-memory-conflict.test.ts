import { describe, expect, test } from 'bun:test';
import {
  projectMemoryConflictFromResult,
  projectMemoryConflictSuggestedMerge,
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

  test('creates a review-required draft that retains remote-only and diverging entries', () => {
    const conflict = projectMemoryConflictFromResult({
      ...payload,
      localContent: `# Project Core Memory\n\n## Key Decisions\n\n### Local decision\n<!-- memory-entry-id:111111111111111111111111 -->\n\n- local wording\n`,
      remoteContent: `# Project Core Memory\n\n## Key Decisions\n\n### Local decision\n<!-- memory-entry-id:111111111111111111111111 -->\n\n- remote wording\n\n### Remote-only decision\n<!-- memory-entry-id:222222222222222222222222 -->\n\n- preserve this\n`,
    }, 'push')!;
    const draft = projectMemoryConflictSuggestedMerge(conflict);
    expect(draft).toContain('- local wording');
    expect(draft).toContain('## Supabase-only entries to place after review');
    expect(draft).toContain('### Remote-only decision');
    expect(draft).toContain('### Review remote version: Local decision');
    expect(draft).toContain('> - remote wording');
  });
});
