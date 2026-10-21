# 통합 검증 기록

2026-10-13. v753 기준에 프로젝트별 큰 대화 창, 기기별 대화 목록, 클라우드 원천의 주제 공통기억, SDK 폴더 목록·멘션 복사를 통합했다. CLI 계정 기능은 v752·v753 구현을 유지하고 프로젝트·계정 격리 및 사용성 검증을 추가했다.

- quick `20261012T152015Z-cf9339cb`: 8개 검사 통과, sourceUnchanged=true.
- persona `20261012T152254Z-3e1c5521`: 16개 역할, 중복 제거한 41개 계약·화면 검사 통과, sourceUnchanged=true. 한글 검색 역할은 계약 검사이며 나머지 역할은 실제 렌더 검사와 연결되어 있다.
- 최종 verify: Python 85, TypeScript 오류 0, Bun 6,176 pass/11 skip/0 fail(804 files), Rust 74 pass. 첫 실행의 안내 용어 회귀를 기기로 수정한 뒤 전체 관문을 다시 통과했다.
- 문구 수정 후 공통기억 화면 `20261012T153324Z-2a786f5e`, 관련 페르소나 `20261012T153730Z-ebe362e1` 통과. 용어·후속 판단·원천 근거 계약 22개도 통과했다.
- 전체 App 프로젝트 진입은 1440×900, 1100×850, 390×844에서 큰 popup과 차단 시 동일 세션 dialog fallback을 확인했다. 실패 때문에 CLI를 다시 시작하지 않는다.
- 계정 UI는 Chromium/WebKit의 desktop/mobile에서 각 12개 검사, SDK는 두 브라우저·두 폭 및 전체 App의 긴 목록까지 5개 여정, 런타임 사용성은 54개 시나리오를 통과했다.
- 커뮤니티 목록은 동일한 opaque session ID를 쓰는 세 기기를 격리하여 기기 소유권·내부 탭 전환·대기 요청·연결 소실 후 초안 복원·숨김 상태 조회 중단을 검증했다. 실제 다른 Mac의 운영 세션을 종료하거나 계정을 바꾸는 검사는 하지 않았다.

증거는 로컬 `.agentstoz/maintainer/runs/`, `output/playwright/cli-accounts-personas/`, `.agentstoz/maintainer/integrated-ui-evidence/`와 `/tmp/agentstoz-persona-directory-final`, `/private/tmp/agentstoz-sdk-folder-evidence`에 있다. 로그·화면은 테스트용 데이터이며 사람 대상 사용성 연구나 실제 OAuth·유료 AI 호출·실제 클라우드 승인 완료를 의미하지 않는다.

기억의 실제 동작·예산·서버 원천 검증과 RPC 사이의 한계는 [구현 계약](../../handoffs/2026-10-13-cloud-topic-memory-implementation.md)을 따른다. 공통기억 후보 발견은 일곱 분야의 항목 기반 힌트이고, 내용의 의미·예외·새 분야는 OPS의 AI 정리와 사람이 검토한다. 선택 승인만으로 원본 기억이나 활용 프로젝트를 합병하지 않는다.

이 기록은 코드 검증이다. 앱 번들·실행 경로·설치/API/MCP의 소스 일치 및 기존 터미널의 종료 권한은 별도 적용 영수증에서 확인한다. 검사 때 현재 Mac의 설치 앱은 v751, 기존 캐시 번들은 v752였다. 설치 앱에는 살아 있는 Codex PTY가 있어 검사를 위해 종료하지 않았다.

## Mac 설치 앱의 후속 검증

v754를 원격 기본 브랜치에서 공식 빌드한 뒤 staged install로 백업·교체·열었다. 실제 설치 app/sidecar의 실행 경로·버전·health와 빌드 원본의 SHA-256 일치를 확인했다. SDK의 실제 폴더 7개와 멘션 복사, 큰 native 창, 창 닫기 후 Codex PID·세션 ID 유지와 재사용, 1호·2호·현재 3호 조회 및 2호 종료 세션의 큰 보기, 클라우드 원본 8개의 주제 후보, 미전송 OPS 요청의 탭 이동 뒤 보존을 확인했다. Finder 내부 화면은 도구 승인 검사에서 거절되어 확인하지 않았고 iPhone 실기는 진행하지 않았다. 실제 OAuth 추가·유료 AI 요청·공통기억 후보 승인은 fixture 검증과 구분한다.

실기에서 찾은 세 문제를 추가로 수정했다. 기기·커뮤니티·종료/활성 탭이 함께 있는 1120×780/font16 창에서는 고정 terminal floor 때문에 작성칸 하단이 795px로 밀렸다. 화면 높이에 따른 floor로 배분한 뒤 전체 작성칸이 처음부터 들어오고 터미널 DOM·초안은 유지된다(Chromium/WebKit 각 9개 popup 여정). SDK와 CS 대직의 같은 sibling key는 프로젝트 전환 후 중복 버튼을 남겼으므로 각 패널 이름으로 분리했다(실제 App에서 수정 전 2개로 실패, 수정 후 반복 전환·빈 결과·목록 복귀 통과). 초기 OPS 조회는 기존 sidecar startup readiness를 기다리는 프로젝트 로드 뒤로 옮겼다(준비 전 실패 재현, 수정 후 1회 조회로 OPS·기억 역할·AI 요청 버튼 복구).

추가 persona `20261012T163045Z-b1080a07`: 관련 4개 역할, 중복 제거한 20개 검사 통과, sourceUnchanged=true. 최종 설치 앱의 재검증은 로컬 `output/mac-real-device/2026-10-13.md`, 전체 필수 검사와 공식 빌드는 해당 로그의 완료 결과를 확인한다. 이 후속 기록은 공통기억의 실제 후보를 대신 승인하거나 다른 기기의 작업을 종료했다는 의미가 아니다.
