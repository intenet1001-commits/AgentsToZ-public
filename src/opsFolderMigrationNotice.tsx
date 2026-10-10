/**
 * The last OPS folder rename outcome (src/opsFolderMigration.ts) as the desktop status carries it, and
 * the one line 아젠투지 설정 shows for it. A rename that waits — an open OPS 워크룸 keeps the folder
 * in use — or stops for a person used to be a log line nobody saw.
 *
 * Browser-safe: no Node imports, so the panel can render it.
 */
export type OpsFolderMigrationRecord = {
  status: 'current' | 'skipped' | 'migrated' | 'needs-attention' | 'failed';
  /** The skip reason, or the needs-attention / failed code. */
  reason?: string;
  /** Processes whose working folder kept the rename waiting (folder-in-use). */
  blocking?: Array<{pid: number; command?: string}>;
  at: string;
};

/** Steady states: a profile without a Control folder, a folder the user named, a profile still preparing. */
const QUIET_REASONS = new Set(['no-binding', 'not-control-folder', 'custom-folder-name', 'binding-not-ready']);
const REASON_TEXT: Record<string, string> = {
  'root-missing': 'OPS 운영 폴더를 찾지 못했습니다',
  'root-not-directory': 'OPS 운영 폴더가 일반 폴더가 아닙니다',
  'target-exists': '같은 위치에 AgentsToZ-OPS 폴더가 이미 있습니다',
  'attach-pending': '중단된 프로필 연결이 남아 있습니다',
  'marker-mismatch': '폴더의 프로필 표식이 연결과 다릅니다',
  'memory-mismatch': '폴더의 기억 ID가 연결과 다릅니다',
  'registration-mismatch': '프로젝트 등록이 폴더 경로와 맞지 않습니다',
  'linked-worktrees': '연결된 워크트리가 있습니다',
  'git-unavailable': 'Git 상태를 확인하지 못했습니다',
  'process-check-unavailable': '폴더를 쓰는 프로세스를 확인하지 못했습니다',
  'workspace-busy': '다른 작업이 폴더를 쓰고 있습니다',
  'migration-busy': '다른 실행이 이름 변경을 진행하고 있습니다',
};
const SHOWN_PROCESSES = 5;

export function opsFolderMigrationNotice(record: OpsFolderMigrationRecord | null | undefined): string | null {
  if (!record) return null;
  switch (record.status) {
    case 'skipped': {
      const reason = record.reason ?? '';
      if (QUIET_REASONS.has(reason)) return null;
      if (reason === 'folder-in-use') {
        const blocking = record.blocking ?? [];
        const names = blocking.slice(0, SHOWN_PROCESSES).map(process => process.command ? `${process.command} (${process.pid})` : `PID ${process.pid}`);
        const more = blocking.length > SHOWN_PROCESSES ? ` 외 ${blocking.length - SHOWN_PROCESSES}개` : '';
        const list = names.length ? ` — ${names.join(', ')}${more}` : '';
        return `OPS 운영 폴더 이름 변경(AgentsToZ-OPS)을 기다리는 중입니다: 폴더를 쓰고 있는 프로세스가 있습니다${list}. 해당 워크룸·터미널을 닫으면 다음 실행 때 옮깁니다.`;
      }
      return `OPS 운영 폴더 이름 변경(AgentsToZ-OPS)을 다음 실행으로 미뤘습니다: ${REASON_TEXT[reason] ?? reason}.`;
    }
    case 'needs-attention':
      return `OPS 운영 폴더 이름 변경을 멈췄습니다(${record.reason ?? '확인 필요'}). 아무것도 지우거나 합치지 않았습니다 — 폴더 상태를 확인하세요.`;
    case 'failed':
      return `OPS 운영 폴더 이름 변경을 끝내지 못했습니다(${record.reason ?? '오류'}). 다음 실행에서 이어갑니다.`;
    default:
      return null;
  }
}

export function OpsFolderMigrationNotice({record}: {record: OpsFolderMigrationRecord | null | undefined}) {
  const notice = opsFolderMigrationNotice(record);
  return notice ? <p data-testid="ops-folder-migration-notice" className="mt-2 text-xs text-amber-600">{notice}</p> : null;
}
