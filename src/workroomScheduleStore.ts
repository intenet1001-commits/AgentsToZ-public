import {Database} from 'bun:sqlite';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {closeSync,existsSync,lstatSync,openSync} from 'node:fs';
import {join} from 'node:path';
import {createProductionPromptGuideKeyProvider,promptGuideDirectory,type PromptGuideKeyProvider} from './promptGuideKeyProvider';
import {WORKROOM_SCHEDULE_LIMITS,type WorkroomSchedule,type WorkroomScheduleRun} from './workroomScheduleProtocol';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const LEASED=['dispatching','submitted','unknown'];
type Row={id:string;kind:string;parent:string;state:string;lease:string;at:number;body:Uint8Array};
/** Private encrypted task text; a FULL-sync SQLite transaction owns both the occurrence and conversation lease. */
export class WorkroomScheduleStore {
  readonly file:string;
  private keys:PromptGuideKeyProvider;
  private loadedKey?:Buffer;
  constructor(appDataDir:string,keys?:PromptGuideKeyProvider){
    const root=promptGuideDirectory(appDataDir,true)!;this.file=join(root,'workroom-schedules.v1.sqlite');
    this.keys=keys??createProductionPromptGuideKeyProvider({appDataDir:root,namespace:{keychainService:'com.portmanager.portmanager.workroom-schedules.v1',keychainAccount:'workroom-schedules-v1',dpapiFile:'workroom-schedules.v1.key.dpapi',dpapiEntropy:'agentstoz-workroom-schedules-v1'}});
  }
  private open(create=false){
    if(!existsSync(this.file)){if(!create)return null;closeSync(openSync(this.file,'wx',0o600));}
    const s=lstatSync(this.file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||process.platform!=='win32'&&(s.uid!==process.getuid?.()||(s.mode&0o077)!==0))throw Error('예약 저장소 접근 권한을 확인하세요.');
    const db=new Database(this.file,{create:false,strict:true});
    try{
      // Even the schema-version read can race another process's immediate transaction.
      db.exec('PRAGMA busy_timeout=3000;');
      const version=db.query('PRAGMA user_version').get() as {user_version:number};
      if(version.user_version!==0&&version.user_version!==1)throw Error('예약 저장소 버전을 확인하세요.');
      db.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,kind TEXT NOT NULL,parent TEXT NOT NULL,state TEXT NOT NULL,lease TEXT NOT NULL,at INTEGER NOT NULL,body BLOB NOT NULL); CREATE INDEX IF NOT EXISTS schedules_lease ON schedules(kind,lease,state); CREATE TABLE IF NOT EXISTS schedule_key(verifier TEXT NOT NULL); CREATE TABLE IF NOT EXISTS schedule_run_owners(run_id TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL); PRAGMA user_version=1;');
      return db;
    }catch(e){db.close();throw e;}
  }
  private async key(db:Database,create=false){
    const rows=db.query('SELECT verifier FROM schedule_key LIMIT 2').all() as {verifier:string}[];
    let key=await this.keys.read();
    if(!key){if(!create||rows.length||db.query('SELECT 1 FROM schedules LIMIT 1').get())throw Error('예약 암호화 키가 없습니다. 기존 예약은 보존했습니다.');key=await this.keys.create();}
    if(key.length!==32){key.fill(0);throw Error('예약 암호화 키를 확인하세요.');}
    const verifier=hash('workroom-schedules-v1\0'+key.toString('hex'));
    if(rows.length>1||rows[0]&&rows[0].verifier!==verifier){key.fill(0);throw Error('기존 예약의 암호화 키와 다릅니다.');}
    if(!rows.length){if(!create){key.fill(0);throw Error('예약 저장소 초기화가 완료되지 않았습니다.');}db.query('INSERT INTO schedule_key VALUES(?)').run(verifier);}
    return key;
  }
  private decode<T extends WorkroomSchedule|WorkroomScheduleRun>(row:Row,key:Buffer):T {
    const bytes=Buffer.from(row.body);const c=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));c.setAAD(Buffer.from('schedule-v1\0'+row.id));c.setAuthTag(bytes.subarray(12,28));
    const plain=Buffer.concat([c.update(bytes.subarray(28)),c.final()]);
    try{
      const value=JSON.parse(plain.toString()) as T;
      if(value.id!==row.id||value.state!==row.state||('scheduleId' in value?value.scheduleId:'')!==row.parent
        ||('leaseKey' in value?value.leaseKey:hash(value.binding.sessionId))!==row.lease)throw Error('예약 기록과 색인이 다릅니다.');
      return value;
    }finally{plain.fill(0);}
  }
  private write(db:Database,key:Buffer,kind:'schedule'|'run',value:WorkroomSchedule|WorkroomScheduleRun){
    const nonce=randomBytes(12),c=createCipheriv('aes-256-gcm',key,nonce);c.setAAD(Buffer.from('schedule-v1\0'+value.id));
    const plain=Buffer.from(JSON.stringify(value));
    try{const body=Buffer.concat([c.update(plain),c.final()]);db.query('INSERT OR REPLACE INTO schedules VALUES(?,?,?,?,?,?,?)').run(value.id,kind,'scheduleId' in value?value.scheduleId:'',value.state,'leaseKey' in value?value.leaseKey:hash(value.binding.sessionId),'startedAt' in value?value.startedAt:value.nextAt,Buffer.concat([nonce,c.getAuthTag(),body]));}finally{plain.fill(0);}
  }
  private row(db:Database,id:string){return db.query('SELECT * FROM schedules WHERE id=?').get(id) as Row|null;}
  private async use<T>(create:boolean,run:(db:Database,key:Buffer)=>T):Promise<T|null>{
    const db=this.open(create);if(!db)return null;let key:Buffer|undefined;
    try{key=await this.key(db,create);if(this.loadedKey&&!this.loadedKey.equals(key))throw Error('예약 저장소의 키가 변경되었습니다.');this.loadedKey??=Buffer.from(key);return db.transaction(()=>run(db,key!)).immediate();}finally{key?.fill(0);db.close();}
  }
  async list(sessionId?:string){return await this.use(false,(db,key)=>(db.query("SELECT * FROM schedules WHERE kind='schedule' ORDER BY at LIMIT 33").all() as Row[]).map(r=>this.decode<WorkroomSchedule>(r,key)).filter(r=>!sessionId||r.binding.sessionId===sessionId))??[];}
  async get(id:string){return await this.use(false,(db,key)=>{const row=this.row(db,id);return row?.kind==='schedule'?this.decode<WorkroomSchedule>(row,key):null;});}
  async runs(id?:string){return await this.use(false,(db,key)=>(db.query("SELECT * FROM schedules WHERE kind='run' AND (? IS NULL OR parent=?) ORDER BY at DESC LIMIT 2048").all(id??null,id??null) as Row[]).map(r=>this.decode<WorkroomScheduleRun>(r,key)))??[];}
  async create(value:WorkroomSchedule){return this.use(true,(db,key)=>{
    const row=this.row(db,value.id);if(row){if(row.kind!=='schedule')throw Error('예약 번호가 충돌했습니다.');const prior=this.decode<WorkroomSchedule>(row,key);if(prior.binding.identity!==value.binding.identity||prior.intentHash!==value.intentHash)throw Error('같은 예약 번호에 다른 작업을 저장할 수 없습니다.');return prior;}
    const count=db.query("SELECT COUNT(*) n FROM schedules WHERE kind='schedule'").get() as {n:number};if(count.n>=WORKROOM_SCHEDULE_LIMITS.schedules)throw Error('예약은 최대 32개입니다. 기존 기록은 보존했습니다.');
    this.write(db,key,'schedule',value);return value;
  });}
  async change(id:string,revision:number,update:(s:WorkroomSchedule)=>void){return this.use(false,(db,key)=>{
    const row=this.row(db,id);if(!row||row.kind!=='schedule')throw Error('예약을 찾을 수 없습니다.');const s=this.decode<WorkroomSchedule>(row,key);
    if(s.revision!==revision)throw Error('예약이 변경되었습니다. 다시 확인하세요.');update(s);s.revision++;this.write(db,key,'schedule',s);return s;
  });}
  async claim(s:WorkroomSchedule,now:number,manualId?:string,owner?:string){return this.use(false,(db,key)=>{
    const id='schedule_run_'+hash(s.id+'\0'+(manualId??String(s.nextAt))).slice(0,48),prior=this.row(db,id);
    if(prior)return {run:this.decode<WorkroomScheduleRun>(prior,key),claimed:false};
    const row=this.row(db,s.id);if(!row)return null;const current=this.decode<WorkroomSchedule>(row,key);
    if(current.revision!==s.revision||current.state!=='active'||current.expiresAt<=now||current.runCount>=current.maxRuns||!manualId&&current.nextAt>now)return null;
    if(db.query("SELECT 1 FROM schedules WHERE kind='run' AND lease=? AND state IN ('dispatching','submitted','unknown') LIMIT 1").get(hash(s.binding.sessionId)))return null;
    const rows=(db.query("SELECT * FROM schedules WHERE kind='run'").all() as Row[]);
    if(rows.length>=WORKROOM_SCHEDULE_LIMITS.runs)throw Error('예약 실행 기록 한도입니다. 기존 기록은 보존했습니다.');
    if(rows.filter(r=>r.parent===s.id&&r.at>now-86400_000).length>=WORKROOM_SCHEDULE_LIMITS.runsPerDay)throw Error('이 예약의 24시간 8회 한도입니다.');
    const run:WorkroomScheduleRun={id,scheduleId:s.id,leaseKey:hash(s.binding.sessionId),consentRevision:s.consentRevision,state:'dispatching',startedAt:now,updatedAt:now,sessionId:s.binding.sessionId,reason:'실행 준비 기록을 저장했습니다.'};
    current.runCount++;current.revision++;current.retryAt=0;current.reason='실행 결과를 기다리는 중입니다.';
    current.nextAt=current.intervalMs?now+current.intervalMs:current.expiresAt;
    if(!current.intervalMs||current.runCount>=current.maxRuns)current.state='finished';
    this.write(db,key,'schedule',current);this.write(db,key,'run',run);
    if(owner)db.query('INSERT INTO schedule_run_owners VALUES(?,?,?)').run(run.id,owner,now+60_000);
    return {run,claimed:true};
  });}
  async settle(id:string,state:WorkroomScheduleRun['state'],reason:string,now:number,sessionId?:string,inputRevision?:number,owner?:string){return this.use(false,(db,key)=>{
    const row=this.row(db,id);if(!row||row.kind!=='run')throw Error('실행 기록을 찾을 수 없습니다.');const run=this.decode<WorkroomScheduleRun>(row,key);
    if(owner){const lease=db.query('SELECT owner,expires FROM schedule_run_owners WHERE run_id=?').get(id) as {owner:string;expires:number}|null;if(!lease||lease.owner!==owner||lease.expires<=now)return run;}
    if(!LEASED.includes(run.state)&&state!=='reviewed')return run;
    run.state=state;run.reason=reason.slice(0,500);run.updatedAt=now;if(sessionId)run.sessionId=sessionId;if(inputRevision!==undefined)run.inputRevision=inputRevision;this.write(db,key,'run',run);
    if(owner&&state==='submitted')db.query('UPDATE schedule_run_owners SET expires=? WHERE run_id=? AND owner=?').run(now+60_000,id,owner);
    return run;
  });}
  /** The original host may renew a submitted run only while another host has not already marked it unknown. */
  async renewOwned(owner:string,now:number){return this.use(false,db=>{
    db.query("UPDATE schedule_run_owners SET expires=? WHERE owner=? AND run_id IN (SELECT id FROM schedules WHERE kind='run' AND state='submitted')").run(now+60_000,owner);
  });}
  /** Classify and, after expiry, atomically mark orphaned executions unknown. Legacy rows get a grace period. */
  async observationOwner(id:string,owner:string,now:number){return this.use(false,(db,key)=>{
    const row=this.row(db,id);if(!row||row.kind!=='run')return {kind:'settled' as const};
    const run=this.decode<WorkroomScheduleRun>(row,key);if(!['dispatching','submitted'].includes(run.state))return {kind:'settled' as const};
    const lease=db.query('SELECT owner,expires FROM schedule_run_owners WHERE run_id=?').get(id) as {owner:string;expires:number}|null;
    if(lease&&lease.expires>now)return {kind:lease.owner===owner?'owned' as const:'other' as const};
    if(!lease&&run.updatedAt+60_000>now)return {kind:'other' as const};
    run.state='unknown';run.updatedAt=now;run.reason='원래 실행 호스트의 결과를 확인해야 합니다. 자동 재실행하지 않습니다.';this.write(db,key,'run',run);
    return {kind:'orphaned' as const,run};
  });}
  /** Record the resumed terminal before writing a prompt, under the original conversation lease. */
  async bindRestored(run:WorkroomScheduleRun,sessionId:string,now:number){return this.use(false,(db,key)=>{
    if(!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId))throw Error('복원된 워크룸 번호를 확인하세요.');
    const rr=this.row(db,run.id),sr=this.row(db,run.scheduleId);
    if(!rr||rr.kind!=='run'||!sr||sr.kind!=='schedule')throw Error('예약 실행 기록을 찾을 수 없습니다.');
    const current=this.decode<WorkroomScheduleRun>(rr,key),schedule=this.decode<WorkroomSchedule>(sr,key);
    if(current.state!=='dispatching'||current.leaseKey!==run.leaseKey||current.consentRevision!==run.consentRevision
      ||schedule.consentRevision!==run.consentRevision||!['active','finished'].includes(schedule.state)
      ||schedule.expiresAt<=now||now<run.startedAt||now-run.startedAt>=60_000)throw Error('복원 전에 예약 실행 동의가 변경되었습니다.');
    current.sessionId=sessionId;current.updatedAt=now;schedule.currentSessionId=sessionId;schedule.revision++;
    this.write(db,key,'run',current);this.write(db,key,'schedule',schedule);return current;
  });}
  /** Synchronous final write fence, also valid from a second host process. */
  authorized(run:WorkroomScheduleRun,now:number){
    if(!this.loadedKey)return false;const db=this.open(false);if(!db)return false;
    try{return db.transaction(()=>{
      const rr=this.row(db,run.id),sr=this.row(db,run.scheduleId);if(!rr||rr.kind!=='run'||!sr||sr.kind!=='schedule')return false;
      const r=this.decode<WorkroomScheduleRun>(rr,this.loadedKey!),s=this.decode<WorkroomSchedule>(sr,this.loadedKey!);
      return r.state==='dispatching'&&r.consentRevision===run.consentRevision&&s.consentRevision===run.consentRevision
        &&['active','finished'].includes(s.state)&&s.expiresAt>now&&now>=run.startedAt&&now-run.startedAt<60_000;
    })();}catch{return false;}finally{db.close();}
  }
  /** Serialize a synchronous native write/spawn against pause/stop across all hosts. Never await or re-enter this store inside effect. */
  withAuthorized<T>(run:WorkroomScheduleRun,now:number,effect:()=>T):T {
    if(!this.loadedKey)throw Error('예약 실행 동의를 확인할 수 없습니다.');
    const db=this.open(false);if(!db)throw Error('예약 실행 기록이 없습니다.');
    try{return db.transaction(()=>{
      const rr=this.row(db,run.id),sr=this.row(db,run.scheduleId);
      if(!rr||rr.kind!=='run'||!sr||sr.kind!=='schedule')throw Error('예약 실행 기록이 없습니다.');
      const r=this.decode<WorkroomScheduleRun>(rr,this.loadedKey!),s=this.decode<WorkroomSchedule>(sr,this.loadedKey!);
      if(r.state!=='dispatching'||r.consentRevision!==run.consentRevision||s.consentRevision!==run.consentRevision
        ||!['active','finished'].includes(s.state)||s.expiresAt<=now||now<run.startedAt||now-run.startedAt>=60_000)throw Error('예약 실행 동의가 변경되었습니다.');
      const result=effect();
      if(result&&typeof (result as any).then==='function')throw Error('예약 실행 경계는 동기 작업만 지원합니다.');
      return result;
    }).immediate();}finally{db.close();}
  }
  dispose(){this.loadedKey?.fill(0);this.loadedKey=undefined;}
}
