import {expect, test} from 'bun:test';
import {branchHygieneHeadline, branchHygieneListLabel, summarizeGitBranchHygiene} from '../src/gitBranchHygiene';

const now = Date.parse('2026-09-25T00:00:00Z');
const day = 86400e3;
const obs = (name: string, extra: Record<string, unknown> = {}) => ({name, scope: 'local' as const, upstream: 'origin/' + name, uniqueCommits: 2, behindDefault: 0, lastCommitAt: new Date(now - day).toISOString(), checkedOut: false, ...extra});

test('the headline counts the branches the list shows, and the over-limit part separately (VOC 2026-09-25: 「16건」 vs a short list)', () => {
  const summary = summarizeGitBranchHygiene({defaultBranch: 'main', defaultRemoteRef: 'origin/main', defaultReliable: true, now, observations: [
    obs('main', {checkedOut: true}),
    ...['a', 'b', 'c', 'd'].map(n => obs(n, {uniqueCommits: 0})),
    ...['e', 'f', 'g'].map(n => obs(n, {lastCommitAt: new Date(now - 40 * day).toISOString()})),
    ...Array.from({length: 17}, (_, i) => obs('w' + i)),
  ]});
  expect(summary.totalLocalBranches).toBe(25);
  expect(summary.attentionCount).toBe(17);
  const h = branchHygieneHeadline(summary);
  expect(h.title).toBe('정리할 브랜치 7개');
  expect(h.detail).toBe('병합 완료 4 · 오래됨 3 · 로컬 브랜치 25개(권장 8개 이하)');
  expect(summary.branches.filter(b => branchHygieneListLabel(b.recommendation) !== null)).toHaveLength(7);
});

test('only too many branches, nothing to delete', () => {
  const summary = summarizeGitBranchHygiene({defaultBranch: 'main', defaultRemoteRef: null, defaultReliable: true, now, observations: [obs('main', {checkedOut: true}), ...Array.from({length: 10}, (_, i) => obs('w' + i))]});
  expect(branchHygieneHeadline(summary)).toEqual({title: '로컬 브랜치가 많아요 11개', detail: '권장 8개 이하 · 지울 수 있는 병합 완료 브랜치는 없어요'});
});
