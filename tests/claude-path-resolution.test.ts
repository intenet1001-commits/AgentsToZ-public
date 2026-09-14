import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

test('Claude CLI path lookup only invokes macOS zsh on macOS and contains shell-launch failures', () => {
  expect(apiSource).toContain('function resolveClaudeThroughLoginShell');
  expect(apiSource).toContain("if (process.platform === 'darwin')");
  expect(apiSource).toContain("resolveClaudeThroughLoginShell('zsh')");
  expect(apiSource).toContain('catch {');
});
