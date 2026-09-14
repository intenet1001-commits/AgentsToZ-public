import { describe, expect, test } from 'bun:test';
import { resolveProjectStartTarget, sanitizeProjectFolderName } from '../src/projectStartLocation';

describe('sanitizeProjectFolderName', () => {
  test('keeps Korean names and joins words with a dash', () => {
    expect(sanitizeProjectFolderName('매출 대시보드')).toBe('매출-대시보드');
    expect(sanitizeProjectFolderName('  my new app  ')).toBe('my-new-app');
  });

  // 이 값은 폴더명이 된다 = 파일시스템에 닿는 입력이다. 경로 구분자가 살아남으면
  // 작업 루트 밖에 폴더가 생긴다.
  test('neutralizes path traversal and separators', () => {
    expect(sanitizeProjectFolderName('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeProjectFolderName('a/b:c*d')).toBe('abcd');
    expect(sanitizeProjectFolderName('..')).toBe('');
  });

  test('never produces a hidden or flag-shaped name', () => {
    expect(sanitizeProjectFolderName('.hidden')).toBe('hidden');
    expect(sanitizeProjectFolderName('-rf')).toBe('rf');
    expect(sanitizeProjectFolderName('---')).toBe('');
  });

  test('drops control characters instead of writing them into a path', () => {
    expect(sanitizeProjectFolderName(`a${String.fromCharCode(9)}b`)).toBe('a-b');
    expect(sanitizeProjectFolderName(`a${String.fromCharCode(0)}b`)).toBe('ab');
  });

  test('bounds the length', () => {
    expect(sanitizeProjectFolderName('x'.repeat(200))).toHaveLength(60);
  });
});

describe('resolveProjectStartTarget', () => {
  test('uses the only registered root without asking', () => {
    const result = resolveProjectStartTarget({ name: '매출 대시보드', roots: [{ path: '/Users/me/work' }], homeDir: '/Users/me' });
    expect(result).toEqual({
      status: 'ok',
      folderName: '매출-대시보드',
      folderPath: '/Users/me/work/매출-대시보드',
      rootPath: '/Users/me/work',
      rootWasDefaulted: false,
    });
  });

  test('asks which root when several are registered', () => {
    const roots = [{ path: '/a' }, { path: '/b' }];
    expect(resolveProjectStartTarget({ name: '앱', roots, homeDir: '/h' })).toEqual({ status: 'need-root', roots });
  });

  // GUI 가 없는 호스트(AWS 등)는 작업 루트를 등록할 방법이 마땅치 않다. 거절하면 거기서는
  // 프로젝트를 시작할 길이 아예 없어지므로 기본 위치로 만들되, 사용자가 고른 위치가
  // 아니라는 사실을 rootWasDefaulted 로 알려 호출부가 어디에 만들었는지 말하게 한다.
  test('falls back to a default location on a rootless host and flags it', () => {
    const result = resolveProjectStartTarget({ name: '앱', roots: [], homeDir: '/home/ubuntu' });
    expect(result).toEqual({
      status: 'ok',
      folderName: '앱',
      folderPath: '/home/ubuntu/projects/앱',
      rootPath: '/home/ubuntu/projects',
      rootWasDefaulted: true,
    });
  });

  // 루트가 있으면 그것이 사용자의 선택이므로 기본값으로 새지 않는다.
  test('does not flag a defaulted root when the host has one registered', () => {
    const result = resolveProjectStartTarget({ name: '앱', roots: [{ path: '/a' }], homeDir: '/home/x' });
    expect(result).toMatchObject({ status: 'ok', rootPath: '/a', rootWasDefaulted: false });
  });

  test('accepts an explicitly chosen root that is registered', () => {
    const result = resolveProjectStartTarget({ name: '앱', rootPath: '/b/', roots: [{ path: '/a' }, { path: '/b' }], homeDir: '/h' });
    expect(result).toMatchObject({ status: 'ok', rootPath: '/b', folderPath: '/b/앱' });
  });

  // 오타 하나로 등록하지 않은 곳에 폴더가 생기면 사용자는 그것을 찾지 못한다.
  test('rejects a root that is not registered', () => {
    const result = resolveProjectStartTarget({ name: '앱', rootPath: '/somewhere-else', roots: [{ path: '/a' }], homeDir: '/h' });
    expect(result).toMatchObject({ status: 'error', code: 'PROJECT_START_UNKNOWN_ROOT' });
  });

  test('requires a usable name', () => {
    expect(resolveProjectStartTarget({ name: '   ', roots: [{ path: '/a' }], homeDir: '/h' }))
      .toMatchObject({ status: 'error', code: 'PROJECT_START_NAME_REQUIRED' });
    expect(resolveProjectStartTarget({ name: '../..', roots: [{ path: '/a' }], homeDir: '/h' }))
      .toMatchObject({ status: 'error', code: 'PROJECT_START_NAME_REQUIRED' });
  });

  test('requires an absolute root when the host has none registered', () => {
    expect(resolveProjectStartTarget({ name: '앱', rootPath: 'relative/dir', roots: [], homeDir: '/h' }))
      .toMatchObject({ status: 'error', code: 'PROJECT_START_ROOT_NOT_ABSOLUTE' });
  });
});
