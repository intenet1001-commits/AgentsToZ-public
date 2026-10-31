import {test,expect} from 'bun:test';
import {createTeamRuntimeBridge,type TeamRuntimeBinding} from '../src/teamRuntimeBridge';
import type {TeamExternalJournal,TeamExternalReceipt,TeamExternalRuntime,TeamExternalJournalRecord} from '../src/teamExternalRuntime';
import {teamPanelActionRequest} from '../src/workroomTeamPanelActions';
import {parseWorkroomTeamRequest} from '../src/workroomTeam';
import {runTeamMemberOperation} from '../src/workroomTeamMemberOperation';

function fixture(){
  let binding:TeamRuntimeBinding|null={targetId:'wt-owned',cwd:'/owned/member',agent:'claude',surface:'orca-worktree',generation:1,active:true};
  const records=new Map<string,TeamExternalJournalRecord>(),calls:{kind:string;input:any}[]=[];
  const receipt:TeamExternalReceipt={version:1,executionRef:{executionId:'team_123456789abc:m1',hostInstanceId:'host-one',teamId:'team_123456789abc',memberId:'m1',targetId:'wt-owned',cwd:'/owned/member',generation:1,agent:'claude',surface:'orca-worktree',native:{kind:'orca',terminalHandle:'private-native-handle',worktreeId:'private-worktree',runtimeInstanceId:'runtime-incarnation',hostInstanceId:'host-one',cwd:'/owned/member',agent:'claude',owned:true}},
    state:'awaiting-ack',management:'managed',agentVerified:false,requested:{},applied:{},capabilities:{probe:true,read:true,submit:true,reveal:true,close:true},capabilityRevision:'one',instruction:{status:'written',operationId:'initial-request'},retainWorktree:true,reason:null};
  const journal:TeamExternalJournal={async read(id){return structuredClone(records.get(id)??null);},async compareAndSet(){throw Error('not used');}};
  const save=(value:TeamExternalReceipt)=>records.set(value.executionRef.executionId,{version:1,revision:1,launchFingerprint:'x',receipt:structuredClone(value),operations:[]});save(receipt);
  const runtime={async launch(input:any){calls.push({kind:'launch',input});return structuredClone(receipt);},async probe(input:any){calls.push({kind:'probe',input});return structuredClone(receipt);},async submit(input:any,value:any){calls.push({kind:'submit',input:value});return structuredClone(receipt);},async closeOwned(input:any){calls.push({kind:'close',input});return structuredClone(receipt);},async read(input:any,value:any){calls.push({kind:'read',input:value});return {receipt:structuredClone(receipt),text:'member output',cursor:'next',outcome:'read' as const};},async reveal(input:any){calls.push({kind:'reveal',input});return structuredClone(receipt);},async keys(input:any,id:string,keys:readonly string[]){calls.push({kind:'keys',input:{id,keys}});return structuredClone(receipt);}} as TeamExternalRuntime;
  const bridge=createTeamRuntimeBridge({journal,runtime,hostInstanceId:'host-one',binding:()=>binding});
  const input={teamId:'team_123456789abc',memberId:'m1',memberName:'worker',agent:'claude' as const,plan:{surface:'orca-worktree' as const,options:{tmuxMode:false,reuse:'new' as const}},cwd:'/owned/member',targetId:'wt-owned',prompt:'the exact member brief',requestId:'initial-request',effort:{requestText:'task'}};
  return {bridge,input,calls,receipt,records,save,setBinding:(value:TeamRuntimeBinding|null)=>{binding=value;}};
}
test('the selected surface, explicit false and durable binding reach the runtime once without exposing native handles',async()=>{
  const f=fixture(),result=await f.bridge.start(f.input);
  expect(f.calls[0]!.input.requested.launchOptions).toEqual({tmuxMode:false,reuse:'new'});
  expect(f.calls[0]!.input.cwd).toBe('/owned/member');expect(result.state).toBe('awaiting-ack');
  expect(result.ref.handle).toBe('team_123456789abc:m1');expect(JSON.stringify(result)).not.toContain('private-native-handle');
  expect(f.bridge.isCurrent(f.receipt.executionRef)).toBe(true);
});
test('a checkout or generation change refuses a new launch before any external write',async()=>{
  const f=fixture();f.setBinding({targetId:'wt-owned',cwd:'/foreign',agent:'claude',surface:'orca-worktree',generation:2,active:true});
  expect(f.bridge.isCurrent(f.receipt.executionRef)).toBe(false);
  await expect(f.bridge.start(f.input)).rejects.toThrow('대상이 바뀌어');expect(f.calls).toHaveLength(0);
});
test('a sidecar restart permits only a separately verified read; it never rebinds submit or an unresolved write',async()=>{
  const f=fixture(),started=await f.bridge.start(f.input),old=f.records.get(started.ref.handle)!;
  let recoveryReads=0,submits=0;
  const journal:TeamExternalJournal={async read(){return structuredClone(old);},async compareAndSet(){throw Error('no journal writes');}};
  const runtime={async read(){return {receipt:{...f.receipt,reason:'EXTERNAL_GENERATION_STALE'},outcome:'unconfirmed',text:''};},async submit(){submits++;return f.receipt;}} as unknown as TeamExternalRuntime;
  const bridge=createTeamRuntimeBridge({journal,runtime,hostInstanceId:'new-host',binding:()=>({targetId:'wt-owned',cwd:'/owned/member',agent:'claude',surface:'orca-worktree',generation:1,active:true}),readAfterHostRestart:async()=>{recoveryReads++;return {text:'recovered output'};}});
  expect(await bridge.read(started.ref,{})).toMatchObject({outcome:'read',text:'recovered output',agentVerified:false,reason:'EXTERNAL_HOST_RESTART_READ_ONLY'});
  expect(bridge.isCurrent(f.receipt.executionRef)).toBe(false);
  old.operations=[{id:'unknown-write',kind:'submit',fingerprint:'x',status:'reserved'}];
  expect(await bridge.read(started.ref,{})).toMatchObject({outcome:'unconfirmed',text:''});
  expect(recoveryReads).toBe(1);expect(submits).toBe(0);
});
// After a restart: the record an earlier run wrote, a runtime that answers only STALE, and a recovery reader that counts its calls.
function restarted(options:{binding?:()=>TeamRuntimeBinding|null;hostInstanceId?:string;reason?:string;readCapability?:boolean;recover?:()=>Promise<{text:string;cursor?:string}|null>}={}){
  const f=fixture(),record=f.records.get('team_123456789abc:m1')!;
  if(options.readCapability===false)record.receipt.capabilities.read=false;
  let revision=record.revision,recoveryReads=0;
  const journal:TeamExternalJournal={async read(){return structuredClone({...record,revision});},async compareAndSet(){throw Error('no journal writes');}};
  const runtime={async read(){return {receipt:{...record.receipt,reason:options.reason??'EXTERNAL_GENERATION_STALE'},outcome:'unconfirmed',text:''};}} as unknown as TeamExternalRuntime;
  const current:TeamRuntimeBinding={targetId:'wt-owned',cwd:'/owned/member',agent:'claude',surface:'orca-worktree',generation:1,active:true};
  const bridge=createTeamRuntimeBridge({journal,runtime,hostInstanceId:options.hostInstanceId??'new-host',binding:options.binding??(()=>current),
    readAfterHostRestart:async()=>{recoveryReads++;return options.recover?options.recover():{text:'recovered output',cursor:'7'};}});
  const ref={kind:'external' as const,surface:'orca-worktree' as const,runtime:'agentstoz-team-external-v1',handle:'team_123456789abc:m1',owned:true,evidence:{send:true,read:true}};
  return {bridge,ref,record,get recoveryReads(){return recoveryReads;},bump(){revision++;}};
}
const UNCONFIRMED={outcome:'unconfirmed',text:'',reason:'EXTERNAL_GENERATION_STALE'};
test('restart read-only: a changed team generation, checkout, agent or an inactive team never reaches the recovery reader',async()=>{
  const base:TeamRuntimeBinding={targetId:'wt-owned',cwd:'/owned/member',agent:'claude',surface:'orca-worktree',generation:1,active:true};
  for(const moved of [{generation:2},{cwd:'/other/member'},{targetId:'wt-other'},{agent:'codex' as const},{surface:'orca-floating' as const},{active:false}]){
    const r=restarted({binding:()=>({...base,...moved})});
    expect(await r.bridge.read(r.ref,{})).toMatchObject(UNCONFIRMED);
    expect(r.recoveryReads).toBe(0);
  }
  const gone=restarted({binding:()=>null});
  expect(await gone.bridge.read(gone.ref,{})).toMatchObject(UNCONFIRMED);expect(gone.recoveryReads).toBe(0);
});
test('restart read-only: a binding or journal that changes during the recovery read discards what it read',async()=>{
  let generation=1;
  const moving=restarted({binding:()=>({targetId:'wt-owned',cwd:'/owned/member',agent:'claude',surface:'orca-worktree',generation,active:true}),
    recover:async()=>{generation=2;return {text:'output of a replaced binding'};}});
  const result=await moving.bridge.read(moving.ref,{});
  expect(result).toMatchObject(UNCONFIRMED);expect(result.text).not.toContain('replaced');expect(moving.recoveryReads).toBe(1);
  let written:ReturnType<typeof restarted>|null=null;
  written=restarted({recover:async()=>{written!.bump();return {text:'output read while a write landed'};}});
  expect(await written.bridge.read(written.ref,{})).toMatchObject(UNCONFIRMED);
  expect(written.recoveryReads).toBe(1);
  const missing=restarted({recover:async()=>null});
  expect(await missing.bridge.read(missing.ref,{})).toMatchObject(UNCONFIRMED);
});
test('restart read-only: only an earlier host\'s STALE read with a read capability and no unresolved write is recovered',async()=>{
  // The same host: a STALE read means its own binding moved — nothing is recovered.
  const same=restarted({hostInstanceId:'host-one'});
  expect(await same.bridge.read(same.ref,{})).toMatchObject(UNCONFIRMED);expect(same.recoveryReads).toBe(0);
  const other=restarted({reason:'EXTERNAL_BINDING_UNVERIFIED'});
  expect(await other.bridge.read(other.ref,{})).toMatchObject({outcome:'unconfirmed',reason:'EXTERNAL_BINDING_UNVERIFIED'});expect(other.recoveryReads).toBe(0);
  const noRead=restarted({readCapability:false});
  expect(await noRead.bridge.read(noRead.ref,{})).toMatchObject(UNCONFIRMED);expect(noRead.recoveryReads).toBe(0);
  const unresolved=restarted();
  unresolved.record.operations=[{id:'reveal-in-flight',kind:'reveal',fingerprint:'x',status:'reserved'}];
  expect(await unresolved.bridge.read(unresolved.ref,{})).toMatchObject(UNCONFIRMED);expect(unresolved.recoveryReads).toBe(0);
  // The recovered read itself: evidence only, never a verified agent, cursor passed through.
  const ok=restarted();
  expect(await ok.bridge.read(ok.ref,{limit:50})).toEqual({text:'recovered output',cursor:'7',agentVerified:false,outcome:'read',reason:'EXTERNAL_HOST_RESTART_READ_ONLY'});
  expect(ok.bridge.isCurrent(ok.record.receipt.executionRef)).toBe(false);
  expect(await ok.bridge.reveal(ok.ref,'reveal-after-restart')).toEqual({outcome:'refused'});
});
test('an earlier written receipt never labels a refused follow-up as newly sent',async()=>{
  const f=fixture(),started=await f.bridge.start(f.input);
  expect(await f.bridge.send!(started.ref,'new instruction','different-request')).toMatchObject({delivery:'not-sent'});
  f.receipt.reason='EXTERNAL_PROMPT_AWAITS_ANSWER';
  f.records.get(started.ref.handle)!.operations.push({id:'blocked-approval',kind:'submit',fingerprint:'a',status:'settled',outcome:'not-sent',reason:'EXTERNAL_PROMPT_AWAITS_ANSWER'});
  expect(await f.bridge.send!(started.ref,'another instruction','blocked-approval')).toEqual({delivery:'not-sent',note:'팀원이 승인·선택 화면에서 기다려 지시를 보내지 않았습니다. 화면을 확인하세요.'});
  expect(await f.bridge.send!(started.ref,'another instruction','never-attempted')).toMatchObject({delivery:'not-sent',note:'이 지시는 새로 보내지 않았습니다. 이전 전달 기록과 현재 실행 상태를 확인하세요.'});
  f.receipt.reason='EXTERNAL_SCREEN_UNAVAILABLE';
  f.records.get(started.ref.handle)!.operations.push({id:'unreadable-screen',kind:'submit',fingerprint:'b',status:'settled',outcome:'not-sent',reason:'EXTERNAL_SCREEN_UNAVAILABLE'});
  expect(await f.bridge.send!(started.ref,'another instruction','unreadable-screen')).toEqual({delivery:'not-sent',note:'팀원의 화면을 확인하지 못해 지시를 보내지 않았습니다.'});
  f.receipt.reason=null;
  f.receipt.instruction={status:'written',operationId:'new-request'};
  expect(await f.bridge.send!(started.ref,'another instruction','new-request')).toMatchObject({delivery:'verified'});
});
test('unknown lifetime never authorizes worktree cleanup and read preserves agent identity uncertainty',async()=>{
  const f=fixture(),started=await f.bridge.start(f.input);
  expect(await f.bridge.close!(started.ref)).toEqual({closed:'unknown'});
  expect(await f.bridge.read(started.ref,{limit:400})).toEqual({text:'member output',cursor:'next',agentVerified:false,outcome:'read',reason:null});
  await expect(f.bridge.read({...started.ref,owned:false},{limit:400})).rejects.toThrow('기록이 일치하지');
});
test('local human actions use the same strict core requests and cannot smuggle agent input or account settings',()=>{
  const base={sessionId:'leader_session',teamId:'team_123456789abc',memberId:'m1'};
  const confirm=teamPanelActionRequest({...base,operation:'confirm-member',confirm:'started'});
  expect(parseWorkroomTeamRequest(confirm.request)).toEqual({op:'confirm',teamId:base.teamId,memberId:'m1',confirm:'started'});
  const report=teamPanelActionRequest({...base,operation:'report-member',status:'done',summary:'read result'});
  expect(parseWorkroomTeamRequest(report.request)).toMatchObject({op:'report',manual:true});
  expect(()=>teamPanelActionRequest({...base,operation:'confirm-member',confirm:'started',text:'execute this'})).toThrow('허용되지');
  expect(()=>teamPanelActionRequest({...base,operation:'copy-brief',accountId:'host-default'})).toThrow('허용되지');
  expect(()=>teamPanelActionRequest({...base,operation:'copy-brief',memberId:'m7'})).toThrow('팀원');
});
test('a missing reveal capability or a refusal without this operation receipt never claims an external window opened',async()=>{
  const f=fixture(),started=await f.bridge.start(f.input);
  f.receipt.capabilities.reveal=false;f.save(f.receipt);
  expect(await f.bridge.reveal(started.ref,'reveal-no-cap')).toEqual({outcome:'refused'});
  expect(f.calls.filter(c=>c.kind==='reveal')).toHaveLength(0);
  f.receipt.capabilities.reveal=true;f.save(f.receipt);
  expect(await f.bridge.reveal(started.ref,'reveal-no-receipt')).toEqual({outcome:'refused'});
});
test('reveal uses its persisted operation outcome, including after probe recovery and old journal replay',async()=>{
  const f=fixture(),started=await f.bridge.start(f.input),record=f.records.get(started.ref.handle)!;
  const operation={id:'reveal-replay',kind:'reveal' as const,fingerprint:'same',status:'settled' as const};
  record.operations=[operation];
  expect(await f.bridge.reveal(started.ref,'reveal-replay')).toEqual({outcome:'unconfirmed'});
  record.operations=[{...operation,outcome:'unknown'}];
  f.receipt.state='working';
  expect(await f.bridge.reveal(started.ref,'reveal-replay')).toEqual({outcome:'unconfirmed'});
  record.operations=[{...operation,outcome:'performed'}];
  expect(await f.bridge.reveal(started.ref,'reveal-replay')).toEqual({outcome:'requested'});
  expect(await f.bridge.reveal(started.ref,'another-reveal')).toEqual({outcome:'refused'});
});
test('member output distinguishes a verified empty read from unsupported and interrupted reads',async()=>{
  const f=fixture(),started=await f.bridge.start(f.input);
  const team={state:'active',leader:{sessionId:'leader_session'},members:[{id:'m1',execution:started.ref}]};
  let outcome:'read'|'unavailable'|'unconfirmed'='unavailable';
  const host={service:{store:{get:()=>team}},external:{async read(){return {text:'',agentVerified:false,outcome,reason:outcome==='unavailable'?'EXTERNAL_CAPABILITY_UNAVAILABLE':null};}}} as any;
  const request={op:'member',teamId:f.input.teamId,memberId:'m1',operation:'read',limit:4000} as const;
  expect(await runTeamMemberOperation(host,request,null)).toMatchObject({success:false,performed:false,effect:'read-unavailable',text:''});
  outcome='unconfirmed';
  expect(await runTeamMemberOperation(host,request,null)).toMatchObject({success:false,performed:false,effect:'read-unconfirmed'});
  outcome='read';
  expect(await runTeamMemberOperation(host,request,null)).toMatchObject({success:true,performed:true,effect:'read-only',agentVerified:false,text:''});
});
test('a known unrelated Workroom cannot read a member or reveal its external window',async()=>{
  const f=fixture(),started=await f.bridge.start(f.input);let reads=0;
  const host={service:{store:{get:()=>({state:'active',leader:{sessionId:'leader_session'},members:[{id:'m1',execution:started.ref}]})}},external:{async read(){reads++;}}} as any;
  await expect(runTeamMemberOperation(host,{op:'member',teamId:f.input.teamId,memberId:'m1',operation:'read',limit:4000},
    {sessionId:'unrelated_session',agent:'claude',targetId:'foreign'})).rejects.toThrow('이 팀의 리더');
  expect(reads).toBe(0);
});


test('restart recovery does not treat a settled transport attempt as resolved delivery or closure',async()=>{
  for(const status of ['unknown','sending'] as const){
    const r=restarted();
    r.record.receipt.instruction.status=status;
    r.record.operations=[{id:'settled-send',kind:'submit',fingerprint:'x',status:'settled'}];
    expect(await r.bridge.read(r.ref,{})).toMatchObject(UNCONFIRMED);
    expect(r.recoveryReads).toBe(0);
  }
  for(const reason of ['EXTERNAL_CLOSE_UNKNOWN','EXTERNAL_OUTCOME_UNKNOWN']){
    const r=restarted();r.record.receipt.reason=reason;
    r.record.operations=[{id:'settled-close',kind:'close',fingerprint:'x',status:'settled'}];
    expect(await r.bridge.read(r.ref,{})).toMatchObject(UNCONFIRMED);
    expect(r.recoveryReads).toBe(0);
  }
});


test('restart diagnostics reach the member read response without exposing native identity',async()=>{
  const f=fixture(),record=f.records.get('team_123456789abc:m1')!;
  const journal:TeamExternalJournal={async read(){return structuredClone(record);},async compareAndSet(){throw Error('read only');}};
  const runtime={async read(){return {receipt:{...record.receipt,reason:'EXTERNAL_GENERATION_STALE'},outcome:'unconfirmed',text:''};}} as unknown as TeamExternalRuntime;
  const bridge=createTeamRuntimeBridge({journal,runtime,hostInstanceId:'new-host',binding:()=>({targetId:'wt-owned',cwd:'/owned/member',agent:'claude',surface:'orca-worktree',generation:1,active:true}),
    inspectAfterHostRestart:async()=>({outcome:'unconfirmed',reason:'EXTERNAL_RECOVERY_AGENT_UNVERIFIED'})});
  const ref={kind:'external' as const,surface:'orca-worktree' as const,runtime:'agentstoz-team-external-v1',handle:record.receipt.executionRef.executionId,owned:true,evidence:{send:true,read:true}};
  expect(await bridge.read(ref,{})).toEqual({outcome:'unconfirmed',text:'',agentVerified:false,reason:'EXTERNAL_RECOVERY_AGENT_UNVERIFIED'});
});

test('team member keys: only the leader asks, never into its own session, and the journal operation is the only answer',async()=>{
  const f=fixture(),started=await f.bridge.start(f.input),record=f.records.get(started.ref.handle)!,teamId=f.input.teamId;
  const keys=(memberId:string,requestId='keys-request-0001')=>({op:'member' as const,teamId,memberId,operation:'keys' as const,requestId,keys:['down','enter'] as ('down'|'enter')[]});
  expect(parseWorkroomTeamRequest({op:'member',teamId,memberId:'m1',operation:'keys',requestId:'keys-request-0001',keys:['down','enter']})).toEqual(keys('m1'));
  for(const bad of [[],['shift-tab'],Array(17).fill('enter'),'enter'])expect(()=>parseWorkroomTeamRequest({op:'member',teamId,memberId:'m1',operation:'keys',requestId:'keys-request-0001',keys:bad})).toThrow();
  expect(()=>parseWorkroomTeamRequest({op:'member',teamId,memberId:'m1',operation:'keys',requestId:'keys-request-0001',keys:['enter'],text:'yes'})).toThrow();
  const team={state:'active',leader:{sessionId:'leader_session'},members:[{id:'m1',execution:started.ref},{id:'m2',sessionId:'member_session_2',targetId:'wt-two'},{id:'m3',sessionId:'leader_session',targetId:'wt-lead'}]};
  const host={service:{store:{get:()=>team},refreshMembers(){},host:{}},external:f.bridge} as any,leader={sessionId:'leader_session',agent:'claude' as const,targetId:'wt-lead'};
  await expect(runTeamMemberOperation(host,keys('m1'),null)).rejects.toThrow('이끄는 워크룸');
  await expect(runTeamMemberOperation(host,keys('m1'),{sessionId:'unrelated_session',agent:'claude',targetId:'foreign'})).rejects.toThrow('이 팀의 리더');
  expect(f.calls.filter(c=>c.kind==='keys')).toHaveLength(0);
  // The runtime ran but recorded no operation: refused before typing, never success.
  expect(await runTeamMemberOperation(host,keys('m1'),leader)).toMatchObject({outcome:'refused',success:false,performed:false,effect:'keys-refused'});
  expect(f.calls.filter(c=>c.kind==='keys').map(c=>c.input)).toEqual([{id:'keys-request-0001',keys:['down','enter']}]);
  const operation={id:'keys-request-0001',kind:'keys' as const,fingerprint:'x'};
  for(const [settled,outcome] of [[{status:'settled',outcome:'performed'},'sent'],[{status:'settled',outcome:'not-sent'},'not-sent'],[{status:'settled',outcome:'unknown'},'unknown'],[{status:'settled'},'unknown'],[{status:'reserved'},'unknown']] as const){
    record.operations=[{...operation,...settled}];
    expect(await runTeamMemberOperation(host,keys('m1'),leader)).toMatchObject({outcome,success:outcome==='sent',performed:outcome==='sent',effect:`keys-${outcome}`});
  }
  // A Workroom member answers its own screen through send_workroom_keys; the leader's own session never takes team keys.
  expect(await runTeamMemberOperation(host,keys('m2'),leader)).toMatchObject({surface:'internal',effect:'send-workroom-keys-required',performed:false});
  await expect(runTeamMemberOperation(host,keys('m3'),leader)).rejects.toThrow('자기 세션');
  team.state='closed';
  await expect(runTeamMemberOperation(host,keys('m1'),leader)).rejects.toThrow('정리된 팀');
});
