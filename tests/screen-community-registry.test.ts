import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {CommunityRegistry} from '../cloud/screen-community/src/registry';
import {DurableRegistryStore} from '../cloud/screen-community/src/store';
import {REQUEST_DOMAIN,keyString,verifyEnvelope,type Envelope,type Operation} from '../cloud/screen-community/src/protocol';

const databases:Database[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
const keys=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
function fixture(){
  let now=1_793_600_000_000;
  const db=new Database(':memory:');databases.push(db);
  const sql={exec(query:string,...args:unknown[]){return db.query(query).all(...args as any[]) as {value:string}[];}};
  const store=new DurableRegistryStore({sql,transactionSync:body=>db.transaction(body)()});
  const issuer=keys(),a={host:keys(),viewer:keys(),id:randomUUID()},b={host:keys(),viewer:keys(),id:randomUUID()},profile=randomUUID();
  const registry=new CommunityRegistry(store,issuer.privateKey,randomBytes(32),()=>now,
    (host,viewer,p)=>host===keyString(a.host.publicKey)&&viewer===keyString(a.viewer.publicKey)&&p===profile,['com.intenet.agentstoz.mobile']);
  const request=(op:Operation,args:unknown[],person=a,actor:string|null=null,id=randomUUID(),nonce=randomBytes(32).toString('base64url'))=>{
    const bytes=Buffer.from(JSON.stringify([1,op,id,now,nonce,actor,args]));
    const key=['bootstrap','approve','approve-entry','revoke','push-register','push-remove'].includes(op)?person.viewer.privateKey:person.host.privateKey;
    const input=Buffer.concat([REQUEST_DOMAIN,bytes]);
    const envelope:Envelope={payload:bytes.toString('base64url'),signature:sign('sha256',input,{key,dsaEncoding:'ieee-p1363'}).toString('base64url')};
    if(op==='bootstrap')envelope.hostSignature=sign('sha256',input,{key:person.host.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
    return envelope;
  };
  const run=(envelope:Envelope)=>{const result=registry.handle(envelope,'isolated-peer');return {...result,body:verifyEnvelope(result.envelope,keyString(issuer.publicKey))};};
  const boot=()=>run(request('bootstrap',[profile,a.id,'Mac 3',keyString(a.host.publicKey),keyString(a.viewer.publicKey),'control','AgentsToZ']));
  return {a,b,profile,store,registry,issuer,request,run,boot,advance:(ms:number)=>now+=ms};
}

test('each device enrolls once in the community, then every enrolled member sees the same trusted directory',()=>{
  const f=fixture(),root=f.boot();expect(root.status).toBe(200);expect(root.body[1]).toBe('member');
  const community=root.body[4] as string,admin=root.body[6] as string;
  const inviteRequest=f.request('invite',[community],f.a,admin),invite=f.run(inviteRequest);
  expect(f.run(inviteRequest).envelope).toEqual(invite.envelope);
  const code=invite.body[8];expect(code).toMatch(/^\d{8}$/);
  const joining=f.request('join',[f.profile,f.b.id,'Mac 1',keyString(f.b.host.publicKey),keyString(f.b.viewer.publicKey),'control',code],f.b);
  const pending=f.run(joining);expect(pending.body[1]).toBe('pending');
  const listing=f.run(f.request('lookup',[community],f.a,admin));
  expect(JSON.stringify(listing.body)).not.toContain(pending.body[9] as string);
  const approved=f.run(f.request('approve',[community,pending.body[4],pending.body[9],'control',false,listing.body[5]],f.a,admin));
  expect(approved.body[1]).toBe('approved');
  const receipt=f.run(f.request('receipt',[JSON.parse(Buffer.from(joining.payload,'base64url').toString())[2]],f.b));
  expect(receipt.body[1]).toBe('member');const member=receipt.body[6] as string;
  const directory=f.run(f.request('directory',[community],f.b,member));
  expect(directory.body[1]).toBe('directory');expect(directory.body[10]).toHaveLength(2);
  const other={host:keys(),viewer:keys(),id:randomUUID()};
  const reused=f.run(f.request('join',[f.profile,other.id,'Other Mac',keyString(other.host.publicKey),keyString(other.viewer.publicKey),'view',code],other));
  expect(reused.body.at(-1)).toBe('CODE_EXPIRED_OR_USED');
});

test('registration codes expire, belong to one community, and cannot silently replace an enrolled key',()=>{
  const f=fixture(),root=f.boot(),community=root.body[4] as string,admin=root.body[6] as string;
  const invite=f.run(f.request('invite',[community],f.a,admin));
  const foreign=f.run(f.request('join',[randomUUID(),f.b.id,'Mac 1',keyString(f.b.host.publicKey),keyString(f.b.viewer.publicKey),'view',invite.body[8]],f.b));
  expect(foreign.body.at(-1)).toBe('OTHER_COMMUNITY');
  f.advance(300_001);
  const expired=f.run(f.request('join',[f.profile,f.b.id,'Mac 1',keyString(f.b.host.publicKey),keyString(f.b.viewer.publicKey),'view',invite.body[8]],f.b));
  expect(expired.body.at(-1)).toBe('CODE_EXPIRED_OR_USED');
});

test('wrong confirmation attempts persist but an identical replay does not consume another attempt',()=>{
  const f=fixture(),root=f.boot(),community=root.body[4] as string,admin=root.body[6] as string;
  const invite=f.run(f.request('invite',[community],f.a,admin));
  const pending=f.run(f.request('join',[f.profile,f.b.id,'Mac 1',keyString(f.b.host.publicKey),keyString(f.b.viewer.publicKey),'view',invite.body[8]],f.b));
  const code=pending.body[9] as string,bad=code==='000000'?'111111':'000000';
  const wrong=f.request('approve',[community,pending.body[4],bad,'view',false,1],f.a,admin);
  const first=f.run(wrong);expect(first.status).toBe(400);expect(first.body.at(-1)).toBe('CONFIRMATION_MISMATCH');
  for(let i=0;i<8;i++)expect(f.run(wrong).envelope).toEqual(first.envelope);
  for(let i=0;i<4;i++)f.run(f.request('approve',[community,pending.body[4],bad,'view',false,1],f.a,admin));
  const locked=f.run(f.request('approve',[community,pending.body[4],code,'view',false,1],f.a,admin));
  expect(locked.body.at(-1)).toBe('CODE_EXPIRED_OR_USED');
});

test('revocation denies new leases; approval and revoke require the admin biometric-key proof, not a host-key proof',()=>{
  const f=fixture(),root=f.boot(),community=root.body[4] as string,admin=root.body[6] as string;
  const invite=f.run(f.request('invite',[community],f.a,admin));
  const pending=f.run(f.request('join',[f.profile,f.b.id,'Mac 1',keyString(f.b.host.publicKey),keyString(f.b.viewer.publicKey),'view',invite.body[8]],f.b));
  f.run(f.request('approve',[community,pending.body[4],pending.body[9],'view',false,1],f.a,admin));
  const listing=f.run(f.request('directory',[community],f.a,admin));
  const member=(listing.body[10] as unknown[][]).find(m=>m[1]===f.b.id)![0] as string;
  const forged=f.request('revoke',[community,member,2],f.a,admin);
  forged.signature=sign('sha256',Buffer.concat([REQUEST_DOMAIN,Buffer.from(forged.payload,'base64url')]),{key:f.a.host.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  expect(f.run(forged).body.at(-1)).toBe('INVALID_PROOF');
  expect(f.run(f.request('revoke',[community,member,2],f.a,admin)).body[1]).toBe('revoked');
  expect(f.run(f.request('directory',[community],f.b,member)).body.at(-1)).toBe('NOT_ENROLLED');
  expect((f.run(f.request('directory',[community],f.a,admin)).body[10] as unknown[]).length).toBe(1);
});

test('nonce conflict rolls back a mutation and an unprovisioned bootstrap cannot create an authority',()=>{
  const f=fixture(),root=f.boot(),community=root.body[4] as string,admin=root.body[6] as string;
  const nonce=randomBytes(32).toString('base64url');f.run(f.request('directory',[community],f.a,admin,randomUUID(),nonce));
  const before=f.run(f.request('directory',[community],f.a,admin)).body[7];
  expect(f.run(f.request('route',[community,'192.168.1.20'],f.a,admin,randomUUID(),nonce)).body.at(-1)).toBe('REPLAYED_NONCE');
  const after=f.run(f.request('directory',[community],f.a,admin));expect(after.body[7]).toBe(before);
  const foreign={host:keys(),viewer:keys(),id:randomUUID()};
  const denied=f.run(f.request('bootstrap',[f.profile,foreign.id,'Fake root',keyString(foreign.host.publicKey),keyString(foreign.viewer.publicKey),'control','Wrong root'],foreign));
  expect(denied.body.at(-1)).toBe('BOOTSTRAP_REQUIRES_DEVICE_BINDING');
});

test('read-only recovery works after receipt expiry, binds both keys and never restores a revoked device',()=>{
  const f=fixture(),root=f.boot(),community=root.body[4] as string,admin=root.body[6] as string;
  f.advance(600_001);
  const recovered=f.run(f.request('recover',[f.profile,f.a.id,keyString(f.a.host.publicKey),keyString(f.a.viewer.publicKey)]));
  expect(recovered.body[1]).toBe('member');expect(recovered.body[6]).toBe(admin);
  const wrongViewer=f.run(f.request('recover',[f.profile,f.a.id,keyString(f.a.host.publicKey),keyString(f.b.viewer.publicKey)]));
  expect(wrongViewer.body.at(-1)).toBe('NOT_ENROLLED');
  const route=f.run(f.request('route',[community,'192.168.1.20'],f.a,admin));
  const sameRoute=f.run(f.request('route',[community,'192.168.1.20'],f.a,admin));
  expect(sameRoute.body[5]).toBe(route.body[5]);
});

test('a public key cannot be reused in the other device-key role',()=>{
  const f=fixture(),root=f.boot(),community=root.body[4] as string,admin=root.body[6] as string;
  const invite=f.run(f.request('invite',[community],f.a,admin));
  const result=f.run(f.request('join',[f.profile,f.b.id,'Alias',keyString(f.b.host.publicKey),keyString(f.a.host.publicKey),'view',invite.body[8]],f.b));
  expect(result.body.at(-1)).toBe('ALREADY_ENROLLED');
});

test('community entry stages one approval and signed push, then one owner approval enrolls the device for every peer',()=>{
  const f=fixture(),root=f.boot(),community=root.body[4] as string,admin=root.body[6] as string;
  const token='ab'.repeat(32);
  expect(f.run(f.request('push-register',[community,token,'production','com.intenet.agentstoz.mobile'],f.a,admin)).body[1]).toBe('push-registered');
  expect(JSON.stringify(f.store.get(`push:${admin}`))).not.toContain(token);
  const entry=f.request('entry',[f.profile,f.b.id,'Mac 1',keyString(f.b.host.publicKey),keyString(f.b.viewer.publicKey),'control',community],f.b);
  const pending=f.run(entry);expect(pending.body[1]).toBe('pending');
  expect(f.run(f.request('recover',[f.profile,f.b.id,keyString(f.b.host.publicKey),keyString(f.b.viewer.publicKey)],f.b)).body.at(-1)).toBe('NOT_ENROLLED');
  const notifications=f.registry.takeNotifications();expect(notifications).toHaveLength(1);
  expect(notifications[0]!.recipientId).toBe(admin);expect(notifications[0]!.notice.signature).toHaveLength(86);
  expect(JSON.stringify(notifications[0]!.notice)).not.toContain(pending.body[9] as string);
  expect(f.registry.takeNotifications()).toHaveLength(0);
  const review=f.run(f.request('review',[community,pending.body[4]],f.a,admin));expect(review.body[1]).toBe('pending-review');
  const approved=f.run(f.request('approve-entry',[community,pending.body[4],review.body[14],'control',false,review.body[5]],f.a,admin));
  expect(approved.body[1]).toBe('approved');
  const receipt=f.run(f.request('receipt',[JSON.parse(Buffer.from(entry.payload,'base64url').toString())[2]],f.b));expect(receipt.body[1]).toBe('member');
  const directory=f.run(f.request('directory',[community],f.b,receipt.body[6] as string));expect(directory.body[10]).toHaveLength(2);
  expect(f.run(f.request('approve-entry',[community,pending.body[4],review.body[14],'control',false,2],f.a,admin)).body[1]).toBe('error');
});

test('a push challenge cannot approve another request, a changed revision or an action signed by the host key',()=>{
  const f=fixture(),root=f.boot(),community=root.body[4] as string,admin=root.body[6] as string;
  const pending=f.run(f.request('entry',[f.profile,f.b.id,'Mac 1',keyString(f.b.host.publicKey),keyString(f.b.viewer.publicKey),'view',community],f.b));
  const review=f.run(f.request('review',[community,pending.body[4]],f.a,admin));
  const bad=f.request('approve-entry',[community,pending.body[4],review.body[14],'view',false,1],f.a,admin);
  bad.signature=sign('sha256',Buffer.concat([REQUEST_DOMAIN,Buffer.from(bad.payload,'base64url')]),{key:f.a.host.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  expect(f.run(bad).body.at(-1)).toBe('INVALID_PROOF');
  expect(f.run(f.request('approve-entry',[community,randomUUID(),review.body[14],'view',false,1],f.a,admin)).body[1]).toBe('error');
  f.run(f.request('route',[community,'192.168.1.21'],f.a,admin));
  expect(f.run(f.request('approve-entry',[community,pending.body[4],review.body[14],'view',false,2],f.a,admin)).body.at(-1)).toBe('STALE_APPROVAL');
  expect(f.run(f.request('push-register',[community,'ab'.repeat(32),'production','attacker.example'],f.a,admin)).body.at(-1)).toBe('PUSH_NOT_CONFIGURED');
});

test('a device can leave without biometric approval; lost leave replies have host-bound receipts and old keys cannot restore membership',()=>{
  const f=fixture(),root=f.boot(),community=root.body[4] as string,admin=root.body[6] as string;
  expect(f.run(f.request('leave',[community],f.a,admin)).body.at(-1)).toBe('LAST_ADMIN');
  const pending=f.run(f.request('entry',[f.profile,f.b.id,'iPad',keyString(f.b.host.publicKey),keyString(f.b.viewer.publicKey),'none',community,'ios'],f.b));
  const review=f.run(f.request('review',[community,pending.body[4]],f.a,admin));
  const approved=f.run(f.request('approve-entry',[community,pending.body[4],review.body[14],'none',true,review.body[5]],f.a,admin));
  const member=approved.body[6] as string;
  const leaving=f.request('leave',[community],f.b,member),id=JSON.parse(Buffer.from(leaving.payload,'base64url').toString())[2];
  const result=f.run(leaving);expect(result.body[1]).toBe('revoked');
  const receipt=f.run(f.request('receipt',[id],f.b));expect(receipt.body[1]).toBe('receipt');expect(receipt.body[4]).toBe(id);
  expect(verifyEnvelope(receipt.body[5] as Envelope,keyString(f.issuer.publicKey))).toEqual(result.body);
  expect(f.run(f.request('directory',[community],f.b,member)).body.at(-1)).toBe('NOT_ENROLLED');
  expect(f.run(f.request('recover',[f.profile,f.b.id,keyString(f.b.host.publicKey),keyString(f.b.viewer.publicKey)],f.b)).body.at(-1)).toBe('NOT_ENROLLED');
  const outsider=f.run(f.request('receipt',[id],f.a));expect(outsider.body.at(-1)).toBe('INVALID_PROOF');
});
