import type { OnboardingDiagnosis } from './onboardingDiagnosis';
import type { OnboardingScenarioId, OnboardingToolDiagnostic } from './onboardingInfrastructure';
import { isPreparationTool, preparationEvidence } from './onboardingProgress';

export interface LocalOnboardingStatus extends OnboardingDiagnosis {
  deviceName?: string;
  supabaseReachable?: boolean | null;
  lastSuccessfulPushAt?: string | null;
}

export function connectionSummary(status: LocalOnboardingStatus | null, scenario: OnboardingScenarioId) {
  const summary = (label: string, title: string, detail: string, ready = false) => ({ label, title, detail, ready });
  if (!status) return summary('확인 필요', '현재 단말 연결 상태를 확인하지 못했습니다.',
    '앱을 다시 열거나 다시 검사하세요. 저장된 설정은 유지됩니다.');
  if (status.stage === 'registered' && status.localAdminPresent) {
    if (status.supabaseReachable !== true) return summary('연결 확인 필요', '단말 설정은 있지만 현재 연결을 확인하지 못했습니다.',
      status.supabaseReachable === false ? '네트워크와 Supabase 프로젝트 상태를 확인한 뒤 다시 검사하세요.' : 'Supabase 응답을 확인한 뒤 동기화 상태를 판단할 수 있습니다.');
    if (status.lastSuccessfulPushAt && Number.isFinite(Date.parse(status.lastSuccessfulPushAt))) return summary(
      '연결 확인됨', '현재 Supabase 응답과 이전 동기화 기록을 확인했습니다.',
      `마지막 Push 기록: ${new Date(status.lastSuccessfulPushAt).toLocaleString('ko-KR')}. Google 로그인·모바일 원격 작업은 별도로 확인해야 합니다.`, true);
    return summary('동기화 확인 필요', 'Supabase에 연결됐습니다.', '프로젝트 화면에서 실제 Push를 실행해 이 단말의 저장 결과를 확인하세요.');
  }
  if (status.stage === 'registered') return summary('관리자 연결 필요', '단말 ID는 있지만 로컬 관리자 연결이 남았습니다.',
    '이 PC의 Supabase 인증과 관리자 연결을 끝낸 뒤 동기화 결과를 확인하세요.');
  if (status.stage === 'additional-pending') return summary('등록 마무리 필요', '추가 단말 등록이 진행 중입니다.',
    '초기 설정으로 돌아가 이 PC가 만든 새 ID로 등록을 이어가세요.');
  if (status.stage === 'configured-unregistered') return summary('단말 등록 필요', '연결 정보 일부가 있지만 단말 등록이 끝나지 않았습니다.',
    '초기 설정에서 이 PC의 단말 등록을 이어가세요.');
  return summary(scenario === 'additional' ? '연결 정보 필요' : '설정 시작 전', '아직 이 PC의 동기화 환경을 설정하지 않았습니다.',
    scenario === 'additional' ? '기존 PC의 “다른 PC 연결 정보 만들기”를 사용하세요. 기존 단말 ID나 인증 비밀을 복사하지 않습니다.'
      : '로컬 작업부터 시작할 수 있습니다. 동기화가 필요하면 본인의 Supabase 환경을 연결하세요.');
}

/** Version, cached credentials and authenticated reads prove different things. */
export function toolReadiness(diagnostic: OnboardingToolDiagnostic) {
  if (!isPreparationTool(diagnostic.id)) return { state: diagnostic.state, label: null, verified: diagnostic.state === 'ready' };
  const evidence = preparationEvidence(diagnostic.id, diagnostic);
  if (evidence === 'installed') return { state: 'unknown' as const, label: '설치 확인 · 로그인 미확인', verified: false };
  if (evidence === 'configured') return { state: 'unknown' as const, label: '로그인 정보 있음 · 연결 미확인', verified: false };
  if (evidence === 'ready') return { state: 'ready' as const, label: '설치·로그인 확인', verified: true };
  return { state: evidence === 'unknown' ? 'unknown' as const : diagnostic.state, label: null, verified: false };
}
