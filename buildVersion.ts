import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The build number comes from git history, not from a bump commit.
 *
 * Every build used to increment build-number.json and commit 12 version files
 * (`chore: bump to vN`). Over one week that was 72 of 157 commits on main — the
 * log was half version noise — and a second Mac building the same commit
 * (3호) produced its own number, so the same source shipped as v625 and v626.
 *
 * Now the committed file is an anchor `{buildNumber, baseCommit}` and a build's
 * number is `buildNumber + commits since baseCommit`. The same commit gets the
 * same number on every machine, and building writes the version files in place
 * without committing them (`restoreVersionFiles` puts them back).
 *
 * While a build runs, build-number.json holds the derived number and no
 * `baseCommit` (`derivedFrom` records where it came from), so readers that
 * look at the file mid-build — the sidecar's MCP version, stamp-icon.py,
 * Vite — take the number as is and never count twice.
 */
export interface BuildNumberFile {
  buildNumber: number;
  baseCommit?: string;
  derivedFrom?: { buildNumber: number; baseCommit: string; head: string };
}

export interface GitResult { exitCode: number; stdout: string; stderr: string }
export type RunGit = (args: string[]) => GitResult;

/** Files a build rewrites in place; all of them are restored from git afterwards. */
export const VERSION_FILES = [
  'build-number.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  // The Windows launcher package (windows-contain) depends on the app crate by path, so a Windows build rewrites
  // the app's version in its lockfile too. Restored with the rest, or every Windows build left the tree dirty.
  'src-tauri/windows-contain/Cargo.lock',
  'src-tauri/icons',
  'mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj',
] as const;

const SHA_RE = /^[0-9a-f]{40}$/;

export function readBuildNumberFile(root: string): BuildNumberFile {
  const path = join(root, 'build-number.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BuildNumberFile>;
  if (typeof parsed.buildNumber !== 'number' || !Number.isInteger(parsed.buildNumber) || parsed.buildNumber < 0) {
    throw new Error(`Invalid buildNumber in ${path}`);
  }
  if (parsed.baseCommit !== undefined && !SHA_RE.test(parsed.baseCommit)) {
    throw new Error(`Invalid baseCommit in ${path}`);
  }
  return parsed as BuildNumberFile;
}

/** node:child_process, not Bun.spawnSync — Vite loads build-info.ts under Node (Vercel runs `npx vite build`). */
export function gitRunner(root: string): RunGit {
  return args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

export type DerivedBuildNumber =
  | { ok: true; buildNumber: number; head: string; derived: boolean }
  | { ok: false; buildNumber: number; reason: string };

/**
 * The number for HEAD. `ok:false` means the history needed to count is not
 * here (a shallow clone, e.g. Vercel) — callers that ship an artifact must
 * refuse; display-only callers may fall back to the anchor number.
 */
export function deriveBuildNumber(file: BuildNumberFile, runGit: RunGit): DerivedBuildNumber {
  if (!file.baseCommit) {
    // Already derived for this build (or an old file without an anchor): take it as is.
    const head = runGit(['rev-parse', 'HEAD']);
    return { ok: true, buildNumber: file.buildNumber, head: head.exitCode === 0 ? head.stdout.trim() : '', derived: false };
  }
  const head = runGit(['rev-parse', 'HEAD']);
  if (head.exitCode !== 0) return { ok: false, buildNumber: file.buildNumber, reason: 'HEAD를 읽지 못했습니다' };
  const ancestor = runGit(['merge-base', '--is-ancestor', file.baseCommit, 'HEAD']);
  if (ancestor.exitCode !== 0) {
    return {
      ok: false,
      buildNumber: file.buildNumber,
      reason: `기준 커밋 ${file.baseCommit.slice(0, 8)}이 이 체크아웃의 기록에 없습니다(얕은 clone이면 전체 기록을 받으세요)`,
    };
  }
  const count = runGit(['rev-list', '--count', `${file.baseCommit}..HEAD`]);
  const commits = Number(count.stdout.trim());
  if (count.exitCode !== 0 || !Number.isInteger(commits) || commits < 0) {
    return { ok: false, buildNumber: file.buildNumber, reason: '커밋 수를 세지 못했습니다' };
  }
  return { ok: true, buildNumber: file.buildNumber + commits, head: head.stdout.trim(), derived: true };
}

/** Put every version file back to its committed content. Safe to call more than once. */
export function restoreVersionFiles(runGit: RunGit): boolean {
  // One path at a time: a single checkout fails as a whole when any pathspec is untracked.
  const tracked = VERSION_FILES.filter(path => runGit(['ls-files', '--error-unmatch', '--', path]).exitCode === 0);
  return tracked.every(path => runGit(['checkout', '--', path]).exitCode === 0);
}
