export type OnboardingDeviceStage =
  | 'fresh'
  | 'configured-unregistered'
  | 'additional-pending'
  | 'registered';

export interface OnboardingLocalEvidence {
  supabaseUrl?: unknown;
  supabaseAnonKey?: unknown;
  deviceId?: unknown;
  pendingDeviceRegistration?: unknown;
  localAdminPresent?: boolean;
}

export interface OnboardingDiagnosis {
  stage: OnboardingDeviceStage;
  recommendedAction:
    | 'choose-first-or-additional'
    | 'finish-current-setup'
    | 'resume-additional-registration'
    | 'create-additional-device-invite';
  hasSupabaseConfig: boolean;
  hasDeviceIdentity: boolean;
  localAdminPresent: boolean;
  canCreateAdditionalDeviceInvite: boolean;
  needsExistingDeviceAnswer: boolean;
}

const hasText = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0
);

/**
 * 로컬에서 증명할 수 있는 사실만으로 현재 설치의 단말 상태를 판정한다.
 *
 * 완전히 새 클론은 아직 Supabase 프로젝트를 모르므로 "세상에 다른 단말이 있는지"를
 * 원격 조회할 수 없다. 그 경우만 한 번 질문하고, 기존 ID를 추측하거나 복사하지 않는다.
 */
export function diagnoseOnboardingDevice(evidence: OnboardingLocalEvidence): OnboardingDiagnosis {
  const hasSupabaseConfig = hasText(evidence.supabaseUrl) && hasText(evidence.supabaseAnonKey);
  const hasDeviceIdentity = hasText(evidence.deviceId);
  const localAdminPresent = evidence.localAdminPresent === true;
  const pending = evidence.pendingDeviceRegistration === true;

  if (hasSupabaseConfig && hasDeviceIdentity && pending) {
    return {
      stage: 'additional-pending',
      recommendedAction: 'resume-additional-registration',
      hasSupabaseConfig,
      hasDeviceIdentity,
      localAdminPresent,
      canCreateAdditionalDeviceInvite: false,
      needsExistingDeviceAnswer: false,
    };
  }

  if (hasSupabaseConfig && hasDeviceIdentity) {
    return {
      stage: 'registered',
      recommendedAction: 'create-additional-device-invite',
      hasSupabaseConfig,
      hasDeviceIdentity,
      localAdminPresent,
      canCreateAdditionalDeviceInvite: true,
      needsExistingDeviceAnswer: false,
    };
  }

  if (hasSupabaseConfig || hasDeviceIdentity) {
    return {
      stage: 'configured-unregistered',
      recommendedAction: 'finish-current-setup',
      hasSupabaseConfig,
      hasDeviceIdentity,
      localAdminPresent,
      canCreateAdditionalDeviceInvite: false,
      needsExistingDeviceAnswer: true,
    };
  }

  return {
    stage: 'fresh',
    recommendedAction: 'choose-first-or-additional',
    hasSupabaseConfig,
    hasDeviceIdentity,
    localAdminPresent,
    canCreateAdditionalDeviceInvite: false,
    needsExistingDeviceAnswer: true,
  };
}
