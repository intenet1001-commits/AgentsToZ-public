import {describe, expect, test} from 'bun:test';
import golden from './fixtures/workroom-notify-golden.json';
import {WORKROOM_NOTIFY_HEURISTIC_HOLD_MS, WORKROOM_NOTIFY_RATE_MS, initialWorkroomNotifyMemory, stepWorkroomNotify, workroomNotifyText, type WorkroomNotifyStep} from '../src/workroomNotifyPolicy';

// One policy for Mac notifications and phone push; the golden table is the contract a Rust caller shares later.
describe('workroom notify policy (golden table)', () => {
  test('constants match the table', () => {
    expect(golden.rateMs).toBe(WORKROOM_NOTIFY_RATE_MS);
    expect(golden.heuristicHoldMs).toBe(WORKROOM_NOTIFY_HEURISTIC_HOLD_MS);
  });
  for (const golden_case of golden.cases) test(golden_case.name, () => {
    let memory = initialWorkroomNotifyMemory();
    for (const [index, {step, expect: expected}] of golden_case.steps.entries()) {
      const result = stepWorkroomNotify(memory, step as WorkroomNotifyStep);
      expect(result.notifications, `step ${index}`).toEqual(expected as any);
      // The memory round-trips through JSON (a Rust or persisted caller holds it as data).
      memory = JSON.parse(JSON.stringify(result.memory));
    }
  });
  test('wording never claims what the host has not proven', () => {
    expect(workroomNotifyText('turn-finished', false)).not.toContain('끝났');
    expect(workroomNotifyText('turn-finished', true)).toBe('작업이 끝났습니다');
    expect(workroomNotifyText('needs-answer', false)).toBe('답이 필요합니다');
    expect(workroomNotifyText('exited', true, 0)).toBe('종료됨(코드 0)');
  });
});
