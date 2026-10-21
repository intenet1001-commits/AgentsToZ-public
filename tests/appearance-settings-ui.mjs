/** Browser regression for the Mac settings-return defect.
 * Native WKWebView reproduction additionally lives in the improvement evidence:
 * closing a dialog nested in the sidebar dropped the sibling project body from AX.
 * The document-level modal boundary below is intentional; DOM snapshots alone do
 * not prove macOS accessibility, so keep installed/native verification separate.
 */
import {chromium, webkit} from 'playwright';
import assert from 'node:assert/strict';

const origin = process.argv[2];
if (!origin || new URL(origin).hostname !== '127.0.0.1' || new URL(origin).port === '3001') throw Error('Expected an owned fixture origin');
const source=await fetch(origin+'/src/AppearanceSettings.tsx').then(r=>r.text());
const main=await fetch(origin+'/src/main.tsx').then(r=>r.text());
const react=source.match(/"([^"\n]*\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom=main.match(/"([^"\n]*\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react&&reactDom,'Use this fixture server’s actual dependency URLs');
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>설정 복귀 회귀 검사</title>
<div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import React from ${JSON.stringify(react)};
import ReactDOM from ${JSON.stringify(reactDom)};
const {AppearanceSettings}=await import('/src/AppearanceSettings.tsx');
import '/src/index.css';import '/src/workspaceDesign.css';
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('div',{className:'workspace-shell',style:{height:'100vh'}},
 React.createElement('aside',{'data-testid':'top-toolbar'},React.createElement('h1',null,'QA 목록'),
  React.createElement('div',{className:'workspace-sidebar-host'}),
  React.createElement('div',{className:'workspace-sidebar-footer'},React.createElement(AppearanceSettings,{language:'ko'}))),
 React.createElement('main',{className:'workspace-content'},React.createElement('h2',null,'QA 프로젝트 본문'),
  React.createElement('label',null,'미전송 초안',React.createElement('input',{'aria-label':'미전송 초안',defaultValue:''})),
  React.createElement('button',{type:'button'},'본문 다음 동작'))));
</script></html>`;

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({viewport:{width:1100,height:900}});
    const errors = [], unexpected = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { unexpected.push(url.origin); return route.abort(); }
      if (url.pathname === '/__appearance-settings') return route.fulfill({contentType:'text/html',body:html});
      if (url.pathname.startsWith('/api/')) {
        if(url.pathname==='/api/browser-profiles') return route.fulfill({json:[]});
        assert.equal(url.pathname, '/api/agent-runtime/platform-cli');
        return route.fulfill({json:{accounts:[],deviceDefaults:{}}});
      }
      return route.continue();
    });
    await page.goto(origin + '/__appearance-settings');
    await page.getByRole('heading',{name:'QA 프로젝트 본문'}).waitFor({timeout:15000}).catch(error=>{throw Error(name+': fixture did not mount: '+errors.join('; '),{cause:error});});
    const opener=page.getByTestId('appearance-settings'), draft=page.getByRole('textbox',{name:'미전송 초안'});
    await draft.fill('한글 미전송 초안 Q90');
    await draft.evaluate(el => {window.__originalDraft=el;});
    for (let cycle=0;cycle<6;cycle++) {
      console.log(name+': cycle '+(cycle+1));
      await opener.focus();
      await page.keyboard.press('Enter');
      const modal=page.getByRole('dialog',{name:'앱 설정',exact:true});
      await modal.waitFor({state:'visible',timeout:5000}).catch(error=>{throw Error(name+': open failed; '+JSON.stringify(errors)+' '+JSON.stringify(page.url()),{cause:error});});
      // Preserve the AX boundary verified on the actual Mac, even if a browser's
      // DOM-based accessibility snapshot would accept the nested version.
      assert.equal(await modal.evaluate(el => el.parentElement===document.body),true,
        name+': sidebar modal must not retain the sibling body AX exclusion');
      assert.equal(await modal.evaluate(el => el.matches(':modal')),true);
      await draft.evaluate(el => el.focus());
      assert.equal(await modal.evaluate(el => el.contains(document.activeElement)),true,'background cannot take focus');
      for(let key=0;key<8;key++) await page.keyboard.press('Tab');
      assert.equal(await modal.evaluate(el => el.contains(document.activeElement)),true,'focus stays in settings');
      if(cycle%2) await page.keyboard.press('Escape');
      else await modal.getByRole('button',{name:'닫기',exact:true}).click();
      await modal.waitFor({state:'hidden'});
      assert.equal(await draft.inputValue(),'한글 미전송 초안 Q90');
      assert.equal(await draft.evaluate(el => el===window.__originalDraft),true,'return preserves the same draft node');
      assert.equal(await page.locator('dialog:modal').count(),0);
      await page.getByRole('button',{name:'본문 다음 동작'}).focus();
      assert.equal(await page.getByRole('button',{name:'본문 다음 동작'}).evaluate(el=>el===document.activeElement),true);
    }
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
    console.log(name+': settings open/close/Escape, modal isolation, same draft and body focus: 6/6');
  } finally {await browser.close();}
}
