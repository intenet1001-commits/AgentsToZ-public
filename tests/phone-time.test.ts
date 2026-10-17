import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { phoneDateTime } from '../src/phoneTime';

// Production audit 2026-10-16: the phone printed four formats, and `toLocaleString()` followed the device region —
// on an English-region iPhone a Korean sentence read 「마지막 저장 10/16/2026, 2:04:05 PM」. One format everywhere.
describe('one date format on the phone', () => {
  test('「10월 16일 14:04」 in local time, the year only when it is not this year, no seconds', () => {
    const at = new Date(2026, 9, 16, 14, 4, 5);
    expect(phoneDateTime(at, new Date(2026, 0, 1).getTime())).toBe('10월 16일 14:04');
    expect(phoneDateTime(at.toISOString(), new Date(2026, 11, 31).getTime())).toBe('10월 16일 14:04');
    expect(phoneDateTime(at, new Date(2027, 0, 1).getTime())).toBe('2026년 10월 16일 14:04');
    expect(phoneDateTime(new Date(2026, 0, 3, 9, 7), new Date(2026, 5, 1).getTime())).toBe('1월 3일 09:07');
    expect(phoneDateTime(at.getTime(), new Date(2026, 0, 1).getTime())).toBe('10월 16일 14:04');
  });

  test('an unreadable value gives nothing, never 「Invalid Date」', () => {
    expect(phoneDateTime('not a date')).toBe('');
    expect(phoneDateTime('')).toBe('');
  });

  test('stands alone, like the functions the QR page embeds', () => {
    const isolated = new Function(`return (${phoneDateTime.toString()})`)();
    const at = new Date(2026, 9, 16, 14, 4);
    expect(isolated(at, new Date(2026, 0, 1).getTime())).toBe('10월 16일 14:04');
  });

  test('the phone screens that showed a date use it, not the device-region format', () => {
    const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
    for (const file of ['RemoteWorkroomHistoryPanel.tsx', 'RemoteVocHub.tsx', 'remoteCommunity.ts']) {
      expect(read(file)).toContain('phoneDateTime(');
      expect(read(file)).not.toMatch(/toLocale(?:Date)?String\(\)/);
    }
    const portal = read('remote-control-portal-main.tsx');
    expect(portal).toContain('phoneDateTime(candidate.createdAt)');
    expect(portal).not.toContain('new Date(candidate.createdAt).toLocaleDateString()');
    // A history row with no title names the AI the way the rest of the app does, not its raw id.
    expect(read('RemoteWorkroomHistoryPanel.tsx')).not.toContain('${row.agent} 대화');
  });

  // Integration review (w5): the workroom footer is mounted in the phone's remote panel too, and the same-Wi‑Fi page's
  // tester printed its run time with toLocaleString() — 「마지막 기억 저장 10/16/2026, 2:04:05 PM」 on an English-region phone.
  test('the workroom footer and the same-Wi‑Fi tester use it too', () => {
    const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
    const footer = read('WorkroomSessionFooter.tsx');
    expect(footer).toContain('phoneDateTime(status.lastSavedAt)');
    expect(footer).toContain('phoneDateTime(status.context.observedAt)');
    expect(footer).not.toMatch(/toLocale(?:Time|Date)?String\(\)/);
    expect(read('remoteControlMobilePage.ts')).toMatch(/const lanTester=\(\$\{mountLanTester\.toString\(\)\}\)\([^\n]*,phoneDate\);/);
    expect(read('mobileTesterLan.ts')).toContain('formatDate?formatDate(r.createdAt)');
  });
});
