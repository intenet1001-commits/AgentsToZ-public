import {chromium,webkit} from 'playwright';import assert from 'node:assert/strict';
const build=await Bun.build({entrypoints:['tests/fixtures/voice/history.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});if(!build.success)throw Error(build.logs.join('\n'));const js=build.outputs[0]!;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>new URL(r.url).pathname==='/app.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/app.js"></script>',{headers:{'Content-Type':'text/html'}})});
try{for(const [name,engine] of Object.entries({chromium,webkit})){const browser=await engine.launch();try{
 const page=await browser.newPage({viewport:{width:402,height:874}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(server.url.toString());
 const session=(text:string)=>page.getByTestId('voice-history-session').filter({hasText:text});
 const chip=(scope:string)=>page.locator(`[data-testid="voice-history-scope"][data-scope="${scope}"]`);
 // Project voice is titled by the registered name; the recorded aiName-first label stays as a subtitle.
 await session('Star Garden · claude').getByText('별빛 프로젝트',{exact:true}).waitFor();
 await session('Star Garden · claude').click();await page.getByText('OpenAI Realtime API 영어 이름은 유지해 주세요.').waitFor();
 await page.getByRole('button',{name:'다음 내용'}).click();await page.getByText('확인 전에는 완료로 기록하지 않겠습니다.').waitFor();
 await page.getByRole('button',{name:'세션 기억하기',exact:true}).click();await page.getByRole('status').filter({hasText:'저장 중'}).waitFor();
 await page.getByRole('button',{name:'저장 상태 확인'}).click();await page.getByRole('status').filter({hasText:'정리했습니다'}).waitFor();
 // A session whose speech was not all saved says so and is not turned into memory.
 await session('Star Garden · codex').getByText('일부 기록 확인 필요').waitFor();await session('Star Garden · codex').click();
 await page.getByTestId('voice-history-incomplete').waitFor();assert.equal(await page.getByRole('button',{name:'세션 기억하기',exact:true}).isDisabled(),true);
 // 아젠투지 (OPS) voice is titled 아젠투지, never the runtime label.
 await session('AgentsToZ-Control').click();await page.getByRole('heading',{name:'아젠투지',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'세션 기억하기',exact:true}).count(),0);
 await page.getByRole('textbox').fill('OPS와 Control은 하나의 운영 기억을 사용한다.');await page.getByRole('button',{name:'운영 기억 후보 저장'}).click();await page.getByRole('status').filter({hasText:'후보로 제출'}).waitFor();
 // Filter chips: 전체 · 아젠투지 · each project.
 assert.equal(await chip('ops').innerText(),'아젠투지');assert.equal(await chip('project_star').innerText(),'별빛 프로젝트');
 await chip('ops').click();await page.waitForFunction(()=>document.querySelectorAll('[data-testid="voice-history-session"]').length===1);
 assert.equal(await chip('ops').getAttribute('aria-pressed'),'true');
 assert.equal(await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.action==='history.list').at(-1).scope),'ops');
 await chip('project_star').click();await page.waitForFunction(()=>document.querySelectorAll('[data-testid="voice-history-session"]').length===2);
 await chip('all').click();await page.waitForFunction(()=>document.querySelectorAll('[data-testid="voice-history-session"]').length===3);
 assert.equal(await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.action==='history.list').at(-1).scope),undefined);
 assert.deepEqual(errors,[]);console.log(name+': voice history names, scopes, paging, speakers, memory action, OPS proposal passed');
}finally{await browser.close();}}}finally{await server.stop(true);}
