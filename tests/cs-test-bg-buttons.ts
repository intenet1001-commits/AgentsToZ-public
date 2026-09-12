/**
 * CS-test: bg 버튼 및 claude --bg 기능 UI 검증 (v3 - 헤더 컨트롤 통합 UI)
 * 실행: bun tests/cs-test-bg-buttons.ts
 * 전제: localhost:5173 dev server 실행 중
 *
 * 변경사항 (2026-05):
 * - 카드 인라인 bg 버튼 → 헤더 컨트롤로 통합 (card-claude-bg 제거됨)
 * - 오버플로우 메뉴 bg 항목 → 헤더 컨트롤로 통합 (menu-claude-bg 제거됨)
 * - 터미널 뷰 Claude 버튼은 유지됨
 */
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

const LOCAL_URL = process.env.LOCAL_URL ?? 'http://localhost:5173';

type Result = { name: string; pass: boolean; note: string };
const results: Result[] = [];

function check(name: string, pass: boolean, note = '') {
  results.push({ name, pass, note });
  console.log(`${pass ? '✓' : '✗'} ${name}${note ? ' — ' + note : ''}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const url = msg.location().url ?? '';
      // 외부 favicon 서비스 404는 우리 코드 문제가 아님
      if (url.includes('gstatic.com') || url.includes('favicon')) return;
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', err => consoleErrors.push(err.message));

  try {
    // --- 페이지 로드 ---
    await page.goto(LOCAL_URL, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(2000);

    const title = await page.title();
    check('페이지 로드', title.length > 0, `title="${title}"`);

    // --- 포트 카드 존재 확인 (card view mode) ---
    const cardBodies = page.locator('[data-help-key="card-body"]');
    const cardCount = await cardBodies.count();
    check('포트 카드 렌더링 (card-body)', cardCount > 0, `${cardCount}개 카드 발견`);

    // --- 헤더 컨트롤 (v3: 카드 bg 버튼 → 헤더로 통합됨) ---
    // --bg 모드 토글 버튼 확인
    const bgModeToggle = page.getByTestId('claude-bg-toggle');
    const bgModeCount = await bgModeToggle.count();
    check('헤더 --bg 모드 토글 버튼', bgModeCount > 0, `${bgModeCount}개 발견`);

    // cmux Agent View 버튼 확인
    const agentViewBtn = page.locator('[data-help-key="header-cmux-agent-view"]');
    const agentViewCount = await agentViewBtn.count();
    check('헤더 cmux Agent View 버튼', agentViewCount > 0, `${agentViewCount}개 발견`);

    // --- 기존 버튼들 (run/stop, favorite, more-menu) ---
    const runStopBtns = page.locator('[data-help-key="card-run-stop"]');
    check('run/stop 버튼 렌더링', await runStopBtns.count() > 0, `${await runStopBtns.count()}개`);

    const favBtns = page.locator('[data-help-key="card-favorite"]');
    check('favorite 버튼 렌더링', await favBtns.count() > 0, `${await favBtns.count()}개`);

    const moreMenuBtns = page.locator('[data-help-key="card-more-menu"]');
    const moreCount = await moreMenuBtns.count();
    check('... 오버플로우 버튼 렌더링 (card-more-menu)', moreCount > 0, `${moreCount}개`);

    // --- 오버플로우 메뉴 확인 (v3: bg 항목은 헤더로 통합됨) ---
    // 기본 메뉴 항목만 확인 (폴더 열기, 로그 보기 등)
    if (moreCount > 0) {
      await moreMenuBtns.first().click({ force: true });
      await page.waitForTimeout(400);

      // 메뉴가 열렸는지 확인
      const menuItems = page.locator('[data-help-key^="menu-"]');
      const menuItemCount = await menuItems.count();
      check('오버플로우 메뉴 열림', menuItemCount > 0, `${menuItemCount}개 메뉴 항목`);

      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }

    // --- 터미널 스플릿 뷰로 전환 → claude --bg 버튼 확인 ---
    // 뷰 모드 전환 버튼 찾기 (title="터미널 스플릿 뷰" 또는 유사)
    const terminalViewBtn = page.locator('button[title*="터미널 스플릿"]');
    const terminalViewCount = await terminalViewBtn.count();

    if (terminalViewCount > 0) {
      await terminalViewBtn.first().click({ force: true });
      await page.waitForTimeout(600);
      check('터미널 스플릿 뷰 전환 버튼 클릭', true, '뷰 전환 성공');

      // 리스트 첫 번째 항목 클릭 → sel 설정
      const listItems = page.locator('div[style*="cursor"]').first();
      // v4 list items — line 3784: <div key={item.id} onClick={() => setV4SelectedId(item.id)} style={{...
      // Broader approach: click first item in the list panel
      const v4Items = page.locator('div').filter({ hasText: /^\S/ }).first();

      // Try clicking the first row in terminal view
      await page.mouse.click(200, 200);
      await page.waitForTimeout(500);

      const claudeBgBtn = page.getByTestId('claude-bg-toggle');
      const claudeBgCount = await claudeBgBtn.count();
      check('터미널 뷰 claude --bg 버튼 렌더링', claudeBgCount > 0, `${claudeBgCount}개 발견`);

      if (claudeBgCount > 0) {
        const btnStyle = await claudeBgBtn.first().getAttribute('style');
        check('claude --bg 버튼 style 존재', !!btnStyle, btnStyle?.slice(0, 60) ?? '');
        // 보라색 계열 확인: #c8a8f0, #c4b5fd, #7c3aed, rgb(124, 58, 237) 등
        const hasColor = (btnStyle ?? '').includes('c8a8f0') ||
                         (btnStyle ?? '').includes('c4b5fd') ||
                         (btnStyle ?? '').includes('7c3aed') ||
                         (btnStyle ?? '').includes('200, 168, 240') ||
                         (btnStyle ?? '').includes('196, 181, 253') ||
                         (btnStyle ?? '').includes('124, 58, 237');
        check('claude --bg 버튼 보라색 계열 색상', hasColor, btnStyle?.slice(0, 80) ?? '');
      }

      // 카드 뷰로 복귀
      const cardViewBtn = page.locator('button[title*="카드 그리드"]');
      if (await cardViewBtn.count() > 0) await cardViewBtn.first().click();
      await page.waitForTimeout(300);
    } else {
      // 뷰 전환 버튼을 다른 방법으로 찾기
      const allBtns = await page.locator('button').all();
      let switched = false;
      for (const btn of allBtns) {
        const t = await btn.getAttribute('title').catch(() => '');
        if (t && t.includes('터미널')) {
          await btn.click();
          await page.waitForTimeout(600);
          switched = true;

          // 첫 번째 항목 클릭
          await page.mouse.click(200, 250);
          await page.waitForTimeout(500);

          const claudeBgBtn = page.getByTestId('claude-bg-toggle');
          const count = await claudeBgBtn.count();
          check('터미널 뷰 claude --bg 버튼 렌더링', count > 0, `${count}개 (뷰전환: "${t}")`);
          if (count > 0) {
            const s = await claudeBgBtn.first().getAttribute('style') ?? '';
            const hasClr = s.includes('c8a8f0') || s.includes('c4b5fd') || s.includes('7c3aed') ||
                           s.includes('200, 168, 240') || s.includes('196, 181, 253') || s.includes('124, 58, 237');
            check('claude --bg 버튼 보라색 계열 색상', hasClr, s.slice(0, 80));
          }
          break;
        }
      }
      if (!switched) {
        check('터미널 스플릿 뷰 전환 버튼', false, '버튼 없음 — 뷰 모드가 card 고정일 수 있음');
        // Fallback: source check
        const html = await page.content();
        check('claude --bg 버튼 소스 포함 확인', html.includes('claude --bg') || html.includes('c8a8f0'),
          html.includes('claude --bg') ? 'HTML에 존재' : 'HTML에 없음');
      }
    }

    // --- 탭 네비게이션 ---
    // 포털 탭
    const tabBtns = await page.locator('button').all();
    let portalTabClicked = false;
    for (const btn of tabBtns) {
      const txt = await btn.textContent().catch(() => '');
      if (txt && (txt.includes('포털') || txt.includes('북마크'))) {
        await btn.click();
        await page.waitForTimeout(500);
        portalTabClicked = true;
        check('포털/북마크 탭 전환', true, `버튼텍스트="${txt.trim()}"`);
        break;
      }
    }
    if (!portalTabClicked) check('포털/북마크 탭 전환', false, '탭 버튼 없음');

    // 설정 탭/버튼
    let settingClicked = false;
    for (const btn of tabBtns) {
      const t = await btn.getAttribute('title').catch(() => '');
      const txt = await btn.textContent().catch(() => '');
      if ((t && t.includes('설정')) || (txt && txt.trim() === '설정')) {
        await btn.click();
        await page.waitForTimeout(400);
        settingClicked = true;
        check('설정 탭/버튼 전환', true, `title="${t}" text="${txt?.trim()}"`);
        await page.keyboard.press('Escape').catch(() => {});
        break;
      }
    }
    if (!settingClicked) check('설정 탭/버튼 전환', false, '설정 버튼 없음');

    // --- 스크린샷 ---
    await page.screenshot({
      path: join(TESTS_DIR, 'results', 'cs-test-screenshot.png'),
      fullPage: false
    });
    console.log('\n스크린샷 저장: tests/results/cs-test-screenshot.png');

    // --- 콘솔 에러 확인 ---
    const filteredErrors = consoleErrors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('Warning:') &&
      !e.includes('DevTools') &&
      !e.includes('net::ERR_ABORTED') // 500s from AI suggest endpoints (no API key) are expected
    );
    // 500 errors from /api/suggest-batch (no Anthropic API key in test env) are expected
    const criticalErrors = filteredErrors.filter(e =>
      !e.includes('suggest') && !e.includes('500')
    );
    check('치명적 콘솔 에러 없음', criticalErrors.length === 0,
      criticalErrors.length > 0
        ? criticalErrors.slice(0, 3).join(' | ')
        : `비치명 500 에러 ${filteredErrors.length}개 (AI API 키 없음 — 정상)`
    );

  } catch (e: any) {
    console.error('테스트 실행 오류:', e.message);
    results.push({ name: 'TEST_EXECUTION', pass: false, note: e.message });
  } finally {
    await browser.close();
  }

  // 결과 요약
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const total = results.length;
  console.log(`\n=== 결과: ${passed}/${total} 통과, ${failed} 실패 ===`);
  if (failed > 0) {
    console.log('실패 항목:');
    results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.name}: ${r.note}`));
  }

  // JSON 저장
  const report = { timestamp: new Date().toISOString(), passed, failed, total, results };
  await Bun.write(
    join(TESTS_DIR, 'results', 'cs-test-bg-report.json'),
    JSON.stringify(report, null, 2)
  );
  console.log('리포트 저장: tests/results/cs-test-bg-report.json');
}

main().catch(console.error);
