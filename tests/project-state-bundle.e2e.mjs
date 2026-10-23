// Actual composer, preview and HTTP client on an owned loopback fixture. No API3001, CLI, test execution or AI.
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {createServer} from 'vite';
import {mkdtemp,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {projectStateSelectionText} from '../src/projectStateBundle.ts';
const root=resolve(import.meta.dirname,'..'),scratch=await mkdtemp(join(tmpdir(),'project-state-ui-'));
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_SUPABASE_URL='https://workspace-fixture.supabase.co';process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
let vite,control;let state;
const reset=()=>{state={reads:[],prepares:[],submissions:[],starts:0,stale:false,hold:false,release:null,held:[],invalid:false};};reset();
const bundles=new Map();
const observation=(id,at)=>({id,availability:id==='tester'?'ready':id==='memory'?'unconfigured':'ready',freshness:id==='tester'?'stale':id==='memory'?'unknown':'current',observedAt:at,...(id==='tester'?{sourceProducedAt:at-30000}:{}),summary:[id==='git'?'branch main · commit abc · 2 changed · @source-data':id==='tester'?'PASS on earlier source':id==='memory'?'No configured curated memory':'One active Workroom'],limits:id==='tester'?['source fingerprint differs']:id==='workroom'?['independent observation, no transcript']:[]});
async function json(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>16384)throw Error('large request');}return JSON.parse(text);}
const respond=(res,value)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
try{
 vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir:scratch,cacheDir:join(scratch,'node_modules/.vite'),mode:'maintainer-test',logLevel:'error',plugins:[{name:'owned-state-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(req.url==='/api/agent-runtime/project-state'){
   try{const r=await json(req);if(r.operation==='preview'){
    state.reads.push(r);if(state.hold)await new Promise(resolve=>{state.held.push(resolve);state.release=()=>{state.hold=false;state.held.splice(0).forEach(fn=>fn());};});
    const at=Date.now(),bundle={id:crypto.randomUUID(),targetId:r.targetId,collectedAt:at,expiresAt:at+300000,state:state.invalid?'invalidated':'partial',observations:['git','workroom','tester',...(r.memoryQuery?['memory']:[])].map(id=>observation(id,at))};bundles.set(bundle.id,bundle);return respond(res,{success:true,bundle});
   }if(r.operation==='prepare'){state.prepares.push(r);const b=bundles.get(r.bundleId);assert.equal(b.targetId,r.targetId);return respond(res,{success:true,prepared:{bundleId:b.id,selectionHash:'a'.repeat(64),text:projectStateSelectionText(b,r.sections)}});}throw Error('Fixture refuses other operation');}catch(e){res.statusCode=400;return respond(res,{success:false,error:e.message});}
  }
  if(req.url==='/fixture/workspace'){
   let r;try{r=await json(req);}catch(error){if(req.aborted||req.destroyed)return;throw error;}const {action,thread}=r.workspace;
   if(action==='workroom.status')return respond(res,{kind:'workspace',action,workroom:{sessionId:r.workspace.sessionId,initialized:false,lastSavedAt:null,context:{usedPercent:null,observedAt:null,source:'unavailable'},save:{requestId:null,state:'idle',localSaved:false,backupSaved:false,message:''}}});
   if(action==='workroom.threads.read')return respond(res,{kind:'workspace',action,threads:state.thread});
   if(action==='workroom.threads.list')return respond(res,{kind:'workspace',action,threads:{threads:[],nextThreadId:null}});
   // A USE-role target reads its tool catalog (41acb49c). Read-only; the fixture has no USE connection.
   if(action==='workroom.threads.catalog')return respond(res,{kind:'workspace',action,threads:{catalog:{tools:[],executionReady:false,problem:'이 기기의 USE 도구 목록을 확인할 수 없습니다.'}}});
   if(action==='workroom.threads.create'||action==='workroom.threads.reply'){
    state.submissions.push(r);if(thread.projectState){assert.deepEqual(Object.keys(thread.projectState).sort(),['bundleId','sections','selectionHash']);const b=bundles.get(thread.projectState.bundleId);assert.equal(b.targetId,r.targetId);assert.ok(thread.text.includes(projectStateSelectionText(b,thread.projectState.sections)));if(state.stale)return respond(res,{kind:'workspace',action,threads:{refusal:{requestId:r.requestId,message:'대상이나 자료가 변경되었습니다. 상태를 다시 확인하세요.'}}});}
    state.starts++;const at=new Date().toISOString();state.thread={thread:{id:r.requestId,title:'Fixture task',agent:'codex',sessionId:'fixture-session',state:'running',revision:1,createdAt:at,updatedAt:at},messages:[{id:r.requestId,seq:1,role:'user',kind:'request',text:thread.text,at,delivery:'written'}],nextBefore:null};return respond(res,{kind:'workspace',action,threads:state.thread});
   }throw Error('Fixture rejects side effect: '+action);
  }
  if(req.url==='/__project-state')return respondHtml(res);
  if(req.url?.startsWith('/api/')){res.statusCode=503;return res.end('Live API blocked');}next();
 });}}],server:{host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**/*']},fs:{allow:[root,realpathSync(join(root,'node_modules')),scratch]}}});
 function respondHtml(res){res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import('/tests/fixtures/project-state/screen.tsx');</script>`);}
 await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
 await fetch(origin+'/tests/fixtures/project-state/screen.tsx').then(response=>response.text());
 for(const [name,engine]of Object.entries({chromium,webkit})){
  const browser=await engine.launch();const context=await browser.newContext({viewport:{width:1000,height:900},serviceWorkers:'block'});const page=await context.newPage();page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const draft=()=>page.getByLabel('프로젝트에 맡길 업무',{exact:true}),dialog=()=>page.getByRole('dialog'),button=label=>page.getByRole('button',{name:label,exact:true});
  const open=async()=>{await button('프로젝트 상태').click();await dialog().getByTestId('project-state-result').waitFor();};
  let visits=0;const fresh=async()=>{visits++;reset();bundles.clear();await page.goto(origin+'/__project-state');await draft().waitFor();await page.getByRole('button',{name:'업무 맡기기',exact:true}).waitFor();};
  try{
   await fresh();assert.equal(state.reads.length,0);assert.equal(state.starts,0);await draft().fill('기존 초안');await open();assert.equal(state.reads.length,1);assert.equal(state.prepares.length,0);assert.equal(state.starts,0);assert.equal(await draft().inputValue(),'기존 초안');assert.deepEqual(state.reads[0],{operation:'preview',targetId:'state-project-one'});
   const tester=dialog().locator('[data-source=tester]');await tester.getByText('조회 가능 상태',{exact:true}).waitFor();await tester.getByText('준비됨',{exact:true}).waitFor();await tester.getByText('이전 자료',{exact:true}).waitFor();await tester.getByText('source fingerprint differs',{exact:true}).waitFor();
   await dialog().getByLabel('워크룸',{exact:true}).uncheck();await dialog().getByRole('button',{name:'입력에 추가',exact:true}).click();await page.getByTestId('project-state-attached').waitFor();const added=await draft().inputValue();assert.ok(added.startsWith('기존 초안\n\n'));assert.ok(added.includes('[git]')&&added.includes('[tester]')&&!added.includes('[workroom]'));assert.deepEqual(state.prepares[0].sections,['git','tester']);assert.equal(state.starts,0);
   await page.getByLabel('기준 프로젝트',{exact:true}).selectOption('state-project-two');await draft().waitFor();assert.equal(await draft().inputValue(),'');await page.getByLabel('기준 프로젝트',{exact:true}).selectOption('state-project-one');await page.getByTestId('project-state-attached').waitFor();assert.equal(await draft().inputValue(),added);
   // IME Ctrl+Enter is never an implicit send; a deliberate button send retains proof.
   await draft().dispatchEvent('compositionstart');await draft().press('Control+Enter');assert.equal(state.submissions.length,0);await draft().dispatchEvent('compositionend');
   await draft().fill(added.replace('[git]','[edited]'));await page.getByTestId('project-state-attached').getByText(/요약이 바뀌었습니다/).waitFor();assert.equal(await button('업무 맡기기').isEnabled(),false);await draft().fill('독립 선행 문장\n'+await draft().inputValue());await draft().fill((await draft().inputValue())+'\n독립 후속 문장');await button('상태 첨부 해제').click();const detached=await draft().inputValue();assert.ok(detached.includes('독립 선행 문장')&&detached.includes('독립 후속 문장')&&detached.includes('기존 초안'));assert.ok(!detached.includes('[edited]')&&!detached.includes('<untrusted_project_state>'));
   await open();await dialog().getByRole('button',{name:'입력에 추가',exact:true}).click();await page.getByTestId('project-state-attached').waitFor();state.stale=true;await button('업무 맡기기').click();await page.getByRole('alert').filter({hasText:'대상이나 자료가 변경'}).first().waitFor();assert.equal(state.starts,0);assert.equal(state.submissions.length,1);assert.ok(state.submissions[0].workspace.thread.projectState);
   // Native dialog traps focus, closes by Escape, and restores its initiating control.
   await button('상태 첨부 해제').click();await open();await page.keyboard.press('Escape');await dialog().waitFor({state:'hidden'});assert.equal(await button('프로젝트 상태').evaluate(el=>el===document.activeElement),true);
   // Optional memory remains a distinct explicit query; draft and host launches stay untouched.
   await open();await dialog().getByLabel('관련 기억 포함',{exact:true}).check();await dialog().getByLabel('기억 검색어',{exact:true}).fill('입력 권한');await dialog().getByRole('button',{name:'상태 확인',exact:true}).click();await dialog().locator('[data-source=memory]').waitFor();assert.equal(state.reads.at(-1).memoryQuery,'입력 권한');await dialog().getByRole('button',{name:'취소',exact:true}).click();
   // Language is the existing device preference, not a component-local switch.
   await page.getByTestId('app-language').selectOption('en');await button('Project state').click();await dialog().getByText('Project state preview',{exact:true}).waitFor();await dialog().getByText('Availability',{exact:true}).first().waitFor();await dialog().getByText('Stale source',{exact:true}).waitFor();await dialog().getByRole('button',{name:'Cancel',exact:true}).click();await page.getByTestId('app-language').selectOption('ko');
   // A late read cannot attach to another target or survive cancellation/hidden UI.
   state.hold=true;await button('프로젝트 상태').click();await dialog().getByRole('status').waitFor();await dialog().getByRole('button',{name:'취소',exact:true}).click();await page.getByLabel('기준 프로젝트',{exact:true}).selectOption('state-project-two');state.release?.();await page.waitForTimeout(100);assert.equal(await page.getByTestId('project-state-result').isVisible(),false);assert.equal(await draft().inputValue(),'');
   state.hold=true;await button('프로젝트 상태').click();await dialog().getByRole('status').waitFor();await dialog().getByRole('button',{name:'취소',exact:true}).click();await button('Toggle visibility').click();state.release?.();await page.waitForTimeout(50);assert.equal(await dialog().isVisible(),false);await button('Toggle visibility').click();
   const beforeUnsupported=state.reads.length;await page.getByLabel('업무 역할',{exact:true}).selectOption('use');assert.equal(await button('프로젝트 상태').isEnabled(),false);assert.equal(state.reads.length,beforeUnsupported);await page.getByLabel('업무 역할',{exact:true}).selectOption('dev');await button('# 원격 Mac').click();await draft().waitFor();assert.equal(await button('프로젝트 상태').isEnabled(),false);assert.equal(state.reads.length,beforeUnsupported);
   await button('# 로컬 Mac').click();await draft().waitFor();state.invalid=true;await open();await dialog().getByText('대상 변경으로 무효',{exact:false}).waitFor();assert.equal(await dialog().getByRole('button',{name:'입력에 추가',exact:true}).isEnabled(),false);await page.keyboard.press('Escape');
   // Routing to another role never transfers a proofless project summary.
   await fresh();await draft().fill('사용자 요청');await open();await dialog().getByRole('button',{name:'입력에 추가',exact:true}).click();await page.getByTestId('project-state-attached').waitFor();const beforeRoute=await draft().inputValue();await draft().fill(beforeRoute+'\n@제품');await page.getByRole('group',{name:'프로젝트 호출·참고 후보'}).getByRole('button',{name:'@제품',exact:true}).click();await draft().waitFor();assert.ok(!(await draft().inputValue()).includes('<untrusted_project_state>'));assert.equal(await page.getByTestId('project-state-attached').count(),0);assert.equal(await button('프로젝트 상태').isEnabled(),false);
   // Existing byte limits keep the original draft intact on a refused append.
   await fresh();await draft().fill('x'.repeat(5990));await open();await dialog().getByRole('button',{name:'입력에 추가',exact:true}).click();await dialog().getByRole('alert').filter({hasText:'입력 한도를 넘었습니다'}).waitFor();assert.equal(await draft().inputValue(),'x'.repeat(5990));assert.equal(state.starts,0);await page.keyboard.press('Escape');
   // A valid selection reaches the original submit path once with the separate proof.
   await fresh();await draft().fill('최종 입력');await open();await dialog().getByRole('button',{name:'입력에 추가',exact:true}).click();await page.getByTestId('project-state-attached').waitFor();await button('업무 맡기기').click();await page.getByTestId('community-task-thread').waitFor();assert.equal(state.starts,1);assert.equal(state.submissions.length,1);assert.equal(state.submissions[0].workspace.thread.projectState.selectionHash,'a'.repeat(64));
   assert.deepEqual(errors,[]);console.log(`${name}: actual composer preview, selection, proof, stale refusal, memory opt-in, ko/en, IME, focus, cancellation, target switch and unsupported roles passed`);
  }catch(error){console.error('Fixture diagnostics',name,'visit',visits,errors,(await page.locator('body').textContent()).slice(0,2500));throw error;}finally{state.release?.();await context.close();await browser.close();}
 }
}finally{state.release?.();await vite?.close();await rm(scratch,{recursive:true,force:true});}
