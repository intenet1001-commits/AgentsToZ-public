import {createHash} from 'node:crypto';
import {ControlProfileError,controlProfileId} from './src/controlProfileContract';
import {DeviceOperatingMemory,type DeviceOperatingScope} from './src/deviceOperatingMemory';
import {type MetaCommonMemoryStore} from './src/metaCommonMemoryStore';
import {captureProjectMemoryBackupGuard,detectProjectMemory,initializeProjectMemory,pullProjectMemory,pushProjectMemory,readProjectMemorySnapshot,writeMemoryDocument} from './project-memory-server';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid=():never=>{throw new ControlProfileError('DEVICE_MEMORY_INPUT_INVALID','이 기기의 기억 요청을 확인하세요.',400);};
export function createDeviceOperatingMemoryHost(options:{
  appDataDir:string;portalDataFile:string;scope():DeviceOperatingScope;
  lease<T>(root:string,label:string,run:()=>Promise<T>):Promise<T>;
  legacy:MetaCommonMemoryStore;
  memory?:DeviceOperatingMemory;
}){
  const makeStore=(assertActive:()=>void=()=>{})=>new DeviceOperatingMemory(options.appDataDir,{
    scope:()=>{assertActive();return options.scope();},
    snapshot:root=>{const s=readProjectMemorySnapshot(root);return {memoryId:s.memoryId,document:s.document,savedAt:s.savedAt};},
    initialize:async(root,memoryId,name)=>{
      assertActive();
      initializeProjectMemory({folderPath:root,projectName:`${name} · 기기 운영기억`,memoryId,agent:'codex',autoBackup:true});
    },
    write:async(root,document,expectedRevision)=>{
      assertActive();
      const s=readProjectMemorySnapshot(root);
      if(createHash('sha256').update(s.document).digest('hex')!==expectedRevision)throw new ControlProfileError('DEVICE_MEMORY_REVISION_CHANGED','저장 직전에 기억이 변경되었습니다.');
      const identity=detectProjectMemory(root);if(!identity.memoryPath)throw new ControlProfileError('DEVICE_MEMORY_PREPARE_FAILED','기억 문서를 확인하세요.');
      writeMemoryDocument(root,identity.memoryPath,document);
    },
    backup:async(root,memoryId)=>options.lease(root,'Device OPS memory backup',async()=>{
      assertActive();
      const guard=captureProjectMemoryBackupGuard({folderPath:root,portalDataFile:options.portalDataFile});
      if(guard.memoryId!==memoryId)throw new ControlProfileError('DEVICE_MEMORY_IDENTITY_CHANGED','이 기기의 기억 식별자가 변경되었습니다.');
      const result=await pushProjectMemory({folderPath:root,portalDataFile:options.portalDataFile,projectName:`${options.scope().name} · 기기 운영기억`,expectedBackup:guard});
      return {backedUp:result.backupComplete===true,reason:result.backupComplete?'complete':'pending'};
    }),
    pull:async(root,memoryId)=>{
      const result=await pullProjectMemory({folderPath:root,portalDataFile:options.portalDataFile,expectedMemoryId:memoryId,assertActive,projectName:`${options.scope().name} · 기기 운영기억`});
      return {current:result.success===true,reason:result.success?'current':'needs-attention'};
    },
    lease:(root,run)=>options.lease(root,'Device OPS memory write',run),
  });
  const store=options.memory??makeStore();
  const source=(groupId:string,entryId:string)=>{
    // A cloud-owned group is shared knowledge. Never reclassify it as a device memory.
    if(options.legacy.handoff(groupId))throw new ControlProfileError('DEVICE_MEMORY_SHARED_SOURCE','이미 클라우드 공통기억으로 이관된 자료입니다. 공통기억에서 관리하세요.');
    const group=options.legacy.read(groupId),entry=group.entries.find(e=>e.id===entryId);
    if(group.archived||!entry||entry.state!=='active')throw new ControlProfileError('DEVICE_MEMORY_SOURCE_UNAVAILABLE','확정된 이전 로컬 기억만 선택하세요. 후보·충돌·보관 항목은 이동하지 않습니다.');
    return {group,entry};
  };
  const preview=(groupId:string,entryId:string)=>{
    const {group,entry}=source(groupId,entryId),target=store.read();
    return {target:{profileId:target.profileId,deviceId:target.deviceId,memoryId:target.memoryId,name:target.name},expectedRevision:target.revision,
      source:{groupId:group.id,entryId:entry.id,revision:group.revision,fingerprint:digest({groupId:group.id,revision:group.revision,entry}),name:group.name,title:entry.title,body:entry.body},originalPreserved:true};
  };
  const handle=async(raw:unknown,active:()=>boolean=()=>true,canImport:()=>boolean=()=>true)=>{
    const assertActive=()=>{if(!active())throw new ControlProfileError('DEVICE_MEMORY_PERMISSION_CHANGED','기기 운영기억 권한이 변경되었습니다.',403);};
    assertActive();const store=options.memory??makeStore(assertActive);
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Buffer.byteLength(JSON.stringify(raw))>32000)invalid();
    const b=raw as Record<string,any>,operation=b.operation;
    const legacyOperation=['legacy-list','legacy-read','import-preview','import-execute'].includes(operation);
    const assertLegacy=()=>{assertActive();if(legacyOperation&&!canImport())throw new ControlProfileError('DEVICE_MEMORY_LEGACY_PERMISSION_REQUIRED','이전 로컬 기억 이관에는 기존 로컬 공통기억 조회·관리 권한도 필요합니다.',403);};assertLegacy();
    const allowed:Record<string,string[]>={read:['offset'],'legacy-list':['offset'],'legacy-read':['groupId'],save:['profileId','deviceId','memoryId','requestId','expectedRevision','title','body'],sync:[], 'import-preview':['groupId','entryId'],'import-execute':['plan','requestId','confirmed']};
    if(!Object.hasOwn(allowed,operation)||Object.keys(b).some(k=>k!=='operation'&&!allowed[operation]!.includes(k)))invalid();
    if(operation==='read')return {memory:store.read(b.offset??0),legacyAvailable:canImport()};
    if(operation==='legacy-list'){if(!Number.isSafeInteger(b.offset??0)||(b.offset??0)<0||(b.offset??0)>10000)invalid();return options.legacy.list('',b.offset??0,{unfencedOnly:true});}
    if(operation==='legacy-read'){if(typeof b.groupId!=='string'||options.legacy.handoff(b.groupId))throw new ControlProfileError('DEVICE_MEMORY_SHARED_SOURCE','클라우드 공통기억에서 관리하세요.');const group=options.legacy.read(b.groupId);return {memory:{id:group.id,name:group.name,revision:group.revision,entries:group.entries.filter(e=>e.state==='active').map(e=>({id:e.id,title:e.title}))}};}
    if(operation==='save')return store.save({profileId:b.profileId,deviceId:b.deviceId,memoryId:b.memoryId,requestId:b.requestId,expectedRevision:b.expectedRevision,title:b.title,body:b.body});
    if(operation==='sync')return store.synchronize();
    if(operation==='import-preview'){
      if(typeof b.groupId!=='string'||typeof b.entryId!=='string')invalid();
      return {plan:preview(b.groupId,b.entryId)};
    }
    if(b.confirmed!==true||!b.plan?.source||!b.plan.target)invalid();
    controlProfileId(b.requestId);
    const sourceRequest={operation:'move-to-device-operating-memory',plan:b.plan};
    const replay=options.legacy.replay(b.plan.source.groupId,b.requestId,sourceRequest);
    const plan=replay?b.plan:preview(b.plan.source.groupId,b.plan.source.entryId);
    if(Object.keys(b.plan).some(k=>!['target','expectedRevision','source','originalPreserved'].includes(k))||b.plan.originalPreserved!==true||digest(plan.source)!==digest(b.plan.source)||digest(plan.target)!==digest(b.plan.target)||b.plan.expectedRevision!==null&&typeof b.plan.expectedRevision!=='string')throw new ControlProfileError('DEVICE_MEMORY_IMPORT_CHANGED','출처 또는 대상 기억이 바뀌었습니다. 이관 계획을 다시 검토하세요.');
    const result=await store.save({...plan.target,requestId:b.requestId,expectedRevision:b.plan.expectedRevision,title:plan.source.title,
      body:`${plan.source.body}\n\n출처: 이전 로컬 기억 ${plan.source.name} · ${plan.source.groupId}/${plan.source.entryId} · 리비전 ${plan.source.revision}`});
    let sourceState=replay?'superseded':'retained';
    if(!replay&&result.backup.backedUp){
      try{
        assertLegacy();
        options.legacy.mutate({id:plan.source.groupId,expectedRevision:plan.source.revision,requestId:b.requestId,operation:'move-to-device-operating-memory',request:sourceRequest},group=>({...group,entries:group.entries.map(e=>e.id===plan.source.entryId?{...e,state:'superseded' as const}:e)}));
        sourceState='superseded';
      }catch{sourceState='retained-needs-review';}
    }
    return {...result,originalPreserved:true,sourceState};
  };
  return {store,handle};
}
