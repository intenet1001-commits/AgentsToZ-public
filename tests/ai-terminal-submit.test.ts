import {describe, expect, test} from 'bun:test';
import {aiTerminalBracketedPaste, aiTerminalSubmitSteps, CODEX_LONG_SUBMISSION_BYTES} from '../src/aiTerminalSubmit';
import {splitTerminalInput, splitTerminalSubmission} from '../src/aiTerminalInput';

const PASTE = (text: string) => `\x1b[200~${text}\x1b[201~`;

describe('how one Workroom input reaches a CLI (shared by typed, routed and MCP instructions)', () => {
  test('single-line text keeps its bytes and the measured Enter delay, with or without bracketed paste', () => {
    for (const bracketedPaste of [undefined, false, true]) {
      expect(aiTerminalSubmitSteps('codex', '한 번에\r', {bracketedPaste})).toEqual([{write: '한 번에'}, {waitMs: 150}, {write: '\r'}]);
      expect(aiTerminalSubmitSteps('claude', 'Claude\r', {bracketedPaste})).toEqual([{write: 'Claude'}, {waitMs: 40}, {write: '\r'}]);
      expect(aiTerminalSubmitSteps('hermes', '한글 지시\r', {bracketedPaste})).toEqual([{write: '한글 지시'}, {waitMs: 40}, {write: '\r'}]);
      expect(aiTerminalSubmitSteps('agy', 'READY\r', {bracketedPaste})).toEqual([{write: 'READY'}, {waitMs: 40}, {write: '\r'}]);
    }
  });

  test('a long Codex orchestration prompt settles before its single Enter', () => {
    const boundary = 'a'.repeat(CODEX_LONG_SUBMISSION_BYTES);
    expect(aiTerminalSubmitSteps('codex', boundary + '\r')).toEqual([{write: boundary}, {waitMs: 150}, {write: '\r'}]);
    const long = boundary + '한';
    expect(aiTerminalSubmitSteps('codex', long + '\r')).toEqual([{write: long}, {waitMs: 750}, {write: '\r'}]);
    expect(aiTerminalSubmitSteps('claude', long + '\r')).toEqual([{write: long}, {waitMs: 40}, {write: '\r'}]);
  });

  test('keystrokes are never pasted: a menu choice typed as "1" + Enter still selects', () => {
    expect(aiTerminalSubmitSteps('codex', '\r', {bracketedPaste: true})).toEqual([{write: '\r'}]);
    expect(aiTerminalSubmitSteps('claude', '1', {bracketedPaste: true})).toEqual([{write: '1'}]);
    expect(aiTerminalSubmitSteps('claude', '1\r', {bracketedPaste: true})).toEqual([{write: '1'}, {waitMs: 40}, {write: '\r'}]);
    // A lone Ctrl+J stays a key, and Enters typed quickly in raw mode still submit.
    expect(aiTerminalSubmitSteps('codex', '\n', {bracketedPaste: true})).toEqual([{write: '\n'}]);
    expect(aiTerminalSubmitSteps('codex', 'y\rn\r', {bracketedPaste: true})).toEqual([{write: 'y\rn'}, {waitMs: 150}, {write: '\r'}]);
    expect(aiTerminalSubmitSteps('claude', '\x1b[A', {bracketedPaste: true})).toEqual([{write: '\x1b[A'}]);
  });

  test('multi-line text is one bracketed paste, then a separate Enter, when the CLI turned bracketed paste on', () => {
    for (const [agent, delay] of [['codex', 150], ['claude', 40], ['hermes', 40], ['agy', 40]] as const) {
      expect(aiTerminalSubmitSteps(agent, 'AgentsToZ 프로젝트 전달\n보낸 프로젝트: OPS\n\n작업\r', {bracketedPaste: true}))
        .toEqual([{write: PASTE('AgentsToZ 프로젝트 전달\r보낸 프로젝트: OPS\r\r작업')}, {waitMs: delay}, {write: '\r'}]);
    }
    // Same line breaks xterm.js sends for a paste: CRLF and LF both become CR inside the brackets.
    expect(aiTerminalSubmitSteps('claude', 'a\r\nb\nc\r', {bracketedPaste: true})[0]).toEqual({write: PASTE('a\rb\rc')});
  });

  test('without bracketed paste the bytes stay exactly as before', () => {
    expect(aiTerminalSubmitSteps('codex', 'a\nb\r', {bracketedPaste: false})).toEqual([{write: 'a\nb'}, {waitMs: 150}, {write: '\r'}]);
    expect(aiTerminalSubmitSteps('codex', 'a\nb\r')).toEqual([{write: 'a\nb'}, {waitMs: 150}, {write: '\r'}]);
    expect(aiTerminalSubmitSteps('claude', 'part one\npart two')).toEqual([{write: 'part one\npart two'}]);
  });

  test('a continuation part of a long message is its own paste and never submits early', () => {
    expect(aiTerminalSubmitSteps('codex', 'part one\npart two', {bracketedPaste: true})).toEqual([{write: PASTE('part one\rpart two')}]);
  });

  test('pasted text cannot end the paste early or be pasted twice', () => {
    // An embedded end marker would turn the rest of the text into keystrokes (and its line break into Enter).
    expect(aiTerminalBracketedPaste('x\x1b[201~rm -rf ~\ny')).toBe(PASTE('xrm -rf ~\ry'));
    expect(aiTerminalBracketedPaste('\x1b[200~a\nb')).toBe(PASTE('a\rb'));
    // xterm already bracketed a raw-mode paste (CR line breaks): it passes through untouched.
    expect(aiTerminalSubmitSteps('claude', PASTE('a\rb'), {bracketedPaste: true})).toEqual([{write: PASTE('a\rb')}]);
  });

  // Review L2 (2026-09-29): removing the markers in one pass could be defeated by nesting one inside
  // another — `\x1b[20` + `\x1b[201~` + `1~` becomes a fresh end marker once the inner one is gone, so
  // the paste ended early and the following line break acted as Enter.
  test('a nested paste marker cannot survive the strip and end the paste early', () => {
    const nested = 'safe\x1b[20\x1b[201~1~echo injected\nmore';
    const pasted = aiTerminalBracketedPaste(nested);
    const inner = pasted.slice('\x1b[200~'.length, -'\x1b[201~'.length);
    expect(inner).not.toContain('\x1b[201~');
    expect(inner).not.toContain('\x1b[200~');
    expect(pasted).toBe(PASTE('safeecho injected\rmore'));
    expect(aiTerminalBracketedPaste('\x1b[20\x1b[200~0~a\nb')).toBe(PASTE('a\rb'));
  });

  test('text carrying ESC is never wrapped, so the nested-marker string is typed exactly as sent', () => {
    const nested = 'safe\x1b[20\x1b[201~1~echo injected\nmore';
    expect(aiTerminalSubmitSteps('claude', nested + '\r', {bracketedPaste: true})).toEqual([{write: nested}, {waitMs: 40}, {write: '\r'}]);
    expect(aiTerminalSubmitSteps('codex', nested, {bracketedPaste: true})).toEqual([{write: nested}]);
  });
});

describe('splitting a submission for the 4 KiB wire limit', () => {
  test('short input is one part and keeps its bytes', () => {
    expect(splitTerminalSubmission('hello\r')).toEqual(['hello\r']);
    expect(splitTerminalSubmission('\r')).toEqual(['\r']);
    expect(splitTerminalSubmission('\x1b')).toEqual(['\x1b']);
  });

  test('the Enter never travels alone, so the paste-to-Enter delay still applies', () => {
    const body = 'a'.repeat(4096);
    expect(splitTerminalInput(body + '\r').at(-1)).toBe('\r');
    const parts = splitTerminalSubmission(body + '\r');
    expect(parts.join('')).toBe(body + '\r');
    expect(parts.at(-1)).toBe('a\r');
    for (const part of parts) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(4096);
  });

  test('a trailing line break moves together with a visible character', () => {
    const body = '한'.repeat(1364) + '\n\n\n\n';
    expect(Buffer.byteLength(body)).toBe(4096);
    const parts = splitTerminalSubmission(body + '\r');
    expect(parts.join('')).toBe(body + '\r');
    expect(parts.at(-1)).toBe('한\n\n\n\n\r');
    for (const part of parts) {
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(4096);
      expect(Buffer.byteLength(JSON.stringify(part)) - 2).toBeLessThanOrEqual(7500);
    }
  });

  test('emoji and Korean survive every split unchanged', () => {
    const text = ('한글😀\n').repeat(900) + '\r';
    const parts = splitTerminalSubmission(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(text);
    expect(parts.at(-1)!.length).toBeGreaterThan(1);
  });
});
