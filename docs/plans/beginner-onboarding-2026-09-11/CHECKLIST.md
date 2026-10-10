# 구현·검증·출시 체크리스트

상태: 2026-09-11 첫 구현 진행. 상세 구현 경계와 검증은 [실행 기록](EXECUTION.md)에 있다.
GitHub 대표 경로의 실제 배포본 검사·권한·로그인 보호 구현은 [후속 실행 기록](GITHUB-EXECUTION.md)에 있다.
O2의 로컬 첫 프로젝트 진입 구현은 [첫 프로젝트 실행 기록](FIRST-PROJECT-EXECUTION.md)에 있다.
Codex 로그인 정보 판정과 읽기 전용 첫 응답 연결은 [Codex 실행 기록](CODEX-FIRST-RESPONSE.md)에 있다.
Codex 자동 설치와 신규 로그인 시작·취소 사전 시험은 [설치 후속 기록](CODEX-INSTALL-EXECUTION.md)에 있다.
Mac browser 로그인 도우미·취소/재개·인증 정보 격리 구현은 [로그인 후속 기록](CODEX-LOGIN-EXECUTION.md)에 있다.
아래 미체크 항목은 구현/검증 완료를 의미하지 않는다.
제품 결정은 [PLAN.md](PLAN.md), 실행 계약은 [ENGINE.md](ENGINE.md)를 따른다.

## 1. 이미 확인한 사실

- [x] 현재 소스와 로컬 장기기억을 읽고 신규 사용자 방향을 대조했다.
- [x] 설치 앱과 소스 실행의 분리 정책, bounded probe, 추가 등록 pending UUID 보호가 이미 있음을 확인했다.
- [x] 중복 wizard, React 메모리에만 남는 단계, 명령 복사 위주의 현황판, 상태 조회의 부작용 가능성을 확인했다.
- [x] Mac 배포와 iPhone TestFlight를 구분하고 공식 설치/인증 자료를 검토했다.
- [x] 공통 모바일+사용자 Supabase가 기존 제품 방향임을 확인했다.
- [x] 개인정보·인증값을 조회/복사하지 않고 설계 문서만 작성했다.
- [ ] 아래 신규 엔진·UI·OAuth broker·고객 gateway를 구현했다.
- [ ] 완전 신규 사용자로 Mac→AI→클라우드→iPhone의 전체 여정을 검증했다.
- [ ] 신규 온보딩 버전을 TestFlight/공식 Mac 설치본으로 배포했다.

## 2. 구현 순서와 통과 기준

| 단계 | 결과물 | 통과해야 다음으로 갈 수 있는 기준 | 권장 에포트 |
|---|---|---|---|
| O0-local / O0-cloud 실증 | 배포·신규 Mac·recipe / OAuth·등록 실증 | local은 O1/O2, cloud는 O3의 선행 조건으로 각각 판정 | Ultra |
| O1 공통 실행 엔진 | 계획·영수증·복구·잠금·인증 세션·진단 분류 | 대표 installer와 인증에서 중단/응답 유실/재시도 성공 | High~Ultra |
| O2 첫 사용자 수직 구현 | 시작 UI, AI 하나, 첫 프로젝트/첫 결과, GitHub 대표 연결 | 깨끗한 Mac에서 개발자 설명 없이 앱의 안내만으로 첫 결과 | 구조 고정 후 Medium |
| O3 내 자료·모바일 연결 | Supabase bootstrap, gateway 등록, 공통 웹/네이티브 연결 공간 | 다른 사용자 소유 DB와 실제 iPhone 외부 네트워크 왕복 | 인증·전환은 Ultra |
| O4 추가 도구와 보조 | 나머지 AI, 앱 설치, Vercel, ego, 고급 복붙 | 같은 엔진/영수증을 사용, 독립 wizard/새 권한 우회 없음 | 반복 어댑터 Medium |
| O5 문서·메뉴 전환 | 기본 진입 단일화, 얇은 agent, 구 링크 호환, 중복 제거 | 모든 기존 지원 경로가 새 경로/유지 문서로 매핑됨 | Medium |
| O6 출시 검증 | 깨끗한 기기 시험, 초보자 시험, 서명 Mac/실제 TestFlight | 선택 기능별 출하 증거·복구·지원 범위를 충족 | 일반 시험 Medium, 미해결 경계 High 이상 |

의존성은 `O0-local → O1 → O2`, `O0-cloud + O1 → O3`다. O4의 독립 도구는 O1/O2 뒤 O3와 병렬화할 수 있다.
O5 정리는 새 경로가 검증된 영역부터 적용한다. O6는 아래 출하 단위별로 수행한다.
O0에서는 별도 검토로 배포/OAuth와 로컬 엔진/UX를 병렬화할 수 있다. O1 후 도구 어댑터도 분리 가능하다.
그러나 같은 Mac의 package manager와 같은 Supabase 프로젝트 변경을 병렬 실행하지 않는다.
기간은 O0에서 신규 OAuth 운영 승인·Intel 시험 기기·Apple 계정 준비를 확인한 후 산정한다.
외부 가입/심사 대기와 개발 시간을 합쳐 근거 없는 완료 날짜를 약속하지 않는다.

출하 단위도 분리한다. L은 검증된 CPU/OS의 로컬 Mac·AI 하나·첫 프로젝트,
C는 고객 Supabase·공통 모바일·내부 TestFlight, X는 나머지 도구·외부 베타다.
Intel이 아직 미검증이면 L은 검증된 arm64만 명시할 수 있으나 Intel 지원을 광고하지 않는다.
L의 배포가 O0-cloud의 외부 승인에 종속되지 않는다. 각 단위의 제공 범위는 첫 화면에 정확히 표시한다.

Claude·Codex·agy·Hermes에 같은 에포트 문자열을 강제하지 않는다. 표는 이 Codex 설계의 권장 깊이다.
다른 실행 표면에서는 실제 지원 설정을 확인하고 그에 맞는 높은 추론/일반 단계로 안내한다.
모델과 에포트는 별도이며 추천을 적용했다고 자동 보고하지 않는다.

### O0 — 가장 먼저 확인할 것

아래 로컬 배포·recipe 항목은 O0-local, 관리 인증·gateway·모바일 항목은 O0-cloud에서 별도 판정한다.

- [ ] 공식 Mac 배포의 서명·공증·staple·Gatekeeper 검증과 clean 설치 환경 준비.
- [ ] 최소 macOS/CPU 지원 표 확정. arm64·Intel의 AgentsToZ 및 선택 공급자 지원을 개별 검증.
- [ ] 새 Mac에서 앱만 설치한 상태로 offline 프로젝트 등록·재실행 시험.
- [ ] Supabase OAuth 통합 등록, 공식 scope·동의·token exchange·client secret 서버 보관 검증.
- [ ] 가입 완료→project 조회→선택/생성→구성 설치까지 실제 test workspace에서 실증.
- [ ] OAuth broker의 일시 token 처리와 Mac 전달·취소·만료·회수·로그 제외 계약 검토.
- [ ] access/refresh token 수명 분리, 동일 run·키 재조회, 키 분실 재인증, 취소 뒤 수령 거부 검증.
- [ ] 위 통합이 막힐 경우 로컬 CLI/보호 입력 경로와 남는 사람 행동 수를 실측.
- [ ] 현재 모바일 실제 로그인 회귀 해결 확인과 신규 gateway 여정의 의존성 분리.
- [ ] 도구별 라이선스·재배포 가능 여부·공식 설치 출처·최소 버전·서명 검증법 확인.
- [ ] recipe 정본, UI 상태, 사용자 승인 범위, 외부 mutation 멱등성 등급 고정.

O0의 중요한 결론은 `현재 상태에서 쉬운 공개 베타가 가능한 범위`다.
기존 개인 포털에서 작동한다는 사실만으로 신규 고객의 Supabase·모바일 준비가 끝난 것으로 보지 않는다.

### O1 — 신뢰할 수 있는 단계 엔진

- [ ] 기존 `/api/onboarding/tools`로 probe를 통합하고 설치 부작용 없는 상태 조회 보장.
- [ ] auth failure를 로그아웃·네트워크·권한·server failure·unknown으로 분류.
- [x] legacy public key 판별을 강화하고 service-role/secret 키의 초대·클립보드 유출 차단.
- [ ] SQLite 또는 기존 동급 내구 저장소로 run/operation/evidence/revision 구현.
- [ ] 승인 digest·expected revision·단일 실행·소유 프로세스/lease 검증.
- [ ] 실행별 격리 cwd/임시파일, 명시 projectRef, 안전한 argv 전달.
- [ ] 인증 전용 세션이 Workroom·내가 한 말·기억·remote transcript에 들어가지 않는 검사.
- [ ] 다운로드·설치·로그인·검증 각각의 deadline/취소/재시도 정책.
- [ ] 대표 GitHub CLI 설치/기존 설치 재사용→로그인→실제 계정 확인의 수직 시험.
- [ ] 모든 mutation 전후 crash point와 응답 유실에서 중복 실행을 막는 행동 시험.
- [ ] 앱 업데이트/회수된 recipe/구 receipt schema에서 readback만 허용하는 재개 계약 시험.
- [ ] 비밀값과 단순 비밀 hash가 input digest/receipt에 들어가지 않는 검사.
- [ ] 기존 등록 읽기 실패를 신규로 오판하지 않고 이전 설치 alias·ID를 유지하는 검사.
- [ ] 인증 대기 단계를 보류한 뒤 독립 준비 진행, 성공 기능 즉시 사용, 같은 단계 재개 시험.

### O2 — 첫 유용한 결과

- [ ] 시작하기/기존 환경 연결/이어서 준비하기가 같은 session을 사용.
- [ ] 목적에 필요한 단계만 생성하고 누락 의존성을 자동 준비.
- [ ] 전체 도구 선택에서 지원/이미 설치/별도 가입 항목을 구분하고 중복 설치하지 않는 검사.
- [ ] 기존 제공자 상태 우선, 없으면 사용자 선택으로 AI 하나 준비.
- [ ] ChatGPT/Claude 대화 앱과 코드 실행 기능을 명확히 분리.
- [ ] 일반 첫 경로는 수동 shell 입력과 비밀값 복사 없이 동작.
- [ ] 샘플/첫 프로젝트에서 명시한 작은 AI 요청을 실제 실행하고 결과/기록 표시.
- [ ] 프로젝트 재열기, 앱 재실행, 실패한 단계만 재개.
- [ ] 로컬 관리/기존 프로젝트 경로에서 AI·샘플·새 UUID를 자동 생성하지 않는 검사.
- [ ] 기존 대표 4대 계보와 자료 수 fixture 보존을 신규 UI 출하 전에 확인.
- [ ] 자동 장기기억 정리는 별도 동의·제한·상태를 유지.
- [ ] 두 테마, 메뉴 외부 클릭, 좁은 화면·확대·VoiceOver 검증.

### O3 — 내 자료와 모바일

- [ ] C 내부 TestFlight에 필요한 Apple 계정/앱 레코드·아이콘·개인정보·서명 archive를 먼저 준비.
- [ ] 신규 빈 DB 구성과 기존 DB 업그레이드 경로 분리; 정확한 manifest 적용.
- [ ] 실제 관리 권한·RLS·비회원 차단·bootstrap 결과·기기 등록 readback.
- [ ] Hosted 연결의 Docker 불필요, 기존 DB password 조회 불가와 필요 시 보호 입력 경로 검증.
- [ ] 고객 gateway의 기기별 인증과 추가 단말 승인/회수 검증.
- [ ] 공통 모바일의 실행 시점 workspace 선택과 키/DB/스토리지 격리.
- [ ] 신규 사용자가 운영자의 개인 Supabase/포털에 연결될 수 없는 검사.
- [ ] 첫 모바일 QR와 원격 실행 권한의 분리, 반복 연결/승인 영수증.
- [ ] Mac 앱에서 인터넷 QR 기본 안내, LAN 설명은 정확한 실제 origin 기반.
- [ ] 실제 iPhone TestFlight 빌드로 외부 네트워크 조회·작업·결과 확인.
- [ ] Mac offline에서 동기화 자료와 live 제어 상태를 구분.
- [ ] 기존 4대 계보 fixture에서 ID·프로젝트·기억·북마크·프롬프트 보존.

### O4 — 모든 선택 도구도 같은 방식으로

- [ ] Codex·Claude Code·agy·Hermes 각각 설치/로그인/권한/실제 작업 시험.
- [ ] Hermes profile·provider·gateway/채널 연결은 선택 목적에 맞게 분리.
- [ ] GitHub repo clone/첫 push 등의 실제 필요 작업에서 정확한 계정·대상 확인.
- [ ] Supabase CLI 단독 설치·로그인·대상 확인을 고급 기능으로도 제공.
- [ ] Vercel CLI와 누락 Node/npm 준비, 선택 계정/team/project로 배포·실제 URL 검증.
- [ ] 외부 프로젝트 생성/배포 응답 유실에서 중복 생성 금지.
- [ ] ego를 브라우저 보조의 선행 단계로 설치·첫 실행·연결 확인.
- [ ] ego 미설치/자동화 불가 시 기존 브라우저·한 단계 복붙으로 같은 단계 재개.
- [ ] 대화 앱만 설치한 사람에게 실행 능력이 있다고 오판하지 않는 검사.
- [ ] CLI 명령 변경 시 recipe 비활성화/업데이트 경로. 오류를 사용자에게 검색하게 하지 않음.

### O5 — 불필요한 설명서와 에이전트 정리

- [ ] 기존 온보딩 메뉴·wizard·URL·skill·tests의 전체 소유 목록 작성.
- [ ] 첫/추가 Mac·Windows·AWS·소스 개발자·개인 Vercel의 대체 위치를 모두 매핑.
- [ ] 기본 신규 Mac 메뉴를 `시작 도우미` 하나로 교체.
- [ ] 기술 현황판·개별 로그인은 같은 엔진의 상세 도구로 편입.
- [ ] 오래된 `/onboarding` 프롬프트/skill도 새 엔진으로 연결하는 얇은 호환 어댑터 제공.
- [ ] 공식 링크·설치·검증·문구를 recipe에서 생성해 중복 정본 제거.
- [ ] 생성 marker 밖 사용자 지침·개인 문서는 보존.
- [ ] 소스 중심 Mac 안내를 고정한 문자열 테스트를 실제 설치 여정의 행동 검사로 교체.
- [ ] 새 경로가 확인된 뒤 중복 component/기본 매뉴얼 제거, 복구 자료는 유지보수 문서로 통합.
- [ ] README·AGENTS·공개 가이드·모바일 설계에 과거 사실과 현재 기능의 혼동 제거.

## 3. 실패 주입과 실제 시험 행렬

| 영역 | 시험 사례 | 합격 기준 |
|---|---|---|
| 완전 신규 Mac | CLI·AI·Brew·Node 없음 | 앱 자체가 뜨고 선택 기능의 필요 항목만 준비 |
| 지원 환경 | arm64/Intel, 최소·최신 지원 macOS | 지원 조합 실제 통과, 미지원은 시작 전 정확한 안내 |
| 계정 | 신규/기존, 다른 계정, MFA, 제한된 조직 | 정확한 대상 확인; 무단 로그아웃/권한 확대 없음 |
| 인증 수명 | 취소, 만료, 늦은/중복 callback, 앱 재시작 | 이전 시도가 새 시도를 완료할 수 없음 |
| 네트워크 | offline, 느림, 429, 5xx, DNS, TLS/기업 proxy | 원인 분류·bounded retry, 인증 삭제/보안 해제 없음 |
| 기존 도구 | 여러 manager, 내장 CLI, 오래된 CLI, 깨진 shim | 검증된 재사용, 무조건 재설치/전역 수정 없음 |
| 디스크·경로 | 부족, 한글/공백/긴 홈, 다른 shell | 안전 argv·정확한 필요 용량, 데이터 삭제 없음 |
| 설치 | 중복 클릭, 다른 설치 실행 중, 서명 불일치 | 단일 실행과 출처 검증 |
| 강제종료·업데이트 | 모든 side effect 전/후, 재부팅, recipe 회수/구버전 | 같은 receipt로 확인, 호환 불가 mutation 중단, 중복 생성 없음 |
| 외부 mutation | DB/프로젝트/배포 생성 응답 유실 | 생성된 결과 조회, 모호하면 검토 대기 |
| 권한 | 회사 정책, 표준 사용자, OS 승인 거부 | 승인 경로와 가능한 기능 제공, 권한 우회 없음 |
| QR·원격 | 종류 오류, 소비/만료, camera 거부, Wi-Fi↔5G | 실제 원인 표시, 정상 연결의 불필요한 초기화 없음 |
| 기존 데이터 | 구 설치 alias·동일 이름 다른 기기·구 schema | 신원/계보/기록 보존, 단말 중복 없음 |
| 비밀 경계 | token 출력, 명령/URL/QR, 진단 export | chat/일지/기억/서버 로그/clipboard 유출 0 |
| AI 보조 | 임의 shell 제안, 페이지 prompt injection, 모델 끊김 | 허용 action만 실행, 엔진 독립 사용 유지 |
| 접근성 | 작은 창, 375px, 200%, 키보드/VoiceOver | 도달 불가 버튼·잘린 입력·막힌 모달 없음 |

### 시험 계층

1. 순수 planner와 상태 전이: 존재하는 도구 건너뛰기·목표 변경·진행 계산.
2. 어댑터 계약: fixture subprocess/HTTP로 결과 분류·timeout·auth 출력 비밀 제거.
3. 실제 격리 프로세스와 DB: file/SQLite 내구성·lock·crash·응답 유실 검증.
4. 깨끗한 지원 Mac: release 설치본에서 Finder launch와 실제 공식 installer/auth.
5. 실제 iPhone: production에 가까운 TestFlight 빌드와 외부 네트워크.
6. CLI·AI 미경험 사용자: 개발자 설명 없이 첫 작업과 중단 후 재개.

현재 사용자 Mac의 실제 계정/프로젝트/로그인을 지우는 방식으로 신규 상태를 만들지 않는다.
전용 macOS 사용자·VM·시험 Mac과 분리된 test Supabase/GitHub/Vercel 자원을 사용한다.
공급자 가입·MFA·실제 Apple/OS 권한은 테스트 더블 성공으로 대체하지 않는다.
초기 UI가 안 나왔다고 skip하는 기존 시험은 출하 게이트로 쓰지 않는다. 기대 상태가 없으면 실패다.

## 4. 출시 지표

다음은 목표이며 달성한 실측값이 아니다.

- 일반 지원 경로: 수동 명령 0개, 비밀값 복사 0개.
- 요구된 사람 행동 외에 기술 문서/외부 검색을 할 필요 0회.
- 모든 선언된 failure-injection 지점에서 상태 보존과 안전 재개/명확한 차단 100%.
- 잘못된 완료 표시·무단 계정 변경·자료 손실·중복 단말 생성 0건.
- 최초 시험 5~8명으로 막히는 위치를 찾고 수정한다. 이어 독립 초보자 10명 중 9명 이상이
  개발자의 실시간 도움 없이 선택한 첫 작업에 도달하는 것을 공개 베타 목표로 둔다.
- 첫 유용한 결과까지의 사용자 능동 시간, 다운로드/가입 대기 시간, 클릭·복붙 수를 따로 측정한다.
  시간 목표는 pilot 실측 후 고정하고 기다림을 빼서 전체 시간이 짧은 것처럼 광고하지 않는다.
- telemetry는 선택 동의와 비식별 단계/오류 분류만 사용. 계정·프로젝트명·명령·로그 원문은 제외한다.

## 5. 공개 베타와 업데이트

- [ ] Mac 앱의 공식 출하 소스·Developer ID·공증·staple·실제 Gatekeeper 실행 확인.
- [ ] O3에서 준비한 iOS App Store Connect 레코드·아이콘·개인정보·암호화 분류·서명 archive를 최종 재검증.
- [ ] 내부 TestFlight 설치 → 외부 시험/심사에 필요한 실제 기능 접근 준비.
- [ ] 베타 reviewer에게 실제 격리된 테스트 공간/호스트와 기능 접근 제공. 개인 호스트/비밀 제공 금지.
  demo로 대체해야 한다면 Apple에 사전 확인하고 실제 기능을 충실히 재현·명확히 공개한다.
  단순 체험 화면이 실제 기능 접근 요구를 자동 충족한다고 간주하지 않는다.
- [ ] TestFlight build 만료·새 버전 업데이트·연결/로컬 키 보존 시험.
- [ ] 설치 앱·레시피·schema/gateway·모바일 client 호환 표와 최소 지원 버전 제공.
- [ ] 기존 개인 portal 사용자에게 새 온보딩을 강제하지 않는 rollout/기능 flag.
- [ ] 동의된 테스트 그룹부터 단계 확대. 새 UI를 되돌려도 기기 신원·기억·DB 상태를 되돌리지 않음.
- [ ] 출시 버전의 `bun run verify` 및 변경 범위 UI smoke, iOS 변경 시 `bun run test:ios`와 실제 Xcode 시험.

TestFlight의 90일 만료와 테스트/심사 구분은 운영 체크리스트에 포함한다.
사용자가 TestFlight를 설치했다고 Mac/원격 서버가 켜지는 것은 아니다.
[TestFlight 개요](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/).

## 6. 이번 계획이 넘겨받는 미해결 사항

1. 네이티브 개발 build 5의 실제 Google 재로그인 성공은 기존 실행 기록상 대기다.
   callback 완화가 실제 원인을 해결했는지, 동일 WK 저장소 교환→SAS→5G 동작을 이어 확인해야 한다.
   [네이티브 실행 기록](../mobile-workspace-2026-09-11/NATIVE-EXECUTION.md).
2. 현재 개인 portal 기반 인터넷 기능을 신규 BYOS gateway 완료로 표현하지 않는다.
3. `native-mobile-testflight.md`의 과거 LAN 제한 서술과 최신 README/실행 기록은 출시 시점에 정리해야 한다.
4. 실제 외부 계정·조직·요금·Apple 배포 권한과 provider 정책은 제공자에게 달려 있다.
   선택 목표의 준비 상태에 반영하고 다른 성공 기능을 막지 않는다.
5. Supabase management OAuth의 운영 승인·broker 수명 및 token 전달 PoC가 미완이면,
   무비밀값 복사 클라우드 onboarding은 아직 출시 조건을 충족하지 않는다.

## 7. 공식 근거

2026-09-11 확인. 설치 recipe 출하 전 URL·지원조건을 다시 검증한다.

| 근거 | 계획에 반영한 사실 |
|---|---|
| [Apple 지침](https://developer.apple.com/app-store/review/guidelines/) | TestFlight도 심사 지침을 고려, Mac CLI 설치 호스트의 배포 적합성 별도 검토 |
| [Developer ID](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/) | Mac 직접 배포 서명 경로 |
| [TestFlight 개요](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/) | 베타 배포·만료·테스트 구분 |
| [ChatGPT Mac 설치](https://help.openai.com/en/articles/9275200-using-the-chatgpt-macos-app) | 현재 앱·구 앱 구분과 OS/CPU 요구사항을 최신 출처에서 판단 |
| [Codex 설치](https://developers.openai.com/codex/cli/) / [인증](https://developers.openai.com/codex/auth/) | standalone 설치와 별도 공식 로그인, device-code 가능 여부별 처리 |
| [Claude 앱](https://support.claude.com/en/articles/10065433-install-claude-desktop) / [Code 설치](https://code.claude.com/docs/en/setup) | 앱과 CLI 준비를 개별 확인 |
| [agy 시작](https://antigravity.google/docs/cli/getting-started) | 공식 CLI 설치와 최초 설정·workspace trust |
| [Hermes 설치](https://hermes-agent.nousresearch.com/docs/getting-started/installation/) | desktop installer와 CLI 경로, provider 설정 |
| [GitHub CLI 로그인](https://cli.github.com/manual/gh_auth_login) | 공식 browser/device 흐름과 credential 관리 |
| [Supabase OAuth](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration) | 관리 통합·token 교환·secret 보관 경계 |
| [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) | 선택 CLI 경로와 런타임 요구사항 |
| [Vercel CLI](https://vercel.com/docs/cli) / [로그인](https://vercel.com/docs/cli/login) | 설치와 계정 인증을 구분 |
| [Homebrew](https://docs.brew.sh/Installation) | CLT·CPU별 설치 경로 등 선행 조건 |
| [ego lite](https://lite.ego.app/) | 선택 브라우저 자동화 보조 |

공식 서비스의 기능 설명은 구현 가능성의 근거다. 우리의 OAuth 통합, 자동 installer,
어댑터·복구 엔진이나 공개 TestFlight 승인이 이미 완성됐다는 증거는 아니다.
