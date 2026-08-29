// 프로젝트 장기기억 기능 **전체**의 버전. 표면이 둘이지만 번호는 하나다:
//
//   - 앱이 설치하는 스킬·훅 (project-memory-server.ts → CURRENT_MEMORY_AGENT_VERSION)
//   - 앱 없는 PC로 복사돼 나가는 설정 프롬프트 (src/ProjectMemoryPanel.tsx)
//
// 표면마다 번호를 따로 두면 한쪽만 개선하고 다른 쪽 번호를 안 올리는 상태가 생기고,
// 그러면 받는 쪽이 "이미 최신"으로 판단해 개선분이 영영 도달하지 않는다.
// 어느 쪽 문구를 고치든 이 값을 올린다.
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
export const CURRENT_PROJECT_MEMORY_VERSION = 15;

// 앱이 설치한 파일에 박히는 마커. 앱을 아는 프로젝트에서만 쓴다.
export const memoryAgentVersionMarker = (version = CURRENT_PROJECT_MEMORY_VERSION) =>
  `<!-- AgentsToZ memory-agent-version:${version} -->`;

// 복사 프롬프트가 설치하는 파일에 박히는 마커. 받는 쪽은 이 앱의 존재를 모르므로
// 제품명을 넣지 않는다 — 번호만 같으면 개선은 같이 따라간다.
export const standaloneMemoryVersionMarker = (version = CURRENT_PROJECT_MEMORY_VERSION) =>
  `<!-- project-memory:${version} -->`;
