import {test,expect} from 'bun:test';
import {createTeamOrcaRecoveryRead,createTeamOrcaRecoveryInspect} from '../src/teamOrcaRecoveryRead';
import type {TeamExternalRef} from '../src/teamExternalRuntime';

const ref:TeamExternalRef={executionId:'team:m1',hostInstanceId:'old-host',teamId:'team',memberId:'m1',targetId:'owned',cwd:'/repo/member',generation:1,agent:'claude',surface:'orca-worktree',native:{kind:'orca',hostInstanceId:'old-host',terminalHandle:'old-handle',worktreeId:'old-tree',runtimeInstanceId:JSON.stringify(['orca-runtime','process-one']),cwd:'/repo/member',agent:'claude',owned:true}};
function fixture(){
  let current=true,incarnation='process-one',cwd='/repo/member',shows=0,changedAfterRead=false;
  const calls:string[][]=[];
  const read=createTeamOrcaRecoveryRead({resolveOrcaCli:()=>'/orca',bindingStillMatches:()=>current,runOrca:async(_cli,args)=>{
    calls.push([...args]);
    if(args[1]==='show'){shows++;return {ok:true,_meta:{runtimeId:'orca-runtime'},result:{terminal:{handle:'old-handle',worktreeId:'old-tree',worktreePath:cwd,executionHostId:'local',agentIdentity:'claude',connected:true,incarnationId:incarnation}}};}
    if(changedAfterRead)incarnation='new-process';
    return {ok:true,_meta:{runtimeId:'orca-runtime'},result:{terminal:{handle:'old-handle',tail:['own member output'],nextCursor:'42'}}};
  }});
  return {read,calls,get shows(){return shows;},changeBinding(){current=false;},changeCwd(){cwd='/other';},changeAfterRead(){changedAfterRead=true;}};
}
test('reads only the recorded Orca terminal and verifies incarnation and worktree on both sides',async()=>{
  const f=fixture();expect(await f.read(ref,{limit:100})).toEqual({text:'own member output',cursor:'42'});
  expect(f.shows).toBe(2);expect(f.calls.map(c=>c.slice(0,2))).toEqual([['terminal','show'],['terminal','read'],['terminal','show']]);
  expect(f.calls.every(c=>c.includes('old-handle'))).toBe(true);
});
test('rejects replacement, worktree changes, team changes, and borrowed windows without returning output',async()=>{
  const swapped=fixture();swapped.changeAfterRead();expect(await swapped.read(ref,{})).toBeNull();
  const cwd=fixture();cwd.changeCwd();expect(await cwd.read(ref,{})).toBeNull();expect(cwd.calls).toHaveLength(1);
  const binding=fixture();binding.changeBinding();expect(await binding.read(ref,{})).toBeNull();expect(binding.calls).toHaveLength(0);
  const borrowed=structuredClone(ref);borrowed.native!.owned=false;
  const f=fixture();expect(await f.read(borrowed,{})).toBeNull();expect(f.calls).toHaveLength(0);
});

// A scripted Orca for the edge cases: each answer can be bent one field at a time.
function scripted(over:{show?:Record<string,unknown>;showRuntime?:string;read?:Record<string,unknown>;readRuntime?:string;readOk?:boolean;cli?:string|null;binding?:()=>boolean}={}){
  const calls:string[][]=[];
  const read=createTeamOrcaRecoveryRead({resolveOrcaCli:()=>over.cli===undefined?'/orca':over.cli,bindingStillMatches:over.binding??(()=>true),runOrca:async(_cli,args,options)=>{
    calls.push([...args]);
    expect(options).toEqual({cwd:'/',timeoutMs:15_000,attempts:1});expect(args.at(-1)).toBe('--json');
    if(args[1]==='show')return {ok:true,_meta:{runtimeId:over.showRuntime??'orca-runtime'},result:{terminal:{handle:'old-handle',worktreeId:'old-tree',worktreePath:'/repo/member',
      executionHostId:'local',agentIdentity:'claude',connected:true,incarnationId:'process-one',...over.show}}};
    if(args[1]==='read')return {ok:over.readOk??true,_meta:{runtimeId:over.readRuntime??'orca-runtime'},result:{terminal:{handle:'old-handle',tail:['own member output'],nextCursor:'42',...over.read}}};
    throw Error(`recovery must never run orca ${args.slice(0,2).join(' ')}`);
  }});
  return {read,calls};
}
test('a terminal on another host, of another agent or worktree, disconnected or of another process is never read',async()=>{
  for(const show of [{executionHostId:'ssh:build-box'},{agentIdentity:'codex'},{agentIdentity:null},{worktreeId:'other-tree'},{worktreePath:'/repo/other'},
    {handle:'other-handle'},{connected:false},{incarnationId:'process-two'}]){
    const f=scripted({show});
    expect(await f.read(ref,{})).toBeNull();
    expect(f.calls.map(c=>c[1])).toEqual(['show']);
  }
});
test('an Orca runtime that restarted before or during the read returns nothing',async()=>{
  const before=scripted({showRuntime:'orca-runtime-2'});
  expect(await before.read(ref,{})).toBeNull();expect(before.calls.map(c=>c[1])).toEqual(['show']);
  const during=scripted({readRuntime:'orca-runtime-2'});
  expect(await during.read(ref,{})).toBeNull();expect(during.calls.map(c=>c[1])).toEqual(['show','read']);
});
test('a team binding that changes between the two checks, or while the CLI is resolved, discards the output',async()=>{
  let reads=0;
  const between=createTeamOrcaRecoveryRead({resolveOrcaCli:()=>'/orca',bindingStillMatches:()=>reads===0,runOrca:async(_cli,args)=>{
    if(args[1]==='read')reads++;
    return args[1]==='show'
      ?{ok:true,_meta:{runtimeId:'orca-runtime'},result:{terminal:{handle:'old-handle',worktreeId:'old-tree',worktreePath:'/repo/member',executionHostId:'local',agentIdentity:'claude',connected:true,incarnationId:'process-one'}}}
      :{ok:true,_meta:{runtimeId:'orca-runtime'},result:{terminal:{handle:'old-handle',tail:['own member output'],nextCursor:'42'}}};
  }});
  expect(await between(ref,{})).toBeNull();expect(reads).toBe(1);
  let asked=0;
  const resolving=scripted({binding:()=>++asked===1});
  expect(await resolving.read(ref,{})).toBeNull();expect(resolving.calls).toHaveLength(0);
});
test('a record that is not an owned Orca worktree terminal of this member, or no Orca CLI, makes no call',async()=>{
  const variants:TeamExternalRef[]=[{...ref,surface:'orca-floating'},{...ref,cwd:'/repo/elsewhere'},{...ref,agent:'codex'},
    {...ref,native:{...ref.native!,kind:'manual'} as unknown as TeamExternalRef['native']},{...ref,native:null}];
  for(const variant of variants){const f=scripted();expect(await f.read(variant,{})).toBeNull();expect(f.calls).toHaveLength(0);}
  const noCli=scripted({cli:null});expect(await noCli.read(ref,{})).toBeNull();expect(noCli.calls).toHaveLength(0);
});
test('a refused or malformed read answer returns nothing; limits and the cursor are bounded and passed through',async()=>{
  for(const over of [{readOk:false},{read:{tail:[1,2]}},{read:{tail:'text'}},{read:{handle:'other-handle'}}]){
    const f=scripted(over);expect(await f.read(ref,{})).toBeNull();
  }
  const big=scripted();
  expect(await big.read(ref,{limit:100_000,cursor:'7'})).toEqual({text:'own member output',cursor:'42'});
  expect(big.calls[1]).toEqual(['terminal','read','--terminal','old-handle','--cursor','7','--limit','1000','--json']);
  const small=scripted();
  expect(await small.read(ref,{limit:10})).toEqual({text:'ber output',cursor:'42'});
  expect(small.calls[1]).toContain('10');
  const nan=scripted();
  await nan.read(ref,{limit:Number.NaN});expect(nan.calls[1]!.slice(-2)).toEqual(['1000','--json']);
  const noCursor=scripted({read:{nextCursor:42}});
  expect(await noCursor.read(ref,{})).toEqual({text:'own member output'});
});


test('diagnostics identify the actual failed boundary without returning terminal text or rebinding',async()=>{
  const native=ref.native!;
  for(const [change,reason] of [
    [{incarnationId:'replaced'},'EXTERNAL_RECOVERY_NATIVE_CHANGED'],
    [{worktreePath:'/other'},'EXTERNAL_RECOVERY_CWD_CHANGED'],
    [{agentIdentity:null},'EXTERNAL_RECOVERY_AGENT_UNVERIFIED'],
    [{connected:false},'EXTERNAL_RECOVERY_DISCONNECTED'],
  ] as const){
    const calls:string[][]=[];
    const inspect=createTeamOrcaRecoveryInspect({resolveOrcaCli:()=>'/orca',bindingStillMatches:()=>true,runOrca:async(_,args)=>{
      calls.push([...args]);return {ok:true,_meta:{runtimeId:'orca-runtime'},result:{terminal:Object.assign({handle:'old-handle',worktreeId:'old-tree',worktreePath:ref.cwd,
        executionHostId:'local',agentIdentity:'claude',connected:true,incarnationId:'process-one',preview:'private output'},change)}};
    }});
    expect(await inspect(ref,{})).toEqual({outcome:'unconfirmed',reason});
    expect(calls.map(v=>v[1])).toEqual(['show']);
    expect(await inspect({...ref,native:{...native,hostInstanceId:'foreign'}},{})).toEqual({outcome:'unconfirmed',reason:'EXTERNAL_RECOVERY_SCOPE_UNVERIFIED'});
  }
});
test('recovery transport rejection is contained and malformed native generation is never queried',async()=>{
  let calls=0;
  const inspect=createTeamOrcaRecoveryInspect({resolveOrcaCli:async()=>{calls++;throw Error('private transport detail');},bindingStillMatches:()=>true,runOrca:async()=>{throw Error('must not call');}});
  expect(await inspect(ref,{})).toEqual({outcome:'unconfirmed',reason:'EXTERNAL_RECOVERY_TRANSPORT_UNAVAILABLE'});
  for(const generation of ['invalid','["only-one"]','[1,2]']){
    expect(await inspect({...ref,native:{...ref.native!,runtimeInstanceId:generation}},{})).toEqual({outcome:'unconfirmed',reason:'EXTERNAL_RECOVERY_SCOPE_UNVERIFIED'});
  }
  expect(calls).toBe(1);
});
