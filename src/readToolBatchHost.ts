import {ProjectStateError} from './projectStateBundle';
import {ProjectStateBundleHost,type ReadPlanExecutionResult} from './projectStateBundleHost';
import {assertReadToolJson,readToolExactObject,readToolIdentifier,parseReadToolPlan,readToolDigest,readToolPlanDigest,READ_TOOL_LIMITS,type ReadToolPlan} from './readToolBundle';
import type {ReadToolBatch,ReadToolBatchRepository,ReadExecutionStageMetadata} from './workroomThreadReadExecution';

export interface ReadToolBatchReference {targetId:string;threadId:string;requestId:string}
export interface ReadToolBatchStartInput extends ReadToolBatchReference {plan:ReadToolPlan}
export interface ReadToolBatchResult {batch:ReadToolBatch;payload:'available'|'unavailable';result?:ReadPlanExecutionResult}
export interface ReadToolBatchHostDependencies {
  executor:ProjectStateBundleHost;
  repository:ReadToolBatchRepository&{cancel:(threadId:string,requestId:string,owner:string,active:()=>boolean)=>Promise<ReadToolBatch>};
  active?:(owner:string,targetId:string)=>boolean;
}
const clone=<T>(value:T):T=>structuredClone(value);
const terminal=(state:string)=>!['pending','running'].includes(state);
function parse(input:unknown,start=false):ReadToolBatchReference|ReadToolBatchStartInput{
  assertReadToolJson(input,READ_TOOL_LIMITS.controlBytes);
  const obj=readToolExactObject(input,start?['targetId','threadId','requestId','plan']:['targetId','threadId','requestId']);
  const ref={targetId:readToolIdentifier(obj.targetId),threadId:readToolIdentifier(obj.threadId),requestId:readToolIdentifier(obj.requestId)};
  return start?{...ref,plan:parseReadToolPlan(obj.plan)}:ref;
}

/** Durable metadata facade; all source execution/admission/cache state belongs to the P1 host. */
export class ReadToolBatchHost {
  private readonly jobs=new Map<string,AbortController>();
  constructor(readonly deps:ReadToolBatchHostDependencies){}
  private key(owner:string,ref:ReadToolBatchReference){return JSON.stringify([owner,ref.threadId,ref.requestId]);}
  private active(owner:string,ref:ReadToolBatchReference){return ()=>this.deps.active?.(owner,ref.targetId)!==false;}
  private async authority(owner:string,ref:ReadToolBatchReference,signal?:AbortSignal){
    readToolIdentifier(owner);if(!this.active(owner,ref)())throw new ProjectStateError('PROJECT_STATE_TARGET_UNAVAILABLE');
    await this.deps.executor.checkAuthority(owner,ref.targetId,signal);
    if(!this.active(owner,ref)())throw new ProjectStateError('PROJECT_STATE_TARGET_UNAVAILABLE');
  }
  private sameIntent(batch:ReadToolBatch,ref:ReadToolBatchStartInput){
    if(batch.targetId!==ref.targetId||batch.threadId!==ref.threadId||batch.requestId!==ref.requestId||batch.intentHash!==readToolDigest({bindingHash:batch.bindingHash,planHash:readToolPlanDigest(ref.plan)}))throw new ProjectStateError('PROJECT_STATE_BATCH_CONFLICT');
  }
  private result(owner:string,ref:ReadToolBatchReference,batch:ReadToolBatch):ReadToolBatchResult{
    if(batch.targetId!==ref.targetId)throw new ProjectStateError('PROJECT_STATE_TARGET_CHANGED');
    const result=this.deps.executor.readPlanResult(owner,ref.targetId,batch.runId);
    return {batch,payload:result?'available':'unavailable',...(result?{result}:{})};
  }
  async start(owner:string,input:unknown,signal?:AbortSignal):Promise<ReadToolBatchResult>{
    const ref=parse(input,true) as ReadToolBatchStartInput;await this.authority(owner,ref,signal);const active=this.active(owner,ref);
    const previous=await this.deps.repository.read(ref.threadId,ref.requestId,owner,active);
    if(previous){this.sameIntent(previous,ref);return this.result(owner,ref,previous);}
    const controller=new AbortController(),key=this.key(owner,ref);let admitted=false,batch:ReadToolBatch|undefined;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
    try{
      await this.deps.executor.executePlan(owner,{targetId:ref.targetId,plan:ref.plan},{active,resultId:()=>batch!.runId,
        onBinding:async binding=>{
          this.jobs.set(key,controller);
          const admission=await this.deps.repository.admit({...ref,owner,binding},active);batch=admission.batch;
          if(!admission.created){this.sameIntent(batch,ref);return false;}
          admitted=true;signal?.removeEventListener('abort',abort);return true;
        },
        onStage:async stage=>{
          if(!batch)throw new ProjectStateError('PROJECT_STATE_BATCH_UNAVAILABLE');
          if(!active())return false;
          const next=clone(batch),index=next.stages.findIndex(s=>s.id===stage.id);if(index<0)throw new ProjectStateError('PROJECT_STATE_BATCH_CONFLICT');
          next.stages[index]=stage;
          const saved=await this.deps.repository.compareAndSet(ref.threadId,ref.requestId,owner,batch.revision,next,active);
          if(saved.revision>=batch.revision)batch=saved;
          return saved.cancelRequestedAt===undefined&&saved.stages[index]!.state===stage.state;
        },
      },controller.signal);
      if(!batch)throw new ProjectStateError('PROJECT_STATE_BATCH_UNAVAILABLE');
      const current=await this.deps.repository.read(ref.threadId,ref.requestId,owner,active);return this.result(owner,ref,current??batch);
    }finally{signal?.removeEventListener('abort',abort);if(this.jobs.get(key)===controller)this.jobs.delete(key);if(!admitted)controller.abort();}
  }
  async read(owner:string,input:unknown,signal?:AbortSignal):Promise<ReadToolBatchResult>{
    const ref=parse(input);await this.authority(owner,ref,signal);const active=this.active(owner,ref);
    let batch=await this.deps.repository.read(ref.threadId,ref.requestId,owner,active);
    if(!batch||batch.targetId!==ref.targetId)throw new ProjectStateError('PROJECT_STATE_BATCH_UNAVAILABLE');
    // A same-boot interruption after metadata admission is not permission to replay.
    if(!this.jobs.has(this.key(owner,ref))&&batch.stages.some(s=>!terminal(s.state))){
      const next=clone(batch);next.stages=next.stages.map(s=>terminal(s.state)?s:{...s,state:'unknown',errorCode:'READ_INTERRUPTED'});
      batch=await this.deps.repository.compareAndSet(ref.threadId,ref.requestId,owner,batch.revision,next,active);
    }
    return this.result(owner,ref,batch);
  }
  async cancel(owner:string,input:unknown,signal?:AbortSignal):Promise<ReadToolBatchResult>{
    const ref=parse(input);await this.authority(owner,ref,signal);const active=this.active(owner,ref);
    const current=await this.deps.repository.read(ref.threadId,ref.requestId,owner,active);
    if(!current||current.targetId!==ref.targetId)throw new ProjectStateError('PROJECT_STATE_BATCH_UNAVAILABLE');
    const batch=await this.deps.repository.cancel(ref.threadId,ref.requestId,owner,active);
    if(batch.cancelRequestedAt!==undefined)this.jobs.get(this.key(owner,ref))?.abort();
    return this.result(owner,ref,batch);
  }
  async prepare(owner:string,input:unknown,signal?:AbortSignal){
    assertReadToolJson(input,READ_TOOL_LIMITS.controlBytes);
    const obj=readToolExactObject(input,['targetId','threadId','requestId','resultId','stepIds']);
    const ref=parse({targetId:obj.targetId,threadId:obj.threadId,requestId:obj.requestId}),resultId=readToolIdentifier(obj.resultId);
    if(!Array.isArray(obj.stepIds)||!obj.stepIds.length||obj.stepIds.length>8)throw new ProjectStateError('PROJECT_STATE_SELECTION');
    const stepIds=obj.stepIds.map(readToolIdentifier);if(new Set(stepIds).size!==stepIds.length)throw new ProjectStateError('PROJECT_STATE_SELECTION');
    const current=await this.read(owner,ref,signal);
    if(current.batch.runId!==resultId||current.payload!=='available'||current.result!.invalidated)throw new ProjectStateError('PROJECT_STATE_EXPIRED');
    return this.deps.executor.preparePlanSelection(owner,{targetId:ref.targetId,resultId,stepIds},signal);
  }
}
