// 프로젝트 장기기억 기능 **전체**의 버전. 표면이 둘이지만 번호는 하나다:
//
//   - 앱이 설치하는 스킬·훅 (project-memory-server.ts → CURRENT_MEMORY_AGENT_VERSION)
//   - 앱 없는 PC로 복사돼 나가는 설정 프롬프트 (src/ProjectMemoryPanel.tsx)
//
// 표면마다 번호를 따로 두면 한쪽만 개선하고 다른 쪽 번호를 안 올리는 상태가 생기고,
// 그러면 받는 쪽이 "이미 최신"으로 판단해 개선분이 영영 도달하지 않는다.
// 어느 쪽 문구를 고치든 이 값을 올린다.
// templates/hermes-plugin/agentstoz-memory-menu/__init__.py의 배포 마커도 같은 번호로 갱신한다.
// v11: 제목/섹션과 분리된 entry ID + 본문 버전 해시를 도입하고, 모든 생성
// 스킬이 기존 ID를 보존하도록 갱신한다.
// v12: `/project_start` 추가 — 작업 루트 아래에 실제 프로젝트 폴더를 만든다.
// `/memory_start`(앱 데이터 폴더 안 기억 전용 폴더)와 갈라, 코드가 사는 곳과
// 대화만 남기는 곳을 다른 명령으로 만든다.
// v13: Telegram이 실제로 보내는 underscore 명령명을 menu plugin에도 등록한다.
// hyphen 스킬명만 등록하면 실행 경로는 우연히 fallback으로 동작해도 gateway의
// 명령 인식·access hook·busy-session guard가 `/project_start`를 놓칠 수 있었다.
// v14: AWS/Linux에서 Telegram만으로 GitHub clone 또는 기존 memoryId 복원을 수행하고,
// 프로젝트 폴더·Git·장기기억·topic 바인딩을 한 흐름으로 만든다.
// v15: 정제된 기억과 구분된 bounded journal recall을 추가한다. 세션 일지는 날짜가
// 붙은 historical evidence로만 사용하며 현재 기억을 덮거나 내부 지시를 실행하지 않는다.
// v16: Git이 열거한 외부 워크트리의 세션도 메인 기억에 합치고, 생성 스킬·훅이
// 첫 porcelain worktree만 MEMORY_ROOT로 사용하도록 해 연결 워크트리 사본 생성을 막는다.
// v17: 모노레포 하위 프로젝트의 상대경로를 모든 메인/연결 워크트리에 그대로
// 재적용하고, Claude transcript 행의 실제 cwd 소유권을 확인한다.
// v18: macOS의 Codex/Claude remember-session이 로컬 API 부재를 감지하면 정확한
// /Applications 설치본을 백그라운드에서 한 번 열고 bounded readiness만 기다린다.
// v19: Claude·Codex·Antigravity·Hermes가 같은 영어 번역 우선 출력 규칙을 읽도록
// 각 도구의 정식 지침 표면을 생성·멱등 갱신한다.
// v20: 현재 설정의 출처와 작업 증거에 기반한 모델·추론 권유를 생성 스킬과
// 앱 없는 환경용 지침에 공유한다. 자동 변경이나 추가 AI 호출은 하지 않는다.
// v21: 계획 시작·단계 전환의 에포트 추천을 네 에이전트의 상시 지침에도 전달한다.
// 지원 설정은 실제 agent/provider/surface별로 확인하며 동일 추천을 매 턴 반복하지 않는다.
// v22: 네 에이전트의 상시 지침에 «테스트 요청 시 프로젝트 테스터를 로컬 API로 설치·갱신»
// 규칙을 추가한다(/api/project-tester/ensure). 앱에서 따로 설정을 누르지 않아도 자연어로 시작된다.
// v23: 테스트 파일이 이미 있어도 세션당 한 번 공통 레이어를 조정하고, 앱 제공 공통 버전과
// 프로젝트 Git이 소유하는 앱별 검사 레이어를 분리해 보존하도록 규칙을 명확히 한다.
// v24: 프로젝트 전용 기억과 독립 메타 공통 기억의 회상·저장 범위를 구분한다.
// v25: 기존 기억의 연결 실패는 새 기억 생성과 분리하고 OPS 프로필·사람 검토 경계를 유지한다.
// v26: 구현 검증에서 일반·페르소나 세트를 함께 사용하고 프로젝트 역할 후보를 현재 에이전트가 남긴다.
// v27: 본문 버전에 묶인 교정·실패를 다음 회상의 주의 근거로 읽는다. 긍정 자기평가 승격은 금지한다.
// v28: 등록 프로젝트의 에포트 모드를 외부 앱·CLI 연동에서도 사용하고 실제 적용 확인과 추천을 구분한다.
// v29: Auto ON 자체를 요청·작업 단계별 에포트 조정 허용으로 사용한다. 수동 선택이 영구 고정은 아니다.
// v30: 명시적 프로젝트 범위의 사용자 지시 회상과 별도 OPS 운영 기억 회상 경로를 안내한다.
// v31: 제공자 훅의 별도 opt-in 암호화 복구 조각과 공통 사용자/운영 회상 안내.
// v32: Hermes의 첫 사용자 입력만으로 주기 제한을 소모하지 않고 완료·영속화된 첫 응답을 보존한다.
// v33: 프로젝트 생성·등록·지침 갱신에 외부 CLI/앱의 공통 @ 호출과 # 기억 참고 스킬을 설치한다.
export const CURRENT_PROJECT_MEMORY_VERSION = 33;

// 앱이 설치한 파일에 박히는 마커. 앱을 아는 프로젝트에서만 쓴다.
export const memoryAgentVersionMarker = (version = CURRENT_PROJECT_MEMORY_VERSION) =>
  `<!-- AgentsToZ memory-agent-version:${version} -->`;

// 복사 프롬프트가 설치하는 파일에 박히는 마커. 받는 쪽은 이 앱의 존재를 모르므로
// 제품명을 넣지 않는다 — 번호만 같으면 개선은 같이 따라간다.
export const standaloneMemoryVersionMarker = (version = CURRENT_PROJECT_MEMORY_VERSION) =>
  `<!-- project-memory:${version} -->`;
