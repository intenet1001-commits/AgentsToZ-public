import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
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
  assert.deepEqual(errors,[]);
  const main=await browser.newPage({viewport:{width:960,height:720}});await main.goto(server.url+'?workmode-main=1');
  // The trigger used to sit on x=0 and read as cut while the brand and tabs are inset (UI audit 2026-10-24).
  assert.ok((await main.getByTestId('work-mode-open').boundingBox()).x>=8,'main trigger is inset from the window edge');
  const navBefore=await main.getByTestId('main-nav').boundingBox();await main.getByTestId('work-mode-open').click();await main.getByText('지금은 쉬는 중',{exact:true}).waitFor();
  assert.deepEqual(await main.getByTestId('main-nav').boundingBox(),navBefore,'main settings do not displace navigation');
  const mainPanel=await main.getByRole('region',{name:'근무 모드 설정'}).boundingBox();assert.ok(mainPanel.x>=0&&mainPanel.x+mainPanel.width<=264,'main settings stay inside the sidebar');
  assert.equal(await main.getByRole('region',{name:'근무 모드 설정'}).evaluate(n=>n.scrollWidth>n.clientWidth),false,'main copy wraps within the sidebar');
  await main.screenshot({path:`.agentstoz/maintainer/work-mode/${name}-main.png`});
  console.log(`${name}: presets, always-on, custom bounds, screen option, failure, stop, native events, Escape, narrow dock and main sidebar passed`);
 }finally{await browser.close();}
}}finally{server.stop(true);}
