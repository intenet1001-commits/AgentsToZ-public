import {MOBILE_TESTER_ACTIONS,normalizeMobileTesterResult,testerProfileId,testerRunId,type MobileTesterAction,type MobileTesterResult} from './mobileTesterProtocol';
import {validWorkroomSessionStatus,type WorkroomSessionStatus} from './workroomSessionStatus';
/** Same-owner workspace operations over the existing encrypted connection.
 * Protocol support never grants access; durable consent is checked on the host. */
export const MOBILE_WORKSPACE_FEATURE = 'workspace-v1';
export const MOBILE_WORKSPACE_SCOPES = ['records.read', 'memory.save', 'duty.manage', 'worktree.manage', 'tester.read', 'tester.run'] as const;
export type MobileWorkspaceScope = typeof MOBILE_WORKSPACE_SCOPES[number];
export type MobileWorkspaceOperation = MobileTesterAction | 'said.list' | 'said.read' | 'memory.status' | 'memory.save' | 'workroom.status' | 'workroom.save' | 'duty.status' | 'duty.enable' | 'duty.disable' | 'duty.diagnose' | 'worktree.review' | 'worktree.remove';
export interface MobileWorkspaceRequest {
  operation: 'workspace'; requestId: string; targetId: string;
  workspace: { action: MobileWorkspaceOperation; profileId?:string; revisionHash?:string; testRequestId?:string; runId?:string; sessionId?:string; saveRequestId?:string; query?: string; beforeSeq?: string; connectionId?: string; revision?: number; knowledgeRevision?: number; consent?: boolean; reviewToken?:string; recordId?:string; offset?:number; textHash?:string };
}
export interface MobileWorkspaceRecord { id: string; text: string; recordedAt: string; agent: string; deviceName: string | null; origin: string; truncated: boolean; textHash:string }
export interface MobileWorkspaceDuty { id: string; title: string; alias: string; profile: string; state: string; revision: number; knowledgeRevision: number; replied: number; checkedAt: number | null }
export interface MobileWorkspaceResult {
  kind: 'workspace'; action: MobileWorkspaceOperation;
  records?: MobileWorkspaceRecord[]; nextBeforeSeq?: string | null; hasMore?: boolean; source?: 'local' | 'supabase'; captureAt?: string | null;
  nextOffset?:number|null; scanComplete?:boolean;
  connections?: MobileWorkspaceDuty[]; supported?: boolean; checks?: {name:string;ok:boolean;detail:string}[];
  cleanup?:{token:string;branch:string;message:string};
  memory?: {state:string; localSaved:boolean; backupSaved:boolean; message:string};
  workroom?:WorkroomSessionStatus; tester?:MobileTesterResult;
}
export function workspaceScope(action: MobileWorkspaceOperation): MobileWorkspaceScope {
  const scopes:Record<MobileWorkspaceOperation,MobileWorkspaceScope>={
    'said.list':'records.read','said.read':'records.read','memory.status':'memory.save','memory.save':'memory.save','workroom.status':'memory.save','workroom.save':'memory.save',
    'duty.status':'duty.manage','duty.enable':'duty.manage','duty.disable':'duty.manage','duty.diagnose':'duty.manage','worktree.review':'worktree.manage','worktree.remove':'worktree.manage',
    'tester.status':'tester.read','tester.read':'tester.read','tester.start':'tester.run','tester.cancel':'tester.run',
  };
  if(!Object.hasOwn(scopes,action))throw new Error('지원하지 않는 모바일 작업입니다.');
  return scopes[action];
}
export function normalizeWorkspaceScopes(value: unknown): MobileWorkspaceScope[] {
  if (!Array.isArray(value) || value.length > MOBILE_WORKSPACE_SCOPES.length || value.some(s => !MOBILE_WORKSPACE_SCOPES.includes(s)) || new Set(value).size !== value.length) throw new Error('모바일 작업 권한을 확인하세요.');
  if(value.includes('tester.run')&&!value.includes('tester.read'))throw new Error('테스트 실행에는 결과 조회 권한도 필요합니다.');
  return [...value];
}
const cursor = (v:unknown):v is string => typeof v==='string' && v.length<=2048 && /^(?:wisr1_\d{1,25}|wisg1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(v);
export function normalizeMobileWorkspaceRequest(value: unknown): MobileWorkspaceRequest {
  const fail = (): never => { throw new Error('모바일 작업 요청 형식이 올바르지 않습니다.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const r=value as MobileWorkspaceRequest, w=r.workspace;
  if(r.operation!=='workspace'||!id(r.requestId)||!id(r.targetId)||Object.keys(r).some(k=>!['operation','requestId','targetId','workspace'].includes(k))||!w||typeof w!=='object'||Array.isArray(w))return fail();
  const fields: Record<MobileWorkspaceOperation,string[]> = {'tester.status':[],'tester.start':['profileId','revisionHash','testRequestId'],'tester.read':['runId'],'tester.cancel':['runId'],'said.list':['query','beforeSeq'],'said.read':['query','beforeSeq','recordId','offset','textHash'],'memory.status':[],'memory.save':[],'workroom.status':['sessionId','saveRequestId'],'workroom.save':['sessionId'],'duty.status':[],'duty.enable':['connectionId','revision','knowledgeRevision','consent'],'duty.disable':['connectionId'],'duty.diagnose':['connectionId'],'worktree.review':[],'worktree.remove':['reviewToken','consent']};
  if(!Object.hasOwn(fields,w.action)||Object.keys(w).some(k=>k!=='action'&&!fields[w.action].includes(k)))return fail();
  if(w.action==='tester.start'&&(!testerProfileId(w.profileId)||typeof w.revisionHash!=='string'||!/^[a-f0-9]{64}$/.test(w.revisionHash)||typeof w.testRequestId!=='string'||!/^test_\d{13}_[a-f0-9-]{36}$/.test(w.testRequestId)))return fail();
  if(['tester.read','tester.cancel'].includes(w.action)&&!testerRunId(w.runId))return fail();
  if(w.action.startsWith('workroom.')&&(!id(w.sessionId)||w.saveRequestId!==undefined&&!id(w.saveRequestId)))return fail();
  if(w.query!==undefined&&(typeof w.query!=='string'||w.query.length>300))return fail();
  if(w.beforeSeq!==undefined&&(!cursor(w.beforeSeq)))return fail();
  if(['duty.enable','duty.disable','duty.diagnose'].includes(w.action)&&!id(w.connectionId))return fail();
  if(w.action==='duty.enable'&&(w.consent!==true||!Number.isSafeInteger(w.revision)||w.revision!<0||!Number.isSafeInteger(w.knowledgeRevision)||w.knowledgeRevision!<0))return fail();
  if(w.action==='said.read'&&(!id(w.recordId)||!Number.isSafeInteger(w.offset)||w.offset!<0||w.offset!>200000||typeof w.textHash!=='string'||!/^[a-f0-9]{64}$/.test(w.textHash)))return fail();
  if(w.action==='worktree.remove'&&(!id(w.reviewToken)||w.consent!==true))return fail();
  return r;
}
export function normalizeMobileWorkspaceResult(value: unknown): MobileWorkspaceResult {
  const r=value as MobileWorkspaceResult;
  if(!r||typeof r!=='object'||Array.isArray(r)||r.kind!=='workspace'||![...MOBILE_TESTER_ACTIONS,'said.list','said.read','memory.status','memory.save','workroom.status','workroom.save','duty.status','duty.enable','duty.disable','duty.diagnose','worktree.review','worktree.remove'].includes(r.action)||Object.keys(r).some(k=>!['kind','action','records','nextBeforeSeq','hasMore','source','captureAt','connections','supported','checks','memory','cleanup','nextOffset','scanComplete','workroom','tester'].includes(k))||new TextEncoder().encode(JSON.stringify(r)).length>8500)throw new Error('모바일 작업 응답 형식이 올바르지 않습니다.');
  if(r.action.startsWith('tester.')){if(!r.tester||Object.keys(r).some(k=>!['kind','action','tester'].includes(k)))throw new Error('테스터 응답 형식 오류');normalizeMobileTesterResult(r.tester);}else if(r.tester!==undefined)throw new Error('테스터 응답 형식 오류');
  if(r.records!==undefined&&(!Array.isArray(r.records)||r.records.length>3||r.records.some(x=>!x||!id(x.id)||typeof x.text!=='string'||typeof x.recordedAt!=='string'||typeof x.agent!=='string'||typeof x.origin!=='string'||typeof x.truncated!=='boolean'||typeof x.textHash!=='string'||!/^[a-f0-9]{64}$/.test(x.textHash)||!(x.deviceName===null||typeof x.deviceName==='string')||Object.keys(x).some(k=>!['id','text','recordedAt','agent','deviceName','origin','truncated','textHash'].includes(k)))))throw new Error('발언 조회 응답을 확인하지 못했습니다.');
  if(r.connections!==undefined&&(!Array.isArray(r.connections)||r.connections.length>8||r.connections.some(c=>!c||!id(c.id)||typeof c.title!=='string'||typeof c.alias!=='string'||typeof c.profile!=='string'||typeof c.state!=='string'||!Number.isSafeInteger(c.revision)||!Number.isSafeInteger(c.knowledgeRevision)||!Number.isSafeInteger(c.replied)||!(c.checkedAt===null||Number.isFinite(c.checkedAt))||Object.keys(c).some(k=>!['id','title','alias','profile','state','revision','knowledgeRevision','replied','checkedAt'].includes(k)))))throw new Error('대직 상태 응답을 확인하지 못했습니다.');
  if(r.hasMore!==undefined&&typeof r.hasMore!=='boolean'||r.source!==undefined&&!['local','supabase'].includes(r.source)||r.nextBeforeSeq!==undefined&&r.nextBeforeSeq!==null&&!cursor(r.nextBeforeSeq)||r.captureAt!==undefined&&r.captureAt!==null&&(typeof r.captureAt!=='string'||!Number.isFinite(Date.parse(r.captureAt))))throw new Error('기록 페이지 응답을 확인하지 못했습니다.');
  if(r.nextOffset!==undefined&&r.nextOffset!==null&&(!Number.isSafeInteger(r.nextOffset)||r.nextOffset<0||r.nextOffset>200000)||r.scanComplete!==undefined&&typeof r.scanComplete!=='boolean')throw new Error('발언 상세 응답 오류');
  if(r.supported!==undefined&&typeof r.supported!=='boolean')throw new Error('지원 상태 응답 오류');
  if(r.checks!==undefined&&(!Array.isArray(r.checks)||r.checks.length>20||r.checks.some(c=>!c||typeof c.name!=='string'||typeof c.ok!=='boolean'||typeof c.detail!=='string'||Object.keys(c).some(k=>!['name','ok','detail'].includes(k)))))throw new Error('진단 응답 오류');
  if(r.cleanup!==undefined&&(!r.cleanup||typeof r.cleanup.token!=='string'||typeof r.cleanup.branch!=='string'||typeof r.cleanup.message!=='string'||Object.keys(r.cleanup).some(k=>!['token','branch','message'].includes(k))))throw new Error('워크트리 정리 응답 오류');
  if(r.workroom!==undefined&&!validWorkroomSessionStatus(r.workroom))throw new Error('워크룸 저장 상태 응답 오류');
  if(r.memory!==undefined&&(!r.memory||typeof r.memory.state!=='string'||typeof r.memory.localSaved!=='boolean'||typeof r.memory.backupSaved!=='boolean'||typeof r.memory.message!=='string'||Object.keys(r.memory).some(k=>!['state','localSaved','backupSaved','message'].includes(k))))throw new Error('기억 상태 응답 오류');
  return r;
}
