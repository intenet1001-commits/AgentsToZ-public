import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {ControlProfileError,controlProfileId,controlProfileText} from './controlProfileContract';
import {parseProjectMemoryEntries,recallProjectMemoryEntries} from './projectMemoryRecall';

export interface DeviceOperatingScope {profileId:string;deviceId:string;name:string}
export interface DeviceOperatingSnapshot {memoryId:string;document:string;savedAt:string}
export interface DeviceOperatingMemoryDeps {
  /** Host-owned identity, re-read before every effect. Never taken from a phone or an AI. */
  scope():DeviceOperatingScope;
  initialize(root:string,memoryId:string,name:string):Promise<void>;
  snapshot(root:string):DeviceOperatingSnapshot;
  write(root:string,document:string,expectedRevision:string):Promise<void>;
  backup(root:string,memoryId:string):Promise<{backedUp:boolean;reason:string}>;
  pull?(root:string,memoryId:string):Promise<{current:boolean;reason:string}>;
  lease<T>(root:string,run:()=>Promise<T>):Promise<T>;
}
export interface DeviceOperatingTarget {profileId:string;deviceId:string;memoryId:string}
export interface DeviceOperatingSave extends DeviceOperatingTarget {
  requestId:string;expectedRevision:string|null;title:string;body:string;
}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const visibleBody=(body:string)=>body.replace(/<!-- device-memory-request:[^>]+ -->\s*/g,'').trim();
const fail=(code:string,message:string):never=>{throw new ControlProfileError(code,message);};

/** A child memory identity. The shared OPS profile and its repository lineage are never replaced. */
export function deviceOperatingMemoryId(profileId:string,deviceId:string):string {
  const bytes=createHash('sha256').update(JSON.stringify(['agentstoz-device-memory-v1',controlProfileId(profileId),controlProfileId(deviceId)])).digest().subarray(0,16);
  bytes[6]=(bytes[6]!&15)|0x80;bytes[8]=(bytes[8]!&63)|0x80;
  const id=bytes.toString('hex');return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

export class DeviceOperatingMemory {
  constructor(private appData:string,private deps:DeviceOperatingMemoryDeps){}
  private target(){
    const scope=this.deps.scope(),profileId=controlProfileId(scope.profileId),deviceId=controlProfileId(scope.deviceId);
    return {profileId,deviceId,memoryId:deviceOperatingMemoryId(profileId,deviceId),name:controlProfileText(scope.name,160)};
  }
  private root(target:DeviceOperatingTarget,create=false){
    // Check every owned path component rather than following a symlink in a device subdirectory.
    const parts=[this.appData,'device-operating-memory',target.profileId,target.deviceId];let root='';
    for(let i=0;i<parts.length;i++){
      root=i===0?parts[i]!:join(root,parts[i]!);
      if(!existsSync(root)){if(!create)return null;mkdirSync(root,{mode:0o700});}
      const st=lstatSync(root);
      if(!st.isDirectory()||st.isSymbolicLink()||process.platform!=='win32'&&st.uid!==process.getuid?.())fail('DEVICE_MEMORY_STORAGE_UNSAFE','이 기기의 운영 기억 저장 위치를 확인하세요.');
    }
    return realpathSync(root);
  }
  private check(expected:DeviceOperatingTarget){
    const now=this.target();
    if(expected.profileId!==now.profileId||expected.deviceId!==now.deviceId||expected.memoryId!==now.memoryId)fail('DEVICE_MEMORY_TARGET_CHANGED','아젠투지 또는 기기가 바뀌었습니다. 현재 기기의 기억을 다시 확인하세요.');
    return now;
  }
  private readAt(target:ReturnType<DeviceOperatingMemory['target']>){
    const root=this.root(target);
    if(!root||!existsSync(join(root,'.agent-memory','config.json')))return {root,snapshot:null,revision:null};
    const snapshot=this.deps.snapshot(root);
    if(snapshot.memoryId!==target.memoryId)fail('DEVICE_MEMORY_IDENTITY_CHANGED','이 기기의 기억 식별자가 다릅니다. 기존 기억을 보존했습니다.');
    if(Buffer.byteLength(snapshot.document)>1024*1024)fail('DEVICE_MEMORY_TOO_LARGE','이 기기의 운영 기억 크기를 검토하세요.');
    return {root,snapshot,revision:hash(snapshot.document)};
  }
  /** Read-only, including the unprepared state: no directory, key, model or cloud request. */
  read(offset=0){
    if(!Number.isSafeInteger(offset)||offset<0||offset>10000)fail('DEVICE_MEMORY_INPUT_INVALID','기억 목록 위치를 확인하세요.');
    const target=this.target(),{snapshot,revision}=this.readAt(target);
    const all=snapshot?parseProjectMemoryEntries(snapshot.document).reverse():[];
    const entries=all.slice(offset,offset+8).map(e=>({entryId:e.entryId,title:e.title,body:visibleBody(e.body)}));
    return {...target,prepared:!!snapshot,revision,savedAt:snapshot?.savedAt??null,entries,total:all.length,offset,nextOffset:offset+8<all.length?offset+8:null};
  }
  recall(query:string){
    const target=this.target(),{snapshot,revision}=this.readAt(target);
    return !snapshot?[]:recallProjectMemoryEntries(snapshot.document,query,{limit:4}).map(e=>({entryId:e.entryId,title:e.title,body:visibleBody(e.body),scope:'device-operating',deviceId:target.deviceId,memoryId:target.memoryId,revision,updatedAt:snapshot.savedAt}));
  }
  async save(input:DeviceOperatingSave){
    const target=this.check(input),requestId=controlProfileId(input.requestId),title=controlProfileText(input.title,200),body=controlProfileText(input.body,12000);
    if(/[\r\n]/.test(title)||/<!--\s*(?:memory-entry-id|device-memory-request):/i.test(body)||/^#{1,3}\s/m.test(body))fail('DEVICE_MEMORY_INPUT_INVALID','제목과 본문을 확인하세요. 내부 기억 표식과 최상위 제목은 넣을 수 없습니다.');
    const root=this.root(target,true)!;
    const entryId=hash(`${target.memoryId}:${requestId}`).slice(0,24),fingerprint=hash(JSON.stringify({title,body}));
    const marker=`<!-- device-memory-request:${requestId}:${fingerprint} -->`;
    const local=await this.deps.lease(root,async()=>{
      this.check(target);
      let current=this.readAt(target);
      const duplicate=current.snapshot?.document.includes(`<!-- memory-entry-id:${entryId} -->`);
      if(duplicate){if(!current.snapshot!.document.includes(marker))fail('DEVICE_MEMORY_REQUEST_CONFLICT','같은 저장 요청에 다른 내용을 넣을 수 없습니다.');return {duplicate:true};}
      if(current.revision!==input.expectedRevision)fail('DEVICE_MEMORY_REVISION_CHANGED','이 기기의 기억이 바뀌었습니다. 내용을 다시 확인하세요.');
      if(!current.snapshot){await this.deps.initialize(root,target.memoryId,target.name);this.check(target);current=this.readAt(target);}
      if(!current.snapshot||!current.revision)fail('DEVICE_MEMORY_PREPARE_FAILED','이 기기의 기억을 준비하지 못했습니다.');
      const document=`${current.snapshot!.document.trimEnd()}\n\n### ${title}\n<!-- memory-entry-id:${entryId} -->\n${marker}\n\n${body}\n`;
      if(Buffer.byteLength(document)>1024*1024)fail('DEVICE_MEMORY_TOO_LARGE','기존 기억을 지우지 않고 저장을 중단했습니다. 기억 크기를 검토하세요.');
      this.check(target);await this.deps.write(root,document,current.revision!);this.check(target);
      return {duplicate:false};
    });
    // A backup failure cannot roll back the local entry. An identical retry backs up the same entry.
    let backup:{backedUp:boolean;reason:string};
    try{this.check(target);backup=await this.deps.backup(root,target.memoryId);this.check(target);}catch(error){if(error instanceof ControlProfileError&&error.code==='DEVICE_MEMORY_TARGET_CHANGED')throw error;backup={backedUp:false,reason:'needs-attention'};}
    return {saved:true,...local,entryId,target:{profileId:target.profileId,deviceId:target.deviceId,memoryId:target.memoryId},backup,memory:this.read()};
  }
  async synchronize(){
    const target=this.target(),{root,snapshot}=this.readAt(target);
    if(!root||!snapshot||!this.deps.pull)return {current:false,reason:'not-prepared',memory:this.read()};
    const result=await this.deps.lease(root,async()=>{this.check(target);const r=await this.deps.pull!(root,target.memoryId);this.check(target);this.readAt(target);return r;});
    return {...result,memory:this.read()};
  }
}
