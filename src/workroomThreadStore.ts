import {sharedThreadTextParts} from './workroomThreadGroup';
import {Database} from 'bun:sqlite';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {closeSync,constants,copyFileSync,existsSync,fsyncSync,lstatSync,openSync} from 'node:fs';
import {join} from 'node:path';
import {acquireOwnedFileLock} from './portalFileLock';
import {createProductionPromptGuideKeyProvider,promptGuideDirectory,syncPromptGuideDirectory,type PromptGuideKeyProvider} from './promptGuideKeyProvider';
import {WorkroomThreadAdmissionError,type WorkroomThreadSummary,type WorkroomThreadMessage,type WorkroomThreadParticipant} from './workroomThreadProtocol';
import type {ServiceUseBinding,ServiceUseCall,ServiceUseOutcome} from './serviceUseProtocol';
import type {ReadToolBatch} from './workroomThreadReadExecution';

export const WORKROOM_THREAD_STORE_VERSIONS = [1,2,3,4] as const;

export interface StoredWorkroomThread extends WorkroomThreadSummary {
 targetId:string;owner:string;fingerprint:string;bootId:string;intentHash:string;messages:WorkroomThreadMessage[];
 /** Only an observed exit or a verified save/close permits an automatic continuation. */
 continuation?:{sessionId:string;mode:'resume'|'fresh'};
 /** Append-only read receipts. Only the metadata facade may change this field. */
 readExecutions?:ReadToolBatch[];
 previousSessions?:string[];
 checkpoint?:{id:string;sessionId:string;inputRevision:number;turnCompletedAt?:string;state:'saving'|'closed'|'blocked';completed?:boolean};
 group?:{members:WorkroomThreadParticipant[];pendingReply?:{id:string;targetId:string;textHash:string}};
 groupParentId?:string;
 preparedInput?:{sessionId:string;id:string;hash:string};
 completionResult?:{sessionId:string;inputRevision:number;key:string};
 serviceExecution?:{binding:ServiceUseBinding;call:ServiceUseCall;outcome?:ServiceUseOutcome;requests?:{id:string;intentHash:string}[]};
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
type Row={id:string;target:string;owner:string;state:string;updated:string;session:string;bytes:number;nonce:Uint8Array;body:Uint8Array;tag:Uint8Array};
/** Independent encrypted journal: never stores task text in the metadata-only Workroom history DB.
 * No eviction of unfinished work or deduplication records. Admission stops at the named budgets. */
export class WorkroomThreadStore {
 readonly file:string;
 private root:string;
 private keys:PromptGuideKeyProvider;
 constructor(appDataDir:string,keys?:PromptGuideKeyProvider){
  this.root=promptGuideDirectory(appDataDir,true)!;this.file=join(this.root,'workroom-threads.v1.sqlite');
  this.keys=keys??createProductionPromptGuideKeyProvider({appDataDir:this.root,namespace:{keychainService:'com.portmanager.portmanager.workroom-threads.v1',keychainAccount:'workroom-threads-v1',dpapiFile:'workroom-threads.v1.key.dpapi',dpapiEntropy:'agentstoz-workroom-threads-v1'}});
 }
 private open(create:boolean){
  if(!existsSync(this.file)){if(!create)return null;const fd=openSync(this.file,'wx',0o600);closeSync(fd);}
  const st=lstatSync(this.file);if(st.isSymbolicLink()||!st.isFile()||st.nlink!==1||process.platform!=='win32'&&(st.uid!==process.getuid?.()||(st.mode&0o077)!==0))throw Error('스레드 저장소 접근 권한을 확인하세요.');
  const db=new Database(this.file,{create:false,strict:true});
  // Inspect before PRAGMA/DDL: a future host owns this file and must retain every byte.
  try{
   if(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_meta'").get()){
    const rows=db.query('SELECT version FROM thread_meta LIMIT 2').all() as {version:number}[];
    if(rows.length>1||rows[0]&&!WORKROOM_THREAD_STORE_VERSIONS.includes(rows[0].version as 1|2|3|4))throw Error('스레드 저장소 버전을 확인하세요.');
   }
  }catch(error){db.close();throw error;}
  db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;');
  db.exec('CREATE TABLE IF NOT EXISTS thread_meta(version INTEGER NOT NULL,verifier TEXT NOT NULL); CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,target TEXT NOT NULL,owner TEXT NOT NULL,state TEXT NOT NULL,updated TEXT NOT NULL,session TEXT NOT NULL,bytes INTEGER NOT NULL,nonce BLOB NOT NULL,body BLOB NOT NULL,tag BLOB NOT NULL); CREATE INDEX IF NOT EXISTS threads_target ON threads(target,updated); CREATE INDEX IF NOT EXISTS threads_session ON threads(session); CREATE TABLE IF NOT EXISTS thread_group_members(parent TEXT NOT NULL,child TEXT PRIMARY KEY,target TEXT NOT NULL); CREATE INDEX IF NOT EXISTS thread_group_target ON thread_group_members(target,parent);');
  return db;
 }
 private async key(db:Database,create:boolean){
  const rows=db.query('SELECT * FROM thread_meta LIMIT 2').all() as {version:number;verifier:string}[];
  if(rows.length>1||rows[0]&&!WORKROOM_THREAD_STORE_VERSIONS.includes(rows[0].version as 1|2|3|4)||!rows.length&&db.query('SELECT 1 FROM threads LIMIT 1').get())throw Error('스레드 저장소 버전을 확인하세요.');
  let key=await this.keys.read();
  if(!key){if(!create||rows.length)throw Error('스레드 암호화 키를 찾을 수 없습니다. 기존 기록을 보존했습니다.');key=await this.keys.create();}
  if(key.length!==32){key.fill(0);throw Error('스레드 암호화 키를 확인하세요.');}
  const verifier=hash('agentstoz-workroom-threads-v1\0'+key.toString('hex'));
  if(rows[0]&&rows[0].verifier!==verifier){key.fill(0);throw Error('스레드 암호화 키가 기존 기록과 다릅니다.');}
  if(!rows.length){if(!create){key.fill(0);throw Error('스레드 저장소 초기화가 완료되지 않았습니다.');}db.query('INSERT INTO thread_meta VALUES(1,?)').run(verifier);}
  return key;
 }
 private decode(row:Row,key:Buffer):StoredWorkroomThread {
  const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(row.nonce));cipher.setAAD(Buffer.from('workroom-thread-v1\0'+row.id));cipher.setAuthTag(Buffer.from(row.tag));
  const plain=Buffer.concat([cipher.update(Buffer.from(row.body)),cipher.final()]);
  try{const record=JSON.parse(plain.toString('utf8')) as StoredWorkroomThread;if(record.id!==row.id||!Array.isArray(record.messages)||row.target!==hash(record.targetId)||row.owner!==hash(record.owner)||row.state!==record.state||row.updated!==record.updatedAt||row.session!==(record.sessionId?hash(record.sessionId):'')||row.bytes!==plain.length)throw Error('스레드 기록과 색인이 일치하지 않습니다.');return record;}finally{plain.fill(0);}
 }
 private checkBudget(db:Database,r:StoredWorkroomThread,bytes:number){
  if(r.messages.length>512||bytes>512*1024)throw new WorkroomThreadAdmissionError('이 스레드의 기록 한도에 도달했습니다. 기록을 보존하고 새 업무 스레드를 사용하세요.');
  const total=db.query('SELECT COUNT(*) count,COALESCE(SUM(bytes),0) bytes FROM threads WHERE id<>?').get(r.id) as {count:number;bytes:number};
  if(total.count>=1000||total.bytes+bytes>100*1024*1024)throw new WorkroomThreadAdmissionError('스레드 저장 한도에 도달했습니다. 기존 기록은 삭제하지 않았습니다.');
 }
 private write(db:Database,key:Buffer,r:StoredWorkroomThread,metadataOnly=false){
  // Older hosts must not reopen a USE record as an ordinary DEV terminal.
  if(r.serviceExecution)db.query('UPDATE thread_meta SET version=3 WHERE version<3').run();
  if(r.readExecutions?.length){
   const version=(db.query('SELECT version FROM thread_meta').get() as {version:number}).version;
   if(version<4)throw Error('조회 영수증 저장 전 백업과 버전 준비가 필요합니다.');
  }
  const plain=Buffer.from(JSON.stringify(r));try{
   this.checkBudget(db,r,plain.length);
   const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from('workroom-thread-v1\0'+r.id));
   const body=Buffer.concat([cipher.update(plain),cipher.final()]);
   db.query('INSERT OR REPLACE INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(r.id,hash(r.targetId),hash(r.owner),r.state,r.updatedAt,r.sessionId?hash(r.sessionId):'',plain.length,nonce,body,cipher.getAuthTag());
   if(!metadataOnly&&r.group){
    db.query('DELETE FROM thread_group_members WHERE parent=?').run(r.id);
    for(const m of r.group.members)db.query('INSERT OR REPLACE INTO thread_group_members VALUES(?,?,?)').run(r.id,m.threadId,hash(m.targetId));
   }
   if(!metadataOnly&&r.groupParentId){
    const row=db.query('SELECT * FROM threads WHERE id=?').get(r.groupParentId) as Row|null;
    if(!row)throw Error('공동 업무 스레드를 찾을 수 없습니다.');
    const parent=this.decode(row,key),member=parent.group?.members.find(m=>m.threadId===r.id&&m.targetId===r.targetId);
    if(!member||parent.owner!==r.owner)throw Error('공동 업무의 프로젝트 연결을 확인하세요.');
    Object.assign(member,{sessionId:r.sessionId,state:r.state,revision:r.revision});
    for(const m of r.messages){
     if(m.seq===1)continue; // The shared initial task is recorded once on the parent.
     for(const [index,text] of sharedThreadTextParts(m.text).entries()){
      const id=index?'part_'+hash(r.id+'\0'+m.id+'\0'+index):m.id,previous=parent.messages.find(v=>v.id===id);
      if(previous){if(previous.targetId!==r.targetId||previous.text!==text)throw Error('공동 업무 메시지 식별자가 중복되었습니다.');previous.delivery=m.delivery;}
      else parent.messages.push({...m,id,text,seq:(parent.messages.at(-1)?.seq??0)+1,targetId:r.targetId,projectLabel:member.label});
     }
    }
    if(parent.state!=='closed'){
     const states=parent.group!.members.map(m=>m.state);
     parent.state=states.includes('unknown')?'unknown':states.includes('needs-answer')?'needs-answer':states.includes('starting')?'starting':states.every(v=>['completed','failed','closed'].includes(v))?(states.includes('failed')?'failed':'completed'):'running';
    }
    parent.updatedAt=parent.updatedAt>r.updatedAt?parent.updatedAt:r.updatedAt;parent.revision++;this.write(db,key,parent);
   }
  }finally{plain.fill(0);}
 }
 async get(id:string):Promise<StoredWorkroomThread|null>{
  if(!existsSync(this.file))return null;const db=this.open(false)!;let key:Buffer|undefined;
  try{const row=db.query('SELECT * FROM threads WHERE id=?').get(id) as Row|null;if(!row)return null;key=await this.key(db,false);return this.decode(row,key);}finally{key?.fill(0);db.close();}
 }
 async list(targetId:string,owner:string,all=false,beforeId?:string):Promise<StoredWorkroomThread[]>{
  if(!existsSync(this.file))return [];const db=this.open(false)!;let key:Buffer|undefined;
  try{const where="(target=? OR id IN (SELECT parent FROM thread_group_members WHERE target=?)) AND id NOT IN (SELECT child FROM thread_group_members)";const args:(string|number)[]=[hash(targetId),hash(targetId),...(all?[]:[hash(owner)])];let boundary='';
   if(beforeId){const anchor=db.query('SELECT updated,id FROM threads WHERE id=? AND '+where+(all?'':' AND owner=?')).get(beforeId,...args) as {updated:string;id:string}|null;if(!anchor)throw Error('업무 목록 위치를 다시 확인하세요.');boundary=' AND (updated<? OR updated=? AND id<?)';args.push(anchor.updated,anchor.updated,anchor.id);}
   const rows=db.query('SELECT * FROM threads WHERE '+where+(all?'':' AND owner=?')+boundary+' ORDER BY updated DESC,id DESC LIMIT 21').all(...args) as Row[];
   if(!rows.length)return [];key=await this.key(db,false);return rows.map(r=>this.decode(r,key!));
  }finally{key?.fill(0);db.close();}
 }
 async forSession(sessionId:string):Promise<StoredWorkroomThread|null>{
  if(!existsSync(this.file))return null;const db=this.open(false)!;let key:Buffer|undefined;
  try{const row=db.query('SELECT * FROM threads WHERE session=? LIMIT 1').get(hash(sessionId)) as Row|null;if(!row)return null;key=await this.key(db,false);return this.decode(row,key);}finally{key?.fill(0);db.close();}
 }
 private async writer<T>(active:()=>boolean,change:(db:Database,key:Buffer)=>T,prepareV4?:(db:Database,key:Buffer)=>boolean):Promise<T>{
  const release=await acquireOwnedFileLock(join(this.root,'workroom-threads.v1.lock'),{label:'workroom-threads',attempts:150,retryMs:20,deadOwnerRecoveryClass:'guarded',canRecoverDeadOwner:()=>{
   // Only a proven dead process's lock is considered. SQLite rolls back an interrupted transaction; key/schema
   // checks still run afterwards. No body, pending task, or existing key is removed to recover the writer lock.
   if(!existsSync(this.file))return true;try{const st=lstatSync(this.file);return st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&(process.platform==='win32'||st.uid===process.getuid?.()&&(st.mode&0o077)===0);}catch{return false;}
  }});
  let db:Database|null=null,key:Buffer|undefined;
  try{
   db=this.open(true)!;key=await this.key(db,true);
   if(!active()||!release.refresh())throw Error('작업 스레드 권한 또는 저장소 잠금이 변경되었습니다.');
   const upgrade=prepareV4?.(db,key)===true&&(db.query('SELECT version FROM thread_meta').get() as {version:number}).version<4;
   if(upgrade){
    // The same owned writer lease spans checkpoint, close, encrypted-file copy and reopen.
    // No key material is exported. A failed migration keeps both the old DB and backup.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();db=null;
    const backup=join(this.root,'workroom-threads.pre-v4.'+Date.now()+'-'+randomBytes(6).toString('hex')+'.sqlite');
    copyFileSync(this.file,backup,constants.COPYFILE_EXCL);
    const fd=openSync(backup,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}syncPromptGuideDirectory(this.root);
    db=this.open(false)!;
    const verified=await this.key(db,false);verified.fill(0);
    if(!active()||!release.refresh())throw Error('작업 스레드 권한 또는 저장소 잠금이 변경되었습니다.');
   }
   return db.transaction(()=>{if(upgrade)db!.query('UPDATE thread_meta SET version=4 WHERE version<4').run();return change(db!,key!);})();
  }finally{key?.fill(0);db?.close();release();}
 }
 /** Exact-row metadata update. Preparation runs under the existing writer lock before any v4 upgrade.
  * Other thread fields and indexes are taken from the current record, never from a caller snapshot. */
 async mutateReadExecutions<T>(id:string,active:()=>boolean,change:(current:StoredWorkroomThread)=>{readExecutions:ReadToolBatch[];value:T;unchanged?:true}):Promise<T>{
  let prepared:{readExecutions:ReadToolBatch[];value:T;unchanged?:true}|undefined;
  return this.writer(active,(db,key)=>{
   const row=db.query('SELECT * FROM threads WHERE id=?').get(id) as Row|null;
   if(!row||!prepared)throw Error('기존 작업 스레드를 확인하세요.');
   const current=this.decode(row,key);
   if(!prepared.unchanged)this.write(db,key,{...current,readExecutions:prepared.readExecutions},true);
   return prepared.value;
  },(db,key)=>{
   const row=db.query('SELECT * FROM threads WHERE id=?').get(id) as Row|null;
   if(!row)throw Error('기존 작업 스레드를 확인하세요.');
   const current=this.decode(row,key),original=JSON.stringify(current.readExecutions);
   const existing=structuredClone(current.readExecutions??[]);
   prepared=change(current);
   if(!Array.isArray(prepared.readExecutions)||new Set(prepared.readExecutions.map(v=>v.runId)).size!==prepared.readExecutions.length||new Set(prepared.readExecutions.map(v=>v.requestId)).size!==prepared.readExecutions.length
    ||existing.some((prior,index)=>{const next=prepared!.readExecutions[index];return !next||['runId','requestId','threadId','owner','targetId','bindingHash','intentHash','bootId','createdAt'].some(k=>(prior as any)[k]!== (next as any)[k]);}))throw Error('기존 조회 영수증을 삭제하거나 바꿀 수 없습니다.');
   if(!active())throw Error('작업 스레드 권한이 변경되었습니다.');
   if(prepared.unchanged&&original!==JSON.stringify(prepared.readExecutions))throw Error('변경되지 않은 조회 기록을 확인하세요.');
   if(!prepared.unchanged){const next={...current,readExecutions:prepared.readExecutions};this.checkBudget(db,next,Buffer.byteLength(JSON.stringify(next)));}
   return !prepared.unchanged&&prepared.readExecutions.length>0;
  });
 }
 async admitGroup(parent:StoredWorkroomThread,children:StoredWorkroomThread[],active:()=>boolean):Promise<boolean>{
  return this.writer(active,(db,key)=>{
   const prior=db.query('SELECT * FROM threads WHERE id=?').get(parent.id) as Row|null;
   if(prior){const record=this.decode(prior,key);if(record.intentHash!==parent.intentHash||record.owner!==parent.owner)throw Error('같은 요청 번호의 작업 내용이 바뀌었습니다.');return false;}
   const count=(db.query("SELECT COUNT(*) n FROM threads WHERE id NOT IN (SELECT parent FROM thread_group_members) AND state NOT IN ('completed','failed','closed')").get() as {n:number}).n;
   if(count+children.length>32)throw new WorkroomThreadAdmissionError('진행 중인 업무가 많습니다. 기존 스레드를 확인하세요.');
   for(const child of children){if(db.query('SELECT 1 FROM threads WHERE id=?').get(child.id))throw new WorkroomThreadAdmissionError('프로젝트별 업무 식별자가 이미 사용되었습니다.');}
   for(const child of children)if(db.query("SELECT 1 FROM threads WHERE target=? AND id NOT IN (SELECT parent FROM thread_group_members) AND state NOT IN ('completed','failed','closed') LIMIT 1").get(hash(child.targetId)))throw new WorkroomThreadAdmissionError('호출한 프로젝트의 이전 업무가 진행 중이거나 결과 확인이 필요합니다. 기존 스레드 또는 별도 워크트리를 사용하세요.');
   if(!active())throw Error('업무 실행 권한이 변경되었습니다.');
   db.query('UPDATE thread_meta SET version=2 WHERE version<2').run();
   this.write(db,key,parent);for(const child of children)this.write(db,key,child);return true;
  });
 }
 async mutate<T>(id:string,active:()=>boolean,change:(current:StoredWorkroomThread|null)=>{record:StoredWorkroomThread;value:T;unchanged?:true},exclusiveTarget=false):Promise<T>{
  return this.writer(active,(db,key)=>{

    const row=db.query('SELECT * FROM threads WHERE id=?').get(id) as Row|null;
    const current=row?this.decode(row,key):null,original=current?JSON.stringify(current):null;
    const originalReads=JSON.stringify(current?.readExecutions);
    const {record,value,unchanged}=change(current);
    if(JSON.stringify(record.readExecutions)!==originalReads)throw Error('조회 실행 메타데이터는 전용 facade로만 변경할 수 있습니다.');
    if(!active())throw Error('작업 스레드 권한이 변경되었습니다.');
    if(exclusiveTarget&&db.query("SELECT 1 FROM threads WHERE target=? AND id<>? AND id<>? AND id NOT IN (SELECT parent FROM thread_group_members) AND state NOT IN ('completed','failed','closed') LIMIT 1").get(hash(record.targetId),record.id,record.groupParentId??''))throw new WorkroomThreadAdmissionError('이 프로젝트의 이전 업무가 진행 중이거나 결과 확인이 필요합니다. 기존 스레드를 이어 쓰거나 별도 워크트리를 선택하세요.');
    if(exclusiveTarget&&!row&&Number((db.query("SELECT COUNT(*) n FROM threads WHERE id NOT IN (SELECT parent FROM thread_group_members) AND state NOT IN ('completed','failed','closed')").get() as {n:number}).n)>=32)throw new WorkroomThreadAdmissionError('진행 중이거나 확인할 업무가 많습니다. 기존 스레드를 확인한 뒤 새 업무를 보내세요.');
    if(unchanged){if(original===null||JSON.stringify(record)!==original)throw Error('변경되지 않은 스레드 기록을 확인하세요.');}
    else this.write(db,key,record);return value;
  });
 }
}
