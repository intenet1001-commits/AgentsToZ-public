/**
 * 「아젠투지 호출」 dock extras (VOC 2026-10-24) in real Chromium and WebKit:
 *  - confirmed automatic saves stack above the dock (newest nearest it), expand, dismiss, stay dismissed, clear all;
 *  - 「열린 AI 세션」 lists open project + agent sessions with context %, saves one and syncs another,
 *    and polls every 5s only while expanded;
 *  - a sent /compact·/clear shows its outcome on the row (compaction record, the same terminal's new conversation);
 *  - unsaved work: a dock card and a count on the session button from one background check, 「모두 저장」 from the
 *    card and from the list saves one project at a time, and folding the list mid-run does not stop it.
 * Synthetic local API (tests/fixtures/voice/dock-sessions.tsx); no network, no app, no 3001.
 *   bun scripts/check-voice-dock-sessions.ts [screenshot-dir]
 */
import {chromium,webkit,type Page} from 'playwright';
import assert from 'node:assert/strict';
const shots=process.argv[2];
const built=await Bun.build({entrypoints:['tests/fixtures/voice/dock-sessions.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
if(!built.success)throw Error('UI fixture build failed: '+built.logs.map(String).join('\n'));
const js=built.outputs.find(o=>o.path.endsWith('.js')),css=built.outputs.filter(o=>o.path.endsWith('.css'));
const cssText=(await Promise.all(css.map(o=>o.text()))).join('\n');
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>{const path=new URL(r.url).pathname;return path==='/fixture.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):path==='/fixture.css'?new Response(cssText,{headers:{'Content-Type':'text/css'}}):new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',{headers:{'Content-Type':'text/html'}});}});
const calls=(page:Page,path:string)=>page.evaluate(p=>(window as any).calls.filter((c:any)=>c.path===p),path);
const until=async(check:()=>Promise<boolean>,what:string,ms=6000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw new Error('timed out: '+what);};
async function box(page:Page,selector:string){const b=await page.locator(selector).first().boundingBox();assert.ok(b,selector+' is on screen');return b!;}
let checks=0;const ok=(name:string)=>{checks++;console.log('  ✓ '+name);};
try{for(const [name,engine] of Object.entries({chromium,webkit})){
  console.log(name);
  const browser=await engine.launch();
  try{for(const viewport of [{width:1280,height:800},{width:420,height:760}]){
    console.log(`  ${viewport.width}×${viewport.height}`);
    const context=await browser.newContext({viewport});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(server.url.toString());

    // ── Notification stack ──
    const cards=page.getByTestId('dock-notice');
    await cards.first().waitFor();
    const unsavedCard=page.getByTestId('dock-unsaved-notice'),badge=page.getByTestId('voice-dock-sessions-unsaved');
    await unsavedCard.waitFor();
    assert.match(await unsavedCard.innerText(),/저장 안 된 작업 · 프로젝트 1개[\s\S]*AgentsToZ_byCS[\s\S]*지금 저장/);
    assert.equal(await badge.innerText(),'1');
    assert.equal((await calls(page,'/api/context-usage')).length,1,'one background check at load');
    assert.equal((await calls(page,'/api/project-memory/session-end')).length,0,'looking saves nothing');
    ok('unsaved work: a card above the dock and a count on 「열린 AI 세션」, from one background check');
    assert.equal(await cards.count(),3);assert.equal(await page.getByTestId('dock-notices-more').innerText(),'알림 1개 더 보기');
    assert.equal(await page.getByTestId('voice-dock').locator('[data-testid="dock-notices"]').count(),1,'the stack lives inside the dock');
    const last=await cards.last().innerText();
    assert.match(last,/AgentsToZ_byCS · Claude/);assert.match(last,/컨텍스트 70% · 자동 세션 기억 저장/);
    ok('three newest saves shown, newest nearest the dock, the rest behind 「더 보기」');
    const stack=await box(page,'[data-testid="dock-notices"]'),main=await box(page,'.az-voice-dock__main');
    assert.ok(stack.y+stack.height<=main.y+1,`the stack sits above the call row (${stack.y+stack.height} <= ${main.y})`);
    assert.ok(stack.x+stack.width<=viewport.width+1&&stack.x>=0,'the stack stays inside the window');ok('the stack floats right above 「아젠투지 호출」');
    if(shots)await page.screenshot({path:`${shots}/dock-notices-${name}-${viewport.width}.png`});
    await cards.last().locator('.az-notice__body').click();
    await cards.last().getByText('로컬 장기기억에 저장했습니다.',{exact:false}).waitFor();
    assert.equal(await cards.last().locator('.az-notice__body').getAttribute('aria-expanded'),'true');ok('a tap expands the full explanation');
    await page.getByTestId('dock-notices-more').click();await until(async()=>await cards.count()===4,'all four shown');ok('「더 보기」 shows the older one');
    await cards.last().getByRole('button',{name:/AgentsToZ_byCS Claude 저장 안내 닫기/}).click();
    await until(async()=>await cards.count()===3,'one dismissed');
    await page.reload();await cards.first().waitFor();
    assert.equal(await cards.count(),3,'a dismissed notice stays dismissed after reload');
    assert.doesNotMatch(await page.getByTestId('dock-notices').innerText(),/AgentsToZ_byCS · Claude/);ok('dismissing one removes it, and it stays gone (shared localStorage)');
    await page.getByTestId('dock-notices-clear').click();
    await until(async()=>await page.getByTestId('dock-notices').count()===0,'all cleared');
    assert.equal(await badge.innerText(),'1','putting the reminder away keeps the count on the session button');ok('「알림 모두 지우기」 clears the stack (the unsaved count stays on the button)');

    // ── 「열린 AI 세션」 ──
    await new Promise(r=>setTimeout(r,5600));
    assert.equal((await calls(page,'/api/context-usage')).length,1,'folded: no 5s polling, only the minute-long background check');
    await page.getByTestId('voice-dock-sessions').click();
    const panel=page.getByTestId('voice-dock-sessions-panel');await panel.waitFor();
    const weekly=page.getByTestId('dock-weekly-usage');await weekly.getByText('72%',{exact:true}).waitFor();
    assert.match(await weekly.innerText(),/Claude[\s\S]*72%[\s\S]*Codex[\s\S]*39%[\s\S]*Antigravity[\s\S]*확인 안 됨/);
    await weekly.locator('[data-provider="agy"]').getByRole('button',{name:'사용량 연결'}).click();
    await weekly.locator('[data-provider="agy"]').getByRole('button',{name:'연결 해제'}).waitFor();
    assert.match(await weekly.locator('[data-provider="agy"]').innerText(),/활동 대기/);
    assert.equal((await calls(page,'/api/agent-runtime/weekly-usage')).filter((c:any)=>c.body.operation==='connect').length,1);
    ok('weekly allowance: provider % is separate from session context; unknown is not zero, native statusline connection is explicit');
    const push=weekly.getByTestId('dock-weekly-push');await push.waitFor();
    assert.equal(await push.getAttribute('data-enabled'),'false','phone alerts start OFF');
    assert.match(await push.innerText(),/휴대폰 알림[\s\S]*Mac 한 대에서만 켜세요/,'the shared-account warning is visible, not only in a tooltip');
    await push.getByTestId('dock-weekly-push-toggle').click(); // controlled: it turns only when the host answers
    await until(async()=>await push.getAttribute('data-enabled')==='true','phone alerts on');
    assert.match(await push.getByTestId('dock-weekly-push-note').innerText(),/AgentsToZ Screen으로 보냅니다 · 등록 기기 2대/);
    assert.deepEqual((await calls(page,'/api/agent-runtime/weekly-usage')).filter((c:any)=>c.body.operation==='alerts'&&'enabled' in c.body).map((c:any)=>c.body),[{operation:'alerts',enabled:true}]);
    await push.getByTestId('dock-weekly-push-toggle').click();
    await until(async()=>await push.getAttribute('data-enabled')==='false','phone alerts off again');
    ok('weekly allowance: 「휴대폰 알림」 is OFF by default, says one Mac per shared account, and switches through the host');
    const rows=page.getByTestId('voice-dock-session');
    await until(async()=>await rows.count()===3,'three open sessions (stale hidden)');
    assert.doesNotMatch(await panel.innerText(),/Guardian review/,'internal reviews do not compete with user conversations');
    assert.match(await rows.first().innerText(),/AgentsToZ_byCS[\s\S]*Claude Code[\s\S]*72%/);
    assert.equal(await rows.first().getByTestId('voice-dock-session-percent').getAttribute('data-level'),'warn');
    // What a screen reader gets is the element's own text (a generic <span> cannot carry an accessible name).
    const percent=rows.first().getByTestId('voice-dock-session-percent');
    assert.equal(await percent.getAttribute('aria-label'),null);
    assert.equal(await percent.ariaSnapshot(),'- text: 컨텍스트 72%');
    // The coordinator checkpoints Claude and Codex sessions alike; the top row here is a Claude Code session.
    assert.equal(await page.getByTestId('voice-dock-sessions-auto').innerText(),'Claude·Codex 자동 체크포인트 켜짐 · 컨텍스트 50·70·75·90%');
    ok('rows: registered project name, agent, context % (highest first, 70%+ amber), stale rows hidden');
    await page.evaluate(()=>{(window as any).sessions.find((s:any)=>s.sessionId==='s-tmp').usedPercent=null;});
    await page.getByRole('button',{name:'세션 목록 새로고침'}).click();
    const unknown=rows.filter({hasText:'임시 실험'}).getByTestId('voice-dock-session-percent');
    await until(async()=>(await unknown.getAttribute('data-level'))==='none','unknown context reading');
    assert.equal(await unknown.ariaSnapshot(),'- text: 컨텍스트 확인 안 됨');
    assert.equal(await unknown.locator('[aria-hidden="true"]').innerText(),'—');
    await page.evaluate(()=>{(window as any).sessions.find((s:any)=>s.sessionId==='s-tmp').usedPercent=20;});
    await page.getByRole('button',{name:'세션 목록 새로고침'}).click();
    await until(async()=>(await unknown.getAttribute('data-level'))==='ok','reading restored');
    // No Claude context capture on this Mac yet: say how to get Claude rows instead of an unexplained Codex-only list.
    const capture=page.getByTestId('voice-dock-sessions-capture');
    assert.equal(await capture.count(),0,'capture connected: no notice');
    await page.evaluate(()=>{(window as any).captureInstalled=false;});
    await page.getByRole('button',{name:'세션 목록 새로고침'}).click();
    await until(async()=>await capture.count()===1,'capture notice');
    assert.equal(await capture.innerText(),'Claude 세션은 위의 Claude 「사용량 연결」을 켠 뒤 다음 Claude 활동부터 이 목록에 보입니다.');
    await page.evaluate(()=>{(window as any).captureInstalled=true;});
    await page.getByRole('button',{name:'세션 목록 새로고침'}).click();
    await until(async()=>await capture.count()===0,'capture notice gone');
    ok('no Claude context capture: the list says to connect Claude usage, and the notice leaves once capture exists');
    await page.evaluate(()=>{localStorage.setItem('portmanager-lang','en');window.dispatchEvent(new CustomEvent('agentstoz:language',{detail:'en'}));});
    await until(async()=>(await page.getByTestId('voice-dock-sessions-auto').innerText())==='Claude·Codex auto checkpoints on · context 50·70·75·90%','English checkpoint line');
    assert.equal(await percent.ariaSnapshot(),'- text: Context 72%');
    await page.evaluate(()=>{localStorage.removeItem('portmanager-lang');window.dispatchEvent(new CustomEvent('agentstoz:language',{detail:'ko'}));});
    await until(async()=>(await page.getByTestId('voice-dock-sessions-auto').innerText()).startsWith('Claude·Codex 자동 체크포인트'),'Korean again');
    ok('context readings are announced from their text (「확인 안 됨」 behind the dash); the checkpoint line names Claude and Codex in both languages');
    const opsRow=rows.nth(1),strayRow=rows.nth(2);
    await until(async()=>(await rows.first().getAttribute('data-action'))==='remember'&&(await opsRow.getAttribute('data-action'))==='push'&&(await strayRow.getAttribute('data-action'))==='start','memory states');
    assert.equal(await rows.first().getByTestId('voice-dock-session-save').isEnabled(),true);
    assert.equal(await opsRow.getByTestId('voice-dock-session-save').isEnabled(),false,'nothing new to save on the OPS row');
    assert.match(await opsRow.innerText(),/Supabase 백업이 필요합니다/);
    assert.equal(await strayRow.getByTestId('voice-dock-session-save').isEnabled(),false,'no new memory in an unregistered folder');
    assert.match(await strayRow.innerText(),/등록되지 않은 폴더 · 장기기억 없음/);
    const times=rows.first().getByTestId('voice-dock-session-times');
    assert.equal(await times.evaluate((el:HTMLDetailsElement)=>el.open),false,'timestamps do not compete with the current state');
    await times.locator('summary').click();
    assert.match(await times.innerText(),/로컬 \d+월 \d+일 \d\d:\d\d · 백업 \d+월 \d+일 \d\d:\d\d/);
    await times.locator('summary').click();
    await page.evaluate(()=>{(window as any).memory['/fixture/AgentsToZ-OPS'].conflict=true;});
    await page.getByRole('button',{name:'세션 목록 새로고침'}).click();
    await until(async()=>(await opsRow.getAttribute('data-action'))==='conflict','conflict is visible without expanding details');
    assert.match(await opsRow.innerText(),/로컬·Supabase가 모두 바뀌었습니다 · 「비교·해결」에서 고르세요/);
    assert.equal(await opsRow.getByTestId('voice-dock-session-sync').isEnabled(),false);
    ok('timestamps are available on demand; conflicts remain visible and cannot be synchronized');
    // 「비교·해결」: comparing writes nothing; the confirmed merge goes once, with the hashes that were compared.
    const resolveCalls=(await calls(page,'/api/project-memory/resolve-conflict')).length;
    await opsRow.getByTestId('voice-dock-session-conflict-review').click();
    const review=opsRow.getByTestId('voice-dock-conflict-review');
    await review.getByTestId('voice-dock-conflict-summary').waitFor();
    assert.equal(await review.getByTestId('voice-dock-conflict-summary').innerText(),'같은 항목 1개 · 다른 항목 2개');
    assert.match(await review.getByTestId('voice-dock-conflict-differences').innerText(),/로컬에서 추가 1개[\s\S]*Local decision[\s\S]*Supabase에서 추가 1개[\s\S]*Remote decision/);
    assert.equal(await review.getByTestId('voice-dock-conflict-merge').isEnabled(),true,'additions only: the merge is offered');
    await review.getByTestId('voice-dock-conflict-merge').click();
    assert.match(await review.getByTestId('voice-dock-conflict-confirm-step').innerText(),/Supabase에서 추가된 항목 1개/);
    await review.getByTestId('voice-dock-conflict-cancel').click();
    assert.equal(await review.getByTestId('voice-dock-conflict-confirm-step').count(),0,'cancel goes back to the choices');
    assert.equal((await calls(page,'/api/project-memory/resolve-conflict')).length,resolveCalls,'comparing and a cancelled choice send nothing');
    await review.getByTestId('voice-dock-conflict-merge').click();
    await review.getByTestId('voice-dock-conflict-confirm').click();
    await opsRow.getByText(/두 기억의 항목을 합쳐 로컬에 저장하고 Supabase에 올렸습니다/).waitFor();
    const sent=(await calls(page,'/api/project-memory/resolve-conflict')).slice(resolveCalls);
    assert.equal(sent.length,1,'one choice, one request');
    assert.deepEqual({strategy:sent[0].body.strategy,local:sent[0].body.expectedLocalHash,revision:sent[0].body.expectedRemoteRevisionId,remote:sent[0].body.expectedRemoteContentHash},
      {strategy:'merged',local:'local-/fixture/AgentsToZ-OPS',revision:'rev-remote',remote:'remote-changed'});
    for(const c of ['a','c','d'])assert.equal(sent[0].body.mergedContent.split('memory-entry-id:'+c.repeat(24)).length-1,1,'each entry once in the merge');
    assert.equal(await opsRow.getByTestId('voice-dock-conflict-review').count(),0,'the review closes once resolved');
    await until(async()=>(await opsRow.getAttribute('data-action'))==='saved','resolved row is current');
    ok('「비교·해결」 compares read-only, names each side\'s additions, and sends the confirmed merge once with the compared hashes');
    // Back to the original scenario (local ahead, nothing new) for the sync checks below.
    await page.evaluate(()=>{(window as any).memory['/fixture/AgentsToZ-OPS'].inSync=false;});
    await page.getByRole('button',{name:'세션 목록 새로고침'}).click();
    await until(async()=>(await opsRow.getAttribute('data-action'))==='push','fixture back to local-ahead');
    const sessionPanel=await box(page,'[data-testid="voice-dock-sessions-panel"]'),mainNow=await box(page,'.az-voice-dock__main');
    assert.ok(sessionPanel.y+sessionPanel.height<=mainNow.y+1,'the list opens above the call row');
    assert.ok(sessionPanel.y>=0,'the list fits the window');
    if(shots)await page.screenshot({path:`${shots}/dock-sessions-${name}-${viewport.width}.png`});

    await rows.first().getByTestId('voice-dock-session-save').click();
    await rows.first().getByText('저장 완료 · 로컬 기억과 Supabase 백업을 갱신했습니다.').waitFor();
    const saved=await calls(page,'/api/project-memory/session-end');
    assert.equal(saved.length,1);assert.deepEqual({folderPath:saved[0].body.folderPath,agent:saved[0].body.agent,keep:saved[0].body.preservePreferredAgent},{folderPath:'/fixture/AgentsToZ_byCS',agent:'claude',keep:true});
    await until(async()=>!(await rows.first().getByTestId('voice-dock-session-save').isEnabled()),'save turns off once saved');
    await until(async()=>await badge.count()===0,'the count clears once nothing is unsaved');
    ok('「지금 저장」 saves that session once with its own agent, then has nothing left to save (the count clears)');
    await opsRow.getByTestId('voice-dock-session-sync').click();
    await opsRow.getByText('Supabase에 백업했습니다.').waitFor();
    assert.equal((await calls(page,'/api/project-memory/sync')).length,1);
    await until(async()=>(await opsRow.getAttribute('data-action'))==='saved','synced row is current');
    await until(async()=>!(await opsRow.getByTestId('voice-dock-session-sync').isEnabled()),'a synced row has nothing left to sync');
    assert.match(await opsRow.getByTestId('voice-dock-session-sync').innerText(),/동기화됨/);
    ok('「동기화」 backs up the OPS row, then reads 「동기화됨」 and stays off');

    // Cleanup is only a display operation. Active readings survive the bulk action and undo restores the idle row.
    await page.getByTestId('voice-dock-sessions-clear').click();await until(async()=>await rows.count()===2,'idle row cleared');
    assert.match(await rows.first().innerText(),/도크 알림 작업/);
    await page.getByTestId('voice-dock-sessions-undo').click();await until(async()=>await rows.count()===3,'cleanup undone');
    const stray=rows.filter({hasText:'임시 실험'});
    await stray.getByRole('button',{name:/목록에서 숨기기/}).click();await until(async()=>await rows.count()===2,'stray hidden');
    await page.reload();await page.getByTestId('voice-dock-sessions').click();await panel.waitFor();
    await until(async()=>await rows.count()===2,'dismissal survives reload');
    await page.evaluate(()=>{(window as any).sessions.find((s:any)=>s.sessionId==='s-tmp').capturedAt=new Date().toISOString();});
    await page.getByRole('button',{name:'세션 목록 새로고침'}).click();await until(async()=>await rows.count()===3,'new activity reappears');
    ok('bulk cleanup protects active readings, undo restores, hidden rows survive reload and reappear on fresh activity');

    const codexRow=rows.filter({hasText:'운영 점검'});
    assert.equal(await codexRow.getByTestId('voice-dock-session-compact').isVisible(),true);
    assert.equal(await codexRow.getByTestId('voice-dock-session-clear').isVisible(),true);
    assert.equal(await codexRow.getByTestId('voice-dock-session-compact').isEnabled(),false);
    assert.equal(await codexRow.getByTestId('voice-dock-session-clear').isEnabled(),false);
    assert.match(await codexRow.getByTestId('voice-dock-session-command-support').innerText(),/Codex 앱에서 직접 실행/);
    await codexRow.getByTestId('voice-dock-session-open').click();
    await codexRow.getByText('원본 Codex 대화로 이동했습니다.',{exact:false}).waitFor();
    const navigations=await calls(page,'/api/context-sessions/navigate');
    assert.deepEqual(navigations.at(-1).body,{sessionId:'s-ops',sourceAgent:'codex'});
    assert.deepEqual(await page.evaluate(()=>(window as any).commandCalls),[],'navigation does not submit a compact or clear command');
    await page.evaluate(()=>{(window as any).navigationFailure=true;});
    await codexRow.getByTestId('voice-dock-session-open').click();
    await codexRow.getByText('대상 대화를 찾지 못했습니다.').waitFor();
    await page.evaluate(()=>{(window as any).navigationFailure=false;});
    ok('Codex cards expose both command states and exact-session navigation without claiming native command execution');

    // These are native context commands, independent of the display cleanup.
    const appRow=rows.filter({hasText:'도크 알림 작업'});
    await until(async()=>await appRow.getByTestId('voice-dock-session-compact').isEnabled(),'managed Claude command ready');
    const commands=appRow.getByTestId('voice-dock-session-commands');
    assert.equal(await commands.getByTestId('voice-dock-session-compact').isVisible(),true,'native commands are visible without expanding a disclosure');
    await page.evaluate(()=>{(window as any).contextFailure='sync';});
    await appRow.getByTestId('voice-dock-session-compact').click();await appRow.locator('.az-session__result--error').waitFor();
    await until(async()=>await appRow.getByTestId('voice-dock-session-compact').isEnabled(),'failed sync finished');
    assert.deepEqual(await page.evaluate(()=>(window as any).commandCalls),[],'failed sync sends no native command');
    await page.evaluate(()=>{(window as any).contextFailure='execute';});
    await appRow.getByTestId('voice-dock-session-compact').click();await appRow.getByText('명령 전송 결과가 미확정입니다. 같은 명령을 다시 보내지 말고 워크룸을 확인하세요.').waitFor();
    assert.equal(await appRow.getByTestId('voice-dock-session-compact').isEnabled(),false,'an unknown attempt fences another command');
    await appRow.getByRole('button',{name:'컨텍스트 명령 전송 확인'}).click();
    await appRow.getByText('명령 결과가 아직 미확정입니다. 자동으로 다시 보내지 않습니다. 워크룸을 확인하세요.').waitFor();
    assert.deepEqual(await page.evaluate(()=>(window as any).commandCalls),['compact'],'receipt checks never replay');
    await page.evaluate(()=>{const f=window as any;Object.keys(f.commandReceipts).forEach(k=>{f.commandReceipts[k]='written';});});
    await appRow.getByRole('button',{name:'컨텍스트 명령 전송 확인'}).click();
    await until(async()=>await appRow.getByTestId('voice-dock-session-compact').isEnabled(),'confirmed receipt releases fence');
    await page.evaluate(()=>{(window as any).contextFailure='';});
    await appRow.getByTestId('voice-dock-session-compact').click();
    await appRow.getByText('기억 저장·동기화 후 /compact 명령을 전송했습니다.',{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>(window as any).commandCalls),['compact','compact']);assert.equal(await rows.count(),3,'compact preserves the conversation row');
    ok('native /compact and /clear follow verified save+sync; a failed sync stops before sending');
    // The outcome is followed on the row from the same reads (src/contextCommandOutcome.ts), never by resending.
    const appOutcome=appRow.getByTestId('voice-dock-session-command-outcome');
    await until(async()=>(await appOutcome.getAttribute('data-outcome'))==='waiting','compact waits for evidence');
    assert.match(await appOutcome.innerText(),/^요약 처리 중 — 컨텍스트 변화를 기다리는 중 · \d+초$/);
    // Claude writes its compaction record into the transcript; the host reports it on the row.
    await page.evaluate(()=>{(window as any).sessions.find((s:any)=>s.sessionId==='session-app-001').lastCompaction={at:new Date().toISOString(),trigger:'manual',preTokens:144000,postTokens:36000};});
    await page.getByRole('button',{name:'세션 목록 새로고침'}).click();
    await until(async()=>(await appOutcome.getAttribute('data-outcome'))==='done','compaction record read');
    assert.equal(await appOutcome.innerText(),'요약 완료 · 컨텍스트 72% → 18% (144K → 36K 토큰)');
    if(shots)await page.screenshot({path:`${shots}/dock-compact-result-${name}-${viewport.width}.png`});
    ok('/compact: 「요약 처리 중」 until the transcript’s compaction record, then 「요약 완료 · 72% → 18%」 on the same row');
    await appRow.getByTestId('voice-dock-session-clear').click();
    await until(async()=>/^새 대화로 비우는 중 — 같은 창의 새 대화를 기다리는 중/.test(await appOutcome.innerText()),'clear waits for the new conversation');
    assert.equal(await appOutcome.count(),1,'the clear replaces the compact result: one line per row');
    assert.equal(await rows.count(),3,'the old conversation stays until a new one is seen');
    assert.deepEqual(await page.evaluate(()=>(window as any).commandCalls),['compact','compact','clear']);
    // Claude starts a new conversation in the same Workroom (an older host: no `nextConversation`, only the Workroom id).
    await page.evaluate(()=>{const f=window as any,old=f.sessions.find((s:any)=>s.sessionId==='session-app-001');
      f.sessions.push({...old,sessionId:'session-app-002',threadTitle:'비운 뒤 새 대화',usedPercent:4,remainingPercent:96,usedTokens:8000,capturedAt:new Date().toISOString(),workroomSessionId:'workroom-app-001',lastCompaction:undefined});});
    await page.getByRole('button',{name:'세션 목록 새로고침'}).click();
    const nextAppRow=rows.filter({hasText:'비운 뒤 새 대화'});
    await until(async()=>await appRow.count()===0,'a confirmed clear retires the old conversation row');
    assert.equal(await nextAppRow.getByTestId('voice-dock-session-command-outcome').innerText(),'새 대화로 비움 · 컨텍스트 72% → 4%');
    assert.equal(await rows.count(),3);
    ok('/clear: the old row stays 「비우는 중」 until the same Workroom’s new conversation appears, then the result moves to it');

    // Orca Claude: exactly one live Orca terminal. Its memory must already be saved and synced; an unknown send fences
    // only that request until a person acknowledges it.
    await page.evaluate(()=>{const f=window as any;f.memory['/fixture/AgentsToZ_byCS'].needs=true;f.sessions.push(f.orcaSession);});
    await page.getByRole('button',{name:'세션 목록 새로고침'}).click();
    const orcaRow=rows.filter({hasText:'Orca 터미널 작업'});await orcaRow.waitFor();
    await page.getByRole('button',{name:'세션 목록 새로고침'}).click(); // now the row's folder is listed: read its memory again
    await until(async()=>/저장할 새 활동이 있습니다 · 먼저 「지금 저장」·「동기화」를 마치세요/.test(await orcaRow.getByTestId('voice-dock-session-command-support').innerText()),'an unsaved Orca row names its memory');
    assert.equal(await orcaRow.getByTestId('voice-dock-session-compact').isEnabled(),false);
    await page.getByTestId('voice-dock-sessions-clear').click();
    await until(async()=>await rows.filter({hasText:'운영 점검'}).count()===0,'idle row cleared');
    assert.equal(await orcaRow.count(),1,'bulk cleanup keeps an idle but live Orca terminal');
    await orcaRow.getByTestId('voice-dock-session-save').click();
    await until(async()=>await orcaRow.getByTestId('voice-dock-session-compact').isEnabled(),'saved and synced Orca row ready');
    assert.match(await orcaRow.getByTestId('voice-dock-session-command-support').innerText(),/Orca의 이 Claude 터미널로 보냅니다/);
    await page.evaluate(()=>{(window as any).orcaFailure='unknown';});
    await orcaRow.getByTestId('voice-dock-session-compact').click();
    await orcaRow.getByText('Orca 전송 결과를 확인하지 못했습니다.',{exact:false}).waitFor();
    assert.equal(await orcaRow.getByTestId('voice-dock-session-compact').isEnabled(),false,'an unknown Orca send fences that conversation');
    await orcaRow.getByTestId('voice-dock-session-command-check').click();
    await orcaRow.getByText('명령 결과가 아직 미확정입니다. 자동으로 다시 보내지 않습니다. Orca를 확인하세요.').waitFor();
    assert.equal(await orcaRow.getByTestId('voice-dock-session-compact').isEnabled(),false,'reading the receipt never releases an unknown send');
    // The Orca window closes while the outcome is unknown: the row stays, says so, and still offers the release.
    await page.evaluate(()=>{(window as any).orcaSession.surfacePresence='gone';});
    await orcaRow.getByTestId('voice-dock-session-closed').waitFor();
    assert.match(await orcaRow.getByTestId('voice-dock-session-command-support').innerText(),/세션 창이 닫혀/);
    assert.equal(await orcaRow.getByTestId('voice-dock-session-compact').isEnabled(),false,'nothing is sent to a closed window');
    await orcaRow.getByTestId('voice-dock-session-command-acknowledge').click();
    await until(async()=>await orcaRow.count()===0,'released, a closed window leaves the list');
    await page.evaluate(()=>{(window as any).orcaSession.surfacePresence='live';(window as any).orcaFailure='';});
    await until(async()=>await orcaRow.getByTestId('voice-dock-session-clear').isEnabled(),'reopened, the released conversation is ready again',8000);
    await orcaRow.getByTestId('voice-dock-session-clear').click();
    await orcaRow.getByText('기억 저장·동기화를 확인한 뒤 Orca의 Claude에 /clear를 전송했습니다.',{exact:true}).waitFor();
    const orcaOutcome=orcaRow.getByTestId('voice-dock-session-command-outcome');
    await until(async()=>/^새 대화로 비우는 중/.test(await orcaOutcome.innerText()),'Orca clear waits for the new conversation');
    assert.equal(await orcaRow.count(),1,'the Orca row stays until its new conversation is seen');
    // The host links the next capture in the same Orca pane to the old row; Claude reports zeros before its first reply.
    await page.evaluate(()=>{const f=window as any,old=f.orcaSession,at=new Date().toISOString();
      old.nextConversation={sessionId:'session-orca-002',capturedAt:at,usedPercent:0,usedTokens:0};
      f.sessions.push({...old,sessionId:'session-orca-002',threadTitle:'Orca 새 대화',usedPercent:0,remainingPercent:100,usedTokens:0,capturedAt:at,nextConversation:undefined});});
    await page.getByRole('button',{name:'세션 목록 새로고침'}).click();
    await until(async()=>await orcaRow.count()===0,'a confirmed clear retires the Orca conversation row');
    const orcaNext=rows.filter({hasText:'Orca 새 대화'});
    assert.equal(await orcaNext.getByTestId('voice-dock-session-command-outcome').innerText(),'새 대화로 비움 · 컨텍스트 55% → 첫 응답 뒤 표시');
    assert.equal(await orcaNext.getByTestId('voice-dock-session-percent').ariaSnapshot(),'- text: 컨텍스트 확인 안 됨','Claude’s zero before the first reply is not 「0%」');
    assert.deepEqual(await page.evaluate(()=>({calls:(window as any).orcaCalls,acks:Object.keys((window as any).orcaAcks).length})),{calls:['compact','clear'],acks:1},'one acknowledgement, no replay');
    assert.deepEqual(await page.evaluate(()=>(window as any).commandCalls),['compact','compact','clear'],'Orca rows never use the Workroom path');
    ok('Orca Claude: memory first, bulk cleanup keeps a live terminal, an unknown send stays fenced — listed even after its window closes — until a person acknowledges that one request; a sent /clear is confirmed by the pane’s next conversation');

    await page.keyboard.press('Escape');await until(async()=>await panel.count()===0,'Escape folds the list');
    // Folding hands the job back to the background check, which reads once right away and then waits a minute.
    await new Promise(r=>setTimeout(r,1000));
    const polled=(await calls(page,'/api/context-usage')).length;
    await new Promise(r=>setTimeout(r,6000));
    assert.equal((await calls(page,'/api/context-usage')).length,polled,'folded again: no more 5s polling');ok('Escape folds it, and the 5s polling stops with it');

    // ── 「모두 저장」 from the dock card: one project at a time ──
    const preset=async()=>{await page.evaluate(([a,b])=>{localStorage.removeItem('agentstoz:context-sessions:dismissed:v1');localStorage.removeItem('agentstoz:context-command:outcome:v1');localStorage.setItem('fixture-memory',JSON.stringify({[a]:{needs:true,inSync:true},[b]:{needs:true,inSync:true}}));localStorage.setItem('fixture-save-delay','400');},['/fixture/AgentsToZ_byCS','/fixture/AgentsToZ-OPS']);await page.reload();};
    await preset();
    await unsavedCard.waitFor();
    const twoUnsaved=await unsavedCard.innerText();
    assert.match(twoUnsaved,/저장 안 된 작업 · 프로젝트 2개[\s\S]*모두 저장 \(2\)/);assert.match(twoUnsaved,/AgentsToZ_byCS/);assert.match(twoUnsaved,/AgentsToZ-OPS/);
    assert.equal(await badge.innerText(),'2');ok('a new unsaved set brings the card back even after it was put away');
    if(shots)await page.screenshot({path:`${shots}/dock-unsaved-${name}-${viewport.width}.png`});
    await page.getByTestId('dock-unsaved-save-all').click();
    const runCard=page.getByTestId('dock-save-run');
    await runCard.getByText(/기억 저장 중 · [01]\/2/).waitFor();
    if(shots)await page.screenshot({path:`${shots}/dock-save-run-${name}-${viewport.width}.png`});
    await runCard.getByText('기억 저장 결과',{exact:true}).waitFor({timeout:8000});
    assert.match(await runCard.innerText(),/저장 2/);
    const all=await calls(page,'/api/project-memory/session-end');
    assert.deepEqual(all.map(c=>c.body.folderPath).sort(),['/fixture/AgentsToZ-OPS','/fixture/AgentsToZ_byCS']);
    assert.ok(all.every(c=>c.body.preservePreferredAgent===true),'saving never changes the project’s preferred agent');
    assert.equal(await page.evaluate(()=>(window as any).maxActiveSaves),1,'never two saves at once');
    await until(async()=>await badge.count()===0&&await unsavedCard.count()===0,'nothing left unsaved');
    ok('「모두 저장」 saves both projects one after another, then the card and count clear');
    await runCard.getByRole('button',{name:'기억 저장 결과 닫기'}).click();await until(async()=>await runCard.count()===0,'run card closed');

    // ── 「모두 저장」 from the list, folded mid-run ──
    await preset();
    await page.getByTestId('voice-dock-sessions').click();await panel.waitFor();
    const saveAll=page.getByTestId('voice-dock-sessions-save-all');
    await until(async()=>(await saveAll.innerText()).includes('모두 저장 (2)')&&await saveAll.isEnabled(),'list offers 모두 저장 (2)');
    await saveAll.click();
    await until(async()=>(await calls(page,'/api/project-memory/session-end')).length===1,'first save started');
    await page.keyboard.press('Escape');await until(async()=>await panel.count()===0,'folded mid-run');
    await runCard.getByText('기억 저장 결과',{exact:true}).waitFor({timeout:8000});
    assert.equal((await calls(page,'/api/project-memory/session-end')).length,2,'the second save still ran after the list folded');
    ok('the list’s 「모두 저장」 keeps going after the list is folded, and reports in the dock');
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
    assert.ok(overflow<=1,`no horizontal scroll (${overflow}px)`);
    assert.deepEqual(errors,[]);ok('no page errors, no horizontal scroll');
    await context.close();
  }}finally{await browser.close();}
}
console.log(`\n${checks} checks passed`);}finally{server.stop(true);}
