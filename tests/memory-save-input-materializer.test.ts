import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,rmSync,appendFileSync,symlinkSync,linkSync,truncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {CompletedMemoryTurnReader,type MemoryObservationBinding} from '../src/memorySaveObservation';
import {materializeMemorySaveInput,type MemoryInputSource} from '../src/memorySaveInputMaterializer';
import {MemorySaveStore} from '../src/memorySaveStore';
import {MemorySaveInputStore} from '../src/memorySaveInputStore';
import {memorySaveSourceKey,saveDigest} from '../src/memorySaveContract';
import {acquireWorkspaceDirectoryLease,type WorkspaceLease} from '../src/workspaceLease';
const roots:string[]=[],leases:WorkspaceLease[]=[];afterEach(()=>{for(const l of leases.splice(0))l.release();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const time='2026-09-07T15:20:00.000Z',line=(row:unknown)=>Buffer.from(JSON.stringify(row)+'\n');
function fixture(agent:'codex'|'claude'='codex',text='전체 한글 대화 🙂',padding=0){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'materialize-memory-')));roots.push(root);const cwd=join(root,'project'),transcriptRoot=join(root,'transcripts');mkdirSync(cwd);mkdirSync(transcriptRoot);
 const path=join(transcriptRoot,'session.jsonl'),binding:MemoryObservationBinding={agent,instanceId:'host',sessionId:'session-'+agent,cwd,memoryId:'memory',policyEpoch:1};
 const base={sessionId:binding.sessionId,cwd,isSidechain:false,timestamp:time};
 const rows:any[]=agent==='codex'?[
  {type:'session_meta',payload:{id:binding.sessionId,cwd,source:'cli'}},
  ...(padding?[{type:'history-metadata',value:'x'.repeat(padding)}]:[]),
  {type:'event_msg',timestamp:time,payload:{type:'task_started',turn_id:'turn-codex'}},
  {type:'turn_context',payload:{cwd,turn_id:'turn-codex'}},
  {type:'event_msg',timestamp:time,payload:{type:'item_completed',item:{type:'UserMessage',content:[{type:'text',text}]}}},
  {type:'event_msg',timestamp:time,payload:{type:'agent_message',message:'Verified answer'}},
  {type:'event_msg',timestamp:time,payload:{type:'task_complete',turn_id:'turn-codex'}},
 ]:[
  {...base,type:'user',uuid:'user-claude',parentUuid:'previous',message:{role:'user',content:text}},
  {...base,type:'attachment',uuid:'attachment',parentUuid:'user-claude',attachment:{fixture:'retained'}},
  {...base,type:'assistant',uuid:'answer',parentUuid:'attachment',message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'Verified answer'}]}},
 ];
 const reader=new CompletedMemoryTurnReader(binding);let offset=0;for(const row of rows){const b=line(row);reader.record(b,offset);offset+=b.length;}
 expect(reader.invalid).toBe(false);expect(reader.sources).toHaveLength(1);writeFileSync(path,Buffer.concat(rows.map(line)));
 const item:MemoryInputSource={source:reader.sources[0]!,binding,path,transcriptRoot};
 return {root,cwd,path,transcriptRoot,rows,item,write:()=>writeFileSync(path,Buffer.concat(rows.map(line)))};
}
function request(sources:MemoryInputSource[]){const sorted=[...sources].sort((a,b)=>memorySaveSourceKey(a.source).localeCompare(memorySaveSourceKey(b.source)));return {sources,expectedCoverageDigest:saveDigest(sorted.map(i=>[memorySaveSourceKey(i.source),i.source.sourceDigest])),validateRegistrationAndLease:async()=>true};}
function refreshObservation(f:ReturnType<typeof fixture>){
 const reader=new CompletedMemoryTurnReader(f.item.binding);let offset=0;
 for(const row of f.rows){const bytes=line(row);reader.record(bytes,offset);offset+=bytes.length;}
 expect(reader.invalid).toBe(false);expect(reader.sources).toHaveLength(1);f.item.source=reader.sources[0]!;f.write();
}

test('conversation projection keeps exact Claude text while verified CLI listings can exceed the old raw cap',async()=>{
 const f=fixture('claude','  전체 사용자 요청\n🙂  ');
 Object.assign(f.rows[2].message,{stop_details:null,diagnostics:{},container:null,context_management:null});
 f.rows[1].attachment={type:'skill_listing',content:'HOST_SKILL_CONTEXT'.repeat(6000)};refreshObservation(f);
 const result=await materializeMemorySaveInput({...request([f.item]),projection:'conversation-v1'});
 const body=JSON.parse(result.plaintext.toString());expect(body.version).toBe(2);expect(body.projection).toBe('conversation-v1');
 expect(body.turns[0].messages).toEqual([{role:'user',content:['  전체 사용자 요청\n🙂  ']},{role:'assistant',content:['Verified answer']}]);
 expect(body.turns[0].omitted['claude.attachment.skill_listing']).toBe(1);expect(body.turns[0].sourceDigest).toBe(f.item.source.sourceDigest);
 expect(result.bytesRead).toBeGreaterThan(100_000);expect(result.plaintext.length).toBeLessThan(20000);
 expect(result.plaintext.toString()).not.toContain('HOST_SKILL_CONTEXT');result.plaintext.fill(0);
});
test('Codex projection uses completed conversation events and documents excluded context copies',async()=>{
 const f=fixture('codex','<command-name>ordinary human text is retained</command-name>');
 Object.assign(f.rows[3].payload,{thread_id:f.item.source.sessionId,turn_id:'turn-codex',started_at_ms:1,completed_at_ms:2});
 f.rows[3].payload.item.content[0].text_elements=[];
 f.rows.splice(3,0,{type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'PLUGIN_CONTEXT'.repeat(6000)}]}},
  {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'CONTEXT_COPY'}]}});refreshObservation(f);
 const result=await materializeMemorySaveInput({...request([f.item]),projection:'conversation-v1'});const body=JSON.parse(result.plaintext.toString());
 expect(body.turns[0].messages.map((m:any)=>m.content.join(''))).toEqual(['<command-name>ordinary human text is retained</command-name>','Verified answer']);
 expect(body.turns[0].omitted['codex.response.message.developer']).toBe(1);expect(body.turns[0].omitted['codex.response.message.user']).toBe(1);
 expect(result.plaintext.toString()).not.toContain('PLUGIN_CONTEXT');expect(result.plaintext.toString()).not.toContain('CONTEXT_COPY');result.plaintext.fill(0);
});
test('projection cannot reuse coverage when only omitted raw metadata changed',async()=>{
 const f=fixture('claude');f.rows[1].attachment={type:'skill_listing',content:'before'};refreshObservation(f);
 f.rows[1].attachment.content='after!';f.write();
 await expect(materializeMemorySaveInput({...request([f.item]),projection:'conversation-v1'})).rejects.toThrow('SOURCE_CHANGED');
});
test('new Claude initial host context is explicitly counted without dropping the surrounding conversation',async()=>{
 const f=fixture('claude');
 const kinds=['environment','model','deferred_tools_delta','agent_listing_delta','skill_listing','auto_mode','total_tokens_reminder','instructions','session_context','date','remote_session_change','prompt_snapshot'];
 const base=f.rows[1];const attachments=kinds.map((type,index)=>({...base,uuid:'context-'+index,parentUuid:index?'context-'+(index-1):'user-claude',attachment:{type,content:'HOST_CONTEXT'.repeat(3000)}}));
 f.rows.splice(1,1,...attachments);f.rows.at(-1).parentUuid='context-'+(kinds.length-1);refreshObservation(f);
 const result=await materializeMemorySaveInput({...request([f.item]),projection:'conversation-v1'});const body=JSON.parse(result.plaintext.toString());
 expect(body.turns[0].messages).toEqual([{role:'user',content:['전체 한글 대화 🙂']},{role:'assistant',content:['Verified answer']}]);
 for(const type of kinds)expect(body.turns[0].omitted['claude.attachment.'+type]).toBe(1);
 expect(result.bytesRead).toBeGreaterThan(400000);expect(result.plaintext.length).toBeLessThan(20000);result.plaintext.fill(0);
});
test('unknown or nontext conversation content rejects instead of completing partial semantic coverage',async()=>{
 for(const kind of ['unknown-block','image','attachment','message-field']){
  const f=fixture('claude');f.rows[1].attachment={type:'skill_listing'};
  if(kind==='unknown-block')f.rows[2].message.content.push({type:'future_text',value:'unrepresented'});
  if(kind==='image')f.rows[0].message.content=[{type:'text',text:'See image'},{type:'image',source:{data:'private'}}];
  if(kind==='attachment')f.rows[1].attachment.type='user_file';
  if(kind==='message-field')f.rows[2].message.new_content='unrepresented';
  refreshObservation(f);
  await expect(materializeMemorySaveInput({...request([f.item]),projection:'conversation-v1'})).rejects.toThrow('UNSUPPORTED_CONTENT');
 }
});
test('projected semantic and serialized envelope budgets both reject whole turns without truncation',async()=>{
 for(const text of ['큰'.repeat(7000),'\\'.repeat(11000)]){
  const f=fixture('codex',text);
  await expect(materializeMemorySaveInput({...request([f.item]),projection:'conversation-v1'})).rejects.toThrow('INPUT_OVERSIZED');
 }
});
test('legacy Codex reasoning remains verified omitted metadata in a complete conversation',async()=>{
 const f=fixture('codex');f.rows.splice(4,0,{type:'event_msg',payload:{type:'agent_reasoning',text:'reasoning metadata'}});refreshObservation(f);
 const result=await materializeMemorySaveInput({...request([f.item]),projection:'conversation-v1'});
 const body=JSON.parse(result.plaintext.toString());expect(body.turns[0].omitted['codex.event.agent_reasoning']).toBe(1);
 expect(body.turns[0].messages).toHaveLength(2);expect(result.plaintext.toString()).not.toContain('reasoning metadata');result.plaintext.fill(0);
});
test('canonical Codex future fields and nonempty text annotations cannot disappear from completed evidence',async()=>{
 for(const kind of ['annotation','event-field','item-field','legacy-field','completion-field']){
  const f=fixture('codex');
  if(kind==='annotation')f.rows[3].payload.item.content[0].text_elements=[{type:'future_annotation',text:'unrepresented'}];
  if(kind==='event-field')f.rows[3].payload.new_content='unrepresented';
  if(kind==='item-field')f.rows[3].payload.item.new_content='unrepresented';
  if(kind==='legacy-field')f.rows[4].payload.audio='unrepresented';
  if(kind==='completion-field')f.rows.at(-1).payload.new_content='unrepresented';
  refreshObservation(f);
  await expect(materializeMemorySaveInput({...request([f.item]),projection:'conversation-v1'})).rejects.toThrow('UNSUPPORTED_CONTENT');
 }
});
test('Codex completion-only final text is retained and only exact conversation duplicates are omitted',async()=>{
 for(const answer of ['Verified answer','Additional final conclusion']){
  const f=fixture('codex');f.rows.at(-1).payload.last_agent_message=answer;refreshObservation(f);
  const result=await materializeMemorySaveInput({...request([f.item]),projection:'conversation-v1'});const body=JSON.parse(result.plaintext.toString());
  const answers=body.turns[0].messages.filter((m:any)=>m.role==='assistant').map((m:any)=>m.content.join('\n'));
  expect(answers).toEqual(answer==='Verified answer'?['Verified answer']:['Verified answer','Additional final conclusion']);result.plaintext.fill(0);
 }
});

test('Claude and Codex exact complete-turn records survive materialization without truncation or filtering',async()=>{
 for(const agent of ['claude','codex'] as const){const f=fixture(agent);const result=await materializeMemorySaveInput(request([f.item]));const body=JSON.parse(result.plaintext.toString());
  expect(body.turns[0].jsonl).toBe(readFileSync(f.path).subarray(f.item.source.startByte,f.item.source.endByte).toString());expect(body.turns[0].jsonl).toContain('전체 한글 대화 🙂');
  expect(result.inputDigest).toBe(createHash('sha256').update(result.plaintext).digest('hex'));expect(result.sourceCount).toBe(1);expect(result.plaintext.length).toBeLessThanOrEqual(48000);result.plaintext.fill(0);
 }
});

test('deterministic group coverage matches the durable reservation and encrypted input binding',async()=>{
 const a=fixture(),b=fixture('claude');const app=join(a.root,'app');mkdirSync(app);const saves=new MemorySaveStore(join(app,'memory-save-v2.sqlite'));
 const keys=saves.observeBatch([a.item.source,b.item.source]);const job=saves.reserve('memory',1,keys);const req=request([b.item,a.item]);expect(req.expectedCoverageDigest).toBe(job.coverageDigest);
 const result=await materializeMemorySaveInput({...req,expectedCoverageDigest:job.coverageDigest});const reordered=await materializeMemorySaveInput(request([a.item,b.item]));expect(result.plaintext).toEqual(reordered.plaintext);
 const lease=await acquireWorkspaceDirectoryLease({workspacePath:app,appDataDir:app,attempts:1,deadOwnerRecoveryClass:'manual'});leases.push(lease);
 const inputStore=new MemorySaveInputStore(app,lease),key=randomBytes(32),binding={saveId:job.saveId,memoryId:job.memoryId,policyEpoch:job.policyEpoch,coverageDigest:job.coverageDigest,inputDigest:result.inputDigest,beforeHash:saveDigest('before'),providerBindingDigest:saveDigest('provider')};
 await inputStore.stage(binding,result.plaintext,key);expect(inputStore.read(binding,key)).toEqual(result.plaintext);expect(saves.get(job.saveId).phase).toBe('prepared');expect(saves.get(job.saveId).attemptId).toBeNull();
 result.plaintext.fill(0);reordered.plaintext.fill(0);key.fill(0);
});

test('changed historical bytes, truncation and shifted record boundaries cannot reuse an observation',async()=>{
 for(const kind of ['changed','truncated','boundary']){const f=fixture();if(kind==='changed'){f.rows[3].payload.item.content[0].text='Changed source';f.write();}if(kind==='truncated')truncateSync(f.path,f.item.source.endByte-1);if(kind==='boundary')f.item.source.startByte++;
  await expect(materializeMemorySaveInput(request([f.item]))).rejects.toThrow('SOURCE_CHANGED');
 }
});

test('session header ownership and actual turn completion are rechecked even with a newly forged range hash',async()=>{
 for(const kind of ['session','cwd','completion']){const f=fixture();if(kind==='session')f.rows[0].payload.id='foreign-codex';if(kind==='cwd')f.rows[0].payload.cwd=f.cwd.replace('project','foreign');if(kind==='completion')f.rows.at(-1).payload.turn_id='wrong-turn';f.write();
  if(kind==='completion'){f.item.source.endByte=readFileSync(f.path).length;f.item.source.sourceDigest=createHash('sha256').update(readFileSync(f.path).subarray(f.item.source.startByte)).digest('hex');}
  await expect(materializeMemorySaveInput(request([f.item]))).rejects.toThrow('SOURCE_CHANGED');
 }
});

test('large transcript history is sought past and new appended turns are not included',async()=>{
 const f=fixture('codex','Selected only',9*1024*1024);appendFileSync(f.path,line({type:'event_msg',payload:{type:'user_message',message:'New unfinished activity'}}));
 const result=await materializeMemorySaveInput(request([f.item]));expect(result.bytesRead).toBeLessThan(70000);expect(result.plaintext.toString()).not.toContain('New unfinished activity');
});

test('oversized whole turns and JSON envelope overhead reject the entire group instead of dropping content',async()=>{
 for(const text of ['x'.repeat(48000),'\\'.repeat(13000)]){const f=fixture('codex',text);await expect(materializeMemorySaveInput(request([f.item]))).rejects.toThrow('INPUT_OVERSIZED');}
});

test('registration denial or a file change during final validation returns no selected input',async()=>{
 const f=fixture();await expect(materializeMemorySaveInput({...request([f.item]),validateRegistrationAndLease:async()=>false})).rejects.toThrow('REGISTRATION_CHANGED');
 let calls=0;await expect(materializeMemorySaveInput({...request([f.item]),validateRegistrationAndLease:async()=>{if(++calls===2)appendFileSync(f.path,'\n');return true;}})).rejects.toThrow('SOURCE_CHANGED');
});

test('symlinks, hardlinks, outside roots and missing files fail without creating a fallback',async()=>{
 for(const kind of ['symlink','hardlink','outside','missing']){const f=fixture();const other=join(f.root,'other');writeFileSync(other,readFileSync(f.path));rmSync(f.path);
  if(kind==='symlink')symlinkSync(other,f.path);if(kind==='hardlink')linkSync(other,f.path);if(kind==='outside')f.item.path=other;
  await expect(materializeMemorySaveInput(request([f.item]))).rejects.toThrow();expect(readFileSync(other).length).toBeGreaterThan(0);
 }
});

test('duplicate sources, mixed memory identity, fragments and wrong coverage fail before registration',async()=>{
 const a=fixture(),b=fixture('claude');let calls=0;const validateRegistrationAndLease=async()=>{calls++;return true;};
 await expect(materializeMemorySaveInput({...request([a.item,a.item]),validateRegistrationAndLease})).rejects.toThrow('INVALID_INPUT');
 b.item.source.memoryId='other';b.item.binding.memoryId='other';await expect(materializeMemorySaveInput({...request([a.item,b.item]),validateRegistrationAndLease})).rejects.toThrow('INVALID_INPUT');
 await expect(materializeMemorySaveInput({...request([a.item]),expectedCoverageDigest:saveDigest('wrong'),validateRegistrationAndLease})).rejects.toThrow('SOURCE_CHANGED');
 a.item.source.coverageKind='fragment';await expect(materializeMemorySaveInput({...request([a.item]),validateRegistrationAndLease})).rejects.toThrow('INVALID_INPUT');expect(calls).toBe(0);
});


test('malformed JSON or UTF-8 cannot pass by merely replacing the stored range digest',async()=>{
 for(const kind of ['json','utf8']){const f=fixture();const bytes=readFileSync(f.path);bytes[f.item.source.startByte]=kind==='json'?33:255;writeFileSync(f.path,bytes);
  f.item.source.sourceDigest=createHash('sha256').update(bytes.subarray(f.item.source.startByte)).digest('hex');
  await expect(materializeMemorySaveInput(request([f.item]))).rejects.toThrow('SOURCE_CHANGED');
 }
});

test('unbounded source headers and more than 128 inputs are rejected before producing plaintext',async()=>{
 const f=fixture();const old=readFileSync(f.path),headEnd=old.indexOf(10)+1;f.rows[0].payload.padding='x'.repeat(260*1024);const head=line(f.rows[0]);
 writeFileSync(f.path,Buffer.concat([head,old.subarray(headEnd)]));f.item.source.startByte+=head.length-headEnd;f.item.source.endByte+=head.length-headEnd;
 await expect(materializeMemorySaveInput(request([f.item]))).rejects.toThrow('SOURCE_OVERSIZED');
 await expect(materializeMemorySaveInput(request(Array(129).fill(f.item)))).rejects.toThrow('INVALID_INPUT');
});
