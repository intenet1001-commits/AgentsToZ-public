import {afterEach,expect,test} from 'bun:test';
import {createMetaMemoryRemoteRequester} from '../src/metaCommonMemoryRemoteClient';
import {MetaCommonMemoryRemoteHost} from '../src/metaCommonMemoryRemoteHost';
import {MetaMemoryClientError} from '../src/metaCommonMemoryClient';
import {createMobileWorkspaceGateway} from '../src/mobileWorkspaceGateway';
import {parseCommonMemoryRequest,COMMON_MEMORY_REMOTE_TARGET} from '../src/commonMemoryRequest';
import {createCommonMemoryClient} from '../src/commonMemoryClient';
import {normalizeMobileWorkspaceRequest,normalizeMobileWorkspaceResult,type MobileWorkspaceRequest,type MobileWorkspaceResult} from '../src/mobileWorkspaceProtocol';
import {COMMON_MEMORY_RPC_V2_FEATURE,META_MEMORY_REMOTE_LIMITS as limits,normalizeMetaMemoryRemoteRequest,normalizeMetaMemoryRemoteResponse,splitMetaMemoryWireText} from '../src/metaCommonMemoryRemoteProtocol';
import {encryptRemoteControlRelayEnvelope,REMOTE_CONTROL_RELAY_MAX_PLAINTEXT_BYTES} from '../src/remoteControlRelayCrypto';
import {REMOTE_CONTROL_RELAY_SCHEMA_VERSION} from '../src/remoteControlRelayContract';
import {createHash} from 'node:crypto';

const hosts:MetaCommonMemoryRemoteHost[]=[];afterEach(()=>{for(const h of hosts.splice(0))h.dispose();});
const bytes=(v:unknown)=>Buffer.byteLength(typeof v==='string'?v:JSON.stringify(v));
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const groupId='11111111-1111-4111-8111-111111111111';
// Worst case for JSON escaping: quotes, backslashes, control characters (6 escaped bytes each) and astral code points.
const WORST='"\\\u0001\u001f\n\t🙂가\u007f';

/**
 * Real host, real gateway and the real request/result normalizers on both sides. The fake only decides what the
 * executed operation returns, so every byte on the wire is the production byte.
 */
function fixture(opts:{rpcV2?:boolean;result?:(operation:string,input:any)=>unknown}={}){
  const calls:{operation:string;input:any}[]=[],wire:{request:MobileWorkspaceRequest;response?:MobileWorkspaceResult}[]=[];
  const host=new MetaCommonMemoryRemoteHost(async(_owner,raw)=>{const {operation,input}=parseCommonMemoryRequest(raw);calls.push({operation,input});return opts.result?opts.result(operation,input):{operation};});hosts.push(host);
  const gateway=createMobileWorkspaceGateway({terminal:async()=>{throw Error('terminal');},active:()=>true,resolve:async()=>[],consent:async()=>({targetIds:new Set<string>(),workspaceScopes:['common-memory.manage'],isActive:()=>true,requestOwner:'phone',executionAllowed:()=>false}),perform:async()=>{throw Error('project');},commonMemory:(r,o,a,c)=>host.perform(o,r,a,'cloud',c)});
  let hook:((r:MobileWorkspaceRequest,phase:string)=>void)|null=null,after:((r:MobileWorkspaceRequest,phase:string)=>void)|null=null;
  const transport=async(r:MobileWorkspaceRequest):Promise<MobileWorkspaceResult>=>{
    const entry:{request:MobileWorkspaceRequest;response?:MobileWorkspaceResult}={request:structuredClone(r)};wire.push(entry);
    expect(normalizeMobileWorkspaceRequest(structuredClone(r))).toEqual(r);
    const phase=r.workspace.meta!.phase;hook?.(r,phase);
    const result=await gateway(r,[],'phone') as MobileWorkspaceResult;
    normalizeMobileWorkspaceResult(structuredClone(result));entry.response=result;after?.(r,phase);return result;
  };
  const rpc=createMetaMemoryRemoteRequester(transport,'common-memory',{rpcV2:opts.rpcV2});
  return {host,rpc,calls,wire,phases:()=>wire.map(w=>w.request.workspace.meta!.phase),before:(f:typeof hook)=>{hook=f;},after:(f:typeof after)=>{after=f;},transport};
}
const big=(n:number)=>({rows:Array.from({length:n},(_,i)=>({id:i,text:'공통기억 결과 '+i+' '+WORST}))});

test('the extended feature is a distinct name and v2 frames stay under the existing envelope ceiling',()=>{
  expect(COMMON_MEMORY_RPC_V2_FEATURE).toBe('common-memory-rpc-v2');expect(limits.wireBytes).toBe(4000);expect(limits.v2WireBytes).toBeLessThanOrEqual(7600);
});

test('a v1 client against the new host is byte-identical: 4,000-byte frames, upload/execute/read and a required release',async()=>{
  const f=fixture({result:()=>big(300)}),out=await f.rpc({operation:'list'});
  expect(out.rows).toHaveLength(300);
  const phases=f.phases();expect(phases[0]).toBe('upload');expect(phases[1]).toBe('execute');expect(phases.at(-1)).toBe('release');expect(phases).not.toContain('call');
  const ready=f.wire[1]!.response!.meta!;expect(Object.keys(ready)).toEqual(['phase','rpcId','hash','count']);
  const serialized=JSON.stringify({ok:true,result:big(300)}),expected=splitMetaMemoryWireText(serialized);
  expect(ready).toEqual({phase:'ready',rpcId:(ready as any).rpcId,hash:digest(serialized),count:expected.length});
  const reads=f.wire.filter(w=>w.request.workspace.meta!.phase==='read');expect(reads).toHaveLength(expected.length);
  reads.forEach((w,i)=>{const m=w.response!.meta as any;expect(JSON.stringify(m)).toBe(JSON.stringify({phase:'chunk',rpcId:m.rpcId,hash:digest(serialized),count:expected.length,index:i,text:expected[i]}));expect(bytes(m.text)).toBeLessThanOrEqual(limits.wireBytes+2);});
  expect(f.host.size).toBe(0);
  // Without the release, a v1 transfer is retained until TTL.
  const g=fixture();g.before((r,phase)=>{if(phase==='release')throw Error('dropped');});await g.rpc({operation:'list'});expect(g.host.size).toBe(1);
});

test('a small v2 request is exactly one exchange and frees itself without release',async()=>{
  const f=fixture({rpcV2:true});expect(await f.rpc({operation:'list'})).toEqual({operation:'list'});
  expect(f.phases()).toEqual(['call']);expect(f.host.size).toBe(0);
  const result=f.wire[0]!.response!.meta as any;expect(Object.keys(result)).toEqual(['phase','rpcId','hash','count','index','text']);expect(result.count).toBe(1);
});

test('a 20 KB v2 result reads only indexes 1..n-1 and the transfer returns to 0 with no release',async()=>{
  const f=fixture({rpcV2:true,result:()=>big(400)}),out=await f.rpc({operation:'list'});
  expect(bytes(JSON.stringify(big(400)))).toBeGreaterThan(20_000);expect(out.rows).toHaveLength(400);
  const first=f.wire[0]!.response!.meta as any,reads=f.wire.slice(1);
  expect(f.phases()[0]).toBe('call');expect(reads.map(w=>(w.request.workspace.meta as any).index)).toEqual(Array.from({length:first.count-1},(_,i)=>i+1));
  expect(f.phases()).not.toContain('release');expect(f.host.size).toBe(0);
  for(const w of f.wire)expect(bytes((w.response!.meta as any).text)).toBeLessThanOrEqual(limits.v2WireBytes+2);
  // 7,600-byte frames need fewer exchanges than v1 for the same result.
  const v1=fixture({result:()=>big(400)});await v1.rpc({operation:'list'});expect(f.wire.length).toBeLessThan(v1.wire.length-2);
});

test('a large v2 request uploads all but the last chunk and carries the last one in call',async()=>{
  const f=fixture({rpcV2:true}),body={operation:'manage',input:{operation:'create',groupId,requestId:crypto.randomUUID(),scopeId:'a'.repeat(64),name:'아이폰 앱',goal:{objective:WORST.repeat(1200)},sourceMemoryIds:[]}};
  const chunks=splitMetaMemoryWireText(JSON.stringify(body),limits.v2WireBytes);expect(chunks.length).toBeGreaterThan(1);
  await f.rpc(body);expect(f.phases()).toEqual([...Array(chunks.length-1).fill('upload'),'call']);
  expect((f.wire.at(-1)!.request.workspace.meta as any).index).toBe(chunks.length-1);expect(f.calls).toHaveLength(1);expect(f.calls[0]!.input.goal.objective).toBe(WORST.repeat(1200));expect(f.host.size).toBe(0);
});

test('ten sequential v2 calls never hit the per-owner transfer limit of 4',async()=>{
  const f=fixture({rpcV2:true,result:()=>big(200)});
  for(let i=0;i<10;i++){await f.rpc({operation:'list'});expect(f.host.size).toBe(0);}
  expect(f.calls).toHaveLength(10);expect(f.phases()).not.toContain('release');
});

test('abort or an error mid-read sends release and frees the v2 transfer',async()=>{
  const f=fixture({rpcV2:true,result:()=>big(400)}),controller=new AbortController();
  f.after((_r,phase)=>{if(phase==='read')controller.abort();});
  await expect(f.rpc({operation:'list'},controller.signal)).rejects.toBeInstanceOf(MetaMemoryClientError);
  expect(f.phases().at(-1)).toBe('release');expect(f.host.size).toBe(0);
  const g=fixture({rpcV2:true,result:()=>big(400)});let reads=0;g.before((_r,phase)=>{if(phase==='read'&&++reads===2)throw Error('relay dropped');});
  await expect(g.rpc({operation:'list'})).rejects.toThrow('relay dropped');expect(g.phases().at(-1)).toBe('release');expect(g.host.size).toBe(0);
});

test('a lost call response is uncertain and the mutation is never retried',async()=>{
  const f=fixture({rpcV2:true});f.after((_r,phase)=>{if(phase==='call')throw Error('response lost after commit');});
  const body={operation:'manage',input:{operation:'create',groupId,requestId:crypto.randomUUID(),scopeId:'a'.repeat(64),name:'아이폰 앱',goal:{objective:'모바일'},sourceMemoryIds:[]}};
  let error:unknown;try{await f.rpc(body);}catch(e){error=e;}
  expect(error).toBeInstanceOf(MetaMemoryClientError);expect((error as MetaMemoryClientError).uncertain).toBe(true);
  expect(f.calls).toHaveLength(1);expect(f.phases().filter(p=>p==='call')).toHaveLength(1);expect(f.phases()).not.toContain('execute');
});

test('an old host that rejects call surfaces the error: no mutation retry, no v1 fallback, and the flag only comes from capability',async()=>{
  const f=fixture({rpcV2:true});
  // An old Mac's normalizer knows only upload/execute/read/release.
  f.before((_r,phase)=>{if(!['upload','execute','read','release'].includes(phase))throw Error('공통 기억 원격 요청 범위를 확인하세요.');});
  const body={operation:'manage',input:{operation:'create',groupId,requestId:crypto.randomUUID(),scopeId:'a'.repeat(64),name:'x',goal:{objective:'y'},sourceMemoryIds:[]}};
  await expect(f.rpc(body)).rejects.toMatchObject({uncertain:true});
  await expect(f.rpc({operation:'list'})).rejects.toThrow('범위');
  expect(f.calls).toHaveLength(0);expect(f.phases()).toEqual(['call','release','call','release']);
  // The default is v1: a phone that was not told the Mac supports v2 never sends a v2 phase.
  const v1=createMetaMemoryRemoteRequester(f.transport,'common-memory');f.before(null);await v1({operation:'list'});expect(f.phases().slice(4)).toEqual(['upload','execute','read','release']);
});

test('call errors before execution free the transfer immediately',async()=>{
  let ran=0;const host=new MetaCommonMemoryRemoteHost(async()=>{ran++;return {};});hosts.push(host);
  const text=JSON.stringify({operation:'list'}),hash=digest(text),rpcId=crypto.randomUUID();
  await host.perform('p',{phase:'upload',rpcId,hash,index:0,count:3,text:text.slice(0,4)},()=>true,'cloud');
  // A call refused before it runs answers a one-frame 409 envelope (never a thrown error), so the phone can tell it never ran.
  const refusal=(r:any)=>{expect(r.phase).toBe('result');expect(r.count).toBe(1);expect(r.hash).toBe(digest(r.text));const env=JSON.parse(r.text);expect(env.ok).toBe(false);expect(env.status).toBe(409);return env;};
  expect(refusal(await host.perform('p',{phase:'call',rpcId,hash,index:2,count:3,text:text.slice(4)},()=>true,'cloud')).error).toContain('누락');expect(host.size).toBe(0);
  const bad=JSON.stringify({operation:'list',folderPath:'/x'});
  refusal(await host.perform('p',{phase:'call',rpcId:crypto.randomUUID(),hash:digest(bad),index:0,count:1,text:bad},()=>true,'cloud'));expect(host.size).toBe(0);expect(ran).toBe(0);
  expect(()=>normalizeMetaMemoryRemoteRequest({phase:'call',rpcId,hash,index:0,count:2,text})).toThrow();
  // A repeated call for a result still held answers the same first chunk and never runs twice.
  const id=crypto.randomUUID(),payload=JSON.stringify({ok:true,result:big(400)}),host2=new MetaCommonMemoryRemoteHost(async()=>{ran++;return big(400);});hosts.push(host2);
  const first=await host2.perform('p',{phase:'call',rpcId:id,hash,index:0,count:1,text},()=>true,'cloud'),again=await host2.perform('p',{phase:'call',rpcId:id,hash,index:0,count:1,text},()=>true,'cloud');
  expect(again).toEqual(first);expect(ran).toBe(1);expect((first as any).hash).toBe(digest(payload));
});

test('concurrent calls on one requester run one at a time on both versions, and a queued abort sends nothing',async()=>{
  for(const rpcV2 of [false,true]){
    const f=fixture({rpcV2,result:()=>big(300)});
    await Promise.all([f.rpc({operation:'list'}),f.rpc({operation:'catalog'}),f.rpc({operation:'updates',input:{offset:0}})]);
    const ids=f.wire.map(w=>(w.request.workspace.meta as any).rpcId),runs=ids.filter((id,i)=>id!==ids[i-1]);expect(runs).toHaveLength(3);expect(f.host.size).toBe(0);
    const controller=new AbortController(),slow=f.rpc({operation:'list'}),queued=f.rpc({operation:'catalog'},controller.signal);const sent=f.wire.length;controller.abort();
    await expect(queued).rejects.toBeInstanceOf(MetaMemoryClientError);await slow;expect(f.calls.at(-1)!.operation).toBe('list');expect(f.calls.filter(c=>c.operation==='catalog')).toHaveLength(1);
    expect(new Set(f.wire.slice(sent).map(w=>(w.request.workspace.meta as any).rpcId)).size).toBeLessThanOrEqual(1);expect(new Set(f.wire.map(w=>(w.request.workspace.meta as any).rpcId)).size).toBe(4);
  }
});

test('worst-case escaping: every v2 chunk with its workspace wrapper fits 8,500 bytes and its relay envelope 11,000',async()=>{
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt']);
  const seal=async(payload:unknown)=>{const plaintext=new TextEncoder().encode(JSON.stringify(payload));expect(plaintext.byteLength).toBeLessThanOrEqual(REMOTE_CONTROL_RELAY_MAX_PLAINTEXT_BYTES);
    await encryptRemoteControlRelayEnvelope({key,metadata:{schemaVersion:REMOTE_CONTROL_RELAY_SCHEMA_VERSION,messageId:crypto.randomUUID(),sessionId:crypto.randomUUID(),controllerId:crypto.randomUUID(),sequence:999_999,expiresAt:'2099-08-31T12:00:00.000Z'},plaintext});};
  const text=(WORST+'\u0000\u0008\u000b\u000c\u000e'+'\\"'.repeat(3)).repeat(4000),chunks=splitMetaMemoryWireText(text,limits.v2WireBytes);
  expect(chunks.join('')).toBe(text);expect(chunks.length).toBeGreaterThan(4);
  let worstRequest=0,worstResponse=0;
  for(let i=0;i<chunks.length;i++){
    expect(bytes(chunks[i]!)).toBeLessThanOrEqual(limits.v2WireBytes+2);
    // Largest counters the protocol allows make the wrapper as long as it can be.
    const meta={phase:i===chunks.length-1?'call':'upload',rpcId:crypto.randomUUID(),hash:'f'.repeat(64),index:4094,count:4095,text:chunks[i]!} as const;
    const request:MobileWorkspaceRequest={operation:'workspace',requestId:crypto.randomUUID(),targetId:COMMON_MEMORY_REMOTE_TARGET,workspace:{action:'common-memory',meta}};
    worstRequest=Math.max(worstRequest,bytes(request));expect(bytes(request)).toBeLessThanOrEqual(8500);expect(normalizeMobileWorkspaceRequest(structuredClone(request))).toEqual(request);
    await seal({type:'terminal.request',sessionToken:'A'.repeat(43),request,device:'d'.repeat(16)});
    for(const phase of ['result','chunk'] as const){
      const responseMeta=phase==='result'?{phase,rpcId:meta.rpcId,hash:meta.hash,count:4095,index:0,text:chunks[i]!}:{phase,rpcId:meta.rpcId,hash:meta.hash,count:4095,index:4094,text:chunks[i]!};
      expect(normalizeMetaMemoryRemoteResponse(structuredClone(responseMeta))).toEqual(responseMeta);
      const body:MobileWorkspaceResult={kind:'workspace',action:'common-memory',meta:responseMeta};
      worstResponse=Math.max(worstResponse,bytes(body));expect(bytes(body)).toBeLessThanOrEqual(8500);normalizeMobileWorkspaceResult(structuredClone(body));
      await seal({type:'terminal.result',requestId:crypto.randomUUID(),ok:true,body});
    }
  }
  // The chunk size leaves real headroom; it was chosen from this measurement.
  expect(worstRequest).toBeLessThan(8000);expect(worstResponse).toBeLessThan(8000);
  // The host itself splits a worst-case result into frames within the same bounds.
  const f=fixture({rpcV2:true,result:()=>({text})}),out=await f.rpc({operation:'list'});expect(out.text).toBe(text);
  for(const w of f.wire){expect(bytes(w.request)).toBeLessThanOrEqual(8500);expect(bytes(w.response)).toBeLessThanOrEqual(8500);}
});

test('budget: the phone open screen is at most 4 exchanges on v2 and opening a group at most 10',async()=>{
  const pages=(op:string)=>op==='inspect'?big(400):op==='catalog'?big(60):big(40);
  for(const rpcV2 of [true,false]){
    const f=fixture({rpcV2,result:pages}),client=createCommonMemoryClient((operation,input)=>f.rpc({operation,...(input===undefined?{}:{input})}));
    await client.list();await client.updates();await client.catalog();const openScreen=f.wire.length;
    await client.inspect(groupId);await client.projectsStatus(groupId);await client.history(groupId);const openGroup=f.wire.length-openScreen;
    if(rpcV2){expect(openScreen).toBeLessThanOrEqual(4);expect(openGroup).toBeLessThanOrEqual(10);}
    else{expect(openScreen).toBeGreaterThan(4);expect(openGroup).toBeGreaterThan(10);}
    expect(f.host.size).toBe(0);
  }
});
