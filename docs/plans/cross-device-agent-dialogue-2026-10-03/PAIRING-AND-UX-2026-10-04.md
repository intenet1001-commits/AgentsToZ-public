# 기기 간 대화 — 30일 상호 페어링과 화면 결함 (2026-10-04)

**상태: 1~7 구현 완료.** 남은 것은 ① 라이브 Supabase 마이그레이션 적용(사용자 승인 대기)과
② 2·3호에 같은 버전 설치 후 1↔2·1↔3·2↔3 실기 재시험이다. 계약은 `CLAUDE.md`의
「기기 간 대화 — 30일 상호 페어링과 자동 입장」과 「워크룸·OPS 손질」이 정본이고, 아래는 그 근거다.

1호에서 3호 OPS로 실제 통신 테스트를 한 뒤 나온 항목이다. 테스트는 **3호 입장 단계에서 멈췄고**
(방 `4e8d97f7…`, 1호 이벤트 `seq1 joined`·`seq2 message`뿐, 3호 `joined` 없음) 그 막힘이 아래 설계의
결과였다. 측정값과 코드 위치를 함께 남긴다.

## 1. `peers`가 100개에서 잘린다 — 다른 기기가 보이지 않는 직접 원인 ✅

`agentDialogueSql.ts`의 `peers` 분기와 미러 마이그레이션
(`20261004010000_agent_dialogue_peer_priority.sql`)이 `order by case when kind='ops' then 0 else 1 end,
last_seen_at desc, endpoint_id limit 100`이다.

실측(2026-10-04): 1호가 101개를 공개한 뒤 3호의 프로젝트가 **38개 → 3개**로 줄었다. OPS는 정렬
우선순위 덕에 남았지만 프로젝트는 `last_seen_at` 경쟁에서 밀렸고, heartbeat 순서가 돌기 때문에
호출마다 보이는 목록이 달라졌다.

- 단순 제거는 payload가 무한정 커진다(엔드포인트 1,000개면 수백 KB가 MCP 응답으로 나간다).
- 그래서 **기기별 공평 배분**으로 바꾼다: ① 모든 기기의 `ops` 먼저, ② 그 다음 기기마다 N개씩
  라운드로빈, ③ 전체 상한을 올리고(500) `deviceId`·`search` 선택 인자로 좁힐 수 있게 한다.
- 한 기기가 몇 개를 공개하든 **다른 기기의 대상은 반드시 목록에 들어온다**가 이 변경의 불변식이다.

## 2. 공개 대상 목록이 실제 등록 상태를 반영하지 않았다 ✅

`AgentDialoguePanel.tsx`의 선택 상태가 `useState<string[]>(['ops'])`로 하드코딩되어 `status.enabled`와
한 번도 동기화되지 않았다. 그래서 101개 중 여러 개가 등록돼 있어도 머리글이 항상 「1/101개 선택」이고
OPS 하나만 연결된 것처럼 읽혔다.

- 판정을 `src/agentDialoguePublishRows.ts` 한 곳으로 옮겼다. **체크박스는 공개 상태 그 자체**이고,
  체크하면 공개, 해제하면 연결 끄기다. 진행 중인 변경은 의도를 보여 준다(`pending`).
- ⚠️ **해제는 파괴적이다**: `disable`이 endpoint를 `revoked`로 만들고, 다시 켜면 **새 `endpointId`**가
  발급된다(`register_endpoint`는 incarnation이 다르면 새 행을 넣는다). 걸려 있던 초대·대화방은
  따라오지 않는다. 그래서 행마다·전체 해제마다 확인 단계를 둔다.
- 앱 목록에 없는 공개 대상(프로젝트 해제·삭제)도 행으로 남겨 끌 수 있게 한다(`missing`).
- 101개를 4줄 상자에 검색 없이 넣던 문제는 검색 + `useIncrementalRender`로 바꿨다.
- 중복이던 하단 `등록된 대상` 목록은 없앴다(체크박스가 같은 사실을 말한다).

## 3. 30일 상호 페어링 — QR 원격제어와 같은 수명 ✅

현재 수치(`src/agentDialogueHost.ts`): `GRANT_TTL` **30분**, `APPROVAL_TTL` **5분**, 방 만료 **24시간**,
유휴 2시간. `enable`만 영구다. 그래서 방마다 양쪽이 다시 수락해야 하고, 그게 "너무 불편하다"의 실체다.

- 새 단위 **페어링**: `(profileId, 내 endpointId, 상대 endpointId)`에 양쪽 1회 수락, **30일** 만료,
  어느 쪽이든 즉시 해지. 로컬은 `enable` 저장 파일과 같은 자리에 0600으로, 원격은 새 테이블 +
  service-role RPC. 1·2·3호는 쌍마다 한 번씩 수락하는 **메시**다(3기기면 3쌍).
- 페어링된 쌍에 대해서는 `create`/`invite`/`join`/`send`/`read`가 UI 승인 없이 grant를 자동 재발급한다.
- **자동 입장이 함께 있어야 의미가 있다.** 오늘 3호가 멈춘 지점은 승인이 아니라 「입장을 호출하는
  주체가 없음」이었다. 페어링된 상대의 초대는 사이드카가 사람 없이 `join`하고, 받은 메시지를 앱
  알림(또는 지정 워크룸 초안)으로 떨어뜨린다.
- 지키는 경계: 페어링은 **그 정확한 endpoint 쌍**에만 적용하고 incarnation이 바뀌면 무효. 같은
  `memoryId`·같은 이름은 근거가 아니다. 받은 본문의 도구 실행 지시는 자동 실행하지 않는다.
  해지 기록 실패는 삼키지 않는다(원격제어 해지와 같은 규칙).

## 4. 워크룸 「세션 기억하기」 — 버튼 둘이 다른 일을 하는데 같은 이름으로 보인다 ✅

| 버튼 | 지금 하는 일 |
|---|---|
| 머리 「세션 기억하기…」 | `App.tsx`의 `requestSessionMemory` → 작성칸에 한국어 지시문 **초안만** 넣는다. 전송은 사람이 누른다 |
| 하단 「지금 저장」 | `workroom.save` → 호스트가 **새 프로세스**로 저장(git + sessionContext 주입) |

사용자가 기대한 동작은 머리 버튼이 **살아 있는 CLI에 슬래시 명령을 넣고 Enter**까지 치는 것이다.
그 경로가 더 정확하다 — 대화 맥락을 그대로 가진 주체가 쓰기 때문이다(이 저장소의 기존 서술과 같다).

- 주입 경로는 이미 있다: `runSlashCommand(command)` → `sendBoundInput(command+'\r')`.
  `isValidSlashCommand`는 `/remember-session`을 이미 허용한다(하이픈 포함).
- 에이전트마다 명령이 다르다: **claude → `/remember-session`**, hermes → `/remember_session`,
  codex·agy → 그런 슬래시 명령이 없으므로 **기존 초안 경로 유지**. 매핑은
  `workroomCliCommands.ts` 한 곳에 둔다.
- 라벨이 무엇을 하는지 말하게 한다: 머리 「이 세션에서 기억하기」(살아 있는 CLI), 하단
  「앱에서 저장」(별도 프로세스). 둘 다 쓸모가 있으므로 지우지 않는다.

## 5. 「저장 상태 확인」 — 동작하지만 저장 중에는 죽은 것처럼 보인다 ✅

`WorkroomSessionFooter.tsx`의 `refresh()`는 `workroom.status`를 읽어 저장 상태와 「마지막 기억 저장」을
갱신한다. 3~15초 주기로 스스로도 돈다. 즉 기능은 동작한다.

⚠️ 다만 `refresh()`가 `if(flight.current||saveFlight.current)return;`로 **조용히 빠진다**. 저장이
진행되는 동안 누르면 아무 반응이 없어 고장으로 읽힌다. 진행 중이면 「저장 중 · 결과를 기다립니다」를
그 자리에 표시한다.

## 배포 순서

1. 이 브랜치(`codex/dialogue-peer-priority`)에서 위 변경 + 테스트.
2. `codex/shared-workroom-shell`(v584, 설치본)로 머지 — 거기서 바로 빌드하면 13커밋이 되돌아간다.
3. `bun run verify` 통과 → 커밋(버전 날짜는 마지막 커밋 날짜다) → DMG 빌드·설치 → push.
4. **라이브 Supabase 마이그레이션은 사용자 승인 뒤에만** 적용한다. `peers` 변경은 함수 재정의라
   표를 잠그지 않는다. 페어링 테이블은 새 표·RPC·RLS가 필요하다.
5. 2호·3호에 같은 버전을 설치한 뒤 1↔2, 1↔3, 2↔3 세 쌍으로 재시험한다.

## 6. 「새 작업 요청 작성」 — 접기 토글이 아니라 새 창이어야 한다 ✅

지금 이 버튼은 `AiTerminalPanel.tsx:486`의 **접기/펼치기 토글**이다(`workroom-composer-toggle`,
라벨이 `작업 요청 접기`/`작성 중인 요청 다시 보기`/`새 작업 요청 작성`으로 돌아간다). 실행 중인
세션이 있을 때 빈 칸을 접어 두기 위해 들어온 것이고(휴대폰 밀도 대응), 같은 창 안에서 칸만 여닫는다.

- 바꿀 것: Mac에서는 **같은 프로젝트의 깨끗한 새 세션을 새 창으로** 연다. 창 생성 경로는 이미 있다 —
  `src/workroomPopout.ts` 문법 + Rust `open_workroom_window`(`workroom-<n>`, 계단식 offset).
- ⚠️ 휴대폰(원격 포털)에는 팝아웃이 없다(페어링 키·릴레이 세션이 그 페이지 메모리에만 있다).
  휴대폰은 지금의 접기 토글을 그대로 둔다. 판정은 기존 `workroomPopoutAvailability`를 쓴다.

## 7. OPS 워크룸이 Codex만 열렸다 ✅

음성 경로(`voiceRuntimeBinding`)는 이미 저장된 선택을 따랐고 「아젠투지 설정」의 AI 선택도 네 개를 모두
제공했는데, `App.tsx`의 `openOpsWorkroom`만 리터럴 `'codex'`였다. 두 경로가 같은 파일
(`ops-launch-preference.json`)을 읽게 했다 — 판정은 `opsWorkroomAgentFrom` 한 곳이다.

## 검증 (이 브랜치, 2026-10-04 실측)

- `bun run typecheck` 0 에러
- `cd src-tauri && cargo test` **70 pass / 0 fail**
- 새 테스트: `agent-dialogue-publish-rows`(6) · `agent-dialogue-pairing-rows`(3) ·
  `ops-workroom-agent`(2) · `workroom-memory-command`(2), 그리고 기존 스위트에 추가한
  `agent-dialogue-sql`의 페어링·공평배분 3건과 `agent-dialogue-host`의 페어링 end-to-end 1건
  (실제 PGlite + 실제 호스트: 페어링 → 승인 없는 방 개설 → 상대 `maintenance()` 자동 입장 → 수신 1명,
  페어링 없는 기기는 자동 입장 안 됨 → 수신 0명)
- 전체 `bun test`는 5,419 pass / 1 fail이었고, 실패 1건의 출처를 확인 중이다(위 영역의 테스트는 모두 통과).
