import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installAgentsToZInvocation,
  withAgentsToZInvocation,
} from '../src/agentstozInvocationInstaller';

describe('AgentsToZ conversational invocation installer', () => {
  // Updated 2026-09-29 (review L5): the agy entries are written only where agy keeps its global
  // customizations, ~/.gemini/config/, and only when that folder exists (agy installed). This home
  // simulates an installed agy; the test below covers a machine without it.
  test('installs native entry points for four agents and is idempotent', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-invocation-'));
    const hermesHome = join(home, '.hermes');
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    const first = installAgentsToZInvocation({ home, hermesHome });
    expect(first.map(result => result.target)).toEqual(['codex', 'claude', 'antigravity', 'hermes']);
    expect(first.every(result => result.changed)).toBe(true);
    expect(readFileSync(join(home, '.claude', 'commands', 'agentstoz.md'), 'utf8')).toContain('$ARGUMENTS');
    expect(readFileSync(join(home, '.claude', 'commands', 'remember_agentstoz.md'), 'utf8')).toContain('only a candidate');
    expect(readFileSync(join(hermesHome, 'skills', 'remember_agentstoz', 'SKILL.md'), 'utf8')).toContain('name: remember_agentstoz');
    for (const path of [
      join(home, '.codex', 'skills', 'agentstoz', 'SKILL.md'),
      join(home, '.claude', 'skills', 'agentstoz', 'SKILL.md'),
      join(home, '.gemini', 'skills', 'agentstoz', 'SKILL.md'),
      // agy (Antigravity CLI) reads its global customizations from ~/.gemini/config/ — its bundled
      // docs name `~/.gemini/config/skills/<name>/SKILL.md` as the global skill location.
      join(home, '.gemini', 'config', 'skills', 'agentstoz', 'SKILL.md'),
      join(hermesHome, 'skills', 'agentstoz', 'SKILL.md'),
    ]) {
      const text = readFileSync(path, 'utf8');
      expect(text).toContain('agentstoz_use_create_project');
      expect(text).toContain('DEV long-term memory');
      expect(text).toContain('아젠투지오피에스');
      expect(text).toContain('아젠투지데브');
      expect(text).toContain('아젠투지총괄');
      expect(text).toContain('아젠투지개발');
      expect(text).toContain('프로젝트담당자');
      expect(text).toContain('agentstoz_use_resolve_target');
      expect(text).toContain('동명 또는 DEV 후보가 여러 개');
    }
    expect(installAgentsToZInvocation({ home, hermesHome }).every(result => !result.changed)).toBe(true);
    const antigravity = first.find(result => result.target === 'antigravity')!;
    expect(antigravity.paths).toEqual([
      join(home, '.gemini', 'skills', 'agentstoz', 'SKILL.md'),
      join(home, '.gemini', 'config', 'skills', 'agentstoz', 'SKILL.md'),
      join(home, '.gemini', 'GEMINI.md'),
      // agy's always-on global rule: a standalone GEMINI.md in its customization root.
      join(home, '.gemini', 'config', 'GEMINI.md'),
    ]);
    expect(readFileSync(join(home, '.gemini', 'config', 'GEMINI.md'), 'utf8')).toContain('<!-- AgentsToZ invocation:start -->');
  });

  // Review L5: agy read the skill but no always-on rule, and the installer created ~/.gemini/config
  // itself on machines without agy — which then looked like an installed agy to the next check.
  test('agy rules go to ~/.gemini/config/GEMINI.md next to user rules, and nothing is created without agy', () => {
    const bare = mkdtempSync(join(tmpdir(), 'agentstoz-invocation-no-agy-'));
    const withoutAgy = installAgentsToZInvocation({ home: bare }).find(result => result.target === 'antigravity')!;
    expect(existsSync(join(bare, '.gemini', 'config'))).toBe(false);
    expect(withoutAgy.paths).toEqual([join(bare, '.gemini', 'skills', 'agentstoz', 'SKILL.md'), join(bare, '.gemini', 'GEMINI.md')]);
    expect(installAgentsToZInvocation({ home: bare }).every(result => !result.changed)).toBe(true);

    const home = mkdtempSync(join(tmpdir(), 'agentstoz-invocation-agy-rules-'));
    const rules = join(home, '.gemini', 'config', 'GEMINI.md');
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(rules, '# My agy rules\n\nAlways answer briefly.\n');
    const first = installAgentsToZInvocation({ home }).find(result => result.target === 'antigravity')!;
    expect(first.changed).toBe(true);
    const text = readFileSync(rules, 'utf8');
    expect(text).toStartWith('# My agy rules\n\nAlways answer briefly.\n');
    expect(text.match(/AgentsToZ invocation:start/g)).toHaveLength(1);
    expect(text).toContain('agentstoz_use_get_control_profile');
    expect(installAgentsToZInvocation({ home }).find(result => result.target === 'antigravity')!.changed).toBe(false);
  });

  test('a stale agy global skill is replaced and another agy skill is left alone', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-invocation-agy-'));
    const skill = join(home, '.gemini', 'config', 'skills', 'agentstoz', 'SKILL.md');
    const other = join(home, '.gemini', 'config', 'skills', 'ego-browser', 'SKILL.md');
    mkdirSync(join(home, '.gemini', 'config', 'skills', 'agentstoz'), { recursive: true });
    mkdirSync(join(home, '.gemini', 'config', 'skills', 'ego-browser'), { recursive: true });
    writeFileSync(skill, '---\nname: agentstoz\ndescription: old\n---\nold body\n');
    writeFileSync(other, '---\nname: ego-browser\n---\nuser skill\n');
    const result = installAgentsToZInvocation({ home }).find(entry => entry.target === 'antigravity')!;
    expect(result.changed).toBe(true);
    expect(readFileSync(skill, 'utf8')).toBe(readFileSync(join(home, '.gemini', 'skills', 'agentstoz', 'SKILL.md'), 'utf8'));
    expect(readFileSync(skill, 'utf8')).not.toContain('old body');
    expect(readFileSync(other, 'utf8')).toBe('---\nname: ego-browser\n---\nuser skill\n');
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
