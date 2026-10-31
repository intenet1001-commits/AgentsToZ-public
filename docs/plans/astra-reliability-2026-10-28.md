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
