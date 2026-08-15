export interface DirtySubmoduleDiagnostic {
  path: string;
  status: string;
}

export interface GitCommitDiagnosticInput {
  worktreePath: string;
  exitCode: number;
  commitOutput: string;
  parentStatus: string;
  dirtySubmodules: DirtySubmoduleDiagnostic[];
  timestamp?: string;
}

export function formatGitCommitDiagnostic(input: GitCommitDiagnosticInput): string {
  const lines = [
    '[AgentsToZ 진단 로그]',
    `시간: ${input.timestamp ?? new Date().toISOString()}`,
    '작업: git.commit',
    `작업 폴더: ${input.worktreePath}`,
    `종료 코드: ${input.exitCode}`,
    `오류 유형: ${input.dirtySubmodules.length > 0 ? 'dirty_submodule' : 'git_commit_failed'}`,
  ];

  if (input.dirtySubmodules.length > 0) {
    lines.push('', '변경된 서브모듈:');
    for (const submodule of input.dirtySubmodules) {
      lines.push(`- ${submodule.path}`);
      const statusLines = submodule.status.split(/\r?\n/).filter(Boolean).slice(0, 50);
      for (const statusLine of statusLines) lines.push(`    ${statusLine}`);
    }
  }

  lines.push('', '상위 저장소 상태:', input.parentStatus.trim() || '(변경 없음)');
  lines.push('', 'Git 출력:', input.commitOutput.trim() || '(출력 없음)');
  return lines.join('\n').slice(0, 32 * 1024);
}

export function gitCommitFailureMessage(dirtySubmodules: DirtySubmoduleDiagnostic[]): string {
  if (dirtySubmodules.length === 0) return 'Git 커밋에 실패했습니다. 상세 진단 로그를 확인하세요.';
  const paths = dirtySubmodules.map(item => item.path).join(', ');
  return `서브모듈 내부 변경은 상위 저장소에서 직접 커밋할 수 없습니다: ${paths}`;
}
