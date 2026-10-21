/** Mac dialog: 「폰 연결 링크 복사」 appears in the app channel once a QR with a public Supabase key is issued,
 * carries only public values, and is absent for a QR without Supabase. Real React dialog, fixture API only.
 * Run: ./node_modules/.bin/vite --port 9019 --strictPort & PHONE_LINK_TEST_ORIGIN=http://127.0.0.1:9019 bun tests/phone-connect-link-dialog.e2e.mjs */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {buildRemoteControlRelayPairingUrl, REMOTE_CONTROL_RELAY_SCHEMA_VERSION} from '../src/remoteControlRelayContract.ts';
import {parsePhoneConnectLink} from '../src/phoneConnectLink.ts';
const origin = process.env.PHONE_LINK_TEST_ORIGIN || 'http://127.0.0.1:9019';
assert.equal(new URL(origin).hostname, '127.0.0.1'); assert.notEqual(new URL(origin).port, '3001');
const read = async path => { const r = await fetch(origin + path); assert.equal(r.status, 200); return r.text(); };
const [source, main] = await Promise.all([read('/src/InternetQrRemoteControlDialog.tsx'), read('/src/main.tsx')]);
const react = source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom = main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1]; assert.ok(react && reactDom);
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const anon = `${b64({alg: 'HS256', typ: 'JWT'})}.${b64({role: 'anon', iss: 'supabase'})}.c2lnbmF0dXJlc2lnbmF0dXJl`;
const key = new Uint8Array(65); key[0] = 4;
const pairingUrl = supabase => buildRemoteControlRelayPairingUrl('https://portal.example.com/remote/', {
  schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION, hostId: 'host_abcdefghijklmnop', pairingId: 'pair_abcdefghijklmnop',
  pairingSecret: Buffer.alloc(32, 7).toString('base64url'), hostPublicKey: Buffer.from(key).toString('base64url'),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...(supabase ? {supabase} : {}),
});
const page = (url) => `<!doctype html><html data-app-theme="gray"><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const React=(await import(${JSON.stringify(react)})).default;const {createRoot}=(await import(${JSON.stringify(reactDom)})).default;
await import('/src/index.css');
const {InternetQrRemoteControlDialog}=await import('/src/InternetQrRemoteControlDialog.tsx');
const expiresAt=new Date(Date.now()+86400000).toISOString();
const status={enabled:true,state:'pairing',controllerUrl:'https://portal.example.com/remote/',hostExpiresAt:expiresAt,pairingExpiresAt:expiresAt,lastRelayContactAt:null,sessions:[],error:null};
const api={status:async()=>({status:structuredClone(status),suggestedControllerOrigin:null}),issuePairing:async()=>({status:structuredClone(status),pairing:{pairingUrl:${JSON.stringify(url)},expiresAt}})};
createRoot(document.getElementById('root')).render(React.createElement(InternetQrRemoteControlDialog,{open:true,onClose(){},api,hostLabel:'CS의 MacBook\\u202e'}));
</script></html>`;
const browser = await chromium.launch({headless: true});
try {
  for (const withSupabase of [true, false]) {
    const url = pairingUrl(withSupabase ? {url: 'https://example-ref.supabase.co', anonKey: anon} : null);
    const context = await browser.newContext({viewport: {width: 1024, height: 900}, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write']});
    const errors = [];
    await context.route('**/*', route => {
      const target = new URL(route.request().url());
      if (target.origin !== origin) return route.abort();
      if (target.pathname === '/__phone-link-fixture') return route.fulfill({contentType: 'text/html', body: page(url)});
      if (target.pathname.startsWith('/api/')) return route.abort();
      return route.continue();
    });
    const tab = await context.newPage(); tab.on('pageerror', e => errors.push(e.message));
    await tab.goto(origin + '/__phone-link-fixture');
    await tab.getByTestId('phone-connect-link').waitFor();
    assert.equal(await tab.getByTestId('phone-connect-link-copy').count(), 0, 'no link before a QR is issued in this dialog');
    await tab.getByTestId('issue-internet-qr-remote-control-pairing').click();
    if (!withSupabase) {
      await tab.getByTestId('phone-connect-link-unavailable').getByText('Supabase 공개 키가 없어').waitFor();
      assert.equal(await tab.getByTestId('phone-connect-link-copy').count(), 0);
    } else {
      await tab.getByTestId('phone-connect-link-copy').waitFor();
      const text = await tab.getByTestId('phone-connect-link-text').textContent();
      const parsed = parsePhoneConnectLink(text);
      assert.deepEqual(parsed, {portalOrigin: 'https://portal.example.com', supabaseUrl: 'https://example-ref.supabase.co', anonKey: anon, hostName: 'CS의 MacBook'});
      assert.ok(!text.includes(Buffer.alloc(32, 7).toString('base64url')), 'no pairing secret');
      await tab.getByTestId('phone-connect-link-copy').click();
      await tab.getByText('폰 연결 링크를 복사했습니다').waitFor();
      assert.equal(await tab.evaluate(() => navigator.clipboard.readText()), text);
    }
    assert.deepEqual(errors, []);
    console.log(`dialog phone link (${withSupabase ? 'with' : 'without'} Supabase) PASS`);
    await context.close();
  }
} finally { await browser.close(); }
