/** Isolated rendered Buzz setup race: no live API, memory write, or installation. */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const build=await Bun.build({entrypoints:['tests/fixtures/buzz-agent-status-race/panel.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"development"'}});
assert.equal(build.success,true,build.logs.join('\n'));
const bundle=await build.outputs[0].text();
const waiting=new Map();
const operations=new Map();
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
  const path=new URL(request.url).pathname;
  if(path==='/panel.js')return new Response(bundle,{headers:{'Content-Type':'text/javascript'}});
  if(path==='/api/buzz-agent-bootstrap/status'){
    const body=await request.json();
    assert.ok(['project-A','project-B'].includes(body.portId));
    return new Promise(resolve=>{
      const queue=waiting.get(body.portId)??[];queue.push(resolve);waiting.set(body.portId,queue);
    });
  }
  if(path==='/api/service-memory/ensure'||path==='/api/buzz-agent-bootstrap/install-codex-control'){
    const body=await request.json();assert.ok(['project-A','project-B'].includes(body.portId));
    const key=`${path}:${body.portId}`;
    return new Promise(resolve=>{const queue=operations.get(key)??[];queue.push(resolve);operations.set(key,queue);});
  }
  if(path.startsWith('/api/'))return Response.json({error:'Unexpected fixture request'},{status:500});
  return new Response('<!doctype html><html><meta charset="utf-8"><div id="root"></div><script type="module" src="/panel.js"></script></html>',{headers:{'Content-Type':'text/html'}});
}});
const project=id=>({projectId:id,projectName:id==='project-B'?'Project B':'Project A',canonicalPath:id==='project-B'?'/fixture/B':'/fixture/A',memoryId:id==='project-B'?'memory-B':'memory-A'});
const status=(id,withControl=false)=>({
  success:true,scope:'service',ready:false,appInstalled:id==='project-B',appPath:null,canonicalRoot:null,
  skillPath:null,canonicalRootReady:false,canonicalProblem:null,
  runtimes:[
    {id:'codex',label:'Codex',installed:id==='project-B',executablePath:null,configurationState:'ready',configurationProblem:null},
    {id:'claude',label:'Claude Code',installed:id==='project-A',executablePath:null,configurationState:'ready',configurationProblem:null},
  ],defaultRuntime:id==='project-B'?'codex':'claude',agentName:`Name ${id}`,
  instructions:null,project:project(id),
  serviceMemory:null,control:withControl?{endpoint:'http://127.0.0.1:3001',controllerPortId:id,actions:[],codexMcp:{serverName:'fixture',executablePath:'/fixture/codex',installed:true,ready:false,problem:null}}:null,
  serviceMemoryStatus:{exists:false,ready:false,record:null,problem:null},
  directCreateSupported:false,ownerApprovalRequired:true,
});
const waitForRequest=async id=>{
  const deadline=Date.now()+10_000;
  while(Date.now()<deadline){if(waiting.get(id)?.length)return;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.fail(`status request for ${id} never arrived`);
};
const waitForStatusQueueLength=async (id,length)=>{
  const deadline=Date.now()+10_000;
  while(Date.now()<deadline){if((waiting.get(id)?.length??0)>=length)return;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.fail(`${length} status requests for ${id} never arrived`);
};
const answer=(id,reply)=>{
  const resolve=waiting.get(id)?.shift();assert.ok(resolve,`pending ${id} status request`);
  resolve(reply instanceof Response?reply:Response.json(reply));
};
const waitForOperation=async (path,id)=>{
  const key=`${path}:${id}`;
  const deadline=Date.now()+10_000;
  while(Date.now()<deadline){if(operations.get(key)?.length)return;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.fail(`operation ${key} never arrived`);
};
const answerOperation=(path,id,reply)=>{
  const resolve=operations.get(`${path}:${id}`)?.shift();assert.ok(resolve,`pending ${path}:${id} operation`);
  resolve(reply instanceof Response?reply:Response.json(reply));
};
const browser=await chromium.launch({headless:true});
try{
  for(const late of ['success','error']){
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}`);
    await waitForRequest('project-A');
    await page.getByTestId('buzz-agent-project').selectOption('project-B');
    await waitForRequest('project-B');
    if(late==='error'){
      const oldReply=page.waitForResponse(response=>response.url().endsWith('/api/buzz-agent-bootstrap/status')&&response.request().postDataJSON().portId==='project-A');
      answer('project-A',Response.json({error:'Old project status failed'},{status:503}));
      await oldReply;
      await page.waitForTimeout(50);
      assert.equal(await page.getByText('DEV 프로젝트와 USE 운영기억 확인 중…').count(),1,'old failure cannot stop the new project loader');
      assert.equal(await page.getByRole('alert').count(),0,'old failure cannot show an error for the new project');
    }
    const newReply=page.waitForResponse(response=>response.url().endsWith('/api/buzz-agent-bootstrap/status')&&response.request().postDataJSON().portId==='project-B');
    answer('project-B',status('project-B'));await newReply;
    await page.getByText('/fixture/B',{exact:true}).waitFor();
    const name=page.getByLabel('Agent 이름 · 기기명 포함'),runtime=page.getByTestId('buzz-agent-runtime');
    assert.equal(await name.inputValue(),'Project B · Fixture Device');
    assert.equal(await runtime.inputValue(),'codex');
    if(late==='success'){
      const oldReply=page.waitForResponse(response=>response.url().endsWith('/api/buzz-agent-bootstrap/status')&&response.request().postDataJSON().portId==='project-A');
      answer('project-A',status('project-A'));await oldReply;await page.waitForTimeout(50);
    }
    assert.equal(await page.getByTestId('buzz-agent-project').inputValue(),'project-B');
    assert.equal(await page.getByText('/fixture/B',{exact:true}).count(),1,'new project status remains visible');
    assert.equal(await page.getByText('/fixture/A',{exact:true}).count(),0,'old project status stays hidden');
    assert.equal(await name.inputValue(),'Project B · Fixture Device','old response cannot replace agent name');
    assert.equal(await runtime.inputValue(),'codex','old response cannot replace runtime');
    assert.equal(await page.getByRole('alert').count(),0);
    assert.deepEqual(errors,[]);
    await context.close();
  }
  for(const operation of ['ensure','install'])for(const late of ['success','error']){
    const path=operation==='ensure'?'/api/service-memory/ensure':'/api/buzz-agent-bootstrap/install-codex-control';
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}`);
    await waitForRequest('project-A');answer('project-A',status('project-A',true));
    await page.getByText('/fixture/A',{exact:true}).waitFor();
    await page.getByTestId(operation==='ensure'?'buzz-service-memory-ensure':'agentstoz-use-install-codex-control').click();
    await waitForOperation(path,'project-A');
    await page.getByTestId('buzz-agent-project').selectOption('project-B');
    await waitForRequest('project-B');answer('project-B',status('project-B',true));
    await page.getByText('/fixture/B',{exact:true}).waitFor();
    await page.getByText('이전 프로젝트(Project A)의 설정 작업이 끝날 때까지 기다려 주세요.').waitFor();
    assert.equal(await page.getByTestId('buzz-service-memory-ensure').isDisabled(),true,'B memory action waits for the old project operation');
    assert.equal(await page.getByTestId('agentstoz-use-install-codex-control').isDisabled(),true,'B Codex control action waits for the old project operation');
    assert.equal(operations.get(`${path}:project-B`)?.length??0,0,'B mutation cannot start while A is pending');
    const requestReply=page.waitForResponse(response=>response.url().endsWith(path));
    if(late==='error')answerOperation(path,'project-A',Response.json({error:'Old project operation failed'},{status:503}));
    else if(operation==='ensure')answerOperation(path,'project-A',{success:true,created:true,project:project('project-A'),serviceMemory:{exists:true,ready:true,record:{serviceMemoryId:'old-memory',serviceKey:'default',displayName:'Project A',sourcePath:'/fixture/A/USE.md',configPath:'/fixture/A/config.json'},problem:null}});
    else answerOperation(path,'project-A',{success:true,message:'Old project installed',codexMcp:{serverName:'fixture',executablePath:'/fixture/codex',installed:true,ready:true,problem:null}});
    await requestReply;await page.waitForTimeout(50);
    assert.equal(await page.getByText('/fixture/B',{exact:true}).count(),1,`${operation} result cannot replace B status`);
    assert.equal(await page.getByText('/fixture/A',{exact:true}).count(),0,`${operation} result cannot restore A status`);
    assert.equal(await page.getByRole('alert').count(),0,`${operation} error cannot appear on B`);
    if(operation==='ensure')assert.equal(await page.getByText('USE 운영기억 미생성',{exact:true}).count(),1,'B memory remains unprepared');
    else assert.equal(await page.getByText('연결 필요',{exact:true}).count(),1,'B Codex control remains unprepared');
    await page.getByText('이전 프로젝트(Project A)의 설정 작업이 끝날 때까지 기다려 주세요.').waitFor({state:'detached'});
    const nextAction=page.getByTestId(operation==='ensure'?'buzz-service-memory-ensure':'agentstoz-use-install-codex-control');
    assert.equal(await nextAction.isEnabled(),true,'B mutation is available once A operation settles');
    await nextAction.click();
    await waitForOperation(path,'project-B');
    const newReply=page.waitForResponse(response=>response.url().endsWith(path)&&response.request().postDataJSON().portId==='project-B');
    if(operation==='ensure')answerOperation(path,'project-B',{success:true,created:true,project:project('project-B'),serviceMemory:{exists:true,ready:true,record:{serviceMemoryId:'new-memory',serviceKey:'default',displayName:'Project B',sourcePath:'/fixture/B/USE.md',configPath:'/fixture/B/config.json'},problem:null}});
    else answerOperation(path,'project-B',{success:true,message:'New project installed',codexMcp:{serverName:'fixture',executablePath:'/fixture/codex',installed:true,ready:true,problem:null}});
    await newReply;
    if(operation==='ensure')await page.getByText('/fixture/B/USE.md',{exact:true}).waitFor();
    else await page.getByText('연결됨',{exact:true}).waitFor();
    assert.deepEqual(errors,[]);
    await context.close();
  }
  for(const operation of ['ensure','install'])for(const earlyStatusError of [false,true]){
    const path=operation==='ensure'?'/api/service-memory/ensure':'/api/buzz-agent-bootstrap/install-codex-control';
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}`);
    await waitForRequest('project-A');answer('project-A',status('project-A',true));
    await page.getByText('/fixture/A',{exact:true}).waitFor();
    await page.getByTestId(operation==='ensure'?'buzz-service-memory-ensure':'agentstoz-use-install-codex-control').click();
    await waitForOperation(path,'project-A');
    await page.getByTestId('buzz-agent-project').selectOption('project-B');
    await waitForRequest('project-B');answer('project-B',status('project-B',true));
    await page.getByText('/fixture/B',{exact:true}).waitFor();
    await page.getByTestId('buzz-agent-project').selectOption('project-A');
    await waitForRequest('project-A');
    if(earlyStatusError){
      const staleReply=page.waitForResponse(response=>response.url().endsWith('/api/buzz-agent-bootstrap/status')&&response.request().postDataJSON().portId==='project-A');
      answer('project-A',Response.json({error:'Status failed while mutation was pending'},{status:503}));await staleReply;await page.waitForTimeout(50);
      assert.equal(await page.getByRole('alert').count(),0,'status error while A mutation is pending must stay hidden');
      assert.equal(await page.getByText('DEV 프로젝트와 USE 운영기억 확인 중…').count(),1,'pending A operation keeps the status loader visible');
    }
    if(operation==='ensure')answerOperation(path,'project-A',{success:true,created:true,project:project('project-A'),serviceMemory:{exists:true,ready:true,record:{serviceMemoryId:'roundtrip-memory',serviceKey:'default',displayName:'Project A',sourcePath:'/fixture/A/USE.md',configPath:'/fixture/A/config.json'},problem:null}});
    else answerOperation(path,'project-A',{success:true,message:'Project A installed',codexMcp:{serverName:'fixture',executablePath:'/fixture/codex',installed:true,ready:true,problem:null}});
    await waitForStatusQueueLength('project-A',earlyStatusError?1:2);
    if(!earlyStatusError){
      const oldStatusReply=page.waitForResponse(response=>response.url().endsWith('/api/buzz-agent-bootstrap/status')&&response.request().postDataJSON().portId==='project-A');
      answer('project-A',status('project-A',true));await oldStatusReply;
    }
    const recovered=status('project-A',true);
    if(operation==='ensure'){
      recovered.serviceMemory={serviceMemoryId:'roundtrip-memory',serviceKey:'default',displayName:'Project A',sourcePath:'/fixture/A/USE.md',configPath:'/fixture/A/config.json'};
      recovered.serviceMemoryStatus={exists:true,ready:true,record:recovered.serviceMemory,problem:null};
    }else recovered.control.codexMcp.ready=true;
    const latestStatusReply=page.waitForResponse(response=>response.url().endsWith('/api/buzz-agent-bootstrap/status')&&response.request().postDataJSON().portId==='project-A');
    answer('project-A',recovered);await latestStatusReply;
    if(operation==='ensure')await page.getByText('/fixture/A/USE.md',{exact:true}).waitFor();
    else await page.getByText('연결됨',{exact:true}).waitFor();
    assert.equal(await page.getByRole('alert').count(),0);
    assert.deepEqual(errors,[]);
    await context.close();
  }
  for(const operation of ['ensure','install'])for(const late of ['success','error']){
    const path=operation==='ensure'?'/api/service-memory/ensure':'/api/buzz-agent-bootstrap/install-codex-control';
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}`);
    await waitForRequest('project-A');answer('project-A',status('project-A',true));
    await page.getByText('/fixture/A',{exact:true}).waitFor();
    const refresh=page.getByRole('button',{name:'다시 확인'});
    await refresh.click();
    await waitForRequest('project-A');
    await page.getByTestId(operation==='ensure'?'buzz-service-memory-ensure':'agentstoz-use-install-codex-control').click();
    await waitForOperation(path,'project-A');
    const operationReply=page.waitForResponse(response=>response.url().endsWith(path));
    if(operation==='ensure')answerOperation(path,'project-A',{success:true,created:true,project:project('project-A'),serviceMemory:{exists:true,ready:true,record:{serviceMemoryId:'new-memory',serviceKey:'default',displayName:'Project A',sourcePath:'/fixture/A/USE.md',configPath:'/fixture/A/config.json'},problem:null}});
    else answerOperation(path,'project-A',{success:true,message:'Project A installed',codexMcp:{serverName:'fixture',executablePath:'/fixture/codex',installed:true,ready:true,problem:null}});
    await operationReply;
    if(operation==='ensure')await page.getByText('/fixture/A/USE.md',{exact:true}).waitFor();
    else await page.getByText('연결됨',{exact:true}).waitFor();
    assert.equal(await refresh.isEnabled(),true,'settled mutation clears invalidated Refresh spinner');
    const oldRefreshReply=page.waitForResponse(response=>response.url().endsWith('/api/buzz-agent-bootstrap/status')&&response.request().postDataJSON().portId==='project-A');
    if(late==='error')answer('project-A',Response.json({error:'Old same-project status failed'},{status:503}));
    else answer('project-A',status('project-A',true));
    await oldRefreshReply;await page.waitForTimeout(50);
    assert.equal(await page.getByRole('alert').count(),0,'old same-project Refresh error stays hidden');
    if(operation==='ensure')assert.equal(await page.getByText('/fixture/A/USE.md',{exact:true}).count(),1,'old same-project status cannot erase ready USE memory');
    else assert.equal(await page.getByText('연결됨',{exact:true}).count(),1,'old same-project status cannot erase ready Codex control');
    assert.deepEqual(errors,[]);
    await context.close();
  }
  console.log('PASS: reversed Buzz status and mutations stay bound to the project and latest state');
}finally{await browser.close();server.stop(true);}
