import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRemoteDeviceEnrollmentCommand,
  buildRemoteDeviceUpgradeCommand,
  buildRemoteHostProjectCommand,
  inferGitHubRepositoryName,
  normalizeRemoteProjectPath,
  remoteEnrollmentTokenFromBytes,
  REMOTE_DEVICE_AGENT_VERSION,
} from '../src/remoteDeviceEnrollment';
import { REMOTE_DEVICE_SQL } from '../src/remoteDeviceSql';
import { REMOTE_DEVICE_RECONNECT_SQL } from '../src/remoteDeviceReconnectSql';
import { REMOTE_HOST_PROJECTS_SQL } from '../src/remoteHostProjectsSql';
import { SAFE_REMOTE_DEVICE_ROTATION_SQL } from '../src/safeRemoteDeviceRotationSql';
import { REMOTE_DEVICE_CLAIM_RECOVERY_SQL } from '../src/remoteDeviceClaimRecoverySql';
import { REMOTE_DEVICE_AGENT_VERSION_SQL } from '../src/remoteDeviceAgentVersionSql';
import { REMOTE_DEVICE_HISTORY_TOPIC_SQL } from '../src/remoteDeviceHistoryTopicSql';
import { REMOTE_DEVICE_RECONNECT_LINEAGE_SQL } from '../src/remoteDeviceReconnectLineageSql';
import { REMOTE_DEVICE_HISTORY_TRIGGER_FIX_SQL } from '../src/remoteDeviceHistoryTriggerFixSql';
import { MIGRATION_SQL, PORTMGR_TABLES } from '../src/schemaSql';

const root = join(import.meta.dir, '..');

test('AWS 등록 명령은 복붙 가능한 일회용 HTTPS 흐름이며 service role을 노출하지 않는다', () => {
  const token = remoteEnrollmentTokenFromBytes(new Uint8Array(32).fill(10));
  const command = buildRemoteDeviceEnrollmentCommand({
    scriptUrl: 'https://portal.example.com/agentstoz-remote-device.sh',
    token,
    supabaseUrl: 'https://project.supabase.co',
    supabaseAnonKey: 'public-anon-key',
    deviceName: "Hermes AWS '운영'",
    environmentKind: 'aws',
    projectPath: '/home/ubuntu/AgentsToZ_byCS/',
  });
  expect(token).toBe('0a'.repeat(32));
  expect(command).toContain('curl --fail --silent --show-error --location --connect-timeout 10 --max-time 60');
  expect(command).toContain("--project '/home/ubuntu/AgentsToZ_byCS'");
  expect(command).toContain("Hermes AWS '\"'\"'운영'\"'\"''");
  expect(command).toContain("trap 'rm -f \"$tmp_script\"' EXIT");
  expect(command).not.toMatch(/service[_ -]?role/i);
  expect(() => buildRemoteDeviceEnrollmentCommand({
    scriptUrl: 'http://unsafe.example.com/script.sh', token,
    supabaseUrl: 'https://project.supabase.co', supabaseAnonKey: 'anon',
    deviceName: 'AWS', environmentKind: 'aws', projectPath: '/srv/app',
  })).toThrow('HTTPS');
  expect(normalizeRemoteProjectPath('/srv/app///')).toBe('/srv/app');
  expect(() => normalizeRemoteProjectPath('relative/path')).toThrow('절대경로');
});

test('headless agent installs a reusable status command and reports memory/Git observations', () => {
  const script = readFileSync(join(root, 'public/agentstoz-remote-device.sh'), 'utf8');
  expect(script).toContain('--sync');
  expect(script).toContain('agentstoz-status');
  expect(script).toContain('PROJECT_CONFIG_DIR="$CONFIG_DIR/projects"');
  expect(script).toContain('for project_config in "$project_dir"/*.json');
  expect(script).toContain('--sync --config "$project_config"');
  expect(script).toContain('git -C "$PROJECT_PATH" fetch --quiet --prune origin');
  expect(script).toContain('p_content_hash');
  expect(script).toContain('p_git_fetch_ok');
  expect(script).toContain('portmgr_report_remote_device_status');
  expect(script).toContain('portmgr_report_remote_device_inventory');
  expect(script).toContain('portmgr_report_remote_device_agent_version');
  expect(script).toContain('AGENT_REPORT_VERSION="${AGENT_VERSION}|b${BUN_READY_CODE}a${API_READY_CODE}h${HERMES_READY_CODE}"');
  expect(script).toContain('[[ -x "$HOME/.bun/bin/bun" ]]');
  expect(script).toContain('REMOTE_CURL_ARGS=(--connect-timeout 10 --max-time 30)');
  expect(script).toContain("health.get('service') == 'agentstoz-api'");
  expect(script).toContain("health['schemaVersion'] >= 10");
  expect(script).toContain('if agentstoz_api_ready; then');
  expect(script).toContain('TimeoutStartSec=4min');
  expect(script).toContain('flock -n 9');
  expect(script).toContain('timeout --signal=TERM 30s git -C "$PROJECT_PATH" fetch');
  expect(script).toContain('프로젝트는 아직 만들지 않았습니다.');
  expect(script).toContain('--project-action');
  expect(script).toContain('"clone" || "$PROJECT_ACTION" == "memory" || "$PROJECT_ACTION" == "new"');
  expect(script).toContain('agentstoz-remote-host-sync.timer');
  expect(script).toContain('--force-new-device');
  expect(script).toContain("'p_force_new'");
  expect(script).toContain("data['device_id'] = os.environ['DEVICE_ID_VALUE']");
  expect(script).toContain('migrate_project_configs');
  expect(script).toContain('rotation_from_device_id');
  expect(script).toContain('옵션 값이 필요합니다');
  expect(script).toContain('portmgr_confirm_remote_device_claim');
  expect(script).toContain('portmgr_cancel_remote_device_claim');
  expect(script).toContain('config_migration_pending');
  expect(script).toContain('"$agent_script" --sync --config "$project_config" || status=$?');
  expect(script).toContain('.agentstoz-staging');
  expect(REMOTE_DEVICE_AGENT_VERSION).toBe('4');
  expect(script).not.toMatch(/service[_ -]?role/i);
});

test('force reconnect command explicitly requests a distinct server identity', () => {
  const command = buildRemoteDeviceEnrollmentCommand({
    scriptUrl: 'https://portal.example.com/agentstoz-remote-device.sh',
    token: 'ab'.repeat(32),
    supabaseUrl: 'https://project.supabase.co',
    supabaseAnonKey: 'public-anon-key',
    deviceName: 'Hermes AWS',
    environmentKind: 'aws',
    projectPath: '/home/ubuntu/AgentsToZ_byCS',
    forceNewDevice: true,
  });
  expect(command).toContain('--force-new-device');
});

test('에이전트 업데이트 명령은 기존 identity를 유지하고 HTTPS 스크립트만 교체한다', () => {
  const command = buildRemoteDeviceUpgradeCommand('https://portal.example.com/agentstoz-remote-device.sh');
  expect(command).toContain('install -m 700 "$tmp_script" "$staged"');
  expect(command).toContain('mv -f -- "$staged" "$installed"');
  expect(command).toContain('--connect-timeout 10 --max-time 60');
  expect(command).not.toContain('install -m 700 "$tmp_script" "$installed"');
  expect(command).toContain('"$installed" --sync');
  expect(command).not.toContain('--token');
  expect(() => buildRemoteDeviceUpgradeCommand('http://unsafe.example.com/script.sh')).toThrow('HTTPS');
});

test('host registration precedes project creation and each project action is copyable', () => {
  const host = buildRemoteDeviceEnrollmentCommand({
    scriptUrl: 'https://portal.example.com/agentstoz-remote-device.sh',
    token: 'cd'.repeat(32),
    supabaseUrl: 'https://project.supabase.co',
    supabaseAnonKey: 'public-anon-key',
    deviceName: 'Hermes AWS',
    environmentKind: 'aws',
    workspaceRoot: '/home/ubuntu/projects',
  });
  expect(host).toContain("--workspace-root '/home/ubuntu/projects'");
  expect(host).not.toContain('--project ');

  expect(buildRemoteHostProjectCommand({
    action: 'clone', projectName: 'portal', workspaceRoot: '/home/ubuntu/projects',
    repositoryUrl: 'https://github.com/example/portal.git',
  })).toContain("--repository-url 'https://github.com/example/portal.git'");
  expect(buildRemoteHostProjectCommand({
    action: 'memory', projectName: 'restored', workspaceRoot: '/home/ubuntu/projects',
    memoryId: '884575df-63c4-407c-8b43-860d1295e663',
  })).toContain("--memory-id '884575df-63c4-407c-8b43-860d1295e663'");
  expect(buildRemoteHostProjectCommand({
    action: 'new', projectName: 'new-app', workspaceRoot: '/home/ubuntu/projects',
  })).toContain("--project-action 'new'");
  expect(() => buildRemoteHostProjectCommand({
    action: 'clone', projectName: 'unsafe', workspaceRoot: '/home/ubuntu/projects',
    repositoryUrl: 'https://gitlab.com/example/unsafe.git',
  })).toThrow('GitHub');
  expect(inferGitHubRepositoryName('https:')).toBe('');
  expect(inferGitHubRepositoryName('https://github.com/intenet1001-commits/typed-repository.git')).toBe('typed-repository');
  expect(inferGitHubRepositoryName('git@github.com:intenet1001-commits/ssh-repository.git')).toBe('ssh-repository');
});

test('canonical setup and versioned migration carry the same remote-device SQL contracts', () => {
  const migration = readFileSync(join(root, 'supabase/migrations/20260823000700_remote_device_enrollment.sql'), 'utf8').trim();
  expect(REMOTE_DEVICE_SQL.trim()).toBe(migration);
  for (const table of [
    'portmgr_remote_devices',
    'portmgr_remote_device_credentials',
    'portmgr_remote_device_enrollments',
    'portmgr_remote_device_memory_access',
    'portmgr_device_identity_aliases',
  ]) {
    expect(PORTMGR_TABLES).toContain(table as never);
    expect(MIGRATION_SQL).toContain(table);
  }
  expect(MIGRATION_SQL).toContain('portmgr_create_remote_device_enrollment');
  expect(MIGRATION_SQL).toContain('portmgr_claim_remote_device_enrollment');
  expect(MIGRATION_SQL).toContain('portmgr_update_remote_device');
  expect(MIGRATION_SQL).toContain('Registration removal is a credential revocation');
});

test('reconnect upgrade migration is canonical and supports a 24-hour token plus identity rotation', () => {
  const migration = readFileSync(join(root, 'supabase/migrations/20260823000800_remote_device_reconnect.sql'), 'utf8').trim();
  expect(REMOTE_DEVICE_RECONNECT_SQL.trim()).toBe(migration);
  expect(MIGRATION_SQL).toContain('p_force_new boolean default false');
  expect(MIGRATION_SQL).toContain('p_ttl_seconds integer default 86400');
  expect(MIGRATION_SQL).toContain('portmgr_remote_device_memory_access');
  expect(MIGRATION_SQL).toContain('delete from public.portmgr_remote_device_credentials');
});

test('host-project hierarchy migration is canonical and preserves missing inventory as history', () => {
  const migration = readFileSync(join(root, 'supabase/migrations/20260823000900_remote_host_projects.sql'), 'utf8').trim();
  expect(REMOTE_HOST_PROJECTS_SQL.trim()).toBe(migration);
  expect(PORTMGR_TABLES).toContain('portmgr_remote_device_projects' as never);
  expect(MIGRATION_SQL).toContain('portmgr_create_remote_host_enrollment');
  expect(MIGRATION_SQL).toContain('portmgr_report_remote_device_inventory');
  expect(MIGRATION_SQL).toContain('set present = false');
});

test('credential rotation migration is canonical and finalizes only after local persistence', () => {
  const migration = readFileSync(join(root, 'supabase/migrations/20260823001000_safe_remote_device_rotation.sql'), 'utf8').trim();
  expect(SAFE_REMOTE_DEVICE_ROTATION_SQL.trim()).toBe(migration);
  expect(MIGRATION_SQL).toContain('portmgr_finalize_remote_device_rotation');
  const claimStart = migration.indexOf('create function public.portmgr_claim_remote_host_enrollment');
  const finalizeStart = migration.indexOf('create or replace function public.portmgr_finalize_remote_device_rotation');
  expect(migration.slice(claimStart, finalizeStart)).not.toContain('delete from public.portmgr_remote_device_credentials');
  expect(migration.slice(finalizeStart)).toContain('delete from public.portmgr_remote_device_credentials');
  expect(migration).toContain('REMOTE_DEVICE_ROTATION_NOT_AUTHORIZED');
  expect(readFileSync(join(root, 'public/agentstoz-remote-device.sh'), 'utf8')).toContain("'rotation_from_device_id'");
});

test('unpersisted claims are cancellable and expire instead of becoming permanent orphans', () => {
  const migration = readFileSync(join(root, 'supabase/migrations/20260823001100_remote_device_claim_recovery.sql'), 'utf8').trim();
  expect(REMOTE_DEVICE_CLAIM_RECOVERY_SQL.trim()).toBe(migration);
  expect(MIGRATION_SQL).toContain('portmgr_confirm_remote_device_claim');
  expect(MIGRATION_SQL).toContain('portmgr_cancel_remote_device_claim');
  expect(MIGRATION_SQL).toContain('portmgr_cleanup_remote_device_provisioning');
});

test('installed agent upgrades refresh the portal version without re-enrollment', () => {
  const migration = readFileSync(join(root, 'supabase/migrations/20260823001200_remote_device_agent_version.sql'), 'utf8').trim();
  expect(REMOTE_DEVICE_AGENT_VERSION_SQL.trim()).toBe(migration);
  expect(MIGRATION_SQL).toContain('portmgr_report_remote_device_agent_version');
});

test('revoked host history and Telegram topics migrate from the same canonical SQL', () => {
  const migration = readFileSync(join(root, 'supabase/migrations/20260823001300_remote_device_history_topics.sql'), 'utf8').trim();
  expect(REMOTE_DEVICE_HISTORY_TOPIC_SQL.trim()).toBe(migration);
  expect(MIGRATION_SQL).toContain('portmgr_create_remote_host_reconnect_enrollment');
  expect(MIGRATION_SQL).toContain('portmgr_inherit_revoked_remote_host_on_seen');
  expect(MIGRATION_SQL).toContain('telegram_thread_id');
  const agent = readFileSync(join(root, 'public/agentstoz-remote-device.sh'), 'utf8');
  expect(agent).toContain('project-memory-thread-bindings.json');
  expect(agent).toContain("'telegram_thread_id'");
});

test('history reconnect claim preserves an explicitly selected revoked predecessor', () => {
  const migration = readFileSync(join(root, 'supabase/migrations/20260823001400_preserve_remote_reconnect_lineage.sql'), 'utf8').trim();
  expect(REMOTE_DEVICE_RECONNECT_LINEAGE_SQL.trim()).toBe(migration);
  expect(MIGRATION_SQL).toContain('portmgr_preserve_remote_reconnect_lineage');
  expect(migration).toContain('old.claimed_at is null');
  expect(migration).toContain('new.claimed_at is not null');
});

test('history inheritance trigger does not collide with the PL/pgSQL OLD record', () => {
  const migration = readFileSync(join(root, 'supabase/migrations/20260823001500_fix_remote_history_trigger_alias.sql'), 'utf8').trim();
  expect(REMOTE_DEVICE_HISTORY_TRIGGER_FIX_SQL.trim()).toBe(migration);
  expect(MIGRATION_SQL).toContain('portmgr_inherit_revoked_remote_host_on_seen');
  expect(migration).toContain('portmgr_remote_devices predecessor');
  expect(migration).not.toContain('portmgr_remote_devices old ');
});

test('portal explains command expiry versus persistent connection and supports per-memory server linking', () => {
  const manager = readFileSync(join(root, 'src/RemoteDeviceManager.tsx'), 'utf8');
  const directory = readFileSync(join(root, 'src/PortalMemoryDirectory.tsx'), 'utf8');
  expect(manager).toContain('등록된 단말 연결은 사용자가 「등록 해제」할 때까지 계속 유지됩니다');
  expect(manager).toContain('강제 재연결 명령 만들기');
  expect(manager).toContain('value={86400}>24시간');
  expect(manager).toContain('단말을 먼저 등록합니다');
  expect(manager).toContain('GitHub 복제');
  expect(manager).toContain('기억으로 복원');
  expect(manager).toContain("'border-zinc-800 text-zinc-400 hover:bg-zinc-900'");
  expect(manager).toContain('text-[10px] leading-relaxed text-zinc-400');
  expect(manager).toContain('projectName === previousInferred');
  expect(manager).toContain('historicalAwsMemory && activeDevices.length === 0');
  expect(manager).toContain("aws: 'AWS Ubuntu'");
  expect(directory).toContain('data-testid="portal-memory-connect-cloud"');
  expect(directory).toContain('initialMemoryId={preferredRemoteMemoryId}');
});
