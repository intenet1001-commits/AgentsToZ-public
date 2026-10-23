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
 await picker.selectOption('ja');await page.getByText('保存・クラウドバックアップ完了',{exact:true}).waitFor();
 for(const [id,heading] of [['ja','マイワークスペース'],['zh-CN','我的工作空间'],['es','Mi espacio de trabajo'],['fr','Mon espace de travail'],['de','Mein Arbeitsbereich']]){await picker.selectOption(id);await page.getByRole('heading',{name:heading,exact:true}).waitFor();assert.equal(await page.locator('html').getAttribute('lang'),id);}
 await page.reload();await page.getByRole('heading',{name:'Mein Arbeitsbereich',exact:true}).waitFor();assert.equal(await picker.inputValue(),'de');
 const other=await context.newPage();await other.goto(server.url.toString());await other.getByTestId('app-language').selectOption('ko');await page.getByRole('heading',{name:'내 작업 공간',exact:true}).waitFor();
 // Invalid stored values and removing/resetting preferences restore the safe default.
 await other.evaluate(()=>localStorage.setItem('portmanager-lang','../../not-a-language'));
 await page.waitForFunction(()=>document.documentElement.lang==='ko');
 await other.getByTestId('app-language').selectOption('en');await page.getByRole('heading',{name:'My workspace',exact:true}).waitFor();
 await other.evaluate(()=>localStorage.removeItem('portmanager-lang'));await page.getByRole('heading',{name:'내 작업 공간',exact:true}).waitFor();
 // sessionStorage events must never override a window-only choice after a failed write.
 await picker.selectOption('en');
 await page.evaluate(()=>{window.__setItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(this===localStorage&&key==='portmanager-lang')throw new DOMException('full','QuotaExceededError');return window.__setItem.call(this,key,value);};});
 await picker.selectOption('ja');await page.getByRole('heading',{name:'マイワークスペース',exact:true}).waitFor();
 await page.getByRole('status').filter({hasText:'言語をこのウィンドウに適用しました。'}).waitFor();
 await page.getByTestId('mount-late-reader').click();await page.waitForFunction(()=>document.querySelector('[data-testid="late-language"]').textContent==='ja');
 await page.getByTestId('read-request-language').click();assert.equal(await page.evaluate(()=>window.requestLanguage),'ja');
 await page.evaluate(()=>{window.dispatchEvent(new StorageEvent('storage',{key:'portmanager-lang',newValue:'en',storageArea:sessionStorage}));});
 assert.equal(await picker.inputValue(),'ja');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Storage warning fits narrow screens');
 // The next successful write clears the warning in every picker/reader.
 await page.evaluate(()=>{Storage.prototype.setItem=window.__setItem;});await picker.selectOption('fr');
 await page.waitForFunction(()=>document.querySelector('[data-testid="late-language"]').textContent==='fr');
 assert.equal(await page.getByRole('status').filter({hasText:'Langue appliquée à cette fenêtre.'}).count(),0);
 await other.getByRole('heading',{name:'Mon espace de travail',exact:true}).waitFor();
 await other.evaluate(()=>localStorage.clear());await page.getByRole('heading',{name:'내 작업 공간',exact:true}).waitFor();await other.close();
 // All new hook consumers must see a change made before their subscription effect.
 await page.getByTestId('mount-race').click();await page.waitForFunction(()=>document.querySelector('[data-testid="race-language"]').textContent==='fr');
 await page.waitForFunction(()=>document.documentElement.lang==='fr');
 // A denied localStorage getter is also supported, with no uncaught page error.
 await page.evaluate(()=>{window.__localStorage=Object.getOwnPropertyDescriptor(window,'localStorage');Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('denied','SecurityError');}});});
 await picker.selectOption('de');await page.getByRole('heading',{name:'Mein Arbeitsbereich',exact:true}).waitFor();
 await page.getByTestId('read-request-language').click();assert.equal(await page.evaluate(()=>window.requestLanguage),'de');
 await page.evaluate(()=>Object.defineProperty(window,'localStorage',window.__localStorage));
 await picker.selectOption('ko');
 // A response arriving after a language switch uses the current language too.
 await page.evaluate(()=>{window.responseDelay=250;window.failBackup=false;});
 await page.getByRole('textbox',{name:'제목',exact:true}).fill('In-flight language change');
 await page.getByRole('textbox',{name:'기억할 내용',exact:true}).fill('Keep this user text unchanged.');
 await page.getByRole('button',{name:'저장',exact:true}).click();
 await picker.selectOption('de');
 await page.waitForFunction(()=>document.querySelector('input[maxlength="200"]').value==='');
 await page.getByText('Gespeichert und in der Cloud gesichert',{exact:true}).waitFor();
 assert.equal(await page.getByText('Keep this user text unchanged.',{exact:true}).count(),1);

 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');assert.deepEqual(errors,[]);
 if(shots)await page.screenshot({path:join(shots,`${name}-${width}.png`),fullPage:true});console.log(`${name} ${width}: seven languages, persistence/windows, backup retry and layout passed`);
 }finally{await context.close();}}}finally{await browser.close();}
}}finally{await server.stop(true);}
