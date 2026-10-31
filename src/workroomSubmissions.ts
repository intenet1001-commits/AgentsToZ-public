import {createHash,randomUUID} from 'node:crypto';
import type {WorkroomConversationJournal} from './workroomConversationJournal';
import type {CorrectionTaskExposure} from './projectMemoryCorrectionContext';
import {normalizeWorkroomSubmission,submissionDigest,submissionManifestHash,validateSubmissionText,WORKROOM_LAUNCH_SCOPE,WORKROOM_SUBMISSION_CHUNK_BYTES,WORKROOM_SUBMISSION_RECENT_LIMIT,WORKROOM_SUBMISSION_NOT_FOUND_ERROR,type WorkroomSubmissionCommand,type WorkroomSubmissionLaunch,type WorkroomSubmissionReceipt} from './workroomSubmissionProtocol';
/**
 * `owner` is the receipt namespace, a lookup key only — never a grant (the caller checks authority before and after).
 * `scope` is set only for a launch: its receipt is keyed by owner + launch scope + id because the client cannot know
 * the session the host allocates, while `sessionId` is that allocated session.
 */
export interface SubmissionContext {owner:string;sessionId:string;targetId:string;binding:string;revision:number;scope?:string;
 /** Launch receipts only: the AI the launch opens. With `targetId` it scopes a recovered banner to that target and AI. */
 agent?:WorkroomSubmissionLaunch['agent']}
/** What the writer needs beyond the text: the session it writes to, for a launch what to start, and the phone's
 *  attachment ids (w13) whose block the host appends — host-side only, taken from the admitted begin. */
export interface SubmissionWriteMeta {sessionId:string;launch?:WorkroomSubmissionLaunch;attachments?:readonly string[]}
type Write=(text:string,start:(exposure?:CorrectionTaskExposure)=>void,references:readonly string[],meta:SubmissionWriteMeta)=>Promise<void>;
export interface StoredSubmission extends SubmissionContext {
 key:string;id:string;fingerprint:string;intentHash:string;epoch:string;bootId:string;
 state:'prepared'|'write_started'|'written'|'unknown'|'rejected';
 exposure?:CorrectionTaskExposure;
 /** Set by the journal when the row is first stored; rows from before this field have none. */
 preparedAt?:string;
 /** Set when the row entered write_started (metadata time, body JSON only). */
 startedAt?:string;
 /** Set when the row became written. Absent on rows written before this field existed. */
 writtenAt?:string;
 /** Set when a person released an unconfirmed receipt's fence (acknowledgeSubmission); its state is unchanged. */
 acknowledgedAt?:string;
}
type Assembly={record:StoredSubmission;command:Omit<Extract<WorkroomSubmissionCommand,{phase:'begin'}>,'firstData'>;references:string[];parts:Map<number,Buffer>;expires:number;writing?:true};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyOf=(context:Pick<SubmissionContext,'owner'|'sessionId'|'scope'>,id:string)=>digest([context.owner,context.scope??context.sessionId,id]);
/** The same receipt key and owner digest for a host that writes the journal directly (src/contextOrcaCommand.ts). */
export const submissionKey=keyOf,submissionOwnerDigest=(owner:string)=>digest(owner);
/** Bounded, volatile payloads; only metadata receipts enter the existing durable history journal. */
export class WorkroomSubmissions {
 private assemblies=new Map<string,Assembly>();
 private expiry:ReturnType<typeof setTimeout>|undefined;
 constructor(private readonly store:()=>WorkroomConversationJournal,private readonly now=()=>performance.now(),private readonly lifetimeMs=30_000){}
 private arm(){clearTimeout(this.expiry);this.expiry=undefined;if(!this.assemblies.size)return;const delay=Math.max(1,Math.min(...[...this.assemblies.values()].map(a=>a.expires))-this.now());this.expiry=setTimeout(()=>this.prune(),delay);this.expiry.unref?.();}
 /** A prepared launch receipt whose payload is gone can never start a session: record that definitively
  *  (prepared → rejected), so a status says «not started» and the panel's start is not blocked by it. A row already past
  *  its fence keeps its state; an assembly still writing is left to its writer, whose fence check now fails and which
  *  records the refusal itself. Input submissions that merely expire keep their prepared receipt (their contract
  *  predates this); one its writer refused is rejected by `refuseUnwritten`. */
 private dropUnwritten(key:string,record:StoredSubmission){if(record.scope!==WORKROOM_LAUNCH_SCOPE)return;this.refuseUnwritten(key);}
 private refuseUnwritten(key:string){try{this.store().transitionSubmission(key,'prepared','rejected');}catch{/* already past the fence, or gone */}}
 private prune(){for(const [key,a] of this.assemblies)if(this.now()>=a.expires){this.assemblies.delete(key);if(!a.writing)this.dropUnwritten(key,a.record);}this.arm();}
 release(sessionId:string){for(const [key,a] of this.assemblies)if(a.record.sessionId===sessionId){this.assemblies.delete(key);if(!a.writing)this.dropUnwritten(key,a.record);}this.arm();}
 close(){clearTimeout(this.expiry);this.expiry=undefined;this.assemblies.clear();}
 usage(){return {assemblies:this.assemblies.size,bytes:[...this.assemblies.values()].reduce((n,a)=>n+[...a.parts.values()].reduce((b,p)=>b+p.length,0),0)};}
 assertRawAllowed(sessionId:string){this.prune();if([...this.assemblies.values()].some(a=>a.record.sessionId===sessionId))throw Error('작성한 요청을 준비하고 있습니다. 전송 결과를 확인한 뒤 직접 입력하세요.');}
 find(id:string,context:Pick<SubmissionContext,'owner'|'sessionId'|'scope'>){
  const store=this.store(),record=store.submission(keyOf(context,id));
  if(!record)return null;
  return {record,receipt:this.receipt(record,store)};
 }
 status(id:string,context:Pick<SubmissionContext,'owner'|'sessionId'|'scope'>){const found=this.find(id,context);if(!found)throw Error(WORKROOM_SUBMISSION_NOT_FOUND_ERROR);return found;}
 private receipt(record:StoredSubmission,store=this.store()):WorkroomSubmissionReceipt {
  return {id:record.id,storeId:store.storeInstanceId,epoch:record.epoch,revision:record.revision,state:record.state==='prepared'&&record.bootId!==store.bootId?'held':record.state,
   ...(record.scope===WORKROOM_LAUNCH_SCOPE?{sessionId:record.sessionId,targetId:record.targetId,agent:record.agent!}:{})};
 }
 /** Read-only: this owner's unsettled receipts in one scope (a session id, or WORKROOM_LAUNCH_SCOPE), newest first. */
 recent(owner:string,scope:string){
  this.prune();const store=this.store();
  // Only receipts that could have started: past the fence (write_started · unknown), or prepared and still in flight here.
  // A prepared row without its payload (held after a restart) can never be written, so it is not offered for recovery.
  return store.recentSubmissions(digest(owner),scope,WORKROOM_SUBMISSION_RECENT_LIMIT)
   .filter(record=>record.state!=='prepared'||record.bootId===store.bootId&&this.assemblies.has(record.key))
   .map(record=>({record,receipt:this.receipt(record,store)}));
 }
 /** The context of a launch receipt. begin/single carry the launch; later phases find it from the stored row. A retried
  *  begin reuses the session id it first allocated, so its fingerprint (and its eventual session) stays the same. */
 launchContext(command:WorkroomSubmissionCommand,owner:string):SubmissionContext{
  if(command.phase==='recent')throw Error('최근 제출 확인은 시작 요청이 아닙니다.');
  const scope=WORKROOM_LAUNCH_SCOPE,record=this.store().submission(keyOf({owner,sessionId:'',scope},command.id));
  if(command.phase==='begin'||command.phase==='single'){
   if(!command.launch)throw Error('새 세션 시작 정보가 없습니다. 작성 내용은 유지했습니다.');
   const binding=digest(['launch',command.launch]);
   if(record&&(record.binding!==binding||record.targetId!==command.launch.targetId))throw Error('같은 제출 ID의 프로젝트 또는 실행 방식이 변경되었습니다. 자동으로 다시 보내지 않습니다.');
   return {owner,sessionId:record?.sessionId??randomUUID(),scope,targetId:command.launch.targetId,binding,revision:0,agent:command.launch.agent};
  }
  if(!record)throw Error(WORKROOM_SUBMISSION_NOT_FOUND_ERROR);
  return {owner,sessionId:record.sessionId,scope,targetId:record.targetId,binding:record.binding,revision:record.revision,...(record.agent?{agent:record.agent}:{})};
 }
 async perform(input:WorkroomSubmissionCommand,context:SubmissionContext,references:readonly string[],write:Write):Promise<WorkroomSubmissionReceipt>{
  const command=normalizeWorkroomSubmission(input);this.prune();
  if(command.phase==='recent')throw Error('최근 제출 확인은 recent()로 읽으세요.');
  const store=this.store(),key=keyOf(context,command.id);
  let record=store.submission(key);
  if(command.phase==='status')return this.status(command.id,context).receipt;
  if(command.phase==='single'){
    const bytes=Buffer.from(command.data,'base64');
    if(bytes.length!==command.bytes||bytes.toString('base64')!==command.data||submissionDigest(bytes)!==command.digest)throw Error('입력 전체의 해시 또는 인코딩이 일치하지 않습니다.');
    validateSubmissionText(new TextDecoder('utf-8',{fatal:true}).decode(bytes),!!command.attachments);
    if(record&&['written','unknown','write_started','rejected'].includes(record.state)){
      if(record.intentHash!==submissionManifestHash(command.bytes,command.digest,references,command.attachments))throw Error('같은 제출 ID의 내용 또는 참조가 변경되었습니다.');
      return this.receipt(record,store);
    }
    const begun=await this.perform({phase:'begin',id:command.id,bytes:command.bytes,digest:command.digest,chunks:1,firstData:command.data,...(command.launch?{launch:command.launch}:{}),...(command.attachments?{attachments:command.attachments}:{})},context,references,write);
    return this.perform({phase:'commit',id:command.id,epoch:begun.epoch},context,[],write);
  }
  if(record&&['written','unknown','write_started','rejected'].includes(record.state)){
    if(command.phase==='begin'){
      const fingerprint=digest([context,command,[...references]]);
      if(fingerprint!==record.fingerprint)throw Error('같은 제출 ID의 내용 또는 입력 상태가 변경되었습니다.');
    }else if(command.epoch!==record.epoch)throw Error('제출 입력 소유자가 변경되었습니다.');
    return this.receipt(record,store);
  }
  if(command.phase==='begin'){
    const first=command.firstData===undefined?null:Buffer.from(command.firstData,'base64');
    if(first&&(first.length!==Math.min(command.bytes,WORKROOM_SUBMISSION_CHUNK_BYTES)||first.toString('base64')!==command.firstData))throw Error('첫 입력 조각의 크기 또는 인코딩이 올바르지 않습니다.');
    const fingerprint=digest([context,command,[...references]]);
    if(record&&record.fingerprint!==fingerprint)throw Error('같은 제출 ID의 내용 또는 입력 상태가 변경되었습니다.');
    const old=this.assemblies.get(key);if(old)return this.receipt(old.record,store);
    if(this.assemblies.size>=8)throw Error('준비 중인 요청이 많습니다. 잠시 후 다시 확인하세요.');
    this.assertRawAllowed(context.sessionId);
    record=store.prepareSubmission({...context,owner:digest(context.owner),key,id:command.id,fingerprint,intentHash:submissionManifestHash(command.bytes,command.digest,references,command.attachments),epoch:randomUUID(),bootId:store.bootId,state:'prepared'});
    if(record.bootId!==store.bootId)throw Error('재시작 전 준비된 제출입니다. 원래 세션과 입력 상태를 다시 확인하세요.');
    const {firstData:_firstData,...manifest}=command;
    const lifetime=Number.isFinite(this.lifetimeMs)?Math.max(1,Math.min(30_000,this.lifetimeMs)):30_000;
    this.assemblies.set(key,{record,command:manifest,references:[...references],parts:new Map(first?[[0,first]]:[]),expires:this.now()+lifetime});this.arm();
    return this.receipt(record,store);
  }
  const assembly=this.assemblies.get(key);
  if(!record||!assembly||record.bootId!==store.bootId||record.epoch!==command.epoch||record.sessionId!==context.sessionId||record.binding!==context.binding||record.targetId!==context.targetId||record.revision!==context.revision)throw Error('입력 또는 연결 상태가 변경되었습니다. 작성 내용을 유지하고 다시 확인하세요.');
  if(command.phase==='chunk'){
    const bytes=Buffer.from(command.data,'base64');
    const expected=command.index===assembly.command.chunks-1?assembly.command.bytes-command.index*WORKROOM_SUBMISSION_CHUNK_BYTES:WORKROOM_SUBMISSION_CHUNK_BYTES;
    if(command.index>=assembly.command.chunks||bytes.length!==expected||bytes.toString('base64')!==command.data)throw Error('입력 조각의 크기 또는 인코딩이 올바르지 않습니다.');
    const old=assembly.parts.get(command.index);if(old&&!old.equals(bytes))throw Error('같은 입력 조각의 내용이 변경되었습니다.');
    assembly.parts.set(command.index,bytes);
    if(command.commit)return this.perform({phase:'commit',id:command.id,epoch:command.epoch},context,[],write);
    return this.receipt(record,store);
  }
  if(assembly.parts.size!==assembly.command.chunks)throw Error('입력 전체를 아직 받지 못했습니다. 터미널에는 쓰지 않았습니다.');
  const bytes=Buffer.concat(Array.from({length:assembly.command.chunks},(_,i)=>assembly.parts.get(i)!));
  if(bytes.length!==assembly.command.bytes||submissionDigest(bytes)!==assembly.command.digest)throw Error('입력 전체의 해시가 일치하지 않습니다. 터미널에는 쓰지 않았습니다.');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(!text.endsWith('\r')||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)||text.slice(0,-1).includes('\r'))throw Error('작성 요청은 완전한 본문과 마지막 Enter 하나로 전송하세요.');
  // One writer per receipt: a duplicate commit arriving while the first is still writing is refused here, before it can
  // reach the writer, so its own refusal can never be mistaken for the first one's outcome.
  if(assembly.writing)throw Error('이 요청을 이미 처리하고 있습니다. 결과를 확인하세요. 자동으로 다시 보내지 않습니다.');
  assembly.writing=true;
  let started=false;
  try{
    await write(text,exposure=>{if(started)throw Error('제출 쓰기를 중복 시작할 수 없습니다.');if(this.assemblies.get(key)!==assembly||this.now()>=assembly.expires)throw Error('제출 준비 기간이 지나 쓰지 않았습니다. 작성 내용을 다시 확인하세요.');store.transitionSubmission(key,'prepared','write_started',exposure);started=true;},assembly.references,{sessionId:record.sessionId,...(assembly.command.launch?{launch:assembly.command.launch}:{}),...(assembly.command.attachments?{attachments:assembly.command.attachments}:{})});
    if(!started)throw Error('제출 쓰기 시작 기록이 없습니다.');
    store.transitionSubmission(key,'write_started','written');
  }catch(error){
    // Refused before the fence (CLI missing, session cap, a moved project, a question screen, a stale correction…):
    // nothing was typed and the payload is dropped below, so the receipt says so definitively. An input receipt left
    // «prepared» here kept the sender's composer fenced for good (2026-10-30), though the same id can never be written.
    if(!started){this.refuseUnwritten(key);throw error;}
    try{store.transitionSubmission(key,'write_started','unknown');}catch{/* The durable write_started record also prevents replay. */}
  }finally{if(this.assemblies.get(key)===assembly)this.assemblies.delete(key);this.arm();}
  return this.receipt(store.submission(key)!,store);
 }
}
