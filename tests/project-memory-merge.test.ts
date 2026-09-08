import { describe, expect, test } from 'bun:test';
import {
  composeMergedMemory,
  fallbackMemoryDisplayName,
  memoryMergeValidation,
  normalizeMemoryDisplayName,
  repositoryUrlForChoice,
  resolveMergeTarget,
} from '../src/projectMemoryMerge';
import { readFileSync } from 'node:fs';
import { PROJECT_MEMORY_LEDGER_SCALE_SQL, PROJECT_MEMORY_MERGE_SQL } from '../src/schemaSql';

const mergeMigration = readFileSync(new URL('../supabase/migrations/20260823000300_project_memory_merge_lineage.sql', import.meta.url), 'utf8');
const retirementMigration = readFileSync(new URL('../supabase/migrations/20260823000400_project_memory_device_retirements.sql', import.meta.url), 'utf8');
const trashMigration = readFileSync(new URL('../supabase/migrations/20260824000100_project_memory_trash.sql', import.meta.url), 'utf8');
const ledgerScaleMigration = readFileSync(new URL('../supabase/migrations/20260828010000_project_memory_ledger_scale.sql', import.meta.url), 'utf8');

function compactSql(source: string): string {
  return source
    .replace(/\s+/g, ' ')
    .replace(/\s+\(/g, '(')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*(\|\||<>|>=|<=|=|>)\s*/g, '$1')
    .trim()
    .toLowerCase();
}

describe('장기기억 계보 합병', () => {
  test('A/B 존속과 새 C 생성을 명시적으로 구분한다', () => {
    expect(resolveMergeTarget({ choice: 'a', memoryA: 'A', memoryB: 'B', newMemoryId: 'C' })).toBe('A');
    expect(resolveMergeTarget({ choice: 'b', memoryA: 'A', memoryB: 'B', newMemoryId: 'C' })).toBe('B');
    expect(resolveMergeTarget({ choice: 'new', memoryA: 'A', memoryB: 'B', newMemoryId: 'C' })).toBe('C');
  });

  test('한쪽 원문을 버리지 않고 출처 ID와 함께 보존한다', () => {
    const merged = composeMergedMemory({
      primaryContent: '# A\n결정 A', secondaryContent: '# B\n결정 B',
      primaryMemoryId: 'A', secondaryMemoryId: 'B', secondaryName: 'B 기억',
    });
    expect(merged).toContain('결정 A');
    expect(merged).toContain('결정 B');
    expect(merged).toContain('이전 memoryId: `B`');
  });

  test('저장소는 기억 ID 선택과 독립적으로 사용자가 고른다', () => {
    const base = { githubA: 'https://github.com/a/one', githubB: 'https://github.com/b/two', newGithubUrl: 'git@github.com:c/three.git' };
    expect(repositoryUrlForChoice({ ...base, choice: 'a' })).toBe(base.githubA);
    expect(repositoryUrlForChoice({ ...base, choice: 'b' })).toBe(base.githubB);
    expect(repositoryUrlForChoice({ ...base, choice: 'new' })).toBe('https://github.com/c/three');
    expect(repositoryUrlForChoice({ ...base, choice: 'memory-only' })).toBeNull();
  });

  test('사용자 별칭은 공백을 정리하고 사람이 수정 가능한 짧은 값으로 제한한다', () => {
    expect(normalizeMemoryDisplayName('  고객   포털 기억  ')).toBe('고객 포털 기억');
    expect(fallbackMemoryDisplayName('', 'https://github.com/acme/portal')).toBe('portal');
  });

  test('동일 계보·저장소 누락·빈 결과는 확정 전에 막는다', () => {
    expect(memoryMergeValidation({ memoryA: 'A', memoryB: 'A', targetMemoryId: 'A', repositoryChoice: 'memory-only', repositoryUrl: null, displayName: '별칭', mergedContent: 'x' })).toContain('서로 다른');
    expect(memoryMergeValidation({ memoryA: 'A', memoryB: 'B', targetMemoryId: 'A', repositoryChoice: 'new', repositoryUrl: null, displayName: '별칭', mergedContent: 'x' })).toContain('저장소');
  });

  test('설치 정본과 배포 마이그레이션이 구 ID 전달·합병·단말 확인 RPC를 모두 포함한다', () => {
    for (const sql of [PROJECT_MEMORY_MERGE_SQL, mergeMigration]) {
      expect(sql).toContain('portmgr_project_memory_aliases');
      expect(sql).toContain('portmgr_merge_project_memories');
      expect(sql).toContain('portmgr_ack_project_memory_merge_device');
      expect(sql).toContain('portmgr_project_memory_labels');
      expect(sql).toContain('PROJECT_MEMORY_MERGE_HEAD_CHANGED');
      expect(sql).toContain("grant execute on function public.portmgr_merge_project_memories");
    }
  });

  test('사용 종료는 이력을 삭제하지 않는 별도 표이며 복구 가능한 RPC로만 변경한다', () => {
    for (const sql of [PROJECT_MEMORY_MERGE_SQL, retirementMigration]) {
      expect(sql).toContain('portmgr_project_memory_device_retirements');
      expect(sql).toContain('portmgr_set_project_memory_device_retired');
      expect(sql).toContain('portmgr_skip_retired_project_memory_merge_device');
      expect(sql).not.toContain('delete from public.portmgr_project_memory_revisions');
    }
    expect(retirementMigration).toContain('grant select on table public.portmgr_project_memory_device_retirements to authenticated');
    expect(retirementMigration).toContain('grant execute on function public.portmgr_set_project_memory_device_retired');
  });

  test('휴지통은 원본 리비전을 지우지 않고 복원 가능한 상태만 기록한다', () => {
    for (const sql of [PROJECT_MEMORY_MERGE_SQL, trashMigration]) {
      expect(sql).toContain('portmgr_project_memory_trash');
      expect(sql).toContain('portmgr_set_project_memory_trashed');
      expect(sql).not.toContain('delete from public.portmgr_project_memory_revisions');
      expect(sql).not.toContain('delete from public.portmgr_project_memory_journal');
    }
    expect(trashMigration).toContain('grant select on table public.portmgr_project_memory_trash to authenticated');
    expect(trashMigration).toContain('grant execute on function public.portmgr_set_project_memory_trashed');
  });

  test('합병은 같은 트랜잭션에서 두 immutable ledger를 대상 계보로 멱등 복사한다', () => {
    for (const source of [PROJECT_MEMORY_MERGE_SQL, ledgerScaleMigration]) {
      const sql = compactSql(source);
      expect(sql).toContain('portmgr_copy_project_memory_ledgers');
      expect(sql).toMatch(/create trigger portmgr_copy_project_memory_ledgers_on_merge after insert on public\.portmgr_project_memory_merges/);
      expect(sql).toContain('insert into public.portmgr_project_memory_journal');
      expect(sql).toContain('on conflict(memory_id,entry_hash) do nothing');
      expect(sql).toContain('insert into public.portmgr_project_memory_feedback');
      expect(sql).toContain('portmgr_project_memory_feedback_lineage_id');
      expect(sql).toContain('coalesce(f.origin_event_id,f.id)');
      expect(sql).toContain('on conflict(id) do nothing');
      expect(sql).toContain('j.memory_id<>p_target_memory_id');
      expect(sql).toContain('f.memory_id<>p_target_memory_id');
      expect(sql).not.toMatch(/delete from public\.portmgr_project_memory_(?:journal|feedback)/);
      expect(sql).not.toMatch(/update public\.portmgr_project_memory_(?:journal|feedback)/);
    }
    const scale = compactSql(PROJECT_MEMORY_LEDGER_SCALE_SQL);
    const migration = compactSql(ledgerScaleMigration);
    for (const sql of [scale, migration]) {
      expect(sql).toContain('from public.portmgr_project_memory_merges order by created_at asc,id asc');
      expect(sql).toContain('perform public.portmgr_copy_project_memory_ledgers');
    }
  });
});
