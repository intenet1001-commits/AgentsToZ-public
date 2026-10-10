/**
 * The subscription's weekly allowance, reduced to one line for the Workroom footer.
 *
 * Codex reports up to two windows (`primary`/`secondary`) and which one is the
 * week depends on the plan — a Pro Lite account measured on 2026-09-26 had only
 * `primary` with `window_minutes: 10080`. So the week is picked by its window
 * length, never by slot. No weekly window means nothing to show, not a guess.
 */
export interface WorkroomWeeklyLimit { usedPercent: number; remainingPercent: number; resetsAt: number | null }

const WEEK_MINUTES = 10080;

type RateWindow = { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown } | null | undefined;

export function pickWeeklyLimit(rateLimits: { primary?: RateWindow; secondary?: RateWindow } | null | undefined): WorkroomWeeklyLimit | null {
  for (const window of [rateLimits?.primary, rateLimits?.secondary]) {
    if (!window || window.window_minutes !== WEEK_MINUTES) continue;
    const used = window.used_percent;
    if (typeof used !== 'number' || !Number.isFinite(used)) continue;
    const usedPercent = Math.max(0, Math.min(100, used));
    const resetsAt = typeof window.resets_at === 'number' && Number.isFinite(window.resets_at) ? window.resets_at : null;
    return { usedPercent, remainingPercent: Math.round((100 - usedPercent) * 10) / 10, resetsAt };
  }
  return null;
}

/** "9/30 13:25 초기화" in local time, or '' when the reset time is unknown. */
export function weeklyLimitResetLabel(resetsAt: number | null): string {
  if (resetsAt === null) return '';
  const date = new Date(resetsAt * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 초기화`;
}
