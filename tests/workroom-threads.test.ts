import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,chmodSync,rmSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkroomThreadStore} from '../src/workroomThreadStore';
import {WorkroomThreadService,type WorkroomThreadDependencies} from '../src/workroomThreadService';
import {normalizeWorkroomThreadResult,normalizeWorkroomThreadRequest} from '../src/workroomThreadProtocol';
import {normalizeMobileWorkspaceRequest,normalizeMobileWorkspaceResult} from '../src/mobileWorkspaceProtocol';
import {normalizeWorkroomThreadPublish,normalizeWorkroomThreadRead} from '../src/workroomThreadMcp';
import {workroomThreadLifecycleHost,workroomThreadSaveConsent} from '../src/workroomThreadLifecycleHost';
import {AiTerminalService} from '../src/aiTerminalService';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {workroomThreadTerminalAdapter} from '../src/workroomThreadTerminalAdapter';
import {submitWorkroomDraft} from '../src/workroomSubmissionClient';
import {workroomThreadProjectFingerprint} from '../src/workroomThreadIdentity';
import {Database} from 'bun:sqlite';
import {createMobileWorkspaceGateway} from '../src/mobileWorkspaceGateway';
import {handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {parseWorkroomCallerHint} from '../src/workroomCaller';

const cleanup:(()=>void)[]=[];afterEach(()=>{for(const fn of cleanup.splice(0))fn();});
function fixture(overrides:Partial<WorkroomThreadDependencies>={}){
 const root=mkdtempSync(join(tmpdir(),'workroom-threads-'));chmodSync(root,0o700);cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 let key:Buffer|null=null,active=true,fingerprint='original-folder';const writes:string[]=[],starts:string[]=[],revisions=new Map<string,number>();
 const store=new WorkroomThreadStore(root,{read:async()=>key?Buffer.from(key):null,create:async()=>{key=Buffer.alloc(32,7);return Buffer.from(key);}});
 let service:WorkroomThreadService;
 const deps:WorkroomThreadDependencies={store,resolve:async()=>({fingerprint}),inspect:id=>({state:'running',inputRevision:revisions.get(id)??0}),
  start:async(id,targetId,agent)=>{starts.push(id);const sessionId=crypto.randomUUID();revisions.set(sessionId,0);return {written:true,session:{id:sessionId,targetId,agent,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:100,rows:28}};},
  reply:async(_id,sessionId,text,revision)=>{if(revision!==revisions.get(sessionId))throw Error('input revision changed');writes.push(text);revisions.set(sessionId,revision+1);await service.input(sessionId,text+'\r',revision+1);return {written:true};},...overrides};
 service=new WorkroomThreadService(deps);
 const access={owner:'phone-one',active:()=>active,readAll:false};
 const target='project-thread-one',call=(action:Parameters<typeof service.perform>[0],body:Parameters<typeof service.perform>[1],id=crypto.randomUUID())=>service.perform(action,body,target,id,access);
 const create=async(text='모바일 로그인 오류를 수정해줘',id=crypto.randomUUID())=>{await call('workroom.threads.create',{agent:'codex',text},id);await service.idle();return (await call('workroom.threads.read',{threadId:id})).thread!;};
 return {root,store,service,deps,access,target,call,create,writes,starts,revisions,revoke:()=>{active=false;},changeFolder:()=>{fingerprint='different-folder';},loseKey:()=>{key=null;}};
}
describe('task threads own one project Workroom',()=>{
 test('host final answers survive a different explicit result, preserving follow-up answers',async()=>{
  const f=fixture(),t=await f.create(),session=t.sessionId!;
  await f.service.completed(session,{key:'codex:first',resultText:'첫 결과'},0,()=>true);
  await f.service.publish(session,crypto.randomUUID(),'result','첫 결과');
  let r=await f.call('workroom.threads.read',{threadId:t.id});expect(r.messages!.filter(m=>m.kind==='result')).toHaveLength(1);
  await f.call('workroom.threads.reply',{threadId:t.id,text:'후속 요청',expectedRevision:r.thread!.revision});
  await f.service.publish(session,crypto.randomUUID(),'result','직접 게시 결과');
  await f.service.completed(session,{key:'codex:second',resultText:'CLI 완료 답변'},1,()=>true);
  r=await f.call('workroom.threads.read',{threadId:t.id});expect(r.messages!.filter(m=>m.kind==='result').map(m=>m.text)).toEqual(['첫 결과','직접 게시 결과','CLI 완료 답변']);
 });
 test('an early tool result cannot suppress the real final answer, and duplicate completion never re-executes',async()=>{
  const f=fixture(),t=await f.create('잘작동하지?'),session=t.sessionId!;
  await f.service.publish(session,crypto.randomUUID(),'result','메시지 수신과 MCP 연결을 확인하고 스레드에 기록합니다.');
  const c={key:'codex:actual-final',resultText:'네, 현재 연결은 정상입니다. 앱 전체 기능을 테스트한 것은 아닙니다.'};
  await f.service.completed(session,c,0,()=>true);await f.service.completed(session,c,0,()=>true);
  expect((await f.store.get(t.id))!.messages.filter(m=>m.kind==='result').at(-1)!.text).toBe(c.resultText);
  await f.service.publish(session,crypto.randomUUID(),'result',c.resultText);
  const r=await f.call('workroom.threads.read',{threadId:t.id});
  expect(r.messages!.filter(m=>m.kind==='result').map(m=>m.text)).toEqual(['메시지 수신과 MCP 연결을 확인하고 스레드에 기록합니다.',c.resultText]);
  expect(r.thread!.state).toBe('completed');expect(f.starts).toHaveLength(1);expect(f.writes).toEqual([]);
 });
 test('an identical explicit result and final answer are recorded once',async()=>{
  const f=fixture(),t=await f.create(),text='실제 최종 답변';
  await f.service.publish(t.sessionId!,crypto.randomUUID(),'result',text);
  await f.service.completed(t.sessionId!,{key:'codex:identical',resultText:text},0,()=>true);
  expect((await f.store.get(t.id))!.messages.filter(m=>m.kind==='result').map(m=>m.text)).toEqual([text]);
 });
 test('the same final text for a newer user request is a separate result',async()=>{
  const f=fixture(),t=await f.create(),text='확인했습니다.';
  await f.service.completed(t.sessionId!,{key:'codex:turn-one',resultText:text},0,()=>true);
  const r=await f.call('workroom.threads.read',{threadId:t.id});
  await f.call('workroom.threads.reply',{threadId:t.id,text:'다시 확인해줘',expectedRevision:r.thread!.revision});
  await f.service.completed(t.sessionId!,{key:'codex:turn-two',resultText:text},1,()=>true);
  expect((await f.store.get(t.id))!.messages.filter(m=>m.kind==='result').map(m=>m.text)).toEqual([text,text]);
 });
 test('a multipart final answer after an early summary deduplicates a later identical tool publication',async()=>{
  const f=fixture(),t=await f.create(),text='최종 결과입니다. '.repeat(110);
  await f.service.publish(t.sessionId!,crypto.randomUUID(),'result','먼저 남긴 요약');
  await f.service.completed(t.sessionId!,{key:'codex:multipart',resultText:text},0,()=>true);
  const before=(await f.store.get(t.id))!.messages.filter(m=>m.kind==='result');expect(before.length).toBeGreaterThan(2);
  expect(before.slice(1).map(m=>m.text).join('')).toBe(text.trim());
  await f.service.publish(t.sessionId!,crypto.randomUUID(),'result',text.trim());
  expect((await f.store.get(t.id))!.messages.filter(m=>m.kind==='result')).toEqual(before);
 });
 test('uncertain delivery, changed project, revoked observation and stale revisions never become completed',async()=>{
  const f=fixture(),t=await f.create(),session=t.sessionId!,c={key:'codex:final',resultText:'완료'};
  await f.service.completed(session,c,1,()=>true);await f.service.completed(session,c,0,()=>false);
  expect((await f.store.get(t.id))!.state).toBe('running');
  await f.store.mutate(t.id,()=>true,r=>{r!.messages[0]!.delivery='unknown';r!.state='unknown';return {record:r!,value:null};});
  await f.service.completed(session,c,0,()=>true);expect((await f.store.get(t.id))!.state).toBe('unknown');
  f.changeFolder();await f.service.completed(session,c,0,()=>true);expect((await f.store.get(t.id))!.messages).toHaveLength(1);
 });
 test('create, question, answer and result persist once; a Workroom answer mirrors without re-execution',async()=>{
  const f=fixture(),thread=await f.create();expect(thread.state).toBe('running');expect(f.starts).toHaveLength(1);
  const q=crypto.randomUUID();await f.service.publish(thread.sessionId!,q,'question','기존 로그인 방식을 유지할까요?');await f.service.publish(thread.sessionId!,q,'question','기존 로그인 방식을 유지할까요?');
  let r=await f.call('workroom.threads.read',{threadId:thread.id});expect(r.thread!.state).toBe('needs-answer');expect(r.messages!.filter(m=>m.kind==='question')).toHaveLength(1);
  const answer=crypto.randomUUID();await f.call('workroom.threads.reply',{threadId:thread.id,text:'기존 방식 유지',expectedRevision:r.thread!.revision},answer);
  await f.call('workroom.threads.reply',{threadId:thread.id,text:'기존 방식 유지',expectedRevision:r.thread!.revision},answer);
  expect(f.writes).toEqual(['기존 방식 유지']);r=await f.call('workroom.threads.read',{threadId:thread.id});expect(r.messages!.filter(m=>m.text==='기존 방식 유지')).toHaveLength(1);
  await f.service.input(thread.sessionId!,'워크룸에서 답한 내용\r',2);expect(f.writes).toHaveLength(1);
  await f.service.publish(thread.sessionId!,crypto.randomUUID(),'result','로그인 경로 수정, 격리 회귀 통과');
  r=await f.call('workroom.threads.read',{threadId:thread.id});expect(r.thread!.state).toBe('completed');expect(r.messages!.some(m=>m.text==='워크룸에서 답한 내용')).toBe(true);
  normalizeMobileWorkspaceResult({kind:'workspace',action:'workroom.threads.read',threads:r});
  expect(readFileSync(f.store.file).includes(Buffer.from('로그인'))).toBe(false);
 });
 test('concurrent creation with the same ID spawns once and changed intent is refused',async()=>{
  const f=fixture(),id=crypto.randomUUID(),body={agent:'codex' as const,text:'한 번만 실행'};
  await Promise.all([f.call('workroom.threads.create',body,id),f.call('workroom.threads.create',body,id)]);await f.service.idle();expect(f.starts).toEqual([id]);
  await expect(f.call('workroom.threads.create',{...body,text:'다른 일'},id)).rejects.toThrow('내용이 바뀌었습니다');
 });
 test('a second thread cannot concurrently edit the same checkout',async()=>{
  const f=fixture();await f.create();expect((await f.call('workroom.threads.create',{agent:'codex',text:'다른 작업'})).refusal!.message).toContain('이전 업무');expect(f.starts).toHaveLength(1);
 });
 test('two answers from the same revision reach the CLI at most once',async()=>{
  const f=fixture(),t=await f.create();const results=await Promise.allSettled([f.call('workroom.threads.reply',{threadId:t.id,text:'첫 답변',expectedRevision:t.revision}),f.call('workroom.threads.reply',{threadId:t.id,text:'두번째 답변',expectedRevision:t.revision})]);
  expect(results.filter(r=>r.status==='fulfilled'&&!r.value.refusal)).toHaveLength(1);expect(f.writes).toHaveLength(1);
 });
 test('an intervening Workroom message makes a stale thread answer fail',async()=>{
  const f=fixture(),t=await f.create();await f.service.input(t.sessionId!,'워크룸에서 먼저 답함\r',1);
  expect((await f.call('workroom.threads.reply',{threadId:t.id,text:'늦은 답변',expectedRevision:t.revision})).refusal!.message).toContain('갱신');expect(f.writes).toHaveLength(0);
 });
 test('lost delivery stays unknown and retrying its ID never types again',async()=>{
  let attempts=0;const f=fixture({reply:async()=>{attempts++;throw Error('ack lost');}}),t=await f.create(),id=crypto.randomUUID();
  const input={threadId:t.id,text:'한 번만 답변',expectedRevision:t.revision};await f.call('workroom.threads.reply',input,id);const r=await f.call('workroom.threads.reply',input,id);
  expect(attempts).toBe(1);expect(r.thread!.state).toBe('unknown');expect(r.messages!.at(-1)!.delivery).toBe('unknown');
 });
 test('project, owner, revoked grant and changed folder cannot redirect a thread',async()=>{
  const f=fixture(),t=await f.create();
  await expect(f.service.perform('workroom.threads.read',{threadId:t.id},'different-project',crypto.randomUUID(),f.access)).rejects.toThrow('접근');
  await expect(f.service.perform('workroom.threads.read',{threadId:t.id},f.target,crypto.randomUUID(),{...f.access,owner:'other-phone'})).rejects.toThrow('접근');
  const other=await f.service.perform('workroom.threads.list',{},f.target,crypto.randomUUID(),{...f.access,owner:'other-phone'});expect(other.threads).toEqual([]);
  const local=await f.service.perform('workroom.threads.read',{threadId:t.id},f.target,crypto.randomUUID(),{...f.access,owner:'local',readAll:true});expect(local.thread!.id).toBe(t.id);
  f.changeFolder();await expect(f.call('workroom.threads.reply',{threadId:t.id,text:'답변',expectedRevision:t.revision})).rejects.toThrow('폴더');
  await expect(f.call('workroom.threads.read',{threadId:t.id})).rejects.toThrow('폴더');f.revoke();await expect(f.call('workroom.threads.read',{threadId:t.id})).rejects.toThrow('연결');expect(f.writes).toEqual([]);
 });
 test('missing encryption key preserves the existing file and never creates a replacement',async()=>{
  const f=fixture(),t=await f.create(),before=readFileSync(f.store.file);f.loseKey();await expect(f.store.get(t.id)).rejects.toThrow('키');expect(readFileSync(f.store.file)).toEqual(before);
 });
 test('a new host instance preserves an uncertain start instead of replaying it',async()=>{
  const f=fixture({start:async()=>({written:false})}),t=await f.create();const restarted=new WorkroomThreadService(f.deps);
  const result=await restarted.perform('workroom.threads.create',{agent:'codex',text:'모바일 로그인 오류를 수정해줘'},f.target,t.id,f.access);expect(result.thread!.state).toBe('unknown');
 });
 test('after a host restart, running or unanswered work needs review before the checkout can be reused',async()=>{
  for(const awaitingAnswer of [false,true]){
   const f=fixture(),t=await f.create();if(awaitingAnswer)await f.service.publish(t.sessionId!,crypto.randomUUID(),'question','재시작 전 질문');
   const restarted=new WorkroomThreadService({...f.deps,inspect:()=>{throw Error('Previous host no longer owns a live PTY');}});
   const call=(action:Parameters<typeof restarted.perform>[0],body:Parameters<typeof restarted.perform>[1])=>restarted.perform(action,body,f.target,crypto.randomUUID(),f.access);
   const r=await call('workroom.threads.read',{threadId:t.id});expect(r.thread!.state).toBe('unknown');expect(f.starts).toHaveLength(1);
   expect((await call('workroom.threads.create',{agent:'codex',text:'새 업무'})).refusal!.message).toContain('이전 업무');
   await call('workroom.threads.close',{threadId:t.id,expectedRevision:r.thread!.revision,consent:true});await call('workroom.threads.create',{agent:'codex',text:'새 업무'});await restarted.idle();expect(f.starts).toHaveLength(2);
  }
 });
 test('publishing needs the bound Workroom, and publishing a duplicate changed body fails',async()=>{
  const f=fixture(),t=await f.create(),id=crypto.randomUUID();await expect(f.service.publish('other-session',id,'result','허위 완료')).rejects.toThrow('연결된');
  await f.service.publish(t.sessionId!,id,'progress','진행 중');await expect(f.service.publish(t.sessionId!,id,'result','변경')).rejects.toThrow('내용');
 });
 test('a prepared Workroom input is uncertain until its exact PTY write finishes',async()=>{
  const f=fixture(),t=await f.create(),written=await f.service.prepareInput(t.sessionId!,'워크룸 답변\r',1);
  let r=await f.call('workroom.threads.read',{threadId:t.id});expect(r.messages!.at(-1)!.delivery).toBe('unknown');expect(r.thread!.state).toBe('unknown');
  await written!();r=await f.call('workroom.threads.read',{threadId:t.id});expect(r.messages!.at(-1)!.delivery).toBe('written');expect(r.thread!.state).toBe('running');expect(f.writes).toHaveLength(0);
 });
 test('CLI approval screens are recorded once per input revision and never answered automatically',async()=>{
  const f=fixture(),t=await f.create();await f.service.questionScreen(t.sessionId!,['Trust this folder?','1. Yes','2. No'],0);await f.service.questionScreen(t.sessionId!,['Trust this folder?','1. Yes','2. No'],0);
  const r=await f.call('workroom.threads.read',{threadId:t.id});expect(r.messages!.filter(m=>m.kind==='question')).toHaveLength(1);expect(r.messages!.at(-1)!.role).toBe('system');expect(r.thread!.state).toBe('needs-answer');expect(f.writes).toEqual([]);
  const refused=await f.call('workroom.threads.reply',{threadId:t.id,text:'승인하지 마',expectedRevision:r.thread!.revision});expect(refused.refusal!.message).toContain('승인·선택');expect(f.writes).toEqual([]);
 });
 test('an observed CLI exit waits for a follow-up; explicit thread closure never reopens it',async()=>{
  const f=fixture(),t=await f.create();await f.service.ended(t.sessionId!);let r=await f.call('workroom.threads.read',{threadId:t.id});expect(r.thread!.state).toBe('needs-answer');
  await f.call('workroom.threads.close',{threadId:t.id,expectedRevision:r.thread!.revision,consent:true});await f.service.publish(t.sessionId!,crypto.randomUUID(),'progress','늦은 진행 보고');
  r=await f.call('workroom.threads.read',{threadId:t.id});expect(r.thread!.state).toBe('closed');expect(f.starts).toHaveLength(1);
 });
 test('completed conversations accept a follow-up, but a new active task owns the checkout',async()=>{
  const f=fixture(),t=await f.create();await f.service.publish(t.sessionId!,crypto.randomUUID(),'result','첫 작업 완료');let r=await f.call('workroom.threads.read',{threadId:t.id});
  await f.call('workroom.threads.reply',{threadId:t.id,text:'후속 확인',expectedRevision:r.thread!.revision});expect(f.writes).toEqual(['후속 확인']);
  await f.service.publish(t.sessionId!,crypto.randomUUID(),'result','후속 완료');await f.create('새 작업');r=await f.call('workroom.threads.read',{threadId:t.id});
  const refused=await f.call('workroom.threads.reply',{threadId:t.id,text:'겹치는 후속 작업',expectedRevision:r.thread!.revision});expect(refused.refusal!.message).toContain('이전 업무');expect(f.writes).toEqual(['후속 확인']);
 });
 test('encrypted record ownership cannot be widened by changing SQLite index metadata',async()=>{
  const f=fixture(),t=await f.create(),db=new Database(f.store.file);try{db.query('UPDATE threads SET owner=? WHERE id=?').run('tampered-owner',t.id);}finally{db.close();}
  await expect(f.store.get(t.id)).rejects.toThrow('색인');
 });
 test('old task and message pages remain accessible with bounded UTF-8 envelopes',async()=>{
  const f=fixture();const ids:string[]=[];
  for(let i=0;i<23;i++){const t=await f.create('한'.repeat(120)+' '+i);ids.push(t.id);await f.service.publish(t.sessionId!,crypto.randomUUID(),'result','완료');}
  const seen=new Set<string>();let before:string|undefined;
  do{const page=await f.call('workroom.threads.list',before?{beforeThreadId:before}:{});normalizeMobileWorkspaceResult({kind:'workspace',action:'workroom.threads.list',threads:page});for(const t of page.threads!)seen.add(t.id);before=page.nextThreadId??undefined;}while(before);
  expect(seen.size).toBe(23);
  const row=await f.store.get(ids.at(-1)!);for(let i=0;i<25;i++)await f.service.publish(row!.sessionId!,crypto.randomUUID(),'progress','긴 답변 '.repeat(80)+i);
  let cursor:number|undefined,total=0;do{const page=await f.call('workroom.threads.read',{threadId:row!.id,...(cursor?{beforeSeq:cursor}:{})});normalizeMobileWorkspaceResult({kind:'workspace',action:'workroom.threads.read',threads:page});total+=page.messages!.length;cursor=page.nextBefore??undefined;}while(cursor);
  expect(total).toBe(27);
 });
 test('escaped text cannot create an unreadable wire page or launch an oversized task',async()=>{
  const f=fixture();await expect(f.create('\\'.repeat(5900))).rejects.toThrow('전송 한도');expect(f.starts).toEqual([]);
  const t=await f.create('a'.repeat(6000));let r=await f.call('workroom.threads.read',{threadId:t.id});
  expect(r.messages![0]!.text).toHaveLength(6000);normalizeMobileWorkspaceResult({kind:'workspace',action:'workroom.threads.read',threads:r});
  await f.service.questionScreen(t.sessionId!,['\\'.repeat(5900)],0);r=await f.call('workroom.threads.read',{threadId:t.id});
  expect(r.messages!.at(-1)!.kind).toBe('question');normalizeMobileWorkspaceResult({kind:'workspace',action:'workroom.threads.read',threads:r});
 });
});
test('production adapter drives the real terminal submission service and mirrors its Workroom input exactly once',async()=>{
 const f=fixture(),journal=new WorkroomConversationJournal(f.root),writes:string[]=[];let finish!:(code:number)=>void,exit=()=>{};let threads:WorkroomThreadService;
 const terminal=new AiTerminalService({submissions:()=>journal,headlessScreen:false,activitySampler:false,resolveTarget:async()=>({cwd:f.root}),executable:()=>'/fixture/codex',
  threadInput:(id,text,revision)=>threads.prepareInput(id,text,revision),threadEnded:id=>threads.ended(id),
  signalGroup:()=>{exit();finish(0);},spawn:(_args,options)=>{exit=(options.terminal as {exit():void}).exit;return {pid:99999999,exited:new Promise<number>(resolve=>{finish=resolve;}),kill:()=>{},terminal:{write:text=>{writes.push(text);return Buffer.byteLength(text);},resize:()=>{},close:()=>{exit();finish(0);}}};}});
 threads=new WorkroomThreadService({...f.deps,resolve:async()=>({fingerprint:workroomThreadProjectFingerprint(f.root)}),...workroomThreadTerminalAdapter(terminal),inspect:(id,target)=>terminal.inspectSession(id,target)});
 try{
  const id=crypto.randomUUID();await threads.perform('workroom.threads.create',{agent:'codex',text:'실제 제출 경로'},f.target,id,f.access);await threads.idle();let r=await threads.perform('workroom.threads.read',{threadId:id},f.target,crypto.randomUUID(),f.access);
  expect(r.thread!.state).toBe('running');expect(r.thread!.sessionId).not.toBeNull();
  const answerId=crypto.randomUUID();await threads.perform('workroom.threads.reply',{threadId:id,text:'스레드에서 답변',expectedRevision:r.thread!.revision},f.target,answerId,f.access);
  const session=terminal.runningSession(r.thread!.sessionId!)!;
  await submitWorkroomDraft({id:crypto.randomUUID(),sessionId:session.id,text:'워크룸에서 직접 답변\r',prepared:()=>{},request:request=>terminal.perform({...request,requestId:crypto.randomUUID()})});
  r=await threads.perform('workroom.threads.read',{threadId:id},f.target,crypto.randomUUID(),f.access);
  expect(r.messages!.filter(m=>m.text==='스레드에서 답변')).toHaveLength(1);expect(r.messages!.filter(m=>m.text==='워크룸에서 직접 답변')).toHaveLength(1);
  expect(writes.join('')).toContain('스레드에서 답변');expect(writes.join('').split('스레드에서 답변')).toHaveLength(2);
 }finally{await terminal.shutdown();journal.close();}
});
describe('Community Workroom continuation and checkpoint lifecycle',()=>{
 function continuationFixture(){
  const opens:{id:string;mode:string}[]=[];
  const f=fixture({open:async(id,r,active)=>{
   if(!active())throw Error('revoked');opens.push({id,mode:r.continuation!.mode});
   const sessionId=crypto.randomUUID();f.revisions.set(sessionId,0);
   return {id:sessionId,targetId:r.targetId,agent:r.agent,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:100,rows:28};
  }});
  return {...f,opens};
 }
 test('a closed CLI resumes once on a new post, preserves history, and fences the previous publisher',async()=>{
  const f=continuationFixture(),t=await f.create();await f.service.publish(t.sessionId!,crypto.randomUUID(),'question','이전 질문');await f.service.ended(t.sessionId!);
  let r=await f.call('workroom.threads.read',{threadId:t.id});const id=crypto.randomUUID(),input={threadId:t.id,text:'새 답변',expectedRevision:r.thread!.revision};
  await f.call('workroom.threads.reply',input,id);await f.call('workroom.threads.reply',input,id);
  r=await f.call('workroom.threads.read',{threadId:t.id});expect(f.opens).toEqual([{id,mode:'resume'}]);expect(f.writes).toEqual(['새 답변']);expect(r.thread!.sessionId).not.toBe(t.sessionId);
  expect(r.messages!.filter(m=>m.text==='새 답변')).toHaveLength(1);expect(r.messages!.some(m=>m.text==='이전 질문')).toBe(true);
  await expect(f.service.publish(t.sessionId!,crypto.randomUUID(),'result','늦은 이전 결과')).rejects.toThrow('연결된');
  await expect(f.service.readSession(t.sessionId!)).rejects.toThrow('연결된');await f.service.input(t.sessionId!,'이전 입력\r',9);
  await f.service.ended(t.sessionId!);expect((await f.store.get(t.id))!.sessionId).toBe(r.thread!.sessionId);expect((await f.store.get(t.id))!.previousSessions).toEqual([t.sessionId!]);
 });
 test('two simultaneous follow-ups cannot open two replacement CLIs',async()=>{
  const f=continuationFixture(),t=await f.create();await f.service.ended(t.sessionId!);const r=await f.call('workroom.threads.read',{threadId:t.id});
  const results=await Promise.allSettled(['첫 답변','두번째 답변'].map(text=>f.call('workroom.threads.reply',{threadId:t.id,text,expectedRevision:r.thread!.revision})));
  expect(results.filter(v=>v.status==='fulfilled'&&!v.value.refusal)).toHaveLength(1);expect(f.opens).toHaveLength(1);expect(f.writes).toHaveLength(1);
 });
 test('a follow-up arriving before the exit callback still reopens the proven exited CLI once',async()=>{
  const f=continuationFixture(),t=await f.create();const inspect=f.deps.inspect;f.deps.inspect=(id,target)=>id===t.sessionId?{state:'exited',inputRevision:0}:inspect(id,target);
  const response=await f.call('workroom.threads.reply',{threadId:t.id,text:'종료 직후 요청',expectedRevision:t.revision});expect(response.thread!.state).toBe('running');expect(f.opens).toHaveLength(1);expect(f.writes).toEqual(['종료 직후 요청']);
 });
 test('a recorded clean exit remains resumable after a host restart; ambiguous input never does',async()=>{
  const f=continuationFixture(),t=await f.create();await f.service.ended(t.sessionId!);
  const restarted=new WorkroomThreadService(f.deps);let r=await restarted.perform('workroom.threads.read',{threadId:t.id},f.target,crypto.randomUUID(),f.access);expect(r.thread!.state).toBe('needs-answer');
  await restarted.perform('workroom.threads.reply',{threadId:t.id,text:'재시작 뒤 후속',expectedRevision:r.thread!.revision},f.target,crypto.randomUUID(),f.access);expect(f.opens).toHaveLength(1);
  r=await f.call('workroom.threads.read',{threadId:t.id});await restarted.prepareInput(r.thread!.sessionId!,'미확정 답변\r',8);await restarted.ended(r.thread!.sessionId!);
  expect((await f.store.get(t.id))!.continuation).toBeUndefined();expect((await f.store.get(t.id))!.state).toBe('unknown');
 });
 test('a crash after continuation admission never reopens or resends that request automatically',async()=>{
  let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>{release=r;}),opening=new Promise<void>(r=>{entered=r;});
  const f=fixture({open:async()=>{entered();await wait;return undefined;}}),t=await f.create();await f.service.ended(t.sessionId!);
  let r=await f.call('workroom.threads.read',{threadId:t.id});const id=crypto.randomUUID(),input={threadId:t.id,text:'한 번만',expectedRevision:r.thread!.revision};
  const pending=f.call('workroom.threads.reply',input,id);await opening;const restarted=new WorkroomThreadService({...f.deps,open:async()=>{throw Error('must not run');}});
  r=await restarted.perform('workroom.threads.read',{threadId:t.id},f.target,crypto.randomUUID(),f.access);expect(r.thread!.state).toBe('unknown');
  await restarted.perform('workroom.threads.reply',input,f.target,id,f.access);expect(f.writes).toEqual([]);release();await pending;
 });
 test('70% save keeps the full thread, opens fresh context only for the next post, and mirrors the original text once',async()=>{
  const f=continuationFixture(),t=await f.create();let checkpoints=0;
  f.deps.checkpointEvidence=async()=>({inputRevision:0});f.deps.checkpoint=async()=>{checkpoints++;return 'closed';};
  await f.service.publish(t.sessionId!,crypto.randomUUID(),'result','검증된 이전 결과');await f.service.checkpointTick();await f.service.checkpointTick();expect(checkpoints).toBe(1);expect(f.opens).toEqual([]);
  let r=await f.call('workroom.threads.read',{threadId:t.id});const text='a'.repeat(6000);
  await f.call('workroom.threads.reply',{threadId:t.id,text,expectedRevision:r.thread!.revision});r=await f.call('workroom.threads.read',{threadId:t.id});
  expect(f.opens[0]!.mode).toBe('fresh');expect(f.writes[0]).toContain('agentstoz_use_read_workroom_thread');expect(f.writes[0]).toContain('이전 요청·완료 결과는 기록');expect(f.writes[0]).toContain(text);
  expect(r.messages!.filter(m=>m.text===text)).toHaveLength(1);expect((await f.store.get(t.id))!.messages.some(m=>m.text==='검증된 이전 결과')).toBe(true);expect(r.nextBefore).not.toBeNull();expect(r.thread!.state).toBe('running');normalizeWorkroomThreadResult(r);
 });
 test('saving refuses a simultaneous post, retains the CLI on failure, and never retries that save',async()=>{
  const f=continuationFixture(),t=await f.create();let attempts=0,state:'saving'|'blocked'='saving';
  f.deps.checkpointEvidence=async()=>({inputRevision:0});f.deps.checkpoint=async()=>{attempts++;return state;};await f.service.checkpointTick();
  let r=await f.call('workroom.threads.read',{threadId:t.id});const reply=await f.call('workroom.threads.reply',{threadId:t.id,text:'새 요청',expectedRevision:r.thread!.revision});expect(reply.refusal!.message).toContain('저장');expect(f.writes).toEqual([]);
  state='blocked';await f.service.checkpointTick();await f.service.checkpointTick();expect(attempts).toBe(2);expect(f.opens).toEqual([]);expect((await f.store.get(t.id))!.continuation).toBeUndefined();
  r=await f.call('workroom.threads.read',{threadId:t.id});await f.call('workroom.threads.reply',{threadId:t.id,text:'기존 세션에서 계속',expectedRevision:r.thread!.revision});expect(f.writes).toEqual(['기존 세션에서 계속']);
 });
 test('an unavailable project cannot starve another thread’s checkpoint on the shared tick',async()=>{
  const f=continuationFixture();await f.create();const id=crypto.randomUUID();
  await f.service.perform('workroom.threads.create',{agent:'codex',text:'다른 프로젝트 업무'},'another-project-target',id,f.access);await f.service.idle();
  f.deps.checkpointEvidence=async r=>{if(r.targetId===f.target)throw Error('project removed');return {inputRevision:0};};f.deps.checkpoint=async()=> 'closed';
  await f.service.checkpointTick();expect((await f.store.get(id))!.checkpoint!.state).toBe('closed');expect((await f.store.get(id))!.continuation!.mode).toBe('fresh');
 });
 test('a revived old thread cannot take a checkout held by a new task',async()=>{
  const f=continuationFixture(),t=await f.create();await f.service.publish(t.sessionId!,crypto.randomUUID(),'result','완료');await f.service.ended(t.sessionId!);await f.create('다른 진행 업무');
  const r=await f.call('workroom.threads.read',{threadId:t.id}),response=await f.call('workroom.threads.reply',{threadId:t.id,text:'겹치는 후속',expectedRevision:r.thread!.revision});expect(response.refusal!.message).toContain('이전 업무');expect(f.opens).toEqual([]);
 });
 test('the checkpoint reservation also owns a completed thread’s checkout until save/close settles',async()=>{
  const f=continuationFixture(),t=await f.create();await f.service.publish(t.sessionId!,crypto.randomUUID(),'result','완료');
  f.deps.checkpointEvidence=async()=>({inputRevision:0});f.deps.checkpoint=async()=> 'saving';await f.service.checkpointTick();
  expect((await f.call('workroom.threads.create',{agent:'codex',text:'저장 중 겹치는 업무'})).refusal!.message).toContain('이전 업무');
 });
 test('a CLI trust prompt during reopening preserves the new message without typing it',async()=>{
  const f=continuationFixture(),t=await f.create();f.deps.ready=async()=>{throw Error('trust menu');};await f.service.ended(t.sessionId!);
  const r=await f.call('workroom.threads.read',{threadId:t.id});await f.call('workroom.threads.reply',{threadId:t.id,text:'보존할 새 요청',expectedRevision:r.thread!.revision});
  expect(f.writes).toEqual([]);const saved=(await f.store.get(t.id))!;expect(saved.messages.find(m=>m.text==='보존할 새 요청')!.delivery).toBe('unknown');expect(saved.state).toBe('unknown');expect(saved.sessionId).not.toBe(t.sessionId);
 });
 test('another input in the replacement CLI before readiness prevents automatic follow-up delivery',async()=>{
  const f=continuationFixture(),t=await f.create();f.deps.ready=async session=>{f.revisions.set(session.id,1);};await f.service.ended(t.sessionId!);
  const r=await f.call('workroom.threads.read',{threadId:t.id});await f.call('workroom.threads.reply',{threadId:t.id,text:'동시에 들어온 후속',expectedRevision:r.thread!.revision});
  expect(f.writes).toEqual([]);expect((await f.store.get(t.id))!.state).toBe('unknown');
 });
});
test('host checkpoint requires the exact CLI transcript, current completed input and opted-in memory policy',async()=>{
 const f=fixture(),t=await f.create(),r=(await f.store.get(t.id))!;r.fingerprint=workroomThreadProjectFingerprint(f.root);
 const now=Date.now(),createdAt=new Date(now-60_000).toISOString(),at=new Date(now-1000).toISOString();
 let enabled=true,revision=1,completed:number|null=1,activity='turn-finished',exact=true,binding='verified',provider='provider-conversation-one',saves=0,closes=0;
 let observation:any={sessionId:provider,cwd:f.root,usedPercent:70,capturedAt:at,turnState:'complete',turnId:'turn-one',turnCompletedAt:at};
 let saveState:'saving'|'saved'|'blocked'='saved',afterSave=()=>{},ended=false;
 const host=workroomThreadLifecycleHost({
  terminal:{inspectSession:()=>({...t,id:t.sessionId!,cwd:f.root,state:ended?'exited':'running',createdAt,inputRevision:revision,completedInputRevision:completed}),activitySnapshot:()=>[{sessionId:t.sessionId!,state:activity,exact}] as any,
   perform:async(request:any,authority:any)=>{expect(request.memoryPolicy).toBe('saved');expect(request.saveRequestId).toBe(r.checkpoint!.id);expect(authority.owner).toBe('thread-checkpoint:'+r.id);closes++;ended=true;return {};},prepareHistoryContext:async()=>{throw Error('not used');}} as any,
  history:{submissionJournal:()=>({forSession:()=>({sessionId:t.sessionId,binding,providerConversationId:provider})}),resumeThreadSession:async()=>undefined} as any,
  observations:async()=>[observation],enabled:()=>enabled,save:async()=>{saves++;afterSave();return saveState;},now:()=>now,
 });
 const evidence=()=>host.checkpointEvidence!(r);
 expect(await evidence()).toEqual({inputRevision:1,turnCompletedAt:at});
 for(const patch of [{usedPercent:69.99},{usedPercent:NaN},{usedPercent:101},{sessionId:'another-provider'},{cwd:'/other'},{sourceAgent:'claude'},{turnState:'running'},{turnId:null},{capturedAt:new Date(now-11*60_000).toISOString()},{capturedAt:new Date(now+60_000).toISOString()},{turnCompletedAt:createdAt.replace('2026','2020')}]){
  const before=observation;observation={...before,...patch};expect(await evidence()).toBeNull();observation=before;
 }
 enabled=false;expect(await evidence()).toBeNull();enabled=true;
 binding='unverified';expect(await evidence()).toBeNull();binding='verified';
 completed=null;expect(await evidence()).toBeNull();completed=1;revision=2;expect(await evidence()).toBeNull();revision=1;
 activity='needs-answer';expect(await evidence()).toBeNull();activity='working';expect(await evidence()).toBeNull();activity='turn-finished';exact=false;expect(await evidence()).toBeNull();exact=true;
 r.checkpoint={id:crypto.randomUUID(),sessionId:t.sessionId!,inputRevision:1,state:'saving'};
 saveState='saving';expect(await host.checkpoint!(r)).toBe('saving');expect(closes).toBe(0);
 saveState='blocked';expect(await host.checkpoint!(r)).toBe('blocked');expect(closes).toBe(0);
 saveState='saved';afterSave=()=>{revision++;};expect(await host.checkpoint!(r)).toBe('blocked');expect(closes).toBe(0);expect(saves).toBe(3);
 revision=1;afterSave=()=>{};expect(await host.checkpoint!(r)).toBe('closed');expect(closes).toBe(1);
});
test('fresh context retains the original CLI account and refuses a changed account at the spawn guard',async()=>{
 const f=fixture(),t=await f.create(),r=(await f.store.get(t.id))!;r.fingerprint=workroomThreadProjectFingerprint(f.root);r.continuation={sessionId:t.sessionId!,mode:'fresh'};
 const old={sessionId:t.sessionId,targetId:r.targetId,agent:r.agent,state:'ended',accountId:'account-one',accountFingerprint:'account-proof',targetFingerprint:'target-proof'};
 let active=true,preparedAccount='account-proof',spawnAccount='account-proof',launches=0;
 const context=(accountFingerprint:string)=>({summary:{...t,targetId:r.targetId,agent:r.agent,accountId:old.accountId},cwd:f.root,accountFingerprint,targetFingerprint:old.targetFingerprint});
 const host=workroomThreadLifecycleHost({terminal:{prepareHistoryContext:async()=>context(preparedAccount),perform:async(request:any,_authority:any,options:any)=>{await options.startGuard(context(spawnAccount));launches++;expect(request.accountId).toBe(old.accountId);expect(request.prompt).toBeUndefined();expect(request.resumeFrom).toBeUndefined();return {session:t};}} as any,
  history:{submissionJournal:()=>({forSession:()=>old})} as any,observations:async()=>[],enabled:()=>true,save:async()=> 'blocked'});
 expect((await host.open!('followup-request-one',r,()=>active))?.id).toBe(t.id);
 spawnAccount='changed-account';await expect(host.open!('followup-request-two',r,()=>active)).rejects.toThrow('계정');expect(launches).toBe(1);
 spawnAccount='account-proof';preparedAccount='changed-account';await expect(host.open!('followup-request-three',r,()=>active)).rejects.toThrow('계정');expect(launches).toBe(1);
 active=false;await expect(host.open!('followup-request-four',r,()=>active)).rejects.toThrow('재개');
});
test('automatic Community checkpoint consent covers only turns completed after enablement',()=>{
 const enabled='2026-10-17T00:00:00.000Z';
 expect(workroomThreadSaveConsent(enabled,'2026-10-16T23:59:59.999Z')).toBe(false);
 expect(workroomThreadSaveConsent(enabled,enabled)).toBe(false);
 expect(workroomThreadSaveConsent(enabled,'2026-10-17T00:00:00.001Z')).toBe(true);
 expect(workroomThreadSaveConsent(Date.parse(enabled),'2026-10-17T00:00:00.001Z')).toBe(true);
 expect(workroomThreadSaveConsent(null)).toBe(false);expect(workroomThreadSaveConsent('bad','bad')).toBe(false);
});
test('thread wire contracts reject paths, malformed fields, oversized text and unrelated result keys',()=>{
 const base={operation:'workspace',requestId:crypto.randomUUID(),targetId:'project-thread-one'};
 for(const action of ['workroom.threads.list','workroom.threads.read','workroom.threads.create','workroom.threads.reply'] as const){
  const thread=action.endsWith('.list')?{}:action.endsWith('.create')?{agent:'codex',text:'업무'}:action.endsWith('.reply')?{threadId:'thread-one-123',text:'답변',expectedRevision:1}:{threadId:'thread-one-123'};
  normalizeMobileWorkspaceRequest({...base,workspace:{action,thread}});
  expect(()=>normalizeMobileWorkspaceRequest({...base,workspace:{action,thread:{...thread,path:'/private/project'}}})).toThrow();
 }
 expect(()=>normalizeWorkroomThreadRequest('workroom.threads.create',{agent:'codex',text:'한'.repeat(2001)})).toThrow();
 for(const text of ['유효하지 않은\r입력','제어문자\u0007','잘린 유니코드\ud800'])expect(()=>normalizeWorkroomThreadRequest('workroom.threads.create',{agent:'codex',text})).toThrow();
 expect(()=>normalizeMobileWorkspaceRequest({...base,requestId:'a'.repeat(129),workspace:{action:'workroom.threads.create',thread:{agent:'codex',text:'업무'}}})).toThrow();
 expect(()=>normalizeWorkroomThreadResult({thread:{id:'bad'}})).toThrow();
 expect(()=>normalizeWorkroomThreadPublish({requestId:'publish-one',kind:'result',text:'완료',threadId:'other-thread'})).toThrow();
 expect(()=>normalizeMobileWorkspaceResult({kind:'workspace',action:'workroom.threads.create',threads:{}})).toThrow();
});
test('Mac-created task journals are shared across approved devices without granting raw conversation history',async()=>{
 const f=fixture();let owner='phone-one',permitted=true,live=true,historyCalls=0;
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({}),active:()=>live,resolve:async()=>[{controlId:'phone-control-one',runtimeTargetId:f.target}],
  consent:async()=>({targetIds:new Set(permitted?[f.target]:[]),workspaceScopes:[],historyScopes:[],isActive:()=>live,requestOwner:owner}),
  history:async()=>{historyCalls++;throw Error('unexpected history access');},
  perform:async(request,targetId,requestOwner,active,_test,targets,access)=>({kind:'workspace',action:request.workspace.action,threads:await f.service.perform(request.workspace.action as any,request.workspace.thread!,targetId,request.requestId,{owner:requestOwner,active,targets,readAll:access!.readAll})})});
 const send=(action:any,thread:any,id=crypto.randomUUID())=>gateway({operation:'workspace',requestId:id,targetId:'phone-control-one',workspace:{action,thread}},[],'connection') as Promise<any>;
 const id=crypto.randomUUID(),local={...f.access,owner:'local',readAll:true};
 await f.service.perform('workroom.threads.create',{agent:'codex',text:'Mac에서 만든 업무'},f.target,id,local);await f.service.idle();
 expect((await send('workroom.threads.list',{})).threads.threads.map((t:any)=>t.id)).toEqual([id]);
 let page=(await send('workroom.threads.read',{threadId:id})).threads;
 await send('workroom.threads.reply',{threadId:id,text:'휴대폰에서 답변',expectedRevision:page.thread.revision});
 page=await f.service.perform('workroom.threads.read',{threadId:id},f.target,crypto.randomUUID(),local);
 expect(page.messages.some((m:any)=>m.text==='휴대폰에서 답변')).toBe(true);
 await f.service.perform('workroom.threads.reply',{threadId:id,text:'Mac에서 답변',expectedRevision:page.thread.revision},f.target,crypto.randomUUID(),local);
 owner='phone-two';page=(await send('workroom.threads.read',{threadId:id})).threads;
 expect(page.messages.some((m:any)=>m.text==='Mac에서 답변')).toBe(true);expect(f.writes).toEqual(['휴대폰에서 답변','Mac에서 답변']);
 expect((await f.store.get(id))!.owner).toBe('local');
 await expect(gateway({operation:'workspace',requestId:crypto.randomUUID(),targetId:'phone-control-one',workspace:{action:'history.list',history:{}}},[],'connection')).rejects.toThrow('대화 기록');expect(historyCalls).toBe(0);
 permitted=false;await expect(send('workroom.threads.read',{threadId:id})).rejects.toThrow('범위');live=false;await expect(send('workroom.threads.list',{})).rejects.toThrow('다시 연결');
});
test('the MCP publisher carries its caller to loopback, publishes once, and refuses another Workroom or an outdated host',async()=>{
 const f=fixture(),t=await f.create(),token='a'.repeat(64);mkdirSync(join(f.root,'control-profile'));
 writeFileSync(join(f.root,'control-profile/access.json'),JSON.stringify({schemaVersion:1,profileId:crypto.randomUUID(),token}),{mode:0o600});
 let outdated=false,requests=0;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
  const path=new URL(request.url).pathname;
  if(!['/api/agent-dialogue/thread-mcp','/api/agent-dialogue/thread-read-mcp'].includes(path))return new Response('not found',{status:404});
  if(request.headers.get('X-AgentsToZ-Control-Profile')!==token||request.headers.get('Origin'))return new Response('unauthorized',{status:403});
  requests++;if(outdated)return Response.json({success:true});
  try{
   const raw=await request.json(),caller=parseWorkroomCallerHint(request.headers).sessionId;
   if(path.endsWith('thread-read-mcp'))return Response.json({success:true,page:await f.service.readSession(caller!,normalizeWorkroomThreadRead(raw).beforeSeq)});
   const input=normalizeWorkroomThreadPublish(raw);return Response.json({success:true,...await f.service.publish(caller!,input.requestId,input.kind,input.text)});
  }catch(e){return Response.json({success:false,error:(e as Error).message},{status:400});}
 }});
 const env={APP_DATA_DIR:f.root,HOME:f.root,AGENTSTOZ_USE_ENDPOINT:`http://127.0.0.1:${server.port}/api/agentstoz-use/action`,AGENTSTOZ_WORKROOM_SESSION_ID:t.sessionId!};
 const body={requestId:crypto.randomUUID(),kind:'question',text:'같은 스레드에 남는 질문'};
 const call=(args:object,session=t.sessionId!)=>handleAgentsToZUseMcpRequest({id:1,method:'tools/call',params:{name:'agentstoz_use_publish_workroom_thread',arguments:args}},{...env,AGENTSTOZ_WORKROOM_SESSION_ID:session}) as Promise<any>;
 try{
  expect((await call(body)).result.isError).toBe(false);expect((await call(body)).result.isError).toBe(false);
  expect((await call({...body,requestId:crypto.randomUUID()},'foreign-session')).result.isError).toBe(true);
  const before=requests;expect((await call({...body,threadId:'forged-target'})).result.isError).toBe(true);expect(requests).toBe(before);
  expect((await f.call('workroom.threads.read',{threadId:t.id})).messages!.filter(m=>m.text===body.text)).toHaveLength(1);
  const read=(args:object,session=t.sessionId!)=>handleAgentsToZUseMcpRequest({id:2,method:'tools/call',params:{name:'agentstoz_use_read_workroom_thread',arguments:args}},{...env,AGENTSTOZ_WORKROOM_SESSION_ID:session}) as Promise<any>;
  const page=await read({});expect(page.result.isError).toBe(false);expect(page.result.structuredContent.messages.some((m:any)=>m.text===body.text)).toBe(true);
  expect((await read({},'foreign-session')).result.isError).toBe(true);expect((await read({threadId:t.id})).result.isError).toBe(true);expect((await read({beforeSeq:0})).result.isError).toBe(true);
  outdated=true;expect((await call({...body,requestId:crypto.randomUUID()})).result.isError).toBe(true);
  expect((await read({})).result.isError).toBe(true);
 }finally{server.stop(true);}
});
