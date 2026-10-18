/** Repeatable React fixture; every API is synthetic and unmocked traffic is denied. No CLI or live app. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'vite';
import {chromium} from 'playwright';

const root=resolve(import.meta.dirname,'..'),scratch=await mkdtemp(join(tmpdir(),'agentstoz-history-ui-'));
const shots=process.env.WORKROOM_HISTORY_EVIDENCE_DIR||join(scratch,'evidence');await mkdir(shots,{recursive:true});
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_SUPABASE_URL='https://workspace-fixture.supabase.co';process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
let vite,browser;const results=[];
try{
  vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir:scratch,cacheDir:join(scratch,'node_modules/.vite'),mode:'maintainer-test',logLevel:'warn',plugins:[{name:'deny-live-api',configureServer(server){server.middlewares.use((request,response,next)=>{if(!request.url?.startsWith('/api/'))return next();response.statusCode=503;response.end('Unmocked fixture API rejected');});}}],server:{host:'127.0.0.1',port:0,strictPort:false,fs:{allow:[root,realpathSync(join(root,'node_modules')),scratch]},watch:{ignored:['**/.agentstoz/**']}}});
  await vite.listen();const address=vite.httpServer.address();assert.ok(address&&typeof address!=='string'&&address.port!==3001);const origin=`http://127.0.0.1:${address.port}`;
  const [source,main]=await Promise.all(['/src/AiTerminalPanel.tsx','/src/main.tsx'].map(path=>fetch(origin+path).then(response=>{assert.equal(response.status,200);return response.text();})));
  const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1],reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert.ok(react&&reactDom);
  const html=`<!doctype html><html data-app-theme="gray"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';import '/src/WorkroomSessionDirectory.css';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {WorkroomConversationPanel}=await import('/src/WorkroomConversationPanel.tsx');const root=ReactDOM.createRoot(document.getElementById('root'));
window.opened=[];window.fixture={visible:true,mount(){root.render(React.createElement('div',{className:'workroom-session-directory'},React.createElement(WorkroomConversationPanel,{visible:this.visible,query:'',projects:[{targetId:'project-target-001',label:'테스트 프로젝트'}],sessions:[],onOpen:session=>{opened.push(session);}})));}};fixture.mount();
</script></html>`;
  browser=await chromium.launch({headless:true});
  for(const width of [1280,390]){
    const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'}),requests=[],errors=[],external=[];
    let record={id:'logical-conversation-001',targetId:'project-target-001',agent:'claude',accountId:'host-default',accountLabel:'현재 CLI 계정',title:'재시작 뒤 남은 대화',createdAt:'2026-10-12T01:00:00Z',updatedAt:'2026-10-12T01:00:00Z',revision:1,archived:false,state:'detached',sessionId:'previous-session-001',binding:'verified'};
    let missing=false,completed=false,executed=null;
    const session={id:'resumed-session-001',targetId:record.targetId,agent:'claude',state:'running',createdAt:'2026-10-13T01:00:00Z',exitCode:null,cols:100,rows:30};
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.origin);return route.abort();}
      if(url.pathname==='/__history-fixture')return route.fulfill({contentType:'text/html',body:html});
      if(!url.pathname.startsWith('/api/'))return route.continue();
      assert.equal(url.pathname,'/api/agent-runtime/terminals/history');assert.equal(route.request().method(),'POST');
      const body=route.request().postDataJSON();requests.push(body);
      if(missing)return route.fulfill({status:404,json:{error:'구버전 호스트'}});
      const base={protocolVersion:'workroom-history-v1',storeInstanceId:'history-store-instance-001'};
      if(body.operation==='list')return route.fulfill({json:{...base,records:record.archived===body.archived?[record]:[],nextBefore:null}});
      if(['rename','archive','unarchive'].includes(body.operation)){
        assert.equal(body.expectedRevision,record.revision);
        record={...record,revision:record.revision+1,...(body.operation==='rename'?{title:body.title}:{archived:body.operation==='archive'})};
        return route.fulfill({json:{...base,record}});
      }
      if(body.operation==='resume.review')return route.fulfill({json:{...base,review:{id:'valid-review-id-001',available:true,reason:'',expiresAt:Date.now()+60000,revision:record.revision}}});
      if(body.operation==='resume.execute'){
        assert.equal(executed,null,'Only one execution may be sent');executed=body.requestId;record={...record,state:'running',revision:record.revision+2,sessionId:session.id};
        return route.abort('failed'); // Host accepted it; response is lost.
      }
      if(body.operation==='resume.status'){assert.equal(body.requestId,executed);return route.fulfill({json:{...base,resume:completed?{state:'completed',session}:{state:'unknown'}}});}
      throw Error('Unexpected history operation '+body.operation);
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/__history-fixture');
    const row=page.getByTestId('history-row');await row.waitFor();assert.deepEqual(requests.map(r=>r.operation),['list'],'Opening the list cannot launch or read terminal output');
    await row.getByRole('button',{name:'제목 변경',exact:true}).click();await page.getByLabel('대화 제목',{exact:true}).fill('내가 정한 대화 제목');
    assert.equal(await page.getByLabel('대화 제목',{exact:true}).evaluate(e=>getComputedStyle(e).fontSize),'16px');
    await page.getByRole('button',{name:'제목 저장',exact:true}).click();await row.getByText('내가 정한 대화 제목',{exact:true}).waitFor();
    await row.getByRole('button',{name:'보관',exact:true}).click();await row.waitFor({state:'hidden'});
    await page.getByLabel('보관한 대화 보기').check();await row.waitFor();await row.getByRole('button',{name:'목록으로 복원',exact:true}).click();await row.waitFor({state:'hidden'});
    await page.getByLabel('보관한 대화 보기').uncheck();await row.waitFor();
    await row.getByRole('button',{name:'이어 열기',exact:true}).evaluate(e=>{e.click();e.click();});
    await page.getByTestId('history-notice').getByText('재개 응답을 받지 못했습니다.',{exact:false}).waitFor();
    assert.equal(requests.filter(r=>r.operation==='resume.execute').length,1);assert.equal(requests.filter(r=>r.operation==='resume.review').length,1);
    await page.reload();await page.getByRole('button',{name:'재개 결과 확인',exact:true}).waitFor();
    assert.equal(requests.filter(r=>r.operation==='resume.execute').length,1,'Reload must not replay the lost request');
    await page.getByRole('button',{name:'재개 결과 확인',exact:true}).click();await page.getByTestId('history-notice').getByText('재개 결과를 확인해야 합니다.',{exact:false}).waitFor();
    assert.equal(requests.filter(r=>r.operation==='resume.execute').length,1);
    await page.screenshot({path:join(shots,`history-${width}-unknown.png`),fullPage:true});
    completed=true;await page.getByRole('button',{name:'재개 결과 확인',exact:true}).click();await page.waitForFunction(()=>opened.length===1);
    assert.equal(await page.evaluate(()=>opened[0].id),session.id);assert.equal(requests.filter(r=>r.operation==='resume.execute').length,1);
    assert.equal(await page.getByRole('button',{name:'재개 결과 확인',exact:true}).count(),0);
    missing=true;await page.getByRole('button',{name:'기록 새로고침',exact:true}).click();await page.getByText('구버전 호스트',{exact:false}).waitFor();
    assert.equal(await row.count(),1,'Storage/old-host failure preserves the last known metadata');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'The mobile history has no horizontal overflow');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);results.push({width,pass:true,executions:1,statusReads:2});await context.close();
  }
  console.log(JSON.stringify({ok:true,results,evidence:process.env.WORKROOM_HISTORY_EVIDENCE_DIR?shots:'temporary screenshots'},null,2));
}finally{await browser?.close();await vite?.close();await rm(scratch,{recursive:true,force:true});}
