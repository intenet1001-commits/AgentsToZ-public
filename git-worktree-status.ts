export interface ParsedGitCheckoutStatus {
  changedFiles: number;
  stagedFiles: number;
  untrackedFiles: number;
  conflictedFiles: number;
  hasCommits: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
}

/**
 * Runtime artifacts that can keep changing while the app is open.
 * They are intentionally excluded from the app's Git action indicator and
 * automatic `git add` so a successful Push does not immediately light Commit
 * back up. Users can still add one explicitly from a terminal with `git add -f`.
 */
export const GIT_VOLATILE_ARTIFACT_PATHSPECS = [
  ':(exclude).playwright-cli/**',
  ':(exclude)output/playwright/**',
  ':(exclude).DS_Store',
  ':(exclude)**/.DS_Store',
  ':(exclude).agent-memory/backups/**',
  // 활동 훅이 AI 프롬프트마다 다시 쓰는 런타임 상태(마지막 활동 시각). 추적 파일이라
  // 여기서 빼지 않으면 AI를 한 번만 써도 "커밋되지 않은 변경"이 생겨 워크트리 생성이
  // 막힌다 — 앱이 만든 변경 때문에 앱 기능이 막히는 상태가 된다.
  ':(exclude).agent-memory/activity.json',
  ':(exclude).env',
  ':(exclude).env.*',
  ':(exclude)**/.env',
  ':(exclude)**/.env.*',
] as const;

/**
 * Same paths as GIT_VOLATILE_ARTIFACT_PATHSPECS but without `:(exclude)` magic, for use with
 * `git reset --` (which doesn't understand exclude pathspecs). `git add -A -- . <excludes>`
 * fails outright when any excluded path is *also* gitignored — git raises "paths ignored by
 * .gitignore" and exits non-zero before staging anything, regardless of the exclude magic.
 * The safe pattern is: `git add -A -- .` (plain, respects .gitignore) then
 * `git reset -- ...GIT_VOLATILE_ARTIFACT_PATHS` to unstage these paths in repos where they
 * happen to be tracked.
 */
export const GIT_VOLATILE_ARTIFACT_PATHS = [
  '.playwright-cli',
  'output/playwright',
  '.DS_Store',
  '**/.DS_Store',
  '.agent-memory/backups',
  '.agent-memory/activity.json',
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
] as const;

export function isGitHubRemoteUrl(remoteUrl: string): boolean {
  const trimmed = remoteUrl.trim();
  if (/^git@github\.com:[^/]+\/.+/i.test(trimmed)) return true;
  try {
    return new URL(trimmed).hostname.toLowerCase() === 'github.com';
  } catch {
    return false;
  }
}

/**
 * Parses `git status --porcelain=v2 --branch --untracked-files=normal`.
 * Keeping this parser pure makes the status contract independently testable
 * while the Bun and Tauri runtimes own their respective process execution.
 */
export function parseGitStatusPorcelainV2(text: string): ParsedGitCheckoutStatus {
  let changedFiles = 0;
  let stagedFiles = 0;
  let untrackedFiles = 0;
  let conflictedFiles = 0;
  let hasCommits = false;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) {
      hasCommits = line.slice('# branch.oid '.length).trim() !== '(initial)';
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim() || undefined;
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/# branch\.ab \+(\d+) -(\d+)/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith('? ')) {
      changedFiles++;
      untrackedFiles++;
      continue;
    }
    if (line.startsWith('u ')) {
      changedFiles++;
      conflictedFiles++;
      continue;
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      changedFiles++;
      const xy = line.slice(2).split(' ', 1)[0] ?? '..';
      if (xy[0] && xy[0] !== '.') stagedFiles++;
    }
  }

  return {
    changedFiles,
    stagedFiles,
    untrackedFiles,
    conflictedFiles,
    hasCommits,
    upstream,
    ahead,
    behind,
  };
}
