import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OnboardingGithubStore } from '../src/onboardingGithubStore';
import { OnboardingGithubHost, type GithubHostEffects } from '../src/onboardingGithubHost';
import { GITHUB_RECIPE } from '../src/onboardingGithub';
import { WINDOWS_ONBOARDING_RECIPES } from '../src/onboardingWindowsInstall';

const roots: string[] = [];
const stores: OnboardingGithubStore[] = [];
const hosts: OnboardingGithubHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(overrides: Partial<GithubHostEffects> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'github-gate-'));
  roots.push(root);
  const store = new OnboardingGithubStore(root);
  stores.push(store);
  const calls: string[] = [];
  const effects: GithubHostEffects = {
    platform: 'darwin',
    probe: async () => { calls.push('probe'); return 'missing'; },
    prepare: async () => { calls.push('prepare'); },
    installFile: async () => { calls.push('install'); },
    openLoginPage: async () => { calls.push('open-login'); },
    login: () => { throw new Error('not configured'); },
    ...overrides,
  };
  const host = new OnboardingGithubHost(store, effects);
  hosts.push(host);
  return { host, store, root, calls };
}

test('Windows is supported when its effects report winget, and may install', async () => {
  const { host, calls } = setup({ platform: 'win32', supported: true });
  expect(host.status().supported).toBe(true);
  const reviewed = (await host.act('review', '0')).receipt!;
  expect(reviewed.state).toBe('reviewed');
  await host.act('install', reviewed.revision);
  for (let i = 0; i < 100 && !calls.includes('probe'); i++) await Bun.sleep(5);
  expect(calls).toContain('probe');
});

test('Windows without winget is refused, and status agrees with act', async () => {
  const { host, calls } = setup({ platform: 'win32', supported: false });
  // The panel must not offer a button that the request would then reject.
  expect(host.status().supported).toBe(false);
  await expect(host.act('review', '0')).rejects.toThrow(/winget/);
  expect(calls).toEqual([]);
});

test('an unspecified Windows capability is unsupported rather than assumed', async () => {
  // `supported` left undefined means the effects never proved winget exists.
  // macOS treats undefined as supported (its own arch check already ran), so the
  // two platforms must not share one `!== false` test.
  const { host } = setup({ platform: 'win32' });
  expect(host.status().supported).toBe(false);
  await expect(host.act('review', '0')).rejects.toThrow();

  const mac = setup({ platform: 'darwin' });
  expect(mac.host.status().supported).toBe(true);
});

test('macOS keeps its Apple Silicon refusal', async () => {
  const { host, calls } = setup({ platform: 'darwin', supported: false });
  expect(host.status().supported).toBe(false);
  await expect(host.act('review', '0')).rejects.toThrow(/Apple Silicon/);
  expect(calls).toEqual([]);
});

test('the receipt records the recipe that will actually run', async () => {
  // The two platforms install differently, and the recipe id is what the host
  // compares before acting. Storing the macOS id on Windows meant the record
  // disagreed with the reviewed text, and a version bump on either platform
  // invalidated the wrong receipts.
  const windowsRecipe = WINDOWS_ONBOARDING_RECIPES.github.id;
  const windows = setup({ platform: 'win32', supported: true, recipeId: windowsRecipe });
  const reviewed = (await windows.host.act('review', '0')).receipt!;
  expect(reviewed.recipe).toBe(windowsRecipe);
  expect(reviewed.recipe).not.toBe(GITHUB_RECIPE.id);
  // And the host accepts its own receipt rather than refusing it as foreign.
  await windows.host.act('check', reviewed.revision);
  expect(windows.calls).toContain('probe');

  // macOS keeps its own identity when the effects name none.
  const mac = setup({ platform: 'darwin' });
  expect((await mac.host.act('review', '0')).receipt!.recipe).toBe(GITHUB_RECIPE.id);
});

test('a receipt from the other platform recipe is refused, not acted on', async () => {
  const { host, store, calls } = setup({ platform: 'win32', supported: true, recipeId: WINDOWS_ONBOARDING_RECIPES.github.id });
  // A receipt left behind by the macOS recipe (e.g. a synced app-data folder).
  const foreign = store.review('0', GITHUB_RECIPE.id);
  expect(foreign.recipe).toBe(GITHUB_RECIPE.id);
  await expect(host.act('check', foreign.revision)).rejects.toThrow(/다시 검토/);
  expect(calls).toEqual([]);
});

test('no other platform becomes installable by accident', async () => {
  for (const platform of ['linux', 'freebsd', 'aix'] as const) {
    const { host } = setup({ platform, supported: true });
    expect(host.status().supported).toBe(false);
    await expect(host.act('review', '0')).rejects.toThrow();
  }
});
