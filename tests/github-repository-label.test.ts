import {expect, test} from 'bun:test';
import {githubRepositoryLabels} from '../src/githubRepositoryLabel';

test('GitHub buttons are named after their repository, not 1/2/3 (VOC 2026-09-25)', () => {
  expect(githubRepositoryLabels([
    'https://github.com/example-owner/Example_Private',
    'https://github.com/intenet1001-commits/AgentsToZ-memory/tree/main',
    'https://github.com/intenet1001-commits/AgentsToZ-public.git',
  ])).toEqual(['Example_Private', 'AgentsToZ-memory', 'AgentsToZ-public']);
  // Same repository name under two owners: show the owner too.
  expect(githubRepositoryLabels(['https://github.com/a/app', 'https://github.com/b/app'])).toEqual(['a/app', 'b/app']);
  // Anything unparseable falls back to a number rather than guessing.
  expect(githubRepositoryLabels(['not a url', 'https://github.com/x/y'])).toEqual(['GitHub 1', 'y']);
});
