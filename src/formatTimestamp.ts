/**
 * 절대 시각 표기: `2026.08.02 23:09:59` (로컬 타임존).
 *
 * 워크트리가 여러 개일 때 "3시간 전 / 5시간 전"은 어느 쪽이 최신인지 매번 다시 계산하게 만들고,
 * 화면을 열어둔 채로는 값이 낡는다. 정렬·비교가 목적이므로 절대 시각을 1순위로 보여준다.
 */
export function formatAbsoluteTimestamp(
  value: string | number | Date | null | undefined,
): string {
  if (value === null || value === undefined || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
