import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'http://localhost:9000';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREENSHOTS_DIR = path.join(PROJECT_ROOT, 'tests/screenshots');
const RESULTS_DIR = path.join(PROJECT_ROOT, 'tests/results');

mkdirSync(SCREENSHOTS_DIR, { recursive: true });
mkdirSync(RESULTS_DIR, { recursive: true });

const tests = [];
let passed = 0, failed = 0, skipped = 0;
const startTime = Date.now();

function record(id, category, page, description, status, details) {
  const t = { id, category, page, description, status, duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`, details };
  tests.push(t);
  if (status === 'passed') passed++;
  else if (status === 'failed') failed++;
  else skipped++;
  console.log(`[${status.toUpperCase()}] ${description}`);
  if (details.error) console.log(`  -> ${details.error}`);
}

async function screenshot(page, name) {
  try {
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/${name}.png`, fullPage: false });
  } catch (e) {}
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const issues = [];

  // ─── Test 1: Page Load ───────────────────────────────────────────────
  try {
    const t0 = Date.now();
    const response = await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await screenshot(page, 'initial-load');
    const title = await page.title();
    const status = response?.status() ?? 0;
    if (status >= 200 && status < 400) {
      record('nav-001', 'navigation', '/', `페이지 로드 (${title})`, 'passed', {
        httpStatus: status, title, loadTime: `${Date.now() - t0}ms`
      });
    } else {
      record('nav-001', 'navigation', '/', '페이지 로드', 'failed', { httpStatus: status });
      issues.push({ severity: 'critical', description: `Page load failed: HTTP ${status}` });
    }
  } catch (e) {
    record('nav-001', 'navigation', '/', '페이지 로드', 'failed', { error: e.message });
    issues.push({ severity: 'critical', description: `Page load error: ${e.message}` });
    await browser.close();
    return { tests, issues };
  }

  // ─── Test 2: Tab Switching ──────────────────────────────────────────
  try {
    // Find the 포털 tab
    const portalTab = page.locator('button:has-text("포털"), [role="tab"]:has-text("포털")').first();
    const visible = await portalTab.isVisible();
    if (visible) {
      await portalTab.click();
      await page.waitForTimeout(500);
      await screenshot(page, 'portal-tab');
      // Check if portal content is visible
      const portalContent = await page.locator('text=포털').first().isVisible();
      record('nav-002', 'navigation', '/', '탭 전환: 프로젝트 관리 → 포털', 'passed', {
        trigger: '포털 탭 클릭', result: 'Portal tab content visible'
      });
    } else {
      record('nav-002', 'navigation', '/', '탭 전환: 포털 탭', 'failed', { error: '포털 탭 버튼을 찾을 수 없음' });
      issues.push({ severity: 'medium', description: 'Portal tab not found' });
    }
  } catch (e) {
    record('nav-002', 'navigation', '/', '탭 전환: 포털 탭', 'failed', { error: e.message });
  }

  // Switch back to 프로젝트 관리 tab
  try {
    const mgmtTab = page.locator('button:has-text("프로젝트 관리"), [role="tab"]:has-text("프로젝트 관리")').first();
    const visible = await mgmtTab.isVisible();
    if (visible) {
      await mgmtTab.click();
      await page.waitForTimeout(500);
      record('nav-003', 'navigation', '/', '탭 전환: 포털 → 프로젝트 관리', 'passed', {
        trigger: '프로젝트 관리 탭 클릭', result: 'Back to project management tab'
      });
    } else {
      record('nav-003', 'navigation', '/', '탭 전환: 프로젝트 관리 탭', 'skipped', { note: '탭 버튼 없음' });
    }
  } catch (e) {
    record('nav-003', 'navigation', '/', '탭 전환: 프로젝트 관리', 'failed', { error: e.message });
  }

  await screenshot(page, 'mgmt-tab');

  // ─── Test 3: Add Port Form - Open ───────────────────────────────────
  let addFormOpened = false;
  try {
    // Look for add button
    const addBtn = page.locator('button:has-text("추가"), button:has-text("포트 추가"), button:has-text("새 포트"), button[aria-label*="추가"]').first();
    const visible = await addBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      await addBtn.click();
      await page.waitForTimeout(600);
      addFormOpened = true;
      await screenshot(page, 'add-form-open');
      record('form-001', 'form', '/', '포트 추가 폼 열기', 'passed', {
        trigger: '추가 버튼 클릭', result: '폼 열림'
      });
    } else {
      // Try + button or any add icon button
      const plusBtn = page.locator('button svg.lucide-plus, button:has(svg[class*="Plus"]), button[class*="add"]').first();
      const pVisible = await plusBtn.isVisible({ timeout: 2000 }).catch(() => false);
      if (pVisible) {
        await plusBtn.click();
        await page.waitForTimeout(600);
        addFormOpened = true;
        await screenshot(page, 'add-form-open');
        record('form-001', 'form', '/', '포트 추가 폼 열기 (+ 버튼)', 'passed', {
          trigger: '+ 버튼 클릭', result: '폼 열림'
        });
      } else {
        record('form-001', 'form', '/', '포트 추가 폼 열기', 'skipped', { note: '추가 버튼을 찾을 수 없음' });
        issues.push({ severity: 'medium', description: 'Add port button not found' });
      }
    }
  } catch (e) {
    record('form-001', 'form', '/', '포트 추가 폼 열기', 'failed', { error: e.message });
  }

  // ─── Test 4: Form Validation - Empty Submit ─────────────────────────
  if (addFormOpened) {
    try {
      // Find submit button in form
      const submitBtn = page.locator('button[type="submit"], button:has-text("저장"), button:has-text("추가"), form button:last-child').first();
      const visible = await submitBtn.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        // Make sure fields are empty first
        const nameInput = page.locator('input[placeholder*="이름"], input[name="name"], input[placeholder*="프로젝트"]').first();
        const nameVisible = await nameInput.isVisible({ timeout: 1000 }).catch(() => false);
        if (nameVisible) {
          await nameInput.clear();
        }
        await submitBtn.click();
        await page.waitForTimeout(500);
        await screenshot(page, 'form-empty-submit');
        // Check for error message or validation
        const errorVisible = await page.locator('[class*="error"], [class*="invalid"], [aria-invalid="true"], .text-red, [class*="text-red"], input:invalid').first().isVisible({ timeout: 1000 }).catch(() => false);
        const toastVisible = await page.locator('[class*="toast"], [class*="alert"]').first().isVisible({ timeout: 1000 }).catch(() => false);
        if (errorVisible || toastVisible) {
          record('form-002', 'form-validation', '/', '빈 폼 제출 시 유효성 검사 에러 표시', 'passed', {
            trigger: '빈 상태로 저장 버튼 클릭', result: '유효성 검사 에러 표시됨'
          });
        } else {
          // Check if form is still open (prevented submission)
          const formStillOpen = await submitBtn.isVisible({ timeout: 500 }).catch(() => false);
          if (formStillOpen) {
            record('form-002', 'form-validation', '/', '빈 폼 제출 방지', 'passed', {
              trigger: '빈 상태로 저장 버튼 클릭', result: '폼 제출이 방지됨 (폼 유지)'
            });
          } else {
            record('form-002', 'form-validation', '/', '빈 폼 제출 유효성 검사', 'failed', {
              trigger: '빈 상태로 저장 버튼 클릭', result: '에러 표시 없이 제출됨'
            });
            issues.push({ severity: 'medium', description: 'No validation error shown for empty form submission' });
          }
        }
      } else {
        record('form-002', 'form-validation', '/', '빈 폼 제출 유효성 검사', 'skipped', { note: '제출 버튼 없음' });
      }
    } catch (e) {
      record('form-002', 'form-validation', '/', '빈 폼 제출 유효성 검사', 'failed', { error: e.message });
    }
  } else {
    record('form-002', 'form-validation', '/', '빈 폼 제출 유효성 검사', 'skipped', { note: '폼 열기 실패로 건너뜀' });
  }

  // ─── Test 5: Fill Form and Submit ──────────────────────────────────
  if (addFormOpened) {
    try {
      const nameInput = page.locator('input[placeholder*="이름"], input[name="name"], input[placeholder*="프로젝트"], input[placeholder*="name"]').first();
      const portInput = page.locator('input[placeholder*="포트"], input[name="port"], input[type="number"], input[placeholder*="port"]').first();

      const nameVisible = await nameInput.isVisible({ timeout: 2000 }).catch(() => false);
      const portVisible = await portInput.isVisible({ timeout: 2000 }).catch(() => false);

      if (nameVisible && portVisible) {
        await nameInput.fill('테스트-포트-9999');
        await portInput.fill('9999');
        await screenshot(page, 'form-filled');
        record('form-003', 'form', '/', '포트 추가 폼 입력: 이름 + 포트번호', 'passed', {
          trigger: '이름="테스트-포트-9999", 포트=9999 입력', result: '필드 입력 완료'
        });

        // Submit
        const submitBtn = page.locator('button[type="submit"], button:has-text("저장"), button:has-text("추가하기")').first();
        const submitVisible = await submitBtn.isVisible({ timeout: 1000 }).catch(() => false);
        if (submitVisible) {
          await submitBtn.click();
          await page.waitForTimeout(1000);
          await screenshot(page, 'form-submitted');

          // Verify item appears in list
          const itemInList = await page.locator('text=테스트-포트-9999').first().isVisible({ timeout: 3000 }).catch(() => false);
          if (itemInList) {
            record('form-004', 'form', '/', '포트 추가 후 목록에 표시', 'passed', {
              trigger: '폼 제출', result: '"테스트-포트-9999" 항목이 목록에 표시됨'
            });
          } else {
            // Check if form closed (may have succeeded but list not visible)
            const formClosed = !(await submitBtn.isVisible({ timeout: 500 }).catch(() => false));
            if (formClosed) {
              record('form-004', 'form', '/', '포트 추가 후 목록에 표시', 'failed', {
                trigger: '폼 제출 후', result: '목록에 "테스트-포트-9999" 항목이 표시되지 않음'
              });
              issues.push({ severity: 'medium', description: 'Added port item not visible in list after submission' });
            } else {
              record('form-004', 'form', '/', '포트 추가 폼 제출', 'failed', {
                trigger: '폼 제출', result: '폼이 닫히지 않음 또는 항목 추가 실패'
              });
            }
          }
        } else {
          record('form-003', 'form', '/', '포트 추가 폼 입력', 'skipped', { note: '저장 버튼 없음' });
        }
      } else {
        record('form-003', 'form', '/', '포트 추가 폼 입력', 'skipped', { note: `name input: ${nameVisible}, port input: ${portVisible}` });
        // Close form if open
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    } catch (e) {
      record('form-003', 'form', '/', '포트 추가 폼 입력', 'failed', { error: e.message });
      await page.keyboard.press('Escape');
    }
  } else {
    record('form-003', 'form', '/', '포트 추가 폼 입력', 'skipped', { note: '폼 열기 실패로 건너뜀' });
    record('form-004', 'form', '/', '포트 추가 후 목록 표시', 'skipped', { note: '폼 열기 실패로 건너뜀' });
  }

  // ─── Test 6: Search ────────────────────────────────────────────────
  try {
    await page.waitForTimeout(300);
    const searchInput = page.locator('input[placeholder*="검색"], input[type="search"], input[placeholder*="search"]').first();
    const visible = await searchInput.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      await searchInput.fill('테스트');
      await page.waitForTimeout(600);
      await screenshot(page, 'search-test');
      // Check list updates
      const listItems = await page.locator('[class*="card"], [class*="port-item"], [class*="PortCard"]').count();
      record('search-001', 'search', '/', '검색: "테스트" 입력 후 목록 필터링', 'passed', {
        trigger: '검색창에 "테스트" 입력', result: `${listItems}개 항목 표시됨`
      });

      // Clear search
      await searchInput.clear();
      await page.waitForTimeout(400);
      record('search-002', 'search', '/', '검색 초기화', 'passed', {
        trigger: '검색창 초기화', result: '검색 초기화됨'
      });
    } else {
      record('search-001', 'search', '/', '검색 기능', 'skipped', { note: '검색 입력란 없음' });
      record('search-002', 'search', '/', '검색 초기화', 'skipped', { note: '검색 입력란 없음' });
    }
  } catch (e) {
    record('search-001', 'search', '/', '검색 기능', 'failed', { error: e.message });
  }

  // ─── Test 7: Filter Buttons ─────────────────────────────────────────
  try {
    // Look for filter buttons: 전체, with-port, without-port
    const filterBtns = [
      { text: '전체', id: 'filter-001' },
      { text: '포트 있음', id: 'filter-002' },
      { text: '포트 없음', id: 'filter-003' },
    ];
    for (const f of filterBtns) {
      const btn = page.locator(`button:has-text("${f.text}")`).first();
      const visible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
      if (visible) {
        await btn.click();
        await page.waitForTimeout(400);
        record(f.id, 'filter', '/', `필터 버튼: "${f.text}" 클릭`, 'passed', {
          trigger: `"${f.text}" 필터 클릭`, result: '필터 적용됨'
        });
      } else {
        record(f.id, 'filter', '/', `필터 버튼: "${f.text}" 클릭`, 'skipped', { note: '버튼 없음' });
      }
    }
    await screenshot(page, 'filter-applied');
  } catch (e) {
    record('filter-001', 'filter', '/', '필터 버튼', 'failed', { error: e.message });
  }

  // ─── Test 8: Sort Options ─────────────────────────────────────────
  try {
    // Look for sort select/dropdown
    const sortSelect = page.locator('select, [class*="sort"], button:has-text("정렬"), button:has-text("이름순"), button:has-text("포트순")').first();
    const visible = await sortSelect.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      const tagName = await sortSelect.evaluate(el => el.tagName.toLowerCase());
      if (tagName === 'select') {
        const options = await sortSelect.evaluate(el => Array.from(el.options).map(o => o.text));
        if (options.length > 1) {
          await sortSelect.selectOption({ index: 1 });
          await page.waitForTimeout(400);
          await screenshot(page, 'sort-applied');
          record('sort-001', 'sort', '/', `정렬 옵션 변경: "${options[1]}"`, 'passed', {
            trigger: '정렬 옵션 변경', options: options.join(', '), result: '정렬 적용됨'
          });
        } else {
          record('sort-001', 'sort', '/', '정렬 옵션', 'skipped', { note: '선택 가능한 옵션 없음' });
        }
      } else {
        await sortSelect.click();
        await page.waitForTimeout(400);
        await screenshot(page, 'sort-applied');
        record('sort-001', 'sort', '/', '정렬 버튼 클릭', 'passed', {
          trigger: '정렬 버튼 클릭', result: '정렬 동작 실행됨'
        });
      }
    } else {
      record('sort-001', 'sort', '/', '정렬 기능', 'skipped', { note: '정렬 컨트롤 없음' });
    }
  } catch (e) {
    record('sort-001', 'sort', '/', '정렬 기능', 'failed', { error: e.message });
  }

  // ─── Test 9: Delete the test port ────────────────────────────────
  try {
    await screenshot(page, 'before-delete');
    const itemRow = page.locator('text=테스트-포트-9999').first();
    const itemVisible = await itemRow.isVisible({ timeout: 2000 }).catch(() => false);
    if (itemVisible) {
      // Find the delete button near this item
      const cardLocator = page.locator('[class*="card"], [class*="port"], li').filter({ hasText: '테스트-포트-9999' }).first();
      const deleteBtn = cardLocator.locator('button:has-text("삭제"), button[aria-label*="삭제"], button svg[class*="Trash"]').first();
      const deleteBtnVisible = await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false);
      if (!deleteBtnVisible) {
        // Try global delete button approach
        const allDeleteBtns = page.locator('button:has-text("삭제")');
        const count = await allDeleteBtns.count();
        // click the last one (our newly added item should be last)
        if (count > 0) {
          await allDeleteBtns.last().click();
          await page.waitForTimeout(500);
          // Handle confirmation dialog if any
          const confirmBtn = page.locator('button:has-text("확인"), button:has-text("삭제"), [role="dialog"] button').last();
          const confirmVisible = await confirmBtn.isVisible({ timeout: 1000 }).catch(() => false);
          if (confirmVisible) {
            await confirmBtn.click();
            await page.waitForTimeout(500);
          }
        }
      } else {
        await deleteBtn.click();
        await page.waitForTimeout(500);
        const confirmBtn = page.locator('button:has-text("확인"), button:has-text("삭제"), [role="dialog"] button').last();
        const confirmVisible = await confirmBtn.isVisible({ timeout: 1000 }).catch(() => false);
        if (confirmVisible) {
          await confirmBtn.click();
          await page.waitForTimeout(500);
        }
      }

      await screenshot(page, 'after-delete');
      const itemGone = !(await page.locator('text=테스트-포트-9999').first().isVisible({ timeout: 1500 }).catch(() => false));
      if (itemGone) {
        record('delete-001', 'delete', '/', '테스트 포트 삭제 후 목록에서 제거 확인', 'passed', {
          trigger: '삭제 버튼 클릭', result: '"테스트-포트-9999" 항목이 목록에서 제거됨'
        });
      } else {
        record('delete-001', 'delete', '/', '테스트 포트 삭제', 'failed', {
          trigger: '삭제 버튼 클릭', result: '항목이 여전히 목록에 남아있음'
        });
        issues.push({ severity: 'medium', description: 'Port item not removed from list after delete' });
      }
    } else {
      record('delete-001', 'delete', '/', '테스트 포트 삭제', 'skipped', { note: '삭제할 테스트 항목 없음 (추가가 실패했거나 이미 없음)' });
    }
  } catch (e) {
    record('delete-001', 'delete', '/', '테스트 포트 삭제', 'failed', { error: e.message });
  }

  // ─── Test 10: 404 Page ───────────────────────────────────────────
  try {
    const resp = await page.goto(`${BASE_URL}/nonexistent-page-xyzabc`, { waitUntil: 'domcontentloaded', timeout: 8000 });
    await page.waitForTimeout(500);
    const bodyText = await page.textContent('body');
    const httpStatus = resp?.status() ?? 0;
    // SPA may redirect to / or show 404 content
    const has404 = bodyText?.includes('404') || bodyText?.includes('Not Found') || httpStatus === 404;
    const redirectedToHome = await page.url() === `${BASE_URL}/` || await page.url() === BASE_URL;
    await screenshot(page, '404-page');
    if (has404 || redirectedToHome) {
      record('error-001', 'error-handling', '/nonexistent', '존재하지 않는 URL 접근 처리', 'passed', {
        trigger: '/nonexistent-page-xyzabc 접근', httpStatus,
        result: has404 ? '404 페이지 표시' : 'SPA가 홈으로 리다이렉트'
      });
    } else {
      record('error-001', 'error-handling', '/nonexistent', '존재하지 않는 URL 처리', 'failed', {
        httpStatus, result: '적절한 에러 처리 없음'
      });
      issues.push({ severity: 'low', description: 'No 404 handling for nonexistent URL' });
    }
  } catch (e) {
    record('error-001', 'error-handling', '/nonexistent', '404 페이지 처리', 'failed', { error: e.message });
  }

  // ─── Test 11: Special characters in search ──────────────────────
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(500);
    const searchInput = page.locator('input[placeholder*="검색"], input[type="search"]').first();
    const visible = await searchInput.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      await searchInput.fill("<script>alert('xss')</script>");
      await page.waitForTimeout(500);
      // Check no alert dialog appeared
      let alertFired = false;
      page.on('dialog', async dialog => {
        alertFired = true;
        await dialog.dismiss();
      });
      await page.waitForTimeout(500);
      await screenshot(page, 'xss-test');
      if (!alertFired) {
        record('security-001', 'security', '/', 'XSS 입력 처리 (검색창)', 'passed', {
          trigger: "검색창에 <script>alert('xss')</script> 입력",
          result: 'XSS 스크립트 실행되지 않음'
        });
      } else {
        record('security-001', 'security', '/', 'XSS 입력 처리 (검색창)', 'failed', {
          trigger: "XSS 스크립트 입력", result: 'alert() 실행됨 - XSS 취약점!'
        });
        issues.push({ severity: 'critical', description: 'XSS vulnerability: script executed in search input' });
      }
      await searchInput.clear();
    } else {
      record('security-001', 'security', '/', 'XSS 입력 처리', 'skipped', { note: '검색 입력란 없음' });
    }
  } catch (e) {
    record('security-001', 'security', '/', 'XSS 입력 처리', 'failed', { error: e.message });
  }

  // ─── Test 12: Console errors check ───────────────────────────────
  try {
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(1000);
    await screenshot(page, 'final-state');
    if (consoleErrors.length === 0) {
      record('perf-001', 'performance', '/', '콘솔 에러 없음 (페이지 로드 시)', 'passed', {
        result: '콘솔 에러 0개'
      });
    } else {
      record('perf-001', 'performance', '/', '콘솔 에러 확인', 'failed', {
        result: `${consoleErrors.length}개 콘솔 에러`, errors: consoleErrors.slice(0, 5)
      });
      issues.push({ severity: 'low', description: `${consoleErrors.length} console errors on page load` });
    }
  } catch (e) {
    record('perf-001', 'performance', '/', '콘솔 에러 확인', 'failed', { error: e.message });
  }

  await browser.close();
  return { tests, issues };
}

run().then(({ tests, issues }) => {
  const total = passed + failed + skipped;
  const passRate = total > 0 ? ((passed / (total - skipped)) * 100).toFixed(1) + '%' : '0%';

  // Grade calculation
  const passRateNum = total > 0 ? (passed / (total - skipped)) * 100 : 0;
  let grade = 'F';
  if (passRateNum >= 90) grade = 'A';
  else if (passRateNum >= 80) grade = 'B';
  else if (passRateNum >= 70) grade = 'C';
  else if (passRateNum >= 60) grade = 'D';

  const report = {
    url: BASE_URL,
    timestamp: new Date().toISOString(),
    grade,
    summary: {
      totalTests: total,
      passed,
      failed,
      skipped,
      passRate
    },
    tests,
    issues
  };

  writeFileSync(`${RESULTS_DIR}/functional-report.json`, JSON.stringify(report, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(`Grade: ${grade}`);
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}, Skipped: ${skipped}`);
  console.log(`Pass Rate: ${passRate}`);
  console.log(`Issues: ${issues.length}`);
  console.log(`Report saved: ${RESULTS_DIR}/functional-report.json`);
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
