import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HelpdeskAssistHost, type AssistVerifier} from '../src/helpdeskAssistHost';
import {HelpdeskAssistStore} from '../src/helpdeskAssistStore';
import type {AssistBrowserDriver} from '../src/helpdeskAssistBrowser';
import type {AssistService} from '../src/helpdeskAssistProtocol';

function gate() {
  let release!: () => void, enter!: () => void;
  const pending = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { enter = r; });
  return {entered, release, async wait() { enter(); await pending; }};
}

const fixtures: {host: HelpdeskAssistHost; directory: string}[] = [];
afterEach(() => {
  for (const {host, directory} of fixtures.splice(0)) {
    host.shutdown();
    rmSync(directory, {recursive: true, force: true});
  }
});

async function fixture(options: {
  service?: AssistService;
  finish?: () => Promise<void>;
  handOff?: () => Promise<void>;
  verify?: AssistVerifier;
  now?: () => number;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'atz-assist-controls-'));
  const store = new HelpdeskAssistStore(directory);
  let takeBacks = 0;
  const driver: AssistBrowserDriver = {
    kind: 'ego', ready: async () => ({available: true}), attach: async () => ({}),
    navigate: async () => ({state: 'confirmed'}), location: async () => null,
    observe: async () => ({title: '', elements: [], secret: false, truncated: false}),
    click: async () => ({state: 'refused'}), fill: async () => ({state: 'refused'}),
    reviewed: async () => {}, settle: async () => 'agent',
    handOff: options.handOff ?? (async () => {}),
    takeBack: async () => { takeBacks++; return 'agent'; },
    finish: options.finish ?? (async () => {}),
  };
  const host = new HelpdeskAssistHost({store, drivers: {ego: () => driver, agentstoz: () => driver},
    verify: options.verify ?? (async () => ({state: 'unknown'})), now: options.now});
  fixtures.push({host, directory});
  const prepared = await host.handle({operation: 'assist-prepare', requestId: 'control-race-request', intent: {
    service: options.service ?? 'google-workspace', goal: 'connect', stage: 'setup',
    origin: 'helpdesk-gws', scope: {kind: 'account-add'},
  }});
  const id = prepared.run!.id;
  const current = () => store.get(id)!;
  const send = (operation: string) => host.handle({operation, runId: id, expectedRevision: current().revision});
  await host.handle({operation: 'assist-start', runId: id, expectedRevision: prepared.revision,
    browser: 'ego', ai: 'none', scopeConfirmed: true});
  return {host, store, id, current, send, takeBacks: () => takeBacks};
}

describe('helpdesk control transitions before asynchronous browser cleanup', () => {
  test('cancellation is terminal while finish waits, so advance cannot defeat cancellation', async () => {
    const finish = gate(), f = await fixture({finish: finish.wait});
    const generation = f.current().generation;
    const cancellation = f.send('assist-cancel');
    await finish.entered;
    try {
      expect(f.current().state).toBe('cancelled');
      expect(f.current().generation).toBeGreaterThan(generation);
      await expect(f.send('assist-advance')).rejects.toThrow();
    } finally { finish.release(); await cancellation.catch(() => {}); }
    expect((await cancellation).run!.state).toBe('cancelled');
    expect(f.current().state).toBe('cancelled');
  });

  test('pause is stored before handoff and resume waits for the old handoff to finish', async () => {
    const handOff = gate(), f = await fixture({handOff: handOff.wait});
    const generation = f.current().generation;
    const pause = f.send('assist-pause');
    await handOff.entered;
    try {
      expect(f.current().state).toBe('paused');
      expect(f.current().generation).toBeGreaterThan(generation);
      await expect(f.send('assist-resume')).rejects.toThrow('정리');
      await expect(f.send('assist-advance')).rejects.toThrow();
      expect(f.takeBacks()).toBe(0);
    } finally { handOff.release(); await pause.catch(() => {}); }
    expect((await pause).run!.state).toBe('paused');
    expect((await f.send('assist-resume')).run!.state).toBe('assisting');
    expect(f.takeBacks()).toBe(1);
  });

  test('cancel can supersede pause but its finish cannot overtake the previous handoff', async () => {
    const handOff = gate(), actions: string[] = [];
    const f = await fixture({handOff: async () => { actions.push('handoff'); await handOff.wait(); actions.push('handed-off'); },
      finish: async () => { actions.push('finish'); }});
    const pause = f.send('assist-pause');
    await handOff.entered;
    const cancellation = f.send('assist-cancel');
    try {
      expect(f.current().state).toBe('cancelled');
      expect(actions).toEqual(['handoff']);
    } finally { handOff.release(); await Promise.allSettled([pause, cancellation]); }
    expect((await cancellation).run!.state).toBe('cancelled');
    expect((await pause).run!.state).toBe('cancelled');
    expect(actions).toEqual(['handoff', 'handed-off', 'finish']);
  });

  test('heartbeat handoff also blocks resuming into a lease that the old handoff can revoke', async () => {
    const handOff = gate(); let now = Date.now();
    const f = await fixture({handOff: handOff.wait, now: () => now});
    const generation = f.current().generation;
    now += 61_000;
    await f.host.handle({operation: 'assist-status', runId: f.id});
    await handOff.entered;
    try {
      expect(f.current().state).toBe('paused');
      expect(f.current().generation).toBeGreaterThan(generation);
      await expect(f.send('assist-resume')).rejects.toThrow('정리');
      expect(f.takeBacks()).toBe(0);
    } finally { handOff.release(); }
  });

  test('guide completion is committed before waiting for finish', async () => {
    const finish = gate(), f = await fixture({service: 'agy', finish: finish.wait});
    await f.send('assist-advance'); // The entry guide asks the person to continue.
    await f.send('assist-human-done');
    const completion = f.send('assist-advance');
    await finish.entered;
    try {
      expect(f.current().state).toBe('completed');
      await expect(f.send('assist-cancel')).rejects.toThrow();
    } finally { finish.release(); await completion.catch(() => {}); }
    expect((await completion).run!.state).toBe('completed');
  });

  test('a cancelled initial check does not begin more provider checks after its pending result arrives', async () => {
    const verifier = gate(), calls: string[] = [];
    const f = await fixture({verify: async id => { calls.push(id); await verifier.wait(); return {state: 'unknown'}; }});
    const advance = f.send('assist-advance');
    await verifier.entered;
    await f.send('assist-cancel');
    verifier.release();
    expect((await advance).run!.state).toBe('cancelled');
    expect(calls).toHaveLength(1);
  });
});
