/**
 * 컴퓨터 유즈 패널의 도우미 연결 줄. Control이 status에 capture/click을 `operations`로 알리지 않으면 이전 빌드다:
 * 연결은 됐지만 창 화면 확인과 좌표 선택은 업데이트 전까지 실패하므로, 「연결됨」만 보여 주지 말고 그렇게 말한다.
 */
import {expect, test} from 'bun:test';
import {generateKeyPairSync, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ComputerUseHelperStatus, liveComputerUsePending} from '../src/ComputerUsePanel';
import {
  ComputerUseOutgoing, ComputerUseRemoteNotice, ComputerUseRemoteReceive, ComputerUseScopeForm, ComputerUseScopeGrants,
  computerUseOutgoingView, computerUseRemoteStateText, computerUseRemoteView, computerUseStandingWho, objectParticle,
} from '../src/ComputerUseScopeControls';
import {ComputerUseRecovery} from '../src/computerUseRecovery';
import {computerScopeApprovalBytes} from '../src/computerUseScopeApproval';
import {COMPUTER_USE_SCOPE_LIMITS, COMPUTER_USE_SCOPE_OPERATIONS, COMPUTER_USE_SCOPE_PERMISSIONS} from '../src/computerUseScopeProtocol';
import {ComputerUseRuntime, computerUseRemoteSettingsMemory, type ComputerUseRemoteLink, type ComputerUseRemoteSettingsStore} from '../src/computerUseRuntime';

const contract = JSON.parse(readFileSync(join(import.meta.dir, '..', 'native', 'computer-use', 'Tests', 'ControlContract', 'requests.json'), 'utf8'));
const currentStatus: Record<string, unknown> = contract.replies.status;
const {operations: _dropped, ...olderStatus} = currentStatus;
const render = (state: Record<string, any> | null, nativeState: Record<string, any> | null = null) =>
  renderToStaticMarkup(React.createElement(ComputerUseHelperStatus, {state, nativeState}));
const UPDATE = 'computer-use-control-update';

test('a Control that lists capture and click is connected with no update notice', () => {
  const html = render({native: currentStatus});
  expect(html).toContain('도우미 연결됨');
  expect(html).not.toContain(UPDATE);
});

test('a connected Control without operations predates capture/click and the person is told to update it', () => {
  const html = render({native: olderStatus});
  expect(html).toContain('도우미 연결됨');
  expect(html).toContain(`data-testid="${UPDATE}"`);
  expect(html).toContain('최신 버전으로 업데이트');
  expect(html).toContain('창 화면 확인과 좌표 선택');
  // What still works stays stated, so the notice is not read as the helper being down.
  expect(html).toContain('관찰·누르기·입력은 창별 승인과 손쉬운 사용 권한이 있으면 쓸 수 있습니다');
});

test('an operations list missing one of the two, or not a bounded array, is still an older Control', () => {
  for (const operations of [['capture', 'observe'], ['click'], 'capture,click', Array(40).fill('capture').concat('click')])
    expect(render({native: {...currentStatus, operations}})).toContain(UPDATE);
});

test('the update notice also shows while Accessibility is still missing, but never for an unreachable helper or a retired link', () => {
  const html = render({native: {...olderStatus, accessibility: false}});
  expect(html).toContain('손쉬운 사용 권한');
  expect(html).toContain(UPDATE);
  expect(render({native: {success: false, code: 'helper-unavailable'}})).not.toContain(UPDATE);
  expect(render({native: {success: false, code: 'signed-main-required'}})).toContain('최신 Mac 앱으로 업데이트');
  expect(render({restartRequired: true, native: olderStatus})).not.toContain(UPDATE);
  expect(render(null)).not.toContain(UPDATE);
});


test('connected does not imply screen consent or general canvas control', () => {
  const html = render({native: currentStatus});
  expect(html).toContain('computer-use-screen-consent');
  expect(html).toContain('화면 보기를 따로 허용');
  expect(html).toContain('Control의 화면 기록 권한');
  expect(html).toContain('캔버스의 임의 좌표 클릭·드래그·단축키 입력');
  expect(html).toContain('Hermes·Orca');
  expect(render({native: olderStatus})).not.toContain('computer-use-screen-consent');
});

test('a retired link cannot display ready from the last successful native status', () => {
  const html = render({restartRequired: true, native: currentStatus});
  expect(html).toContain('연결 다시 시작 필요');
  expect(html).not.toContain('도우미 연결됨');
});

test('a waiting request leaves the list at its expiry even when no newer status arrives', () => {
  const now = 1_000_000;
  const window = {approvalId: 'p1', expiresAt: now + 120_000}, scope = {approvalId: 'scope_p1', expiresAt: now + 1};
  expect(liveComputerUsePending([window, scope], now)).toEqual([window, scope]);
  // The server reaps at expiresAt; a failed or slow status read must not keep the row and its review button.
  expect(liveComputerUsePending([window, scope], now + 1)).toEqual([window]);
  expect(liveComputerUsePending([window, scope], now + 120_000)).toEqual([]);
  // A request without a numeric expiry is not guessed away: only Control's status removes it.
  const unknown: {approvalId: string; expiresAt?: unknown} = {approvalId: 'p2'}, text = {approvalId: 'p3', expiresAt: '0'};
  expect(liveComputerUsePending([unknown, text], now)).toEqual([unknown, text]);
});

/*
 * 「다른 Mac의 AI」 (docs/design/remote-computer-use-2026-11-01 §6 WP7, §7.9). A real runtime behind the panel's own
 * buttons: each button's handler is called as the panel would call it, its request goes through `manage` (the management
 * route), and the panel is rendered again from the status that follows. Nothing here touches the desktop or a network.
 */
const DEVICE = '3a9d0c1e-5b7f-4e2a-9c3d-1f2e3d4c5b6a', DEVICE2 = '7c1f2e3d-4b5a-4968-8776-5a4b3c2d1e0f';
const TAG_A = 'a'.repeat(32), TAG_B = 'b'.repeat(32), SESSION = '1'.repeat(32), STANDING = 1_793_400_000_000;
const owner = {pid: 912, start: '100001'};

/** A fake Control that approves a desktop request itself while the standing allowance is on (as Control does). */
function fixture(options: {standing?: number | null; acceptRemote?: boolean; settings?: ComputerUseRemoteSettingsStore; link?: ComputerUseRemoteLink} = {}) {
  const pair = generateKeyPairSync('ec', {namedCurve: 'prime256v1'}), jwk = pair.publicKey.export({format: 'jwk'});
  const helperPublicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64');
  const recovery = new ComputerUseRecovery(':memory:'), requests = new Map<string, any>(), answers = new Map<string, string>();
  let clock = Date.now(), standing = options.standing === undefined ? STANDING : options.standing, grant: string | null = null, opened = 0;
  const approve = (id: string) => { const r = requests.get(id); if (standing && r?.scope.kind === 'desktop' && grant === null && answers.get(id) === 'pending') answers.set(id, 'approved'); };
  const channel = {available: true, dispose() {}, retire(body: any) { if (body.operation === 'scope-revoke' && body.grant === grant) grant = null; }, async request(body: any): Promise<any> {
    switch (body.operation) {
      case 'status': return {success: true, protocolVersion: 1, workerProtocol: 2, backgroundOnly: true, accessibility: true, secureInput: false, operations: ['capture', 'click']};
      case 'scope-status': return {success: true, scopeProtocolVersion: 2, operations: [...COMPUTER_USE_SCOPE_OPERATIONS, 'scope-standing-off'], accessibility: true, screenRecording: true,
        secureInput: false, owner, standing: standing ? {scope: {kind: 'desktop'}, since: standing} : null};
      case 'scope-revoke': if (body.grant === grant) grant = null; return {success: true, revoked: true};
      case 'scope-revoke-session': grant = null; return {success: true, revoked: true};
      case 'scope-standing-off': standing = null; grant = null; return {success: true, standing: null};
      case 'scope-request-approval': requests.set(body.approvalId, {...body, owner}); answers.set(body.approvalId, 'pending'); approve(body.approvalId); return {success: true, state: answers.get(body.approvalId)};
      case 'scope-approval-status': {
        approve(body.approvalId); const state = answers.get(body.approvalId) ?? 'unknown', r = requests.get(body.approvalId);
        if (state !== 'approved') return {success: true, state};
        const payload = {version: 2 as const, approvalId: r.approvalId, scope: r.scope, permissions: [...COMPUTER_USE_SCOPE_PERMISSIONS], caller: r.caller, owner, issuedAt: clock, expiresAt: r.expiresAt};
        return {success: true, state, approval: {...payload, signature: sign('sha256', computerScopeApprovalBytes(payload), pair.privateKey).toString('base64')}, helperPublicKey};
      }
      case 'scope-open-grant':
        if (grant !== null) return {success: false, notDispatched: true, code: 'scope-conflict'};
        answers.set(body.approvalId, 'consumed'); grant = (++opened).toString(16).padStart(32, '0');
        return {success: true, bound: true, grant, expiresAt: clock + COMPUTER_USE_SCOPE_LIMITS.grantMs, scopeProtocolVersion: 2, operations: [...COMPUTER_USE_SCOPE_OPERATIONS], scope: body.scope, permissions: [...COMPUTER_USE_SCOPE_PERMISSIONS]};
      default: return {success: true};
    }
  }};
  const runtime = new ComputerUseRuntime(channel, recovery, {now: () => clock, callerHost: async () => ({state: 'known', bundleIds: ['com.stablyai.orca']}),
    acceptRemote: options.acceptRemote !== false, remoteSettings: options.settings ?? computerUseRemoteSettingsMemory(), remoteHumanInput: async () => null,
    ...(options.link ? {remoteLink: () => options.link!} : {}), sleep: async ms => { clock += ms; }});
  const remote = (body: Record<string, unknown>, peer: Record<string, unknown> = {}, session = SESSION): Promise<any> =>
    runtime.remote(session, {deviceId: DEVICE, deviceName: '1호 / 아젠투지(OPS)', instance: TAG_A, client: 'codex-mcp-client', host: 'Codex', ...peer}, body);
  return {runtime, remote, now: () => clock, advance: (ms: number) => { clock += ms; }, close() { runtime.dispose(); recovery.close(); }};
}
type F = ReturnType<typeof fixture>;
type El = {props: Record<string, any>};
/** Every element with this test id in a rendered tree (the remote components are plain elements, no hooks). */
function find(node: unknown, testId: string, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const child of node) find(child, testId, out); return out; }
  if (!node || typeof node !== 'object' || !('props' in node)) return out;
  const el = node as El; if (el.props['data-testid'] === testId) out.push(el); find(el.props.children, testId, out); return out;
}
/** The panel's wiring around the remote components: requests go to the runtime's management route and are recorded. */
function panel(f: F) {
  const sent: any[] = [], notices: string[] = [];let state: Record<string, any> | null = null, pending: Promise<void> = Promise.resolve();
  const props = {busy: false, run: (action: () => Promise<void>) => (pending = action()), onNotice: (value: string) => { notices.push(value); },
    request: async (body: any) => { sent.push(body); return await f.runtime.manage(body) as Record<string, any>; },
    refresh: async () => { state = await f.runtime.manage({operation: 'status'}) as Record<string, any>; }};
  const html = (component: (p: any) => React.ReactNode) => renderToStaticMarkup(React.createElement(component as any, {state, ...props}));
  return {sent, notices, html, get state() { return state; }, load: () => props.refresh(),
    /** Presses the n-th element with this test id in the component as rendered now and waits for its request and refresh. */
    async press(component: (p: any) => React.ReactNode, testId: string, index = 0) {
      const target = find(component({state, ...props}), testId)[index]; if (!target) throw Error(`no ${testId}[${index}] to press`);
      expect(target.props.disabled).toBe(false); target.props.onClick(); await pending;
    }};
}
const refused = async (p: Promise<unknown>) => { try { await p; } catch (error) { return (error as {code?: string}).code ?? (error as Error).message; } return 'no refusal'; };
const count = (html: string, testId: string) => html.split(`data-testid="${testId}"`).length - 1;
const remoteRows = (state: Record<string, any> | null) => (state?.connections ?? []).filter((c: any) => c.scope === 'remote-connection');

test('the receiving switch, 「끊기」 and blocking change only through the management route; off or a block removes the remote rows', async () => {
  const f = fixture();try {
    const ui = panel(f);
    expect((await f.remote({operation: 'scope-request-access'})).state).toBe('granted');
    await f.remote({operation: 'scope-status'}, {deviceId: DEVICE2, deviceName: '2호'}, '2'.repeat(32));
    await ui.load();
    let html = ui.html(ComputerUseRemoteReceive);
    expect(html).toContain('aria-checked="true"');expect(html).toContain('받기</span><span class="font-semibold">켜짐');
    expect(count(html, 'computer-use-remote-row')).toBe(2);
    // The remote grant is in its row, not in the generic list where 「제어 종료」 alone would let that AI take it again.
    expect(html).toContain('AI가 사용 중 · 전체 Mac');expect(html).toContain('연결됨 · 아직 허용 없음');
    expect(ui.state!.scoped.grants).toHaveLength(1);
    expect(renderToStaticMarkup(React.createElement(ComputerUseScopeGrants, {state: ui.state, busy: false, run: async () => {}, request: async () => ({}), refresh: async () => {}}))).not.toContain('제어 종료');

    // Neither an AI of this Mac nor one of another Mac can reach the person's switches.
    const instance = '9'.repeat(64);
    for (const body of [{operation: 'scope-remote-set', allowRemote: false}, {operation: 'scope-remote-set', block: {deviceId: DEVICE}}, {operation: 'scope-remote-set', noticeShown: true}]) {
      expect(await refused(f.runtime.agent(instance, 'codex-mcp-client', body))).not.toBe('no refusal');
      expect(await refused(f.remote(body))).toBe('REMOTE_OPERATION_REFUSED');
    }
    await ui.load();
    expect(ui.state!.remote).toMatchObject({allowRemote: true, blockedDevices: [], blockedConnections: [], noticeShown: false});
    expect(remoteRows(ui.state)).toHaveLength(2);expect(ui.state!.scoped.grants).toHaveLength(1);

    // 「끊기」 on 1호's row: exactly that connection for 30 minutes; its grant ends and the row goes.
    const row = remoteRows(ui.state).find((c: any) => c.remote.deviceId === DEVICE);
    await ui.press(ComputerUseRemoteReceive, 'computer-use-remote-cut', remoteRows(ui.state).indexOf(row));
    expect(ui.sent.at(-1)).toEqual({operation: 'scope-remote-set', block: {deviceId: DEVICE, name: '1호', connection: TAG_A, minutes: 30}});
    expect(ui.notices.at(-1)).toBe('원격 1호 (3a9d)의 이 연결을 끊었습니다. 30분 동안 다시 붙지 않습니다.');
    expect(remoteRows(ui.state).map((c: any) => c.remote.deviceCode)).toEqual(['7c1f']);expect(ui.state!.scoped.grants).toHaveLength(0);
    html = ui.html(ComputerUseRemoteReceive);
    expect(count(html, 'computer-use-remote-row')).toBe(1);expect(html).not.toContain('원격 · 1호');
    // The saved cut keeps no name (only device, connection and time); with no other row of that device it is named by its code.
    expect(count(html, 'computer-use-remote-cut-list')).toBe(1);expect(html).toContain('기기 (3a9d) · 끊은 연결 1개');
    expect(await refused(f.remote({operation: 'scope-status'}))).toBe('REMOTE_DEVICE_BLOCKED');
    // Another connection of 1호 is still received, and the cut list takes the name from its row.
    await f.remote({operation: 'scope-status'}, {instance: TAG_B}, '3'.repeat(32));
    await ui.load();expect(ui.html(ComputerUseRemoteReceive)).toContain('1호 (3a9d) · 끊은 연결 1개');

    // Clearing a cut is unavailable until Control's authenticated setting commit exists.
    expect(find(ComputerUseRemoteReceive({state:ui.state,busy:false,run:async()=>{},request:async()=>({}),refresh:async()=>{},onNotice:()=>{}}), 'computer-use-remote-uncut')[0]!.props.disabled).toBe(true);
    expect(await refused(f.runtime.manage({operation:'scope-remote-set',unblock:{deviceId:DEVICE}}))).toContain('이 버전에서는');
    expect(await refused(f.remote({operation:'scope-status'}))).toBe('REMOTE_DEVICE_BLOCKED');

    // 「이 기기의 AI 막기」 on 2호: every connection of 2호 ends and it is listed until 「풀기」.
    const two = remoteRows(ui.state).findIndex((c: any) => c.remote.deviceId === DEVICE2);
    await ui.press(ComputerUseRemoteReceive, 'computer-use-remote-block-device', two);
    expect(ui.sent.at(-1)).toEqual({operation: 'scope-remote-set', block: {deviceId: DEVICE2, name: '2호'}});
    expect(remoteRows(ui.state).map((c: any) => c.remote.deviceCode)).toEqual(['3a9d']);
    html = ui.html(ComputerUseRemoteReceive);
    expect(html).not.toContain('원격 · 2호');expect(count(html, 'computer-use-remote-blocked')).toBe(1);expect(html).toContain('2호 (7c1f) · 풀 때까지 막음');
    expect(await refused(f.remote({operation: 'scope-status'}, {deviceId: DEVICE2, deviceName: '2호'}, '4'.repeat(32)))).toBe('REMOTE_DEVICE_BLOCKED');
    expect(find(ComputerUseRemoteReceive({state:ui.state,busy:false,run:async()=>{},request:async()=>({}),refresh:async()=>{},onNotice:()=>{}}), 'computer-use-remote-unblock')[0]!.props.disabled).toBe(true);
    expect(await refused(f.runtime.manage({operation:'scope-remote-set',unblock:{deviceId:DEVICE2}}))).toContain('이 버전에서는');
    expect(ui.state!.remote.blockedDevices).toHaveLength(1);

    // The switch off ends remote rows; this Mac's own AI is unaffected and re-enabling is unavailable.
    await ui.press(ComputerUseRemoteReceive, 'computer-use-remote-switch');
    expect(ui.sent.at(-1)).toEqual({operation: 'scope-remote-set', allowRemote: false});
    html = ui.html(ComputerUseRemoteReceive);
    expect(remoteRows(ui.state)).toHaveLength(0);expect(count(html, 'computer-use-remote-row')).toBe(0);
    expect(html).toContain('aria-checked="false"');expect(html).toContain('꺼짐 · 다른 Mac의 AI를 받지 않습니다. 이 Mac의 AI는 그대로 씁니다.');
    expect(await refused(f.remote({operation: 'scope-status'}))).toBe('REMOTE_BLOCKED_BY_PERSON');
    expect((await f.runtime.agent(instance, 'codex-mcp-client', {operation: 'scope-request-access'}) as any).state).toBe('granted');
    expect(find(ComputerUseRemoteReceive({state:ui.state,busy:false,run:async()=>{},request:async()=>({}),refresh:async()=>{},onNotice:()=>{}}), 'computer-use-remote-switch')[0]!.props.disabled).toBe(true);
    expect(await refused(f.runtime.manage({operation:'scope-remote-set',allowRemote:true}))).toContain('이 버전에서는');
    expect(ui.state!.remote.allowRemote).toBe(false);
    // Every change above went through the management route only: no other operation was sent by the remote controls.
    expect(new Set(ui.sent.map(b => b.operation))).toEqual(new Set(['scope-remote-set']));
  } finally { f.close(); }
});

test('a remote row shows the device name and code; the notice is shown once until the person answers it', async () => {
  const settings = computerUseRemoteSettingsMemory(), f = fixture({settings});try {
    const ui = panel(f);
    await f.remote({operation: 'scope-request-access'});await ui.load();
    const [row] = remoteRows(ui.state), html = ui.html(ComputerUseRemoteReceive);
    // The sender's 「/ 아젠투지(OPS)」 suffix is not part of its name; the code is the first four of its device id.
    expect(html).toContain('원격 · 1호 (3a9d)');expect(html).toContain(`연결 ${row.code.slice(0, 8)} · AI가 사용 중 · 전체 Mac`);
    expect(html).toContain('aria-label="원격 1호 (3a9d) 연결 ' + row.code.slice(0, 8) + ' 끊기 · 30분"');expect(html).toContain('aria-label="1호 (3a9d)의 AI 막기"');
    // The risk of pointer input from another Mac is told, not hidden (D11: nothing is turned off).
    expect(html).toContain('오른쪽·두 번 클릭, 스크롤, 끌기도 받습니다');

    const notice = ui.html(ComputerUseRemoteNotice);
    expect(count(notice, 'computer-use-remote-notice')).toBe(1);expect(notice).toContain('이제 다른 Mac의 AI도 받습니다');expect(notice).toContain('막기');
    await ui.press(ComputerUseRemoteNotice, 'computer-use-remote-notice-ok');
    expect(ui.sent.at(-1)).toEqual({operation: 'scope-remote-set', noticeShown: true});
    expect(ui.html(ComputerUseRemoteNotice)).toBe('');
    // Answered once is answered for good: a restarted app reads the same settings and shows no notice; receiving stays on.
    const g = fixture({settings});try {
      const again = panel(g);await again.load();
      expect(again.html(ComputerUseRemoteNotice)).toBe('');expect(again.state!.remote.allowRemote).toBe(true);
    } finally { g.close(); }

    // 「막기」 in the notice: receiving off and the notice answered in one request.
    const h = fixture();try {
      const other = panel(h);await h.remote({operation: 'scope-status'});await other.load();
      expect(count(other.html(ComputerUseRemoteNotice), 'computer-use-remote-notice')).toBe(1);
      await other.press(ComputerUseRemoteNotice, 'computer-use-remote-notice-block');
      expect(other.sent).toEqual([{operation: 'scope-remote-set', allowRemote: false, noticeShown: true}]);
      expect(other.html(ComputerUseRemoteNotice)).toBe('');expect(remoteRows(other.state)).toHaveLength(0);
      expect(other.html(ComputerUseRemoteReceive)).toContain('aria-checked="false"');
    } finally { h.close(); }
  } finally { f.close(); }

  // Without the standing allowance it says that others' AIs could come in, not that they do.
  const off = fixture({standing: null});try {
    const ui = panel(off);await ui.load();const notice = ui.html(ComputerUseRemoteNotice);
    expect(notice).toContain('이제 다른 Mac의 AI도 받을 수 있습니다');expect(notice).toContain('상시 허용을 켜면');
    expect(ui.html(ComputerUseRemoteReceive)).toContain('켜짐 · 상시 허용이 꺼져 있어 아직 받지 않습니다');
  } finally { off.close(); }
  // A host that cannot receive (an unsigned build) never shows the notice, and its switch cannot be pressed.
  const unsigned = fixture({acceptRemote: false});try {
    const ui = panel(unsigned);await ui.load();
    expect(ui.html(ComputerUseRemoteNotice)).toBe('');
    const html = ui.html(ComputerUseRemoteReceive);expect(html).toContain('받을 수 없음 · 이 앱은 다른 Mac의 AI를 받지 않습니다');
    const [remoteSwitch] = find(ComputerUseRemoteReceive({state: ui.state, busy: false, run: async () => {}, request: async () => ({}), refresh: async () => {}, onNotice: () => {}}), 'computer-use-remote-switch');
    expect(remoteSwitch?.props.disabled).toBe(true);
  } finally { unsigned.close(); }
});

/** This Mac's AIs on other Macs as the sidecar reports them (the fake closes a device's sessions like the client does). */
function outgoingLink(ready = true) {
  const closed: string[] = [];
  let sessions: any[] = [
    {deviceId: DEVICE, deviceName: '1호 / 아젠투지(OPS)', connection: 'c'.repeat(32), client: 'codex-mcp-client', since: STANDING, lastCallAt: STANDING + 60_000, active: true},
    {deviceId: DEVICE, deviceName: '1호', connection: 'd'.repeat(32), client: 'claude-code', since: STANDING + 10_000, lastCallAt: STANDING + 20_000, active: false},
    {deviceId: DEVICE2.toUpperCase(), deviceName: '3호', connection: 'e'.repeat(32), client: null, since: STANDING, lastCallAt: STANDING, active: false},
    {deviceId: 'not-a-device', deviceName: '가짜', connection: 'f'.repeat(32), client: 'x', since: STANDING, lastCallAt: STANDING, active: true},
  ];
  const link: ComputerUseRemoteLink & {closed: string[]} = {closed, profileReady: () => ready, usage: () => ({sessions}),
    closeDevice(deviceId) { closed.push(deviceId); const n = sessions.filter(s => s.deviceId.toLowerCase() === deviceId).length; sessions = sessions.filter(s => s.deviceId.toLowerCase() !== deviceId); return n; }};
  return link;
}

test('A side: 「이 Mac의 AI가 <기기>를 사용 중」 per device, and its 「끊기」 closes that device through the management route', async () => {
  const link = outgoingLink(), f = fixture({link});try {
    const ui = panel(f);await ui.load();
    expect(ui.state!.outgoing.map((s: any) => `${s.deviceName}:${s.connection}`)).toEqual(['1호:cccccccc', '1호:dddddddd', '3호:eeeeeeee']);
    let html = ui.html(ComputerUseOutgoing);
    expect(count(html, 'computer-use-outgoing-row')).toBe(2);
    expect(html).toContain('이 Mac의 AI가 1호를 사용 중');expect(html).toContain('이 Mac의 AI가 3호를 사용 중');
    expect(html).toContain('연결 2개 · codex-mcp-client, claude-code · 최근 동작');expect(html).toContain('연결 1개 · 쉬는 중 · 마지막 동작');
    expect(html).not.toContain('가짜');
    // Neither path an AI has can close them.
    for (const body of [{operation: 'scope-remote-outgoing-close', deviceId: DEVICE}]) {
      expect(await refused(f.runtime.agent('9'.repeat(64), 'codex-mcp-client', body))).not.toBe('no refusal');
      expect(await refused(f.remote(body))).toBe('REMOTE_OPERATION_REFUSED');
    }
    expect(link.closed).toEqual([]);
    await ui.press(ComputerUseOutgoing, 'computer-use-outgoing-close');
    expect(ui.sent).toEqual([{operation: 'scope-remote-outgoing-close', deviceId: DEVICE}]);expect(link.closed).toEqual([DEVICE]);
    expect(ui.notices.at(-1)).toContain('1호 사용을 끊었습니다');
    html = ui.html(ComputerUseOutgoing);
    expect(count(html, 'computer-use-outgoing-row')).toBe(1);expect(html).not.toContain('1호');expect(html).toContain('3호를 사용 중');
    // An upper-case id from a status is still the same device; anything else is refused before the link is called.
    await f.runtime.manage({operation: 'scope-remote-outgoing-close', deviceId: DEVICE2.toUpperCase()});expect(link.closed).toEqual([DEVICE, DEVICE2]);
    await ui.load();expect(ui.html(ComputerUseOutgoing)).toBe('');
    for (const body of [{operation: 'scope-remote-outgoing-close'}, {operation: 'scope-remote-outgoing-close', deviceId: 'nope'}, {operation: 'scope-remote-outgoing-close', deviceId: DEVICE, all: true}])
      expect(await refused(f.runtime.manage(body))).toBe('끊을 기기를 확인하세요.');
    expect(link.closed).toHaveLength(2);
    // The receiving side reads the shared control-folder link from the same source.
    expect(ui.state!.remote.profileReady).toBe(true);
  } finally { f.close(); }
  // A sidecar that gives no link: no A rows, no readiness claim, and 「끊기」 says it cannot rather than pretending.
  const bare = fixture();try {
    const ui = panel(bare);await ui.load();
    expect('outgoing' in ui.state!).toBe(false);expect('profileReady' in ui.state!.remote).toBe(false);
    expect(ui.html(ComputerUseOutgoing)).toBe('');
    expect(await refused(bare.runtime.manage({operation: 'scope-remote-outgoing-close', deviceId: DEVICE}))).toContain('다른 Mac 연결 정보를 읽지 못했습니다');
  } finally { bare.close(); }
});

test('without the shared control-folder link the receiving side says it cannot receive', async () => {
  const f = fixture({link: outgoingLink(false)});try {
    const ui = panel(f);await ui.load();
    expect(ui.state!.remote.profileReady).toBe(false);
    expect(ui.html(ComputerUseRemoteReceive)).toContain('받을 수 없음 · 공유 총괄 폴더 연결이 필요합니다');
  } finally { f.close(); }
  const broken = fixture({link: {profileReady() { throw Error('unreadable'); }, usage() { throw Error('unreadable'); }, closeDevice: () => 0}});try {
    const ui = panel(broken);await ui.load();
    expect(ui.state!.remote.profileReady).toBe(false);expect(ui.state!.outgoing).toEqual([]);
  } finally { broken.close(); }
});

test('the standing allowance text names who it lets in (D1), and the old 「맡긴 작업도 이 Mac의 AI가」 sentence is gone', async () => {
  const f = fixture();try {
    // The panel's capability check reads Control, which tells the host the allowance is on.
    const ui = panel(f);await f.runtime.manage({operation: 'scope-status'});await ui.load();
    const form = (state: Record<string, any> | null) => renderToStaticMarkup(React.createElement(ComputerUseScopeForm,
      {mode: 'desktop', state, applications: [], request: async () => ({}), refresh: async () => {}, busy: false, run: async () => {}, onNotice: () => {}}));
    let html = form(ui.state);
    expect(html).toContain('computer-use-standing');
    expect(html).toContain('이 Mac의 모든 AgentsToZ AI와 같은 커뮤니티 다른 Mac의 AI가 다시 묻지 않고 전체 Mac을 씁니다');
    expect(html).not.toContain('맡긴 작업도 이 Mac의 AI가');
    await f.runtime.manage({operation: 'scope-remote-set', allowRemote: false});await ui.load();
    html = form(ui.state);
    expect(html).toContain('다른 Mac의 AI는 막아 두었습니다');expect(html).not.toContain('같은 커뮤니티 다른 Mac의 AI가 다시 묻지 않고');
  } finally { f.close(); }
  expect(computerUseStandingWho(null)).toBe('이 Mac의 모든 AgentsToZ AI가 다시 묻지 않고 전체 Mac을 씁니다.');
  const unsigned = fixture({acceptRemote: false});try {
    const ui = panel(unsigned);await ui.load();
    expect(computerUseStandingWho(computerUseRemoteView(ui.state))).toBe('이 Mac의 모든 AgentsToZ AI가 다시 묻지 않고 전체 Mac을 씁니다.');
  } finally { unsigned.close(); }
});

test('the remote view keeps only rows it can act on, groups cut connections by device and is absent for an older host', () => {
  const remote = {accepting: true, allowRemote: true, noticeShown: true,
    blockedDevices: [{deviceId: DEVICE2, name: '2호‮', since: STANDING}, {deviceId: 'nope', name: 'x', since: 1}],
    blockedConnections: [{deviceId: DEVICE, instance: TAG_A, until: STANDING + 1}, {deviceId: DEVICE, instance: TAG_B, until: STANDING + 9}, {deviceId: DEVICE2, instance: TAG_A, until: STANDING}]};
  const connections = [
    {id: 'rcu_1', code: '12345678-aaaa', scope: 'remote-connection', remote: {deviceId: DEVICE, deviceName: '1호', deviceCode: '3a9d', connection: TAG_B}},
    {id: 'rcu_2', code: 'x', scope: 'remote-connection', remote: {deviceId: DEVICE, deviceName: '1호', deviceCode: '3a9d', connection: 'short'}},
    {id: 'mcp_1', code: 'y', scope: 'mcp-connection'},
  ];
  const grants = [{id: 'g1', caller: {sessionId: 'rcu_1'}, halted: true}, {id: 'g2', caller: {sessionId: 'rcu_1'}, owner: 'person'}, {id: 'g3', caller: {sessionId: 'mcp_1'}, label: '이 Mac', scope: {kind: 'desktop'}}];
  const view = computerUseRemoteView({remote, connections, scoped: {grants}, access: {enabled: true, scope: {kind: 'desktop'}, standing: {since: STANDING}}})!;
  expect(view.rows).toEqual([{connectionId: 'rcu_1', code: '12345678', deviceId: DEVICE, deviceName: '1호', deviceCode: '3a9d', connection: TAG_B, grant: {id: 'g2', state: 'person'}}]);
  // A device blocked as a whole is listed once, not again for its cut connections; a name cannot carry direction marks.
  expect(view.blockedDevices).toEqual([{deviceId: DEVICE2, name: '2호', since: STANDING}]);
  expect(view.blockedConnections).toEqual([{deviceId: DEVICE, name: '1호', count: 2, until: STANDING + 9}]);
  expect(view.noticeDue).toBe(false);expect(computerUseRemoteStateText(view)).toContain('켜짐 · 같은 커뮤니티 다른 Mac의 AI가 상시 허용 아래 이 Mac 전체를 씁니다');
  expect(computerUseRemoteStateText({...view, appScope: true})).toBe('켜짐 · 지금은 한 앱만 허용돼 있어 다른 Mac의 AI는 거절합니다.');
  expect(computerUseRemoteStateText({...view, unreadable: true})).toBe('꺼짐 · 설정 파일을 읽지 못해 다른 Mac의 AI를 받지 않습니다. 공통 등록·권한관리에서 Native 수신 상태를 확인하세요.');
  const unreadableState={remote:{...remote,settingsUnreadable:true},connections,scoped:{grants},access:{enabled:true,scope:{kind:'desktop'},standing:{since:STANDING}}};
  const unreadableProps={state:unreadableState,busy:false,run:async()=>{},request:async()=>({}),refresh:async()=>{},onNotice:()=>{}};
  const unreadablePanel=ComputerUseRemoteReceive(unreadableProps);
  expect(find(unreadablePanel,'computer-use-remote-switch')[0]!.props.disabled).toBe(true);
  expect(renderToStaticMarkup(React.createElement(ComputerUseRemoteReceive,unreadableProps))).not.toContain('다시 켜면 새로 저장합니다');
  expect(ComputerUseRemoteNotice(unreadableProps)).toBeNull();
  // Only this Mac's own grant stays in the generic list.
  const grantsHtml = renderToStaticMarkup(React.createElement(ComputerUseScopeGrants, {state: {remote, connections, scoped: {grants}}, busy: false, run: async () => {}, request: async () => ({}), refresh: async () => {}}));
  expect(grantsHtml.split('제어 종료').length - 1).toBe(1);expect(grantsHtml).toContain('이 Mac');
  // A host from before remote computer use: nothing of it is shown.
  expect(computerUseRemoteView({connections})).toBeNull();expect(computerUseRemoteView(null)).toBeNull();
  expect(renderToStaticMarkup(React.createElement(ComputerUseRemoteReceive, {state: {connections}, busy: false, run: async () => {}, request: async () => ({}), refresh: async () => {}, onNotice: () => {}}))).toBe('');
  expect(computerUseOutgoingView({outgoing: [{deviceId: DEVICE, deviceName: '1호', since: 'x', lastCallAt: 1}]})).toEqual([]);
});

test('the object particle follows the device name', () => {
  expect(['1호', '사무실', '맥북', '노트북 2', '3', '9', 'Studio', ''].map(objectParticle)).toEqual(['를', '을', '을', '를', '을', '를', '을(를)', '을(를)']);
});

test('the remote controls use theme tokens only and no HTML5 drag', () => {
  for (const file of ['ComputerUseScopeControls.tsx', 'ComputerUsePanel.tsx']) {
    const source = readFileSync(join(import.meta.dir, '..', 'src', file), 'utf8');
    expect(source.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)).toBeNull();
    expect(source).not.toMatch(/draggable|onDrop|onDragStart/);
  }
});
