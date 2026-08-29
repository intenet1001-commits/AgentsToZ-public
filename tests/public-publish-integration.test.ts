import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  test('dry-run excludes every private-only path and returns to main', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-publish-'));
    roots.push(root);
    mkdirSync(join(root, 'docs', 'superpowers'), { recursive: true });
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
    const publicTree = git(root, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'publish-clean']).split('\n').filter(Boolean);
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
