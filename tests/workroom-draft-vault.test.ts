import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {WorkroomSubmissions} from '../src/workroomSubmissions';
import {submitWorkroomDraft} from '../src/workroomSubmissionClient';
import type {AiTerminalRequest,AiTerminalResponse} from '../src/aiTerminalProtocol';
import {
 WORKROOM_DRAFT_VAULT_FLAG_KEY,WORKROOM_DRAFT_VAULT_LIMIT,WORKROOM_DRAFT_VAULT_TTL_MS,WorkroomDraftVault,
 announceDraftVaultOptIn,createGatedDraftVault,draftVaultIfEnabled,readDraftVaultOptIn,subscribeDraftVaultOptIn,turnDraftVaultOff,writeDraftVaultOptIn,workroomDraftVaultSupported,
 type WorkroomDraftStorage,
} from '../src/workroomDraftVault';
import {DRAFT_RAW_SEND_NOTICE,draftSealNotice,draftVaultScopeFor,restoreDraftQueue,sendQueuedDraft,sendWithDraftSeal,WORKROOM_DRAFT_SEAL_WAIT_MS,WORKROOM_DRAFT_STOPPED_LABEL} from '../src/workroomDraftQueue';
import {readFileSync} from 'node:fs';

/** Records every write so a test can prove that nothing was stored. CryptoKeys are kept as live objects, as IndexedDB does. */
class RecordingStorage implements WorkroomDraftStorage {
 records=new Map<string,unknown>();writes=0;deletes=0;
 async read(key:string){return this.records.get(key)??null;}
 async write(key:string,value:unknown){this.writes++;this.records.set(key,value);}
 async delete(key:string){this.deletes++;this.records.delete(key);}
 async entries(){return [...this.records].map(([recordKey,value])=>({recordKey,value}));}
 async keys(){return [...this.records.keys()];}
 async clear(){this.deletes++;this.records.clear();}
 async update(key:string,mutate:(value:unknown)=>unknown){const before=this.records.get(key)??null;const next=mutate(before);if(next!==undefined){this.writes++;this.records.set(key,next);}return before;}
}
const scope='local',sessionId='session-aaaa-1111';
const stores:WorkroomConversationJournal[]=[],dirs:string[]=[],managers:WorkroomSubmissions[]=[];
afterEach(()=>{for(const m of managers.splice(0))m.close();for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function memoryFlags(){const data=new Map<string,string>();let writes=0;return {data,get writes(){return writes;},getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{writes++;data.set(k,v);},removeItem:(k:string)=>{writes++;data.delete(k);}};}

test('opt-in is off by default and an off flag stores nothing anywhere',async()=>{
 const flags=memoryFlags();expect(readDraftVaultOptIn(flags)).toBe(false);
 const storage=new RecordingStorage();let created=0;
 const vault=draftVaultIfEnabled({flags,supported:true,create:()=>{created++;return new WorkroomDraftVault({storage});}});
 expect(vault).toBeNull();expect(created).toBe(0);expect(storage.writes).toBe(0);expect(flags.writes).toBe(0);
 // Even an enabled vault writes nothing until a draft is actually saved: listing, pruning and counting are reads.
 const idle=new WorkroomDraftVault({storage});expect((await idle.list(scope,sessionId)).drafts).toEqual([]);await idle.prune();expect(await idle.count()).toBe(0);
 expect(storage.writes).toBe(0);expect(storage.deletes).toBe(0);
 writeDraftVaultOptIn(flags,true);expect(readDraftVaultOptIn(flags)).toBe(true);expect(flags.data.get(WORKROOM_DRAFT_VAULT_FLAG_KEY)).toBe('on');
 expect(draftVaultIfEnabled({flags,supported:true,create:()=>new WorkroomDraftVault({storage})})).not.toBeNull();
 // Unsupported (no IndexedDB, no crypto.subtle, an http origin): hidden even when the flag is on.
 expect(draftVaultIfEnabled({flags,supported:false,create:()=>{created++;return new WorkroomDraftVault({storage});}})).toBeNull();expect(created).toBe(0);
 expect(workroomDraftVaultSupported({indexedDB:undefined,crypto:globalThis.crypto,isSecureContext:true})).toBe(false);
 expect(workroomDraftVaultSupported({indexedDB:{} as IDBFactory,crypto:{} as Crypto,isSecureContext:true})).toBe(false);
 expect(workroomDraftVaultSupported({indexedDB:{} as IDBFactory,crypto:globalThis.crypto,isSecureContext:false})).toBe(false);
 expect(workroomDraftVaultSupported({indexedDB:{} as IDBFactory,crypto:globalThis.crypto,isSecureContext:true})).toBe(true);
});

test('drafts are sealed with a non-extractable key and the stored bytes never contain the text',async()=>{
 const storage=new RecordingStorage(),vault=new WorkroomDraftVault({storage});
 const text='PRIVATE_SYNTHETIC_draft 한글🙂\r';
 await vault.save({scope,sessionId,submissionId:'queued-submission-1',text,references:['ref-target-1']});
 const key=[...storage.records.values()].find(v=>(v as {key?:unknown}).key instanceof CryptoKey) as {key:CryptoKey;storeId:string};
 expect(key.key.extractable).toBe(false);expect(key.key.algorithm.name).toBe('AES-GCM');
 const draft=storage.records.get('draft:queued-submission-1') as Record<string,unknown>;
 expect(Object.keys(draft).sort()).toEqual(['attempted','ciphertext','nonce','savedAt','schemaVersion','scope','sessionId','submissionId']);
 const bytes=Buffer.from(draft.ciphertext as ArrayBuffer);
 for(const secret of ['PRIVATE_SYNTHETIC_draft','한글','ref-target-1'])expect(bytes.includes(Buffer.from(secret))).toBe(false);
 expect(JSON.stringify([...storage.records.values()].map(v=>({...(v as object),key:undefined})))).not.toContain('PRIVATE_SYNTHETIC');
 const listed=await vault.list(scope,sessionId);
 expect(listed).toEqual({drafts:[{submissionId:'queued-submission-1',text,references:['ref-target-1'],savedAt:expect.any(Number),attempted:false}],dropped:0});
 expect((await vault.list(scope,'other-session-2222')).drafts).toEqual([]);
});

// Review S3-8 (low, 2026-10-16): the key used to be read, generated and then written outside one transaction, so two
// windows saving for the first time at once each wrote their own key and the loser's draft no longer opened.
test('two windows saving for the first time at once end up with one key and both drafts open',async()=>{
 /** Every key read waits a macrotask, so both windows are certain to read «no key» before either one writes it. */
 class SlowKeyReadStorage extends RecordingStorage {
  override async read(key:string){const value=await super.read(key);if(key==='key')await new Promise(resolve=>setTimeout(resolve,5));return value;}
 }
 const storage=new SlowKeyReadStorage();
 const main=new WorkroomDraftVault({storage}),popout=new WorkroomDraftVault({storage});
 await Promise.all([
  main.save({scope,sessionId,submissionId:'first-window-draft',text:'from the main window\r',references:[]}),
  popout.save({scope,sessionId,submissionId:'second-window-draft',text:'from the popout\r',references:[]}),
 ]);
 const keys=[...storage.records.values()].filter(v=>(v as {key?:unknown}).key instanceof CryptoKey);
 expect(keys).toHaveLength(1);
 const listed=await new WorkroomDraftVault({storage}).list(scope,sessionId);
 expect(listed.dropped).toBe(0);
 expect(listed.drafts.map(d=>d.text).sort()).toEqual(['from the main window\r','from the popout\r']);
 // A third window that finds the key already there neither generates nor writes another one.
 const writes=storage.writes;
 await new WorkroomDraftVault({storage}).save({scope,sessionId,submissionId:'third-window-draft',text:'third\r',references:[]});
 expect(storage.writes).toBe(writes+1);
 expect((await main.list(scope,sessionId)).drafts).toHaveLength(3);
});

test('a record moved to another session or another store is refused and dropped',async()=>{
 const storage=new RecordingStorage(),vault=new WorkroomDraftVault({storage});
 await vault.save({scope,sessionId,submissionId:'moved-submission',text:'move me\r',references:[]});
 const record=storage.records.get('draft:moved-submission') as Record<string,unknown>;
 storage.records.set('draft:moved-submission',{...record,sessionId:'other-session-2222'});
 expect(await vault.list(scope,'other-session-2222')).toEqual({drafts:[],dropped:1});expect(storage.records.has('draft:moved-submission')).toBe(false);

 await vault.save({scope,sessionId,submissionId:'store-bound-draft',text:'bound\r',references:[]});
 const keyEntry=[...storage.records].find(([,v])=>(v as {key?:unknown}).key instanceof CryptoKey)!;
 storage.records.set(keyEntry[0],{...(keyEntry[1] as object),storeId:'another-store-id-0000'});
 expect(await new WorkroomDraftVault({storage}).list(scope,sessionId)).toEqual({drafts:[],dropped:1});

 const other=new WorkroomDraftVault({storage});
 await other.save({scope:'remote:host-a',sessionId,submissionId:'scope-bound-draft',text:'scoped\r',references:[]});
 const scoped=storage.records.get('draft:scope-bound-draft') as Record<string,unknown>;
 storage.records.set('draft:scope-bound-draft',{...scoped,scope:'local'});
 expect(await other.list('local',sessionId)).toEqual({drafts:[],dropped:1});
});

test('drafts expire after seven days, stay within the count and size limits and can be deleted',async()=>{
 let now=Date.parse('2026-10-15T00:00:00Z');const storage=new RecordingStorage(),vault=new WorkroomDraftVault({storage,now:()=>now});
 await vault.save({scope,sessionId,submissionId:'expiring-draft',text:'old\r',references:[]});
 now+=WORKROOM_DRAFT_VAULT_TTL_MS-1;expect((await vault.list(scope,sessionId)).drafts).toHaveLength(1);
 now+=2;expect((await vault.list(scope,sessionId)).drafts).toEqual([]);expect(storage.records.has('draft:expiring-draft')).toBe(false);
 for(let i=0;i<WORKROOM_DRAFT_VAULT_LIMIT;i++,now++)await vault.save({scope,sessionId,submissionId:'limit-draft-'+i,text:'n'+i+'\r',references:[]});
 await expect(vault.save({scope,sessionId,submissionId:'limit-draft-over',text:'over\r',references:[]})).rejects.toMatchObject({code:'DRAFT_LIMIT'});
 // Saving the same id again replaces it and does not count as a new draft.
 await vault.save({scope,sessionId,submissionId:'limit-draft-0',text:'replaced\r',references:[]});
 const drafts=(await vault.list(scope,sessionId)).drafts;expect(drafts).toHaveLength(WORKROOM_DRAFT_VAULT_LIMIT);expect(drafts.map(d=>d.submissionId).slice(0,2)).toEqual(['limit-draft-1','limit-draft-2']);
 await vault.delete('limit-draft-5');expect(await vault.count()).toBe(WORKROOM_DRAFT_VAULT_LIMIT-1);
 await expect(vault.save({scope,sessionId,submissionId:'huge-draft',text:'x'.repeat(1024*1024+1)+'\r',references:[]})).rejects.toMatchObject({code:'DRAFT_TOO_LARGE'});
 await expect(vault.save({scope,sessionId,submissionId:'bad id with spaces',text:'x\r',references:[]})).rejects.toMatchObject({code:'DRAFT_INVALID'});
 await vault.clear();expect(storage.records.size).toBe(0);
});

test('a restored queue is stopped and makes no transport call until the user presses send',async()=>{
 const storage=new RecordingStorage();
 const before=new WorkroomDraftVault({storage});
 await before.save({scope,sessionId,submissionId:'queued-one-1111',text:'first\r',references:[]});
 await before.save({scope,sessionId,submissionId:'queued-two-2222',text:'second\r',references:[]});
 let calls=0;const request=async()=>{calls++;return {} as AiTerminalResponse;};void request;
 // A reload: a new vault instance over the same storage. Restoring reads only — it is not even given a transport.
 const items=await restoreDraftQueue(new WorkroomDraftVault({storage}),scope,sessionId);
 expect(items.map(i=>[i.submissionId,i.state])).toEqual([['queued-one-1111','stopped'],['queued-two-2222','stopped']]);
 expect(WORKROOM_DRAFT_STOPPED_LABEL).toContain('직접');expect(calls).toBe(0);
});

function journalFixture(){
 const dir=mkdtempSync(join(tmpdir(),'draft-queue-'));chmodSync(dir,0o700);dirs.push(dir);
 const store=new WorkroomConversationJournal(dir);stores.push(store);const manager=new WorkroomSubmissions(()=>store);managers.push(manager);
 const writes:string[]=[],phases:string[]=[];let failStatus=false;
 // The receipt owner is the transport's principal (relay session, device consent, community endpoint). It can change
 // between the original send and the queued one — a new QR, a granted consent, a re-published Mac.
 const requestAs=(owner:string)=>async(r:Omit<AiTerminalRequest,'requestId'>):Promise<AiTerminalResponse>=>{
  phases.push(r.submission!.phase);
  if(failStatus&&r.submission!.phase==='status')throw Error('network lost');
  const context={owner,sessionId,targetId:'fixture-project',binding:'a'.repeat(64),revision:0};
  return {submission:await manager.perform(r.submission!,context,r.references??[],async(text,start)=>{start();writes.push(text);})};
 };
 return {request:requestAs('fixture-owner'),requestAs,writes,phases,failStatus:(v:boolean)=>{failStatus=v;}};
}
const neverClaimed=async()=>{throw Error('claim must not be asked');};

test('sending a queued draft asks for its receipt first and never writes the same request twice',async()=>{
 const f=journalFixture(),storage=new RecordingStorage(),vault=new WorkroomDraftVault({storage});
 const draft={submissionId:'queued-sent-before-crash',text:'already sent\r',references:[] as string[]};
 await vault.save({scope,sessionId,...draft});
 // The page crashed after the host wrote it: the receipt exists, the queue still holds the draft.
 expect((await submitWorkroomDraft({id:draft.submissionId,sessionId,text:draft.text,request:f.request,prepared:()=>{}})).state).toBe('written');
 expect(f.writes).toEqual(['already sent\r']);f.phases.length=0;
 const [item]=await restoreDraftQueue(vault,scope,sessionId);
 const outcome=await sendQueuedDraft({draft:item!,sessionId,request:f.request,claim:neverClaimed,prepared:()=>{}});
 expect(outcome.kind).toBe('existing');expect(outcome.receipt!.state).toBe('written');expect(outcome.receipt!.id).toBe(draft.submissionId);
 expect(f.phases).toEqual(['status']);expect(f.writes).toEqual(['already sent\r']);
});

test('a queued draft the host never saw is sent once with its pre-assigned id; a failed status check sends nothing',async()=>{
 const f=journalFixture();
 const draft={submissionId:'queued-never-seen',text:'send me once\r',references:[] as string[],savedAt:0,attempted:false,state:'stopped' as const};
 let claims=0;const claim=async()=>{claims++;return 'fresh' as const;};
 f.failStatus(true);
 await expect(sendQueuedDraft({draft,sessionId,request:f.request,claim,prepared:()=>{}})).rejects.toThrow();
 expect(f.phases).toEqual(['status']);expect(f.writes).toEqual([]);expect(claims).toBe(0);
 f.failStatus(false);f.phases.length=0;
 const sent=await sendQueuedDraft({draft,sessionId,request:f.request,claim,prepared:()=>{}});
 expect(sent.kind).toBe('sent');expect(sent.receipt!.id).toBe('queued-never-seen');expect(sent.receipt!.state).toBe('written');
 expect(f.phases).toEqual(['status','single']);expect(f.writes).toEqual(['send me once\r']);expect(claims).toBe(1);
 // Pressing send again (a stale queue in another window) finds the receipt and writes nothing.
 f.phases.length=0;const again=await sendQueuedDraft({draft,sessionId,request:f.request,claim,prepared:()=>{}});
 expect(again.kind).toBe('existing');expect(f.phases).toEqual(['status']);expect(f.writes).toEqual(['send me once\r']);
});

test('a draft that was ever handed to a transport is not sent on a bare not-found after the receipt owner changed',async()=>{
 const f=journalFixture(),storage=new RecordingStorage(),vault=new WorkroomDraftVault({storage});
 // The direct send path seals the request as attempted before it leaves; the host writes it under the first relay session.
 const first={submissionId:'draft-xyz-1-sent',text:'rm -rf build\r',references:[] as string[]};
 await vault.save({scope,sessionId,...first,attempted:true});
 expect((await submitWorkroomDraft({id:first.submissionId,sessionId,text:first.text,request:f.requestAs('internet:relay-session-1'),prepared:()=>{}})).state).toBe('written');
 // The result was lost and the page died; the user scanned a new QR, so the same id now looks up under another owner.
 f.phases.length=0;
 const [item]=await restoreDraftQueue(new WorkroomDraftVault({storage}),scope,sessionId);
 expect(item!.attempted).toBe(true);
 const claim=()=>vault.claimForSend(scope,sessionId,first.submissionId);
 const outcome=await sendQueuedDraft({draft:item!,sessionId,request:f.requestAs('internet:relay-session-2'),claim,prepared:()=>{}});
 expect(outcome.kind).toBe('unproven');expect(outcome.receipt).toBeUndefined();
 expect(f.phases).toEqual(['status']);expect(f.writes).toEqual(['rm -rf build\r']);
 expect((await vault.list(scope,sessionId)).drafts.map(d=>d.submissionId)).toEqual([first.submissionId]);
});

test('the first press claims a queued draft before sending, so a later press under another owner refuses too',async()=>{
 const f=journalFixture(),storage=new RecordingStorage(),vault=new WorkroomDraftVault({storage});
 const queued={submissionId:'queued-then-pressed',text:'deploy staging\r',references:[] as string[]};
 await vault.save({scope,sessionId,...queued});
 const [fresh]=await restoreDraftQueue(vault,scope,sessionId);expect(fresh!.attempted).toBe(false);
 const claim=()=>vault.claimForSend(scope,sessionId,queued.submissionId);
 const sent=await sendQueuedDraft({draft:fresh!,sessionId,request:f.requestAs('device:host-a:controller-1'),claim,prepared:()=>{}});
 expect(sent.kind).toBe('sent');expect(f.writes).toEqual(['deploy staging\r']);
 // The written receipt never came back to this page; the stored draft is now marked as attempted.
 const [after]=await restoreDraftQueue(new WorkroomDraftVault({storage}),scope,sessionId);expect(after!.attempted).toBe(true);
 // A window still showing the stale, unclaimed item presses send under another owner: the store says attempted.
 f.phases.length=0;
 const stale=await sendQueuedDraft({draft:fresh!,sessionId,request:f.requestAs('internet:relay-session-9'),claim,prepared:()=>{}});
 expect(stale.kind).toBe('unproven');expect(f.phases).toEqual(['status']);expect(f.writes).toEqual(['deploy staging\r']);
 // A draft deleted in another window is not sent either.
 await vault.delete(queued.submissionId);
 expect(await vault.claimForSend(scope,sessionId,queued.submissionId)).toBe('missing');
 // Claims only open this scope and session's record.
 await vault.save({scope,sessionId,submissionId:'other-scope-draft',text:'x\r',references:[]});
 expect(await vault.claimForSend('remote:host-b',sessionId,'other-scope-draft')).toBe('missing');
 expect(await vault.claimForSend(scope,sessionId,'other-scope-draft')).toBe('fresh');
 expect(await vault.claimForSend(scope,sessionId,'other-scope-draft')).toBe('attempted');
});

// Review S3-8 (low, 2026-10-16): 「현재 세션에 전송」 started sealing and submitting at the same time, so a tab that died
// right after the send could lose the text the vault was supposed to keep. The seal now completes before the request
// leaves; a slow or failed seal never blocks the send — the request still goes once and the screen says it may not be kept.
/** Holds every draft write until `release()`, like an IndexedDB transaction that has not committed yet. */
class GatedDraftStorage extends RecordingStorage {
 #open:(()=>void)|null=null;readonly #gate=new Promise<void>(resolve=>{this.#open=resolve;});
 release(){this.#open?.();}
 override async write(key:string,value:unknown){if(key.startsWith('draft:'))await this.#gate;await super.write(key,value);}
}
test('the direct send stores its seal (attempted) before the request leaves',async()=>{
 const f=journalFixture(),storage=new GatedDraftStorage(),vault=new WorkroomDraftVault({storage});
 const id='direct-send-sealed-1';let sealAtFirstCall:unknown='no call';
 const request:typeof f.request=async r=>{if(sealAtFirstCall==='no call')sealAtFirstCall=(storage.records.get('draft:'+id) as {attempted?:unknown}|undefined)?.attempted;return f.request(r);};
 const sealed:string[]=[];
 const sending=sendWithDraftSeal({vault,scope,sessionId,id,text:'make check\r',references:[],request,prepared:()=>{},waitMs:10_000,onSealed:s=>sealed.push(s.state)});
 await new Promise(resolve=>setTimeout(resolve,40));
 expect(f.phases).toEqual([]);expect(sealed).toEqual([]);
 storage.release();
 const receipt=await sending.receipt;
 expect(receipt.state).toBe('written');expect(await sending.stored).toBe(true);expect(sealed).toEqual(['kept']);
 expect(sealAtFirstCall).toBe(true);expect(f.writes).toEqual(['make check\r']);
 expect(draftSealNotice({state:'kept'})).toBe('');
});
test('a seal that does not finish in time still sends once and says the request may not be kept',async()=>{
 const f=journalFixture(),storage=new GatedDraftStorage(),vault=new WorkroomDraftVault({storage});
 expect(WORKROOM_DRAFT_SEAL_WAIT_MS).toBeGreaterThan(0);expect(WORKROOM_DRAFT_SEAL_WAIT_MS).toBeLessThanOrEqual(3000);
 const notes:string[]=[];
 const sending=sendWithDraftSeal({vault,scope,sessionId,id:'direct-send-slow-1',text:'slow seal\r',references:[],request:f.request,prepared:()=>{},waitMs:30,
  onSealed:s=>notes.push(draftSealNotice(s))});
 expect((await sending.receipt).state).toBe('written');expect(f.writes).toEqual(['slow seal\r']);
 expect(notes).toHaveLength(1);expect(notes[0]).toContain('보관되지 않았을 수');
 // The late seal still lands as attempted, so a written receipt can remove it and the queue never re-sends it on its own.
 storage.release();expect(await sending.stored).toBe(true);
 expect((storage.records.get('draft:direct-send-slow-1') as {attempted:boolean}).attempted).toBe(true);
});
test('a failed seal still sends once and says the request was not kept',async()=>{
 const f=journalFixture(),storage=new RecordingStorage(),vault=new WorkroomDraftVault({storage});
 for(let i=0;i<WORKROOM_DRAFT_VAULT_LIMIT;i++)await vault.save({scope,sessionId,submissionId:'full-vault-draft-'+i,text:'n\r',references:[]});
 const notes:string[]=[];
 const sending=sendWithDraftSeal({vault,scope,sessionId,id:'direct-send-full-1',text:'vault is full\r',references:[],request:f.request,prepared:()=>{},
  onSealed:s=>notes.push(draftSealNotice(s))});
 expect((await sending.receipt).state).toBe('written');expect(f.writes).toEqual(['vault is full\r']);
 expect(await sending.stored).toBe(false);expect(storage.records.has('draft:direct-send-full-1')).toBe(false);
 expect(notes[0]).toContain('보관함에 넣지 못했습니다');expect(notes[0]).toContain('가득');
});
// Review S3-8 (low, 2026-10-16): the notice is shown from onSealed, before the submit, and the composer appends it to a
// submission failure that may say nothing was sent (a phone that went offline during the wait). It used to say
// 「…보관하지 않고 보냈습니다」, so one line said «not sent» and the next «sent». It speaks about keeping only now.
test('the seal notice speaks about keeping only, never about the request having been sent',async()=>{
 for(const sealed of [{state:'failed',reason:''},{state:'failed',reason:'보관함이 가득 찼습니다(32개).'},{state:'timeout'}] as const){
  const notice=draftSealNotice(sealed);
  expect(notice).not.toBe('');expect(notice).toContain('보관');expect(notice).not.toContain('보냈');
 }
 // The raw-input send with the vault on (integration review w4, 4a) follows the same rule.
 expect(DRAFT_RAW_SEND_NOTICE).toContain('보관함에 넣지 않았습니다');expect(DRAFT_RAW_SEND_NOTICE).not.toContain('보냈');
 const storage=new RecordingStorage(),vault=new WorkroomDraftVault({storage});
 for(let i=0;i<WORKROOM_DRAFT_VAULT_LIMIT;i++)await vault.save({scope,sessionId,submissionId:'offline-full-draft-'+i,text:'n\r',references:[]});
 const refusal='휴대폰이 인터넷에 연결되어 있지 않아 요청을 보내지 않았습니다.';
 let notice='';
 const sending=sendWithDraftSeal({vault,scope,sessionId,id:'refused-before-send-1',text:'offline\r',references:[],
  request:async()=>{throw Error(refusal);},prepared:()=>{},onSealed:s=>{notice=draftSealNotice(s);}});
 await expect(sending.receipt).rejects.toThrow(refusal);
 expect(notice).toContain('가득');expect(notice).not.toContain('보냈');
});
// Review S3-8 (low, 2026-10-16): save() counted the vault by reading every stored record — up to 32 × 1 MiB of
// ciphertext — and the direct send now waits on that save, so send latency grew with the vault's contents. The count
// needs keys only.
test('saving counts the vault by keys and never reads the other drafts',async()=>{
 class EntryCountingStorage extends RecordingStorage {entryReads=0;override async entries(){this.entryReads++;return super.entries();}}
 const storage=new EntryCountingStorage(),vault=new WorkroomDraftVault({storage});
 for(let i=0;i<WORKROOM_DRAFT_VAULT_LIMIT;i++)await vault.save({scope,sessionId,submissionId:'counted-draft-'+i,text:'n\r',references:[]});
 expect(await vault.count()).toBe(WORKROOM_DRAFT_VAULT_LIMIT);
 // The limit holds as before: a new draft over it is refused, re-sealing one that is already kept is not.
 await expect(vault.save({scope,sessionId,submissionId:'counted-draft-over',text:'n\r',references:[]})).rejects.toMatchObject({code:'DRAFT_LIMIT'});
 await vault.save({scope,sessionId,submissionId:'counted-draft-0',text:'again\r',references:[]});
 expect(storage.entryReads).toBe(0);
});
test('with the vault off the send does not wait and stores nothing',async()=>{
 const f=journalFixture(),sealed:string[]=[];
 const sending=sendWithDraftSeal({vault:null,scope,sessionId,id:'direct-send-off-1',text:'no vault\r',references:[],request:f.request,prepared:()=>{},onSealed:s=>sealed.push(s.state)});
 expect((await sending.receipt).state).toBe('written');expect(await sending.stored).toBe(false);expect(sealed).toEqual(['off']);
 expect(draftSealNotice({state:'off'})).toBe('');
});
// Integration review w4 (4a): the composer's raw-input branch (no submission id to seal under) says the request was not kept
// when the vault is on — the browser check is tests/workroom-usability.e2e.mjs raw-send-with-the-vault-*.
test('the composer\'s raw-input send says it was not kept when the vault is on',()=>{
 const panel=readFileSync(join(import.meta.dir,'..','src','AiTerminalPanel.tsx'),'utf8');
 const start=panel.indexOf('const sendTerminalDraft=()=>{'),end=panel.indexOf('sendWithDraftSeal(',start);
 const raw=panel.slice(start,end).split('\n').find(line=>line.includes('!usableSessionStorage()'))??'';
 expect(raw).toContain('sendBoundInput(');expect(raw).toContain('if(draftVault.vault)setError(DRAFT_RAW_SEND_NOTICE)');
});
test('the composer\'s direct send goes through the seal-then-send path',()=>{
 const panel=readFileSync(join(import.meta.dir,'..','src','AiTerminalPanel.tsx'),'utf8');
 const start=panel.indexOf('const sendTerminalDraft=()=>{'),end=panel.indexOf('const sendQueuedDraftItem=',start);
 expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const body=panel.slice(start,end);
 expect(body).toContain('sendWithDraftSeal(');expect(body).not.toContain('submitWorkroomDraft(');expect(body).not.toContain('vault.save(');
});

test('a vault object kept by another window stores nothing once the setting is turned off',async()=>{
 const flags=memoryFlags();writeDraftVaultOptIn(flags,true);
 const storage=new RecordingStorage();
 // Two windows of one origin (main + popout): each built its own vault while the setting was on.
 const main=createGatedDraftVault({flags,storage}),popout=createGatedDraftVault({flags,storage});
 await popout.save({scope,sessionId,submissionId:'before-off-draft',text:'kept\r',references:[]});
 await turnDraftVaultOff({flags,vault:main});
 expect(storage.records.size).toBe(0);expect(readDraftVaultOptIn(flags)).toBe(false);
 const writes=storage.writes;
 await expect(popout.save({scope,sessionId,submissionId:'after-off-draft',text:'secret after opt-out\r',references:[]})).rejects.toMatchObject({code:'DRAFT_VAULT_OFF'});
 await expect(popout.claimForSend(scope,sessionId,'before-off-draft')).rejects.toMatchObject({code:'DRAFT_VAULT_OFF'});
 expect(storage.writes).toBe(writes);expect(storage.records.size).toBe(0);
});

test('a save racing the opt-out is wiped, and turning off removes the flag before clearing',async()=>{
 const flags=memoryFlags();writeDraftVaultOptIn(flags,true);
 const order:string[]=[];
 class RacingStorage extends RecordingStorage {
  override async write(key:string,value:unknown){await super.write(key,value);if(key.startsWith('draft:')){order.push('write');writeDraftVaultOptIn(flags,false);}}
  override async clear(){order.push(readDraftVaultOptIn(flags)?'clear-while-on':'clear-while-off');await super.clear();}
 }
 const storage=new RacingStorage(),vault=createGatedDraftVault({flags,storage});
 // The other window removed the flag (and cleared) while this save was writing: nothing may remain.
 await expect(vault.save({scope,sessionId,submissionId:'racing-draft-1',text:'race\r',references:[]})).rejects.toMatchObject({code:'DRAFT_VAULT_OFF'});
 expect(storage.records.size).toBe(0);
 // The window that turns it off removes the flag first, so a save landing between flag and clear is caught by the line above.
 writeDraftVaultOptIn(flags,true);order.length=0;
 await turnDraftVaultOff({flags,vault:new WorkroomDraftVault({storage:new RacingStorage()})});
 expect(order).toEqual(['clear-while-off']);
 // A failed clear puts the setting back on, so the user still sees it on and can try again.
 writeDraftVaultOptIn(flags,true);
 const broken=new WorkroomDraftVault({storage:Object.assign(new RecordingStorage(),{clear:async()=>{throw Error('disk');}})});
 await expect(turnDraftVaultOff({flags,vault:broken})).rejects.toThrow();expect(readDraftVaultOptIn(flags)).toBe(true);
});

test('turning the setting off reaches every other instance of this origin',async()=>{
 const seen:string[]=[];
 const events=new EventTarget();
 const env={BroadcastChannel:globalThis.BroadcastChannel,events};
 const stopA=subscribeDraftVaultOptIn(()=>seen.push('a'),env),stopB=subscribeDraftVaultOptIn(()=>seen.push('b'),env);
 // Same window (another panel, the session dialog) and other windows/tabs: one broadcast.
 announceDraftVaultOptIn(env);
 await new Promise(resolve=>setTimeout(resolve,30));
 expect(seen.sort()).toEqual(['a','b']);
 // Another window's localStorage change (the `storage` event) for this flag only.
 seen.length=0;
 events.dispatchEvent(Object.assign(new Event('storage'),{key:'something-else'}));
 events.dispatchEvent(Object.assign(new Event('storage'),{key:WORKROOM_DRAFT_VAULT_FLAG_KEY}));
 expect(seen.sort()).toEqual(['a','b']);
 stopA();stopB();seen.length=0;
 announceDraftVaultOptIn(env);events.dispatchEvent(Object.assign(new Event('storage'),{key:WORKROOM_DRAFT_VAULT_FLAG_KEY}));
 await new Promise(resolve=>setTimeout(resolve,30));
 expect(seen).toEqual([]);
 // No BroadcastChannel (older WebView): the storage event still works and announcing does not throw.
 const plain={events};const stopC=subscribeDraftVaultOptIn(()=>seen.push('c'),plain);
 expect(()=>announceDraftVaultOptIn(plain)).not.toThrow();
 events.dispatchEvent(Object.assign(new Event('storage'),{key:null}));expect(seen).toEqual(['c']);stopC();
});

// Integration review 2026-10-15 (A2): the main window's composer lives in the session directory (`directory:local`) and
// the popout in `popout`; both write as this Mac, so their kept requests must land in one queue. Another Mac reached from
// either surface (`directory:<deviceId>` / `community:<deviceId>`) shares one queue too. Other scopes are untouched.
test('every surface that writes as the same receipt owner keeps its requests in one queue',()=>{
 expect(draftVaultScopeFor('popout')).toBe('local');
 expect(draftVaultScopeFor('local')).toBe('local');
 expect(draftVaultScopeFor('directory:local')).toBe('local');
 expect(draftVaultScopeFor('directory:dev-2ho')).toBe('community:dev-2ho');
 expect(draftVaultScopeFor('community:dev-2ho')).toBe('community:dev-2ho');
 expect(draftVaultScopeFor('host-abc')).toBe('host-abc');
});
