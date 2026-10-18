import { expect, test } from 'bun:test';
import { classifyOnboardingAuth } from '../src/onboardingAuthDiagnosis';

test('inconclusive failures never erase an existing login', () => {
  for (const output of ['fetch failed: please log in', 'ENOTFOUND api.example',
    '403 forbidden', 'rate limit 429', 'certificate invalid', 'unexpected provider output']) {
    const result = classifyOnboardingAuth({ok: false, timedOut: false, output});
    expect(result.state).toBe('unknown');
    expect(result.authenticated).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(output);
  }
  expect(classifyOnboardingAuth({ok: false, timedOut: true, output: 'not logged in'}).state).toBe('unknown');
});

test('explicit unauthenticated states request login and success remains ready', () => {
  for (const output of ['You are not logged into any GitHub hosts', 'Access token not provided',
    'No credentials found', 'token has expired', 'please run supabase login']) {
    expect(classifyOnboardingAuth({ok: false, timedOut: false, output})).toMatchObject({
      state: 'needs-login', authenticated: false,
    });
  }
  expect(classifyOnboardingAuth({ok: true, timedOut: false, output: 'private-account-name'}))
    .toEqual({state: 'ready', authenticated: true});
});
