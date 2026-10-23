import {expect,test} from 'bun:test';
import {handleReadToolBatchRequest,READ_TOOL_BATCH_PATH,type ReadToolBatchHttpHost,type ReadToolBatchHttpOptions} from '../src/readToolBatchHttp';
import {ReadExecutionError,type ReadToolBatch} from '../src/workroomThreadReadExecution';
const plan={steps:[{id:'git',input:{operation:'project.git.read'}}]};
const identity={targetId:'project-one',threadId:'existing-thread',requestId:'stable-request'};
const input={operation:'batch.start',...identity,plan};
const batch:ReadToolBatch={runId:'run-one',...identity,owner:'local',bindingHash:'a'.repeat(64),intentHash:'b'.repeat(64),bootId:'boot-one',revision:1,createdAt:1,updatedAt:1,state:'pending',stages:[{id:'git',operation:'project.git.read',state:'pending'}],payload:'unavailable'};
function fixture(){const calls:{method:string;owner:string;input:unknown}[]=[];const host:ReadToolBatchHttpHost={start:async(owner,input)=>{calls.push({method:'start',owner,input});return {batch,payload:'unavailable'};},read:async(owner,input)=>{calls.push({method:'read',owner,input});return {batch,payload:'unavailable'};},cancel:async(owner,input)=>{calls.push({method:'cancel',owner,input});return {batch,payload:'unavailable'};}};return {host,calls};}
const request=(body:unknown,overrides:RequestInit={},url=READ_TOOL_BATCH_PATH)=>new Request('http://127.0.0.1'+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),...overrides});
const run=(req:Request,host:ReadToolBatchHttpHost,options:ReadToolBatchHttpOptions={enabled:true},owner='local')=>handleReadToolBatchRequest(req,host,owner,{},options);
test('P2 exact wire wrappers preserve immutable request identity and invoke trusted access before the host',async()=>{
 const f=fixture();let inside=false,checks=0;
 const original=f.host.start;f.host.start=async(...args)=>{expect(inside).toBe(true);expect(Object.isFrozen((args[1] as any).plan)).toBe(true);return original(...args);};
 const options:ReadToolBatchHttpOptions={enabled:true,withAccess:async(owner,i,op,_signal,execute)=>{expect(owner).toBe('local');expect(i).toEqual(identity);expect(op).toBe('batch.start');checks++;inside=true;try{return await execute();}finally{inside=false;}}};
 const response=await run(request(input),f.host,options);expect(response.status).toBe(200);expect(await response.json()).toEqual({success:true,batch,payload:'unavailable'});expect(checks).toBe(1);expect(f.calls).toHaveLength(1);expect(response.headers.get('cache-control')).toBe('private, no-store');
});
test('P2 feature-off refuses start while permitting exact existing read/cancel without plan or source work',async()=>{
 const f=fixture();expect((await run(request(input),f.host,{enabled:false})).status).toBe(503);expect(f.calls).toEqual([]);
 for(const operation of ['batch.read','batch.cancel'])expect((await run(request({operation,...identity}),f.host,{enabled:false})).status).toBe(200);
 expect(f.calls.map(c=>c.method)).toEqual(['read','cancel']);expect(f.calls.every(c=>JSON.stringify(c.input)===JSON.stringify(identity))).toBe(true);
});
test('P2 rejects nonlocal owners, paths, queries and methods before access or host admission',async()=>{
 const f=fixture();expect((await run(request(input),f.host,{enabled:true},'remote-owner')).status).toBe(403);
 for(const url of [READ_TOOL_BATCH_PATH+'?',READ_TOOL_BATCH_PATH+'?target=one',READ_TOOL_BATCH_PATH+'/',READ_TOOL_BATCH_PATH+'/batch'])expect((await run(request(input,{},url),f.host)).status).toBe(404);
 expect((await run(request(input,{method:'GET',body:undefined}),f.host)).status).toBe(405);expect(f.calls).toEqual([]);
});
test('P2 validates strict plan, required existing thread id and fixed operations before calling the host',async()=>{
 const f=fixture();for(const bad of [{...input,threadId:undefined},{...input,threadId:'/tmp/thread'},{...input,owner:'local'},{...input,rootPath:'/tmp'},
  {...input,plan:{steps:[{id:'shell',input:{operation:'shell',command:'whoami'}}]}},
  {...input,plan:{steps:[{id:'memory',input:{operation:'memory.reference.read',role:'ops',query:'query'}}]}},
  {...input,plan:{steps:[{id:'report',input:{operation:'tester.report.read',runId:'latest'}}]}},
  {...input,operation:'batch.read'}, {...identity,operation:'batch.cancel',force:true}])expect((await run(request(bad),f.host)).status).toBe(400);
 expect(f.calls).toEqual([]);
});
test('P2 bounds declared and chunked bodies, rejects invalid UTF-8 and content encoding',async()=>{
 const f=fixture();for(const req of [request(input,{headers:{'Content-Type':'text/plain'}}),request(input,{headers:{'Content-Type':'application/json','Content-Encoding':'gzip'}})])expect((await run(req,f.host)).status).toBe(415);
 expect((await run(request(input,{headers:{'Content-Type':'application/json','Content-Length':'4097'}}),f.host)).status).toBe(413);
 expect((await run(request(input,{body:'x'.repeat(4097)}),f.host)).status).toBe(413);
 expect((await run(request(input,{body:new Uint8Array([0xff,0xfe])}),f.host)).status).toBe(400);expect(f.calls).toEqual([]);
});
test('P2 body deadline cancels incomplete streaming input without host admission',async()=>{
 const f=fixture();let cancelled=false;const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('{"operation":'));},cancel(){cancelled=true;}});
 const response=await run(request(null,{body}),f.host);expect(response.status).toBe(408);expect(cancelled).toBe(true);expect(f.calls).toEqual([]);
},4000);
test('P2 bounds responses and strips internal errors while preserving classified authority failures',async()=>{
 const f=fixture();f.host.read=async()=>{throw Object.assign(new Error('/private/path token=secret'),{code:'READ_EXECUTION_ACCESS'});};let response=await run(request({operation:'batch.read',...identity}),f.host);expect(response.status).toBe(403);expect(await response.text()).not.toContain('private/path');
 f.host.read=async()=>{throw new ReadExecutionError('READ_EXECUTION_MISSING');};expect((await run(request({operation:'batch.read',...identity}),f.host)).status).toBe(404);
 f.host.read=async()=>({batch:{...batch,runId:'x'.repeat(33000)},payload:'unavailable'});response=await run(request({operation:'batch.read',...identity}),f.host);expect(response.status).toBe(413);expect((await response.json() as any).code).toBe('READ_TOOL_RESPONSE_TOO_LARGE');
});
test('P2 multiplexing keeps P1 preview and prepare available with the activation gate off',async()=>{
 const f=fixture();let previews=0,prepares=0;const options:ReadToolBatchHttpOptions={enabled:false,projectState:{preview:async(_owner,args)=>{previews++;expect(args).toEqual({targetId:'project-one'});return {id:'bundle-one',targetId:'project-one',state:'ready',collectedAt:1,expiresAt:2,observations:[]};},prepare:async()=>{prepares++;return {bundleId:'bundle-one',selectionHash:'a'.repeat(64),text:'safe summary'};}}};
 expect((await run(request({operation:'preview',targetId:'project-one'}),f.host,options)).status).toBe(200);
 expect((await run(request({operation:'prepare',targetId:'project-one',bundleId:'bundle-one',sections:['git']}),f.host,options)).status).toBe(200);
 expect(previews).toBe(1);expect(prepares).toBe(1);expect(f.calls).toEqual([]);
});
