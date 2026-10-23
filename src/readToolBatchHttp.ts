import {PROJECT_STATE_PATH,PROJECT_STATE_CONTROL_BYTES,PROJECT_STATE_RESPONSE_BYTES,handleProjectStateBundleRequest} from './projectStateBundleHttp';
import {ProjectStateError} from './projectStateBundle';
import type {ProjectStateBundleHost,ReadPlanExecutionResult} from './projectStateBundleHost';
import {assertReadToolJson,parseReadToolPlan,readToolExactObject,readToolIdentifier,ReadToolError} from './readToolBundle';
import type {ReadToolBatch} from './workroomThreadReadExecution';

export const READ_TOOL_BATCH_PATH=PROJECT_STATE_PATH;
export type ReadToolBatchHttpOperation='batch.start'|'batch.read'|'batch.cancel'|'pack.run'|'pack.read';
export interface ReadToolBatchHttpInput {targetId:string;threadId:string;requestId:string}
export interface ReadToolBatchHttpResult {batch:ReadToolBatch;payload:'available'|'unavailable';result?:ReadPlanExecutionResult}
export interface ReadToolBatchHttpHost {
 start(owner:string,input:ReadToolBatchHttpInput&{plan:unknown},signal?:AbortSignal):Promise<ReadToolBatchHttpResult>;
 read(owner:string,input:ReadToolBatchHttpInput,signal?:AbortSignal):Promise<ReadToolBatchHttpResult>;
 cancel(owner:string,input:ReadToolBatchHttpInput,signal?:AbortSignal):Promise<ReadToolBatchHttpResult>;
}
export interface ReadToolBatchHttpOptions {
 enabled:boolean;
 projectState?:Pick<ProjectStateBundleHost,'preview'|'prepare'>;
 /** P3 work packs run as ordinary batches on the same thread, gate and receipts. */
 packs?:{run(owner:string,input:unknown,signal?:AbortSignal):Promise<ReadToolBatchHttpResult&{completion:unknown}>;read(owner:string,input:unknown,signal?:AbortSignal):Promise<ReadToolBatchHttpResult&{completion:unknown}>};
 /** Trusted request-scoped authority; never accepted from the HTTP body. */
 withAccess?<T>(owner:string,input:ReadToolBatchHttpInput,operation:ReadToolBatchHttpOperation,signal:AbortSignal,run:()=>Promise<T>):Promise<T>;
}
class HttpError extends Error {constructor(readonly code:string,readonly status:number){super(code);}}
async function control(req:Request):Promise<Record<string,unknown>> {
 if(req.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase()!=='application/json'||req.headers.get('content-encoding')&&req.headers.get('content-encoding')!=='identity')throw new HttpError('PROJECT_STATE_JSON_REQUIRED',415);
 const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>PROJECT_STATE_CONTROL_BYTES))throw new HttpError('PROJECT_STATE_BODY_TOO_LARGE',413);
 const reader=req.body?.getReader();if(!reader)throw new HttpError('PROJECT_STATE_INVALID_INPUT',400);
 const bytes=new Uint8Array(PROJECT_STATE_CONTROL_BYTES);let size=0,done=false,stopped=false,timer:ReturnType<typeof setTimeout>|undefined,abort=()=>{};
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new HttpError('PROJECT_STATE_BODY_TIMEOUT',408)),2000);abort=()=>reject(new HttpError('PROJECT_STATE_CANCELLED',408));req.signal.addEventListener('abort',abort,{once:true});if(req.signal.aborted)abort();});
 try{
  const read=async()=>{for(;;){const part=await reader.read();if(stopped)throw new HttpError('PROJECT_STATE_CANCELLED',408);if(part.done)break;if(size+part.value.byteLength>bytes.length)throw new HttpError('PROJECT_STATE_BODY_TOO_LARGE',413);bytes.set(part.value,size);size+=part.value.byteLength;}
   let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));}catch{throw new HttpError('PROJECT_STATE_INVALID_INPUT',400);}
   if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError('PROJECT_STATE_INVALID_INPUT',400);return value as Record<string,unknown>;};
  const value=await Promise.race([read(),deadline]);done=true;return value;
 }finally{stopped=true;clearTimeout(timer);req.signal.removeEventListener('abort',abort);if(!done)void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}bytes.fill(0);}
}
/** Runs only behind the existing exact local runtime origin/capability gate. */
export async function handleReadToolBatchRequest(req:Request,host:ReadToolBatchHttpHost,owner:string,responseHeaders:HeadersInit={},options:ReadToolBatchHttpOptions={enabled:false}):Promise<Response>{
 const headers=new Headers(responseHeaders);headers.set('Content-Type','application/json');headers.set('Cache-Control','private, no-store');headers.set('X-Content-Type-Options','nosniff');
 try{
  const url=new URL(req.url);if(url.pathname!==READ_TOOL_BATCH_PATH||url.search||req.url.includes('?')||url.hash)throw new HttpError('PROJECT_STATE_ROUTE_DENIED',404);
  if(req.method!=='POST')throw new HttpError('PROJECT_STATE_METHOD_DENIED',405);if(owner!=='local')throw new HttpError('READ_TOOL_LOCAL_ONLY',403);
  const body=await control(req);
  if((body.operation==='preview'||body.operation==='prepare')&&options.projectState){
   // Forward only the already bounded body. No clone/tee retains an unbounded caller stream.
   const forwarded=new Request(req.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:req.signal});
   return handleProjectStateBundleRequest(forwarded,options.projectState,owner,headers);
  }
  const operation=body.operation,pack=operation==='pack.run'||operation==='pack.read';
  if(!['batch.start','batch.read','batch.cancel',...(options.packs?['pack.run','pack.read']:[])].includes(String(operation)))throw new HttpError('READ_TOOL_OPERATION',400);
  assertReadToolJson(body,PROJECT_STATE_CONTROL_BYTES);
  readToolExactObject(body,operation==='batch.start'?['operation','targetId','threadId','requestId','plan']:operation==='pack.run'?['operation','targetId','threadId','requestId','guideId','values']:operation==='pack.read'?['operation','targetId','threadId','requestId','guideId']:['operation','targetId','threadId','requestId']);
  const input={targetId:readToolIdentifier(body.targetId),threadId:readToolIdentifier(body.threadId),requestId:readToolIdentifier(body.requestId)};
  const plan=operation==='batch.start'?parseReadToolPlan(body.plan):undefined;
  if(pack)readToolIdentifier(body.guideId);
  if((operation==='batch.start'||operation==='pack.run')&&!options.enabled)throw new HttpError('READ_TOOL_DISABLED',503);
  const {operation:_,...packInput}=body;
  const invoke=()=>pack?(operation==='pack.run'?options.packs!.run(owner,packInput,req.signal):options.packs!.read(owner,packInput,req.signal))
   :operation==='batch.start'?host.start(owner,{...input,plan},req.signal):operation==='batch.read'?host.read(owner,input,req.signal):host.cancel(owner,input,req.signal);
  const result=options.withAccess?await options.withAccess(owner,input,operation as ReadToolBatchHttpOperation,req.signal,invoke):await invoke();
  const encoded=JSON.stringify({success:true,...result});if(new TextEncoder().encode(encoded).byteLength>PROJECT_STATE_RESPONSE_BYTES)throw new HttpError('READ_TOOL_RESPONSE_TOO_LARGE',413);
  return new Response(encoded,{headers});
 }catch(error){
  const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^(?:PROJECT_STATE|READ_TOOL|READ_EXECUTION|WORK_PACKS?)_[A-Z_]+$/.test(error.code)?error.code:'READ_TOOL_UNAVAILABLE';
  const status=error instanceof HttpError||error instanceof ProjectStateError?error.status:error instanceof ReadToolError?400:code==='READ_EXECUTION_ACCESS'?403:code==='READ_EXECUTION_MISSING'?404:code.endsWith('_BUSY')?429:409;
  if(status===405)headers.set('Allow','POST');if(status===413||status===408){headers.set('Connection','close');if(req.body&&!req.body.locked)void req.body.cancel().catch(()=>{});}
  return Response.json({success:false,code,error:'조회 요청을 처리하지 못했습니다. 기존 요청 번호로 결과를 확인하고 대상과 권한을 다시 확인하세요.'},{status,headers});
 }
}
