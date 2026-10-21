/**
 * A Device Attributes reply (DA1 `CSI ? … c`, DA2 `CSI > … c`, DA3 `CSI = … c`) — what a terminal sends back
 * when a program asks «what are you». No key produces one, so it can be told apart from typing.
 *
 * Its own module with no imports: the Workroom panel runs in the browser and must not pull in
 * aiTerminalScreen.ts, which loads the server-only @xterm/headless (importing it there made Vite answer 500
 * and the whole panel failed to load — caught by tests/workroom-input-lifecycle.e2e.mjs).
 */
export const DEVICE_ATTRIBUTES_REPLY = /^\x1b\[[?>=][\d;]*c$/;
/**
 * A cursor position report: CPR `CSI r ; c R` (answer to `CSI 6 n`) or DECXCPR `CSI ? r ; c R`
 * (answer to `CSI ? 6 n`). Group 1 is the DEC-private `?`.
 */
export const CURSOR_POSITION_REPLY = /^\x1b\[(\?)?(\d+);(\d+)R$/;
/**
 * The only keys shaped like a CPR: xterm.js sends F3 with modifiers as `CSI 1 ; m R`, m = 2…16
 * (Keyboard.ts, case 114). A plain CPR for row 1, columns 2…16 is byte-identical.
 */
export const MODIFIED_F3_SHAPE = /^\x1b\[1;(?:[2-9]|1[0-6])R$/;
