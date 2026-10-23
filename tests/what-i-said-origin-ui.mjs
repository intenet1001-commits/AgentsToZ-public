/** Actual record/guide components; synthetic read-only API only, both browser engines. */
import assert from 'node:assert/strict';
import {chromium, webkit} from 'playwright';
import {verifyPromptGuideOriginUi} from './prompt-guide-smoke.mjs';

const origin = process.argv[2];
if (!origin || new URL(origin).hostname !== '127.0.0.1' || new URL(origin).port === '3001') throw Error('Expected an owned fixture origin');
const source = await fetch(origin+'/src/WhatISaidPanel.tsx').then(r=>r.text());
const main = await fetch(origin+'/src/main.tsx').then(r=>r.text());
const react = source.match(/"([^"\n]*\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom = main.match(/"([^"\n]*\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react && reactDom, 'Use the owned server’s React runtime');
const project = {id:'origin-fixture',name:'출처 검증',folderPath:'/fixture-only/origin'};
const base = {recordedAt:'2026-09-06T00:00:00Z',agent:'codex',projectId:project.id,projectName:project.name,memoryId:'origin-memory'};
const rows = [
  {...base,id:'legacy',seq:'3',text:'기존 일반 메시지는 분류를 덮어쓰지 않고 보존합니다.',promptOrigin:'human'},
  {...base,id:'automatic',seq:'2',text:'<heartbeat>예약 점검 원문 보존</heartbeat>',promptOrigin:'unknown'},
  {...base,id:'copy',seq:'1',text:'앱에서 복사한 메시지',promptOrigin:'agentstoz'},
];
for (const [name, engine] of [['chromium',chromium],['webkit',webkit]]) {
  const browser = await engine.launch();
  try {
    for (const language of ['ko','en']) {
      const context = await browser.newContext({viewport:{width:1100,height:950},serviceWorkers:'block'});
      try {
        const unexpected=[],errors=[],requests=[];
        const html = `<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';const {WhatISaidPanel}=await import('/src/WhatISaidPanel.tsx');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(WhatISaidPanel,{projects:[${JSON.stringify(project)}],language:${JSON.stringify(language)},visible:true}));</script>`;
        await context.route('**/*', async route=>{
          const request=route.request(),url=new URL(request.url());
          if(url.origin!==origin){unexpected.push(url.origin);return route.abort();}
          if(url.pathname==='/__origin-fixture')return route.fulfill({contentType:'text/html',body:html});
          if(!url.pathname.startsWith('/api/'))return route.continue();
          const path=url.pathname.replace('/api/what-i-said/',''),body=request.postDataJSON();
          requests.push({path,body});
          const respond=value=>route.fulfill({json:value});
          if(path==='global-status')return respond({configured:true,enabled:true,retentionDays:90,analysisAllowed:false,updatedAt:base.recordedAt});
          if(path==='remote/status')return respond({enabled:true,credentialsReady:true,exclusionsReady:true,sharedPolicyReady:true,projects:[{...project,memoryId:'origin-memory',excluded:false,captureConfigured:true,captureEnabled:true}],cloudProjects:[],storedRows:3,deviceId:'fixture-device',deviceName:'검증 Mac',remoteError:null});
          if(path==='remote-key/status')return respond({keys:[],endpoint:null,error:null});
          if(path==='outcomes')return respond({outcomes:[],complete:true});
          if(path==='status')return respond({enabled:true,cryptoState:'ready',retentionDays:90,analysisAllowed:false,count:3});
          if(path==='list')return respond({items:rows.filter(row=>!body.origin||row.promptOrigin===body.origin),hasMore:false,nextBeforeSeq:null,source:body.source==='supabase'?'supabase':'local',scan:{complete:true,unreadable:0,withheld:0}});
          unexpected.push(path);return route.fulfill({status:503,json:{error:'Unmocked fixture API rejected'}});
        });
        const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
        await page.goto(origin+'/__origin-fixture');
        await page.getByText(rows[0].text,{exact:true}).waitFor({timeout:15000});
        const labels=page.getByTestId('what-i-said-prompt-origin');
        await page.getByText(rows[1].text,{exact:true}).waitFor();
        const labelText=await labels.allTextContents();
        assert.ok(labelText.includes(language==='ko'?'일반 메시지':'General message'));
        assert.ok(labelText.includes(language==='ko'?'입력 경로 미확인':'Input source unconfirmed'));
        assert.ok(!labelText.some(text=>/직접 입력|Typed directly/.test(text)));
        const originFilter=page.locator('select').filter({has:page.locator('option[value="human"]')});
        await originFilter.selectOption('human');
        await page.getByText(rows[1].text,{exact:true}).waitFor({state:'hidden'});
        assert.ok(requests.some(request=>request.path==='list'&&request.body.origin==='human'));
        assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
        console.log(`${name}/${language}: legacy row preserved, truthful labels and compatible read-only filter`);
      } finally {await context.close();}
    }
    await verifyPromptGuideOriginUi(browser, origin);
    console.log(name+': guide review explains legacy uncertainty and saves nothing');
  } finally {await browser.close();}
}
