export const TESTER_ENDPOINT = '/api/agent-runtime/tester';
export const TESTER_OPERATIONS = ['status','plan','apply','start','read','cancel','handoff'] as const;
export type TesterOperation = typeof TESTER_OPERATIONS[number];
export interface TesterTarget { portId: string; workspaceTargetId?: string }
export interface TesterRequest extends TesterTarget {
  operation: TesterOperation;
  revision?: string; requestId?: string; profileId?: string; runId?: string;
  mode?: 'configure' | 'repair';
}
export interface TesterCheck { id:string; state:string; durationSeconds?:number; reason?:string; output?:string; evidence?:string }
export interface TesterReport { runId:string; state:string; profile:string; startedAt:string; finishedAt?:string; sourceUnchanged?:boolean; checks:TesterCheck[]; source?:{commit?:string; fingerprint?:string}; limits?:string[] }
export interface TesterRun { id:string; state:string; profileId:string; createdAt:string; finishedAt?:string; message?:string; report?:TesterReport; origin:'app'|'local-cli' }
export interface TesterStatus {
  installation:string; installedVersion?:string|null; availableVersion:string; configurationRevision:string;
  profiles:{id:string; checks:string[]; configured:boolean}[]; defaultProfile:string|null;
  pythonVersion?:string; environmentReady:boolean; problem?:string;
  latest:TesterReport|null; latestRun?:TesterRun|null; active:TesterRun|null; freshness:string; instructionsConnected:boolean;
  memoryLinked:boolean; limitations:string[];
  targets:{id:string; label:string}[];
}
export interface TesterResult { status?:TesterStatus; plan?:{revision:string; files:string[]; recovering:boolean}; applied?:boolean; run?:TesterRun; handoff?:string; files?:string[] }
export class TesterError extends Error {
  constructor(readonly code:string, message:string, readonly status=409) { super(message); }
}
const fields:Record<TesterOperation,string[]> = {status:[],plan:[],apply:['revision'],start:['revision','requestId','profileId'],read:['runId'],cancel:['runId'],handoff:['mode','runId']};
export function parseTesterRequest(input:unknown):TesterRequest {
  const r=input as TesterRequest;
  const bad=()=>{throw new TesterError('TESTER_REQUEST_INVALID','테스터 요청을 확인하세요.',400);};
  if(!r||typeof r!=='object'||Array.isArray(r)||!TESTER_OPERATIONS.includes(r.operation)) return bad();
  if(Object.keys(r).some(k=>!['operation','portId','workspaceTargetId',...fields[r.operation]].includes(k)))return bad();
  if(typeof r.portId!=='string'||!r.portId.trim()||r.portId.length>200||/[\x00-\x1f]/.test(r.portId))return bad();
  if(r.workspaceTargetId!==undefined&&(typeof r.workspaceTargetId!=='string'||!/^[-\w]{8,128}$/.test(r.workspaceTargetId)))return bad();
  if(['apply','start'].includes(r.operation)&&(typeof r.revision!=='string'||!/^[a-f0-9]{64}$/.test(r.revision)))return bad();
  if(r.operation==='start'&&(typeof r.profileId!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.profileId)||typeof r.requestId!=='string'||!/^test_\d{13}_[a-f0-9-]{36}$/.test(r.requestId)))return bad();
  if(['read','cancel'].includes(r.operation)&&r.runId===undefined)return bad();
  if(r.runId!==undefined&&(typeof r.runId!=='string'||!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(r.runId)))return bad();
  if(r.operation==='handoff'&&!['configure','repair'].includes(r.mode!))return bad();
  return {...r};
}
export function testerRequestId():string {return `test_${Date.now()}_${crypto.randomUUID()}`;}
export const testerActive=(s:string)=>['queued','starting','running','canceling'].includes(s);
