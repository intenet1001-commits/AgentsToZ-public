/**
 * 스모크 테스트 — 핵심 경로만 빠르게 확인.
 * 사용: `node tests/smoke.mjs`
 *
 * 옵션 환경변수:
 *   TARGET=local   → http://localhost:9000 (기본)  — 로컬 App.tsx 전체 (ports + portal)
 *   TARGET=vercel PORTAL_URL=https://<your-portal> → 별도 포털 배포본
 *   TARGET=<url>   → 임의 URL (자동 감지)
 *   VIEWPORT=mobile → 375x812 (iPhone SE 세로)
 *   API_PORT=3101  → 격리된 로컬 API 포트 (기본 3001)
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { classifyPortalSmokeSurface } from './portal-smoke-surface.mjs';
import { classifySmokeTarget } from './smoke-target.mjs';

const API_PORT = Number(process.env.API_PORT) || 3001;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const contextApiContract = JSON.parse(
  readFileSync(new URL('../context-api-contract.json', import.meta.url), 'utf8'),
);

const TARGET = process.env.TARGET === 'vercel'
  ? process.env.PORTAL_URL
  : process.env.TARGET && process.env.TARGET.startsWith('http')
    ? process.env.TARGET
    : 'http://localhost:9000';

if (!TARGET) throw new Error('TARGET=vercel requires an explicit PORTAL_URL.');

const { isLocalFullApp, isPortalOnly } = classifySmokeTarget(TARGET);
const isMobileViewport = process.env.VIEWPORT === 'mobile';
const viewport = isMobileViewport ? { width: 375, height: 812 } : { width: 1280, height: 800 };

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function verifyCurrentGitWorktreeUi(browser) {
  const projectId = 'smoke-current-worktree-parent';
  const projectPath = '/tmp/agentstoz-smoke-current-worktree';
  const linkedPath = `${projectPath}/worktrees/codex-visible-worktree`;
  const worktrees = [
    {
      path: projectPath,
      branch: 'main',
      head: 'a'.repeat(40),
      is_main: true,
      changedFiles: 0,
      stagedFiles: 0,
      untrackedFiles: 0,
      conflictedFiles: 0,
      hasCommits: true,
      upstream: 'origin/main',
      hasUpstream: true,
      remoteBranchExists: true,
      githubConnected: true,
      ahead: 0,
      behind: 0,
    },
    {
      path: linkedPath,
      branch: 'codex/visible-worktree',
      head: 'b'.repeat(40),
      is_main: false,
      changedFiles: 0,
      stagedFiles: 0,
      untrackedFiles: 0,
      conflictedFiles: 0,
      hasCommits: true,
      upstream: 'origin/codex/visible-worktree',
      hasUpstream: true,
      remoteBranchExists: true,
      githubConnected: true,
      ahead: 0,
      behind: 0,
    },
  ];
  const linkedTargetId = 'rwt_' + createHash('sha256').update('agentstoz-runtime-worktree-v1\0' + projectId + '\0' + linkedPath).digest('hex').slice(0, 48);
  const terminalStarts = [];
  const browserOpens = [];
  const previewOpens = [];
  let worktreeRefreshGate = null;
  let releaseWorktreeRefresh = () => {};
  let noteWorktreeRefresh = () => {};
  let terminalSession;
  const runtimeTargets = [
    {targetId: projectId, projectTargetId: projectId, label: '워크트리 실측 프로젝트', scope: 'main', branch: 'main', locked: false, worktreeCapable: true},
    {targetId: linkedTargetId, projectTargetId: projectId, label: '워크트리 실측 프로젝트 · codex/visible-worktree', scope: 'worktree', branch: 'codex/visible-worktree', locked: false, worktreeCapable: true},
  ];
  const observedApiRequests = [];
  const isolated = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await isolated.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    observedApiRequests.push(`${request.method()} ${pathname}`);
    const json = (body, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    if (pathname === '/api/open-browser') { browserOpens.push(request.postDataJSON()); return json({success:true}); }
    if (pathname === '/api/open-orca-localhost' || pathname === '/api/open-cmux-localhost') {
      previewOpens.push({path:pathname,body:request.postDataJSON()});return json({success:true,message:'Preview fixture opened'});
    }
    if (pathname === '/api/agent-runtime/targets') return json({protocolVersion: 'agentstoz-tasks-v2', targets: runtimeTargets, complete: true});
    if (pathname === '/api/agent-runtime/terminals') {
      const body = request.postDataJSON();
      if (body.operation === 'start') {
        terminalStarts.push(body);
        terminalSession = {id: 'smoke-terminal-session', targetId: body.targetId, agent: body.agent, state: 'running', createdAt: new Date().toISOString(), exitCode: null, cols: 100, rows: 28};
      }
      if (body.operation === 'list') return json({sessions: terminalSession ? [terminalSession] : []});
      if (body.operation === 'read') return json({session: terminalSession, chunks: [{seq: 1, text: 'Fixture CLI ready'}], nextCursor: 1, truncated: false, hasMore: false});
      return json({session: terminalSession});
    }
    if (pathname === '/api/agent-runtime/terminals/access') return json({connections: []});
    if (pathname === '/api/agent-runtime/terminals/memory') return json({jobs:[{sessionId:'closed-fixture-session',targetId:projectId,state:'failed'}]});
    if (pathname === '/api/ports') {
      return json(request.method() === 'GET'
        ? [{ id: projectId, name: '워크트리 실측 프로젝트', folderPath: projectPath, port:9000, isRunning: false }]
        : { success: true });
    }
    if (pathname === '/api/ports/merge') return json({ success: true });
    if (pathname === '/api/discover-registered-git-worktrees') {
      return json({
        success: true,
        families: [{ projectId, worktrees }],
        registeredProjectIds: [projectId],
        nextCursor: null,
        truncated: false,
      });
    }
    if (pathname === '/api/list-git-worktrees') {
      if (worktreeRefreshGate) {
        noteWorktreeRefresh();
        await worktreeRefreshGate;
      }
      return json({ success: true, worktrees });
    }
    if (pathname === '/api/git-branch-hygiene') return json({
      success: true,
      summary: {
        defaultBranch: 'main',
        defaultRemoteRef: 'origin/main',
        defaultReliable: true,
        generatedAt: '2026-08-31T00:00:00.000Z',
        totalLocalBranches: 2,
        totalRemoteBranches: 2,
        safeDeleteCount: 2,
        reviewCount: 0,
        overflowCount: 0,
        attentionCount: 2,
        needsAttention: true,
        truncated: false,
        branches: [],
      },
    });
    if (pathname === '/api/workspace-roots') return json(request.method() === 'GET' ? [] : { success: true });
    if (pathname === '/api/portal') return json({
      items: [],
      localOnlyDeletedPortIds: [],
      remoteDeletedPortIds: [],
      verifiedLegacyGeneratedWorktreeIds: [],
    });
    if (pathname === '/api/portal/safety-lease/acquire') return json({
      success: true,
      token: 'f'.repeat(64),
      metadata: {
        localOnlyDeletedPortIds: [],
        remoteDeletedPortIds: [],
        verifiedLegacyGeneratedWorktreeIds: [],
      },
      fingerprint: '[[],[],[]]',
      expiresInMs: 30_000,
    });
    if (pathname === '/api/portal/safety-lease/renew') {
      return json({ success: true, renewed: true, expiresInMs: 30_000 });
    }
    if (pathname === '/api/portal/safety-lease/release') return json({ success: true, released: true });
    if (pathname === '/api/check-ports-batch') return json({ success: true, results: [] });
    if (pathname === '/api/browser-profiles') return json({ success: true, profiles: [] });
    if (pathname === '/api/last-visits' || pathname === '/api/last-git-activity') return json({});
    if (pathname === '/api/project-memory/hermes-adapter') return json({ hermesCliPath: null });
    return json({ success: true, results: [] });
  });
  const worktreePage = await isolated.newPage();
  const browserErrors = [];
  worktreePage.on('pageerror', error => browserErrors.push(`pageerror:${error.message}`));
  worktreePage.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      browserErrors.push(`${message.type()}:${message.text()}`);
    }
  });
  await worktreePage.addInitScript(() => {
    localStorage.setItem('portmanager-setup-wizard-seen-v1', 'true');
    localStorage.setItem('folder-portal-migrated-v1', '1');
    localStorage.setItem('portmanager-ui-zoom', '1.25');
  });
  try {
    await worktreePage.clock.install();
    await worktreePage.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const row = worktreePage.locator(`[data-testid="sidebar-project-row"][data-project-id="${projectId}"]`);
    await row.waitFor({ state: 'visible', timeout: 15_000 });
    const sidebarCount = row.getByTestId('sidebar-current-worktree-count');
    try {
      await sidebarCount.waitFor({ state: 'visible', timeout: 10_000 });
    } catch (error) {
      const rowText = ((await row.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}; APIs=${observedApiRequests.join(',')}; row=${rowText}; browser=${browserErrors.join('|')}`);
    }
    check('Local: 사이드바가 Git 현재 연결 워크트리 1개를 표시', (await sidebarCount.textContent())?.trim() === '1');

    await row.click();
    const toggle = worktreePage.getByRole('button', { name: /^현재 Git 워크트리 1개/ });
    await toggle.waitFor({ state: 'visible', timeout: 10_000 });
    const currentCount = worktreePage.getByTestId('current-git-worktree-count');
    await currentCount.waitFor({ state: 'visible', timeout: 10_000 });
    if (await toggle.getAttribute('aria-pressed') === 'true') {
      await toggle.click();
      await currentCount.waitFor({ state: 'hidden', timeout: 5_000 });
    }
    await toggle.click();
    await currentCount.waitFor({ state: 'visible', timeout: 10_000 });
    const linkedPathRow = worktreePage.locator(`[data-testid="worktree-path"][title="${linkedPath}"]`);
    await linkedPathRow.waitFor({ state: 'visible', timeout: 10_000 });
    check('Local: 워크트리 버튼으로 목록을 다시 열면 Git 현재 1개를 표시',
      ((await currentCount.textContent()) ?? '').includes('Git 현재 1개'));
    check('Local: 외부에서 만든 워크트리의 정확한 브랜치와 경로를 표시',
      await linkedPathRow.count() === 1
        && await worktreePage.getByText('codex/visible-worktree', { exact: true }).count() === 1,
      linkedPath);
    const hygiene = worktreePage.getByTestId('branch-hygiene-harness');
    await hygiene.waitFor({ state: 'visible', timeout: 10_000 });
    check('Local: 브랜치가 쌓이면 정리 하네스가 근거와 AI 유도 버튼을 표시',
      (await hygiene.textContent())?.includes('브랜치 정리 필요 2건') === true
        && await worktreePage.getByTestId('branch-hygiene-copy-prompt').count() === 1);
    for (const path of [projectPath, linkedPath]) {
      const group = worktreePage.locator(`[data-testid="worktree-action-groups"][data-worktree-path="${path}"]`);
      check('Local: 메인·브랜치의 앱 내부/외부 터미널/공급자/Git 구분 ' + path,
        await group.getByTestId('worktree-internal-ai').count() === 1 && await group.getByTestId('worktree-external-terminal').count() === 1
        && await group.getByTestId('worktree-provider-apps').count() === 1 && await group.getByTestId('worktree-git-actions').count() === 1);
    }
    // Default installed window dimensions; keep the stored 125% zoom active.
    await worktreePage.setViewportSize({width: 1000, height: 1050});
    check('Local: 1000×1050 · 125% 작업 그룹 가로 넘침 없음', await worktreePage.getByTestId('worktree-action-groups').evaluateAll(groups =>
      groups.every(group => group.scrollWidth <= group.clientWidth + 1)));
    const detailBrowser = worktreePage.getByTestId('detail-browser-localhost');
    const mainBrowser = worktreePage.getByTestId('worktree-main-browser-localhost');
    const linkedBrowser = worktreePage.getByTestId('worktree-open-localhost');
    check('Local: 상세·메인·브랜치 미리보기를 브라우저 한 동작으로 표시',
      (await Promise.all([detailBrowser,mainBrowser,linkedBrowser].map(button=>button.textContent()))).every(text=>text?.trim()==='브라우저')
      && await worktreePage.getByRole('button',{name:'cmux에서 열기',exact:true}).count()===0
      && await worktreePage.getByRole('button',{name:'Orca에서 열기',exact:true}).count()===0);
    mkdirSync('output/playwright', {recursive:true});
    for (const [name,button] of [['detail',detailBrowser],['main',mainBrowser],['linked',linkedBrowser]]) {
      const group = button.locator('..');
      await button.scrollIntoViewIfNeeded();
      await group.locator('summary').click();
      await group.locator('.workspace-tools-panel').evaluate(panel=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(panel.style.left)))));
      const bounds = await group.locator('.workspace-tools-panel').evaluate(panel=>{
        const rect=panel.getBoundingClientRect();let left=0,right=window.innerWidth,top=0,bottom=window.innerHeight;
        for(let parent=panel.parentElement;parent;parent=parent.parentElement){
          if(['auto','scroll','hidden','clip'].includes(getComputedStyle(parent).overflowX)){
            const clip=parent.getBoundingClientRect();left=Math.max(left,clip.left);right=Math.min(right,clip.right);
          }
          if(['auto','scroll','hidden','clip'].includes(getComputedStyle(parent).overflowY)){
            const clip=parent.getBoundingClientRect();top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom);
          }
        }
        return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,clipLeft:left,clipRight:right,clipTop:top,clipBottom:bottom};
      });
      check('Local: 125% 브라우저 옵션 문구가 스크롤 영역 안에 표시 '+name,
        bounds.left>=bounds.clipLeft-1&&bounds.right<=bounds.clipRight+1&&bounds.top>=bounds.clipTop-1&&bounds.bottom<=bounds.clipBottom+1,JSON.stringify(bounds));
      await worktreePage.screenshot({path:`output/playwright/browser-options-${name}-125.png`});
      await group.locator('summary').click();
    }
    await Promise.all([worktreePage.waitForResponse(response=>new URL(response.url()).pathname==='/api/open-browser'),detailBrowser.click()]);
    check('Local: 브라우저 기본 동작은 Ego Lite',browserOpens.length===1&&browserOpens[0].browser==='ego-lite'&&browserOpens[0].url==='http://localhost:9000/');
    const settingsButton = worktreePage.getByTestId('appearance-settings');
    const settingsTools = settingsButton.locator('xpath=ancestor::details[1]');
    if (!await settingsButton.isVisible()) await settingsTools.locator(':scope > summary').click();
    await settingsButton.click();
    await worktreePage.getByTestId('preferred-browser').selectOption('chrome');
    await worktreePage.getByRole('dialog',{name:'앱 설정',exact:true}).getByRole('button',{name:'닫기',exact:true}).click();
    await Promise.all([worktreePage.waitForResponse(response=>new URL(response.url()).pathname==='/api/open-browser'),mainBrowser.click()]);
    await Promise.all([worktreePage.waitForResponse(response=>new URL(response.url()).pathname==='/api/open-browser'),linkedBrowser.click()]);
    check('Local: 설정 변경 즉시 메인·브랜치 브라우저에 반영',browserOpens.length===3&&browserOpens.slice(1).every(open=>open.browser==='chrome')
      && browserOpens[1].url==='http://localhost:9000/'&&browserOpens[2].url!==browserOpens[1].url);
    const linkedBrowserGroup = linkedBrowser.locator('..');
    await linkedBrowserGroup.locator('summary').click();
    await Promise.all([worktreePage.waitForResponse(response=>new URL(response.url()).pathname==='/api/open-orca-localhost'),linkedBrowserGroup.getByRole('button',{name:'Orca에서 열기',exact:true}).click()]);
    await linkedBrowserGroup.locator('summary').click();
    await Promise.all([worktreePage.waitForResponse(response=>new URL(response.url()).pathname==='/api/open-cmux-localhost'),linkedBrowserGroup.getByRole('button',{name:'cmux에서 열기',exact:true}).click()]);
    check('Local: 펼친 브라우저 실행 옵션에서 Orca 경로와 cmux 포트를 보존',previewOpens.length===2
      && previewOpens[0].path==='/api/open-orca-localhost'&&previewOpens[0].body.worktreePath===linkedPath
      && previewOpens[1].path==='/api/open-cmux-localhost'&&previewOpens[1].body.port===Number(new URL(browserOpens[2].url).port));

    // A slow 30-second background refresh must not unmount cards, collapse the
    // detail scrollport, or move an open browser action underneath the pointer.
    await worktreePage.getByTestId('worktree-refreshing').waitFor({state:'hidden'});
    await linkedBrowser.scrollIntoViewIfNeeded();
    await linkedBrowserGroup.locator('summary').click();
    await linkedBrowserGroup.locator('.workspace-tools-panel').evaluate(() =>
      new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const detailScrollport = worktreePage.locator('.workspace-project-detail');
    const priorScroll = await detailScrollport.evaluate(element=>({top:element.scrollTop,height:element.scrollHeight}));
    const retainedCards = await worktreePage.getByTestId('worktree-action-groups').elementHandles();
    const retainedMenu = await linkedBrowserGroup.locator('summary').elementHandle();
    await linkedBrowserGroup.locator('summary').focus();
    let refreshObserved = false;
    worktreeRefreshGate = new Promise(resolve=>{releaseWorktreeRefresh=resolve;});
    noteWorktreeRefresh=()=>{refreshObserved=true;};
    try {
      await worktreePage.clock.fastForward(30_000);
      await worktreePage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      check('Local: 실제 30초 background 워크트리 갱신을 지연',refreshObserved);
      const duringScroll = await detailScrollport.evaluate(element=>({top:element.scrollTop,height:element.scrollHeight}));
      check('Local: background 갱신 중 메인·브랜치 DOM과 상세 스크롤 유지',
        retainedCards.length===2 && (await Promise.all(retainedCards.map(handle=>handle.evaluate(element=>element.isConnected)))).every(Boolean)
          && priorScroll.top>0 && Math.abs(duringScroll.top-priorScroll.top)<=1
          && Math.abs(duringScroll.height-priorScroll.height)<=1,
        JSON.stringify({before:priorScroll,during:duringScroll}));
      check('Local: background 갱신 중 열린 브라우저 메뉴와 포커스 유지',
        await retainedMenu.evaluate(element=>element.isConnected&&element===document.activeElement&&element.parentElement.open)
          && await linkedBrowserGroup.getByRole('button',{name:'Orca에서 열기',exact:true}).isVisible()
          && await worktreePage.getByTestId('worktree-refreshing').isVisible());
      await Promise.all([worktreePage.waitForResponse(response=>new URL(response.url()).pathname==='/api/open-orca-localhost'),
        linkedBrowserGroup.getByRole('button',{name:'Orca에서 열기',exact:true}).click()]);
      check('Local: 지연 갱신 중 브라우저 메뉴가 원래 워크트리에서 실행',
        previewOpens.length===3&&previewOpens[2].body.worktreePath===linkedPath);
    } finally {
      releaseWorktreeRefresh();worktreeRefreshGate=null;
      await Promise.all(retainedCards.map(handle=>handle.dispose()));await retainedMenu?.dispose();
    }
    await worktreePage.getByTestId('worktree-refreshing').waitFor({state:'hidden'});
    check('Local: 지연 응답 완료 뒤에도 워크트리 카드 유지',await worktreePage.getByTestId('worktree-action-groups').count()===2);
    mkdirSync('output/playwright', {recursive:true});
    await worktreePage.locator(`[data-testid="worktree-action-groups"][data-worktree-path="${projectPath}"]`).scrollIntoViewIfNeeded();
    await worktreePage.screenshot({path:'output/playwright/workroom-project-actions-125.png'});
    const launches = [
      {launcher: worktreePage.getByTestId('detail-terminal-launcher'), targetId: projectId, agent: 'claude'},
      {launcher: worktreePage.locator(`[data-testid="worktree-action-groups"][data-worktree-path="${projectPath}"]`).getByTestId('worktree-terminal-launcher'), targetId: projectId, agent: 'codex'},
      {launcher: worktreePage.locator(`[data-testid="worktree-action-groups"][data-worktree-path="${linkedPath}"]`).getByTestId('worktree-terminal-launcher'), targetId: linkedTargetId, agent: 'hermes'},
    ];
    for (const [index, launch] of launches.entries()) {
      if (index) {
        await worktreePage.locator('#tab-ports').click();
        await row.click();
      }
      await launch.launcher.getByRole('combobox').selectOption(launch.agent);
      await launch.launcher.getByRole('button', {name: 'AI 터미널 열기', exact: true}).click();
      await worktreePage.getByTestId('ai-terminal-panel').waitFor({state: 'visible'});
      await worktreePage.getByRole('tab', {name: /실행 중/}).waitFor({state: 'visible'});
      check('Local: 선택한 AI와 정확한 프로젝트/워크트리로 한 번만 실행 ' + index,
        terminalStarts.length === index + 1 && terminalStarts[index].targetId === launch.targetId && terminalStarts[index].agent === launch.agent
        && await worktreePage.getByLabel('터미널 AI', {exact: true}).inputValue() === launch.agent
        && await worktreePage.getByRole('tab', {name: /실행 중/}).getAttribute('aria-selected') === 'true');
    }

    await worktreePage.locator('#tab-ports').click();
    await row.click();
    const tools = worktreePage.locator('[data-testid="project-main-actions"] > .workspace-tools');
    await tools.locator(':scope > summary').click();
    await worktreePage.getByTestId('terminal-app-internal').click();
    check('Local: 워크룸은 실행 옵션으로 저장되고 외부 옵션을 적용하지 않음',
      await worktreePage.evaluate(()=>localStorage.getItem('portmanager-terminalApp')) === 'internal'
      && await worktreePage.getByTestId('tmux-toggle').count() === 0 && await worktreePage.getByTestId('bypass-toggle').count() === 0);
    await tools.locator(':scope > summary').click();
    await worktreePage.getByTestId('detail-codex-run').click();
    await worktreePage.getByTestId('ai-terminal-panel').waitFor({state:'visible'});
    check('Local: 기존 AI 실행 버튼도 선택한 워크룸으로 실행',terminalStarts.length===4 && terminalStarts[3].agent==='codex' && terminalStarts[3].targetId===projectId);
    await worktreePage.screenshot({path:'output/playwright/workroom-session-125.png'});
    check('Local: 종료 저장 실패는 워크룸에서 이어서 확인 가능',await worktreePage.getByRole('button',{name:'워크룸에서 이어서 확인',exact:true}).isVisible());
    await worktreePage.getByRole('button',{name:'워크룸에서 이어서 확인',exact:true}).click();
    check('Local: 저장 실패 복구는 대상과 검토 요청을 전달하고 자동 실행하지 않음',
      (await worktreePage.getByLabel('터미널에 전달할 작업').inputValue()).includes('세션 기억 저장')&&terminalStarts.length===4);
  } finally {
    releaseWorktreeRefresh();
    await isolated.close();
  }
}

async function verifyIndeterminateConversationUi(browser) {
  const isolated = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await isolated.addInitScript(() => {
    localStorage.setItem('portmanager-setup-wizard-seen-v1', 'true');
    localStorage.setItem('folder-portal-migrated-v1', '1');
  });
  const protocolVersion = 'agentstoz-tasks-v2';
  const conversationProtocolVersion = 'agentstoz-conversations-v1';
  const unknownConversation = {
    protocolVersion: conversationProtocolVersion,
    conversationId: 'conversation_smoke_unknown',
    targetId: 'target_smoke_unknown',
    projectLabel: '응답 경계 확인 프로젝트',
    adapterId: 'codex',
    modelId: 'gpt-smoke',
    state: 'unknown',
    activeTurnId: null,
    revision: 4,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:01.000Z',
  };
  await isolated.route('**/api/agent-runtime/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = body => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    if (path.endsWith('/capabilities')) return json({
      protocolVersion,
      adapters: [{
        adapterId: 'codex',
        label: 'Codex',
        availability: 'unavailable',
        models: [],
        features: { structuredProgress: true, questions: false, approvals: false, cancellation: true },
      }],
      limits: { maxPromptBytes: 32_768, maxConcurrentTasks: 4 },
    });
    if (path.endsWith('/readiness')) return json({
      protocolVersion,
      schemaVersion: 3,
      kind: 'agent-runtime-readiness-diagnostic',
      platform: 'macos',
      state: 'blocked',
      authoritative: false,
      reusable: false,
      ready: false,
      gates: [
        { id: 'managed-execution-policy', status: 'blocked', reason: 'managed-execution-policy-closed' },
        { id: 'host-platform', status: 'passed', reason: 'platform-supported' },
        { id: 'codex-adapter', status: 'passed', reason: 'codex-adapter-verified' },
        { id: 'production-team-pin', status: 'blocked', reason: 'production-team-pin-unconfigured' },
        { id: 'embedded-broker-signing', status: 'blocked', reason: 'broker-helper-missing' },
        { id: 'smappservice-channel', status: 'pending', reason: 'smappservice-channel-awaits-installed-proof' },
        { id: 'dedicated-runtime-identity', status: 'pending', reason: 'dedicated-runtime-identity-not-implemented' },
        { id: 'detached-descendant-canary', status: 'pending', reason: 'detached-descendant-canary-not-implemented' },
        { id: 'runtime-supervisor', status: 'blocked', reason: 'runtime-supervisor-unavailable' },
      ],
    });
    if (path.endsWith('/targets')) return json({
      protocolVersion,
      targets: [{
        targetId: 'target_smoke_unknown',
        projectTargetId: 'target_smoke_unknown',
        label: '응답 경계 확인 프로젝트',
        scope: 'main',
        branch: 'main',
        locked: false,
        worktreeCapable: true,
      }],
      complete: true,
    });
    if (path.endsWith('/tasks')) return json({ protocolVersion, tasks: [] });
    if (path.endsWith('/conversations')) return json({
      protocolVersion: conversationProtocolVersion,
      conversations: [unknownConversation],
    });
    if (path.includes('/conversations/conversation_smoke_unknown/events')) {
      const after = Number(url.searchParams.get('after') ?? '0');
      return json({
        protocolVersion: conversationProtocolVersion,
        conversationId: unknownConversation.conversationId,
        after,
        nextCursor: after,
        events: [],
      });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  const page = await isolated.newPage();
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.getByTestId('top-level-runtime-tab').click();
    const runtimePanel = page.getByTestId('agent-runtime-panel');
    await runtimePanel.waitFor({ state: 'visible', timeout: 10_000 });
    await runtimePanel.getByRole('tab', { name: '대화', exact: true }).click();
    await runtimePanel.getByRole('button', { name: /^응답 경계 확인 프로젝트 Codex/ }).click();
    const unknownBoundary = runtimePanel.getByTestId('conversation-unknown-boundary');
    await unknownBoundary.waitFor({ state: 'visible', timeout: 10_000 });
    const composer = runtimePanel.getByRole('textbox', { name: '대화 지시', exact: true });
    const unknownText = ((await unknownBoundary.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    check(
      'Local: 불확실한 turn은 모바일 폭에서도 재전송 입력을 잠금',
      await composer.isDisabled()
        && unknownText.includes('자동 재실행을 중단했습니다.')
        && unknownText.includes('새 지시·보관·삭제는 잠겨'),
      unknownText,
    );
    // The 1280px app at 125% still needs a single-column conversation after its sidebar.
    // Selecting a conversation from the lower list must bring its content back into view.
    await page.setViewportSize({ width: 1280, height: 800 });
    await runtimePanel.getByRole('button', { name: /^응답 경계 확인 프로젝트 Codex/ }).click();
    await page.waitForFunction(() => {
      const main = document.querySelector('.runtime-conversation-main');
      const rect = main?.getBoundingClientRect();
      return rect && rect.top >= -1 && rect.top < window.innerHeight / 2;
    }, null, { timeout: 5000 });
    check('Local: 좁은 대화 영역에서 목록 선택 후 본문으로 돌아옴', true);
  } finally {
    await isolated.close();
  }
}

(async () => {
  console.log(`\n▶ Smoke test against ${TARGET} (${viewport.width}x${viewport.height})\n`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport, isMobile: isMobileViewport });
  const page = await ctx.newPage();
  // 이 스모크는 초기 설정 마법사가 아닌 일반 프로젝트 관리 화면을 검증한다.
  // 매번 새 브라우저 컨텍스트에서 wizard overlay가 뒤늦게 떠 UI 클릭을 가로막지 않게 한다.
  await page.addInitScript(() => localStorage.setItem('portmanager-setup-wizard-seen-v1', 'true'));

  try {
    if (isLocalFullApp) {
      // The mobile list needs one selectable project before testing its detail header.
      // Keep both reads and persistence in this browser fixture, independent of device data.
      if (isMobileViewport) {
        await page.route('**/api/ports', route => route.fulfill({
          json: route.request().method() === 'GET'
            ? [{ id: 'smoke-mobile-project', name: '모바일 UI 검증', folderPath: process.cwd() }]
            : { success: true },
        }));
        await page.route('**/api/ports/merge', route => route.fulfill({ json: { success: true } }));
      }
      // 새 프로젝트 옵션을 실제 생성 없이 검증한다. App은 GET으로 읽은 루트를 상태에
      // 반영한 직후 POST로 자동 저장하므로, 읽기만 mock하고 쓰기를 실제 API로 보내면
      // `smoke-root` fixture가 사용자의 workspace-roots.json을 오염시킨다.
      // smoke-workspace-roots:start
      await page.route('**/api/workspace-roots', async route => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([{ id: 'smoke-root', name: 'Smoke', path: process.cwd() }]),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true }),
          });
        }
      });
      // smoke-workspace-roots:end
      // 로컬이 원격보다 최신인 상태를 고정해 Push 안내를 결정적으로 검증한다.
      await page.route('**/api/project-memory/remote-status', async route => {
        const body = route.request().postDataJSON();
        if (body?.folderPath === process.cwd()) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              exists: true,
              revisionId: 'smoke-remote-revision',
              createdAt: '2000-01-01T00:00:00.000Z',
              contentHash: 'smoke-remote-content',
              inSync: false,
            }),
          });
        } else {
          await route.continue();
        }
      });
    }
    const res = await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 20000 });
    check('page loads 2xx/3xx', !!res && res.status() < 400, `status ${res?.status()}`);

    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // 가로 오버플로우 체크 — scrollWidth > clientWidth 면 UI 잘림
    if (isMobileViewport) {
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      check(
        `Mobile: 가로 오버플로우 없음 (scrollWidth ${overflow.scrollWidth} ≤ clientWidth ${overflow.clientWidth})`,
        overflow.scrollWidth <= overflow.clientWidth + 1, // 1px 여유
      );
    }
    const bodyText = await page.locator('body').innerText().catch(() => '');

    if (isPortalOnly) {
      // Feature copy itself contains "공유 북마크", so body text alone cannot
      // prove that the authenticated portal rendered. Require the current gate
      // controls or the portal's dedicated management heading.
      const surface = classifyPortalSmokeSurface({
        hasPasswordPrompt: bodyText.includes('비밀번호'),
        hasPasswordSubmit: await page.getByRole('button', { name: /입장/ }).count() > 0,
        hasGoogleIntro: bodyText.includes('흩어진 프로젝트를')
          && bodyText.includes('Supabase RLS'),
        hasGoogleLoginButton: await page.getByRole('button', { name: 'Google 계정으로 계속', exact: true }).count() > 0,
        hasAuthenticatedHeading: await page.getByRole('heading', {
          name: 'AgentsToZ 프로젝트 관리 포털',
          exact: true,
        }).count() === 1,
      });
      if (surface === 'password-gate') {
        check('Portal: 비밀번호 게이트 정상 렌더', true, '비밀번호 보호 활성');
        check('Portal: "프로젝트 추가" 버튼 없음 (포털 전용)',
          await page.getByRole('button', { name: /프로젝트 추가/ }).count() === 0);
      } else if (surface === 'google-gate') {
        check('Portal: Google 로그인 게이트 정상 렌더', true, 'Google OAuth 보호 활성');
        check('Portal: "프로젝트 추가" 버튼 없음 (포털 전용)',
          await page.getByRole('button', { name: /프로젝트 추가/ }).count() === 0);
      } else {
        check('Portal: 인증된 관리 화면 구조 노출', surface === 'authenticated-portal', surface);
        check('Portal: "프로젝트 추가" 버튼 없음 (포털 전용)',
          await page.getByRole('button', { name: /프로젝트 추가/ }).count() === 0);
      }
    } else if (isLocalFullApp) {
      const projectAdd = page.locator('[data-testid="header-new-project"]:visible, [data-testid="sidebar-new-project"]:visible');
      const addBtn = await projectAdd.count();
      check('Local: 프로젝트 추가 버튼 노출', addBtn > 0);
      const worktreeButtons = page.locator('button[data-help-key="card-worktree"]');
      if (await worktreeButtons.count() > 0) {
        const worktreePressedStates = await worktreeButtons.evaluateAll(buttons =>
          buttons.map(button => button.getAttribute('aria-pressed'))
        );
        check('Local: 워크트리 버튼 기본 ON',
          worktreePressedStates.includes('true'));
      }

      if (addBtn > 0) {
        await projectAdd.click();
        await page.waitForTimeout(500);
        check('Local: "기존 폴더 등록" 탭', await page.getByRole('button', { name: /기존 폴더 (연결|등록)/ }).count() > 0);
        check('Local: "새 폴더 만들기" 탭', await page.getByRole('button', { name: /새 폴더 만들기/ }).count() > 0);
        await page.getByRole('button', { name: /기존 폴더 (연결|등록)/ }).click();
        await page.getByLabel('폴더 경로').fill(process.cwd());
        const existingGitSelect = page.getByLabel('Git 저장소');
        await existingGitSelect.locator('option[value="keep"]').waitFor({ state: 'attached', timeout: 10000 });
        check('Local: 기존 Git 저장소 유지 선택지', await existingGitSelect.locator('option[value="keep"]').count() > 0);
        check('Local: Git 초기화 후 다시 만들기 선택지', await existingGitSelect.locator('option[value="reinitialize"]').count() > 0);
        const existingRunCheckbox = page.getByLabel('등록 후 프로젝트 실행');
        check('Local: 기존 프로젝트 등록 후 실행 기본 OFF (임의 실행 방지)', !(await existingRunCheckbox.isChecked()));
        check('Local: 기존 프로젝트 장기기억 자동 감지 UI', await page.getByText('프로젝트 장기기억', { exact: true }).count() > 0);
        const memorySyncStatus = page.getByTestId('project-memory-sync-status');
        const memorySyncText = (await memorySyncStatus.textContent().catch(() => '') || '').trim();
        check('Local: 장기기억 동기화 상태를 표시', memorySyncText.length > 0, memorySyncText);
        const memoryStateAnchor = page.locator(
          '[data-testid="project-memory-create-primary"], [data-testid="project-memory-restore-primary"], [data-testid="project-memory-id-copy"]',
        );
        check(
          'Local: 장기기억 상태에 맞는 생성·복원 또는 기존 기억 ID 제공',
          await memoryStateAnchor.count() === 1,
        );
        const memoryFeatureVersion = (await page.getByTestId('project-memory-feature-version').textContent().catch(() => '') || '').trim();
        check('Local: 장기기억 기능 버전 표시', /^v\d+$|^v\d+ → v\d+$/.test(memoryFeatureVersion), memoryFeatureVersion);
        await existingRunCheckbox.check();
        check('Local: 기존 프로젝트 실행 옵션 선택 가능', await existingRunCheckbox.isChecked());
        await page.getByRole('button', { name: /새 폴더 만들기/ }).click();
        await page.waitForTimeout(300);
        check('Local: 새 프로젝트 입력 UI 노출', await page.getByPlaceholder('my-project').count() > 0);

        const gitCheckbox = page.getByLabel('Git 저장소 만들기');
        const runCheckbox = page.getByLabel('생성 후 프로젝트 실행');
        const memoryCheckbox = page.getByLabel('처음부터 프로젝트 장기기억 사용');
        const memoryBackupCheckbox = page.getByLabel('Supabase 백업');
        check('Local: Git 저장소 만들기 기본 ON', await gitCheckbox.isChecked());
        check('Local: 생성 후 프로젝트 실행 기본 OFF (임의 실행 방지)', !(await runCheckbox.isChecked()));
        check('Local: 새 프로젝트 장기기억 기본 ON', await memoryCheckbox.isChecked());
        check('Local: 새 프로젝트 장기기억 Supabase 백업 기본 ON', await memoryBackupCheckbox.isChecked());
        await gitCheckbox.uncheck();
        await runCheckbox.check();
        check('Local: Git/실행 옵션 변경 가능',
          !(await gitCheckbox.isChecked()) && await runCheckbox.isChecked());
        await page.getByRole('button', { name: '취소', exact: true }).click();
      }

      if (isMobileViewport) await page.getByTestId('sidebar-project-row').first().click();

      // QR 원격제어는 저장된 확대 배율에서도 헤더·경고·켜기 동작이 viewport 밖으로
      // 밀리면 실제 사용자가 기능을 끌 수조차 없다. 소스 문자열 검사가 아니라 실제
      // 브라우저에서 100/125/150%를 순회해 dialog 외곽과 내부 스크롤 경계를 확인한다.
      const launchTools = page.locator('[data-testid="project-main-actions"] > .workspace-tools');
      const sidebarTools = page.locator('.workspace-sidebar-footer > .workspace-tools');
      const openTools = async tools => {
        if (!await tools.evaluate(element => element.open)) await tools.locator(':scope > summary').click();
      };
      const zoomReset = page.getByTestId('header-ui-zoom-reset');
      const zoomOut = page.getByTestId('header-ui-zoom-out');
      const zoomIn = page.getByTestId('header-ui-zoom-in');
      for (const zoomCase of [
        { label: '100%', steps: -5 },
        { label: '125%', steps: 0 },
        { label: '150%', steps: 5 },
      ]) {
        await openTools(launchTools);
        await zoomReset.click();
        const zoomButton = zoomCase.steps < 0 ? zoomOut : zoomIn;
        for (let step = 0; step < Math.abs(zoomCase.steps); step += 1) {
          await zoomButton.click();
        }
        const launchBounds = await launchTools.locator(':scope > .workspace-tools-panel').evaluate(panel => {
          const rect = panel.getBoundingClientRect();
          return rect.left >= -1 && rect.right <= window.innerWidth + 1
            && rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
        });
        check(`Local: 실행 도구 ${zoomCase.label} 메뉴가 화면 안에 표시`, launchBounds);
        // Clicking the trigger again must remain possible after the header wraps.
        await launchTools.locator(':scope > summary').click();
        check(`Local: 실행 도구 ${zoomCase.label} 버튼으로 다시 닫기`,
          !await launchTools.evaluate(element => element.open));
        await openTools(sidebarTools);
        await page.getByRole('button', { name: 'More options' }).click();
        await page.getByTestId('open-qr-remote-control').click();
        const qrDialog = page.getByTestId('qr-remote-control-dialog');
        await qrDialog.waitFor({ state: 'visible', timeout: 5000 });
        const availableQrAction = page.locator([
          '[data-testid="qr-remote-control-enable"]',
          '[data-testid="qr-remote-control-rotate"]',
        ].join(', '));
        await availableQrAction.waitFor({ state: 'visible', timeout: 5000 });
        const layout = await qrDialog.evaluate(dialog => {
          const rect = dialog.getBoundingClientRect();
          const scrollingBody = dialog.querySelector('.overflow-y-auto');
          const close = dialog.querySelector('[data-testid="qr-remote-control-close"]');
          const primaryAction = dialog.querySelector([
            '[data-testid="qr-remote-control-enable"]',
            '[data-testid="qr-remote-control-rotate"]',
          ].join(', '));
          const visible = element => {
            if (!(element instanceof HTMLElement)) return false;
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0
              && box.right > 0 && box.bottom > 0
              && box.left < window.innerWidth && box.top < window.innerHeight;
          };
          return {
            insideViewport: rect.left >= -1 && rect.top >= -1
              && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1,
            boundedHeight: rect.height <= window.innerHeight * 0.91,
            scrollContained: scrollingBody instanceof HTMLElement
              && getComputedStyle(scrollingBody).overflowY === 'auto',
            controlsVisible: visible(close) && visible(primaryAction),
          };
        });
        check(
          `Local: QR 원격제어 ${zoomCase.label} 확대 레이아웃`,
          Object.values(layout).every(Boolean),
          JSON.stringify(layout),
        );
        await page.getByTestId('qr-remote-control-close').click();
      }
      await openTools(launchTools);
      await zoomReset.click();
      await launchTools.locator(':scope > summary').click();

      // 실제 최상위 Runtime → 대화 흐름을 연다. 소스 개발 앱에서는 실제
      // workspace-write와 로컬 full-access 테스트가 가능해야 하지만 그 권한이
      // 배포본이나 모바일 원격으로 확장된다고 오해할 수 없어야 한다.
      await page.getByTestId('top-level-runtime-tab').click();
      const runtimePanel = page.getByTestId('agent-runtime-panel');
      await runtimePanel.waitFor({ state: 'visible', timeout: 10_000 });
      const runtimeTasksTab = runtimePanel.getByRole('tab', { name: '작업', exact: true });
      const runtimeConversationsTab = runtimePanel.getByRole('tab', { name: '대화', exact: true });
      await runtimeTasksTab.click();
      const dangerousModeToggle = runtimePanel.getByRole('checkbox', {
        name: /dangerously-bypass-approvals-and-sandbox/,
      });
      await dangerousModeToggle.waitFor({ state: 'visible', timeout: 10_000 });
      let dangerousModeEnabled = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await dangerousModeToggle.isEnabled()) {
          dangerousModeEnabled = true;
          break;
        }
        await page.waitForTimeout(100);
      }
      check(
        'Local: 개발 런타임은 열고 배포·원격 full-access 경계를 표시',
        await runtimePanel.getByText('로컬 개발 테스트 모드 · 파일 수정과 전체 접근 실행 허용', { exact: true }).count() === 1
          && await runtimePanel.getByText('모바일 원격 테스트는 workspace-write만 허용', { exact: false }).count() === 1
          && (dangerousModeEnabled || (await runtimePanel.getByRole('combobox', { name: '모델', exact: true }).inputValue() === ''
            && await dangerousModeToggle.isDisabled())),
      );
      await runtimeTasksTab.focus();
      await runtimeTasksTab.press('ArrowRight');
      check(
        'Local: 런타임 작업·대화 탭을 키보드로 전환',
        await runtimeConversationsTab.getAttribute('aria-selected') === 'true'
          && await runtimeConversationsTab.getAttribute('tabindex') === '0',
      );
      const conversationView = runtimePanel.getByTestId('agent-runtime-conversation-view');
      await conversationView.waitFor({ state: 'visible', timeout: 10_000 });
      // VOC: compact, collapsible composer must retain the unsent draft at
      // saved high zoom and a small desktop window. No provider call is made.
      const composer = conversationView.getByTestId('conversation-composer-disclosure');
      const prompt = composer.getByRole('textbox', { name: '대화 지시' });
      await prompt.fill('VOC composer draft — do not send');
      for (const steps of [-5, 0, 5]) {
        await page.locator('[data-top-level-tab="ports"]').click();
        await openTools(launchTools);
        await zoomReset.click();
        for (let step = 0; step < Math.abs(steps); step += 1) {
          await (steps < 0 ? zoomOut : zoomIn).click();
        }
        await page.getByTestId('top-level-runtime-tab').click();
        await page.setViewportSize({ width: 900, height: 800 });
        await prompt.fill('VOC composer draft — do not send');
        const expanded = await composer.boundingBox();
        await composer.locator(':scope > summary').click();
        const collapsed = await composer.boundingBox();
        const collapseResult = {
          closed: !await composer.evaluate(element => element.open),
          compact: collapsed.height < expanded.height / 2,
          fits: collapsed.width <= 900,
          draftRetained: await composer.locator('textarea').inputValue() === 'VOC composer draft — do not send',
        };
        check(`Local: 대화 입력 접기·초안 보존 ${125 + steps * 5}%`,
          Object.values(collapseResult).every(Boolean), JSON.stringify(collapseResult));
        await composer.locator(':scope > summary').click();
        check(`Local: 대화 입력 다시 펼치기 ${125 + steps * 5}%`,
          await prompt.isVisible() && await prompt.inputValue() === 'VOC composer draft — do not send');
      }
      await prompt.fill('');
      await page.setViewportSize(viewport);
      await page.locator('[data-top-level-tab="ports"]').click();
      await openTools(launchTools);
      await zoomReset.click();
      await page.getByTestId('top-level-runtime-tab').click();
      const surfaceBoundary = conversationView.getByTestId('conversation-surface-boundary');
      const surfaceText = ((await surfaceBoundary.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      check(
        'Local: 앱형 대화를 기본, 외부 터미널을 보조 surface로 렌더',
        surfaceText.includes('AgentsToZ 앱 대화 · 기본')
          && surfaceText.includes('cmux · Orca · iTerm · Terminal · 보조')
          && surfaceText.includes('현재는 독립 CLI 실행입니다'),
        surfaceText,
      );

      // 실제 Git 정본을 mock한 별도 브라우저 컨텍스트에서 사이드바 숫자 → 프로젝트
      // 선택 → 패널 토글 → 정확한 브랜치/경로까지 한 흐름으로 검증한다. 소스 문자열이나
      // 계산 함수만 통과하고 사용자가 목록을 못 보는 회귀는 smoke를 통과할 수 없다.
      await verifyCurrentGitWorktreeUi(browser);
      await verifyIndeterminateConversationUi(browser);

      // api-server health
      try {
        const apiRes = await page.request.get(`${API_BASE}/api/health`);
        const health = await apiRes.json().catch(() => null);
        const capabilities = new Set(health?.capabilities || []);
        const missing = contextApiContract.requiredCapabilities
          .filter(capability => !capabilities.has(capability));
        const healthy = apiRes.status() === 200
          && health?.service === 'agentstoz-api'
          && health?.schemaVersion >= contextApiContract.schemaVersion
          && missing.length === 0;
        check(
          `Local: api-server :${API_PORT} schema/capability 계약`,
          healthy,
          healthy ? `schema ${health.schemaVersion}` : `missing ${missing.join(', ') || 'valid health'}`,
        );
      } catch (error) {
        check(
          `Local: api-server :${API_PORT} schema/capability 계약`,
          false,
          error instanceof Error ? error.message : 'api-server not running',
        );
      }
      try {
        const checkpointRes = await page.request.get(`${API_BASE}/api/project-memory/auto-checkpoint/status`);
        const checkpoint = await checkpointRes.json().catch(() => null);
        const contractValid = checkpointRes.status() === 200
          && checkpoint?.schemaVersion === 1
          && typeof checkpoint?.settings?.enabled === 'boolean'
          && JSON.stringify(checkpoint?.settings?.thresholds) === JSON.stringify([50, 75, 90])
          && Array.isArray(checkpoint?.sessions);
        check(
          'Local: Codex 프로젝트 기억 자동 체크포인트 API 계약',
          contractValid,
          contractValid
            ? `enabled=${checkpoint.settings.enabled}, thresholds=${checkpoint.settings.thresholds.join('/')}`
            : `status=${checkpointRes.status()}, body=${JSON.stringify(checkpoint)}`,
        );
      } catch (error) {
        check(
          'Local: Codex 프로젝트 기억 자동 체크포인트 API 계약',
          false,
          error instanceof Error ? error.message : 'auto-checkpoint endpoint unavailable',
        );
      }
    } else {
      check(`unknown target ${TARGET}`, true, 'skipping mode-specific checks');
    }
  } catch (e) {
    if (process.env.SMOKE_SCREENSHOT_PATH) {
      await page.screenshot({ path: process.env.SMOKE_SCREENSHOT_PATH }).catch(() => {});
    }
    check('no exceptions during smoke', false, e.message);
  } finally {
    await browser.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\nResult: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('Failed:');
    failed.forEach(f => console.log(`  - ${f.name} (${f.detail})`));
    process.exit(1);
  }
})();
