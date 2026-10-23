/** Rendered opt-in/recovery journey against an owned API; no personal data. */
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium,webkit} from 'playwright';
const origin=process.argv[2];
assert.equal(new URL(origin).hostname,'127.0.0.1');assert.notEqual(new URL(origin).port,'3001');
const [source,main]=await Promise.all(['/src/RecoveryCheckpointSettings.tsx','/src/main.tsx'].map(p=>fetch(origin+p).then(r=>r.text())));
const react=source.match(/"([^"\n]*\/deps\/react\.js[^"\n]*)"/)?.[1];
const dom=main.match(/"([^"\n]*\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert.ok(react&&dom);
const output=new URL('../.agentstoz/maintainer/ui-evidence/',import.meta.url).pathname;mkdirSync(output,{recursive:true});
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};import '/src/index.css';import '/src/AiTerminalPanel.css';
const {RecoveryCheckpointSettings}=await import('/src/RecoveryCheckpointSettings.tsx');
function App(){const [id,setId]=React.useState('alpha');return React.createElement('main',{className:'ai-terminal-panel',style:{padding:12,maxWidth:700}},React.createElement('button',{onClick:()=>setId(id==='alpha'?'beta':'alpha')},'Switch project'),React.createElement(RecoveryCheckpointSettings,{targetId:id}));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));</script>`;
for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch();
 try{
  const context=await browser.newContext({viewport:{width:390,height:900},serviceWorkers:'block'}),page=await context.newPage(),calls=[],errors=[],unexpected=[];
  const states={alpha:{enabled:false,revision:0},beta:{enabled:false,revision:0}};let holdRead=false,releaseRead;
  page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin!==origin){unexpected.push(url.origin);return route.abort();}
   if(url.pathname==='/__recovery')return route.fulfill({contentType:'text/html',body:html});
   if(!url.pathname.startsWith('/api/'))return route.continue();
   const input=JSON.parse(req.postData()??'{}');calls.push(input);
   assert.equal(url.pathname,'/api/agent-runtime/terminals/memory');
   const id=input.observationTargetId,state=states[id];assert.ok(state);
   if(input.checkpointOperation==='enable'){assert.equal(input.consentVersion,1);assert.equal(input.expectedRevision,state.revision);state.enabled=true;state.revision++;}
   if(input.checkpointOperation==='disable'){assert.equal(input.expectedRevision,state.revision);state.enabled=false;state.revision++;}
   if(input.checkpointOperation==='read'){
    assert.equal(input.checkpointId,'a'.repeat(64));
    if(holdRead)await new Promise(resolve=>{releaseRead=resolve;});
    return route.fulfill({json:{checkpointId:input.checkpointId,coverage:'fragment',authority:'historical-untrusted',memorySaved:false,text:'<script>window.recoveryInjected=true</script> synthetic private fragment'}});
   }
   return route.fulfill({json:{version:1,targetId:id,supported:true,...state,memorySaved:false,coverage:'fragment',retentionDays:7,
    receipts:id==='alpha'?[{id:'a'.repeat(64),agent:'codex',createdAt:Date.now(),expiresAt:Date.now()+10000,coverage:'fragment',expired:false},{id:'b'.repeat(64),agent:'agy',createdAt:1,expiresAt:2,coverage:'fragment',expired:true}]:[]}});
  });
  await page.goto(origin+'/__recovery');const panel=page.getByTestId('recovery-checkpoint-settings');await panel.locator('summary').click();
  await panel.getByText('이 프로젝트의 복구 저장 꺼짐',{exact:true}).waitFor();
  const enable=panel.getByRole('button',{name:'이 프로젝트 복구 저장 켜기',exact:true});assert.equal(await enable.isDisabled(),true);
  assert.equal(calls.some(c=>c.checkpointOperation!=='status'),false,'Opening settings must not enable capture or read raw text');
  await panel.getByRole('checkbox').check();await enable.click();
  await panel.getByText('이 프로젝트의 복구 저장 켜짐',{exact:true}).waitFor();
  assert.equal(calls.filter(c=>c.checkpointOperation==='enable').length,1);
  const reads=panel.getByRole('button',{name:'복구 원문 보기',exact:true});assert.equal(await reads.nth(1).isDisabled(),true);
  assert.ok((await panel.locator('summary').boundingBox()).height>=44);
  for(const button of await panel.getByRole('button').all())assert.ok((await button.boundingBox()).height>=44,'Real Workroom CSS must retain 44px narrow-screen targets');
  await reads.first().click();await panel.locator('pre').getByText('synthetic private fragment',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.recoveryInjected),undefined,'Recovery text is historical data, never executable HTML');
  await panel.getByRole('button',{name:'원문 닫기',exact:true}).click();assert.equal(await panel.locator('pre').count(),0);
  holdRead=true;await reads.first().click();await page.waitForFunction(()=>document.querySelector('button')!==null);
  for(let i=0;i<100&&!releaseRead;i++)await page.waitForTimeout(20);assert.ok(releaseRead);
  await page.getByRole('button',{name:'Switch project',exact:true}).click();
  await panel.getByText('최근 영수증 0건',{exact:false}).waitFor();releaseRead();await page.waitForTimeout(100);
  assert.equal(await panel.locator('pre').count(),0,'A delayed raw fragment must not leak into another project');
  assert.equal(await panel.getByRole('checkbox').isChecked(),false);assert.equal(await enable.isDisabled(),true);
  assert.equal(await panel.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
  await page.screenshot({path:output+`recovery-checkpoint-${name}-390.png`});
  assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);await context.close();
  console.log(`PASS ${name}: separate consent, no read on navigation, expired receipt blocked, escaped raw text, late-response project isolation`);
 }finally{await browser.close();}
}
