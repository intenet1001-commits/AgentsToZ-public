import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,symlinkSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkroomScheduleStore} from '../src/workroomScheduleStore';
import {WorkroomScheduleHost,type ScheduleSnapshot,type WorkroomScheduleAdapter} from '../src/workroomScheduleHost';
import {parseWorkroomScheduleRequest,type WorkroomSchedule} from '../src/workroomScheduleProtocol';
import {handleWorkroomSchedules} from '../src/workroomScheduleApi';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const fn of cleanup.splice(0))fn();});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'workroom-schedules-'));chmodSync(root,0o700);cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  let key:Buffer|null=null,now=1_800_000_000_000,enabled=true;
  const keys={read:async()=>key?Buffer.from(key):null,create:async()=>Buffer.from(key=Buffer.alloc(32,17))};
  const store=new WorkroomScheduleStore(root,keys);cleanup.push(()=>store.dispose());
  let snapshot:ScheduleSnapshot={binding:{sessionId:'session_original',targetId:'target_original',agent:'codex',model:'gpt-test',accountId:'host-default',identity:'a'.repeat(64),bypass:false},inputRevision:2,outputCursor:3,ready:true,canStartNew:true,reason:'입력 대기'};
  const writes:string[]=[],gates:boolean[]=[];let fail=false,finish:'submitted'|'completed'|'unknown'|'failed'='submitted',during:(()=>Promise<void>)|undefined;
  const adapter:WorkroomScheduleAdapter={inspect:async()=>structuredClone(snapshot),captureRestore:async()=>({commit(){},cancel(){}}),dispatch:async(s,r,_snapshot,active)=>{if(during)await during();gates.push(active());if(!active())throw Error('revoked');writes.push(s.prompt);if(fail)throw Error('lost ACK');return {state:'submitted',sessionId:r.sessionId,inputRevision:3};},reconcile:async()=>finish};
  const options={enabled:()=>enabled,now:()=>now},host=new WorkroomScheduleHost(store,adapter,options);
  const create=async(extra:Record<string,unknown>={})=>{const response=await host.manage({operation:'create',id:crypto.randomUUID(),sessionId:snapshot.binding.sessionId,title:'정기 검사',prompt:'이 프로젝트의 상태를 확인하고 보고해 줘.',mode:'continue',nextAt:now,intervalMs:300000,expiresAt:now+86400_000,maxRuns:20,consent:true,...extra});return (response as {schedule:WorkroomSchedule}).schedule;};
  return {root,store,host,adapter,options,keys,writes,gates,create,time:(ms:number)=>{now+=ms;},now:()=>now,enabled:(v:boolean)=>{enabled=v;},change:(v:Partial<ScheduleSnapshot>)=>{snapshot={...snapshot,...v};},fail:()=>{fail=true;},finish:(v:typeof finish)=>{finish=v;},during:(v:typeof during)=>{during=v;}};
}
test('explicit consent, closed operation set, bounded cadence and fixed lifetime are required',()=>{
  const now=1_800_000_000_000,body={operation:'create',id:'schedule_one',sessionId:'session_original',title:'이름',prompt:'상태 확인',mode:'continue',nextAt:now,intervalMs:300000,expiresAt:now+86400000,maxRuns:20,consent:true} as const;
  expect(parseWorkroomScheduleRequest(body,now)).toEqual(body);
  for(const extra of [{consent:false},{intervalMs:1000},{expiresAt:now+31*86400000},{maxRuns:0},{prompt:'/approve all'},{command:'shell'},{nextAt:NaN},{mode:'infer-agent'}])expect(()=>parseWorkroomScheduleRequest({...body,...extra},now)).toThrow();
});
test('read-only management does not initialize keys or the schedule database',async()=>{
  const f=fixture();const view=await f.host.manage({operation:'list',sessionId:'session_original'});
  expect(view).toMatchObject({success:true,schedules:[],runs:[]});expect(()=>readFileSync(f.store.file)).toThrow();
});
test('due dispatch is encrypted, coalesced after sleep, and reported submitted until actual completion',async()=>{
  const f=fixture(),s=await f.create();expect(readFileSync(f.store.file).includes(Buffer.from(s.prompt))).toBe(false);
  f.time(5*3600000);await f.host.tick();expect(f.writes).toEqual([s.prompt]);
  expect((await f.store.runs(s.id))[0]?.state).toBe('submitted');expect((await f.store.get(s.id))?.nextAt).toBe(f.now()+300000);
  await f.host.tick();expect(f.writes).toHaveLength(1);f.finish('completed');await f.host.tick();expect((await f.store.runs(s.id))[0]?.state).toBe('completed');
});
test('busy composer, approval and changed binding defer without claiming or writing',async()=>{
  const f=fixture(),s=await f.create();f.change({ready:false,reason:'승인 대기'});await f.host.tick();expect(f.writes).toHaveLength(0);expect(await f.store.runs()).toEqual([]);expect((await f.store.get(s.id))?.reason).toContain('승인');
  f.time(60001);f.change({ready:true,binding:{sessionId:'session_original',targetId:'target_original',agent:'codex',model:'changed',accountId:'host-default',identity:'b'.repeat(64),bypass:false}});await f.host.tick();expect((await f.store.get(s.id))?.state).toBe('needs-human');expect(f.writes).toHaveLength(0);
});
test('two independent hosts and manual/timer race share one durable claim',async()=>{
  const f=fixture(),s=await f.create(),otherStore=new WorkroomScheduleStore(f.root,f.keys),other=new WorkroomScheduleHost(otherStore,f.adapter,f.options);cleanup.push(()=>other.dispose());
  await Promise.all([f.host.tick(),other.manage({operation:'run-now',id:s.id,expectedRevision:s.revision,requestId:'manual_run_01'})]);
  expect(f.writes).toHaveLength(1);expect((await f.store.runs()).filter(r=>r.state==='submitted')).toHaveLength(1);
});
test('only the owner observes a live submitted PTY; a missing owner becomes unknown after its lease expires',async()=>{
  const f=fixture(),s=await f.create(),otherStore=new WorkroomScheduleStore(f.root,f.keys);let foreignReads=0;
  const other=new WorkroomScheduleHost(otherStore,{...f.adapter,reconcile:async()=>{foreignReads++;return 'unknown';}},f.options);cleanup.push(()=>other.dispose());
  await f.host.tick();expect((await f.store.runs(s.id))[0]?.state).toBe('submitted');
  f.time(30000);await other.tick();expect(foreignReads).toBe(0);expect((await f.store.runs(s.id))[0]?.state).toBe('submitted');
  await f.host.tick();f.time(30001);await other.tick();expect(foreignReads).toBe(0);expect((await f.store.runs(s.id))[0]?.state).toBe('submitted');
  f.host.dispose();f.time(60001);await other.tick();expect(foreignReads).toBe(0);expect((await otherStore.runs(s.id))[0]?.state).toBe('unknown');
  expect((await otherStore.get(s.id))?.state).toBe('needs-human');expect(f.writes).toHaveLength(1);
});
test('legacy submitted runs wait for their grace period and are then preserved as unknown',async()=>{
  const f=fixture(),s=await f.create(),claim=(await f.store.claim(s,f.now()))!;await f.store.settle(claim.run.id,'submitted','legacy',f.now());
  await f.host.tick();expect((await f.store.runs())[0]?.state).toBe('submitted');
  f.time(60001);await f.host.tick();expect((await f.store.runs())[0]?.state).toBe('unknown');expect((await f.store.get(s.id))?.state).toBe('needs-human');expect(f.writes).toHaveLength(0);
});
test('a separate Bun process cannot observe another live owner, and recovers an expired owner conservatively',async()=>{
  const f=fixture(),s=await f.create();await f.host.tick();
  const script=`import {WorkroomScheduleStore} from ${JSON.stringify(join(import.meta.dir,'../src/workroomScheduleStore.ts'))};import {WorkroomScheduleHost} from ${JSON.stringify(join(import.meta.dir,'../src/workroomScheduleHost.ts'))};const now=Number(process.argv[3]),store=new WorkroomScheduleStore(process.argv[1],{read:async()=>Buffer.alloc(32,17),create:async()=>{throw Error('not allowed')}});let observed=0;const host=new WorkroomScheduleHost(store,{inspect:async()=>{throw Error('no local session')},dispatch:async()=>{throw Error('not allowed')},reconcile:async()=>{observed++;return 'unknown'}},{enabled:()=>true,now:()=>now});await host.tick();console.log(JSON.stringify({state:(await store.runs(process.argv[2]))[0].state,observed}));host.dispose();`;
  const run=async(now:number)=>{const child=Bun.spawn([process.execPath,'-e',script,f.root,s.id,String(now)],{stdout:'pipe',stderr:'pipe'});const exit=await child.exited,text=await new Response(child.stdout).text(),stderr=await new Response(child.stderr).text();expect({exit,stderr}).toEqual({exit:0,stderr:''});return JSON.parse(text);};
  expect(await run(f.now()+30000)).toEqual({state:'submitted',observed:0});
  expect(await run(f.now()+60001)).toEqual({state:'unknown',observed:0});expect((await f.store.get(s.id))?.state).toBe('needs-human');expect(f.writes).toHaveLength(1);
});
test('two schedules for one conversation share a lease while another conversation is not starved',async()=>{
  const f=fixture();await f.create();const second=await f.create({id:'schedule_second'});await f.host.tick();await f.host.tick();expect(f.writes).toHaveLength(1);expect((await f.store.get(second.id))?.retryAt).toBeGreaterThan(f.now());
});
test('pause then resume during dispatch invalidates the original consent generation',async()=>{
  const f=fixture(),s=await f.create();f.during(async()=>{
    const current=(await f.store.get(s.id))!;await f.host.manage({operation:'pause',id:s.id,expectedRevision:current.revision});
    const paused=(await f.store.get(s.id))!;await f.host.manage({operation:'resume',id:s.id,expectedRevision:paused.revision,consent:true});
  });
  await f.host.tick();expect(f.gates).toEqual([false]);expect(f.writes).toHaveLength(0);expect((await f.store.runs())[0]?.state).toBe('unknown');
});
test('lost ACK blocks new IDs and requires review plus separate re-enable; no automatic replay',async()=>{
  const f=fixture(),s=await f.create();f.fail();await f.host.tick();const run=(await f.store.runs())[0]!;
  expect(run.state).toBe('unknown');expect((await f.store.get(s.id))?.state).toBe('needs-human');
  const restarted=new WorkroomScheduleHost(new WorkroomScheduleStore(f.root,f.keys),f.adapter,f.options);cleanup.push(()=>restarted.dispose());
  f.time(3600000);await restarted.tick();expect(f.writes).toHaveLength(1);
  await restarted.manage({operation:'review',runId:run.id,confirmed:true});await restarted.tick();expect(f.writes).toHaveLength(1);expect((await f.store.get(s.id))?.state).toBe('needs-human');
});
test('original Run now ID reads its old result even after the schedule revision changed',async()=>{
  const f=fixture(),s=await f.create();const request={operation:'run-now',id:s.id,expectedRevision:s.revision,requestId:'manual_repeat_1'};
  await f.host.manage(request);await f.host.manage(request);expect(f.writes).toHaveLength(1);
});
test('a lost creation reply reads the original schedule after its initial time passed and never enables it again',async()=>{
  const f=fixture(),body={operation:'create',id:'creation_repeat_01',sessionId:'session_original',title:'확인',prompt:'현재 상태 확인',mode:'continue',nextAt:f.now(),intervalMs:300000,expiresAt:f.now()+86400000,maxRuns:3,consent:true};
  await f.host.manage(body);await f.host.manage({operation:'pause',id:body.id,expectedRevision:1});f.time(3600000);
  expect(await f.host.manage({...body})).toMatchObject({schedule:{id:body.id,state:'paused',revision:2}});expect(f.writes).toHaveLength(0);
  await expect(f.host.manage({...body,prompt:'바꾼 작업'})).rejects.toThrow('같은 예약');
});
test('separate Bun host processes cannot both claim the same due occurrence',async()=>{
  const f=fixture(),s=await f.create();
  const script=`import {WorkroomScheduleStore} from ${JSON.stringify(join(import.meta.dir,'../src/workroomScheduleStore.ts'))};const s=new WorkroomScheduleStore(process.argv[1],{read:async()=>Buffer.alloc(32,17),create:async()=>{throw Error('not allowed')}});const row=await s.get(process.argv[2]);const result=await s.claim(row,Number(process.argv[3]));console.log(result?.claimed===true?'claimed':'not-claimed');s.dispose();`;
  const children=[0,1].map(()=>Bun.spawn([process.execPath,'-e',script,f.root,s.id,String(f.now())],{stdout:'pipe',stderr:'pipe'}));
  const replies=await Promise.all(children.map(async p=>({exit:await p.exited,text:await new Response(p.stdout).text(),stderr:await new Response(p.stderr).text()})));
  expect(replies.map(r=>({exit:r.exit,stderr:r.stderr}))).toEqual([{exit:0,stderr:''},{exit:0,stderr:''}]);expect(replies.filter(r=>r.text.trim()==='claimed')).toHaveLength(1);expect(await f.store.runs(s.id)).toHaveLength(1);
});
test('expiry, maximum count, rolling budget and a disabled host never dispatch beyond consent',async()=>{
  const f=fixture(),s=await f.create({maxRuns:1});await f.host.tick();f.finish('completed');f.time(3600000);await f.host.tick();expect(f.writes).toHaveLength(1);expect((await f.store.get(s.id))?.state).toBe('finished');
  const g=fixture();await g.create();g.time(2*86400000);await g.host.tick();expect(g.writes).toHaveLength(0);
  const h=fixture();await h.create();h.enabled(false);await h.host.tick();expect(h.writes).toHaveLength(0);
  const rolling=fixture(),limited=await rolling.create();rolling.finish('completed');
  for(let n=0;n<9;n++){await rolling.host.tick();rolling.time(300001);}
  expect(rolling.writes).toHaveLength(8);expect((await rolling.store.get(limited.id))?.state).toBe('needs-human');
});
test('admission before dispatch survives an owner crash and becomes unknown without a new write',async()=>{
  const f=fixture(),s=await f.create();await f.store.claim(s,f.now());f.time(60001);f.finish('unknown');await f.host.tick();
  expect((await f.store.runs())[0]?.state).toBe('unknown');expect(f.writes).toHaveLength(0);expect((await f.store.get(s.id))?.state).toBe('needs-human');
});
test('a completed conversation is restored only after its durable claim and remains bound to the original lease',async()=>{
  const f=fixture();let restored=false,restoreCount=0;
  f.change({canRestore:true});const original=await f.adapter.inspect('session_original');
  f.adapter.inspectBound=async(_schedule,id)=>id==='session_restored'&&restored?{...original,binding:{...original.binding,sessionId:id}}:null;
  f.adapter.inspectRestore=async()=>({proof:'verified-original-conversation'});
  f.adapter.restore=async(_schedule,run,proof,active)=>{
    expect(proof.proof).toBe('verified-original-conversation');expect(active()).toBe(true);
    expect((await f.store.runs())[0]?.id).toBe(run.id);restoreCount++;restored=true;
    return {...original,binding:{...original.binding,sessionId:'session_restored'}};
  };
  const s=await f.create({autoRestore:true});
  await f.host.tick();
  expect(restoreCount).toBe(1);expect(f.writes).toHaveLength(1);
  expect((await f.store.get(s.id))?.currentSessionId).toBe('session_restored');
  const run=(await f.store.runs())[0]!;expect(run.leaseKey).toBe(Bun.CryptoHasher.hash('sha256',s.binding.sessionId,'hex'));
  f.finish('completed');f.time(300001);await f.host.tick();expect(f.writes).toHaveLength(2);expect(restoreCount).toBe(1);
});
test('missing proof or changed resumed identity never restores or submits',async()=>{
  const f=fixture();let restores=0;f.change({canRestore:true});
  f.adapter.inspectBound=async()=>null;f.adapter.inspectRestore=async()=>null;
  f.adapter.restore=async()=>{restores++;throw Error('unexpected');};
  const s=await f.create({autoRestore:true});
  await f.host.tick();expect(restores).toBe(0);expect(await f.store.runs()).toEqual([]);expect((await f.store.get(s.id))?.state).toBe('needs-human');
  const g=fixture();g.change({canRestore:true});const original=await g.adapter.inspect('session_original');
  g.adapter.inspectBound=async()=>null;g.adapter.inspectRestore=async()=>({proof:'verified'});
  g.adapter.restore=async()=>({...original,binding:{...original.binding,sessionId:'session_restored',model:'other-model'}});
  await g.create({autoRestore:true});
  await g.host.tick();expect(g.writes).toHaveLength(0);expect((await g.store.runs())[0]?.state).toBe('unknown');
});
test('unsafe existing resumed session cannot trigger another restore, and revoked consent prevents input',async()=>{
  const f=fixture();let restores=0;f.change({canRestore:true});
  f.adapter.inspectBound=async()=>{throw Error('사람이 입력했습니다.');};f.adapter.inspectRestore=async()=>({proof:'verified'});
  f.adapter.restore=async()=>{restores++;throw Error('unexpected');};
  const s=await f.create({autoRestore:true});
  await f.host.tick();expect(restores).toBe(0);expect(f.writes).toHaveLength(0);expect((await f.store.get(s.id))?.state).toBe('needs-human');
  const g=fixture();g.change({canRestore:true});const original=await g.adapter.inspect('session_original');
  g.adapter.inspectBound=async()=>null;g.adapter.inspectRestore=async()=>({proof:'verified'});
  let other:WorkroomSchedule;g.adapter.restore=async()=>{const current=(await g.store.get(other.id))!;await g.host.manage({operation:'pause',id:other.id,expectedRevision:current.revision});return {...original,binding:{...original.binding,sessionId:'session_restored'}};};
  other=await g.create({autoRestore:true});
  await g.host.tick();expect(g.writes).toHaveLength(0);expect((await g.store.runs())[0]?.state).toBe('unknown');expect((await g.store.get(other.id))?.currentSessionId).toBeUndefined();
});
test('unknown restoration after host restart never invokes restore again',async()=>{
  const f=fixture();let restores=0;f.change({canRestore:true});
  f.adapter.inspectBound=async()=>null;f.adapter.inspectRestore=async()=>({proof:'verified'});
  f.adapter.restore=async()=>{restores++;throw Error('restore result unavailable');};
  const s=await f.create({autoRestore:true});
  await f.host.tick();expect(restores).toBe(1);expect((await f.store.runs())[0]?.state).toBe('unknown');
  const restarted=new WorkroomScheduleHost(new WorkroomScheduleStore(f.root,f.keys),f.adapter,f.options);cleanup.push(()=>restarted.dispose());
  f.time(3600000);await restarted.tick();expect(restores).toBe(1);expect(f.writes).toHaveLength(0);expect((await f.store.get(s.id))?.state).toBe('needs-human');
});
test('two hosts racing the same missing terminal perform one restoration and one input',async()=>{
  const f=fixture();f.change({canRestore:true});const original=await f.adapter.inspect('session_original');let restores=0;
  f.adapter.inspectBound=async()=>null;f.adapter.inspectRestore=async()=>({proof:'verified'});
  f.adapter.restore=async()=>{restores++;await Promise.resolve();return {...original,binding:{...original.binding,sessionId:'session_restored'}};};
  const s=await f.create({autoRestore:true});const other=new WorkroomScheduleHost(new WorkroomScheduleStore(f.root,f.keys),f.adapter,f.options);cleanup.push(()=>other.dispose());
  await Promise.all([f.host.tick(),other.tick()]);expect(restores).toBe(1);expect(f.writes).toHaveLength(1);expect((await f.store.runs(s.id))).toHaveLength(1);
});
test('auto restore requires separate consent and creation-time completed-conversation proof',async()=>{
  const f=fixture();let restores=0;f.adapter.inspectBound=async()=>null;f.adapter.inspectRestore=async()=>({proof:'verified'});
  f.adapter.restore=async()=>{restores++;throw Error('unexpected');};
  await expect(f.create({autoRestore:true})).rejects.toThrow('증명하지 못해');
  const legacy=await f.create();await f.host.tick();expect(restores).toBe(0);expect((await f.store.get(legacy.id))?.state).toBe('needs-human');
  f.change({canRestore:true,ready:false});await expect(f.create({autoRestore:true})).rejects.toThrow('증명하지 못해');
  f.change({ready:true});await expect(f.create({autoRestore:true,mode:'new-conversation'})).rejects.toThrow('동의');
});
test('private route checks capability before body parsing and rejects arbitrary fields and query routes',async()=>{
  const f=fixture(),req=(url:string,body:unknown)=>new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  expect((await handleWorkroomSchedules(req('http://localhost/api/agent-runtime/workroom-schedules',{}),f.host,false)).status).toBe(403);
  expect((await handleWorkroomSchedules(req('http://localhost/api/agent-runtime/workroom-schedules?x=1',{operation:'list',sessionId:'session_original'}),f.host,true)).status).toBe(400);
  expect((await handleWorkroomSchedules(req('http://localhost/api/agent-runtime/workroom-schedules',{operation:'list',sessionId:'session_original',shell:'x'}),f.host,true)).status).toBe(400);
  expect(f.writes).toHaveLength(0);
});
test('symlinked stores fail closed without touching their destination',async()=>{
  const f=fixture(),target=join(f.root,'untouched');await Bun.write(target,'keep');symlinkSync(target,f.store.file);
  await expect(f.store.list()).rejects.toThrow('접근 권한');expect(readFileSync(target,'utf8')).toBe('keep');
});
