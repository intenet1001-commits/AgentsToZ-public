import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isSafeBrowserProfileDirectory,
  type BrowserProfile,
} from './browserProfile';

type Platform = NodeJS.Platform | 'darwin' | 'win32' | 'linux';

interface BrowserHost {
  platform?: Platform;
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

interface ChromeLaunchInput extends BrowserHost {
  profile: BrowserProfile;
  url: string;
}

export interface BrowserLaunchSpec {
  command: string;
  args: string[];
}

function chromeUserDataDir({
  platform = process.platform,
  homeDir = homedir(),
  env = process.env,
}: BrowserHost): string | null {
  if (platform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    return localAppData ? join(localAppData, 'Google', 'Chrome', 'User Data') : null;
  }
  if (platform === 'linux') {
    return join(homeDir, '.config', 'google-chrome');
  }
  return null;
}

function chromeExecutable({
  platform = process.platform,
  homeDir = homedir(),
  env = process.env,
}: BrowserHost): string {
  if (platform === 'darwin') {
    const userInstall = join(homeDir, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
    return existsSync(userInstall)
      ? userInstall
      : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  if (platform === 'win32') {
    const candidates = [
      env.PROGRAMFILES && join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env['PROGRAMFILES(X86)'] && join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].filter((candidate): candidate is string => Boolean(candidate));
    return candidates.find(candidate => existsSync(candidate)) ?? candidates[0] ?? 'chrome.exe';
  }
  return 'google-chrome';
}

function profileSortKey(directory: string): [number, number, string] {
  if (directory === 'Default') return [0, 0, directory];
  const numbered = directory.match(/^Profile (\d+)$/);
  return numbered ? [1, Number(numbered[1]), directory] : [2, 0, directory];
}

export function discoverChromeProfiles(host: BrowserHost = {}): BrowserProfile[] {
  const userDataDir = chromeUserDataDir(host);
  if (!userDataDir) return [];
  const localStatePath = join(userDataDir, 'Local State');
  if (!existsSync(localStatePath)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(localStatePath, 'utf8'));
  } catch {
    return [];
  }
  const infoCache = (parsed as any)?.profile?.info_cache;
  if (!infoCache || typeof infoCache !== 'object' || Array.isArray(infoCache)) return [];

  return Object.entries(infoCache as Record<string, unknown>)
    .filter(([profileDirectory]) => (
      isSafeBrowserProfileDirectory(profileDirectory)
      && existsSync(join(userDataDir, profileDirectory))
    ))
    .sort(([left], [right]) => {
      const a = profileSortKey(left);
      const b = profileSortKey(right);
      return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
    })
    .map(([profileDirectory, raw]) => {
      const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const profileName = typeof value.name === 'string' && value.name.trim()
        ? value.name.trim()
        : profileDirectory;
      const accountLabel = typeof value.user_name === 'string' && value.user_name.trim()
        ? value.user_name.trim()
        : null;
      return {
        id: `chrome:${profileDirectory}`,
        browserId: 'chrome' as const,
        browserName: 'Chrome',
        profileDirectory,
        profileName,
        accountLabel,
      };
    });
}

export function buildChromeProfileLaunch(input: ChromeLaunchInput): BrowserLaunchSpec {
  if (input.profile.browserId !== 'chrome' || !isSafeBrowserProfileDirectory(input.profile.profileDirectory)) {
    throw new Error('안전하지 않은 Chrome 프로필입니다.');
  }

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new Error('유효한 배포 URL이 아닙니다.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('배포 URL은 http 또는 https 주소여야 합니다.');
  }

  return {
    command: chromeExecutable(input),
    args: [
      `--profile-directory=${input.profile.profileDirectory}`,
      parsed.toString(),
    ],
  };
}

/** Only a fixed browser allowlist may become an executable; URLs remain one argv. */
export function buildPreferredBrowserLaunch(input: BrowserHost & { browser: unknown; url: unknown }): BrowserLaunchSpec {
  if (typeof input.url !== 'string' || /[\u0000-\u001f\u007f]/.test(input.url)) throw new Error('올바른 웹 주소가 필요합니다.');
  const url = new URL(input.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('http 또는 https 주소만 열 수 있습니다.');
  const platform = input.platform ?? process.platform;
  switch (input.browser) {
    case 'ego-lite':
      if (platform !== 'darwin') throw new Error('Ego Lite 연결은 현재 macOS에서 지원합니다. 앱 설정에서 Chrome 또는 시스템 기본 브라우저를 선택해주세요.');
      return { command: '/usr/bin/open', args: ['-a', 'ego lite', url.href] };
    case 'system':
      return platform === 'darwin'
        ? { command: '/usr/bin/open', args: [url.href] }
        : platform === 'win32'
          ? { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url.href] }
          : { command: 'xdg-open', args: [url.href] };
    case 'chrome':
      return platform === 'darwin'
        ? { command: '/usr/bin/open', args: ['-a', 'Google Chrome', url.href] }
        : { command: chromeExecutable(input), args: [url.href] };
    default: throw new Error('지원하지 않는 브라우저입니다.');
  }
}
