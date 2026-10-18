import {Database,constants as sqlite} from 'bun:sqlite';
import {chmodSync,closeSync,existsSync,lstatSync,mkdirSync,openSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {TesterError,type TesterRun,type TesterTarget} from './testerAgentContract';
export interface TesterReceipt extends TesterRun { target:TesterTarget; root:string; rootIdentity:string; requestKey:string; digest:string; revision:string; remoteOwner?:string }
export class TesterAgentStore {
  private db:Database;
  constructor(directory:string) {
    const dir=join(directory,'tester-agent');mkdirSync(dir,{recursive:true,mode:0o700});
    const owner=process.getuid?.();
    const st=lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink()||owner!==undefined&&st.uid!==owner)throw new Error('TESTER_STORAGE_UNSAFE');
    chmodSync(dir,0o700);const path=join(realpathSync(dir),'runs-v1.sqlite');
    if(!existsSync(path)){const fd=openSync(path,'wx',0o600);closeSync(fd);}
    const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||owner!==undefined&&before.uid!==owner)throw new Error('TESTER_STORAGE_UNSAFE');
    chmodSync(path,0o600);this.db=new Database(path,sqlite.SQLITE_OPEN_READWRITE|sqlite.SQLITE_OPEN_NOFOLLOW);
    const after=lstatSync(path);if(before.ino!==after.ino||before.dev!==after.dev){this.db.close();throw new Error('TESTER_STORAGE_UNSAFE');}
    this.db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;');
    if((this.db.query('PRAGMA user_version').get() as {user_version:number}).user_version>1){this.db.close();throw new Error('TESTER_SCHEMA_UNSUPPORTED');}
    this.db.exec('CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, root TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL); PRAGMA user_version=1;');
    this.db.exec("UPDATE runs SET state='recovery-required', body=json_set(body,'$.state','recovery-required','$.message','이전 앱 실행의 종료 결과를 확인하세요. 자동 재실행하지 않습니다.') WHERE state IN ('queued','starting','running','canceling');");
  }
  private decode(row:unknown):TesterReceipt|null {return row?JSON.parse((row as {body:string}).body):null;}
  get(id:string){return this.decode(this.db.query('SELECT body FROM runs WHERE id=?').get(id));}
  request(key:string){return this.decode(this.db.query('SELECT body FROM runs WHERE request_key=?').get(key));}
  latest(root:string){return this.decode(this.db.query('SELECT body FROM runs WHERE root=? ORDER BY created_at DESC LIMIT 1').get(root));}
  active(root?:string):TesterReceipt[]{return (this.db.query("SELECT body FROM runs WHERE state IN ('queued','starting','running','canceling','recovery-required') AND (? IS NULL OR root=?) ORDER BY created_at LIMIT 32").all(root??null,root??null) as {body:string}[]).map(r=>JSON.parse(r.body));}
  save(r:TesterReceipt){this.db.query('UPDATE runs SET state=?,body=? WHERE id=?').run(r.state,JSON.stringify(r),r.id);}
  reserve(r:TesterReceipt):TesterReceipt {
    return this.db.transaction(()=>{
      const previous=this.request(r.requestKey);
      if(previous){if(previous.digest!==r.digest)throw new TesterError('TESTER_REQUEST_CONFLICT','같은 요청 ID의 검사 내용이 달라졌습니다.');return previous;}
      if(this.active().length>=16)throw new TesterError('TESTER_QUEUE_FULL','먼저 진행 중인 검사의 결과를 확인하세요.');
      if(this.active(r.root).length)throw new TesterError('TESTER_PROJECT_BUSY','이 프로젝트의 진행 중인 검사 또는 복구 결과를 먼저 확인하세요.');
      this.db.query("DELETE FROM runs WHERE created_at<? AND state NOT IN ('queued','starting','running','canceling','recovery-required')").run(new Date(Date.now()-30*86400000).toISOString());
      this.db.query('INSERT INTO runs VALUES(?,?,?,?,?,?)').run(r.id,r.requestKey,r.root,r.state,r.createdAt,JSON.stringify(r));
      return r;
    }).immediate();
  }
  close(){this.db.close();}
}
