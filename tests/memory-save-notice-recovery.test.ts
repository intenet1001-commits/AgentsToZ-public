import {expect,test} from 'bun:test';
import {MemorySaveRecoveryAttempt,memorySaveRecoveryPrompt,MEMORY_RECOVERY_UNCONFIRMED,type MemorySaveRecoveryDependencies} from '../src/memorySaveNoticeRecovery';
import {ProjectMemoryAgentFailure,projectMemoryAgentOutput} from '../src/projectMemoryAgentFailure';
import type {AiTerminalRequest,AiTerminalSummary} from '../src/aiTerminalProtocol';
import {performMemorySaveNoticeRecovery,MemorySaveNoticeRecoveryError} from '../src/memorySaveNoticeRecoveryRoute';

const room=(over:Partial<AiTerminalSummary>={}):AiTerminalSummary=>({id:'session-123',targetId:'project-123',agent:'codex',state:'running',createdAt:'2026-10-29T06:00:00Z',exitCode:null,cols:100,rows:28,...over});
function fixture(over:Partial<MemorySaveRecoveryDependencies>={}){
  const starts:AiTerminalRequest[]=[],opened:string[]=[],resolved:string[]=[];
  const dependencies:MemorySaveRecoveryDependencies={resolve:async folder=>{resolved.push(folder);return {id:'project-123'};},
    start:async request=>{starts.push(request);return {session:room({agent:request.agent})};},list:async()=>[],
    open:async route=>{opened.push(route.sessionId);},newId:()=> 'request-123',...over};
  const attempt=new MemorySaveRecoveryAttempt({folder:'/private/exact-project',name:'Project',problem:'conflict'},dependencies);
  return {attempt,starts,opened,resolved};
}

test('nothing launches until explicitly clicked; the resolved project and chosen AI get one bounded diagnostic request',async()=>{
  const f=fixture();expect(f.starts.length).toBe(0);
  await f.attempt.launch('claude');
  expect(f.resolved).toEqual(['/private/exact-project']);
  expect(f.starts).toHaveLength(1);expect(f.starts[0]).toMatchObject({operation:'start',targetId:'project-123',agent:'claude',bypassPermissions:false});
  expect(f.starts[0]!.prompt).toContain('양쪽 원본');expect(f.starts[0]!.prompt).not.toContain('/private/exact-project');
  await f.attempt.launch('codex'); // It already exists: reopen that exact session, never another provider.
  expect(f.starts.length).toBe(1);expect(f.opened).toEqual(['session-123','session-123']);expect(f.attempt.phase).toBe('opened');
});

test('an unresolved or invalid registration starts nothing and can be checked again',async()=>{
  for(const resolve of [async()=>{throw Error('private path and token');},async()=>({id:'../../other-project'})]){
    const f=fixture({resolve});await expect(f.attempt.launch('codex')).rejects.toThrow('등록 경로');expect(f.starts.length).toBe(0);expect(f.attempt.phase).toBe('idle');
  }
});

test('two rapid clicks while resolving a project cannot launch two diagnostic agents',async()=>{
  let release!:(value:{id:string})=>void;
  const pending=new Promise<{id:string}>(resolve=>{release=resolve;});
  const f=fixture({resolve:()=>pending});const first=f.attempt.launch('codex');
  await expect(f.attempt.launch('codex')).rejects.toThrow('준비 중');expect(f.starts.length).toBe(0);
  release({id:'project-123'});await first;expect(f.starts.length).toBe(1);
});

test('a lost start reply never starts again; only user-selected sessions of that project and AI can open',async()=>{
  let starts=0;
  const f=fixture({start:async()=>{starts++;throw Error('private raw provider output');},list:async()=>[room(),room({id:'wrong-project',targetId:'other-123'}),room({id:'wrong-agent',agent:'claude'})]});
  await expect(f.attempt.launch('codex')).rejects.toThrow(MEMORY_RECOVERY_UNCONFIRMED);
  await expect(f.attempt.launch('codex')).rejects.toThrow(MEMORY_RECOVERY_UNCONFIRMED);expect(starts).toBe(1);
  expect((await f.attempt.rooms()).map(r=>r.id)).toEqual(['session-123']);
  await expect(f.attempt.openListed('wrong-project')).rejects.toThrow('이 프로젝트');expect(f.opened).toEqual([]);
  await f.attempt.openListed('session-123');expect(f.opened).toEqual(['session-123']);expect(starts).toBe(1);
});

test('a confirmed launch with a failed window retains the same session for the next open',async()=>{
  let views=0;const f=fixture({open:async()=>{if(++views===1)throw Error('popup denied');}});
  await expect(f.attempt.launch('codex')).rejects.toThrow('워크룸은 시작');expect(f.attempt.phase).toBe('started');
  await f.attempt.launch('codex');expect(f.starts.length).toBe(1);expect(views).toBe(2);
});

test('a mismatched start reply cannot open or silently retry another project',async()=>{
  const f=fixture({start:async()=>({session:room({targetId:'other-123'})})});
  await expect(f.attempt.launch('codex')).rejects.toThrow(MEMORY_RECOVERY_UNCONFIRMED);expect(f.opened).toEqual([]);
  await expect(f.attempt.launch('codex')).rejects.toThrow(MEMORY_RECOVERY_UNCONFIRMED);
});

test('diagnosis preserves uncertainty, existing local saves and both conflicting originals',()=>{
  expect(memorySaveRecoveryPrompt('unknown')).toContain('원래 요청의 영수증');
  expect(memorySaveRecoveryPrompt('backup')).toContain('기억 정리 AI를 다시 실행하지 말고');
  expect(memorySaveRecoveryPrompt('conflict')).toContain('강제 Pull/Push');
  const failure=new ProjectMemoryAgentFailure('codex',1);
  expect(failure.code).toBe('PROJECT_MEMORY_AGENT_FAILED');expect(failure.message.length).toBeLessThan(160);expect(failure.message).not.toContain('stderr');
});

test('failed provider output is discarded before it can enter an API error, while successful output reaches the existing guard',()=>{
  for(const agent of ['codex','claude'] as const){
    const secret='PRIVATE_USER_PROMPT_DO_NOT_RETURN';
    let failure:unknown;
    try{projectMemoryAgentOutput(agent,{exitCode:1,stdout:secret,stderr:`OpenAI Codex v0.163.0\nuser\n${secret.repeat(100)}`});}catch(error){failure=error;}
    expect(failure).toBeInstanceOf(ProjectMemoryAgentFailure);
    expect((failure as Error).message.includes(secret)).toBe(false);
    expect(JSON.stringify(failure).includes(secret)).toBe(false);
    expect(projectMemoryAgentOutput(agent,{exitCode:0,stdout:'guarded memory result',stderr:'diagnostic'})).toBe('guarded memory result');
  }
});

test('the voice recovery route accepts fixed metadata only and constructs its own prompt without bypass',async()=>{
  const calls:AiTerminalRequest[]=[];
  const input={operation:'start',requestId:'request-123',targetId:'project-123',agent:'codex',problem:'conflict'};
  const perform=async(request:AiTerminalRequest)=>{calls.push(request);return {session:room()};};
  for(const change of [{prompt:'arbitrary instructions'},{bypassPermissions:true},{folderPath:'/outside'},{agent:'hermes'},{problem:'execute-shell'},{targetId:'../../private'}]){
    await expect(performMemorySaveNoticeRecovery({...input,...change},perform)).rejects.toMatchObject({code:'MEMORY_RECOVERY_INPUT_INVALID'});
  }
  expect(calls).toEqual([]);
  expect(await performMemorySaveNoticeRecovery(input,perform)).toMatchObject({session:{targetId:'project-123'}});
  expect(calls[0]).toMatchObject({targetId:'project-123',agent:'codex',bypassPermissions:false,prompt:memorySaveRecoveryPrompt('conflict')});
});

test('the restricted route filters and bounds session metadata, and does not expose a failed start output',async()=>{
  const request={operation:'list',requestId:'request-123',targetId:'project-123',agent:'codex'};
  const rows=Array.from({length:30},(_,index)=>room({id:`session-${index}`,createdAt:new Date(Date.parse('2026-10-29T06:00:00Z')+index*1000).toISOString()}));
  const listed=await performMemorySaveNoticeRecovery(request,async()=>({sessions:[...rows,room({targetId:'other-123'}),room({agent:'claude'})]}));
  expect(listed.sessions).toHaveLength(16);expect(listed.sessions!.every(value=>value.targetId==='project-123'&&value.agent==='codex')).toBe(true);
  expect(listed.sessions![0]!.id).toBe('session-29');
  let failure:unknown;
  try{await performMemorySaveNoticeRecovery({...request,operation:'start',problem:'agent'},async()=>{throw Error('PRIVATE_PROVIDER_PROMPT');});}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(MemorySaveNoticeRecoveryError);
  expect(failure).toMatchObject({code:'MEMORY_RECOVERY_UNCONFIRMED',status:503});expect((failure as Error).message.includes('PRIVATE')).toBe(false);
});
