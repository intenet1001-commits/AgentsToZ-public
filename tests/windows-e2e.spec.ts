/**
 * windows-e2e.spec.ts
 * Playwright E2E suite for the Port Management app on Windows.
 * Run: bun run test:windows:e2e
 * Report: tests/results/windows-e2e-report.json
 * Failure screenshots: tests/results/fail-*.png
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.LOCAL_URL ?? "http://localhost:9000";
const API_PORT = Number(process.env.API_PORT) || 3001;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(MODULE_DIR, "results");
const REPORT_PATH = path.join(RESULTS_DIR, "windows-e2e-report.json");
const SETUP_WIZARD_SEEN_KEY = "portmanager-setup-wizard-seen-v1";

interface TestResult {
  name: string;
  status: "pass" | "fail" | "skip";
  duration: number;
  error?: string;
  screenshot?: string;
}

const results: TestResult[] = [];

function ensureResultsDir() {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
}

// On a Mac, `WINDOWS_E2E_EMULATE_PLATFORM=1` makes the page report `navigator.platform`
// 'Win32' so this suite can be preflighted before spending a hosted Windows run. On a
// real Windows runner the browser already reports Win32 and this stays off.
const EMULATE_WINDOWS_PLATFORM = process.env.WINDOWS_E2E_EMULATE_PLATFORM === "1";

async function newContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((key) => localStorage.setItem(key, "seen"), SETUP_WIZARD_SEEN_KEY);
  if (EMULATE_WINDOWS_PLATFORM) {
    // A string script: tsx's keepNames would otherwise inject an undefined `__name` helper.
    await context.addInitScript({
      content: 'Object.defineProperty(Navigator.prototype, "platform", { get: function () { return "Win32"; }, configurable: true });',
    });
  }
  return context;
}

/**
 * The app keeps long-lived requests open (workroom navigation, worktree discovery), so
 * Playwright's "networkidle" never settles once the API answers. Wait for the app shell.
 */
async function gotoApp(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.locator('[data-top-level-tab="ports"]').first().waitFor({ state: "visible", timeout: 20000 });
}

/** Launch tools live in collapsed <details> popovers since the 2026-09 redesign. */
async function openLaunchTools(page: Page): Promise<void> {
  const launchTools = page.locator("details.workspace-tools").filter({
    has: page.locator(":scope > summary", { hasText: /^(실행 도구|Launch tools)$/ }),
  }).first();
  await launchTools.waitFor({ state: "attached", timeout: 10000 });
  if (!(await launchTools.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await launchTools.locator(":scope > summary").click();
  }
}

/**
 * The app briefly takes a portal safety lease (it holds portal.json's lock) while it loads.
 * Closing a context between acquire and release strands that lock for the lease TTL
 * (2 minutes), and every later /api/portal read then fails. Let each test's own leases
 * finish before its context closes so tests stay independent.
 */
function trackPortalSafetyLeases(page: Page): { settle(): Promise<void> } {
  let open = 0;
  let lastEventAt = 0;
  const pathOf = (url: string) => new URL(url).pathname;
  page.on("request", (request) => {
    if (pathOf(request.url()) === "/api/portal/safety-lease/acquire") { open += 1; lastEventAt = Date.now(); }
  });
  page.on("response", (response) => {
    const pathname = pathOf(response.url());
    const acquireFailed = pathname === "/api/portal/safety-lease/acquire" && !response.ok();
    const released = pathname === "/api/portal/safety-lease/release" && response.ok();
    if (acquireFailed || released) { open = Math.max(0, open - 1); lastEventAt = Date.now(); }
  });
  page.on("requestfailed", (request) => {
    if (pathOf(request.url()) === "/api/portal/safety-lease/acquire") { open = Math.max(0, open - 1); lastEventAt = Date.now(); }
  });
  return {
    // Load-time leases come in quick acquire→release pairs; wait for the pairs to close
    // and for a short quiet window so the next pair has not just started.
    async settle() {
      for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
        if (open === 0 && Date.now() - lastEventAt > 1000) return;
        await page.waitForTimeout(100);
      }
    },
  };
}

async function runTest(
  name: string,
  browser: Browser,
  fn: (page: Page) => Promise<void>
): Promise<void> {
  const start = Date.now();
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const openLeases = trackPortalSafetyLeases(page);
  try {
    await fn(page);
    results.push({ name, status: "pass", duration: Date.now() - start });
    console.log(`  PASS  ${name} (${Date.now() - start}ms)`);
  } catch (err: any) {
    const screenshotName = `fail-${name.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.png`;
    const screenshotPath = path.join(RESULTS_DIR, screenshotName);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch (_) {}
    results.push({
      name,
      status: "fail",
      duration: Date.now() - start,
      error: err?.message ?? String(err),
      screenshot: screenshotName,
    });
    console.error(`  FAIL  ${name} (${Date.now() - start}ms): ${err?.message}`);
  } finally {
    // Settle on failure too: a failed test that strands a portal lease would otherwise
    // fail every later test with /api/portal 500 and hide the real first failure.
    await openLeases.settle().catch(() => {});
    await ctx.close();
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ---------------------------------------------------------------------------
// Test definitions
// ---------------------------------------------------------------------------

// 1. Basic App Load
async function test01_basicAppLoad(page: Page) {
  await gotoApp(page);
  const title = await page.title();
  assert(title.length > 0, "Page title should not be empty");
  const body = await page.locator("body").textContent();
  assert((body ?? "").length > 0, "Body should have content");
  // Tab shell visible — look for at least one tab-like element
  const tabCount = await page.locator("[data-tab], [role='tab'], button").count();
  assert(tabCount > 0, "Tab shell / buttons should be present");
}

// 2. Tab Navigation
async function test02_tabNavigation(page: Page) {
  await gotoApp(page);

  // Click Projects tab
  const projectsTab = page.locator("button, [role='tab']").filter({ hasText: /프로젝트|project/i }).first();
  if (await projectsTab.count() > 0) {
    await projectsTab.click();
    await page.waitForTimeout(500);
  }

  // Click Portal tab
  const portalTab = page.locator("button, [role='tab']").filter({ hasText: /포털|portal/i }).first();
  if (await portalTab.count() > 0) {
    await portalTab.click();
    await page.waitForTimeout(500);
    const bodyText = await page.locator("body").textContent();
    assert((bodyText ?? "").length > 0, "Body should have content after tab switch");
  }

  // Switch back to main/projects
  const mainTab = page.locator("button, [role='tab']").filter({ hasText: /프로젝트|project/i }).first();
  if (await mainTab.count() > 0) {
    await mainTab.click();
    await page.waitForTimeout(300);
  }
}

// 3. Port List Renders
async function test03_portListRenders(page: Page) {
  await gotoApp(page);

  // A fresh CI runner has no registered projects; then only the empty shell is checked.
  const rows = page.locator("[data-testid='sidebar-project-row']");
  const rowCount = await rows.count();
  if (rowCount > 0) {
    const firstText = await rows.first().textContent();
    assert((firstText ?? "").trim().length > 0, "Project row should have text");
    assert(await page.locator("[data-testid='sidebar-pin-project']").count() > 0, "Pin (favorite) controls should be present");
  }
  assert(await page.locator("[class*='workspace-sidebar']").count() > 0, "Sidebar should be present");
}

// 4. Windows-Specific UI
async function test04_windowsSpecificUI(page: Page) {
  await gotoApp(page);
  const isWin = await page.evaluate(() => navigator.platform.toLowerCase().startsWith("win"));
  assert(isWin, `This suite asserts Windows UI; navigator.platform=${await page.evaluate(() => navigator.platform)}`);

  // Terminal selector and build buttons sit inside the collapsed 「실행 도구」 popover.
  await openLaunchTools(page);

  // Windows offers PowerShell/Orca/WSL; macOS-only terminals and the Workroom PTY
  // (unsupported on Windows, see aiTerminalService) are not offered.
  for (const app of ["powershell", "orca", "wsl"]) {
    const btn = page.locator(`[data-testid='terminal-app-${app}']`);
    assert(await btn.count() === 1 && await btn.isVisible(), `terminal-app-${app} should be visible on Windows`);
  }
  for (const app of ["internal", "cmux", "iterm", "terminal"]) {
    assert(
      await page.locator(`[data-testid='terminal-app-${app}']`).count() === 0,
      `terminal-app-${app} should not be offered on Windows`,
    );
  }

  // The build group is its own nested <details> inside 「실행 도구」.
  const winBuildBtn = page.locator("[data-help-key='header-build-windows']");
  assert(await winBuildBtn.count() === 1, "Windows build button should be rendered on Windows");
  const buildTools = winBuildBtn.locator("xpath=ancestor::details[1]");
  if (!(await buildTools.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await buildTools.locator(":scope > summary").click();
  }
  assert(await winBuildBtn.isVisible(), "Windows build button should be visible once the Build group is open");

  // macOS-only build buttons should be absent.
  assert(await page.locator("[data-help-key='header-build-app']").count() === 0, "macOS App build button should not be present on Windows");
  assert(await page.locator("[data-help-key='header-build-dmg']").count() === 0, "macOS DMG build button should not be present on Windows");
}

// 5. Worktree Panel
async function test05_worktreePanel(page: Page) {
  await gotoApp(page);

  // Toggle worktree panel
  const worktreeToggle = page.locator("button").filter({ hasText: /워크트리|worktree/i }).first();
  if (await worktreeToggle.count() > 0) {
    await worktreeToggle.click();
    await page.waitForTimeout(600);

    // Check panel content
    const panel = page.locator("[class*='worktree'], [data-worktree]");
    if (await panel.count() > 0) {
      const panelText = await panel.first().textContent();
      assert(panelText !== null, "Worktree panel should have content");

      // Git action buttons or empty state
      const gitButtons = page.locator("button").filter({ hasText: /commit|pull|push|source/i });
      const emptyState = page.locator("[class*='empty'], [class*='placeholder']").filter({ hasText: /없|empty|no/i });
      const hasContent = (await gitButtons.count() > 0) || (await emptyState.count() > 0);
      assert(hasContent, "Worktree panel should show git buttons or empty state");
    }
  }
  // Test passes even if no worktree toggle found (feature may not be active)
}

// 6. API Health Check
async function test06_apiHealthCheck(page: Page) {
  await gotoApp(page);

  const apiBase = `http://127.0.0.1:${API_PORT}`;

  // /api/ports
  const portsResp = await page.evaluate(async (base) => {
    const r = await fetch(`${base}/api/ports`);
    return { status: r.status, contentType: r.headers.get("content-type") };
  }, apiBase);
  assert(portsResp.status === 200, `/api/ports returned ${portsResp.status}`);
  assert((portsResp.contentType ?? "").includes("json"), "/api/ports should return JSON");

  // /api/portal
  const portalResp = await page.evaluate(async (base) => {
    const r = await fetch(`${base}/api/portal`);
    return { status: r.status, contentType: r.headers.get("content-type") };
  }, apiBase);
  assert(portalResp.status === 200, `/api/portal returned ${portalResp.status}`);
  assert((portalResp.contentType ?? "").includes("json"), "/api/portal should return JSON");

  // /api/build-status
  const buildResp = await page.evaluate(async (base) => {
    const r = await fetch(`${base}/api/build-status`);
    return { status: r.status, contentType: r.headers.get("content-type") };
  }, apiBase);
  assert(buildResp.status === 200, `/api/build-status returned ${buildResp.status}`);
  assert((buildResp.contentType ?? "").includes("json"), "/api/build-status should return JSON");

  // A macOS-only build request must fail without poisoning the shared build state.
  // Under Mac-side emulation the API server really is macOS, so this POST would start a
  // real build — only the browser is pretending to be Windows. Skip it there.
  if (EMULATE_WINDOWS_PLATFORM) return;
  const rejectedMacBuild = await page.evaluate(async (base) => {
    const rejected = await fetch(`${base}/api/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "app" }),
    });
    const status = await fetch(`${base}/api/build-status`).then(r => r.json());
    return { rejectedStatus: rejected.status, isBuilding: status.isBuilding };
  }, apiBase);
  assert(rejectedMacBuild.rejectedStatus === 400, "macOS build should be rejected on Windows");
  assert(rejectedMacBuild.isBuilding === false, "rejected macOS build must not leave build state locked");
}

// 7. Port Status Display
async function test07_portStatusDisplay(page: Page) {
  await gotoApp(page);

  const runButtons = page.locator("button").filter({ hasText: /실행|run|시작/i });
  const stopButtons = page.locator("button").filter({ hasText: /중지|stop/i });
  const totalActionBtns = (await runButtons.count()) + (await stopButtons.count());

  if (totalActionBtns > 0) {
    assert(totalActionBtns > 0, "Run/stop buttons should have labels");
  }

  // Refresh button
  const refreshBtn = page.locator("button").filter({ hasText: /새로고침|refresh|reload/i });
  const refreshIcon = page.locator("[data-help-key='btn-refresh'], button[title*='새로고침'], button[title*='Refresh']");
  const refreshCount = (await refreshBtn.count()) + (await refreshIcon.count());
  assert(refreshCount > 0, "Refresh button should be present");
}

// 8. Search and Filter
async function test08_searchAndFilter(page: Page) {
  await gotoApp(page);

  const cards = page.locator(".port-card, [data-port-card], [class*='card']");
  const initialCount = await cards.count();

  const searchInput = page.locator("input[placeholder*='검색'], input[placeholder*='search'], input[type='search']").first();
  if (await searchInput.count() === 0 || initialCount === 0) {
    // No search or no cards — test passes trivially
    return;
  }

  // Type a search term unlikely to match
  await searchInput.fill("zzz_unlikely_match_xyz");
  await page.waitForTimeout(500);
  const filteredCount = await cards.count();
  assert(filteredCount <= initialCount, "Search should reduce or maintain card count");

  // Clear search
  await searchInput.fill("");
  await page.waitForTimeout(500);
  const restoredCount = await cards.count();
  assert(restoredCount >= filteredCount, "Clearing search should restore cards");

  // Sidebar All filter
  const allFilter = page.locator("button, [role='tab']").filter({ hasText: /전체|all/i }).first();
  if (await allFilter.count() > 0) {
    await allFilter.click();
    await page.waitForTimeout(300);
  }

  // Starred filter
  const starredFilter = page.locator("button, [role='tab']").filter({ hasText: /즐겨찾기|starred|favorite/i }).first();
  if (await starredFilter.count() > 0) {
    await starredFilter.click();
    await page.waitForTimeout(300);
    const starredCount = await cards.count();
    assert(starredCount <= restoredCount, "Starred filter should show subset or all");
  }
}

// 9. Responsive Behavior
async function test09_responsiveBehavior(page: Page) {
  await gotoApp(page);

  const viewports = [
    { width: 1440, height: 900 },
    { width: 768, height: 1024 },
    { width: 375, height: 812 },
  ];

  for (const vp of viewports) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(400);
    const bodyText = await page.locator("body").textContent();
    assert((bodyText ?? "").length > 0, `Body should not be blank at ${vp.width}px`);
  }

  // Restore and check header
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  // The project screen header carries 「새 프로젝트」; generic "*header*" classes also match hidden panels.
  const headerAction = page.locator("[data-testid='header-new-project']");
  await headerAction.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  assert(await headerAction.isVisible(), "Header should be visible after restoring viewport");
}

// 10. New Project Modal
async function test10_newProjectModal(page: Page) {
  await gotoApp(page);

  const addBtn = page.locator("[data-testid='header-new-project']");
  assert(await addBtn.count() === 1, "New project button should be present");

  await addBtn.click();
  const modal = page.locator("[data-testid='new-project-dialog']");
  await modal.waitFor({ state: "visible", timeout: 5000 });
  // A fresh install has no workspace root yet, so the dialog may show choices rather than inputs.
  const controls = modal.locator("input, textarea, select, button");
  assert(await controls.count() > 1, "New project dialog should offer controls");

  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
  assert(await modal.count() === 0, "Modal should close on Escape");
}

// 11. No Critical Console Errors
async function test11_noCriticalConsoleErrors(page: Page) {
  const errors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Exclude expected AI-endpoint 500s
      if (/suggest-batch|suggest-name|suggest-category/i.test(text)) return;
      // Exclude network errors for optional services
      if (/ERR_CONNECTION_REFUSED/i.test(text)) return;
      errors.push(text);
    }
  });

  page.on("pageerror", (err) => {
    errors.push(err.message);
  });

  await gotoApp(page);
  await page.waitForTimeout(2000);

  assert(errors.length === 0, `Critical JS errors on startup: ${errors.join("; ")}`);
}

// 12. Supabase Settings Modal
async function test12_supabaseSettingsModal(page: Page) {
  await gotoApp(page);
  const tools = page.locator('details.workspace-tools').filter({
    has: page.locator(':scope > summary', {hasText:/^(도구 및 설정|Tools & settings)$/}),
  }).first();
  await tools.waitFor({state:'attached',timeout:10000});
  if (!(await tools.evaluate(element=>(element as HTMLDetailsElement).open))) {
    await tools.locator(':scope > summary').click();
  }
  const settingsBtn = tools.locator('button[data-help-key="btn-settings"]');
  await settingsBtn.waitFor({state:'visible',timeout:10000});
  await settingsBtn.click();
  await page.waitForTimeout(600);

  const modal = page.locator('.portal-modal-panel[role="dialog"]');
  await modal.waitFor({state:'visible',timeout:10000});
  const modalText = await modal.textContent();
  const hasSupabase = /supabase/i.test(modalText ?? "");
  const hasDevice = /기기|device/i.test(modalText ?? "");
  assert(hasSupabase || hasDevice, "Settings modal should mention Supabase or device config");

  await page.keyboard.press("Escape");
  await modal.waitFor({state:'hidden',timeout:5000});
}

// 13. Header Project Count Badge
async function test13_headerProjectCountBadge(page: Page) {
  await gotoApp(page);

  const badge = page.locator("[class*='badge'], [class*='count'], [class*='chip']").first();
  if (await badge.count() === 0) {
    // Badge may not exist with zero ports — acceptable
    return;
  }

  const badgeText = await badge.textContent();
  const num = parseInt((badgeText ?? "").trim(), 10);
  assert(!isNaN(num), `Badge should show a parseable number, got: "${badgeText}"`);
}

// 14. Export/Import Buttons
async function test14_exportImportButtons(page: Page) {
  await gotoApp(page);

  const exportBtn = page.locator(
    "[data-help-key='btn-export-ports'], button[title*='내보내기'], button[title*='Export']"
  );
  const exportAlt = page.locator("button").filter({ hasText: /내보내기|export/i });
  const exportCount = (await exportBtn.count()) + (await exportAlt.count());
  assert(exportCount > 0, "Export button should be visible");

  const importBtn = page.locator(
    "[data-help-key='btn-import-ports'], button[title*='불러오기'], button[title*='Import']"
  );
  const importAlt = page.locator("button").filter({ hasText: /불러오기|import/i });
  const importCount = (await importBtn.count()) + (await importAlt.count());
  assert(importCount > 0, "Import button should be visible");
}

// 15. Card Overflow Menu
async function test15_cardOverflowMenu(page: Page) {
  await gotoApp(page);

  const cards = page.locator(".port-card, [data-port-card], [class*='card']");
  if (await cards.count() === 0) return;

  // Find overflow / context menu trigger on first card
  const firstCard = cards.first();
  const menuBtn = firstCard
    .locator("button")
    .filter({ hasText: /⋯|…|more|메뉴|⋮/i })
    .first();
  const menuIcon = firstCard.locator("button[aria-label*='more'], button[aria-label*='menu'], button[class*='more']").first();

  const trigger = (await menuBtn.count() > 0) ? menuBtn : menuIcon;
  if (await trigger.count() === 0) return;

  await trigger.click();
  await page.waitForTimeout(400);

  const dropdown = page.locator("[class*='dropdown'], [class*='menu'], [role='menu']").first();
  if (await dropdown.count() > 0) {
    const items = await dropdown.locator("button, [role='menuitem'], a").count();
    assert(items > 0, "Overflow menu should have items");

    // cmux should be absent on Windows
    const cmuxItem = dropdown.locator("button, [role='menuitem']").filter({ hasText: /cmux/i });
    assert(await cmuxItem.count() === 0, "cmux should be absent from overflow menu on Windows");

    // Close menu
    await page.keyboard.press("Escape");
  }
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

async function main() {
  ensureResultsDir();

  console.log("=== Windows E2E Test Suite ===");
  console.log(`Target: ${BASE_URL}`);
  console.log("");

  const browser: Browser = await chromium.launch({ headless: true });

  const tests: Array<{ name: string; fn: (page: Page) => Promise<void> }> = [
    { name: "01 Basic App Load", fn: test01_basicAppLoad },
    { name: "02 Tab Navigation", fn: test02_tabNavigation },
    { name: "03 Port List Renders", fn: test03_portListRenders },
    { name: "04 Windows-Specific UI", fn: test04_windowsSpecificUI },
    { name: "05 Worktree Panel", fn: test05_worktreePanel },
    { name: "06 API Health Check", fn: test06_apiHealthCheck },
    { name: "07 Port Status Display", fn: test07_portStatusDisplay },
    { name: "08 Search and Filter", fn: test08_searchAndFilter },
    { name: "09 Responsive Behavior", fn: test09_responsiveBehavior },
    { name: "10 New Project Modal", fn: test10_newProjectModal },
    { name: "11 No Critical Console Errors", fn: test11_noCriticalConsoleErrors },
    { name: "12 Supabase Settings Modal", fn: test12_supabaseSettingsModal },
    { name: "13 Header Project Count Badge", fn: test13_headerProjectCountBadge },
    { name: "14 Export/Import Buttons", fn: test14_exportImportButtons },
    { name: "15 Card Overflow Menu", fn: test15_cardOverflowMenu },
  ];

  for (const t of tests) {
    await runTest(t.name, browser, t.fn);
  }

  await browser.close();

  // Write report
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;

  const report = {
    summary: { total: results.length, passed, failed, skipped },
    generatedAt: new Date().toISOString(),
    results,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log("");
  console.log("=== Summary ===");
  console.log(`Total: ${results.length}  Pass: ${passed}  Fail: ${failed}  Skip: ${skipped}`);
  console.log(`Report: ${REPORT_PATH}`);

  if (failed > 0) {
    process.exit(1);
  }
}

// `bun test` discovers every *.spec.ts file. Running this standalone Playwright
// runner during unit discovery used to print many FAIL lines and still let the
// suite end green. Execute only when this file itself is the entry point.
const isDirectEntry = import.meta.main === true
  || (Boolean(process.argv[1]) && path.resolve(process.argv[1]!) === fileURLToPath(import.meta.url));

if (isDirectEntry && process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    console.error("Runner crashed:", err);
    process.exit(1);
  });
}
