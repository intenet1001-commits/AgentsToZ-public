import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {createOpsRequestDispatch,handleOpsRequestMcpHttp} from '../src/opsRequestDispatch';
import {OpsRequestHost,callerOpsRequestDispatch} from '../src/opsRequestHost';
import {parseWorkroomCallerHint} from '../src/workroomCaller';import {OpsRequestStore} from '../src/opsRequestStore';
const roots:string[]=[];afterEach(()=>{roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true}));});
const endpoint='40000000-0000-4000-8000-000000000001';
test('Codex, Claude, Hermes and agy MCP clients submit, wait and get the same receiving OPS result over HTTP',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ops-mcp-http-'));roots.push(root);const token='a'.repeat(64);
  mkdirSync(join(root,'control-profile'));writeFileSync(join(root,'control-profile','access.json'),JSON.stringify({schemaVersion:1,profileId:crypto.randomUUID(),token}),{mode:0o600});
  const launch:{prompt:string;requestId:string;agent:string}[]=[];
  const host=new OpsRequestHost({store:new OpsRequestStore(root,{read:async()=>Buffer.alloc(32,1),create:async()=>Buffer.alloc(32,1)}),
    binding:()=>({scope:'one-profile',targetId:'registered_ops',agent:'hermes'}),peerActive:async()=>true,
    start:async input=>{launch.push(input);return {id:'session_'+launch.length,targetId:input.targetId,agent:input.agent,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:80,rows:24};},
    inspect:async()=>({state:'running',awaitingAnswer:false})});
  const dispatch=createOpsRequestDispatch({host,devices:async()=>({inside:true,devices:[{endpointId:endpoint,deviceId:'target',displayName:'2호',kind:'ops'}]}),
    call:async(_e,request)=>({ok:true,body:{receipt:await host.receive(request,{endpointId:endpoint,deviceId:'source',name:'1호'})}})});
  let unauthorized=0;
  const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:req=>new URL(req.url).pathname==='/api/agent-dialogue/ops-mcp'
    ?handleOpsRequestMcpHttp(req,{authorize:value=>{if(value!==token)unauthorized++;return value===token;},dispatch}):new Response('not found',{status:404})});
  const env={APP_DATA_DIR:root,HOME:root,AGENTSTOZ_USE_ENDPOINT:`http://127.0.0.1:${server.port}/api/agentstoz-use/action`};
  const call=async(name:string,args:Record<string,unknown>)=>{
    const reply=await handleAgentsToZUseMcpRequest({id:1,method:'tools/call',params:{name,arguments:args}},env) as any;
    expect(reply.result.isError).toBe(false);return reply.result.structuredContent;
  };
  try{
    for(const agent of ['codex','claude','hermes','agy']){
      await handleAgentsToZUseMcpRequest({id:0,method:'initialize',params:{clientInfo:{name:agent}}},env);
      expect((await call('agentstoz_use_list_ops_devices',{})).devices[0].displayName).toBe('2호');
      const requestId=crypto.randomUUID();await call('agentstoz_use_submit_ops_request',{endpointId:endpoint,requestId,text:`${agent}의 상태 확인 요청`});
      await host.tick();expect(launch.at(-1)!.agent).toBe('hermes');
      const capability=launch.at(-1)!.prompt.match(/capability=([a-f0-9]{64})/)![1];
      await call('agentstoz_use_complete_ops_request',{requestId,capability,state:'completed',result:'정상 상태 확인',evidence:'대상 기기에서 실제 목록 확인'});
      const result=await call('agentstoz_use_wait_ops_request',{endpointId:endpoint,requestId,timeoutMs:0});
      expect(result.receipt.state).toBe('completed');expect(result.receipt.result).toBe('정상 상태 확인');expect(JSON.stringify(result)).not.toContain(capability);
    }
    const url=`http://127.0.0.1:${server.port}/api/agent-dialogue/ops-mcp`;
    expect((await fetch(url,{method:'POST',body:'{"operation":"devices"}'})).status).toBe(403);
    expect((await fetch(url,{method:'POST',headers:{Origin:'http://localhost:9000','X-AgentsToZ-Control-Profile':token},body:'{"operation":"devices"}'})).status).toBe(403);
    expect(unauthorized).toBeGreaterThan(0);expect(launch).toHaveLength(4);
  }finally{server.stop(true);}
});

test('an older host with no OPS protocol is an error, never a successful task receipt',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ops-mcp-old-'));roots.push(root);mkdirSync(join(root,'control-profile'));
  writeFileSync(join(root,'control-profile','access.json'),JSON.stringify({schemaVersion:1,profileId:crypto.randomUUID(),token:'a'.repeat(64)}),{mode:0o600});
  const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>Response.json({success:true})});
  try{const reply=await handleAgentsToZUseMcpRequest({id:1,method:'tools/call',params:{name:'agentstoz_use_list_ops_devices',arguments:{}}},
    {APP_DATA_DIR:root,HOME:root,AGENTSTOZ_USE_ENDPOINT:`http://127.0.0.1:${server.port}/api/agentstoz-use/action`}) as any;
    expect(reply.result.isError).toBe(true);expect(reply.result.content[0].text).toContain('업데이트');
  }finally{server.stop(true);}
});

test('a receiving OPS worker hands in its result from its own Workroom and cannot forward the task to another device',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ops-mcp-worker-'));roots.push(root);const token='b'.repeat(64);
  mkdirSync(join(root,'control-profile'));writeFileSync(join(root,'control-profile','access.json'),JSON.stringify({schemaVersion:1,profileId:crypto.randomUUID(),token}),{mode:0o600});
  const launch:{prompt:string}[]=[];
  const host=new OpsRequestHost({store:new OpsRequestStore(root,{read:async()=>Buffer.alloc(32,2),create:async()=>Buffer.alloc(32,2)}),
    binding:()=>({scope:'one-profile',targetId:'registered_ops',agent:'codex'}),peerActive:async()=>true,
    start:async input=>{launch.push(input);return {id:'worker_session_'+launch.length,targetId:input.targetId,agent:input.agent,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:80,rows:24};},
    inspect:async()=>({state:'running',awaitingAnswer:false})});
  const deps={devices:async()=>({inside:true,devices:[{endpointId:endpoint,deviceId:'target',displayName:'2호',kind:'ops' as const}]}),
    call:async(_e:string,request:Record<string,unknown>)=>({ok:true,body:{receipt:await host.receive(request,{endpointId:endpoint,deviceId:'source',name:'1호'})}})};
  // The route resolves the caller from the headers the MCP server sends, as api-server does.
  const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:req=>handleOpsRequestMcpHttp(req,{authorize:value=>value===token,
    dispatch:callerOpsRequestDispatch(host,deps,parseWorkroomCallerHint(req.headers).sessionId)})});
  const base={APP_DATA_DIR:root,HOME:root,AGENTSTOZ_USE_ENDPOINT:`http://127.0.0.1:${server.port}/api/agentstoz-use/action`};
  const call=async(env:Record<string,string>,name:string,args:Record<string,unknown>)=>
    (await handleAgentsToZUseMcpRequest({id:1,method:'tools/call',params:{name,arguments:args}},env) as any).result;
  try{
    const requestId=crypto.randomUUID();
    expect((await call(base,'agentstoz_use_submit_ops_request',{endpointId:endpoint,requestId,text:'2호 상태 확인'})).isError).toBe(false);
    await host.tick();expect(launch).toHaveLength(1);
    const worker={...base,AGENTSTOZ_WORKROOM_SESSION_ID:'worker_session_1'};
    const forwarded=await call(worker,'agentstoz_use_submit_ops_request',{endpointId:endpoint,requestId:crypto.randomUUID(),text:'다른 기기에도 똑같이 맡겨줘'});
    expect(forwarded.isError).toBe(true);expect(JSON.stringify(forwarded)).toContain('OPS_REQUEST_FORWARD_DENIED');
    // Another Workroom's session cannot hand in this task's result without the capability.
    const foreign=await call({...base,AGENTSTOZ_WORKROOM_SESSION_ID:'other_session_9'},'agentstoz_use_complete_ops_request',{requestId,state:'completed',result:'완료',evidence:'확인'});
    expect(foreign.isError).toBe(true);
    const done=await call(worker,'agentstoz_use_complete_ops_request',{requestId,state:'completed',result:'정상 상태 확인',evidence:'대상 기기에서 실제 목록 확인'});
    expect(done.isError).toBe(false);expect(done.structuredContent.receipt.state).toBe('completed');
    expect(launch).toHaveLength(1);
  }finally{server.stop(true);}
});
