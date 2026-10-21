/** Shared by MCP, voice and the app. No caller-selected agent, path, shell or permission mode. */
export const OPS_REQUEST_VERSION = 'ops-request-v1';
// JSON escaping plus the receiver's fixed instructions must fit the CLI's 24,000-byte first prompt.
export const OPS_REQUEST_MAX_TEXT_BYTES = 10_000;
export const OPS_REQUEST_MAX_RESULT_BYTES = 8_000;
export const OPS_REQUEST_STATES = ['queued','starting','running','needs-attention','completed','failed','unknown'] as const;
export type OpsRequestState = typeof OPS_REQUEST_STATES[number];
export type OpsRequestCommand = {kind:'ops-request';operation:'submit';requestId:string;text:string}
  | {kind:'ops-request';operation:'status';requestId:string};
export interface OpsRequestReceipt {
  version:typeof OPS_REQUEST_VERSION;requestId:string;state:OpsRequestState;createdAt:number;updatedAt:number;
  sessionId?:string;targetId?:string;agent?:'codex'|'claude'|'hermes'|'agy';
  result?:string;evidence?:string;message?:string;windowOpened:boolean;
  windowFallback?:true;
}
/**
 * The receiver answers a refusal as `{ok:false,error:<message>}` over the community mailbox, so its code does not
 * travel. These two answers are told apart by their exact text: the not-found answer of `OpsRequestHost.receive`
 * and the answer of an AgentsToZ that predates OPS requests (`createCommunityControlExecutor`, unknown kind).
 */
export const OPS_REQUEST_NOT_FOUND_MESSAGE = '이 기기에서 접수한 작업을 찾지 못했습니다.';
export const OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE = '지원하지 않는 기기 제어 요청입니다.';
/**
 * Answers of the receiver's mailbox loop (`AgentDialogueHost.controlPoll`) that leave the outcome open: the request
 * outlived its execution deadline but keeps running, or ran and its answer was too large to deliver. Never a refusal.
 */
export const COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE = '이 기기에서 그 요청이 제때 끝나지 않았습니다. 실행됐는지는 알 수 없습니다.';
export const COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE = '응답이 너무 커서 전달하지 못했습니다.';
export class OpsRequestError extends Error {
  constructor(readonly code:string,message:string){super(message);}
}
export function opsRequestId(value:unknown):string {
  if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new OpsRequestError('OPS_REQUEST_INVALID','작업 요청 ID를 확인하세요.');
  return value.toLowerCase();
}
export function opsRequestText(value:unknown,max=OPS_REQUEST_MAX_TEXT_BYTES,naturalLanguage=true):string {
  if(typeof value!=='string'||!value.trim()||new TextEncoder().encode(value).length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    throw new OpsRequestError('OPS_REQUEST_INVALID','작업 내용과 입력 크기를 확인하세요.');
  const text=value.trim();
  if(naturalLanguage&&/^\s*[!/]/.test(text))throw new OpsRequestError('OPS_REQUEST_INVALID','작업 요청은 자연어로 입력하세요.');
  return text;
}
export function parseOpsRequest(value:unknown):OpsRequestCommand {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new OpsRequestError('OPS_REQUEST_INVALID','작업 요청을 확인하세요.');
  const r=value as Record<string,unknown>;
  const keys=r.operation==='submit'?['kind','operation','requestId','text']:['kind','operation','requestId'];
  if(r.kind!=='ops-request'||!['submit','status'].includes(String(r.operation))||Object.keys(r).some(k=>!keys.includes(k)))
    throw new OpsRequestError('OPS_REQUEST_INVALID','지원하지 않는 OPS 요청입니다.');
  const requestId=opsRequestId(r.requestId);
  return r.operation==='submit'?{kind:'ops-request',operation:'submit',requestId,text:opsRequestText(r.text)}:{kind:'ops-request',operation:'status',requestId};
}
export function normalizeOpsReceipt(value:unknown):OpsRequestReceipt {
  const r=value as OpsRequestReceipt|null;
  const keys=['version','requestId','state','createdAt','updatedAt','sessionId','targetId','agent','result','evidence','message','windowOpened','windowFallback'];
  const bytes=(v:unknown,max:number)=>v===undefined||typeof v==='string'&&new TextEncoder().encode(v).length<=max;
  if(!r||r.version!==OPS_REQUEST_VERSION||!OPS_REQUEST_STATES.includes(r.state)||opsRequestId(r.requestId)!==r.requestId
    ||Object.keys(r).some(k=>!keys.includes(k))||!Number.isSafeInteger(r.createdAt)||!Number.isSafeInteger(r.updatedAt)||typeof r.windowOpened!=='boolean'
    ||!bytes(r.result,OPS_REQUEST_MAX_RESULT_BYTES)||!bytes(r.evidence,2000)||!bytes(r.message,1200)
    ||r.sessionId!==undefined&&!/^[A-Za-z0-9_-]{8,160}$/.test(r.sessionId)||r.targetId!==undefined&&!/^[A-Za-z0-9_-]{8,160}$/.test(r.targetId)
    ||r.agent!==undefined&&!['codex','claude','hermes','agy'].includes(r.agent)
    ||r.windowFallback!==undefined&&r.windowFallback!==true
    ||r.state==='completed'&&(!r.result?.trim()||!r.evidence?.trim()))
    throw new OpsRequestError('OPS_HOST_OUTDATED','상대 기기의 OPS 작업 기능과 응답을 확인하세요. 앱 업데이트가 필요할 수 있습니다.');
  return r;
}
export const OPS_STATE_LABELS:Record<OpsRequestState,string>={queued:'접수 · 대기',starting:'OPS 시작 중',running:'처리 중',
  'needs-attention':'승인·확인 필요',completed:'완료',failed:'실패',unknown:'실행 결과 미확정'};
