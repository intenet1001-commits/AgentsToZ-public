import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const OVERLAY = readFileSync(new URL('../src/voc/VocOverlay.tsx', import.meta.url), 'utf8');
const API = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

/**
 * A report that arrives and is never seen is the same as no report.
 *
 * The portal writes to `portmgr_client_errors`, but on the Mac the only way in
 * was: enable VOC mode -> open the inbox popover -> scroll to a section. The
 * user sent a report and could not find it, which is the failure this whole
 * path exists to prevent. The desktop announces waiting reports on the toolbar
 * instead, and stays out of the way when there are none.
 */
describe('desktop surfaces portal error reports', () => {
  test('polls the client-error endpoint the sidecar exposes', () => {
    expect(APP).toContain('/api/client-errors');
  });

  test('shows a toolbar entry point only when reports are waiting', () => {
    expect(APP).toContain('portal-errors-badge');
    // Rendered conditionally — an empty inbox must not add toolbar noise.
    expect(APP).toMatch(/portalErrorCount\s*>\s*0/);
  });

  test('the badge states how many reports are waiting', () => {
    expect(APP).toContain('portalErrorCount');
  });

  test('opening the badge leads to the list rather than a dead end', () => {
    // VOC mode owns the list; the badge is the discoverable way into it.
    expect(APP).toContain('setVocMode(true)');
  });

  test('badge and inbox use one loader, including the Tauri localhost origin', () => {
    expect(APP).toContain('onLoadPortalErrors={loadPortalErrors}');
    expect(APP).toContain('onPortalErrorCountChange={setPortalErrorCount}');
    expect(OVERLAY).toContain('await onLoadPortalErrors()');
    expect(OVERLAY).not.toContain("fetch('/api/client-errors')");
  });

  test('the sidecar returns only unresolved reports for its current remote host', () => {
    const route = API.slice(API.indexOf('if (url.pathname === "/api/client-errors"'));
    expect(route).toContain('readRemoteControlHostRecord(APP_DATA_DIR)?.hostId');
    expect(route).toContain(".eq('device_id', hostId)");
    expect(route).toContain(".eq('resolved', false)");
  });

  test('a failed inbox fetch is an error, not a false empty state', () => {
    const catchBlock = OVERLAY.slice(OVERLAY.indexOf('} catch (error) {'), OVERLAY.indexOf('} finally {'));
    expect(catchBlock).toContain('setPortalErrorsMessage');
    expect(catchBlock).not.toContain('setPortalErrors([])');
  });

  test('a failed poll never blocks the app or raises a dialog', () => {
    // The endpoint is unavailable before Supabase is configured; that is a
    // normal state for a fresh install, not an error to interrupt anyone with.
    expect(APP).toContain('catch { /* 포털 오류 조회 실패는 앱 사용을 막지 않는다 */ }');
  });
});
