import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,chmodSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {WorkroomSubmissions} from '../src/workroomSubmissions';
import {normalizeWorkroomSubmission,normalizeSubmissionReceipt,submissionDigest,type WorkroomSubmissionCommand} from '../src/workroomSubmissionProtocol';
import {submitWorkroomDraft,pendingSubmissionKey,readPendingSubmission,writePendingSubmission} from '../src/workroomSubmissionClient';
import {AiTerminalService} from '../src/aiTerminalService';
import type {AiTerminalRequest} from '../src/aiTerminalProtocol';
import {Database} from 'bun:sqlite';
import type {CorrectionTaskGuidance} from '../src/projectMemoryCorrectionContext';
const stores:WorkroomConversationJournal[]=[],dirs:string[]=[],managers:WorkroomSubmissions[]=[];
afterEach(()=>{for(const m of managers.splice(0))m.close();for(const s of stores.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'submission-'));chmodSync(dir,0o700);dirs.push(dir);const store=new WorkroomConversationJournal(dir);stores.push(store);let now=1000;const manager=new WorkroomSubmissions(()=>store,()=>now);managers.push(manager);const context={owner:'fixture-owner',sessionId:'fixture-session',targetId:'fixture-project',binding:'a'.repeat(64),revision:0};return{dir,store,manager,context,advance:(ms:number)=>{now+=ms;}};}
function command(text:string,id='fixture-submission'){const bytes=new TextEncoder().encode(text);return{bytes,begin:{phase:'begin' as const,id,bytes:bytes.length,chunks:Math.ceil(bytes.length/4000),digest:submissionDigest(bytes)}};}
async function upload(f:ReturnType<typeof fixture>,text:string,id='fixture-submission') {const c=command(text,id);const receipt=await f.manager.perform(c.begin,f.context,[],async()=>{throw Error('unexpected write');});for(let i=0;i<c.begin.chunks;i++)await f.manager.perform({phase:'chunk',id,epoch:receipt.epoch,index:i,data:Buffer.from(c.bytes.subarray(i*4000,(i+1)*4000)).toString('base64')},f.context,[],async()=>{throw Error('unexpected write');});return receipt;}
test('bounded strict phases and receipts reject extra keys, malformed base64 and impossible chunk counts',()=>{const c=command('hello\r');expect(normalizeWorkroomSubmission(c.begin)).toEqual(c.begin);for(const x of [{...c.begin,bytes:24001},{...c.begin,chunks:6},{...c.begin,path:'/secret'},{phase:'chunk',id:c.begin.id,epoch:'fixture-epoch',index:0,data:'%%%'}])expect(()=>normalizeWorkroomSubmission(x)).toThrow();expect(()=>normalizeSubmissionReceipt({id:c.begin.id,epoch:'fixture-epoch',revision:0,state:'written',storeId:'fixture-store',data:'secret'})).toThrow();});
test('incomplete chunks, a digest mismatch and invalid UTF8 never reach the writer',async()=>{const f=fixture();let writes=0;const c=command('한글🙂'.repeat(700)+'\r');const r=await f.manager.perform(c.begin,f.context,[],async()=>{writes++;});await expect(f.manager.perform({phase:'commit',id:r.id,epoch:r.epoch},f.context,[],async()=>{writes++;})).rejects.toThrow();expect(writes).toBe(0);
 const g=fixture();const b=command('hello\r');const s=await g.manager.perform(b.begin,g.context,[],async()=>{writes++;});await g.manager.perform({phase:'chunk',id:s.id,epoch:s.epoch,index:0,data:Buffer.from('xxxxx\r').toString('base64')},g.context,[],async()=>{writes++;});await expect(g.manager.perform({phase:'commit',id:s.id,epoch:s.epoch},g.context,[],async()=>{writes++;})).rejects.toThrow();expect(writes).toBe(0);
 const h=fixture();const bytes=Uint8Array.from([0xc0,0xaf,13]);const bad={phase:'begin' as const,id:'invalid-utf-eight',bytes:3,chunks:1,digest:submissionDigest(bytes)};const t=await h.manager.perform(bad,h.context,[],async()=>{writes++;});await h.manager.perform({phase:'chunk',id:t.id,epoch:t.epoch,index:0,data:Buffer.from(bytes).toString('base64')},h.context,[],async()=>{writes++;});await expect(h.manager.perform({phase:'commit',id:t.id,epoch:t.epoch},h.context,[],async()=>{writes++;})).rejects.toThrow();expect(writes).toBe(0);
});
test('whole Unicode submission is written once and a lost receipt retry never writes again',async()=>{const f=fixture(),text='한글🙂Friday\n'.repeat(500)+'\r';const r=await upload(f,text);let writes=0;let received='';const commit:WorkroomSubmissionCommand={phase:'commit',id:r.id,epoch:r.epoch};const writer=async(data:string,start:()=>void)=>{start();writes++;received=data;};const result=await f.manager.perform(commit,f.context,[],writer);expect(result.state).toBe('written');expect(received).toBe(text);expect((await f.manager.perform(commit,{...f.context,revision:1},[],writer)).state).toBe('written');expect(writes).toBe(1);expect(normalizeSubmissionReceipt(result)).toEqual(result);});
test('changed content, owner, binding, revision and writer epoch cannot reuse prepared input',async()=>{const f=fixture();const r=await upload(f,'draft\r');let writes=0;const write=async()=>{writes++;};for(const context of [{...f.context,revision:1},{...f.context,owner:'other-owner'},{...f.context,binding:'b'.repeat(64)}])await expect(f.manager.perform({phase:'commit',id:r.id,epoch:r.epoch},context,[],write)).rejects.toThrow();await expect(f.manager.perform({...command('other\r').begin},f.context,[],write)).rejects.toThrow();await expect(f.manager.perform({phase:'commit',id:r.id,epoch:'stale-epoch'},f.context,[],write)).rejects.toThrow();expect(writes).toBe(0);});
test('write_started survives a crash as unknown and never allows an automatic replay',async()=>{const f=fixture();const r=await upload(f,'draft\r');let writes=0;const result=await f.manager.perform({phase:'commit',id:r.id,epoch:r.epoch},f.context,[],async(_text:string,start:()=>void)=>{start();writes++;throw Error('partial write');});expect(result.state).toBe('unknown');const second=new WorkroomSubmissions(()=>f.store);expect((await second.perform({phase:'commit',id:r.id,epoch:r.epoch},f.context,[],async()=>{writes++;})).state).toBe('unknown');expect(writes).toBe(1);});
test('assemblers expire and remain bounded, raw input is fenced and close can release the reservation',async()=>{const f=fixture();const r=await upload(f,'draft\r');expect(()=>f.manager.assertRawAllowed(f.context.sessionId)).toThrow();await expect(f.manager.perform(command('draft\r','second-submission').begin,{...f.context,owner:'other-owner'},[],async()=>{})).rejects.toThrow();f.advance(30001);expect(()=>f.manager.assertRawAllowed(f.context.sessionId)).not.toThrow();await expect(f.manager.perform({phase:'commit',id:r.id,epoch:r.epoch},f.context,[],async()=>{})).rejects.toThrow();await upload(f,'draft\r','third-submission');f.manager.release(f.context.sessionId);expect(()=>f.manager.assertRawAllowed(f.context.sessionId)).not.toThrow();});
test('a real journal reopen preserves lineage, turns write_started into unknown and stores no payload',async()=>{const f=fixture();const text='PRIVATE_SYNTHETIC_COMMAND_never_store\r';const r=await upload(f,text);const key=f.manager.status(r.id,f.context).record.key;f.store.transitionSubmission(key,'prepared','write_started');const instance=f.store.storeInstanceId;f.store.close();const reopened=new WorkroomConversationJournal(f.dir);stores.push(reopened);expect(reopened.storeInstanceId).toBe(instance);const manager=new WorkroomSubmissions(()=>reopened);expect(manager.status(r.id,f.context).receipt.state).toBe('unknown');expect(readFileSync(join(f.dir,'workroom-history-v1','history.sqlite')).includes(Buffer.from(text.slice(0,-1)))).toBe(false);});
test('version one journal migration preserves records and instance identity atomically',()=>{const f=fixture(),instance=f.store.storeInstanceId;f.store.close();const path=join(f.dir,'workroom-history-v1','history.sqlite'),db=new Database(path);db.exec('DROP TABLE workroom_submissions; UPDATE workroom_meta SET version=1');db.close();const migrated=new WorkroomConversationJournal(f.dir);stores.push(migrated);expect(migrated.storeInstanceId).toBe(instance);const inspect=new Database(path,{readonly:true});expect((inspect.query('SELECT version FROM workroom_meta').get() as {version:number}).version).toBe(2);inspect.close();});
test('assembly and durable receipt budgets reject new work without deleting unknown evidence',async()=>{
 const f=fixture();for(let i=0;i<8;i++)await f.manager.perform(command('bounded\r','bounded-submission-'+i).begin,{...f.context,sessionId:'bounded-session-'+i},[],async()=>{});
 await expect(f.manager.perform(command('overflow\r','overflow-submission').begin,{...f.context,sessionId:'overflow-session'},[],async()=>{})).rejects.toThrow('준비 중');
 const g=fixture(),receipt=await upload(g,'keep unknown\r'),record=g.manager.status(receipt.id,g.context).record;g.store.transitionSubmission(record.key,'prepared','write_started');g.store.transitionSubmission(record.key,'write_started','unknown');g.manager.release(g.context.sessionId);
 const db=new Database(join(g.dir,'workroom-history-v1','history.sqlite'));const insert=db.query('INSERT INTO workroom_submissions VALUES(?,?,?,?,?)');db.transaction(()=>{for(let i=0;i<19999;i++){const value={...record,key:'fill-'+i,id:'filled-submission-'+i,state:'written'};insert.run(value.key,'written',value.bootId,value.targetId,JSON.stringify(value));}})();db.close();
 await expect(g.manager.perform(command('new request\r','budget-new-submission').begin,g.context,[],async()=>{})).rejects.toThrow('한도');expect(g.manager.status(receipt.id,g.context).receipt.state).toBe('unknown');
});
test('idle payload expires without another request while its durable receipt remains',async()=>{
 const f=fixture(),manager=new WorkroomSubmissions(()=>f.store,()=>performance.now(),10),c=command('expire body\r','idle-expiry-submission');
 const receipt=await manager.perform({...c.begin,firstData:Buffer.from(c.bytes).toString('base64')},f.context,[],async()=>{});expect(manager.usage()).toEqual({assemblies:1,bytes:c.bytes.length});await Bun.sleep(30);expect(manager.usage()).toEqual({assemblies:0,bytes:0});expect(manager.status(receipt.id,f.context).receipt.state).toBe('prepared');manager.close();
});
test('a reservation expiring during final validation never crosses the write boundary',async()=>{
 const f=fixture(),receipt=await upload(f,'expired before write\r');let writes=0;
 await expect(f.manager.perform({phase:'commit',id:receipt.id,epoch:receipt.epoch},f.context,[],async(_text,start)=>{f.advance(30001);start();writes++;})).rejects.toThrow('기간');expect(writes).toBe(0);expect(f.manager.status(receipt.id,f.context).receipt.state).toBe('prepared');
});
test('browser sender stops on a missing chunk acknowledgement and never falls back to raw input',async()=>{const f=fixture();let calls=0,prepared=false;await expect(submitWorkroomDraft({id:'browser-submission',sessionId:f.context.sessionId,text:'한글🙂'.repeat(700)+'\r',prepared:()=>{prepared=true;},request:async r=>{calls++;if(r.submission?.phase==='chunk')throw Error('network lost');return{submission:await f.manager.perform(r.submission!,f.context,[],async()=>{throw Error('unexpected write');})};}})).rejects.toThrow('network lost');expect(prepared).toBe(true);expect(calls).toBe(2);});
test('short and long browser submissions add no preparation round trips beyond payload chunks',async()=>{
 for(const text of ['short task\r','한글🙂.'.repeat(700)+'\r']){
  const f=fixture();let calls=0,writes=0;let received='';const result=await submitWorkroomDraft({id:'wire-count-submission',sessionId:f.context.sessionId,text,prepared:()=>{},request:async request=>{calls++;return{submission:await f.manager.perform(request.submission!,f.context,[],async(data,start)=>{start();writes++;received=data;})};}});
  expect(calls).toBe(Math.ceil(Buffer.byteLength(text)/4000));expect(result.state).toBe('written');expect(writes).toBe(1);expect(received).toBe(text);
 }
});
test('pending metadata survives reload without retaining text and refuses another receipt lineage',async()=>{const data=new Map<string,string>();const storage={get length(){return data.size;},key:(n:number)=>[...data.keys()][n]??null,getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);},clear:()=>data.clear()} as Storage;const f=fixture(),receipt=await upload(f,'private text\r');const key=pendingSubmissionKey('fixture-host',f.context.sessionId);writePendingSubmission(storage,key,{id:receipt.id,sessionId:f.context.sessionId,receipt});expect(readPendingSubmission(storage,key)?.receipt).toEqual(receipt);expect([...data.values()].join('')).not.toContain('private text');storage.setItem(key,JSON.stringify({id:'other-submission',sessionId:f.context.sessionId,receipt}));expect(()=>readPendingSubmission(storage,key)).toThrow();});
test('service keeps legacy wire stable, serializes complete submissions, refuses short writes and rechecks grants',async()=>{
 const f=fixture();let finish!: (code:number)=>void;let exit:()=>void=()=>{};let short=false;let guidance:CorrectionTaskGuidance|null=null;const writes:string[]=[];
 const service=new AiTerminalService({submissions:()=>f.store,corrections:async()=>guidance,headlessScreen:false,resolveTarget:async()=>({cwd:f.dir}),executable:()=>'/fixture/harmless',signalGroup:()=>{exit();finish(0);},spawn:(_args,options)=>{exit=(options.terminal as {exit():void}).exit;return{pid:999999999,exited:new Promise<number>(resolve=>{finish=resolve;}),kill:()=>{},terminal:{write:(text:string)=>{writes.push(text);return short?0:Buffer.byteLength(text);},resize:()=>{},close:()=>{exit();finish(0);}}};}});
 const perform=(r:Omit<AiTerminalRequest,'requestId'>)=>service.perform({...r,requestId:crypto.randomUUID()});
 try{
  expect(Object.keys(await perform({operation:'list'}))).toEqual(['sessions']);expect((await perform({operation:'list',capabilities:true})).features).toContain('terminal-submission-v1');
  const session=(await perform({operation:'start',targetId:f.context.targetId,agent:'hermes',cols:80,rows:24})).session!;
  let prepared:any;
  const receipt=await submitWorkroomDraft({id:'service-submission',sessionId:session.id,text:'한글🙂'.repeat(900)+'\r',request:perform,prepared:r=>{prepared=r;}});
  expect(receipt.state).toBe('written');expect(writes.join('')).toBe('한글🙂'.repeat(900)+'\r');
  const repeated=await perform({operation:'submission',sessionId:session.id,submission:{phase:'commit',id:receipt.id,epoch:prepared.epoch}});expect(repeated.submission?.state).toBe('written');expect(writes.length).toBe(2);
  await expect(submitWorkroomDraft({id:'unprepared-multiline',sessionId:session.id,text:'first line\nsecond line\r',request:perform,prepared:()=>{}})).rejects.toThrow('여러 줄');expect(writes.length).toBe(2);
  const memoryId='fixture-memory-identity';guidance={text:'Failure: old interpolation was unsafe.\nNext: quote literal input.',validate:()=>{},exposure:{memoryId,contextHash:'c'.repeat(64),sourceWithheld:false,entries:[{entryKey:'e'.repeat(24),contentVersionHash:'a'.repeat(32),reportIds:['fixture-report']}]} };
  service.setRemoteAccess('voice-owner',true);const voice={owner:'voice-owner',targets:new Set([f.context.targetId])};const revision=service.inspectSession(session.id,f.context.targetId).inputRevision;
  await service.submitReviewed('reviewed-task-once',session.id,'approved task\r',revision,voice);const writeCount=writes.length;
  expect(writes.at(-2)).toContain('quote literal input');expect(writes.at(-2)).not.toContain('\n');expect(f.store.correctionTaskSummary(f.context.targetId,memoryId)).toMatchObject({delivered:1,awaitingIndependentOutcome:1,efficacyVerified:false});
  await service.submitReviewed('reviewed-task-once',session.id,'approved task\r',revision,voice);expect(writes.length).toBe(writeCount);await expect(service.submitReviewed('reviewed-task-once',session.id,'changed task\r',revision,voice)).rejects.toThrow('변경');
  guidance={...guidance,validate:()=>{throw Error('stale correction');}};await expect(submitWorkroomDraft({id:'stale-correction',sessionId:session.id,text:'new task\r',request:perform,prepared:()=>{}})).rejects.toThrow('stale correction');expect(writes.length).toBe(writeCount);guidance=null;
  const enters=writes.filter(x=>x==='\r').length;short=true;const failure=await submitWorkroomDraft({id:'short-submission',sessionId:session.id,text:'do not replay\r',request:perform,prepared:()=>{}});expect(failure.state).toBe('unknown');expect(writes.at(-1)).toBe('do not replay');expect(writes.filter(x=>x==='\r')).toHaveLength(enters);
  service.setRemoteAccess('device-owner',true);let active=true;const authority={owner:'device-owner',targets:new Set([f.context.targetId]),isActive:()=>active};
  const remote=async(r:Omit<AiTerminalRequest,'requestId'>)=>service.perform({...r,requestId:crypto.randomUUID()},authority);
  const initial=command('revoked\r','revoked-submission');const begin=(await remote({operation:'submission',sessionId:session.id,submission:initial.begin})).submission!;
  await remote({operation:'submission',sessionId:session.id,submission:{phase:'chunk',id:begin.id,epoch:begin.epoch,index:0,data:Buffer.from(initial.bytes).toString('base64')}});active=false;
  await expect(remote({operation:'submission',sessionId:session.id,submission:{phase:'commit',id:begin.id,epoch:begin.epoch}})).rejects.toThrow();expect(writes.join('')).not.toContain('revoked');
 }finally{await service.shutdown();}
});
test('prepared rows from an earlier boot age into rejected; written, unknown and recent rows are left alone',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'submission-aging-'));chmodSync(dir,0o700);dirs.push(dir);
 let clock=Date.parse('2026-10-01T00:00:00Z');const now=()=>new Date(clock).toISOString();
 const first=new WorkroomConversationJournal(dir,now,'00000000-0000-4000-8000-000000000001');const manager=new WorkroomSubmissions(()=>first);managers.push(manager);
 const context={owner:'fixture-owner',sessionId:'fixture-session',targetId:'fixture-project',binding:'a'.repeat(64),revision:0};
 const begin=async(id:string)=>manager.perform(command('aging body\r',id).begin,{...context,sessionId:id+'-session'},[],async()=>{throw Error('unexpected write');});
 await begin('old-prepared-submission');const stuck=await begin('old-unknown-submission');
 const key=(id:string)=>manager.status(id,{...context,sessionId:id+'-session'}).record.key;
 first.transitionSubmission(key(stuck.id),'prepared','write_started');first.transitionSubmission(key(stuck.id),'write_started','unknown');
 clock+=6*24*3600_000;await begin('recent-prepared-submission');manager.close();first.close();
 clock+=2*24*3600_000;
 const reopened=new WorkroomConversationJournal(dir,now,'00000000-0000-4000-8000-000000000002');stores.push(reopened);const after=new WorkroomSubmissions(()=>reopened);managers.push(after);
 const state=(id:string)=>after.status(id,{...context,sessionId:id+'-session'}).receipt.state;
 expect(state('old-prepared-submission')).toBe('rejected');expect(state('old-unknown-submission')).toBe('unknown');expect(state('recent-prepared-submission')).toBe('held');
 // Still a dedupe record: the same id is answered from it and nothing is written.
 const c=command('aging body\r','old-prepared-submission');let writes=0;
 expect((await after.perform({phase:'single',id:c.begin.id,bytes:c.bytes.length,digest:c.begin.digest,data:Buffer.from(c.bytes).toString('base64')},{...context,sessionId:'old-prepared-submission-session'},[],async()=>{writes++;})).state).toBe('rejected');
 expect(writes).toBe(0);
});
test('rejected rows stay as dedupe records but stop holding the open-record budget; the table stays bounded',async()=>{
 const f=fixture(),receipt=await upload(f,'seed\r'),record=f.manager.status(receipt.id,f.context).record;f.manager.release(f.context.sessionId);
 const fill=(from:number,count:number)=>{const db=new Database(join(f.dir,'workroom-history-v1','history.sqlite'));const insert=db.query('INSERT INTO workroom_submissions VALUES(?,?,?,?,?)');db.transaction(()=>{for(let i=from;i<from+count;i++){const value={...record,key:'aged-'+i,id:'aged-submission-'+i,state:'rejected'};insert.run(value.key,'rejected',value.bootId,value.targetId,JSON.stringify(value));}})();db.close();};
 // 20,000 aged (rejected) rows: an open question no longer, so a new request still gets a slot.
 fill(0,20_000);
 expect((await f.manager.perform(command('after aging\r','after-aging-submission').begin,{...f.context,sessionId:'after-aging-session'},[],async()=>{})).state).toBe('prepared');
 // The whole table still has a ceiling, so rejected rows cannot grow without bound.
 fill(20_000,20_000);
 await expect(f.manager.perform(command('over ceiling\r','over-ceiling-submission').begin,{...f.context,sessionId:'over-ceiling-session'},[],async()=>{})).rejects.toThrow('한도');
});
test('write_started and written stamp metadata times and relatedness counts without payload text',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'submission-stamp-'));chmodSync(dir,0o700);dirs.push(dir);
 let clock=Date.parse('2026-10-15T01:00:00.000Z');const store=new WorkroomConversationJournal(dir,()=>new Date(clock).toISOString());stores.push(store);
 const manager=new WorkroomSubmissions(()=>store);managers.push(manager);
 const context={owner:'fixture-owner',sessionId:'fixture-session',targetId:'fixture-project',binding:'a'.repeat(64),revision:0};
 const text='PRIVATE_SYNTHETIC_COMMAND_never_store\r',c=command(text);
 const r=await manager.perform({...c.begin,firstData:Buffer.from(c.bytes).toString('base64')},context,[],async()=>{});
 const exposure={memoryId:'m'.repeat(36),contextHash:'c'.repeat(64),sourceWithheld:false,protocolVersion:1,entries:[{entryKey:'e'.repeat(24),contentVersionHash:'a'.repeat(32),reportIds:['r'.repeat(64)],relatedness:{queryTerms:4,matchedTerms:3,evidenceMatchedTerms:2}}]};
 clock+=1000;
 const done=await manager.perform({phase:'commit',id:r.id,epoch:r.epoch},context,[],async(_t,start)=>{start(exposure);clock+=500;});
 expect(done.state).toBe('written');
 const record=manager.status(r.id,context).record;
 expect(record.startedAt).toBe('2026-10-15T01:00:01.000Z');expect(record.writtenAt).toBe('2026-10-15T01:00:01.500Z');
 expect(record.exposure?.entries[0]?.relatedness).toEqual({queryTerms:4,matchedTerms:3,evidenceMatchedTerms:2});
 expect(readFileSync(join(dir,'workroom-history-v1','history.sqlite')).includes(Buffer.from(text.slice(0,-1)))).toBe(false);
 const units=store.correctionExposureUnits(0,256);
 expect(units).toHaveLength(1);
 expect(units[0]).toMatchObject({key:record.key,state:'written',targetId:'fixture-project',sessionId:'fixture-session',writtenAt:'2026-10-15T01:00:01.500Z'});
 expect(Object.keys(units[0]!).sort()).toEqual(['exposure','key','rowid','sessionId','startedAt','state','targetId','writtenAt']);
 expect(store.correctionExposureUnits(units[0]!.rowid,256)).toEqual([]);
 expect(()=>store.correctionExposureUnits(0,257)).toThrow();
});
test('a stamped v2 record is still readable by the unchanged v2 reader and the status receipt keeps five keys',async()=>{
 const f=fixture(),r=await upload(f,'stamped\r');
 const receipt=await f.manager.perform({phase:'commit',id:r.id,epoch:r.epoch},f.context,[],async(_t,start)=>{start();});
 expect(Object.keys(receipt).sort()).toEqual(['epoch','id','revision','state','storeId']);
 expect(normalizeSubmissionReceipt(receipt)).toEqual(receipt);
 const path=join(f.dir,'workroom-history-v1','history.sqlite');f.store.close();
 const db=new Database(path,{readonly:true});
 // The v791 reader reads only the key, the state column and the body JSON; the stamps ride inside the body.
 expect((db.query('SELECT version FROM workroom_meta').get() as {version:number}).version).toBe(2);
 expect(db.query('PRAGMA table_info(workroom_submissions)').all().map((c:any)=>c.name)).toEqual(['key','state','boot_id','target_id','body']);
 const row=db.query('SELECT state,body FROM workroom_submissions').get() as {state:string;body:string};db.close();
 const body=JSON.parse(row.body);expect(row.state).toBe('written');expect(typeof body.startedAt).toBe('string');expect(typeof body.writtenAt).toBe('string');
});
test('an exposure with three corrections and relatedness stays under the 4096-byte journal cap',async()=>{
 const f=fixture(),r=await upload(f,'worst case\r');
 const entries=Array.from({length:3},(_,i)=>({entryKey:String(i).repeat(24),contentVersionHash:String(i).repeat(32),reportIds:[0,1,2].map(j=>String(j).repeat(64)),relatedness:{queryTerms:24,matchedTerms:24,evidenceMatchedTerms:24}}));
 const exposure={memoryId:'9'.repeat(160),contextHash:'c'.repeat(64),sourceWithheld:false,protocolVersion:1,entries};
 const done=await f.manager.perform({phase:'commit',id:r.id,epoch:r.epoch},{...f.context},[],async(_t,start)=>{start(exposure);});
 expect(done.state).toBe('written');
 const db=new Database(join(f.dir,'workroom-history-v1','history.sqlite'),{readonly:true});
 const row=db.query('SELECT body FROM workroom_submissions').get() as {body:string};db.close();
 expect(row.body.length).toBeLessThan(4096);expect(JSON.parse(row.body).writtenAt).toBeTruthy();
});
test('reboot reconciliation keeps startedAt on unknown records',async()=>{
 const f=fixture(),r=await upload(f,'reboot\r');const key=f.manager.status(r.id,f.context).record.key;
 f.store.transitionSubmission(key,'prepared','write_started');f.store.close();
 const reopened=new WorkroomConversationJournal(f.dir);stores.push(reopened);
 const record=reopened.submission(key)!;
 expect(record.state).toBe('unknown');expect(typeof record.startedAt).toBe('string');expect(record.writtenAt).toBeUndefined();
});
