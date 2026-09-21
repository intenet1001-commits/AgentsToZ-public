import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProjectMemory } from '../project-memory-server';
import { sessionMemoryAction, type SessionMemoryStatusState } from '../src/components/aiUsageMemoryState';

/**
 * A context session outlives the folder it ran in: deleting an Orca worktree
 * leaves a session row whose cwd no longer exists. That is a permanent state,
 * not a transient failure, so it must never be offered as "retry".
 */
describe('project memory for a folder that no longer exists', () => {
  test('detect reports a distinguishable code instead of a generic failure', () => {
    const gone = join(mkdtempSync(join(tmpdir(), 'agentstoz-gone-')), 'deleted-worktree');
    let caught: any;
    try {
      detectProjectMemory(gone);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe('PROJECT_ROOT_MISSING');
  });

  test('an absolute path that still exists is not reported as missing', () => {
    const live = mkdtempSync(join(tmpdir(), 'agentstoz-live-'));
    try {
      expect(detectProjectMemory(live).exists).toBe(false);
    } finally {
      rmSync(live, { recursive: true, force: true });
    }
  });

  test('a relative path keeps its own validation code', () => {
    let caught: any;
    try {
      detectProjectMemory('relative/path');
    } catch (error) {
      caught = error;
    }
    expect(caught.code).toBe('PROJECT_ROOT_INVALID');
  });
});

describe('AI usage row for a deleted project folder', () => {
  const errorState = (code?: string): SessionMemoryStatusState =>
    ({ kind: 'error', message: '프로젝트 폴더가 없습니다', code, checkedAt: Date.now() }) as SessionMemoryStatusState;

  test('offers no retry when the folder is gone for good', () => {
    expect(sessionMemoryAction('/gone/worktree', errorState('PROJECT_ROOT_MISSING'))).toBe('missing');
  });

  test('still retries genuinely transient failures', () => {
    expect(sessionMemoryAction('/work/회의실', errorState())).toBe('retry');
    expect(sessionMemoryAction('/work/회의실', errorState('SUPABASE_UNREACHABLE'))).toBe('retry');
  });
});
