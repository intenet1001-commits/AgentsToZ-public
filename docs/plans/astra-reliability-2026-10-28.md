# AgentsToZ 실패 기능 재검토 — 2026-10-28

사용자 요청: 컴퓨터 사용 등 이전 실패를 Astra로 개선하고, 최근 세션 카드의 Clear·Compact 누락을 확인한다.
현재 변경은 소스·개별 검사 단계이며 설치 앱의 전체 성공을 뜻하지 않는다.

## 수정

- 컴퓨터 사용: 버튼 내부 글자·이미지 좌표가 정확히 관찰한 부모 버튼에 연결되게 했다. 부모·자식·내용·보호 상태가 바뀌면 쓰기 전에 거절한다.
  모달/시트/보호 대화상자 검사를 관찰·캡처·동작에 추가했다. 종료된 도우미 연결이 옛 정상 응답 때문에 정상으로 보이던 UI를 수정했다.
- Orca: 설치 MCP에서 기존 팀원 출력의 실제 읽기에 성공했다. `EXTERNAL_HOST_RESTART_READ_ONLY`, `agentVerified:false`이므로 쓰기 권한 복원이나 Claude 신원 확인은 아니다.
  실패 원인별 진단과 settled 이후에도 미확정 전송·종료 결과를 막는 조건을 추가했다. 연결된 PTY만으로 idle이라고 추정하지 않는다.
- 세션 카드: Compact·Clear를 접지 않고 보인다. 정확히 연결한 Claude 워크룸만 기존 저장→동기화→고정 명령을 실행한다.
  Codex 앱은 원본 대화 열기와 직접 실행 안내를 제공한다. 내부 `compactThread` 존재와 외부 자동 실행 API 지원을 혼동하지 않는다.
- OPS 기억: 별도 비교/적용 화면과 로컬 앱 전용 route를 추가했다. 서버가 연결된 profileId·memoryId·root를 정하며 요청에서 경로를 받지 않는다.
  비교는 GET-only이고 apply는 사람이 검토한 버전의 CAS·기존 백업/리비전 보존을 사용한다. OPS 해결에 identity claim/schema repair를 실행하지 않도록
  strict `expectedMemoryId` 경로를 추가했다. JSON escape에 필요한 전송 한도를 문서 1MB 규칙과 맞췄으며 다른 관리 경로의 예산은 그대로다.

## 개별 검증

- 컴퓨터 사용: Swift 34개, Control core 25개, UI 상태 6개, Chromium/WebKit 두 화면 폭 4회 통과.
  독립 테스트 창의 캡처→좌표 클릭→결과 확인 10항목 통과(`productionGrantTested:false`). 첫 시도의 사람 활동 거절은 가드를 유지한 결과이며 우회하지 않았다.
- Dock: 단위 21개, Chromium/WebKit 두 화면 폭 84개 검사 통과. Codex 버튼은 자동 명령을 보내지 않고 원본 세션을 열도록 검사한다.
- 팀 연결: 관련 회귀 53개 통과. 설치 MCP의 기존 Orca 팀원 읽기도 확인했다. 새 지시나 권한 승인은 전송하지 않았다.
- OPS: 바뀐 ID·오래된 버전에서 GET 요청만 발생하고 config/원문이 변하지 않는 HTTP fixture, UI의 비교→사람 확인→적용 fixture,
  전용 Tauri 경로와 일반 관리 proxy 분리 검사를 추가했다. 실제 사용자 기억은 적용하지 않았다.

## 남은 경계

- 임의 캔버스 픽셀·드래그·단축키 주입과 Hermes 앱 인증 브리지는 미구현이다. 기존 창 결속·사람 우선·보호 표면 규칙을 해제해 구현으로 가장하지 않는다.
- Codex 앱의 자동 Compact/Clear는 현재 연결된 공개 도구에 없다. 활성 앱 대화를 다른 CLI writer로 재개해 조작하지 않는다.
- 다른 Mac 조회는 현재 연결 DB의 대화 마이그레이션 누락으로 실패한다. 실제 DB 변경은 하지 않았다.
- Control 설치·XPC 상호 인증·생체 승인·TCC 및 공증된 앱 설치 실기는 별도다. 아래의 독립 Control 공증 성공을 설치 앱 전체 동작의 증거로 대체하지 않는다.
- 운영 기억의 실제 충돌 해결은 새 비교 화면에서 사람이 선택해야 한다. 소스 변경만으로 이전 충돌이 해결되거나 세션 기억이 저장됐다고 하지 않는다.

전체 필수 검사·구성된 테스터 결과는 실제 실행 보고서에서 확인한다. 이 문서의 개별 검사는 해당 범위의 증거만 제공한다.

## 통합 검사 결과

- TypeScript 검사와 프론트엔드 빌드 통과. Rust 전체 139 pass, 1 ignored.
- 전체 Bun: 9,275 pass, 12 skip, 1 fail. `project-memory-correction-outcome.test.ts`의 300개 행/약 900회 내구성 쓰기 준비를 포함한
  예산 검사 한 건이 5초 제한을 넘었다. 소스·단언·시간제한 변경 없이 해당 검사 단독은 859.83ms, 파일 전체 33 pass(대상 1,016.54ms).
  지연 원인은 재현되지 않아 확정하지 않았다. 전체 `verify`는 실패이며, 제한적 재검사 통과와 별도로 기록한다.
- 일반 프로필의 관련 검사 3개를 각각 실행해 통과했다. 여러 `--check`를 한 명령에 쓰면 마지막 하나만 적용되므로 개별 실행했다.
  보고서: `20261028T064020Z-76b634c0`(기억 화면), `20261028T065320Z-1d9f3477`(네이티브 기반), `20261028T065512Z-79ee6952`(운영 기억 계약).
- 이번 변경에 관련된 구성 페르소나 3개(multi-session-maker, project-memory-user, shared-memory-curator), 실제 검사 24개 통과.
  보고서: `20261028T064151Z-2211228e`. 전체 16개 페르소나 실행이라고 표현하지 않는다.
- Control 산출물 `/private/tmp/agentstoz-astra-control-20261028/AgentsToZ Control.app`: release, Developer ID 서명,
  보안 타임스탬프 확인, notarizable true, notarized false. 설치·등록·TCC·생체 인증 검증은 하지 않았다.
- ego lite CS1 프로필의 App Store Connect는 로그인/계정 복구 단계다. 공증 자격 증명을 확인하거나 API 키를 생성하지 않았다.

이 최초 검사 시점에는 실패가 남아 있어 변경을 작업트리에 보존했다. 이후 전체 재검사 결과는 아래에 기록한다.

## chunsung 프로필과 실제 공증 확인

- 사용자 지시에 따라 ego lite의 정확한 `chunsung` 프로필(`Default`)을 사용했다. CS1과 달리 이미 Connect에 로그인되어 있었으며,
  계정의 Team ID `DA8QKAQ2C9`와 기존 Developer 권한 공증 키를 확인했다. 키 생성·폐기·권한 변경은 하지 않았다.
- 기존 `nhdesign-usher/scripts/release_notarized.sh`에서 키체인 프로필 `nhdesign-usher`를 찾았다.
  `bun check-macos-notary.ts --profile nhdesign-usher`는 `ready`, `data-protection-keychain`, exit 0을 반환했다.
  비밀 키를 추출하거나 복사하지 않고 기존 프로필을 그대로 사용했다.
- 최신 Control 소스를 release로 빌드하고 Developer ID 서명·보안 타임스탬프·Apple 공증·staple·validate·Gatekeeper를 통과했다.
  산출물: `/private/tmp/agentstoz-control-notarized-20261028/AgentsToZ Control.app`.
  제출 ID: `caf3c23f-c75b-46fb-ae74-fc3bf3af1f10`.
  영수증: 같은 폴더의 `AgentsToZ Control.notary-receipt.json` (`installed:false`).
- 첫 실행은 새 출력 폴더가 없어서 제출 전에 중단됐다. 폴더를 준비한 뒤 한 번 제출했으며 미확정 업로드를 재전송하지 않았다.
- 이 결과는 독립 Control 도우미에 해당한다. 메인 앱의 Developer ID 빌드, 설치, XPC·TCC·생체 승인 및 Hermes/Orca 연동 실기는 완료되지 않았다.
- 메인 빌드에도 명시적 `--developer-id --notary-profile NAME [--notary-keychain /absolute/path]`를 추가했다.
  기존 raw API 키 경로는 유지하며, 프로필을 선택하면 raw 키 파일을 읽거나 다른 계정으로 전환하지 않는다.
  컴파일 전과 제출 직전에 같은 프로필을 읽기 검증한다. 미확정 제출은 history 확인을 안내하고 재전송하지 않는다.
- 메인 빌드의 실제 `preflightDeveloperId({profile:'nhdesign-usher'})`가 동일 팀으로 통과했다. TypeScript 검사,
  관련 유닛 28개 및 `mac-distribution`의 배포 계약 검사 통과.
  보고서: `20261028T071726Z-e424a895`. 최초 `quick` 선택은 해당 검사 소속이 아니어서 실행 전에 거절되어 올바른 프로필로 실행했다.
- 현 카탈로그에 배포 담당자 페르소나가 없어 초안을 제출했으나 후보 예산이 가득 차 등록되지 않았다.
  기존 후보를 삭제하거나 자동 승인하지 않았다. 이 변경으로 새 페르소나가 활성화·통과했다고 표현하지 않는다.
- 이 범위 검사 당시에는 앞선 전체 `verify`의 시간제한 실패를 별도 미해결 기록으로 유지했으며, 범위 검사로 전체 통과를 대신하지 않았다.

## 전체 재검사 — 2026-10-28 16:35 KST 이후

- `bun run verify` exit 0. TypeScript 검사 통과, Bun **9,278 pass / 12 skip / 0 fail**(1,058개 파일, 913.12초),
  Rust **139 pass / 1 ignored / 0 fail**.
- 앞서 시간초과가 났던 예산 검사는 같은 전체 실행에서 **1,381.60ms**에 통과했다.
  단언·시간제한·준비 코드를 바꾸지 않았다. 이전 지연의 원인이 확정됐다는 뜻은 아니다.
- 전체 로그: `/private/tmp/agentstoz-terra-verify-20261028.log`.
- 이 결과도 설치 앱의 TCC·XPC·Hermes 실제 동작을 증명하지 않는다. 해당 실기 경계는 그대로 남아 있다.

## 격리된 메인 앱 빌드

- 원본 작업트리를 그대로 두고 관리 작업트리 `codex/reliability-notarization-20261028`에 검증된 40개 파일만 동일하게 복사했다.
  로컬 커밋 `a176d1ad`. 별도 진행 중인 Supabase 통합 문서는 포함하지 않았다. 원격 push는 하지 않았다.
- 이 Mac의 임시 CMake/Ninja는 pip target 설치여서 실행기 PATH만으로는 모듈을 찾지 못했다. 첫 빌드는 공증 전
  `ModuleNotFoundError: No module named 'cmake'`로 종료됐다. 기존 설치를 그대로 두고
  `PYTHONPATH=/private/tmp/agentstoz-cef-build-tools`를 지정해 CMake 3.31.6 / Ninja 1.11.1 실행을 확인한 뒤 재빌드했다.
- 재현 명령은 `PYTHONPATH=/private/tmp/agentstoz-cef-build-tools CEF_PATH=/private/tmp/agentstoz-cef-runtime-156 AGENTSTOZ_CARGO_TARGET_DIR=/private/tmp/agentstoz-terra-cargo-20261028 PATH="/private/tmp/agentstoz-cef-build-tools/bin:$PATH" bun build-macos.ts --embedded-browser --developer-id --notary-profile nhdesign-usher --allow-unpublished-source`.
  미공개 **로컬 테스트 패키지**이며 공식 설치·배포본으로 쓰지 않는다. 현재 설치 앱은 교체하지 않았다.
- 메인 앱 **1545.0.0** 빌드 exit 0. Apple 공증 Accepted (`cf231387-ea99-4b76-8500-8e6933593b28`),
  동봉 Screen과 메인 앱 티켓 부착·검증, Gatekeeper `source=Notarized Developer ID` 통과.
  영수증: `/private/tmp/agentstoz-terra-cargo-20261028/release/developer-id/receipt.json`.
- 해당 실제 패키지의 compiled sidecar를 빈 임시 HOME/data와 외부 네트워크 차단 환경에서 실행해
  최초 기동·권한 거절·프로젝트 생성·실제 프로세스 시작/정지·서버 재시작·재실행 **16개 검사 통과**.
  `/private/tmp/agentstoz-terra-fresh-profile-20261028/fresh-native-profile.json`.
  `freshOSUser:false`, `guiTested:false`이며 설치 Mac의 GUI·TCC·생체 승인을 검사한 것은 아니다.
- 비공개 origin 기본 브랜치는 `main`이다. 현재 로컬 빌드 커밋을 원격에 반영하지 않았으므로
  `--allow-unpublished-source` 패키지를 설치하지 않았다. 팀 스킬의 `Never push` 규칙에 따라 원격 반영 확인이 필요하다.

## 사용자 승인 후 공식 설치와 추가 실기 발견

- 사용자가 `a176d1ad`의 비공개 `origin/main` 반영과 공식 빌드·설치를 명시적으로 승인했다.
  일반 fast-forward push 성공 후 원격 HEAD 일치를 확인했다.
- 같은 커밋에서 출하 소스 가드를 통과해 공식 메인 앱 1545.0.0을 빌드했다. Apple 공증 Accepted
  (`55683161-f7ec-4c2a-a322-5a43cfb7fd43`), Screen·메인 앱 티켓 및 Gatekeeper 통과.
  공식 패키지의 빈 임시 프로필 sidecar 실제 실행 검사 16개도 통과했다.
- 설치 전 등록 프로젝트 50개와 OPS 모두 Workroom 세션 0개를 두 번 확인했다. 외부 Orca/Hermes 작업은 그 조회 범위가 아니다.
  로컬 설치기는 기존 앱을 `/Applications/.AgentsToZ_byCS-backups/AgentsToZ_byCS-1793174288956-39619.app`에 보존했다.
  설치된 GUI에서 `1545.0.0`, 소스 `a176d1ad`, 원격 기본 브랜치 검증 표시를 보았고, 새 앱의 자식 sidecar와 health를 확인했다.
- 설치 앱의 운영 기억 비교 화면에서 실제 로컬·원격 기록을 읽고 검토 전 적용 버튼이 비활성화되는 것을 확인했다.
  어느 기억도 적용·변경하지 않았다.
- 설치된 음성 독립 창의 최근 세션 패널에서 목록 새로고침 후 실제 세션 9개와 각 카드의 Compact·Clear 버튼을 확인했다.
  Codex 앱 세션은 두 버튼이 비활성화되고 원본 대화에서 직접 실행하라는 안내와 원본 열기 버튼이 표시된다.
  자동 Compact/Clear 실행 성공이나 Claude 실제 실행은 검증하지 않았다.
- 같은 소스의 Control 1545도 별도로 서명·공증·설치했으나 **실행에 실패했다**. Apple taskgated/AMFI는 `No matching profile found`로 거절했다.
  기존 프로파일의 DeveloperCertificates SHA-1은 `1BC39F06E7B56FD673B6528F7FA7045720679725`,
  실제 서명 인증서 SHA-1은 `C2219F84E1E1714E0DB78BF61799D9CFB80CB9B5`로 다르다.
  이는 강한 원인이며 다른 검증 문제의 부재까지 증명하지 않는다. 공증이나 Gatekeeper 통과를 실행 성공으로 취급하지 않는다.
- `chunsung` Apple Developer의 기존 Control 프로필을 직접 내려받아도 동일한 불일치였다. 기존 프로필은 유지하고
  Control의 기존 App ID와 이 Mac의 인증서를 선택한 새 Developer ID 프로필 발급 화면을 준비했다.
  현재 최종 발급은 사용자 확인을 기다린다. 인증서 원문·개인 키·비밀번호는 이 문서에 저장하지 않는다.
- 사전 검사에서 서명 인증서와 프로필 인증서의 불일치를 빌드·업로드 전에 거절하는 소스 수정을 별도 작업트리에 보존했다.
  실제 불일치 조합을 컴파일·공증 전에 거절했으며, 관련 테스트 31개·TypeScript·macOS 배포 계약 검사 통과.
  구성된 페르소나 전체 16개·실제 검사 74개도 통과했다(`20261028T080638Z-36a8dd2d`, source unchanged).
  이 추가 수정은 커밋·푸시·앱 반영하지 않았으며, Control XPC/TCC·Hermes/Orca 연동 성공은 별도다.
- 후속 조사: 설치된 Hermes 0.17.0은 ad-hoc 서명으로 팀 서명 신원을 제공하지 않는다. Hermes의 새 세션은 첫 입력 전까지 DB에
  남지 않아 생성 응답이 유실되면 경로나 제목으로 찾아 재전송할 수 없다. Electron main의 peer 인증·세션 결속과 durable 영수증을
  구현해야 하며 현재 일반 renderer 경로의 timeout 재전송을 팀 브리지에 그대로 재사용해서는 안 된다. 이 조사는 읽기 전용이며
  Hermes의 기존 사용자 수정·앱·세션을 변경하지 않았다.

## Control 프로필 수정과 실제 실행

- 사용자가 발급 진행을 확인해, 기존 Control 앱 ID와 이 Mac의 Developer ID 인증서가 결속된 새 프로필을 Apple에서 발급했다.
  공개 인증서 지문이 실제 서명 identity와 일치하는지 재확인했고, 기존 프로필은 변경하지 않았다.
- 비공개 `origin/main`에 반영된 Control native 소스를 일치 검사한 후 새 프로필로 Control 1545를 다시 서명·공증했다.
  Apple Accepted `8337de8f-3406-42b1-b5cd-d1902558f79b`, ticket 검증·Gatekeeper 통과.
  기존 Control은 `/Applications/.AgentsToZ-Control-backups/AgentsToZ Control-cf07909b9d0d4cb4b588ae0a43720f42.app`에 보존하고 원자적으로 교체했다.
- 설치된 Control 설정 창이 실제로 열렸으며, `백그라운드 실행 등록` 뒤 화면에서 `켜짐`을 확인했다. 실행 오류 163은 이 빌드에서 재현되지 않았다.
- 이 시점에 Control의 macOS 손쉬운 사용은 꺼져 있다. 메인·Control XPC와 승인된 창의 관찰·입력·캡처·클릭은 아직 검증되지 않았다.
  macOS 접근성·화면 기록 권한 승인과 별도 창 승인/Touch ID는 건너뛰지 않는다.
- 사전 인증서 일치 검사 수정 5개 파일은 해당 작업트리에 미커밋 상태다. 관련 31개 테스트, macOS 배포 계약, 전체 16 페르소나·74개 검사 통과.

## Control 권한과 창 승인 실기 후속

- 사용자의 명시적 승인과 macOS 인증 후 Control의 손쉬운 사용과 화면 기록 권한을 켰다. Control 설정에 손쉬운 사용 허용·백그라운드 실행 켜짐이 표시됐다.
- 설치된 메인 앱과 Control 사이의 실제 XPC 연결은 `ready`, 화면 캡처는 `supported`로 확인됐다. 이는 개별 창의 승인이나 조작 성공을 뜻하지 않는다.
- 별도 테스트 창이 화면 밖으로 판정된 경우 Control이 승인 버튼을 비활성화하는 것을 실제 확인했다. TextEdit 창의 정확한 Space는 확인하지 못했다.
- 테스트 전용 임시 창을 모든 Space에 표시하도록 준비해 다시 요청했고, Control의 승인 검토에서 정확한 테스트 창과 작업이 나타나며 승인 버튼이 활성화됐다. 화면 이미지 선택과 Touch ID 또는 로그인 암호 인증은 사용자가 직접 완료해야 한다. 승인 이후 관찰·입력·버튼·캡처·좌표 클릭은 아직 검증 전이다.
- 설치 앱 UI는 Hermes·Orca 제어 및 임의 캔버스 좌표·드래그·단축키를 지원하지 않는다고 명시한다. 구현·실기 통과로 보고하지 않는다.

## 1546 전면화 실패와 1547 실기

- 1546(`148b2699`)을 비공개 main에 반영했고 메인·Control을 서명·공증해 설치했다. 접근성·화면 기록 권한과 XPC 연결은 유지됐으나 승인 검토를 열 때 실제 전면 앱은 메인이었고 Control은 비활성이었다. 미확정 안내가 표시됐다. 창 존재만으로 전면 성공을 주장하지 않는다.
- macOS 협력 활성화 경로를 명시적 검토 요청에만 추가했다. 인증된 같은 XPC 연결의 peer PID·프로세스 세대·서명과 메인 앱 전면 상태를 확인한 뒤 메인 스레드에서 활성 상태를 양도하며, 시간 초과·사용자의 다른 앱 전환 시 실패로 처리한다. 검토 창 최소화 복원과 제한된 표시 확인도 추가했다. 생체 승인 및 창별 권한은 사람이 직접 처리한다.
- 1547(`1d0e560e`)을 비공개 main에 반영했고 메인 Apple 공증 `8c923c8e-cbf8-4a03-944b-07323e3a2fd9`, Control 공증 `4ba542f0-2668-46ce-a615-55ceeb2d0bb9`과 서명·스테이플 검증 뒤 설치했다. 기존 1546 앱과 Control 백업은 Applications의 각 백업 폴더에 보존했다.
- 최종 `bun run verify` exit 0: Bun 9284 pass, 12 skip, 0 fail; Rust 140 pass, 1 ignored, 0 fail. 16 페르소나의 74 검사 통과, 임시 프로필 검사 16개 통과(별도 GUI 테스트 아님).
- 설치된 1547의 테스트 승인 요청에서 Control이 macOS 실제 전면 앱이고 해당 승인 창이 on-screen이며 앞쪽 일반 창과 겹침이 0인 것을 확인했다. 직접 승인·Touch ID는 진행되지 않아 요청이 만료됐다. 따라서 승인 후 관찰·입력·캡처·클릭은 아직 검증되지 않았다.
- 사용자 프로필 회상은 revision 0·항목 0이었다. 공통 교훈은 OPS 운영 기억 후보로만 제출됐고 `saved:false`; 사용자 프로필 저장이나 OPS 후보 승인은 완료되지 않았다. 로컬·원격 운영 기억 충돌을 유지했다.

## 사용자가 직접 승인한 창 실기와 새 범위 요청

- 사용자가 앱 화면에서 승인 요청을 직접 다시 만들고 승인했다고 알려줬다. 따라서 후속 승인을 자동으로 연결한 것으로 기록하지 않는다.
- 같은 MCP 연결에서 실제 native grant가 반환됐고, 관찰·텍스트 입력이 성공했다. 접근성 버튼 및 캡처 이미지 좌표 버튼 선택의 native 영수증은 `dispatched-unverified`였으나, 후속 관찰의 `완료 1`/`완료 2`와 임시 fixture 결과 JSON의 정확한 입력값·클릭 수 2로 실제 결과를 별도로 확인했다. JPEG 창 캡처도 승인된 테스트 창만 반환했다. 이는 window v1 실기 성공이며 전체 Mac 제어의 증거는 아니다.
- 사용자는 제어판에서 한 번 동의하는 전체 Mac 제어와, 추가 옵션으로 Orca·Claude Code 등 특정 앱의 여러 창을 제어하는 기능을 요청했다. 기존 v1은 정확한 창·AX 동작만이므로 별도 v2 scope 서명/프로토콜·네이티브 화면/키보드/좌표 엔진을 구현 중이다. 아직 지원 광고·설치·전체 범위 실기 성공은 없다.


## Scope v2 implementation checkpoint — 2026-10-28

사용자 추가 요청: 창별 승인 외에 전체 Mac 및 Orca·Claude·Hermes 등 특정 실행 앱의 모든 창에 대한 별도 승인 옵션. 현재 reliability-notarization 워크트리에 TS host/protocol/서명/복구, Rust 채널, 새 MCP 도구(계약 1.66.0), native Control route/직접 인증 UI, SCK 캡처·CGEvent 입력을 구현했다. 기존 창 v1 동의는 확대되지 않는다.

집중 TS/MCP 검사와 typecheck, Chromium/WebKit 1100/390px UI fixture 통과. native Swift 55개 통과는 fake sink이며 실제 이벤트 전송이 아니다. 최종 보안 포커스 수정 이후 소스를 고정해 `verify` 프로필을 재시작했다. 설치·공증·새 범위 승인·실기는 아직 미완료.

AX generic container에서 실제 focused 비보안 자식 없이 key를 허용하는 변경은 자동 승인 심사가 숨겨진 비밀번호 입력 위험으로 거절했다. 우회 없이 실제 focused leaf 검증으로 보강했으므로 leaf 노출이 부족한 canvas 단축키는 거절될 수 있다. WindowServer 장식 예외는 실제 Apple 서명/프로세스 세대/SDK layer/제목·위치·크기를 함께 확인하며 입력 대상은 계속 제외한다. IOConsoleLocked는 공개 SDK 안정성 보장이 아닌 XNU diagnostic key이며 부재/비Boolean/GUI세션미확인은 거절한다.

실기 fixture A는 두 창으로 준비되고 CUA에서 열렸으며 입력은 아직 보내지 않았다. 추가 fixture B는 CUA 접근 승인이 거절돼 다른 경로로 재시도하지 않는다. 수동으로 열고 승인했던 이전 v1 실기의 출처는 계속 구분한다.


## Scope v1548 published and installed — 2026-10-28

비공개 origin/main에 `6bf0463766dfed2d214af5087deb1c9381ce074c` 반영, main/Control 모두 1548.0.0으로 공식 서명·공증·staple 검증 뒤 설치했다. main 공증 `4e23f7f6-af54-45ab-88db-92f8c3ab9c38`, Control 공증 `5f9b00b8-3a69-458b-8476-bc8bf29c5ed2`. 기존 1547은 각 /Applications 숨김 backup 폴더의 pre-1548-scoped.app으로 보존했다.

최종 정상 프로필: 20261028T130132Z-8f5919ce, sourceUnchanged=true. Bun 9301 pass/12 skip/0 fail, Rust 142 pass/1 ignored/0 fail. 최초 전체 검사에서 MCP 도구 목록 회귀 1건이 새 도구를 누락한 것을 수정하고 전체 재실행 통과. 페르소나 20261028T131804Z-f43f62f1: 16역할/74검사 통과, sourceUnchanged=true. Swift 55개 fake sink 통과, 임시 HOME 패키지 검사16개 통과(실제 새 OS 사용자 아님).

실제 설치본에서 버전·소스, v2 helper 연결, 전체 Mac/선택한 앱/한 창 라디오, 실제 native 앱 목록의 Orca·Hermes와 Orca 선택 반영을 확인했다. 아직 새 v2 사람 승인을 만들지 않았고, 실제 v2 캡처·좌표·키보드·HID 동작 성공은 미검증이다. AI 연결 목록은 현재 비어 있다.

사용자가 MCP 승인 요청을 허용했다고 답한 직후 get_control_profile을 한 번 재호출했으나 도구가 여전히 `MCP tool call requires approval, but approval policy is never`로 거절했다. 현재 도구 목록에는 기존 computer만 있고 새 computer_session은 없다. Codex 자체 CUA 조작도 safety reasons로 거절됐다. 다른 경로로 이 차단을 우회하지 않았다. 새 턴에서 실제 호스트 승인 정책과 1.66.0 MCP 연결 반영을 먼저 확인해야 한다. 사용자에게 같은 설정 변경을 반복 요구하지 않는다. 공식 MCP pilot 스크립트는 임시 폴더에 준비만 했고 실행하지 않았다.
