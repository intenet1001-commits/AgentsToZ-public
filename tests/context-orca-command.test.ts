import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {claudeOrcaComposerEmpty,performContextOrcaCommand,type ContextOrcaHost} from '../src/contextOrcaCommand';
import {normalizeContextCommandRequest} from '../src/contextSessionCommand';
import {acknowledgeContextCommand,checkContextCommand,contextCommandAttempts,syncAndRunOrcaContextCommand} from '../src/contextSessionCommandClient';

/** A fake Orca CLI envelope host: every answer is what Orca 1.4.219 printed for the same call (2026-10-29). */
const S1='0bbbc3c7-9ae3-4878-856d-4097479f1a3f',S2='9d0c6a51-1111-4b22-8c33-0123456789ab';
const tab=(s:string)=>`tab-${s.slice(0,8)}`,leaf=(s:string)=>`leaf-${s.slice(0,8)}`,handleOf=(s:string)=>`term_${s.slice(0,8)}`;
const worktreeId='bdfe4122-e699-4912-9ebb-a463f8074b00::/Users/fixture/project';
const IDLE=['⏺ Done.','──────────────────────────────','❯ ','──────────────────────────────','  ⏵⏵ bypass permissions on'];
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const c of cleanup.splice(0))c();});

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'context-orca-')),journal=new WorkroomConversationJournal(root);
  cleanup.push(()=>{journal.close();rmSync(root,{recursive:true,force:true});});
  const calls:string[][]=[],sends:string[][]=[];
  const f={
    runtime:'rt-1',incarnation:'inc-1',screen:IDLE as string[],draft:undefined as string|undefined,idle:true,memory:[] as boolean[],
    showRuntime:undefined as string|undefined,showHandle:undefined as string|undefined,reshow:{incarnation:undefined as string|undefined},
    send:'accepted' as 'accepted'|'not-accepted'|'throw'|'other-runtime'|'other-incarnation',
    calls,sends,journal,
  };
  let shows=0;
  const env=(result:unknown,runtime=f.runtime)=>({id:crypto.randomUUID(),ok:true,result,_meta:{runtimeId:runtime}});
  const host:ContextOrcaHost={
    snapshot:id=>[S1,S2].includes(id)?{sessionId:id,cwd:'/Users/fixture/project',launchContext:{orcaPaneKey:`${tab(id)}:${leaf(id)}`,orcaWorktreeId:worktreeId,termProgram:'Orca'}}:null,
    sessionState:()=>({kind:'ok',state:{workspaceSession:{sleepingAgentSessionsByPaneKey:Object.fromEntries([S1,S2].map(id=>[`${tab(id)}:${leaf(id)}`,
      {paneKey:`${tab(id)}:${leaf(id)}`,tabId:tab(id),worktreeId,agent:'claude',providerSession:{id}}]))}}}),
    cli:()=>'/fake/orca',
    run:async(_cli,args)=>{
      calls.push(args);
      const handle=args[args.indexOf('--terminal')+1]!;
      if(args[0]==='status')return env({app:{running:true},runtime:{reachable:true,runtimeId:f.runtime,capabilities:['terminal.prompt-delivery.v1']}});
      if(args[1]==='list')return env({terminals:[S1,S2].map(id=>({handle:handleOf(id),tabId:tab(id),leafId:leaf(id),worktreeId,connected:true,orphaned:false,agentIdentity:'claude'}))});
      if(args[1]==='show'){
        const s=[S1,S2].find(id=>handleOf(id)===handle)!,again=shows++>0;
        return env({terminal:{handle:f.showHandle??handle,tabId:tab(s),leafId:leaf(s),worktreeId,incarnationId:again?f.reshow.incarnation??f.incarnation:f.incarnation,
          agentIdentity:'claude',connected:true,writable:true,executionHostId:'local'}},f.showRuntime??f.runtime);
      }
      if(args[1]==='wait')return f.idle?env({wait:{handle,condition:'tui-idle',satisfied:true,status:'running'}}):{ok:false,error:{code:'timeout',message:'timeout'},_meta:{runtimeId:f.runtime}};
      if(args[1]==='read')return env({terminal:{handle,status:'running',source:'screen',tail:f.screen,...(f.draft!==undefined?{draft:f.draft}:{})}});
      if(args[1]==='send'){
        sends.push(args);
        if(f.send==='throw')throw Error('Orca CLI 응답 시간 초과 (30초)');
        return env({send:{handle,accepted:f.send!=='not-accepted',prompt:{requestId:args[args.indexOf('--retry-request')+1],stages:['input_accepted'],provider:'claude',observation:'supported',
          processIncarnation:f.send==='other-incarnation'?'inc-restarted':f.incarnation}}},f.send==='other-runtime'?'rt-2':f.runtime);
      }
      throw Error(`unexpected ${args.join(' ')}`);
    },
    verifyMemory:async()=>{calls.push(['verifyMemory']);if(f.memory.shift()===false)throw Error('저장할 새 활동이 있습니다.');},
    journal:()=>journal,
    lock:work=>work(),
  };
  const call=(operation:'context.orca.execute'|'context.orca.receipt'|'context.orca.acknowledge',providerSessionId:string,requestId:string,command:'compact'|'clear'='compact')=>
    performContextOrcaCommand(host,normalizeContextCommandRequest(operation==='context.orca.execute'?{operation,command,providerSessionId,requestId}:{operation,providerSessionId,requestId}) as never) as Promise<any>;
  return {f,call,host};
}

/** The dock client against the real host over a fake local fetch. `drop` loses one execute reply before the host saw the
 *  request or after it answered (a sidecar restart, the proxy's read timeout). */
function dockClient(host:ContextOrcaHost){
  const storage=new Map<string,string>(),realFetch=globalThis.fetch,realStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  const net={drop:null as null|'before'|'after'};
  Object.defineProperty(globalThis,'localStorage',{configurable:true,writable:true,value:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>void storage.set(k,String(v)),removeItem:(k:string)=>void storage.delete(k)}});
  globalThis.fetch=(async(_path:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body)),drop=body.operation==='context.orca.execute'?net.drop:null;
    if(drop)net.drop=null;
    if(drop==='before')throw TypeError('Load failed');
    let response:Response;
    try{response=Response.json(await performContextOrcaCommand(host,normalizeContextCommandRequest(body) as never));}
    catch(error){response=Response.json({error:error instanceof Error?error.message:String(error)},{status:400});}
    if(drop==='after')throw TypeError('Load failed');
    return response;
  }) as unknown as typeof fetch;
  cleanup.push(()=>{globalThis.fetch=realFetch;if(realStorage)Object.defineProperty(globalThis,'localStorage',realStorage);else delete (globalThis as {localStorage?:unknown}).localStorage;});
  return net;
}
const synced=async()=>({ok:true});

test('a saved, synced, idle Orca Claude receives the fixed command once, bound to its runtime, handle and incarnation',async()=>{
  const {f,call}=fixture(),id=crypto.randomUUID();
  expect(await call('context.orca.execute',S1,id)).toEqual({state:'written'});
  expect(f.sends).toEqual([['terminal','send','--terminal',handleOf(S1),'--text','/compact','--enter','--wait-submit','2','--retry-request',id]]);
  // The same request is answered from its receipt and never written twice.
  expect(await call('context.orca.execute',S1,id)).toEqual({state:'written'});
  expect(await call('context.orca.receipt',S1,id)).toEqual({state:'written',acknowledged:false});
  expect(f.sends).toHaveLength(1);
});

test('the empty-composer read is the last look before the write: no memory or network check sits between them',async()=>{
  const {f,call}=fixture();
  expect(await call('context.orca.execute',S1,crypto.randomUUID())).toEqual({state:'written'});
  expect(f.calls.map(c=>c[0]==='terminal'?c[1]:c[0])).toEqual(['verifyMemory','status','list','show','wait','verifyMemory','read','show','send']);
});

for(const mismatch of ['runtime','handle','incarnation'] as const)test(`a ${mismatch} that changed before the write is not sent`,async()=>{
  const {f,call}=fixture(),id=crypto.randomUUID();
  if(mismatch==='runtime')f.showRuntime='rt-2';if(mismatch==='handle')f.showHandle='term_elsewhere';if(mismatch==='incarnation')f.reshow.incarnation='inc-restarted';
  const outcome=await call('context.orca.execute',S1,id);
  expect(outcome.state).toBe('rejected');expect(f.sends).toEqual([]);
  // The refusal is durable: a lost reply resolves to "not sent".
  expect(await call('context.orca.receipt',S1,id)).toEqual({state:'rejected',acknowledged:false});
});

for(const busy of ['tui-busy','draft','composer-text','approval','turn-running'] as const)test(`Claude ${busy} is refused without a write`,async()=>{
  const {f,call}=fixture();
  if(busy==='tui-busy')f.idle=false;if(busy==='draft')f.draft='half a thought';
  if(busy==='composer-text')f.screen=['──────────','❯ unfinished','──────────'];
  if(busy==='approval')f.screen=['Do you want to proceed?','❯ 1. Yes','  2. No','──────────'];
  if(busy==='turn-running')f.screen=['✻ Moonwalking… (12s · esc to interrupt)','──────────','❯','──────────'];
  const id=crypto.randomUUID();
  expect((await call('context.orca.execute',S1,id)).state).toBe('rejected');
  expect(f.sends).toEqual([]);
  expect(await call('context.orca.receipt',S1,id)).toEqual({state:'rejected',acknowledged:false});
});

for(const memory of ['before','after-idle'] as const)test(`memory not saved and synced (${memory}) stops before the write`,async()=>{
  const {f,call}=fixture(),id=crypto.randomUUID();f.memory=memory==='before'?[false]:[true,false];
  const outcome=await call('context.orca.execute',S1,id);
  expect(outcome).toMatchObject({state:'rejected',error:'저장할 새 활동이 있습니다.'});expect(f.sends).toEqual([]);
  // The second check runs after Orca's idle wait and before the screen is read.
  expect(f.calls.some(c=>c[1]==='read')).toBe(false);
  expect(await call('context.orca.receipt',S1,id)).toEqual({state:'rejected',acknowledged:false});
});

for(const outcome of ['throw','other-runtime','other-incarnation'] as const)test(`an unproven send (${outcome}) is unknown, fenced and never resent`,async()=>{
  const {f,call}=fixture(),id=crypto.randomUUID();f.send=outcome;
  expect((await call('context.orca.execute',S1,id)).state).toBe('unknown');
  expect(await call('context.orca.receipt',S1,id)).toEqual({state:'unknown',acknowledged:false});
  f.send='accepted';
  expect((await call('context.orca.execute',S1,id)).state).toBe('unknown');
  const nextId=crypto.randomUUID(),next=await call('context.orca.execute',S1,nextId);
  expect(next.state).toBe('rejected');expect(next.error).toContain('미확정');
  expect(await call('context.orca.receipt',S1,nextId)).toEqual({state:'rejected',acknowledged:false});
  expect(f.sends).toHaveLength(1);
});

test('Orca refusing the input is a definite not-sent, not a fence',async()=>{
  const {f,call}=fixture();f.send='not-accepted';
  expect((await call('context.orca.execute',S1,crypto.randomUUID())).state).toBe('rejected');
  f.send='accepted';
  expect((await call('context.orca.execute',S1,crypto.randomUUID())).state).toBe('written');
});

test('a person acknowledging one receipt releases only that request; nothing releases a fence by itself',async()=>{
  const {f,call}=fixture(),a=crypto.randomUUID(),b=crypto.randomUUID();
  f.send='throw';
  expect((await call('context.orca.execute',S1,a)).state).toBe('unknown');
  expect((await call('context.orca.execute',S2,b)).state).toBe('unknown');
  // A request this host never recorded is acknowledged as a tombstone; it does not touch the unknown receipt.
  expect(await call('context.orca.acknowledge',S1,crypto.randomUUID())).toEqual({state:'not-found',acknowledged:true});
  expect(await call('context.orca.receipt',S1,a)).toEqual({state:'unknown',acknowledged:false});
  expect(await call('context.orca.acknowledge',S1,a)).toEqual({state:'unknown',acknowledged:true});
  // The outcome stays unknown; the receipt is never replayed.
  expect(await call('context.orca.receipt',S1,a)).toEqual({state:'unknown',acknowledged:true});
  expect((await call('context.orca.execute',S1,a)).state).toBe('unknown');
  f.send='accepted';
  expect((await call('context.orca.execute',S2,crypto.randomUUID())).state).toBe('rejected');
  const c=crypto.randomUUID();
  expect((await call('context.orca.execute',S1,c,'clear')).state).toBe('written');
  expect(f.sends.map(s=>s[5])).toEqual(['/compact','/compact','/clear']);
  // Acknowledging again changes nothing; a written receipt has nothing to release and stays unacknowledged.
  expect(await call('context.orca.acknowledge',S1,a)).toEqual({state:'unknown',acknowledged:true});
  expect(await call('context.orca.acknowledge',S1,c)).toEqual({state:'written',acknowledged:false});
  expect(await call('context.orca.receipt',S1,c)).toEqual({state:'written',acknowledged:false});
  expect(f.sends).toHaveLength(3);
});

test('acknowledging a request the host never recorded leaves a tombstone: its late arrival is refused, never sent',async()=>{
  const {f,call}=fixture(),id=crypto.randomUUID();
  expect(await call('context.orca.receipt',S1,id)).toEqual({state:'not-found'});
  expect(await call('context.orca.acknowledge',S1,id)).toEqual({state:'not-found',acknowledged:true});
  expect(await call('context.orca.receipt',S1,id)).toEqual({state:'rejected',acknowledged:true});
  const late=await call('context.orca.execute',S1,id,'clear');
  expect(late.state).toBe('rejected');expect(late.error).toContain('미확정 해제');
  expect(f.sends).toEqual([]);
  // The tombstone fences nothing else.
  expect(await call('context.orca.execute',S1,crypto.randomUUID())).toEqual({state:'written'});
});

test('dock: a refusal whose reply was lost resolves from its receipt and releases the fence without a resend',async()=>{
  const {f,host}=fixture(),net=dockClient(host);
  f.idle=false;net.drop='after';
  await expect(syncAndRunOrcaContextCommand(S1,'compact',synced,()=>{})).rejects.toThrow('Load failed');
  expect(contextCommandAttempts()).toEqual([]);
  expect(f.sends).toEqual([]);
});

test('dock: a request the host never saw stays fenced until a person acknowledges that one request',async()=>{
  const {f,host,call}=fixture(),net=dockClient(host);
  net.drop='before';
  await expect(syncAndRunOrcaContextCommand(S1,'compact',synced,()=>{})).rejects.toThrow('미확정');
  net.drop='before';
  await expect(syncAndRunOrcaContextCommand(S2,'clear',synced,()=>{})).rejects.toThrow('미확정');
  const [a,b]=contextCommandAttempts();
  expect([a?.providerSessionId,b?.providerSessionId]).toEqual([S1,S2]);
  // Reading the receipt never releases a request the host has no record of; the dock refuses another run meanwhile.
  expect(await checkContextCommand(a!)).toBe('not-found');
  expect(contextCommandAttempts()).toEqual([a!,b!]);
  await expect(syncAndRunOrcaContextCommand(S1,'compact',synced,()=>{})).rejects.toThrow('이전 컨텍스트 명령');
  // The person's acknowledgement releases only that request.
  expect(await acknowledgeContextCommand(a!)).toBe('not-found');
  expect(contextCommandAttempts()).toEqual([b!]);
  // The lost request arriving after all is answered from its tombstone and never sent.
  expect((await call('context.orca.execute',S1,a!.requestId)).state).toBe('rejected');
  expect(f.sends).toEqual([]);
  expect(await syncAndRunOrcaContextCommand(S1,'compact',synced,()=>{})).toContain('/compact');
  expect(f.sends.map(s=>s[5])).toEqual(['/compact']);
  expect(contextCommandAttempts()).toEqual([b!]);
});

test('wire requests cannot name a handle, text or a non-UUID retry identity',()=>{
  const id=crypto.randomUUID();
  expect(()=>normalizeContextCommandRequest({operation:'context.orca.execute',command:'compact',providerSessionId:S1,requestId:id,terminal:'term_x'})).toThrow();
  expect(()=>normalizeContextCommandRequest({operation:'context.orca.execute',command:'clear; rm',providerSessionId:S1,requestId:id})).toThrow();
  expect(()=>normalizeContextCommandRequest({operation:'context.orca.execute',command:'compact',providerSessionId:S1,requestId:'not-a-uuid-1234'})).toThrow();
  expect(()=>normalizeContextCommandRequest({operation:'context.orca.acknowledge',providerSessionId:'../x',requestId:id})).toThrow();
  expect(normalizeContextCommandRequest({operation:'context.orca.receipt',providerSessionId:S1,requestId:id}).operation).toBe('context.orca.receipt');
});

test('the composer reader accepts only an empty prompt between the two rules',()=>{
  expect(claudeOrcaComposerEmpty(IDLE)).toBe(true);
  expect(claudeOrcaComposerEmpty(['──────────','> ','──────────'])).toBe(true);
  expect(claudeOrcaComposerEmpty(['❯'])).toBe(false);
  expect(claudeOrcaComposerEmpty(['──────────','❯ /compact','──────────'])).toBe(false);
});
