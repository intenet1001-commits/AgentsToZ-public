import type {WeeklyProvider} from './weeklyUsage';
import {WEEKLY_USAGE_REMOTE_PROVIDERS,remoteWeeklyUsageMinimum,remoteWeeklyUsageState,type RemoteWeeklyUsageRow} from './weeklyUsageRemote';

/**
 * When a weekly allowance is worth a phone alert (a per-Mac opt-in push through AgentsToZ Screen and the screen-push relay —
 * src/weeklyUsagePushHost.ts, docs/claude/remote-control.md 「문턱 알림 푸시」). Pure: no clock, no file, no transport. The host stores `nextState`
 * **before** it sends anything, so a send whose outcome is unknown is never repeated; an alert it could not send is lost, not
 * resent.
 *
 * Per provider, on the figure the Home card and the Mac dock show — the lowest remaining bucket (agy has up to three; alerting
 * per bucket would triple the pushes and announce a figure nobody sees):
 * - each 10-point boundary of remaining 90/80/…/10 is announced once per weekly window when remaining goes below it, and
 *   reaching 0 is a separate 「소진」;
 * - a jump across several boundaries is one alert, for the boundary it landed under (the skipped ones count as announced);
 * - a first observation, a new weekly window, or a provider that switches between a known and an unknown reset time sets a
 *   silent baseline; a stale, waiting or unknown row announces nothing and leaves the stored baseline as it was, so the next
 *   fresh reading in the same window is compared with it (a drop that happened while the CLI was idle is still said once);
 * - the stored mark only goes down inside a window — small swings around a boundary say nothing again.
 * Window: the latest reset time of the provider's buckets, keyed to the hour. A new window is a reset time later by at least
 * an hour, or a reset time that has passed with remaining risen. With no reset time at all: the ISO week (UTC), and a new
 * window only when the week changed **and** remaining rose by at least 20 points. When a window is unclear it re-baselines —
 * an alert may be missed, a reset is never announced as usage.
 */
export const WEEKLY_USAGE_ALERT_BOUNDARIES = [90, 80, 70, 60, 50, 40, 30, 20, 10] as const;
/** 100: above every boundary; 90…10: 「N% 미만」; 0: 소진. */
export type WeeklyUsageAlertMark = 100 | typeof WEEKLY_USAGE_ALERT_BOUNDARIES[number] | 0;
export interface WeeklyUsageAlertWindow {windowKey: string; resetsAt: number | null; mark: WeeklyUsageAlertMark; remaining: number; observedAt: string}
export interface WeeklyUsageAlertState {version: 1; providers: Partial<Record<WeeklyProvider, WeeklyUsageAlertWindow>>}
export interface WeeklyUsageAlert {
  provider: WeeklyProvider; mark: Exclude<WeeklyUsageAlertMark, 100>; remainingPercent: number; windowKey: string; resetsAt: number | null;
  /** `<provider>:<windowKey>:<mark>` — one per boundary per window (a collapse id can be built from it). */
  key: string;
}
export type WeeklyUsageAlertRow = Pick<RemoteWeeklyUsageRow, 'provider' | 'buckets' | 'checkedAt' | 'connected'>;
export const WEEKLY_USAGE_ALERT_INITIAL: WeeklyUsageAlertState = {version: 1, providers: {}};

const HOUR_S = 3600, RISE_WITHOUT_RESET = 20;
const MARKS: ReadonlySet<number> = new Set([100, ...WEEKLY_USAGE_ALERT_BOUNDARIES, 0]);

export function weeklyUsageAlertMark(remaining: number): WeeklyUsageAlertMark {
  if (remaining <= 0) return 0;
  for (let i = WEEKLY_USAGE_ALERT_BOUNDARIES.length - 1; i >= 0; i--) if (remaining < WEEKLY_USAGE_ALERT_BOUNDARIES[i]!) return WEEKLY_USAGE_ALERT_BOUNDARIES[i]!;
  return 100;
}
export function weeklyUsageAlertLabel(alert: Pick<WeeklyUsageAlert, 'mark'>): string {
  return alert.mark === 0 ? '소진' : `${alert.mark}% 미만`;
}

/** ISO 8601 week of `now` in UTC, e.g. 「2026-W44」. */
export function weeklyUsageIsoWeek(now: number): string {
  const d = new Date(now), weekday = (d.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - weekday + 3);
  const year = new Date(thursday).getUTCFullYear(), jan4 = new Date(Date.UTC(year, 0, 4));
  const firstThursday = Date.UTC(year, 0, 4 - (jan4.getUTCDay() + 6) % 7 + 3);
  return `${year}-W${String(1 + Math.round((thursday - firstThursday) / (7 * 86_400_000))).padStart(2, '0')}`;
}

const windowReset = (row: WeeklyUsageAlertRow): number | null => row.buckets.reduce<number | null>((latest, b) => b.resetsAt !== null && (latest === null || b.resetsAt > latest) ? b.resetsAt : latest, null);
const windowKey = (reset: number | null, now: number) => reset !== null ? `r${Math.round(reset / HOUR_S)}` : `w${weeklyUsageIsoWeek(now)}`;
function newWindow(stored: WeeklyUsageAlertWindow, remaining: number, reset: number | null, now: number): boolean {
  if (reset !== null && stored.resetsAt !== null) return reset - stored.resetsAt >= HOUR_S || stored.resetsAt * 1000 <= now && remaining > stored.remaining;
  if (reset === null && stored.resetsAt === null) return stored.windowKey !== windowKey(null, now) && remaining >= stored.remaining + RISE_WITHOUT_RESET;
  return true;
}

/** One sampling step over a `status()` (or `usage.weekly`) answer: the state to store first, then what to announce. */
export function stepWeeklyUsageAlerts(state: WeeklyUsageAlertState | null | undefined, rows: readonly WeeklyUsageAlertRow[], now: number): {nextState: WeeklyUsageAlertState; alerts: WeeklyUsageAlert[]} {
  const providers: WeeklyUsageAlertState['providers'] = {...(state?.providers ?? {})};
  const alerts: WeeklyUsageAlert[] = [];
  for (const provider of WEEKLY_USAGE_REMOTE_PROVIDERS) {
    const row = rows.find(r => r.provider === provider);
    if (!row || remoteWeeklyUsageState(row, now) !== 'ready') continue;
    const remaining = remoteWeeklyUsageMinimum(row)!.remainingPercent, reset = windowReset(row), mark = weeklyUsageAlertMark(remaining);
    const stored = providers[provider], observedAt = new Date(now).toISOString();
    if (!stored || newWindow(stored, remaining, reset, now)) {
      providers[provider] = {windowKey: windowKey(reset, now), resetsAt: reset, mark, remaining, observedAt};
      continue;
    }
    if (mark < stored.mark) {
      const announced = mark as WeeklyUsageAlert['mark'];
      alerts.push({provider, mark: announced, remainingPercent: remaining, windowKey: stored.windowKey, resetsAt: stored.resetsAt, key: `${provider}:${stored.windowKey}:${announced}`});
    }
    providers[provider] = {...stored, mark: mark < stored.mark ? mark : stored.mark, remaining, observedAt};
  }
  return {nextState: {version: 1, providers}, alerts};
}

/** Strict reader for a stored state. Anything unusable is null: the caller starts over, and every provider re-baselines silently. */
export function normalizeWeeklyUsageAlertState(value: unknown): WeeklyUsageAlertState | null {
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!plain(value) || value.version !== 1 || !plain(value.providers) || Object.keys(value).length !== 2) return null;
  const providers: WeeklyUsageAlertState['providers'] = {};
  for (const [provider, w] of Object.entries(value.providers)) {
    if (!(WEEKLY_USAGE_REMOTE_PROVIDERS as readonly string[]).includes(provider) || !plain(w) || Object.keys(w).length !== 5) return null;
    if (typeof w.windowKey !== 'string' || !/^(?:r\d{1,9}|w\d{4}-W\d{2})$/.test(w.windowKey)) return null;
    if (!(w.resetsAt === null || typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) && w.resetsAt > 0)) return null;
    if (typeof w.mark !== 'number' || !MARKS.has(w.mark) || typeof w.remaining !== 'number' || !Number.isFinite(w.remaining) || w.remaining < 0 || w.remaining > 100) return null;
    if (typeof w.observedAt !== 'string' || w.observedAt.length >= 80 || !Number.isFinite(Date.parse(w.observedAt))) return null;
    providers[provider as WeeklyProvider] = {windowKey: w.windowKey, resetsAt: w.resetsAt as number | null, mark: w.mark as WeeklyUsageAlertMark, remaining: w.remaining, observedAt: w.observedAt};
  }
  return {version: 1, providers};
}
