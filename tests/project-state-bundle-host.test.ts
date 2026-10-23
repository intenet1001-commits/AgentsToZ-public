import {expect,test} from 'bun:test';
import {ProjectStateBundleHost,type ProjectStateClock} from '../src/projectStateBundleHost';
import {type TargetBinding,type SectionId,type ReadSourceAdapter,type SourceObservation} from '../src/projectStateBundle';

function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
class Clock implements ProjectStateClock{
  value=1000;next=0;timers=new Map<number,{at:number,fn:()=>void}>();
  now=()=>this.value;
  setTimeout=(fn:()=>void,ms:number)=>{const id=++this.next;this.timers.set(id,{at:this.value+ms,fn});return id;};
  clearTimeout=(id:unknown)=>{this.timers.delete(id as number);};
  async advance(ms:number){this.value+=ms;for(const [id,t] of [...this.timers])if(t.at<=this.value){this.timers.delete(id);t.fn();}await flush();}
}
async function flush(){for(let i=0;i<30;i++)await Promise.resolve();}
const observation=(id:SectionId):SourceObservation=>({id,availability:'ready',freshness:'current',observedAt:1000,sourceRevision:'v1',summary:[`${id} summary`],limits:[]});
function fixture(){
  const clock=new Clock();let proof='original',authority=true;let calls:SectionId[]=[];
  const binding=(targetId:string,owner:string):TargetBinding=>({targetId,projectId:targetId,role:'dev',owner,proof,rootPath:'/never-public'});
  const reader=(id:SectionId):ReadSourceAdapter=>({async read(_binding,input){calls.push(input.id);return observation(id);}});
  const readers:Record<SectionId,ReadSourceAdapter>={git:reader('git'),workroom:reader('workroom'),tester:reader('tester'),memory:reader('memory')};
  const host=new ProjectStateBundleHost({clock,uuid:(()=>{let id=0;return ()=>`bundle-${++id}`;})(),resolve:async(owner,targetId)=>{if(!authority)throw Error('/private/secret revoked token=hidden');return binding(targetId,owner);},readers});
  return {host,clock,readers,calls,setProof:(v:string)=>{proof=v;},revoke:()=>{authority=false;}};
}
test('T02 binding_branch_head_change_blocks_send',async()=>{
  const f=fixture(),bundle=await f.host.preview('owner',{targetId:'target'});const selected={targetId:'target',bundleId:bundle.id,sections:['git'] as SectionId[]};
  const prepared=await f.host.prepare('owner',selected);f.setProof('branch-and-head-changed');let sends=0;
  await expect(f.host.withPrepared('owner',{...selected,selectionHash:prepared.selectionHash},async()=>{sends++;})).rejects.toThrow();expect(sends).toBe(0);
  const g=fixture();g.readers.git={async read(){g.setProof('changed-during-collection');return observation('git');}};
  expect((await g.host.preview('owner',{targetId:'target'})).state).toBe('invalidated');
});
test('T04 binding_grant_revoked_blocks_all_send',async()=>{
  const f=fixture();f.readers.git={async read(){f.revoke();return observation('git');}};
  const b=await f.host.preview('owner',{targetId:'target'});expect(b.state).toBe('invalidated');
  await expect(f.host.prepare('owner',{targetId:'target',bundleId:b.id,sections:['git']})).rejects.toThrow();
  expect(JSON.stringify(b)).not.toContain('/private/secret');expect(JSON.stringify(b)).not.toContain('/never-public');
  expect(f.calls).not.toContain('tester');
});
test('T05 preview_readers_no_domain_mutation',async()=>{
  const f=fixture();await f.host.preview('owner',{targetId:'target'});expect(f.calls).toEqual(['git','workroom','tester']);
  let query='';f.readers.memory={async read(_b,input){query=input.query!;return observation('memory');}};
  const b=await f.host.preview('owner',{targetId:'target',memoryQuery:'decision'});expect(query).toBe('decision');expect(b.observations.map(o=>o.id)).toContain('memory');
  // The host receives only readers and a resolver: no provider, test, memory write,
  // history, key, index, thread factory or mutation port is available to call.
  expect(Object.keys(f.host.diagnostics())).toEqual(['activePreviews','activeSources','storedPreviews']);
});
test('T11 budget_concurrency_and_bounds_hold',async()=>{
  const f=fixture(),pending=deferred<SourceObservation>();let active=0,max=0;
  for(const id of ['git','workroom','tester'] as SectionId[])f.readers[id]={async read(){active++;max=Math.max(max,active);const v=await pending.promise;active--;return {...v,id};}};
  const a=f.host.preview('owner',{targetId:'a'}),b=f.host.preview('owner',{targetId:'b'});await flush();
  expect(f.host.diagnostics().activeSources).toBe(4);expect(max).toBe(4);
  await expect(f.host.preview('owner',{targetId:'c'})).rejects.toThrow();await expect(f.host.preview('owner',{targetId:'a'})).rejects.toThrow();
  pending.resolve(observation('git'));await Promise.all([a,b]);expect(f.host.diagnostics().activeSources).toBe(0);
});
test('T12 budget_deadline_output_utf8_limits_are_explicit',async()=>{
  const f=fixture();f.readers.git={async read(_b,_i,budget){expect(budget.consume(1024*1024+1)).toBe(false);return {...observation('git'),summary:['한글😀'.repeat(6000)]};}};
  const b=await f.host.preview('owner',{targetId:'target'});const git=b.observations[0]!;expect(git.availability).toBe('partial');expect(git.limits.join(' ')).toContain('budget');
  expect(new TextEncoder().encode(JSON.stringify(b)).byteLength).toBeLessThanOrEqual(32768);expect(JSON.stringify(b)).not.toContain('\ufffd');
  await f.clock.advance(300001);await expect(f.host.prepare('owner',{targetId:'target',bundleId:b.id,sections:['git']})).rejects.toThrow();
});
test('T13 cancel_timeout_hold_real_slots',async()=>{
  const f=fixture(),pending=deferred<SourceObservation>();let aborted=0;
  for(const id of ['git','workroom'] as SectionId[])f.readers[id]={async read(_b,_i,_budget,signal){signal.addEventListener('abort',()=>aborted++);return {...await pending.promise,id};}};
  const run=f.host.preview('owner',{targetId:'target'});await flush();await f.clock.advance(3001);const b=await run;
  expect(b.state).toBe('partial');expect(aborted).toBe(2);expect(f.host.diagnostics().activeSources).toBe(2);expect(f.host.diagnostics().activePreviews).toBe(1);
  await expect(f.host.preview('owner',{targetId:'target'})).rejects.toThrow();pending.resolve(observation('git'));await flush();expect(f.host.diagnostics().activeSources).toBe(0);expect(f.host.diagnostics().activePreviews).toBe(0);
  expect(b.observations[0]!.availability).toBe('unknown');expect(b.observations[0]!.summary).toEqual([]);
  const g=fixture(),never=deferred<SourceObservation>(),controller=new AbortController();g.readers.git={async read(_b,_i,_bu,signal){signal.addEventListener('abort',()=>aborted++);return never.promise;}};
  const cancelled=g.host.preview('owner',{targetId:'target'},controller.signal);await flush();controller.abort();const cb=await cancelled;expect(cb.state).toBe('partial');expect(g.host.diagnostics().activePreviews).toBe(1);never.resolve(observation('git'));await flush();expect(g.host.diagnostics().activePreviews).toBe(0);
});
test('selection owner, target, source digest and hash are revalidated before the send callback',async()=>{
  const f=fixture(),b=await f.host.preview('owner',{targetId:'target'}),selection={targetId:'target',bundleId:b.id,sections:['git'] as SectionId[]};
  const prepared=await f.host.prepare('owner',selection);let sent='';
  await f.host.withPrepared('owner',{...selection,selectionHash:prepared.selectionHash},async p=>{sent=p.text;});expect(sent).toBe(prepared.text);
  await expect(f.host.prepare('other',selection)).rejects.toThrow();await expect(f.host.prepare('owner',{...selection,targetId:'other'})).rejects.toThrow();
  await expect(f.host.withPrepared('owner',{...selection,selectionHash:'0'.repeat(64)},async()=>{})).rejects.toThrow();
  f.readers.git={async read(){return {...observation('git'),sourceRevision:'v2',summary:['changed source']};}};let sends=0;
  await expect(f.host.withPrepared('owner',{...selection,selectionHash:prepared.selectionHash},async()=>{sends++;})).rejects.toThrow();expect(sends).toBe(0);
});
test('incomplete source proof permits bounded preview and blocks attachment',async()=>{
  const f=fixture(),resolve=f.host.deps.resolve;
  f.host.deps.resolve=async(...args)=>({...await resolve(...args),sourceProofComplete:false});
  const b=await f.host.preview('owner',{targetId:'target'});expect(b.state).toBe('partial');expect(b.observations[0]!.limits.join(' ')).toContain('fingerprint incomplete');
  await expect(f.host.prepare('owner',{targetId:'target',bundleId:b.id,sections:['git']})).rejects.toThrow();
});
test('cheap authority guard stops subsequent readers without repeated checkout fingerprint reads',async()=>{
  const f=fixture(),resolve=f.host.deps.resolve;let proofs=0,allowed=true;
  f.host.deps.resolve=async(...args)=>{proofs++;return resolve(...args);};
  f.host.deps.authorize=async()=>{if(!allowed)throw Error('revoked');};
  f.readers.git={async read(){allowed=false;return observation('git');}};
  const b=await f.host.preview('owner',{targetId:'target'});expect(b.state).toBe('invalidated');expect(f.calls).not.toContain('tester');expect(proofs).toBe(1);
});
test('total source I/O reservations cannot exceed the shared two MiB budget',async()=>{
  const f=fixture();const reservations:boolean[]=[];
  for(const id of ['git','workroom','tester'] as SectionId[])f.readers[id]={async read(_b,_i,budget){reservations.push(budget.consume(1024*1024));return observation(id);}};
  const b=await f.host.preview('owner',{targetId:'target'});expect(reservations).toEqual([true,true,false]);expect(b.observations[2]!.availability).toBe('partial');
});
test('submission errors keep the original error and are never replayed by the state host',async()=>{
  const f=fixture(),b=await f.host.preview('owner',{targetId:'target'}),input={targetId:'target',bundleId:b.id,sections:['git'] as SectionId[]};
  const prepared=await f.host.prepare('owner',input),unknown=new Error('existing submission receipt is unknown');let calls=0;
  try{await f.host.withPrepared('owner',{...input,selectionHash:prepared.selectionHash},async()=>{calls++;throw unknown;});throw Error('must reject');}catch(error){expect(error).toBe(unknown);}
  expect(calls).toBe(1);expect(f.host.diagnostics().activePreviews).toBe(0);
});
test('source observation time can advance while source identity and selected order remain stable',async()=>{
  const f=fixture();f.readers.git={async read(){return {...observation('git'),observedAt:f.clock.now()};}};
  const b=await f.host.preview('owner',{targetId:'target'}),input={targetId:'target',bundleId:b.id,sections:['git','workroom'] as SectionId[]};
  const a=await f.host.prepare('owner',input),reordered=await f.host.prepare('owner',{...input,sections:['workroom','git']});expect(reordered).toEqual(a);
  await f.clock.advance(100);let sent=0;await f.host.withPrepared('owner',{...input,selectionHash:a.selectionHash},async()=>{sent++;});expect(sent).toBe(1);
  f.revoke();await expect(f.host.withPrepared('owner',{...input,selectionHash:a.selectionHash},async()=>{sent++;})).rejects.toThrow();expect(sent).toBe(1);
});
test('volatile previews stay bounded and caller mutation cannot alter stored source evidence',async()=>{
  const f=fixture();let first='';
  for(let i=0;i<10;i++){const b=await f.host.preview('owner',{targetId:`target-${i}`});if(!i)first=b.id;}
  expect(f.host.diagnostics().storedPreviews).toBe(8);await expect(f.host.prepare('owner',{targetId:'target-0',bundleId:first,sections:['git']})).rejects.toThrow();
  const b=await f.host.preview('owner',{targetId:'target'});b.observations[0]!.summary=['injected by caller'];
  const p=await f.host.prepare('owner',{targetId:'target',bundleId:b.id,sections:['git']});expect(p.text).not.toContain('injected by caller');
});
test('continuation excludes only its trusted newly created Workroom session from final source validation',async()=>{
  const f=fixture();let ownPresent=false,otherChanged=false;let excluded:string|undefined;
  f.readers.workroom={async read(_binding,input){
    excluded=input.excludeWorkroomSessionId;
    const sessions=['existing-session',...(ownPresent?['new-own-session']:[]),...(otherChanged?['other-session']:[])].filter(id=>id!==input.excludeWorkroomSessionId);
    return {...observation('workroom'),sourceRevision:JSON.stringify(sessions),summary:sessions};
  }};
  f.readers.git={async read(_binding,input){expect(input.excludeWorkroomSessionId).toBeUndefined();return observation('git');}};
  const b=await f.host.preview('owner',{targetId:'target'}),input={targetId:'target',bundleId:b.id,sections:['git','workroom'] as SectionId[]};
  const prepared=await f.host.prepare('owner',input);ownPresent=true;let sends=0;
  await f.host.withPrepared('owner',{...input,selectionHash:prepared.selectionHash},async()=>{sends++;},undefined,{excludeWorkroomSessionId:'new-own-session'});
  expect(sends).toBe(1);expect(excluded).toBe('new-own-session');
  otherChanged=true;
  await expect(f.host.withPrepared('owner',{...input,selectionHash:prepared.selectionHash},async()=>{sends++;},undefined,{excludeWorkroomSessionId:'new-own-session'})).rejects.toThrow();
  expect(sends).toBe(1);
});
