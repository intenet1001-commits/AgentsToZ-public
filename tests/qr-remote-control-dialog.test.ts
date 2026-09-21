import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QrRemoteControlDialog } from '../src/QrRemoteControlDialog';

const source = readFileSync(new URL('../src/QrRemoteControlDialog.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

describe('QR remote-control desktop dialog', () => {
  test('is a separate opt-in dialog, not a fifth main tab or prompt-data surface', () => {
    expect(renderToStaticMarkup(createElement(QrRemoteControlDialog, {
      open: false,
      onClose() {},
    }))).toBe('');

    const html = renderToStaticMarkup(createElement(QrRemoteControlDialog, {
      open: true,
      onClose() {},
    }));
    expect(html).toContain('data-testid="qr-remote-control-dialog"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('QR 원격제어 · 이 Mac');
    expect(html).toContain('등록 프로젝트·워크트리의 프로세스를 제어하고 이 Mac의 허용된 앱으로 엽니다.');
    expect(html).toContain('파일 내용·Git 변경·AI 대화·자격증명·장기기억·프롬프트 데이터에는 접근 권한을 주지 않습니다.');
    expect(source).not.toContain("from './WhatISaidPanel'");
    expect(source).not.toContain("from './whatISaid");
    expect(source).not.toContain('/api/what-i-said');
    expect(source).not.toContain('ShadowLoop');
    expect(appSource).toContain('!isDeployedWeb() && !isWindows()');
  });

  test('keeps the dialog keyboard-contained and restores the prior focus', () => {
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain("event.key !== 'Tab'");
    expect(source).toContain('dialogRef.current?.querySelectorAll<HTMLElement>(interactiveSelector)');
    expect(source).toContain('previousFocusRef.current?.focus();');
    expect(source).toContain('closeButtonRef.current?.focus()');
    expect(source).toContain('if (busyRef.current) return;');
  });

  test('fits saved 100/125/150% layouts by scrolling inside one bounded responsive panel', () => {
    expect(source).toContain("maxHeight: 'calc(var(--ui-viewport-height, 100dvh) - max(24px, 10dvh))'");
    expect(source).toContain('w-full max-w-3xl min-w-0');
    expect(source).toContain('min-h-0 flex-1 overflow-y-auto');
    expect(source).toContain('grid-cols-1');
    expect(source).toContain('md:grid-cols-[minmax(0,1fr)_260px]');
    expect((source.match(/min-h-11/g) ?? []).length).toBeGreaterThanOrEqual(10);
    expect(source).toContain('min-w-11');
  });

  test('renders the secret locally as a high-contrast SVG and offers an accessible copy alternative', () => {
    expect(source).toContain("import { QRCodeSVG } from 'qrcode.react';");
    expect(source).toContain('<QRCodeSVG');
    expect(source).toContain('title="일회용 QR 원격제어 연결 코드"');
    expect(source).toContain('level="Q"');
    expect(source).toContain('marginSize={4}');
    expect(source).toContain('bgColor="#ffffff"');
    expect(source).toContain('fgColor="#000000"');
    expect(source).toContain('연결 링크 복사');
    expect(source).not.toContain('chart.googleapis.com');
    expect(source).not.toContain('api.qrserver.com');
  });

  test('explains trust boundaries and exposes explicit issue, revoke, and disable controls', () => {
    for (const phrase of [
      '같은 신뢰할 수 있는 개인 Wi‑Fi에서만 사용하세요.',
      '공용·게스트 Wi‑Fi에서는 켜지 마세요.',
      '이 Mac에서 켜고 QR 발급',
      'QR은 한 번만 쓸 수 있고 30일 뒤 만료됩니다.',
      'QR 재발급',
      '연결 해제',
      '원격제어 전체 끄기',
      '기존 QR 원문은 보안상 다시 불러오지 않습니다.',
    ]) expect(source).toContain(phrase);

    // Adding a device IS "rotate the QR and scan it from the other phone", so
    // the dialog must not tell the user that rotating ends the connections it
    // no longer ends. That false warning — shown only once a device was
    // connected, i.e. exactly when you want a second one — is why the user
    // reported there was no button to add a device at all (VOC 2026-08-31 23:42).
    expect(source).not.toContain('현재 연결된 휴대폰·iPad도 즉시 종료됩니다');
    expect(source).not.toContain("window.confirm('새 QR을 발급하면");
    expect(source).toContain('이미 연결된 기기는 그대로 유지됩니다');
    expect(source).toContain("'다른 기기 추가 (새 QR)'");
    // The cap comes from the host, so the copy cannot drift from it.
    expect(source).toContain('REMOTE_CONTROL_MAX_SESSIONS');
    expect(source).not.toMatch(/최대 \d+대/);
  });

  test('announces state outcomes without reading the countdown every second', () => {
    expect(source).toContain("role={notice.kind === 'error' ? 'alert' : 'status'}");
    expect(source).toContain("aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}");
    expect(source).toContain('aria-atomic="true"');
    const countdown = source.slice(source.indexOf("{effectiveExpiry && ("), source.indexOf("{status.pairing &&"));
    expect(countdown).not.toContain('aria-live');
  });

  test('refreshes pairing and session status while visible without racing explicit mutations', () => {
    expect(source).toContain('document.hidden');
    expect(source).toContain('pollInFlight');
    expect(source).toContain('3_000');
    expect(source).toContain('managementRevisionRef.current');
    expect(source).toContain("document.addEventListener('visibilitychange', handleVisibilityChange)");
  });
});
