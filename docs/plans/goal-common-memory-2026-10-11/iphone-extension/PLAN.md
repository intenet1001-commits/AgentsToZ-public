---
cs_artifact:
  type: PLAN.md
  producer: CS-plan
  produced_at: "2026-10-11T10:09:08.394Z"
  status: ready
  gate:
    passed: true
    criterion: "4개 산출물 품질·정합성 게이트 통과"
    blocking_items: []
---

# 공통기억의 Mac·iPhone·MCP 및 구성 프로젝트 가져오기

protocol: LOOP-PROTOCOL [a-f] loaded (round budget 1)
recall: E3/C3/N0
hitl: auto — arch-choice: default(권장안) 채택
contracts: 4 issued / 4 accepted
계획 커버리지: 4/4 전문 역할 (100%)

공통기억을 장기기억과 같은 Mac 메뉴 깊이에 두고, iPhone·MCP에서 같은 목표·원본·검토·게시 계약을 사용한다. ‘공통기억으로부터 만들기’는 **현재 연결된 원본 프로젝트들을 이 단말에 개별 가져오기**로 제공한다. 공통기억 초안도 구성 프로젝트의 비교·가져오기에 사용할 수 있다.

이 문서의 ready는 **계획 품질 게이트 통과**다. 기능 구현·실제 MCP·실기기·production 연결·다른 Mac 설치의 통과를 뜻하지 않는다. 구현 담당자는 아래 acceptance와 체크리스트에 실제 실행 근거를 남긴다.

## 빠른 시작

1. [구현 체크리스트](implementation-checklist.md)의 기존 파일·담당 범위를 확인한다.
2. [TDD 전략](tdd-strategy.md)의 T01–T34 행동을 이미 있는 회귀와 대조하고 필요한 실패·중단 경계를 검증한다.
3. 실제 실행·수정 결과를 상위 `IPHONE-PLAN.md` 및 실행 기록에 연결한다. baseline quick 통과와 새 기능 통과는 각각 기록한다.

| 산출물 | 책임 |
|---|---|
| [domain-analysis.md](domain-analysis.md) | 원본 정체성, 구성·영수증·정확한 기존 binding의 정본 명칭과 계약 |
| [architecture.md](architecture.md) | 기존 함수형 4레이어 매핑, 독립 권한, bounded 원격 전송·공유 UI |
| [tdd-strategy.md](tdd-strategy.md) | 34개 행동 검사: Domain 7개, 통합 23개, 실제 iPhone persona 4개 |
| [implementation-checklist.md](implementation-checklist.md) | Inside-Out 구현·검증 순서와 Critical Files·완료 조건 |
| [PLAN.md](PLAN.md) | 확정 정책, 수용 조건, 네 문서의 정합성 검사 결과 |

## 아키텍처 선택 (arch-choice 체크포인트 결과)

**확정:** 기존 함수형 서비스 + 분리된 bounded 원격 어댑터 + 공유 UI + 고정 구성 계획. 선택 주체는 `HITL=auto`의 권장안 채택이다. 사용자가 구현·검증을 계속 진행하도록 요청했으므로 일상적인 설계 선택을 별도 승인 대기로 바꾸지 않았다.

| 레이어 | 기존 파일·확장 위치 | 책임 |
|---|---|---|
| Domain Layer | `src/commonMemory.ts`, `src/commonMemoryProjects.ts`, `src/gitCloneRequest.ts` | 목표·출처·게시본·적용 결과의 규칙, 구성 프로젝트 판정, 계획 비교, GitHub 주소 정규화 |
| Application Layer | `common-memory-server.ts`의 서비스 함수, `common-memory-projects-server.ts`의 주입된 함수형 실행 서비스 | 공통기억 관리·회상·binding, 원본 구성 조회, 프로젝트 추가 계획·단계 실행·영수증 복구 |
| Interface Adapters Layer | `src/commonMemoryRequest.ts`, `src/commonMemoryClient.ts`, `src/metaCommonMemoryRemoteHost.ts`, `src/metaCommonMemoryRemoteClient.ts`, `src/mobileWorkspaceGateway.ts`, React 화면 및 MCP 요청 변환 | 동일한 엄격 요청 계약, bounded DTO, 별도 권한 검사, 입력·출력·미확정 결과 표현 |
| Infrastructure Layer | `api-server.ts` 조립부, 기존 Supabase RPC·테이블, 앱 데이터의 영수증 파일, workspace lease·Git subprocess·등록 저장, Swift WKWebView | 실제 클라우드·파일·프로세스·연결·기기, 수명·동시 실행·중단 복구 |

대안인 장수 batch queue는 자율적인 대량 설치를 제공하지만 새 scheduler·취소·restart ownership을 관리해야 한다. 현재 최대 16개 원본은 한 구성원 호출·durable 영수증으로 필요한 중단 복구를 제공한다. 모바일 cloud 직접 관리 대안은 Mac 없이 접근할 수 있으나 새로운 인증·RLS·쓰기 계약이 필요하다. 이번 기능은 기존 승인된 host의 암호화 workspace를 재사용한다. 새 DB 스키마나 전면 클래스·폴더 재편이 필요하다는 근거는 없다.

## 확정 의미와 수용 조건

| 요구·판정 | 확정 계약 | 검사 |
|---|---|---|
| 목표별 공통기억 | A+B와 B+C의 교차 구성을 지원하고 목표·원본 변경은 재검토한다. 원본 기억·기존 작업의 과거 pin은 독립적으로 보존한다. | T01, T07, T16 |
| 공통기억으로부터 만들기 | 현재 `sourceMemoryIds`의 원본 프로젝트를 Clone·동일 기억 복원·개별 등록한다. 선택한 공통기억의 새 목표·게시 지식 적용은 별도 `ProjectCommonMemoryChoice`다. | T02, T08, T15–T16 |
| 기기별 안내 | 실제 등록 memoryId·Git origin·접근성을 비교해 present/missing/conflict/unavailable을 구분한다. no-repository는 unavailable의 이유로 안내하고 주소 갱신은 별도로 확인한다. | T03–T05, T26 |
| 계획 고정 | group version/goalVersion·source heads/hash·GitHub·cloud scope·등록 root identity를 고정하고 실행 직전 및 Clone 뒤 재검증한다. planHash는 변경 비교용이다. | T06, T14, T28 |
| 한 구성원 실행 | `projectsAdd({plan,requestId,memoryId})`는 명시한 구성원 하나만 실행한다. 동일 ID+member는 같은 결과만 replay하고 다음 구성원은 새 ID로 선택한다. | T08–T10 |
| 중단·복구 | prior 서버 영수증/projectId/실제 directory identity로 자기 결과만 복구한다. fresh 점유 폴더는 채택하지 않는다. 응답 유실 뒤 결과 조회는 읽기만 수행한다. | T11–T13, T25, T27 |
| 원래 목표·pin의 휴대성 | 새 Clone에서 기존 cloud binding의 정확한 원래 목표·historical selection을 읽어 복원한다. Git-ignored capsule의 복원을 Clone 성공으로 추정하지 않는다. | T15–T16, T30 |
| 권한 | cloud 관리·local meta 관리·프로젝트 Clone·해당 프로젝트 파일 binding 권한을 각각 검증한다. 기존 terminal/bulk grant는 새 기능의 동의가 아니다. | T17–T20 |
| 큰 기억·목록 | 전체 list/state/publication/report도 서버에서 page로 제한한다. shared transfer 8/owner4/TTL5분 및 wire·응답·300/min 예산을 지킨다. | T20–T21 |
| Mac 메뉴 | 장기기억과 공통기억을 같은 깊이에 둔다. 공통기억은 cloud 목표 기억을 기본으로 하고 이 Mac의 기존 meta 기억은 내부에서 구분한다. ARIA·키보드 순서도 맞춘다. | T23 |
| iPhone·MCP | 같은 transport 주입 UI와 strict 요청 계약을 사용한다. 입력 최소16px·터치44pt·키보드·safe area·확대·미확정 결과를 실제 기기에서 확인한다. 실제 stdio tool 호출과 production 연결 근거를 각각 수집한다. | T18, T22–T25, T31–T34 |
| SDK 프로젝트 | repository·memoryId·relative catalog를 보존하고 새 Mac의 준비 상태를 별도로 확인한다. Clone·기억 복원·등록·SDK 준비 결과를 구분한다. | T30, T34 |

실행자·scope·requestId·planHash·member 결속은 host 내부 durable 기록의 기준이다. 외부 `projectReceipt` 개념을 현재 `project-add-status` 같은 operation 이름에 매핑하더라도 동일 owner/scope/member 결과를 읽는 의미를 유지한다. 원격 계획과 결과에 실제 로컬 경로·명령·credential·서비스 키를 넣지 않는다.

## 구현·검증 순서

1. 기존 Domain 규칙과 구성 상태·고정 계획의 순수 테스트를 완성한다.
2. exact source·원래 binding 조회, 한 member 실행, durable 단계·replay·취소·동시성 경계를 주입된 서비스로 검증한다.
3. strict HTTP/MCP/mobile 계약, 별도 cloud/project-add grant, 공유 전송 pool과 전체 응답 page를 연결한다.
4. Mac sibling 메뉴·아이폰 관리 및 프로젝트 만들기 진입점, 단말별 안내·미확정 intent 복구를 shared UI에 연결한다.
5. actual MCP subprocess·실제 파일/Git/등록·SDK 경계를 검증하고 `bun run verify`와 maintainer quick을 완료한다.
6. 연결된 iPhone 13 Pro Max/iOS26.3에서 네 persona를 검증한다. production relay/SAS/현재 권한·cloud readback과 fixture 결과를 구분한다. 공식 Mac·iPhone 설치는 해당 출하 source guard를 통과한 뒤 실행하고 설치된 commit/build를 대조한다.

한 구성원 작업도 timeout·앱 종료가 가능하므로 ephemeral transfer를 완료 영수증으로 취급하지 않는다. 미확정 작업은 자동 재실행하지 않고 같은 구성원의 결과 확인·명시 복구를 제공한다. source/cloud가 변경된 뒤 새 최신 기준을 기존 완료 결과에 합치지 않는다.

## 설계 검토에서 우선 확인할 위험

| 확인 조건 | severity / confidence | 근거 |
|---|---|---|
| 완료 receipt replay의 효과 0, 다른 member/request 재결속 거부 | 높음 / 높음 | 전략 T08–T11; `common-memory-projects-server.ts`의 단계·결과 조립 |
| Clone 중 source·GitHub·root·scope 변경을 restore 전에 재검증 | 높음 / 높음 | 전략 T14/T17, deferred barrier로 이전 snapshot과 새 source를 분리 |
| 공개 marker만으로 폴더를 채택하지 않고 prior server receipt로 소유 확인 | 높음 / 높음 | 전략 T12–T13/T28; `src/projectLaunchReceipt.ts`의 directory identity |
| private capsule의 exact original binding 읽기·복원 | 높음 / 높음 | `common-memory-server.ts`의 Git-ignored capsule·cloud binding 쓰기, 전략 T16/T30 |
| 전체 state/list에도 실제 wire·왕복 예산 적용 | 높음 / 높음 | `src/metaCommonMemoryRemoteProtocol.ts` 상한·gateway300/min, 전략 T21 |
| remount/host/cloud 변경 뒤 원래 pending 결과를 읽기만 확인 | 높음 / 높음 | 전략 T24–T25, stable client/generation 및 bounded intent metadata |
| actual iPhone·production relay·실제 다른 Mac은 별도 실행 근거 필요 | 중간 / 높음 | 전략 T31–T34. 계획이나 isolated fixture의 성공을 실제 경로 성공으로 승격하지 않음 |

위 항목은 후속 편집으로 수정될 수 있는 관측과 acceptance 조건이다. 구현 완료 여부는 현재 코드와 실제 실행 결과로 다시 판정한다. repository가 없는 원본이나 cloud에 저장되지 않은 local-only 목표 정보는 원인을 표시하고 추정 값을 만들지 않는다.

## 품질·정합성 게이트 결과

- 네 산출물은 ls/wc/필수 섹션 assertion을 먼저 통과했다. 각 문서는 실질 내용 30줄 이상이며 실제 기존 모듈·기능을 다룬다.
- Domain의 Aggregate·Repository·용어집, Architecture의 네 레이어·세 대안, TDD의 Given/When/Then, Checklist의 Inside-Out RED/GREEN/RFCT 및 Critical Files를 확인했다.
- 한 수정 라운드에서 explicit member wire·같은 요청 replay·다음 구성원의 새 ID·기존 네 상태를 맞췄다.
- TDD T01–T34와 checklist의 34개 RED 라벨을 줄 단위로 비교한 결과 missing/extra/mismatch 모두 0이다.
- 정본 정책·레이어·대표 Configure/ProjectsAdd/Receipt/Binding 검사를 대조했다. 확인되지 않은 실기·production·coverage 결과는 미측정으로 유지한다.
- 상류 `CLARIFY.md` find-meta 결과는 null이며 새로운 질문·유령 범위를 추가하지 않았다. Phase R은 canonical primary의 읽기 전용 어댑터로 수행했고 기억 파일은 수정하지 않았다.
- 계획 등록은 ignored `.cs-artifacts` metadata만 갱신한다. 계획팀은 이 디렉터리의 다섯 Markdown 산출물 외에 source·tests·DB·앱 설정을 수정하지 않았다.

