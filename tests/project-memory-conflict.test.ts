import { describe, expect, test } from 'bun:test';
import {
  projectMemoryConflictFromResult,
  projectMemoryConflictSuggestedMerge,
  projectMemoryConflictSummary,
  projectMemoryConflictIdentityIssues,
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

  test('retains remote context outside entries even when every entry matches', () => {
    const entry = '### Shared\n<!-- memory-entry-id:111111111111111111111111 -->\n- same\n';
    const conflict = projectMemoryConflictFromResult({...payload,
      localContent:'# Project Core Memory\n\n## Decisions\n'+entry,
      remoteContent:'# Project Core Memory\n\nOwner decision: retain the older backup.\n\n## Decisions\n'+entry},'push')!;
    expect(projectMemoryConflictSuggestedMerge(conflict)).toContain('> Owner decision: retain the older backup.');
  });

  test('code headings are not entries and ambiguous IDs preserve the entire remote original', () => {
    const local = '# Project Core Memory\n\n## Decisions\n### Local\n<!-- memory-entry-id:111111111111111111111111 -->\nlocal\n';
    const remote = '# Project Core Memory\n\n## Decisions\n### One\n<!-- memory-entry-id:222222222222222222222222 -->\nfirst\n### Two\n<!-- memory-entry-id:222222222222222222222222 -->\nsecond\n';
    const conflict = projectMemoryConflictFromResult({...payload,localContent:local,remoteContent:remote},'push')!;
    const draft = projectMemoryConflictSuggestedMerge(conflict);
    expect(draft).toContain('ID를 자동 재발급하지 않았습니다');
    expect(draft).toContain('> first'); expect(draft).toContain('> second');
    expect(projectMemoryConflictIdentityIssues(remote)).toEqual({duplicateIds:['222222222222222222222222'],malformedIds:0});
    expect(projectMemoryConflictIdentityIssues(local+'\n```md\n### Example\n<!-- memory-entry-id:pending -->\n```')).toEqual({duplicateIds:[],malformedIds:0});
    expect(projectMemoryConflictIdentityIssues(local+'\n### Broken\n<!-- memory-entry-id:pending -->\n')).toEqual({duplicateIds:[],malformedIds:1});
  });
});
