import {describe,test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {randomUUID,randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {CommunityRegistry} from '../cloud/screen-community/src/registry';
import {CommunityAccessRegistry} from '../cloud/screen-community/src/accessRegistry';
import {DurableRegistryStore} from '../cloud/screen-community/src/store';
import {keyString,REQUEST_DOMAIN,verifyEnvelope} from '../cloud/screen-community/src/protocol';
import {ACCESS_REQUEST_DOMAIN,CAPABILITIES,MOBILE_RELAY_PURPOSES,accessSigned,verifyAccessEnvelope,accessPlanBytes,type AccessPlan,type AccessOperation,type AccessEnvelope} from '../cloud/screen-community/src/accessProtocol';
import {createHash} from 'node:crypto';
import vector from '../native/screen-control/Tests/Fixtures/community-access-v2.json';

const keys=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
function fixture(){
  let now=1_800_000_000_000,tick=0;
  const db=new Database(':memory:'),store=new DurableRegistryStore({sql:{exec:(sql:string,...args:unknown[])=>db.query(sql).all(...args as never[]) as never},
    transactionSync:<T>(body:()=>T)=>db.transaction(body)()});
  const issuer=keys(),host=keys(),bio=keys(),operation=keys(),control=keys(),profile=randomUUID(),device=randomUUID(),stateKey=randomBytes(32),issuerPublic=keyString(issuer.publicKey);
  const legacy=new CommunityRegistry(store,issuer.privateKey,stateKey,()=>now,()=>true);
  const oldBytes=Buffer.from(JSON.stringify([1,'bootstrap',randomUUID(),now,randomBytes(32).toString('base64url'),null,[profile,device,'Mac3',keyString(host.publicKey),keyString(bio.publicKey),'control','Community','mac']]));
  const signature=(key:typeof host.privateKey,bytes:Buffer,domain:Buffer)=>sign('sha256',Buffer.concat([domain,bytes]),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
  const boot=legacy.handle({payload:oldBytes.toString('base64url'),signature:signature(bio.privateKey,oldBytes,REQUEST_DOMAIN),hostSignature:signature(host.privateKey,oldBytes,REQUEST_DOMAIN)},'fixture');
  const bootBody=verifyEnvelope(boot.envelope,issuerPublic),community=bootBody[4] as string,admin=bootBody[6] as string;
  expect(bootBody[1]).toBe('member');
  const service=()=>new CommunityAccessRegistry(store,issuer.privateKey,issuerPublic,stateKey,()=>{const at=now;now+=tick;return at;});
  const request=(op:AccessOperation,args:unknown[],key=host.privateKey,actor:string|null=admin,id=randomUUID(),nonce=randomBytes(32).toString('base64url')):AccessEnvelope=>{
    const bytes=Buffer.from(JSON.stringify([2,op,id,now,nonce,actor,args]));return {payload:bytes.toString('base64url'),signature:signature(key,bytes,ACCESS_REQUEST_DOMAIN)};
  };
  const run=(envelope:AccessEnvelope)=>{const result=service().handle(envelope,'fixture');return {...result,body:verifyAccessEnvelope(result.envelope,issuerPublic)};};
  const payload=(envelope:AccessEnvelope)=>run(envelope).body[4] as any;
  const plan:AccessPlan={version:1,profileId:profile,deviceId:device,name:'Mac3',kind:'desktop',hostKey:keyString(host.publicKey),biometricKey:keyString(bio.publicKey),operationKey:keyString(operation.publicKey),controlKey:keyString(control.publicKey),agentDeviceId:randomUUID(),capabilities:CAPABILITIES.filter(cap=>cap!=='screen.desktop-trust'&&cap!=='screen.owner-delegation')};
  function enroll(value=plan,signer=host.privateKey){
    const staged=payload(request('prepare',[value],signer,null));
    const review=payload(request('review',[community,staged.planId]));
    const approved=run(request('approve',[community,staged.planId,review.digest,review.challenge,review.revision],bio.privateKey));
    expect(approved.body[1]).toBe('authorization');return approved.body[4] as any;
  }
  return {db,store,legacy,issuer,issuerPublic,host,bio,operation,control,profile,device,community,admin,service,request,run,payload,plan,enroll,
    advance:(ms:number)=>{now+=ms;},tick:()=>{tick=1;},now:()=>now};
}
function enrollMobile(f:ReturnType<typeof fixture>,caps:AccessPlan['capabilities']=['screen.view','agent.communicate','teams.run','computer-use.agent-settings','computer-use.browser']){
  const mobile={host:keys(),bio:keys(),operation:keys(),session:keys(),id:randomUUID()};
  const authorization=f.enroll({...f.plan,deviceId:mobile.id,name:'Mobile shared auth',kind:'mobile',hostKey:keyString(mobile.host.publicKey),biometricKey:keyString(mobile.bio.publicKey),operationKey:keyString(mobile.operation.publicKey),controlKey:null,agentDeviceId:null,capabilities:caps},mobile.host.privateKey);
  const opened=f.payload(f.request('session-open',[f.community,keyString(mobile.session.publicKey),caps],mobile.bio.privateKey,authorization.enrollmentId));
  return {...mobile,authorization,opened};
}
describe('community-wide enrollment and shared authentication authority',()=>{
  test('browser/settings-only Control enrollment can read its community directory without gaining agent or Teams scope',()=>{
    for(const cap of ['computer-use.agent-settings','computer-use.browser'] as const){
      const f=fixture();const auth=f.enroll({...f.plan,agentDeviceId:null,capabilities:[cap]});
      const directory=f.run(f.request('component-directory',[f.community],f.control.privateKey));expect(directory.body[1]).toBe('directory');
      expect((directory.body[4] as any[])[0].capabilities).toEqual([cap]);expect(auth.agentDeviceId).toBeNull();
      expect(f.run(f.request('component-directory',[f.community],f.operation.privateKey)).body[4]).toEqual({code:'INVALID_PROOF'});
      for(const purpose of ['agent','teams','mobile-agent','mobile-teams'])expect(f.run(f.request('component-ticket',[f.community,purpose,randomUUID(),'host'],f.control.privateKey)).body[4]).toEqual({code:'CAPABILITY_DENIED'});
    }
  });
  test('Worker and CryptoKit use the same reviewed capability-plan digest',()=>{
    expect(createHash('sha256').update(accessPlanBytes(vector.plan as AccessPlan)).digest('hex')).toBe(vector.digest);
  });
  test('one approved capability bundle persists across service restarts; ordinary desktop use needs its operation key only',()=>{
    const f=fixture(),credential=f.enroll();expect(credential.capabilities).toEqual(CAPABILITIES.filter(cap=>cap!=='screen.desktop-trust'&&cap!=='screen.owner-delegation'));expect(credential.deviceKind).toBe('desktop');
    f.advance(3_600_000);
    const renewed=f.run(f.request('authorization',[f.community],f.operation.privateKey));expect(renewed.body[1]).toBe('authorization');
    expect((renewed.body[4] as any).enrollmentId).toBe(f.admin);
    expect(f.run(f.request('authorization',[f.community],f.bio.privateKey)).body[4]).toEqual({code:'INVALID_PROOF'});
    const ticket=f.run(f.request('component-ticket',[f.community,'browser',randomUUID(),'host'],f.control.privateKey));
    expect(ticket.body[1]).toBe('ticket');
    const admitted=f.service().admitTicket(ticket.envelope);expect(admitted.deviceId).toBe(f.device);
    expect(()=>f.service().admitTicket(ticket.envelope)).toThrow('TICKET_ALREADY_USED');
  });
  test('staging grants nothing, and a host-key signature cannot approve its own capability request',()=>{
    const f=fixture();const prepared=f.payload(f.request('prepare',[f.plan],f.host.privateKey,null));
    expect(f.run(f.request('authorization',[f.community],f.operation.privateKey)).body[4]).toEqual({code:'NOT_AUTHORIZED'});
    const reviewed=f.payload(f.request('review',[f.community,prepared.planId]));
    expect(f.run(f.request('approve',[f.community,prepared.planId,reviewed.digest,reviewed.challenge,reviewed.revision])).body[4]).toEqual({code:'INVALID_PROOF'});
  });
  test('selection cannot silently include an unknown feature or a dependent control scope without viewing',()=>{
    const f=fixture();
    for(const scopes of [['root.admin'],['screen.control'],['screen.view','screen.view']]){
      const rejected=f.run(f.request('prepare',[{...f.plan,capabilities:scopes}],f.host.privateKey,null));expect(rejected.body[1]).toBe('error');
    }
    const selected=f.enroll({...f.plan,capabilities:['agent.communicate']});
    expect(selected.capabilities).toEqual(['agent.communicate']);
    expect(f.run(f.request('relay-ticket',[f.community,'screen',randomUUID(),'client',null],f.operation.privateKey)).body[4]).toEqual({code:'CAPABILITY_DENIED'});
  });
  test('computer-use authority binds its own distinct component key and never treats a Viewer key as Control consent',()=>{
    const f=fixture();
    for(const controlKey of [null,f.plan.operationKey,f.plan.hostKey]){
      expect(f.run(f.request('prepare',[{...f.plan,controlKey}],f.host.privateKey,null)).body[1]).toBe('error');
    }
    const grant=f.enroll();expect(grant.controlKey).toBe(f.plan.controlKey);
    expect(grant.hostPublicKey).toBe(f.plan.hostKey);expect(grant.name).toBe(f.plan.name);
  });
  test('an altered reviewed plan and stale community revision cannot be authorized',()=>{
    const f=fixture(),prepared=f.payload(f.request('prepare',[f.plan],f.host.privateKey,null));
    const reviewed=f.payload(f.request('review',[f.community,prepared.planId]));
    expect(f.run(f.request('approve',[f.community,prepared.planId,'0'.repeat(64),reviewed.challenge,reviewed.revision],f.bio.privateKey)).body[4]).toEqual({code:'INVALID_APPROVAL'});
    const community=f.store.get<any>(`community:${f.community}`);community.revision++;f.store.put(`community:${f.community}`,community);
    expect(f.run(f.request('approve',[f.community,prepared.planId,reviewed.digest,reviewed.challenge,reviewed.revision],f.bio.privateKey)).body[4]).toEqual({code:'STALE_APPROVAL'});
  });
  test('expired registration requires a new request, while an expired review can be refreshed',()=>{
    const f=fixture(),first=f.payload(f.request('prepare',[f.plan],f.host.privateKey,null));
    const review=f.payload(f.request('review',[f.community,first.planId]));
    f.advance(120_000);
    expect(f.run(f.request('approve',[f.community,first.planId,review.digest,review.challenge,review.revision],f.bio.privateKey)).body[4]).toEqual({code:'STALE_APPROVAL'});
    const refreshed=f.payload(f.request('review',[f.community,first.planId]));
    expect(refreshed.challenge).not.toBe(review.challenge);
    f.advance(480_000);
    expect(f.run(f.request('status',[first.planId],f.host.privateKey,null)).body[4]).toEqual({code:'REQUEST_EXPIRED'});
    expect(f.run(f.request('review',[f.community,first.planId])).body[4]).toEqual({code:'REQUEST_EXPIRED'});
    const next=f.payload(f.request('prepare',[f.plan],f.host.privateKey,null));
    expect(next.planId).not.toBe(first.planId);
    const nextReview=f.payload(f.request('review',[f.community,next.planId]));
    expect(f.run(f.request('approve',[f.community,next.planId,nextReview.digest,nextReview.challenge,nextReview.revision],f.bio.privateKey)).body[1]).toBe('authorization');
  });
  test('a registered mobile cannot claim desktop trust with the same keys',()=>{
    const f=fixture();const member=f.store.get<any>(`member:${f.admin}`);member.platform='ios';member.grant='none';f.store.put(`member:${f.admin}`,member);
    const prepared=f.payload(f.request('prepare',[f.plan],f.host.privateKey,null)),reviewed=f.payload(f.request('review',[f.community,prepared.planId]));
    expect(f.run(f.request('approve',[f.community,prepared.planId,reviewed.digest,reviewed.challenge,reviewed.revision],f.bio.privateKey)).body[4]).toEqual({code:'DEVICE_KIND_CHANGED'});
  });
  test('one mobile biometric-key proof authorizes a shared session; host switching does not repeat that proof',()=>{
    const f=fixture(),mobile={host:keys(),bio:keys(),operation:keys(),session:keys(),id:randomUUID()};
    const grant=f.enroll({...f.plan,deviceId:mobile.id,name:'iPad mini',kind:'mobile',controlKey:null,agentDeviceId:null,hostKey:keyString(mobile.host.publicKey),biometricKey:keyString(mobile.bio.publicKey),operationKey:keyString(mobile.operation.publicKey),
      capabilities:['screen.view','screen.control','agent.communicate','teams.run','computer-use.browser']},mobile.host.privateKey);
    const opened=f.payload(f.request('session-open',[f.community,keyString(mobile.session.publicKey),grant.capabilities],mobile.bio.privateKey,grant.enrollmentId));
    for(const purpose of ['screen','mobile-agent','mobile-teams','mobile-browser']){
      const result=f.run(f.request('relay-ticket',[f.community,purpose,randomUUID(),'client',opened.sessionId],mobile.session.privateKey,grant.enrollmentId));expect(result.body[1]).toBe('ticket');
    }
    f.advance(3_599_999);
    expect(f.run(f.request('relay-ticket',[f.community,'screen',randomUUID(),'client',opened.sessionId],mobile.session.privateKey,grant.enrollmentId)).body[1]).toBe('ticket');
    f.advance(1);
    expect(f.run(f.request('relay-ticket',[f.community,'screen',randomUUID(),'client',opened.sessionId],mobile.session.privateKey,grant.enrollmentId)).body[4]).toEqual({code:'SESSION_EXPIRED'});
  });
  test('only ordered real-use event types extend idle time; receipt replay and keepalives cannot do so',()=>{
    const f=fixture(),member=f.store.get<any>(`member:${f.admin}`);member.platform='ios';member.grant='none';f.store.put(`member:${f.admin}`,member);
    const grant=f.enroll({...f.plan,kind:'mobile',controlKey:null,agentDeviceId:null,capabilities:['screen.view']}),session=keys();
    const opened=f.payload(f.request('session-open',[f.community,keyString(session.publicKey),grant.capabilities],f.bio.privateKey));
    f.advance(50_000);
    const ping=f.run(f.request('activity',[f.community,opened.sessionId,1,'ping'],session.privateKey));expect(ping.body[4]).toEqual({code:'INVALID_ACTIVITY'});
    const activity=f.request('activity',[f.community,opened.sessionId,1,'touch'],session.privateKey),active=f.payload(activity);
    expect(active.idleExpiresAt).toBe(f.now()+3_600_000);
    f.advance(20_000);expect(f.payload(activity).idleExpiresAt).toBe(active.idleExpiresAt);
    expect(f.run(f.request('activity',[f.community,opened.sessionId,1,'touch'],session.privateKey)).body[4]).toEqual({code:'INVALID_ACTIVITY'});
    expect(f.run(f.request('session-open',[f.community,keyString(keys().publicKey),grant.capabilities],f.operation.privateKey)).body[4]).toEqual({code:'INVALID_PROOF'});
    expect(f.run(f.request('session-close',[f.community,opened.sessionId],session.privateKey)).body[1]).toBe('session-closed');
    expect(f.run(f.request('relay-ticket',[f.community,'screen',randomUUID(),'client',opened.sessionId],session.privateKey)).body[4]).toEqual({code:'SESSION_EXPIRED'});
  });
  test('a lost approval result is recovered with the original owner host key without re-approving or issuing a second grant',()=>{
    const f=fixture(),prepared=f.payload(f.request('prepare',[f.plan],f.host.privateKey,null)),reviewed=f.payload(f.request('review',[f.community,prepared.planId]));
    const approval=f.request('approve',[f.community,prepared.planId,reviewed.digest,reviewed.challenge,reviewed.revision],f.bio.privateKey),approved=f.run(approval);
    const id=JSON.parse(Buffer.from(approval.payload,'base64url').toString())[2];f.advance(61_000);
    const recovered=f.payload(f.request('receipt',[id]));expect(recovered.originalRequestId).toBe(id);expect(recovered.result).toEqual(approved.envelope);
    const policy=f.store.get<any>(`access-policy:${f.admin}`);expect(policy.revision).toBe((approved.body[4] as any).revision);
  });
  test('revocation invalidates tickets and renewal even if the old desktop certificate has not yet expired',()=>{
    const f=fixture();f.enroll();const ticket=f.run(f.request('component-ticket',[f.community,'agent',randomUUID(),'client'],f.control.privateKey));
    const member=f.store.get<any>(`member:${f.admin}`);member.revokedAt=f.now();f.store.put(`member:${f.admin}`,member);
    expect(()=>f.service().admitTicket(ticket.envelope)).toThrow('NOT_ENROLLED');
    expect(f.run(f.request('authorization',[f.community],f.operation.privateKey)).body[4]).toEqual({code:'NOT_ENROLLED'});
  });
  test('real clocks cannot desynchronize signed leases, and each native component proves its own key',()=>{
    const f=fixture();f.enroll();f.tick();
    const status=f.run(f.request('component-status',[f.community],f.control.privateKey));
    expect(status.body[1]).toBe('authorization');expect((status.body[4] as any).issuedAt).toBe(status.body[3]);
    const directory=f.run(f.request('receiver-directory',[f.community],f.host.privateKey));
    expect(directory.body[1]).toBe('directory');expect((directory.body[4] as any[]).every(value=>value.issuedAt===directory.body[3])).toBe(true);
    const ticket=f.run(f.request('receiver-ticket',[f.community,randomUUID()],f.host.privateKey));
    expect(f.service().admitTicket(ticket.envelope).publicKey).toBe(f.plan.hostKey);
    const component=f.run(f.request('component-ticket',[f.community,'agent',randomUUID(),'client'],f.control.privateKey));
    const componentKey=f.plan.controlKey;if(componentKey===null)throw Error('fixture component key missing');
    expect(f.service().admitTicket(component.envelope).publicKey).toBe(componentKey);
    expect(f.run(f.request('component-status',[f.community],f.operation.privateKey)).body[4]).toEqual({code:'INVALID_PROOF'});
    expect(f.run(f.request('relay-ticket',[f.community,'agent',randomUUID(),'client',null],f.operation.privateKey)).body[4]).toEqual({code:'COMPONENT_TICKET_REQUIRED'});
  });
  test('desktop communications bind a unique portal device identity into the reviewed plan',()=>{
    const f=fixture();
    expect(f.run(f.request('prepare',[{...f.plan,agentDeviceId:null}],f.host.privateKey,null)).body[4]).toEqual({code:'AGENT_DEVICE_ID_REQUIRED'});
    const grant=f.enroll();expect(grant.agentDeviceId).toBe(f.plan.agentDeviceId);
  });
  test('legacy community discovery cannot reopen a v2 member through its old biometric key',()=>{
    const f=fixture();f.enroll({...f.plan,capabilities:['agent.communicate']});
    const legacyHost=keys(),legacyBio=keys(),peer=randomUUID(),device=randomUUID();
    f.store.put(`member:${peer}`,{enrollmentId:peer,communityId:f.community,profileId:f.profile,deviceId:device,name:'Legacy Mac',
      hostKey:keyString(legacyHost.publicKey),viewerKey:keyString(legacyBio.publicKey),platform:'mac',grant:'view',admin:false,keyEpoch:1,joinedAt:f.now(),revokedAt:null,route:null});
    const community=f.store.get<any>(`community:${f.community}`);community.memberIds.push(peer);community.revision++;f.store.put(`community:${f.community}`,community);
    function directory(actor:string,key:typeof legacyHost.privateKey):any[]{
      const bytes=Buffer.from(JSON.stringify([1,'directory',randomUUID(),f.now(),randomBytes(32).toString('base64url'),actor,[f.community]]));
      const envelope={payload:bytes.toString('base64url'),signature:sign('sha256',Buffer.concat([REQUEST_DOMAIN,bytes]),{key,dsaEncoding:'ieee-p1363'}).toString('base64url')};
      const result=verifyEnvelope(f.legacy.handle(envelope,'fixture').envelope,f.issuerPublic);expect(result[1]).toBe('directory');return result[10] as any[];
    }
    const legacyPeers=directory(peer,legacyHost.privateKey);
    expect(legacyPeers.map(row=>row[0])).toEqual([peer]); // Receiver cannot admit the v2 member's BIO key.
    const recovery=directory(f.admin,f.host.privateKey);
    expect(recovery.some(row=>row[0]===f.admin)).toBe(true); // Own identity recovery is still available.
  });
  test('mobile aliases map to the exact capability and a target component verifies the existing shared session',()=>{
    const f=fixture();f.enroll();const mobile=enrollMobile(f);
    for(const purpose of MOBILE_RELAY_PURPOSES){
      const checked=f.run(f.request('component-session',[f.community,purpose,mobile.authorization.enrollmentId,mobile.opened.sessionId],f.control.privateKey));
      expect(checked.body[1]).toBe('session');const value=checked.body[4] as any;
      expect(value.sessionId).toBe(mobile.opened.sessionId);expect(value.enrollmentId).toBe(mobile.authorization.enrollmentId);expect(value.publicKey).toBe(keyString(mobile.session.publicKey));
      expect(value.issuedAt).toBe(checked.body[3]);expect(Object.hasOwn(value,'agentDeviceId')).toBe(false);
      const receiver=f.run(f.request('component-ticket',[f.community,purpose,randomUUID(),'host'],f.control.privateKey));
      expect(f.service().admitTicket(receiver.envelope).publicKey).toBe(f.plan.controlKey!);
      const sender=f.run(f.request('relay-ticket',[f.community,purpose,randomUUID(),'client',mobile.opened.sessionId],mobile.session.privateKey,mobile.authorization.enrollmentId));
      expect(f.service().admitTicket(sender.envelope).publicKey).toBe(keyString(mobile.session.publicKey));
    }
  });
  test('mobile alias host/client roles stay separate from legacy desktop purposes and target operation keys',()=>{
    const f=fixture();f.enroll();const mobile=enrollMobile(f);
    for(const purpose of MOBILE_RELAY_PURPOSES){
      expect(f.run(f.request('component-ticket',[f.community,purpose,randomUUID(),'client'],f.control.privateKey)).body[4]).toEqual({code:'INVALID_TICKET_ROLE'});
      expect(f.run(f.request('relay-ticket',[f.community,purpose,randomUUID(),'host',mobile.opened.sessionId],mobile.session.privateKey,mobile.authorization.enrollmentId)).body[4]).toEqual({code:'INVALID_TICKET_ROLE'});
      expect(f.run(f.request('component-ticket',[f.community,purpose,randomUUID(),'host'],mobile.session.privateKey,mobile.authorization.enrollmentId)).body[4]).toEqual({code:'COMPONENT_KEY_REQUIRED'});
      for(const key of [f.host,f.bio,f.operation])expect(f.run(f.request('component-session',[f.community,purpose,mobile.authorization.enrollmentId,mobile.opened.sessionId],key.privateKey)).body[4]).toEqual({code:'INVALID_PROOF'});
    }
    for(const purpose of ['agent','teams','agent-settings','browser'])expect(f.run(f.request('relay-ticket',[f.community,purpose,randomUUID(),'client',mobile.opened.sessionId],mobile.session.privateKey,mobile.authorization.enrollmentId)).body[4]).toEqual({code:'INVALID_TICKET_ROLE'});
    expect(f.run(f.request('component-session',[f.community,'agent',mobile.authorization.enrollmentId,mobile.opened.sessionId],f.control.privateKey)).body[1]).toBe('error');
    const legacy=f.run(f.request('component-ticket',[f.community,'agent',randomUUID(),'host'],f.control.privateKey));expect(f.service().admitTicket(legacy.envelope).purpose).toBe('agent');
  });
  test('component session requires both target capability and current mobile session capability',()=>{
    const f=fixture();f.enroll();const mobile=enrollMobile(f,['agent.communicate']);
    expect(f.run(f.request('component-session',[f.community,'mobile-browser',mobile.authorization.enrollmentId,mobile.opened.sessionId],f.control.privateKey)).body[4]).toEqual({code:'CAPABILITY_DENIED'});
    const policy=f.store.get<any>(`access-policy:${f.admin}`);policy.plan.capabilities=['teams.run'];f.store.put(`access-policy:${f.admin}`,policy);
    expect(f.run(f.request('component-session',[f.community,'mobile-agent',mobile.authorization.enrollmentId,mobile.opened.sessionId],f.control.privateKey)).body[4]).toEqual({code:'CAPABILITY_DENIED'});
    // A narrowed episode cannot borrow a capability merely present on the persistent mobile enrollment.
    const other=fixture();other.enroll();const full=enrollMobile(other);const narrow=other.payload(other.request('session-open',[other.community,keyString(keys().publicKey),['agent.communicate']],full.bio.privateKey,full.authorization.enrollmentId));
    expect(other.run(other.request('component-session',[other.community,'mobile-browser',full.authorization.enrollmentId,narrow.sessionId],other.control.privateKey)).body[4]).toEqual({code:'CAPABILITY_DENIED'});
  });
  test('component session rejects revoked, replaced, expired, revision-changed and foreign mobile episodes',()=>{
    for(const mode of ['revoked','replaced','expired','revision','foreign','closed','wrong-session'] as const){
      const f=fixture();f.enroll();const mobile=enrollMobile(f),id=mobile.authorization.enrollmentId;
      if(mode==='revoked'){const member=f.store.get<any>(`member:${id}`);member.revokedAt=f.now();f.store.put(`member:${id}`,member);}
      if(mode==='foreign'){const member=f.store.get<any>(`member:${id}`);member.communityId=randomUUID();f.store.put(`member:${id}`,member);}
      if(mode==='revision'){const policy=f.store.get<any>(`access-policy:${id}`);policy.revision++;f.store.put(`access-policy:${id}`,policy);}
      if(mode==='replaced')f.payload(f.request('session-open',[f.community,keyString(keys().publicKey),mobile.authorization.capabilities],mobile.bio.privateKey,id));
      if(mode==='expired')f.advance(3_600_000);
      if(mode==='closed')f.payload(f.request('session-close',[f.community,mobile.opened.sessionId],mobile.session.privateKey,id));
      const result=f.run(f.request('component-session',[f.community,'mobile-agent',id,mode==='wrong-session'?randomUUID():mobile.opened.sessionId],f.control.privateKey));
      expect(result.body[1]).toBe('error');expect(result.body[4]).toEqual({code:mode==='revoked'?'NOT_ENROLLED':mode==='foreign'?'OTHER_COMMUNITY':'SESSION_EXPIRED'});
    }
    const f=fixture();f.enroll();expect(f.run(f.request('component-session',[f.community,'mobile-agent',f.admin,randomUUID()],f.control.privateKey)).body[4]).toEqual({code:'MOBILE_SESSION_REQUIRED'});
  });
  test('even an issuer-signed malformed alias ticket cannot cross device class, role or legacy routing',()=>{
    const f=fixture();f.enroll();const mobile=enrollMobile(f);
    const response=f.run(f.request('relay-ticket',[f.community,'mobile-agent',randomUUID(),'client',mobile.opened.sessionId],mobile.session.privateKey,mobile.authorization.enrollmentId)),ticket=response.body[4] as any;
    for(const change of [{purpose:'agent'},{role:'host'}]){
      const body={...ticket,...change,ticketId:randomUUID()};expect(()=>f.service().admitTicket(accessSigned('ticket',body.ticketId,f.now(),body,f.issuer.privateKey))).toThrow('INVALID_TICKET_ROLE');
    }
    const host=f.run(f.request('component-ticket',[f.community,'mobile-agent',randomUUID(),'host'],f.control.privateKey)).body[4] as any;
    const client={...host,ticketId:randomUUID(),role:'client'};expect(()=>f.service().admitTicket(accessSigned('ticket',client.ticketId,f.now(),client,f.issuer.privateKey))).toThrow('INVALID_TICKET_ROLE');
  });

  test('a single target or mobile capability authorizes exactly its corresponding alias',()=>{
    const mapping=[['mobile-agent','agent.communicate'],['mobile-teams','teams.run'],['mobile-agent-settings','computer-use.agent-settings'],['mobile-browser','computer-use.browser']] as const;
    for(const [selected,cap]of mapping)for(const narrow of ['target','mobile'] as const){
      const f=fixture();f.enroll(narrow==='target'?{...f.plan,capabilities:[cap]}:f.plan);const mobile=enrollMobile(f,narrow==='mobile'?[cap]:undefined);
      for(const [purpose]of mapping){
        const result=f.run(f.request('component-session',[f.community,purpose,mobile.authorization.enrollmentId,mobile.opened.sessionId],f.control.privateKey));
        if(purpose===selected)expect(result.body[1]).toBe('session');else expect(result.body[4]).toEqual({code:'CAPABILITY_DENIED'});
      }
      expect(f.run(f.request('relay-ticket',[f.community,selected,randomUUID(),'client',mobile.opened.sessionId],mobile.operation.privateKey,mobile.authorization.enrollmentId)).body[4]).toEqual({code:'INVALID_PROOF'});
    }
  });

});
