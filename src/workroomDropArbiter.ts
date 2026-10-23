/**
 * One owner for every Tauri file drop (S3, 2026-10-16).
 *
 * Tauri hands a drop to every `onDragDropEvent` listener at once — there is no stopPropagation — so the VOC form,
 * every FolderDropZone and the Workroom all hear the same Finder drop. Before this, a file dropped on the Workroom
 * could also register a project. The rule is decided here, purely, and every listener asks the same question:
 *
 *   VOC capture on                         → VOC (its overlay covers the app; src/voc/vocDropCapture.ts)
 *   the topmost element is inside a live Workroom drop zone → that Workroom (terminal or composer area)
 *   a modal dialog drawn from inside the Workroom (hit on it or its backdrop) → FolderDropZone's own inside test
 *   anything else (a modal above the Workroom, the rest of the app) → FolderDropZone's own inside test
 *
 * "Topmost element" is document.elementFromPoint at the drop point in CSS pixels, so a dialog drawn over the
 * Workroom wins over the Workroom under it.
 */

/** macOS WKWebView reports drag positions in view points; WebView2 and WebKitGTK report physical pixels. */
export type DropPositionUnit = 'logical' | 'physical';

export interface DropGeometry {
  unit: DropPositionUnit;
  /** Window scale factor (backing pixels per point). */
  scaleFactor: number;
  /** The webview's width in logical points, measured from the window (0 when unknown). */
  logicalWidth: number;
  /** window.innerWidth — the same width in CSS pixels after the app's zoom. */
  cssWidth: number;
}

export function dropPositionUnit(platform: string): DropPositionUnit {
  return /mac/i.test(platform) ? 'logical' : 'physical';
}

/**
 * A drop position as CSS pixels. The app zooms the webview (App.tsx `setZoom(uiZoom)`), so one CSS pixel is
 * `zoom` points: the ratio is measured as innerWidth over the window's logical width instead of assumed, which
 * also holds when the zoom fell back to CSS (the ratio is then 1). Without a measurement, physical positions
 * still lose the scale factor and logical ones are taken as they are.
 */
export function dropPointToCss(position: {x: number; y: number}, geometry: DropGeometry): {x: number; y: number} {
  const scale = geometry.scaleFactor > 0 ? geometry.scaleFactor : 1;
  const lx = geometry.unit === 'physical' ? position.x / scale : position.x;
  const ly = geometry.unit === 'physical' ? position.y / scale : position.y;
  const ratio = geometry.logicalWidth > 0 && geometry.cssWidth > 0 ? geometry.cssWidth / geometry.logicalWidth : 1;
  return {x: lx * ratio, y: ly * ratio};
}

/** The smallest part of an Element the arbiter reads, so the rule is tested without a DOM. */
export interface DropHitElement {
  closest(selector: string): DropHitElement | null;
  getAttribute(name: string): string | null;
}

export const WORKROOM_DROP_ZONE_ATTRIBUTE = 'data-workroom-drop-zone';
/** The terminal area inside a Workroom panel; anywhere else in the panel is the composer side. */
export const WORKROOM_DROP_TERMINAL_SELECTOR = '.ai-terminal-surface';

export type DropOwner =
  | {kind: 'voc'}
  | {kind: 'workroom'; zoneId: string; area: 'terminal' | 'composer'}
  | {kind: 'folder'};

/**
 * A modal dialog shown from inside a Workroom panel (the 세션 종료 dialog) is a DOM descendant of that panel, and
 * its backdrop hit-tests as the dialog itself — but the person sees the dialog, not the composer under it. Such a
 * hit is not the Workroom's unless the drop zone lies inside the dialog. `:modal` falls back to `dialog[open]`
 * where the engine does not know it.
 */
function insideModalOutsideItsZones(hit: DropHitElement): boolean {
  const zone = `[${WORKROOM_DROP_ZONE_ATTRIBUTE}]`;
  for (const modal of ['dialog:modal', 'dialog[open]']) {
    try { return !!hit.closest(modal) && !hit.closest(`${modal} ${zone}`); }
    catch { /* an unknown selector: try the next */ }
  }
  return false;
}

/** Exactly one owner. A zone counts only while it is registered (a stale attribute on a dead panel does not). */
export function decideDropOwner(input: {vocActive: boolean; hit: DropHitElement | null; liveZones: ReadonlySet<string>}): DropOwner {
  if (input.vocActive) return {kind: 'voc'};
  if (input.hit && insideModalOutsideItsZones(input.hit)) return {kind: 'folder'};
  const zone = input.hit?.closest(`[${WORKROOM_DROP_ZONE_ATTRIBUTE}]`) ?? null;
  const zoneId = zone?.getAttribute(WORKROOM_DROP_ZONE_ATTRIBUTE) ?? null;
  if (!zoneId || !input.liveZones.has(zoneId)) return {kind: 'folder'};
  return {kind: 'workroom', zoneId, area: input.hit?.closest(WORKROOM_DROP_TERMINAL_SELECTOR) ? 'terminal' : 'composer'};
}
