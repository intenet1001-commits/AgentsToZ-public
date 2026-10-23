import {expect,test} from 'bun:test';
import {createProjectStateRequester,decodeNativeProjectStateResult,decodeProjectStateResult,PROJECT_STATE_ENDPOINT,type ProjectStateClientRequest,type ProjectStatePreviewBundle,type ProjectStateClientResult} from '../src/projectStateBundleClient';
const request:ProjectStateClientRequest={operation:'preview',targetId:'fixture-project'};
const bundle:ProjectStatePreviewBundle={id:'bundle-fixture',targetId:'fixture-project',collectedAt:1,expiresAt:300001,state:'partial',observations:[{id:'tester',availability:'ready',freshness:'stale',observedAt:1,sourceProducedAt:0,sourceRevision:'abc',summary:['PASS (earlier source)'],limits:['Source fingerprint differs']}]};
const response:ProjectStateClientResult={success:true,bundle};
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
test('decode preserves availability and freshness independently and rejects response authority expansion',()=>{
 const result=decodeProjectStateResult(response,request);expect('bundle'in result&&result.bundle.observations[0]?.freshness).toBe('stale');
 for(const value of [{...response,path:'/secret'}, {...response,bundle:{...bundle,targetId:'other-project'}},{...response,bundle:{...bundle,observations:[{...bundle.observations[0],path:'/secret'}]}},{...response,bundle:{...bundle,observations:[...bundle.observations,...bundle.observations]}}])expect(()=>decodeProjectStateResult(value,request)).toThrow('INVALID_RESPONSE');
});
test('native envelope is exact and structured host refusal remains an admission refusal',()=>{
 expect(decodeNativeProjectStateResult({status:200,body:response},request)).toEqual(response);
 expect(()=>decodeNativeProjectStateResult({status:200,body:response,extra:true},request)).toThrow();
 try{decodeNativeProjectStateResult({status:409,body:{success:false,code:'PROJECT_STATE_INVALIDATED',error:'Changed'}},request);throw Error('missing refusal');}catch(e:any){expect(e.code).toBe('PROJECT_STATE_INVALIDATED');expect(e.serverRejected).toBe(true);}
});
test('local web uses the exact endpoint and cancellation signal without starting a task',async()=>{
 const calls:any[]=[];const client=createProjectStateRequester({native:false,fetch:(async(path:RequestInfo|URL,init?:RequestInit)=>{calls.push({path,init});return Response.json(response);}) as unknown as typeof fetch});
 await client(request);expect(calls).toHaveLength(1);expect(calls[0].path).toBe(PROJECT_STATE_ENDPOINT);expect(calls[0].init.method).toBe('POST');expect(JSON.parse(calls[0].init.body)).toEqual(request);expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
});
test('native timeout does not release its busy slot until the actual invoke settles',async()=>{
 let release:(v:unknown)=>void=()=>{};const calls:any[]=[];const client=createProjectStateRequester({native:true,timeoutMs:5,invoke:async(command,args)=>{calls.push({command,args});return new Promise(resolve=>{release=resolve;});}});
 await expect(client(request)).rejects.toThrow('TIMEOUT');await expect(client(request)).rejects.toThrow('BUSY');expect(calls).toHaveLength(1);expect(calls[0]).toEqual({command:'agent_runtime_request',args:{path:PROJECT_STATE_ENDPOINT,method:'POST',body:request}});
 release({status:200,body:response});await pause();const again=client(request);release({status:200,body:response});expect(await again).toEqual(response);
});
test('native cancel ignores caller view but retains the real operation slot',async()=>{
 let release:(v:unknown)=>void=()=>{};const client=createProjectStateRequester({native:true,invoke:async()=>new Promise(resolve=>{release=resolve;})});const abort=new AbortController();const pending=client(request,abort.signal);abort.abort();await expect(pending).rejects.toThrow();await expect(client(request)).rejects.toThrow('BUSY');release({status:200,body:response});await pause();
});
test('prepare is bound to bundle and response size never silently truncates',()=>{
 const selection={operation:'prepare',targetId:'fixture-project',bundleId:'bundle-fixture',sections:['git']} as const;
 expect(()=>decodeProjectStateResult({success:true,prepared:{text:'summary',bundleId:'other-bundle',selectionHash:'a'.repeat(64)}},selection as unknown as ProjectStateClientRequest)).toThrow();
 expect(()=>decodeProjectStateResult({...response,extra:'x'.repeat(33000)},request)).toThrow();
});
test('client refuses an expanded control request before either transport',async()=>{
 let calls=0;const client=createProjectStateRequester({native:false,fetch:(async()=>{calls++;return Response.json(response);}) as unknown as typeof fetch});
 await expect(client({...request,path:'/secret'} as any)).rejects.toThrow('INVALID_REQUEST');await expect(client({operation:'prepare',targetId:'fixture-project',bundleId:'bundle-fixture',sections:['git','git']})).rejects.toThrow();expect(calls).toBe(0);
});
test('web response stops reading at the wire budget',async()=>{
 let cancelled=false;const client=createProjectStateRequester({native:false,fetch:(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(32769));},cancel(){cancelled=true;}}))) as unknown as typeof fetch});
 await expect(client(request)).rejects.toThrow('INVALID_RESPONSE');expect(cancelled).toBe(true);
});

test('non-success HTTP or native status can never carry a success proof',async()=>{
 expect(()=>decodeNativeProjectStateResult({status:409,body:response},request)).toThrow('INVALID_RESPONSE');
 const client=createProjectStateRequester({native:false,fetch:(async()=>Response.json(response,{status:500})) as unknown as typeof fetch});await expect(client(request)).rejects.toThrow('INVALID_RESPONSE');
 const selection:ProjectStateClientRequest={operation:'prepare',targetId:'fixture-project',bundleId:'bundle-fixture',sections:['git']};
 for(const selectionHash of ['short','A'.repeat(64),'a'.repeat(65)])expect(()=>decodeProjectStateResult({success:true,prepared:{text:'summary',bundleId:'bundle-fixture',selectionHash}},selection)).toThrow('INVALID_RESPONSE');
});
