import { describe, expect, test } from 'bun:test';
import { onboardingCompletionProblem, onboardingEntryState, resolveOnboardingMode } from '../src/onboardingEntryPolicy';

describe('preserve an existing installation during onboarding', () => {
  test('missing, failed, and future status responses cannot authorize a fresh setup', () => {
    for (const stage of [undefined, null, 'future-version', {}, true]) {
      const state = onboardingEntryState({ stage, checking: false, hasExistingDevice: false });
      expect(state).toBe('unavailable');
      for (const mode of ['first', 'first_cli', 'one_click', 'additional'] as const) {
        expect(resolveOnboardingMode(mode, state)).toBe('choose');
      }
    }
    expect(resolveOnboardingMode('first', 'checking')).toBe('choose');
  });

  test('the parent identity remains protected while a sidecar is slow or disagrees', () => {
    for (const stage of [undefined, 'fresh', 'configured-unregistered']) {
      for (const checking of [true, false]) {
        const state = onboardingEntryState({ stage, checking, hasExistingDevice: true });
        expect(state).toBe('registered');
        for (const mode of ['first', 'first_cli', 'one_click', 'additional'] as const) {
          expect(resolveOnboardingMode(mode, state)).toBe('existing');
        }
        expect(resolveOnboardingMode('pair_device', state)).toBe('pair_device');
      }
    }
  });

  test('late registered evidence redirects an already selected first-run flow', () => {
    expect(onboardingEntryState({ stage: 'registered', checking: true, hasExistingDevice: false })).toBe('registered');
    expect(resolveOnboardingMode('first_cli', 'fresh')).toBe('first_cli');
    expect(resolveOnboardingMode('first_cli', 'registered')).toBe('existing');
    expect(resolveOnboardingMode('first_cli', 'unavailable')).toBe('choose');
  });

  test('a pending registration only resumes its additional-device flow', () => {
    for (const mode of ['first', 'first_cli', 'one_click', 'additional'] as const) {
      expect(resolveOnboardingMode(mode, 'additional-pending')).toBe('additional');
    }
    expect(resolveOnboardingMode('pair_device', 'additional-pending')).toBe('choose');
  });

  test('a fresh installation and read-only troubleshooting remain available', () => {
    expect(resolveOnboardingMode('first', 'fresh')).toBe('first');
    expect(resolveOnboardingMode('additional', 'fresh')).toBe('additional');
    expect(resolveOnboardingMode('first', 'configured-unregistered')).toBe('first');
    expect(resolveOnboardingMode('infrastructure', 'unavailable')).toBe('infrastructure');
  });

  test('completion cannot overwrite a concurrently registered device or its database', () => {
    const existing = { deviceId: 'existing-device', supabaseUrl: 'https://example.supabase.co' };
    const before = JSON.stringify(existing);
    for (const kind of ['first', 'additional', undefined] as const) {
      expect(onboardingCompletionProblem(existing, kind)).toContain('기존 단말 설정');
    }
    expect(JSON.stringify(existing)).toBe(before);
    const pending = { ...existing, pendingDeviceRegistration: true };
    expect(onboardingCompletionProblem(pending, 'first')).toContain('같은 단말 ID');
    expect(onboardingCompletionProblem(pending, 'additional')).toBeNull();
    expect(onboardingCompletionProblem({}, 'first')).toBeNull();
  });
});
