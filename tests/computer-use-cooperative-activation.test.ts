import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test.skipIf(process.platform !== 'darwin')('review activation only follows a verified, current, uncancelled explicit request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentstoz-coop-test-'));
  try {
    const executable = join(dir, 'checks');
    const source = join(import.meta.dir, 'fixtures', 'computer-use-cooperative-activation.m');
    const build = Bun.spawnSync(['xcrun', 'clang', '-fobjc-arc', '-fmodules', `-fmodules-cache-path=${dir}/modules`,
      '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=14.0', source, '-framework', 'Foundation',
      '-framework', 'AppKit', '-framework', 'Security', '-o', executable], {stdout: 'pipe', stderr: 'pipe', timeout: 60_000});
    expect(build.stderr.toString()).toBe('');
    expect(build.exitCode).toBe(0);
    const result = Bun.spawnSync([executable], {stdout: 'pipe', stderr: 'pipe', timeout: 5_000});
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('cooperative activation gate passed');
  } finally { rmSync(dir, {recursive: true, force: true}); }
}, 90_000);
