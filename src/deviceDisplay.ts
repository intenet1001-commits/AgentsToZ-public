export function formatDeviceLastPushAt(value: string | null | undefined, locale = 'ko-KR'): string {
  const timestamp = Date.parse(value ?? '');
  if (!Number.isFinite(timestamp)) return '최근 Push 기록 없음';
  return new Date(timestamp).toLocaleDateString(locale, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
