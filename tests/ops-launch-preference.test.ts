import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OPS_LAUNCH_PREFERENCE_FILE,opsLaunchPreferenceFromOpen,readOpsLaunchPreference,writeOpsLaunchPreference} from '../src/opsLaunchPreference';

const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const appData=()=>{const dir=mkdtempSync(join(tmpdir(),'ops-launch-preference-'));dirs.push(dir);return dir;};

test('the AI this device last opened OPS with survives a restart and is private to the user',()=>{
  const dir=appData();
  expect(readOpsLaunchPreference(dir)).toBeNull();
  expect(writeOpsLaunchPreference(dir,{agent:'agy',surface:'workroom'},new Date('2026-09-29T00:00:00Z'))).toEqual({agent:'agy',surface:'workroom',updatedAt:'2026-09-29T00:00:00.000Z'});
  expect(readOpsLaunchPreference(dir)).toEqual({agent:'agy',surface:'workroom',updatedAt:'2026-09-29T00:00:00.000Z'});
  if(process.platform!=='win32')expect(statSync(join(dir,OPS_LAUNCH_PREFERENCE_FILE)).mode&0o077).toBe(0);
  writeOpsLaunchPreference(dir,{agent:'claude',surface:'app'});
  expect(readOpsLaunchPreference(dir)).toMatchObject({agent:'claude',surface:'app'});
});

test('unknown or impossible combinations are never stored, and a damaged file reads as no preference',()=>{
  const dir=appData();
  for(const bad of [{agent:'gpt',surface:'workroom'},{agent:'codex',surface:'buzz'},{agent:'agy',surface:'shell'},{agent:1,surface:'workroom'}])expect(writeOpsLaunchPreference(dir,bad)).toBeNull();
  expect(readOpsLaunchPreference(dir)).toBeNull();
  writeFileSync(join(dir,OPS_LAUNCH_PREFERENCE_FILE),'{not json');expect(readOpsLaunchPreference(dir)).toBeNull();
  writeFileSync(join(dir,OPS_LAUNCH_PREFERENCE_FILE),JSON.stringify({agent:'gpt',surface:'app'}));expect(readOpsLaunchPreference(dir)).toBeNull();
  writeFileSync(join(dir,OPS_LAUNCH_PREFERENCE_FILE),JSON.stringify({agent:'hermes',surface:'orca-floating',updatedAt:5}));expect(readOpsLaunchPreference(dir)).toEqual({agent:'hermes',surface:'orca-floating',updatedAt:''});
  expect(readFileSync(join(dir,OPS_LAUNCH_PREFERENCE_FILE),'utf8')).toContain('hermes');
});

test('only a confirmed OPS open with an AI becomes the preference',()=>{
  expect(opsLaunchPreferenceFromOpen({action:'start-workroom-session',agent:'agy'},{performed:true})).toEqual({agent:'agy',surface:'workroom'});
  expect(opsLaunchPreferenceFromOpen({action:'open-code-app',agent:'claude',surface:'app'},{performed:true})).toEqual({agent:'claude',surface:'app'});
  expect(opsLaunchPreferenceFromOpen({action:'open-code-app',agent:'agy',surface:'orca-worktree'},{performed:true})).toEqual({agent:'agy',surface:'orca-worktree'});
  // Buzz has no AI; an unconfirmed or failed open is not a choice the user saw work.
  expect(opsLaunchPreferenceFromOpen({action:'open-buzz-dev'},{performed:true})).toBeNull();
  expect(opsLaunchPreferenceFromOpen({action:'start-workroom-session',agent:'agy'},{performed:false})).toBeNull();
  expect(opsLaunchPreferenceFromOpen({action:'start-workroom-session',agent:'agy'},{success:false} as {performed?:unknown})).toBeNull();
});

test('Antigravity app (launch only) is a valid OPS choice once it was confirmed',()=>{
  const dir=appData();
  expect(writeOpsLaunchPreference(dir,{agent:'agy',surface:'app'},new Date('2026-10-08T00:00:00Z'))).toEqual({agent:'agy',surface:'app',updatedAt:'2026-10-08T00:00:00.000Z'});
  expect(readOpsLaunchPreference(dir)).toMatchObject({agent:'agy',surface:'app'});
  expect(opsLaunchPreferenceFromOpen({action:'open-code-app',agent:'agy',surface:'app'},{performed:true})).toEqual({agent:'agy',surface:'app'});
  expect(opsLaunchPreferenceFromOpen({action:'open-code-app',agent:'agy'},{performed:true})).toEqual({agent:'agy',surface:'app'});
  // performed but the launch was not confirmed (open past its deadline): not remembered.
  expect(opsLaunchPreferenceFromOpen({action:'open-code-app',agent:'agy',surface:'app'},{performed:true,launchVerified:false})).toBeNull();
  expect(opsLaunchPreferenceFromOpen({action:'open-code-app',agent:'agy',surface:'app'},{performed:true,launchVerified:true})).toEqual({agent:'agy',surface:'app'});
});
