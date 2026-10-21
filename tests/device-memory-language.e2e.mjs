// Browser engines exercise the actual React preference and memory form; the host/backup is explicitly scripted.
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const built=await Bun.build({entrypoints:['tests/fixtures/device-memory/panel.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});if(!built.success)throw Error(built.logs.join('\n'));const js=built.outputs.find(o=>o.path.endsWith('.js'));
const html='<meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--surface:#172934;--line:#53656c;--ink:#ecf3f2}*{box-sizing:border-box}body{margin:0;background:#0c1922;color:var(--ink);font:15px system-ui}h1{font-size:24px}button:disabled{opacity:.5}select option{background:#172934;color:white}summary{cursor:pointer;padding:10px}input,textarea{max-width:100%}</style><div id="root"></div><script type="module" src="/panel.js"></script>';
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>new URL(r.url).pathname==='/panel.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):new Response(html,{headers:{'Content-Type':'text/html'}})});
if(process.argv.includes('--serve')){console.log(JSON.stringify({url:server.url.toString()}));await new Promise(()=>{});}
const shots=process.env.DEVICE_MEMORY_SHOTS;if(shots)await mkdir(shots,{recursive:true});
try{for(const [name,engine] of Object.entries({chromium,webkit})){
 const browser=await engine.launch();try{for(const width of [1280,390,320]){
 const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<600});try{
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(server.url.toString());
 await page.getByText('아직 저장한 기기 기억이 없습니다.',{exact:true}).waitFor();assert.equal(await page.locator('html').getAttribute('lang'),'ko');
 const picker=page.getByTestId('app-language');await picker.selectOption('en');await page.getByRole('heading',{name:'My workspace',exact:true}).waitFor();
 const title=page.getByRole('textbox',{name:'Title',exact:true}),body=page.getByRole('textbox',{name:'What to remember',exact:true});await title.fill('Device preference');await body.fill('Keep the microphone muted during meetings.');
 await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Saved locally · cloud backup pending',{exact:true}).waitFor();assert.equal(await title.isDisabled(),true);
 await page.evaluate(()=>window.failBackup=false);await page.getByRole('button',{name:'Check the same request',exact:true}).click();await page.getByText('Saved and backed up to cloud',{exact:true}).waitFor();assert.equal(await title.inputValue(),'');
 const saves=await page.evaluate(()=>window.requests.filter(r=>r.operation==='save'));assert.equal(saves.length,2);assert.deepEqual(saves[0],saves[1]);assert.equal(await page.getByText('Device preference',{exact:true}).count(),1);
 for(const [id,heading] of [['ja','マイワークスペース'],['zh-CN','我的工作空间'],['es','Mi espacio de trabajo'],['fr','Mon espace de travail'],['de','Mein Arbeitsbereich']]){await picker.selectOption(id);await page.getByRole('heading',{name:heading,exact:true}).waitFor();assert.equal(await page.locator('html').getAttribute('lang'),id);}
 await page.reload();await page.getByRole('heading',{name:'Mein Arbeitsbereich',exact:true}).waitFor();assert.equal(await picker.inputValue(),'de');
 const other=await context.newPage();await other.goto(server.url.toString());await other.getByTestId('app-language').selectOption('ko');await page.getByRole('heading',{name:'내 작업 공간',exact:true}).waitFor();await other.close();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');assert.deepEqual(errors,[]);
 if(shots)await page.screenshot({path:join(shots,`${name}-${width}.png`),fullPage:true});console.log(`${name} ${width}: seven languages, persistence/windows, backup retry and layout passed`);
 }finally{await context.close();}}}finally{await browser.close();}
}}finally{await server.stop(true);}
