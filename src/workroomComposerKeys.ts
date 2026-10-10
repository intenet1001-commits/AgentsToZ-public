/**
 * Keys typed in the Workroom input box that belong to the CLI (VOC 2026-10-02: "여기 박스 안에서도 방향키나 탭 등등"),
 * the rule NHCS 0.10.1 ships as draftKeyToCli: a CLI's menus and prompts answer to keys, not text, so they
 * should not need 「터미널 직접 입력」.
 *
 * - Always: Esc and Ctrl+C — except Esc while an @/#// suggestion list is open (it would otherwise
 *   interrupt the AI when the person only meant to leave the list).
 * - Only while the box is empty (no text, no image, no @ receiver): arrows, Tab/Shift+Tab, Enter,
 *   Backspace, Delete, Home/End, PageUp/PageDown. With anything in the box they edit or send it as before.
 * - Never ⌘/⌥ chords (app and capture shortcuts), never during an IME composition (the caller checks).
 * - An auto-repeated Backspace/Delete is not sent: holding Backspace to clear the box must not go on to
 *   erase the CLI's own input once the box is empty.
 */
export interface WorkroomComposerKeyContext {
  empty: boolean;
  /** The CLI turned on application cursor keys (DECCKM); arrows then use SS3 like a real terminal. */
  appCursor: boolean;
  /** An @, # or / suggestion list is showing. */
  menuOpen: boolean;
  repeat?: boolean;
}
export interface WorkroomComposerKeyMods {ctrl: boolean; meta: boolean; alt: boolean; shift: boolean}

export function workroomComposerKeyToCli(key: string, mods: WorkroomComposerKeyMods, context: WorkroomComposerKeyContext): string | null {
  if (mods.meta || mods.alt) return null;
  if (mods.ctrl) return !mods.shift && (key === 'c' || key === 'C') ? '\x03' : null;
  if (key === 'Escape') return context.menuOpen ? null : '\x1b';
  if (!context.empty) return null;
  if (context.repeat && (key === 'Backspace' || key === 'Delete')) return null;
  const cursor = (final: string) => (context.appCursor ? '\x1bO' : '\x1b[') + final;
  switch (key) {
    case 'ArrowUp': return cursor('A');
    case 'ArrowDown': return cursor('B');
    case 'ArrowRight': return cursor('C');
    case 'ArrowLeft': return cursor('D');
    case 'Home': return cursor('H');
    case 'End': return cursor('F');
    case 'Tab': return mods.shift ? '\x1b[Z' : '\t';
    case 'Enter': return mods.shift ? null : '\r';
    case 'Backspace': return '\x7f';
    case 'Delete': return '\x1b[3~';
    case 'PageUp': return '\x1b[5~';
    case 'PageDown': return '\x1b[6~';
    default: return null;
  }
}

export const WORKROOM_COMPOSER_KEYS_HINT = '입력칸이 비어 있으면 방향키·Tab·Enter·Backspace는 AI로 갑니다. Esc·Ctrl+C는 언제나 AI로 갑니다.';
