import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  EMPTY_WHAT_I_SAID_REMOTE_POLICY,
  normalizeWhatISaidRemotePolicy,
  whatISaidRemotePushAllowed,
  whatISaidRemoteUploadEnabled,
  whatISaidRemoteRow,
  withWhatISaidProjectExcluded,
} from '../src/whatISaidRemotePolicy';
import {
  MIGRATION_SQL,
  WHAT_I_SAID_FEED_KEY_SQL,
  WHAT_I_SAID_REMOTE_SQL,
} from '../src/schemaSql';

const remoteSql = readFileSync(new URL('../src/whatISaidRemoteSql.ts', import.meta.url), 'utf8');

describe('shared upload consent precedence', () => {
  test('shared opt-in works without a legacy device setting and still respects exclusions', () => {
    const enabled = whatISaidRemoteUploadEnabled({
      sharedReady: true, sharedPolicy: { configured: true, enabled: true }, localEnabled: false,
    });
    expect(enabled).toBe(true);
    expect(whatISaidRemotePushAllowed({ enabled, excludedMemoryIds: [] }, 'memory-1')).toBe(true);
    expect(whatISaidRemotePushAllowed({ enabled, excludedMemoryIds: ['memory-1'] }, 'memory-1')).toBe(false);
  });
  test('shared opt-out wins over legacy opt-in and explicit sync', () => {
    expect(whatISaidRemoteUploadEnabled({
      sharedReady: true, sharedPolicy: { configured: true, enabled: false }, localEnabled: true, explicit: true,
    })).toBe(false);
  });
  test('unknown or unconfigured shared policy does not invent consent', () => {
    for (const sharedReady of [true, false]) {
      expect(whatISaidRemoteUploadEnabled({ sharedReady, sharedPolicy: null, localEnabled: false })).toBe(false);
      expect(whatISaidRemoteUploadEnabled({ sharedReady, sharedPolicy: null, localEnabled: true })).toBe(true);
      expect(whatISaidRemoteUploadEnabled({ sharedReady, sharedPolicy: null, localEnabled: false, explicit: true })).toBe(true);
    }
    expect(whatISaidRemoteUploadEnabled({
      sharedReady: false, sharedPolicy: { configured: true, enabled: true }, localEnabled: false,
    })).toBe(false);
  });
  test('API passes effective consent into the final exclusion guard, not the legacy toggle', () => {
    const source = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
    expect(source).toContain('policy = { enabled, excludedMemoryIds: [...await readWhatISaidRemoteExclusions()] }');
    expect(source).not.toContain('policy = { enabled: local.enabled, excludedMemoryIds:');
  });
});
const commitOrderedFeedMigration = readFileSync(
  new URL('../supabase/migrations/20260901080000_what_i_said_commit_ordered_feed.sql', import.meta.url),
  'utf8',
);
const totalScopeFeedMigration = readFileSync(
  new URL('../supabase/migrations/20260901050000_what_i_said_total_scope_feed_key.sql', import.meta.url),
  'utf8',
);
const remotePromptMigration = readFileSync(
  new URL('../supabase/migrations/20260901020000_what_i_said_remote_prompts.sql', import.meta.url),
  'utf8',
);
const memoryPolicyMigration = readFileSync(
  new URL('../supabase/migrations/20260901040000_what_i_said_memory_unit_exclusion.sql', import.meta.url),
  'utf8',
);
const supabaseConfig = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');

const entry = {
  id: 'evt-1',
  seq: '42',
  agent: 'claude' as const,
  recordedAt: '2026-09-01T00:00:00.000Z',
  capturedAt: '2026-09-01T00:00:01.000Z',
  text: '이 프롬프트는 안전합니다',
  contentHash: 'a'.repeat(64),
  retentionUntil: '2026-12-01T00:00:00.000Z',
  promptOrigin: 'agentstoz' as const,
};
const context = {
  deviceId: 'device-1',
  deviceName: 'cs-work MacBookPro',
  memoryId: 'mem-1',
  projectName: 'AgentsToZ_byCS',
};

describe('what-i-said remote push policy', () => {
  test('includes the current What I Said SQL modules in the canonical fresh-install schema', () => {
    expect(MIGRATION_SQL).toContain(WHAT_I_SAID_REMOTE_SQL);
    expect(MIGRATION_SQL).toContain(WHAT_I_SAID_FEED_KEY_SQL);
  });

  test('includes every project by default and excludes only what was chosen', () => {
    const policy = normalizeWhatISaidRemotePolicy({ enabled: true, excludedMemoryIds: ['mem-secret'] });
    expect(whatISaidRemotePushAllowed(policy, 'mem-1')).toBe(true);
    // 목록에 없는 새 프로젝트는 자동으로 포함된다 — 이 방향이 요구사항이다.
    expect(whatISaidRemotePushAllowed(policy, 'mem-brand-new')).toBe(true);
    expect(whatISaidRemotePushAllowed(policy, 'mem-secret')).toBe(false);
  });

  test('never pushes while the global switch is off, whatever the list says', () => {
    const policy = normalizeWhatISaidRemotePolicy({ enabled: false, excludedMemoryIds: [] });
    expect(whatISaidRemotePushAllowed(policy, 'mem-1')).toBe(false);
  });

  test('a project without a memory id is not pushable', () => {
    const policy = normalizeWhatISaidRemotePolicy({ enabled: true, excludedMemoryIds: [] });
    for (const id of [null, undefined, '', '   ']) {
      expect(whatISaidRemotePushAllowed(policy, id)).toBe(false);
    }
  });

  /**
   * 깨진 값을 "켜짐"으로 읽으면 사용자가 올린 적 없다고 믿는 프롬프트가 올라간다.
   * 되돌릴 수 없는 방향이므로 파싱 실패는 항상 꺼짐으로 떨어진다.
   */
  test('a broken stored policy falls back to off, not on', () => {
    for (const raw of [null, undefined, 'enabled', 42, [], { enabled: 'true' }]) {
      expect(normalizeWhatISaidRemotePolicy(raw)).toEqual(EMPTY_WHAT_I_SAID_REMOTE_POLICY);
    }
  });

  test('normalizes the exclusion list so the same project cannot be listed twice', () => {
    const policy = normalizeWhatISaidRemotePolicy({
      enabled: true,
      excludedMemoryIds: ['b', 'a', 'b', '  a  ', '', 7, null],
    });
    expect(policy.excludedMemoryIds).toEqual(['a', 'b']);
  });

  test('toggling an exclusion is idempotent in both directions', () => {
    let policy = normalizeWhatISaidRemotePolicy({ enabled: true, excludedMemoryIds: [] });
    policy = withWhatISaidProjectExcluded(policy, 'mem-1', true);
    policy = withWhatISaidProjectExcluded(policy, 'mem-1', true);
    expect(policy.excludedMemoryIds).toEqual(['mem-1']);
    policy = withWhatISaidProjectExcluded(policy, 'mem-1', false);
    policy = withWhatISaidProjectExcluded(policy, 'mem-1', false);
    expect(policy.excludedMemoryIds).toEqual([]);
    expect(policy.enabled).toBe(true);
  });
});

describe('what-i-said remote projection', () => {
  test('uploads the redacted feed projection, never the raw prompt', () => {
    const row = whatISaidRemoteRow(entry, context);
    expect(row).toMatchObject({
      id: 'evt-1',
      device_id: 'device-1',
      device_name: 'cs-work MacBookPro',
      memory_id: 'mem-1',
      project_name: 'AgentsToZ_byCS',
      local_seq: 42,
      agent: 'claude',
      prompt_origin: 'agentstoz',
      redaction_state: 'clean',
      redaction_reasons: [],
      truncated: false,
      retention_until: '2026-12-01T00:00:00.000Z',
    });
    expect(row.body).toBe('이 프롬프트는 안전합니다');
  });

  /**
   * 시크릿이 든 프롬프트는 본문 없이 행만 남는다. 행까지 지우면 소비하는 쪽에서
   * "그날 말한 적이 없다"로 읽혀 개수가 거짓이 된다.
   */
  test('withholds a prompt carrying a high-confidence secret but still records that it existed', () => {
    const row = whatISaidRemoteRow(
      { ...entry, text: 'my key is sk-ant-api03-' + 'A'.repeat(48) },
      context,
    );
    expect(row.redaction_state).toBe('withheld');
    expect(row.body).toBeNull();
    expect(row.redaction_reasons).toContain('high-confidence-secret');
    expect(row.content_hash).toBe(entry.contentHash);
  });

  test('marks a prompt whose local path or email was stripped as redacted', () => {
    const row = whatISaidRemoteRow(
      { ...entry, text: '/Users/cs-work/forcs/AgentsToZ_byCS 에서 실행했어' },
      context,
    );
    expect(row.redaction_state).toBe('redacted');
    expect(row.redaction_reasons).toContain('local-path');
    expect(row.body).not.toContain('/Users/cs-work');
  });

  // withheld 행에 본문이 남는 조합은 DB가 거절해야 한다. 코드 한쪽이 틀려도
  // 시크릿이 조용히 올라가지 않게 하는 마지막 방어선이다.
  test('the table refuses a withheld row that still carries a body', () => {
    expect(remoteSql).toContain("check ((redaction_state = 'withheld' and body is null)");
    expect(remoteSql).toContain("or (redaction_state <> 'withheld' and body is not null))");
  });

  // 로컬에서 만료·삭제된 기록이 원격에 영구히 남으면 보관기간이 거짓이 된다.
  test('the table can expire rows on its own', () => {
    expect(remoteSql).toContain('portmgr_what_i_said_cleanup');
    expect(remoteSql).toContain('retention_until is not null and p.retention_until <= now()');
    expect(remoteSql).toContain("auth.role() is distinct from 'service_role'");
  });
});

describe('what-i-said remote upload surface', () => {
  const panel = readFileSync(new URL('../src/WhatISaidPanel.tsx', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

  /**
   * 「수집과 보관은 이 기기의 로컬 서비스에서만 처리됩니다」는 적재가 켜지면
   * 거짓이다. 배지가 상태를 따라가지 않으면 앱이 사용자에게 거짓말을 한다.
   */
  test('the storage-scope badge stops claiming local-only once upload is on', () => {
    expect(panel).toContain('data-testid="what-i-said-storage-scope"');
    expect(panel).toContain('remoteScopeUnverified');
    expect(panel).toContain('t.remoteCopiesRemain(remoteStatus?.storedRows ?? 0)');
    expect(panel).toContain('&& status.credentialsReady');
    expect(panel).toContain('&& status.exclusionsReady');
    expect(panel).toContain('&& status.remoteError === null');
    expect(panel).toContain('Supabase에서 공유합니다');
    expect(panel).toContain('확인 전에는 로컬 전용이라고 단정하지 않습니다.');
  });

  test('the panel offers the exclusion picker the exclusion policy needs', () => {
    expect(panel).toContain('data-testid="what-i-said-remote-toggle"');
    expect(panel).toContain('data-testid="what-i-said-remote-exclusions"');
    expect(panel).toContain('toggleRemoteExclusion(project.memoryId, event.target.checked)');
  });

  // 원격 실패가 로컬 수집을 되돌리면, 올릴 수 없는 동안 프롬프트를 잃는다.
  test('a failed upload never rolls back the local capture', () => {
    expect(server).toContain('[WhatISaidRemote] push failed');
    expect(server).toContain('const push = await whatISaidRemoteMutations.run(');
    expect(server).toContain('() => withWhatISaidRemoteFileLock(() => pushWhatISaidRemote(project))');
  });

  // 제외/삭제가 원격까지 가지 않으면 "제외했다"와 "삭제했다"가 둘 다 거짓이 된다.
  test('excluding and deleting both reach the remote copy', () => {
    // 제외는 장기기억의 결정이므로 정책 변경과 모든 기기 행 삭제를 DB가 원자적으로 한다.
    expect(server).toContain("sb.rpc('portmgr_set_what_i_said_memory_exclusion'");
    // 로컬 삭제는 이 기기가 올린 것만 지운다 — 내 Mac 에서 지웠다고 다른 Mac 의
    // 기록까지 없애면 안 된다.
    expect(server).toContain('await deleteWhatISaidRemote({');
    expect(server).toContain('memoryId: project.location.memoryId,');
    expect(server).toContain('...(input.id ? { ids: [input.id] } : {})');
    expect(server).toContain("sb.rpc('portmgr_delete_what_i_said_prompts'");
    expect(server).toContain('p_device_id: input.allDevices ? null : identity.deviceId');
  });

  test('remote deletion is verified before local purge, with an explicit local-only escape hatch', () => {
    const deletion = server.slice(
      server.indexOf('async function deleteRegisteredWhatISaid('),
      server.indexOf('/**\n * 「내가 한 말」 행에 함께 박아 둘 기기 신원.'),
    );
    expect(deletion).toContain("reason: 'explicit-local-only'");
    expect(deletion.indexOf('await deleteWhatISaidRemote')).toBeLessThan(deletion.indexOf('softDeleteAllWhatISaidEntries'));
    expect(deletion.indexOf('hasActiveWhatISaidEntry')).toBeLessThan(deletion.indexOf('await deleteWhatISaidRemote'));
    expect(deletion).toContain('whatISaidRemoteMutations.run(project.location.memoryId');
    expect(deletion).toContain('withWhatISaidRemoteFileLock(async () =>');
    expect(server).toContain("join(APP_DATA_DIR, 'what-i-said-remote.lock')");
    expect(server).toContain('acquireOwnedFileLock(WHAT_I_SAID_REMOTE_FILE_LOCK');
    expect(server).toContain('"현재 꺼짐"은 "과거에 올린 적 없음"의 증거가 아니다.');
    expect(server).toContain("'WHAT_I_SAID_REMOTE_DELETE_UNVERIFIED'");
    expect(panel).toContain('localOnlyDeleteConfirm');
    expect(panel).toContain('deleteOneLocalOnly');
    expect(panel).toContain("code === 'WHAT_I_SAID_REMOTE_DELETE_FAILED'");
    expect(deletion).not.toContain('delete-all failed');
  });

  test('status represents an unread exclusion policy as unknown, including without credentials', () => {
    const statusRoute = server.slice(
      server.indexOf("if (url.pathname === '/api/what-i-said/remote/status'"),
      server.indexOf("if (url.pathname === '/api/what-i-said/remote/configure'"),
    );
    expect(statusRoute).toContain('let excluded: Set<string> | null = null;');
    expect(statusRoute).toContain('exclusionsReady: excluded !== null');
    expect(statusRoute).toContain('excluded: excluded ? excluded.has(item.location.memoryId) : null');
    expect(panel).toContain('project.excluded === null');
    expect(panel).toContain('? t.remoteUnknown');
    expect(panel).toContain('disabled={remoteBusy !== null || remoteToggleBlocked}');
    expect(panel).toContain('const confirmedLocalOnly');
    expect(panel).toContain('status.storedRows === 0');
  });

  // 올라가는 것은 언제나 레닥션 결과여야 한다 — 원문을 바로 올리는 경로 금지.
  test('the server uploads only through the redacting projection', () => {
    expect(server).toContain('whatISaidRemoteRow(item, {');
    expect(server).not.toMatch(/upsert\(\s*page\.items/);
  });

  test('service-role data clients reject plaintext non-loopback Supabase URLs', () => {
    const mentionClient = server.slice(
      server.indexOf('function sharedMentionClient()'),
      server.indexOf('async function persistPortalDeployUrl'),
    );
    const remoteClient = server.slice(
      server.indexOf('async function whatISaidRemoteClient()'),
      server.indexOf('/** 이 기기·프로젝트에서 이미 올린 마지막 로컬 시퀀스.'),
    );
    expect(mentionClient).toContain('normalizeServerSupabaseUrl(portal.supabaseUrl)');
    expect(remoteClient).toContain('normalizeServerSupabaseUrl(rawUrl)');
    expect(server).toContain('whatISaidRemoteFeedEndpoint(normalizeServerSupabaseUrl(rawUrl))');
  });
});

describe('what-i-said management routes stay in step with the app proxy', () => {
  const panel = readFileSync(new URL('../src/WhatISaidPanel.tsx', import.meta.url), 'utf8');
  const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

  /**
   * 앱에서는 이 요청들이 Rust 프록시의 정확한 허용 목록을 거치고, 웹에서는 라우터가
   * 바로 받는다. 그래서 목록에 빠진 경로는 **앱에서만** 죽는다 — 화면은 뜨는데
   * 내용이 비어 보이고 콘솔에도 아무것도 안 남는다. 실제로 원격 적재 카드가
   * 그렇게 비어 있었다(v339에서 실측).
   */
  test('every path the panel calls is allowed by the Tauri proxy', () => {
    const start = panel.indexOf('export const whatISaidApi');
    expect(start).toBeGreaterThan(-1);
    const api = panel.slice(start, panel.indexOf('\n};', start));
    const calls = [...api.matchAll(/whatISaidRequest<[^>]*>\(\s*'([^']+)'\s*,\s*'(GET|POST|DELETE)'/g)]
      .map(match => ({ path: match[1], method: match[2] }));
    expect(calls.length).toBeGreaterThan(10);

    const allowStart = rust.indexOf('fn is_allowed_what_i_said_management_route');
    const allowlist = rust.slice(allowStart, rust.indexOf('\n}', allowStart));
    for (const call of calls) {
      // 피드는 관리 API가 아니라 외부 앱용 읽기 경로다.
      if (call.path === '/api/what-i-said/feed') continue;
      expect({ ...call, allowed: allowlist.includes(`("${call.method}", "${call.path}")`) })
        .toEqual({ ...call, allowed: true });
    }
  });
});

describe('what-i-said external app key composes with the upload policy', () => {
  const panel = readFileSync(new URL('../src/WhatISaidPanel.tsx', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
  const keySql = readFileSync(new URL('../src/whatISaidFeedKeySql.ts', import.meta.url), 'utf8');
  const fn = readFileSync(new URL('../supabase/functions/what-i-said-feed/index.ts', import.meta.url), 'utf8');

  /**
   * 적재는 "모든 장기기억 − 제외"인데 키가 장기기억 하나에 묶여 있으면 두 반쪽이
   * 맞물리지 않는다 — 소비하는 앱이 프로젝트 수만큼 키를 등록해야 하고, 몇 개가
   * 필요한지 알아낼 방법조차 없다. 키의 단위는 소비하는 앱이다.
   */
  test('a key belongs to an app and reads everything uploaded', () => {
    expect(keySql).toContain('id uuid primary key');
    expect(keySql).toContain('label text not null');
    // 키 테이블에 memory_id 컬럼이 있으면 다시 "키 하나 = 장기기억 하나"로 돌아간다.
    // allowed_memory_ids 는 좁히는 수단이지 키의 단위가 아니다.
    const keyTable = keySql.slice(keySql.indexOf('create table if not exists public.portmgr_what_i_said_feed_keys'));
    expect(keyTable.slice(0, keyTable.indexOf(');'))).not.toMatch(/^\s{2}memory_id\b/m);
    // 좁힐 수단은 스키마 변경이 아니라 컬럼으로 남긴다.
    expect(keySql).toContain('allowed_memory_ids text[]');
    expect(keySql).toContain('v_key.allowed_memory_ids is null or p.memory_id = any(v_key.allowed_memory_ids)');
  });

  test('the scope migration preserves every already-issued memory key as a narrow app key', () => {
    expect(totalScopeFeedMigration).toContain('rename to portmgr_what_i_said_feed_keys_memory_legacy');
    expect(totalScopeFeedMigration).toContain('token_hash, token, allowed_memory_ids, created_at, rotated_at, last_used_at, revoked_at');
    expect(totalScopeFeedMigration).toContain('token_hash, token, array[memory_id], created_at, rotated_at, last_used_at, revoked_at');
    expect(totalScopeFeedMigration).toContain("coalesce(nullif(btrim(label), ''), '기존 연결 · '");
    expect(totalScopeFeedMigration).toContain('on conflict (token_hash) do nothing');
    const migrateAt = totalScopeFeedMigration.indexOf('insert into public.portmgr_what_i_said_feed_keys(');
    const legacyDropAt = totalScopeFeedMigration.indexOf('drop table public.portmgr_what_i_said_feed_keys_memory_legacy cascade');
    expect(migrateAt).toBeGreaterThan(-1);
    expect(legacyDropAt).toBeGreaterThan(migrateAt);
    expect(totalScopeFeedMigration).not.toContain('drop table if exists public.portmgr_what_i_said_feed_keys cascade;');
  });

  // 제외한 장기기억은 걸러지는 것이 아니라 없는 것이어야 한다. 클라이언트 판정이
  // 한 번 어긋나도 들어오지 못하게 저장 트랜잭션 안에서 막는다.
  test('an excluded memory cannot be uploaded at all, enforced by the database', () => {
    expect(keySql).toContain('portmgr_what_i_said_prompts_exclusion_guard');
    expect(keySql).toContain("message = 'WHAT_I_SAID_MEMORY_EXCLUDED'");
    expect(keySql).toContain('before insert or update on public.portmgr_what_i_said_prompts');
    // 이미 올라간 뒤 제외해도 피드가 즉시 감춘다.
    expect(keySql).toContain('where mp.memory_id = p.memory_id and mp.upload_excluded');
  });

  /**
   * feed_seq 는 identity 라 커밋 순서를 보장하지 않는다. 꼬리까지 커서를 밀면
   * 그 사이에 커밋된 행을 영원히 건너뛴다 — 중복은 허용하고 유실은 허용하지 않는다.
   */
  test('the cursor is assigned in commit order so a long transaction cannot be skipped', () => {
    for (const sql of [keySql, commitOrderedFeedMigration]) {
      expect(sql).toContain("pg_advisory_xact_lock(hashtextextended('what-i-said-feed-sequence-v1', 0))");
      expect(sql).toContain("pg_get_serial_sequence('public.portmgr_what_i_said_prompts', 'feed_seq')");
      expect(sql).toContain('new.feed_seq := nextval(v_sequence);');
      expect(sql).not.toContain('max(p.feed_seq), 0) + 1 into new.feed_seq');
      expect(sql).toContain('p_after text');
      expect(sql).toContain('feed_seq text');
      expect(sql).toContain('next_cursor text');
      expect(sql).toContain('portmgr_what_i_said_prompts_00_feed_sequence');
      expect(sql).toContain('portmgr_what_i_said_prompts_10_exclusion_guard');
      expect(sql).toContain('language plpgsql security definer');
      expect(sql).toContain('revoke all on function public.portmgr_assign_what_i_said_feed_seq()');
      expect(sql).toContain('to authenticated, service_role;');
      expect('portmgr_what_i_said_prompts_00_feed_sequence'
        .localeCompare('portmgr_what_i_said_prompts_10_exclusion_guard')).toBeLessThan(0);
    }
    expect(keySql).not.toContain("now() - interval '10 seconds'");
    expect(fn).toContain('const nextCursor = rows.length ? String(rows[0].next_cursor ?? afterText) : afterText;');
    expect(fn).not.toContain('items[items.length - 1].cursor');
    expect(fn).toContain('p_after: afterText');
    expect(fn).not.toContain('Number(afterText)');
    expect(commitOrderedFeedMigration.trimStart()).toContain('begin;');
    expect(commitOrderedFeedMigration.trimEnd().endsWith('commit;')).toBe(true);
    expect(commitOrderedFeedMigration).toContain("set local lock_timeout = '10s';");
    expect(commitOrderedFeedMigration).toContain("set local statement_timeout = '2min';");
  });

  // 범위를 넓히면 "키 하나 = 장기기억 하나"가 대신 해 주던 방어가 사라진다.
  test('a widened key comes with a daily limit and expiry', () => {
    expect(keySql).toContain('daily_limit integer not null');
    expect(keySql).toContain("message = 'WHAT_I_SAID_FEED_RATE_LIMITED'");
    expect(keySql).toContain('v_limit := least(v_limit, (v_key.daily_limit - v_used)::integer);');
    expect(keySql).toContain('expires_at timestamptz');
    expect(keySql).toContain('v_key.expires_at is not null and v_key.expires_at <= now()');
    expect(fn).toContain("return json({ error: 'rate_limited' }, 429)");
  });

  test('one materialized page owns rows, usage charge, and next cursor', () => {
    for (const sql of [keySql, commitOrderedFeedMigration]) {
      expect(sql).toContain('with selected as materialized (');
      expect(sql).toContain('set rows_served = u.rows_served + (select count(*) from selected)');
      expect(sql).toContain('(max(s.feed_seq) over ())::text');
      expect(sql).toContain('from selected s');
      expect(sql).not.toContain('select count(*), coalesce(max(s.feed_seq), v_after)');
      expect(sql).toContain('for update;');
    }
  });

  test('remote deletion is a service-only memory-locked RPC in fresh and forward SQL', () => {
    for (const sql of [keySql, commitOrderedFeedMigration]) {
      expect(sql).toContain('portmgr_delete_what_i_said_prompts');
      expect(sql).toContain("message = 'WHAT_I_SAID_REMOTE_DELETE_INVALID'");
      expect(sql).toContain("hashtextextended('what-i-said-memory:' || btrim(p_memory_id), 0)");
      expect(sql).toContain('and (p_all_devices or p.device_id = btrim(p_device_id))');
      expect(sql).toContain('and (p_ids is null or p.id = any(p_ids))');
      expect(sql).toContain('from public, anon, authenticated;');
    }
  });

  test('fresh schema applies the same member-only RLS posture to all four tables', () => {
    const canonical = `${remoteSql}\n${keySql}`;
    const deployed = `${remotePromptMigration}\n${memoryPolicyMigration}\n${totalScopeFeedMigration}`;
    for (const table of [
      'portmgr_what_i_said_prompts',
      'portmgr_what_i_said_memory_policy',
      'portmgr_what_i_said_feed_keys',
      'portmgr_what_i_said_feed_key_usage',
    ]) {
      for (const sql of [canonical, deployed]) {
        expect(sql).toContain(`alter table ${sql === canonical ? 'public.' : ''}${table} enable row level security`);
        expect(sql).toContain(`create policy portmgr_authenticated_all on ${sql === canonical ? 'public.' : ''}${table}`);
        expect(sql).toContain('using ((select public.portmgr_is_member()))');
        expect(sql).toContain('with check ((select public.portmgr_is_member()))');
      }
      expect(canonical).toContain(`revoke all privileges on table public.${table} from anon, public`);
      expect(canonical).toContain(`grant select, insert, update, delete on table public.${table}`);
    }
  });

  // 없는 키·회수된 키·만료된 키를 구분해 주면 추측하는 쪽에 정보를 준다.
  test('unknown, revoked and expired keys are refused identically', () => {
    expect(keySql).toContain('WHAT_I_SAID_FEED_UNAUTHORIZED');
    expect(fn).toContain("return json({ error: 'unauthorized' }, 401)");
  });

  test('the edge function calls the service-only RPC instead of reading tables', () => {
    expect(fn).toContain('/rest/v1/rpc/portmgr_what_i_said_feed');
    expect(fn).not.toContain('/rest/v1/portmgr_what_i_said_prompts');
    expect(fn).not.toContain('/rest/v1/portmgr_what_i_said_feed_keys');
    expect(keySql).toContain("auth.role() is distinct from 'service_role'");
    expect(supabaseConfig).toMatch(
      /\[functions\.what-i-said-feed\][\s\S]*?verify_jwt\s*=\s*false/,
    );
  });

  // 한 번만 보여 주고 잃어버리면 재발급뿐인데, 재발급은 이미 붙여 넣은 앱들의
  // 연결을 전부 끊는다.
  test('a key can be read again instead of being shown once', () => {
    expect(keySql).toContain('token text not null');
    expect(server).toContain("'id, label, token, allowed_memory_ids, daily_limit, expires_at, created_at, rotated_at, last_used_at'");
    expect(panel).toContain('data-testid="what-i-said-remote-key-value"');
    expect(panel).toContain('revealedKeyId === key.id ? (key.token ?? \'\')');
  });

  // 회전이 신원을 바꾸면 UI 가 손잡이를 잃고 "회전"이 "회수 후 재발급"이 된다.
  test('rotation replaces the token in place, keeping the key identity', () => {
    expect(keySql).toContain('update public.portmgr_what_i_said_feed_keys k');
    expect(keySql).toContain('rotated_at = now()');
    expect(keySql).toContain("message = 'WHAT_I_SAID_KEY_NOT_FOUND'");
  });

  /**
   * 제외 목록을 못 읽었는데 올려 버리면 제외의 의미가 사라진다. 앞서 여기서
   * 빈 목록으로 떨어뜨렸는데, 그 방향이 틀렸다 — 못 올린 것은 다음 수집이
   * 따라잡지만 올려 버린 것은 되돌릴 수 없다.
   */
  test('a failed exclusion read stops the upload instead of uploading anyway', () => {
    expect(server).toContain("throw new Error('WHAT_I_SAID_EXCLUSIONS_UNAVAILABLE')");
    expect(server).toContain('// 제외를 확인하지 못한 채 올리면 제외의 의미가 사라진다. 다음 수집에서 따라잡는다.');
  });

  test('exclusion and all-device cleanup share one serialized transaction', () => {
    expect(keySql).toContain('portmgr_set_what_i_said_memory_exclusion');
    expect(keySql).toContain("hashtextextended('what-i-said-memory:' || btrim(p_memory_id), 0)");
    expect(keySql).toContain('delete from public.portmgr_what_i_said_prompts p');
    expect(keySql).toContain('get diagnostics v_deleted = row_count');
    expect(keySql).toContain("hashtextextended('what-i-said-memory:' || new.memory_id, 0)");
  });

  // 이 RPC 는 호출부가 0개여서 서버 쪽 "90일 보관"이 사실이 아니었다.
  test('retention cleanup actually runs', () => {
    expect(server).toContain("sb.rpc('portmgr_what_i_said_cleanup'");
  });
});
