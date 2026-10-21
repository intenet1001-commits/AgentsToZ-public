import {isTauri} from './lib/env';
import {TESTER_ENDPOINT,type TesterRequest,type TesterResult} from './testerAgentContract';
export function decodeTesterResult(data:any):TesterResult {
  if(data?.success!==true){const e=new Error(data?.error||'테스터 결과를 확인하지 못했습니다.');Object.assign(e,{code:data?.code,serverRejected:true});throw e;}
  return data;
}
export function decodeNativeTesterResult(value:unknown):TesterResult {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('네이티브 테스터 응답을 확인하지 못했습니다.');
  const envelope=value as Record<string,unknown>;
  if(Object.keys(envelope).length!==2||!Object.hasOwn(envelope,'body')||!Number.isInteger(envelope.status)||Number(envelope.status)<100||Number(envelope.status)>599)throw new Error('네이티브 테스터 응답을 확인하지 못했습니다.');
  return decodeTesterResult(envelope.body);
}
export async function testerRequest(request:TesterRequest):Promise<TesterResult>{
  let data:any;
  if(isTauri()){
    const {invoke}=await import('@tauri-apps/api/core');
    return decodeNativeTesterResult(await invoke('agent_runtime_request',{path:TESTER_ENDPOINT,method:'POST',body:request}));
  }else{
    const response=await fetch(TESTER_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
    data=await response.json();
  }
  return decodeTesterResult(data);
}
