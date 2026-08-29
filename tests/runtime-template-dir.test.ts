import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRuntimeTemplateDir } from '../src/runtimeTemplateDir';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-template-dir-'));
  roots.push(root);
  return {
    root,
    moduleDir: join(root, 'bunfs', 'root'),
    execPath: join(root, 'bundle', 'agentstoz-api-sidecar'),
  };
}

test('prefers source templates during local development', () => {
  const { moduleDir, execPath } = fixture();
  const source = join(moduleDir, 'templates', 'hermes');
  const bundled = join(execPath, '..', 'templates', 'hermes');
  mkdirSync(source, { recursive: true });
  mkdirSync(bundled, { recursive: true });
  expect(resolveRuntimeTemplateDir('hermes', { moduleDir, execPath })).toBe(source);
});

test('uses executable-adjacent templates in a compiled standalone sidecar', () => {
  const { moduleDir, execPath } = fixture();
  const bundled = join(execPath, '..', 'templates', 'hermes-plugin');
  mkdirSync(bundled, { recursive: true });
  expect(resolveRuntimeTemplateDir('hermes-plugin', { moduleDir, execPath })).toBe(bundled);
});
