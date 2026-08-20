export type OrcaWorktreeVisibility =
  | 'visible'
  | 'hidden-path'
  | 'unlisted'
  | 'unknown'
  | 'main';

export type OrcaWorktreeAction = 'claude' | 'codex' | 'agy' | 'hermes' | 'browser';
export type OrcaActionOutcome = 'succeeded' | 'attempted';

export interface OrcaWorktreeVisibilityInput {
  repositoryPath?: string | null;
  worktreePath?: string | null;
  isMain?: boolean;
  listingAvailable: boolean;
  listedPaths?: Iterable<string>;
}

export interface OrcaWorktreeActionNoticeInput {
  action: OrcaWorktreeAction;
  visibility: OrcaWorktreeVisibility;
  outcome?: OrcaActionOutcome;
}

/** Normalize only for local path identity checks; never use this as a shell argument. */
export function normalizeOrcaWorktreePath(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const slashed = trimmed.replace(/\\/g, '/');
  if (slashed === '/') return '/';
  if (/^[A-Za-z]:\/+$/u.test(slashed)) return `${slashed[0]!.toUpperCase()}:/`;
  return slashed.replace(/\/+$/u, '');
}

export function hasHiddenOrcaPathSegment(value?: string | null): boolean {
  const normalized = normalizeOrcaWorktreePath(value);
  if (!normalized) return false;
  return normalized.split('/').some(segment => segment.length > 1 && segment.startsWith('.'));
}

/** Classifies Orca sidebar visibility. Hidden paths are not safe launch targets:
 * Orca may create a backend PTY without attaching a visible pane. */
export function classifyOrcaWorktreeVisibility(
  input: OrcaWorktreeVisibilityInput,
): OrcaWorktreeVisibility {
  const repositoryPath = normalizeOrcaWorktreePath(input.repositoryPath);
  const worktreePath = normalizeOrcaWorktreePath(input.worktreePath);

  if (input.isMain === true || !worktreePath || worktreePath === repositoryPath) {
    return 'main';
  }
  if (hasHiddenOrcaPathSegment(worktreePath)) return 'hidden-path';

  const listed = new Set(
    Array.from(input.listedPaths ?? [])
      .map(normalizeOrcaWorktreePath)
      .filter((path): path is string => !!path),
  );
  if (listed.has(worktreePath)) return 'visible';
  return input.listingAvailable ? 'unlisted' : 'unknown';
}

const ACTION_DESCRIPTION: Record<OrcaWorktreeAction, string> = {
  claude: 'Claude 실행',
  codex: 'Codex 실행',
  agy: 'Antigravity(agy) 실행',
  hermes: 'Hermes CLI 실행',
  browser: 'localhost 브라우저 탭 열기',
};

/** Build the notice shown after an Orca action succeeds or is attempted. */
export function formatOrcaWorktreeActionNotice(
  input: OrcaWorktreeActionNoticeInput,
): string {
  const action = ACTION_DESCRIPTION[input.action];
  const result = input.outcome === 'attempted'
    ? `${action}를 시도했습니다.`
    : `${action}에 성공했습니다.`;

  switch (input.visibility) {
    case 'main':
      return `Orca 메인 프로젝트에서 ${result}`;
    case 'visible':
      return `Orca 워크트리에서 ${result} 사이드바의 별도 카드에서 확인할 수 있습니다.`;
    case 'hidden-path':
      return `숨김 경로 워크트리는 Orca 화면에 연결되지 않는 세션이 생성될 수 있어 ${action}을 차단했습니다. 먼저 “새 경로로 옮기기”를 실행하세요.`;
    case 'unlisted':
      return `Orca exact path(정확한 워크트리 경로)로 ${result} 이 워크트리는 Orca 사이드바에 아직 별도 카드로 표시되지 않습니다.`;
    case 'unknown':
      return `Orca exact path(정확한 워크트리 경로)로 ${result} Orca 사이드바의 별도 카드 표시 여부는 현재 확인하지 못했습니다.`;
  }
}

/**
 * Orca answers `selector_not_found` when a `path:` worktree selector names a
 * location it has no worktree for — typically an ordinary folder or a repo the
 * user never registered. The floating workspace is not bound to a repository,
 * so it can host that terminal instead of failing the launch outright.
 */
export function isOrcaWorktreeSelectorMissing(error?: string | null): boolean {
  return /selector_not_found/i.test(error ?? '');
}

/**
 * Whether a failed worktree-terminal attempt should fall back to the Floating
 * workspace instead of hard-failing the launch. Covers two shapes:
 *
 * - `selector_not_found` — Orca does not track this path as a worktree at all;
 *   Floating never needed the selector, so it is unaffected either way.
 * - a bare `unknown` (after the retry wrapper's own attempts are exhausted) —
 *   the CLI call itself returned no parseable output, most often because the
 *   Orca daemon was briefly unresponsive under load. That case is
 *   indistinguishable from `selector_not_found` from the caller's side, and
 *   Floating is strictly safer than surfacing an opaque "unknown" error for
 *   a worktree the user has clicked into before without issue.
 *
 * Deliberately narrower than "any failure" — a deterministic error such as
 * "not a valid git repository" would fail in Floating too, so it is left to
 * surface as a real error instead of being silently swallowed.
 */
export function shouldFallBackToOrcaFloatingTerminal(error?: string | null): boolean {
  if (isOrcaWorktreeSelectorMissing(error)) return true;
  return /:\s*unknown$/i.test((error ?? '').trim());
}

/** Explain the surface substitution in the message. Silently opening a
 * different surface than the one selected would be its own bug. */
export function formatOrcaFloatingFallbackNotice(worktreePath?: string | null): string {
  const target = worktreePath?.trim();
  return 'Orca에 등록된 워크트리가 아니라 워크트리 내부 터미널을 만들 수 없어 Floating Terminal로 열었습니다.'
    + (target ? ` (${target})` : '')
    + '\n워크트리 내부에서 열려면 Orca에 해당 저장소를 먼저 추가하세요.';
}

/**
 * Which surface an Orca launch actually landed on, read back from the backend's own
 * success message — not re-derived from what the frontend originally requested.
 *
 * The web (api-server.ts) and desktop (src-tauri) backends can silently substitute
 * Floating for a worktree-internal request (see `shouldFallBackToOrcaFloatingTerminal`),
 * and the Tauri command only returns a plain string, so the message text is the one
 * place the caller can learn what really happened. Both backends share the exact
 * wording `Orca Floating Terminal에` / `Orca 워크트리 터미널에` for a fresh launch, and
 * only Floating tracks tab reuse (`...재사용했습니다`), so the message alone determines
 * the surface without guessing. Trusting the caller's original request instead produces
 * a toast that names both surfaces for the same action — reported 2026-08-10 on a
 * project whose worktree Orca had silently lost (see the recurring-issues memory entry).
 */
export function orcaSurfaceFromLaunchMessage(backendMessage: string): 'floating' | 'worktree' | null {
  if (/재사용했습니다/.test(backendMessage)) return 'floating';
  if (/Floating Terminal/.test(backendMessage)) return 'floating';
  if (/워크트리 터미널/.test(backendMessage)) return 'worktree';
  return null;
}
