import {terminalLocalRequest} from './aiTerminalClient';
import {PLATFORM_CLI_PATH} from './platformCliProtocol';
import type {PlatformCliOperationView} from './platformCliOperation';
const key='agentstoz-cli-connection-request';
export function pendingPlatformConnection():string|null {try{return localStorage.getItem(key);}catch{return null;}}
export async function platformConnectionOperation(body:Record<string,unknown>,onWaiting?:(id:string)=>void,request=terminalLocalRequest):Promise<any>{
  const requestId=typeof body.requestId==='string'?body.requestId:crypto.randomUUID();
  const previous=pendingPlatformConnection();
  if(previous&&previous!==requestId){
    onWaiting?.(previous);
    const prior=await platformConnectionResult(previous,request);
    if(prior.state==='waiting')throw Error('진행 중인 계정 확인을 먼저 마치세요. 같은 요청 결과를 확인합니다.');
  }
  try{localStorage.setItem(key,requestId);}catch{}
  onWaiting?.(requestId);
  let result:any;
  try{result=await request(PLATFORM_CLI_PATH,{...body,requestId});}
  catch(error){
    if((error as {serverRejected?:boolean})?.serverRejected)try{if(localStorage.getItem(key)===requestId)localStorage.removeItem(key);}catch{}
    // A lost admission reply never starts another check or login.
    throw Error('확인 결과를 받지 못했습니다. 키체인 확인창을 직접 처리한 뒤 ‘같은 계정 확인 결과 보기’를 누르세요. 새 로그인을 시작하지 않았습니다.');
  }
  return finish(result.connection);
}
export async function platformConnectionResult(id:string,request=terminalLocalRequest):Promise<PlatformCliOperationView>{
  const r=await request(PLATFORM_CLI_PATH,{operation:'connection-status',requestId:id});return finish(r.connection);
}
function finish(connection:PlatformCliOperationView){if(connection.state!=='waiting')try{if(localStorage.getItem(key)===connection.id)localStorage.removeItem(key);}catch{}return connection;}
