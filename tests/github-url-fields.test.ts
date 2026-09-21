import { test, expect } from 'bun:test';
import {
  appendBlankGitHubRepositoryUrlRow,
  githubRepositoryUrlRows,
  githubRepositoryUrlRowsText,
  removeGitHubRepositoryUrlRow,
  replaceGitHubRepositoryUrlRow,
  shouldAdoptGitHubRepositoryUrlValue,
} from '../src/githubUrlFields';

test('always shows one row so an empty project can be given a repository', () => {
  expect(githubRepositoryUrlRows('')).toEqual(['']);
});

test('one row per stored repository', () => {
  expect(githubRepositoryUrlRows('https://github.com/a/b\nhttps://github.com/c/d'))
    .toEqual(['https://github.com/a/b', 'https://github.com/c/d']);
});

test('the added blank row survives being written back to the form value', () => {
  // This is the regression: the value drops the blank row, so re-deriving rows
  // from it made the add button appear to do nothing.
  const rows = appendBlankGitHubRepositoryUrlRow(['https://github.com/a/b']);
  const value = githubRepositoryUrlRowsText(rows);

  expect(rows).toEqual(['https://github.com/a/b', '']);
  expect(githubRepositoryUrlRows(value)).toEqual(['https://github.com/a/b']);
  expect(shouldAdoptGitHubRepositoryUrlValue(value, rows)).toBe(false);
});

test('a blank row added to an empty editor also survives', () => {
  const rows = appendBlankGitHubRepositoryUrlRow(githubRepositoryUrlRows(''));
  expect(rows).toEqual(['', '']);
  expect(shouldAdoptGitHubRepositoryUrlValue(githubRepositoryUrlRowsText(rows), rows)).toBe(false);
});

test('a half-typed address does not reset the rows', () => {
  const rows = replaceGitHubRepositoryUrlRow(['https://github.com/a/b', ''], 1, 'https://git');
  expect(shouldAdoptGitHubRepositoryUrlValue(githubRepositoryUrlRowsText(rows), rows)).toBe(false);
});

test('normalization alone does not reset the rows', () => {
  const rows = ['git@github.com:a/b.git'];
  const stored = 'https://github.com/a/b';
  expect(shouldAdoptGitHubRepositoryUrlValue(stored, rows)).toBe(false);
});

test('an externally detected remote is adopted', () => {
  const rows = githubRepositoryUrlRows('');
  expect(shouldAdoptGitHubRepositoryUrlValue('https://github.com/a/b', rows)).toBe(true);
  expect(githubRepositoryUrlRows('https://github.com/a/b')).toEqual(['https://github.com/a/b']);
});

test('clearing the form value is adopted', () => {
  expect(shouldAdoptGitHubRepositoryUrlValue('', ['https://github.com/a/b'])).toBe(true);
});

test('removing a row keeps at least one row', () => {
  expect(removeGitHubRepositoryUrlRow(['https://github.com/a/b', ''], 0)).toEqual(['']);
  expect(removeGitHubRepositoryUrlRow(['https://github.com/a/b'], 0)).toEqual(['https://github.com/a/b']);
});

test('editing a row leaves the others alone', () => {
  expect(replaceGitHubRepositoryUrlRow(['a', 'b', 'c'], 1, 'z')).toEqual(['a', 'z', 'c']);
});
