/**
 * Delivers Finder drops to the Workroom panel that owns them (rule: src/workroomDropArbiter.ts).
 *
 * Main window: Tauri's `onDragDropEvent` (the main window holds the event permission).
 * Workroom pop-outs: Rust's `agentstoz-drag`/`agentstoz-drop` CustomEvents carry only coordinates; the paths
 *   come from the label-checked `workroom_take_drop`, once (src-tauri/src/workroom_drop.rs).
 * The web build has no path-carrying drop; the panel handles DOM drops itself (src/WorkroomAttachBar.tsx).
 *
 * Only drags that carry files show the overlay and attach. Tauri's drag handler takes every drag over the webview
 * — selected text, a chip's thumbnail or a link dragged inside the page too — and those arrive with no path. A drag
 * that started in this page (DOM `dragstart`, the one drag event that still reaches the page) is ignored outright;
 * a pathless drag from another app gets one message on drop that does not assume it was a file.
 */
import {isTauri} from './lib/env';
import {isVocDropCaptureActive} from './voc/vocDropCapture';
import {decideDropOwner, dropPointToCss, dropPositionUnit, WORKROOM_DROP_ZONE_ATTRIBUTE, type DropGeometry, type DropOwner} from './workroomDropArbiter';

export type WorkroomDropEvent =
  | {type: 'over'; area: 'terminal' | 'composer'}
  | {type: 'leave'}
  | {type: 'drop'; area: 'terminal' | 'composer'; paths: string[]; total: number; pathless?: boolean};
type ZoneHandler = (event: WorkroomDropEvent) => void;

const zones = new Map<string, ZoneHandler>();
let hovered: string | null = null;
let installed = false;
let nextZone = 1;
let measured: DropGeometry | null = null;
/** Whether the drag now over the window carries file paths (null: no drag seen yet). */
let dragFiles: boolean | null = null;
/** A drag that started inside this page (text, a thumbnail, a link): never an attachment. */
let internalDrag = false;
let geometryInstalled = false;

function platform(): string { return typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent; }
function fallbackGeometry(): DropGeometry {
  return {unit: dropPositionUnit(platform()), scaleFactor: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, logicalWidth: 0, cssWidth: 0};
}
function currentGeometry(): DropGeometry { return measured ?? fallbackGeometry(); }

function popoutWindow(): boolean {
  try {
    const label = (window as unknown as {__TAURI_INTERNALS__?: {metadata?: {currentWindow?: {label?: string}}}}).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
    return typeof label === 'string' && label.startsWith('workroom-');
  } catch { return false; }
}

/** The main window measures its logical width so app zoom maps back to CSS pixels. */
async function measureMainWindow(): Promise<void> {
  try {
    const {getCurrentWindow} = await import('@tauri-apps/api/window');
    const current = getCurrentWindow();
    const [size, scale] = await Promise.all([current.innerSize(), current.scaleFactor()]);
    measured = {unit: dropPositionUnit(platform()), scaleFactor: scale, logicalWidth: size.width / (scale || 1), cssWidth: window.innerWidth};
  } catch { /* the fallback geometry still converts physical pixels */ }
}

/**
 * Keeps the main window's geometry measured (app zoom, scale). FolderDropZone calls this too, so its own inside
 * test uses the same coordinate model as the Workroom even when no Workroom is open. Pop-outs get their geometry
 * with each event instead.
 */
export function installWorkroomDropGeometry(): void {
  if (geometryInstalled || typeof window === 'undefined' || !isTauri() || popoutWindow()) return;
  geometryInstalled = true;
  void measureMainWindow();
  window.addEventListener('resize', () => { void measureMainWindow(); });
}

/** A Tauri drop position (macOS: view points; elsewhere: physical pixels) as CSS pixels after the app's zoom. */
export function workroomDropPointToCss(position: {x: number; y: number}): {x: number; y: number} {
  return dropPointToCss(position, currentGeometry());
}

export function workroomDropOwnerAt(position: {x: number; y: number}, geometry: DropGeometry = currentGeometry()): DropOwner {
  if (typeof document === 'undefined') return {kind: 'folder'};
  const css = dropPointToCss(position, geometry);
  return decideDropOwner({vocActive: isVocDropCaptureActive(), hit: document.elementFromPoint(css.x, css.y), liveZones: new Set(zones.keys())});
}

/** FolderDropZone asks this first: a drop the Workroom owns must not also add a project. */
export function workroomOwnsDropAt(position: {x: number; y: number}): boolean {
  return zones.size > 0 && workroomDropOwnerAt(position).kind === 'workroom';
}

function leave(): void {
  if (hovered) zones.get(hovered)?.({type: 'leave'});
  hovered = null;
}
function hover(position: {x: number; y: number}, geometry?: DropGeometry): void {
  const owner = workroomDropOwnerAt(position, geometry);
  const id = owner.kind === 'workroom' ? owner.zoneId : null;
  if (hovered && hovered !== id) zones.get(hovered)?.({type: 'leave'});
  hovered = id;
  if (owner.kind === 'workroom') zones.get(owner.zoneId)?.({type: 'over', area: owner.area});
}
function endDrag(): void { dragFiles = null; internalDrag = false; }
function deliver(owner: DropOwner, paths: string[], total: number): void {
  const fromThisPage = internalDrag;
  leave();
  endDrag();
  if (owner.kind !== 'workroom') return;
  // Moving text or a thumbnail inside the page is not an attachment, and says nothing.
  if (!paths.length && total === 0 && fromThisPage) return;
  zones.get(owner.zoneId)?.({type: 'drop', area: owner.area, paths, total, ...(!paths.length && total === 0 ? {pathless: true} : {})});
}
/** A drag carrying files hovers; any other drag shows nothing until it is dropped (or not). */
function enter(carriesFiles: boolean): void {
  dragFiles = carriesFiles;
  if (!carriesFiles) leave();
}
function trackPageDrags(): void {
  document.addEventListener('dragstart', () => { internalDrag = true; }, true);
  document.addEventListener('dragend', () => { internalDrag = false; }, true);
}

/** Exposed for tests and FolderDropZone: is a drag that started inside this page in progress? */
export function workroomInternalDragActive(): boolean { return internalDrag; }

function installMain(): void {
  installWorkroomDropGeometry();
  trackPageDrags();
  void import('@tauri-apps/api/webview').then(({getCurrentWebview}) => getCurrentWebview().onDragDropEvent(({payload}) => {
    if (payload.type === 'leave') { leave(); endDrag(); return; }
    if (payload.type === 'enter') { void measureMainWindow(); enter(payload.paths.length > 0); if (!dragFiles) return; }
    if (payload.type === 'drop') { deliver(workroomDropOwnerAt(payload.position), payload.paths, payload.paths.length); return; }
    if (dragFiles) hover(payload.position);
  })).catch(() => { /* drops just do nothing here; the buttons and paste still work */ });
}

type PopoutDetail = {x?: unknown; y?: unknown; width?: unknown; count?: unknown; type?: unknown};
function popoutGeometry(detail: PopoutDetail): DropGeometry {
  return {unit: 'logical', scaleFactor: 1, logicalWidth: typeof detail.width === 'number' ? detail.width : 0, cssWidth: window.innerWidth};
}
function point(detail: PopoutDetail): {x: number; y: number} {
  return {x: typeof detail.x === 'number' ? detail.x : 0, y: typeof detail.y === 'number' ? detail.y : 0};
}
function installPopout(): void {
  trackPageDrags();
  window.addEventListener('agentstoz-drag', event => {
    const detail = ((event as CustomEvent).detail ?? {}) as PopoutDetail;
    if (detail.type === 'leave') { leave(); endDrag(); return; }
    if (detail.type === 'enter') { enter(typeof detail.count === 'number' && detail.count > 0); if (!dragFiles) return; }
    if (dragFiles) hover(point(detail), popoutGeometry(detail));
  });
  window.addEventListener('agentstoz-drop', event => {
    const detail = ((event as CustomEvent).detail ?? {}) as PopoutDetail;
    const owner = workroomDropOwnerAt(point(detail), popoutGeometry(detail));
    const fromThisPage = internalDrag;
    leave();
    if (typeof detail.count === 'number' && detail.count === 0) {
      // Nothing with a path was dropped: clear Rust's (empty) entry, and explain only a drag from another app.
      endDrag();
      void import('@tauri-apps/api/core').then(({invoke}) => invoke('workroom_take_drop')).catch(() => {});
      if (!fromThisPage && owner.kind === 'workroom') zones.get(owner.zoneId)?.({type: 'drop', area: owner.area, paths: [], total: 0, pathless: true});
      return;
    }
    // Taken once in every case, so a drop nobody owns does not wait in Rust for the next one.
    void import('@tauri-apps/api/core').then(({invoke}) => invoke<{paths: string[]; total: number}>('workroom_take_drop'))
      .then(taken => deliver(owner, Array.isArray(taken?.paths) ? taken.paths.filter(path => typeof path === 'string') : [], typeof taken?.total === 'number' ? taken.total : 0))
      .catch(() => { if (owner.kind === 'workroom') zones.get(owner.zoneId)?.({type: 'drop', area: owner.area, paths: [], total: -1}); });
  });
}

/**
 * Registers one Workroom panel as a drop zone. The zone attribute goes on the panel element so the arbiter can
 * find it under the drop point; the returned function removes both.
 */
export function registerWorkroomDropZone(element: HTMLElement, handler: ZoneHandler): () => void {
  const id = `workroom-drop-${nextZone++}`;
  zones.set(id, handler);
  element.setAttribute(WORKROOM_DROP_ZONE_ATTRIBUTE, id);
  if (!installed && isTauri()) { installed = true; if (popoutWindow()) installPopout(); else installMain(); }
  return () => {
    zones.delete(id);
    if (hovered === id) hovered = null;
    if (element.getAttribute(WORKROOM_DROP_ZONE_ATTRIBUTE) === id) element.removeAttribute(WORKROOM_DROP_ZONE_ATTRIBUTE);
  };
}
