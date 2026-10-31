/**
 * The 「아젠투지 호출」 voice dock (z 1000) and, in the installed app's main window, its floating notice stack (z 999)
 * float in the bottom-right corner above every page popover. A popover that opens down into that corner ends above
 * them instead of sliding underneath: click sweep 2026-11-01 (1440×900) found 「실행 도구」's 권한 우회 toggle and its
 * 빌드 menu under the dock, where no click could reach them. The full-screen caption view is a modal, not furniture.
 *
 * When an expanded dock (saved notices, 「열린 AI 세션」) leaves too little room above it, the popover keeps the window's
 * height and is marked `data-over-dock`; the dock then steps below it while it is open (AgentsToZVoiceDock.css).
 */
export const CORNER_FLOAT_SELECTOR = '.az-voice-dock:not(.az-voice-dock--fullscreen), .az-notices--floating';

/** Below this many layout px of room above the dock, a popover goes over the dock instead (about four rows). */
export const CORNER_FLOAT_MIN_POPOVER = 160;

/** Gap kept between a popover and the furniture, and between a popover and the window edge (client px). */
export const CORNER_FLOAT_GAP = 12;

export interface ClientBox { left: number; right: number; top: number; width: number; height: number }

/** Top edge (client px) of the corner furniture that shares columns with `span`, or null when none does. */
export function cornerFloatTop(span: { left: number; right: number }, boxes: Iterable<ClientBox>): number | null {
  let top: number | null = null;
  for (const box of boxes) {
    if (box.width < 1 || box.height < 1) continue;
    if (box.right <= span.left || box.left >= span.right) continue;
    top = top === null ? box.top : Math.min(top, box.top);
  }
  return top;
}

/**
 * Where a popover that opens downward from `panelTop` may end (client px), and whether it must go over the dock.
 * `scale` converts layout px to client px (the browser build scales #root by the 화면 배율, src/uiZoom.ts).
 */
export function popoverPlacement(input: {
  panelTop: number; span: { left: number; right: number }; windowHeight: number; scale: number; boxes: Iterable<ClientBox>;
}): { bottom: number; overDock: boolean } {
  const windowEdge = input.windowHeight - CORNER_FLOAT_GAP;
  const corner = cornerFloatTop(input.span, input.boxes);
  if (corner === null || corner - CORNER_FLOAT_GAP >= windowEdge) return { bottom: windowEdge, overDock: false };
  const aboveDock = corner - CORNER_FLOAT_GAP;
  if (aboveDock - input.panelTop >= CORNER_FLOAT_MIN_POPOVER * input.scale) return { bottom: aboveDock, overDock: false };
  return { bottom: windowEdge, overDock: true };
}

/** Client boxes of the corner furniture in `doc`. */
export function cornerFloatBoxes(doc: Pick<Document, 'querySelectorAll'> = document): ClientBox[] {
  return [...doc.querySelectorAll(CORNER_FLOAT_SELECTOR)].map(element => element.getBoundingClientRect());
}
