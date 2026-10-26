import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const publishScript = resolve(import.meta.dir, '../scripts/publish.ts');
const roots: string[] = [];
const publicUrl = 'https://github.com/example/public.git';
const realGit = Bun.which('git')!;

function git(root: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: [realGit, ...args], cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`fixture git failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'agentstoz-public-append-'));
  roots.push(base);
  const source = join(base, 'source'), published = join(base, 'published'), remote = join(base, 'public.git');
  const client = join(base, 'other-mac'), bin = join(base, 'bin'), log = join(base, 'network.jsonl');
  for (const path of [source, published, bin]) mkdirSync(path);
  git(base, ['init', '--bare', '--initial-branch=main', remote]);
  for (const root of [source, published]) {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'AgentsToZ Test']);
    git(root, ['config', 'user.email', 'test@example.com']);
  }
  writeFileSync(join(published, 'README.md'), 'old public source\n');
  git(published, ['add', '-A']); git(published, ['commit', '-m', 'existing public snapshot']);
  git(published, ['push', remote, 'HEAD:refs/heads/main']);
  const publicParent = git(published, ['rev-parse', 'HEAD']);
  git(base, ['clone', remote, client]);
  writeFileSync(join(source, 'CLAUDE.md'), 'private operating notes excluded from publication\n');
  writeFileSync(join(source, 'README.md'), 'private development start\n');
  git(source, ['add', '-A']); git(source, ['commit', '-m', 'private source history']);
  writeFileSync(join(source, 'README.md'), 'new sanitized public source\n');
  git(source, ['add', '-A']); git(source, ['commit', '-m', 'current source']);
  const sourceHead = git(source, ['rev-parse', 'HEAD']);
  git(source, ['remote', 'add', 'origin', 'https://github.com/example/private-source.git']);
  git(source, ['remote', 'add', 'publish', publicUrl]);

  // Only GitHub transport is replaced with the local bare fixture. Unknown network
  // destinations fail instead of touching an external repository.
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\n` + String.raw`
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), network = ['ls-remote', 'fetch', 'push'].includes(args[0]);
if (network) {
  appendFileSync(process.env.APPEND_FIXTURE_LOG, JSON.stringify(args) + '\n');
  if (!args.includes(process.env.APPEND_FIXTURE_URL)) process.exit(91);
}
const actual = args.map(arg => network && arg === process.env.APPEND_FIXTURE_URL ? process.env.APPEND_FIXTURE_REMOTE : arg);
const result = Bun.spawnSync({ cmd: [process.env.APPEND_FIXTURE_GIT, ...actual], stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' });
if (args[0] === 'fetch' && result.exitCode === 0) {
  if (process.env.APPEND_FIXTURE_CORRUPT_FETCH === '1') {
    writeFileSync('.git/FETCH_HEAD', process.env.APPEND_FIXTURE_SOURCE + '\t\tfixture\n');
  }
  if (process.env.APPEND_FIXTURE_ADVANCE) {
    const moved = Bun.spawnSync({ cmd: [process.env.APPEND_FIXTURE_GIT, '--git-dir=' + process.env.APPEND_FIXTURE_REMOTE, 'update-ref', 'refs/heads/main', process.env.APPEND_FIXTURE_ADVANCE] });
    if (moved.exitCode !== 0) process.exit(92);
  }
}
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.exitCode);
`);
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\n` + String.raw`
process.stdout.write(JSON.stringify({ viewerPermission: 'WRITE', visibility: process.env.APPEND_FIXTURE_VISIBILITY || 'PUBLIC', nameWithOwner: 'example/public' }));
`);
  for (const name of ['git', 'gh']) chmodSync(join(bin, name), 0o755);
  const run = (args: string[], extra: Record<string, string> = {}) => Bun.spawnSync({
    cmd: [process.execPath, publishScript, ...args], cwd: source, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, APPEND_FIXTURE_LOG: log,
      APPEND_FIXTURE_URL: publicUrl, APPEND_FIXTURE_REMOTE: remote, APPEND_FIXTURE_GIT: realGit,
      APPEND_FIXTURE_SOURCE: sourceHead, ...extra },
  });
  const network = (): string[][] => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { source, published, remote, client, publicParent, sourceHead, run, network };
}

describe('opt-in public history continuation', () => {
  test('publishes one child of the observed public main and an existing clone can fast-forward pull', () => {
    const f = fixture(), index = readFileSync(join(f.source, '.git', 'index'));
    const result = f.run(['--append-public-history']);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const candidate = git(f.source, ['for-each-ref', '--format=%(objectname)', 'refs/agentstoz/publication-candidates/']);
    expect(git(f.source, ['show', '-s', '--format=%P', candidate])).toBe(f.publicParent);
    expect(git(f.source, ['rev-list', candidate, '--not', f.publicParent])).toBe(candidate);
    expect(Bun.spawnSync({ cmd: [realGit, 'merge-base', '--is-ancestor', f.sourceHead, candidate], cwd: f.source }).exitCode).toBe(1);
    expect(git(f.source, ['ls-tree', '-r', '--name-only', candidate])).toBe('README.md');
    expect(git(f.source, ['rev-parse', 'HEAD'])).toBe(f.sourceHead);
    expect(readFileSync(join(f.source, '.git', 'index')).equals(index)).toBe(true);
    const fetch = f.network().find(args => args[0] === 'fetch')!;
    expect(fetch).toEqual(['fetch', '--no-tags', '--no-recurse-submodules', publicUrl, f.publicParent]);
    const pushes = f.network().filter(args => args[0] === 'push');
    expect(pushes).toHaveLength(2);
    expect(pushes.every(args => args.includes(`--force-with-lease=refs/heads/main:${f.publicParent}`))).toBe(true);
    expect(git(f.client, ['pull', '--ff-only'])).toContain('Fast-forward');
    expect(readFileSync(join(f.client, 'README.md'), 'utf8')).toBe('new sanitized public source\n');
  });

  test('append dry-run proves the same parent and leaves the remote unchanged', () => {
    const f = fixture();
    const result = f.run(['--append-public-history', '--dry-run']);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const candidate = git(f.source, ['for-each-ref', '--format=%(objectname)', 'refs/agentstoz/publication-candidates/']);
    expect(git(f.source, ['show', '-s', '--format=%P', candidate])).toBe(f.publicParent);
    expect(git(f.remote, ['rev-parse', 'refs/heads/main'])).toBe(f.publicParent);
    expect(f.network().filter(args => args[0] === 'push')).toEqual([]);
  });

  test('refuses a non-public target before fetching or creating a candidate', () => {
    const f = fixture();
    const result = f.run(['--append-public-history', '--dry-run'], { APPEND_FIXTURE_VISIBILITY: 'PRIVATE' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('PUBLISH_REPOSITORY_NOT_PUBLIC');
    expect(f.network()).toEqual([]);
    expect(git(f.source, ['for-each-ref', '--format=%(refname)', 'refs/agentstoz/publication-candidates/'])).toBe('');
  });

  test('refuses FETCH_HEAD that does not prove the captured remote commit', () => {
    const f = fixture();
    const result = f.run(['--append-public-history', '--dry-run'], { APPEND_FIXTURE_CORRUPT_FETCH: '1' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('PUBLISH_PUBLIC_PARENT_PROVENANCE');
    expect(git(f.source, ['for-each-ref', '--format=%(refname)', 'refs/agentstoz/publication-candidates/'])).toBe('');
    expect(f.network().filter(args => args[0] === 'push')).toEqual([]);
  });

  test('a concurrently advanced remote cannot get a new lease for an old-parent candidate', () => {
    const f = fixture();
    writeFileSync(join(f.published, 'README.md'), 'another publisher advanced main\n');
    git(f.published, ['add', '-A']); git(f.published, ['commit', '-m', 'concurrent public update']);
    git(f.published, ['push', f.remote, 'HEAD:refs/heads/staged']);
    const advanced = git(f.published, ['rev-parse', 'HEAD']);
    const result = f.run(['--append-public-history'], { APPEND_FIXTURE_ADVANCE: advanced });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('PUBLISH_PUBLIC_PARENT_CHANGED');
    expect(git(f.remote, ['rev-parse', 'refs/heads/main'])).toBe(advanced);
    expect(f.network().filter(args => args[0] === 'push')).toEqual([]);
  });
});
