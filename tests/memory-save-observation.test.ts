import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,appendFileSync,truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {observeCompletedMemoryTranscript,MEMORY_OBSERVATION_MAX_BYTES,CompletedMemoryTurnReader,type MemoryObservationBinding} from '../src/memorySaveObservation';
import {MemorySaveStore} from '../src/memorySaveStore';
import {Database} from 'bun:sqlite';

const roots:string[]=[];
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const time='2026-09-07T15:20:00.000Z';
function fixture(agent:'claude'|'codex'='codex') {
 const root=mkdtempSync(join(tmpdir(),'memory-observer-'));roots.push(root);
 const cwd=join(root,'project');mkdirSync(cwd);
 const transcriptRoot=join(root,'transcripts');mkdirSync(transcriptRoot);
 const path=join(transcriptRoot,'session.jsonl');
 const binding:MemoryObservationBinding={agent,instanceId:'host-1',sessionId:'session-1',cwd,memoryId:'memory-1',policyEpoch:1};
 const store=new MemorySaveStore(join(root,'observations.sqlite'));
 return {root,cwd,path,transcriptRoot,binding,store,validateRegistration:async()=>true};
}
const line=(row:unknown)=>JSON.stringify(row)+'\n';
function codex(f:ReturnType<typeof fixture>,turn='turn-1') {
 return [
 {type:'session_meta',payload:{id:'session-1',cwd:f.cwd,source:'cli'}},
 {type:'event_msg',timestamp:time,payload:{type:'task_started',turn_id:turn}},
 {type:'turn_context',payload:{cwd:f.cwd,turn_id:turn}},
 {type:'event_msg',timestamp:time,payload:{type:'item_completed',item:{type:'UserMessage',content:[{type:'text',text:'한글 이야기 🙂'}]}}},
 {type:'event_msg',timestamp:time,payload:{type:'item_completed',item:{type:'AgentMessage',content:[{type:'Text',text:'answer'}]}}},
 {type:'event_msg',timestamp:time,payload:{type:'task_complete',turn_id:turn}},
 ];
}
function claude(f:ReturnType<typeof fixture>) {
 const base={sessionId:'session-1',cwd:f.cwd,isSidechain:false,timestamp:time};
 return [
 {...base,type:'user',uuid:'user-1',parentUuid:'previous',message:{role:'user',content:'한글 이야기 🙂'}},
 {...base,type:'assistant',uuid:'assistant-1',parentUuid:'user-1',message:{role:'assistant',content:[{type:'text',text:'answer'}],stop_reason:'end_turn'}},
 ];
}
function write(f:ReturnType<typeof fixture>,rows:unknown[]) {writeFileSync(f.path,rows.map(line).join(''));}

test('new Codex item events require matching task completion and persist exact UTF-8 record coverage',async()=>{
 const f=fixture();const rows=codex(f);write(f,rows);
 const result=await observeCompletedMemoryTranscript(f);
 expect(result).toEqual({observed:1,complete:true,reason:'observed'});
 const db=new Database(f.store.path);
 const row=db.query('SELECT payload FROM save_sources').get() as {payload:string};db.close();
 const source=JSON.parse(row.payload);const bytes=readFileSync(f.path);const start=Buffer.byteLength(line(rows[0]));
 expect(source.startByte).toBe(start);expect(source.endByte).toBe(bytes.length);
 expect(source.sourceDigest).toBe(createHash('sha256').update(bytes.subarray(start)).digest('hex'));
 expect(source.coverageKind).toBe('complete-turn');
 expect(await observeCompletedMemoryTranscript(f)).toEqual(result);
 expect(f.store.pending('memory-1',1).items).toHaveLength(1);
 expect(readFileSync(f.store.path).toString()).not.toContain('한글 이야기');
 expect(f.store.page().items).toHaveLength(0);
});

test('Claude end_turn must descend from an owned human message',async()=>{
 const f=fixture('claude');write(f,claude(f));
 expect((await observeCompletedMemoryTranscript(f)).observed).toBe(1);
 const rows=claude(f);rows[1]!.parentUuid='another-branch';write(f,rows);
 expect((await observeCompletedMemoryTranscript(f)).reason).toBe('source-invalid');
});

test('Claude tool-use and tool-result chain remains one human turn',async()=>{
 const f=fixture('claude');const rows=claude(f);
 const base={sessionId:'session-1',cwd:f.cwd,isSidechain:false,timestamp:time};
 write(f,[rows[0],{...base,type:'assistant',uuid:'tool-call',parentUuid:'user-1',message:{role:'assistant',stop_reason:'tool_use',content:[]}},
 {...base,type:'user',uuid:'tool-result',parentUuid:'tool-call',message:{role:'user',content:[{type:'tool_result',content:'result'}]}},
 {...rows[1],parentUuid:'tool-result'}]);
 expect((await observeCompletedMemoryTranscript(f)).observed).toBe(1);
});

test('Claude attachment ancestry is owned and links the human turn to its final answer',async()=>{
 const f=fixture('claude');const rows=claude(f);
 const attachment={type:'attachment',uuid:'attachment-1',parentUuid:'user-1',sessionId:'session-1',cwd:f.cwd,isSidechain:false,timestamp:time};
 write(f,[rows[0],attachment,{type:'mode',sessionId:'session-1'}, {...rows[1],parentUuid:'attachment-1'}]);
 expect((await observeCompletedMemoryTranscript(f)).observed).toBe(1);
 write(f,[rows[0],{...attachment,cwd:f.root},{...rows[1],parentUuid:'attachment-1'}]);
 expect((await observeCompletedMemoryTranscript(f)).reason).toBe('source-invalid');
});

test('assistant item completion, tool stop and partial EOF never fabricate a completed turn',async()=>{
 const f=fixture();write(f,codex(f).slice(0,-1));
 expect(await observeCompletedMemoryTranscript(f)).toEqual({observed:0,complete:false,reason:'incomplete'});
 appendFileSync(f.path,line(codex(f).at(-1)).trimEnd());
 expect((await observeCompletedMemoryTranscript(f)).observed).toBe(0);
 appendFileSync(f.path,'\n');expect((await observeCompletedMemoryTranscript(f)).observed).toBe(1);
 const c=fixture('claude');const rows=claude(c);rows[1]!.message.stop_reason='tool_use';write(c,rows);
 expect((await observeCompletedMemoryTranscript(c)).observed).toBe(0);
});

test('mismatched completion IDs, session identity, cwd and subagents are rejected',async()=>{
 for(const change of ['turn','session','cwd','subagent','context']){
  const f=fixture();const rows:any[]=codex(f);
  if(change==='turn')rows.at(-1).payload.turn_id='foreign';
  if(change==='session')rows[0].payload.id='foreign';
  if(change==='cwd')rows[0].payload.cwd=f.root;
  if(change==='subagent')rows[0].payload.source={subagent:'review'};
  if(change==='context')rows[2].payload.cwd=f.root;
  write(f,rows);expect((await observeCompletedMemoryTranscript(f)).reason).toBe('source-invalid');
  expect(f.store.pending('memory-1',1).items).toHaveLength(0);
 }
 const c=fixture('claude');const rows=claude(c);rows[1]!.isSidechain=true;write(c,rows);
 expect((await observeCompletedMemoryTranscript(c)).reason).toBe('source-invalid');
});

test('malformed JSON and invalid UTF-8 invalidate all staged observations',async()=>{
 for(const bad of [Buffer.from('{broken}\n'),Buffer.from([0xff,10])]){
  const f=fixture();write(f,codex(f));appendFileSync(f.path,bad);
  expect((await observeCompletedMemoryTranscript(f)).reason).toBe('source-invalid');
  expect(f.store.pending('memory-1',1).items).toHaveLength(0);
 }
});

test('fresh registration proof is checked before reading and after the bounded snapshot',async()=>{
 const f=fixture();write(f,codex(f));let count=0;
 expect((await observeCompletedMemoryTranscript({...f,validateRegistration:async()=>++count===1})).reason).toBe('registration-changed');
 expect(count).toBe(2);expect(f.store.pending('memory-1',1).items).toHaveLength(0);
 expect((await observeCompletedMemoryTranscript({...f,validateRegistration:async()=>false})).reason).toBe('registration-changed');
});

test('source changes during registration revalidation discard the staged receipt',async()=>{
 const f=fixture();write(f,codex(f));let count=0;
 const result=await observeCompletedMemoryTranscript({...f,validateRegistration:async()=>{
  if(++count===2)appendFileSync(f.path,'{}\n');return true;
 }});
 expect(result.reason).toBe('source-changed');
 expect(f.store.pending('memory-1',1).items).toHaveLength(0);
});

test('symlinks, outside discovery roots and excessive source size do not create observations',async()=>{
 const f=fixture();write(f,codex(f));const link=join(f.transcriptRoot,'link.jsonl');symlinkSync(f.path,link);
 expect((await observeCompletedMemoryTranscript({...f,path:link})).observed).toBe(0);
 expect((await observeCompletedMemoryTranscript({...f,transcriptRoot:f.cwd})).reason).toBe('source-invalid');
 truncateSync(f.path,MEMORY_OBSERVATION_MAX_BYTES+1);
 expect((await observeCompletedMemoryTranscript(f)).reason).toBe('source-oversized');
 expect(f.store.pending('memory-1',1).items).toHaveLength(0);
});

test('record gaps and missing final newline are rejected by the sequential adapter',()=>{
 const f=fixture();const r=new CompletedMemoryTurnReader(f.binding);
 r.record(Buffer.from(line(codex(f)[0])),1);expect(r.invalid).toBe(true);
 const other=new CompletedMemoryTurnReader(f.binding);
 other.record(Buffer.from(line(codex(f)[0]).trimEnd()),0);expect(other.invalid).toBe(true);
});

test('completed turns remain pending separately while a later turn is still running',async()=>{
 const f=fixture();write(f,[...codex(f),...codex(f,'turn-2').slice(1,-1)]);
 expect(await observeCompletedMemoryTranscript(f)).toEqual({observed:1,complete:false,reason:'incomplete'});
 expect(f.store.pending('memory-1',1).items).toHaveLength(1);
});

test('same completed turn shifted to another byte range cannot create a second observation',async()=>{
 const f=fixture();write(f,codex(f));await observeCompletedMemoryTranscript(f);
 const rows=codex(f);rows.splice(1,0,{type:'metadata',payload:{padding:'x'.repeat(2000)}} as any);write(f,rows);
 await expect(observeCompletedMemoryTranscript(f)).rejects.toThrow('SOURCE_CONFLICT');
});
