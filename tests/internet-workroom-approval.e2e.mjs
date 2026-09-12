/** Real React dialog; all management and terminal APIs are fixture-only.
 * INTERNET_APPROVAL_TEST_ORIGIN=http://127.0.0.1:9017 node tests/internet-workroom-approval.e2e.mjs */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const origin=process.env.INTERNET_APPROVAL_TEST_ORIGIN||'http://127.0.0.1:9017';
assert.equal(new URL(origin).hostname,'127.0.0.1');assert.notEqual(new URL(origin).port,'3001');
const read=async path=>{const r=await fetch(origin+path);assert.equal(r.status,200);return r.text();};
const [source,main]=await Promise.all([read('/src/InternetQrRemoteControlDialog.tsx'),read('/src/main.tsx')]);
const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert.ok(react&&reactDom);
const html=`<!doctype html><html data-app-theme="gray"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const React=(await import(${JSON.stringify(react)})).default;const {createRoot}=(await import(${JSON.stringify(reactDom)})).default;
await import('/src/index.css');
const {AgentRuntimeClient}=await import('/src/agentRuntimeClient.ts');
AgentRuntimeClient.prototype.targets=async()=>({targets:[{targetId:'target-fixture',label:'Fixture project'},{targetId:'second-fixture',label:'Second project'}],complete:!location.search.includes('incomplete')});
const {InternetQrRemoteControlDialog}=await import('/src/InternetQrRemoteControlDialog.tsx');
const expiresAt=new Date(Date.now()+30*86400000).toISOString();
const session={sessionId:'session-fixture',pairingId:null,controllerId:'controller-fixture',controllerName:'Fixture iPhone',controllerKeyFingerprint:'fixture-key',approvalState:'pending',sasCode:'123456',createdAt:new Date().toISOString(),expiresAt,approvedAt:null,taskScopeGranted:false,conversationScopeGranted:false};
window.fixture={approvals:[],status:{enabled:true,state:'approval-required',controllerUrl:'https://fixture.invalid/remote/',hostExpiresAt:expiresAt,pairingExpiresAt:expiresAt,lastRelayContactAt:null,sessions:[session],error:null}};
const api={status:async()=>({status:structuredClone(fixture.status),suggestedControllerOrigin:null}),approveSession:async(...args)=>{fixture.approvals.push(args);fixture.status={...fixture.status,state:'online',sessions:[{...session,approvalState:'approved',sasCode:null,approvedAt:new Date().toISOString()}]};return structuredClone(fixture.status)}};
createRoot(document.getElementById('root')).render(React.createElement(InternetQrRemoteControlDialog,{open:true,onClose(){},api}));
</script></html>`;
const browser=await chromium.launch({headless:true}),output=new URL('../output/playwright/',import.meta.url);await mkdir(output,{recursive:true});const results=[];
try{
 for(const width of [375,1024])for(const scope of ['target','root','all','all-incomplete']){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'}),requests=[],unexpected=[],errors=[];let failGrant=scope==='root';
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin){unexpected.push(url.href);return route.abort();}
   if(url.pathname==='/__internet-approval-fixture')return route.fulfill({contentType:'text/html',body:html});
   if(url.pathname==='/api/agent-runtime/terminals/access'){
    const body=route.request().postDataJSON();if(body.owner){requests.push(body);if(failGrant)return route.fulfill({status:500,json:{error:'fixture grant disk failure'}});}
    return route.fulfill({json:{connections:[],workspaceRoots:[{workspaceRootId:'root-fixture',name:'Fixture root'}]}});
   }
   if(url.pathname.startsWith('/api/')){unexpected.push(url.pathname);return route.abort();}return route.continue();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/__internet-approval-fixture'+(scope==='all-incomplete'?'?incomplete':''));
  const checkbox=page.getByTestId('grant-internet-workroom'),approve=page.getByTestId('approve-internet-remote-session'),sas=page.getByTestId('internet-remote-sas-input');
  await checkbox.waitFor();assert.equal(await checkbox.isEnabled(),true);assert.equal(await checkbox.isChecked(),false);assert.equal(await page.getByTestId('grant-internet-remote-task-scope').count(),0,'blocked managed checkbox is not the primary choice');
  await sas.fill('123450');assert.equal(await approve.isDisabled(),true);await checkbox.check();assert.equal(await checkbox.isChecked(),true);await sas.fill('123456');await approve.click();
  await page.getByText('워크룸 작업을 허용할 프로젝트 또는 작업 폴더를 선택하세요.',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>fixture.approvals),[]);assert.deepEqual(requests,[]);
  const selector=page.getByLabel('워크룸 허용 범위');await selector.selectOption(scope.startsWith('all')?'all-targets':scope+':'+scope+'-fixture');
  if(scope.startsWith('all'))await page.getByText(/이후 추가되는 프로젝트는 포함되지 않습니다/).waitFor();
  if(scope==='all-incomplete'){
    await page.getByText(/현재 확인된 2개만 승인할 수 있으며/).waitFor();
    assert.equal(await selector.locator('option:checked').innerText(),'현재 확인된 전체 프로젝트·워크트리 (2개)');
  }
  for(const theme of ['gray','dark']){
   await page.evaluate(theme=>document.documentElement.dataset.appTheme=theme,theme);await checkbox.scrollIntoViewIfNeeded();
   const geometry=await page.locator('.internet-workroom-consent,.internet-workroom-scope select').evaluateAll(elements=>elements.map(e=>{const r=e.getBoundingClientRect();return{height:r.height,left:r.left,right:r.right};}));assert.ok(geometry.every(r=>r.height>=44&&r.left>=0&&r.right<=width),JSON.stringify(geometry));
   assert.equal(await selector.evaluate(e=>getComputedStyle(e).color),await page.locator('.internet-workroom-consent').evaluate(e=>getComputedStyle(e).color),'shared foreground token');
   assert.equal(await approve.evaluate(e=>getComputedStyle(e).color),await approve.evaluate(e=>{const span=document.createElement('span');span.style.color='var(--on-accent)';e.append(span);const color=getComputedStyle(span).color;span.remove();return color;}),'approval uses readable on-accent token');
   await page.screenshot({path:new URL('internet-approval-'+width+'-'+scope+'-'+theme+'.png',output).pathname});
  }
  await approve.click();await page.waitForFunction(()=>fixture.approvals.length===1);
  if(scope==='root'){
   const retry=page.getByRole('button',{name:'권한 저장 다시 시도',exact:true});await retry.waitFor();assert.equal(requests.length,1);assert.equal(await checkbox.count(),0,'successful approval remains approved even when grant fails');
   assert.ok((await retry.boundingBox()).height>=44);await retry.scrollIntoViewIfNeeded();await page.screenshot({path:new URL('internet-approval-'+width+'-grant-pending.png',output).pathname});
   failGrant=false;await retry.click();await retry.waitFor({state:'hidden'});assert.equal(requests.length,2);assert.equal((await page.evaluate(()=>fixture.approvals)).length,1,'grant-only retry never repeats SAS approval');
  }else{await page.getByText(/워크룸 권한도 최대 30일 유지됩니다/).waitFor();assert.equal(requests.length,1);}
  const expected={owner:'internet:session-fixture',enabled:true,rememberDevice:true,...(scope==='root'?{workspaceRootIds:['root-fixture']}:{targetIds:scope.startsWith('all')?['target-fixture','second-fixture']:['target-fixture']})};for(const request of requests)assert.deepEqual(request,expected);
  assert.deepEqual(await page.evaluate(()=>fixture.approvals),[['session-fixture','123456',false,false]]);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
  results.push({width,scope,passed:true,checks:['clickable-default-off','exact-SAS','required-scope','explicit-durable-grant','44px','shared-light-dark',...(scope==='root'?['partial-success-grant-only-retry']:[])]});await context.close();
 }
 await writeFile(new URL('internet-workroom-approval-results.json',output),JSON.stringify(results,null,2));console.log(JSON.stringify({passed:results.length,failed:0,results},null,2));
}finally{await browser.close();}
