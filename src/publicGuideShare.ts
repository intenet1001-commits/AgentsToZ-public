import { ONBOARDING_GUIDE_URL } from './onboardingInfrastructure';

export const PUBLIC_GUIDE_SHARE_DATA = {
  title: 'AgentsToZ 아주 쉬운 시작 설명서',
  text: '코딩을 몰라도 따라 하는 AgentsToZ 설치·연결 설명서입니다.',
  url: ONBOARDING_GUIDE_URL,
} as const;

export type PublicGuideShareResult = 'shared' | 'copied' | 'cancelled';

interface GuideShareNavigator {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  clipboard?: { writeText: (value: string) => Promise<void> };
}

/** 모바일은 OS 공유창을 우선하고, 미지원·일시 실패 환경은 공개 주소 복사로 끝낸다. */
export async function sharePublicGuide(
  browserNavigator: GuideShareNavigator,
): Promise<PublicGuideShareResult> {
  const data: ShareData = { ...PUBLIC_GUIDE_SHARE_DATA };
  let canUseNativeShare = typeof browserNavigator.share === 'function';
  if (canUseNativeShare && browserNavigator.canShare) {
    try {
      canUseNativeShare = browserNavigator.canShare(data);
    } catch {
      canUseNativeShare = false;
    }
  }

  if (canUseNativeShare) {
    try {
      await browserNavigator.share!(data);
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
      // 공유창을 열 수 없는 브라우저도 아래의 주소 복사로 안전하게 마무리한다.
    }
  }

  if (!browserNavigator.clipboard?.writeText) {
    throw new Error('이 브라우저에서는 공유나 주소 복사를 사용할 수 없습니다.');
  }
  await browserNavigator.clipboard.writeText(PUBLIC_GUIDE_SHARE_DATA.url);
  return 'copied';
}
