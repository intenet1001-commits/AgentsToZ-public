/** Real panels, isolated read-only API fixtures, Chromium and WebKit. */
import assert from 'node:assert/strict';
import {chromium, webkit} from 'playwright';
const origin=process.argv[2];
if(!origin||new URL(origin).hostname!=='127.0.0.1'||new URL(origin).port==='3001')throw Error('Owned fixture origin required');
const source=await fetch(origin+'/src/WhatISaidPanel.tsx').then(r=>r.text());
const main=await fetch(origin+'/src/main.tsx').then(r=>r.text());
const react=source.match(/"([^"\n]*\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom=main.match(/"([^"\n]*\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react&&reactDom);
const project={id:'history-project',name:'사용자 기억 시험',folderPath:'/fixture-only/history'};
const at=minute=>`2026-10-22T00:${String(minute).padStart(2,'0')}:00Z`;
const rows=[['old',5],['paired',15],['later',25]].map(([id,minute])=>({id,seq:id==='old'?'1':id==='paired'?'2':'3',text:`${id} 지시 원문`,recordedAt:at(minute),memoryId:'history-memory',projectId:project.id,projectName:project.name,agent:'codex',promptOrigin:'human'}));
const outcomes=[10,20].map((minute,i)=>({entryHash:`journal-${i}`,memoryId:'history-memory',recordedAt:at(minute),summary:`세션 결과 ${i}`,agent:'codex',projectName:project.name,deviceId:null,deviceName:null}));
for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch();
 try{
 for(const language of ['ko','en']){
  const context=await browser.newContext({viewport:{width:1100,height:950},serviceWorkers:'block'});
  const unexpected=[],errors=[],calls=[];let outcomeMode='complete',outcomeCalls=0,releaseLate,entriesBroken=false;
  try{
   const html=`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};import '/src/index.css';
const {WhatISaidPanel}=await import('/src/WhatISaidPanel.tsx');const {ControlProfilePanel}=await import('/src/ControlProfilePanel.tsx');
function App(){const [visible,setVisible]=React.useState(false),[ops,setOps]=React.useState(false);return React.createElement(React.Fragment,null,React.createElement('button',{onClick:()=>setVisible(v=>!v)},'Toggle history'),React.createElement('button',{onClick:()=>setOps(true)},'Open OPS'),React.createElement(WhatISaidPanel,{projects:[${JSON.stringify(project)}],language:${JSON.stringify(language)},visible}),ops&&React.createElement(React.StrictMode,null,React.createElement(ControlProfilePanel,{onClose:()=>setOps(false),onOpenWork:()=>{},onOpenProject:()=>{},onOpenUserMemory:()=>{setOps(false);setVisible(true);}})));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));</script>`;
   await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==origin){unexpected.push(url.origin);return route.abort();}
    if(url.pathname==='/__user-memory')return route.fulfill({contentType:'text/html',body:html});
    if(!url.pathname.startsWith('/api/'))return route.continue();
    calls.push({path:url.pathname,method:req.method()});
    const respond=json=>route.fulfill({json});
    if(url.pathname.startsWith('/api/control-profile/')){
     const op=url.pathname.split('/').at(-1);
     if(op==='status')return respond({success:true,profile:{state:'ready',profileId:'fixture-profile',memoryId:'ops-memory',backend:'app-data',projectId:null,sync:{state:'not-configured'}}});
     if(op==='pending')return respond({success:true,proposals:[]});
     if(op==='connections')return respond({success:true,connections:[]});
     if(op==='controls')return respond({success:true,controls:[]});
     if(op==='launch-preference')return respond({success:true,preference:null});
     if(op==='tester-results')return respond({success:true,overview:{entries:[],complete:true,hostName:'시험 Mac',checkedAt:at(0),total:0,nextOffset:null}});
     if(op==='device-memory')return respond({success:true,devices:[],entries:[]});
     if(op==='entries'){if(entriesBroken)return route.fulfill({status:503,json:{success:false,error:'fixture entries unavailable'}});return respond({success:true,memory:{ready:true,revision:null,total:0,entries:[]}});}
    }
    const path=url.pathname.replace('/api/what-i-said/','');
    if(path==='global-status')return respond({configured:true,enabled:true,retentionDays:90,analysisAllowed:false,updatedAt:at(0)});
    if(path==='remote/status')return respond({enabled:false,credentialsReady:false,exclusionsReady:true,sharedPolicyReady:true,projects:[{...project,memoryId:'history-memory',excluded:false,captureConfigured:true,captureEnabled:true}],cloudProjects:[],storedRows:0,deviceId:'fixture-device',deviceName:'시험 Mac',remoteError:null});
    if(path==='remote-key/status')return respond({keys:[],endpoint:null,error:null});
    if(path==='status')return respond({enabled:true,cryptoState:'ready',retentionDays:90,analysisAllowed:false,count:3});
    if(path==='list')return respond({items:rows,hasMore:false,nextBeforeSeq:null,source:'local',scan:{complete:true,unreadable:0,withheld:0}});
    if(path==='outcomes'){
     outcomeCalls++;
     if(outcomeMode==='late'){
      outcomeMode='complete';await new Promise(resolve=>{releaseLate=resolve;});
      return respond({outcomes:[...outcomes.slice(0,1),{...outcomes[1],summary:'STALE RESULT'}],complete:true});
     }
     if(outcomeMode==='failure')return route.fulfill({status:503,json:{error:'Fixture unavailable'}});
     return respond({outcomes:outcomes.map(row=>({...row,summary:outcomeMode==='updated'?'새로 확인한 결과':row.summary})),complete:outcomeMode!=='partial'});
    }
    unexpected.push(url.pathname);return route.fulfill({status:503,json:{error:'Unmocked fixture request rejected'}});
   });
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.goto(origin+'/__user-memory');
   await page.getByRole('button',{name:'Toggle history',exact:true}).click();
   const status=page.getByTestId('what-i-said-outcome-status');
   const refresh=page.getByRole('button',{name:language==='ko'?'새로고침':'Refresh',exact:true});
   const paired=language==='ko'?'결과 연결 1건':'1 linked to results';
   await status.getByText(new RegExp(paired)).waitFor();
   assert.match(await status.innerText(),language==='ko'?/연결 미확인 2건/:/2 links unconfirmed/);
   assert.equal(await page.getByTestId('what-i-said-outcome').count(),1);
   assert.equal(await page.getByTestId('what-i-said-outcome-pending').count(),1);
   outcomeMode='updated';const before=outcomeCalls;await refresh.click();
   await page.getByTestId('what-i-said-outcome').filter({hasText:'새로 확인한 결과'}).waitFor();assert.ok(outcomeCalls>before,'same-memory refresh must reload outcomes');
   outcomeMode='partial';await refresh.click();await status.getByText(language==='ko'?'일부 세션 기록만 확인했습니다. 연결되지 않은 지시의 결과 유무는 알 수 없습니다.':'Only some session records were available. Unlinked instructions may still have results.').waitFor();
   assert.equal(await page.getByTestId('what-i-said-outcome-pending').count(),0);
   outcomeMode='failure';await refresh.click();await status.getByText(new RegExp(language==='ko'?'불러오지 못했습니다':'Could not load')).waitFor();
   assert.equal(await page.getByTestId('what-i-said-prompt-text').count(),3);assert.equal(await page.getByTestId('what-i-said-outcome').count(),0);
   outcomeMode='late';await refresh.click();await page.waitForFunction(()=>document.querySelector('[data-testid="what-i-said-outcome-status"]')?.textContent?.match(/확인 중|Checking/));
   await page.getByRole('button',{name:'Toggle history',exact:true}).click();
   await page.getByRole('button',{name:'Toggle history',exact:true}).click();
   await status.getByText(new RegExp(paired)).waitFor();
   if(releaseLate){releaseLate();await page.waitForTimeout(50);}
   assert.ok(!(await page.content()).includes('STALE RESULT'));
   if(language==='ko'){
    // The panel runs under StrictMode here as in main.tsx, so its mount effects run twice (review 2026-10-25).
    const openOps=page.getByRole('button',{name:'Open OPS',exact:true});
    await openOps.focus();await openOps.press('Enter');
    const panel=page.getByTestId('control-profile-panel');await panel.waitFor();
    // Escape closes it and focus returns to the opener — the second StrictMode run must not record the panel itself.
    await page.waitForFunction(()=>document.querySelector('[data-testid="control-profile-panel"]')?.contains(document.activeElement));
    await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.activeElement?.textContent==='Open OPS',null,{timeout:5000}).catch(()=>{throw new Error('Escape returns focus to the opener under StrictMode');});
    // A failed saved-memory read says to press 「상태 다시 확인」, and that press really reads the list again.
    entriesBroken=true;await openOps.click();
    // A local-only (app-data) memory is not shared with other Macs, so the headline does not say 연결됨 (UX audit 2026-10-25).
    await panel.getByText('운영 기억 준비됨 · 이 Mac 전용',{exact:true}).waitFor();
    const savedMemory=panel.getByTestId('control-profile-saved-memory');
    await savedMemory.getByRole('alert').filter({hasText:'저장된 운영 기억을 읽지 못했습니다. 「상태 다시 확인」을 누르세요.'}).waitFor();
    assert.ok((await panel.innerText()).includes('내 지시는 「내가 한 말」에서'));
    entriesBroken=false;await panel.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
    await panel.getByRole('button',{name:'상태 다시 확인',exact:true}).waitFor({state:'visible'});
    await savedMemory.getByText('아직 저장된 운영 기억이 없습니다.',{exact:false}).waitFor();
    assert.equal(await savedMemory.getByRole('alert').count(),0);
    // A local-only memory saves an AI's memory request at once, so nothing under the status tells the user to save a
    // candidate here (review 2026-10-25: that hint moved to the top of the panel with the candidates block).
    assert.match(await panel.getByTestId('control-profile-pending').innerText(),/후보 없이 바로 저장합니다/);
    assert.doesNotMatch(await panel.getByTestId('control-profile-pending').innerText(),/여기서 저장합니다/);
    assert.match(await savedMemory.innerText(),/기억해”라고 요청하면 여기에 보입니다/);
    assert.ok(!(await panel.innerText()).includes('TypeError'));
    await panel.getByTestId('control-profile-memory-map').getByText('내 지시',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'내 지시·결과 기록 보기',exact:true}).click();
    await panel.waitFor({state:'hidden'});await page.getByTestId('what-i-said-panel').waitFor();
   }
   await page.setViewportSize({width:390,height:844});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.screenshot({path:`.agentstoz/maintainer/user-memory-${name}-${language}-390.png`});
   assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
   assert.ok(calls.every(call=>!/(capture|configure|sync|save|prepare|delete)$/.test(call.path)));
   console.log(`${name}/${language}: pairing counts, refresh, partial/error, hide/reopen and stale-response isolation; no mutations`);
  }finally{releaseLate?.();await context.close();}
 }
 }finally{await browser.close();}
}
// The same normal/persona user-memory check also covers the separate, user-confirmed profile panel.
await import('./user-profile-panel.e2e.mjs');
