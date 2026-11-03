import {describe,test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {keyString} from '../cloud/screen-community/src/protocol';
import {safetyPolicyDigest} from '../cloud/screen-community/src/screenSafety';
import {screenSafetyFixture,safetyPerson} from './fixtures/community-screen-safety';
describe('common-only Screen safety authority',()=>{
 test('neither enrollment nor stored token is a ready round; host proof and current eligible watcher are mandatory',()=>{
  const f=screenSafetyFixture();expect(f.poll().value.watchers).toEqual([]);expect(f.subscribe().kind).toBe('safety-subscribed');
  const signed=f.pollRequest(),round=f.run(signed);expect(round.kind).toBe('safety-round');expect(round.value.watchers).toHaveLength(1);expect(round.value.pollRequestId).toBe(JSON.parse(Buffer.from(signed.payload,'base64url').toString())[2]);
  expect(f.store.get('push:'+f.mobile.enrollment)).toBeUndefined();f.pushConfigured(false);expect(f.poll().value.watchers).toEqual([]);
  expect(f.call('receiver-safety-poll',[f.cid,f.activation,0,[],{...f.snapshot,observationSequence:2}],f.host,'op').value.code).toBe('INVALID_PROOF');
 });
 test('self subscription preserves generation for same observation, rotates changed tokens, and null retires it without granting a role',()=>{
  const f=screenSafetyFixture(),first=f.subscribe(),second=f.subscribe();expect(first.value.subscriptionGeneration).toBe(second.value.subscriptionGeneration);
  expect(f.subscribe(f.mobile,'cd'.repeat(32)).value.subscriptionGeneration).not.toBe(first.value.subscriptionGeneration);
  expect(f.remove().value.subscriptionGeneration).toBeNull();expect(f.poll().value.watchers).toEqual([]);
  const nonadmin=safetyPerson('Non-admin');f.enroll(nonadmin,['screen.view']);expect(f.subscribe(nonadmin).value.code).toBe('ADMIN_REQUIRED');
  expect(f.call('screen-safety-subscribe',[f.cid,null,f.observe(nonadmin,null)],nonadmin,'op').kind).toBe('safety-subscribed');
 });
 test('OS denied remove wins over delayed subscribe, and newer permission allow wins over a delayed older remove',()=>{
  const f=screenSafetyFixture(),s=f.request('screen-safety-subscribe',[f.cid,{token:'ab'.repeat(32),environment:'sandbox',topic:f.topic},f.observe(f.mobile,{})],f.mobile,'op');
  expect(f.remove().kind).toBe('safety-subscribed');expect(f.run(s).value.code).toBe('SUBSCRIPTION_OBSERVATION_STALE');expect(f.poll().value.watchers).toEqual([]);
  const oldRemove=f.request('screen-safety-subscribe',[f.cid,null,f.observe(f.mobile,null)],f.mobile,'op');const newAllow=f.subscribe();expect(newAllow.kind).toBe('safety-subscribed');
  expect(f.run(oldRemove).value.code).toBe('SUBSCRIPTION_OBSERVATION_STALE');expect(f.poll().value.watchers).toHaveLength(1);
 });
 test('an explicit new OS-denied removal after a lost expired removal retires older observations without replaying them',()=>{
  const f=screenSafetyFixture();
  const originalPositive=f.request('screen-safety-subscribe',[f.cid,{token:'ab'.repeat(32),environment:'sandbox',topic:f.topic},f.observe(f.mobile,{})],f.mobile,'op');
  expect(f.run(originalPositive).value.subscriptionGeneration).toBeDefined();
  const lostRemove=f.request('screen-safety-subscribe',[f.cid,null,f.observe(f.mobile,null)],f.mobile,'op'),lostId=JSON.parse(Buffer.from(lostRemove.payload,'base64url').toString())[2];
  // The original removal never reached the server. Only an explicit newly observed negative action is prepared.
  f.advance(61_000);expect(f.call('receipt',[lostId],f.mobile,'host').value.code).toBe('RECEIPT_NOT_FOUND');
  expect(f.remove().value.subscriptionGeneration).toBeNull();expect(f.store.get<number>('safety-subscription-observation:'+f.mobile.enrollment)).toBe(3);
  expect(f.run(originalPositive).value.code).toBe('INVALID_REQUEST');expect(f.run(lostRemove).value.code).toBe('INVALID_REQUEST');expect(f.poll().value.watchers).toEqual([]);
  expect(f.subscribe(f.mobile,'ef'.repeat(32)).kind).toBe('safety-subscribed');
  expect(f.run(lostRemove).value.code).toBe('INVALID_REQUEST');expect(f.poll().value.watchers).toHaveLength(1);
 });
 test('late positive observation cannot cross role or policy revision changes even with the old current operation key',()=>{
  const f=screenSafetyFixture(),s=f.request('screen-safety-subscribe',[f.cid,{token:'ab'.repeat(32),environment:'sandbox',topic:f.topic},f.observe(f.mobile,{})],f.mobile,'op');
  const p=f.store.get<any>('access-policy:'+f.mobile.enrollment);p.revision++;f.store.put('access-policy:'+f.mobile.enrollment,p);
  expect(f.run(s).value.code).toBe('SUBSCRIPTION_POLICY_CHANGED');expect(f.poll().value.watchers).toEqual([]);
 });
 test('stop uses current RAM proof and immutable original receipt, result requires separate exact host proof',()=>{
  const f=screenSafetyFixture();f.subscribe();f.openUse();f.poll();const request=f.stopRequest(),queued=f.run(request),id=queued.value.commandId;
  expect(queued.kind).toBe('safety-result');expect(queued.value.state).toBe('queued');expect(f.run(request).envelope).toEqual(queued.envelope);
  const round=f.poll();expect(round.value.commands).toHaveLength(1);expect(round.value.commands[0].request).toEqual(request);
  expect(f.poll([f.result(id,'ended')]).value.code).toBe('INVALID_SAFETY_RESULT');
  const proof=f.result(id);expect(f.poll([proof]).kind).toBe('safety-round');expect(f.poll().value.commands).toEqual([]);
  const receipt=f.call('screen-safety-result',[f.cid,f.mobile.useId,id],f.mobile,'ram');expect(receipt.value.state).toBe('result');expect(receipt.value.result).toEqual(proof);
  expect(f.call('screen-safety-stop',[f.cid,f.mobile.useId,f.host.enrollment,f.activation,{action:'turnOff',targetEnrollmentId:null,expectedSessionId:null}],f.mobile,'op').value.code).toBe('INVALID_PROOF');
 });
 test('admitted negative stop remains after use idle expiry; read uses a fresh episode of the same stable owner',()=>{
  const f=screenSafetyFixture();f.subscribe();f.openUse();f.poll();const stop=f.run(f.stopRequest());f.advance(3_601_000);
  expect(f.poll().value.commands.map((v:any)=>v.commandId)).toEqual([stop.value.commandId]);
  f.openUse();expect(f.call('screen-safety-result',[f.cid,f.mobile.useId,stop.value.commandId],f.mobile,'ram').value.state).toBe('queued');
 });
 test('stop admission matches the native five-second future boundary while retaining the past-sixty-second window',()=>{
  const f=screenSafetyFixture();f.subscribe();f.openUse();f.poll();
  const at=(offset:number)=>{f.advance(offset);const request=f.stopRequest();f.advance(-offset);return request;};
  expect(f.run(at(5_000)).value.state).toBe('queued');
  expect(f.run(at(5_001)).value.code).toBe('INVALID_SAFETY_STOP_TIME');
  expect(f.run(at(60_000)).value.code).toBe('INVALID_SAFETY_STOP_TIME');
  expect(f.run(at(-60_000)).value.state).toBe('queued');
  expect(f.run(at(-60_001)).value.code).toBe('INVALID_REQUEST');
  expect(f.poll().value.commands).toHaveLength(2);
  f.advance(60_000);const other=f.request('authorization',[f.cid],f.mobile,'op');f.advance(-60_000);
  expect(f.run(other).kind).toBe('authorization');
 });
 test('watcher policy, role, epoch, subscription or membership changes remove both witness and queued command authority',()=>{
  for(const kind of ['policy','role','epoch','subscription','revoked']){
   const f=screenSafetyFixture();f.subscribe();f.openUse();f.poll();f.run(f.stopRequest());
   const m=f.store.get<any>('member:'+f.mobile.enrollment);
   if(kind==='policy'){const p=f.store.get<any>('access-policy:'+f.mobile.enrollment);p.revision++;f.store.put('access-policy:'+f.mobile.enrollment,p);}
   if(kind==='role')m.admin=false;if(kind==='epoch')m.keyEpoch++;if(kind==='revoked')m.revokedAt=f.now();f.store.put('member:'+f.mobile.enrollment,m);
   if(kind==='subscription')f.remove();const round=f.poll();expect(round.value.watchers).toEqual([]);expect(round.value.commands).toEqual([]);
  }
 });
 test('issuer state reports the exact host channel; stale channel or activation cannot address a new session',()=>{
  const f=screenSafetyFixture();f.subscribe();f.openUse();const channel=randomUUID(),snapshot={power:'on' as const,held:false,session:{channelId:channel,controllerEnrollmentId:f.mobile.enrollment!,since:f.now()}};
  f.poll([],0,f.activation,snapshot);const state=f.call('screen-safety-state',[f.cid,f.mobile.useId,f.host.enrollment],f.mobile,'ram');expect(state.value.activationId).toBe(f.activation);expect(state.value.state.session.channelId).toBe(channel);
  expect(f.run(f.stopRequest('end',null,randomUUID())).value.code).toBe('STALE_SAFETY_SESSION');expect(f.run(f.stopRequest('end',null,channel)).value.state).toBe('queued');
  expect(f.run(f.stopRequest('turnOff',null,null,randomUUID())).value.code).toBe('SAFETY_ACTIVATION_CHANGED');
  const newer=randomUUID();expect(f.poll([],0,newer,{power:'on',held:false,session:null}).value.commands).toEqual([]);
  f.advance(90_001);const old=f.call('screen-safety-state',[f.cid,f.mobile.useId,f.host.enrollment],f.mobile,'ram');expect(old.value.state).toBeNull();expect(old.value.activationId).toBe(newer);
 });
 test('late host result and exact duplicate survive a network loss longer than sixty seconds without timestamp repackaging',()=>{
  const f=screenSafetyFixture();f.subscribe();f.openUse();f.poll();const queued=f.run(f.stopRequest()),id=queued.value.commandId;
  const proof=f.result(id);f.advance(120_000);expect(f.poll([proof]).kind).toBe('safety-round');f.advance(120_000);expect(f.poll([proof]).kind).toBe('safety-round');
  const read=f.call('screen-safety-result',[f.cid,f.mobile.useId,id],f.mobile,'ram');expect(read.value.result).toEqual(proof);
  expect(f.poll([f.result(id)]).value.code).toBe('SAFETY_RESULT_CONFLICT');
 });
 test('a newly signed result cannot turn an effect after its original command deadline into success',()=>{
  const f=screenSafetyFixture();f.subscribe();f.openUse();const channel=randomUUID();f.poll([],0,f.activation,{power:'on',held:false,session:{channelId:channel,controllerEnrollmentId:f.mobile.enrollment!,since:f.now()}});
  const queued=f.run(f.stopRequest('end',null,channel));f.advance(610_000);
  expect(f.poll([f.result(queued.value.commandId,'ended')]).value.code).toBe('INVALID_SAFETY_RESULT_TIME');
 });
 test('late old activation and old snapshot polls cannot overwrite newer protected observations',()=>{
  const f=screenSafetyFixture();f.subscribe();const older=f.pollRequest([],0,f.activation,{power:'on',held:false,session:null}),newer=randomUUID();
  expect(f.poll([],0,newer,{power:'on',held:false,session:null}).kind).toBe('safety-round');expect(f.run(older).value.code).toBe('SAFETY_POLL_STALE');
  const oldState=f.pollRequest([],0,newer,{power:'on',held:false,session:null});const stopped=f.poll([],0,newer,{power:'off',held:true,session:null});expect(stopped.kind).toBe('safety-round');
  expect(f.run(oldState).value.code).toBe('SAFETY_POLL_STALE');f.openUse();const state=f.call('screen-safety-state',[f.cid,f.mobile.useId,f.host.enrollment],f.mobile,'ram');expect(state.value.state.power).toBe('off');expect(state.value.activationId).toBe(newer);
 });
 test('a final original result can be carried by a newer activation poll without rolling back its state',()=>{
  const f=screenSafetyFixture();f.subscribe();f.openUse();f.poll();const queued=f.run(f.stopRequest()),proof=f.result(queued.value.commandId),newer=randomUUID();
  expect(f.poll([proof],0,newer,{power:'on',held:false,session:null}).kind).toBe('safety-round');
  const state=f.call('screen-safety-state',[f.cid,f.mobile.useId,f.host.enrollment],f.mobile,'ram');expect(state.value.activationId).toBe(newer);expect(state.value.state.power).toBe('on');
  expect(f.call('screen-safety-result',[f.cid,f.mobile.useId,queued.value.commandId],f.mobile,'ram').value.result).toEqual(proof);
 });
 test('five unresolved stops wrap fairly after cursor three and a paging cursor never acknowledges a command',()=>{
  const f=screenSafetyFixture();f.subscribe();f.openUse();f.poll();for(let i=0;i<5;i++)expect(f.run(f.stopRequest()).value.state).toBe('queued');
  const round=f.poll([],3);expect(round.value.commands.map((r:any)=>r.sequence)).toEqual([4,5,1,2]);expect(round.value.nextSequence).toBe(2);
  expect(f.poll([],2).value.commands.map((r:any)=>r.sequence)).toEqual([3,4,5,1]);
 });
 test('subscription capability is separate from administrator and screen watcher selection; no v1 migration or extra BIO subscription',()=>{
  const f=screenSafetyFixture(),mobile=safetyPerson('Only browser');f.enroll(mobile,['computer-use.browser'],true,true);expect(f.subscribe(mobile).kind).toBe('safety-subscribed');expect(f.poll().value.watchers).toEqual([]);
  const pending=safetyPerson('New Mac'),plan={version:1,profileId:f.profile,deviceId:pending.device,name:pending.name,kind:'desktop',hostKey:keyString(pending.host.publicKey),biometricKey:keyString(pending.bio.publicKey),operationKey:keyString(pending.op.publicKey),controlKey:null,agentDeviceId:null,capabilities:['screen.receive.view']};
  f.call('prepare',[plan],pending,'host',null);const notices=f.service().takeNotifications();expect(notices.some(n=>n.recipientId===mobile.enrollment&&n.subscriptionGeneration)).toBe(true);expect(f.store.get('push:'+mobile.enrollment)).toBeUndefined();
 });
 test('new subscription generation survives old APNs dead-token cleanup; event-only queue never claims poll as an alert',()=>{
  const f=screenSafetyFixture();f.subscribe();f.poll();expect(f.service().screenSafety().hasNotifications()).toBe(false);
  expect(f.call('receiver-safety-event',[f.cid,f.activation,randomUUID(),'connection',f.mobile.enrollment],f.host).value.state).toBe('queued');
  const job=f.service().screenSafety().takeNotifications()[0]!;expect(job).toBeDefined();expect(f.service().screenSafety().notificationCurrent(job)).toBe(true);
  f.subscribe(f.mobile,'ef'.repeat(32));f.service().screenSafety().removeDeadPush(job);expect(f.poll().value.watchers).toHaveLength(1);expect(f.service().screenSafety().notificationCurrent(job)).toBe(false);
 });
 test('an advisory event ID belongs to its exact receiver, activation, kind and actor and cannot overwrite the original row',()=>{
  const f=screenSafetyFixture();f.subscribe();const id=randomUUID(),args=[f.cid,f.activation,id,'connection',f.mobile.enrollment];
  expect(f.call('receiver-safety-event',args,f.host).value.state).toBe('queued');
  const original=f.store.get<Record<string,unknown>>('safety-event:'+id),other=safetyPerson('Other receiver');f.enroll(other,['screen.receive.view'],false);
  expect(f.call('receiver-safety-event',args,other).value.code).toBe('SAFETY_EVENT_ID_CONFLICT');
  for(const replacement of [[f.cid,randomUUID(),id,'connection',f.mobile.enrollment],[f.cid,f.activation,id,'security',f.mobile.enrollment],[f.cid,f.activation,id,'connection',null]])expect(f.call('receiver-safety-event',replacement,f.host).value.code).toBe('SAFETY_EVENT_ID_CONFLICT');
  f.advance(121_000);expect(f.call('receiver-safety-event',args,f.host).value.state).toBe('coalesced');
  expect(f.store.get<Record<string,unknown>>('safety-event:'+id)).toEqual(original);
  expect(f.service().screenSafety().takeNotifications()).toHaveLength(1);
 });
 test('foreign communities, alternate host keys, non-owner results and forged host result signatures are refused',()=>{
  const f=screenSafetyFixture();f.subscribe();f.openUse();f.poll();const queued=f.run(f.stopRequest());
  expect(f.call('screen-safety-state',[randomUUID(),f.mobile.useId,f.host.enrollment],f.mobile,'ram').value.code).toBe('OTHER_COMMUNITY');
  const stranger=safetyPerson('Other admin');f.enroll(stranger,['screen.view'],true,true);f.openUse(stranger);
  expect(f.call('screen-safety-result',[f.cid,stranger.useId,queued.value.commandId],stranger,'ram').value.code).toBe('OTHER_COMMAND_OWNER');
  const forged={...f.result(queued.value.commandId),signature:Buffer.alloc(64).toString('base64url')};expect(f.poll([forged]).value.code).toBe('INVALID_SAFETY_RESULT');
  const unknown=f.result(randomUUID());expect(f.poll([unknown]).value.code).toBe('SAFETY_COMMAND_UNKNOWN');
 });
 test('safety subscriptions stop at sixteen while community membership remains available, and removing one frees its slot',()=>{
  const f=screenSafetyFixture();f.subscribe();
  for(let i=0;i<15;i++){if(i%4===0)f.advance(61_000);const who=safetyPerson('Watcher '+i);f.enroll(who,['screen.view'],true,true);expect(f.subscribe(who).kind).toBe('safety-subscribed');}
  f.advance(61_000);const extra=safetyPerson('Still a member');f.enroll(extra,['screen.view'],true,true);expect(f.subscribe(extra).value.code).toBe('SAFETY_SUBSCRIPTION_LIMIT');
  expect(f.store.get<any>('member:'+extra.enrollment).revokedAt).toBeNull();expect(f.poll().value.watchers).toHaveLength(16);
  f.remove();expect(f.subscribe(extra).kind).toBe('safety-subscribed');expect(f.poll().value.watchers).toHaveLength(16);
 });
 test('queue exhaustion refuses a new effect and expiry does not permanently fill the receiver ledger',()=>{
  const f=screenSafetyFixture();f.subscribe();f.openUse();f.poll();
  for(let i=0;i<32;i++)expect(f.run(f.stopRequest()).value.state).toBe('queued');
  expect(f.run(f.stopRequest()).value.code).toBe('SAFETY_QUEUE_FULL');f.advance(7*86400_000+1_000);f.openUse();f.poll();expect(f.run(f.stopRequest()).value.state).toBe('queued');
 });
 test('poll receipt replay keeps the original issuance and nonce and never becomes a fresh thirty-minute witness',()=>{
  const f=screenSafetyFixture();f.subscribe();const poll=f.pollRequest(),first=f.run(poll);f.advance(30_000);expect(f.run(poll).envelope).toEqual(first.envelope);expect(f.run(poll).value.issuedAt).toBe(first.value.issuedAt);
 });
});
