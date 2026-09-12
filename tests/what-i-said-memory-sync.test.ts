import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  normalizeWhatISaidMemoryIds,
  normalizeWhatISaidRemotePromptRow,
  normalizeWhatISaidSharedCapturePolicy,
  whatISaidSharedPolicyRetryDelay,
  whatISaidTextMatches,
} from '../src/whatISaidSharedPolicy';
import { WHAT_I_SAID_FEED_KEY_SQL } from '../src/whatISaidFeedKeySql';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/WhatISaidPanel.tsx', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../supabase/migrations/20260902010000_what_i_said_memory_sync_and_search.sql', import.meta.url),
  'utf8',
);
const capturePolicyFixMigration = readFileSync(
  new URL('../supabase/migrations/20260902020000_fix_what_i_said_capture_policy_ambiguity.sql', import.meta.url),
  'utf8',
);

describe('What I said memory-scoped sharing', () => {
  test('normalizes a bounded set of durable memory ids without changing their order', () => {
    expect(normalizeWhatISaidMemoryIds([' memory-a ', 'memory-b', 'memory-a']))
      .toEqual(['memory-a', 'memory-b']);
    expect(normalizeWhatISaidMemoryIds([])).toEqual([]);
    expect(normalizeWhatISaidMemoryIds(['ok', 7])).toEqual([]);
  });

  test('normalizes the shared capture policy and remote prompt projection fail-closed', () => {
    expect(normalizeWhatISaidSharedCapturePolicy({
      memory_id: 'memory-a',
      capture_configured: true,
      capture_enabled: true,
      capture_enabled_at: '2026-09-02T00:00:00Z',
      retention_days: '365',
      analysis_allowed: false,
      updated_at: '2026-09-02T00:00:01Z',
    })).toMatchObject({
      memoryId: 'memory-a',
      configured: true,
      enabled: true,
      retentionDays: 365,
    });
    expect(normalizeWhatISaidRemotePromptRow({
      id: 'prompt-a',
      memory_id: 'memory-a',
      project_name: 'A',
      device_id: 'mac-a',
      device_name: 'Mac A',
      feed_seq: '9007199254740993',
      agent: 'claude',
      prompt_origin: 'agentstoz',
      recorded_at: '2026-09-02T00:00:00Z',
      body: 'hello',
      redaction_state: 'clean',
    })).toMatchObject({ feed_seq: '9007199254740993', prompt_origin: 'agentstoz' });
    expect(normalizeWhatISaidRemotePromptRow({
      id: 'prompt-a', memory_id: 'memory-a', device_id: 'mac-a', feed_seq: '1',
      agent: 'assistant', recorded_at: '2026-09-02T00:00:00Z', body: 'must not render',
      redaction_state: 'clean',
    })).toBeNull();
  });

  test('search is Unicode-normalized literal substring matching', () => {
    expect(whatISaidTextMatches('ＡＢＣ 프로젝트', 'abc')).toBe(true);
    expect(whatISaidTextMatches('100%_literal', '%_')).toBe(true);
    expect(whatISaidTextMatches('Claude prompt', 'codex')).toBe(false);
  });

  test('startup reconciliation keeps retrying with capped backoff after a transient outage', () => {
    expect(whatISaidSharedPolicyRetryDelay(1)).toBe(5_000);
    expect(whatISaidSharedPolicyRetryDelay(5)).toBe(60_000);
    expect(whatISaidSharedPolicyRetryDelay(500)).toBe(60_000);
    expect(apiSource).toContain('scheduleWhatISaidSharedPolicyReconciliation()');
    expect(apiSource).toContain('reconcileWhatISaidSharedPolicyNow({ force: true })');
    expect(apiSource).toContain('await reconcileWhatISaidSharedPolicyNow();');
  });

  test('fresh and forward SQL store capture consent per memory and search the shared rows', () => {
    for (const sql of [WHAT_I_SAID_FEED_KEY_SQL, migration]) {
      expect(sql).toContain('capture_configured boolean not null default false');
      expect(sql).toContain('portmgr_set_what_i_said_capture_policy');
      expect(sql).toContain('portmgr_list_what_i_said_prompts');
      expect(sql).toContain('p.memory_id = any(p_memory_ids)');
      expect(sql).toContain('lower(normalize(v_query, NFKC))');
      expect(sql).toContain('position(');
      expect(sql).toContain('WHAT_I_SAID_SERVICE_ROLE_REQUIRED');
      expect(sql).toContain('portmgr_what_i_said_memory_policy_retention_days_check');
      expect(sql).toContain("p_prompt_origin is null or p.prompt_origin = p_prompt_origin");
    }
    for (const sql of [WHAT_I_SAID_FEED_KEY_SQL, capturePolicyFixMigration]) {
      const start = sql.indexOf('create or replace function public.portmgr_set_what_i_said_capture_policy(');
      const end = sql.indexOf('\nend;\n$$;', start);
      const capturePolicyFunction = sql.slice(start, end);
      expect(capturePolicyFunction).toContain('on conflict on constraint portmgr_what_i_said_memory_policy_pkey');
      expect(capturePolicyFunction).not.toContain('on conflict (memory_id) do update');
    }
  });

  test('desktop APIs use memory ids for shared list, count, and multi-memory manual sync', () => {
    expect(apiSource).toContain("if (url.pathname === '/api/what-i-said/sync'");
    expect(apiSource).toContain('resolveRegisteredWhatISaidTargets(input.memoryIds)');
    expect(apiSource).toContain(".in('memory_id', memoryIds)");
    expect(apiSource).toContain("source: 'supabase' as const");
    expect(apiSource).toContain('pushWhatISaidRemote(project, { explicit: true })');
    expect(apiSource).not.toContain(".eq('device_id', identity.deviceId);\n          if (error) remoteError");
    expect(rustSource).toContain('("POST", "/api/what-i-said/sync")');
  });

  test('panel exposes multi-memory update and sends memory ids to shared search', () => {
    expect(panelSource).toContain('data-testid="what-i-said-memory-sync-selection"');
    expect(panelSource).toContain('whatISaidApi.sync(selectedMemoryIds, backfill)');
    expect(panelSource).toContain('{ memoryIds: [projectFilterMemoryId] }');
    expect(panelSource).toContain("/^wisr1_(?:0|[1-9][0-9]*)$/");
    expect(panelSource).toContain('리멤버세션을 하지 않았어도');
  });
});
