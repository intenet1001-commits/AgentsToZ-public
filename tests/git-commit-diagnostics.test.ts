import { describe, expect, test } from 'bun:test';
import { formatGitCommitDiagnostic, gitCommitFailureMessage } from '../git-commit-diagnostics';
import { formatOperationDiagnostic } from '../src/diagnosticLog';

describe('Git commit diagnostics', () => {
  test('explains dirty submodules and includes bounded copyable evidence', () => {
    const dirty = [{ path: 'marketplaces/studio-wp-marketplace', status: ' M theme.css\n?? draft.txt' }];
    const text = formatGitCommitDiagnostic({
      worktreePath: '/projects/site',
      exitCode: 1,
      commitOutput: 'no changes added to commit',
      parentStatus: ' M marketplaces/studio-wp-marketplace',
      dirtySubmodules: dirty,
      timestamp: '2026-08-01T00:00:00.000Z',
    });
    expect(gitCommitFailureMessage(dirty)).toContain('서브모듈 내부 변경');
    expect(text).toContain('오류 유형: dirty_submodule');
    expect(text).toContain('?? draft.txt');
  });

  test('wraps backend evidence in a reusable operation report', () => {
    const text = formatOperationDiagnostic({
      operation: 'git.commit',
      projectName: 'Studio',
      projectPath: '/projects/site',
      message: '커밋 실패',
      backendDiagnostic: '오류 유형: dirty_submodule',
      timestamp: '2026-08-01T00:00:00.000Z',
    });
    expect(text).toContain('프로젝트: Studio');
    expect(text).toContain('오류 유형: dirty_submodule');
  });
});
