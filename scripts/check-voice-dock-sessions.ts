/**
 * 「아젠투지 호출」 dock extras (VOC 2026-10-24) in real Chromium and WebKit:
 *  - confirmed automatic saves stack above the dock (newest nearest it), expand, dismiss, stay dismissed, clear all;
 *  - 「열린 AI 세션」 lists open project + agent sessions with context %, saves one and syncs another,
 *    and polls every 5s only while expanded;
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
    const rows=page.getByTestId('voice-dock-session');
    await until(async()=>await rows.count()===3,'three open sessions (stale hidden)');
    assert.match(await rows.first().innerText(),/AgentsToZ_byCS[\s\S]*Claude Code[\s\S]*72%/);
    assert.equal(await rows.first().getByTestId('voice-dock-session-percent').getAttribute('data-level'),'warn');
    assert.match(await page.getByTestId('voice-dock-sessions-auto').innerText(),/자동 저장 켜짐 · 컨텍스트 50·70·75·90%/);
    ok('rows: registered project name, agent, context % (highest first, 70%+ amber), stale rows hidden');
    const opsRow=rows.nth(1),strayRow=rows.nth(2);
    await until(async()=>(await rows.first().getAttribute('data-action'))==='remember'&&(await opsRow.getAttribute('data-action'))==='push'&&(await strayRow.getAttribute('data-action'))==='start','memory states');
    assert.equal(await rows.first().getByTestId('voice-dock-session-save').isEnabled(),true);
    assert.equal(await opsRow.getByTestId('voice-dock-session-save').isEnabled(),false,'nothing new to save on the OPS row');
    assert.match(await opsRow.innerText(),/Supabase 백업이 필요합니다/);
    assert.equal(await strayRow.getByTestId('voice-dock-session-save').isEnabled(),false,'no new memory in an unregistered folder');
    assert.match(await strayRow.innerText(),/등록되지 않은 폴더 · 장기기억 없음/);
    assert.match(await rows.first().innerText(),/로컬 \d+월 \d+일 \d\d:\d\d · 백업 \d+월 \d+일 \d\d:\d\d/);ok('each row shows local save and backup times and which button applies; a stray folder gets no new memory');
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
    await until(async()=>(await opsRow.getAttribute('data-action'))==='saved','synced row is current');ok('「동기화」 backs up the OPS row');

    await page.keyboard.press('Escape');await until(async()=>await panel.count()===0,'Escape folds the list');
    // Folding hands the job back to the background check, which reads once right away and then waits a minute.
    await new Promise(r=>setTimeout(r,1000));
    const polled=(await calls(page,'/api/context-usage')).length;
    await new Promise(r=>setTimeout(r,6000));
    assert.equal((await calls(page,'/api/context-usage')).length,polled,'folded again: no more 5s polling');ok('Escape folds it, and the 5s polling stops with it');

    // ── 「모두 저장」 from the dock card: one project at a time ──
    const preset=async()=>{await page.evaluate(([a,b])=>{localStorage.setItem('fixture-memory',JSON.stringify({[a]:{needs:true,inSync:true},[b]:{needs:true,inSync:true}}));localStorage.setItem('fixture-save-delay','400');},['/fixture/AgentsToZ_byCS','/fixture/AgentsToZ-OPS']);await page.reload();};
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
    await runCard.getByText('기억 저장 끝').waitFor({timeout:8000});
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
    await runCard.getByText('기억 저장 끝').waitFor({timeout:8000});
    assert.equal((await calls(page,'/api/project-memory/session-end')).length,2,'the second save still ran after the list folded');
    ok('the list’s 「모두 저장」 keeps going after the list is folded, and reports in the dock');
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
    assert.ok(overflow<=1,`no horizontal scroll (${overflow}px)`);
    assert.deepEqual(errors,[]);ok('no page errors, no horizontal scroll');
    await context.close();
  }}finally{await browser.close();}
}
console.log(`\n${checks} checks passed`);}finally{server.stop(true);}
