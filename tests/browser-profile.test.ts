import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  browserProfileOptionLabel,
  isDeploymentPortalItem,
  resolveSavedBrowserProfile,
  type BrowserProfile,
} from '../src/browserProfile';
import {
  buildChromeProfileLaunch,
  discoverChromeProfiles,
} from '../src/browserProfilesServer';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function macChromeFixture() {
  const homeDir = mkdtempSync(join(tmpdir(), 'agentstoz-chrome-profiles-'));
  roots.push(homeDir);
  const userDataDir = join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome');
  mkdirSync(join(userDataDir, 'Default'), { recursive: true });
  mkdirSync(join(userDataDir, 'Profile 3'), { recursive: true });
  writeFileSync(join(userDataDir, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        Default: { name: 'Default profile', user_name: 'default@example.test' },
        'Profile 3': { name: 'Deploy', user_name: 'deploy-user@example.test' },
        '../escape': { name: 'unsafe', user_name: 'unsafe@example.com' },
        'Profile 99': { name: 'missing', user_name: 'missing@example.com' },
      },
    },
  }));
  return { homeDir, userDataDir };
}

describe('Chrome deployment profile discovery', () => {
  test('lists only real contained profiles and exposes a local-only account label', () => {
    const { homeDir } = macChromeFixture();
    const profiles = discoverChromeProfiles({ platform: 'darwin', homeDir, env: {} });

    expect(profiles.map(profile => ({
      id: profile.id,
      name: profile.profileName,
      account: profile.accountLabel,
    }))).toEqual([
      { id: 'chrome:Default', name: 'Default profile', account: 'default@example.test' },
      { id: 'chrome:Profile 3', name: 'Deploy', account: 'deploy-user@example.test' },
    ]);
    expect(profiles.every(profile => !profile.id.includes('..'))).toBe(true);
  });

  test('keeps only the stable profile id and does not silently switch a stale selection', () => {
    const profiles: BrowserProfile[] = [
      {
        id: 'chrome:Profile 3',
        browserId: 'chrome',
        browserName: 'Chrome',
        profileDirectory: 'Profile 3',
        profileName: 'Deploy',
        accountLabel: 'deploy-user@example.test',
      },
    ];

    expect(resolveSavedBrowserProfile(profiles, 'chrome:Profile 3')?.profileName).toBe('Deploy');
    expect(resolveSavedBrowserProfile(profiles, 'chrome:Profile 2')).toBeNull();
    expect(browserProfileOptionLabel(profiles[0]!)).toBe('Chrome · Deploy · deploy-user@example.test');
  });

  test('builds argv without shell interpolation for the selected profile', () => {
    const profile: BrowserProfile = {
      id: 'chrome:Profile 3',
      browserId: 'chrome',
      browserName: 'Chrome',
      profileDirectory: 'Profile 3',
      profileName: 'Deploy',
      accountLabel: 'deploy-user@example.test',
    };

    expect(buildChromeProfileLaunch({
      platform: 'darwin',
      homeDir: '/Users/test',
      env: {},
      profile,
      url: 'https://agents.example.test/login?next=%2F',
    })).toEqual({
      command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: [
        '--profile-directory=Profile 3',
        'https://agents.example.test/login?next=%2F',
      ],
    });
  });

  test('rejects unsafe profile directories and non-web URLs', () => {
    const profile: BrowserProfile = {
      id: 'chrome:../escape',
      browserId: 'chrome',
      browserName: 'Chrome',
      profileDirectory: '../escape',
      profileName: 'unsafe',
      accountLabel: null,
    };

    expect(() => buildChromeProfileLaunch({
      platform: 'darwin', homeDir: '/Users/test', env: {}, profile, url: 'https://example.test',
    })).toThrow('안전하지 않은 Chrome 프로필');

    expect(() => buildChromeProfileLaunch({
      platform: 'darwin',
      homeDir: '/Users/test',
      env: {},
      profile: { ...profile, id: 'chrome:Default', profileDirectory: 'Default' },
      url: 'file:///Users/test/secret',
    })).toThrow('http 또는 https');
  });


  test('uses the selected profile only for automatic deploy portal items', () => {
    expect(isDeploymentPortalItem({ id: 'auto:deploy:project-1', type: 'web', url: 'https://app.example.test' })).toBe(true);
    expect(isDeploymentPortalItem({ id: 'auto:github:project-1', type: 'web', url: 'https://github.com/example/repo' })).toBe(false);
    expect(isDeploymentPortalItem({ id: 'manual-bookmark', type: 'web', url: 'https://app.example.test' })).toBe(false);
    expect(isDeploymentPortalItem({ id: 'auto:deploy:project-1', type: 'folder' })).toBe(false);
  });
});
