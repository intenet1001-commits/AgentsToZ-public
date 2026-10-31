import {describe,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {type ComputerWorker} from '../src/computerUseHost';
import {ComputerCallerRegistry,isAuthenticatedComputerCaller} from '../src/computerUseCaller';
import {testComputerUseHost} from './computer-use-test-helper';
import {COMPUTER_USE_REFUSED_BUNDLES,COMPUTER_USE_REFUSED_TEAMS,isRefusedComputerTarget,parseComputerAgentRequest,parseComputerTarget} from '../src/computerUseProtocol';

const target={bundleId:'com.example.editor',teamId:'ABCDEFGHIJ',codeHash:'ab'.repeat(20),pid:100,processStart:'9007199254740995',windowId:321};
const observed={success:true,snapshotId:'ps1_exact',elements:[{id:'elem_1',role:'button',label:'Send',value:'',enabled:true,settable:false}],truncated:false};
function fixture() {
  const callers=new ComputerCallerRegistry();
  const leader=callers.authenticate(callers.issue({sessionId:'workroom_session_a',lane:'leader'}))!;
  const member=callers.authenticate(callers.issue({sessionId:'workroom_session_a',lane:'member-2'}))!;
  const otherSession=callers.authenticate(callers.issue({sessionId:'workroom_session_b',lane:'leader'}))!;
  const calls:Record<string,unknown>[]=[];let closed=0;
  let observe:()=>Promise<Record<string,any>>=async()=>observed;
  let action:()=>Promise<Record<string,any>>=async()=>({success:true,halted:false,humanStatePreserved:true,outcome:{state:'confirmed_change'}});
  const {host,grantFor}=testComputerUseHost({createWorker:async()=>({close(){closed++;},async request(body){calls.push(body);
    if(body.operation==='bind')return {success:true,bound:true,protocolVersion:2};
    if(body.operation==='observe')return observe();
    return action();
  }} satisfies ComputerWorker)});
  const grant=async()=>{const raw=await grantFor(leader,target,'Send the draft');return {grant:raw.grant,epoch:raw.epoch,id:raw.id};};
  const press=(g:{grant:string;epoch:number},observationId:string,requestId='press_request_01')=>({grant:g.grant,epoch:g.epoch,operation:'press',requestId,observationId,element:'elem_1'});
  return {host,grantFor,callers,leader,member,otherSession,calls,closed:()=>closed,grant,press,
    setObserve:(fn:typeof observe)=>{observe=fn;},setAction:(fn:typeof action)=>{action=fn;},
    dispatched:()=>calls.filter(c=>c.operation==='press').length};
}

describe('C3 · the authenticated caller, never the request body, owns a grant',()=>{
  test('a body cannot name a caller and a look-alike caller object is not authenticated',async()=>{
    const f=fixture();try{
      const g=await f.grant();
      for(const extra of [{caller:{sessionId:'workroom_session_a',lane:'leader'}},{sessionId:'workroom_session_a'},{lane:'leader'}])
        expect(()=>parseComputerAgentRequest({grant:g.grant,epoch:g.epoch,operation:'observe',...extra})).toThrow();
      const forged={sessionId:'workroom_session_a',lane:'leader'};
      expect(isAuthenticatedComputerCaller(forged)).toBe(false);
      await expect(f.host.agent(forged as any,{grant:g.grant,epoch:g.epoch,operation:'observe'})).rejects.toThrow('인증된 작업 세션');
      expect(()=>f.host.requestApproval(forged as any,target,'forged')).toThrow('인증된 작업 세션');
      expect(f.calls.filter(c=>c.operation==='observe')).toHaveLength(0);
    }finally{f.host.dispose();}
  });
  test('a leaked grant secret is useless to another lane or session and leaves the owner untouched',async()=>{
    const f=fixture();try{
      const g=await f.grant();
      for(const intruder of [f.member,f.otherSession]) {
        await expect(f.host.agent(intruder,{grant:g.grant,epoch:g.epoch,operation:'observe'})).rejects.toThrow('사람이 허용한');
        await expect(f.host.agent(intruder,{grant:g.grant,epoch:g.epoch,operation:'request-human'})).rejects.toThrow('사람이 허용한');
      }
      expect(f.calls.filter(c=>c.operation==='observe')).toHaveLength(0);
      const obs=await f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'observe'});
      const done=await f.host.agent(f.leader,f.press(g,obs.observationId));
      expect(done.receipt.state).toBe('confirmed');
      await expect(f.host.agent(f.member,{grant:g.grant,epoch:g.epoch,operation:'receipt',requestId:'press_request_01'})).rejects.toThrow('사람이 허용한');
      expect(f.host.list()[0]).toMatchObject({caller:{sessionId:'workroom_session_a',lane:'leader'},halted:false});
      expect(JSON.stringify(f.host.list())).not.toContain(g.grant);
    }finally{f.host.dispose();}
  });
  test('a retired credential stops authenticating and an ended session takes its grants and workers',async()=>{
    const f=fixture();try{
      const credential=f.callers.issue({sessionId:'workroom_session_c',lane:'leader'});
      const caller=f.callers.authenticate(credential)!;expect(caller.lane).toBe('leader');
      expect(f.callers.authenticate('ff'.repeat(32))).toBeNull();expect(f.callers.authenticate({credential})).toBeNull();
      await f.grantFor(caller,{...target,pid:200},'session c');
      f.callers.retire('workroom_session_c');expect(f.callers.authenticate(credential)).toBeNull();
      f.host.endSession('workroom_session_c');
      expect(f.host.list()).toHaveLength(0);expect(f.closed()).toBe(1);
    }finally{f.host.dispose();}
  });
});

describe('C5 · a person moving during a read voids only that read; a real stop is shared',()=>{
  test('a discarded observation keeps the grant usable and the next observation works',async()=>{
    const f=fixture();try{
      const g=await f.grant();
      f.setObserve(async()=>({success:false,code:'observation-discarded',halted:false}));
      await expect(f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'observe'})).rejects.toThrow('이번 관찰만');
      expect(f.host.list()[0]).toMatchObject({halted:false});expect(f.host.list()[0]).not.toHaveProperty('haltReason');
      f.setObserve(async()=>observed);
      const obs=await f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'observe'});
      expect((await f.host.agent(f.leader,f.press(g,obs.observationId))).receipt.state).toBe('confirmed');
    }finally{f.host.dispose();}
  });
  test('a worker that reports it stopped stops the host grant, closes the worker and gets no further calls',async()=>{
    const f=fixture();try{
      const g=await f.grant();
      f.setObserve(async()=>({success:false,code:'worker-halted',halted:true}));
      await expect(f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'observe'})).rejects.toThrow();
      expect(f.host.list()[0]).toMatchObject({halted:true,haltReason:'worker-halted'});expect(f.closed()).toBe(1);
      const before=f.calls.length;
      await expect(f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'observe'})).rejects.toThrow('제어 허용이 끝났습니다');
      expect(f.calls.length).toBe(before);
    }finally{f.host.dispose();}
  });
  test('a worker that disappears while observing is shown as stopped, not alive',async()=>{
    const f=fixture();try{
      const g=await f.grant();f.setObserve(async()=>{throw Error('pipe closed');});
      await expect(f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'observe'})).rejects.toThrow('실행기가 끝났습니다');
      expect(f.host.list()[0]).toMatchObject({halted:true,haltReason:'worker-unavailable'});
    }finally{f.host.dispose();}
  });
});

describe('refused before dispatch is not unknown',()=>{
  test('C6 human activity hold is a refusal with a retry hint; the same ID never re-sends, a new observation may',async()=>{
    const f=fixture();try{
      const g=await f.grant();
      const obs=await f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'observe'});
      f.setAction(async()=>({success:false,code:'human-active',notDispatched:true,halted:false,retryAfterMs:900}));
      const held=await f.host.agent(f.leader,f.press(g,obs.observationId));
      expect(held).toMatchObject({receipt:{state:'refused',reason:'human-active'},retryAfterMs:900});expect(held).not.toHaveProperty('owner');
      expect(f.host.list()[0]).toMatchObject({halted:false});
      expect((await f.host.agent(f.leader,f.press(g,obs.observationId))).receipt.state).toBe('refused');
      expect(f.dispatched()).toBe(1);
      f.setAction(async()=>({success:true,halted:false,humanStatePreserved:true,outcome:{state:'confirmed_change'}}));
      const again=await f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'observe'});
      expect((await f.host.agent(f.leader,f.press(g,again.observationId,'press_request_02'))).receipt.state).toBe('confirmed');
    }finally{f.host.dispose();}
  });
  test('a failure without an explicit not-dispatched mark stays unknown and stops the grant',async()=>{
    const f=fixture();try{
      const g=await f.grant();
      const obs=await f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'observe'});
      f.setAction(async()=>({success:false,code:'native-operation-unconfirmed',halted:true}));
      expect(await f.host.agent(f.leader,f.press(g,obs.observationId))).toMatchObject({receipt:{state:'unknown'},owner:'human'});
      expect(f.host.list()[0]).toMatchObject({halted:true,haltReason:'outcome-unknown'});
    }finally{f.host.dispose();}
  });
  test('a takeover the worker also reports as a stop is shown to the person as a takeover',async()=>{
    const f=fixture();try{
      const g=await f.grant();
      const obs=await f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'observe'});
      f.setAction(async()=>({success:true,halted:true,humanStatePreserved:false,outcome:{state:'confirmed_change'}}));
      expect(await f.host.agent(f.leader,f.press(g,obs.observationId))).toMatchObject({receipt:{state:'human-takeover'},owner:'human'});
      expect(f.host.list()[0]).toMatchObject({halted:true,haltReason:'human-takeover'});
    }finally{f.host.dispose();}
  });
  test('the SDK refusal and unrecognised refusal codes are refusals with a bounded reason',async()=>{
    const f=fixture();try{
      const g=await f.grant();
      let obs=await f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'observe'});
      f.setAction(async()=>({success:true,halted:false,humanStatePreserved:true,outcome:{state:'refused'}}));
      expect((await f.host.agent(f.leader,f.press(g,obs.observationId))).receipt).toEqual({requestId:'press_request_01',state:'refused',reason:'native-refused'});
      obs=await f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'observe'});
      f.setAction(async()=>({success:false,code:'raw AX text: secret',notDispatched:true,halted:false}));
      const r=await f.host.agent(f.leader,f.press(g,obs.observationId,'press_request_02'));
      expect(r.receipt).toEqual({requestId:'press_request_02',state:'refused',reason:'worker-refused'});
      expect(JSON.stringify(r)).not.toContain('secret');expect(f.host.list()[0]).toMatchObject({halted:false});
    }finally{f.host.dispose();}
  });
  test('a worker transport that throws during capture stops the grant like observe does',async()=>{
    const f=fixture();try{
      const g=await f.grant();
      const obs=await f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'observe'});
      f.setAction(async()=>{throw Error('lab transport lost');});
      await expect(f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'capture',observationId:obs.observationId})).rejects.toThrow('실행기가 끝났습니다');
      expect(f.host.list()[0]).toMatchObject({halted:true,haltReason:'worker-unavailable',busy:false});
      expect(f.closed()).toBeGreaterThan(0);
      await expect(f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch+1,operation:'observe'})).rejects.toThrow('제어 허용이 끝났습니다');
    }finally{f.host.dispose();}
  });
  test('a refusal that also says the worker stopped keeps the receipt refused and stops the grant',async()=>{
    const f=fixture();try{
      const g=await f.grant();
      const obs=await f.host.agent(f.leader,{grant:g.grant,epoch:g.epoch,operation:'observe'});
      f.setAction(async()=>({success:false,code:'target-changed',notDispatched:true,halted:true}));
      expect(await f.host.agent(f.leader,f.press(g,obs.observationId))).toMatchObject({receipt:{state:'refused',reason:'target-changed'},owner:'human'});
      expect(f.host.list()[0]).toMatchObject({halted:true,haltReason:'worker-halted'});
    }finally{f.host.dispose();}
  });
});

describe('C1/C2 target refusal list',()=>{
  test('a worker that does not speak the current stop/refusal protocol is never bound',async()=>{
    for(const bind of [{success:true,bound:true},{success:true,bound:true,protocolVersion:1}]) {
      let closed=0;const callers=new ComputerCallerRegistry();const caller=callers.authenticate(callers.issue({sessionId:'workroom_session_a',lane:'leader'}))!;
      const {host,grantFor}=testComputerUseHost({createWorker:async()=>({close(){closed++;},async request(){return bind;}})});
      await expect(grantFor(caller,target,'old worker')).rejects.toThrow('버전');
      expect(host.list()).toHaveLength(0);expect(closed).toBe(1);host.dispose();
    }
  });
  test('the child-process worker is lab-only and refuses to start inside the bundled app sidecar',async()=>{
    const {createLabComputerWorkerFactory}=await import('../src/computerUseWorker');
    let verified=0;const verify=async()=>{verified++;return true;};
    await expect(createLabComputerWorkerFactory({executable:'/usr/bin/false',verify,lab:false as unknown as true})()).rejects.toThrow('실험과 시험 전용');
    const before=process.env.PORTMGR_BUNDLED_SIDECAR;process.env.PORTMGR_BUNDLED_SIDECAR='1';
    try{await expect(createLabComputerWorkerFactory({executable:'/usr/bin/false',verify,lab:true})()).rejects.toThrow('실험과 시험 전용');}
    finally{if(before===undefined)delete process.env.PORTMGR_BUNDLED_SIDECAR;else process.env.PORTMGR_BUNDLED_SIDECAR=before;}
    expect(verified).toBe(0);
  });
  test('a lab grant refuses capture and click up front with the lab reason, before any ledger row or worker request',async()=>{
    if(process.platform!=='darwin')return;
    const {mkdtempSync,writeFileSync,chmodSync,rmSync,existsSync}=await import('node:fs');
    const {tmpdir}=await import('node:os');const {join}=await import('node:path');
    const {createLabComputerWorkerFactory}=await import('../src/computerUseWorker');
    const {ComputerUseRecovery}=await import('../src/computerUseRecovery');
    // Answers like the native lab worker (Sources/ComputerUseWorker) and logs every line it is sent.
    const dir=mkdtempSync(join(tmpdir(),'agentstoz-lab-worker-')),log=join(dir,'requests.log'),executable=join(dir,'lab-worker');
    writeFileSync(executable,`#!/bin/sh\nwhile IFS= read -r line; do\n  printf '%s\\n' "$line" >> '${log}'\n  case "$line" in\n`
      +`    *'"operation":"bind"'*) echo '{"success":true,"bound":true,"protocolVersion":2,"halted":false}';;\n`
      +`    *'"operation":"observe"'*) echo '${JSON.stringify({...observed,halted:false})}';;\n`
      +`    *) echo '{"success":false,"code":"unsupported-operation","notDispatched":false,"halted":false}';;\n  esac\ndone\n`);
    chmodSync(executable,0o700);
    const before=process.env.PORTMGR_BUNDLED_SIDECAR;delete process.env.PORTMGR_BUNDLED_SIDECAR;
    const recovery=new ComputerUseRecovery(':memory:');
    const callers=new ComputerCallerRegistry();const leader=callers.authenticate(callers.issue({sessionId:'workroom_session_a',lane:'leader'}))!;
    const factory=createLabComputerWorkerFactory({executable,verify:async()=>true,lab:true});
    const {host,grantFor}=testComputerUseHost({createWorker:()=>factory(),recovery});
    try{
      const raw=await grantFor(leader,target,'Lab grant');const g={grant:raw.grant,epoch:raw.epoch};
      const obs=await host.agent(leader,{...g,operation:'observe'});
      for(const request of [{...g,operation:'capture',observationId:obs.observationId},
        {...g,operation:'click',requestId:'click_request_01',observationId:obs.observationId,x:10,y:10}])
        await expect(host.agent(leader,request)).rejects.toThrow('lab-worker-unsupported');
      // Nothing was recorded as possibly sent: the grant keeps working and no app waits for a person's review.
      expect(recovery.pending()).toEqual([]);
      expect(host.list()[0]).toMatchObject({halted:false,busy:false});
      expect(existsSync(log)?readFileSync(log,'utf8'):'').not.toMatch(/"operation":"(capture|click)"/);
      expect((await host.agent(leader,{...g,operation:'observe'})).observationId).toEqual(expect.any(String));
    }finally{
      host.dispose();if(before!==undefined)process.env.PORTMGR_BUNDLED_SIDECAR=before;rmSync(dir,{recursive:true,force:true});
    }
  });
  test('AgentsToZ itself, its helpers, agent apps, their shells and security surfaces are never targets',()=>{
    for(const bundleId of ['com.intenet.agentstozbycs','com.intenet.agentstozbycs.screen','com.intenet.agentstozbycs.control','com.intenet.agentstozbycs.helper.computer-use',
      'com.openai.codex','com.openai.atlas','com.anthropic.claudefordesktop','com.nousresearch.hermes','com.google.antigravity',
      'com.stablyai.orca','com.cmuxterm.app','com.googlecode.iterm2','com.apple.Terminal','com.apple.Passwords','com.apple.systempreferences',
      'com.apple.keychainaccess','com.apple.loginwindow','com.apple.SecurityAgent','com.apple.SecurityAgentHelper.arm64'])
      expect(()=>parseComputerTarget({...target,bundleId})).toThrow('허용하지 않습니다');
    // Apple's Intel helper ID has an underscore, which the target format already rejects; it stays listed for the worker.
    expect(isRefusedComputerTarget({bundleId:'com.apple.SecurityAgentHelper.x86_64',teamId:''})).toBe(true);
    expect(()=>parseComputerTarget({...target,bundleId:'com.apple.SecurityAgentHelper.x86_64'})).toThrow('다시 선택하세요');
    expect(()=>parseComputerTarget({...target,bundleId:'com.example.renamed',teamId:'DA8QKAQ2C9'})).toThrow('허용하지 않습니다');
    expect(parseComputerTarget(target).bundleId).toBe('com.example.editor');
  });
  test('the native worker refuses the same bundles and team',()=>{
    // One native list (ControlProtocol.swift `RefusedTargets`) serves the lab worker and AgentsToZ Control alike.
    const read=(path:string)=>readFileSync(new URL(`../native/computer-use/Sources/${path}`,import.meta.url),'utf8');
    const swift=read('ComputerUseControlCore/ControlProtocol.swift');
    for(const id of [...COMPUTER_USE_REFUSED_BUNDLES,...COMPUTER_USE_REFUSED_TEAMS,'com.intenet.agentstozbycs.'])expect(swift).toContain(`"${id}"`);
    const engine=read('ComputerUseEngine/Engine.swift');
    expect(engine).toContain('RefusedTargets.refuses(bundle:');expect(engine).toContain('RefusedTargets.teams.contains');
    expect(read('ComputerUseControlCore/ControlState.swift')).toContain('RefusedTargets.refuses(target)');
  });
});
