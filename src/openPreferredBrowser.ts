import { invoke } from '@tauri-apps/api/core';
import { isTauri, isDeployedWeb } from './lib/env';
import { readPreferredBrowser } from './browserPreference';
import type { BrowserProfile } from './browserProfile';

/** A chosen account profile deliberately overrides the general browser preference. */
export async function openPreferredBrowser(url: string, profile?: BrowserProfile | null): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('브라우저에서는 http 또는 https 주소만 열 수 있습니다.');
  }
  // A hosted portal cannot launch applications on a visitor's computer.
  if (isDeployedWeb()) {
    window.open(parsed.href, '_blank', 'noopener,noreferrer');
    return;
  }
  const browser = profile ? 'chrome' : readPreferredBrowser();
  if (isTauri()) {
    await invoke('open_preferred_browser', { url: parsed.href, browser, profileDirectory: profile?.profileDirectory ?? null });
    return;
  }
  const response = await fetch('/api/open-browser', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: parsed.href, browser, profileId: profile?.id ?? null }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success !== true) {
    throw new Error(result.error || '선택한 브라우저를 열지 못했습니다. 로컬 API를 최신 버전으로 실행해주세요.');
  }
}
