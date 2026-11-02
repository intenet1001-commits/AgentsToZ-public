import {Database} from 'bun:sqlite';
import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {promptGuideDirectory} from './promptGuideKeyProvider';
import {CommunityRelayClient,type CommunityRelaySocketFactory,type CommunityRelayRecord} from './communityRelayClient';
import {communityBase64,communityBytes,communityObject,type CommunityAccessEnvelope,type CommunityRelayTicket} from './communityAccessClient';
import {communityComponentHandshakeBytes,verifyCommunityComponentPeerProof,type CommunityComponentAuthorization,
  type CommunityComponentContext,type CommunityComponentHandshake,type CommunityComponentPurpose} from './communityComponentIdentity';

export interface AuthenticatedCommunityIdentity {
  context():Promise<CommunityComponentContext>;
  relayOrigin():Promise<string>;
  currentAuthorization(purpose:CommunityComponentPurpose):Promise<CommunityComponentAuthorization>;
  directory(purpose:CommunityComponentPurpose):Promise<CommunityComponentAuthorization[]>;
  verifyAuthorization(envelope:CommunityAccessEnvelope,deviceId?:string):Promise<CommunityComponentAuthorization>;
  ticket(purpose:CommunityComponentPurpose,connectionId:string,role:'host'|'client'):Promise<CommunityRelayTicket>;
  signRelayProof(purpose:CommunityComponentPurpose,ticket:CommunityRelayTicket,challenge:string):Promise<Uint8Array>;
  signHandshake(purpose:CommunityComponentPurpose,role:'sender'|'receiver',transcript:CommunityComponentHandshake,
    own:CommunityComponentAuthorization,peer:CommunityComponentAuthorization):Promise<Uint8Array>;
}
export interface AuthenticatedCommunityMembership {
  profileId:string;deviceId:string;sourceEndpointId:string;localEndpointIds:readonly string[];
  members:readonly {endpointId:string;deviceId:string;name:string}[];
}
export type CommunityControlOperation='control-send'|'control-result'|'control-inbox'|'control-respond';
export interface AgentDialogueControlTransport {
  bindMembership(read:()=>Promise<AuthenticatedCommunityMembership|null>):void;
  rpc(operation:CommunityControlOperation,profileId:string,deviceId:string,secret:string,args:Record<string,unknown>,
    purpose?:CommunityComponentPurpose):Promise<Record<string,any>>;
}
export class AuthenticatedCommunityError extends Error {
  constructor(readonly code:string,readonly outcome:'not-run'|'unknown'='not-run') {super(code);this.name='AuthenticatedCommunityError';}
}
function fail(code:string,outcome:'not-run'|'unknown'='not-run'):never{throw new AuthenticatedCommunityError(code,outcome);}
const utf8=new TextEncoder(),decode=new TextDecoder('utf-8',{fatal:true});
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const uid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const exact=(v:unknown,keys:readonly string[])=>communityObject(v,keys);
const buffer=(bytes:Uint8Array)=>new Uint8Array(bytes).buffer;
type Purpose=CommunityComponentPurpose;
export interface CommunityControlRow {
  id:string;profile:string;device:string;direction:'in'|'out';sourceEndpoint:string;targetEndpoint:string;
  fromDevice:string;toDevice:string;purpose:Purpose;digest:string;createdAt:number;state:'prepared'|'pending'|'taken'|'done'|'unknown';
  request:Record<string,unknown>|null;response:Record<string,unknown>|null;consumed?:boolean;
  peerPolicy:string;ownPolicy:string;ackPending?:boolean;receiptExpired?:boolean;
}
type Row=CommunityControlRow;
const REQUEST_WINDOW_MS=30_000;
const FULL_ROWS=512,FULL_BYTES=16*1024*1024,TOMBSTONE_ROWS=4096,TOMBSTONE_BYTES=4*1024*1024;
/** UUIDv7 binds the non-replayable admission timestamp to the original opaque control ID. */
export function communityControlId(at:number):string {
  if(!Number.isSafeInteger(at)||at<0||at>0xffffffffffff)fail('COMMUNITY_CONTROL_CLOCK_INVALID');
  const bytes=randomBytes(16);bytes.writeUIntBE(at,0,6);bytes[6]=(bytes[6]!&15)|0x70;bytes[8]=(bytes[8]!&63)|0x80;
  const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function communityControlIdTime(id:unknown):number|null {
  if(!uid(id)||id[14]!=='7'||!/[89ab]/.test(id[19]!))return null;
  return Number.parseInt(id.slice(0,8)+id.slice(9,13),16);
}
/** Local encrypted receipt ledger. Its key derives from the existing dialogue store key, never a transport identity key. */
export class CommunityControlLedger {
  private db:Database;
  constructor(root:string,readonly profile:string,readonly device:string,private readonly key:Buffer,private readonly now=Date.now) {
    const file=join(promptGuideDirectory(root,true)!,`community-control-${hash(profile+'\0'+device).slice(0,24)}.sqlite`);
    if(existsSync(file)){const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)fail('COMMUNITY_CONTROL_STORE_UNSAFE');}
    this.db=new Database(file,{create:true,strict:true});if(process.platform!=='win32')chmodSync(file,0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS control_rows(id TEXT PRIMARY KEY,state TEXT NOT NULL,direction TEXT NOT NULL,created_at INTEGER NOT NULL,body BLOB NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS control_metadata(verifier TEXT NOT NULL)');
    const metas=this.db.query('SELECT verifier FROM control_metadata LIMIT 2').all() as {verifier:string}[],verifier=hash(Buffer.concat([Buffer.from('agentstoz.community-control.store/v1\0'),key]));
    if(metas.length>1||metas[0]&&metas[0].verifier!==verifier||!metas.length&&(this.db.query('SELECT count(*) n FROM control_rows').get() as {n:number}).n>0){this.db.close();fail('COMMUNITY_CONTROL_STORE_KEY_MISMATCH','unknown');}
    if(!metas.length)this.db.query('INSERT INTO control_metadata(verifier) VALUES(?)').run(verifier);
    const columns=new Set((this.db.query('PRAGMA table_info(control_rows)').all() as {name:string}[]).map(c=>c.name));
    for(const name of ['body_bytes','compact','ack_pending','ack_scan'])if(!columns.has(name))this.db.exec(`ALTER TABLE control_rows ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
    this.db.exec('UPDATE control_rows SET body_bytes=length(body) WHERE body_bytes=0');
    const metaColumns=new Set((this.db.query('PRAGMA table_info(control_metadata)').all() as {name:string}[]).map(c=>c.name));
    if(!metaColumns.has('retired_before'))this.db.exec('ALTER TABLE control_metadata ADD COLUMN retired_before INTEGER NOT NULL DEFAULT 0');
  }
  get(id:string):Row|undefined {
    const row=this.db.query('SELECT body FROM control_rows WHERE id=?').get(id) as {body:Uint8Array}|null;if(!row)return undefined;
    try {const bytes=Buffer.from(row.body),cipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));cipher.setAAD(Buffer.from(id));cipher.setAuthTag(bytes.subarray(12,28));
      const clear=Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]);try{return JSON.parse(clear.toString('utf8'));}finally{clear.fill(0);}}
    catch{return fail('COMMUNITY_CONTROL_STORE_UNAVAILABLE','unknown');}
  }
  get retiredBefore():number {return (this.db.query('SELECT retired_before n FROM control_metadata').get() as {n:number}).n;}
  compact():void {
    const cutoff=Math.max(this.retiredBefore,this.now()-REQUEST_WINDOW_MS);
    this.db.transaction(()=>{
      // The durable high-water mark prevents a wall-clock rollback from reopening retired IDs.
      this.db.query('UPDATE control_metadata SET retired_before=?').run(cutoff);
      this.db.query("DELETE FROM control_rows WHERE compact=1 AND created_at<? AND (direction='in' OR ack_pending=0)").run(cutoff);
    })();
  }
  put(row:Row):void {
    this.db.transaction(()=>{
      this.compact();
      const compact=row.state==='done'&&row.consumed===true&&row.request===null&&row.response===null&&communityControlIdTime(row.id)===row.createdAt;
      if(compact&&row.createdAt<this.retiredBefore&&(row.direction==='in'||!row.ackPending)){
        this.db.query('DELETE FROM control_rows WHERE id=?').run(row.id);return;
      }
      const clear=Buffer.from(JSON.stringify(row));
      try {
        const bytes=clear.length+28;if(bytes>300_000)fail('COMMUNITY_CONTROL_ROW_TOO_LARGE');
        const total=this.db.query('SELECT count(*) n,COALESCE(sum(body_bytes),0) bytes FROM control_rows WHERE compact=? AND id<>?').get(compact?1:0,row.id) as {n:number;bytes:number};
        if(total.n+1>(compact?TOMBSTONE_ROWS:FULL_ROWS)||total.bytes+bytes>(compact?TOMBSTONE_BYTES:FULL_BYTES))fail('COMMUNITY_CONTROL_STORE_FULL');
        const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(Buffer.from(row.id));
        const encrypted=Buffer.concat([cipher.update(clear),cipher.final()]);
        this.db.query('INSERT INTO control_rows(id,state,direction,created_at,body,body_bytes,compact,ack_pending) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,body=excluded.body,body_bytes=excluded.body_bytes,compact=excluded.compact,ack_pending=excluded.ack_pending')
          .run(row.id,row.state,row.direction,row.createdAt,Buffer.concat([nonce,cipher.getAuthTag(),encrypted]),bytes,compact?1:0,row.ackPending?1:0);
      }finally{clear.fill(0);}
    })();
  }
  pendingConsumption():Row[]{return this.db.transaction(()=>{
    // Rotate a bounded batch even when an offline peer retains the oldest acknowledgement.
    const ids=this.db.query("SELECT id FROM control_rows WHERE compact=1 AND direction='out' AND ack_pending=1 ORDER BY ack_scan,created_at,id LIMIT 16").all() as {id:string}[];
    const next=(this.db.query('SELECT COALESCE(max(ack_scan),0)+1 n FROM control_rows').get() as {n:number}).n;
    for(const {id}of ids)this.db.query('UPDATE control_rows SET ack_scan=? WHERE id=?').run(next,id);
    return ids.map(r=>this.get(r.id)!);
  })();}
  pending():Row[]{return (this.db.query("SELECT id FROM control_rows WHERE direction='in' AND state='pending' ORDER BY created_at,id LIMIT 16").all() as {id:string}[]).map(r=>this.get(r.id)!);}
  claim(id:string):Row|undefined {return this.db.transaction(()=>{const row=this.get(id);if(!row||row.state!=='pending')return undefined;row.state='taken';this.put(row);return row;})();}
  close(){this.db.close();this.key.fill(0);}
}

interface CryptoKeys {send:CryptoKey;receive:CryptoKey;senderConfirm:CryptoKey;receiverConfirm:CryptoKey;digest:Uint8Array}
async function agreement(privateKey:CryptoKey,peer:string,transcript:CommunityComponentHandshake,side:'sender'|'receiver'):Promise<CryptoKeys>{
  const publicKey=await crypto.subtle.importKey('raw',buffer(communityBytes(peer,65)),{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:publicKey},privateKey,256));
  try {
    const material=await crypto.subtle.importKey('raw',buffer(shared),'HKDF',false,['deriveKey']);
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',buffer(communityComponentHandshakeBytes(transcript,'sender'))));
    const derive=async(label:string,algorithm:AesKeyGenParams|HmacKeyGenParams,usages:KeyUsage[])=>crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:buffer(digest),
      info:buffer(utf8.encode('agentstoz.community-control/channel/v1\0'+transcript.purpose+'\0'+label))},material,algorithm,false,usages);
    const a=await derive('sender-to-receiver',{name:'AES-GCM',length:256},[side==='sender'?'encrypt':'decrypt']);
    const b=await derive('receiver-to-sender',{name:'AES-GCM',length:256},[side==='receiver'?'encrypt':'decrypt']);
    return {send:side==='sender'?a:b,receive:side==='sender'?b:a,digest,
      senderConfirm:await derive('sender-confirm',{name:'HMAC',hash:'SHA-256',length:256},['sign','verify']),
      receiverConfirm:await derive('receiver-confirm',{name:'HMAC',hash:'SHA-256',length:256},['sign','verify'])};
  }finally{shared.fill(0);}
}
const freshKey=async()=>{const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  return {key:pair.privateKey,publicKey:communityBase64(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)))};};
async function confirmation(keys:CryptoKeys,role:'sender'|'receiver',proof:string):Promise<string>{
  return communityBase64(new Uint8Array(await crypto.subtle.sign('HMAC',role==='sender'?keys.senderConfirm:keys.receiverConfirm,
    buffer(utf8.encode(role+'\0'+communityBase64(keys.digest)+'\0'+proof)))));
}
async function verifyConfirmation(keys:CryptoKeys,role:'sender'|'receiver',proof:string,value:unknown):Promise<boolean>{
  try{return await crypto.subtle.verify('HMAC',role==='sender'?keys.senderConfirm:keys.receiverConfirm,buffer(communityBytes(value,32)),
    buffer(utf8.encode(role+'\0'+communityBase64(keys.digest)+'\0'+proof)));}catch{return false;}
}
function nonce(sequence:number,direction:'sender'|'receiver'):Uint8Array {
  const bytes=new Uint8Array(12);bytes.set(utf8.encode(direction==='sender'?'a2b\0':'b2a\0'));
  const view=new DataView(bytes.buffer);view.setUint32(4,Math.floor(sequence/0x100000000));view.setUint32(8,sequence%0x100000000);return bytes;
}
interface Channel {
  side:'sender'|'receiver';purpose:Purpose;peer:CommunityComponentAuthorization;own:CommunityComponentAuthorization;role:'host'|'client';
  remoteConnection:string;session:string;transcript:CommunityComponentHandshake;keys:CryptoKeys;ready:boolean;sendSeq:number;receiveSeq:number;
  resolve?:()=>void;reject?:(error:Error)=>void;timeout?:ReturnType<typeof setTimeout>;
  tail?:Promise<void>;
}
interface Opening {peer:CommunityComponentAuthorization;own:CommunityComponentAuthorization;key:CryptoKey;publicKey:string;nonce:string;instance:string;
  purpose:Purpose;answered?:boolean;resolve:(channel:Channel)=>void;reject:(error:Error)=>void;timeout:ReturnType<typeof setTimeout>}
interface Link {client:CommunityRelayClient;connection:string;ticket?:CommunityRelayTicket;nextWrite:number}
interface Part {total:number;count:number;next:number;bytes:Uint8Array[];length:number;until:number}

/** Outbound-only Cloudflare transport. Execution still runs exclusively through AgentDialogueHost's existing dispatcher. */
export class AuthenticatedCommunityTransport implements AgentDialogueControlTransport {
  private membership:()=>Promise<AuthenticatedCommunityMembership|null>=async()=>null;
  private ledger?:CommunityControlLedger;private ledgerScope='';private storageIdentity?:{profile:string;device:string};
  private links=new Map<string,Promise<Link>>();private channels=new Map<string,Channel>();private openings=new Map<string,Opening>();
  private parts=new Map<string,Part>();private queued=new Map<string,number>();private inboundTails=new Map<string,Promise<void>>();
  private pendingOpen=new Map<string,Promise<Channel>>();private helloSeen=new Map<string,number>();private closed=false;private generation=0;
  private responseDeliveries=new Set<string>();
  private ownCache=new Map<Purpose,{value:CommunityComponentAuthorization;until:number}>();
  private directoryCache=new Map<Purpose,{value:CommunityComponentAuthorization[];until:number}>();
  constructor(private readonly root:string,private readonly identity:AuthenticatedCommunityIdentity,private readonly sockets:CommunityRelaySocketFactory,
    private readonly teamsReady=false,private readonly now=Date.now){}
  bindMembership(read:()=>Promise<AuthenticatedCommunityMembership|null>){this.membership=read;}
  private prune(){
    const now=this.now();this.ledger?.compact();for(const [key,part]of this.parts)if(part.until<=now)this.parts.delete(key);
    for(const [key,ch]of this.channels)if(!ch.own.isCurrent(now)||!ch.peer.isCurrent(now)){clearTimeout(ch.timeout);this.channels.delete(key);}
    for(const [key,until]of this.helloSeen)if(until<=now)this.helloSeen.delete(key);
    for(const [key,at]of this.receiptReadAt)if(at<now-60_000)this.receiptReadAt.delete(key);
  }
  private store(profile:string,device:string,secret:string):CommunityControlLedger {
    const scope=hash(profile+'\0'+device+'\0'+secret);
    if(this.ledger&&this.ledgerScope!==scope)fail('COMMUNITY_CONTROL_IDENTITY_CHANGED','unknown');
    if(!this.ledger){this.ledger=new CommunityControlLedger(this.root,profile,device,createHash('sha256').update('agentstoz.community-control.store/v1\0'+profile+'\0'+device+'\0'+secret).digest(),this.now);this.ledgerScope=scope;}
    this.storageIdentity={profile,device};return this.ledger;
  }
  private async self(profile:string,device:string,purpose:Purpose){
    if(purpose==='teams'&&!this.teamsReady)fail('COMMUNITY_TEAMS_ROUTE_UNAVAILABLE');
    const context=await this.identity.context();if(context.profileId!==profile||context.agentDeviceId!==device)fail('COMMUNITY_COMPONENT_IDENTITY_MISMATCH');
    const own=await this.authorization(purpose);if(!own.permits(purpose,this.now())||own.body.deviceId!==context.deviceId||own.body.agentDeviceId!==device)fail('COMMUNITY_COMPONENT_NOT_AUTHORIZED');return own;
  }
  private async authorization(purpose:Purpose):Promise<CommunityComponentAuthorization>{
    // Native local-off/identity is checked even while a short issuer lease is reused. No native key is cached here.
    await this.identity.context();const cached=this.ownCache.get(purpose);
    if(cached&&cached.until>this.now()&&cached.value.permits(purpose,this.now()))return cached.value;
    const value=await this.identity.currentAuthorization(purpose);this.ownCache.set(purpose,{value,until:Math.min(this.now()+5000,value.body.expiresAt)});return value;
  }
  private async peer(portalID:string,purpose:Purpose):Promise<CommunityComponentAuthorization>{
    let cached=this.directoryCache.get(purpose);if(!cached||cached.until<=this.now()){
      const value=await this.identity.directory(purpose);cached={value,until:Math.min(this.now()+5000,...value.map(a=>a.body.expiresAt))};this.directoryCache.set(purpose,cached);
    }
    const peers=cached.value.filter(a=>a.body.agentDeviceId===portalID&&a.permits(purpose,this.now()));
    if(peers.length!==1)fail('COMMUNITY_COMPONENT_PEER_UNAVAILABLE');return peers[0]!;
  }
  private async link(purpose:Purpose,role:'host'|'client'):Promise<Link>{
    if(this.closed)fail('COMMUNITY_CONNECTION_ENDED');
    const key=purpose+':'+role,prior=this.links.get(key);if(prior)return prior;
    const promise=(async()=>{
      const c=await this.identity.context(),origin=await this.identity.relayOrigin();let link:Link;
      const client=new CommunityRelayClient(origin,{communityId:c.communityId,enrollmentId:c.enrollmentId,deviceId:c.deviceId,purpose,role,sessionId:null},
        {publicKey:c.publicKey,signRelayProof:input=>this.identity.signRelayProof(purpose,link.ticket!,input.challenge)},
        async connection=>{const ticket=await this.identity.ticket(purpose,connection,role);link.connection=connection;link.ticket=ticket;return ticket;},this.sockets,
        record=>this.enqueueInbound(purpose,role,record),()=>{if(this.links.get(key)===promise)this.links.delete(key);
          for(const [session,ch]of this.channels)if(ch.purpose===purpose&&ch.role===role){ch.reject?.(new Error('COMMUNITY_CONNECTION_ENDED'));this.channels.delete(session);}},
        this.now,peer=>{for(const [session,ch]of this.channels)if(ch.purpose===purpose&&ch.role===role&&ch.peer.body.deviceId===peer.from&&ch.remoteConnection===peer.fromConnection)this.channels.delete(session);});
      link={client,connection:'',nextWrite:performance.now()};await client.connect();return link;
    })();this.links.set(key,promise);promise.catch(()=>{if(this.links.get(key)===promise)this.links.delete(key);});return promise;
  }
  private async wire(link:Link,to:string,message:unknown):Promise<void>{
    const bytes=utf8.encode(JSON.stringify(message));if(bytes.length>400_000)fail('COMMUNITY_CONTROL_FRAME_TOO_LARGE');
    const group=randomUUID(),count=Math.ceil(bytes.length/16_000);
    for(let i=0;i<count;++i){const packet={v:1,group,index:i,count,total:bytes.length,part:communityBase64(bytes.subarray(i*16_000,(i+1)*16_000))};
      const ciphertext=communityBase64(utf8.encode(JSON.stringify(packet))),now=performance.now(),scheduled=Math.max(now,link.nextWrite);
      // Keep large encrypted Computer Use replies below the DO's 256 KiB/s control budget, including JSON/base64 overhead.
      link.nextWrite=scheduled+(ciphertext.length+256)/160;if(scheduled>now)await new Promise(r=>setTimeout(r,scheduled-now));
      if(this.closed)fail('COMMUNITY_CONNECTION_ENDED','unknown');
      const result=await link.client.sendRecord({to,id:randomUUID(),ciphertext});
      if(!result.reachable)fail('COMMUNITY_PEER_OFFLINE','unknown');}
  }
  private enqueueInbound(purpose:Purpose,role:'host'|'client',record:CommunityRelayRecord){
    if(this.closed)return;
    const key=purpose+':'+role+':'+record.from,n=this.queued.get(key)??0;if(n>=32)return;this.queued.set(key,n+1);
    const work=(this.inboundTails.get(key)??Promise.resolve()).then(()=>this.receive(purpose,role,record)).catch(()=>{}).finally(()=>{const n=this.queued.get(key)!-1;if(n)this.queued.set(key,n);else{this.queued.delete(key);this.inboundTails.delete(key);}});
    this.inboundTails.set(key,work);
  }
  private async receive(purpose:Purpose,role:'host'|'client',record:CommunityRelayRecord){
    const value=exact(JSON.parse(decode.decode(communityBytes(record.ciphertext,48_000))),['v','group','index','count','total','part']);
    if(value.v!==1||!uid(value.group)||!Number.isSafeInteger(value.index)||!Number.isSafeInteger(value.count)||!Number.isSafeInteger(value.total)
      ||(value.total as number)<1||(value.total as number)>400_000||(value.count as number)!==Math.ceil((value.total as number)/16_000))return;
    const index=value.index as number,count=value.count as number,total=value.total as number,key=purpose+':'+role+':'+record.fromConnection+':'+value.group;
    for(const [id,p]of this.parts)if(p.until<=this.now())this.parts.delete(id);
    let part=this.parts.get(key);
    if(!part){if(index!==0||this.parts.size>=32)return;part={total,count,next:0,bytes:[],length:0,until:this.now()+5000};this.parts.set(key,part);}
    const bytes=communityBytes(value.part,16_000);
    if(part.next!==index||part.total!==total||part.count!==count||bytes.length!==Math.min(16_000,total-index*16_000)){this.parts.delete(key);return;}
    part.bytes.push(bytes);part.length+=bytes.length;part.next++;
    if(part.next!==part.count)return;this.parts.delete(key);
    const joined=new Uint8Array(total);let offset=0;for(const bytes of part.bytes){joined.set(bytes,offset);offset+=bytes.length;}
    const packet=JSON.parse(decode.decode(joined));await this.message(purpose,role,record,packet);
  }
  private async open(peer:CommunityComponentAuthorization,own:CommunityComponentAuthorization,purpose:Purpose):Promise<Channel>{
    for(const [id,ch]of this.channels)if(!ch.peer.isCurrent(this.now())||!ch.own.isCurrent(this.now())){clearTimeout(ch.timeout);this.channels.delete(id);}
    const existing=[...this.channels.values()].find(c=>c.side==='sender'&&c.ready&&c.purpose===purpose&&c.peer.policyDigest===peer.policyDigest&&c.own.isCurrent(this.now())&&c.peer.isCurrent(this.now()));if(existing)return existing;
    const key=purpose+':'+peer.policyDigest+':'+own.policyDigest,prior=this.pendingOpen.get(key);if(prior)return prior;
    const work=this.openNew(peer,own,purpose);this.pendingOpen.set(key,work);
    try{return await work;}finally{if(this.pendingOpen.get(key)===work)this.pendingOpen.delete(key);}
  }
  private async openNew(peer:CommunityComponentAuthorization,own:CommunityComponentAuthorization,purpose:Purpose):Promise<Channel>{
    if(this.openings.size>=16||this.channels.size>=32)fail('COMMUNITY_CONTROL_BUSY');
    const link=await this.link(purpose,'client'),session=randomBytes(16).toString('hex'),ephemeral=await freshKey(),nonce=communityBase64(randomBytes(32));
    return new Promise<Channel>((resolve,reject)=>{
      const timeout=setTimeout(()=>{this.openings.delete(session);reject(new AuthenticatedCommunityError('COMMUNITY_HANDSHAKE_TIMEOUT','unknown'));},8000);
      this.openings.set(session,{peer,own,key:ephemeral.key,publicKey:ephemeral.publicKey,nonce,instance:link.connection.replaceAll('-',''),purpose,resolve,reject,timeout});
      void this.wire(link,peer.body.deviceId,{type:'hello',session,instance:link.connection.replaceAll('-',''),senderAuthorization:own.envelope,
        senderEphemeral:ephemeral.publicKey,senderNonce:nonce}).catch(error=>{clearTimeout(timeout);this.openings.delete(session);reject(error);});
    });
  }
  private async message(purpose:Purpose,role:'host'|'client',record:CommunityRelayRecord,packet:Record<string,any>){
    if(packet.type==='hello'&&role==='host'){
      exact(packet,['type','session','instance','senderAuthorization','senderEphemeral','senderNonce']);
      if(!/^[a-f0-9]{32}$/.test(packet.session)||packet.instance!==record.fromConnection.replaceAll('-','')||this.channels.size>=32)return;
      for(const [id,until]of this.helloSeen)if(until<=this.now())this.helloSeen.delete(id);
      const helloKey=record.fromConnection+':'+packet.session;if(this.helloSeen.has(helloKey)||this.helloSeen.size>=256)return;this.helloSeen.set(helloKey,this.now()+120_000);
      const peer=await this.identity.verifyAuthorization(packet.senderAuthorization,record.from);if(!peer.permits(purpose,this.now()))return;
      const pinned=await this.peer(peer.body.agentDeviceId,purpose);if(pinned.policyDigest!==peer.policyDigest)return;
      const own=await this.authorization(purpose),link=await this.link(purpose,role),ephemeral=await freshKey();
      const transcript:CommunityComponentHandshake={version:1,purpose,profileId:own.body.profileId,communityId:own.body.communityId,
        senderDeviceId:peer.body.deviceId,receiverDeviceId:own.body.deviceId,senderAgentDeviceId:peer.body.agentDeviceId,receiverAgentDeviceId:own.body.agentDeviceId,
        senderEnrollmentId:peer.body.enrollmentId,receiverEnrollmentId:own.body.enrollmentId,senderCertificateHash:peer.policyDigest,receiverCertificateHash:own.policyDigest,
        session:packet.session,instance:packet.instance,receiverBootId:link.connection.replaceAll('-',''),senderEphemeral:packet.senderEphemeral,receiverEphemeral:ephemeral.publicKey,
        senderNonce:packet.senderNonce,receiverNonce:communityBase64(randomBytes(32))};
      const proof=communityBase64(await this.identity.signHandshake(purpose,'receiver',transcript,own,peer));
      const keys=await agreement(ephemeral.key,transcript.senderEphemeral,transcript,'receiver');
      const channel:Channel={side:'receiver',purpose,peer,own,role,remoteConnection:record.fromConnection,session:packet.session,transcript,keys,ready:false,sendSeq:0,receiveSeq:0};
      channel.timeout=setTimeout(()=>this.channels.delete(channel.session),8000);this.channels.set(channel.session,channel);
      await this.wire(link,peer.body.deviceId,{type:'answer',session:packet.session,transcript,receiverAuthorization:own.envelope,proof,confirmation:await confirmation(keys,'receiver',proof)});return;
    }
    if(packet.type==='answer'&&role==='client'){
      exact(packet,['type','session','transcript','receiverAuthorization','proof','confirmation']);const opening=this.openings.get(packet.session);if(!opening)return;
      const peer=await this.identity.verifyAuthorization(packet.receiverAuthorization,record.from),t=packet.transcript as CommunityComponentHandshake;
      if(opening.answered||peer.policyDigest!==opening.peer.policyDigest||t.session!==packet.session||t.senderNonce!==opening.nonce||t.senderEphemeral!==opening.publicKey
        ||t.instance!==opening.instance||t.receiverBootId!==record.fromConnection.replaceAll('-','')||t.senderCertificateHash!==opening.own.policyDigest
        ||!await verifyCommunityComponentPeerProof(t,'receiver',peer,packet.proof,this.now()))return;
      opening.answered=true;
      const keys=await agreement(opening.key,t.receiverEphemeral,t,'sender');if(!await verifyConfirmation(keys,'receiver',packet.proof,packet.confirmation))return;
      const proof=communityBase64(await this.identity.signHandshake(purpose,'sender',t,opening.own,peer));
      const channel:Channel={side:'sender',purpose,peer,own:opening.own,role,remoteConnection:record.fromConnection,session:packet.session,transcript:t,keys,ready:false,sendSeq:0,receiveSeq:0};
      channel.resolve=()=>{clearTimeout(opening.timeout);this.openings.delete(packet.session);opening.resolve(channel);};channel.reject=opening.reject;
      this.channels.set(channel.session,channel);
      await this.wire(await this.link(purpose,role),peer.body.deviceId,{type:'finish',session:packet.session,proof,confirmation:await confirmation(keys,'sender',proof)});return;
    }
    const channel=this.channels.get(packet.session);if(!channel||channel.purpose!==purpose||channel.role!==role||channel.peer.body.deviceId!==record.from||channel.remoteConnection!==record.fromConnection)return;
    if(packet.type==='finish'&&channel.side==='receiver'&&!channel.ready){
      exact(packet,['type','session','proof','confirmation']);if(!await verifyCommunityComponentPeerProof(channel.transcript,'sender',channel.peer,packet.proof,this.now())
        ||!await verifyConfirmation(channel.keys,'sender',packet.proof,packet.confirmation))return;
      clearTimeout(channel.timeout);channel.ready=true;await this.seal(channel,{type:'ready'});return;
    }
    if(packet.type!=='sealed')return;exact(packet,['type','session','seq','box']);
    if(!channel.own.isCurrent(this.now())||!channel.peer.isCurrent(this.now())||!Number.isSafeInteger(packet.seq)||packet.seq!==channel.receiveSeq+1)return;
    const direction=channel.side==='sender'?'receiver':'sender',aad=utf8.encode('agentstoz.community-control/record/v1\0'+purpose+'\0'+packet.session+'\0'+direction+'\0'+packet.seq+'\0'+communityBase64(channel.keys.digest));
    const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:buffer(nonce(packet.seq,direction)),additionalData:buffer(aad)},channel.keys.receive,buffer(communityBytes(packet.box,300_000)));
    if(packet.seq!==channel.receiveSeq+1)return;channel.receiveSeq=packet.seq;const body=JSON.parse(decode.decode(clear));
    if(body.type==='ready'&&channel.side==='sender'&&!channel.ready){exact(body,['type']);channel.ready=true;channel.resolve?.();channel.resolve=undefined;channel.reject=undefined;return;}
    if(channel.ready)await this.dispatch(channel,body);
  }
  private async seal(channel:Channel,body:Record<string,unknown>){
    const work=(channel.tail??Promise.resolve()).then(()=>this.sealNow(channel,body));
    channel.tail=work.catch(()=>{channel.ready=false;this.channels.delete(channel.session);});return work;
  }
  private async sealNow(channel:Channel,body:Record<string,unknown>){
    if(this.closed||this.channels.get(channel.session)!==channel)fail('COMMUNITY_CONNECTION_ENDED','unknown');
    if(!channel.own.isCurrent(this.now())||!channel.peer.isCurrent(this.now())||channel.sendSeq>=Number.MAX_SAFE_INTEGER)fail('COMMUNITY_CHANNEL_EXPIRED','unknown');
    const seq=++channel.sendSeq,direction=channel.side,aad=utf8.encode('agentstoz.community-control/record/v1\0'+channel.purpose+'\0'+channel.session+'\0'+direction+'\0'+seq+'\0'+communityBase64(channel.keys.digest));
    const clear=utf8.encode(JSON.stringify(body));if(clear.length>262_144)fail('COMMUNITY_CONTROL_RESPONSE_TOO_LARGE');
    const box=communityBase64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:buffer(nonce(seq,direction)),additionalData:buffer(aad)},channel.keys.send,buffer(clear))));
    await this.wire(await this.link(channel.purpose,channel.role),channel.peer.body.deviceId,{type:'sealed',session:channel.session,seq,box});
  }
  private async validRequest(row:Row):Promise<boolean>{
    const membership=await this.membership();return !!membership&&membership.profileId===row.profile&&membership.deviceId===row.toDevice
      &&membership.localEndpointIds.includes(row.targetEndpoint)&&membership.members.some(m=>m.endpointId===row.targetEndpoint&&m.deviceId===row.toDevice)
      &&membership.members.some(m=>m.endpointId===row.sourceEndpoint&&m.deviceId===row.fromDevice);
  }
  private async dispatch(channel:Channel,packet:Record<string,any>){
    const own=this.storageIdentity;if(!own||!this.ledger)return;const ledger=this.ledger;
    if(packet.type==='request'&&channel.side==='receiver'){
      exact(packet,['type','controlId','sourceEndpointId','targetEndpointId','createdAt','request']);
      if(communityControlIdTime(packet.controlId)!==packet.createdAt||packet.createdAt<ledger.retiredBefore||!uid(packet.sourceEndpointId)||!uid(packet.targetEndpointId)||!Number.isSafeInteger(packet.createdAt)
        ||packet.createdAt>this.now()+5000||packet.createdAt<this.now()-30_000||!packet.request||typeof packet.request!=='object'||Array.isArray(packet.request)
        ||utf8.encode(JSON.stringify(packet.request)).length>65_536)return;
      const row:Row={id:packet.controlId,profile:channel.own.body.profileId,device:channel.own.body.agentDeviceId,direction:'in',fromDevice:channel.peer.body.agentDeviceId,
        toDevice:channel.own.body.agentDeviceId,sourceEndpoint:packet.sourceEndpointId,targetEndpoint:packet.targetEndpointId,purpose:channel.purpose,
        digest:hash(JSON.stringify(packet.request)),createdAt:packet.createdAt,state:'pending',request:packet.request,response:null,peerPolicy:channel.peer.policyDigest,ownPolicy:channel.own.policyDigest};
      if(!await this.validRequest(row))return;const prior=ledger.get(row.id);
      if(prior){if(prior.direction!=='in'||prior.digest!==row.digest||prior.sourceEndpoint!==row.sourceEndpoint||prior.targetEndpoint!==row.targetEndpoint||prior.fromDevice!==row.fromDevice||prior.purpose!==row.purpose||prior.peerPolicy!==row.peerPolicy||prior.ownPolicy!==row.ownPolicy)return;
        if(prior.response)await this.sendResponse(channel,prior);return;}
      ledger.put(row);await this.seal(channel,{type:'received',controlId:row.id});return;
    }
    if(packet.type==='receipt'&&channel.side==='receiver'){
      exact(packet,['type','controlId','sourceEndpointId']);const row=ledger.get(packet.controlId);
      const idTime=communityControlIdTime(packet.controlId);
      if(!row&&idTime!==null&&idTime<ledger.retiredBefore){
        await this.seal(channel,{type:'receipt-expired',controlId:packet.controlId,sourceEndpointId:packet.sourceEndpointId});return;}
      if(row&&row.direction==='in'&&row.fromDevice===channel.peer.body.agentDeviceId&&row.sourceEndpoint===packet.sourceEndpointId&&row.purpose===channel.purpose
        &&row.peerPolicy===channel.peer.policyDigest&&row.ownPolicy===channel.own.policyDigest&&row.response)
        await this.sendResponse(channel,row);return;
    }
    if(packet.type==='receipt-expired'&&channel.side==='sender'){
      exact(packet,['type','controlId','sourceEndpointId']);const row=ledger.get(packet.controlId);
      if(row&&row.direction==='out'&&!row.consumed&&row.toDevice===channel.peer.body.agentDeviceId&&row.sourceEndpoint===packet.sourceEndpointId
        &&row.purpose===channel.purpose&&row.peerPolicy===channel.peer.policyDigest&&row.ownPolicy===channel.own.policyDigest){row.receiptExpired=true;ledger.put(row);}return;
    }
    if((packet.type==='result-consumed'&&channel.side==='receiver')||(packet.type==='consumed-confirmed'&&channel.side==='sender')){
      exact(packet,['type','controlId','sourceEndpointId','targetEndpointId','digest','createdAt']);
      if(communityControlIdTime(packet.controlId)!==packet.createdAt||!uid(packet.sourceEndpointId)||!uid(packet.targetEndpointId)||typeof packet.digest!=='string'||!/^[a-f0-9]{64}$/.test(packet.digest))return;
      const row=ledger.get(packet.controlId),receiver=channel.side==='receiver';
      if(!row){
        if(receiver&&packet.createdAt<ledger.retiredBefore)await this.seal(channel,{...packet,type:'consumed-confirmed'});
        return;
      }
      if(row.direction!==(receiver?'in':'out')||row.createdAt!==packet.createdAt||row.digest!==packet.digest||row.sourceEndpoint!==packet.sourceEndpointId||row.targetEndpoint!==packet.targetEndpointId
        ||(receiver?row.fromDevice:row.toDevice)!==channel.peer.body.agentDeviceId||row.purpose!==channel.purpose
        ||row.peerPolicy!==channel.peer.policyDigest||row.ownPolicy!==channel.own.policyDigest||row.state!=='done')return;
      if(receiver){
        if(!row.response&&!row.consumed)return;row.consumed=true;row.response=null;row.request=null;ledger.put(row);
        await this.seal(channel,{...packet,type:'consumed-confirmed'});
      }else if(row.consumed){row.ackPending=false;ledger.put(row);}
      return;
    }
    if((packet.type==='response'||packet.type==='received')&&channel.side==='sender'){
      exact(packet,packet.type==='response'?['type','controlId','response']:['type','controlId']);const row=ledger.get(packet.controlId);
      if(!row||row.direction!=='out'||row.toDevice!==channel.peer.body.agentDeviceId||row.purpose!==channel.purpose||row.response||row.consumed
        ||row.peerPolicy!==channel.peer.policyDigest||row.ownPolicy!==channel.own.policyDigest)return;
      if(packet.type==='received'){row.state='pending';ledger.put(row);return;}
      if(!packet.response||typeof packet.response!=='object'||Array.isArray(packet.response)||utf8.encode(JSON.stringify(packet.response)).length>262_144)return;
      row.response=packet.response;row.state='done';row.request=null;ledger.put(row);
    }
  }
  async rpc(operation:CommunityControlOperation,profileId:string,deviceId:string,secret:string,args:Record<string,unknown>,purpose:Purpose='agent'):Promise<Record<string,any>>{
    if(this.closed)fail('COMMUNITY_CONNECTION_ENDED');
    this.prune();
    if(!['agent','teams'].includes(purpose))fail('COMMUNITY_CONTROL_INVALID');
    exact(args,operation==='control-send'?['sourceEndpointId','targetEndpointId','request']:operation==='control-result'?['sourceEndpointId','controlIds']:
      operation==='control-respond'?['controlId','response']:operation==='control-inbox'?[]:['unsupported-operation']);
    if(!uid(profileId)||!uid(deviceId)||typeof secret!=='string'||secret.length<32)fail('COMMUNITY_CONTROL_IDENTITY_REQUIRED');
    const ledger=this.store(profileId,deviceId,secret);ledger.compact();
    for(const row of ledger.pendingConsumption())void this.sendConsumed(row).catch(()=>{});
    if(operation==='control-respond'){
      const row=ledger.get(String(args.controlId));if(!row||row.direction!=='in'||row.profile!==profileId||row.device!==deviceId)return {responded:false};
      if(row.response||row.state!=='taken')return {responded:false};if(!args.response||typeof args.response!=='object'||Array.isArray(args.response)||utf8.encode(JSON.stringify(args.response)).length>250_000)fail('COMMUNITY_CONTROL_RESPONSE_TOO_LARGE');
      row.state='done';row.request=null;row.response=args.response as Record<string,unknown>;ledger.put(row);
      void this.deliverResult(row).catch(()=>{});return {responded:true};
    }
    if(operation==='control-result'){
      const ids=args.controlIds;if(!Array.isArray(ids)||ids.length<1||ids.length>16||new Set(ids).size!==ids.length||!uid(args.sourceEndpointId)||ids.some(id=>!uid(id)))fail('COMMUNITY_CONTROL_INVALID');
      const results:unknown[]=[],waiting:string[]=[];
      for(const id of ids){const row=ledger.get(id);
        const idTime=communityControlIdTime(id);
        if(!row&&idTime!==null&&idTime<ledger.retiredBefore)fail('COMMUNITY_CONTROL_RECEIPT_EXPIRED','unknown');
        if(!row||row.direction!=='out'||row.sourceEndpoint!==args.sourceEndpointId||row.profile!==profileId||row.device!==deviceId)continue;
        if(row.receiptExpired)fail('COMMUNITY_CONTROL_RECEIPT_EXPIRED','unknown');
        if(row.response&&!row.consumed){results.push({controlId:id,response:row.response});row.consumed=true;
          if(communityControlIdTime(row.id)===row.createdAt){row.response=null;row.request=null;row.ackPending=true;}ledger.put(row);if(row.ackPending)void this.sendConsumed(row).catch(()=>{});}
        else if(!row.consumed&&!row.response){waiting.push(id);void this.queryReceipt(row).catch(()=>{});}}
      return {results,waiting};
    }
    const own=await this.self(profileId,deviceId,purpose),membership=await this.membership();
    if(!membership||membership.profileId!==profileId||membership.deviceId!==deviceId)fail('COMMUNITY_CONTROL_NOT_IN_COMMUNITY');
    await this.link(purpose,'host');
    if(operation==='control-inbox'){
      const controls:unknown[]=[];for(const row of ledger.pending()){
        if(row.purpose!==purpose||!await this.validRequest(row))continue;
        const active=await this.peer(row.fromDevice,purpose).catch(()=>null);if(!active||active.policyDigest!==row.peerPolicy||own.policyDigest!==row.ownPolicy)continue;
        if(row.createdAt<this.now()-30_000){row.state='done';row.request=null;row.response={ok:false,error:'요청 대기 시간이 지나 실행하지 않았습니다.'};ledger.put(row);continue;}
        const taken=ledger.claim(row.id);if(!taken)continue;
        controls.push({controlId:row.id,fromEndpointId:row.sourceEndpoint,toEndpointId:row.targetEndpoint,fromDeviceId:row.fromDevice,
          fromName:active.body.name,request:row.request,transportPurpose:row.purpose});
      }return {controls};
    }
    if(operation!=='control-send'||!uid(args.sourceEndpointId)||!uid(args.targetEndpointId)||!membership.localEndpointIds.includes(args.sourceEndpointId)
      ||!args.request||typeof args.request!=='object'||Array.isArray(args.request)||utf8.encode(JSON.stringify(args.request)).length>65_536)fail('COMMUNITY_CONTROL_INVALID');
    const target=membership.members.find(m=>m.endpointId===args.targetEndpointId&&m.deviceId!==deviceId);if(!target)fail('COMMUNITY_CONTROL_TARGET_UNAVAILABLE');
    const peer=await this.peer(target.deviceId,purpose),pendingKey=purpose+':'+peer.body.deviceId,n=this.queued.get('out:'+pendingKey)??0;if(n>=8)fail('COMMUNITY_CONTROL_BUSY');
    const at=this.now();if(at<ledger.retiredBefore)fail('COMMUNITY_CONTROL_CLOCK_REGRESSED');
    const row:Row={id:communityControlId(at),profile:profileId,device:deviceId,direction:'out',fromDevice:deviceId,toDevice:target.deviceId,
      sourceEndpoint:args.sourceEndpointId,targetEndpoint:args.targetEndpointId,purpose,digest:hash(JSON.stringify(args.request)),createdAt:at,state:'prepared',request:args.request as Record<string,unknown>,response:null,
      peerPolicy:peer.policyDigest,ownPolicy:own.policyDigest};
    ledger.put(row);this.queued.set('out:'+pendingKey,n+1);
    // Return the durable original ID before I/O. Any failure from here is an unknown outcome, never an unsent retry.
    const generation=this.generation;
    void this.open(peer,own,purpose).then(channel=>this.seal(channel,{type:'request',controlId:row.id,sourceEndpointId:row.sourceEndpoint,targetEndpointId:row.targetEndpoint,createdAt:row.createdAt,request:row.request}))
      .catch(()=>{if(this.closed||generation!==this.generation)return;const current=ledger.get(row.id);if(current&&!current.response&&!current.consumed){current.state='unknown';ledger.put(current);}})
      .finally(()=>{const n=(this.queued.get('out:'+pendingKey)??1)-1;if(n)this.queued.set('out:'+pendingKey,n);else this.queued.delete('out:'+pendingKey);});
    return {controlId:row.id,targetDeviceId:target.deviceId};
  }
  private receiptReads=new Set<string>();
  private receiptReadAt=new Map<string,number>();
  private async sendConsumed(row:Row){
    const key='consumed:'+row.id;
    if(this.receiptReads.has(key)||(this.receiptReadAt.get(key)??0)>this.now()-1000)return;this.receiptReads.add(key);this.receiptReadAt.set(key,this.now());
    try{
      const own=await this.authorization(row.purpose),peer=await this.peer(row.toDevice,row.purpose);
      if(own.policyDigest!==row.ownPolicy||peer.policyDigest!==row.peerPolicy)return;
      const channel=await this.open(peer,own,row.purpose);
      await this.seal(channel,{type:'result-consumed',controlId:row.id,sourceEndpointId:row.sourceEndpoint,targetEndpointId:row.targetEndpoint,digest:row.digest,createdAt:row.createdAt});
    }finally{this.receiptReads.delete(key);}
  }
  private async queryReceipt(row:Row){
    if(this.receiptReads.has(row.id)||(this.receiptReadAt.get(row.id)??0)>this.now()-1000)return;this.receiptReads.add(row.id);this.receiptReadAt.set(row.id,this.now());
    for(const [id,at]of this.receiptReadAt)if(at<this.now()-60_000)this.receiptReadAt.delete(id);
    try {const own=await this.authorization(row.purpose),peer=await this.peer(row.toDevice,row.purpose),channel=await this.open(peer,own,row.purpose);
      await this.seal(channel,{type:'receipt',controlId:row.id,sourceEndpointId:row.sourceEndpoint});}
    finally {this.receiptReads.delete(row.id);}
  }
  private async deliverResult(row:Row){
    let channel=[...this.channels.values()].find(c=>c.side==='receiver'&&c.ready&&c.purpose===row.purpose&&c.peer.body.agentDeviceId===row.fromDevice&&c.peer.policyDigest===row.peerPolicy&&c.own.policyDigest===row.ownPolicy&&c.peer.isCurrent(this.now())&&c.own.isCurrent(this.now()));
    // Receipt reads can establish a fresh authenticated channel. A result is never turned into a fresh execution request.
    if(channel)await this.sendResponse(channel,row);
  }
  private async sendResponse(channel:Channel,row:Row){
    const key=channel.session+':'+row.id;if(this.responseDeliveries.has(key))return;this.responseDeliveries.add(key);
    try{await this.seal(channel,{type:'response',controlId:row.id,response:row.response});}finally{this.responseDeliveries.delete(key);}
  }
  close(){if(this.closed)return;this.closed=true;++this.generation;for(const link of this.links.values())void link.then(l=>l.client.close()).catch(()=>{});this.links.clear();
    for(const open of this.openings.values()){clearTimeout(open.timeout);open.reject(new Error('COMMUNITY_CONNECTION_ENDED'));}this.openings.clear();
    for(const channel of this.channels.values())clearTimeout(channel.timeout);this.channels.clear();this.parts.clear();this.pendingOpen.clear();this.helloSeen.clear();this.responseDeliveries.clear();
    this.ownCache.clear();this.directoryCache.clear();this.receiptReadAt.clear();this.storageIdentity=undefined;this.ledger?.close();this.ledger=undefined;}
}

/** Bun's documented header-capable client; no TLS bypass, proxy override or browser-profile credentials. */
export function createBunCommunityRelaySockets():CommunityRelaySocketFactory {
  return {open:input=>new Promise((resolve,reject)=>{
    if(typeof Bun==='undefined'||!input.url.startsWith('wss://'))return reject(new Error('Bun WSS transport required'));
    const BunSocket=WebSocket as unknown as {new(url:string,options:{headers:Record<string,string>;perMessageDeflate:boolean}):WebSocket};
    const socket=new BunSocket(input.url,{headers:{Authorization:input.authorization},perMessageDeflate:false});let opened=false;
    socket.addEventListener('message',event=>{if(typeof event.data==='string')input.onMessage(event.data);else socket.close(1003,'Text records required');});
    socket.addEventListener('close',()=>{if(!opened)reject(new Error('Community connection refused'));input.onClose();});
    socket.addEventListener('error',()=>{if(!opened)reject(new Error('Community connection failed'));});
    socket.addEventListener('open',()=>{opened=true;resolve({send:text=>socket.send(text),close:(code,reason)=>socket.close(code,reason),get bufferedAmount(){return socket.bufferedAmount;}});});
  })};
}
