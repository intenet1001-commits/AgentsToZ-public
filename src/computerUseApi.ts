import type {ComputerUseRuntime} from './computerUseRuntime';
import {COMPUTER_USE_INSTANCE_HEADER,COMPUTER_USE_CLIENT_HEADER} from './computerUseConnectionProtocol';
import type {ComputerCallerOrigin} from './computerUseCallerHost';
const HEADERS={'Content-Type':'application/json','Cache-Control':'private, no-store'};
async function readBody(request:Request){
  const reader=request.body?.getReader();if(!reader)throw Error('JSON 요청이 필요합니다.');
  let length=0;const chunks:Uint8Array[]=[];const deadline=Date.now()+5000;
  try{while(true){
    let timer:ReturnType<typeof setTimeout>|undefined;
    const remaining=deadline-Date.now();if(remaining<=0)throw Error('요청 시간이 초과됐습니다.');
    const next=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('요청 시간이 초과됐습니다.')),remaining);timer.unref?.();})]).finally(()=>{if(timer)clearTimeout(timer);});
    if(next.done)break;length+=next.value.length;if(length>16000)throw Error('요청 크기를 줄여 주세요.');chunks.push(next.value);
  }
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
/**
 * Management authorization is checked by the exact Agent Runtime UI route before this handler. `origin` is the server's
 * own record of the agent request's loopback socket, used only to read the caller's host app (never a header or body).
 */
export async function handleComputerUse(request:Request,runtime:()=>ComputerUseRuntime,options:{agent:boolean;authorized:boolean;origin?:ComputerCallerOrigin|null}){
  if(!options.authorized)return Response.json({success:false,error:'이 연결에서 컴퓨터 유즈를 관리할 수 없습니다.'},{status:403,headers:HEADERS});
  try{
    const url=new URL(request.url);
    if(request.method!=='POST'||url.search||request.headers.get('content-type')?.split(';')[0]!=='application/json'||options.agent&&request.headers.has('origin'))throw Error('로컬 JSON POST만 허용합니다.');
    const body=await readBody(request),host=runtime();
    const result=options.agent?await host.agent(request.headers.get(COMPUTER_USE_INSTANCE_HEADER),request.headers.get(COMPUTER_USE_CLIENT_HEADER),body,options.origin??null):await host.manage(body);
    const encoded=JSON.stringify(result);if(Buffer.byteLength(encoded)>512000)throw Error('응답 한도를 초과했습니다.');return new Response(encoded,{headers:HEADERS});
  }catch(error){return Response.json({success:false,error:error instanceof Error?error.message:'컴퓨터 유즈 결과를 확인하지 못했습니다.'},{status:400,headers:HEADERS});}
}
