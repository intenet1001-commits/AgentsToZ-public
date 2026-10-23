import {isTauri} from './lib/env';
import {parseProjectStatePreviewInput,parseProjectStateSelectionInput} from './projectStateBundle';

export const PROJECT_STATE_ENDPOINT='/api/agent-runtime/project-state';
export const PROJECT_STATE_TIMEOUT_MS=15_000;
export type {SectionId as ProjectStateSectionId,SourceObservation as ProjectStateObservation,ProjectStateBundle as ProjectStatePreviewBundle,PreparedProjectState as ProjectStatePrepared} from './projectStateBundle';
import type {SectionId as ProjectStateSectionId,ProjectStateBundle as ProjectStatePreviewBundle,PreparedProjectState as ProjectStatePrepared} from './projectStateBundle';
export interface ProjectStateSelectionReference {bundleId:string;sections:ProjectStateSectionId[];selectionHash:string}
export type ProjectStateClientRequest={operation:'preview';targetId:string;memoryQuery?:string}|{operation:'prepare';targetId:string;bundleId:string;sections:ProjectStateSectionId[]};
export type ProjectStateClientResult={success:true;bundle:ProjectStatePreviewBundle}|{success:true;prepared:ProjectStatePrepared};
export type ProjectStateRequester=(request:ProjectStateClientRequest,signal?:AbortSignal)=>Promise<ProjectStateClientResult>;
const sections=['git','workroom','tester','memory'];
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=8640000000000000;
const string=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max;
const strings=(v:unknown,max:number)=>Array.isArray(v)&&v.length<=max&&v.every(s=>typeof s==='string'&&s.length<=4096);
const malformed=()=>new Error('PROJECT_STATE_INVALID_RESPONSE');
export function decodeProjectStateResult(raw:unknown,request:ProjectStateClientRequest):ProjectStateClientResult {
 if(!object(raw)||new TextEncoder().encode(JSON.stringify(raw)).length>32*1024)throw malformed();
 if(raw.success!==true){const e=new Error(typeof raw.error==='string'?raw.error:'PROJECT_STATE_REQUEST_FAILED');Object.assign(e,{code:raw.code,serverRejected:true});throw e;}
 if(request.operation==='preview'){
  if(!exact(raw,['success','bundle'])||!object(raw.bundle))throw malformed();const b=raw.bundle;
  if(!exact(b,['id','targetId','collectedAt','expiresAt','state','observations'])||!string(b.id,128)||b.targetId!==request.targetId||!finite(b.collectedAt)||!finite(b.expiresAt)||b.expiresAt<b.collectedAt||!['ready','partial','invalidated'].includes(String(b.state))||!Array.isArray(b.observations)||b.observations.length>4)throw malformed();
  const seen=new Set();for(const o of b.observations){if(!object(o)||!exact(o,['id','availability','freshness','observedAt','sourceProducedAt','sourceRevision','summary','limits','errorCode'])||!sections.includes(String(o.id))||o.id==='memory'&&request.memoryQuery===undefined||seen.has(o.id)||!['ready','unconfigured','partial','unknown','unavailable'].includes(String(o.availability))||!['current','stale','unknown'].includes(String(o.freshness))||!finite(o.observedAt)||!strings(o.summary,20)||!strings(o.limits,16)||o.sourceProducedAt!==undefined&&!finite(o.sourceProducedAt)||o.sourceRevision!==undefined&&!string(o.sourceRevision,256)||o.errorCode!==undefined&&!string(o.errorCode,100))throw malformed();seen.add(o.id);}
  return raw as unknown as ProjectStateClientResult;
 }
 if(!exact(raw,['success','prepared'])||!object(raw.prepared)||!exact(raw.prepared,['text','bundleId','selectionHash'])||raw.prepared.bundleId!==request.bundleId||!string(raw.prepared.text,6000)||new TextEncoder().encode(String(raw.prepared.text)).length>4096||(typeof raw.prepared.selectionHash!=='string'||!/^[a-f0-9]{64}$/.test(raw.prepared.selectionHash)))throw malformed();
 return raw as unknown as ProjectStateClientResult;
}
export function decodeNativeProjectStateResult(raw:unknown,request:ProjectStateClientRequest):ProjectStateClientResult {
 if(!object(raw)||!exact(raw,['status','body'])||Object.keys(raw).length!==2||!Number.isInteger(raw.status)||Number(raw.status)<100||Number(raw.status)>599)throw malformed();if((Number(raw.status)<200||Number(raw.status)>=300)&&object(raw.body)&&raw.body.success===true)throw malformed();return decodeProjectStateResult(raw.body,request);
}
async function boundedResponse(response:Response):Promise<unknown> {
 const reader=response.body?.getReader();if(!reader)throw malformed();
 const decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>32*1024){await reader.cancel();throw malformed();}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}finally{reader.releaseLock();}
}
interface ClientOptions {native?:boolean;invoke?:(command:string,args:Record<string,unknown>)=>Promise<unknown>;fetch?:typeof fetch;timeoutMs?:number}
/** Native invoke cannot be cancelled: this slot stays occupied until its real promise settles. */
export function createProjectStateRequester(options:ClientOptions={}):ProjectStateRequester {
 let nativeBusy=false;
 return async(request,signal)=>{
  if(signal?.aborted)throw new DOMException('Aborted','AbortError');
  if(!object(request)||!['preview','prepare'].includes(request.operation)||!exact(request,request.operation==='preview'?['operation','targetId','memoryQuery']:['operation','targetId','bundleId','sections'])||new TextEncoder().encode(JSON.stringify(request)).length>4096)throw Error('PROJECT_STATE_INVALID_REQUEST');
  const {operation:_,...input}=request;request.operation==='preview'?parseProjectStatePreviewInput(input):parseProjectStateSelectionInput(input);
  const native=options.native??isTauri();if(native&&nativeBusy)throw Error('PROJECT_STATE_BUSY');
  const controller=new AbortController();const abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});
  let timer:ReturnType<typeof setTimeout>|undefined;
  const stopped=new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(controller.signal.reason instanceof Error?controller.signal.reason:new DOMException('Aborted','AbortError')),{once:true});timer=setTimeout(()=>controller.abort(new Error('PROJECT_STATE_TIMEOUT')),options.timeoutMs??PROJECT_STATE_TIMEOUT_MS);});
  let actual:Promise<ProjectStateClientResult>;
  if(native){
   nativeBusy=true;actual=(async()=>{const invoke=options.invoke??(await import('@tauri-apps/api/core')).invoke;return decodeNativeProjectStateResult(await invoke('agent_runtime_request',{path:PROJECT_STATE_ENDPOINT,method:'POST',body:request}),request);})().finally(()=>{nativeBusy=false;});
  }else actual=(async()=>{const response=await(options.fetch??fetch)(PROJECT_STATE_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:controller.signal});const body=await boundedResponse(response);if(!response.ok&&object(body)&&body.success===true)throw malformed();return decodeProjectStateResult(body,request);})();
  try{return await Promise.race([actual,stopped]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 };
}
export const projectStateRequest=createProjectStateRequester();
