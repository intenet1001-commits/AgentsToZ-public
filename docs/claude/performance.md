# 성능 기준선 · 원격 여정 하네스 · 앞단 비용

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## 성능 기준선 — `bun run perf:baseline` (2026-10-08)

재현 가능한 측정 25개를 한 명령으로 재고 `docs/perf/baseline.json`에 남긴다. 비교는
`bun run perf:baseline -- --compare docs/perf/baseline.json`(파일을 쓰지 않음). 회귀 판정은 **중앙값이 기준의
1.5배를 넘고 증가분이 측정별 하한도 넘을 때만** 종료 코드 1이다 — 잡음으로 깜빡이지 않게. 일부만: `--only ui,remote`,
표본 `--samples N`, 실제 CLI 첫 출력까지 보려면 `--real-cli`(비교 대상 아님). 모듈은 `scripts/perf/`.

- ⚠️ **시간 값을 `bun test` 단언으로 만들지 말 것.** `tests/perf-baseline.test.ts`는 통계·비교 로직과 파일
  스키마만 본다. 측정은 실제 부하에 흔들린다(이 Mac은 평소 load 5 안팎 — 기준선에 load를 함께 적는다).
- 격리 원칙: 사이드카는 **격리 HOME·데이터 폴더·빈 포트**로 띄우고, 실제 데이터 폴더나 `~/.claude`·`~/.codex`
  아래 파일을 열면 `lsof` 검사로 측정을 중단한다. 설치 앱·3001 사이드카는 건드리지 않는다. 커뮤니티는 PGlite
  위 실제 `AgentDialogueHost` 2대, 목록 그리기는 격리 Vite 빌드 + 합성 API + Playwright(chromium).
- 기준선(2026-10-08, Mac16,8, load 4.7→6.0, 중앙값): 사이드카 준비 289ms(150개 등록 308ms) · 워크룸 시작→첫 출력
  31ms, 화면 안정 144ms(가짜 CLI 100ms 포함) · 커뮤니티 제어 왕복 바닥 152ms / 받는 쪽 활성 381ms / 유휴 1,563ms
  (p90 2,774) · 휴대폰 목록 첫 페이지 169ms, 다음 페이지 167ms, 160장 전체 1,352ms · LAN 워크룸 목록 폴링 18ms
  (5초 캐시 만료 직후 293ms) · 프로젝트 150행 118ms · 북마크 첫 카드 54ms.
- **이 측정이 지목해서 고친 것 두 가지**:
  ① **북마크 첫 진입 326.6ms → 54ms.** 원인은 데이터가 아니라 React 19의 Suspense 공개 지연(300ms)이었다
  (청크는 ~10ms에 도착). ⚠️ **모듈을 미리 import 해도 안 바뀐다**(실측: 5초 미리 데워도 328ms) — `React.lazy`는
  팩토리의 `.then` 콜백이 그 자리에서 불리지 않으면 멈춘다(react 19.2 `lazyInitializer`). 그래서
  `src/lazyTabPreload.ts`의 `preloadableModule`이 받아 둔 모듈을 **동기 thenable**로 돌려주고, App이 첫 화면 뒤
  유휴 시간에 북마크·워크룸·장기기억·내가 한 말 탭을 하나씩 받는다. 새 lazy 탭을 자주 여는 자리에 두면 같은 것을 쓸 것.
  `tests/lazy-tab-preload.test.ts`가 설치된 React로 「미리 받은 lazy는 첫 렌더에 멈추지 않고, 안 받은 것은 멈춘다」를 본다.
  ② **LAN 워크룸 폴링 190.5ms → 18.5ms.** `read`·`list`마다 `taskTargetBindings`가 등록 프로젝트 전체 카드를
  다시 만들었다. 이제 소켓별로 5초 재사용한다(`LAN_READ_ONLY_TERMINAL_BINDINGS_TTL_MS` — 인터넷 릴레이의
  `READ_ONLY_TERMINAL_BINDINGS_TTL_MS`와 같은 규칙). start·input·resize·close는 매번 새로 만들고, 연결이 살아
  있는지는 요청마다 본다. 회귀: `tests/remote-control-lan-terminal-bindings.integration.test.ts`.
- 휴대폰 원격 목록의 쪽마다 재열거는 2026-10-08에 고쳤다(전체 1,352ms → 175ms, 「목록을 다 못 받는 폰」 절). 커뮤니티 제어의 150ms 바닥은 보내는 쪽 `controlCall`의 첫 확인 뒤 대기이고, 전체는 받는 쪽 폴링
  주기(0.6초/3초)가 지배한다 — 바닥만 줄여도 체감은 거의 같다.
- ⚠️ **실제 2호·3호 왕복은 이 스크립트로 재지 않는다(UNVERIFIED).** 앱의 `/api/agent-dialogue/control`은 Tauri
  관리 권한(`isRemoteControlManagementRequest`)을 요구하고, MCP에는 다른 기기로 요청을 넘기는 도구가 없다. 우회하거나
  토큰을 만들지 말 것 — 재려면 앱 화면(워크룸 「기기」 탭)에서 사람이 재거나, 권한 있는 측정 경로를 따로 설계한다.

## 원격 여정 하네스 — 실기 측정은 사람이 들고 있는 휴대폰에서만 (F11, 2026-10-15)

원격 benchmark의 후보 쪽 수치(latency·effort·retry·violations)는 실제 iPhone의 이벤트 로그에서 나온다. 리듀서
`src/remoteJourneyReducer.ts`(순수)가 로그를 줄이고, `mobile/ios/scripts/remote-journey-iphone.ts`가 로그를 쓴다.
규칙 요약은 `docs/plans/voice-remote-growth-2026-10-15/BENCHMARK.md`의 「오프라인 평가 도구」.

- ⚠️ **스크립트는 이중 게이트다**: `--device <UDID>`와 `AGENTSTOZ_REMOTE_JOURNEY_DEVICE=attended`가 둘 다 없으면 Appium에 닿기
  전에 종료 코드 2로 거절한다. 조작 대상은 **개발 앱(`com.intenet.agentstoz.mobile.dev`) 하나**이고 다른 bundle은 인자로도
  받지 않는다. Mac 화면(cliclick·screencapture)·다른 앱(OpenAI 앱 포함)·휴대폰 설정을 건드리지 않는다 — 테스트가 소스를 검사한다.
- ⚠️ **Mac 승인(6자리) 화면은 동의 경계다** — 시작 때 보이면 아무것도 누르지 않고 거절하고, 도중에 보이면 기록을 멈춘다.
  SAS·권한·범위를 자동 승인하는 경로를 더하지 말 것. Wi‑Fi·잠금·Mac 앱 재시작도 사람이 하고 스크립트는 묻고 기록만 한다.
- ⚠️ **written은 추론이다**: 패널은 written 영수증에서만(또는 옛 Mac이 제출 자체를 거절할 때만) 보류 기록을 지운다. 그래서
  기록이 사라지면 written, 「전체 요청 제출을 아직 받지 않습니다」가 보이면 rejected로 적는다. 화면 밖(잠금·다른 탭)의
  입력칸은 초안에 대해 아무것도 말하지 않으므로 그때의 빈 값은 draft로 적지 않는다(적으면 거짓 draft-lost).
- ⚠️ **요청은 `--project`의 세션에만 들어간다**(2026-10-15 리뷰). 휴대폰이 다른 세션(OPS·실제 작업)의 입력칸을 연 채였으면 그대로
  입력하던 결함이 있었다. 지금은 세션 탭의 **글자 노드**(소유자·상태 span 제외)가 `<project> · <agent>[ #n]`의 프로젝트 부분과 정확히
  같거나 탭 이름 전체와 같은 실행 중 세션 **하나**만 고르고(`selectJourneySession`·`journeySessionMatches`, 웹 화면에 소스로 심는다),
  입력 전·보내기 전에 `.ai-terminal-current-label`을 다시 확인한다. 없으면 `WORKROOM_SESSION_NOT_FOUND`, 둘 이상이면
  `WORKROOM_SESSION_AMBIGUOUS`, 고른 뒤에도 다르면 `WORKROOM_TARGET_MISMATCH`로 **아무것도 입력하지 않고** 멈춘다. 포털의 어느 Mac
  탭이 열려 있는지는 확인하지 않는다 — 실행 전에 사람이 고른다.
- ⚠️ **복구 metric은 교란이 끝난 뒤 보낸 요청으로만 잰다.** 예전에는 요청을 교란 전에 보내고 교란 중에는 화면을 보지 않아, 그 사이
  나온 답이 「끝」 직후 처음 보여 복구 시간이 ≈0ms였다. 지금은 초안을 쓰고 → 사람이 교란을 시작·끝내고 → 다시 들어가 초안이 남아
  있는지 확인한 뒤(사라졌으면 다시 쓰지 않고 `draft-lost`로 멈춘다) 보낸다. 리듀서는 끝 이전에 보냈거나(`SUBMIT_BEFORE_RECOVERY`)
  답이 보인(`ANSWER_BEFORE_RECOVERY`) 기록에 복구 latency를 주지 않는다.
- ⚠️ **id 없는 submit은 옛 입력 경로다**(전체 요청 제출을 모르는 Mac): 패널이 보내면서 입력칸을 직접 비우므로, 그 초안이 화면에 있던
  동안의 id 없는 submit이 그 비움을 설명한다 — `draft-lost`가 아니다. 철회 중 id 없는 submit의 답은 그 앞 요청이 아직 답을 못 받았으면
  누구의 답인지 모르므로 `grant-bypass`가 아니라 `BYPASS_UNATTRIBUTABLE`이다.
- ⚠️ **아직 실기에서 돌리지 않았다.** 웹 화면이 NATIVE_APP만 보이면(TestFlight 712에서 실제로 그랬다) `WEBVIEW_UNAVAILABLE`로
  거절한다 — 추측하지 않는다. 실행 전 Web Inspector를 켜고 끝나면 끈다(iphone-ui-automation 메모).
- 검증: `tests/remote-journey-reducer.test.ts`(골든 로그: 기본·중복 탭 vs 두 번 실행·초안 분실·재연결·철회 뒤 거절/수락·assembler 연결,
  교란 전 요청·답의 복구 latency 없음, 옛 입력 경로의 비움, 귀속할 수 없는 철회 중 답),
  `tests/remote-journey-iphone-script.test.ts`(인자·opt-in 거절과 실제 프로세스 종료 코드, 가짜 드라이버 여정, 다른 세션이 열려 있어도
  요청이 그 세션에 가지 않음·없거나 둘이면 입력 전 거절, 세 복구 metric 모두 끝 뒤에 보냄, 웹 화면 관측·세션 선택 함수).

## 앞단 비용 — 같은 것을 요청마다 다시 읽지 않는다 (감사 2026-10-06)

MCP·커뮤니티가 느린 원인은 폴링이 아니라 **모든 호출 앞단에 붙은 반복 조회**였다. 네 곳을 고쳤다.

| 무엇 | 전 | 후 |
|---|---|---|
| `resolveRegisteredUseProject` | **전체** `detectProjectMemory`(동기 git 다수 + 기억 문서 전부 + CLAUDE.md·AGENTS.md 각 2회) | `detectProjectMemoryIdentity`(비동기, 쓰는 값은 `memoryId`·`projectRoot` 둘뿐) |
| `boundOpsProjectId()` | `store.status()` — 기억 문서 전체 읽기 + sha256 + 후보 목록(최대 1MB) 파싱 | `store.boundProjectId()` — 바인딩만 읽는다(값은 동일: `projectId`는 ready 검사 **앞에서** 채워진다) |
| `listAgentsToZUseProjects()` | 호출마다 ports.json 전체 + 프로젝트마다 realpath→stat→readFile. 유지 틱이 엔드포인트 수만큼 반복 호출 | **3초 공유 캐시** + 등록·기억 초기화 시 즉시 무효화 |
| 유지 틱의 heartbeat | 공개 엔드포인트 수만큼 **직렬** RPC(실측 101개) | 6개씩 끊어 보내고, 하나가 실패해도 나머지를 보낸 뒤 첫 오류를 던진다 |
| 테스터 `resolve`(폴더를 여러 개 도는 경로) | 폴더마다 전수 인벤토리(등록 프로젝트마다 `git worktree list`, 페이지마다 realpath/stat 재적용) | `loadReadOnlyAgentRuntimeTargetInventory()` — 기존 5초 공유를 **id 를 찾기만 하는** 호출자에게 연다 |

- ⚠️ **실행 직전 판정은 캐시를 쓰지 않는다.** `captureAgentRuntimeLeasedTargetIdentity` 와
  `resolveAgentRuntimeRegisteredTarget` 는 「실행 바로 전에 새로 읽는다」가 계약이고 **그것이 신뢰 경계**다.
- ⚠️ **`listAgentRuntimeTargets()`에도 쓰지 말 것.** 그 응답의 `complete` 는 사용자에게 경고로 보이는
  값이라 낡은 `complete:true` 는 거짓이다. 실제로 한 번 캐시를 걸었다가
  `tests/agent-runtime-capability-isolation.test.ts`(레지스트리를 읽을 수 없게 만든 뒤 새로 고치면
  `complete:false`)가 그 회귀를 잡아 되돌렸다. 쓸 수 있는 곳은 **id 를 찾은 뒤 곧바로 새로 확정하는**
  호출자뿐이다.
- ⚠️ **`detectProjectMemory`(전체)를 전역 캐시하지 말 것** — 「세션 기억하기 필요」 배지가 그 결과를
  폴링하므로 배지가 늦어진다. USE 경로는 **identity 전용 함수로 교체**한 것이지 캐시한 것이 아니다.
- ⚠️ **`Promise.race` 의 패자 타이머는 반드시 `clearTimeout` 한다.** 정리하지 않아 열거가 반복되는 틱에서
  별칭 수만큼의 500ms 타이머가 수만 개 동시에 떠 있었다.
- ~~부분 실패한 worktree 목록이 성공한 프로젝트까지 매번 다시 조회한다~~ — **해결.**
  `src/worktreeDiscoveryPageCache.ts`는 성공한 가족 목록과 실패한 프로젝트 ID를 함께 짧게 보존한다.
  다음 조회는 성공 부분을 재확인하고 실패 후보만 다시 찾으며, 부분 결과를 새로 저장해도 원래 TTL을
  늘리지 않는다. 실행 직전 대상 검증과 목록의 `complete:false` 경고는 그대로 유지한다.
