import {afterEach,expect,test} from 'bun:test';
import {appendFileSync,chmodSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AiTerminalService} from '../src/aiTerminalService';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {WorkroomConversationService} from '../src/workroomConversationService';
import {claudeProjectSlugCandidates} from '../src/sessionTranscript';
import {savedWorkroomConversation} from '../src/workroomConversationIdentity';
import {createWorkroomScheduleAdapter} from '../src/workroomScheduleIntegration';
import {WorkroomScheduleStore} from '../src/workroomScheduleStore';
import {WorkroomScheduleHost} from '../src/workroomScheduleHost';
import {readWorkroomTranscriptWitness} from '../src/aiTerminalActivityTranscript';

const cleanups:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanups.splice(0).reverse())await fn();});

/** Real terminal and history service boundaries, with only the child process and provider storage isolated. */
async function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'schedule-integration-')));chmodSync(root,0o700);
  cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
  const provider=join(root,'.claude');mkdirSync(provider);
  const journal=new WorkroomConversationJournal(root);let history!:WorkroomConversationService;
  let clock=1_800_000_000_000,completion=false,completionKey='claude:fixture-turn';let beforeLaunch:(()=>Promise<void>)|undefined,afterLaunch:(()=>Promise<void>)|undefined;
  const children:{args:string[];writes:string[];emit(text:string):void;exit():void}[]=[];
  const terminal=new AiTerminalService({resolveTarget:async()=>({cwd:root}),executable:()=>'/fixture/claude',
    env:{HOME:root,CLAUDE_CONFIG_DIR:provider,PATH:'/usr/bin'},activitySampler:false,activityClock:()=>clock,
    submissions:()=>journal,history:{started:(...args)=>history.started(...args),ended:(...args)=>history.ended(...args),input:id=>history.input(id)},
    turnSignals:{forget(){},async poll(){if(!completion)return {completions:[],bytes:0};completion=false;return {completions:[{key:completionKey,completedAt:clock}],bytes:0,witness:readWorkroomTranscriptWitness(transcript,'claude',completionKey)??undefined};}},
    signalGroup:pid=>children[pid-8100001]?.exit(),spawn:(args,options:any)=>{
      let end!:(code:number)=>void;const exited=new Promise<number>(resolve=>{end=resolve;});const writes:string[]=[];
      const child={args:[...args],writes,emit:(text:string)=>options.terminal.data(null,Buffer.from(text)),exit:()=>{options.terminal.exit?.();end(0);}};
      children.push(child);return {pid:8100000+children.length,exited,kill:()=>child.exit(),terminal:{write:(text:string)=>{writes.push(text);return Buffer.byteLength(text);},resize(){},close(){}}} as any;
    }});
  history=new WorkroomConversationService({appDataDir:root,journal,platform:'darwin',tickMs:0,contexts:()=>terminal.historySessions(),
    prepare:record=>terminal.prepareHistoryContext(record),assertNoWriter:async()=>{},resolveBinding:async context=>context.providerConversationId??null,
    launch:async(record,requestId,cols,rows,historyResume)=>{await beforeLaunch?.();const result=await terminal.perform({operation:'start',requestId,targetId:record.targetId,agent:record.agent,accountId:record.accountId,cols,rows},undefined,{historyResume,launchModel:historyResume.launchModel,startGuard:historyResume.startGuard});await afterLaunch?.();return result;}});
  cleanups.push(async()=>{await terminal.shutdown();await history.shutdown();});
  const session=(await terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:'integration_target',agent:'claude',cols:80,rows:24},undefined,{launchModel:{model:'claude-fixture'}})).session!;
  const child=children[0]!;child.emit('\x1b[2J\x1b[HSet model to claude-fixture\r\n\r\n❯ ');
  const transcript=join(provider,'projects',claudeProjectSlugCandidates(root)[0]!,session.id+'.jsonl');mkdirSync(join(provider,'projects',claudeProjectSlugCandidates(root)[0]!),{recursive:true});
  const complete=async()=>{
    await terminal.perform({operation:'input',requestId:crypto.randomUUID(),sessionId:session.id,data:'first fixture request\r'});
    writeFileSync(transcript,JSON.stringify({type:'user',message:{content:'fixture request'}})+'\n'+JSON.stringify({type:'assistant',uuid:'fixture-turn',timestamp:new Date(clock).toISOString(),message:{stop_reason:'end_turn'}})+'\n');
    completion=true;clock+=100;await terminal.sampleActivity();
    child.emit('\x1b[2J\x1b[HSet model to claude-fixture\r\n\r\n❯ ');clock+=10_000;await terminal.sampleActivity();clock+=10_000;await terminal.sampleActivity();
    expect(savedWorkroomConversation('claude',provider,root,session.id)).toBe(transcript);
    journal.observe(terminal.historySessions().find(context=>context.summary.id===session.id)!,session.id);
  };
  const endOriginal=async()=>{child.exit();await new Promise<void>(resolve=>setTimeout(resolve,0));await history.ended(terminal.historySessions().find(context=>context.summary.id===session.id)!);};
  const completeRestored=async(turn='fixture-second-turn')=>{
    const current=children.at(-1)!;
    appendFileSync(transcript,JSON.stringify({type:'user',message:{content:'fixture request'}})+'\n'+JSON.stringify({type:'assistant',uuid:turn,timestamp:new Date(clock).toISOString(),message:{stop_reason:'end_turn'}})+'\n');
    completionKey='claude:'+turn;completion=true;clock+=100;await terminal.sampleActivity();
    current.emit('\x1b[2J\x1b[HSet model to claude-fixture\r\n\r\n❯ ');clock+=10_000;await terminal.sampleActivity();clock+=10_000;await terminal.sampleActivity();
  };
  let readyChild:typeof children[number]|undefined;
  const delay=async()=>{clock+=1000;const current=children.at(-1)!;if(readyChild!==current){readyChild=current;current.emit('\x1b[2J\x1b[HSet model to claude-fixture\r\n\r\n❯ ');}await terminal.sampleActivity();};
  return {root,provider,journal,history,terminal,session,child,children,complete,completeRestored,endOriginal,delay,transcript,clock:()=>clock,
    beforeLaunch:(fn:()=>Promise<void>)=>{beforeLaunch=fn;},afterLaunch:(fn:()=>Promise<void>)=>{afterLaunch=fn;}};
}

test('isolated terminal completion and exact history binding are both required before restoration',async()=>{
  const f=await fixture();await expect(f.terminal.scheduleRestoreFacts(f.session.id)).rejects.toThrow('완료');
  expect(f.history.verifiedProviderId(f.session.id,'integration_target')).toBeNull();
  await f.complete();
  expect((await f.terminal.scheduleRestoreFacts(f.session.id)).completedInputRevision).toBe(1);
  expect(f.history.verifiedProviderId(f.session.id,'integration_target')).toBe(f.session.id);
});

async function scheduledFixture(){
  const f=await fixture();await f.complete();
  const keys={read:async()=>Buffer.alloc(32,21),create:async()=>Buffer.alloc(32,21)};
  const store=new WorkroomScheduleStore(f.root,keys);const adapter=createWorkroomScheduleAdapter(f.terminal,f.history,{now:f.clock,delay:f.delay,readyTimeoutMs:25_000});
  let failure:unknown;const restore=adapter.restore!;adapter.restore=async(...args)=>{try{return await restore(...args);}catch(error){failure=error;throw error;}};
  const host=new WorkroomScheduleHost(store,adapter,{enabled:()=>true,now:f.clock});cleanups.push(()=>host.dispose());
  const create=async(autoRestore?:true)=>host.manage({operation:'create',id:crypto.randomUUID(),sessionId:f.session.id,title:'예약',prompt:'격리된 프로젝트 상태 확인',mode:'continue',nextAt:f.clock(),intervalMs:300_000,expiresAt:f.clock()+86_400_000,maxRuns:10,consent:true,...(autoRestore?{autoRestore}:{})});
  return {...f,store,host,adapter,create,failure:()=>failure};
}

test('same-host restore uses real history receipt and terminal binding before submitting once',async()=>{
  const f=await scheduledFixture();const created=await f.create(true),s=created.schedule!;await f.endOriginal();
  await f.host.tick();const run=(await f.store.runs(s.id))[0]!;
  expect(f.failure()).toBeUndefined();expect(run.state).toBe('submitted');expect(f.children).toHaveLength(2);expect(f.children[1]!.args).toContain('--resume');expect(f.children[1]!.args).toContain(f.session.id);
  expect(f.children[1]!.writes.join('')).toContain(s.prompt);expect(f.history.resumeReceipt(run.id+'_resume')?.state).toBe('completed');
  expect((await f.store.get(s.id))?.currentSessionId).toBe(run.sessionId);
});
test('a completed restored session can be safely restored again in the same host',async()=>{
  const f=await scheduledFixture();const s=(await f.create(true)).schedule!;await f.endOriginal();await f.host.tick();
  const first=(await f.store.runs(s.id))[0]!;expect(first.state).toBe('submitted');await f.completeRestored();await f.host.tick();
  expect((await f.store.runs(s.id))[0]?.state).toBe('completed');
  const restoredId=first.sessionId;f.children[1]!.exit();await new Promise<void>(resolve=>setTimeout(resolve,0));
  await f.history.ended(f.terminal.historySessions().find(context=>context.summary.id===restoredId)!);
  const current=(await f.store.get(s.id))!;await f.host.manage({operation:'run-now',id:s.id,expectedRevision:current.revision,requestId:'manual_repeat_real'});
  expect(f.children).toHaveLength(3);expect(f.children[2]!.args).toContain('--resume');expect(f.children[2]!.args).toContain(f.session.id);
  expect(f.children[2]!.writes.filter(part=>part.includes(s.prompt))).toHaveLength(1);
  expect((await f.store.runs(s.id)).map(run=>run.state).sort()).toEqual(['completed','submitted']);
});
test('human input in a restored session prevents a later automatic restoration',async()=>{
  const f=await scheduledFixture();const s=(await f.create(true)).schedule!;await f.endOriginal();await f.host.tick();
  const first=(await f.store.runs(s.id))[0]!;await f.completeRestored();await f.host.tick();expect((await f.store.runs(s.id))[0]?.state).toBe('completed');
  await f.terminal.perform({operation:'input',requestId:crypto.randomUUID(),sessionId:first.sessionId,data:'human request\r'});
  await f.completeRestored('fixture-human-turn');
  f.children[1]!.exit();await new Promise<void>(resolve=>setTimeout(resolve,0));await f.history.ended(f.terminal.historySessions().find(context=>context.summary.id===first.sessionId)!);
  const current=(await f.store.get(s.id))!;await f.host.manage({operation:'run-now',id:s.id,expectedRevision:current.revision,requestId:'manual_human_guard'});
  expect(f.children).toHaveLength(2);expect((await f.store.get(s.id))?.state).toBe('needs-human');expect(await f.store.runs(s.id)).toHaveLength(1);
});
test('a restored session ending before its scheduled completion is never resumed again automatically',async()=>{
  const f=await scheduledFixture();const s=(await f.create(true)).schedule!;await f.endOriginal();await f.host.tick();
  const first=(await f.store.runs(s.id))[0]!;expect(first.state).toBe('submitted');f.children[1]!.exit();
  await new Promise<void>(resolve=>setTimeout(resolve,0));await f.history.ended(f.terminal.historySessions().find(context=>context.summary.id===first.sessionId)!);
  await f.host.tick();expect((await f.store.runs(s.id))[0]?.state).toBe('unknown');expect((await f.store.get(s.id))?.state).toBe('needs-human');
  expect(f.children).toHaveLength(2);
});
test('two separately consented schedules cannot guess ownership of the same restored conversation',async()=>{
  const f=await scheduledFixture();const first=(await f.create(true)).schedule!,second=(await f.create(true)).schedule!;
  await f.endOriginal();await f.host.tick();
  const started=(await f.store.runs())[0]!;expect([first.id,second.id]).toContain(started.scheduleId);
  const blockedId=started.scheduleId===first.id?second.id:first.id;
  expect(f.children).toHaveLength(2);expect(f.children[1]!.writes.filter(part=>part.includes(first.prompt))).toHaveLength(1);
  await f.completeRestored();await f.host.tick();
  expect((await f.store.runs(started.scheduleId))[0]?.state).toBe('completed');
  expect((await f.store.get(blockedId))?.state).toBe('needs-human');expect(await f.store.runs(blockedId)).toEqual([]);
  expect(f.children).toHaveLength(2);expect(f.children[1]!.writes.filter(part=>part.includes(first.prompt))).toHaveLength(1);
});
test('two hosts competing with separately consented schedules restore and write only once',async()=>{
  const f=await scheduledFixture();const first=(await f.create(true)).schedule!,second=(await f.create(true)).schedule!;await f.endOriginal();
  const other=new WorkroomScheduleHost(new WorkroomScheduleStore(f.root,{read:async()=>Buffer.alloc(32,21),create:async()=>Buffer.alloc(32,21)}),f.adapter,{enabled:()=>true,now:f.clock});cleanups.push(()=>other.dispose());
  await Promise.all([
    f.host.manage({operation:'run-now',id:first.id,expectedRevision:first.revision,requestId:'competing_schedule_first'}),
    other.manage({operation:'run-now',id:second.id,expectedRevision:second.revision,requestId:'competing_schedule_second'}),
  ]);
  expect(f.children).toHaveLength(2);expect(await f.store.runs()).toHaveLength(1);
  expect(f.children[1]!.writes.filter(part=>part.includes(first.prompt))).toHaveLength(1);
});
test('existing consent and absent in-memory evidence do not permit unattended restore',async()=>{
  const f=await scheduledFixture();const s=(await f.create()).schedule!;await f.endOriginal();await f.host.tick();
  expect(f.children).toHaveLength(1);expect((await f.store.get(s.id))?.state).toBe('needs-human');
  const g=await scheduledFixture();const other=(await g.create(true)).schedule!;await g.endOriginal();
  const restartedAdapter=createWorkroomScheduleAdapter(g.terminal,g.history,{now:g.clock,delay:g.delay});
  const restarted=new WorkroomScheduleHost(g.store,restartedAdapter,{enabled:()=>true,now:g.clock});
  await restarted.tick();expect(g.children).toHaveLength(1);expect((await g.store.get(other.id))?.state).toBe('needs-human');
});
test('account replacement or transcript mutation prevents recovery before a terminal is started',async()=>{
  for(const change of ['account','transcript']){
    const f=await scheduledFixture();const s=(await f.create(true)).schedule!;await f.endOriginal();
    if(change==='account')writeFileSync(join(f.provider,'.credentials.json'),'fixture changed');
    else appendFileSync(f.transcript,JSON.stringify({type:'user',message:{content:'later external input'}})+'\n');
    await f.host.tick();expect(f.children).toHaveLength(1);expect((await f.store.get(s.id))?.state).toBe('needs-human');expect(await f.store.runs(s.id)).toEqual([]);
  }
});
test('revoked consent or changed transcript at launch prevents the resumed child',async()=>{
  for(const change of ['consent','transcript']){
    const f=await scheduledFixture();const s=(await f.create(true)).schedule!;await f.endOriginal();
    f.beforeLaunch(async()=>{if(change==='consent'){const current=(await f.store.get(s.id))!;await f.host.manage({operation:'pause',id:s.id,expectedRevision:current.revision});}
      else appendFileSync(f.transcript,JSON.stringify({type:'user',message:{content:'changed before launch'}})+'\n');});
    await f.host.tick();expect(f.children).toHaveLength(1);expect((await f.store.runs(s.id))[0]?.state).toBe('unknown');expect(f.child.writes.join('')).not.toContain(s.prompt);
  }
});
test('an unknown resume receipt is never replayed by a second host',async()=>{
  const f=await scheduledFixture();const s=(await f.create(true)).schedule!;await f.endOriginal();
  f.afterLaunch(async()=>{throw Error('fixture lost launch result');});await f.host.tick();
  const run=(await f.store.runs(s.id))[0]!;expect(run.state).toBe('unknown');expect(f.history.resumeReceipt(run.id+'_resume')?.state).toBe('unknown');expect(f.children).toHaveLength(2);
  const other=new WorkroomScheduleHost(new WorkroomScheduleStore(f.root,{read:async()=>Buffer.alloc(32,21),create:async()=>Buffer.alloc(32,21)}),f.adapter,{enabled:()=>true,now:f.clock});cleanups.push(()=>other.dispose());
  await other.tick();expect(f.children).toHaveLength(2);expect(f.children[1]!.writes.join('')).not.toContain(s.prompt);
});
test('two scheduler hosts share one real history resume and one real terminal input',async()=>{
  const f=await scheduledFixture();const s=(await f.create(true)).schedule!;await f.endOriginal();
  const other=new WorkroomScheduleHost(new WorkroomScheduleStore(f.root,{read:async()=>Buffer.alloc(32,21),create:async()=>Buffer.alloc(32,21)}),f.adapter,{enabled:()=>true,now:f.clock});cleanups.push(()=>other.dispose());
  await Promise.all([f.host.tick(),other.tick()]);expect(f.children).toHaveLength(2);expect((await f.store.runs(s.id))).toHaveLength(1);
  expect(f.children[1]!.writes.filter(part=>part.includes(s.prompt))).toHaveLength(1);
});
test('failed reservation evidence is released without exhausting future restore consent',async()=>{
  const f=await scheduledFixture(),realCreate=f.store.create.bind(f.store);
  f.store.create=async()=>{throw Error('fixture storage failure');};
  for(let i=0;i<34;i++)await expect(f.create(true)).rejects.toThrow('fixture storage failure');
  f.store.create=realCreate;const s=(await f.create(true)).schedule!;await f.endOriginal();
  expect(await f.adapter.inspectRestore!(s)).not.toBeNull();
});
test('a failed concurrent creation cannot delete the successful creation evidence',async()=>{
  const f=await scheduledFixture(),realCreate=f.store.create.bind(f.store);let calls=0,release!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;});
  f.store.create=async value=>{calls++;if(calls===1){await wait;throw Error('fixture concurrent failure');}
    const saved=await realCreate(value);release();return saved;};
  const request={operation:'create',id:crypto.randomUUID(),sessionId:f.session.id,title:'예약',prompt:'격리 상태 확인',mode:'continue',nextAt:f.clock(),intervalMs:300_000,expiresAt:f.clock()+86_400_000,maxRuns:10,consent:true,autoRestore:true};
  const results=await Promise.allSettled([f.host.manage(request),f.host.manage(request)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const s=(await f.store.get(request.id))!;await f.endOriginal();expect(await f.adapter.inspectRestore!(s)).not.toBeNull();
});
