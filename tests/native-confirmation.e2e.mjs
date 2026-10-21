// Tauri dialog 2.4 returns Promise<boolean> from window.confirm. Real panel, synthetic runtimes only.
// Owns an ephemeral Vite server; denies all live APIs and external origins.
import assert from 'node:assert/strict';
import {chromium, webkit} from 'playwright';
import {createServer} from 'vite';
import {mkdtemp, rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';

const root=resolve(import.meta.dirname,'..'), scratch=await mkdtemp(join(tmpdir(),'native-confirmation-'));
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_SUPABASE_URL='https://fixture.invalid';process.env.VITE_SUPABASE_ANON_KEY='fixture-public';
let vite;
try {
 vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir:scratch,cacheDir:join(scratch,'node_modules/.vite'),mode:'maintainer-test',logLevel:'error',
  plugins:[{name:'deny-live-api',configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/api/'))return next();res.statusCode=503;res.end('Fixture only');});}}],
  server:{host:'127.0.0.1',port:0,fs:{allow:[root,realpathSync(join(root,'node_modules')),scratch]}}});
 await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
 const [src,main]=await Promise.all(['/src/AiTerminalPanel.tsx','/src/main.tsx'].map(path=>fetch(origin+path).then(r=>r.text())));
 const react=src.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1],dom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
 assert.ok(react&&dom);
 const html=`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
 import R from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};
 R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
 import '/src/index.css';import '/src/workspaceDesign.css';const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
 const target='confirm-project',make=id=>({id,targetId:target,agent:'codex',state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:100,rows:28});
 let rows=[make('confirm-original'),make('confirm-other')];window.calls=[];window.prompts=[];window.answers=[];
 window.confirm=message=>{window.prompts.push(message);return new Promise((resolve,reject)=>window.answers.push({resolve,reject}));};
 const transport=async r=>{window.calls.push(r);
  if(r.operation==='list')return {sessions:structuredClone(rows)};
  if(r.operation==='accounts')return {accounts:{agent:'codex',selectedAccountId:'host-default',items:[{id:'host-default',agent:'codex',label:'현재 CLI 계정',authState:'unknown',checkedAt:null,loginState:'idle'}]}};
  if(r.operation==='start'){const old=rows.find(s=>s.id===r.resumeFrom);old.state='exited';old.exitCode=143;const next=make('confirm-restarted');rows.push(next);return {session:next,resumed:true};}
  const session=rows.find(s=>s.id===r.sessionId);
  if(r.operation==='read')return {session,chunks:[],nextCursor:r.after??0};
  if(r.operation==='resize')return {session};
  throw Error('Unmocked terminal operation: '+r.operation);
 };
 function Harness(){const [entry,setEntry]=React.useState({nonce:1,targetId:target,sessionId:'confirm-original'});window.selectOther=()=>setEntry({nonce:2,targetId:target,sessionId:'confirm-other'});
  return React.createElement(AiTerminalPanel,{projects:[{targetId:target,label:'확인 검증 프로젝트'}],transport,workspaceTransport:async()=>{throw Error('Fixture: no workspace writes');},entry,visible:true,sessionScope:'confirm-fixture'});}
 ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));</script>`;
 const keyHtml=`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
 import R from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};
 R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
 import '/src/index.css';const {ProjectMemoryApiKeys}=await import('/src/ProjectMemoryApiKeys.tsx');
 window.calls=[];window.prompts=[];window.confirm=message=>{window.prompts.push(message);return new Promise(resolve=>window.answer=resolve);};
 const key={id:'key-fixture',label:'검증용 연결',token:'fixture-only',memoryIds:['memory-fixture'],expiresAt:new Date(Date.now()+86400000).toISOString(),lastUsedAt:null};
 const client=()=>({rpc:async(name,args)=>{window.calls.push({name,...args});return {data:args.p_action==='revoke'?[]:[key],error:null};}});
 ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(ProjectMemoryApiKeys,{client,supabaseUrl:'https://fixture.invalid',memories:[]}));</script>`;
 for(const [name,engine] of Object.entries({chromium,webkit})){
  const browser=await engine.launch();
  try {
   for(const outcome of ['cancel','reject','approve','selection-changed']){
    const context=await browser.newContext({viewport:{width:1100,height:1000},serviceWorkers:'block'});
    try {
     const errors=[],blocked=[];
     await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin){blocked.push(u.origin);return route.abort();}if(u.pathname==='/__confirm')return route.fulfill({contentType:'text/html',body:html});if(u.pathname.startsWith('/api/'))return route.fulfill({status:404,json:{error:'Fixture only'}});return route.continue();});
     const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/__confirm');
     const restart=page.getByTestId('workroom-restart');await restart.waitFor();
     await page.waitForFunction(()=>window.calls.some(r=>r.operation==='read'&&r.sessionId==='confirm-original'));
     await page.getByLabel('워크룸 입력',{exact:true}).fill('아직 보내지 않은 초안');
     await restart.click();await page.waitForFunction(()=>window.prompts.length===1);
     // A second event while a native reply is pending must not open another prompt or restart.
     await restart.evaluate(node=>node.click());
     await page.waitForTimeout(80);
     assert.equal(await page.evaluate(()=>window.calls.filter(r=>r.operation==='start'||r.operation==='close').length),0,`${name}/${outcome}: pending confirmation changed a runtime`);
     assert.equal(await page.evaluate(()=>window.prompts.length),1,'Only one prompt in flight');
     if(outcome==='selection-changed'){await page.evaluate(()=>window.selectOther());await page.waitForFunction(()=>window.calls.some(r=>r.operation==='read'&&r.sessionId==='confirm-other'));}
     await page.evaluate(outcome=>{const answer=window.answers[0];if(outcome==='reject')answer.reject(Error('Dialog unavailable'));else answer.resolve(outcome==='approve'||outcome==='selection-changed');},outcome);
     if(outcome==='approve'){
      await page.getByTestId('workroom-restart-notice').waitFor();
      const starts=await page.evaluate(()=>window.calls.filter(r=>r.operation==='start'));
      assert.equal(starts.length,1);assert.equal(starts[0].resumeFrom,'confirm-original');assert.equal('bypassPermissions' in starts[0],false);
     }else {
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(()=>window.calls.filter(r=>r.operation==='start'||r.operation==='close').length),0,`${name}/${outcome}: unapproved or stale answer changed a runtime`);
      if(outcome==='cancel')assert.equal(await page.getByLabel('워크룸 입력',{exact:true}).inputValue(),'아직 보내지 않은 초안');
     }
     assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);console.log(`${name} ${outcome}: passed`);
    }finally{await context.close();}
   }
   for(const approved of [false,true]){
    const context=await browser.newContext({serviceWorkers:'block'});
    try {
     const errors=[],blocked=[];
     await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin||u.pathname.startsWith('/api/')){blocked.push(u.origin+u.pathname);return route.abort();}if(u.pathname==='/__keys')return route.fulfill({contentType:'text/html',body:keyHtml});return route.continue();});
     const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/__keys');
     await page.getByRole('button',{name:'연결 키 관리',exact:true}).click();
     const revoke=page.getByRole('button',{name:'연결 해제',exact:true});await revoke.waitFor();await revoke.click();
     await page.waitForFunction(()=>window.prompts.length===1);await revoke.evaluate(node=>node.click());await page.waitForTimeout(60);
     assert.equal(await page.evaluate(()=>window.calls.filter(r=>r.p_action==='revoke').length),0,'Pending key revocation must not reach RPC');
     assert.equal(await page.evaluate(()=>window.prompts.length),1);
     await page.evaluate(approved=>window.answer(approved),approved);
     if(approved)await page.getByText('연결을 해제했습니다.',{exact:true}).waitFor();else await page.waitForTimeout(80);
     assert.equal(await page.evaluate(()=>window.calls.filter(r=>r.p_action==='revoke').length),approved?1:0);
     if(!approved)assert.equal(await revoke.count(),1,'Cancel keeps the existing key');
     assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);console.log(`${name} key revoke ${approved?'approve':'cancel'}: passed`);
    }finally{await context.close();}
   }
  }finally{await browser.close();}
 }
}finally{await vite?.close();await rm(scratch,{recursive:true,force:true});}
