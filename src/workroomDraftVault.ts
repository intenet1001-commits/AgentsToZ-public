/**
 * Opt-in encrypted keeping of Workroom requests in this browser/app origin (S3-8).
 *
 * Off by default, per device (localStorage flag). When on, a request the user queues — or sends — is sealed with a
 * non-extractable AES-GCM key kept in IndexedDB, under its pre-assigned submission id. The point is that a reload or a
 * crashed tab does not lose the text, while nothing is ever re-sent on its own: the queue (src/workroomDraftQueue.ts)
 * comes back stopped, and each item asks the host for that id's receipt before it may be sent.
 *
 * Bounds: 7 days, 32 drafts, 1 MiB of sealed plaintext each. The AAD binds the store id, scope, session and submission
 * id, so a record copied to another session, scope or browser store does not open. Nothing here leaves this origin.
 */
const DATABASE_NAME='agentstoz-workroom-drafts-v1';
const OBJECT_STORE_NAME='drafts';
const KEY_RECORD='key';
const DRAFT_PREFIX='draft:';
const SCHEMA_VERSION=1 as const;
const AAD_DOMAIN='agentstoz.workroom.draft-vault/v1';
const NONCE_BYTES=12;
const ID_RE=/^[A-Za-z0-9_-]{8,160}$/;
const MAX_SCOPE_LENGTH=200;
export const WORKROOM_DRAFT_VAULT_FLAG_KEY='agentstoz:workroom-draft-vault:v1';
export const WORKROOM_DRAFT_VAULT_TTL_MS=7*24*60*60*1000;
export const WORKROOM_DRAFT_VAULT_LIMIT=32;
export const WORKROOM_DRAFT_VAULT_MAX_BYTES=1024*1024;
const encoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true});

export class WorkroomDraftVaultError extends Error {
 constructor(readonly code:string,message:string){super(message);this.name='WorkroomDraftVaultError';}
}
const fail=(code:string,message:string):never=>{throw new WorkroomDraftVaultError(code,message);};

export interface WorkroomDraftStorage {
 read(recordKey:string):Promise<unknown|null>;
 write(recordKey:string,value:unknown):Promise<void>;
 delete(recordKey:string):Promise<void>;
 entries():Promise<Array<{recordKey:string;value:unknown}>>;
 /**
  * The record keys only. Counting must not read values: each draft is up to 1 MiB of ciphertext, and the direct send
  * waits on save(), which counts the vault (review S3-8, 2026-10-16).
  */
 keys():Promise<string[]>;
 clear():Promise<void>;
 /**
  * One atomic read-modify-write (a single IndexedDB readwrite transaction, so two windows cannot interleave). `mutate`
  * returns the new value, or undefined to leave the record as it is. Resolves to the value as it was before.
  */
 update(recordKey:string,mutate:(value:unknown)=>unknown):Promise<unknown|null>;
}
/**
 * `attempted`: this request was handed to a transport at least once (the send path seals it as attempted; a queued draft
 * is claimed before its first send). Such a draft is never sent on a bare «not found» — see sendQueuedDraft.
 */
export interface WorkroomStoredDraft {submissionId:string;text:string;references:string[];savedAt:number;attempted:boolean}
/** A kept request with the session it was saved for: what a scope-wide listing returns. */
export interface WorkroomScopedDraft extends WorkroomStoredDraft {sessionId:string}
export type WorkroomDraftClaim='fresh'|'attempted'|'missing';

/** The flag is a per-device choice; an unreadable store reads as «off». Reading never writes. */
export function readDraftVaultOptIn(storage:Pick<Storage,'getItem'>):boolean{
 try{return storage.getItem(WORKROOM_DRAFT_VAULT_FLAG_KEY)==='on';}catch{return false;}
}
export function writeDraftVaultOptIn(storage:Pick<Storage,'setItem'|'removeItem'>,on:boolean){
 if(on)storage.setItem(WORKROOM_DRAFT_VAULT_FLAG_KEY,'on');else storage.removeItem(WORKROOM_DRAFT_VAULT_FLAG_KEY);
}
/**
 * Needs IndexedDB, WebCrypto and a secure context. The LAN QR page is served over plain http from a private address,
 * where `crypto.subtle` is absent — there the feature is not offered at all (the composer is unchanged).
 */
export function workroomDraftVaultSupported(env:{indexedDB?:IDBFactory;crypto?:Crypto;isSecureContext?:boolean}={
 indexedDB:typeof indexedDB==='undefined'?undefined:indexedDB,
 crypto:typeof crypto==='undefined'?undefined:crypto,
 isSecureContext:typeof isSecureContext==='undefined'?false:isSecureContext,
}):boolean{
 return !!env.indexedDB&&!!env.crypto?.subtle&&typeof env.crypto.getRandomValues==='function'&&env.isSecureContext===true;
}
/**
 * The vault the composer uses: every write re-reads the per-device flag, so a window that kept its vault object after
 * another window turned the setting off stores nothing (see WorkroomDraftVault#save).
 */
export function createGatedDraftVault(input:{flags:Pick<Storage,'getItem'>;storage?:WorkroomDraftStorage;crypto?:Crypto;now?:()=>number}):WorkroomDraftVault{
 return new WorkroomDraftVault({storage:input.storage,crypto:input.crypto,now:input.now,enabled:()=>readDraftVaultOptIn(input.flags)});
}
/**
 * Turning the setting off: the flag goes first, then every draft and the key. Any other window's vault re-reads the
 * flag around each write, so nothing it saves survives this. If clearing fails the flag comes back on — the setting must
 * not read «off» while drafts remain — and the error is the caller's to show.
 */
export async function turnDraftVaultOff(input:{flags:Pick<Storage,'setItem'|'removeItem'>;vault:WorkroomDraftVault|null}):Promise<void>{
 writeDraftVaultOptIn(input.flags,false);
 if(!input.vault)return;
 try{await input.vault.clear();}catch(error){writeDraftVaultOptIn(input.flags,true);throw error;}
}
const OPT_IN_CHANNEL='agentstoz-workroom-draft-vault-v1';
type OptInEnv={BroadcastChannel?:typeof BroadcastChannel;events?:Pick<EventTarget,'addEventListener'|'removeEventListener'>};
function optInEnv():OptInEnv{
 return {BroadcastChannel:typeof BroadcastChannel==='undefined'?undefined:BroadcastChannel,events:typeof window==='undefined'?undefined:window};
}
/**
 * Every panel of this origin follows the setting. `storage` reaches other windows and tabs, BroadcastChannel also the
 * other panels in this window (the popout, the session dialog), which `storage` never does. The message carries
 * nothing: listeners re-read the flag.
 */
export function subscribeDraftVaultOptIn(onChange:()=>void,env:OptInEnv=optInEnv()):()=>void{
 const onStorage=(event:Event)=>{const key=(event as StorageEvent).key;if(key===null||key===WORKROOM_DRAFT_VAULT_FLAG_KEY)onChange();};
 env.events?.addEventListener('storage',onStorage);
 let channel:BroadcastChannel|null=null;
 try{if(env.BroadcastChannel){channel=new env.BroadcastChannel(OPT_IN_CHANNEL);channel.onmessage=()=>onChange();}}catch{channel=null;}
 return ()=>{env.events?.removeEventListener('storage',onStorage);try{channel?.close();}catch{/* already closed */}};
}
export function announceDraftVaultOptIn(env:OptInEnv=optInEnv()):void{
 try{if(!env.BroadcastChannel)return;const channel=new env.BroadcastChannel(OPT_IN_CHANNEL);channel.postMessage('changed');channel.close();}catch{/* best effort: every write re-checks the flag */}
}
/** The one gate: off flag or unsupported environment → no vault, so nothing is ever opened or written. */
export function draftVaultIfEnabled(input:{flags:Pick<Storage,'getItem'>;supported:boolean;create:()=>WorkroomDraftVault}):WorkroomDraftVault|null{
 return input.supported&&readDraftVaultOptIn(input.flags)?input.create():null;
}

const buffer=(bytes:Uint8Array)=>bytes.slice().buffer;
function aad(storeId:string,scope:string,sessionId:string,submissionId:string){
 return buffer(encoder.encode([AAD_DOMAIN,storeId,scope,sessionId,submissionId].join('\0')));
}
function isVaultKey(value:unknown):value is CryptoKey{
 if(typeof CryptoKey==='undefined'||!(value instanceof CryptoKey))return false;
 const algorithm=value.algorithm as AesKeyAlgorithm;
 return value.type==='secret'&&value.extractable===false&&algorithm.name==='AES-GCM'&&algorithm.length===256
  &&value.usages.length===2&&value.usages.includes('encrypt')&&value.usages.includes('decrypt');
}
type KeyRecord={schemaVersion:typeof SCHEMA_VERSION;storeId:string;key:CryptoKey};
// `attempted` is outside the AAD so a claim can flip it in one storage transaction without re-encrypting. Only this
// origin can write the store, and code running here could send anything anyway; the flag guards against our own resend.
type DraftRecord={schemaVersion:typeof SCHEMA_VERSION;scope:string;sessionId:string;submissionId:string;savedAt:number;attempted:boolean;nonce:ArrayBuffer;ciphertext:ArrayBuffer};
function keyRecord(value:unknown):KeyRecord|null{
 const r=value as KeyRecord|null;
 return r&&typeof r==='object'&&Object.keys(r).length===3&&r.schemaVersion===SCHEMA_VERSION&&typeof r.storeId==='string'&&ID_RE.test(r.storeId)&&isVaultKey(r.key)?r:null;
}
function draftRecord(value:unknown):DraftRecord|null{
 const r=value as DraftRecord|null;
 if(!r||typeof r!=='object'||Array.isArray(r))return null;
 const keys=['schemaVersion','scope','sessionId','submissionId','savedAt','attempted','nonce','ciphertext'];
 return Object.keys(r).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(r,k))&&r.schemaVersion===SCHEMA_VERSION
  &&typeof r.scope==='string'&&r.scope.length>0&&r.scope.length<=MAX_SCOPE_LENGTH&&typeof r.sessionId==='string'&&ID_RE.test(r.sessionId)
  &&typeof r.submissionId==='string'&&ID_RE.test(r.submissionId)&&typeof r.savedAt==='number'&&Number.isFinite(r.savedAt)&&typeof r.attempted==='boolean'
  &&r.nonce instanceof ArrayBuffer&&r.nonce.byteLength===NONCE_BYTES&&r.ciphertext instanceof ArrayBuffer&&r.ciphertext.byteLength>=16
  &&r.ciphertext.byteLength<=WORKROOM_DRAFT_VAULT_MAX_BYTES+16?r:null;
}

export class WorkroomDraftVault {
 readonly #storage:WorkroomDraftStorage;
 readonly #crypto:Crypto;
 readonly #now:()=>number;
 readonly #enabled:()=>boolean;
 constructor(options:{storage?:WorkroomDraftStorage;crypto?:Crypto;now?:()=>number;enabled?:()=>boolean}={}){
  this.#storage=options.storage??createIndexedDbWorkroomDraftStorage();
  const api=options.crypto??globalThis.crypto;
  if(!api?.subtle||typeof api.getRandomValues!=='function')fail('WEBCRYPTO_UNAVAILABLE','이 브라우저에서는 작성 내용을 암호화해 보관할 수 없습니다.');
  this.#crypto=api;this.#now=options.now??Date.now;this.#enabled=options.enabled??(()=>true);
 }
 #assertEnabled(){if(!this.#enabled())fail('DRAFT_VAULT_OFF','작성 내용 보관이 꺼져 있어 보관하지 않았습니다.');}
 /**
  * The key is created only by the first save: listing an empty vault writes nothing. Creation is create-if-absent in
  * one storage transaction (`update`): two windows saving for the first time at once both generate a key, but only the
  * first one is stored and the other window adopts it — a read-then-write here left the loser's draft sealed with a key
  * that was overwritten, so it never opened again (review S3-8, 2026-10-16). Generating happens before the transaction
  * because an IndexedDB transaction cannot stay open across a WebCrypto await.
  */
 async #key(create:boolean):Promise<KeyRecord|null>{
  const existing=keyRecord(await this.#storage.read(KEY_RECORD));
  if(existing||!create)return existing;
  const key=await this.#crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const record:KeyRecord={schemaVersion:SCHEMA_VERSION,storeId:this.#crypto.randomUUID(),key};
  const before=keyRecord(await this.#storage.update(KEY_RECORD,value=>keyRecord(value)?undefined:record));
  return before??record;
 }
 async #drafts(){return (await this.#storage.entries()).filter(entry=>entry.recordKey.startsWith(DRAFT_PREFIX));}
 /** Draft record keys, without reading any record: what counting needs. */
 async #draftKeys(){return (await this.#storage.keys()).filter(recordKey=>recordKey.startsWith(DRAFT_PREFIX));}
 /**
  * Seals one draft. Refused when the setting is off — checked before and again after the write: turning it off removes
  * the flag before clearing, so a write racing that clear is either wiped by it or found here and wiped by this call.
  */
 async save(input:{scope:string;sessionId:string;submissionId:string;text:string;references:readonly string[];attempted?:boolean}):Promise<void>{
  this.#assertEnabled();
  if(typeof input.scope!=='string'||!input.scope||input.scope.length>MAX_SCOPE_LENGTH||!ID_RE.test(input.sessionId)||!ID_RE.test(input.submissionId)
   ||typeof input.text!=='string'||!Array.isArray(input.references)||input.references.some(r=>typeof r!=='string'))
   fail('DRAFT_INVALID','보관할 요청의 형식이 올바르지 않습니다.');
  const plaintext=encoder.encode(JSON.stringify({text:input.text,references:[...input.references]}));
  if(plaintext.byteLength>WORKROOM_DRAFT_VAULT_MAX_BYTES)fail('DRAFT_TOO_LARGE','보관할 수 있는 요청은 1MiB까지입니다.');
  const recordKey=DRAFT_PREFIX+input.submissionId;
  const others=(await this.#draftKeys()).filter(key=>key!==recordKey).length;
  // The limit counts the whole device (every session and connection): counting per scope would read every value.
  if(others>=WORKROOM_DRAFT_VAULT_LIMIT)fail('DRAFT_LIMIT',`보관함이 가득 찼습니다(이 기기 전체 ${WORKROOM_DRAFT_VAULT_LIMIT}개). 보내거나 지운 뒤 다시 보관하세요.`);
  const store=(await this.#key(true))!;
  const nonce=this.#crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext=await this.#crypto.subtle.encrypt({name:'AES-GCM',iv:buffer(nonce),additionalData:aad(store.storeId,input.scope,input.sessionId,input.submissionId),tagLength:128},store.key,buffer(plaintext));
  await this.#storage.write(recordKey,{schemaVersion:SCHEMA_VERSION,scope:input.scope,sessionId:input.sessionId,submissionId:input.submissionId,savedAt:this.#now(),attempted:input.attempted===true,nonce:buffer(nonce),ciphertext} satisfies DraftRecord);
  if(!this.#enabled()){await this.#storage.clear().catch(()=>undefined);fail('DRAFT_VAULT_OFF','작성 내용 보관이 꺼져 있어 보관하지 않았습니다.');}
 }
 /**
  * Marks this scope+session's draft as handed to a transport, atomically, and says what it was before. Only `fresh`
  * may be sent on a «not found»: `attempted` (another press, another window, the send path) and `missing` (deleted,
  * expired, another scope) never are. Refused when the setting is off.
  */
 async claimForSend(scope:string,sessionId:string,submissionId:string):Promise<WorkroomDraftClaim>{
  this.#assertEnabled();
  if(!ID_RE.test(submissionId))return 'missing';
  const mine=(value:unknown)=>{const r=draftRecord(value);return r&&r.submissionId===submissionId&&r.scope===scope&&r.sessionId===sessionId&&this.#now()-r.savedAt<=WORKROOM_DRAFT_VAULT_TTL_MS?r:null;};
  const before=mine(await this.#storage.update(DRAFT_PREFIX+submissionId,value=>{const r=mine(value);return r&&!r.attempted?{...r,attempted:true}:undefined;}));
  return !before?'missing':before.attempted?'attempted':'fresh';
 }
 /**
  * This scope+session's drafts, oldest first. Expired, malformed and unopenable records (another session, scope or
  * store, a tampered byte) are deleted and counted — a record that does not open is never shown as someone's text.
  */
 async list(scope:string,sessionId:string):Promise<{drafts:WorkroomStoredDraft[];dropped:number}>{
  const {drafts,dropped}=await this.#listIn(scope,sessionId);
  return {drafts:drafts.map(({sessionId:_session,...draft})=>draft),dropped};
 }
 /**
  * Every draft of this scope, whichever session it was kept for, oldest first (audit 2026-10-16: a request kept for a
  * session that ended was otherwise unreachable, yet still counted toward the limit). `elsewhere` counts the unexpired,
  * well-formed drafts of other scopes — other Macs or connections — which share the device-wide limit; they are not
  * opened here, and `elsewhereIds` names them so they can be cleared (deleteOutsideScope).
  */
 async listScope(scope:string):Promise<{drafts:WorkroomScopedDraft[];dropped:number;elsewhere:number;elsewhereIds:string[]}>{return this.#listIn(scope,null);}
 async #listIn(scope:string,sessionId:string|null):Promise<{drafts:WorkroomScopedDraft[];dropped:number;elsewhere:number;elsewhereIds:string[]}>{
  const entries=await this.#drafts();if(!entries.length)return {drafts:[],dropped:0,elsewhere:0,elsewhereIds:[]};
  const store=await this.#key(false);
  const drafts:WorkroomScopedDraft[]=[],elsewhereIds:string[]=[];let dropped=0;
  for(const entry of entries){
   const record=draftRecord(entry.value);
   if(!record||entry.recordKey!==DRAFT_PREFIX+record.submissionId||this.#now()-record.savedAt>WORKROOM_DRAFT_VAULT_TTL_MS){
    await this.#storage.delete(entry.recordKey);continue;
   }
   if(record.scope!==scope){elsewhereIds.push(record.submissionId);continue;}
   if(sessionId!==null&&record.sessionId!==sessionId)continue;
   try{
    if(!store)throw Error('no key');
    const plain=await this.#crypto.subtle.decrypt({name:'AES-GCM',iv:record.nonce,additionalData:aad(store.storeId,scope,record.sessionId,record.submissionId),tagLength:128},store.key,record.ciphertext);
    const value=JSON.parse(decoder.decode(plain)) as {text?:unknown;references?:unknown};
    if(!value||typeof value!=='object'||Object.keys(value).length!==2||typeof value.text!=='string'||!Array.isArray(value.references)||value.references.some(r=>typeof r!=='string'))throw Error('shape');
    drafts.push({submissionId:record.submissionId,sessionId:record.sessionId,text:value.text,references:value.references as string[],savedAt:record.savedAt,attempted:record.attempted});
   }catch{dropped++;await this.#storage.delete(entry.recordKey);}
  }
  drafts.sort((a,b)=>a.savedAt-b.savedAt||(a.submissionId<b.submissionId?-1:1));
  return {drafts,dropped,elsewhere:elsewhereIds.length,elsewhereIds};
 }
 /**
  * Clears drafts kept for other scopes, by id, without opening them (w5 review): a connection that is gone from this
  * device — a community device that left, a Mac removed from the phone — leaves drafts no panel can open again, yet they
  * fill the device-wide limit. Only a record that still names another scope is deleted, whatever ids are passed.
  */
 async deleteOutsideScope(scope:string,ids:readonly string[]):Promise<number>{
  let deleted=0;
  for(const id of new Set(ids)){
   if(!ID_RE.test(id))continue;
   const record=draftRecord(await this.#storage.read(DRAFT_PREFIX+id));
   if(!record||record.submissionId!==id||record.scope===scope)continue;
   await this.#storage.delete(DRAFT_PREFIX+id);deleted++;
  }
  return deleted;
 }
 /** Deletes expired and malformed records only; reads alone when there is nothing to delete. */
 async prune():Promise<void>{
  for(const entry of await this.#drafts()){
   const record=draftRecord(entry.value);
   if(!record||this.#now()-record.savedAt>WORKROOM_DRAFT_VAULT_TTL_MS)await this.#storage.delete(entry.recordKey);
  }
 }
 async count():Promise<number>{return (await this.#draftKeys()).length;}
 async delete(submissionId:string):Promise<void>{if(ID_RE.test(submissionId))await this.#storage.delete(DRAFT_PREFIX+submissionId);}
 /** Turning the feature off: every draft and the key go. A later opt-in starts a new store id. */
 async clear():Promise<void>{await this.#storage.clear();}
}

function openDatabase():Promise<IDBDatabase>{
 if(typeof indexedDB==='undefined')return Promise.reject(new WorkroomDraftVaultError('INDEXED_DB_UNAVAILABLE','이 브라우저에서는 작성 내용을 보관할 수 없습니다.'));
 return new Promise((resolve,reject)=>{
  const request=indexedDB.open(DATABASE_NAME,1);
  request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(OBJECT_STORE_NAME))request.result.createObjectStore(OBJECT_STORE_NAME);};
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(new WorkroomDraftVaultError('INDEXED_DB_UNAVAILABLE','작성 내용 보관함을 열지 못했습니다.'));
  request.onblocked=()=>reject(new WorkroomDraftVaultError('INDEXED_DB_BLOCKED','작성 내용 보관함이 다른 창에서 사용 중입니다.'));
 });
}
function transact<T>(mode:IDBTransactionMode,run:(store:IDBObjectStore,done:(value:T)=>void)=>void):Promise<T>{
 return openDatabase().then(database=>new Promise<T>((resolve,reject)=>{
  let result:T;let settled=false;
  const finish=(error?:Error)=>{if(settled)return;settled=true;database.close();if(error)reject(error);else resolve(result);};
  const failed=()=>finish(new WorkroomDraftVaultError('INDEXED_DB_FAILED','작성 내용 보관함을 읽거나 쓰지 못했습니다.'));
  const transaction=database.transaction(OBJECT_STORE_NAME,mode);
  transaction.oncomplete=()=>finish();transaction.onerror=failed;transaction.onabort=failed;
  try{run(transaction.objectStore(OBJECT_STORE_NAME),value=>{result=value;});}catch{failed();}
 }));
}
export function createIndexedDbWorkroomDraftStorage():WorkroomDraftStorage{
 return {
  read:key=>transact<unknown>('readonly',(store,done)=>{const r=store.get(key);r.onsuccess=()=>done(r.result??null);}),
  write:(key,value)=>transact<void>('readwrite',store=>{store.put(value,key);}),
  delete:key=>transact<void>('readwrite',store=>{store.delete(key);}),
  clear:()=>transact<void>('readwrite',store=>{store.clear();}),
  update:(key,mutate)=>transact<unknown>('readwrite',(store,done)=>{
   const r=store.get(key);
   r.onsuccess=()=>{const before=r.result??null;done(before);const next=mutate(before);if(next!==undefined)store.put(next,key);};
  }),
  entries:()=>transact<Array<{recordKey:string;value:unknown}>>('readonly',(store,done)=>{
   const entries:Array<{recordKey:string;value:unknown}>=[];done(entries);
   const cursor=store.openCursor();
   cursor.onsuccess=()=>{const c=cursor.result;if(!c)return;if(typeof c.key==='string')entries.push({recordKey:c.key,value:c.value});c.continue();};
  }),
  keys:()=>transact<string[]>('readonly',(store,done)=>{
   const r=store.getAllKeys();
   r.onsuccess=()=>done(r.result.filter((key):key is string=>typeof key==='string'));
  }),
 };
}
