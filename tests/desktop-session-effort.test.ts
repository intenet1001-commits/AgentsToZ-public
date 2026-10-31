import {expect,test} from 'bun:test';
import {DesktopSessionEffort,type DesktopEffortReading,type DesktopSessionEffortAdapter} from '../src/desktopSessionEffort';
const binding={adapter:'hermes-desktop',adapterVersion:'pilot-1',sessionId:'exact-session',generation:2,model:'claude-opus-5-5',provider:'anthropic',accountId:'local-account'};
function fixture() {
  let read:DesktopEffortReading={...binding,revision:4,effort:'medium',supported:['low','medium','high','xhigh','max'],idle:true,nativePickerOpen:false,globalSettingsFingerprint:'global-before',otherSessionsFingerprint:'others-before'};
  let writes:any[]=[],fail=false,after:Partial<DesktopEffortReading>={};
  const adapter:DesktopSessionEffortAdapter={binding,capabilities:{sessionOnly:true,compareAndSet:true,effectiveReadback:true},async read(){return {...read};},async set(r){writes.push(r);if(fail)throw Error();read={...read,effort:r.effort,revision:read.revision+1,...after};}};
  const control=new DesktopSessionEffort(adapter);
  return {control,adapter,writes,change:(v:Partial<DesktopEffortReading>)=>{read={...read,...v};},fail:()=>{fail=true;},after:(v:Partial<DesktopEffortReading>)=>{after=v;}};
}
const request=(requestId='effort_request_01',text='보안 권한 격리를 설계하고 검토해줘')=>({requestId,text,phase:'planning' as const});
test('external app auto needs exact session consent; default only recommends',async()=>{
  const f=fixture();expect((await f.control.transition(request())).state).toBe('recommended');expect(f.writes).toHaveLength(0);
  await expect(f.control.configure('auto')).rejects.toThrow('동의');
  await expect(f.control.configure('auto',{consent:{...binding,sessionId:'other'}})).rejects.toThrow();
});
test('auto changes only the bound session using revision/generation and verifies native effect',async()=>{
  const f=fixture();await f.control.configure('auto',{consent:binding});
  expect(await f.control.transition(request())).toMatchObject({state:'applied',before:'medium',requested:'high',after:'high'});
  expect(f.writes).toEqual([{sessionId:binding.sessionId,generation:2,expectedRevision:4,effort:'high',requestId:'effort_request_01'}]);
  await f.control.transition(request());expect(f.writes).toHaveLength(1);
});
test('fixed Max, xhigh minimum, off, active input and unsupported readback never trigger GUI or writes',async()=>{
  for(const options of [{fixed:'max'},{minimum:'xhigh'}]) {
    const f=fixture();await f.control.configure('auto',{consent:binding,...options});expect((await f.control.transition(request())).state).toBe('held');expect(f.writes).toHaveLength(0);
  }
  for(const patch of [{idle:false},{nativePickerOpen:true},{generation:3},{model:'changed'},{supported:['low'] as string[]}]) {
    const f=fixture();await f.control.configure('auto',{consent:binding});f.change(patch);expect((await f.control.transition(request())).state).toBe('held');expect(f.writes).toHaveLength(0);
  }
  const f=fixture();await f.control.configure('auto',{consent:binding});f.adapter.capabilities.effectiveReadback=false;
  expect((await f.control.transition(request())).state).toBe('recommended');expect(f.writes).toHaveLength(0);
});
test('manual change wins at the next boundary and remains held',async()=>{
  const f=fixture();await f.control.configure('auto',{consent:binding});await f.control.transition(request());f.change({effort:'max'});
  expect((await f.control.transition(request('effort_request_02','오타만 수정'))).reason).toBe('manual-change');
  expect((await f.control.transition(request('effort_request_03'))).state).toBe('held');expect(f.writes).toHaveLength(1);
});
test('unknown native outcome is never replayed with either the old or a new ID',async()=>{
  const f=fixture();await f.control.configure('auto',{consent:binding});f.fail();
  expect((await f.control.transition(request())).state).toBe('unknown');
  expect((await f.control.transition(request())).state).toBe('unknown');
  expect((await f.control.transition(request('effort_request_02'))).state).toBe('held');expect(f.writes).toHaveLength(1);
});
test('wire effort, model, account, global defaults and other sessions must all remain bound',async()=>{
  for(const patch of [{effort:'medium'},{model:'other-model'},{accountId:'other-account'},{globalSettingsFingerprint:'changed'},{otherSessionsFingerprint:'changed'}]) {
    const f=fixture();await f.control.configure('auto',{consent:binding});f.after(patch);
    expect((await f.control.transition(request())).state).toBe('unknown');
    expect((await f.control.transition(request('effort_request_02'))).state).toBe('held');expect(f.writes).toHaveLength(1);
  }
});
test('E1: Auto consent keeps the session\'s effective Max or xhigh and never lowers it without explicit allowance',async()=>{
  for(const effort of ['max','xhigh']) {
    const f=fixture();f.change({effort});
    expect(await f.control.configure('auto',{consent:binding})).toEqual({mode:'auto',baseline:effort,preserved:effort});
    expect(await f.control.transition(request('effort_request_01','오타만 수정'))).toMatchObject({state:'held',reason:'preserved-current',requested:'low'});
    expect(await f.control.transition(request('effort_request_02'))).toMatchObject({state:'held',reason:'preserved-current',requested:'high'});
    expect(f.writes).toHaveLength(0);
  }
  const f=fixture();f.change({effort:'high'});
  expect(await f.control.configure('auto',{consent:binding})).toEqual({mode:'auto',baseline:'high'});
  expect(await f.control.transition(request('effort_request_01','오타만 수정'))).toMatchObject({state:'applied',before:'high',after:'low'});
});
test('E1: only an explicit allowance in the consent lets Auto lower a Max session',async()=>{
  const f=fixture();f.change({effort:'max'});
  expect(await f.control.configure('auto',{consent:binding,allowLowering:true})).toEqual({mode:'auto',baseline:'max'});
  expect(await f.control.transition(request('effort_request_01','오타만 수정'))).toMatchObject({state:'applied',before:'max',requested:'low',after:'low'});
  await expect(f.control.configure('auto',{consent:binding,allowLowering:'yes' as unknown as boolean})).rejects.toThrow('낮춤');
});
test('E1: consent fails closed when the effective effort cannot be read; a change after consent stops Auto',async()=>{
  const f=fixture();const read=f.adapter.read;
  f.adapter.read=async()=>{throw Error('native read unavailable');};
  await expect(f.control.configure('auto',{consent:binding})).rejects.toThrow('현재 에포트');
  f.adapter.read=read;
  expect((await f.control.transition(request())).state).toBe('recommended');
  f.change({model:'other-model'});await expect(f.control.configure('auto',{consent:binding})).rejects.toThrow('현재 에포트');
  const g=fixture();await g.control.configure('auto',{consent:binding});g.change({effort:'max'});
  expect(await g.control.transition(request())).toMatchObject({state:'held',reason:'manual-change',before:'max'});
  expect(await g.control.transition(request('effort_request_02','오타만 수정'))).toMatchObject({state:'held'});
  expect(f.writes).toHaveLength(0);expect(g.writes).toHaveLength(0);
});
