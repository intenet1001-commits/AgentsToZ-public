/**
 * Workroom terminal view preferences — font size and the wide view.
 *
 * Stored per device in localStorage: a phone and a Mac want different text
 * sizes, so this is never synced. A broken or unreadable value quietly falls
 * back to the default — a terminal that refuses to render over a preference
 * reads as a broken app, not as a setting.
 */
export const WORKROOM_FONT_MIN = 10;
export const WORKROOM_FONT_MAX = 24;
/**
 * 원격(휴대폰·포털) 화면이 처음 쓰는 크기. 호스트의 100칸 줄을 폰 너비에서 다시 접으므로, 16px이면
 * 한 줄에 20자 남짓이라 모든 줄이 네 번씩 접혀 깨진 것처럼 보였다(VOC 2026-10-05, 아이폰 17 Pro).
 * 좁은 화면에서는 12px로 시작한다 — A+로 언제든 키울 수 있고, 고른 크기는 저장된다.
 */
export const WORKROOM_REMOTE_FONT_NARROW = 12;
export const WORKROOM_REMOTE_FONT_WIDE = 16;
export function remoteWorkroomFontFloor(viewportWidth: number): number {
  return viewportWidth > 0 && viewportWidth <= 640 ? WORKROOM_REMOTE_FONT_NARROW : WORKROOM_REMOTE_FONT_WIDE;
}
export const WORKROOM_FONT_DEFAULT = 13;

const FONT_KEY = 'portmanager-workroom-font-size';
/** Remote (phone·portal) screens keep their own size, saved only when the user presses A−/A+. */
const REMOTE_FONT_KEY = 'portmanager-workroom-remote-font-size';
const WIDE_KEY = 'portmanager-workroom-wide';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

function read(storage: PreferenceStorage, key: string): string | null {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function write(storage: PreferenceStorage, key: string, value: string): void {
  try { storage?.setItem(key, value); } catch { /* Private browsing refuses the write. */ }
}

export function stepWorkroomFontSize(size: number, delta: number): number {
  return Math.max(WORKROOM_FONT_MIN, Math.min(WORKROOM_FONT_MAX, size + delta));
}

export function readWorkroomFontSize(storage: PreferenceStorage): number {
  const raw = read(storage, FONT_KEY);
  const size = raw !== null && /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  return size >= WORKROOM_FONT_MIN && size <= WORKROOM_FONT_MAX ? size : WORKROOM_FONT_DEFAULT;
}

export function writeWorkroomFontSize(storage: PreferenceStorage, size: number): void {
  write(storage, FONT_KEY, String(size));
}

export function readWorkroomWide(storage: PreferenceStorage): boolean {
  return read(storage, WIDE_KEY) === 'true';
}

export function writeWorkroomWide(storage: PreferenceStorage, wide: boolean): void {
  write(storage, WIDE_KEY, wide ? 'true' : 'false');
}

/** `window.localStorage` itself can throw on access in a locked-down WebView. */
export function workroomPreferenceStorage(): PreferenceStorage {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/**
 * The size a remote screen chose with A−/A+, or null if it never chose. The old shared key was written on
 * every mount, so the phone's former 16px default was saved as if chosen and `max(12, 16)` kept every
 * phone at 16 — wrapping each 100-column line four times (iPhone, 2026-10-07). A choice below the narrow
 * starting size is honoured too; the old `max` threw it away on the next open.
 */
export function readWorkroomRemoteFontSize(storage: PreferenceStorage): number | null {
  const raw = read(storage, REMOTE_FONT_KEY);
  const size = raw !== null && /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  return size >= WORKROOM_FONT_MIN && size <= WORKROOM_FONT_MAX ? size : null;
}

export function writeWorkroomRemoteFontSize(storage: PreferenceStorage, size: number): void {
  write(storage, REMOTE_FONT_KEY, String(size));
}

/** Starting size: a remote screen uses its own saved choice, else the size for its width. */
export function initialWorkroomFontSize(remote: boolean, viewportWidth: number, storage: PreferenceStorage): number {
  if (remote) return readWorkroomRemoteFontSize(storage) ?? remoteWorkroomFontFloor(viewportWidth);
  return readWorkroomFontSize(storage);
}
