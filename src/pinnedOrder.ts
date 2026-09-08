// 사이드바 「고정」 그룹의 수동 순서.
//
// 순서는 이 기기에만 남는다(localStorage). `favorite` 플래그는 Supabase로 동기화되지만
// 순서는 안 한다 — 고정 대상 자체가 기기별로 다르므로(포트는 device_id로 격리) 순서만
// 공유하면 다른 기기에서는 존재하지 않는 id 목록이 된다.
//
// 저장 형태는 프로젝트 id 배열 하나뿐이다. 항목마다 숫자를 들고 있으면 삽입할 때마다
// 나머지를 다시 매겨야 하고, 그 재계산이 빠진 자리에서 순서가 어긋난다.

export const PINNED_ORDER_STORAGE_KEY = 'portmanager-pinned-order';

/**
 * 저장된 순서대로 정렬한다.
 *
 * 순서 목록에 없는 항목(새로 고정한 것)은 **앞**에 온다. 방금 고정한 프로젝트가
 * 목록 맨 아래에 묻히면 고정한 이유가 사라진다.
 * 순서 목록에만 있고 실제로는 없는 id(고정 해제됨·삭제됨)는 조용히 무시한다.
 */
export function sortByPinnedOrder<T extends { id: string }>(items: T[], order: readonly string[]): T[] {
  const rank = new Map<string, number>();
  order.forEach((id, index) => { if (!rank.has(id)) rank.set(id, index); });
  const known: T[] = [];
  const fresh: T[] = [];
  for (const item of items) (rank.has(item.id) ? known : fresh).push(item);
  known.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...fresh, ...known];
}

/**
 * `draggedId`를 `targetId`가 있던 자리로 옮긴 새 순서를 만든다.
 *
 * 입력은 **화면에 보이는 현재 순서**(`visibleIds`)다. 저장된 순서에는 이미 고정 해제된
 * id가 남아 있을 수 있는데, 그걸 기준으로 자리를 계산하면 사용자가 놓은 위치와 결과가
 * 어긋난다. 화면 순서를 그대로 정본으로 삼고 저장한다.
 */
export function reorderPinned(visibleIds: readonly string[], draggedId: string, targetId: string): string[] {
  if (draggedId === targetId) return [...visibleIds];
  const from = visibleIds.indexOf(draggedId);
  const to = visibleIds.indexOf(targetId);
  if (from < 0 || to < 0) return [...visibleIds];
  const next = [...visibleIds];
  next.splice(from, 1);
  next.splice(to, 0, draggedId);
  return next;
}

/**
 * 포인터가 놓인 행의 id.
 *
 * ⚠️ 이 순서 변경은 HTML5 드래그(`draggable` + `dragover`/`drop`)로 만들 수 없다. Tauri 앱의
 * 웹뷰는 파일 드롭 핸들러가 켜져 있으면(`dragDropEnabled` 기본값 true) 드래그를 **전부** 가로챈다
 * — wry의 macOS 핸들러는 리스너가 true를 반환하면 WebKit 기본 동작을 호출하지 않고,
 * tauri-runtime-wry의 리스너는 **항상 true**를 반환한다. 그래서 앱에서는 `dragstart`만 뜨고
 * `dragover`/`drop`이 웹뷰에 도달하지 않아 순서가 바뀌지 않는다(웹에서는 잘 된다).
 * `dragDropEnabled:false`로 끄면 이번엔 FolderDropZone의 **절대경로 파일 드롭**이 죽는다
 * (WebKit File 객체에는 경로가 없다). 그래서 순서 변경은 포인터 이벤트로 구현하고, 네이티브
 * 드래그 세션 자체를 시작하지 않는다.
 *
 * 목록 위/아래로 벗어난 좌표는 첫/마지막 행으로 붙인다 — 끝으로 옮기려고 살짝 넘긴 드래그가
 * 무효가 되면 맨 위·맨 아래로 옮길 방법이 사라진다.
 */
export function pinnedDropTargetAt(
  rows: readonly { id: string; top: number; bottom: number }[],
  y: number,
): string | null {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return null;
  if (y < first.top) return first.id;
  if (y >= last.bottom) return last.id;
  // 경계값은 그 자리에서 시작하는 행의 것이다(top 포함, bottom 제외).
  const hit = rows.find(row => y >= row.top && y < row.bottom);
  return hit ? hit.id : last.id;
}

/** 클릭과 드래그를 가르는 이동 거리. 이보다 적게 움직이면 선택(클릭)으로 본다. */
export const PINNED_DRAG_THRESHOLD_PX = 4;

export function readPinnedOrder(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0 && !seen.has(id) && (seen.add(id), true));
  } catch {
    return [];
  }
}
