import { describe, expect, test } from 'bun:test';
import {
  WORKTREE_REMOTE_REFRESH_INTERVAL_MS,
  resolveWorktreeRemoteRefreshFeedback,
  shouldFetchWorktreeRemote,
} from '../src/worktreeRemoteRefresh';

const appSource = await Bun.file(new URL('../src/App.tsx', import.meta.url)).text();

describe('worktree remote refresh scheduling', () => {
  test('fetches immediately when a panel has never refreshed its remote', () => {
    expect(shouldFetchWorktreeRemote(undefined, 100_000)).toBe(true);
  });

  test('does not fetch again during the remote refresh interval', () => {
    expect(shouldFetchWorktreeRemote(100_000, 100_000 + WORKTREE_REMOTE_REFRESH_INTERVAL_MS - 1)).toBe(false);
  });

  test('fetches again when the remote refresh interval elapses', () => {
    expect(shouldFetchWorktreeRemote(100_000, 100_000 + WORKTREE_REMOTE_REFRESH_INTERVAL_MS)).toBe(true);
  });

  test('refreshes the remote on panel open, project selection, and scheduled polling', () => {
    expect(appSource).toContain("loadWorktrees(portId, folderPath, { fetchRemote: true, showResult: false })");
    expect(appSource).toContain("loadWorktrees(v4SelectedId, sel.folderPath, { fetchRemote: true, showResult: false })");
    expect(appSource).toContain('const fetchRemote = shouldFetchWorktreeRemote(');
  });

  test('treats a missing origin as a completed local refresh instead of a commit failure', () => {
    expect(resolveWorktreeRemoteRefreshFeedback([
      { remoteRefreshState: 'no-origin' },
    ])).toEqual({
      kind: 'no-origin',
      message: '로컬 Git 상태를 갱신했습니다 · GitHub 원격(origin) 미연결',
      countsAsRefresh: true,
    });
  });

  test('keeps a real fetch failure in the error path and eligible for retry', () => {
    expect(resolveWorktreeRemoteRefreshFeedback([
      { remoteRefreshError: 'network unavailable' },
    ])).toEqual({
      kind: 'error',
      message: '원격 상태 확인 실패: network unavailable',
      countsAsRefresh: false,
    });
  });
});
