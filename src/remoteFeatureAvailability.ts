/**
 * What a phone screen may say about one feature of the connected Mac (browser-safe, no imports).
 *
 * `supportedFeatures` arrives in two steps: the legacy answer (capped at eight names, so the extended-only ones —
 * 공통기억 `goal-common-memory-v1`, 기기 기억 `device-memory-v1`, the v2 RPC — are never in it) and then the extended
 * manifest. Until the extended answer, or an old Mac's refusal of it, is in, a missing name proves nothing: telling
 * the person to update a current Mac then was the 기록 tab's 「연결한 Mac 앱을 업데이트하면…」 on a 1639 Mac
 * (2026-11-01). Only a confirmed manifest without the name is 「update required」.
 */
export type RemoteFeatureAvailability = 'ready' | 'checking' | 'update-required';

export const REMOTE_FEATURE_CHECKING = '연결한 Mac이 지원하는 기능을 확인하는 중입니다.';

export function remoteFeatureAvailability(
  status: { supportedFeatures: readonly string[] | null; featuresProbing?: boolean; extendedCapabilitiesChecked?: boolean },
  feature: string,
): RemoteFeatureAvailability {
  if (status.supportedFeatures?.includes(feature)) return 'ready';
  if (status.supportedFeatures === null || status.featuresProbing || status.extendedCapabilitiesChecked !== true) return 'checking';
  return 'update-required';
}
