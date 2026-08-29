# AgentsToZ + Hermes Telegram Bot 단말별 온보딩 매뉴얼

이 문서는 새 단말에서 현재 단말용 Telegram Bot 3개를 만들고 Hermes에 연결하는 절차다.

## 목표

현재 단말의 단말 별칭을 기준으로 다음 3개 Bot을 만든다.

```text
<device-alias> · Hermes
<device-alias> · AgentsToZ
<device-alias> · CS CEO
```

그리고 다음 단체톡을 만든다.

```text
<device-alias> · Hermes 3-Bot
```

단체톡 참여자:

```text
<device-alias> · Hermes
<device-alias> · AgentsToZ
<device-alias> · CS CEO
```

## 1. 단말 별칭 확정

1. 현재 단말의 authoritative `device_id`를 AgentsToZ에서 읽는다.
2. 사람이 읽을 단말 별칭을 확인한다. 예: `workmacbook`, `office-mac`, `aws-prod`.
3. 기존 별칭과 중복되면 다른 별칭을 사용한다.
4. 별칭에는 공백 대신 `-`를 사용하고, Telegram username에는 영문 소문자·숫자·underscore만 사용한다.
5. Bot 생성 전에 아래 이름을 사용자에게 보여주고 확인한다.

```text
표시명: <alias> · Hermes
표시명: <alias> · AgentsToZ
표시명: <alias> · CS CEO
단체톡: <alias> · Hermes 3-Bot
```

## 2. 기존 Hermes Bot 처리

기존 Hermes Bot이 이미 이 단말에 연결되어 있으면 Bot을 새로 만들지 않는다.

- 기존 Bot token과 profile 연결은 보존한다.
- 표시명만 `<alias> · Hermes`로 변경한다.
- 기존 username과 기존 단체톡 멘션은 임의로 변경하지 않는다.
- username 변경이 필요한 경우 별도 승인 후 BotFather와 Hermes config를 함께 변경하고 readback한다.

## 3. BotFather에서 새 Bot 2개 만들기

Telegram BotFather에서 다음 두 Bot을 생성한다.

```text
<alias> · AgentsToZ
<alias> · CS CEO
```

username 후보:

```text
<alias>_agentstoz_bot
<alias>_cs_ceo_bot
```

username은 Telegram 전역에서 유일해야 한다. 이미 사용 중이면 숫자 suffix를 붙이되 표시명에는 suffix를 넣지 않는다.

BotFather가 반환한 token은 다음 원칙을 지킨다.

- 채팅·Git·매뉴얼·로그·commit에 저장하지 않는다.
- 복붙 프롬프트에 넣지 않는다.
- 사용자 화면에 다시 출력하지 않는다.
- Hermes의 해당 profile 보안 입력 단계에 직접 입력한다.
- 입력 후 token이 실제 설정되었는지 `token present` 여부만 확인한다.

## 4. Hermes profile 연결

Telegram Bot은 각각 하나의 로컬 Hermes profile/gateway에 연결한다. profile 이름을 미리 가정하지 말고, 먼저 현재 단말의 live gateway/profile 목록과 기존 Hermes Bot 연결 상태를 readback한다.

기본 역할은 다음과 같지만, 기존 Hermes Bot의 실제 profile 이름을 authoritative 값으로 사용한다.

```text
<기존 Hermes Bot이 연결된 profile> / Hermes
  현재 단말의 기존 Hermes Telegram Bot

agentstoz-bot
  AgentsToZ control-plane

cs-ceo
  실제 프로젝트 worker
```

기존 Hermes Bot profile이 `default`일 수도 있지만, `default`를 무조건 만들거나 사용한다고 가정하지 않는다. `agentstoz-bot`과 `cs-ceo`가 이미 있으면 새로 만들지 않고 해당 profile의 gateway와 Bot identity를 readback한다. 없을 때만 별도 승인 후 profile/gateway를 준비한다.

각 profile에 연결한 Bot의 표시명·username·단말 별칭을 기록하되 token 값은 기록하지 않는다.

검증해야 할 identity:

```text
Telegram display name
Telegram username
device_id
device alias
Hermes profile
role
```

## 5. Telegram 단체톡 생성

Telegram에서 새 단체톡을 만들고 다음 3개 Bot을 추가한다.

```text
<alias> · Hermes
<alias> · AgentsToZ
<alias> · CS CEO
```

단체톡 이름:

```text
<alias> · Hermes 3-Bot
```

생성 후 실제 화면에서 다음을 readback한다.

```text
member count = 3 bots
세 Bot 표시명
세 Bot username
단체톡 제목
각 Bot available/connected 상태
```

## 6. Smoke test

단체톡에서 새 request ID를 사용해 다음을 확인한다.

```text
@<alias>_agentstoz_bot #csncompany2-0 request_id=<alias>-telegram-onboard-<unique-id>
정상 연결 확인만 수행해줘. 프로젝트 파일이나 memory를 변경하지 말고, 현재 단말 alias, device_id, Hermes profile, Bot username과 단체톡 참여 Bot 3개의 identity만 readback해줘.
```

PASS 조건:

- 단말 alias가 예상값과 일치한다.
- 세 Bot이 모두 예상 역할에 연결되어 있다.
- 기존 Hermes와 새 AgentsToZ/CS CEO가 서로 다른 Bot identity다.
- 단체톡에 정확히 세 Bot이 있다.
- `csncompany2-0` selector가 exact로 resolve된다.
- token 값이 출력·저장되지 않는다.

## 7. 실패·중단 규칙

다음 상황에서는 중단한다.

- authoritative device_id를 읽지 못함
- 단말 별칭이 비어 있거나 기존 단말과 충돌함
- BotFather username 충돌
- 기존 Bot token과 새 Bot token을 혼동함
- 단체톡에 다른 단말 Bot이 들어 있음
- Bot username과 표시명이 예상 identity와 다름
- `csncompany2-0` project/memory/Git binding이 일치하지 않음
- token이 로그·프롬프트·파일에 노출됨

기존 Bot 삭제·reset·token 교체·기존 단체톡 변경은 명시적 승인 없이 수행하지 않는다.

## 8. 최종 보고

```text
Telegram Bot onboarding: PASS/FAIL/BLOCKED
Device alias: <alias>
Device ID: <id 또는 redacted>

Hermes:
- profile: default
- display name: <alias> · Hermes
- username: <username>
- token: present/not present (값 출력 금지)

AgentsToZ:
- profile: agentstoz-bot
- display name: <alias> · AgentsToZ
- username: <username>
- token: present/not present

CS CEO:
- profile: cs-ceo
- display name: <alias> · CS CEO
- username: <username>
- token: present/not present

Group chat:
- title: <alias> · Hermes 3-Bot
- members: 3 bots
- identity readback: PASS/FAIL
- smoke test: PASS/FAIL
```
