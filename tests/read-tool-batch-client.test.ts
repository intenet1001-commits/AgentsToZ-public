import {expect,test} from 'bun:test';
import {
 createReadToolBatchRequester,decodeReadToolBatchResult,decodeNativeReadToolBatchResult,
 normalizeReadToolBatchRequest,readToolBatchSelectionText,READ_TOOL_BATCH_ENDPOINT,
 type ReadToolBatchRequest,type ReadToolBatchResponse,
} from '../src/readToolBatchClient';

const targetId='batch-project',threadId='existing-thread',requestId='original-request';
const start:ReadToolBatchRequest={operation:'batch.start',targetId,threadId,requestId,plan:{steps:[{id:'git',input:{operation:'project.git.read'},dependsOn:[],condition:'always'}]}};
const read:ReadToolBatchRequest={operation:'batch.read',targetId,threadId,requestId};
const observation={id:'git' as const,availability:'ready' as const,freshness:'current' as const,observedAt:10,sourceRevision:'commit-abc',summary:['branch main'],limits:['independent observation']};
const stage={id:'git',operation:'project.git.read' as const,state:'completed' as const,observedAt:10,sourceId:'git',sourceRevision:'commit-abc',availability:'ready' as const,freshness:'current' as const,outputDigest:'a'.repeat(64)};
const response=():ReadToolBatchResponse=>({success:true,batch:{runId:'run-one',threadId,requestId,targetId,owner:'local',bindingHash:'b'.repeat(64),intentHash:'c'.repeat(64),bootId:'boot-one',revision:2,createdAt:1,updatedAt:11,state:'completed',stages:[stage],payload:'unavailable'},payload:'available',result:{id:'result-one',targetId,collectedAt:10,expiresAt:300010,state:'completed',invalidated:false,stages:[stage],outputs:[{stepId:'git',operation:'project.git.read',observation}]}});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('batch request is exact, requires an existing thread ID and parses the whole DAG before transport',()=>{
 expect(normalizeReadToolBatchRequest(start)).toEqual(start);
 for(const request of [{...start,threadId:''},{...read,plan:start.plan},{...start,path:'/private'}, {...start,role:'use'}, {...start,operation:'tester.start'}, {...start,plan:{steps:[{id:'git',input:{operation:'project.git.read'},dependsOn:['missing']}]}}])expect(()=>normalizeReadToolBatchRequest(request)).toThrow();
});

test('response preserves exact owner, target, thread and request provenance and rejects unknown fields',()=>{
 expect(decodeReadToolBatchResult(response(),read)).toEqual(response());
 for(const key of ['targetId','threadId','requestId','owner'] as const){const raw=response();raw.batch[key]='other';expect(()=>decodeReadToolBatchResult(raw,read)).toThrow('INVALID_RESPONSE');}
 for(const raw of [{...response(),url:'https://example.com'}, {...response(),batch:{...response().batch,path:'/private'}}, {...response(),result:{...response().result,outputs:[{...response().result!.outputs[0],code:'eval()'}]}}, {...response(),result:{...response().result,targetId:'other'}}])expect(()=>decodeReadToolBatchResult(raw,read)).toThrow('INVALID_RESPONSE');
});

test('output operation, source section, stage identity and receipt shape cannot cross bind',()=>{
 for(const patch of [{stepId:'other'}, {operation:'tester.status.read'}, {observation:{...observation,id:'memory'}}, {latestRunId:'20261024T010203Z-1234abcd'}]){
  const raw=response();raw.result!.outputs=[{...raw.result!.outputs[0]!,...patch} as any];expect(()=>decodeReadToolBatchResult(raw,read)).toThrow('INVALID_RESPONSE');
 }
 for(const change of [(r:any)=>r.batch.stages.push(r.batch.stages[0]),(r:any)=>r.batch.revision=0,(r:any)=>r.batch.state='PASS',(r:any)=>r.result.outputs.push(r.result.outputs[0]),(r:any)=>r.result.expiresAt=1]){const raw=response();change(raw);expect(()=>decodeReadToolBatchResult(raw,read)).toThrow('INVALID_RESPONSE');}
 const unavailable=response();delete unavailable.result;unavailable.payload='unavailable';expect(decodeReadToolBatchResult(unavailable,read).payload).toBe('unavailable');
 expect(()=>decodeReadToolBatchResult({...response(),payload:'unavailable'},read)).toThrow('INVALID_RESPONSE');
});

test('web start/read/cancel use one endpoint and retain the original request ID without replay',async()=>{
 const calls:any[]=[];
 const client=createReadToolBatchRequester({native:false,fetch:(async(path,init)=>{calls.push({path,init});return Response.json(response());}) as typeof fetch});
 await client(start);await client(read);await client({...read,operation:'batch.cancel'});
 expect(calls.map(call=>JSON.parse(call.init.body).operation)).toEqual(['batch.start','batch.read','batch.cancel']);
 expect(calls.every(call=>call.path===READ_TOOL_BATCH_ENDPOINT&&JSON.parse(call.init.body).requestId===requestId)).toBe(true);
});

test('native cancellation lane stays available while a timed-out start retains its actual slot',async()=>{
 let settleStart:(value:unknown)=>void=()=>{};const calls:string[]=[];
 const client=createReadToolBatchRequester({native:true,timeoutMs:5,invoke:async(command,args)=>{
  expect(command).toBe('agent_runtime_request');expect(args.path).toBe(READ_TOOL_BATCH_ENDPOINT);
  const operation=(args.body as any).operation;calls.push(operation);
  if(operation==='batch.start')return new Promise(resolve=>{settleStart=resolve;});
  return {status:200,body:response()};
 }});
 await expect(client(start)).rejects.toThrow('TIMEOUT');
 await expect(client(start)).rejects.toThrow('BUSY');
 await client({...read,operation:'batch.cancel'});await client(read);
 expect(calls).toEqual(['batch.start','batch.cancel','batch.read']);
 settleStart({status:200,body:response()});await tick();
});

test('native read/cancel has a bounded separate slot until actual settlement',async()=>{
 let settle:(value:unknown)=>void=()=>{};const client=createReadToolBatchRequester({native:true,timeoutMs:5,invoke:async()=>new Promise(resolve=>{settle=resolve;})});
 await expect(client(read)).rejects.toThrow('TIMEOUT');await expect(client({...read,operation:'batch.cancel'})).rejects.toThrow('BUSY');settle({status:200,body:response()});await tick();
});

test('unknown transport outcome never becomes a rejected admission or triggers a replay',async()=>{
 let calls=0;const client=createReadToolBatchRequester({native:false,fetch:(async()=>{calls++;throw Error('connection lost');}) as unknown as typeof fetch});
 try{await client(start);throw Error('expected failure');}catch(error:any){expect(error.serverRejected).not.toBe(true);}
 expect(calls).toBe(1);
 try{decodeNativeReadToolBatchResult({status:409,body:{success:false,code:'READ_EXECUTION_ACCESS',error:'Access changed'}},read);throw Error('expected failure');}catch(error:any){expect(error.serverRejected).toBe(true);expect(error.code).toBe('READ_EXECUTION_ACCESS');}
 expect(()=>decodeNativeReadToolBatchResult({status:500,body:response()},read)).toThrow('INVALID_RESPONSE');
});

test('wire bounds are enforced while streaming and expanded inputs never reach transport',async()=>{
 let calls=0,cancelled=false;
 const client=createReadToolBatchRequester({native:false,fetch:(async()=>{calls++;return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(32769));},cancel(){cancelled=true;}}));}) as unknown as typeof fetch});
 await expect(client({...start,credentials:'secret'} as any)).rejects.toThrow();expect(calls).toBe(0);
 await expect(client(read)).rejects.toThrow('INVALID_RESPONSE');expect(cancelled).toBe(true);
});

test('copy is explicit, selected, bounded and includes source limitations without authorizing a model send',()=>{
 const value=response();const text=readToolBatchSelectionText(value,['git'],20);
 expect(text).toContain('<untrusted_read_tool_result>');expect(text).toContain('branch main');expect(text).toContain('freshness=current');expect(text).toContain('independent observation');
 expect(()=>readToolBatchSelectionText(value,[],20)).toThrow();expect(()=>readToolBatchSelectionText(value,['git','git'],20)).toThrow();
 expect(()=>readToolBatchSelectionText(value,['git'],300011)).toThrow('EXPIRED');
 value.result!.invalidated=true;expect(()=>readToolBatchSelectionText(value,['git'],20)).toThrow('INVALIDATED');
 const missing=response();delete missing.result;missing.payload='unavailable';expect(()=>readToolBatchSelectionText(missing,['git'],20)).toThrow('PAYLOAD');
});
