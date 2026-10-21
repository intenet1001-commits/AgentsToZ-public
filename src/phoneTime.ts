/**
 * One date-time format on the phone: 「10월 16일 14:04」 in the viewer's own time zone, with the year in
 * front only when it is not this year.
 *
 * The phone used four (production audit 2026-10-16): `toLocaleString()` follows the device region, so on an
 * English-region iPhone a Korean sentence read 「마지막 저장 10/16/2026, 2:04:05 PM」 (seconds in a list row too),
 * beside 「10/16 14:04」 (VOC), 「10-16 14:04」 (community) and 「2026. 10. 16.」 (OPS candidates).
 *
 * Built by hand rather than with Intl: engines disagree on the Korean pieces (오후 vs 24-hour), and this must read
 * the same in WebKit, Chromium and Bun. Self-contained — no imports, no module scope — like the functions the
 * same-Wi‑Fi QR page embeds with `toString()`. An unreadable value gives ''.
 */
export function phoneDateTime(value: string | number | Date, now: number = Date.now()): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = at.getFullYear() !== new Date(now).getFullYear() ? `${at.getFullYear()}년 ` : '';
  return `${year}${at.getMonth() + 1}월 ${at.getDate()}일 ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
