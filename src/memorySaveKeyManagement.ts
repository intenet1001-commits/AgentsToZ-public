import {MemorySaveKeyLifecycleError,type MemorySaveKeyLifecycle,type MemorySaveKeyStatus} from './memorySaveKeyLifecycle';
import type {WorkspaceLease} from './workspaceLease';
export type MemoryKeyOperation='status'|'prepare'|'recover-initial';
export interface MemoryKeyManagementResult {version:1;targetId:string;keyStatus:MemorySaveKeyStatus;automaticSavingChanged:false}
/** Invoked only behind the existing local Agent Runtime capability. Never
 * accepts a key, account, filesystem path, service name or automatic consent. */
export async function manageMemorySaveKey(body:unknown,deps:{
 enabled:()=>boolean;
 resolve:(targetId:string)=>Promise<{validate:()=>Promise<boolean>}|null>;
 identity:(create:boolean)=>string|null;
 service:(installationId:string)=>MemorySaveKeyLifecycle;
 acquire:()=>Promise<WorkspaceLease>;
 release:(lease:WorkspaceLease)=>void;
}):Promise<MemoryKeyManagementResult>{
 const request=body as {keyOperation:MemoryKeyOperation;observationTargetId:string};
 if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(k=>!['keyOperation','observationTargetId'].includes(k))
  ||!['status','prepare','recover-initial'].includes(request.keyOperation)||typeof request.observationTargetId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(request.observationTargetId))throw new Error('키 준비 요청이 올바르지 않습니다.');
 const result=(keyStatus:MemorySaveKeyStatus):MemoryKeyManagementResult=>({version:1,targetId:request.observationTargetId,keyStatus,automaticSavingChanged:false});
 if(!deps.enabled())return result('unsupported');
 let lease:WorkspaceLease|undefined;
 try{
  const target=await deps.resolve(request.observationTargetId);
  if(!target||!await target.validate())throw new Error();
  const valid=async()=>deps.enabled()&&await target.validate()&&deps.enabled();
  if(request.keyOperation==='status'){
   const identity=deps.identity(false),status=identity?deps.service(identity).status():'not-configured';
   if(!await valid())throw new Error();return result(status);
  }
  lease=await deps.acquire();if(!await valid())throw new Error();
  const identity=deps.identity(true);if(!identity)throw new Error();
  return result(await deps.service(identity).prepare(lease,valid,request.keyOperation==='recover-initial'));
 }catch(error){
  if(error instanceof MemorySaveKeyLifecycleError){
   const messages:Record<MemorySaveKeyLifecycleError['code'],string>={
    KEY_LOST:'등록된 암호화 키가 없습니다. 기존 키를 Keychain에서 복원해야 합니다. 새 키로 교체하지 않았습니다.',
    KEY_CHANGED:'등록된 키와 Keychain의 키가 다릅니다. 기존 키와 저장 이력을 보존했습니다.',
    HISTORY_EXISTS:'기존 저장 이력이 있어 새 키를 만들지 않았습니다. 이전 키 복원이 필요합니다.',
    SETUP_INCOMPLETE:'키 초기 설정이 완료되지 않았습니다. 상태를 확인한 뒤 초기 설정 복구를 실행하세요.',
    LEASE_LOST:'다른 저장 작업 또는 프로젝트 변경으로 키 준비를 보류했습니다.',
    UNSUPPORTED:'키 준비는 설치된 Mac 앱에서 사용할 수 있습니다.',
    UNAVAILABLE:'키 상태를 확인하지 못했습니다. Keychain 접근 상태를 확인하세요. 기존 키와 저장 이력은 보존됩니다.',
   };throw new Error(messages[error.code]);
  }
  throw new Error('프로젝트 또는 키 저장소를 확인하지 못했습니다. 기존 키와 저장 이력은 보존됩니다.');
 }finally{if(lease)deps.release(lease);}
}
