import { expect, test } from 'bun:test';

import { resetWindowsPtyRuntimeCache, spawnWindowsPty, windowsPtyAvailable } from '../src/windowsPty';
import type { WindowsPtyHandle } from '../src/windowsPty';

const win32 = process.platform === 'win32';
const onWindows = win32 ? test : test.skip;

/** Collects PTY bytes the way the Workroom's `append` does. */
function collector() {
  const decoder = new TextDecoder();
  let text = '';
  let ended = false;
  return {
    get text() { return text; },
    get ended() { return ended; },
    terminal: {
      cols: 80,
      rows: 24,
      exit: () => { ended = true; },
      data: (_pty: WindowsPtyHandle, bytes: Uint8Array) => { text += decoder.decode(bytes, { stream: true }); },
    },
  };
}

const waitFor = async (predicate: () => boolean, budgetMs = 8000) => {
  const until = Date.now() + budgetMs;
  while (Date.now() < until && !predicate()) await Bun.sleep(50);
  return predicate();
};

test('availability is false off Windows and never throws', () => {
  resetWindowsPtyRuntimeCache();
  if (!win32) expect(windowsPtyAvailable()).toBe(false);
  else expect(typeof windowsPtyAvailable()).toBe('boolean');
});

onWindows('a real session carries output, input, resize and an exit code', async () => {
  // Bun has no Windows PTY of its own ("terminal option is not supported on
  // this platform"), so this is the only path a Windows Workroom session has.
  expect(windowsPtyAvailable()).toBe(true);
  const sink = collector();
  const child = spawnWindowsPty(['cmd.exe'], {
    cwd: process.cwd(),
    env: { ...process.env },
    terminal: sink.terminal,
  });

  expect(child.pid).toBeGreaterThan(0);
  expect(await waitFor(() => sink.text.length > 0)).toBe(true);

  // Input is the part that does not work through node-pty's own socket: it
  // wraps the conin descriptor in net.Socket({fd}), which throws
  // ERR_SOCKET_CLOSED under Bun while still reporting writable. A returned echo
  // is the proof that the fs.writeSync path reaches the child.
  const marker = `AGENTSTOZ_PTY_${Math.random().toString(36).slice(2, 10)}`;
  expect(child.terminal.write(`echo ${marker}\r`)).toBeGreaterThan(0);
  expect(await waitFor(() => sink.text.includes(marker))).toBe(true);

  child.terminal.resize(100, 30);

  child.terminal.write('exit\r');
  const code = await Promise.race([child.exited, Bun.sleep(8000).then(() => 'timeout' as const)]);
  expect(code).toBe(0);
  // The Workroom drains the screen after exit, so the stream end must be
  // signalled as well as the exit code resolved.
  expect(await waitFor(() => sink.ended)).toBe(true);
  child.terminal.close();
});

onWindows('close is idempotent and writes after it are refused, not thrown', async () => {
  const sink = collector();
  const child = spawnWindowsPty(['cmd.exe'], {
    cwd: process.cwd(),
    env: { ...process.env },
    terminal: sink.terminal,
  });
  await waitFor(() => sink.text.length > 0);

  child.terminal.close();
  child.terminal.close();
  // The Workroom closes the terminal from both its exit handler and its
  // shutdown sweep, and a keystroke can race either; neither may throw.
  expect(child.terminal.write('echo late\r')).toBe(0);
  child.terminal.resize(120, 40);
  await Promise.race([child.exited, Bun.sleep(5000)]);
});

onWindows('the tree kill stops a session the Workroom signals', async () => {
  const sink = collector();
  const child = spawnWindowsPty(['cmd.exe'], {
    cwd: process.cwd(),
    env: { ...process.env },
    terminal: sink.terminal,
  });
  await waitFor(() => sink.text.length > 0);
  child.kill('SIGKILL');
  const code = await Promise.race([child.exited, Bun.sleep(8000).then(() => 'timeout' as const)]);
  expect(code).not.toBe('timeout');
});
