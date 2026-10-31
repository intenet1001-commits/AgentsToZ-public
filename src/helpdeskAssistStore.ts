import {Database,constants as sqlite} from 'bun:sqlite';
import {chmodSync,closeSync,existsSync,lstatSync,mkdirSync,openSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {ASSIST_SECRET_TEXT} from './helpdeskAssistRecipes';
import type {AssistRun} from './helpdeskAssistProtocol';
/** Where the engine is inside the current step. Internal: never in a view. `navigated` = this step's fixed address was
 * requested; `target` = the next target pattern; `arrived` = origin+path last checked before observing. */
export type AssistCursor={index:number;navigated:boolean;target:number;misses?:number};
/** `generation` rises whenever the person moves the run (start, pause, take, resume, done, cancel): a result computed
 * under an older generation keeps its receipts and check evidence and changes nothing else. */
export type AssistRecord=AssistRun&{requestId:string;fingerprint:string;ownerPid:number|null;cursor:AssistCursor;lastSeen:number;generation:number};
const MAX_RECORD=64_000,KEEP=20;
/** Unfinished runs are never pruned; past this many, a new one is refused until the person ends or reviews one. */
export const ASSIST_UNFINISHED_LIMIT=8;
const FINISHED=new Set(['completed','failed','cancelled']);
/** The support session's links only: recipe position, step states, ids of existing install/login/check work and
 * secret-free receipt summaries. Install, login, account and client state stay in their own hosts and stores.
 * Grants, auth URL queries, codes, client JSON, keys, tokens, DOM, screenshots and model output are never written. */
export class HelpdeskAssistStore {
 private db:Database;
 constructor(directory:string){
  const folder=join(directory,'onboarding');mkdirSync(folder,{recursive:true,mode:0o700});
  const info=lstatSync(folder);if(!info.isDirectory()||info.isSymbolicLink()||(process.platform!=='win32'&&info.uid!==process.getuid?.()))throw Error('ASSIST_STORAGE_UNSAFE');
  if(process.platform!=='win32')chmodSync(folder,0o700);
  const file=join(realpathSync(folder),'assistance-v1.sqlite');
  if(!existsSync(file))try{closeSync(openSync(file,'wx',0o600));}catch(e:any){if(e.code!=='EEXIST')throw e;}
  const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(process.platform!=='win32'&&stat.uid!==process.getuid?.()))throw Error('ASSIST_STORAGE_UNSAFE');
  if(process.platform!=='win32')chmodSync(file,0o600);
  this.db=new Database(file,sqlite.SQLITE_OPEN_READWRITE|sqlite.SQLITE_OPEN_NOFOLLOW);
  try{
   const opened=lstatSync(file);if(opened.dev!==stat.dev||opened.ino!==stat.ino||opened.isSymbolicLink())throw Error('ASSIST_STORAGE_UNSAFE');
   this.db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;');
   const schema=this.db.query('PRAGMA user_version').get() as {user_version:number};if(schema.user_version>1)throw Error('ASSIST_SCHEMA_UNSUPPORTED');
   this.db.exec('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, body TEXT NOT NULL); PRAGMA user_version=1;');
  }catch(e){this.db.close();throw e;}
 }
 close(){this.db.close();}
 private parse(body:string):AssistRecord{
  if(body.length>MAX_RECORD)throw Error('ASSIST_RECORD_UNREADABLE');const r=JSON.parse(body) as AssistRecord;
  if(!r||typeof r.id!=='string'||!Number.isSafeInteger(r.revision)||!Array.isArray(r.steps)||r.steps.length>16||!Array.isArray(r.receipts)||r.receipts.length>64||!Array.isArray(r.checks)||!r.cursor||!Number.isSafeInteger(r.cursor.index)||!Number.isSafeInteger(r.generation))throw Error('ASSIST_RECORD_UNREADABLE');
  return r;
 }
 private body(r:AssistRecord){
  const text=JSON.stringify(r);if(text.length>MAX_RECORD)throw Error('ASSIST_RECORD_TOO_LARGE');
  // A secret that slipped into a message or receipt is refused here rather than kept on disk.
  if(ASSIST_SECRET_TEXT.test(text))throw Error('ASSIST_RECORD_SECRET');
  return text;
 }
 get(id:string):AssistRecord|null{const row=this.db.query('SELECT body FROM runs WHERE id=?').get(id) as {body:string}|null;return row?this.parse(row.body):null;}
 byRequest(requestId:string):AssistRecord|null{const row=this.db.query('SELECT body FROM runs WHERE request_id=?').get(requestId) as {body:string}|null;return row?this.parse(row.body):null;}
 latest():AssistRecord|null{const row=this.db.query('SELECT body FROM runs ORDER BY updated_at DESC, rowid DESC LIMIT 1').get() as {body:string}|null;return row?this.parse(row.body):null;}
 all():AssistRecord[]{return (this.db.query('SELECT body FROM runs ORDER BY updated_at DESC, rowid DESC').all() as {body:string}[]).map(r=>this.parse(r.body));}
 create(r:AssistRecord):AssistRecord{
  return this.db.transaction(()=>{
   const same=this.byRequest(r.requestId);if(same)return same;
   const all=this.all();if(all.filter(x=>!FINISHED.has(x.state)).length>=ASSIST_UNFINISHED_LIMIT)throw Error('끝나지 않은 도움 기록이 많습니다. 진행 중이거나 확인이 필요한 도움을 끝낸 뒤 새로 시작해 주세요.');
   this.db.query('INSERT INTO runs(id,request_id,revision,updated_at,body) VALUES(?,?,?,?,?)').run(r.id,r.requestId,r.revision,r.updatedAt,this.body(r));
   // Only finished runs are pruned, oldest first; unfinished, unknown or review-needed runs stay until the person ends them.
   const finished=all.filter(x=>FINISHED.has(x.state));for(const o of finished.slice(Math.max(0,KEEP-1)))this.db.query('DELETE FROM runs WHERE id=?').run(o.id);
   return r;
  }).immediate();
 }
 /** Compare-and-swap on the run's revision. A stale caller changes nothing. */
 update(id:string,expected:number,fn:(current:AssistRecord)=>AssistRecord):AssistRecord{
  return this.db.transaction(()=>{
   const current=this.get(id);if(!current)throw Error('도움받기 기록을 찾지 못했습니다.');
   if(current.revision!==expected)throw Error('도움받기 상태가 바뀌었습니다. 최신 상태를 확인한 뒤 다시 요청하세요.');
   const next={...fn(structuredClone(current)),id,revision:current.revision+1,updatedAt:Date.now()};
   this.db.query('UPDATE runs SET revision=?, updated_at=?, body=? WHERE id=? AND revision=?').run(next.revision,next.updatedAt,this.body(next),id,expected);
   return next;
  }).immediate();
 }
}
