// Actual workerd + SQLite + WebSockets. Ephemeral software keys and loopback only; every outbound request is refused.
import {Miniflare, Log, LogLevel} from 'miniflare';
import {generateKeyPairSync, randomBytes, randomUUID, sign, verify} from 'node:crypto';
import {strict as assert} from 'node:assert';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CommunityAccessClient, CommunityAccessReply, CommunityRelayTicket} from '../../../src/communityAccessClient.ts';
import {CommunityRelayClient} from '../../../src/communityRelayClient.ts';
import {CommunityComponentAuthorization,communityComponentHandshakeBytes} from '../../../src/communityComponentIdentity.ts';
import {AuthenticatedCommunityTransport} from '../../../src/authenticatedCommunityTransport.ts';

const pair = () => generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
const point = key => { const k = key.export({format: 'jwk'}); return Buffer.concat([Buffer.from([4]), Buffer.from(k.x, 'base64url'), Buffer.from(k.y, 'base64url')]).toString('base64url'); };
const signature = (key, bytes) => sign('sha256', bytes, {key, dsaEncoding: 'ieee-p1363'});
const person = () => ({id: randomUUID(), host: pair(), viewer: pair(), operation: pair(), control: pair()});
const issuer = pair(), admin = person(), joining = person(), third = person(), profile = randomUUID();
const caps = ['screen.view', 'screen.control', 'screen.receive.view', 'screen.receive.control', 'agent.communicate', 'teams.run', 'computer-use.agent-settings', 'computer-use.browser'];
const temporary = await mkdtemp(join(tmpdir(), 'community-access-workerd-'));
const connections = [], relays = [], controllers=[]; let worker, outbound = 0;
try {
  const build = await Bun.build({entrypoints: [new URL('../src/worker.ts', import.meta.url).pathname], target: 'browser',
    external: ['cloudflare:workers', 'node:*'], outdir: temporary});
  assert(build.success);
  worker = new Miniflare({cf: false, scriptPath: join(temporary, 'worker.js'), modules: true, modulesRoot: temporary,
    compatibilityDate: '2026-07-29', compatibilityFlags: ['nodejs_compat'], port: 0, host: '127.0.0.1', log: new Log(LogLevel.ERROR),
    durableObjects: {REGISTRY: {className: 'ScreenCommunityRegistry', useSQLite: true}, RELAY: {className: 'CommunityRelayHub', useSQLite: true}},
    outboundService: async () => { ++outbound; throw new Error('Outbound networking prohibited'); },
    bindings: {COMMUNITY_ISSUER_JWK: JSON.stringify(issuer.privateKey.export({format: 'jwk'})), COMMUNITY_STATE_KEY: randomBytes(32).toString('base64url'),
      COMMUNITY_BOOTSTRAP_HOST: point(admin.host.publicKey), COMMUNITY_BOOTSTRAP_VIEWER: point(admin.viewer.publicKey), COMMUNITY_BOOTSTRAP_PROFILE: profile}});
  const v1bytes = Buffer.from(JSON.stringify([1, 'bootstrap', randomUUID(), Date.now(), randomBytes(32).toString('base64url'), null,
    [profile, admin.id, 'Mac 3 fixture', point(admin.host.publicKey), point(admin.viewer.publicKey), 'control', 'AgentsToZ fixture']]));
  const v1input = Buffer.concat([Buffer.from('agentstoz.screen-community.request/v1\0'), v1bytes]);
  const bootstrap = await worker.dispatchFetch('https://community.test/v1', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({payload: v1bytes.toString('base64url'), signature: signature(admin.viewer.privateKey, v1input).toString('base64url'), hostSignature: signature(admin.host.privateKey, v1input).toString('base64url')})});
  const legacy = await bootstrap.json(), bootBytes = Buffer.from(legacy.payload, 'base64url');
  assert(verify('sha256', Buffer.concat([Buffer.from('agentstoz.screen-community.response/v1\0'), bootBytes]), {key: issuer.publicKey, dsaEncoding: 'ieee-p1363'}, Buffer.from(legacy.signature, 'base64url')));
  const boot = JSON.parse(bootBytes); assert.equal(boot[1], 'member'); const community = boot[4], administrator = boot[6];
  const fetcher = (url, options) => worker.dispatchFetch(url, options);
  function client(key) { return new CommunityAccessClient('https://community.test', point(issuer.publicKey), {
    publicKey: point(key.publicKey), signAccessRequest: async r => {
      const bytes = Buffer.from(JSON.stringify([2, r.operation, r.requestId, r.observedAt, r.nonce, r.actor, r.args]));
      return {payload: bytes.toString('base64url'), signature: signature(key.privateKey, Buffer.concat([Buffer.from('agentstoz.community-access.request/v2\0'), bytes])).toString('base64url')};
    }}, fetcher); }
  const request = (operation, args, actor = null) => ({operation, args, actor, requestId: randomUUID(), observedAt: Date.now(), nonce: randomBytes(32).toString('base64url')});
  async function enroll(p, name, kind = 'desktop') {
    const plan = {version: 1, profileId: profile, deviceId: p.id, name, kind, hostKey: point(p.host.publicKey), biometricKey: point(p.viewer.publicKey), operationKey: point(p.operation.publicKey), controlKey: kind==='mobile'?null:point(p.control.publicKey), agentDeviceId: kind==='mobile'?null:randomUUID(), capabilities: kind==='mobile'?caps.filter(c=>!c.startsWith('screen.receive.')):caps};
    const prepared = await client(p.host).exchange(request('prepare', [plan])); assert.equal(prepared.kind, 'prepared');
    const review = await client(admin.host).exchange(request('review', [community, prepared.payload.planId], administrator));
    const approval = request('approve', [community, prepared.payload.planId, review.payload.digest, review.payload.challenge, review.payload.revision], administrator);
    const auth = await client(admin.viewer).exchange(approval); assert.equal(auth.kind, 'authorization'); p.authorization = auth.payload;
    const status = await client(p.host).exchange(request('status', [prepared.payload.planId])); assert.equal(status.payload.enrollmentId, auth.payload.enrollmentId);
    assert.deepEqual(status.payload.capabilities, auth.payload.capabilities);
  }
  await enroll(admin, 'Mac 3 fixture'); await enroll(joining, 'Mac 1 fixture'); await enroll(third, 'Mac 2 fixture');
  async function ticket(p, purpose = 'screen', role = 'client', connectionId = randomUUID()) {
    const host = purpose === 'screen' && role === 'host', component = purpose !== 'screen', key = host ? p.host : component ? p.control : p.operation;
    const reply = await client(key).exchange(request(host ? 'receiver-ticket' : component ? 'component-ticket' : 'relay-ticket', host ? [community, connectionId] : component ? [community, purpose, connectionId, role] : [community, purpose, connectionId, role, null], p.authorization.enrollmentId));
    return CommunityRelayTicket.fromReply(reply, {communityId: community, enrollmentId: p.authorization.enrollmentId, deviceId: p.id,
      connectionId, publicKey: point(key.publicKey), purpose, role, sessionId: null});
  }
  function channel(ws) {
    const messages = [], waiters = []; let closed;
    ws.addEventListener('message', event => { const frame = JSON.parse(event.data); if (frame.type === 'peer-ended') return; if (waiters.length) waiters.shift().resolve(frame); else messages.push(frame); });
    ws.addEventListener('close', event => { closed = event.code; for (const waiter of waiters.splice(0)) waiter.reject(new Error(`Socket closed ${event.code}`)); });
    const next = (ms = 1500) => messages.length ? Promise.resolve(messages.shift()) : closed ? Promise.reject(new Error(`Socket closed ${closed}`)) : new Promise((resolve, reject) => {
      const pending = {resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); }};
      const timer = setTimeout(() => { const i = waiters.indexOf(pending); if (i >= 0) waiters.splice(i, 1); reject(new Error('Frame timeout')); }, ms); waiters.push(pending);
    });
    return {ws, next, get closed() { return closed; }};
  }
  async function open(t) {
    const r = await worker.dispatchFetch('https://community.test/relay', {headers: {Upgrade: 'websocket', Authorization: `AgentsToZ ${t.envelope.payload}.${t.envelope.signature}`}});
    assert.equal(r.status, 101, `upgrade status: ${r.status}`); const c = channel(r.webSocket); r.webSocket.accept(); connections.push(c); return c;
  }
  async function prove(c, t, key) {
    const challenge = await c.next(); assert.equal(challenge.type, 'challenge');
    const bytes = Buffer.from(JSON.stringify(['agentstoz.relay.bind/v2', t.body.ticketId, t.body.connectionId, challenge.challenge]));
    c.ws.send(JSON.stringify({type: 'proof', signature: signature(key.privateKey, bytes).toString('base64url')}));
    const ready = await c.next(); assert.equal(ready.type, 'ready'); return c;
  }
  const hostTicket = await ticket(joining, 'screen', 'host'), host = await prove(await open(hostTicket), hostTicket, joining.host);
  const senderTicket = await ticket(admin), sender = await prove(await open(senderTicket), senderTicket, admin.operation);
  const send = async (source, destination, text = 'opaque encrypted fixture') => {
    const id = randomUUID(), ciphertext = Buffer.from(text).toString('base64url'); source.ws.send(JSON.stringify({type: 'data', to: destination, id, ciphertext}));
    const ack = await source.next(); assert.deepEqual(ack, {type: 'forwarded', id, reachable: destination === joining.id}); return {id, ciphertext};
  };
  const first = await send(sender, joining.id); const received = await host.next();
  assert.deepEqual(received, {type: 'data', from: admin.id, fromConnection: senderTicket.body.connectionId, ...first});
  assert.equal((await worker.dispatchFetch('https://community.test/internal/relay-admission', {method: 'POST'})).status, 404, 'private admission is not public');
  const replay = await worker.dispatchFetch('https://community.test/relay', {headers: {Upgrade: 'websocket', Authorization: `AgentsToZ ${senderTicket.envelope.payload}.${senderTicket.envelope.signature}`}});
  assert.equal(replay.status, 403, 'a ticket is single-use');
  const stolenTicket = await ticket(admin), thief = await open(stolenTicket); await thief.next();
  thief.ws.send(JSON.stringify({type: 'proof', signature: randomBytes(64).toString('base64url')}));
  await assert.rejects(thief.next(), /closed 4003/); assert.equal(sender.closed, undefined, 'an intercepted ticket cannot evict the legitimate peer');
  const afterTheft = await send(sender, joining.id); assert.equal((await host.next()).id, afterTheft.id);
  const sameRoleTicket = await ticket(third), sameRole = await prove(await open(sameRoleTicket), sameRoleTicket, third.operation);
  const isolatedId = randomUUID(); sender.ws.send(JSON.stringify({type: 'data', to: third.id, id: isolatedId, ciphertext: Buffer.from('no same-role screen path').toString('base64url')}));
  assert.deepEqual(await sender.next(), {type: 'forwarded', id: isolatedId, reachable: false});
  const agentTicket = await ticket(third, 'agent', 'host'), agent = await prove(await open(agentTicket), agentTicket, third.control);
  await send(sender, third.id); // Same device, different purpose cannot receive a screen record.
  const renew = await ticket(admin, 'screen', 'client', senderTicket.body.connectionId);
  sender.ws.send(JSON.stringify({type: 'authorize', ticket: renew.envelope})); assert.equal((await sender.next()).type, 'authorized');
  const wrongPurpose = await ticket(admin, 'agent', 'client', senderTicket.body.connectionId);
  sender.ws.send(JSON.stringify({type: 'authorize', ticket: wrongPurpose.envelope})); await assert.rejects(sender.next(), /closed 4003/);
  const replacement = await ticket(third); const other = await prove(await open(replacement), replacement, third.operation);
  await assert.rejects(sameRole.next(), /closed 4001/); // Same bound identity replacement after proof only.
  other.ws.send(JSON.stringify({type: 'data', to: joining.id, id: randomUUID(), ciphertext: 'A'.repeat(262_144)}));
  await assert.rejects(other.next(), /closed 4003/, 'wire size is bounded including its JSON envelope');
  const expiredBody = {...hostTicket.body, ticketId: randomUUID(), issuedAt: Date.now() - 2000, expiresAt: Date.now() - 1, leaseExpiresAt: Date.now() + 500};
  function signTicket(body) { const bytes = Buffer.from(JSON.stringify([2, 'ticket', body.ticketId, body.issuedAt, body])); return {body, envelope: {payload: bytes.toString('base64url'), signature: signature(issuer.privateKey, Buffer.concat([Buffer.from('agentstoz.community-access.response/v2\0'), bytes])).toString('base64url')}}; }
  const expired = signTicket(expiredBody);
  assert.equal((await worker.dispatchFetch('https://community.test/relay', {headers: {Upgrade: 'websocket', Authorization: `AgentsToZ ${expired.envelope.payload}.${expired.envelope.signature}`}})).status, 403);
  const foreign = signTicket({...hostTicket.body, ticketId: randomUUID(), communityId: randomUUID(), issuedAt: Date.now(), expiresAt: Date.now() + 1000, leaseExpiresAt: Date.now() + 1000});
  assert.equal((await worker.dispatchFetch('https://community.test/relay', {headers: {Upgrade: 'websocket', Authorization: `AgentsToZ ${foreign.envelope.payload}.${foreign.envelope.signature}`}})).status, 403, 'a signed ticket still rechecks its actual community membership');
  const short = signTicket({...agentTicket.body, ticketId: randomUUID(), connectionId: randomUUID(), issuedAt: Date.now(), expiresAt: Date.now() + 500, leaseExpiresAt: Date.now() + 500});
  const shortConnection = await prove(await open(short), short, third.control); await assert.rejects(shortConnection.next(2500), /closed 4003/, 'actual DO alarm closes expired leases');
  // SDK uses the same actual Worker transport; record bytes remain opaque and peer crypto is outside this harness.
  const records = [], adapter = {open: async ({url, authorization, onMessage, onClose}) => {
    const response = await worker.dispatchFetch(url.replace(/^wss:/, 'https:'), {headers: {Upgrade: 'websocket', Authorization: authorization}});
    assert.equal(response.status, 101); const ws = response.webSocket;
    ws.addEventListener('message', e => onMessage(e.data)); ws.addEventListener('close', onClose); ws.accept();
    return {send: text => ws.send(text), close: (code, reason) => ws.close(code, reason), bufferedAmount: 0};
  }};
  const sdk = new CommunityRelayClient('https://community.test', {communityId: community, enrollmentId: admin.authorization.enrollmentId,
    deviceId: admin.id, purpose: 'screen', role: 'client', sessionId: null}, {publicKey: point(admin.operation.publicKey),
      signRelayProof: async input => signature(admin.operation.privateKey, Buffer.from(JSON.stringify(['agentstoz.relay.bind/v2', input.ticketId, input.connectionId, input.challenge])))},
    id => ticket(admin, 'screen', 'client', id), adapter, record => records.push(record)); relays.push(sdk);
  await sdk.connect(); const sdkId = randomUUID(), sdkCipher = Buffer.from('opaque SDK record').toString('base64url');
  const delivered = await sdk.sendRecord({to: joining.id, id: sdkId, ciphertext: sdkCipher});
  assert.deepEqual(delivered, {stage: 'forwarded', reachable: true, requestId: sdkId}); assert.equal((await host.next()).id, sdkId);
  await assert.rejects(sdk.sendRecord({to: joining.id, id: sdkId, ciphertext: sdkCipher}), /INVALID_RECORD/, 'IDs cannot be reused within a connection');
  sdk.close();
  // Actual control carrier above the same workerd sockets. Native signing is an explicit software-key stand-in.
  const identity = p => ({
    context:async()=>({communityId:community,profileId:profile,enrollmentId:p.authorization.enrollmentId,deviceId:p.id,agentDeviceId:p.authorization.agentDeviceId,publicKey:point(p.control.publicKey)}),
    relayOrigin:async()=>'https://community.test',
    currentAuthorization:async purpose=>{const r=await client(p.control).exchange(request('component-status',[community],p.authorization.enrollmentId));return CommunityComponentAuthorization.fromReply(r,profile,p.id);},
    directory:async purpose=>{const r=await client(p.control).exchange(request('component-directory',[community],p.authorization.enrollmentId));return Promise.all(r.payload.map(body=>CommunityComponentAuthorization.fromReply(r,profile,body.deviceId)));},
    verifyAuthorization:async(envelope,deviceId)=>{const fields=JSON.parse(Buffer.from(envelope.payload,'base64url').toString());return CommunityComponentAuthorization.fromReply(await CommunityAccessReply.verify(envelope,point(issuer.publicKey),fields[2]),profile,deviceId);},
    ticket:(purpose,connection,role)=>ticket(p,purpose,role,connection),
    signRelayProof:async(purpose,t,challenge)=>signature(p.control.privateKey,Buffer.from(JSON.stringify(['agentstoz.relay.bind/v2',t.body.ticketId,t.body.connectionId,challenge]))),
    signHandshake:async(purpose,role,t,own,peer)=>{
      assert.equal(own.body.controlKey,point(p.control.publicKey));assert.equal(t[`${role}DeviceId`],p.id);assert.equal(t[`${role}AgentDeviceId`],p.authorization.agentDeviceId);
      assert(own.permits(purpose)&&peer.permits(purpose));return signature(p.control.privateKey,communityComponentHandshakeBytes(t,role));
    },
  });
  const endpoints=[randomUUID(),randomUUID()],members=[admin,joining].map((p,i)=>({endpointId:endpoints[i],deviceId:p.authorization.agentDeviceId,name:'Software fixture'}));
  const firstControl=new AuthenticatedCommunityTransport(join(temporary,'control-a'),identity(admin),adapter);
  const secondControl=new AuthenticatedCommunityTransport(join(temporary,'control-b'),identity(joining),adapter);controllers.push(firstControl,secondControl);
  for(const [p,c,index]of [[admin,firstControl,0],[joining,secondControl,1]])c.bindMembership(async()=>({profileId:profile,deviceId:p.authorization.agentDeviceId,sourceEndpointId:endpoints[index],localEndpointIds:[endpoints[index]],members}));
  const call=(p,c,op,args)=>c.rpc(op,profile,p.authorization.agentDeviceId,'f'.repeat(64),args);
  await call(joining,secondControl,'control-inbox',{});
  const original=randomUUID(),sent=await call(admin,firstControl,'control-send',{sourceEndpointId:endpoints[0],targetEndpointId:endpoints[1],request:{kind:'ops-request',operation:'status',requestId:original}});
  const wait=async(read,predicate)=>{const until=Date.now()+8000;for(;;){const value=await read();if(predicate(value))return value;assert(Date.now()<until,'actual authenticated control deadline');await new Promise(resolve=>setTimeout(resolve,40));}};
  const inbox=await wait(()=>call(joining,secondControl,'control-inbox',{}),v=>v.controls.length===1);
  assert.equal(inbox.controls[0].request.requestId,original);assert.equal(inbox.controls[0].fromDeviceId,admin.authorization.agentDeviceId);
  const answer={ok:true,body:{requestId:original,synthetic:'x'.repeat(180_000)}};
  assert.equal((await call(joining,secondControl,'control-respond',{controlId:sent.controlId,response:answer})).responded,true);
  const result=await wait(()=>call(admin,firstControl,'control-result',{sourceEndpointId:endpoints[0],controlIds:[sent.controlId]}),v=>v.results.length===1);
  assert.deepEqual(result.results[0],{controlId:sent.controlId,response:answer});assert.deepEqual((await call(joining,secondControl,'control-inbox',{})).controls,[]);
  // Mobile control-v2 aliases share the existing biometric episode, never a fake desktop/portal identity.
  const mobile=person();mobile.session=pair();await enroll(mobile,'iPad software fixture','mobile');
  assert.equal(mobile.authorization.agentDeviceId,null);assert.equal(mobile.authorization.controlKey,null);
  const opened=await client(mobile.viewer).exchange(request('session-open',[community,point(mobile.session.publicKey),mobile.authorization.capabilities],mobile.authorization.enrollmentId));
  assert.equal(opened.kind,'session');const sessionId=opened.payload.sessionId;
  const mobileTicket=async(purpose,session=sessionId,key=mobile.session,connectionId=randomUUID())=>{
    const reply=await client(key).exchange(request('relay-ticket',[community,purpose,connectionId,'client',session],mobile.authorization.enrollmentId));
    return CommunityRelayTicket.fromReply(reply,{communityId:community,enrollmentId:mobile.authorization.enrollmentId,deviceId:mobile.id,connectionId,publicKey:point(key.publicKey),purpose,role:'client',sessionId:session});
  };
  const legacyHostTicket=await ticket(joining,'agent','host'),legacyHost=await prove(await open(legacyHostTicket),legacyHostTicket,joining.control);
  const aliases=['mobile-agent','mobile-teams','mobile-agent-settings','mobile-browser'],mobilePeers=[];
  for(const purpose of aliases){
    const checked=await client(joining.control).exchange(request('component-session',[community,purpose,mobile.authorization.enrollmentId,sessionId],joining.authorization.enrollmentId));
    assert.equal(checked.kind,'session');assert.equal(checked.payload.sessionId,sessionId);assert.equal(checked.payload.publicKey,point(mobile.session.publicKey));
    const receiverTicket=await ticket(joining,purpose,'host'),receiver=await prove(await open(receiverTicket),receiverTicket,joining.control);
    const sourceTicket=await mobileTicket(purpose),source=await prove(await open(sourceTicket),sourceTicket,mobile.session);mobilePeers.push({source,receiver,sourceTicket});
    const id=randomUUID(),ciphertext=Buffer.from('opaque mobile control-v2 '+purpose).toString('base64url');source.ws.send(JSON.stringify({type:'data',to:joining.id,id,ciphertext}));
    assert.deepEqual(await source.next(),{type:'forwarded',id,reachable:true});assert.deepEqual(await receiver.next(),{type:'data',from:mobile.id,fromConnection:sourceTicket.body.connectionId,id,ciphertext});
    assert.equal(legacyHost.closed,undefined,'mobile alias cannot evict the same desktop legacy host socket');
    await assert.rejects(client(joining.control).exchange(request('component-ticket',[community,purpose,randomUUID(),'client'],joining.authorization.enrollmentId)),/INVALID_TICKET_ROLE/);
  }
  for(const {source,receiver}of mobilePeers){
    const id=randomUUID(),ciphertext=Buffer.from('alias isolation probe').toString('base64url');source.ws.send(JSON.stringify({type:'data',to:joining.id,id,ciphertext}));
    assert.equal((await source.next()).id,id);assert.equal((await receiver.next()).id,id,'other mobile purposes did not queue a record on this alias');
  }
  const otherHostSession=await client(third.control).exchange(request('component-session',[community,'mobile-agent',mobile.authorization.enrollmentId,sessionId],third.authorization.enrollmentId));
  assert.equal(otherHostSession.payload.sessionId,sessionId,'switching desktop host uses the same mobile episode without another biometric proof');
  const legacyClientTicket=await ticket(third,'agent','client'),legacyClient=await prove(await open(legacyClientTicket),legacyClientTicket,third.control),legacyId=randomUUID();
  legacyClient.ws.send(JSON.stringify({type:'data',to:joining.id,id:legacyId,ciphertext:Buffer.from('legacy desktop carrier still works').toString('base64url')}));
  assert.equal((await legacyClient.next()).reachable,true);assert.equal((await legacyHost.next()).id,legacyId,'legacy host received no mobile alias records');
  for(const purpose of ['agent','teams','agent-settings','browser'])await assert.rejects(mobileTicket(purpose),/INVALID_TICKET_ROLE/);
  const stolenMobileTicket=await mobileTicket('mobile-agent'),mobileThief=await open(stolenMobileTicket);await mobileThief.next();
  mobileThief.ws.send(JSON.stringify({type:'proof',signature:randomBytes(64).toString('base64url')}));await assert.rejects(mobileThief.next(),/closed 4003/);
  assert.equal(mobilePeers[0].source.closed,undefined,'ticket theft cannot evict the authenticated mobile alias');
  const wrongMobilePurpose=await mobileTicket('mobile-teams',sessionId,mobile.session,mobilePeers[0].sourceTicket.body.connectionId);
  mobilePeers[0].source.ws.send(JSON.stringify({type:'authorize',ticket:wrongMobilePurpose.envelope}));
  await assert.rejects(mobilePeers[0].source.next(),/closed 4003/,'a mobile connection cannot renew into another control-v2 purpose');
  const staleMobileTicket=await mobileTicket('mobile-browser'),newSession=pair();
  const replacementSession=await client(mobile.viewer).exchange(request('session-open',[community,point(newSession.publicKey),mobile.authorization.capabilities],mobile.authorization.enrollmentId));
  await assert.rejects(client(joining.control).exchange(request('component-session',[community,'mobile-agent',mobile.authorization.enrollmentId,sessionId],joining.authorization.enrollmentId)),/SESSION_EXPIRED/);
  assert.equal((await worker.dispatchFetch('https://community.test/relay',{headers:{Upgrade:'websocket',Authorization:`AgentsToZ ${staleMobileTicket.envelope.payload}.${staleMobileTicket.envelope.signature}`}})).status,403,'stale mobile episode is refused on actual admission');
  const fresh=await client(joining.control).exchange(request('component-session',[community,'mobile-browser',mobile.authorization.enrollmentId,replacementSession.payload.sessionId],joining.authorization.enrollmentId));assert.equal(fresh.kind,'session');
  await client(newSession).exchange(request('session-close',[community,replacementSession.payload.sessionId],mobile.authorization.enrollmentId));
  await assert.rejects(client(joining.control).exchange(request('component-session',[community,'mobile-browser',mobile.authorization.enrollmentId,replacementSession.payload.sessionId],joining.authorization.enrollmentId)),/SESSION_EXPIRED/);
  assert.equal(outbound, 0);
  console.log('PASS: workerd/SQLite v2 approvals; pinned SDK; actual WS proof/single-use/stolen-ticket/role/purpose/community/renewal/size/expiry-alarm/replacement; authenticated agent AEAD control+180KB reply and original target receipt; mobile four-purpose aliases/controlKey episode lookup/no legacy collision/session replacement and closure; routing ACK only; outbound=0');
} finally {
  for(const c of controllers)c.close();for (const relay of relays) relay.close(); for (const c of connections) try { c.ws.close(1000); } catch {}
  await worker?.dispose(); await rm(temporary, {recursive: true, force: true});
}
