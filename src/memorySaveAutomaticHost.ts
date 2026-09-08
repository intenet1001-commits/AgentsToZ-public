import {automaticMemoryOwns} from './memorySaveAutomaticPolicy';
import {existsSync,realpathSync} from 'node:fs';
import {detectProjectMemory} from '../project-memory-server';
import {MemorySaveStore} from './memorySaveStore';
import {MemorySaveDispatcher} from './memorySaveDispatcher';
import {MemorySaveKeyLifecycle} from './memorySaveKeyLifecycle';
import {MemoryEmergencyReserve} from './memoryEmergencyReserve';
import {memorySaveTextProvider,prepareMemoryProvider,type MemoryProviderHost} from './memorySaveProvider';
import {executeAutomaticMemorySave} from './memorySaveExecutor';
import {selectAutomaticMemorySources} from './memorySaveSelection';
import {MemorySaveError,saveDigest,saveInteger} from './memorySaveContract';
import type {MemoryObservationCandidate} from './memoryObservationCoordinator';
import type {MemorySessionStore} from './memorySessionStore';
import type {WorkspaceLease} from './workspaceLease';

export interface AutomaticMemoryTarget {id:string;cwd:string;root:string;memoryId:string;validate:()=>Promise<boolean>}
export type AutomaticMemoryRunState='saved'|'idle'|'waiting-idle'|'source-unavailable'|'oversized'|'pending'|'budget-paused'|'recovery-required'|'provider-changed'|'busy'|'unavailable';
export interface AutomaticMemoryRunResult {state:AutomaticMemoryRunState;localSaved:boolean;backupPending?:boolean;hasMore?:boolean}
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
  preflight:(root:string)=>Promise<void>;disableLegacy:()=>void;
  key?:(id:string)=>Pick<MemorySaveKeyLifecycle,'load'>;
  maintenanceStatus?:()=>{expiry:string;backup:string};
 }){}
 policy(){return existsSync(this.d.store.path)?this.d.store.automaticPolicy():{revision:0,enabled:false,enabledAt:null,providerBindingDigest:null,excludedMemoryIds:[],scopeMemoryId:null,scopeTargetId:null};}
 owns(memoryId:string){return this.d.enabled()&&automaticMemoryOwns(this.policy(),memoryId);}
 handles(memoryId:string){const p=this.policy();return this.d.enabled()&&automaticMemoryOwns(p,memoryId)&&!p.excludedMemoryIds.includes(memoryId);}
 blocksLegacyGlobally(){const p=this.policy();return p.enabled&&p.scopeMemoryId===null;}
 #keep<T>(map:Map<string,T>,key:string,value:T){map.delete(key);map.set(key,value);while(map.size>128)map.delete(map.keys().next().value!);}
 durableResult(target:AutomaticMemoryTarget):AutomaticMemoryRunResult|null {
  if(!existsSync(this.d.store.path))return null;
  const job=this.d.store.latestJob(target.memoryId);if(!job)return null;
  const saved=job.phase==='local-saved';
  return {state:saved?'saved':'recovery-required',localSaved:saved,backupPending:saved&&this.d.store.backupSummary(target.memoryId).pending>0};
 }
 async status(target:AutomaticMemoryTarget){
  const policy=this.policy(),binding=existsSync(this.d.store.path)?this.d.store.providerBinding():null;
  if(!await target.validate())throw new MemorySaveError('SOURCE_CONFLICT');
  return {version:1,targetId:target.id,maintenance:this.d.maintenanceStatus?.()??null,supported:this.d.enabled(),revision:policy.revision,enabled:policy.enabled,
   excluded:policy.excludedMemoryIds.includes(target.memoryId),scope:policy.scopeMemoryId===null?'all':'project',inScope:policy.scopeMemoryId===null||policy.scopeMemoryId===target.memoryId,
   provider:binding?{model:binding.model,effort:binding.effort,configurationId:saveDigest(binding),preparedAt:binding.preparedAt}:null,
   last:this.#results.get(target.id)??this.durableResult(target),backup:existsSync(this.d.store.path)?this.d.store.backupSummary(target.memoryId):{pending:0,blocked:0,hasMore:false}};
 }
 /** Called behind the existing local capability; accepts no account/path/key. */
 async manage(body:unknown){
  const b=body as Record<string,unknown>;
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['automaticOperation','observationTargetId','model','effort','expectedRevision','configurationId','consentVersion','excluded','scope'].includes(k))
   ||typeof b.observationTargetId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(b.observationTargetId)
   ||!['status','prepare-provider','enable','disable','exclude'].includes(String(b.automaticOperation)))throw new MemorySaveError('INVALID_INPUT');
  const allowed:Record<string,string[]>={status:[], 'prepare-provider':['model','effort'],enable:['expectedRevision','configurationId','consentVersion','scope'],disable:['expectedRevision'],exclude:['expectedRevision','excluded']};
  if(Object.keys(b).some(k=>!['automaticOperation','observationTargetId',...allowed[String(b.automaticOperation)]!].includes(k)))throw new MemorySaveError('INVALID_INPUT');
  if(b.automaticOperation==='prepare-provider'&&(typeof b.model!=='string'||!/^claude-[a-z0-9][a-z0-9.-]{1,95}$/.test(b.model)||!['low','medium'].includes(String(b.effort))))throw new MemorySaveError('INVALID_INPUT');
  if(b.automaticOperation==='enable'&&(!saveInteger(b.expectedRevision)||b.consentVersion!==1||typeof b.configurationId!=='string'||!['project','all'].includes(String(b.scope))))throw new MemorySaveError('INVALID_INPUT');
  if(!this.d.enabled())throw new MemorySaveError('POLICY_DISABLED');
  const target=await this.d.resolve(b.observationTargetId);if(!target||!await target.validate())throw new MemorySaveError('SOURCE_CONFLICT');
  if(b.automaticOperation==='status')return this.status(target);
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
   const workspace=b.automaticOperation==='enable'?await this.d.acquireWorkspace(target.root):null;
   let lease:WorkspaceLease|undefined;
   try{
    lease=await this.d.acquireApp();
    if(!lease.refresh()||workspace&&!workspace.refresh()||!await target.validate())throw new MemorySaveError('SOURCE_CONFLICT');
    if(b.automaticOperation==='enable'&&this.policy().enabled)throw new MemorySaveError('POLICY_CHANGED');
    const id=this.d.identity(true);if(!id)throw new MemorySaveError('STORAGE_UNAVAILABLE');
    const key=await (this.d.key?.(id)??new MemorySaveKeyLifecycle(this.d.appDataRoot,id)).load();key.fill(0);
    if(b.automaticOperation==='prepare-provider'){
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
 async runLeased(target:AutomaticMemoryTarget,workspaceLease:WorkspaceLease,signal:AbortSignal,manual=false):Promise<AutomaticMemoryRunResult>{
  const result=await this.#executeLeased(target,workspaceLease,signal,manual);
  this.#keep(this.#results,target.id,result);return result;
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
   const selected=selectAutomaticMemorySources({store:this.d.store,memoryId:target.memoryId,policyEpoch:1,revision:p.revision,
    after:this.#scans.get(target.id)??0,instanceId:id,cwd:target.cwd,candidates});
   this.#keep(this.#scans,target.id,selected.nextCursor??0);
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
  this.#keep(this.#results,target.id,result);return result;
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
