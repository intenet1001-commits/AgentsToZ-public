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
  const runtime={async launch(input:any){calls.push({kind:'launch',input});return structuredClone(receipt);},async probe(input:any){calls.push({kind:'probe',input});return structuredClone(receipt);},async submit(input:any,value:any){calls.push({kind:'submit',input:value});return structuredClone(receipt);},async closeOwned(input:any){calls.push({kind:'close',input});return structuredClone(receipt);},async read(input:any,value:any){calls.push({kind:'read',input:value});return {receipt:structuredClone(receipt),text:'member output',cursor:'next',outcome:'read' as const};},async reveal(input:any){calls.push({kind:'reveal',input});return structuredClone(receipt);}} as TeamExternalRuntime;
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
test('an earlier written receipt never labels a refused follow-up as newly sent',async()=>{
  const f=fixture(),started=await f.bridge.start(f.input);
  expect(await f.bridge.send!(started.ref,'new instruction','different-request')).toMatchObject({delivery:'not-sent'});
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
