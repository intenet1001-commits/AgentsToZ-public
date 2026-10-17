# 공통기억 · Mac 메뉴 · 프로젝트 묶음 · iPhone 검증

## 동작

- Mac의 `공통기억`은 `장기기억`과 같은 최상위 탭이다. 기존 장기기억 화면에서는 이 탭으로 이동하며 중복 편집 화면을 만들지 않는다. 기존 Mac 로컬 메타 기억은 별도 접힌 영역에서 유지한다.
- 새 프로젝트의 `공통기억으로부터 만들기`는 선택한 기억의 현재 원본 프로젝트들을 검토하고 각 저장소를 Clone·기존 기억 복원·등록한다. 이미 등록된 memoryId를 재사용하고 다른 기억의 같은 저장소, 접근 불가 등록, 기존 폴더는 확인 대상으로 표시한다. 공통기억 게시본을 원본 프로젝트의 목표에 자동 적용하지 않는다.
- 기기별 누락 프로젝트 안내와 개별/일괄 추가를 제공한다. 일괄 작업도 회원별 명시적 요청 ID로 처리하고 실패·미확정 결과에서 멈춘다. 같은 요청 재시도는 자신이 만들었던 폴더의 복원·등록을 이어간다.
- 원본 내용·계보, 목표·게시본, 클라우드와 작업 루트의 identity, root grant를 실행 중 다시 검사한다. 사용자 원본 CORE와 기존 로컬 기억 계보를 보존한다.
- 모바일 클라우드 관리와 작업 루트 추가 권한은 별도다. 기존 8개 기능 조회를 유지하며 새 클라이언트만 확장 기능 조회를 요청한다. 공유 전송 버퍼·만료·요청 예산을 사용한다.
- MCP 계약 1.34.0/80개 도구와 SDK 0.2.0에 원본 목록/전체 항목, 프로젝트 계획/추가, 완료 영수증 조회를 제공한다. SDK에는 정확한 의존성 lock을 내보내며 새 checkout에서는 lifecycle script 없이 frozen install 후 빌드·검사한다.

## 확인한 결과

- Mac 화면: 격리된 실제 Vite 빌드에서 메뉴 6개·ARIA/방향키/Home/End 이동 및 관련 화면 9개 검사 통과.
- Chromium/WebKit 390×844: 처음 생성·검토·게시, A+B/B+C의 목표별 선별, 목표 변경 시 선택 초기화, 프로젝트 2개 Clone, 복원 실패 후 중복 없는 재시도, 응답 유실·새로고침 후 읽기 전용 영수증, 입력 16px/버튼 44px/가로 넘침 없음 통과.
- 물리 기기: 연결된 **iPhone 13 Pro Max(iPhone14,3), iOS 26.3**의 실제 WKWebView. native Appium 터치와 실제 키보드로 위 생성/선별/프로젝트 2개/부분 실패/프로세스 재시작 후 영수증 확인 5개 흐름 통과. 428px viewport, 확대율 1, 가로 넘침 없음, 표시 입력 16px. 기존 main/dev/TestFlight와 연결 정보를 보존하고 격리 앱만 시험 후 제거했다.
- 실기에서 HTTP LAN WebKit의 `randomUUID`/`subtle` 부재를 확인해 보완했다. CSPRNG `getRandomValues`로 UUID를 만들고 동일 SHA-256을 사용한다. HTTPS 암호화와 권한 규칙은 유지한다.
- 실제 Bun stdio MCP 프로세스에서 initialize/tools/list, 원본 목록·정확한 전체 항목, 동일 요청 재시도·문서화되지 않은 입력 거부를 검증했다. 기존 설치 MCP의 Control profile/운영 기억 읽기도 성공했다.
- quick 5개와 페르소나 프로필 통과. SDK의 node_modules 없는 checkout 자동 준비와 SDK quick 2개 통과. 최종 `bun run verify`: Python 85 통과, TypeScript 오류 0, Bun 6,089 통과/10 기존 skip/0 실패(794 파일), Rust 73 통과/0 실패. 출하 commit·설치 결과는 빌드 metadata와 별도 출하 증거에서 확인한다.

## 증거 경계

물리 UI 시험은 **격리된 클라우드와 소유한 실제 Git 저장소**를 사용했다. 실제 Supabase 계정·개인 relay·SAS 신규 승인·셀룰러 전환·TestFlight 다운로드를 이 시험의 성공으로 주장하지 않는다. 브라우저 검사와 다른 Mac 모양의 경로 검사도 실제 다른 Mac 설치 증거가 아니다. 실기 PNG/상세 JSON은 `mobile/ios/build/common-memory-device-evidence`의 private 산출물로 보존하고 Git에 올리지 않는다.

## 재현

`bun tests/common-memory-ui.mjs`, 프로젝트 tester quick/persona, `bun run verify`를 실행한다. 물리 시험은 `check-common-memory-device.ts`가 알려 준 격리 template의 provisioning certificate와 연결된 기기 ID로 시작하고, 자신이 만든 Appium session JSON 및 fixture JSON을 `check-common-memory-device-ui.py`에 전달한다. 인증서 이름의 Team 표기만 믿지 말고 embedded profile의 허용 인증서와 일치시킨다. 두 도구는 production bundle을 시험 template으로 받지 않는다.

## 출하 및 운영 확인

개발 source `9860be44f8a315c3b4a2b5cd5813b7366ace8971`을 GitHub에 반영하고 공식 원격 HEAD/clean-source 가드로 **743.0.0** Mac 앱을 빌드·서명 검증·설치했다. 실제 Mac에서 장기기억과 같은 tab group의 공통기억 메뉴를 확인했다. 같은 source의 **iPhone 개발 앱 743.0.0**(별도 `.dev` bundle, build `261011120653`)도 설치했다. main/TestFlight 앱은 이 설치 결과에 포함되지 않는다.

실제 설치된 MCP binary **1.34.0+build.743 / 80 tools**에서 실제 Mac host/Supabase를 사용해 원본 94개 목록, SDK 원본 전체 1,492 bytes 읽기와 원본 hash, 시험용 목표 version 1→2 변경을 확인했다. QA 그룹은 보관 처리하고 원본 장기기억은 쓰지 않았다. 운영에서 누락된 metadata-only head catalog RPC를 발견하여 기존 bundled schema와 같은 invoker 함수/권한을 `20261011122536_project_memory_head_catalog_compat`로 보완하고 migration history를 기록했다. anonymous 실행은 거부하고 기존 102 head/517 revision 행을 보존한다.

SDK **0.2.0**을 원본 source에서 11개 관리 파일·lock·hash manifest로 내보냈다. SDK GitHub `98b11fc`, 깨끗한 SDK checkout의 quick 2개와 현재 Mac 모듈의 자동 준비를 확인했다. 현재 Mac의 기존 SDK Git 변경과 독립 `Cdp` 저장소는 유지했다. 원본 SDK/project 기억과 사용자 변경을 합쳐서 커밋하지 않았다.

## OPS 연결 안내 통합과 USB 개발 검사 보완

별도 `codex/ops-memory-aws` 작업의 검토된 변경을 공통기억 작업에 통합했다. OPS·legacy Control 저장소는 표시에서만 `OPS 운영 기억`으로 구분하며 이름으로 권한을 부여하지 않는다. AWS 안내·Hermes `/memory_link` 오류는 같은 기억 ID의 폴더 등록과 기존 OPS 프로필 복원을 먼저 안내한다. 공통 기억 에이전트 버전은 25이며 후보에 대한 인증된 사람의 검토는 유지한다.

실기 개발 앱 설치기가 사용하는 `usb-development` 채널이 기존 Web Inspector 허용 목록에서 빠져 있음을 발견했다. 이름이 확인된 시험 채널만 검사하도록 보완하고 배포·누락·미지원 채널 차단을 확인했다. iOS 네이티브 15개 회귀 그룹과 실제 native/Bun 연결·재연결 검사가 통과했다.

통합 source의 `bun run verify`는 Python 85 통과, TypeScript 오류 0, Bun 6,094 통과/10 기존 skip/0 실패(795 파일), Rust 73 통과/0 실패다. OPS 관련 회귀 86개와 1100px·390px 화면 검사도 통과했다. 실제 운영 iPhone 연결과 AWS 프로필 복구 결과는 별도 실행 확인 후 기록한다.

## 운영 연결 후속 검사

`ba608e1c`의 Mac 앱과 iPhone 개발 앱 745.0.0을 설치했다. 실제 iPhone 13 Pro Max에서 QR 사진을 판독하고 두 끝의 SAS가 일치하는 것을 확인하여 ‘아젠투지 1호’ 연결을 승인했다. 별도로 승인받은 공통기억 조회·관리와 `product_2026` 작업 루트의 프로젝트 Clone·등록 권한만 저장했다. 기존 기기 연결을 유지하고 일반 AI 작업·대화 권한은 추가하지 않았다. 실제 암호화 relay에서 공통기억 목록과 클라우드 원본 94개를 읽었으며 실제 키보드로 목표를 입력했다. 카메라 촬영·셀룰러 전환·TestFlight 설치는 이 결과에 포함되지 않는다.

권한 화면의 일괄 5개 기능 저장이 별도로 저장된 공통기억·프로젝트 추가 권한을 지우는 회귀를 재현했다. `internet:` 소유자 결속으로 기존 권한을 읽고 일괄 5개 기능과 합친 결과를 서버·화면에 함께 저장하도록 보완했다. 375·500·800·1024px의 실제 React 승인 화면 20개 사례에서 별도 권한 유지·전체 해제·부분 실패 재시도가 통과했다. 보완 source 전체 `verify`도 Python 85, TypeScript 오류 0, Bun 6,094/0 fail, Rust 73/0 fail로 통과했다.

실제 설치 MCP 1.34.0+build.745의 80개 도구에서 클라우드 원본 94개·전체 SDK 원본 1,492 bytes·원본 hash 검증·목표 version 2·QA 보관 상태를 읽기 전용으로 재확인했다. 원본 기억은 수정하지 않았다.

AWS는 clean source를 `ba608e1c`로 fast-forward하고 frozen 의존성 설치·Linux Bun 번들 검증 뒤 기존 API 서비스만 반영했다. 초기에는 해당 호스트의 GitHub 계정에 Private OPS 저장소 권한이 없어 준비 중이었다. 사용자의 별도 접근 승인 후 기존 저장소·프로필·기억을 공식 복원 경로로 연결했다. 최종 프로필은 `ready` / `control-folder`이며 원래 프로필·기억 ID와 표식이 일치한다. 기존 등록 7개를 보존하고 OPS를 추가했다. 오류가 났던 원래 Telegram topic을 기존 세션의 정확한 기억 ID 요청으로 확인한 뒤 연결했다. 상태 조회가 성공하고 새 기억 초기화는 없었으며 다른 topic 바인딩은 그대로다. 실제 AWS stdio MCP의 80개 도구, OPS 프로필 조회와 ‘아젠투지’ alias 해석도 통과했다. 실제 봇 메시지 발송이나 볼륨 변경은 수행하지 않았다.

## 최종 설치 및 실제 클라우드 시험 — 2026-10-12 KST

공식 출하 가드를 통과한 `e0818efe`의 **Mac 746.0.0**을 설치하고 실제 창에서 소스·버전과 `장기기억`/`공통기억`의 같은 메뉴 깊이를 확인했다. 기존 iPhone 연결의 별도 두 권한과 선택한 작업 루트는 Mac 교체 뒤에도 유지됐다. iPhone 개발 앱은 **745.0.0**이며 이 후속 Mac 변경은 승인 화면의 권한 보존 보완이다.

실제 iPhone 13 Pro Max의 개발 앱에서 운영 relay와 실제 Supabase를 사용해 QA 공통기억을 만들고 SDK·Mac-setup 두 원본을 연결했다. 실제 키보드로 목표 관련 규칙·필요 이유를 저장하고 게시했다. 목표를 version 2로 수정하면 항목 재검토가 요구되고 기존 version 1 게시본이 보존됐다. 설치 MCP **1.34.0+build.746 / 80 tools**의 읽기 전용 확인에서 원본 94개 목록, 검토한 SDK 원본 전체 527 bytes와 hash, 원본 head 불변, 목표 변경·이전 게시본 보존을 확인했다. 초기 MCP 검증 스크립트의 필드 가정은 실제 요약 DTO의 `needsReviewCount`로 바로잡았으며 최종 검증은 통과했다.

같은 iPhone의 프로젝트 추가 계획은 승인된 `product_2026` 루트만 선택해 조회했다. SDK는 이미 등록됨으로, GitHub 주소가 없는 Mac-setup은 확인 필요로 표시됐다. 이 운영 시험에서는 추가 가능한 프로젝트가 없어 새 Clone을 하지 않았다. 프로젝트 2개 실제 Git Clone·부분 실패 재개는 앞의 격리된 물리 시험 결과다. QA 공통기억은 보관하고 시험용 QR 파일 제공 앱과 자신이 만든 시험 서버·세션을 정리했다. 원본 장기기억과 기존 설치 앱은 유지한다.

셀룰러 전환과 TestFlight 재배포는 미검증이다. 신규 grant가 없는 기기에서는 해당 Mac 연결/권한을 먼저 안내한다.
