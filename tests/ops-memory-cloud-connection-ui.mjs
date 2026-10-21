// Real directory/dialog rendering; no installed app, credentials, or live database.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), 'ops-memory-ui-'));
const server = await createServer({ root, cacheDir: join(temp, 'vite'), server: { host: '127.0.0.1', port: 0, strictPort: true, fs: { allow: [root, temp, await realpath(join(root, 'node_modules'))] } } });
let browser;
try {
  await new Promise((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const moduleSource = await fetch(`${origin}/src/PortalMemoryDirectory.tsx`).then(r => r.text());
  const mainSource = await fetch(`${origin}/src/main.tsx`).then(r => r.text());
  const react = moduleSource.match(/"([^"\n]*react\.js[^"\n]*)"/)?.[1];
  const reactDom = mainSource.match(/"([^"\n]*react-dom_client\.js[^"\n]*)"/)?.[1];
  assert.ok(react && reactDom);
  const opsId = '51c574e8-2109-4065-92e0-66523c206fe8';
  const memories = [
    { memory_id: opsId, project_name: 'AgentsToZ-OPS', github_url: 'https://github.com/fixture/AgentsToZ-OPS' },
    { memory_id: '884575df-63c4-407c-8b43-860d1295e663', project_name: 'demo', github_url: null },
  ].map((entry, index) => ({ ...entry, id: `revision-${index}`, device_id: 'fixture-mac', device_name: 'Fixture Mac', content_hash: `${index}`.repeat(64), created_at: '2026-10-11T00:00:00Z' }));
  const html = `<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
import '/src/index.css';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import(${JSON.stringify(react)});
const {default:ReactDOM}=await import(${JSON.stringify(reactDom)});
document.documentElement.dataset.appTheme='gray';
window.__copies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.__copies.push(text)}});
const exchange=async body=>(await fetch('/__ops-fixture-data',{method:'POST',body:JSON.stringify(body)})).json();
const client={rpc:(name,args)=>exchange({kind:'rpc',name,args}),from:table=>{
const query={};for(const method of ['select','order','limit','eq','in','gt','gte','lt','lte','is','not'])query[method]=()=>query;
query.then=(resolve,reject)=>exchange({kind:'query',table}).then(resolve,reject);return query;}};
const {default:Directory}=await import('/src/PortalMemoryDirectory.tsx');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Directory,{supabaseUrl:'https://fixture.invalid',supabaseKey:'fixture-key',requiresUserSession:false,showToast:()=>{},supabaseClientFactory:()=>client}));
</script>`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1100, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    const errors = [], blocked = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { blocked.push(url.origin); return route.abort(); }
      if (url.pathname === '/__ops-fixture') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.pathname === '/__ops-fixture-data') {
        const body = route.request().postDataJSON();
        const data = body.name === 'portmgr_list_project_memory_head_page'
          ? memories.filter(entry => !body.args.p_after_memory_id || entry.memory_id > body.args.p_after_memory_id)
          : body.table === 'portmgr_remote_devices'
            ? [{ device_id: 'fixture-aws', display_name: 'Fixture AWS', environment_kind: 'aws', agent_version: '4|b1a1h1', default_workspace_root: '/home/ubuntu/projects', registered_at: '2026-10-11T00:00:00Z', revoked_at: null }]
            : [];
        return route.fulfill({ json: { data, error: null } });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { success: false, error: 'Fixture: no live API' } });
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/__ops-fixture`);
    const ops = page.locator(`[data-memory-id="${opsId}"]`);
    await ops.waitFor({ timeout: 20000 }).catch(error => {
      throw new Error(`${error.message}\nBrowser errors: ${JSON.stringify(errors)}\nBlocked: ${JSON.stringify(blocked)}`);
    });
    assert.equal(await ops.getByTestId('portal-memory-purpose').textContent(), 'OPS 운영 기억');
    assert.equal(await page.locator('[data-memory-purpose="dev"]').textContent(), 'DEV 프로젝트 기억');
    await ops.getByTestId('portal-memory-connect-cloud').click();
    const guidance = page.getByTestId('remote-existing-memory-connection');
    await guidance.waitFor();
    await page.locator('p[title="Fixture AWS · AWS Ubuntu"]').waitFor();
    assert.equal(await page.getByTestId('remote-project-setup').count(), 0, 'OPS must not enter generic memory creation automatically');
    assert.match(await guidance.textContent(), /같은 ID/);
    await guidance.getByText('연결 진단 요청 보기', { exact: true }).click();
    await guidance.getByTestId('remote-copy-memory-connection').click();
    const copies = await page.evaluate(() => window.__copies);
    assert.equal(copies.length, 1);
    assert.match(copies[0], new RegExp(opsId));
    assert.match(copies[0], /\.agentstoz-control-profile\.json/);
    assert.match(copies[0], /인증된 사람의 검토/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflow, false, `No horizontal page overflow at ${width}px`);
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
    const output = join(root, 'output/playwright');
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, `ops-memory-cloud-${width}.png`), fullPage: true });
    await context.close();
    console.log(`PASS: OPS directory and AWS guidance at ${width}px`);
  }
} finally {
  await browser?.close();
  await server.close();
  await rm(temp, { recursive: true, force: true });
}
