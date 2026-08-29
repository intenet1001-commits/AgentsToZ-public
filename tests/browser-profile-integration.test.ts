import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DEPLOYMENT_BROWSER_PROFILE_STORAGE_KEY } from '../src/browserProfile';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const portalManager = readFileSync(new URL('../src/PortalManager.tsx', import.meta.url), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

describe('deployment Chrome profile integration', () => {
  test('offers a persisted local profile selector but not on deployed web', () => {
    expect(app).toContain('data-testid="deployment-browser-profile"');
    expect(DEPLOYMENT_BROWSER_PROFILE_STORAGE_KEY).toBe('portmanager-deployment-browser-profile');
    expect(app).toContain('DEPLOYMENT_BROWSER_PROFILE_STORAGE_KEY');
    expect(app).toContain('!isDeployedWeb()');
    expect(app).toContain('browserProfileOptionLabel');
    const controlsStart = app.indexOf('{/* Claude/Terminal Controls');
    const terminalOnlyGuard = app.indexOf("{activeTab === 'ports' && (", controlsStart);
    const selector = app.indexOf('data-testid="deployment-browser-profile"', controlsStart);
    expect(selector).toBeLessThan(terminalOnlyGuard);
  });

  // 프로필을 고르는 자리에 여는 동작이 없어 고른 뒤 카드·상세로 내려가야 했다
  // (VOC 2026-08-15-2138). 고르는 이유가 그 세션으로 배포본을 보는 것이므로 같은 자리에 둔다.
  test('opens the selected project deployment from the profile selector', () => {
    expect(app).toContain('data-testid="deployment-open-selected"');
    const button = app.indexOf('data-testid="deployment-open-selected"');
    const selector = app.indexOf('data-testid="deployment-browser-profile"');
    expect(selector).toBeGreaterThan(0);
    expect(button).toBeGreaterThan(selector);
    // 여는 경로는 카드·상세와 같은 헬퍼여야 한다 — 프로필 적용과 실패 진단이 한 벌이다.
    expect(app.slice(button - 1400, button + 2600)).toContain('void openDeploymentWithDiagnostics(item)');
  });

  // v4SelectedId 는 앱을 켤 때마다 null 이다. 이 버튼을 그 선택에 매어 내보냈더니
  // 켜자마자 보이는 상태가 비활성 버튼이었고 "작동 안 함"으로 돌아왔다.
  test('never depends on a sidebar selection that is empty on launch', () => {
    const button = app.indexOf('data-testid="deployment-open-selected"');
    const region = app.slice(button - 1400, button + 2600);
    expect(region).not.toContain('왼쪽에서 프로젝트를 먼저 고르세요');
    // 선택이 없으면 배포 주소가 있는 프로젝트를 목록으로 띄워 거기서 고르게 한다.
    expect(region).toContain('setDeployPickerOpen');
    expect(app).toContain('data-testid="deployment-open-picker"');
    expect(app).toContain('data-testid="deployment-open-picker-item"');
    expect(region).toContain('deploymentTargets\n              .filter');
    // 비활성은 정말로 열 것이 하나도 없을 때뿐이다.
    expect(region).toContain('const empty = !target && deployable.length === 0');
    expect(region).toContain('현재 기기 프로젝트와 공유 포털에 배포 주소가 없습니다');
  });

  test('does not require Chrome profile discovery before the open button appears', () => {
    const button = app.indexOf('data-testid="deployment-open-selected"');
    const guard = app.slice(button - 1800, button);
    expect(guard).toContain('{!isDeployedWeb() && (() => {');
    expect(guard).not.toContain('browserProfiles.length > 0 && (() => {');
  });

  test('passes the selected web profile to deployment and project GitHub links', () => {
    const helperStart = app.indexOf('const openDeploymentWithDiagnostics');
    const helperEnd = app.indexOf('const openSelectedTerminalAtRoot', helperStart);
    const helper = app.slice(helperStart, helperEnd);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helper).toContain('selectedDeploymentBrowserProfile');
    expect(app).toContain('void openDeploymentWithDiagnostics(item)');
    const activeDeployRow = app.slice(
      app.indexOf('actionTestId="meta-open-deploy"') - 240,
      app.indexOf('actionTestId="meta-open-deploy"') + 360,
    );
    expect(activeDeployRow).toContain('openDeploymentWithDiagnostics(sel)');
    const githubHelperStart = app.indexOf('const openGitHubWithDiagnostics');
    const githubHelperEnd = app.indexOf('const openSelectedTerminalAtRoot', githubHelperStart);
    const githubHelper = app.slice(githubHelperStart, githubHelperEnd);
    expect(githubHelperStart).toBeGreaterThan(-1);
    expect(githubHelper).toContain('selectedDeploymentBrowserProfile');
    expect(app).toContain('void openGitHubWithDiagnostics(sel, url)');
    expect(app).toContain('void openGitHubWithDiagnostics(item, url)');
    expect(app).toContain('API.openInChrome(url, selectedDeploymentBrowserProfile).catch');
  });

  test('labels the top selector as the web account used for deploy and GitHub permissions', () => {
    expect(app).toContain('aria-label="웹 Chrome 프로필"');
    expect(app).toContain('배포·GitHub URL을 ${browserProfileOptionLabel(selectedDeploymentBrowserProfile)} 프로필로 엽니다');
    expect(app).toContain('<option value="">웹 · Chrome 기본</option>');
    expect(app).toContain('{`웹 · ${browserProfileOptionLabel(profile)}`}');
  });

  test('routes only automatic deploy bookmarks through the selected profile', () => {
    expect(portalManager).toContain('onOpenDeployUrl?: (url: string) => Promise<void>');
    expect(portalManager).toContain('isDeploymentPortalItem(item)');
    expect(portalManager).toContain('await onOpenDeployUrl(item.url)');
    expect(portalManager).toContain('await PortalAPI.openUrl(item.url)');
    expect(portalManager).toContain("invoke('open_in_chrome', { url, profileDirectory: null })");
    expect(app).toContain('onOpenDeployUrl={url => API.openInChrome(url, selectedDeploymentBrowserProfile)}');
    expect(portalManager).toContain('import.meta.env.VITE_PORTAL_URL');
    expect(portalManager).toContain('const portalUrl = portalUrlWithParams(portalBaseUrl, p)');
    expect(portalManager).toContain('data-testid="personal-portal-not-configured"');
    expect(portalManager).not.toContain([
      ['portmanager', 'portal'].join('-'),
      'vercel',
      'app',
    ].join('.'));
    expect(portalManager).toContain('await onOpenDeployUrl(portalUrl)');
  });

  test('supports profile discovery and argv-safe launch in local web and Tauri', () => {
    expect(api.indexOf("code: 'LOCAL_API_ORIGIN_DENIED'")).toBeLessThan(api.indexOf('/api/browser-profiles'));
    expect(api).toContain('/api/browser-profiles');
    expect(api).toContain('discoverChromeProfiles');
    expect(api).toContain('buildChromeProfileLaunch');
    expect(rust).toContain('fn list_browser_profiles');
    expect(rust).toContain('profile_directory: Option<String>');
    expect(rust).toContain('.arg(format!("--profile-directory={}", profile_directory))');
    expect(rust).toContain('list_browser_profiles,');
  });
});
