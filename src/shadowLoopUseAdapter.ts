import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {WorkroomThreadStore,type StoredWorkroomThread} from './workroomThreadStore';
import type {ServiceUseAdapter} from './serviceUseHost';
import {normalizeServiceUseOutcome,SERVICE_USE_TOOLS,type ServiceUseBinding,type ServiceUseOutcome} from './serviceUseProtocol';

export const SHADOWLOOP_USE_REVISION='shadowloop-use-v1';
const CODE=/^SLUSE1\.([a-f0-9-]{36})\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
type Scope=Pick<ServiceUseBinding,'principalId'|'libraryId'|'deviceId'|'installationId'|'grantRevision'>;
const scopeFields=['principalId','libraryId','deviceId','installationId','grantRevision'] as const;

/** Fixed installed-app endpoint, explicit capability, encrypted local vault. No URL/path/CLI input. */
export class ShadowLoopUseConnector {
 private vault?:WorkroomThreadStore;
 private root:string;
 constructor(appDataDir:string,private deps:{vault?:WorkroomThreadStore;fetch?:typeof fetch}={}){
  this.root=join(appDataDir,'shadowloop-use-connection');this.vault=deps.vault;
 }
 private storage(){return this.vault??=new WorkroomThreadStore(this.root);}
 private id(projectId:string){return 'shadowloop_'+hash(projectId);}
 private async post(code:string,operation:'scope'|'execute'|'receipt',body:unknown,active:()=>boolean){
  if(!CODE.test(code)||!active())throw Error('ShadowLoop 운영 연결을 확인하세요.');
  const match=CODE.exec(code)!,key=Buffer.from(hash(match[3]!),'hex'),serialized=JSON.stringify(body),nonce=randomUUID(),stamp=String(Date.now());
  const signature=createHmac('sha256',key).update(`SLUSE1\n${operation}\n${stamp}\n${nonce}\n${hash(serialized)}`).digest('hex');
  try{
  let response:Response;
  try{response=await (this.deps.fetch??fetch)('http://127.0.0.1:8127/api/service-use/'+operation,{
   method:'POST',redirect:'error',headers:{'Content-Type':'application/json','x-shadowloop-use-grant':match[1]+'.'+match[2],
    'x-shadowloop-use-nonce':nonce,'x-shadowloop-use-time':stamp,'x-shadowloop-use-signature':signature},
   body:serialized,signal:AbortSignal.timeout(10_000),
  });}catch{throw Error('ShadowLoop 앱을 열고 AI 운영 연결을 확인하세요. 응답이 유실된 작업은 원래 요청 ID로 조회하세요.');}
  if(!active()||!response.ok||response.headers.has('location'))throw Error('ShadowLoop 운영 연결·현재 프로필·원래 작업 ID를 확인하세요.');
  const reader=response.body?.getReader();let text='',bytes=0;
  if(!reader)throw Error('ShadowLoop 응답을 확인하지 못했습니다.');
  const decoder=new TextDecoder();
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>12_000)throw Error('bounded');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
  catch{await reader.cancel().catch(()=>{});throw Error('ShadowLoop 응답 형식을 확인하세요.');}
  if(!active())throw Error('USE 연결 권한이 변경되었습니다.');
  const proof=response.headers.get('x-shadowloop-use-proof')??'',expected=createHmac('sha256',key).update(`reply\n${nonce}\n${hash(text)}`).digest();
  if(!/^[a-f0-9]{64}$/.test(proof)||!timingSafeEqual(Buffer.from(proof,'hex'),expected))throw Error('이 ShadowLoop 설치의 응답 서명을 확인하지 못했습니다.');
  try{return JSON.parse(text);}catch{throw Error('ShadowLoop 응답 형식을 확인하세요.');}
  }finally{key.fill(0);}
 }
 private async snapshot(code:string,active:()=>boolean):Promise<{scope:Scope;phones:{id:string;name:string}[]}>{
  const data=await this.post(code,'scope',{},active),match=CODE.exec(code)!;
  if(data?.app!=='shadowloop'||data.definitionRevision!==SHADOWLOOP_USE_REVISION
   ||!Array.isArray(data.tools)||data.tools.length!==SERVICE_USE_TOOLS.length||SERVICE_USE_TOOLS.some(t=>!data.tools.includes(t))
   ||!data.scope||Object.keys(data.scope).length!==scopeFields.length||scopeFields.some(k=>typeof data.scope[k]!=='string'||!data.scope[k]||data.scope[k].length>256)
   ||data.scope.installationId!==match[1]||data.scope.grantRevision!==match[2])throw Error('이 ShadowLoop 설치의 운영 계약을 검증하지 못했습니다.');
  if(!Array.isArray(data.phones)||data.phones.length>256||new Set(data.phones.map((p:any)=>p?.id)).size!==data.phones.length||data.phones.some((p:any)=>!p||Object.keys(p).sort().join(',')!=='id,name'||typeof p.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>80||/[\u0000-\u001f\u007f]/.test(p.name)))throw Error('이 프로필의 승인 폰 목록을 확인하지 못했습니다.');
  return {scope:Object.fromEntries(scopeFields.map(k=>[k,data.scope[k]])) as Scope,phones:data.phones.map((p:any)=>({id:p.id,name:p.name}))};
 }
 async connect(projectId:string,code:string,consent:boolean){
  if(!consent||typeof code!=='string'||!CODE.test(code))throw Error('ShadowLoop에서 발급한 운영 연결 코드와 등록 동의를 확인하세요.');
  const {scope}=await this.snapshot(code,()=>true),id=this.id(projectId),at=new Date().toISOString();
  await this.storage().mutate(id,()=>true,prior=>{
   const record:StoredWorkroomThread={id,targetId:projectId,owner:'local',fingerprint:hash(JSON.stringify(scope)),bootId:'shadowloop-use',intentHash:hash(code),
    title:'ShadowLoop USE connection',agent:'codex',sessionId:null,state:'closed',revision:(prior?.revision??0)+1,createdAt:prior?.createdAt??at,updatedAt:at,
    messages:[{id:'capability',seq:1,role:'system',kind:'notice',text:code,at,delivery:'recorded'}]};
   return {record,value:null};
  });
  return {connected:true};
 }
 async adapter(projectId:string,serviceKey:string):Promise<ServiceUseAdapter|undefined>{
  if(serviceKey!=='default')return undefined;
  if(!this.vault&&!existsSync(join(this.root,'workroom-threads.v1.sqlite')))return undefined;
  const record=await this.storage().get(this.id(projectId));
  if(!record)return undefined;
  const code=record.messages[0]?.text;
  if(record.targetId!==projectId||record.owner!=='local'||typeof code!=='string'||!CODE.test(code))throw Error('ShadowLoop 연결 저장소를 확인하세요.');
  const same=async()=>{const current=await this.storage().get(record.id);return current?.intentHash===record.intentHash&&current.revision===record.revision;};
  const result=async(operation:'execute'|'receipt',body:unknown,active:()=>boolean):Promise<ServiceUseOutcome>=>{
   if(!await same()||!active())throw Error('ShadowLoop 운영 연결이 변경되었습니다.');
   const data=await this.post(code,operation,body,active);
   if(!await same()||!active())throw Error('ShadowLoop 운영 연결이 변경되었습니다. 원래 요청을 확인하세요.');
   return normalizeServiceUseOutcome(data?.outcome);
  };
  return {projectId,serviceKey,definitionRevision:SHADOWLOOP_USE_REVISION,tools:SERVICE_USE_TOOLS,
   scope:async owner=>{if(owner!=='local'||!await same())throw Error('이 ShadowLoop 연결은 이 Mac의 로컬 사용자 전용입니다.');return (await this.snapshot(code,()=>true)).scope;},
   phoneTargets:async owner=>{if(owner!=='local'||!await same())throw Error('이 ShadowLoop 연결은 이 Mac의 로컬 사용자 전용입니다.');return (await this.snapshot(code,()=>true)).phones;},
   execute:(call,requestId,binding,active)=>result('execute',{call,requestId,binding},active),
   receipt:(requestId,binding,active)=>result('receipt',{requestId,binding},active),
  };
 }
}
