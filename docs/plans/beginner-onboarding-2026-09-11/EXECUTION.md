# 첫 구현 기록 — 설치 준비와 정확한 판정

후속 구현: [GitHub 설치·로그인 대표 경로](GITHUB-EXECUTION.md). 아래는 첫 구현 시점의 경계다.

2026-09-11. [전체 계획](PLAN.md) 중 O1의 준비 기록/진단과 O2의 일부 UI를 구현했다.
전체 온보딩, 자동 installer, 인증 broker, 첫 AI 작업, 공개 고객 모바일 연결 완료를 뜻하지 않는다.

## 구현

- 설치·연결 현황판에 `필요한 도구부터, 하나씩` 패널 추가. AI CLI 네 가지와 GitHub/Supabase/Vercel 중 필요한 도구 선택, 다음 항목, 보류/재개를 제공한다.
- 로컬 `onboarding/progress-v1.sqlite`에 선택과 검사 상태를 저장한다. 새 단말 ID·프로젝트·계정·설치 상태를 임의 생성하지 않는다.
- 고정 도구 ID만 받는 `/api/onboarding/progress`는 선택 저장·보류·읽기 전용 진단만 처리한다. 임의 명령·완료 상태·credential은 입력받지 않는다. 기존 localhost Host/Origin 경계 뒤에 있으며 **설치 권한이 아니다**.
- SQLite 즉시 트랜잭션과 revision 비교로 다른 창/늦은 결과의 덮어쓰기를 막는다. 검사 시작을 먼저 저장하며, 재실행 시 저장된 결과만 읽는다. 30초 지난 미확정 **읽기 검사**는 사용자가 명시적으로 재검사할 수 있다. 자동 mutation 재생은 없다.
- 파일/폴더 소유권·권한·심볼릭 링크/하드 링크와 DB schema를 확인한다. 손상된 기록/미지원 schema를 초기화하지 않는다.
- CLI 버전만 확인된 AI는 `설치 확인 · 로그인은 별도 확인`이다. 로그인/접근 오류와 네트워크·TLS·timeout 등의 불확정을 구분해 credential 초기화를 권하지 않는다.
- Vercel 기존 상태 API에서 `npx`를 제거하고 존재하는 CLI만 제한 시간 내 조회한다. 계정 원문을 반환하지 않는다.
- 추가 단말 초대는 legacy JWT의 `anon` 역할과 publishable key 형식을 검사한다. `service_role`/secret은 거부한다. 이 검사는 유출 방지이며 JWT 서명 검증을 대신하지 않는다.

## 검증

- Bun 상태/HTTP 회귀: 재시작 복원, 두 창 CAS, 설치와 로그인 구분, 보류/재개, 미래 schema 보존, 중단 검사 명시 재시도, 늦은 응답 거부, 손상 기록 보존, 과대 요청/임의 완료 입력 거부.
- 실제 Chromium + 격리 SQLite/HTTP: React StrictMode 초기 로드, 선택 저장, 실제 진단 증거 표시, 새로고침, 보류 후 재개, 새로고침 시 자동 재검사 없음. `bun tests/onboarding-preparation-ui.mjs`.
- 검사에는 사용자 credential/설치 앱 DB를 쓰지 않는다. 이 UI 시험은 installer/공급자 로그인/신규 Mac 또는 iPhone 5G 검증이 아니다.
- 전체 `bun run verify` 통과: TypeScript, Bun 4,082 pass/0 fail, Rust 56 pass/0 fail. 이후 추가한 격리 API·중단/손상 회귀를 포함한 집중 검사 15 pass/0 fail, 최종 TypeScript 재검사 통과.
- Vite 프런트엔드 빌드 통과(기존 큰 chunk 안내 있음). 빌드 CSS를 적용한 390px Chromium의 밝은/어두운 테마에서 가로 넘침 없음과 화면을 확인했다.

## 남은 구현 순서

1. 별도 설치 capability 및 고정 recipe/영수증·프로세스 소유권. 대표 도구 하나의 설치/중단/검증 경로부터 구현한다.
2. 로그인 전용 세션과 일반 워크룸/발언/자동 기억의 수집 경계, 공급자별 로그인/첫 사용 증거.
3. 새 시작 화면을 기본 진입으로 전환하고 기존 마법사의 검증된 기능을 이관한다. 현 단계에서는 기존 기능을 제거하지 않았다.
4. Supabase OAuth broker/gateway 및 신규 사용자 모바일 연결은 별도 외부 설정·실기기 실증 후 진행한다.

공식 설치 안내 링크를 여는 것은 자동 설치 완료가 아니다. 기존 Supabase legacy helper의
프로젝트 조회·link/create 경로 및 CLI 로그인 endpoint는 새 엔진으로 아직 이관하지 않았다.
현재 변경은 소스 작업이며 설치 Mac 앱/웹/TestFlight 배포는 하지 않았다.
