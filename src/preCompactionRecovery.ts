import {Database, constants as sqlite} from 'bun:sqlite';
import {existsSync, chmodSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {MemorySaveInputStore, MEMORY_INPUT_TTL, type MemoryInputBinding} from './memorySaveInputStore';
import {saveDigest, saveToken} from './memorySaveContract';
import type {WorkspaceLease} from './workspaceLease';

export type RecoveryAgent = 'codex'|'claude'|'hermes'|'agy';
export interface RecoveryTarget {id:string; root:string; memoryId:string; name?:string; validate:()=>Promise<boolean>}
export interface RecoverySource {
  bytes:Buffer; sourceDigest:string; start:number; end:number;
  /** Source adapter has independently checked the session's exact workspace. */
  agent:RecoveryAgent; sessionId:string;
  verification?:'transcript-cwd'|'provider-db-cwd'|'provider-hook-workspace';
}
export interface RecoveryReceipt {
  projectId?:string;projectName?:string;
  id:string; agent:RecoveryAgent; sessionId:string; createdAt:number; expiresAt:number;
  start:number; end:number; coverage:'fragment'; binding:MemoryInputBinding;
  verification?:RecoverySource['verification'];
}
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** A write intent younger than this is never swept. Every capture also holds the app-data lease from before its
 * intent until after its receipt, so the age is a second, clock-based margin for a capture still in flight. */
export const RECOVERY_INTENT_GRACE=10*60*1000;
type StagedHeader=Awaited<ReturnType<MemorySaveInputStore['stage']>>;

/** Recovery bytes and canonical memory are separate outcomes. A synchronous
 * hook can retain an in-flight fragment without running AI or changing CORE.
 * Uses the existing OS key, encrypted staging, lease and seven-day retention.
 * No operation here creates a key or enables automatic model calls. */
export class PreCompactionRecovery {
  #busy=false;
  constructor(private d:{path:string;appDataRoot:string; supported:()=>boolean;
    acquire:()=>Promise<WorkspaceLease>;release:(lease:WorkspaceLease)=>void;
    readKey:()=>Promise<Buffer>;now?:()=>number}){}
  #now(){return this.d.now?.()??Date.now();}
  #db<T>(write:boolean,fn:(db:Database)=>T):T|null {
    if(!write&&!existsSync(this.d.path))return null;
    if(write)mkdirSync(dirname(this.d.path),{recursive:true,mode:0o700});
    const db=new Database(this.d.path,(write?sqlite.SQLITE_OPEN_READWRITE|sqlite.SQLITE_OPEN_CREATE:sqlite.SQLITE_OPEN_READONLY)|sqlite.SQLITE_OPEN_NOFOLLOW);
    try{
      db.run('PRAGMA busy_timeout=100');db.run('PRAGMA cache_size=-256');
      const version=(db.query('PRAGMA user_version').get() as {user_version:number}).user_version;
      if(version>2)throw Error('복구 저장 기록은 더 최신 앱이 필요합니다.');
      if(write){
        if(process.platform!=='win32')chmodSync(this.d.path,0o600);
        db.transaction(()=>{
          db.run('CREATE TABLE IF NOT EXISTS policies (memory_id TEXT PRIMARY KEY, root_digest TEXT NOT NULL, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, enabled_at INTEGER NOT NULL)');
          db.run('CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, created_at INTEGER NOT NULL, receipt TEXT NOT NULL, expired INTEGER NOT NULL DEFAULT 0)');
          db.run('CREATE INDEX IF NOT EXISTS checkpoints_recent ON checkpoints(memory_id,created_at DESC)');
          db.run('CREATE INDEX IF NOT EXISTS checkpoints_global_recent ON checkpoints(created_at DESC)');
          db.run('CREATE TABLE IF NOT EXISTS checkpoint_budgets (memory_id TEXT, revision INTEGER, agent TEXT, session_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(memory_id,revision,agent,session_id))');
          // Added without a version bump: an older app ignores it, and a sweep reads it only once it exists.
          db.run('CREATE TABLE IF NOT EXISTS checkpoint_intents (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, binding TEXT NOT NULL, unresolved INTEGER NOT NULL DEFAULT 0)');
          if(version<2)db.run("INSERT OR REPLACE INTO checkpoint_budgets SELECT memory_id,json_extract(receipt,'$.binding.policyEpoch'),json_extract(receipt,'$.agent'),json_extract(receipt,'$.sessionId'),MAX(created_at) FROM checkpoints GROUP BY memory_id,json_extract(receipt,'$.binding.policyEpoch'),json_extract(receipt,'$.agent'),json_extract(receipt,'$.sessionId')");
          db.run('PRAGMA user_version=2');
        })();
      }
      return fn(db);
    }finally{db.close();}
  }
  #policy(target:RecoveryTarget){
    const row=this.#db(false,db=>db.query('SELECT * FROM policies WHERE memory_id=?').get(target.memoryId)) as {
      root_digest:string;revision:number;enabled:number;enabled_at:number;
    }|null;
    return row&&row.root_digest===saveDigest(target.root)?row:null;
  }
  hasEnabledPolicies():boolean {
    return this.d.supported()&&!!this.#db(false,db=>db.query('SELECT 1 FROM policies WHERE enabled=1 LIMIT 1').get());
  }
  /** Content-free historical notifications. No key access or plaintext read. */
  notices(){
    const rows=this.#db(false,db=>db.query('SELECT receipt FROM checkpoints WHERE created_at>? ORDER BY created_at DESC,id LIMIT 12').all(this.#now()-MEMORY_INPUT_TTL)) as {receipt:string}[]|null;
    return (rows??[]).flatMap(row=>{
      const r=JSON.parse(row.receipt) as RecoveryReceipt;
      if(!r.projectId||!r.projectName||r.createdAt>this.#now()||r.expiresAt<=this.#now())return [];
      return [{id:r.id,projectId:r.projectId,projectName:r.projectName,agent:r.agent,savedAt:new Date(r.createdAt).toISOString(),expiresAt:new Date(r.expiresAt).toISOString()}];
    });
  }
  async status(target:RecoveryTarget){
    if(!await target.validate())throw Error('등록 프로젝트가 변경되었습니다.');
    const policy=this.#policy(target);
    const rows=this.#db(false,db=>db.query('SELECT receipt FROM checkpoints WHERE memory_id=? ORDER BY created_at DESC,id LIMIT 12').all(target.memoryId)) as {receipt:string}[]|null;
    const receipts=(rows??[]).map(row=>JSON.parse(row.receipt) as RecoveryReceipt).map(({binding:_,...receipt})=>({...receipt,expired:receipt.expiresAt<=this.#now()}));
    return {version:1,targetId:target.id,supported:this.d.supported(),enabled:policy?.enabled===1,revision:policy?.revision??0,
      retentionDays:7,coverage:'fragment' as const,memorySaved:false as const,receipts};
  }
  async setEnabled(target:RecoveryTarget,expectedRevision:number,enabled:boolean,consentVersion?:number){
    if(!this.d.supported()||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||enabled&&consentVersion!==1)throw Error('복구 저장 지원 상태와 별도 동의를 확인하세요.');
    if(!await target.validate())throw Error('등록 프로젝트가 변경되었습니다.');
    let lease:WorkspaceLease|undefined,key:Buffer|undefined;
    try{
      lease=await this.d.acquire();
      if(enabled){key=await this.d.readKey();if(key.length!==32)throw Error('암호화 키를 먼저 준비하세요.');}
      if(!lease.refresh()||!await target.validate())throw Error('등록 프로젝트가 변경되었습니다.');
      this.#db(true,db=>db.transaction(()=>{
        const prior=db.query('SELECT revision,root_digest FROM policies WHERE memory_id=?').get(target.memoryId) as {revision:number;root_digest:string}|null;
        if((prior?.revision??0)!==expectedRevision||prior&&prior.root_digest!==saveDigest(target.root))throw Error('설정이 바뀌었습니다. 다시 확인하세요.');
        db.query('INSERT OR REPLACE INTO policies VALUES (?,?,?,?,?)').run(target.memoryId,saveDigest(target.root),expectedRevision+1,enabled?1:0,this.#now());
      })());
    }finally{key?.fill(0);if(lease)this.d.release(lease);}
    return this.status(target);
  }
  async capture(target:RecoveryTarget,source:()=>Promise<RecoverySource>,periodic=false){
    const policy=this.#policy(target);
    if(!this.d.supported()||policy?.enabled!==1)return {localCheckpointSaved:false,memorySaved:false,reason:'disabled'};
    if(this.#busy)return {localCheckpointSaved:false,memorySaved:false,reason:'busy'};
    this.#busy=true;
    let lease:WorkspaceLease|undefined,key:Buffer|undefined,value:RecoverySource|undefined;
    try{
      if(!await target.validate())throw Error('등록 프로젝트가 변경되었습니다.');
      value=await source();
      if(!['codex','claude','hermes','agy'].includes(value.agent)||!saveToken(value.sessionId)||value.bytes.length<1||value.bytes.length>32_000
        ||digest(value.bytes)!==value.sourceDigest||!Number.isSafeInteger(value.start)||!Number.isSafeInteger(value.end)||value.start<0||value.end<=value.start)throw Error('복구 원본의 범위를 확인하지 못했습니다.');
      const id=saveDigest(['precompaction-v1',target.memoryId,policy.revision,value.agent,value.sessionId,value.start,value.end,value.sourceDigest]);
      lease=await this.d.acquire();
      const active=async()=>lease!.refresh()&&await target.validate()&&this.#policy(target)?.revision===policy.revision&&this.#policy(target)?.enabled===1;
      if(!await active())throw Error('저장 동의 또는 프로젝트가 변경되었습니다.');
      // An indexed exact-session lookup under the shared lease cannot be
      // defeated by 24 newer sessions or by a second host winning the race.
      if(periodic){
        const recent=this.#db(true,db=>db.query('SELECT created_at FROM checkpoint_budgets WHERE memory_id=? AND revision=? AND agent=? AND session_id=?').get(target.memoryId,policy.revision,value!.agent,value!.sessionId)) as {created_at:number}|null;
        if(recent&&this.#now()-recent.created_at<120_000)return {localCheckpointSaved:false,memorySaved:false,reason:'rate-limited'};
      }
      key=await this.d.readKey();
      const binding:MemoryInputBinding={saveId:id,memoryId:target.memoryId,policyEpoch:policy.revision,
        coverageDigest:saveDigest([value.agent,value.sessionId,value.start,value.end,value.sourceDigest]),inputDigest:value.sourceDigest,
        beforeHash:saveDigest([target.memoryId,target.root]),providerBindingDigest:saveDigest('precompaction-recovery-v1-no-ai')};
      const store=new MemorySaveInputStore(this.d.appDataRoot,lease,()=>this.#now(),'precompaction-inputs');
      // Write-ahead intent, recorded only while nothing is staged at this binding: if the process dies before the
      // receipt, the maintenance sweep can reclaim what this attempt created, and never a file it did not create.
      if(!store.exists(binding))this.#db(true,db=>db.query('INSERT OR REPLACE INTO checkpoint_intents (id,created_at,binding,unresolved) VALUES (?,?,?,0)').run(id,this.#now(),JSON.stringify(binding)));
      const header=await store.stage(binding,value.bytes,key);
      try{
        const readback=store.read(binding,key);
        try{if(!readback.equals(value.bytes)||!await active())throw Error('복구 저장의 읽기 검증이 완료되지 않았습니다.');}finally{readback.fill(0);}
      }catch(error){
        // The receipt transaction has not begun. Cleanup failure must not hide the original rejection.
        this.#discardUnreceipted(store,header,key,id);
        throw error;
      }
      const receipt:RecoveryReceipt={id,projectId:target.id,...(target.name?{projectName:target.name.slice(0,160)}:{}),agent:value.agent,sessionId:value.sessionId,createdAt:header.createdAt,expiresAt:header.expiresAt,
        start:value.start,end:value.end,coverage:'fragment',binding,verification:value.verification};
      try{
        this.#db(true,db=>db.transaction(()=>{
          db.query('INSERT OR IGNORE INTO checkpoints (id,memory_id,created_at,receipt) VALUES (?,?,?,?)').run(id,target.memoryId,receipt.createdAt,JSON.stringify(receipt));
          db.query('INSERT INTO checkpoint_budgets VALUES (?,?,?,?,?) ON CONFLICT(memory_id,revision,agent,session_id) DO UPDATE SET created_at=MAX(created_at,excluded.created_at)').run(target.memoryId,policy.revision,value!.agent,value!.sessionId,receipt.createdAt);
          db.query('DELETE FROM checkpoint_intents WHERE id=?').run(id);
        })());
      }catch(error){
        // The schema bootstrap, the INSERT or the COMMIT failed (e.g. SQLITE_BUSY). A fresh read under the same lease
        // decides: no receipt row means none committed, since a rollback journal never rolls forward. If that read
        // cannot answer, the file and its intent stay for the sweep, which asks the same question later.
        this.#discardUnreceipted(store,header,key,id);
        throw error;
      }
      return {localCheckpointSaved:true,memorySaved:false,remoteBackedUp:false,checkpointId:id,coverage:'fragment',expiresAt:header.createdAt+MEMORY_INPUT_TTL};
    }finally{value?.bytes.fill(0);key?.fill(0);if(lease)this.d.release(lease);this.#busy=false;}
  }
  /** Cleanup after a certain pre-receipt failure. Only this invocation's newly created file can be discarded (a
   * replay or a replaced file is retained), and only while a fresh read shows no receipt for this id. The intent row
   * goes with the file; if deleting it fails, the sweep finds an intent without a file and just clears it. */
  #discardUnreceipted(store:MemorySaveInputStore,header:StagedHeader,key:Buffer,id:string){
    try{
      const found=this.#db(false,db=>db.query('SELECT COUNT(*) AS count FROM checkpoints WHERE id=?').get(id)) as {count:number}|null;
      if(found?.count===0&&store.discardCreated(header,key))this.#db(true,db=>db.query('DELETE FROM checkpoint_intents WHERE id=?').run(id));
    }catch{}
  }
  /** Existing host maintenance tick calls this even after opt-out. Expired
   * ciphertext is authenticated before deletion; receipts remain as evidence.
   * Write intents past the grace age are settled under the lease every capture holds from intent to receipt: a
   * receipt keeps its file, a missing file only clears the intent, and an unreceipted file goes only when it
   * authenticates as that intent's binding. Anything else stays and its intent is marked unresolved, never retried. */
  async maintenance(){
    const now=this.#now();
    const intents=this.#db(false,db=>db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoint_intents'").get()
      ?db.query('SELECT id,created_at FROM checkpoint_intents WHERE unresolved=0 AND created_at<=? ORDER BY created_at LIMIT 24').all(now-RECOVERY_INTENT_GRACE):[]) as {id:string;created_at:number}[]|null;
    const rows=this.#db(false,db=>db.query('SELECT receipt FROM checkpoints WHERE expired=0 AND created_at<=? ORDER BY created_at LIMIT 24').all(now-MEMORY_INPUT_TTL)) as {receipt:string}[]|null;
    if(!rows?.length&&!intents?.length)return;
    const lease=await this.d.acquire();let key:Buffer|undefined;
    try{
      key=await this.d.readKey();const store=new MemorySaveInputStore(this.d.appDataRoot,lease,()=>this.#now(),'precompaction-inputs');
      for(const intent of intents??[]){
        if(!lease.refresh())throw Error('복구 입력 보관 작업의 잠금이 바뀌었습니다.');
        // Re-read under the lease: a capture that held it a moment ago may have committed and cleared this intent.
        const row=this.#db(false,db=>db.query('SELECT binding,(SELECT COUNT(*) FROM checkpoints WHERE id=?) AS receipts FROM checkpoint_intents WHERE id=? AND created_at=? AND unresolved=0').get(intent.id,intent.id,intent.created_at)) as {binding:string;receipts:number}|null;
        if(!row)continue;
        let binding:MemoryInputBinding|null=null;try{binding=JSON.parse(row.binding);}catch{}
        const outcome=row.receipts>0?'receipted':binding?.saveId===intent.id?store.discardUnreceipted(binding,key,intent.created_at):'retained';
        this.#db(true,db=>db.query(outcome==='retained'?'UPDATE checkpoint_intents SET unresolved=1 WHERE id=? AND created_at=?':'DELETE FROM checkpoint_intents WHERE id=? AND created_at=?').run(intent.id,intent.created_at));
      }
      for(const row of rows??[]){const r=JSON.parse(row.receipt) as RecoveryReceipt;
        if(!lease.refresh())throw Error('복구 입력 보관 작업의 잠금이 바뀌었습니다.');
        if(store.expire(r.binding,key))this.#db(true,db=>db.query('UPDATE checkpoints SET expired=1 WHERE id=?').run(r.id));
      }
    }finally{key?.fill(0);this.d.release(lease);}
  }
  /** Explicit, capability-protected recovery read. It never imports the bytes
   * into project memory or changes a remembered/backup completion boundary. */
  async read(target:RecoveryTarget,id:string){
    if(!/^[a-f0-9]{64}$/.test(id)||!await target.validate())throw Error('복구 대상을 확인하세요.');
    const row=this.#db(false,db=>db.query('SELECT receipt FROM checkpoints WHERE id=? AND memory_id=?').get(id,target.memoryId)) as {receipt:string}|null;
    if(!row)throw Error('복구 저장 영수증을 찾을 수 없습니다.');
    const receipt=JSON.parse(row.receipt) as RecoveryReceipt;
    if(receipt.binding.beforeHash!==saveDigest([target.memoryId,target.root]))throw Error('원래 프로젝트 연결이 바뀌었습니다.');
    const lease=await this.d.acquire();let key:Buffer|undefined,bytes:Buffer|undefined;
    try{
      key=await this.d.readKey();bytes=new MemorySaveInputStore(this.d.appDataRoot,lease,()=>this.#now(),'precompaction-inputs').read(receipt.binding,key);
      if(!await target.validate()||!lease.refresh())throw Error('등록 프로젝트가 변경되었습니다.');
      return {checkpointId:id,coverage:'fragment',authority:'historical-untrusted',text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),memorySaved:false};
    }finally{key?.fill(0);bytes?.fill(0);this.d.release(lease);}
  }
}
