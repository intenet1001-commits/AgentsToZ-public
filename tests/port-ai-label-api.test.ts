import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireOwnedFileLock } from '../src/portalFileLock';
import { startTestApiServer } from './startTestApiServer';

const original = { id: 'p1', name: 'Original', folderPath: '/project', aiName: 'Old', category: 'Work', description: 'Details' };
const patch = (id = 'p1') => ({
  id,
  expected: { name: original.name, folderPath: original.folderPath, aiName: original.aiName, category: original.category, description: original.description },
  desired: { aiName: 'New label', category: 'Tools' },
});

test('AI label API checks latest disk state under the shared lock and never overwrites stale fields or recreates rows', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentstoz-ai-label-api-'));
  const appData = join(directory, 'app-data');
  mkdirSync(appData);
  const portsFile = join(appData, 'ports.json');
  const backupFile = join(appData, 'ports.json.bak');
  writeFileSync(portsFile, JSON.stringify([original, { ...original, id: 'changed' }, { ...original, id: 'deleted' }]));
  let child: Bun.Subprocess | undefined;
  let release: (() => void) | undefined;
  try {
    const server = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        HOME: directory, APP_DATA_DIR: appData,
        APPDATA: join(directory, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(directory, '.config'),
        AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1', AGENTSTOZ_SKIP_HERMES_SYNC: '1',
        PORTMGR_BUNDLED_SIDECAR: '0', PORTMGR_PARENT_PID: '0', PORTMGR_ALLOWED_ORIGINS: '',
      },
    });
    child = server.child;
    // Drain this isolated child's logs; never dump an ambient app configuration.
    const stdout = new Response(child.stdout as ReadableStream).text();
    const stderr = new Response(child.stderr as ReadableStream).text();
    void stdout.catch(() => {}); void stderr.catch(() => {});
    const send = (body: unknown, origin = 'tauri://localhost') => fetch(`${server.baseUrl}/api/ports/ai-labels`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
    });

    release = await acquireOwnedFileLock(join(appData, 'ports.json.lock'), { label: 'ports.json' });
    let settled = false;
    const batch = { patches: [patch(), patch('changed'), patch('deleted')] };
    const pending = send(batch).finally(() => { settled = true; });
    await Bun.sleep(100);
    expect(settled).toBe(false);
    const current = [
      { id: 'windows', name: 'Keep other platform', folderPath: 'C:\\projects\\keep', future: { keep: true } },
      { ...original, memo: 'Concurrent memo', favorite: true, syncGeneration: '9007199254740993' },
      { ...original, id: 'changed', category: 'User choice' },
      { id: 'new', name: 'New row while request waits' },
    ];
    const latestBytes = JSON.stringify(current, null, 2);
    writeFileSync(portsFile, latestBytes);
    release(); release = undefined;
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json();
    expect(result).toMatchObject({ success: true, appliedIds: ['p1'], unchangedIds: [], skipped: [
      { id: 'changed', reason: 'changed', fields: ['category'] },
      { id: 'deleted', reason: 'missing', fields: [] },
    ] });
    const expected = [current[0], { ...current[1], aiName: 'New label', category: 'Tools' }, current[2], current[3]];
    expect(result.ports).toEqual(expected);
    expect(JSON.parse(readFileSync(portsFile, 'utf8'))).toEqual(expected);
    expect(readFileSync(backupFile, 'utf8')).toBe(latestBytes);
    expect(existsSync(join(appData, 'ports.json.lock'))).toBe(false);

    // Source UI is subject to the same guard; a partial-success retry writes nothing.
    const committed = readFileSync(portsFile, 'utf8');
    const replay = await send(batch, 'http://localhost:9000');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ appliedIds: [], unchangedIds: ['p1'] });
    expect(readFileSync(portsFile, 'utf8')).toBe(committed);
    expect(readFileSync(backupFile, 'utf8')).toBe(latestBytes);

    // A user's later label edit cannot be mistaken for an idempotent replay.
    const userRows = structuredClone(expected);
    Object.assign(userRows[1]!, { aiName: 'User renamed later' });
    const userBytes = JSON.stringify(userRows);
    writeFileSync(portsFile, userBytes);
    const later = await send({ patches: [patch()] });
    expect(await later.json()).toMatchObject({ appliedIds: [], unchangedIds: [], skipped: [{ id: 'p1', reason: 'changed' }] });
    expect(readFileSync(portsFile, 'utf8')).toBe(userBytes);

    // Validation is all-or-nothing, before the shared write lock is touched.
    const invalid = await send({ patches: [patch(), { ...patch('new'), desired: { aiName: 'Would apply', category: '' } }] });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'PORT_AI_LABELS_INVALID_REQUEST' });
    expect(readFileSync(portsFile, 'utf8')).toBe(userBytes);
    expect(readFileSync(backupFile, 'utf8')).toBe(latestBytes);

    const foreign = await send({ patches: [patch()] }, 'https://untrusted.example');
    expect(foreign.status).toBe(403);
    expect(readFileSync(portsFile, 'utf8')).toBe(userBytes);
    const wrongMethod = await fetch(`${server.baseUrl}/api/ports/ai-labels`, { headers: { Origin: 'tauri://localhost' } });
    expect(wrongMethod.status).toBe(405);

    // A damaged file is never interpreted as an empty registration list.
    writeFileSync(portsFile, '{damaged');
    const corrupted = await send({ patches: [patch()] });
    expect(corrupted.status).toBe(500);
    expect(await corrupted.json()).toEqual({ error: 'PORT_AI_LABELS_SAVE_FAILED' });
    expect(readFileSync(portsFile, 'utf8')).toBe('{damaged');
    expect(readFileSync(backupFile, 'utf8')).toBe(latestBytes);
    expect(existsSync(join(appData, 'ports.json.lock'))).toBe(false);

    const longLabel = 'Existing long descriptive name '.repeat(6);
    const refreshRow = { ...original, aiName: longLabel, category: undefined, memo: 'Preserve this too' };
    writeFileSync(portsFile, JSON.stringify([refreshRow]));
    const refresh = await send({ patches: [{
      ...patch(), expected: { ...patch().expected, aiName: longLabel, category: null }, desired: { category: 'Tools' },
    }] });
    expect(refresh.status).toBe(200);
    const refreshResult = await refresh.json();
    expect(refreshResult.appliedIds).toEqual(['p1']);
    expect(refreshResult.ports).toEqual([{ ...refreshRow, category: 'Tools' }]);
    expect(JSON.parse(readFileSync(portsFile, 'utf8'))).toEqual([{ ...refreshRow, category: 'Tools' }]);
  } finally {
    release?.();
    if (child) {
      try { child.kill(); } catch {}
      const forceExit = setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} }, 2_000);
      try { await child.exited; } finally { clearTimeout(forceExit); }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
