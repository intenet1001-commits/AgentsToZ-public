import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppDataDir } from '../src/appDataDir';
import { portalLocalMetadataFingerprint } from '../src/portalLocalMetadata';
import { startTestApiServer } from './startTestApiServer';

const roots: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(options: { leaseTtlMs?: number; leaseGraceMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agentstoz-portal-safety-lease-'));
  roots.push(home);
  const env = {
    ...process.env,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
    NODE_ENV: 'test',
    PORTMGR_ALLOWED_ORIGINS: '',
    PORTMGR_BUNDLED_SIDECAR: '1',
    AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    PORTMGR_TEST_PORTAL_SAFETY_LEASE_TTL_MS: options.leaseTtlMs == null
      ? ''
      : String(options.leaseTtlMs),
    PORTMGR_TEST_PORTAL_SAFETY_LEASE_GRACE_MS: options.leaseGraceMs == null
      ? ''
      : String(options.leaseGraceMs),
  };
  const appDataDir = resolveAppDataDir(process.platform, env, home);
  mkdirSync(appDataDir, { recursive: true });
  const portalFile = join(appDataDir, 'portal.json');
  const metadataFile = join(appDataDir, 'portal-local-metadata.json');
  writeFileSync(portalFile, JSON.stringify({
    items: [],
    categories: [],
    localOnlyDeletedPortIds: ['stale-portal-copy'],
  }));
  writeFileSync(metadataFile, JSON.stringify({
    localOnlyDeletedPortIds: ['authoritative-deletion'],
    remoteDeletedPortIds: ['authoritative-remote-deletion'],
    verifiedLegacyGeneratedWorktreeIds: ['verified-worktree'],
  }));
  const { baseUrl, child } = await startTestApiServer({
    cwd: join(import.meta.dir, '..'),
    env,
  });
  children.push(child);
  return { baseUrl, metadataFile };
}

describe('portal safety lease API', () => {
  test('a held lease blocks marker mutation and only its exact token releases it', async () => {
    const { baseUrl, metadataFile } = await fixture();
    const acquireResponse = await fetch(`${baseUrl}/api/portal/safety-lease/acquire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(acquireResponse.status).toBe(200);
    expect(acquireResponse.headers.get('cache-control')).toBe('no-store');
    const acquired = await acquireResponse.json() as any;
    expect(acquired.success).toBe(true);
    expect(acquired.token).toMatch(/^[0-9a-f]{64}$/);
    expect(acquired.expiresInMs).toBe(120_000);
    expect(acquired.metadata).toEqual({
      localOnlyDeletedPortIds: ['authoritative-deletion'],
      remoteDeletedPortIds: ['authoritative-remote-deletion'],
      verifiedLegacyGeneratedWorktreeIds: ['verified-worktree'],
    });
    expect(acquired.fingerprint).toBe(portalLocalMetadataFingerprint(acquired.metadata));

    let markerSettled = false;
    const pendingMarker = fetch(`${baseUrl}/api/portal/local-metadata`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field: 'localOnlyDeletedPortIds',
        mode: 'add',
        ids: ['marker-waiting-for-lease'],
      }),
    }).finally(() => { markerSettled = true; });
    await Bun.sleep(100);
    expect(markerSettled).toBe(false);

    const wrongToken = `${acquired.token[0] === '0' ? '1' : '0'}${acquired.token.slice(1)}`;
    const wrongRenew = await fetch(`${baseUrl}/api/portal/safety-lease/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: wrongToken }),
    });
    expect(wrongRenew.status).toBe(200);
    expect(wrongRenew.headers.get('cache-control')).toBe('no-store');
    expect(await wrongRenew.json()).toEqual({ success: true, renewed: false, expiresInMs: 120_000 });
    await Bun.sleep(100);
    expect(markerSettled).toBe(false);

    const renewResponse = await fetch(`${baseUrl}/api/portal/safety-lease/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: acquired.token }),
    });
    expect(renewResponse.status).toBe(200);
    expect(renewResponse.headers.get('cache-control')).toBe('no-store');
    expect(await renewResponse.json()).toEqual({ success: true, renewed: true, expiresInMs: 120_000 });

    const wrongRelease = await fetch(`${baseUrl}/api/portal/safety-lease/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: wrongToken }),
    });
    expect(wrongRelease.status).toBe(200);
    expect(await wrongRelease.json()).toEqual({ success: true, released: false });
    await Bun.sleep(100);
    expect(markerSettled).toBe(false);

    const releaseResponse = await fetch(`${baseUrl}/api/portal/safety-lease/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: acquired.token }),
    });
    expect(releaseResponse.status).toBe(200);
    expect(releaseResponse.headers.get('cache-control')).toBe('no-store');
    expect(await releaseResponse.json()).toEqual({ success: true, released: true });

    const markerResponse = await pendingMarker;
    expect(markerResponse.status).toBe(200);
    expect((await markerResponse.json() as any).data.localOnlyDeletedPortIds).toEqual([
      'authoritative-deletion',
      'marker-waiting-for-lease',
    ]);
    expect(JSON.parse(readFileSync(metadataFile, 'utf8')).localOnlyDeletedPortIds).toEqual([
      'authoritative-deletion',
      'marker-waiting-for-lease',
    ]);

    const repeatedRelease = await fetch(`${baseUrl}/api/portal/safety-lease/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: acquired.token }),
    });
    expect(repeatedRelease.status).toBe(200);
    expect(await repeatedRelease.json()).toEqual({ success: true, released: false });
  });

  test('renewal extends expiry from the last confirmed heartbeat', async () => {
    const { baseUrl } = await fixture({ leaseTtlMs: 300, leaseGraceMs: 100 });
    const acquireResponse = await fetch(`${baseUrl}/api/portal/safety-lease/acquire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const acquired = await acquireResponse.json() as any;
    expect(acquired.expiresInMs).toBe(300);

    let markerSettled = false;
    const pendingMarker = fetch(`${baseUrl}/api/portal/local-metadata`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field: 'localOnlyDeletedPortIds',
        mode: 'add',
        ids: ['blocked-past-original-expiry'],
      }),
    }).finally(() => { markerSettled = true; });

    await Bun.sleep(200);
    const renewResponse = await fetch(`${baseUrl}/api/portal/safety-lease/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: acquired.token }),
    });
    expect(await renewResponse.json()).toEqual({ success: true, renewed: true, expiresInMs: 300 });

    // More than the original TTL + grace (400ms) has elapsed, but less than a
    // fresh TTL since renewal. Without last-renew expiry this marker settles.
    await Bun.sleep(250);
    expect(markerSettled).toBe(false);

    const releaseResponse = await fetch(`${baseUrl}/api/portal/safety-lease/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: acquired.token }),
    });
    expect(await releaseResponse.json()).toEqual({ success: true, released: true });
    expect((await pendingMarker).status).toBe(200);
  });

  test('the one-shot resume grace keeps markers blocked and accepts a wake-up renew', async () => {
    const { baseUrl } = await fixture({ leaseTtlMs: 200, leaseGraceMs: 250 });
    const acquired = await (await fetch(`${baseUrl}/api/portal/safety-lease/acquire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })).json() as any;

    let markerSettled = false;
    const pendingMarker = fetch(`${baseUrl}/api/portal/local-metadata`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field: 'localOnlyDeletedPortIds',
        mode: 'add',
        ids: ['blocked-during-resume-grace'],
      }),
    }).finally(() => { markerSettled = true; });

    await Bun.sleep(250);
    expect(markerSettled).toBe(false);
    const renewed = await fetch(`${baseUrl}/api/portal/safety-lease/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: acquired.token }),
    });
    expect(await renewed.json()).toEqual({ success: true, renewed: true, expiresInMs: 200 });
    await Bun.sleep(100);
    expect(markerSettled).toBe(false);

    const released = await fetch(`${baseUrl}/api/portal/safety-lease/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: acquired.token }),
    });
    expect(await released.json()).toEqual({ success: true, released: true });
    expect((await pendingMarker).status).toBe(200);
  });

  test('an unrenewed lease releases after TTL plus the bounded resume grace', async () => {
    const { baseUrl } = await fixture({ leaseTtlMs: 200, leaseGraceMs: 200 });
    await fetch(`${baseUrl}/api/portal/safety-lease/acquire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    let markerSettled = false;
    const pendingMarker = fetch(`${baseUrl}/api/portal/local-metadata`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field: 'localOnlyDeletedPortIds',
        mode: 'add',
        ids: ['accepted-after-resume-grace'],
      }),
    }).finally(() => { markerSettled = true; });

    await Bun.sleep(250);
    expect(markerSettled).toBe(false);
    await Bun.sleep(225);
    expect(markerSettled).toBe(true);
    expect((await pendingMarker).status).toBe(200);
  });

  test('malformed or unexpected JSON fails without acquiring or releasing a lease', async () => {
    const { baseUrl } = await fixture();

    const missingJsonType = await fetch(`${baseUrl}/api/portal/safety-lease/acquire`, {
      method: 'POST',
      body: '{}',
    });
    expect(missingJsonType.status).toBe(415);
    expect((await missingJsonType.json() as any).code).toBe('PORTAL_SAFETY_LEASE_JSON_REQUIRED');

    const unexpectedAcquire = await fetch(`${baseUrl}/api/portal/safety-lease/acquire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'not-accepted-on-acquire' }),
    });
    expect(unexpectedAcquire.status).toBe(400);
    expect((await unexpectedAcquire.json() as any).code).toBe('PORTAL_SAFETY_LEASE_UNEXPECTED_FIELDS');

    const malformedToken = await fetch(`${baseUrl}/api/portal/safety-lease/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '../portal.json.lock' }),
    });
    expect(malformedToken.status).toBe(400);
    expect((await malformedToken.json() as any).code).toBe('PORTAL_SAFETY_LEASE_INVALID_TOKEN');

    const malformedRenewToken = await fetch(`${baseUrl}/api/portal/safety-lease/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '../portal.json.lock' }),
    });
    expect(malformedRenewToken.status).toBe(400);
    expect((await malformedRenewToken.json() as any).code).toBe('PORTAL_SAFETY_LEASE_INVALID_TOKEN');

    const unexpectedRenewField = await fetch(`${baseUrl}/api/portal/safety-lease/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'b'.repeat(64), path: '/tmp/portal.json.lock' }),
    });
    expect(unexpectedRenewField.status).toBe(400);
    expect((await unexpectedRenewField.json() as any).code).toBe('PORTAL_SAFETY_LEASE_UNEXPECTED_FIELDS');

    // Neither rejected request may leave the shared portal lock held.
    const markerResponse = await fetch(`${baseUrl}/api/portal/local-metadata`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field: 'localOnlyDeletedPortIds',
        mode: 'add',
        ids: ['accepted-after-rejections'],
      }),
    });
    expect(markerResponse.status).toBe(200);
  });
});
