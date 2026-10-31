/**
 * The weekly-usage alert machine (pure; the push transport comes later): every 10-point boundary of remaining once per weekly
 * window plus 「소진」, on the figure the card shows, never from a first look, a reset, stale or unknown data — and its state is
 * what a host stores before sending, so nothing is announced twice after a restart.
 */
import {expect, test} from 'bun:test';
import {
  WEEKLY_USAGE_ALERT_INITIAL, normalizeWeeklyUsageAlertState, stepWeeklyUsageAlerts, weeklyUsageAlertLabel, weeklyUsageAlertMark, weeklyUsageIsoWeek,
  type WeeklyUsageAlertRow, type WeeklyUsageAlertState,
} from '../src/weeklyUsageAlerts';

const NOW = Date.parse('2026-10-29T03:00:00.000Z');
const RESET = 1793664000; // 2026-11-03 09:00 KST — Claude's fixed weekly anchor, sampled twice 14 days apart.
const HOUR = 3600_000;
const codex = (remaining: number, at = NOW, resetsAt: number | null = RESET): WeeklyUsageAlertRow =>
  ({provider: 'codex', buckets: [{label: '주간', remainingPercent: remaining, resetsAt}], checkedAt: new Date(at).toISOString(), connected: true});

/** Feeds readings one after another and returns the labels announced at each step. */
function run(readings: {rows: WeeklyUsageAlertRow[]; now?: number}[], start: WeeklyUsageAlertState | null = null) {
  let state = start;
  const said: string[][] = [];
  for (const r of readings) {
    const {nextState, alerts} = stepWeeklyUsageAlerts(state, r.rows, r.now ?? NOW);
    state = nextState;
    said.push(alerts.map(a => `${a.provider} ${weeklyUsageAlertLabel(a)}`));
  }
  return {said, state: state!};
}

test('marks: below each boundary 90…10, and 소진 only at 0', () => {
  expect([100, 90, 89.9, 85, 80, 79.9, 10, 9.9, 0.1, 0].map(weeklyUsageAlertMark)).toEqual([100, 100, 90, 90, 90, 80, 20, 10, 10, 0]);
  expect(weeklyUsageAlertLabel({mark: 80})).toBe('80% 미만');
  expect(weeklyUsageAlertLabel({mark: 0})).toBe('소진');
});

test('a first look is a silent baseline; crossing 80 is said once; small swings around it say nothing', () => {
  const {said, state} = run([85, 79.9, 79.9, 81, 79, 80.5, 79.5].map(v => ({rows: [codex(v)]})));
  expect(said).toEqual([[], ['codex 80% 미만'], [], [], [], [], []]);
  expect(state.providers.codex).toMatchObject({mark: 80, remaining: 79.5, windowKey: `r${Math.round(RESET / 3600)}`});
});

test('a jump across several boundaries is one alert for where it landed; 0 is 소진, once', () => {
  expect(run([75, 52, 51, 0, 0].map(v => ({rows: [codex(v)]}))).said).toEqual([[], ['codex 60% 미만'], [], ['codex 소진'], []]);
  // The alert names its window and boundary, the key a collapse id can be built from.
  const {alerts} = stepWeeklyUsageAlerts(run([{rows: [codex(75)]}]).state, [codex(52)], NOW);
  expect(alerts).toEqual([{provider: 'codex', mark: 60, remainingPercent: 52, windowKey: `r${Math.round(RESET / 3600)}`, resetsAt: RESET, key: `codex:r${Math.round(RESET / 3600)}:60`}]);
});

test('stale or unknown data says nothing and leaves the baseline; the next fresh reading in the window says the drop once', () => {
  const base = run([{rows: [codex(75)]}]).state;
  const stale = stepWeeklyUsageAlerts(base, [codex(40, NOW - 16 * 60_000)], NOW);
  expect(stale.alerts).toEqual([]);
  expect(stale.nextState).toEqual(base);
  for (const rows of [[], [{...codex(40), buckets: []}], [{...codex(40), checkedAt: null}], [{...codex(40), checkedAt: new Date(NOW + 5 * 60_000).toISOString()}]] as WeeklyUsageAlertRow[][]) {
    const step = stepWeeklyUsageAlerts(base, rows, NOW);
    expect(step.alerts).toEqual([]);
    expect(step.nextState).toEqual(base);
  }
  // A reset time that has passed is stale too (the old figure is no longer this week's).
  expect(stepWeeklyUsageAlerts(base, [codex(40, NOW, NOW / 1000 - 1)], NOW).alerts).toEqual([]);
  // 75 → 40 an hour later (remaining 40 is below 50, not below 40): one alert, for where it landed.
  expect(stepWeeklyUsageAlerts(base, [codex(40, NOW + HOUR)], NOW + HOUR).alerts.map(a => weeklyUsageAlertLabel(a))).toEqual(['50% 미만']);
});

test('a new weekly window re-baselines silently; a reset time that only wobbles is the same window', () => {
  const later = RESET + 7 * 24 * 3600;
  const {said, state} = run([
    {rows: [codex(30)]},
    {rows: [codex(25)]},
    // Reset: a later reset time by ≥ 1 h, remaining back up — not usage, nothing said.
    {rows: [codex(100, NOW, later)]},
    {rows: [codex(89, NOW, later)]},
    // A reset time 20 minutes off is the same window: 90 is not said again.
    {rows: [codex(88, NOW, later + 1200)]},
  ]);
  expect(said).toEqual([[], ['codex 30% 미만'], [], ['codex 90% 미만'], []]);
  expect(state.providers.codex).toMatchObject({windowKey: `r${Math.round(later / 3600)}`, resetsAt: later, mark: 90});
  // A passed reset time with remaining risen is a new window even when the new reset time is under an hour later.
  const passed = NOW / 1000 - 600, next = NOW / 1000 + 1200;
  const before = run([{rows: [codex(30, NOW - 20 * 60_000, passed)], now: NOW - 20 * 60_000}]).state;
  expect(run([{rows: [codex(95, NOW, next)]}, {rows: [codex(85, NOW, next)]}], before).said).toEqual([[], ['codex 90% 미만']]);
});

test('without a reset time: the ISO week, and a new window only when the week changed and remaining rose 20 points', () => {
  const w45 = NOW + 7 * 24 * HOUR;
  const {said, state} = run([
    {rows: [codex(35, NOW, null)]},
    // Same week, rose 30: not trusted as a reset — the stored mark stays, nothing said.
    {rows: [codex(65, NOW, null)]},
    {rows: [codex(29, NOW, null)]},
    // Next week, rose only 15: the same window continues.
    {rows: [codex(44, w45, null)], now: w45},
    {rows: [codex(19, w45, null)], now: w45},
    // Next week, rose 51: a new window, silent; then 70 is said.
    {rows: [codex(70, w45, null)], now: w45},
    {rows: [codex(69, w45, null)], now: w45},
  ]);
  expect(said).toEqual([[], [], ['codex 30% 미만'], [], ['codex 20% 미만'], [], ['codex 70% 미만']]);
  expect(state.providers.codex?.windowKey).toBe('w2026-W45');
  // Switching between a known and an unknown reset time cannot be compared: a silent baseline.
  expect(run([{rows: [codex(50)]}, {rows: [codex(20, NOW, null)]}]).said).toEqual([[], []]);
});

test('per provider, on the lowest bucket — agy’s buckets are one figure, not three alerts', () => {
  const agy = (gemini: number, other: number): WeeklyUsageAlertRow => ({provider: 'agy', checkedAt: new Date(NOW).toISOString(), connected: true,
    buckets: [{label: 'Gemini', remainingPercent: gemini, resetsAt: RESET}, {label: 'Claude/GPT', remainingPercent: other, resetsAt: RESET - 3 * 24 * 3600}]});
  const claude = (remaining: number): WeeklyUsageAlertRow => ({...codex(remaining), provider: 'claude'});
  const {said} = run([
    {rows: [agy(95, 85), claude(95), codex(95)]},
    {rows: [agy(55, 84), claude(95), codex(85)]},
    {rows: [agy(54, 70), claude(79), codex(85)]},
  ]);
  expect(said).toEqual([[], ['codex 90% 미만', 'agy 60% 미만'].sort(byProvider), ['claude 80% 미만']]);
});
const order = ['claude', 'codex', 'agy'];
function byProvider(a: string, b: string) { return order.indexOf(a.split(' ')[0]!) - order.indexOf(b.split(' ')[0]!); }

test('the state is stored before sending: after a restart the same reading announces nothing again', () => {
  const first = stepWeeklyUsageAlerts(run([{rows: [codex(85)]}]).state, [codex(79)], NOW);
  expect(first.alerts).toHaveLength(1);
  const restored = normalizeWeeklyUsageAlertState(JSON.parse(JSON.stringify(first.nextState)));
  expect(restored).toEqual(first.nextState);
  expect(stepWeeklyUsageAlerts(restored, [codex(79)], NOW + 60_000).alerts).toEqual([]);
  // The input state is never changed in place.
  const frozen = JSON.stringify(first.nextState);
  stepWeeklyUsageAlerts(first.nextState, [codex(10)], NOW);
  expect(JSON.stringify(first.nextState)).toBe(frozen);
});

test('an unusable stored state is no state: every provider re-baselines silently', () => {
  const good = run([{rows: [codex(85)]}]).state;
  expect(normalizeWeeklyUsageAlertState(WEEKLY_USAGE_ALERT_INITIAL)).toEqual(WEEKLY_USAGE_ALERT_INITIAL);
  const window = good.providers.codex!;
  for (const bad of [
    null, [], {version: 2, providers: {}}, {version: 1}, {version: 1, providers: {}, extra: 1},
    {version: 1, providers: {gemini: window}},
    {version: 1, providers: {codex: {...window, mark: 85}}},
    {version: 1, providers: {codex: {...window, remaining: 101}}},
    {version: 1, providers: {codex: {...window, resetsAt: 0}}},
    {version: 1, providers: {codex: {...window, windowKey: '../x'}}},
    {version: 1, providers: {codex: {...window, observedAt: 'later'}}},
    {version: 1, providers: {codex: {...window, sent: true}}},
  ]) expect(normalizeWeeklyUsageAlertState(bad)).toBeNull();
  expect(stepWeeklyUsageAlerts(normalizeWeeklyUsageAlertState('garbage'), [codex(10)], NOW).alerts).toEqual([]);
});

test('ISO weeks (UTC) across year boundaries', () => {
  expect(weeklyUsageIsoWeek(NOW)).toBe('2026-W44');
  expect(weeklyUsageIsoWeek(Date.UTC(2026, 0, 1))).toBe('2026-W01');
  expect(weeklyUsageIsoWeek(Date.UTC(2021, 0, 3))).toBe('2020-W53');
  expect(weeklyUsageIsoWeek(Date.UTC(2024, 11, 30))).toBe('2025-W01');
  expect(weeklyUsageIsoWeek(Date.UTC(2027, 0, 3, 23, 59))).toBe('2026-W53');
});
