/**
 * Opens a Workroom pop-out. In the Mac app, Rust creates the window
 * (`open_workroom_window`) so no window needs a JS window-creation permission.
 * In the local web build it is an ordinary `window.open` of the same route.
 */
import {isTauri} from './lib/env';
import {buildWorkroomPopoutQuery, buildWorkroomPopoutUrl, type WorkroomPopoutRoute} from './workroomPopout';

export async function openWorkroomPopout(route: WorkroomPopoutRoute, title: string): Promise<void> {
  if (isTauri()) {
    const {invoke} = await import('@tauri-apps/api/core');
    await invoke<string>('open_workroom_window', {query: buildWorkroomPopoutQuery(route), title});
    return;
  }
  // A unique name each time so every click opens one more window (several at once).
  const opened = window.open(buildWorkroomPopoutUrl(window.location.href, route), `workroom-${Date.now()}`, 'popup=yes,width=960,height=980');
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
