import {ReadToolError} from './readToolBundle';
import {WorkPackError} from './workPack';
import {WorkPackStoreError} from './workPackStore';
import type {WorkPackHost} from './workPackHost';

export const WORK_PACKS_PATH='/api/what-i-said/guides/packs';
const MAX_BYTES=8*1024;
const messages:Record<string,string>={
 WORK_PACKS_CONFLICT:'다른 창에서 작업 팩이 바뀌었습니다. 목록을 다시 읽은 뒤 저장하세요.',
 WORK_PACKS_SOURCE_CONFLICT:'규격 명령이 바뀌었습니다. 목록을 다시 읽은 뒤 저장하세요.',
 WORK_PACK_SOURCE:'저장된 규격 명령을 선택하세요.',
 WORK_PACK_NOT_FOUND:'이 규격 명령에 저장된 작업 팩이 없습니다.',
 WORK_PACKS_LIMIT_EXCEEDED:'작업 팩 저장 한도를 넘었습니다.',
};
/** Called only after the existing What I Said management capability gate (same as guides). */
export async function handleWorkPackRequest(req:Request,host:Pick<WorkPackHost,'list'|'save'|'disable'>,responseHeaders:HeadersInit={}):Promise<Response> {
 const headers=new Headers(responseHeaders);
 headers.set('Content-Type','application/json; charset=utf-8');headers.set('Cache-Control','private, no-store');headers.set('X-Content-Type-Options','nosniff');
 try{
  const url=new URL(req.url);
  if(url.pathname!==WORK_PACKS_PATH||url.search||req.url.includes('?')||url.hash)throw new WorkPackError('WORK_PACKS_NOT_FOUND');
  if(req.method!=='POST')throw new WorkPackError('WORK_PACKS_METHOD_NOT_ALLOWED');
  const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES))throw new WorkPackError('WORK_PACKS_LIMIT_EXCEEDED');
  const reader=req.body?.getReader();if(!reader)throw new WorkPackError('WORK_PACK_INPUT');
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw new WorkPackError('WORK_PACKS_LIMIT_EXCEEDED');}chunks.push(part.value);}}
  finally{try{reader.releaseLock();}catch{}}
  let body:unknown;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new WorkPackError('WORK_PACK_INPUT');}
  if(!body||typeof body!=='object'||Array.isArray(body))throw new WorkPackError('WORK_PACK_INPUT');
  const {operation,...input}=body as Record<string,unknown>;
  const result=operation==='list'&&Object.keys(input).length===0?await host.list():operation==='save'?await host.save(input):operation==='disable'?await host.disable(input):(()=>{throw new WorkPackError('WORK_PACK_INPUT');})();
  return new Response(JSON.stringify({success:true,...result}),{headers});
 }catch(error){
  const code=error instanceof WorkPackError||error instanceof WorkPackStoreError||error instanceof ReadToolError?error.code:'WORK_PACKS_UNAVAILABLE';
  const status=code==='WORK_PACKS_NOT_FOUND'?404:code==='WORK_PACKS_METHOD_NOT_ALLOWED'?405:code==='WORK_PACKS_LIMIT_EXCEEDED'?413:/INPUT|PARAMETER|READ_TOOL/.test(code)?400:409;
  if(status===405)headers.set('Allow','POST');
  return new Response(JSON.stringify({success:false,code,error:messages[code]??'작업 팩을 처리하지 못했습니다. 목록을 다시 읽어 확인하세요.'}),{status,headers});
 }
}
