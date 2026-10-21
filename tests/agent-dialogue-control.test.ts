import {expect,test} from 'bun:test';
import {createCommunityControlExecutor,communityControlPollDelay,COMMUNITY_CONTROL_ACTIVE_POLL_MS,COMMUNITY_CONTROL_IDLE_POLL_MS} from '../src/agentDialogueControl';
import {communityDeviceLabel} from '../src/workroomDeviceLabel';
import {REMOTE_HISTORY_ACTIONS} from '../src/workroomHistoryRemoteProtocol';

const executor=()=>{
  const calls:string[]=[];
  const run=createCommunityControlExecutor({
    terminal:async body=>{calls.push('terminal:'+String(body.operation));return {sessions:[]};},
    workspace:async body=>{calls.push('workspace:'+String((body.workspace as any)?.action));return {ok:true};},
    projects:async()=>({projects:[{targetId:'project-aaaa',label:'A'}],opsTargetId:null,deviceName:'3호'}),
  });
  return {run,calls};
};

test('another Mac reaches only the Workroom: terminal operations, workroom actions and the project list',async()=>{
  const {run,calls}=executor();
  expect(await run({kind:'projects'})).toEqual({projects:[{targetId:'project-aaaa',label:'A'}],opsTargetId:null,deviceName:'3호'});
  for(const operation of ['list','start','read','input','resize','close'])
    expect(await run({kind:'terminal',body:{operation}})).toEqual({result:{sessions:[]}});
  expect(await run({kind:'terminal',body:{operation:'workspace',workspace:{action:'workroom.status'}}})).toEqual({result:{ok:true}});
  expect(calls).toEqual(['terminal:list','terminal:start','terminal:read','terminal:input','terminal:resize','terminal:close','workspace:workroom.status']);
});

test('the raw shared shell, unknown kinds and extra keys are refused before anything runs',async()=>{
  const {run,calls}=executor();
  for(const request of [
    {kind:'terminal',body:{operation:'shell.input',data:'rm -rf ~'}},
    {kind:'terminal',body:{operation:'unknown'}},
    {kind:'terminal',body:null},
    {kind:'terminal',body:[]},
    {kind:'shell',body:{}},
    {kind:'projects',extra:true},
    {kind:'terminal',body:{operation:'list'},path:'/etc'},
  ])await expect(run(request as Record<string,unknown>)).rejects.toThrow();
  expect(calls).toEqual([]);
});

test('the inbox is read fast only while another Mac is actually driving this one',()=>{
  expect(communityControlPollDelay(null,1_000_000)).toBe(COMMUNITY_CONTROL_IDLE_POLL_MS);
  expect(communityControlPollDelay(1_000_000-30_000,1_000_000)).toBe(COMMUNITY_CONTROL_ACTIVE_POLL_MS);
  expect(communityControlPollDelay(1_000_000-120_000,1_000_000)).toBe(COMMUNITY_CONTROL_IDLE_POLL_MS);
});

test('the device list shows the device, not the endpoint suffix',()=>{
  expect(communityDeviceLabel('아젠투지3호-회사 / 아젠투지(OPS)')).toBe('아젠투지3호-회사');
  expect(communityDeviceLabel('아젠투지 1호 / qq')).toBe('아젠투지 1호');
  expect(communityDeviceLabel('이름만')).toBe('이름만');
  expect(communityDeviceLabel('  \u0007 ')).toBe('다른 기기');
});

test('the 「기기」 row lays out as a row, not as a stretched column', async()=>{
  // `.ai-terminal-field` is a column flex box. The device row shares that class, so without an
  // explicit row direction its flex bases became heights (a 380px label) and it floated mid-screen.
  const css=await Bun.file(new URL('../src/AiTerminalPanel.css',import.meta.url)).text();
  const rule=css.match(/\.ai-terminal-panel \.ai-terminal-field--device \{([^}]*)\}/)?.[1]??'';
  expect(rule).toContain('flex-direction: row');
  const panel=await Bun.file(new URL('../src/AiTerminalPanel.tsx',import.meta.url)).text();
  // Outside the toolbar grid, whose stretched first row it used to take.
  expect(panel.indexOf('{deviceSwitch}')).toBeLessThan(panel.indexOf('<div className="ai-terminal-toolbar">'));
  // 전용 창(팝아웃)에서도 기기 줄은 남는다 — 거기서 다른 호를 골라 새 작업을 여는 것이 그 창의 동선이다.
  const focused=css.match(/\.ai-terminal-panel--focused \.ai-terminal-field--device \{([^}]*)\}/)?.[1]??'';
  expect(focused).toContain('display: flex');
  expect(focused).not.toContain('display: none');
});

import {createCommunityControlExecutor as executorForPrivilegeTest} from '../src/agentDialogueControl';
test('a request from another device cannot start a bypassed or resumed session', async () => {
  const seen: unknown[] = [];
  const run = executorForPrivilegeTest({terminal: async body => { seen.push(body); return {}; }, workspace: async () => ({}), projects: async () => ({projects: [], opsTargetId: null, deviceName: 'x'})});
  const start = {operation: 'start', requestId: 'r', targetId: 't', agent: 'claude', cols: 80, rows: 24};
  await expect(run({kind: 'terminal', body: {...start, bypassPermissions: true}})).rejects.toThrow('권한 우회');
  await expect(run({kind: 'terminal', body: {operation: 'start', requestId: 'r', resumeFrom: 's1'}})).rejects.toThrow('권한 우회');
  // The refusal is written by the device that refuses, which may be Windows (2호) — it must not say 「Mac」.
  const refusal = await run({kind: 'terminal', body: {...start, bypassPermissions: true}}).catch((e: Error) => e.message);
  expect(refusal).not.toContain('Mac');
  expect(refusal).toContain('세션을 열 기기 앞에서');
  await run({kind: 'terminal', body: start});
  expect(seen).toHaveLength(1);
});

import {COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR,COMMUNITY_CONTROL_RECEIPT_OWNER,communityReceiptOwner} from '../src/agentDialogueControl';
test('each sending Mac gets its own receipt namespace, keyed by the authenticated sender endpoint', async () => {
  // Two Macs driving this one must not read each other's submission receipts; the namespace comes from the
  // sender the control channel recorded, never from the request body.
  const seen: unknown[] = [];
  const run = createCommunityControlExecutor({terminal: async (_body, options) => { seen.push(options); return {ok: 1}; }, workspace: async () => ({}), projects: async () => ({projects: [], opsTargetId: null, deviceName: 'x'})});
  const body = {operation: 'submission', requestId: 'r1', sessionId: 'session-1', submission: {phase: 'status', id: 'submission-1'}};
  const a = '11111111-2222-4333-8444-555555555555', b = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
  await run({kind: 'terminal', body}, {deviceId: 'd1', name: 'one', endpointId: a});
  await run({kind: 'terminal', body}, {deviceId: 'd2', name: 'two', endpointId: b});
  await run({kind: 'terminal', body}, {deviceId: 'd3', name: 'three', endpointId: '../local'});
  expect(seen).toEqual([{receiptOwner: `community:${a}`}, {receiptOwner: `community:${b.toLowerCase()}`}, {receiptOwner: COMMUNITY_CONTROL_RECEIPT_OWNER}]);
  expect(communityReceiptOwner(undefined)).toBe(COMMUNITY_CONTROL_RECEIPT_OWNER);
});
test('another Mac can submit a whole Workroom request, with receipts kept apart from this Mac\'s own', async () => {
  // The receiver advertises terminal-submission-v1 on `list`; refusing `submission` left the other device's
  // composer with a pending banner it could never resolve (installed v791, 2026-10-15).
  const seen: {body: Record<string, unknown>; options: unknown}[] = [];
  const run = createCommunityControlExecutor({terminal: async (body, options) => { seen.push({body, options}); return {ok: 1}; }, workspace: async () => ({}), projects: async () => ({projects: [], opsTargetId: null, deviceName: 'x'})});
  const single = {operation: 'submission', requestId: 'r1', sessionId: 'session-1', submission: {phase: 'single', id: 'submission-1', bytes: 3, digest: 'a'.repeat(64), data: 'aGkN'}};
  expect(await run({kind: 'terminal', body: single})).toEqual({result: {ok: 1}});
  const status = {operation: 'submission', requestId: 'r2', sessionId: 'session-1', submission: {phase: 'status', id: 'submission-1'}};
  expect(await run({kind: 'terminal', body: status})).toEqual({result: {ok: 1}});
  // The receipt namespace is host-only: it rides beside the body, never inside it.
  expect(seen.map(x => x.body)).toEqual([single, status]);
  for (const x of seen) expect(x.options).toEqual({receiptOwner: COMMUNITY_CONTROL_RECEIPT_OWNER});
  expect(COMMUNITY_CONTROL_RECEIPT_OWNER).not.toBe('local');
  // No field on any operation raises privileges.
  for (const body of [{...single, bypassPermissions: true}, {...status, resumeFrom: 'session-0'}, {operation: 'input', requestId: 'r3', sessionId: 'session-1', data: 'x', bypassPermissions: true}])
    await expect(run({kind: 'terminal', body})).rejects.toThrow('권한 우회');
  expect(seen).toHaveLength(2);
  // The refusal an older receiver gives is shared, so a sender can recognise it exactly.
  await expect(run({kind: 'terminal', body: {operation: 'shell.input'}})).rejects.toThrow(COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR);
});

test('conversation history is never reachable from another Mac, even though it is not a `workroom.` action', async () => {
  // History list/resume is granted per phone in the Mac dialog. Community membership is not that grant, so the
  // executor refuses it before the workspace path runs (2026-10-15, S3-7).
  const {run, calls} = executor();
  // Every history action, the restart offer (w14) included.
  for (const action of new Set([...REMOTE_HISTORY_ACTIONS, 'history.restart', 'history.restart.dismiss']))
    await expect(run({kind: 'terminal', body: {operation: 'workspace', requestId: 'request-0001', targetId: 'project-aaaa', workspace: {action, history: {}}}})).rejects.toThrow('대화 기록');
  expect(calls).toEqual([]);
});
