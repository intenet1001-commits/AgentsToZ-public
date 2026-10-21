/** Real local receipt hosts and rendered components; official installers/auth/AI replaced only at their boundary. */
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MacSetupHost} from '../src/macSetupHost.ts';
import {HelpdeskHost} from '../src/helpdeskHost.ts';
const root=mkdtempSync(join(tmpdir(),'atz-helpdesk-screen-')),output=join(import.meta.dir,'../output/playwright/helpdesk');mkdirSync(output,{recursive:true});
const build=await Bun.build({entrypoints:['tests/fixtures/helpdesk/panel.tsx'],target:'browser',format:'esm'});assert.equal(build.success,true,build.logs.join('\n'));const js=await build.outputs[0].text();
const cssFile=join(root,'app.css'),cssBuild=Bun.spawn(['./node_modules/.bin/tailwindcss','-i','src/index.css','-o',cssFile],{stdout:'ignore',stderr:'pipe'});assert.equal(await cssBuild.exited,0,await new Response(cssBuild.stderr).text());const css=readFileSync(cssFile,'utf8')+'\n'+await Promise.all(build.outputs.filter(o=>o.path.endsWith('.css')).map(o=>o.text())).then(parts=>parts.join('\n'));
const results=[];let browser;
try{
for(const [engineName,engine]of [['chromium',chromium],['webkit',webkit]])for(const width of [390,1120]){
 const dir=join(root,engineName+'-'+width),installed=new Set(),installs=[],answers=[],errors=[];let authenticated=false,loginCalls=0,loseAck=false,hold=false;
 const setup=new MacSetupHost(dir,{probe:async id=>({id,state:installed.has(id)?'installed':'missing',message:'격리 실행 확인'}),install:async id=>{installs.push(id);installed.add(id);},launch:async()=>{}},true);
 const host=new HelpdeskHost(join(dir,'helpdesk'),{check:async()=>authenticated?'ready':'signed-out',loginClaude:async()=>{loginCalls++;authenticated=true;},context:()=>({platform:'darwin'}),answer:async(p,prompt,signal)=>{answers.push({p,prompt});if(hold)await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));return '프로젝트·폴더를 열고 해당 워크룸에서 첫 업무를 시작하세요. <script>unexpected()</script>';}});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
  const path=new URL(req.url).pathname;
  if(path==='/helpdesk'){const body=await req.json();try{await host.recoverInterrupted();const v=await host.handle(body);if(body.operation==='ask'&&loseAck){loseAck=false;return Response.json({error:'응답 확인에 실패했습니다. 같은 요청 결과를 확인하세요.'},{status:503});}return Response.json(v);}catch(e){return Response.json({error:e.message},{status:409});}}
  if(path==='/setup'){const body=await req.json();try{return Response.json({success:true,...(body.operation==='status'?setup.status():await setup.act(body))});}catch(e){return Response.json({error:e.message},{status:409});}}
  if(path==='/app.js')return new Response(js,{headers:{'Content-Type':'text/javascript'}});
  return new Response(`<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body class="bg-[var(--bg)] text-[var(--ink)]"><div id="root"></div><p id="destination"></p><script type="module" src="/app.js"></script></body></html>`,{headers:{'Content-Type':'text/html'}});
 }});
 try{
  browser=await engine.launch();const page=await browser.newPage({viewport:{width,height:950}});page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await page.goto(server.url.href);
  await page.getByRole('log',{name:'헬프데스크 대화'}).getByText('안녕하세요! 아젠투지를 처음 쓰시나요?',{exact:true}).waitFor();
  assert.equal(installs.length,0);assert.equal(loginCalls,0);assert.equal(answers.length,0);await page.screenshot({path:join(output,engineName+'-'+width+'-welcome.png')});
  await page.getByRole('button',{name:'처음 설치해요',exact:true}).click();
  const start=page.getByRole('button',{name:'필요한 프로그램 한 번에 준비',exact:true});await start.waitFor();await page.screenshot({path:join(output,engineName+'-'+width+'-prepare.png')});assert.equal(installs.length,0);await start.click();await page.getByText('프로그램 실행을 확인했습니다. 다음은 사용할 서비스의 계정 인증입니다.',{exact:true}).waitFor();assert.deepEqual(installs,['git','node','codex','claude','github']);
  await page.reload();await page.getByRole('button',{name:'처음 설치해요',exact:true}).click();await start.click();await page.getByText('프로그램 실행을 확인했습니다. 다음은 사용할 서비스의 계정 인증입니다.',{exact:true}).waitFor();assert.equal(installs.length,5);
  await page.getByRole('button',{name:'도움받기',exact:true}).click();await page.getByRole('button',{name:'사용법이 궁금해요',exact:true}).click();await page.getByRole('button',{name:'첫 업무는 어디에 맡기나요?',exact:true}).click();await page.getByRole('heading',{name:'업무를 실제로 실행하는 곳',exact:true}).waitFor();assert.equal(answers.length,0);
  await page.getByRole('button',{name:'프로젝트·폴더 열기',exact:true}).click();await page.getByText('앱 화면: projects',{exact:true}).waitFor();await page.getByLabel('헬프데스크 질문').fill('인증 전 질문');await page.getByRole('button',{name:'보내기',exact:true}).click();await page.getByRole('log').getByText('AI 답변을 받으려면 Codex 또는 Claude를 연결해 주세요. 지금은 앱에 포함된 기본 안내로 도와드릴게요.',{exact:true}).waitFor();assert.equal(answers.length,0);
  await page.getByRole('button',{name:'문제가 생겼어요',exact:true}).click();await page.getByRole('button',{name:'로그인이 안 돼요',exact:true}).click();await page.getByRole('region',{name:'사용할 AI 인증'}).waitFor();await page.getByRole('button',{name:'인증·연결 다시 확인',exact:true}).click();await page.getByRole('button',{name:'Claude · 계정 연결 필요',exact:true}).click();await page.getByRole('button',{name:'Claude 공식 로그인 시작',exact:true}).click();
  await page.getByRole('button',{name:'Claude · 연결 확인됨',exact:true}).waitFor();assert.equal(loginCalls,1);assert.equal(answers.length,0);await page.getByRole('button',{name:'질문으로 돌아가기',exact:true}).click();
  const question=page.getByLabel('헬프데스크 질문'),send=page.getByRole('button',{name:'보내기',exact:true});await question.fill('프로젝트 작업을 처음 시작하려면?');await send.click();await page.getByRole('log').getByText('프로젝트·폴더를 열고 해당 워크룸에서 첫 업무를 시작하세요. <script>unexpected()</script>',{exact:true}).waitFor();
  const layout=await page.evaluate(()=>{const log=document.querySelector('[role=log]'),input=document.querySelector('textarea');return {logHeight:log.clientHeight,inputBottom:input.getBoundingClientRect().bottom,height:innerHeight}});assert.ok(layout.logHeight>200,'conversation has room to read');assert.ok(layout.inputBottom<layout.height,'composer stays visible');
  await question.fill('조합 중');await question.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});assert.equal(answers.length,1,'Korean IME Enter does not send');await question.fill('줄 하나');await question.press('Shift+Enter');assert.equal(answers.length,1,'Shift+Enter keeps a new line');assert.equal(answers.length,1);assert.equal(await page.locator('script:not([src])').count(),0);
  loseAck=true;await question.fill('기억은 어디에 저장되나요?');await send.click();await page.getByRole('alert').waitFor();assert.equal(await question.inputValue(),'기억은 어디에 저장되나요?');await page.getByRole('button',{name:'같은 요청 결과 확인',exact:true}).click();await page.waitForFunction(()=>document.querySelector('textarea')?.value==='');assert.equal(answers.length,2);
  await page.reload();await page.getByRole('log').getByText('기억은 어디에 저장되나요?',{exact:true}).waitFor();assert.equal(answers.length,2);await page.getByRole('button',{name:'AI 연결 확인',exact:true}).click();await page.getByRole('combobox').selectOption('claude');
  authenticated=false;await page.getByRole('button',{name:'AI 연결 확인',exact:true}).click();await question.fill('다시 왔는데 어디부터 보나요?');await page.getByRole('button',{name:'보내기',exact:true}).click();assert.equal(answers.length,2);assert.ok((await page.getByRole('log').innerText()).endsWith('AI 연결하기'),'new local guidance follows old answers');
  await page.getByRole('button',{name:'사용법이 궁금해요',exact:true}).click();assert.ok((await page.getByRole('log').innerText()).endsWith('프로젝트·폴더 열기'),'new guide follows history');
  authenticated=true;await page.getByRole('button',{name:'AI 연결 확인',exact:true}).click();
  hold=true;await question.fill('중지할 질문');await send.click();await page.getByRole('button',{name:'진행 중인 지원 요청 중지',exact:true}).click();await page.getByRole('log').getByText('중지했습니다. 자동으로 다시 보내지 않습니다.',{exact:true}).waitFor();await page.reload();await page.getByRole('log').getByText('중지할 질문',{exact:true}).waitFor();assert.equal(answers.length,3);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(errors,[]);await page.screenshot({path:join(output,engineName+'-'+width+'.png'),fullPage:true});results.push({engine:engineName,width,passed:true,journeys:['beginner-chat-first-three-intents','visible-composer','IME-and-newline-guard','batch-five-once','pre-auth-local-guide','official-login-one','explicit-AI-answer','lost-ack-readback','reopen-no-replay','cancel-owned-request','plain-text-answer','narrow-app-action']});console.log(engineName+'-'+width+': helpdesk journeys passed');
 }finally{await browser?.close();browser=null;await host.shutdown();if(setup.status().view.active)await setup.act({operation:'cancel',expectedRevision:setup.status().view.revision});server.stop(true);}
}
}finally{await browser?.close();writeFileSync(join(output,'results.json'),JSON.stringify({source:'real-host-real-components-synthetic-auth-installers-AI',results},null,2));rmSync(root,{recursive:true,force:true});}
