import { describe, expect, test } from 'bun:test';
import {
  githubRepositoryUrlFields,
  githubRepositoryUrls,
  githubRepositoryUrlsText,
} from '../src/githubUrls';

describe('GitHub repository URL compatibility', () => {
  test('reads an existing single githubUrl as a one-item collection', () => {
    expect(githubRepositoryUrls({ githubUrl: 'https://github.com/acme/legacy' })).toEqual([
      'https://github.com/acme/legacy',
    ]);
  });

  test('keeps the legacy primary URL first and normalizes/deduplicates added repositories', () => {
    const urls = githubRepositoryUrls({
      githubUrl: 'git@github.com:acme/primary.git',
      githubUrls: [
        'https://github.com/acme/secondary/',
        'https://github.com/acme/primary',
      ],
    });

    expect(urls).toEqual([
      'https://github.com/acme/primary',
      'https://github.com/acme/secondary',
    ]);
    expect(githubRepositoryUrlsText({ githubUrl: urls[0], githubUrls: urls.slice(1) })).toBe([
      'https://github.com/acme/primary',
      'https://github.com/acme/secondary',
    ].join('\n'));
  });

  test('writes multi-line input to both the primary legacy field and the full collection', () => {
    expect(githubRepositoryUrlFields('https://github.com/acme/one\nhttps://github.com/acme/two')).toEqual({
      githubUrl: 'https://github.com/acme/one',
      githubUrls: [
        'https://github.com/acme/one',
        'https://github.com/acme/two',
      ],
    });
  });
});
