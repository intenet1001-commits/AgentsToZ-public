/**
 * 「에포트 자동」 reaches every Workroom screen through the existing workspace channel (w16 Build B): the Mac's own windows
 * (local route), a phone holding this project, and another community Mac — one action, `workroom.effort`. No capability-list
 * slot: an older Mac refuses the action outright and the screen hides the option. A phone may change this Mac's setting (it
 * may already type `/effort` into the same Workroom, which changes more); another community device may only read it.
 */
import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService} from '../src/aiTerminalService';
import {createCommunityControlExecutor} from '../src/agentDialogueControl';
import {createMobileWorkspaceGateway} from '../src/mobileWorkspaceGateway';
import {normalizeMobileWorkspaceRequest, normalizeMobileWorkspaceResult, workspaceScope, type MobileWorkspaceResult} from '../src/mobileWorkspaceProtocol';
import {isBackgroundTerminalRequest, readOnlyTerminalProbe} from '../src/remoteControlRelayController';
import {normalizeRemoteTerminalRequest} from '../src/remoteControlTerminalProtocol';
import {WORKROOM_EFFORT_COMMUNITY_REFUSAL} from '../src/workroomEffortView';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

const read = {operation: 'workspace' as const, requestId: 'request_effort_1', targetId: 'control_1234', workspace: {action: 'workroom.effort' as const}};
const withSession = {...read, workspace: {action: 'workroom.effort' as const, sessionId: 'session_1234'}};
const set = {...read, workspace: {action: 'workroom.effort' as const, set: false}};

test('the request: optional session, optional boolean set, nothing else; it needs no feature scope beyond the project', () => {
  expect(normalizeMobileWorkspaceRequest(read)).toEqual(read);
  expect(normalizeMobileWorkspaceRequest(withSession)).toEqual(withSession);
  expect(normalizeMobileWorkspaceRequest(set)).toEqual(set);
  for (const bad of [
    {...read, workspace: {action: 'workroom.effort', set: 'off'}},
    {...read, workspace: {action: 'workroom.effort', auto: false}},
    {...read, workspace: {action: 'workroom.effort', sessionId: '../x'}},
    {...read, workspace: {action: 'workroom.effort', saveRequestId: 'request_1234'}},
  ]) expect(() => normalizeMobileWorkspaceRequest(bad)).toThrow();
  // Other workroom actions still need their session.
  expect(() => normalizeMobileWorkspaceRequest({...read, workspace: {action: 'workroom.status'}})).toThrow();
  expect(() => normalizeMobileWorkspaceRequest({...read, workspace: {action: 'workroom.status', set: true}})).toThrow();
  expect(workspaceScope('workroom.effort')).toBeNull();
  // The relay envelope accepts it as it accepts every workspace action.
  expect(normalizeRemoteTerminalRequest({type: 'terminal.request', sessionToken: 'a'.repeat(43), request: read}).request).toEqual(read);
});

test('the result carries only the strict effort view, and only for that action', () => {
  const ok = {kind: 'workspace', action: 'workroom.effort', effort: {auto: true, session: {agent: 'claude', tier: 'high', reason: 'concurrency', level: 'high', origin: 'launch', manual: false}}};
  expect(normalizeMobileWorkspaceResult(ok)).toEqual(ok as never);
  for (const bad of [
    {kind: 'workspace', action: 'workroom.effort'},
    {kind: 'workspace', action: 'workroom.effort', effort: {auto: true}, memory: {state: 'idle', localSaved: false, backupSaved: false, message: ''}},
    {kind: 'workspace', action: 'workroom.effort', effort: {auto: true, session: {agent: 'claude', manual: false, sessionId: 'session_1234'}}},
    {kind: 'workspace', action: 'workroom.status', effort: {auto: true}},
  ]) expect(() => normalizeMobileWorkspaceResult(bad)).toThrow();
});

test('a phone with the project — and no feature scope at all — may read and change it; one without the project may not', async () => {
  let calls = 0, permitted = true;
  const gateway = createMobileWorkspaceGateway({
    terminal: async () => ({sessions: []}), active: () => true,
    resolve: async () => [{controlId: 'control_1234', runtimeTargetId: 'runtime_1234'}],
    consent: async () => ({targetIds: new Set(permitted ? ['runtime_1234'] : []), workspaceScopes: [], isActive: () => true, requestOwner: 'device_1234'}),
    perform: async request => { calls++; return {kind: 'workspace', action: 'workroom.effort', effort: {auto: request.workspace.set ?? true}}; },
  });
  expect(((await gateway(read, [], 'owner')) as MobileWorkspaceResult).effort).toEqual({auto: true});
  expect(((await gateway(set, [], 'owner')) as MobileWorkspaceResult).effort).toEqual({auto: false});
  permitted = false;
  await expect(gateway(read, [], 'owner')).rejects.toThrow();
  expect(calls).toBe(2);
});

test('another community Mac may read this Mac’s setting but never change it', async () => {
  const calls: unknown[] = [];
  const run = createCommunityControlExecutor({
    terminal: async () => ({sessions: []}),
    workspace: async body => { calls.push(body.workspace); return {kind: 'workspace', action: 'workroom.effort', effort: {auto: true}}; },
    projects: async () => ({projects: [], opsTargetId: null, deviceName: '3호'}),
  });
  expect(await run({kind: 'terminal', body: read})).toEqual({result: {kind: 'workspace', action: 'workroom.effort', effort: {auto: true}}});
  await expect(run({kind: 'terminal', body: set})).rejects.toThrow(WORKROOM_EFFORT_COMMUNITY_REFUSAL);
  await expect(run({kind: 'terminal', body: {...read, workspace: {action: 'workroom.effort', set: true}}})).rejects.toThrow(WORKROOM_EFFORT_COMMUNITY_REFUSAL);
  for(const mode of ['auto','recommend','off'])await expect(run({kind:'terminal',body:{...read,workspace:{action:'workroom.effort',effortModes:true,mode}}})).rejects.toThrow(WORKROOM_EFFORT_COMMUNITY_REFUSAL);
  expect(calls).toEqual([{action: 'workroom.effort'}]);
});

test('on the phone a read waits behind what a person pressed and its refusal by an older Mac does not stand as the relay error; a change does not', () => {
  expect(isBackgroundTerminalRequest(read)).toBe(true);
  expect(readOnlyTerminalProbe(read)).toBe(true);
  expect(isBackgroundTerminalRequest(set)).toBe(false);
  expect(readOnlyTerminalProbe(set)).toBe(false);
  for(const mode of ['auto','recommend','off'] as const){const change={...read,workspace:{action:'workroom.effort' as const,effortModes:true as const,mode}};expect(isBackgroundTerminalRequest(change)).toBe(false);expect(readOnlyTerminalProbe(change)).toBe(false);}
  // Unchanged neighbours.
  expect(isBackgroundTerminalRequest({...read, workspace: {action: 'workroom.status', sessionId: 'session_1234'}})).toBe(true);
  expect(readOnlyTerminalProbe({...read, workspace: {action: 'workroom.status', sessionId: 'session_1234'}})).toBe(false);
});

test('the host answers the Mac setting and that session’s record; a session of another project is not found; a change persists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'effort-workspace-'));
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  let auto = true;
  const service = new AiTerminalService({
    resolveTarget: async id => { if (id !== 'project-effort-a' && id !== 'project-effort-b') throw new Error('unregistered'); return {cwd: dir}; },
    executable: agent => `/fixture/bin/${agent}`, headlessScreen: false, activitySampler: false,
    env: {HOME: dir, PATH: '/usr/bin'}, resume: async () => null,
    effortAuto: {get: () => auto, set: value => (auto = value)},
    spawn: (_args, options: any) => {
      let settle!: (code: number) => void;
      const exited = new Promise<number>(resolve => { settle = resolve; });
      return {pid: 7_100_000 + Math.floor(Math.random() * 1000), exited, kill: () => { options.terminal.exit?.(); settle(143); }, terminal: {write: (data: string) => Buffer.byteLength(data), resize() {}, close() {}}} as any;
    },
  });
  cleanups.push(() => service.shutdown());
  void realpathSync(dir);
  const session = (await service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId: 'project-effort-a', agent: 'claude', cols: 80, rows: 24, prompt: '두 창이 동시에 저장하면 데드락이 걸려요'})).session!;
  expect(service.workspaceEffort({targetId: 'project-effort-a'})).toEqual({auto: true});
  expect(service.workspaceEffort({targetId: 'project-effort-a', sessionId: session.id})).toEqual({auto: true,
    session: {agent: 'claude', tier: 'high', reason: 'concurrency', level: 'high', origin: 'launch', manual: false}});
  expect(() => service.workspaceEffort({targetId: 'project-effort-b', sessionId: session.id})).toThrow();
  // A refused lookup changes nothing.
  expect(() => service.workspaceEffort({targetId: 'project-effort-b', sessionId: session.id, set: false})).toThrow();
  expect(auto).toBe(true);
  expect(service.workspaceEffort({targetId: 'project-effort-a', set: false})).toEqual({auto: false});
  expect(auto).toBe(false);
  // The view passes the phone's strict normalizer as it is.
  expect(normalizeMobileWorkspaceResult({kind: 'workspace', action: 'workroom.effort', effort: service.workspaceEffort({targetId: 'project-effort-a', sessionId: session.id})}).effort?.auto).toBe(false);
});

test('a host without the setting store cannot change it and says so', () => {
  const service = new AiTerminalService({resolveTarget: async () => ({cwd: tmpdir()}), executable: agent => `/fixture/bin/${agent}`, headlessScreen: false, activitySampler: false});
  cleanups.push(() => service.shutdown());
  expect(service.workspaceEffort({targetId: 'project-effort-a'})).toEqual({auto: false});
  expect(() => service.workspaceEffort({targetId: 'project-effort-a', set: true})).toThrow('업데이트');
});

test('a failed setting write never sends its local path or raw filesystem error to the phone', () => {
  const service = new AiTerminalService({
    resolveTarget: async () => ({cwd: tmpdir()}), executable: () => '/fixture/bin/claude', headlessScreen: false, activitySampler: false,
    effortAuto: {get: () => true, set: () => {throw new Error("EACCES: open '/Users/private-owner/Library/Application Support/workroom-effort-auto.json'");}},
  });
  cleanups.push(() => service.shutdown());
  let message = '';
  try {service.workspaceEffort({targetId: 'project-effort-a', set: false});} catch (error) {message = (error as Error).message;}
  expect(message).toContain('설정을 저장하지 못했습니다');
  expect(message).not.toContain('/Users/');
  expect(message).not.toContain('EACCES');
  expect(service.workspaceEffort({targetId: 'project-effort-a'})).toEqual({auto: true});
});

test('mode-v2 uses the same project grant, keeps legacy responses compatible and never permits a community write',async()=>{
 const {createWorkroomEffortSetting}=await import('../src/workroomEffortSetting');
 const dir=mkdtempSync(join(tmpdir(),'effort-modes-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
 const service=new AiTerminalService({resolveTarget:async()=>({cwd:dir}),executable:()=>null,effortAuto:createWorkroomEffortSetting(dir),activitySampler:false});cleanups.push(()=>service.shutdown());
 let permitted=true;
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({}),active:()=>true,resolve:async()=>[{controlId:'control_1234',runtimeTargetId:'runtime_1234'}],consent:async()=>({targetIds:new Set(permitted?['runtime_1234']:[]),workspaceScopes:[],isActive:()=>true,requestOwner:'phone_1234'}),perform:async(request,targetId)=>({kind:'workspace',action:'workroom.effort',effort:service.workspaceEffort({targetId,...request.workspace})})});
 for(const mode of ['auto','recommend','off'] as const){const req={...read,requestId:crypto.randomUUID(),workspace:{action:'workroom.effort' as const,effortModes:true as const,mode}};expect(((await gateway(req,[],'phone')) as MobileWorkspaceResult).effort).toEqual({auto:mode==='auto',mode});}
 expect(service.workspaceEffort({targetId:'runtime_1234'})).toEqual({auto:false});
 expect(normalizeMobileWorkspaceResult({kind:'workspace',action:'workroom.effort',effort:{auto:false,mode:'recommend'}}).effort!.mode).toBe('recommend');
 for(const workspace of [{action:'workroom.effort',mode:'auto'},{action:'workroom.effort',effortModes:true,mode:'other'},{action:'workroom.effort',effortModes:true,mode:'auto',set:true},{action:'memory.status',effortModes:true}])expect(()=>normalizeMobileWorkspaceRequest({...read,workspace})).toThrow();
 permitted=false;await expect(gateway({...read,workspace:{action:'workroom.effort',effortModes:true,mode:'auto'}},[],'phone')).rejects.toThrow('범위');
});
