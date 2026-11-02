// Process fixture for native XCTest. No production endpoints, credentials, Keychain, TCC, capture or input.
import {Miniflare, Log, LogLevel} from 'miniflare';
import {generateKeyPairSync, randomBytes, randomUUID, sign} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CommunityAccessClient} from '../../../src/communityAccessClient.ts';

const keys = () => generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
const point = key => { const p = key.export({format: 'jwk'}); return Buffer.concat([Buffer.from([4]), Buffer.from(p.x, 'base64url'), Buffer.from(p.y, 'base64url')]).toString('base64url'); };
const signature = (key, bytes) => sign('sha256', bytes, {key, dsaEncoding: 'ieee-p1363'}).toString('base64url');
const issuer = keys(), profile = randomUUID();
const devices = Array.from({length: 4}, (_, i) => ({id: randomUUID(), kind: i === 3 ? 'mobile' : 'desktop', host: keys(), viewer: keys(), operation: keys(), session: i === 3 ? keys() : null}));
const [admin] = devices, temporary = await mkdtemp(join(tmpdir(), 'native-community-wss-'));
let worker, server;
async function close() { server?.stop(true); await worker?.dispose(); await rm(temporary, {recursive: true, force: true}); }
try {
  const bundle = await Bun.build({entrypoints: [new URL('../src/worker.ts', import.meta.url).pathname], target: 'browser',
    external: ['cloudflare:workers', 'node:*'], outdir: temporary});
  if (!bundle.success) throw new Error('Fixture worker did not build');
  worker = new Miniflare({cf: false, scriptPath: join(temporary, 'worker.js'), modules: true, modulesRoot: temporary,
    compatibilityDate: '2026-07-29', compatibilityFlags: ['nodejs_compat'], port: 0, host: '127.0.0.1', log: new Log(LogLevel.ERROR),
    durableObjects: {REGISTRY: {className: 'ScreenCommunityRegistry', useSQLite: true}, RELAY: {className: 'CommunityRelayHub', useSQLite: true}},
    outboundService: async () => { throw new Error('Fixture denied outbound networking'); },
    bindings: {COMMUNITY_ISSUER_JWK: JSON.stringify(issuer.privateKey.export({format: 'jwk'})), COMMUNITY_STATE_KEY: randomBytes(32).toString('base64url'),
      COMMUNITY_BOOTSTRAP_HOST: point(admin.host.publicKey), COMMUNITY_BOOTSTRAP_VIEWER: point(admin.viewer.publicKey), COMMUNITY_BOOTSTRAP_PROFILE: profile}});
  const req = (operation, args, actor = null) => ({operation, args, actor, requestId: randomUUID(), observedAt: Date.now(), nonce: randomBytes(32).toString('base64url')});
  const client = key => new CommunityAccessClient('https://fixture.workers.dev', point(issuer.publicKey), {publicKey: point(key.publicKey),
    signAccessRequest: async r => {
      const bytes = Buffer.from(JSON.stringify([2, r.operation, r.requestId, r.observedAt, r.nonce, r.actor, r.args]));
      return {payload: bytes.toString('base64url'), signature: signature(key.privateKey, Buffer.concat([Buffer.from('agentstoz.community-access.request/v2\0'), bytes]))};
    }}, (url, options) => worker.dispatchFetch(url, options));
  const bytes = Buffer.from(JSON.stringify([1, 'bootstrap', randomUUID(), Date.now(), randomBytes(32).toString('base64url'), null,
    [profile, admin.id, 'Fixture A', point(admin.host.publicKey), point(admin.viewer.publicKey), 'control', 'Isolated native fixture']]));
  const input = Buffer.concat([Buffer.from('agentstoz.screen-community.request/v1\0'), bytes]);
  const bootstrap = await worker.dispatchFetch('https://fixture.workers.dev/v1', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({payload: bytes.toString('base64url'), signature: signature(admin.viewer.privateKey, input), hostSignature: signature(admin.host.privateKey, input)})});
  const boot = JSON.parse(Buffer.from((await bootstrap.json()).payload, 'base64url')), community = boot[4], administrator = boot[6];
  if (boot[1] !== 'member') throw new Error('Fixture bootstrap refused');
  for (const [index, device] of devices.entries()) {
    const plan = {version: 1, profileId: profile, deviceId: device.id, name: `Native fixture ${index}`, kind: device.kind, hostKey: point(device.host.publicKey),
      biometricKey: point(device.viewer.publicKey), operationKey: point(device.operation.publicKey), controlKey: null, agentDeviceId: null,
      capabilities: device.kind === 'mobile' ? ['screen.view', 'screen.control'] : ['screen.view', 'screen.control', 'screen.receive.view', 'screen.receive.control']};
    const prepared = await client(device.host).exchange(req('prepare', [plan]));
    const review = await client(admin.host).exchange(req('review', [community, prepared.payload.planId], administrator));
    const auth = await client(admin.viewer).exchange(req('approve', [community, prepared.payload.planId, review.payload.digest, review.payload.challenge, review.payload.revision], administrator));
    device.enrollment = auth.payload.enrollmentId;
    if (device.kind === 'mobile') {
      const use = await client(device.viewer).exchange(req('session-open', [community, point(device.session.publicKey), plan.capabilities], device.enrollment));
      device.sessionId = use.payload.sessionId;
    }
  }
  server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/ticket' || (await request.clone().text()).length > 1024) return new Response(null, {status: 404});
    try {
      const body = await request.json(), device = devices.find(d => d.id === body.deviceId), host = body.role === 'host';
      if (!device || !['host', 'client'].includes(body.role) || !/^[a-f0-9-]{36}$/.test(body.connectionId)) throw new Error('Bad fixture request');
      if (host && device.kind === 'mobile') throw new Error('Mobile fixture cannot host');
      const key = host ? device.host : device.operation;
      const auth = await client(key).exchange(req(host ? 'receiver-status' : 'authorization', [community], device.enrollment));
      const use = device.session ? await client(device.session).exchange(req('session-status', [community, device.sessionId], device.enrollment)) : null;
      const ticket = await client(device.session ?? key).exchange(req(host ? 'receiver-ticket' : 'relay-ticket', host ? [community, body.connectionId]
        : [community, 'screen', body.connectionId, 'client', device.sessionId ?? null], device.enrollment));
      return Response.json({authorization: auth.envelope, ticket: ticket.envelope, session: use?.envelope ?? null});
    } catch { return Response.json({error: 'FIXTURE_TICKET_REFUSED'}, {status: 400}); }
  }});
  const address = await worker.ready;
  // Software fixture private keys are sent only through the parent test's private stdout pipe, never logged or persisted.
  console.log(JSON.stringify({origin: 'https://fixture.workers.dev', issuer: point(issuer.publicKey), profile, community,
    websocket: `${String(address).replace(/^http:/, 'ws:').replace(/\/$/, '')}/relay`, ticketURL: `${server.url}ticket`,
    devices: devices.map(d => ({id: d.id, kind: d.kind, enrollment: d.enrollment, hostPublicKey: point(d.host.publicKey), operationPublicKey: point(d.operation.publicKey),
      sessionID: d.sessionId ?? null, sessionPublicKey: d.session ? point(d.session.publicKey) : null, sessionPrivateDER: d.session?.privateKey.export({format: 'der', type: 'pkcs8'}).toString('base64') ?? null,
      hostPrivateDER: d.host.privateKey.export({format: 'der', type: 'pkcs8'}).toString('base64'), operationPrivateDER: d.operation.privateKey.export({format: 'der', type: 'pkcs8'}).toString('base64')}))}));
  process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
  process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
} catch (error) { await close(); throw error; }
