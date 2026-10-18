import {sha256} from '@noble/hashes/sha2.js';

/** LAN WebKit exposes secure random bytes but not randomUUID/subtle on HTTP origins. */
export function commonMemoryUuid(api=globalThis.crypto):string {
  if(typeof api?.randomUUID==='function')return api.randomUUID();
  if(typeof api?.getRandomValues!=='function')throw Error('안전한 요청 식별자를 만들 수 없습니다.');
  const bytes=api.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;
  const hex=Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
/** Identical SHA-256 across secure desktop/portal origins and a private LAN page. */
export async function commonMemoryDigest(value:string):Promise<string>{
  const bytes=new TextEncoder().encode(value);
  const result=globalThis.crypto?.subtle?new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)):sha256(bytes);
  return Array.from(result,n=>n.toString(16).padStart(2,'0')).join('');
}
