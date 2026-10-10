import {randomUUID, randomBytes, createHash, timingSafeEqual} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, realpathSync, statSync} from 'node:fs';
import {join, dirname, isAbsolute, relative, sep} from 'node:path';
import {withOwnedPortalFileLock} from './portalFileLock';
import {appendDurableProjectMemoryFile, fsyncProjectMemoryDirectory} from './projectMemoryDurability';
import {CONTROL_PROFILE_ALIASES, CONTROL_PROFILE_CORE, CONTROL_PROFILE_MARKER, ControlProfileError, controlProfileId, controlProfileText, type ControlProfileStatus, type ControlProfileSync} from './controlProfileContract';

export type ControlProfileSeed = {schemaVersion:1; profileId:string; memoryId:string; repositoryUrl:string; repositoryNodeId:string};
export type ControlProfileCandidate = {root:string; projectId:string|null; memoryId:string; profileId?:string};
export type ControlMemorySnapshot = {memoryId:string; root:string; document:string; savedAt:string};
export type ControlMemoryProposal = {id:string; requestId:string; title:string; body:string; evidence:string; baseRevision:string; state:'pending'|'saved'|'rejected'; createdAt:string; savedAt?:string};
// legacyRoots: earlier locations of the same Control folder (a rename such as AgentsToZ-Control →
// AgentsToZ-OPS). Optional and additive, so schemaVersion stays 1 and older readers ignore it.
type Binding = {schemaVersion:1; profileId:string; memoryId:string; root:string; projectId:string|null; backend:'control-folder'|'app-data'; state:'preparing'|'ready'; restore:ControlProfileSeed|null; lastProblem:string|null; coordinationPolicy:'agentstoz'|'cs-ceo'; initialRevision?:string;sync?:ControlProfileSync;legacyRoots?:string[]};
export type ControlProfileLocation = {state:'preparing'|'ready';backend:'control-folder'|'app-data';root:string;projectId:string|null;profileId:string;memoryId:string;legacyRoots:readonly string[]};
const MAX_LEGACY_ROOTS=8;
/** History with `previous` appended once; never the current root. */
const withLegacyRoot=(b:Binding,previous:string):string[]=>[...(b.legacyRoots??[]).filter(root=>root!==previous&&root!==b.root),previous].slice(-MAX_LEGACY_ROOTS);
const samePath=(a:string,b:string)=>{if(a===b)return true;try{return realpathSync(a)===realpathSync(b);}catch{return false;}};
type AttachTransition={schemaVersion:1;previousProfileId:string;previousAccessHash:string;next:Binding;nextAccess:{schemaVersion:1;profileId:string;token:string}};
export type ControlProfileDependencies = {
  candidates(): Promise<ControlProfileCandidate[]>;
  seed(): Promise<ControlProfileSeed|null>;
  restore(seed:ControlProfileSeed, currentRoot?:string):Promise<ControlProfileCandidate>;
  initialize(root:string,memoryId:string):Promise<void>;
  snapshot(root:string):ControlMemorySnapshot;
  save(root:string, expectedRevision:string, entry:{id:string;title:string;body:string}):Promise<void>;
  synchronize?(root:string):Promise<ControlProfileSync>;
  register?(candidate:ControlProfileCandidate):Promise<string>;
};
const MAX_STORE_BYTES=1024*1024;
const revisionOf=(document:string)=>createHash('sha256').update(document).digest('hex');
function safeFile(path:string,max=MAX_STORE_BYTES):string|null {
  let st;try{st=lstatSync(path);}catch(e:any){if(e.code==='ENOENT')return null;throw e;}
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>max)throw new ControlProfileError('CONTROL_PROFILE_FILE_INVALID','프로필 파일을 안전하게 읽을 수 없습니다.');
  return readFileSync(path,'utf8');
}
export function readControlProfileSeed(path:string):ControlProfileSeed|null {
  const raw=safeFile(path,4096);if(raw===null)return null;
  const value=JSON.parse(raw);
  if(value.schemaVersion!==1||!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value.repositoryUrl)||typeof value.repositoryNodeId!=='string'||!value.repositoryNodeId||value.repositoryNodeId.length>200)
    throw new ControlProfileError('CONTROL_PROFILE_SEED_INVALID','기존 OPS 운영 폴더 복원 정보를 확인하세요.');
  return {schemaVersion:1,profileId:controlProfileId(value.profileId),memoryId:controlProfileId(value.memoryId),repositoryUrl:value.repositoryUrl,repositoryNodeId:value.repositoryNodeId};
}
function writeJson(path:string,value:unknown){
  if(existsSync(path))safeFile(path);
  const serialized=JSON.stringify(value,null,2)+'\n';
  if(Buffer.byteLength(serialized)>MAX_STORE_BYTES)throw new ControlProfileError('CONTROL_PROFILE_QUEUE_FULL','프로필 기록 크기 한도에 도달했습니다. 기존 후보를 검토하세요.');
  const temp=`${path}.${randomUUID()}.tmp`;
  try{appendDurableProjectMemoryFile(temp,serialized);renameSync(temp,path);fsyncProjectMemoryDirectory(dirname(path));}
  finally{try{unlinkSync(temp);}catch{}}
}
export function controlProfileAccessPath(appData:string){return join(appData,'control-profile','access.json');}
export function readControlProfileAccess(appData:string):{profileId:string;token:string}|null {
  const path=controlProfileAccessPath(appData),raw=safeFile(path,4096);if(raw===null)return null;
  const st=lstatSync(path);
  if(process.platform!=='win32'&&((st.mode&0o077)!==0||st.uid!==process.getuid?.()))throw new ControlProfileError('CONTROL_PROFILE_ACCESS_INVALID','이 OS 사용자의 프로필 연결 권한을 확인하세요.');
  const data=JSON.parse(raw);
  if(data.schemaVersion!==1||typeof data.token!=='string'||!/^[a-f0-9]{64}$/.test(data.token))throw new ControlProfileError('CONTROL_PROFILE_ACCESS_INVALID','프로필 연결 권한이 올바르지 않습니다.');
  return {profileId:controlProfileId(data.profileId),token:data.token};
}
export class ControlProfileStore {
  readonly directory:string;
  private running:Promise<ControlProfileStatus>|null=null;
  private lastProblem:string|null=null;
  private syncing:Promise<ControlProfileStatus>|null=null;
  constructor(readonly appData:string,private deps:ControlProfileDependencies){this.directory=join(appData,'control-profile');}
  private ensureDirectory(){
    mkdirSync(this.directory,{recursive:true,mode:0o700});
    const st=lstatSync(this.directory);
    if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&st.uid!==process.getuid?.()))throw new ControlProfileError('CONTROL_PROFILE_DIRECTORY_INVALID','프로필 저장 위치를 확인하세요.');
  }
  private path(name:string){return join(this.directory,name);}
  private binding():Binding|null{
    const raw=safeFile(this.path('binding.json'),16*1024);if(raw===null)return null;
    const b=JSON.parse(raw) as Binding;
    if(b.schemaVersion!==1||!isAbsolute(b.root)||!['control-folder','app-data'].includes(b.backend)||!['preparing','ready'].includes(b.state)||!['agentstoz','cs-ceo'].includes(b.coordinationPolicy))throw new ControlProfileError('CONTROL_PROFILE_BINDING_INVALID','기존 프로필 연결을 확인하세요.');
    if(b.legacyRoots!==undefined&&(!Array.isArray(b.legacyRoots)||b.legacyRoots.length>MAX_LEGACY_ROOTS||b.legacyRoots.some(root=>typeof root!=='string'||!isAbsolute(root))))throw new ControlProfileError('CONTROL_PROFILE_BINDING_INVALID','기존 프로필 연결을 확인하세요.');
    controlProfileId(b.profileId);controlProfileId(b.memoryId);return b;
  }
  private proposals():ControlMemoryProposal[]{
    const raw=safeFile(this.path('proposals.json'));if(raw===null)return [];
    const value=JSON.parse(raw);
    if(value.schemaVersion!==1||!Array.isArray(value.items)||value.items.length>500)throw new ControlProfileError('CONTROL_PROFILE_PROPOSALS_INVALID','운영 기억 후보 기록을 확인하세요.');
    return value.items;
  }
  private snapshot(b:Binding){
    const value=this.deps.snapshot(b.root);
    if(value.memoryId!==b.memoryId||realpathSync(value.root)!==realpathSync(b.root))throw new ControlProfileError('CONTROL_PROFILE_MEMORY_MISMATCH','연결된 OPS 운영 기억이 변경되었습니다. 기존 연결을 확인하세요.');
    if(Buffer.byteLength(value.document)>1024*1024)throw new ControlProfileError('CONTROL_PROFILE_MEMORY_TOO_LARGE','운영 기억 크기를 검토하세요.');
    return value;
  }
  /**
   * 바인딩에 적힌 프로젝트 id **하나만**. `status()`는 운영 기억 문서 전체를 읽고 sha256 까지 하며
   * 후보 목록(최대 1MB)을 파싱하는데, id 하나가 필요한 호출자가 그것을 부르면 USE 요청마다 그 비용이
   * 세 번씩 붙는다(2026-10-06 감사: resolve_target 1회 = status() 3회 = 동기 spawn 21회).
   * 값은 `status().projectId`와 같다 — 그 필드는 ready 검사 **앞에서** 채워지기 때문이다.
   */
  boundProjectId():string|null{
    try{return this.binding()?.projectId??null;}catch{return null;}
  }
  /**
   * 공유 총괄 프로필 id만 — 대화·제어 폴링이 매 틱 부르는 경로용. `status()`는 운영 기억 문서 전체를 읽고
   * 후보 목록까지 파싱해서, 0.6초마다 도는 제어 우편함 폴에 붙으면 사이드카를 반복해서 멈춘다(2026-10-06 감사).
   * 판정 조건은 status()의 ready·control-folder·연결 키 일치와 같고, 문서 스냅샷만 건너뛴다.
   */
  sharedProfileId():string|null{
    try{
      const b=this.binding();
      if(!b||b.state!=='ready'||b.backend!=='control-folder')return null;
      const access=readControlProfileAccess(this.appData);
      return access&&access.profileId===b.profileId?b.profileId:null;
    }catch{return null;}
  }
  status():ControlProfileStatus {
    const empty:ControlProfileStatus={state:this.running?'preparing':'unprepared',profileId:null,memoryId:null,displayName:'AgentsToZ',aliases:CONTROL_PROFILE_ALIASES,projectId:null,revision:null,lastSavedAt:null,problem:this.lastProblem,pendingCount:0,backend:null,coordinationPolicy:'agentstoz'};
    try{
      const b=this.binding();if(!b)return {...empty,state:this.lastProblem?'needs-attention':empty.state};
      const result={...empty,profileId:b.profileId,memoryId:b.memoryId,projectId:b.projectId,backend:b.backend,coordinationPolicy:'agentstoz' as const,sync:b.sync,pendingCount:this.proposals().filter(p=>p.state==='pending').length};
      if(b.state!=='ready')return {...result,state:this.running&&!this.lastProblem?'preparing':'needs-attention',problem:this.lastProblem??b.lastProblem??'프로필 준비를 이어서 완료하세요.'};
      const snapshot=this.snapshot(b),access=readControlProfileAccess(this.appData);
      if(!access||access.profileId!==b.profileId)throw new ControlProfileError('CONTROL_PROFILE_ACCESS_MISSING','프로필 연결 키가 없습니다. 연결 상태를 확인하세요.');
      return {...result,state:'ready',revision:revisionOf(snapshot.document),lastSavedAt:snapshot.savedAt,problem:this.lastProblem??b.lastProblem};
    }catch(e){return {...empty,state:'needs-attention',problem:e instanceof ControlProfileError?e.message:'프로필 상태를 읽지 못했습니다. 기존 파일을 확인하세요.'};}
  }
  async prepare(selectedProjectId?:string):Promise<ControlProfileStatus>{
    if(this.running)return this.running;
    this.ensureDirectory();
    this.running=withOwnedPortalFileLock(this.path('prepare.lock'),async()=>{
      this.resumeAttach();
      let b=this.binding();
      if(selectedProjectId!==undefined&&(typeof selectedProjectId!=='string'||!selectedProjectId||selectedProjectId.length>200))throw new ControlProfileError('CONTROL_PROFILE_CANDIDATE_MISSING','등록된 OPS 운영 폴더를 선택하세요.');
      if(b&&selectedProjectId&&b.projectId!==selectedProjectId)throw new ControlProfileError('CONTROL_PROFILE_ALREADY_BOUND','기존 프로필 준비를 먼저 완료하세요.');
      if(!b){
        const seed=await this.deps.seed();
        const candidates=await this.deps.candidates();
        const eligible=seed?candidates.filter(c=>c.memoryId===seed.memoryId):candidates;
        const matching=selectedProjectId?eligible.filter(c=>c.projectId===selectedProjectId):eligible;
        if(selectedProjectId&&matching.length!==1)throw new ControlProfileError('CONTROL_PROFILE_CANDIDATE_MISSING','원래 프로필과 일치하는 OPS 운영 폴더를 선택하세요.');
        if(matching.length>1)throw new ControlProfileError('CONTROL_PROFILE_AMBIGUOUS','OPS 운영 폴더 후보가 여러 개입니다. 기존 프로필을 선택해 연결하세요.');
        const candidate=matching[0];
        b={schemaVersion:1,profileId:seed?.profileId??candidate?.profileId??candidate?.memoryId??randomUUID(),memoryId:seed?.memoryId??candidate?.memoryId??randomUUID(),root:candidate?.root??join(this.directory,'memory'),projectId:candidate?.projectId??null,backend:candidate||seed?'control-folder':'app-data',state:'preparing',restore:seed,lastProblem:null,coordinationPolicy:'agentstoz'};
        controlProfileId(b.profileId);controlProfileId(b.memoryId);
        writeJson(this.path('binding.json'),b);
      }
      if(b.restore){
        const restored=await this.deps.restore(b.restore,b.backend==='control-folder'&&b.root!==join(this.directory,'memory')?b.root:undefined);
        if(restored.memoryId!==b.memoryId)throw new ControlProfileError('CONTROL_PROFILE_MEMORY_MISMATCH','복원한 기억 ID가 원래 OPS 운영 폴더와 다릅니다.');
        b.root=restored.root;b.projectId=restored.projectId;b.restore=null;b.sync={state:'current',lastCheckedAt:new Date().toISOString(),problem:null};writeJson(this.path('binding.json'),b);
      }else if(b.backend==='app-data'){
        mkdirSync(b.root,{recursive:true,mode:0o700});await this.deps.initialize(b.root,b.memoryId);
      }else if(!existsSync(b.root)){
        const candidates=(await this.deps.candidates()).filter(c=>c.memoryId===b!.memoryId);
        if(candidates.length!==1)throw new ControlProfileError('CONTROL_PROFILE_LOCATION_MISSING','기존 OPS 운영 폴더 위치를 찾지 못했습니다. 새 기억을 만들지 않았습니다.');
        // The folder moved (a rename such as AgentsToZ-Control → AgentsToZ-OPS whose relocation did
        // not run). Keep where it was: records made there stay attributable only through legacyRoots.
        const previous=b.root;
        b.root=candidates[0]!.root;b.projectId=candidates[0]!.projectId;
        if(previous!==b.root)b.legacyRoots=withLegacyRoot(b,previous);
      }
      const preparedSnapshot=this.snapshot(b);
      if(b.state==='preparing'&&!b.initialRevision)b.initialRevision=revisionOf(preparedSnapshot.document);
      if(b.backend==='control-folder'){
        const marker=join(b.root,CONTROL_PROFILE_MARKER),raw=safeFile(marker,4096);
        if(raw){const value=JSON.parse(raw);if(value.schemaVersion!==1||value.profileId!==b.profileId||value.memoryId!==b.memoryId)throw new ControlProfileError('CONTROL_PROFILE_MARKER_MISMATCH','OPS 운영 폴더의 프로필 표식이 기존 연결과 다릅니다.');}
        else writeJson(marker,{schemaVersion:1,profileId:b.profileId,memoryId:b.memoryId});
        if(!b.projectId&&this.deps.register)b.projectId=await this.deps.register({root:b.root,memoryId:b.memoryId,projectId:null,profileId:b.profileId});
      }
      const access=readControlProfileAccess(this.appData);
      if(access&&access.profileId!==b.profileId)throw new ControlProfileError('CONTROL_PROFILE_ACCESS_MISMATCH','다른 프로필의 연결 키가 남아 있습니다.');
      if(!access){
        if(b.state==='ready')throw new ControlProfileError('CONTROL_PROFILE_ACCESS_MISSING','기존 연결 키가 없습니다. 자동으로 재발급하지 않았습니다.');
        writeJson(controlProfileAccessPath(this.appData),{schemaVersion:1,profileId:b.profileId,token:randomBytes(32).toString('hex')});
      }
      b.state='ready';b.lastProblem=null;writeJson(this.path('binding.json'),b);this.lastProblem=null;return this.status();
    },{attempts:1,label:'AgentsToZ Control profile'}).catch(e=>{
      this.lastProblem=e instanceof ControlProfileError?e.message:'아젠투지 준비를 완료하지 못했습니다. 연결·폴더 상태를 확인한 뒤 다시 시도하세요.';
      return this.status();
    }).finally(()=>{this.running=null;});
    return this.running;
  }
  authorize(token:string|null):boolean{
    try{const access=readControlProfileAccess(this.appData),b=this.binding();return !!access&&b?.state==='ready'&&access.profileId===b.profileId&&!!token&&token.length===64&&timingSafeEqual(Buffer.from(token),Buffer.from(access.token));}catch{return false;}
  }
  read(){const status=this.status();if(status.state!=='ready')throw new ControlProfileError('CONTROL_PROFILE_NOT_READY',status.problem??'먼저 AgentsToZ 프로필을 준비하세요.');const b=this.binding()!;return {binding:b,snapshot:this.snapshot(b),status};}
  /** The stored location for startup maintenance. Read-only; null when absent or unreadable (never throws). */
  boundLocation():ControlProfileLocation|null{
    try{const b=this.binding();return b?{state:b.state,backend:b.backend,root:b.root,projectId:b.projectId,profileId:b.profileId,memoryId:b.memoryId,legacyRoots:[...(b.legacyRoots??[])]}:null;}catch{return null;}
  }
  /**
   * Follow a Control folder that was renamed on disk (AgentsToZ-Control → AgentsToZ-OPS).
   * The identity never moves: profile, memory and access key stay. Only `root` changes, after
   * the new path proves the same profile (marker) and memory; the old root is kept in
   * `legacyRoots`. Idempotent: a binding already at `to` only gains `from` in its history, once, and
   * only when the folder there still proves the same profile (preparation may have re-found the
   * moved folder first, and an older app did that without keeping the old root).
   */
  async relocate(from:string,to:string):Promise<ControlProfileStatus>{
    if(typeof from!=='string'||typeof to!=='string'||!isAbsolute(from)||!isAbsolute(to)||from===to)throw new ControlProfileError('CONTROL_PROFILE_RELOCATE_INVALID','옮길 운영 폴더 경로를 확인하세요.',400);
    this.ensureDirectory();
    return withOwnedPortalFileLock(this.path('prepare.lock'),async()=>{
      if(existsSync(this.path('attach-transition.json')))throw new ControlProfileError('CONTROL_PROFILE_ATTACH_PENDING','중단된 프로필 연결을 먼저 마무리하세요.');
      const b=this.binding();
      if(!b||b.backend!=='control-folder')throw new ControlProfileError('CONTROL_PROFILE_RELOCATE_INVALID','연결된 OPS 운영 폴더가 없습니다.');
      const proven=(root:string)=>{
        const raw=safeFile(join(root,CONTROL_PROFILE_MARKER),4096);
        if(!raw)throw new ControlProfileError('CONTROL_PROFILE_MARKER_MISSING','옮긴 OPS 운영 폴더에서 프로필 표식을 찾지 못했습니다.');
        const marker=JSON.parse(raw);
        if(marker.schemaVersion!==1||marker.profileId!==b.profileId||marker.memoryId!==b.memoryId)throw new ControlProfileError('CONTROL_PROFILE_MARKER_MISMATCH','OPS 운영 폴더의 프로필 표식이 기존 연결과 다릅니다.');
      };
      if(samePath(b.root,to)){
        if(b.legacyRoots?.includes(from))return this.status();
        try{proven(b.root);this.snapshot(b);}catch{return this.status();}
        writeJson(this.path('binding.json'),{...b,legacyRoots:withLegacyRoot(b,from)});
        return this.status();
      }
      if(b.root!==from)throw new ControlProfileError('CONTROL_PROFILE_RELOCATE_CHANGED','OPS 운영 폴더 연결이 이미 바뀌었습니다. 연결 상태를 확인하세요.');
      proven(to);
      const next:Binding={...b,root:to,legacyRoots:withLegacyRoot({...b,root:to},from)};
      this.snapshot(next);
      writeJson(this.path('binding.json'),next);
      return this.status();
    },{attempts:1});
  }
  context(){const {status}=this.read();return {...status,core:CONTROL_PROFILE_CORE};}
  protectsSharedRoot(root:unknown):boolean{
    if(typeof root!=='string'||!isAbsolute(root))return false;
    try{
      let cursor=realpathSync(root);if(statSync(cursor).isFile())cursor=dirname(cursor);
      for(let depth=0;depth<128;depth+=1){
        if(existsSync(join(cursor,CONTROL_PROFILE_MARKER)))return true;
        const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;
      }
    }catch{}
    try{
      const b=this.binding();if(b?.backend!=='control-folder')return false;
      const from=realpathSync(b.root),to=realpathSync(root),child=relative(from,to);
      return child===''||(!isAbsolute(child)&&child!=='..'&&!child.startsWith(`..${sep}`));
    }catch{return false;}
  }
  proposalByRequest(requestId:string){return this.proposals().find(p=>p.requestId===requestId)??null;}
  pending(){return this.proposals().filter(p=>p.state==='pending');}
  private async saveProposal(binding:Binding,snapshot:ControlMemorySnapshot,status:ControlProfileStatus,proposal:ControlMemoryProposal,expectedRevision:string){
    const entryId=createHash('sha256').update(`${binding.profileId}:${proposal.id}`).digest('hex').slice(0,24);
    const marker=`<!-- memory-entry-id:${entryId} -->`;
    if(!snapshot.document.includes(marker)){
      // The reviewer must have seen the current memory. A candidate written against an older
      // revision may still be saved by that human decision: saving appends one entry with a
      // stable id, so it overwrites nothing and never duplicates itself. Requiring the base to
      // match left every candidate unsaveable after any later save, with no way to re-propose
      // from the phone (three candidates stuck on 2026-09-26).
      if(expectedRevision!==status.revision)throw new ControlProfileError('CONTROL_PROFILE_REVISION_CHANGED','운영 기억이 방금 바뀌었습니다. 후보 목록을 다시 불러온 뒤 결정하세요.');
      await this.deps.save(binding.root,status.revision!,{id:entryId,title:proposal.title,body:proposal.body});
    }
    proposal.state='saved';proposal.savedAt=new Date().toISOString();
  }
  async propose(input:{requestId:unknown;title:unknown;body:unknown;evidence:unknown;expectedRevision:unknown}){
    const requestId=controlProfileText(input.requestId,200),title=controlProfileText(input.title,200),body=controlProfileText(input.body,4000),evidence=controlProfileText(input.evidence,1000);
    return withOwnedPortalFileLock(this.path('prepare.lock'),async()=>{
      const {binding,snapshot,status}=this.read(),items=this.proposals(),old=items.find(p=>p.requestId===requestId);
      if(old){
        if(old.title!==title||old.body!==body||old.evidence!==evidence||old.baseRevision!==input.expectedRevision)throw new ControlProfileError('CONTROL_PROFILE_REQUEST_CONFLICT','같은 요청 ID에 다른 기억을 제출할 수 없습니다.');
        if(old.state==='pending'&&binding.backend==='app-data'){await this.saveProposal(binding,snapshot,status,old,status.revision!);writeJson(this.path('proposals.json'),{schemaVersion:1,items});}
        return old;
      }
      if(input.expectedRevision!==status.revision)throw new ControlProfileError('CONTROL_PROFILE_REVISION_CHANGED','운영 기억이 변경되었습니다. 다시 회상한 뒤 제안하세요.');
      if(items.length>=500||items.filter(p=>p.state==='pending').length>=100)throw new ControlProfileError('CONTROL_PROFILE_QUEUE_FULL','기존 운영 기억 후보를 먼저 검토하세요.');
      const proposal:ControlMemoryProposal={id:randomUUID(),requestId,title,body,evidence,baseRevision:status.revision!,state:'pending',createdAt:new Date().toISOString()};
      // A local-only app-data profile is not a shared document. It therefore has
      // no second human/backup boundary and can commit the user's explicit memory
      // request immediately. A connected Control folder always remains pending.
      if(binding.backend==='app-data')await this.saveProposal(binding,snapshot,status,proposal,status.revision!);
      writeJson(this.path('proposals.json'),{schemaVersion:1,items:[...items,proposal]});return proposal;
    },{attempts:1});
  }
  async review(id:string,accept:boolean,expectedRevision:string){
    return withOwnedPortalFileLock(this.path('prepare.lock'),async()=>{
      const {binding,snapshot,status}=this.read(),items=this.proposals(),proposal=items.find(p=>p.id===id);
      if(!proposal)throw new ControlProfileError('CONTROL_PROFILE_PROPOSAL_MISSING','운영 기억 후보를 다시 조회하세요.');
      if(proposal.state!=='pending')return proposal;
      if(accept)await this.saveProposal(binding,snapshot,status,proposal,expectedRevision);
      else proposal.state='rejected';
      writeJson(this.path('proposals.json'),{schemaVersion:1,items});return proposal;
    },{attempts:1});
  }
  async availableControls(){return (await this.deps.candidates()).map(c=>({projectId:c.projectId,memoryId:c.memoryId}));}
  async attach(projectId:string,expectedProfileId:string){
    return withOwnedPortalFileLock(this.path('prepare.lock'),async()=>{
      const {binding:old,status,snapshot}=this.read();
      if(old.profileId!==expectedProfileId)throw new ControlProfileError('CONTROL_PROFILE_CHANGED','현재 프로필을 다시 확인하세요.');
      if(old.projectId===projectId)return status;
      if(old.backend!=='app-data'||old.initialRevision!==revisionOf(snapshot.document)||this.proposals().length>0)
        throw new ControlProfileError('CONTROL_PROFILE_HAS_MEMORY','현재 운영 기억이 있습니다. 기존 기억을 합칠지 먼저 검토해야 하므로 연결을 바꾸지 않았습니다.');
      const matches=(await this.deps.candidates()).filter(c=>c.projectId===projectId);
      if(matches.length!==1)throw new ControlProfileError('CONTROL_PROFILE_CANDIDATE_MISSING','등록된 OPS 운영 폴더를 다시 확인하세요.');
      const candidate=matches[0]!,profileId=controlProfileId(candidate.profileId??candidate.memoryId);
      const next:Binding={...old,profileId,memoryId:candidate.memoryId,root:candidate.root,projectId,backend:'control-folder',state:'preparing',restore:null,lastProblem:null,initialRevision:undefined};
      const memory=this.snapshot(next);next.initialRevision=revisionOf(memory.document);
      const access=readControlProfileAccess(this.appData)!;
      writeJson(this.path(`previous-${old.profileId}.json`),old);
      const transition:AttachTransition={schemaVersion:1,previousProfileId:old.profileId,previousAccessHash:revisionOf(access.token),next,nextAccess:{schemaVersion:1,profileId,token:randomBytes(32).toString('hex')}};
      writeJson(this.path('attach-transition.json'),transition);
      this.resumeAttach();return this.status();
    },{attempts:1});
  }
  private resumeAttach(){
    const path=this.path('attach-transition.json'),raw=safeFile(path,32*1024);if(!raw)return;
    const t=JSON.parse(raw) as AttachTransition,b=this.binding(),access=readControlProfileAccess(this.appData);
    if(t.schemaVersion!==1||!b||!access||t.next.state!=='preparing'||t.next.backend!=='control-folder'||!isAbsolute(t.next.root)||t.nextAccess.profileId!==t.next.profileId||!/^[a-f0-9]{64}$/.test(t.nextAccess.token))
      throw new ControlProfileError('CONTROL_PROFILE_ATTACH_INVALID','중단된 프로필 연결 기록을 확인하세요.');
    controlProfileId(t.next.profileId);controlProfileId(t.next.memoryId);
    const oldAccess=access.profileId===t.previousProfileId&&revisionOf(access.token)===t.previousAccessHash;
    const newAccess=access.profileId===t.next.profileId&&access.token===t.nextAccess.token;
    const targetBinding=b.profileId===t.next.profileId&&b.memoryId===t.next.memoryId&&b.root===t.next.root;
    if((b.profileId!==t.previousProfileId&&!targetBinding)||(!oldAccess&&!newAccess))throw new ControlProfileError('CONTROL_PROFILE_ATTACH_CHANGED','중단 이후 프로필 연결이 변경되었습니다. 기록을 확인하세요.');
    this.snapshot(t.next);
    const marker=join(t.next.root,CONTROL_PROFILE_MARKER),markerRaw=safeFile(marker,4096);
    if(markerRaw){const value=JSON.parse(markerRaw);if(value.schemaVersion!==1||value.profileId!==t.next.profileId||value.memoryId!==t.next.memoryId)throw new ControlProfileError('CONTROL_PROFILE_MARKER_MISMATCH','OPS 운영 폴더의 프로필 표식이 기존 연결과 다릅니다.');}
    else writeJson(marker,{schemaVersion:1,profileId:t.next.profileId,memoryId:t.next.memoryId});
    if(!(targetBinding&&newAccess&&b.state==='ready')){
      writeJson(this.path('binding.json'),t.next);
      writeJson(controlProfileAccessPath(this.appData),t.nextAccess);
      writeJson(this.path('binding.json'),{...t.next,state:'ready'});
    }
    unlinkSync(path);fsyncProjectMemoryDirectory(this.directory);
  }
  async synchronize(force=false):Promise<ControlProfileStatus>{
    if(this.syncing)return this.syncing;
    const current=this.read();
    if(!this.deps.synchronize)return current.status;
    const checked=current.binding.sync?.lastCheckedAt;
    if(!force&&checked&&Date.now()-Date.parse(checked)<60_000)return current.status;
    this.syncing=withOwnedPortalFileLock(this.path('prepare.lock'),async()=>{
      const {binding}=this.read();
      binding.sync=await this.deps.synchronize!(binding.root);
      this.snapshot(binding);writeJson(this.path('binding.json'),binding);return this.status();
    },{attempts:1}).finally(()=>{this.syncing=null;});
    return this.syncing;
  }
  async setPolicy(policy:'agentstoz'|'cs-ceo'){
    if(policy!=='agentstoz')throw new ControlProfileError('CONTROL_PROFILE_POLICY_INVALID','AgentsToZ OPS 기본 운영만 지원합니다.',400);
    return withOwnedPortalFileLock(this.path('prepare.lock'),async()=>{const {binding}=this.read();binding.coordinationPolicy=policy;writeJson(this.path('binding.json'),binding);return this.status();},{attempts:1});
  }
}
export {revisionOf as controlMemoryRevision};
