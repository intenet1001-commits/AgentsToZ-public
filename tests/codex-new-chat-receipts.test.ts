import {describe,expect,test} from 'bun:test';
import {chmodSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexNewChatReceiptStore,canCancelUndispatchedCodexRequest} from '../src/codexNewChatReceipts';

const threadId='2c923dc0-2693-4c4f-8dd5-5c79da7ec10f';
const now=1_800_000_000_000;
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'codex-chat-receipt-'));
  return {root,store:new CodexNewChatReceiptStore(root,()=>now),cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
const request={controllerId:'device-1',projectIdentity:'project-a-inode',actionId:'action-1',expiresAt:new Date(now+60_000).toISOString()};
describe('Codex new-chat durable receipts',()=>{
  test('reserves before dispatch and survives restart without treating a retry as new',async()=>{
    const f=fixture();try{
      expect(await f.store.reserve(request)).toMatchObject({created:true,state:'started'});
      expect(await new CodexNewChatReceiptStore(f.root,()=>now).reserve(request)).toMatchObject({created:false,state:'started'});
      expect(await f.store.review(request)).toEqual({actionId:'action-1',state:'started'});
      await expect(f.store.acknowledge(request)).rejects.toMatchObject({code:'CODEX_NEW_CHAT_REVIEW_REQUIRED'});
    }finally{f.cleanup();}
  });
  test('blocks a new ID, another device, and reuse with another project until exact ack',async()=>{
    const f=fixture();try{
      await f.store.reserve(request);
      await expect(f.store.reserve({...request,actionId:'action-2'})).rejects.toMatchObject({code:'CODEX_NEW_CHAT_REVIEW_REQUIRED'});
      await expect(f.store.reserve({...request,controllerId:'device-2',actionId:'other'})).rejects.toMatchObject({code:'CODEX_NEW_CHAT_BUSY'});
      await expect(f.store.review({...request,controllerId:'device-2'})).rejects.toMatchObject({code:'CODEX_NEW_CHAT_BUSY'});
      await expect(f.store.reserve({...request,projectIdentity:'project-b'})).rejects.toMatchObject({code:'ACTION_ID_REUSED'});
      await f.store.complete({...request,threadId});
      expect(await f.store.review(request)).toEqual({actionId:'action-1',state:'completed'});
      await expect(f.store.acknowledge({...request,actionId:'action-2'})).rejects.toMatchObject({code:'CODEX_NEW_CHAT_RECEIPT_EXPIRED'});
      expect(await f.store.acknowledge(request)).toBe(threadId);
      expect(await f.store.acknowledge(request)).toBe(threadId);
      expect(await f.store.reserve(request)).toMatchObject({created:false,state:'acknowledged',threadId});
      expect(await f.store.reserve({...request,actionId:'action-2'})).toMatchObject({created:true,state:'started'});
      // A delayed duplicate acknowledgement cannot clear the newer barrier.
      await f.store.acknowledge(request);
      expect(await f.store.review(request)).toEqual({actionId:'action-2',state:'started'});
    }finally{f.cleanup();}
  });
  test('expired unfinished or completed records block a different request and never rerun the same ID',async()=>{
    const f=fixture();try{
      await f.store.reserve(request);
      const later=new CodexNewChatReceiptStore(f.root,()=>now+61_000);
      await expect(later.reserve(request)).rejects.toMatchObject({code:'CODEX_NEW_CHAT_RECEIPT_EXPIRED'});
      await expect(later.reserve({...request,actionId:'new',expiresAt:new Date(now+120_000).toISOString()})).rejects.toMatchObject({code:'CODEX_NEW_CHAT_REVIEW_REQUIRED'});
    }finally{f.cleanup();}
  });
  test('rejects malformed or world-readable storage instead of dropping the fence',async()=>{
    const f=fixture();try{
      await f.store.reserve(request);const file=join(f.root,'remote-control','codex-new-chat-receipts-v1.json');
      const saved=readFileSync(file,'utf8');writeFileSync(file,'{"schemaVersion":1,"entries":{"bad":{}}}');
      await expect(f.store.review(request)).rejects.toMatchObject({code:'CODEX_NEW_CHAT_RECEIPT_UNAVAILABLE'});
      writeFileSync(file,saved);chmodSync(file,0o644);
      if(process.platform!=='win32')await expect(f.store.review(request)).rejects.toMatchObject({code:'CODEX_NEW_CHAT_RECEIPT_UNAVAILABLE'});
    }finally{f.cleanup();}
  });
  test('manual CAS only cancels a proven unsent request and retains its tombstone',async()=>{
    const f=fixture();try{
      await f.store.reserve(request);const view=await f.store.reviewLocal(request.projectIdentity);expect(view?.state).toBe('started');
      await expect(f.store.resolveLocal(request.projectIdentity,view!.revision,false)).rejects.toMatchObject({code:'CODEX_NEW_CHAT_REVIEW_REQUIRED'});
      await expect(f.store.resolveLocal(request.projectIdentity,'a'.repeat(64),true)).rejects.toMatchObject({code:'CODEX_NEW_CHAT_REVIEW_STALE'});
      await f.store.resolveLocal(request.projectIdentity,view!.revision,true);
      expect(await f.store.reserve(request)).toMatchObject({created:false,state:'cancelled'});
      expect(await f.store.reserve({...request,actionId:'action-2'})).toMatchObject({created:true,state:'started'});
    }finally{f.cleanup();}
  });
  test('only proven pre-submit errors without either durable fence are cancellable',()=>{
    expect(canCancelUndispatchedCodexRequest('CODEX_DESKTOP_AUTOMATION_PERMISSION_DENIED',false,false)).toBe(true);
    expect(canCancelUndispatchedCodexRequest('CODEX_DESKTOP_AUTOMATION_PERMISSION_DENIED',true,false)).toBe(false);
    expect(canCancelUndispatchedCodexRequest('CODEX_DESKTOP_AUTOMATION_PERMISSION_DENIED',false,true)).toBe(false);
    expect(canCancelUndispatchedCodexRequest('CODEX_DESKTOP_SUBMISSION_UNCERTAIN',false,false)).toBe(false);
    expect(canCancelUndispatchedCodexRequest('CODEX_THREAD_PERSISTENCE_TIMEOUT',false,false)).toBe(false);
  });
  test('a second registration sharing the same directory cannot bypass its barrier',async()=>{
    const f=fixture();try{
      await f.store.reserve({...request,folderIdentity:'same-folder'});
      await expect(f.store.reserve({...request,projectIdentity:'new-registration',folderIdentity:'same-folder',actionId:'action-2'})).rejects.toMatchObject({code:'CODEX_NEW_CHAT_REVIEW_REQUIRED'});
    }finally{f.cleanup();}
  });
  test('a moved folder with the same registration cannot bypass the previous barrier',async()=>{
    const f=fixture();try{
      await f.store.reserve({...request,folderIdentity:'old-folder',registrationIdentity:'same-registration'});
      await expect(f.store.reserve({...request,projectIdentity:'new-project-binding',folderIdentity:'new-folder',registrationIdentity:'same-registration',actionId:'action-2'})).rejects.toMatchObject({code:'CODEX_NEW_CHAT_REVIEW_REQUIRED'});
      expect(await f.store.hasBarrier('new-folder',['same-registration'])).toBe(true);
    }finally{f.cleanup();}
  });
  test('a retained exact thread can be promoted by local CAS without resubmission',async()=>{
    const f=fixture();try{
      await f.store.reserve(request);const started=await f.store.reviewLocal(request.projectIdentity);
      const revision=await f.store.promoteLocalStarted(request.projectIdentity,started!.revision,threadId);
      expect((await f.store.reviewLocal(request.projectIdentity))?.state).toBe('completed');
      await expect(f.store.resolveLocal(request.projectIdentity,started!.revision,false)).rejects.toMatchObject({code:'CODEX_NEW_CHAT_REVIEW_STALE'});
      await f.store.resolveLocal(request.projectIdentity,revision,false);
      expect(await f.store.reserve(request)).toMatchObject({created:false,state:'acknowledged',threadId});
    }finally{f.cleanup();}
  });
  test('explicit cancellation tombstones an unseen request before any late arrival',async()=>{
    const f=fixture();try{
      await f.store.cancelAbsent(request);await f.store.cancelAbsent(request);
      expect(await f.store.reviewExact(request)).toEqual({actionId:request.actionId,state:'cancelled'});
      expect(await f.store.reserve(request)).toMatchObject({created:false,state:'cancelled'});
      await expect(f.store.cancelAbsent({...request,projectIdentity:'another-project'})).rejects.toMatchObject({code:'ACTION_ID_REUSED'});
      const next={...request,actionId:'active'};await f.store.reserve(next);
      await expect(f.store.cancelAbsent(next)).rejects.toMatchObject({code:'CODEX_NEW_CHAT_REVIEW_REQUIRED'});
      await f.store.complete({...next,threadId});
      await expect(f.store.cancelAbsent(next)).rejects.toMatchObject({code:'CODEX_NEW_CHAT_REVIEW_REQUIRED'});
    }finally{f.cleanup();}
  });
  test('start and cancel of the same action across two projects cannot both succeed',async()=>{
    for(const startFirst of [true,false]){
      const f=fixture();try{
        const other={...request,projectIdentity:'other-project',folderIdentity:'other-folder'};
        if(startFirst){await f.store.reserve(request);await expect(f.store.cancelAbsent(other)).rejects.toMatchObject({code:'ACTION_ID_REUSED'});}
        else{await f.store.cancelAbsent(other);await expect(f.store.reserve(request)).rejects.toMatchObject({code:'ACTION_ID_REUSED'});}
      }finally{f.cleanup();}
    }
    const f=fixture();try{
      const other={...request,projectIdentity:'other-project',folderIdentity:'other-folder'};
      const results=await Promise.allSettled([f.store.reserve(request),f.store.cancelAbsent(other)]);
      expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
      const rejected=results.find(r=>r.status==='rejected');expect(rejected?.status==='rejected'&&rejected.reason.code).toBe('ACTION_ID_REUSED');
    }finally{f.cleanup();}
  });
});
