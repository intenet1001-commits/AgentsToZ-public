import type {AiTerminalService} from './aiTerminalService';
import type {WorkroomConversationService} from './workroomConversationService';
import type {CodexAutoRememberObservation} from './codexAutoRememberContract';
import type {WorkroomThreadDependencies} from './workroomThreadService';
import type {StoredWorkroomThread} from './workroomThreadStore';
import {workroomThreadProjectFingerprint} from './workroomThreadIdentity';
import {createHash,randomUUID} from 'node:crypto';
import {waitForWorkroomReady,workroomScreenAwaitsAnswer} from './workroomRouteDelivery';
import {renderTerminalPlainText} from './terminalPlainText';

/** Enabling or re-enabling automatic memory never includes turns completed before that consent. */
export function workroomThreadSaveConsent(enabledAt:string|number|null,completedAt?:string){
 const start=typeof enabledAt==='number'?enabledAt:enabledAt===null?NaN:Date.parse(enabledAt);
 return Number.isFinite(start)&&(completedAt===undefined||Number.isFinite(Date.parse(completedAt))&&Date.parse(completedAt)>start);
}

/** Host-only lifecycle. Browser requests cannot supply a provider conversation, CLI account, context metric or save proof. */
export function workroomThreadLifecycleHost(deps:{
 terminal:Pick<AiTerminalService,'inspectSession'|'activitySnapshot'|'perform'|'prepareHistoryContext'>;
 history:Pick<WorkroomConversationService,'submissionJournal'|'resumeThreadSession'>;
 observations:()=>Promise<CodexAutoRememberObservation[]>;
 enabled:(cwd:string,completedAt?:string)=>boolean;
 save:(record:StoredWorkroomThread,cwd:string)=>Promise<'saving'|'saved'|'blocked'>;
 now?:()=>number;
}):Pick<WorkroomThreadDependencies,'open'|'ready'|'checkpointEvidence'|'checkpoint'> {
 const inspect=(r:StoredWorkroomThread)=>{
  if(!r.sessionId)throw Error('연결 워크룸이 없습니다.');
  const s=deps.terminal.inspectSession(r.sessionId,r.targetId);
  if(workroomThreadProjectFingerprint(s.cwd)!==r.fingerprint)throw Error('원래 프로젝트 폴더가 변경되었습니다.');
  return s;
 };
 const settled=(r:StoredWorkroomThread)=>{
  const s=inspect(r),a=deps.terminal.activitySnapshot().find(a=>a.sessionId===s.id);
  return s.state==='running'&&s.completedInputRevision===s.inputRevision&&a?.exact&&['turn-finished','idle'].includes(a.state)?s:null;
 };
 return {
  open:async(id,r,active)=>{
   if(!r.continuation||r.continuation.sessionId!==r.sessionId||!active())throw Error('워크룸 재개 요청을 확인하세요.');
   const requestId='thread-'+createHash('sha256').update(id).digest('hex');
   if(r.continuation.mode==='resume')return deps.history.resumeThreadSession(r.sessionId!,r.targetId,requestId,active);
   const original=deps.history.submissionJournal().forSession(r.sessionId!);
   if(!original||original.sessionId!==r.sessionId||original.targetId!==r.targetId||original.agent!==r.agent||original.state==='running')throw Error('저장 후 종료한 원래 워크룸을 확인하세요.');
   const validate=async(context:Awaited<ReturnType<AiTerminalService['prepareHistoryContext']>>)=>{
    if(!active()||context.summary.targetId!==r.targetId||context.summary.agent!==r.agent||(context.summary.accountId??'host-default')!==original.accountId
      ||context.targetFingerprint!==original.targetFingerprint||context.accountFingerprint!==original.accountFingerprint||workroomThreadProjectFingerprint(context.cwd)!==r.fingerprint)throw Error('워크룸 프로젝트 또는 원래 CLI 계정이 변경되었습니다.');
   };
   await validate(await deps.terminal.prepareHistoryContext(original));
   const authority={owner:'thread:'+id,targets:new Set([r.targetId]),isActive:active,deviceConsentActive:active,accountSelectionAllowed:()=>active(),validateTarget:(_id:string,cwd:string)=>{if(workroomThreadProjectFingerprint(cwd)!==r.fingerprint)throw Error('프로젝트 폴더가 변경되었습니다.');}};
   const response=await deps.terminal.perform({operation:'start',requestId,targetId:r.targetId,agent:r.agent,accountId:original.accountId,cols:100,rows:28,bypassPermissions:false},authority,{startGuard:validate});
   return response.session;
  },
  ready:async(session,active)=>{
   const screen=await waitForWorkroomReady({sessionId:session.id,read:async request=>{if(!active())throw Error('워크룸 연결 권한이 변경되었습니다.');return deps.terminal.perform({...request,requestId:randomUUID()});},render:async text=>(await renderTerminalPlainText(text,session.cols,session.rows)).split('\n')});
   if(!active()||screen.state!=='settled'||!screen.lines||workroomScreenAwaitsAnswer(screen.lines))throw Error('워크룸 입력 준비 또는 CLI 승인을 확인하세요. 새 글을 자동 전송하지 않았습니다.');
  },
  checkpointEvidence:async r=>{
   const s=settled(r);if(!s||!deps.enabled(s.cwd)||!['codex','claude'].includes(s.agent))return null;
   const original=deps.history.submissionJournal().forSession(s.id);
   if(!original||original.sessionId!==s.id||original.binding!=='verified'||!original.providerConversationId)return null;
   const key=s.agent==='claude'?'claude:'+original.providerConversationId:original.providerConversationId;
   const now=deps.now?.()??Date.now();
   const observation=(await deps.observations()).find(o=>o.sessionId===key&&o.cwd===s.cwd&&(o.sourceAgent??'codex')===s.agent);
   if(!observation||!Number.isFinite(observation.usedPercent)||observation.usedPercent<70||observation.usedPercent>100||observation.turnState!=='complete'||!observation.turnId
     ||!observation.turnCompletedAt||!Number.isFinite(Date.parse(observation.turnCompletedAt))||Date.parse(observation.turnCompletedAt)<Date.parse(s.createdAt)
     ||!Number.isFinite(Date.parse(observation.capturedAt))||Date.parse(observation.capturedAt)<Date.parse(s.createdAt)||Date.parse(observation.capturedAt)>now+5000||now-Date.parse(observation.capturedAt)>10*60_000)return null;
   const fresh=settled(r);return fresh&&fresh.inputRevision===s.inputRevision&&deps.enabled(fresh.cwd,observation.turnCompletedAt)?{inputRevision:fresh.inputRevision,turnCompletedAt:observation.turnCompletedAt}:null;
  },
  checkpoint:async r=>{
   try{
    const c=r.checkpoint;if(!c||!r.sessionId||c.sessionId!==r.sessionId)return 'blocked';
    const s=settled(r);if(!s||s.inputRevision!==c.inputRevision||!deps.enabled(s.cwd,c.turnCompletedAt))return 'blocked';
    const state=await deps.save(r,s.cwd);if(state!=='saved')return state;
    // A new question, keystroke or queued request after admission keeps the original CLI alive.
    const fresh=settled(r);if(!fresh||fresh.inputRevision!==c.inputRevision||!deps.enabled(fresh.cwd,c.turnCompletedAt))return 'blocked';
    const active=()=>deps.enabled(s.cwd,c.turnCompletedAt);
    await deps.terminal.perform({operation:'close',requestId:c.id+'_close',sessionId:s.id,memoryPolicy:'saved',saveRequestId:c.id},
      {owner:'thread-checkpoint:'+r.id,targets:new Set([r.targetId]),isActive:active,deviceConsentActive:active});
    return inspect(r).state==='exited'?'closed':'blocked';
   }catch{return 'blocked';}
  },
 };
}
