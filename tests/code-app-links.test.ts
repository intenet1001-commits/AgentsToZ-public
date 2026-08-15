import { describe, expect, test } from 'bun:test';
import { buildCodeAppDeepLink } from '../code-app-links';

describe('buildCodeAppDeepLink', () => {
  test('opens a Codex local task with the exact absolute workspace path', () => {
    expect(buildCodeAppDeepLink('codex', '/Users/test/My Project')).toEqual({
      url: 'codex://threads/new?path=%2FUsers%2Ftest%2FMy%20Project',
      confirmationRequired: false,
    });
  });

  test('opens Claude Desktop Code with a UTF-8 folder and required confirmation', () => {
    expect(buildCodeAppDeepLink('claude', '/Users/test/기말 프로젝트')).toEqual({
      url: 'claude://code/new?folder=%2FUsers%2Ftest%2F%EA%B8%B0%EB%A7%90%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8',
      confirmationRequired: true,
    });
  });

  test('preserves a Windows workspace path through URL encoding', () => {
    expect(buildCodeAppDeepLink('codex', 'C:\\Projects\\Agent App')).toEqual({
      url: 'codex://threads/new?path=C%3A%5CProjects%5CAgent%20App',
      confirmationRequired: false,
    });
  });
});
