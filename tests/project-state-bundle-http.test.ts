import {expect,test} from 'bun:test';
import {ProjectStateError} from '../src/projectStateBundle';
import {handleProjectStateBundleRequest,PROJECT_STATE_PATH} from '../src/projectStateBundleHttp';

const endpoint=`http://localhost:3001${PROJECT_STATE_PATH}`;
const preview={operation:'preview',targetId:'fixture-project'};
const request=(value:unknown=preview,options:RequestInit={})=>new Request(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value),...options});
const bundle={id:'bundle-fixture',targetId:'fixture-project',collectedAt:1,expiresAt:300001,state:'ready' as const,observations:[]};

test('HTTP uses only the fixed preview and prepare operations and emits non-cacheable bounded responses',async()=>{
 const calls:unknown[]=[];
 const host={preview:async(...args:unknown[])=>{calls.push(args.slice(0,2));return bundle;},prepare:async(...args:unknown[])=>{calls.push(args.slice(0,2));return {text:'reference',bundleId:bundle.id,selectionHash:'a'.repeat(64)};}};
 const first=await handleProjectStateBundleRequest(request(),host,'local');
 expect(first.status).toBe(200);expect(first.headers.get('cache-control')).toContain('no-store');expect(first.headers.get('x-content-type-options')).toBe('nosniff');
 expect(await first.json()).toEqual({success:true,bundle});
 const selection={operation:'prepare',targetId:'fixture-project',bundleId:bundle.id,sections:['git']};
 expect((await handleProjectStateBundleRequest(request(selection),host,'local')).status).toBe(200);
 expect(calls).toEqual([['local',{targetId:'fixture-project'}],['local',{targetId:'fixture-project',bundleId:bundle.id,sections:['git']}]]);
});

test('HTTP denies route expansion, remote owners, methods and mutation operations before touching a source',async()=>{
 let reads=0;const host={preview:async()=>{reads++;return bundle;},prepare:async()=>{reads++;return {text:'',bundleId:bundle.id,selectionHash:'a'.repeat(64)};}};
 for(const suffix of ['?','?targetId=other','/preview','#fragment'])expect((await handleProjectStateBundleRequest(new Request(endpoint+suffix,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(preview)}),host,'local')).status).toBe(404);
 expect((await handleProjectStateBundleRequest(new Request(endpoint),host,'local')).status).toBe(405);
 expect((await handleProjectStateBundleRequest(request(),host,'device:fixture')).status).toBe(403);
 for(const operation of ['send','execute','remember','test','validate'])expect((await handleProjectStateBundleRequest(request({...preview,operation}),host,'local')).status).toBe(400);
 expect(reads).toBe(0);
});

test('HTTP rejects oversized streaming controls and unsupported encodings without executing the host',async()=>{
 let reads=0,cancelled=false;const host={preview:async()=>{reads++;return bundle;},prepare:async()=>{throw Error('unused');}};
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(4097));},cancel(){cancelled=true;}});
 const oversized=new Request(endpoint,{method:'POST',headers:{'content-type':'application/json'},body,duplex:'half'} as RequestInit);
 expect((await handleProjectStateBundleRequest(oversized,host,'local')).status).toBe(413);expect(cancelled).toBe(true);
 for(const [headers,status] of [[{'content-type':'text/plain'},415],[{'content-type':'application/json','content-encoding':'gzip'},415],[{'content-type':'application/json','content-length':'4097'},413]] as const)expect((await handleProjectStateBundleRequest(request(preview,{headers}),host,'local')).status).toBe(status);
 expect(reads).toBe(0);
});

test('HTTP preserves known admission status while withholding raw exception data',async()=>{
 for(const [code,status] of [['PROJECT_STATE_INPUT',400],['PROJECT_STATE_BUSY',429],['PROJECT_STATE_SELECTION_TOO_LARGE',413]] as const){
  const host={preview:async()=>{throw new ProjectStateError(code,'secret /private/path',status);},prepare:async()=>{throw Error('unused');}};
  const response=await handleProjectStateBundleRequest(request(),host,'local');
  expect(response.status).toBe(status);expect(await response.text()).not.toContain('/private/path');
 }
 const host={preview:async()=>{throw Error('token=secret /private/path');},prepare:async()=>{throw Error('unused');}};
 const response=await handleProjectStateBundleRequest(request(),host,'local');expect(response.status).toBe(409);expect(await response.json()).toMatchObject({success:false,code:'PROJECT_STATE_UNAVAILABLE'});
 const huge={preview:async()=>({...bundle,observations:[{summary:['x'.repeat(32768)]}]} as never),prepare:async()=>{throw Error('unused');}};
 expect((await handleProjectStateBundleRequest(request(),huge,'local')).status).toBe(413);
});
