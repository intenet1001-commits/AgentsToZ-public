import {assemble} from 'es-hangul';

const HANGUL_COMPATIBILITY_JAMO = /^[\u3131-\u3163]$/u;

export interface TerminalHangulInputResult {
  ready: string;
  pending: boolean;
}

/**
 * xterm can briefly emit the text inserted after an IME commit and then emit
 * the delayed commit with that same text as its suffix (for example `🙂` then
 * `영🙂`). Both events arrive in one transport batch. Retract only that exact,
 * adjacent overlap; ordinary key events and already-flushed input are left
 * untouched by the caller.
 */
export function createTerminalCompositionOverlapFilter(
  now: () => number = () => performance.now(),
  windowMs = 80,
) {
  let previous = '';
  let previousAt = Number.NEGATIVE_INFINITY;
  return {
    push(data: string): {data: string; retract: string} {
      const currentAt = now();
      const retract = previous
        && data.length > previous.length
        && data.endsWith(previous)
        && currentAt - previousAt <= windowMs
        ? previous
        : '';
      previous = data;
      previousAt = currentAt;
      return {data, retract};
    },
  };
}

/**
 * macOS WKWebView can emit Korean compatibility jamo through xterm without a
 * composition lifecycle. Buffer only that broken delivery shape; completed
 * Hangul, Latin text, emoji and control characters continue without changes.
 */
export function createTerminalHangulInputFallback() {
  let compatibilityJamo = '';

  const flush = () => {
    const value = compatibilityJamo;
    compatibilityJamo = '';
    return value ? assemble([...value]) : '';
  };

  return {
    push(data: string): TerminalHangulInputResult {
      let ready = '';
      for (const character of data) {
        if (HANGUL_COMPATIBILITY_JAMO.test(character)) {
          compatibilityJamo += character;
          continue;
        }
        ready += flush() + character;
      }
      return {ready, pending: compatibilityJamo.length > 0};
    },
    flush,
  };
}

/** UTF-8 bounds preserve emoji/Korean when a paste spans multiple wire messages. */
export function splitTerminalInput(text: string): string[] {
  const parts: string[] = [];
  let part = '', bytes = 0, encoded = 0;
  for (const char of text) {
    const size = new TextEncoder().encode(char).length;
    const jsonSize = new TextEncoder().encode(JSON.stringify(char)).length - 2;
    if (bytes + size > 4096 || encoded + jsonSize > 7500) { parts.push(part); part = ''; bytes = 0; encoded = 0; }
    part += char; bytes += size; encoded += jsonSize;
  }
  if (part) parts.push(part);
  return parts;
}

/**
 * `splitTerminalInput` for a submission ending in Enter. A body that exactly fills the wire limit
 * used to leave the Enter alone in the last request, so it reached the CLI a round trip after the
 * text instead of after the measured paste delay. Move the tail of the body (at least one visible
 * character, never more than 64) into the Enter's request.
 */
export function splitTerminalSubmission(text: string): string[] {
  const parts = splitTerminalInput(text);
  if (parts.length < 2 || parts[parts.length - 1] !== '\r') return parts;
  const previous = [...parts[parts.length - 2]!];
  let moved = '', count = 0;
  while (previous.length && count < 64 && (!moved || /^[\r\n]*$/.test(moved))) { moved = previous.pop()! + moved; count++; }
  parts.splice(parts.length - 2, 2, ...(previous.length ? [previous.join('')] : []), moved + '\r');
  return parts;
}
