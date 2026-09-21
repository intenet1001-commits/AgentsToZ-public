import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProductionPromptGuideKeyProvider, PROMPT_GUIDES_DPAPI_FILE,
  __setPromptGuideDurabilityFaultForTests,
  PROMPT_GUIDES_KEYCHAIN_ACCOUNT, PROMPT_GUIDES_KEYCHAIN_SERVICE, type PromptGuideKeyCommandRunner,
} from '../src/promptGuideKeyProvider';

const roots: string[] = [];
afterEach(() => { __setPromptGuideDurabilityFaultForTests(null); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() { const root = mkdtempSync(join(tmpdir(), 'agentstoz-guide-key-')); roots.push(root); return root; }

describe('guide-only OS key adapter (mock commands, no credential UI)', () => {
  test('macOS read of a missing key never creates; locked keychain is unavailable rather than absent', async () => {
    const commands: string[] = [];
    let status = 44;
    const provider = createProductionPromptGuideKeyProvider({ appDataDir: directory(), platform: 'darwin', runner: async (_, args) => {
      commands.push(args[0]!); return { status, stdout: Buffer.alloc(0) };
    } });
    expect(await provider.read()).toBeNull(); expect(commands).toEqual(['find-generic-password']);
    status = 36;
    await expect(provider.read()).rejects.toMatchObject({ code: 'PROMPT_GUIDES_KEY_UNAVAILABLE' });
    await expect(provider.create()).rejects.toMatchObject({ code: 'PROMPT_GUIDES_KEY_UNAVAILABLE' });
    expect(commands.every(value => value === 'find-generic-password')).toBe(true);
  });

  test('macOS creation uses its own service/account, add-only and a private two-line stdin', async () => {
    let stored: string | null = null;
    const outputs: Buffer[] = [];
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const runner: PromptGuideKeyCommandRunner = async (command, args, input) => {
      calls.push({ command, args: [...args], input: input?.toString('utf8') });
      if (args[0] === 'add-generic-password') stored = input!.toString('utf8').split('\n')[0]!;
      const stdout = Buffer.from(args[0] === 'find-generic-password' && stored ? stored + '\n' : ''); outputs.push(stdout);
      return { status: args[0] === 'find-generic-password' && !stored ? 44 : 0, stdout };
    };
    const provider = createProductionPromptGuideKeyProvider({ appDataDir: directory(), platform: 'darwin', runner });
    const key = await provider.create(); expect(key.length).toBe(32);
    const addition = calls.find(call => call.args[0] === 'add-generic-password')!;
    expect(addition.command).toBe('/usr/bin/security');
    expect(addition.args).toEqual(['add-generic-password', '-a', PROMPT_GUIDES_KEYCHAIN_ACCOUNT, '-s', PROMPT_GUIDES_KEYCHAIN_SERVICE, '-w']);
    expect(addition.args).not.toContain(key.toString('base64'));
    expect(addition.input).toBe(`${key.toString('base64')}\n${key.toString('base64')}\n`);
    expect(outputs.every(output => output.every(byte => byte === 0))).toBe(true);
    key.fill(0);
    const again = await provider.create(); again.fill(0);
    expect(calls.filter(call => call.args[0] === 'add-generic-password')).toHaveLength(1);
  });

  test('malformed existing macOS key and thrown runner errors never create replacements', async () => {
    for (const raw of ['', 'not-base64', Buffer.alloc(16, 1).toString('base64')]) {
      const actions: string[] = [];
      const provider = createProductionPromptGuideKeyProvider({ appDataDir: directory(), platform: 'darwin', runner: async (_, args) => {
        actions.push(args[0]!); return { status: 0, stdout: Buffer.from(raw) };
      } });
      await expect(provider.create()).rejects.toMatchObject({ code: 'PROMPT_GUIDES_KEY_MALFORMED' });
      expect(actions).toEqual(['find-generic-password']);
    }
    const provider = createProductionPromptGuideKeyProvider({ appDataDir: directory(), platform: 'darwin', runner: async () => { throw new Error('private runner details'); } });
    await expect(provider.read()).rejects.toMatchObject({ message: 'PROMPT_GUIDES_KEY_UNAVAILABLE' });
  });

  test('Windows stores only a separate DPAPI ciphertext and reads it without reprovisioning', async () => {
    const appDataDir = join(directory(), 'app-data');
    let raw = '';
    const calls: string[] = [];
    const sealed = Buffer.from('synthetic DPAPI ciphertext').toString('base64');
    const provider = createProductionPromptGuideKeyProvider({ appDataDir, platform: 'win32', runner: async (command, args, stdin) => {
      expect(command).toMatch(/^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
      const script = args.at(-1)!; calls.push(script);
      expect(script).toContain('CurrentUser'); expect(script).toContain('agentstoz-prompt-guides-key-v1');
      if (script.includes('::Protect(')) { raw = stdin!.toString('utf8'); return { status: 0, stdout: Buffer.from(sealed) }; }
      expect(stdin!.toString('utf8').trim()).toBe(sealed);
      return { status: 0, stdout: Buffer.from(raw) };
    } });
    expect(await provider.read()).toBeNull(); expect(calls).toHaveLength(0); expect(existsSync(appDataDir)).toBe(false);
    const key = await provider.create(); expect(key.toString('base64')).toBe(raw); key.fill(0);
    const path = join(appDataDir, PROMPT_GUIDES_DPAPI_FILE);
    expect(readFileSync(path, 'utf8').trim()).toBe(sealed);
    expect(readFileSync(path, 'utf8')).not.toContain(raw);
    if (process.platform !== 'win32') expect(lstatSync(path).mode & 0o777).toBe(0o600);
    (await provider.read())!.fill(0);
    expect(calls.filter(script => script.includes('::Protect('))).toHaveLength(1);
  });

  test('Windows key symlink, invalid blob or decryption failure is never replaced', async () => {
    const appDataDir = directory(); const file = join(appDataDir, PROMPT_GUIDES_DPAPI_FILE);
    const provider = createProductionPromptGuideKeyProvider({ appDataDir, platform: 'win32', runner: async () => ({ status: 1, stdout: Buffer.alloc(0) }) });
    writeFileSync(file, 'invalid!');
    await expect(provider.create()).rejects.toMatchObject({ code: 'PROMPT_GUIDES_KEY_MALFORMED' });
    expect(readFileSync(file, 'utf8')).toBe('invalid!');
    writeFileSync(file, 'YmxvYg==');
    await expect(provider.create()).rejects.toMatchObject({ code: 'PROMPT_GUIDES_KEY_UNAVAILABLE' });
    const other = directory(); const target = join(other, 'target'); writeFileSync(target, 'YmxvYg==');
    symlinkSync(target, join(other, PROMPT_GUIDES_DPAPI_FILE));
    await expect(createProductionPromptGuideKeyProvider({ appDataDir: other, platform: 'win32' }).read())
      .rejects.toMatchObject({ code: 'PROMPT_GUIDES_PATH_UNSAFE' });
  });

  test('DPAPI key data is flushed before readback and a flush failure preserves the add-only blob', async () => {
    const appDataDir = directory();
    const sealed = Buffer.from('synthetic DPAPI ciphertext').toString('base64');
    let unprotects = 0;
    const phases: string[] = [];
    const provider = createProductionPromptGuideKeyProvider({ appDataDir, platform: 'win32', runner: async (_, args) => {
      if (args.at(-1)!.includes('::Protect(')) return { status: 0, stdout: Buffer.from(sealed) };
      unprotects++; return { status: 0, stdout: Buffer.alloc(0) };
    } });
    __setPromptGuideDurabilityFaultForTests(phase => { phases.push(phase); if (phase === 'key-file') throw Error('fixture key flush failure'); });
    await expect(provider.create()).rejects.toMatchObject({ code: 'PROMPT_GUIDES_KEY_UNAVAILABLE' });
    expect(phases).toEqual(['key-file']); expect(unprotects).toBe(0);
    expect(readFileSync(join(appDataDir, PROMPT_GUIDES_DPAPI_FILE), 'utf8')).toBe(sealed + '\n');
  });

  test('unsupported systems fail closed without commands or plaintext key files', async () => {
    const appDataDir = directory(); let calls = 0;
    const provider = createProductionPromptGuideKeyProvider({ appDataDir, platform: 'linux', runner: async () => { calls++; return { status: 0, stdout: Buffer.alloc(32) }; } });
    await expect(provider.read()).rejects.toMatchObject({ code: 'PROMPT_GUIDES_KEY_UNSUPPORTED' });
    await expect(provider.create()).rejects.toMatchObject({ code: 'PROMPT_GUIDES_KEY_UNSUPPORTED' });
    expect(calls).toBe(0);
  });
});
