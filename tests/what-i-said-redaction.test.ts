import { describe, expect, test } from 'bun:test';
import {
  containsHighConfidenceWhatISaidSecret,
  redactWhatISaidForFeed,
} from '../src/whatISaidRedaction';

describe('What-I-said feed secret boundary', () => {
  test('withholds lowercase env and quoted JSON credential names', () => {
    for (const text of [
      'api_key="abcdefghijklmnopqrstuvwx"',
      'password=correct-horse-battery-staple',
      'password=correct horse battery staple',
      '{"access_token":"abcdefghijklmnopqrstuvwxyz012345"}',
      '{"client_secret":"abcdefghijklmnopqrstuvwxyz012345"}',
    ]) {
      expect(containsHighConfidenceWhatISaidSecret(text)).toBe(true);
      expect(redactWhatISaidForFeed(text)).toMatchObject({
        withheld: true,
        text: null,
        reasons: ['high-confidence-secret'],
      });
    }
  });

  test('does not withhold ordinary short configuration values', () => {
    expect(containsHighConfidenceWhatISaidSecret('theme_key=teal')).toBe(false);
    expect(containsHighConfidenceWhatISaidSecret('TOKEN_HEADER=X-AgentsToZ-Remote-Control-Capability')).toBe(true);
    expect(containsHighConfidenceWhatISaidSecret('AUTH_HEADER_TOKEN=abcdefghijklmnopqrstuvwxyz0123456789')).toBe(true);
    expect(redactWhatISaidForFeed('Last Updated: 2026-09-05').reasons).not.toContain('phone');
    expect(redactWhatISaidForFeed('연락처 ٠١٠-١٢٣٤-٥٦٧٨').reasons).toContain('phone');
  });

  test('withholds recognizable package, GitLab, Stripe, Google, PyPI, and SendGrid credentials', () => {
    for (const text of [
      'npm_abcdefghijklmnopqrstuvwxyz0123456789',
      'glpat-abcdefghijklmnopqrst',
      'sk_live_' + 'abcdefghijklmnopqrstuvwxyz',
      'rk_live_' + 'abcdefghijklmnopqrstuvwxyz',
      'GOCSPX-abcdefghijklmnopqrstuvwxyz',
      'pypi-abcdefghijklmnopqrstuvwxyz012345',
      'SG.abcdefghijklmnop.qrstuvwxyz012345',
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    ]) {
      expect(redactWhatISaidForFeed(text)).toMatchObject({
        withheld: true,
        text: null,
        reasons: ['high-confidence-secret'],
      });
    }
  });
});
