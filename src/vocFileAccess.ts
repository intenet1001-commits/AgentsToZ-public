/**
 * VOC 한 건을 **파일 이름으로** 다시 집는 규칙.
 *
 * 남긴 뒤에 고칠 수 있어야 한다는 요청(VOC 2026-09-01 15:39)에서 나왔다. 목록·수정·삭제가
 * 모두 파일 이름을 열쇠로 쓰는데, 그 이름은 브라우저에서 온 값이므로 **파일시스템에 닿는
 * 입력**이다. 경로 조각(`..`, `/`)이 섞이면 앱 데이터 폴더 밖의 파일을 지우게 된다.
 *
 * 그래서 이름 검사는 여기 한 곳에만 둔다 — 서버가 세 자리(GET·PATCH·DELETE)에서 같은
 * 판정을 써야 한다. 검사와 실제 경로 결합이 따로 놀면 한쪽만 고쳐진다.
 */

/** 파일 이름 길이 상한. 앵커 슬러그(40자) + 시간(15자) + 접미사로도 한참 남는다. */
const MAX_VOC_FILE_NAME = 200;

/**
 * 최상위 VOC 폴더의 **미처리** 한 건을 가리키는 이름인가.
 *
 * `done/`은 이미 처리된 기록이라 여기서 다루지 않는다 — 하위 경로를 허용하는 순간
 * 이름 검사가 곧 경로 검사가 되고, 그것이 이 함수가 막으려는 것이다.
 */
export function isPendingVocFileName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const name = value.trim();
  if (!name || name.length > MAX_VOC_FILE_NAME) return false;
  if (!name.endsWith('.json')) return false;
  // 경로가 될 수 있는 모든 조각을 거른다. 하나라도 통과하면 앱 데이터 폴더 밖이 열린다.
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  // 선행 점은 숨김 파일(`.DS_Store`)과 상위 이동(`..`)을 동시에 막는다.
  if (name.startsWith('.')) return false;
  return true;
}

/** 목록 화면이 한 줄로 보여줄 만큼만 추린 VOC 한 건. */
export interface VocInboxItem {
  file: string;
  id: string;
  createdAt: string;
  comment: string;
  tab: string;
  appVersion: string;
  /** 앵커 한 줄 요약. 읽을 수 없는 파일이면 빈 문자열이다. */
  anchorLabel: string;
  /** JSON 이 깨져 서버가 내용을 읽지 못한 파일. 지우는 것만 허용한다. */
  unreadable: boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * `GET /api/voc` 응답을 목록이 쓸 모양으로 정리한다.
 *
 * ⚠️ **읽을 수 없는 파일도 버리지 않는다.** 목록에서 사라지면 사용자는 그 파일이 없는 줄
 * 알지만 폴더에는 그대로 남아 다음 검토를 계속 방해한다. 대신 `unreadable` 로 표시해
 * 지울 수 있게 둔다.
 */
export function normalizeVocInbox(payload: unknown, describe: (anchor: unknown) => string): VocInboxItem[] {
  const items = (payload && typeof payload === 'object' ? (payload as { items?: unknown }).items : null);
  if (!Array.isArray(items)) return [];
  const normalized: VocInboxItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const file = text(row.file).trim();
    if (!isPendingVocFileName(file)) continue;
    const unreadable = row.unreadable === true;
    normalized.push({
      file,
      id: text(row.id),
      createdAt: text(row.createdAt),
      comment: text(row.comment),
      tab: text(row.tab),
      appVersion: text(row.appVersion),
      anchorLabel: unreadable ? '' : describe(row.anchor),
      unreadable,
    });
  }
  return normalized;
}
