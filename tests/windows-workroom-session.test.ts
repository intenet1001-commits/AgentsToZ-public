import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AiTerminalService } from '../src/aiTerminalService';
import { normalizeAiTerminalResponse, type AiTerminalRequest } from '../src/aiTerminalProtocol';

/**
 * The Workroom driven end to end on Windows, through the real service.
 *
 * `tests/ai-terminal.test.ts` covers the service's logic with POSIX shell fake
 * CLIs that Windows cannot execute at all (CreateProcess error 193), so its
 * cases are skipped there. This file is the Windows half: a `.cmd` fake CLI, no
 * injected spawn, so the start goes through `spawnWindowsPty` and ConPTY exactly
 * as a real session does.
 */
const onWindows = process.platform === 'win32' ? test : test.skip;

const services: AiTerminalService[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(s => s.shutdown()));
  for (const dir of dirs.splice(0)) {
    // A ConPTY teardown can still hold a handle under the directory for a moment.
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { await Bun.sleep(150); }
    }
  }
});

const targetId = 'windows-workroom-fixture';
const req = (r: Omit<AiTerminalRequest, 'requestId'>): AiTerminalRequest => ({ ...r, requestId: crypto.randomUUID() });

/** A fake CLI Windows can actually run: echoes a banner, then each line back. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agentstoz-winpty-'));
  dirs.push(dir);
  const executable = join(dir, 'cli.cmd');
  writeFileSync(executable, [
    '@echo off',
    'echo READY:%CD%',
    ':loop',
    'set "line="',
    'set /p line=',
    'if not defined line goto loop',
    'if "%line%"=="quit" exit /b 0',
    'echo GOT:%line%',
    'goto loop',
    '',
  ].join('\r\n'));
  const service = new AiTerminalService({
    resolveTarget: async id => { if (id !== targetId) throw new Error('unregistered'); return { cwd: dir }; },
    executable: () => executable,
  });
  services.push(service);
  return { service, dir, executable };
}

async function output(service: AiTerminalService, id: string, contains: string, budgetMs = 10_000) {
  const deadline = Date.now() + budgetMs;
  let text = '';
  let cursor = 0;
  while (Date.now() < deadline) {
    const r = await service.perform(req({ operation: 'read', sessionId: id, after: cursor }));
    normalizeAiTerminalResponse(r);
    for (const chunk of r.chunks ?? []) { text += chunk.text; cursor = chunk.seq; }
    if (text.includes(contains)) return text;
    await Bun.sleep(25);
  }
  throw new Error(`missing output ${contains}: ${JSON.stringify(text.slice(-400))}`);
}

onWindows('a session starts in its registered cwd, takes input, resizes and exits', async () => {
  const { service, dir } = fixture();
  const started = await service.perform(req({ operation: 'start', targetId, agent: 'codex', cols: 80, rows: 24 }));
  const id = started.session!.id;
  expect(started.session!.state).toBe('running');

  // The cwd the CLI reports is the registered folder, not the sidecar's.
  const banner = await output(service, id, 'READY:');
  expect(banner.toLowerCase()).toContain(dir.toLowerCase());

  await service.perform(req({ operation: 'input', sessionId: id, data: 'hello-workroom\r' }));
  expect(await output(service, id, 'GOT:hello-workroom')).toContain('GOT:hello-workroom');

  await service.perform(req({ operation: 'resize', sessionId: id, cols: 100, rows: 30 }));
  const listed = await service.perform(req({ operation: 'list' }));
  const summary = listed.sessions!.find(s => s.id === id)!;
  expect(summary.cols).toBe(100);
  expect(summary.rows).toBe(30);

  await service.perform(req({ operation: 'input', sessionId: id, data: 'quit\r' }));
  const deadline = Date.now() + 10_000;
  let state = 'running';
  while (Date.now() < deadline && state === 'running') {
    const now = await service.perform(req({ operation: 'list' }));
    state = now.sessions!.find(s => s.id === id)?.state ?? 'exited';
    if (state === 'running') await Bun.sleep(50);
  }
  expect(state).toBe('exited');
});

onWindows('「다시 시작」 closes the old CLI and opens a new one', async () => {
  const { service } = fixture();
  const first = await service.perform(req({ operation: 'start', targetId, agent: 'codex', cols: 80, rows: 24 }));
  const firstId = first.session!.id;
  await output(service, firstId, 'READY:');

  // restart = start + resumeFrom. This fake CLI has no saved Codex rollout, so
  // nothing can be continued and the host must open a fresh conversation rather
  // than resume an empty one -- a CLI asked to resume nothing exits at once,
  // which would turn a live session into a dead one.
  const again = await service.perform(req({
    operation: 'start', targetId, agent: 'codex', cols: 80, rows: 24, resumeFrom: firstId,
  }));
  expect(again.session!.id).not.toBe(firstId);
  expect(again.session!.state).toBe('running');
  expect(again.resumed).toBe(false);
  await output(service, again.session!.id, 'READY:');

  // The replaced session is closed, not left running beside its replacement.
  const listed = await service.perform(req({ operation: 'list' }));
  expect(listed.sessions!.find(s => s.id === firstId)?.state ?? 'exited').not.toBe('running');
});

onWindows('close ends the session and its tree', async () => {
  const { service } = fixture();
  const started = await service.perform(req({ operation: 'start', targetId, agent: 'codex', cols: 80, rows: 24 }));
  const id = started.session!.id;
  await output(service, id, 'READY:');

  // Termination goes through the service's SIGTERM-then-SIGKILL escalation,
  // which on Windows is `taskkill /T` -- a POSIX process-group signal would
  // throw there and leave the CLI's own children running.
  await service.perform(req({ operation: 'close', sessionId: id, memoryPolicy: 'skip' }));
  const listed = await service.perform(req({ operation: 'list' }));
  expect(listed.sessions!.find(s => s.id === id)?.state ?? 'exited').not.toBe('running');
});
