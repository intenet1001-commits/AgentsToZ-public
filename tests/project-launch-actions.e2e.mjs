/** Real React, fixture-only callbacks. No host API, project, CLI or AI is accessed.
 * PROJECT_LAUNCH_TEST_ORIGIN=http://127.0.0.1:9017 node tests/project-launch-actions.e2e.mjs
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const origin=process.env.PROJECT_LAUNCH_TEST_ORIGIN||'http://127.0.0.1:9017';
assert.equal(new URL(origin).hostname,'127.0.0.1');
assert.notEqual(new URL(origin).port,'3001','Never run against the installed sidecar');
const read=async path=>{const response=await fetch(origin+path);assert.equal(response.status,200);return response.text();};
const [source,main]=await Promise.all([read('/src/ProjectLaunchActions.tsx'),read('/src/main.tsx')]);
const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react&&reactDom);
const html=`<!doctype html><html data-app-theme="gray"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;padding:12px;font:14px var(--font-sans,system-ui);background:var(--bg-base);color:var(--text-primary)}#root{max-width:800px;margin:0 auto}button:disabled{cursor:default;opacity:.55}</style><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const React=(await import(${JSON.stringify(react)})).default;
const {createRoot}=(await import(${JSON.stringify(reactDom)})).default;
await import('/src/appearanceTokens.css');
const {ProjectLaunchActions}=await import('/src/ProjectLaunchActions.tsx');
const root=createRoot(document.getElementById('root'));
window.fixture={loads:[],workroom:[],codex:[],failWorkroom:false,hold:false,release:null,mount(project,state='none',appAvailable=true){
const current=this;root.render(React.createElement(ProjectLaunchActions,{projectKey:project,testId:'launch',
loadCodex:async()=>{current.loads.push({project,state});return{recentState:state,appAvailable};},
onWorkroom:async agent=>{current.workroom.push({project,agent});if(current.failWorkroom)throw Error('CLI 설치를 확인하세요 · fixture');},
onCodex:async()=>{current.codex.push({project});if(current.hold)await new Promise(resolve=>{current.release=resolve;});return{mode:state==='found'?'reopened':'prepared',projectConfirmed:true,deliveryRequested:true,selectionVerified:false};}}));
}};window.fixture.mount('project-A');
</script></html>`;
const browser=await chromium.launch({headless:true});
const output=new URL('../output/playwright/',import.meta.url);await mkdir(output,{recursive:true});
const results=[];
try{
for(const width of [375,1024]){
  const context=await browser.newContext({viewport:{width,height:850},serviceWorkers:'block'});
  const unexpected=[],errors=[];
  await context.route('**/*',route=>{const url=new URL(route.request().url());
    if(url.origin!==origin||url.pathname.startsWith('/api/')){unexpected.push(url.pathname);return route.abort();}
    if(url.pathname==='/__project-launch-fixture')return route.fulfill({contentType:'text/html',body:html});
    return route.continue();
  });
  const page=await context.newPage();page.on('pageerror',error=>{errors.push(error.message);console.error('Fixture browser error:',error.message);});
  await page.goto(origin+'/__project-launch-fixture');
  const codex=page.getByTestId('launch-codex'),workroom=page.getByTestId('launch-workroom');
  await page.getByRole('button',{name:'Mac의 Codex 앱에서 처음 열기',exact:true}).waitFor({timeout:10000});
  assert.deepEqual(await page.evaluate(()=>[fixture.workroom.length,fixture.codex.length]),[0,0],'mount never launches');
  assert.match(await page.getByTestId('launch').textContent(),/고정 안내문을 1회/);
  await page.getByRole('combobox').selectOption('claude');
  await page.evaluate(()=>{fixture.failWorkroom=true;});await workroom.click();
  await page.getByRole('alert').waitFor();
  assert.deepEqual(await page.evaluate(()=>fixture.workroom),[{project:'project-A',agent:'claude'}]);
  await page.getByRole('combobox').selectOption('hermes');
  assert.match(await page.getByRole('alert').textContent(),/CLI 설치/,'error survives rerender');
  await page.evaluate(()=>{fixture.failWorkroom=false;});await workroom.click();
  await page.getByRole('alert').waitFor({state:'hidden'});
  await codex.click();await page.getByRole('button',{name:'Mac의 Codex 앱에서 이어 열기',exact:true}).waitFor();
  assert.match(await page.getByRole('status').textContent(),/열기 요청을 보냈습니다/);
  assert.deepEqual(await page.evaluate(()=>fixture.codex),[{project:'project-A'}]);
  await page.evaluate(()=>fixture.mount('project-B','found'));await page.getByRole('button',{name:'Mac의 Codex 앱에서 이어 열기',exact:true}).waitFor();
  await codex.click();await page.getByRole('status').waitFor();
  assert.deepEqual(await page.evaluate(()=>fixture.codex.at(-1)),{project:'project-B'});
  await page.evaluate(()=>fixture.mount('project-C','unavailable'));await page.getByRole('button',{name:'Codex 연결 다시 확인',exact:true}).waitFor();
  const before=await page.evaluate(()=>({loads:fixture.loads.length,codex:fixture.codex.length}));await codex.click();
  await page.waitForFunction(count=>fixture.loads.length>count,before.loads);
  assert.equal(await page.evaluate(()=>fixture.codex.length),before.codex,'unknown only rechecks metadata');
  await page.evaluate(()=>{fixture.hold=true;fixture.mount('project-D','none');});await page.getByRole('button',{name:'Mac의 Codex 앱에서 처음 열기',exact:true}).waitFor();
  await codex.evaluate(button=>{button.click();button.click();});await page.waitForFunction(()=>fixture.release!==null);
  assert.equal(await page.evaluate(()=>fixture.codex.filter(c=>c.project==='project-D').length),1,'rapid duplicate dispatch coalesces');
  await page.evaluate(()=>fixture.mount('project-E','found'));await page.getByRole('button',{name:'Mac의 Codex 앱에서 이어 열기',exact:true}).waitFor();
  await page.evaluate(()=>{fixture.hold=false;fixture.release();});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole('status').count(),0,'late project-D response cannot claim project-E ready');
  await page.evaluate(()=>fixture.mount('project-F','none',false));await page.getByRole('button',{name:'Mac의 Codex 앱 준비',exact:true}).waitFor();
  assert.equal(await codex.isDisabled(),true);assert.equal(await workroom.isEnabled(),true,'missing Codex app does not block Workroom');
  await page.evaluate(()=>fixture.mount('project-G','none'));await page.getByRole('button',{name:'Mac의 Codex 앱에서 처음 열기',exact:true}).waitFor();
  for(const theme of ['gray','dark']){
    await page.evaluate(theme=>document.documentElement.dataset.appTheme=theme,theme);await page.evaluate(()=>document.fonts.ready);
    const rects=await page.locator('#root button,#root select').evaluateAll(elements=>elements.map(element=>{const r=element.getBoundingClientRect();return{x:r.x,right:r.right,height:r.height};}));
    assert.ok(rects.every(r=>r.height>=44&&r.x>=0&&r.right<=innerWidthForTest(width)),JSON.stringify(rects));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
    assert.ok(await page.locator('#root button').evaluateAll(buttons=>buttons.every(button=>{const style=getComputedStyle(button);return parseFloat(style.borderTopWidth)>0&&style.fontFamily===getComputedStyle(document.body).fontFamily;})),'shared token borders and inherited font resolve');
    await page.screenshot({path:new URL(`project-launch-${width}-${theme}.png`,output).pathname,fullPage:true});
  }
  assert.deepEqual(unexpected,[],'no host API or external requests');assert.deepEqual(errors,[],'no React errors');
  results.push({width,checks:['mount-readonly','first','continue','unknown-recheck','selected-agent-target','persistent-error','double-click','late-response','missing-app-independent','44px','no-overflow','light-dark'],passed:true});
  await context.close();
}
await writeFile(new URL('project-launch-actions-results.json',output),JSON.stringify(results,null,2));
console.log(JSON.stringify({passed:results.length,failed:0,results},null,2));
}finally{await browser.close();}
function innerWidthForTest(width){return width;}
