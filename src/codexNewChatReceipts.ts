import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {withOwnedPortalFileLock} from './portalFileLock';

const MAX_RECORDS = 4096;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_MS = 30 * 86400_000;
const actionIdRe = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const threadIdRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const revisionOf = (r:Receipt) => digest(JSON.stringify(r));

export type CodexNewChatReceiptState = 'started' | 'completed' | 'acknowledged' | 'cancelled';
interface Receipt {
  controller: string; project: string; folder: string; registration: string; actionId: string; state: CodexNewChatReceiptState;
  threadId: string | null; createdAt: number; expiresAt: number;
}
export class CodexNewChatReceiptError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const unavailable = () => new CodexNewChatReceiptError('CODEX_NEW_CHAT_RECEIPT_UNAVAILABLE', '이전 새 대화 요청 기록을 안전하게 확인하지 못해 중복 생성을 중단했습니다. Mac에서 확인하세요.');
const PROVEN_UNSENT_CODES = new Set([
  'CODEX_PROJECT_CONNECTION_UNAVAILABLE','CODEX_PROJECT_METADATA_UNAVAILABLE','CODEX_DESKTOP_APP_OPEN_FAILED',
  'CODEX_PROJECT_SELECTION_TIMEOUT','CODEX_DESKTOP_AUTOMATION_PERMISSION_DENIED',
  'CODEX_DESKTOP_PROCESS_NOT_FOUND','CODEX_DESKTOP_COMPOSER_NOT_READY',
  'CODEX_DESKTOP_AUTHORITY_REVOKED',
]);
/** Both durable fences must be empty in addition to a known pre-submit error. */
export function canCancelUndispatchedCodexRequest(code:string,hasPending:boolean,hasSubmissionFence:boolean):boolean {
  return PROVEN_UNSENT_CODES.has(code)&&!hasPending&&!hasSubmissionFence;
}

/** Private, bounded write-ahead receipts: paths and device tokens are never stored. */
export class CodexNewChatReceiptStore {
  readonly #directory: string;
  readonly #file: string;
  constructor(appDataDir: string, readonly now: () => number = Date.now) {
    this.#directory = join(appDataDir, 'remote-control');
    this.#file = join(this.#directory, 'codex-new-chat-receipts-v1.json');
  }
  #key(controller: string, actionId: string) { return digest(`${controller}\0${actionId}`); }
  #read(): Record<string, Receipt> {
    try {
      const st = lstatSync(this.#file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_BYTES
        || (process.platform !== 'win32' && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()))) throw unavailable();
      const raw = JSON.parse(readFileSync(this.#file, 'utf8'));
      if (!raw || Object.keys(raw).sort().join() !== 'entries,schemaVersion' || raw.schemaVersion !== 1
        || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) throw unavailable();
      const entries = Object.entries(raw.entries as Record<string, Receipt>);
      if (entries.length > MAX_RECORDS) throw unavailable();
      for (const [key, r] of entries) {
        if (!r || Object.keys(r).sort().join() !== 'actionId,controller,createdAt,expiresAt,folder,project,registration,state,threadId'
          || !/^[a-f0-9]{64}$/.test(r.controller) || !/^[a-f0-9]{64}$/.test(r.project) || !/^[a-f0-9]{64}$/.test(r.folder) || !/^[a-f0-9]{64}$/.test(r.registration)
          || !actionIdRe.test(r.actionId) || key !== this.#key(r.controller, r.actionId)
          || !['started','completed','acknowledged','cancelled'].includes(r.state)
          || !(r.threadId === null || threadIdRe.test(r.threadId))
          || (r.state === 'started' || r.state === 'cancelled' ? r.threadId !== null : r.threadId === null)
          || !Number.isSafeInteger(r.createdAt) || !Number.isSafeInteger(r.expiresAt)
          || r.expiresAt <= r.createdAt || r.expiresAt - r.createdAt > MAX_SESSION_MS) throw unavailable();
      }
      return Object.fromEntries(entries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
      throw unavailable();
    }
  }
  async #mutate<T>(fn: (records: Record<string, Receipt>) => {result:T; write:boolean}): Promise<T> {
    mkdirSync(this.#directory, {recursive:true, mode:0o700});
    const dir = lstatSync(this.#directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (process.platform !== 'win32'
      && ((dir.mode & 0o077) !== 0 || dir.uid !== process.getuid?.()))) throw unavailable();
    return withOwnedPortalFileLock(`${this.#file}.lock`, () => {
      const entries = this.#read(), next = fn(entries);
      if (next.write) {
        const bytes = JSON.stringify({schemaVersion:1, entries});
        if (Buffer.byteLength(bytes) > MAX_BYTES) throw unavailable();
        const temporary = `${this.#file}.${randomUUID()}.tmp`;
        try {
          const fd = openSync(temporary,'wx',0o600);
          try { writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
          renameSync(temporary,this.#file); chmodSync(this.#file,0o600);
          if (process.platform !== 'win32') {const dirfd=openSync(this.#directory,'r');try{fsyncSync(dirfd);}finally{closeSync(dirfd);}}
        } finally {try{unlinkSync(temporary);}catch{}}
      }
      return next.result;
    }, {label:'codex new chat receipts', attempts:50, retryMs:20});
  }
  #binding(input:{controllerId:string;projectIdentity:string;folderIdentity?:string;registrationIdentity?:string;actionId:string}) {
    if (!input.controllerId || !input.projectIdentity || !actionIdRe.test(input.actionId)) throw unavailable();
    const controller=digest(input.controllerId), project=digest(input.projectIdentity),folder=digest(input.folderIdentity??input.projectIdentity),registration=digest(input.registrationIdentity??input.projectIdentity);
    return {controller,project,folder,registration,key:this.#key(controller,input.actionId)};
  }
  async reserve(input:{controllerId:string;projectIdentity:string;folderIdentity?:string;registrationIdentity?:string;actionId:string;expiresAt:string}):Promise<{created:boolean;state:CodexNewChatReceiptState;threadId:string|null}> {
    const b=this.#binding(input);
    return this.#mutate<{created:boolean;state:CodexNewChatReceiptState;threadId:string|null}>(entries=>{
      const previous=entries[b.key], now=this.now(), expires=Date.parse(input.expiresAt);
      if (previous) {
        if (previous.project!==b.project||previous.folder!==b.folder||previous.registration!==b.registration) throw new CodexNewChatReceiptError('ACTION_ID_REUSED','같은 요청을 다른 프로젝트에 사용할 수 없습니다.');
        if (previous.expiresAt<=now) throw new CodexNewChatReceiptError('CODEX_NEW_CHAT_RECEIPT_EXPIRED','이전 요청의 확인 기간이 끝났습니다. Mac에서 대화를 확인하세요.');
        return {result:{created:false,state:previous.state,threadId:previous.threadId},write:false};
      }
      const barrier=Object.values(entries).find(r=>(r.folder===b.folder||r.registration===b.registration) && r.state!=='acknowledged'&&r.state!=='cancelled');
      if (barrier) throw new CodexNewChatReceiptError(barrier.controller===b.controller?'CODEX_NEW_CHAT_REVIEW_REQUIRED':'CODEX_NEW_CHAT_BUSY','이 프로젝트의 이전 새 대화 요청을 먼저 확인하세요.');
      if (!Number.isFinite(expires) || expires<=now || expires-now>MAX_SESSION_MS) throw unavailable();
      // Acknowledged records are tombstones for the remainder of the pairing.
      for(const [key,r] of Object.entries(entries)) if((r.state==='acknowledged'||r.state==='cancelled')&&r.expiresAt<=now) delete entries[key];
      if(Object.keys(entries).length>=MAX_RECORDS) throw unavailable();
      entries[b.key]={controller:b.controller,project:b.project,folder:b.folder,registration:b.registration,actionId:input.actionId,state:'started',threadId:null,createdAt:now,expiresAt:expires};
      return {result:{created:true,state:'started',threadId:null},write:true};
    });
  }
  async complete(input:{controllerId:string;projectIdentity:string;folderIdentity?:string;registrationIdentity?:string;actionId:string;threadId:string}):Promise<void>{
    const b=this.#binding(input);if(!threadIdRe.test(input.threadId))throw unavailable();
    await this.#mutate(entries=>{const r=entries[b.key];if(!r||r.project!==b.project||r.folder!==b.folder||r.registration!==b.registration||r.state!=='started')throw unavailable();r.state='completed';r.threadId=input.threadId;return{result:undefined,write:true};});
  }
  async review(input:{controllerId:string;projectIdentity:string;folderIdentity?:string;registrationIdentity?:string}):Promise<{actionId:string;state:'started'|'completed'}|null>{
    const controller=digest(input.controllerId),project=digest(input.projectIdentity),folder=digest(input.folderIdentity??input.projectIdentity),registration=digest(input.registrationIdentity??input.projectIdentity);
    return this.#mutate(entries=>{const r=Object.values(entries).find(x=>(x.folder===folder||x.registration===registration)&&x.state!=='acknowledged'&&x.state!=='cancelled');
      if(!r)return{result:null,write:false};if(r.controller!==controller||r.project!==project||r.folder!==folder||r.registration!==registration)throw new CodexNewChatReceiptError('CODEX_NEW_CHAT_BUSY','이 프로젝트의 이전 새 대화 요청을 먼저 확인하세요.');
      return{result:{actionId:r.actionId,state:r.state as 'started'|'completed'},write:false};});
  }
  async reviewExact(input:{controllerId:string;projectIdentity:string;folderIdentity?:string;registrationIdentity?:string;actionId:string}):Promise<{actionId:string;state:CodexNewChatReceiptState}|null>{
    const b=this.#binding(input);return this.#mutate(entries=>{const r=entries[b.key];
      if(!r||r.project!==b.project||r.folder!==b.folder||r.registration!==b.registration||r.expiresAt<=this.now())return{result:null,write:false};
      return{result:{actionId:r.actionId,state:r.state},write:false};});
  }
  async hasBarrier(folderIdentity:string,registrationIdentities:readonly string[]=[]):Promise<boolean>{
    const folder=digest(folderIdentity),registrations=new Set(registrationIdentities.map(digest));return this.#mutate(entries=>({result:Object.values(entries).some(r=>(r.folder===folder||registrations.has(r.registration))&&r.state!=='acknowledged'&&r.state!=='cancelled'),write:false}));
  }
  async reviewLocal(projectIdentity:string):Promise<{state:'started'|'completed';revision:string;threadId:string|null}|null>{
    const project=digest(projectIdentity);return this.#mutate(entries=>{const r=Object.values(entries).find(x=>x.project===project&&x.state!=='acknowledged'&&x.state!=='cancelled');
      return{result:r?{state:r.state as 'started'|'completed',revision:revisionOf(r),threadId:r.threadId}:null,write:false};});
  }
  async resolveLocal(projectIdentity:string,expectedRevision:string,allowUnsent:boolean):Promise<void>{
    const project=digest(projectIdentity);await this.#mutate(entries=>{const r=Object.values(entries).find(x=>x.project===project&&x.state!=='acknowledged'&&x.state!=='cancelled');
      if(!r||revisionOf(r)!==expectedRevision)throw new CodexNewChatReceiptError('CODEX_NEW_CHAT_REVIEW_STALE','새 대화 확인 상태가 바뀌었습니다. 다시 확인하세요.');
      if(r.state==='started') {
        if(!allowUnsent)throw new CodexNewChatReceiptError('CODEX_NEW_CHAT_REVIEW_REQUIRED','진행 결과를 확인할 수 없는 요청은 자동 해제할 수 없습니다.');
        r.state='cancelled';return{result:undefined,write:true};
      }
      if(r.state!=='completed'||!r.threadId)throw unavailable();
      r.state='acknowledged';return{result:undefined,write:true};});
  }
  async promoteLocalStarted(projectIdentity:string,expectedRevision:string,threadId:string):Promise<string>{
    if(!threadIdRe.test(threadId))throw unavailable();
    const project=digest(projectIdentity);return this.#mutate(entries=>{
      const r=Object.values(entries).find(x=>x.project===project&&x.state!=='acknowledged'&&x.state!=='cancelled');
      if(!r||revisionOf(r)!==expectedRevision)throw new CodexNewChatReceiptError('CODEX_NEW_CHAT_REVIEW_STALE','새 대화 확인 상태가 바뀌었습니다. 다시 확인하세요.');
      if(r.state!=='started'||r.threadId)throw unavailable();
      r.state='completed';r.threadId=threadId;return{result:revisionOf(r),write:true};
    });
  }
  async cancelUndispatched(input:{controllerId:string;projectIdentity:string;folderIdentity?:string;registrationIdentity?:string;actionId:string}):Promise<void>{
    const b=this.#binding(input);await this.#mutate(entries=>{const r=entries[b.key];
      if(!r||r.project!==b.project||r.folder!==b.folder||r.registration!==b.registration||r.state!=='started')throw unavailable();r.state='cancelled';return{result:undefined,write:true};});
  }
  /** Tombstone an exact not-yet-received request before the user abandons it. */
  async cancelAbsent(input:{controllerId:string;projectIdentity:string;folderIdentity?:string;registrationIdentity?:string;actionId:string;expiresAt:string}):Promise<void>{
    const b=this.#binding(input);await this.#mutate(entries=>{
      const prior=entries[b.key],now=this.now(),expires=Date.parse(input.expiresAt);
      if(prior){
        if(prior.project!==b.project||prior.folder!==b.folder||prior.registration!==b.registration)throw new CodexNewChatReceiptError('ACTION_ID_REUSED','같은 요청을 다른 프로젝트에 사용할 수 없습니다.');
        if(prior.expiresAt<=now)throw new CodexNewChatReceiptError('CODEX_NEW_CHAT_RECEIPT_EXPIRED','이전 요청의 확인 기간이 끝났습니다. Mac에서 확인하세요.');
        if(prior.state==='cancelled')return{result:undefined,write:false};
        throw new CodexNewChatReceiptError('CODEX_NEW_CHAT_REVIEW_REQUIRED','이미 수신된 요청은 취소할 수 없습니다. Mac에서 확인하세요.');
      }
      if(!Number.isFinite(expires)||expires<=now||expires-now>MAX_SESSION_MS)throw unavailable();
      for(const [key,r] of Object.entries(entries))if((r.state==='acknowledged'||r.state==='cancelled')&&r.expiresAt<=now)delete entries[key];
      if(Object.keys(entries).length>=MAX_RECORDS)throw unavailable();
      entries[b.key]={controller:b.controller,project:b.project,folder:b.folder,registration:b.registration,actionId:input.actionId,state:'cancelled',threadId:null,createdAt:now,expiresAt:expires};
      return{result:undefined,write:true};
    });
  }
  async threadForAcknowledgement(input:{controllerId:string;projectIdentity:string;folderIdentity?:string;registrationIdentity?:string;actionId:string}):Promise<string>{
    const b=this.#binding(input);return this.#mutate(entries=>{const r=entries[b.key];
      if(!r||r.project!==b.project||r.folder!==b.folder||r.registration!==b.registration||r.expiresAt<=this.now())throw new CodexNewChatReceiptError('CODEX_NEW_CHAT_RECEIPT_EXPIRED','이전 요청을 안전하게 확인할 수 없습니다.');
      if(r.state==='started'||!r.threadId)throw new CodexNewChatReceiptError('CODEX_NEW_CHAT_REVIEW_REQUIRED','이전 요청의 생성 결과가 불확실합니다. Mac에서 확인하세요.');
      return{result:r.threadId,write:false};});
  }
  async acknowledge(input:{controllerId:string;projectIdentity:string;folderIdentity?:string;registrationIdentity?:string;actionId:string}):Promise<string>{
    const b=this.#binding(input);return this.#mutate(entries=>{const r=entries[b.key];
      if(!r||r.project!==b.project||r.folder!==b.folder||r.registration!==b.registration||r.expiresAt<=this.now())throw new CodexNewChatReceiptError('CODEX_NEW_CHAT_RECEIPT_EXPIRED','이전 요청을 안전하게 확인할 수 없습니다.');
      if(r.state==='started'||r.state==='cancelled')throw new CodexNewChatReceiptError('CODEX_NEW_CHAT_REVIEW_REQUIRED','이전 요청의 생성 결과가 불확실합니다. Mac에서 확인하세요.');
      if(!r.threadId)throw unavailable();
      if(r.state==='acknowledged')return{result:r.threadId,write:false};r.state='acknowledged';return{result:r.threadId,write:true};});
  }
}
