import {describe, expect, test} from 'bun:test';
import {createPromptGuideClient, normalizePromptGuideHumanPage} from '../src/promptGuideClient';

const snapshot = {success: true, revision: '0', entries: []};
const page = {success: true, source: 'local', items: [], hasMore: false, nextBeforeSeq: null, scan: null};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const never = () => new Promise<never>(() => {});
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('prompt guide protected client using only injected transports', () => {
  test('forwards the exact opaque cursor and human scope without transforming it', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const client = createPromptGuideClient({isNative: () => false, fetchImpl: (async (_url, init) => {
      requestBody = JSON.parse(init!.body as string);
      expect(init?.cache).toBe('no-store'); expect(init?.redirect).toBe('error');
      return response({...page, source: 'supabase'});
    })});
    await expect(client.humanPage('wisr1_9007199254740995')).resolves.toMatchObject({source: 'supabase', items: []});
    expect(requestBody).toEqual({origin: 'human', limit: 100, beforeSeq: 'wisr1_9007199254740995'});
  });

  test.each([
    null, {}, {source: 'local'}, {...page, success: false}, {...page, items: undefined}, {...page, items: {}},
    {...page, source: 'unknown'}, {...page, hasMore: undefined}, {...page, hasMore: true},
    {...page, nextBeforeSeq: 'garbage'}, {...page, scan: {complete: false, unreadable: -1, withheld: 0}},
    {...page, items: [null]}, {...page, items: Array(101).fill({})},
  ])('rejects a malformed HTTP 200 body as an error rather than empty history: %j', async raw => {
    const client = createPromptGuideClient({isNative: () => false, fetchImpl: (async () => response(raw))});
    await expect(client.humanPage()).rejects.toMatchObject({code: 'PROMPT_GUIDE_PAGE_INVALID'});
  });

  test('keeps valid source scan restrictions and opaque global cursor', () => {
    expect(normalizePromptGuideHumanPage({...page, hasMore: true, nextBeforeSeq: 'wisg1_opaque_source.opaque_signature',
      scan: {complete: false, unreadable: 3, withheld: 4}})).toMatchObject({
      nextBeforeSeq: 'wisg1_opaque_source.opaque_signature', scan: {complete: false, unreadable: 3, withheld: 4},
    });
  });

  test('pre-abort performs no network or native call', async () => {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    const client = createPromptGuideClient({isNative: () => false, fetchImpl: (async () => {calls++; return response(page);})});
    await expect(client.humanPage(undefined, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(calls).toBe(0);
  });

  test('external abort reaches the actual fetch signal and immediately settles an uncooperative fetch', async () => {
    const controller = new AbortController(); let transportSignal: AbortSignal | undefined;
    const client = createPromptGuideClient({isNative: () => false, fetchImpl: (async (_url, init) => {
      transportSignal = init?.signal as AbortSignal; return never();
    })});
    const pending = client.humanPage(undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(transportSignal?.aborted).toBe(true);
  });

  test('timeout also bounds a body read and aborts its transport', async () => {
    let transportSignal: AbortSignal | undefined;
    const client = createPromptGuideClient({isNative: () => false, timeoutMs: 10,
      fetchImpl: (async (_url, init) => {transportSignal = init?.signal as AbortSignal;
        return {status: 200, json: never} as unknown as Response;
      })});
    await expect(client.read()).rejects.toMatchObject({code: 'PROMPT_GUIDE_REQUEST_TIMEOUT'});
    expect(transportSignal?.aborted).toBe(true);
  });

  test('cancels a real HTTP body read against an isolated ephemeral fixture server', async () => {
    let bodyStarted!: () => void;
    const started = new Promise<void>(resolve => {bodyStarted = resolve;});
    const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response(new ReadableStream({
      start(controller) {controller.enqueue(new TextEncoder().encode('{"success":'));},
    }), {headers: {'Content-Type': 'application/json'}})});
    try {
      const controller = new AbortController();
      const client = createPromptGuideClient({isNative: () => false, timeoutMs: 1000,
        fetchImpl: async (_url, init) => {
          const actual = await fetch(`http://127.0.0.1:${server.port}/fixture-only`, init);
          return {status: actual.status, json: () => {
            const reading = actual.json(); bodyStarted(); return reading;
          }} as Response;
        }});
      const pending = client.humanPage(undefined, controller.signal);
      await started; controller.abort();
      await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    } finally {await server.stop(true);}
  });

  test('successful completion cleans its timeout and external abort listener', async () => {
    const external = new AbortController(); let transportSignal: AbortSignal | undefined;
    const client = createPromptGuideClient({isNative: () => false, timeoutMs: 10,
      fetchImpl: (async (_url, init) => {transportSignal = init?.signal as AbortSignal; return response(snapshot);})});
    await expect(client.read(external.signal)).resolves.toEqual({revision: '0', entries: []});
    external.abort(); await delay(20);
    expect(transportSignal?.aborted).toBe(false);
  });

  test('native abort retains the in-flight slot until the real invoke resolves', async () => {
    let resolveInvoke!: (value: {status: number; body: unknown}) => void; let calls = 0;
    const client = createPromptGuideClient({isNative: () => true, invokeImpl: async () => {
      calls++; return await new Promise(resolve => {resolveInvoke = resolve;});
    }});
    const controller = new AbortController();
    const first = client.humanPage(undefined, controller.signal);
    controller.abort();
    await expect(first).rejects.toMatchObject({name: 'AbortError'});
    await expect(client.humanPage()).rejects.toMatchObject({code: 'PROMPT_GUIDE_READ_IN_PROGRESS'});
    expect(calls).toBe(1);
    resolveInvoke({status: 200, body: page}); await delay(0);
    const next = client.humanPage(); expect(calls).toBe(2);
    resolveInvoke({status: 200, body: page}); await expect(next).resolves.toMatchObject({items: []});
  });

  test('native timeout retains its slot through a late invoke rejection and then releases it', async () => {
    let rejectInvoke!: (reason: Error) => void; let calls = 0;
    const client = createPromptGuideClient({isNative: () => true, timeoutMs: 10, invokeImpl: async () => {
      calls++;
      if (calls > 1) return {status: 200, body: page};
      return await new Promise((_resolve, reject) => {rejectInvoke = reject;});
    }});
    await expect(client.humanPage()).rejects.toMatchObject({code: 'PROMPT_GUIDE_REQUEST_TIMEOUT'});
    await expect(client.humanPage()).rejects.toMatchObject({code: 'PROMPT_GUIDE_READ_IN_PROGRESS'});
    rejectInvoke(new Error('Late fixture failure')); await delay(0);
    await expect(client.humanPage()).resolves.toMatchObject({items: []}); expect(calls).toBe(2);
  });

  test('keeps a store conflict code for the UI and does not retry a save', async () => {
    let calls = 0;
    const client = createPromptGuideClient({isNative: () => false, fetchImpl: (async () => {
      calls++; return response({code: 'PROMPT_GUIDES_CONFLICT', error: 'Fixture conflict'}, 409);
    })});
    await expect(client.save('0', [])).rejects.toMatchObject({code: 'PROMPT_GUIDES_CONFLICT'}); expect(calls).toBe(1);
  });
});
