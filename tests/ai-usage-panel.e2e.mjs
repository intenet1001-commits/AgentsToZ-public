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
  '**/api/open-cmux-project-agents',
  '**/api/open-claude-bg',
  '**/api/open-terminal-claude',
  '**/api/open-terminal-codex',
  '**/api/open-terminal-agy',
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
    assert(false, `${label}: 실행 요청 발생`);
    return null;
  }
  return launches[launches.length - 1];
}

try {
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(2_000);

  // ---------- 프로젝트 상세 열기 ----------
  const row = page.getByTestId('sidebar-project-row').first();
  assert(await row.count() > 0, '프로젝트 목록 렌더링');
  await row.click();
  await page.waitForTimeout(800);
  assert(await page.getByTestId('terminal-agent-panel').count() > 0, 'AI 실행 패널 표시');

  // ---------- 1. iTerm + tmux: 실행은 재사용, 새 창은 강제 생성 ----------
  await page.getByTestId('terminal-app-iterm').click();
  await page.waitForTimeout(400);
  const bgToggle = page.getByTestId('claude-bg-toggle');
  if (await bgToggle.count() > 0 && await bgToggle.getAttribute('aria-pressed') === 'true') {
    await bgToggle.click();   // Claude가 tmux 경로를 타도록 --bg를 끈다
    await page.waitForTimeout(300);
  }
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

  // ---------- 2. Orca: 같은 버튼 쌍이 newWindow 로 구분 ----------
  await page.getByTestId('terminal-app-orca').click();
  await page.waitForTimeout(400);
  await page.getByTestId('orca-launch-mode-floating').click();
  await page.waitForTimeout(300);
  const orcaBg = page.getByTestId('claude-bg-toggle');
  if (await orcaBg.count() > 0 && await orcaBg.getAttribute('aria-pressed') === 'true') {
    await orcaBg.click();
    await page.waitForTimeout(300);
  }
  const orcaCases = [
    ['detail-claude-run', 'Claude 실행', 'claude', false],
    ['detail-claude-new', 'Claude 새 창', 'claude', true],
    ['detail-codex-run', 'Codex 실행', 'codex', false],
    ['detail-codex-new', 'Codex 새 창', 'codex', true],
    ['detail-agy-run', 'AGY 실행', 'agy', false],
    ['detail-agy-new', 'AGY 새 창', 'agy', true],
  ];
  for (const [testId, label, agent, newWindow] of orcaCases) {
    const launch = await clickAndCaptureLaunch(testId, `orca ${label}`);
    if (!launch) continue;
    assert(launch.url === '/api/open-orca-agent', `orca ${label} → open-orca-agent`, launch.url);
    assert(launch.body?.agent === agent, `orca ${label} agent=${agent}`, `agent=${launch.body?.agent}`);
    assert(launch.body?.newWindow === newWindow, `orca ${label} newWindow=${newWindow}`, `newWindow=${launch.body?.newWindow}`);
  }

  // ---------- 3. AI 사용량 패널 ----------
  await page.getByTestId('btn-ai-usage').click();
  await page.waitForTimeout(4_000);

  assert(
    await page.getByTestId('context-api-outdated').count() === 0,
    '최신 API에서는 버전 경고가 없음',
  );

  const cards = page.getByTestId(/context-session-card-/);
  const cardCount = await cards.count();
  assert(cardCount > 0, '세션 카드 렌더링', `${cardCount}개`);

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
