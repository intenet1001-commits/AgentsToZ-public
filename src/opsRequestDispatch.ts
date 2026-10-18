import {OPS_REQUEST_VERSION,OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE,OPS_REQUEST_NOT_FOUND_MESSAGE,COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,
  COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE,normalizeOpsReceipt,OpsRequestError,type OpsRequestReceipt} from './opsRequestProtocol';
import {AgentDialogueHostError} from './agentDialogueHost';
import {opsRequestMcpBody} from './opsRequestMcp';
import type {OpsRequestHost} from './opsRequestHost';
export interface OpsRequestDispatchDependencies {
  devices():Promise<{inside:boolean;devices:{endpointId:string;deviceId:string;displayName:string;kind:'ops'|'project'}[]}>;
  call(endpointId:string,request:Record<string,unknown>,timeoutMs:number):Promise<Record<string,unknown>>;
  host:Pick<OpsRequestHost,'complete'>;
  now?:()=>number;sleep?:(ms:number)=>Promise<void>;
}
/**
 * Every status read of a wait gets at least this budget. A community round trip takes ~0.4 s while the receiver is
 * active and ~1.6 s (p90 ~2.8 s) while it idles, so a 1 s budget ended nearly every wait on a timeout that reads
 * "unknown whether it ran". The wait stops early instead of starting a read it cannot finish before its deadline.
 */
export const OPS_WAIT_CALL_FLOOR_MS=5000;
/**
 * The receiver's answer carries only a message; keep the reason and recover the codes callers act on. Any other
 * answer stays the neutral OPS_REQUEST_FAILED: its text alone does not prove the task was never admitted, so a code
 * that reads "refused" would invite a resubmit under a new ID, and the work would run twice.
 */
function receiverRefusal(error:unknown):OpsRequestError{
  const message=typeof error==='string'&&error.trim()?error:'상대 OPS가 작업 요청을 처리하지 못했습니다.';
  if(message===OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE)
    return new OpsRequestError('OPS_HOST_OUTDATED','상대 기기의 AgentsToZ를 업데이트하세요. 지금 버전은 OPS 작업 요청을 받지 못합니다.');
  if(message===OPS_REQUEST_NOT_FOUND_MESSAGE)return new OpsRequestError('OPS_REQUEST_NOT_FOUND',message);
  // The receiver may still admit or have run it: check the same ID, never resend under a new one.
  if(message===COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE||message===COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE)
    return new OpsRequestError('OPS_REQUEST_OUTCOME_UNKNOWN',message);
  return new OpsRequestError('OPS_REQUEST_FAILED',message);
}
/** Only the transport's own deadline: the read may still be answered later, and it executes nothing. */
const transportTimedOut=(error:unknown)=>(error as {code?:unknown})?.code==='AGENT_DIALOGUE_CONTROL_TIMEOUT';
export function createOpsRequestDispatch(deps:OpsRequestDispatchDependencies){
  return async(value:unknown,active:()=>boolean=()=>true):Promise<Record<string,unknown>>=>{
    const body=value as Record<string,unknown>|null;
    const name=({devices:'agentstoz_use_list_ops_devices',submit:'agentstoz_use_submit_ops_request',status:'agentstoz_use_get_ops_request_result',
      wait:'agentstoz_use_wait_ops_request',complete:'agentstoz_use_complete_ops_request'} as Record<string,string>)[String(body?.operation)];
    if(!name||!body)throw Error('지원하지 않는 OPS 작업 동작입니다.');
    const {operation,...args}=body,r=opsRequestMcpBody(name,args);
    if(!active())throw Error('호출 권한이 종료되었습니다.');
    const response=(result:Record<string,unknown>)=>({version:OPS_REQUEST_VERSION,...result});
    if(operation==='complete')return response({receipt:await deps.host.complete({requestId:r.requestId,capability:r.capability,state:r.state,result:r.result,evidence:r.evidence})});
    const devices=await deps.devices();
    if(!devices.inside)throw new OpsRequestError('OPS_REQUEST_PERMISSION','기기 간 대화의 커뮤니티에 입장하세요.');
    if(operation==='devices')return response({devices:devices.devices});
    // The list selects only. The transport and receiver re-check current membership on each request.
    if(!devices.devices.some(d=>d.endpointId===r.endpointId))throw new OpsRequestError('OPS_REQUEST_TARGET','기기 목록에서 현재 참여한 상대 기기를 다시 선택하세요.');
    const now=deps.now??Date.now,until=now()+Number(r.timeoutMs??0);
    let first=true,last:OpsRequestReceipt|null=null;
    for(;;){
      if(!active())throw Error('호출 권한이 종료되었습니다.');
      let reply:Record<string,unknown>;
      try{
        reply=await deps.call(String(r.endpointId),{kind:'ops-request',operation:operation==='submit'?'submit':'status',requestId:r.requestId,
          ...(operation==='submit'?{text:r.text}:{})},operation==='wait'?Math.max(OPS_WAIT_CALL_FLOOR_MS,Math.min(8000,until-now())):20_000);
      }catch(error){
        // A status read executes nothing. Once one answered, a later read that timed out leaves that answer current.
        // Any other failure (the peer left, a full inbox, a bad receipt) is reported now, not hidden behind it.
        if(operation==='wait'&&last&&transportTimedOut(error)){
          if(!active())throw Error('호출 권한이 종료되었습니다.');
          return response({receipt:last});
        }
        throw error;
      }
      if(reply.ok!==true)throw receiverRefusal(reply.error);
      const receipt=normalizeOpsReceipt((reply.body as any)?.receipt);
      if(receipt.requestId!==r.requestId)throw Error('OPS 작업 응답의 요청 ID가 다릅니다.');
      if(!active())throw Error('호출 권한이 종료되었습니다.');
      last=receipt;
      // Never start a read that could not finish before the deadline; the current receipt is the answer then.
      if(operation!=='wait'||!['queued','starting','running'].includes(receipt.state)||until-now()<OPS_WAIT_CALL_FLOOR_MS)return response({receipt});
      // Waiting never holds the receiving inbox. It is another bounded status read of the same ID.
      await (deps.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(Math.min(first?1000:2000,until-now()-OPS_WAIT_CALL_FLOOR_MS));first=false;
    }
  };
}

/** The app's control route keeps an OPS refusal's code and message (it would otherwise say only "failed"). */
export function opsRequestFailure(error:unknown):{code:string;error:string}|null{
  return error instanceof OpsRequestError?{code:error.code,error:error.message}:null;
}
/**
 * The failure answer of `/api/agent-dialogue/control`. The OPS composer acts on the code (not-found offers a new
 * task), so this is the one place that keeps it; an unknown error keeps its text off the wire.
 */
export function communityControlRouteFailure(error:unknown):{status:number;body:{success:false;code:string;error:string}}{
  const ops=opsRequestFailure(error);if(ops)return {status:400,body:{success:false,...ops}};
  const known=error instanceof AgentDialogueHostError;
  return {status:known?error.status:400,body:{success:false,code:known?error.code:'AGENT_DIALOGUE_CONTROL_FAILED',
    error:known?error.message:'다른 기기 제어 요청을 처리하지 못했습니다.'}};
}

/** Actual local MCP HTTP boundary, also used by isolated integration fixtures. */
export async function handleOpsRequestMcpHttp(req:Request,options:{authorize:(token:string|null)=>boolean;dispatch:ReturnType<typeof createOpsRequestDispatch>;headers?:HeadersInit}):Promise<Response>{
  const headers=new Headers(options.headers);headers.set('Cache-Control','no-store');
  const active=()=>!req.headers.has('origin')&&options.authorize(req.headers.get('X-AgentsToZ-Control-Profile'));
  if(req.method!=='POST'||!active())return Response.json({success:false,error:'OPS MCP 연결 권한이 필요합니다.'},{status:403,headers});
  try{
    const raw=await req.text();if(Buffer.byteLength(raw)>65_536)throw Error('OPS 작업 요청이 너무 큽니다.');
    const result=await options.dispatch(JSON.parse(raw),active);
    return Response.json({success:true,...result},{headers});
  }catch(error){return Response.json({success:false,version:OPS_REQUEST_VERSION,code:error instanceof OpsRequestError?error.code:'OPS_REQUEST_FAILED',
    error:error instanceof Error?error.message:'OPS 작업 요청을 처리하지 못했습니다.'},{status:400,headers});}
}
