import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppDataDir } from '../src/appDataDir';
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

describe('portal-local metadata cross-process lock', () => {
  test('an API full write waits for the shared Tauri lock and preserves the newly committed sidecar', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-portal-lock-'));
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
    };
    const appDataDir = resolveAppDataDir(process.platform, env, home);
    mkdirSync(appDataDir, { recursive: true });
    const portalFile = join(appDataDir, 'portal.json');
    const metadataFile = join(appDataDir, 'portal-local-metadata.json');
    const lockFile = join(appDataDir, 'portal.json.lock');
    writeFileSync(portalFile, JSON.stringify({ items: [], categories: [] }));

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env,
    });
    children.push(child);

    // This is the same cross-process lock that the Tauri command holds while
    // committing its local-only safety metadata.
    writeFileSync(lockFile, '', { flag: 'wx', mode: 0o600 });
    let settled = false;
    const pendingWrite = fetch(`${baseUrl}/api/portal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ id: 'stale-bookmark' }],
        categories: [],
        localOnlyDeletedPortIds: [],
        remoteDeletedPortIds: [],
        verifiedLegacyGeneratedWorktreeIds: [],
      }),
    }).finally(() => { settled = true; });

    await Bun.sleep(100);
    expect(settled).toBe(false);
    writeFileSync(metadataFile, JSON.stringify({
      localOnlyDeletedPortIds: ['deleted-while-api-waited'],
      remoteDeletedPortIds: ['remote-deleted-while-api-waited'],
      verifiedLegacyGeneratedWorktreeIds: ['verified-while-api-waited'],
    }));
    unlinkSync(lockFile);

    const writeResponse = await pendingWrite;
    expect(writeResponse.status).toBe(200);
    const stored = JSON.parse(readFileSync(portalFile, 'utf8'));
    expect(stored).toMatchObject({
      localOnlyDeletedPortIds: ['deleted-while-api-waited'],
      remoteDeletedPortIds: ['remote-deleted-while-api-waited'],
      verifiedLegacyGeneratedWorktreeIds: ['verified-while-api-waited'],
    });

    const loaded = await (await fetch(`${baseUrl}/api/portal`)).json() as any;
    expect(loaded).toMatchObject({
      localOnlyDeletedPortIds: ['deleted-while-api-waited'],
      remoteDeletedPortIds: ['remote-deleted-while-api-waited'],
      verifiedLegacyGeneratedWorktreeIds: ['verified-while-api-waited'],
    });
  });

  test('cross-process add/add and add/remove deltas apply to the latest sidecar under one lock', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-portal-delta-lock-'));
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
    };
    const appDataDir = resolveAppDataDir(process.platform, env, home);
    mkdirSync(appDataDir, { recursive: true });
    const portalFile = join(appDataDir, 'portal.json');
    const metadataFile = join(appDataDir, 'portal-local-metadata.json');
    const lockFile = join(appDataDir, 'portal.json.lock');
    writeFileSync(portalFile, JSON.stringify({ items: [], categories: [] }));
    writeFileSync(metadataFile, JSON.stringify({
      localOnlyDeletedPortIds: ['existing'],
      remoteDeletedPortIds: ['remote-existing'],
      verifiedLegacyGeneratedWorktreeIds: [],
    }));

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env,
    });
    children.push(child);

    const runWhileOtherProcessCommits = async (
      mutation: { field: string; mode: string; ids: string[] },
      otherMetadata: Record<string, string[]>,
    ) => {
      writeFileSync(lockFile, 'simulated-tauri-owner', { flag: 'wx', mode: 0o600 });
      let settled = false;
      const pending = fetch(`${baseUrl}/api/portal/local-metadata`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mutation),
      }).finally(() => { settled = true; });
      await Bun.sleep(100);
      expect(settled).toBe(false);
      writeFileSync(metadataFile, JSON.stringify(otherMetadata));
      unlinkSync(lockFile);
      const response = await pending;
      expect(response.status).toBe(200);
      return (await response.json() as any).data;
    };

    const added = await runWhileOtherProcessCommits({
      field: 'localOnlyDeletedPortIds',
      mode: 'add',
      ids: ['api-added'],
    }, {
      localOnlyDeletedPortIds: ['existing', 'tauri-added'],
      remoteDeletedPortIds: ['remote-existing'],
      verifiedLegacyGeneratedWorktreeIds: [],
    });
    expect(added.localOnlyDeletedPortIds).toEqual(['existing', 'tauri-added', 'api-added']);
    expect(added.remoteDeletedPortIds).toEqual(['remote-existing']);

    const removed = await runWhileOtherProcessCommits({
      field: 'localOnlyDeletedPortIds',
      mode: 'remove',
      ids: ['existing'],
    }, {
      localOnlyDeletedPortIds: ['existing', 'tauri-added', 'api-added', 'second-tauri-add'],
      remoteDeletedPortIds: ['remote-existing'],
      verifiedLegacyGeneratedWorktreeIds: [],
    });
    expect(removed.localOnlyDeletedPortIds).toEqual([
      'tauri-added',
      'api-added',
      'second-tauri-add',
    ]);

    const accumulatedRemoteIds = Array.from({ length: 2_100 }, (_, index) => `remote-${index}`);
    const remoteAdded = await runWhileOtherProcessCommits({
      field: 'remoteDeletedPortIds',
      mode: 'add',
      ids: ['remote-2100'],
    }, {
      localOnlyDeletedPortIds: removed.localOnlyDeletedPortIds,
      remoteDeletedPortIds: accumulatedRemoteIds,
      verifiedLegacyGeneratedWorktreeIds: [],
    });
    expect(remoteAdded.remoteDeletedPortIds).toHaveLength(2_101);
    expect(remoteAdded.remoteDeletedPortIds[0]).toBe('remote-0');
    expect(remoteAdded.remoteDeletedPortIds.at(-1)).toBe('remote-2100');
    expect(JSON.parse(readFileSync(metadataFile, 'utf8')).remoteDeletedPortIds).toEqual(
      remoteAdded.remoteDeletedPortIds,
    );
    expect(JSON.parse(readFileSync(portalFile, 'utf8')).remoteDeletedPortIds).toEqual(
      remoteAdded.remoteDeletedPortIds,
    );
  });
});
