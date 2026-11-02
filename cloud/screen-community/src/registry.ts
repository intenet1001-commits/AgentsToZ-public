import {randomUUID,randomBytes} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {type KeyObject} from 'node:crypto';
import {type Envelope,type Request,type Member,type Grant,Fault,demand,uuid,name,grant,publicKey,checkProof,
  signed,codeHash,newCode,hash,fingerprint,seal,openSealed,memberFields,privateIPv4,readRequest,JOIN_TTL,RECEIPT_TTL,LEASE_TTL,MAX_MEMBERS} from './protocol';
import type {RegistryStore} from './store';

interface Community {id:string;profileId:string;name:string;revision:number;memberIds:string[]}
interface Invite {id:string;communityId:string;expiresAt:number;usedBy:string|null;hash:string}
interface Pending {id:string;communityId:string;requestId:string;hostKey:string;viewerKey:string;deviceId:string;name:string;platform:'mac'|'ios';grant:Grant;
  mode:'code'|'entry';expiresAt:number;attempts:number;confirmationHash:string;confirmationCipher:string;enrollmentId:string|null}
interface Approval {pendingId:string;actorId:string;revision:number;digest:string;challengeHash:string;expiresAt:number}
interface PushSubscription {token:string;environment:'sandbox'|'production';topic:string}
export interface CommunityNotification {pendingId:string;recipientId:string;token:string;environment:'sandbox'|'production';topic:string;expiresAt:number;notice:Envelope}
interface Receipt {hash:string;hostKey:string;actor:string|null;cipher:string;pendingId:string|null;expiresAt:number}

/** Private issuer and wrapping keys live only in the service. This registry never handles video or input. */
export class CommunityRegistry {
  constructor(private readonly store:RegistryStore,private readonly issuer:KeyObject,private readonly stateKey:Buffer,
    private readonly clock=Date.now,private readonly bootstrapAllowed:(host:string,viewer:string,profile:string)=>boolean=()=>false,private readonly allowedPushTopics:readonly string[]=[]){demand(stateKey.length===32,'ISSUER_NOT_CONFIGURED');}

  handle(value:unknown,peerBucket:string):{status:number;envelope:Envelope}{
    let request:Request|undefined;
    try{
      // Parsing remains outside the transaction; protocol primitives do not touch storage.
      request=this.read(value);
      this.budget(peerBucket,['bootstrap','join','entry'].includes(request.op)?20:300);
      const result=this.store.transaction(()=>this.execute(request!));
      if(result instanceof Fault)return {status:result.status,envelope:this.reply(request,'error',[result.code])};
      const payload=JSON.parse(Buffer.from(result.payload,'base64url').toString('utf8'));
      return {status:payload[1]==='error'?400:200,envelope:result};
    }catch(error){const fault=error instanceof Fault?error:new Fault('SERVICE_UNAVAILABLE',503);
      return {status:fault.status,envelope:signed([1,'error',request?.id??null,this.clock(),fault.code],this.issuer)};}
  }

  private read(value:unknown):Request{
    // Kept as a normal import in the bundle; no code, URL or key can select an alternate verifier.
    return readRequest(value,this.clock());
  }
  private reply(r:Request,kind:string,args:unknown[]):Envelope{return signed([1,kind,r.id,this.clock(),...args],this.issuer);}
  private budget(peer:string,limit:number):void{
    const now=this.clock(),bucket=Math.floor(now/60_000),key=`rate:${limit}:${hash(peer)}:${bucket}`;
    const count=this.store.transaction(()=>{this.store.collect(now);const n=(this.store.get<number>(key)??0)+1;this.store.put(key,n,now+120_000);return n;});
    demand(count<=limit,'RATE_LIMITED');
  }
  private actor(r:Request):Member{
    demand(r.actor&&uuid(r.actor),'NOT_ENROLLED');const actor=this.store.get<Member>(`member:${r.actor}`);
    demand(actor&&actor.revokedAt===null,'NOT_ENROLLED');
    // Leaving only lowers this device's authority. It must remain possible without a biometric prompt.
    checkProof(r,['approve','approve-entry','revoke','push-register','push-remove'].includes(r.op)?actor.viewerKey:actor.hostKey);
    return actor;
  }
  private community(id:unknown):Community{
    demand(uuid(id));const c=this.store.get<Community>(`community:${id}`);demand(c,'COMMUNITY_NOT_FOUND');return c;
  }
  private memberCertificate(r:Request,m:Member):Envelope{
    return this.reply(r,'member',[m.communityId,m.profileId,...memberFields(m),this.clock()+30*24*60*60_000]);
  }
  private conflicts(c:Community,device:string,host:string,viewer:string):boolean{
    return c.memberIds.some(id=>{const m=this.store.get<Member>(`member:${id}`);
      return m?.revokedAt===null&&(m.deviceId===device||[m.hostKey,m.viewerKey].some(key=>key===host||key===viewer));});
  }
  private record(r:Request,hostKey:string,result:Envelope,pendingId:string|null=null):Envelope{
    const oldNonce=this.store.get<string>(`nonce:${fingerprint(hostKey)}:${r.nonce}`);
    demand(oldNonce===undefined||oldNonce===r.id,'REPLAYED_NONCE');
    this.store.put(`nonce:${fingerprint(hostKey)}:${r.nonce}`,r.id,this.clock()+RECEIPT_TTL);
    this.store.put(`request:${r.id}`,{hash:hash(r.bytes),hostKey,actor:r.actor,cipher:seal(result,this.stateKey,r.id),pendingId,
      expiresAt:this.clock()+RECEIPT_TTL} satisfies Receipt,this.clock()+RECEIPT_TTL);
    return result;
  }
  private pendingReply(r:Request,p:Pending):Envelope{
    const c=this.community(p.communityId);return this.reply(r,'pending',[p.id,c.id,c.profileId,c.name,p.expiresAt,
      openSealed<string>(p.confirmationCipher,this.stateKey,'confirmation'),p.deviceId,p.hostKey,p.viewerKey]);
  }
  private pendingDigest(p:Pending):string{return hash(JSON.stringify([p.communityId,p.id,p.deviceId,p.hostKey,p.viewerKey,p.platform,p.grant,p.expiresAt]));}
  /** Claim an at-most-once advisory notification. Neither receiving nor tapping it grants membership. */
  takeNotifications():CommunityNotification[]{
    return this.store.transaction(()=>{
      const now=this.clock(),jobs:CommunityNotification[]=[];
      for(const id of (this.store.get<string[]>('notification-queue')??[]).slice(-32)){
        const p=this.store.get<Pending>(`pending:${id}`);if(!p||p.expiresAt<=now||p.enrollmentId)continue;
        const c=this.community(p.communityId);
        for(const memberId of c.memberIds){
          if(jobs.length===4)return jobs;
          const m=this.store.get<Member>(`member:${memberId}`),key=`notified:${p.id}:${memberId}`,cipher=this.store.get<string>(`push:${memberId}`);
          if(!m||m.revokedAt!==null||!m.admin||!cipher||this.store.get(key))continue;
          const subscription=openSealed<PushSubscription>(cipher,this.stateKey,memberId);
          if(!this.allowedPushTopics.includes(subscription.topic))continue;
          this.store.put(key,true,p.expiresAt);
          jobs.push({pendingId:p.id,recipientId:memberId,...subscription,expiresAt:p.expiresAt,
            notice:signed([1,'enrollment-notice',p.id,now,c.id,p.id,p.expiresAt,this.pendingDigest(p)],this.issuer)});
        }
      }
      return jobs;
    });
  }
  private execute(r:Request):Envelope|Fault{
    const a=r.args,now=this.clock();
    const actor=r.actor?this.actor(r):null;
    const prior=this.store.get<Receipt>(`request:${r.id}`);
    if(prior){demand(prior.hash===hash(r.bytes),'REQUEST_CONFLICT');if(!actor){
        if(r.op==='bootstrap'){checkProof(r,r.args[4] as string);checkProof({...r,signature:r.hostSignature!},prior.hostKey);}
        else checkProof(r,prior.hostKey);
      }
      return openSealed<Envelope>(prior.cipher,this.stateKey,r.id);}
    let hostKey=actor?.hostKey;
    let result:Envelope;
    let pendingId:string|null=null;
    if(r.op==='discover'){
      demand(!actor&&a.length===2&&uuid(a[1]));publicKey(a[0]);checkProof(r,a[0] as string);hostKey=a[0] as string;
      const root=this.store.get<string>('bootstrap-completed');demand(root,'COMMUNITY_NOT_READY');
      const c=this.community(root);demand(c.profileId===a[1],'OTHER_COMMUNITY');
      result=this.reply(r,'community-info',[c.id,c.profileId,c.name]);
    }else if(r.op==='bootstrap'||r.op==='join'||r.op==='entry'){
      demand(!actor&&(a.length===7||a.length===8)&&uuid(a[0])&&uuid(a[1])&&name(a[2])
        &&typeof a[3]==='string'&&typeof a[4]==='string'&&grant(a[5]));
      publicKey(a[3]);publicKey(a[4]);demand(a[3]!==a[4],'KEYS_MUST_DIFFER');hostKey=a[3];
      const platform=a[7]??'mac';demand(platform==='mac'||platform==='ios');demand(platform==='mac'||a[5]==='none','MOBILE_CANNOT_HOST');
      if(r.op==='bootstrap'){
        demand(name(a[6]));checkProof(r,a[4]);checkProof({...r,signature:r.hostSignature!},a[3]);
        demand(this.bootstrapAllowed(a[3],a[4],a[0]),'BOOTSTRAP_REQUIRES_DEVICE_BINDING');
        demand(this.store.get('bootstrap-completed')===undefined,'COMMUNITY_ALREADY_CREATED');
        const c:Community={id:randomUUID(),profileId:a[0],name:a[6],revision:1,memberIds:[]};
        const m:Member={enrollmentId:randomUUID(),communityId:c.id,profileId:c.profileId,deviceId:a[1],name:a[2],hostKey:a[3],viewerKey:a[4],
          platform,grant:a[5],admin:true,keyEpoch:1,joinedAt:now,revokedAt:null,route:null};
        c.memberIds.push(m.enrollmentId);this.store.put(`community:${c.id}`,c);this.store.put(`member:${m.enrollmentId}`,m);
        this.store.put('bootstrap-completed',c.id);
        result=this.memberCertificate(r,m);
      }else{
        checkProof(r,a[3]);
        let invite:Invite|undefined,c:Community;
        if(r.op==='join'){
          demand(typeof a[6]==='string'&&/^\d{8}$/.test(a[6]));
          const inviteId=this.store.get<string>(`code:${codeHash(a[6],this.stateKey)}`);
          invite=inviteId?this.store.get<Invite>(`invite:${inviteId}`):undefined;
          demand(invite&&invite.expiresAt>now&&invite.usedBy===null,'CODE_EXPIRED_OR_USED');
          c=this.community(invite.communityId);
        }else{
          c=this.community(a[6]);
          // A public community ID may stage a request, never authorize it. Bound queue/rate prevent push flooding.
          const bucket=`entry-rate:${c.id}:${Math.floor(now/60_000)}`;
          const n=this.store.get<number>(bucket)??0;demand(n<6,'RATE_LIMITED');this.store.put(bucket,n+1,now+120_000);
          const existing=(this.store.get<string[]>(`pending-list:${c.id}`)??[]).map(id=>this.store.get<Pending>(`pending:${id}`))
            .find(p=>p&&p.expiresAt>now&&!p.enrollmentId&&p.deviceId===a[1]&&p.hostKey===a[3]&&p.viewerKey===a[4]);
          if(existing){hostKey=a[3];return this.record(r,hostKey,this.pendingReply(r,existing),existing.id);}
        }
        demand(c.profileId===a[0],'OTHER_COMMUNITY');
        demand(c.memberIds.filter(id=>this.store.get<Member>(`member:${id}`)?.revokedAt===null).length<MAX_MEMBERS,'COMMUNITY_FULL');
        demand(!this.conflicts(c,a[1],a[3],a[4]),'ALREADY_ENROLLED');
        const confirmation=newCode().slice(0,6);
        const p:Pending={id:randomUUID(),communityId:c.id,requestId:r.id,hostKey:a[3],viewerKey:a[4],deviceId:a[1],name:a[2],platform,grant:a[5],
          mode:r.op==='entry'?'entry':'code',expiresAt:now+JOIN_TTL,attempts:0,confirmationHash:codeHash('confirmation:'+confirmation,this.stateKey),
          confirmationCipher:seal(confirmation,this.stateKey,'confirmation'),enrollmentId:null};
        if(invite){invite.usedBy=p.id;this.store.put(`invite:${invite.id}`,invite,invite.expiresAt);}
        this.store.put(`pending:${p.id}`,p,now+RECEIPT_TTL);
        const list=this.store.get<string[]>(`pending-list:${c.id}`)??[];
        this.store.put(`pending-list:${c.id}`,[...list.filter(id=>(this.store.get<Pending>(`pending:${id}`)?.expiresAt??0)>now),p.id].slice(-32),now+RECEIPT_TTL);
        if(p.mode==='entry')this.store.put('notification-queue',[...(this.store.get<string[]>('notification-queue')??[]),p.id].slice(-32),now+RECEIPT_TTL);
        result=this.pendingReply(r,p);pendingId=p.id;
      }
    }else if(r.op==='recover'){
      // Read-only recovery of the exact key pair after a lost reply/restart. It never creates, replaces or unrevokes.
      demand(!actor&&a.length===4&&uuid(a[0])&&uuid(a[1]));publicKey(a[2]);publicKey(a[3]);
      checkProof(r,a[2] as string);hostKey=a[2] as string;
      const root=this.store.get<string>('bootstrap-completed');demand(root,'NOT_ENROLLED');
      const c=this.community(root);demand(c.profileId===a[0],'OTHER_COMMUNITY');
      const member=c.memberIds.map(id=>this.store.get<Member>(`member:${id}`)).find(m=>m?.revokedAt===null
        &&m.deviceId===a[1]&&m.hostKey===a[2]&&m.viewerKey===a[3]);
      demand(member,'NOT_ENROLLED');result=this.memberCertificate(r,member);
    }else if(r.op==='receipt'){
      demand(a.length===1&&uuid(a[0]));const receipt=this.store.get<Receipt>(`request:${a[0]}`);demand(receipt,'RECEIPT_NOT_FOUND');
      if(!actor)checkProof(r,receipt.hostKey);else demand(actor.hostKey===receipt.hostKey,'OTHER_RECEIPT');
      hostKey=receipt.hostKey;
      const pending=receipt.pendingId?this.store.get<Pending>(`pending:${receipt.pendingId}`):undefined;
      if(pending?.enrollmentId){const m=this.store.get<Member>(`member:${pending.enrollmentId}`);demand(m&&m.revokedAt===null,'REGISTRATION_REVOKED');result=this.memberCertificate(r,m);}
      else if(pending){demand(pending.expiresAt>now&&pending.attempts<5,'CODE_EXPIRED_OR_USED');
        const c=this.community(pending.communityId);result=this.reply(r,'pending',[pending.id,c.id,c.profileId,c.name,pending.expiresAt,
          openSealed<string>(pending.confirmationCipher,this.stateKey,'confirmation'),pending.deviceId,pending.hostKey,pending.viewerKey]);}
      else result=this.reply(r,'receipt',[a[0],openSealed<Envelope>(receipt.cipher,this.stateKey,a[0])]);
    }else{
      demand(actor,'NOT_ENROLLED');const c=this.community(a[0]);demand(actor.communityId===c.id,'OTHER_COMMUNITY');
      if(['invite','lookup','review','approve','approve-entry','revoke','push-register','push-remove'].includes(r.op))demand(actor.admin,'ADMIN_REQUIRED');
      if(r.op==='invite'){
        demand(a.length===1);let code='',digest='';
        for(let n=0;n<16;n++){code=newCode();digest=codeHash(code,this.stateKey);if(!this.store.get(`code:${digest}`))break;code='';}
        demand(code,'CODE_SPACE_BUSY');const invitation:Invite={id:randomUUID(),communityId:c.id,expiresAt:now+JOIN_TTL,usedBy:null,hash:digest};
        this.store.put(`invite:${invitation.id}`,invitation,invitation.expiresAt);this.store.put(`code:${digest}`,invitation.id,invitation.expiresAt);
        result=this.reply(r,'invite',[c.id,c.profileId,c.name,invitation.id,code,invitation.expiresAt]);
      }else if(r.op==='lookup'){
        demand(a.length===1);const pending=(this.store.get<string[]>(`pending-list:${c.id}`)??[])
          .map(id=>this.store.get<Pending>(`pending:${id}`)).filter((p):p is Pending=>!!p&&p.expiresAt>now&&p.attempts<5&&!p.enrollmentId)
          .map(p=>[p.id,p.name,p.deviceId,p.hostKey,p.viewerKey,p.platform,p.grant,p.expiresAt]);
        result=this.reply(r,'pending-list',[c.id,c.revision,pending]);
      }else if(r.op==='review'){
        demand(a.length===2&&uuid(a[1]));const p=this.store.get<Pending>(`pending:${a[1]}`);
        demand(p&&p.communityId===c.id&&p.expiresAt>now&&!p.enrollmentId&&p.attempts<5,'CODE_EXPIRED_OR_USED');
        const challenge=randomBytes(32).toString('base64url');
        const approval:Approval={pendingId:p.id,actorId:actor.enrollmentId,revision:c.revision,digest:this.pendingDigest(p),
          challengeHash:codeHash(challenge,this.stateKey),expiresAt:Math.min(p.expiresAt,now+120_000)};
        this.store.put(`approval:${actor.enrollmentId}:${p.id}`,approval,approval.expiresAt);
        result=this.reply(r,'pending-review',[c.id,c.revision,p.id,c.profileId,p.deviceId,p.name,p.hostKey,p.viewerKey,p.grant,approval.expiresAt,challenge,p.platform]);
      }else if(r.op==='push-register'){
        demand(a.length===4&&typeof a[1]==='string'&&/^[0-9a-f]{64,200}$/.test(a[1])&&a[1].length%2===0
          &&(a[2]==='sandbox'||a[2]==='production')&&typeof a[3]==='string'&&this.allowedPushTopics.includes(a[3]),'PUSH_NOT_CONFIGURED');
        this.store.put(`push:${actor.enrollmentId}`,seal({token:a[1],environment:a[2],topic:a[3]} satisfies PushSubscription,this.stateKey,actor.enrollmentId));
        result=this.reply(r,'push-registered',[c.id,actor.enrollmentId]);
      }else if(r.op==='push-remove'){
        demand(a.length===1);this.store.remove(`push:${actor.enrollmentId}`);result=this.reply(r,'push-removed',[c.id,actor.enrollmentId]);
      }else if(r.op==='approve'||r.op==='approve-entry'){
        demand(a.length===6&&uuid(a[1])&&typeof a[2]==='string'&&(r.op==='approve'?/^\d{6}$/.test(a[2]):/^[A-Za-z0-9_-]{43}$/.test(a[2]))&&grant(a[3])&&typeof a[4]==='boolean'&&a[5]===c.revision,'STALE_REGISTRATION');
        const p=this.store.get<Pending>(`pending:${a[1]}`);demand(p&&p.communityId===c.id&&p.expiresAt>now&&p.attempts<5&&!p.enrollmentId,'CODE_EXPIRED_OR_USED');
        if(r.op==='approve-entry'){
          const approval=this.store.get<Approval>(`approval:${actor.enrollmentId}:${p.id}`);
          demand(p.mode==='entry'&&approval&&approval.expiresAt>now&&approval.revision===c.revision&&approval.pendingId===p.id
            &&approval.actorId===actor.enrollmentId&&approval.digest===this.pendingDigest(p)&&approval.challengeHash===codeHash(a[2],this.stateKey),'STALE_APPROVAL');
        }
        if(r.op==='approve'&&codeHash('confirmation:'+a[2],this.stateKey)!==p.confirmationHash){p.attempts++;this.store.put(`pending:${p.id}`,p,now+RECEIPT_TTL);
          return this.record(r,actor.hostKey,this.reply(r,'error',['CONFIRMATION_MISMATCH']));}
        demand(p.grant==='control'||a[3]!=='control','GRANT_ESCALATION');demand(p.grant!=='none'||a[3]==='none','GRANT_ESCALATION');
        demand(c.memberIds.filter(id=>this.store.get<Member>(`member:${id}`)?.revokedAt===null).length<MAX_MEMBERS,'COMMUNITY_FULL');
        demand(c.memberIds.length<1024,'COMMUNITY_HISTORY_FULL');
        demand(!this.conflicts(c,p.deviceId,p.hostKey,p.viewerKey),'ALREADY_ENROLLED');
        const m:Member={enrollmentId:randomUUID(),communityId:c.id,profileId:c.profileId,deviceId:p.deviceId,name:p.name,hostKey:p.hostKey,viewerKey:p.viewerKey,
          platform:p.platform,grant:a[3],admin:a[4],keyEpoch:1,joinedAt:now,revokedAt:null,route:null};
        p.enrollmentId=m.enrollmentId;c.memberIds.push(m.enrollmentId);c.revision++;
        this.store.put(`member:${m.enrollmentId}`,m);this.store.put(`community:${c.id}`,c);this.store.put(`pending:${p.id}`,p,now+RECEIPT_TTL);
        result=this.reply(r,'approved',[c.id,c.revision,m.enrollmentId,m.deviceId]);
      }else if(r.op==='directory'){
        // A v2 member cannot bypass its selected purposes or mobile episode by reconnecting with its old BIO key.
        // Keep self for enrollment/identity recovery; direct QR pairings use independent registries and are unchanged.
        demand(a.length===1);const members=c.memberIds.map(id=>this.store.get<Member>(`member:${id}`))
          .filter((m):m is Member=>!!m&&m.revokedAt===null&&(m.enrollmentId===actor.enrollmentId||!this.store.get(`access-policy:${m.enrollmentId}`)));
        result=this.reply(r,'directory',[c.id,c.profileId,c.name,c.revision,now+LEASE_TTL,actor.enrollmentId,members.map(memberFields)]);
      }else if(r.op==='route'){
        demand(a.length===2&&(a[1]===null||privateIPv4(a[1])));
        if(actor.route!==a[1]){actor.route=a[1] as string|null;c.revision++;
          this.store.put(`member:${actor.enrollmentId}`,actor);this.store.put(`community:${c.id}`,c);}
        result=this.reply(r,'route',[c.id,c.revision]);
      }else if(r.op==='revoke'||r.op==='leave'){
        demand(r.op==='leave'?a.length===1:a.length===3&&uuid(a[1])&&a[2]===c.revision,'STALE_REGISTRATION');
        const m=r.op==='leave'?actor:this.store.get<Member>(`member:${a[1]}`);demand(m&&m.communityId===c.id&&m.revokedAt===null,'NOT_ENROLLED');
        if(m.admin)demand(c.memberIds.some(id=>{const other=this.store.get<Member>(`member:${id}`);return other&&other.enrollmentId!==m.enrollmentId&&other.admin&&other.revokedAt===null;}),'LAST_ADMIN');
        m.revokedAt=now;c.revision++;this.store.remove(`push:${m.enrollmentId}`);this.store.put(`member:${m.enrollmentId}`,m);this.store.put(`community:${c.id}`,c);result=this.reply(r,'revoked',[c.id,c.revision,m.enrollmentId]);
      }else throw new Fault('INVALID_REQUEST');
    }
    demand(hostKey,'NOT_ENROLLED');return this.record(r,hostKey,result,pendingId);
  }
}
