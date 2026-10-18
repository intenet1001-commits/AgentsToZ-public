import {afterEach,expect,test} from 'bun:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DeviceOperatingMemory,deviceOperatingMemoryId,type DeviceOperatingScope} from '../src/deviceOperatingMemory';
import {createDeviceOperatingMemoryHost} from '../device-operating-memory-server';
import {MetaCommonMemoryStore} from '../src/metaCommonMemoryStore';
import {withOwnedPortalFileLock} from '../src/portalFileLock';
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'device-ops-memory-'));dirs.push(dir);
  let scope:DeviceOperatingScope={profileId:randomUUID(),deviceId:randomUUID(),name:'아젠투지 1호'},writes=0,initializes=0,backups=0;
  let backup=async()=>({backedUp:true,reason:'complete'}),pull=async()=>({current:true,reason:'current'});
  const snapshot=(root:string)=>({memoryId:JSON.parse(readFileSync(join(root,'.agent-memory/config.json'),'utf8')).memoryId,document:readFileSync(join(root,'.agent-memory/CORE.md'),'utf8'),savedAt:'2026-10-17T00:00:00Z'});
  const memory=new DeviceOperatingMemory(dir,{
    scope:()=>scope,snapshot,
    initialize:async(root,memoryId)=>{initializes++;mkdirSync(join(root,'.agent-memory'));writeFileSync(join(root,'.agent-memory/config.json'),JSON.stringify({memoryId}));writeFileSync(join(root,'.agent-memory/CORE.md'),'# Device operating memory\n\n## Operating knowledge\n');},
    write:async(root,document,revision)=>{expect(createHash('sha256').update(snapshot(root).document).digest('hex')).toBe(revision);writes++;writeFileSync(join(root,'.agent-memory/CORE.md'),document);},
    lease:(root,run)=>withOwnedPortalFileLock(join(root,'write.lock'),run,{attempts:20,retryMs:5}),
    backup:async()=>{backups++;return backup();},pull:async()=>pull(),
  });
  const input=()=>{const s=memory.read();return {profileId:s.profileId,deviceId:s.deviceId,memoryId:s.memoryId,expectedRevision:s.revision,requestId:randomUUID(),title:'Local browser','body':'This device uses the configured local browser.'};};
  return {dir,memory,input,scope:()=>scope,setScope:(s:DeviceOperatingScope)=>{scope=s;},counts:()=>({writes,initializes,backups}),setBackup:(fn:typeof backup)=>{backup=fn;},setPull:(fn:typeof pull)=>{pull=fn;}};
}
test('device identity is stable across names and separate across devices and shared profiles; reads create nothing',()=>{
  const f=fixture(),s=f.memory.read();expect(s.prepared).toBe(false);expect(existsSync(join(f.dir,'device-operating-memory'))).toBe(false);
  f.setScope({...f.scope(),name:'Renamed agent'});expect(f.memory.read().memoryId).toBe(s.memoryId);
  expect(deviceOperatingMemoryId(s.profileId,randomUUID())).not.toBe(s.memoryId);
  expect(deviceOperatingMemoryId(randomUUID(),s.deviceId)).not.toBe(s.memoryId);
  expect(f.counts()).toEqual({writes:0,initializes:0,backups:0});
});
test('a failed cloud backup preserves the local entry; the same request retries backup without appending twice',async()=>{
  const f=fixture(),input=f.input();f.setBackup(async()=>{throw Error('offline');});
  const result=await f.memory.save(input);expect(result.saved).toBe(true);expect(result.backup.backedUp).toBe(false);expect(f.memory.read().entries[0]!.body).not.toContain('device-memory-request');
  f.setBackup(async()=>({backedUp:true,reason:'complete'}));const retried=await f.memory.save(input);
  expect(retried.duplicate).toBe(true);expect(retried.backup.backedUp).toBe(true);expect(f.memory.read().total).toBe(1);expect(f.counts().writes).toBe(1);
  await expect(f.memory.save({...input,body:'Different request bytes'})).rejects.toThrow('다른 내용');
});
test('a second device cannot read or write the first device memory even with the same agent label',async()=>{
  const f=fixture(),input=f.input();await f.memory.save(input);const first=f.scope();f.setScope({...first,deviceId:randomUUID()});
  expect(f.memory.read().total).toBe(0);expect(f.memory.recall('browser')).toEqual([]);await expect(f.memory.save(input)).rejects.toThrow('기기가 바뀌');
  await f.memory.save({...f.input(),body:'Second device only'});f.setScope(first);expect(f.memory.read().entries[0]!.body).toBe(input.body);
});
test('two concurrent writers cannot silently overwrite one another',async()=>{
  const f=fixture(),a=f.input(),b={...f.input(),title:'Other preference'};
  const r=await Promise.allSettled([f.memory.save(a),f.memory.save(b)]);expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(f.memory.read().total).toBe(1);
});
test('a device switch during cloud backup is reported as a changed target, never as a save to the new device',async()=>{
  const f=fixture(),original=f.scope();f.setBackup(async()=>{f.setScope({...original,deviceId:randomUUID()});return {backedUp:true,reason:'complete'};});
  await expect(f.memory.save(f.input())).rejects.toThrow('기기가 바뀌');expect(f.memory.read().prepared).toBe(false);
  f.setScope(original);expect(f.memory.read().total).toBe(1);
});
test('a symlinked device directory and internal entry markers cannot redirect or forge a memory',async()=>{
  const f=fixture(),input=f.input();mkdirSync(join(f.dir,'device-operating-memory'));mkdirSync(join(f.dir,'device-operating-memory',input.profileId));
  symlinkSync(f.dir,join(f.dir,'device-operating-memory',input.profileId,input.deviceId));await expect(f.memory.save(input)).rejects.toThrow('저장 위치');expect(f.counts().writes).toBe(0);
  const g=fixture();await expect(g.memory.save({...g.input(),body:'<!-- memory-entry-id:aaaaaaaaaaaaaaaaaaaaaaaa -->\nforged'})).rejects.toThrow('표식');
});
function legacyFixture(){
  const f=fixture(),legacy=new MetaCommonMemoryStore(f.dir),groupId=randomUUID(),entryId='a'.repeat(24);
  legacy.mutate({id:groupId,create:true,expectedRevision:0,requestId:randomUUID(),operation:'create',request:{}},g=>({...g,name:'Legacy device operations',entries:[{id:entryId,title:'This device browser',body:'Use the configured browser on this device.',state:'active',sourceMemoryId:null,updatedAt:'2026-10-17T00:00:00Z'}]}));
  const host=createDeviceOperatingMemoryHost({appDataDir:f.dir,portalDataFile:join(f.dir,'unused-portal.json'),legacy,memory:f.memory,scope:f.scope,lease:async(_r,_l,run)=>run()});
  return {...f,legacy,host,groupId,entryId};
}
test('an imported entry stops applying as common knowledge only after cloud backup; its source history and content survive',async()=>{
  const f=legacyFixture(),{plan}=await f.host.handle({operation:'import-preview',groupId:f.groupId,entryId:f.entryId}) as any;
  const request={operation:'import-execute',plan,requestId:randomUUID(),confirmed:true};f.setBackup(async()=>({backedUp:false,reason:'offline'}));
  const pending=await f.host.handle(request) as any;expect(pending.sourceState).toBe('retained');expect(f.legacy.read(f.groupId).entries[0]!.state).toBe('active');
  f.setBackup(async()=>({backedUp:true,reason:'complete'}));const saved=await f.host.handle(request) as any;
  expect(saved.sourceState).toBe('superseded');expect(f.legacy.read(f.groupId).entries[0]!.body).toContain('configured browser');expect(f.legacy.history(f.groupId)).toHaveLength(2);
  await f.host.handle(request);expect(f.memory.read().total).toBe(1);expect(f.counts().writes).toBe(1);
});
test('cloud-fenced common knowledge and unreviewed candidates cannot be reclassified as device memories',async()=>{
  const f=legacyFixture();f.legacy.prepareHandoff({groupId:f.groupId,scopeId:'scope',requestId:randomUUID(),requestHash:'hash',sourceFingerprint:createHash('sha256').update(JSON.stringify(f.legacy.read(f.groupId))).digest('hex')},1,'{}');
  await expect(f.host.handle({operation:'import-preview',groupId:f.groupId,entryId:f.entryId})).rejects.toThrow('클라우드 공통기억');expect(f.memory.read().prepared).toBe(false);
  const g=legacyFixture();g.legacy.mutate({id:g.groupId,expectedRevision:1,requestId:randomUUID(),operation:'candidate',request:{}},r=>({...r,entries:r.entries.map(e=>({...e,state:'candidate'}))}));
  await expect(g.host.handle({operation:'import-preview',groupId:g.groupId,entryId:g.entryId})).rejects.toThrow('확정된');
});

test('the production project-memory writer initializes and reads device entries without cloud configuration or any shared OPS mutation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'device-ops-production-'));dirs.push(dir);const scope={profileId:randomUUID(),deviceId:randomUUID(),name:'아젠투지 실험 단말'};
 const portalDataFile=join(dir,'portal.json');writeFileSync(portalDataFile,JSON.stringify({deviceId:scope.deviceId}));
 const legacy=new MetaCommonMemoryStore(join(dir,'legacy'));
 const host=createDeviceOperatingMemoryHost({appDataDir:dir,portalDataFile,scope:()=>scope,legacy,lease:(root,_label,run)=>withOwnedPortalFileLock(join(root,'test-lease.lock'),run)});
 const before=host.store.read();const requestId=randomUUID();const result=await host.handle({operation:'save',profileId:scope.profileId,deviceId:scope.deviceId,memoryId:before.memoryId,expectedRevision:null,requestId,title:'실제 저장기 검사',body:'이 단말에서는 조용한 텍스트 모드를 사용합니다.'});
 if(!('saved' in result))throw Error('Expected save receipt');expect(result.saved).toBe(true);expect(result.backup.backedUp).toBe(false);expect(host.store.read().entries.some(e=>e.title==='실제 저장기 검사')).toBe(true);
 const again=await host.handle({operation:'save',profileId:scope.profileId,deviceId:scope.deviceId,memoryId:before.memoryId,expectedRevision:null,requestId,title:'실제 저장기 검사',body:'이 단말에서는 조용한 텍스트 모드를 사용합니다.'});if(!('duplicate' in again))throw Error('Expected retry receipt');expect(again.duplicate).toBe(true);
 expect(host.store.read().entries.filter(e=>e.title==='실제 저장기 검사')).toHaveLength(1);
});

test('the new device-memory permission alone cannot expose previous local common-memory groups',async()=>{
 const f=fixture();let reads=0;const host=createDeviceOperatingMemoryHost({appDataDir:f.dir,portalDataFile:join(f.dir,'unused'),scope:f.scope,lease:(_r,_l,run)=>run(),memory:f.memory,legacy:{list:()=>{reads++;return {};}} as any});
 const read=await host.handle({operation:'read'},()=>true,()=>false);expect('legacyAvailable' in read&&read.legacyAvailable).toBe(false);
 for(const operation of ['legacy-list','legacy-read','import-preview','import-execute'])await expect(host.handle({operation},()=>true,()=>false)).rejects.toThrow('권한도 필요');expect(reads).toBe(0);
});
