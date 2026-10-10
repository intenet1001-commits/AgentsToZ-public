import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VoiceCredentials } from '../src/voiceCredentials';
import {
  VOICE_SECRET_ACCOUNT,
  VOICE_SECRET_SERVICE,
  createWindowsVoiceSecretStore,
  voiceSecretStoreName,
  type VoiceSecretStore,
} from '../src/voiceSecretStore';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(join(tmpdir(), 'voice-secret-')); roots.push(path); return path; }

const KEY = 'sk-test-0123456789abcdefghij';

/** Stands in for Bun.secrets, recording what the store asked the OS to do. */
function fakeSecrets(initial: string | null = null) {
  const calls: string[] = [];
  let value = initial;
  let failSet = false;
  let storeNothing = false;
  let refuseDelete = false;
  return {
    calls,
    setFailSet(on: boolean) { failSet = on; },
    setStoreNothing(on: boolean) { storeNothing = on; },
    setRefuseDelete(on: boolean) { refuseDelete = on; },
    read: () => value,
    api: {
      get: async (options: { service: string; name: string }) => {
        calls.push(`get:${options.service}/${options.name}`);
        return value;
      },
      set: async (options: { service: string; name: string; value: string }) => {
        calls.push(`set:${options.service}/${options.name}`);
        if (failSet) throw new Error('credential manager unavailable');
        if (!storeNothing) value = options.value;
      },
      delete: async (options: { service: string; name: string }) => {
        calls.push(`delete:${options.service}/${options.name}`);
        if (refuseDelete) throw new Error('locked');
        value = null;
      },
    },
  };
}

test('the Windows store uses the same service and account identity as the keychain entry', async () => {
  const secrets = fakeSecrets();
  const store = createWindowsVoiceSecretStore(secrets.api);
  await store.set(KEY);
  expect(secrets.calls[0]).toBe(`set:${VOICE_SECRET_SERVICE}/${VOICE_SECRET_ACCOUNT}`);
  expect(await store.get()).toBe(KEY);
});

test('a save is only reported after the value reads back', async () => {
  const silent = fakeSecrets();
  silent.setStoreNothing(true);
  // A credential API that accepts the write but stores nothing must not be
  // reported as configured; that is the whole point of the readback.
  await expect(createWindowsVoiceSecretStore(silent.api).set(KEY)).rejects.toThrow(/일치/);

  const broken = fakeSecrets();
  broken.setFailSet(true);
  await expect(createWindowsVoiceSecretStore(broken.api).set(KEY)).rejects.toThrow();
  expect(broken.read()).toBeNull();
});

test('a malformed stored value is treated as absent, never handed to the provider', async () => {
  for (const stored of ['', 'short', 'has space 0123456789abcdef', 'x'.repeat(600)]) {
    const secrets = fakeSecrets(stored);
    expect(await createWindowsVoiceSecretStore(secrets.api).get()).toBeNull();
  }
  expect(await createWindowsVoiceSecretStore(fakeSecrets(null).api).get()).toBeNull();
});

test('the store refuses to write a key that does not match the accepted shape', async () => {
  const secrets = fakeSecrets();
  const store = createWindowsVoiceSecretStore(secrets.api);
  for (const bad of ['', 'short', 'sk key with spaces 12345', 'x'.repeat(600)]) {
    await expect(store.set(bad)).rejects.toThrow();
  }
  expect(secrets.calls).toEqual([]);
});

test('deleting an absent entry succeeds; a store that keeps the value fails', async () => {
  const empty = fakeSecrets(null);
  await createWindowsVoiceSecretStore(empty.api).delete();
  expect(empty.read()).toBeNull();

  const stuck = fakeSecrets(KEY);
  stuck.setRefuseDelete(true);
  await expect(createWindowsVoiceSecretStore(stuck.api).delete()).rejects.toThrow();
});

test('Windows can configure, read and remove the voice key through the store', async () => {
  const directory = root();
  const secrets = fakeSecrets();
  const store: VoiceSecretStore = createWindowsVoiceSecretStore(secrets.api);
  const credentials = new VoiceCredentials(directory, {}, undefined, 'win32', store);

  expect(credentials.status().keySource).toBe('none');
  // The old behaviour on Windows was an outright refusal to accept a key.
  const configured = await credentials.configure({ apiKey: KEY } as any);
  expect(configured.keySource).toBe('keychain');
  expect(configured.configured).toBe(true);
  expect(await credentials.key()).toBe(KEY);

  // The durable settings file records only that a key exists, never the key.
  const settings = readFileSync(join(directory, 'settings.json'), 'utf8');
  expect(settings).toContain('"keyConfigured":true');
  expect(settings).not.toContain(KEY);

  const removed = await credentials.configure({ removeKey: true } as any);
  expect(removed.keySource).toBe('none');
  await expect(credentials.key()).rejects.toThrow();
});

test('an environment key still wins over the store on Windows', async () => {
  const secrets = fakeSecrets();
  const credentials = new VoiceCredentials(
    root(), { AGENTSTOZ_VOICE_API_KEY: KEY }, undefined, 'win32',
    createWindowsVoiceSecretStore(secrets.api),
  );
  expect(credentials.status().keySource).toBe('environment');
  expect(await credentials.key()).toBe(KEY);
  expect(secrets.calls).toEqual([]);
});

test('a Windows host without a credential store keeps the environment-only guidance', async () => {
  // `store` is explicitly absent and the platform cannot build one in the test
  // harness, so the host must say which setting to use instead of half-saving.
  const credentials = new VoiceCredentials(root(), {}, async () => ({ code: 1, text: '' }), 'linux');
  await expect(credentials.configure({ apiKey: KEY } as any)).rejects.toThrow(/AGENTSTOZ_VOICE_API_KEY/);
});

test('the macOS keychain path is untouched by the store seam', async () => {
  const issued: string[][] = [];
  const credentials = new VoiceCredentials(root(), {}, async (args, input) => {
    issued.push(args);
    if (args[0] === 'find-generic-password') return { code: 0, text: `${KEY}\n` };
    expect(input).toContain('add-generic-password');
    // The key must never appear in argv on macOS; it travels on stdin.
    expect(args.join(' ')).not.toContain(KEY);
    return { code: 0, text: '' };
  }, 'darwin');
  const configured = await credentials.configure({ apiKey: KEY } as any);
  expect(configured.keySource).toBe('keychain');
  expect(issued[0]).toEqual(['-i']);
  expect(issued[1]?.[0]).toBe('find-generic-password');
  expect(await credentials.key()).toBe(KEY);
});

test('the store is named per platform for user-facing text', () => {
  expect(voiceSecretStoreName('win32')).toBe('자격 증명 관리자');
  expect(voiceSecretStoreName('darwin')).toBe('Keychain');
  expect(voiceSecretStoreName('linux')).not.toBe('Keychain');
});
