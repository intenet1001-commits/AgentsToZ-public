import {createHash} from 'node:crypto';
import type {AiTerminalService} from './aiTerminalService';
import type {WorkroomConversationService} from './workroomConversationService';
import type {WorkroomSchedule,WorkroomScheduleRun} from './workroomScheduleProtocol';
import type {ScheduleSnapshot,WorkroomScheduleAdapter} from './workroomScheduleHost';
import {savedWorkroomConversation} from './workroomConversationIdentity';
import {verifyWorkroomTranscriptWitness} from './aiTerminalActivityTranscript';

/** Local, in-process consent evidence: losing this map on a sidecar restart refuses cold restoration. */
export function createWorkroomScheduleAdapter(terminal:AiTerminalService,history:WorkroomConversationService,options:{delay?:(ms:number)=>Promise<void>;now?:()=>number;readyTimeoutMs?:number}={}):WorkroomScheduleAdapter {
  const captured=new Map<string,{identity:string;providerId:string;fingerprint:string;pending:number;committed:boolean}>();
  const now=options.now??Date.now,delay=options.delay??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  async function facts(sessionId:string,targetId:string,schedule?:WorkroomSchedule){
    const data=await terminal.scheduleRestoreFacts(sessionId,schedule),providerId=history.verifiedProviderId(sessionId,targetId);
    if(!providerId||data.context.summary.targetId!==targetId||data.context.restricted||data.context.bypass
      ||data.context.providerConversationId&&data.context.providerConversationId!==providerId)throw Error('원래 대화의 검증된 기록을 확인하지 못했습니다.');
    const saved=savedWorkroomConversation(data.context.summary.agent,data.context.providerHome,data.context.cwd,providerId);
    if(!saved||!verifyWorkroomTranscriptWitness(data.transcriptWitness,saved))throw Error('원래 완료 이후 저장된 대화가 변경되었습니다.');
    const fingerprint=hash([data.context.summary.targetId,data.context.summary.agent,data.context.accountFingerprint,
      data.context.targetFingerprint,data.configFingerprint,data.launchModel.model,data.launchModel.provider??null,providerId]);
    return {data,providerId,fingerprint};
  }
  async function checked(schedule:WorkroomSchedule){
    const saved=captured.get(schedule.id);if(!saved||!saved.committed||saved.identity!==schedule.binding.identity)return null;
    const sourceId=schedule.currentSessionId??schedule.binding.sessionId;
    const current=await facts(sourceId,schedule.binding.targetId,schedule);
    if(current.fingerprint!==saved.fingerprint||current.providerId!==saved.providerId||current.data.context.summary.state==='running'
      ||current.data.launchModel.model!==schedule.binding.model||current.data.context.summary.agent!==schedule.binding.agent
      ||(current.data.context.summary.accountId??'host-default')!==schedule.binding.accountId||schedule.binding.bypass)return null;
    return {...current,sourceId,proof:hash([saved.identity,current.fingerprint,sourceId,current.data.inputRevision,current.data.transcriptWitness])};
  }
  async function inspect(sessionId:string):Promise<ScheduleSnapshot>{
    const snapshot=await terminal.scheduleSnapshot(sessionId);
    let canRestore=false;
    if(snapshot.ready&&!snapshot.binding.bypass)try{
      const current=await facts(sessionId,snapshot.binding.targetId);
      canRestore=current.data.inputRevision===snapshot.inputRevision&&current.data.launchModel.model===snapshot.binding.model;
    }catch{/* Lack of proof is a disabled option, never permission to infer it. */}
    return {...snapshot,canRestore};
  }
  return {
    inspect,
    inspectBound:(schedule,id)=>terminal.inspectBoundSchedule(schedule,id),
    captureRestore:async(schedule,snapshot)=>{
      if(captured.size>=32&&!captured.has(schedule.id))throw Error('복원 증거 한도에 도달했습니다.');
      const current=await facts(schedule.binding.sessionId,schedule.binding.targetId),again=await terminal.scheduleSnapshot(schedule.binding.sessionId);
      if(!snapshot.ready||!again.ready||snapshot.binding.identity!==schedule.binding.identity||again.binding.identity!==schedule.binding.identity
        ||current.data.inputRevision!==snapshot.inputRevision||again.inputRevision!==snapshot.inputRevision
        ||again.outputCursor!==snapshot.outputCursor||current.data.launchModel.model!==schedule.binding.model||schedule.binding.bypass)
        throw Error('예약 동의 중 원래 대화가 변경되었습니다. 다시 확인하세요.');
      let entry=captured.get(schedule.id);
      if(entry&&(entry.identity!==schedule.binding.identity||entry.providerId!==current.providerId||entry.fingerprint!==current.fingerprint))throw Error('같은 예약 번호의 복원 근거가 다릅니다.');
      if(!entry){entry={identity:schedule.binding.identity,providerId:current.providerId,fingerprint:current.fingerprint,pending:0,committed:false};captured.set(schedule.id,entry);}
      const selected=entry;selected.pending++;let finished=false;
      const finish=(commit:boolean)=>{if(finished)return;finished=true;selected.pending--;if(commit)selected.committed=true;
        if(!selected.committed&&selected.pending===0&&captured.get(schedule.id)===selected)captured.delete(schedule.id);};
      return {commit:()=>finish(true),cancel:()=>finish(false)};
    },
    inspectRestore:async schedule=>{const current=await checked(schedule);return current?{proof:current.proof}:null;},
    restore:async(schedule:WorkroomSchedule,run:WorkroomScheduleRun,proof,active,gate)=>{
      if(!active())throw Error('예약 동의가 종료되었습니다.');
      const evidence=await checked(schedule);if(!active()||!evidence||evidence.proof!==proof.proof)throw Error('원래 대화의 완료 증거가 변경되었습니다.');
      const requestId=run.id+'_resume';
      const session=await history.resumeThreadSession(evidence.sourceId,schedule.binding.targetId,requestId,active,{
        launchModel:evidence.data.launchModel,startEffectGate:effect=>gate(()=>{
          const path=savedWorkroomConversation(evidence.data.context.summary.agent,evidence.data.context.providerHome,evidence.data.context.cwd,evidence.providerId);
          if(!path||!verifyWorkroomTranscriptWitness(evidence.data.transcriptWitness,path))throw Error('복원 직전 완료 기록이 변경되었습니다.');
          return effect();
        }),startGuard:async context=>{
          const latest=await checked(schedule);
          if(!active()||!latest||latest.proof!==proof.proof||context.accountFingerprint!==evidence.data.context.accountFingerprint
            ||context.targetFingerprint!==evidence.data.context.targetFingerprint)throw Error('복원 직전 대상 또는 동의가 변경되었습니다.');
          return ()=>{
            const currentPath=savedWorkroomConversation(evidence.data.context.summary.agent,evidence.data.context.providerHome,evidence.data.context.cwd,evidence.providerId);
            if(!active()||!currentPath||!verifyWorkroomTranscriptWitness(evidence.data.transcriptWitness,currentPath))throw Error('복원 직전 동의 또는 완료 기록이 변경되었습니다.');
          };
        }});
      if(!active()||!session||history.resumeReceipt(requestId)?.state!=='completed')throw Error('대화 복원 결과를 확인하지 못했습니다.');
      let snapshot=await terminal.adoptRestoredSchedule(schedule,session.id,evidence.providerId,evidence.sourceId);
      const deadline=now()+Math.max(0,Math.min(options.readyTimeoutMs??20_000,30_000));
      while(!snapshot.ready&&now()<deadline){if(!active())throw Error('예약 동의가 종료되었습니다.');await delay(200);if(!active())throw Error('예약 동의가 종료되었습니다.');
        snapshot=await terminal.inspectBoundSchedule(schedule,session.id)??(()=>{throw Error('복원한 터미널이 종료되었습니다.');})();}
      if(!active()||!snapshot.ready)throw Error('복원한 대화의 입력 대기 상태를 확인하지 못했습니다.');
      return snapshot;
    },
    dispatch:(schedule,run,snapshot,active,gate)=>terminal.dispatchSchedule(schedule,run,snapshot,active,gate),
    reconcile:run=>terminal.reconcileSchedule(run),
  };
}
