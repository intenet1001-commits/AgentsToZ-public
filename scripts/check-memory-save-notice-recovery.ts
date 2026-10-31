import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
const output=process.argv[2];if(output)mkdirSync(output,{recursive:true});
const build=await Bun.build({entrypoints:['tests/fixtures/memory-save-notice-recovery.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
if(!build.success)throw Error(build.logs.map(String).join('\n'));
const script=build.outputs.find(file=>file.path.endsWith('.js'))!,css=(await Promise.all(build.outputs.filter(file=>file.path.endsWith('.css')).map(file=>file.text()))).join('\n');
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>{
  const path=new URL(request.url).pathname;
  if(path==='/fixture.js')return new Response(script,{headers:{'Content-Type':'text/javascript'}});
  if(path==='/fixture.css')return new Response(css,{headers:{'Content-Type':'text/css'}});
  return new Response(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{--ink:#eee;--ink-2:#ddd;--ink-3:#aaa;--bg-card-rgb:24 24 27;--line:#444;--line-2:#555;--surface:#252529;--sunken:#151518;--accent:#e5a071;--accent-rgb:229 160 113;--danger:#ff7777;--warn:#ffd47b;--ok:#93dc99}
    *{box-sizing:border-box}body{margin:0;padding:12px;background:#111;color:#eee;font:14px system-ui}h1{font-size:16px;margin:0 0 12px}main{display:flex;flex-direction:column;gap:12px}textarea{display:block;width:100%;height:42px;background:#222;color:#fff}
  </style><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>`,{headers:{'Content-Type':'text/html; charset=utf-8'}});
}});
let checks=0;
try{
  for(const [engineName,engine] of Object.entries({chromium,webkit})){
    const browser=await engine.launch();
    try{for(const kind of ['agent','conflict','unknown','backup','unregistered','launch-unknown','open-fail']){
      const context=await browser.newContext({viewport:{width:280,height:620}}),page=await context.newPage();
      const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`${server.url}?kind=${kind}`);
      const card=page.getByTestId('dock-save-run');
      try{await card.locator('[data-testid="memory-save-recovery"]').waitFor({timeout:6000});}
      catch(error){console.log(JSON.stringify({engineName,kind,errors,text:(await page.textContent('body'))?.slice(0,700)}));throw error;}
      assert.equal((await page.textContent('body'))!.includes('PRIVATE_'),false,'raw prompt/error never reaches notice text');
      assert.equal(await page.locator('button button').count(),0,'actions never nest inside the expandable header button');
      const bounds=await card.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=281,'notice fits 280px voice window');
      await card.getByRole('button',{name:/테스트 프로젝트 (확인·해결|결과 확인|백업 확인)/}).click();
      const panel=card.getByRole('region',{name:'테스트 프로젝트 기억 저장 해결'});
      await panel.waitFor();await panel.getByRole('combobox').selectOption(kind==='agent'?'claude':'codex');
      await panel.getByTestId('memory-save-recovery-start').click();
      if(kind==='unregistered'){
        await panel.getByText('이 프로젝트의 등록 경로를 확인하지 못했습니다.',{exact:false}).waitFor();
      }else if(kind==='launch-unknown'){
        await panel.getByRole('button',{name:'프로젝트 워크룸 목록 확인'}).click();
        const rooms=panel.locator('.az-memory-recovery__rooms button');await rooms.waitFor();assert.equal(await rooms.count(),1,'only the same project and chosen AI');await rooms.click();
      }else{
        if(kind==='open-fail')await panel.getByText('워크룸은 시작됐지만',{exact:false}).waitFor();
        else await panel.getByText('워크룸을 열었습니다.',{exact:false}).waitFor();
        await panel.getByRole('button',{name:'같은 워크룸 다시 열기'}).click();
      }
      const state=await page.evaluate(()=>({calls:(window as any).calls,opened:(window as any).opened,terminalCalls:(window as any).terminalCalls}));
      const starts=state.terminalCalls.filter((call:any)=>call.operation==='start');
      assert.equal(starts.length,kind==='unregistered'?0:1,'repeat opens or lost replies never start twice');
      if(starts.length){assert.equal(starts[0].targetId,'project-memory-123');assert.equal(starts[0].bypassPermissions,false);assert.equal(starts[0].prompt.includes('PRIVATE_'),false);}
      assert.equal(state.calls.some((call:any)=>call.path==='/api/agent-runtime/terminals'),false,'voice UI never uses the general terminal proxy');
      assert.equal(state.calls.filter((call:any)=>call.path==='/api/agent-runtime/memory-save-recovery').some((call:any)=>'prompt' in call.body||'bypassPermissions' in call.body),false,'wire carries fixed diagnosis metadata only');
      assert.equal(state.calls.filter((call:any)=>call.path==='/api/project-memory/session-end').length,1,'diagnosis never resubmits the failed save');
      assert.deepEqual(errors,[]);
      if(output)await page.screenshot({path:`${output}/${engineName}-${kind}-280.png`});
      console.log(`${engineName}: ${kind} safe notice, exact project, explicit AI launch and no duplicate retry passed`);checks++;
      await context.close();
    }}finally{await browser.close();}
  }
}finally{server.stop(true);}
console.log(`${checks} rendered recovery journeys passed (fixture; no real provider calls).`);
