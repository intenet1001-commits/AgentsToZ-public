import {Database} from 'bun:sqlite';
import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {VoiceHistoryStore,type VoiceHistoryMeta} from '../src/voiceHistoryStore';
import {VoiceMemoryBridge} from '../src/voiceMemoryBridge';
import {MemorySaveStore} from '../src/memorySaveStore';
import {materializeMemorySaveInput} from '../src/memorySaveInputMaterializer';
import {memorySaveSourceKey,saveDigest} from '../src/memorySaveContract';
import {selectAutomaticMemorySources} from '../src/memorySaveSelection';
import {normalizeVoiceRequest,normalizeVoiceResponse,VOICE_TIME_LIMIT_NOTICE} from '../src/voiceSessionProtocol';
import {legacyOpsVoiceBindingHashes,opsVoiceIdentity,sameVoiceScope} from '../src/voiceOpsIdentity';
const roots:string[]=[];afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'voice-history-')));roots.push(root);let key:Buffer|null=null;
 const store=new VoiceHistoryStore(join(root,'records'),{read:async()=>key?Buffer.from(key):null,create:async()=>{key=randomBytes(32);return Buffer.from(key);}});
 const meta:VoiceHistoryMeta={id:'voice_session_1',target:{kind:'workroom',targetId:'project_fixture',sessionId:'terminal_fixture'},binding:'fixture_binding',memoryId:'memory_fixture',label:'별빛 작업',createdAt:new Date().toISOString(),mode:'conversation',model:'gpt-realtime-2.1'};
 return {root,store,meta,lose:()=>{key=null;},replace:()=>{key=randomBytes(32);}};
}
test('encrypted voice records survive reopen, retain speaker attribution and paginate without clipping',async()=>{
 const f=fixture();await f.store.begin(f.meta);const speech='한국어 OpenAI Realtime '.repeat(500);
 await f.store.append(f.meta.id,'item_user','user',speech,f.meta.createdAt);expect(await f.store.append(f.meta.id,'item_user','user',speech,f.meta.createdAt)).toBe(false);
 await f.store.append(f.meta.id,'item_ai','assistant','아직 실행하지 않았습니다.',f.meta.createdAt);await f.store.end(f.meta.id,new Date().toISOString());
 expect(readFileSync(join(f.root,'records/voice-history.sqlite')).includes(Buffer.from('한국어'))).toBe(false);
 expect((await f.store.list()).sessions[0]!.turnCount).toBe(2);
 let result='',cursor:string|undefined;do{const p=await f.store.read(f.meta.id,cursor);if(p.turn?.role==='user')result+=p.turn.text;cursor=p.nextCursor??undefined;}while(cursor);expect(result).toBe(speech);
 await expect(f.store.append(f.meta.id,'item_user','user','changed',f.meta.createdAt)).rejects.toThrow();
});
test('missing/replaced key never creates a replacement database or appends mixed-key data',async()=>{
 for(const action of ['lose','replace'] as const){const f=fixture();await f.store.begin(f.meta);const before=readFileSync(join(f.root,'records/voice-history.sqlite'));f[action]();await expect(f.store.begin({...f.meta,id:'another_session'})).rejects.toThrow();expect(readFileSync(join(f.root,'records/voice-history.sqlite'))).toEqual(before);}
});
test('incomplete and foreign-target voice cannot enter memory evidence; acknowledged evidence is consumed exactly',async()=>{
 const f=fixture();await f.store.begin(f.meta);await f.store.append(f.meta.id,'one','user','출시 전 오디오 테스트를 해야 함',f.meta.createdAt);
 await expect(f.store.assertRememberable(f.meta.id)).rejects.toThrow();expect((await f.store.evidencePage(f.meta)).items).toHaveLength(0);await f.store.end(f.meta.id,new Date().toISOString(),false);expect((await f.store.evidencePage(f.meta)).items).toHaveLength(0);
 const good={...f.meta,id:'voice_session_2'};await f.store.begin(good);await f.store.append(good.id,'one','user','영어 명칭 유지',good.createdAt);await f.store.end(good.id,new Date().toISOString());
 await f.store.assertRememberable(good.id);const p=await f.store.evidencePage(good);expect(p.items).toHaveLength(1);expect((await f.store.evidencePage({...good,binding:'foreign'})).items).toHaveLength(0);
 await expect(f.store.evidenceSequence({...good,memoryId:'different'},good.id,p.items[0]!.sequence)).rejects.toThrow();
 await f.store.acknowledge(good,p.items);expect((await f.store.evidencePage(good,0,true)).items).toHaveLength(0);expect((await f.store.evidencePage(good)).items).toHaveLength(1);
});
test('genuine voice source uses encrypted loader, validates identity and participates in existing automatic coverage',async()=>{
 const f=fixture();let now=Date.now();const saves=new MemorySaveStore(join(f.root,'memory-save.sqlite'),()=>now);
 const bridge=new VoiceMemoryBridge({store:f.store,saves,identity:async()=>f.meta});
 const target={id:'project_fixture',cwd:f.root,root:f.root,memoryId:'memory_fixture',validate:async()=>true};
 await f.store.begin(f.meta);await f.store.append(f.meta.id,'one','user','결정: 영어 기술 용어를 유지한다.',f.meta.createdAt);await f.store.end(f.meta.id,new Date(now-10).toISOString());
 await bridge.observe(target,'installation');const pending=saves.pending(f.meta.memoryId!,1);expect(pending.items).toHaveLength(1);
 // Read observed source through its durable reservation contract, without inventing CLI evidence.
 const job=saves.reserve(f.meta.memoryId!,1,pending.items.map(i=>i.sourceKey));const db=new Database(saves.path,{readonly:true});const source=JSON.parse((db.query('SELECT payload FROM save_sources WHERE saveId=?').get(job.saveId) as any).payload);db.close();
 expect(source.agent).toBe('voice');const item=bridge.source(target,'installation',source);
 const input={sources:[item],expectedCoverageDigest:saveDigest([[memorySaveSourceKey(source),source.sourceDigest]]),projection:'conversation-v1' as const,validateRegistrationAndLease:async()=>true};
 const result=await materializeMemorySaveInput(input);expect(result.plaintext.toString()).toContain('영어 기술 용어');result.plaintext.fill(0);
 await expect(materializeMemorySaveInput({...input,sources:[{...item,source:{...source,sourceDigest:'a'.repeat(64)}}],expectedCoverageDigest:saveDigest([[memorySaveSourceKey(source),'a'.repeat(64)]])})).rejects.toThrow();
 await expect(bridge.source({...target,validate:async()=>false},'installation',source).readVoice!()).rejects.toThrow();
});

test('host records late final at stop, deduplicates provider events, and keeps remote reads forbidden',async()=>{
 const {VoiceSessionHost}=await import('../src/voiceSessionHost');const f=fixture();let event:(e:any)=>void=()=>{};
 const host=new VoiceSessionHost({credentials:{status:()=>({configured:true,model:'gpt-realtime-2.1'}),key:async()=>'',configure:async()=>({})},
  history:{store:f.store,identity:async()=>f.meta,review:async()=>''},bind:async()=>({label:'fixture',key:'fixed',validate:async()=>{},tools:[],run:async()=>null}),
  provider:async i=>{event=i.onEvent;return {sdp:'v=0',send:()=>{},close:async()=>{}};}});
 const authority={owner:'device',active:()=>true},request=(action:any,other:any={})=>({action,requestId:crypto.randomUUID(),...other});
 try{const p=await host.perform(request('prepare',{target:f.meta.target,mode:'conversation',consent:true,recordConsent:true}),authority),id=p.session!.id;
 await host.perform(request('connect',{sessionId:id,sdp:'v=0'}),authority);event({type:'input_audio_buffer.committed',item_id:'last'});
 const final={type:'conversation.item.input_audio_transcription.completed',item_id:'last',transcript:'OpenAI 연결을 확인하자'};setTimeout(()=>{event(final);event(final);},150);
 const end=await host.perform(request('stop',{sessionId:id}),authority);expect(end.session?.recording?.savedTurns).toBe(1);
 expect((await f.store.read(id)).turn?.text).toBe(final.transcript);await expect(host.perform(request('history.list'),authority)).rejects.toThrow();
 }finally{await host.shutdown();}
});

type HostEvents={event:(e:Record<string,unknown>)=>void;disconnect:()=>void};
/** A real host over the real encrypted store; only the provider and clock are scripted. */
async function recordingHost(f:ReturnType<typeof fixture>,options:{fail?:boolean}={}){
 const {VoiceSessionHost}=await import('../src/voiceSessionHost');let now=Date.parse('2026-09-29T00:00:00Z');const events:HostEvents={event:()=>{},disconnect:()=>{}};
 const host=new VoiceSessionHost({now:()=>now,credentials:{status:()=>({configured:true,model:'gpt-realtime-2.1'}),key:async()=>'',configure:async()=>({})},
  history:{store:f.store,identity:async()=>f.meta,review:async()=>''},bind:async()=>({label:'별빛 작업',key:'record-'+crypto.randomUUID(),validate:async()=>{},tools:[],run:async()=>null}),
  provider:async i=>{if(options.fail)throw Error('음성 제공자 연결 실패 (HTTP 401).');events.event=i.onEvent;events.disconnect=i.onDisconnect;return {sdp:'v=0',send:()=>{},close:async()=>{}};}});
 const start=async()=>{const id=(await host.perform(request('prepare',{target:f.meta.target,mode:'conversation',consent:true,recordConsent:true}),authority)).session!.id;await host.perform(request('connect',{sessionId:id,sdp:'v=0'}),authority);return id;};
 return {host,events,start,advance:(ms:number)=>{now+=ms;}};
}
const authority={owner:'local',active:()=>true};
const request=(action:string,other:Record<string,unknown>={})=>({action,requestId:crypto.randomUUID(),...other});

test('a session that reaches the 15-minute limit ends normally and its saved transcripts stay rememberable',async()=>{
 const f=fixture(),h=await recordingHost(f);
 try{
  const id=await h.start();
  h.events.event({type:'conversation.item.input_audio_transcription.completed',item_id:'said',transcript:'배포 전에 로그인 오류를 먼저 고치자'});
  h.events.event({type:'response.output_audio_transcript.done',item_id:'answer',transcript:'로그인 오류부터 확인하겠습니다.'});
  h.advance(15*60_000);
  // A final that lands after the limit passed but before the host noticed is still speech that was said.
  h.events.event({type:'conversation.item.input_audio_transcription.completed',item_id:'late',transcript:'마지막으로 테스트도 돌려 줘'});
  const ended=(await h.host.perform(request('state',{sessionId:id}),authority)).session!;
  // Used to be 'failed' + incomplete: the time limit was treated like a dropped connection.
  expect(ended.state).toBe('ended');expect(ended.notice).toBe(VOICE_TIME_LIMIT_NOTICE);expect(ended.recording).toMatchObject({savedTurns:3});
  await f.store.assertRememberable(id);
  expect((await f.store.evidencePage(f.meta)).items.map(item=>item.itemId)).toEqual(['said','answer','late']);
  expect((await f.store.list()).sessions[0]).toMatchObject({id,complete:true});
 }finally{await h.host.shutdown();}
});

test('a clean stop is complete; a failed provider connection and a dropped provider stay incomplete',async()=>{
 const f=fixture(),clean=await recordingHost(f);
 try{
  const id=await clean.start();clean.events.event({type:'conversation.item.input_audio_transcription.completed',item_id:'clean',transcript:'오늘은 여기까지'});
  expect((await clean.host.perform(request('stop',{sessionId:id}),authority)).session!.state).toBe('ended');
  await f.store.assertRememberable(id);
 }finally{await clean.host.shutdown();}
 const failed=await recordingHost(f,{fail:true});
 try{
  const id=(await failed.host.perform(request('prepare',{target:f.meta.target,mode:'conversation',consent:true,recordConsent:true}),authority)).session!.id;
  await expect(failed.host.perform(request('connect',{sessionId:id,sdp:'v=0'}),authority)).rejects.toThrow('401');
  await expect(f.store.assertRememberable(id)).rejects.toThrow();
  expect((await f.store.list()).sessions.find(session=>session.id===id)).toMatchObject({complete:false});
 }finally{await failed.host.shutdown();}
 const dropped=await recordingHost(f);
 try{
  const id=await dropped.start();dropped.events.event({type:'conversation.item.input_audio_transcription.completed',item_id:'dropped',transcript:'말하는 중에'});
  dropped.events.disconnect();await Bun.sleep(20);
  expect((await dropped.host.perform(request('state',{sessionId:id}),authority)).session!.state).toBe('failed');
  await expect(f.store.assertRememberable(id)).rejects.toThrow();
 }finally{await dropped.host.shutdown();}
});

test('Gemini ending its own connection (goAway) is a normal end; its last turn is kept',async()=>{
 const {VoiceSessionHost}=await import('../src/voiceSessionHost');const f=fixture();let onEvent:(e:Record<string,unknown>)=>void=()=>{};
 const host=new VoiceSessionHost({credentials:{status:()=>({configured:false}),key:async()=>'',configure:async()=>({})},history:{store:f.store,identity:async()=>f.meta,review:async()=>''},
  gemini:{status:()=>({configured:true,model:'gemini-live-fixture'}),key:async()=>'gemini-fixture',configure:async()=>{},provider:async input=>{onEvent=input.onEvent;return {sdp:'',send:()=>{},appendAudio:()=>{},endAudio:()=>{},readMedia:async()=>[],close:async()=>{}};}},
  bind:async()=>({label:'별빛 작업',key:'gemini-record',validate:async()=>{},tools:[],run:async()=>null})});
 try{
  const id=(await host.perform(request('prepare',{provider:'gemini',target:f.meta.target,mode:'conversation',consent:true,recordConsent:true}),authority)).session!.id;
  await host.perform(request('media.connect',{sessionId:id}),authority);
  // What the provider emits for the turn it flushes at goAway, then its announcement.
  onEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'gemini_0_in',transcript:'여기까지 정리해 줘'});
  onEvent({type:'session.provider_ending'});
  const deadline=Date.now()+4000;let state='';while(Date.now()<deadline){state=(await host.perform(request('state',{sessionId:id}),authority)).session!.state;if(state!=='active')break;await Bun.sleep(50);}
  expect(state).toBe('ended');
  await f.store.assertRememberable(id);
  expect((await f.store.evidencePage(f.meta)).items.map(item=>item.itemId)).toEqual(['gemini_0_in']);
 }finally{await host.shutdown();}
});

test('history lists 아젠투지 or one project, names the scopes it holds, and pages a filter',async()=>{
 const f=fixture(),at=(n:number)=>new Date(Date.parse('2026-09-29T00:00:00Z')+n*1000).toISOString();
 const ops:VoiceHistoryMeta={...f.meta,id:'voice_ops_1',target:{kind:'ops'},memoryScope:'ops',binding:'ops_binding',label:'AgentsToZ OPS',createdAt:at(1)};
 const vibe:VoiceHistoryMeta={...f.meta,id:'voice_vibe_1',target:{kind:'workroom',targetId:'vibe2_target',sessionId:'terminal_vibe'},binding:'vibe_binding',label:'vibe2 · claude',createdAt:at(2)};
 // The Control workroom shares the OPS memory, so its voice belongs to 아젠투지 too.
 const control:VoiceHistoryMeta={...f.meta,id:'voice_ctrl_1',target:{kind:'workroom',targetId:'control_target',sessionId:'terminal_ctrl'},memoryScope:'ops',binding:'ops_binding',label:'AgentsToZ-Control · agy',createdAt:at(3)};
 for(const meta of [ops,vibe,control])await f.store.begin(meta);
 await f.store.end(vibe.id,at(4));
 const all=await f.store.list();
 expect(all.sessions.map(session=>session.id)).toEqual(['voice_ctrl_1','voice_vibe_1','voice_ops_1']);
 expect(all.sessions.find(session=>session.id==='voice_vibe_1')).toMatchObject({kind:'workroom',targetId:'vibe2_target',complete:true});
 expect(all.sessions.find(session=>session.id==='voice_ops_1')).toMatchObject({kind:'ops',targetId:null,complete:false});
 expect(all.scopes).toEqual([{key:'ops',kind:'ops',label:'AgentsToZ OPS'},{key:'vibe2_target',kind:'workroom',label:'vibe2'}]);
 expect((await f.store.list(undefined,'ops')).sessions.map(session=>session.id)).toEqual(['voice_ctrl_1','voice_ops_1']);
 expect((await f.store.list(undefined,'vibe2_target')).sessions.map(session=>session.id)).toEqual(['voice_vibe_1']);
 expect((await f.store.list(undefined,'control_target')).sessions.map(session=>session.id)).toEqual(['voice_ctrl_1']);
 expect(normalizeVoiceResponse({history:all}).history).toEqual(all);
 expect(normalizeVoiceRequest(request('history.list',{scope:'ops'})).scope).toBe('ops');
 expect(()=>normalizeVoiceRequest(request('history.list',{scope:'../ops'}))).toThrow();
 for(let n=0;n<24;n++)await f.store.begin({...ops,id:`voice_ops_page_${String(n).padStart(2,'0')}`,createdAt:at(10+n)});
 const first=await f.store.list(undefined,'ops');expect(first.sessions).toHaveLength(20);expect(first.sessions.every(session=>session.kind==='ops')).toBe(true);
 const second=await f.store.list(first.nextBefore!,'ops');expect(second.sessions.map(session=>session.id)).toEqual(['voice_ops_page_03','voice_ops_page_02','voice_ops_page_01','voice_ops_page_00','voice_ctrl_1','voice_ops_1']);expect(second.nextBefore).toBeNull();
 expect(second.scopes).toBeUndefined();
 const host=await recordingHost(f);
 try{expect((await host.host.perform(request('history.list',{scope:'vibe2_target'}),authority)).history!.sessions.map(session=>session.id)).toEqual(['voice_vibe_1']);}
 finally{await host.host.shutdown();}
});

test('OPS voice keeps one record scope across a folder rename; pre-rename sessions stay rememberable via former roots',async()=>{
 const f=fixture(),created=new Date().toISOString();
 const before={profileId:'profile_fixture',memoryId:'memory_ops',root:'/Users/fixture/product_2026/AgentsToZ-Control',projectId:'359150c5-7ed4-4b99-9b81-d864190342d3',backend:'control-folder'};
 // Recorded by the previous build, whose OPS scope hashed the root path.
 const {formerBindings:_former,...pathScoped}=opsVoiceIdentity({kind:'ops'},before,'memory_ops');
 const legacy:VoiceHistoryMeta={...pathScoped,binding:legacyOpsVoiceBindingHashes(before)[0]!,id:'voice_ops_legacy',label:'AgentsToZ OPS',createdAt:created,mode:'conversation',model:'gpt-realtime-2.1'};
 await f.store.begin(legacy);await f.store.append(legacy.id,'one','user','운영 결정: 폴더 이름을 AgentsToZ-OPS로 바꾼다',created);await f.store.end(legacy.id,created);
 const renamed={...before,root:'/Users/fixture/product_2026/AgentsToZ-OPS',legacyRoots:[before.root]};
 const current=opsVoiceIdentity({kind:'ops'},renamed,'memory_ops');
 expect(current.binding).toBe(opsVoiceIdentity({kind:'ops'},before,'memory_ops').binding);
 expect(sameVoiceScope(current,await f.store.metadata(legacy.id))).toBe(true);
 expect((await f.store.evidencePage(current)).items.map(item=>item.sessionId)).toEqual([legacy.id]);
 expect((await f.store.evidenceTurn(current,legacy.id,'one','user')).text).toContain('AgentsToZ-OPS');
 // Without the recorded former root the old path hash is unknowable, and nothing else matches it.
 expect(sameVoiceScope(opsVoiceIdentity({kind:'ops'},{...before,root:'/elsewhere'},'memory_ops'),await f.store.metadata(legacy.id))).toBe(false);
 // New sessions are sealed with the path-free scope only; accepted former scopes are never sealed.
 await f.store.begin({...current,id:'voice_ops_new',label:'AgentsToZ OPS',createdAt:created,mode:'conversation',model:'gpt-realtime-2.1'});
 const sealed=await f.store.metadata('voice_ops_new');
 expect(sealed.binding).toBe(current.binding);expect(Object.keys(sealed)).not.toContain('formerBindings');
 await f.store.begin({...current,id:'voice_ops_new',label:'AgentsToZ OPS',createdAt:created,mode:'conversation',model:'gpt-realtime-2.1'});
 const moved=opsVoiceIdentity({kind:'ops'},{profileId:before.profileId,memoryId:before.memoryId,root:'/Volumes/Other/AgentsToZ-OPS',projectId:before.projectId,backend:before.backend},'memory_ops');
 expect(sameVoiceScope(moved,sealed)).toBe(true);
 expect(sameVoiceScope(opsVoiceIdentity({kind:'ops'},{...renamed,memoryId:'memory_other'},'memory_other'),sealed)).toBe(false);
 expect(sameVoiceScope({...current,memoryId:'memory_other'},sealed)).toBe(false);
});

test('simultaneous history reads and final transcripts serialize without losing records',async()=>{
 const f=fixture();await f.store.begin(f.meta);
 await Promise.all([f.store.append(f.meta.id,'concurrent_user','user','동시에 저장',f.meta.createdAt),f.store.list(),f.store.append(f.meta.id,'concurrent_ai','assistant','기록 확인',f.meta.createdAt)]);
 expect((await f.store.list()).sessions[0]!.turnCount).toBe(2);
});
