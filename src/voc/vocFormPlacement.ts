export interface VocFormRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface VocFormPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const EDGE_GAP = 12;
const TARGET_GAP = 10;
const FORM_WIDTH = 360;
const MIN_USEFUL_HEIGHT = 280;

/** Keep the VOC form inside the effective visual viewport, including at browser/webview zoom. */
export function placeVocForm(
  rect: VocFormRect,
  viewport: { width: number; height: number },
  bannerHeight: number,
): VocFormPlacement {
  const width = Math.max(0, Math.min(FORM_WIDTH, viewport.width - EDGE_GAP * 2));
  const belowTop = rect.top + rect.height + TARGET_GAP;
  const belowHeight = viewport.height - belowTop - EDGE_GAP;
  const aboveHeight = rect.top - bannerHeight - EDGE_GAP * 2;

  let top: number;
  if (belowHeight >= MIN_USEFUL_HEIGHT) {
    top = belowTop;
  } else if (aboveHeight >= MIN_USEFUL_HEIGHT) {
    top = Math.max(bannerHeight + EDGE_GAP, rect.top - MIN_USEFUL_HEIGHT - TARGET_GAP);
  } else {
    top = bannerHeight + EDGE_GAP;
  }

  const maxLeft = Math.max(EDGE_GAP, viewport.width - width - EDGE_GAP);
  const left = Math.min(Math.max(rect.left, EDGE_GAP), maxLeft);
  const maxHeight = Math.max(0, viewport.height - top - EDGE_GAP);
  return { top, left, width, maxHeight };
}
