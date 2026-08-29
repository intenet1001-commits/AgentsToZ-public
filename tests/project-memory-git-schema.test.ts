import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PROJECT_MEMORY_IDENTITY_SQL } from '../src/schemaSql';

const migration = readFileSync(new URL('../supabase/migrations/20260823000500_project_memory_git_state.sql', import.meta.url), 'utf8');

describe('장기기억 단말별 Git 상태 스키마', () => {
  test('정본 SQL과 증분 마이그레이션이 같은 Git 비교 열을 가진다', () => {
    for (const column of [
      'git_head_sha', 'git_branch', 'git_remote_url', 'git_upstream_sha',
      'git_ahead', 'git_behind', 'git_dirty', 'git_commit_at', 'git_checked_at',
    ]) {
      expect(PROJECT_MEMORY_IDENTITY_SQL).toContain(column);
      expect(migration).toContain(column);
    }
  });

  test('upstream 값이 네트워크 최신값이라고 오해되지 않게 문서화한다', () => {
    expect(migration).toContain('last locally fetched');
  });
});
