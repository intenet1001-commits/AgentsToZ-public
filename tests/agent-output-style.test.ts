import { expect, test } from 'bun:test';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENTSTOZ_OUTPUT_STYLE_END,
  AGENTSTOZ_OUTPUT_STYLE_START,
  hasCurrentSharedOutputStyle,
  SHARED_OUTPUT_STYLE_PROMPT,
  withSharedOutputStyle,
} from '../src/agentOutputStyle';
import { installDeviceSharedOutputStyle } from '../src/agentOutputStyleInstaller';

test('shared output prompt carries the exact cross-agent language contract', () => {
  expect(SHARED_OUTPUT_STYLE_PROMPT).toContain('English translation:');
  expect(SHARED_OUTPUT_STYLE_PROMPT).toContain("Write the actual response in the user's language");
  expect(SHARED_OUTPUT_STYLE_PROMPT).toContain('Do not translate code, file paths, URLs, proper nouns, or quoted text');
});

test('managed output block preserves user instructions and updates idempotently', () => {
  const original = '# User-owned instructions\n\nKeep this text.\n';
  const once = withSharedOutputStyle(original);
  const twice = withSharedOutputStyle(once);

  expect(once).toContain(original.trim());
  expect(once.match(new RegExp(AGENTSTOZ_OUTPUT_STYLE_START, 'g'))).toHaveLength(1);
  expect(once.match(new RegExp(AGENTSTOZ_OUTPUT_STYLE_END, 'g'))).toHaveLength(1);
  expect(twice).toBe(once);
  expect(hasCurrentSharedOutputStyle(once)).toBe(true);
});

test('managed output block replaces an older generated copy without duplication', () => {
  const old = `${AGENTSTOZ_OUTPUT_STYLE_START}\nold rule\n${AGENTSTOZ_OUTPUT_STYLE_END}\n\nUser text\n`;
  const updated = withSharedOutputStyle(old);

  expect(updated).not.toContain('old rule');
  expect(updated).toContain('User text');
  expect(updated.match(new RegExp(AGENTSTOZ_OUTPUT_STYLE_START, 'g'))).toHaveLength(1);
});

test('managed output block keeps YAML frontmatter as the first document section', () => {
  const original = '---\ndescription: Claude project rules\nalwaysApply: true\n---\n\n# Existing rules\n';
  const updated = withSharedOutputStyle(original);

  expect(updated.startsWith('---\ndescription: Claude project rules')).toBe(true);
  expect(updated.indexOf(AGENTSTOZ_OUTPUT_STYLE_START)).toBeGreaterThan(updated.indexOf('\n---', 4));
  expect(updated).toContain('# Existing rules');
  expect(withSharedOutputStyle(updated)).toBe(updated);
});

test('device installer writes every supported global surface and preserves existing text', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-output-style-'));
  const hermesHome = join(root, '.hermes');
  try {
    const claudePath = join(root, '.claude', 'CLAUDE.md');
    const first = installDeviceSharedOutputStyle({ home: root, hermesHome });
    expect(first.map(result => result.target)).toEqual(['claude', 'codex', 'antigravity', 'hermes']);
    expect(first.every(result => result.changed)).toBe(true);

    writeFileSync(claudePath, `${readFileSync(claudePath, 'utf8')}\nUser-owned Claude rule.\n`);
    const second = installDeviceSharedOutputStyle({ home: root, hermesHome });
    expect(readFileSync(claudePath, 'utf8')).toContain('User-owned Claude rule.');
    expect(readFileSync(join(root, '.codex', 'AGENTS.md'), 'utf8')).toContain('English translation:');
    expect(readFileSync(join(root, '.gemini', 'GEMINI.md'), 'utf8')).toContain('English translation:');
    expect(readFileSync(join(hermesHome, 'SOUL.md'), 'utf8')).toContain('English translation:');
    expect(second.find(result => result.target === 'claude')?.changed).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('device installer updates a symlink target without replacing the link', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-output-style-link-'));
  try {
    const target = join(root, 'shared-codex.md');
    const link = join(root, '.codex', 'AGENTS.md');
    writeFileSync(target, 'Shared user rule.\n');
    installDeviceSharedOutputStyle({ home: root });
    rmSync(link);
    symlinkSync(target, link);

    installDeviceSharedOutputStyle({ home: root });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(link, 'utf8')).toContain('English translation:');
    expect(readFileSync(link, 'utf8')).toContain('Shared user rule.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
