import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyAgentsToZPrompt, createAgentsToZPromptCopier } from '../src/whatISaidPromptOriginClient';
import { canRegisterWhatISaidPromptOrigin, WHAT_I_SAID_PROMPT_ORIGIN_MAX_BYTES } from '../src/whatISaidPromptOriginPolicy';
import { WhatISaidPromptOriginRegistry } from '../src/whatISaidPromptOriginRegistry';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

const tick = () => Bun.sleep(0);
let originalNavigator: PropertyDescriptor | undefined;
let originalWindow: PropertyDescriptor | undefined;
let originalFetch: typeof fetch;
let writes: string[];

function setClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText } },
  });
}

function restoreGlobal(name: 'navigator' | 'window', original: PropertyDescriptor | undefined): void {
  if (original) Object.defineProperty(globalThis, name, original);
  else Reflect.deleteProperty(globalThis, name);
}

function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = handler as typeof fetch;
}

beforeEach(() => {
  originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  originalFetch = globalThis.fetch;
  Reflect.deleteProperty(globalThis, 'window');
  writes = [];
  setClipboard(async (text) => { writes.push(text); });
});

afterEach(() => {
  restoreGlobal('navigator', originalNavigator);
  restoreGlobal('window', originalWindow);
  globalThis.fetch = originalFetch;
});

describe('clipboard completion and bounded provenance queue', () => {
  test('waits for the actual clipboard write before completing or registering', async () => {
    const written = deferred<void>();
    const registered: string[] = [];
    setClipboard(() => written.promise);
    const copy = createAgentsToZPromptCopier({ register: async (text) => { registered.push(text); } });
    let completed = false;
    const result = copy('synthetic pending write').then(() => { completed = true; });
    await tick();
    expect(completed).toBe(false);
    expect(registered).toEqual([]);
    written.resolve();
    await result;
    expect(completed).toBe(true);
    expect(registered).toEqual(['synthetic pending write']);
  });

  test('propagates the original clipboard rejection and never registers it', async () => {
    const failure = new Error('synthetic clipboard refusal');
    let registrations = 0;
    setClipboard(async () => { throw failure; });
    const copy = createAgentsToZPromptCopier({ register: async () => { registrations += 1; } });
    expect(await copy('not copied').catch((error: unknown) => error)).toBe(failure);
    expect(registrations).toBe(0);
  });

  test('reports unavailable clipboard accurately', async () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    const copy = createAgentsToZPromptCopier({ register: async () => { throw new Error('must not run'); } });
    await expect(copy('not copied')).rejects.toThrow('Clipboard unavailable');
  });

  test('stalled provenance allows subsequent copies with only the latest pending registration', async () => {
    const first = deferred<void>();
    const latest = deferred<void>();
    const registered: string[] = [];
    let active = 0;
    let maxActive = 0;
    const copy = createAgentsToZPromptCopier({
      register: async (text) => {
        registered.push(text);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try { await (registered.length === 1 ? first.promise : latest.promise); }
        finally { active -= 1; }
      },
    });
    await copy('first');
    for (let index = 0; index < 1_000; index += 1) await copy(`pending ${index}`);
    expect(writes.length).toBe(1_001);
    expect(registered).toEqual(['first']);
    first.resolve();
    await tick();
    expect(registered).toEqual(['first', 'pending 999']);
    expect(maxActive).toBe(1);
    latest.resolve();
    await tick();
  });

  test('a rejected registration drains the latest pending copy without rejecting clipboard success', async () => {
    const first = deferred<void>();
    const registered: string[] = [];
    const copy = createAgentsToZPromptCopier({ register: async (text) => {
      registered.push(text);
      if (registered.length === 1) await first.promise;
    } });
    await copy('first');
    await copy('latest');
    first.reject(new Error('synthetic unavailable sidecar'));
    await tick();
    expect(registered).toEqual(['first', 'latest']);
  });

  test('copies unsupported provenance values exactly, without retaining or registering them', async () => {
    const first = deferred<void>();
    const registered: string[] = [];
    const copy = createAgentsToZPromptCopier({ register: async (text) => {
      registered.push(text);
      if (registered.length === 1) await first.promise;
    } });
    const unsupported = ['', '  \n ', 'nul\0text', 'x'.repeat(WHAT_I_SAID_PROMPT_ORIGIN_MAX_BYTES + 1)];
    await copy('first');
    await copy('valid pending');
    for (const value of unsupported) await copy(value);
    expect(writes).toEqual(['first', 'valid pending', ...unsupported]);
    first.resolve();
    await tick();
    expect(registered).toEqual(['first', 'valid pending']);
  });
});

describe('real transport branches with synthetic clipboard and transport mocks', () => {
  test('public helper resolves after clipboard even when the web request has not settled', async () => {
    const response = deferred<Response>();
    let requested = false;
    mockFetch(async () => { requested = true; return response.promise; });
    await copyAgentsToZPrompt('synthetic public contract');
    expect(writes).toEqual(['synthetic public contract']);
    expect(requested).toBe(true);
    response.resolve(new Response(null, { status: 204 }));
    await tick();
  });

  test('aborts a stalled web request and starts the latest queued registration after actual rejection', async () => {
    const signals: AbortSignal[] = [];
    const submitted: string[] = [];
    mockFetch(async (input, init) => {
      expect(input).toBe('/api/what-i-said/prompt-origin/register');
      expect(init?.method).toBe('POST');
      expect(init?.cache).toBe('no-store');
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      submitted.push((JSON.parse(String(init?.body)) as { prompt: string }).prompt);
      if (signals.length > 1) return new Response(null, { status: 204 });
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const copy = createAgentsToZPromptCopier({ webTimeoutMs: 15 });
    await copy('first');
    await copy('intermediate');
    await copy('latest');
    expect(submitted).toEqual(['first']);
    await Bun.sleep(40);
    expect(signals[0]?.aborted).toBe(true);
    expect(submitted).toEqual(['first', 'latest']);
    expect(signals[1]?.aborted).toBe(false);
  });

  test('does not free the web slot on a timer when a transport ignores abort', async () => {
    const first = deferred<Response>();
    const submitted: string[] = [];
    let firstSignal: AbortSignal | undefined;
    mockFetch(async (_input, init) => {
      submitted.push((JSON.parse(String(init?.body)) as { prompt: string }).prompt);
      if (submitted.length === 1) {
        firstSignal = init?.signal as AbortSignal;
        return first.promise;
      }
      return new Response(null, { status: 204 });
    });
    const copy = createAgentsToZPromptCopier({ webTimeoutMs: 10 });
    await copy('first');
    await Bun.sleep(25);
    for (let index = 0; index < 30; index += 1) await copy(`later ${index}`);
    expect(firstSignal?.aborted).toBe(true);
    expect(submitted).toEqual(['first']);
    first.resolve(new Response(null, { status: 204 }));
    await tick();
    expect(submitted).toEqual(['first', 'later 29']);
  });

  test('disposes response bodies and clears the timer even for an unsuccessful HTTP status', async () => {
    let cancelled = false;
    let signal: AbortSignal | undefined;
    mockFetch(async (_input, init) => {
      signal = init?.signal as AbortSignal;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
    });
    await createAgentsToZPromptCopier({ webTimeoutMs: 10 })('synthetic copy');
    await Bun.sleep(25);
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(false);
  });

  test('holds the native slot until actual invoke completion, regardless of the web timeout', async () => {
    const first = deferred<unknown>();
    const submitted: string[] = [];
    let active = 0;
    let maxActive = 0;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke: async (command: string, args: { path: string; method: string; body: { prompt: string } }) => {
        expect(command).toBe('what_i_said_management_request');
        expect(args.path).toBe('/api/what-i-said/prompt-origin/register');
        expect(args.method).toBe('POST');
        submitted.push(args.body.prompt);
        active += 1;
        maxActive = Math.max(active, maxActive);
        try { if (submitted.length === 1) await first.promise; }
        finally { active -= 1; }
      } } },
    });
    mockFetch(async () => { throw new Error('web transport must not run'); });
    const copy = createAgentsToZPromptCopier({ webTimeoutMs: 10 });
    await copy('native first');
    await Bun.sleep(25);
    for (let index = 0; index < 100; index += 1) await copy(`native pending ${index}`);
    expect(writes.length).toBe(101);
    expect(submitted).toEqual(['native first']);
    first.resolve({ success: true });
    await tick();
    expect(submitted).toEqual(['native first', 'native pending 99']);
    expect(maxActive).toBe(1);
  });
});

describe('shared provenance admission policy', () => {
  test('retains the registry byte limit for ASCII, Unicode, and invalid values', () => {
    expect(canRegisterWhatISaidPromptOrigin('x'.repeat(65_536))).toBe(true);
    expect(canRegisterWhatISaidPromptOrigin('x'.repeat(65_537))).toBe(false);
    expect(canRegisterWhatISaidPromptOrigin('😀'.repeat(16_384))).toBe(true);
    expect(canRegisterWhatISaidPromptOrigin('😀'.repeat(16_385))).toBe(false);
    for (const value of [null, undefined, 1, {}, '', ' \t\n ', 'has\0nul']) {
      expect(canRegisterWhatISaidPromptOrigin(value)).toBe(false);
    }
  });

  test('registry accepts the same boundary without persisting the prompt text', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-origin-budget-'));
    try {
      const registry = new WhatISaidPromptOriginRegistry(root);
      registry.register('x'.repeat(65_536));
      registry.register('😀'.repeat(16_384));
      expect(() => registry.register('x'.repeat(65_537))).toThrow('WHAT_I_SAID_PROMPT_ORIGIN_INPUT_INVALID');
      expect(() => registry.register('😀'.repeat(16_385))).toThrow('WHAT_I_SAID_PROMPT_ORIGIN_INPUT_INVALID');
      const stored = readFileSync(registry.filePath, 'utf8');
      expect(stored).not.toContain('xxxx');
      expect(stored).not.toContain('😀');
      expect((JSON.parse(stored) as { prompts: unknown[] }).prompts.length).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
