/**
 * 「기존 기억에 합류」 — 다른 기기가 쓰던 memoryId를 붙여넣어 같은 장기기억을 잇는다.
 *
 * 기기 간 신원은 보통 저장소(`canonicalProjectRepositoryKey`)에서 파생되지만, 그러려면
 * 두 기기가 같은 remote를 봐야 한다. 그렇지 않은 형태가 실제로 있다 — 예: Obsidian 볼트는
 * 내용이 Obsidian 동기화로 오가고 GitHub에는 구조만 올려두며, 어떤 기기에는 clone 자체가
 * 없다. remote가 없으면 파생할 키가 없어 기기마다 랜덤 UUID가 잡히고, 같은 프로젝트의
 * 노하우가 영영 두 갈래로 쌓인다. 그 경우 사용자가 직접 id를 건네는 것이 유일한 연결점이다.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProjectMemoryJoinIdError extends Error {
  code: 'MEMORY_ID_EMPTY' | 'MEMORY_ID_TRUNCATED' | 'MEMORY_ID_INVALID';
}

function joinError(code: ProjectMemoryJoinIdError['code'], message: string): ProjectMemoryJoinIdError {
  const error = new Error(message) as ProjectMemoryJoinIdError;
  error.code = code;
  return error;
}

/**
 * 붙여넣은 값을 정규화한다. 관대하게 받되(공백·대문자·따옴표·`memoryId:` 접두), 모양이
 * 다르면 **조용히 고치지 않고 던진다** — 잘못된 id로 초기화하면 아무도 쓰지 않는 새 계보가
 * 하나 더 생기고, 사용자는 합류했다고 믿는다.
 */
export function normalizeJoinMemoryId(raw: string | null | undefined): string {
  const trimmed = (raw ?? '')
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/^memory[_-]?id\s*[:=]\s*/i, '')
    .trim()
    .toLowerCase();
  if (!trimmed) throw joinError('MEMORY_ID_EMPTY', '합류할 장기기억 ID를 입력하세요.');
  if (UUID_PATTERN.test(trimmed)) return trimmed;
  // 패널 배지는 앞 8자리만 보여준다. 그걸 그대로 옮겨 적는 것이 가장 흔한 실수이고,
  // 8자리로는 어떤 기억인지 확정할 수 없으므로 전체 값을 요구한다.
  if (/^[0-9a-f]{8}$/.test(trimmed)) {
    throw joinError(
      'MEMORY_ID_TRUNCATED',
      '앞 8자리만 입력됐습니다. 패널의 ID 배지를 클릭하면 전체 값이 복사됩니다.',
    );
  }
  throw joinError('MEMORY_ID_INVALID', '장기기억 ID 형식이 아닙니다. 예: 884575df-63c4-407c-8b43-860d1295e663');
}

/** 입력 중 실시간 표시용 — 던지지 않는다. */
export function joinMemoryIdProblem(raw: string | null | undefined): string | null {
  if (!(raw ?? '').trim()) return null;
  try {
    normalizeJoinMemoryId(raw);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
