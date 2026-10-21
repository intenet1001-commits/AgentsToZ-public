/**
 * Opens a Workroom pop-out. In the Mac app, Rust creates the window
 * (`open_workroom_window`) so no window needs a JS window-creation permission.
 * In the local web build it is an ordinary `window.open` of the same route.
 */
import {isTauri} from './lib/env';
import {buildWorkroomPopoutQuery, buildWorkroomPopoutUrl, type WorkroomPopoutRoute} from './workroomPopout';

/** Keep the conversation wide, with room for the OS frame on a laptop screen. */
export function workroomPopoutSize(availableWidth: number, availableHeight: number): {width: number; height: number} {
  const width = Number.isFinite(availableWidth) && availableWidth > 32 ? availableWidth - 32 : 1120;
  const height = Number.isFinite(availableHeight) && availableHeight > 64 ? availableHeight - 64 : 780;
  return {width: Math.floor(Math.min(1120, width)), height: Math.floor(Math.min(780, height))};
}

export async function openWorkroomPopout(route: WorkroomPopoutRoute, title: string): Promise<void> {
  if (isTauri()) {
    const {invoke} = await import('@tauri-apps/api/core');
    await invoke<string>('open_workroom_window', {query: buildWorkroomPopoutQuery(route), title});
    return;
  }
  // A unique name each time so every click opens one more window (several at once).
  const {width, height} = workroomPopoutSize(window.screen.availWidth, window.screen.availHeight);
  const opened = window.open(buildWorkroomPopoutUrl(window.location.href, route), `workroom-${Date.now()}`, `popup=yes,width=${width},height=${height}`);
  if (!opened) throw new Error('브라우저가 새 창을 막았습니다. 이 페이지의 팝업을 허용한 뒤 다시 눌러 주세요.');
}

/** A pop-out follows its session: its OS title names the project and agent it shows now. */
export function setWorkroomWindowTitle(title: string): void {
  document.title = title;
  if (!isTauri()) return;
  void import('@tauri-apps/api/window')
    .then(({getCurrentWindow}) => getCurrentWindow().setTitle(title))
    .catch(() => { /* The title is a convenience; the window keeps working. */ });
}
