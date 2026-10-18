/**
 * 「에포트 자동」 is a host-owned, per-Mac setting (default ON): the Mac whose CLIs run decides, so starts from this
 * Mac's windows, a phone, the LAN page or another community device all follow it. It is changed only through the
 * local `effort` operation — no phone wire key, no capability-list slot.
 */
import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeAiTerminalRequest} from '../src/aiTerminalProtocol';
import {AiTerminalService} from '../src/aiTerminalService';
import {WORKROOM_EFFORT_SETTING_FILE, createWorkroomEffortSetting, isWorkroomEffortOperation, normalizeWorkroomEffortRequest} from '../src/workroomEffortSetting';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'effort-setting-')); dirs.push(dir); return dir; };

test('absent → ON (the user decision of 2026-10-16); a choice persists 0600 through an atomic rename', () => {
  const dir = temp(), setting = createWorkroomEffortSetting(dir);
  expect(setting.get()).toBe(true);
  expect(setting.set(false)).toBe(false);
  expect(setting.get()).toBe(false);
  const path = join(dir, WORKROOM_EFFORT_SETTING_FILE);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  expect(saved).toMatchObject({version: 1, auto: false});
  expect(typeof saved.updatedAt).toBe('string');
  expect(readdirSync(dir)).toEqual([WORKROOM_EFFORT_SETTING_FILE]); // no temp file left behind
  // Another process (a second sidecar on the same data folder) sees the same value: it is read, not cached.
  expect(createWorkroomEffortSetting(dir).get()).toBe(false);
  setting.set(true);
  expect(createWorkroomEffortSetting(dir).get()).toBe(true);
});

test('a damaged or foreign file falls back to the default ON, and a symlink is not followed', () => {
  const dir = temp(), path = join(dir, WORKROOM_EFFORT_SETTING_FILE), setting = createWorkroomEffortSetting(dir);
  writeFileSync(path, 'not json');
  expect(setting.get()).toBe(true);
  writeFileSync(path, JSON.stringify({version: 2, auto: false}));
  expect(setting.get()).toBe(true);
  rmSync(path);
  const elsewhere = join(dir, 'elsewhere.json');
  writeFileSync(elsewhere, JSON.stringify({version: 1, auto: false}));
  symlinkSync(elsewhere, path);
  expect(setting.get()).toBe(true);
});

test('strict local request shape', () => {
  expect(isWorkroomEffortOperation({operation: 'effort'})).toBe(true);
  expect(isWorkroomEffortOperation({operation: 'list'})).toBe(false);
  expect(normalizeWorkroomEffortRequest({operation: 'effort'})).toEqual({operation: 'effort'});
  expect(normalizeWorkroomEffortRequest({operation: 'effort', requestId: 'request-1234', set: false, sessionIds: ['session-1234']})).toEqual({operation: 'effort', set: false, sessionIds: ['session-1234']});
  for (const bad of [{operation: 'effort', set: 'false'}, {operation: 'effort', auto: true}, {operation: 'effort', sessionIds: 'x'},
    {operation: 'effort', sessionIds: Array.from({length: 25}, (_, i) => `session-${1000 + i}`)}, {operation: 'effort', sessionIds: ['../etc']}, {operation: 'effort', requestId: 'x'}])
    expect(() => normalizeWorkroomEffortRequest(bad)).toThrow();
  // Phones, the relay, the LAN page and community devices go through the terminal-v1 normalizer: it never parses `effort`.
  expect(() => normalizeAiTerminalRequest({operation: 'effort', requestId: 'request-1234'})).toThrow();
});

test('the service answers the local operation and refuses any remote authority or community owner', async () => {
  const dir = temp(), setting = createWorkroomEffortSetting(dir);
  const service = new AiTerminalService({resolveTarget: async () => ({cwd: dir}), executable: () => null, effortAuto: setting, activitySampler: false});
  try {
    expect(await service.performEffort({operation: 'effort'})).toEqual({effort: {auto: true, sessions: []}});
    expect(await service.performEffort({operation: 'effort', set: false})).toEqual({effort: {auto: false, sessions: []}});
    expect(setting.get()).toBe(false);
    await expect(service.performEffort({operation: 'effort', set: true}, {owner: 'internet:phone', targets: new Set()})).rejects.toThrow('이 Mac');
    await expect(service.performEffort({operation: 'effort', set: true}, undefined, {receiptOwner: 'community:other-mac'})).rejects.toThrow('이 Mac');
    expect(setting.get()).toBe(false);
  } finally { await service.shutdown(); }
});

test('a host without the setting never runs auto and says it cannot change it', async () => {
  const dir = temp();
  const service = new AiTerminalService({resolveTarget: async () => ({cwd: dir}), executable: () => null, activitySampler: false});
  try {
    expect(await service.performEffort({operation: 'effort'})).toEqual({effort: {auto: false, sessions: []}});
    await expect(service.performEffort({operation: 'effort', set: true})).rejects.toThrow();
  } finally { await service.shutdown(); }
});

test('three host-wide modes persist, migrate the old explicit choice and default to automatic selection',()=>{
 const dir=temp(),setting=createWorkroomEffortSetting(dir),other=createWorkroomEffortSetting(dir);
 expect(setting.getMode!()).toBe('auto');
 setting.set(false);expect(other.getMode!()).toBe('off');
 for(const mode of ['auto','recommend','off'] as const){setting.setMode!(mode);expect(other.getMode!()).toBe(mode);expect(other.get()).toBe(mode==='auto');expect(statSync(join(dir,WORKROOM_EFFORT_SETTING_FILE)).mode&0o777).toBe(0o600);}
 expect(JSON.parse(readFileSync(join(dir,WORKROOM_EFFORT_SETTING_FILE),'utf8'))).toMatchObject({version:2,mode:'off'});
});
test('the mode protocol is explicit and rejects mixed, unknown and legacy-only writes',()=>{
 for(const mode of ['auto','recommend','off'])expect(normalizeWorkroomEffortRequest({operation:'effort',effortModes:true,mode})).toEqual({operation:'effort',effortModes:true,mode} as never);
 for(const input of [{mode:'auto'},{effortModes:true,mode:'invalid'},{effortModes:true,mode:'off',set:false},{effortModes:false}])expect(()=>normalizeWorkroomEffortRequest({operation:'effort',...input})).toThrow();
});
