import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuildInfo } from '../build-info';
import { deriveBuildNumber, gitRunner, readBuildNumberFile, restoreVersionFiles } from '../buildVersion';

// A week of `chore: bump to vN` commits was 72 of 157 on main, and a second Mac building the same
// commit produced its own number (v625 vs v626). The number now comes from git history.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function repo(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-build-version-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src-tauri'));
  writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), '{"version":"625.0.0"}\n');
  writeFileSync(join(root, 'build-number.json'), '{"buildNumber":625}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'build-number.json'), JSON.stringify({ buildNumber: 625, baseCommit: base }) + '\n');
  git(root, 'commit', '-qam', 'anchor');
  return { root, base };
}

describe('build number from git history', () => {
  test('anchor + commits since the base commit, the same on every clone of that commit', () => {
    const { root } = repo();
    for (const name of ['a', 'b', 'c']) { writeFileSync(join(root, name), name); git(root, 'add', name); git(root, 'commit', '-qm', name); }
    const derived = deriveBuildNumber(readBuildNumberFile(root), gitRunner(root));
    expect(derived).toMatchObject({ ok: true, buildNumber: 625 + 4, derived: true });

    const clone = mkdtempSync(join(tmpdir(), 'agentstoz-build-version-clone-'));
    roots.push(clone);
    git(clone, 'clone', '-q', root, '.');
    expect(deriveBuildNumber(readBuildNumberFile(clone), gitRunner(clone))).toMatchObject({ ok: true, buildNumber: 629 });
  });

  test('a shallow clone cannot count — it says so instead of guessing', () => {
    const { root } = repo();
    writeFileSync(join(root, 'x'), 'x'); git(root, 'add', 'x'); git(root, 'commit', '-qm', 'x');
    const shallow = mkdtempSync(join(tmpdir(), 'agentstoz-build-version-shallow-'));
    roots.push(shallow);
    git(shallow, 'clone', '-q', '--depth', '1', `file://${root}`, '.');
    const derived = deriveBuildNumber(readBuildNumberFile(shallow), gitRunner(shallow));
    expect(derived.ok).toBe(false);
    expect(derived.buildNumber).toBe(625);
    // Display-only builds (the Vercel portal) fall back to the anchor rather than failing the deploy.
    expect(createBuildInfo({ root: shallow, tauriVersionPolicy: 'if-present' }).buildNumber).toBe(625);
  });

  test('a number already written for this build is taken as is — readers never count twice', () => {
    const { root } = repo();
    writeFileSync(join(root, 'build-number.json'), JSON.stringify({ buildNumber: 640, derivedFrom: { buildNumber: 625, baseCommit: 'x', head: 'y' } }));
    writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), '{"version":"640.0.0"}\n');
    expect(deriveBuildNumber(readBuildNumberFile(root), gitRunner(root))).toMatchObject({ ok: true, buildNumber: 640, derived: false });
    expect(createBuildInfo({ root }).buildNumber).toBe(640);
  });

  test('the displayed number is derived while the tracked files stay consistent with each other', () => {
    const { root } = repo();
    writeFileSync(join(root, 'y'), 'y'); git(root, 'add', 'y'); git(root, 'commit', '-qm', 'y');
    expect(createBuildInfo({ root })).toMatchObject({ buildNumber: 627, version: '627.0.0' });
    writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), '{"version":"600.0.0"}\n');
    expect(() => createBuildInfo({ root })).toThrow('Build version mismatch');
  });

  test('the Vercel portal build keeps the git history it counts from', () => {
    // .vercelignore deleted .git right after Vercel's clone, so the web portal showed the anchor (625)
    // even with VERCEL_DEEP_CLONE on.
    const ignored = readFileSync(new URL('../.vercelignore', import.meta.url), 'utf8').split('\n').map(line => line.trim());
    expect(ignored).not.toContain('.git');
  });

  test('restoring puts the version files back to the committed anchor', () => {
    const { root } = repo();
    const committed = readFileSync(join(root, 'build-number.json'), 'utf8');
    writeFileSync(join(root, 'build-number.json'), '{"buildNumber":700}\n');
    writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), '{"version":"700.0.0"}\n');
    restoreVersionFiles(gitRunner(root));
    expect(readFileSync(join(root, 'build-number.json'), 'utf8')).toBe(committed);
    expect(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).toBe('{"version":"625.0.0"}\n');
  });
});

test('a Windows build restores the launcher lockfile with the other version files', async () => {
  // The launcher package depends on the app crate by path; a build that rewrites the app version also rewrites
  // that lockfile. Left out of the list, every Windows build left `src-tauri/windows-contain/Cargo.lock` modified (2호, 2026-10-08).
  const { VERSION_FILES } = await import('../buildVersion');
  expect(VERSION_FILES).toContain('src-tauri/windows-contain/Cargo.lock');
});
