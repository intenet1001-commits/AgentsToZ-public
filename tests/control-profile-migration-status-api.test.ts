import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startTestApiServer} from './startTestApiServer';

// Review finding 7, through the real API: the desktop status carries the last OPS folder rename outcome
// as its own optional field. The profile object is unchanged — the remote ops.status DTO is built from
// the store's status and its keys are a wire contract.
const children: Bun.Subprocess[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill(); await child.exited; }
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

async function server(record?: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'control-profile-migration-status-'));
  dirs.push(home);
  const data = join(home, 'app-data');
  mkdirSync(join(data, 'control-profile'), {recursive: true});
  if (record !== undefined) writeFileSync(join(data, 'control-profile', 'ops-folder-rename-last.json'), JSON.stringify(record), {mode: 0o600});
  const env = {...process.env, HOME: home, APP_DATA_DIR: data, NODE_ENV: 'test', AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP: '1', AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1', AGENTSTOZ_SKIP_HERMES_SYNC: '1'};
  const {baseUrl, child} = await startTestApiServer({cwd: join(import.meta.dir, '..'), env});
  children.push(child);
  return await fetch(`${baseUrl}/api/control-profile/status`).then(response => response.json()) as any;
}

test('the desktop status carries the last rename outcome beside the profile, not inside it', async () => {
  const record = {status: 'skipped', reason: 'folder-in-use', blocking: [{pid: 4242, command: 'agy'}], at: '2026-09-29T01:02:03.004Z'};
  const status = await server(record);
  expect(status.success).toBe(true);
  expect(status.opsFolderMigration).toEqual(record);
  expect(status.profile.opsFolderMigration).toBeUndefined();
});

test('no record (or an unreadable one) leaves the field out', async () => {
  expect((await server()).opsFolderMigration).toBeUndefined();
  expect((await server({status: 'rm -rf', at: 7})).opsFolderMigration).toBeUndefined();
});
