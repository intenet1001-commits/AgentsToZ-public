import {PROJECT_STATE_LIMITS,PROJECT_STATE_SECTIONS,ProjectStateError,parseProjectStatePreviewInput,parseProjectStateSelectionInput,parseProjectStateSendInput,projectSourceObservation,projectStateSelectionText,utf8Bytes,type TargetBinding,type SourceObservation,type SectionId,type ReadBudget,type ReadSourceInput,type ReadSourceAdapter,type ProjectStateBundle,type ProjectStateSelectionInput,type PreparedProjectState,type ReadToolSourceAdapters,type ReadToolSourceResult} from './projectStateBundle';
import {parseReadToolPlan,readStepEligibility,resolveReadToolInput,readToolSection,testerRunId,type ReadToolPlan,type ReadToolOperation,type ResolvedReadToolInput,type ReadStepEvidence,type ReadStepState} from './readToolBundle';
import type {ReadExecutionStageMetadata} from './workroomThreadReadExecution';

export interface ProjectStateClock {now:()=>number;setTimeout:(fn:()=>void,ms:number)=>unknown;clearTimeout:(timer:unknown)=>void}
export interface ProjectStateBundleHostDependencies {
  resolve:(owner:string,targetId:string,signal:AbortSignal)=>Promise<TargetBinding>;
  /** Optional cheap current registry/principal guard, without Git/file probes. */
  authorize?:(owner:string,targetId:string,signal:AbortSignal)=>Promise<void>;
  readers:Partial<Record<SectionId,ReadSourceAdapter>>;
  operations?:ReadToolSourceAdapters;
  clock?:ProjectStateClock;uuid?:()=>string;
}
export interface ProjectStateSendOptions {
  /** Only the replacement CLI session created by the current trusted submission. */
  excludeWorkroomSessionId?:string;
}
export interface ReadPlanExecutionHooks {
  onBinding?:(binding:TargetBinding)=>Promise<boolean|void>;
  onStage?:(stage:ReadExecutionStageMetadata)=>Promise<boolean|void>;
  active?:()=>boolean;
  /** Repository run ID, available after onBinding admission. Never wire input. */
  resultId?:()=>string;
}
export interface ReadPlanStepOutput {stepId:string;operation:ReadToolOperation;observation:SourceObservation;latestRunId?:string;reportRunId?:string}
export interface ReadPlanExecutionResult {
  id:string;targetId:string;collectedAt:number;expiresAt:number;
  state:'completed'|'partial'|'failed'|'skipped'|'cancelled'|'unknown';invalidated:boolean;
  stages:ReadExecutionStageMetadata[];outputs:ReadPlanStepOutput[];
}
interface Lease {targetId:string;pending:Set<Promise<unknown>>;callerDone:boolean;released:boolean;sources:number;controller:AbortController;invalidated:boolean;deadline:number;timer?:unknown;totalBytes:number}
interface PlanTask {stepId:string;input:ResolvedReadToolInput}
interface PreviewRecord {kind:'preview';owner:string;binding:TargetBinding;bundle:ProjectStateBundle;inputs:ReadSourceInput[];tasks?:PlanTask[]}
interface PlanRecord {kind:'plan';owner:string;binding:TargetBinding;result:ReadPlanExecutionResult;tasks:PlanTask[];attachment?:PreviewRecord}
type CacheRecord=PreviewRecord|PlanRecord;
const realClock:ProjectStateClock={now:()=>Date.now(),setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>)};
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const sameBinding=(a:TargetBinding,b:TargetBinding)=>a.targetId===b.targetId&&a.projectId===b.projectId&&a.owner===b.owner&&a.role==='dev'&&b.role==='dev'&&a.proof===b.proof&&a.rootPath===b.rootPath&&a.sourceProofComplete===b.sourceProofComplete;
const sourceValue=(source:SourceObservation)=>{const {observedAt:_,...value}=source;return JSON.stringify(value);};
async function digest(text:string):Promise<string>{const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}

/** Volatile fixed-list executor; no thread, provider, database, key or mutation port. */
export class ProjectStateBundleHost {
  private readonly clock:ProjectStateClock;
  private readonly records=new Map<string,CacheRecord>();
  private readonly leases=new Set<Lease>();
  private activeSources=0;
  constructor(readonly deps:ProjectStateBundleHostDependencies){this.clock=deps.clock??realClock;}
  diagnostics(){return {activePreviews:this.leases.size,activeSources:this.activeSources,storedPreviews:this.records.size};}
  private prune(){for(const [id,record] of this.records)if((record.kind==='preview'?record.bundle:record.result).expiresAt<=this.clock.now())this.records.delete(id);}
  private cache(id:string,record:CacheRecord){
    const targetId=record.kind==='preview'?record.bundle.targetId:record.result.targetId;
    for(const [oldId,r] of this.records)if((r.kind==='preview'?r.bundle.targetId:r.result.targetId)===targetId)this.records.delete(oldId);
    while(this.records.size>=PROJECT_STATE_LIMITS.storedPreviews)this.records.delete(this.records.keys().next().value!);
    this.records.set(id,record);
  }
  private admit(targetId:string,signal?:AbortSignal):Lease {
    if(signal?.aborted)throw new ProjectStateError('PROJECT_STATE_CANCELLED');
    if(this.leases.size>=PROJECT_STATE_LIMITS.activePreviews||[...this.leases].some(l=>l.targetId===targetId))throw new ProjectStateError('PROJECT_STATE_BUSY','다른 상태 조회가 끝난 뒤 다시 확인하세요.',429);
    const lease:Lease={targetId,pending:new Set(),callerDone:false,released:false,sources:0,controller:new AbortController(),invalidated:false,deadline:this.clock.now()+PROJECT_STATE_LIMITS.totalMs,totalBytes:0};
    lease.timer=this.clock.setTimeout(()=>lease.controller.abort(),PROJECT_STATE_LIMITS.totalMs);
    if(signal){const abort=()=>lease.controller.abort();signal.addEventListener('abort',abort,{once:true});lease.controller.signal.addEventListener('abort',()=>signal.removeEventListener('abort',abort),{once:true});}
    this.leases.add(lease);return lease;
  }
  private release(lease:Lease){if(lease.callerDone&&!lease.pending.size&&!lease.released){lease.released=true;this.clock.clearTimeout(lease.timer);lease.controller.abort();this.leases.delete(lease);}}
  private track<T>(lease:Lease,promise:Promise<T>):Promise<T> {
    lease.pending.add(promise);void promise.then(()=>{lease.pending.delete(promise);this.release(lease);},()=>{lease.pending.delete(promise);this.release(lease);});return promise;
  }
  private async race<T>(lease:Lease,promise:Promise<T>,ms:number,signal:AbortSignal,onStop:()=>void):Promise<{value:T}|{stopped:true}> {
    const actual=this.track(lease,promise);let timer:unknown,abort:()=>void=()=>{};
    const stop=new Promise<{stopped:true}>(resolve=>{abort=()=>{onStop();resolve({stopped:true});};timer=this.clock.setTimeout(abort,Math.max(0,ms));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
    try{return await Promise.race([actual.then(value=>({value})),stop]);}
    finally{this.clock.clearTimeout(timer);signal.removeEventListener('abort',abort);}
  }
  private async resolve(lease:Lease,owner:string):Promise<TargetBinding> {
    const result=await this.race(lease,Promise.resolve().then(()=>this.deps.resolve(owner,lease.targetId,lease.controller.signal)),Math.min(PROJECT_STATE_LIMITS.sourceMs,lease.deadline-this.clock.now()),lease.controller.signal,()=>lease.controller.abort());
    if('stopped' in result)throw new ProjectStateError('PROJECT_STATE_TARGET_UNAVAILABLE');
    const binding=result.value;
    if(binding.owner!==owner||binding.targetId!==lease.targetId||binding.role!=='dev'||!binding.projectId||!binding.proof)throw new ProjectStateError('PROJECT_STATE_TARGET_CHANGED');
    return binding;
  }
  private unavailable(id:SectionId,code:string):SourceObservation{return {id,availability:'unknown',freshness:'unknown',observedAt:this.clock.now(),summary:[],limits:[code==='PROJECT_STATE_CANCELLED'?'collection cancelled; source may still be settling':'source unavailable within the read budget'],errorCode:code};}
  private async readTask(lease:Lease,binding:TargetBinding,id:SectionId,read:((budget:ReadBudget,signal:AbortSignal)=>Promise<ReadToolSourceResult>)|undefined,active?:()=>boolean):Promise<ReadToolSourceResult>{
    const unavailable=(code:string)=>({observation:this.unavailable(id,code)});
    if(lease.controller.signal.aborted)return unavailable('PROJECT_STATE_CANCELLED');
    try{
      if(active&&!active())throw new ProjectStateError('PROJECT_STATE_TARGET_CHANGED');
      if(this.deps.authorize){
        const authorization=await this.race(lease,Promise.resolve().then(()=>this.deps.authorize!(binding.owner,binding.targetId,lease.controller.signal)),Math.min(PROJECT_STATE_LIMITS.sourceMs,lease.deadline-this.clock.now()),lease.controller.signal,()=>lease.controller.abort());
        if('stopped' in authorization)throw new ProjectStateError('PROJECT_STATE_TARGET_UNAVAILABLE');
      }else if(!sameBinding(binding,await this.resolve(lease,binding.owner)))throw new ProjectStateError('PROJECT_STATE_TARGET_CHANGED');
      if(active&&!active())throw new ProjectStateError('PROJECT_STATE_TARGET_CHANGED');
    }catch{lease.invalidated=true;lease.controller.abort();return unavailable('PROJECT_STATE_TARGET_CHANGED');}
    if(lease.sources>=PROJECT_STATE_LIMITS.sourceConcurrency||this.activeSources>=PROJECT_STATE_LIMITS.hostSourceConcurrency)return unavailable('PROJECT_STATE_SOURCE_BUSY');
    if(!read)return {observation:{...this.unavailable(id,'PROJECT_STATE_UNCONFIGURED'),availability:'unconfigured'}};
    const controller=new AbortController(),abort=()=>controller.abort();lease.controller.signal.addEventListener('abort',abort,{once:true});
    let consumed=0,exceeded=false;
    const budget:ReadBudget={deadline:Math.min(lease.deadline,this.clock.now()+PROJECT_STATE_LIMITS.sourceMs),maxSourceBytes:PROJECT_STATE_LIMITS.sourceReadBytes,maxTotalBytes:PROJECT_STATE_LIMITS.totalReadBytes,
      consume:bytes=>{if(!Number.isSafeInteger(bytes)||bytes<0||controller.signal.aborted||this.clock.now()>budget.deadline||consumed+bytes>budget.maxSourceBytes||lease.totalBytes+bytes>budget.maxTotalBytes){exceeded=true;return false;}consumed+=bytes;lease.totalBytes+=bytes;return true;}};
    this.activeSources++;lease.sources++;
    const actual=Promise.resolve().then(()=>read(budget,controller.signal));
    void actual.then(()=>{this.activeSources--;lease.sources--;lease.controller.signal.removeEventListener('abort',abort);},()=>{this.activeSources--;lease.sources--;lease.controller.signal.removeEventListener('abort',abort);});
    try{
      const result=await this.race(lease,actual,budget.deadline-this.clock.now(),lease.controller.signal,()=>controller.abort());
      if('stopped' in result)return unavailable(lease.controller.signal.aborted?'PROJECT_STATE_CANCELLED':'PROJECT_STATE_SOURCE_TIMEOUT');
      if(active&&!active()){lease.invalidated=true;lease.controller.abort();return unavailable('PROJECT_STATE_TARGET_CHANGED');}
      if(result.value.observation.id!==id)throw new ProjectStateError('PROJECT_STATE_SOURCE_INVALID');
      const observation=projectSourceObservation(result.value.observation);
      if(exceeded){observation.availability='partial';observation.limits.push('source I/O byte budget exceeded');}
      return {observation,...(result.value.latestRunId===undefined?{}:{latestRunId:testerRunId(result.value.latestRunId)}),...(result.value.reportRunId===undefined?{}:{reportRunId:testerRunId(result.value.reportRunId)})};
    }catch{return unavailable('PROJECT_STATE_SOURCE_UNAVAILABLE');}
  }
  private async collect(lease:Lease,binding:TargetBinding,inputs:ReadSourceInput[]):Promise<SourceObservation[]> {
    const collected:SourceObservation[]=new Array(inputs.length);let cursor=0;
    const worker=async()=>{
      while(cursor<inputs.length){
        const index=cursor++,input=inputs[index]!;
        const reader=this.deps.readers[input.id];
        collected[index]=(await this.readTask(lease,binding,input.id,reader?async(budget,signal)=>({observation:await reader.read(binding,input,budget,signal)}):undefined)).observation;
      }
    };
    await Promise.all(Array.from({length:Math.min(PROJECT_STATE_LIMITS.sourceConcurrency,inputs.length)},worker));return collected;
  }
  private async typedTask(lease:Lease,binding:TargetBinding,input:ResolvedReadToolInput,active?:()=>boolean,options?:ProjectStateSendOptions):Promise<ReadToolSourceResult>{
    const adapter=this.deps.operations?.[input.operation];
    return this.readTask(lease,binding,readToolSection(input.operation),adapter?async(budget,signal)=>{
      const value=await adapter.read(binding,input,budget,signal,input.operation==='workroom.status.read'?options:undefined);
      if(value.latestRunId!==undefined&&input.operation!=='tester.status.read'||value.reportRunId!==undefined&&(input.operation!=='tester.report.read'||value.reportRunId!==input.runId))throw new ProjectStateError('PROJECT_STATE_SOURCE_INVALID');
      return value.observation.availability==='ready'?value:{observation:value.observation};
    }:undefined,active);
  }
  private combined(stages:ReadExecutionStageMetadata[]):ReadPlanExecutionResult['state']{
    const states=stages.map(s=>s.state);
    if(states.includes('unknown'))return 'unknown';if(states.includes('cancelled'))return 'cancelled';
    if(states.every(s=>s==='completed'))return 'completed';
    if(states.some(s=>s==='completed'||s==='partial'))return 'partial';
    return states.includes('failed')?'failed':'skipped';
  }
  private stageState(source:SourceObservation):ReadStepState{
    return source.availability==='ready'?'completed':source.availability==='partial'||source.availability==='unconfigured'?'partial':source.availability==='unavailable'?'failed':'unknown';
  }
  async checkAuthority(owner:string,targetId:string,signal?:AbortSignal):Promise<void>{
    if(signal?.aborted)throw new ProjectStateError('PROJECT_STATE_CANCELLED');
    try{await this.deps.authorize?.(owner,targetId,signal??new AbortController().signal);}catch{throw new ProjectStateError('PROJECT_STATE_TARGET_UNAVAILABLE');}
  }
  async executePlan(owner:string,input:{targetId:string;plan:unknown},hooks:ReadPlanExecutionHooks={},signal?:AbortSignal):Promise<ReadPlanExecutionResult>{
    const plan=parseReadToolPlan(input.plan),targetId=parseProjectStatePreviewInput({targetId:input.targetId}).targetId;
    this.prune();const lease=this.admit(targetId,signal);
    try{
      const binding=await this.resolve(lease,owner);
      if(hooks.active&&!hooks.active())throw new ProjectStateError('PROJECT_STATE_TARGET_CHANGED');
      const accepted=await hooks.onBinding?.(binding),stages:ReadExecutionStageMetadata[]=plan.steps.map(s=>({id:s.id,operation:s.input.operation,state:'pending'}));
      const id=hooks.resultId?.()??(this.deps.uuid??(()=>crypto.randomUUID()))(),outputs:ReadPlanStepOutput[]=[],tasks:PlanTask[]=[],evidence=new Map<string,ReadStepEvidence>();
      const result:ReadPlanExecutionResult={id,targetId,collectedAt:this.clock.now(),expiresAt:this.clock.now()+PROJECT_STATE_LIMITS.ttlMs,state:'skipped',invalidated:false,stages,outputs};
      if(accepted===false)return result;
      let activeWorkers=0,wake:()=>void=()=>{},changed=new Promise<void>(resolve=>{wake=resolve;});
      const notify=()=>{const previous=wake;changed=new Promise<void>(resolve=>{wake=resolve;});previous();};
      const emit=async(stage:ReadExecutionStageMetadata)=>{if(await hooks.onStage?.(copy(stage))===false)lease.controller.abort();};
      const worker=async()=>{
        try{for(;;){
          const pending=stages.filter(s=>s.state==='pending');if(!pending.length)return;
          const index=stages.findIndex(s=>s.state==='pending'&&(lease.controller.signal.aborted||readStepEligibility(plan.steps.find(p=>p.id===s.id)!,[...evidence.values()]).state!=='wait'));
          if(index<0){if(!activeWorkers)throw new ProjectStateError('PROJECT_STATE_DEPENDENCY');const wait=changed;await wait;continue;}
          const stage=stages[index]!,step=plan.steps[index]!;
          const eligibility=readStepEligibility(step,[...evidence.values()]);
          if(lease.controller.signal.aborted||eligibility.state==='skip'){
            Object.assign(stage,{state:lease.controller.signal.aborted?'cancelled':'skipped',finishedAt:this.clock.now(),errorCode:lease.controller.signal.aborted?'READ_CANCELLED':eligibility.reason==='report-absent'?'READ_REPORT_ABSENT':'READ_DEPENDENCY_UNAVAILABLE'});
            evidence.set(stage.id,{stepId:stage.id,operation:stage.operation,state:stage.state,availability:'unknown',freshness:'unknown'});await emit(stage);notify();continue;
          }
          const resolved=resolveReadToolInput(step,[...evidence.values()]);
          if(!resolved){Object.assign(stage,{state:'skipped',finishedAt:this.clock.now(),errorCode:'READ_REPORT_ABSENT'});evidence.set(stage.id,{stepId:stage.id,operation:stage.operation,state:'skipped',availability:'unknown',freshness:'unknown'});await emit(stage);notify();continue;}
          stage.state='running';stage.startedAt=this.clock.now();activeWorkers++;
          evidence.set(stage.id,{stepId:stage.id,operation:stage.operation,state:'running',availability:'unknown',freshness:'unknown'});
          try{
            await emit(stage);
            if(lease.controller.signal.aborted){stage.state='cancelled';stage.errorCode='READ_CANCELLED';stage.finishedAt=this.clock.now();await emit(stage);continue;}
            const value=await this.typedTask(lease,binding,resolved,hooks.active),source=value.observation;
            const output:ReadPlanStepOutput={stepId:stage.id,operation:stage.operation,...value};
            if(utf8Bytes(JSON.stringify(outputs))+utf8Bytes(JSON.stringify(output))>PROJECT_STATE_LIMITS.previewBytes-4096){output.observation={...source,availability:'partial',summary:[],limits:['preview output UTF-8 byte budget exceeded'],errorCode:'READ_OUTPUT_LIMIT'};delete output.latestRunId;delete output.reportRunId;}
            const observation=output.observation;
            Object.assign(stage,{state:this.stageState(observation),finishedAt:this.clock.now(),observedAt:Math.max(0,Math.floor(observation.observedAt)),sourceId:observation.id,sourceRevision:await digest(observation.sourceRevision??sourceValue(observation)),outputDigest:await digest(sourceValue(observation)),availability:observation.availability,freshness:observation.freshness});
            if(observation.sourceProducedAt!==undefined)stage.sourceProducedAt=Math.max(0,Math.floor(observation.sourceProducedAt));
            if(observation.errorCode)stage.errorCode=observation.errorCode;
            outputs.push(output);tasks.push({stepId:stage.id,input:resolved});
            evidence.set(stage.id,{stepId:stage.id,operation:stage.operation,state:stage.state,availability:observation.availability,freshness:observation.freshness,...(output.latestRunId?{latestRunId:output.latestRunId}:{}),...(output.reportRunId?{reportRunId:output.reportRunId}:{})});
            await emit(stage);
          }finally{activeWorkers--;notify();}
        }}catch(error){lease.controller.abort();notify();throw error;}
      };
      const completed=await Promise.allSettled(Array.from({length:Math.min(PROJECT_STATE_LIMITS.sourceConcurrency,plan.steps.length)},worker));
      const failure=completed.find(v=>v.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
      if(!lease.controller.signal.aborted){try{if(!sameBinding(binding,await this.resolve(lease,owner)))lease.invalidated=true;}catch{lease.invalidated=true;}}
      result.invalidated=lease.invalidated;result.state=lease.invalidated?'unknown':this.combined(stages);result.collectedAt=this.clock.now();result.expiresAt=result.collectedAt+PROJECT_STATE_LIMITS.ttlMs;
      outputs.sort((a,b)=>plan.steps.findIndex(s=>s.id===a.stepId)-plan.steps.findIndex(s=>s.id===b.stepId));
      if(lease.invalidated){for(const output of outputs){output.observation=this.unavailable(output.observation.id,'PROJECT_STATE_TARGET_CHANGED');delete output.latestRunId;delete output.reportRunId;}}
      if(utf8Bytes(JSON.stringify(result))>PROJECT_STATE_LIMITS.previewBytes)throw new ProjectStateError('PROJECT_STATE_OUTPUT_TOO_LARGE');
      this.cache(result.id,{kind:'plan',owner,binding,result:copy(result),tasks});return copy(result);
    }finally{lease.callerDone=true;this.release(lease);}
  }
  readPlanResult(owner:string,targetId:string,id:string):ReadPlanExecutionResult|null{
    this.prune();const record=this.records.get(id);
    return record?.kind==='plan'&&record.owner===owner&&record.result.targetId===targetId?copy(record.result):null;
  }
  private async folded(outputs:ReadPlanStepOutput[],tasks:PlanTask[]):Promise<SourceObservation[]>{
    const observations:SourceObservation[]=[];
    for(const id of PROJECT_STATE_SECTIONS){
      const selected=outputs.filter(o=>o.observation.id===id);if(!selected.length)continue;
      const values=selected.map(o=>({stepId:o.stepId,operation:o.operation,input:tasks.find(t=>t.stepId===o.stepId)!.input,source:sourceValue(o.observation),latestRunId:o.latestRunId??null,reportRunId:o.reportRunId??null}));
      observations.push(projectSourceObservation({id,availability:selected.every(o=>o.observation.availability==='ready')?'ready':'partial',freshness:selected.some(o=>o.observation.freshness==='stale')?'stale':selected.every(o=>o.observation.freshness==='current')?'current':'unknown',
        observedAt:Math.max(...selected.map(o=>o.observation.observedAt)),sourceProducedAt:Math.max(0,...selected.map(o=>o.observation.sourceProducedAt??0))||undefined,sourceRevision:await digest(JSON.stringify(values)),
        summary:selected.flatMap(o=>[`Step ${o.stepId} (${o.operation})`,...o.observation.summary]),limits:selected.flatMap(o=>o.observation.limits)}));
    }
    return observations;
  }
  async preparePlanSelection(owner:string,input:{targetId:string;resultId:string;stepIds:string[]},signal?:AbortSignal):Promise<{prepared:PreparedProjectState;projectState:{bundleId:string;sections:SectionId[];selectionHash:string};resultId:string;stepIds:string[]}>{
    this.prune();const record=this.records.get(input.resultId);
    if(record?.kind!=='plan'||record.owner!==owner||record.result.targetId!==input.targetId||record.result.invalidated)throw new ProjectStateError('PROJECT_STATE_EXPIRED');
    if(!input.stepIds.length||input.stepIds.length>8||new Set(input.stepIds).size!==input.stepIds.length||input.stepIds.some(id=>!record.result.outputs.some(o=>o.stepId===id)||!['completed','partial'].includes(record.result.stages.find(s=>s.id===id)?.state??'')))throw new ProjectStateError('PROJECT_STATE_SELECTION');
    const outputs=record.result.outputs.filter(o=>input.stepIds.includes(o.stepId)),tasks=record.tasks.filter(t=>input.stepIds.includes(t.stepId));
    const observations=await this.folded(outputs,tasks),sections=observations.map(o=>o.id);
    const attachment:PreviewRecord={kind:'preview',owner,binding:record.binding,inputs:[],tasks,bundle:{id:record.result.id,targetId:record.result.targetId,collectedAt:record.result.collectedAt,expiresAt:record.result.expiresAt,state:record.result.state==='completed'?'ready':'partial',observations}};
    record.attachment=attachment;
    const prepared=await this.prepare(owner,{targetId:input.targetId,bundleId:input.resultId,sections},signal);
    return {prepared,projectState:{bundleId:input.resultId,sections,selectionHash:prepared.selectionHash},resultId:input.resultId,stepIds:outputs.map(o=>o.stepId)};
  }
  private async collectPlanSelection(lease:Lease,binding:TargetBinding,tasks:PlanTask[],sections:SectionId[],options?:ProjectStateSendOptions):Promise<SourceObservation[]>{
    const selected=tasks.filter(t=>sections.includes(readToolSection(t.input.operation))),outputs:ReadPlanStepOutput[]=new Array(selected.length);let cursor=0;
    const worker=async()=>{while(cursor<selected.length){const index=cursor++,task=selected[index]!,value=await this.typedTask(lease,binding,task.input,undefined,options);outputs[index]={stepId:task.stepId,operation:task.input.operation,...value};}};
    await Promise.all(Array.from({length:Math.min(PROJECT_STATE_LIMITS.sourceConcurrency,selected.length)},worker));return this.folded(outputs,selected);
  }
  private record(owner:string,input:ProjectStateSelectionInput):PreviewRecord {
    this.prune();const cached=this.records.get(input.bundleId),record=cached?.kind==='plan'?cached.attachment:cached;
    if(!record||record.owner!==owner||record.bundle.targetId!==input.targetId)throw new ProjectStateError('PROJECT_STATE_EXPIRED','상태 묶음이 만료되었거나 대상이 달라졌습니다. 다시 조회하세요.');
    if(record.bundle.state==='invalidated')throw new ProjectStateError('PROJECT_STATE_INVALIDATED');
    return record;
  }
  private invalidate(record:PreviewRecord){record.bundle.state='invalidated';}
  private async prepared(record:PreviewRecord,input:ProjectStateSelectionInput):Promise<PreparedProjectState>{
    const text=projectStateSelectionText(record.bundle,input.sections);
    return {text,bundleId:record.bundle.id,selectionHash:await digest(JSON.stringify({bundleId:input.bundleId,targetId:input.targetId,sections:record.bundle.observations.filter(o=>input.sections.includes(o.id)).map(o=>o.id),text}))};
  }
  async preview(owner:string,input:unknown,signal?:AbortSignal):Promise<ProjectStateBundle>{
    const req=parseProjectStatePreviewInput(input);this.prune();const lease=this.admit(req.targetId,signal);
    try{
      let binding:TargetBinding;
      try{binding=await this.resolve(lease,owner);}catch{throw new ProjectStateError('PROJECT_STATE_TARGET_UNAVAILABLE','대상과 조회 권한을 확인하지 못했습니다.');}
      const inputs:ReadSourceInput[]=PROJECT_STATE_SECTIONS.filter(id=>id!=='memory'||req.memoryQuery!==undefined).map(id=>({id,...(id==='memory'?{query:req.memoryQuery}:{})}));
      const observations=await this.collect(lease,binding,inputs),collectedAt=this.clock.now();let invalidated=lease.invalidated;
      if(!lease.controller.signal.aborted){try{invalidated=!sameBinding(binding,await this.resolve(lease,owner));}catch{invalidated=true;}}
      if(binding.sourceProofComplete===false)observations[0]?.limits.push('source fingerprint incomplete; attachment is unavailable until a complete proof is collected');
      const bundle:ProjectStateBundle={id:(this.deps.uuid??(()=>crypto.randomUUID()))(),targetId:req.targetId,collectedAt,expiresAt:collectedAt+PROJECT_STATE_LIMITS.ttlMs,state:invalidated?'invalidated':binding.sourceProofComplete!==false&&observations.every(o=>o.availability==='ready')?'ready':'partial',observations};
      if(utf8Bytes(JSON.stringify(bundle))>PROJECT_STATE_LIMITS.responseBytes)throw new ProjectStateError('PROJECT_STATE_OUTPUT_TOO_LARGE');
      this.cache(bundle.id,{kind:'preview',owner,binding,bundle:copy(bundle),inputs});return copy(bundle);
    }finally{lease.callerDone=true;this.release(lease);}
  }
  async prepare(owner:string,input:unknown,signal?:AbortSignal):Promise<PreparedProjectState>{
    const req=parseProjectStateSelectionInput(input),record=this.record(owner,req),lease=this.admit(req.targetId,signal);
    try{try{if(record.binding.sourceProofComplete===false)throw new ProjectStateError('PROJECT_STATE_SOURCE_PROOF_INCOMPLETE');if(!sameBinding(record.binding,await this.resolve(lease,owner)))throw new ProjectStateError('PROJECT_STATE_TARGET_CHANGED');}catch{this.invalidate(record);throw new ProjectStateError('PROJECT_STATE_INVALIDATED','완전한 상태 근거를 확인하지 못했습니다. 다시 조회한 뒤 전달하세요.');}return await this.prepared(record,req);}
    finally{lease.callerDone=true;this.release(lease);}
  }
  async withPrepared<T>(owner:string,input:unknown,send:(prepared:PreparedProjectState)=>Promise<T>,signal?:AbortSignal,options?:ProjectStateSendOptions):Promise<T>{
    const req=parseProjectStateSendInput(input),record=this.record(owner,req),prepared=await this.prepared(record,req);
    if(req.selectionHash!==prepared.selectionHash)throw new ProjectStateError('PROJECT_STATE_SELECTION_CHANGED');
    if(record.binding.sourceProofComplete===false)throw new ProjectStateError('PROJECT_STATE_SOURCE_PROOF_INCOMPLETE','완전한 상태 근거를 확인하지 못했습니다. 다시 조회하세요.');
    const lease=this.admit(req.targetId,signal);let enteredSend=false;
    try{
      const binding=await this.resolve(lease,owner);
      if(!sameBinding(record.binding,binding)){this.invalidate(record);throw new ProjectStateError('PROJECT_STATE_INVALIDATED');}
      const inputs=record.inputs.filter(i=>req.sections.includes(i.id)).map(input=>input.id==='workroom'&&options?.excludeWorkroomSessionId
        ? {...input,excludeWorkroomSessionId:options.excludeWorkroomSessionId}:input);
      const selected=record.tasks?await this.collectPlanSelection(lease,binding,record.tasks,req.sections,options):await this.collect(lease,binding,inputs);
      if(lease.controller.signal.aborted||selected.some(source=>sourceValue(source)!==sourceValue(record.bundle.observations.find(o=>o.id===source.id)!))||!sameBinding(binding,await this.resolve(lease,owner))){this.invalidate(record);throw new ProjectStateError('PROJECT_STATE_INVALIDATED','상태 근거가 변경되었습니다. 다시 조회한 뒤 전달하세요.');}
      // Enter the existing submission pipeline without an intervening asynchronous step.
      enteredSend=true;
      return await send(prepared);
    }catch(error){if(enteredSend||error instanceof ProjectStateError)throw error;this.invalidate(record);throw new ProjectStateError('PROJECT_STATE_INVALIDATED');}
    finally{lease.callerDone=true;this.release(lease);}
  }
}
