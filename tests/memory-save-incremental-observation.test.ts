import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,appendFileSync,rmSync,renameSync,symlinkSync,utimesSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Database} from 'bun:sqlite';
import {MemorySaveError} from '../src/memorySaveContract';
import {MemorySaveStore} from '../src/memorySaveStore';
import {MemoryObservationCursorStore} from '../src/memoryObservationCursorStore';
import {observeIncrementalMemoryTranscript} from '../src/memorySaveIncrementalObservation';
import type {MemoryObservationBinding} from '../src/memorySaveObservation';

const roots:string[]=[];
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const stamp='2026-09-07T15:00:00Z';
const json=(v:unknown)=>JSON.stringify(v)+'\n';
function fixture(agent:'codex'|'claude'='codex'){
 const root=mkdtempSync(join(tmpdir(),'memory-cursor-'));roots.push(root);
 const cwd=join(root,'project');mkdirSync(cwd);const transcriptRoot=join(root,'transcripts');mkdirSync(transcriptRoot);
 const path=join(transcriptRoot,'session.jsonl');
 const binding:MemoryObservationBinding={agent,instanceId:'host',sessionId:'session',cwd,memoryId:'memory',policyEpoch:1};
 return {root,cwd,path,transcriptRoot,binding,store:new MemorySaveStore(join(root,'sources.sqlite')),
  cursors:new MemoryObservationCursorStore(join(root,'cursors.sqlite')),validateRegistration:async()=>true};
}
function head(f:ReturnType<typeof fixture>){return json(f.binding.agent==='codex'?{type:'session_meta',payload:{id:'session',source:'cli',cwd:f.cwd}}:{type:'mode',sessionId:'session'});}
function turn(f:ReturnType<typeof fixture>,id:number,padding=0){
 if(f.binding.agent==='claude')return json({type:'user',uuid:`user-${id}`,parentUuid:'old',cwd:f.cwd,sessionId:'session',timestamp:stamp,message:{role:'user',content:'한글🙂'+'.'.repeat(padding)}})
  +json({type:'assistant',uuid:`assistant-${id}`,parentUuid:`user-${id}`,cwd:f.cwd,sessionId:'session',timestamp:stamp,message:{role:'assistant',content:'response',stop_reason:'end_turn'}});
 return json({type:'event_msg',timestamp:stamp,payload:{type:'task_started',turn_id:`turn-${id}`}})
  +json({type:'event_msg',timestamp:stamp,payload:{type:'item_completed',item:{type:'UserMessage',content:[{type:'text',text:'한글🙂'+'.'.repeat(padding)}]}}})
  +json({type:'event_msg',timestamp:stamp,payload:{type:'task_complete',turn_id:`turn-${id}`}});
}
function count(f:ReturnType<typeof fixture>){f.store.pending('memory',1);const db=new Database(f.store.path);try{return (db.query('SELECT COUNT(*) AS n FROM save_sources').get() as {n:number}).n;}finally{db.close();}}
function cursor(f:ReturnType<typeof fixture>){const db=new Database(f.cursors.path);try{return db.query('SELECT key,revision,payload FROM cursors').get() as {key:string;revision:number;payload:string}|null;}finally{db.close();}}

test('more than 128 completed turns resume across reopened stores without losing or repeating coverage',async()=>{
 const f=fixture();writeFileSync(f.path,head(f)+Array.from({length:300},(_,i)=>turn(f,i)).join(''));
 const a=await observeIncrementalMemoryTranscript(f);expect(a.observed).toBe(128);expect(a.reason).toBe('more');
 const b=await observeIncrementalMemoryTranscript({...f,cursors:new MemoryObservationCursorStore(f.cursors.path),store:new MemorySaveStore(f.store.path)});
 expect(b.observed).toBe(128);expect(b.offset).toBeGreaterThan(a.offset);
 const c=await observeIncrementalMemoryTranscript(f);expect(c.observed).toBe(44);expect(c.reason).toBe('observed');
 const unchanged=await observeIncrementalMemoryTranscript(f);expect(unchanged.observed).toBe(0);expect(unchanged.bytesRead).toBeLessThanOrEqual(8192);
 expect(count(f)).toBe(300);expect(f.store.page().items).toHaveLength(0);
});

test('histories larger than eight MiB progress in bounded slices while the event loop remains live',async()=>{
 const f=fixture();writeFileSync(f.path,head(f)+Array.from({length:200},(_,i)=>turn(f,i,48*1024)).join(''));
 let ticks=0;const timer=setInterval(()=>ticks++,0);const samples:number[]=[];
 try{
  for(let i=0;i<8;i++){
   const result=await observeIncrementalMemoryTranscript({...f,maxBytes:2*1024*1024});samples.push(result.bytesRead);
   expect(result.bytesRead).toBeLessThanOrEqual(2*1024*1024);
   if(result.reason==='observed')break;expect(result.reason).toBe('more');
  }
 }finally{clearInterval(timer);}
 expect(samples.length).toBeGreaterThan(1);expect(count(f)).toBe(200);expect(ticks).toBeGreaterThan(0);
});

test('Claude resumes after end_turn and does not discard a split UTF-8 tail',async()=>{
 const f=fixture('claude');const first=head(f)+turn(f,1);writeFileSync(f.path,first);
 await observeIncrementalMemoryTranscript(f);
 const bytes=Buffer.from(turn(f,2));const cut=bytes.indexOf(Buffer.from('🙂'))+2;
 appendFileSync(f.path,bytes.subarray(0,cut));
 const partial=await observeIncrementalMemoryTranscript(f);expect(partial.observed).toBe(0);expect(partial.reason).toBe('incomplete');
 expect(partial.offset).toBe(Buffer.byteLength(first));
 appendFileSync(f.path,bytes.subarray(cut));
 const final=await observeIncrementalMemoryTranscript(f);expect(final.observed).toBe(1);expect(final.reason).toBe('observed');expect(count(f)).toBe(2);
});

test('source replacement resets progress but preserves already observed turn identities',async()=>{
 const f=fixture();const first=head(f)+turn(f,1);writeFileSync(f.path,first);await observeIncrementalMemoryTranscript(f);
 const replacement=join(f.transcriptRoot,'replacement');writeFileSync(replacement,first+turn(f,2));renameSync(replacement,f.path);
 const result=await observeIncrementalMemoryTranscript(f);expect(result.reset).toBe(true);expect(result.reason).toBe('observed');expect(count(f)).toBe(2);
});

test('truncation and header changes invalidate the cursor without deleting old observations',async()=>{
 const f=fixture();const first=head(f)+turn(f,1);writeFileSync(f.path,first+turn(f,2));await observeIncrementalMemoryTranscript(f);
 writeFileSync(f.path,first);const shorter=await observeIncrementalMemoryTranscript(f);expect(shorter.reset).toBe(true);expect(shorter.reason).toBe('observed');expect(count(f)).toBe(2);
 // Keep line length and turn ranges stable; owner validation must still run after a reset.
 const bad=first.replace('"id":"session"','"id":"foreign"');writeFileSync(f.path,bad);
 const invalid=await observeIncrementalMemoryTranscript(f);expect(invalid.reset).toBe(true);expect(invalid.reason).toBe('source-invalid');expect(count(f)).toBe(2);
});

test('a changed checkpoint anchor is not trusted even when the source also grows',async()=>{
 const f=fixture();const original=head(f)+turn(f,1);writeFileSync(f.path,original);await observeIncrementalMemoryTranscript(f);
 const altered=original.replace('"turn_id":"turn-1"','"turn_id":"other1"');writeFileSync(f.path,altered+turn(f,2));
 const result=await observeIncrementalMemoryTranscript(f);expect(result.reset).toBe(true);expect(result.reason).toBe('source-invalid');expect(count(f)).toBe(1);
});

test('crash after observations but before cursor advancement replays idempotently without scheduling AI',async()=>{
 const f=fixture();writeFileSync(f.path,head(f)+turn(f,1));const script=join(f.root,'crash.ts');
 writeFileSync(script,`import {observeIncrementalMemoryTranscript} from ${JSON.stringify(resolve(import.meta.dir,'../src/memorySaveIncrementalObservation'))};
import {MemorySaveStore} from ${JSON.stringify(resolve(import.meta.dir,'../src/memorySaveStore'))};
import {MemoryObservationCursorStore} from ${JSON.stringify(resolve(import.meta.dir,'../src/memoryObservationCursorStore'))};
const real=new MemoryObservationCursorStore(${JSON.stringify(f.cursors.path)});
await observeIncrementalMemoryTranscript({path:${JSON.stringify(f.path)},transcriptRoot:${JSON.stringify(f.transcriptRoot)},binding:${JSON.stringify(f.binding)},validateRegistration:async()=>true,
store:new MemorySaveStore(${JSON.stringify(f.store.path)}),cursors:{get:key=>real.get(key),advance:()=>process.kill(process.pid,'SIGKILL')}});`);
 const child=Bun.spawnSync({cmd:[process.execPath,script],stdout:'pipe',stderr:'pipe'});expect(child.exitCode).not.toBe(0);
 expect(count(f)).toBe(1);expect(cursor(f)).toBeNull();
 const recovered=await observeIncrementalMemoryTranscript(f);
 expect(recovered.reason).toBe('observed');expect(count(f)).toBe(1);expect(cursor(f)).not.toBeNull();
 expect(f.store.page().items).toHaveLength(0);
});

test('partial observation admission failure never advances the cursor past the missing record',async()=>{
 const f=fixture();writeFileSync(f.path,head(f)+turn(f,1)+turn(f,2));let writes=0;
 await expect(observeIncrementalMemoryTranscript({...f,store:{observe:source=>{
  if(++writes===2)throw new MemorySaveError('STORAGE_UNAVAILABLE');return f.store.observe(source);
 }}})).rejects.toThrow('STORAGE_UNAVAILABLE');
 expect(count(f)).toBe(1);expect(cursor(f)).toBeNull();
 expect((await observeIncrementalMemoryTranscript(f)).reason).toBe('observed');expect(count(f)).toBe(2);
});

test('concurrent readers retain one cursor revision and the same observed coverage',async()=>{
 const f=fixture();writeFileSync(f.path,head(f)+turn(f,1));let waiting=0;
 let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
 const run=()=>{let checks=0;return observeIncrementalMemoryTranscript({...f,validateRegistration:async()=>{
  if(++checks===2){if(++waiting===2)release();await barrier;}return true;
 }});};
 const results=await Promise.allSettled([run(),run()]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
 expect(rejected.reason.code).toBe('REVISION_CONFLICT');
 expect(cursor(f)!.revision).toBe(1);expect(count(f)).toBe(1);expect(f.store.page().items).toHaveLength(0);
});

test('same-size timestamp changes trigger revalidation instead of trusting the old cursor',async()=>{
 const f=fixture();writeFileSync(f.path,head(f)+turn(f,1));await observeIncrementalMemoryTranscript(f);
 const future=new Date(Date.now()+60000);utimesSync(f.path,future,future);
 const result=await observeIncrementalMemoryTranscript(f);expect(result.reset).toBe(true);expect(result.reason).toBe('observed');expect(count(f)).toBe(1);
});

test('failed cursor commit and stale revision preserve durable observations and the newer cursor',async()=>{
 const f=fixture();writeFileSync(f.path,head(f)+turn(f,1));
 await expect(observeIncrementalMemoryTranscript({...f,cursors:{get:key=>f.cursors.get(key),advance:()=>{throw new Error('injected interruption');}}})).resolves.toMatchObject({reason:'unavailable'});
 expect(count(f)).toBe(1);expect(cursor(f)).toBeNull();
 await observeIncrementalMemoryTranscript(f);const first=cursor(f)!;
 appendFileSync(f.path,turn(f,2));await observeIncrementalMemoryTranscript(f);const second=cursor(f)!;
 expect(()=>f.cursors.advance(first.key,first.revision,JSON.parse(first.payload))).toThrow('REVISION_CONFLICT');
 expect(cursor(f)!.revision).toBe(second.revision);expect(count(f)).toBe(2);
});

test('registration or source changes during the slice do not move the cursor',async()=>{
 for(const change of ['registration','source']){
  const f=fixture();writeFileSync(f.path,head(f)+turn(f,1));let checks=0;
  const result=await observeIncrementalMemoryTranscript({...f,validateRegistration:async()=>{
   if(++checks===2){if(change==='registration')return false;appendFileSync(f.path,'{}\n');}return true;
  }});
  expect(result.reason).toBe(change==='registration'?'registration-changed':'source-changed');
  expect(cursor(f)).toBeNull();expect(f.store.pending('memory',1).items).toHaveLength(0);
 }
});

test('an individual oversized open turn is retained instead of advancing past unread coverage',async()=>{
 const f=fixture();writeFileSync(f.path,head(f)+turn(f,1,2*1024*1024));
 const first=await observeIncrementalMemoryTranscript({...f,maxBytes:512*1024});expect(first.reason).toBe('more');
 const second=await observeIncrementalMemoryTranscript({...f,maxBytes:512*1024});expect(second.reason).toBe('source-oversized');
 expect(second.offset).toBe(first.offset);expect(count(f)).toBe(0);
});

test('future cursor schema, symlink database and oversized cursor payload fail closed',async()=>{
 const f=fixture();writeFileSync(f.path,head(f)+turn(f,1));await observeIncrementalMemoryTranscript(f);const current=cursor(f)!;
 const db=new Database(f.cursors.path);db.query('UPDATE cursors SET payload=?').run('x'.repeat(5000));
 expect(()=>f.cursors.get(current.key)).toThrow('STORAGE_UNAVAILABLE');
 db.run('PRAGMA user_version=2');db.close();const before=readFileSync(f.cursors.path);
 expect(()=>f.cursors.get(current.key)).toThrow('UNSUPPORTED_VERSION');expect(readFileSync(f.cursors.path).equals(before)).toBe(true);
 const link=join(f.root,'linked.sqlite');symlinkSync(f.cursors.path,link);expect(()=>new MemoryObservationCursorStore(link).get(current.key)).toThrow('STORAGE_UNAVAILABLE');
});
