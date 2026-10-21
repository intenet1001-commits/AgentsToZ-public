import {existsSync} from 'node:fs';
import {MemorySaveInputStore} from './memorySaveInputStore';
import type {MemorySaveStore,MemoryInputExpiryCursor} from './memorySaveStore';
import type {MemoryBackupGuard} from './memoryBackupContract';
import type {WorkspaceLease} from './workspaceLease';
/** Existing host tick only. Never creates keys, calls AI, repairs leases or
 * substitutes the current revision for the outbox's immutable backup guard. */
export class MemorySaveMaintenance {
 #running=false;#after:MemoryInputExpiryCursor|null=null;
 #expiryCycleFailed=false;
 #status={expiry:'idle',backup:'idle'};
 constructor(private d:{enabled:()=>boolean;store:MemorySaveStore;appDataRoot:string;
  acquireApp:()=>Promise<WorkspaceLease>;release:(lease:WorkspaceLease)=>void;readKey:()=>Promise<Buffer>;
  backup:(memoryId:string,guard:MemoryBackupGuard)=>Promise<'complete'|'blocked'|'retry'>;
 }){}
 status(){return {...this.#status};}
 async tick(){
  if(this.#running||!this.d.enabled()||!existsSync(this.d.store.path))return;
  this.#running=true;
  try{
   try{
    if(this.#after===null)this.#expiryCycleFailed=false;
    const page=this.d.store.expiryPage(this.#after);this.#after=page.nextCursor;
    if(page.items.length){
     const lease=await this.d.acquireApp();let key:Buffer|undefined;
     try{
      key=await this.d.readKey();const inputs=new MemorySaveInputStore(this.d.appDataRoot,lease);
      let failed=false;
      for(const row of page.items){
       if(!this.d.enabled()||!lease.refresh()){failed=true;break;}
       try{const b=this.d.store.inputBinding(row.saveId);if(b&&inputs.expire(b,key))this.d.store.markInputExpired(row.saveId);else failed=true;}
       catch{failed=true;}
      }
      this.#expiryCycleFailed ||= failed;
     }finally{key?.fill(0);this.d.release(lease);}
    }
    // A later healthy page must not clear an earlier failure in this sweep.
    // Clear the warning only after a complete clean cycle, including an empty one.
    if(this.#expiryCycleFailed)this.#status.expiry='needs-attention';
    else if(this.#after===null)this.#status.expiry='checked';
   }catch{this.#expiryCycleFailed=true;this.#status.expiry='needs-attention';}
   if(!this.d.enabled())return;
   const job=this.d.store.nextBackup();if(!job)return;
   const binding=this.d.store.hostBinding(job.saveId),guard=binding?.backup;
   if(!binding||binding.sessionPlanId!==job.localRevisionId||!guard||guard.memoryId!==job.memoryId||guard.contentHash!==binding.afterHash){
    this.d.store.finishBackup(job.saveId,job.attempts,'blocked');this.#status.backup='blocked';return;
   }
   let result:'complete'|'blocked'|'retry';
   try{result=await this.d.backup(job.memoryId,guard);}catch{result='retry';}
   if(result!=='retry')this.d.store.finishBackup(job.saveId,job.attempts,result);
   this.#status.backup=result;
  }catch{this.#status.backup='needs-attention';}
  finally{this.#running=false;}
 }
}
