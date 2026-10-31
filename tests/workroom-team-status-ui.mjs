import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
// 팀 현황 (src/WorkroomTeamStatus.tsx): the leader's and a member's view of a 팀 작전 — states, model and effort, last output,
// reports, commits, 「열기」, polling that brings Git only when something changed, closed teams, and narrow widths —
// in Chromium and WebKit against a synthetic panel route. Nothing here starts, sends or merges anything.
const built=await Bun.build({entrypoints:['tests/fixtures/workroom-team-status.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
if(!built.success)throw Error(built.logs.join('\n'));
const js=built.outputs.find(f=>f.path.endsWith('.js')),css=built.outputs.find(f=>f.path.endsWith('.css'));
const at=iso=>Date.parse(iso);
const brief='Exact member checkout: /tmp/team-member\nShared team rules and the complete task.\n'+'Complete private member task and team rules.\n'.repeat(70);
const member=(id,name,agent,extra)=>({id,name,agent,task:`${name}의 작업`,branch:`team/abc123/${name}`,state:'working',sessionId:`s-${id.slice(1)}`,session:'running',lastOutputAt:Date.now()-120_000,git:null,...extra});
let state,requests;
const reset=()=>{requests=[];state={teams:[
 {id:'team_active',title:'로그인 개선',goal:'로그인 흐름을 고친다',state:'active',leader:{sessionId:'leader-1',agent:'claude'},createdAt:'2026-10-25T01:00:00Z',updatedAt:'2026-10-25T01:00:00Z',
  members:[member('m1','m1-codex','codex',{model:'gpt-6.1-sol',effort:'high'}),member('m2','m2-hermes','hermes',{model:'claude-opus-5-5',provider:'anthropic',role:'reviewer'}),
   member('m3','m3-agy','agy',{state:'failed',sessionId:null,session:null,lastOutputAt:null,error:'Antigravity를 시작하지 못했습니다.'}),
   member('m4','m4-claude','claude',{state:'unknown',session:null,lastOutputAt:null,attached:true})]},
 {id:'team_old',title:'지난 작업',goal:'끝난 일',state:'closed',leader:{sessionId:'leader-1',agent:'claude'},createdAt:'2026-10-24T01:00:00Z',updatedAt:'2026-10-24T02:00:00Z',
  members:[member('m1','m1-claude','claude',{state:'reported',session:'exited',report:{status:'done',summary:'끝냈습니다',at:'2026-10-24T02:00:00Z'}})]},
]};};
const settledOf=team=>team.members.filter(m=>['reported','blocked','failed','exited','unknown','closed'].includes(m.state)).length;
const answer=(sessionId,git)=>({teams:state.teams.filter(t=>t.leader.sessionId===sessionId||t.members.some(m=>m.sessionId===sessionId)).map(t=>{
 const own=t.members.find(m=>m.sessionId===sessionId);
 return {...t,role:own?'member':'leader',memberId:own?.id??null,settled:settledOf(t),members:t.members.map(m=>({...m,git:git?{commits:2,files:3,insertions:10,deletions:1,merged:false}:null}))};})});
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async r=>{
 const p=new URL(r.url).pathname;
 if(p==='/api/agent-runtime/workroom-teams'){const body=await r.json();requests.push(body);
  if(state.rejectAction&&state.rejectAction.operation===body.operation)return Response.json({error:state.rejectAction.error},{status:409});
  if(body.operation==='copy-brief')return Response.json({brief});
  if(body.operation==='confirm-member'){
   const member=state.teams[0].members[0];
   if(['reported','blocked','failed','exited','unknown','closed'].includes(member.state))return Response.json({error:`${member.id} is already ${member.state}`},{status:409});
   member.manual={confirmed:body.confirm,at:new Date().toISOString()};member.state='working';if(body.confirm==='delivered')member.delivery='manual';return Response.json({success:true});}
  if(body.operation==='report-member'){state.teams[0].members[0].report={status:body.status,summary:body.summary,at:new Date().toISOString(),provenance:'manual'};state.teams[0].members[0].state=body.status==='blocked'?'blocked':'reported';return Response.json({success:true});}
  if(state.rejectRead)return Response.json({error:state.rejectRead},{status:503});
  return Response.json(answer(body.sessionId,body.git));}
 return p==='/app.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):p==='/app.css'?new Response(css,{headers:{'Content-Type':'text/css'}}):new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}</style><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>',{headers:{'Content-Type':'text/html'}});
}});
mkdirSync('.agentstoz/maintainer/workroom-team',{recursive:true});
try{for(const [name,engine] of Object.entries({chromium,webkit})){
 const browser=await engine.launch();try{
  reset();
  const page=await browser.newPage({viewport:{width:520,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.url+'?session=leader-1');
  const strip=page.getByTestId('workroom-team-status');await strip.waitFor();
  const teams=strip.locator('section');
  assert.equal(await teams.count(),2,'the active team and the latest closed one');
  const active=teams.nth(0),rows=active.getByTestId('workroom-team-status-member');
  assert.match(await active.locator('header').innerText(),/로그인 개선[\s\S]*내가 리더[\s\S]*2\/4 끝남/);
  assert.equal(await rows.count(),4);
  assert.deepEqual(await rows.evaluateAll(r=>r.map(x=>x.dataset.state)),['working','working','failed','unknown']);
  assert.match(await rows.nth(3).innerText(),/확인 불가 · 앱 재시작 전/,'a member from an earlier run of the app says so');
  const first=await rows.nth(0).innerText();
  for(const part of ['작업 중','m1-codex','Codex · gpt-6.1-sol · 에포트 고정 · 높음','마지막 출력 2분 전','m1-codex의 작업','커밋 2 · 파일 3 · +10 −1 · 병합 전'])assert.ok(first.includes(part),`${name}: row shows ${part}\n${first}`);
  assert.ok(!first.includes('요청됨'),'a Codex Workroom pin is enforced at start (refused when its model cannot be proven), never shown as a request');
  assert.ok((await rows.nth(1).innerText()).includes('Hermes · anthropic/claude-opus-5-5 · 에포트 자동'),'Hermes shows provider/model and 자동');
  assert.deepEqual(await rows.locator('.workroom-team-status__tag:not(.workroom-team-status__tag--attached)').allInnerTexts(),['검토'],'only the reviewer is tagged');
  // A member that joined from an open session says so, and the strip does not guess its model or effort.
  assert.deepEqual(await rows.locator('.workroom-team-status__tag--attached').allInnerTexts(),['열린 세션']);
  assert.ok((await rows.nth(3).innerText()).includes('Claude Code · 세션 설정 그대로'),'an open session keeps its own settings');
  const third=await rows.nth(2).innerText();
  assert.ok(third.includes('시작 실패')&&third.includes('Antigravity를 시작하지 못했습니다.')&&!third.includes('에포트'),'agy: no effort label, the failure reason shown');
  assert.equal(await rows.nth(2).getByTestId('workroom-team-status-open').count(),0,'a member that never started has nothing to open');
  // The first read brings Git; the poll does not, until a member's state changes.
  assert.equal(requests[0].git,true);
  // A closed team starts folded and can be hidden.
  const old=teams.nth(1);
  assert.equal(await old.getByTestId('workroom-team-status-member').count(),0,'closed team folded');
  assert.match(await old.locator('header').innerText(),/정리된 팀/);
  await old.getByRole('button',{name:'이 팀 숨기기'}).click();
  assert.equal(await strip.locator('section').count(),1);
  // 「열기」 goes to the member's session; one not in this Workroom's list is disabled.
  await rows.nth(0).getByTestId('workroom-team-status-open').click();
  assert.deepEqual(await page.evaluate(()=>window.opened),['s-1']);
  // A report lands: the next poll shows it and asks for Git once.
  const before=requests.length;
  state.teams[0].members[0]={...state.teams[0].members[0],state:'reported',report:{status:'done',summary:'API와 테스트를 끝냈습니다. 커밋 2개.',at:'2026-10-25T01:10:00Z'}};
  state.teams[0].members[1]={...state.teams[0].members[1],state:'blocked',report:{status:'blocked',summary:'토큰 만료 정책을 정해 주세요',at:'2026-10-25T01:11:00Z'}};
  await page.waitForFunction(()=>document.querySelector('[data-member-id="m1"]')?.dataset.state==='reported',undefined,{timeout:12_000});
  const polled=requests.slice(before);
  assert.ok(polled.some(r=>r.git===false)&&polled.some(r=>r.git===true),`${name}: a poll without Git, then one with it after the change: ${JSON.stringify(polled)}`);
  assert.match(await active.locator('header').innerText(),/4\/4 끝남/);
  assert.match(await rows.nth(0).innerText(),/보고\s+API와 테스트를 끝냈습니다/);
  assert.match(await rows.nth(1).innerText(),/막힘[\s\S]*막힌 이유\s+토큰 만료 정책을 정해 주세요/);
  const quiet=requests.length;
  await active.getByTestId('workroom-team-status-refresh').click();
  for(let i=0;i<40&&requests.length===quiet;i++)await new Promise(r=>setTimeout(r,50));
  assert.equal(requests.at(-1)?.git,true,'refresh reads Git');
  // Collapse keeps the header.
  await active.getByRole('button',{name:'접기'}).click();
  assert.equal(await rows.count(),0);
  await active.getByRole('button',{name:'펼치기'}).click();
  for(const width of [280,320,420]){
   await page.setViewportSize({width,height:800});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`no horizontal overflow at ${width}px`);
  }
  await page.setViewportSize({width:520,height:800});
  await page.screenshot({path:`.agentstoz/maintainer/workroom-team/${name}-status-leader.png`});
  // The actual default handlers, without injected callbacks: the local leader can copy a complete brief,
  // record what was observed and transcribe a result. Clipboard denial still exposes selectable text.
  state.teams[0].members[0]={...state.teams[0].members[0],state:'awaiting-manual-join',surface:'app',delivery:'not-sent',sessionId:null,session:null,report:null};
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Clipboard denied');}}}));
  await page.goto(server.url+'?session=leader-1');
  const external=page.locator('[data-member-id="m1"]');
  assert.equal(await external.getByTestId('workroom-team-status-brief-fallback').count(),0,'private brief is absent before an explicit copy request');
  state.rejectAction={operation:'copy-brief',error:'fixture brief refused'};
  await external.getByTestId('workroom-team-status-copy-brief').click();
  const actionError=external.getByTestId('workroom-team-status-action-error');
  await actionError.waitFor();assert.match(await actionError.innerText(),/^지시문을 불러오지 못했습니다: fixture brief refused$/);
  assert.equal(await page.getByTestId('workroom-team-status-load-error').count(),0,'brief retrieval errors are not status load errors');
  state.rejectAction=null;
  await external.getByTestId('workroom-team-status-copy-brief').click();
  const fallback=external.getByTestId('workroom-team-status-brief-fallback');await fallback.waitFor();
  assert.match(await fallback.inputValue(),/Exact member checkout: \/tmp\/team-member[\s\S]*complete task/);
  assert.equal(await fallback.getAttribute('readonly'),'');
  assert.equal(await fallback.getAttribute('aria-label'),'팀원 지시문 전문');
  const fullySelected=()=>fallback.evaluate(node=>document.activeElement===node&&node.selectionStart===0&&node.selectionEnd===node.value.length);
  await page.waitForFunction(()=>{const node=document.querySelector('[data-testid="workroom-team-status-brief-fallback"]');return node&&document.activeElement===node&&node.selectionStart===0&&node.selectionEnd===node.value.length;});
  assert.equal(await fullySelected(),true,'clipboard denial focuses and selects the actual complete brief');
  await fallback.click();assert.equal(await fullySelected(),true,'WebKit mouseup does not collapse the selection');
  await external.getByTestId('workroom-team-status-select-brief').click();assert.equal(await fullySelected(),true,'the explicit select-all control selects the real textarea');
  const settleFocus=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const selectedState=()=>fallback.evaluate(node=>({focused:document.activeElement===node,start:node.selectionStart,end:node.selectionEnd,length:node.value.length,selected:String(getSelection()).length}));
  const expectKeyboardSelection=async direction=>{
   await settleFocus();const actual=await selectedState();
   assert.deepEqual(actual,{focused:true,start:0,end:actual.length,length:actual.length,selected:actual.length},`${name}: ${direction} selects the complete actual brief after focus settles`);
  };
  await external.getByTestId('workroom-team-status-select-brief').focus();
  await page.keyboard.press('Shift+Tab');await expectKeyboardSelection('Shift+Tab');
  await active.getByRole('button',{name:'접기',exact:true}).focus();
  await page.keyboard.press('Tab');await expectKeyboardSelection('Tab');
  await fallback.evaluate(node=>{
   const next=node.parentElement.querySelector('[data-testid="workroom-team-status-select-brief"]');
   next.focus();node.focus();next.focus();node.setSelectionRange(0,0);
  });
  await settleFocus();
  assert.equal(await external.getByTestId('workroom-team-status-select-brief').evaluate(node=>document.activeElement===node),true,'a newer focus wins over pending textarea selection');
  const afterBlur=await selectedState();
  assert.deepEqual({focused:afterBlur.focused,start:afterBlur.start,end:afterBlur.end},{focused:false,start:0,end:0},'a cancelled focus frame does not change selection after blur');
  const detached=await fallback.elementHandle();
  await fallback.evaluate(node=>{
   node.focus();node.setSelectionRange(0,0);
   node.closest('section').querySelector('button[aria-expanded]').click();
  });
  await settleFocus();
  assert.deepEqual(await detached.evaluate(node=>({connected:node.isConnected,focused:node.ownerDocument.activeElement===node,start:node.selectionStart,end:node.selectionEnd})),
   {connected:false,focused:false,start:0,end:0},'removing the textarea cancels stale selection without refocusing it');
  await detached.dispose();
  await active.getByRole('button',{name:'펼치기',exact:true}).click();await fallback.waitFor();
  await external.getByTestId('workroom-team-status-select-brief').click();assert.equal(await fullySelected(),true,'explicit selection still works after remount');
  assert.equal(await external.getByTestId('workroom-team-status-copy-brief').innerText(),'복사 실패','the button keeps a short label');
  for(const width of [280,320]){
   await page.setViewportSize({width,height:800});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name}: no horizontal overflow for a denied clipboard at ${width}px`);
  }
  await page.screenshot({path:`.agentstoz/maintainer/workroom-team/${name}-status-clipboard-denied-320.png`,fullPage:true});
  state.rejectAction={operation:'confirm-member',error:'fixture confirmation refused'};
  await external.getByTestId('workroom-team-status-confirm-started').click();
  await actionError.waitFor();assert.match(await actionError.innerText(),/^확인 내용을 저장하지 못했습니다: fixture confirmation refused$/);
  assert.equal(await page.getByTestId('workroom-team-status-load-error').count(),0);
  await active.getByTestId('workroom-team-status-refresh').click();
  assert.equal(await actionError.isVisible(),true,'a successful read does not clear a confirmation failure');
  state.rejectAction=null;
  await external.getByTestId('workroom-team-status-confirm-started').click();
  await page.waitForFunction(()=>document.querySelector('[data-member-id="m1"]')?.textContent?.includes('시작 확인'));
  assert.ok(requests.some(r=>r.operation==='confirm-member'&&r.memberId==='m1'&&r.confirm==='started'&&r.sessionId==='leader-1'));
  await external.getByTestId('workroom-team-status-manual-report').click();
  const reportForm=external.getByTestId('workroom-team-status-report-form');
  await reportForm.locator('textarea').fill('Observed output from the external member.');
  await reportForm.locator('select').selectOption('blocked');
  state.rejectAction={operation:'report-member',error:'fixture report refused'};
  await reportForm.locator('button[type="submit"]').click();
  await actionError.waitFor();assert.match(await actionError.innerText(),/^보고를 저장하지 못했습니다: fixture report refused$/);
  assert.equal(await reportForm.isVisible(),true,'a refused save retains the draft');
  const readsBeforePoll=requests.filter(r=>!r.operation).length;
  state.teams[0].members[1].task='Scheduled poll after failed report';
  for(const deadline=Date.now()+8_000;Date.now()<deadline&&requests.filter(r=>!r.operation).length===readsBeforePoll;)await new Promise(r=>setTimeout(r,50));
  await page.waitForFunction(()=>document.querySelector('[data-member-id="m2"] .workroom-team-status__task')?.textContent==='Scheduled poll after failed report');
  assert.ok(requests.filter(r=>!r.operation).length>readsBeforePoll,'an actual scheduled poll completed after the refused report');
  assert.match(await actionError.innerText(),/fixture report refused/,'polling never hides a failed save');
  state.rejectRead='fixture status unavailable';
  await active.getByTestId('workroom-team-status-refresh').click();
  const loadError=page.getByTestId('workroom-team-status-load-error');await loadError.waitFor();
  assert.match(await loadError.innerText(),/^팀 현황을 불러오지 못했습니다: fixture status unavailable$/);
  assert.equal(await actionError.isVisible(),true,'load and action failures remain distinct');
  state.rejectRead=null;
  await active.getByTestId('workroom-team-status-refresh').click();
  await loadError.waitFor({state:'detached'});assert.equal(await actionError.isVisible(),true,'recovering the status read leaves the failed save visible');
  for(const width of [280,320]){
   await page.setViewportSize({width,height:800});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name}: no horizontal overflow for an external report form at ${width}px`);
  }
  await page.screenshot({path:`.agentstoz/maintainer/workroom-team/${name}-status-report-refused-320.png`,fullPage:true});
  await reportForm.locator('textarea').fill('Observed output from the external member. Revised.');
  assert.equal(await actionError.count(),0,'editing the failed draft dismisses its action error');
  await reportForm.locator('textarea').fill('Observed output from the external member.');
  state.rejectAction=null;
  await reportForm.locator('button[type="submit"]').click();
  await external.getByTestId('workroom-team-status-report-manual').waitFor();
  assert.ok(requests.some(r=>r.operation==='report-member'&&r.summary==='Observed output from the external member.'&&r.memberId==='m1'&&r.status==='blocked'));
  assert.equal(await external.getByTestId('workroom-team-status-report-form').count(),0);
  assert.equal(await external.getByTestId('workroom-team-status-confirm-started').count(),0);
  assert.equal(await external.getByTestId('workroom-team-status-confirm-delivered').count(),0,'a blocked report is settled and cannot be confirmed again');
  await external.getByTestId('workroom-team-status-manual-report').click();
  assert.equal(await reportForm.locator('textarea').inputValue(),'Observed output from the external member.');
  assert.equal(await reportForm.locator('select').inputValue(),'blocked');
  await reportForm.locator('select').selectOption('done');
  await reportForm.locator('textarea').fill('The external blocker was resolved and its result was checked.');
  await reportForm.locator('button[type="submit"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-member-id="m1"] .workroom-team-status__report')?.textContent?.includes('blocker was resolved'));
  assert.ok(requests.some(r=>r.operation==='report-member'&&r.memberId==='m1'&&r.status==='done'));
  for(const stateName of ['reported','blocked','failed','exited','unknown','closed']){
   state.teams[0].members[0].state=stateName;
   await active.getByTestId('workroom-team-status-refresh').click();
   await external.waitFor({state:'visible'});
   await page.waitForFunction(expected=>document.querySelector('[data-member-id="m1"]')?.dataset.state===expected,stateName==='exited'?'ended':stateName);
   assert.equal(await external.getByTestId('workroom-team-status-confirm-started').count(),0,`${stateName}: no start confirmation`);
   assert.equal(await external.getByTestId('workroom-team-status-confirm-delivered').count(),0,`${stateName}: no delivery confirmation`);
  }
  const surfaceCases=[
   ['iterm',{tmuxMode:true,reuse:'reuse-or-new'},'실행 iTerm · tmux · 기존 창 재사용'],
   ['app',{appMode:'reopen'},'실행 Codex 앱 · 최근 대화 다시 열기'],
   ['orca-floating',{reuse:'new'},'실행 Orca · 플로팅 · 새 창'],['orca-worktree',{},'실행 Orca · 사이드바'],
   ['cmux',{bgMode:false,tmuxMode:false,reuse:'new'},'실행 cmux · Claude --bg 끔 · tmux 끔 · 새 창','claude'],['terminal',{},'실행 Terminal'],
   ['powershell',{},'실행 PowerShell'],['wsl',{},'실행 WSL'],['internal',{},'실행 워크룸'],
  ];
  for(const [surface,launchOptions,label,agent='codex']of surfaceCases){
   Object.assign(state.teams[0].members[0],{agent,surface,launchOptions});
   await active.getByTestId('workroom-team-status-refresh').click();
   await page.waitForFunction(expected=>document.querySelector('[data-member-id="m1"] .workroom-team-status__surface .workroom-team-status__tag')?.textContent===expected,label);
   assert.equal(await external.getByTestId('workroom-team-status-surface').locator('.workroom-team-status__tag').innerText(),label);
  }
  // A pinned level reads as the builder writes it (「고정 · xhigh」). A member outside the Workroom shows it as a request, and so
  // does Hermes everywhere: its provider adapter moves or drops --reasoning and the Workroom start cannot refuse that.
  for(const [surface,agent,model,effort,expected,request,provider] of [
   ['orca-worktree','claude','claude-opus-5-5','xhigh','Claude Code · claude-opus-5-5 · 에포트 고정 · xhigh · 요청됨 · 실제 적용 확인 필요',true],
   ['internal','codex','gpt-6.1-sol','max','Codex · gpt-6.1-sol · 에포트 고정 · max',false],
   ['internal','hermes','claude-opus-5-5','max','Hermes · anthropic/claude-opus-5-5 · 에포트 고정 · max · 요청됨 · 실제 적용 확인 필요',true,'anthropic'],
   [undefined,'hermes',undefined,'high','Hermes · 기본 모델 · 에포트 고정 · 높음 · 요청됨 · 실제 적용 확인 필요',true]]){
   Object.assign(state.teams[0].members[0],{agent,surface,model,provider,effort,launchOptions:{}});
   await active.getByTestId('workroom-team-status-refresh').click();
   await page.waitForFunction(text=>document.querySelector('[data-member-id="m1"] .workroom-team-status__model')?.textContent?.startsWith(text),expected);
   assert.equal((await external.locator('.workroom-team-status__model').innerText()).includes('요청됨'),request,`${surface}: ${expected}`);
  }
  assert.equal(await external.getByTestId('workroom-team-status-manual').count(),0,'internal Workroom members have no external manual controls');
  // A member sees the same team, marked as itself, with the leader one tap away and no 「열기」 on its own row.
  reset();
  await page.goto(server.url+'?session=s-2&listed=leader-1');
  await page.getByTestId('workroom-team-status').waitFor();
  const mine=page.locator('section').first();
  assert.match(await mine.locator('header').innerText(),/나는 m2-hermes/);
  await mine.getByTestId('workroom-team-status-open-leader').click();
  assert.deepEqual(await page.evaluate(()=>window.opened),['leader-1']);
  const own=mine.locator('[data-member-id="m2"]');
  assert.match(await own.innerText(),/m2-hermes\s*검토\s*나/);
  assert.equal(await own.getByTestId('workroom-team-status-open').count(),0);
  assert.equal(await mine.locator('[data-member-id="m1"]').getByTestId('workroom-team-status-open').isDisabled(),true,'a session outside this list cannot be opened from here');
  // A session in no team shows nothing at all.
  await page.goto(server.url+'?session=someone-else');
  await page.getByTestId('below').waitFor();await new Promise(r=>setTimeout(r,400));
  assert.equal(await page.getByTestId('workroom-team-status').count(),0);
  assert.deepEqual(errors,[]);
  console.log(`${name}: leader/member views, model/effort/reviewer/attachment, closed fold/hide, open, poll-then-Git, no team, six settled states without confirmations, distinct persistent action/load errors, real clipboard automatic/click/Tab/Shift+Tab selection with focus/unmount cancellation, external 280/320px overflow and nine localized surface labels passed`);
 }finally{await browser.close();}
}}finally{server.stop(true);}
