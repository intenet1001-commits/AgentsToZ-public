import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProductionPromptGuideKeyProvider } from '../src/promptGuideKeyProvider';

/**
 * Windows DPAPI key creation went through a detached child, and a detached
 * `powershell.exe` exits 0 having written **nothing** to the pipe (measured on
 * Bun 1.3.12: 0 bytes detached vs 352 bytes attached). Because the status was 0
 * the empty output then fell through to the base64 check, so every encrypted
 * store on Windows -- prompt guides, agent dialogue, orchestration missions and
 * the Gemini voice key -- reported `PROMPT_GUIDES_KEY_MALFORMED` and refused to
 * save. The cause was never the key material.
 */
describe('Windows encrypted key storage', () => {
  const directory = () => mkdtempSync(join(tmpdir(), 'agentstoz-win-key-'));

  test('an empty successful command is unavailable, not malformed', async () => {
    const provider = createProductionPromptGuideKeyProvider({
      appDataDir: directory(),
      platform: 'win32',
      runner: async () => ({ status: 0, stdout: Buffer.alloc(0) }),
    });
    // Reporting MALFORMED here blames the key for a spawn defect, and sends the
    // user to look at a store that is in fact intact.
    await expect(provider.create()).rejects.toMatchObject({ code: 'PROMPT_GUIDES_KEY_UNAVAILABLE' });
  });

  test('the credential command is never detached on Windows', () => {
    const source = readFileSync(new URL('../src/promptGuideKeyProvider.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const defaultRunner: PromptGuideKeyCommandRunner');
    expect(start).toBeGreaterThanOrEqual(0);
    const spawnCall = source.slice(start, source.indexOf('\n});', start));
    expect(spawnCall).toContain("detached: process.platform !== 'win32'");
    expect(spawnCall).not.toContain('detached: true');
  });

  test('a real round trip stores and restores 32 bytes', async () => {
    if (process.platform !== 'win32') return; // DPAPI exists only here.
    const appDataDir = directory();
    const namespace = {
      keychainService: 'com.portmanager.portmanager.test.v1',
      keychainAccount: 'windows-key-storage-test',
      dpapiFile: 'windows-key-storage-test.v1.key.dpapi',
      dpapiEntropy: 'agentstoz-windows-key-storage-test-v1',
    };
    const provider = createProductionPromptGuideKeyProvider({ appDataDir, namespace });
    const created = await provider.create();
    expect(created?.length).toBe(32);
    const restored = await provider.read();
    expect(restored?.length).toBe(32);
    expect(restored?.equals(created!)).toBe(true);
  });
});
