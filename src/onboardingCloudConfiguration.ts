import {createHash} from 'node:crypto';
import {writePrivateFileAtomically} from './remoteControlHostVault';
import {serviceRoleKeyPath} from '../server-supabase-service';
import type {CloudJob} from './onboardingCloudHost';
import {supabaseApiKeyHeaders} from './supabaseApiKeyHeaders';
export interface CloudConfigurationValue {ref:string;publicKey:string;serviceKey:string;email:string}
export interface CloudConfigurationDependencies {
  appDirectory:string;deviceName:string;withLock<T>(work:()=>Promise<T>):Promise<T>;
  read():Record<string,any>;serviceKey():string|null;guard(next:Record<string,any>,current:Record<string,any>):Record<string,any>;
  write(next:Record<string,any>,current:Record<string,any>):void;assertAccount():void;fetch?:typeof fetch;
}
/** Register the same installation on retry; preserve existing connections and secret ownership. */
export async function saveOnboardingCloudConfiguration(deps:CloudConfigurationDependencies,value:CloudConfigurationValue,job:CloudJob,signal:AbortSignal){
  if(!/^[a-z0-9]{20}$/.test(value.ref)||value.ref!==job.ref)throw Error('원래 전용 저장소를 확인하세요.');
  return deps.withLock(async()=>{
    signal.throwIfAborted();deps.assertAccount();const current=deps.read(),url=`https://${value.ref}.supabase.co`;
    if(current.supabaseUrl&&current.supabaseUrl!==url)throw Error('기존 저장소 연결을 보존합니다.');
    const checkKey=()=>{const key=deps.serviceKey();if(key&&key!==value.serviceKey)throw Error('기존 관리자 연결을 보존합니다.');};checkKey();
    const hash=createHash('sha256').update('onboarding-device:'+job.id).digest('hex');
    const id=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
    const next=deps.guard({...current,supabaseUrl:url,supabaseAnonKey:value.publicKey,deviceId:current.deviceId||id,deviceName:current.deviceName||deps.deviceName,allowedEmails:current.supabaseUrl===url&&Array.isArray(current.allowedEmails)?[...new Set([...current.allowedEmails.filter((v:unknown)=>typeof v==='string'),value.email])]:[value.email]},current);
    const response=await(deps.fetch??fetch)(url+'/rest/v1/portmgr_devices?on_conflict=id',{method:'POST',headers:{...supabaseApiKeyHeaders(value.serviceKey),'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({id:next.deviceId,name:next.deviceName,last_push_at:new Date().toISOString()}),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])});
    if(!response.ok)throw Error('새 기기 등록 결과를 확인하지 못했습니다.');await response.body?.cancel();
    signal.throwIfAborted();deps.assertAccount();checkKey();
    writePrivateFileAtomically(deps.appDirectory,serviceRoleKeyPath(deps.appDirectory),JSON.stringify({serviceRoleKey:value.serviceKey}));
    deps.write({...next,pendingDeviceRegistration:false,deviceRegisteredAt:new Date().toISOString()},current);
  });
}
