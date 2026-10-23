import {isWorkroomEffortMode,type WorkroomEffortMode} from './workroomEffortMode';
import {WORKROOM_THREAD_ACTIONS,isWorkroomThreadAction,normalizeWorkroomThreadRequest,normalizeWorkroomThreadResult,type WorkroomThreadAction,type WorkroomThreadRequest,type WorkroomThreadResult} from './workroomThreadProtocol';
import {commonMemoryText,commonMemoryId,type CommonMemorySelection} from './commonMemory';
import {COMMON_MEMORY_REMOTE_TARGET} from './commonMemoryRequest';
import {META_MEMORY_REMOTE_TARGET,normalizeMetaMemoryRemoteRequest,normalizeMetaMemoryRemoteResponse,type MetaMemoryRemoteRequest,type MetaMemoryRemoteResponse} from './metaCommonMemoryRemoteProtocol';
import {normalizeVoiceRequest,normalizeVoiceResponse,type VoiceRequest,type VoiceResponse} from './voiceSessionProtocol';
import {MOBILE_TESTER_ACTIONS,normalizeMobileTesterResult,testerProfileId,testerRunId,type MobileTesterAction,type MobileTesterResult} from './mobileTesterProtocol';
import {validWorkroomSessionStatus,type WorkroomSessionStatus} from './workroomSessionStatus';
import {normalizeRemoteVocReceipt,normalizeRemoteVocSubmission,type RemoteVocReceipt,type RemoteVocSubmission} from './vocAttachments';
import {normalizeRemoteVocInbox,type RemoteVocInbox} from './vocInboxSummary';
import {isCommunityDeviceRef,normalizeRemoteCommunityProjects,normalizeRemoteCommunityState,normalizeRemoteCommunityText,type RemoteCommunityProjects,type RemoteCommunityState} from './remoteCommunity';
import {REMOTE_HISTORY_ACTIONS,isRemoteHistoryAction,normalizeRemoteHistoryRequest,normalizeRemoteHistoryResult,type RemoteHistoryAction,type RemoteHistoryRequest,type RemoteHistoryResult} from './workroomHistoryRemoteProtocol';
import {WORKROOM_ATTACH_ACTIONS,isWorkroomAttachAction,normalizeWorkroomAttachmentRequest,normalizeWorkroomAttachmentResult,type WorkroomAttachAction,type WorkroomAttachmentRequest,type WorkroomAttachmentResult} from './workroomRemoteAttachmentProtocol';
import {normalizeWorkroomEffortView,type WorkroomEffortView} from './workroomEffortView';
/** Same-owner workspace operations over the existing encrypted connection.
 * Protocol support never grants access; durable consent is checked on the host. */
import {DEVICE_MEMORY_TARGET} from './deviceOperatingMemoryProtocol';
export const MOBILE_WORKSPACE_FEATURE = 'workspace-v1';
export const MOBILE_WORKSPACE_SCOPES = ['records.read', 'memory.save', 'duty.manage', 'worktree.manage', 'tester.read', 'tester.run', 'voice.use', 'account.select', 'meta-memory.manage', 'ops-memory.manage', 'common-memory.manage', 'projects.add'] as const;
export type MobileWorkspaceScope = typeof MOBILE_WORKSPACE_SCOPES[number];
export const MOBILE_WORKSPACE_SCOPE_LABELS:Record<MobileWorkspaceScope,string> = {
  'account.select':'CLI 계정 선택',
  'common-memory.manage':'클라우드 공통기억 전체 조회·관리',
  'projects.add':'공통기억의 프로젝트 Clone·등록',
  'ops-memory.manage':'이 아젠투지의 기기 운영기억 조회·저장',
  'meta-memory.manage':'메타 공통 기억 전체 조회·관리 (이 Mac 전체)',
  'voice.use':'음성 입력·실시간 대화',
  'records.read':'내가 한 말 조회',
  'memory.save':'세션 기억 저장',
  'duty.manage':'승인된 대직 방 관리',
  'worktree.manage':'병합된 워크트리 정리',
  'tester.read':'테스트 결과 조회',
  'tester.run':'테스트 실행·검사 취소',
};
export type MobileWorkspaceOperation = WorkroomThreadAction | 'common-memory.bind' | 'common-memory' | 'meta-memory' | 'device-memory' | 'voice' | MobileTesterAction | 'said.list' | 'said.read' | 'memory.status' | 'memory.save' | 'workroom.status' | 'workroom.save' | 'workroom.effort' | 'duty.status' | 'duty.enable' | 'duty.disable' | 'duty.diagnose' | 'worktree.review' | 'worktree.remove' | 'voc.submit' | 'voc.inbox' | RemoteHistoryAction | WorkroomAttachAction | 'community.status' | 'community.read' | 'community.send' | 'community.projects';
export interface MobileWorkspaceRequest {
  operation: 'workspace'; requestId: string; targetId: string;
  workspace: { action: MobileWorkspaceOperation; thread?:WorkroomThreadRequest; history?:RemoteHistoryRequest; common?:{expectedEmpty?:boolean;projectGoal:string;groupIds:string[];expectedSelections?:CommonMemorySelection[]}; meta?:MetaMemoryRemoteRequest; voice?:VoiceRequest; profileId?:string; revisionHash?:string; testRequestId?:string; runId?:string; sessionId?:string; saveRequestId?:string; query?: string; beforeSeq?: string; connectionId?: string; revision?: number; knowledgeRevision?: number; consent?: boolean; reviewToken?:string; recordId?:string; offset?:number; textHash?:string; voc?:RemoteVocSubmission; text?:string; afterSeq?:number; deviceRef?:string; page?:number;
    /** `attachments.receive`: the transit items; `attachments.status`: `{receiveId}`; `attachments.rebind`/`.release`: `{receiveId, ids}`
     *  (w13, src/workroomRemoteAttachmentProtocol.ts). */
    attachments?:WorkroomAttachmentRequest;
    /** `workroom.effort`: change this Mac’s automatic effort setting. */
    set?:boolean; mode?:WorkroomEffortMode; effortModes?:true };
}
export interface MobileWorkspaceRecord { id: string; text: string; recordedAt: string; agent: string; deviceName: string | null; origin: string; truncated: boolean; textHash:string }
export interface MobileWorkspaceDuty { id: string; title: string; alias: string; profile: string; state: string; revision: number; knowledgeRevision: number; replied: number; checkedAt: number | null }
export interface MobileWorkspaceResult {
  kind: 'workspace'; action: MobileWorkspaceOperation; threads?:WorkroomThreadResult; commonBinding?:{saved:boolean;message:string}; meta?:MetaMemoryRemoteResponse; voice?:VoiceResponse;
  records?: MobileWorkspaceRecord[]; nextBeforeSeq?: string | null; hasMore?: boolean; source?: 'local' | 'supabase'; captureAt?: string | null;
  nextOffset?:number|null; scanComplete?:boolean;
  connections?: MobileWorkspaceDuty[]; supported?: boolean; checks?: {name:string;ok:boolean;detail:string}[];
  cleanup?:{token:string;branch:string;message:string};
  memory?: {state:string; localSaved:boolean; backupSaved:boolean; message:string};
  workroom?:WorkroomSessionStatus; tester?:MobileTesterResult; voc?:RemoteVocReceipt; vocInbox?:RemoteVocInbox;
  community?:RemoteCommunityState; communityProjects?:RemoteCommunityProjects; history?:RemoteHistoryResult;
  workroomAttachments?:WorkroomAttachmentResult;
  /** `workroom.effort` only (w16): this Mac's 「에포트 자동」 setting and, with a session, that session's record. */
  effort?:WorkroomEffortView;
}
/**
 * `null` = no feature scope beyond the project range itself. `voc.submit` only files an
 * improvement request (optionally with photos) under the AgentsToZ DEV project; a device that may
 * already type into that project's Workroom needs no second switch to leave a note there.
 * `voc.inbox` reads only bounded summaries of this Mac's unprocessed VOCs (no paths, no photo bytes)
 * so that same device can hand what has piled up to the Workroom later — the Workroom it may already
 * drive can read the same files in full.
 */
export function workspaceScope(action: MobileWorkspaceOperation): MobileWorkspaceScope | null {
  // `community.*` needs no second switch either: it speaks as this Mac's OPS endpoint in the one
  // standing group room, and the host already requires the request to target that OPS project. A
  // phone that may drive that Workroom could tell its AI to send the same message anyway.
  // History permission is a separate grant field (`historyScopes`); it is never a workspace scope.
  if(isRemoteHistoryAction(action))throw new Error('대화 기록 권한은 별도로 확인합니다.');
  // Attachments (w13) need no second switch either: the device grant that lets a phone type into the project is the
  // grant to give it a file. The host binds every id to that owner and project.
  if(isWorkroomAttachAction(action)||isWorkroomThreadAction(action))return null;
  // `workroom.effort` (w16): read or change this Mac's 「에포트 자동」 setting. A device that may drive this project's Workroom
  // can already type `/effort` into it — which changes more (Claude saves that as the person's default) — so the project
  // range is the whole check. Another community Mac may only read it (src/agentDialogueControl.ts).
  if(action==='workroom.effort')return null;
  if(action==='voc.submit'||action==='voc.inbox'||action==='community.status'||action==='community.read'||action==='community.send'||action==='community.projects')return null;
  const scopes:Record<Exclude<MobileWorkspaceOperation,WorkroomThreadAction|RemoteHistoryAction|WorkroomAttachAction|'workroom.effort'|'voc.submit'|'voc.inbox'|'community.status'|'community.read'|'community.send'|'community.projects'>,MobileWorkspaceScope>={
    'common-memory.bind':'memory.save','device-memory':'ops-memory.manage','common-memory':'common-memory.manage','meta-memory':'meta-memory.manage','said.list':'records.read','said.read':'records.read','memory.status':'memory.save','memory.save':'memory.save','workroom.status':'memory.save','workroom.save':'memory.save',
    'duty.status':'duty.manage','duty.enable':'duty.manage','duty.disable':'duty.manage','duty.diagnose':'duty.manage','worktree.review':'worktree.manage','worktree.remove':'worktree.manage',
    'voice':'voice.use','tester.status':'tester.read','tester.read':'tester.read','tester.start':'tester.run','tester.cancel':'tester.run',
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
  const fields: Record<MobileWorkspaceOperation,string[]> = {'workroom.threads.catalog':['thread'],'workroom.threads.list':['thread'],'workroom.threads.read':['thread'],'workroom.threads.create':['thread'],'workroom.threads.reply':['thread'],'workroom.threads.close':['thread'],'common-memory.bind':['common'],'common-memory':['meta'],'meta-memory':['meta'],'device-memory':['meta'],'voice':['voice'],'tester.status':[],'tester.start':['profileId','revisionHash','testRequestId'],'tester.read':['runId'],'tester.cancel':['runId'],'said.list':['query','beforeSeq'],'said.read':['query','beforeSeq','recordId','offset','textHash'],'memory.status':[],'memory.save':[],'workroom.status':['sessionId','saveRequestId'],'workroom.save':['sessionId'],'workroom.effort':['sessionId','set','mode','effortModes'],'duty.status':[],'duty.enable':['connectionId','revision','knowledgeRevision','consent'],'duty.disable':['connectionId'],'duty.diagnose':['connectionId'],'worktree.review':[],'worktree.remove':['reviewToken','consent'],'voc.submit':['voc'],'voc.inbox':[],'community.status':[],'community.read':['afterSeq'],'community.send':['text','afterSeq'],'community.projects':['deviceRef','page'],'history.list':['history'],'history.resume.review':['history'],'history.resume.execute':['history'],'history.resume.status':['history'],'history.restart':['history'],'history.restart.dismiss':['history'],'attachments.receive':['attachments'],'attachments.status':['attachments'],'attachments.rebind':['attachments'],'attachments.release':['attachments']};
  if(!Object.hasOwn(fields,w.action)||Object.keys(w).some(k=>k!=='action'&&!fields[w.action].includes(k)))return fail();
  if(isWorkroomThreadAction(w.action)){if(r.requestId.length>128)return fail();w.thread=normalizeWorkroomThreadRequest(w.action,w.thread);if(new TextEncoder().encode(JSON.stringify(r)).length>8500)return fail();}
  if(w.action==='common-memory.bind'){const c=w.common;if(!c||Object.keys(c).some(k=>!['projectGoal','groupIds','expectedSelections','expectedEmpty'].includes(k))||!Array.isArray(c.groupIds)||c.groupIds.length>8||new TextEncoder().encode(JSON.stringify(r)).length>8500)return fail();if(c.expectedEmpty!==undefined&&typeof c.expectedEmpty!=='boolean')return fail();c.projectGoal=commonMemoryText(c.projectGoal);c.groupIds=c.groupIds.map(commonMemoryId);if(c.expectedSelections&&(!Array.isArray(c.expectedSelections)||c.expectedSelections.length!==c.groupIds.length||c.expectedSelections.some(e=>!e||Object.keys(e).some(k=>!['groupId','revisionId','goalVersion','scopeId'].includes(k))||!Number.isSafeInteger(e.goalVersion))))return fail();}
  if(w.action==='meta-memory'||w.action==='common-memory'||w.action==='device-memory'){if(r.targetId!==(w.action==='device-memory'?DEVICE_MEMORY_TARGET:w.action==='common-memory'?COMMON_MEMORY_REMOTE_TARGET:META_MEMORY_REMOTE_TARGET)||new TextEncoder().encode(JSON.stringify(r)).length>8500)return fail();w.meta=normalizeMetaMemoryRemoteRequest(w.meta);}
  if(w.action==='voice'){const v=normalizeVoiceRequest(w.voice);if(v.action.startsWith('history.')||v.action==='configure'||v.action==='connect'||v.requestId!==r.requestId||v.target?.kind==='workroom'&&v.target.targetId!==r.targetId||new TextEncoder().encode(JSON.stringify(r)).length>8500)throw new Error('원격 음성 요청 형식 오류');}
  if(w.action==='tester.start'&&(!testerProfileId(w.profileId)||typeof w.revisionHash!=='string'||!/^[a-f0-9]{64}$/.test(w.revisionHash)||typeof w.testRequestId!=='string'||!/^test_\d{13}_[a-f0-9-]{36}$/.test(w.testRequestId)))return fail();
  if(['tester.read','tester.cancel'].includes(w.action)&&!testerRunId(w.runId))return fail();
  // `workroom.effort` names a session only for its record; the setting itself is the Mac's (the 「새 작업」 sheet has no session).
  if(w.action.startsWith('workroom.')&&!isWorkroomThreadAction(w.action)&&(!(w.action==='workroom.effort'&&w.sessionId===undefined)&&!id(w.sessionId)||w.saveRequestId!==undefined&&!id(w.saveRequestId)))return fail();
  if(w.set!==undefined&&typeof w.set!=='boolean')return fail();
  if(w.effortModes!==undefined&&w.effortModes!==true||w.mode!==undefined&&(!isWorkroomEffortMode(w.mode)||w.effortModes!==true||w.set!==undefined))return fail();
  if(w.query!==undefined&&(typeof w.query!=='string'||w.query.length>300))return fail();
  if(w.beforeSeq!==undefined&&(!cursor(w.beforeSeq)))return fail();
  if(['duty.enable','duty.disable','duty.diagnose'].includes(w.action)&&!id(w.connectionId))return fail();
  if(w.action==='duty.enable'&&(w.consent!==true||!Number.isSafeInteger(w.revision)||w.revision!<0||!Number.isSafeInteger(w.knowledgeRevision)||w.knowledgeRevision!<0))return fail();
  if(w.action==='said.read'&&(!id(w.recordId)||!Number.isSafeInteger(w.offset)||w.offset!<0||w.offset!>200000||typeof w.textHash!=='string'||!/^[a-f0-9]{64}$/.test(w.textHash)))return fail();
  if(w.action==='worktree.remove'&&(!id(w.reviewToken)||w.consent!==true))return fail();
  if(w.afterSeq!==undefined&&(!Number.isSafeInteger(w.afterSeq)||w.afterSeq<0||w.afterSeq>2_000_000))return fail();
  if(w.action==='community.read'&&w.afterSeq===undefined)return fail();
  if(w.action==='community.projects'&&(!isCommunityDeviceRef(w.deviceRef)||!Number.isSafeInteger(w.page)||w.page!<0||w.page!>500))return fail();
  if(w.action==='community.send'){try{w.text=normalizeRemoteCommunityText(w.text);}catch{return fail();}}
  if(w.action==='voc.submit'){try{w.voc=normalizeRemoteVocSubmission(w.voc);}catch{return fail();}}
  if(isRemoteHistoryAction(w.action)){try{w.history=normalizeRemoteHistoryRequest(w.action,w.history);}catch{return fail();}}else if(w.history!==undefined)return fail();
  if(isWorkroomAttachAction(w.action)){try{w.attachments=normalizeWorkroomAttachmentRequest(w.action,w.attachments);}catch{return fail();}}else if(w.attachments!==undefined)return fail();
  return r;
}
export function normalizeMobileWorkspaceResult(value: unknown): MobileWorkspaceResult {
  const r=value as MobileWorkspaceResult;
  if(!r||typeof r!=='object'||Array.isArray(r)||r.kind!=='workspace'||![...WORKROOM_THREAD_ACTIONS,'common-memory.bind','common-memory','meta-memory','device-memory','voice',...MOBILE_TESTER_ACTIONS,'said.list','said.read','memory.status','memory.save','workroom.status','workroom.save','workroom.effort','duty.status','duty.enable','duty.disable','duty.diagnose','worktree.review','worktree.remove','voc.submit','voc.inbox','community.status','community.read','community.send','community.projects',...REMOTE_HISTORY_ACTIONS,...WORKROOM_ATTACH_ACTIONS].includes(r.action)||Object.keys(r).some(k=>!['kind','action','threads','commonBinding','meta','records','nextBeforeSeq','hasMore','source','captureAt','connections','supported','checks','memory','cleanup','nextOffset','scanComplete','workroom','tester','voice','voc','vocInbox','community','communityProjects','history','workroomAttachments','effort'].includes(k))||new TextEncoder().encode(JSON.stringify(r)).length>8500)throw new Error('모바일 작업 응답 형식이 올바르지 않습니다.');
  if(r.action==='common-memory.bind'){if(!r.commonBinding||Object.keys(r).some(k=>!['kind','action','commonBinding'].includes(k))||typeof r.commonBinding.saved!=='boolean'||typeof r.commonBinding.message!=='string'||Object.keys(r.commonBinding).some(k=>!['saved','message'].includes(k)))throw Error('공통기억 연결 응답 형식 오류');return r;}else if(r.commonBinding!==undefined)throw Error('공통기억 연결 응답 형식 오류');
  if(r.action==='meta-memory'||r.action==='common-memory'||r.action==='device-memory'){if(Object.keys(r).some(k=>!['kind','action','meta'].includes(k)))throw new Error('공통 기억 응답 형식 오류');r.meta=normalizeMetaMemoryRemoteResponse(r.meta);return r;}else if(r.meta!==undefined)throw new Error('공통 기억 응답 형식 오류');
  if(r.action==='voice'){if(Object.keys(r).some(k=>!['kind','action','voice'].includes(k)))throw new Error('음성 응답 형식 오류');normalizeVoiceResponse(r.voice);return r;}else if(r.voice!==undefined)throw new Error('음성 응답 형식 오류');
  if(r.action==='workroom.effort'){if(Object.keys(r).some(k=>!['kind','action','effort'].includes(k)))throw new Error('에포트 자동 응답 형식 오류');return {kind:'workspace',action:r.action,effort:normalizeWorkroomEffortView(r.effort)};}else if(r.effort!==undefined)throw new Error('에포트 자동 응답 형식 오류');
  if(r.action.startsWith('tester.')){if(!r.tester||Object.keys(r).some(k=>!['kind','action','tester'].includes(k)))throw new Error('테스터 응답 형식 오류');normalizeMobileTesterResult(r.tester);}else if(r.tester!==undefined)throw new Error('테스터 응답 형식 오류');
  if(r.records!==undefined&&(!Array.isArray(r.records)||r.records.length>3||r.records.some(x=>!x||!id(x.id)||typeof x.text!=='string'||typeof x.recordedAt!=='string'||typeof x.agent!=='string'||typeof x.origin!=='string'||typeof x.truncated!=='boolean'||typeof x.textHash!=='string'||!/^[a-f0-9]{64}$/.test(x.textHash)||!(x.deviceName===null||typeof x.deviceName==='string')||Object.keys(x).some(k=>!['id','text','recordedAt','agent','deviceName','origin','truncated','textHash'].includes(k)))))throw new Error('발언 조회 응답을 확인하지 못했습니다.');
  if(r.connections!==undefined&&(!Array.isArray(r.connections)||r.connections.length>8||r.connections.some(c=>!c||!id(c.id)||typeof c.title!=='string'||typeof c.alias!=='string'||typeof c.profile!=='string'||typeof c.state!=='string'||!Number.isSafeInteger(c.revision)||!Number.isSafeInteger(c.knowledgeRevision)||!Number.isSafeInteger(c.replied)||!(c.checkedAt===null||Number.isFinite(c.checkedAt))||Object.keys(c).some(k=>!['id','title','alias','profile','state','revision','knowledgeRevision','replied','checkedAt'].includes(k)))))throw new Error('대직 상태 응답을 확인하지 못했습니다.');
  if(r.hasMore!==undefined&&typeof r.hasMore!=='boolean'||r.source!==undefined&&!['local','supabase'].includes(r.source)||r.nextBeforeSeq!==undefined&&r.nextBeforeSeq!==null&&!cursor(r.nextBeforeSeq)||r.captureAt!==undefined&&r.captureAt!==null&&(typeof r.captureAt!=='string'||!Number.isFinite(Date.parse(r.captureAt))))throw new Error('기록 페이지 응답을 확인하지 못했습니다.');
  if(r.nextOffset!==undefined&&r.nextOffset!==null&&(!Number.isSafeInteger(r.nextOffset)||r.nextOffset<0||r.nextOffset>200000)||r.scanComplete!==undefined&&typeof r.scanComplete!=='boolean')throw new Error('발언 상세 응답 오류');
  if(r.supported!==undefined&&typeof r.supported!=='boolean')throw new Error('지원 상태 응답 오류');
  if(r.checks!==undefined&&(!Array.isArray(r.checks)||r.checks.length>20||r.checks.some(c=>!c||typeof c.name!=='string'||typeof c.ok!=='boolean'||typeof c.detail!=='string'||Object.keys(c).some(k=>!['name','ok','detail'].includes(k)))))throw new Error('진단 응답 오류');
  if(r.cleanup!==undefined&&(!r.cleanup||typeof r.cleanup.token!=='string'||typeof r.cleanup.branch!=='string'||typeof r.cleanup.message!=='string'||Object.keys(r.cleanup).some(k=>!['token','branch','message'].includes(k))))throw new Error('워크트리 정리 응답 오류');
  if(r.action==='voc.submit'){if(Object.keys(r).some(k=>!['kind','action','voc'].includes(k)))throw new Error('VOC 응답 형식 오류');r.voc=normalizeRemoteVocReceipt(r.voc);}else if(r.voc!==undefined)throw new Error('VOC 응답 형식 오류');
  if(r.action==='community.projects'){
    if(Object.keys(r).some(k=>!['kind','action','communityProjects'].includes(k)))throw new Error('커뮤니티 응답 형식 오류');
    r.communityProjects=normalizeRemoteCommunityProjects(r.communityProjects);
  }else if(r.communityProjects!==undefined)throw new Error('커뮤니티 응답 형식 오류');
  if(r.action.startsWith('community.')&&r.action!=='community.projects'){
    if(Object.keys(r).some(k=>!['kind','action','community'].includes(k)))throw new Error('커뮤니티 응답 형식 오류');
    r.community=normalizeRemoteCommunityState(r.community);
  }else if(r.community!==undefined)throw new Error('커뮤니티 응답 형식 오류');
  if(r.action==='voc.inbox'){if(Object.keys(r).some(k=>!['kind','action','vocInbox'].includes(k)))throw new Error('쌓인 VOC 응답 형식 오류');r.vocInbox=normalizeRemoteVocInbox(r.vocInbox);}else if(r.vocInbox!==undefined)throw new Error('쌓인 VOC 응답 형식 오류');
  if(isWorkroomThreadAction(r.action)){if(Object.keys(r).some(k=>!['kind','action','threads'].includes(k)))throw new Error('스레드 응답 형식 오류');r.threads=normalizeWorkroomThreadResult(r.threads,r.action);return r;}else if(r.threads!==undefined)throw new Error('스레드 응답 형식 오류');
  if(isRemoteHistoryAction(r.action)){if(Object.keys(r).some(k=>!['kind','action','history'].includes(k)))throw new Error('대화 기록 응답 형식 오류');r.history=normalizeRemoteHistoryResult(r.action,r.history);return r;}else if(r.history!==undefined)throw new Error('대화 기록 응답 형식 오류');
  if(isWorkroomAttachAction(r.action)){if(Object.keys(r).some(k=>!['kind','action','workroomAttachments'].includes(k)))throw new Error('첨부 전달 응답 형식 오류');r.workroomAttachments=normalizeWorkroomAttachmentResult(r.workroomAttachments);return r;}else if(r.workroomAttachments!==undefined)throw new Error('첨부 전달 응답 형식 오류');
  if(r.workroom!==undefined&&!validWorkroomSessionStatus(r.workroom))throw new Error('워크룸 저장 상태 응답 오류');
  if(r.memory!==undefined&&(!r.memory||typeof r.memory.state!=='string'||typeof r.memory.localSaved!=='boolean'||typeof r.memory.backupSaved!=='boolean'||typeof r.memory.message!=='string'||Object.keys(r.memory).some(k=>!['state','localSaved','backupSaved','message'].includes(k))))throw new Error('기억 상태 응답 오류');
  return r;
}
