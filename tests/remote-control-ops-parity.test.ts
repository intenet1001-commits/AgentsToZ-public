import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  RemoteControlCore,
  parseRemoteControlClientMessage,
  type RemoteControlActionRequest,
  type RemoteControlOpsAction,
} from '../src/remoteControlCore';
import {normalizeQrRemoteControlOpsCandidates,normalizeQrRemoteControlOpsStatus} from '../src/qrRemoteControlContract';

function pairingToken(url: string): string {
  return new URLSearchParams(new URL(url).hash.slice(1)).get('pair') ?? '';
}

function request(sessionToken: string, action: 'ops.status' | 'ops.open' | 'ops.memory.pending', confirmed?: boolean): RemoteControlActionRequest {
  return {
    type: 'action.request', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    sessionToken, actionId: `${action}-${confirmed ? 'confirmed' : 'read'}`, action,
    ...(confirmed === undefined ? {} : {remoteConfirmed: confirmed}),
  };
}

test('remote OPS status and open reuse one authenticated host contract without project IDs or paths', async () => {
  const executed: RemoteControlOpsAction[] = [];
  const core = new RemoteControlCore({
    listRegisteredProjects: () => [],
    executeRegisteredProjectAction: () => undefined,
    readOpsStatus: () => ({
      state: 'ready', backend: 'control-folder', pendingCount: 2,
      lastSavedAt: '2026-09-20T00:00:00.000Z', syncState: 'current',
    }),
    executeOpsAction: action => { executed.push(action); },
  }, {hostName: 'OPS Mac'});
  const ready = await core.pair(pairingToken(core.enable('http://192.168.0.8:43123').pairingUrl));

  const status = await core.perform(request(ready.sessionToken, 'ops.status'));
  expect(status).toEqual({
    type: 'action.result', actionId: 'ops.status-read', ok: true,
    ops: {state: 'ready', backend: 'control-folder', pendingCount: 2, lastSavedAt: '2026-09-20T00:00:00.000Z', syncState: 'current'},
  });
  expect(JSON.stringify(status)).not.toContain('/Users/');
  expect(JSON.stringify(status)).not.toContain('memoryId');

  await expect(core.perform(request(ready.sessionToken, 'ops.open')))
    .rejects.toMatchObject({code: 'REMOTE_CONFIRMATION_REQUIRED'});
  const opened = await core.perform(request(ready.sessionToken, 'ops.open', true));
  expect(opened).toMatchObject({ok: true, ops: {state: 'ready', pendingCount: 2}});
  expect(executed).toHaveLength(1);
  expect(executed[0]).toMatchObject({action: 'ops.open', actionId: 'ops.open-confirmed'});
  expect(executed[0]!.authority.controllerId).toMatch(/^lan:[a-f0-9]{64}$/);
});

test('remote OPS messages are strict and their response normalizer rejects additive secrets', () => {
  const token = 'A'.repeat(43);
  expect(parseRemoteControlClientMessage(request(token, 'ops.status'))).toMatchObject({action: 'ops.status'});
  expect(parseRemoteControlClientMessage(request(token, 'ops.open', true))).toMatchObject({action: 'ops.open', remoteConfirmed: true});
  for (const extra of [{controlId: token}, {input: 'save it'}, {path: '/private'}, {remoteConfirmed: true}]) {
    expect(() => parseRemoteControlClientMessage({...request(token, 'ops.status'), ...extra})).toThrow();
  }
  expect(() => parseRemoteControlClientMessage({...request(token, 'ops.open', true), input: 'approve'})).toThrow();
  expect(normalizeQrRemoteControlOpsStatus({ops: {state: 'ready', backend: 'app-data', pendingCount: 0, lastSavedAt: null, syncState: 'not-configured'}}))
    .toMatchObject({state: 'ready', backend: 'app-data'});
  expect(() => normalizeQrRemoteControlOpsStatus({ops: {state: 'ready', backend: 'app-data', pendingCount: 0, lastSavedAt: null, syncState: null, memoryId: 'secret'}})).toThrow();
  const candidates={revision:'a'.repeat(64),candidates:[{id:'candidate-1',title:'원칙',body:'검증 후 보고',evidence:'사용자 요청',baseRevision:'a'.repeat(64),createdAt:'2026-09-20T00:00:00.000Z'}]};
  expect(normalizeQrRemoteControlOpsCandidates({opsCandidates:candidates})).toEqual(candidates);
  expect(()=>normalizeQrRemoteControlOpsCandidates({opsCandidates:{...candidates,path:'/private'}})).toThrow();
});

test('pending candidates are readable on either transport but shared review requires Internet SAS authority',async()=>{
  const reviews:any[]=[];const revision='a'.repeat(64),candidate={id:'candidate-1',title:'원칙',body:'검증 후 보고',evidence:'사용자 요청',baseRevision:revision,createdAt:'2026-09-20T00:00:00.000Z'};
  const core=new RemoteControlCore({listRegisteredProjects:()=>[],executeRegisteredProjectAction:()=>undefined,
    readOpsStatus:()=>({state:'ready',backend:'control-folder',pendingCount:1,lastSavedAt:null,syncState:'current'}),
    listOpsMemoryCandidates:()=>({revision,candidates:[candidate]}),reviewOpsMemoryCandidate:action=>{reviews.push(action);}}, {hostName:'OPS Mac'});
  const ready=await core.pair(pairingToken(core.enable('http://192.168.0.8:43123').pairingUrl));
  expect(await core.perform(request(ready.sessionToken,'ops.memory.pending'))).toMatchObject({ok:true,opsCandidates:{revision,candidates:[candidate]}});
  const review:RemoteControlActionRequest={type:'action.request',protocolVersion:REMOTE_CONTROL_PROTOCOL_VERSION,sessionToken:ready.sessionToken,actionId:'review-1',action:'ops.memory.review',remoteConfirmed:true,candidateId:candidate.id,expectedRevision:revision,accept:true};
  expect(await core.perform(review)).toMatchObject({ok:false,error:{code:'OPS_REVIEW_SAS_REQUIRED'}});expect(reviews).toHaveLength(0);
  expect(await core.perform({...review,actionId:'review-2'},{controllerId:'internet:approved-controller',expiresAt:'2026-10-01T00:00:00.000Z'})).toMatchObject({ok:true,ops:{pendingCount:1}});
  expect(reviews[0]).toMatchObject({candidateId:candidate.id,expectedRevision:revision,accept:true,authority:{controllerId:'internet:approved-controller'}});
  expect(()=>parseRemoteControlClientMessage({...review,expectedRevision:'bad'})).toThrow();
  expect(()=>parseRemoteControlClientMessage({...request(ready.sessionToken,'ops.memory.pending'),candidateId:candidate.id})).toThrow();
});

test('LAN and portal surfaces expose the same OPS labels and portal action wiring', () => {
  const lan = readFileSync(new URL('../src/remoteControlMobilePage.ts', import.meta.url), 'utf8');
  const portal = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
  for (const label of ['AgentsToZ OPS 열기', '운영기억 상태 확인', '저장 후보 확인']) {
    expect(lan).toContain(label);
    expect(portal).toContain(label);
  }
  expect(lan).toContain('sendAction("ops.open", "", true)');
  expect(lan).toContain('sendAction("ops.status", "", false)');
  expect(lan).toContain('sendAction("ops.memory.pending", "", false)');
  expect(portal).toContain("controller.sendAction('ops.open')");
  expect(portal).toContain("controller.sendAction('ops.status')");
  expect(portal).toContain("controller.sendAction('ops.memory.pending')");
  expect(portal).toContain("controller.sendAction('ops.memory.review'");
  expect(lan).not.toContain('sendAction("ops.memory.review"');
  expect(REMOTE_CONTROL_PROTOCOL_VERSION).toBe('agentstoz-local-v9');
});
