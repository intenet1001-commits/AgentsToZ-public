import {OPS_REQUEST_MAX_TEXT_BYTES,OPS_REQUEST_MAX_RESULT_BYTES,opsRequestId,opsRequestText} from './opsRequestProtocol';
const uuid={type:'string',format:'uuid'};
const schema=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export const OPS_REQUEST_MCP_TOOLS=[
  {name:'agentstoz_use_list_ops_devices',description:'Start here only when the user explicitly asks to hand a task to another device: list_ops_devices → submit_ops_request → wait_ops_request until completed/failed, then report the result and evidence. Lists current community devices; use the returned endpointId and never guess a device or pick an ambiguous name.',inputSchema:schema({})},
  {name:'agentstoz_use_submit_ops_request',description:'Send an explicitly delegated user task to the selected other device. Its own configured AI opens a dedicated OPS Workroom. Keep this requestId and exact text on a retry; after an unknown or network outcome look it up with get_ops_request_result, never a new requestId. Receipt means admission, not completion. Then wait_ops_request and return the actual result/evidence to the user.',inputSchema:schema({endpointId:uuid,requestId:uuid,text:{type:'string',minLength:1,maxLength:OPS_REQUEST_MAX_TEXT_BYTES}})},
  {name:'agentstoz_use_get_ops_request_result',description:'Read the receiving OPS task by the same endpointId and requestId. No execution or replay. completed/failed include the receiving AI result and evidence; quiet output and an open window are not completion.',inputSchema:schema({endpointId:uuid,requestId:uuid})},
  {name:'agentstoz_use_wait_ops_request',description:'Wait up to 25 seconds for a submitted OPS task result or approval need. Repeat while queued/starting/running, preserving the same IDs. An unknown/network outcome requires a get_ops_request_result lookup, never a new submission ID. Return result and evidence when completed/failed.',inputSchema:schema({endpointId:uuid,requestId:uuid,timeoutMs:{type:'integer',minimum:0,maximum:25000}},['endpointId','requestId'])},
  {name:'agentstoz_use_complete_ops_request',description:'Receiving OPS worker only: submit the actual task result and execution/verification evidence. From the receiving OPS Workroom itself the capability may be omitted; otherwise pass the exact private capability from its initial task. Does not run a task. Delivery is not completion. Never expose the capability. Retry only with identical content.',inputSchema:schema({requestId:uuid,capability:{type:'string',pattern:'^[a-f0-9]{64}$'},state:{type:'string',enum:['completed','failed']},result:{type:'string',minLength:1,maxLength:OPS_REQUEST_MAX_RESULT_BYTES},evidence:{type:'string',minLength:1,maxLength:2000}},['requestId','state','result','evidence'])},
] as const;
const operations:Record<string,string>={agentstoz_use_list_ops_devices:'devices',agentstoz_use_submit_ops_request:'submit',
  agentstoz_use_get_ops_request_result:'status',agentstoz_use_wait_ops_request:'wait',agentstoz_use_complete_ops_request:'complete'};
export const isOpsRequestMcpTool=(name:unknown):name is string=>typeof name==='string'&&Object.hasOwn(operations,name);
export function opsRequestMcpBody(name:string,value:unknown):Record<string,unknown>{
  const tool=OPS_REQUEST_MCP_TOOLS.find(t=>t.name===name);
  if(!tool||!value||typeof value!=='object'||Array.isArray(value))throw Error('OPS 작업 도구 입력을 확인하세요.');
  const args=value as Record<string,unknown>,s=tool.inputSchema;
  if(Object.keys(args).some(k=>!Object.hasOwn(s.properties,k))||s.required.some(k=>args[k]===undefined))throw Error('지원하지 않는 OPS 도구 필드입니다.');
  const operation=operations[name];
  if(operation==='devices')return {operation};
  const requestId=opsRequestId(args.requestId);
  if(operation==='complete'){
    if(args.capability!==undefined&&(typeof args.capability!=='string'||!/^[a-f0-9]{64}$/.test(args.capability))||!['completed','failed'].includes(String(args.state)))throw Error('OPS 결과 제출 내용을 확인하세요.');
    return {operation,requestId,...(args.capability===undefined?{}:{capability:args.capability}),state:args.state,result:opsRequestText(args.result,OPS_REQUEST_MAX_RESULT_BYTES,false),evidence:opsRequestText(args.evidence,2000,false)};
  }
  const endpointId=opsRequestId(args.endpointId);
  if(operation==='submit')return {operation,endpointId,requestId,text:opsRequestText(args.text)};
  if(operation==='wait'&&args.timeoutMs!==undefined&&(!Number.isInteger(args.timeoutMs)||Number(args.timeoutMs)<0||Number(args.timeoutMs)>25000))throw Error('OPS 대기 시간을 확인하세요.');
  return {operation,endpointId,requestId,...(operation==='wait'?{timeoutMs:args.timeoutMs??20000}:{})};
}
