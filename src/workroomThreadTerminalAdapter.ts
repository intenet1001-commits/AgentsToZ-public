import {workroomThreadProjectFingerprint} from './workroomThreadIdentity';
import type {AiTerminalService} from './aiTerminalService';
import type {AiTerminalSummary} from './aiTerminalProtocol';
import type {WorkroomThreadDependencies} from './workroomThreadService';
import {submitWorkroomDraft} from './workroomSubmissionClient';

/** DEV terminals only. USE is dispatched by the bounded service host before reaching this adapter.
 * The workspace gateway has already authorized this target; recheck that live proof at each write. */
export function workroomThreadTerminalAdapter(terminal:Pick<AiTerminalService,'perform'|'runningSession'|'submitHostInstruction'>):Pick<WorkroomThreadDependencies,'start'|'reply'>{
 return {
  start:async(id,targetId,agent,prompt,active,fingerprint)=>{
   let session:AiTerminalSummary|undefined;
   const authority={owner:'thread:'+id,targets:new Set([targetId]),isActive:active,deviceConsentActive:active,validateTarget:(id:string,cwd:string)=>{if(id!==targetId||workroomThreadProjectFingerprint(cwd)!==fingerprint)throw Error('업무를 맡긴 프로젝트 폴더가 변경되었습니다.');}};
   const receipt=await submitWorkroomDraft({id,text:prompt+'\r',prepared:()=>{},launch:{targetId,agent,cols:100,rows:28,bypassPermissions:false},
    request:async request=>{const response=await terminal.perform({...request,requestId:crypto.randomUUID()},authority);if(response.session)session=response.session;return response;}});
   if(!session&&receipt.sessionId)session=terminal.runningSession(receipt.sessionId)??undefined;
   return {written:receipt.state==='written',session};
  },
  reply:async(id,sessionId,text,revision,active,fingerprint)=>({written:(await terminal.submitHostInstruction({id,sessionId,data:text+'\r',revision,active,validateTarget:(_id,cwd)=>{if(workroomThreadProjectFingerprint(cwd)!==fingerprint)throw Error('원래 프로젝트 폴더가 변경되었습니다.');},receiptOwner:'thread:'+sessionId})).state==='written'}),
 };
}
