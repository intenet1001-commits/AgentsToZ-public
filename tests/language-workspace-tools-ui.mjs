// Real workspace controls with synthetic preference readers; never writes host settings.
import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
import {t} from '../src/i18n.ts';
const origin=process.argv[2];
if(!origin||new URL(origin).hostname!=='127.0.0.1'||new URL(origin).port==='3001')throw Error('Expected an owned fixture origin');
const source=await fetch(origin+'/src/LaunchEffortControls.tsx').then(r=>r.text());
const main=await fetch(origin+'/src/main.tsx').then(r=>r.text());
const react=source.match(/"([^"\n]*\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom=main.match(/"([^"\n]*\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react&&reactDom,'Use the fixture dependency URLs');
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';
const {LaunchEffortControls}=await import('/src/LaunchEffortControls.tsx');
const {WorkspaceRootRow}=await import('/src/components/WorkspaceRootRow.tsx');
const {WorkspaceThemePicker}=await import('/src/WorkspaceThemePicker.tsx');
const {WorkspaceTools}=await import('/src/components/WorkspaceTools.tsx');
const {AppLanguagePicker,useAppLanguage}=await import('/src/useAppLanguage.tsx');
const {t}=await import('/src/i18n.ts');
window.__mode='auto';window.__desktop='recommend';window.__calls=[];window.__desktopCalls=[];window.__actions=[];
const request=async next=>{window.__calls.push(next??null);if(next)window.__mode=next;return window.__mode;};
const requestDesktop=async next=>{window.__desktopCalls.push(next??null);if(next)window.__desktop=next;return window.__desktop;};
const root={id:'fixture-root',name:'Dev projects',path:'/fixture/projects'};
function Harness(){const [lang]=useAppLanguage();return React.createElement('main',{style:{maxWidth:1000,padding:12,margin:'auto'}},
 React.createElement(AppLanguagePicker),
 React.createElement('header',{style:{whiteSpace:'nowrap'}},React.createElement(WorkspaceTools,{label:t(lang,'launchTools')},React.createElement(LaunchEffortControls,{lang,request,requestDesktop}))),
 React.createElement(WorkspaceRootRow,{language:lang,root,index:0,total:2,projectCount:2,monoFont:'monospace',onMove:(...args)=>window.__actions.push(['move',...args]),onNewFolder:id=>window.__actions.push(['new',id]),onRemove:id=>window.__actions.push(['remove',id])}),
 React.createElement(WorkspaceThemePicker));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Harness)));
</script>`;
for(const [engineName,engine] of Object.entries({chromium,webkit})){
 const browser=await engine.launch();
 try{for(const width of [1000,390,320]){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
  try{
   const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[],unexpected=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin||url.pathname.startsWith('/api/')){unexpected.push(url.pathname);return route.abort();}
    if(url.pathname==='/__language-tools')return route.fulfill({contentType:'text/html',body:html});
    return route.continue();
   });
   await page.goto(origin+'/__language-tools');
   const picker=page.getByTestId('app-language'),tools=page.locator('details.workspace-tools');
   await picker.waitFor();await tools.locator(':scope > summary').click();
   await page.getByRole('button',{name:'추천만 받기',exact:true}).click();
   await page.waitForFunction(()=>window.__mode==='recommend');
   await page.getByTestId('desktop-effort-off').click();await page.waitForFunction(()=>window.__desktop==='off');
   if(await tools.evaluate(el=>el.open))await tools.locator(':scope > summary').click();
   await page.locator('.workspace-theme > summary').click();await page.getByRole('button',{name:'어둡게',exact:true}).click();
   await page.waitForFunction(()=>document.documentElement.dataset.appTheme==='dark');
   for(const [lang,automatic,newFolder,display] of [
    ['ko','에포트 자동 조절','새 폴더','화면 설정'],
    ['en','Automatic effort','New folder','Display settings'],
    ['ja','推論レベルの自動調整','新しいフォルダー','表示設定'],
    ['zh-CN','自动调整推理强度','新建文件夹','显示设置'],
    ['es','Esfuerzo automático','Nueva carpeta','Ajustes de pantalla'],
    ['fr','Effort automatique','Nouveau dossier','Réglages d’affichage'],
    ['de','Automatischer Denkaufwand','Neuer Ordner','Anzeigeeinstellungen'],
   ]){
    await picker.selectOption(lang);
    if(!await tools.evaluate(el=>el.open))await tools.locator(':scope > summary').click();
    const toggle=page.getByRole('switch',{name:automatic,exact:true});await toggle.waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'),'false');assert.equal(await toggle.innerText(),t(lang,'effortAdviceOnly'));
    assert.equal(await page.getByTestId('desktop-effort-off').getAttribute('aria-checked'),'true');
    assert.equal(await page.locator('html').getAttribute('lang'),lang);
    assert.equal(await page.getByRole('button',{name:newFolder,exact:true}).count(),1);
    assert.equal(await page.getByTestId('workspace-root-move-down-fixture-root').getAttribute('aria-label'),t(lang,'rootMoveDown',{name:'Dev projects'}));
    assert.equal(await page.getByTestId('workspace-root-remove-fixture-root').getAttribute('title'),t(lang,'rootRemoveHelp'));
    const paragraphs=await page.getByTestId('launch-effort-controls').locator('p').evaluateAll(nodes=>nodes.map(n=>({width:n.clientWidth,content:n.scrollWidth})));
    assert.ok(paragraphs.every(p=>p.content<=p.width+1),'Long help wraps inside the toolbar');
    await tools.locator(':scope > summary').click();
    const themeTrigger=page.locator('.workspace-theme > summary');
    assert.equal(await themeTrigger.getAttribute('aria-label'),display);
    await themeTrigger.click();
    await page.getByRole('group',{name:t(lang,'screenTheme'),exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:t(lang,'themeDarkShort'),exact:true}).getAttribute('aria-pressed'),'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.appTheme),'dark','Language changes preserve the theme');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Translated workspace controls fit the viewport');
   }
   assert.deepEqual(await page.evaluate(()=>window.__calls.filter(x=>x!==null)),['recommend'],'Switching languages never changes CLI effort');
   assert.deepEqual(await page.evaluate(()=>window.__desktopCalls.filter(x=>x!==null)),['off'],'Switching languages never changes desktop advice');
   await page.getByTestId('workspace-root-move-down-fixture-root').click();
   await page.getByRole('button',{name:'Neuer Ordner',exact:true}).click();await page.getByTestId('workspace-root-remove-fixture-root').click();
   assert.deepEqual(await page.evaluate(()=>window.__actions),[['move','fixture-root',1],['new','fixture-root'],['remove','fixture-root']]);
   assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
   console.log(engineName+' '+width+': seven workspace languages, preserved effort/theme, root actions and wrapping passed');
  }finally{await context.close();}
 }}finally{await browser.close();}
}
