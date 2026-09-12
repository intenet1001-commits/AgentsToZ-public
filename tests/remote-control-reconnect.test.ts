import { describe, test, expect } from 'bun:test';

/**
 * QR 원격제어 WebSocket 자동 재연결 및 상태 표시 테스트.
 *
 * 이 테스트는 remoteControlMobilePage.ts의 REMOTE_CONTROL_MOBILE_JS에 포함된
 * 클라이언트 JavaScript 동작을 검증합니다.
 */

import { REMOTE_CONTROL_MOBILE_JS } from '../src/remoteControlMobilePage';

describe('remote control mobile page reconnection', () => {
  test('includes reconnection state variables', () => {
    // 재연결 상태 추적 변수가 존재해야 함
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('reconnectAttempts');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('MAX_RECONNECT_ATTEMPTS');
  });

  test('implements exponential backoff for reconnection', () => {
    // exponential backoff 계산 로직이 있어야 함
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('reconnectDelay');
    // 지수 증가 패턴: Math.min(..., baseDelay * 2^attempt)
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('Math.pow');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('Math.min');
  });

  test('attempts automatic reconnection on close', () => {
    // close 이벤트에서 scheduleReconnect 호출
    expect(REMOTE_CONTROL_MOBILE_JS).toMatch(/socket\.addEventListener\s*\(\s*["']close["']/);
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('scheduleReconnect');
  });

  test('shows reconnecting status during reconnection attempts', () => {
    // "재연결 중" 상태 표시
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('재연결');
  });

  test('stops reconnection after max attempts', () => {
    // 최대 재시도 횟수 초과 시 중단
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('MAX_RECONNECT_ATTEMPTS');
    expect(REMOTE_CONTROL_MOBILE_JS).toMatch(/reconnectAttempts\s*>=\s*MAX_RECONNECT_ATTEMPTS/);
  });

  test('resets reconnect attempts on successful connection', () => {
    // 연결 성공 시 재시도 카운터 리셋
    expect(REMOTE_CONTROL_MOBILE_JS).toMatch(/reconnectAttempts\s*=\s*0/);
  });

  test('preserves the session token across a closed tab, not just a dropped socket', () => {
    // 탭이 닫혀도 남아야 한다 — 호스트가 30일짜리 세션을 복구해도 폰이 자기 토큰을 잊으면
    // 아침에 QR을 다시 스캔해야 한다. iOS는 백그라운드 탭을 스스로 버리기도 한다.
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('localStorage.setItem(SESSION_STORAGE_KEY');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('localStorage.getItem(SESSION_STORAGE_KEY)');
    // 해제는 두 저장소 모두에서 이뤄져야 한다. 한쪽만 지우면 지운 토큰이 되살아난다.
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('localStorage.removeItem(SESSION_STORAGE_KEY)');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('sessionStorage.removeItem(SESSION_STORAGE_KEY)');
  });

  test('shows specific error messages for different close reasons', () => {
    // 다양한 종료 사유에 대한 구체적 메시지
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('closeReasonMessage');
    expect(REMOTE_CONTROL_MOBILE_JS).toMatch(/1000|1001|1006|1008|1011/);
  });

  test('cancels pending reconnection on manual disconnect', () => {
    // 수동 연결 해제 시 예약된 재연결 취소
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('cancelReconnect');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('reconnectTimer');
  });
});

describe('remote control session restoration', () => {
  test('attempts session restoration with stored token', () => {
    // 저장된 세션 토큰으로 복원 시도
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('session.restore');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('attemptReconnect');
  });

  test('falls back to QR pairing when restoration fails', () => {
    // 복원 실패 시 QR 페어링으로 fallback
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('pairToken');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('controller.pair');
  });

  test('clears stored session on explicit revocation', () => {
    // 명시적 해제 시 저장된 세션 삭제
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('clearSavedSession');
    expect(REMOTE_CONTROL_MOBILE_JS).toMatch(/sessionStorage\.removeItem/);
  });

  test('saves session on successful connection', () => {
    // 연결 성공 시 세션 저장
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('saveSession');
    expect(REMOTE_CONTROL_MOBILE_JS).toMatch(/sessionStorage\.setItem/);
  });
});

describe('remote control version compatibility', () => {
  test('checks protocol version on connection', () => {
    // 프로토콜 버전 확인
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('PROTOCOL_VERSION');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('protocolVersion');
  });

  test('shows clear message on version mismatch', () => {
    // 버전 불일치 시 명확한 안내
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('PROTOCOL_MISMATCH');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('버전 불일치');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('업데이트');
  });
});
