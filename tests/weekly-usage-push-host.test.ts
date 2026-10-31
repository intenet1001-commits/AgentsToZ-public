// 「휴대폰 알림」 for the weekly allowance on the Mac side (src/weeklyUsagePushHost.ts): OFF by default, the next alert state
// stored before anything is handed over, nothing handed over twice, and the hand-off file AgentsToZ Screen reads
// (native/screen-control WeeklyUsageOutbox.swift) byte for byte the one in Tests/PushContract/vectors.json.
import {afterEach, beforeEach, expect, test} from 'bun:test';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeWeeklyUsageRequest, type WeeklyUsage} from '../src/weeklyUsage';
import {WeeklyUsageHost} from '../src/weeklyUsageHost';
import {WEEKLY_USAGE_PUSH_COPY, normalizeWeeklyUsagePushStatus, weeklyUsagePushNote} from '../src/weeklyUsagePush';
import {WEEKLY_USAGE_PUSH_FILE, WEEKLY_USAGE_PUSH_OUTBOX_LIMIT, WeeklyUsagePushHost} from '../src/weeklyUsagePushHost';
import type {WeeklyUsageAlert} from '../src/weeklyUsageAlerts';

const vectors = JSON.parse(readFileSync(join(import.meta.dir, '..', 'native', 'screen-control', 'Tests', 'PushContract', 'vectors.json'), 'utf8'));
/** The vector's moment; the reset an hour-key away from it is the vector's window `r498056`. */
const NOW: number = vectors.eventAt;
const RESET = 498056 * 3600;

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'weekly-usage-push-')); chmodSync(dir, 0o700); });
afterEach(() => { chmodSync(dir, 0o700); rmSync(dir, {recursive: true, force: true}); });

const root = () => join(dir, 'weekly-usage');
const stored = () => JSON.parse(readFileSync(join(root(), WEEKLY_USAGE_PUSH_FILE), 'utf8'));
const codex = (remaining: number, at = NOW): WeeklyUsage[] => [
  {provider: 'claude', buckets: [], checkedAt: null, source: 'unavailable', connected: false, canConnect: true},
  {provider: 'codex', buckets: [{label: '주간', remainingPercent: remaining, resetsAt: RESET}], checkedAt: new Date(at).toISOString(), source: 'live', connected: true, canConnect: false},
];
function host(over: Partial<ConstructorParameters<typeof WeeklyUsagePushHost>[0]> = {}) {
  let now = NOW;
  const delivered: {alert: WeeklyUsageAlert; observedAt: number; storedMark: unknown}[] = [];
  const logs: string[] = [];
  const h = new WeeklyUsagePushHost({
    root: root(), now: () => now, log: m => logs.push(m),
    // What a send would see: the stored state, read from disk at the moment of the hand-off.
    deliver: (alert, observedAt) => { delivered.push({alert, observedAt, storedMark: stored().state.providers[alert.provider]?.mark}); },
    ...over,
  });
  return {h, delivered, logs, at: (t: number) => { now = t; }};
}

test('the request: read the switch, or set it; nothing else', () => {
  expect(normalizeWeeklyUsageRequest({operation: 'alerts'})).toEqual({operation: 'alerts'});
  expect(normalizeWeeklyUsageRequest({operation: 'alerts', enabled: true})).toEqual({operation: 'alerts', enabled: true});
  expect(normalizeWeeklyUsageRequest({operation: 'alerts', enabled: false})).toEqual({operation: 'alerts', enabled: false});
  for (const bad of [{operation: 'alerts', enabled: 'true'}, {operation: 'alerts', enabled: 1}, {operation: 'alerts', enabled: true, provider: 'codex'},
    {operation: 'alerts', endpoint: 'https://x'}, {operation: 'alert'}]) expect(() => normalizeWeeklyUsageRequest(bad)).toThrow();
  expect(normalizeWeeklyUsageRequest({operation: 'status'})).toEqual({operation: 'status'});
});

test('OFF by default: readings are not stepped, stored or handed over', async () => {
  const {h, delivered} = host();
  expect(await h.status()).toEqual({enabled: false, screen: {state: 'missing'}});
  expect(await h.observe(codex(95))).toEqual([]);
  expect(await h.observe(codex(5))).toEqual([]);
  expect(delivered).toEqual([]);
  expect(existsSync(join(root(), WEEKLY_USAGE_PUSH_FILE))).toBe(false);
  // A damaged file never turns it on.
  mkdirSync(root(), {mode: 0o700});
  writeFileSync(join(root(), WEEKLY_USAGE_PUSH_FILE), '{"version":1,"enabled":true}');
  expect((await h.status()).enabled).toBe(false);
  expect(await h.observe(codex(5))).toEqual([]);
});

test('on: a silent baseline, then each boundary once — stored before it is handed over', async () => {
  const {h, delivered} = host();
  expect(await h.perform({operation: 'alerts', enabled: true})).toEqual({enabled: true, screen: {state: 'missing'}});
  expect(stored()).toEqual({version: 1, enabled: true, state: null});
  expect(statSync(join(root(), WEEKLY_USAGE_PUSH_FILE)).mode & 0o777).toBe(0o600);
  expect(statSync(root()).mode & 0o777).toBe(0o700);

  expect(await h.observe(codex(64))).toEqual([]); // what was used before turning on is not news
  const alerts = await h.observe(codex(28));
  expect(alerts.map(a => a.key)).toEqual(['codex:r498056:30']); // a jump across three boundaries is one alert
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({observedAt: NOW, storedMark: 30}); // the hand-off saw the new state already on disk
  expect(await h.observe(codex(27))).toEqual([]);
  expect(await h.observe(codex(31))).toEqual([]); // swinging back over a boundary says nothing again
  expect((await h.observe(codex(0))).map(a => a.mark)).toEqual([0]);
  expect(delivered.map(d => d.alert.key)).toEqual(['codex:r498056:30', 'codex:r498056:0']);
});

test('a hand-off that fails is not tried again; the next reading stays quiet', async () => {
  let attempts = 0;
  const {h, logs} = host({deliver: () => { attempts++; throw Error('Screen 폴더에 쓰지 못했습니다.'); }});
  await h.setEnabled(true);
  await h.observe(codex(64));
  expect((await h.observe(codex(48))).map(a => a.key)).toEqual(['codex:r498056:50']);
  expect(attempts).toBe(1);
  expect(logs.join('\n')).toContain('codex:r498056:50 not handed over');
  expect(await h.observe(codex(48))).toEqual([]);
  expect(await h.observe(codex(45))).toEqual([]);
  expect(attempts).toBe(1);
  expect(stored().state.providers.codex.mark).toBe(50);
});

test('if the state cannot be stored nothing is handed over, and the next reading says it once', async () => {
  const {h, delivered} = host();
  await h.setEnabled(true);
  await h.observe(codex(64));
  chmodSync(root(), 0o755); // not private any more: the host refuses to write there
  await expect(h.observe(codex(18))).rejects.toThrow();
  expect(delivered).toEqual([]);
  chmodSync(root(), 0o700);
  expect((await h.observe(codex(18))).map(a => a.key)).toEqual(['codex:r498056:20']);
  expect(delivered).toHaveLength(1);
});

test('turning off forgets the state and drops waiting hand-offs; turning on again starts from a new baseline', async () => {
  const {h} = host({deliver: undefined});
  await h.setEnabled(true);
  await h.observe(codex(64));
  await h.observe(codex(55));
  const outbox = join(root(), 'push-outbox');
  expect(readdirSync(outbox)).toHaveLength(1);
  writeFileSync(join(outbox, 'notes.txt'), 'not ours');
  expect(await h.perform({operation: 'alerts', enabled: false})).toMatchObject({enabled: false});
  expect(stored()).toEqual({version: 1, enabled: false, state: null});
  expect(readdirSync(outbox)).toEqual(['notes.txt']);
  await h.setEnabled(true);
  expect(await h.observe(codex(12))).toEqual([]);
  expect(readdirSync(outbox)).toEqual(['notes.txt']);
});

test('the hand-off file is the bytes AgentsToZ Screen reads (vectors.json weeklyUsage.handoff)', async () => {
  const {h} = host({deliver: undefined});
  await h.setEnabled(true);
  await h.observe(codex(64));
  await h.observe(codex(28));
  const outbox = join(root(), 'push-outbox');
  const [name, ...rest] = readdirSync(outbox);
  expect(rest).toEqual([]);
  expect(name).toMatch(/^1792999999000-codex-30-[0-9a-f]{8}\.json$/);
  expect(Buffer.byteLength(name!)).toBeLessThanOrEqual(96);
  expect(readFileSync(join(outbox, name!), 'utf8')).toBe(vectors.weeklyUsage.handoff);
  expect(statSync(join(outbox, name!)).mode & 0o777).toBe(0o600);
  expect(statSync(outbox).mode & 0o777).toBe(0o700);
  // The vector's relay message carries the same provider, boundary and window.
  expect(vectors.weeklyUsage).toMatchObject({provider: 2, mark: 30, windowKey: 'r498056'});
});

test('the outbox is bounded: old hand-offs are dropped, a full one refuses instead of piling up', async () => {
  const {h, at} = host({deliver: undefined});
  const alert: WeeklyUsageAlert = {provider: 'claude', mark: 50, remainingPercent: 49, windowKey: 'r498056', resetsAt: RESET, key: 'claude:r498056:50'};
  for (let i = 0; i < WEEKLY_USAGE_PUSH_OUTBOX_LIMIT; i++) h.handOff(alert, NOW + i);
  const outbox = join(root(), 'push-outbox');
  expect(readdirSync(outbox)).toHaveLength(WEEKLY_USAGE_PUSH_OUTBOX_LIMIT);
  expect(() => h.handOff(alert, NOW + 100)).toThrow('가져가지 않고');
  expect(readdirSync(outbox)).toHaveLength(WEEKLY_USAGE_PUSH_OUTBOX_LIMIT);
  at(NOW + 2 * 3600_000 + 60_000); // AgentsToZ Screen would drop these unsent now
  h.handOff(alert, NOW + 2 * 3600_000 + 60_000);
  expect(readdirSync(outbox)).toEqual([expect.stringMatching(/^1793007259000-claude-50-/)]);
});

test("AgentsToZ Screen's own status file says whether it can send now (display only)", async () => {
  const path = join(dir, 'status.json');
  const {h} = host({screenStatusPath: path});
  expect((await h.status()).screen).toEqual({state: 'missing'});
  const write = (o: object) => writeFileSync(path, JSON.stringify({version: 1, pid: process.pid, power: 'on', viewing: false, devices: 2, capture: true, control: true, loginItem: 'on', updatedAt: NOW, ...o}));
  write({});
  expect((await h.status()).screen).toEqual({state: 'on', devices: 2});
  write({power: 'waiting', devices: 0});
  expect((await h.status()).screen).toEqual({state: 'waiting', devices: 0});
  write({pid: 2 ** 22 + 12345}); // no such process: it quit without removing its file
  expect((await h.status()).screen).toEqual({state: 'missing'});
  write({power: 'sleeping'});
  expect((await h.status()).screen).toEqual({state: 'missing'});
});

test('WeeklyUsageHost feeds every reading to the alerts and passes the switch through; without it the switch is refused', async () => {
  const seen: WeeklyUsage[][] = [];
  const requests: unknown[] = [];
  const make = (alerts?: ConstructorParameters<typeof WeeklyUsageHost>[0]['alerts']) => new WeeklyUsageHost({
    appDataDir: dir, home: dir, python: null, available: () => false,
    codex: async () => ({rateLimits: {secondary: {used_percent: 72, window_minutes: 10080, resets_at: RESET}}, checkedAt: new Date(NOW).toISOString()}),
    ...(alerts ? {alerts} : {}),
  });
  const usage = make({observe: async items => { seen.push(items); }, perform: async request => { requests.push(request); return {enabled: true, screen: {state: 'missing'}}; }});
  const items = await usage.status();
  expect(seen).toEqual([items]);
  expect(await usage.perform({operation: 'alerts', enabled: true})).toEqual({enabled: true, screen: {state: 'missing'}});
  expect(requests).toEqual([{operation: 'alerts', enabled: true}]);
  // A failing alert step is not the reading's failure.
  const failing = make({observe: async () => { throw Error('disk'); }, perform: async () => ({})});
  expect((await failing.status()).map(i => i.provider)).toEqual(['claude', 'codex', 'agy']);
  await expect(make().perform({operation: 'alerts'})).rejects.toThrow('휴대폰 알림');
});

test('the dock reads the answer strictly and says what a person needs', () => {
  expect(normalizeWeeklyUsagePushStatus({enabled: true, screen: {state: 'on', devices: 2}})).toEqual({enabled: true, screen: {state: 'on', devices: 2}});
  expect(normalizeWeeklyUsagePushStatus({enabled: false, screen: {state: 'missing'}})).toEqual({enabled: false, screen: {state: 'missing'}});
  for (const bad of [{}, {connected: true}, {enabled: 'yes', screen: {state: 'missing'}}, {enabled: true, screen: {state: 'on'}},
    {enabled: true, screen: {state: 'on', devices: -1}}, {enabled: true, screen: {state: 'missing', devices: 1}},
    {enabled: true, screen: {state: 'on', devices: 2}, account: 'a@b.c'}]) expect(normalizeWeeklyUsagePushStatus(bad)).toBeNull();
  expect(weeklyUsagePushNote({enabled: true, screen: {state: 'on', devices: 2}})).toBe('AgentsToZ Screen으로 보냅니다 · 등록 기기 2대');
  expect(weeklyUsagePushNote({enabled: true, screen: {state: 'waiting', devices: 0}})).toContain('등록한 기기가 없어');
  expect(weeklyUsagePushNote({enabled: true, screen: {state: 'off', devices: 3}})).toContain('화면 제어를 켜 둔 동안만');
  expect(weeklyUsagePushNote({enabled: true, screen: {state: 'missing'}})).toContain('실행 중이 아니어서');
  expect(WEEKLY_USAGE_PUSH_COPY.shared).toContain('Mac 한 대에서만 켜세요');
});

test('the dock switch: shown only when the Mac app answers, OFF until turned on, styled with tokens only', () => {
  const tsx = readFileSync(join(import.meta.dir, '..', 'src', 'components', 'DockWeeklyUsage.tsx'), 'utf8');
  expect(tsx).toContain("{operation:'alerts'}");
  expect(tsx).toContain("{operation:'alerts',enabled}");
  expect(tsx).toContain('{push&&<div className="az-weekly__push"');
  expect(tsx).toContain('WEEKLY_USAGE_PUSH_COPY.shared');
  expect(tsx).toContain('checked={push.enabled}');
  const css = readFileSync(join(import.meta.dir, '..', 'src', 'components', 'AgentsToZVoiceDock.css'), 'utf8');
  const rules = css.split('\n').filter(line => line.startsWith('.az-weekly__push'));
  expect(rules.length).toBeGreaterThan(2);
  for (const rule of rules) expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  // The phone portal is untouched: the remote weekly DTO has no switch (normalizers there reject unknown keys).
  const remote = readFileSync(join(import.meta.dir, '..', 'src', 'weeklyUsageRemote.ts'), 'utf8');
  expect(remote).not.toMatch(/alerts|push/i);
});
