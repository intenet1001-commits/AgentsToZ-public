# 제품 운영 도구 연결

## 현재 버튼과 사용 흐름

1. ShadowLoop Mac 앱 상단의 **AI 운영 연결**에서 가족 프로필을 확인하고
   **현재 프로필의 운영 연결 허용·코드 발급**을 누른다.
2. AgentsToZ의 **장기기억 → USE 활성화·준비 → ShadowLoop**에 코드를 등록한다.
   기억 준비·활성화와 앱 도구 연결은 별도 상태로 표시한다. Buzz 연결이나 고급 설정은 필요 없다.
3. 워크룸·OPS의 `@` 후보와 커뮤니티의 프로젝트 선택·멘션 후보에 `ShadowLoop`(DEV)와
   `ShadowLoop-USE`가 함께 표시된다. USE 선택은 같은 등록 프로젝트 ID·폴더를 유지하고
   제품 운영 대화와 허용된 도구로 연결한다. 별도 프로젝트를 등록하거나 DEV CLI를 열지 않는다.
   `#ShadowLoop-USE`는 참고 멘션이며 작업을 실행하지 않는다. 워크룸의 참고 폴더는 DEV 루트가
   아닌 검증된 USE 운영기억만 가리킨다. 기존 `@ShadowLoop USE` 표기도 호환한다.
4. 외부 CLI·에이전트 앱에서는 `@` 자동완성이 없어도 “ShadowLoop USE로 자료 만들어줘”처럼
   요청할 수 있다. 연결된 MCP의 `agentstoz_use_resolve_target`으로 `ShadowLoop USE` 또는
   `ShadowLoop-USE`를 해석하고, 반환된 `projectId`를 `agentstoz_use_service_operation`의
   `portId`로 사용한다. 먼저 `status`, 허용된 입력의 `execute`, 원래 요청 ID의 `receipt` 순서다.
   코드 발급·운영 연결·USE 활성화는 이 이름 해석만으로 자동 실행하지 않는다. 설치 전부터
   열려 있던 외부 앱의 MCP 프로세스에는 새 도구 설명이 자동 반영되지 않을 수 있으므로 해당
   앱의 MCP를 다시 연결하거나 새 세션을 시작한다. stdio 계약 검사는 실제 모델의 자연어 판단을
   대신하지 않는다.
5. OPS의 음성·MCP도 동일한 호스트를 사용한다. 현재 설치 어댑터는 이 Mac의 `local` 사용자 전용이다.
   기존 원격 프로젝트 권한만으로 이 연결을 다른 사용자에게 자동 부여하지 않는다.
6. ShadowLoop의 같은 프로필에서 연결을 해제하거나 30일이 지나면 코드 권한이 끝난다.
   진행 중 작업은 다음 권한 확인에서 중단하며 이미 만든 자료·음성은 보존한다.

외부 CLI·에이전트 앱의 공통 텍스트 호출은 `@OPS`, `@프로젝트-DEV`, `@프로젝트-USE`다.
`#OPS`, `#프로젝트-DEV`, `#프로젝트-USE`는 해당 역할의 기억을 읽기 전용으로 참고한다.
이름은 `agentstoz_use_resolve_target`, 기억 참고는 `agentstoz_use_read_reference`로 처리한다.
USE 참고는 활성화된 운영기억의 앞 32 KiB에서 관련 구간 최대 5개만 읽으며, 잘린 결과는
`truncated`/`complete`로 표시한다. 앱 실행·로그인·키 조회를 하지 않고 DEV 기억으로 대체하지 않는다.

새 프로젝트를 만들거나 MCP로 기존 폴더를 등록하면 `.agents/skills/agentstoz-mentions/SKILL.md`,
`.claude/skills/agentstoz-mentions/SKILL.md`와 프로젝트 지침에 같은 규칙을 설치한다. 등록은
기존 소스·Git·기억을 유지하며 호출 지침만 추가한다. 기존 프로젝트는 기억 지침 v33 갱신으로
받는다. 갱신은 기억 본문·ID·저장 기준을 바꾸지 않는다. 전역 Codex·Claude·Antigravity·Hermes
호출 스킬도 앱 시작 시 갱신한다. 다른 앱에서는 프로젝트 스킬·지침 읽기와 MCP 연결 지원이
필요하며, 입력창의 네이티브 `@` 자동완성은 그 앱의 기능이다. 제한된 앱 USE 에이전트에 전체
OPS MCP 권한을 부여하지 않는다. OPS·DEV 작업이 필요하면 신뢰된 호스트에 인계를 요청한다.

코드는 프롬프트·MCP 인자·채팅에 붙이지 않는다. AgentsToZ는 별도 로컬 암호화 vault에
보관하며 HTTP에는 원문 코드를 보내지 않는다. 연결 준비 버튼만으로 도구를 검증 완료로
표시하지 않는다. **양쪽 새 소스가 반영된 앱**이 필요하다. 설치·배포와 실제 폰 검증은 별도다.

## ShadowLoop 운영 계약 v1

`src/shadowLoopUseAdapter.ts`는 고정 `127.0.0.1:8127/api/service-use/`만 호출한다.
사용자 입력으로 URL·경로·셸 명령·도구 정의를 등록하지 않으며 redirect를 거부한다.
앱의 명시적 연결 허용은 로컬 SQLite 보관함의 현재 가족 프로필 하나에 결속된다.
Postgres/Supabase 보관함은 이 연결 버전의 대상이 아니다.

도구는 `materials.generate`, `materials.reuse`, `audio.prepare`, `operation.status`,
`operation.cancel`, `phone.deliver`다. 짧은 본문 또는 불투명 자료·작업·폰 ID만 받는다.
사용자·보관함·Mac 기기·설치·권한 revision과 `shadowloop-use-v1` 정의를 매번 확인한다.
서버는 프로필을 고정한 저장소를 사용하며 LLM/TTS 대기 후에도 각 저장소 작업 직전에 권한을
확인한다. 프로필 전환과 저장은 같은 프로필 잠금을 사용한다. 도구 내부 AI는 기존 앱의
도구 없는 Claude / 읽기 전용 Codex 경로를 사용하며 개발 터미널을 시작하지 않는다.

앱 요청은 입력 원문 대신 의도 hash를 먼저 영속화한다. 같은 ID·같은 입력은 기존 결과를
반환한다. 재시작으로 실행 여부를 알 수 없으면 `unknown`을 유지한다. 호스트와 스레드는
원래 ID의 `receipt`만 조회해 진행 결과를 갱신하며 작업을 자동 재실행하지 않는다.
취소 접수는 실제 취소 완료와 구분하고 외부 AI/TTS 호출을 강제 종료했다고 주장하지 않는다.

기존 Phone Sync의 프로필 공유 보관함에 기기별 게시 목록을 추가했다. 해당 프로필을 공유하는
승인 iPhone 중 **입력한 phoneId의 기기에만** 새 자료·revision을 게시한다. 다른 폰의 기존
공유 목록과 승인 범위는 유지한다. 목록·manifest·음성 파일·수신 영수증 모두 기기 범위를 검사한다.
기기 전용 revision은 구버전 서버의 실제 프로필 권한으로도 읽히지 않게 저장한다.
게시 자체는 폰 수신 완료가 아니다. 기존 영수증의 최신 manifest hash·`ready`·수신 시각을
확인해야 `phoneReceived=true`이며, 파일 확인 중 `stored`나 옛 revision은 완료로 보지 않는다.
영수증은 해당 요청이 게시한 manifest hash에도 결속되어 다른 요청의 수신을 대신 증명하지 않는다.
연결 상태의 `phones`는 이 프로필에 승인된 기기의 표시 이름·불투명 ID만 반환한다.
OPS는 이 목록에서 실제 기기를 확인하며, 동명 기기가 있으면 임의로 선택하지 않는다.
이 읽기는 새 페어링·전송·기억 변경을 실행하지 않는다.

## 서명된 로컬 전송

발급 코드 형식은 `SLUSE1.<installationId>.<grantId>.<secret>`이며 32-byte 무작위 secret을 쓴다.
서버는 secret의 SHA-256만 저장한다. 양쪽의 요청 HMAC 키는 그 SHA-256의 32 bytes다.

- 요청 header: `x-shadowloop-use-grant`(설치 ID와 grant ID), `x-shadowloop-use-time`(Unix ms),
  `x-shadowloop-use-nonce`(새 UUID), `x-shadowloop-use-signature`(소문자 hex HMAC-SHA256).
- 서명 원문: `SLUSE1\n<scope|execute|receipt>\n<time>\n<nonce>\n<SHA256(raw JSON body)>`.
- 허용 시계 차이는 30초다. 유효 nonce는 31초·최대 4,096개로 제한하며 재사용을 거부한다.
  재시작 뒤에도 요청 ID 영수증이 앱 쓰기 중복을 막는다.
- 성공 응답의 `x-shadowloop-use-proof`는 `reply\n<nonce>\n<SHA256(raw response body)>`의
  HMAC이다. 응답 서명과 설치·정의가 맞아야 연결을 저장한다. 원문 코드를 포트 위조 서버에
  보내지 않는다. 본문·응답은 12,000 bytes 안으로 제한한다.

관리용 발급·조회·해제는 ShadowLoop의 기존 Mac Origin·Host·프로세스 token guard를 재사용한다.
서명된 운영 API는 loopback client·정확한 Host만 허용하고 브라우저 Origin·query를 거부한다.

## 다른 제품을 연결하려면

프로젝트 워크룸에서 아래 공통 연결 규약을 앱에 구현하면 AgentsToZ를 앱마다 수정하지 않고 연결할 수 있다. 기존 설치 어댑터도 계속 지원한다. 임의 URL 추가·JSON 도구 가져오기·프로젝트 코드를 호스트에서 실행하는 자동 검색은 제공하지 않는다.

1. 제품이 제공할 제한된 업무 동작과 명시적 사용자 허용·해제 UI를 만든다.
2. 제품의 실제 사용자·자료 보관함·설치 identity와 요청 ID별 결과 조회·취소 계약을 구현한다.
3. 공통 연결의 `scope`, `execute`, `receipt`를 실제 앱에 구현하고 사용자가 앱 코드를 등록한다.
   기존 설치 어댑터 확장은 호스트의 허용 목록·입력·권한·결과 스키마와 검증을 함께 버전 관리한다.
4. 중복·응답 유실·재시작·권한 변경·잘못된 사용자·실제 제품 결과를 검증한다.
   실제 기기 수신이 필요한 제품은 수신 측의 별도 영수증으로 완료를 판단한다.

연결 채널과 제품 운영 권한은 독립적이다. DEV 기억, USE 기억, AgentsToZ OPS 기억을
합치거나 일반 제품에 전체 관제 MCP·소스 수정·배포 권한을 주지 않는다.

## 프로젝트 워크룸에서 USE 준비 (공통 연결 v1)

워크룸의 **USE 준비**에서 프로젝트와 사용할 업무를 고르고 **워크룸에서 USE 연결 준비**를
누른다. 해당 등록 프로젝트의 DEV 요청 초안이 열린다. 기존 워크룸의 작성 중인 내용을
덮어쓰거나 AI를 즉시 실행하지 않는다. AI를 골라 요청을 시작하면 실제 앱 기능과 기존
API/MCP/CLI를 확인하고, 필요한 앱 연결 구현·검증을 진행한다. 장기기억의 기존 USE 준비
화면도 같은 요청을 만든다. 로컬 워크룸 연결이 없는 포털은 준비 요청을 복사한다.

준비 요청에는 `agentstoz-app-use-v1` 규약과 Python 표준 라이브러리 참조 SDK가 포함된다.
앱 언어에 맞게 구현해도 같은 프로토콜을 사용한다. SDK만 설치한 빈 서비스는 실제 앱 기능을
제공하지 않는다. 앱이 제공하는 제한된 동작, 현재 계정·보관함·기기 identity, 내부 쓰기의
권한 잠금, 사용자 허용/해제 UI와 실제 업무 검증은 프로젝트 DEV가 구현해야 한다.

앱은 사용자의 명시적 허용으로 `ATZUSE1` 코드를 발급한다. AgentsToZ에 코드를 등록하면
공통 커넥터가 loopback의 고정 경로 `/api/agentstoz-use/{scope,execute,receipt}`와 요청/응답
HMAC을 검증한다. 프로젝트 코드·실행 파일·JSON 명령·임의 URL을 호스트에 적재하지 않는다.
공통 연결은 앱이 서명한 등록 프로젝트 ID·서비스·사용자·보관함·기기·설치·권한·동작 목록에
결속되고, 그 목록이 달라지면 재연결이 필요하다. 코드는 로컬 암호화 vault에만 보관한다.
현재 공통 연결도 로컬 사용자 전용이며 원격 워크룸 권한을 자동 상속하지 않는다.

각 앱은 최대 12개의 동작과 동작별 최대 8개의 문자열·숫자·boolean 입력을 제공한다.
화면은 이 목록으로 입력 양식을 만들고 MCP·음성은 status의 `actions`와 `tools`를 읽는다.
공통 실행은 `app.invoke`의 `actionId`와 선언된 `arguments`만 받는다. 다른 프로젝트 동작,
미등록 입력과 중첩 객체는 거부한다. ShadowLoop의 기존 6개 도구·연결 코드·폰 권한은 유지한다.
같은 프로젝트·서비스의 두 연결은 모호하게 선택하지 않고 거부한다.

기억 준비·활성화·연결 확인은 계속 별도 상태다. 준비 초안이나 코드 생성만으로 완료라
표시하지 않으며, 앱별 실증이 필요하다. 운영기억은 같은 프로젝트의 독립 USE namespace를
사용하고 DEV·OPS 기억을 바꾸지 않는다. 이후 @프로젝트-USE와 외부 MCP의 기존 경로를 쓴다.
원래 요청 ID의 receipt는 조회만 하고 unknown 작업을 자동 재실행하지 않는다.

`python3 scripts/agentstoz-maintainer.py run --root . --profile workroom-improvement`은 실제 서명된
두 Python 테스트 앱의 프로젝트 격리·영수증 복구와 Chromium/WebKit의 준비·동적 양식을
검사한다. 이는 임의의 실제 제품이 모두 연동됐다는 근거가 아니다. 실제 연결 코드를
채팅·기억·스크린샷·Git에 기록하지 않는다.

## USE 끄기와 다시 켜기

워크룸 **USE 준비** 3단계에서 USE가 켜져 있으면 **USE 끄기**가 보인다. 한 번 더 확인을 받은 뒤
그 프로젝트·서비스의 활성화 표시만 끈다. USE 운영기억(`project-namespace-v1`)과 그 ID, 앱 연결,
이전 요청의 결과는 지우지도 되돌리지도 않는다. 같은 자리의 **USE 다시 켜기**는 기존 활성화
경로를 그대로 지나며 같은 기억·연결로 이어진다. 로컬 API는
`POST /api/service-memory/disable-use`이고 `portId`·`serviceKey`·`consent:true`만 받는다.

꺼진 동안에는 `@프로젝트-USE`·`#프로젝트-USE` 후보(Mac 워크룸·커뮤니티·휴대폰 `#` 목록)에서
빠지고, MCP의 `#` 참고도 꺼져 있다고 답한다. 새 실행(로컬 경로·MCP `agentstoz_use_service_operation`·음성)과 새 USE
스레드·답장은 「USE가 꺼져 있습니다 … 「USE 다시 켜기」를 누르세요」로 거절한다. status는 계속
읽히고, 이미 보낸 요청 ID의 receipt와 USE 스레드의 결과도 계속 조회된다 — 조회만 하고 작업을
다시 보내지 않는다. 켜고 끄기는 Mac 화면에서만 한다.
