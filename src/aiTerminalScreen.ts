import {Terminal} from '@xterm/headless';
import {SerializeAddon} from '@xterm/addon-serialize';
import {terminalOutputPage} from './aiTerminalOutput';

type OutputChunk = {seq:number;text:string};
export interface AiTerminalSnapshotPage {chunks:OutputChunk[];nextCursor:number;hasMore:boolean;truncated:boolean}

/** The same wire limits `terminalOutputPage` keeps (old phones validate every response with them). */
export const AI_TERMINAL_PAGE_MAX_CHUNKS = 4;
export const AI_TERMINAL_PAGE_MAX_CHUNK_CHARS = 1024;
export const AI_TERMINAL_PAGE_MAX_BYTES = 8500;
/** A phone must see the current screen after at most this many relay reads. */
export const AI_TERMINAL_SNAPSHOT_MAX_PAGES = 2;
/** Colored serializations tried in order; the first that fits wins. */
const SNAPSHOT_SCROLLBACK_CANDIDATES = [60, 0] as const;
/** The headless copy only needs what a snapshot can carry, not the phone's 2,000-line history. */
export const AI_TERMINAL_HEADLESS_SCROLLBACK = 200;
const SNAPSHOT_CACHE_ENTRIES = 4;
const SNAPSHOT_CACHE_TTL_MS = 120_000;
const UNIT_CHARS = 256;

interface CachedSnapshot {first:number;last:number;pages:OutputChunk[][];at:number}

const encoder = new TextEncoder();
const chunkBytes = (chunk:OutputChunk) => encoder.encode(JSON.stringify(chunk)).length;

/** Split into surrogate-safe units; escape sequences may be split, the client joins the whole stream. */
function units(text:string):string[] {
  const out:string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + UNIT_CHARS);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

/** Pack a serialized screen into v1-sized pages. */
export function packSnapshotPages(text:string, seqWidth:number, maxPages = AI_TERMINAL_SNAPSHOT_MAX_PAGES):string[][] | null {
  const pages:string[][] = [];
  let page:string[] = [], bytes = 0;
  const size = (value:string) => chunkBytes({seq:seqWidth, text:value});
  for (const unit of units(text)) {
    const last = page.at(-1);
    if (last !== undefined && last.length + unit.length <= AI_TERMINAL_PAGE_MAX_CHUNK_CHARS && bytes - size(last) + size(last + unit) <= AI_TERMINAL_PAGE_MAX_BYTES) {
      bytes += size(last + unit) - size(last);
      page[page.length - 1] = last + unit;
      continue;
    }
    if (page.length < AI_TERMINAL_PAGE_MAX_CHUNKS && bytes + size(unit) <= AI_TERMINAL_PAGE_MAX_BYTES) {
      page.push(unit); bytes += size(unit); continue;
    }
    pages.push(page);
    if (pages.length >= maxPages) return null;
    page = [unit]; bytes = size(unit);
  }
  if (page.length) pages.push(page);
  return pages.length <= maxPages ? pages : null;
}

import { CURSOR_POSITION_REPLY, DEVICE_ATTRIBUTES_REPLY } from './aiTerminalDeviceAttributes';
export { CURSOR_POSITION_REPLY, DEVICE_ATTRIBUTES_REPLY };
/** How long after the host answered a plain CPR a viewer's `CSI 1;m R` is read as its duplicate. */
export const AI_TERMINAL_CPR_ECHO_WINDOW_MS = 30_000;

/** Headless copy of one Workroom PTY used by late viewers to obtain the current screen. */
export class AiTerminalScreen {
  readonly #term:Terminal;
  readonly #serializer = new SerializeAddon();
  #parsedSeq = 0;
  #disposed = false;
  #snapshots:CachedSnapshot[] = [];
  #plainCursorReplyAt = Number.NEGATIVE_INFINITY;
  /**
   * `reply` receives the terminal's answers to Device Attributes and cursor-position queries — the host is
   * the one answerer, whether anyone is watching or not, at the PTY's own size.
   * - DA: Antigravity (agy) asks `CSI > c` at startup and draws nothing until it is answered; the viewer's
   *   xterm drops its own answer unless direct input is on, so nobody answered and agy stayed blank (3호, 2026-10-07).
   * - CPR (`CSI 6 n`) and DECXCPR (`CSI ? 6 n`): Codex asks on every PTY size change and stops reading keys for
   *   up to 2 s waiting. The phone resizes right before its first input, so the text and the Enter sent 150 ms
   *   later reached Codex in one batch and its paste-burst rule turned Enter into a newline — the request stayed
   *   in the composer (TestFlight 712, 2026-10-09; real Codex 0.160: 0/6 submitted unanswered, 36/36 answered).
   * Answering a CPR here is safe even though the bytes can look like Shift/Ctrl+F3: this copy has no keyboard,
   * so its answer can only be to a query the program sent. The F3 ambiguity lives in viewer input, where the
   * host removes duplicates (aiTerminalReplyFilter.ts).
   */
  constructor(cols:number, rows:number, private readonly now:()=>number = Date.now, reply?:(data:string)=>void) {
    this.#term = new Terminal({cols, rows, scrollback:AI_TERMINAL_HEADLESS_SCROLLBACK, allowProposedApi:true});
    this.#term.loadAddon(this.#serializer as never);
    if (reply) this.#term.onData(data => {
      if (this.#disposed) return;
      if (DEVICE_ATTRIBUTES_REPLY.test(data)) { reply(data); return; }
      const cursor = CURSOR_POSITION_REPLY.exec(data);
      if (!cursor) return;
      // xterm.js reports column cols+1 while a wrap is pending; real terminals report the last column.
      const column = Math.min(Number(cursor[3]), this.#term.cols);
      if (!cursor[1]) this.#plainCursorReplyAt = this.now();
      reply(`\x1b[${cursor[1] ?? ''}${cursor[2]};${column}R`);
    });
  }
  get parsedSeq() { return this.#parsedSeq; }
  /** The host answered a plain `CSI 6 n` within the echo window (a viewer's `CSI 1;m R` is then its duplicate). */
  answeredPlainCursorRecently() { return this.now() - this.#plainCursorReplyAt <= AI_TERMINAL_CPR_ECHO_WINDOW_MS; }
  write(text:string, seq:number) {
    if (this.#disposed || !text) return;
    this.#term.write(text, () => { if (seq > this.#parsedSeq) this.#parsedSeq = seq; });
  }
  resize(cols:number, rows:number) {
    if (this.#disposed) return;
    this.#term.write('', () => { if (!this.#disposed && (this.#term.cols !== cols || this.#term.rows !== rows)) this.#term.resize(cols, rows); });
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true; this.#snapshots = [];
    this.#term.dispose();
  }
  #drained() { return new Promise<void>(resolve => this.#disposed ? resolve() : this.#term.write('', resolve)); }
  /** The CLI asked for bracketed paste (DECSET 2004): a multi-line submission can arrive as one paste. */
  get bracketedPasteMode() { return !this.#disposed && this.#term.modes.bracketedPasteMode; }
  /** The CLI asked for application cursor keys (DECCKM): arrows are sent as ESC O A…D. */
  get applicationCursorKeysMode() { return !this.#disposed && this.#term.modes.applicationCursorKeysMode; }
  /** Modes after every write queued so far has been parsed. */
  async settledModes():Promise<{bracketedPaste:boolean;applicationCursorKeys:boolean}> {
    await this.#drained();
    return {bracketedPaste:this.bracketedPasteMode, applicationCursorKeys:this.applicationCursorKeysMode};
  }
  /** Plain visible rows (right-trimmed) and the cursor, for host-side readers; never sent to a phone. */
  async plainRows():Promise<{rows:string[];cursorRow:number;cursorCol:number;alternate:boolean} | null> {
    await this.#drained();
    if (this.#disposed) return null;
    const term = this.#term, buffer = term.buffer.active;
    const rows = Array.from({length:term.rows}, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '');
    return {rows, cursorRow:buffer.cursorY, cursorCol:buffer.cursorX, alternate:buffer.type === 'alternate'};
  }
  /** Plain visible rows, bottom-anchored; top rows are dropped until the wire limit fits. */
  #plainScreen(seqWidth:number):string[][] | null {
    const term = this.#term, buffer = term.buffer.active;
    const lines:{row:number;text:string}[] = [];
    for (let y = 0; y < term.rows; y++) {
      const text = buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '';
      if (text) lines.push({row:y + 1, text});
    }
    const modes = term.modes;
    const prefix = (buffer.type === 'alternate' ? '\x1b[?1049h' : '') + (modes.applicationCursorKeysMode ? '\x1b[?1h' : '')
      + (modes.bracketedPasteMode ? '\x1b[?2004h' : '') + (modes.applicationKeypadMode ? '\x1b=' : '') + '\x1b[H\x1b[2J';
    const cursor = `\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`;
    for (let from = 0; from <= lines.length; from++) {
      const body = lines.slice(from).map(line => `\x1b[${line.row};1H${line.text}`).join('');
      const pages = packSnapshotPages(prefix + body + cursor, seqWidth);
      if (pages) return pages;
    }
    return null;
  }
  #serialize(seqWidth:number):string[][] | null {
    for (const scrollback of SNAPSHOT_SCROLLBACK_CANDIDATES) {
      const pages = packSnapshotPages(this.#serializer.serialize({scrollback}), seqWidth);
      if (pages) return pages;
    }
    return this.#plainScreen(seqWidth);
  }
  #cached(after:number) {
    const now = this.now();
    this.#snapshots = this.#snapshots.filter(entry => now - entry.at < SNAPSHOT_CACHE_TTL_MS);
    for (const entry of this.#snapshots) {
      let offset = 0;
      for (let index = 0; index < entry.pages.length; index++) {
        if (entry.first + offset === after + 1 && index > 0) return {entry, index};
        offset += entry.pages[index]!.length;
      }
    }
    return null;
  }
  #page(entry:CachedSnapshot, index:number, latest:number):AiTerminalSnapshotPage {
    const chunks = entry.pages[index]!;
    return {chunks:chunks.map(chunk => ({...chunk})), nextCursor:chunks.at(-1)!.seq,
      hasMore:index < entry.pages.length - 1 || latest > entry.last, truncated:true};
  }
  async snapshotPage(after:number, retained:readonly OutputChunk[], latest:number):Promise<AiTerminalSnapshotPage | null> {
    if (this.#disposed) return null;
    if (after > 0) {
      const found = this.#cached(after);
      return found ? this.#page(found.entry, found.index, latest) : null;
    }
    const first = terminalOutputPage(retained, 0);
    if (!first.hasMore && !first.truncated) return null;
    await this.#drained();
    if (this.#disposed) return null;
    const last = this.#parsedSeq;
    const texts = this.#serialize(Math.max(last, 1));
    const count = texts?.reduce((sum, page) => sum + page.length, 0) ?? 0;
    if (!texts || !count || last < count) return null;
    let seq = last - count;
    const entry:CachedSnapshot = {first:last - count + 1, last, at:this.now(), pages:texts.map(page => page.map(text => ({seq:++seq, text})))};
    this.#snapshots = [entry, ...this.#snapshots].slice(0, SNAPSHOT_CACHE_ENTRIES);
    return this.#page(entry, 0, latest);
  }
}
