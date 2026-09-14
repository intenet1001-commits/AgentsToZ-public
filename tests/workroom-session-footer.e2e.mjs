/** Isolated real React browser tests: no actual memory or model calls. */
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const origin=process.env.WORKROOM_TEST_ORIGIN||'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname,'127.0.0.1');
assert.notEqual(new URL(origin).port,'3001');
const source=await fetch(origin+'/src/AiTerminalPanel.tsx').then(r=>r.text());
const main=await fetch(origin+'/src/main.tsx').then(r=>r.text());
const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const dom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react&&dom);
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {WorkroomSessionFooter}=await import('/src/WorkroomSessionFooter.tsx');await import('/src/AiTerminalPanel.css');
window.fixture={requests:[],closes:[],paused:false,state:'idle',last:null,receipt:null,fail:false,deny:false,closeFail:false};
const session={id:'session-1234',targetId:'project-1234',agent:'codex',state:'running',createdAt:'2026-09-13T00:00:00Z',exitCode:null,cols:80,rows:24};
const transport=async r=>{const f=window.fixture;f.requests.push(r);if(f.deny)throw Error('저장 권한 필요');if(r.workspace.action==='workroom.save'){f.receipt=r.requestId;f.state='saving';if(f.fail)throw Error('응답 유실');}return {kind:'workspace',action:r.workspace.action,workroom:{sessionId:session.id,initialized:true,lastSavedAt:f.last,context:{usedPercent:null,observedAt:null,source:'unavailable'},save:{requestId:f.receipt,state:f.state,localSaved:f.state==='saved',backupSaved:false,message:f.state==='saved'?'로컬 저장 완료 · 백업 대기':f.state==='saving'?'저장 중':f.state==='recovery-required'?'복구 확인 필요':''}}}};
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(WorkroomSessionFooter,{session,visible:true,transport,contextUsed:67.6,scope:'fixture',onPause:p=>window.fixture.paused=p,onClose:async(policy,id)=>{if(window.fixture.closeFail)throw Error('새 활동 저장 필요');window.fixture.closes.push({policy,id});}}));
</script>`;
for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch({headless:true});
 try{
  for(const scenario of ['save-close','recovery','cancel','skip','lost-response','permission','changed-input']){
   const context=await browser.newContext({viewport:{width:393,height:852},serviceWorkers:'block'});
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin)return route.abort();if(u.pathname==='/__footer')return route.fulfill({contentType:'text/html',body:html});if(u.pathname.startsWith('/api/'))throw Error('Unexpected live API');return route.continue()});
   await page.goto(origin+'/__footer');await page.getByRole('button',{name:'지금 저장',exact:true}).waitFor();
   assert.match(await page.getByTestId('workroom-session-footer').innerText(),/67.6%/);
   if(scenario==='permission'){await page.evaluate(()=>window.fixture.deny=true);await page.getByRole('button',{name:'저장 상태 확인',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('button',{name:'지금 저장',exact:true}).isDisabled(),true);}
   else{
    if(scenario==='lost-response')await page.evaluate(()=>window.fixture.fail=true);
    if(scenario==='changed-input')await page.evaluate(()=>window.fixture.closeFail=true);
    await page.getByRole('button',{name:'세션 종료',exact:true}).click();await page.getByRole('dialog').waitFor();
    assert.equal(await page.evaluate(()=>window.fixture.closes.length),0);
    if(scenario==='skip')await page.getByRole('button',{name:'저장 없이 종료',exact:true}).click();
    else{
     await page.getByRole('button',{name:'저장하고 종료',exact:true}).click();
     await page.waitForFunction(()=>window.fixture.requests.some(r=>r.workspace.action==='workroom.save'));
     assert.equal(await page.evaluate(()=>window.fixture.closes.length),0);
     if(scenario==='cancel')await page.getByRole('button',{name:'취소',exact:true}).click();
     await page.evaluate(s=>{window.fixture.state=s==='recovery'?'recovery-required':'saved';window.fixture.last='2026-09-13T00:10:00Z'},scenario);
     // Native modal blocks the background status button; normal polling must finish it.
     if(scenario==='cancel')await page.getByRole('button',{name:'저장 상태 확인',exact:true}).click();
     else await page.waitForFunction(()=>document.querySelector('footer').textContent.includes(window.fixture.state==='saved'?'백업 대기':'복구 확인 필요'),null,{timeout:12000}).catch(async e=>{console.log(await page.evaluate(()=>({fixture:window.fixture,body:document.body.innerText})),errors);throw e});
     if(['save-close','lost-response'].includes(scenario))await page.waitForFunction(()=>window.fixture.closes.length===1);
     if(scenario==='changed-input')await page.getByRole('alert').waitFor();
    }
    const f=await page.evaluate(()=>window.fixture);
    assert.equal(f.closes.length,['skip','save-close','lost-response'].includes(scenario)?1:0);
    assert.equal(f.requests.filter(r=>r.workspace.action==='workroom.save').length,scenario==='skip'?0:1);
    if(f.closes.length)assert.equal(f.closes[0].policy,scenario==='skip'?'skip':'saved');
   }
   assert.deepEqual(errors,[]);console.log(name,scenario,'PASS');await context.close();
  }
 }finally{await browser.close()}
}
