# AI 대직 · CS 대직

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## AI 대직 — 켜고 방만 고르면 끝 (2026-10-06)

「CS 대직 · 질문 응답 설정」의 맨 위가 **AI 대직**이다: 카카오톡 방·슬랙 채널/DM을 고르고 「대직 켜기」를 누르면 그 프로젝트
폴더에서 **제한된 Claude 세션**이 사용자의 kakaotalk·slack MCP(mcp-series 0.2.0)로 그 방들을 지키며, **누가 묻든(사용자 본인 포함)
질문으로 보이면** 프로젝트 파일을 읽어 짧게 답한다. 옛 3단계(공유 자료만으로 `/cs` 응답)는 「기존 방식 (고급)」으로 접혀 있고,
그 프로젝트에 옛 설정이 있으면 펼쳐진 채로 열린다. 정본: `src/csDutyAgent.ts`(설정·허용 도구·프롬프트·MCP 설정)·
`src/csDutyAgentHost.ts`(시작·중지·부팅·감시)·`src/CsDutyAgentSection.tsx`(화면)·`src/mcpStdioClient.ts`(목록 읽기).
- ⚠️ **안전 경계는 프롬프트가 아니라 허용 도구 목록이다.** 세션은 `--permission-mode dontAsk`로 뜨고(`AiTerminalLaunchProfile`,
  `aiTerminalLaunchArgs`) 허용 목록은 `Read(./**)`·Glob·Grep + 고른 채널의 `*_delegate_*` 도구뿐이다. 셸·쓰기·`kakao_send`·
  `slack_send_message`·`slack_api`는 묻지 않고 거절된다. `.env`·키·`*secret*`·`*token*`·`.git/**` 읽기는 deny다
  (2026-10-06 실측: `.env`와 `/etc/hosts` 읽기가 dontAsk에서 거절됨). 바깥 사람의 글이 무엇을 시켜도 이 경계를 넘지 못한다.
- 제한 실행은 **호스트 전용**이다: `perform(value, authority, {launchProfile})`의 세 번째 인자로만 받고, 원격 권한·Claude 외 AI·
  이어 열기(`resumeFrom`)와 함께 오면 거절한다. 다시 시작은 그 세션의 제한을 그대로 물려받는다.
- MCP는 사용자 `~/.claude.json`에서 두 서버만 옮긴 **전용 설정**(`cs-duty/agent-mcp-<id>.json`, 0600, `--strict-mcp-config`)으로
  띄운다 — 서버 이름이 고정돼 도구 이름(`mcp__kakaotalk__…`)이 사용자 설정과 무관하게 안정적이다.
- 봇 자신의 글 무시·「봇 그만」·시간당 상한·만료는 **MCP가 강제**한다(앱이 다시 구현하지 않는다). 본인 질문은 `include_mine=true`로
  받고, `[cs-assistant-bot]`로 시작하는 글은 누가 보냈든 돌려주지 않는다. 답하는 사이 들어온 질문은 버리지 않는다(`pending`).
- ON/OFF·방 목록은 `cs-duty/agent-duty.json`에 저장되어 **앱을 다시 열어도 이어진다**(설치 앱만, 부팅 15초 뒤). 1분마다 끝난 세션을
  다시 띄우되 한 시간에 세 번까지이고 그 뒤에는 이유를 말한다. 5분 넘게 출력이 없으면 한 줄로 깨우되 **질문 화면이면 입력하지 않는다.**
- 켜진 채 방을 바꾸면 「저장하고 세션 다시 시작」 — 실행 중인 세션은 시작할 때의 방만 지킨다.
- 검증: `tests/cs-duty-agent.test.ts`(허용 도구에 셸·임의 발송 없음·dontAsk 인자·0600·재시작 상한·질문 화면 미입력·원격 거절),
  `tests/cs-duty-agent-ui.mjs`(격리 fixture, 목록·직접 입력·한 번에 저장+시작·수정 시 재시작·OFF·390px), mcp-series의 delegate 테스트.

## CS 대직 — 실패는 이유를 말해야 한다

전체 계약은 `docs/cs-duty.md`가 정본이다. 여기 남기는 것은 반복해서 사람을 막았던 두 가지다.

- **읽기는 `--background-safe`라 카카오톡 창을 대신 열지 않는다.** 목록에서 선택만 해 둔
  채팅방은 «노출»이 아니라 kmsg가 `BACKGROUND_SAFE_BLOCKED`(exit 1)로 거절한다. 같은 방을
  별도 창으로 열면 즉시 성공한다(2026-09-09 실측). `kmsg chats --keep-window`가 창을 **열어
  두는** 것도 같은 이유다 — kmsg는 카카오 서버 API가 아니라 macOS 접근성 기반 UI 자동화다.
- ⚠️ **`catch {}`로 실패 사유를 뭉개지 말 것.** `enable`·`tick`이 모든 원인을 «연결하지
  못했습니다» 한 줄로 합쳐서, 무엇을 고쳐야 하는지 알 수 없었다. 이제 `DutyFailure`로 던진
  운영자용 문구만 화면에 그대로 나가고 그 밖의 오류는 일반 문구로 떨어진다. 새 실패 경로를
  추가하면 `DutyFailure`를 쓰고, 진단(`diagnose`) 체크리스트에도 항목을 넣을 것.
  진단은 **한 검사가 실패해도 멈추지 않는다** — 첫 실패만 보고하면 "카톡이 꺼졌다"와
  "그 채팅방 창이 안 열렸다"를 구분할 수 없다.
- 문구는 패널에 그대로 나가므로 **경로·stderr·비밀을 담지 않는다.** 명령 실패는 명령 이름과
  종료 코드까지만 밝힌다.
- Rust 프록시의 응답 타임아웃 기본값은 20초다. `enable`과 `diagnose`는 카카오톡 프로브를
  여러 번 도니 75초를 따로 준다(`agent_runtime_response_timeout`). 새 장기 오퍼레이션을
  추가하면 여기도 함께 고칠 것.
