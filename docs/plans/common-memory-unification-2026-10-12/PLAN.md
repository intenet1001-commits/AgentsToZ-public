---
cs_artifact:
  type: PLAN.md
  producer: CS-plan
  produced_at: 2026-10-11T15:59:00Z
  status: ready
  gate:
    passed: true
    criterion: "4개 산출물 품질·정합성 게이트 통과"
    blocking_items: []
---

# 공통기억 통합과 SDK 재사용 흐름 추가 계획

protocol: LOOP-PROTOCOL [a-f] loaded (round budget 1)
recall: E3/C5/N0
hitl: auto — arch-choice: default(권장안) 채택

이 문서의 ready는 계획 정합성 상태다. 기능 구현·마이그레이션·실기·새 SDK 흐름의 성공 보고가 아니다. 기존 iPhone-extension 계획을 반복하지 않고 추가 요구만 다룬다.

## 빠른 시작

1. [도메인](domain-analysis.md)의 ID·원본 보존·Repository 계약으로 이관 preview/execute/status부터 구현한다.
2. [아키텍처](architecture.md)의 단일 cloud record와 strict dispatcher에 검색·복수 선택·연결 상세를 붙인다.
3. [테스트 전략](tdd-strategy.md)와 [체크리스트](implementation-checklist.md)의 같은 검사명을 순서대로 사용한다.
4. 기존 지식 이관·Mac/iPhone 관리·MCP 검증 뒤 SDK 실제 후보 코드/문서/검사/사람 승인/대상별 적용을 완성한다. Root가 이미 승인된 구현과 검증을 이어 수행한다.

## 아키텍처 선택 (arch-choice 체크포인트 결과)

auto default로 **schema1 additive CommonMemoryUnified + 기존 6테이블 + 이관 fence + SDK 후보/대상별 영수증**을 확정했다. 기존 flat 함수 모듈에 네 논리 레이어를 적용하며 별도 framework/상시 job queue는 추가하지 않는다.

| 레이어 | 변경 경계 |
|---|---|
| Domain | commonMemory.ts, 제안 commonMemoryMembership.ts/sdkReuseCandidate.ts의 순수 계약 |
| Application | common-memory-server.ts, 제안 common-memory-migration-server.ts/sdk-reuse-server.ts |
| Interface Adapters | 동일 요청 파서·HTTP/MCP·한 공통기억 패널·공용 프로젝트 연결 요약 |
| Infrastructure | 기존 6개 cloud tables/RPC guard, local SQLite trigger/backup, SDK owned staging/receipt |

분리 지식·연결 테이블은 정상 데이터가 JSON1MB 한도를 지속 초과하거나 indexed 검색의 실측 필요가 생길 때 재평가한다. schema2/nullable goal은 설치 iPhone745/MCP reader가 goal.objective를 읽으므로 이번 범위에서는 선택하지 않았다.

## 확정된 데이터·이관 계약

`CommonMemoryUnified = CommonMemory & {portableKnowledge?:PortableKnowledge;goalConfigured?:boolean}`로 schemaVersion1과 non-null goal을 유지한다. `PortableKnowledge={snapshot,current,sourceFingerprint,importedAt}`의 snapshot/current는 원래 MetaCommonMemory 형식이다. snapshot은 불변 원본이며 current만 cloud CAS로 관리한다.

새 이관의 objective는 기존 description/name을 표시하는 초안, goalConfigured:false, goalVersion1, sources/items/heads=[], publication:null이다. 기존 active 지식의 승인과 목표 관련성 검토·게시를 별개로 표시한다. 일반 goal create/configure의 source1..16 조건은 유지하고 source0은 호스트가 검증한 portableKnowledge import 분기에만 허용한다. **게시 시 실제 verified heads1..16을 별도 검사해 0heads=0sources 비교만으로 게시하지 않는다.** 수동 지식을 가짜 project revision으로 만들지 않는다.

| 계약 | 입력·결과·불변식 |
|---|---|
| previewLegacyMigration | localGroupId/scopeId/assignments → source revision/hash/cloud version/등록 identity에 결속한 LegacyMigrationPlan; 쓰기 없음 |
| executeLegacyMigration | plan/requestId → prepared/cloud-committed/handed-off/conflict/unknown receipt; 공개 fingerprint만으로 권한 인정 안 함 |
| legacyMigrationStatus | exact group/scope/request의 읽기 전용 조회; missing receipt가 실행·fence 해제를 허용하지 않음 |
| 호환 legacy 요청 | handed-off 뒤 cloud current로 전달; 이전 local 성공 requestId/hash는 원래 SQLite receipt 읽기만 하며 재실행 금지 |

순서는 호스트 readonly snapshot → 일관된 SQLite/WAL backup → source CAS와 group fence/write triggers 준비 → atomic cloud CAS+receipt → 전체 stateHash readback → local handoff다. user_version bump만으로 미리 version 검사를 통과한 writer를 차단했다고 판단하지 않는다. unknown에서는 원본·fence·request key를 보존하고 자동 재실행/새 request/로컬 쓰기 재개를 하지 않는다. 명시 복구는 cloud 편집 없음의 exact CAS withdrawal/readback 뒤에만 가능하다.

기존 portableKnowledge의 누락·snapshot 변경·goalConfigured 제거를 RPC에서도 거부한다. 별도 로컬 editable 정본으로 자동 회귀하지 않는다. 이관 전 이력은 원본 SQLite에서 복구 가능하게 남기고 future 지식 편집은 기존 operation receipt의 bounded before/after delta·compat revision·stateHash로 보존한다.

## 실제 설정 대상과 식별자

아래는 부모가 실제 MCP 및 사용자 지정으로 전달한 관측이다. 계획 에이전트의 live 검사 결과가 아니다.

| 대상 | 등록 프로젝트 ID | 기억 ID |
|---|---|---|
| NHCS 이관 원본 | group d14813cf-a25d-48fb-8c35-03b85261b25e | revision1, active4, members2 |
| nhdesign-marketplace | 3ea092ae-8498-48de-adb5-08c4bf83df12 | 1eb621cd-79c2-46fa-bf38-dd6c2a9a9657 |
| nhdesign-usher 현재 대상 | 0951a853-9fd7-4bdb-be7e-ee856c0ceb92 | 3c880ef4-46b6-5731-b388-ad79bf29ef88 |
| usher 원본 연결 | 위 current ID와 병합하지 않음 | 3fbdfd1a-dab4-5c6a-99e6-9cf22546d865 |

현재 두 프로젝트 연결은 사용자가 명시 승인한 assignments로 current에 반영하고 old usher는 원본 snapshot에 보존한다. 현재 usher는 Supabase head가 없으므로 verified goal source를 꾸며내지 않는다. 이관 때문에 CORE·새 memoryId를 만들지 않는다.

이름 같은 song/karaoke 그룹이나 stale DEV device70839979는 이름·역할로 기억을 합치지 않는다. root가 실제 alias/계보/등록/현재 파일 ID로 조사한다. 프로젝트 공용 표시 이름은 canonical memory label과 같게 투영하고 기기별 물리 폴더명·경로는 별도 유지한다.

## 화면·권한 수용 기준

- 공통기억 한 화면에서 이름·목표·지식·연결을 검색하고 복수 선택한다. active 기본 목록과 보관 filter를 구분하고 QA3 archived는 정상 목록에서 숨기며 복구 가능하게 남긴다. 조회 범위·전체 개수·선택 개수·숨겨진 선택을 표시하며 조용한 일부 성공이 없다.
- 원본 지식의 active/candidate/contested/superseded와 include/exclude/category 의미를 보존한다. 현재 member IDs와 goal verified source IDs는 다른 집합이다. source0이어도 현재2 연결과 상태가 보인다.
- 기존 bundle 최대16은 유지한다. 더 많은 legacy members는 전체 수·페이지와 명시적 subset을 제공한다. head 없음/미초기화/주소 충돌은 unavailable 상태이며 신규 기억 생성으로 해결하지 않는다.
- 프로젝트와 폴더 상세에 연결된 공통기억 이름·목표 미설정 여부·게시본·재검토·같은 관리 화면 링크를 표시한다. role은 ops/dev/managed 저장 계약 그대로이며 SDK는 확인한 catalog의 표시 facet이다.
- 권한은 meta-memory.manage와 common-memory.manage를 독립 확인한다. clone/등록은 projects.add와 exact root, binding은 해당 프로젝트 memory.save 경계를 유지한다. UI 통합은 grant 확대가 아니다.
- OPS 저장 선택은 실제 지원 agent/surface/mode/bypass만 복원한다. root가 고친 persistence/unsupported desktop 처리를 회귀로 확인한다. 설정 선호가 실행 권한을 부여하지 않는다.
- AI 연결은 설정 존재, 설치 launcher의 stdio probe, 서버가 관측한 실제 MCP 호출을 구분한다. clientInfo.name만으로 provider 인증이나 네 AI 연결 완료를 주장하지 않는다.

## SDK 새 흐름의 완료 조건

목표와 선택한 등록 프로젝트에서 코드+기억 근거를 고정한 뒤 실제 재사용 후보 구현·safe HTML 설명/demo·manifest를 등록 SDK의 owned staging/worktree에 만든다. 분석문이나 HTML만으로 구현 완료를 표시하지 않는다. 선택 source≤4/code evidence≤32/capture≤512KiB 제안이며 초과는 명시 범위 조정이다.

실제 검사 결과는 source/artifact/candidate version/hash에 결속한다. 사람의 승인은 같은 검사·후보·명시 target IDs의 서버 영수증/token이며 에이전트는 자기 후보를 승인하지 못한다. 적용은 target별 preview/diff/권한/HEAD/dirty fingerprint를 재확인하고 한 target 한 durable receipt로 수행한다. unknown은 자동 적용·다음 target 진행을 막는다.

현재 dirty SDK/Cdp·원본 source·dirty target은 덮어쓰지 않는다. 후보 코드/문서는 Git에 운반할 수 있고 host test receipts·승인·root paths는 owned app-data에 둔다. 다른 Mac clone/pull은 그 Mac의 준비·검사 완료 증거가 아니다. SDK0.2 catalog/status/prepare/recommend와 기존 자동 준비 의미는 유지한다.

## 검증·설계 위험

| severity/confidence | 반드시 확인할 경계 | 현재 근거 |
|---|---|---|
| 높음/높음 | 0-source 특수 import, PK field-loss 방지, source0 게시 거절 | commonMemorySql.ts64-100의 기존1..16/RPC head검증 |
| 높음/높음 | old prechecked writer·cloud commit 후 disconnect·원래 receipt replay | metaCommonMemoryStore.ts41-42/86/94-121 |
| 높음/높음 | ID 동일성, current usher의 없음 상태, name/device로 merge 금지 | projectMemoryDirectory.ts614-642/688, parent exact IDs |
| 높음/높음 | SDK source/artifact/test/approval/target snapshot 바뀜과 부분 적용 | 현재 sdkProjectManagement.ts16-57에는 새 후보 workflow 없음 |
| 중간/높음 | fullsnapshot+current 전체1MB 및 paged compact wire350KB | metaCommonMemoryStore.ts114, 기존 transfer budgets |
| 중간/높음 | 관리 UI·공통 상세·설정/실제 call을 같은 흐름에서 사용 | CommonMemoryPanel.ts38/50, App14648, controlProfileConnections64-94 |

기본 테스트는 실제 SQLite·temp Git/filesystem·재시작·deferred barrier·실제 stdio 호출을 필요한 성질에 사용한다. 실제 Mac/iPhone의 검색·복수 선택·연결 상세·권한 선호 복원·production relay/MCP는 root가 수행하고 fixture 결과와 구분한다. 핵심 새 비즈니스 분기 coverage≥90은 검증 목표이며 지금 측정값은 아니다.

현재 package.json의 최종 검증은 `bun run verify`(maintainer→typecheck→Bun→sidecar/Rust)이며 official 설치는 committed/published clean source guard를 지킨다. tester reconciliation은 부모가 세션에서 이미 수행했으므로 중복 호출하지 않는다.

## 디자인 시스템 영향도

기존 top-level 공통기억 탭과 token을 재사용하고 검색/체크/선택 수/상태를 한 열에서도 읽게 한다. 입력16px·touch44pt, keyboard focus/ARIA, 색상 이외의 상태 문구를 유지한다. 이동·필터·scope 변경에 pending request와 draft가 다른 기억으로 전송되지 않게 한다.

## 계획 품질 게이트

contracts: 4 issued / 4 accepted. 네 산출물의 실질 내용·FEATURE 일치·역할 완결성 기준을 모두 통과했다. 도메인/아키텍처의 세 Repository 시그니처는 원문이 같고 주요 Aggregate·VO·유스케이스와 네 레이어를 대조했다. TDD U01–U30(순수7/통합20/실기3)과 체크리스트의 RED30 이름은 전부 같으며 누락·추가·불일치0이다. 대표 U10(구형 writer fence), U20(strict 권한), U27(SDK 대상별 적용)의 유스케이스/레이어 매핑을 확인했다. 구현 체크리스트는 7단계·체크박스64개(DoD15개 포함)이고 모두 미체크다. 미해결 계획 정합성 항목은 없으며 이 PASS는 코드·DB·MCP·실기 테스트 통과를 뜻하지 않는다. 회상은 untrusted/historical/contested 근거로 주입했으며 root의 진행 중 source 변경을 기저 오류로 재보고하지 않았다. 이 역할은 이 다섯 계획 문서와 ignored artifact registry metadata만 작성한다.

