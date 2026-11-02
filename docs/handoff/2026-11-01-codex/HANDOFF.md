# 인수인계서 — Mac 간 AI 컴퓨터 유즈 · Mac 뷰어 · 플로팅 세션 바 · 에뮬레이터 테스트 (2026-11-01, Claude → Codex)

> 11-02 21시 이후 일괄 등록·공통 인증·CF 통합 구현의 보존 위치·실제 검증 범위·현재 미완료는 [UNIFIED-IMPLEMENTATION-2026-11-02.md](UNIFIED-IMPLEMENTATION-2026-11-02.md)를 먼저 확인한다. 전체 완료나 실기 성공 기록이 아니다.

> 2026-11-02 후속 소스와 실제 재검증·미완료 상태는 [CONTINUATION-2026-11-02.md](CONTINUATION-2026-11-02.md)를 먼저 함께 확인한다.
> 아래 상태표는 최초 인수인계 당시의 기록이다. 5G 실기 성공 또는 전체 완성을 의미하지 않는다.
> 최신 커뮤니티 목록·추가 안내 수정, QA 0.0.2 공증과 검증 범위는 [COMMUNITY-VIEWER-2026-11-02.md](COMMUNITY-VIEWER-2026-11-02.md)를 먼저 확인한다.
> 사용자 스크린샷 후 안내 흐름·12초 검색·QA 0.0.4 개선은 [VIEWER-GUIDANCE-2026-11-02.md](VIEWER-GUIDANCE-2026-11-02.md)가 최신이다.
> 11-02 저녁 사용자의 일괄 등록·Desktop 지속 신뢰·Mobile 유휴60분·Cloudflare 통신 통합 요구는 [통합 등록·통신 설계](../../design/mac-to-mac-2026-11-01/UNIFIED-ENROLLMENT-AND-TRANSPORT.md)를 먼저 확인한다. 설계 반영이며 기존 안전 관문의 구현 해제나 새 검증 통과를 뜻하지 않는다. 재시작 후 임시 소스/로그 보존 한계도 그 문서10절에 기록했다.

Claude 세션이 주간 사용 한도(90%)에 다가가서 2026-11-01에 멈췄다. 이 문서 하나만 읽으면 **놓치는 것 없이 이어서** 끝낼 수
있게 썼다. 각 작업의 에이전트 원문 보고서(리뷰 지적·검증 숫자·남은 항목)는 `reports/`에 그대로 있다. 이 문서는 그 색인이자
순서표다. **수치나 상태를 이 문서만 믿고 보고하지 말고, 이어받을 때 해당 브랜치에서 다시 돌려 확인한다.**

## 0. 먼저 읽을 것 (순서대로)

1. 이 저장소의 `AGENTS.md`(= `CLAUDE.md`와 같은 규칙) — 절대 규칙, 검증 명령, 테스터 절차.
2. 설계 3개 (main `aee852d0`에 커밋됨):
   - 기능 1: `docs/design/remote-computer-use-2026-11-01/DESIGN.md` (16절 작업 묶음 WP1–WP10)
   - 기능 2: `docs/design/mac-to-mac-2026-11-01/DESIGN.md` (v2.1, 결정 D-1/D-2/D-3, **부록 A = 플로팅 세션 바**)
   - 에뮬레이터 하네스: `docs/design/emulator-e2e-2026-11-01/DESIGN.md`
   - 설계 사본과 판정 JSON(작업 묶음·사람 단계 목록 포함): `/Users/cs-work/agentstoz-emulator/{ai-cross-mac-final.json, human-mac-viewer-final.json, harness-final.json}`
3. 이 문서의 1절(사람이 한 말)과 2절(지켜야 할 것).
4. 손댈 작업의 `reports/*` 원문.

## 1. 사람이 요청한 것 (원문)

- 10-31: "어차피 아젠투지 커뮤니티에 들어있는 호끼리는 새션별로 아니라 항상 크로스로 아젠투지 컴퓨터유즈를 쓸수있게해줘야 의미가있지"
- 11-01: "둘다 완성해야지 그리고 처음것 은 워크룸아니더라도 아젠투지설치되어있으면 되나야한다고 내가말했지? 설계부터 제대로 다시해서 완성하자"
  - **기능 1** = 커뮤니티 Mac끼리 AI 컴퓨터 유즈. 받는 Mac에 워크룸·OPS AI가 없어도 **AgentsToZ만 설치돼 있으면** 동작해야 한다.
  - **기능 2** = 사람이 Mac→Mac 화면 보기·조작 (AgentsToZ Viewer). 가까운 곳 + 인터넷(Cloudflare로 이미 되는 경로).
- "모바일에사프로젝트제어 맥제어 맥간맥제어 모두 에뮬레이터테스트도해" → 휴대폰→프로젝트 제어, 휴대폰→Mac 화면, Mac↔Mac(J4 휴대폰→A→커뮤니티→B, 기능 1 = 3a, 기능 2 = 3b) 모두 에뮬레이터 e2e.
- "한번연결하면 편하게 쭉쓰는 맥락이지?" → 예라고 답했다. 기능 1은 한 번 켜 두는 상시 허용, 기능 2는 한 번 등록 + 연결마다 Touch ID/Watch.
  연결마다 확인을 완화할지 제안했지만 **사람이 아직 답하지 않았다** (8절).
- "맥제어기능도 컴퓨터유즈처럼 플로팅바 기능있어야함 맥끼리 또는 모바일의 맥제어기능 모두" → 조작당하는 Mac의 AgentsToZ Screen에
  컴퓨터 유즈 같은 플로팅 바. 휴대폰 세션과 Mac 뷰어 세션 **둘 다**.
- 확정된 결정(AskUserQuestion 답): 원격 포인터 "처음부터 전부 허용"(RC-17 개정: 원격도 오른쪽·두 번 클릭·스크롤·드래그 허용,
  `REMOTE_POINTER_DISABLED` 없음), 뷰어 등록 "두 Mac 직접 등록"(D-1), 잠금 해제 "조건부 허용"(D-3), 켜 두기 "조건부 켜 두기"(D-2).
  D1(상시 허용 아래 다른 Mac의 AI 받기)은 사람 말에서 예로 받았다. 나머지는 설계 권장값. D-10(Viewer 입력 모니터링)은 S-M3 스파이크 뒤에 묻는다.
- 상시 목표: 모든 기능이 오류 없이 동작 · 공개 저장소 갱신(`bun run publish --append-public-history`) · 공증된 Mac 앱 빌드·설치 최신 유지 ·
  worktree 병합·정리 · 답변은 "English translation:" 다음 한국어.

## 2. 지켜야 할 것 (어기면 사고)

- **실제 데스크톱 입력·실제 캡처 금지**, 사람 화면에 진짜 창 띄우지 않기, TCC·키체인 변경 금지, sudo 금지, OS 프롬프트에 답하지 않기
  (그런 레인은 blocked로 보고).
- **127.0.0.1:3001, 52741, 4723, 설치된 앱의 어떤 포트에도 테스트가 붙지 않는다.** 테스트는 loopback 임시 포트·오프스크린 렌더·가짜만.
- 운영 Supabase(agentstoz `yfbiv…`)에 가짜 데이터를 쓰지 않는다. 레인은 PGlite 대역(`ctx.startSupabaseShim`)만. RLS는 절대 끄지 않는다.
  Supabase MCP의 portmanagement 프로젝트는 nhdesign·cs_rules·meokgo용이라 바꾸지 않는다.
- **SR-23: 어떤 AI 경로도 사람의 화면 세션(기능 2)을 시작·조작하지 않는다.** SAS·Touch ID 승인은 사람만 한다.
- 휴대폰은 세션 프로토콜 **4에 고정**, 골든 벡터 바이트 동일. 프로토콜 5는 Mac↔Mac 전용.
- 결과를 모르는 요청은 자동으로 다시 보내지 않는다. `git stash`(인자 없이) 쓰지 않는다. 작업공간 잠금 자동 회수 금지.
- 설치된 앱을 허락 없이 끄거나 켜지 않는다. 새 앱은 `env -i`로 연다. Windows GitHub Actions는 요청 없이 돌리지 않는다.
- verify가 도는 동안 파일을 고치지 않는다(마지막 편집을 커밋한 뒤 돌린다). CI는 결제로 막혀 있다 → 로컬 `bun run verify`가 유일한 관문.
- 커밋은 이 저장소 기기 설정 이메일 그대로(Vercel BLOCKED 주의). push·공개 저장소 반영·설치는 사람 승인이 있는 범위에서.
- 에뮬레이터 레인은 **등록 루트(`/Users/cs-work/forcs`) 밖 사본에서만** 실행: `git archive <branch> | tar -x -C /Users/cs-work/agentstoz-emulator/<run>/wt`,
  거기서 진짜 `bun install`, `bun scripts/emulator-e2e.ts preflight` 다음 레인. 끝나면 사본 삭제. 시뮬레이터는 소유한 headless만, 끝나면 삭제.

## 3. 현재 상태 한눈에

main = `aee852d0` (설계 문서 + 부록 A). 아래는 전부 **로컬 브랜치**(push 안 됨). 실행 중이던 워크플로 3개는 멈췄고, 그때 진행 중이던
변경은 아래처럼 보존했다. 이 세션이 쓴 worktree는 모두 정리했다(남은 `.claude/worktrees/agent-*`, `control-bar-design`, `release-1585`는 이전 세션 것 — 건드리지 않았다).

| 갈래 | 브랜치 (끝 커밋) | 상태 |
|---|---|---|
| 기능 1 WP1–5 | `feat/rcu-wp1`(47cc1b24) `wp2`(ca0a5a6f) `wp3`(cc8f60ad) `wp4`(e34cbaf5) `wp5`(1c7568c2) | 빌드→리뷰→수정 완료 |
| 기능 1 WP6 | `feat/rcu-wp6`(5bd40cb0) — wp1~5를 포함 | 빌드 완료, **리뷰 도중 멈춤(리뷰 결과 없음)** |
| 기능 1 WP7 | `feat/rcu-wp7`(63ca7b3f) — wp1~4 포함(wp5·6 미포함) | 빌드 완료, **리뷰 도중 멈춤** |
| 기능 1 통합 | (없음) `feat/rcu-integration` | **미착수** |
| 기능 2 통합 | `feat/viewer-integration`(737980e9) = 8묶음 + 수정 + 통합 수정 2 | **검증 통과**(5절) |
| 플로팅 바 | `feat/screen-session-bar`(ded55801) | 빌드→리뷰→수정 완료, main 기준 |
| 바 + 뷰어 합치기 | `feat/viewer-bar`(737980e9, 아직 통합과 같음) | **합치는 도중 멈춤** — 충돌 해결본을 `reports/viewer-bar-merge-in-progress.diff`로 보존 |
| 기능 2 문서·테스터 | (없음) | **미착수** |
| 하네스 1단계 | `emu/integration`(3c06fc81) | 통합·검증 완료 |
| 하네스 2단계 WP4 | `emu/wp4`(bc28b538) | 빌드·리뷰 완료, 리뷰 수정 커밋(bc28b538)은 들어갔으나 **수정 에이전트의 최종 검증 보고가 오기 전에 멈춤** |
| 하네스 2단계 WP5 | `emu/wp5-fix`(5e414e35, wp5 포함) | 빌드→리뷰→수정 완료 |
| 하네스 2단계 WP8 | `emu/wp8`(044735fc) + `emu/wp8-fix-wip`(d058d450) | 리뷰 수정 **도중 멈춤**. WIP는 빌드·테스트 안 된 상태로 커밋해 둠 |
| 하네스 2단계 WP10 | `emu/wp10`(9955978d) | 빌드·리뷰 완료, **리뷰 지적 5건 미수정** |
| 하네스 2단계 WP9·WP11 | (없음) | **미착수**(WP9은 WP4·WP8, WP11은 WP5·WP10에 의존) |

`feat/viewer-*-fix`, `feat/screen-session-bar-fixes`는 원래 브랜치와 같은 커밋이다(빨리 감기 맞춤 완료) — 지워도 된다.

## 4. 기능 1 — Mac 간 AI 컴퓨터 유즈 (`feat/rcu-*`)

요지(설계 참고): A의 MCP `agentstoz_use_computer_session`에 `device`(deviceId) 인자, MCP 계약 1.76.0. 전송은 커뮤니티 제어 우편함
(`portmgr_agent_dialogue_controls`) 새 kind `computer-use`, 종단간 암호 상자(P-256 ECDH/HKDF/AES-GCM) — 화면·글자·허가·오류는 DB에
평문으로 남지 않는다. B는 자기 사이드카 ComputerUseRuntime → ScopeHost → Control로 실행(폴링 루프 밖 전용 줄). B 실행 조건 4개:
상시 허용 · B의 「다른 Mac의 AI 받기」 · 보낸 기기가 막히지 않음 · DB 회원. 원격 데스크톱 클라이언트는 모든 AI에 입력 거절,
원격 AI는 터미널·AI 앱·스크립트 도구·IDE에 입력 거절(D2). 응답 262,144바이트, 캡처 ≤240KB JPEG 2조각, heartbeat 25초, 기기당 8/24, 수신 Mac당 캡처 6MB/분.

이어서 할 일 (순서):
1. **WP6 리뷰** — `git diff main...feat/rcu-wp6`. 사이드카 연결(api-server)과 두 호스트 e2e 시험. 지적을 고친다(빌더 보고 `reports/feature1-rcu__build-WP6.md`).
2. **WP7 리뷰** — `git diff main...feat/rcu-wp7`. 컴퓨터 유즈 패널(B 받기·막기·원격 행·첫 안내, A 사용 중 표시)과 click-sweep 기준. 보고 `reports/feature1-rcu__build-WP7.md`.
3. **통합** `feat/rcu-integration` = main에서 `feat/rcu-wp6` 병합 → `feat/rcu-wp7` 병합(wp7에는 wp5·6이 없으므로 충돌 가능 — MCP 계약 버전·패널 파일 확인).
   MCP 계약 버전이 다른 브랜치와 겹치지 않는지 본다(메모리 "MCP 계약 버전 충돌").
4. 각 WP 수정 보고(`reports/feature1-rcu__fix-WP*.md`)의 「남은 항목」을 전부 읽고 반영 여부를 정한다 — 리뷰가 범위 밖으로 넘긴 것이 있다.
5. **WP8** 문서·테스터 등록(`docs/claude/computer-use.md` 갱신, CLAUDE.md 색인, 테스터 매니페스트는 검사 96개 상한이 꽉 차 있으니 **기존 검사 argv에 새 테스트 파일을 더한다**).
6. **WP10**(2단계) Control 릴리스: Control 막대의 「원격 · <기기>」 표시·문구·원격 데스크톱 보호·받기 인증·기기 신원 키. **Screen 릴리스와 같은 릴리스로 묶는다.**
7. WP9 라이브 확인·서명 빌드·설치·실기·측정(7절, 사람 단계 포함).

## 5. 기능 2 — Mac 뷰어 (`feat/viewer-integration`)

8묶음(core-v5+PreAuthGate, input-origin, controller-store, main-app helper, pairing, screen-host, viewer-app, screen-ui)을 각각 빌드→리뷰→수정 후 합쳤다.
통합 수정 2개: `74aba961`(B의 새 보기 전용 사유 2개를 Viewer 띠에 표시), `737980e9`(「Mac 추가」 등록 시트를 AppKit으로 다시 써 Viewer 소스 계약 안으로).
통합 브랜치에서 실제로 돌린 결과(`reports/feature2-viewer__integrate-viewer.md`):
`swift build` 성공 · `bun run test:screen-control` 158/158 + XCTest 108개 0 실패 · `swift test` 121개 0 실패 · `bun run typecheck` 0 ·
`bun run test` 9814 pass/12 skip/1 fail(node_modules 없는 worktree 탓 — 링크 후 10/0 확인) · `cargo test` 165 통과 · `bun run test:ios` 통과.
조작은 S-M3 플래그 뒤에서 **기본 꺼짐**. 등록 시트는 컴파일·소스 계약으로만 확인, 두 Mac 실기 등록은 아직.

이어서 할 일:
1. **플로팅 바 합치기**: `git checkout feat/viewer-bar`(=통합과 같은 커밋) → `git merge --no-edit feat/screen-session-bar`.
   충돌 3곳: `native/screen-control/Sources/AgentsToZScreen/ScreenApp.swift`, `Sources/ScreenHost/ScreenService.swift`, `scripts/check-screen-control.ts`.
   멈추기 직전 에이전트가 풀어 둔 결과가 `reports/viewer-bar-merge-in-progress.diff`(HEAD 대비 전체 diff, 충돌 표식 없음)에 있으니 참고해서 양쪽을 모두 살린다.
2. 합친 뒤 할 일(멈춘 워크플로의 지시 그대로):
   - 바의 클릭 규칙 사본을 `ScreenInputOrigin.humanClick`으로 바꾼다(버튼 안·한 번 클릭·접근성 누르기 거절 조건은 유지, 상수 묶는 소스 검사 유지).
   - **Mac 컨트롤러 세션도 바에 표시**: 기기 종류 Mac + 등록 이름, view 권한이면 「보는 중」 + 끊기만, control이면 「조작 중」. 남은 시간은 보기 60분 / 조작 유휴 60분·최대 8시간.
     같은 `ScreenMacHold`를 쓴다(직접 하기·보기만 보류는 휴대폰·Mac 모든 원격 세션에 적용, 풀림은 하드웨어 「다시 넘기기」 또는 인증된 켜기뿐).
     `canControl`을 `RegisteredController.grant`와 맞춘다.
   - **프로토콜 5 전용 안내**: B의 사람이 입력을 가져가면 A의 띠에 「B에서 직접 조작 중 — B에서 다시 넘겨야 조작할 수 있습니다」. v4 휴대폰 바이트·문구는 그대로. v5 벡터·검사 추가. 인증 전 위조 불가 확인.
   - 시험: 컨트롤러 세션 바 모델 XCTest(view/control, 기한, 휴대폰·Mac 공유 보류, 재연결 뒤에도 멈춤), Mac 세션 오프스크린 렌더 상태, 소스 계약.
   - 검증: `bun install` → `swift build` → `bun run test:screen-control` → `swift test --package-path native/screen-control` → `bun run test:ios` → `bun run typecheck`.
3. 독립 리뷰 → 수정.
4. **wp-docs-tester**: `docs/claude/mac-viewer.md` 신설(결정, 프로토콜 5 vs 휴대폰 4, 컨트롤러 저장소, 등록, push 관문, 켜 두기·잠금 해제 조건, 세션 바 보류 규칙,
   알려진 빈틈, 사람 단계) + CLAUDE.md 표에 색인 한 줄(`tests/claude-md-size.test.ts` 통과), `docs/claude/remote-control.md`는 모순되는 곳만. 테스터는 상한 때문에 기존 검사 argv에 추가.
5. 각 묶음 수정 보고(`reports/feature2-viewer__fix-*.md`)의 「남은 것」 확인. 특히 core-v5의 TXT `pv=5` 광고 미구현, 52741 호스트의 컨트롤러 수락은 screen-host에서 처리됨(확인).

## 6. 플로팅 세션 바 (`feat/screen-session-bar`, 이미 완료)

NSPanel 비활성 패널 `.statusBar` 레벨을 매 초 다시 세움, 모든 Space·전체 화면, 끌기·위치 기억, 캡처에서 제외하지 않음(상대도 봄),
Control 막대보다 한 칸 위 기본 위치. 버튼: 끊기·보기만·직접 하기는 어떤 클릭도 받음, **다시 넘기기는 그 버튼 안의 새 하드웨어 클릭 한 번만**
(pid 0, Screen 주입 아님, 원격 데스크톱 거절, 접근성 누르기 거절, 두 번 누름 거절). 보류(`ScreenMacHold`)는 **Mac 전체 단위**라 어느 기기로 재연결해도 유지.
검증: `bun run test:screen-control` 102/102, XCTest 24개 0 실패, 오프스크린 렌더 14상태(`tests/results/screen-session-bar/`는 gitignore).
남은 것: 실제 Mac에서 패널 레벨·앞에 머묾·끌기·실제 더블클릭·osascript 누르기 확인. 「보기만」 뒤 휴대폰 문구가 원인을 틀리게 말함(전용 문구는 프로토콜 변경 필요 — v4에서는 하지 않는다).
Control 막대(`native/computer-use` ControlBar)에도 같은 「1초 안 접근성 누르기」 틈이 있다 — 범위 밖이라 안 고침(기능 1 WP10 때 같이 볼 것).

## 7. 에뮬레이터 하네스 (`emu/*`)

1단계(`emu/integration` 3c06fc81, 검증 끝): preflight, 빈 상태에서 만드는 환경 허용 목록, sandbox-exec 프로필(open·osascript·security·tccutil·launchctl·defaults 실행 거절,
loopback은 그 실행의 포트만 — 허용 목록 규칙이 **마지막**이어야 함, 3001·52741·4723 거절, LAN 바인드는 선언 포트만 + lsof en0 확인, canary),
`lockf` 시뮬레이터 잠금, PGlite Supabase 대역(http/https 문, 실행별 CA, GoTrue 이메일 코드, `SET LOCAL ROLE` RLS), ScreenFixtureHost(합성 캡처·기록 전용 입력, `nm -u` 관문), j1-pty.
검증: typecheck 0 · 하네스 테스트 94/0 · 레인 관련 96/0 · test:screen-control 102/102+13 · 루트 밖 사본에서 preflight pass, screen-host-selfcheck 45/45, j1-pty pass.
**막힘**: 127.0.0.1:443이 sudo 없이 EACCES → 실제 앱 인터넷 레인(J1-RELAY-SIM, J4-SIM)은 blocked가 정상. 우회(sudo/pf) 금지. 릴레이는 WebKit 레인(WP5)이 덮는다.

이어서 할 일 (모두 `emu/integration` 기준 브랜치):
1. **WP4** `emu/wp4`: 수정 커밋 bc28b538을 루트 밖 사본에서 다시 검증(j1-lan 레인, test20 XCUITest, check-ui.py 개수). 리뷰 원문 `reports/emulator-stage2__review-wp4.md`와 대조해 빠진 지적이 없는지.
2. **WP8** `emu/wp8-fix-wip`: WIP를 이어서 완성(리뷰 `reports/emulator-stage2__review-wp8.md`). 빌드·테스트 안 된 상태이니 처음부터 검증.
3. **WP10** `emu/wp10`: 리뷰 지적 5건 수정(`reports/emulator-stage2__review-wp10.md`) — 특히 1번(샌드박스 밖에서 api-server가 기본 포트로 뜰 수 있는 시험), 2번(여러 줄 import를 못 보는 정규식 → `Bun.Transpiler.scanImports`), 3번(`Promise.all` 부분 실패 시 사이드카 누수).
4. **WP9** (WP4+WP8 뒤): J2-APP-BOUNDARY(test30: 실제 앱이 `agentstoz-screen://` 컨트롤러 초대를 「Mac 컨트롤러 전용 QR은…」로 거절, 기기 초대는 키·증명 전 등록 연결 0) + J2-VIEWER-MODEL(시뮬레이터가 SecureEnclave를 지원할 때만, 아니면 blocked).
5. **WP11** (WP5+WP10 뒤): J4-COMMUNITY-WEB — WebKit 포털 휴대폰이 사이드카 A와 페어링 → 커뮤니티 → B의 프로젝트 목록·워크룸 터미널·명령·출력, 거절(우회·재시작)은 거절 유지, DB 덤프에 제어 행. J4-COMMUNITY-SIM은 443 때문에 blocked.
6. 병합: `emu/integration`에 wp4, wp5-fix, wp8(완성본), wp10, wp9, wp11 → typecheck + `tests/emulator-*.test.ts` → 루트 밖 사본 하나에서 preflight, j1-lan, j1-pty, j1-relay-web, j2, j2-boundary, j2-model, j4-web, screen-host-selfcheck, `all`. 각 레인 pass/fail/blocked/skipped와 이유를 그대로 보고.
7. 새 레인: **3a**(격리 호스트 두 개 + 대역 우편함 위 가짜 Control로 기능 1 e2e — `feat/rcu-integration`이 생긴 뒤), **3b**(Viewer ↔ ScreenFixtureHost loopback — `feat/viewer-bar` 뒤), **세션 바 단언**(J2에서 바 모델 상태).
8. WP13: 오케스트레이터 `all`, 테스터 매니페스트(상한 안에서), 문서.

## 8. 사람이 정할 것 / 사람만 할 수 있는 것

정할 것 (사람이 아직 답하지 않았다 — 묻되 기본값으로 진행 가능한 것은 진행):
- 뷰어 연결마다 Touch ID/Watch 확인을 완화할지(제안만 함, 답 없음).
- 「보기만」 뒤 다음 세션: 기본값으로 **일시 정지(원격 입력 멈춘 채 시작)** 로 했다. 바꾸고 싶으면 사람이 말한다.
- D-10 Viewer 입력 모니터링 권한 — S-M3 스파이크 뒤에 묻는다.

사람 단계 (AI가 하지 않는다): S-M3·S-K2(App Attest)·S-N2(WARP↔WARP) 스파이크 실측, H1 Viewer 서명 프로필(`com.intenet.agentstozbycs.viewer`),
H10 screen-push 배포(`pushLive` 관문 — 조작·켜 두기·미결속 등록에 필요), 두 Mac 실기 점검표, SAS·Touch ID 승인, 운영 배포 승인.
막힌 운영 단계는 문서에만 적지 말고 **같은 세션에서 사람에게 바로 알린다**.

## 9. 마지막 통합·릴리스 순서

1. main에 병합: `feat/rcu-integration` → `feat/viewer-bar`(문서 포함) → `emu/integration` (각각 병합 후 충돌·계약 버전 확인).
2. `bun run verify`(typecheck · bun test · cargo test) 0 fail. pyenv `python3`면 `PATH="/usr/bin:$PATH"`로.
3. 테스터: 세션당 한 번 `curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$(git rev-parse --show-toplevel)" http://127.0.0.1:3001/api/project-tester/ensure`,
   그다음 `python3 scripts/agentstoz-maintainer.py run --root . --profile quick` + `personas run --root .` + native 프로필(ios-ui: check-ui.py 기대 1 pass/1 skip, 제스처 7).
   quick의 `workroom-browser-native-screen`이 "Native QA source does not match the cached bundle"로 실패하면 회귀가 아니라 CEF 환경으로 `--build` 다시 빌드할 것(이번 세션에서 그렇게 통과).
   새 사용자(Mac 뷰어 사용자, 조작당하는 Mac 앞 사람, 다른 Mac의 AI를 받는 사람)는 `personas propose`로 후보만 남긴다.
4. 서명·공증 빌드와 설치: 메모리 `signed-release-build-recipe.md`, `local-app-install-false-ok.md`, `install-from-workroom.md`
   (`/Users/cs-work/.claude/projects/-Users-cs-work-forcs-AgentsToZ-byCS/memory/`)의 절차 그대로 — 깨끗한 origin/main worktree, `build-macos.ts --embedded-browser --developer-id --notary-profile nhdesign-usher`,
   Control 앱은 `scripts/build-computer-use-control-app.ts`. 빌드는 HEAD=origin/main을 요구하므로 **push 승인 후**. 설치: osascript 종료 → 백업 → ditto → `env -i open`, 성공 판정은 3001 소유자가 새 GUI의 자식인지.
   워크룸 안에서는 앱 교체 불가. 3호 설치 + 1호는 `scripts/install-remote-mac.ts`. Viewer/Screen 앱은 H1 프로필이 있어야 한다.
5. 공개 저장소 `bun run publish --append-public-history`(승인 후), 세션 기억하기.

## 10. 이번 세션에서 배운 함정

- **워크플로 수정 에이전트의 커밋이 `-fix` 브랜치에 생긴다**: 빌더 worktree가 그 브랜치를 잡고 있으면 다른 worktree에서 checkout이 거절된다.
  수정 에이전트가 `<branch>-fix`를 만들거나 `--ignore-other-worktrees`로 가져가면, 빌더 worktree는 HEAD만 움직이고 파일은 옛 상태라 「되돌리는 변경」처럼 보인다
  (`git diff HEAD~k`가 비면 낡은 상태일 뿐). 다음엔 빌더가 끝나면 worktree를 비우거나, 수정 단계에 처음부터 새 브랜치 이름을 준다.
- 링크한 새 worktree에는 `node_modules`가 없다 — `bun install` 없이 돌린 실패(`node_api.h` 등)는 환경 탓. 심볼릭 node_modules는 다른 가짜 실패를 만든다(메모리).
- SourceKit의 "No such module 'ScreenControlCore'" 진단은 편집기 맥락 소음이다 — `swift build`가 판정.
- SBPL 규칙 순서: 포트 허용 뒤에 다른 outbound 규칙이 오면 일부 포트가 빠진다 → 허용 목록을 마지막에.
- 레인 결과는 태그로 분류(실패한 레인을 「조건 불충족」으로 세지 않기).
- 테스터 매니페스트: 검사 96개·프로필 16개 상한(꽉 참).

## 11. 보고서 색인 (`reports/`)

- 기능 1: `feature1-rcu__{build,review,fix}-WP1..5`, `build-WP6`, `build-WP7` (WP6·7 리뷰는 없음 — 멈춤)
- 기능 2: `feature2-viewer__{build,review,fix}-{core,origin,store,mainapp,pairing,host,viewer,ui}`, `integrate-viewer`
- 세션 바: `session-bar__{build,review,fix}-session-bar`
- 하네스 1단계: `emulator-stage1__*`, `emulator-stage1-fix__*`(merge-emu 포함)
- 하네스 2단계: `emulator-stage2__{build,review}-{wp4,wp5,wp8,wp10}`, `fix-wp5` (wp4·wp8 수정 보고 없음, wp10 수정 미착수)
- `viewer-bar-merge-in-progress.diff`: 바 합치기 도중의 해결본
