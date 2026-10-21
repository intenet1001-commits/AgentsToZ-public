import {afterEach,expect,test} from 'bun:test';
import {OPS,VIBE,VIBE2,HERMES,authority,request,voiceWorld,output,until,call} from './fixtures/voice-world';

/**
 * The whole voice orchestration path with only the speech provider scripted (tests/fixtures/voice-world.ts).
 * The OPS workroom runs on Antigravity; the project delegate on Claude.
 */
const cleanup:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const step of cleanup.splice(0).reverse())await step();});
const world=()=>voiceWorld(cleanup);

test('OPS on Antigravity delegates 「바이브2 담당자」 to a Claude workroom by voice, and each voice keeps its own record',async()=>{
  const w=await world();
  // The OPS workroom was opened with Antigravity.
  const opsRoom=(await w.terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:OPS,agent:'agy',cols:100,rows:28})).session!;
  await until(async()=>(await output(w.terminal,opsRoom.id)).includes('READY:agy'),'the OPS agy workroom');

  const opsVoice=(await w.host.perform(request('prepare',{target:{kind:'ops'},mode:'conversation',consent:true,recordConsent:true}),authority)).session!.id;
  await w.host.perform(request('connect',{sessionId:opsVoice,sdp:'v=0'}),authority);

  // 1. The transcribed 「바이브2」 misses, and the answer hands back the exact names.
  const miss=await call(w.provider,'resolve_target_alias',{alias:'바이브2 담당자'});
  expect(miss).toMatchObject({resolved:false,code:'TARGET_ALIAS_NOT_FOUND'});
  expect(miss.candidates).toContainEqual({id:VIBE2,name:'vibe2',aliases:['Vibe Coding Guide v2']});
  // 2. The model maps the pronunciation to the exact name.
  expect(await call(w.provider,'resolve_target_alias',{alias:'vibe2'})).toEqual({resolved:true,kind:'project',projectId:VIBE2,projectName:'vibe2',role:'managed'});
  // 3. 「클로드로」: a Claude workroom is opened even though codex/agy exist elsewhere.
  const connected=await call(w.provider,'connect_project_delegate',{targetId:VIBE2,agent:'claude'});
  expect(connected).toMatchObject({state:'delegate-connected',agent:'claude',reused:false,activeTarget:{kind:'workroom',label:'vibe2',targetId:VIBE2,agent:'claude'}});
  const claudeRoom=connected.activeTarget.sessionId as string;
  expect((await w.host.perform(request('state',{sessionId:opsVoice}),authority)).session!.activeTarget).toMatchObject({kind:'workroom',targetId:VIBE2,sessionId:claudeRoom,agent:'claude'});
  await until(async()=>(await output(w.terminal,claudeRoom)).includes('READY:claude'),'the Claude workroom');

  // 4. Talking to the project AI relays (VOC 2026-09-30): what the person says is typed into its workroom; no draft.
  expect((await call(w.provider,'prepare_delegate_instruction',{text:'README 첫 줄을 알려줘'})).error).toMatch(/그대로 입력/);
  w.provider.event({type:'input_audio_buffer.committed',item_id:'relay_user_1'});
  w.provider.event({type:'conversation.item.input_audio_transcription.completed',item_id:'relay_user_1',transcript:'README 첫 줄을 알려줘'});
  await until(async()=>(await output(w.terminal,claudeRoom)).includes('GOT:claude:README 첫 줄을 알려줘'),'Claude to receive the instruction');
  expect(await output(w.terminal,opsRoom.id)).not.toContain('GOT:');

  // 5. Calling the project again without naming an AI reuses the running Claude workroom.
  expect(await call(w.provider,'connect_project_delegate',{targetId:VIBE2})).toMatchObject({agent:'claude',reused:true,activeTarget:{sessionId:claudeRoom}});
  // 6. App/folder requests go to the running OPS workroom — on Antigravity, as it was opened.
  expect(await call(w.provider,'prepare_ops_instruction',{text:'vibe2 폴더를 Finder로 열어 줘'})).toMatchObject({state:'awaiting-user',agent:'agy',reused:true,target:'AgentsToZ-Control · agy'});
  const opsDraft=(await w.host.perform(request('state',{sessionId:opsVoice}),authority)).session!.draft!;
  await w.host.perform(request('discard',{sessionId:opsVoice,draftId:opsDraft.id}),authority);
  expect((await w.terminal.perform({operation:'list',requestId:crypto.randomUUID()})).sessions!.filter(session=>session.state==='running').map(session=>`${session.targetId}:${session.agent}`).sort()).toEqual([`${OPS}:agy`,`${VIBE2}:claude`].sort());

  // What was said after switching to vibe2's delegate is vibe2's record (VOC 2026-09-29: talking
  // straight to a staff member is not the department head's conversation); OPS keeps one line about it.
  w.provider.event({type:'conversation.item.input_audio_transcription.completed',item_id:'delegate_user_1',transcript:'테스트 상태 알려줘'});
  w.provider.event({type:'response.output_audio_transcript.done',item_id:'delegate_ai_1',transcript:'vibe2 Claude 워크룸은 대기 중입니다.'});
  expect((await w.host.perform(request('stop',{sessionId:opsVoice}),authority)).session!.state).toBe('ended');

  // A voice conversation started inside the vibe2 workroom stays with vibe2.
  const projectVoice=(await w.host.perform(request('prepare',{target:{kind:'workroom',targetId:VIBE2,sessionId:claudeRoom},mode:'conversation',consent:true,recordConsent:true}),authority)).session!;
  expect(projectVoice.label).toBe('vibe2 · claude');
  await w.host.perform(request('connect',{sessionId:projectVoice.id,sdp:'v=0'}),authority);
  w.provider.event({type:'conversation.item.input_audio_transcription.completed',item_id:'project_user_1',transcript:'테스트를 다시 돌려 줘'});
  await w.host.perform(request('stop',{sessionId:projectVoice.id}),authority);

  const opsHistory=(await w.store.list(undefined,'ops')).sessions,projectHistory=(await w.store.list(undefined,VIBE2)).sessions;
  expect(opsHistory.map(session=>session.id)).toEqual([opsVoice]);
  expect(opsHistory[0]).toMatchObject({kind:'ops',targetId:null,label:'AgentsToZ OPS',turnCount:1,complete:true});
  expect(projectHistory.map(session=>session.id)[0]).toBe(projectVoice.id);
  expect(projectHistory[0]).toMatchObject({kind:'workroom',targetId:VIBE2,label:'vibe2 · claude',turnCount:1,complete:true});
  // The relayed line plus the two spoken after the switch.
  expect(projectHistory[1]).toMatchObject({kind:'workroom',targetId:VIBE2,label:'vibe2 · claude',turnCount:3,complete:true});
  expect((await w.store.list()).scopes).toEqual([{key:VIBE2,kind:'workroom',label:'vibe2'},{key:'ops',kind:'ops',label:'AgentsToZ OPS'}]);
  await w.store.assertRememberable(projectHistory[1]!.id);
  await w.store.assertRememberable(opsVoice);await w.store.assertRememberable(projectVoice.id);
},30_000);

test('by voice, 「헤르메스 담당자」 and 「아젠투지개발」 resolve exactly as they do in chat',async()=>{
  const w=await world();
  const voice=(await w.host.perform(request('prepare',{target:{kind:'ops'},mode:'conversation',consent:true}),authority)).session!.id;
  await w.host.perform(request('connect',{sessionId:voice,sdp:'v=0'}),authority);
  expect(await call(w.provider,'resolve_target_alias',{alias:'헤르메스 담당자'})).toMatchObject({resolved:true,projectId:HERMES,projectName:'헤르메스'});
  expect(await call(w.provider,'resolve_target_alias',{alias:'Claude Agent Config'})).toMatchObject({resolved:true,projectId:HERMES});
  // No DEV folder is registered here: the DEV alias says so instead of guessing.
  expect(await call(w.provider,'resolve_target_alias',{alias:'아젠투지개발'})).toMatchObject({resolved:false,candidates:[]});
  const listed=await call(w.provider,'list_projects',{query:'vibe'});
  expect(listed).toMatchObject({total:2,nextOffset:null});
  expect(listed.projects.map((project:{name:string})=>project.name).sort()).toEqual(['vibe','vibe2']);
  await w.host.perform(request('stop',{sessionId:voice}),authority);
},20_000);
