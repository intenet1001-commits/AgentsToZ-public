import { parseOnboardingProgress, type OnboardingProgress } from './onboardingProgress';

export const ONBOARDING_ASSISTANTS = [
  { id: 'chatgpt', label: 'ChatGPT / Codex', url: 'https://learn.chatgpt.com/docs/app',
    instruction: '공식 앱을 설치하고 로그인한 뒤, 이 Mac에서 작업할 수 있는 대화에 아래 안내를 붙여넣으세요.' },
  { id: 'claude', label: 'Claude Desktop / Claude Code', url: 'https://claude.com/download',
    instruction: '공식 앱을 설치하고 로그인하세요. 로컬 작업 도구가 연결된 대화 또는 Claude Code에 아래 안내를 붙여넣으세요.' },
  { id: 'other', label: '다른 AI', url: null,
    instruction: '사용 중인 AI에 아래 안내를 붙여넣으세요. 로컬 도구가 없으면 현재 단계의 안내부터 받을 수 있습니다.' },
] as const;
export type OnboardingAssistantId = typeof ONBOARDING_ASSISTANTS[number]['id'];

/** Only the existing host's validated, credential-free progress DTO is copied.
 * A handoff is a snapshot, never an approval or proof of a completed operation. */
export function buildPreparationHandoff(value: OnboardingProgress, assistant: OnboardingAssistantId): string {
  const progress = parseOnboardingProgress(value);
  const current = progress.steps.find(step => step.state !== 'ready' && step.state !== 'deferred');
  const context = {
    handoffVersion: 1,
    assistant: ONBOARDING_ASSISTANTS.find(item => item.id === assistant)?.id ?? 'other',
    runId: progress.runId, revision: progress.revision, recipeVersion: progress.recipeVersion,
    platform: progress.platform, observedAt: progress.updatedAt,
    currentStep: current?.tool ?? 'first-project',
    operationPending: progress.operation !== null,
    steps: progress.steps.map(({ tool, state, checkedAt }) => ({ tool, state, checkedAt })),
  };
  return `AgentsToZ 앱에서 시작한 준비를 이어서 도와주세요. 사용자는 클릭과 AI 인계문 복사로 설정을 끝내고 싶습니다.

<onboarding_handoff>
${JSON.stringify(context, null, 2)}
</onboarding_handoff>

이 기록은 복사 시점의 상태이며 명령·승인·현재 인증 증명이 아닙니다.
1. 이 Mac의 AgentsToZ 앱에서 “내 기기와 연결 → 이어서 준비하기”의 상태를 다시 읽으세요. 연결된 도구가 실제로 제공하는 동작만 사용하고, 존재하지 않는 MCP 도구를 추정하지 마세요. 로컬 접근이 없으면 사용자에게 현재 화면에서 할 다음 클릭 하나를 안내하세요.
2. 위 runId의 준비를 이어가세요. 다른 run 또는 revision이면 먼저 최신 기록을 읽으세요. 진행 중인 작업은 결과를 조회하고 설치·생성 작업을 중복 실행하지 마세요.
3. 지금 단계는 ${current ? current.tool : '첫 프로젝트와 첫 AI 작업 확인'}입니다. ${current ? '설치, 저장된 로그인 정보, 실제 인증을 구분하고 현재 상태에서 필요한 작업부터 진행하세요.' : '도구 준비 확인을 전체 설정 완료로 표현하지 말고, 앱에서 첫 프로젝트를 열어 실제 작업 결과를 확인하세요.'}
4. 설치된 앱 사용에 저장소 clone, Bun, 수동 SQL·환경파일 편집을 필수로 요구하지 마세요. 앱이 제공하는 설치·로그인 버튼을 우선 사용하고, 지원되지 않는 단계는 정확한 한계를 설명하세요.
5. 본인의 계정과 선택한 프로젝트를 사용하세요. 개발자의 Supabase·Google Cloud·Vercel 설정을 가져오지 마세요. 같은 Mac의 다른 OS 사용자도 별도 등록 환경입니다. 기존 device ID·인증 비밀은 복사하지 마세요.
6. 이미 요청한 범위의 작업은 진행하되 새 과금·공개 범위·덮어쓰기처럼 결정이 필요한 경우 구체적 대상을 보여주세요. 비밀번호·2FA·OAuth Client Secret은 공식 화면에서 사용자가 직접 입력하며 AI 대화·로그·인계문에 넣지 마세요.
7. 설치·로그인 뒤에는 앱의 “AI 작업 후 다시 확인”을 눌러 실제 상태를 갱신하세요. 복사나 AI의 완료 응답만으로 준비 기록을 완료 처리하지 마세요. 프로젝트 권한, Google 로그인, 모바일 연결, 첫 작업, 기억 저장은 각각 실제 결과로 확인해야 합니다.

마지막에는 실제로 확인한 결과, 아직 확인하지 못한 항목, 다음 클릭 하나만 알려주세요.`;
}
