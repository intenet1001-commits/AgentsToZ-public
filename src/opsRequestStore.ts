import {Database} from 'bun:sqlite';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {chmodSync,existsSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {createProductionPromptGuideKeyProvider,promptGuideDirectory,type PromptGuideKeyProvider} from './promptGuideKeyProvider';
import {OpsRequestError,type OpsRequestReceipt} from './opsRequestProtocol';

export interface OpsRequestOrigin {endpointId:string;deviceId:string;name:string}
export interface OpsRequestRecord {
  id:string;scope:string;origin:OpsRequestOrigin;text:string;token:string;receipt:OpsRequestReceipt;
  windowClaim?:{id:string;at:number};
  initialInputRevision?:number;released?:boolean;
  /** When the CLI start was claimed; the liveness bounds count from it until the first output. */
  startedAt?:number;
  /** Gave the queue back after an hour without output; its CLI may still be open until it exits or hands in a result. */
  abandoned?:true;
  /** A finished row past retention: its task text, capability and result are gone, its identity stays. */
  tombstone?:true;textHash?:string;
}
export interface OpsRequestStoreLimits {
  /** Rows that still carry their task and result. Tombstones do not count. */
  maxLiveRows:number;
  /** Unfinished rows on this receiver, and per calling device. */
  maxPending:number;maxPendingPerOrigin:number;
  /** Finished rows older than this become tombstones; tombstones beyond the cap go oldest first. */
  retentionMs:number;maxTombstones:number;
}
export const OPS_REQUEST_STORE_LIMITS:OpsRequestStoreLimits={maxLiveRows:1000,maxPending:32,maxPendingPerOrigin:8,retentionMs:30*24*60*60_000,maxTombstones:10_000};
const PENDING="('queued','starting','running','needs-attention')",FINISHED="('completed','failed','unknown')";
export const opsRequestTextHash=(text:string)=>createHash('sha256').update('agentstoz-ops-request-text\0').update(text).digest('hex');
/** The same task, whether the row still holds its text or only a tombstone's hash. */
export function opsRequestSameText(record:OpsRequestRecord,text:string):boolean{
  return record.tombstone?record.textHash===opsRequestTextHash(text):record.text===text;
}
function tombstoneOf(r:OpsRequestRecord):OpsRequestRecord{
  const note='보존 기간(30일)이 지나 작업 내용과 결과를 정리했습니다. 같은 요청 ID로는 다시 실행하지 않습니다.';
  const receipt=r.receipt.state==='completed'
    ?{version:r.receipt.version,requestId:r.receipt.requestId,state:r.receipt.state,createdAt:r.receipt.createdAt,updatedAt:r.receipt.updatedAt,windowOpened:true,result:note,evidence:'수신 OPS가 완료 결과를 제출했던 작업입니다.'}
    :{version:r.receipt.version,requestId:r.receipt.requestId,state:r.receipt.state,createdAt:r.receipt.createdAt,updatedAt:r.receipt.updatedAt,windowOpened:true,message:note};
  return {id:r.id,scope:r.scope,origin:{endpointId:'',deviceId:r.origin.deviceId,name:''},text:'',token:'',receipt,tombstone:true,textHash:opsRequestTextHash(r.text)};
}
type Row={id:string;nonce:Uint8Array;body:Uint8Array;tag:Uint8Array};
/**
 * Encrypted, bounded local ledger. Unfinished work is never evicted. Finished rows past retention keep
 * only their identity (a tombstone) so the same request ID does not run again while that tombstone
 * exists. Tombstones beyond the cap go oldest first, and that gives up deduplication for those IDs: a
 * caller may put any old request ID in a fresh envelope (the control channel's two-minute limit bounds
 * the envelope's age, not the request ID's), and it is then admitted as new work.
 */
export class OpsRequestStore {
  private file:string;
  private keys:PromptGuideKeyProvider;
  private keyPromise:Promise<Buffer>|null=null;
  private limits:OpsRequestStoreLimits;
  constructor(appDataDir:string,keyProvider?:PromptGuideKeyProvider,limits:Partial<OpsRequestStoreLimits>={}){
    this.limits={...OPS_REQUEST_STORE_LIMITS,...limits};
    const root=promptGuideDirectory(appDataDir,true)!;
    this.file=join(root,'ops-requests.v1.sqlite');
    this.keys=keyProvider??createProductionPromptGuideKeyProvider({appDataDir:root,namespace:{
      keychainService:'com.portmanager.portmanager.ops-requests.v1',keychainAccount:'ops-requests-v1',
      dpapiFile:'ops-requests.v1.key.dpapi',dpapiEntropy:'agentstoz-ops-requests-v1'}});
  }
  private open(){
    if(existsSync(this.file)){const st=lstatSync(this.file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw Error('OPS_REQUEST_PATH_UNSAFE');}
    const db=new Database(this.file,{create:true,strict:true});
    if(process.platform!=='win32')chmodSync(this.file,0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
    db.exec(`CREATE TABLE IF NOT EXISTS metadata(version INTEGER NOT NULL, verifier TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,scope TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,window_opened INTEGER NOT NULL,released INTEGER NOT NULL,nonce BLOB NOT NULL,body BLOB NOT NULL,tag BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_scope ON requests(scope,created_at);`);
    return db;
  }
  private async key(db:Database){
    const metas=db.query('SELECT * FROM metadata LIMIT 2').all() as {version:number;verifier:string}[];
    if(metas.length>1||metas[0]&&metas[0].version!==1)throw Error('OPS_REQUEST_SCHEMA_UNSUPPORTED');
    if(!metas.length&&db.query('SELECT 1 FROM requests LIMIT 1').get())throw Error('OPS_REQUEST_METADATA_MISSING');
    if(!this.keyPromise)this.keyPromise=(async()=>{
      let key=await this.keys.read();
      if(!key&&metas.length)throw Error('OPS_REQUEST_KEY_MISSING');
      key??=await this.keys.create();
      if(key.length!==32)throw Error('OPS_REQUEST_KEY_INVALID');return key;
    })().catch(e=>{this.keyPromise=null;throw e;});
    const key=await this.keyPromise;
    const verifier=createHash('sha256').update('agentstoz-ops-requests-v1\0').update(key).digest('hex');
    if(metas[0]&&metas[0].verifier!==verifier)throw Error('OPS_REQUEST_KEY_INVALID');
    if(!metas.length)db.query('INSERT INTO metadata VALUES(1,?)').run(verifier);
    return key;
  }
  private decode(row:Row,key:Buffer):OpsRequestRecord {
    const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(row.nonce));cipher.setAAD(Buffer.from(row.id));cipher.setAuthTag(Buffer.from(row.tag));
    const plain=Buffer.concat([cipher.update(Buffer.from(row.body)),cipher.final()]);
    try{return JSON.parse(plain.toString('utf8'));}finally{plain.fill(0);}
  }
  private write(db:Database,key:Buffer,r:OpsRequestRecord){
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(r.id));
    const plain=Buffer.from(JSON.stringify(r));
    try{
      const body=Buffer.concat([cipher.update(plain),cipher.final()]);
      // Every finished row without a recorded session has no worker to retire.
      const noWorker=!r.receipt.sessionId&&['completed','failed','unknown'].includes(r.receipt.state);
      db.query('INSERT OR REPLACE INTO requests VALUES(?,?,?,?,?,?,?,?,?)').run(r.id,r.scope,r.tombstone?'tombstone':r.receipt.state,r.receipt.createdAt,Number(r.receipt.windowOpened||r.receipt.windowFallback===true||noWorker),Number(!!r.released||noWorker),nonce,body,cipher.getAuthTag());
    }finally{plain.fill(0);}
  }
  hasData(){return existsSync(this.file);}
  async get(id:string):Promise<OpsRequestRecord|null>{
    if(!existsSync(this.file))return null;
    const db=this.open();try{
      const row=db.query('SELECT * FROM requests WHERE id=?').get(id) as Row|null;
      return row?this.decode(row,await this.key(db)):null;
    }finally{db.close();}
  }
  /**
   * Live rows of one scope, or of every scope with `null`. `workers` are rows whose CLI may still be
   * doing the peer's task; `results` are rows a worker can hand a result in for. Tombstones are never listed.
   */
  async list(scope:string|null,mode:'all'|'pending'|'windows'|'finished'|'workers'|'results'='all'):Promise<OpsRequestRecord[]>{
    if(!existsSync(this.file))return [];
    const filter={all:" AND state<>'tombstone'",pending:` AND state IN ${PENDING}`,
      windows:" AND state IN ('starting','running','needs-attention','completed','failed') AND window_opened=0",
      finished:" AND state IN ('completed','failed') AND released=0",
      workers:" AND state IN ('starting','running','needs-attention','unknown')",
      results:" AND state IN ('starting','running','needs-attention','unknown','completed','failed')"}[mode];
    const db=this.open();try{const key=await this.key(db);
      const rows=(scope===null?db.query('SELECT * FROM requests WHERE 1=1'+filter+' ORDER BY created_at,rowid LIMIT 1001').all()
        :db.query('SELECT * FROM requests WHERE scope=?'+filter+' ORDER BY created_at,rowid LIMIT 1001').all(scope)) as Row[];
      return rows.map(r=>this.decode(r,key));}finally{db.close();}
  }
  /** Turns finished rows past retention into tombstones and drops the oldest tombstones beyond the cap. */
  async prune(now:number):Promise<void>{
    if(!existsSync(this.file))return;
    const db=this.open();try{const key=await this.key(db);db.transaction(()=>{
      for(const row of db.query(`SELECT * FROM requests WHERE state IN ${FINISHED} AND created_at<? ORDER BY created_at,rowid LIMIT 500`).all(now-this.limits.retentionMs) as Row[])
        this.write(db,key,tombstoneOf(this.decode(row,key)));
      const excess=(db.query("SELECT COUNT(*) AS n FROM requests WHERE state='tombstone'").get() as {n:number}).n-this.limits.maxTombstones;
      if(excess>0)db.query("DELETE FROM requests WHERE id IN (SELECT id FROM requests WHERE state='tombstone' ORDER BY created_at,rowid LIMIT ?)").run(excess);
    }).immediate();}finally{db.close();}
  }
  async update(id:string,change:(record:OpsRequestRecord|null)=>OpsRequestRecord):Promise<OpsRequestRecord>{
    const db=this.open();try{const key=await this.key(db);return db.transaction(()=>{
      const row=db.query('SELECT * FROM requests WHERE id=?').get(id) as Row|null;
      if(!row&&(db.query("SELECT COUNT(*) AS n FROM requests WHERE state<>'tombstone'").get() as {n:number}).n>=this.limits.maxLiveRows)
        throw new OpsRequestError('OPS_REQUEST_CAPACITY','OPS 작업 장부가 가득 찼습니다. 끝난 작업은 30일 뒤 자동으로 정리됩니다. 기존 작업 결과를 확인하세요.');
      const prior=row?this.decode(row,key):null,before=JSON.stringify(prior);
      const next=change(prior);
      if(!row&&['queued','starting','running','needs-attention'].includes(next.receipt.state)){
        const pending=db.query(`SELECT * FROM requests WHERE state IN ${PENDING}`).all() as Row[];
        if(pending.length>=this.limits.maxPending)
          throw new OpsRequestError('OPS_REQUEST_QUEUE_FULL','대기 중인 OPS 작업이 많습니다. 기존 작업을 확인한 뒤 다시 접수하세요.');
        // One calling device must not occupy every slot of this receiver.
        if(pending.filter(r=>this.decode(r,key).origin.deviceId===next.origin.deviceId).length>=this.limits.maxPendingPerOrigin)
          throw new OpsRequestError('OPS_REQUEST_QUEUE_FULL','이 기기에서 맡긴 대기 중인 OPS 작업이 많습니다. 기존 작업을 확인한 뒤 다시 접수하세요.');
      }
      if(JSON.stringify(next)!==before)this.write(db,key,next);return next;
    }).immediate();}finally{db.close();}
  }
}
