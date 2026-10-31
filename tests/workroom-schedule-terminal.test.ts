import {afterEach,expect,test} from 'bun:test';
import {chmodSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AiTerminalService} from '../src/aiTerminalService';
import {readWorkroomTranscriptWitness} from '../src/aiTerminalActivityTranscript';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {WorkroomSubmissions} from '../src/workroomSubmissions';
import {WorkroomScheduleHost} from '../src/workroomScheduleHost';
import {WorkroomScheduleStore} from '../src/workroomScheduleStore';
import type {WorkroomSchedule,WorkroomScheduleRun} from '../src/workroomScheduleProtocol';
const passthroughGate=<T>(effect:()=>T):T=>effect();
const cleanup:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
test('Hermes and agy cannot authorize unattended input using a quiet or ready-looking screen',async()=>{
  for(const agent of ['hermes','agy'] as const){
    const root=mkdtempSync(join(tmpdir(),'schedule-unsupported-'));chmodSync(root,0o700);cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
    const writes:string[]=[];let emit!:(text:string)=>void;let end!:(code:number)=>void;
    const exited=new Promise<number>(resolve=>{end=resolve;});
    const terminal=new AiTerminalService({resolveTarget:async()=>({cwd:root}),executable:()=>'/owned/fake-cli',env:{HOME:root,PATH:'/usr/bin'},activitySampler:false,
      spawn:(_args,options:any)=>{emit=text=>options.terminal.data(null,Buffer.from(text));return {pid:9000000,exited,kill:()=>end(0),terminal:{write:(text:string)=>{writes.push(text);return Buffer.byteLength(text);},resize(){},close(){}}} as any;},
      signalGroup:()=>end(0)});cleanup.push(()=>terminal.shutdown());
    const session=(await terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:'schedule_target',agent,cols:80,rows:24})).session!;
    emit('\x1b[2J\x1b[H── ready │\r\n────────\r\n❯ \r\n────────');
    await expect(terminal.scheduleSnapshot(session.id)).rejects.toThrow('현재 모델·계정·대화와 요청 완료');
    let key:Buffer|null=null;const now=Date.now();
    const store=new WorkroomScheduleStore(root,{read:async()=>key?Buffer.from(key):null,create:async()=>Buffer.from(key=Buffer.alloc(32,48))});
    const host=new WorkroomScheduleHost(store,{inspect:id=>terminal.scheduleSnapshot(id),inspectBound:(s,id)=>terminal.inspectBoundSchedule(s,id),
      dispatch:(s,r,snapshot,active,gate)=>terminal.dispatchSchedule(s,r,snapshot,active,gate),reconcile:r=>terminal.reconcileSchedule(r)},
      {enabled:()=>true,now:()=>now});cleanup.push(()=>host.dispose());
    const view=await host.manage({operation:'list',sessionId:session.id});
    expect(view).toMatchObject({snapshot:null,problem:expect.stringContaining('현재 모델·계정·대화와 요청 완료'),schedules:[],runs:[]});
    for(const mode of ['continue','new-conversation'] as const){
      await expect(host.manage({operation:'create',id:'schedule_unsupported_'+agent+'_'+mode.replace('-','_'),sessionId:session.id,
        title:'지원 확인',prompt:'이 요청은 전송되지 않아야 합니다.',mode,nextAt:now,intervalMs:300000,expiresAt:now+86400000,maxRuns:2,consent:true}))
        .rejects.toThrow('현재 모델·계정·대화와 요청 완료');
    }
    await host.tick();expect(await store.list()).toEqual([]);expect(await store.runs()).toEqual([]);
    // A stale or imported record cannot bypass the same adapter check on the maintenance tick.
    const stale:WorkroomSchedule={id:'schedule_stale_'+agent,title:'이전 예약',prompt:'전송 금지',mode:'continue',
      binding:{sessionId:session.id,targetId:'schedule_target',agent,model:'unverified-model',accountId:'host-default',identity:'unverified-identity',bypass:false},
      intentHash:'unverified',state:'active',revision:1,consentRevision:1,createdAt:now,expiresAt:now+86400000,nextAt:now,
      intervalMs:300000,maxRuns:2,runCount:0,retryAt:0,reason:''};
    await store.create(stale);await host.tick();
    expect((await store.get(stale.id))?.state).toBe('needs-human');expect(await store.runs()).toEqual([]);
    expect(writes).toEqual([]);
  }
});
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'schedule-terminal-'));chmodSync(root,0o700);cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'.codex'));
  const providerId='01234567-89ab-4cde-8fab-0123456789ab',dir=join(root,'.codex','sessions','2026','10','27');mkdirSync(dir,{recursive:true});
  const transcript=join(dir,'rollout-2026-10-27T00-00-00-'+providerId+'.jsonl');
  let clock=1_800_000_000_000;let nextCompletion=false;const children:{emit(s:string):void;exit():void;writes:string[];args:string[]}[]=[];
  const journal=new WorkroomConversationJournal(root);cleanup.push(()=>journal.close());
  const terminal=new AiTerminalService({resolveTarget:async()=>({cwd:root}),executable:()=>'/owned/fake-codex',env:{HOME:root,PATH:'/usr/bin'},
    activitySampler:false,activityClock:()=>clock,submissions:()=>journal,codexHookTrustSupported:async()=>false,
    turnSignals:{forget(){},async poll(){if(!nextCompletion)return {completions:[],bytes:0};nextCompletion=false;
      const timestamp=new Date(clock).toISOString(),rows=[{type:'session_meta',payload:{id:providerId,cwd:realpathSync(root),timestamp,source:'cli'}},{type:'event_msg',payload:{type:'user_message',message:'fixture'}},{type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:'fixture-completion'}}];
      writeFileSync(transcript,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
      return {completions:[{key:'codex:fixture-completion',completedAt:clock}],bytes:0,witness:readWorkroomTranscriptWitness(transcript,'codex','codex:fixture-completion')??undefined};}},
    signalGroup:pid=>children[pid-8000001]?.exit(),spawn:(args,options:any)=>{
      let end!:(n:number)=>void;const exited=new Promise<number>(resolve=>{end=resolve;});const writes:string[]=[];
      children.push({args:[...args],writes,emit:s=>options.terminal.data(null,Buffer.from(s)),exit:()=>{options.terminal.exit?.();end(0);}});
      return {pid:8000000+children.length,exited,kill:()=>children.at(-1)!.exit(),terminal:{write:(s:string)=>{writes.push(s);return Buffer.byteLength(s);},resize(){},close(){}}} as any;
    }});cleanup.push(()=>terminal.shutdown());
  const session=(await terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:'schedule_target',agent:'codex',cols:80,rows:24},undefined,{launchModel:{model:'gpt-fixture'}})).session!;
  const child=children[0]!;child.emit('\x1b[2J\x1b[Hgpt-fixture high\r\n\r\n› ');
  clock+=10000;await terminal.sampleActivity();clock+=10000;await terminal.sampleActivity();
  const snapshot=await terminal.scheduleSnapshot(session.id);
  const schedule:WorkroomSchedule={id:'schedule_test_01',title:'검사',prompt:'현재 프로젝트 상태를 보고해 줘.',mode:'continue',binding:snapshot.binding,intentHash:'intent',state:'active',revision:1,consentRevision:1,createdAt:clock,expiresAt:clock+86400000,nextAt:clock,intervalMs:300000,maxRuns:10,runCount:0,retryAt:0,reason:''};
  const run:WorkroomScheduleRun={id:'schedule_run_test_01',scheduleId:schedule.id,leaseKey:'lease',consentRevision:1,state:'dispatching',startedAt:clock,updatedAt:clock,sessionId:session.id,reason:''};
  return {root,terminal,session,children,child,snapshot,schedule,run,journal,transcript,complete:async()=>{nextCompletion=true;clock+=100;await terminal.sampleActivity();},advance:async()=>{clock+=10000;await terminal.sampleActivity();}};
}
test('real terminal adapter sends a whole request once under its original input revision',async()=>{
  const f=await fixture();expect(f.snapshot.ready).toBe(true);
  expect(await f.terminal.dispatchSchedule(f.schedule,f.run,f.snapshot,()=>true,passthroughGate)).toMatchObject({state:'submitted',inputRevision:1,sessionId:f.session.id});
  expect(f.child.writes.join('')).toContain(f.schedule.prompt);expect(f.terminal.inspectSession(f.session.id,'schedule_target').inputRevision).toBe(1);
});
test('revoking a schedule after the body leaves a draft, never an Enter or automatic replay',async()=>{
  const f=await fixture();let active=true,calls=0;
  const gate=<T>(effect:()=>T):T=>{if(!active)throw Error('revoked');const result=effect();if(++calls===1)active=false;return result;};
  expect(await f.terminal.dispatchSchedule(f.schedule,f.run,f.snapshot,()=>active,gate)).toMatchObject({state:'unknown'});
  expect(f.child.writes.join('')).toBe(f.schedule.prompt);expect(f.child.writes).not.toContain('\r');
  expect(new WorkroomSubmissions(()=>f.journal).find(f.run.id,{owner:'schedule:'+f.run.id,sessionId:f.session.id})?.receipt.state).toBe('unknown');
});
test('a revoked spawn gate never starts a scheduled new conversation',async()=>{
  const f=await fixture();f.schedule.mode='new-conversation';
  await expect(f.terminal.dispatchSchedule(f.schedule,f.run,f.snapshot,()=>true,()=>{throw Error('revoked');})).rejects.toThrow('revoked');
  expect(f.children).toHaveLength(1);expect(f.child.writes).toEqual([]);
});
test('a submitted turn whose terminal exits without a completion remains unknown and blocks later scheduled writes',async()=>{
  const f=await fixture();let now=f.run.startedAt,key:Buffer|null=null;
  const store=new WorkroomScheduleStore(f.root,{read:async()=>key?Buffer.from(key):null,create:async()=>Buffer.from(key=Buffer.alloc(32,47))});
  const host=new WorkroomScheduleHost(store,{inspect:id=>f.terminal.scheduleSnapshot(id),inspectBound:(s,id)=>f.terminal.inspectBoundSchedule(s,id),
    dispatch:(s,r,snapshot,active,gate)=>f.terminal.dispatchSchedule(s,r,snapshot,active,gate),reconcile:r=>f.terminal.reconcileSchedule(r)},{enabled:()=>true,now:()=>now});cleanup.push(()=>host.dispose());
  const result=await host.manage({operation:'create',id:'schedule_exit_unknown',sessionId:f.session.id,title:'반복 검사',prompt:'프로젝트 상태를 확인해 줘.',mode:'continue',nextAt:now,intervalMs:300000,expiresAt:now+86400000,maxRuns:4,consent:true});
  const schedule=(result as {schedule:WorkroomSchedule}).schedule;await host.tick();expect((await store.runs(schedule.id))[0]?.state).toBe('submitted');
  const writes=[...f.child.writes];f.child.exit();await new Promise(resolve=>setTimeout(resolve,20));now+=300001;await host.tick();
  expect((await store.runs(schedule.id))[0]?.state).toBe('unknown');expect((await store.get(schedule.id))?.state).toBe('needs-human');
  now+=300001;await host.tick();expect(await store.runs(schedule.id)).toHaveLength(1);expect(f.child.writes).toEqual(writes);
});
test('a proven exact completion remains completed when the terminal later exits',async()=>{
  const f=await fixture();const sent=await f.terminal.dispatchSchedule(f.schedule,f.run,f.snapshot,()=>true,passthroughGate);await f.complete();f.child.exit();await new Promise(resolve=>setTimeout(resolve,20));
  expect(await f.terminal.reconcileSchedule({...f.run,state:'submitted',sessionId:sent.sessionId,inputRevision:sent.inputRevision})).toBe('completed');
});
test('human input after admission is retained and the schedule never writes over it',async()=>{
  const f=await fixture();await f.terminal.perform({operation:'input',requestId:crypto.randomUUID(),sessionId:f.session.id,data:'human draft'});const writes=[...f.child.writes];
  await expect(f.terminal.dispatchSchedule(f.schedule,f.run,f.snapshot,()=>true,passthroughGate)).rejects.toThrow('변경');expect(f.child.writes).toEqual(writes);
});
test('bound inspection reports absence separately from a changed or unrelated live terminal',async()=>{
  const f=await fixture();expect(await f.terminal.inspectBoundSchedule(f.schedule,f.session.id)).toMatchObject({ready:true});
  expect(await f.terminal.inspectBoundSchedule(f.schedule,'missing_session')).toBeNull();
  const other=(await f.terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:'schedule_target',agent:'codex',cols:80,rows:24},undefined,{launchModel:{model:'gpt-fixture'}})).session!;
  await expect(f.terminal.inspectBoundSchedule(f.schedule,other.id)).rejects.toThrow('결속');
  writeFileSync(join(f.root,'.codex','auth.json'),'new fake account');
  await expect(f.terminal.inspectBoundSchedule(f.schedule,f.session.id)).rejects.toThrow('변경');
  expect(f.child.writes).toEqual([]);
});
test('a quiet TUI after a submitted turn is not proof that the model or tool finished',async()=>{
  const f=await fixture();await f.terminal.dispatchSchedule(f.schedule,f.run,f.snapshot,()=>true,passthroughGate);
  f.child.emit('\x1b[2J\x1b[Hgpt-fixture high\r\n\r\n› ');await f.terminal.sampleActivity();
  const snapshot=await f.terminal.scheduleSnapshot(f.session.id);expect(snapshot.ready).toBe(false);expect(f.terminal.inspectSession(f.session.id,'schedule_target').completedInputRevision).toBeNull();
});
test('recovery facts require the last exact transcript completion and a stable explicit launch model',async()=>{
  const f=await fixture();await expect(f.terminal.scheduleRestoreFacts(f.session.id)).rejects.toThrow('마지막 요청 완료');
  await f.terminal.dispatchSchedule(f.schedule,f.run,f.snapshot,()=>true,passthroughGate);
  await expect(f.terminal.scheduleRestoreFacts(f.session.id)).rejects.toThrow('마지막 요청 완료');
  await f.complete();
  const facts=await f.terminal.scheduleRestoreFacts(f.session.id);
  expect(facts).toMatchObject({sessionId:f.session.id,launchModel:{model:'gpt-fixture'},inputRevision:1,completedInputRevision:1});
  expect(facts.configFingerprint).toHaveLength(64);
  await f.terminal.perform({operation:'input',requestId:crypto.randomUUID(),sessionId:f.session.id,data:'new draft'});
  await expect(f.terminal.scheduleRestoreFacts(f.session.id)).rejects.toThrow('마지막 요청 완료');
});
test('a completion with no visible current model cannot authorize later unattended recovery',async()=>{
  const f=await fixture();await f.terminal.dispatchSchedule(f.schedule,f.run,f.snapshot,()=>true,passthroughGate);
  f.child.emit('\x1b[2J\x1b[H› ');await f.complete();
  await expect(f.terminal.scheduleRestoreFacts(f.session.id)).rejects.toThrow('마지막 요청 완료');
});
test('a newly displayed approval, account replacement or revoked consent prevents scheduled input',async()=>{
  for(const cause of ['approval','account','revoked']){
    const f=await fixture();
    if(cause==='approval')f.child.emit('\x1b[2J\x1b[HAllow this command?\r\n1. Yes\r\n2. No\r\n› ');
    if(cause==='account')writeFileSync(join(f.root,'.codex','auth.json'),'owned fake credential metadata');
    await expect(f.terminal.dispatchSchedule(f.schedule,f.run,f.snapshot,()=>cause!=='revoked',passthroughGate)).rejects.toThrow();expect(f.child.writes).toEqual([]);
  }
});
test('new-conversation repeats keep the chosen model and account while using normal approvals',async()=>{
  const f=await fixture();expect(f.snapshot.canStartNew).toBe(true);f.schedule.mode='new-conversation';
  const result=await f.terminal.dispatchSchedule(f.schedule,f.run,f.snapshot,()=>true,passthroughGate);
  expect(result.sessionId).not.toBe(f.session.id);expect(f.children).toHaveLength(2);expect(f.child.writes).toEqual([]);
  expect(result.inputRevision,'the launch prompt is the native initial turn, not a later PTY input').toBe(0);
  expect(f.children[1]!.args).toContain('gpt-fixture');expect(f.children[1]!.args).toContain(f.schedule.prompt);expect(f.children[1]!.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
});
test('host history resume can explicitly carry the original model without injecting a request',async()=>{
  const f=await fixture();let validated=0,launching=0;
  await f.terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:'schedule_target',agent:'codex',accountId:'host-default',cols:80,rows:24},undefined,
    {launchModel:{model:'gpt-fixture'},historyResume:{logicalConversationId:'history_fixture',resume:{agent:'codex',conversationId:'01234567-89ab-4cde-8fab-0123456789ab'},accountId:'host-default',cwd:f.root,validate:()=>{validated++;},launching:()=>{launching++;}}});
  const args=f.children[1]!.args;
  expect(args).toContain('resume');expect(args).toContain('01234567-89ab-4cde-8fab-0123456789ab');expect(args).toContain('gpt-fixture');expect(validated).toBeGreaterThan(0);expect(launching).toBe(1);expect(f.children[1]!.writes).toEqual([]);
});
test('a verified resumed terminal remains bound to its original schedule and refuses later human input',async()=>{
  const f=await fixture();await f.terminal.dispatchSchedule(f.schedule,f.run,f.snapshot,()=>true,passthroughGate);await f.complete();
  f.child.exit();await new Promise(resolve=>setTimeout(resolve,20));
  const providerConversationId='01234567-89ab-4cde-8fab-0123456789ab';
  const resumed=(await f.terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:'schedule_target',agent:'codex',accountId:'host-default',cols:80,rows:24},undefined,
    {launchModel:{model:'gpt-fixture'},historyResume:{logicalConversationId:'history_fixture',resume:{agent:'codex',conversationId:providerConversationId},accountId:'host-default',cwd:f.root,validate:()=>{},launching:()=>{}}})).session!;
  f.children[1]!.emit('\x1b[2J\x1b[Hgpt-fixture high\r\n\r\n› ');await f.advance();await f.advance();
  await expect(f.terminal.adoptRestoredSchedule(f.schedule,resumed.id,'another-conversation')).rejects.toThrow();
  const restored=await f.terminal.adoptRestoredSchedule(f.schedule,resumed.id,providerConversationId);
  expect(restored.binding).toMatchObject({...f.schedule.binding,sessionId:resumed.id});expect(restored.ready).toBe(true);
  const run={...f.run,id:'schedule_run_next',sessionId:resumed.id};
  expect(await f.terminal.dispatchSchedule(f.schedule,run,restored,()=>true,passthroughGate)).toMatchObject({state:'submitted',sessionId:resumed.id,inputRevision:1});
  await f.terminal.perform({operation:'input',requestId:crypto.randomUUID(),sessionId:resumed.id,data:'human draft'});
  await expect(f.terminal.inspectBoundSchedule(f.schedule,resumed.id)).rejects.toThrow('결속');
});
test('restoration refuses a different model or a draft already typed into the resumed terminal',async()=>{
  for(const cause of ['model','draft'] as const){
    const f=await fixture();await f.terminal.dispatchSchedule(f.schedule,f.run,f.snapshot,()=>true,passthroughGate);await f.complete();f.child.exit();await new Promise(resolve=>setTimeout(resolve,20));
    const providerConversationId='01234567-89ab-4cde-8fab-0123456789ab';
    const resumed=(await f.terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:'schedule_target',agent:'codex',accountId:'host-default',cols:80,rows:24},undefined,
      {launchModel:{model:cause==='model'?'gpt-other':'gpt-fixture'},historyResume:{logicalConversationId:'history_fixture',resume:{agent:'codex',conversationId:providerConversationId},accountId:'host-default',cwd:f.root,validate:()=>{},launching:()=>{}}})).session!;
    if(cause==='draft')await f.terminal.perform({operation:'input',requestId:crypto.randomUUID(),sessionId:resumed.id,data:'human draft'});
    const writes=[...f.children[1]!.writes];
    await expect(f.terminal.adoptRestoredSchedule(f.schedule,resumed.id,providerConversationId)).rejects.toThrow();expect(f.children[1]!.writes).toEqual(writes);
  }
});
test('a transcript changed after the observed completion cannot be restored automatically',async()=>{
  const f=await fixture();await f.terminal.dispatchSchedule(f.schedule,f.run,f.snapshot,()=>true,passthroughGate);await f.complete();f.child.exit();await new Promise(resolve=>setTimeout(resolve,20));
  const providerConversationId='01234567-89ab-4cde-8fab-0123456789ab';
  const resumed=(await f.terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:'schedule_target',agent:'codex',accountId:'host-default',cols:80,rows:24},undefined,
    {launchModel:{model:'gpt-fixture'},historyResume:{logicalConversationId:'history_fixture',resume:{agent:'codex',conversationId:providerConversationId},accountId:'host-default',cwd:f.root,validate:()=>{},launching:()=>{}}})).session!;
  writeFileSync(f.transcript,JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'changed'}})+'\n');
  await expect(f.terminal.adoptRestoredSchedule(f.schedule,resumed.id,providerConversationId)).rejects.toThrow('변경');expect(f.children[1]!.writes).toEqual([]);
});
test('replacing CLI settings after consent changes the scheduling binding before any input',async()=>{
  const f=await fixture();writeFileSync(join(f.root,'.codex','config.toml'),'model_provider = "another-provider"\n');
  expect((await f.terminal.scheduleSnapshot(f.session.id)).binding.identity).not.toBe(f.snapshot.binding.identity);
  await expect(f.terminal.dispatchSchedule(f.schedule,f.run,f.snapshot,()=>true,passthroughGate)).rejects.toThrow('변경');expect(f.child.writes).toEqual([]);
});
test('a host-only final input guard is honored even with a scoped authority',async()=>{
  const f=await fixture();
  await expect(f.terminal.submitHostInstruction({id:'scheduled_guard_failure',sessionId:f.session.id,data:'절대 보내지 말기\r',receiptOwner:'schedule:guard',active:()=>true,beforeInput:async()=>{throw Error('final guard');}})).rejects.toThrow('final guard');
  expect(f.child.writes).toEqual([]);
});
test('a final synchronous start guard prevents spawning after an asynchronous target revalidation',async()=>{
  const f=await fixture();await expect(f.terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId:'schedule_target',agent:'codex',cols:80,rows:24,prompt:'보내지 말기'},undefined,
    {startGuard:async()=>()=>{throw Error('late revocation');}})).rejects.toThrow('late revocation');expect(f.children).toHaveLength(1);
});
