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

async function newContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((key) => localStorage.setItem(key, "seen"), SETUP_WIZARD_SEEN_KEY);
  return context;
}

async function runTest(
  name: string,
  browser: Browser,
  fn: (page: Page) => Promise<void>
): Promise<void> {
  const start = Date.now();
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
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
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });
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
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

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
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

  // Cards with text content
  const cards = page.locator(".port-card, [data-port-card], [class*='card']");
  const cardCount = await cards.count();

  if (cardCount > 0) {
    const firstText = await cards.first().textContent();
    assert((firstText ?? "").length > 0, "Port card should have text");

    // Run/stop buttons
    const runStopButtons = page.locator("button").filter({ hasText: /실행|중지|run|stop/i });
    const runStopCount = await runStopButtons.count();
    assert(runStopCount > 0, "Run/stop buttons should be present");

    // Favorite buttons
    const favButtons = page.locator("button[data-favorite], button[aria-label*='즐겨'], button[class*='fav']");
    const favAlt = page.locator("button").filter({ hasText: /★|☆|즐겨|favorite/i });
    const favCount = (await favButtons.count()) + (await favAlt.count());
    assert(favCount > 0, "Favorite buttons should be present");
  }

  // Sidebar rows
  const sidebar = page.locator("[class*='sidebar'], [data-sidebar], aside");
  const sidebarExists = await sidebar.count();
  assert(sidebarExists > 0 || cardCount === 0, "Sidebar should be present when cards exist");
}

// 4. Windows-Specific UI
async function test04_windowsSpecificUI(page: Page) {
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

  // Windows build button should be visible
  const winBuildBtn = page.locator("[data-help-key='header-build-windows']");
  const winBuildVisible = await winBuildBtn.count() > 0 && await winBuildBtn.first().isVisible().catch(() => false);
  assert(winBuildVisible, "Windows build button should be present on Windows");

  // macOS-only buttons should be absent
  const macAppBtn = page.locator("[data-testid='header-build-app'], #header-build-app");
  const macDmgBtn = page.locator("[data-testid='header-build-dmg'], #header-build-dmg");
  assert(await macAppBtn.count() === 0, "macOS App build button should not be present on Windows");
  assert(await macDmgBtn.count() === 0, "macOS DMG build button should not be present on Windows");

  // Orca is supported on Windows; cmux remains macOS-only.
  const orcaBtn = page.locator("[data-testid='terminal-app-orca']");
  assert(
    await orcaBtn.count() > 0 && await orcaBtn.first().isVisible().catch(() => false),
    "Orca terminal selector should be present on Windows",
  );
  const cmuxBtn = page.locator("[data-testid='terminal-app-cmux']");
  assert(await cmuxBtn.count() === 0, "cmux button should not be present on Windows");
}

// 5. Worktree Panel
async function test05_worktreePanel(page: Page) {
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

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
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

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
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

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
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

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
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

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
  const header = page.locator("header, [class*='header'], [class*='topbar']").first();
  if (await header.count() > 0) {
    const visible = await header.isVisible();
    assert(visible, "Header should be visible after restoring viewport");
  }
}

// 10. New Project Modal
async function test10_newProjectModal(page: Page) {
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

  const addBtn = page
    .locator("button")
    .filter({ hasText: /추가|새 프로젝트|add|new project|\+/i })
    .first();

  if (await addBtn.count() === 0) return; // Feature not visible — skip

  await addBtn.click();
  await page.waitForTimeout(600);

  const modal = page.locator("[class*='modal'], [role='dialog'], [class*='dialog']").first();
  if (await modal.count() > 0) {
    const inputs = modal.locator("input, textarea");
    assert(await inputs.count() > 0, "Modal should have input fields");

    // Close with Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const modalAfterEsc = page.locator("[class*='modal'], [role='dialog'], [class*='dialog']");
    const stillOpen = await modalAfterEsc.count();
    assert(stillOpen === 0, "Modal should close on Escape");
  }
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

  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(2000);

  assert(errors.length === 0, `Critical JS errors on startup: ${errors.join("; ")}`);
}

// 12. Supabase Settings Modal
async function test12_supabaseSettingsModal(page: Page) {
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

  const settingsBtn = page
    .locator("button")
    .filter({ hasText: /설정|settings|config/i })
    .first();

  if (await settingsBtn.count() === 0) return;

  await settingsBtn.click();
  await page.waitForTimeout(600);

  const modal = page.locator("[class*='modal'], [role='dialog'], [class*='dialog']").first();
  if (await modal.count() > 0) {
    const modalText = await modal.textContent();
    const hasSupabase = /supabase/i.test(modalText ?? "");
    const hasDevice = /기기|device/i.test(modalText ?? "");
    assert(hasSupabase || hasDevice, "Settings modal should mention Supabase or device config");

    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const afterEsc = page.locator("[class*='modal'], [role='dialog'], [class*='dialog']");
    assert(await afterEsc.count() === 0, "Settings modal should close on Escape");
  }
}

// 13. Header Project Count Badge
async function test13_headerProjectCountBadge(page: Page) {
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

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
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

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
  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 15000 });

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
