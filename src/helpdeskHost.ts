import {createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathEntryExists,readPrivateFileStrict,writePrivateFileAtomically} from './remoteControlHostVault';
import {withOwnedPortalFileLock} from './portalFileLock';
import {redactWhatISaidForFeed} from './whatISaidRedaction';
import {helpdeskPrompt,type HelpdeskProvider} from './helpdeskKnowledge';

export type HelpdeskConnection = 'unknown'|'missing'|'signed-out'|'ready'|'unsupported';
export interface HelpdeskJob {id:string;provider:HelpdeskProvider;kind:'question'|'login';question:string;answer:string;state:'running'|'answered'|'failed'|'cancelled'|'interrupted';message:string;createdAt:number}
interface Stored {schemaVersion:1;revision:number;ownerPid:number|null;jobs:(HelpdeskJob&{fingerprint:string})[]}
export interface HelpdeskView {revision:number;connections:Record<HelpdeskProvider,HelpdeskConnection>;checkedAt:number|null;jobs:HelpdeskJob[]}
export interface HelpdeskEffects {
  check(provider:HelpdeskProvider):Promise<HelpdeskConnection>;
  answer(provider:HelpdeskProvider,prompt:string,signal:AbortSignal,id:string):Promise<string>;
  loginClaude(signal:AbortSignal):Promise<void>;
  context():unknown;
}
const fingerprint=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clean=(v:string)=>{const r=redactWhatISaidForFeed(v);if(r.withheld)throw Error('키·토큰·비밀번호를 질문에 넣지 마세요. 비밀값을 지운 뒤 다시 보내세요.');return r.text??'';};
export async function readHelpdeskRequest(req:Request):Promise<unknown>{
  if(Number(req.headers.get('content-length'))>16000)throw Error('지원 질문이 너무 큽니다.');
  const reader=req.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
  if(reader)try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16000){await reader.cancel();throw Error('지원 질문이 너무 큽니다.');}chunks.push(part.value);}}finally{reader.releaseLock();}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}
/** Local bounded support history, separate from OPS/project memory. Admission is durable before one AI call.
 * Losing the response or restarting never resubmits an admitted question. */
export class HelpdeskHost {
  private file:string;private closed=false;private active:{id:string;abort:AbortController;done:Promise<void>}|null=null;
  private connections:Record<HelpdeskProvider,HelpdeskConnection>={codex:'unknown',claude:'unknown'};
  private checkedAt:number|null=null;
  constructor(private directory:string,private effects:HelpdeskEffects){mkdirSync(directory,{recursive:true,mode:0o700});this.file=join(directory,'support-history.json');}
  private read():Stored {
    const text=readPrivateFileStrict(this.file);
    if(text===null&&pathEntryExists(this.file))throw Error('지원 기록을 안전하게 읽지 못했습니다. 원본을 보존했습니다.');
    if(text===null)return {schemaVersion:1,revision:0,ownerPid:null,jobs:[]};
    if(Buffer.byteLength(text)>256_000)throw Error('지원 기록의 크기를 확인하세요.');
    const d=JSON.parse(text) as Stored;
    if(d.schemaVersion!==1||!Number.isSafeInteger(d.revision)||d.revision<0||!Array.isArray(d.jobs)||d.jobs.length>12||d.jobs.some(j=>!j||typeof j.id!=='string'||typeof j.fingerprint!=='string'||!['codex','claude'].includes(j.provider)||!['question','login'].includes(j.kind)||!['running','answered','failed','cancelled','interrupted'].includes(j.state)||typeof j.question!=='string'||j.question.length>2000||typeof j.answer!=='string'||j.answer.length>3000||typeof j.message!=='string'||!Number.isFinite(j.createdAt)))throw Error('지원 기록을 확인하지 못했습니다. 기존 기록을 보존했습니다.');
    return d;
  }
  private save(d:Stored){const text=JSON.stringify(d);if(Buffer.byteLength(text)>256_000)throw Error('지원 기록의 크기를 확인하세요.');writePrivateFileAtomically(this.directory,this.file,text);}
  status():HelpdeskView {const d=this.read();return {revision:d.revision,connections:{...this.connections},checkedAt:this.checkedAt,jobs:d.jobs.map(({fingerprint:_,...j})=>({...j}))};}
  async handle(raw:unknown):Promise<HelpdeskView>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('지원 요청 형식을 확인하세요.');
    const r=raw as Record<string,unknown>;
    if(Object.keys(r).some(k=>!['operation','provider','question','requestId','expectedRevision','id'].includes(k)))throw Error('지원하지 않는 지원 요청입니다.');
    if(r.operation==='status'&&Object.keys(r).length===1)return this.status();
    if(r.operation==='check'&&Object.keys(r).length===1){
      const [codex,claude]=await Promise.allSettled([this.effects.check('codex'),this.effects.check('claude')]);
      this.connections={codex:codex.status==='fulfilled'?codex.value:'unknown',claude:claude.status==='fulfilled'?claude.value:'unknown'};
      this.checkedAt=Date.now();return this.status();
    }
    if(r.operation==='cancel'&&Object.keys(r).length===2&&typeof r.id==='string'){
      if(this.active?.id===r.id){this.active.abort.abort();await this.active.done;}return this.status();
    }
    if(this.closed||!['ask','login'].includes(String(r.operation))||!['codex','claude'].includes(String(r.provider))||typeof r.requestId!=='string'||!/^[a-zA-Z0-9-]{8,100}$/.test(r.requestId)||!Number.isSafeInteger(r.expectedRevision))throw Error('최신 지원 상태를 확인한 뒤 다시 요청하세요.');
    if(r.operation==='login'&&(r.provider!=='claude'||r.question!==undefined)||r.id!==undefined)throw Error('공식 로그인 요청을 확인하세요.');
    const question=r.operation==='ask'&&typeof r.question==='string'?clean(r.question.trim()):'';
    if(r.operation==='ask'&&(!question||question.length>2000))throw Error('질문은 1~2,000자로 입력하세요.');
    const key=fingerprint({kind:r.operation,provider:r.provider,question});
    await withOwnedPortalFileLock(this.file+'.lock',async()=>{
      const d=this.read();const old=d.jobs.find(j=>j.id===r.requestId);
      if(old){if(old.fingerprint!==key)throw Error('같은 요청 번호의 내용이 달라졌습니다.');return;}
      if(d.revision!==r.expectedRevision)throw Error('지원 기록이 바뀌었습니다. 결과를 다시 확인하세요.');
      if(d.jobs.some(j=>j.state==='running'))throw Error('이전 요청 결과를 먼저 확인하세요. 자동으로 다시 보내지 않습니다.');
      if(r.operation==='ask'&&this.connections[r.provider as HelpdeskProvider]!=='ready')throw Error('선택한 AI의 공식 인증과 연결을 먼저 다시 확인하세요.');
      if(r.operation==='login'&&this.connections.claude!=='signed-out')throw Error('로그인이 필요한 상태인지 먼저 확인하세요. 기존 인증을 보존했습니다.');
      const job:Stored['jobs'][number]={id:r.requestId as string,fingerprint:key,kind:r.operation==='ask'?'question':'login',provider:r.provider as HelpdeskProvider,question,answer:'',state:'running',message:'',createdAt:Date.now()};
      d.jobs=[...d.jobs.slice(-11),job];d.ownerPid=process.pid;d.revision++;this.save(d);
      const abort=new AbortController();const record={id:job.id,abort,done:Promise.resolve()};this.active=record;
      record.done=this.run(job,abort).catch(()=>{}); // unknown persistence outcome stays pending, never resubmitted
    },{label:'Helpdesk question admission'});
    return this.status();
  }
  private async run(job:Stored['jobs'][number],abort:AbortController){
    // Yield until the admission lease is released; model work never holds the file lease.
    await new Promise<void>(resolve=>setTimeout(resolve,0));
    const timer=setTimeout(()=>abort.abort(),job.kind==='login'?600_000:120_000);
    try{
      if(job.kind==='login'){await this.effects.loginClaude(abort.signal);this.connections.claude=await this.effects.check('claude');if(this.connections.claude!=='ready')throw Error('로그인 결과를 다시 확인하세요.');job.answer='Claude 공식 인증을 확인했습니다. 이제 사용법을 물어보세요.';}
      else {
        const history=this.read().jobs.filter(j=>j.state==='answered'&&j.kind==='question').map(j=>({question:j.question,answer:j.answer}));
        job.answer=clean((await this.effects.answer(job.provider,helpdeskPrompt(job.question,history,this.effects.context()),abort.signal,job.id)).slice(0,3000));
        if(!job.answer.trim())throw Error('답변을 확인하지 못했습니다.');
      }
      job.state=abort.signal.aborted?'cancelled':'answered';
    }catch{job.state=abort.signal.aborted?'cancelled':'failed';job.message=abort.signal.aborted?'중지했습니다. 자동으로 다시 보내지 않습니다.':'답변 또는 인증을 확인하지 못했습니다. 질문은 보존됐습니다. 연결을 다시 확인하세요.';}
    finally{
      clearTimeout(timer);
      await withOwnedPortalFileLock(this.file+'.lock',async()=>{const d=this.read();const index=d.jobs.findIndex(j=>j.id===job.id);if(index>=0&&d.jobs[index]?.state==='running'){d.jobs[index]=job;d.revision++;d.ownerPid=null;this.save(d);}},{label:'Helpdesk result'});
      if(this.active?.id===job.id)this.active=null;
    }
  }
  async recoverInterrupted(){
    await withOwnedPortalFileLock(this.file+'.lock',async()=>{const d=this.read();if(!d.jobs.some(j=>j.state==='running')||this.active)return;let alive=false;if(d.ownerPid)try{process.kill(d.ownerPid,0);alive=true;}catch(e:any){alive=e?.code!=='ESRCH';}if(alive)return;
      for(const j of d.jobs)if(j.state==='running'){j.state='interrupted';j.message='앱 종료로 결과를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.';}d.ownerPid=null;d.revision++;this.save(d);
    },{label:'Helpdesk recovery'});
  }
  async shutdown(){this.closed=true;if(this.active){this.active.abort.abort();await this.active.done;}}
}
