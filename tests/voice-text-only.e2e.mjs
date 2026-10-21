// Real dock, panel and media client. Synthetic host/RTC only; no microphone, provider, CLI or cloud.
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {join,basename} from 'node:path';
const built=await Bun.build({entrypoints:['tests/fixtures/voice/text-only.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
if(!built.success)throw Error(built.logs.join('\n'));
const js=built.outputs.find(o=>o.path.endsWith('.js')),css=built.outputs.find(o=>o.path.endsWith('.css'));
const assets=new Map(built.outputs.map(o=>['/'+basename(o.path),o]));
const remoteCss=(await Bun.file('src/remote-control-portal.css').text()).replace(/^@import[^;]+;/gm,'');
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>{const path=new URL(r.url).pathname;return path==='/panel.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):path==='/panel.css'?new Response(css,{headers:{'Content-Type':'text/css'}}):path==='/remote-theme.css'?new Response(remoteCss,{headers:{'Content-Type':'text/css'}}):assets.has(path)?new Response(assets.get(path)):new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/panel.css"><div id="root"></div><script type="module" src="/panel.js"></script>',{headers:{'Content-Type':'text/html'}});}});
const shots=process.env.TEXT_ONLY_SHOTS;if(shots)await mkdir(shots,{recursive:true});
async function phoneDockGeometry(page,{idle=false}={}){
 const g=await page.getByTestId('voice-dock').evaluate(dock=>{
  const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
  return {dock:rect(dock),main:rect(dock.querySelector('.az-voice-dock__main')),form:rect(dock.querySelector('form')),call:rect(dock.querySelector('[data-testid="voice-dock-call"]')),settings:rect(dock.querySelector('[data-testid="voice-dock-settings"]')),controls:[...dock.querySelectorAll('.az-voice-dock__main button')].map(rect),input:rect(dock.querySelector('form input')),nav:rect(document.querySelector('nav.workspace-navigation')),viewport:innerWidth};
 });
 assert.ok(g.dock.left>=0&&g.dock.right<=g.viewport,JSON.stringify(g));
 assert.ok(Math.abs(g.main.left-g.form.left)<=1&&Math.abs(g.main.right-g.form.right)<=1,`Call header and composer must align: ${JSON.stringify(g)}`);
 assert.ok(Math.abs(g.call.top+g.call.height/2-g.settings.top-g.settings.height/2)<=1,`Settings must stay beside the call: ${JSON.stringify(g)}`);
 assert.ok(g.dock.bottom<=g.nav.top-3,`Dock must clear the bottom navigation: ${JSON.stringify(g)}`);
 assert.ok(g.input.width>=60&&g.input.left>=g.form.left&&g.input.right<=g.form.right,`Composer must remain usable: ${JSON.stringify(g)}`);
 for(let i=0;i<g.controls.length;i++)for(let j=i+1;j<g.controls.length;j++){
  const a=g.controls[i],b=g.controls[j];assert.ok(Math.min(a.right,b.right)-Math.max(a.left,b.left)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<=1,`Call controls overlap: ${JSON.stringify(g)}`);
 }
 if(idle)assert.ok(g.dock.height<=132,`Idle caller must not grow into a tall wrapped panel: ${JSON.stringify(g)}`);
}
try{
 for(const [name,engine] of Object.entries({chromium,webkit})){
  const browser=await engine.launch();try{
   for(const width of [1280,390,320]){
    const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<600,isMobile:width<600,serviceWorkers:'block'});
    try{
     await context.route('**/*',route=>new URL(route.request().url()).origin===server.url.origin?route.continue():route.abort());
     await context.addInitScript(()=>{
      const layout=new URLSearchParams(location.search).has('idle-layout');
      localStorage.setItem('agentstoz-voice-dock-folded',layout?'0':'1');
      localStorage.setItem('portmanager-lang',layout?new URLSearchParams(location.search).get('lang')??'ko':'ko');
      if(layout)localStorage.setItem('portmanager-voice-preferences',JSON.stringify({interactionMode:'text'}));else localStorage.removeItem('portmanager-voice-preferences');
      window.audioPlays=0;HTMLMediaElement.prototype.play=function(){window.audioPlays++;return Promise.reject(Error('Audio must remain silent'));};
     });
     const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
     if(width<600){
      const idle=await context.newPage();
      try{
       for(const lang of ['ko','en','de']){
        await idle.goto(server.url.toString()+`?remote=1&idle-layout=1&lang=${lang}`);await idle.getByTestId('voice-dock-type').waitFor();
        await idle.locator('nav.workspace-navigation').waitFor();await idle.waitForFunction(()=>[...document.styleSheets].some(s=>s.href?.endsWith('/remote-theme.css')));
        await phoneDockGeometry(idle,{idle:true});
        if(shots)await idle.screenshot({path:join(shots,`${name}-${width}-${lang}-idle.png`)});
       }
       if(width===390){await idle.setViewportSize({width:844,height:390});await idle.goto(server.url.toString()+'?remote=1&idle-layout=1');await idle.getByTestId('voice-dock-type').waitFor();await phoneDockGeometry(idle,{idle:true});}
      }finally{await idle.close();}
     }
     await page.goto(server.url.toString()+(width<600?'?remote=1':''));await page.evaluate(()=>window.deny=true);
     await page.getByTestId('voice-dock-text-start').click();
     const panel=page.getByTestId('voice-panel');await panel.waitFor();
     assert.equal(await page.evaluate(()=>window.captureRequests),0,'Text start never asks for microphone permission');
     await panel.getByRole('checkbox').last().check();await panel.getByRole('button',{name:'텍스트로 대화 시작',exact:true}).click();
     await page.waitForFunction(()=>window.client.snapshot().textOnly&&window.client.snapshot().phase==='review');
     assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('portmanager-voice-preferences')).consent?.openai===true),false,'Text consent never grants voice consent');
     await panel.getByRole('button',{name:'대화 창 내리기',exact:true}).click();
     const input=page.getByRole('textbox',{name:'아젠투지에게 입력',exact:true});await input.fill('조용히 입력하는 요청');
     await input.dispatchEvent('compositionstart');await page.getByTestId('voice-dock-type').evaluate(form=>form.requestSubmit());
     assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.action==='say').length),0,'IME confirmation is not submission');
     await input.dispatchEvent('compositionend');await page.getByTestId('voice-dock-type').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
     await page.waitForFunction(()=>window.requests.filter(r=>r.action==='say').length===1);assert.equal(await input.inputValue(),'');
     await page.evaluate(()=>{window.client.setCaptionMode('off');window.emit({type:'response.output_audio_transcript.done',item_id:'silent-answer',transcript:'소리 없이 글로 답했습니다.'});window.peer.ontrack({streams:[new MediaStream()]});});
     await page.getByTestId('voice-dock-captions').getByText('소리 없이 글로 답했습니다.').waitFor();
     assert.equal(await page.getByTestId('voice-dock-mic').count(),0);assert.equal(await page.getByTestId('voice-dock-speaker').count(),0);
     assert.equal(await page.evaluate(()=>window.captureRequests),0);assert.equal(await page.evaluate(()=>window.audioPlays),0);
     await input.fill('전체 화면에 유지할 초안');await page.getByTestId('voice-dock-fullscreen-open').click();
     const full=page.getByTestId('voice-dock-fullscreen');assert.equal(await full.getByRole('textbox',{name:'아젠투지에게 입력',exact:true}).inputValue(),'전체 화면에 유지할 초안');
     await full.getByRole('textbox',{name:'아젠투지에게 입력',exact:true}).press('Enter');await page.waitForFunction(()=>window.requests.filter(r=>r.action==='say').length===2);
     await page.getByTestId('voice-dock-fullscreen-close').click();
     await input.fill('@다른');await page.getByRole('option').filter({hasText:'다른 프로젝트'}).click();
     await page.getByTestId('voice-dock-route').waitFor();await page.getByTestId('voice-dock-type').locator('input').fill('이 프로젝트에 요청');
     if(width<600)await phoneDockGeometry(page);
     await page.getByRole('button',{name:'입력한 글 보내기',exact:true}).click();
     await page.waitForFunction(()=>window.requests.filter(r=>r.action==='say').length===3);
     assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.action==='say').at(-1).route),'project_other');
     const geometry=await page.getByTestId('voice-dock').evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth};});
     assert.ok(geometry.left>=-1&&geometry.right<=geometry.width+1,JSON.stringify(geometry));
     if(width<600)await phoneDockGeometry(page);
     if(shots)await page.screenshot({path:join(shots,`${name}-${width}-text-only.png`),fullPage:true});
     const id=await page.evaluate(()=>window.client.snapshot().session.id);
     await page.evaluate(()=>window.bothProviders=true);await page.getByTestId('voice-dock-settings').click();await page.getByTestId('voice-dock-provider').selectOption('gemini');await page.getByRole('combobox',{name:'대화 방식',exact:true}).selectOption('voice');
     await panel.waitFor();assert.equal(await page.evaluate(()=>window.captureRequests),0,'Switching mode waits for separate voice consent');
     assert.equal(await panel.getByText('마이크 음성과 필요한 대화 문맥을', {exact:false}).locator('input').isChecked(),false,'Text consent never appears checked as voice consent during the mode transition');
     await panel.getByText('마이크 음성과 필요한 대화 문맥을', {exact:false}).locator('input').check();
     await panel.getByRole('button',{name:'음성으로 전환',exact:true}).click();
     await page.waitForFunction(()=>window.captureRequests===1&&window.client.snapshot().textOnly);
     assert.equal(await page.evaluate(()=>window.client.snapshot().session.id),id,'Microphone refusal keeps the existing text conversation');
     assert.equal(await page.evaluate(()=>window.audioPlays),0);assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.action==='prepare').length),1);
     assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('portmanager-voice-preferences')).consent.openai),true,'Consent belongs to the active OpenAI session despite the next-provider picker');
     assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('portmanager-voice-preferences')).consent.gemini),undefined);
     assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('portmanager-voice-preferences')).interactionMode),'text','Denied microphone leaves the working text mode selected');
     assert.deepEqual(errors,[]);await page.evaluate(()=>window.client.stop());
     console.log(`${name} ${width}: text start, consent separation, IME, replies, @ route and denied microphone passed`);
    }finally{await context.close();}
   }
  }finally{await browser.close();}
 }
}finally{await server.stop(true);}
