import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OpsRequestStore} from '../src/opsRequestStore';
import {OpsRequestHost,opsRequestScope,opsRequestsAllowed,OPS_REQUESTS_OPT_IN_ENV} from '../src/opsRequestHost';
import {createOpsRequestDispatch} from '../src/opsRequestDispatch';
import {createCommunityControlExecutor} from '../src/agentDialogueControl';
import {normalizeOpsReceipt,parseOpsRequest} from '../src/opsRequestProtocol';
import {OPS_REQUEST_MCP_TOOLS,opsRequestMcpBody} from '../src/opsRequestMcp';
import {AGENTSTOZ_USE_MCP_TOOLS} from '../agentstoz-use-mcp-server';
import type {AiTerminalSummary} from '../src/aiTerminalProtocol';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const endpoint='10000000-0000-4000-8000-000000000001',peer='10000000-0000-4000-8000-000000000002';
const origin={endpointId:peer,deviceId:'source-device',name:'1호 · Claude'};
const provider={read:async()=>Buffer.alloc(32,8),create:async()=>Buffer.alloc(32,8)};
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'atz-ops-request-'));roots.push(dir);
  const store=new OpsRequestStore(dir,provider);
  let now=1000,scope='profile-device-ops-binding',permitted=true,awaitingAnswer=false,exited=false,lastOutputAt:number|null|undefined;
  const launches:{requestId:string;targetId:string;agent:string;prompt:string}[]=[];
  const deps={store,binding:()=>({scope,targetId:'registered_ops',agent:'claude' as const}),peerActive:async()=>permitted,
    start:async(input:typeof launches[number])=>{launches.push(input);return {id:'session_'+launches.length,targetId:input.targetId,agent:input.agent,state:'running',createdAt:new Date(now).toISOString(),exitCode:null,cols:100,rows:28} as AiTerminalSummary;},
    inspect:async()=>({state:exited?'exited' as const:'running' as const,awaitingAnswer,...(lastOutputAt===undefined?{}:{lastOutputAt})}),now:()=>now};
  const host=new OpsRequestHost(deps),requestId=crypto.randomUUID();
  const request={kind:'ops-request',operation:'submit',requestId,text:'2호의 등록 프로젝트 상태를 확인해줘.'};
  return {dir,store,deps,host,launches,requestId,request,advance:(n=3000)=>{now+=n;},rebind:()=>{scope='other-profile-device-ops';},
    output:()=>{lastOutputAt=now;},now:()=>now,
    revoke:()=>{permitted=false;},approve:()=>{permitted=true;},block:()=>{awaitingAnswer=true;},unblock:()=>{awaitingAnswer=false;},exit:()=>{exited=true;}};
}
function completion(prompt:string,requestId:string){return {requestId,capability:prompt.match(/capability=([a-f0-9]{64})/)![1]!,state:'completed',result:'등록 프로젝트 3개의 상태를 확인했습니다.',evidence:'실제 프로젝트 목록과 각 상태 응답 3건 확인.'};}

test('all MCP agents use the same tools and cannot choose the receiving AI or elevate permissions',()=>{
  for(const tool of OPS_REQUEST_MCP_TOOLS)expect(AGENTSTOZ_USE_MCP_TOOLS.some(t=>t.name===tool.name)).toBe(true);
  for(const caller of ['codex','claude','hermes','agy']){
    const body=opsRequestMcpBody('agentstoz_use_submit_ops_request',{endpointId:endpoint,requestId:crypto.randomUUID(),text:`${caller}에서 요청한 상태 조회`});
    expect(body.operation).toBe('submit');expect(body.agent).toBeUndefined();
  }
  for(const extra of [{agent:'codex'},{bypassPermissions:true},{path:'/tmp'},{shell:'whoami'}])
    expect(()=>opsRequestMcpBody('agentstoz_use_submit_ops_request',{endpointId:endpoint,requestId:crypto.randomUUID(),text:'조회',...extra})).toThrow();
});

test('receiver admission, local OPS start, local window acknowledgement and result return form one journey',async()=>{
  const f=fixture();
  const execute=createCommunityControlExecutor({terminal:async()=>{throw Error('not used');},workspace:async()=>({}),projects:async()=>({projects:[],opsTargetId:'registered_ops',deviceName:'2호'}),
    opsRequest:(request,from)=>f.host.receive(request,{...from,endpointId:from.endpointId!})});
  const dispatch=createOpsRequestDispatch({host:f.host,devices:async()=>({inside:true,devices:[{endpointId:endpoint,deviceId:'receiver',displayName:'2호',kind:'ops'}]}),
    call:async(_endpoint,request)=>({ok:true,body:await execute(request,origin)})});
  const accepted=await dispatch({operation:'submit',endpointId:endpoint,requestId:f.requestId,text:f.request.text});
  expect(normalizeOpsReceipt(accepted.receipt).state).toBe('queued');expect(f.launches).toHaveLength(0);
  await f.host.tick();expect(f.launches).toHaveLength(1);expect(f.launches[0]!.agent).toBe('claude');
  expect(f.launches[0]!.targetId).toBe('registered_ops');
  let result=await dispatch({operation:'status',endpointId:endpoint,requestId:f.requestId});
  expect(normalizeOpsReceipt(result.receipt).state).toBe('running');expect(JSON.stringify(result)).not.toContain('capability');
  const windows=await f.host.windows();expect(windows).toHaveLength(1);expect(windows[0]!.receipt.sessionId).toBe('session_1');
  expect(await f.host.windows()).toEqual([]);
  await f.host.windowOpened(windows[0]!.claimId);
  result=await dispatch({operation:'status',endpointId:endpoint,requestId:f.requestId});
  expect(normalizeOpsReceipt(result.receipt).windowOpened).toBe(true);expect(normalizeOpsReceipt(result.receipt).state).toBe('running');
  const done=completion(f.launches[0]!.prompt,f.requestId);
  await dispatch({operation:'complete',...done});
  result=await dispatch({operation:'wait',endpointId:endpoint,requestId:f.requestId,timeoutMs:0});
  expect(normalizeOpsReceipt(result.receipt)).toMatchObject({state:'completed',result:done.result,evidence:done.evidence});
  expect(JSON.stringify(result)).not.toContain(done.capability);
});

test('lost admission receipt and concurrent duplicate submissions never launch twice',async()=>{
  const f=fixture();
  await Promise.all(Array.from({length:8},()=>f.host.receive(f.request,origin)));
  await Promise.all([f.host.tick(),f.host.tick(),f.host.tick()]);
  f.advance();await f.host.receive(f.request,origin);await f.host.tick();
  expect(f.launches).toHaveLength(1);expect((await f.store.list(f.deps.binding().scope)).length).toBe(1);
  await expect(f.host.receive({...f.request,text:'다른 작업'},origin)).rejects.toThrow('같은 요청 ID');
});

test('completed results survive host/store reconstruction and do not replay',async()=>{
  const f=fixture();await f.host.receive(f.request,origin);await f.host.tick();
  const done=completion(f.launches[0]!.prompt,f.requestId);await f.host.complete(done);
  const host=new OpsRequestHost({...f.deps,store:new OpsRequestStore(f.dir,provider)});
  await host.tick();expect(f.launches).toHaveLength(1);
  const receipt=await host.receive({kind:'ops-request',operation:'status',requestId:f.requestId},origin);
  expect(receipt.state).toBe('completed');expect(receipt.result).toBe(done.result);
});

test('restart after execution began preserves an unknown outcome and never resubmits to the CLI',async()=>{
  const f=fixture();await f.host.receive(f.request,origin);await f.host.tick();
  const host=new OpsRequestHost(f.deps);await host.tick();
  expect((await host.receive(f.request,origin)).state).toBe('unknown');expect(f.launches).toHaveLength(1);
});

test('queued work survives restart, while revoked membership prevents its start',async()=>{
  const f=fixture();await f.host.receive(f.request,origin);f.revoke();
  const host=new OpsRequestHost(f.deps);await host.tick();expect(f.launches).toHaveLength(0);
  f.approve();expect((await host.receive(f.request,origin)).state).toBe('failed');
});

test('the same authenticated device can recover a result after its endpoint changes; other devices and profiles cannot',async()=>{
  const f=fixture();await f.host.receive(f.request,origin);
  expect((await f.host.receive({kind:'ops-request',operation:'status',requestId:f.requestId},{...origin,endpointId:endpoint})).state).toBe('queued');
  await expect(f.host.receive({kind:'ops-request',operation:'status',requestId:f.requestId},{...origin,deviceId:'another-device'})).rejects.toThrow('찾지 못했습니다');
  f.rebind();await f.host.tick();expect(f.launches).toHaveLength(0);
  await expect(f.host.receive({kind:'ops-request',operation:'status',requestId:f.requestId},origin)).rejects.toThrow('찾지 못했습니다');
});

test('OPS starts once per request, serializes tasks and reports approval screens without typing',async()=>{
  const f=fixture();await f.host.receive(f.request,origin);await f.host.receive({...f.request,requestId:crypto.randomUUID()},origin);
  await f.host.tick();f.block();f.advance();await f.host.tick();
  expect((await f.host.receive(f.request,origin)).state).toBe('needs-attention');expect(f.launches).toHaveLength(1);
  f.unblock();f.advance();await f.host.tick();expect((await f.host.receive(f.request,origin)).state).toBe('running');
  await f.host.complete(completion(f.launches[0]!.prompt,f.requestId));f.advance();await f.host.tick();expect(f.launches).toHaveLength(2);
});

test('a quiet or exited Workroom without a submitted result never becomes completed',async()=>{
  const f=fixture();await f.host.receive(f.request,origin);await f.host.tick();
  f.advance(60_000);await f.host.tick();expect((await f.host.receive(f.request,origin)).state).toBe('running');
  f.exit();await f.host.tick();expect((await f.host.receive(f.request,origin)).state).toBe('unknown');
});

test('an ambiguous launch failure is unknown and is never retried',async()=>{
  const f=fixture();let attempts=0;f.deps.start=async()=>{attempts++;throw Error('lost acknowledgement');};
  await f.host.receive(f.request,origin);await f.host.tick();await f.host.tick();await f.host.receive(f.request,origin);
  expect(attempts).toBe(1);expect((await f.host.receive(f.request,origin)).state).toBe('unknown');
});

test('completion needs the private execution capability, retries are immutable and it never leaves the result',async()=>{
  const f=fixture();await f.host.receive(f.request,origin);await f.host.tick();const done=completion(f.launches[0]!.prompt,f.requestId);
  await expect(f.host.complete({...done,capability:'f'.repeat(64)})).rejects.toThrow('권한');
  const input={...done,result:'처리 완료 '+done.capability};const result=await f.host.complete(input);
  expect(result.result).not.toContain(done.capability);expect(result.result).toContain('[redacted]');
  expect(await f.host.complete(input)).toEqual(result);
  await expect(f.host.complete({...done,result:'변경된 결과'})).rejects.toThrow('이미 제출한');
});

test('task text, result and return capability are encrypted at rest, and a missing key never replaces it',async()=>{
  const f=fixture();await f.host.receive(f.request,origin);await f.host.tick();const done=completion(f.launches[0]!.prompt,f.requestId);await f.host.complete(done);
  const bytes=Buffer.concat(readdirSync(f.dir).map(name=>readFileSync(join(f.dir,name))));
  for(const secret of [f.request.text,done.result,done.capability])expect(bytes.includes(Buffer.from(secret))).toBe(false);
  let created=false;const store=new OpsRequestStore(f.dir,{read:async()=>null,create:async()=>{created=true;return Buffer.alloc(32,9);}});
  await expect(store.list(f.deps.binding().scope)).rejects.toThrow('KEY_MISSING');expect(created).toBe(false);
});

test('unknown receipt versions, unsafe input and unsupported fields fail closed',()=>{
  for(const value of [{...fixture().request,text:'!ls'},{...fixture().request,text:'/command'},{...fixture().request,bypassPermissions:true},
    {...fixture().request,text:'한'.repeat(4001)},{...fixture().request,text:'unsafe\x1btext'}])expect(()=>parseOpsRequest(value)).toThrow();
  expect(()=>normalizeOpsReceipt({version:'old',requestId:crypto.randomUUID(),state:'completed'})).toThrow('상대 기기');
});

test('bounded wait polls only status with the same identity and returns the final explicit result',async()=>{
  let now=0,calls=0;const requestId=crypto.randomUUID(),requests:Record<string,unknown>[]=[];
  const dispatch=createOpsRequestDispatch({host:{complete:async()=>{throw Error();}},devices:async()=>({inside:true,devices:[{endpointId:endpoint,deviceId:'d',displayName:'2호',kind:'ops'}]}),
    call:async(_e,r)=>{requests.push(r);calls++;return {ok:true,body:{receipt:{version:'ops-request-v1',requestId,state:calls===3?'completed':'running',createdAt:0,updatedAt:now,windowOpened:true,...(calls===3?{result:'완료',evidence:'작업 확인'}:{})}}};},
    now:()=>now,sleep:async ms=>{now+=ms;}});
  expect((await dispatch({operation:'wait',endpointId:endpoint,requestId,timeoutMs:10000})).receipt).toMatchObject({state:'completed',result:'완료'});
  expect(requests).toHaveLength(3);expect(requests.every(r=>r.operation==='status'&&r.requestId===requestId)).toBe(true);
});

test('empty idle host creates no database or key and window claims retry only after their lease',async()=>{
  const f=fixture();await f.host.tick();expect(await f.host.windows()).toEqual([]);expect(readdirSync(f.dir)).toEqual([]);
  await expect(f.host.receive({kind:'ops-request',operation:'status',requestId:f.requestId},origin)).rejects.toThrow('찾지 못했습니다');
  expect(readdirSync(f.dir)).toEqual([]);
  await f.host.receive(f.request,origin);await f.host.tick();const [window]=await f.host.windows();
  expect(window).toBeDefined();expect(await f.host.windows()).toEqual([]);f.advance(30001);
  const [retried]=await f.host.windows();expect(retried!.claimId).not.toBe(window!.claimId);
  await f.host.windowOpened(window!.claimId);expect((await f.host.receive(f.request,origin)).windowOpened).toBe(false);
  await f.host.windowOpened(retried!.claimId);expect((await f.host.receive(f.request,origin)).windowOpened).toBe(true);
});

test('completed workers release their PTY after a grace period while a user-continued session remains open',async()=>{
  for(const userContinued of [false,true]){
    const f=fixture();let revision=0,closed=0;
    const host=new OpsRequestHost({...f.deps,revision:()=>revision,close:async()=>{closed++;}});
    await host.receive(f.request,origin);await host.tick();await host.complete(completion(f.launches[0]!.prompt,f.requestId));
    if(userContinued)revision++;
    await host.tick();expect(closed).toBe(0);f.advance(16000);await host.tick();await host.tick();
    expect(closed).toBe(userContinued?0:1);
    expect((await host.receive(f.request,origin)).state).toBe('completed');
  }
});

test('a blocked receiver popup can be acknowledged as an inline fallback without claiming completion or a new window',async()=>{
 const f=fixture();await f.host.receive(f.request,origin);await f.host.tick();const [window]=await f.host.windows();
 await f.host.windowOpened(window!.claimId,true);
 expect(await f.host.windows()).toEqual([]);
 expect(await f.host.receive(f.request,origin)).toMatchObject({state:'running',windowOpened:false,windowFallback:true});
});

test('queue admission is bounded and a queued task expires without executing after 24 hours',async()=>{
 // Four calling devices, each within the per-device bound, together reach the receiver's overall bound.
 const f=fixture();for(let i=0;i<32;i++)await f.host.receive({...f.request,requestId:crypto.randomUUID()},{...origin,deviceId:'source-'+i%4});
 await expect(f.host.receive(f.request,origin)).rejects.toThrow('대기 중인');
 f.advance(24*60*60_000+1);await f.host.tick();expect(f.launches).toHaveLength(0);
 expect((await f.store.list(f.deps.binding().scope)).filter(r=>r.receipt.state==='failed')).toHaveLength(1);
});

test('worst-case JSON escaping fits the CLI first prompt and credential redaction retains the result byte limit',async()=>{
 const f=fixture();await f.host.receive({...f.request,text:'\\'.repeat(10000)},{...origin,name:'한'.repeat(120)});await f.host.tick();
 expect(Buffer.byteLength(f.launches[0]!.prompt)).toBeLessThanOrEqual(24000);
 const done=completion(f.launches[0]!.prompt,f.requestId);
 const result=await f.host.complete({...done,result:'secret=x '.repeat(880),evidence:'/project-relative-file 검증'});
 expect(Buffer.byteLength(result.result!)).toBeLessThanOrEqual(8000);expect(result.result).not.toContain('secret=x');
 expect(normalizeOpsReceipt(result).state).toBe('completed');
});

// --- Hardening: identity, liveness, lock scope, retention, worker retirement and boot ownership ---

test('relocating the OPS folder or re-attaching its project keeps one request identity; profile, device and memory still isolate',async()=>{
  const location={profileId:'profile-1',memoryId:'memory-1',root:'/Users/me/AgentsToZ-Control',projectId:'registered_ops'};
  const f=fixture();f.deps.binding=()=>({scope:opsRequestScope(location,'this-device'),targetId:location.projectId,agent:'claude' as const});
  await f.host.receive(f.request,origin);await f.host.tick();expect(f.launches).toHaveLength(1);
  location.root='/Users/me/AgentsToZ-OPS';location.projectId='registered_ops_again';
  expect((await f.host.receive(f.request,origin)).state).toBe('running');
  await f.host.tick();expect(f.launches).toHaveLength(1);
  expect((await f.host.complete(completion(f.launches[0]!.prompt,f.requestId))).state).toBe('completed');
  const scope=opsRequestScope(location,'this-device');
  for(const changed of [opsRequestScope({...location,profileId:'profile-2'},'this-device'),opsRequestScope({...location,memoryId:'memory-2'},'this-device'),opsRequestScope(location,'other-device')])
    expect(changed).not.toBe(scope);
});

test('a binding change resolves the old binding\'s unfinished rows once, so they never hold the queue',async()=>{
  const f=fixture();const peers=Array.from({length:4},(_,i)=>({...origin,deviceId:'source-'+i}));
  for(let i=0;i<32;i++)await f.host.receive({...f.request,requestId:i?crypto.randomUUID():f.requestId},peers[i%4]!);
  await f.host.tick();expect(f.launches).toHaveLength(1);
  const old=f.deps.binding().scope;f.rebind();await f.host.tick();
  const rows=await f.store.list(old);
  expect(rows.find(r=>r.receipt.requestId===f.requestId)!.receipt.state).toBe('unknown');
  expect(rows.filter(r=>r.receipt.state==='failed')).toHaveLength(31);
  expect((await f.host.receive({...f.request,requestId:crypto.randomUUID()},origin)).state).toBe('queued');
  expect(f.launches).toHaveLength(1);
  // The worker of the old binding can still hand in its result.
  expect((await f.host.complete(completion(f.launches[0]!.prompt,f.requestId))).state).toBe('completed');
});

test('a worker that stops producing output without a result needs attention, then frees the queue as unknown',async()=>{
  const f=fixture();let closed=0;const host=new OpsRequestHost({...f.deps,revision:()=>0,close:async()=>{closed++;}});
  const second={...f.request,requestId:crypto.randomUUID()};
  await host.receive(f.request,origin);await host.receive(second,origin);await host.tick();expect(f.launches).toHaveLength(1);
  // A worker that keeps producing output is working, however long it takes.
  for(let i=0;i<24;i++){f.advance(5*60_000);f.output();await host.tick();}
  expect((await host.receive(f.request,origin)).state).toBe('running');
  f.advance(10*60_000-1);await host.tick();expect((await host.receive(f.request,origin)).state).toBe('running');
  f.advance(2);await host.tick();
  const quiet=await host.receive(f.request,origin);
  expect(quiet.state).toBe('needs-attention');expect(quiet.message).toContain('결과를 제출하지');expect(normalizeOpsReceipt(quiet).state).toBe('needs-attention');
  f.advance(50*60_000);await host.tick();
  const unknown=await host.receive(f.request,origin);expect(unknown.state).toBe('unknown');expect(normalizeOpsReceipt(unknown).message).toContain('다시 실행하지');
  await host.tick();expect(f.launches).toHaveLength(2);await host.tick();expect(f.launches).toHaveLength(2);
  expect(closed).toBe(0);
  expect((await host.complete(completion(f.launches[0]!.prompt,f.requestId))).state).toBe('completed');
});

test('a worker waiting for a person at a trust, approval or y/n screen keeps holding the queue past the 60-minute bound',async()=>{
  const f=fixture();let closed=0;const host=new OpsRequestHost({...f.deps,revision:()=>0,close:async()=>{closed++;}});
  for(let i=0;i<4;i++)await host.receive({...f.request,requestId:crypto.randomUUID()},origin);
  await host.receive(f.request,origin);f.block();
  // The approval screen prints nothing; an unattended night must not stack one paid CLI per queued task.
  for(let i=0;i<5;i++){await host.tick();f.advance(61*60_000);await host.tick();}
  expect(f.launches).toHaveLength(1);expect(closed).toBe(0);
  const waiting=(await f.store.list(null)).map(r=>r.receipt).filter(r=>r.state==='needs-attention');expect(waiting).toHaveLength(1);
  // The person approves the next morning: the worker resumes and is still the only one.
  f.advance(24*60*60_000);f.unblock();f.output();await host.tick();
  expect((await f.store.list(null)).map(r=>r.receipt).filter(r=>r.state==='running')).toHaveLength(1);
  // The tasks that waited past 24 hours expire unexecuted, the clean state the queue always had.
  await host.complete(completion(f.launches[0]!.prompt,f.launches[0]!.prompt.match(/요청 ID: (\S+)/)![1]!));
  for(let i=0;i<6;i++)await host.tick();
  expect(f.launches).toHaveLength(1);expect((await host.receive(f.request,origin)).state).toBe('failed');
});

test('abandoned workers that stay open are bounded; one that exits or hands in a late result frees its place',async()=>{
  const f=fixture();const closed:string[]=[],exited=new Set<string>();
  const host=new OpsRequestHost({...f.deps,revision:()=>0,close:async id=>{closed.push(id);},
    inspect:async id=>({state:exited.has(id)?'exited' as const:'running' as const,awaitingAnswer:false,lastOutputAt:null})});
  const ids=Array.from({length:3},()=>crypto.randomUUID());
  for(const requestId of ids)await host.receive({...f.request,requestId},origin);
  await host.tick();expect(f.launches).toHaveLength(1);
  f.advance(61*60_000);await host.tick();await host.tick();expect(f.launches).toHaveLength(2);
  f.advance(61*60_000);await host.tick();
  // Two abandoned CLIs are open: the third task waits instead of opening a third.
  for(let i=0;i<4;i++){f.advance(61*60_000);await host.tick();}
  expect(f.launches).toHaveLength(2);expect(closed).toEqual([]);
  exited.add('session_1');await host.tick();await host.tick();expect(f.launches).toHaveLength(3);
  // A late result on an abandoned worker retires it like any finished worker.
  expect((await host.complete(completion(f.launches[1]!.prompt,ids[1]!))).state).toBe('completed');
  f.advance(16_000);await host.tick();expect(closed).toEqual(['session_2']);
});

test('an abandoned worker a person types into belongs to that person and no longer holds a place',async()=>{
  const f=fixture();const typed=new Set<string>(),closed:string[]=[];
  const host=new OpsRequestHost({...f.deps,revision:id=>typed.has(id)?1:0,close:async id=>{closed.push(id);},
    inspect:async()=>({state:'running' as const,awaitingAnswer:false,lastOutputAt:null})});
  for(let i=0;i<3;i++)await host.receive({...f.request,requestId:crypto.randomUUID()},origin);
  await host.tick();f.advance(61*60_000);await host.tick();await host.tick();f.advance(61*60_000);await host.tick();await host.tick();
  expect(f.launches).toHaveLength(2);
  typed.add('session_2');await host.tick();expect(f.launches).toHaveLength(3);expect(closed).toEqual([]);
});

test('a slow CLI start or screen read never holds the receiver inbox',async()=>{
  const f=fixture();const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();
  const start=f.deps.start;f.deps.start=async input=>{entered.resolve();await gate.promise;return start(input);};
  const answer=(request:typeof f.request)=>Promise.race([f.host.receive(request,origin).then(r=>r.state),Bun.sleep(300).then(()=>'blocked')]);
  await f.host.receive(f.request,origin);const ticking=f.host.tick();await entered.promise;
  expect(await answer({...f.request,requestId:crypto.randomUUID()})).toBe('queued');
  expect(await answer(f.request)).toBe('starting');
  gate.resolve();await ticking;expect(f.launches).toHaveLength(1);
  const inspectGate=Promise.withResolvers<void>(),inspecting=Promise.withResolvers<void>();const inspect=f.deps.inspect;
  f.deps.inspect=async()=>{inspecting.resolve();await inspectGate.promise;return inspect();};
  const second=f.host.tick();await inspecting.promise;
  expect(await answer(f.request)).toBe('running');
  inspectGate.resolve();await second;
});

test('finished rows are kept as tombstones after 30 days, so the ledger never locks up and a pruned ID never runs again',async()=>{
  const f=fixture();await f.host.receive(f.request,origin);await f.host.tick();await f.host.complete(completion(f.launches[0]!.prompt,f.requestId));
  const scope=f.deps.binding().scope,base=f.now();
  for(let i=1;i<1000;i++)await f.store.update('filler-'+i,()=>({id:'filler-'+i,scope,origin,text:'완료된 작업',token:'0'.repeat(64),
    receipt:{version:'ops-request-v1',requestId:crypto.randomUUID(),state:'failed',createdAt:base,updatedAt:base,windowOpened:false,message:'실패'}}));
  await expect(f.host.receive({...f.request,requestId:crypto.randomUUID()},origin)).rejects.toThrow('가득');
  f.advance(31*24*60*60_000);
  expect((await f.host.receive({...f.request,requestId:crypto.randomUUID()},origin)).state).toBe('queued');
  const pruned=await f.host.receive(f.request,origin);
  expect(pruned.state).toBe('completed');expect(normalizeOpsReceipt(pruned).result).toContain('보존 기간');
  await expect(f.host.receive({...f.request,text:'다른 작업'},origin)).rejects.toThrow('같은 요청 ID');
  await f.host.tick();await f.host.tick();expect(f.launches).toHaveLength(2);
  expect(f.launches.filter(l=>l.requestId===f.launches[0]!.requestId)).toHaveLength(1);
},30_000);

test('tombstones are bounded, oldest first',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'atz-ops-request-'));roots.push(dir);
  const store=new OpsRequestStore(dir,provider,{maxTombstones:3});
  for(let i=0;i<5;i++)await store.update('row-'+i,()=>({id:'row-'+i,scope:'s',origin,text:'작업 '+i,token:'0'.repeat(64),
    receipt:{version:'ops-request-v1',requestId:crypto.randomUUID(),state:'failed',createdAt:i,updatedAt:i,windowOpened:false,message:'실패'}}));
  await store.prune(31*24*60*60_000+10);
  expect(await store.get('row-0')).toBeNull();expect(await store.get('row-1')).toBeNull();
  expect((await store.get('row-4'))!.tombstone).toBe(true);
});

test('one calling device cannot occupy the whole receiver queue',async()=>{
  const f=fixture();for(let i=0;i<8;i++)await f.host.receive({...f.request,requestId:crypto.randomUUID()},origin);
  await expect(f.host.receive({...f.request,requestId:crypto.randomUUID()},origin)).rejects.toThrow('대기 중인');
  expect((await f.host.receive({...f.request,requestId:crypto.randomUUID()},{...origin,deviceId:'another-device'})).state).toBe('queued');
});

test('workers without a recorded session never block retiring later completed workers',async()=>{
  const f=fixture();const closed:string[]=[];let lose=true;const start=f.deps.start;
  const host=new OpsRequestHost({...f.deps,start:async input=>{const s=await start(input);if(lose)throw Error('lost acknowledgement');return s;},
    revision:()=>0,close:async id=>{closed.push(id);}});
  const ids=Array.from({length:4},()=>crypto.randomUUID());
  for(const requestId of ids){await host.receive({...f.request,requestId},origin);await host.tick();}
  expect(f.launches).toHaveLength(4);
  for(const [i,requestId] of ids.entries())expect((await host.complete(completion(f.launches[i]!.prompt,requestId))).state).toBe('completed');
  lose=false;await host.receive(f.request,origin);await host.tick();
  await host.complete(completion(f.launches[4]!.prompt,f.requestId));
  f.advance(16_000);await host.tick();expect(closed).toEqual(['session_5']);
});

test('retiring a worker never starts an automatic memory save of peer-originated work',async()=>{
  const f=fixture();const options:unknown[]=[];const host=new OpsRequestHost({...f.deps,revision:()=>0,close:async(_id,option)=>{options.push(option);}});
  await host.receive(f.request,origin);await host.tick();await host.complete(completion(f.launches[0]!.prompt,f.requestId));
  f.advance(16_000);await host.tick();expect(options).toEqual([{memoryPolicy:'skip'}]);
});

test('the worker session itself can hand in its result without the capability; another session cannot',async()=>{
  const f=fixture();await f.host.receive(f.request,origin);await f.host.tick();
  const {capability:_,...result}=completion(f.launches[0]!.prompt,f.requestId);
  await expect(f.host.complete({...result,callerSessionId:'session_9'})).rejects.toThrow('권한');
  await expect(f.host.complete({...result,callerSessionId:null})).rejects.toThrow('권한');
  expect((await f.host.complete({...result,callerSessionId:'session_1'})).state).toBe('completed');
  expect((await f.host.complete({...result,capability:'f'.repeat(64),callerSessionId:'session_1'}).catch(e=>e.message))).toContain('권한');
});

test('an OPS worker session is recognized as one so it cannot forward its task to another device',async()=>{
  const f=fixture();await f.host.receive(f.request,origin);await f.host.tick();
  expect(await f.host.workerSession('session_1')).toBe(true);expect(await f.host.workerSession('session_2')).toBe(false);
  await f.host.complete(completion(f.launches[0]!.prompt,f.requestId));
  // A finished worker that a person continues owns its own lifetime and may delegate on their behalf.
  expect(await f.host.workerSession('session_1')).toBe(false);
});

test('only the installed app sidecar, or an explicit opt-in, receives and runs OPS requests',()=>{
  expect(opsRequestsAllowed({bundledSidecar:true,env:{}})).toBe(true);
  expect(opsRequestsAllowed({bundledSidecar:false,env:{}})).toBe(false);
  expect(opsRequestsAllowed({bundledSidecar:false,env:{[OPS_REQUESTS_OPT_IN_ENV]:'1'}})).toBe(true);
  expect(opsRequestsAllowed({bundledSidecar:false,env:{[OPS_REQUESTS_OPT_IN_ENV]:'true'}})).toBe(false);
  const source=readFileSync(join(import.meta.dir,'..','api-server.ts'),'utf8');
  expect(source.includes('if(OPS_REQUESTS_ENABLED)scheduleOpsRequests();')).toBe(true);
  expect(/opsRequest:async\(request,from\)=>\{if\(!OPS_REQUESTS_ENABLED\)/.test(source)).toBe(true);
});
