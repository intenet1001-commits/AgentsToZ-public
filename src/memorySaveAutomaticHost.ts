import {automaticMemoryOwns} from './memorySaveAutomaticPolicy';
import {existsSync,realpathSync} from 'node:fs';
import {detectProjectMemory} from '../project-memory-server';
import {MemorySaveStore} from './memorySaveStore';
import {MemorySaveDispatcher} from './memorySaveDispatcher';
import {MemorySaveKeyLifecycle} from './memorySaveKeyLifecycle';
import {MemoryEmergencyReserve} from './memoryEmergencyReserve';
import {memorySaveTextProvider,prepareMemoryProvider,revalidateMemoryProvider,type MemoryProviderHost} from './memorySaveProvider';
import {executeAutomaticMemorySave} from './memorySaveExecutor';
import {reviewAmbiguousMemorySave,executeAmbiguousMemorySave,type MemoryRecoveryExecution} from './memorySaveRecoveryExecutor';
import {reviewRecoveryProvider,verifyRecoveryProvider} from './memorySaveProviderTransitionExecutor';
import {selectAutomaticMemorySources} from './memorySaveSelection';
import {MemorySaveError,saveDigest,saveInteger,saveToken} from './memorySaveContract';
import type {MemoryObservationCandidate} from './memoryObservationCoordinator';
import type {MemorySessionStore} from './memorySessionStore';
import type {WorkspaceLease} from './workspaceLease';
import type {MemorySaveFailure} from './memorySaveFailure';
import type {MemorySaveRecoveryEvidence} from './memorySaveRecovery';

export interface AutomaticMemoryTarget {id:string;cwd:string;root:string;memoryId:string;validate:()=>Promise<boolean>}
export type AutomaticMemoryRunState='saved'|'idle'|'waiting-idle'|'source-unavailable'|'oversized'|'pending'|'budget-paused'|'recovery-required'|'provider-changed'|'busy'|'unavailable';
export interface AutomaticMemoryRunResult {state:AutomaticMemoryRunState;localSaved:boolean;backupPending?:boolean;hasMore?:boolean;failure?:MemorySaveFailure|null;recovery?:MemorySaveRecoveryEvidence|null;historicalReceipt?:boolean}
export class MemorySaveAutomaticHost {
 #tickRunning=false;#after:string|null=null;#active:AbortController|null=null;
 #scans=new Map<string,number>();#results=new Map<string,AutomaticMemoryRunResult>();
 constructor(private d:{
  enabled:()=>boolean;store:MemorySaveStore;sessions:MemorySessionStore;appDataRoot:string;portalDataFile:string;
  dispatcher:MemorySaveDispatcher;identity:(create:boolean)=>string|null;
  targets:(scopeTargetId?:string|null)=>Promise<{id:string}[]>;resolve:(id:string)=>Promise<AutomaticMemoryTarget|null>;
  discover:(cwd:string)=>Promise<MemoryObservationCandidate[]>;
  providerHost:(id:string)=>MemoryProviderHost;
  acquireApp:()=>Promise<WorkspaceLease>;acquireWorkspace:(root:string)=>Promise<WorkspaceLease>;release:(lease:WorkspaceLease)=>void;
  preflight:(root:string)=>Promise<void>;recoveryPreflight?:(root:string)=>Promise<void>;disableLegacy:()=>void;
  key?:(id:string)=>Pick<MemorySaveKeyLifecycle,'load'>;
  maintenanceStatus?:()=>{expiry:string;backup:string};
 }){}
 policy(){return existsSync(this.d.store.path)?this.d.store.automaticPolicy():{revision:0,enabled:false,enabledAt:null,providerBindingDigest:null,excludedMemoryIds:[],scopeMemoryId:null,scopeTargetId:null};}
 owns(memoryId:string){return this.d.enabled()&&automaticMemoryOwns(this.policy(),memoryId);}
 handles(memoryId:string){const p=this.policy();return this.d.enabled()&&automaticMemoryOwns(p,memoryId)&&!p.excludedMemoryIds.includes(memoryId);}
 blocksLegacyGlobally(){const p=this.policy();return p.enabled&&p.scopeMemoryId===null;}
 #keep<T>(map:Map<string,T>,key:string,value:T){map.delete(key);map.set(key,value);while(map.size>128)map.delete(map.keys().next().value!);}
 #targetKey(target:AutomaticMemoryTarget){return saveDigest([target.id,target.memoryId,target.root,target.cwd]);}
 durableResult(target:AutomaticMemoryTarget):AutomaticMemoryRunResult|null {
  return this.#durableResult(target,this.d.store.statusSnapshot(target.memoryId));
 }
 #durableResult(target:AutomaticMemoryTarget,snapshot:ReturnType<MemorySaveStore['statusSnapshot']>):AutomaticMemoryRunResult|null {
  const job=snapshot?.job;if(!snapshot||!job)return null;
  const saved=job.phase==='local-saved';
  const linked=snapshot.binding?.sessionPlanId??null,rootMatches=snapshot.binding?.rootDigest===saveDigest(target.root);
  let pending:ReturnType<MemorySessionStore['status']>=null,recovery:MemorySaveRecoveryEvidence|null=null;
  try{
   // Only ENOENT means absent. Busy, unreadable, malformed or future records
   // remain unknown; neither bodies nor keys are read for this assessment.
   pending=this.d.sessions.status(target.root,{readOnly:true});
   if(pending&&(!saveToken(pending.id)||!['document','journal','state','outcome'].includes(pending.phase)))throw new MemorySaveError('STORAGE_UNAVAILABLE');
   if(snapshot.bindingUnavailable)throw new MemorySaveError('STORAGE_UNAVAILABLE');
   if((saved||linked)&&!rootMatches)recovery='plan-needs-review';
   else if(pending&&linked===pending.id)recovery=saved?'saved-plan':'bound-plan';
   else if(!saved||pending)recovery=!pending&&!linked?'no-retained-plan':'plan-needs-review';
  }catch{recovery='unavailable';}
  // A receipt can precede host-plan retirement. Only its exact pending plan
  // shares that success; another pending plan must retain its own uncertainty.
  const localSaved=saved&&rootMatches&&recovery!=='unavailable'&&(!pending||linked===pending.id);
  return {state:localSaved&&!pending?'saved':'recovery-required',localSaved,backupPending:saved&&snapshot.backup.pending>0,
   failure:saved?null:snapshot.failure,recovery,historicalReceipt:saved};
 }
 async status(target:AutomaticMemoryTarget){
  if(!await target.validate())throw new MemorySaveError('SOURCE_CONFLICT');
  const snapshot=this.d.store.statusSnapshot(target.memoryId);
  const policy=snapshot?.policy??{revision:0,enabled:false,enabledAt:null,providerBindingDigest:null,excludedMemoryIds:[],scopeMemoryId:null,scopeTargetId:null},binding=snapshot?.provider??null;
  const durable=this.#durableResult(target,snapshot),recent=this.#results.get(this.#targetKey(target));
  // Durable recovery work takes precedence over transient admission results.
  // Exact recovery can finish outside this host, so retire its stale cached
  // recovery result only after both the receipt and host-plan cleanup exist.
  const last=durable&&(durable.state==='recovery-required'||recent?.state==='recovery-required')?{...recent,...durable}
   :recent?{...recent,failure:durable?.failure??null,recovery:durable?.recovery??null}:durable;
  let recoveryProvider:null|{state:'claimed'|'ready'|'failed'|'unknown'|'unavailable';completedAt:number|null}=null;
  if(snapshot?.job?.phase==='recovery-required'){
   try{
    const probe=this.d.store.latestRecoveryProviderTransition(snapshot.job.saveId);
    if(probe){
     const context=probe.binding;
     const matches=context.parentAttemptId===snapshot.job.attemptId&&context.memoryId===target.memoryId
      &&context.targetId===target.id&&context.rootDigest===saveDigest(target.root)
      &&context.registrationDigest===saveDigest([target.id,target.memoryId,target.root,target.cwd]);
     recoveryProvider={state:matches?probe.state:'unavailable',completedAt:matches?probe.completedAt:null};
    }
   }catch{recoveryProvider={state:'unavailable',completedAt:null};}
  }
  return {version:1,targetId:target.id,maintenance:this.d.maintenanceStatus?.()??null,supported:this.d.enabled(),revision:policy.revision,enabled:policy.enabled,
   excluded:policy.excludedMemoryIds.includes(target.memoryId),scope:policy.scopeMemoryId===null?'all':'project',inScope:policy.scopeMemoryId===null||policy.scopeMemoryId===target.memoryId,
   provider:binding?{model:binding.model,effort:binding.effort,configurationId:saveDigest(binding),preparedAt:binding.preparedAt}:null,
   last,recoveryProvider,backup:snapshot?.backup??{pending:0,blocked:0,hasMore:false}};
 }
 /** Called behind the existing local capability; accepts no account/path/key. */
 async manage(body:unknown){
  const b=body as Record<string,unknown>;
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['automaticOperation','observationTargetId','model','effort','expectedRevision','configurationId','consentVersion','excluded','scope','approvalId','reviewDigest','explicitConsent'].includes(k))
   ||typeof b.observationTargetId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(b.observationTargetId)
   ||!['status','prepare-provider','revalidate-provider','enable','disable','exclude','review-recovery','execute-recovery','review-recovery-provider','verify-recovery-provider'].includes(String(b.automaticOperation)))throw new MemorySaveError('INVALID_INPUT');
  const allowed:Record<string,string[]>={status:[], 'prepare-provider':['model','effort'],'revalidate-provider':['expectedRevision','configurationId'],enable:['expectedRevision','configurationId','consentVersion','scope'],disable:['expectedRevision'],exclude:['expectedRevision','excluded'],'review-recovery':[],'execute-recovery':['approvalId','reviewDigest','explicitConsent'],'review-recovery-provider':[],'verify-recovery-provider':['approvalId','reviewDigest','explicitConsent']};
  if(Object.keys(b).some(k=>!['automaticOperation','observationTargetId',...allowed[String(b.automaticOperation)]!].includes(k)))throw new MemorySaveError('INVALID_INPUT');
  if(b.automaticOperation==='prepare-provider'&&(typeof b.model!=='string'||!/^claude-[a-z0-9][a-z0-9.-]{1,95}$/.test(b.model)||!['low','medium'].includes(String(b.effort))))throw new MemorySaveError('INVALID_INPUT');
  if(b.automaticOperation==='enable'&&(!saveInteger(b.expectedRevision)||b.consentVersion!==1||typeof b.configurationId!=='string'||!['project','all'].includes(String(b.scope))))throw new MemorySaveError('INVALID_INPUT');
  if(b.automaticOperation==='revalidate-provider'&&(!saveInteger(b.expectedRevision)||typeof b.configurationId!=='string'))throw new MemorySaveError('INVALID_INPUT');
  if(!this.d.enabled())throw new MemorySaveError('POLICY_DISABLED');
  const target=await this.d.resolve(b.observationTargetId);if(!target||!await target.validate())throw new MemorySaveError('SOURCE_CONFLICT');
  if(b.automaticOperation==='status')return this.status(target);
  if(['review-recovery','execute-recovery','review-recovery-provider','verify-recovery-provider'].includes(String(b.automaticOperation)))return this.#recover(target,b);
  if(b.automaticOperation==='disable'||b.automaticOperation==='exclude'){
   if(!saveInteger(b.expectedRevision)||(b.automaticOperation==='exclude'&&typeof b.excluded!=='boolean'))throw new MemorySaveError('INVALID_INPUT');
   const p=this.policy();
   if(!existsSync(this.d.store.path)&&b.automaticOperation==='disable'){if(b.expectedRevision!==0)throw new MemorySaveError('POLICY_CHANGED');return this.status(target);}
   if(!this.d.identity(true))throw new MemorySaveError('STORAGE_UNAVAILABLE');
   // Opt-out does not wait behind a running model's app-data lease.
   if(b.automaticOperation==='disable'){
    this.d.store.setAutomaticPolicy(b.expectedRevision,{enabled:false});this.#active?.abort();
   }else{
    const ids=p.excludedMemoryIds.filter(id=>id!==target.memoryId);if(b.excluded)ids.push(target.memoryId);
    this.d.store.setAutomaticPolicy(b.expectedRevision,{enabled:p.enabled,consentVersion:1,providerBindingDigest:p.providerBindingDigest??undefined,excludedMemoryIds:ids});
    this.#active?.abort();
   }
   return this.status(target);
  }
  return this.d.dispatcher.schedule({root:target.root,trigger:'manual',run:async signal=>{
   const workspace=['enable','revalidate-provider'].includes(String(b.automaticOperation))?await this.d.acquireWorkspace(target.root):null;
   let lease:WorkspaceLease|undefined;
   try{
    lease=await this.d.acquireApp();
    if(!lease.refresh()||workspace&&!workspace.refresh()||!await target.validate())throw new MemorySaveError('SOURCE_CONFLICT');
    if(b.automaticOperation==='enable'&&this.policy().enabled)throw new MemorySaveError('POLICY_CHANGED');
    const priorBinding=b.automaticOperation==='revalidate-provider'
     ?this.d.store.assertProviderRevalidation(b.expectedRevision as number,b.configurationId as string):null;
    if(priorBinding&&(!this.owns(target.memoryId)||this.d.sessions.status(target.root)))throw new MemorySaveError('RECOVERY_REQUIRED');
    const id=this.d.identity(true);if(!id)throw new MemorySaveError('STORAGE_UNAVAILABLE');
    const key=await (this.d.key?.(id)??new MemorySaveKeyLifecycle(this.d.appDataRoot,id)).load();key.fill(0);
    if(priorBinding){
     const binding=await revalidateMemoryProvider(this.d.providerHost(id),priorBinding,signal);
     signal.throwIfAborted();
     if(!lease.refresh()||!workspace?.refresh()||!await target.validate())throw new MemorySaveError('SOURCE_CONFLICT');
     this.d.store.revalidateProviderBinding(b.expectedRevision as number,b.configurationId as string,binding);
    }else if(b.automaticOperation==='prepare-provider'){
     if(this.policy().enabled||typeof b.model!=='string'||!['low','medium'].includes(String(b.effort)))throw new MemorySaveError('INVALID_INPUT');
     const binding=await prepareMemoryProvider(this.d.providerHost(id),b.model,b.effort as 'low'|'medium',signal);
     if(!lease.refresh()||workspace&&!workspace.refresh()||!await target.validate())throw new MemorySaveError('SOURCE_CONFLICT');
     this.d.store.setProviderBinding(binding);
    }else{
     if(!saveInteger(b.expectedRevision)||b.consentVersion!==1||typeof b.configurationId!=='string')throw new MemorySaveError('INVALID_INPUT');
     const binding=this.d.store.providerBinding();if(!binding||saveDigest(binding)!==b.configurationId)throw new MemorySaveError('POLICY_CHANGED');
     if(!await memorySaveTextProvider(this.d.providerHost(id),binding).ready())throw new MemorySaveError('POLICY_CHANGED');
     await new MemoryEmergencyReserve(this.d.appDataRoot,lease).ensure();
     if(!lease.refresh()||workspace&&!workspace.refresh()||!await target.validate())throw new MemorySaveError('SOURCE_CONFLICT');
     // Global opt-in replaces legacy checkpoints; project opt-in leaves other
     // roots alone. The workspace lease fences a same-project legacy save.
     if(this.policy().revision!==b.expectedRevision)throw new MemorySaveError('POLICY_CHANGED');
     if(b.scope==='all')this.d.disableLegacy();
     this.d.store.setAutomaticPolicy(b.expectedRevision,{enabled:true,consentVersion:1,providerBindingDigest:saveDigest(binding),scopeMemoryId:b.scope==='project'?target.memoryId:null,scopeTargetId:b.scope==='project'?target.id:null});
    }
    return this.status(target);
   }finally{if(lease)this.d.release(lease);if(workspace)this.d.release(workspace);}
  }});
 }
 async #recover(target:AutomaticMemoryTarget,b:Record<string,unknown>){
  if(['execute-recovery','verify-recovery-provider'].includes(String(b.automaticOperation))&&(typeof b.approvalId!=='string'||typeof b.reviewDigest!=='string'||b.explicitConsent!==true))throw new MemorySaveError('INVALID_INPUT');
  if(!this.d.recoveryPreflight)throw new MemorySaveError('STORAGE_UNAVAILABLE');
  return this.d.dispatcher.schedule({root:target.root,trigger:'manual',run:async signal=>{
   const workspace=await this.d.acquireWorkspace(target.root);let app:WorkspaceLease|undefined;
   const controller=new AbortController(),abort=()=>controller.abort();this.#active=controller;
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   try{
    app=await this.d.acquireApp();
    if(!await target.validate())throw new MemorySaveError('SOURCE_CONFLICT');
    const id=this.d.identity(false),binding=this.d.store.providerBinding();
    if(!id||!binding)throw new MemorySaveError('POLICY_CHANGED');
    const c:MemoryRecoveryExecution={root:target.root,cwd:target.cwd,targetId:target.id,instanceId:id,
     appDataRoot:this.d.appDataRoot,workspaceLease:workspace,stagingLease:app,saves:this.d.store,sessions:this.d.sessions,
     candidates:await this.d.discover(target.cwd),provider:memorySaveTextProvider(this.d.providerHost(id),binding),providerHost:this.d.providerHost(id),
     readKey:()=>(this.d.key?.(id)??new MemorySaveKeyLifecycle(this.d.appDataRoot,id)).load(),
     validateRegistration:async()=>await target.validate()?{memoryId:target.memoryId,canonicalRoot:target.root}:null,
     preflight:()=>this.d.recoveryPreflight!(target.root),portalDataFile:this.d.portalDataFile,signal:controller.signal};
    if(b.automaticOperation==='review-recovery-provider'){
     const providerRecoveryReview=await reviewRecoveryProvider(c);
     return {...await this.status(target),providerRecoveryReview};
    }
    if(b.automaticOperation==='verify-recovery-provider'){
     await verifyRecoveryProvider(c,{approvalId:b.approvalId as string,reviewDigest:b.reviewDigest as string,explicitConsent:true});
     return this.status(target);
    }
    if(b.automaticOperation==='review-recovery'){
     const parent=this.d.store.statusSnapshot(target.memoryId)?.job;
     if(!parent)throw new MemorySaveError('RECOVERY_REQUIRED');
     const recoveryReview=await reviewAmbiguousMemorySave(c,parent.saveId);
     return {...await this.status(target),recoveryReview:{...recoveryReview,model:binding.model,effort:binding.effort}};
    }
    await executeAmbiguousMemorySave(c,{approvalId:b.approvalId as string,reviewDigest:b.reviewDigest as string,explicitConsent:true});
    this.#results.delete(this.#targetKey(target));
    return this.status(target);
   }finally{signal.removeEventListener('abort',abort);if(this.#active===controller)this.#active=null;if(app)this.d.release(app);this.d.release(workspace);}
  }});
 }
 async runLeased(target:AutomaticMemoryTarget,workspaceLease:WorkspaceLease,signal:AbortSignal,manual=false):Promise<AutomaticMemoryRunResult>{
  let result=await this.#executeLeased(target,workspaceLease,signal,manual);
  // Bind a failed execution to its durable unfinished work before caching it.
  // Later exact recovery can then retire any original error classification;
  // an older saved receipt must never mask a new admission/scan failure.
  try{const durable=this.durableResult(target);if(durable?.state==='recovery-required')result={...result,...durable};}
  catch{/* A status read failure cannot replace the execution result. */}
  this.#keep(this.#results,this.#targetKey(target),result);return result;
 }
 async #executeLeased(target:AutomaticMemoryTarget,workspaceLease:WorkspaceLease,signal:AbortSignal,manual=false):Promise<AutomaticMemoryRunResult>{
  const beforeJob=existsSync(this.d.store.path)?this.d.store.latestJob(target.memoryId):null;
  let appLease:WorkspaceLease|undefined;const controller=new AbortController();this.#active=controller;
  const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  try{
   const p=this.policy();if(!this.handles(target.memoryId)||!await target.validate())throw new MemorySaveError('POLICY_DISABLED');
   if(this.d.store.openJob(target.memoryId)||this.d.sessions.status(target.root))return {state:'recovery-required',localSaved:false};
   const current=detectProjectMemory(target.root);
   // The legacy badge additionally requires Git/file churn. A completed,
   // unreserved post-consent conversation is itself unsaved activity in V2.
   const candidates=await this.d.discover(target.cwd);
   const id=this.d.identity(false);if(!id)throw new MemorySaveError('STORAGE_UNAVAILABLE');
   const selected=await selectAutomaticMemorySources({store:this.d.store,memoryId:target.memoryId,policyEpoch:1,revision:p.revision,
    after:this.#scans.get(this.#targetKey(target))??0,instanceId:id,cwd:target.cwd,candidates,
    validateRegistrationAndLease:async()=>workspaceLease.refresh()&&await target.validate()&&this.policy().revision===p.revision});
   this.#keep(this.#scans,this.#targetKey(target),selected.nextCursor??0);
   const hasMore=selected.nextCursor!==null||selected.remaining>0||selected.unavailable>0||selected.oversized>0;
   if(!selected.sources.length)return {state:selected.oversized?'oversized':selected.unavailable?'source-unavailable':hasMore?'pending':'idle',localSaved:false,hasMore};
   const latest=Math.max(...selected.sources.map(s=>s.source.completedAt),Date.parse(current.activity.lastActivityAt??'')||0,
    ...candidates.map(c=>Number(c.stamp.split(':').at(-1))||0));
   if(!manual&&Date.now()-latest<120_000)return {state:'waiting-idle',localSaved:false,hasMore:true};
   const binding=this.d.store.providerBinding();if(!binding)throw new MemorySaveError('POLICY_CHANGED');
   appLease=await this.d.acquireApp();
   const result=await executeAutomaticMemorySave({root:realpathSync(target.root),appDataRoot:this.d.appDataRoot,workspaceLease,stagingLease:appLease,
    saves:this.d.store,sessions:this.d.sessions,sources:selected.sources,provider:memorySaveTextProvider(this.d.providerHost(id),binding),
    readKey:()=>(this.d.key?.(id)??new MemorySaveKeyLifecycle(this.d.appDataRoot,id)).load(),
    validateRegistration:async()=>await target.validate()?{memoryId:target.memoryId,canonicalRoot:target.root}:null,
    preflight:()=>this.d.preflight(target.root),portalDataFile:this.d.portalDataFile,signal:controller.signal});
   return {state:'saved',localSaved:result.localSaved,backupPending:result.backupRequested,hasMore};
  }catch(e:any){
   // A receipt committed before host-plan cleanup failed is still a real local save.
   const afterJob=this.d.store.latestJob(target.memoryId);
   if(afterJob&&afterJob.saveId!==beforeJob?.saveId&&afterJob.phase==='local-saved')return {state:'recovery-required',localSaved:true,backupPending:this.d.store.backupSummary(target.memoryId).pending>0};
   const state:AutomaticMemoryRunState=e?.code==='BUDGET_PAUSED'?'budget-paused':e?.code==='POLICY_CHANGED'?'provider-changed'
    :['RECOVERY_REQUIRED','COVERAGE_RESERVED','EXECUTION_BUSY'].includes(e?.code)?'recovery-required'
    :['WORKSPACE_LEASE_BUSY','MEMORY_SAVE_BUSY'].includes(e?.code)?'busy':e?.code==='SOURCE_OVERSIZED'||e?.code==='INPUT_OVERSIZED'?'oversized':'unavailable';
   return {state,localSaved:false};
  }finally{signal.removeEventListener('abort',abort);if(this.#active===controller)this.#active=null;if(appLease)this.d.release(appLease);}
 }
 async run(id:string,manual=false){
  const target=await this.d.resolve(id);if(!target)throw new MemorySaveError('SOURCE_CONFLICT');
  if(!this.handles(target.memoryId))return {state:'idle' as const,localSaved:false};
  const result=await this.d.dispatcher.schedule({root:target.root,trigger:manual?'manual':'checkpoint',run:async signal=>{
   const lease=await this.d.acquireWorkspace(target.root);
   try{return await this.runLeased(target,lease,signal,manual);}finally{this.d.release(lease);}
  }});
  this.#keep(this.#results,this.#targetKey(target),result);return result;
 }
 async tick(){
  if(this.#tickRunning||!this.d.enabled())return;
  this.#tickRunning=true;
  try{
   if(!this.policy().enabled)return;
   const targets=(await this.d.targets(this.policy().scopeTargetId)).sort((a,b)=>a.id.localeCompare(b.id));
   const target=targets.find(t=>this.#after===null||t.id.localeCompare(this.#after)>0)??targets[0];
   if(!target)return;this.#after=target.id;await this.run(target.id);
  }catch{/* The next bounded tick continues with a different registered target. */}
  finally{this.#tickRunning=false;}
 }
}
