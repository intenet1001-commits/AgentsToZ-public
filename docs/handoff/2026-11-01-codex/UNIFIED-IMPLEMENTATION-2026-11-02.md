# 일괄 등록·공통 인증·Cloudflare 통합 구현 진행

2026-11-03 후속 기록. **이 문서는 전체 완료·최신 앱 설치·실기 통과 영수증이 아니다.**

정본 설계: [통합 등록·통신](../../design/mac-to-mac-2026-11-01/UNIFIED-ENROLLMENT-AND-TRANSPORT.md), [모바일 비화면 제어 v2](../../design/mac-to-mac-2026-11-01/MOBILE-CONTROL-V2.md).

## 이어받을 위치

- 현재 통합 worktree: `/Users/cs-work/.codex/worktrees/community-unified-release/AgentsToZ_byCS`.
- branch: `codex/community-unified-release-20261102`.
- 이전 `community-auth-policy` worktree는 보존본이다. 새 통합 HEAD로 오인하지 않는다.
- 사용자가 내부 Codex 보조 3개·현재 설정 상속을 선택했다. 각자 별도 worktree에서 UI·Native·CF를 구현했고 부모가 커밋을 명시적으로 통합했다.
- main `9f94277c`의 기존 기억 관계·설정 기능과 3-way 통합했다. MCP 계약은 양쪽 기능을 보존한 `1.80.0`이다.
- 기억 정본은 `/Users/cs-work/forcs/AgentsToZ_byCS/.agent-memory/`다. 이 worktree에 새 기억 정본을 만들지 않는다.
- 재개할 때 `git status`와 HEAD를 확인한다. 로그·서명 산출물은 무시된 `.agentstoz/maintainer/manual/`에 두며 마지막 검증 소스와 현재 HEAD를 대조한다.

## 통합한 구현

1. 최초 관리자 등록 응답 유실 복구, 코드 대조, 목적별 일괄 선택, 실제 Main portal ID와 Screen 기기 ID·Control 공개키의 분리 결속.
2. CF v2 의도/검토/승인/영수증, 고정 issuer 검증, Desktop 지속 운영키, Mobile RAM 사용키·사람 활동 기준 유휴60분·90초 lease.
3. 별도 Screen protocol6과 CF WSS 다중 채널. phone4/Mac5 기존 bytes와 저장소는 유지하고 자동 downgrade하지 않는다.
4. Viewer 일반 재연결은 반복 BIO 없이 현재 공통 신뢰로 준비한다. 사람의 Viewer 시작·입력 경계와 로컬 hold·OS·push·calibration 관문은 보존한다.
5. Native Main↔Viewer 관리 경로와 Main↔Control 감사된 private link, 목적별 typed 서명. 서로 다른 네이티브 소유자의 개인키는 합치지 않는다.
6. Desktop Agent·Teams 실제 CF 전송, 양쪽 Native 증명·키 확인, bounded queue와 암호화 실행 장부. 미확정 요청을 DB 경로로 다시 보내지 않는다.
7. 실제 Remote Teams 수신 소비·프로젝트 default-none/CAS 허용 목록, Native 수신 끄기/차단 복구를 중앙 권한관리 화면에 연결했다.
8. 모바일은 별도 `mobile-agent`, `mobile-teams`, `mobile-agent-settings`, `mobile-browser`와 typed component-session 조회를 사용한다. Desktop agent v1과 섞지 않는다.
9. 모바일 실제 Swift carrier/client/UI·기기 선택·원래 작업 journal과 TS receiving Host를 연결했다. OPS는 실제 등록한 OPS worker에, Teams는 실제 project allowlist에, 설정은 기존 CLI 정책에, 브라우저는 기존 owned context와 observation/epoch에 결속한다.
10. 수신 장부는 별도 로컬 data key와 현재 Native 기기 namespace에 결속한다. 처음 등록한 Mac도 기존 대화 endpoint를 켜지 않고 준비하며, 원장·준비 이력이 있는데 키가 유실되면 재생성하지 않는다. 원래 요청 UUIDv7·시간·내용·결과 digest를 보존하며 unknown은 실행하지 않고 원래 backend receipt만 회수한다.
11. 최초 미등록은 같은 수신기가 등록 뒤 준비하고, 이미 고정한 Native revision/key epoch 변경은 기존 수신기를 닫고 새 lineage로 시작한다. 작업을 복제하지 않는다.
12. 독립 OPS 작업 권한과 모바일 설정 권한을 분리했다. 원래 모바일 episode 종료는 자동 에포트 변경을 닫지만, 별도 작업 권한이 유효한 이미 접수된 OPS는 실행 전 기본 설정으로 1회 계획할 수 있다. 노출 뒤 재실행은 없다.
13. 서명 전 공개 설정 입력은 정확한 세 필드 `origin`, `issuerPublicKey`, `profileId`만 받는다. Main·Screen·Viewer·Control의 signed Info 설정과 실제 iOS 서명 조립을 함께 점검한다. runtime env·UserDefaults·health 응답을 새 신뢰점으로 쓰지 않는다.
14. 기존 H10 push 주소는 authority와 별개다. Main의 Screen 빌드는 명시 빌드 환경 `AGENTSTOZ_SCREEN_PUSH_URL`, iOS build-only는 `--push-endpoint`로 서명 전에 봉인한다. iOS는 실제 APS entitlement·프로필·AppGroup도 검증한다. 공통 v6 연결은 실제 admission의 키·기기 종류·이름을 기존 H10 형식으로 투영해 현재 owner phones에 알리며 가짜 legacy 등록을 만들지 않는다.

## 이미 확인한 부분과 한계

- 보조 고정 소스에서 Swift 실제 URLSession HTTP/WebSocket → 격리 workerd/SQLite relay → 실제 TS 수신 Host의 네 목적 handshake·키 확인·1회 효과·원래 결과·consumed ACK가 통과했다. 사람 화면·운영 키·실제 Mac 입력을 사용하지 않았다.
- 부모 통합 브랜치의 focused OPS/소비/Host/race 회귀와 타입 검사를 실행했다. 이후 변경이 있으면 그 수치를 최종 검증으로 재사용하지 않는다.
- 고정 `23babaad`의 전체 검증은 Python·TS 뒤 Bun10542 pass/12 skip/5 fail로 끝나 Rust에 도달하지 않았다. 실패는 public-config 검사 cwd 경로, iOS probe 목록 누락, 이전 UI 문구, 이전 OPS 호출 소스 단언, synthetic runtime child 조기 종료였다. 앞의 네 건을 고쳤고 마지막은 ready/state 원자 발행과 bounded 진단을 보강했다. 조기 종료의 실제 원인은 단정하지 않으며 최종 전체 재검증이 필요하다.
- 같은 `23babaad`에서 정상 mobile-workroom은 essential-contracts의 cwd 결함 외 검사를 통과했다. 실제 격리 workerd v1/v2 registry·WS·네 모바일 목적·180KB 응답·원래 영수증·outbound0도 확인했다. 이후 소스의 전체 통과로 대신 쓰지 않는다.
- 예전 `40f3c515`의 full verify는 Python138·TS 통과, Bun10394 pass/12 skip/1 obsolete-schema fail였다. 해당 단언은 수정했다. 예전 `87f` Rust169 pass/1 ignored와 `3806` ios-core pass도 최신 전체 검증은 아니다.
- 최종 `bun run verify`, 정상 `mobile-workroom` profile, configured personas의 동일 소스 결과를 반드시 새로 확인한다. tester ensure는 이번 세션에서 한 번 ready 확인했으므로 중복 호출하지 않는다.
- `8fd07ebf`의 단일 전체 verify도 exit0: Python138, TS0오류, Bun10549 pass/12 skip/0 fail, Cargo169 pass/1 ignored/0 fail이다. 전후 HEAD·dirty는 불변이다. 같은 소스의 정상 profile12개와 configured personas16명(실제 증거75개)도 각각 단일 실행으로 모두 통과했다. 영수증은 등록 root 밖 `unified-verify-20261103-c560/wt/.agentstoz/maintainer/manual/final-verify-8fd07ebf.receipt.json`과 `8fd-verification-receipt.json`이다. 뒤의 소스 수정까지 통과했다고 재사용하지 않는다.
- `8fd07ebf`를 로컬 main으로 fast-forward한 뒤 실제 append-public-history dry-run은 테스트5파일의 Supabase 형식 URL 때문에 중단됐다. push는 하지 않았다. 거절 테스트의 운영 참조4개는 기존 `PRODUCTION_SUPABASE_REFS`의 ref-only 값으로 검사하고, 일반 외부 origin7개는 예약 `.invalid` 주소로 바꾼다. 운영 URL을 조합해 숨기거나 publisher·production guard·CSP·network fence를 완화하지 않는다. 주소 정리 뒤 공개 스캔과 최종 소스 검증을 다시 실행한다.
- 설치 전 read-only 점검에서 Main startup가 실행 중인 Screen을 자동 TERM·교체하고, 별도 QA 인스턴스를 정확한 설치본 실행과 혼동할 수 있음을 발견했다. C의 `6b1265e5`를 `b4f9b3f6`으로 통합해 실행 중 업데이트를 대기시키고 자동 종료·재실행을 막았다. 다른 위치 인스턴스와 관측 불가 상태는 설치·열기를 거절하는 음성 조건으로만 사용한다. 키·승인·실행 중 QA를 자동 정리하지 않는다. C의 외부 사본 집중 mock Rust44개는 통과했고, 실제 서명·plutil 시험2개는 이 집중 실행에서 명시적으로 제외했다.
- A의 `619611a0`와 `e9e72900`를 `5d5beca0`·`5eb887ea`로 통합했다. 두 진입 화면은 Screen 업데이트 대기와 Screen/Viewer의 다른 인스턴스·관측 불가를 표시하고, 최초 조회 실패에도 해당 항목을 숨기지 않는다. 이전 상태의 준비 표시·동작은 실패 때 닫고 기존5초 조회의 새 성공으로 회복한다. 읽기 발행만으로 성공을 추정하지 않으며, R2 대기 중 R1 실패도 반영한다. 더 새 완료 응답·unmount 이후의 낡은 응답은 무효화한다. A의 최종 단위16개·타입 검사·실제 component의 mock Chromium/WebKit 렌더가 통과했고 C가 읽기 재검토했다. 실제 OS·Viewer 세션 성공은 이 범위에 없다.
- 주소 정리 `774dcea3`의 타입 검사는 통과했다. `.codex` 사본에서 실행한 집중 검사는 sandbox의 해당 폴더 read-deny로5건 실패했으며 보존했다. 보호 규칙을 바꾸지 않고 루트 밖의 정확한 같은 소스 사본에서161개 모두 통과했다. canonical local main의 append-public-history dry-run도3936파일 비밀값 없음·exit0이며 실제 push는 하지 않았다. 같은 소스의 실제 sidecar staging과 embedded-browser Cargo check도 exit0으로 확인했지만 이는 캐시·빌드 전제 확인이며 최종 앱 빌드·설치가 아니다.
- `c560c76f` 고정 소스의 실제 전체 verify는 exit0: Python138, TS0오류, Bun10549 pass/12 skip/0 fail, Cargo169 pass/1 ignored/0 fail이다. 전후 HEAD·dirty 불변 영수증은 등록 root 밖 `unified-verify-20261103-c560/wt/.agentstoz/maintainer/manual/`에 있다. 정상 profile도12 checks 모두 통과했다.
- 같은 소스의 최초 persona는13 PASS/3 FAIL였다. 공통 synthetic installer check의5초 시간 초과는 정확 check 재실행과3역할 재검증에서 통과했고, cautious-sync·runtime-terminal은 PASS로 확인했다. first-time은 별도 helpdesk fixture의 PID 준비 전2초 timeout으로 FAIL였다. 실제 production spawn·2000ms/TERM→KILL100ms/300ms wall 회귀는 유지하고 test-only positive PID·owned PG 준비 장벽을 추가했다. 이 수정 뒤 최종 소스 검증 결과는 별도로 확인한다.
- `c560c76f`의 정본 git archive는4194파일을 대조했다(명시된 Windows eol export 변환 포함). 기능9레인+preflight 통과/실패0, 미구현2 skip·별도조건1 unmet으로 all exit4다. main 비교는 미측정, index gitHead unknown을 그대로 보존했다. 앞전 clone 실행의 `.git` 거절·main 차이 FAIL도 지우지 않았다.
- CF 운영 Worker는 `c560c76f`로 갱신해 버전 `b887da1d-53e1-48c3-b1b8-97d8f788bc12` 100%를 확인했다. issuer fingerprint·REGISTRY/RELAY namespace·v2 migration·비밀 이름5개를 전후 대조해 보존했고 health200을 확인했다. 비밀 값·개별 회원 원문은 읽지 않았다. APNs 등록 알림용 secret은 아직 없으며 실기 성공을 뜻하지 않는다.
- CF DO migration 뒤에는 pre-v2 Worker로 rollback하지 않는다. 보존한 recovery branch `codex/community-cf-recovery`의 `a691f036`은 같은 v2 binding/class를 유지하는 roll-forward fallback이다.
- QA0.1.1은 소스 `8d248416`의 과거 산출물이다. Mac 세 앱은 공증·staple됐지만 설치/실행하지 않았으며, 새 기능의 최종 앱으로 재사용하지 않는다.
- 현재 설치 Main1679는 새 private bridge를 제공하지 않는다. helper만 교체해서 일괄 기능이 된다고 보고하면 안 된다.
- `c560c76f`의 Control2117은 실제 서명·공증 Accepted(`7ea65022-af9d-49b8-b18b-8a53f44176cb`)·staple·Gatekeeper 검증을 마쳤고 미설치다. 같은 소스 InputProbe도 빌드만 했고 실행·보정하지 않았다.
- 기존 설치 Screen에는 H10 주소가 있으나 보존 QA0.1.1 Screen은 없고 iOS는 빈 값이었다. 현재 로컬 TestFlight-ID 개발 프로필에는 APS entitlement가 없어 push-enabled iPad 서명에는 프로필 갱신이 필요하다. Apple Developer 로그인은 사용자 단계로 넘겼고, APNs 실수신·원격 중단 성공은 아직 확인하지 않았다.
- `23babaad`에서 공개 authority를 봉인한 iPad 개발용 앱의 실제 서명은 확인했지만 push OFF·미설치 산출물이다. 새 push 옵션을 포함한 최종 signed 앱 또는 TestFlight 배포 성공으로 보고하지 않는다.
- MCP 충돌 점검의 실제 live origin/main9f94277c는1.76.0, publish/main e598aeea는1.75.0이었다. 후보1.80.0은 충돌하지 않는다. build 숫자는 계약 minor나 schema 호환성을 대신하지 않으며 새 도구를 쓰려면 MCP 프로세스 재연결도 필요하다.

## 남은 순서

1. 마지막 검토 수정과 iOS signed configuration 조립을 통합하고 모든 source를 커밋한다.
2. 등록 root 밖의 고정 소스 사본에서 기존 sandbox 경계를 유지하며 전체 verify·정상 profile·personas·필요 에뮬레이터를 재실행한다. 누락 catalog·skip·blocked·fail을 pass로 세지 않는다.
3. source/publication 검사와 실제 원격 기본 HEAD guard를 만족한 뒤 같은 소스로 Main·Screen·Viewer·Control·iOS를 서명·검증한다. 공식 Main에 unpublished override를 써 설치하지 않는다. 설치된 내장 브라우저 형태를 보존한다.
4. 필요한 경우 기존 계정·이름·키·멤버를 보존하며 최신 Worker를 배포하고 정확한 version/issuer/namespace를 확인한다. 일부 membership/discovery·데이터 적재는 여전히 DB를 사용하므로 모든 네트워크가 CF라고 주장하지 않는다.
5. 사람 단계가 준비되면 한 번에 안내한다. OS/BIO와 S-M3의 실제 하드웨어·가상 HID·원격 주입 구분 실측, 사람이 시작한 Mac1↔Mac3/iPad5G 보기·클릭·스크롤·전환·종료·폐기·재시작을 구분해 기록한다.
6. S-M3의 표본 JSON은 언제나 `certifiesCalibration:false`다. 판독·보정·벡터·빌드 관문을 별도로 결정하고 새 소스를 검증·서명한 뒤에만 Mac 양방향 조작 실기를 진행한다. 그 전 빌드는 보기·거절 확인 범위다.

## 유지할 안전 경계

- SR-23에 따라 AI는 사람 Viewer 세션을 시작하거나 조작하지 않는다. Jump/CLI/AppleScript 등으로 우회하지 않는다.
- S-M3는 아직 미측정이므로 Mac control gate는 OFF다. InputProbe 컴파일이나 소프트웨어 테스트는 calibration 인증이 아니며 보고서는 `certifiesCalibration:false`다.
- OS·BIO·TCC·Keychain 프롬프트는 사람만 처리한다. sudo나 권한 초기화를 쓰지 않는다.
- 격리 검사는 임시 loopback 포트만 쓰며 설치 앱3001/52741/4723과 운영 Supabase를 시험 대상으로 삼지 않는다.
- 설치 Main의 정확한 감사 신원을 fake app·symlink·동시 실행으로 대신하지 않는다. active Main·Workroom을 임의 종료하지 않는다.
- 미확정 작업·실행 장부·기존 키·일괄 등록 상태를 지우거나 새 ID로 자동 재접수하지 않는다.
- 최종 보고는 실제 검증 소스·앱·배포·물리 기기 범위를 각각 표시한다. 물리 단계를 남긴 채 전체 완성으로 보고하지 않는다.
