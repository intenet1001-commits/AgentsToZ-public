import {describe, expect, test} from 'bun:test';
import {
  WORKROOM_KEY_NAMES,
  WORKROOM_KEYS_MAX,
  WORKROOM_WAIT_LIMITS,
  normalizeWorkroomKeys,
  waitForWorkroomSettle,
  workroomKeySequence,
} from '../src/workroomOrchestration';
import {keepTailUtf8, renderTerminalPlainText, stripTerminalControls} from '../src/terminalPlainText';

describe('send_workroom_keys allow-list', () => {
  test('maps every allowed key to the bytes a real terminal sends', () => {
    const normal = Object.fromEntries(WORKROOM_KEY_NAMES.map(key => [key, workroomKeySequence(key)]));
    // Deliberate change (review 2026-09-29, finding 9): shift-tab is no longer allowed, because in
    // Claude Code it cycles permission modes. It used to map to '\x1b[Z' here.
    expect(normal).toEqual({
      enter: '\r', esc: '\x1b', tab: '\t',
      up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
      space: ' ', backspace: '\x7f', 'ctrl-c': '\x03',
      1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', y: 'y', n: 'n',
    });
  });

  test('arrow keys follow the application cursor keys mode of the driven CLI', () => {
    const app = {applicationCursorKeys: true};
    expect(['up', 'down', 'right', 'left'].map(key => workroomKeySequence(key as any, app)))
      .toEqual(['\x1bOA', '\x1bOB', '\x1bOC', '\x1bOD']);
    // Only the four arrows change; Enter, Esc and Tab never do.
    expect(workroomKeySequence('enter', app)).toBe('\r');
    expect(workroomKeySequence('esc', app)).toBe('\x1b');
    expect(workroomKeySequence('tab', app)).toBe('\t');
  });

  test('rejects anything outside the allow-list instead of typing it', () => {
    expect(normalizeWorkroomKeys(['1', 'down', 'enter', 'y'])).toEqual(['1', 'down', 'enter', 'y']);
    for (const keys of [[], Array(WORKROOM_KEYS_MAX + 1).fill('enter'), 'enter', [''], ['0'], ['Y'], ['ENTER'],
      ['F1'], ['ctrl-d'], ['shift-tab'], ['rm -rf /'], ['\x1b[A'], ['enter\r'], [1], [null]]) {
      expect(() => normalizeWorkroomKeys(keys)).toThrow();
    }
  });
});

describe('wait_workroom_session semantics', () => {
  function clock() {
    let now = 10_000;
    const sleeps: number[] = [];
    return {now: () => now, advance: (ms: number) => { now += ms; }, sleeps,
      sleep: async (ms: number) => { sleeps.push(ms); now += ms; }};
  }

  test('quiet is measured from the later of the last output and the start of the wait', async () => {
    const c = clock();
    // The last output is old, but a wait that returns at once would race the CLI's reaction.
    const result = await waitForWorkroomSettle({probe: () => ({state: 'running', lastOutputAt: 1_000}), idleMs: 4_000, timeoutMs: 30_000, now: c.now, sleep: c.sleep});
    expect(result).toEqual({reason: 'idle', waitedMs: 4_000});
  });

  test('new output restarts the quiet window', async () => {
    const c = clock();
    const started = c.now();
    let lastOutputAt: number | null = null;
    const probe = () => {
      const elapsed = c.now() - started;
      if (elapsed >= 1_000 && elapsed < 3_000) lastOutputAt = c.now(); // the CLI prints for two seconds
      return {state: 'running' as const, lastOutputAt};
    };
    const result = await waitForWorkroomSettle({probe, idleMs: 2_000, timeoutMs: 30_000, now: c.now, sleep: c.sleep, pollMs: 200});
    expect(result.reason).toBe('idle');
    expect(result.waitedMs).toBeGreaterThanOrEqual(4_800);
    expect(result.waitedMs).toBeLessThanOrEqual(5_000);
  });

  test('an exited session returns immediately and continuous output ends at the timeout', async () => {
    const exited = clock();
    expect(await waitForWorkroomSettle({probe: () => ({state: 'exited', lastOutputAt: exited.now()}), idleMs: 4_000, timeoutMs: 30_000, now: exited.now, sleep: exited.sleep}))
      .toEqual({reason: 'exited', waitedMs: 0});
    expect(exited.sleeps).toEqual([]);
    const busy = clock();
    const result = await waitForWorkroomSettle({probe: () => ({state: 'running', lastOutputAt: busy.now()}), idleMs: 4_000, timeoutMs: 10_000, now: busy.now, sleep: busy.sleep});
    expect(result).toEqual({reason: 'timeout', waitedMs: 10_000});
    expect(Math.max(...busy.sleeps)).toBeLessThanOrEqual(1_000);
  });

  test('limits are the documented tool bounds', () => {
    expect(WORKROOM_WAIT_LIMITS).toEqual({idleMs: {default: 4_000, min: 1_000, max: 20_000}, timeoutMs: {default: 30_000, min: 1_000, max: 50_000}});
  });
});

describe('Workroom tail text', () => {
  test('renders escape sequences, carriage-return redraws and cursor-up frames like a terminal', async () => {
    const frame = (label: string) => `\x1b[2K\x1b[1A\x1b[2K\x1b[G╭ ${label}\r\n╰ esc to interrupt`;
    const raw = '\x1b]0;title\x07\x1b[1;32mREADY\x1b[0m:codex\r\nprogress 10%\rprogress 99%\r\n'
      + '╭ first\r\n╰ esc to interrupt' + frame('second') + frame('third') + '\r\n\x1b[?2004hdone\x1b[K';
    const text = await renderTerminalPlainText(raw, 60, 10);
    expect(text).toBe('READY:codex\nprogress 99%\n╭ third\n╰ esc to interrupt\ndone');
    expect(text).not.toContain('\x1b');
  });

  test('joins soft-wrapped rows and keeps wide characters', async () => {
    const long = '가'.repeat(15) + 'END';
    expect(await renderTerminalPlainText(`${long}\r\nnext`, 20, 5)).toBe(`${long}\nnext`);
  });

  test('the plain fallback removes controls without a terminal', () => {
    // Backspace and a bare carriage return overwrite, as they would on a screen.
    expect(stripTerminalControls('\x1b[31mred\x1b[0m\r\n\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\\x07\x08!\r\nbar\rbaz'))
      .toBe('red\nlin!\nbaz');
  });

  test('keeps whole trailing lines within the UTF-8 byte budget', () => {
    const text = ['첫째 줄', 'second line', '마지막'].join('\n');
    expect(keepTailUtf8(text, 1_000)).toEqual({text, cut: false});
    const cut = keepTailUtf8(text, new TextEncoder().encode('second line\n마지막').length);
    expect(cut).toEqual({text: 'second line\n마지막', cut: true});
    const single = keepTailUtf8('한'.repeat(10), 9);
    expect(single).toEqual({text: '한한한', cut: true});
  });
});
