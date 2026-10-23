/** Real project/workroom panels; all state and APIs belong to this isolated browser. */
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync} from 'node:fs';
import {chromium,webkit} from 'playwright';
const CURRENT_PROJECT_MEMORY_VERSION=Number(readFileSync(new URL('../src/projectMemoryVersion.ts',import.meta.url),'utf8').match(/export const CURRENT_PROJECT_MEMORY_VERSION = (\d+)/)[1]);
const origin=process.argv[2];
assert.equal(new URL(origin).hostname,'127.0.0.1');assert.notEqual(new URL(origin).port,'3001');
const [source,main]=await Promise.all(['/src/ProjectMemoryPanel.tsx','/src/main.tsx'].map(p=>fetch(origin+p).then(r=>r.text())));
const react=source.match(/"([^"\n]*\/deps\/react\.js[^"\n]*)"/)?.[1];
const dom=main.match(/"([^"\n]*\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert.ok(react&&dom);
const output=new URL('../.agentstoz/maintainer/ui-evidence/',import.meta.url).pathname;mkdirSync(output,{recursive:true});
const status=(name,needsRemember=false)=>({exists:true,projectRoot:`/fixture/${name}`,memoryPath:`/fixture/${name}/.agent-memory/CORE.md`,sourcePath:'.agent-memory/CORE.md',kind:'native',size:100,
 modifiedAt:'2026-10-22T00:00:00Z',contentHash:`${name}-hash`,config:{schemaVersion:1,memoryId:`${name}-memory`,sourcePath:'.agent-memory/CORE.md',agent:'codex',autoBackup:true,
 lastPulledRevisionId:null,lastSyncedHash:`${name}-hash`,lastUpdatedAt:null,lastBackedUpAt:null,lastRememberedAt:'2026-10-22T00:00:00Z',lastRememberedActivityFingerprint:'current'},
 adapters:{claude:true,codex:true},memoryAgent:{installedVersion:30,currentVersion:30,updateAvailable:false},
 activity:{needsRemember,reasons:needsRemember?['session-activity']:[],currentFingerprint:'current',lastRememberedFingerprint:'current',lastActivityAt:null,lastRememberedAt:'2026-10-22T00:00:00Z',lastAgent:null,worktreeCount:0,hooks:{claude:true,codex:true}}});
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};import '/src/index.css';import '/src/AiTerminalPanel.css';
const {ProjectMemoryPanel}=await import('/src/ProjectMemoryPanel.tsx');const {TerminalMemoryStatus}=await import('/src/TerminalMemoryStatus.tsx');
window.evidence={manage:[],review:[],toasts:[]};
function App(){const [name,setName]=React.useState('alpha');return React.createElement('main',{style:{padding:12,maxWidth:700,margin:'auto'}},
React.createElement('button',{onClick:()=>setName(n=>n==='alpha'?'beta':'alpha')},'Switch project'),
React.createElement(ProjectMemoryPanel,{folderPath:'/fixture/'+name,projectName:name,projectRole:'managed',compact:true,onToast:(...args)=>window.evidence.toasts.push(args)}),
React.createElement(TerminalMemoryStatus,{visible:true,projects:[{targetId:'worktree',label:'알파 워크트리',projectTargetId:'alpha-project'}],onManageProject:id=>window.evidence.manage.push(id),onReview:target=>window.evidence.review.push(target)}));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));
</script>`;
for(const [engineName,engine]of [['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch();
 try{
 const context=await browser.newContext({viewport:{width:390,height:900},serviceWorkers:'block'}),calls=[],errors=[],unexpected=[];
 let mode='fresh',localFailure=false,releaseLate,held=false;
 const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.origin!==origin){unexpected.push(url.origin);return route.abort();}
  if(url.pathname==='/__memory-journey')return route.fulfill({contentType:'text/html',body:html});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  const path=url.pathname,input=req.postData()?JSON.parse(req.postData()):{};calls.push({path,input});
  const respond=(json,statusCode=200)=>route.fulfill({status:statusCode,json});
  if(path==='/api/agent-runtime/terminals/memory')return respond({jobs:[{sessionId:'old-save',targetId:'worktree',state:'backup-pending'}],total:1,unresolved:1,nextOffset:null});
  if(path==='/api/project-memory/hermes-adapter')return respond({error:'Fixture has no Hermes'},503);
  const name=input.folderPath?.split('/').at(-1)??'alpha';
  const next=status(name,mode==='pending'||mode==='conflict');
  if(mode==='conflict')next.config.lastSyncedHash='base';
  if(mode==='adapters-current')next.memoryAgent={installedVersion:CURRENT_PROJECT_MEMORY_VERSION-1,currentVersion:CURRENT_PROJECT_MEMORY_VERSION,updateAvailable:true,adaptersVersion:CURRENT_PROJECT_MEMORY_VERSION,adaptersUpdateAvailable:false,memoryContentReady:false};
  if(path==='/api/project-memory/panel-status'){
   if(localFailure)return respond({error:'Fixture read unavailable'},503);
   if(mode==='late'&&name==='alpha'&&!held){held=true;await new Promise(resolve=>{releaseLate=resolve;});}
   if(mode==='activity-unknown')delete next.activity;
   return respond({status:next,privateGitHubArchive:null,remote:input.scope==='local'?null:mode==='pending'||mode==='backup-failed'?{ok:false,error:'Fixture cloud offline'}:{ok:true,exists:true,contentHash:mode==='conflict'?'remote-hash':next.contentHash,inSync:mode!=='conflict'},computedAt:Date.now(),stale:false});
  }
  if(path==='/api/project-memory/detect')return respond(next);
  if(path==='/api/project-memory/remote-status')return respond({exists:true,contentHash:next.contentHash,inSync:true});
  if(path==='/api/project-memory/session-end'){
   assert.equal(mode,'pending');mode='backup-failed';return respond({success:true,localSaved:true,remoteBackedUp:false,backupError:'Fixture cloud offline'});
  }
  if(path==='/api/project-memory/sync')return respond({conflict:true,success:false,localSaved:false,localContentHash:next.contentHash,remoteContentHash:'remote-hash',remoteRevisionId:'revision-1',lastSyncedHash:'base',localContent:'# Local\nKeep local lesson',remoteContent:'# Remote\nKeep remote lesson'},409);
  unexpected.push(path);return respond({error:'Unmocked fixture request'},503);
 });
 await page.goto(origin+'/__memory-journey');
 const save=page.getByTestId('project-memory-session-end'),progress=page.getByTestId('project-memory-progress');
 await save.waitFor();
 assert.equal(await save.innerText(),'새로 저장할 활동 없음','An initialized file is not evidence of a saved task');
 await progress.getByText('기억 파일 준비됨',{exact:true}).waitFor();
 assert.ok((await save.boundingBox()).height>=44,'The mobile save target must be at least 44px');
 assert.equal(await page.getByText('세션 기억 완료',{exact:true}).count(),0);
 assert.equal(await page.getByTestId('project-memory-save-result').count(),0,'An initialization timestamp is not a save receipt');
 await page.getByRole('button',{name:'장기기억에서 백업 확인',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.evidence.manage),['alpha-project']);
 assert.deepEqual(await page.evaluate(()=>window.evidence.review),[],'Opening recovery must not launch AI');
 // Poll failure retains known local memory and blocks writes until a successful read.
 localFailure=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await progress.getByText('현재 상태 확인 필요 · 마지막 확인 내용 유지',{exact:true}).waitFor();
 assert.equal(await page.getByTestId('project-memory-create-primary').count(),0);
 assert.equal(await page.getByTestId('project-memory-safe-sync').isDisabled(),true);
 localFailure=false;await progress.getByRole('button',{name:'기억 상태 다시 확인',exact:true}).click();
 await progress.getByText('기억 파일 준비됨',{exact:true}).waitFor();
 // Unknown activity must not be presented as saved/current.
 mode='activity-unknown';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await progress.getByText('활동 상태 확인 필요',{exact:true}).waitFor();
 assert.equal(await save.innerText(),'활동 상태 확인 필요');
 // Local AI storage remains available with the cloud offline, exactly once.
 mode='pending';await progress.getByRole('button',{name:'기억 상태 다시 확인',exact:true}).click();
 await save.getByText('세션 기억하기 필요',{exact:true}).waitFor();await save.click();
 await progress.getByText('새로 저장할 활동 없음',{exact:true}).waitFor();
 await progress.getByText('연결 상태 확인 필요',{exact:true}).waitFor();
 await progress.getByTestId('project-memory-save-result').getByText('이번 요청 · 로컬 저장 확인 · 클라우드 백업 확인 필요',{exact:true}).waitFor();
 assert.equal(calls.filter(c=>c.path.endsWith('/session-end')).length,1);
 assert.match((await page.evaluate(()=>window.evidence.toasts)).at(-1)[0],/백업/);
 await page.getByTestId('project-memory-check-remote').click();
 await progress.getByText('현재 내용과 일치',{exact:true}).waitFor();
 assert.equal(calls.filter(c=>c.path.endsWith('/session-end')).length,1,'A backup recheck must not rerun AI');
 // A real read failure on initial entry is unknown, never an empty memory to initialize.
 localFailure=true;await page.reload();
 await progress.getByText('현재 상태 확인 필요',{exact:true}).waitFor();
 assert.equal(await page.getByTestId('project-memory-create-primary').count(),0);
 localFailure=false;mode='conflict';await progress.getByRole('button',{name:'기억 상태 다시 확인',exact:true}).click();
 await progress.getByText('양쪽 변경 검토 필요',{exact:true}).waitFor();
 assert.equal(await save.innerText(),'충돌 검토 후 저장');assert.equal(await save.isDisabled(),true);
 await page.getByTestId('project-memory-safe-sync').click();
 await page.getByTestId('project-memory-conflict-resolver').getByText('Keep local lesson',{exact:false}).waitFor();
 assert.equal(calls.filter(c=>c.path.endsWith('/session-end')).length,1,'A conflict review never repeats the AI save');
 assert.equal(calls.filter(c=>c.path.endsWith('/resolve-conflict')).length,0,'Showing a conflict cannot choose a winning version');
 // A late alpha read cannot overwrite beta state or leave alpha actions enabled.
 mode='late';await page.reload();
 await page.waitForFunction(()=>document.querySelector('[data-testid="project-memory-checking-cancel"]'));
 for(let i=0;i<100&&!releaseLate;i++)await page.waitForTimeout(20);assert.ok(releaseLate);
 await page.getByRole('button',{name:'Switch project',exact:true}).click();
 await page.locator('[data-memory-id="beta-memory"]').waitFor();releaseLate();
 await page.waitForTimeout(250);
 assert.equal(await page.locator('[data-memory-id="alpha-memory"]').count(),0);
 assert.equal(await page.locator('[data-memory-id="beta-memory"]').count(),1);
 assert.equal(await page.getByTestId('project-memory-save-result').count(),0,'A different project cannot inherit the save receipt');
 assert.equal(calls.filter(c=>c.path.endsWith('/sync')).length,1,'Only the explicitly clicked conflict comparison can invoke sync');
 assert.equal(calls.some(c=>/\/project-memory\/(?:init|push|pull|resolve-conflict|update)$/.test(c.path)),false,'Reading and navigation never write memory');
 mode='adapters-current';await page.reload();
 await page.getByTestId('memory-document-format-review').waitFor();
 assert.equal(await page.getByTestId('project-memory-feature-version').innerText(),`v${CURRENT_PROJECT_MEMORY_VERSION}`);
 assert.equal(await page.getByTestId('project-memory-agent-update').count(),0,'Document review alone must not keep asking for an adapter upgrade');
 assert.equal(calls.some(c=>c.path.includes('/upgrade-')),false,'Status and format review never upgrade automatically');
 assert.equal(await progress.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
 await progress.scrollIntoViewIfNeeded();await page.screenshot({path:output+`memory-journey-${engineName}-390.png`});
 assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);await context.close();
 console.log(`PASS ${engineName}: honest first-save state, read recovery, backup-only recovery, project isolation, no AI on navigation`);
 }finally{await browser.close();}
}
