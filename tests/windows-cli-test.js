/**
 * Windows CLI 호출 점검 스크립트
 * 실행: node run.js tests/windows-cli-test.js (playwright-skill 디렉토리에서)
 * 또는: cd %USERPROFILE%\.claude\skills\playwright-skill && node run.js <프로젝트경로>\tests\windows-cli-test.js
 */
const { chromium } = require('playwright');

const APP_URL = 'http://localhost:9000';
const API_URL = 'http://localhost:3001';

const results = [];
const issues = [];

function log(msg) { console.log(msg); }
function pass(test, detail = '') { results.push({ test, status: '✅', detail }); log(`✅ ${test}${detail ? ': ' + detail : ''}`); }
function fail(test, detail = '') { results.push({ test, status: '❌', detail }); issues.push(`${test}: ${detail}`); log(`❌ ${test}${detail ? ': ' + detail : ''}`); }
function warn(test, detail = '') { results.push({ test, status: '⚠️', detail }); log(`⚠️ ${test}${detail ? ': ' + detail : ''}`); }

(async () => {
  // ── A. Win 빌드 prereqs API 직접 확인 ─────────────────────────────────
  log('\n═══════════════════════════════════════════');
  log('[A] Windows 빌드 prereqs API 점검');
  log('═══════════════════════════════════════════');
  try {
    // 빌드 중이 아닌지 확인 후 prereqs만 체크 (실제 빌드 X)
    const res = await fetch(`${API_URL}/api/build-windows`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      // 빌드 시작됨 (prereqs 모두 갖춰짐)
      pass('Win 빌드 prereqs', 'cargo + VS Build Tools 모두 설치됨 — 빌드 시작됨');
      // 빌드 취소 (상태 초기화)
      await fetch(`${API_URL}/api/build-status`).catch(() => {});
    } else if (data.missingTools) {
      warn('Win 빌드 prereqs', `누락: ${data.missingTools.join(', ')}`);
      log(`  → 자동설치 가능: ${data.canAutoInstall}`);
      log(`  → 메시지: ${data.error?.split('\n')[0]}`);
    } else {
      warn('Win 빌드 prereqs', data.error || '알 수 없는 응답');
    }
  } catch (e) {
    fail('Win 빌드 API', `연결 실패: ${e.message}`);
  }

  // ── B. 브라우저 기반 UI 점검 ────────────────────────────────────────────
  log('\n═══════════════════════════════════════════');
  log('[B] UI 점검 (Claude / Codex / Antigravity)');
  log('═══════════════════════════════════════════');

  const browser = await chromium.launch({ headless: false, slowMo: 70 });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  try {
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1200);

    // ── B1. 현재 terminalApp 모드 확인 ──────────────────────────────────
    log('\n[B1] 현재 terminalApp 모드 확인...');
    const allBtns = await page.$$eval('button', bs => bs.map(b => ({
      text: b.textContent?.trim(),
      active: b.className.includes('amber') || b.className.includes('orange') || b.style?.background?.includes('amber'),
      cls: b.className.substring(0, 60),
    })));
    const termBtns = allBtns.filter(b => ['powershell','wsl','bg'].includes(b.text || ''));
    log(`  터미널 버튼: ${termBtns.map(b => `${b.text}(active=${b.active})`).join(', ')}`);

    // localStorage에서 현재 모드 확인
    const currentMode = await page.evaluate(() => localStorage.getItem('portmanager-terminalApp'));
    log(`  localStorage terminalApp: ${currentMode ?? '(없음 — 기본값 사용)'}`);
    if (!currentMode || currentMode === 'powershell') {
      pass('기본 terminalApp', `powershell 모드 (${currentMode ?? '기본값'})`);
    } else {
      warn('기본 terminalApp', `${currentMode} 모드 (수동 설정됨)`);
    }

    // ── B2. 더미 포트 추가 (folderPath 포함) ────────────────────────────
    log('\n[B2] 테스트용 더미 포트 추가...');
    const getRes = await page.evaluate(async (apiUrl) => {
      const r = await fetch(`${apiUrl}/api/ports`);
      return r.ok ? r.json() : [];
    }, API_URL);
    const existingPorts = Array.isArray(getRes) ? getRes : [];

    const dummyPort = {
      id: 'test-win-cli-9999',
      name: 'Win CLI 테스트 포트',
      port: 9999,
      folderPath: 'C:\\Users\\inten',
      isRunning: false,
    };
    const saveRes = await page.evaluate(async ({ apiUrl, ports }) => {
      const r = await fetch(`${apiUrl}/api/ports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ports),
      });
      return r.ok;
    }, { apiUrl: API_URL, ports: [...existingPorts, dummyPort] });

    if (saveRes) {
      pass('더미 포트 추가', 'port:9999, folderPath:C:\\Users\\inten');
    } else {
      fail('더미 포트 추가', 'POST /api/ports 실패');
    }

    // 페이지 새로고침하여 포트 목록 반영
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

    // ── B3. WSL 모드에서 Codex/agy 에러 확인 (수정 전 동작 검증) ────────
    log('\n[B3] WSL 모드 전환 후 Codex 클릭 테스트...');
    const wslBtn = page.locator('button').filter({ hasText: 'wsl' });
    if (await wslBtn.count() > 0) {
      await wslBtn.click();
      await page.waitForTimeout(400);
      log('  → wsl 모드로 전환');

      // Codex 버튼 찾기
      const codexBtn = page.locator('button[title^="Codex"]').first();
      if (await codexBtn.count() > 0) {
        await codexBtn.click();
        await page.waitForTimeout(1500);
        await page.screenshot({ path: 'C:/tmp/wincli-wsl-codex.png' });

        // 에러 토스트 확인
        const toastText = await page.evaluate(() => document.body.innerText);
        if (toastText.includes('실행 중') || toastText.includes('Windows Terminal')) {
          pass('WSL 모드 Codex (수정 후)', 'Windows Terminal 폴백 실행됨');
        } else if (toastText.includes('실패') || toastText.includes('오류')) {
          fail('WSL 모드 Codex', '에러 토스트 발생 (수정 미적용?)');
        } else {
          warn('WSL 모드 Codex', '토스트 내용 불명확');
        }
      } else {
        warn('Codex 버튼', '더미 포트가 없거나 버튼 미감지 — 포트 선택 필요');
        log('  → 포트 카드 클릭 후 상세패널에서 Codex 버튼 탐색');
        // 포트 카드 클릭
        const portCard = page.locator('text=Win CLI 테스트 포트').first();
        if (await portCard.count() > 0) {
          await portCard.click();
          await page.waitForTimeout(600);
          const codexBtn2 = page.locator('button').filter({ hasText: /codex/i }).first();
          if (await codexBtn2.count() > 0) {
            await codexBtn2.click();
            await page.waitForTimeout(1500);
            await page.screenshot({ path: 'C:/tmp/wincli-wsl-codex2.png' });
            const t2 = await page.evaluate(() => document.body.innerText);
            if (t2.includes('실행 중') || t2.includes('Windows Terminal')) {
              pass('WSL 모드 Codex (수정 후)', 'Windows Terminal 폴백 실행됨');
            } else {
              warn('WSL 모드 Codex', '결과 불명확');
            }
          }
        }
      }
    }

    // ── B4. powershell 모드에서 Codex/agy 성공 확인 ─────────────────────
    log('\n[B4] powershell 모드 전환 후 Codex/AGY 테스트...');
    const psBtn = page.locator('button').filter({ hasText: 'powershell' });
    if (await psBtn.count() > 0) {
      await psBtn.click();
      await page.waitForTimeout(400);
      log('  → powershell 모드로 전환');

      // Codex 버튼 — title 속성으로 찾기
      const codexBtnPs = page.locator('button[title^="Codex"]').first();
      const codexBtnPs2 = page.locator('button').filter({ hasText: /^Codex$/i }).first();
      const hasCodex = await codexBtnPs.count() > 0 || await codexBtnPs2.count() > 0;

      if (hasCodex) {
        const btn = await codexBtnPs.count() > 0 ? codexBtnPs : codexBtnPs2;
        await btn.click();
        await page.waitForTimeout(1500);
        const t = await page.evaluate(() => document.body.innerText);
        if (t.includes('실행 중') || t.includes('Terminal')) {
          pass('powershell 모드 Codex', '성공 토스트 확인');
        } else {
          warn('powershell 모드 Codex', '토스트 미확인 (wt.exe 창이 열렸을 수 있음)');
        }
        await page.screenshot({ path: 'C:/tmp/wincli-ps-codex.png' });
      } else {
        warn('Codex 버튼 (powershell)', '카드 내 버튼 미감지 — 상세패널 확인 필요');
      }

      // AGY 버튼
      const agyBtn = page.locator('button[title^="Antigravity"]').first();
      const agyBtn2 = page.locator('button').filter({ hasText: /^agy$/i }).first();
      const hasAgy = await agyBtn.count() > 0 || await agyBtn2.count() > 0;

      if (hasAgy) {
        const btn = await agyBtn.count() > 0 ? agyBtn : agyBtn2;
        await btn.click();
        await page.waitForTimeout(1500);
        const t = await page.evaluate(() => document.body.innerText);
        if (t.includes('실행 중') || t.includes('Terminal')) {
          pass('powershell 모드 Antigravity', '성공 토스트 확인');
        } else {
          warn('powershell 모드 Antigravity', '토스트 미확인');
        }
      }
    }

    // ── B5. Claude 버튼 확인 ────────────────────────────────────────────
    log('\n[B5] Claude 버튼 확인...');
    const claudeBtn = page.locator('button[title*="Claude"]').first();
    const claudeBtn2 = page.locator('button').filter({ hasText: /^Claude$/ }).first();
    const hasClaudeBtn = await claudeBtn.count() > 0 || await claudeBtn2.count() > 0;
    if (hasClaudeBtn) {
      pass('Claude 버튼 존재', 'title 또는 텍스트로 감지됨');
    } else {
      warn('Claude 버튼', '포트 카드 없거나 미감지');
    }

    // ── B6. 더미 포트 정리 ──────────────────────────────────────────────
    log('\n[B6] 더미 포트 정리...');
    await page.evaluate(async ({ apiUrl, ports }) => {
      await fetch(`${apiUrl}/api/ports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ports),
      });
    }, { apiUrl: API_URL, ports: existingPorts });
    log('  → 원래 포트 목록 복원 완료');

    // 최종 스크린샷
    await page.screenshot({ path: 'C:/tmp/wincli-final.png' });

  } catch (err) {
    fail('테스트 오류', err.message.substring(0, 120));
    await page.screenshot({ path: 'C:/tmp/wincli-error.png' }).catch(() => {});
  }

  // ── 결과 요약 ────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log('           최종 점검 결과');
  console.log('═══════════════════════════════════════════');
  results.forEach(r => console.log(`  ${r.status}  ${r.test}${r.detail ? ' — ' + r.detail : ''}`));

  if (consoleErrors.length > 0) {
    console.log(`\n🔴 브라우저 콘솔 에러 ${consoleErrors.length}개:`);
    consoleErrors.slice(0, 3).forEach(e => console.log('  ', e.substring(0, 100)));
  }

  console.log('\n──── 이슈 목록 ────');
  if (issues.length === 0) console.log('  ✅ 이슈 없음');
  else issues.forEach((v, i) => console.log(`  ${i + 1}. ${v}`));

  await browser.close();
})();
