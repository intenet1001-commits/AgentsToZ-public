import {mkdirSync,existsSync,readFileSync,lstatSync,realpathSync,renameSync,statSync} from 'node:fs';
import {join,dirname,basename,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ControlProfileStore,readControlProfileSeed,controlMemoryRevision,type ControlProfileCandidate,type ControlProfileSeed} from './src/controlProfileStore';
import {CONTROL_PROFILE_PRIVATE_PATH,CONTROL_PROFILE_MARKER,ControlProfileError} from './src/controlProfileContract';
import {detectProjectMemory,detectProjectMemoryIdentity,initializeProjectMemory,readMemoryDocument,writeMemoryDocument,pullProjectMemory,pushProjectMemory,runWithTimeout} from './project-memory-server';
import {recallProjectMemoryEntries} from './src/projectMemoryRecall';
import {isAgentsToZControlProject} from './buzz-agent-bootstrap-server';
import {LEGACY_OPS_FOLDER_NAMES,OPS_FOLDER_NAME,isOpsFolderName} from './src/opsFolderName';
import {PINNED_REPOSITORY_KEY_CONFIG,canonicalProjectRepositoryKey,pinnedProjectRepositoryKey} from './src/projectMemoryIdentity';
import {gitHubRepositoryPath} from './src/githubUrls';

type Registration={id:string;name?:string;folderPath?:string;worktreePath?:string};
export type ControlProfileHostOptions={
 appDataDir:string;portalDataFile:string;gitPath:string;ghPath:string;
 registered():Promise<Registration[]>;
 register(candidate:ControlProfileCandidate):Promise<string>;
 lease<T>(root:string,label:string,operation:()=>Promise<T>):Promise<T>;
 command?: (argv:string[],cwd:string,timeout:number)=>Promise<{stdout:string;exitCode:number}>;
 pullMemory?: typeof pullProjectMemory;
};
export function createControlProfileHost(options:ControlProfileHostOptions){
 let seedParent:string|null=null;
 const snapshot=(root:string)=>{
  const memory=detectProjectMemory(root);
  if(!memory.exists||!memory.config||!memory.memoryPath)throw new ControlProfileError('CONTROL_PROFILE_MEMORY_MISSING','연결된 운영 기억 파일을 찾지 못했습니다.');
  return {root:memory.projectRoot,memoryId:memory.config.memoryId,document:readMemoryDocument(memory.projectRoot,memory.memoryPath),savedAt:statSync(memory.memoryPath).mtime.toISOString()};
 };
 const command=async(argv:string[],cwd:string,timeout=15_000)=>{
  const result=options.command ? await options.command(argv,cwd,timeout) : await runWithTimeout(argv,cwd,timeout,undefined,{maxOutputBytes:64*1024});
  if(result.exitCode!==0)throw new ControlProfileError('CONTROL_PROFILE_GITHUB_UNAVAILABLE','OPS 운영 폴더 저장소에 접근하지 못했습니다. GitHub 로그인과 연결 상태를 확인하세요.');
  return result.stdout.trim();
 };
 // ⚠️ 복원 seed를 **폴더 이름으로 고르지 않는다.** 예전에는 디스크 basename이
 // `/^AgentsToZ_(?:byCS|public)$/i`인 등록 폴더만 봤는데, 다른 이름으로 clone한 앱 소스
 // (`AgentsToZ_byCS-win`, 워크트리 등)는 seed를 찾지 못해 **조용히 새 profileId**가 생겼다 —
 // 그 Mac은 자기만의 운영 프로필·커뮤니티 방을 들고 고아가 된다(2호 실측, 2026-10-05).
 // 신뢰 경계는 이름이 아니라 **내용**이다: `isAgentsToZControlProject`가 package.json의
 // `name === "AgentsToZ_byCS"` + `api-server.ts` + `src/App.tsx`를 함께 확인하므로, 등록된
 // 아무 폴더의 seed 파일을 읽는 일은 여전히 없다. 서로 다른 profileId가 둘 이상이면 아래에서
 // 멈춘다 — 그 판정이 이름 제한이 하던 역할을 대신한다.
 const seed=async()=>{
  const registrations=await options.registered(),seeds:Array<{seed:ControlProfileSeed;root:string}>=[];
  for(const r of registrations){
   if(!r.folderPath||!isAbsolute(r.folderPath))continue;
   if(!isAgentsToZControlProject({canonicalPath:r.folderPath} as any))continue;
   const path=join(r.folderPath,CONTROL_PROFILE_PRIVATE_PATH);
   const value=readControlProfileSeed(path);if(value)seeds.push({seed:value,root:dirname(realpathSync(r.folderPath))});
  }
  if(seeds.length>1&&new Set(seeds.map(s=>s.seed.profileId)).size>1)throw new ControlProfileError('CONTROL_PROFILE_SEED_AMBIGUOUS','등록된 앱 소스에 서로 다른 OPS 운영 폴더 복원 정보가 있습니다.');
  seedParent=seeds[0]?.root??null;return seeds[0]?.seed??null;
 };
 const candidates=async()=>{
  const result:ControlProfileCandidate[]=[],seen=new Set<string>();
  let boundProjectId:string|null=null;
  try {const path=join(options.appDataDir,'control-profile','binding.json');if(lstatSync(path).size<16384)boundProjectId=JSON.parse(readFileSync(path,'utf8')).projectId;}catch{}
  for(const r of await options.registered()){
   const root=r.folderPath;if(!root||!isAbsolute(root))continue;
   // Either OPS folder name: this Mac may still hold the legacy AgentsToZ-Control until it migrates.
   const eligible=isOpsFolderName(r.name)||isOpsFolderName(basename(root))||r.id===boundProjectId;
   if(!eligible||!existsSync(root))continue;
   const memory=await detectProjectMemoryIdentity(root);if(!memory.config?.memoryId)throw new ControlProfileError('CONTROL_PROFILE_MEMORY_MISSING','기존 OPS 운영 폴더 등록에 기억 파일이 없습니다. 복원을 먼저 확인하세요.');
   const canonical=realpathSync(memory.projectRoot);if(seen.has(canonical))continue;seen.add(canonical);
   let profileId:string|undefined;const marker=join(canonical,CONTROL_PROFILE_MARKER);
   if(existsSync(marker)){
    const st=lstatSync(marker);if(!st.isFile()||st.isSymbolicLink()||st.size>4096)throw new ControlProfileError('CONTROL_PROFILE_MARKER_INVALID','OPS 운영 폴더의 프로필 표식을 확인하세요.');
    const value=JSON.parse(readFileSync(marker,'utf8'));
    if(value.schemaVersion!==1||value.memoryId!==memory.config.memoryId)throw new ControlProfileError('CONTROL_PROFILE_MARKER_MISMATCH','OPS 운영 폴더의 프로필 표식과 기억 ID가 다릅니다.');profileId=value.profileId;
   }else if(!existsSync(join(canonical,'CONTROL.md')))continue;
   result.push({root:canonical,memoryId:memory.config.memoryId,projectId:r.id,profileId});
  }
  return result;
 };
 const restore=async(s:ControlProfileSeed,currentRoot?:string):Promise<ControlProfileCandidate>=>{
  // The seed is portable metadata from a registered source checkout, never an AI-supplied path/URL.
  if(!seedParent)await seed();
  if(!seedParent&&!currentRoot)throw new ControlProfileError('CONTROL_PROFILE_ROOT_REQUIRED','OPS 운영 폴더를 복원할 앱 소스 또는 작업 위치를 확인하세요.');
  const parent=currentRoot?dirname(currentRoot):seedParent!;
  const repository=gitHubRepositoryPath(s.repositoryUrl)!;
  const remote=JSON.parse(await command([options.ghPath,'repo','view',repository,'--json','id,visibility,url'],parent));
  if(remote.id!==s.repositoryNodeId||remote.visibility!=='PRIVATE')throw new ControlProfileError('CONTROL_PROFILE_REPOSITORY_MISMATCH','원래 Private OPS 저장소의 정체성이 일치하지 않습니다.');
  // The seed keeps the URL the repository was created with. GitHub renamed AgentsToZ-Control to
  // AgentsToZ-OPS in place, so an origin is the same repository when it is the seed URL, the URL
  // GitHub reports for the verified node id, or any GitHub URL that resolves to that node id.
  const seedKey=canonicalProjectRepositoryKey(s.repositoryUrl),renamedKey=canonicalProjectRepositoryKey(typeof remote.url==='string'?remote.url:null);
  const sameRepository=async(origin:string|null,cwd:string)=>{
   const key=canonicalProjectRepositoryKey(origin);if(!key)return false;
   if(key===seedKey||key===renamedKey)return true;
   const path=gitHubRepositoryPath(origin);if(!path)return false;
   try{return JSON.parse(await command([options.ghPath,'repo','view',path,'--json','id'],cwd)).id===s.repositoryNodeId;}catch{return false;}
  };
  const originOf=async(root:string)=>{try{return await command([options.gitPath,'remote','get-url','origin'],root);}catch{return null;}};
  let target=currentRoot;
  if(!target){
   // Reuse a clone that is already here: the new folder, or one an older app restored under the legacy
   // name (the boot migration renames it later). A folder with another repository or memory is never adopted.
   for(const name of [OPS_FOLDER_NAME,...LEGACY_OPS_FOLDER_NAMES]){
    const candidate=join(parent,name);if(!existsSync(candidate))continue;
    try{
     if(!await sameRepository(await originOf(candidate),candidate))continue;
     const memory=await detectProjectMemoryIdentity(candidate);
     if(!memory.config||memory.config.memoryId===s.memoryId){target=candidate;break;}
    }catch{/* an unreadable folder is not a reusable clone */}
   }
   target??=join(parent,OPS_FOLDER_NAME);
  }
  const destination=target;
  await options.lease(parent,'Control restoration parent',async()=>{
   if(!existsSync(destination)){
    const staging=join(parent,`.agentstoz-control-restore-${randomUUID()}`);
    // Fixed HTTPS origin; disable hooks during the bounded checkout. Incomplete staging is retained for diagnosis.
    await command([options.gitPath,'-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','-c','protocol.ext.allow=never','clone','--',s.repositoryUrl,staging],parent,120_000);
    const cloned=await detectProjectMemoryIdentity(staging);
    if(cloned.config&&cloned.config.memoryId!==s.memoryId)throw new ControlProfileError('CONTROL_PROFILE_MEMORY_MISMATCH','복제된 기억 ID가 기존 OPS 운영 폴더와 다릅니다. 복제물을 분리 보관했습니다.');
    if(existsSync(destination))throw new ControlProfileError('CONTROL_PROFILE_DESTINATION_CHANGED','복원 중 목적지 폴더가 생겼습니다. 기존 폴더를 확인하세요.');
    renameSync(staging,destination);
   }
  });
  return options.lease(destination,'Control memory restore',async()=>{
   const origin=await originOf(destination);
   if(!await sameRepository(origin,destination))throw new ControlProfileError('CONTROL_PROFILE_REPOSITORY_MISMATCH','기존 폴더가 다른 저장소에 연결되어 있습니다.');
   // An origin that already follows the rename would present a new repository key for this memory
   // lineage. Pin the key it was created under, exactly as the boot migration does, unless pinned.
   if(seedKey&&canonicalProjectRepositoryKey(origin)!==seedKey){
    let pinned:string|null=null;try{pinned=await command([options.gitPath,'config','--local','--get',PINNED_REPOSITORY_KEY_CONFIG],destination);}catch{}
    if(!pinnedProjectRepositoryKey(pinned))await command([options.gitPath,'config','--local',PINNED_REPOSITORY_KEY_CONFIG,seedKey],destination);
   }
   const memory=detectProjectMemory(destination);
   if(memory.config&&memory.config.memoryId!==s.memoryId)throw new ControlProfileError('CONTROL_PROFILE_MEMORY_MISMATCH','기존 폴더의 기억 ID가 다릅니다. 덮어쓰지 않았습니다.');
   if(!memory.config)initializeProjectMemory({folderPath:destination,projectName:'AgentsToZ',memoryId:s.memoryId,agent:'codex',autoBackup:true});
   // Pull performs lineage/conflict checks. A failed or missing backup is never replaced by a new Push.
   const pulled=await (options.pullMemory??pullProjectMemory)({folderPath:destination,portalDataFile:options.portalDataFile,githubUrl:s.repositoryUrl,projectName:OPS_FOLDER_NAME});
   if(pulled.success!==true)throw new ControlProfileError('CONTROL_PROFILE_RESTORE_CONFLICT','로컬과 원격 운영 기억이 다릅니다. 기존 기억 충돌을 검토한 뒤 복원을 계속하세요.');
   const restored=snapshot(destination);if(restored.memoryId!==s.memoryId)throw new ControlProfileError('CONTROL_PROFILE_MEMORY_MISMATCH','원격 기억의 정체성이 다릅니다.');
   const candidate={root:restored.root,memoryId:s.memoryId,projectId:null,profileId:s.profileId};
   const projectId=await options.register(candidate);return {...candidate,projectId};
  });
 };
 const store=new ControlProfileStore(options.appDataDir,{
  candidates,seed,restore,snapshot,register:options.register,
  synchronize:async(root)=>{
   const memory=detectProjectMemory(root),lastCheckedAt=new Date().toISOString();
   if(!memory.config?.autoBackup)return {state:'not-configured',lastCheckedAt,problem:null};
   try{
    const result=await options.lease(root,'Control memory refresh',()=> (options.pullMemory??pullProjectMemory)({folderPath:root,portalDataFile:options.portalDataFile,projectName:'AgentsToZ'}));
    return result.success===true?{state:'current',lastCheckedAt,problem:null}:{state:'needs-attention',lastCheckedAt,problem:'로컬과 원격 운영 기억이 다릅니다. 장기기억의 충돌 검토에서 확인하세요.'};
   }catch{return {state:'needs-attention',lastCheckedAt,problem:'원격 운영 기억을 확인하지 못했습니다. 로컬 기억은 유지됩니다. 연결 후 다시 확인하세요.'};}
  },
  initialize:async(root,memoryId)=>options.lease(root,'Control local memory preparation',async()=>{
   const old=detectProjectMemory(root);
   if(old.config){if(old.config.memoryId!==memoryId)throw new ControlProfileError('CONTROL_PROFILE_MEMORY_MISMATCH','기존 프로필 기억을 확인하세요.');return;}
   initializeProjectMemory({folderPath:root,projectName:'AgentsToZ',memoryId,agent:'codex',autoBackup:false});
  }),
  save:async(root,expectedRevision,entry)=>options.lease(root,'Control memory review',async()=>{
   const memory=detectProjectMemory(root),current=snapshot(root);
   if(controlMemoryRevision(current.document)!==expectedRevision)throw new ControlProfileError('CONTROL_PROFILE_REVISION_CHANGED','저장 직전에 기억이 변경되었습니다. 다시 확인하세요.');
   const heading=entry.title.replace(/[\r\n\u0000-\u001f]/g,' ').replace(/^#+\s*/,''),body=entry.body;
   if(/<!--\s*memory-entry-id:/i.test(body))throw new ControlProfileError('CONTROL_PROFILE_ENTRY_INVALID','기억 후보 본문에 내부 항목 ID를 넣을 수 없습니다.');
   const section='## AgentsToZ 운영 결정',addition=`\n\n### ${heading}\n<!-- memory-entry-id:${entry.id} -->\n\n${body}\n`;
   const index=current.document.indexOf(`\n${section}\n`),nextSection=index<0?-1:current.document.indexOf('\n## ',index+section.length+2);
   const updated=index<0?`${current.document.trimEnd()}\n\n${section}${addition}`:nextSection<0?current.document.trimEnd()+addition:current.document.slice(0,nextSection).trimEnd()+addition+current.document.slice(nextSection);
   writeMemoryDocument(memory.projectRoot,memory.memoryPath!,updated);
  }),
 });
 const recall=(query:string)=>{
  const {status,snapshot}=store.read();
  let bytes=0;const hits=[];
  for(const hit of recallProjectMemoryEntries(snapshot.document,query,{limit:8})){
   const dto={entryId:hit.entryId,title:hit.title,body:hit.body,scope:'operating',revision:status.revision,updatedAt:status.lastSavedAt};
   const size=Buffer.byteLength(JSON.stringify(dto));if(bytes+size>16*1024)break;bytes+=size;hits.push(dto);
  }
  return {profile:store.context(),hits,bytes,scope:'operating',projectMemoryIncluded:false};
 };
 const backup=async()=>{
  const {binding}=store.read();const memory=detectProjectMemory(binding.root);
  if(!memory.config?.autoBackup)return {backedUp:false,reason:'not-configured'};
  try{const result=await options.lease(binding.root,'Control memory backup',()=>pushProjectMemory({folderPath:binding.root,portalDataFile:options.portalDataFile,projectName:'AgentsToZ'}));return {backedUp:result.backupComplete===true,reason:result.backupComplete?'complete':'pending'};}
  catch{return {backedUp:false,reason:'needs-attention'};}
 };
 const prepare=async(projectId?:string)=>{const wasReady=store.status().state==='ready';const result=await store.prepare(projectId);return result.state==='ready'?store.synchronize(wasReady):result;};
 return {store,recall,backup,prepare};
}
