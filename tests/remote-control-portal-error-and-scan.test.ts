import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const PORTAL = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
const PORTAL_CSS = readFileSync(new URL('../src/remote-control-portal.css', import.meta.url), 'utf8');

/**
 * Every unmapped failure collapsed into "Mac과 인터넷 상태를 확인해 주세요".
 *
 * The screen said to check the internet while the real state was
 * `approval-required`, so the actual code never reached the user and could not
 * be reported or acted on. The fallback stays as the human sentence, but the
 * machine-readable token has to travel with it.
 */
describe('portal remote control surfaces the real failure token', () => {
  test('an unmapped error keeps its code alongside the human message', () => {
    expect(PORTAL).toContain('remoteControlErrorDetail');
    // The fallback sentence remains, but is no longer the whole story.
    expect(PORTAL).toContain('Mac과 인터넷 상태를 확인해 주세요');
  });

  test('the failure detail is rendered, not just stored', () => {
    expect(PORTAL).toContain('remote-alert-detail');
    expect(PORTAL_CSS).toContain('.remote-alert-detail');
  });

  test('the detail can be copied so it can be pasted into a report', () => {
    expect(PORTAL).toContain('navigator.clipboard');
    expect(PORTAL).toContain('오류 정보 복사');
  });
});

/**
 * The resume note tells the user to scan a new QR to add another Mac, but the
 * scan button lived only in the portal header — a different screen. Put the
 * entry point where the instruction is.
 */
describe('portal remote control offers QR scanning on this screen', () => {
  test('a scan entry point exists on the remote control screen', () => {
    expect(PORTAL).toContain('remote-portal-scan');
    expect(PORTAL).toContain('QR 스캔');
  });

  test('the scan control sits with the top navigation, not at the bottom', () => {
    const navIndex = PORTAL.indexOf('remote-portal-nav');
    const scanIndex = PORTAL.indexOf('remote-portal-scan');
    expect(navIndex).toBeGreaterThan(-1);
    expect(scanIndex).toBeGreaterThan(-1);
    // Rendered in the same header block, before the security note and panels.
    expect(scanIndex).toBeLessThan(PORTAL.indexOf('remote-security-note'));
  });

  test('scanning navigates to the portal scanner rather than duplicating it', () => {
    expect(PORTAL).toContain('scan=remote');
  });
});
