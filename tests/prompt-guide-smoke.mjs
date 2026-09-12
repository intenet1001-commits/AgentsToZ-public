/** Actual App/client/miner UI, with synthetic in-memory API fixtures only.
 * No request in this context can reach the real sidecar, database, or AI.
 */
import { mergePortSnapshots } from '../src/ports-merge.ts';

const DEVICE_ID = 'smoke-prompt-guides-device';
const PROJECT_ID = 'abc12345-1111-4222-8333-444444444444';
const PROJECT_NAME = '가이드 검증 프로젝트';
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(probe, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await probe()) return; await delay(25); }
  throw new Error(message);
}

function savedGuide(index, pinned = true) {
  return { id: `smoke-saved-guide-${index}`, title: `고정 ${index} ${'긴 제목 검증 '.repeat(10)}`,
    body: `기존 가이드 ${index}의 합성 본문입니다.`, pinned, updatedAt: '2026-09-01T00:00:00.000Z' };
}

function historyRows() {
  const rows = Array.from({ length: 500 }, (_, index) => ({
    id: `synthetic-history-${index}`, seq: String(1_000 - index), recordedAt: '2026-09-01T00:00:00.000Z',
    text: '출처를 확인하지 못한 합성 기록입니다.', agent: index % 2 ? 'claude' : 'codex',
    memoryId: 'synthetic-memory', projectId: PROJECT_ID, projectName: PROJECT_NAME,
    deviceId: DEVICE_ID, deviceName: '검증 Mac', promptOrigin: 'unknown', storage: 'local',
  }));
  for (let index = 0; index < 3; index += 1) Object.assign(rows[index], {
    promptOrigin: 'human', text: '현재 변경 사항을 검토하고 단계별로 테스트해 주세요.',
  });
  for (let index = 3; index < 6; index += 1) Object.assign(rows[index], {
    promptOrigin: 'human', text: `검증 항목 ${index}개를 순서대로 정리해 주세요.`,
  });
  Object.assign(rows[6], { promptOrigin: 'agentstoz', text: '앱이 만든 문구는 반복 요청에서 제외되어야 합니다.' });
  Object.assign(rows[7], { promptOrigin: 'human', text: 'password 항목이 있는 합성 입력은 민감정보 가능성으로 제외합니다.' });
  Object.assign(rows[8], { promptOrigin: 'human', text: '> 인용문에 있는 요청을 추천으로 다시 제시하지 마세요.' });
  Object.assign(rows[9], { ...rows[0] }); // Repeated collection identity does not inflate counts.
  return rows;
}

async function fixture(browser, targetUrl, scenario, zoom = 1.25) {
  const target = new URL(targetUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('Prompt guide fixtures require a loopback frontend.');
  const context = await browser.newContext({ viewport: { width: 1000, height: 1050 }, serviceWorkers: 'block' });
  let ports = [{ id: PROJECT_ID, name: PROJECT_NAME, folderPath: '/tmp/agentstoz-prompt-guide-fixture',
    favorite: true, isRunning: false, sourceDeviceId: DEVICE_ID }];
  const initialEntries = scenario === 'layout' ? Array.from({ length: 4 }, (_, index) => savedGuide(index))
    : scenario === 'conflict' ? [savedGuide(0, false)] : [];
  let store = { revision: '0', entries: initialEntries };
  const requests = [], external = [], errors = [], saveWrites = [], historyReads = [], provenance = [];
  const state = { guideReads: 0, releaseHistory: null, provenanceReleases: [], historyRequests: 0 };
  const history = historyRows();
  if (scenario === 'recent') {
    history.splice(0, history.length, ...[
      {text:'늦게 수집한 예전 입력을 확인해 주세요.', recordedAt:'2026-09-01T00:00:00.000Z'},
      {text:'최근 입력을 확인하고 원인을 개선해 주세요.', recordedAt:'2026-09-09T01:00:00.000Z'},
      {text:'<task-notification>Background command completed</task-notification>'},
      {text:'진행해'}, {text:'진행해'},
    ].map((value, index) => ({...historyRows()[0], id:'recent-'+index, seq:String(100-index), ...value})));
  }
  const safety = { localOnlyDeletedPortIds: [], remoteDeletedPortIds: [], verifiedLegacyGeneratedWorktreeIds: [] };
  const portal = { ...safety, deviceId: DEVICE_ID, deviceName: '가이드 검증 전용 Mac', items: [], categories: [] };
  await context.addInitScript(({ zoom }) => {
    localStorage.setItem('portmanager-setup-wizard-seen-v1', 'true');
    localStorage.setItem('folder-portal-migrated-v1', '1');
    localStorage.setItem('portmanager-ui-zoom', String(zoom));
    window.__promptGuideSmokeClipboard = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.__promptGuideSmokeClipboard.push(text); },
    } });
  }, { zoom });
  // HMR and every other WebSocket are unnecessary for a fixed fixture run.
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json',
      headers: { 'cache-control': 'no-store' }, body: JSON.stringify(value) });
    if (path.startsWith('/api/')) {
      let body; try { body = request.postDataJSON(); } catch { body = null; }
      requests.push({ path, method: request.method() });
      if (path === '/api/what-i-said/guides/list') { state.guideReads += 1; return json({ success: true, ...clone(store) }); }
      if (path === '/api/what-i-said/guides/save') {
        saveWrites.push(clone(body));
        if (scenario === 'conflict' && saveWrites.length === 1) {
          store = { revision: 'changed-elsewhere', entries: [{ ...store.entries[0], body: '다른 창에서 저장한 합성 본문', updatedAt: '2026-09-02T00:00:00.000Z' }] };
          return json({ code: 'PROMPT_GUIDES_CONFLICT', error: '합성 저장 충돌' }, 409);
        }
        if (body.expectedRevision !== store.revision) return json({ code: 'PROMPT_GUIDES_CONFLICT', error: '합성 저장 충돌' }, 409);
        store = { revision: `saved-${saveWrites.length}`, entries: clone(body.entries) };
        if (scenario === 'bad-receipt' && saveWrites.length === 1) {
          return json({ success: true, revision: store.revision, entries: [] });
        }
        if (scenario === 'malformed-receipt' && saveWrites.length === 1) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{synthetic invalid JSON' });
        }
        if (scenario === 'lost-receipt' && saveWrites.length === 1) return route.abort('failed');
        return json({ success: true, ...clone(store) });
      }
      if (path === '/api/what-i-said/list') {
        historyReads.push(clone(body)); state.historyRequests += 1;
        if (scenario === 'cancel' && historyReads.length === 1) {
          await new Promise(resolve => { state.releaseHistory = resolve; }); state.releaseHistory = null;
          // The browser may already have aborted the intercepted request.
          await json({ success: true, items: history.slice(0, 100), source: 'local', hasMore: true, nextBeforeSeq: '100', scan: null }).catch(() => {});
          return;
        }
        if (scenario === 'invalid-history') return json({ success: true, source: 'local', hasMore: false, nextBeforeSeq: null });
        const index = body.beforeSeq ? Number(body.beforeSeq) / 100 : 0;
        const source = scenario === 'changed-source' && index > 0 ? 'supabase' : 'local';
        return json({ success: true, items: history.slice(index * 100, (index + 1) * 100), source,
          hasMore: !['cancel','recent'].includes(scenario), nextBeforeSeq: ['cancel','recent'].includes(scenario) ? null : String((index + 1) * 100),
          scan: { complete: false, unreadable: 2, withheld: 1 } });
      }
      if (path === '/api/what-i-said/prompt-origin/register') {
        provenance.push(clone(body));
        if (scenario === 'crud') await new Promise(resolve => { state.provenanceReleases.push(resolve); });
        await json({ success: true }).catch(() => {}); return;
      }
      if (path === '/api/ports') return request.method() === 'GET' ? json(clone(ports)) : json({ error: 'Fixture rejects legacy writes.' }, 409);
      if (path === '/api/ports/merge') { ports = mergePortSnapshots(body.basePorts ?? [], body.ports ?? [], ports); return json({ success: true }); }
      if (path.startsWith('/api/supabase-proxy/')) return json({ error: 'Fixture forbids Supabase.' }, 403);
      if (path === '/api/portal') return json(portal);
      if (path === '/api/portal/safety-lease/acquire') return json({ success: true, token: 'd'.repeat(64), metadata: safety, fingerprint: '[[],[],[]]', expiresInMs: 30_000 });
      if (path === '/api/portal/safety-lease/renew') return json({ success: true, renewed: true, expiresInMs: 30_000 });
      if (path === '/api/portal/safety-lease/release') return json({ success: true, released: true });
      if (path === '/api/workspace-roots') return json(request.method() === 'GET' ? [] : { success: true });
      if (path === '/api/discover-registered-git-worktrees') return json({ success: true, families: [], registeredProjectIds: ports.map(row => row.id), nextCursor: null, truncated: false });
      if (path === '/api/list-git-worktrees') return json({ success: true, worktrees: [] });
      if (path === '/api/project-memory/memory-ids') return json({ memoryIds: {} });
      if (path === '/api/project-memory/detect') return json({ exists: false, projectRoot: body?.folderPath ?? '', memoryPath: null, sourcePath: null, kind: 'none', size: 0, modifiedAt: null, contentHash: null, config: null,
        adapters: { claude: false, codex: false }, memoryAgent: { installedVersion: 0, currentVersion: 20, updateAvailable: false },
        activity: { needsRemember: false, reasons: [], currentFingerprint: null, lastRememberedFingerprint: null, lastActivityAt: null, lastRememberedAt: null, lastAgent: null, worktreeCount: 0, hooks: { claude: false, codex: false } } });
      if (path === '/api/project-memory/hermes-adapter') return json({ hermesPresent: false, hermesCliPath: null, available: [], installed: [], updateAvailable: false });
      if (path === '/api/check-ports-batch') return json({ success: true, results: [] });
      if (path === '/api/browser-profiles') return json({ success: true, profiles: [] });
      if (path === '/api/last-visits' || path === '/api/last-git-activity') return json({});
      if (path === '/api/agent-runtime/targets') return json({ protocolVersion: 'agentstoz-tasks-v2', targets: [], complete: true });
      if (path === '/api/agent-runtime/capabilities') return json({ protocolVersion: 'agentstoz-tasks-v2', adapters: [], limits: { maxPromptBytes: 32_768, maxConcurrentTasks: 4 } });
      if (path === '/api/agent-runtime/tasks') return json({ protocolVersion: 'agentstoz-tasks-v2', tasks: [] });
      if (path === '/api/agent-runtime/conversations') return json({ protocolVersion: 'agentstoz-conversations-v1', conversations: [] });
      if (path === '/api/agent-runtime/terminals') return json({ sessions: [] });
      if (path === '/api/agent-runtime/terminals/access') return json({ connections: [] });
      if (path === '/api/agent-runtime/terminals/memory') return json({ jobs: [], total: 0, unresolved: 0, nextOffset: null });
      return json({ success: true, results: [] });
    }
    if (url.origin !== target.origin || request.method() !== 'GET') { external.push(`${request.method()} ${url.origin}${path}`); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.getByTestId('prompt-guide-open').waitFor({ state: 'visible', timeout: 15_000 });
    await eventually(() => state.guideReads === 1, 'Guide store was not read exactly once.');
  } catch (error) { await context.close(); throw error; }
  return { context, page, requests, external, errors, saveWrites, historyReads, provenance, state,
    store: () => clone(store), clipboard: () => page.evaluate(() => window.__promptGuideSmokeClipboard) };
}

async function open(test) {
  await test.page.getByTestId('prompt-guide-open').click();
  await test.page.getByTestId('prompt-guide-dialog').waitFor({ state: 'visible' });
}
async function fill(test, title, body) {
  await test.page.getByTestId('prompt-guide-title').fill(title);
  await test.page.getByTestId('prompt-guide-body').fill(body);
}
async function fits(page, testId) {
  return page.getByTestId(testId).evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const root = document.documentElement;
    const controls = [...element.querySelectorAll('button,input,textarea')].filter(control => control.getClientRects().length);
    return { okay: bounds.left >= -1 && bounds.right <= window.innerWidth + 1
      && bounds.top >= -1 && bounds.bottom <= window.innerHeight + 1
      && element.scrollWidth <= element.clientWidth + 1 && root.scrollWidth <= root.clientWidth + 1
      && controls.every(control => { const rect = control.getBoundingClientRect(); return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1; }),
      bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
      overflow: element.scrollWidth - element.clientWidth, documentOverflow: root.scrollWidth - root.clientWidth };
  });
}

export async function verifyPromptGuideUi(browser, targetUrl, check) {
  const scenarios = [['layout', 1], ['layout', 1.25], ['crud', 1.25], ['conflict', 1.25],
    ['bad-receipt', 1.25], ['malformed-receipt', 1.25], ['lost-receipt', 1.25],
    ['analysis', 1.25], ['recent', 1.25], ['cancel', 1.25], ['invalid-history', 1.25], ['changed-source', 1.25]];
  for (const [scenario, zoom] of scenarios) {
    let test;
    try {
      test = await fixture(browser, targetUrl, scenario, zoom);
      const { page } = test;
      check(`Local: 가이드 ${scenario} ${zoom * 100}% 열기만으로 원문 분석·저장하지 않음`,
        test.saveWrites.length === 0 && test.historyReads.length === 0 && test.state.guideReads === 1);
      if (scenario === 'layout') {
        await page.getByTestId('prompt-guide-pinned-copy').first().waitFor({ state: 'visible' });
        const toolbar = await fits(page, 'prompt-guide-bar');
        check(`Local: 가이드 ${zoom * 100}% 긴 고정 제목 4개도 상단 영역에 맞고 더보기 제공`,
          toolbar.okay && await page.getByTestId('prompt-guide-pinned-copy').count() === 3
          && await page.getByTestId('prompt-guide-more').textContent() === '+1', JSON.stringify(toolbar));
        await open(test);
        const dialog = await fits(page, 'prompt-guide-dialog');
        check(`Local: 가이드 ${zoom * 100}% 기본 창에서 대화상자·입력·버튼 가로 넘침 없음`, dialog.okay, JSON.stringify(dialog));
        await page.getByTestId('prompt-guide-close').click();
        await page.locator(`[data-testid="sidebar-project-row"][data-project-id="${PROJECT_ID}"]`).click();
        await page.getByTestId('meta-copy-project-name-code').click();
        check(`Local: 프로젝트명+해시 ${zoom * 100}% 버튼은 한 줄로 복사`,
          (await test.clipboard()).at(-1) === `#${PROJECT_NAME} [로컬프로젝트해시: ABC12345]`);
      } else if (scenario === 'crud') {
        await open(test);
        await fill(test, '합성 검토 가이드', '변경 사항을 순서대로 검토해 주세요.\n테스트 결과도 함께 알려 주세요.');
        await page.getByTestId('prompt-guide-pin').check();
        check('Local: 가이드 초안 입력·고정만으로 저장하지 않음', test.saveWrites.length === 0 && test.store().entries.length === 0);
        await page.getByTestId('prompt-guide-save').click();
        await eventually(() => test.store().entries.length === 1, 'Guide create was not saved.');
        await page.getByTestId('prompt-guide-delete').waitFor({ state: 'visible' });
        const created = test.store().entries[0];
        await page.getByTestId('prompt-guide-close').click();
        await page.getByTestId('prompt-guide-pinned-copy').click();
        await page.getByTestId('prompt-guide-pinned-copy').click();
        check('Local: 출처 등록이 멈춰도 상단 가이드 복사를 연속 완료',
          equal(await test.clipboard(), [created.body, created.body]) && test.provenance.length === 1);
        check('Local: 상단 복사 성공을 눈에 보이는 버튼 문구로 표시', await page.getByTestId('prompt-guide-pinned-copy').textContent() === '복사됨 ✓');
        for (const release of test.state.provenanceReleases.splice(0)) release();
        await delay(40);
        for (const release of test.state.provenanceReleases.splice(0)) release();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByTestId('prompt-guide-pinned-copy').waitFor({ state: 'visible' });
        await open(test);
        await page.getByTestId('prompt-guide-edit').click();
        check('Local: 가이드 저장·상단 고정은 새로고침 후 API 저장본으로 복원',
          await page.getByTestId('prompt-guide-body').inputValue() === created.body
          && await page.getByTestId('prompt-guide-pin').isChecked());
        await fill(test, '수정한 합성 가이드', '수정한 합성 본문을 확인해 주세요.');
        await page.getByTestId('prompt-guide-pin').uncheck();
        await page.getByTestId('prompt-guide-save').click();
        await eventually(() => test.store().entries[0]?.title === '수정한 합성 가이드', 'Guide edit was not persisted.');
        await eventually(async () => await page.getByTestId('prompt-guide-delete').isEnabled(), 'Guide edit receipt did not unlock UI.');
        await page.getByTestId('prompt-guide-delete').click();
        await page.getByTestId('prompt-guide-cancel-delete').click();
        check('Local: 가이드 삭제 취소는 저장본 보존', test.store().entries.length === 1 && test.saveWrites.length === 2);
        await page.getByTestId('prompt-guide-delete').click();
        await page.getByTestId('prompt-guide-confirm-delete').click();
        await eventually(() => test.store().entries.length === 0, 'Guide delete was not persisted.');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await open(test);
        check('Local: 가이드 수정·고정 해제·명시적 삭제 후 재조회에도 삭제 유지',
          await page.getByTestId('prompt-guide-edit').count() === 0
          && await page.getByTestId('prompt-guide-pinned-copy').count() === 0 && test.saveWrites.length === 3);
      } else if (['conflict', 'bad-receipt', 'malformed-receipt', 'lost-receipt'].includes(scenario)) {
        await open(test);
        if (scenario === 'conflict') await page.getByTestId('prompt-guide-edit').click();
        await fill(test, '보존해야 할 제목', '사용자가 작성하던 합성 초안');
        await page.getByTestId('prompt-guide-save').click();
        await page.getByTestId('prompt-guide-action-error').waitFor({ state: 'visible' });
        check(`Local: 가이드 ${scenario} 저장 문제는 성공으로 처리하지 않고 초안·재조회 게이트 보존`,
          await page.getByTestId('prompt-guide-body').inputValue() === '사용자가 작성하던 합성 초안'
          && await page.getByTestId('prompt-guide-save').isDisabled() && test.saveWrites.length === 1);
        await page.getByTestId('prompt-guide-reload').click();
        await eventually(() => test.state.guideReads === 2, 'Conflict recovery did not read the store again.');
        if (scenario === 'conflict') {
          await page.getByTestId('prompt-guide-conflict').waitFor({ state: 'visible' });
          await page.getByTestId('prompt-guide-conflict').locator('summary').click();
          check('Local: 재조회 충돌 비교는 다른 창 저장본과 사용자 초안을 함께 보존',
            await page.getByTestId('prompt-guide-conflict').getByText('다른 창에서 저장한 합성 본문', { exact: true }).isVisible()
            && await page.getByTestId('prompt-guide-body').inputValue() === '사용자가 작성하던 합성 초안'
            && await page.getByTestId('prompt-guide-save').isDisabled() && test.saveWrites.length === 1);
        } else {
          await eventually(async () => await page.getByTestId('prompt-guide-save').isEnabled(), 'Receipt recovery did not unlock an identical saved guide.');
          if (scenario === 'bad-receipt') {
            // Saved A survives a broken receipt while NEW_DRAFT still holds A.
            // Editing the recovered saved row creates a separate dirty B. The
            // idempotent A confirmation must not overwrite that distinct B.
            await page.getByTestId('prompt-guide-edit').click();
            await fill(test, '별도로 편집한 제목 B', '별도로 편집한 합성 초안 B');
            await page.getByRole('button', { name: '새 가이드 초안', exact: true }).click();
            check('Local: 불명확한 A 저장 뒤 별도 B 편집과 새 가이드 A 초안을 각각 유지',
              await page.getByTestId('prompt-guide-body').inputValue() === '사용자가 작성하던 합성 초안');
          }
          await page.getByTestId('prompt-guide-save').click();
          check(`Local: ${scenario} 재조회에서 같은 저장본을 확인하면 중복 가이드를 만들지 않음`,
            test.store().entries.length === 1 && test.saveWrites.length === 1
            && await page.getByTestId('prompt-guide-body').inputValue() === (scenario === 'bad-receipt' ? '별도로 편집한 합성 초안 B' : '사용자가 작성하던 합성 초안'));
          if (scenario === 'bad-receipt') check('Local: A의 alreadySavedNew 확인은 별도 dirty B 초안을 덮어쓰지 않음',
            await page.getByTestId('prompt-guide-title').inputValue() === '별도로 편집한 제목 B'
            && test.store().entries[0].body === '사용자가 작성하던 합성 초안' && test.saveWrites.length === 1);
        }
      } else {
        await open(test);
        await page.getByTestId('prompt-guide-suggestions-load').click();
        if (scenario === 'cancel') {
          await eventually(() => test.state.releaseHistory !== null, 'History request was not held.');
          await page.getByTestId('prompt-guide-close').click();
          test.state.releaseHistory();
          await delay(100);
          await open(test);
          check('Local: 추천 조회 중 닫기는 후속 페이지·늦은 결과 표시를 취소',
            test.historyReads.length === 1 && await page.getByTestId('prompt-guide-suggestion-use').count() === 0
            && await page.getByTestId('prompt-guide-suggestions-load').isEnabled() && test.saveWrites.length === 0);
          await page.getByTestId('prompt-guide-suggestions-load').click();
          await page.getByTestId('prompt-guide-sample-scope').waitFor({ state: 'visible' });
          check('Local: 취소한 추천을 다시 요청하면 새로운 표본으로 완료', test.historyReads.length === 2);
        } else if (scenario === 'recent') {
          await page.getByTestId('prompt-guide-recent-list').waitFor({state:'visible'});
          const recent = page.getByTestId('prompt-guide-recent-use');
          check('Local: 반복되지 않은 최근 입력을 시각순으로 표시하고 시스템 알림은 제외',
            await recent.count() === 2 && await page.getByTestId('prompt-guide-suggestion-use').count() === 0
            && (await page.getByTestId('prompt-guide-recent-list').innerText()).indexOf('최근 입력을') < (await page.getByTestId('prompt-guide-recent-list').innerText()).indexOf('예전 입력을')
            && !(await page.getByTestId('prompt-guide-dialog').innerText()).includes('<task-notification>'));
          await recent.first().click();
          check('Local: 최근 입력은 수정 가능한 새 초안으로만 가져오며 자동 저장하지 않음',
            await page.getByTestId('prompt-guide-body').inputValue() === '최근 입력을 확인하고 원인을 개선해 주세요.' && test.saveWrites.length === 0);
          await page.getByTestId('prompt-guide-include-short').check();
          check('Local: 짧은 지시 옵션 변경은 이전 결과를 비우고 조회 전 새 기록 요청 없음', test.historyReads.length === 1 && await recent.count() === 0);
          await page.getByTestId('prompt-guide-suggestions-refresh').click();
          await page.getByTestId('prompt-guide-recent-list').waitFor({state:'visible'});
          check('Local: 짧은 지시를 포함한 재조회는 실제 반복과 새 조회시각을 표시', test.historyReads.length === 2
            && await recent.count() === 3 && await page.getByTestId('prompt-guide-suggestion-use').count() === 1
            && await page.getByTestId('prompt-guide-analysis-time').isVisible());
          await recent.last().click();
          check('Local: 최근 입력을 다시 골라도 작성 중인 초안은 덮어쓰지 않음',
            await page.getByTestId('prompt-guide-body').inputValue() === '최근 입력을 확인하고 원인을 개선해 주세요.' && test.saveWrites.length === 0);
          check('Local: 최근 입력을 표시한 가이드도 고배율 창에서 넘침 없음', (await fits(page,'prompt-guide-dialog')).okay);
        } else if (scenario === 'analysis') {
          await page.getByTestId('prompt-guide-sample-scope').waitFor({ state: 'visible' });
          const scope = await page.getByTestId('prompt-guide-sample-scope').textContent();
          const suggestions = page.getByTestId('prompt-guide-suggestion-use');
          const bodies = await suggestions.locator('..').locator('..').locator(':scope > p').allTextContents();
          check('Local: 추천은 human 조건으로 100개씩 5페이지·500개까지만 조회하고 범위·누락 표시',
            test.historyReads.length === 5 && test.historyReads.every((body, index) => body.origin === 'human' && body.limit === 100
              && (index === 0 ? !Object.hasOwn(body, 'beforeSeq') : body.beforeSeq === String(index * 100)))
            && /500개 조회/.test(scope) && /표본 밖/.test(scope) && /일부 기록/.test(scope));
          check('Local: 실제 miner가 반복 3회와 숫자 패턴 3회를 찾고 앱·민감·인용·중복을 제외',
            await suggestions.count() === 2 && bodies.includes('현재 변경 사항을 검토하고 단계별로 테스트해 주세요.')
            && bodies.includes('검증 항목 {숫자}개를 순서대로 정리해 주세요.')
            && await page.getByTestId('prompt-guide-dialog').getByText(/실제 분석 6개 · 제외 494개 · 추천 2개/).isVisible());
          await page.getByTestId('prompt-guide-dialog').getByText('제외한 기록 기준', { exact: true }).click();
          check('Local: 제외 사유를 표시하고 후보 선택 전후에도 자동 저장하지 않음',
            await page.getByTestId('prompt-guide-dialog').getByText(/직접 입력 아님.*중복 수집.*민감정보 포함 가능.*인용·코드/).isVisible()
            && test.saveWrites.length === 0 && test.store().entries.length === 0);
          await suggestions.first().click();
          check('Local: 추천 선택은 편집 가능한 초안만 만들며 명시적 저장을 기다림',
            (await page.getByTestId('prompt-guide-body').inputValue()).trim().length > 0
            && test.saveWrites.length === 0 && test.store().entries.length === 0);
        } else {
          await page.getByTestId('prompt-guide-suggestions-error').waitFor({ state: 'visible' });
          check(`Local: ${scenario} 잘못된·출처 변경 응답을 빈 기록·부분 추천으로 처리하지 않음`,
            await page.getByTestId('prompt-guide-suggestion-use').count() === 0
            && test.historyReads.length === (scenario === 'changed-source' ? 2 : 1)
            && await page.getByTestId('prompt-guide-suggestions-load').isEnabled() && test.saveWrites.length === 0);
        }
      }
      const persisted = await page.evaluate(() => Object.entries(localStorage));
      check(`Local: 가이드 ${scenario} ${zoom * 100}% fixture는 외부·DB·AI 호출과 원문 localStorage 저장 없음`,
        test.external.length === 0 && test.errors.length === 0
        && !test.requests.some(request => request.path.startsWith('/api/supabase-proxy/') || request.path.startsWith('/api/suggest-'))
        && !persisted.some(([, value]) => /합성 본문|합성 초안|테스트해 주세요|검증 항목/.test(value)),
        JSON.stringify({ external: test.external, pageErrors: test.errors }));
    } catch (error) {
      check(`Local: 가이드 ${scenario} ${zoom * 100}% 실제 App UI`, false,
        `${error.message}; recent API=${JSON.stringify(test?.requests.slice(-8))}`);
    } finally {
      test?.state.releaseHistory?.();
      for (const release of test?.state.provenanceReleases ?? []) release();
      await test?.context.close();
    }
  }
}
