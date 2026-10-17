import {commonMemoryHash} from './commonMemory';
export type CommonMemoryIntent={kind:'manage'|'report'|'projects-add';scopeId:string;groupId:string;requestId:string;requestHash:string;createdAt:number};
const key='agentstoz-common-memory-intents-v1';
const payloads=new Map<string,{operation:string;input:any}>();
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const commonMemoryRequestHash=(input:unknown)=>commonMemoryHash(JSON.stringify(canonical(input)));
/** Only identifiers and hashes survive a reload. No memory body, path, credential or prompt is stored. */
export function readCommonMemoryIntents():CommonMemoryIntent[]{
  try{const raw=localStorage.getItem(key);if(!raw)return [];if(raw.length>16000)throw Error('size');const v=JSON.parse(raw);if(!Array.isArray(v)||v.length>16||v.some(i=>!i||!['manage','report','projects-add'].includes(i.kind)||!Number.isFinite(i.createdAt)||!/^[a-f0-9]{64}$/.test(i.scopeId)||!/^[a-f0-9]{64}$/.test(i.requestHash)||!/^[-a-f0-9]{36}$/i.test(i.groupId)||!/^[-a-f0-9]{36}$/i.test(i.requestId)))throw Error('format');return v;}catch{throw Error('미확정 공통기억 요청 기록을 확인하지 못했습니다. 새 저장을 중단했습니다.');}
}
export async function retainCommonMemoryIntent(payload:{operation:string;input:any},scopeId:string,groupId:string,requestId:string){
  const requestHash=await commonMemoryRequestHash(payload.input),all=readCommonMemoryIntents(),prior=all.find(i=>i.requestId===requestId&&i.scopeId===scopeId);
  if(prior&&prior.requestHash!==requestHash)throw Error('같은 공통기억 요청의 내용이 바뀌었습니다.');
  if(!prior){if(all.length>=16)throw Error('미확정 공통기억 결과를 먼저 확인하세요.');all.push({kind:payload.operation as CommonMemoryIntent['kind'],scopeId,groupId,requestId,requestHash,createdAt:Date.now()});localStorage.setItem(key,JSON.stringify(all));}
  payloads.set(requestId,payload);
}
export function forgetCommonMemoryIntent(requestId:string){localStorage.setItem(key,JSON.stringify(readCommonMemoryIntents().filter(i=>i.requestId!==requestId)));payloads.delete(requestId);}
export function commonMemoryIntentPayload(requestId:string){return payloads.get(requestId);}
