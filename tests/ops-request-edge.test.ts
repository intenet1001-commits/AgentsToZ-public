/** Requester edge of cross-device OPS requests: the bounded wait, receiver refusals, MCP guidance and wording. */
import {describe,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// Paths are resolved from this file, not the cwd: other tests in the full suite change the working directory.
const repoFile=(file:string)=>join(import.meta.dir,'..',file);
import {communityControlRouteFailure,createOpsRequestDispatch} from '../src/opsRequestDispatch';
import {communityControlRequest} from '../src/agentDialogueControlClient';
import {AgentDialogueHostError} from '../src/agentDialogueHost';
import {createCommunityControlExecutor} from '../src/agentDialogueControl';
import {OpsRequestHost} from '../src/opsRequestHost';
import {OpsRequestStore} from '../src/opsRequestStore';
import {COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE,OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE,
  OPS_REQUEST_NOT_FOUND_MESSAGE,OpsRequestError} from '../src/opsRequestProtocol';

const endpoint='50000000-0000-4000-8000-000000000001';
const devices=async()=>({inside:true,devices:[{endpointId:endpoint,deviceId:'d',displayName:'2호',kind:'ops' as const}]});
const running=(requestId:string,updatedAt:number)=>({version:'ops-request-v1',requestId,state:'running',createdAt:0,updatedAt,windowOpened:true});
const timeout=()=>Object.assign(Error('상대 기기가 제때 답하지 않았습니다. 요청이 실행됐는지는 알 수 없습니다.'),{code:'AGENT_DIALOGUE_CONTROL_TIMEOUT'});

/** A community round trip that takes `latency` ms on a fake clock and times out like controlCall when the budget is shorter. */
function slowPeer(latency:number,answer:(requestId:string,now:number,call:number)=>Record<string,unknown>|'timeout'=(id,now)=>({ok:true,body:{receipt:running(id,now)}})){
  let now=0;const calls:{at:number;budget:number}[]=[];
  const dispatch=createOpsRequestDispatch({host:{complete:async()=>{throw Error('not used');}},devices,
    call:async(_e,request,budget)=>{
      calls.push({at:now,budget});
      if(budget<latency){now+=budget;throw timeout();}
      now+=latency;const reply=answer(String(request.requestId),now,calls.length);
      if(reply==='timeout')throw timeout();return reply;
    },
    now:()=>now,sleep:async ms=>{now+=ms;}});
  return {dispatch,calls,now:()=>now};
}

describe('OPS-5: the bounded wait never ends on a too-short call', () => {
  test('a running task with a 1.2 s round trip returns its receipt, and no call starts after the deadline', async () => {
    const requestId=crypto.randomUUID(),peer=slowPeer(1200);
    const value=await peer.dispatch({operation:'wait',endpointId:endpoint,requestId,timeoutMs:20_000});
    expect((value.receipt as any).state).toBe('running');
    expect(peer.calls.length).toBeGreaterThan(1);
    for(const call of peer.calls){expect(call.budget).toBeGreaterThanOrEqual(5000);expect(call.at).toBeLessThan(20_000);}
    expect(peer.now()).toBeLessThanOrEqual(20_000);
  });
  test('timeoutMs 0 still gives one status read a usable budget', async () => {
    const requestId=crypto.randomUUID(),peer=slowPeer(1200);
    expect(((await peer.dispatch({operation:'wait',endpointId:endpoint,requestId,timeoutMs:0})).receipt as any).state).toBe('running');
    expect(peer.calls).toHaveLength(1);
  });
  test('a later read that times out keeps the last answer; a first read that times out stays unknown', async () => {
    const requestId=crypto.randomUUID();
    const later=slowPeer(100,(id,now,call)=>call===1?{ok:true,body:{receipt:running(id,now)}}:'timeout');
    expect(((await later.dispatch({operation:'wait',endpointId:endpoint,requestId,timeoutMs:20_000})).receipt as any).state).toBe('running');
    const first=slowPeer(100,()=> 'timeout');
    await expect(first.dispatch({operation:'wait',endpointId:endpoint,requestId,timeoutMs:20_000})).rejects.toThrow('알 수 없습니다');
    // submit and status are not waits: their unknown outcome is still reported, never hidden.
    await expect(first.dispatch({operation:'status',endpointId:endpoint,requestId})).rejects.toThrow('알 수 없습니다');
  });
});

describe('OPS-12: receiver refusals keep their reason, and an old receiver means update', () => {
  const refusal=async(error:string)=>{
    const dispatch=createOpsRequestDispatch({host:{complete:async()=>{throw Error();}},devices,call:async()=>({ok:false,error})});
    return dispatch({operation:'submit',endpointId:endpoint,requestId:crypto.randomUUID(),text:'2호 상태 확인'}).then(()=>null,e=>e);
  };
  test('the exact legacy executor refusal becomes OPS_HOST_OUTDATED', async () => {
    // The message an AgentsToZ without OPS requests answers for any unknown kind (this path is unchanged since then).
    const execute=createCommunityControlExecutor({terminal:async()=>({}),workspace:async()=>({}),projects:async()=>({projects:[],opsTargetId:null,deviceName:'2호'})});
    await expect(execute({kind:'something-new'})).rejects.toThrow(OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE);
    const error=await refusal(OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE);
    expect(error).toBeInstanceOf(OpsRequestError);expect(error.code).toBe('OPS_HOST_OUTDATED');expect(error.message).toContain('업데이트');
  });
  test('the receiver\'s not-found answer keeps its code, other refusals keep their message', async () => {
    const dir=mkdtempSync(join(tmpdir(),'ops-edge-'));
    try{
      const host=new OpsRequestHost({store:new OpsRequestStore(dir,{read:async()=>Buffer.alloc(32,2),create:async()=>Buffer.alloc(32,2)}),
        binding:()=>({scope:'s',targetId:'registered_ops',agent:'claude'}),peerActive:async()=>true,
        start:async()=>{throw Error('not used');},inspect:async()=>({state:'running',awaitingAnswer:false})});
      // The constant is the receiver's real answer, not a copy that can drift from it.
      await expect(host.receive({kind:'ops-request',operation:'status',requestId:crypto.randomUUID()},{endpointId:endpoint,deviceId:'src',name:'1호'}))
        .rejects.toThrow(OPS_REQUEST_NOT_FOUND_MESSAGE);
    }finally{rmSync(dir,{recursive:true,force:true});}
    const missing=await refusal(OPS_REQUEST_NOT_FOUND_MESSAGE);
    expect(missing.code).toBe('OPS_REQUEST_NOT_FOUND');expect(missing.message).toBe(OPS_REQUEST_NOT_FOUND_MESSAGE);
    // A generic receiver answer is not proof of non-admission: neutral code, the receiver's reason kept.
    const full=await refusal('대기 중인 작업이 너무 많습니다.');
    expect(full).toBeInstanceOf(OpsRequestError);expect(full.code).toBe('OPS_REQUEST_FAILED');expect(full.message).toBe('대기 중인 작업이 너무 많습니다.');
  });
  test('the receiver\'s execution deadline and oversize answers are unknown outcomes, never a refusal', async () => {
    for(const message of [COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE]){
      const error=await refusal(message);
      expect(error).toBeInstanceOf(OpsRequestError);expect({message,code:error.code}).toEqual({message,code:'OPS_REQUEST_OUTCOME_UNKNOWN'});
      expect(error.message).toBe(message);
    }
    // The receiver answers with these exact constants (no copy that can drift).
    const source=readFileSync(repoFile('src/agentDialogueHost.ts'),'utf8');
    expect(source).toContain('COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE');expect(source).toContain('COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE');
    expect(source).not.toContain(`'${COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE}'`);expect(source).not.toContain(`'${COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE}'`);
  });
});

describe('a wait keeps the last answer only when a later read timed out', () => {
  const run=async(second:()=>never,active:()=>boolean=()=>true)=>{
    let now=0,calls=0;
    const dispatch=createOpsRequestDispatch({host:{complete:async()=>{throw Error();}},devices,
      call:async(_e,request)=>{calls++;now+=100;if(calls===1)return {ok:true,body:{receipt:running(String(request.requestId),now)}};return second();},
      now:()=>now,sleep:async ms=>{now+=ms;}});
    return dispatch({operation:'wait',endpointId:endpoint,requestId:crypto.randomUUID(),timeoutMs:20_000},active).then(v=>v,e=>e);
  };
  test('a peer that left the community is reported, not hidden behind the stale receipt', async () => {
    const error=await run(()=>{throw new AgentDialogueHostError('AGENT_DIALOGUE_CONTROL_TARGET_UNAVAILABLE','상대 기기가 커뮤니티를 떠났습니다.',409);});
    expect(error).toBeInstanceOf(Error);expect((error as any).code).toBe('AGENT_DIALOGUE_CONTROL_TARGET_UNAVAILABLE');
  });
  test('a timeout keeps the last receipt only while the caller is still authorized', async () => {
    expect(((await run(()=>{throw timeout();})) as any).receipt.state).toBe('running');
    let reads=0;
    // Authorized through both reads (entry, loop, receipt, loop), revoked while the later read was failing.
    const revoked=await run(()=>{throw timeout();},()=>++reads<=4);
    expect(revoked).toBeInstanceOf(Error);expect(String((revoked as Error).message)).toContain('권한');
  });
});

describe('the app\'s control route keeps a refusal code all the way to the composer', () => {
  const realFetch=globalThis.fetch;
  const throughRoute=async(error:unknown)=>{
    const failure=communityControlRouteFailure(error);
    globalThis.fetch=(async()=>Response.json(failure.body,{status:failure.status})) as unknown as typeof fetch;
    try{return await communityControlRequest({operation:'ops-action',request:{}}).then(()=>null,e=>e);}finally{globalThis.fetch=realFetch;}
  };
  test('an OPS refusal, a host error and an unknown error each arrive with their code', async () => {
    const missing=await throughRoute(new OpsRequestError('OPS_REQUEST_NOT_FOUND',OPS_REQUEST_NOT_FOUND_MESSAGE));
    expect({code:missing.code,message:missing.message}).toEqual({code:'OPS_REQUEST_NOT_FOUND',message:OPS_REQUEST_NOT_FOUND_MESSAGE});
    const late=await throughRoute(timeout());
    expect(late.code).toBe('AGENT_DIALOGUE_CONTROL_FAILED');
    const host=await throughRoute(new AgentDialogueHostError('AGENT_DIALOGUE_CONTROL_TIMEOUT','상대 기기가 제때 답하지 않았습니다.',504));
    expect(host.code).toBe('AGENT_DIALOGUE_CONTROL_TIMEOUT');
    expect(communityControlRouteFailure(new AgentDialogueHostError('X','y',504)).status).toBe(504);
    expect(communityControlRouteFailure(Error('secret path /Users/a')).body.error).toBe('다른 기기 제어 요청을 처리하지 못했습니다.');
  });
  test('the api route uses that function', () => {
    const source=readFileSync(repoFile('api-server.ts'),'utf8');
    const route=source.slice(source.indexOf("url.pathname==='/api/agent-dialogue/control'"));
    expect(route.slice(0,route.indexOf('\n    }\n')+1)).toContain('communityControlRouteFailure(error)');
  });
});

describe('OPS-14: wording', () => {
  test('user-facing strings use correct particles after 기기 and the glossary word 기기, not 단말', () => {
    for(const file of ['src/opsRequestDispatch.ts','src/voiceRuntimeBinding.ts','src/voiceSessionHost.ts','src/OpsRequestPanel.tsx','src/opsRequestProtocol.ts']){
      expect({file,typo:/기기을|기기과/.test(readFileSync(repoFile(file),'utf8'))}).toEqual({file,typo:false});
    }
    for(const file of ['README.md','docs/cross-device-ops.md','tests/fixtures/ops-request-screen.ts','src/OpsRequestPanel.tsx']){
      expect({file,word:readFileSync(repoFile(file),'utf8').includes('단말')}).toEqual({file,word:false});
    }
  });
});
