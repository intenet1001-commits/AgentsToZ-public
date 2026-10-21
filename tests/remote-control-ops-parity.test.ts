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

test('LAN and portal surfaces open the registered OPS project in Workroom and keep memory reads', () => {
  const lan = readFileSync(new URL('../src/remoteControlMobilePage.ts', import.meta.url), 'utf8');
  const portal = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
  const voicePanel = readFileSync(new URL('../src/VoiceSessionPanel.tsx', import.meta.url), 'utf8');
  for (const label of ['아젠투지(OPS) 워크룸 열기', '운영기억 상태 확인', '저장 후보 확인']) expect(lan).toContain(label);
  // The portal reads the status on its own and offers one review button only when candidates exist.
  for (const label of ['data-testid="remote-ops-status"', '개 검토', 'data-testid="remote-ops-review"']) expect(portal).toContain(label);
  // The portal opens OPS through the dock only — the OPS card no longer repeats it (VOC 2026-10-06).
  expect(portal).toContain('onOpenOpsWorkroom={()=>{void openOps();}}');
  expect(lan).toContain("candidate.role==='ops'");
  expect(lan).toContain('sendAction("ops.status", "", false)');
  expect(lan).toContain('sendAction("ops.memory.pending", "", false)');
  expect(portal).toContain("candidate.role==='ops'");
  expect(portal).toContain('role:p.role,kind:p.kind');
  expect(portal).toContain('openProjectWorkroom(project)');
  expect(portal).toContain("controller.sendAction('ops.status')");
  expect(portal).toContain("controller.sendAction('ops.memory.pending')");
  expect(portal).toContain("controller.sendAction('ops.memory.review'");
  expect(lan).not.toContain('sendAction("ops.memory.review"');
  // The phone picks OPS by the host role in one helper shared by the entry and the root voice host (VOC 2026-09-29).
  const remoteOpsEntry = voicePanel.slice(voicePanel.indexOf('export function remoteOpsVoiceProject'));
  expect(remoteOpsEntry).toContain('export function RemoteOpsVoiceEntry');
  expect(remoteOpsEntry).toContain("p.role==='ops'&&p.kind==='main'");
  expect(remoteOpsEntry).not.toContain('<select');
  expect(remoteOpsEntry).toContain('Mac에서 허용한 프로젝트 범위 안에서 아젠투지가 조회·지시합니다.');
  expect(REMOTE_CONTROL_PROTOCOL_VERSION).toBe('agentstoz-local-v9');
});

test('the phone voice dock lists every AgentsToZ, this Mac included (VOC 2026-10-05)', () => {
  const portal = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
  const dock = readFileSync(new URL('../src/components/AgentsToZVoiceDock.tsx', import.meta.url), 'utf8');
  // 「OPS 워크룸 열기 · <이 기기>」 줄은 `onOpenOpsWorkroom`이 있을 때만 그려진다. 폰이 그것을 넘기지
  // 않아서 2호·3호만 보이고 **연결한 1호만 빠져** 있었다 — 한 목록에 셋이 다 있어야 한다.
  expect(dock).toContain('opsDevices?.length?`OPS 워크룸 열기 · ');
  const usage = portal.slice(portal.indexOf('<AgentsToZVoiceDock'));
  expect(usage).toContain('onOpenOpsWorkroom=');
  expect(usage.indexOf('onOpenOpsWorkroom=')).toBeLessThan(usage.indexOf('/>'));
  // 기기 이름은 「<이름> / 아젠투지(OPS)」로 와서 줄이지 않으면 버튼 하나가 두 줄이 된다.
  expect(usage).toContain('communityDeviceLabel(device.name)');
});

test('the phone keeps one filled accent on screen — the dock (VOC 2026-10-05)', () => {
  const portal = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
  const opsCard = portal.slice(portal.indexOf('data-testid="remote-ops-controls"'), portal.indexOf('remote-ops-candidates'));
  // 도크(아젠투지 호출)가 이미 채운 액센트다. 같은 화면에 채운 버튼이 둘이면 서로 경쟁한다.
  expect(opsCard).not.toContain('remote-primary');
  // The card keeps only what no other place offers (memory review); voice and OPS Workroom are the dock's.
  expect(opsCard).not.toContain('워크룸 열기');
  expect(opsCard).not.toContain('RemoteOpsVoiceEntry');
});
