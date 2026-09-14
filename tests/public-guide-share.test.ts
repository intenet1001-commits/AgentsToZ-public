import { describe, expect, test } from 'bun:test';
import { ONBOARDING_GUIDE_URL } from '../src/onboardingInfrastructure';
import { PUBLIC_GUIDE_SHARE_DATA, sharePublicGuide } from '../src/publicGuideShare';

describe('public guide sharing', () => {
  test('uses the mobile OS share sheet with only the canonical public guide URL', async () => {
    const shared: ShareData[] = [];
    const result = await sharePublicGuide({
      canShare: () => true,
      share: async data => { shared.push(data); },
    });

    expect(result).toBe('shared');
    expect(shared).toEqual([PUBLIC_GUIDE_SHARE_DATA]);
    expect(shared[0]?.url).toBe(ONBOARDING_GUIDE_URL);
    expect(JSON.stringify(shared)).not.toContain('service_role');
  });

  test('copies the canonical address when Web Share is unavailable or fails', async () => {
    const copied: string[] = [];
    const clipboard = { writeText: async (value: string) => { copied.push(value); } };

    expect(await sharePublicGuide({ clipboard })).toBe('copied');
    expect(await sharePublicGuide({
      share: async () => { throw new Error('share unavailable'); },
      clipboard,
    })).toBe('copied');
    expect(copied).toEqual([ONBOARDING_GUIDE_URL, ONBOARDING_GUIDE_URL]);
  });

  test('falls back to copying when a browser exposes a broken canShare implementation', async () => {
    const copied: string[] = [];
    expect(await sharePublicGuide({
      canShare: () => { throw new Error('broken capability probe'); },
      share: async () => { throw new Error('must not run'); },
      clipboard: { writeText: async value => { copied.push(value); } },
    })).toBe('copied');
    expect(copied).toEqual([ONBOARDING_GUIDE_URL]);
  });

  test('treats closing the share sheet as cancellation instead of copying unexpectedly', async () => {
    let copied = false;
    expect(await sharePublicGuide({
      share: async () => { throw new DOMException('cancelled', 'AbortError'); },
      clipboard: { writeText: async () => { copied = true; } },
    })).toBe('cancelled');
    expect(copied).toBe(false);
  });

  test('fails clearly when neither sharing nor clipboard is available', async () => {
    expect(sharePublicGuide({})).rejects.toThrow('공유나 주소 복사');
  });
});
