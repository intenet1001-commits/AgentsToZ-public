import {createHash,randomBytes} from 'node:crypto';
import {lstatSync,mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {isTransitObjectPath} from './vocAttachments';
import {fetchTransitBlob,RemoteVocError,vocTransitDownloadUrl,type RemoteVocTransit} from './vocRemoteReceive.server';
import {assertWorkroomImageAttachments,isWorkroomImagePath,saveWorkroomImage,workroomImageKind} from './workroomImages';
import {isWorkroomFilePath,saveWorkroomFile} from './workroomFiles';
import {
  normalizeWorkroomAttachmentRequest, workroomAttachmentFailureMessage,
  WORKROOM_ATTACH_ACTIVE_JOBS, WORKROOM_ATTACH_DAILY_BYTES, WORKROOM_ATTACH_HOST_BYTES, WORKROOM_ATTACH_ID_RE,
  WORKROOM_ATTACH_ITEM_TIMEOUT_MS, WORKROOM_ATTACH_LIVE_IDS, WORKROOM_ATTACH_MAX_FILES, WORKROOM_ATTACH_MAX_IDS,
  WORKROOM_ATTACH_MAX_IMAGES, WORKROOM_ATTACH_QUEUED_JOBS, WORKROOM_ATTACH_TTL_MS, WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES,
  type WorkroomAttachmentIdsRequest, type WorkroomAttachmentItemResult, type WorkroomAttachmentReceive, type WorkroomAttachmentResult,
} from './workroomRemoteAttachmentProtocol';

/**
 * Phone Workroom attachments, the Mac half (w13). A ledger of what a phone asked this Mac to fetch:
 *
 * - `receive` admits a request after every bound (owner on the internet connection, project resolvable, transit paths
 *   under this Mac's host id, ≤ 32 live ids per owner, ≤ 512 MiB unconsumed host-wide, ≤ 2 downloading + 8 queued,
 *   256 MiB per owner per local day reserved and never refunded) and answers at once. The phone's rate is the
 *   gateway's (src/mobileWorkspaceGateway.ts).
 * - Downloads run in the background, outside the relay poll: the URL is rebuilt from this Mac's Supabase URL, the bytes
 *   are decrypted and checked (size, sha256, image bytes for an image), the connection's consent is checked again, and
 *   the file is saved through the w10 host functions (workroom-images / workroom-files). One failed item fails alone.
 *   Every transit object is then removed when this Mac can (service_role); otherwise the answer tells the phone to.
 * - A ready item is an opaque id bound to its owner and project for sixty minutes. `check` (at a submission's begin)
 *   and `lease` (right before the write) are the only ways a submission turns ids into paths. An unconsumed id is
 *   deleted with its file when it expires; a consumed one leaves its file to the 14-day prune (the AI may reopen it).
 * - An id is single-use: once a written request consumed it, `check`/`lease` read it as gone. A replay of that same
 *   submission id never reaches them (the journal answers it), so exactly-once replays still work; a second, NEW request
 *   naming the same ids — a second CLI with the same files after a lost answer — is refused (review w13). That holds for
 *   two new requests at once as well: an id leased by a request still on its way to its write is not lent to another
 *   (both used to pass `check` and `lease` and type the same files into two sessions).
 * - `rebind` moves this owner's ready, unconsumed ids to another project it may type into (the phone's viewed session
 *   changed): no upload, no download, no new id, no quota. `release` frees ids the person took back out: the file goes
 *   and the live slot returns. Neither touches a consumed or pinned id.
 *
 * The state file holds metadata only — never a transit token or key. A restart marks unfinished items interrupted.
 */
export const WORKROOM_REMOTE_ATTACHMENT_STATE_FILE='workroom-remote-attachments.json';
/** `lease` while another request is still writing with one of the ids (two new requests at once). */
export const WORKROOM_ATTACH_IN_USE_MESSAGE='첨부가 다른 요청에서 쓰이는 중입니다 — 그 요청의 결과를 확인한 뒤 다시 보내세요. 작성 내용은 유지했습니다.';
const SCHEMA_VERSION=1;
/** Items kept across all jobs (the state file stays small). */
const MAX_ITEMS=512;
const SWEEP_INTERVAL_MS=5*60*1000;
const TRANSIT_REMOVE_TIMEOUT_MS=15_000;
/** Only a phone on the internet connection (an approved relay session with durable consent). */
const INTERNET_OWNER=/^device:[^:]+:internet:/;

export class WorkroomRemoteAttachmentError extends Error {
  constructor(readonly code:string,message:string){super(`${message} (${code})`);}
}
class ItemFailure extends Error {constructor(readonly code:string){super(code);}}

type ItemState='pending'|'ready'|'failed'|'expired';
interface Item {
  state:ItemState;kind:'image'|'file';bytes:number;
  id?:string;path?:string;readyAt?:number;expiresAt?:number;consumedAt?:number|null;
  code?:string;removed?:boolean;settledAt?:number;
  /** Set by `rebind`: the project this id now belongs to (otherwise its job's). */
  targetId?:string;
}
interface Job {receiveId:string;owner:string;targetId:string;fingerprint:string;createdAt:number;items:Item[]}
interface Usage {day:string;bytes:number}
interface Run {key:string;job:Job;request:WorkroomAttachmentReceive;isActive:()=>boolean}

export interface WorkroomRemoteAttachmentLease {
  /** Absolute paths, in the order their ids were given: images first, files after (the block order). */
  images:string[];files:string[];
  /** Right before the write fence: every file is still this app's own regular file. */
  recheck():void;
  /** After the write fence: the ids stay usable until they expire, and their files are no longer deleted early. */
  consume():void;
  release():void;
}
export interface WorkroomRemoteAttachmentScope {owner:string;targetId:string}

export interface WorkroomRemoteAttachmentDependencies {
  appDataDir:string;
  /** This Mac's relay host id: every transit path must sit under it. */
  hostId():string|null;
  /** This Mac's Supabase URL; the download URL is rebuilt from it, never taken from the phone. */
  supabaseUrl():string|null;
  /** Removes transit objects when this Mac can (service_role); null when it cannot. */
  transit():RemoteVocTransit|null;
  /** Throws when the runtime target is not a registered project. */
  resolveTarget(targetId:string):Promise<unknown>;
  fetchImpl?:typeof fetch;
  now?:()=>number;
  log?:(line:string)=>void;
  itemTimeoutMs?:number;
  /** null: no timer (tests). The default sweeps every five minutes on an unref'd timer. */
  sweepIntervalMs?:number|null;
}

const pad=(n:number)=>String(n).padStart(2,'0');
const localDay=(at:number)=>{const d=new Date(at);return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;};
const jobKey=(owner:string,receiveId:string)=>createHash('sha256').update(JSON.stringify([owner,receiveId])).digest('hex');
const refused=(code:string,message:string):never=>{throw new WorkroomRemoteAttachmentError(code,message);};

function itemCode(error:unknown):string{
  if(error instanceof ItemFailure)return error.code;
  if(error instanceof RemoteVocError){
    switch(error.code){
      case 'VOC_DOWNLOAD_NOT_FOUND':return 'WORKROOM_ATTACH_DOWNLOAD_NOT_FOUND';
      case 'VOC_DOWNLOAD_TOO_LARGE':return 'WORKROOM_ATTACH_TOO_LARGE';
      case 'VOC_DECRYPT_FAILED':return 'WORKROOM_ATTACH_DECRYPT_FAILED';
      case 'VOC_HASH_MISMATCH':return 'WORKROOM_ATTACH_HASH_MISMATCH';
      default:return 'WORKROOM_ATTACH_DOWNLOAD_FAILED';
    }
  }
  return 'WORKROOM_ATTACH_DOWNLOAD_FAILED';
}

export class WorkroomRemoteAttachmentLedger {
  #jobs=new Map<string,Job>();
  #byId=new Map<string,{job:Job;item:Item}>();
  #usage:Record<string,Usage>={};
  #pins=new Map<string,number>();
  #queue:Run[]=[];
  #active=0;
  #inflight=new Set<Promise<unknown>>();
  #closed=false;
  #timer:ReturnType<typeof setInterval>|undefined;
  readonly #file:string;
  readonly #now:()=>number;
  constructor(private readonly deps:WorkroomRemoteAttachmentDependencies){
    this.#file=join(deps.appDataDir,WORKROOM_REMOTE_ATTACHMENT_STATE_FILE);
    this.#now=deps.now??Date.now;
    this.#load();
    this.sweep();
    this.#persist();
    const every=deps.sweepIntervalMs===undefined?SWEEP_INTERVAL_MS:deps.sweepIntervalMs;
    if(every!==null){this.#timer=setInterval(()=>{try{this.sweep();}catch{/* next tick */}},every);(this.#timer as {unref?:()=>void}).unref?.();}
  }

  async receive(value:WorkroomAttachmentReceive,scope:WorkroomRemoteAttachmentScope&{isActive:()=>boolean}):Promise<WorkroomAttachmentResult>{
    if(this.#closed)refused('WORKROOM_ATTACH_BUSY','Mac 앱이 종료 중입니다. 잠시 후 다시 시도하세요.');
    const request=normalizeWorkroomAttachmentRequest('attachments.receive',value);
    if(!INTERNET_OWNER.test(scope.owner))refused('WORKROOM_ATTACH_INTERNET_ONLY','첨부는 인터넷 연결에서만 할 수 있습니다');
    const key=jobKey(scope.owner,request.receiveId);
    const fingerprint=createHash('sha256').update(JSON.stringify([scope.targetId,request.items])).digest('hex');
    // The same receiveId with the same items is the same job: a lost answer or a reconnect re-asks, never re-downloads.
    const existing=()=>{
      const job=this.#jobs.get(key);
      if(!job)return null;
      if(job.fingerprint!==fingerprint||job.targetId!==scope.targetId)refused('WORKROOM_ATTACH_RECEIVE_CONFLICT','같은 첨부 전달 ID에 다른 항목을 보낼 수 없습니다 — 첨부를 다시 넣어 주세요');
      return this.#snapshot(job);
    };
    this.sweep();
    const first=existing();if(first)return first;
    try{await this.deps.resolveTarget(scope.targetId);}
    catch{refused('WORKROOM_ATTACH_TARGET_INVALID','첨부할 프로젝트를 이 Mac에서 확인하지 못했습니다');}
    const again=existing();if(again)return again;
    const supabaseUrl=this.deps.supabaseUrl();
    if(!supabaseUrl)refused('WORKROOM_ATTACH_SUPABASE_URL_MISSING','이 Mac에 Supabase 연결이 없어 첨부를 받을 수 없습니다');
    try{vocTransitDownloadUrl(supabaseUrl!,request.items[0]!.path,'probe');}
    catch{refused('WORKROOM_ATTACH_SUPABASE_URL_INVALID','이 Mac의 Supabase 주소를 확인하지 못해 첨부를 받을 수 없습니다');}
    const hostId=this.deps.hostId();
    if(!hostId||request.items.some(item=>!isTransitObjectPath(item.path,hostId)))refused('WORKROOM_ATTACH_PATH_INVALID','이 Mac으로 보낸 첨부가 아닙니다 — 연결한 Mac을 확인하고 다시 넣어 주세요');
    const now=this.#now(),incoming=request.items.reduce((sum,item)=>sum+item.bytes,0);
    // Live: pending, or ready and still unconsumed (unexpired by the sweep above).
    const live=(item:Item)=>item.state==='pending'||item.state==='ready'&&item.consumedAt==null;
    let ownerLive=0,hostBytes=0,items=0;
    for(const job of this.#jobs.values())for(const item of job.items){
      items++;
      if(!live(item))continue;
      hostBytes+=item.bytes;
      if(job.owner===scope.owner)ownerLive++;
    }
    if(ownerLive+request.items.length>WORKROOM_ATTACH_LIVE_IDS)refused('WORKROOM_ATTACH_LIVE_LIMIT',`아직 보내지 않은 첨부가 많습니다(최대 ${WORKROOM_ATTACH_LIVE_IDS}개). 보내거나 뺀 뒤 다시 넣어 주세요`);
    if(hostBytes+incoming>WORKROOM_ATTACH_HOST_BYTES)refused('WORKROOM_ATTACH_HOST_LIMIT','Mac이 받아 둔 첨부가 많습니다. 잠시 후 다시 시도하세요');
    if(items+request.items.length>MAX_ITEMS&&!this.#evictSettled(items+request.items.length-MAX_ITEMS))refused('WORKROOM_ATTACH_HOST_LIMIT','Mac이 받아 둔 첨부가 많습니다. 잠시 후 다시 시도하세요');
    if(this.#active+this.#queue.length>=WORKROOM_ATTACH_ACTIVE_JOBS+WORKROOM_ATTACH_QUEUED_JOBS)refused('WORKROOM_ATTACH_BUSY','Mac이 다른 첨부를 받는 중입니다. 잠시 후 다시 시도하세요');
    const day=localDay(now),used=this.#usage[scope.owner]?.day===day?this.#usage[scope.owner]!.bytes:0;
    if(used+incoming>WORKROOM_ATTACH_DAILY_BYTES)refused('WORKROOM_ATTACH_QUOTA','오늘 이 기기에서 보낼 수 있는 첨부 용량(256MB)을 다 썼습니다. 내일 다시 넣어 주세요');
    // Reserved now and never refunded: a failed download still cost this Mac.
    this.#usage[scope.owner]={day,bytes:used+incoming};
    const job:Job={receiveId:request.receiveId,owner:scope.owner,targetId:scope.targetId,fingerprint,createdAt:now,
      items:request.items.map(item=>({state:'pending',kind:item.kind,bytes:item.bytes}))};
    this.#jobs.set(key,job);
    this.#persist();
    this.#queue.push({key,job,request,isActive:scope.isActive});
    this.#pump();
    return this.#snapshot(job);
  }

  status(receiveId:string,scope:WorkroomRemoteAttachmentScope):WorkroomAttachmentResult{
    this.sweep();
    const job=this.#jobs.get(jobKey(scope.owner,receiveId));
    if(!job||job.targetId!==scope.targetId)refused('WORKROOM_ATTACH_NOT_FOUND','첨부 전달 기록을 찾지 못했습니다 — 첨부를 다시 넣어 주세요');
    return this.#snapshot(job!);
  }

  /** At a submission's begin: every id is this owner's, this project's, ready and unexpired — or nothing is prepared. */
  check(ids:readonly string[],scope:WorkroomRemoteAttachmentScope):void{this.#entries(ids,scope);}

  /**
   * The phone's viewed session moved to another project: its ready ids follow, with no new upload, download, id or
   * quota. `scope.targetId` is the project the gateway already checked this device may type into; it must still resolve.
   * Another owner's, an unknown, an expired or a consumed id answers failed (the phone then sends that file again).
   */
  async rebind(value:WorkroomAttachmentIdsRequest,scope:WorkroomRemoteAttachmentScope):Promise<WorkroomAttachmentResult>{
    if(this.#closed)refused('WORKROOM_ATTACH_BUSY','Mac 앱이 종료 중입니다. 잠시 후 다시 시도하세요.');
    const request=normalizeWorkroomAttachmentRequest('attachments.rebind',value);
    if(!INTERNET_OWNER.test(scope.owner))refused('WORKROOM_ATTACH_INTERNET_ONLY','첨부는 인터넷 연결에서만 할 수 있습니다');
    try{await this.deps.resolveTarget(scope.targetId);}
    catch{refused('WORKROOM_ATTACH_TARGET_INVALID','첨부할 프로젝트를 이 Mac에서 확인하지 못했습니다');}
    this.sweep();
    const now=this.#now();let changed=false;
    const items=request.ids.map((id):WorkroomAttachmentItemResult=>{
      const entry=this.#byId.get(id);
      const failed=(code:string):WorkroomAttachmentItemResult=>({state:'failed',code,message:workroomAttachmentFailureMessage(code),removed:true});
      // Another owner's id reads exactly like an unknown one.
      if(!entry||entry.job.owner!==scope.owner||entry.item.state!=='ready'||!entry.item.path)return failed('WORKROOM_ATTACH_NOT_FOUND');
      if(now>=entry.item.expiresAt!)return failed('WORKROOM_ATTACH_EXPIRED');
      if(entry.item.consumedAt!=null)return failed('WORKROOM_ATTACH_CONSUMED');
      const next=scope.targetId===entry.job.targetId?undefined:scope.targetId;
      if(entry.item.targetId!==next){if(next===undefined)delete entry.item.targetId;else entry.item.targetId=next;changed=true;}
      return this.#itemResult(entry.item,now);
    });
    if(changed)this.#persist();
    return {receiveId:request.receiveId,items};
  }

  /** Ids the person took back out: an unconsumed, unpinned one is deleted with its file now and stops counting as live. */
  release(value:WorkroomAttachmentIdsRequest,scope:Pick<WorkroomRemoteAttachmentScope,'owner'>):WorkroomAttachmentResult{
    const request=normalizeWorkroomAttachmentRequest('attachments.release',value);
    if(!INTERNET_OWNER.test(scope.owner))refused('WORKROOM_ATTACH_INTERNET_ONLY','첨부는 인터넷 연결에서만 할 수 있습니다');
    let changed=false;
    for(const id of request.ids){
      const entry=this.#byId.get(id);
      if(!entry||entry.job.owner!==scope.owner||entry.item.state!=='ready'||entry.item.consumedAt!=null||this.#pins.has(id))continue;
      if(entry.item.path)this.#deleteOwn(entry.item.path);
      this.#expire(entry.item);changed=true;
    }
    if(changed){this.#reindex();this.#persist();}
    const message=workroomAttachmentFailureMessage('WORKROOM_ATTACH_RELEASED');
    return {receiveId:request.receiveId,items:request.ids.map(()=>({state:'failed',code:'WORKROOM_ATTACH_RELEASED',message,removed:true}))};
  }

  /** Right before the write: the ids again, their files on disk, and a pin that keeps the sweep away until release. */
  lease(ids:readonly string[],scope:WorkroomRemoteAttachmentScope):WorkroomRemoteAttachmentLease{
    const entries=this.#entries(ids,scope);
    // Single use under concurrency: an id another request holds (it has not crossed its write fence yet, so it is not
    // consumed) is not lent a second time. Nothing of this request has been written; the composer keeps the text.
    if(entries.some(e=>this.#pins.has(e.item.id!)))throw new Error(WORKROOM_ATTACH_IN_USE_MESSAGE);
    const images=entries.filter(e=>e.item.kind==='image').map(e=>e.item.path!);
    const files=entries.filter(e=>e.item.kind==='file').map(e=>e.item.path!);
    const verify=()=>{
      if(images.length)assertWorkroomImageAttachments(this.deps.appDataDir,images);
      for(const path of files)this.#assertOwnFile(path);
    };
    verify();
    for(const e of entries)this.#pins.set(e.item.id!,(this.#pins.get(e.item.id!)??0)+1);
    let released=false;
    return {images,files,recheck:verify,
      consume:()=>{const at=this.#now();let changed=false;for(const e of entries)if(e.item.consumedAt==null){e.item.consumedAt=at;changed=true;}if(changed)this.#persist();},
      release:()=>{if(released)return;released=true;for(const e of entries){const left=(this.#pins.get(e.item.id!)??1)-1;if(left>0)this.#pins.set(e.item.id!,left);else this.#pins.delete(e.item.id!);}}};
  }

  /** Expired ids: an unconsumed file is deleted (only inside this app's own folders); a consumed one is kept. */
  sweep():void{
    if(this.#closed)return;
    const now=this.#now();let changed=false;
    for(const [key,job] of this.#jobs){
      for(const item of job.items){
        if(item.state==='ready'&&now>=item.expiresAt!&&!this.#pins.has(item.id!)){
          if(item.consumedAt==null&&item.path)this.#deleteOwn(item.path);
          this.#expire(item);changed=true;
        }else if(item.state==='failed'&&now>=(item.settledAt??job.createdAt)+WORKROOM_ATTACH_TTL_MS){this.#expire(item);changed=true;}
      }
      if(job.items.every(item=>item.state==='expired')){this.#jobs.delete(key);changed=true;}
    }
    const today=localDay(now);
    for(const [owner,usage] of Object.entries(this.#usage))if(usage.day!==today){delete this.#usage[owner];changed=true;}
    if(changed){this.#reindex();this.#persist();}
  }

  /** Tests: resolves once every admitted download has settled. */
  async idle():Promise<void>{while(this.#inflight.size)await Promise.allSettled([...this.#inflight]);}

  close():void{this.#closed=true;this.#queue=[];if(this.#timer)clearInterval(this.#timer);this.#timer=undefined;}

  #entries(ids:readonly string[],scope:WorkroomRemoteAttachmentScope):{job:Job;item:Item}[]{
    if(!Array.isArray(ids)||!ids.length||ids.length>WORKROOM_ATTACH_MAX_IDS||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!WORKROOM_ATTACH_ID_RE.test(id)))
      throw new Error('첨부 목록을 확인하지 못했습니다. 작성 내용은 유지했습니다.');
    this.sweep();
    const now=this.#now();let missing=0,otherTarget=0;
    const entries:{job:Job;item:Item}[]=[];
    for(const id of ids){
      const entry=this.#byId.get(id);
      // Another owner's id reads exactly like an unknown one: nothing about it is revealed. A consumed id is gone too —
      // single-use: a replay of the request that consumed it is answered by the journal before it ever gets here.
      if(!entry||entry.job.owner!==scope.owner||entry.item.state!=='ready'||!entry.item.path||now>=entry.item.expiresAt!||entry.item.consumedAt!=null){missing++;continue;}
      if((entry.item.targetId??entry.job.targetId)!==scope.targetId){otherTarget++;continue;}
      entries.push(entry);
    }
    if(missing)throw new Error(`첨부 ${missing}개를 찾을 수 없거나 만료되었습니다 — 첨부를 다시 넣어 주세요. 작성 내용은 유지했습니다.`);
    if(otherTarget)throw new Error('다른 프로젝트용으로 넣은 첨부입니다 — 이 세션의 프로젝트에서 첨부를 다시 넣어 주세요. 작성 내용은 유지했습니다.');
    const images=entries.filter(e=>e.item.kind==='image').length,files=entries.length-images;
    if(images>WORKROOM_ATTACH_MAX_IMAGES||files>WORKROOM_ATTACH_MAX_FILES)throw new Error(`한 요청에 이미지는 ${WORKROOM_ATTACH_MAX_IMAGES}개, 파일은 ${WORKROOM_ATTACH_MAX_FILES}개까지 넣을 수 있습니다. 작성 내용은 유지했습니다.`);
    return entries;
  }

  #assertOwnFile(path:string){
    let ok=false;
    try{ok=isWorkroomFilePath(this.deps.appDataDir,path)&&lstatSync(path).isFile()&&[dirname(path),dirname(dirname(path))].every(dir=>lstatSync(dir).isDirectory());}catch{ok=false;}
    if(!ok)throw new Error('첨부 파일을 찾지 못했거나 이 앱이 받은 파일이 아닙니다. 첨부를 다시 넣어 주세요. 작성 내용은 유지했습니다.');
  }

  #deleteOwn(path:string){
    if(!isWorkroomImagePath(this.deps.appDataDir,path)&&!isWorkroomFilePath(this.deps.appDataDir,path))return;
    try{if(lstatSync(path).isFile())rmSync(path,{force:true});}catch{/* already gone */}
  }

  #expire(item:Item){item.state='expired';delete item.path;}

  /** Frees room for new items: oldest jobs with nothing pending, live or pinned go first. */
  #evictSettled(needed:number):boolean{
    let freed=0;
    const jobs=[...this.#jobs.entries()].sort((a,b)=>a[1].createdAt-b[1].createdAt);
    for(const [key,job] of jobs){
      if(freed>=needed)break;
      if(job.items.some(item=>item.state==='pending'||item.state==='ready'&&(item.consumedAt==null||this.#pins.has(item.id!))))continue;
      this.#jobs.delete(key);freed+=job.items.length;
    }
    if(freed){this.#reindex();this.#persist();}
    return freed>=needed;
  }

  #pump(){
    while(!this.#closed&&this.#active<WORKROOM_ATTACH_ACTIVE_JOBS&&this.#queue.length){
      const run=this.#queue.shift()!;this.#active++;
      const work=this.#runJob(run).catch(error=>this.deps.log?.(`[RemoteAttach] job failed: ${error instanceof Error?error.message:String(error)}`))
        .finally(()=>{this.#active--;this.#inflight.delete(work);this.#pump();});
      this.#inflight.add(work);
    }
  }

  async #runJob(run:Run){
    let next=0;
    // Two items in parallel per job; two jobs at once host-wide.
    const worker=async()=>{while(!this.#closed&&next<run.request.items.length){const index=next++;await this.#runItem(run,index);}};
    await Promise.all([worker(),worker()]);
  }

  async #runItem(run:Run,index:number){
    const source=run.request.items[index]!,item=run.job.items[index]!;
    let saved:string|null=null,code:string|null=null;
    try{
      if(!run.isActive())throw new ItemFailure('WORKROOM_ATTACH_REVOKED');
      const supabaseUrl=this.deps.supabaseUrl();
      if(!supabaseUrl)throw new ItemFailure('WORKROOM_ATTACH_DOWNLOAD_FAILED');
      const plain=await fetchTransitBlob({supabaseUrl,path:source.path,token:source.token,key:source.key,sha256:source.sha256,bytes:source.bytes,
        maxPlainBytes:WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES,fetchImpl:this.deps.fetchImpl,timeoutMs:this.deps.itemTimeoutMs??WORKROOM_ATTACH_ITEM_TIMEOUT_MS});
      if(source.kind==='image'&&!workroomImageKind(plain))throw new ItemFailure('WORKROOM_ATTACH_NOT_IMAGE');
      // The grant may have been revoked while the bytes travelled: nothing is saved for a connection that lost it.
      if(!run.isActive())throw new ItemFailure('WORKROOM_ATTACH_REVOKED');
      if(this.#closed)return;
      const at=new Date(this.#now());
      try{saved=source.kind==='image'?saveWorkroomImage(this.deps.appDataDir,plain,at).path:saveWorkroomFile(this.deps.appDataDir,plain,source.name??'file',at).path;}
      catch{throw new ItemFailure('WORKROOM_ATTACH_SAVE_FAILED');}
    }catch(error){code=itemCode(error);}
    const removed=await this.#removeTransit(source.path);
    if(this.#closed){if(saved)this.#deleteOwn(saved);return;}
    const now=this.#now();
    if(code||!saved){Object.assign(item,{state:'failed',code:code??'WORKROOM_ATTACH_DOWNLOAD_FAILED',removed,settledAt:now});}
    else{
      const id='wa_'+randomBytes(24).toString('base64url');
      Object.assign(item,{state:'ready',id,path:saved,readyAt:now,expiresAt:now+WORKROOM_ATTACH_TTL_MS,consumedAt:null,removed,settledAt:now});
      this.#byId.set(id,{job:run.job,item});
    }
    this.#persist();
  }

  async #removeTransit(path:string):Promise<boolean>{
    const transit=this.deps.transit();
    if(!transit)return false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      return await Promise.race([transit.remove([path]).catch(()=>false),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),TRANSIT_REMOVE_TIMEOUT_MS);})]);
    }finally{clearTimeout(timer);}
  }

  #snapshot(job:Job):WorkroomAttachmentResult{
    const now=this.#now();
    return {receiveId:job.receiveId,items:job.items.map(item=>this.#itemResult(item,now))};
  }

  #itemResult(item:Item,now:number):WorkroomAttachmentItemResult{
    if(item.state==='pending')return {state:'pending'};
    if(item.state==='ready')return {state:'ready',id:item.id!,kind:item.kind,bytes:item.bytes,lineBytes:Buffer.byteLength(item.path!),
      expiresInMs:Math.max(0,Math.min(WORKROOM_ATTACH_TTL_MS,item.expiresAt!-now)),removed:item.removed===true};
    const code=item.state==='expired'?'WORKROOM_ATTACH_EXPIRED':item.code??'WORKROOM_ATTACH_DOWNLOAD_FAILED';
    return {state:'failed',code,message:workroomAttachmentFailureMessage(code),removed:item.removed===true};
  }

  #reindex(){
    this.#byId.clear();
    for(const job of this.#jobs.values())for(const item of job.items)if(item.state==='ready'&&item.id)this.#byId.set(item.id,{job,item});
  }

  #persist(){
    if(this.#closed)return;
    const state={schemaVersion:SCHEMA_VERSION,jobs:[...this.#jobs.values()],usage:this.#usage};
    const tmp=`${this.#file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try{
      mkdirSync(this.deps.appDataDir,{recursive:true,mode:0o700});
      writeFileSync(tmp,JSON.stringify(state),{mode:0o600,flag:'wx'});
      renameSync(tmp,this.#file);
    }catch(error){
      try{rmSync(tmp,{force:true});}catch{/* nothing written */}
      this.deps.log?.(`[RemoteAttach] could not save the attachment ledger: ${error instanceof Error?error.message:String(error)}`);
    }
  }

  #load(){
    let raw:string;
    try{raw=readFileSync(this.#file,'utf8');}
    catch(error){if((error as NodeJS.ErrnoException)?.code!=='ENOENT')this.deps.log?.('[RemoteAttach] the attachment ledger could not be read; starting empty');return;}
    let state:unknown;
    try{state=JSON.parse(raw);}catch{this.deps.log?.('[RemoteAttach] the attachment ledger is unreadable; starting empty');return;}
    const s=state as {schemaVersion?:unknown;jobs?:unknown;usage?:unknown};
    if(!s||typeof s!=='object'||s.schemaVersion!==SCHEMA_VERSION||!Array.isArray(s.jobs)){this.deps.log?.('[RemoteAttach] the attachment ledger has an unknown shape; starting empty');return;}
    const now=this.#now(),uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,num=(x:unknown)=>typeof x==='number'&&Number.isFinite(x);
    let count=0;
    for(const raw of s.jobs as unknown[]){
      const j=raw as Job;
      if(!j||typeof j!=='object'||typeof j.receiveId!=='string'||!uuid.test(j.receiveId)||typeof j.owner!=='string'||typeof j.targetId!=='string'
        ||typeof j.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(j.fingerprint)||!num(j.createdAt)||!Array.isArray(j.items)||!j.items.length||j.items.length>5)continue;
      const items:Item[]=[];
      for(const r of j.items as Item[]){
        if(!r||typeof r!=='object'||(r.kind!=='image'&&r.kind!=='file')||!num(r.bytes))break;
        const base={kind:r.kind,bytes:r.bytes};
        // An unfinished download cannot resume: its key was never written down.
        if(r.state==='pending'){items.push({...base,state:'failed',code:'WORKROOM_ATTACH_INTERRUPTED',removed:false,settledAt:now});continue;}
        if(r.state==='ready'){
          const own=typeof r.path==='string'&&(isWorkroomImagePath(this.deps.appDataDir,r.path)||isWorkroomFilePath(this.deps.appDataDir,r.path));
          if(own&&typeof r.id==='string'&&WORKROOM_ATTACH_ID_RE.test(r.id)&&num(r.readyAt)&&num(r.expiresAt)&&(r.consumedAt===null||num(r.consumedAt))&&(r.targetId===undefined||typeof r.targetId==='string')){
            items.push({...base,state:'ready',id:r.id,path:r.path,readyAt:r.readyAt,expiresAt:r.expiresAt,consumedAt:r.consumedAt,removed:r.removed===true,settledAt:num(r.settledAt)?r.settledAt:r.readyAt,...(typeof r.targetId==='string'?{targetId:r.targetId}:{})});
          }else items.push({...base,state:'expired'}); // a path that is not this app's own is never touched
          continue;
        }
        if(r.state==='failed'&&typeof r.code==='string'&&/^WORKROOM_ATTACH_[A-Z_]{2,48}$/.test(r.code)){items.push({...base,state:'failed',code:r.code,removed:r.removed===true,settledAt:num(r.settledAt)?r.settledAt:j.createdAt});continue;}
        items.push({...base,state:'expired'});
      }
      if(items.length!==j.items.length||count+items.length>MAX_ITEMS)continue;
      count+=items.length;
      this.#jobs.set(jobKey(j.owner,j.receiveId),{receiveId:j.receiveId,owner:j.owner,targetId:j.targetId,fingerprint:j.fingerprint,createdAt:j.createdAt,items});
    }
    if(s.usage&&typeof s.usage==='object'&&!Array.isArray(s.usage))
      for(const [owner,u] of Object.entries(s.usage as Record<string,Usage>))if(u&&typeof u.day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(u.day)&&num(u.bytes)&&u.bytes>=0)this.#usage[owner]={day:u.day,bytes:u.bytes};
    this.#reindex();
  }
}
