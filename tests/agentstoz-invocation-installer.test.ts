import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installAgentsToZInvocation,
  withAgentsToZInvocation,
} from '../src/agentstozInvocationInstaller';

describe('AgentsToZ conversational invocation installer', () => {
  test('installs native entry points for four agents and is idempotent', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-invocation-'));
    const hermesHome = join(home, '.hermes');
    const first = installAgentsToZInvocation({ home, hermesHome });
    expect(first.map(result => result.target)).toEqual(['codex', 'claude', 'antigravity', 'hermes']);
    expect(first.every(result => result.changed)).toBe(true);
    expect(readFileSync(join(home, '.claude', 'commands', 'agentstoz.md'), 'utf8')).toContain('$ARGUMENTS');
    for (const path of [
      join(home, '.codex', 'skills', 'agentstoz', 'SKILL.md'),
      join(home, '.claude', 'skills', 'agentstoz', 'SKILL.md'),
      join(home, '.gemini', 'skills', 'agentstoz', 'SKILL.md'),
      join(hermesHome, 'skills', 'agentstoz', 'SKILL.md'),
    ]) {
      const text = readFileSync(path, 'utf8');
      expect(text).toContain('agentstoz_use_create_project');
      expect(text).toContain('DEV long-term memory');
    }
    expect(installAgentsToZInvocation({ home, hermesHome }).every(result => !result.changed)).toBe(true);
  });

  test('preserves user instructions and replaces only its managed block', () => {
    const old = `before\n\n<!-- AgentsToZ invocation:start -->\nold\n<!-- AgentsToZ invocation:end -->\n\nafter\n`;
    const next = withAgentsToZInvocation(old);
    expect(next).toStartWith('before');
    expect(next).toEndWith('\n\nafter\n');
    expect(next).not.toContain('\nold\n');
    expect(next.match(/AgentsToZ invocation:start/g)).toHaveLength(1);
  });

  test('updates a symlink target without replacing the symlink', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-invocation-link-'));
    const target = join(home, 'real-agents.md');
    const link = join(home, '.codex', 'AGENTS.md');
    writeFileSync(target, 'personal rule\n');
    Bun.spawnSync(['/bin/mkdir', '-p', join(home, '.codex')]);
    symlinkSync(target, link);
    installAgentsToZInvocation({ home });
    expect(readFileSync(target, 'utf8')).toContain('personal rule');
    expect(readFileSync(target, 'utf8')).toContain('아젠투지');
  });
});
