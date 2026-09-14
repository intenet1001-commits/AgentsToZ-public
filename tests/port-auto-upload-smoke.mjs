/** Actual App UI with a fresh browser profile and a fully intercepted API.
 * This module never starts the sidecar, reads app data, or contacts Supabase.
 */
const PROJECT_ID = 'smoke-port-auto-upload';
const DEVICE_ID = 'smoke-port-upload-device';
const PROJECT_PATH = '/tmp/agentstoz-smoke-port-auto-upload';
const UPSERT_RPC = 'portmgr_upsert_ports_if_generation_matches';
const DESCRIPTION_PLACEHOLDER = '이 프로젝트가 뭔지 메모 (나중에 헷갈리지 않도록)';
const GITHUB_EDIT_SCENARIOS = ['github-first-folder-untouched', 'github-unset-edited-clear', 'github-late-detection-clear'];
const DETECTED_GITHUB_URL = 'https://github.com/example/detected-must-not-replace-clear';

function clone(value) { return JSON.parse(JSON.stringify(value)); }

async function eventually(probe, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function fixture(browser, targetUrl, scenario) {
  const target = new URL(targetUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
    throw new Error('Port upload UI fixture requires an explicit loopback frontend URL.');
  }
  const narrowNotice = ['missing-fence', 'metadata-conflict', 'upload-field-conflict'].includes(scenario);
  const context = await browser.newContext({
    viewport: { width: narrowNotice ? 1000 : 1440, height: 1050 }, serviceWorkers: 'block',
  });
  const errors = [];
  const requests = [];
  const blockedExternal = [];
  const remoteWrites = [];
  const portWrites = [];
  const schemaReads = [];
  const requiredPullFailures = [];
  let localPorts = [{
    id: PROJECT_ID, name: '자동 업로드 검증 프로젝트', folderPath: PROJECT_PATH,
    category: '초기 카테고리', description: '초기 설명', aiName: '업로드 검증',
    sourceDeviceId: DEVICE_ID, syncGeneration: '0', isRunning: false,
  }];
  let remoteRow = {
    id: PROJECT_ID, name: localPorts[0].name, folder_path: PROJECT_PATH,
    category: localPorts[0].category, description: localPorts[0].description,
    ai_name: localPorts[0].aiName, device_id: DEVICE_ID, sync_generation: '0',
    favorite: false, memo: null,
  };
  if (GITHUB_EDIT_SCENARIOS.includes(scenario)) {
    localPorts[0] = { ...localPorts[0], port: 9000 };
    delete localPorts[0].folderPath;
  }
  if (scenario === 'metadata-conflict') remoteRow = {
    ...remoteRow, category: '원격 카테고리', description: '원격에서 더 나중에 작성한 설명', sync_generation: '5',
  };
  if (scenario === 'upload-field-conflict') {
    localPorts[0] = { ...localPorts[0], port: 9000, favorite: true,
      deployUrl: 'https://local.example.test', githubUrls: ['https://github.com/example/local'],
      commandPath: '/fixture/local.command', terminalCommand: 'bun run local', manualPath: '/fixture/local.md',
      logFilePath: '/fixture/local-log.md' };
    remoteRow = { ...remoteRow, name: '원격에서 바꾼 프로젝트명', port: null, favorite: false,
      folder_path: '/fixture/remote-worktree', worktree_parent_id: 'fixture-remote-parent',
      deploy_url: 'https://remote.example.test', github_urls: ['https://github.com/example/remote'],
      command_path: null, terminal_command: 'bun run remote', manual_path: null, log_file_path: '/fixture/remote-log.md',
      memo: '원격 상세 메모', memo_updated_at: '2026-09-09T00:00:00Z', sync_generation: '5' };
  }
  if (scenario === 'fresh-then-late-conflict') remoteRow = {
    ...remoteRow, deploy_url: 'https://fresh.example.test', github_urls: ['https://github.com/example/fresh'],
    sync_generation: '5',
  };
  if (scenario === 'explicit-edit-clear' || scenario === 'explicit-inline-clear') {
    localPorts[0] = { ...localPorts[0], port: 9000, syncGeneration: '3',
      deployUrl: 'https://previous.example.test', githubUrl: 'https://github.com/example/previous',
      githubUrls: ['https://github.com/example/previous'], commandPath: `${PROJECT_PATH}/run.command`,
      terminalCommand: 'bun run previous', manualPath: '/fixture/previous.md', logFilePath: '/fixture/previous.log' };
    remoteRow = { ...remoteRow, port: 9000, sync_generation: '3', deploy_url: localPorts[0].deployUrl,
      github_url: localPorts[0].githubUrl, github_urls: localPorts[0].githubUrls,
      command_path: localPorts[0].commandPath, terminal_command: localPorts[0].terminalCommand,
      manual_path: localPorts[0].manualPath, log_file_path: localPorts[0].logFilePath };
  }
  const safety = {
    localOnlyDeletedPortIds: [], remoteDeletedPortIds: [], verifiedLegacyGeneratedWorktreeIds: [],
  };
  const portal = {
    ...safety, deviceId: DEVICE_ID, deviceName: '검증 전용 Mac', items: [], categories: [],
    supabaseUrl: 'https://agentstoz-smoke.invalid', supabaseAnonKey: 'fixture-public-key-not-a-credential',
  };
  const state = {
    schemaMissing: scenario === 'missing-fence', initialPullFailed: scenario === 'failed-pull',
    configured: !['no-config', 'explicit-edit-clear', 'explicit-inline-clear', ...GITHUB_EDIT_SCENARIOS].includes(scenario),
    rejectSourceRevoke: false,
    holdNextGitDetection: false, releaseGitDetection: null,
    holdNextPortWrite: false, releaseBlockedWrite: null, activePortWrites: 0, maxConcurrentPortWrites: 0,
  };

  await context.addInitScript(({ zoom, conflictingMemo, projectId }) => {
    localStorage.setItem('portmanager-setup-wizard-seen-v1', 'true');
    localStorage.setItem('folder-portal-migrated-v1', '1');
    localStorage.setItem('portmanager-ui-zoom', zoom);
    if (conflictingMemo) localStorage.setItem('portmanager-memos', JSON.stringify({
      [projectId]: { content: '로컬 상세 메모', updatedAt: '2026-09-01T00:00:00Z' },
    }));
  }, { zoom: narrowNotice ? '1.25' : '1', conflictingMemo: scenario === 'upload-field-conflict', projectId: PROJECT_ID });
  // A catch-all route, rather than selective overrides, prevents a newly added
  // component endpoint from reaching the user's local API or a real database.
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body),
    });
    if (path.startsWith('/api/')) {
      const method = request.method();
      let body;
      try { body = request.postDataJSON(); } catch { body = null; }
      requests.push({ path, method });

      if (path.startsWith('/api/supabase-proxy/rest/v1/')) {
        const resource = path.slice('/api/supabase-proxy/rest/v1/'.length);
        // PostgREST RPCs are POST even when they only read. The shared prompt
        // guide read is `stable` and select-only (20260911010000_shared_prompt_guides.sql),
        // so counting it as a remote write made every "no remote writes" check fail.
        if (resource === 'rpc/portmgr_prompt_guides_read') return json({ success: true, revision: '0', entries: [] });
        if (method !== 'GET' && method !== 'HEAD') remoteWrites.push({ resource, method, body: clone(body) });
        if (resource === 'portmgr_port_fences') {
          schemaReads.push(url.search);
          if (state.schemaMissing) return json({
            code: 'PGRST205', message: "Could not find the table 'public.portmgr_port_fences' in the schema cache",
          }, 404);
          return json([{ port_id: PROJECT_ID, state: 'active', generation: remoteRow.sync_generation, owner_device_id: DEVICE_ID }]);
        }
        if (resource === 'portmgr_ports') {
          if (method !== 'GET' && method !== 'HEAD') return json({ code: 'FIXTURE_DIRECT_PORT_WRITE_FORBIDDEN' }, 403);
          return json([clone(remoteRow)]);
        }
        if (resource === 'portmgr_workspace_roots' && (method === 'GET' || method === 'HEAD')) {
          if (state.initialPullFailed) {
            requiredPullFailures.push(resource);
            return json({ code: '42501', message: 'fixture required initial workspace roots Pull denied' }, 403);
          }
          return json([]);
        }
        if (resource === `rpc/${UPSERT_RPC}`) {
          const rows = clone(body?.p_rows ?? []);
          portWrites.push({ rows, operationId: body?.p_upsert_op_id, receivedAt: Date.now() });
          state.activePortWrites += 1;
          state.maxConcurrentPortWrites = Math.max(state.maxConcurrentPortWrites, state.activePortWrites);
          if (state.holdNextPortWrite) {
            state.holdNextPortWrite = false;
            await new Promise(resolve => { state.releaseBlockedWrite = resolve; });
            state.releaseBlockedWrite = null;
          }
          if (rows.some(row => row.sync_generation !== remoteRow.sync_generation)) {
            try { return await json({ code: 'P0001', message: 'PORT_FENCE_GENERATION_MISMATCH' }, 409); }
            finally { state.activePortWrites -= 1; }
          }
          // Real CAS semantics: a changed row advances once; a no-op keeps its
          // generation. This also catches accidental generation-only loops.
          const results = rows.map(row => {
            const changed = Object.entries(row).some(([key, value]) => key !== 'sync_generation'
              && JSON.stringify(value ?? null) !== JSON.stringify(remoteRow[key] ?? null));
            const generation = changed ? String(BigInt(remoteRow.sync_generation) + 1n) : remoteRow.sync_generation;
            remoteRow = { ...remoteRow, ...row, sync_generation: generation };
            return { id: row.id, generation };
          });
          try { return await json(results); }
          finally { state.activePortWrites -= 1; }
        }
        if (resource.startsWith('rpc/')) return json({ code: 'FIXTURE_UNKNOWN_RPC', message: resource }, 400);
        return json([]);
      }
      if (path.startsWith('/api/supabase-proxy/')) return json({ error: 'fixture does not provide auth/realtime' }, 404);
      if (path === '/api/ports') {
        if (method === 'GET') return json(clone(localPorts));
        return json({ error: 'fixture expects three-way merge writes' }, 400);
      }
      if (path === '/api/ports/merge') {
        localPorts = clone(body.ports);
        return json({ success: true });
      }
      if (path === '/api/portal') {
        const { supabaseUrl, supabaseAnonKey, ...localOnlyPortal } = portal;
        return json(state.configured ? portal : localOnlyPortal);
      }
      if (path === '/api/portal/safety-lease/acquire') return json({
        success: true, token: 'f'.repeat(64), metadata: safety, fingerprint: '[[],[],[]]', expiresInMs: 30_000,
      });
      if (path === '/api/portal/safety-lease/renew') return json({ success: true, renewed: true, expiresInMs: 30_000 });
      if (path === '/api/portal/safety-lease/release') return json({ success: true, released: true });
      if (path === '/api/workspace-roots') return json(method === 'GET' ? [] : { success: true });
      if (path === '/api/discover-registered-git-worktrees') return json({
        success: true, families: [], registeredProjectIds: [PROJECT_ID], nextCursor: null, truncated: false,
      });
      if (path === '/api/list-git-worktrees') return json({ success: true, worktrees: [] });
      if (path === '/api/project-memory/memory-ids') return json({ memoryIds: {} });
      if (path === '/api/detect-git-remote') {
        if (state.holdNextGitDetection) {
          state.holdNextGitDetection = false;
          await new Promise(resolve => { state.releaseGitDetection = resolve; });
          state.releaseGitDetection = null;
        }
        return json({ url: DETECTED_GITHUB_URL });
      }
      if (path === '/api/what-i-said/source' && method === 'DELETE') return state.rejectSourceRevoke
        ? json({ error: 'fixture revoke unavailable' }, 503) : json({ success: true });
      if (path === '/api/project-memory/hermes-adapter') return json({ hermesCliPath: null });
      if (path === '/api/check-ports-batch') return json({ success: true, results: [] });
      if (path === '/api/browser-profiles') return json({ success: true, profiles: [] });
      if (path === '/api/last-visits' || path === '/api/last-git-activity') return json({});
      if (path === '/api/agent-runtime/targets') return json({ protocolVersion: 'agentstoz-tasks-v2', targets: [], complete: true });
      if (path === '/api/agent-runtime/terminals') return json({ sessions: [] });
      if (path === '/api/agent-runtime/terminals/access') return json({ connections: [] });
      if (path === '/api/agent-runtime/terminals/memory') return json({ jobs: [], total: 0, unresolved: 0, nextOffset: null });
      return json({ success: true, results: [] });
    }
    if (url.origin !== target.origin || request.method() !== 'GET') {
      blockedExternal.push({ origin: url.origin, path, method: request.method() });
      return route.abort('blockedbyclient');
    }
    // Only source frontend documents/static modules/styles may reach Vite.
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const status = page.getByTestId('ports-auto-upload-status');
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.getByTestId('sidebar-project-row').filter({ hasText: localPorts[0].name }).waitFor({ state: 'visible', timeout: 15_000 });
    await openGlobalTools(page);
    await status.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    await context.close();
    throw error;
  }
  return {
    context, page, status, state, requests, blockedExternal, errors, schemaReads, portWrites, remoteWrites, requiredPullFailures,
    localPorts: () => clone(localPorts),
    remoteRow: () => clone(remoteRow),
    editRemote: values => { remoteRow = { ...remoteRow, ...clone(values) }; },
  };
}

async function openGlobalTools(page) {
  const tools = page.locator('.workspace-sidebar-footer > details.workspace-tools');
  if (!await tools.evaluate(element => element.open)) await tools.locator(':scope > summary').click();
}

async function editMetadata(page, label, placeholder, next) {
  const details = page.locator('.workspace-project-detail');
  await details.locator('.meta-editable-row').filter({ has: page.getByText(label, { exact: true }) }).click();
  const input = details.getByPlaceholder(placeholder, { exact: true });
  await input.fill(next);
  await input.press('Enter');
  await input.waitFor({ state: 'hidden' });
}

async function openProject(page) {
  const tools = page.locator('.workspace-sidebar-footer > details.workspace-tools');
  // At 125% the tools popover legitimately overlays the project row. Close
  // its native disclosure before selecting the project, as a user would.
  if (await tools.evaluate(element => element.open)) await tools.locator(':scope > summary').click();
  await page.locator(`[data-testid="sidebar-project-row"][data-project-id="${PROJECT_ID}"]`).click();
  await page.locator('.workspace-project-detail').waitFor({ state: 'visible' });
}

async function statusTextGeometry(page) {
  return page.getByTestId('ports-auto-upload-status').evaluate(element => {
    const rect = value => ({ left: value.left, right: value.right, top: value.top, bottom: value.bottom });
    const bounds = rect(element.getBoundingClientRect());
    const range = document.createRange();
    range.selectNodeContents(element);
    const lines = Array.from(range.getClientRects(), rect);
    const buttons = Array.from(element.parentElement.querySelectorAll(
      '[data-help-key="btn-export-ports"], [data-help-key="btn-import-ports"]',
    ), button => rect(button.getBoundingClientRect()));
    const contained = lines.length > 0 && lines.every(line => line.left >= bounds.left - 1
      && line.right <= bounds.right + 1 && line.top >= bounds.top - 1 && line.bottom <= bounds.bottom + 1);
    const overlapsButton = lines.some(line => buttons.some(button => line.left < button.right - 1
      && line.right > button.left + 1 && line.top < button.bottom - 1 && line.bottom > button.top + 1));
    return { contained, overlapsButton, bounds, lines, buttons, whiteSpace: getComputedStyle(element).whiteSpace };
  });
}

async function verifyNoticeGeometry(page, scenario, check) {
  // Global scrollWidth can remain unchanged while inherited nowrap paints
  // glyphs across neighbouring buttons. Measure actual text fragments instead.
  const fixed = await statusTextGeometry(page);
  check(`Local: 1000px·125% ${scenario} 상태 텍스트는 자체 영역 안에 줄바꿈하고 버튼과 겹치지 않음`,
    fixed.contained && !fixed.overlapsButton && fixed.buttons.length === 2, JSON.stringify(fixed));
  let oldStyle;
  let legacy;
  try {
    // Reproduce only the previous span layout in this intercepted fixture;
    // never change source CSS or persist a user's app settings.
    oldStyle = await page.addStyleTag({ content: `
      .workspace-project-tools > [data-testid="ports-auto-upload-status"] {
        flex: 0 1 auto !important; width: auto !important; min-width: auto !important;
        max-width: 14rem !important; white-space: nowrap !important;
        overflow-wrap: normal !important; line-height: normal !important;
      }
    ` });
    legacy = await statusTextGeometry(page);
  } finally {
    await oldStyle?.evaluate(element => element.remove());
  }
  const restored = await statusTextGeometry(page);
  check(`Local: ${scenario} 텍스트 경계 검사는 이전 nowrap 회귀를 탐지하고 스타일 복원 후 통과`,
    legacy && (!legacy.contained || legacy.overlapsButton)
    && restored.contained && !restored.overlapsButton, JSON.stringify({ legacy, restored }));
}

/** The parent smoke runner owns Chromium and its PASS/FAIL reporter. */
export async function verifyPortAutoUploadUi(browser, targetUrl, check, scenarios = ['missing-fence', 'ready', 'failed-pull', 'slow-upload', 'no-config', 'metadata-conflict',
  'upload-field-conflict', 'fresh-then-late-conflict', 'explicit-edit-clear', 'explicit-inline-clear', ...GITHUB_EDIT_SCENARIOS]) {
  for (const scenario of scenarios) {
    let test;
    try {
      test = await fixture(browser, targetUrl, scenario);
      const { page, status, portWrites } = test;
      if (GITHUB_EDIT_SCENARIOS.includes(scenario)) {
        await openProject(page);
        await page.getByTestId('detail-edit-project').click();
        const github = page.getByLabel('GitHub 저장소 주소 1', { exact: true });
        if (await github.inputValue() !== '') throw new Error('The fixture must start with unknown GitHub fields.');
        await page.getByTestId('edit-folder-field-detail').locator('input').fill(PROJECT_PATH);
        if (scenario === 'github-unset-edited-clear') {
          await github.fill('https://github.com/example/typed-then-removed');
          await github.fill('');
        }
        if (scenario === 'github-late-detection-clear') test.state.holdNextGitDetection = true;
        await page.getByTestId('detail-edit-save').click();
        await page.getByTestId('detail-edit-save').waitFor({ state: 'hidden' });
        await eventually(() => test.localPorts()[0].folderPath === PROJECT_PATH, 'First folder connection must be saved.');
        const detections = () => test.requests.filter(request => request.path === '/api/detect-git-remote');
        const cleared = () => test.localPorts()[0].githubUrl === '' && test.localPorts()[0].githubUrls?.length === 0;
        if (scenario === 'github-first-folder-untouched') {
          await eventually(() => test.localPorts()[0].githubUrl === DETECTED_GITHUB_URL,
            'Untouched unknown GitHub metadata must still auto-detect after connecting a folder.');
          check('Local: 기존 프로젝트의 첫 폴더 연결은 건드리지 않은 미설정 GitHub 주소를 자동 탐지',
            detections().length === 1 && test.localPorts()[0].githubUrls?.[0] === DETECTED_GITHUB_URL
            && test.localPorts()[0].port === 9000 && portWrites.length === 0);
        } else {
          if (scenario === 'github-late-detection-clear') {
            await eventually(() => typeof test.state.releaseGitDetection === 'function', 'A delayed detection must be in flight.');
            await page.getByTestId('detail-edit-project').click();
            await github.fill('https://github.com/example/new-intent');await github.fill('');
            await page.getByTestId('detail-edit-save').click();
            await page.getByTestId('detail-edit-save').waitFor({ state: 'hidden' });
            await eventually(cleared, 'The newer explicit clear must be durable before releasing detection.');
            test.state.releaseGitDetection();
            await eventually(() => test.state.releaseGitDetection === null, 'Release only the fixture detection response.');
          }
          await eventually(cleared, 'Editing an unset value and clearing it must retain explicit empty fields.');
          await page.waitForTimeout(300);
          check(`Local: ${scenario}는 입력 후 비우기 의도와 빈 배열을 보존하며 늦은 Git 탐지도 덮어쓰지 않음`,
            cleared() && detections().length === (scenario === 'github-late-detection-clear' ? 1 : 0)
            && test.localPorts()[0].folderPath === PROJECT_PATH && test.localPorts()[0].port === 9000 && portWrites.length === 0);
        }
      } else if (scenario === 'explicit-edit-clear' || scenario === 'explicit-inline-clear') {
        await openProject(page);
        const fullEdit = scenario === 'explicit-edit-clear';
        if (fullEdit) {
          // Keep the real folder while clearing just GitHub first. Otherwise
          // an empty folder would accidentally hide an automatic-refill bug.
          await page.getByTestId('detail-edit-project').click();
          await page.getByLabel('GitHub 저장소 주소 1', { exact: true }).fill('');
          await page.getByTestId('detail-edit-save').click();
          await page.getByTestId('detail-edit-save').waitFor({ state: 'hidden' });
          await eventually(() => test.localPorts()[0].githubUrl === '' && test.localPorts()[0].githubUrls?.length === 0,
            'A cleared GitHub editor value must remain explicit.');
          await page.waitForTimeout(250);
          check('Local: 폴더를 유지한 GitHub 지우기는 저장 후 자동 Git 감지로 다시 채워지지 않음',
            test.localPorts()[0].folderPath === PROJECT_PATH && test.localPorts()[0].githubUrl === ''
            && test.localPorts()[0].githubUrls?.length === 0
            && !test.requests.some(request => request.path === '/api/detect-git-remote'));
          await page.getByTestId('detail-edit-project').click();
          await page.getByPlaceholder('포트', { exact: true }).fill('');
          await page.getByPlaceholder('배포 주소', { exact: true }).fill('');
          await page.getByLabel('GitHub 저장소 주소 1', { exact: true }).fill('');
          await page.getByTestId('edit-category-detail').fill('');
          await page.getByPlaceholder('프로젝트 설명', { exact: true }).fill('');
          await page.getByPlaceholder('터미널 명령어', { exact: true }).fill('');
          for (const id of ['edit-command-file-field', 'edit-folder-field-detail', 'edit-manual-file-field-detail', 'edit-log-file-field-detail']) {
            await page.getByTestId(id).locator('input').fill('');
          }
          test.state.rejectSourceRevoke = true;
          await page.getByTestId('detail-edit-save').click();
          await eventually(() => test.requests.some(request => request.path === '/api/what-i-said/source' && request.method === 'DELETE'),
            'Clearing a project path must revoke the original What I Said source.');
          await page.getByText('기존 프로젝트 경로의 What I said 공유를 해제하지 못해 경로 변경을 중단했습니다.', { exact: false }).waitFor();
          check('Local: 명시적 경로 지우기도 What I Said 해제 실패 시 원래 프로젝트를 보존',
            test.localPorts()[0].folderPath === PROJECT_PATH && test.localPorts()[0].port === 9000
            && await page.getByTestId('detail-edit-save').isVisible());
          test.state.rejectSourceRevoke = false;
          await page.getByTestId('detail-edit-save').click();
          await page.getByTestId('detail-edit-save').waitFor({ state: 'hidden' });
        } else {
          await editMetadata(page, 'deploy', '배포 주소 입력', '');
          await editMetadata(page, '카테고리', '카테고리 입력', '');
          await editMetadata(page, '메모', DESCRIPTION_PLACEHOLDER, '');
          await page.locator('.workspace-project-detail .meta-editable-row').filter({ has: page.getByText('github', { exact: true }) }).click();
          await page.getByLabel('GitHub 저장소 주소 1', { exact: true }).fill('');
          await page.locator('.workspace-project-detail').getByRole('button', { name: '저장', exact: true }).click();
        }
        const strings = ['deployUrl', 'category', 'description', ...(fullEdit ? ['commandPath', 'terminalCommand', 'folderPath', 'manualPath', 'logFilePath'] : [])];
        const isCleared = row => strings.every(field => row[field] === '') && row.githubUrl === ''
          && Array.isArray(row.githubUrls) && row.githubUrls.length === 0 && (!fullEdit || row.port === 0);
        await eventually(() => isCleared(test.localPorts()[0]), `${scenario} did not persist explicit clears through the real editor.`);
        check(`Local: ${scenario} 실제 저장은 빈 문자열·GitHub 빈 배열${fullEdit ? '·포트 0' : ''}을 명시적으로 보존`,
          isCleared(test.localPorts()[0]) && test.localPorts()[0].syncGeneration === '3' && portWrites.length === 0
          && !test.requests.some(request => request.path === '/api/detect-git-remote'));
        test.state.configured = true;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openGlobalTools(page);
        await eventually(async () => /비교/.test(await status.textContent()), 'Restart Pull must flag the old remote values against explicit clears.');
        await page.waitForTimeout(3_500);
        check(`Local: ${scenario} 재시작 Pull은 지운 로컬 값과 원격 이전 값·세대를 모두 보존하고 자동 업로드를 차단`,
          isCleared(test.localPorts()[0]) && test.localPorts()[0].syncGeneration === '3'
          && test.remoteRow().deploy_url === 'https://previous.example.test'
          && test.remoteRow().github_urls?.[0] === 'https://github.com/example/previous'
          && test.remoteRow().sync_generation === '3' && portWrites.length === 0 && test.remoteWrites.length === 0);
        if (fullEdit) {
          await openProject(page);await page.getByTestId('detail-edit-project').click();
          check('Local: 지운 포트의 저장값 0은 편집 재진입 시 빈 입력으로 표시',
            test.localPorts()[0].port === 0 && await page.getByPlaceholder('포트', { exact: true }).inputValue() === '');
        }
      } else if (scenario === 'missing-fence') {
        await eventually(async () => /스키마.*업데이트|업데이트.*필요/.test(await status.textContent()), 'Missing fence must show a schema update status.');
        await openProject(page);
        await editMetadata(page, '메모', DESCRIPTION_PLACEHOLDER, '스키마 준비 전 로컬 변경');
        await page.waitForTimeout(3_500);
        await openGlobalTools(page);
        check('Local: 삭제 fence 미설치 상태는 스키마 업데이트 안내와 로컬 편집을 유지',
          /스키마.*업데이트|업데이트.*필요/.test(await status.textContent())
          && test.localPorts()[0].description === '스키마 준비 전 로컬 변경');
        check('Local: 삭제 fence 미설치에서는 자동 RPC와 직접 포트 쓰기 없음',
          test.schemaReads.length > 0 && portWrites.length === 0
          && !test.remoteWrites.some(write => write.resource === 'portmgr_ports'));
        await verifyNoticeGeometry(page, scenario, check);
      } else if (scenario === 'ready') {
        await eventually(async () => /업로드 켜짐|업로드 대기|업로드 완료/.test(await status.textContent()), 'Ready Pull did not enable upload.');
        // Let the initial snapshot write (if needed) and its generation no-op
        // settle before measuring a burst of actual user changes.
        await page.waitForTimeout(7_000);
        await openProject(page);
        await editMetadata(page, '카테고리', '카테고리 입력', '배포 검증');
        await page.waitForTimeout(400);
        await editMetadata(page, '메모', DESCRIPTION_PLACEHOLDER, '첫 설명');
        await page.waitForTimeout(400);
        const beforeFinal = portWrites.length;
        const finalEditAt = Date.now();
        await editMetadata(page, '메모', DESCRIPTION_PLACEHOLDER, '최종 설명');
        await page.waitForTimeout(2_300);
        check('Local: 카테고리·설명 연속 편집은 debounce 전 업로드하지 않음', portWrites.length === beforeFinal);
        await eventually(() => portWrites.some(write => write.rows.some(row => row.description === '최종 설명')), 'Edited metadata was never auto uploaded.');
        const finalWrites = portWrites.filter(write => write.rows.some(row => row.description === '최종 설명'));
        check('Local: 실제 상세 편집의 카테고리·설명을 최종값으로 한 번 업로드',
          finalWrites.length === 1 && finalWrites[0].rows.length === 1
          && finalWrites[0].rows[0].category === '배포 검증'
          && finalWrites[0].rows[0].device_id === DEVICE_ID
          && finalWrites[0].receivedAt - finalEditAt >= 2_800
          && !portWrites.some(write => write.rows.some(row => row.description === '첫 설명')));
        await eventually(async () => /업로드 완료/.test(await status.textContent()), 'Successful automatic upload was not shown.');
        await openGlobalTools(page);
        check('Local: 자동 업로드 성공을 상태 표시에서 확인', await status.isVisible() && /업로드 완료/.test(await status.textContent()));
      } else if (scenario === 'failed-pull') {
        await eventually(async () => /대기|중단/.test(await status.textContent()) && test.requiredPullFailures.length > 0,
          'Required initial Pull failure did not hold automatic upload.');
        await page.waitForTimeout(3_500);
        check('Local: 필수 작업루트 Pull 실패는 초기 자동 업로드를 차단', portWrites.length === 0);
        // The connection now permits writes. A successful manual Push still
        // does not prove that the required startup read succeeded.
        test.state.initialPullFailed = false;
        await page.getByTestId('ports-supabase-push').click();
        await eventually(async () => /앱을 다시 열어/.test(await status.textContent()), 'Manual Push incorrectly reopened the initial Pull gate.');
        const afterManual = portWrites.length;
        await openProject(page);
        await editMetadata(page, '메모', DESCRIPTION_PLACEHOLDER, '초기 Pull 재검증 전 변경');
        await page.waitForTimeout(3_500);
        await openGlobalTools(page);
        check('Local: 수동 Push 성공은 실패한 초기 Pull의 자동 업로드 gate를 열지 않음',
          afterManual === 1 && portWrites.length === afterManual
          && /앱을 다시 열어/.test(await status.textContent())
          && test.localPorts()[0].description === '초기 Pull 재검증 전 변경');
      } else if (scenario === 'slow-upload') {
        await eventually(async () => /업로드 켜짐|업로드 대기|업로드 완료/.test(await status.textContent()), 'Slow fixture did not finish initial Pull.');
        await page.waitForTimeout(7_000);
        await openProject(page);
        const baseline = portWrites.length;
        test.state.holdNextPortWrite = true;
        await editMetadata(page, '메모', DESCRIPTION_PLACEHOLDER, '지연 중 첫 요청');
        await eventually(() => test.state.releaseBlockedWrite !== null, 'Expected a held automatic upsert.');
        await editMetadata(page, '카테고리', '카테고리 입력', '지연 중 카테고리');
        await editMetadata(page, '메모', DESCRIPTION_PLACEHOLDER, '지연 중 최신 요청');
        await page.waitForTimeout(3_700);
        check('Local: 느린 자동 업로드 중 새 편집은 기존 요청을 추월하지 않음',
          portWrites.length === baseline + 1 && test.state.maxConcurrentPortWrites === 1);
        test.state.releaseBlockedWrite();
        await eventually(() => portWrites.some(write => write.rows.some(row => row.description === '지연 중 최신 요청')),
          'The latest edit was lost after the slow upload completed.', 12_000);
        await page.waitForTimeout(3_700);
        const changedWrites = portWrites.slice(baseline);
        check('Local: 느린 요청 뒤 최신 편집만 한 번 이어 업로드하고 generation 재업로드 없음',
          changedWrites.length === 2 && test.state.maxConcurrentPortWrites === 1
          && changedWrites[0].rows[0].description === '지연 중 첫 요청'
          && changedWrites[1].rows[0].description === '지연 중 최신 요청'
          && changedWrites[1].rows[0].category === '지연 중 카테고리');
      } else if (scenario === 'no-config') {
        await page.waitForTimeout(3_500);
        check('Local: Supabase 미설정 시작은 원격 조회·자동 쓰기를 수행하지 않음',
          test.schemaReads.length === 0 && portWrites.length === 0
          && !test.requests.some(request => request.path.startsWith('/api/supabase-proxy/')));
        // Change only what the mocked authoritative portal endpoint returns.
        // No React state/private ref injection or synthetic reload is used.
        test.state.configured = true;
        await page.getByTestId('ports-supabase-push').click();
        await eventually(async () => /앱을 다시 열어/.test(await status.textContent()),
          'Adding credentials through a manual Push must still require the initial Pull.');
        const afterManual = portWrites.length;
        await openProject(page);
        await editMetadata(page, '메모', DESCRIPTION_PLACEHOLDER, '새 연결의 초기 Pull 전 로컬 변경');
        await page.waitForTimeout(3_500);
        await openGlobalTools(page);
        check('Local: 미설정 시작 후 수동 Push로 연결해도 자동 업로드를 암묵적으로 켜지 않음',
          afterManual === 1 && portWrites.length === afterManual
          && /앱을 다시 열어/.test(await status.textContent())
          && test.localPorts()[0].description === '새 연결의 초기 Pull 전 로컬 변경'
          && test.remoteRow().description === '초기 설명');
      } else if (scenario === 'upload-field-conflict') {
        await eventually(async () => /비교/.test(await status.textContent()), 'Uploaded field differences did not close the initial upload gate.');
        await page.waitForTimeout(3_500);
        const local = test.localPorts().find(port => port.id === PROJECT_ID);
        const memo = await page.evaluate(id => JSON.parse(localStorage.getItem('portmanager-memos') || '{}')[id], PROJECT_ID);
        check('Local: 새 원격 세대의 이름·포트·명령·URL·즐겨찾기·상세 메모 차이는 로컬 값과 이전 세대를 보존',
          local?.name === '자동 업로드 검증 프로젝트' && local.port === 9000 && local.favorite === true
          && local.deployUrl === 'https://local.example.test' && local.githubUrls?.[0] === 'https://github.com/example/local'
          && local.commandPath === '/fixture/local.command' && local.terminalCommand === 'bun run local'
          && local.manualPath === '/fixture/local.md' && local.logFilePath === '/fixture/local-log.md'
          && local.folderPath === PROJECT_PATH && local.syncGeneration === '0' && memo?.content === '로컬 상세 메모'
          && test.remoteRow().memo === '원격 상세 메모' && test.remoteRow().sync_generation === '5' && portWrites.length === 0);
        await openProject(page);
        check('Local: 충돌 중 원격 worktree 마커를 부분 채택해 기존 프로젝트 카드를 숨기지 않음',
          !local.worktreeParentId && !local.worktreePath
          && await page.locator('.workspace-project-detail').isVisible());
        await openGlobalTools(page);
        const differences = page.getByTestId('ports-upload-conflicts');
        await differences.locator(':scope > summary').click();
        const shown = await differences.textContent();
        check('Local: 전체 업로드 필드와 별도 상세 메모 차이를 읽기 전용으로 비교',
          ['프로젝트명', '포트', '배포 주소', 'GitHub 저장소', '실행 파일', '실행 명령', '매뉴얼', '로그 문서', '즐겨찾기', '상세 메모',
            'https://local.example.test', 'https://remote.example.test', '로컬 상세 메모', '원격 상세 메모'].every(value => shown.includes(value))
          && await differences.locator('input,textarea,button').count() === 0);
        const readsBefore = test.requests.filter(request => request.path.endsWith('/rest/v1/portmgr_ports')).length;
        await page.getByTestId('ports-supabase-push').click();
        await eventually(() => test.requests.filter(request => request.path.endsWith('/rest/v1/portmgr_ports')).length > readsBefore,
          'Full-field manual preflight did not query remote metadata.');
        await eventually(async () => !await page.getByTestId('ports-supabase-push').isDisabled(), 'Full-field manual preflight did not finish.');
        check('Local: 수동 Push도 전체 필드 충돌을 RPC 전에 차단하고 원격 값을 유지',
          portWrites.length === 0 && test.remoteWrites.length === 0
          && test.remoteRow().deploy_url === 'https://remote.example.test'
          && test.remoteRow().memo === '원격 상세 메모' && /비교/.test(await status.textContent()));
      } else if (scenario === 'fresh-then-late-conflict') {
        await eventually(async () => /업로드 켜짐|업로드 대기|업로드 완료/.test(await status.textContent()), 'Fresh missing fields were incorrectly blocked.');
        await page.waitForTimeout(7_000);
        check('Local: 미충돌 결측 배포·GitHub 주소는 최신 원격 값을 채택하고 자동 업로드에도 같은 값을 사용',
          test.localPorts()[0].deployUrl === 'https://fresh.example.test'
          && test.localPorts()[0].githubUrls?.[0] === 'https://github.com/example/fresh'
          && portWrites.length > 0 && portWrites[0].rows[0].sync_generation === '5'
          && portWrites.every(write => write.rows[0].deploy_url === 'https://fresh.example.test'
            && write.rows[0].github_urls?.[0] === 'https://github.com/example/fresh'));
        const before = portWrites.length;
        const writesBefore = test.remoteWrites.length;
        test.editRemote({ deploy_url: 'https://later.example.test', sync_generation: String(BigInt(test.remoteRow().sync_generation) + 1n) });
        await page.getByTestId('ports-supabase-push').click();
        await eventually(async () => /비교/.test(await status.textContent()), 'Fresh manual preflight did not detect a later remote URL edit.');
        check('Local: 초기 Pull 이후 생긴 원격 URL 변경도 수동 Push 최신 비교에서 보존',
          portWrites.length === before && test.remoteWrites.length === writesBefore
          && test.remoteRow().deploy_url === 'https://later.example.test'
          && test.localPorts()[0].deployUrl === 'https://fresh.example.test');
        const differences = page.getByTestId('ports-upload-conflicts');
        await differences.locator(':scope > summary').click();
        check('Local: 수동 Push가 발견한 새 URL 충돌의 양쪽 값을 화면에서 확인',
          await differences.getByText('이 기기: https://fresh.example.test', { exact: true }).isVisible()
          && await differences.getByText('원격: https://later.example.test', { exact: true }).isVisible());
      } else {
        await eventually(async () => /충돌|서로 다|비교/.test(await status.textContent()),
          'Different local and newer remote metadata must show an explicit conflict.');
        await page.waitForTimeout(3_500);
        await openProject(page);
        const localMetadata = () => test.localPorts().find(port => port.id === PROJECT_ID);
        check('Local: 초기 메타데이터 충돌은 로컬·원격 category/description과 세대를 보존',
          localMetadata()?.category === '초기 카테고리' && localMetadata()?.description === '초기 설명'
          && localMetadata()?.syncGeneration === '0'
          && test.remoteRow().category === '원격 카테고리'
          && test.remoteRow().description === '원격에서 더 나중에 작성한 설명'
          && test.remoteRow().sync_generation === '5' && portWrites.length === 0
          && await page.locator('.workspace-project-detail').getByText('초기 설명', { exact: true }).isVisible());
        await openGlobalTools(page);
        const differences = page.getByTestId('ports-upload-conflicts');
        await differences.locator(':scope > summary').click();
        check('Local: 1000px·125% 충돌 비교 화면은 로컬·원격 값을 모두 읽기 전용으로 표시',
          await differences.getByText('이 기기: 초기 카테고리', { exact: true }).isVisible()
          && await differences.getByText('원격: 원격 카테고리', { exact: true }).isVisible()
          && await differences.getByText('이 기기: 초기 설명', { exact: true }).isVisible()
          && await differences.getByText('원격: 원격에서 더 나중에 작성한 설명', { exact: true }).isVisible()
          && await differences.locator('input,textarea,button').count() === 0);
        check('Local: 125% 메타데이터 차이 펼침은 가로 넘침 없음',
          await differences.evaluate(element => element.scrollWidth <= element.clientWidth + 1)
          && await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
        await verifyNoticeGeometry(page, scenario, check);
        const readsBefore = test.requests.filter(request => request.path.endsWith('/rest/v1/portmgr_ports')).length;
        await page.getByTestId('ports-supabase-push').click();
        await eventually(() => test.requests.filter(request => request.path.endsWith('/rest/v1/portmgr_ports')).length > readsBefore,
          'Manual Push must re-read the current remote metadata before mutating.');
        await eventually(async () => !await page.getByTestId('ports-supabase-push').isDisabled(),
          'Manual Push did not finish its conflict preflight.');
        await page.waitForTimeout(3_500);
        check('Local: 수동 Push도 최신 메타데이터 충돌을 재확인하고 RPC 없이 중단',
          portWrites.length === 0 && test.remoteWrites.length === 0
          && /충돌|서로 다|비교/.test(await status.textContent())
          && localMetadata()?.description === '초기 설명'
          && test.remoteRow().description === '원격에서 더 나중에 작성한 설명');
      }
      check(`Local: 포트 업로드 fixture ${scenario}는 외부 API·실제 Supabase에 접근하지 않음`,
        test.blockedExternal.length === 0 && test.requests.length > 0
        && test.errors.length === 0, JSON.stringify({ blocked: test.blockedExternal, pageErrors: test.errors }));
    } catch (error) {
      check(`Local: 포트 자동 업로드 ${scenario} UI`, false,
        `${error.message}; status=${test ? await test.status.textContent().catch(() => '') : 'fixture not ready'}`);
    } finally {
      test?.state.releaseBlockedWrite?.();
      test?.state.releaseGitDetection?.();
      await test?.context.close();
    }
  }
}
