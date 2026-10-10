import { describe, expect, test } from 'bun:test';
import { normalizeCodexRateLimits } from '../codex-rate-limits';

describe('Codex rate-limit payload normalization', () => {
  test('maps the live app-server camelCase weekly bucket', () => {
    expect(normalizeCodexRateLimits({
      rateLimitsByLimitId: {
        codex: {
          planType: 'pro',
          primary: { usedPercent: 78, windowDurationMins: 10080, resetsAt: 1_786_164_688 },
        },
      },
    })).toEqual({
      primary: { used_percent: 78, window_minutes: 10080, resets_at: 1_786_164_688 },
      secondary: null,
      credits: null,
      plan_type: 'pro',
      limit_id: null,
      limit_name: null,
    });
  });

  test('keeps historical rollout snapshot payloads compatible', () => {
    expect(normalizeCodexRateLimits({
      primary: { used_percent: 42, window_minutes: 300, resets_at: 100 },
      secondary: { used_percent: 6, window_minutes: 10080, resets_at: 200 },
      plan_type: 'plus',
    })).toMatchObject({
      primary: { used_percent: 42, window_minutes: 300, resets_at: 100 },
      secondary: { used_percent: 6, window_minutes: 10080, resets_at: 200 },
      plan_type: 'plus',
    });
  });
});
