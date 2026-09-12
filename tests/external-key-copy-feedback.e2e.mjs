/** Actual React copy controls, isolated API fixtures and an in-memory clipboard.
 * Start Vite on 127.0.0.1:9000, then: node tests/external-key-copy-feedback.e2e.mjs
 * This never issues a real key, writes the OS clipboard, or accesses user data.
 * Chromium layout checks do not replace installed macOS/WebKit verification.
 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const origin=process.env.COPY_FEEDBACK_TEST_ORIGIN||'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname,'127.0.0.1');
const output=new URL('../output/playwright/',import.meta.url);await mkdir(output,{recursive:true});
const source=await fetch(`${origin}/src/WhatISaidPanel.tsx`).then(r=>{assert.equal(r.status,200,'Start isolated Vite first');return r.text();});
const main=await fetch(`${origin}/src/main.tsx`).then(r=>r.text());
const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react&&reactDom,'Use Vite’s actual React dependency versions');
const TOKEN_A='ab'.repeat(32),TOKEN_B='cd'.repeat(32);
const endpoint={wis:'https://fixture.invalid/functions/v1/what-i-said-feed',memory:'https://fixture.invalid/functions/v1/project-memory-feed'};
const memories=[{memoryId:'fixture-memory-a',name:'복사 검증 기억 A',folderPath:'/fixture-only/copy/A',excluded:false,captureConfigured:true,captureEnabled:true}];
const keys=[TOKEN_A,TOKEN_B].map((token,i)=>({id:`fixture-key-${i}`,label:`Fixture reader ${i+1}`,token,memoryIds:['fixture-memory-a'],allowedMemoryIds:[],expiresAt:'2026-12-01T00:00:00Z',lastUsedAt:null}));
const html=mode=>`<!doctype html><meta charset="utf-8"><div id="root" style="padding:16px"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import {applyZoomToDocument} from '/src/uiZoom.ts';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
document.documentElement.dataset.appTheme='gray';localStorage.setItem('portmanager-ui-zoom','1.25');applyZoomToDocument(document,1.25);
window.__copy={mode:'success',calls:[],pending:new Map(),fallbacks:0};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:value=>{
 const state=window.__copy,index=state.calls.push(value)-1;
 if(state.mode==='failure')return Promise.reject(new Error('Fixture clipboard denied'));
 if(state.mode==='deferred')return new Promise((resolve,reject)=>state.pending.set(index,{resolve,reject}));
 return Promise.resolve();
}}});
document.execCommand=()=>{window.__copy.fallbacks++;throw new Error('OS clipboard fallback is forbidden');};
window.__settleCopy=(index,ok=true)=>{const entry=window.__copy.pending.get(index);if(!entry)throw new Error('No pending fixture copy '+index);window.__copy.pending.delete(index);ok?entry.resolve():entry.reject(new Error('Fixture clipboard denied'));};
const mode=${JSON.stringify(mode)};let element;
if(mode==='wis'){
 const {WhatISaidPanel}=await import('/src/WhatISaidPanel.tsx');
 element=React.createElement(WhatISaidPanel,{projects:[{id:'fixture-project-a',name:'복사 검증 기억 A',folderPath:'/fixture-only/copy/A'}],language:'ko',visible:true});
}else if(mode==='memory'){
 const {ProjectMemoryApiKeys}=await import('/src/ProjectMemoryApiKeys.tsx');
 const client={rpc:(name,args)=>fetch('/__copy-rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})}).then(r=>r.json())};
 element=React.createElement(ProjectMemoryApiKeys,{client:()=>client,supabaseUrl:'https://fixture.invalid',memories:${JSON.stringify(memories)}});
}else{
 const {ClipboardCopyButton}=await import('/src/ClipboardCopyButton.tsx');
 function Harness(){const [value,setValue]=React.useState('fixture-value-a'),[mounted,setMounted]=React.useState(true);
  window.__changeValue=setValue;window.__mountCopy=setMounted;
  return React.createElement('section',{'data-testid':'copy-harness'},mounted?React.createElement(ClipboardCopyButton,{value,label:'테스트 값 복사',copiedLabel:'복사됨',copyingLabel:'복사 중…',successMessage:'테스트 값을 복사했습니다.',errorMessage:'복사하지 못했습니다. 다시 시도해 주세요.',testId:'fixture-copy',className:'inline-flex items-center gap-1 rounded border px-3 py-2'}):null);
 }element=React.createElement(Harness);
}
ReactDOM.createRoot(document.getElementById('root')).render(element);
</script>`;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(10);}assert.fail(message);}
const browser=await chromium.launch({headless:true}),results=[];
async function fixture(mode){
  const context=await browser.newContext({viewport:{width:1000,height:1050},serviceWorkers:'block'});
  const state={calls:[],blocked:[],errors:[]};
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){state.blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');}
    if(url.pathname==='/__copy-page')return route.fulfill({contentType:'text/html',body:html(mode)});
    const respond=json=>route.fulfill({json});
    if(url.pathname==='/__copy-rpc'){
      const body=request.postDataJSON();state.calls.push(body);
      if(body.name==='portmgr_project_memory_feed_keys_manage'&&body.args.p_action==='list')return respond({data:keys,error:null});
    }else if(url.pathname.startsWith('/api/')){
      const path=url.pathname.replace('/api/what-i-said/','');state.calls.push({path,body:request.postDataJSON()});
      if(path==='global-status')return respond({configured:true,enabled:true,retentionDays:90,analysisAllowed:false});
      if(path==='remote/status')return respond({enabled:true,credentialsReady:true,exclusionsReady:true,sharedPolicyReady:true,projects:memories,deviceId:'fixture-device',deviceName:'Fixture Mac',storedRows:11,remoteError:null});
      if(path==='remote-key/status')return respond({keys,endpoint:endpoint.wis,error:null});
      if(path==='status')return respond({enabled:true,cryptoState:'ready',retentionDays:90,analysisAllowed:false,count:11,scan:{complete:true,unreadable:0,withheld:0}});
      if(path==='list')return respond({items:[],hasMore:false,nextBeforeSeq:null,capture:{}});
    }else return route.continue();
    state.blocked.push(`${request.method()} ${url.pathname}`);return route.fulfill({status:503,json:{error:'Unmocked fixture API'}});
  });
  const page=await context.newPage();page.on('pageerror',error=>state.errors.push(error.message));
  await page.goto(`${origin}/__copy-page`);
  const panel=page.getByTestId(mode==='wis'?'what-i-said-remote-key':mode==='memory'?'project-memory-api-keys':'copy-harness');
  await panel.waitFor({timeout:10000});
  if(mode==='memory')await panel.getByRole('button',{name:'연결 키 관리',exact:true}).click();
  if(mode!=='button')await until(async()=>await page.getByTestId(mode==='wis'?'what-i-said-copy-key':'project-memory-copy-key').count()===2,'Both dummy key controls must load');
  return {context,page,panel,state};
}
const group=button=>button.locator('..');
const clipboard=page=>page.evaluate(()=>window.__copy.calls);
const setMode=(page,mode)=>page.evaluate(mode=>{window.__copy.mode=mode;},mode);
async function copied(button,message){
  await until(async()=>await button.innerText()==='복사됨','The clicked button must show completion');
  assert.ok(await button.isEnabled());assert.equal(await button.locator('svg.lucide-check').count(),1);
  assert.equal(await group(button).getByRole('status').innerText(),message);
  assert.equal(await group(button).getByRole('alert').count(),0);
}
async function run(name,mode,execute){
  let f;try{f=await fixture(mode);const details=await execute(f);
    assert.deepEqual(f.state.blocked,[],'All external requests and non-fixture APIs are forbidden');
    assert.deepEqual(f.state.errors,[],'Actual React components must not throw');
    assert.equal(await f.page.evaluate(()=>window.__copy.fallbacks),0);
    results.push({name,status:'passed',...details});console.log(`PASS ${name}`);
  }catch(error){results.push({name,status:'failed',error:error.message});console.error(`FAIL ${name}: ${error.message}`);await f?.page.screenshot({path:new URL(`copy-${name}-failed.png`,output).pathname,fullPage:true}).catch(()=>{});
  }finally{await f?.context.close();}
}

try{
  await run('what-i-said-address-key-and-repeat-feedback','wis',async({page,panel})=>{
    const address=page.getByTestId('what-i-said-copy-address'),key=page.getByTestId('what-i-said-copy-key').first();
    assert.equal(await address.getAttribute('aria-label'),'주소 복사');assert.equal(await key.getAttribute('aria-label'),'접근 키 복사');
    assert.equal(await group(address).getByRole('status').innerText(),'');assert.ok(!(await panel.textContent()).includes(TOKEN_A));
    await address.click();await copied(address,'API 주소를 복사했습니다.');
    await address.evaluate(button=>{window.__firstCopyAnnouncement=button.parentElement.querySelector('[role=status]').firstElementChild;});
    await address.click();await copied(address,'API 주소를 복사했습니다.');
    assert.ok(await address.evaluate(button=>window.__firstCopyAnnouncement!==button.parentElement.querySelector('[role=status]').firstElementChild),'Repeated copy must renew the live announcement node');
    await key.click();await copied(key,'접근 키를 복사했습니다.');
    assert.deepEqual(await clipboard(page),[endpoint.wis,endpoint.wis,TOKEN_A]);
    assert.equal(await page.getByTestId('what-i-said-copy-key').nth(1).innerText(),'접근 키 복사');
    assert.equal(await address.getAttribute('aria-label'),'주소 복사');
  });

  await run('memory-address-key-and-guide-values','memory',async({page,panel,state})=>{
    const address=page.getByTestId('project-memory-copy-address'),key=page.getByTestId('project-memory-copy-key').first(),guide=page.getByTestId('project-memory-copy-guide').first();
    assert.ok(!(await panel.textContent()).includes(TOKEN_A));
    await address.click();await copied(address,'API 주소를 복사했습니다.');
    await key.click();await copied(key,'인증 키를 복사했습니다.');
    await guide.click();await copied(guide,'연결 안내를 복사했습니다.');
    const values=await clipboard(page);assert.deepEqual(values.slice(0,2),[endpoint.memory,TOKEN_A]);
    assert.ok(values[2].includes(`GET ${endpoint.memory}?limit=10\nAuthorization: Bearer ${TOKEN_A}`));
    assert.deepEqual(state.calls.map(call=>call.args.p_action),['list'],'Copying must not issue, rotate, or revoke a key');
  });

  for(const mode of ['wis','memory'])await run(`${mode}-independent-pending-failure-and-retry`,mode,async({page})=>{
    const buttons=page.getByTestId(mode==='wis'?'what-i-said-copy-key':'project-memory-copy-key');
    const first=buttons.first(),second=buttons.nth(1);await setMode(page,'deferred');
    await first.click();assert.ok(await first.isDisabled());assert.equal(await first.innerText(),'복사 중…');
    assert.ok(await second.isEnabled());await second.click();assert.deepEqual(await clipboard(page),[TOKEN_A,TOKEN_B]);
    await page.evaluate(()=>window.__settleCopy(1));await copied(second,mode==='wis'?'접근 키를 복사했습니다.':'인증 키를 복사했습니다.');
    assert.ok(await first.isDisabled());await page.evaluate(()=>window.__settleCopy(0,false));
    await group(first).getByRole('alert').waitFor();assert.match(await group(first).getByRole('alert').innerText(),/복사.*(?:못했습니다|실패했습니다)/);
    assert.ok(await first.isEnabled());assert.equal(await group(first).getByRole('status').innerText(),'');
    assert.equal(await second.innerText(),'복사됨');await setMode(page,'success');await first.click();
    await copied(first,mode==='wis'?'접근 키를 복사했습니다.':'인증 키를 복사했습니다.');assert.deepEqual(await clipboard(page),[TOKEN_A,TOKEN_B,TOKEN_A]);
    const address=page.getByTestId(mode==='wis'?'what-i-said-copy-address':'project-memory-copy-address');
    await setMode(page,'failure');await address.click();await group(address).getByRole('alert').waitFor();
    assert.equal(await address.innerText(),'주소 복사');assert.equal(await second.innerText(),'복사됨');
    await setMode(page,'success');await address.click();await copied(address,'API 주소를 복사했습니다.');
  });

  await run('pending-value-change-and-unmount-ignore-late-results','button',async({page})=>{
    const button=page.getByTestId('fixture-copy');await setMode(page,'deferred');await button.click();
    assert.ok(await button.isDisabled());await button.evaluate(node=>node.click());assert.equal((await clipboard(page)).length,1);
    await page.evaluate(()=>window.__changeValue('fixture-value-b'));
    await until(async()=>await button.isEnabled()&&await button.innerText()==='테스트 값 복사','A changed value must start fresh');
    await page.evaluate(()=>window.__settleCopy(0));await sleep(30);
    assert.equal(await button.innerText(),'테스트 값 복사');assert.equal(await group(button).getByRole('status').innerText(),'');
    await button.click();await page.evaluate(()=>window.__changeValue('fixture-value-c'));
    await until(async()=>await button.isEnabled(),'Value change must release the old pending state');
    await page.evaluate(()=>window.__settleCopy(1,false));await sleep(30);assert.equal(await page.getByRole('alert').count(),0);
    await button.click();await page.evaluate(()=>window.__mountCopy(false));await until(async()=>await button.count()===0,'The pending button must unmount');
    await page.evaluate(()=>window.__mountCopy(true));await button.waitFor();await page.evaluate(()=>window.__settleCopy(2));await sleep(30);
    assert.equal(await button.innerText(),'테스트 값 복사');assert.equal(await group(button).getByRole('status').innerText(),'');
    await setMode(page,'success');await button.click();await copied(button,'테스트 값을 복사했습니다.');
    assert.deepEqual(await clipboard(page),['fixture-value-a','fixture-value-b','fixture-value-c','fixture-value-c']);
    await page.evaluate(()=>window.__changeValue(''));
    await until(async()=>await button.isDisabled()&&await button.innerText()==='테스트 값 복사','An empty value must disable copying and clear old success');
    await button.evaluate(node=>node.click());assert.equal((await clipboard(page)).length,4);
    await page.evaluate(()=>{window.__changeValue('fixture-value-d');window.__savedClipboard=navigator.clipboard;Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});});
    await until(async()=>await button.isEnabled(),'A nonempty value must become actionable');
    await button.click();await group(button).getByRole('alert').waitFor();
    assert.equal(await button.innerText(),'테스트 값 복사');assert.equal(await group(button).getByRole('status').innerText(),'');
    assert.equal((await clipboard(page)).length,4,'An unavailable clipboard cannot report a write');
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:window.__savedClipboard}));
    await button.click();await copied(button,'테스트 값을 복사했습니다.');assert.equal((await clipboard(page)).at(-1),'fixture-value-d');
  });

  for(const mode of ['wis','memory'])await run(`${mode}-copy-layout-125-percent`,mode,async({page,panel})=>{
    const address=page.getByTestId(mode==='wis'?'what-i-said-copy-address':'project-memory-copy-address');
    await address.click();await copied(address,'API 주소를 복사했습니다.');
    const firstKey=page.getByTestId(mode==='wis'?'what-i-said-copy-key':'project-memory-copy-key').first();
    await firstKey.click();await copied(firstKey,mode==='wis'?'접근 키를 복사했습니다.':'인증 키를 복사했습니다.');
    for(const width of [1000,640]){
      await page.setViewportSize({width,height:1050});await panel.scrollIntoViewIfNeeded();
      const layout=await panel.evaluate(card=>{
        const bounds=card.getBoundingClientRect();
        const buttons=[...card.querySelectorAll('button[data-testid*="copy-"]')].map(button=>{const box=button.getBoundingClientRect();return{left:box.left,right:box.right,overflow:button.scrollWidth-button.clientWidth};});
        return{width:innerWidth,left:bounds.left,right:bounds.right,overflow:card.scrollWidth-card.clientWidth,zoom:document.getElementById('root').style.transform,buttons};
      });
      assert.equal(layout.zoom,'scale(1.25)');assert.ok(layout.left>=-2&&layout.right<=width+2&&layout.overflow<=2,JSON.stringify(layout));
      assert.ok(layout.buttons.every(button=>button.left>=layout.left-2&&button.right<=layout.right+2&&button.overflow<=2),JSON.stringify(layout));
      assert.ok(!(await panel.textContent()).includes(TOKEN_A)&&!(await panel.textContent()).includes(TOKEN_B),'Copy feedback must never reveal the dummy keys');
      await panel.screenshot({path:new URL(`external-copy-${mode}-${width}-125.png`,output).pathname});
      await address.scrollIntoViewIfNeeded();assert.ok(await address.isVisible());
      await page.screenshot({path:new URL(`external-copy-${mode}-${width}-125-viewport.png`,output).pathname,fullPage:false});
      if(width===640){
        const key=page.getByTestId(mode==='wis'?'what-i-said-copy-key':'project-memory-copy-key').first();
        await setMode(page,'failure');await key.click();await group(key).getByRole('alert').waitFor();
        const errorLayout=await group(key).getByRole('alert').evaluate(node=>{const box=node.getBoundingClientRect();return{left:box.left,right:box.right,width:innerWidth,overflow:node.scrollWidth-node.clientWidth};});
        assert.ok(errorLayout.left>=-2&&errorLayout.right<=width+2&&errorLayout.overflow<=2,JSON.stringify(errorLayout));
        await key.scrollIntoViewIfNeeded();await page.screenshot({path:new URL(`external-copy-${mode}-640-error-viewport.png`,output).pathname,fullPage:false});
      }
    }
    return{viewports:['1000×1050','640×1050'],zoom:'125%'};
  });
}finally{
  await browser.close();await writeFile(new URL('external-key-copy-feedback-results.json',output),JSON.stringify({generatedAt:new Date().toISOString(),results},null,2)+'\n');
}
console.log(`${results.filter(row=>row.status==='passed').length}/${results.length} external copy regressions passed`);
if(results.some(row=>row.status==='failed'))process.exitCode=1;
