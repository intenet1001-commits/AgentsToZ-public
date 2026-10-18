import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService} from '../src/aiTerminalService';
import {dropPartialTerminalPrefix, incompleteEscapeSuffix} from '../src/terminalPlainText';

// A fully scripted PTY: the test decides every output chunk, so chunk boundaries (1,024
// characters per append) are deterministic, and no real process or process group is touched.
// There is no line discipline, so the scripted output uses CRLF like a real PTY's onlcr does.
type FakeChild = {pid: number; env: Record<string, string | undefined>; emit(text: string): void; exit(code: number): void; writes: string[]};
const services: AiTerminalService[] = [], dirs: string[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.shutdown()));
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
const targetId = 'project-fixture-123';

function fakeService() {
  const dir = mkdtempSync(join(tmpdir(), 'agentstoz-fake-pty-')); dirs.push(dir);
  const children: FakeChild[] = [];
  let nextPid = 4_000_000;
  const spawn = (_args: string[], options: any) => {
    let settle!: (code: number) => void;
    const exited = new Promise<number>(resolve => { settle = resolve; });
    const writes: string[] = [];
    const control: FakeChild = {
      pid: ++nextPid, env: options.env, writes,
      emit: text => options.terminal.data(null, new TextEncoder().encode(text)),
      exit: code => { options.terminal.exit?.(); settle(code); },
    };
    children.push(control);
    return {pid: control.pid, exited, kill: () => control.exit(143),
      terminal: {write: (data: string) => { writes.push(data); return data.length; }, resize() {}, close() {}}};
  };
  const service = new AiTerminalService({
    resolveTarget: async id => { if (id !== targetId) throw new Error('unregistered'); return {cwd: dir}; },
    executable: () => '/bin/sh',
    spawn: spawn as any,
    // Never signal a real process group with a made-up pid.
    signalGroup: (pid, _signal) => children.find(child => child.pid === pid)?.exit(143),
  });
  services.push(service);
  const start = async () => {
    const session = (await service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId, agent: 'codex', cols: 80, rows: 24})).session!;
    return {session, child: children.at(-1)!};
  };
  const exited = async (id: string) => {
    for (const deadline = Date.now() + 3_000; Date.now() < deadline; await Bun.sleep(5)) {
      const listed = await service.perform({operation: 'list', requestId: crypto.randomUUID()});
      const found = listed.sessions!.find(session => session.id === id);
      if (!found || found.state === 'exited') return;
    }
    throw new Error(`session ${id} did not exit`);
  };
  return {service, start, exited};
}

describe('B7: a tail never starts in the middle of an escape sequence', () => {
  test('pure helpers find an unfinished escape and drop a partial prefix', () => {
    expect(incompleteEscapeSuffix('PART1 \x1b[38;2;2')).toBe('\x1b[38;2;2');
    expect(incompleteEscapeSuffix('title \x1b]0;my ti')).toBe('\x1b]0;my ti');
    expect(incompleteEscapeSuffix('done \x1b]0;title\x07')).toBe('');
    expect(incompleteEscapeSuffix('done \x1b]0;title\x1b\\')).toBe('');
    expect(incompleteEscapeSuffix('plain\x1b[0m')).toBe('');
    expect(incompleteEscapeSuffix('lone \x1b')).toBe('\x1b');
    expect(incompleteEscapeSuffix('no escape at all')).toBe('');
    expect(dropPartialTerminalPrefix('55;255;255mX\x1b[0mrest\nnext')).toBe('\x1b[0mrest\nnext');
    expect(dropPartialTerminalPrefix('tial line\nnext')).toBe('next');
    expect(dropPartialTerminalPrefix('no boundary')).toBe('no boundary');
  });

  test('a window cut by the raw budget drops its partial first sequence', async () => {
    const {service, start} = fakeService();
    const {session, child} = await start();
    const unit = '\x1b[38;2;255;255;255mX';
    child.emit('HEAD\r\n');
    child.emit(unit.repeat(3_000)); // 60,000 characters: 1,024-character chunks cut it mid-sequence
    child.emit('\x1b[0m\r\nTAIL\r\n');
    const tail = await service.outputTail(session.id, targetId);
    expect(tail.truncated).toBe(true);
    const [first, ...rest] = tail.text.split('\n');
    expect(first).toMatch(/^X+$/);
    expect(rest).toEqual(['TAIL']);
  });

  test('a cursor that split a sequence keeps the new text and repairs the sequence from the older chunk', async () => {
    const {service, start} = fakeService();
    const {session, child} = await start();
    child.emit('BEGIN\r\n');
    child.emit('PART1 \x1b[38;2;2');
    const cut = service.inspectSession(session.id, targetId).outputCursor;
    child.emit('55;255;255mRED\x1b[0m\r\n');
    child.emit('\x1b]0;my ti');
    const titled = service.inspectSession(session.id, targetId).outputCursor;
    child.emit('tle\x07TITLED\r\n');
    expect((await service.outputTail(session.id, targetId, cut)).text).toBe('RED\nTITLED');
    expect((await service.outputTail(session.id, targetId, titled)).text).toBe('TITLED');
    // A cursor after a complete line starts cleanly, as before.
    expect((await service.outputTail(session.id, targetId, 1)).text).toBe('PART1 RED\nTITLED');
  });
});

describe('B11: an exited session pruned from the live list keeps its last output', () => {
  test('retired sessions answer activity, tail and stream reads as exited, and stay bounded', async () => {
    const {service, start, exited} = fakeService();
    const {session, child} = await start();
    child.emit('LAST-WORDS\r\n');
    child.exit(0);
    await exited(session.id);
    // More than 24 sessions prune the oldest exited ones on the next start.
    for (let index = 0; index < 25; index++) {
      const filler = await start();
      filler.child.exit(0);
      await exited(filler.session.id);
    }
    const listed = await service.perform({operation: 'list', requestId: crypto.randomUUID()});
    expect(listed.sessions!.some(candidate => candidate.id === session.id)).toBe(false);
    expect(service.retiredSession(session.id)).toMatchObject({id: session.id, targetId, state: 'exited', exitCode: 0});
    const activity = service.sessionActivity(session.id, targetId);
    expect(activity).toMatchObject({id: session.id, state: 'exited', exitCode: 0});
    expect(typeof activity.lastOutputAt).toBe('number');
    expect(await service.outputTail(session.id, targetId)).toMatchObject({text: 'LAST-WORDS', truncated: false});
    expect(await service.screenText(session.id, targetId)).toBeNull();
    const page = service.retainedOutputPage(session.id, targetId, 0);
    expect(page.chunks.map(chunk => chunk.text).join('')).toContain('LAST-WORDS');
    expect(() => service.sessionActivity(session.id, 'another-target-1234')).toThrow();
    // The live-only inspection stays strict.
    expect(() => service.inspectSession(session.id, targetId)).toThrow();
    // Retired records are bounded: enough further prunes forget the oldest.
    for (let index = 0; index < 40; index++) {
      const filler = await start();
      filler.child.exit(0);
      await exited(filler.session.id);
    }
    expect(service.retiredSession(session.id)).toBeNull();
    expect(() => service.sessionActivity(session.id, targetId)).toThrow();
  }, 30_000);
});

describe('B2: the service can name the running session a process belongs to', () => {
  test('the CLI environment names its session, and its pid (group leader) maps to it only while running', async () => {
    const {service, start, exited} = fakeService();
    const {session, child} = await start();
    expect(child.env.AGENTSTOZ_WORKROOM_SESSION_ID).toBe(session.id);
    expect(child.env.AGENTSTOZ_WORKROOM_TARGET_ID).toBe(targetId);
    expect(service.sessionForProcesses([1234, child.pid])).toMatchObject({id: session.id, targetId, agent: 'codex', state: 'running'});
    expect(service.sessionForProcesses([1234, 5678])).toBeNull();
    expect(service.runningSession(session.id)).toMatchObject({id: session.id, state: 'running'});
    child.exit(0);
    await exited(session.id);
    expect(service.sessionForProcesses([child.pid])).toBeNull();
    expect(service.runningSession(session.id)).toBeNull();
  });
});
