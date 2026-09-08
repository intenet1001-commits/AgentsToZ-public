import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, symlinkSync, existsSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const publishScript = resolve(import.meta.dir, '../scripts/publish.ts');
const roots: string[] = [];

function git(root: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('public publisher integration', () => {
  test('preserves source history, index, ignored files, existing refs and bypasses checkout/commit hooks', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-publish-preserve-'));
    roots.push(root);
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'AgentsToZ Test']);
    git(root, ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(root, '.gitignore'), 'local-only.txt\n');
    writeFileSync(join(root, 'README.md'), 'first revision\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'private history']);
    git(root, ['branch', 'publish-clean']);
    const existingRef = git(root, ['rev-parse', 'publish-clean']);
    writeFileSync(join(root, 'README.md'), 'public revision\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'current source']);
    git(root, ['remote', 'add', 'publish', 'https://github.com/example/public.git']);
    writeFileSync(join(root, 'local-only.txt'), 'ignored development state\n');
    for (const hook of ['post-checkout', 'pre-commit', 'post-commit']) {
      const path = join(root, '.git', 'hooks', hook);
      writeFileSync(path, '#!/bin/sh\necho invoked > hook-invoked\nexit 1\n');
      chmodSync(path, 0o755);
    }
    const source = git(root, ['rev-parse', 'HEAD']);
    const index = readFileSync(join(root, '.git', 'index'));
    // A metadata-only touch must not let read-only status refresh the source index.
    const touchedAt = new Date(Date.now() + 60_000);
    utimesSync(join(root, 'README.md'), touchedAt, touchedAt);
    const result = Bun.spawnSync({ cmd: [process.execPath, publishScript, '--dry-run'], cwd: root, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const candidateRef = /candidate: (refs\/agentstoz\/publication-candidates\/[^ ]+) @/.exec(result.stdout.toString())?.[1];
    expect(candidateRef).toBeDefined();
    expect(git(root, ['rev-list', '--count', candidateRef!])).toBe('1');
    expect(git(root, ['show', '-s', '--format=%P', candidateRef!])).toBe('');
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(source);
    expect(git(root, ['rev-parse', 'publish-clean'])).toBe(existingRef);
    expect(git(root, ['branch', '--show-current'])).toBe('main');
    expect(readFileSync(join(root, '.git', 'index')).equals(index)).toBe(true);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('public revision\n');
    expect(readFileSync(join(root, 'local-only.txt'), 'utf8')).toBe('ignored development state\n');
    expect(existsSync(join(root, 'hook-invoked'))).toBe(false);
    expect(git(root, ['status', '--porcelain'])).toBe('');
  });

  test('rejects links without changing source or registering an unaudited candidate', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-publish-link-'));
    roots.push(root);
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'AgentsToZ Test']);
    git(root, ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(root, 'README.md'), 'public revision\n');
    symlinkSync('README.md', join(root, 'linked-file'));
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'fixture']);
    git(root, ['remote', 'add', 'publish', 'https://github.com/example/public.git']);
    const source = git(root, ['rev-parse', 'HEAD']);
    const result = Bun.spawnSync({ cmd: [process.execPath, publishScript, '--dry-run'], cwd: root, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('symlink/submodule/file mode');
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(source);
    expect(git(root, ['status', '--porcelain'])).toBe('');
    expect(git(root, ['for-each-ref', '--format=%(refname)', 'refs/agentstoz/publication-candidates/'])).toBe('');
  });

  test('dry-run rejects Stripe-shaped credentials before a remote push', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-publish-stripe-'));
    roots.push(root);
    // Synthetic values are assembled only at runtime; no real credentials.
    writeFileSync(join(root, 'fixture.txt'), ['sk_live_', 'rk_live_']
      .map(prefix => prefix + 'abcdefghijklmnopqrstuvwxyz').join('\n'));
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'AgentsToZ Test']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'fixture']);
    git(root, ['remote', 'add', 'publish', 'https://github.com/example/public.git']);
    const source = git(root, ['rev-parse', 'HEAD']);
    const index = readFileSync(join(root, '.git', 'index'));
    const result = Bun.spawnSync({
      cmd: [process.execPath, publishScript, '--dry-run'],
      cwd: root, stdout: 'pipe', stderr: 'pipe',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('Stripe API key');
    expect(git(root, ['branch', '--show-current'])).toBe('main');
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(source);
    expect(readFileSync(join(root, '.git', 'index')).equals(index)).toBe(true);
    expect(git(root, ['for-each-ref', '--format=%(refname)', 'refs/agentstoz/publication-candidates/'])).toBe('');
  });

  test('dry-run excludes every private-only path without leaving main', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-publish-'));
    roots.push(root);
    mkdirSync(join(root, 'docs', 'superpowers'), { recursive: true });
    mkdirSync(join(root, 'docs', 'design'), { recursive: true });
    mkdirSync(join(root, 'docs', 'handoffs', 'fixture'), { recursive: true });
    writeFileSync(join(root, 'docs', 'handoffs', 'fixture', 'README.md'), 'private local UI handoff');
    mkdirSync(join(root, 'release'), { recursive: true });
    writeFileSync(join(root, 'docs', 'design', 'overnight-progress.md'), 'private runtime observations');
    writeFileSync(join(root, 'release', 'README.md'), 'private development layout');
    mkdirSync(join(root, 'uploaded-commands'), { recursive: true });
    writeFileSync(join(root, 'README.md'), 'safe public file\n');
    writeFileSync(join(root, 'uploaded-commands', '실행.command'), '#!/bin/sh\necho safe\n');
    writeFileSync(join(root, 'CLAUDE.md'), 'private operator notes\n');
    writeFileSync(join(root, 'docs', 'PROJECT_MEMORY_V99_HANDOFF_private.md'), 'private handoff\n');
    writeFileSync(join(root, 'docs', 'superpowers', 'internal-plan.md'), 'private plan\n');

    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'AgentsToZ Test']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'fixture']);
    git(root, ['remote', 'add', 'publish', 'https://github.com/example/public.git']);

    const result = Bun.spawnSync({
      cmd: [process.execPath, publishScript, '--dry-run'],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(git(root, ['branch', '--show-current'])).toBe('main');
    const candidateRef = /candidate: (refs\/agentstoz\/publication-candidates\/[^ ]+) @/.exec(result.stdout.toString())?.[1];
    expect(candidateRef).toBeDefined();
    const publicTree = git(root, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', candidateRef!]).split('\n').filter(Boolean);
    expect(publicTree).toEqual(['README.md', 'uploaded-commands/실행.command']);
  });

  test('dry-run rejects canonical, generated-alias, and URL-encoded personal deployment references', () => {
    const projectPrefix = ['portmanager', 'portal'].join('-');
    const hostSuffix = ['vercel', 'app'].join('.');
    const generatedAlias = `${projectPrefix}-nogdsbmju-team-example.${hostSuffix}`;
    const cases = [
      projectPrefix,
      `${projectPrefix}-nogdsbmju-team-example`,
      `https://${projectPrefix}.${hostSuffix}`,
      `https://${generatedAlias}`,
      encodeURIComponent(`https://${generatedAlias}/guide`),
      encodeURIComponent(encodeURIComponent(`https://${generatedAlias}/guide`)),
      `ordinary modulo % plus ${encodeURIComponent(`https://${generatedAlias}/guide`)}`,
    ];

    for (const [index, reference] of cases.entries()) {
      const root = mkdtempSync(join(tmpdir(), `agentstoz-publish-private-url-${index}-`));
      roots.push(root);
      writeFileSync(join(root, 'README.md'), `do not publish ${reference}\n`);

      git(root, ['init', '-b', 'main']);
      git(root, ['config', 'user.name', 'AgentsToZ Test']);
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['add', '-A']);
      git(root, ['commit', '-m', 'fixture']);
      git(root, ['remote', 'add', 'publish', 'https://github.com/example/public.git']);

      const result = Bun.spawnSync({
        cmd: [process.execPath, publishScript, '--dry-run'],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode, reference).toBe(1);
      expect(result.stderr.toString(), reference).toContain('개인용 Vercel 배포 주소');
      expect(git(root, ['branch', '--show-current']), reference).toBe('main');
    }
  });

  test('dry-run rejects raw, remote URL, and encoded private source repository identities', () => {
    const owner = ['intenet1001', 'commits'].join('-');
    const repository = ['AgentsToZ', 'byCS'].join('_');
    const identity = `${owner}/${repository}`;
    const cases = [
      identity,
      `https://github.com/${identity}.git`,
      `git@github.com:${identity}.git`,
      encodeURIComponent(`https://github.com/${identity}.git`),
      encodeURIComponent(encodeURIComponent(`https://github.com/${identity}.git`)),
    ];

    for (const [index, reference] of cases.entries()) {
      const root = mkdtempSync(join(tmpdir(), `agentstoz-publish-private-source-${index}-`));
      roots.push(root);
      writeFileSync(join(root, 'README.md'), `do not publish ${reference}\n`);

      git(root, ['init', '-b', 'main']);
      git(root, ['config', 'user.name', 'AgentsToZ Test']);
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['add', '-A']);
      git(root, ['commit', '-m', 'fixture']);
      git(root, ['remote', 'add', 'publish', 'https://github.com/example/public.git']);

      const result = Bun.spawnSync({
        cmd: [process.execPath, publishScript, '--dry-run'],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode, reference).toBe(1);
      expect(result.stderr.toString(), reference).toContain('비공개 원본 GitHub 저장소 식별자');
      expect(git(root, ['branch', '--show-current']), reference).toBe('main');
    }
  });

  test('dry-run rejects a private Supabase ref learned only from an ignored local env file', () => {
    const privateProjectRef = ['private', 'project', 'ref', '9876'].join('');
    const privateUrl = `https://${privateProjectRef}.${['supabase', 'co'].join('.')}`;
    const cases = [
      privateProjectRef,
      privateUrl,
      encodeURIComponent(privateUrl),
      encodeURIComponent(encodeURIComponent(privateUrl)),
    ];

    for (const [index, reference] of cases.entries()) {
      const root = mkdtempSync(join(tmpdir(), `agentstoz-publish-private-db-${index}-`));
      roots.push(root);
      writeFileSync(join(root, '.gitignore'), '.env\n');
      writeFileSync(join(root, '.env'), `VITE_SUPABASE_URL=${privateUrl}\n`);
      writeFileSync(join(root, 'README.md'), `do not publish ${reference}\n`);

      git(root, ['init', '-b', 'main']);
      git(root, ['config', 'user.name', 'AgentsToZ Test']);
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['add', '-A']);
      git(root, ['commit', '-m', 'fixture']);
      git(root, ['remote', 'add', 'publish', 'https://github.com/example/public.git']);

      const result = Bun.spawnSync({
        cmd: [process.execPath, publishScript, '--dry-run'],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode, `case ${index}`).toBe(1);
      expect(result.stderr.toString()).toContain('개인 Supabase project ref');
      expect(result.stderr.toString()).not.toContain(privateProjectRef);
      expect(git(root, ['branch', '--show-current'])).toBe('main');
    }
  });

  test('dry-run rejects actual-shaped hosted Supabase URLs without a local env file', () => {
    const projectRef = ['unrelated', 'project', 'ref', '2468'].join('');
    const projectUrl = `https://${projectRef}.${['supabase', 'co'].join('.')}`;
    const cases = [
      projectUrl,
      encodeURIComponent(projectUrl),
      encodeURIComponent(encodeURIComponent(projectUrl)),
    ];

    for (const [index, reference] of cases.entries()) {
      const root = mkdtempSync(join(tmpdir(), `agentstoz-publish-hosted-db-${index}-`));
      roots.push(root);
      writeFileSync(join(root, 'README.md'), `do not publish ${reference}\n`);

      git(root, ['init', '-b', 'main']);
      git(root, ['config', 'user.name', 'AgentsToZ Test']);
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['add', '-A']);
      git(root, ['commit', '-m', 'fixture']);
      git(root, ['remote', 'add', 'publish', 'https://github.com/example/public.git']);

      const result = Bun.spawnSync({
        cmd: [process.execPath, publishScript, '--dry-run'],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode, `case ${index}`).toBe(1);
      expect(result.stderr.toString()).toContain('실제 Supabase project URL');
      expect(result.stderr.toString()).not.toContain(projectRef);
      expect(git(root, ['branch', '--show-current'])).toBe('main');
    }
  });
});
