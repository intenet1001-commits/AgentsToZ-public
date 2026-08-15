import { describe, expect, test } from 'bun:test';
import {
  classifyOrcaWorktreeVisibility,
  formatOrcaFloatingFallbackNotice,
  formatOrcaWorktreeActionNotice,
  hasHiddenOrcaPathSegment,
  isOrcaWorktreeSelectorMissing,
  normalizeOrcaWorktreePath,
  orcaSurfaceFromLaunchMessage,
  shouldFallBackToOrcaFloatingTerminal,
  type OrcaWorktreeAction,
  type OrcaWorktreeVisibility,
} from '../src/orcaWorktreeSupport';

describe('Orca worktree sidebar visibility', () => {
  test.each([
    {
      name: 'main when no linked worktree is selected',
      input: { repositoryPath: '/repo', listingAvailable: true },
      expected: 'main',
    },
    {
      name: 'main when repository and selected path are identical after normalization',
      input: { repositoryPath: '/repo/', worktreePath: '/repo', listingAvailable: true },
      expected: 'main',
    },
    {
      name: 'hidden path even when a stale Orca list contains it',
      input: {
        repositoryPath: '/repo',
        worktreePath: '/repo/.claude/worktrees/test/',
        listingAvailable: true,
        listedPaths: ['/repo/.claude/worktrees/test'],
      },
      expected: 'hidden-path',
    },
    {
      name: 'visible when the normalized exact path is listed',
      input: {
        repositoryPath: '/repo',
        worktreePath: '/repo/worktrees/test/',
        listingAvailable: true,
        listedPaths: ['/repo/worktrees/test'],
      },
      expected: 'visible',
    },
    {
      name: 'unlisted when Orca answered without the path',
      input: {
        repositoryPath: '/repo',
        worktreePath: '/repo/worktrees/test',
        listingAvailable: true,
        listedPaths: [],
      },
      expected: 'unlisted',
    },
    {
      name: 'unknown when the Orca list is unavailable',
      input: {
        repositoryPath: '/repo',
        worktreePath: '/repo/worktrees/test',
        listingAvailable: false,
      },
      expected: 'unknown',
    },
  ] as const)('$name', ({ input, expected }) => {
    expect(classifyOrcaWorktreeVisibility(input)).toBe(expected);
  });

  test('normalizes Windows separators and detects hidden segments', () => {
    expect(normalizeOrcaWorktreePath('C:\\repo\\worktrees\\test\\')).toBe('C:/repo/worktrees/test');
    expect(hasHiddenOrcaPathSegment('C:\\repo\\.claude\\worktrees\\test')).toBe(true);
  });
});

describe('Orca exact-path action notices', () => {
  const actions: OrcaWorktreeAction[] = ['claude', 'codex', 'agy', 'hermes', 'browser'];
  const actionText: Record<OrcaWorktreeAction, string> = {
    claude: 'Claude 실행',
    codex: 'Codex 실행',
    agy: 'Antigravity(agy) 실행',
    hermes: 'Hermes CLI 실행',
    browser: 'localhost 브라우저 탭 열기',
  };

  for (const action of actions) {
    test(`${action} hidden-path is blocked with migration guidance`, () => {
      const notice = formatOrcaWorktreeActionNotice({ action, visibility: 'hidden-path' });
      expect(notice).toContain(actionText[action]);
      expect(notice).toContain('차단했습니다');
      expect(notice).toContain('새 경로로 옮기기');
      expect(notice).not.toContain('성공했습니다');
    });

    test(`${action} hidden-path attempted state is still reported as blocked`, () => {
      const notice = formatOrcaWorktreeActionNotice({
        action,
        visibility: 'hidden-path',
        outcome: 'attempted',
      });
      expect(notice).toContain('차단했습니다');
      expect(notice).toContain('새 경로로 옮기기');
      expect(notice).not.toContain('시도했습니다');
    });
  }

  test.each([
    ['main', '메인 프로젝트'],
    ['visible', '사이드바의 별도 카드에서 확인'],
    ['unlisted', '아직 별도 카드로 표시되지 않습니다'],
    ['unknown', '표시 여부는 현재 확인하지 못했습니다'],
  ] as const)('%s visibility has a distinct notice', (visibility, expected) => {
    const notice = formatOrcaWorktreeActionNotice({
      action: 'claude',
      visibility: visibility as OrcaWorktreeVisibility,
    });
    expect(notice).toContain(expected);
    expect(notice).not.toContain('지원하지');
  });

  test('recognizes the missing-worktree selector Orca reports for untracked paths', () => {
    // Verbatim from the reported failure on a plugin marketplace checkout.
    expect(isOrcaWorktreeSelectorMissing('Orca 워크트리 터미널 생성 실패: selector_not_found')).toBe(true);
    expect(isOrcaWorktreeSelectorMissing('SELECTOR_NOT_FOUND')).toBe(true);
    expect(isOrcaWorktreeSelectorMissing('daemon timeout')).toBe(false);
    expect(isOrcaWorktreeSelectorMissing(null)).toBe(false);
    expect(isOrcaWorktreeSelectorMissing(undefined)).toBe(false);
  });

  test('also falls back on a bare "unknown" left after retries are exhausted', () => {
    // Verbatim from the reported failure: the daemon was momentarily unresponsive,
    // so the CLI returned no parseable output for all three retry attempts.
    expect(shouldFallBackToOrcaFloatingTerminal('Orca 워크트리 터미널 생성 실패: unknown')).toBe(true);
    expect(shouldFallBackToOrcaFloatingTerminal('Orca 워크트리 터미널 생성 실패: selector_not_found')).toBe(true);
  });

  test('does not fall back on a deterministic error Floating would fail too', () => {
    expect(shouldFallBackToOrcaFloatingTerminal('Orca는 git 저장소만 지원합니다')).toBe(false);
    expect(shouldFallBackToOrcaFloatingTerminal('daemon timeout')).toBe(false);
    // "unknown" only as a whole trailing word, not merely appearing in the message.
    expect(shouldFallBackToOrcaFloatingTerminal('unknown error occurred')).toBe(false);
    expect(shouldFallBackToOrcaFloatingTerminal(null)).toBe(false);
    expect(shouldFallBackToOrcaFloatingTerminal(undefined)).toBe(false);
  });

  test('the floating fallback names the path and how to get the worktree surface back', () => {
    const notice = formatOrcaFloatingFallbackNotice('/Users/me/.claude/plugins/marketplaces/demo');
    expect(notice).toContain('Floating Terminal');
    expect(notice).toContain('/Users/me/.claude/plugins/marketplaces/demo');
    expect(notice).toContain('Orca에 해당 저장소를 먼저 추가');
    // A missing path must not produce a dangling "()" fragment.
    expect(formatOrcaFloatingFallbackNotice(null)).not.toContain('()');
  });

  test('reads the actual launch surface back from the backend message, not the request', () => {
    // Verbatim shape of the reported bug: the request asked for worktree-internal, the
    // backend fell back to Floating, and the message says so — this must win over
    // whatever the caller originally intended, or the toast contradicts itself.
    const fellBack = 'Orca Floating Terminal에 Claude ⚡ 명령 전송 완료\n'
      + '⚠ Orca에 등록된 워크트리가 아니라 워크트리 내부 터미널을 만들 수 없어 Floating Terminal로 열었습니다. (/path)\n'
      + '워크트리 내부에서 열려면 Orca에 해당 저장소를 먼저 추가하세요.';
    expect(orcaSurfaceFromLaunchMessage(fellBack)).toBe('floating');

    expect(orcaSurfaceFromLaunchMessage('Orca 워크트리 터미널에 Claude 명령 전송 완료')).toBe('worktree');
    expect(orcaSurfaceFromLaunchMessage('Orca Floating Terminal의 기존 Claude 탭을 재사용했습니다')).toBe('floating');
    expect(orcaSurfaceFromLaunchMessage('아무 표면 정보도 없는 메시지')).toBe(null);
  });
});
