import {CURSOR_POSITION_REPLY, MODIFIED_F3_SHAPE} from './aiTerminalDeviceAttributes';

const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~';
/** DA1/DA2/DA3, CPR and DECXCPR replies anywhere in a string (a viewer batches them with typing). */
const REPLY = /\x1b\[[?>=][\d;]*c|\x1b\[\??\d+;\d+R/g;
/** Enough of what was already passed on to find a paste end marker cut by a request split. */
const MARKER_TAIL = PASTE_END.length - 1;
/**
 * Every client splits a large batch at 4096 bytes / 7500 JSON characters (splitTerminalInput, the LAN page),
 * so a part that is not the last is at least 1024 characters. Only such a part can end in the middle of an
 * escape sequence; a short request ending in ESC is a real Esc key and is never held.
 */
export const VIEWER_SPLIT_PART_MIN_CHARS = 1024;
/** A lone ESC or an unfinished CSI (`ESC [`, private marker, digits, `;`) — the head of a reply or a paste marker. */
const UNFINISHED_ESCAPE = /\x1b(?:\[[?>=]?[\d;]*)?$/;

export interface ViewerReplyFilterState {
  /** A viewer paste that started in an earlier input request and has not ended yet. */
  pasteOpen: boolean;
  /** The last characters of an open paste already passed on, so an end marker cut by a split is still seen. */
  tail?: string;
  /** An unfinished escape sequence held back from the end of a split request; it leads the next request. */
  held?: string;
}
export interface ViewerReplyFilterOptions {
  /** Whether a plain `CSI 1;m R` (m 2…16) is also a reply here, not Shift/Ctrl/Alt+F3. */
  ambiguousIsReply: boolean;
}

/**
 * Remove terminal query replies a viewer's xterm forwarded (direct input, the LAN page, a replay of old
 * output). The host's headless screen already answered every one of those queries, so a forwarded reply
 * is a duplicate (or a stale answer to a query asked long ago).
 *
 * It reads the requests of one session as one stream: a client cuts a large batch into parts without regard
 * to escape sequences, so a paste marker or a reply can arrive in two requests. Paste content is passed on
 * as it arrives and never edited (a cut end marker is found through `tail`); an unfinished escape at the end
 * of a split part is held and joins the next request, so neither half reaches the CLI on its own.
 */
export function stripViewerTerminalReplies(input:string, state:ViewerReplyFilterState, options:ViewerReplyFilterOptions):string {
  const data = (state.held ?? '') + input;
  state.held = '';
  let out = '', index = 0;
  while (index < data.length) {
    if (state.pasteOpen) {
      const tail = state.tail ?? '';
      const joined = tail + data.slice(index);
      const at = joined.indexOf(PASTE_END);
      if (at < 0) { out += data.slice(index); state.tail = joined.slice(-MARKER_TAIL); index = data.length; break; }
      // The tail is shorter than the marker, so the paste always ends inside this request.
      const end = index + at + PASTE_END.length - tail.length;
      out += data.slice(index, end); index = end; state.pasteOpen = false; state.tail = '';
      continue;
    }
    const start = data.indexOf(PASTE_START, index);
    const plain = start < 0 ? data.slice(index) : data.slice(index, start);
    out += plain.replace(REPLY, reply => {
      if (!CURSOR_POSITION_REPLY.test(reply)) return '';           // DA: no key produces one
      if (reply.startsWith('\x1b[?')) return '';                    // DECXCPR: no key produces one
      return MODIFIED_F3_SHAPE.test(reply) && !options.ambiguousIsReply ? reply : '';
    });
    if (start < 0) break;
    out += PASTE_START; index = start + PASTE_START.length; state.pasteOpen = true; state.tail = '';
  }
  if (!state.pasteOpen && input.length >= VIEWER_SPLIT_PART_MIN_CHARS) {
    const unfinished = UNFINISHED_ESCAPE.exec(out);
    if (unfinished) { state.held = unfinished[0]; out = out.slice(0, unfinished.index); }
  }
  return out;
}
