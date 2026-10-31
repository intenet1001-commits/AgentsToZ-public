/** Isolated rendered-screen fixture. Real HelpdeskAssistHost/Store/verifier; browser/CLI/OAuth are deterministic
 * external boundaries. No installed app, 3001, credentials, actual browser SDK, account or cloud service is used. */
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {HelpdeskAssistHost} from '../../src/helpdeskAssistHost';
import {HelpdeskAssistStore} from '../../src/helpdeskAssistStore';
import {createAssistVerifier} from '../../src/helpdeskAssistVerifiers';
import {AssistHumanControl, type AssistBrowserDriver, type AssistElement} from '../../src/helpdeskAssistBrowser';

const projectRoot = resolve(import.meta.dir, '../..');
const email = 'fixture@example.test', projectId = 'fixture-project-123';
let assets: Promise<{js: string; css: string}> | undefined;
function screenAssets() {
  return assets ??= (async () => {
    const build = await Bun.build({entrypoints: [join(import.meta.dir, 'helpdesk-assist-screen.tsx')], target: 'browser', format: 'esm'});
    if (!build.success) throw Error(build.logs.join('\n'));
    const js = await build.outputs.find(o => o.path.endsWith('.js'))!.text();
    const directory = mkdtempSync(join(tmpdir(), 'atz-assist-css-'));
    try {
      const cssFile = join(directory, 'app.css');
      const child = Bun.spawn([join(projectRoot, 'node_modules/.bin/tailwindcss'), '-i', 'src/index.css', '-o', cssFile],
        {cwd: projectRoot, stdout: 'ignore', stderr: 'pipe'});
      const error = await new Response(child.stderr).text();
      if (await child.exited !== 0) throw Error(error);
      return {js, css: readFileSync(cssFile, 'utf8') + '\n' + (await Promise.all(build.outputs.filter(o => o.path.endsWith('.css')).map(o => o.text()))).join('\n')};
    } finally { rmSync(directory, {recursive: true, force: true}); }
  })();
}
const element = (ref: string, role: string, name: string): AssistElement => ({ref, role, name});

export async function createAssistScreenFixture(options: {holdCheck?: boolean} = {}) {
  const {js, css} = await screenAssets();
  const directory = mkdtempSync(join(tmpdir(), 'atz-assist-screen-'));
  const store = new HelpdeskAssistStore(directory);
  const operations: string[] = [], actions: {kind: string; label: string}[] = [], inFlight = new Set<Promise<unknown>>();
  let clientReady = false, loginComplete = false, waitingCheck = false;
  let releaseCheck!: () => void;
  const checkGate = new Promise<void>(r => { releaseCheck = r; });
  const accounts: Record<string, any>[] = [], logins = new Map<string, Record<string, any>>();
  const pages = new Map<string, {url: string; control: 'agent' | 'human'; enabled: boolean; desktopMenu: boolean}>();
  function driver(): AssistBrowserDriver {
    let runId = '';
    const page = () => pages.get(runId)!;
    return {
      kind: 'ego', ready: async () => ({available: true}),
      attach: async id => { runId = id; if (!pages.has(id)) pages.set(id, {url: 'about:blank', control: 'agent', enabled: false, desktopMenu: false}); return {spaceId: 4242}; },
      navigate: async url => { if (page().control !== 'agent') throw new AssistHumanControl(); page().url = url; actions.push({kind: 'navigate', label: new URL(url).pathname}); return {state: 'confirmed'}; },
      location: async () => { if (page().control !== 'agent') throw new AssistHumanControl(); return page().url; },
      observe: async () => {
        if (page().control !== 'agent') throw new AssistHumanControl();
        const path = new URL(page().url).pathname;
        let elements: AssistElement[] = [];
        if (path.includes('drive.googleapis.com')) elements = [element('@1', 'button', page().enabled ? '관리' : '사용')];
        if (path === '/projectcreate') elements = [element('@2', 'textbox', '프로젝트 이름'), element('@99', 'button', '만들기')];
        if (path === '/auth/branding') elements = [element('@3', 'textbox', '앱 이름'), element('@4', 'combobox', '사용자 지원 이메일'),
          element('@5', 'option', email), element('@6', 'button', '다음'), element('@7', 'radio', '외부'), element('@8', 'radio', '내부'),
          element('@9', 'textbox', '이메일 주소'), element('@99', 'button', '만들기')];
        if (path === '/auth/audience') elements = [element('@10', 'button', '사용자 추가'), element('@11', 'textbox', '이메일'), element('@99', 'button', '저장')];
        if (path === '/auth/clients/create') elements = [element('@12', 'combobox', '애플리케이션 유형'),
          ...(page().desktopMenu ? [element('@13', 'option', '데스크톱 앱')] : []), element('@99', 'button', '만들기')];
        return {title: '격리 Console 경계', elements, secret: false, truncated: false};
      },
      click: async (ref, label) => { if (page().control !== 'agent') throw new AssistHumanControl();
        if (ref === '@99') throw Error('The help must never confirm a create/save action');
        if (ref === '@1') page().enabled = true;
        if (ref === '@12') page().desktopMenu = true;
        actions.push({kind: 'click', label}); return {state: 'dispatched-unverified'};
      },
      fill: async (_ref, label) => { if (page().control !== 'agent') throw new AssistHumanControl(); actions.push({kind: 'fill', label}); return {state: 'dispatched-unverified'}; },
      reviewed: async () => {}, settle: async () => page().control,
      handOff: async () => { if (pages.has(runId)) page().control = 'human'; },
      takeBack: async () => { if (pages.has(runId)) page().control = 'agent'; return 'agent'; },
      finish: async () => { if (pages.has(runId)) page().control = 'human'; },
    };
  }
  async function platform(r: Record<string, any>): Promise<Record<string, any>> {
    if (r.operation === 'list') return {accounts, deviceDefaults: {}};
    if (r.operation === 'google-client-status') return {googleClient: {ready: clientReady, source: clientReady ? 'app' : 'none'}};
    if (r.operation === 'google-client-save') { JSON.parse(r.clientJson); clientReady = true; return {googleClient: {ready: true, source: 'app'}}; }
    if (r.operation === 'setup-status') return {setup: ['github', 'supabase', 'vercel', 'google-workspace'].map(provider => ({provider, installed: true, connected: accounts.filter(a => a.provider === provider).length}))};
    if (['login-start', 'login-add-start', 'login-onboarding-start'].includes(r.operation)) {
      const login = {id: r.requestId, provider: r.provider, purpose: r.purpose, email: r.email ?? email, state: 'waiting', expiresAt: Date.now() + 600_000,
        url: r.provider === 'google-workspace' ? 'https://accounts.google.com/o/oauth2/auth?client_id=synthetic' : 'https://github.com/login/device'};
      logins.set(login.id, login); return {login};
    }
    if (r.operation === 'login-status') {
      const login = logins.get(r.loginId); if (!login) throw Error('Missing fixture login');
      if (loginComplete && login.state !== 'completed') {
        const account = {id: 'pcli_' + login.id, provider: login.provider, source: 'managed', label: email, verifiedEmail: email, identity: email, state: 'ready', revision: 'fixture-1'};
        accounts.push(account); Object.assign(login, {state: 'completed', email, url: undefined, account});
      }
      return {login};
    }
    if (r.operation === 'check') { const account = accounts.find(a => a.id === r.accountId); if (!account) throw Error('Missing fixture account'); return {account}; }
    if (r.operation === 'login-cancel') { const login = logins.get(r.loginId); if (login) login.state = 'cancelled'; return {login}; }
    throw Error('Unsupported isolated platform operation: ' + r.operation);
  }
  const verify = createAssistVerifier({platform, ai: async () => 'signed-out'});
  const host = new HelpdeskAssistHost({store, drivers: {ego: driver, agentstoz: () => ({...driver(), ready: async () => ({available: false, reason: '이 웹 fixture에는 네이티브 CEF 뷰가 없습니다.'})})},
    verify: async (id, run) => { if (options.holdCheck && !waitingCheck) { waitingCheck = true; await checkGate; } return verify(id, run); }});
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: async req => {
    const path = new URL(req.url).pathname;
    try {
      if (path === '/assist' && req.method === 'POST') {
        const body = await req.json(); operations.push(body.operation);
        const task = host.handle(body); inFlight.add(task);
        try { return Response.json(await task, {headers: {'Cache-Control': 'no-store'}}); } finally { inFlight.delete(task); }
      }
      if (path === '/api/agent-runtime/platform-cli') { const body = await req.json(); operations.push('platform:' + body.operation); return Response.json(await platform(body)); }
      if (path === '/api/browser-profiles') return Response.json({profiles: []});
      if (path === '/api/open-browser') return Response.json({success: true, verified: true});
      if (path === '/fixture/state') return Response.json({run: store.latest(), operations, actions, waitingCheck, clientReady, loginComplete});
      if (path === '/fixture' && req.method === 'POST') {
        const body = await req.json();
        if (body.operation === 'complete-login') loginComplete = true;
        else if (body.operation === 'complete-project') { for (const page of pages.values()) if (page.url.includes('/projectcreate')) page.url = 'https://console.cloud.google.com/home/dashboard?project=' + projectId; }
        else if (body.operation === 'release-check') releaseCheck();
        return Response.json({ok: true});
      }
      if (path === '/app.js') return new Response(js, {headers: {'Content-Type': 'text/javascript'}});
      if (path === '/app.css') return new Response(css, {headers: {'Content-Type': 'text/css'}});
      if (path.startsWith('/api/')) return Response.json({error: 'Isolated fixture has no such API'}, {status: 404});
      return new Response('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>헬프데스크 브라우저 지원 · 격리 시험</title><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>', {headers: {'Content-Type': 'text/html; charset=utf-8'}});
    } catch (error) { return Response.json({error: error instanceof Error ? error.message : 'Fixture error'}, {status: 409}); }
  }});
  return {server, host, url: server.url.href, async close() { releaseCheck(); await Promise.allSettled([...inFlight]); server.stop(true); host.shutdown(); rmSync(directory, {recursive: true, force: true}); }};
}

if (import.meta.main) {
  const fixture = await createAssistScreenFixture();
  console.log(JSON.stringify({fixture: 'helpdesk-assist', url: fixture.url, scope: 'real UI/host, synthetic external boundaries; no actual OAuth'}));
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (!closing) { closing = true; void fixture.close().then(() => process.exit(0)); } });
}
