import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { WORKROOM_RESTART_AVAILABILITY, workroomRestartActionable, workroomRestartRunnable } from '../src/workroomConversationProtocol';
import { RESTART_AVAILABILITY_PHRASE, RESTART_BYPASS_LINE, restartBatchSummary, restartOfferTitle } from '../src/workroomRestartText';
import { GUIDE_CONTENT } from '../src/guide/guideContent';

const row = (id: string) => ({ id, targetId: 'project-target-001', agent: 'codex' as const, title: '', accountLabel: '현재 CLI 계정', createdAt: '2026-10-16T01:00:00Z', updatedAt: '2026-10-16T01:00:00Z', revision: 2, availability: 'ready' as const, bypass: null });

test('every availability has one short phrase and never a bare 「이어 열 수 없음」', () => {
  for (const availability of WORKROOM_RESTART_AVAILABILITY) {
    const phrase = RESTART_AVAILABILITY_PHRASE[availability];
    expect(phrase.length).toBeGreaterThan(3); expect(phrase.length).toBeLessThanOrEqual(24); expect(phrase).not.toBe('이어 열 수 없음');
  }
  expect(WORKROOM_RESTART_AVAILABILITY.filter(workroomRestartRunnable)).toEqual(['ready', 'check']);
  expect(WORKROOM_RESTART_AVAILABILITY.filter(workroomRestartActionable)).toEqual(['ready', 'check', 'in-flight', 'pending']);
});
test('the title says update only when the build changed; the bypass line uses the glossary term', () => {
  expect(restartOfferTitle(3, true)).toBe('업데이트 전 실행 중이던 작업 세션 3개');
  expect(restartOfferTitle(1, false)).toBe('앱을 다시 열기 전 실행 중이던 작업 세션 1개');
  expect(RESTART_BYPASS_LINE).toContain('승인 없이 실행 (권한 우회)');
});
test('the batch summary counts what opened, groups the reasons and names the row it stopped at', () => {
  const text = restartBatchSummary({
    opened: [{ row: row('conversation-0001') }, { row: row('conversation-0002') }],
    skipped: [{ row: row('conversation-0003'), reason: '첫 요청을 보내기 전에 끝나 저장된 대화가 없습니다. 같은 프로젝트에서 새 대화를 시작하세요.' }],
    stopped: { row: { ...row('conversation-0004'), title: '배포 정리' }, reason: 'lost', requestId: 'request-0001' },
  }, r => r.title || r.id);
  expect(text).toBe('2개를 다시 열었습니다 — 작업 세션 목록에서 여세요 · 1개는 첫 요청을 보내기 전에 끝나 저장된 대화가 없습니다 · 배포 정리의 결과를 확인하지 못해 멈췄습니다. 요청을 다시 보내지 않았습니다.');
});
test('the banner carries one guide entry and keeps literal colours out of its stylesheet', () => {
  expect(GUIDE_CONTENT['workroom-restart']?.body).toContain('권한 우회 없이');
  const css = readFileSync(new URL('../src/WorkroomRestartBanner.css', import.meta.url), 'utf8');
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(\s*\d/i);
  expect(css).toContain('min-height:44px'); expect(css).toContain('font-size:16px');
});
