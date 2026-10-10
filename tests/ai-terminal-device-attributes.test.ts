import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { AiTerminalScreen, DEVICE_ATTRIBUTES_REPLY } from '../src/aiTerminalScreen';

// Antigravity (agy) sends CSI > c and draws nothing until it is answered. In a Workroom nobody answered:
// the viewer's xterm drops its own reply unless direct input is on (3호, 2026-10-07 — fine in Orca).
test('the host copy answers «what terminal are you», whether anyone is watching or not', async () => {
  const replies: string[] = [];
  const screen = new AiTerminalScreen(80, 24, undefined, data => replies.push(data));
  screen.write('\x1b[>c', 1);
  screen.write('\x1b[c', 2);
  await Bun.sleep(50);
  expect(replies.length).toBe(2);
  for (const reply of replies) expect(DEVICE_ATTRIBUTES_REPLY.test(reply)).toBe(true);
});

// Codex asks CSI 6 n on every resize and stops reading keys until it is answered (TestFlight 712, 2026-10-09);
// the host answers that too — tests/ai-terminal-cursor-position.test.ts covers it in full.
test('a cursor-position query is answered once, as a cursor-position reply, never as DA', async () => {
  const replies: string[] = [];
  const screen = new AiTerminalScreen(80, 24, undefined, data => replies.push(data));
  screen.write('\x1b[6n', 1);
  await Bun.sleep(50);
  expect(replies).toEqual(['\x1b[1;1R']);
  expect(DEVICE_ATTRIBUTES_REPLY.test('\x1b[1;5R')).toBe(false);
  expect(DEVICE_ATTRIBUTES_REPLY.test('a')).toBe(false);
});

test('the viewer drops its own DA reply so the program never gets two', () => {
  const panel = readFileSync(new URL('../src/AiTerminalPanel.tsx', import.meta.url), 'utf8');
  expect(panel).toContain('const acceptInput=(data:string)=>{if(DEVICE_ATTRIBUTES_REPLY.test(data))return;');
  // The browser panel must not import the server-only headless module (Vite answered 500 and the panel died).
  expect(panel).not.toContain("from './aiTerminalScreen'");
  expect(panel).toContain("from './aiTerminalDeviceAttributes'");
});
