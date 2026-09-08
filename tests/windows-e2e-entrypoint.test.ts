import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./windows-e2e.spec.ts', import.meta.url), 'utf8');
const onboardingFirstSource = readFileSync(new URL('./e2e/onboarding-1st.spec.ts', import.meta.url), 'utf8');
const onboardingSecondSource = readFileSync(new URL('./e2e/onboarding-2nd-handoff.spec.ts', import.meta.url), 'utf8');

describe('standalone Windows E2E entrypoint', () => {
  test('uses the actual development URL by default', () => {
    expect(source).toContain('process.env.LOCAL_URL ?? "http://localhost:9000"');
    expect(source).toContain('const API_PORT = Number(process.env.API_PORT) || 3001');
    expect(source).toContain('const apiBase = `http://127.0.0.1:${API_PORT}`');
    expect(source).toContain('[data-help-key=\'header-build-windows\']');
    expect(source).toContain('assert(winBuildVisible, "Windows build button should be present on Windows")');
  });

  test('does not execute when imported by bun test', () => {
    expect(source).toContain('const isDirectEntry = import.meta.main === true');
    expect(source).toContain('path.resolve(process.argv[1]!) === fileURLToPath(import.meta.url)');
    expect(source).toContain("if (isDirectEntry && process.env.NODE_ENV !== 'test')");
  });

  test('keeps the first-run wizard out of the main Windows app suite', () => {
    expect(source).toContain('const SETUP_WIZARD_SEEN_KEY = "portmanager-setup-wizard-seen-v1"');
    expect(source).toContain('localStorage.setItem(key, "seen")');
  });

  test('matches the supported Windows terminal surfaces: Orca present, cmux absent', () => {
    expect(source).toContain("[data-testid='terminal-app-orca']");
    expect(source).toContain('Orca terminal selector should be present on Windows');
    expect(source).toContain('cmux button should not be present on Windows');
    expect(source).not.toContain('cmux/Orca buttons should be absent on Windows');
  });

  test('keeps onboarding E2E scripts standalone instead of silently running under bun test', () => {
    for (const onboardingSource of [onboardingFirstSource, onboardingSecondSource]) {
      expect(onboardingSource).toContain("if (import.meta.main && process.env.NODE_ENV !== 'test')");
      expect(onboardingSource).toContain("process.exit(1)");
    }
  });
});
