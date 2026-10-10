import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { WINDOWS_ONBOARDING_RECIPES } from '../src/onboardingWindowsInstall';

function panel(name: string): string {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
}

/** Executable lines only: a comment may still quote the old wording to explain it. */
function live(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the unsupported notice names what is actually missing on each platform', () => {
  for (const name of ['OnboardingGithubSetup.tsx', 'OnboardingCodexInstaller.tsx']) {
    const source = live(panel(name));
    // Windows is supported now, so "Apple Silicon Mac only" is no longer the
    // whole truth, and on Windows the real blocker is winget.
    expect(source).toContain('isWindowsClient()');
    expect(source).toContain('winget');
    expect(source).not.toMatch(/자동 설치는 Apple Silicon Mac에서 지원합니다\./);
    expect(source).not.toMatch(/현재 Apple Silicon Mac 설치 앱에서 사용할 수 있습니다\./);
  }
});

test('the review text does not promise a download that Windows never performs', () => {
  const source = live(panel('OnboardingCodexInstaller.tsx'));
  // macOS downloads a pinned ~112MB payload; Windows installs through winget.
  // One shared sentence would promise an action that does not happen.
  const downloadClaim = /약 112MB를 다운로드하며/;
  expect(source).toMatch(downloadClaim);
  // The panel interpolates the pinned constants rather than restating them, so
  // the shown package id and signer cannot drift from what the install verifies.
  const windowsSentence = source.split('\n')
    .find(line => line.includes('WINDOWS_ONBOARDING_RECIPES.codex.packageId'));
  expect(windowsSentence).toBeDefined();
  expect(windowsSentence!).toContain('WINDOWS_ONBOARDING_RECIPES.codex.publisherCommonName');
  expect(windowsSentence!).not.toMatch(downloadClaim);
  expect(windowsSentence!).not.toContain('이 Mac에 설치');
  // And the macOS sentence must stay on its own branch.
  const macSentence = source.split('\n').find(line => downloadClaim.test(line));
  expect(macSentence!).not.toContain('WINDOWS_ONBOARDING_RECIPES');
});

test('the GitHub review text states the Windows trust anchor it actually uses', () => {
  const source = live(panel('OnboardingGithubSetup.tsx'));
  const windowsSentence = source.split('\n')
    .find(line => line.includes('WINDOWS_ONBOARDING_RECIPES.github.packageId'));
  expect(windowsSentence).toBeDefined();
  // The publisher string the install verifies must be the one shown.
  expect(windowsSentence!).toContain('WINDOWS_ONBOARDING_RECIPES.github.publisherCommonName');
  // The pinned constants exist and are what those references resolve to.
  expect(WINDOWS_ONBOARDING_RECIPES.github.packageId).toBe('GitHub.cli');
  expect(WINDOWS_ONBOARDING_RECIPES.codex.packageId).toBe('OpenAI.Codex');
});

test('the credential-store notice follows the platform', () => {
  const source = live(panel('OnboardingGithubSetup.tsx'));
  expect(source).toContain('clientSecretStoreLabel()');
  // "Mac의 키체인" on Windows sends the user to a store that does not exist there.
  expect(source).not.toContain('Mac의 키체인');
});
