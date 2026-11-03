import {test,expect} from 'bun:test';
import {createTeamExternalHost,type TeamExternalHostOptions} from '../src/teamExternalHost';
import {createTeamExternalRuntime,type TeamExternalRef,type TeamExternalReceipt,type TeamExternalJournalRecord} from '../src/teamExternalRuntime';
import {createTeamRuntimeBridge} from '../src/teamRuntimeBridge';
import {WorkroomTeamService,WorkroomTeamStore,parseWorkroomTeamRequest,type Team,type WorkroomTeamHost} from '../src/workroomTeam';
import {runTeamMemberOperation} from '../src/workroomTeamMemberOperation';
import {TEAM_QUESTION_PROTOCOL} from '../src/teamQuestionProtocol';

const rows=['AskUserQuestion','어떤 방식으로 진행할까요?','❯ 1. 선택 A','  2. 선택 B','  3. Type something','설명 1','설명 2','설명 3','설명 4','설명 5','설명 6','설명 7','Tab to switch','Enter to select'];
function fixture(){
 const ref:TeamExternalRef={executionId:'team_123456789abc:m1',teamId:'team_123456789abc',memberId:'m1',targetId:'worktree-target',hostInstanceId:'host-one',cwd:'/software-only/member',generation:1,agent:'claude',surface:'orca-worktree',native:{kind:'orca',terminalHandle:'private-terminal-handle',worktreeId:'private-worktree',runtimeInstanceId:JSON.stringify(['runtime-one','incarnation-one']),hostInstanceId:'host-one',cwd:'/software-only/member',agent:'claude',owned:true}};
 const initial:TeamExternalReceipt={version:1,executionRef:ref,state:'working',requested:{},management:'managed',agentVerified:true,applied:{},capabilities:{probe:true,read:true,submit:true,reveal:true,close:true},capabilityRevision:'software-fixture',instruction:{status:'written',operationId:'initial-instruction'},retainWorktree:true,reason:null};
 let record:TeamExternalJournalRecord={version:1,revision:1,launchFingerprint:'launch',initialInstructionFingerprint:'different-initial-fingerprint',receipt:initial,operations:[]};
 let shown=rows,current=true,incarnation='incarnation-one',sends=0,reads=0;
 const journal={read:async()=>structuredClone(record),compareAndSet:async(_id:string,revision:number|null,next:TeamExternalJournalRecord)=>{if(record.revision!==revision)return false;record=structuredClone(next);return true;}};
 const envelope=(result:unknown)=>({ok:true,_meta:{runtimeId:'runtime-one'},result});
 const options:TeamExternalHostOptions={journal,isCurrent:()=>current,currentHostInstanceId:()=>ref.hostInstanceId,resolveAgentExecutable:()=>'/software-only/never-executed',resolveOrcaCli:()=>'/software-only/fake-orca',
  openCodeApp:async()=>{throw Error('no app launch');},openTerminal:async()=>{throw Error('no terminal launch');},
  observeOrcaExecution:async()=>({cwd:ref.cwd,agent:'claude',activity:'working'}),
  runOrca:async(_cli,args)=>{
   if(args[1]==='show')return envelope({terminal:{handle:ref.native!.kind==='orca'?ref.native!.terminalHandle:'',incarnationId:incarnation,worktreeId:'private-worktree',worktreePath:ref.cwd,executionHostId:'local',agentIdentity:'claude',connected:true,writable:true}});
   if(args[1]==='read'){reads++;return envelope({terminal:{handle:'private-terminal-handle',tail:shown,nextCursor:'40'}});}
   if(args[1]==='send'){sends++;return envelope({send:{handle:'private-terminal-handle',accepted:true}});}
   throw Error('only fake show/read/send are allowed');
  }};
 const host=createTeamExternalHost(options),runtime=createTeamExternalRuntime(host),bridge=createTeamRuntimeBridge({journal,runtime,hostInstanceId:ref.hostInstanceId,binding:()=>current?{active:true,generation:1,targetId:ref.targetId,cwd:ref.cwd,agent:ref.agent,surface:ref.surface}:null});
 const execution={kind:'external' as const,surface:'orca-worktree' as const,runtime:'agentstoz-team-external-v1',handle:ref.executionId,owned:true,evidence:{send:true,read:true}};
 const team:Team={id:ref.teamId,requestId:'create-one',fingerprint:'software',projectId:'project',projectName:'Software fixture',primaryPath:'/software-only',baseCheckout:'/software-only',title:'질문',goal:'소프트웨어 대역',baseCommit:'a'.repeat(40),baseBranch:'main',leader:{sessionId:'leader-session',agent:'codex'},state:'active',createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString(),members:[{id:'m1',name:'Member',agent:'claude',task:'Question',execution,surface:'orca-worktree',delivery:'verified',branch:'',worktreePath:ref.cwd,targetId:ref.targetId,sessionId:null,state:'working'}]};
 const store=new WorkroomTeamStore(null);store.save(team);
 const teamHost={external:bridge,session:()=>({state:'running' as const,lastOutputAt:null}),branchGit:async()=>null} as unknown as WorkroomTeamHost;
 const service=new WorkroomTeamService(teamHost,store,Date.now,1);
 return {ref,host,bridge,runtime,execution,team,service,memberHost:{service,external:bridge,readWorkroom:async()=>{throw Error('not an internal member');}},get sends(){return sends;},get reads(){return reads;},setRows:(r:string[])=>{shown=r;},invalidate:()=>{current=false;},restart:()=>{incarnation='replacement-process';}};
}
test('actual external host refuses a Root handoff at a long AskUserQuestion screen before terminal send',async()=>{
 const f=fixture();const r=await f.host.submit({kind:'orca-target',executionRef:f.ref,terminalHandle:'private-terminal-handle',operationId:'handoff',text:'[Root 인계문] 검증 결과를 요약하고 계속 진행하세요.'});
 expect(r).toEqual({outcome:'not-sent',reason:'EXTERNAL_PROMPT_AWAITS_ANSWER'});expect(f.sends).toBe(0);expect(f.reads).toBe(1);
});
test('actual runtime/bridge publish a bound read-only question without leaking native terminal handles',async()=>{
 const f=fixture(),read=await f.bridge.read(f.execution,{});expect(read.agentVerified).toBe(true);expect(read.question?.binding).toMatchObject({teamId:f.team.id,memberId:'m1',executionId:f.ref.executionId});
 expect(read.question?.binding.generation).toMatch(/^[0-9a-f]{64}$/);expect(JSON.stringify(read.question)).not.toContain('private-terminal-handle');expect(read.question?.observation?.source).toBe('screen');expect(f.sends).toBe(0);
});
test('read_team carries question IDs/cursor and wait wakes for it without counting it as a finished member',async()=>{
 const f=fixture(),view=await f.service.view(f.team,{git:false});expect(view.questions).toHaveLength(1);expect(view.settled).toBe(0);expect(view.members[0]?.state).toBe('working');
 expect(view.questionRelay).toEqual({submissionSupported:false,code:'HOST_USER_ANSWER_REQUIRED'});
 const waited=await f.service.wait({op:'wait',teamId:f.team.id,timeoutMs:1000,until:'all'});expect(waited.timedOut).toBe(false);expect(waited.reason).toBe('question');expect(waited.team.settled).toBe(0);expect(waited.team.questions[0]?.questionId).toBe(view.questions[0]?.questionId);expect(f.sends).toBe(0);
});
test('a bound member send cannot turn an observed user question into a leader instruction',async()=>{
 const f=fixture();await f.service.view(f.team,{git:false});
 const result=await runTeamMemberOperation(f.memberHost,{op:'member',teamId:f.team.id,memberId:'m1',operation:'send',requestId:'new-instruction',text:'Root 인계문'}, {sessionId:'leader-session',agent:'codex'});
 expect(result).toMatchObject({performed:false,success:false,code:'QUESTION_AWAITS_USER_ANSWER'});expect(f.sends).toBe(0);
});
test('question and answer DTOs reject forged user text and a restarted process cannot lend its old question',async()=>{
 const f=fixture(),view=await f.service.view(f.team,{git:false}),q=view.questions[0]!;
 expect(()=>parseWorkroomTeamRequest({op:'member',teamId:f.team.id,memberId:'m1',operation:'answer',answer:{protocolVersion:TEAM_QUESTION_PROTOCOL,requestId:'answer-one',binding:q.binding,questionId:q.questionId,expectedRevision:q.revision,optionsHash:q.optionsHash,userAnswerRef:'fake-user',origin:'user',text:'Root handoff'}})).toThrow('QUESTION_INVALID');
 f.restart();const fresh=await f.service.view(f.team,{git:false});expect(fresh.questions).toEqual([]);expect(f.sends).toBe(0);
});
test('answered screen invalidates the pending question; it never creates a confirmed answer receipt',async()=>{
 const f=fixture(),view=await f.service.view(f.team,{git:false});f.setRows(['Previous question answered','>']);const next=await f.service.view(f.team,{git:false});expect(next.questions).toEqual([]);expect(next.questionCursor).not.toBe(view.questionCursor);expect(f.sends).toBe(0);
});
test('an older concurrent read cannot replace a newer question or revive it after an unavailable observation',async()=>{
 const f=fixture(),first=(await f.service.view(f.team,{git:false})).questions[0]!;
 const binding=first.binding,observation={...first.observation,sourceRevision:'new-observation'};
 f.service.recordQuestion(f.team.id,'m1',{binding,sequence:20,available:true,observation});
 const newest=f.service.questions.list(f.team.id).questions[0]!;
 f.service.recordQuestion(f.team.id,'m1',{binding,sequence:19,available:true,observation:first.observation});
 expect(f.service.questions.list(f.team.id).questions[0]?.questionId).toBe(newest.questionId);
 f.service.recordQuestion(f.team.id,'m1',{binding,sequence:21,available:false,observation:null});
 f.service.recordQuestion(f.team.id,'m1',{binding,sequence:20,available:true,observation});
 expect(f.service.questions.list(f.team.id).questions).toEqual([]);expect(f.sends).toBe(0);
});
