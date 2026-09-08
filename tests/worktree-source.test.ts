import { describe, expect, test } from 'bun:test';
import { classifyWorktreeSource } from '../src/worktreeSource';

const REPO = '/Users/x/product/demo';

describe('classifyWorktreeSource', () => {
  test('앱이 만든 워크트리는 Orca 목록에 있어도 앱 소유다', () => {
    // 회귀 방지: Orca는 등록된 저장소 안의 일반 git 워크트리도 자기 목록에 넣는다.
    // 이걸 소유권으로 오인하면 평범한 삭제가 `orca worktree rm --force`로 새어나간다.
    const result = classifyWorktreeSource({
      repoRoot: REPO,
      worktreePath: `${REPO}/worktrees/test1`,
      orcaPaths: [`${REPO}/worktrees/test1`],
    });
    expect(result.kind).toBe('app');
    expect(result.orcaManaged).toBe(false);
    expect(result.inOrcaList).toBe(true);
  });

  test('구버전 숨김 경로도 앱 소유로 본다', () => {
    const result = classifyWorktreeSource({
      repoRoot: REPO,
      worktreePath: `${REPO}/.claude/worktrees/legacy`,
      orcaPaths: [],
    });
    expect(result.kind).toBe('app');
    expect(result.isLegacyAppWorktree).toBe(true);
  });

  test('Orca 워크스페이스 경로는 목록이 없어도 Orca 소유다', () => {
    const result = classifyWorktreeSource({
      repoRoot: REPO,
      worktreePath: '/Users/x/orca/workspaces/demo/feature',
      orcaPaths: null,
    });
    expect(result.kind).toBe('orca');
    expect(result.orcaManaged).toBe(true);
  });

  test('저장소 밖의 외부 워크트리는 Orca 목록에 있을 때만 Orca 소유다', () => {
    const outside = '/Users/x/elsewhere/wt';
    expect(classifyWorktreeSource({ repoRoot: REPO, worktreePath: outside, orcaPaths: [] }).kind)
      .toBe('external');
    expect(classifyWorktreeSource({ repoRoot: REPO, worktreePath: outside, orcaPaths: [outside] }).kind)
      .toBe('orca');
  });

  test('경로 끝 슬래시 차이로 판정이 갈리지 않는다', () => {
    const result = classifyWorktreeSource({
      repoRoot: `${REPO}/`,
      worktreePath: `${REPO}/worktrees/test1/`,
      orcaPaths: [`${REPO}/worktrees/test1`],
    });
    expect(result.kind).toBe('app');
    expect(result.inOrcaList).toBe(true);
  });

  test('projectRoot를 모르면 앱 소유로 단정하지 않는다', () => {
    const result = classifyWorktreeSource({
      repoRoot: '',
      worktreePath: `${REPO}/worktrees/test1`,
      orcaPaths: [],
    });
    expect(result.isAppWorktree).toBe(false);
    expect(result.kind).toBe('external');
  });
});
