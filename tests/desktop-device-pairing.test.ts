import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const portal = readFileSync(new URL("../src/portal-main.tsx", import.meta.url), "utf8");
const setup = readFileSync(new URL("../src/SetupWizard.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const server = readFileSync(new URL("../api-server.ts", import.meta.url), "utf8");
const codexOnboarding = readFileSync(new URL("../.agents/skills/onboarding/SKILL.md", import.meta.url), "utf8");
const claudeOnboarding = readFileSync(new URL("../.claude/skills/onboarding/SKILL.md", import.meta.url), "utf8");

test("the deployed portal issues a Mac/Windows invite instead of creating a ghost device row", () => {
  expect(portal).toContain("createDesktopDeviceInvite");
  expect(portal).toContain("Mac·Windows 연결");
  expect(portal).toContain("앱이 연결을 완료할 때 새 단말 ID와 DB 행이 등록됩니다");
  expect(portal).not.toContain("async function registerThisDevice()");
  expect(portal).not.toContain("async function handleCopySetup()");
});

test("a registered first device can issue the same invite without a personal Vercel portal", () => {
  expect(setup).toContain("function AdditionalDeviceInviteWizard");
  expect(setup).toContain("개인 Vercel 포털을 만들지 않아도 여러 Mac·Windows를 연결할 수 있습니다");
  expect(setup).toContain("createDesktopDeviceInvite({");
  expect(setup).toContain("isRegisteredDevice ? 'pair_device' : 'additional'");
  expect(setup).toContain("다른 PC 연결 정보 만들기");
});

test("additional-device onboarding always creates its own identity", () => {
  expect(setup).toContain("freshDeviceRequired");
  expect(setup).toContain("이 기기는 새 단말 ID를 자동 생성합니다");
  expect(setup).not.toContain("이 단말 ID 그대로 사용");
  expect(app).toContain("setupKind === 'additional'");
  expect(app).not.toContain("단말 ID 이어받음");
});

test("desktop identities are viewed or safely linked, never switched or row-deleted in settings", () => {
  expect(setup).not.toContain("이 단말 ID 그대로 사용");
  expect(portal).not.toContain("현재 보고 있는 device 의 ID/이름을 함께 전달");
  expect(portal).not.toContain("portmanager-setup");
  expect(app).not.toContain("단말 ID 이어받음");
  expect(readFileSync(new URL("../src/PortalManager.tsx", import.meta.url), "utf8"))
    .not.toContain("이 기기로 전환 (ID 변경)");
});

test("a loginless additional app must establish its own local admin path", () => {
  expect(setup).toContain("로컬 관리자 연결 확인");
  expect(setup).toContain("/api/supabase-service-key/from-cli");
  expect(server).toContain("body.supabaseUrl");
  expect(app).toContain("localAdminReady");
});

test("every desktop Supabase onboarding path finishes its local admin connection in the wizard", () => {
  expect((setup.match(/const \[localAdminReady, setLocalAdminReady\]/g) ?? [])).toHaveLength(3);
  expect(setup).toContain("setupKind: 'first', localAdminReady: !isTauri() || localAdminReady");
  expect(setup).toContain("await configureLocalAdminFromCli(sbUrl)");
  expect(app).toContain("(setupKind === 'first' || setupKind === 'additional') && isTauri() && !localAdminReady");
});

test("registration retries reuse one pending identity and only finalize after the DB upsert", () => {
  expect(setup).toContain("pendingDeviceId");
  expect(app).toContain("existingObj.pendingDeviceRegistration && existingObj.deviceId");
  expect(app).toContain("pendingDeviceRegistration: true");
  expect(app).toContain("pendingDeviceRegistration: false");
  expect(app.indexOf("pendingDeviceRegistration: false"))
    .toBeGreaterThan(app.indexOf("if (!registration.ok)"));
  expect(setup).toContain("hasExistingDevice");
  expect(app).toContain("deviceId || existingObj.deviceId || crypto.randomUUID()");
});

test("onboarding status reports only local evidence, not credential values", () => {
  expect(server).toContain('"/api/onboarding/status"');
  expect(server).toContain("diagnoseOnboardingDevice({");
  const route = server.slice(
    server.indexOf('url.pathname === "/api/onboarding/status"'),
    server.indexOf('// Portal 데이터 로드'),
  );
  expect(route).toContain("...diagnosis");
  expect(route).toContain("'Cache-Control': 'no-store'");
});

test("both onboarding agents teach the same host-first registration boundary", () => {
  for (const guide of [codexOnboarding, claudeOnboarding]) {
    expect(guide).toContain("포털은 연결 정보만 만든다");
    expect(guide).toContain("기존 단말 ID를 복사하거나 선택하지 않는다");
    expect(guide).toContain("새 단말 앱이 새 UUID를 생성");
    expect(guide).toContain("Ubuntu/AWS/Linux");
    expect(guide).toContain("호스트를 먼저 등록");
    expect(guide).toContain("pendingDeviceRegistration");
    expect(guide).toContain("/api/onboarding/status");
    expect(guide).toContain("개인 Vercel 포털은 추가 Mac·Windows의 필수 조건이 아니다");
    expect(guide).toContain("Playwright");
  }
  expect(setup).toContain("기존 단말 ID,");
  expect(setup).toContain("service_role 키, 로그인 토큰은 복사하지 않는다");
  expect(setup).toContain("Tauri 앱은 localhost sidecar의 로컬 service_role 연결");
});

test("easy portal deploy persists build-time configuration before production deploy", () => {
  expect(setup).toContain("환경 변수 저장 + 자동 배포 시작");
  expect(setup).toContain("Playwright 브라우저 보조 요청 복사");
  expect(server).toContain("['link', '--yes']");
  expect(server).toContain("['env', 'add', name, 'production', '--force']");
  expect(server).toContain("stdinValue: value");
  expect(server).toContain("text.split(options.stdinValue).join('[입력값 숨김]')");
  expect(server).toContain("['deploy', '--prod', '--yes']");
  expect(server).toContain("isPublicSupabaseClientKey");
});
