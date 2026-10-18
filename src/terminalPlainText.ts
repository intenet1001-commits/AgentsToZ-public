import {Terminal} from '@xterm/headless';

/** Upper bound of the plain text one Workroom tail read returns to an orchestrating AI. */
export const TERMINAL_TAIL_MAX_BYTES = 8_000;

/** Trailing blanks and blank-line runs carry no meaning for a reader; tokens do. */
function tidyLines(lines: readonly string[]): string {
  const out: string[] = [];
  for (const line of lines.map(value => value.replace(/\s+$/u, ''))) {
    if (!line && !out.at(-1)) continue;
    out.push(line);
  }
  while (out.length && !out.at(-1)) out.pop();
  return out.join('\n');
}

/**
 * Plain text of raw PTY output as a terminal of this size would show it. TUIs redraw with
 * cursor movement and erase sequences; replaying them (instead of deleting escape codes)
 * keeps one copy of each redrawn frame and applies carriage-return overwrites.
 */
export async function renderTerminalPlainText(raw: string, cols: number, rows: number, scrollback = 1_000): Promise<string> {
  if (!raw) return '';
  let term: Terminal | undefined;
  try {
    term = new Terminal({cols, rows, scrollback, allowProposedApi: true});
    await new Promise<void>(resolve => term!.write(raw, resolve));
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      // A soft-wrapped row continues on the next one: keep its full width, then join.
      const text = line.translateToString(!buffer.getLine(y + 1)?.isWrapped);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return tidyLines(lines);
  } catch {
    return stripTerminalControls(raw);
  } finally {
    term?.dispose();
  }
}

/** Line-based fallback when no terminal can be created: removes controls, applies CR and BS. */
export function stripTerminalControls(raw: string): string {
  const lines: string[] = [];
  let line = '', returned = false;
  const newline = () => { lines.push(line); line = ''; returned = false; };
  const put = (text: string) => { if (returned) { line = ''; returned = false; } line += text; };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const next = raw[i + 1] ?? '';
    if (ch === '\x1b' || ch === '\u009b' || ch === '\u009d') {
      if (ch === '\u009b' || next === '[') {
        let j = ch === '\u009b' ? i + 1 : i + 2;
        while (j < raw.length && /[0-?]/.test(raw[j]!)) j++;
        while (j < raw.length && /[ -/]/.test(raw[j]!)) j++;
        const final = raw[j];
        if (final && 'ABEFHdf'.includes(final) && line.trim()) newline();
        else if (final === 'G') returned = true;
        else if (final === 'C' && line && !/\s$/.test(line)) put(' ');
        i = j;
        continue;
      }
      if (ch === '\u009d' || next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
        let j = ch === '\u009d' ? i + 1 : i + 2;
        while (j < raw.length && raw[j] !== '\x07' && raw[j] !== '\u009c' && !(raw[j] === '\x1b' && raw[j + 1] === '\\')) j++;
        i = raw[j] === '\x1b' ? j + 1 : j;
        continue;
      }
      i += '()*+-./#%'.includes(next) && next ? 2 : 1;
      continue;
    }
    if (ch === '\n') { newline(); continue; }
    if (ch === '\r') { if (next !== '\n') returned = true; continue; }
    if (ch === '\b') { if (!returned) line = Array.from(line).slice(0, -1).join(''); continue; }
    const code = ch.charCodeAt(0);
    if (ch !== '\t' && (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f))) continue;
    put(ch);
  }
  if (line) lines.push(line);
  return tidyLines(lines);
}

/** Index just past the escape sequence that starts at `start`, or -1 when `text` ends inside it. */
function escapeSequenceEnd(text: string, start: number): number {
  const introducer = text[start];
  let i = start + 1;
  let string = introducer === '\u009d' || introducer === '\u0090';
  if (introducer === '\x1b') {
    const next = text[i];
    if (next === undefined) return -1;
    if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') { string = true; i++; }
    else if (next === '[') i++;
    else {
      // ESC, intermediates, final (for example ESC ( B or the ST of a string, ESC \).
      while (i < text.length && /[ -/]/.test(text[i]!)) i++;
      return i < text.length ? i + 1 : -1;
    }
  }
  if (string) {
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '\x07' || ch === '\u009c') return i + 1;
      if (ch === '\x1b') return text[i + 1] === undefined ? -1 : text[i + 1] === '\\' ? i + 2 : i;
    }
    return -1;
  }
  // CSI: parameters, intermediates, one final byte.
  while (i < text.length && /[0-?]/.test(text[i]!)) i++;
  while (i < text.length && /[ -/]/.test(text[i]!)) i++;
  return i < text.length ? i + 1 : -1;
}

/**
 * The escape sequence `text` ends in the middle of, or ''. Output is stored in chunks cut at
 * arbitrary points, so a read that starts at a chunk can start inside a CSI or OSC sequence;
 * prepending this suffix from the chunk before repairs it without dropping any new output.
 */
export function incompleteEscapeSuffix(text: string): string {
  const start = Math.max(text.lastIndexOf('\x1b'), text.lastIndexOf('\u009b'), text.lastIndexOf('\u009d'), text.lastIndexOf('\u0090'));
  return start >= 0 && escapeSequenceEnd(text, start) < 0 ? text.slice(start) : '';
}

/**
 * A raw window whose beginning was cut off (older output omitted) may start with the tail of an
 * escape sequence, which a terminal would print as text (e.g. `5;255;255m`). Drop everything up to
 * the first line feed or escape so the window starts at a boundary a terminal can parse.
 */
export function dropPartialTerminalPrefix(raw: string): string {
  const lineFeed = raw.indexOf('\n'), escape = raw.indexOf('\x1b');
  if (escape >= 0 && (lineFeed < 0 || escape < lineFeed)) return raw.slice(escape);
  return lineFeed >= 0 ? raw.slice(lineFeed + 1) : raw;
}

/** Keeps whole trailing lines within the UTF-8 budget; a single oversized line keeps its end. */
export function keepTailUtf8(text: string, maxBytes: number): {text: string; cut: boolean} {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return {text, cut: false};
  const lines = text.split('\n');
  const kept: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const size = encoder.encode(lines[index]!).length + (kept.length ? 1 : 0);
    if (bytes + size <= maxBytes) { kept.unshift(lines[index]!); bytes += size; continue; }
    if (!kept.length) {
      let tail = '', tailBytes = 0;
      for (const character of Array.from(lines[index]!).reverse()) {
        const width = encoder.encode(character).length;
        if (tailBytes + width > maxBytes) break;
        tail = character + tail; tailBytes += width;
      }
      kept.unshift(tail);
    }
    break;
  }
  return {text: kept.join('\n'), cut: true};
}
