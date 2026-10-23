# 공통기억 통합 실행 기록

2026-10-12 · Mac의 기존 기억과 SDK/프로젝트 폴더는 원본 보존을 우선한다.

## 구현과 클라우드 검증

- schema1에 portableKnowledge/goalConfigured를 추가했다. 이관 snapshot은 불변이며 current의 지식·연결만 CAS로 편집한다. 기존 프로젝트 CORE와 목표별 게시본은 각각 보존한다.
- SQLite의 groups/members/revisions 쓰기 trigger가 이관 전부터 구형 writer를 막는다. cloud 응답 유실은 같은 staged state/request로 확인하며 로컬 authority를 자동 재개하지 않는다. 이전 성공 요청은 원래 SQLite receipt부터 재생한다.
- 기존 NHCS 그룹의 ID·원문 4개·active 상태와 이력을 보존해 클라우드로 이관했다. 지정한 현재 Marketplace와 Usher만 include하며 이전 Usher ID는 snapshot 및 current의 exclude로 남긴다. 원본 프로젝트 기억이나 alias 계보는 합치지 않았다. 현재 두 프로젝트에서 클라우드 지식 회상을 확인했다.
- 하나의 공통기억 화면에 지식/목표/프로젝트 연결, 검색·복수 선택·휴지통·복원을 제공한다. 기존 별도 editable legacy 영역은 제거했다. 목표가 없는 지식의 관리는 가능하고, verified source가 없는 목표 게시·추천은 거부한다.
- 프로젝트 폴더 상세에 공유 장기기억 이름·ID와 공통기억 이름·목표·상태를 표시한다. 로컬 폴더 이름은 ID나 권한으로 쓰지 않는다. SDK는 검증된 catalog와 memoryId로 구분하며 저장 역할 ops/dev/managed는 유지한다.
- OPS mode/bypass 선택은 변경 즉시 직렬화해 저장한다. Codex/Hermes/agy 데스크톱의 미지원 권한 우회는 표시·실행 범위에서 제외한다. 설정 등록과 실제 AI MCP 호출 증거를 구분한다.
- MCP 1.35.0은 기존 도구와 4개 통합 도구를 제공한다. AI의 지식 변경은 candidate로 제출하며 자기 후보의 승인·직접 확정 편집은 거부한다.
- 비동기 cloud reader를 sync 호출에서 실행하지 않도록 수정했다. 수동/V2/복구 저장에는 awaited shared context를 넣는다. cloud 미설정·schema 미설치의 미이관 legacy는 기존 offline 계약을 유지하지만, 이관 fence가 있으면 local writer로 fallback하지 않는다.

## song-app 단일 루트

사용자 지시로 karaoke-studio 중첩을 없앴다. 실제 앱의 Git HEAD, staged index와 358개 추적 파일의 이동 전 hash를 유지하고 연결 worktree를 repair했다. 기존 상위 Git 이력은 별도 ref/백업에 남겼다. 두 로컬 기억의 45개 entry ID를 보존해 대표 기억으로 합쳤다. 정상 merge RPC의 OUT-column merge_id 모호성을 실제 실패로 재현하여 column qualification과 ledger lock 순서를 수정했다. 원래 두 head CAS·alias·merged content hash를 확인했고 이전 ID는 대표 ID로 해석된다. 다른 기기 전환 확인은 남아 있다. 기기 70839979는 초기에는 합치지 않았으며, 이후 사용자가 이 Mac의 이전 설치라고 확인한 뒤 기억·리비전을 보존하는 device alias만 연결했다.

## 실행한 검사

- Python maintainer 85 pass, TypeScript 0 error, Bun 6104 pass / 기존 10 skip / 0 fail, Rust 73 pass.
- 현재 quick profile 5/5 pass: maintainer-self, essential-contracts, voice-regression, common-memory-contracts, common-memory-screen.
- 새 통합 행동 검사 8 pass: 상태/ID 보존, membership, candidate exclusion, 실제 SQLite old writer fence, 응답 유실 재생, snapshot 변경, async 거절, MCP 자기 승인 거부.
- 실제 isolated PostgreSQL: CAS/역할/게시본/원본 head 검증 및 지식 누락·snapshot 변경·0-source 게시 거부.
- Chromium/WebKit 390×844: 기존 7개 여정과 portable 지식 생성·정확 연결·통합 검색·복수 체크·휴지통 복원. 입력 16px·터치 44px·가로 넘침 없음. fixture이며 운영 iPhone 검사와 구분한다.
- 설치 후 확인한 동명 원본 선택의 모호함을 보완했다. 저장소·기억 ID를 함께 표시하고 이름·저장소·ID 검색을 제공한다. Chromium/WebKit에서 동명 원본을 구분해 선택하고 검색을 바꿔도 선택이 유지되는 추가 여정까지 통과했다.
- song-app의 기존 npm production build+Node tests quick pass; Git staged index/파일 hash 및 전체 기억 readback 확인.
- SDK VOC/reuse 핵심 후보: 7 pass, browser bundle, 실제 로컬 HTML에서 실패/미확정 입력 보존·영수증 일치 후 정리 확인. AgentsToZ/ShadowLoop의 선택 코드와 관련 curated entry ID/hash를 참고했다. 전체 앱 중 최상 평가나 실제 대상 앱 적용을 주장하지 않는다. 사람 승인 증명·실제 target 파일 작업은 호스트 adapter 책임이다.

## 설치·후속 검증의 범위

이 소스가 공개된 후 공식 clean/published guard를 거쳐 Mac 앱과 동일 소스의 USB 개발 iPhone 앱을 갱신한다. 기존 운영 연결과 승인한 공통기억 관리/프로젝트 추가 grant를 유지해 실제 목록·회상·관리/폴더 연결을 점검한다. TestFlight 앱, 셀룰러 전환, 다른 Mac의 실기 완료는 이 문서의 source/fixture 결과만으로 확인되지 않는다. 아젠투지 3호 업데이트 지시는 최종 이 Mac의 설치/검증 이후 사용자 승인 범위로 전달하고 실제 수신/작업 결과를 구분해 기록한다.

실기·cloud/폴더 이관의 정확한 request/hash/영수증과 백업은 해당 호스트 app-data와 owned private temporary evidence에 저장한다. 비밀과 운영 원문을 소스 저장소에 복사하지 않는다.

`c94449d9` 설치본 747에서 실제 MCP `1.35.0+build.747`/84개 도구, 같은 OPS 프로필의 ready, NHCS 확정 지식 4개와 지정 프로젝트 2개의 연결을 확인했다. Mac 프로젝트 화면에도 공유 장기기억 이름·memoryId·공통기억 목표와 상태가 표시됐고, usher의 로컬/원격 기억 해시는 일치했다. 사용자 확인에 따라 이 Mac의 이전 설치 ID `70839979`를 현재 ID로 연결하되 당시 기억 상태 8건과 리비전 6건을 보존했다. 747 USB 개발 앱은 기존 iPhone 13 Pro Max에 설치됐으나 최종 UI 자동화 재연결은 시간 초과여서 설치 완료와 실기 여정 완료를 구분한다. 동명 원본 표시를 포함한 최종 설치본의 추가 실기 결과는 별도 영수증으로 확인한다.

## 3호 설치 후 발견한 정합성 보완

`0f76f831`의 Mac 1호·3호 설치본 748, 실제 설치 MCP `1.35.0+build.748`/84개 도구를 확인했다. 3호의 원본·Git index 보존도 검증했으나 로컬/클라우드 중복 회상과 옛 Usher 제외 미반영을 발견했다. 기존 이관 영수증만 기준으로 로컬 회상을 제외하던 것이 원인이었다.

- 같은 ID가 현재 클라우드에 있으면 그 정본만 회상·목록에 사용한다. 보관·개별 프로젝트 제외도 로컬 사본보다 우선한다. 원본 파일·SQLite 이력은 변경하지 않는다.
- 이미 있는 정본은 `follow-cloud` 계획으로 연결한다. 클라우드 쓰기나 후보 승인을 하지 않고, 현재 namespace/버전/hash와 로컬 원본 fingerprint를 검증한 뒤 로컬 보존 사본의 old writer를 차단한다. 로컬/클라우드 차이는 별도 검토 대상이며 연결을 병합 완료로 주장하지 않는다.
- 완료된 이관 요청의 재전송은 기존 영수증을 반환한다. 이후 정상적인 목표 변경을 초기 이관 응답 유실로 오해하거나 다시 쓰지 않는다. 생성 commit에도 선택 당시 cloud scope를 전달해 다른 클라우드로 쓰지 않는다.
- 집중 검사 48 pass: 이관 전 같은 ID 중복·제외·보관, 실제 SQLite old writer, 기존 정본 무쓰기 연결, 변경된 원본/정본/namespace 거부, 완료 후 재전송 및 다른 scope의 생성 거부.
- 보완 후 전체 검증: TypeScript 0 error, Bun 6109 pass / 기존 10 skip / 0 fail, Rust 73 pass, quick profile 5/5 pass. 첫 전체 실행의 기존 restart vertical 시간 초과는 해당 검사 단독 재실행과 전체 재실행에서 통과했으며, 시간 제한이나 테스트 구현은 바꾸지 않았다.

3호의 현행 Usher 추가는 같은 이름의 기존 폴더와 충돌하며, DEV 기억은 local/remote 내용 차이가 있다. GitHub 읽기 검사에서 Usher의 두 owner URL은 동일한 repository node ID로 반환됐다. 이 사실만으로 다른 기억 ID의 내용을 합치지 않으며, 실제 Git 계보와 기억 원문을 별도로 비교한다. 원본을 덮어쓰지 않고 보존·검토해야 한다. iPhone 개발 앱 748 설치와 마지막 터치 검사 미완료도 별도 기록한다.

## 공통기억 목록·만들기·관리 화면 분리

공통기억 생성은 하나의 진입점으로 통일했다. 새로 만들 때는 ‘기존 장기기억에서 가져오기’ 또는 ‘직접 작성하기’를 선택하며 기존 목록을 함께 표시하지 않는다. 목록에서 기존 기억을 선택하면 해당 기억의 관리·수정 화면만 표시한다. 기존 NHCS의 네 항목은 같은 공통기억 내부의 ‘기억 항목’으로 표시하며 별도 공통 지식을 생성하지 않는다. 데이터 ID, 클라우드 구조, 기존 원본·연결과 호환 MCP 계약은 유지한다.

직접 작성한 항목의 저장이 미확정이면 입력·요청 ID를 유지하고 이동을 막는다. 동일 요청으로 결과를 확인한 뒤 목록으로 돌아갈 수 있다. 공통기억 선택과 텍스트 입력은 44px 이상 터치 영역으로 조정했다. 프로젝트 상세의 항목 수정 번호도 기억 자체의 수정 번호와 구분해 표시한다.

Chromium·WebKit 390×844에서 각 13개 여정이 통과했다. 목표를 아직 설정하지 않은 기억은 목표 설정을 접고 불필요한 0개 검토·게시 영역을 숨긴다. 긴 프로젝트 이름은 좁은 화면의 한 줄 너비를 사용하며, 기억 항목과 이력을 여는 영역도 44px 이상으로 조정했다. 실제 조회 중에는 항목·프로젝트 연결을 불러오는 상태를 표시한다. 목록·만들기·수정 분리, 직접 작성 저장의 응답 유실 후 단일 재확인, 원본 교차 선택·목표 검토·게시, 프로젝트 추가 부분 실패 복구, 검색·복수 선택·보관·복원과 입력/터치 크기를 검증했다. 전체 회귀는 Python 85 pass, TypeScript 0 error, Bun 6109 pass / 10 skip / 0 fail, Rust 73 pass, quick 5/5 pass다.

SDK 내보내기는 package 버전을 정본으로 사용하고 기존 통합 기억의 portable type 두 파일을 함께 내보내도록 보완했다. 0.3.1의 13개 관리 파일을 fresh export로 browser build·portable regression 검사했다. 설치본·실기 결과와 최종 공개 source SHA는 각 호스트의 별도 영수증으로 확인한다.
