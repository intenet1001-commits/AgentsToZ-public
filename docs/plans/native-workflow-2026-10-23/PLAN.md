---
cs_artifact:
  type: PLAN.md
  producer: CS-plan
  produced_at: 2026-10-23T14:48:14Z
  status: ready
  gate:
    passed: true
    criterion: "4개 산출물 품질·정합성 게이트 통과"
    blocking_items: []
---

# 프로젝트 상태 묶음 → 조회 도구 묶음 → 작업 팩

외부 ego-lite·Aside를 사용하지 않고 AgentsToZ가 현재 작업의 근거를 읽고 재사용하는 기능을 단계별로 만든다. **기존 워크룸·업무 스레드·기억·테스터·규격 명령을 확장하며, 구현 순서는 1→2→3으로 고정한다.** 이 문서는 구현 전 계획이다.

- 기준 소스: `3619c91bc90ef83dd3b1ce6888db7e24edb45f09`, 브랜치 `codex/ego-aside-analysis`.
- 작업 위치: `/Users/gwanli/.codex/worktrees/ego-aside-analysis/AgentsToZ_byCS`.
- 시작 문서: [도메인·기존 기능 매핑](domain-analysis.md), [아키텍처·자원 예산](architecture.md), [TDD 전략](tdd-strategy.md), [구현 체크리스트](implementation-checklist.md).
- 원래 요구는 이번 대화이며 CLARIFY 아티팩트는 없다. [자체 생태계 연구](../../research/agentstoz-native-ecosystem-features-2026-10-23.md)는 참고 자료다. 이번 계획의 좁은 범위와 순서가 앞선 연구의 확장 제안보다 우선한다.

## 아키텍처 선택 (arch-choice 체크포인트 결과)

계획 작성자는 **공통 조회 executor 하나 + 기존 스레드의 실행 metadata + 기존 명령에 연결한 로컬 sidecar**를 권고한다. 상태 묶음은 고정 조회의 projection이고, 작업 팩 실행은 검토된 정의를 참조하는 같은 조회 묶음이다. 단계마다 실행기·대기열·기록 저장소를 새로 만들지 않는다.

기술적 대안인 guide/envelope v2 전환은 구형 local/shared 검증기와 writer의 동시 업데이트가 필요하다. sidecar는 기존 텍스트 호환을 유지하는 대신 source identity·본문 hash·삭제 이력을 별도로 검사해야 한다. 이번에는 기존 항목을 보존하는 sidecar를 권고한다. 이는 가역적인 계획 작성 판단이며 사용자 승인·구현 완료를 뜻하지 않는다. 별도 질문 없이 구체화하도록 호출자가 판단했다.

## 단계별 결과와 완료 조건

| 단계 | 사용자가 얻는 결과 | 추가할 계약과 최소 패치 | 다음 단계 진입 조건 |
|---|---|---|---|
| 1. 프로젝트 상태 묶음 | 현재 프로젝트의 브랜치·변경·워크룸 상태·최근 검사·선택한 관련 기억을 한 번에 미리보고 전달 항목을 선택 | 순수 타입/검증 `projectStateBundle.ts`, 공통 host, client와 좁은 기존 reader, 정확한 API/Rust 경로, 기존 composer의 preview | 같은 대상 결속과 source별 시각·불완전성·오래됨을 표시하고, checkout/branch/권한 변경 시 전체 전송을 차단. 조회가 새 AI·스레드·테스트·키·기억 쓰기를 만들지 않음 |
| 2. 조회 도구 묶음 | 허용된 조회를 선택하고 단계별 성공·실패·누락을 확인 | 1단계 executor의 typed 단계/DAG 검증과 예산 집행 확장, 기존 ThreadStore facade의 CAS·영수증·version guard, 기존 결과 UI | 독립 조회만 제한 병렬 실행. 동일 요청·취소·timeout·재시작·권한 회수·늦은 결과를 처리하고 자동 재실행하지 않음 |
| 3. 작업 팩 | 기존 규격 명령 하나에 검토한 입력·조회 절차·완료 조건을 붙여 다른 프로젝트에서도 재사용 | `workPack.ts`, 필요한 경우 `workPackStore.ts` adapter, 기존 Prompt UI에 source 검토·입력·실행 preview 추가 | 같은 팩을 두 등록 프로젝트에서 새 결속으로 사용. 기존 simple/command 텍스트와 pin/reorder 유지, 본문 변경·삭제·재가져오기·계정 전환·구형 writer를 안전하게 처리 |

각 단계는 해당 RED 테스트 → 최소 구현 → 리팩터링 → 관련 정상 프로필·페르소나 검증으로 끝낸다. 이전 단계의 gate를 통과하기 전 다음 기능을 활성화하지 않는다. 구체적인 테스트명과 패치 순서는 TDD 문서와 체크리스트를 따른다.

## 기존 기능과 겹치지 않게 만드는 경계

| 기존 정본 | 유지할 책임 | 이번에 추가하는 부분 |
|---|---|---|
| 등록 대상·Git inventory | 현재 프로젝트/워크트리의 실제 identity | 수집 시작·끝·전송 직전의 동일 대상·권한 재검증 |
| 기억·테스터·runtime | 각자의 문서·검사 결과·세션 상태 | 범위가 제한된 읽기 projection과 출처·현재성 표시 |
| Workroom·업무 스레드 | 요청·대화·사용자·기기 권한·결과 기록 | 선택한 기존 스레드 안의 run별 조회 metadata와 작은 결과 참조 |
| PromptGuide/규격 명령 | 텍스트·항목 identity·local/shared 저장·CAS | 원본을 복제하지 않는 입력 schema·허용 단계·완료 조건·검토 revision |
| USE | 제품별 grant·adapter·실행·receipt | 결속·원래 요청 ID 원칙만 재사용. 기존 mutation 도구는 조회에 노출하지 않음 |

실제 파일·심볼·라인의 중복 방지 근거는 [도메인 매핑](domain-analysis.md)과 [reader의 부수효과 표](architecture.md)에 있다. 이름이 status/read인 API도 provider 준비·키 생성·journal index·앱 접근이 있는지 확인하고, 필요한 좁은 reader만 사용한다. 조회 과정의 제한된 local receipt reconciliation은 프로젝트를 변경하는 동작과 구별한다.

## 실행·데이터·권한 계약

- 첫 범위는 **로컬 데스크톱의 등록 DEV 프로젝트와 워크트리**다. USE·OPS·원격·모바일·MCP 신규 action은 미지원으로 표시하며 DEV로 자동 전환하지 않는다. 기능 정의는 target·계정·기기·grant·CLI profile을 지정하거나 권한을 늘리지 못한다.
- 미리보기는 스레드 없이 메모리에서 가능하다. 영속 batch는 사용자가 선택한 **기존 exact DEV thread**가 필수다. facade는 `get(threadId)`로 단건 조회한 뒤 owner/target을 확인하고 `(threadId, requestId)`별 append-only metadata를 보존한다. 전체 JSON 검색·새 receipt index·독립 DB·새 스레드·CLI·가짜 agent는 만들지 않는다.
- 원래 thread.state와 USE serviceExecution을 변경하지 않는다. CAS 충돌에서는 metadata만 다시 병합하며 완료한 source를 재호출하지 않는다. 영수증 조회에도 현재 owner·대상 권한을 확인한다. Phase3도 같은 thread/run key를 사용한다.
- 조회 operation은 `project.git.read`, `workroom.status.read`, `tester.status.read`, `tester.report.read`, `memory.reference.read` 다섯 개다. typed 입력·앞선 단계 참조만 허용하며 임의 JS/eval/셸·URL·credential·도구 등록·테스트 시작·remember·push/Pull·앱 실행은 거부한다.
- source별 `availability`와 `freshness`를 분리한다. 불완전·미설정·조회 불가·미확인과 오래된 결과를 구별하고 수집 구간·시각·commit/fingerprint를 보여준다. 전역 원자 snapshot이나 시작/끝 검사만으로 ABA 완전 탐지를 보장하지 않는다.
- 모델에 보낼 내용은 선택 preview와 기존 submission pipeline을 거친다. raw diff/log/transcript/env/비밀/기억 전체/절대경로를 자동 전송하지 않는다. 권한 회수·대상 교체는 일부 성공으로 숨기지 않고 전체 전송을 막는다. 전송이 unknown이면 원래 receipt를 읽으며 자동 재전송하지 않는다.
- 작업 팩의 첫 예시는 **개발 현황 조회**다. Git·워크룸·tester metadata → exact run 보고서(있을 때) → 선택한 관련 기억 → 누락·오래됨 요약으로 구성한다. completion condition은 조회 완료를 뜻하며 검사 PASS를 새로 만들어내지 않는다. `pack.prepare`에서 정의를 검토한 뒤 기존 `batch.start`가 같은 executor와 frozen definition reference를 사용한다.

## 자원·실패·호환과 롤백

초기 제안 예산은 단계8개/깊이3, 동시 source batch2·host4, active batch target1·host2, source3초·전체10초, control4 KiB·response32 KiB다. preview는 최대24 KiB·5분, source 입력은 각1 MiB/총2 MiB로 제한한다. 이는 실측 전 값이며 자세한 바이트·보관 상한은 아키텍처를 따른다. 출력 잘림과 미확인을 표시하고 무제한 대기열을 두지 않는다.

취소는 다음 단계를 중지하고 실제 종료까지 slot을 점유한다. 동기 전체 읽기를 Promise.race로 감싸는 것만으로 timeout을 보장하지 않는다. 바이트 제한이 있는 비동기 reader나 source에 한정된 기존 격리 probe를 사용하고, 느린 source 중에도 다른 API와 취소 UI의 응답을 검증한다. 시간초과·화면 숨김을 실제 종료로 단정하지 않는다. 재시작 시 진행 중 run은 unknown이고 자동 재개하지 않는다. 영속 기록은 상태·출처·digest·오류 등의 metadata이며, preview 만료나 재시작 후 값이 없으면 payload unavailable로 표시한다. receipt 조회는 source 재수집이 아니다. 사용자가 다시 수집하면 새 ID의 관측이다. 미완료·unknown·중복 방지 기록을 예산 확보용으로 삭제하지 않는다. 기존 행512 KiB/전체100 MiB 등 한도를 공유하고 한도에서는 새 admission을 거절한다.

기존 PromptGuideEntry와 shared SQL/RPC schema는 바꾸지 않는다. sidecar는 전용 키 namespace·CAS·owned lock·원자 파일 교체를 사용하고 명시적 첫 팩 저장에서만 키를 만든다. 계정/library identity+guideId+bodyHash+revision을 재검증하며 본문 변경은 stale, 삭제는 tombstone/orphan, 재가져오기는 재검토 전 실행 불가다. 손상·future schema·키 유실은 원본을 보존하고 실행을 막는다. 팩 공유·동기화는 이번 범위 밖이다.

새 typed run 기록의 첫 영속화에서는 ThreadStore version4와 모든 writer의 단조 version 처리가 필요하다. 활성화 전 지원 여부와 닫힌 DB의 pre-v4 backup을 확인한다. preview-only는 migration이 없다. feature-off는 새 실행을 막고 현재 host에서 과거 기록을 읽는 조치다. 구형 host는 v4 전체 저장소에 fail closed하며, 실제 downgrade는 v4 원본 보존과 명시적 복원 절차가 필요하다. 기존 명령 본문은 어느 경로에서도 되돌려 쓰지 않는다.

## 검증·페르소나·측정과 인계

이번에는 문서 정합성만 확인하며 코드 테스트·앱 빌드·설치·배포를 실행하지 않는다. 구현 검증을 시작할 때 현재 worktree에서 AGENTS.md의 `/api/project-tester/ensure`를 세션당 한 번 호출한다. API가 없거나 미등록이면 이유를 기록하고 기존 도구로 계속한다. ready/updated/installed이면 `.agentstoz/MAINTAINER.md`에 따라 quick 또는 관련 `workroom-improvement` 정상 프로필을 실행하고, 포함되지 않은 전체 persona를 한 번 실행한다.

실제 카탈로그는 `tests/personas/catalog.json`의16개이며 `scripts/persona-tests.py`가 legacy 경로를 지원한다. quick의 공통 기억 persona4개는 전체 실행이 아니다. 기존 goal을 확장하는 것을 우선하고, 새 여정은 구현 후 이미 활성인 에이전트가 현재 revision에서 `personas propose`로 제안한다. actor·필요성·시작 상황·순서 있는 여정·관측 가능한 성공 기준·source 파일·check ID를 기록한다. 검사가 없으면 ID를 비우고 needs checks로 남긴다. 후보64개 한도에서 기존 후보를 자동 삭제하지 않으며 제안·활성화·실제 verdict를 구분한다.

최종 `bun run verify`는 실제 package 기준 test:maintainer → typecheck → Bun tests → test:rust(사이드카 빌드+cargo)다. 별도 smoke는 변경 소스에 맞는 격리된 개발 API/Vite에서 실행하며 기존 `.mjs` fixture의 임시 서버·임시 app data 경로를 재사용한다. macOS에서 APP_DATA_DIR 하나만으로 격리를 가정하거나 설치된 기존 3001 sidecar/실데이터를 변경 소스의 검증으로 오인하지 않는다. 기존 guide/shared guide·submission·thread·USE·memory·tester 회귀와 신규 UI의 ko/en·키보드/IME·focus·aria-live·늦은 응답을 검증한다. 합성 fixture 결과, 설치된 Mac 앱, 실제 Windows PC, 실제 모바일 결과를 각각 구분하며 미실행 범위는 완료로 표시하지 않는다.

구현 인계에는 기준 commit/변경 파일, 실제 테스트 run ID·명령·결과, 미실행 환경, source/권한/receipt 계약, 버전·원본 보존·롤백 조건을 포함한다. 대표 두 프로젝트에서 수동 조회 대비 호출 수·전체 시간·반복 설명·확인 시간을 비교한 뒤 효율을 판단한다. 토큰·비용·성능 향상은 측정 전 주장하지 않는다.

## 계획 작성 검토 기록

protocol: LOOP-PROTOCOL [a-f] loaded (round budget 1)
recall: E3/C0/N0 — 에피소드3건은 현재 설계와 관련성이 낮아 정책 근거로 채택하지 않았다. 호출자의 canonical memory recall/Pull 결과와 현행 소스로 제약을 확인했다.
hitl: gate — 가역적인 기술 권고는 호출자 판단에 따라 추가 질문 없이 구체화했다.
contracts: 4 issued / 4 accepted
커버리지: 전문 역할4/4 수락(100%). 문서 품질·정합성 게이트 통과, 구현 검증은 미실행.
