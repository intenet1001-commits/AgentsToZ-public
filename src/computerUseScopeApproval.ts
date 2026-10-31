import {randomBytes,verify} from 'node:crypto';
import {COMPUTER_USE_APPROVAL_LIMITS as L,computerApprovalKey} from './computerUseApproval';
import {computerCallerGeneration,isLiveComputerCallerGeneration,type AuthenticatedComputerCaller} from './computerUseCaller';
import {parseComputerCaller} from './computerUseProtocol';
import {COMPUTER_USE_SCOPE_PERMISSIONS,parseComputerUseScope,sameComputerUseScope,type ComputerUseScope} from './computerUseScopeProtocol';

export const COMPUTER_USE_SCOPE_APPROVAL_DOMAIN='agentstoz-computer-use-scope/v2';
/** The signed approval's own window: the request deadline plus skew, with 10 s of margin (native ComputerUseScopeApproval.maxGrantMs). */
export const COMPUTER_USE_SCOPE_APPROVAL_MAX_MS=610_000;
export interface ScopeOwner {pid:number;start:string}
export interface ScopeCaller {sessionId:string;lane:string;generation:string}
export interface ScopeApproval {version:2;approvalId:string;scope:ComputerUseScope;permissions:readonly string[];caller:ScopeCaller;owner:ScopeOwner;issuedAt:number;expiresAt:number;signature:string}
type Request={approvalId:string;scope:ComputerUseScope;caller:ScopeCaller;owner:ScopeOwner;expiresAt:number;label:string};
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,any>,keys:string[])=>Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
export function parseScopeOwner(value:unknown):ScopeOwner {
  if(!plain(value)||!exact(value,['pid','start'])||!Number.isSafeInteger(value.pid)||value.pid<1||value.pid>2147483647||typeof value.start!=='string'||! /^[1-9][0-9]{0,19}$/.test(value.start))throw Error('도우미의 앱 연결을 확인하지 못했습니다.');
  return {pid:value.pid,start:value.start};
}
export function parseScopeCaller(value:unknown):ScopeCaller {
  if(!plain(value)||!exact(value,['sessionId','lane','generation'])||typeof value.generation!=='string'||! /^[a-f0-9]{32}$/.test(value.generation))throw Error('AI 연결을 확인하지 못했습니다.');
  return {...parseComputerCaller({sessionId:value.sessionId,lane:value.lane}),generation:value.generation};
}
/** `expiresAt` is the request deadline (10 min) by which the grant must open, not the grant's lifetime (Control's own). */
export function parseScopeApproval(value:unknown):ScopeApproval {
  if(!plain(value)||!exact(value,['version','approvalId','scope','permissions','caller','owner','issuedAt','expiresAt','signature'])||value.version!==2||typeof value.approvalId!=='string'||! /^[a-f0-9]{64}$/.test(value.approvalId)
    ||!Array.isArray(value.permissions)||JSON.stringify(value.permissions)!==JSON.stringify(COMPUTER_USE_SCOPE_PERMISSIONS)
    ||!Number.isSafeInteger(value.issuedAt)||value.issuedAt<0||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=value.issuedAt||value.expiresAt-value.issuedAt>COMPUTER_USE_SCOPE_APPROVAL_MAX_MS
    ||typeof value.signature!=='string'||! /^[A-Za-z0-9+/]{16,200}={0,2}$/.test(value.signature))throw Error('범위 승인을 확인하지 못했습니다.');
  return {version:2,approvalId:value.approvalId,scope:parseComputerUseScope(value.scope),permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS],caller:parseScopeCaller(value.caller),owner:parseScopeOwner(value.owner),issuedAt:value.issuedAt,expiresAt:value.expiresAt,signature:value.signature};
}
/** Exact domain-separated P-256/SHA-256 signed bytes; never reuse v1 for a broader scope. */
export function computerScopeApprovalBytes(value:Omit<ScopeApproval,'signature'>):Buffer {
  const a=parseScopeApproval({...value,signature:'AAAAAAAAAAAAAAAA'});const app=a.scope.kind==='application'?a.scope.application:null;
  return Buffer.from([COMPUTER_USE_SCOPE_APPROVAL_DOMAIN,`approval=${a.approvalId}`,`scope=${a.scope.kind}`,`bundle=${app?.bundleId??'-'}`,`team=${app?.teamId??'-'}`,`code=${app?.codeHash??'-'}`,`pid=${app?.pid??'-'}`,`start=${app?.processStart??'-'}`,
    `permissions=${a.permissions.join(',')}`,`session=${a.caller.sessionId}`,`lane=${a.caller.lane}`,`generation=${a.caller.generation}`,`owner-pid=${a.owner.pid}`,`owner-start=${a.owner.start}`,`issued=${a.issuedAt}`,`expires=${a.expiresAt}`].join('\n')+'\n','utf8');
}
/** The helper's authenticated v2 status supplies expected owner; only its signed status response supplies the key. */
export class ComputerScopeApprovalVerifier {
  private pending=new Map<string,Request>();private used=new Map<string,number>();
  constructor(private readonly now:()=>number=()=>Date.now()){}
  private prune(){for(const [id,r] of this.pending)if(r.expiresAt+5000<this.now()||!isLiveComputerCallerGeneration(r.caller.generation))this.pending.delete(id);for(const [id,t] of this.used)if(t+5000<this.now())this.used.delete(id);}
  request(caller:AuthenticatedComputerCaller,scopeValue:unknown,label:string,ownerValue:unknown):Request {
    const generation=computerCallerGeneration(caller);if(!generation)throw Error('AI 연결이 끝났습니다.');this.prune();
    if(this.pending.size>=8)throw Error('승인을 기다리는 요청이 너무 많습니다.');
    if(typeof label!=='string'||!label.trim()||label.length>100||/[\u0000-\u001f\u007f]/.test(label))throw Error('맡길 작업 이름을 확인하세요.');
    const request={approvalId:randomBytes(32).toString('hex'),scope:parseComputerUseScope(scopeValue),caller:{...caller,generation},owner:parseScopeOwner(ownerValue),expiresAt:this.now()+L.approvalMs,label:label.trim()};
    this.pending.set(request.approvalId,structuredClone(request));return structuredClone(request);
  }
  verify(value:unknown,key:Uint8Array):Request {
    const a=parseScopeApproval(value);this.prune();const request=this.pending.get(a.approvalId);const now=this.now();
    if(!request||this.used.has(a.approvalId)||!isLiveComputerCallerGeneration(request.caller.generation)||now>request.expiresAt||a.expiresAt!==request.expiresAt||a.issuedAt>now+L.skewMs||a.issuedAt<request.expiresAt-L.approvalMs-L.skewMs
      ||!sameComputerUseScope(a.scope,request.scope)||JSON.stringify(a.caller)!==JSON.stringify(request.caller)||JSON.stringify(a.owner)!==JSON.stringify(request.owner))throw Error('범위 승인 대상이나 시간이 일치하지 않습니다.');
    let verified=false;try{verified=verify('sha256',computerScopeApprovalBytes(a),{key:computerApprovalKey(key),dsaEncoding:'der'},Buffer.from(a.signature,'base64'));}catch{}
    if(!verified)throw Error('범위 승인 서명을 확인하지 못했습니다.');return structuredClone(request);
  }
  redeem(id:string){const r=this.pending.get(id);if(!r||this.used.has(id)||r.expiresAt<this.now()||!isLiveComputerCallerGeneration(r.caller.generation))throw Error('범위 승인이 끝났습니다.');this.pending.delete(id);this.used.set(id,r.expiresAt);}
  cancel(id:string){this.pending.delete(id);}
  cancelSession(sessionId:string){for(const[id,r]of this.pending)if(r.caller.sessionId===sessionId)this.pending.delete(id);}
}
