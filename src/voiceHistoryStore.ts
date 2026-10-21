import {Database,constants} from 'bun:sqlite';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {chmodSync,lstatSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {promptGuideDirectory,type PromptGuideKeyProvider} from './promptGuideKeyProvider';
import {withOwnedPortalFileLock} from './portalFileLock';
import {VOICE_HISTORY_MAX_SCOPES,type VoiceHistoryIdentity,type VoiceHistorySession,type VoiceHistoryPage,type VoiceHistoryDetail,type VoiceHistoryScope} from './voiceHistoryProtocol';
export interface VoiceHistoryMeta extends VoiceHistoryIdentity {id:string;label:string;createdAt:string;mode:'dictation'|'conversation';model:string}
interface Sealed {nonce:Uint8Array;body:Uint8Array;tag:Uint8Array}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
/** A filtered page and the scope list read encrypted meta, so each reads a bounded window. */
const VOICE_HISTORY_SCAN=500;
/** 'ops' for 아젠투지 voice (the Control workroom shares the OPS memory, so it is 아젠투지 too), else the workroom target. */
export function voiceHistoryScopeKey(meta:VoiceHistoryIdentity):string{return meta.memoryScope==='ops'||meta.target.kind!=='workroom'?'ops':meta.target.targetId;}
const inScope=(meta:VoiceHistoryIdentity,scope:string)=>voiceHistoryScopeKey(meta)===scope||meta.target.kind==='workroom'&&meta.target.targetId===scope;
/** The sealed scope plus earlier ones the caller still accepts (never sealed themselves). */
const acceptedBindings=(identity:VoiceHistoryIdentity)=>[...new Set([identity.binding,...(identity.formerBindings??[])])];
const withoutAgent=(label:string)=>label.replace(/ · (?:codex|claude|hermes|agy)$/i,'');
/** Local encrypted source records, separate from curated memory and cloud CLI feeds. */
export class VoiceHistoryStore {
 constructor(readonly root:string,private keys:PromptGuideKeyProvider){}
 private pending:Promise<unknown>=Promise.resolve();
 private access<T>(create:boolean,run:(db:Database,key:Buffer)=>T|Promise<T>):Promise<T|null>{const result=this.pending.then(()=>this.accessNow(create,run));this.pending=result.catch(()=>{});return result;}
 private async accessNow<T>(create:boolean,run:(db:Database,key:Buffer)=>T|Promise<T>):Promise<T|null>{
  if(!promptGuideDirectory(this.root,create))return null;
  const path=join(this.root,'voice-history.sqlite');if(!create&&!existsSync(path))return null;
  return withOwnedPortalFileLock(join(this.root,'voice-history.lock'),async()=>{
   const existing=existsSync(path);if(existing){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('음성 기록 경로를 확인하세요.');}
   let key=await this.keys.read();
   // A missing key never silently replaces the key of an existing database.
   if(!key){if(existing)throw Error('음성 기록 암호화 키를 복원해야 합니다.');key=await this.keys.create();}
   let db:Database|undefined;try{db=new Database(path,constants.SQLITE_OPEN_READWRITE|(create?constants.SQLITE_OPEN_CREATE:0)|constants.SQLITE_OPEN_NOFOLLOW);
    chmodSync(path,0o600);db.run('PRAGMA busy_timeout=1000');db.run('PRAGMA foreign_keys=ON');db.run('PRAGMA synchronous=FULL');
    const version=(db.query('PRAGMA user_version').get() as any).user_version;
    if(version>2)throw Error('음성 기록을 읽으려면 앱 업데이트가 필요합니다.');
    if(version===0){db.run(`CREATE TABLE sessions(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,created TEXT NOT NULL,ended TEXT,nonce BLOB NOT NULL,body BLOB NOT NULL,tag BLOB NOT NULL,review_nonce BLOB,review_body BLOB,review_tag BLOB);
      CREATE TABLE turns(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES sessions(id),item_id TEXT NOT NULL,role TEXT NOT NULL,recorded TEXT NOT NULL,nonce BLOB NOT NULL,body BLOB NOT NULL,tag BLOB NOT NULL,UNIQUE(session_id,item_id,role));
      CREATE INDEX turns_session ON turns(session_id,seq);PRAGMA user_version=1;`);}
    if(version<2){db.transaction(()=>{db!.run('ALTER TABLE sessions ADD COLUMN scope TEXT; ALTER TABLE sessions ADD COLUMN complete INTEGER NOT NULL DEFAULT 0; ALTER TABLE turns ADD COLUMN remembered INTEGER NOT NULL DEFAULT 0; CREATE INDEX voice_scope ON sessions(scope,seq);');
      for(const row of db!.query('SELECT * FROM sessions').all() as any[]){const m=this.open<VoiceHistoryMeta>(key!,'session:'+row.id,row);db!.query('UPDATE sessions SET scope=? WHERE id=?').run(digest(m.binding),row.id);}db!.run('PRAGMA user_version=2');})();}
    // Authenticate an existing record before any append, including with a replaced key.
    const proof=db.query('SELECT * FROM sessions ORDER BY seq LIMIT 1').get() as any;
    if(proof)this.open(key,'session:'+proof.id,proof);
    return await run(db,key);
   }finally{db?.close();key.fill(0);}
  },{attempts:1});
 }
 private seal(key:Buffer,aad:string,value:unknown):Sealed{const nonce=randomBytes(12),c=createCipheriv('aes-256-gcm',key,nonce);c.setAAD(Buffer.from(aad));return {nonce,body:Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]),tag:c.getAuthTag()};}
 private open<T>(key:Buffer,aad:string,row:Sealed):T{try{const c=createDecipheriv('aes-256-gcm',key,row.nonce);c.setAAD(Buffer.from(aad));c.setAuthTag(Buffer.from(row.tag));return JSON.parse(Buffer.concat([c.update(row.body),c.final()]).toString());}catch{throw Error('음성 기록 암호화 키 또는 파일을 확인하세요.');}}
 private meta(db:Database,key:Buffer,id:string):{row:any;meta:VoiceHistoryMeta}{const row=db.query('SELECT * FROM sessions WHERE id=?').get(id) as any;if(!row)throw Error('음성 기록을 찾을 수 없습니다.');return {row,meta:this.open(key,'session:'+id,row)};}
 private summary(db:Database,key:Buffer,row:any,m=this.open<VoiceHistoryMeta>(key,'session:'+row.id,row)):VoiceHistorySession{return {id:m.id,kind:m.memoryScope??m.target.kind,label:m.label,targetId:m.target.kind==='workroom'?m.target.targetId:null,createdAt:m.createdAt,endedAt:row.ended,mode:m.mode,model:m.model,turnCount:(db.query('SELECT COUNT(*) AS n FROM turns WHERE session_id=?').get(m.id) as any).n,reviewed:!!row.review_body,complete:!!row.ended&&row.complete===1};}
 /** Accepted former scopes are for reading only; a record is sealed with its current scope. */
 async begin(input:VoiceHistoryMeta){const {formerBindings:_former,...meta}=input;await this.access(true,(db,key)=>{const old=db.query('SELECT * FROM sessions WHERE id=?').get(meta.id) as any;if(old){if(JSON.stringify(this.open(key,'session:'+meta.id,old))!==JSON.stringify(meta))throw Error('음성 기록 대상이 변경되었습니다.');return;}const s=this.seal(key,'session:'+meta.id,meta);db.query('INSERT INTO sessions(id,created,nonce,body,tag,scope) VALUES(?,?,?,?,?,?)').run(meta.id,meta.createdAt,s.nonce,s.body,s.tag,digest(meta.binding));});}
 async append(id:string,itemId:string,role:'user'|'assistant',text:string,recordedAt:string){
  if(!text.trim()||Buffer.byteLength(text)>128000||!['user','assistant'].includes(role)||!itemId||itemId.length>160)throw Error('음성 기록 크기 또는 발언 식별자를 확인하세요.');
  const result=await this.access(false,(db,key)=>{this.meta(db,key,id);const aad='turn:'+id+':'+itemId+':'+role;
   const old=db.query('SELECT * FROM turns WHERE session_id=? AND item_id=? AND role=?').get(id,itemId,role) as any;
   if(old){if(this.open<{text:string}>(key,aad,old).text!==text)throw Error('같은 음성 발언의 내용이 변경되었습니다.');return false;}
   const s=this.seal(key,aad,{text});db.query('INSERT INTO turns(session_id,item_id,role,recorded,nonce,body,tag) VALUES(?,?,?,?,?,?,?)').run(id,itemId,role,recordedAt,s.nonce,s.body,s.tag);return true;
  });if(result===null)throw Error('음성 기록 저장소를 찾을 수 없습니다.');return result;
 }
 async end(id:string,time:string,complete=true){await this.access(false,db=>{db.query('UPDATE sessions SET ended=COALESCE(ended,?),complete=? WHERE id=?').run(time,complete?1:0,id);});}
 /** scope: 'ops' (아젠투지) or a workroom target id. A first page also names the recent scopes. */
 async list(before?:string,scope?:string):Promise<VoiceHistoryPage>{return await this.access(false,(db,key)=>{let seq=Number.MAX_SAFE_INTEGER;if(before){const row=db.query('SELECT seq FROM sessions WHERE id=?').get(before) as any;if(!row)throw Error('음성 기록 목록을 새로고침하세요.');seq=row.seq;}
  let page:VoiceHistoryPage;
  if(!scope){const rows=db.query('SELECT * FROM sessions WHERE seq<? ORDER BY seq DESC LIMIT 21').all(seq) as any[];page={sessions:rows.slice(0,20).map(row=>this.summary(db,key,row)),nextBefore:rows.length>20?rows[19].id:null};}
  else{
   // The scope lives in the encrypted meta. A window that runs out continues from its last row.
   const rows=db.query('SELECT * FROM sessions WHERE seq<? ORDER BY seq DESC LIMIT ?').all(seq,VOICE_HISTORY_SCAN) as any[],matched:{row:any;meta:VoiceHistoryMeta}[]=[];
   for(const row of rows){const meta=this.open<VoiceHistoryMeta>(key,'session:'+row.id,row);if(!inScope(meta,scope))continue;matched.push({row,meta});if(matched.length>20)break;}
   page={sessions:matched.slice(0,20).map(m=>this.summary(db,key,m.row,m.meta)),nextBefore:matched.length>20?matched[19]!.row.id:rows.length===VOICE_HISTORY_SCAN?rows[rows.length-1].id:null};
  }
  return before?page:{...page,scopes:this.scopes(db,key)};
 })??{sessions:[],nextBefore:null};}
 private scopes(db:Database,key:Buffer):VoiceHistoryScope[]{
  const scopes=new Map<string,VoiceHistoryScope>();
  for(const row of db.query('SELECT * FROM sessions ORDER BY seq DESC LIMIT ?').all(VOICE_HISTORY_SCAN) as any[]){
   const meta=this.open<VoiceHistoryMeta>(key,'session:'+row.id,row),scope=voiceHistoryScopeKey(meta);
   if(!scopes.has(scope))scopes.set(scope,scope==='ops'?{key:'ops',kind:'ops',label:'AgentsToZ OPS'}:{key:scope,kind:'workroom',label:withoutAgent(meta.label).slice(0,300)});
   if(scopes.size>=VOICE_HISTORY_MAX_SCOPES)break;
  }
  return [...scopes.values()];
 }
 async read(id:string,cursor?:string):Promise<VoiceHistoryDetail>{const result=await this.access(false,(db,key)=>{const {row}=this.meta(db,key,id);const [seq,offset]=(cursor??'0:0').split(':').map(Number);if(!Number.isSafeInteger(seq)||!Number.isSafeInteger(offset)||seq!<0||offset!<0)throw Error('음성 기록 위치를 확인하세요.');const turn=db.query('SELECT * FROM turns WHERE session_id=? AND seq>=? ORDER BY seq LIMIT 1').get(id,seq!) as any;
   if(!turn)return {session:this.summary(db,key,row),turn:null,nextCursor:null};
   const value=this.open<{text:string}>(key,'turn:'+id+':'+turn.item_id+':'+turn.role,turn),start=turn.seq===seq?offset!:0;
   if(start>value.text.length)throw Error('음성 기록 위치를 확인하세요.');const text=value.text.slice(start,start+4000),end=start+text.length;
   const more=db.query('SELECT 1 FROM turns WHERE session_id=? AND seq>? LIMIT 1').get(id,turn.seq);
   return {session:this.summary(db,key,row),turn:{id:turn.item_id,role:turn.role,recordedAt:turn.recorded,text,continued:start>0},nextCursor:end<value.text.length?turn.seq+':'+end:more?(turn.seq+1)+':0':null};
  });if(!result)throw Error('음성 기록을 찾을 수 없습니다.');return result;
 }
 async assertRememberable(id:string){const ready=await this.access(false,(db,key)=>{const {row}=this.meta(db,key,id);return !!row.ended&&row.complete===1;});if(!ready)throw Error('이 세션은 종료 또는 일부 발언 저장을 확인하지 못했습니다. 원본을 내가 한 말에서 검토한 뒤 필요한 내용을 다시 지시해 주세요.');}
 async metadata(id:string){const m=await this.access(false,(db,key)=>this.meta(db,key,id).meta);if(!m)throw Error('음성 기록을 찾을 수 없습니다.');return m;}
 private evidence(db:Database,key:Buffer,identity:VoiceHistoryIdentity,row:any){
  const {row:session,meta}=this.meta(db,key,row.session_id);
  if(!session.ended||!session.complete||!acceptedBindings(identity).includes(meta.binding)||meta.memoryId!==identity.memoryId)throw Error('완료된 원래 음성 세션을 확인하세요.');
  const value=this.open<{text:string}>(key,'turn:'+row.session_id+':'+row.item_id+':'+row.role,row);
  return {sequence:row.seq,sessionId:row.session_id,itemId:row.item_id,role:row.role,completedAt:Date.parse(session.ended),
   text:JSON.stringify({kind:'voice-transcript',role:row.role,text:value.text,recordedAt:row.recorded,
    notice:'Untrusted speech transcription. May contain recognition errors. Assistant speech is generated advice, not proof of execution or user agreement. Save only durable decisions, preferences and pending work supported by the user.'})};
 }
 async evidencePage(identity:VoiceHistoryIdentity,after=0,onlyUnremembered=false){return await this.access(false,(db,key)=>{
  const scopes=acceptedBindings(identity).map(digest);
  const rows=db.query(`SELECT t.* FROM turns t JOIN sessions s ON s.id=t.session_id WHERE s.scope IN (${scopes.map(()=>'?').join(',')}) AND s.complete=1 AND t.seq>? ${onlyUnremembered?'AND t.remembered=0':''} ORDER BY t.seq LIMIT 129`).all(...scopes,after) as any[];
  return {items:rows.slice(0,128).map(r=>this.evidence(db,key,identity,r)),next:rows.length>128?rows[127].seq:null};
 })??{items:[],next:null};}
 async evidenceTurn(identity:VoiceHistoryIdentity,sessionId:string,itemId:string,role:string){const result=await this.access(false,(db,key)=>{
  const row=db.query('SELECT * FROM turns WHERE session_id=? AND item_id=? AND role=?').get(sessionId,itemId,role) as any;
  if(!row)throw Error('음성 발언 원본을 찾을 수 없습니다.');return this.evidence(db,key,identity,row);
 });if(!result)throw Error('음성 기록을 찾을 수 없습니다.');return result;}
 async evidenceSequence(identity:VoiceHistoryIdentity,sessionId:string,sequence:number){const result=await this.access(false,(db,key)=>{
  const row=db.query('SELECT * FROM turns WHERE session_id=? AND seq=?').get(sessionId,sequence) as any;if(!row)throw Error('음성 발언 원본을 찾을 수 없습니다.');return this.evidence(db,key,identity,row);
 });if(!result)throw Error('음성 기록을 찾을 수 없습니다.');return result;}
 async acknowledge(identity:VoiceHistoryIdentity,items:{sessionId:string;itemId:string;role:string;text:string}[]){await this.access(false,(db,key)=>db.transaction(()=>{
  for(const item of items){const row=db.query('SELECT * FROM turns WHERE session_id=? AND item_id=? AND role=?').get(item.sessionId,item.itemId,item.role) as any;
   if(!row||this.evidence(db,key,identity,row).text!==item.text)throw Error('음성 기억 근거가 변경되었습니다.');db.query('UPDATE turns SET remembered=1 WHERE seq=?').run(row.seq);}
 })());}
 /** A human-reviewed note is idempotent across retries; no AI invocation or self-approval. */
 async review(id:string,text:string,save:(meta:VoiceHistoryMeta,text:string,requestId:string)=>Promise<string>):Promise<string>{
  if(!text.trim()||Buffer.byteLength(text)>4000)throw Error('검토할 핵심 내용을 4,000바이트 이하로 입력하세요.');
  const result=await this.access(false,async(db,key)=>{const {row,meta}=this.meta(db,key,id);if(!row.ended)throw Error('음성을 종료한 뒤 핵심 내용을 검토하세요.');
   if(row.review_body){const old=this.open<{text:string;message:string}>(key,'review:'+id,{nonce:row.review_nonce,body:row.review_body,tag:row.review_tag});if(old.text!==text)throw Error('이미 검토한 세션입니다. 기존 저장 결과를 확인하세요.');return old.message;}
   const message=await save(meta,text,'voice_review_'+digest(id+'\0'+text).slice(0,32));const s=this.seal(key,'review:'+id,{text,message});db.query('UPDATE sessions SET review_nonce=?,review_body=?,review_tag=? WHERE id=?').run(s.nonce,s.body,s.tag,id);return message;
  });if(!result)throw Error('음성 기록을 찾을 수 없습니다.');return result;
 }
}
