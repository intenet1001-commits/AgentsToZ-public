import {expect,test} from 'bun:test';
import {DesktopEffortPreDispatchRefusal,DesktopSessionEffort} from '../src/desktopSessionEffort';
import {DESKTOP_EFFORT_ADAPTER_STATUS,HermesDesktopEffortAdapter,type HermesDesktopEffortPort,type NativeDesktopEffortSnapshot} from '../src/desktopEffortNative';
import {DesktopEffortHost} from '../src/desktopEffortHost';
import {handleDesktopEffort} from '../src/desktopEffortApi';
function fixture(){
  let now=1_800_000_000_000,fail=false;
  const binding={adapter:'hermes-desktop',adapterVersion:'canonical-view-witness-v1',sessionId:'hermes_session_01',generation:4,model:'gpt-fixture',provider:'openai',accountId:'profile-fixture'};
  let snapshot:NativeDesktopEffortSnapshot={...binding,revision:12,executionGeneration:37,effort:'medium',supported:['low','medium','high','xhigh','max'],idle:true,nativePickerOpen:false,
    globalSettingsFingerprint:'global-unchanged',otherSessionsFingerprint:'other-unchanged',view:{sessionId:binding.sessionId,generation:4,inputRevision:8,composerEmpty:true,pickerOpen:false,validUntil:now+10000}};
  const calls:{params:Parameters<HermesDesktopEffortPort['mutate']>[0];view:NativeDesktopEffortSnapshot['view']}[]=[];
  const port:HermesDesktopEffortPort={capture:async()=>structuredClone(snapshot),mutate:async(params,view,isAuthorized)=>{
    if(!isAuthorized())throw new DesktopEffortPreDispatchRefusal('authorization revoked before dispatch');
    calls.push({params,view});if(fail)throw Error('lost native response');
    if(params.expected_revision!==snapshot.revision||params.expected_generation!==snapshot.executionGeneration||view.inputRevision!==snapshot.view.inputRevision||view.validUntil<=now)throw Error('native CAS refusal');
    snapshot={...snapshot,revision:snapshot.revision+1,executionGeneration:snapshot.executionGeneration+1,effort:params.payload.effort};
    return {session_id:binding.sessionId,request_id:params.request_id,status:'applied',revision:snapshot.revision,execution_generation:snapshot.executionGeneration,effort:snapshot.effort};
  }};
  const adapter=new HermesDesktopEffortAdapter(binding,port,()=>now);
  return {binding,port,adapter,calls,now:()=>now,time:(ms:number)=>{now+=ms;snapshot.view.validUntil=now+10000;},change:(p:Partial<NativeDesktopEffortSnapshot>)=>{snapshot={...snapshot,...p};},get:()=>structuredClone(snapshot),fail:()=>{fail=true;}};
}
test('native adapter sends canonical session-scoped reasoning CAS and verifies policy plus view readback',async()=>{
  const f=fixture(),control=new DesktopSessionEffort(f.adapter);await control.configure('auto',{consent:f.binding});
  expect(await control.transition({requestId:'native_effort_run_01',text:'권한 격리 설계를 검증해 줘',phase:'planning'})).toMatchObject({state:'applied',after:'high'});
  expect(f.calls).toHaveLength(1);expect(f.calls[0]!.params).toEqual({session_id:f.binding.sessionId,request_id:'native_effort_run_01',expected_revision:12,expected_generation:37,operation:'reasoning',payload:{effort:'high'}});
  expect(f.calls[0]!.view).toMatchObject({sessionId:f.binding.sessionId,inputRevision:8});
  expect((await f.adapter.read()).generation).toBe(4);expect(f.get().executionGeneration).toBe(38);
});
test('view input edits, native pickers, session replacement and stale policy never dispatch',async()=>{
  for(const change of ['input','picker','session','revision']){
    const f=fixture();await f.adapter.read();const s=f.get();
    if(change==='input')f.change({view:{...s.view,inputRevision:9,composerEmpty:false}});
    if(change==='picker')f.change({view:{...s.view,pickerOpen:true}});
    if(change==='session')f.change({sessionId:'replacement-session'});
    if(change==='revision')f.change({revision:13});
    await expect(f.adapter.set({sessionId:f.binding.sessionId,generation:4,expectedRevision:12,effort:'high',requestId:'native_guard_01'})).rejects.toThrow();expect(f.calls).toHaveLength(0);
  }
});
test('a lost native result halts the adapter and can never issue another mutation',async()=>{
  const f=fixture();await f.adapter.read();f.fail();const request={sessionId:f.binding.sessionId,generation:4,expectedRevision:12,effort:'high' as const,requestId:'native_unknown_01'};
  await expect(f.adapter.set(request)).rejects.toThrow();await expect(f.adapter.set({...request,requestId:'native_unknown_02'})).rejects.toThrow();expect(f.calls).toHaveLength(1);
});
test('policy readback cannot silently change another session or global defaults',async()=>{
  const f=fixture(),mutate=f.port.mutate;f.port.mutate=async(...args)=>{const result=await mutate(...args);f.change({otherSessionsFingerprint:'changed'});return result;};
  await f.adapter.read();await expect(f.adapter.set({sessionId:f.binding.sessionId,generation:4,expectedRevision:12,effort:'high',requestId:'native_other_01'})).rejects.toThrow();await expect(f.adapter.read()).rejects.toThrow();
});
test('management starts unsupported, cannot register a fake adapter or execute a native mutation',async()=>{
  const host=new DesktopEffortHost();const state=await host.manage({operation:'status'});expect(state).toMatchObject({success:true,sessions:[]});
  expect(state.adapters?.every(a=>a.available===false)).toBe(true);
  for(const body of [{operation:'register',binding:{}},{operation:'transition',text:'raise effort'},{operation:'configure',id:'fake-session',expectedRevision:1,mode:'auto',consent:true}])await expect(host.manage(body)).rejects.toThrow();
});
test('app status names what AgentsToZ still lacks and the manual step, without claiming a vendor API or an installed app',()=>{
  expect(DESKTOP_EFFORT_ADAPTER_STATUS.map(s=>s.id)).toEqual(['hermes-desktop','codex-desktop','claude-desktop','agy-desktop']);
  for(const s of DESKTOP_EFFORT_ADAPTER_STATUS){
    expect(s.available).toBe(false);expect(s.reason).toContain('연결이 아직 없습니다');
    expect(s.reason).toEndWith(`${s.label} 앱의 effort 선택에서 직접 바꾸세요.`);
    expect(s.reason).not.toMatch(/공식|RPC|session\.mutate|설치본|config\.set/);
  }
  expect(DESKTOP_EFFORT_ADAPTER_STATUS[0].reason).toContain('전역 설정으로 넘어갈 수 있는 설정 변경으로 대신하지 않습니다');
});
test('a missing or mismatched session id never reaches the port, so nothing can fall back to a global default',async()=>{
  const f=fixture();expect(()=>new HermesDesktopEffortAdapter({...f.binding,sessionId:''},f.port,f.now)).toThrow('세션 결속');
  await f.adapter.read();
  for(const sessionId of ['','hermes_session_02'])
    await expect(f.adapter.set({sessionId,generation:4,expectedRevision:12,effort:'high',requestId:`session_mismatch_${sessionId||'empty'}`})).rejects.toThrow('세션 상태가 바뀌어');
  expect(f.calls).toHaveLength(0);
  // An answer for another session is never accepted as applied to this one.
  const mutate=f.port.mutate;f.port.mutate=async(...args)=>({...await mutate(...args),session_id:'hermes_session_02'});
  await expect(f.adapter.set({sessionId:f.binding.sessionId,generation:4,expectedRevision:12,effort:'high',requestId:'session_mismatch_result'})).rejects.toThrow('변경 결과');
  expect(f.calls.map(c=>c.params.session_id)).toEqual([f.binding.sessionId]);
});
test('session-specific consent, fixed Max and expiry are enforced independently from desktop defaults',async()=>{
  const f=fixture(),host=new DesktopEffortHost(f.now),id=host.register('Owned Hermes session',f.adapter);
  await expect(host.manage({operation:'configure',id,expectedRevision:1,mode:'auto'})).rejects.toThrow('동의');
  await host.manage({operation:'configure',id,expectedRevision:1,mode:'auto',consent:true,fixed:'max'});
  expect(await host.boundary(id,{requestId:'host_boundary_01',text:'오타만 수정',phase:'implementation'})).toMatchObject({state:'held',reason:'user-fixed'});expect(f.calls).toHaveLength(0);
  await host.manage({operation:'configure',id,expectedRevision:2,mode:'auto',consent:true});f.time(600001);
  await host.boundary(id,{requestId:'host_boundary_02',text:'권한 격리 설계',phase:'planning'});expect(f.calls).toHaveLength(0);expect((await host.manage({operation:'status'})).sessions?.[0]?.mode).toBe('recommend');
});
test('unregistering during the last native read prevents mutation; the consent deadline reaches the native witness',async()=>{
  const f=fixture(),host=new DesktopEffortHost(f.now),id=host.register('Owned',f.adapter);await host.manage({operation:'configure',id,expectedRevision:1,mode:'auto',consent:true});
  await host.boundary(id,{requestId:'host_boundary_03',text:'권한 격리 설계',phase:'planning'});expect(f.calls[0]!.view.validUntil).toBeLessThanOrEqual(f.now()+600000);
  const g=fixture(),other=new DesktopEffortHost(g.now),key=other.register('Other',g.adapter);await other.manage({operation:'configure',id:key,expectedRevision:1,mode:'auto',consent:true});
  const read=g.port.capture;let reads=0;g.port.capture=async()=>{const result=await read();if(++reads===1)other.unregister(key);return result;};
  expect(await other.boundary(key,{requestId:'host_boundary_04',text:'권한 격리 설계',phase:'planning'})).toMatchObject({state:'held',reason:'consent-revoked'});expect(g.calls).toHaveLength(0);
});
test('revoking consent while the adapter is awaiting its final native capture never dispatches',async()=>{
  for(const revoke of ['disconnect','expiry'] as const){
    const f=fixture(),host=new DesktopEffortHost(f.now),id=host.register('Owned',f.adapter);
    await host.manage({operation:'configure',id,expectedRevision:1,mode:'auto',consent:true});
    let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
    const capture=f.port.capture;let reads=0;
    f.port.capture=async()=>{const result=await capture();if(++reads===2){started();await gate;}return result;};
    const pending=host.boundary(id,{requestId:`revoke_final_${revoke}`,text:'권한 격리 설계',phase:'planning'});
    await entered;
    if(revoke==='disconnect')host.unregister(id);else f.time(600001);
    release();
    expect(await pending).toMatchObject({state:'held',reason:'native-pre-dispatch-refused'});
    expect(f.calls).toHaveLength(0);
  }
});
test('a cooperative connector rechecks consent after its asynchronous setup and before native dispatch',async()=>{
  const f=fixture(),host=new DesktopEffortHost(f.now),id=host.register('Owned',f.adapter);
  await host.manage({operation:'configure',id,expectedRevision:1,mode:'auto',consent:true});
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
  const mutate=f.port.mutate;f.port.mutate=async(...args)=>{started();await gate;return mutate(...args);};
  const pending=host.boundary(id,{requestId:'revoke_native_setup_01',text:'권한 격리 설계',phase:'planning'});
  await entered;host.unregister(id);release();
  expect(await pending).toMatchObject({state:'held',reason:'native-pre-dispatch-refused'});expect(f.calls).toHaveLength(0);
});
test('external effort HTTP keeps management authorization and strict body limits',async()=>{
  const host=new DesktopEffortHost(),req=(body:unknown)=>new Request('http://localhost/api/agent-runtime/desktop-effort',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  expect((await handleDesktopEffort(req({operation:'status'}),host,false)).status).toBe(403);
  expect((await handleDesktopEffort(req({operation:'status',binding:'forged'}),host,true)).status).toBe(400);
  expect((await handleDesktopEffort(req({operation:'status'}),host,true)).status).toBe(200);
});
test('incomplete or non-finite native view witnesses cannot authorize mutation',async()=>{
  for(const invalid of [
    {pickerOpen:undefined}, {composerEmpty:undefined}, {validUntil:NaN}, {validUntil:Infinity}
  ]){
    const f=fixture(),s=f.get();f.change({view:{...s.view,...invalid} as NativeDesktopEffortSnapshot['view']});
    await expect(f.adapter.read()).rejects.toThrow();expect(f.calls).toHaveLength(0);
  }
  for(const invalid of [{idle:undefined},{nativePickerOpen:undefined},{globalSettingsFingerprint:{}},{supported:[42]}]){
    const f=fixture();f.change(invalid as unknown as Partial<NativeDesktopEffortSnapshot>);
    await expect(f.adapter.read()).rejects.toThrow();expect(f.calls).toHaveLength(0);
  }
});
test('turning off during an in-flight auto configuration invalidates its pending consent',async()=>{
  const f=fixture(),host=new DesktopEffortHost(f.now),id=host.register('Owned',f.adapter);
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
  const capture=f.port.capture;f.port.capture=async()=>{started();await gate;return capture();};
  const first=host.manage({operation:'configure',id,expectedRevision:1,mode:'auto',consent:true});await entered;
  await expect(host.manage({operation:'configure',id,expectedRevision:1,mode:'off'})).resolves.toMatchObject({success:true});
  release();await expect(first).rejects.toThrow('동의 상태');expect((await host.manage({operation:'status'})).sessions?.[0]).toMatchObject({revision:2,mode:'off'});
  expect(await host.boundary(id,{requestId:'off_during_config_01',text:'권한 격리 설계',phase:'planning'})).toMatchObject({state:'held'});expect(f.calls).toHaveLength(0);
});
test('off and recommend revoke consent immediately during the adapter final capture',async()=>{
  for(const mode of ['off','recommend'] as const){
    const f=fixture(),host=new DesktopEffortHost(f.now),id=host.register('Owned',f.adapter);
    await host.manage({operation:'configure',id,expectedRevision:1,mode:'auto',consent:true});
    let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
    const capture=f.port.capture;let reads=0;f.port.capture=async()=>{const result=await capture();if(++reads===2){started();await gate;}return result;};
    const pending=host.boundary(id,{requestId:`mode_final_${mode}`,text:'권한 격리 설계',phase:'planning'});await entered;
    await host.manage({operation:'configure',id,expectedRevision:2,mode});
    expect((await host.manage({operation:'status'})).sessions?.[0]).toMatchObject({mode,revision:3,expiresAt:0});
    release();expect(await pending).toMatchObject({state:'held',reason:'native-pre-dispatch-refused'});expect(f.calls).toHaveLength(0);
    if(mode==='recommend')expect(await host.boundary(id,{requestId:'recommend_after_refusal_01',text:'권한 격리 설계',phase:'planning'})).toMatchObject({state:'recommended'});
  }
});
test('an off request from a stale view still revokes the current session',async()=>{
  const f=fixture(),host=new DesktopEffortHost(f.now),id=host.register('Owned',f.adapter);
  await host.manage({operation:'configure',id,expectedRevision:1,mode:'auto',consent:true});
  await host.manage({operation:'configure',id,expectedRevision:1,mode:'off'});
  expect((await host.manage({operation:'status'})).sessions?.[0]).toMatchObject({mode:'off',revision:3,expiresAt:0});
  expect(await host.boundary(id,{requestId:'stale_off_view_01',text:'권한 격리 설계',phase:'planning'})).toMatchObject({state:'held'});expect(f.calls).toHaveLength(0);
});
test('turning off while renewing consent prevents the older renewal from restoring auto',async()=>{
  const f=fixture(),host=new DesktopEffortHost(f.now),id=host.register('Owned',f.adapter);
  await host.manage({operation:'configure',id,expectedRevision:1,mode:'auto',consent:true});
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
  const capture=f.port.capture;f.port.capture=async()=>{started();await gate;return capture();};
  const renewal=host.manage({operation:'configure',id,expectedRevision:2,mode:'auto',consent:true});await entered;
  await host.manage({operation:'configure',id,expectedRevision:2,mode:'off'});release();
  await expect(renewal).rejects.toThrow('동의 상태');
  expect((await host.manage({operation:'status'})).sessions?.[0]).toMatchObject({mode:'off',revision:3,expiresAt:0});
});
test('turning off during asynchronous native setup prevents the eventual dispatch',async()=>{
  const f=fixture(),host=new DesktopEffortHost(f.now),id=host.register('Owned',f.adapter);
  await host.manage({operation:'configure',id,expectedRevision:1,mode:'auto',consent:true});
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
  const mutate=f.port.mutate;f.port.mutate=async(...args)=>{started();await gate;return mutate(...args);};
  const pending=host.boundary(id,{requestId:'off_native_setup_01',text:'권한 격리 설계',phase:'planning'});await entered;
  await host.manage({operation:'configure',id,expectedRevision:2,mode:'off'});release();
  expect(await pending).toMatchObject({state:'held',reason:'native-pre-dispatch-refused'});expect(f.calls).toHaveLength(0);
});
test('turning off after dispatch leaves its result unknown and never replays it',async()=>{
  const f=fixture(),host=new DesktopEffortHost(f.now),id=host.register('Owned',f.adapter);
  await host.manage({operation:'configure',id,expectedRevision:1,mode:'auto',consent:true});
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
  const mutate=f.port.mutate;f.port.mutate=async(...args)=>{const result=await mutate(...args);started();await gate;return result;};
  const input={requestId:'off_after_dispatch_01',text:'권한 격리 설계',phase:'planning' as const};
  const pending=host.boundary(id,input);await entered;await host.manage({operation:'configure',id,expectedRevision:2,mode:'off'});release();
  expect(await pending).toMatchObject({state:'unknown'});expect(await host.boundary(id,input)).toMatchObject({state:'unknown'});expect(f.calls).toHaveLength(1);
});
test('a dispatched uncertain result survives a switch to recommend and cannot be retried as auto',async()=>{
  const f=fixture(),host=new DesktopEffortHost(f.now),id=host.register('Owned',f.adapter);
  await host.manage({operation:'configure',id,expectedRevision:1,mode:'auto',consent:true});
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
  const mutate=f.port.mutate;f.port.mutate=async(...args)=>{const result=await mutate(...args);started();await gate;return result;};
  const input={requestId:'recommend_unknown_01',text:'권한 격리 설계',phase:'planning' as const};
  const pending=host.boundary(id,input);await entered;await host.manage({operation:'configure',id,expectedRevision:2,mode:'recommend'});release();
  expect(await pending).toMatchObject({state:'unknown'});expect(await host.boundary(id,input)).toMatchObject({state:'unknown'});
  expect(await host.boundary(id,{...input,requestId:'recommend_unknown_02'})).toMatchObject({state:'recommended'});
  await expect(host.manage({operation:'configure',id,expectedRevision:3,mode:'auto',consent:true})).rejects.toThrow('결과를 확인하지 못했습니다');
  expect(f.calls).toHaveLength(1);
});
test('a failed old capture does not stop a newly selected recommend mode',async()=>{
  const f=fixture(),host=new DesktopEffortHost(f.now),id=host.register('Owned',f.adapter);
  await host.manage({operation:'configure',id,expectedRevision:1,mode:'auto',consent:true});
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
  f.port.capture=async()=>{started();await gate;throw Error('read failed');};
  const pending=host.boundary(id,{requestId:'recommend_old_read_01',text:'권한 격리 설계',phase:'planning'});await entered;
  await host.manage({operation:'configure',id,expectedRevision:2,mode:'recommend'});release();
  expect(await pending).toMatchObject({state:'held',reason:'native-read-unavailable'});
  expect(await host.boundary(id,{requestId:'recommend_old_read_02',text:'권한 격리 설계',phase:'planning'})).toMatchObject({state:'recommended'});
  expect(f.calls).toHaveLength(0);
});
test('expiry during an in-flight reconfiguration cannot silently restore expired consent',async()=>{
  const f=fixture(),host=new DesktopEffortHost(f.now),id=host.register('Owned',f.adapter);
  await host.manage({operation:'configure',id,expectedRevision:1,mode:'auto',consent:true});
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
  const capture=f.port.capture;f.port.capture=async()=>{started();await gate;return capture();};
  const pending=host.manage({operation:'configure',id,expectedRevision:2,mode:'auto',consent:true});await entered;
  f.time(600001);expect((await host.manage({operation:'status'})).sessions?.[0]).toMatchObject({revision:3,mode:'recommend'});
  release();await expect(pending).rejects.toThrow('동의 상태');
  expect(await host.boundary(id,{requestId:'expiry_race_01',text:'권한 격리 설계',phase:'planning'})).toMatchObject({state:'held'});expect(f.calls).toHaveLength(0);
});
test('a delayed initial consent cannot activate after its original ten-minute window',async()=>{
  const f=fixture(),host=new DesktopEffortHost(f.now),id=host.register('Owned',f.adapter);
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
  const capture=f.port.capture;f.port.capture=async()=>{started();await gate;return capture();};
  const pending=host.manage({operation:'configure',id,expectedRevision:1,mode:'auto',consent:true});await entered;
  f.time(600001);release();await expect(pending).rejects.toThrow('동의 상태');
  expect((await host.manage({operation:'status'})).sessions?.[0]).toMatchObject({revision:1,mode:'recommend',expiresAt:0});
  expect(await host.boundary(id,{requestId:'delayed_consent_01',text:'권한 격리 설계',phase:'planning'})).toMatchObject({state:'held'});expect(f.calls).toHaveLength(0);
});
