import {describe,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ComputerCallerRegistry,isAuthenticatedComputerCaller} from '../src/computerUseCaller';
import {ComputerUseRecovery} from '../src/computerUseRecovery';
import type {ComputerWorker} from '../src/computerUseHost';
import {testComputerUseHost} from './computer-use-test-helper';

// Leader's independent reproductions (2026-10-27 02:45, /tmp/agentstoz-core-independent-probes-20261027), kept as
// regressions: a cached caller object outliving its session, a grant created after its session ended, and two hosts
// sharing one ledger both admitting an action for the same app.
const target={bundleId:'com.example.probe',teamId:'ABCDEFGHIJ',codeHash:'ab'.repeat(20),pid:100,processStart:'101',windowId:123};
const bound={success:true,bound:true,protocolVersion:2};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

describe('a caller object is trusted only while its credential is live',()=>{
  test('retiring the session or reaching the lifetime ends trust in objects callers already hold',()=>{
    let now=1000;const registry=new ComputerCallerRegistry({now:()=>now,lifetimeMs:100});
    const retired=registry.authenticate(registry.issue({sessionId:'owned-probe-session',lane:'leader'}))!;
    expect(isAuthenticatedComputerCaller(retired)).toBe(true);
    registry.retire('owned-probe-session');
    expect(isAuthenticatedComputerCaller(retired)).toBe(false);
    const expiring=registry.authenticate(registry.issue({sessionId:'owned-expiry-session',lane:'leader'}))!;
    now+=99;expect(isAuthenticatedComputerCaller(expiring)).toBe(true);
    now+=1;expect(isAuthenticatedComputerCaller(expiring)).toBe(false);
    // The registry no longer resolves it either, and a copy of the object was never trusted.
    expect(isAuthenticatedComputerCaller({...expiring})).toBe(false);
  });
  test('a new credential for a reused session ID is a different caller',()=>{
    const registry=new ComputerCallerRegistry();
    const first=registry.authenticate(registry.issue({sessionId:'owned-reused-session',lane:'leader'}))!;
    registry.retire('owned-reused-session');
    const second=registry.authenticate(registry.issue({sessionId:'owned-reused-session',lane:'leader'}))!;
    expect(isAuthenticatedComputerCaller(first)).toBe(false);
    expect(isAuthenticatedComputerCaller(second)).toBe(true);
    expect(second).not.toBe(first);
  });
});

describe('an ended session cannot gain control while a grant is being prepared',()=>{
  function pendingBind() {
    let release!:(v:any)=>void;let closed=0;
    const f=testComputerUseHost({createWorker:async()=>({close(){closed++;},request:async()=>await new Promise(resolve=>release=resolve)})});
    return {...f,release:(v:any)=>release(v),closed:()=>closed};
  }
  test('ending the session while the worker binds closes it and creates no grant',async()=>{
    const callers=new ComputerCallerRegistry(),caller=callers.authenticate(callers.issue({sessionId:'owned-close-during-bind',lane:'leader'}))!;
    const f=pendingBind();
    const pending=f.grantFor(caller,target);
    await tick();f.host.endSession(caller.sessionId);callers.retire(caller.sessionId);
    f.release(bound);
    await expect(pending).rejects.toThrow('작업 세션이 끝나');
    expect(f.host.list()).toHaveLength(0);expect(f.closed()).toBeGreaterThan(0);
    f.host.dispose();
  });
  test('retiring the credential alone during the bind also creates no grant',async()=>{
    const callers=new ComputerCallerRegistry(),caller=callers.authenticate(callers.issue({sessionId:'owned-retire-during-bind',lane:'leader'}))!;
    const f=pendingBind();
    const pending=f.grantFor(caller,target);
    await tick();callers.retire(caller.sessionId);f.release(bound);
    await expect(pending).rejects.toThrow('작업 세션이 끝나');
    expect(f.host.list()).toHaveLength(0);
    f.host.dispose();
  });
  test('a signature that arrives after the session ended is refused',async()=>{
    const callers=new ComputerCallerRegistry(),caller=callers.authenticate(callers.issue({sessionId:'owned-close-before-sign',lane:'leader'}))!;
    let workers=0;
    const f=testComputerUseHost({createWorker:async()=>{workers++;return {close(){},request:async()=>bound};}});
    const request=f.host.requestApproval(caller,target,'Edit draft');
    f.host.endSession(caller.sessionId);callers.retire(caller.sessionId);
    await expect(f.host.grant(f.helper.approve(request))).rejects.toThrow();
    expect(workers).toBe(0);expect(f.host.list()).toHaveLength(0);
    f.host.dispose();
  });
  test('reusing an old session ID revives neither its approval request nor its grant',async()=>{
    const callers=new ComputerCallerRegistry();
    const old=callers.authenticate(callers.issue({sessionId:'owned-reused-session-a',lane:'leader'}))!;
    const f=testComputerUseHost({createWorker:async()=>({close(){},request:async(b:any)=>b.operation==='bind'?bound:{success:true,snapshotId:'ps1',elements:[],truncated:false,halted:false}})});
    const granted=await f.grantFor(old,target);
    const request=f.host.requestApproval(old,{...target,windowId:124},'Second window');
    callers.retire(old.sessionId);f.host.endSession(old.sessionId);
    const reborn=callers.authenticate(callers.issue({sessionId:'owned-reused-session-a',lane:'leader'}))!;
    await expect(f.host.grant(f.helper.approve(request))).rejects.toThrow();
    await expect(f.host.agent(reborn,{grant:granted.grant,epoch:1,operation:'observe'})).rejects.toThrow('사람이 허용한');
    expect(f.host.list()).toHaveLength(0);
    f.host.dispose();
  });
  test('a grant whose credential was retired without endSession stops and is no longer listed as active',async()=>{
    const callers=new ComputerCallerRegistry();
    const caller=callers.authenticate(callers.issue({sessionId:'owned-retired-grant',lane:'leader'}))!;
    const f=testComputerUseHost({createWorker:async()=>({close(){},request:async()=>bound})});
    await f.grantFor(caller,target);
    expect(f.host.list()).toHaveLength(1);
    callers.retire(caller.sessionId);
    expect(f.host.list()).toHaveLength(0);
    f.host.dispose();
  });
});

describe('two hosts sharing one ledger admit at most one unknown action per app',()=>{
  test('the second begin for the same app is refused inside the writer transaction; another app still runs',()=>{
    const dir=mkdtempSync(join(tmpdir(),'agentstoz-computer-use-admission-'));
    try {
      const path=join(dir,'actions.sqlite');
      const a=new ComputerUseRecovery(path),b=new ComputerUseRecovery(path);
      expect(a.unresolved('com.example.probe')).toHaveLength(0);expect(b.unresolved('com.example.probe')).toHaveLength(0);
      a.begin({bundleId:'com.example.probe',windowId:1,operation:'press',requestId:'owned-first',sessionId:'first',lane:'leader'});
      expect(()=>b.begin({bundleId:'com.example.probe',windowId:2,operation:'press',requestId:'owned-second',sessionId:'second',lane:'leader'})).toThrow('결과를 모르는');
      expect(()=>b.begin({bundleId:'COM.EXAMPLE.PROBE',windowId:3,operation:'set-value',requestId:'owned-third',sessionId:'second',lane:'leader'})).toThrow('결과를 모르는');
      const other=b.begin({bundleId:'com.example.other',windowId:4,operation:'press',requestId:'owned-other',sessionId:'second',lane:'leader'});
      expect(a.pending().map(r=>r.bundleId).sort()).toEqual(['com.example.other','com.example.probe']);
      b.settle(other);a.close();b.close();
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  test('while one host sends to an app, a second host sharing the ledger is refused for that app and sends nothing',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'agentstoz-computer-use-hosts-'));
    try {
      const path=join(dir,'actions.sqlite');
      const callers=new ComputerCallerRegistry();
      const caller=callers.authenticate(callers.issue({sessionId:'owned-two-hosts',lane:'leader'}))!;
      let finish!:(v:Record<string,any>)=>void;const sent:string[]=[];
      const worker=(name:string)=>async():Promise<ComputerWorker>=>({close(){},request:async(b:any):Promise<Record<string,any>>=>{
        if(b.operation==='bind')return bound;
        if(b.operation==='observe')return {success:true,snapshotId:`ps_${name}_snapshot`,halted:false,truncated:false,
          elements:[{id:'elem_1',role:'button',label:'Send',value:'',enabled:true,settable:false}]};
        sent.push(name);
        return name==='a'?await new Promise<Record<string,any>>(r=>finish=r):{success:true,halted:false,humanStatePreserved:true,outcome:{state:'confirmed_change'}};
      }});
      const ledgerA=new ComputerUseRecovery(path),ledgerB=new ComputerUseRecovery(path);
      const A=testComputerUseHost({createWorker:worker('a'),recovery:ledgerA});
      const B=testComputerUseHost({createWorker:worker('b'),recovery:ledgerB});
      const ga=await A.grantFor(caller,target),gb=await B.grantFor(caller,{...target,pid:200,processStart:'201',windowId:124});
      const oa=await A.host.agent(caller,{grant:ga.grant,epoch:ga.epoch,operation:'observe'});
      const ob=await B.host.agent(caller,{grant:gb.grant,epoch:gb.epoch,operation:'observe'});
      const first=A.host.agent(caller,{grant:ga.grant,epoch:ga.epoch,operation:'press',requestId:'owned_press_a',observationId:oa.observationId,element:'elem_1'});
      await tick();
      await expect(B.host.agent(caller,{grant:gb.grant,epoch:gb.epoch,operation:'press',requestId:'owned_press_b',
        observationId:ob.observationId,element:'elem_1'})).rejects.toThrow(/결과를 (아직 )?모르는|결과를 확인하지 못한/);
      expect(sent).toEqual(['a']);
      finish({success:true,halted:false,humanStatePreserved:true,outcome:{state:'confirmed_change'}});
      expect((await first).receipt.state).toBe('confirmed');
      expect(ledgerA.pending()).toHaveLength(0);
      A.host.dispose();B.host.dispose();ledgerA.close();ledgerB.close();
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
});
