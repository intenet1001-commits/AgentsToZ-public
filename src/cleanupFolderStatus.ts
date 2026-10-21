/**
 * 정리 검토의 행별 폴더·장기기억 표시.
 *
 * 지우기 전에 「무엇을 지우는지」가 보여야 한다. 행에는 폴더가 아직 있는지와 장기기억이 연동돼
 * 있는지를 함께 적고, 폴더가 사라졌거나 경로가 없으면 「없음」·「알 수 없음」으로 밝힌다. 확인되지
 * 않은 것을 「없음」으로 단정하지 않는 것이 이 모듈의 유일한 규칙이다.
 *
 * ⚠️ 기억 판정은 그 폴더의 `.agent-memory/config.json` 존재 **한 번의 stat**이다.
 * `detectProjectMemory`는 폴더마다 git을 여러 번 띄우므로(실측 107개면 수백 spawn) 이 목록에는
 * 쓰지 않는다. 그래서 링크된 워크트리처럼 기억이 **주 체크아웃**에 있는 경우는 「없음」이 아니라
 * 「알 수 없음」으로 떨어뜨릴 수 없고 「없음」으로 보인다 — 표시 전용 값이며 삭제 판단의 근거가
 * 아니다(`cleanupProject`는 여전히 자기 경로로 보관을 시도한다).
 */
export type CleanupFolderState = 'present' | 'missing' | 'unknown';
export type CleanupMemoryState = 'linked' | 'none' | 'unknown';

export interface CleanupFolderStatus {
  folderPath: string;
  folder: CleanupFolderState;
  memory: CleanupMemoryState;
}

export interface CleanupRowStatus {
  folder: CleanupFolderState;
  memory: CleanupMemoryState;
  /** 열 수 있는 경로. 폴더가 확인된 경우에만 값이 있다. */
  openPath: string | null;
  folderLabel: string;
  memoryLabel: string;
}

const FOLDER_LABELS: Record<CleanupFolderState, string> = {
  present: '폴더 있음',
  missing: '폴더 없음',
  unknown: '폴더 알 수 없음',
};
const MEMORY_LABELS: Record<CleanupMemoryState, string> = {
  linked: '장기기억 연동',
  none: '장기기억 없음',
  unknown: '장기기억 알 수 없음',
};

export function cleanupStatusIndex(rows: readonly CleanupFolderStatus[] | null | undefined): Map<string, CleanupFolderStatus> {
  const index = new Map<string, CleanupFolderStatus>();
  for (const row of rows ?? []) {
    if (typeof row?.folderPath !== 'string' || !row.folderPath) continue;
    if (!index.has(row.folderPath)) index.set(row.folderPath, row);
  }
  return index;
}

/** 한 행의 표시 상태. 조회 전(`null`)과 경로 없음은 모두 「알 수 없음」이지만 열 수는 없다. */
export function cleanupRowStatus(
  folderPath: string | undefined | null,
  index: Map<string, CleanupFolderStatus> | null,
): CleanupRowStatus {
  const path = typeof folderPath === 'string' && folderPath ? folderPath : null;
  const found = path && index ? index.get(path) : undefined;
  const folder: CleanupFolderState = path === null ? 'unknown' : found?.folder ?? 'unknown';
  const memory: CleanupMemoryState = path === null ? 'unknown' : found?.memory ?? 'unknown';
  return {
    folder,
    memory,
    openPath: folder === 'present' ? path : null,
    folderLabel: path === null ? '폴더 경로 없음' : FOLDER_LABELS[folder],
    memoryLabel: MEMORY_LABELS[memory],
  };
}
