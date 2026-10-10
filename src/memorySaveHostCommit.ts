import {createHash} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {applyProjectMemorySession,readMemoryDocument} from '../project-memory-server';
import type {WorkspaceLease} from './workspaceLease';
import type {MemorySessionStore,MemorySessionPlan} from './memorySessionStore';
import type {MemorySaveStore} from './memorySaveStore';
import {MemorySaveError,saveDigest,type MemorySaveHostBinding} from './memorySaveContract';
interface Context {
 root:string;lease:WorkspaceLease;sessions:MemorySessionStore;saves:MemorySaveStore;
 saveId:string;attemptId:string;sessionPlanId:string;
 validateRegistration:()=>Promise<{memoryId:string;canonicalRoot:string}|null>;
}
const active=new WeakSet<WorkspaceLease>();
function leaseValid(c:Context){if(!c.lease.refresh()||!lstatSync(c.root).isDirectory()||realpathSync(c.root)!==c.root||c.lease.identity.canonicalWorkspacePath!==c.root)throw new MemorySaveError('RECOVERY_REQUIRED');}
async function registered(c:Context,memoryId:string){leaseValid(c);const identity=await c.validateRegistration();leaseValid(c);if(identity?.memoryId!==memoryId||identity.canonicalRoot!==c.root)throw new MemorySaveError('SOURCE_CONFLICT');}
function planFor(c:Context,memoryId:string):MemorySessionPlan {
 const pending=c.sessions.get(c.root);const plan=pending?.plan;
 if(!plan||plan.id!==c.sessionPlanId||plan.root!==c.root||plan.memoryId!==memoryId||plan.saveV2?.saveId!==c.saveId||plan.saveV2.attemptId!==c.attemptId
   ||plan.automaticSaveId!==undefined||plan.workroomJob!==undefined)throw new MemorySaveError('REVISION_CONFLICT');
 const bytes=[...(plan.document?.entries??[]),...(plan.state?.entries??[])].reduce((n,entry)=>n+Buffer.byteLength(entry.after??''),0);
 if(bytes>256*1024)throw new MemorySaveError('INVALID_INPUT');
 return plan;
}
async function locked<T>(c:Context,run:()=>Promise<T>):Promise<T>{
 if(active.has(c.lease))throw new MemorySaveError('EXECUTION_BUSY');active.add(c.lease);
 try{return await run();}catch(error){if(error instanceof MemorySaveError)throw error;throw new MemorySaveError('RECOVERY_REQUIRED');}finally{active.delete(c.lease);}
}
/** Bind only a host-prepared, durable proposal. No model output is accepted here.
 * The future dispatcher must prepare its plan with the original captured activity
 * snapshot, after proposal validation and disk/lease admission. */
export function bindPreparedMemorySaveSession(c:Context):Promise<void>{return locked(c,async()=>{
 const job=c.saves.get(c.saveId);if(job.attemptId!==c.attemptId)throw new MemorySaveError('REVISION_CONFLICT');
 await registered(c,job.memoryId);const plan=planFor(c,job.memoryId);
 const prior=c.saves.hostBinding(c.saveId);
 if(!prior&&c.sessions.status(c.root)?.phase!=='document')throw new MemorySaveError('RECOVERY_REQUIRED');
 const binding:MemorySaveHostBinding={sessionPlanId:plan.id,planDigest:saveDigest(plan),rootDigest:saveDigest(c.root),
  beforeHash:prior?.beforeHash??createHash('sha256').update(readMemoryDocument(c.root,join(c.root,plan.sourcePath))).digest('hex'),
  afterHash:plan.afterHash,backupRequested:plan.backupRequested,...(plan.backup?{backup:plan.backup}:{})};
 await registered(c,job.memoryId);c.saves.bindHostSession(c.saveId,c.attemptId,binding);
});}

/** Existing document/journal/config manifests do the file work. Commit the V2
 * receipt/outbox BEFORE retiring the host plan; recovery never invokes a model.
 * A retained receipt is historical evidence, not proof of today's file contents. */
export function applyBoundMemorySaveSession(c:Context,afterStage?:(stage:string)=>void){return locked(c,async()=>{
 const job=c.saves.get(c.saveId),binding=c.saves.hostBinding(c.saveId);
 if(job.attemptId!==c.attemptId||!binding||binding.sessionPlanId!==c.sessionPlanId||binding.rootDigest!==saveDigest(c.root))throw new MemorySaveError('REVISION_CONFLICT');
 await registered(c,job.memoryId);
 const pending=c.sessions.status(c.root);
 if(job.phase==='local-saved'){
   if(pending){const plan=planFor(c,job.memoryId);if(pending.phase!=='outcome'||saveDigest(plan)!==binding.planDigest)throw new MemorySaveError('REVISION_CONFLICT');c.sessions.finish(c.root,plan.id);}
   return {localSaved:true as const,saveId:c.saveId,localRevisionId:binding.sessionPlanId,backupRequested:binding.backupRequested,verifiedNow:false};
 }
 if(!['summarizing','recovery-required'].includes(job.phase))throw new MemorySaveError('RECOVERY_REQUIRED');
 const plan=planFor(c,job.memoryId);if(saveDigest(plan)!==binding.planDigest)throw new MemorySaveError('REVISION_CONFLICT');
 try{
   applyProjectMemorySession(c.sessions,c.root,c.sessionPlanId,stage=>{leaseValid(c);afterStage?.(stage);leaseValid(c);},
     {saveId:c.saveId,attemptId:c.attemptId,planDigest:binding.planDigest});
   await registered(c,job.memoryId);
   afterStage?.('before-receipt');leaseValid(c);
   // Registration can yield. Recheck the retained outcome after that await so
   // intervening document/config edits cannot receive a success receipt.
   applyProjectMemorySession(c.sessions,c.root,c.sessionPlanId,undefined,
     {saveId:c.saveId,attemptId:c.attemptId,planDigest:binding.planDigest});
   leaseValid(c);
   c.saves.commitLocal(c.saveId,c.attemptId,{manifestDigest:binding.planDigest,beforeHash:binding.beforeHash,afterHash:binding.afterHash,localRevisionId:binding.sessionPlanId},binding.backupRequested);
   afterStage?.('receipt');leaseValid(c);c.sessions.finish(c.root,c.sessionPlanId);
   return {localSaved:true as const,saveId:c.saveId,localRevisionId:binding.sessionPlanId,backupRequested:binding.backupRequested,verifiedNow:true};
 }catch(error){
   try{if(c.saves.get(c.saveId).phase!=='local-saved')c.saves.requireRecovery(c.saveId,c.attemptId);}catch{/* Preserve the durable ambiguity, never replay a model. */}
   if(error instanceof MemorySaveError)throw error;throw new MemorySaveError('RECOVERY_REQUIRED');
 }
});}
