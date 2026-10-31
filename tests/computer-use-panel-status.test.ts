/**
 * 컴퓨터 유즈 패널의 도우미 연결 줄. Control이 status에 capture/click을 `operations`로 알리지 않으면 이전 빌드다:
 * 연결은 됐지만 창 화면 확인과 좌표 선택은 업데이트 전까지 실패하므로, 「연결됨」만 보여 주지 말고 그렇게 말한다.
 */
import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ComputerUseHelperStatus, liveComputerUsePending} from '../src/ComputerUsePanel';

const contract = JSON.parse(readFileSync(join(import.meta.dir, '..', 'native', 'computer-use', 'Tests', 'ControlContract', 'requests.json'), 'utf8'));
const currentStatus: Record<string, unknown> = contract.replies.status;
const {operations: _dropped, ...olderStatus} = currentStatus;
const render = (state: Record<string, any> | null, nativeState: Record<string, any> | null = null) =>
  renderToStaticMarkup(React.createElement(ComputerUseHelperStatus, {state, nativeState}));
const UPDATE = 'computer-use-control-update';

test('a Control that lists capture and click is connected with no update notice', () => {
  const html = render({native: currentStatus});
  expect(html).toContain('도우미 연결됨');
  expect(html).not.toContain(UPDATE);
});

test('a connected Control without operations predates capture/click and the person is told to update it', () => {
  const html = render({native: olderStatus});
  expect(html).toContain('도우미 연결됨');
  expect(html).toContain(`data-testid="${UPDATE}"`);
  expect(html).toContain('최신 버전으로 업데이트');
  expect(html).toContain('창 화면 확인과 좌표 선택');
  // What still works stays stated, so the notice is not read as the helper being down.
  expect(html).toContain('관찰·누르기·입력은 창별 승인과 손쉬운 사용 권한이 있으면 쓸 수 있습니다');
});

test('an operations list missing one of the two, or not a bounded array, is still an older Control', () => {
  for (const operations of [['capture', 'observe'], ['click'], 'capture,click', Array(40).fill('capture').concat('click')])
    expect(render({native: {...currentStatus, operations}})).toContain(UPDATE);
});

test('the update notice also shows while Accessibility is still missing, but never for an unreachable helper or a retired link', () => {
  const html = render({native: {...olderStatus, accessibility: false}});
  expect(html).toContain('손쉬운 사용 권한');
  expect(html).toContain(UPDATE);
  expect(render({native: {success: false, code: 'helper-unavailable'}})).not.toContain(UPDATE);
  expect(render({native: {success: false, code: 'signed-main-required'}})).toContain('최신 Mac 앱으로 업데이트');
  expect(render({restartRequired: true, native: olderStatus})).not.toContain(UPDATE);
  expect(render(null)).not.toContain(UPDATE);
});


test('connected does not imply screen consent or general canvas control', () => {
  const html = render({native: currentStatus});
  expect(html).toContain('computer-use-screen-consent');
  expect(html).toContain('화면 보기를 따로 허용');
  expect(html).toContain('Control의 화면 기록 권한');
  expect(html).toContain('캔버스의 임의 좌표 클릭·드래그·단축키 입력');
  expect(html).toContain('Hermes·Orca');
  expect(render({native: olderStatus})).not.toContain('computer-use-screen-consent');
});

test('a retired link cannot display ready from the last successful native status', () => {
  const html = render({restartRequired: true, native: currentStatus});
  expect(html).toContain('연결 다시 시작 필요');
  expect(html).not.toContain('도우미 연결됨');
});

test('a waiting request leaves the list at its expiry even when no newer status arrives', () => {
  const now = 1_000_000;
  const window = {approvalId: 'p1', expiresAt: now + 120_000}, scope = {approvalId: 'scope_p1', expiresAt: now + 1};
  expect(liveComputerUsePending([window, scope], now)).toEqual([window, scope]);
  // The server reaps at expiresAt; a failed or slow status read must not keep the row and its review button.
  expect(liveComputerUsePending([window, scope], now + 1)).toEqual([window]);
  expect(liveComputerUsePending([window, scope], now + 120_000)).toEqual([]);
  // A request without a numeric expiry is not guessed away: only Control's status removes it.
  const unknown: {approvalId: string; expiresAt?: unknown} = {approvalId: 'p2'}, text = {approvalId: 'p3', expiresAt: '0'};
  expect(liveComputerUsePending([unknown, text], now)).toEqual([unknown, text]);
});
