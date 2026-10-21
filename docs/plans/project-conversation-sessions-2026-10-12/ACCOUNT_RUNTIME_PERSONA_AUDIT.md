# 계정 관리·런타임 독립 페르소나 감사

검증 저장소: `worktrees/conversation-sessions`, 기준 HEAD `663ac2b2`(753). 검증 당시 기능 변경은 미커밋 상태였으며, 마지막 통합 관문과 앱 빌드의 근거는 별도로 남긴다.

## 실제 검증 범위

설치 앱의 계정 변경·로그인·세션 종료는 수행하지 않았다. 계정 UI는 임시 HOME·앱 데이터·두 개의 임시 Git 프로젝트·가짜 공식 로그인 CLI를 쓰는 소유한 API 서버에서 검증했다. 브라우저 외부 요청을 차단하고, 임시 서버가 만든 합성 PTY만 시작·종료했다.

| 검사 | 결과 | 범위 |
|---|---:|---|
| 계정 저장·API·MCP·관찰·입력 관련 Bun 묶음 | 43 pass / 0 fail | 프로젝트·CLI별 선택, 이력 소유권, 자격 증명 경계, 권한 취소, 멱등 재시도 |
| PTY·화면·재시작 수직 관문·팝업 Bun 묶음 | 59 pass / 0 fail | 실제 합성 PTY, 출력·입력 순서, 프로세스 복구·정리, 팝업 계약 |
| 재시작·CPR/DA·원격 승인·대기열 Bun 묶음 | 75 pass / 0 fail | 기존 대화·계정 유지, 중복 터미널 응답 제거, resize 직후 Enter, 기기별 동의·복구 |
| 계정 관리 UI 페르소나 | 4 / 4 여정, 각 12개 검사 | Chromium/WebKit × 390×844·1120×780 |
| 팝업·큰 dialog | 8 / 8 | 여러 창, 뷰 닫기, 기기 dialog, viewport·기억 drawer 접근 |
| 입력·IME·세션 수명 브라우저 회귀 | 18 / 18 | 한글 조합, 입력 순서, 종료·세션 전환, 숨긴 상태·읽기 장애 복구 |
| TUI 렌더링 | 4 / 4 | Chromium/WebKit × desktop/mobile, 숨긴 뒤 출력 재개, 최신 화면·구형 호스트 fallback |
| 저장 후 종료 | 16 / 16 | 두 엔진 × 성공·복구·취소·건너뛰기·응답 유실·권한·새 입력·미접수 |
| 사용성 전체 검사 | 53 / 54 뒤 실패한 1개 focused 통과 | 레거시 mobile 검사에 새 CLI 계정 select를 반영한 뒤 1/1 확인. 최종 전체 재검사는 통합 관문에서 수행 |

위 Bun 묶음은 일부 동일 파일을 포함하므로 합산하여 고유 테스트 수로 표시하지 않는다.

계정 페르소나는 Codex·Claude 각각 추가·가짜 공식 로그인·선택, 프로젝트 간 선택 격리, 제공자 간 선택 격리, 중복 이름 거절, 실행 중 계정의 재로그인·목록 제외 거절, 기존 PTY 유지, 합성 PTY 종료 후 목록 제외, 다른 제공자의 선택 보존, 화면 폭·외부 요청 차단을 확인했다. 현재 추가 계정 기능의 지원 범위는 Codex/Claude다. Hermes/agy 계정 선택을 지원한다고 주장하지 않는다.

## 발견과 수정

- 렌더링·입력·사용성 fixture가 새 `accounts/list` 요청을 세션 명령으로 해석해 중단됐다. 알려진 fixture 대상과 Codex/Claude만 받는 정상 DTO를 추가했다. 미등록 대상은 404로 거절한다. 제품 코드는 이 이유로 변경하지 않았다.
- mobile 사용성 검사는 select가 두 개라고 가정했다. 이제 CLI 계정·프로젝트·AI 세 select의 접근성 이름을 정확히 확인하며 기존 높이·폭·overflow 기준을 유지한다.
- 계정 관리 제품 코드에서 재현된 결함은 없었다. 실제 제공자 OAuth 로그인이나 유료 모델 실행은 검증하지 않았다.
- Directory 독립 코드 검토에서 새로 고른 행의 owner 교체, 대기 요청의 owner 결속, 교체된 owner의 오래된 대기열, 내부 세션 탭 전환 후 행 다시 열기, disabled fieldset 추가 뒤 flex ancestry 문제를 담당 에이전트에 전달했다. 해당 수정·회귀 결과는 Directory 담당 검증을 따른다.

## 증거 파일

- `output/playwright/cli-accounts-personas/results.json`: 4개 계정 여정과 검사 목록
- `output/playwright/cli-accounts-personas/*-in-use-account.png`: 실행 중 계정의 변경 거절
- `output/playwright/cli-accounts-personas/*-claude-preserved.png`: 제공자 전환·Codex 제외 뒤 Claude 선택 보존
- `output/playwright/workroom-popout-results.json`: 팝업·dialog 8개 검사
- `output/playwright/workroom-input-lifecycle-results.json`: 입력 회귀 18개
- `output/playwright/workroom-rendering-results.json`, `workroom-render-*.png`: 두 엔진·두 표면의 TUI
- `output/playwright/workroom-usability-results.json`: 전체 53/54 결과
- `output/playwright/workroom-usability-focused-results.json`: 수정한 mobile 항목 1/1 결과

계정 screenshot은 Chromium 390px과 WebKit 1120px을 직접 읽어 라벨·거절 사유·계정 선택·관리 버튼의 줄바꿈과 가림 여부를 확인했다.

## Native 실행과 빌드 경계

읽기 전용 확인 당시 `/Applications/AgentsToZ_byCS.app`은 `751.0.0`, 실행 PID 71598이었다. 설치 sidecar PID 71614가 `127.0.0.1:3001`을 점유했다. PID/PPID/TTY/프로그램명만 사용한 조상 관계 검사에서 node 25227·codex 25229의 두 터미널 연결 자식이 확인됐다. argv·환경·대화 원문·credential은 읽지 않았다. 캐시된 빌드 bundle은 `752.0.0`이었다.

`build-macos.ts --allow-unpublished-source`도 깨끗한 Git 상태를 요구한다. 로컬 TEST는 검증한 소스만 담은 별도 clean commit snapshot에서 빌드하고, `/Applications`에 설치하지 않고 별도 경로에서 연다. 원격 기본 HEAD와 일치하지 않는 산출물은 공식 배포본으로 표시하지 않는다. 이 감사에서는 커밋·push·빌드·앱 열기를 수행하지 않았다.

Native sidecar supervisor는 3001의 호환 API를 채택하며, 비호환·다른 서비스는 건드리지 않는다. 따라서 기존 751 sidecar를 유지한 채 후보 frontend를 여는 것은 새 SDK/cloud/runtime backend가 동작한다는 증거가 아니다. 실제 backend 검증이나 설치 앱 교체에 기존 앱 종료가 필요하다면, 실행 중 작업과 이어갈 수단을 확인하고 구체적인 TEST 산출물을 준비한 뒤 사용자의 승인을 받는다.
