/**
 * Drives the real UI for the two things unit tests cannot see: that every
 * launch button sends the request it claims to, and that the AI usage panel
 * renders and acts on what the API actually returns.
 *
 * Every launch endpoint is intercepted, so this starts no terminal and no agent.
 * What is asserted is the request the UI produced — the part that was wrong when
 * "새 창" silently reused a session.
 *
 * 실행: bun tests/ai-usage-panel.e2e.mjs   (LOCAL_URL 로 dev 서버 지정)
 */
import { chromium } from 'playwright';

const APP_URL = process.env.LOCAL_URL ?? 'http://localhost:5199';
const results = [];

function assert(condition, message, note = '') {
  results.push({ condition: !!condition, message, note });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}${note ? ` — ${note}` : ''}`);
}

const LAUNCH_ROUTES = [
  '**/api/open-orca-agent',
  '**/api/open-tmux-claude',
  '**/api/open-tmux-claude-fresh',
  '**/api/open-tmux-claude-bypass',
  '**/api/open-tmux-codex',
  '**/api/open-tmux-agy',
  '**/api/open-cmux-claude',
  '**/api/open-cmux-claude-new',
  '**/api/open-cmux-codex',
  '**/api/open-cmux-agy',
  '**/api/open-cmux-hermes',
  '**/api/open-cmux-project-agents',
  '**/api/open-claude-bg',
  '**/api/open-terminal-claude',
  '**/api/open-terminal-claude-bypass',
  '**/api/open-terminal-codex',
  '**/api/open-terminal-agy',
  '**/api/open-terminal-hermes',
  '**/api/open-terminal-agent-view',
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await context.newPage();

/** Every launch attempt lands here instead of the machine. */
const launches = [];
for (const pattern of LAUNCH_ROUTES) {
  await page.route(pattern, async route => {
    const request = route.request();
    let body = null;
    try { body = request.postDataJSON(); } catch { body = null; }
    launches.push({ url: new URL(request.url()).pathname, body });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, message: '(e2e intercepted)' }),
    });
  });
}

// 실행 라우팅 행렬은 첫 임무 선택 모달 자체가 아니라 터미널 분기를 검증한다.
// 실제 저장소 상태와 무관하게 기존 프로젝트로 고정해 모든 클릭이 바로 실행 경로로 간다.
await page.route('**/api/repository-workflow/status', route => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    isGit: true,
    projectRoot: process.cwd(),
    installedVersion: 1,
    currentVersion: 1,
    updateAvailable: false,
    firstTaskPending: false,
  }),
}));

async function ensurePressed(locator, desired) {
  if (await locator.count() === 0) return;
  if ((await locator.getAttribute('aria-pressed')) === String(desired)) return;
  if (desired) page.once('dialog', dialog => dialog.accept());
  await locator.click();
  await page.waitForFunction(
    ({ testId, value }) => document.querySelector(`[data-testid="${testId}"]`)?.getAttribute('aria-pressed') === String(value),
    { testId: await locator.getAttribute('data-testid'), value: desired },
  );
}

async function clickAndCaptureLaunch(testId, label) {
  launches.length = 0;
  const button = page.getByTestId(testId);
  if (await button.count() === 0) {
    assert(false, `${label}: 버튼 존재`);
    return null;
  }
  await button.first().click();
  // A project that has never run an agent asks where to start first.
  const modal = page.getByTestId('first-task-worktree-modal');
  for (let i = 0; i < 20 && launches.length === 0; i++) {
    if (await modal.count() > 0) await page.getByTestId('first-task-use-main').click();
    await page.waitForTimeout(150);
  }
  if (launches.length === 0) {
    const visibleModal = await modal.isVisible().catch(() => false);
    const toastText = await page.locator('[data-testid="toast"]')?.allTextContents().catch(() => []);
    assert(false, `${label}: 실행 요청 발생`, `firstTaskModal=${visibleModal}, toast=${toastText.join(' | ')}`);
    return null;
  }
  return launches[launches.length - 1];
}

try {
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(2_000);

  // ---------- 프로젝트 상세 열기 ----------
  const row = page.locator(`[data-testid="sidebar-project-row"][data-folder-path="${process.cwd()}"]`).first();
  assert(await row.count() > 0, '프로젝트 목록 렌더링');
  // 행 중앙에는 고정/실행 버튼이 겹칠 수 있다. 실제 사용자가 프로젝트명을 누르는
  // 경로로 선택해야 부수 동작 없이 상세가 열린다.
  await row.locator('div > span').first().click();
  await page.waitForTimeout(800);
  assert(await page.getByTestId('terminal-agent-panel').count() > 0, 'AI 실행 패널 표시');

  // ---------- 1. iTerm/Terminal 직접 실행: 네 에이전트가 선택한 표면으로 감 ----------
  await page.getByTestId('terminal-app-iterm').click();
  await page.waitForTimeout(300);
  const directBg = page.getByTestId('claude-bg-toggle');
  await ensurePressed(directBg, false);
  const directTmux = page.getByTestId('tmux-toggle');
  if (await directTmux.count() > 0 && await directTmux.getAttribute('data-tmux-reach') !== 'off') {
    await directTmux.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="tmux-toggle"]')?.getAttribute('data-tmux-reach') === 'off');
  }
  await ensurePressed(page.getByTestId('bypass-toggle'), false);
  const directCases = [
    ['detail-claude-run', 'Claude', '/api/open-terminal-claude'],
    ['detail-codex-run', 'Codex', '/api/open-terminal-codex'],
    ['detail-agy-run', 'AGY', '/api/open-terminal-agy'],
    ['detail-hermes-run', 'Hermes', '/api/open-terminal-hermes'],
  ];
  for (const [testId, label, endpoint] of directCases) {
    const launch = await clickAndCaptureLaunch(testId, `iTerm ${label}`);
    if (!launch) continue;
    assert(launch.url === endpoint, `iTerm ${label} → ${endpoint}`, launch.url);
    assert(launch.body?.terminalApp === 'iterm', `iTerm ${label} terminalApp=iterm`, `terminalApp=${launch.body?.terminalApp}`);
  }

  await page.getByTestId('terminal-app-terminal').click();
  await page.waitForTimeout(300);
  const terminalBg = page.getByTestId('claude-bg-toggle');
  await ensurePressed(terminalBg, false);
  const terminalTmux = page.getByTestId('tmux-toggle');
  if (await terminalTmux.count() > 0 && await terminalTmux.getAttribute('data-tmux-reach') !== 'off') {
    await terminalTmux.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="tmux-toggle"]')?.getAttribute('data-tmux-reach') === 'off');
  }
  await ensurePressed(page.getByTestId('bypass-toggle'), false);
  for (const [testId, label, endpoint] of directCases) {
    const launch = await clickAndCaptureLaunch(testId, `Terminal ${label}`);
    if (!launch) continue;
    assert(launch.url === endpoint, `Terminal ${label} → ${endpoint}`, launch.url);
    assert(launch.body?.terminalApp === 'terminal', `Terminal ${label} terminalApp=terminal`, `terminalApp=${launch.body?.terminalApp}`);
  }

  // 우회는 지원하는 Claude/Codex에만 전달되고 Hermes에는 새지 않아야 한다.
  await ensurePressed(page.getByTestId('bypass-toggle'), true);
  const bypassClaude = await clickAndCaptureLaunch('detail-claude-run', 'Terminal Claude bypass');
  assert(bypassClaude?.url === '/api/open-terminal-claude-bypass', 'Terminal Claude bypass 전용 endpoint', bypassClaude?.url);
  const bypassCodex = await clickAndCaptureLaunch('detail-codex-run', 'Terminal Codex bypass');
  assert(bypassCodex?.body?.bypass === true, 'Terminal Codex bypass=true', `bypass=${bypassCodex?.body?.bypass}`);
  const bypassHermes = await clickAndCaptureLaunch('detail-hermes-run', 'Terminal Hermes 안전 실행');
  assert(bypassHermes?.body?.bypass !== true, 'Hermes에는 bypass를 전달하지 않음', `bypass=${bypassHermes?.body?.bypass}`);

  // ---------- 2. iTerm + tmux: 실행은 재사용, 새 창은 강제 생성 ----------
  await page.getByTestId('terminal-app-iterm').click();
  await page.waitForTimeout(400);
  const bgToggle = page.getByTestId('claude-bg-toggle');
  await ensurePressed(bgToggle, false); // Claude가 tmux 경로를 타도록 --bg를 끈다
  const tmuxToggle = page.getByTestId('tmux-toggle');
  if (await tmuxToggle.count() > 0 && await tmuxToggle.getAttribute('data-tmux-reach') === 'off') {
    await tmuxToggle.click();
    await page.waitForTimeout(300);
  }

  // Claude's reuse path splits by bypass (…-bypass vs plain); both are
  // reuse-or-new. What matters is that the pair names one session.
  const tmuxCases = [
    ['detail-claude-run', 'Claude 실행', ['/api/open-tmux-claude', '/api/open-tmux-claude-bypass'], null],
    ['detail-claude-new', 'Claude 새 창', ['/api/open-tmux-claude-fresh'], null],
    ['detail-codex-run', 'Codex 실행', ['/api/open-tmux-codex'], false],
    ['detail-codex-new', 'Codex 새 창', ['/api/open-tmux-codex'], true],
    ['detail-agy-run', 'AGY 실행', ['/api/open-tmux-agy'], false],
    ['detail-agy-new', 'AGY 새 창', ['/api/open-tmux-agy'], true],
  ];
  const claudeSessionNames = {};
  for (const [testId, label, endpoints, fresh] of tmuxCases) {
    const launch = await clickAndCaptureLaunch(testId, `tmux ${label}`);
    if (!launch) continue;
    assert(endpoints.includes(launch.url), `tmux ${label} → ${endpoints.join(' | ')}`, launch.url);
    if (fresh !== null) {
      assert(launch.body?.fresh === fresh, `tmux ${label} fresh=${fresh}`, `fresh=${launch.body?.fresh}`);
    }
    if (testId.startsWith('detail-claude')) claudeSessionNames[testId] = launch.body?.sessionName;
  }
  // The pair is only meaningful if both address the same tmux session. Note the
  // limits of what a click can show: the detail buttons act on the main tree, so
  // the worktree half of the name is empty here, and the `-bypass` half is added
  // server-side. tests/tmux-session-name.test.ts pins both rules directly.
  assert(
    claudeSessionNames['detail-claude-run']
      && claudeSessionNames['detail-claude-run'] === claudeSessionNames['detail-claude-new'],
    'tmux Claude 실행/새 창이 같은 세션을 대상으로 함',
    `${claudeSessionNames['detail-claude-run']} vs ${claudeSessionNames['detail-claude-new']}`,
  );

  // Hermes는 tmux 지원 대상으로 표시하지 않는다. tmux ON에서도 직접 터미널로 가야
  // "tmux가 켜졌는데 아무것도 안 열림"이 되지 않는다.
  const tmuxHermes = await clickAndCaptureLaunch('detail-hermes-run', 'tmux ON Hermes');
  assert(tmuxHermes?.url === '/api/open-terminal-hermes', 'tmux ON에서도 Hermes는 지원되는 직접 실행 경로', tmuxHermes?.url);

  // ---------- 3. cmux: 네 에이전트와 Claude 새 창 경로 ----------
  await page.getByTestId('terminal-app-cmux').click();
  await page.waitForTimeout(300);
  const cmuxBg = page.getByTestId('claude-bg-toggle');
  await ensurePressed(cmuxBg, false);
  const cmuxTmux = page.getByTestId('tmux-toggle');
  if (await cmuxTmux.count() > 0 && await cmuxTmux.getAttribute('data-tmux-reach') !== 'off') {
    await cmuxTmux.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="tmux-toggle"]')?.getAttribute('data-tmux-reach') === 'off');
  }
  const cmuxCases = [
    ['detail-claude-run', 'Claude 실행', '/api/open-cmux-claude'],
    ['detail-claude-new', 'Claude 새 창', '/api/open-cmux-claude-new'],
    ['detail-codex-run', 'Codex 실행', '/api/open-cmux-codex'],
    ['detail-hermes-run', 'Hermes 실행', '/api/open-cmux-hermes'],
  ];
  for (const [testId, label, endpoint] of cmuxCases) {
    const launch = await clickAndCaptureLaunch(testId, `cmux ${label}`);
    if (!launch) continue;
    assert(launch.url === endpoint, `cmux ${label} → ${endpoint}`, launch.url);
  }

  // ---------- 4. Orca: 같은 버튼 쌍이 newWindow 로 구분 ----------
  await page.getByTestId('terminal-app-orca').click();
  await page.waitForTimeout(400);
  await page.getByTestId('orca-launch-mode-floating').click();
  await page.waitForTimeout(300);
  const orcaBg = page.getByTestId('claude-bg-toggle');
  await ensurePressed(orcaBg, false);
  const orcaCases = [
    ['detail-claude-run', 'Claude 실행', 'claude', false],
    ['detail-claude-new', 'Claude 새 창', 'claude', true],
    ['detail-codex-run', 'Codex 실행', 'codex', false],
    ['detail-codex-new', 'Codex 새 창', 'codex', true],
    ['detail-agy-run', 'AGY 실행', 'agy', false],
    ['detail-agy-new', 'AGY 새 창', 'agy', true],
    ['detail-hermes-run', 'Hermes 실행', 'hermes', false],
    ['detail-hermes-new', 'Hermes 새 창', 'hermes', true],
  ];
  for (const [testId, label, agent, newWindow] of orcaCases) {
    const launch = await clickAndCaptureLaunch(testId, `orca ${label}`);
    if (!launch) continue;
    assert(launch.url === '/api/open-orca-agent', `orca ${label} → open-orca-agent`, launch.url);
    assert(launch.body?.agent === agent, `orca ${label} agent=${agent}`, `agent=${launch.body?.agent}`);
    assert(launch.body?.newWindow === newWindow, `orca ${label} newWindow=${newWindow}`, `newWindow=${launch.body?.newWindow}`);
  }

  // ---------- 5. AI 사용량 패널 ----------
  await page.getByTestId('btn-ai-usage').click();
  await page.waitForTimeout(4_000);

  assert(
    await page.getByTestId('context-api-outdated').count() === 0,
    '최신 API에서는 버전 경고가 없음',
  );

  const cards = page.getByTestId(/context-session-card-/);
  const cardCount = await cards.count();
  const emptySessionMessage = page.getByText(/표시할 최근 AI 세션이 없습니다/);
  assert(cardCount > 0 || await emptySessionMessage.count() > 0, '세션 카드 또는 정직한 빈 상태 렌더링', `${cardCount}개`);

  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  assert(!body.includes('실행 위치 미확인'), 'Agent View에 없는 유령 행이 남지 않음');

  const agentViewButtons = page.getByRole('button', { name: /에이전트 뷰 열기/ });
  if (await agentViewButtons.count() > 0) {
    launches.length = 0;
    await agentViewButtons.first().click();
    await page.waitForTimeout(2_500);
    assert(launches.length > 0, '백그라운드 에이전트 이동이 Agent View를 실행', launches[0]?.url ?? '');
  } else {
    console.log('SKIP 백그라운드 에이전트 행이 없어 Agent View 이동은 건너뜀');
  }
} catch (error) {
  assert(false, `예외 없이 완주`, error?.message ?? String(error));
} finally {
  await browser.close();
}

const failed = results.filter(r => !r.condition);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('실패:');
  for (const f of failed) console.log(`  - ${f.message}${f.note ? ` (${f.note})` : ''}`);
}
process.exit(failed.length ? 1 : 0);
