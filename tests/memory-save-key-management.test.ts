import {expect,test} from 'bun:test';
import {manageMemorySaveKey} from '../src/memorySaveKeyManagement';
import type {MemorySaveKeyLifecycle} from '../src/memorySaveKeyLifecycle';
import type {WorkspaceLease} from '../src/workspaceLease';
function fixture(){
 const calls:string[]=[];let valid=true,identity:string|null=null;
 const lease={} as WorkspaceLease;
 const deps={enabled:()=>true,resolve:async(id:string)=>{calls.push('resolve:'+id);return {validate:async()=>valid};},
  identity:(create:boolean)=>{calls.push('identity:'+create);if(create)identity='installation';return identity;},
  service:()=>({status:()=>{calls.push('status');return 'registered';},prepare:async(l:WorkspaceLease,validate:()=>Promise<boolean>,recover:boolean)=>{expect(l).toBe(lease);expect(await validate()).toBe(true);calls.push('prepare:'+recover);return 'registered';}} as unknown as MemorySaveKeyLifecycle),
  acquire:async()=>{calls.push('acquire');return lease;},release:()=>{calls.push('release');},
 };
 return {deps,calls,setValid:(value:boolean)=>{valid=value;}};
}
test('read-only status cannot create identity, lease, key or policy',async()=>{
 const f=fixture();expect(await manageMemorySaveKey({keyOperation:'status',observationTargetId:'target-fixture'},f.deps)).toEqual({version:1,targetId:'target-fixture',keyStatus:'not-configured',automaticSavingChanged:false});
 expect(f.calls).toEqual(['resolve:target-fixture','identity:false']);
});
test('only validated local scope reaches explicit preparation and always releases its lease',async()=>{
 for(const op of ['prepare','recover-initial']){const f=fixture();await manageMemorySaveKey({keyOperation:op,observationTargetId:'target-fixture'},f.deps);
  expect(f.calls).toEqual(['resolve:target-fixture','acquire','identity:true','prepare:'+(op==='recover-initial'),'release']);
 }
 const f=fixture();f.deps.acquire=async()=>{f.setValid(false);return {} as WorkspaceLease;};
 await expect(manageMemorySaveKey({keyOperation:'prepare',observationTargetId:'target-fixture'},f.deps)).rejects.toThrow('프로젝트');
 expect(f.calls).toEqual(['resolve:target-fixture','release']);
});
test('caller keys, paths, accounts, mixed status fields and unknown operations fail before any host lookup',async()=>{
 for(const extra of [{key:'secret'},{path:'/private'},{account:'foreign'},{installationId:'foreign'},{offset:0},{enabled:true},{keyOperation:'reset'}]){
  const f=fixture();await expect(manageMemorySaveKey({keyOperation:'prepare',observationTargetId:'target-fixture',...extra},f.deps)).rejects.toThrow('올바르지');expect(f.calls).toHaveLength(0);
 }
});
test('unsupported environments do not invoke OS credentials or resolve a caller target',async()=>{
 const f=fixture();f.deps.enabled=()=>false;
 expect((await manageMemorySaveKey({keyOperation:'prepare',observationTargetId:'target-fixture'},f.deps)).keyStatus).toBe('unsupported');expect(f.calls).toHaveLength(0);
});
