// Project/OPS entry on a phone with no running session must open the new-task sheet.
// All transports are synthetic. Owns an ephemeral Vite server; never contacts an installed app.
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {createServer} from 'vite';
import {mkdtemp,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const root=resolve(import.meta.dirname,'..'),scratch=await mkdtemp(join(tmpdir(),'workroom-entry-'));
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_SUPABASE_URL='https://workspace-fixture.supabase.co';process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
let vite;
try{
 const plugins=[{name:'deny-live-api',configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/api/'))return next();res.statusCode=503;res.end('Fixture only');});}}];
 if(process.env.WORKROOM_ENTRY_BASELINE==='1')plugins.push({name:'entry-baseline',enforce:'pre',load(id){if(id===join(root,'src/AiTerminalPanel.tsx'))return execFileSync('git',['show','HEAD:src/AiTerminalPanel.tsx'],{cwd:root,encoding:'utf8'});}});
 vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir:scratch,cacheDir:join(scratch,'node_modules/.vite'),mode:'maintainer-test',logLevel:'error',plugins,
  server:{host:'127.0.0.1',port:0,fs:{allow:[root,realpathSync(join(root,'node_modules')),scratch]}}});
 await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
 const src=await fetch(origin+'/src/AiTerminalPanel.tsx').then(r=>r.text()),main=await fetch(origin+'/src/main.tsx').then(r=>r.text());
 const react=src.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1],dom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
 assert.ok(react&&dom);
 const html=mode=>`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
 import R from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};
 R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
 import '/src/index.css';import '/src/workspaceDesign.css';const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
 const mode=${JSON.stringify(mode)},target='entry-project-one',session={id:'entry-session-one',targetId:target,agent:'codex',state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:100,rows:28};
 window.calls=[];window.entries=[];let rows=mode==='running'?[session]:[];
 const transport=async r=>{window.calls.push(r);if(r.operation==='list'){if(mode==='failed-list')throw Error('호스트 목록 조회 실패');return {sessions:rows};}if(r.operation==='read')return {session,chunks:[],nextCursor:r.after??0};if(r.operation==='start'){rows=[session];return {session};}throw Error('fixture: unsupported');};
 function Harness(){const [entry,setEntry]=React.useState({nonce:1,targetId:target,...(mode==='plain'?{}:{resumeLatest:true})});window.enter=next=>setEntry(next);return React.createElement(AiTerminalPanel,{projects:[{targetId:target,label:'아젠투지 프로젝트'},{targetId:'entry-project-two',label:'두번째 프로젝트'}],transport,workspaceTransport:async()=>{throw Error('fixture: no memory');},entry,remote:true,sessionFullscreen:true,sessionScope:'entry-'+mode,visible:true,onScreen:true});}
 ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));</script>`;
 for(const [name,engine] of Object.entries({webkit,chromium})){
  const browser=await engine.launch();try{
   for(const mode of ['empty','plain','running','failed-list']){
    const context=await browser.newContext({viewport:{width:402,height:874},hasTouch:true,isMobile:true,serviceWorkers:'block'});
    try{
     await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin)return route.abort();if(u.pathname==='/__entry')return route.fulfill({contentType:'text/html',body:html(mode)});if(u.pathname.startsWith('/api/'))return route.fulfill({status:404,json:{error:'fixture'}});return route.continue();});
     const page=await context.newPage();await page.goto(origin+'/__entry');
     const sheet=page.getByTestId('workroom-new-task-sheet'),view=page.getByTestId('workroom-session-view');
     if(mode==='running'){
      await view.waitFor();assert.equal(await sheet.count(),0);
      await page.evaluate(()=>window.enter({nonce:2,targetId:'entry-project-two',resumeLatest:true}));
      await sheet.waitFor();assert.equal(await page.getByLabel('터미널 프로젝트').inputValue(),'entry-project-two');
      await page.waitForFunction(()=>!history.state?.workroomSessionView);assert.equal(await sheet.isVisible(),true);
      await page.getByTestId('workroom-new-task-close').click();await sheet.waitFor({state:'detached'});assert.equal(await view.count(),0);
     }else if(mode==='failed-list'){
      await page.getByRole('alert').filter({hasText:'호스트 목록 조회 실패'}).first().waitFor({timeout:4000}).catch(async e=>{console.log('FAILED LIST BODY:',await page.locator('body').innerText());throw e;});assert.equal(await sheet.count(),0);
     }else{
      await sheet.waitFor({timeout:6000});assert.equal(await page.getByLabel('터미널 프로젝트').inputValue(),'entry-project-one');
     }
     assert.equal(await page.evaluate(()=>window.calls.filter(r=>r.operation==='start').length),0,'Opening a project never starts a paid AI');
     console.log(`${name} ${mode}: passed`);
    }finally{await context.close();}
   }
  }finally{await browser.close();}
 }
}finally{await vite?.close();await rm(scratch,{recursive:true,force:true});}
