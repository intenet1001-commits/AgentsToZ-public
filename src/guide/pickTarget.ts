import { INTERACTIVE_SELECTOR, isElementVisible } from './tipResolve';

/**
 * "커서 아래에서 사용자가 가리킨 것"을 고르는 규칙 한 곳.
 *
 * 안전 탐색(가이드) 모드와 VOC 코멘트 모드가 **같은 규칙**을 써야 한다. 두 모드가 서로 다른
 * 요소를 집으면, 가이드에서 설명을 본 그 버튼에 코멘트를 달 수 없게 된다.
 *
 * 비용은 DOM 크기가 아니라 **커서 아래 스택 깊이**에 비례한다 — `elementsFromPoint`가
 * 한 점 위에 쌓인 요소만 돌려주고, 위로 걷는 것도 `POINTER_LOOKUP_DEPTH`로 막혀 있다.
 * 프로젝트가 130개든 1300개든 이 함수의 비용은 같다.
 */

/** 위로 훑어볼 최대 깊이. */
const POINTER_LOOKUP_DEPTH = 6;

/**
 * 이 앱의 상당 부분이 button/role 없는 평범한 `<div>` 클릭 핸들러다(프로젝트 목록 행,
 * 포털 카드, 사이드바). 사용자에게는 눌리는 것으로 보이므로 `cursor: pointer`를
 * 마지막 신호로 쓴다.
 */
export function findPointerAncestor(start: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = start;
  for (let i = 0; cur && i < POINTER_LOOKUP_DEPTH && cur !== document.body; i++) {
    const cursor = window.getComputedStyle(cur).cursor;
    if ((cursor === 'pointer' || cursor === 'help') && isElementVisible(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/**
 * 화면 좌표 → 대상 요소.
 *
 * `data-help-key`가 붙은 조상이 있으면 **그것을 우선**한다. 사람이 이름을 붙여 둔
 * 요소이므로 앵커로서도 가장 오래 살아남는다.
 * 오버레이 자신(`data-guide-ui="1"`)은 항상 건너뛴다 — 안 그러면 오버레이가 자기를 집는다.
 */
export function findTargetAt(
  x: number,
  y: number,
  options: { allowAny?: boolean } = {},
): HTMLElement | null {
  const elements = document.elementsFromPoint(x, y);
  let fallback: HTMLElement | null = null;
  let anyElement: HTMLElement | null = null;
  for (const node of elements) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.dataset.guideUi === '1' || node.closest('[data-guide-ui="1"]')) continue;

    const tagged = node.closest<HTMLElement>('[data-help-key]');
    if (tagged && isElementVisible(tagged)) return tagged;
    if (!fallback) {
      const interactive = node.closest<HTMLElement>(INTERACTIVE_SELECTOR);
      if (interactive && isElementVisible(interactive)) fallback = interactive;
      else fallback = findPointerAncestor(node);
    }
    if (!anyElement && isElementVisible(node)) anyElement = node;
  }
  // 가이드 모드는 "설명할 수 있는 것"만 집으면 되지만, VOC는 **불만이 있는 모든 곳**을
  // 집을 수 있어야 한다. 제목·설명 문구·빈 영역처럼 클릭 대상이 아닌 곳이 오히려
  // 개선 요청이 많이 나오는 자리다.
  return fallback ?? (options.allowAny ? anyElement : null);
}

/**
 * 드래그로 그린 사각형과 겹치는, **이름이 붙은** 요소들.
 *
 * 영역 선택의 앵커는 좌표만으로는 쓸모가 없다 — 창 크기가 바뀌면 그 좌표에 다른 것이
 * 있다. 그래서 영역 안에 든 `data-help-key`/`data-testid`를 함께 적어 두고, 나중에
 * 그 이름들로 위치를 되찾는다.
 *
 * 이름 붙은 요소만 조회하므로(`querySelectorAll`) 전체 DOM 순회가 아니고, 상한도 둔다.
 */
export function namedElementsInRect(
  rect: { left: number; top: number; right: number; bottom: number },
  limit = 12,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const node of document.querySelectorAll<HTMLElement>('[data-help-key],[data-testid]')) {
    if (names.length >= limit) break;
    if (node.dataset.guideUi === '1' || node.closest('[data-guide-ui="1"]')) continue;
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const overlaps = box.left < rect.right && box.right > rect.left
      && box.top < rect.bottom && box.bottom > rect.top;
    if (!overlaps || !isElementVisible(node)) continue;
    const name = node.dataset.helpKey?.trim() || node.dataset.testid?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}
