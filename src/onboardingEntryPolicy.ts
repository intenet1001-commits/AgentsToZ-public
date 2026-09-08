import type { OnboardingDeviceStage, OnboardingLocalEvidence } from './onboardingDiagnosis';

export type OnboardingEntryState = OnboardingDeviceStage | 'checking' | 'unavailable';
export type OnboardingWizardMode = 'choose' | 'existing' | 'infrastructure' | 'first' | 'first_cli'
  | 'additional' | 'pair_device' | 'portal' | 'windows_env' | 'mac_env' | 'dev_env'
  | 'terminal_tools' | 'one_click';

const stages = new Set<unknown>(['fresh', 'configured-unregistered', 'additional-pending', 'registered']);

export function onboardingEntryState(input: {
  stage: unknown;
  checking: boolean;
  hasExistingDevice: boolean;
}): OnboardingEntryState {
  // A successful parent read must not be downgraded by an older sidecar response.
  if (input.hasExistingDevice || input.stage === 'registered') return 'registered';
  if (input.checking) return 'checking';
  return stages.has(input.stage) ? input.stage as OnboardingDeviceStage : 'unavailable';
}

/** Prevent entry and late status changes from mounting a setup writer. */
export function resolveOnboardingMode(
  requested: OnboardingWizardMode,
  state: OnboardingEntryState,
): OnboardingWizardMode {
  if (['first', 'first_cli', 'one_click'].includes(requested)) {
    if (state === 'registered') return 'existing';
    if (state === 'additional-pending') return 'additional';
    if (state === 'checking' || state === 'unavailable') return 'choose';
  }
  if (requested === 'additional') {
    if (state === 'registered') return 'existing';
    if (state === 'checking' || state === 'unavailable') return 'choose';
  }
  if ((requested === 'existing' || requested === 'pair_device') && state !== 'registered') return 'choose';
  return requested;
}

/** Recheck the latest local identity at completion, before persisting setup. */
export function onboardingCompletionProblem(
  existing: OnboardingLocalEvidence,
  setupKind: 'first' | 'additional' | undefined,
): string | null {
  const hasIdentity = typeof existing.deviceId === 'string' && !!existing.deviceId.trim();
  const hasProject = typeof existing.supabaseUrl === 'string' && !!existing.supabaseUrl.trim();
  if (hasIdentity && hasProject && existing.pendingDeviceRegistration !== true) {
    return '이 앱에는 기존 단말 설정이 있습니다. 기존 환경 이어쓰기에서 연결을 확인하세요. 추가 단말 설정은 새 Mac·Windows에서 진행하세요.';
  }
  if (hasIdentity && existing.pendingDeviceRegistration === true && setupKind !== 'additional') {
    return '진행 중인 추가 단말 등록이 있습니다. 두 번째·추가 기기 연결에서 같은 단말 ID로 이어가세요.';
  }
  return null;
}
