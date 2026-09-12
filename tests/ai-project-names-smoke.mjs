/** Actual App browser fixtures. Every API request is intercepted; no real
 * sidecar, project files, Supabase, or model/provider is used by this module.
 */
import { mergePortSnapshots } from '../src/ports-merge.ts';
const DEVICE_ID = 'smoke-ai-names-device';
const EXPECTED = ['name', 'folderPath', 'aiName', 'category', 'description'];
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const equal = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

async function eventually(probe, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(message);
}

function initialPorts(scenario) {
  const count = scenario === 'batch' ? 31 : scenario.startsWith('refresh') ? 18 : scenario === 'partial' ? 3 : 1;
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `smoke-ai-name-${String(index).padStart(4, '0')}`, name: `이름 검증 프로젝트 ${String(index).padStart(2, '0')}`,
    folderPath: `/tmp/agentstoz-ai-names-fixture/project-${index}`, commandPath: `/tmp/agentstoz-ai-names-fixture/project-${index}/run.command`,
    aiName: `기존 별명 ${index}`, category: `기존 분류 ${index}`, description: `기존 설명 ${index}`,
    favorite: true, isRunning: false, sourceDeviceId: DEVICE_ID,
  }));
  if (scenario === 'batch') { delete rows[30].aiName; delete rows[30].category; delete rows[30].description; }
  if (scenario.startsWith('refresh')) {
    delete rows[1].category;
    delete rows[2].aiName;
    for (const row of rows.slice(3)) { delete row.aiName; delete row.category; }
  }
  return rows;
}

async function fixture(browser, targetUrl, scenario) {
  const target = new URL(targetUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('AI names fixture requires a loopback frontend.');
  const context = await browser.newContext({ viewport: { width: 1000, height: 1050 }, serviceWorkers: 'block' });
  const originals = initialPorts(scenario);
  let rows = clone(originals);
  const requests = [], external = [], errors = [], mergeWrites = [], labelWrites = [], labelResponses = [], suggestions = [], legacyBatches = [], quickCalls = [];
  const jobs = new Map();
  const state = { releaseSuggestion: null, heldSuggestion: false, activeSuggestion: 0, maxSuggestions: 0, activeReads: 0, maxReads: 0, activeQuickJob: null };
  const safety = { localOnlyDeletedPortIds: [], remoteDeletedPortIds: [], verifiedLegacyGeneratedWorktreeIds: [] };
  const portal = { ...safety, deviceId: DEVICE_ID, deviceName: '이름 검증 전용 Mac', items: [], categories: [] };
  await context.addInitScript(() => {
    localStorage.setItem('portmanager-setup-wizard-seen-v1', 'true');
    localStorage.setItem('folder-portal-migrated-v1', '1');
    localStorage.setItem('portmanager-ui-zoom', '1.25');
  });
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });
    if (path.startsWith('/api/')) {
      let body; try { body = request.postDataJSON(); } catch { body = null; }
      requests.push({ path, method: request.method(), body: clone(body) });
      if (path === '/api/ports') return request.method() === 'GET' ? json(clone(rows)) : json({ error: 'Legacy fallback write is forbidden in this fixture.' }, 409);
      if (path === '/api/ports/merge') {
        mergeWrites.push(clone(body));
        // Exercise the production merge, including its intentional-edit
        // resurrection behavior; a safer mock would conceal stale AI writes.
        rows = mergePortSnapshots(body.basePorts ?? [], body.ports ?? [], rows);
        return json({ success: true });
      }
      if (path === '/api/ports/ai-labels') {
        labelWrites.push(clone(body));
        if (scenario === 'apply-failure') return json({ error: 'fixture guarded label write unavailable' }, 503);
        if (!Array.isArray(body?.patches) || body.patches.some(patch =>
          !patch.expected || Object.keys(patch.expected).sort().join() !== [...EXPECTED].sort().join()
          || EXPECTED.some(key => !Object.hasOwn(patch.expected, key) || patch.expected[key] === undefined))) {
          return json({ error: 'fixture requires the complete nullable expected metadata' }, 400);
        }
        if (scenario === 'partial' && labelWrites.length === 1) {
          rows[1].category = '다른 창에서 수정한 분류';
          rows = rows.filter(row => row.id !== originals[2].id);
        }
        const result = { success: true, ports: [], appliedIds: [], unchangedIds: [], skipped: [] };
        for (const patch of body.patches) {
          const row = rows.find(row => row.id === patch.id);
          if (!row) { result.skipped.push({ id: patch.id, reason: 'missing', fields: [] }); continue; }
          const already = EXPECTED.every(key => equal(row[key], Object.hasOwn(patch.desired, key) ? patch.desired[key] : patch.expected[key]));
          if (already) { result.unchangedIds.push(patch.id); continue; }
          const changed = EXPECTED.filter(key => !equal(row[key], patch.expected[key]));
          if (changed.length) { result.skipped.push({ id: patch.id, reason: 'changed', fields: changed }); continue; }
          Object.assign(row, patch.desired); result.appliedIds.push(patch.id);
        }
        result.ports = clone(rows); labelResponses.push(clone(result));
        return json(result);
      }
      if (path === '/api/agent-runtime/quick-labels') {
        quickCalls.push(clone(body));
        if (body.operation === 'start') {
          if (state.activeQuickJob || !body.items?.length || body.items.length > 30) return json({ error: 'fixture quick labels must run one 1–30-item batch at a time' }, 409);
          const id = `fixture-quick-${jobs.size}`;
          jobs.set(id, { id, state: 'running', error: null, results: body.items.map(item => ({ id: item.id, name: `추천 ${item.id}`, category: '추천 분류' })) });
          state.activeQuickJob = id;
          return json({ id, state: 'running', error: null, results: [] });
        }
        const job = jobs.get(body.id);
        if (!job) return json({ error: 'fixture unknown quick-label job' }, 404);
        if (body.operation === 'cancel') { job.state = 'cancelled'; state.activeQuickJob = null; return json({ ...job, results: [] }); }
        state.activeReads += 1; state.maxReads = Math.max(state.maxReads, state.activeReads);
        await new Promise(resolve => setTimeout(resolve, 80));
        state.activeReads -= 1; job.state = 'completed'; state.activeQuickJob = null;
        return json(clone(job));
      }
      if (path === '/api/suggest-name-and-category') {
        suggestions.push(clone(body)); state.activeSuggestion += 1; state.maxSuggestions = Math.max(state.maxSuggestions, state.activeSuggestion);
        if ((scenario.startsWith('edit-') || scenario === 'refresh-stop') && !state.heldSuggestion) {
          state.heldSuggestion = true;
          await new Promise(resolve => { state.releaseSuggestion = resolve; }); state.releaseSuggestion = null;
        }
        await new Promise(resolve => setTimeout(resolve, 20)); state.activeSuggestion -= 1;
        return json({ name: `Claude 추천 ${body.name}`, category: 'Claude 추천 분류' });
      }
      if (path === '/api/suggest-batch') {
        if (!scenario.startsWith('refresh')) return json({ error: 'unexpected legacy batch path outside refresh' }, 400);
        legacyBatches.push(clone(body.ports));
        state.activeSuggestion += 1; state.maxSuggestions = Math.max(state.maxSuggestions, state.activeSuggestion);
        if (scenario === 'refresh-stop' && !state.heldSuggestion) {
          state.heldSuggestion = true;
          await new Promise(resolve => { state.releaseSuggestion = resolve; }); state.releaseSuggestion = null;
        }
        await new Promise(resolve => setTimeout(resolve, 40)); state.activeSuggestion -= 1;
        return json({ results: body.ports.map(port => ({ id: port.id, name: `Claude 추천 ${port.name}`, category: 'Claude 추천 분류' })) });
      }
      if (path.startsWith('/api/supabase-proxy/')) return json({ error: 'Supabase must remain unused in this local-only fixture.' }, 403);
      if (path === '/api/portal') return json(portal);
      if (path === '/api/portal/safety-lease/acquire') return json({ success: true, token: 'c'.repeat(64), metadata: safety, fingerprint: '[[],[],[]]', expiresInMs: 30_000 });
      if (path === '/api/portal/safety-lease/renew') return json({ success: true, renewed: true, expiresInMs: 30_000 });
      if (path === '/api/portal/safety-lease/release') return json({ success: true, released: true });
      if (path === '/api/workspace-roots') return json(request.method() === 'GET' ? [] : { success: true });
      if (path === '/api/discover-registered-git-worktrees') return json({ success: true, families: [], registeredProjectIds: rows.map(row => row.id), nextCursor: null, truncated: false });
      if (path === '/api/list-git-worktrees') return json({ success: true, worktrees: [] });
      if (path === '/api/project-memory/memory-ids') return json({ memoryIds: {} });
      if (path === '/api/project-memory/detect') return json({ exists: false, projectRoot: body?.folderPath ?? '', memoryPath: null, sourcePath: null, kind: 'none', size: 0, modifiedAt: null, contentHash: null, config: null,
        adapters: { claude: false, codex: false }, memoryAgent: { installedVersion: 0, currentVersion: 19, updateAvailable: false },
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
    if (url.origin !== target.origin || request.method() !== 'GET') { external.push({ origin: url.origin, path }); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.locator(`[data-testid="sidebar-project-row"][data-project-id="${originals[0].id}"]`).waitFor({ state: 'visible', timeout: 15_000 });
  } catch (error) { await context.close(); throw error; }
  return { context, page, originals, state, requests, external, errors, mergeWrites, labelWrites, labelResponses, suggestions, legacyBatches, quickCalls, rows: () => clone(rows), editDisk: changes => Object.assign(rows[0], changes) };
}

async function toolsOpen(page, open) {
  const details = page.locator('.workspace-sidebar-footer > details.workspace-tools');
  if (await details.evaluate(element => element.open) !== open) await details.locator(':scope > summary').click();
}
async function portsTab(page) { await page.locator('[data-top-level-tab="ports"]').click(); }
async function runtimeTab(page) { await page.getByTestId('top-level-runtime-tab').click(); }
async function openEditor(test) {
  await portsTab(test.page); await toolsOpen(test.page, false);
  await test.page.locator(`[data-testid="sidebar-project-row"][data-project-id="${test.originals[0].id}"]`).click();
  await test.page.getByTestId('detail-edit-project').click();
  await test.page.getByTestId('edit-ai-name-detail').waitFor({ state: 'visible' });
}
async function tableFits(page, testId) {
  return page.getByTestId(testId).evaluate(table => {
    const range = document.createRange();
    const outside = [...table.querySelectorAll('th,td')].some(cell => {
      range.selectNodeContents(cell); const bounds = cell.getBoundingClientRect();
      return [...range.getClientRects()].some(rect => rect.left < bounds.left - 1 || rect.right > bounds.right + 1);
    });
    return !outside && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
  });
}

/** Parent smoke runner owns Chromium and the PASS/FAIL reporter. */
export async function verifyAiProjectNamesUi(browser, targetUrl, check) {
  for (const scenario of ['batch', 'edit-review', 'edit-conflict', 'edit-persisted-conflict', 'partial', 'apply-failure', 'refresh-complete', 'refresh-stop']) {
    let test;
    try {
      test = await fixture(browser, targetUrl, scenario);
      const { page } = test;
      if (['batch', 'partial', 'apply-failure'].includes(scenario)) {
        await toolsOpen(page, true);
        await page.getByTestId('open-ai-project-names').click();
        const card = page.getByTestId('quick-project-names');
        await card.waitFor({ state: 'visible' });
        check(`Local: ${scenario} 상단 이름 추천은 AI 작업 탭 안에 표시`,
          await page.getByTestId('top-level-runtime-view').isVisible()
          && await card.evaluate(element => !!element.closest('[data-testid="top-level-runtime-view"]') && element.getAttribute('role') !== 'dialog'));
        await card.getByRole('button', { name: '추천 시작', exact: true }).click();
        await eventually(() => test.quickCalls.some(call => call.operation === 'start'), 'Quick label start was not requested.');
        await portsTab(page);
        await eventually(async () => /전체 추천 완료/.test(await page.getByTestId('quick-project-names-progress').textContent()), 'Hidden AI tab did not finish all batches.');
        check(`Local: ${scenario} 탭을 숨겨도 추천을 완료하며 적용 전 원본은 불변`,
          equal(test.rows(), test.originals) && test.labelWrites.length === 0);
        await runtimeTab(page);
        const starts = test.quickCalls.filter(call => call.operation === 'start');
        check(`Local: ${scenario} 전체 프로젝트 ID를 순차 청크로 보존`,
          equal(starts.flatMap(call => call.items.map(item => item.id)).sort(), test.originals.map(row => row.id).sort())
          && (scenario !== 'batch' || equal(starts.map(call => call.items.length), [30, 1])) && test.state.maxReads === 1,
          JSON.stringify({ sizes: starts.map(call => call.items.length), maxConcurrentReads: test.state.maxReads }));
        check(`Local: ${scenario} 125% 제안 표의 실제 텍스트는 셀을 넘지 않음`, await tableFits(page, 'quick-project-names-results'));
        const mergeCountBeforeApply = test.mergeWrites.length;
        await card.getByRole('button', { name: `${test.originals.length}개 제안 적용`, exact: true }).click();
        await eventually(() => test.labelWrites.length === 1, 'Reviewed proposals did not use guarded /api/ports/ai-labels.');
        if (scenario === 'batch') {
          await card.waitFor({ state: 'hidden' });
          check('Local: 31개 제안은 nullable expected 메타데이터와 함께 한 번 적용하고 성공 표시',
            test.labelWrites.length === 1 && test.labelResponses[0]?.appliedIds.length === 31
            && test.rows().every(row => row.aiName === `추천 ${row.id}` && row.category === '추천 분류')
            && test.labelWrites[0].patches.find(patch => patch.id === test.originals[30].id)?.expected.description === null
            && await page.getByText('추천 이름과 카테고리 31개를 적용했습니다.', { exact: true }).isVisible(),
            JSON.stringify({ applied: test.labelResponses[0]?.appliedIds.length,
              nullableExpected: test.labelWrites[0].patches.find(patch => patch.id === test.originals[30].id)?.expected }));
        } else if (scenario === 'partial') {
          await card.getByRole('alert').waitFor({ state: 'visible' });
          check('Local: 메타데이터 수정·삭제는 건너뛰고 부분 제안과 정확한 적용 수를 보존',
            /1개 적용.*2개.*건너뛰.*보존/.test(await card.getByRole('alert').textContent())
            && await card.locator('tbody tr').count() === 3
            && test.rows().find(row => row.id === test.originals[1].id)?.category === '다른 창에서 수정한 분류'
            && !test.rows().some(row => row.id === test.originals[2].id)
            && equal(test.labelResponses[0]?.skipped.map(row => row.reason).sort(), ['changed', 'missing'])
            && !await page.getByText('추천 이름과 카테고리 3개를 적용했습니다.', { exact: true }).isVisible(),
            JSON.stringify({ alert: await card.getByRole('alert').textContent(), skipped: test.labelResponses[0]?.skipped }));
        } else {
          await card.getByRole('alert').waitFor({ state: 'visible' });
          await page.waitForTimeout(350);
          check('Local: guarded 저장 실패는 제안을 보존하고 일반 포트 저장으로 우회하지 않음',
            /저장 결과를 확인하지 못했습니다.*제안.*보존/.test(await card.getByRole('alert').textContent())
            && await card.locator('tbody tr').count() === 1 && equal(test.rows(), test.originals)
            && test.mergeWrites.length === mergeCountBeforeApply
            && test.labelWrites.length === 1 && !test.requests.some(request => request.path === '/api/ports' && request.method === 'POST'),
            JSON.stringify({ alert: await card.getByRole('alert').textContent(), guardedWrites: test.labelWrites.length,
              mergeWritesBefore: mergeCountBeforeApply, mergeWritesAfter: test.mergeWrites.length }));
        }
      } else if (scenario.startsWith('edit')) {
        await openEditor(test);
        await page.getByTestId('edit-ai-generate-detail').click();
        const work = page.getByTestId('legacy-project-name-work');
        await work.waitFor({ state: 'visible' });
        await eventually(() => test.state.releaseSuggestion !== null, 'Legacy analysis was not held in the fixture.');
        await page.getByTestId('legacy-project-name-return').click();
        check(`Local: ${scenario} 기본 생성 버튼은 Claude 작업으로 이동하고 초안을 미리 덮어쓰지 않음`,
          await page.getByTestId('edit-ai-name-detail').inputValue() === test.originals[0].aiName
          && await page.getByTestId('edit-category-detail').inputValue() === test.originals[0].category
          && equal(test.rows(), test.originals) && test.suggestions.length === 1);
        if (scenario === 'edit-conflict') await page.getByTestId('edit-ai-name-detail').fill('사용자가 분석 중 입력한 별명');
        if (scenario === 'edit-persisted-conflict') {
          const readsBefore=test.requests.filter(request=>request.path==='/api/ports'&&request.method==='GET').length;
          test.editDisk({category:'다른 창에서 저장한 분류'});
          await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
          await eventually(()=>test.requests.filter(request=>request.path==='/api/ports'&&request.method==='GET').length>readsBefore,'Focus did not reload current persisted metadata.');
          await page.waitForTimeout(150);
        }
        test.state.releaseSuggestion();
        await runtimeTab(page);
        await eventually(async () => /분석 완료/.test(await page.getByTestId('legacy-project-name-status').textContent()), 'Legacy analysis did not complete.');
        check(`Local: ${scenario} 분석 완료만으로 초안이나 디스크를 저장하지 않음`, (scenario === 'edit-persisted-conflict' ? test.rows()[0].category === '다른 창에서 저장한 분류' : equal(test.rows(), test.originals)) && test.labelWrites.length === 0);
        await page.getByTestId('legacy-project-name-apply').click();
        if (scenario === 'edit-persisted-conflict') {
          await page.getByTestId('legacy-project-name-error').waitFor({ state: 'visible' });
          check('Local: 다른 창에서 저장한 메타데이터가 바뀌면 오래된 초안 제안을 거부', /반영하지 않았/.test(await page.getByTestId('legacy-project-name-error').textContent()) && test.rows()[0].category === '다른 창에서 저장한 분류' && await work.locator('tbody tr').count() === 1);
        } else if (scenario === 'edit-conflict') {
          await page.getByTestId('legacy-project-name-error').waitFor({ state: 'visible' });
          check('Local: 생성 중 바뀐 편집 초안에는 제안을 반영하지 않고 원래 제안을 유지',
            /편집 내용이 바뀌어.*반영하지 않았/.test(await page.getByTestId('legacy-project-name-error').textContent())
            && await work.locator('tbody tr').count() === 1 && equal(test.rows(), test.originals));
          await page.getByTestId('legacy-project-name-return').click();
          check('Local: 충돌 뒤 사용자 초안 값은 그대로 유지', await page.getByTestId('edit-ai-name-detail').inputValue() === '사용자가 분석 중 입력한 별명');
        } else {
          await page.getByTestId('edit-ai-name-detail').waitFor({ state: 'visible' });
          check('Local: 명시적 편집 반영은 초안만 갱신하며 저장 전 디스크는 불변',
            await page.getByTestId('edit-ai-name-detail').inputValue() === `Claude 추천 ${test.originals[0].name}`
            && await page.getByTestId('edit-category-detail').inputValue() === 'Claude 추천 분류' && equal(test.rows(), test.originals));
          await page.getByTestId('detail-edit-save').click();
          await eventually(() => test.rows()[0].aiName === `Claude 추천 ${test.originals[0].name}`, 'Explicit draft Save did not persist the accepted proposal.');
          check('Local: 사용자가 저장을 눌러야 Claude 제안이 로컬에 저장됨', test.rows()[0].category === 'Claude 추천 분류' && test.labelWrites.length === 0);
        }
      } else {
        await toolsOpen(page, true);
        await page.locator('[data-help-key="btn-refresh"]').click();
        await page.getByTestId('legacy-project-name-work').waitFor({ state: 'visible' });
        if (scenario === 'refresh-stop') {
          await eventually(() => test.state.releaseSuggestion !== null, 'Refresh analysis was not held.');
          await page.getByTestId('legacy-project-name-stop').click();
          check('Local: 새로고침 중지는 현재 분석의 실제 완료를 기다림',
            /현재 분석/.test(await page.getByTestId('legacy-project-name-status').textContent()) && test.labelWrites.length === 0);
          test.state.releaseSuggestion();
          await eventually(async () => /중지됨/.test(await page.getByTestId('legacy-project-name-status').textContent()), 'Refresh did not stop after the current analysis.');
          await page.waitForTimeout(350);
          check('Local: 현재 분석 후 중지는 현재 15개 묶음의 빈 필드만 저장하고 다음 묶음을 시작하지 않음',
            test.legacyBatches.length === 1 && test.legacyBatches[0].length === 15 && test.labelWrites.length === 1
            && test.rows()[1].aiName === test.originals[1].aiName && test.rows()[1].category === 'Claude 추천 분류'
            && test.rows()[2].category === test.originals[2].category
            && equal(test.rows()[16], test.originals[16]) && equal(test.rows()[17], test.originals[17]));
        } else {
          await eventually(async () => /분석 완료/.test(await page.getByTestId('legacy-project-name-status').textContent()), 'Refresh enrichment did not complete.');
          check('Local: 새로고침은 빈 필드가 있는 17개만 15+2 순차 분석하고 기존 분류를 보존',
            equal(test.legacyBatches.map(batch => batch.length), [15, 2]) && test.state.maxSuggestions === 1 && test.labelWrites.length === 2
            && !test.legacyBatches.flat().some(input => input.folderPath === test.originals[0].folderPath)
            && equal(test.rows()[0], test.originals[0]) && test.rows()[1].aiName === test.originals[1].aiName
            && test.rows()[2].category === test.originals[2].category
            && test.rows().every(row => row.aiName && row.category)
            && /처리 17개.*성공 17개.*실패 0개/.test(await page.getByTestId('legacy-project-name-status').textContent()));
        }
      }
      check(`Local: AI 이름 ${scenario} fixture는 실제 API·Supabase·모델에 접근하지 않음`,
        test.external.length === 0 && test.errors.length === 0
        && !test.requests.some(request => request.path.startsWith('/api/supabase-proxy/')),
        JSON.stringify({ external: test.external, pageErrors: test.errors }));
    } catch (error) {
      check(`Local: AI 이름 ${scenario} 실제 App UI`, false, `${error.message}; recent API=${JSON.stringify(test?.requests.slice(-8))}`);
    } finally {
      test?.state.releaseSuggestion?.();
      await test?.context.close();
    }
  }
}
