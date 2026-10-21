import { describe, expect, test } from 'bun:test';
import { sweepRemoteControlProjects } from '../src/remoteControlPortalPagination';

describe('complete mobile project catalog', () => {
  test('resumes at 60/107 and retries a busy admission without skipping a page', async () => {
    let next: number | null = 3;
    let loaded = 60;
    let busy = true;
    const requests: number[] = [], accepted: number[] = [], waits: number[] = [];
    expect(await sweepRemoteControlProjects({
      nextPage: () => next, isCurrent: () => true,
      request: async page => {
        requests.push(page);
        if (busy) { busy = false; throw new Error('REMOTE_CONTROL_ACTION_IN_PROGRESS'); }
        loaded = Math.min(107, (page + 1) * 20);
        next = loaded === 107 ? null : page + 1;
      },
      onPage: page => accepted.push(page), sleep: async ms => { waits.push(ms); },
    })).toBe(true);
    expect(requests).toEqual([3, 3, 4, 5]);
    expect(accepted).toEqual([3, 4, 5]);
    expect(waits).toEqual([750]);
    expect(loaded).toBe(107);
  });

  test('busy channel has a finite retry budget and is never marked complete', async () => {
    let calls = 0;
    const accepted: number[] = [];
    await expect(sweepRemoteControlProjects({
      nextPage: () => 3, isCurrent: () => true,
      request: async () => { calls++; throw new Error('REMOTE_CONTROL_ACTION_IN_PROGRESS'); },
      onPage: page => accepted.push(page), sleep: async () => {},
    })).rejects.toThrow('REMOTE_CONTROL_ACTION_IN_PROGRESS');
    expect(calls).toBe(4);
    expect(accepted).toEqual([]);
  });

  test('transport failure preserves the partial list and does not resend a possibly pending action', async () => {
    let calls = 0;
    let next: number | null = 3;
    const pages: number[] = [];
    const options = {
      nextPage: () => next, isCurrent: () => true,
      request: async (page: number) => {
        calls++;
        if (calls === 1) throw new Error('relay unavailable');
        next = page === 5 ? null : page + 1;
      }, onPage: (page: number) => { pages.push(page); },
    };
    await expect(sweepRemoteControlProjects(options)).rejects.toThrow('relay unavailable');
    expect(calls).toBe(1);
    expect(next).toBe(3);
    expect(pages).toEqual([]);
    expect(await sweepRemoteControlProjects(options)).toBe(true);
    expect(pages).toEqual([3, 4, 5]);
  });

  test('switching Macs during a request suppresses late pages and stops the old sweep', async () => {
    let current = true;
    let calls = 0, updates = 0;
    expect(await sweepRemoteControlProjects({
      nextPage: () => 3, isCurrent: () => current,
      request: async () => { calls++; current = false; }, onPage: () => { updates++; },
    })).toBe(false);
    expect(calls).toBe(1);
    expect(updates).toBe(0);
  });

  test('repeated pages fail rather than repeatedly growing or fetching the same catalog', async () => {
    let calls = 0;
    await expect(sweepRemoteControlProjects({ nextPage: () => 3, isCurrent: () => true,
      request: async () => { calls++; }, onPage: () => {},
    })).rejects.toThrow('올바르게 진행되지');
    expect(calls).toBe(1);
  });

  test('byte-bounded pages may reach page 99 and still complete', async () => {
    let next: number | null = 0;
    let calls = 0;
    expect(await sweepRemoteControlProjects({ nextPage: () => next, isCurrent: () => true,
      request: async page => { calls++; next = page === 99 ? null : page + 1; }, onPage: () => {},
    })).toBe(true);
    expect(calls).toBe(100);
  });
});
