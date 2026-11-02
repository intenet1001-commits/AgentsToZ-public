import {expect,test} from 'bun:test';
import {CommunityMobileRuntime} from '../src/communityMobileRuntime';

test('an unenrolled receiver stays unsupported and uses the same Native instance after human enrollment',async()=>{
  let supported=false,created=0,starts=0,closed=0;
  const runtime=new CommunityMobileRuntime(()=>{created++;return {identity:{ended:false,close(){closed++;}},host:{start:async()=>{starts++;},close(){closed++;},status:()=>({phase:supported?'ready' as const:'unsupported' as const,closed:false,pendingHandshakes:0,activeChannels:0,purposes:[]})}};});
  await runtime.refresh();expect(runtime.status().phase).toBe('unsupported');supported=true;await runtime.refresh();expect(runtime.status().phase).toBe('ready');expect(created).toBe(1);expect(starts).toBe(1);expect(closed).toBe(0);runtime.close();
});
test('a fenced lineage is closed before replacement and concurrent refresh creates only one new receiver',async()=>{
  const events:string[]=[],identities:{ended:boolean;close():void}[]=[];
  const runtime=new CommunityMobileRuntime(()=>{const n=identities.length,identity={ended:false,close(){events.push('identity-close'+n);}};identities.push(identity);events.push('create'+n);
    return {identity,host:{start:async()=>{events.push('start'+n);},close(){events.push('host-close'+n);},status:()=>({phase:'unsupported' as const,closed:false,pendingHandshakes:0,activeChannels:0,purposes:[]})}};
  });
  await runtime.refresh();identities[0]!.ended=true;await Promise.all([runtime.refresh(),runtime.refresh(),runtime.refresh()]);
  expect(events).toEqual(['create0','start0','host-close0','identity-close0','create1','start1']);runtime.close();await runtime.refresh();expect(identities).toHaveLength(2);expect(events.slice(-2)).toEqual(['host-close1','identity-close1']);
});
test('shutdown during asynchronous receiver preparation leaves it closed and never creates another lineage',async()=>{
  let release!:()=>void,created=0,closed=0;const waiting=new Promise<void>(resolve=>{release=resolve;});
  const runtime=new CommunityMobileRuntime(()=>{created++;return {identity:{ended:false,close(){}},host:{start:()=>waiting,close(){closed++;},status:()=>({phase:'closed' as const,closed:true,pendingHandshakes:0,activeChannels:0,purposes:[]})}};});
  const pending=runtime.refresh();runtime.close();release();await pending;await runtime.refresh();expect(created).toBe(1);expect(closed).toBe(1);expect(runtime.status().closed).toBe(true);
});
