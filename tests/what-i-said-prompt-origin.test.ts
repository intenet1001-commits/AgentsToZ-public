import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WhatISaidPromptOriginRegistry,
  whatISaidPromptFingerprint,
} from '../src/whatISaidPromptOriginRegistry';

const roots: string[] = [];
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/WhatISaidPanel.tsx', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('../src/whatISaidStore.ts', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../supabase/migrations/20260902010000_what_i_said_memory_sync_and_search.sql', import.meta.url),
  'utf8',
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('What-I-said explicit prompt origin', () => {
  test('stores only a fingerprint and distinguishes app copy, direct input, and historical unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-prompt-origin-'));
    roots.push(root);
    const registry = new WhatISaidPromptOriginRegistry(root);
    const prompt = '코드를 확인하고 테스트해줘';

    // No evidence-era boundary yet: historical input cannot honestly be called human.
    expect(registry.classify(prompt, '2026-09-02T09:00:00Z')).toBe('unknown');
    registry.register(prompt, '2026-09-02T10:00:00Z');

    expect(registry.classify(`  ${prompt}\n`, '2026-09-02T10:01:00Z')).toBe('agentstoz');
    expect(registry.classify('사람이 직접 쓴 새 요청', '2026-09-02T10:01:00Z')).toBe('human');
    expect(registry.classify('과거 요청', '2026-09-01T10:00:00Z')).toBe('unknown');

    const stored = readFileSync(registry.filePath, 'utf8');
    expect(stored).toContain(whatISaidPromptFingerprint(prompt));
    expect(stored).not.toContain(prompt);
  });

  test('keeps repeated copy evidence and does not infer app provenance outside its submit window', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-prompt-origin-repeat-'));
    roots.push(root);
    const prompt = '/remember_session /project';
    const registry = new WhatISaidPromptOriginRegistry(root);
    registry.register(prompt, '2026-09-02T10:00:00Z');
    registry.register(prompt, '2026-09-02T14:00:00Z');

    expect(registry.classify(prompt, '2026-09-02T10:01:00Z')).toBe('agentstoz');
    expect(registry.classify(prompt, '2026-09-02T14:01:00Z')).toBe('agentstoz');
    expect(registry.classify(prompt, '2026-09-02T12:00:00Z')).toBe('unknown');

    const reloaded = new WhatISaidPromptOriginRegistry(root);
    expect(reloaded.classify(prompt, '2026-09-02T10:01:00Z')).toBe('agentstoz');
  });

  test('threads explicit origin through copy, collection, local/remote storage, and filtering', () => {
    expect(appSource).toContain("copyAgentsToZPrompt(buildGitMergeSyncPrompt({");
    expect(apiSource).toContain("'/api/what-i-said/prompt-origin/register'");
    expect(apiSource).toContain('p_prompt_origin: input.origin');
    expect(rustSource).toContain('("POST", "/api/what-i-said/prompt-origin/register")');
    expect(storeSource).toContain("prompt_origin IN ('human', 'agentstoz', 'unknown')");
    expect(migration).toContain("prompt_origin in ('human', 'agentstoz', 'unknown')");
    expect(panelSource).toContain('data-testid="what-i-said-prompt-origin"');
    expect(panelSource).toContain("origin: originFilter === 'all' ? undefined : originFilter");
  });
});
