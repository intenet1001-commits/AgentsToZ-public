/** Real components, owned HTTP fixture and fresh Chromium/WebKit contexts. No app, AI, native grant or user profile. */
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium,webkit} from 'playwright';
const origin=process.argv[2];if(!origin||new URL(origin).hostname!=='127.0.0.1'||new URL(origin).port==='3001')throw Error('Owned fixture origin required');
const source=await fetch(origin+'/src/WorkroomScheduleCard.tsx').then(r=>r.text()),main=await fetch(origin+'/src/main.tsx').then(r=>r.text());
const react=source.match(/"([^"\n]*\/deps\/react\.js[^"\n]*)"/)?.[1],dom=main.match(/"([^"\n]*\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert(react&&dom);
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Owned schedule and effort fixture</title><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};import '/src/index.css';
const{WorkroomScheduleCard}=await import('/src/WorkroomScheduleCard.tsx'),{DesktopEffortPanel}=await import('/src/DesktopEffortPanel.tsx'),{WorkspaceTools}=await import('/src/components/WorkspaceTools.tsx');
window.calls=[];window.failCreate=false;let schedules=[],runs=[];const kind=new URLSearchParams(location.search).get('kind');window.canRestore=kind!=='no-restore';
const binding={sessionId:'session_fixture',targetId:'project_fixture',agent:'codex',model:'gpt-fixture',accountId:'host-default',identity:'a'.repeat(64),bypass:false};
const request=async body=>{window.calls.push(body);if(body.operation==='create'&&window.failCreate)throw Error('fixture create unavailable');if(body.operation==='create'&&!schedules.some(s=>s.id===body.id))schedules=[{...body,binding,...(body.autoRestore?{currentSessionId:'restored_fixture'}:{}),state:'active',revision:1,consentRevision:1,runCount:0,reason:'다음 시각을 기다립니다.'}];
if(body.operation==='pause'){schedules[0].state='paused';schedules[0].revision++;}if(body.operation==='resume'){schedules[0].state='active';schedules[0].revision++;}
if(body.operation==='run-now'){runs=[{id:'run_fixture',scheduleId:schedules[0].id,sessionId:binding.sessionId,state:'unknown',startedAt:Date.now(),reason:'결과를 확인해야 합니다.'}];schedules[0].state='needs-human';schedules[0].revision++;}
if(body.operation==='review'){runs[0].state='reviewed';runs[0].reason='사용자가 실제 결과를 확인했습니다. 이 실행은 다시 보내지 않습니다.';}return{success:true,enabled:true,snapshot:{binding:{...binding,sessionId:body.sessionId||binding.sessionId},ready:true,canStartNew:true,canRestore:window.canRestore,inputRevision:0,outputCursor:0},schedules:[...schedules],runs:[...runs]};};
let mode='recommend',revision=1,fixed,minimum;const effort=async body=>{window.calls.push(body);if(body.operation==='configure'){mode=body.mode;fixed=body.fixed;minimum=body.minimum;revision++;}return{success:true,adapters:[{id:'hermes-desktop',label:'Hermes',available:kind!=='empty',reason:'현재 네이티브 입력칸 상태를 확인할 수 없습니다.'}],sessions:kind==='empty'?[]:[{id:'effort_fixture',label:'Owned Hermes',binding:{adapter:'hermes-desktop',adapterVersion:'test',sessionId:'native_session',generation:1,model:'gpt-fixture',provider:'openai',accountId:'fixture-profile'},mode,revision,fixed,minimum,expiresAt:mode==='auto'?Date.now()+600000:0}]};};
function App(){const[show,setShow]=React.useState(false),[session,setSession]=React.useState(binding.sessionId),opener=React.useRef(null);return React.createElement(React.Fragment,null,React.createElement(WorkroomScheduleCard,{sessionId:session,visible:true,request,onOpen:id=>window.calls.push({open:id})}),React.createElement('button',{id:'change-session',onClick:()=>setSession('another_fixture')},'테스트 세션 전환'),React.createElement(WorkspaceTools,{label:'도구 및 설정'},React.createElement('button',{id:'opener',ref:opener,onClick:()=>setShow(true)},'외부 앱 에포트')),show&&React.createElement(DesktopEffortPanel,{request:effort,onClose:()=>setShow(false),returnFocusTo:opener.current}));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));</script>`;
const evidence=process.env.SCHEDULE_EFFORT_UI_OUT??'/tmp/agentstoz-schedule-effort-ui-20261027';mkdirSync(evidence,{recursive:true});
for(const[name,engine]of[['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch({headless:true});
 try{for(const width of[1100,390]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin||url.pathname.startsWith('/api/'))return route.abort();return route.continue();});
  await page.route('**/__schedule_effort_fixture__*',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
  await page.goto(origin+'/__schedule_effort_fixture__?kind=ready');
  const card=page.getByTestId('workroom-schedule-card');await page.getByRole('button',{name:'예약 만들기'}).click();
  const create=page.getByRole('button',{name:'예약 켜기',exact:true});assert.equal(await create.isEnabled(),false);
  await page.getByLabel('예약 이름',{exact:true}).fill('프로젝트 상태 확인');await page.getByLabel('예약할 작업',{exact:true}).fill('프로젝트 상태를 확인하고 한글로 보고해 줘.');
  await page.getByLabel('반복 간격', {exact:false}).fill('5');await page.getByLabel('최대 실행 횟수',{exact:true}).fill('3');
  const restore=page.getByRole('checkbox',{name:'종료된 이 대화의 자동 복원을 허용합니다.'}),allow=page.getByRole('checkbox',{name:'이 대상과 작업을 지정한 시각·횟수 안에서 실행하도록 허용합니다.'});
  assert.equal(await restore.isChecked(),false);await page.getByText('호스트를 다시 시작한 뒤 원래 대화를 증명할 수 없으면 예약이 중단될 수 있습니다.').waitFor();await allow.check();await restore.check();
  await page.evaluate(()=>{window.canRestore=false});await page.getByRole('button',{name:'새로 고침'}).click();await restore.waitFor({state:'detached'});
  await page.evaluate(()=>{window.canRestore=true});await page.getByRole('button',{name:'새로 고침'}).click();await restore.waitFor({state:'visible'});assert.equal(await restore.isChecked(),false);await restore.check();
  await page.evaluate(()=>{window.failCreate=true});await create.click();await page.waitForFunction(()=>window.calls.filter(c=>c.operation==='create').length===1);
  await page.getByLabel('실행 위치').selectOption('new-conversation');assert.equal(await restore.count(),0);await create.click();await page.waitForFunction(()=>window.calls.filter(c=>c.operation==='create').length===2);
  await page.getByLabel('실행 위치').selectOption('continue');assert.equal(await restore.isChecked(),false);await create.click();await page.waitForFunction(()=>window.calls.filter(c=>c.operation==='create').length===3);
  await restore.check();await page.locator('#change-session').click();await page.getByRole('button',{name:'예약 만들기'}).click();assert.equal(await restore.isChecked(),false);assert.equal(await allow.isChecked(),false);
  await allow.check();await restore.check();await page.evaluate(()=>{window.failCreate=false});await create.click();
  const summary=card.locator('details > summary');await summary.waitFor();await summary.click();await page.getByRole('button',{name:'대화 열기',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls.find(c=>c.open)?.open),'restored_fixture');
  await page.getByRole('button',{name:'일시정지',exact:true}).click();await page.getByRole('button',{name:'확인 후 다시 켜기'}).click();
  await page.getByRole('button',{name:'지금 실행',exact:true}).click();await page.getByText('결과를 확인해야 합니다.',{exact:true}).waitFor();
  const review=page.getByRole('button',{name:'결과 확인 완료',exact:true});assert.equal(await review.isEnabled(),false);await page.getByRole('checkbox',{name:'실제 작업 결과를 확인했습니다.',exact:false}).check();await review.click();
  await page.waitForFunction(()=>window.calls.some(c=>c.operation==='review'));assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.operation==='run-now').length),1);
  const attempts=await page.evaluate(()=>window.calls.filter(c=>c.operation==='create'));assert.equal(attempts.length,4);assert.equal(new Set(attempts.map(c=>c.id)).size,4);assert.equal(attempts[0].autoRestore,true);assert.equal('autoRestore'in attempts[1],false);assert.equal('autoRestore'in attempts[2],false);const created=attempts[3];assert.equal(created.consent,true);assert.equal(created.autoRestore,true);assert.equal(created.sessionId,'another_fixture');assert.equal(created.intervalMs,300000);assert.equal(created.mode,'continue');assert.equal(created.maxRuns,3);
  await page.screenshot({path:evidence+'/'+name+'-'+width+'-schedule.png',fullPage:true});assert.equal(await card.evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);
  await page.locator('.workspace-tools > summary').click();await page.locator('#opener').click();const dialog=page.getByRole('dialog');await page.getByText('Owned Hermes',{exact:true}).waitFor();
  await page.getByLabel('모드',{exact:true}).selectOption('auto');const apply=page.getByRole('button',{name:'이 세션에 적용',exact:true});assert.equal(await apply.isEnabled(),false);
  await page.getByLabel('최소 강도',{exact:true}).selectOption('xhigh');await page.getByRole('checkbox',{name:'이 세션에서 최대 10분 동안 자동 변경을 허용합니다.'}).check();await apply.click();
  await page.waitForFunction(()=>window.calls.some(c=>c.operation==='configure'));const configured=await page.evaluate(()=>window.calls.find(c=>c.operation==='configure'));assert.equal(configured.mode,'auto');assert.equal(configured.minimum,'xhigh');assert.equal(configured.consent,true);assert.equal(configured.allowLowering,false);
  await page.waitForFunction(()=>document.querySelector('select[aria-label="최소 강도"]')?.value==='xhigh');assert.equal(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);await page.screenshot({path:evidence+'/'+name+'-'+width+'-effort.png',fullPage:true});
  await dialog.dispatchEvent('keydown',{key:'Escape',isComposing:true,keyCode:229,bubbles:true});assert.equal(await dialog.count(),1);await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);assert.equal(await page.locator('#opener').evaluate(e=>e===document.activeElement),true,'the visible opener regains focus while the tools menu stays open');
  await page.locator('#opener').click();await page.getByText('Owned Hermes',{exact:true}).waitFor();
  await page.locator('.workspace-tools').evaluate(e=>{e.open=false});
  await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);assert.equal(await page.locator('.workspace-tools > summary').evaluate(e=>e===document.activeElement),true,'a closed disclosure returns focus to its visible summary');
  await page.goto(origin+'/__schedule_effort_fixture__?kind=no-restore');await page.getByRole('button',{name:'예약 만들기'}).click();assert.equal(await page.getByRole('checkbox',{name:'종료된 이 대화의 자동 복원을 허용합니다.'}).count(),0);
  await page.getByLabel('예약 이름',{exact:true}).fill('지원되지 않는 복원');await page.getByLabel('예약할 작업',{exact:true}).fill('현재 대화 상태 확인');await page.getByRole('checkbox',{name:'이 대상과 작업을 지정한 시각·횟수 안에서 실행하도록 허용합니다.'}).check();await page.getByRole('button',{name:'예약 켜기'}).click();await page.waitForFunction(()=>window.calls.some(c=>c.operation==='create'));assert.equal(await page.evaluate(()=>('autoRestore'in window.calls.find(c=>c.operation==='create'))),false);await page.getByTestId('workroom-schedule-card').locator('details > summary').click();await page.getByRole('button',{name:'대화 열기',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls.find(c=>c.open)?.open),'session_fixture');
  await page.goto(origin+'/__schedule_effort_fixture__?kind=empty');await page.locator('.workspace-tools > summary').click();await page.locator('#opener').click();
  await page.getByText('자동 변경을 지원하는 네이티브 세션이 연결되어 있지 않습니다.',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'이 세션에 적용'}).count(),0);
  assert.deepEqual(errors,[]);await page.close();console.log(name+' '+width+': schedule/consent/pause/review/native-session-mode/unsupported/IME/focus PASS');
 }}finally{await browser.close();}
}
