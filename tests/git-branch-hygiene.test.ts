import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGitBranchHygienePrompt,
  summarizeGitBranchHygiene,
} from '../src/gitBranchHygiene';
import { startTestApiServer } from './startTestApiServer';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const roots: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

describe('Git branch hygiene harness', () => {
  test('uses the observed remote default instead of assuming main', () => {
    const summary = summarizeGitBranchHygiene({
      defaultBranch: 'trunk',
      defaultRemoteRef: 'origin/trunk',
      defaultReliable: true,
      now: NOW,
      observations: [
        { name: 'trunk', scope: 'local', checkedOut: true, uniqueCommits: 0, behindDefault: 0, upstream: 'origin/trunk', lastCommitAt: '2026-08-31T10:00:00.000Z' },
        { name: 'codex/done', scope: 'local', checkedOut: false, uniqueCommits: 0, behindDefault: 3, upstream: 'origin/codex/done', lastCommitAt: '2026-08-30T10:00:00.000Z' },
        { name: 'origin/trunk', scope: 'remote', checkedOut: false, uniqueCommits: 0, behindDefault: 0, upstream: null, lastCommitAt: '2026-08-31T10:00:00.000Z' },
      ],
    });

    expect(summary.defaultBranch).toBe('trunk');
    expect(summary.safeDeleteCount).toBe(1);
    expect(summary.branches.find(branch => branch.name === 'codex/done')?.recommendation).toBe('delete-merged');
    expect(summary.branches.find(branch => branch.name === 'trunk')?.recommendation).toBe('keep-default');
  });

  test('never labels a branch safe to delete without reliable default evidence', () => {
    const summary = summarizeGitBranchHygiene({
      defaultBranch: 'main',
      defaultRemoteRef: null,
      defaultReliable: false,
      now: NOW,
      observations: [
        { name: 'old', scope: 'local', checkedOut: false, uniqueCommits: 0, behindDefault: 10, upstream: null, lastCommitAt: '2026-06-01T00:00:00.000Z' },
      ],
    });

    expect(summary.safeDeleteCount).toBe(0);
    expect(summary.branches[0]?.mergedIntoDefault).toBeNull();
    expect(summary.branches[0]?.recommendation).toBe('review-stale');
  });

  test('protects checked-out worktrees and flags old unpublished branches for review', () => {
    const summary = summarizeGitBranchHygiene({
      defaultBranch: 'main',
      defaultRemoteRef: 'origin/main',
      defaultReliable: true,
      now: NOW,
      observations: [
        { name: 'main', scope: 'local', checkedOut: true, uniqueCommits: 0, behindDefault: 0, upstream: 'origin/main', lastCommitAt: '2026-08-31T10:00:00.000Z' },
        { name: 'codex/live', scope: 'local', checkedOut: true, uniqueCommits: 2, behindDefault: 0, upstream: null, lastCommitAt: '2026-06-01T00:00:00.000Z' },
        { name: 'codex/forgotten', scope: 'local', checkedOut: false, uniqueCommits: 1, behindDefault: 20, upstream: null, lastCommitAt: '2026-08-01T00:00:00.000Z' },
      ],
    });

    expect(summary.branches.find(branch => branch.name === 'codex/live')?.recommendation).toBe('keep-active');
    expect(summary.branches.find(branch => branch.name === 'codex/forgotten')?.recommendation).toBe('review-unpublished');
    expect(summary.needsAttention).toBeTrue();
  });

  test('prompt preserves user work and prohibits destructive shortcuts', () => {
    const summary = summarizeGitBranchHygiene({
      defaultBranch: 'main',
      defaultRemoteRef: 'origin/main',
      defaultReliable: true,
      now: NOW,
      observations: [
        { name: 'codex/done', scope: 'local', checkedOut: false, uniqueCommits: 0, behindDefault: 2, upstream: 'origin/codex/done', lastCommitAt: '2026-08-20T00:00:00.000Z' },
      ],
    });
    const prompt = buildGitBranchHygienePrompt({ folderPath: '/project', projectName: 'Project', summary });

    expect(prompt).toContain('원격의 실제 기본 브랜치');
    expect(prompt).toContain('worktree list --porcelain');
    expect(prompt).toContain('reset --hard');
    expect(prompt).toContain('force push');
    expect(prompt).toContain('codex/done');
    expect(prompt).toContain('삭제 승인이 아닙니다');
  });

  test('real local API observes origin HEAD, checked-out worktrees, and merged branches without mutating Git', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-branch-hygiene-'));
    roots.push(home);
    const repo = join(home, 'project');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'trunk']);
    git(repo, ['config', 'user.email', 'branch-hygiene@example.invalid']);
    git(repo, ['config', 'user.name', 'Branch Hygiene Test']);
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-q', '-m', 'base']);
    git(repo, ['branch', 'done']);
    git(repo, ['update-ref', 'refs/remotes/origin/trunk', 'HEAD']);
    git(repo, ['update-ref', 'refs/remotes/origin/done', 'refs/heads/done']);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
    const before = git(repo, ['show-ref']);

    const server = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        HOME: home,
        APPDATA: join(home, 'AppData', 'Roaming'),
        XDG_CONFIG_HOME: join(home, '.config'),
        NODE_ENV: 'test',
        PORT: '19000',
        AGENTSTOZ_SKIP_HERMES_SYNC: '1',
      },
    });
    children.push(server.child);
    const response = await fetch(`${server.baseUrl}/api/git-branch-hygiene`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath: repo }),
    });
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.success).toBeTrue();
    expect(body.summary).toMatchObject({
      defaultBranch: 'trunk',
      defaultRemoteRef: 'origin/trunk',
      defaultReliable: true,
      safeDeleteCount: 2,
    });
    expect(body.summary.branches.find((branch: any) => branch.name === 'trunk')).toMatchObject({
      checkedOut: true,
      recommendation: 'keep-default',
    });
    expect(body.summary.branches.find((branch: any) => branch.name === 'done' as string)).toMatchObject({
      checkedOut: false,
      recommendation: 'delete-merged',
    });
    expect(git(repo, ['show-ref'])).toBe(before);
  });

  test('App surfaces the harness and only offers an AI cleanup prompt', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('data-testid="branch-hygiene-harness"');
    expect(app).toContain('브랜치 정리 필요');
    expect(app).toContain('AI에게 정리 맡기기');
    expect(app).toContain('buildGitBranchHygienePrompt');
    expect(app).not.toContain('autoDeleteGitBranches');
  });
});
