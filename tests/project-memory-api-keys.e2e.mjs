/** Real PortalMemoryDirectory + ProjectMemoryApiKeys with an isolated Supabase RPC fixture.
 * Start Vite on 127.0.0.1:9000, then run this file with Node. All API/network calls
 * and clipboard writes are intercepted. Issued/revealed values are dummy fixture keys.
 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const origin = process.env.MEMORY_KEYS_TEST_ORIGIN || 'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname, '127.0.0.1');
const output = new URL('../output/playwright/', import.meta.url);
await mkdir(output, {recursive: true});
const moduleSource = await fetch(`${origin}/src/PortalMemoryDirectory.tsx`).then(r => {assert.equal(r.status, 200, 'Start the isolated Vite fixture first'); return r.text();});
const mainSource = await fetch(`${origin}/src/main.tsx`).then(r => r.text());
const react = moduleSource.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom = mainSource.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react && reactDom, 'Use each dependency’s actual Vite version');
const memories = ['A', 'B', 'C'].map((name, index) => ({
  id: `fixture-revision-${index}`, memory_id: `fixture-memory-${name.toLowerCase()}`, project_name: `기억 ${name}`,
  github_url: null, device_id: 'fixture-device', device_name: 'Fixture Mac', content_hash: `${index}`.repeat(64),
  created_at: `2026-09-0${index + 1}T00:00:00Z`,
}));
const TOKEN = 'ab'.repeat(32);
const initialKey = {id: 'fixture-key-one', label: 'Fixture reader', token: TOKEN, memoryIds: ['fixture-memory-a'], expiresAt: '2026-12-01T00:00:00Z', lastUsedAt: null};
const html = `<!doctype html><meta charset="utf-8"><div id="root" style="padding:16px"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
import React from ${JSON.stringify(react)};
import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';
import {applyZoomToDocument} from '/src/uiZoom.ts';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
document.documentElement.dataset.appTheme='gray';localStorage.setItem('portmanager-ui-zoom','1.25');applyZoomToDocument(document,1.25);
window.__clipboardWrites=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__clipboardWrites.push(text);throw new Error('Clipboard writes are forbidden in this fixture')}}});
const exchange=async payload=>(await fetch('/__memory-key-fixture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).json();
const client={rpc:(name,args)=>exchange({kind:'rpc',name,args}),from:table=>{
 const query={};for(const method of ['select','order','limit','eq','in','gt','gte','lt','lte','is','not'])query[method]=()=>query;
 query.then=(resolve,reject)=>exchange({kind:'query',table}).then(resolve,reject);return query;
}};
const {default:PortalMemoryDirectory}=await import('/src/PortalMemoryDirectory.tsx');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(PortalMemoryDirectory,{supabaseUrl:'https://fixture.invalid',supabaseKey:'fixture-public-only',deviceId:'fixture-device',deviceName:'Fixture Mac',showToast:()=>{},requiresUserSession:false,supabaseClientFactory:()=>client}));
</script>`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {if (await predicate()) return; await sleep(10);}
  assert.fail(message);
}
const browser = await chromium.launch({headless: true});
const results = [];
async function fixture(options = {}) {
  const directoryMemories = options.many ? Array.from({length: 105}, (_, index) => ({...memories[0], id: `many-revision-${index}`, memory_id: `many-memory-${String(index).padStart(3, '0')}`, project_name: `대량 기억 ${index}`})) : memories;
  const context = await browser.newContext({viewport: {width: 1000, height: 1050}, serviceWorkers: 'block'});
  const state = {calls: [], blocked: [], errors: [], keys: options.empty ? [] : [structuredClone(initialKey)], failList: !!options.failList};
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) {state.blocked.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort('blockedbyclient');}
    if (url.pathname === '/__memory-key-page') return route.fulfill({contentType: 'text/html', body: html});
    if (url.pathname === '/__memory-key-fixture') {
      const body = request.postDataJSON(); state.calls.push(body);
      const respond = payload => route.fulfill({json: payload});
      if (body.kind === 'query' && /^portmgr_/.test(body.table)) return respond({data: [], error: null});
      if (body.kind === 'rpc' && body.name === 'portmgr_list_project_memory_head_page') return respond({data: directoryMemories.filter(m => body.args.p_after_memory_id === null || m.memory_id > body.args.p_after_memory_id), error: null});
      if (body.kind === 'rpc' && body.name === 'portmgr_project_memory_feed_keys_manage') {
        const args = body.args;
        if (args.p_action === 'list') return respond(state.failList ? {data: null, error: {message: 'Fixture key-list unavailable'}} : {data: state.keys, error: null});
        if (args.p_action === 'issue') {
          assert.match(args.p_token, /^[a-f0-9]{64}$/);
          // The locally generated value is not issued remotely or shown as a real key.
          state.keys.push({...initialKey, id: 'fixture-issued-key', label: args.p_label, memoryIds: args.p_memory_ids, token: 'cd'.repeat(32)});
          return respond({data: state.keys, error: null});
        }
      }
      state.blocked.push(`Unmocked RPC ${body.name ?? body.table}`);
      return respond({data: null, error: {message: 'Unexpected fixture mutation'}});
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/rest/')) {state.blocked.push(`${request.method()} ${url.pathname}`); return route.abort('blockedbyclient');}
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  await page.goto(`${origin}/__memory-key-page`);
  const panel = page.getByTestId('project-memory-api-keys');
  await panel.waitFor({timeout: 12000}).catch(error => {throw new Error(error.message + '\nBrowser: ' + JSON.stringify(state.errors) + '\nBlocked: ' + JSON.stringify(state.blocked));});
  await until(async () => await page.getByTestId('portal-memory-row').count() === Math.min(15, directoryMemories.length), 'The actual memory directory must load the mock memories');
  return {context, page, panel, state};
}
const keyCalls = state => state.calls.filter(call => call.name === 'portmgr_project_memory_feed_keys_manage');
async function expand(panel) {await panel.getByRole('button', {name: '연결 키 관리', exact: true}).click(); await panel.getByRole('button', {name: '목록 새로고침', exact: true}).waitFor();}
async function run(name, execute, options) {
  let f;
  try {
    f = await fixture(options); await execute(f);
    assert.deepEqual(f.state.blocked, [], 'No actual API, external endpoint, or unplanned RPC may be called');
    assert.deepEqual(f.state.errors, [], 'The real components must not throw');
    assert.deepEqual(await f.page.evaluate(() => window.__clipboardWrites), [], 'The test must not copy a token into the OS clipboard');
    results.push({name, status: 'passed'}); console.log(`PASS ${name}`);
  } catch (error) {
    results.push({name, status: 'failed', error: error.message}); console.error(`FAIL ${name}: ${error.message}`);
    await f?.page.screenshot({path: new URL(`memory-keys-${name}.png`, output).pathname, fullPage: true}).catch(() => {});
  } finally {await f?.context.close();}
}

try {
  await run('bulk-selection-obeys-server-100-memory-limit', async ({panel, state}) => {
    await expand(panel);
    assert.equal(await panel.getByRole('checkbox').count(), 105);
    await panel.getByRole('button', {name: '최대 100개 선택', exact: true}).click();
    assert.equal(await panel.getByRole('checkbox', {checked: true}).count(), 100);
    assert.equal(await panel.getByRole('checkbox', {checked: false, disabled: true}).count(), 5);
    await panel.getByRole('checkbox', {checked: true}).first().uncheck();
    assert.equal(await panel.getByRole('checkbox', {disabled: true}).count(), 0);
    await panel.getByRole('button', {name: '전체해제', exact: true}).click();
    assert.equal(await panel.getByRole('checkbox', {checked: true}).count(), 0);
    assert.deepEqual(keyCalls(state).map(call => call.args.p_action), ['list']);
  }, {many: true});
  await run('select-all-and-clear-without-issuing', async ({panel, state}) => {
    await expand(panel);
    await panel.getByRole('button', {name: '전체선택', exact: true}).click();
    assert.equal(await panel.getByRole('checkbox', {checked: true}).count(), 3);
    assert.ok(await panel.getByText('3 / 3개 선택', {exact: true}).isVisible());
    await panel.getByRole('button', {name: '전체해제', exact: true}).click();
    assert.equal(await panel.getByRole('checkbox', {checked: true}).count(), 0);
    assert.deepEqual(keyCalls(state).map(call => call.args.p_action), ['list']);
  });
  await run('top-level-discovery-and-list-only-expansion', async ({page, panel, state}) => {
    assert.equal(await page.getByTestId('project-memory-api-keys').count(), 1, 'There must be one key manager, not duplicate top and bottom controls');
    assert.ok(await panel.getByText('외부 앱 연결 키', {exact: true}).isVisible());
    assert.ok(await panel.getByText('장기기억 본문 · 읽기 전용', {exact: true}).isVisible());
    assert.equal(keyCalls(state).length, 0, 'Mounting the directory must not even list keys before explicit expansion');
    assert.ok(await page.evaluate(() => {
      const directory = document.querySelector('[data-testid="portal-memory-directory"]');
      const header = directory.querySelector('header'); const keys = directory.querySelector('[data-testid="project-memory-api-keys"]'); const row = directory.querySelector('[data-testid="portal-memory-row"]');
      return !!(header.compareDocumentPosition(keys) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(keys.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), 'The key manager must follow the header and precede every memory card');
    const initialBox = await panel.boundingBox();
    assert.ok(initialBox.y >= 0 && initialBox.y + initialBox.height <= 1050, 'The collapsed manager must be discoverable without scrolling past the directory');
    await expand(panel);
    assert.deepEqual(keyCalls(state).map(call => call.args), [{p_action: 'list', p_key_id: null, p_label: null, p_token: null, p_memory_ids: null}]);
    assert.equal(await panel.getByRole('checkbox').count(), 3);
    assert.ok(!(await panel.textContent()).includes(TOKEN), 'Listed tokens must remain masked by default');
  });

  await run('issue-exact-selected-memory-ids', async ({panel, state}) => {
    await expand(panel);
    const issue = panel.getByRole('button', {name: '키 발급', exact: true});
    assert.ok(await issue.isDisabled());
    await panel.getByLabel('연결할 앱 이름', {exact: true}).fill('  Fixture 선택 A C  ');
    assert.ok(await issue.isDisabled(), 'A label alone must not implicitly grant every memory');
    await panel.getByRole('checkbox', {name: '기억 A', exact: true}).check();
    await panel.getByRole('checkbox', {name: '기억 C', exact: true}).check();
    assert.equal(keyCalls(state).length, 1, 'Changing selection must not issue or rotate a key');
    await issue.click();
    await until(() => keyCalls(state).length === 2, 'Explicit issue must send exactly one mocked RPC');
    const args = keyCalls(state)[1].args;
    assert.deepEqual({...args, p_token: '<fixture-generated>'}, {p_action: 'issue', p_key_id: null, p_label: 'Fixture 선택 A C', p_token: '<fixture-generated>', p_memory_ids: ['fixture-memory-a', 'fixture-memory-c']});
    await until(async () => await panel.getByLabel('연결할 앱 이름', {exact: true}).inputValue() === '', 'Successful issue must clear the draft');
    assert.equal(await panel.getByRole('checkbox').evaluateAll(inputs => inputs.filter(input => input.checked).length), 0);
    assert.ok(!(await panel.textContent()).includes('cd'.repeat(32)), 'A newly issued dummy token must not be automatically revealed');
  }, {empty: true});

  await run('mask-reveal-collapse-and-reopen', async ({panel, state}) => {
    await expand(panel);
    assert.ok(!(await panel.textContent()).includes(TOKEN));
    await panel.getByRole('button', {name: '키 보기', exact: true}).click();
    await until(async () => (await panel.textContent()).includes(TOKEN), 'Explicit reveal must display the dummy key');
    await panel.getByRole('button', {name: /접기/}).click();
    assert.ok(!(await panel.textContent()).includes(TOKEN), 'Collapsing the manager must hide a revealed token');
    await expand(panel);
    assert.ok(!(await panel.textContent()).includes(TOKEN), 'Reopening must not retain a previous reveal');
    assert.deepEqual(keyCalls(state).map(call => call.args.p_action), ['list', 'list']);
  });

  await run('cancel-rotate-and-revoke-without-rpc', async ({page, panel, state}) => {
    await expand(panel);
    const messages = [];
    for (const label of ['재발급', '연결 해제']) {
      page.once('dialog', async dialog => {messages.push(dialog.message()); await dialog.dismiss();});
      await panel.getByRole('button', {name: label, exact: true}).click();
    }
    assert.equal(messages.length, 2);
    assert.ok(messages.every(message => message.includes('Fixture reader')));
    assert.deepEqual(keyCalls(state).map(call => call.args.p_action), ['list'], 'Cancelled key mutations must issue zero rotate/revoke RPCs');
    assert.ok(!(await panel.textContent()).includes(TOKEN));
  });

  await run('failure-is-not-an-empty-key-list', async ({panel, state}) => {
    await expand(panel);
    await until(async () => (await panel.textContent()).includes('Fixture key-list unavailable'), 'A failed list must explain the failure');
    assert.equal(await panel.getByText('발급한 키가 없습니다.', {exact: true}).count(), 0, 'An unreadable key list is not proof that no keys exist');
    await panel.getByLabel('연결할 앱 이름', {exact: true}).fill('Fixture failure');
    await panel.getByRole('checkbox', {name: '기억 A', exact: true}).check();
    assert.ok(await panel.getByRole('button', {name: '키 발급', exact: true}).isDisabled(), 'Initial list failure must not enable issuing');
    state.failList = false;
    await panel.getByRole('button', {name: '목록 새로고침', exact: true}).click();
    await panel.getByText('발급한 키가 없습니다.', {exact: true}).waitFor();
    assert.ok(!(await panel.textContent()).includes('Fixture key-list unavailable'));
    state.failList = true;
    await panel.getByRole('button', {name: '목록 새로고침', exact: true}).click();
    await until(async () => (await panel.textContent()).includes('Fixture key-list unavailable'), 'A later failed refresh must also remain distinguishable');
    assert.equal(await panel.getByText('발급한 키가 없습니다.', {exact: true}).count(), 0, 'A stale empty result must not be presented as the failed refresh result');
  }, {empty: true, failList: true});

  await run('layout-at-saved-125-percent', async ({page, panel}) => {
    await expand(panel);
    await panel.getByLabel('연결할 앱 이름', {exact: true}).fill('긴 외부 앱 이름을 입력한 레이아웃 확인');
    await panel.getByRole('checkbox', {name: '기억 A', exact: true}).check();
    await panel.scrollIntoViewIfNeeded();
    const layout = await panel.evaluate(card => {
      const box = card.getBoundingClientRect();
      return {width: innerWidth, scrollWidth: document.documentElement.scrollWidth, left: box.left, right: box.right, overflow: card.scrollWidth - card.clientWidth, zoom: document.getElementById('root').style.transform};
    });
    assert.equal(layout.zoom, 'scale(1.25)');
    assert.ok(layout.scrollWidth <= layout.width + 2 && layout.left >= -2 && layout.right <= layout.width + 2 && layout.overflow <= 2, JSON.stringify(layout));
    assert.ok(!(await panel.textContent()).includes(TOKEN));
    await page.screenshot({path: new URL('project-memory-external-app-keys-125.png', output).pathname, fullPage: true});
  });
} finally {
  await browser.close();
  await writeFile(new URL('project-memory-api-keys-results.json', output), JSON.stringify({generatedAt: new Date().toISOString(), results}, null, 2) + '\n');
}
console.log(`${results.filter(r => r.status === 'passed').length}/${results.length} project-memory key regressions passed`);
if (results.some(r => r.status === 'failed')) process.exitCode = 1;
