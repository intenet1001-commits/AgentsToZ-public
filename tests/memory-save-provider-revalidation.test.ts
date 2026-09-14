import {test,expect,afterEach} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {MemorySaveStore} from '../src/memorySaveStore';
import {saveDigest,type MemorySaveSource} from '../src/memorySaveContract';
import type {MemoryProviderBinding} from '../src/memorySaveProviderContract';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'memory-revalidate-'));roots.push(root);let now=1000;
 const store=new MemorySaveStore(join(root,'save.sqlite'),()=>now);
 const binding:MemoryProviderBinding={version:1,agent:'claude',model:'claude-fixture-1',effort:'low',
  binaryFingerprint:saveDigest('binary'),accountFingerprint:saveDigest('account'),installationFingerprint:saveDigest('installation'),preparedAt:now};
 const source=(turnId:string):MemorySaveSource=>({agent:'codex',instanceId:'instance',sessionId:'session',turnId,
  startByte:0,endByte:200,sourceDigest:saveDigest(turnId),memoryId:'memory',policyEpoch:1,completedAt:now,coverageKind:'complete-turn'});
 store.setProviderBinding(binding);store.observe(source('before-consent'));now=2000;
 store.setAutomaticPolicy(0,{enabled:true,consentVersion:1,providerBindingDigest:saveDigest(binding),scopeMemoryId:'memory',scopeTargetId:'target',excludedMemoryIds:['other-memory']});
 now=3000;const key=store.observe(source('after-consent'));
 const snapshot=()=>{const db=new Database(store.path,{readonly:true});try{return{
  policy:JSON.parse((db.query('SELECT payload FROM save_auto_policy').get() as {payload:string}).payload),
  provider:db.query('SELECT * FROM save_provider_binding').all(),sources:db.query('SELECT * FROM save_sources ORDER BY sequence').all(),
  jobs:db.query('SELECT * FROM save_jobs ORDER BY sequence').all(),attempts:db.query('SELECT * FROM save_auto_attempts ORDER BY startedAt').all(),
  backups:db.query('SELECT * FROM backup_outbox ORDER BY saveId').all(),
 };}finally{db.close();}};
 const next={...binding,binaryFingerprint:saveDigest('updated-binary'),preparedAt:now};
 return {store,binding,next,key,source,snapshot,setNow:(value:number)=>{now=value;}};
}
test('binary refresh atomically preserves consent time, observation boundary, scope, exclusions and pending coverage across reopen',()=>{
 const f=fixture(),before=f.snapshot();
 expect(f.store.assertProviderRevalidation(1,saveDigest(f.binding))).toEqual(f.binding);
 f.store.revalidateProviderBinding(1,saveDigest(f.binding),f.next);
 const after=f.snapshot();expect(after.policy).toEqual({...before.policy,revision:2,providerBindingDigest:saveDigest(f.next)});
 expect(after.sources).toEqual(before.sources);expect(after.jobs).toEqual(before.jobs);expect(after.attempts).toEqual(before.attempts);
 const reopened=new MemorySaveStore(f.store.path,()=>3000);
 expect(reopened.providerBinding()).toEqual(f.next);
 expect(reopened.automaticPending('memory',1,2).items.map(i=>i.sourceKey)).toEqual([f.key]);
 expect(()=>reopened.revalidateProviderBinding(1,saveDigest(f.binding),f.next)).toThrow('POLICY_CHANGED');
});
test('model, effort, account, installation and backward preparation time cannot replace an enabled binding',()=>{
 const f=fixture(),before=f.snapshot();
 for(const change of [{model:'claude-fixture-2'},{effort:'medium' as const},{accountFingerprint:saveDigest('other')},
  {installationFingerprint:saveDigest('other')},{preparedAt:999}]){
  expect(()=>f.store.revalidateProviderBinding(1,saveDigest(f.binding),{...f.next,...change})).toThrow('POLICY_CHANGED');
  expect(f.snapshot()).toEqual(before);
 }
});
test('prepared, running and recovery jobs block refresh without clearing any durable state',()=>{
 for(const phase of ['prepared','summarizing','recovery-required']){
  const f=fixture(),job=f.store.reserve('memory',1,[f.key]);
  if(phase!=='prepared'){
   const attempt=f.store.beginAutomaticAttempt(job.saveId,job.coverageDigest,1,{inputDigest:saveDigest('input'),beforeHash:saveDigest('before'),providerBindingDigest:saveDigest(f.binding)});
   if(phase==='recovery-required')f.store.requireRecovery(job.saveId,attempt);
  }
  const before=f.snapshot();
  expect(()=>f.store.assertProviderRevalidation(1,saveDigest(f.binding))).toThrow('RECOVERY_REQUIRED');
  expect(()=>f.store.revalidateProviderBinding(1,saveDigest(f.binding),f.next)).toThrow('RECOVERY_REQUIRED');
  expect(f.snapshot()).toEqual(before);
 }
});
test('completed attempts, receipts and quota remain authoritative after refresh',()=>{
 const f=fixture(),job=f.store.reserve('memory',1,[f.key]);
 const intent={inputDigest:saveDigest('input'),beforeHash:saveDigest('before'),providerBindingDigest:saveDigest(f.binding)};
 const attempt=f.store.beginAutomaticAttempt(job.saveId,job.coverageDigest,1,intent);
 f.store.commitLocal(job.saveId,attempt,{manifestDigest:saveDigest('manifest'),beforeHash:intent.beforeHash,afterHash:saveDigest('after'),localRevisionId:'revision'},true);
 f.setNow(4000);const pending=f.store.observe(f.source('later'));const before=f.snapshot();
 f.store.revalidateProviderBinding(1,saveDigest(f.binding),{...f.next,preparedAt:4000});
 const after=f.snapshot();expect(after.jobs).toEqual(before.jobs);expect(after.attempts).toEqual(before.attempts);expect(after.backups).toEqual(before.backups);
 expect(()=>f.store.checkAutomaticSources('memory',1,[pending],2,after.policy.providerBindingDigest)).toThrow('BUDGET_PAUSED');
});
test('concurrent opt-out and a partial binding-write failure cannot leave a mixed policy',()=>{
 const f=fixture();f.store.setAutomaticPolicy(1,{enabled:false});const disabled=f.snapshot();
 expect(()=>f.store.revalidateProviderBinding(1,saveDigest(f.binding),f.next)).toThrow('POLICY_CHANGED');expect(f.snapshot()).toEqual(disabled);
 const other=fixture(),db=new Database(other.store.path);
 db.run("CREATE TRIGGER fail_binding_refresh BEFORE UPDATE ON save_provider_binding BEGIN SELECT RAISE(ABORT,'fixture failure'); END");db.close();
 const before=other.snapshot();expect(()=>other.store.revalidateProviderBinding(1,saveDigest(other.binding),other.next)).toThrow('STORAGE_UNAVAILABLE');expect(other.snapshot()).toEqual(before);
});
test('host clock rollback refuses refresh without changing consent or its clock fence',()=>{
 const f=fixture(),before=f.snapshot();f.setNow(1000);
 expect(()=>f.store.revalidateProviderBinding(1,saveDigest(f.binding),f.next)).toThrow('CLOCK_ROLLBACK');expect(f.snapshot()).toEqual(before);
});
