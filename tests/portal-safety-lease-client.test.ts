import { describe, expect, test } from 'bun:test';
import { withPortalSafetyLease } from '../src/portalSafetyLease';
import { portalLocalMetadataFingerprint } from '../src/portalLocalMetadata';

const token = 'a'.repeat(64);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('renderer portal safety lease', () => {
  test('fails closed before the operation when acquisition fails', async () => {
    let operated = false;
    await expect(withPortalSafetyLease({}, () => {
      operated = true;
    }, {
      deployedWeb: false,
      tauri: false,
      fetchImpl: (async () => response({ error: 'busy' }, 409)) as unknown as typeof fetch,
    })).rejects.toThrow('HTTP 409');
    expect(operated).toBe(false);
  });

  test('uses authoritative metadata and always releases after an operation error', async () => {
    const metadata = {
      localOnlyDeletedPortIds: ['deleted-port'],
      verifiedLegacyGeneratedWorktreeIds: ['legacy-child'],
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/acquire')) {
        return response({
          success: true,
          token,
          metadata,
          fingerprint: portalLocalMetadataFingerprint(metadata),
          expiresInMs: 120_000,
        });
      }
      return response({ success: true, released: true });
    }) as unknown as typeof fetch;

    await expect(withPortalSafetyLease({}, lease => {
      expect(lease.metadata).toEqual(metadata);
      throw new Error('operation failed');
    }, { deployedWeb: false, tauri: false, fetchImpl })).rejects.toThrow('operation failed');

    expect(calls.map(call => call.url)).toEqual([
      '/api/portal/safety-lease/acquire',
      '/api/portal/safety-lease/release',
    ]);
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ token });
  });

  test('rejects a mismatched metadata fingerprint without running the operation', async () => {
    let operated = false;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1 ? response({
        success: true,
        token,
        metadata: { localOnlyDeletedPortIds: ['a'] },
        fingerprint: portalLocalMetadataFingerprint({ localOnlyDeletedPortIds: ['b'] }),
        expiresInMs: 120_000,
      }) : response({ success: true, released: true });
    }) as unknown as typeof fetch;

    await expect(withPortalSafetyLease({}, () => {
      operated = true;
    }, { deployedWeb: false, tauri: false, fetchImpl })).rejects.toThrow('일치하지 않습니다');
    expect(operated).toBe(false);
    expect(calls).toBe(2);
  });

  test('serializes concurrent renderer lease users', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    let leaseNumber = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/acquire')) {
        leaseNumber += 1;
        events.push(`acquire:${leaseNumber}`);
        return response({
          success: true,
          token: String(leaseNumber).repeat(64),
          metadata: {},
          fingerprint: portalLocalMetadataFingerprint({}),
          expiresInMs: 120_000,
        });
      }
      events.push('release');
      return response({ success: true, released: true });
    }) as unknown as typeof fetch;
    const first = withPortalSafetyLease({}, async () => {
      events.push('first:start');
      markFirstStarted();
      await firstGate;
      events.push('first:end');
    }, { deployedWeb: false, tauri: false, fetchImpl });
    const second = withPortalSafetyLease({}, async () => {
      events.push('second:start');
    }, { deployedWeb: false, tauri: false, fetchImpl });
    await firstStarted;
    try {
      expect(events).toEqual(['acquire:1', 'first:start']);
    } finally {
      releaseFirst();
    }
    await Promise.all([first, second]);
    expect(events).toEqual([
      'acquire:1',
      'first:start',
      'first:end',
      'release',
      'acquire:2',
      'second:start',
      'release',
    ]);
  });

  test('renews a long-running operation and waits for an in-flight heartbeat before release', async () => {
    const calls: string[] = [];
    let finishOperation!: () => void;
    const operationGate = new Promise<void>(resolve => { finishOperation = resolve; });
    let markRenewed!: () => void;
    const renewed = new Promise<void>(resolve => { markRenewed = resolve; });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/acquire')) {
        return response({
          success: true,
          token,
          metadata: {},
          fingerprint: portalLocalMetadataFingerprint({}),
          expiresInMs: 120_000,
        });
      }
      if (url.endsWith('/renew')) {
        markRenewed();
        return response({ success: true, renewed: true, expiresInMs: 120_000 });
      }
      return response({ success: true, released: true });
    }) as unknown as typeof fetch;

    const running = withPortalSafetyLease({}, async () => {
      await operationGate;
      return 7;
    }, {
      deployedWeb: false,
      tauri: false,
      fetchImpl,
      renewIntervalMs: 5,
    });
    await renewed;
    finishOperation();
    expect(await running).toBe(7);
    expect(calls[0]).toBe('/api/portal/safety-lease/acquire');
    expect(calls).toContain('/api/portal/safety-lease/renew');
    expect(calls.at(-1)).toBe('/api/portal/safety-lease/release');
  });

  test('reports a definitive heartbeat ownership loss once without releasing early', async () => {
    const calls: string[] = [];
    const leaseErrors: unknown[] = [];
    let markRenewAttempted!: () => void;
    const renewAttempted = new Promise<void>(resolve => { markRenewAttempted = resolve; });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/acquire')) {
        return response({
          success: true,
          token,
          metadata: {},
          fingerprint: portalLocalMetadataFingerprint({}),
          expiresInMs: 120_000,
        });
      }
      if (url.endsWith('/renew')) {
        markRenewAttempted();
        return response({ success: true, renewed: false, expiresInMs: 120_000 });
      }
      return response({ success: true, released: false });
    }) as unknown as typeof fetch;

    const result = await withPortalSafetyLease({}, async () => {
      await renewAttempted;
      return 11;
    }, {
      deployedWeb: false,
      tauri: false,
      fetchImpl,
      renewIntervalMs: 5,
      onReleaseError: error => { leaseErrors.push(error); },
    });
    expect(result).toBe(11);
    expect(calls).toEqual([
      '/api/portal/safety-lease/acquire',
      '/api/portal/safety-lease/renew',
      '/api/portal/safety-lease/release',
    ]);
    expect(leaseErrors).toHaveLength(1);
    expect(String(leaseErrors[0])).toContain('작업 중 만료');
  });

  test('reports lease ownership loss without misreporting a committed operation as failed', async () => {
    let calls = 0;
    let releaseError: unknown;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1 ? response({
        success: true,
        token,
        metadata: {},
        fingerprint: portalLocalMetadataFingerprint({}),
        expiresInMs: 120_000,
      }) : response({ success: true, released: false });
    }) as unknown as typeof fetch;
    const result = await withPortalSafetyLease({}, () => 42, {
      deployedWeb: false,
      tauri: false,
      fetchImpl,
      onReleaseError: error => { releaseError = error; },
    });
    expect(result).toBe(42);
    expect(releaseError).toBeInstanceOf(Error);
    expect(String(releaseError)).toContain('소유권');
  });

  test('deployed web bypasses localhost and uses the supplied marker snapshot', async () => {
    const portalData = { localOnlyDeletedPortIds: ['hidden'] };
    let fetched = false;
    const result = await withPortalSafetyLease(portalData, lease => lease, {
      deployedWeb: true,
      tauri: false,
      fetchImpl: (async () => {
        fetched = true;
        return response({});
      }) as unknown as typeof fetch,
    });
    expect(fetched).toBe(false);
    expect(result.metadata).toEqual(portalData);
    expect(result.fingerprint).toBe(portalLocalMetadataFingerprint(portalData));
  });
});
