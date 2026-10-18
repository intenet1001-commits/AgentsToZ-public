import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {WorkroomSubmissions} from '../src/workroomSubmissions';
import {submitWorkroomDraft} from '../src/workroomSubmissionClient';
import type {AiTerminalRequest,AiTerminalResponse} from '../src/aiTerminalProtocol';
import {WORKROOM_DRAFT_VAULT_LIMIT,WorkroomDraftVault,type WorkroomDraftStorage} from '../src/workroomDraftVault';
import {checkKeptDraft,keptDraftNote,restoreDraftQueueScope,takeBackKeptDraft} from '../src/workroomDraftQueue';

/**
 * Audit 2026-10-16 (S3-8): a kept request was listed only under the running session it was saved for. Once that session
 * ended (closed, exited, a Mac app restart), the request could not be sent, taken back or deleted — and it still counted
 * toward the 32-draft limit, so 「보관함에 넣기」 and every direct send's seal eventually failed with nothing to clear.
 * Requests of other sessions in the same scope are now listed with only what the receipt rules allow: a status check by
 * the original submission id under its own session, a take-back only when nothing ran (or after the duplicate warning,
 * as for the current session), and delete. An old id is never sent to another session.
 */
class MemoryStorage implements WorkroomDraftStorage {
 records=new Map<string,unknown>();writes=0;
 async read(key:string){return this.records.get(key)??null;}
 async write(key:string,value:unknown){this.writes++;this.records.set(key,value);}
 async delete(key:string){this.records.delete(key);}
 async entries(){return [...this.records].map(([recordKey,value])=>({recordKey,value}));}
 async keys(){return [...this.records.keys()];}
 async clear(){this.records.clear();}
 async update(key:string,mutate:(value:unknown)=>unknown){const before=this.records.get(key)??null;const next=mutate(before);if(next!==undefined){this.writes++;this.records.set(key,next);}return before;}
}
const scope='host-fixture-1',ended='session-ended-0000',running='session-running-1111';
const dirs:string[]=[],closers:Array<{close():void}>=[];
afterEach(()=>{for(const c of closers.splice(0))c.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});

/** A real receipt journal. Receipts are keyed by owner + the session the request names, as on the host. */
function journal(){
 const dir=mkdtempSync(join(tmpdir(),'kept-drafts-'));chmodSync(dir,0o700);dirs.push(dir);
 const store=new WorkroomConversationJournal(dir);const manager=new WorkroomSubmissions(()=>store);closers.push(manager,store);
 const phases:Array<{phase:string;sessionId:string|undefined}>=[],writes:string[]=[];let failStatus=false;
 const request=async(r:Omit<AiTerminalRequest,'requestId'>):Promise<AiTerminalResponse>=>{
  phases.push({phase:r.submission!.phase,sessionId:r.sessionId});
  if(failStatus&&r.submission!.phase==='status')throw Error('network lost');
  const context={owner:'fixture-owner',sessionId:r.sessionId!,targetId:'fixture-project',binding:'a'.repeat(64),revision:0};
  return {submission:await manager.perform(r.submission!,context,r.references??[],async(text,start)=>{start();writes.push(text);})};
 };
 return {request,phases,writes,failStatus:(v:boolean)=>{failStatus=v;}};
}

test('requests kept for a session that ended stay listed in the same scope; restoring reads only',async()=>{
 const storage=new MemoryStorage(),vault=new WorkroomDraftVault({storage});
 await vault.save({scope,sessionId:ended,submissionId:'kept-queued-0001',text:'보관만 한 요청\r',references:[]});
 await vault.save({scope,sessionId:ended,submissionId:'kept-sent-00002',text:'보낸 적 있는 요청\r',references:[],attempted:true});
 await vault.save({scope,sessionId:running,submissionId:'kept-current-03',text:'지금 세션 요청\r',references:[]});
 await vault.save({scope:'another-mac-scope',sessionId:ended,submissionId:'kept-elsewhere-4',text:'다른 Mac\r',references:[]});
 const writes=storage.writes;
 const queue=await restoreDraftQueueScope(new WorkroomDraftVault({storage}),scope,running);
 expect(queue.current.map(d=>[d.submissionId,d.state])).toEqual([['kept-current-03','stopped']]);
 expect(queue.earlier.map(d=>[d.submissionId,d.sessionId,d.attempted])).toEqual([['kept-queued-0001',ended,false],['kept-sent-00002',ended,true]]);
 expect(queue.elsewhere).toBe(1);
 expect(storage.writes).toBe(writes);
 // No running composer (the selected session ended): every request of the scope is an earlier one.
 const detached=await restoreDraftQueueScope(new WorkroomDraftVault({storage}),scope,null);
 expect(detached.current).toEqual([]);
 expect(detached.earlier.map(d=>d.submissionId).sort()).toEqual(['kept-current-03','kept-queued-0001','kept-sent-00002']);
 // The per-session list keeps its exact shape for the existing callers.
 expect(await vault.list(scope,ended)).toEqual({drafts:[
  {submissionId:'kept-queued-0001',text:'보관만 한 요청\r',references:[],savedAt:expect.any(Number),attempted:false},
  {submissionId:'kept-sent-00002',text:'보낸 적 있는 요청\r',references:[],savedAt:expect.any(Number),attempted:true}],dropped:0});
});

test('a full vault of an ended session can be cleared from the next session',async()=>{
 const storage=new MemoryStorage(),vault=new WorkroomDraftVault({storage});
 for(let i=0;i<WORKROOM_DRAFT_VAULT_LIMIT;i++)await vault.save({scope,sessionId:ended,submissionId:'full-kept-'+i,text:'n'+i+'\r',references:[]});
 await expect(vault.save({scope,sessionId:running,submissionId:'full-next-0001',text:'next\r',references:[]})).rejects.toMatchObject({code:'DRAFT_LIMIT'});
 const {earlier}=await restoreDraftQueueScope(vault,scope,running);
 expect(earlier).toHaveLength(WORKROOM_DRAFT_VAULT_LIMIT);
 await vault.delete(earlier[0]!.submissionId);
 await vault.save({scope,sessionId:running,submissionId:'full-next-0001',text:'next\r',references:[]});
 expect((await vault.list(scope,running)).drafts.map(d=>d.submissionId)).toEqual(['full-next-0001']);
});

test('checking a kept request reads its receipt under its own session and never writes',async()=>{
 const f=journal();
 // Written before the session ended.
 expect((await submitWorkroomDraft({id:'kept-written-001',sessionId:ended,text:'이미 전달\r',request:f.request,prepared:()=>{}})).state).toBe('written');
 const written=f.writes.length;f.phases.length=0;
 const found=await checkKeptDraft({draft:{submissionId:'kept-written-001',sessionId:ended},request:f.request});
 expect(found.kind).toBe('existing');expect(found.receipt!.state).toBe('written');
 expect(f.phases).toEqual([{phase:'status',sessionId:ended}]);
 // The same id under another session is another receipt: nothing found there, and still nothing written.
 f.phases.length=0;
 expect((await checkKeptDraft({draft:{submissionId:'kept-written-001',sessionId:running},request:f.request})).kind).toBe('not-found');
 expect(f.phases).toEqual([{phase:'status',sessionId:running}]);
 // A failed status check is not «not found».
 f.failStatus(true);
 await expect(checkKeptDraft({draft:{submissionId:'kept-written-001',sessionId:ended},request:f.request})).rejects.toThrow('network lost');
 expect(f.writes.length).toBe(written);
});

test('what a checked kept request offers follows the receipt rules',()=>{
 const receipt=(state:string)=>({id:'kept-receipt-001',storeId:'store-1',epoch:'epoch-1',revision:0,state}) as never;
 expect(keptDraftNote({kind:'existing',receipt:receipt('written')},true)).toEqual({text:expect.stringContaining('전달됐습니다'),takeBack:null,remove:true});
 for(const state of ['rejected','held'])expect(keptDraftNote({kind:'existing',receipt:receipt(state)},true)!.takeBack).toBe('never-ran');
 for(const state of ['prepared','write_started','unknown']){
  const note=keptDraftNote({kind:'existing',receipt:receipt(state)},true)!;
  expect(note.takeBack).toBeNull();expect(note.text).toContain('다시 보내지 않았습니다');
 }
 // Not found: proof that nothing ran only when this request was never handed to a transport.
 expect(keptDraftNote({kind:'not-found'},false)!.takeBack).toBe('never-sent');
 const unproven=keptDraftNote({kind:'not-found'},true)!;
 expect(unproven.takeBack).toBe('duplicate-risk');expect(unproven.text).toContain('다시 보내지 않았습니다');
});

test('taking back a never-sent kept request claims it first; one another window already sent stays put',async()=>{
 const storage=new MemoryStorage(),vault=new WorkroomDraftVault({storage});
 await vault.save({scope,sessionId:ended,submissionId:'take-back-fresh1',text:'꺼낼 요청\r',references:[]});
 await vault.save({scope,sessionId:ended,submissionId:'take-back-raced2',text:'다른 창이 보낸 요청\r',references:[]});
 const draft=(id:string,text:string)=>({submissionId:id,sessionId:ended,text});
 let put='',asked=0;const confirm=()=>{asked++;return true;};
 // A composer that holds text: nothing is claimed or taken.
 expect(await takeBackKeptDraft({vault,scope,draft:draft('take-back-fresh1','꺼낼 요청\r'),risk:'never-sent',composerEmpty:false,confirm,put:()=>{put='x';return true;}})).toBe('composer-busy');
 expect(put).toBe('');expect(await vault.claimForSend(scope,ended,'take-back-raced2')).toBe('fresh');
 // ↑ another window pressed 「보내기」 on the second one meanwhile (its claim marks it as handed to a transport).
 expect(await takeBackKeptDraft({vault,scope,draft:draft('take-back-fresh1','꺼낼 요청\r'),risk:'never-sent',composerEmpty:true,confirm,put:()=>{put='꺼낼 요청';return true;}})).toBe('taken');
 expect(put).toBe('꺼낼 요청');expect(asked).toBe(0);expect(storage.records.has('draft:take-back-fresh1')).toBe(false);
 put='';
 expect(await takeBackKeptDraft({vault,scope,draft:draft('take-back-raced2','다른 창이 보낸 요청\r'),risk:'never-sent',composerEmpty:true,confirm,put:()=>{put='dup';return true;}})).toBe('already-sent');
 expect(put).toBe('');expect(storage.records.has('draft:take-back-raced2')).toBe(true);
 // An unproven request is taken back only after the duplicate warning; declined, nothing changes.
 expect(await takeBackKeptDraft({vault,scope,draft:draft('take-back-raced2','다른 창이 보낸 요청\r'),risk:'duplicate-risk',composerEmpty:true,confirm:()=>false,put:()=>{put='dup';return true;}})).toBe('declined');
 expect(put).toBe('');expect(storage.records.has('draft:take-back-raced2')).toBe(true);
 expect(await takeBackKeptDraft({vault,scope,draft:draft('take-back-raced2','다른 창이 보낸 요청\r'),risk:'duplicate-risk',composerEmpty:true,confirm,put:()=>{put='dup';return true;}})).toBe('taken');
 expect(put).toBe('dup');expect(storage.records.has('draft:take-back-raced2')).toBe(false);
});

test('requests kept for another connection can be cleared here without opening them (w5 review)',async()=>{
 // A community device that left, a Mac removed from this phone: no panel opens those scopes any more, yet they count
 // toward the device-wide limit. They are listed by id only (never decrypted here) and deleted only outside this scope.
 const storage=new MemoryStorage(),vault=new WorkroomDraftVault({storage});
 await vault.save({scope,sessionId:running,submissionId:'kept-current-03',text:'지금 세션 요청\r',references:[]});
 await vault.save({scope,sessionId:ended,submissionId:'kept-queued-0001',text:'앞 세션 요청\r',references:[]});
 await vault.save({scope:'community:left-device',sessionId:ended,submissionId:'kept-elsewhere-4',text:'떠난 기기\r',references:[]});
 await vault.save({scope:'removed-mac-host',sessionId:ended,submissionId:'kept-elsewhere-5',text:'지운 Mac\r',references:[],attempted:true});
 const queue=await restoreDraftQueueScope(vault,scope,running);
 expect(queue.elsewhere).toBe(2);
 expect([...queue.elsewhereIds].sort()).toEqual(['kept-elsewhere-4','kept-elsewhere-5']);
 // Ids of this scope are never deleted through it, whatever the caller passes.
 expect(await vault.deleteOutsideScope(scope,[...queue.elsewhereIds,'kept-current-03','kept-queued-0001','not-a-draft-0001'])).toBe(2);
 const after=await vault.listScope(scope);
 expect(after.elsewhere).toBe(0);
 expect(after.drafts.map(d=>d.submissionId).sort()).toEqual(['kept-current-03','kept-queued-0001']);
});
