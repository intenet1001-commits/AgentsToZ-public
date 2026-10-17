import {afterEach,expect,test} from 'bun:test';
import {OPS,VIBE,VIBE2,authority,request,voiceWorld,output,until,call,type ScriptedProvider} from './fixtures/voice-world';
import {normalizeVoiceRequest,normalizeVoiceResponse} from '../src/voiceSessionProtocol';
import {voiceCaptionSource} from '../src/voiceCaption';
import {voiceDockStatus,voicePartnerName} from '../src/components/AgentsToZVoiceDock';

/**
 * 아젠투지 voice dock (VOC 2026-09-29). Like a division head who can work through the department
 * head (총괄) or talk straight to a staff member (a project's AI): what was said to the 총괄 is the
 * OPS voice record, what was said to a project's AI after switching is that project's voice record,
 * and the OPS record keeps one line saying where the direct conversation went.
 */
const cleanup:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const step of cleanup.splice(0).reverse())await step();});

test('the answering OPS includes its verified device nickname in voice controls',()=>{
  const ops={kind:'ops' as const,label:'AgentsToZ OPS'};
  expect(voicePartnerName(ops,'아젠투지 1호')).toBe('총괄(아젠투지 1호)');
  expect(voiceDockStatus(ops,'아젠투지 1호')).toBe('총괄(아젠투지 1호) 응답중');
  expect(voicePartnerName(ops,'\u202e잘못된 이름')).toBe('총괄');
  expect(voicePartnerName({kind:'workroom',label:'mcp-series',targetId:'project',sessionId:'session',agent:'claude'},'아젠투지 1호')).toBe('mcp-series · Claude · 아젠투지 1호');
});

async function running(w:Awaited<ReturnType<typeof voiceWorld>>,targetId:string,agent:'codex'|'claude'){
  const session=(await w.terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId,agent,cols:100,rows:28})).session!;
  await until(async()=>(await output(w.terminal,session.id)).includes('READY:'+agent),agent+' workroom');
  return session;
}
async function opsVoice(w:Awaited<ReturnType<typeof voiceWorld>>,recordConsent=true){
  const id=(await w.host.perform(request('prepare',{target:{kind:'ops'},mode:'conversation',consent:true,...(recordConsent?{recordConsent:true}:{})}),authority)).session!.id;
  await w.host.perform(request('connect',{sessionId:id,sdp:'v=0'}),authority);
  return id;
}
/** The provider's own lifecycle: a user item is committed when speech stops, then transcribed. */
function say(p:ScriptedProvider,itemId:string,text:string,{transcribeNow=true}={}){
  p.event({type:'input_audio_buffer.committed',item_id:itemId});
  if(transcribeNow)p.event({type:'conversation.item.input_audio_transcription.completed',item_id:itemId,transcript:text});
}
function answer(p:ScriptedProvider,itemId:string,text:string){
  p.event({type:'conversation.item.added',item:{id:itemId,type:'message',role:'assistant'}});
  p.event({type:'response.output_audio_transcript.done',item_id:itemId,transcript:text});
}
async function turns(w:Awaited<ReturnType<typeof voiceWorld>>,sessionId:string){
  const out:{role:string;text:string}[]=[];let cursor:string|undefined;
  do{const page=await w.store.read(sessionId,cursor);if(page.turn)out.push({role:page.turn.role,text:page.turn.text});cursor=page.nextCursor??undefined;}while(cursor);
  return out;
}

test('talking to the 총괄 stays OPS; after switching to a project AI the conversation is that project’s record',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  say(w.provider,'u1','바이브2 담당자 클로드로 불러줘');
  const connected=await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'});
  const room=connected.activeTarget.sessionId as string;
  answer(w.provider,'a1','vibe2 담당자 Claude에 연결했습니다.');
  say(w.provider,'u2','테스트 돌려 줘');
  answer(w.provider,'a2','테스트 초안을 준비할게요.');
  expect(await call(w.provider,'return_to_ops',{})).toMatchObject({state:'ops-active'});
  say(w.provider,'u3','총괄로 돌아왔어');
  await w.host.perform(request('stop',{sessionId:voice}),authority);

  const ops=(await w.store.list(undefined,'ops')).sessions,project=(await w.store.list(undefined,VIBE2)).sessions;
  expect(ops.map(s=>s.id)).toEqual([voice]);
  const opsTurns=await turns(w,voice);
  expect(opsTurns.map(t=>t.text)).toEqual(['바이브2 담당자 클로드로 불러줘',expect.stringContaining('vibe2 · claude'),'총괄로 돌아왔어']);
  expect(opsTurns[1]!.text).toMatch(/\[아젠투지 기록\].*직접 대화 3개 발언/);
  expect(project).toHaveLength(1);
  expect(project[0]).toMatchObject({kind:'workroom',targetId:VIBE2,label:'vibe2 · claude',turnCount:3,complete:true});
  expect((await turns(w,project[0]!.id)).map(t=>t.text)).toEqual(['vibe2 담당자 Claude에 연결했습니다.','테스트 돌려 줘','테스트 초안을 준비할게요.']);
  // Both are complete records, so each can be remembered on its own side.
  await w.store.assertRememberable(voice);await w.store.assertRememberable(project[0]!.id);
  expect(room).toBeTruthy();
},30_000);

test('an utterance belongs to whoever was listening when it was spoken, not when its transcript arrived',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  say(w.provider,'late','vibe2로 가자',{transcribeNow:false});
  await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'});
  w.provider.event({type:'conversation.item.input_audio_transcription.completed',item_id:'late',transcript:'vibe2로 가자'});
  say(w.provider,'after','README 봐 줘');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
  expect((await turns(w,voice)).map(t=>t.text)[0]).toBe('vibe2로 가자');
  const [segment]=(await w.store.list(undefined,VIBE2)).sessions;
  expect((await turns(w,segment!.id)).map(t=>t.text)).toEqual(['README 봐 줘']);
},30_000);

test('ending the voice while talking to a project AI closes both records and leaves the marker',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'codex'});
  say(w.provider,'u1','커밋해 줘');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
  const [segment]=(await w.store.list(undefined,VIBE2)).sessions;
  expect(segment).toMatchObject({label:'vibe2 · codex',turnCount:1,complete:true});
  expect((await turns(w,voice)).map(t=>t.text)).toEqual([expect.stringMatching(/\[아젠투지 기록\] vibe2 · codex.*직접 대화 1개 발언/)]);
},30_000);

test('switching from one project AI to another opens a separate record for each',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'});
  say(w.provider,'u1','vibe2 상태는?');
  await call(w.provider,'connect_project_delegate',{targetId:VIBE,agent:'codex'});
  say(w.provider,'u2','vibe 상태는?');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
  expect((await w.store.list(undefined,VIBE2)).sessions[0]).toMatchObject({label:'vibe2 · claude',turnCount:1});
  expect((await w.store.list(undefined,VIBE)).sessions[0]).toMatchObject({label:'vibe · codex',turnCount:1});
  expect((await turns(w,voice)).map(t=>t.text)).toEqual([expect.stringContaining('vibe2 · claude'),expect.stringContaining('vibe · codex')]);
},30_000);

test('the dock lists the 총괄 and running workrooms, and a tap switches exactly like the voice command',async()=>{
  const w=await voiceWorld(cleanup);
  const older=await running(w,VIBE,'codex');const newer=await running(w,VIBE2,'claude');
  const voice=await opsVoice(w);
  const listed=await w.host.perform(request('partners',{sessionId:voice}),authority);
  expect(listed.partners).toEqual([
    {kind:'ops',label:'AgentsToZ OPS'},
    {kind:'workroom',label:'vibe2',targetId:VIBE2,sessionId:newer.id,agent:'claude'},
    {kind:'workroom',label:'vibe',targetId:VIBE,sessionId:older.id,agent:'codex'},
  ]);
  const switched=await w.host.perform(request('partner',{sessionId:voice,partner:{kind:'workroom',targetId:VIBE,sessionId:older.id}}),authority);
  expect(switched.session!.activeTarget).toEqual({kind:'workroom',label:'vibe',targetId:VIBE,sessionId:older.id,agent:'codex'});
  // The model hears that the person switched on screen, as context — it is not asked to speak.
  const note=w.provider.outputs.at(-1)!;
  expect(note).toMatchObject({type:'conversation.item.create',item:{type:'message',role:'user'}});
  expect(note.item.content[0].text).toContain('[화면 전환');
  expect(note.item.content[0].text).toContain('vibe · codex');
  expect(w.provider.outputs.filter(e=>e.type==='response.create')).toHaveLength(0);
  say(w.provider,'u1','여기서 빌드해 줘');
  // The voice tools now act on that workroom.
  expect(await call(w.provider,'delegate_status',{})).toMatchObject({state:'delegate-connected',activeTarget:{sessionId:older.id}});
  expect((await w.host.perform(request('partner',{sessionId:voice,partner:{kind:'ops'}}),authority)).session!.activeTarget).toEqual({kind:'ops',label:'AgentsToZ OPS'});
  await w.host.perform(request('stop',{sessionId:voice}),authority);
  expect((await w.store.list(undefined,VIBE)).sessions[0]).toMatchObject({label:'vibe · codex',turnCount:1,complete:true});
},30_000);

test('a tap never switches under a pending draft, onto an ended workroom, or outside the allowed projects',async()=>{
  const w=await voiceWorld(cleanup);
  const room=await running(w,VIBE2,'claude');
  const voice=await opsVoice(w);
  // A draft from the 총괄 blocks a tap until it is sent or discarded.
  await call(w.provider,'prepare_workroom_instruction',{targetId:VIBE2,sessionId:room.id,text:'README 첫 줄'});
  await expect(w.host.perform(request('partner',{sessionId:voice,partner:{kind:'workroom',targetId:VIBE2,sessionId:room.id}}),authority)).rejects.toThrow(/초안/);
  const draft=(await w.host.perform(request('state',{sessionId:voice}),authority)).session!.draft!;
  await w.host.perform(request('discard',{sessionId:voice,draftId:draft.id}),authority);
  await w.terminal.perform({operation:'close',requestId:crypto.randomUUID(),sessionId:room.id});
  await until(()=>w.terminal.inspectSession(room.id,VIBE2).state==='exited','workroom to exit');
  await expect(w.host.perform(request('partner',{sessionId:voice,partner:{kind:'workroom',targetId:VIBE2,sessionId:room.id}}),authority)).rejects.toThrow(/실행 중/);
  await w.host.perform(request('stop',{sessionId:voice}),authority);
  // A phone allowed only OPS and vibe cannot switch to vibe2.
  const other=await running(w,VIBE2,'codex');
  const phone={owner:'remote:phone',active:()=>true,allowedTargets:new Set([OPS,VIBE])};
  const remoteVoice=(await w.host.perform(request('prepare',{target:{kind:'ops'},mode:'conversation',consent:true}),phone)).session!.id;
  await w.host.perform(request('connect',{sessionId:remoteVoice,sdp:'v=0'}),phone);
  expect((await w.host.perform(request('partners',{sessionId:remoteVoice}),phone)).partners!.map(p=>p.kind==='workroom'?p.targetId:'ops')).toEqual(['ops']);
  await expect(w.host.perform(request('partner',{sessionId:remoteVoice,partner:{kind:'workroom',targetId:VIBE2,sessionId:other.id}}),phone)).rejects.toThrow(/허용된 프로젝트/);
  await w.host.perform(request('stop',{sessionId:remoteVoice}),phone);
},30_000);

test('without record consent, switching still works and nothing is written',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w,false);
  await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'});
  say(w.provider,'u1','기록하지 마');
  await call(w.provider,'return_to_ops',{});
  await w.host.perform(request('stop',{sessionId:voice}),authority);
  expect((await w.store.list()).sessions).toEqual([]);
},30_000);

test('the model is told where this conversation is saved',async()=>{
  const w=await voiceWorld(cleanup);
  await opsVoice(w);
  expect(w.provider.input!.instructions).toContain('총괄과 나눈 대화는 OPS 음성 세션');
  expect(w.provider.input!.instructions).toContain('그 프로젝트의 음성 세션');
},30_000);

test('subtitles: a Korean line gets English and an English line gets Korean, from the session provider',async()=>{
  const calls:{provider:string;text:string;to:string}[]=[];
  const w=await voiceWorld(cleanup,{translate:async(provider,text,to)=>{calls.push({provider,text,to});return to==='en'?'Run the tests.':'테스트를 돌려 주세요.';}});
  const voice=await opsVoice(w,false);
  expect((await w.host.perform(request('caption',{sessionId:voice,text:'테스트 돌려 줘'}),authority)).caption).toEqual({text:'테스트 돌려 줘',translation:'Run the tests.',source:'ko'});
  expect((await w.host.perform(request('caption',{sessionId:voice,text:'Run the tests please'}),authority)).caption).toEqual({text:'Run the tests please',translation:'테스트를 돌려 주세요.',source:'en'});
  expect(calls).toEqual([{provider:'openai',text:'테스트 돌려 줘',to:'en'},{provider:'openai',text:'Run the tests please',to:'ko'}]);
  await w.host.perform(request('stop',{sessionId:voice}),authority);
  await expect(w.host.perform(request('caption',{sessionId:voice,text:'끝난 뒤'}),authority)).rejects.toThrow();
},30_000);

test('subtitles fail closed without a translator, and the source language follows the script',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w,false);
  await expect(w.host.perform(request('caption',{sessionId:voice,text:'안녕'}),authority)).rejects.toThrow(/자막 통역/);
  expect(voiceCaptionSource('AgentsToZ OPS에서 vibe2 커밋해 줘')).toBe('ko');
  expect(voiceCaptionSource('commit vibe2 on main')).toBe('en');
  expect(voiceCaptionSource('push 해')).toBe('ko');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('the wire accepts the new dock requests and answers, and nothing looser',()=>{
  const id='voice_0123456789abcdef';
  expect(normalizeVoiceRequest({action:'partners',requestId:'req_12345678',sessionId:id}).action).toBe('partners');
  expect(normalizeVoiceRequest({action:'partner',requestId:'req_12345678',sessionId:id,partner:{kind:'ops'}}).partner).toEqual({kind:'ops'});
  expect(normalizeVoiceRequest({action:'partner',requestId:'req_12345678',sessionId:id,partner:{kind:'workroom',targetId:VIBE2,sessionId:'ai_0123456789'}}).partner).toMatchObject({kind:'workroom'});
  expect(()=>normalizeVoiceRequest({action:'partner',requestId:'req_12345678',sessionId:id})).toThrow();
  expect(()=>normalizeVoiceRequest({action:'partner',requestId:'req_12345678',sessionId:id,partner:{kind:'workroom',targetId:VIBE2}})).toThrow();
  expect(()=>normalizeVoiceRequest({action:'caption',requestId:'req_12345678',sessionId:id})).toThrow();
  expect(()=>normalizeVoiceRequest({action:'caption',requestId:'req_12345678',sessionId:id,text:'x'.repeat(4001)})).toThrow();
  expect(normalizeVoiceResponse({partners:[{kind:'ops',label:'AgentsToZ OPS'},{kind:'workroom',label:'vibe',targetId:VIBE,sessionId:'ai_0123456789',agent:'codex'}]}).partners).toHaveLength(2);
  expect(()=>normalizeVoiceResponse({partners:[{kind:'ops',label:'AgentsToZ OPS',extra:1}]})).toThrow();
  expect(()=>normalizeVoiceResponse({partners:Array.from({length:10},()=>({kind:'ops',label:'x'}))})).toThrow();
  expect(normalizeVoiceResponse({caption:{text:'안녕',translation:'Hi',source:'ko'}}).caption).toEqual({text:'안녕',translation:'Hi',source:'ko'});
  expect(()=>normalizeVoiceResponse({caption:{text:'안녕',translation:'Hi',source:'jp'}})).toThrow();
});

test('on a phone, subtitles spend the live-voice budget, so a chatty conversation never starves the state check',async()=>{
  const {createMobileWorkspaceGateway}=await import('../src/mobileWorkspaceGateway');
  const performed:string[]=[];
  const gateway=createMobileWorkspaceGateway({
    terminal:async()=>{throw new Error('not used');},active:()=>true,
    resolve:async()=>[{controlId:'target-ops-1',runtimeTargetId:'runtime-ops'}],
    consent:async()=>({targetIds:new Set(['runtime-ops']),workspaceScopes:['voice.use'],isActive:()=>true,requestOwner:'device:h:c'}),
    perform:async(req:any)=>{const voice=req.workspace.voice;performed.push(voice.action);return {kind:'workspace',action:'voice',voice:voice.action==='caption'?{caption:{text:voice.text,translation:'t',source:'ko'}}:{}} as any;},
  } as any);
  const send=(voice:Record<string,unknown>)=>{const requestId=crypto.randomUUID();return gateway({operation:'workspace',requestId,targetId:'target-ops-1',workspace:{action:'voice',voice:{...voice,requestId}}} as never,[],'internet:s1');};
  // Ninety finished lines in a minute — far above the 60-per-minute read budget.
  for(let i=0;i<90;i++)await send({action:'caption',sessionId:'voice_0123456789abcdef',text:'줄 '+i});
  await send({action:'state',sessionId:'voice_0123456789abcdef'});
  expect(performed.filter(a=>a==='caption')).toHaveLength(90);
  expect(performed.at(-1)).toBe('state');
});

test('⋯ picks any allowed project: it lists projects (not the OPS project) and a choice opens or reuses its workroom',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  const all=(await w.host.perform(request('projects',{sessionId:voice}),authority)).projects!;
  expect(all.map(p=>p.label)).toEqual(expect.arrayContaining(['vibe','vibe2','헤르메스']));
  expect(all.some(p=>p.id===OPS)).toBe(false);
  expect((await w.host.perform(request('projects',{sessionId:voice,text:'Vibe Coding'}),authority)).projects!.map(p=>p.id)).toEqual([VIBE2]);
  // Nothing runs for vibe2: choosing it with no AI opens a Codex workroom and talks to it.
  const opened=await w.host.perform(request('partner',{sessionId:voice,partner:{kind:'project',targetId:VIBE2}}),authority);
  expect(opened.session!.activeTarget).toMatchObject({kind:'workroom',label:'vibe2',targetId:VIBE2,agent:'codex'});
  const codexRoom=(opened.session!.activeTarget as {sessionId:string}).sessionId;
  await until(async()=>(await output(w.terminal,codexRoom)).includes('READY:codex'),'the opened codex workroom');
  // Choosing it again without an AI reuses that running workroom; naming Claude opens Claude.
  await w.host.perform(request('partner',{sessionId:voice,partner:{kind:'ops'}}),authority);
  expect((await w.host.perform(request('partner',{sessionId:voice,partner:{kind:'project',targetId:VIBE2}}),authority)).session!.activeTarget).toMatchObject({sessionId:codexRoom});
  expect((await w.host.perform(request('partner',{sessionId:voice,partner:{kind:'project',targetId:VIBE2,agent:'claude'}}),authority)).session!.activeTarget).toMatchObject({targetId:VIBE2,agent:'claude'});
  say(w.provider,'u1','클로드야 상태 알려줘');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
  // Each stint of direct talk is its own record: codex, (back to 총괄) codex again, then claude.
  expect((await w.store.list(undefined,VIBE2)).sessions.map(s=>s.label)).toEqual(['vibe2 · claude','vibe2 · codex','vibe2 · codex']);
},30_000);

test('⋯ never opens a project outside what the phone is allowed',async()=>{
  const w=await voiceWorld(cleanup);
  const phone={owner:'remote:phone',active:()=>true,allowedTargets:new Set([OPS,VIBE])};
  const voice=(await w.host.perform(request('prepare',{target:{kind:'ops'},mode:'conversation',consent:true}),phone)).session!.id;
  await w.host.perform(request('connect',{sessionId:voice,sdp:'v=0'}),phone);
  expect((await w.host.perform(request('projects',{sessionId:voice}),phone)).projects!.map(p=>p.id)).toEqual([VIBE]);
  expect((await w.host.perform(request('projects.page',{sessionId:voice,offset:0}),phone)).projectPage).toEqual({projects:[{id:VIBE,label:'vibe'}],total:1,nextOffset:null});
  await expect(w.host.perform(request('partner',{sessionId:voice,partner:{kind:'project',targetId:VIBE2}}),phone)).rejects.toThrow(/허용된 프로젝트/);
  expect((await w.terminal.perform({operation:'list',requestId:crypto.randomUUID()})).sessions!.filter(s=>s.targetId===VIBE2)).toEqual([]);
  await w.host.perform(request('stop',{sessionId:voice}),phone);
},30_000);

test('the wire accepts a project choice and a project page, and nothing looser',()=>{
  const id='voice_0123456789abcdef';
  expect(normalizeVoiceRequest({action:'projects',requestId:'req_12345678',sessionId:id}).action).toBe('projects');
  expect(normalizeVoiceRequest({action:'projects',requestId:'req_12345678',sessionId:id,text:'vibe'}).text).toBe('vibe');
  expect(normalizeVoiceRequest({action:'projects.page',requestId:'req_12345678',sessionId:id,text:'vibe',offset:12}).offset).toBe(12);
  expect(()=>normalizeVoiceRequest({action:'projects.page',requestId:'req_12345678',sessionId:id,offset:-1})).toThrow();
  expect(()=>normalizeVoiceRequest({action:'projects',requestId:'req_12345678',sessionId:id,text:'x'.repeat(301)})).toThrow();
  expect(normalizeVoiceRequest({action:'partner',requestId:'req_12345678',sessionId:id,partner:{kind:'project',targetId:VIBE2,agent:'claude'}}).partner).toEqual({kind:'project',targetId:VIBE2,agent:'claude'});
  expect(()=>normalizeVoiceRequest({action:'partner',requestId:'req_12345678',sessionId:id,partner:{kind:'project',targetId:VIBE2,agent:'gpt'}})).toThrow();
  expect(()=>normalizeVoiceRequest({action:'partner',requestId:'req_12345678',sessionId:id,partner:{kind:'project',targetId:VIBE2,sessionId:'ai_0123456789'}})).toThrow();
  expect(normalizeVoiceResponse({projects:[{id:VIBE,label:'vibe'}]}).projects).toEqual([{id:VIBE,label:'vibe'}]);
  expect(normalizeVoiceResponse({projectPage:{projects:[{id:VIBE,label:'vibe'}],total:13,nextOffset:1}}).projectPage?.nextOffset).toBe(1);
  expect(()=>normalizeVoiceResponse({projectPage:{projects:[{id:VIBE,label:'vibe',path:'/Users/x'}],total:1,nextOffset:null}})).toThrow();
  expect(()=>normalizeVoiceResponse({projectPage:{projects:[],total:1,nextOffset:999}})).toThrow();
  expect(()=>normalizeVoiceResponse({projects:[{id:VIBE,label:'vibe',path:'/Users/x'}]})).toThrow();
  expect(()=>normalizeVoiceResponse({projects:Array.from({length:13},(_,i)=>({id:'target_'+String(i).padStart(8,'0'),label:'p'}))})).toThrow();
});

test('typing in the dock speaks to whoever is answering: the model hears it, answers aloud, and the record keeps it',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  const before=w.provider.outputs.length;
  await w.host.perform(request('say',{sessionId:voice,text:'오늘 할 일 정리해 줘'}),authority);
  const sent=w.provider.outputs.slice(before);
  expect(sent[0]).toMatchObject({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:'오늘 할 일 정리해 줘'}]}});
  expect(sent.some(e=>e.type==='response.create')).toBe(true);
  // Typed to a project AI after switching: that project's record, like speech.
  await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'});
  await w.host.perform(request('say',{sessionId:voice,text:'README 요약해 줘'}),authority);
  await w.host.perform(request('stop',{sessionId:voice}),authority);
  expect((await turns(w,voice)).map(t=>t.text)[0]).toBe('오늘 할 일 정리해 줘');
  const [segment]=(await w.store.list(undefined,VIBE2)).sessions;
  expect((await turns(w,segment!.id)).map(t=>t.text)).toEqual(['README 요약해 줘']);
  await expect(w.host.perform(request('say',{sessionId:voice,text:'끝난 뒤'}),authority)).rejects.toThrow();
  expect(()=>normalizeVoiceRequest({action:'say',requestId:'req_12345678',sessionId:'voice_0123456789abcdef'})).toThrow();
},30_000);

test('a phone names a workroom by its own project id; the host finds it by session and still checks the allowed projects',async()=>{
  const w=await voiceWorld(cleanup);
  const room=await running(w,VIBE,'codex'),other=await running(w,VIBE2,'claude');
  const phone={owner:'remote:phone',active:()=>true,allowedTargets:new Set([OPS,VIBE])};
  const voice=(await w.host.perform(request('prepare',{target:{kind:'ops'},mode:'conversation',consent:true}),phone)).session!.id;
  await w.host.perform(request('connect',{sessionId:voice,sdp:'v=0'}),phone);
  // The phone's workroom list carries its control id, not the Mac's runtime id.
  const switched=await w.host.perform(request('partner',{sessionId:voice,partner:{kind:'workroom',targetId:'control_id_on_phone_1',sessionId:room.id}}),phone);
  expect(switched.session!.activeTarget).toMatchObject({kind:'workroom',targetId:VIBE,sessionId:room.id,agent:'codex'});
  await expect(w.host.perform(request('partner',{sessionId:voice,partner:{kind:'workroom',targetId:'control_id_on_phone_2',sessionId:other.id}}),phone)).rejects.toThrow();
  await w.host.perform(request('stop',{sessionId:voice}),phone);
},30_000);

test('voice drives the workroom: after 「보내」 the draft is typed into the terminal and runs',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  // From the 총괄: a draft for a workroom, sent on the person's 「응, 보내」.
  const room=(await running(w,VIBE2,'claude')).id;
  expect(await call(w.provider,'prepare_workroom_instruction',{targetId:VIBE2,sessionId:room,text:'테스트 돌려 줘'})).toMatchObject({state:'awaiting-user'});
  expect(await output(w.terminal,room)).not.toContain('GOT:claude');
  // The person said 「응, 보내」: the model sends the prepared draft.
  expect(await call(w.provider,'send_prepared_instruction',{})).toMatchObject({state:'submitted'});
  await until(async()=>(await output(w.terminal,room)).includes('GOT:claude:테스트 돌려 줘'),'the instruction in the terminal');
  expect((await w.host.perform(request('state',{sessionId:voice}),authority)).session!.draft).toBeNull();
  expect(await call(w.provider,'send_prepared_instruction',{})).toMatchObject({error:expect.stringContaining('초안')});
  expect(w.provider.input!.instructions).toContain('send_prepared_instruction');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('a workroom waiting on a question is never typed into; the person answers it by voice with a named key',async()=>{
  const w=await voiceWorld(cleanup,{trustPrompt:'agy'});
  const voice=await opsVoice(w);
  const room=(await w.terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:VIBE2,agent:'agy',cols:100,rows:28})).session!.id;
  await until(async()=>(await output(w.terminal,room)).includes('Do you trust'),'the trust question');
  await call(w.provider,'prepare_workroom_instruction',{targetId:VIBE2,sessionId:room,text:'빌드해 줘'});
  const refused=await call(w.provider,'send_prepared_instruction',{});
  expect(refused.error).toMatch(/질문에 답을 기다리고/);
  expect(await output(w.terminal,room)).not.toContain('빌드해 줘');
  // 「예, 신뢰한다고 눌러줘」 → y then Enter.
  const answered=await call(w.provider,'answer_workroom_prompt',{keys:['y','enter']});
  expect(answered).toMatchObject({state:'keys-sent',keys:['y','enter']});
  await until(async()=>(await output(w.terminal,room)).includes('TRUSTED:y'),'the trust answer');
  await until(async()=>(await output(w.terminal,room)).includes('READY:agy'),'agy ready');
  expect(await call(w.provider,'send_prepared_instruction',{})).toMatchObject({state:'submitted'});
  await until(async()=>(await output(w.terminal,room)).includes('GOT:agy:빌드해 줘'),'the instruction after the answer');
  // Only named keys; nothing that raises permissions.
  expect((await call(w.provider,'answer_workroom_prompt',{keys:['shift-tab']})).error).toBeTruthy();
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('the dock’s 보내기 sends without the old checkbox, and the Mac still refuses a question screen',async()=>{
  const w=await voiceWorld(cleanup,{trustPrompt:'codex'});
  const voice=await opsVoice(w);
  const room=(await w.terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:VIBE,agent:'codex',cols:100,rows:28})).session!.id;
  await until(async()=>(await output(w.terminal,room)).includes('Do you trust'),'the trust question');
  await call(w.provider,'prepare_workroom_instruction',{targetId:VIBE,sessionId:room,text:'상태 알려줘'});
  const draft=(await w.host.perform(request('state',{sessionId:voice}),authority)).session!.draft!;
  await expect(w.host.perform(request('submit',{sessionId:voice,draftId:draft.id,text:draft.text,inputReady:true}),authority)).rejects.toThrow(/질문에 답을 기다리고/);
  expect((await w.host.perform(request('state',{sessionId:voice}),authority)).session!.draft).not.toBeNull();
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('a phone allowed several projects keeps its OPS voice working after prepare, and loses it when the grant shrinks',async()=>{
  const {remoteVoiceAllowedTargets}=await import('../src/remoteVoiceAuthority');
  const w=await voiceWorld(cleanup);
  const room=await running(w,VIBE,'codex');
  // api-server recomputes the grant for every request; later requests carry no target.
  let grant=[OPS,VIBE];
  const as=(voice:Record<string,unknown>)=>({owner:'remote:phone',active:()=>true,allowedTargets:remoteVoiceAllowedTargets(voice as any,OPS,new Set(grant))});
  const send=async(voice:Record<string,unknown>)=>{const r=request(voice.action as string,voice);return w.host.perform(r,as(r));};
  const voice=(await send({action:'prepare',target:{kind:'ops'},mode:'conversation',consent:true})).session!.id;
  await send({action:'connect',sessionId:voice,sdp:'v=0'});
  expect((await send({action:'partners',sessionId:voice})).partners!.map(p=>p.kind==='workroom'?p.targetId:'ops')).toEqual(['ops',VIBE]);
  expect((await send({action:'partner',sessionId:voice,partner:{kind:'workroom',targetId:'phone_control_id',sessionId:room.id}})).session!.activeTarget).toMatchObject({targetId:VIBE});
  await send({action:'say',sessionId:voice,text:'상태 알려줘'});
  // The Mac removed vibe from this phone: the next request is refused.
  grant=[OPS];
  await expect(send({action:'partners',sessionId:voice})).rejects.toThrow(/프로젝트가 요청과 다릅니다/);
  // A workroom-target prepare still reaches only its own project.
  expect([...remoteVoiceAllowedTargets({action:'prepare',target:{kind:'workroom'}},VIBE,new Set([OPS,VIBE]))]).toEqual([VIBE]);
  expect([...remoteVoiceAllowedTargets({action:'state'},VIBE,new Set([OPS,VIBE]))]).toEqual([OPS,VIBE]);
},30_000);

test('a reply still being spoken when the person switches stays with the project AI, and the marker counts it',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'});
  say(w.provider,'u1','테스트 결과 알려줘');
  // The project AI starts answering (item created) — Gemini announces its turn the same way now.
  w.provider.event({type:'conversation.item.added',item:{id:'gemini_7_out',type:'message',role:'assistant'}});
  await w.host.perform(request('partner',{sessionId:voice,partner:{kind:'ops'}}),authority);
  // The reply finishes after the tap.
  w.provider.event({type:'response.output_audio_transcript.done',item_id:'gemini_7_out',transcript:'테스트 3개 모두 통과했어요.'});
  say(w.provider,'u2','고마워 총괄');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
  const [segment]=(await w.store.list(undefined,VIBE2)).sessions;
  expect((await turns(w,segment!.id)).map(t=>t.text)).toEqual(['테스트 결과 알려줘','테스트 3개 모두 통과했어요.']);
  expect(segment).toMatchObject({turnCount:2,complete:true});
  // The marker is written once the late reply has landed, so it may follow speech already said to the 총괄.
  expect((await turns(w,voice)).map(t=>t.text).sort()).toEqual(['고마워 총괄',expect.stringContaining('직접 대화 2개 발언')].sort());
},30_000);

test('the sent receipt shows only under the workroom that received it; a send to the OPS workroom names its target',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'});
  await call(w.provider,'prepare_ops_instruction',{text:'vibe2 폴더 열어 줘'});
  expect(await call(w.provider,'send_prepared_instruction',{})).toMatchObject({state:'submitted'});
  const notice=(await w.host.perform(request('state',{sessionId:voice}),authority)).session!.notice;
  expect(notice.startsWith('아젠투지가 워크룸에 보냄')).toBe(false);
  expect(notice).toMatch(/^아젠투지가 AgentsToZ-Control · codex에 보냄: 「vibe2 폴더 열어 줘」/);
  // A relayed line lands in the partner's own box, so it gets the receipt there.
  say(w.provider,'u9','README 읽어 줘');
  await until(async()=>(await w.host.perform(request('state',{sessionId:voice}),authority)).session!.notice.startsWith('아젠투지가 워크룸에 보냄: 「README 읽어 줘」'),'the receipt');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('an OPS workroom question is answered by voice too, so an OPS draft is never stuck',async()=>{
  const w=await voiceWorld(cleanup,{trustPrompt:'codex'});
  const voice=await opsVoice(w);
  await call(w.provider,'prepare_ops_instruction',{text:'새 프로젝트 만들어 줘'});
  const room=(await w.terminal.perform({operation:'list',requestId:crypto.randomUUID()})).sessions!.find(s=>s.targetId===OPS)!.id;
  expect((await w.host.perform(request('state',{sessionId:voice}),authority)).session!.openedWorkroom).toMatchObject({kind:'workroom',targetId:OPS,sessionId:room,agent:'codex'});
  await until(async()=>(await output(w.terminal,room)).includes('Do you trust'),'the OPS trust question');
  expect((await call(w.provider,'send_prepared_instruction',{})).error).toMatch(/질문에 답을 기다리고/);
  expect(await call(w.provider,'answer_workroom_prompt',{keys:['y','enter']})).toMatchObject({state:'keys-sent'});
  await until(async()=>(await output(w.terminal,room)).includes('READY:codex'),'codex ready');
  expect(await call(w.provider,'send_prepared_instruction',{})).toMatchObject({state:'submitted'});
  await until(async()=>(await output(w.terminal,room)).includes('GOT:codex:새 프로젝트 만들어 줘'),'the OPS instruction');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('a person typing into the workroom still blocks the draft even after the voice answered a question',async()=>{
  const w=await voiceWorld(cleanup,{trustPrompt:'claude'});
  const voice=await opsVoice(w);
  const room=(await w.terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:VIBE2,agent:'claude',cols:100,rows:28})).session!.id;
  await until(async()=>(await output(w.terminal,room)).includes('Do you trust'),'the trust question');
  await call(w.provider,'prepare_workroom_instruction',{targetId:VIBE2,sessionId:room,text:'빌드해 줘'});
  expect((await call(w.provider,'send_prepared_instruction',{})).error).toMatch(/질문에 답을 기다리고/);
  // Someone types on the Mac, then the voice presses keys.
  await w.terminal.perform({operation:'input',requestId:crypto.randomUUID(),sessionId:room,data:'x'});
  await call(w.provider,'answer_workroom_prompt',{keys:['y','enter']});
  await until(async()=>(await output(w.terminal,room)).includes('READY:claude'),'claude ready');
  expect((await call(w.provider,'send_prepared_instruction',{})).error).toMatch(/입력이 변경/);
  expect(await output(w.terminal,room)).not.toContain('GOT:claude:빌드해 줘');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('two workrooms of one project and AI are told apart like the Workroom tabs, and start_workroom points to the dock',async()=>{
  const w=await voiceWorld(cleanup);
  const first=await running(w,VIBE,'codex');const second=await running(w,VIBE,'codex');
  const voice=await opsVoice(w);
  const listed=(await w.host.perform(request('partners',{sessionId:voice}),authority)).partners!;
  expect(listed.filter(p=>p.kind==='workroom').map(p=>[(p as any).sessionId,p.label])).toEqual([[second.id,'vibe #2'],[first.id,'vibe #1']]);
  const started=await call(w.provider,'start_workroom',{targetId:VIBE2,agent:'claude'});
  expect(started.message).not.toContain('음성 버튼');expect(started.message).toContain('connect_project_delegate');
  expect((await w.host.perform(request('state',{sessionId:voice}),authority)).session!.openedWorkroom).toMatchObject({
    kind:'workroom',targetId:VIBE2,sessionId:started.session.id,agent:'claude',label:'vibe2',
  });
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('items that never carry a transcript (tool calls, results, notes, typed text) do not hold a project record open',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'});
  // What OpenAI echoes back for the host's own items while talking to the project AI.
  for(const item of [{id:'item_fc1',type:'function_call'},{id:'item_fco1',type:'function_call_output'},{id:'item_note1',type:'message',role:'user',content:[{type:'input_text'}]}])w.provider.event({type:'conversation.item.added',item});
  await w.host.perform(request('say',{sessionId:voice,text:'README 요약해 줘'}),authority);
  // (While relaying, typed text goes to the workroom, not to the voice model, so it is never echoed.)
  // A reply that was cut off never gets its transcript.
  w.provider.event({type:'conversation.item.added',item:{id:'item_cut',type:'message',role:'assistant'}});
  w.provider.event({type:'response.done',response:{output:[{id:'item_cut',status:'incomplete'}]}});
  say(w.provider,'u1','고마워');
  await w.host.perform(request('partner',{sessionId:voice,partner:{kind:'ops'}}),authority);
  await w.host.perform(request('stop',{sessionId:voice}),authority);
  const [segment]=(await w.store.list(undefined,VIBE2)).sessions;
  expect(segment).toMatchObject({turnCount:2,complete:true});
  await w.store.assertRememberable(segment!.id);
},30_000);

test('a key answer goes to the workroom whose question blocked the send, not to the connected project AI',async()=>{
  const w=await voiceWorld(cleanup,{trustPrompt:'codex'});
  const voice=await opsVoice(w);
  const vibe2=(await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'})).activeTarget.sessionId as string;
  await call(w.provider,'prepare_ops_instruction',{text:'새 프로젝트 만들어 줘'});
  const ops=(await w.terminal.perform({operation:'list',requestId:crypto.randomUUID()})).sessions!.find(s=>s.targetId===OPS)!.id;
  await until(async()=>(await output(w.terminal,ops)).includes('Do you trust'),'the OPS question');
  expect((await call(w.provider,'send_prepared_instruction',{})).error).toMatch(/질문에 답을 기다리고/);
  expect(await call(w.provider,'answer_workroom_prompt',{keys:['y','enter']})).toMatchObject({state:'keys-sent',sessionId:ops});
  await until(async()=>(await output(w.terminal,ops)).includes('READY:codex'),'the OPS workroom ready');
  expect(await output(w.terminal,vibe2)).not.toContain('GOT:claude:y');
  expect(await call(w.provider,'send_prepared_instruction',{})).toMatchObject({state:'submitted'});
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('a switch that finishes after the voice ended opens no record that stays open forever',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  const pending=call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'}).catch(()=>null);
  await w.host.perform(request('stop',{sessionId:voice}),authority);
  await pending;await Bun.sleep(100);
  expect((await w.store.list(undefined,VIBE2)).sessions.filter(s=>s.endedAt===null)).toEqual([]);
},30_000);

test('the OpenAI Realtime wire never carries the host-only `silent` hint',async()=>{
  const {realtimeWireEvent}=await import('../src/voiceRealtimeProvider');
  const item={type:'message',role:'user',content:[{type:'input_text',text:'[화면 전환 · 명령 아님]'}]};
  expect(realtimeWireEvent({type:'conversation.item.create',silent:true,item})).toEqual({type:'conversation.item.create',item});
  expect(realtimeWireEvent({type:'response.create'})).toEqual({type:'response.create'});
});

const relayMode=(p:ScriptedProvider)=>p.outputs.filter(e=>e.type==='session.update').map(e=>e.session.audio.input.turn_detection.create_response);

test('talking to a project AI relays: what the person says goes into that workroom as typed, and its output is read back',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  const room=(await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'})).activeTarget.sessionId as string;
  await until(async()=>(await output(w.terminal,room)).includes('READY:claude'),'claude ready');
  // OpenAI stops answering on its own while relaying; the host asks for a reply when output arrives.
  expect(relayMode(w.provider).at(-1)).toBe(false);
  say(w.provider,'u1','README 요약해 줘');
  await until(async()=>(await output(w.terminal,room)).includes('GOT:claude:README 요약해 줘'),'the spoken line in the terminal');
  expect((await w.host.perform(request('state',{sessionId:voice}),authority)).session!.draft).toBeNull();
  await until(()=>w.provider.outputs.some(e=>e.type==='conversation.item.create'&&JSON.stringify(e.item).includes('워크룸 실제 출력 관찰')),'the observed output for the model');
  // Typed in the dock: the same relay.
  await w.host.perform(request('say',{sessionId:voice,text:'테스트도 돌려 줘'}),authority);
  await until(async()=>(await output(w.terminal,room)).includes('GOT:claude:테스트도 돌려 줘'),'the typed line in the terminal');
  // 「아젠투지, …」 is for 아젠투지, never the workroom.
  const responses=w.provider.outputs.filter(e=>e.type==='response.create').length;
  say(w.provider,'u2','아젠투지, 총괄로 돌아가');
  await Bun.sleep(150);
  expect(await output(w.terminal,room)).not.toContain('총괄로 돌아가');
  expect(w.provider.outputs.filter(e=>e.type==='response.create').length).toBeGreaterThan(responses);
  await call(w.provider,'return_to_ops',{});
  expect(relayMode(w.provider).at(-1)).toBe(true);
  // Back with the 총괄: speech is conversation again, not typed anywhere.
  say(w.provider,'u3','오늘 뭐 했지');await Bun.sleep(150);
  expect(await output(w.terminal,room)).not.toContain('오늘 뭐 했지');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('relaying never types into a question; the model is told what is on screen',async()=>{
  const w=await voiceWorld(cleanup,{trustPrompt:'claude'});
  const voice=await opsVoice(w);
  const room=(await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'})).activeTarget.sessionId as string;
  await until(async()=>(await output(w.terminal,room)).includes('Do you trust'),'the trust question');
  say(w.provider,'u1','빌드해 줘');
  await until(()=>w.provider.outputs.some(e=>e.type==='conversation.item.create'&&JSON.stringify(e.item).includes('질문에 답을 기다리고')),'the refusal told to the model');
  expect(await output(w.terminal,room)).not.toContain('빌드해 줘');
  expect(await call(w.provider,'answer_workroom_prompt',{keys:['y','enter']})).toMatchObject({state:'keys-sent',sessionId:room});
  await until(async()=>(await output(w.terminal,room)).includes('READY:claude'),'claude ready');
  say(w.provider,'u2','이제 빌드해 줘');
  await until(async()=>(await output(w.terminal,room)).includes('GOT:claude:이제 빌드해 줘'),'the line after the answer');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('who 아젠투지 is addressed by, across real transcripts',async()=>{
  const {addressedToAgentsToZ}=await import('../src/voiceOrchestrationGuidance');
  for(const said of ['아젠투지, 총괄로 돌아가','음, 아젠투지 총괄로 돌아가','아젠 투지 돌아가','에이전트 투 지 불러 줘','총괄로 돌아가','총괄, 대학원 담당자 불러','메인으로 돌아가','테스트 돌려. 아젠투지 총괄로 돌아가','AgentsToZ back to main'])
    expect([said,addressedToAgentsToZ(said)]).toEqual([said,true]);
  for(const said of ['총괄적으로 리팩터링해 줘','README 요약해 줘','테스트 돌려 줘','아젠다 정리해 줘'])
    expect([said,addressedToAgentsToZ(said)]).toEqual([said,false]);
});

test('relaying: 「음, 아젠투지…」 and 「메인으로 돌아가」 stay with 아젠투지; 「총괄적으로…」 is typed',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  const room=(await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'})).activeTarget.sessionId as string;
  await until(async()=>(await output(w.terminal,room)).includes('READY:claude'),'claude ready');
  say(w.provider,'u1','음, 아젠투지 총괄로 돌아가');say(w.provider,'u2','메인으로 돌아가');say(w.provider,'u3','총괄적으로 리팩터링해 줘');
  await until(async()=>(await output(w.terminal,room)).includes('GOT:claude:총괄적으로 리팩터링해 줘'),'the refactor line');
  const text=await output(w.terminal,room);
  expect(text).not.toContain('총괄로 돌아가');expect(text).not.toContain('메인으로 돌아가');
  // A draft is never made while relaying (it would type the words twice).
  expect((await call(w.provider,'prepare_delegate_instruction',{text:'테스트'})).error).toMatch(/그대로 입력/);
  expect((await call(w.provider,'prepare_workroom_instruction',{targetId:VIBE2,sessionId:room,text:'테스트'})).error).toMatch(/그대로 입력/);
  // The Mac says it relays.
  expect((await w.host.perform(request('relay',{sessionId:voice}),authority)).session!.id).toBe(voice);
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('speech that finishes after a switch is typed nowhere, and the person is told',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  const room=(await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'})).activeTarget.sessionId as string;
  await until(async()=>(await output(w.terminal,room)).includes('READY:claude'),'claude ready');
  say(w.provider,'late1','이 테스트 지워 줘',{transcribeNow:false});
  await w.host.perform(request('partner',{sessionId:voice,partner:{kind:'ops'}}),authority);
  w.provider.event({type:'conversation.item.input_audio_transcription.completed',item_id:'late1',transcript:'이 테스트 지워 줘'});
  await Bun.sleep(200);
  expect(await output(w.terminal,room)).not.toContain('이 테스트 지워 줘');
  expect((await w.host.perform(request('state',{sessionId:voice}),authority)).session!.notice).toContain('입력하지 않았습니다');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('a burst of relayed lines gets one spoken read-back, and a refused line reaches the model with its words',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  const room=(await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'})).activeTarget.sessionId as string;
  await until(async()=>(await output(w.terminal,room)).includes('READY:claude'),'claude ready');
  say(w.provider,'b1','첫째 줄');say(w.provider,'b2','둘째 줄');
  await until(async()=>(await output(w.terminal,room)).includes('GOT:claude:둘째 줄'),'both lines');
  await Bun.sleep(3500);
  expect(w.provider.outputs.filter(e=>e.type==='conversation.item.create'&&JSON.stringify(e.item).includes('워크룸 실제 출력 관찰'))).toHaveLength(1);
  await w.host.perform(request('stop',{sessionId:voice}),authority);

  const q=await voiceWorld(cleanup,{trustPrompt:'claude'});
  const v2=await opsVoice(q);
  const r2=(await call(q.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'})).activeTarget.sessionId as string;
  await until(async()=>(await output(q.terminal,r2)).includes('Do you trust'),'the trust question');
  await q.host.perform(request('say',{sessionId:v2,text:'1'}),authority);
  await until(()=>q.provider.outputs.some(e=>e.type==='conversation.item.create'&&JSON.stringify(e.item).includes('「1」')),'the refused words for the model');
  expect((await q.host.perform(request('state',{sessionId:v2}),authority)).session!.notice).toContain('전달하지 못함');
  await q.host.perform(request('stop',{sessionId:v2}),authority);
},40_000);

test('a workroom voice (a phone without OPS) relays too, from the start',async()=>{
  const w=await voiceWorld(cleanup);
  const room=await running(w,VIBE,'codex');
  const voice=(await w.host.perform(request('prepare',{target:{kind:'workroom',targetId:VIBE,sessionId:room.id},mode:'conversation',consent:true}),authority)).session!.id;
  await w.host.perform(request('connect',{sessionId:voice,sdp:'v=0'}),authority);
  expect(relayMode(w.provider)).toEqual([false]);
  expect(w.provider.input!.tools.map(t=>t.name)).not.toContain('prepare_instruction');
  say(w.provider,'w1','린트 돌려 줘');
  await until(async()=>(await output(w.terminal,room.id)).includes('GOT:codex:린트 돌려 줘'),'the spoken line');
  await w.host.perform(request('say',{sessionId:voice,text:'테스트도'}),authority);
  await until(async()=>(await output(w.terminal,room.id)).includes('GOT:codex:테스트도'),'the typed line');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('Enter or a digit that would choose 「No, exit」 is recognised; other answers are not',async()=>{
  const {workroomKeyChoosesExit}=await import('../src/workroomOrchestration');
  const claude=['Quick safety check: Is this a project you trust?','','❯ No, exit','  Yes, I trust this folder','','Enter to confirm · Esc to cancel'];
  expect(workroomKeyChoosesExit(claude,'enter')).toBe('No, exit');
  expect(workroomKeyChoosesExit(['❯ Yes, I trust this folder','  No, exit'],'enter')).toBeNull();
  expect(workroomKeyChoosesExit(['> 1. Yes, I trust this folder','  2. No, exit'],'2')).toBe('No, exit');
  expect(workroomKeyChoosesExit(['> 1. Yes, I trust this folder','  2. No, exit'],'1')).toBeNull();
  expect(workroomKeyChoosesExit(['> 1. Yes, I trust this folder','  2. No, exit'],'down')).toBeNull();
  // Denying one permission is a normal answer; only leaving the CLI is refused.
  expect(workroomKeyChoosesExit(['Do you want to proceed?','  1. Yes','❯ 2. No, and tell Claude what to do differently (esc)'],'enter')).toBeNull();
});

test('the voice never presses Enter on a highlighted 「No, exit」, and moves the highlight first (VOC 2026-09-30)',async()=>{
  const w=await voiceWorld(cleanup,{trustPrompt:'claude',exitFirst:true});
  const voice=await opsVoice(w);
  const room=(await w.terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:VIBE,agent:'claude',cols:100,rows:28})).session!.id;
  await until(async()=>(await output(w.terminal,room)).includes('No, exit'),'the exit-first trust screen');
  await w.host.perform(request('partner',{sessionId:voice,partner:{kind:'workroom',targetId:VIBE,sessionId:room}}),authority);
  const refused=await call(w.provider,'answer_workroom_prompt',{keys:['enter']});
  expect(refused.error).toMatch(/No, exit/);
  await Bun.sleep(300);
  expect(await output(w.terminal,room)).not.toContain('EXITED');
  expect(w.terminal.inspectSession(room,VIBE).state).toBe('running');
  expect(await call(w.provider,'answer_workroom_prompt',{keys:['down','enter']})).toMatchObject({state:'keys-sent'});
  await until(async()=>(await output(w.terminal,room)).includes('READY:claude'),'claude trusted and ready');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('when the partner’s workroom ends, the dock returns to the 총괄 and says why',async()=>{
  const w=await voiceWorld(cleanup,{trustPrompt:'claude',exitFirst:true});
  const voice=await opsVoice(w);
  const room=(await w.terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:VIBE,agent:'claude',cols:100,rows:28})).session!.id;
  await until(async()=>(await output(w.terminal,room)).includes('No, exit'),'the exit-first trust screen');
  expect((await w.host.perform(request('partner',{sessionId:voice,partner:{kind:'workroom',targetId:VIBE,sessionId:room}}),authority)).session!.activeTarget).toMatchObject({kind:'workroom',sessionId:room});
  // The person answers in the workroom itself (or anything else ends the CLI).
  await w.terminal.perform({operation:'input',requestId:crypto.randomUUID(),sessionId:room,data:'\r'});
  await until(()=>w.terminal.inspectSession(room,VIBE).state==='exited','the workroom exit');
  const before=w.provider.outputs.length;
  const state=(await w.host.perform(request('state',{sessionId:voice}),authority)).session!;
  expect(state.activeTarget).toEqual({kind:'ops',label:'AgentsToZ OPS'});
  expect(state.notice).toMatch(/vibe.*Claude 워크룸이 종료되어 총괄로 돌아왔습니다/);
  const told=w.provider.outputs.slice(before).map(e=>JSON.stringify(e)).join('\n');
  expect(told).toContain('워크룸 CLI가 종료되었습니다');
  expect(told).toContain('create_response":true'); // the 총괄 answers speech again
  // Said once: the next poll is quiet.
  const again=(await w.host.perform(request('state',{sessionId:voice}),authority)).session!;
  expect(w.provider.outputs.slice(before).filter(e=>JSON.stringify(e).includes('워크룸 CLI가 종료되었습니다')).length).toBe(1);
  expect(again.activeTarget).toEqual({kind:'ops',label:'AgentsToZ OPS'});
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('typed # 언급: the 총괄 hears the exact project, a relayed workroom gets its folder',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  await w.host.perform(request('say',{sessionId:voice,text:'#vibe2 상태 알려줘',references:[VIBE2]}),authority);
  const heard=w.provider.outputs.filter(e=>e.type==='conversation.item.create'&&e.item?.role==='user').map(e=>e.item.content[0].text).pop();
  expect(heard).toContain('#vibe2 상태 알려줘');
  expect(heard).toContain(`targetId ${VIBE2}`);
  // An unregistered id is refused, not passed on.
  await expect(w.host.perform(request('say',{sessionId:voice,text:'#x 봐 줘',references:['not_a_project_1']}),authority)).rejects.toThrow();
  const room=await running(w,VIBE,'codex');
  await w.host.perform(request('partner',{sessionId:voice,partner:{kind:'workroom',targetId:VIBE,sessionId:room.id}}),authority);
  await w.host.perform(request('say',{sessionId:voice,text:'#vibe2 방식대로 고쳐 줘',references:[VIBE2]}),authority);
  await until(async()=>/GOT:codex:#vibe2 방식대로 고쳐 줘 \(참고 프로젝트 · [^)]*vibe2=/.test(await output(w.terminal,room.id)),'the relayed words with the # folder');
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);

test('typed @ 호출: one message into that project’s workroom, the partner stays the 총괄',async()=>{
  const w=await voiceWorld(cleanup);
  const voice=await opsVoice(w);
  const room=await running(w,VIBE2,'codex');
  const after=(await w.host.perform(request('say',{sessionId:voice,text:'테스트 돌려 줘',route:VIBE2}),authority)).session!;
  expect(after.activeTarget).toEqual({kind:'ops',label:'AgentsToZ OPS'});
  expect(after.openedWorkroom).toBeUndefined(); // Routing to an existing session does not keep opening windows.
  expect(after.notice).toMatch(/vibe2.*Codex에 보냄: 「테스트 돌려 줘」/);
  await until(async()=>(await output(w.terminal,room.id)).includes('GOT:codex:테스트 돌려 줘'),'the routed words');
  // Without a running workroom the words are the new workroom's first request, never typed into its first screen.
  const before=w.provider.outputs.length;
  const openedFromVoice=(await w.host.perform(request('say',{sessionId:voice,text:'README 읽어 줘',route:VIBE}),authority)).session!;
  const opened=(await w.terminal.perform({operation:'list',requestId:crypto.randomUUID()})).sessions!.find(s=>s.targetId===VIBE&&s.state==='running')!;
  expect(openedFromVoice.openedWorkroom).toMatchObject({kind:'workroom',targetId:VIBE,sessionId:opened.id,agent:'codex'});
  expect(openedFromVoice.openedWorkroom?.eventId).toBeTruthy();
  await until(async()=>(await output(w.terminal,opened.id)).includes('README 읽어 줘'),'the first request as a launch argument');
  expect(await output(w.terminal,opened.id)).not.toContain('GOT:');
  expect(w.provider.outputs.slice(before).map(e=>JSON.stringify(e)).join('')).toContain('@ 호출로');
  // The 총괄 itself is not an @ target, and a pending draft blocks it.
  await expect(w.host.perform(request('say',{sessionId:voice,text:'x',route:OPS}),authority)).rejects.toThrow(/@ 없이/);
  expect(()=>normalizeVoiceRequest({action:'say',requestId:crypto.randomUUID(),sessionId:voice,text:'x',route:'../etc'})).toThrow(/@ 호출/);
  expect(()=>normalizeVoiceRequest({action:'say',requestId:crypto.randomUUID(),sessionId:voice,text:'x',references:Array.from({length:9},(_,i)=>'target_'+i+'_fixture')})).toThrow(/# 언급/);
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},30_000);
