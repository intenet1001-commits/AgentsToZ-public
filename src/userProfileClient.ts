import {isTauri} from '@tauri-apps/api/core';

/** Local desktop management only. No cloud endpoint or remote controller fallback. */
export async function requestUserProfile(body:Record<string,unknown>,signal?:AbortSignal){
 const response=await fetch(`${isTauri()?'http://127.0.0.1:3001':''}/api/user-profile`,{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal??AbortSignal.timeout(15_000),
 });
 const result=await response.json();
 if(!response.ok||result.success!==true){
  throw Object.assign(new Error(typeof result.error==='string'?result.error:'내 프로필을 확인하지 못했습니다.'),{status:response.status,code:result.code});
 }
 return result;
}
