import {createHash,randomUUID} from 'node:crypto';
import type {TargetBinding,SourceAvailability,SourceFreshness} from './projectStateBundle';
import {READ_TOOL_LIMITS,READ_TOOL_OPERATIONS,assertReadToolJson,parseReadToolPlan,readToolIdentifier,readToolPlanDigest} from './readToolBundle';
import type {ReadToolOperation,ReadStepState} from './readToolBundle';
import type {StoredWorkroomThread,WorkroomThreadStore} from './workroomThreadStore';

/** Durable receipts contain provenance and state only; source values live in the host preview. */
export interface ReadExecutionStageMetadata {
 id:string;operation:ReadToolOperation;state:ReadStepState;
 startedAt?:number;finishedAt?:number;observedAt?:number;sourceProducedAt?:number;
 sourceId?:string;sourceRevision?:string;outputDigest?:string;
 availability?:SourceAvailability;freshness?:SourceFreshness;errorCode?:string;
}
export interface ReadToolBatch {
 runId:string;threadId:string;requestId:string;owner:string;targetId:string;
 bindingHash:string;intentHash:string;bootId:string;revision:number;
 createdAt:number;updatedAt:number;state:ReadStepState;stages:ReadExecutionStageMetadata[];
 /** No durable payload exists, including after preview expiry or restart. */
 payload:'unavailable';cancelRequestedAt?:number;
}
export interface ReadToolBatchAdmission {
 threadId:string;requestId:string;owner:string;binding:TargetBinding;
 /** Parsed again here before storage admission; raw query/input is never persisted. */
 plan:unknown;
}
export interface ReadToolBatchRepository {
 admit(input:ReadToolBatchAdmission,active:()=>boolean):Promise<{batch:ReadToolBatch;created:boolean}>;
 read(threadId:string,requestId:string,owner:string,active:()=>boolean):Promise<ReadToolBatch|null>;
 compareAndSet(threadId:string,requestId:string,owner:string,expectedRevision:number,next:ReadToolBatch,active:()=>boolean):Promise<ReadToolBatch>;
}
export class ReadExecutionError extends Error {
 constructor(readonly code:string){super(code);this.name='ReadExecutionError';}
}
function fail(code:string):never {throw new ReadExecutionError(code);}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const terminal=(state:ReadStepState)=>!['pending','running'].includes(state);
const unsettled=(batch:ReadToolBatch)=>['pending','running'].includes(batch.state);
const states=['pending','running','completed','partial','failed','skipped','cancelled','unknown'];
const batchKeys=['runId','threadId','requestId','owner','targetId','bindingHash','intentHash','bootId','revision','createdAt','updatedAt','state','stages','payload','cancelRequestedAt'];
const stageKeys=['id','operation','state','startedAt','finishedAt','observedAt','sourceProducedAt','sourceId','sourceRevision','outputDigest','availability','freshness','errorCode'];
const immutableKeys=['runId','threadId','requestId','owner','targetId','bindingHash','intentHash','bootId','createdAt'] as const;
function exact(value:object,keys:string[]){if(Object.keys(value).some(k=>!keys.includes(k)))fail('READ_EXECUTION_METADATA');}
function time(value:unknown){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)fail('READ_EXECUTION_METADATA');}
function validate(batch:ReadToolBatch):void {
 assertReadToolJson(batch,READ_TOOL_LIMITS.metadataBytes);exact(batch,batchKeys);
 for(const k of ['runId','threadId','requestId','owner','targetId','bootId'] as const)readToolIdentifier(batch[k]);
 if(!/^[a-f0-9]{64}$/.test(batch.bindingHash)||!/^[a-f0-9]{64}$/.test(batch.intentHash)||!Number.isSafeInteger(batch.revision)||batch.revision<1||!states.includes(batch.state)||batch.payload!=='unavailable')fail('READ_EXECUTION_METADATA');
 time(batch.createdAt);time(batch.updatedAt);if(batch.cancelRequestedAt!==undefined)time(batch.cancelRequestedAt);
 if(!Array.isArray(batch.stages)||!batch.stages.length||batch.stages.length>READ_TOOL_LIMITS.stages||new Set(batch.stages.map(s=>s.id)).size!==batch.stages.length)fail('READ_EXECUTION_METADATA');
 for(const s of batch.stages){
  exact(s,stageKeys);readToolIdentifier(s.id);
  if(!READ_TOOL_OPERATIONS.includes(s.operation)||!states.includes(s.state))fail('READ_EXECUTION_METADATA');
  for(const key of ['startedAt','finishedAt','observedAt','sourceProducedAt'] as const)if(s[key]!==undefined)time(s[key]);
  for(const key of ['sourceId','sourceRevision'] as const)if(s[key]!==undefined)readToolIdentifier(s[key]);
  if(s.outputDigest!==undefined&&!/^[a-f0-9]{64}$/.test(s.outputDigest))fail('READ_EXECUTION_METADATA');
  if(s.errorCode!==undefined&&!/^[A-Z][A-Z0-9_]{0,63}$/.test(s.errorCode))fail('READ_EXECUTION_METADATA');
  if(s.availability!==undefined&&!['ready','unconfigured','partial','unknown','unavailable'].includes(s.availability))fail('READ_EXECUTION_METADATA');
  if(s.freshness!==undefined&&!['current','stale','unknown'].includes(s.freshness))fail('READ_EXECUTION_METADATA');
 }
}
function combinedState(stages:ReadExecutionStageMetadata[]):ReadStepState {
 const values=stages.map(s=>s.state);
 if(values.includes('unknown'))return 'unknown';
 if(values.includes('running'))return 'running';
 if(values.includes('pending'))return 'pending';
 if(values.includes('cancelled'))return 'cancelled';
 if(values.every(v=>v==='completed'))return 'completed';
 if(values.includes('completed')||values.includes('partial'))return 'partial';
 if(values.includes('failed'))return 'failed';return 'skipped';
}
/** Append-only facade over one exact existing DEV thread. No reader, executor, provider or queue port.
 * Host admission still owns target/host concurrency, unsettled child slots and authority revalidation.
 * Unknown receipts are retained; a new explicit ID may observe again only after host admission permits it. */
export class WorkroomThreadReadExecutionRepository implements ReadToolBatchRepository {
 readonly bootId:string;
 private now:()=>number;
 constructor(private store:WorkroomThreadStore,options:{bootId?:string;now?:()=>number}={}){
  this.bootId=options.bootId??randomUUID();this.now=options.now??Date.now;
 }
 private allowed(record:StoredWorkroomThread|null,owner:string,active:()=>boolean,targetId?:string):asserts record is StoredWorkroomThread {
  if(!active()||!record||record.owner!==owner||record.serviceExecution||record.execution||record.group||record.groupParentId||(targetId!==undefined&&record.targetId!==targetId))fail('READ_EXECUTION_ACCESS');
 }
 private lookup(record:StoredWorkroomThread,requestId:string):ReadToolBatch|null {
  const matches=record.readExecutions?.filter(b=>b.requestId===requestId)??[];
  if(matches.length>1)fail('READ_EXECUTION_METADATA');
  const batch=matches[0];if(!batch)return null;
  validate(batch);
  if(batch.threadId!==record.id||batch.owner!==record.owner||batch.targetId!==record.targetId)fail('READ_EXECUTION_ACCESS');
  return batch;
 }
 private async get(threadId:string,owner:string,active:()=>boolean,targetId?:string){
  readToolIdentifier(threadId);readToolIdentifier(owner);
  // This explicit lookup is the authorization boundary; no global JSON search/index exists.
  const record=await this.store.get(threadId);this.allowed(record,owner,active,targetId);return record;
 }
 async admit(input:ReadToolBatchAdmission,active:()=>boolean):Promise<{batch:ReadToolBatch;created:boolean}>{
  const plan=parseReadToolPlan(input.plan);readToolIdentifier(input.requestId);
  const b=input.binding;
  if(!b||b.role!=='dev'||b.owner!==input.owner||typeof b.proof!=='string'||!b.proof||b.proof.length>4096)fail('READ_EXECUTION_ACCESS');
  readToolIdentifier(b.projectId);readToolIdentifier(b.targetId);
  const bindingHash=digest({targetId:b.targetId,projectId:b.projectId,role:b.role,owner:b.owner,proof:b.proof});
  const intentHash=digest({bindingHash,planHash:readToolPlanDigest(plan)});
  await this.get(input.threadId,input.owner,active,b.targetId);
  return this.store.mutateReadExecutions<{batch:ReadToolBatch;created:boolean}>(input.threadId,active,record=>{
   this.allowed(record,input.owner,active,b.targetId);
   const previous=this.lookup(record,input.requestId),all=record.readExecutions??[];
   if(previous){
    if(previous.intentHash!==intentHash||previous.bindingHash!==bindingHash)fail('READ_EXECUTION_CONFLICT');
    const recovered=this.recover(previous);
    return {readExecutions:all.map(v=>v.requestId===previous.requestId?recovered:v),value:{batch:structuredClone(recovered),created:false},...(same(previous,recovered)?{unchanged:true as const}:{})};
   }
   if(all.some(unsettled))fail('READ_EXECUTION_BUSY');
   const at=this.now();
   const batch:ReadToolBatch={runId:randomUUID(),threadId:record.id,requestId:input.requestId,owner:record.owner,targetId:record.targetId,bindingHash,intentHash,bootId:this.bootId,revision:1,createdAt:at,updatedAt:at,state:'pending',stages:plan.steps.map(s=>({id:s.id,operation:s.input.operation,state:'pending'})),payload:'unavailable'};
   validate(batch);return {readExecutions:[...all,batch],value:{batch:structuredClone(batch),created:true}};
  });
 }
 private recover(batch:ReadToolBatch):ReadToolBatch {
  if(batch.bootId===this.bootId||!batch.stages.some(s=>s.state==='running'||s.state==='pending'))return batch;
  const stages=batch.stages.map(s=>terminal(s.state)?s:{...s,state:'unknown' as const,errorCode:'RESTART_UNKNOWN'});
  return {...batch,stages,state:'unknown',revision:batch.revision+1,updatedAt:this.now()};
 }
 async read(threadId:string,requestId:string,owner:string,active:()=>boolean):Promise<ReadToolBatch|null>{
  readToolIdentifier(requestId);const record=await this.get(threadId,owner,active),batch=this.lookup(record,requestId);
  if(!batch)return null;
  if(this.recover(batch)===batch)return structuredClone(batch);
  return this.store.mutateReadExecutions(threadId,active,current=>{
   this.allowed(current,owner,active);const latest=this.lookup(current,requestId);if(!latest)fail('READ_EXECUTION_MISSING');
   const recovered=this.recover(latest);
   return {readExecutions:current.readExecutions!.map(v=>v.requestId===requestId?recovered:v),value:structuredClone(recovered),...(same(latest,recovered)?{unchanged:true as const}:{})};
  });
 }
 async compareAndSet(threadId:string,requestId:string,owner:string,expectedRevision:number,next:ReadToolBatch,active:()=>boolean):Promise<ReadToolBatch>{
  validate(next);readToolIdentifier(requestId);
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)fail('READ_EXECUTION_REVISION');
  await this.get(threadId,owner,active);
  return this.store.mutateReadExecutions(threadId,active,current=>{
   this.allowed(current,owner,active);const prior=this.lookup(current,requestId);if(!prior)fail('READ_EXECUTION_MISSING');
   if(immutableKeys.some(k=>!same(prior[k],next[k]))||prior.threadId!==threadId||prior.owner!==owner||prior.requestId!==requestId||prior.stages.length!==next.stages.length||prior.stages.some((s,i)=>s.id!==next.stages[i]!.id||s.operation!==next.stages[i]!.operation))fail('READ_EXECUTION_CONFLICT');
   if(expectedRevision>prior.revision||next.revision!==expectedRevision)fail('READ_EXECUTION_REVISION');
   // An old process cannot report completion after restart recovery. Preserve the original receipt.
   const recovered=this.recover(prior);
   if(recovered!==prior)return {readExecutions:current.readExecutions!.map(v=>v.requestId===requestId?recovered:v),value:structuredClone(recovered)};
   const stale=expectedRevision!==prior.revision;
   const stages=prior.stages.map((old,i)=>{
    const incoming=next.stages[i]!;
    if(terminal(old.state)||old.state==='running'&&incoming.state==='pending')return old;
    // A stale snapshot may add a terminal result, but cannot revise another running stage's evidence.
    if(stale&&incoming.state===old.state)return old;
    return structuredClone(incoming);
   });
   const merged:ReadToolBatch={...prior,stages,state:combinedState(stages)};
   if(same(merged,prior))return {readExecutions:current.readExecutions!,value:structuredClone(prior),unchanged:true};
   merged.updatedAt=this.now();merged.revision++;validate(merged);
   return {readExecutions:current.readExecutions!.map(v=>v.requestId===requestId?merged:v),value:structuredClone(merged)};
  });
 }
 /** Records cancellation only. Actual AbortSignal/child termination belongs to the shared host.
  * A running native operation is unknown until settlement, so this never frees a host slot. */
 async cancel(threadId:string,requestId:string,owner:string,active:()=>boolean):Promise<ReadToolBatch>{
  readToolIdentifier(requestId);await this.get(threadId,owner,active);
  return this.store.mutateReadExecutions(threadId,active,current=>{
   this.allowed(current,owner,active);const prior=this.lookup(current,requestId);if(!prior)fail('READ_EXECUTION_MISSING');
   if(prior.cancelRequestedAt!==undefined||prior.stages.every(s=>terminal(s.state)))return {readExecutions:current.readExecutions!,value:structuredClone(prior),unchanged:true};
   const at=this.now(),stages=prior.stages.map(s=>terminal(s.state)?s:{...s,state:s.state==='running'?'unknown' as const:'cancelled' as const,errorCode:s.state==='running'?'CANCEL_UNCONFIRMED':'CANCELLED'});
   const batch:ReadToolBatch={...prior,stages,state:combinedState(stages),cancelRequestedAt:at,updatedAt:at,revision:prior.revision+1};validate(batch);
   return {readExecutions:current.readExecutions!.map(v=>v.requestId===requestId?batch:v),value:structuredClone(batch)};
  });
 }
}
