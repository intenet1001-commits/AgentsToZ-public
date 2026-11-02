import {test, expect} from 'bun:test';
import {generateKeyPairSync, randomBytes, randomUUID, sign} from 'node:crypto';
import {CommunityAccessClient, CommunityAccessReply, CommunityAccessClientError, CommunityRelayTicket,
  COMMUNITY_MOBILE_RELAY_PURPOSES, communityComponentSessionArgs, type CommunityAccessRequest, type CommunityRelayTicketBody} from '../src/communityAccessClient';
import {CommunityRelayClient, type CommunityRelaySocketFactory} from '../src/communityRelayClient';

const pair = () => generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
const point = (key: ReturnType<typeof pair>['publicKey']) => {
  const value = key.export({format: 'jwk'});
  return Buffer.concat([Buffer.from([4]), Buffer.from(value.x!, 'base64url'), Buffer.from(value.y!, 'base64url')]).toString('base64url');
};
const issuer = pair(), operation = pair();
const signed = (kind: string, id: string, at: number, payload: unknown, domain = 'agentstoz.community-access.response/v2\0') => {
  const bytes = Buffer.from(JSON.stringify([2, kind, id, at, payload]));
  return {payload: bytes.toString('base64url'), signature: sign('sha256', Buffer.concat([Buffer.from(domain), bytes]), {key: issuer.privateKey, dsaEncoding: 'ieee-p1363'}).toString('base64url')};
};
const request = (): CommunityAccessRequest => ({operation: 'authorization', actor: randomUUID(), args: [randomUUID()], requestId: randomUUID(), observedAt: Date.now(), nonce: randomBytes(32).toString('base64url')});
const nativeSign = (r: Readonly<CommunityAccessRequest>, args: readonly unknown[] = r.args) => {
  const bytes = Buffer.from(JSON.stringify([2, r.operation, r.requestId, r.observedAt, r.nonce, r.actor, args]));
  return {payload: bytes.toString('base64url'), signature: sign('sha256', Buffer.concat([Buffer.from('agentstoz.community-access.request/v2\0'), bytes]), {key: operation.privateKey, dsaEncoding: 'ieee-p1363'}).toString('base64url')};
};

test('HTTP pins issuer/domain/request and preserves uncertainty without replaying a failed dispatch', async () => {
  let calls = 0;
  const signer = {publicKey: point(operation.publicKey), signAccessRequest: async (r: Readonly<CommunityAccessRequest>) => {
    expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.args)).toBe(true);
    return nativeSign(r);
  }};
  const unconfirmed = new CommunityAccessClient('https://fixture.workers.dev', point(issuer.publicKey), signer, async () => {
    ++calls; throw new CommunityAccessClientError('NOT_ENROLLED'); // Not an issuer-signed rejection.
  });
  try { await unconfirmed.exchange(request()); throw new Error('Expected failure'); }
  catch (error) { expect((error as CommunityAccessClientError).outcome).toBe('unknown'); }
  expect(calls).toBe(1);
  const r = request(), at = Date.now();
  await expect(CommunityAccessReply.verify(signed('authorization', randomUUID(), at, {}), point(issuer.publicKey), r.requestId)).rejects.toThrow('STALE_RESPONSE');
  await expect(CommunityAccessReply.verify(signed('authorization', r.requestId, at, {}, 'wrong-domain'), point(issuer.publicKey), r.requestId)).rejects.toThrow('INVALID_ISSUER');
  const refused = new CommunityAccessClient('https://fixture.workers.dev', point(issuer.publicKey), signer,
    async (_url, init) => {
      const body = JSON.parse(String(init!.body)), fields = JSON.parse(Buffer.from(body.payload, 'base64url').toString());
      return Response.json(signed('error', fields[2], Date.now(), {code: 'NOT_ENROLLED'}), {status: 400});
    });
  try { await refused.exchange(request()); throw new Error('Expected refusal'); }
  catch (error) { expect((error as CommunityAccessClientError).code).toBe('NOT_ENROLLED'); expect((error as CommunityAccessClientError).outcome).toBe('refused'); }
});

test('native signed JSON bytes remain intact across different native object-key ordering', async () => {
  let actualPayload = '';
  const client = new CommunityAccessClient('https://fixture.workers.dev', point(issuer.publicKey), {
    publicKey: point(operation.publicKey), signAccessRequest: async r => nativeSign(r, [{a: 2, z: 1}]),
  }, async (_url, init) => {
    const wrapped = JSON.parse(String(init.body)); actualPayload = Buffer.from(wrapped.payload, 'base64url').toString();
    const fields = JSON.parse(actualPayload); return Response.json(signed('authorization', fields[2], Date.now(), {}));
  });
  await client.exchange({...request(), args: [{z: 1, a: 2}]});
  expect(actualPayload).toContain('{"a":2,"z":1}');
  const changed = new CommunityAccessClient('https://fixture.workers.dev', point(issuer.publicKey), {
    publicKey: point(operation.publicKey), signAccessRequest: async r => nativeSign(r, [{a: 3, z: 1}]),
  }, async () => { throw new Error('changed intent must not dispatch'); });
  await expect(changed.exchange({...request(), args: [{z: 1, a: 2}]})).rejects.toThrow('INVALID_NATIVE_PROOF');
});

async function relayFixture() {
  const identity = {communityId: randomUUID(), enrollmentId: randomUUID(), deviceId: randomUUID(), purpose: 'screen' as const, role: 'client' as const, sessionId: null};
  const records: Array<{type: string; to: string; id: string}> = [];
  let onMessage: (text: string) => void = () => {}, onClose: () => void = () => {}, buffered = 0, opened = 0;
  let lastTicket: CommunityRelayTicket;
  const ticket = async (connectionId: string) => {
    const now = Date.now(), body: CommunityRelayTicketBody = {version: 1, ticketId: randomUUID(), ...identity, connectionId,
      deviceKind: 'desktop', publicKey: point(operation.publicKey), revision: 1, issuedAt: now, expiresAt: now + 30_000, leaseExpiresAt: now + 90_000};
    const reply = await CommunityAccessReply.verify(signed('ticket', body.ticketId, now, body), point(issuer.publicKey), body.ticketId);
    lastTicket = CommunityRelayTicket.fromReply(reply, {...identity, connectionId, publicKey: body.publicKey}); return lastTicket;
  };
  const sockets: CommunityRelaySocketFactory = {open: async input => {
    ++opened; onMessage = input.onMessage; onClose = input.onClose;
    expect(input.url).toBe('wss://fixture.workers.dev/relay'); expect(input.authorization.startsWith('AgentsToZ ')).toBe(true);
    queueMicrotask(() => onMessage(JSON.stringify({type: 'challenge', ticketId: lastTicket.body.ticketId,
      connectionId: lastTicket.body.connectionId, challenge: randomBytes(32).toString('base64url')})));
    return {get bufferedAmount() { return buffered; }, close: () => onClose(), send: text => {
      const frame = JSON.parse(text);
      if (frame.type === 'proof') queueMicrotask(() => onMessage(JSON.stringify({type: 'ready', connectionId: lastTicket.body.connectionId, leaseExpiresAt: lastTicket.body.leaseExpiresAt})));
      else records.push(frame);
    }};
  }};
  const client = new CommunityRelayClient('https://fixture.workers.dev', identity, {publicKey: point(operation.publicKey), signRelayProof: async () => new Uint8Array(64)}, ticket, sockets, () => {});
  await client.connect();
  return {client, records, buffered: (n: number) => { buffered = n; }, opened: () => opened,
    ack: (id: string, reachable = true) => onMessage(JSON.stringify({type: 'forwarded', id, reachable}))};
}
const cipher = Buffer.from('opaque authenticated record fixture').toString('base64url');

test('an unresponsive peer has bounded slots while another peer still sends; unknown outcomes are never replayed', async () => {
  const f = await relayFixture(), offline = randomUUID(), awake = randomUUID();
  try {
    const outcomes: Promise<unknown>[] = [];
    for (let i = 0; i < 36; ++i) outcomes.push(f.client.sendRecord({to: offline, id: randomUUID(), ciphertext: cipher}).catch(error => error));
    expect(f.records.length).toBe(4);
    await expect(f.client.sendRecord({to: offline, id: randomUUID(), ciphertext: cipher})).rejects.toThrow('QUEUE_FULL');
    const id = randomUUID(), other = f.client.sendRecord({to: awake, id, ciphertext: cipher});
    expect(f.records.at(-1)?.id).toBe(id); f.ack(id); expect((await other).stage).toBe('forwarded');
    f.ack(id); await Promise.resolve(); // Duplicate admission does not close other peer traffic.
    f.client.close(); const ended = await Promise.all(outcomes);
    expect(ended.filter((e: any) => e.outcome === 'unknown').length).toBe(4);
    expect(ended.filter((e: any) => e.outcome === 'unsent').length).toBe(32);
    const sent = f.records.length; await f.client.connect(); expect(f.opened()).toBe(2); expect(f.records.length).toBe(sent);
  } finally { f.client.close(); }
});

test('control precedes buffered media; explicit media coalescing never discards a control record', async () => {
  const f = await relayFixture(), target = randomUUID();
  try {
    f.buffered(1_000_000);
    const replaced = f.client.sendRecord({to: target, id: randomUUID(), ciphertext: cipher, lane: 'media', coalesceKey: 'video'}).catch(error => error);
    const mediaId = randomUUID(), media = f.client.sendRecord({to: target, id: mediaId, ciphertext: cipher, lane: 'media', coalesceKey: 'video'});
    const controlId = randomUUID(), control = f.client.sendRecord({to: target, id: controlId, ciphertext: cipher});
    expect((await replaced).code).toBe('SUPERSEDED'); expect(f.records.length).toBe(0);
    f.buffered(0); await new Promise(resolve => setTimeout(resolve, 40));
    expect(f.records.map(r => r.id)).toEqual([controlId, mediaId]); f.ack(controlId); f.ack(mediaId);
    expect((await control).requestId).toBe(controlId); expect((await media).requestId).toBe(mediaId);
  } finally { f.client.close(); }
});

test('a prototype-shaped object cannot substitute for an issuer-verified ticket', () => {
  const forged = Object.create(CommunityAccessReply.prototype); forged.kind = 'ticket';
  expect(() => CommunityRelayTicket.fromReply(forged, {} as never)).toThrow('INVALID_TICKET');
  expect(CommunityRelayTicket.isVerified(Object.create(CommunityRelayTicket.prototype))).toBe(false);
});


test('typed component-session requests keep exact mobile episode binding and purpose-limited native signing',async()=>{
  expect(CommunityAccessReply.isVerified(Object.create(CommunityAccessReply.prototype))).toBe(false);
  const communityId=randomUUID(),mobileEnrollmentId=randomUUID(),sessionId=randomUUID();
  for(const purpose of COMMUNITY_MOBILE_RELAY_PURPOSES){
    const args=communityComponentSessionArgs({communityId,purpose,mobileEnrollmentId,sessionId});expect(args).toEqual([communityId,purpose,mobileEnrollmentId,sessionId]);expect(Object.isFrozen(args)).toBe(true);
    const r:CommunityAccessRequest={...request(),operation:'component-session',args};let calls=0;
    const client=new CommunityAccessClient('https://fixture.workers.dev',point(issuer.publicKey),{publicKey:point(operation.publicKey),signAccessRequest:async typed=>{expect(typed.operation).toBe('component-session');return nativeSign(typed);}},async(_url,init)=>{
      ++calls;const wrapped=JSON.parse(String(init.body)),fields=JSON.parse(Buffer.from(wrapped.payload,'base64url').toString());expect(fields[6]).toEqual(args);
      return Response.json(signed('session',fields[2],Date.now(),{sessionId}));
    });
    const reply=await client.exchange(r);expect(reply.kind).toBe('session');expect(CommunityAccessReply.isVerified(reply)).toBe(true);expect(calls).toBe(1);
  }
  expect(()=>communityComponentSessionArgs({communityId,purpose:'agent' as any,mobileEnrollmentId,sessionId})).toThrow('INVALID_REQUEST');
});

test('issuer-verified SDK tickets enforce mobile alias device roles instead of accepting a legacy desktop socket',async()=>{
  for(const purpose of COMMUNITY_MOBILE_RELAY_PURPOSES)for(const deviceKind of ['mobile','desktop'] as const){
    const at=Date.now(),body:CommunityRelayTicketBody={version:1,ticketId:randomUUID(),communityId:randomUUID(),enrollmentId:randomUUID(),deviceId:randomUUID(),deviceKind,
      connectionId:randomUUID(),publicKey:point(operation.publicKey),purpose,role:deviceKind==='mobile'?'client':'host',sessionId:deviceKind==='mobile'?randomUUID():null,revision:1,issuedAt:at,expiresAt:at+30_000,leaseExpiresAt:at+90_000};
    const expected={communityId:body.communityId,enrollmentId:body.enrollmentId,deviceId:body.deviceId,connectionId:body.connectionId,publicKey:body.publicKey,purpose,role:body.role,sessionId:body.sessionId};
    const reply=await CommunityAccessReply.verify(signed('ticket',body.ticketId,at,body),point(issuer.publicKey),body.ticketId);
    expect(CommunityRelayTicket.fromReply(reply,expected).body.purpose).toBe(purpose);
    const altered={...body,role:deviceKind==='mobile'?'host' as const:'client' as const},wrong=await CommunityAccessReply.verify(signed('ticket',body.ticketId,at,altered),point(issuer.publicKey),body.ticketId);
    expect(()=>CommunityRelayTicket.fromReply(wrong,{...expected,role:altered.role})).toThrow('INVALID_TICKET');
  }
  const at=Date.now(),body:CommunityRelayTicketBody={version:1,ticketId:randomUUID(),communityId:randomUUID(),enrollmentId:randomUUID(),deviceId:randomUUID(),deviceKind:'mobile',connectionId:randomUUID(),
    publicKey:point(operation.publicKey),purpose:'agent',role:'client',sessionId:randomUUID(),revision:1,issuedAt:at,expiresAt:at+30_000,leaseExpiresAt:at+90_000};
  const reply=await CommunityAccessReply.verify(signed('ticket',body.ticketId,at,body),point(issuer.publicKey),body.ticketId);
  expect(()=>CommunityRelayTicket.fromReply(reply,body)).toThrow('INVALID_TICKET');
});
