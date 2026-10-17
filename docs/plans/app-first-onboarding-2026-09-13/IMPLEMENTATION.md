# 구현 순서와 변경 단위

상태: 구현 진행 중. 실제 완료 범위는 [EXECUTION.md](EXECUTION.md)를 따른다. [PLAN.md](PLAN.md)의 최신 요청으로 고정한 우선순위를 따른다.
사용자의 구현 진행 요청에 따라 시작했으며, 계정·배포 변경과 코드 구현을 구분해 기록한다.
기존 9월 11일 O1/O2 구현은 재사용하며 두 번째 온보딩 엔진을 만들지 않는다.

## 1. 단계 순서와 의존성

| 단계 | 결과물 | 선행 조건 | 완료 기준 |
|---|---|---|---|
| P0 가능성·기준선 확인 | 배포 적합성 보고, 새 계정 기준선, OAuth 비밀 전달/포털 배포 실증 | 계획 검토 | TestFlight 가능/불가능/미확정, 설치본 단독 실행, 실제 자동화 경계를 각각 판정 |
| P1 실행 환경·진단 정리 | 사용자별 sidecar 발견, 단말 메타데이터, 공통 상태 DTO | P0의 로컬 실증 | 두 OS 사용자 동시 실행, 충돌/unknown 처리, 기존 UUID 보존 |
| P2 앱 시작·상시 연결 센터 | 단일 시작 도우미·내 기기와 연결·첫 프로젝트 | P1 | 앱 안내만으로 로컬 프로젝트 재실행/열기, 기존 사용자 설정 보존 |
| P3 AI 인계 왕복 | ChatGPT/Codex 및 Claude 선택, 공식 설치 안내, MCP/복붙, 재개 기록 | P2 | AI 없는 시작 → 연결 확인 → 같은 run 인계 → 앱이 실제 결과 재검사 |
| P4 현재 구성의 개인 환경 복제 | Supabase/Google OAuth/Vercel/GitHub 단계와 영수증 | P0 클라우드 실증 + P3 | 개발자 환경과 독립된 사용자의 로그인·기기 조회·동기화·배포 확인 |
| P5 모바일·상시 관리 | QR/로그인 후 목록 갱신, 원격 CLI 작업, 상태·복구·갱신 | P4 | 실제 iPhone 외부망 첫 작업과 앱 업데이트 후 연결 유지 |
| P6 배포·초보자 실기 | 공개 snapshot 설치본, TestFlight 외부 테스트 준비, 문서 전환 | P1~P5 및 채널별 적합성 | ACCEPTANCE의 지원 범위별 항목 통과·실패와 잔여 작업 공개 |
| F1 후속 간소화 | 공통 모바일+고객 gateway+등록 중계 | 별도 설계/외부 통합 실증 | 개인 Vercel/개별 Google OAuth 앱 없이 같은 사용자 경험 달성 |

권장 첫 구현 묶음: **P0의 짧은 실증과 P1 → P2 → P3의 Codex 대표 경로**.
P4에서는 신규 Supabase→Google→Vercel 전체 한 경로를 먼저 완성하고, 기존 자원 재사용·다른 AI로 확장한다.
타인 계정 로그인과 외부 심사 시간을 코드 작업 시간으로 추정하지 않는다. P0 후 파일별 변경과 실기 횟수로 일정을 다시 산정한다.
계정·권한/동시성 설계는 높은 추론 수준을 유지하고, 대표 구현/회귀가 안정되면 반복 UI/어댑터는 낮출 수 있다.

## 2. P0 — 큰 구현 전에 증명할 네 가지

### P0-A: Mac TestFlight 호스트 적합성

- 현재 app identifier·서명·sandbox·sidecar·CLI 탐색·폴더 선택·PTY·메모리 저장·원격 listener 사용을 기능별로 정리한다.
- 최소 시험 앱/지원되는 배포 설정에서 외부 CLI 실행, 사용자 폴더 읽기/쓰기, 자식 프로세스, 업데이트를 검증한다.
- 설치/실행 아키텍처가 Apple 조건에 부합하는지 문서와 실제 배포 결과를 구분해 기록한다.
- TestFlight에 업로드됐다는 결과와 설치 가능, 기능 실행 가능, 외부 테스터 배포 가능을 별도로 확인한다.
- 원격 MCP 또는 외부 AI에 실행을 넘겨 App Store 제한을 우회하는 구조를 합격으로 처리하지 않는다.
- 불가능한 기능이 있으면 최소 UI companion과 전체 호스트를 혼동하지 않으며 제품 범위 변경은 별도 결정한다.

### P0-B: 실제 새 OS 계정과 동시 실행

- 기존 계정의 Keychain/앱 데이터/기억을 복사하지 않는 실제 새 macOS 계정에서 검사한다.
- 공용 `/Applications`·Homebrew 실행 파일이 보이는 경우 사용자별 인증과 구분한다.
- 기존 계정의 앱/sidecar가 켜진 상태에서 새 계정 앱을 열어 포트 3001 점유 결과를 확인한다.
- 기존 사용자를 로그아웃한 시험과 빠른 사용자 전환 시험을 모두 기록한다.
- HOME만 바꾼 자동 시험을 OS 계정/Keychain 격리 실증으로 계산하지 않는다.

### P0-C: Google OAuth와 Supabase 자동 설정의 실제 경계

- 개인 Google Cloud 프로젝트 소유자, 프로젝트 ID/번호, OAuth client ID를 다른 개념으로 취급한다.
- 공식 UI로 가능한 단계, 공식 API로 가능한 단계, 사용자 보안 입력이 남는 단계를 분류한다.
- Client Secret을 AI/일반 UI/영수증에 노출하지 않고 공급자 사이에 전달할 수 있는 지원 경로를 검증한다.
- 해당 경로가 없다면 사용자 직접 보안 입력을 정확하게 안내하고 최소 조작 목표의 미달 항목으로 남긴다.
- 제공자 로그인과 리소스 생성 응답 유실 후 재조회가 가능한지 먼저 확인한다.

### P0-D: 소스 없는 Mac에서 개인 포털 배포

- 설치 앱의 cwd에 repo가 있다고 가정하지 않는다. 번들 동봉 또는 서명/해시 검증된 portal 배포 패키지를 사용한다.
- 패키지는 공개 snapshot commit·recipe·스키마·portal 버전을 묶고 개인 주소/키를 포함하지 않는다.
- legacy API가 repo link/build 경로를 요구하는지 추적하고 설치본 전용 어댑터로 분리한다.
- Vercel API 또는 검증된 CLI 어댑터로 대상 팀·프로젝트를 선택한 뒤 배포한다.
- GitHub 소스 사본 생성은 Git 연동 자동배포를 선택할 때만 필요하다. 설치 앱 사용과 구분한다.

## 3. P1 — 진단·실행 환경 계약

기존 `device_id`는 유지한다. 선택 메타데이터로 표시용 environment label, OS/architecture, 앱 버전/채널,
마지막 보고 시간, 선택적 physical grouping을 추가할 수 있다. username/UID/로컬 경로는 기본적으로 로컬 진단만 사용한다.
다른 OS 계정을 재설치 alias로 자동 합치지 않는다. 표시 이름 변경은 권한·TTL·프로젝트 소유권을 변경하지 않는다.

sidecar는 사용자별 endpoint resolver와 capability challenge를 사용한다. 포트 할당과 endpoint 파일 공개 사이 경쟁,
앱 재시작 세대, 오래된 endpoint, 타 사용자 파일, 기존 localhost 웹 클라이언트, MCP 브리지까지 한 계약으로 검증한다.
loopback인 것만으로 신뢰하지 않으며 기존 프로세스를 포트 번호만으로 종료하지 않는다.
사용자별 listener로 해결할 수 없는 Store 제약은 P0-A 결과에 따라 별도 설계한다.

진단 상태는 도구 설치/인증/리소스 권한/선택 기능 실행 결과를 각각 보관한다. 조회가 생성·설치·로그인을 시작하지 않는다.
네트워크/권한/Keychain/CLI 출력 변경은 `확인하지 못함`으로 남긴다. 실패를 `계정 없음`으로 바꾸지 않는다.
검사 결과는 environment·선택 workspace·provider/account 세대에 결속하고 늦은 결과를 폐기한다.
목표 예산: 로컬 probe 3초, 외부 read 10초, 전체 초기 묶음 15초; 실제 성능 측정 후 조정한다.
최대 2개 probe 동시 실행, 동일 검사 합치기, 숨겨진 화면에서 반복 조회 중단, 앱 복귀/인증 변화 때 필요한 read만 갱신한다.
사용자 인증 대기를 위 timeout에 포함하지 않는다. 검사 지연 중에도 이전 결과의 시각을 표시하고 UI는 사용할 수 있다.

## 4. P2/P3 — 화면·앱 연결·AI 핸드오프

기존 `SetupWizard`와 `OnboardingInfrastructureCenter`를 얇은 진입으로 전환한다.
상태 정본은 기존 host/SQLite이고 React가 실행 프로세스를 소유하지 않는다.
첫 화면의 주 동작은 현재 상태에서 필요한 한 단계다. 전제 조건이 없는 도구는 선택 기능으로 접는다.
앱이 제공하는 도움 내용은 버전이 붙은 번들 자원으로 제공해 Supabase/소스 저장소가 없어도 읽을 수 있게 한다.

AI 연결 카드는 `설치`, `로그인`, `로컬 작업 가능`, `AgentsToZ MCP 확인`을 구분한다.
ChatGPT의 선택 표면/권한과 Claude Desktop의 extension 연결은 실제 handshake 결과로 표시한다.
없으면 공식 앱 열기·설치 안내·인계문 복사를 제공한다. 자동 붙여넣기/제공자 비공개 API를 전제로 하지 않는다.

새 온보딩 MCP는 다음 **제안 동작**만 기존 capability/recipe 엔진에 연결한다(아직 호출 가능한 도구명이 아님).

| 동작 | 입력/결과 계약 |
|---|---|
| 상태 읽기 | run 참조 → 비밀 없는 단계/증거/다음 행동 |
| 단계 제안 | 목표·고정 recipe ID → 실제 대상·영향·의존성 미리보기 |
| 승인된 단계 시작 | run·step·revision·호스트 검증 승인 참조 → 동일 operation 영수증 |
| 결과 재검사 | operation → 사후 상태 확인. 외부 생성 재실행 아님 |
| 보류·재개·취소 | 같은 run의 정책에 따른 변경. 중단했다고 외부 자원 삭제하지 않음 |

임의 shell/path/token을 받는 설치 도구를 추가하지 않는다. 기존 범용 agentstoz 작업 도구와 온보딩 권한은 분리한다.
AI 변경/대화 종료/재부팅 뒤에도 앱이 같은 영수증을 보여주고 AI 완료 문구로 체크를 채우지 않는다.

## 5. P4 — 사람·앱·AI의 역할

상세 순서는 [HANDOFF.md](HANDOFF.md)의 S0~S9다.
앱은 지원되는 설치·검사·DB 스키마 패키지·배포·결과 재조회 등 반복 작업을 담당한다.
AI는 공식 브라우저 화면에서 비밀 없는 입력/안내·예외 진단을 보조한다. 사람은 로그인/2FA·소유/요금/공개 결정과
자동 처리할 수 없는 보안 입력을 담당한다. 모든 단계마다 동일한 승인 질문을 반복하지 않는다.
AI 도구나 브라우저 자동화가 막히면 앱이 현재 단계의 공식 화면과 다음 동작 하나를 보여주며 보류/재개한다.

외부 변경은 실행 전 intended target과 operation을 저장한다. 성공 응답 유실 시 provider ID로 readback한다.
API가 멱등 키/조회 상관키를 제공하지 않으면 `결과 확인 필요`에서 멈추며 이름만으로 중복 자원을 선택/생성하지 않는다.
DB 스키마는 기존 `schemaSql.ts` 정본과 migration version/hash를 사용한다. 기존 DB의 예상 영향 확인 뒤 실행하고
데이터를 지우는 초기화는 기본 경로에 넣지 않는다. 롤백은 이 단계가 소유한 임시 자원만, 별도 확인 아래 처리한다.
Legacy 관리자 키는 일반 상태 DTO·브라우저·AI 인계에서 배제하고 선택 공간의 로컬 서버에만 결속한다.

## 6. 변경 파일과 재사용 대상

| 작업 | 기존 중심 파일 | 제안 신규 경계 |
|---|---|---|
| 기본 UI/현황 | `src/SetupWizard.tsx`, `src/OnboardingInfrastructureCenter.tsx`, `src/OnboardingPreparation.tsx`, `src/App.tsx` | 연결 센터 view-model와 실행 상태 구독 |
| 진단/재개 | `src/onboardingInfrastructure.ts`, `src/onboardingAuthDiagnosis.ts`, `src/onboardingProgress*.ts` | provider별 readiness·resource selection 계약 |
| 설치/로그인 | `src/onboardingCodex*.ts`, `src/onboardingGithub*.ts` | Claude/Hermes/agy/Supabase/Vercel recipe 어댑터 |
| 사용자별 endpoint | `src-tauri/src/lib.rs`, `src/appDataDir.ts`, `api-server.ts`, localhost client/브리지 전체 | 단일 endpoint resolver·서버 소유 증명 |
| 추가 단말 | `src/onboardingHandoff.ts`, `src/onboardingEntryPolicy.ts`, portal 단말 UI | 실행 환경 메타데이터·조회 공통 컴포넌트 |
| DB/클라우드 | `src/schemaSql.ts`, `api-server.ts` legacy Supabase/Vercel 경로 | package deploy·Google 설정 recipe/receipt |
| 모바일 | `src/remote-control-portal-main.tsx`, `src/remoteControlRelayController.ts`, `mobile/ios/App/*` | 로그인/승인 뒤 조회 조정·공간/기기 정보 표시 |
| 기억/문서 | Control 생성 경로, `.agents/skills/onboarding`, `docs/SELF-HOSTING.md`, `docs/user-guide` | 앱 동봉 핸드오프 템플릿과 버전 선언 |

아직 존재하지 않는 신규 모듈은 구현 시 정하고 기존 API를 임의로 사용했다고 표시하지 않는다.
새 사용자·개인 서버 ID를 공개 테스트 fixture로 복제하지 않고 샘플 namespace를 사용한다.

## 7. 유지 관리까지 이어지는 완료

시작 도우미 성공 후 연결 센터에는 계정/팀 변경, CLI 업데이트, 다시 로그인, 포털 재배포, 다른 기기 추가,
원격 권한 변경/회수, Control·기억 상태 확인을 남긴다. 자동 업데이트는 동의한 도구에 한정한다.
작업 중 CLI 교체는 연기하고 변경된 설치/인증 세대의 이전 검증은 오래된 것으로 표시한 뒤 재검사한다.
장기기억 자동 저장 동의와 모델/Keychain 준비는 별도이며 설치만으로 자동 활성화하지 않는다.
로컬 저장 성공과 원격 백업 성공은 분리한다. 계정 연결 해제를 프로젝트/기억 삭제로 구현하지 않는다.
