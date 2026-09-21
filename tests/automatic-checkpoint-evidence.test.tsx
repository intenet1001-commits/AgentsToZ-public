import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutoRememberEvidence, automaticCheckpointEvidence } from '../src/components/AutoRememberEvidence';
import type { CodexAutoRememberStatus, CodexAutoRememberSessionStatus } from '../src/codexAutoRememberContract';

const status = (sessions: Partial<CodexAutoRememberSessionStatus>[]): CodexAutoRememberStatus => ({
  schemaVersion: 1, settings: { enabled: true, enabledAt: null, thresholds: [50, 75, 90] },
  running: false, sessions: sessions as CodexAutoRememberSessionStatus[],
});
test('enabled and saved phase labels alone cannot become verified local checkpoints', () => {
  const value = status([{ phase: 'saved', lastCheckpointAt: null }, { phase: 'waiting-for-changes' },
    { phase: 'retrying' }, { phase: 'failed' }, { phase: 'recovery-required' }]);
  expect(automaticCheckpointEvidence(value)).toEqual({ observed: 5, saved: 0, lastSavedAt: null, waiting: 2, attention: 2 });
  const html = renderToStaticMarkup(<AutoRememberEvidence status={value} />);
  expect(html).toContain('확인된 로컬 저장 기록 없음');
  expect(html).toContain('켜짐은 자동 실행 설정입니다');
  expect(html).toContain('전체 저장 이력이 없다는 뜻은 아니며');
});
test('retained checkpoints stay separate from current failures, future dates and unseen history', () => {
  const at = '2026-09-08T00:00:00.000Z', now = Date.parse(at);
  const value = status([{ phase: 'failed', lastCheckpointAt: at }, { phase: 'saved', lastCheckpointAt: 'invalid' },
    { phase: 'saved', lastCheckpointAt: '2099-01-01' }, ...Array.from({ length: 22 }, () => ({ phase: 'observing' as const })),
    { phase: 'saved', lastCheckpointAt: at }]);
  expect(automaticCheckpointEvidence(value, now)).toEqual({ observed: 24, saved: 1, lastSavedAt: at, waiting: 0, attention: 1 });
});
