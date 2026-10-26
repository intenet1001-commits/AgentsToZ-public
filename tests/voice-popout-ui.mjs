import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
const built=await Bun.build({entrypoints:['tests/fixtures/voice/popout.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
if(!built.success)throw Error(built.logs.join('\n'));
const js=built.outputs.find(f=>f.path.endsWith('.js')),css=built.outputs.find(f=>f.path.endsWith('.css'));
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>{const p=new URL(r.url).pathname;return p==='/app.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):p==='/app.css'?new Response(css,{headers:{'Content-Type':'text/css'}}):new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;--bg:#0a0a0b;--surface:#18181b;--ink:#fafafa;--line:#3f3f46}</style><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>',{headers:{'Content-Type':'text/html'}});}});
mkdirSync('.agentstoz/maintainer/rebuild-20261014/voice-ui',{recursive:true});
try{for(const [name,engine] of Object.entries({chromium,webkit})){
 const browser=await engine.launch();try{
  const main=await browser.newPage();main.on('pageerror',e=>console.error('primary',e.message));await main.goto(server.url+'?primary=1');await main.waitForFunction(()=>window.creations===1);console.log(name+': launcher ready');
  assert.equal(await main.getByTestId('voice-dock').count(),0);assert.equal(await main.evaluate(()=>window.mediaStarts),0);await main.evaluate(()=>window.nativeEvent('voice-dock:action',{kind:'helpdesk',key:null}));assert.equal(await main.evaluate(()=>window.helpdeskOpens),1,'main receives the fixed helpdesk action');
  await main.evaluate(()=>window.dispatchEvent(new Event('agentstoz:open-ops-voice')));await main.waitForFunction(()=>window.nativeCalls.some(c=>c.command==='open_voice_window'&&c.args.panel));assert.equal(await main.evaluate(()=>window.creations),1);console.log(name+': launcher panel event ready');
  // VOC 2026-10-15: a closed 「아젠투지 호출」 window must be reopenable without quitting the app.
  assert.equal(await main.getByTestId('voice-dock-reopen').count(),0,'no reopen button while the voice window is open');
  await main.evaluate(()=>window.closeVoiceWindow());await main.getByTestId('voice-dock-reopen').waitFor();
  // Reopen DOM commits before the launcher's passive effect applies the shared toast offset.
  await main.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--voice-dock-offset').trim()==='52px',null,{timeout:3000});
  assert.equal(await main.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--voice-dock-offset').trim()),'52px','toasts are lifted above the reopen button');
  assert.equal(await main.evaluate(()=>{const scrim=document.createElement('div');scrim.style.cssText='position:fixed;inset:0;z-index:50;background:#0006';document.body.append(scrim);const box=document.querySelector('[data-testid="voice-dock-reopen"]').getBoundingClientRect();const hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);scrim.remove();return hit===scrim;}),true,'a modal scrim (lowest z-50) covers the reopen button');
  const opensBefore=await main.evaluate(()=>window.nativeCalls.filter(c=>c.command==='open_voice_window').length);
  await main.getByTestId('voice-dock-reopen').click();await main.getByTestId('voice-dock-reopen').waitFor({state:'detached'});
  const reopenCall=await main.evaluate(n=>window.nativeCalls.filter(c=>c.command==='open_voice_window')[n],opensBefore);
  assert.deepEqual(reopenCall.args,{panel:false},'the reopen button brings back the compact dock, not the full panel');
  assert.equal(await main.evaluate(()=>window.creations),2);
  await main.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--voice-dock-offset').trim()==='',null,{timeout:3000});
  assert.equal(await main.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--voice-dock-offset').trim()),'','offset is released once the dock is back');
  await main.evaluate(()=>window.closeVoiceWindow(true));await main.evaluate(()=>window.dispatchEvent(new Event('focus')));await main.getByTestId('voice-dock-reopen').waitFor();
  await main.evaluate(()=>window.dispatchEvent(new Event('agentstoz:open-voice-dock')));await main.getByTestId('voice-dock-reopen').waitFor({state:'detached'});
  assert.equal(await main.evaluate(()=>window.creations),3);console.log(name+': closed dock reopens from the floating button and from 「도구 및 설정」');
  // A native content inset must not hide the initial text field or send button.
  for(const width of [280,320,420]){
   const initial=await browser.newPage({viewport:{width,height:116}});let nativeInnerHeight=148;
   await initial.exposeFunction('resizeNativeContent',async args=>{
    nativeInnerHeight=Math.min(760,args.height+Math.max(0,nativeInnerHeight-(args.viewportHeight??nativeInnerHeight)));
    await initial.setViewportSize({width,height:Math.max(94,Math.round(nativeInnerHeight-32))});
   });
   await initial.goto(server.url.toString());await initial.getByTestId('voice-dock-type').waitFor();
   await initial.waitForFunction(()=>window.nativeCalls.some(c=>c.command==='resize_voice_window'));
   const visible=await initial.evaluate(()=>{const form=document.querySelector('[data-testid="voice-dock-type"]').getBoundingClientRect();const submit=document.querySelector('[data-testid="voice-dock-type"] button[type="submit"]').getBoundingClientRect();return {height:innerHeight,formBottom:form.bottom,submitBottom:submit.bottom,width:innerWidth,submitRight:submit.right};});
   assert.ok(visible.formBottom<=visible.height&&visible.submitBottom<=visible.height,`${name} ${width}: initial composer fits the actual native viewport: ${JSON.stringify(visible)}`);
   assert.ok(visible.submitRight<=visible.width,'initial send button fits horizontally');const help=await initial.getByTestId('voice-helpdesk-open').boundingBox();assert.ok(help.x>=65&&help.x+help.width<=width&&help.y>=0&&help.y+help.height<=38,'helpdesk stays in title area clear of native traffic lights');await initial.close();
  }
  const page=await browser.newPage({viewport:{width:420,height:720}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(server.url.toString());
  await page.getByTestId('voice-dock-call').waitFor();await page.getByTestId('voice-helpdesk-open').click();assert.equal(await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='voice_dock_action'&&c.args.kind==='helpdesk'&&c.args.key===null).length),1);assert.equal(await page.evaluate(()=>window.mediaStarts),0,'helpdesk opens without starting voice');await page.setViewportSize({width:320,height:116});await page.screenshot({path:`.agentstoz/maintainer/rebuild-20261014/voice-ui/${name}-collapsed.png`});await page.setViewportSize({width:420,height:720});
  await page.getByTestId('voice-dock-call').click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'마이크 켜고 시작',exact:true}).click();await page.getByRole('meter').waitFor();console.log(name+': microphone active');
  assert.equal(await page.evaluate(()=>window.mediaStarts),1);
  await page.getByRole('button',{name:'음성 창 내리기',exact:true}).click();assert.equal(await page.evaluate(()=>window.trackStops),0);
  await page.getByTestId('voice-dock-call').click();assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.action==='prepare').length),1);
  const bounds=await page.getByTestId('voice-panel').boundingBox();assert.ok(bounds.x>=0&&bounds.width<=420);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.setViewportSize({width:280,height:720});for(const button of await page.locator('.az-voice-dock__controls button').all()){const box=await button.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=280,'every dock control stays inside the minimum native width');}await page.setViewportSize({width:420,height:720});
  const target={kind:'workroom',targetId:'target_12345',sessionId:'session_12345',agent:'codex',label:'시험 프로젝트'};
  await page.evaluate(t=>{window.dispatchEvent(new CustomEvent('agentstoz:voice-workroom-opened',{detail:t}));window.dispatchEvent(new CustomEvent('agentstoz:voice-target-change',{detail:t}));},target);
  await page.waitForFunction(()=>window.nativeCalls.some(c=>c.command==='open_workroom_window'));assert.equal(await page.evaluate(()=>window.nativeCalls.filter(c=>c.command==='open_workroom_window').length),1);console.log(name+': workroom opened');
  await page.screenshot({path:`.agentstoz/maintainer/rebuild-20261014/voice-ui/${name}.png`,fullPage:true});
  await page.evaluate(()=>window.nativeEvent('tauri://close-requested',null));await page.waitForFunction(()=>window.voiceClosed===true);
  assert.equal(await page.evaluate(()=>window.trackStops),1);assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.action==='stop').length),1);assert.deepEqual(errors,[]);
  console.log(name+': independent voice owner, same-session panel, bounded layout, deduplicated workroom event, media cleanup passed');
 }finally{await browser.close();}
}}finally{server.stop(true);}
