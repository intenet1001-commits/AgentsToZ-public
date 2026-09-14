export interface BrowserProfile {
  /** Stable local identifier. This is the only value persisted by the UI. */
  id: string;
  browserId: 'chrome';
  browserName: string;
  profileDirectory: string;
  profileName: string;
  /** Display-only local account hint. Never persist this value. */
  accountLabel: string | null;
}

export const DEPLOYMENT_BROWSER_PROFILE_STORAGE_KEY = 'portmanager-deployment-browser-profile';

export function resolveSavedBrowserProfile(
  profiles: readonly BrowserProfile[],
  savedId: string | null | undefined,
): BrowserProfile | null {
  if (!savedId) return null;
  return profiles.find(profile => profile.id === savedId) ?? null;
}

export function browserProfileOptionLabel(profile: BrowserProfile): string {
  return [profile.browserName, profile.profileName, profile.accountLabel]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' · ');
}

export function isSafeBrowserProfileDirectory(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0
    && trimmed === value
    && trimmed !== '.'
    && trimmed !== '..'
    && !trimmed.includes('/')
    && !trimmed.includes('\\')
    && !trimmed.includes('\0')
    && !/[\u0000-\u001f\u007f]/.test(trimmed);
}

export function isDeploymentPortalItem(item: {
  id: string;
  type: string;
  url?: string;
}): boolean {
  return item.type === 'web'
    && typeof item.url === 'string'
    && item.url.trim().length > 0
    && item.id.startsWith('auto:deploy:');
}
