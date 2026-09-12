import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,realpathSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {initializeProjectMemory,prepareProjectMemorySession,applyProjectMemorySession,readMemoryDocument,readProjectMemoryJournal} from '../project-memory-server';
import {MemorySessionStore} from '../src/memorySessionStore';
import {MemorySaveStore} from '../src/memorySaveStore';
import {MemorySaveAutomaticHost} from '../src/memorySaveAutomaticHost';
import {MemorySaveDispatcher} from '../src/memorySaveDispatcher';
import {saveDigest} from '../src/memorySaveContract';
import {bindPreparedMemorySaveSession,applyBoundMemorySaveSession} from '../src/memorySaveHostCommit';
import {acquireWorkspaceDirectoryLease,type WorkspaceLease} from '../src/workspaceLease';
const roots:string[]=[],leases:WorkspaceLease[]=[];afterEach(()=>{for(const l of leases.splice(0))l.release();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
async function fixture(backupRequested=false){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'host-save-v2-')));roots.push(base);const root=join(base,'project'),app=join(base,'app');mkdirSync(root);mkdirSync(app);
 const status=initializeProjectMemory({folderPath:root,autoBackup:false});
 const before=readMemoryDocument(root,status.memoryPath!);const beforeHash=createHash('sha256').update(before).digest('hex');
 const saves=new MemorySaveStore(join(app,'memory-save-v2.sqlite'));const sessions=new MemorySessionStore(join(app,'memory-session-recovery.sqlite'));
 const key=saves.observe({agent:'codex',instanceId:'instance',sessionId:'session',turnId:'turn',startByte:0,endByte:1,sourceDigest:saveDigest('source'),memoryId:status.config!.memoryId,policyEpoch:1,completedAt:1,coverageKind:'complete-turn'});
 const job=saves.reserve(status.config!.memoryId,1,[key]);const attemptId=saves.beginAttempt(job.saveId,job.coverageDigest,{inputDigest:saveDigest('input'),beforeHash,providerBindingDigest:saveDigest('provider')});
 const next='# Project Core Memory\n\n## Key Decisions\n\n### Verified fixture decision\nKeep verified evidence.\n';
 const plan=prepareProjectMemorySession({root,memoryPath:status.memoryPath!,next,narrative:'Bound host fixture',agent:'codex',autoBackup:backupRequested,recordedAt:'2026-09-07T01:00:00Z',saveV2:{saveId:job.saveId,attemptId}});sessions.prepare(plan);
 const lease=await acquireWorkspaceDirectoryLease({workspacePath:root,appDataDir:app,attempts:1,deadOwnerRecoveryClass:'manual'});leases.push(lease);
 const c={root,lease,sessions,saves,saveId:job.saveId,attemptId,sessionPlanId:plan.id,validateRegistration:async()=>({memoryId:plan.memoryId,canonicalRoot:root})};
 return {base,root,app,before,next,plan,c};
}

test('bound host application records local receipt and backup intent before retiring the host plan',async()=>{
 const f=await fixture(true);await bindPreparedMemorySaveSession(f.c);let sawPending=false;
 const result=await applyBoundMemorySaveSession(f.c,stage=>{if(stage==='receipt'){sawPending=true;expect(f.c.saves.get(f.c.saveId).phase).toBe('local-saved');expect(f.c.sessions.status(f.root)?.phase).toBe('outcome');}});
 expect(sawPending).toBe(true);expect(result).toMatchObject({localSaved:true,backupRequested:true,verifiedNow:true});expect(f.c.sessions.status(f.root)).toBeNull();
 expect(readMemoryDocument(f.root,join(f.root,f.plan.sourcePath))).toBe(f.next);expect(readProjectMemoryJournal(f.root).filter(j=>j.entryHash===f.plan.journal.entryHash)).toHaveLength(1);
 const db=new Database(f.c.saves.path);expect(db.query('SELECT state FROM backup_outbox').all()).toEqual([{state:'pending'}]);db.close();
 expect((await applyBoundMemorySaveSession(f.c)).verifiedNow).toBe(false);
});

test('legacy recovery cannot apply V2 plans without the exact host binding proof',async()=>{
 const f=await fixture();expect(()=>applyProjectMemorySession(f.c.sessions,f.root,f.plan.id)).toThrow('V2');
 expect(()=>applyProjectMemorySession(f.c.sessions,f.root,f.plan.id,undefined,{saveId:f.c.saveId,attemptId:f.c.attemptId,planDigest:saveDigest('wrong')})).toThrow('V2');
 expect(readMemoryDocument(f.root,join(f.root,f.plan.sourcePath))).toBe(f.before);expect(f.c.saves.hostBinding(f.c.saveId)).toBeNull();
 await expect(applyBoundMemorySaveSession(f.c)).rejects.toThrow('REVISION_CONFLICT');
 await bindPreparedMemorySaveSession(f.c);await bindPreparedMemorySaveSession(f.c);await applyBoundMemorySaveSession(f.c);
});

// Each durable interruption is an independent fixture with its own cleanup and deadline.
for(const stage of ['document','journal','state','outcome','before-receipt','receipt'])
test(stage+': interrupted host phase resumes the exact plan and journal without a new AI attempt',async()=>{
  const f=await fixture();await bindPreparedMemorySaveSession(f.c);
  await expect(applyBoundMemorySaveSession(f.c,s=>{if(s===stage)throw new Error('fixture interruption');})).rejects.toThrow('RECOVERY_REQUIRED');
  expect(f.c.saves.get(f.c.saveId).phase).toBe(stage==='receipt'?'local-saved':'recovery-required');
  const c={...f.c,saves:new MemorySaveStore(f.c.saves.path),sessions:new MemorySessionStore(f.c.sessions.path)};
  await applyBoundMemorySaveSession(c);expect(c.saves.get(c.saveId).attemptId).toBe(f.c.attemptId);
  expect(c.sessions.status(c.root)).toBeNull();expect(readProjectMemoryJournal(f.root).filter(j=>j.entryHash===f.plan.journal.entryHash)).toHaveLength(1);
});

test('exact recovery clears cold and warm current failures while preserving diagnostic history and unfinished cleanup',async()=>{
 for(const stage of ['before-receipt','receipt']){
  const f=await fixture(true);await bindPreparedMemorySaveSession(f.c);
  f.c.saves.setAutomaticPolicy(0,{enabled:true,consentVersion:1,providerBindingDigest:saveDigest('provider')});
  const target={id:'fixture-target',cwd:f.root,root:f.root,memoryId:f.plan.memoryId,validate:async()=>true};
  const forbidden=async():Promise<never>=>{throw new Error('Status/recovery fixture must not call a provider, key, or new execution lease');};
  const makeHost=()=>new MemorySaveAutomaticHost({enabled:()=>true,store:f.c.saves,sessions:f.c.sessions,
   appDataRoot:f.app,portalDataFile:join(f.app,'portal.json'),dispatcher:new MemorySaveDispatcher(),identity:()=> 'fixture-install',
   targets:async()=>[],resolve:async()=>target,discover:async()=>[],providerHost:()=>{throw new Error('Provider access is forbidden');},
   key:()=>{throw new Error('Key access is forbidden');},acquireApp:forbidden,acquireWorkspace:forbidden,release:()=>{},preflight:forbidden,disableLegacy:()=>{}});
  const host=makeHost();
  await expect(applyBoundMemorySaveSession(f.c,s=>{if(s===stage)throw new Error('Fixture host interruption');})).rejects.toThrow('RECOVERY_REQUIRED');
  f.c.saves.recordFailure(f.c.saveId,f.c.attemptId,{version:1,stage:'host-commit',code:'RECOVERY_REQUIRED',providerCallPossible:true});
  const history=f.c.saves.failure(f.c.saveId),policy=f.c.saves.automaticPolicy();
  expect(f.c.sessions.status(f.root)?.phase).toBe('outcome');
  // Populate the actual warm-host result through the existing pending-job guard.
  expect((await host.runLeased(target,f.c.lease,new AbortController().signal)).state).toBe('recovery-required');
  for(const current of [host,makeHost()])expect((await current.status(target)).last).toMatchObject({
   state:'recovery-required',localSaved:stage==='receipt',failure:stage==='receipt'?null:history,
   recovery:stage==='receipt'?'saved-plan':'bound-plan',
  });
  await applyBoundMemorySaveSession(f.c);
  for(const current of [host,makeHost()])expect((await current.status(target)).last).toMatchObject({state:'saved',localSaved:true,backupPending:true,failure:null,recovery:null});
  expect(f.c.saves.failure(f.c.saveId)).toEqual(history);
  expect(f.c.saves.get(f.c.saveId)).toMatchObject({phase:'local-saved',attemptId:f.c.attemptId});
  expect(f.c.saves.automaticPolicy()).toEqual(policy);expect(f.c.saves.page().items).toHaveLength(1);
  expect(f.c.sessions.status(f.root)).toBeNull();
  // A later empty scan also must not inherit the recovered job's old failure.
  expect((await host.runLeased(target,f.c.lease,new AbortController().signal)).state).toBe('idle');
  expect((await host.status(target)).last).toMatchObject({state:'idle',localSaved:false,failure:null,recovery:null});
  const nextPlan=prepareProjectMemorySession({root:f.root,memoryPath:join(f.root,f.plan.sourcePath),
   next:f.next+'\n### Later fixture\nA separate pending operation.\n',narrative:'Later fixture',agent:'codex',autoBackup:false});
  f.c.sessions.prepare(nextPlan);
  expect((await host.status(target)).last).toMatchObject({state:'recovery-required',localSaved:false,failure:null});
  expect(f.c.sessions.status(f.root)?.id).toBe(nextPlan.id);
  expect(f.c.saves.failure(f.c.saveId)).toEqual(history);
 }
});

test('a failed V2 receipt write retains the complete host plan for model-free retry',async()=>{
 const f=await fixture(true);await bindPreparedMemorySaveSession(f.c);const db=new Database(f.c.saves.path);
 db.run("CREATE TRIGGER deny_receipt BEFORE INSERT ON backup_outbox BEGIN SELECT RAISE(ABORT,'fixture I/O failure'); END");db.close();
 await expect(applyBoundMemorySaveSession(f.c)).rejects.toThrow('STORAGE_UNAVAILABLE');
 expect(f.c.sessions.status(f.root)?.phase).toBe('outcome');expect(f.c.saves.get(f.c.saveId).phase).toBe('recovery-required');expect(readMemoryDocument(f.root,join(f.root,f.plan.sourcePath))).toBe(f.next);
 const repair=new Database(f.c.saves.path);repair.run('DROP TRIGGER deny_receipt');repair.close();await applyBoundMemorySaveSession(f.c);
 expect(f.c.saves.get(f.c.saveId).phase).toBe('local-saved');
});

test('changed registration, host plan, and external document edits cannot become a success receipt',async()=>{
 const f=await fixture();await bindPreparedMemorySaveSession(f.c);
 await expect(applyBoundMemorySaveSession({...f.c,validateRegistration:async()=>null})).rejects.toThrow('SOURCE_CONFLICT');
 const binding=f.c.saves.hostBinding(f.c.saveId)!;
 expect(()=>f.c.saves.bindHostSession(f.c.saveId,f.c.attemptId,{...binding,planDigest:saveDigest('other')})).toThrow('REVISION_CONFLICT');
 expect(()=>f.c.saves.commitLocal(f.c.saveId,f.c.attemptId,{manifestDigest:binding.planDigest,beforeHash:binding.beforeHash,afterHash:binding.afterHash,localRevisionId:'wrong-plan'},false)).toThrow('REVISION_CONFLICT');
 writeFileSync(join(f.root,f.plan.sourcePath),'External decision must survive.\n');
 await expect(applyBoundMemorySaveSession(f.c)).rejects.toThrow('RECOVERY_REQUIRED');expect(readFileSync(join(f.root,f.plan.sourcePath),'utf8')).toBe('External decision must survive.\n');expect(f.c.saves.get(f.c.saveId).phase).toBe('recovery-required');
});

test('a durable receipt survives pruned display history and does not overwrite later project edits',async()=>{
 const f=await fixture();await bindPreparedMemorySaveSession(f.c);await applyBoundMemorySaveSession(f.c);
 const db=new Database(f.c.sessions.path);db.run('DELETE FROM completed');db.close();
 writeFileSync(join(f.root,f.plan.sourcePath),'Later decision.\n');const result=await applyBoundMemorySaveSession(f.c);
 expect(result.verifiedNow).toBe(false);expect(result.localSaved).toBe(true);expect(readFileSync(join(f.root,f.plan.sourcePath),'utf8')).toBe('Later decision.\n');
 expect(JSON.stringify(f.c.saves.hostBinding(f.c.saveId))).not.toContain(f.root);expect(JSON.stringify(f.c.saves.hostBinding(f.c.saveId))).not.toContain('Verified fixture');
});

test('the exact durable plan digest is required even if its memory ID and source path are unchanged',async()=>{
 const f=await fixture();await bindPreparedMemorySaveSession(f.c);const db=new Database(f.c.sessions.path);
 const row=db.query('SELECT payload FROM pending').get() as {payload:string};const plan=JSON.parse(row.payload);plan.journal.recordedAt='2030-01-01T00:00:00Z';db.query('UPDATE pending SET payload=?').run(JSON.stringify(plan));db.close();
 await expect(applyBoundMemorySaveSession(f.c)).rejects.toThrow('REVISION_CONFLICT');expect(readMemoryDocument(f.root,join(f.root,f.plan.sourcePath))).toBe(f.before);
});

test('a separate process death after file application leaves recoverable durable binding without another model call',async()=>{
 const f=await fixture();await bindPreparedMemorySaveSession(f.c);f.c.lease.release();
 const code=`import {MemorySaveStore} from ${JSON.stringify(join(import.meta.dir,'../src/memorySaveStore.ts'))};import {MemorySessionStore} from ${JSON.stringify(join(import.meta.dir,'../src/memorySessionStore.ts'))};import {applyBoundMemorySaveSession} from ${JSON.stringify(join(import.meta.dir,'../src/memorySaveHostCommit.ts'))};import {acquireWorkspaceDirectoryLease} from ${JSON.stringify(join(import.meta.dir,'../src/workspaceLease.ts'))};const root=${JSON.stringify(f.root)},memoryId=${JSON.stringify(f.plan.memoryId)};const lease=await acquireWorkspaceDirectoryLease({workspacePath:root,appDataDir:${JSON.stringify(f.app)},deadOwnerRecoveryClass:'guarded'});await applyBoundMemorySaveSession({root,lease,saves:new MemorySaveStore(${JSON.stringify(f.c.saves.path)}),sessions:new MemorySessionStore(${JSON.stringify(f.c.sessions.path)}),saveId:${JSON.stringify(f.c.saveId)},attemptId:${JSON.stringify(f.c.attemptId)},sessionPlanId:${JSON.stringify(f.plan.id)},validateRegistration:async()=>({memoryId,canonicalRoot:root})},stage=>{if(stage==='before-receipt')process.kill(process.pid,'SIGKILL');});`;
 const child=Bun.spawn([process.execPath,'-e',code],{stdout:'pipe',stderr:'pipe'});expect(await child.exited).not.toBe(0);expect(await new Response(child.stderr).text()).toBe('');
 expect(f.c.saves.get(f.c.saveId).phase).toBe('summarizing');expect(f.c.sessions.status(f.root)?.phase).toBe('outcome');
 const lease=await acquireWorkspaceDirectoryLease({workspacePath:f.root,appDataDir:f.app,attempts:3,retryMs:1,deadOwnerGraceMs:0,canRecoverDeadOwner:()=>true,deadOwnerRecoveryClass:'manual'});leases.push(lease);
 await applyBoundMemorySaveSession({...f.c,lease});expect(f.c.saves.get(f.c.saveId).attemptId).toBe(f.c.attemptId);expect(f.c.saves.get(f.c.saveId).phase).toBe('local-saved');
},15000);


test('edits while the final registration check awaits cannot receive a local success receipt',async()=>{
 const f=await fixture();await bindPreparedMemorySaveSession(f.c);let checks=0;
 const c={...f.c,validateRegistration:async()=>{if(++checks===2){await Promise.resolve();writeFileSync(join(f.root,f.plan.sourcePath),'Concurrent external decision.\n');}return {memoryId:f.plan.memoryId,canonicalRoot:f.root};}};
 await expect(applyBoundMemorySaveSession(c)).rejects.toThrow('RECOVERY_REQUIRED');
 expect(c.saves.get(c.saveId).phase).toBe('recovery-required');
 expect(readFileSync(join(f.root,f.plan.sourcePath),'utf8')).toBe('Concurrent external decision.\n');
});

test('host schema upgrade preserves pending legacy-compatible rows and fences older writers',async()=>{
 const f=await fixture();const db=new Database(f.c.sessions.path);
 db.run('PRAGMA user_version=1');db.close();
 expect(new MemorySessionStore(f.c.sessions.path).get(f.root)?.plan).toEqual(f.plan);
 const upgraded=new Database(f.c.sessions.path);
 expect(upgraded.query('PRAGMA user_version').get()).toEqual({user_version:2});upgraded.close();
 await bindPreparedMemorySaveSession(f.c);await applyBoundMemorySaveSession(f.c);
});
