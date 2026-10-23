/**
 * The 아젠투지 voice dock (VOC 2026-09-29) in real Chromium and WebKit: always on screen, one-tap start
 * after the first consent, who is answering, tap-to-switch, the ⋯ project picker, drafts, two-language
 * subtitles and their modes, the panel above the dock, phone sizes, and an older Mac.
 * Fake microphone and provider (tests/fixtures/voice/panel.tsx); no credentials, no network.
 *   bun scripts/check-voice-dock.ts [screenshot-dir]
 */
import {chromium,webkit,type Page} from 'playwright';
import assert from 'node:assert/strict';
const shots=process.argv[2];
const built=await Bun.build({entrypoints:['tests/fixtures/voice/panel.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
if(!built.success)throw Error('UI fixture build failed');
const js=built.outputs.find(o=>o.path.endsWith('.js')),css=built.outputs.find(o=>o.path.endsWith('.css'));
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>{const path=new URL(r.url).pathname;return path==='/panel.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):path==='/panel.css'?new Response(css,{headers:{'Content-Type':'text/css'}}):new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/panel.css"><div id="root"></div><script type="module" src="/panel.js"></script>',{headers:{'Content-Type':'text/html'}});}});
const requests=(page:Page,action:string)=>page.evaluate(a=>(window as any).requests.filter((r:any)=>r.action===a),action);
const until=async(check:()=>Promise<boolean>,what:string,ms=5000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw new Error('timed out: '+what);};
const emit=(page:Page,e:object)=>page.evaluate(e=>(window as any).emit(e),e);
const status=(page:Page)=>page.getByTestId('voice-dock-status').innerText();
async function box(page:Page,testId:string){const b=await page.getByTestId(testId).boundingBox();assert.ok(b,testId+' is on screen');return b!;}
let checks=0;const ok=(name:string)=>{checks++;console.log('  ✓ '+name);};
try{for(const [name,engine] of Object.entries({chromium,webkit})){
  console.log(name);
  const browser=await engine.launch();
  try{
    const context=await browser.newContext({viewport:{width:1280,height:800}});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(server.url.toString());
    assert.equal(await status(page),'눌러서 말하기');ok('the dock is on screen before any voice');

    // First tap: consent has not been given on this device, so the panel asks for it.
    await page.getByTestId('voice-dock-call').click();await page.getByTestId('voice-panel').waitFor();
    assert.equal((await requests(page,'prepare')).length,0);ok('first tap opens the panel for consent, starts nothing');
    await page.getByTestId('voice-panel').getByRole('checkbox').last().check();
    await page.getByRole('button',{name:'마이크 켜고 시작'}).click();
    await page.getByTestId('voice-dock-status').filter({hasText:'총괄 응답중'}).waitFor();ok('status reads 총괄 응답중');
    const panel=await box(page,'voice-panel'),dock=await box(page,'voice-dock');
    assert.ok(panel.y+panel.height<=dock.y+1,`the panel sits above the dock (${panel.y+panel.height} <= ${dock.y})`);ok('the panel opens above the dock, not on it');
    await page.getByTestId('voice-panel').getByRole('button',{name:'음성 창 내리기'}).click();

    await page.getByTestId('voice-dock-partners').waitFor();
    assert.equal(await page.getByTestId('voice-dock-partner-ops').getAttribute('aria-pressed'),'true');
    assert.equal(await page.getByTestId('voice-dock-partner').innerText(),'테스트 프로젝트 · Codex');ok('partners: 총괄 selected, the running workroom offered');

    await page.getByTestId('voice-dock-partner').click();
    await page.getByTestId('voice-dock-status').filter({hasText:'테스트 프로젝트 · Codex 담당자 응답중'}).waitFor();
    const switched=await requests(page,'partner');assert.deepEqual(switched.at(-1).partner,{kind:'workroom',targetId:'project_fixture',sessionId:'terminal_fixture'});
    assert.equal(await page.evaluate(()=>(window as any).targetChanges),1,'the app is told the partner changed (it opens that workroom)');
    // Talking to a project AI is a relay: the dock says the words go into that workroom as-is.
    assert.match(await page.getByTestId('voice-dock-relay').innerText(),/테스트 프로젝트 · Codex 워크룸에 그대로 들어갑니다/);
    await page.getByRole('textbox',{name:/테스트 프로젝트.*워크룸에 입력/}).waitFor();
    ok('a tap switches to the project AI; the status and the relay hint follow');
    await page.getByTestId('voice-dock-partner-ops').click();
    await page.getByTestId('voice-dock-status').filter({hasText:'총괄 응답중'}).waitFor();ok('a tap on 총괄 comes back');

    // ⋯: any project, with or without a running workroom, optionally with a named AI.
    await page.getByTestId('voice-dock-partner-more').click();await page.getByTestId('voice-dock-picker').waitFor();
    await page.getByTestId('voice-dock-pick').first().waitFor();assert.equal(await page.getByTestId('voice-dock-pick').count(),2);
    if(shots)await page.screenshot({path:`${shots}/dock-${name}-picker.png`});
    await page.getByRole('searchbox',{name:'이 기기 프로젝트 검색'}).fill('다른');
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid="voice-dock-pick"]').length===1);
    await page.getByTestId('voice-dock-picker-agent').selectOption('claude');
    await page.getByTestId('voice-dock-pick').click();
    await page.getByTestId('voice-dock-status').filter({hasText:'다른 프로젝트 · Claude 담당자 응답중'}).waitFor();
    assert.deepEqual((await requests(page,'partner')).at(-1).partner,{kind:'project',targetId:'project_other',agent:'claude'});
    assert.equal(await page.getByTestId('voice-dock-picker').count(),0);ok('⋯ picks any project and its AI; the picker closes');
    await page.getByTestId('voice-dock-partner-ops').click();
    await page.getByTestId('voice-dock-status').filter({hasText:'총괄 응답중'}).waitFor();

    await emit(page,{type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'빌드 상태 알려줘'});
    await emit(page,{type:'response.output_audio_transcript.done',item_id:'a1',transcript:'The build is running.'});
    const captions=page.getByTestId('voice-dock-captions');
    await captions.getByText('(EN) 빌드 상태 알려줘').waitFor();await captions.getByText('(KO) The build is running.').waitFor();
    assert.match(await captions.innerText(),/나\s*빌드 상태 알려줘/);ok('subtitles: Korean line + English, English line + Korean');
    const preparesBeforeViewChange=(await requests(page,'prepare')).length;
    await page.getByTestId('voice-dock-call').click();await page.getByTestId('voice-panel').waitFor();
    await page.getByTestId('voice-dock-minimize').click();
    await page.getByTestId('voice-dock-restore').waitFor();
    assert.equal(await page.getByTestId('voice-panel').count(),0,'minimizing also lowers the open voice panel');
    assert.equal(await page.getByTestId('voice-dock-captions').count(),0,'a minimized voice hides subtitles and uncovers the page');
    assert.equal(await page.getByTestId('voice-dock-stop').count(),0,'the small icon replaces the large controls');
    await page.getByTestId('voice-dock-restore').click();
    await page.getByTestId('voice-dock-fullscreen-open').click();
    await page.getByTestId('voice-dock-fullscreen').waitFor();
    assert.match(await page.getByTestId('voice-dock-fullscreen-captions').innerText(),/빌드 상태 알려줘/);
    await emit(page,{type:'response.output_audio_transcript.done',item_id:'a-full',transcript:'The task is still running.'});
    await page.getByTestId('voice-dock-fullscreen-captions').getByText('The task is still running.',{exact:true}).waitFor();
    await page.getByTestId('voice-dock-fullscreen-minimize').click();
    await page.getByTestId('voice-dock-restore').click();
    assert.equal((await requests(page,'prepare')).length,preparesBeforeViewChange,'view changes keep the same voice session');
    ok('minimize and full-screen captions preserve the live conversation');
    await page.getByTestId('voice-dock-settings').click();await page.getByTestId('voice-dock-caption-mode').selectOption('original');await page.keyboard.press('Escape');
    await emit(page,{type:'conversation.item.input_audio_transcription.completed',item_id:'u2',transcript:'커밋해 줘'});
    await captions.getByText('커밋해 줘').waitFor();assert.equal(await captions.getByText('(EN) 커밋해 줘').count(),0);ok('원문만: no translation requested or shown');
    await page.getByTestId('voice-dock-settings').click();await page.getByTestId('voice-dock-caption-mode').selectOption('off');await page.keyboard.press('Escape');
    assert.equal(await page.getByTestId('voice-dock-captions').count(),0);ok('끄기: no subtitle strip');
    await page.getByTestId('voice-dock-settings').click();await page.getByTestId('voice-dock-caption-mode').selectOption('bilingual');
    // The provider stays changeable during a conversation and says when it applies (VOC 2026-09-30).
    await page.getByTestId('voice-dock-provider').selectOption('gemini');
    assert.match(await page.getByTestId('voice-dock-provider-next').innerText(),/지금 대화는 OpenAI.*다음 대화부터 Gemini/);
    await page.getByTestId('voice-dock-provider').selectOption('openai');assert.equal(await page.getByTestId('voice-dock-provider-next').count(),0);
    ok('provider can change mid-conversation and says it applies next time');
    await page.getByTestId('voice-dock-settings').click();
    // Typing speaks to whoever answers now and joins the subtitles.
    await page.getByRole('textbox',{name:'아젠투지에게 입력'}).fill('README 요약해 줘');await page.getByRole('textbox',{name:'아젠투지에게 입력'}).press('Enter');
    await page.getByTestId('voice-dock-captions').locator('.az-voice-dock__said').filter({hasText:'README 요약해 줘'}).waitFor();
    assert.equal((await requests(page,'say')).at(-1).text,'README 요약해 줘');
    assert.equal(await page.getByRole('textbox',{name:'아젠투지에게 입력'}).inputValue(),'');ok('typing in the dock speaks to the current partner');
    // # 언급 and @ 호출 in the dock input (VOC 2026-09-30), the same signs as the workroom composer.
    {const box=page.getByTestId('voice-dock-type').locator('input');
      assert.match(await box.getAttribute('placeholder')??'',/@ 호출 · # 언급/);
      await box.pressSequentially('#테스');
      const mentionList=page.getByRole('listbox',{name:'언급할 프로젝트 선택'});await mentionList.waitFor();
      await mentionList.getByRole('option',{name:'# 테스트 프로젝트'}).click();
      assert.equal(await box.inputValue(),'#테스트 프로젝트 ');
      await box.pressSequentially('상태 봐 줘');await box.press('Enter');
      await until(async()=>(await requests(page,'say')).at(-1)?.text==='#테스트 프로젝트 상태 봐 줘','the # say');
      assert.deepEqual((await requests(page,'say')).at(-1).references,['project_fixture']);
      await until(async()=>await box.inputValue()===''&&await box.isEnabled(),'the # send to finish');
      await box.pressSequentially('@다른');
      const callList=page.getByRole('listbox',{name:'호출할 프로젝트 선택'});await callList.waitFor();
      await callList.getByRole('option',{name:'@ 다른 프로젝트'}).click();
      await page.getByTestId('voice-dock-route').filter({hasText:'@ 다른 프로젝트'}).waitFor();
      assert.equal(await box.inputValue(),'');assert.equal(await box.getAttribute('aria-label'),'다른 프로젝트 워크룸에 맡길 내용');
      await box.pressSequentially('빌드해 줘');await box.press('Enter');
      await until(async()=>(await requests(page,'say')).at(-1)?.text==='빌드해 줘','the @ say');
      assert.equal((await requests(page,'say')).at(-1).route,'project_other');
      assert.equal(await page.getByTestId('voice-dock-route').count(),0);
      // Escape closes the suggestions without leaving the input.
      await box.pressSequentially('#');await mentionList.waitFor();await box.press('Escape');assert.equal(await mentionList.count(),0);await box.fill('');
      ok('# 언급 names a project and @ 호출 hands one message to another project from the dock');}
    // A draft 아젠투지 prepared is visible on the dock, and a tap opens the confirmation.
    // Talk to the workroom first; while a draft waits, the partner row is locked like the host rule.
    await page.getByTestId('voice-dock-partner').click();await page.getByTestId('voice-dock-status').filter({hasText:'담당자 응답중'}).waitFor();
    await page.evaluate(()=>(window as any).transcribe());
    await page.getByTestId('voice-dock-draft').waitFor({timeout:8000});
    assert.match(await page.getByTestId('voice-dock-draft').innerText(),/보낼 초안[\s\S]*음성 입력 테스트/);
    assert.equal(await page.getByRole('button',{name:'초안 보내기',exact:true}).count(),1);
    assert.equal(await page.getByRole('button',{name:'입력한 글 보내기',exact:true}).count(),1);
    assert.equal(await page.getByRole('button',{name:'보내기',exact:true}).count(),0,'the draft and typed input must have distinct accessible names');
    assert.equal(await page.getByTestId('voice-dock-partner-ops').isDisabled(),true,'no switch while a draft waits');
    if(shots)await page.screenshot({path:`${shots}/dock-${name}-draft.png`});
    // 「고쳐서 보내기」 edits on the card itself (VOC 2026-10-01: the panel opened behind a tall phone dock).
    await page.getByTestId('voice-dock-draft-edit-toggle').click();
    const edit=page.getByTestId('voice-dock-draft-edit');assert.equal(await edit.inputValue(),'음성 입력 테스트');
    await page.getByTestId('voice-dock-draft-edit-toggle').click();assert.equal(await edit.count(),0,'고치기 취소 returns to the draft');
    await page.getByTestId('voice-dock-draft-edit-toggle').click();await edit.fill('음성 입력 테스트 고침');
    // The card's buttons do not wait on another dock request (a typed line still on its way).
    await page.evaluate(()=>{(window as any).holdSay=true;});
    await page.getByTestId('voice-dock-type').locator('input').fill('다른 말');await page.getByTestId('voice-dock-type').locator('input').press('Enter');
    assert.equal(await page.getByTestId('voice-dock-draft-send').isEnabled(),true,'the draft send is not blocked by a typed line');
    await page.getByTestId('voice-dock-draft-send').click();
    await page.evaluate(()=>{(window as any).holdSay=false;(window as any).releaseSay?.();});
    // What 아젠투지 sent shows under that workroom's input box.
    await page.getByTestId('workroom-voice-sent').waitFor({timeout:4000});assert.match(await page.getByTestId('workroom-voice-sent').innerText(),/아젠투지가 워크룸에 보냄: 「음성 입력 테스트 고침」/);
    await page.getByTestId('voice-dock-draft').waitFor({state:'detached',timeout:4000});
    const sent=(await requests(page,'submit')).at(-1);assert.equal(sent.inputReady,true);assert.equal(sent.text,'음성 입력 테스트 고침');
    ok('draft card: edit in place, send not blocked by another dock request');
    ok('a pending draft shows its text on the dock and 보내기 sends it there');
    await page.evaluate(()=>(window as any).transcribe());await page.getByTestId('voice-dock-draft').waitFor({timeout:8000});
    await page.getByTestId('voice-dock-draft-discard').click();await page.getByTestId('voice-dock-draft').waitFor({state:'detached',timeout:4000});
    ok('버리기 discards the draft from the dock');
    // Pop-ups close like pop-ups: outside click, Escape.
    await page.getByTestId('voice-dock-partner-more').click();await page.getByTestId('voice-dock-picker').waitFor();
    assert.equal(await page.getByTestId('voice-dock-captions').count(),0,'subtitles step aside while a list is open');
    await page.mouse.click(40,300);await page.getByTestId('voice-dock-picker').waitFor({state:'detached'});
    await page.getByTestId('voice-dock-settings').click();await page.getByTestId('voice-dock-menu').waitFor();
    await page.keyboard.press('Escape');await page.getByTestId('voice-dock-menu').waitFor({state:'detached'});
    ok('the picker closes on an outside click, the menu on Escape');
    // Folding leaves one row (character, status, controls); unfolding brings the partners and the box back.
    await page.getByTestId('voice-dock-fold').click();
    assert.equal(await page.getByTestId('voice-dock-partners').count(),0);assert.equal(await page.getByTestId('voice-dock-type').count(),0);
    await page.getByTestId('voice-dock-fold').click();await page.getByTestId('voice-dock-partners').waitFor();await page.getByTestId('voice-dock-type').waitFor();
    ok('the dock folds to one row and unfolds');
    if(shots)await page.screenshot({path:`${shots}/dock-${name}-desktop.png`});

    await page.getByTestId('voice-dock-stop').click();
    await page.getByTestId('voice-dock-status').filter({hasText:'눌러서 말하기'}).waitFor();
    // After the end: the dock says why it ended, and the old subtitles are gone.
    await page.getByTestId('voice-dock-notice').waitFor();assert.match(await page.getByTestId('voice-dock-notice').innerText(),/종료/);
    assert.equal(await page.getByTestId('voice-dock-captions').count(),0);ok('after the end the dock says why and clears the subtitles');
    await page.getByTestId('voice-dock-notice').waitFor({state:'detached',timeout:10_000});ok('the end notice leaves after a few seconds instead of covering the page');
    if(await page.getByTestId('voice-panel').count())await page.getByTestId('voice-panel').getByRole('button',{name:'음성 패널 닫기'}).click();
    const prepared=(await requests(page,'prepare')).length;
    await page.getByTestId('voice-dock-call').click();
    await page.getByTestId('voice-dock-status').filter({hasText:'총괄 응답중'}).waitFor();
    assert.equal((await requests(page,'prepare')).length,prepared+1);assert.equal(await page.getByTestId('voice-panel').count(),0);ok('after consent, one tap on the character starts voice without the panel');
    await page.getByTestId('voice-dock-stop').click();
    assert.deepEqual(errors,[]);

    // An older Mac: nothing breaks; the partner list stays hidden, subtitles show the original.
    await page.evaluate(()=>{(window as any).olderMac=true;});
    await page.getByTestId('voice-dock-call').click();await page.getByTestId('voice-dock-status').filter({hasText:'총괄 응답중'}).waitFor();
    await page.waitForTimeout(150);
    assert.equal(await page.getByTestId('voice-dock-partners').count(),0);
    assert.equal(await page.getByTestId('voice-dock-relay').count(),0,'an older Mac never gets the relay promise');
    await emit(page,{type:'conversation.item.input_audio_transcription.completed',item_id:'old1',transcript:'안녕'});
    await page.getByTestId('voice-dock-captions').getByText('안녕').waitFor();await page.waitForTimeout(150);
    assert.equal(await page.getByTestId('voice-dock-error').count(),0);ok('older Mac: no partner list, original subtitles, no error');
    await page.getByTestId('voice-dock-stop').click();
    assert.deepEqual(errors,[]);await context.close();

    // A phone not granted OPS: a tap talks to an open workroom's AI (one → at once, several → pick, none → says what to do).
    {
      const noOps=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});const p=await noOps.newPage();
      await p.addInitScript(()=>localStorage.setItem('portmanager-voice-preferences',JSON.stringify({provider:'openai',consent:{openai:true}})));
      await p.goto(server.url.toString()+'?no-ops');
      assert.equal(await p.getByTestId('voice-dock-status').innerText(),'눌러서 말하기 · 워크룸');
      await p.getByTestId('voice-dock-call').click();await p.getByTestId('voice-dock-error').filter({hasText:'원격 작업에서 워크룸을 연 뒤'}).waitFor();
      await p.evaluate(()=>{(window as any).rooms=[{targetId:'project_fixture',sessionId:'terminal_fixture',label:'테스트 프로젝트 · codex'},{targetId:'project_other',sessionId:'terminal_other',label:'다른 프로젝트 · claude'}];});
      await p.getByTestId('voice-dock-call').click();await p.getByTestId('voice-dock-rooms').waitFor();
      assert.equal(await p.getByTestId('voice-dock-room').count(),2);
      await p.getByTestId('voice-dock-room').nth(1).click();
      await p.getByTestId('voice-dock-status').filter({hasText:'응답중'}).waitFor();
      assert.deepEqual((await requests(p,'prepare')).at(-1).target,{kind:'workroom',targetId:'project_other',sessionId:'terminal_other'});
      assert.equal(await p.getByTestId('voice-dock-partners').count(),0,'a workroom voice has no partner list');
    await p.getByTestId('voice-dock-relay').waitFor();assert.match(await p.getByTestId('voice-dock-relay').innerText(),/그대로 들어갑니다/);
      await p.getByTestId('voice-dock-stop').click();await noOps.close();
      ok('a phone without OPS talks to the open workroom it picks');
    }

    // Phone size: the dock and the panel fit, touch targets are 44px.
    const phone=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});const mobile=await phone.newPage();
    await mobile.addInitScript(()=>localStorage.setItem('portmanager-voice-preferences',JSON.stringify({provider:'openai',consent:{openai:true}})));
    await mobile.goto(server.url.toString());
    await mobile.getByTestId('voice-dock-call').click();await mobile.getByTestId('voice-dock-partners').waitFor();
    await mobile.getByTestId('voice-dock-minimize').click();
    const compact=await box(mobile,'voice-dock-restore');assert.ok(compact.width<=60&&compact.height>=44,'minimized phone voice is one touch target');
    if(shots)await mobile.screenshot({path:`${shots}/dock-${name}-phone-minimized.png`});
    await mobile.getByTestId('voice-dock-restore').click();
    await emit(mobile,{type:'conversation.item.input_audio_transcription.completed',item_id:'phone-u1',transcript:'아젠투지, 현재 진행 상황 알려줘'});
    await emit(mobile,{type:'response.output_audio_transcript.done',item_id:'phone-a1',transcript:'vibe2 워크룸 종료 상태를 확인했습니다.'});
    await mobile.getByTestId('voice-dock-fullscreen-open').click();
    const full=await box(mobile,'voice-dock-fullscreen');assert.ok(full.width>=389&&full.height>=843,`captions fill the phone viewport: ${JSON.stringify(full)}`);
    await mobile.getByTestId('voice-dock-fullscreen-captions').getByText('vibe2 워크룸 종료 상태를 확인했습니다.',{exact:true}).waitFor();
    if(shots)await mobile.screenshot({path:`${shots}/dock-${name}-phone-captions.png`});
    await mobile.getByTestId('voice-dock-fullscreen-close').click();
    const d=await box(mobile,'voice-dock');assert.ok(d.x>=0&&d.x+d.width<=390&&d.y+d.height<=844,'the dock fits the phone');
    for(const id of ['voice-dock-mic','voice-dock-stop','voice-dock-settings','voice-dock-partner'])assert.ok((await box(mobile,id)).height>=44,id+' is a 44px target');
    await mobile.getByTestId('voice-dock-call').click();await mobile.getByTestId('voice-panel').waitFor();
    const p=await box(mobile,'voice-panel'),d2=await box(mobile,'voice-dock');
    assert.ok(p.y>=0&&p.y+p.height<=d2.y+1,'the phone panel sits above the dock');
    assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no sideways scroll');
    if(shots)await mobile.screenshot({path:`${shots}/dock-${name}-phone.png`});
    ok('phone: fits, 44px targets, panel above the dock, no sideways scroll');
    await phone.close();
  }finally{await browser.close();}
}}finally{await server.stop(true);}
console.log(`${checks} checks passed`);
