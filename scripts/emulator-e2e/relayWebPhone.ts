/**
 * J1-RELAY-WEB(WP5)의 휴대폰: Playwright WebKit(402×874)이 운영 포털 번들을 `https://portal.test`에서 연다.
 *
 * - 서빙은 context route로만 한다(portalFixtureBuild.ts — 포털을 로컬 서버로 띄우지 않는다). 요청은 셋으로 가른다:
 *   포털 파일(dist에서 fulfill) · shim(`https://localhost:<port>`로 그대로 continue — 브라우저가 shim에 직접 간다) · 나머지는 끊는다.
 *   어느 쪽이든 원장(ledger)에 남긴다(메서드·경로·origin만 — 헤더·본문·프래그먼트는 남기지 않는다).
 * - shim 인증서는 실행마다 만든 픽스처 CA라 `ignoreHTTPSErrors`로 받는다(대역 — labels.standIn).
 * - 응답 헤더는 운영과 같게 붙인다(portalResponseHeaders): web은 vercel.json이 그 경로에 붙이는 헤더 전부(CSP·COOP·CORP·
 *   X-Frame-Options·Referrer-Policy …), bundled는 iPhone 앱 PortalSchemeHandler의 집합. CSP(메타·헤더)의 connect-src에는 shim
 *   origin만 더한다. 넓히지 못한 HTML 문서(원문 connect-src가 없거나 CSP가 아예 없음)·CSP 헤더는 csp.missing으로 센다 — 레인이 실패로 본다.
 * - bundled 변형은 iPhone 앱처럼 `window.agentstozBundledPortal`을 동결 값으로 주입한다(앱 origin agentstoz-app://portal 대신
 *   https://portal.test에서 서빙 — 대역).
 * - 브라우저 프로세스 환경은 레인이 넘긴 네 키뿐이다(relayWebJourney.ts phoneBrowserEnv — HOME은 WebKit 샌드박스 때문에 실제 값).
 * 이 모듈은 Playwright 타입만 정적으로 가져온다. 런타임 import는 launchPhoneBrowser 안에서만 한다(단위 시험이 순수 도우미만 쓴다).
 */
import {existsSync, readFileSync} from 'node:fs';
import type {Browser, BrowserContext, Locator, Page} from 'playwright';
import {
  PORTAL_ORIGIN,
  assertPortalOrigin,
  classifyPhoneRequest,
  contentTypeFor,
  portalFilePath,
  portalResponseHeaders,
  widenPortalCsp,
  type PortalVariant,
  type VercelHeaderRule,
} from './portalFixtureBuild';

export const PHONE_VIEWPORT = Object.freeze({width: 402, height: 874});

export class PhoneBlockedError extends Error {}

export interface LedgerEntry {
  at: string;
  kind: 'portal' | 'shim' | 'abort';
  method: string;
  /** shim: 경로(예: /rest/v1/rpc/portmgr_remote_control_claim_pairing) · portal: 경로 · abort: origin. */
  target: string;
}

export interface PhoneBrowser {
  browser: Browser;
  version: string;
  close(): Promise<void>;
}

/** WebKit을 띄운다. 브라우저가 설치돼 있지 않으면 PhoneBlockedError(레인은 막힘으로 끝낸다). */
export async function launchPhoneBrowser(env: Record<string, string>): Promise<PhoneBrowser> {
  let webkit: typeof import('playwright').webkit;
  try { ({webkit} = await import('playwright')); }
  catch (error) { throw new PhoneBlockedError(`playwright is not installed: ${(error as Error).message}`); }
  const executable = webkit.executablePath();
  if (!executable || !existsSync(executable)) throw new PhoneBlockedError(`Playwright WebKit is not installed (${executable || 'no path'}) — run \`bunx playwright install webkit\``);
  const browser = await webkit.launch({headless: true, env});
  return {browser, version: browser.version(), close: () => browser.close()};
}

export interface PhoneOptions {
  label: string;
  dist: string;
  shimOrigin: string;
  /** 운영 응답 헤더의 정본(저장소 vercel.json — readVercelConfig). */
  vercel: {headers?: VercelHeaderRule[]};
  /** bundled 변형: 앱이 주입하는 값. */
  bundled?: {portalOrigin: string; supabaseUrl: string; supabaseAnonKey: string};
  /** 로그인된 기기를 흉내 낼 때(음성 사례): 다른 context의 storageState. */
  storageState?: Awaited<ReturnType<BrowserContext['storageState']>>;
}

export class Phone {
  readonly label: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly ledger: LedgerEntry[] = [];
  readonly pageErrors: string[] = [];
  readonly dialogs: string[] = [];
  /**
   * HTML 문서: 메타 CSP를 넓힌 수(widened) · CSP 헤더를 넓힌 응답 수(headerWidened) · 넓히지 못한 것(missing — 원문 connect-src가 없는
   * 메타·헤더, 또는 CSP가 아예 없는 HTML 문서). missing이 하나라도 있거나 /remote/를 연 휴대폰의 widened가 0이면 레인은 실패다.
   */
  readonly csp = {widened: 0, headerWidened: 0, missing: 0};
  readonly variant: PortalVariant;

  private constructor(label: string, context: BrowserContext, page: Page, variant: PortalVariant) {
    this.label = label;
    this.context = context;
    this.page = page;
    this.variant = variant;
  }

  static async open(phoneBrowser: PhoneBrowser, options: PhoneOptions): Promise<Phone> {
    assertPortalOrigin(PORTAL_ORIGIN);
    const context = await phoneBrowser.browser.newContext({
      viewport: PHONE_VIEWPORT,
      serviceWorkers: 'block',
      ignoreHTTPSErrors: true,
      locale: 'ko-KR',
      ...(options.storageState ? {storageState: options.storageState} : {}),
    });
    const page = await context.newPage();
    const variant: PortalVariant = options.bundled ? 'bundled' : 'web';
    const phone = new Phone(options.label, context, page, variant);
    page.on('pageerror', error => phone.pageErrors.push(error.message.slice(0, 500)));
    page.on('dialog', dialog => { phone.dialogs.push(dialog.message().slice(0, 300)); void dialog.accept().catch(() => {}); });
    if (options.bundled) {
      await context.addInitScript(value => {
        Object.defineProperty(window, 'agentstozBundledPortal', {value: Object.freeze(value), writable: false, configurable: false});
      }, options.bundled);
    }
    await context.route('**/*', async route => {
      const request = route.request();
      const decision = classifyPhoneRequest(request.url(), options.shimOrigin);
      const at = new Date().toISOString();
      if (decision.kind === 'shim') {
        phone.ledger.push({at, kind: 'shim', method: request.method(), target: new URL(request.url()).pathname});
        return route.continue().catch(() => {});
      }
      if (decision.kind === 'abort') {
        phone.ledger.push({at, kind: 'abort', method: request.method(), target: decision.origin});
        return route.abort().catch(() => {});
      }
      phone.ledger.push({at, kind: 'portal', method: request.method(), target: decision.path});
      const path = portalFilePath(options.dist, decision.path);
      if (!path || !existsSync(path)) return route.fulfill({status: 404, body: ''}).catch(() => {});
      const type = contentTypeFor(path);
      let body: Buffer | string = readFileSync(path);
      const served = portalResponseHeaders({variant, pathname: decision.path, contentType: type, shimOrigin: options.shimOrigin, vercel: options.vercel});
      if (type.startsWith('text/html')) {
        // 앱(BundledPortalConfig.servedHTML)은 메타 CSP에 QR의 Supabase를 https + wss로 더한다 — bundled는 그대로 따른다.
        const widened = widenPortalCsp(body.toString('utf8'), options.shimOrigin, {socket: variant === 'bundled'});
        if (widened.widened) phone.csp.widened += 1; else phone.csp.missing += 1;
        if (served.cspHeaderWidened) phone.csp.headerWidened += 1;
        if (served.cspHeaderUnwidened) phone.csp.missing += 1;
        body = widened.html;
      }
      return route.fulfill({status: 200, body, contentType: type, headers: served.headers}).catch(() => {});
    });
    return phone;
  }

  /** 원장의 shim 요청 수(선택: 경로 조건). */
  shimRequests(filter?: (path: string) => boolean): number {
    return this.ledger.filter(entry => entry.kind === 'shim' && (!filter || filter(entry.target))).length;
  }

  rpcCalls(fn: string): number {
    return this.shimRequests(path => path === `/rest/v1/rpc/${fn}`);
  }

  aborted(): string[] {
    return [...new Set(this.ledger.filter(entry => entry.kind === 'abort').map(entry => entry.target))];
  }

  /** 프래그먼트를 담은 주소로 연다. 실패 메시지에 주소가 실리지 않게 감싼다. */
  async goto(url: string): Promise<void> {
    try { await this.page.goto(url, {waitUntil: 'domcontentloaded', timeout: 45_000}); }
    catch (error) { throw new Error(`${this.label}: opening the portal failed (${(error as Error).name})`); }
  }

  async login(email: string, code: string, timeoutMs = 45_000): Promise<void> {
    const box = this.page.getByTestId('portal-email-login');
    await box.waitFor({timeout: timeoutMs});
    await box.getByLabel('이메일 코드로 로그인').fill(email);
    await box.getByRole('button', {name: '코드 받기', exact: true}).click();
    const field = box.getByLabel(`${email}로 보낸 코드`);
    await field.waitFor({timeout: timeoutMs});
    await field.fill(code);
    await box.getByRole('button', {name: '로그인', exact: true}).click();
    await this.page.waitForFunction(() => !document.querySelector('[data-testid=portal-email-login]'), null, {timeout: timeoutMs});
  }

  /** 휴대폰에 보이는 6자리 SAS. */
  async waitForSas(timeoutMs = 60_000): Promise<string> {
    const sas = this.page.locator('[data-testid="internet-remote-approval"] .remote-sas');
    await sas.waitFor({timeout: timeoutMs});
    return (await sas.textContent())?.trim() ?? '';
  }

  async pillText(): Promise<string> {
    const pill = this.page.getByTestId('remote-connection-state');
    return await pill.count() ? ((await pill.first().textContent())?.trim() ?? '') : '';
  }

  async waitForPill(text: string, timeoutMs = 60_000): Promise<void> {
    await this.page.waitForFunction(expected => document.querySelector('[data-testid="remote-connection-state"]')?.textContent?.trim() === expected, text, {timeout: timeoutMs});
  }

  /**
   * 아래 작업 메뉴의 탭을 누른다(사람이 하는 탭). QR을 그대로 열면(카메라·앱의 pageURL — `?tab=` 없음) 홈에서 시작하고, 연결 상태
   * 표시(remote-connection-state)는 「원격 작업」 탭에만 있다.
   */
  async openWorkspaceTab(tab: 'home' | 'projects' | 'workroom' | 'bookmarks' | 'records', timeoutMs = 30_000): Promise<void> {
    const button = this.page.locator(`nav.workspace-navigation [data-workspace-tab="${tab}"]`).first();
    await button.waitFor({timeout: timeoutMs});
    if ((await button.getAttribute('aria-current')) !== 'page') await button.click({timeout: 10_000});
    await this.page.waitForFunction(value => document.querySelector(`nav.workspace-navigation [data-workspace-tab="${value}"]`)?.getAttribute('aria-current') === 'page', tab, {timeout: timeoutMs});
  }

  /** 지금 고른 작업 메뉴 탭(aria-current="page"). 없으면 null. */
  async currentWorkspaceTab(): Promise<string | null> {
    return this.page.evaluate(() => document.querySelector('nav.workspace-navigation [aria-current="page"]')?.getAttribute('data-workspace-tab') ?? null);
  }

  /** 이메일 코드 로그인 칸이 화면에 보이는가(숨은 탭 안이면 false). */
  async loginVisible(): Promise<boolean> {
    const box = this.page.getByTestId('portal-email-login');
    return await box.count() ? box.first().isVisible() : false;
  }

  /** 휴대폰의 「더 보기」(닫혀 있을 때만 연다). */
  async openMore(): Promise<void> {
    const toggle = this.page.getByTestId('remote-workroom-more-toggle');
    if (await toggle.count() && await toggle.first().isVisible() && (await toggle.first().getAttribute('aria-expanded')) === 'false') await toggle.first().click();
  }

  async openProjects(): Promise<void> {
    await this.openMore();
    await this.page.getByRole('button', {name: '프로젝트 관리', exact: true}).click();
  }

  projectCard(name: string): Locator {
    return this.page.locator('[data-testid="remote-project-card"]').filter({has: this.page.getByRole('heading', {name, exact: true})});
  }

  /**
   * 그 카드의 실행/중지 버튼이 **눌 수 있게** 될 때까지. 카드는 실행·중지·재시작 버튼을 늘 그리고, 호스트가 그 동작을
   * 주지 않으면 disabled로 둔다(RemoteControlProjectCard.tsx) — 그래서 「있다」가 아니라 「켜졌다」를 기다린다.
   * 이것이 곧 「휴대폰 카드가 실행 중/중지됨 상태로 바뀌었다」의 관측이다.
   */
  async waitForProjectAction(name: string, action: 'start' | 'stop', timeoutMs = 60_000): Promise<void> {
    await this.projectCard(name).locator(`[data-action="${action}"]:not([disabled])`).first().waitFor({timeout: timeoutMs});
  }

  async projectStatus(name: string): Promise<string> {
    const status = this.projectCard(name).locator('.remote-project-status');
    return await status.count() ? ((await status.first().textContent())?.trim() ?? '') : '';
  }

  /** 휴대폰의 「새로고침」(`remote-refresh`)을 누른다 — 사람이 하는 것과 같은 탭이다. 눌렀으면 true. */
  async tapRefresh(timeoutMs = 30_000): Promise<boolean> {
    const button = this.page.locator('[data-testid="remote-refresh"]:not([disabled])').first();
    try {
      await button.waitFor({timeout: timeoutMs});
      await button.click({timeout: 10_000});
      return true;
    } catch { return false; }
  }

  async clickProjectAction(name: string, action: 'start' | 'stop', timeoutMs = 60_000): Promise<void> {
    await this.waitForProjectAction(name, action, timeoutMs);
    await this.projectCard(name).locator(`[data-action="${action}"]:not([disabled])`).first().click({timeout: 15_000});
  }

  /** 휴대폰 상단 경고(`.remote-alert`)의 문구와 코드. 없으면 null — 실패 사유에 그대로 싣는다(비밀값은 들어 있지 않다). */
  async alert(): Promise<{message: string; code: string} | null> {
    const box = this.page.locator('.remote-alert');
    if (!await box.count()) return null;
    const message = ((await box.first().locator('p').first().textContent().catch(() => '')) ?? '').trim();
    const code = ((await box.first().locator('.remote-alert-detail code').first().textContent({timeout: 1_000}).catch(() => '')) ?? '').trim();
    return message || code ? {message: message.slice(0, 160), code: code.slice(0, 80)} : null;
  }

  async openWorkroom(): Promise<void> {
    await this.openMore();
    await this.page.getByRole('button', {name: '워크룸 이어가기', exact: true}).click();
  }

  /** 새 작업 시트에서 프로젝트(이름이 들어간 첫 항목)와 AI를 골라 시작한다. 고른 targetId를 돌려준다. */
  async startWorkroomTask(projectName: string, agent: string, timeoutMs = 60_000, requireBypassDisabled = false): Promise<string> {
    const open = this.page.getByTestId('workroom-new-task');
    await open.waitFor({timeout: timeoutMs});
    await open.click();
    const sheet = this.page.getByTestId('workroom-new-task-sheet');
    await sheet.waitFor({timeout: timeoutMs});
    if (requireBypassDisabled) {
      const options = sheet.getByTestId('workroom-launch-options');
      if ((await options.getAttribute('data-bypass')) !== 'off') throw new Error(`${this.label}: community bypass is on`);
      await options.click();
      if (!await sheet.getByRole('checkbox', {name:'승인 없이 실행 (권한 우회)'}).isDisabled()
          || !await sheet.getByTestId('workroom-bypass-unavailable').isVisible())
        throw new Error(`${this.label}: community bypass is not disabled with an explanation`);
    }
    const project = sheet.getByLabel('터미널 프로젝트');
    await this.page.waitForFunction(name => [...document.querySelectorAll<HTMLOptionElement>('[data-testid="workroom-new-task-sheet"] select[aria-label="터미널 프로젝트"] option')]
      .some(option => option.value && option.textContent?.includes(name)), projectName, {timeout: timeoutMs});
    const value = await project.evaluate((select, name) => [...(select as HTMLSelectElement).options].find(option => option.value && option.textContent?.includes(name))?.value ?? '', projectName);
    if (!value) throw new Error(`${this.label}: the workroom project list has no ${projectName}`);
    await project.selectOption(value);
    await sheet.getByTestId('workroom-launch-choice').selectOption(agent);
    const start = sheet.getByTestId('workroom-new-task-start');
    await this.page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="workroom-new-task-start"]');
      return !!button && !button.disabled;
    }, null, {timeout: timeoutMs});
    await start.click();
    await this.page.getByTestId('workroom-session-view').waitFor({timeout: timeoutMs});
    return value;
  }

  async workroomText(): Promise<string> {
    const view = this.page.getByTestId('workroom-session-view');
    return await view.count() ? await view.first().innerText() : '';
  }

  async waitForWorkroomText(needle: string, timeoutMs = 60_000): Promise<void> {
    await this.page.waitForFunction(text => (document.querySelector('[data-testid="workroom-session-view"]') as HTMLElement | null)?.innerText.includes(text) ?? false, needle, {timeout: timeoutMs});
  }

  async sendWorkroomInput(text: string): Promise<void> {
    const composer = this.page.getByLabel('워크룸 입력');
    await composer.waitFor({timeout: 30_000});
    await composer.fill(text);
    await composer.press('Enter');
  }

  async workroomErrors(): Promise<string[]> {
    return (await this.page.locator('.ai-terminal-error').allTextContents()).map(text => text.trim()).filter(Boolean);
  }

  async foreignGuardTitle(timeoutMs = 20_000): Promise<string> {
    await this.page.getByTestId('remote-foreign-pairing').waitFor({timeout: timeoutMs});
    return (await this.page.getByTestId('remote-foreign-pairing-title').textContent())?.trim() ?? '';
  }

  /** 주소창에 프래그먼트(#pair=)가 남았는가 — 값은 돌려주지 않는다. */
  hasFragmentInAddressBar(): boolean {
    try { return new URL(this.page.url()).hash.length > 0; } catch { return false; }
  }

  async screenshot(path: string): Promise<void> {
    try { await this.page.screenshot({path, fullPage: false, timeout: 15_000}); } catch { /* evidence is best-effort */ }
  }

  async close(): Promise<void> {
    try { await this.context.close(); } catch {}
  }
}
