# 대화 복원 첫 구현 기록

2026-10-13 · `codex/workroom-conversation-recovery` · 기준 소스 `8711599f3c928437063a80d3744d36a2cc734db3`

[설계](DESIGN.md)의 A+B를 독립 worktree에 구현했다. 제품 코드와 격리 테스트의 기록이며, 설치 앱에 반영하거나 실제 Codex/Claude 계정으로 재개한 출하 검증은 아니다. 원래 checkout의 기존 파일과 운영 세션은 유지했다.

## 구현한 동작

- 이 기기의 `대화 세션`에 `저장된 대화`를 추가했다. 사용자 제목, 보관함, 페이지 이동과 현재 페이지 검색을 제공한다. 기존 `현재 터미널` 목록은 계속 사용할 수 있다. 원격 기기의 저장 기록은 새로 공개하지 않는다.
- 시작과 종료를 계정 전용 app-data의 `workroom-history-v1/history.sqlite`에 기록한다. 논리 대화 ID와 실제 PTY 구간 ID를 분리한다. 검증된 기존 `다시 시작`도 같은 논리 ID로 연결한다. 보관은 실행 종료나 provider 원본 삭제를 수행하지 않는다.
- 프로세스 재시작은 metadata만 복원한다. 예전 `running`은 `detached`, 준비 중 재개 영수증은 `unknown`으로 분류한다. 목록 조회나 페이지 새로고침은 CLI를 시작하거나 프롬프트를 보내지 않는다.
- Mac의 Claude/Codex `이어 열기`는 한 번의 사용자 클릭 안에서 검토 → 영속 예약 → 실행을 수행한다. 원래 target, canonical checkout/Git identity, CLI 계정 설정, 저장된 user turn과 provider ID를 재검증한다. 처음 입력했던 요청을 재전송하지 않는다. 새 재개는 CLI 기본 승인 설정을 사용하며 과거의 임시 승인 우회를 저장하지 않는다.
- 같은 request ID는 같은 결과를 공유한다. 일반 terminal 시작과 다른 재개 대상은 같은 ID의 결과를 가져올 수 없다. 다른 ID의 동시 재개는 revision과 pending 예약으로 하나만 허용한다. 실행 직전 await 이후에도 account/target을 다시 검사한다. 실행 시작 후 crash·응답 유실은 결과 확인 대상으로 남고 자동 실행을 반복하지 않는다.
- Claude의 시작 ID는 아직 user turn을 확인하지 못해도 미확인 상태로 보존한다. 최초 관측 전 강제 종료가 발생해도 다음 부팅의 명시 검토에서 그 ID의 저장 파일을 확인할 수 있다. ID가 있다는 사실만으로 재개를 승인하지 않는다.
- 브라우저 sessionStorage에는 저장소 ID·논리 대화 ID·요청 ID만 보존한다. 재개 응답이 끊기거나 페이지가 새로고침되면 같은 영수증의 상태만 조회한다. `not-recorded`도 곧바로 재전송하지 않으며 사용자의 새 검토가 이전 검토를 무효화한다.
- DB의 권한·소유 inode·schema를 검증하고, 손상이나 미래 schema에서 빈 DB로 대체하지 않는다. 제목·표시 metadata·digest·호스트 내부 provider ID만 저장한다. 원문 대화, terminal 출력, 프롬프트, credential, 환경변수와 실제 경로는 새 DB에 넣지 않는다. Supabase 동기화도 추가하지 않았다.
- 제한된 duty 실행은 저장된 사용자 대화 목록에서 제외한다. 기존 raw terminal protocol과 remote scopes는 유지한다.

## 연결과 예산

| 영역 | 첫 구현 계약 |
| --- | --- |
| 관리 API | exact `POST /api/agent-runtime/terminals/history`, query 금지, 기존 Agent Runtime capability·origin gate |
| Operations | `list`, `rename`, `archive`, `unarchive`, `resume.review`, `resume.execute`, `resume.status` |
| Metadata 변경 | expectedRevision·requestId·intent digest, 중복 토글 금지 |
| SQLite | FULL synchronous, DELETE journal, cache 2 MiB, busy wait 100ms, short transaction 밖에서 provider 검사·CLI 실행 |
| 목록 | keyset 50행, 원본 기록을 자동 축출하지 않음 |
| 바인딩 수집 | 목록당 최대4회·세션별15초 cache, cache32개, 정상 종료/앱 종료 시 강제 확인 |
| Provider 증거 | 파일 head 최대4 MiB, Codex metadata head256 KiB. bounded directory 순회이며 상한 도달은 미확인 |
| 검토 | 최대64개,60초. 새 검토는 같은 대화의 이전 검토를 무효화 |
| 요청 본문 | streaming8,192 bytes 상한, unknown keys 거부 |
| 화면 | 보일 때15초 조회, 한 페이지50행, 숨김/unmount 후 늦은 목록 응답 무시 |
| 브라우저 영수증 | 최대32개,20,000자 cache 읽기 상한. 읽기/쓰기 실패 때 실행 재전송 금지 |

## 검증 기록

- Project tester ensure: 주 checkout에서 이 세션에 한 번 호출, `ready`.
- 변경 후 quick profile:9개 검사 통과. 보고서 `.agentstoz/maintainer/runs/20261013T125506Z-68175d08/report.md`.
- 신규 backend/client 회귀:21개 통과. 실제 SQLite 재개장과 terminal service 재생성, 최초 관측 전 Claude 강제 종료, 준비 영수증의 crash 복구, 같은/다른 ID 동시 재개, trusted resume intent의 ID 충돌, 검토 만료/대체, 계정·checkout 교체, 실제 열린 provider 파일의 충돌, duty 제외·Windows cold resume 차단, future schema·symlink, page cursor, provider cwd/user turn, 응답 DTO·browser cache·streaming 상한을 검증했다. 요청 ID 충돌은 먼저 실패를 재현한 뒤 수정했다.
- 기존 terminal/restart/resume/directory 계약:80개 통과한 범위가 있다. 최종 변경은 아래 전체 verify로 다시 확인한다.
- 실제 격리 sidecar의 새 history 관리 경로: 잘못된 capability·origin·GET/query를 거부하고, 올바른 요청만 metadata DB를 생성하는 검사 통과. 원격용 terminal API로 history operation을 실행할 수 없다.
- 신규 React 화면:1280px·390px에서 제목 변경, 보관/복원, 두 번 클릭, 재개 응답 유실, reload, unknown→completed 상태 조회와 동일 실행 열기 통과. 전체 흐름에서 execute 전송1회, status 조회2회. 추가 API나 외부 origin 요청 없음.
- 기존 세션 목록 React 화면:1280px·390px에서 기기 소유자, 초안 유지, 대기 요청, 종료 출력, 팝업 실패 fallback, 저장 제목의 실제 child session 결속, 숨김 polling과 가로 overflow 회귀 통과. 다른 세션 탭에 저장 제목을 적용하지 않는다.
- 전체 `bun run verify`: Python85개·타입 검사·Bun6,325개·Rust74개 통과,0 fail. 최종 로그 `.agentstoz/maintainer/workroom-recovery-verify-final.log`. 마지막 화면 변경과 journal 변경 후 별도 타입 검사·해당 회귀도 다시 통과했다. Rust의 기존 unused/dead-code 경고는 남아 있다.

브라우저와 provider 증거는 합성 fixture다. 실제 유료 AI 요청이나 설치 앱/휴대폰 동작의 성공으로 해석하지 않는다.

## 실제 설치 pilot과 후속 범위

1. 격리 등록 프로젝트에서 실제 Claude/Codex user turn을 완료하고 앱을 종료한 뒤, 동일 논리 ID·제목 유지와 명시 재개를 확인한다. 기존 기능 이전에 끝난 대화를 전부 backfill하는 기능은 없다.
2. 기존 작업이 없는 pilot 환경에서 provider lock/rollout 수집과 실제 shutdown 저장 순서를 확인한다. 외부 CLI 충돌 검사는 lsof 시점의 열린 파일을 보수적으로 검사한다. 임의 외부 CLI와의 원자적 writer exclusion을 보장하지 않는다.
3. OAuth credential 파일의 metadata가 refresh/재로그인으로 바뀌어도 첫 구현은 계정 설정 변경으로 보고 재개를 막을 수 있다. 안정된 provider account identity를 확인하지 않고 과거 binding을 새 설정에 자동 재결속하지 않는다.
4. crash 뒤 `unknown`은 자동 해제하지 않는다. 시작된 CLI의 정확한 증거로 영수증을 확정하는 별도 복구 UX가 후속 과제다. 영수증 조회 성공을 provider turn 시작/완료로 표시하지 않는다.
5. Mac cold resume만 지원한다. Windows의 metadata/list와 기존 terminal은 유지하지만, 실제 Windows PC 검증 전 cold resume는 허용하지 않는다. Hermes/agy는 metadata·현재 터미널 보기 범위다.
6. C(긴 입력의 완전한 준비·전달 영수증·writer lease), D(원격 history scopes·재연결), E(semantic events·암호화 초안·대기열)는 후속 구현이다. 첫 단계는 PTY와 semantic runtime의 영속 대화를 자동 병합하지 않는다.

REA에서 확인한 ChatGPT 정적 구조는 설계 참고 자료다. 현재 코드와 테스트로 ChatGPT보다 성능이나 안정성이 우수하다고 판정하지 않았다.
