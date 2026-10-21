# 구현·검증 기록 — 프로젝트와 워크룸

이 기록은 계획 문서와 구분한 실제 실행 증거다. 소스 구현, 격리 fixture, 기존 설치본, 새 설치본과 운영 배포의 결과를 서로 대체하지 않는다. 아래 검증은 커밋 전 작업 트리에서 실행했다. 이후 소스 해시 동일 여부를 확인하고 커밋·푸시하며, 설치·운영 배포 여부는 별도로 판정한다.

## 구현

- Mac 프로젝트/워크트리 상세의 주 행동을 **워크룸에서 작업 / Mac의 Codex 앱에서 처음·이어 열기**로 연결했다. 대상·AI를 명시하며 mount만으로 실행하지 않는다. 대상 변경 후 도착한 이전 응답은 새 대상의 성공으로 표시하지 않는다.
- Codex의 기존 대화 확인이 불가능하면 새 대화를 만들지 않는다. 확인된 부재만 고정 첫 안내문 1회 준비를 허용하며, 앱 열기 실패 재시도는 같은 대화를 사용한다. OS가 열기 요청을 받았다는 결과와 실제 창/프로젝트 선택 확인을 구분한다.
- 프로젝트 생성 전 controller·요청·root identity에 결속한 영속 기록을 예약한다. 등록 후 부가 처리 실패는 등록된 폴더를 이동하지 않는다. 생성 응답에 정확한 프로젝트를 포함하여 목록 첫 페이지 밖에서도 선택한다. 화면도 미확정 생성 요청 ID를 새로고침·재시도에 유지한다. 이름·token을 저장하지 않고 지문과 무작위 ID만 최대 32개 보관한다. 같은 pairing의 프로젝트/루트 ID는 HMAC으로 재시작 후에도 유지한다.
- 워크룸 권한은 연결별 명시 동의와 선택한 프로젝트 또는 ‘이 기기가 선택한 작업 폴더에 만든 프로젝트’ 범위에 결속한다. 최대 30일이며 pairing의 만료를 넘기지 않는다. 기존 관리형 실행 권한이나 세션 한정 동의를 자동 승격하지 않는다.
- private grant 파일의 원자 쓰기·revision CAS·프로세스 간 잠금과 현재 연결의 실행 전후 검증을 추가했다. 해제·만료·바뀐 대상·이전 socket의 요청은 거부한다.
- 포털·원격 화면은 공통 밝은/어두운 색상·폰트 토큰을 사용한다. Projects/Workroom 전환에서 같은 워크룸을 유지한다.
- iOS는 Projects/Workroom에 단일 WKWebView와 저장소를 사용한다. background에서 연결 화면을 파괴하지 않으며 cold launch는 저장된 검증된 origin으로 복귀한다. 새 연결에서 QR을 재전송하거나 controller를 이중 생성하지 않는다.
- iOS 인터넷 로그인은 시스템 인증 창과 PKCE를 사용한다. 고정 callback, main-frame origin, state, code-only 결과, 일회용 attempt와 295초 native timeout을 검증한다. JS의 300초 deadline 전에 native 시도를 정리한다.
- LAN의 마지막 프로젝트·AI·터미널 선택은 해당 pairing에 결속해 복원한다. 현재 목록에 정확한 대상이 없으면 선택 필요/종료 상태를 표시하며 다른 프로젝트로 바꾸거나 입력을 재전송하지 않는다.
- 명시 연결 해제는 서버 ACK와 단순 socket close를 구분한다. ACK가 없으면 원격 권한 해제 성공을 주장하지 않는다.

## 실제 검증 결과

| 실행 | 결과 | 범위 |
|---|---|---|
| Workroom usability E2E | 30/30 통과 | 실제 React/xterm + 격리 API fixture |
| Workroom input lifecycle E2E | 12/12 통과 | 입력, 한글 CDP composition, 유실/지연, 종료, session 전환; 물리 키보드/실제 iPhone IME는 아님 |
| ProjectLaunchActions E2E | 375/1024px 모두 통과 | mount 무실행, 첫/이어 열기, unknown 재조회, 대상/AI, 오류 유지, 중복/지연, 44px, 가로 넘침, 두 테마 |
| 최초 인터넷 승인 React E2E | 4/4 통과 | 375/1024px × 프로젝트/루트; 실제 체크박스, SAS·범위 필수, grant 실패 후 재승인 없는 재시도, 두 테마·44px |
| 자원 회귀 | 328 통과 / 0 실패 | queue·보존·종료·관측 수명 |
| Rust + sidecar build | 56 통과 / 0 실패 | 별도 `test:rust`; 기존 compiler warning은 남음 |
| 순수 정책·저장·OAuth 집중 | 28 통과 / 0 실패 | receipt, coordinator, grant, 승인 부분 실패, OAuth; 전체 suite 개수와 중복 합산하지 않음 |
| 생성·재시도 추가 집중 | 73 통과 / 0 실패 | 실제 LAN callback, same-pair host restart ID, 다른 pairing 격리, relay 암호화 요청 ID 포함 |
| 비보안 HTTP 생성 E2E | 통과 | Chromium secureContext=false, crypto.subtle 없음, timeout/reload 동일 actionId, 외부 요청 0 |
| iOS 실제 WK fixture | 22 확인 통과 / exit 0 | 실제 발급 QR URL, 한 owner, background/cold exact 프로젝트 B·Codex·같은 session, 추가 start/input 0, disconnect ACK, 새 pairing 재동의, 외부 요청 0 |
| native OAuth + portal auth | 12 통과 / 0 실패 | fixed callback/state, code-only, 중복/취소, 표준 웹 정책 |
| Swift package | 1 XCTest 통과 | 내부 계약 그룹 포함; 그룹 수를 XCTest 수로 부풀리지 않음 |
| iOS 소스 검사 | 11 그룹 통과 | real URLSession/Bun 사례 포함 |
| iOS build | simulator/unsigned arm64/별도 development 서명 build 성공 | 설치 성공과 별개 |
| 전체 verify | exit 0: TypeScript 오류 0, Bun 4055 통과/0 실패, Rust 56 통과/0 실패 | 529 Bun 파일, 282.90초; 이전 기존 문자열 계약 실패 수정 후 전체 재실행. 이후 폰트 산출 방식 수정은 typecheck·portal build·실제 CSP 브라우저로 추가 검증 |

프로젝트 생성·grant의 실제 파일/격리 Git·LAN/E2EE 통합 테스트와 두 프로세스 CAS 경쟁 테스트도 통과했다. Bun coverage는 function/line 지표만 제공하므로 **branch ≥90%를 달성했다고 주장하지 않는다**. 집중 실행에서 receipt·workroom coordinator·grant store line 100%, grant 정책 line 92.86%였으며, 이는 실제 기기 성공률이나 전체 프로젝트 커버리지가 아니다.

## 표면별 확인과 한계

### ego-browser / Vercel

- 운영 포털의 기존 원격 화면을 ego-browser에서 확인했다. 새 QR이 없는 격리 탭이므로 승인된 운영 세션의 검증은 아니다.
- 수정한 로컬 원격 화면에서 두 테마와 320/375/430/1024/1440px 가로 넘침을 확인했다. 인증 전 화면 검사와 실제 프로젝트 조작 fixture를 구분한다.
- 최종 배포용 산출물에 Vercel과 같은 보안 헤더를 적용한 로컬 서버도 ego-browser로 확인했다. 작은 font subset이 data URL로 inline되어 remote CSP에 차단되는 문제를 발견해 폰트 파일을 별도로 내보냈다. 재빌드 뒤 font error 0과 가로 넘침 없음, 실제 새 번들 로딩을 확인했다. 이는 Vercel의 CDN/로그인/relay 운영 경로 검증과 별개다.
- 정적 산출물만 담은 Vercel 미리보기 배포가 생성됐다. 미리보기는 Vercel 로그인 보호 화면에 막혀 새 페이지의 원격 실행 성공으로 세지 않는다. 운영 배포는 변경하지 않았다.

### 기존 Mac 설치본

기존 v433 설치본에서 등록된 이 프로젝트의 새 Codex CLI 터미널을 열고 첫 화면 출력을 확인한 뒤 종료했다. 프롬프트 제출은 없었고 실제 AI 작업이나 파일 변경을 유발하지 않았다. 따라서 ‘native 전체 워크룸이 실행 불가’라는 가설은 이 경로에서 재현되지 않았다. 원래 상세 화면 버튼과 이번 수정 소스의 새 설치본 동작이 동일하게 통과했다는 의미는 아니다. 설치본 source hash가 현재 작업 소스와 다르다.

새 Mac 공식 설치본은 아직 만들거나 설치하지 않았다. 출하 래퍼의 clean/원격 기본 브랜치 HEAD 가드를 유지한다. Codex 앱에서 정확한 창이 선택된 실제 GUI 결과도 미검증이다.

### 실제 iPhone

연결된 iPhone의 올바른 development team으로 별도 테스트 앱 서명 build는 성공했다. 설치는 무료 development profile의 설치 앱 3개 제한으로 실패했다. 기존 앱을 삭제하거나 교체하지 않았다. 사용자가 슬롯을 비웠다는 응답 전에는 실제 iPhone 검증을 완료로 세지 않는다.

시뮬레이터는 실제 fixture host가 발급한 QR URL을 앱에 입력해 ‘QR을 찍은 직후’를 재현한다. 암호화 연결과 앱 lifecycle은 검사하지만 물리 카메라 인식·기기별 권한·실제 Google 인증 성공의 대체는 아니다.

### 인증 설정

현재 개인 Supabase 프로젝트의 기존 redirect 5개를 보존하고 고정 앱 callback `agentstoz-mobile://auth/callback?state=*` 하나를 추가한 뒤 6개 유지와 Google provider 불변을 재조회했다. token/secret은 로그·문서·앱 간 저장소로 복사하지 않았다. 다른 설치자의 Supabase에도 필요한 설정이며, 실제 Google 로그인→시스템 창→앱 복귀→E2EE resume는 아직 검증되지 않았다.

참고: [Supabase native deep linking](https://supabase.com/docs/guides/auth/native-mobile-deep-linking), [Auth configuration API](https://supabase.com/docs/reference/api/v1-update-auth-service-config), [Apple ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession).

## 남은 출하 조건

- 전체 verify와 UI/iOS fixture는 위 범위에서 통과했다. 이 결과가 아래 실제 설치·운영 검증을 대체하지는 않는다.
- 실제 iPhone 설치 슬롯 확보 후 isolated test app 설치·권한·background/cold resume를 검증한다.
- 보호된 Vercel 미리보기와 실제 Google 인증 복귀를 확인한다.
- 출하 guard를 만족하는 Mac 설치본과 함께 host-first 순서로 운영 반영한다.
- LAN 주소가 바뀔 때의 자동 탐색 + pinned-host challenge는 구현하지 않았다. 같은 origin/session 복구와 다른 주소로의 안전한 자동 이동을 혼동하지 않는다.
- 구버전 native-only 연결을 새 WK 저장소로 가져오는 token 이관은 하지 않는다. 해당 기존 연결은 최초 1회 새 pairing이 필요하다.

증거 산출물: `output/playwright/remote-workspace-source-manifest.json`, `output/playwright/internet-workroom-approval-results.json`, `output/playwright/remote-project-create-lan-results.json`, `output/playwright/project-launch-actions-results.json`, `output/playwright/project-launch-*.png`, `mobile/ios/build/workroom-evidence/`. 생성물은 로컬 검증 산출물이며 저장소의 공개 배포 자료로 자동 포함하지 않는다.
