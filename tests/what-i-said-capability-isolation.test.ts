import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppDataDir } from '../src/appDataDir';
import { startTestApiServer } from './startTestApiServer';

const roots: string[] = [];
const children: Bun.Subprocess[] = [];
const CAPABILITY = '9'.repeat(64);

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('What-I-said management capability isolation', () => {
  test('a registered project process cannot inherit the Tauri-sidecar secret', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-capability-isolation-'));
    roots.push(home);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: join(home, '.config'),
      NODE_ENV: 'test',
      PORTMGR_ALLOWED_ORIGINS: '',
      PORTMGR_BUNDLED_SIDECAR: '1',
      PORTMGR_WHAT_I_SAID_CAPABILITY: CAPABILITY,
      AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    };
    const appDataDir = resolveAppDataDir(process.platform, env, home);
    env.APP_DATA_DIR = appDataDir;
    env.PORTMGR_PARENT_PID = String(process.pid);
    const projectPath = join(home, 'project');
    const resultPath = join(home, 'capability-result.txt');
    const commandPath = join(projectPath, 'check-capability.sh');
    mkdirSync(appDataDir, { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    const quotedResult = resultPath.replace(/'/g, `'"'"'`);
    writeFileSync(commandPath, [
      '#!/bin/bash',
      'if [ -n "${PORTMGR_WHAT_I_SAID_CAPABILITY:-}${APP_DATA_DIR:-}${PORTMGR_PARENT_PID:-}${PORTMGR_BUNDLED_SIDECAR:-}" ]; then',
      `  printf leaked > '${quotedResult}'`,
      'else',
      `  printf absent > '${quotedResult}'`,
      'fi',
      '',
    ].join('\n'));
    writeFileSync(join(appDataDir, 'ports.json'), JSON.stringify([{
      id: 'capability-check',
      name: 'Capability check',
      folderPath: projectPath,
      commandPath,
    }]));

    const { baseUrl, child } = await startTestApiServer({
      cwd: join(import.meta.dir, '..'),
      env,
    });
    children.push(child);
    const response = await fetch(`${baseUrl}/api/execute-command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        portId: 'capability-check',
        commandPath,
        folderPath: projectPath,
      }),
    });
    expect(response.status).toBe(200);
    for (let attempt = 0; attempt < 100 && !existsSync(resultPath); attempt += 1) {
      await Bun.sleep(20);
    }
    expect(readFileSync(resultPath, 'utf8')).toBe('absent');

    const source = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
    const capture = source.indexOf('const WHAT_I_SAID_MANAGEMENT_CAPABILITY');
    const removal = source.indexOf('delete process.env.PORTMGR_WHAT_I_SAID_CAPABILITY', capture);
    const appDataRemoval = source.indexOf('delete process.env.APP_DATA_DIR', removal);
    const firstRegisteredSpawn = source.indexOf('env: {\n            ...process.env', appDataRemoval);
    expect(capture).toBeGreaterThan(-1);
    expect(removal).toBeGreaterThan(capture);
    expect(appDataRemoval).toBeGreaterThan(removal);
    expect(firstRegisteredSpawn).toBeGreaterThan(appDataRemoval);
  });
});
