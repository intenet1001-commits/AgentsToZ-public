import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const APP_URL = process.env.LOCAL_URL ?? 'http://localhost:9000';
const ORCA = process.env.ORCA_CLI
  ?? `${process.env.LOCALAPPDATA}\\Programs\\orca\\resources\\bin\\orca.exe`;
const agents = [
  ['header-claude-launch', 'claude'],
  ['header-codex-launch', 'codex'],
  ['header-agy-launch', 'agy'],
];
const fixturePath = process.env.ORCA_E2E_WORKTREE;

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

function readTerminal(handle) {
  const stdout = execFileSync(ORCA, ['terminal', 'read', '--terminal', handle, '--json'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  const parsed = JSON.parse(stdout);
  return parsed?.result?.terminal?.tail ?? [];
}

async function launchAndVerify(page, button, agent, expectedSurface, expectedWorktreePath) {
  console.log(`CLICK ${expectedSurface} ${agent}`);
  const responsePromise = page.waitForResponse(
    response => response.url().includes('/api/open-orca-agent') && response.request().method() === 'POST',
    { timeout: 120_000 },
  );
  await button.click();
  const response = await responsePromise;
  const request = response.request().postDataJSON();
  const result = await response.json();
  assert(request.agent === agent, `${expectedSurface} ${agent} 요청 agent가 정확함`);
  assert(request.floating === (expectedSurface === 'floating'), `${expectedSurface} ${agent} 표면 요청이 정확함`);
  assert(request.newWindow !== true, `${expectedSurface} ${agent} 일반 실행은 새창을 강제하지 않음`);
  if (expectedWorktreePath) {
    assert(
      String(request.worktreePath).replace(/\\/g, '/').toLowerCase() === expectedWorktreePath.replace(/\\/g, '/').toLowerCase(),
      `${expectedSurface} ${agent} 대상 워크트리 경로가 정확함`,
    );
  }
  assert(response.ok() && result.success === true, `${expectedSurface} ${agent} Orca API 성공`);
  assert(result.orcaSurface === expectedSurface, `${expectedSurface} ${agent} 응답 표면이 정확함`);
  if (expectedSurface === 'floating') {
    assert(result.worktreeId === 'global-floating-terminal', `${agent} 터미널이 global-floating-terminal 소속`);
    if (!result.reused) assert(result.hostPlatform === 'linux', `${agent} 플로팅 셸이 Linux/WSL`);
  } else {
    assert(result.worktreeId && result.worktreeId !== 'global-floating-terminal', `${agent} 터미널이 대상 워크트리 소속`);
    assert(result.hostPlatform !== 'linux', `${agent} 워크트리 셸이 Windows cmd`);
  }
  assert(typeof result.terminalHandle === 'string' && result.terminalHandle, `${expectedSurface} ${agent} 터미널 핸들 반환`);
  await page.waitForTimeout(1_500);
  const tail = readTerminal(result.terminalHandle);
  const text = tail.join('\n');
  assert(!/command not found|no such file or directory|cannot execute|permission denied|the system cannot find the path specified|is not recognized as an internal or external command/i.test(text), `${expectedSurface} ${agent} 실행 오류 없음`);
  assert(text.trim().length > 0, `${expectedSurface} ${agent} 실제 터미널 출력 확인`);
  console.log(`TAIL ${expectedSurface} ${agent}: ${tail.slice(-4).join(' | ').slice(0, 500)}`);
}

async function worktreeButton(page, testId, path) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const buttons = page.getByTestId(testId);
    for (let index = 0; index < await buttons.count(); index++) {
      const button = buttons.nth(index);
      const candidate = await button.getAttribute('data-worktree-path');
      if (candidate?.replace(/\\/g, '/').toLowerCase() === path.replace(/\\/g, '/').toLowerCase()) return button;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`${testId} not found for ${path}`);
}

async function elementByFolder(page, testId, path) {
  const elements = page.getByTestId(testId);
  const normalizedPath = path.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  for (let index = 0; index < await elements.count(); index++) {
    const element = elements.nth(index);
    const candidate = (await element.getAttribute('data-folder-path'))
      ?.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
    if (candidate === normalizedPath) return element;
  }
  throw new Error(`${testId} not found for ${path}`);
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);
  await page.addInitScript(() => {
    // Reproduce the stale preference that used to divert only Claude to Agent View.
    localStorage.setItem('portmanager-terminalApp', 'orca');
    localStorage.setItem('portmanager-orcaLaunchMode', 'worktree');
    localStorage.setItem('portmanager-bgMode', 'true');
    localStorage.setItem('portmanager-terminalDefaultsVersion', '5');
  });

  console.log(`OPEN ${APP_URL}`);
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByTestId('header-agent-launcher').waitFor({ state: 'visible' });

  await page.getByRole('button', { name: 'orca', exact: true }).first().click();
  await page.getByTestId('orca-launch-mode-floating').click();
  assert(
    await page.evaluate(() => localStorage.getItem('portmanager-orcaLaunchMode')) === 'floating',
    '플로팅 선택이 localStorage에 유지됨',
  );
  const claudeBgToggle = page.getByTestId('claude-bg-toggle');
  assert(await claudeBgToggle.count() === 1, 'Orca 플로팅에서 Claude --bg 선택기가 보임');
  assert(await claudeBgToggle.getAttribute('aria-pressed') === 'true', 'Orca 플로팅은 Claude --bg를 기본 ON으로 설정');
  // 아래 일반 Claude/Codex/agy 표면 검증은 기존처럼 각 에이전트의 직접 터미널 실행을 확인한다.
  await claudeBgToggle.click();
  assert(await claudeBgToggle.getAttribute('aria-pressed') === 'false', 'Claude --bg를 끄면 Orca 플로팅의 일반 Claude 실행으로 전환');

  for (const [testId, agent] of agents) {
    await launchAndVerify(page, page.getByTestId(testId), agent, 'floating');
  }

  if (fixturePath) {
    await page.getByTestId('orca-launch-mode-worktree').click();
    assert(
      await page.evaluate(() => localStorage.getItem('portmanager-orcaLaunchMode')) === 'worktree',
      '워크트리 내부 선택이 localStorage에 유지됨',
    );
    assert(await page.getByTestId('claude-bg-toggle').count() === 0, 'Orca 워크트리 내부에서는 Claude --bg 선택기가 숨겨짐');
    if (await page.getByTestId('project-card').count()) {
      const projectCard = await elementByFolder(page, 'project-card', process.cwd());
      await projectCard.locator('button[data-help-key="card-worktree"]').click();
    } else {
      const projectRow = await elementByFolder(page, 'sidebar-project-row', process.cwd());
      await projectRow.click();
      const worktreeToggle = page.locator('button[data-help-key="card-worktree"]').first();
      await worktreeToggle.waitFor({ state: 'visible' });
      if (await worktreeToggle.getAttribute('aria-pressed') !== 'true') await worktreeToggle.click();
    }
    await worktreeButton(page, 'worktree-claude-agent', fixturePath);
    for (const [testId, agent] of [
      ['worktree-claude-agent', 'claude'],
      ['worktree-codex-agent', 'codex'],
      ['worktree-agy-agent', 'agy'],
    ]) {
      await launchAndVerify(page, await worktreeButton(page, testId, fixturePath), agent, 'worktree', fixturePath);
    }
  }
} finally {
  await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 5_000))]);
}

console.log('PASS Orca Floating UI E2E');
process.exit(0);
