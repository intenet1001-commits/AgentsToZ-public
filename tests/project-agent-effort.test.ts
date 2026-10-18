import {expect, test} from 'bun:test';
import {ProjectAgentEffortController, type ProjectAgentEffortHost, type ProjectAgentEffortSession} from '../src/projectAgentEffort';
import type {WorkroomEffortMode} from '../src/workroomEffortMode';

function fixture() {
  let mode: WorkroomEffortMode = 'auto';
  let session: ProjectAgentEffortSession = {projectId: 'registered-project', sessionId: 'external-session', agent: 'codex', model: 'gpt-6.1-sol', revision: 'input-1', effort: 'medium', supportedEfforts: ['low','medium','high','max'], manual: false, control: 'session'};
  const writes: string[] = [];
  let beforeResolve: (() => void) | undefined;
  let acknowledge = true;
  const host: ProjectAgentEffortHost = {
    mode: () => mode,
    resolve: async (projectId, sessionId) => {
      beforeResolve?.();
      if (projectId !== session.projectId || sessionId !== session.sessionId) throw Error('unregistered');
      return {...session, supportedEfforts: [...session.supportedEfforts]};
    },
    apply: async (expected, level) => {
      if (expected.revision !== session.revision || expected.model !== session.model || session.manual) throw Error('changed');
      writes.push(level);
      if (acknowledge) session = {...session, effort: level};
    },
  };
  return {controller: new ProjectAgentEffortController(host), host, writes,
    mode(value: WorkroomEffortMode) {mode = value;},
    patch(value: Partial<ProjectAgentEffortSession>) {session = {...session, ...value};},
    onResolve(fn: () => void) {beforeResolve = fn;},
    unconfirmed() {acknowledge = false;},
  };
}
const request = (prompt: string) => ({projectId: 'registered-project', sessionId: 'external-session', prompt});

test('an external native host adjusts across task phases and confirms the actual session setting', async () => {
  const f = fixture();
  expect((await f.controller.adjust(request('문구만 수정'))).status).toBe('applied');
  expect((await f.controller.adjust(request('동시성 아키텍처 검토'))).observed).toBe('high');
  expect((await f.controller.adjust({...request('변경 검증'), context: {routineVerification: true}})).observed).toBe('low');
  expect(f.writes).toEqual(['low','high','low']);
});

test('Codex Claude and Hermes adapters use only the host-proven native session control', async () => {
  for (const agent of ['codex','claude','hermes'] as const) {
    const f = fixture(); f.patch({agent});
    expect(await f.controller.adjust(request('권한 보안 검토'))).toMatchObject({status: 'applied', observed: 'high'});
    f.mode('recommend');
    expect((await f.controller.adjust(request('오타 수정'))).status).toBe('recommended');
    expect(f.writes).toEqual(['high']);
  }
});

test('recommend and off share the preference without writing the external session', async () => {
  const f = fixture(); f.mode('recommend');
  expect(await f.controller.adjust(request('보안 검토'))).toMatchObject({mode: 'recommend', status: 'recommended', decision: {tier: 'high'}});
  f.mode('off');
  expect(await f.controller.adjust(request('보안 검토'))).toEqual({mode: 'off', status: 'off'});
  expect(f.writes).toEqual([]);
});

test('explicit manual max and model/account binding changes are preserved', async () => {
  const f = fixture(); f.patch({manual: true, effort: 'max'});
  expect(await f.controller.adjust(request('문구만 수정'))).toMatchObject({status: 'manual', observed: 'max'});
  expect(f.writes).toEqual([]);
});

test('an unregistered project cannot borrow another registered session even when off', async () => {
  const f = fixture(); f.mode('off');
  await expect(f.controller.adjust({...request('작업'), projectId: 'other-project'})).rejects.toThrow('unregistered');
  expect(f.writes).toEqual([]);
});

test('instruction-only external apps and unsupported model levels remain recommendation-only', async () => {
  const f = fixture(); f.patch({control: 'none'});
  expect(await f.controller.adjust(request('보안 검토'))).toMatchObject({status: 'unsupported', decision: {tier: 'high'}});
  f.patch({control: 'session', supportedEfforts: ['medium']});
  expect((await f.controller.adjust(request('보안 검토'))).status).toBe('unsupported');
  f.patch({agent: 'agy', supportedEfforts: ['high']});
  expect((await f.controller.adjust(request('보안 검토'))).status).toBe('unsupported');
  expect(f.writes).toEqual([]);
});

test('a mode, model or input revision changed during preparation fences native writes', async () => {
  for (const mutate of ['mode','model','revision','manual','account','provider'] as const) {
    const f = fixture(); let count = 0;
    f.onResolve(() => {if (++count === 2) {
      if (mutate === 'mode') f.mode('off'); else if (mutate === 'model') f.patch({model: 'different-model'});
      else if (mutate === 'revision') f.patch({revision: 'input-2'}); else if (mutate === 'account') f.patch({accountId: 'different-account'});
      else if (mutate === 'provider') f.patch({provider: 'different-provider'}); else f.patch({manual: true});
    }});
    expect((await f.controller.adjust(request('보안 검토'))).status).toBe('deferred');
    expect(f.writes).toEqual([]);
  }
});

test('a native setting not observed after application is never reported as applied', async () => {
  const f = fixture(); f.unconfirmed();
  expect((await f.controller.adjust(request('보안 검토'))).status).toBe('unconfirmed');
});

test('commands and unchanged levels generate no native writes', async () => {
  const f = fixture();
  expect((await f.controller.adjust(request('/model'))).status).toBe('unclassified');
  expect((await f.controller.adjust(request('기능 구현'))).status).toBe('unchanged');
  expect(f.writes).toEqual([]);
});

test('existing unresolved failure context increases effort without another model call', async () => {
  const f = fixture();
  expect(await f.controller.adjust({...request('확인해 줘'), context: {unresolvedFailure: true, routineVerification: true}})).toMatchObject({status: 'applied', decision: {tier: 'high', reason: 'unclear-failure'}});
});

test('concurrent phase changes never overlap native writes in one session and failed writes release their slot', async () => {
  const f = fixture(); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => {release = resolve;});
  const started = new Promise<void>(resolve => {entered = resolve;});
  const apply = f.host.apply;
  f.host.apply = async (session, level) => {entered(); await waiting; await apply(session, level);};
  const first = f.controller.adjust(request('보안 검토'));
  await started;
  expect((await f.controller.adjust(request('오타 수정'))).status).toBe('deferred');
  release(); expect((await first).status).toBe('applied');
  f.host.apply = async () => {throw Error('native failure');};
  await expect(f.controller.adjust(request('오타 수정'))).rejects.toThrow('native failure');
  f.host.apply = apply;
  expect((await f.controller.adjust(request('오타 수정'))).status).toBe('applied');
});

test('external host resolution is bounded before any pending native change', async () => {
  const f = fixture(); let release!: () => void, calls = 0;
  const wait = new Promise<void>(resolve => {release = resolve;});
  f.host.resolve = async (projectId, sessionId) => {calls++; await wait; return {projectId, sessionId, agent: 'codex', model: 'model', revision: '1', effort: 'high', supportedEfforts: ['high'], manual: false, control: 'session'};};
  const pending = Array.from({length: 32}, (_, i) => f.controller.adjust({...request('보안 검토'), sessionId: 'session-' + i}));
  expect((await f.controller.adjust({...request('보안 검토'), sessionId: 'overflow'})).status).toBe('deferred');
  expect(calls).toBe(32);
  release(); await Promise.all(pending);
  expect((await f.controller.adjust({...request('보안 검토'), sessionId: 'after-release'})).status).toBe('unchanged');
});
