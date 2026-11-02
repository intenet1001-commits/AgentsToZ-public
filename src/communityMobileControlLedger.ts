import {Database} from 'bun:sqlite';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {closeSync,constants,existsSync,fstatSync,lstatSync,openSync} from 'node:fs';
import {join} from 'node:path';
import {promptGuideDirectory} from './promptGuideKeyProvider';
import {mobileControlHash,mobileControlOperationTime,mobileControlPurpose,mobileControlUuid,MOBILE_CONTROL_MAX_RESULT} from './communityMobileControlProtocol';
import type {CommunityMobileRelayPurpose} from './communityAccessClient';

export interface MobileControlLedgerScope {profileId:string;communityId:string;deviceId:string}
export interface MobileControlReceipt {
  owner:string;operationId:string;createdAt:number;purpose:CommunityMobileRelayPurpose;commandDigest:string;scope:string;
  executionBoot:string;state:'pending'|'unknown'|'done';result:string|null;resultDigest:string|null;consumed:boolean;
}
const HEX=/^[a-f0-9]{64}$/,BOOT=/^[a-f0-9]{32}$/,WINDOW=30_000,MAX_FULL_ROWS=512,MAX_FULL_BYTES=16*1024*1024,MAX_TOMBSTONES=4096;
function fail(code:string):never{throw new Error(code);}
/** Separate domain/key/file from identity keys, dialogue records and the desktop transport ledger. */
export class CommunityMobileControlLedger {
  private readonly db:Database;private readonly key:Buffer;private readonly namespace:string;private closed=false;
  constructor(root:string,readonly identity:Readonly<MobileControlLedgerScope>,dataKey:Uint8Array,private readonly now=Date.now){
    if(![identity.profileId,identity.communityId,identity.deviceId].every(mobileControlUuid)||dataKey.length!==32)fail('MOBILE_STORE_IDENTITY_REQUIRED');
    this.identity=Object.freeze({...identity});this.key=Buffer.from(dataKey);
    this.namespace=JSON.stringify([2,identity.profileId,identity.communityId,identity.deviceId]);
    const file=join(promptGuideDirectory(root,true)!,`community-mobile-control-${mobileControlHash(this.namespace).slice(0,24)}.sqlite`);
    if(existsSync(file)){
      const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||(st.mode&0o077)!==0||(typeof process.getuid==='function'&&st.uid!==process.getuid()))fail('MOBILE_STORE_UNSAFE');
    }else{
      const fd=openSync(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      try{if(!fstatSync(fd).isFile())fail('MOBILE_STORE_UNSAFE');}finally{closeSync(fd);}
    }
    this.db=new Database(file,{create:false,strict:true});
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY CHECK(id=1),verifier TEXT NOT NULL,retired_before INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS receipts(owner TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,compact INTEGER NOT NULL,bytes INTEGER NOT NULL,body BLOB NOT NULL,PRIMARY KEY(owner,id));');
    const verifier=createHash('sha256').update('agentstoz.community-mobile-control/store-key/v2\0').update(this.key).update(this.namespace).digest('hex');
    const meta=this.db.query('SELECT verifier FROM metadata WHERE id=1').get() as {verifier:string}|null;
    if(meta&&meta.verifier!==verifier||!meta&&(this.db.query('SELECT count(*) n FROM receipts').get() as {n:number}).n!==0){this.db.close();this.key.fill(0);fail('MOBILE_STORE_KEY_MISMATCH');}
    if(!meta)this.db.query('INSERT INTO metadata VALUES(1,?,0)').run(verifier);
  }
  get retiredBefore():number {this.check();return (this.db.query('SELECT retired_before n FROM metadata WHERE id=1').get() as {n:number}).n;}
  private check(){if(this.closed)fail('MOBILE_STORE_CLOSED');}
  private aad(owner:string,id:string):Buffer{return Buffer.from('agentstoz.community-mobile-control/receipt/v2\0'+this.namespace+'\0'+owner+'\0'+id);}
  private validate(r:MobileControlReceipt):void{
    if(Object.keys(r).sort().join(',')!==['owner','operationId','createdAt','purpose','commandDigest','scope','executionBoot','state','result','resultDigest','consumed'].sort().join(','))fail('MOBILE_STORE_CORRUPT');
    if(!HEX.test(r.owner)||mobileControlOperationTime(r.operationId)!==r.createdAt||!mobileControlPurpose(r.purpose)||!HEX.test(r.commandDigest)
      ||typeof r.scope!=='string'||Buffer.byteLength(r.scope)>1024||!BOOT.test(r.executionBoot)||!['pending','unknown','done'].includes(r.state)||typeof r.consumed!=='boolean'
      ||r.state!=='done'&&(r.result!==null||r.resultDigest!==null||r.consumed))fail('MOBILE_STORE_CORRUPT');
    if(r.result!==null){if(typeof r.result!=='string'||Buffer.byteLength(r.result)>MOBILE_CONTROL_MAX_RESULT||r.resultDigest!==mobileControlHash(r.result)||r.consumed)fail('MOBILE_STORE_CORRUPT');try{JSON.parse(r.result);}catch{fail('MOBILE_STORE_CORRUPT');}}
    if(r.state==='done'&&(!r.resultDigest||!HEX.test(r.resultDigest)||r.result===null&&!r.consumed))fail('MOBILE_STORE_CORRUPT');
  }
  get(owner:string,id:string):MobileControlReceipt|null {
    this.check();if(!HEX.test(owner)||mobileControlOperationTime(id)===null)fail('MOBILE_INVALID_OPERATION');
    const stored=this.db.query('SELECT at,compact,bytes,body FROM receipts WHERE owner=? AND id=?').get(owner,id) as {at:number;compact:number;bytes:number;body:Uint8Array}|null;if(!stored)return null;
    try{
      const bytes=Buffer.from(stored.body);if(bytes.length<28||bytes.length!==stored.bytes)fail('MOBILE_STORE_CORRUPT');
      const cipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));cipher.setAAD(this.aad(owner,id));cipher.setAuthTag(bytes.subarray(12,28));
      const clear=Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]);
      try{const row=JSON.parse(clear.toString('utf8')) as MobileControlReceipt;this.validate(row);if(row.owner!==owner||row.operationId!==id||row.createdAt!==stored.at||stored.compact!==(row.consumed?1:0))fail('MOBILE_STORE_CORRUPT');return row;}finally{clear.fill(0);}
    }catch{fail('MOBILE_STORE_UNAVAILABLE');}
  }
  compact():void{
    this.check();const now=this.now();if(!Number.isSafeInteger(now)||now<0)fail('MOBILE_INVALID_CLOCK');
    const cutoff=Math.max(this.retiredBefore,now-WINDOW);
    this.db.transaction(()=>{this.db.query('UPDATE metadata SET retired_before=? WHERE id=1').run(cutoff);this.db.query('DELETE FROM receipts WHERE compact=1 AND at<?').run(cutoff);})();
  }
  private put(row:MobileControlReceipt):void {
    this.validate(row);const clear=Buffer.from(JSON.stringify(row));
    try{
      const bytes=clear.length+28,compact=row.consumed?1:0;
      const used=this.db.query('SELECT count(*) n,COALESCE(sum(bytes),0) bytes FROM receipts WHERE compact=? AND NOT(owner=? AND id=?)').get(compact,row.owner,row.operationId) as {n:number;bytes:number};
      if(used.n+1>(compact?MAX_TOMBSTONES:MAX_FULL_ROWS)||used.bytes+bytes>(compact?4*1024*1024:MAX_FULL_BYTES))fail('MOBILE_STORE_FULL');
      const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(this.aad(row.owner,row.operationId));
      const encrypted=Buffer.concat([cipher.update(clear),cipher.final()]);
      this.db.query('INSERT INTO receipts(owner,id,at,compact,bytes,body) VALUES(?,?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET compact=excluded.compact,bytes=excluded.bytes,body=excluded.body')
        .run(row.owner,row.operationId,row.createdAt,compact,bytes,Buffer.concat([nonce,cipher.getAuthTag(),encrypted]));
    }finally{clear.fill(0);}
  }
  reserve(row:Omit<MobileControlReceipt,'state'|'result'|'resultDigest'|'consumed'>):{fresh:boolean;receipt:MobileControlReceipt}{
    this.check();return this.db.transaction(()=>{
      this.compact();const prior=this.get(row.owner,row.operationId);
      if(prior){if(prior.createdAt!==row.createdAt||prior.purpose!==row.purpose||prior.commandDigest!==row.commandDigest||prior.scope!==row.scope)fail('MOBILE_OPERATION_ID_CONFLICT');return {fresh:false,receipt:prior};}
      if(mobileControlOperationTime(row.operationId)!==row.createdAt||row.createdAt<this.retiredBefore||row.createdAt<this.now()-WINDOW||row.createdAt>this.now()+5000)fail('MOBILE_OPERATION_EXPIRED');
      const receipt:MobileControlReceipt={...row,state:'pending',result:null,resultDigest:null,consumed:false};this.put(receipt);return {fresh:true,receipt};
    })();
  }
  settle(owner:string,id:string,result:string):MobileControlReceipt {
    this.check();return this.db.transaction(()=>{
      const row=this.get(owner,id);if(!row||!['pending','unknown','done'].includes(row.state)||row.consumed)fail('MOBILE_OPERATION_NOT_PENDING');
      if(row.state==='done'){if(row.result!==result)fail('MOBILE_OPERATION_RESULT_CONFLICT');return row;}
      const next:MobileControlReceipt={...row,state:'done',result,resultDigest:mobileControlHash(result)};this.put(next);return next;
    })();
  }
  unknown(owner:string,id:string):void{this.check();this.db.transaction(()=>{const row=this.get(owner,id);if(row?.state==='pending')this.put({...row,state:'unknown'});})();}
  consume(owner:string,id:string,createdAt:number,resultDigest:string):boolean{
    this.check();return this.db.transaction(()=>{
      this.compact();const row=this.get(owner,id);
      if(!row)return mobileControlOperationTime(id)===createdAt&&createdAt<this.retiredBefore;
      if(row.createdAt!==createdAt||row.state!=='done'||row.resultDigest!==resultDigest)return false;
      this.put({...row,result:null,consumed:true});this.compact();return true;
    })();
  }
  /** Missing/retired records are never proof that an effect did not run. */
  missingState(id:string):'expired'|'unseen'{return (mobileControlOperationTime(id)??Infinity)<this.retiredBefore?'expired':'unseen';}
  close(){if(this.closed)return;this.closed=true;this.db.close();this.key.fill(0);}
}
