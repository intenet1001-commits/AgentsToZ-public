import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {workModeCopy} from '../src/i18n';
const copy=workModeCopy('ko');
const built=await Bun.build({entrypoints:['tests/fixtures/voice/popout.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
if(!built.success)throw Error(built.logs.join('\n'));
const js=built.outputs.find(f=>f.path.endsWith('.js')),css=built.outputs.find(f=>f.path.endsWith('.css'));
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>{
 const p=new URL(r.url).pathname;
 return p==='/app.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):p==='/app.css'?new Response(css,{headers:{'Content-Type':'text/css'}}):new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;--bg:#131211;--surface:#1d1c19;--ink:#f4efe3;--ink-2:#a8a29e;--accent:#ef995e;--line:#383630;font-family:system-ui}</style><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>',{headers:{'Content-Type':'text/html'}});
}});
mkdirSync('.agentstoz/maintainer/work-mode',{recursive:true});
try{for(const [name,engine] of Object.entries({chromium,webkit})){
 const browser=await engine.launch();try{
  const page=await browser.newPage({viewport:{width:420,height:650}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(server.url.toString());
  await page.getByTestId('work-mode-open').click();await page.getByText('지금은 쉬는 중',{exact:true}).waitFor();
  await page.getByRole('button',{name:'24시간',exact:true}).click();await page.getByRole('checkbox',{name:'화면도 계속 켜 두기'}).check();
  await page.getByRole('button',{name:'근무 시작',exact:true}).click();await page.getByRole('button',{name:'지금 퇴근',exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='set_work_mode').at(-1).args),{minutes:1440,keepDisplayOn:true});
  await page.getByText(/화면도 켜짐/).waitFor();
  for(const width of [280,320,420]){
   await page.setViewportSize({width,height:650});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');
   for(const control of await page.locator('.voice-popout__titlebar button, .voice-popout__titlebar input').all()){
    const box=await control.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width,'every control stays in the narrow dock');
   }
   const help=await page.getByTestId('voice-helpdesk-open').boundingBox();assert.ok(help.x>=70&&help.y+help.height<=38,'helpdesk and native traffic lights stay accessible');
  }
  await page.setViewportSize({width:420,height:650});
  await page.screenshot({path:`.agentstoz/maintainer/work-mode/${name}-active.png`});
  // Failure leaves the native mode and its stop action available.
  await page.evaluate(()=>window.failWorkMode=true);await page.getByRole('button',{name:'시간 다시 시작',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'전원 요청 실패'}).waitFor();assert.equal(await page.getByRole('button',{name:'지금 퇴근',exact:true}).count(),1);
  await page.evaluate(()=>window.failWorkMode=false);
  await page.getByRole('button',{name:'지금 퇴근',exact:true}).click();await page.getByText('지금은 쉬는 중',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.workMode().endsAt),null);
  const before=await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='set_work_mode').length);
  await page.getByRole('spinbutton',{name:'근무 시간 (분)'}).fill('1441');await page.getByRole('button',{name:'근무 시작',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='set_work_mode').length),before,'invalid duration makes no native request');
  await page.getByRole('spinbutton',{name:'근무 시간 (분)'}).fill('17');await page.getByRole('button',{name:'근무 시작',exact:true}).click();
  await page.getByRole('button',{name:'지금 퇴근',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='set_work_mode').at(-1).args.minutes),17);
  // 연중무휴: no minutes, no end time, held until 「지금 퇴근」.
  await page.getByRole('button',{name:'연중무휴',exact:true}).click();
  assert.equal(await page.getByRole('spinbutton',{name:'근무 시간 (분)'}).count(),0,'always-on takes no duration');
  await page.getByText(/앱을 완전히 종료할 때까지 잠들지 않아요/).waitFor();
  await page.getByRole('button',{name:'연중무휴 시작',exact:true}).click();await page.getByText(/연중무휴 · 퇴근할 때까지 유지/).waitFor();
  const always=await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='set_work_mode').at(-1).args);
  assert.equal(always.alwaysOn,true);assert.equal(always.minutes,0);
  assert.match(await page.getByTestId('work-mode-open').innerText(),/연중무휴 근무/);
  assert.equal(await page.evaluate(()=>window.workMode().endsAt),null);
  await page.getByRole('button',{name:'지금 퇴근',exact:true}).click();await page.getByText('지금은 쉬는 중',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.workMode().alwaysOn),false);
  await page.getByRole('button',{name:'1시간',exact:true}).click();
  // Another native window's event wins over an older in-flight response.
  await page.evaluate(()=>{window.nativeEvent('work-mode:changed',{supported:true,revision:100,endsAt:null,keepDisplayOn:false});window.nativeEvent('work-mode:changed',{supported:true,revision:99,endsAt:Date.now()+60000,keepDisplayOn:true});});
  await page.getByText('지금은 쉬는 중',{exact:true}).waitFor();
  await page.getByRole('spinbutton',{name:'근무 시간 (분)'}).press('Escape');assert.equal(await page.getByRole('region',{name:'근무 모드 설정'}).count(),0);
  assert.equal(await page.getByTestId('work-mode-open').evaluate(n=>n===document.activeElement),true);
  await page.getByTestId('work-mode-open').click();await page.getByTestId('voice-dock-call').click();assert.equal(await page.getByRole('region',{name:'근무 모드 설정'}).count(),0,'outside action also dismisses settings');
  assert.equal(await page.evaluate(()=>window.nativeCalls.some(c=>c.command==='agent_runtime_request'&&c.args.body.action==='prepare')),false,'work mode never starts AI');
  // Closed-lid work: gated by a one-time grant, sent only when chosen, reported in the status line.
  // The injected events above carried no lid and a high revision; the native side now reports its own, newer state.
  await page.evaluate(()=>{window.setWorkMode({revision:200});window.nativeEvent('work-mode:changed',{...window.workMode()});});
  await page.getByTestId('work-mode-open').click();
  await page.getByRole('checkbox',{name:'덮개를 닫아도 계속 근무',exact:true}).check();
  await page.getByText(/pmset 잠자기 끄기·켜기 두 명령만 허용해요/).waitFor();
  assert.equal(await page.getByRole('button',{name:'근무 시작',exact:true}).isDisabled(),true,'no hold before the one-time grant');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'grant hint wraps in the dock');
  await page.evaluate(()=>window.cancelGrant=true);await page.getByRole('button',{name:'처음 한 번 허용',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'허용을 취소했어요'}).waitFor();
  await page.evaluate(()=>window.cancelGrant=false);await page.getByRole('button',{name:'처음 한 번 허용',exact:true}).click();
  await page.getByRole('button',{name:'허용 지우기',exact:true}).waitFor();
  const grant=await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='set_closed_lid_grant').at(-1).args);
  assert.equal(grant.granted,true);assert.match(grant.prompt,/pmset disablesleep 0·1 두 명령만/);
  await page.getByRole('button',{name:'근무 시작',exact:true}).click();await page.getByText(/덮개 닫아도 근무/).waitFor();
  assert.equal(await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='set_work_mode').at(-1).args.closedLid),true);
  assert.equal(await page.getByRole('button',{name:'허용 지우기',exact:true}).count(),0,'no revoke under a live hold');
  await page.screenshot({path:`.agentstoz/maintainer/work-mode/${name}-closed-lid.png`});
  // Low battery pauses the lid hold while the work session itself remains active.
  await page.evaluate(()=>{const m=window.workMode();window.nativeEvent('work-mode:changed',{...m,revision:m.revision+1,lid:{...m.lid,state:'lowBattery'}});});
  await page.getByText(/배터리가 얼마 남지 않아 잠시 멈췄어요 · 충전하면 다시 켜져요/).waitFor();
  await page.getByRole('button',{name:'지금 퇴근',exact:true}).click();await page.getByText('지금은 쉬는 중',{exact:true}).waitFor();
  const stop=await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='set_work_mode').at(-1).args);
  assert.equal(stop.minutes,0);assert.equal('closedLid' in stop,false,'stopping never asks for a hold');
  assert.equal(await page.evaluate(()=>window.workMode().lid.state),'off');
  // AgentsToZ Screen: the panel says where the helper is and opens it; switching it on stays in the helper.
  await page.getByTestId('work-mode-screen-status').waitFor();
  assert.match(await page.getByTestId('work-mode-screen-status').innerText(),/AgentsToZ Screen이 꺼져 있어요/);
  await page.getByTestId('work-mode-screen-open').click();
  await page.getByText('AgentsToZ Screen 실행 중 · 화면 제어 꺼짐',{exact:true}).waitFor();
  await page.getByText('조작하려면 손쉬운 사용·입력 모니터링 권한이 필요해요',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='open_screen_helper').map(c=>c.args)),[{}],'opening takes no arguments');
  // The panel reads the helper again when it opens.
  const reopen=async()=>{await page.getByTestId('work-mode-open').click();await page.getByTestId('work-mode-open').click();await page.getByTestId('work-mode-screen-status').waitFor();};
  await page.evaluate(()=>window.setScreenHelper({state:{power:'on',viewing:true,devices:2,capture:true,control:true,loginItem:'approval'}}));
  await reopen();
  await page.getByText('화면 제어 켜짐 · 등록된 기기 2대',{exact:true}).waitFor();
  await page.getByText('현재 연결 1대 · 이 Mac 화면을 보고 있어요',{exact:true}).waitFor();
  await page.getByText(/시스템 설정에서 허용해야/).waitFor();
  assert.equal(await page.getByText('조작하려면 손쉬운 사용·입력 모니터링 권한이 필요해요',{exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'the screen section wraps in the dock');
  await page.screenshot({path:`.agentstoz/maintainer/work-mode/${name}-screen.png`});
  // On, but the Mac is off an approved network: no device can connect, so no count of devices that can.
  await page.evaluate(()=>window.setScreenHelper({state:{power:'waiting',viewing:false,devices:2,capture:true,control:true,loginItem:'on'}}));
  await reopen();
  await page.getByText(/지금 네트워크에서는 연결을 받지 않아요/).waitFor();
  assert.equal(await page.getByText(/등록된 기기 2대/).count(),0,'waiting is not shown as ready for devices');
  // Asked but not yet seen running: say where to look, neither success nor failure.
  await page.evaluate(()=>window.unverifiedScreenOpen=true);await page.getByTestId('work-mode-screen-open').click();
  await page.getByText(/메뉴 막대의 화면 아이콘을 확인하세요/).waitFor();
  await page.evaluate(()=>{window.unverifiedScreenOpen=false;window.failScreenOpen=true;});await page.getByTestId('work-mode-screen-open').click();
  await page.getByRole('alert').filter({hasText:'AgentsToZ Screen을 열지 못했습니다'}).waitFor();
  await page.evaluate(()=>{window.failScreenOpen=false;window.setScreenHelper({installed:false,running:false,state:null});});
  await reopen();
  await page.getByText(/AgentsToZ Screen 설치가 필요해요/).waitFor();
  assert.equal(await page.getByTestId('work-mode-screen-open').isEnabled(),true,'a failed startup installation can be retried');
  await page.evaluate(()=>window.failScreenOpen=true);
  await page.getByTestId('work-mode-screen-open').click();
  await page.getByRole('alert').filter({hasText:'AgentsToZ Screen을 열지 못했습니다'}).waitFor();
  assert.equal(await page.getByTestId('work-mode-screen-open').isEnabled(),true,'installation failure keeps the retry available');
  await page.evaluate(()=>window.failScreenOpen=false);
  await page.getByTestId('work-mode-screen-open').click();
  await page.getByText('AgentsToZ Screen 실행 중 · 화면 제어 꺼짐',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='open_screen_helper').slice(-2).map(c=>c.args)),[{},{}],'retry uses the same bounded install/open command');
  // An old running Screen remains usable while its update waits; opening proves running, never latest.
  await page.evaluate(()=>window.setScreenHelper({running:true,updatePending:true,state:{power:'on',viewing:true,devices:2,capture:true,control:true,loginItem:'off'}}));await reopen();
  await page.getByText(copy.screenUpdatePending,{exact:true}).waitFor();
  await page.getByText('현재 연결 1대 · 이 Mac 화면을 보고 있어요',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('work-mode-screen-open').isEnabled(),true,'pending alone does not stop opening the current installed app');
  await page.getByTestId('work-mode-screen-open').click();await page.getByText(copy.screenUpdatePending,{exact:true}).waitFor();
  await page.screenshot({path:`.agentstoz/maintainer/work-mode/${name}-screen-update-pending.png`});
  const screenCalls=await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='open_screen_helper').length);
  await page.evaluate(()=>window.setScreenHelper({otherInstanceRunning:true,running:false,state:null}));await reopen();
  await page.getByText(copy.screenOtherInstance,{exact:true}).waitFor();
  assert.equal(await page.getByTestId('work-mode-screen-open').count(),0,'another-path instance is not opened or mistaken for the installed copy');
  await page.evaluate(()=>window.setScreenHelper({otherInstanceRunning:false,instanceStatusUnknown:true}));await reopen();
  await page.getByText(copy.screenInstanceUnknown,{exact:true}).waitFor();
  assert.equal(await page.getByTestId('work-mode-screen-open').count(),0,'unknown process observations do not authorize opening');
  assert.equal(await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='open_screen_helper').length),screenCalls,'status and blocked rendering never launch a helper');
  await page.evaluate(()=>window.setScreenHelper({otherInstanceRunning:false,instanceStatusUnknown:false,updatePending:false,running:true,state:{power:'off',viewing:false,devices:0,capture:true,control:false,loginItem:'off'}}));await reopen();
  await page.getByText(copy.screenOff,{exact:true}).waitFor();
  assert.equal(await page.getByTestId('work-mode-screen-open').isEnabled(),true,'a fresh clear observation restores the human open action');
  // AgentsToZ Viewer (docs/design/mac-to-mac-2026-11-01 5.4): 「다른 Mac 화면 보기」 opens the app, naming no Mac and starting nothing.
  await page.getByTestId('work-mode-viewer-status').waitFor();
  assert.match(await page.getByTestId('work-mode-viewer-status').innerText(),/AgentsToZ Viewer가 꺼져 있어요/);
  await page.getByRole('button',{name:'다른 Mac 화면 보기',exact:true}).click();
  await page.getByText('AgentsToZ Viewer 실행 중',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='open_viewer_helper').map(c=>c.args)),[{}],'opening the Viewer takes no arguments');
  // Asked but not yet seen running: where to look, neither success nor failure.
  await page.evaluate(()=>window.unverifiedViewerOpen=true);await page.getByTestId('work-mode-viewer-open').click();
  await page.getByText(/Dock에서 AgentsToZ Viewer를 확인하세요/).waitFor();
  // A failure is said, and the button stays to try again.
  await page.evaluate(()=>{window.unverifiedViewerOpen=false;window.failViewerOpen=true;});await page.getByTestId('work-mode-viewer-open').click();
  await page.getByRole('alert').filter({hasText:'AgentsToZ Viewer를 열지 못했습니다'}).waitFor();
  assert.equal(await page.getByTestId('work-mode-viewer-open').isEnabled(),true,'a failed Viewer open can be retried');
  await page.evaluate(()=>window.failViewerOpen=false);
  // Carried but not installed (a failed startup installation): the same button retries it.
  await page.evaluate(()=>window.setViewerHelper({installed:false,running:false}));await reopen();
  await page.getByText(/AgentsToZ Viewer 설치가 필요해요/).waitFor();
  assert.equal(await page.getByTestId('work-mode-viewer-open').isEnabled(),true,'a failed Viewer installation can be retried');
  // A newer Viewer waiting for the running one to close is said, not done under the person (SR-35).
  await page.evaluate(()=>window.setViewerHelper({installed:true,running:true,updatePending:true}));await reopen();
  await page.getByText(/새 버전이 기다리고 있어요/).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'the Viewer section wraps in the dock');
  await page.screenshot({path:`.agentstoz/maintainer/work-mode/${name}-viewer.png`});
  const viewerCalls=await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='open_viewer_helper').length);
  await page.evaluate(()=>window.setViewerHelper({running:false,otherInstanceRunning:true}));await reopen();
  await page.getByText(copy.viewerOtherInstance,{exact:true}).waitFor();
  assert.equal(await page.getByTestId('work-mode-viewer-open').isDisabled(),true,'a different Viewer path is a blocker, not the installed running app');
  await page.evaluate(()=>window.setViewerHelper({otherInstanceRunning:false,instanceStatusUnknown:true}));await reopen();
  await page.getByText(copy.viewerInstanceUnknown,{exact:true}).waitFor();
  assert.equal(await page.getByTestId('work-mode-viewer-open').isDisabled(),true,'unknown Viewer observations block opening without claiming another app runs');
  assert.equal(await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='open_viewer_helper').length),viewerCalls,'blocked or observed Viewer states start no app or session');
  await page.evaluate(()=>window.setViewerHelper({otherInstanceRunning:false,instanceStatusUnknown:false,updatePending:false,running:true}));await reopen();
  await page.getByText(copy.viewerRunning,{exact:true}).waitFor();
  assert.equal(await page.getByTestId('work-mode-viewer-open').isEnabled(),true,'opening recovers after a fresh clear observation');
  // Older successes cannot overwrite a newer unknown result; each mock keeps a bounded number of replies per helper.
  await page.evaluate(()=>{window.holdNextScreenStatus=true;window.holdNextViewerStatus=true;});
  await page.waitForFunction(()=>window.heldHelperStatuses().length===2);
  await page.evaluate(()=>{window.failScreenStatus=true;window.failViewerStatus=true;});
  await page.getByText(copy.screenInstanceUnknown,{exact:true}).waitFor();await page.getByText(copy.viewerInstanceUnknown,{exact:true}).waitFor();
  await page.evaluate(()=>window.releaseHeldHelperStatuses(true));await page.waitForTimeout(100);
  assert.equal(await page.getByText(copy.screenInstanceUnknown,{exact:true}).count(),1,'late success cannot erase the newer unknown Screen state');
  assert.equal(await page.getByText(copy.viewerInstanceUnknown,{exact:true}).count(),1,'late success cannot erase the newer unknown Viewer state');
  assert.equal(await page.getByTestId('work-mode-screen-open').count(),0,'a rejected status read fences the previous Screen state');
  assert.equal(await page.getByTestId('work-mode-viewer-open').isDisabled(),true,'a rejected status read fences the previous Viewer state');
  // Nor can an older failure erase a newer recovery through the same existing 5s poll.
  await page.evaluate(()=>{window.holdNextScreenStatus=true;window.holdNextViewerStatus=true;window.failScreenStatus=false;window.failViewerStatus=false;});
  await page.waitForFunction(()=>window.heldHelperStatuses().length===2);
  await page.getByText(copy.screenOff,{exact:true}).waitFor();await page.getByText(copy.viewerRunning,{exact:true}).waitFor();
  await page.evaluate(()=>window.releaseHeldHelperStatuses(false));await page.waitForTimeout(100);
  assert.equal(await page.getByText(copy.screenOff,{exact:true}).count(),1,'late failure cannot erase a newer Screen recovery');
  assert.equal(await page.getByText(copy.viewerRunning,{exact:true}).count(),1,'late failure cannot erase a newer Viewer recovery');
  assert.equal(await page.getByTestId('work-mode-screen-open').isEnabled(),true);
  assert.equal(await page.getByTestId('work-mode-viewer-open').isEnabled(),true);
  // A newer query that is only pending cannot erase the observed rejection of its predecessor.
  await page.evaluate(()=>{window.holdNextScreenStatus=true;window.holdNextViewerStatus=true;});
  await page.waitForFunction(()=>window.heldHelperStatuses().length===2);
  await page.evaluate(()=>{window.holdNextScreenStatus=true;window.holdNextViewerStatus=true;});
  await page.waitForFunction(()=>window.heldHelperStatuses().length===4);
  await page.evaluate(()=>window.releaseHeldHelperStatuses(false,true));
  await page.getByText(copy.screenInstanceUnknown,{exact:true}).waitFor();await page.getByText(copy.viewerInstanceUnknown,{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.heldHelperStatuses().length),2,'the newer reads are still pending, not evidence of success');
  assert.equal(await page.getByTestId('work-mode-screen-open').count(),0,'the older known failure blocks Screen while the newer read is pending');
  assert.equal(await page.getByTestId('work-mode-viewer-open').isDisabled(),true,'the older known failure blocks Viewer while the newer read is pending');
  await page.evaluate(()=>window.releaseHeldHelperStatuses(true));
  await page.getByText(copy.screenOff,{exact:true}).waitFor();await page.getByText(copy.viewerRunning,{exact:true}).waitFor();
  assert.equal(await page.getByTestId('work-mode-screen-open').isEnabled(),true);
  assert.equal(await page.getByTestId('work-mode-viewer-open').isEnabled(),true);
  // An app that carries no Viewer and has none installed offers no button that could only fail.
  await page.evaluate(()=>window.setViewerHelper({installed:false,bundled:false,running:false,updatePending:false}));await reopen();
  assert.equal(await page.getByTestId('work-mode-viewer').count(),0,'no Viewer section without a Viewer');
  assert.equal(await page.evaluate(()=>window.nativeCalls.some(c=>c.command==='agent_runtime_request'&&c.args.body.action==='prepare')),false,'opening the Viewer never starts AI');
  await page.evaluate(()=>window.setViewerHelper({installed:true,bundled:true,running:false,updatePending:false}));
  assert.deepEqual(errors,[]);
  const main=await browser.newPage({viewport:{width:960,height:720}});await main.goto(server.url+'?workmode-main=1');
  // The trigger used to sit on x=0 and read as cut while the brand and tabs are inset (UI audit 2026-10-24).
  assert.ok((await main.getByTestId('work-mode-open').boundingBox()).x>=8,'main trigger is inset from the window edge');
  const navBefore=await main.getByTestId('main-nav').boundingBox();await main.getByTestId('work-mode-open').click();await main.getByText('지금은 쉬는 중',{exact:true}).waitFor();
  assert.deepEqual(await main.getByTestId('main-nav').boundingBox(),navBefore,'main settings do not displace navigation');
  const mainPanel=await main.getByRole('region',{name:'근무 모드 설정'}).boundingBox();assert.ok(mainPanel.x>=0&&mainPanel.x+mainPanel.width<=264,'main settings stay inside the sidebar');
  assert.equal(await main.getByRole('region',{name:'근무 모드 설정'}).evaluate(n=>n.scrollWidth>n.clientWidth),false,'main copy wraps within the sidebar');
  await main.screenshot({path:`.agentstoz/maintainer/work-mode/${name}-main.png`});
  // A first read failure keeps status null: explain the hidden action without inventing an installed app.
  await main.goto(server.url+'?workmode-main=1&helper-status-fail=1');await main.getByTestId('work-mode-open').click();
  await main.getByText(copy.screenInstanceUnknown,{exact:true}).waitFor();await main.getByText(copy.viewerInstanceUnknown,{exact:true}).waitFor();
  assert.equal(await main.getByTestId('work-mode-screen-open').count(),0);
  assert.equal(await main.getByTestId('work-mode-viewer-open').count(),0);
  await main.evaluate(()=>{window.failScreenStatus=false;window.failViewerStatus=false;});
  await main.getByText(copy.screenStopped,{exact:true}).waitFor();await main.getByText(copy.viewerStopped,{exact:true}).waitFor();
  assert.equal(await main.getByTestId('work-mode-screen-open').isEnabled(),true);
  assert.equal(await main.getByTestId('work-mode-viewer-open').isEnabled(),true);
  // The QR remote-control dialog is where people look for AgentsToZ Screen (2026-10-25): the same status and 「열기」.
  const qr=await browser.newPage({viewport:{width:960,height:720}}),qrErrors=[];qr.on('pageerror',e=>qrErrors.push(e.message));
  await qr.goto(server.url+'?qr-remote=1');await qr.getByTestId('qr-remote-control-lan-folded').waitFor();
  // 꺼진 같은 Wi‑Fi 웹 원격은 접혀 있고(2026-11-01), 펼치면 예전 켜기 화면이 그대로 나온다.
  assert.equal(await qr.getByTestId('qr-remote-control-enable').count(),0,'folded: no LAN enable button');
  await qr.getByTestId('qr-remote-control-lan-expand').click();await qr.getByText('현재 꺼져 있습니다',{exact:true}).waitFor();await qr.getByTestId('qr-remote-control-enable').waitFor();
  await qr.getByTestId('qr-remote-screen-status').waitFor();
  assert.match(await qr.getByTestId('qr-remote-screen-status').innerText(),/AgentsToZ Screen이 꺼져 있어요/);
  await qr.getByTestId('qr-remote-screen-open').click();
  await qr.getByText('AgentsToZ Screen 실행 중 · 화면 제어 꺼짐',{exact:true}).waitFor();
  assert.deepEqual(await qr.evaluate(()=>window.nativeCalls.filter(c=>c.command==='open_screen_helper').map(c=>c.args)),[{}],'the dialog opens it the same way');
  await qr.screenshot({path:`.agentstoz/maintainer/work-mode/${name}-qr-remote-screen.png`});
  // Both entry surfaces consume the same pending note; a verified open cannot erase the old-copy warning.
  await qr.evaluate(()=>window.setScreenHelper({updatePending:true}));
  await qr.getByText(copy.screenUpdatePending,{exact:true}).waitFor();
  await qr.getByTestId('qr-remote-screen-open').click();await qr.getByText(copy.screenUpdatePending,{exact:true}).waitFor();
  await qr.screenshot({path:`.agentstoz/maintainer/work-mode/${name}-qr-screen-update-pending.png`});
  await qr.evaluate(()=>window.setScreenHelper({otherInstanceRunning:true,running:false,state:null}));
  await qr.getByText(copy.screenOtherInstance,{exact:true}).waitFor();
  assert.equal(await qr.getByTestId('qr-remote-screen-open').count(),0,'the QR entry also blocks a conflicting QA instance');
  await qr.evaluate(()=>window.setScreenHelper({otherInstanceRunning:false,instanceStatusUnknown:false,updatePending:false,running:true,state:{power:'off',viewing:false,devices:0,capture:true,control:false,loginItem:'off'}}));
  await qr.getByText(copy.screenOff,{exact:true}).waitFor();
  assert.equal(await qr.getByTestId('qr-remote-screen-open').isEnabled(),true,'the QR entry recovers when the blocker clears');
  await qr.goto(server.url+'?qr-remote=1&helper-status-fail=1');
  await qr.getByText(copy.screenInstanceUnknown,{exact:true}).waitFor();
  assert.equal(await qr.getByTestId('qr-remote-screen-open').count(),0,'initial QR status failure explains the unavailable action');
  await qr.evaluate(()=>window.failScreenStatus=false);await qr.getByText(copy.screenStopped,{exact:true}).waitFor();
  assert.equal(await qr.getByTestId('qr-remote-screen-open').isEnabled(),true,'normal QR status recovers through the existing poll');
  await qr.goto(server.url+'?qr-remote=1&browser=1');await qr.getByTestId('qr-remote-control-lan-folded').waitFor();
  assert.equal(await qr.getByTestId('qr-remote-screen').count(),0,'no Screen entry in a browser');
  assert.equal(await qr.evaluate(()=>window.nativeCalls.filter(c=>c.command==='get_screen_helper').length),0,'a browser never asks for the helper');
  assert.deepEqual(qrErrors,[]);
  console.log(`${name}: presets, always-on, custom bounds, screen option, closed-lid grant, AgentsToZ Screen status and open (panel and QR remote dialog), AgentsToZ Viewer status and open, failure, stop, native events, Escape, narrow dock and main sidebar passed`);
 }finally{await browser.close();}
}}finally{server.stop(true);}

// The same normal check covers the sidebar's direct Screen/Viewer entries and purpose groups.
await import('./workspace-tools-ui.mjs');
