import {sharedThreadTextParts,sharedThreadProjectLabel} from './workroomThreadGroup';
import {workroomTurnResultText} from './aiTerminalActivity';
import {createHash,randomUUID} from 'node:crypto';
import type {AiTerminalAgent,AiTerminalSummary} from './aiTerminalProtocol';
import {WorkroomThreadStore,type StoredWorkroomThread} from './workroomThreadStore';
import type {ServiceUseHost} from './serviceUseHost';
import type {ServiceUseCall,ServiceUseOutcome} from './serviceUseProtocol';
import {threadId,WorkroomThreadAdmissionError,normalizeWorkroomThreadRequest,workroomThreadText,type WorkroomThreadAction,type WorkroomThreadMessage,type WorkroomThreadRequest,type WorkroomThreadResult,type WorkroomThreadSummary} from './workroomThreadProtocol';

export interface WorkroomThreadAccess {owner:string;active():boolean;readAll:boolean;targets?:ReadonlySet<string>;
 /** Local, request-scoped context validation. Never supplied by a remote request. */
 withInputContext?<T>(operation:()=>Promise<T>,context?:{excludeWorkroomSessionId:string}):Promise<T>}
export interface WorkroomThreadDependencies {
 store:WorkroomThreadStore;
 use?:Pick<ServiceUseHost,'bind'|'execute'|'receipt'> & Partial<Pick<ServiceUseHost,'status'>>;
 resolve(targetId:string):Promise<{fingerprint:string;label?:string}>;
 start(id:string,targetId:string,agent:AiTerminalAgent,prompt:string,active:()=>boolean,fingerprint:string):Promise<{session?:AiTerminalSummary;written:boolean}>;
 reply(id:string,sessionId:string,text:string,revision:number,active:()=>boolean,fingerprint:string):Promise<{written:boolean}>;
 inspect(sessionId:string,targetId:string):{inputRevision:number;state:string};
 open?(id:string,record:StoredWorkroomThread,active:()=>boolean):Promise<AiTerminalSummary|undefined>;
 ready?(session:AiTerminalSummary,active:()=>boolean):Promise<void>;
 /** Host transcript evidence only; UI/footer text is never scheduling authority. */
 checkpointEvidence?(record:StoredWorkroomThread):Promise<{inputRevision:number;turnCompletedAt?:string}|null>;
 checkpoint?(record:StoredWorkroomThread):Promise<'saving'|'closed'|'blocked'>;
 now?():string;
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function publicWorkroomThread(r:StoredWorkroomThread):WorkroomThreadSummary {
 const {id,title,agent,sessionId,state,revision,createdAt,updatedAt}=r;return {id,title,agent,sessionId,state,revision,createdAt,updatedAt,...(r.group?{participants:r.group.members.map(m=>({...m}))}:{}),...(r.serviceExecution?{execution:{role:'use' as const,serviceKey:r.serviceExecution.binding.serviceKey}}:{})};
}
/** A task owns one exact Workroom. Receiving an echo or re-reading a receipt never starts or types anything. */
export class WorkroomThreadService {
 readonly bootId=randomUUID();
 linkedSession(id:string){return !!this.sessionLinks.get(id);}
 private flights=new Map<string,Promise<unknown>>();
 private sessionLinks=new Map<string,string|null>();
 private questionRevisions=new Map<string,number>();
 private checking=false;
 private clock:()=>string;
 constructor(private deps:WorkroomThreadDependencies){this.clock=deps.now??(()=>new Date().toISOString());}
 private message(id:string,role:WorkroomThreadMessage['role'],kind:WorkroomThreadMessage['kind'],text:string,delivery:WorkroomThreadMessage['delivery']='recorded'):WorkroomThreadMessage {
  return {id,seq:0,role,kind,text,at:this.clock(),delivery};
 }
 private append(r:StoredWorkroomThread,m:WorkroomThreadMessage){if(r.messages.some(v=>v.id===m.id))return;r.messages.push({...m,seq:(r.messages.at(-1)?.seq??0)+1});r.updatedAt=this.clock();r.revision++;}
 /** Compare whole result text within this request, including consecutive bounded chunks. */
 private hasResultText(r:StoredWorkroomThread,text:string){
  const start=r.messages.findLastIndex(m=>m.role==='user')+1;
  for(let i=start;i<r.messages.length;i++){
   let offset=0;
   for(let j=i;j<r.messages.length;j++){
    const m=r.messages[j]!;
    if(m.role!=='assistant'||m.kind!=='result'||!text.startsWith(m.text,offset))break;
    offset+=m.text.length;if(offset===text.length)return true;
   }
  }
  return false;
 }
 private allowed(r:StoredWorkroomThread|null,targetId:string,access:WorkroomThreadAccess):asserts r is StoredWorkroomThread {
  if(!access.active()||!r||(r.targetId!==targetId&&!r.group?.members.some(m=>m.targetId===targetId))||!access.readAll&&r.owner!==access.owner)throw Error('이 프로젝트의 작업 스레드에 접근할 수 없습니다.');
  if(r.serviceExecution&&r.owner!==access.owner)throw Error('USE 실행은 원래 사용자 문맥에서만 조회할 수 있습니다.');
 }
 private async forSession(sessionId:string){
  if(this.sessionLinks.has(sessionId)){const id=this.sessionLinks.get(sessionId),r=id?await this.deps.store.get(id):null;return r?.sessionId===sessionId?r:null;}
  const record=await this.deps.store.forSession(sessionId);this.sessionLinks.set(sessionId,record?.id??null);
  if(this.sessionLinks.size>512)for(const [key,value] of this.sessionLinks){if(value===null){this.sessionLinks.delete(key);break;}}
  return record;
 }
 private page(r:StoredWorkroomThread,before?:number):WorkroomThreadResult {
  const rows=r.messages.filter(m=>before===undefined||m.seq<before),kept:WorkroomThreadMessage[]=[];let bytes=r.group?Buffer.byteLength(JSON.stringify(publicWorkroomThread(r))):0;
  for(const m of rows.slice().reverse()){const size=Buffer.byteLength(JSON.stringify(m));if(kept.length>=20||bytes+size>(r.group?7800:6500))break;kept.unshift(m);bytes+=size;}
  return {thread:publicWorkroomThread(r),messages:kept,nextBefore:kept.length&&rows[0]!.seq<kept[0]!.seq?kept[0]!.seq:null};
 }
 async perform(action:WorkroomThreadAction,body:WorkroomThreadRequest,targetId:string,requestId:string,access:WorkroomThreadAccess):Promise<WorkroomThreadResult>{
  if(!threadId(requestId))throw Error('업무 요청 번호를 확인하세요.');
  const input=normalizeWorkroomThreadRequest(action,body);if(!access.active())throw Error('워크룸 연결을 확인하세요.');
  if(input.projectState&&(!access.withInputContext||access.owner!=='local'))throw new WorkroomThreadAdmissionError('프로젝트 상태 첨부는 이 기기의 DEV 업무에서만 사용할 수 있습니다.');
  if(action==='workroom.threads.catalog'){
   await this.deps.resolve(targetId);
   const status=await this.deps.use?.status?.(targetId,access.owner,input.serviceKey??'default');
   if(!access.active())throw Error('USE 연결 권한이 변경되었습니다.');
   return {catalog:{tools:status?.tools??[],...(status?.actions?{actions:status.actions}:{}),executionReady:status?.readiness.executionReady??false,problem:status?.readiness.problem??(status?null:'이 기기의 USE 도구 목록을 확인할 수 없습니다.')}};
  }
  if(action==='workroom.threads.list'){
   const binding=await this.deps.resolve(targetId),rows=await this.deps.store.list(targetId,access.owner,access.readAll,input.beforeThreadId),threads:WorkroomThreadSummary[]=[];let consumed=0;
   for(const row of rows.slice(0,20)){if(row.serviceExecution){try{await this.useAccess(row,targetId,access);}catch{consumed++;continue;}}else if(row.group){try{await this.groupAccess(row,targetId,access);}catch{consumed++;continue;}}else if(row.fingerprint!==binding.fingerprint){consumed++;continue;}const summary=publicWorkroomThread(row);if(Buffer.byteLength(JSON.stringify([...threads,summary]))>6500)break;threads.push(summary);consumed++;}
   return {threads,nextThreadId:rows.length>consumed&&consumed>0?rows[consumed-1]!.id:null};
  }
  if(action==='workroom.threads.create')try{return input.use?await this.createUse(requestId,targetId,input,access):input.targetIds?await this.createGroup(requestId,targetId,input,access):await this.create(requestId,targetId,input,access);}catch(error){if(error instanceof WorkroomThreadAdmissionError)return {refusal:{requestId,message:error.message}};throw error;}
  const r=await this.deps.store.get(input.threadId!);this.allowed(r,targetId,access);
  if(input.projectState&&(r.group||r.groupParentId||r.serviceExecution))throw new WorkroomThreadAdmissionError('한 DEV 프로젝트의 업무에서 상태를 첨부하세요.');
  if(r.serviceExecution){await this.useAccess(r,targetId,access);if(action==='workroom.threads.read')return this.readUse(r,access,input.beforeSeq);if(action==='workroom.threads.reply')return this.replyUse(r,input,requestId,access);}
  else if(input.use)throw Error('기존 DEV 스레드를 USE로 바꿀 수 없습니다. 새 USE 업무를 시작하세요.');
  if(r.groupParentId)throw Error('공동 업무는 공유 스레드에서 확인하세요.');
  if(r.group)return this.performGroup(action,input,r,targetId,requestId,access);
  if(input.recipientTargetId&&input.recipientTargetId!==targetId)throw Error('답변할 프로젝트가 이 스레드와 다릅니다.');
  if(action==='workroom.threads.read')return this.readSingle(r,targetId,access,input.beforeSeq);
  if(action==='workroom.threads.close'){
   await this.deps.store.mutate(r.id,access.active,current=>{this.allowed(current,targetId,access);if(current.messages.some(m=>m.id===requestId))return {record:current,value:null};if(current.revision!==input.expectedRevision)throw Error('스레드가 갱신되었습니다. 다시 확인하세요.');current.state='closed';this.append(current,this.message(requestId,'system','notice','사용자가 이 업무 스레드를 종료 표시했습니다. 연결 워크룸은 별도로 확인하세요.'));return {record:current,value:null};});
   return this.page((await this.deps.store.get(r.id))!);
  }
  return this.reply(r,input,requestId,access);
 }
 private async useAccess(r:StoredWorkroomThread,targetId:string,access:WorkroomThreadAccess){
  this.allowed(r,targetId,access);if(!r.serviceExecution||!this.deps.use)throw Error('이 호스트는 USE 실행을 지원하지 않습니다.');
  const binding=await this.deps.use.bind(targetId,access.owner,r.serviceExecution.call,access.active);
  if(hash(binding)!==hash(r.serviceExecution.binding))throw Error('원래 USE 역할·서비스·사용자·보관함·설치·기억 또는 권한이 변경되었습니다.');
 }
 private async createUse(id:string,targetId:string,input:WorkroomThreadRequest,access:WorkroomThreadAccess){
  if(!this.deps.use)throw new WorkroomThreadAdmissionError('이 호스트는 USE 실행을 지원하지 않습니다. DEV로 대신 실행하지 않습니다.');
  let binding;try{binding=await this.deps.use.bind(targetId,access.owner,input.use!,access.active);}catch(e){throw new WorkroomThreadAdmissionError(e instanceof Error?e.message:'USE 실행 준비를 확인하세요.');}
  const intentHash=hash({targetId,owner:access.owner,use:input.use,text:input.text,binding}),at=this.clock();let admitted=false;
  const record=await this.deps.store.mutate(id,access.active,prior=>{
   if(prior){this.allowed(prior,targetId,access);if(prior.intentHash!==intentHash)throw Error('같은 요청 번호의 작업 내용이 바뀌었습니다.');return {record:prior,value:prior};}
   admitted=true;const r:StoredWorkroomThread={id,targetId,owner:access.owner,fingerprint:hash(binding),bootId:this.bootId,intentHash,title:input.text!.replace(/\s+/gu,' ').slice(0,80),agent:input.agent!,sessionId:null,state:'running',revision:1,createdAt:at,updatedAt:at,messages:[{...this.message(id,'user','request',input.text!),seq:1}],serviceExecution:{binding,call:input.use!,requests:[{id,intentHash:hash({text:input.text,use:input.use})}]}};return {record:r,value:r};
  },true);
  if(admitted)this.startUse(record,input.use!,id,access);return this.page(record);
 }
 private startUse(record:StoredWorkroomThread,call:ServiceUseCall,id:string,access:WorkroomThreadAccess){
  const job=(async()=>{
   let outcome:ServiceUseOutcome;
   try{outcome=await this.deps.use!.execute(record.targetId,access.owner,id,call,access.active,record.serviceExecution!.binding);}
   catch{outcome={state:'unknown',message:'USE 실행 결과를 확인해야 합니다. DEV 터미널로 전환하거나 자동 재실행하지 않습니다.'};}
   await this.finishUse(record.id,id,outcome,record.revision);
  })();this.flights.set(id,job);void job.finally(()=>this.flights.delete(id)).catch(()=>{});
 }
 private async finishUse(thread:string,id:string,outcome:ServiceUseOutcome,expectedRevision:number){
  await this.deps.store.mutate(thread,()=>true,r=>{
   if(!r?.serviceExecution)throw Error('USE 스레드 결속을 확인하세요.');
   if(r.revision!==expectedRevision&&r.messages.findLast(m=>m.role==='user')?.id===id)return {record:r,value:null,unchanged:true};
   const original=JSON.stringify(r);
   const resultId='use_'+hash(id);
   const existing=r.messages.find(m=>m.id===resultId);
   let changed=false;
   // A previous host can still finish after a newer status/cancel request was admitted.
   // Preserve its historical result without overwriting the latest request's receipt/state.
   if(r.messages.findLast(m=>m.role==='user')?.id===id){
    changed=hash(r.serviceExecution.outcome??null)!==hash(outcome);
    r.serviceExecution.outcome=outcome;
    if(r.state!=='closed')r.state=outcome.state==='cancelled'?'completed':outcome.state;
   }
   const request=r.messages.find(m=>m.id===id);if(request)request.delivery=outcome.state==='unknown'?'unknown':'written';
   if(existing){if(existing.text!==outcome.message||changed){existing.text=outcome.message;existing.at=this.clock();r.revision++;r.updatedAt=this.clock();}}
   else this.append(r,this.message(resultId,'assistant','result',outcome.message));return {record:r,value:null,...(JSON.stringify(r)===original?{unchanged:true as const}:{})};
  });
 }
 private async readUse(record:StoredWorkroomThread,access:WorkroomThreadAccess,before?:number){
  const previous=record.serviceExecution!.outcome;
  if(!this.flights.has(record.messages.findLast(m=>m.role==='user')!.id)&&(!previous||['running','unknown'].includes(previous.state)||record.serviceExecution!.call.tool==='phone.deliver'&&previous.evidence?.phoneReceived!==true)){
   const id=record.messages.findLast(m=>m.role==='user')!.id;
   let outcome:ServiceUseOutcome;try{outcome=await this.deps.use!.receipt(record.targetId,access.owner,id,access.active);}catch{outcome={state:'unknown',message:'재시작 전 USE 요청의 결과를 확인해야 합니다. 같은 작업을 자동 재실행하지 않습니다.'};}
   await this.finishUse(record.id,id,outcome,record.revision);
  }
  return this.page((await this.deps.store.get(record.id))!,before);
 }
 private async replyUse(record:StoredWorkroomThread,input:WorkroomThreadRequest,id:string,access:WorkroomThreadAccess){
  if(!input.use||input.use.serviceKey!==record.serviceExecution!.binding.serviceKey)return {...this.page(record),refusal:{requestId:id,message:'USE 후속 요청에는 같은 서비스의 제한된 도구를 선택하세요. 개발 요청은 DEV 담당자에게 인계하세요.'}};
  const binding=await this.deps.use!.bind(record.targetId,access.owner,input.use,access.active);
  if(hash(binding)!==hash(record.serviceExecution!.binding))throw Error('USE 실행 문맥이 변경되었습니다.');
  let admitted=false;
  try{await this.deps.store.mutate(record.id,access.active,r=>{
   this.allowed(r,record.targetId,access);const prior=r.messages.find(m=>m.id===id);
   if(prior){
    const saved=r.serviceExecution!.requests?.find(request=>request.id===id)?.intentHash
      ??(r.messages.findLast(m=>m.role==='user')?.id===id?hash({text:prior.text,use:r.serviceExecution!.call}):null);
    if(saved!==hash({text:input.text,use:input.use}))throw Error('같은 USE 답변 번호의 입력이 다릅니다.');return {record:r,value:null};
   }
   const control=input.use!.tool==='operation.status'||input.use!.tool==='operation.cancel';
   if(r.revision!==input.expectedRevision||!(['completed','failed'].includes(r.state)||control&&['running','unknown'].includes(r.state))||this.flights.has(r.messages.findLast(m=>m.role==='user')!.id))throw new WorkroomThreadAdmissionError('USE 실행 결과와 스레드의 최신 상태를 먼저 확인하세요.');
   r.serviceExecution={binding,call:input.use!,requests:[...(r.serviceExecution!.requests??[]),{id,intentHash:hash({text:input.text,use:input.use})}]};r.state='running';r.bootId=this.bootId;this.append(r,this.message(id,'user','reply',input.text!));admitted=true;return {record:r,value:null};
  });}catch(e){if(e instanceof WorkroomThreadAdmissionError)return {...this.page((await this.deps.store.get(record.id))!),refusal:{requestId:id,message:e.message}};throw e;}
  if(admitted)this.startUse((await this.deps.store.get(record.id))!,input.use,id,access);return this.page((await this.deps.store.get(record.id))!);
 }
 private async readSingle(r:StoredWorkroomThread,targetId:string,access:WorkroomThreadAccess,beforeSeq?:number):Promise<WorkroomThreadResult>{
  this.allowed(r,targetId,access);
  if((await this.deps.resolve(targetId)).fingerprint!==r.fingerprint)throw Error('원래 프로젝트 폴더가 변경되었습니다. 이전 스레드를 다른 폴더에 연결하지 않습니다.');
  if(['starting','running','needs-answer'].includes(r.state)&&r.bootId!==this.bootId&&!r.continuation)await this.deps.store.mutate(r.id,access.active,current=>{this.allowed(current,targetId,access);if(['starting','running','needs-answer'].includes(current.state)&&current.bootId!==this.bootId&&!current.continuation){current.state='unknown';this.append(current,this.message(randomUUID(),'system','notice','앱 재시작 전 워크룸의 실행 결과를 확인해야 합니다. 같은 작업을 자동으로 다시 실행하지 않습니다.'));}return {record:current,value:null};});
  return this.page((await this.deps.store.get(r.id))!,beforeSeq);
 }
 private async groupAccess(r:StoredWorkroomThread,targetId:string,access:WorkroomThreadAccess){
  this.allowed(r,targetId,access);
  if(!r.group)throw Error('공동 업무 스레드가 아닙니다.');
  for(const member of r.group.members){
   if(access.targets&&!access.targets.has(member.targetId))throw Error('이 업무의 모든 프로젝트에 대한 연결 권한이 필요합니다.');
   const child=await this.deps.store.get(member.threadId);
   if(!child||child.groupParentId!==r.id||child.owner!==r.owner||child.targetId!==member.targetId||(await this.deps.resolve(member.targetId)).fingerprint!==child.fingerprint)throw Error('공동 업무의 프로젝트 폴더 또는 연결이 변경되었습니다.');
  }
  if(!access.active())throw Error('공동 업무 권한이 변경되었습니다.');
 }
 private async createGroup(id:string,targetId:string,input:WorkroomThreadRequest,access:WorkroomThreadAccess){
  const targets=[...input.targetIds!].sort();
  if(!targets.includes(targetId)||targets.some(t=>access.targets&&!access.targets.has(t)))throw Error('호출할 프로젝트의 연결 권한을 확인하세요.');
  const intentHash=hash({targetId,targets,owner:access.owner,agent:input.agent,text:input.text});
  const prior=await this.deps.store.get(id);if(prior){await this.groupAccess(prior,targetId,access);if(prior.intentHash!==intentHash)throw Error('같은 요청 번호의 작업 내용이 바뀌었습니다.');return this.page(prior);}
  const at=this.clock(),children:StoredWorkroomThread[]=[];
  for(const target of targets){const binding=await this.deps.resolve(target),childId='member_'+hash([id,target]).slice(0,48);
   children.push({id:childId,targetId:target,owner:access.owner,fingerprint:binding.fingerprint,bootId:this.bootId,intentHash:hash([intentHash,target]),title:input.text!.replace(/\s+/gu,' ').slice(0,80),agent:input.agent!,sessionId:null,state:'starting',revision:1,createdAt:at,updatedAt:at,groupParentId:id,messages:[{...this.message(childId,'user','request',input.text!),seq:1}]});
  }
  const anchor=children.find(c=>c.targetId===targetId)!;
  const members=[];for(const c of children){const binding=await this.deps.resolve(c.targetId);if(binding.fingerprint!==c.fingerprint)throw Error('호출 전 프로젝트 폴더가 변경되었습니다.');members.push({targetId:c.targetId,label:sharedThreadProjectLabel(binding.label??'프로젝트'),threadId:c.id,sessionId:null,agent:c.agent,state:c.state,revision:c.revision});}
  const parent:StoredWorkroomThread={...anchor,id,intentHash,groupParentId:undefined,group:{members},messages:sharedThreadTextParts(input.text!).map((text,index)=>({...this.message(index?'part_'+hash([id,index]):id,'user','request',text),seq:index+1}))};
  const admitted=await this.deps.store.admitGroup(parent,children,access.active);
  if(admitted)for(const child of children){const job=this.launch(child,{...access,active:()=>access.active()&&(!access.targets||access.targets.has(child.targetId))});this.flights.set(child.id,job);void job.finally(()=>this.flights.delete(child.id)).catch(()=>{});}
  return this.page((await this.deps.store.get(id))!);
 }
 private async performGroup(action:WorkroomThreadAction,input:WorkroomThreadRequest,r:StoredWorkroomThread,targetId:string,id:string,access:WorkroomThreadAccess):Promise<WorkroomThreadResult>{
  await this.groupAccess(r,targetId,access);
  if(action==='workroom.threads.read'){
   // Let each original Workroom apply its existing restart/continuation fences.
   for(const m of r.group!.members){const child=await this.deps.store.get(m.threadId);this.allowed(child,m.targetId,access);await this.readSingle(child,m.targetId,access);}
   return this.page((await this.deps.store.get(r.id))!,input.beforeSeq);
  }
  if(action==='workroom.threads.close'){
   await this.deps.store.mutate(r.id,access.active,current=>{this.allowed(current,targetId,access);if(current.messages.some(m=>m.id===id))return {record:current,value:null};if(current.revision!==input.expectedRevision)throw Error('스레드가 갱신되었거나 답변을 전송 중입니다.');current.state='closed';this.append(current,this.message(id,'system','notice','공동 업무를 종료 표시했습니다. 연결 워크룸은 별도로 유지됩니다.'));return {record:current,value:null};});
   return this.page((await this.deps.store.get(r.id))!);
  }
  const member=r.group!.members.find(m=>m.targetId===input.recipientTargetId);
  if(!member)throw Error('답변을 보낼 @프로젝트를 선택하세요.');
  const prior=r.messages.find(m=>m.id===id);if(prior){if((await this.deps.store.get(member.threadId))?.messages.find(m=>m.id===id)?.text!==input.text||prior.targetId!==member.targetId)throw Error('같은 답변 번호의 내용 또는 대상이 변경되었습니다.');return this.page(r);}
  if(r.state==='closed')throw Error('종료 표시된 공동 업무입니다.');
  try{await this.deps.store.mutate(r.id,access.active,current=>{
   this.allowed(current,targetId,access);
   if(current.group!.pendingReply)throw new WorkroomThreadAdmissionError('이전 답변의 전송 결과를 확인하세요. 같은 답변을 자동 재전송하지 않습니다.');
   if(current.revision!==input.expectedRevision)throw new WorkroomThreadAdmissionError('스레드가 갱신되었습니다. 프로젝트의 새 결과를 확인하세요.');
   current.group!.pendingReply={id,targetId:member.targetId,textHash:hash(input.text)};current.revision++;return {record:current,value:null};
  });}catch(e){if(e instanceof WorkroomThreadAdmissionError)return {...this.page((await this.deps.store.get(r.id))!),refusal:{requestId:id,message:e.message}};throw e;}
  let result:WorkroomThreadResult|undefined;
  try{const child=(await this.deps.store.get(member.threadId))!;result=await this.reply(child,{...input,threadId:child.id,recipientTargetId:undefined,expectedRevision:member.revision},id,access);}
  catch(e){result={refusal:{requestId:id,message:(e instanceof Error?e.message:String(e)).slice(0,500)}};}
  await this.deps.store.mutate(r.id,()=>true,current=>{
   if(!current?.group||current.group.pendingReply?.id!==id)throw Error('공동 답변 영수증이 변경되었습니다.');
   delete current.group.pendingReply;
   if(!current.messages.some(m=>m.id===id)&&!result?.refusal){current.state='unknown';this.append(current,this.message(id,'system','notice','답변의 전송 결과를 확인해야 합니다. 자동 재전송하지 않습니다.'));}
   current.revision++;return {record:current,value:null};
  });
  return {...this.page((await this.deps.store.get(r.id))!),...(result?.refusal?{refusal:result.refusal}:{})};
 }
 private async create(id:string,targetId:string,input:WorkroomThreadRequest,access:WorkroomThreadAccess):Promise<WorkroomThreadResult>{
  const intentHash=hash({targetId,owner:access.owner,agent:input.agent,text:input.text});
  const previous=await this.deps.store.get(id);if(previous){this.allowed(previous,targetId,access);if(previous.intentHash!==intentHash)throw Error('같은 요청 번호의 작업 내용이 바뀌었습니다.');return this.page(previous);}
  const resolved=await this.deps.resolve(targetId),at=this.clock();let admitted=false;
  await access.withInputContext?.(async()=>undefined);
  const initial:StoredWorkroomThread={id,targetId,owner:access.owner,fingerprint:resolved.fingerprint,bootId:this.bootId,intentHash,title:input.text!.replace(/\s+/gu,' ').slice(0,80),agent:input.agent!,sessionId:null,state:'starting',revision:1,createdAt:at,updatedAt:at,messages:[{...this.message(id,'user','request',input.text!),seq:1}]};
  const record=await this.deps.store.mutate(id,access.active,current=>{if(current){this.allowed(current,targetId,access);if(current.intentHash!==intentHash)throw Error('같은 요청 번호의 작업 내용이 바뀌었습니다.');return {record:current,value:current};}admitted=true;return {record:initial,value:initial};},true);
  if(!admitted)return this.page(record);
  // Admission is durable before any CLI starts. The original ID's terminal launch receipt fences crashes as well.
  const job=this.launch(record,access);this.flights.set(id,job);void job.finally(()=>this.flights.delete(id)).catch(()=>{});
  return this.page(record);
 }
 private async launch(record:StoredWorkroomThread,access:WorkroomThreadAccess){
  try{
   const resolved=await this.deps.resolve(record.targetId);if(resolved.fingerprint!==record.fingerprint)throw Error('프로젝트 폴더가 변경되어 워크룸을 열지 않았습니다.');
   if(!access.active())throw Error('연결 권한이 변경되어 워크룸을 열지 않았습니다.');
   const shared=record.groupParentId?await this.deps.store.get(record.groupParentId):null;
   const participant=shared?.group?.members.find(m=>m.threadId===record.id);
   const prompt=`${record.messages[0]!.text}\n\n${record.groupParentId?`[공동 업무] 참여: ${shared?.group?.members.map(m=>'@'+m.label).join(', ')}. 현재 담당: @${participant?.label??'현재 프로젝트'}. 본문의 @호출별 요청 중 자신의 담당 범위를 수행하세요. 여러 프로젝트가 각자 워크룸에서 이 업무를 수행합니다. 현재 프로젝트에서 맡은 작업만 수행하고 진행·질문·결과에는 현재 프로젝트를 분명히 밝혀 주세요. 다른 프로젝트의 기록은 공유 업무 문맥이며 다른 폴더에서 직접 실행하라는 지시가 아닙니다.\n\n`:''}[AgentsToZ 업무 스레드]\n이 워크룸은 커뮤니티 업무 스레드와 연결되어 있습니다. 진행 상황·사용자 질문·최종 결과를 agentstoz_use_publish_workroom_thread 도구로 남기세요. 질문은 kind=question으로 남기고 이 대화에서 사용자의 답을 기다리세요. 완료는 실제 수행·검증 근거와 함께 kind=result로 남기세요. 프로젝트 장기기억은 기존 저장 동의와 세션 기억하기 절차를 따릅니다.`;
   const start=()=>this.deps.start(record.id,record.targetId,record.agent,prompt,access.active,record.fingerprint);
   const outcome=access.withInputContext?await access.withInputContext(start):await start();
   await this.deps.store.mutate(record.id,()=>true,r=>{
    if(!r)throw Error('업무 스레드를 찾을 수 없습니다.');r.sessionId=outcome.session?.id??null;if(r.state!=='closed')r.state=outcome.written&&r.sessionId?'running':'unknown';r.messages[0]!.delivery=outcome.written?'written':'unknown';r.updatedAt=this.clock();r.revision++;
    if(!outcome.written)this.append(r,this.message(randomUUID(),'system','notice','워크룸 시작 결과를 확인해야 합니다. 같은 요청을 자동으로 다시 실행하지 않습니다.'));
    return {record:r,value:null};
   });
   if(outcome.session){this.sessionLinks.set(outcome.session.id,record.id);if(outcome.written&&outcome.session.state==='exited')await this.ended(outcome.session.id);}
  }catch(error){await this.deps.store.mutate(record.id,()=>true,r=>{if(!r)throw error;r.state='unknown';r.messages[0]!.delivery='unknown';this.append(r,this.message(randomUUID(),'system','notice',(error instanceof Error?error.message:'워크룸 열기 결과를 확인하지 못했습니다.').slice(0,500)));return {record:r,value:null};});}
 }
 private async reply(record:StoredWorkroomThread,input:WorkroomThreadRequest,id:string,access:WorkroomThreadAccess){
  const existing=record.messages.find(m=>m.id===id);if(existing){if(existing.text!==input.text)throw Error('같은 답변 번호의 내용이 변경되었습니다.');return this.page(record);}
  if(!record.sessionId||!['running','needs-answer','completed'].includes(record.state))throw Error('실행 중인 연결 워크룸에서만 답변할 수 있습니다.');
  if(record.checkpoint?.state==='saving')return {...this.page(record),refusal:{requestId:id,message:'컨텍스트 세션을 저장하고 있습니다. 완료 후 새 글을 보내세요.'}};
  if(!record.continuation&&record.state==='needs-answer'&&record.messages.findLast(m=>m.kind==='question')?.role==='system')return {...this.page(record),refusal:{requestId:id,message:'이 질문은 CLI의 승인·선택 화면입니다. 연결 워크룸에서 현재 선택지를 확인하고 답하세요.'}};
  const binding=await this.deps.resolve(record.targetId);if(binding.fingerprint!==record.fingerprint)throw Error('원래 프로젝트 폴더가 변경되었습니다.');
  await access.withInputContext?.(async()=>undefined);
  if(record.continuation)return this.continue(record,input,id,access);
  const inspected=this.deps.inspect(record.sessionId,record.targetId);
  if(inspected.state!=='running'){
   if(inspected.state==='exited'&&record.bootId===this.bootId&&record.revision===input.expectedRevision){
    await this.ended(record.sessionId);const ended=(await this.deps.store.get(record.id))!;
    if(ended.continuation&&ended.revision===record.revision+1&&ended.messages.at(-1)?.id===`exit_${record.sessionId}`)return this.continue(ended,{...input,expectedRevision:ended.revision},id,access);
   }
   return {...this.page((await this.deps.store.get(record.id))!),refusal:{requestId:id,message:'연결 워크룸의 종료 상태를 갱신했습니다. 기존 기록을 확인하고 후속 글을 다시 보내세요.'}};
  }
  try{await this.deps.store.mutate(record.id,access.active,r=>{this.allowed(r,record.targetId,access);if(r.revision!==input.expectedRevision)throw new WorkroomThreadAdmissionError('스레드가 갱신되었습니다. 새 질문과 답변을 확인하고 다시 보내세요.');
   r.state='running';this.append(r,this.message(id,'user','reply',input.text!));return {record:r,value:null};},true);}catch(error){if(error instanceof WorkroomThreadAdmissionError)return {...this.page((await this.deps.store.get(record.id))!),refusal:{requestId:id,message:error.message}};throw error;}
  let written=false;
  try{const reply=()=>this.deps.reply(id,record.sessionId!,input.text!,inspected.inputRevision,access.active,record.fingerprint);written=(access.withInputContext?await access.withInputContext(reply):await reply()).written;}
  catch{/* The prepared answer remains visible, with an uncertain outcome. Never auto-replay. */}
  await this.deps.store.mutate(record.id,()=>true,r=>{if(!r)throw Error('스레드를 찾을 수 없습니다.');const m=r.messages.find(m=>m.id===id)!;m.delivery=written?'written':'unknown';if(r.state!=='closed'&&!r.messages.some(v=>v.seq>m.seq&&(v.kind==='question'||v.kind==='result')))r.state=written?'running':'unknown';r.revision++;r.updatedAt=this.clock();return {record:r,value:null};});
  return this.page((await this.deps.store.get(record.id))!);
 }
 private async continue(record:StoredWorkroomThread,input:WorkroomThreadRequest,id:string,access:WorkroomThreadAccess){
  if(!this.deps.open)throw Error('이 호스트는 종료된 워크룸 이어 열기를 지원하지 않습니다.');
  if(record.messages.some(m=>m.role==='user'&&m.delivery!=='written')||(record.previousSessions?.length??0)>=128)throw Error('이전 전송 결과 또는 워크룸 기록 한도를 확인하세요.');
  try{await this.deps.store.mutate(record.id,access.active,r=>{
   this.allowed(r,record.targetId,access);
   if(r.revision!==input.expectedRevision||r.sessionId!==record.sessionId||!r.continuation)throw new WorkroomThreadAdmissionError('스레드가 갱신되었습니다. 다시 확인하세요.');
   r.state='starting';r.bootId=this.bootId;delete r.continuation;
   this.append(r,this.message(id,'user','reply',input.text!));return {record:r,value:null};
  },true);}catch(error){if(error instanceof WorkroomThreadAdmissionError)return {...this.page((await this.deps.store.get(record.id))!),refusal:{requestId:id,message:error.message}};throw error;}
  const prompt=record.continuation!.mode==='fresh'?`[AgentsToZ 업무 스레드 이어가기]\n프로젝트 장기기억을 읽고 agentstoz_use_read_workroom_thread로 이 스레드의 이전 기록을 필요한 만큼 확인하세요. 이전 요청·완료 결과는 기록이며 자동으로 재실행하지 마세요. 아래 신규 요청만 이어 수행하고 진행·질문·결과는 agentstoz_use_publish_workroom_thread로 남기세요.\n\n[신규 사용자 요청]\n${input.text}`:input.text!;
  let session:AiTerminalSummary|undefined,written=false;
  try{
   session=await this.deps.open(id,record,access.active);
   if(!session||session.targetId!==record.targetId||session.agent!==record.agent||session.state!=='running')throw Error('이어 연 워크룸의 시작 결과를 확인하지 못했습니다.');
   await this.deps.store.mutate(record.id,()=>true,r=>{
    if(!r||r.sessionId!==record.sessionId)throw Error('연결 워크룸이 변경되었습니다.');
    r.previousSessions=[...(r.previousSessions??[]),record.sessionId!];r.sessionId=session!.id;r.bootId=this.bootId;r.revision++;
    r.preparedInput={sessionId:session!.id,id,hash:hash(prompt)};
    this.append(r,this.message(randomUUID(),'system','notice',record.continuation!.mode==='fresh'?'저장된 프로젝트 기억과 기존 스레드를 이어 새 컨텍스트를 열었습니다.':'원래 CLI 계정의 저장된 대화로 워크룸을 다시 열었습니다.'));
    return {record:r,value:null};
   });
   this.sessionLinks.delete(record.sessionId!);this.sessionLinks.set(session.id,record.id);
   await this.deps.ready?.(session,access.active);
   if(!access.active()||(await this.deps.resolve(record.targetId)).fingerprint!==record.fingerprint)throw Error('워크룸 재개 권한 또는 프로젝트가 변경되었습니다.');
   if(this.deps.inspect(session.id,record.targetId).inputRevision!==0)throw Error('새 워크룸에 다른 입력이 있습니다. 자동 전송하지 않습니다.');
   const reply=()=>this.deps.reply(id,session!.id,prompt,0,access.active,record.fingerprint);
   written=(access.withInputContext?await access.withInputContext(reply,{excludeWorkroomSessionId:session.id}):await reply()).written;
  }catch{/* The recorded admission and CLI/history receipts fence an ambiguous open/write. */}
  await this.deps.store.mutate(record.id,()=>true,r=>{
   if(!r)throw Error('스레드를 찾을 수 없습니다.');const m=r.messages.find(m=>m.id===id)!;m.delivery=written?'written':'unknown';
   delete r.preparedInput;
   if(r.state!=='closed'&&!r.messages.some(v=>v.seq>m.seq&&(v.kind==='question'||v.kind==='result')))r.state=written?'running':'unknown';
   if(!written)this.append(r,this.message(randomUUID(),'system','notice','워크룸 이어 열기 또는 전송 결과를 확인해야 합니다. 같은 요청을 자동으로 다시 실행하지 않습니다.'));
   r.revision++;r.updatedAt=this.clock();return {record:r,value:null};
  });
  return this.page((await this.deps.store.get(record.id))!);
 }
 /** Bound read for a replacement CLI: full encrypted thread stays paginated, never copied into history metadata. */
 async readSession(sessionId:string,beforeSeq?:number){
  const r=await this.forSession(sessionId);if(!r)throw Error('이 워크룸에 연결된 커뮤니티 업무 스레드가 없습니다.');
  if((await this.deps.resolve(r.targetId)).fingerprint!==r.fingerprint)throw Error('원래 프로젝트 폴더가 변경되었습니다.');
  if(r.groupParentId){const parent=await this.deps.store.get(r.groupParentId);if(!parent)throw Error('공동 업무 스레드를 찾을 수 없습니다.');await this.groupAccess(parent,r.targetId,{owner:r.owner,active:()=>true,readAll:false});return this.page(parent,beforeSeq);}
  return this.page(r,beforeSeq);
 }
 /** Runs on the existing host maintenance tick, at most one checkpoint per pass. No new timer or AI scheduler. */
 async checkpointTick(){
  if(this.checking||!this.deps.checkpointEvidence||!this.deps.checkpoint)return;this.checking=true;
  try{for(const [sessionId,id] of this.sessionLinks){try{
   if(!id)continue;const r=await this.deps.store.get(id);
   if(!r||r.sessionId!==sessionId||r.bootId!==this.bootId||r.continuation&&r.checkpoint?.state!=='saving'||!['running','completed','needs-answer'].includes(r.state))continue;
   if(r.checkpoint?.sessionId===sessionId&&r.checkpoint.state!=='saving')continue;
   if(!r.checkpoint||r.checkpoint.sessionId!==sessionId){
    if(r.messages.some(m=>m.role==='user'&&m.delivery!=='written'))continue;
    const evidence=await this.deps.checkpointEvidence(r);if(!evidence)continue;
    const revision=r.revision;
    await this.deps.store.mutate(r.id,()=>true,current=>{
     if(!current||current.sessionId!==sessionId||current.revision!==revision)throw Error('저장 전 스레드가 변경되었습니다.');
     current.checkpoint={id:randomUUID(),sessionId,inputRevision:evidence.inputRevision,turnCompletedAt:evidence.turnCompletedAt,state:'saving',completed:current.state==='completed'};current.state='running';
     this.append(current,this.message(randomUUID(),'system','notice','컨텍스트 70%에 도달하여 완료된 턴을 저장합니다. 저장 확인 전까지 워크룸을 유지합니다.'));
     return {record:current,value:null};
    },true);
   }
   const current=(await this.deps.store.get(r.id))!;
   const outcome=await this.deps.checkpoint(current);
   if(outcome!=='saving')await this.deps.store.mutate(r.id,()=>true,saved=>{
    if(!saved||saved.sessionId!==sessionId||saved.checkpoint?.id!==current.checkpoint!.id)throw Error('저장 대상 워크룸이 변경되었습니다.');
    saved.checkpoint.state=outcome;
    if(outcome==='closed'){
     saved.continuation={sessionId,mode:'fresh'};if(saved.state!=='closed')saved.state=saved.checkpoint.completed?'completed':'needs-answer';
     this.append(saved,this.message(randomUUID(),'system','notice','로컬 세션 저장과 종료를 확인했습니다. 다음 글을 보내면 새 컨텍스트에서 프로젝트 기억과 이 스레드를 이어갑니다.'));
    }else this.append(saved,this.message(randomUUID(),'system','notice','저장·종료를 확인하지 못했거나 새 입력이 있습니다. 워크룸을 유지하며 같은 저장을 자동 재실행하지 않습니다. Mac에서 저장 상태를 확인하세요.'));
    return {record:saved,value:null};
   });
   if(outcome==='closed')this.sessionLinks.delete(sessionId);
   break;
  }catch{/* One removed project cannot starve another thread. Its durable intent is never replayed. */}
  }}catch{/* Durable saving/blocked state remains visible; never replay a failed or uncertain operation. */}finally{this.checking=false;}
 }
 /** Mirrors a whole request written from the Workroom composer. It never sends it back to the CLI. */
 async input(sessionId:string,text:string,revision:number){
  const r=await this.forSession(sessionId);if(!r)return;
  if((await this.deps.resolve(r.targetId)).fingerprint!==r.fingerprint)throw Error('원래 프로젝트 폴더가 변경되었습니다.');
  const plain=text.replace(/\r$/u,'');if(!plain.trim())return;if(r.preparedInput?.sessionId!==sessionId||r.preparedInput.hash!==hash(plain))workroomThreadText(plain);
  await this.deps.store.mutate(r.id,()=>true,current=>{if(!current||current.sessionId!==sessionId)throw Error('연결 워크룸이 변경되었습니다.');
   const prepared=current.preparedInput?.sessionId===sessionId&&current.preparedInput.hash===hash(plain)?current.messages.find(m=>m.id===current.preparedInput!.id):current.messages.find(m=>m.role==='user'&&m.delivery==='recorded'&&m.text===plain);
   if(prepared)prepared.delivery='written';else this.append(current,this.message(`input_${sessionId}_${revision}`,'user','reply',plain,'written'));
   if(!['completed','failed','closed'].includes(current.state)&&!current.messages.some(m=>m.role==='assistant'&&m.seq>(prepared?.seq??Infinity)))current.state='running';return {record:current,value:null};});
 }
 /** Mirror intent is durable before the PTY write. A partial write stays visibly uncertain. */
 async prepareInput(sessionId:string,text:string,revision:number):Promise<(()=>Promise<void>)|undefined>{
  const r=await this.forSession(sessionId);if(!r)return;
  if((await this.deps.resolve(r.targetId)).fingerprint!==r.fingerprint)throw Error('원래 프로젝트 폴더가 변경되었습니다.');
  const plain=text.replace(/\r$/u,'');if(!plain.trim())return;if(r.preparedInput?.sessionId!==sessionId||r.preparedInput.hash!==hash(plain))workroomThreadText(plain);
  let messageId=`input_${sessionId}_${revision}`;
  await this.deps.store.mutate(r.id,()=>true,current=>{
   if(!current||current.sessionId!==sessionId)throw Error('연결 워크룸이 변경되었습니다.');
   const prepared=current.preparedInput?.sessionId===sessionId&&current.preparedInput.hash===hash(plain)?current.messages.find(m=>m.id===current.preparedInput!.id):current.messages.find(m=>m.role==='user'&&m.delivery==='recorded'&&m.text===plain);
   if(prepared){messageId=prepared.id;prepared.delivery='unknown';current.revision++;}
   else this.append(current,this.message(messageId,'user','reply',plain,'unknown'));
   if(!['closed','failed'].includes(current.state))current.state='unknown';
   return {record:current,value:null};
  },true);
  return async()=>{await this.deps.store.mutate(r.id,()=>true,current=>{
   if(!current||current.sessionId!==sessionId)throw Error('연결 워크룸이 변경되었습니다.');const message=current.messages.find(m=>m.id===messageId)!;message.delivery='written';
   if(!['completed','closed','failed'].includes(current.state)&&!current.messages.some(m=>m.seq>message.seq&&(m.kind==='question'||m.kind==='result')))current.state='running';
   current.revision++;current.updatedAt=this.clock();return {record:current,value:null};
  });};
 }
 /** An observed CLI approval screen is never automatically approved. */
 async questionScreen(sessionId:string,rows:readonly string[],revision:number){
  if(this.questionRevisions.get(sessionId)===revision)return;
  const r=await this.forSession(sessionId);if(!r||['completed','closed','failed'].includes(r.state))return;
  const id=`screen_${sessionId}_${revision}`;if(r.messages.some(m=>m.id===id))return;
  const text='워크룸에서 답변 또는 승인을 기다리고 있습니다.\n'+rows.slice(-18).join('\n').trim();
  let bounded='';for(const c of text){if(Buffer.byteLength(JSON.stringify(bounded+c))>5800)break;bounded+=c;}
  await this.deps.store.mutate(r.id,()=>true,current=>{if(!current||current.sessionId!==sessionId)throw Error('연결 워크룸이 변경되었습니다.');if(!['completed','closed','failed'].includes(current.state)){this.append(current,this.message(id,'system','question',bounded));current.state='needs-answer';}return {record:current,value:null};});this.questionRevisions.set(sessionId,revision);
 }
 async ended(sessionId:string){
  const r=await this.forSession(sessionId);this.questionRevisions.delete(sessionId);if(!r||['closed','failed'].includes(r.state)){this.sessionLinks.delete(sessionId);return;}
  await this.deps.store.mutate(r.id,()=>true,current=>{
   if(!current||current.sessionId!==sessionId)throw Error('스레드를 찾을 수 없습니다.');
   if(!['closed','failed','unknown','starting'].includes(current.state)&&!current.messages.some(m=>m.role==='user'&&m.delivery!=='written')){
    current.continuation={sessionId,mode:'resume'};if(current.state!=='completed')current.state='needs-answer';
    this.append(current,this.message(`exit_${sessionId}`,'system','notice','연결 워크룸이 종료됐습니다. 새 글을 보내면 원래 계정의 저장된 대화를 확인하고 다시 엽니다. 미확정 전송은 자동 재실행하지 않습니다.'));
   }return {record:current,value:null};
  });
  if(r.checkpoint?.state!=='saving')this.sessionLinks.delete(sessionId);
 }
 /** Exact host-observed final reply. It cannot execute work, confirm uncertain delivery, or cross a newer input. */
 async completed(sessionId:string,completion:{key:string;resultText:string},revision:number,active:()=>boolean){
  const text=workroomTurnResultText(completion.resultText);if(!text||!active())return;
  const r=await this.forSession(sessionId);if(!r)return;
  const current=()=>active()&&this.deps.inspect(sessionId,r.targetId).inputRevision===revision;
  if(!current()||(await this.deps.resolve(r.targetId)).fingerprint!==r.fingerprint)return;
  await this.deps.store.mutate(r.id,current,saved=>{
   if(!saved||saved.sessionId!==sessionId)throw Error('연결 워크룸이 변경되었습니다.');
   if(['closed','failed'].includes(saved.state))return {record:saved,value:null};
   if(saved.completionResult?.sessionId===sessionId&&saved.completionResult.key===completion.key)return {record:saved,value:null};
   const request=saved.messages.findLast(m=>m.role==='user');
   if(!request||request.delivery!=='written')return {record:saved,value:null};
   const published=this.hasResultText(saved,text);
   if(!published)for(const [index,part] of sharedThreadTextParts(text).entries())this.append(saved,this.message('completion_'+hash([sessionId,completion.key,index]),'assistant','result',part));
   saved.completionResult={sessionId,inputRevision:revision,key:completion.key};saved.state='completed';saved.revision++;saved.updatedAt=this.clock();
   return {record:saved,value:null};
  });
 }
 async publish(sessionId:string,id:string,kind:'progress'|'question'|'result',text:string){
  workroomThreadText(text);const r=await this.forSession(sessionId);if(!r)throw Error('이 워크룸에 연결된 커뮤니티 업무 스레드가 없습니다.');
  await this.deps.store.mutate(r.id,()=>true,current=>{if(!current||current.sessionId!==sessionId)throw Error('연결 워크룸을 확인하세요.');
   const previous=current.messages.find(m=>m.id===id);if(previous){if(previous.text!==text||previous.kind!==kind)throw Error('같은 게시 번호의 내용이 변경되었습니다.');return {record:current,value:null};}
   // The explicit tool can race the host observation of the same final text.
   if(kind==='result'&&current.completionResult?.sessionId===sessionId&&current.completionResult.inputRevision===this.deps.inspect(sessionId,current.targetId).inputRevision){
    if(this.hasResultText(current,text))return {record:current,value:null};
   }
   this.append(current,this.message(id,'assistant',kind,text));if(current.state!=='closed'&&(current.state!=='completed'||kind==='result'))current.state=kind==='result'?'completed':kind==='question'?'needs-answer':'running';return {record:current,value:null};});
  return {threadId:r.groupParentId??r.id,recorded:true};
 }
 async idle(){await Promise.allSettled([...this.flights.values()]);}
}
