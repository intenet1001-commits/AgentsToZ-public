/** Isolated UI fixture only: no installed app, native bridge, user profile, real registry or remote team execution. */
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium,webkit} from 'playwright';
const origin=process.argv[2],evidence=process.argv[3];
if(!origin||new URL(origin).hostname!=='127.0.0.1'||new URL(origin).port==='3001'||!evidence)throw Error('Owned fixture origin and evidence directory required');
mkdirSync(evidence,{recursive:true});
const module=await fetch(origin+'/src/RemoteTeamsPermissions.tsx').then(result=>result.text()),main=await fetch(origin+'/src/main.tsx').then(result=>result.text());
const react=module.match(/"([^"\n]*\/deps\/react\.js[^"\n]*)"/)?.[1],dom=main.match(/"([^"\n]*\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert(react&&dom,'fixture resolves the actual React modules');
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote Teams permissions fixture</title><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};import '/src/index.css';
const {RemoteTeamsPermissions}=await import('/src/RemoteTeamsPermissions.tsx');const {RemoteTeamsPermissionsError}=await import('/src/remoteTeamsPermissionsClient.ts');const {WorkspaceTools}=await import('/src/components/WorkspaceTools.tsx');
const kind=new URLSearchParams(location.search).get('kind');window.calls=[];let once=false;
let actual={revision:0,configured:kind!=='no-consent',projects:[{projectId:'project-a',name:'첫 프로젝트',allowed:false},{projectId:'project-b',name:'둘째 프로젝트',allowed:false}]};
if(kind==='empty')actual.projects=[];
window.addProject=()=>{actual={...actual,projects:[...actual.projects,{projectId:'project-c',name:'새 프로젝트',allowed:false}]};};
const request=async body=>{window.calls.push(structuredClone(body));if(body.operation==='permissions')return structuredClone(actual);if(kind==='busy')await new Promise(resolve=>{window.finishSave=resolve;});if(kind==='conflict'&&!once){once=true;actual.revision++;throw new RemoteTeamsPermissionsError('REMOTE_TEAMS_REVISION_CONFLICT','다른 창에서 설정이 바뀌었습니다. 최신 목록을 불러와 선택을 다시 확인한 뒤 저장하세요.',409);}actual={...actual,revision:actual.revision+1,projects:actual.projects.map(project=>({...project,allowed:body.projectIds.includes(project.projectId)}))};if(kind==='unknown'&&!once){once=true;throw new RemoteTeamsPermissionsError('REMOTE_TEAMS_UNCONFIRMED','저장 결과를 확인하지 못했습니다. 현재 허용 상태를 다시 읽어 확인하세요.');}return structuredClone(actual);};
function Fixture(){const[open,setOpen]=React.useState(false),opener=React.useRef(null);return React.createElement(React.Fragment,null,React.createElement(WorkspaceTools,{label:'도구 및 설정'},React.createElement('button',{id:'opener',ref:opener,onClick:()=>setOpen(true)},'Teams 원격 작업 허용 프로젝트')),open&&React.createElement(React.StrictMode,null,React.createElement(RemoteTeamsPermissions,{onClose:()=>setOpen(false),request,returnFocusTo:opener.current})));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));</script>`;
for(const[name,engine]of[['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch({headless:true});
 try{for(const width of [1100,390]){
  const page=await browser.newPage({viewport:{width,height:700}}),errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error(name,width,'pageerror',error.message);});page.on('response',response=>{if(response.status()>=400)console.error('fixture response',response.status(),response.url());});
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin||url.pathname.startsWith('/api/'))return route.abort();return route.continue();});
  await page.route('**/__remote_teams_fixture__*',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
  const open=async(kind='ready')=>{await page.goto(origin+'/__remote_teams_fixture__?kind='+kind);await page.locator('.workspace-tools > summary').click();await page.locator('#opener').click();await page.getByRole('dialog').waitFor();if(kind==='empty')await page.getByTestId('remote-teams-selection-count').waitFor();else await page.getByRole('checkbox',{name:'첫 프로젝트',exact:true}).waitFor();};
  const save=()=>page.getByRole('button',{name:'선택한 프로젝트 저장',exact:true}),reload=()=>page.getByRole('button',{name:'현재 허용 상태 다시 읽기',exact:true});
  const all=()=>page.getByRole('button',{name:'전체 선택',exact:true}),clear=()=>page.getByRole('button',{name:'전체 해제',exact:true}),count=()=>page.getByTestId('remote-teams-selection-count');
  await open();assert.equal(await save().isDisabled(),true);assert.equal(await page.getByRole('checkbox',{checked:true}).count(),0,'default none');
  assert.equal(await page.evaluate(()=>calls.length),1,'StrictMode opens only one read');
  assert.equal(await clear().isDisabled(),true);await all().click();
  assert.equal(await page.getByRole('checkbox',{checked:true}).count(),2);assert.equal(await count().textContent(),'총 2개 중 2개 선택');assert.equal(await all().isDisabled(),true);
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.operation==='set-permissions').length),0,'select all changes only the current draft');
  await clear().click();assert.equal(await count().textContent(),'총 2개 중 0개 선택');assert.equal(await save().isDisabled(),true);assert.equal(await page.evaluate(()=>calls.filter(call=>call.operation==='set-permissions').length),0,'clear all does not write');
  await page.getByRole('checkbox',{name:'첫 프로젝트',exact:true}).check();await save().click();await page.getByRole('status').waitFor();
  assert.deepEqual(await page.evaluate(()=>calls.filter(call=>call.operation==='set-permissions')),[{operation:'set-permissions',expectedRevision:0,projectIds:['project-a']}]);
  await all().click();assert.equal(await page.evaluate(()=>calls.filter(call=>call.operation==='set-permissions').length),1);await save().click();await page.getByRole('status').waitFor();
  assert.deepEqual(await page.evaluate(()=>calls.filter(call=>call.operation==='set-permissions')),[{operation:'set-permissions',expectedRevision:0,projectIds:['project-a']},{operation:'set-permissions',expectedRevision:1,projectIds:['project-a','project-b']}],'one explicit CAS save after selecting the current list');
  await page.evaluate(()=>addProject());await reload().click();await page.getByRole('checkbox',{name:'새 프로젝트',exact:true}).waitFor();
  assert.equal(await page.getByRole('checkbox',{name:'새 프로젝트',exact:true}).isChecked(),false,'new projects never inherit allowance');
  assert.equal(await count().textContent(),'총 3개 중 2개 선택');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow');
  await page.screenshot({path:evidence+'/'+name+'-'+width+'-ready.png',fullPage:true});
  await clear().click();assert.equal(await page.getByRole('checkbox',{checked:true}).count(),0);assert.equal(await page.evaluate(()=>calls.filter(call=>call.operation==='set-permissions').length),2);await save().click();await page.getByRole('status').waitFor();
  assert.deepEqual(await page.evaluate(()=>calls.filter(call=>call.operation==='set-permissions').at(-1)),{operation:'set-permissions',expectedRevision:2,projectIds:[]},'clear all is saved only by the explicit existing Save');
  await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(await page.locator('#opener').evaluate(element=>element===document.activeElement),true,'focus returns to the settings action');
  await open('empty');assert.equal(await count().textContent(),'총 0개 중 0개 선택');assert.equal(await all().isDisabled(),true);assert.equal(await clear().isDisabled(),true);assert.equal(await save().isDisabled(),true);
  await open('busy');await all().click();await save().click();await page.waitForFunction(()=>typeof finishSave==='function');
  assert.equal(await all().isDisabled(),true);assert.equal(await clear().isDisabled(),true);assert.equal(await page.getByRole('button',{name:'확인 중…',exact:true}).isDisabled(),true);assert.equal(await reload().isDisabled(),true);
  await page.evaluate(()=>finishSave());await page.getByRole('status').waitFor();assert.equal(await clear().isDisabled(),false);assert.equal(await page.evaluate(()=>calls.filter(call=>call.operation==='set-permissions').length),1);
  await open('no-consent');assert.equal(await page.getByRole('checkbox',{name:'첫 프로젝트',exact:true}).isDisabled(),true);assert.equal(await save().isDisabled(),true);assert.equal(await all().isDisabled(),true);assert.equal(await clear().isDisabled(),true);assert.equal(await page.evaluate(()=>calls.some(call=>call.operation==='set-permissions')),false);
  for(const kind of ['conflict','unknown']){
   await open(kind);await page.getByRole('checkbox',{name:'첫 프로젝트',exact:true}).check();await save().click();await page.getByRole('alert').waitFor();
   assert.equal(await save().isDisabled(),true);assert.equal(await all().isDisabled(),true);assert.equal(await clear().isDisabled(),true);assert.equal(await page.evaluate(()=>calls.filter(call=>call.operation==='set-permissions').length),1,'no automatic mutation replay');
   await reload().click();await page.getByRole('alert').waitFor({state:'hidden'});assert.equal(await page.getByRole('checkbox',{name:'첫 프로젝트',exact:true}).isChecked(),true,'explicit reload retains the reviewed registered ID');
   if(kind==='conflict'){await save().click();await page.getByRole('status').waitFor();assert.deepEqual(await page.evaluate(()=>calls.filter(call=>call.operation==='set-permissions').map(call=>call.expectedRevision)),[0,1]);}
   else assert.equal(await save().isDisabled(),true,'an unknown successful write is observed without a second mutation');
  }
  assert.deepEqual(errors,[]);await page.close();console.log(name+' '+width+': PASS');
 }}finally{await browser.close();}
}
