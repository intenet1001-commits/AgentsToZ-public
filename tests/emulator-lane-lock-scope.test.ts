/** Pure fake lanes/locks: no simulator, app, network, kernel lock, or production port. */
import {describe, expect, test} from 'bun:test';
import {LaneSimulatorLock, ownedChildExitUncertainty, registerLane, runLanes, unregisterLane, waitForLaneChildrenBeforeUnlock, type LaneContext, type LaneScope} from '../scripts/emulator-e2e';
import type {SimulatorLockResult} from '../scripts/emulator-e2e/preflight';

function fakeLock() {
  let owner: string | null = null;
  const calls: string[] = [];
  const acquire = (run: string) => async (): Promise<SimulatorLockResult> => {
    calls.push(`acquire:${run}`);
    if (owner) return {status: 'blocked', lockPath: 'fake', waitedMs: 0, reason: 'held', holder: null};
    owner = run;
    let released = false;
    return {status: 'acquired', lockPath: 'fake', waitedMs: 0, loadavgAtAcquire: [], cpuCount: 1,
      holder: {pid: 1, lockfPid: 2, runId: run, acquiredAt: 'fake'}, release: async () => {
        if (released) return;
        released = true;
        if (owner !== run) throw Error('attempt to release another run');
        calls.push(`release:${run}`); owner = null;
      }};
  };
  return {acquire, calls, owner: () => owner};
}
const passing = {status: 'pass', reasons: []};
const quiet = () => {};

describe('simulator lock belongs to one lane', () => {
  test('all settles J1 child resources and releases before J2 acquires', async () => {
    const lock = fakeLock();
    const events = lock.calls;
    const ctx = {preflight: passing, acquireSimulatorBootLock: lock.acquire('all')} as unknown as LaneContext;
    for (const id of ['j1-lan', 'j2'] as const) registerLane({id, run: async lane => {
      expect((await lane.acquireSimulatorBootLock(0)).status).toBe('acquired');
      events.push(`run:${id}`); return {status: 'pass'};
    }});
    try {
      const scope = (id: string): LaneScope => ({settle: async () => {events.push(`child-stopped:${id}`); return [];}});
      const result = await runLanes(['j1-lan', 'j2'], 'all', ctx, id => scope(id), quiet);
      expect(result.lanes.map(lane => lane.status)).toEqual(['pass', 'pass']);
      expect(events).toEqual(['acquire:all', 'run:j1-lan', 'child-stopped:j1-lan', 'release:all',
        'acquire:all', 'run:j2', 'child-stopped:j2', 'release:all']);
      expect(lock.owner()).toBeNull();
    } finally {unregisterLane('j1-lan'); unregisterLane('j2');}
  });

  test('throwing lane settles its child and releases before the next lane', async () => {
    const lock = fakeLock();
    const ctx = {preflight: passing, acquireSimulatorBootLock: lock.acquire('all')} as unknown as LaneContext;
    registerLane({id: 'j1-lan', run: async lane => {await lane.acquireSimulatorBootLock(0); throw Error('cancelled');}});
    registerLane({id: 'j2', run: async lane => ({status: (await lane.acquireSimulatorBootLock(0)).status === 'acquired' ? 'pass' : 'fail'})});
    try {
      const result = await runLanes(['j1-lan', 'j2'], 'all', ctx, id => ({settle: async () => {lock.calls.push(`child-stopped:${id}`); return [];}}), quiet);
      expect(result.lanes.map(lane => lane.status)).toEqual(['fail', 'pass']);
      expect(lock.calls).toEqual(['acquire:all', 'child-stopped:j1-lan', 'release:all', 'acquire:all', 'child-stopped:j2', 'release:all']);
    } finally {unregisterLane('j1-lan'); unregisterLane('j2');}
  });

  test('another run stays held when a lane is blocked', async () => {
    const lock = fakeLock();
    const other = await lock.acquire('other')();
    if (other.status !== 'acquired') throw Error('fixture');
    const lane = new LaneSimulatorLock(lock.acquire('lane'));
    expect((await lane.acquire(0)).status).toBe('blocked');
    await lane.settle();
    expect(lock.owner()).toBe('other');
    expect(lock.calls).not.toContain('release:other');
    await other.release();
  });

  test('uncertain child cleanup stops the remaining lanes and retains this run’s lock', async () => {
    const lock = fakeLock();
    let retained: Extract<SimulatorLockResult, {status: 'acquired'}> | null = null;
    const ctx = {preflight: passing, acquireSimulatorBootLock: lock.acquire('all')} as unknown as LaneContext;
    registerLane({id: 'j1-lan', run: async lane => {
      const result = await lane.acquireSimulatorBootLock(0);
      if (result.status === 'acquired') retained = result;
      return {status: 'pass'};
    }});
    registerLane({id: 'j2', run: async () => {throw Error('must not run');}});
    try {
      const result = await runLanes(['j1-lan', 'j2'], 'all', ctx, () => ({settle: async () => {throw Error('child still alive');}}), quiet);
      expect(result.cleanupFailed).toBe(true);
      expect(result.lanes).toHaveLength(1);
      expect(result.lanes[0]).toMatchObject({status: 'fail'});
      expect(lock.owner()).toBe('all');
      expect(lock.calls).toEqual(['acquire:all']);
    } finally {
      if (retained) await (retained as Extract<SimulatorLockResult, {status: 'acquired'}>).release();
      unregisterLane('j1-lan'); unregisterLane('j2');
    }
  });

  test('a reported still-running child stops the next lane, but a dirty exited child only fails its lane', async () => {
    for (const alive of [true, false]) {
      const lock = fakeLock();
      const child = {exitCode: alive ? null : 1, signalCode: null};
      let retained: Extract<SimulatorLockResult, {status: 'acquired'}> | null = null;
      const ctx = {preflight: passing, acquireSimulatorBootLock: lock.acquire('all')} as unknown as LaneContext;
      registerLane({id: 'j1-lan', run: async lane => {
        const result = await lane.acquireSimulatorBootLock(0);
        if (result.status === 'acquired') retained = result;
        return {status: 'pass'};
      }});
      registerLane({id: 'j2', run: async () => ({status: 'pass'})});
      try {
        const scope = (id: string): LaneScope => id === 'j1-lan'
          ? {settle: async () => [alive ? 'supabase shim: still running' : 'supabase shim: dirty exit'],
             cleanupUncertain: () => ownedChildExitUncertainty([{label: 'fake shim', child}])}
          : {settle: async () => []};
        const result = await runLanes(['j1-lan', 'j2'], 'all', ctx, scope, quiet);
        expect(result.lanes[0]).toMatchObject({status: 'fail'});
        expect(result.cleanupFailed).toBe(alive);
        expect(result.lanes.length).toBe(alive ? 1 : 2);
        expect(lock.owner()).toBe(alive ? 'all' : null);
      } finally {
        if (retained) await (retained as Extract<SimulatorLockResult, {status: 'acquired'}>).release();
        unregisterLane('j1-lan'); unregisterLane('j2');
      }
    }
  });

  test('unlock waits for the owned fake child after a normal stop return with no confirmed exit', async () => {
    const child = {exitCode: null as number | null, signalCode: null};
    let resolveExit!: () => void;
    const exited = new Promise<void>(resolve => {resolveExit = resolve;});
    const hosts = {settle: async () => ['supabase shim: still running'],
      cleanupUncertain: () => ownedChildExitUncertainty([{label: 'fake shim', child}]),
      waitForOwnedChildrenExit: async () => {await exited;}};
    let unlocked = false;
    const waiting = waitForLaneChildrenBeforeUnlock(hosts, quiet).then(() => {unlocked = true;});
    await Promise.resolve(); await Promise.resolve();
    expect(unlocked).toBe(false);
    child.exitCode = 0; resolveExit();
    await waiting;
    expect(unlocked).toBe(true);
  });

  test('nested and concurrent acquisitions fail without overwriting the owned handle', async () => {
    const lock = fakeLock();
    const lane = new LaneSimulatorLock(lock.acquire('lane'));
    expect((await lane.acquire(0)).status).toBe('acquired');
    await expect(lane.acquire(0)).rejects.toThrow('not reentrant');
    await lane.settle(); await lane.settle();
    expect(lock.calls).toEqual(['acquire:lane', 'release:lane']);
    await expect(lane.acquire(0)).rejects.toThrow('closed');
    let resolve!: (value: SimulatorLockResult) => void;
    const pending = new LaneSimulatorLock(() => new Promise(r => {resolve = r;}));
    const first = pending.acquire(0);
    await expect(pending.acquire(0)).rejects.toThrow('not reentrant');
    const closing = pending.settle();
    resolve(await lock.acquire('pending')());
    expect((await first).status).toBe('blocked');
    await closing;
    expect(lock.owner()).toBeNull();
    expect(lock.calls.slice(-2)).toEqual(['acquire:pending', 'release:pending']);
  });
});
