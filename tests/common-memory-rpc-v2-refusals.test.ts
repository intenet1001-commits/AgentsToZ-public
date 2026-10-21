// On v2 a small request is a single `call`. A refusal that provably never ran (phone offline, gateway consent or budget,
// host transfer limit) must fail cleanly, as it does on v1's first `upload`; only a lost answer to a call that may have
// run is "uncertain" (which keeps the panel's retained intent and blocks its forms).
import {afterEach,expect,test} from 'bun:test';
import {createMetaMemoryRemoteRequester} from '../src/metaCommonMemoryRemoteClient';
import {MetaCommonMemoryRemoteHost} from '../src/metaCommonMemoryRemoteHost';
import {MetaMemoryClientError} from '../src/metaCommonMemoryClient';
import {createMobileWorkspaceGateway} from '../src/mobileWorkspaceGateway';
import {parseCommonMemoryRequest} from '../src/commonMemoryRequest';
import {META_MEMORY_REMOTE_LIMITS as limits} from '../src/metaCommonMemoryRemoteProtocol';
import {normalizeMobileWorkspaceResult,type MobileWorkspaceRequest,type MobileWorkspaceResult} from '../src/mobileWorkspaceProtocol';
import {RemoteControlRelayRequestError} from '../src/remoteControlRelayController';

const hosts:MetaCommonMemoryRemoteHost[]=[];afterEach(()=>{for(const h of hosts.splice(0))h.dispose();});
const archive=()=>({operation:'manage',input:{operation:'archive',groupId:crypto.randomUUID(),requestId:crypto.randomUUID()}});
const failure=async(p:Promise<unknown>)=>{try{await p;}catch(e){expect(e).toBeInstanceOf(MetaMemoryClientError);return e as MetaMemoryClientError;}throw Error('expected a failure');};

function phoneTransport(fail:(phase:string)=>Error|null){
  const phases:string[]=[];
  const transport=async(r:MobileWorkspaceRequest):Promise<MobileWorkspaceResult>=>{const phase=r.workspace.meta!.phase;phases.push(phase);const e=fail(phase);if(e)throw e;return {kind:'workspace',action:'common-memory',meta:{phase:'released',rpcId:(r.workspace.meta as any).rpcId}} as any;};
  return {transport,phases};
}

for(const rpcV2 of [false,true]){
  test(`rpcV2=${rpcV2}: a phone-side refusal before sending is a plain failure that keeps its code`,async()=>{
    for(const make of [()=>new RemoteControlRelayRequestError('REMOTE_CONTROL_PHONE_OFFLINE','휴대폰이 오프라인입니다'),()=>new RemoteControlRelayRequestError('REMOTE_CONTROL_REQUEST_UNSENT_AHEAD','앞선 요청이 아직 휴대폰에 있습니다'),()=>new Error('REMOTE_CONTROL_ACTION_IN_PROGRESS')]){
      const {transport,phases}=phoneTransport(phase=>phase==='release'?null:make());
      const e=await failure(createMetaMemoryRemoteRequester(transport,'common-memory',{rpcV2})(archive()));
      expect(e.uncertain).toBe(false);
      expect(phases).toEqual([rpcV2?'call':'upload','release']);
      const code=(make() as any).code;if(code)expect(e.code).toBe(code);
    }
  });
}

test('v2: a held envelope or a lost answer to the call stays uncertain',async()=>{
  for(const make of [()=>new RemoteControlRelayRequestError('REMOTE_CONTROL_REQUEST_UNSENT','보관했습니다'),()=>new RemoteControlRelayRequestError('REMOTE_CONTROL_RESULT_UNREACHABLE','결과를 읽지 못했습니다'),()=>new TypeError('Load failed')]){
    const {transport}=phoneTransport(phase=>phase==='release'?null:make());
    expect((await failure(createMetaMemoryRemoteRequester(transport,'common-memory',{rpcV2:true})(archive()))).uncertain).toBe(true);
  }
});

test('v1: an execute refused on the phone never ran',async()=>{
  const {transport,phases}=phoneTransport(phase=>phase==='execute'?new RemoteControlRelayRequestError('REMOTE_CONTROL_PHONE_OFFLINE','오프라인'):null);
  const wrapped=async(r:MobileWorkspaceRequest)=>{const p=r.workspace.meta!.phase;if(p==='upload')return {kind:'workspace',action:'common-memory',meta:{phase:'uploaded',rpcId:(r.workspace.meta as any).rpcId}} as any;return transport(r);};
  const e=await failure(createMetaMemoryRemoteRequester(wrapped,'common-memory')(archive()));
  expect(e.uncertain).toBe(false);expect(phases).toEqual(['execute','release']);
});

/** Real gateway, real host, real normalizers: only consent, the budget and the executor are chosen by the test. */
function macFixture(opts:{scopes?:string[]}={}){
  let ran=0;
  const host=new MetaCommonMemoryRemoteHost(async(_o,raw)=>{parseCommonMemoryRequest(raw);ran++;return {};});hosts.push(host);
  const gateway=createMobileWorkspaceGateway({terminal:async()=>{throw Error('terminal');},active:()=>true,resolve:async()=>[],consent:async()=>({targetIds:new Set<string>(),workspaceScopes:(opts.scopes??['common-memory.manage']) as any,isActive:()=>true,requestOwner:'phone',executionAllowed:()=>false}),perform:async()=>{throw Error('project');},commonMemory:(r,o,a,c)=>host.perform(o,r,a,'cloud',c)});
  const transport=async(r:MobileWorkspaceRequest)=>{const result=await gateway(r,[],'phone') as MobileWorkspaceResult;normalizeMobileWorkspaceResult(structuredClone(result));return result;};
  return {host,transport,ran:()=>ran};
}

test('v2: missing consent on the Mac answers a refused result, not an uncertain one; v1 is unchanged',async()=>{
  const v2=macFixture({scopes:[]});
  const e=await failure(createMetaMemoryRemoteRequester(v2.transport,'common-memory',{rpcV2:true})(archive()));
  expect(e.uncertain).toBe(false);expect(e.message).toContain('공통기억 조회·관리');expect(v2.ran()).toBe(0);
  const v1=macFixture({scopes:[]});
  const old=await failure(createMetaMemoryRemoteRequester(v1.transport,'common-memory')(archive()));
  expect(old.uncertain).toBe(false);expect(old.message).toContain('공통기억 조회·관리');
});

test('v2: the per-owner request budget refusal is a plain failure',async()=>{
  const mac=macFixture(),rpc=createMetaMemoryRemoteRequester(mac.transport,'common-memory',{rpcV2:true});
  let e:MetaMemoryClientError|null=null;
  for(let i=0;i<700&&!e;i++){try{await rpc(archive());}catch(x){e=x as MetaMemoryClientError;}}
  expect(e).not.toBeNull();expect(e!.uncertain).toBe(false);expect(e!.message).toContain('모바일 조회 요청이 많습니다');
});

test("v2: the host's transfer limit refuses the call without running it",async()=>{
  const mac=macFixture();
  // Fill this owner's transfers with v1 uploads that are never executed.
  for(let i=0;i<limits.ownerRecords;i++)await mac.host.perform('phone',{phase:'upload',rpcId:crypto.randomUUID(),hash:'0'.repeat(64),index:0,count:2,text:'{'},()=>true,'cloud');
  const e=await failure(createMetaMemoryRemoteRequester(mac.transport,'common-memory',{rpcV2:true})(archive()));
  expect(e.uncertain).toBe(false);expect(e.code).toBe('META_MEMORY_REMOTE_BUSY');expect(mac.ran()).toBe(0);
});
