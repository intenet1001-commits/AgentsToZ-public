# 커뮤니티 Viewer 목록·추가 안내 — 2026-11-02

상태: **발견 목록과 안내 동작 QA 구현 완료. Mac 간 실제 등록·연결·조작은 미완료.**
검증한 제품 소스는 `dffc32b990ae0360c1b622a37f998d9fdd47252e`, 브랜치는 `codex/remote-completion-20261101`이다.

## 변경

- 「Mac 추가…」가 안내를 여는 단계부터 물리 입력 증명을 요구해 Jump 입력을 거절하던 경로를 분리했다.
  목록 새로 고침·등록 안내·안내 닫기·취소·다시 찾기는 `PresentationButton`으로 처리한다.
  이 경로는 `HumanProof`를 만들지 않는다. 실제 등록 상대 선택·키 생성·코드 입력·연결은 기존 보호를 유지한다.
- 메인 앱의 기존 community-status 결과에서 자기 기기를 뺀 이름·불투명 참조·최근 응답 시각만 내보낸다.
  새 RPC나 사이드카 타이머가 없다. 계정 전환·회원 캐시 무효화 때 지우고 이전 계정의 늦은 응답은 내보내지 않는다.
- Viewer는 owner-only 정규 파일, 최대 32KiB·64기기·90초 유효기간을 확인한다. 링크·공유 권한·FIFO·만료·미지 필드를 거절한다.
  주소·키·권한·명령은 전달하지 않으며 같은 이름으로 기존 등록 Mac에 자동 결속하지 않는다.
- 커뮤니티 기기의 「화면 등록 안내…」는 이름을 참고 문구로만 쓴다. 참여는 화면 지원·등록·연결 성공의 증명이 아니다.

## 검증

| 소스 | 실제 결과 |
| --- | --- |
| `e5390a1f` 전체 `bun run verify` | exit 0. Python 138, TypeScript 0오류, Bun 10,317 pass / 12 skip / 0 fail, Rust 165 pass / 1 ignored / 0 fail |
| `e5390a1f` quick의 관련 essential-contracts | 409 pass / 0 fail, run `20261102T021219Z-d807e542`, source unchanged |
| `e5390a1f` 관련 페르소나 | remote-controller·low-vision-user PASS, run `20261102T021544Z-13834874` |
| 이후 Swift 안내 닫기만 바꾼 `dffc32b9` | `test:screen-control` 166/166, 전체 Swift 147/147, 관련 Bun 17/17 |

마지막 Swift-only 보완 뒤 전체 verify를 다시 실행하지 않았다. TypeScript·Rust 소스는 전체 verify 때와 같다.
새 AppKit 검사는 실제 창을 표시하지 않고 목록 생성·반복 레이아웃·안내 닫기를 실행하며,
등록 키를 만들지 않는 것과 보호된 선택의 프로그램 실행 거부를 확인한다. 실제 Jump 클릭 성공의 증거는 아니다.
커뮤니티 Mac 사용자 후보 `role-c2423b729373ffd6bd54`는 제안만 했고 활성화하지 않았다.

## 실제 QA 앱

- Viewer **0.0.2**, Developer ID 팀 `DA8QKAQ2C9`, 전용 H1 프로필.
- Apple 공증 **Accepted**: `c616f77f-839d-4b80-9e24-9516e18128dd`.
  스테이플·strict codesign·Gatekeeper를 양쪽에서 확인했다.
- 전달 ZIP SHA-256: `f5ce4744befa1993174ab3e505b4d63283f977d8efad5213fe5c29cbff9e24e5` — 양쪽 일치.
- 3호: `/private/tmp/agentstoz-viewer-community-final-20261102.r25Ltg/AgentsToZViewer.app`, 실행 확인 PID **40983**.
- 1호(`jumpremote`): `/private/tmp/agentstoz-viewer-community-final-20261102.Vb4CZG/AgentsToZViewer.app`, PID **26174**.
- `env -i open -n`으로 목록 앱만 열었다. 설치 앱을 교체하지 않았고 기존 QA 창도 강제로 닫지 않았다.
- 실제 MCP community-status에서 1호·2호·3호 참여를 확인하고 각 Mac에 다른 기기 2개를 **일회성** 발견 파일로 전달했다.
  기존 설치 사이드카는 아직 새 publisher를 포함하지 않는다. 파일이 만료된 뒤 새로 고침하면 최신 목록 없음 안내가 나올 수 있다.
  자동 갱신 기능을 설치본에서 검증한 것으로 보지 않는다.

## 남은 실기와 출시 조건

- CUA가 `AgentsToZ Viewer` 사용 승인이 없다고 거절했다. 이를 Jump나 다른 도구로 우회하지 않았다.
  실제 창의 목록·추가·닫기는 사용자의 확인을 기다린다. 실행 PID는 창의 표시나 버튼 성공의 증명이 아니다.
- 사람이 화면 세션을 시작하거나 생체·SAS 승인을 해야 한다. 에이전트는 시작하지 않았다.
- 받는 Screen은 여전히 기존 설치본(3호 1679, 1호 1646)이다. 이전에 만든 새 QA Screen도 아직 실행하지 않았다.
  기존 공개 상태는 3호 power off / devices 2, 1호 power on / devices 1, 모두 viewing false였다.
  공개 상태의 control=true는 Mac 컨트롤러 출시 관문 통과를 뜻하지 않는다.
- 최초 Mac 등록은 여전히 Bonjour/AWDL 근거리 방식이다. 커뮤니티 발견은 인터넷 최초 등록을 구현하지 않는다.
  3호의 1호 RFC1918 주소 접근 경로와 WARP 클라이언트 준비도 별도 필요하다. SSH overlay 연결 성공과 혼동하지 않는다.
- S-M3 입력 출처 보정은 미측정이며 Mac 조작 플래그와 push 관문을 열지 않았다. Mac App Attest는 문서상 미지원이다.
  이 관문을 풀거나 커뮤니티 이름을 등록 키로 신뢰하는 우회는 추가하지 않았다.
- 전체 브랜치에는 다른 AI 컴퓨터 유즈·에뮬레이터 변경도 있으므로 이 UI 수정만 보고 전체를 main에 병합·출하하지 않는다.

로컬 증거: `/Users/cs-work/forcs/AgentsToZ_byCS/tests/results/remote-continuation-20261102/community-viewer/state.json`과 같은 폴더의 로그.
프로필·QA 앱·증거는 공개 소스로 커밋하지 않는다. 운영 DB에 가짜 행을 쓰거나 RLS·TCC·키체인 권한을 바꾸지 않았다.
