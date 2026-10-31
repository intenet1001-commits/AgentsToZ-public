/** A successful live Codex response without a weekly bucket is not a failed read. */
export function codexWeeklyUsageNoDataState(row: {
  provider: string; source: string; checkedAt: string | null; buckets: readonly unknown[];
}, now = Date.now()): 'current' | 'stale' | null {
  const checkedAt = Date.parse(row.checkedAt ?? '');
  if (row.provider !== 'codex' || row.source !== 'live' || row.buckets.length !== 0
    || !Number.isFinite(checkedAt) || checkedAt > now + 60_000) return null;
  return now - checkedAt > 15 * 60_000 ? 'stale' : 'current';
}

export function weeklyUsageCheckedAgo(checkedAt: string | null, now: number): string {
  const at = Date.parse(checkedAt ?? '');
  if (!Number.isFinite(at)) return '시각 미상';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
  return `${Math.floor(minutes / (24 * 60))}일 전`;
}
