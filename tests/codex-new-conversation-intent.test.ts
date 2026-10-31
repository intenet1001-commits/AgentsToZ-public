import { describe, expect, test } from 'bun:test';
import { createCodexNewConversationIntentStore, reserveVerifiedCodexNewIntent } from '../src/codexNewConversationIntent';
import { projectCreationIntentFingerprint } from '../src/projectLaunchIntent';

describe('Codex new conversation browser intent', () => {
  test('persists one request id across reload and prevents a different project from stealing it', () => {
    const data = new Map<string, string>(); let n = 0;
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const make = () => createCodexNewConversationIntentStore(storage, () => `request-${++n}`, projectCreationIntentFingerprint);
    const first = make().reserve('host-a', 'controller-a', 'private project label');
    expect(make().reserve('host-a', 'controller-a', 'private project label')).toEqual(first);
    expect(() => make().reserve('host-a', 'controller-a', 'another project')).toThrow('결과를 확인하지 못한');
    expect([...data.values()].join('')).not.toContain('private project label');
    make().complete(first);
    expect(make().reserve('host-a', 'controller-a', 'private project label').actionId).not.toBe(first.actionId);
  });

  test('does not clear the wrong receipt and fails closed when storage is unavailable or corrupt', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const store = createCodexNewConversationIntentStore(storage, () => 'request-1', projectCreationIntentFingerprint);
    const intent = store.reserve('host', 'controller', 'project');
    expect(() => store.complete({...intent, actionId: 'request-2'})).toThrow();
    expect(store.reserve('host', 'controller', 'project')).toEqual(intent);
    data.set('agentstoz-codex-new-intents-v1', '{not valid');
    expect(() => store.reserve('host', 'controller', 'project')).toThrow();
    const broken = createCodexNewConversationIntentStore({getItem() { return null; }, setItem() { throw new Error('storage'); }}, () => 'request-1', projectCreationIntentFingerprint);
    expect(() => broken.reserve('host', 'controller', 'project')).toThrow();
  });

  test('a changed control id can be rebound only to the same previously stored action id', () => {
    const data = new Map<string, string>();
    const storage = {getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }};
    const store = createCodexNewConversationIntentStore(storage, () => 'request-1', projectCreationIntentFingerprint);
    const old = store.reserve('host', 'controller', 'old-control');
    expect(store.inspect('host', 'controller')).toEqual(old);
    expect(() => store.rebind(old, 'new-control', 'other-request')).toThrow();
    expect(store.inspect('host', 'controller')).toEqual(old);
    const rebound = store.rebind(old, 'new-control', 'request-1');
    expect(store.reserve('host', 'controller', 'new-control')).toEqual(rebound);
    expect(rebound.actionId).toBe(old.actionId);
  });

  test('a missing receipt is never cleared on refusal, outbox blockage, or a mismatched response', async () => {
    const data = new Map<string, string>();
    const storage = {getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }};
    const store = createCodexNewConversationIntentStore(storage, () => 'request-1', projectCreationIntentFingerprint);
    const pending = store.reserve('host', 'controller', 'old-control');
    const base = {store, hostId:'host', controllerId:'controller', projectControlId:'new-control', fingerprint:projectCreationIntentFingerprint};
    await expect(reserveVerifiedCodexNewIntent({...base, reviewExact:async()=>null, cancelMissing:async()=>false})).rejects.toThrow();
    expect(store.inspect('host','controller')).toEqual(pending);
    await expect(reserveVerifiedCodexNewIntent({...base, reviewExact:async()=>null, cancelMissing:async()=>{throw new Error('outbox pending');}})).rejects.toThrow('outbox pending');
    expect(store.inspect('host','controller')).toEqual(pending);
    let cancelCalls = 0;
    await expect(reserveVerifiedCodexNewIntent({...base, reviewExact:async()=>({actionId:'different-id'}),cancelMissing:async()=>{cancelCalls++;return true;}})).rejects.toThrow();
    expect(cancelCalls).toBe(0);
    expect(store.inspect('host','controller')).toEqual(pending);
    expect(await reserveVerifiedCodexNewIntent({...base, reviewExact:async()=>null,cancelMissing:async()=>true})).toBeNull();
    expect(store.inspect('host','controller')).toBeNull();
  });
});
