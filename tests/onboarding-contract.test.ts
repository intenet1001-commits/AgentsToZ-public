import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AI_TABLE_PROMPT,
  MIGRATION_SQL,
  PORTMGR_TABLES,
  PROJECT_MEMORY_IDENTITY_SQL,
  PROJECT_MEMORY_LEDGER_SECURITY_SQL,
  SCHEMA_TABLE_COUNT,
  aiTablePromptForAllowedEmails,
  migrationSqlForAllowedEmails,
  portalSqlForAllowedEmails,
} from '../src/schemaSql';

const root = join(import.meta.dir, '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

test('schema count and AI prompt are derived from the canonical migration', () => {
  expect(SCHEMA_TABLE_COUNT).toBe(PORTMGR_TABLES.length);
  expect(MIGRATION_SQL).toContain('github_urls text[]');
  expect(MIGRATION_SQL).toContain('portmgr_project_memories');
  expect(MIGRATION_SQL).toContain('portmgr_project_memory_heads');
  expect(MIGRATION_SQL).toContain('portmgr_claim_project_memory');
  expect(MIGRATION_SQL).toContain('portmgr_append_project_memory_revision');
  expect(MIGRATION_SQL).toContain('to authenticated, service_role');
  expect(AI_TABLE_PROMPT).toContain(`${SCHEMA_TABLE_COUNT}개 테이블`);
});

test('mixed v8/v9 writers cannot bypass identity or atomic-head guards', () => {
  const migration = source('supabase/migrations/20260812000100_project_memory_identity_cas.sql');
  for (const sql of [PROJECT_MEMORY_IDENTITY_SQL, migration]) {
    expect(sql).toContain('portmgr_canonical_repo_key');
    expect(sql).toContain('git@github');
    expect(sql).toContain('ssh://git@github');
    expect(sql).toContain('else null');
    expect(sql).toContain('portmgr_guard_project_memory_revision_insert');
    expect(sql).toContain('PROJECT_MEMORY_IDENTITY_MISMATCH');
    expect(sql).toContain('PROJECT_MEMORY_STALE_PARENT');
    expect(sql).toContain('before insert on public.portmgr_project_memory_revisions');
  }
});

test('project-memory ledger writes are server-mediated and append-only', () => {
  const migration = source('supabase/migrations/20260812000200_project_memory_ledger_security.sql');
  for (const sql of [PROJECT_MEMORY_LEDGER_SECURITY_SQL, migration]) {
    expect(sql).toContain("revoke all privileges on table public.%I from public, anon, authenticated, service_role");
    expect(sql).toContain("grant select on table public.%I to authenticated");
    expect(sql).toContain("grant select, insert, delete on table public.portmgr_project_memory_revisions to service_role");
    expect(sql).toContain("grant select, insert on table public.portmgr_project_memory_journal to service_role");
    expect(sql).toContain("grant select, insert on table public.portmgr_project_memory_feedback to service_role");
    expect(sql).not.toContain("grant select, insert, update, delete on table public.portmgr_project_memory_journal");
    expect(sql).not.toContain("grant select, insert, update, delete on table public.portmgr_project_memory_feedback");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  }
  expect(MIGRATION_SQL.lastIndexOf(PROJECT_MEMORY_LEDGER_SECURITY_SQL))
    .toBeGreaterThan(MIGRATION_SQL.lastIndexOf(
      'grant select, insert, update, delete on table portmgr_project_memory_feedback to authenticated;',
    ));
});

test('anon hardening covers every current and future portmgr table without reopening ledger writes', () => {
  const migration = source('supabase/migrations/20260814000100_lock_all_portmgr_anon.sql');
  expect(migration).toContain("tablename like 'portmgr\\_%'");
  expect(migration).toContain('alter table public.%I enable row level security');
  expect(migration).toContain('revoke all privileges on table public.%I from anon');
  expect(migration).toContain('revoke all privileges on table public.%I from public');
  expect(migration).not.toContain('grant select');
  expect(migration).not.toContain('drop policy');
  expect(migration).not.toContain('create policy');
  for (const table of PORTMGR_TABLES) {
    expect(MIGRATION_SQL).toContain(table);
  }
});

test('authenticated access is still server-allowlisted and canonical setup never resets membership', () => {
  const upgrade = source('supabase/migrations/20260815010000_enforce_server_email_allowlist.sql');
  const legacyRepair = source('supabase/migrations/20260804010000_enable_rls_authenticated_only.sql');
  for (const sql of [MIGRATION_SQL, upgrade, legacyRepair]) {
    expect(sql).toContain('create table if not exists public.portmgr_allowed_members');
    expect(sql).toContain('security definer');
    expect(sql).toContain('from public.portmgr_allowed_members');
    expect(sql).toMatch(/revoke all privileges on table public\.portmgr_allowed_members from [^;]*authenticated/);
    expect(sql).not.toContain('cardinality(public.portmgr_allowed_emails()) = 0');
    expect(sql).toContain('alter table public.portmgr_allowed_members enable row level security');
    expect(sql).not.toMatch(/grant select, insert, update, delete on table (?:public\.)?portmgr_allowed_members to authenticated/);
  }

  const configured = migrationSqlForAllowedEmails([
    ' Owner@Example.com ',
    'owner@example.com',
    'teammate@example.com',
  ]);
  expect(configured).toContain("values ('owner@example.com'),\n  ('teammate@example.com')");
  expect(configured).not.toContain('Owner@Example.com');
  expect(() => migrationSqlForAllowedEmails([])).toThrow('허용 이메일');
  const portalSql = portalSqlForAllowedEmails(['Owner@example.com']);
  expect(portalSql).toContain("values ('owner@example.com')");
  expect(AI_TABLE_PROMPT).toContain('<OWNER_GOOGLE_EMAIL>');
  expect(AI_TABLE_PROMPT).toContain('literal placeholder 상태로 실행하지 마');
  const aiPrompt = aiTablePromptForAllowedEmails(['Owner@example.com']);
  expect(aiPrompt).toContain("values ('owner@example.com')");
  expect(aiPrompt).not.toContain('<OWNER_GOOGLE_EMAIL>');
  expect(() => migrationSqlForAllowedEmails(['not-an-email'])).toThrow('올바른 이메일');
});

test('desktop sidecar service role can pass guarded RPCs without weakening web membership', () => {
  const desktopMigration = source('supabase/migrations/20260823000600_allow_desktop_service_role_membership.sql');
  for (const sql of [MIGRATION_SQL, desktopMigration]) {
    expect(sql).toContain("coalesce(auth.jwt() ->> 'role', '') = 'service_role'");
    expect(sql).toContain("coalesce(auth.jwt() ->> 'role', '') = 'authenticated'");
    expect(sql).toContain('from public.portmgr_allowed_members member');
    expect(sql).toContain('to authenticated, service_role');
  }
  expect(desktopMigration).not.toContain('to anon');
});

test('both API setup paths return the canonical migration instead of a stale DDL copy', () => {
  const api = source('api-server.ts');
  expect(api).toContain('migrationSqlForAllowedEmails');
  expect((api.match(/migrationSqlForAllowedEmails\(allowedEmails\)/g) ?? []).length).toBe(2);
  expect(api).toContain('const { ref, allowedEmails } = await req.json()');
  expect(api).toContain('허용 이메일 필수');
  expect(api).not.toContain('7개 테이블 자동 생성 완료');
});

test('first-run keeps web authentication while desktop completion has no user login', () => {
  const app = source('src/App.tsx');
  const setup = source('src/SetupWizard.tsx');
  const env = source('.env.example');

  expect(app).toContain("SETUP_WIZARD_SEEN_KEY = 'portmanager-setup-wizard-seen-v1'");
  expect(app).not.toContain("fetch('http://127.0.0.1:3001/api/portal'");
  expect(app).not.toContain("fetch('http://localhost:3001/api/open-orca-localhost'");
  expect(app).not.toContain("fetch('http://localhost:3001/api/open-orca-app'");
  const completion = app.slice(app.indexOf('onComplete={async ({ supabaseUrl'), app.indexOf('onSkip={() =>'));
  expect(completion.indexOf("localStorage.setItem(SETUP_WIZARD_SEEN_KEY, '1')"))
    .toBeGreaterThan(completion.indexOf("await invoke('save_portal'"));
  expect(completion).toContain('if (!isTauri())');
  expect(completion).not.toContain('signInNativeSupabase(supabase');
  expect(completion).toContain('signInBrowserSupabase(supabase');
  expect(completion).toContain(".rpc('portmgr_is_member')");
  expect(completion).toContain('isMember !== true');
  expect(completion.indexOf("localStorage.setItem(SETUP_WIZARD_SEEN_KEY, '1')"))
    .toBeGreaterThan(completion.indexOf('signInBrowserSupabase(supabase'));
  expect(completion.indexOf('setShowSetupWizard(false)'))
    .toBeLessThan(completion.indexOf('} catch (e)'));
  expect(setup).toContain('=> void | Promise<void>');
  expect(setup).toContain('await onComplete();');
  const oneClickFinish = setup.slice(setup.indexOf("if (id === 'finish_setup')"), setup.indexOf('async function pollStep'));
  expect(oneClickFinish).toContain('await onComplete({');
  expect(oneClickFinish.indexOf('setAllDone(true)')).toBeGreaterThan(oneClickFinish.indexOf('await onComplete({'));
  expect(oneClickFinish).not.toContain('setTimeout(() => onComplete');
  expect(app).toContain('isLoading || isDeployedWeb()');
  expect(setup).toContain('crypto.randomUUID()');
  // 권장 첫 단말 3단계 화면도 동일한 canonical email-scoped SQL을 쓴다.
  expect((setup.match(/const \[allowedEmail, setAllowedEmail\]/g) ?? [])).toHaveLength(4);
  expect(setup).toContain('portalSqlForAllowedEmails([allowedEmail])');
  expect(setup).not.toContain('앱에는 로그인 단계가 없고 Push/Pull은 anon key로 바로 동작한다');
  expect(setup).toContain('Google OAuth 세션의 authenticated JWT');
  expect(setup).toContain('http://127.0.0.1:3001/api/auth/native/callback');
  expect(setup).toContain('Redirect URLs');
  expect(setup).toContain('migrationSqlForAllowedEmails([allowedEmail])');
  expect(setup).toContain('allowedEmails: [allowedEmail]');
  expect(setup).not.toContain('code={MIGRATION_SQL}');
  expect(setup).not.toContain('VITE_PORTAL_PASSWORD_HASH');
  expect(env).not.toContain('VITE_PORTAL_PASSWORD_HASH');

  for (const skill of [
    '.agents/skills/onboarding/SKILL.md',
    '.claude/skills/onboarding/SKILL.md',
  ]) {
    const body = source(skill);
    expect(body).toContain('migrationSqlForAllowedEmails');
    expect(body).toContain('ALLOWED_EMAIL=owner@example.com');
    expect(body).not.toContain("console.log(MIGRATION_SQL)");
    expect(body).not.toContain('앱 안에는 로그인 화면이 없다');
    expect(body).not.toContain('앱에는 별도 로그인 단계가 없다');
    expect(body).not.toContain('저장한 URL + anon key로 Push/Pull이 바로 동작한다');
    expect(body).not.toContain('VITE_PORTAL_PASSWORD_HASH');
    expect(body).not.toContain('RLS 비활성화');
  }
});

test('web setup keeps same-origin OAuth while the desktop app uses its local service proxy', () => {
  const setup = source('src/SetupWizard.tsx');
  const portal = source('src/PortalManager.tsx');
  const client = source('src/lib/supabaseClient.ts');
  const api = source('api-server.ts');
  const readme = source('README.md');
  const security = source('docs/SECURITY-SETUP.md');

  expect(client).toContain("DESKTOP_PROXY_URL = 'http://127.0.0.1:3001/api/supabase-proxy'");
  expect(client).toContain('desktop ? DESKTOP_OPTIONS : AUTH_OPTIONS');
  expect(api).toContain("const DESKTOP_SUPABASE_PROXY_PREFIX = '/api/supabase-proxy'");
  expect(api).toContain('isTauriAppOrigin(requestOrigin)');
  expect(api).toContain("loadServiceRoleKey(APP_DATA_DIR)");
  expect(api).not.toContain('serviceRoleKey: target.serviceRoleKey');
  expect(portal).toContain('!isTauri() && !isDeployedWeb()');
  expect(portal).toContain('데스크톱 앱은 Google 로그인이 필요하지 않습니다.');
  expect(setup).toContain('로컬 관리자 연결을 확인했으므로 앱에서는 Google 로그인 없이 Push/Pull을 사용합니다.');
  for (const guide of [setup, portal, readme, security]) {
    expect(guide).not.toContain('저장한 URL + anon key로 Push/Pull이 바로 동작한다');
  }
  // 최초 단말 권장·CLI 고급·추가 단말의 세 연결 화면 모두 anon 차단을 검사한다.
  expect((setup.match(/const \[authRequired, setAuthRequired\]/g) ?? [])).toHaveLength(3);
  expect(setup).toContain('parseOnboardingHandoff(raw)');
  expect(setup).toContain('const [freshDeviceRequired, setFreshDeviceRequired] = useState(true)');
  expect(setup).toContain('기존 단말 ID는 복사하지 않습니다');
  expect(setup).toContain('/api/supabase-service-key/from-cli');
  expect(setup).toContain('http://127.0.0.1:9000/portal.html');
  expect(portal).toContain('http://127.0.0.1:9000/portal.html');
  expect(readme).toContain('http://127.0.0.1:9000/portal.html');
  expect(security).toContain('portmgr-auth');
  expect(security).toContain('20260815010000_enforce_server_email_allowlist.sql');
  expect(security).not.toContain('select array[]::text[];   -- ← 비우면 "로그인한 모든 사용자" 허용');
  expect(readme).toContain('migrationSqlForAllowedEmails');
  expect(readme).not.toContain("console.log(MIGRATION_SQL)");
  expect(portal).toContain(".rpc('portmgr_is_member')");
  expect(portal).toContain('aiTablePromptForAllowedEmails([allowedEmail])');
});

test('public email configuration is documented as a client prefilter, never the RLS authority', () => {
  const envExample = source('.env.example');
  const portal = source('src/portal-main.tsx');
  const guide = source('docs/user-guide/GUIDE.md');
  for (const text of [envExample, portal, guide]) {
    expect(text).toContain('portmgr_allowed_members');
    expect(text).toMatch(/client|클라이언트|UI/);
  }
  expect(envExample).not.toContain('실제 접근 제어는 Supabase RLS가 담당합니다.');
});
