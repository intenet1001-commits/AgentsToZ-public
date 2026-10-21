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
    // The build buttons moved into the nested 「빌드」 popover of 「실행 도구」 (2026-09 redesign):
    // the spec must open it before asserting visibility, not assert a hidden control.
    expect(source).toContain('Windows build button should be visible once the Build group is open');
  });

  test('waits for the app shell instead of networkidle, which never settles against a live API', () => {
    expect(source).toContain('async function gotoApp(page: Page)');
    expect(source).not.toContain('waitUntil: "networkidle"');
  });

  test('lets portal safety leases settle even when a test fails, so one failure cannot cascade', () => {
    const runTest = source.slice(source.indexOf('async function runTest('), source.indexOf('function assert('));
    const finallyBlock = runTest.slice(runTest.indexOf('} finally {'));
    expect(finallyBlock).toContain('await openLeases.settle()');
    expect(finallyBlock.indexOf('await openLeases.settle()')).toBeLessThan(finallyBlock.indexOf('await ctx.close()'));
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

  test('matches the supported Windows terminal surfaces: Orca present, cmux and Workroom absent', () => {
    const test04 = source.slice(source.indexOf('async function test04_windowsSpecificUI'), source.indexOf('// 5. Worktree Panel'));
    // The selector lives in the collapsed 「실행 도구」 <details>; open it first.
    expect(test04.indexOf('await openLaunchTools(page)')).toBeGreaterThan(-1);
    expect(test04.indexOf('await openLaunchTools(page)')).toBeLessThan(test04.indexOf('terminal-app-${app}'));
    expect(test04).toContain('for (const app of ["powershell", "orca", "wsl"])');
    expect(test04).toContain('for (const app of ["internal", "cmux", "iterm", "terminal"])');
    expect(test04).toContain('should not be offered on Windows');
    expect(source).not.toContain('cmux/Orca buttons should be absent on Windows');
  });

  test('keeps onboarding E2E scripts standalone instead of silently running under bun test', () => {
    for (const onboardingSource of [onboardingFirstSource, onboardingSecondSource]) {
      expect(onboardingSource).toContain("if (import.meta.main && process.env.NODE_ENV !== 'test')");
      expect(onboardingSource).toContain("process.exit(1)");
    }
  });
});
