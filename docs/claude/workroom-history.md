# 휴대폰 워크룸 대화 기록 · 업데이트 뒤 이어 열기

> CLAUDE.md에서 옮긴 상세 노트다(2026-10-24, 원문 그대로 · 제목 수준만 한 단계 올림). 이 영역의 코드를 고치기 전에 읽는다.
> 새 결정·함정은 이 파일에 적고, CLAUDE.md에는 색인 한 줄(필요하면 절대 규칙 한 줄)만 더한다. 「위/아래 절」이라는 말은 옮기기 전 CLAUDE.md 안의 위치를 가리킬 수 있다 — 색인에서 찾을 것.

## 휴대폰 워크룸 대화 기록 — 목록·이어 열기는 별도 권한이다 (`workroom-history-v1`, 2026-10-15)

워크룸 대화 기록(`WorkroomConversationService`)은 로컬 전용이었다. 이제 휴대폰 포털의 워크룸 아래 접힌 「대화 기록」에서
허용된 프로젝트의 지난 대화를 보고, 저장된 대화를 **이 Mac에서** 다시 연다. 정본: `src/workroomHistoryRemoteProtocol.ts`(와이어·
권한 이름·휴대폰 보관)·`src/workroomHistoryRemoteHost.ts`(Mac)·`src/remoteWorkroomHistoryClient.ts`·`src/RemoteWorkroomHistoryPanel.tsx`.

- **권한은 새 grant 필드 `historyScopes`**(`history.read`·`history.resume`)다. ⚠️ `MOBILE_WORKSPACE_SCOPES`에 넣지 말 것 — 옛
  reader가 모르는 workspace scope를 거절해 grant 파일 전체를 못 읽는다. 옛 검증기는 모르는 **키**는 무시하므로 롤백해도 파일이
  읽히고 아무 권한도 주지 않는다. 기본 꺼짐이고 Mac 대화상자의 체크박스로만 켠다(기존 페어링은 아무것도 받지 않는다).
  체크하지 않은 대화상자는 요청 본문에 그 키를 싣지 않는다(`historyGrantFields`). 이어 열기는 보기를 포함한다.
  ⚠️ grant 저장은 통째 교체다. 기록 권한을 고치지 않는 프로젝트 패널(`AiTerminalPanel`)의 접근 허용 저장은 **저장 직전에 `/access`를 새로 읽어**
  그 연결의 `historyScopes`를 싣는다(`src/workroomAccessSave.ts` — 5초 폴링 상태를 쓰면 다른 창이 방금 끈 권한을 되살린다).
  ⚠️ **기록 권한은 허용한 범위 안에서만 따라간다.** QR 대화상자는 범위마다 기록을 허용하고, 패널 저장은 범위를 패널의 프로젝트·폴더로 바꾼다 —
  그대로 실으면 아무도 허용하지 않은 프로젝트로 기록 권한이 옮겨 갔다(리뷰 2026-10-16). 그래서 관리 목록이 그 권한을 허용한 범위
  (`historyGrantScope`, 로컬 관리 목록에만 — 와이어 아님, 폴더는 정체가 그대로일 때만)를 함께 싣고, 저장 범위가 같은 종류이면서 그 안일 때만
  싣는다(좁히기는 허용). 범위가 바뀌면 끈 채로 저장하고 그렇게 말한다. 못 읽으면(옛 사이드카·읽기 실패·형식 오류·범위 없음) 싣지 않는다 —
  fail-closed(기록 꺼짐)이고, 패널이 마지막으로 본 상태에 기록이 있었으면 그렇게 말한다.
- **기능 광고는 확장 답에만**(`protocol.capabilities.extended`). 레거시 8개 답에서 거른다 — 안 거르면 `conversations-v1`이 밀려난다.
  LAN 서버는 광고하지 않는다(LAN 페이지에 기록 화면이 없다). 광고하지 않는 옛 Mac이면 휴대폰은 화면 자체를 그리지 않는다.
- **동작 이름은 `workroom.` 밖**(`history.list`·`history.resume.review/execute/status`)이고, 커뮤니티 제어 실행기와 휴대폰 전달
  분기(`device`)가 **명시적으로 거절**한다(`REMOTE_HISTORY_COMMUNITY_REFUSAL`) — 커뮤니티 입장은 기록 권한이 아니다.
- **행은 불투명 id·제목·AI·상태·갱신 시각·revision·`resumable`뿐**이다(w14부터 `detail`을 물은 휴대폰에만 이유 `why` — 아래 「업데이트 뒤 작업 세션 이어 열기」). 프로바이더 대화 id·경로·세션/대상 id·계정 이름을 싣지 않는다.
  한 쪽 최대 20행이고 응답 7,000바이트에 맞게 자른 뒤 마지막 행부터 이어 읽는다(한글 제목은 글자당 3바이트).
  요청이 고른 프로젝트 밖의 대화는 어떤 id를 보내든 「찾지 못함」이다(`json_extract` 필터 + 커서의 대상 확인).
- **이어 열기는 로컬 review → execute → status를 그대로 쓴다** — 권한 우회 없음(`historyResume`이 bypass를 거절), 새 실행 경로 없음.
  요청 id는 연결(owner `device:<host>:<controller>`)별로 해시해 네임스페이스를 나눈다(`rh_` + sha256(owner, id)) — 다른 기기는 같은 id로
  아무것도 알 수 없다. ⚠️ owner는 **페어링 하나**다: 새 QR로 다시 페어링한 같은 휴대폰은 새 relay controller id라 다른 owner로 묻는다.
  review는 그 기기·그 프로젝트·그 대화에만 쓰인다. **grant는 실행 경계에서 다시 본다**: `perform(…, {allowed})`가 launch 직전
  `validate` 안에서 확인하고, 거기서 끊기면 영수증은 `rejected`다. 다른 CLI 계정으로 연 대화는 `account.select` 권한이 있어야 연다.
- ⚠️ **결과를 모르면 다시 실행하지 않는다.** 휴대폰은 execute를 보내기 **전에** `{host, conversationId, resumeRequestId, controlId, pairing, requestedAt}`을
  localStorage(`…pending-resumes.v2`, 첫 릴리스의 3-키 행은 `.v1`에서 읽고 지우기만 한다 — 옛 페이지가 새 행을 버리거나 덮지 않게 키를 나눴다)에 적고
  (못 적으면 실행하지 않는다), 응답 유실·새로고침·`unknown`은 모두 「결과 확인」(status)만 남긴다. status는 **그 요청을 보낸 프로젝트**에 먼저 묻는다 —
  휴대폰이 불러온 프로젝트 쪽에 그 id가 있든 없든(목록은 20개씩 나눠 받으므로 「안 보임」은 「없음」이 아니다). Mac이 그 프로젝트를 거절할 때만
  현재 프로젝트에 한 번 더 묻고(status는 아무것도 실행하지 않는다), 둘 다 거절되면 첫 거절을 보인다. 같은 연결의 같은 id 재전송은 영속 영수증으로 답해 두 번 띄우지 않는다.
  `pairing`은 relay controller id의 지문(`remoteHistoryPairing`, 휴대폰 밖으로 나가지 않는다)이다. `.v2`는 이 릴리스에서 `controlId`·`pairing`과 함께 나와 옛 페이지가 읽지 않는다.
- **「이어 열기」는 일부러 확인한다**(감사 2026-10-16). 확인 버튼이 「이어 열기」와 같은 자리·크기로 바뀌어서 두 번 탭 한 번에 review·execute가 나갔고,
  켜진 확인에는 취소가 없고 「새로 고침」 뒤에도 남았다. 지금은 제목 아래 따로 떨어진 블록(무엇이 열리는지 한 문장 + 「이 Mac에서 열기」·「취소」)이고,
  켠 지 500ms 안의 확인은 버튼 위에 떨어져도 무시하며(`REMOTE_HISTORY_CONFIRM_GUARD_MS`), 새로 고침·패널 닫기·Mac 전환이 끈다. 와이어는 그대로다.
  켜면 초점이 그 문장으로 가고(키보드·VoiceOver — 초점을 잃으면 WebKit의 다음 Tab이 프로젝트 선택으로 돌아갔다) 「취소」는 그 행의 「이어 열기」로 돌려준다.
  검증: `bun tests/remote-workroom-history-confirm.e2e.mjs`(Chromium 모바일·WebKit, 수정 전 코드에서 두 번 탭이 execute까지 보냈다).
  패널은 포털에서 `key={selectedHostId}`인 워크룸 블록 안에 있어 Mac을 바꾸면 다시 마운트된다 — 진행 중이던 요청의 결과는 새 Mac 패널에 쓰이지 않는다.
- ⚠️ **`not-recorded`는 증명될 때만**: Mac은 **묻는 연결(owner)**·id의 영수증이 없고 이 프로세스에서 그 id의 execute가 돌고 있지 않을 때 그렇게 답한다(영수증은 지우지 않는다).
  Mac은 같은 휴대폰의 이전 페어링을 볼 수 없으므로, **휴대폰은 그 요청을 보낸 페어링·프로젝트로 물었을 때만** 그 답을 믿는다(`settle`). 다른 페어링(새 QR),
  페어링을 모르는 행(첫 릴리스·당시 이름을 못 얻음), 다른 프로젝트로 물은 답(옛 Mac은 물은 프로젝트만 본다)의 `not-recorded`는 `unproven`이고 행을 남긴다
  — 「이전 연결로 보냈습니다」 또는 「단정할 수 없습니다」라고 말하고 지우기만 권한다. 이전 페어링의 행에는 「결과 확인」 대신 그 사실을 보인다(어차피 닿지 않는다).
  영수증이 다른 프로젝트에 있는데 그 프로젝트가 이 기기의 grant 밖이거나(게이트웨이가 호스트 전용 `targets`로 기기의 허용 대상을 넘긴다 — 와이어 아님),
  `record()`가 저널 오류를 삼켜 null이면 `unknown`이다. 예전엔 셋 다 `not-recorded`라 휴대폰이 유일한 손잡이를 지우고 「열리지 않았다」고 거짓말했다.
- **오래 `unknown`인 요청은 휴대폰이 정리한다**: 패널이 그 Mac의 미확정 요청을 **목록에 없는 대화까지** 모두 보이고(첫 렌더부터, 요약에 건수),
  「결과 확인」과 「목록에서 지우기」를 준다. 지우기는 「이 Mac이 이미 열었을 수 있다」는 확인을 거치고 Mac에는 아무것도 하지 않는다.
  상한은 Mac마다 32건(전체 64)이고 **보내기 전에** 거절하며 그 목록을 가리킨다. 같은 대화의 두 번째 미확정 요청은 덮지 않고 거절한다.
  전체 64건에는 **이 휴대폰이 더는 들고 있지 않은 Mac**(연결 해제·새 호스트 신원)의 행도 세므로, 어느 Mac의 「대화 기록」에서나 그 행들을
  「이 휴대폰에 연결되어 있지 않은 Mac에 보낸 요청」으로 보이고 같은 확인을 거쳐 지운다(`orphanedRemoteHistoryResumes` — 결과 확인은 없다).
  들고 있는 Mac은 저장된 연결(`sources`)과 연결 중인 Mac의 합집합이라, 아직 연결 중인 Mac을 「연결되어 있지 않음」으로 보이지 않는다.
- **오류는 경로 없이 나간다**: `prepareHistoryContext`의 Node `ENOENT … '<절대 경로>'`가 릴레이를 거쳐 휴대폰에 그대로 갔다. 원격 기록 호스트는
  안전한 한국어 문구만 통과시키고 나머지는 고정 문구로 바꾼다(`publicHistoryError`).
- 이어 열기가 끝나면(또는 결과 확인이 완료를 찾으면) 휴대폰이 **자기 세션 목록에 그 세션이 있을 때** 워크룸에서 고른다 — 기존 entry 경로에
  `keepDraft`를 실어 새 작업 작성칸의 초안·대상·AI는 그대로 둔다(`src/aiTerminalEntry.ts`). 와이어 키는 늘리지 않았다.
  ⚠️ **keepDraft entry는 진행 중인 「작업 시작」의 성공 뒤 정리를 막지 않는다**(통합 리뷰 w4, finding 1). `start()`는 「더 새 초안이 왔는가」를
  entry nonce(`applied`)가 아니라 작성칸 내용을 바꾸는 것만 올리는 `draftGeneration`으로 본다 — nonce로 보던 동안 시작 중에 도착한 keepDraft
  entry가 성공 뒤 비우기를 건너뛰게 해, 이미 시작한 요청이 켜진 시작 버튼 아래 남았다(두 번째 누름 = 같은 첫 요청의 두 번째 CLI).
  ⚠️ **자동 선택은 그 요청을 보낸 Mac이 아직 보일 때만 한다**(`selectResumedSessionOn`, 통합 리뷰 w4, finding 2). 포털의 워크룸 entry는 Mac별이
  아니라서, Mac A에서 시작한 이어 열기·결과 확인이 Mac B로 바꾼 뒤 끝나면 A의 세션이 B의 워크룸에 적용돼 B의 프로젝트·AI·선택을 덮었다.
  콜백이 만들어진 때의 Mac과 `selectedHostIdRef`를 목록 요청 앞뒤로 비교하고, 다르면 고르지 않는다(그 요청의 기록은 A 밑에 그대로 남는다).
- ⚠️ **화면은 `.ai-terminal-panel` 밖이다** — 포털이 `AiTerminalPanel`의 형제로 붙인다. 그래서 `.ai-terminal-panel …` 규칙이 하나도 닿지 않아
  실기(아이폰 13 Pro Max, 2026-10-16)에서 프로젝트 select가 가장 긴 이름 폭(~462px)으로 열 밖까지 늘어 페이지가 옆으로 스크롤됐고
  「불러오기」가 45×19pt였다. 지금은 토큰·공용 컨트롤 규칙이 `:is(.ai-terminal-panel, .ai-terminal-history)`를 함께 쓰고 배치는
  `AiTerminalPanel.css`의 history 절(select는 `minmax(0,1fr)` 칸·`overflow:hidden`, ≤640px·`pointer:coarse`에서 44px)이다.
  새 클래스를 쓸 때 `.ai-terminal-panel` 아래에만 정의하지 말 것. 검증: `tests/remote-workroom-history-layout.e2e.mjs`(Chromium·WebKit,
  390/428/가로 926 — 문서 폭·select 끝·44px·거절 문구) + `tests/remote-workroom-history-layout.test.ts`(규칙 계약).
- 검증: `tests/workroom-history-remote.test.ts`(와이어 엄격성·행 키 허용 목록·게이트웨이 권한 경계·전달 거절·대상 필터·응답 유실 뒤
  status·`unknown` 재실행 없음·실행 경계 재확인·계정), `tests/remote-workroom-history-client.test.ts`(휴대폰 쪽 정확히 한 번·옛 Mac),
  `tests/remote-terminal-grant.test.ts`(옛 검증기 사본이 새 파일을 읽음), `tests/remote-control-core.test.ts`(레거시 8개),
  `tests/agent-dialogue-control.test.ts`(커뮤니티 거절), `tests/workroom-access-save.test.ts`(패널 저장이 기록 권한을 새로 읽어 허용 범위 안에서만 싣고,
  범위가 바뀌거나 못 읽으면 싣지 않음), `tests/workroom-history-remote.test.ts`의 「phone ↔ real Mac host」(실제 호스트: 다시 페어링한 뒤의 `not-recorded`를
  믿지 않음), `tests/remote-workroom-history-client.test.ts`의 리뷰 묶음(페어링·프로젝트 규칙, 불러오지 않은 쪽의 프로젝트, 거절 뒤 한 번만 대체, 연결되지 않은 Mac의 행).
  `tests/workroom-usability.e2e.mjs`의 `keep-draft-entry-during-a-{plain-start,launch}-still-clears-the-started-request`(시작 중 도착한 keepDraft entry —
  고치기 전 코드에서 실패), `tests/remote-workroom-history-client.test.ts`의 「selecting the resumed session only on the Mac it was resumed on」
  (목록 요청 중·전에 Mac을 바꾸면 적용 안 함, 포털이 그 경로를 씀 — 새 export라 수정 전에는 실패).
  ⚠️ 실제 휴대폰·실제 CLI 재개는 아직 확인하지 않았다(정리 목록·자동 선택 흐름 자체는 브라우저 e2e 없음 — 서버 렌더·순수 함수로만 검사).

## 업데이트 뒤 작업 세션 이어 열기 (w14, 2026-10-16)

앱을 설치하면 사이드카가 끝나고 실행 중이던 워크룸 CLI도 모두 끝난다. 예전에는 그 세션들이 「종료됨」과 「재시작 전」으로
무작위로 갈리고 일부는 「이어 열 수 없음」이었다. 이제 다음 부팅이 **사람이 누를 때 한 번** 다시 연다. 정본: 저장 `src/workroomConversationJournal.ts`
(부팅·안내·확인 기록)·판정 `src/workroomConversationService.ts`(`availability`·`restart.list`)·Codex 근거 `src/workroomRestartBinding.ts`·
일괄 실행 `src/workroomRestartBatch.ts`·화면 `src/WorkroomRestartBanner.tsx`+`src/workroomRestartText.ts`.

- ⚠️ **우리 종료가 일으킨 종료는 대화의 끝이 아니다**(R1). `shutdown()`이 SIGTERM 뒤 200ms를 기다리는 동안 먼저 끝난 CLI는 종료 처리기에서
  `history.ended`를 불러 「종료됨」이 됐고, SIGKILL이 필요했던 CLI만 「재시작 전」이 됐다. 이제 `exitCause==='shutdown'`이면 종료 처리기가
  기록하지 않는다(그 세션의 대화는 shutdown이 실행 중에 이미 확인했다). 행은 `running`으로 남고 다음 부팅이 `detached`로 바꾼다.
- **종료 기록에 기대지 않는다.** 사이드카는 종료 코드 없이 끝나는 길이 많다(24초 한도의 `process.exit`, 27초 네이티브 SIGKILL, Windows의 모든 종료,
  크래시·전원). `started()`가 이미 `running` 행을 남기므로 다음 부팅이 그것에서 목록을 만든다. 부팅마다 `workroom_boots` 한 행(pid·build·열린 때·
  마지막 신호·닫힌 때)을 남기고, 닫히지 않았고 pid가 답하고 마지막 신호가 150초 안인 부팅은 **살아 있는 것**으로 본다 — 같은 데이터 폴더의 두 번째
  사이드카(`bun api-server.ts`)의 실행 중 세션을 떼어 내지 않는다(R7). 신호는 `started()`와 세션이 도는 동안 60초 틱이 남긴다. 판정은 열 때와
  `restart.list`마다 다시 한다. 「다른 부팅 실행 행 24개 초과면 저장소 전체를 못 연다」던 throw는 없어졌다(한 번에 512행씩).
- **곁 표만 더했다** — `workroom_boots`·`workroom_restart_offers`·`workroom_session_facts`(권한 우회 여부)·`workroom_binding_checks`(부정 결과 캐시)·
  `workroom_session_inputs`(세션이 입력을 받은 적이 있는가), 모두 `CREATE TABLE IF NOT EXISTS`. `workroom_meta` 버전도 대화 본문 키도 바꾸지 않았다(`#decode`가 모르는 키를 거절한다 — 옛 앱이 롤백 뒤 그대로 연다).
- **안내 = 재시작 한 번**: 죽은 부팅에서 떼어 낸 행 중 보관·제한(CS 대직)이 아니고 마지막 신호가 72시간 안인 것으로 `open` 안내 하나를 만든다(최대 64행).
  더 새 재시작은 열린 안내를 `superseded`로 바꾸며 아직 `detached`인 행을 넘겨받는다(연달아 두 번 설치해도 잃지 않는다), 72시간 지나면 `expired`.
  「닫기」(`restart.dismiss`, 요청 ID로 멱등, 모든 창·휴대폰이 공유)와, 할 일이 남지 않았고 그중 하나라도 다시 열린 첫 `restart.list`(`done`) 뒤에는
  **다시 나오지 않는다.** 처음부터 아무것도 열 수 없는 안내(Hermes·agy·저장된 대화 없음)는 이유와 함께 한 번 남아 사람이 닫을 때까지 보인다 — 조용히 끝나면
  사용자는 그 세션들이 왜 사라졌는지 몰랐다(리뷰 18). 대체된(`superseded`) 안내를 닫으면 그 안내의 행을 새 안내에서도 뺀다(리뷰 9 — 예전엔 닫은 행이 돌아왔다).
  행은 무슨 일이 있어도 「저장된 대화」에 남는다. 제목은 이전 부팅의 build가 다를 때만 「업데이트 전…」이고 아니면 「앱을 다시 열기 전…」(크래시는 업데이트가 아니다).
- **판정은 한 함수다**(`availability`, 닫힌 목록 `WORKROOM_RESTART_AVAILABILITY`): ready · check · in-flight · pending · running · open-elsewhere ·
  unsupported(Hermes·agy) · unsaved(첫 요청 전에 끝남) · ambiguous · legacy · project-changed · account-changed · unprepared(프로젝트·CLI 계정을 준비하지
  못함 — 리뷰 12). 버튼의 N은 ready+check다. ⚠️ **`ready`는 이 Mac이 지금 확인했을 때만이다**(리뷰 4): 저장된 대화 + 프로젝트·계정 지문을 확인한 답을
  프로세스 메모리에 120초 두고(`#probed`), 그 밖의 행은 verified여도 `check`다 — 토큰 갱신으로 `auth.json`이 바뀐 행이 「이어 열 수 있음」으로 세어졌다.
  휴대폰 기록의 `resumable`도 이 답을 쓴다(R3 — 예전엔 `binding==='verified'`만 봐서, Mac은 여는 Claude 대화를 휴대폰은 「이어 열 수 없음」이라 했다).
  `restart.list`는 확인 안 된 행을 한 번에 8개까지 실제로 확인한다(계정 준비 + 전사/rollout 읽기) — 확인되면 그 자리에서 `verified`로 묶고,
  아니면 그 revision에 대해 부정 결과를 캐시한다. 휴대폰 「대화 기록」 한 쪽도 8개까지 확인하고(리뷰 5 — 행만 보고 「이어 열기」를 말하지 않는다), 리뷰가
  저장된 대화를 못 찾으면 `unsaved`를 남겨 다음 목록이 이유를 말한다. 살아 있는 리뷰가 있는 행은 확인이 묶지 않는다(리뷰 10 — 그 revision을 execute가 쓴다).
  리뷰 문구도 둘로 나눴다: 「프로젝트 폴더가 바뀜」과 「CLI 로그인 상태가 바뀜」(R6 — 지문은 그대로; D1은 사용자 결정으로 남았다). 계정 쪽 이유는
  「다시 로그인」을 권하지 않는다 — 로그인도 그 파일을 다시 써서 지문이 돌아오지 않는다(리뷰 6). Mac 저장 목록은 `list`에 `detail`을 붙여 이유 한 구절을
  받고 열 수 없는 행에는 「이어 열기」를 그리지 않는다(옛 사이드카가 거절하면 한 번 묻고 그 뒤로는 그냥 묻는다).
- **Codex 스레드 id가 없는 행**(R2): 그 폴더·그 수명(시작−10초 ~ 종료 또는 부팅 마지막 신호+60초, +10초, 그 부팅 뒤 처음 열린 부팅을 넘지 않음)의 대화형
  CLI rollout이 **정확히 하나**이고 다른 행이 이미 쓰지 않고 사용자 턴이 있을 때만 묶는다(`bindDerived`, revision CAS). ⚠️ **판정은 함께 한다**(리뷰 3):
  스레드를 모르는 같은 프로젝트·계정의 다른 Codex 행이 그 rollout이 시작될 때 살아 있었으면 둘 다 `ambiguous`다 — 한 행씩 세던 동안 새 행(아무 말도 안 함)이
  먼저 확인돼 옛 행의 rollout을 가져가고 진짜 주인은 「첫 요청 전에 끝남」이 됐다. 입력을 받은 적이 없는 세션(`workroom_session_inputs`, 시작 때 + 첫 입력 때
  기록)은 rollout을 쓸 수 없으므로 `unsaved`이고 경쟁하지 않는다; 기록이 없는 옛 행은 경쟁한다. 0개는 unsaved, 2개 이상은 ambiguous, 상한을 모르는 옛 부팅은
  legacy — 추측하지 않는다. rollout 첫 줄만 16KiB씩, 한 번에 8MiB까지 읽는다. 리뷰도 같은 판정을 하고 바뀐 revision을 돌려준다(Mac 저장 목록은 실행 때
  **리뷰의 revision**을 쓴다). ⚠️ **실행 중인 Codex는 스레드 잠금만이 근거다**(리뷰 2): `resolveCodex`는 lsof가 있는 플랫폼에서 잠금을 못 찾으면 null이다
  (아직 말하지 않았다 — 폴더·시간 창 일치는 옆 워크룸의 rollout을 가져갔다; Windows만 그 일치를 쓴다). 그래서 60초 틱(입력이 있었던 세션 최대 4개)·shutdown
  확인은 말한 세션만 묶고, 끝난 Codex 세션의 종료 확인은 창 일치로 묶지 않는다 — 위의 함께 하는 판정이 나중에 맡는다.
- **결과를 모르는 이어 열기**(R4): 부팅이 바뀌면 `prepared`였던 이어 열기는 `unknown`이 되고 그 대화를 영영 잠갔다. 이제 사람이 작업 세션 목록에서
  열려 있지 않음을 확인하고 「확인했음」을 누르면(`resume.settle` — 경고문, 500ms 이중 클릭 방지, `unknown`일 때만, 이 부팅의 `prepared`면 거절, 요청 ID로 멱등)
  잠금이 풀린다. 영수증은 중복 방지 기록으로 남는다. 리뷰가 그 상태에 `WORKROOM_RESUME_UNSETTLED_REASON`을 돌려주면 Mac 저장 목록도 같은 버튼을 보인다.
- **정확히 한 번은 기존 길 그대로다.** 「N개 이어 열기」 → 확인(「권한 우회 없음」, 500ms 안의 누름 무시) → 행마다 review → (sessionStorage에 영수증) → execute.
  두 창이 동시에 눌러도 두 번째 예약이 CAS로 실패한다. 응답을 잃으면 그 행에서 멈추고 다시 보내지 않는다(「결과 확인」). 창을 저절로 열지 않는다.
  ⚠️ **한 번은 행이 아니라 프로바이더 대화마다다**(리뷰 1): 두 행이 한 대화를 가리킬 수 있다(세션 안의 Codex `/resume`). `prepareResume`이 같은 트랜잭션에서
  같은 대화를 가진 다른 행이 실행 중이거나 이어 열기가 `prepared`/`unknown`이면 거절하고(`WORKROOM_PROVIDER_BUSY`), 그 행은 `open-elsewhere`다.
  행의 「이어 열기」도 일괄처럼 확인을 거친다(리뷰 16). 확인 블록과 그것이 대신한 버튼은 다른 요소라(key) 「취소」 위의 Enter·Enter가 「닫기」를 누르지 않고,
  초점은 확인 문장으로 갔다가 무장한 버튼으로 돌아온다(리뷰 11·15). 제목은 모든 세션 수, 버튼은 열 수 있는 수다(리뷰 17). 같은 프로젝트·AI 행은 이름 아래
  「10월 16일 14:04 시작」으로 갈리고 확인·요약은 이름에 시각을 붙인다(`restartRowLabeler`, 리뷰 14).
- **권한 우회로 다시 열지 않는다** — 기록 재개 경로가 원래 거절한다. 그렇게 열었던 세션은 「승인 없이 실행 (권한 우회)이었음 · 우회 없이 열림」.
- 와이어: 같은 경로(`workroom-history-v1`)에 새 동작만(`restart.list`·`restart.dismiss`·`resume.settle`), 기존 결과에 새 키 없음. 옛 사이드카는 400 →
  배너가 아무것도 그리지 않는다. Rust는 바뀌지 않았다. macOS 밖에서는 `restart.list`가 null이다(리뷰가 거절하는 버튼을 보이지 않는다).
- 자리: 메인 창은 「대화 세션」의 이 기기 칸, 실행 목록 바로 위. 팝아웃은 `AiTerminalPanel`의 `restartBanner` 칸 — Mac에서는 세션 목록·터미널 **위**
  (첫 화면에서 보이고, 처리되면 사라진다), 휴대폰 목록(`sessionFullscreen`)에서는 세션 행 **뒤**(첫 행 위치를 지킨다; 세션이 없으면 빈 목록 안내 자리).
  ⚠️ **모드마다 자리는 하나다** — 실행 세션 수로 자리를 바꾸면, 일괄 이어 열기 도중 첫 세션이 뜨는 순간 배너가 다시 마운트되며 진행 상태를 잃었다.
  다른 기기 패널에는 넘기지 않는다. 저장 목록의 상태 글자는 「앱 재시작으로 끊김」(휴대폰 「대화 기록」도 같다).
- 검증: `tests/workroom-restart-offer.test.ts`(안내 생성·한 번·닫기·넘겨받기·만료·보관·30행·살아 있는 부팅·150초·Codex 정확히 하나/여럿/다른 행 것/
  +70초 밖/사용자 턴 없음/legacy·settle·동시 두 일괄=행마다 한 번·응답 유실 뒤 실행 없음·휴대폰 R3·macOS 밖), `tests/workroom-restart-shutdown.test.ts`
  (실제 터미널 서비스: shutdown이 끝낸 세션이 `detached`+verified로 돌아옴 — 수정 전 「ended」, 틱이 입력 뒤 확인, 권한 우회 세션이 우회 없이 열림),
  `tests/workroom-restart-text.test.ts`, `bun tests/workroom-restart-banner.e2e.mjs`(격리 Vite + 합성 호스트: 제목·N·500ms·행마다 review→execute 한 번·
  창 없음·닫기 한 번·「확인했음」·옛 사이드카 무표시·팝아웃 자리·저장 목록 settle). ⚠️ 실제 앱 설치·실제 CLI로는 아직 확인하지 않았다.

### 휴대폰 — `workroom-restart-v1` (Build B)

휴대폰 포털 워크룸(이 Mac의 패널만, 커뮤니티 기기 패널에는 없다)도 같은 안내를 보인다. 정본: 와이어 `src/workroomHistoryRemoteProtocol.ts`·Mac
`src/workroomHistoryRemoteHost.ts`·클라이언트 `src/remoteWorkroomRestartClient.ts`·화면 `src/RemoteWorkroomRestartBanner.tsx`.

- **기존 기록 채널에 동작 둘**: `history.restart`(`history.read`, 요청 `{}`)·`history.restart.dismiss`(`history.resume`, `{offerId, expectedRevision,
  dismissRequestId}` — 호스트 id는 이어 열기처럼 `rh_`+sha256(owner, id)라 연결(페어링)마다 네임스페이스가 갈리고 멱등). `history.list`는 `detail:true`를
  받으면 행마다 `why`(닫힌 코드, 열 수 있으면 null)를 싣는다 — 옛 휴대폰은 묻지 않으므로 7키 그대로다. 커뮤니티 제어·기기 전달은 둘 다 거절한다.
- ⚠️ **기능 이름은 확장 답에만**(`protocol.capabilities.extended`, `workroom-history-v1` 바로 뒤, 16칸 중 12칸 — w13의 `workroom-attach-v1`이 맨 끝에 붙어 합친 트리는 13칸(`remoteControlHostSupportedFeatures`), tasks-v1이 켜지면 14칸). 레거시 8개 답에서 둘 다 거른다(합친 트리의 레거시 8개는 origin/main과 같음 — `tests/remote-control-core.test.ts`의 「merge w13+w14」). **옛 Mac의 요청
  정규화기는 두 동작과 `detail`을 거절한다** — 그래서 휴대폰은 그 기능을 광고한 Mac에만 보내고, 릴레이 컨트롤러도 기능이 없으면 보내기 전에 「Mac 앱 업데이트
  필요」로 막는다(`tests/fixtures/workroom-history-remote-request-v1.ts`가 옛 정규화기 사본이다). LAN 서버는 광고하지 않는다.
- **행은 휴대폰의 control id로만 나간다**(`project`) — 게이트웨이가 호스트 전용 `controlIds`(runtime → control, 그 기기가 쓸 수 있는 것만)를 넘기고, 거기 없는
  프로젝트의 행은 빠진다(`complete:false`). runtime id·세션 id·경로·프로바이더 id·계정 이름은 싣지 않는다. 응답은 7,000바이트에서 끝에서부터 잘린다(`more`).
  가용성 목록은 Mac 것에 둘을 더한 닫힌 목록이다: 열 수 있었을 행이 이어 열기 권한이 없으면 `grant`, 다른 CLI 계정이고 계정 선택 권한이 없으면 `account`.
  휴대폰 목록은 Mac 목록을 import하지 않고 적어 둔다 — Mac이 값을 더하면 Mac이 대응시켜야지 옛 휴대폰이 답 전체를 거절하게 두면 안 된다(타입 검사가 포함을 지킨다).
- **묻는 프로젝트는 통로일 뿐이다** — 두 동작에 한해 게이트웨이는 요청의 control id가 그 연결이 받은 것인지만 보고, 그 프로젝트의 이용 허락은 요구하지 않는다
  (안내는 그 기기가 쓸 수 있는 **모든** 프로젝트에 관한 것이다). 그렇지 않으면 첫 프로젝트를 허락받지 않은 휴대폰은 배너를 영영 못 봤다. 행은 여전히 Mac이 grant로 자른다.
- **닫기는 모든 행을 보는 휴대폰만** — 안내는 Mac과 모든 창·휴대폰이 공유하므로, 일부 행을 못 보는 휴대폰의 닫기는 Mac이 거절한다(`REMOTE_RESTART_PARTIAL_DISMISS`).
  그 휴대폰은 「이 휴대폰에서 숨기기」(localStorage `agentstoz.remote.workroom-restart.hidden.v1`, Mac·안내별, try/catch)만 준다. 이어 열기 권한이 없어도 그렇다.
  ⚠️ **닫을 수 있는지는 Mac이 말한다**(`closable` = 이어 열기 권한 && 모든 행을 봄, 리뷰 7) — 휴대폰이 `grant` 행으로 추측하던 동안 `pending`뿐인 안내에서
  읽기 전용 휴대폰에 「닫기」가 보였다. 대체된 안내의 닫기는 그 행들을 새 안내에서 빼고(모든 행을 볼 때만), 이미 닫힌·끝난 안내는 아무것도 닫지 않고 지금 안내로 답한다.
- **읽기 권한이 없는 휴대폰도 조용하지 않다**(리뷰 13): 게이트웨이는 `history.restart`만 `history.read` 없이 받아 호스트에 `canRead:false`로 묻고, 호스트는
  그 기기 프로젝트의 세션 **수만**(`unlisted`, 행·제목 없음) 답한다. 배너는 「업데이트 전 작업 세션 N개 · 보기」 + 어떤 권한이 필요한지 한 문장 + 숨기기다.
  다른 기록 동작은 여전히 읽기 권한이 있어야 한다. `RemoteRestartOffer`의 키는 `closable`·`unlisted`, 행은 `createdAt`이 더해졌다(이 기능은 아직 배포 전이다).
- **「N개 이어 열기」 = 행마다 `resumeRemoteHistory`** — 보내기 전에 휴대폰에 요청을 기록하고, 한 번에 하나씩, 그 행의 프로젝트(`project`)로 보낸다. 결과를 모르면
  (응답 유실·unknown·unproven) 거기서 멈추고 다시 보내지 않는다(그 행은 「결과 확인」). 휴대폰이 아직 정리하지 않은 요청이 있는 행은 「이어 열기」 대신 「결과 확인」이고
  일괄에서 빠진다. 오프라인이 되면 다음 행을 보내지 않는다. 세션 화면을 저절로 열지 않는다. 배너와 접힌 「대화 기록」은 서로의 요청 기록이 바뀌면 다시 읽는다
  (`REMOTE_HISTORY_PENDING_EVENT` — 같은 페이지의 localStorage 쓰기에는 `storage` 이벤트가 없다).
- 화면: 접히면 44px 버튼 하나·16px 글자(「업데이트 전 작업 세션 3개 · 이어 열기 ›」 — N은 목록의 모든 세션, 열 것이 없으면 「… · 보기」). 펼치면 행마다 한 구절(44px 행), 「N개 이어 열기」와
  행의 「이어 열기」는 따로 떨어진 확인 블록(「이 Mac에서 N개 대화를 다시 엽니다 · 권한 우회 없음」, 500ms 안의 누름 무시, 초점이 들어가고 「취소」가 돌려준다).
  권한이 없으면 「이어 열기 권한이 없습니다 · …허용하세요」 한 문장과 여는 버튼 없음. 묻는 때: 워크룸이 보이고 Mac이 연결됐을 때·`online`·동작 뒤 — 타이머 없음.
  「대화 기록」은 그 기능이 있는 Mac에 `detail`을 묻고 「이어 열 수 없음」 대신 이유 한 구절을 보인다. 행 하나의 「이어 열기」로 연 세션은 「대화 기록」처럼
  그 세션 화면을 열고(`selectResumedSession`, 리뷰 19), 「N개 이어 열기」 뒤에는 세션 목록만 바로 다시 읽는다(`AiTerminalPanel`의 `listRefresh`) — 저절로 열지 않는다.
  Mac에 기록이 없는 요청은 「이 요청으로는 대화가 열리지 않았습니다」라고 요청에 대해서만 말한다 — 같은 대화를 Mac이 직접 열었을 수 있다(리뷰 8).
- 검증: `tests/workroom-restart-remote.test.ts`(와이어 엄격성·행 키 허용 목록·grant 밖 행 제외·control id·7,000바이트·grant/account·닫기 권한·일부만 보는 휴대폰
  거절·멱등·소유자 네임스페이스·`detail`·옛 정규화기 거절·게이트웨이 통로·실제 호스트로 행마다 한 번), `tests/remote-workroom-restart-client.test.ts`(일괄:
  보내기 전 기록·첫 unknown에서 멈춤·응답 유실·오프라인·화면 상태·실제 E2EE 릴레이로 확장 답에만 광고·기능 없는 Mac에는 안 보냄), `tests/remote-control-core.test.ts`
  (레거시 8개 그대로), 포털 빌드 + `bun tests/remote-workroom-restart.e2e.mjs <dir> [shots]`(WebKit·Chromium, 390×844·375×667·926×428·844×390: 첫 실행 행 상자가
  배너 유무로 같음·44px·16px·가로 스크롤 없음·두 번 탭 무전송·확인 버튼이 손가락 아래 아님·행마다 review→execute 한 번·Hermes 행 안 보냄·권한 없음 문장·숨기기가
  새로고침 뒤에도 유지·닫기 한 번·기록의 이유 구절 — 변경 전 포털 빌드에서 실패). ⚠️ 실기 iPhone·실제 Mac 앱으로는 아직 확인하지 않았다.
- 리뷰(2026-10-16) 회귀: `tests/workroom-restart-review.test.ts`(16건 — 한 대화 두 행·잠금 없는 실행 중 Codex·끝난 Codex·함께 하는 판정·입력 기록 없음·바뀐 계정
  지문·휴대폰 목록 확인·unprepared·Hermes만의 안내·대체된 안내 닫기·리뷰 뒤 목록·closable·읽기 권한 없는 수·시작 시각·기록 없는 요청 문구; 모두 수정 전 코드에서
  실패), `tests/ai-terminal-resume.test.ts`(잠금 없는 실행 중 Codex — POSIX null, Windows rollout), `tests/remote-workroom-restart-client.test.ts`(화면: closable·
  읽기 권한 없음·이름과 시작 시각), Mac e2e 6–8단계(키보드·행 확인·쌍둥이 행·저장 목록 이유·옛 사이드카·닫기 뒤 지금 안내), 휴대폰 e2e(읽기 권한 없음·행 하나 열기·
  일괄 뒤 바로 목록). ⚠️ 리뷰 6의 「같은 계정으로 다시 로그인하면 열린다」는 이루지 않았다 — 계정 지문을 느슨하게 할지(D1)는 사용자 결정이다.
