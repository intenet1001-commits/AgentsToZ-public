# 근무 모드

본창의 AgentsToZ 이름 아래 또는 「아젠투지 호출」 창 상단의 커피 버튼에서 켭니다.
30분·1/2/4/8/24시간을 선택하거나 1–1440분을 직접 지정하고 **근무 시작**을 누릅니다.
**연중무휴**를 고르면 종료 시각 없이 **지금 퇴근**을 누르거나 앱을 완전히 종료할 때까지 유지합니다.
현재 시점부터 시간을 다시 시작할 수 있으며 **지금 퇴근**은 즉시 해제합니다.
자동 잠자기만 막으며 **화면도 계속 켜 두기**를 선택하면 화면의 자동 꺼짐도 막습니다.
Mac에서는 **덮개를 닫아도 계속 근무**를 함께 고를 수 있습니다(아래 절) — 전원을 연결하지 않아도 됩니다.

두 창은 같은 컴퓨터의 모드 하나를 공유합니다. 창을 닫거나 숨겨도 타이머는 유지되고,
시간 만료·앱 완전 종료 시 해제됩니다. 앱 재시작 시에는 꺼져 있습니다.
덮개 닫힘 근무를 고르지 않으면 노트북 덮개 닫기·사용자가 직접 선택한 잠자기·배터리 부족·운영체제 전원 정책을 우회하지 않습니다.
24시간은 반복 일정이나 AI 자동 실행이 아니라 한 번의 절전 방지 시간입니다.
연중무휴도 저장하지 않습니다 — 앱을 다시 열면 꺼져 있고, 기한이 없는 세션은 worker가 만료시키지 않습니다.

Mac은 프로세스 소유 IOKit assertion, Windows는 Power Request handle을 사용합니다.
OS가 프로세스 종료 시 요청을 회수합니다. 덮개 닫힘 근무의 `SleepDisabled` 하나를 빼면 전역 전원 설정·보안 잠금·사용자 입력은 수정하지 않습니다.
웹 포털·iPhone에서 호스트 전원을 제어하지 않으며 Linux 데스크톱은 미지원으로 표시합니다.

타이머는 Rust 단일 worker가 소유하고 renderer와 독립적으로 만료됩니다. 유휴 worker는 condition
variable에서 대기하고, 실행 중 최대 30초 단위로 벽시계·monotonic deadline을 확인합니다.
화면은 이벤트·다시 포커스 시 조회와 실행 중 보이는 창의 30초 조회만 사용합니다.
요청 실패 시 기존 모드를 보존하며 결과 revision이 오래된 화면 응답은 버립니다.

플랫폼 계약: [Apple IOKit](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridlesystemsleep),
[Windows PowerSetRequest](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest).

## 덮개를 닫아도 계속 근무 (Mac, 2026-10-24)

assertion(`PreventUserIdleSystemSleep`)은 유휴 타이머만 막고 덮개 스위치는 막지 못합니다 — Caffeine·KeepingYouAwake류가
모두 같은 한계입니다. Apple이 지원하는 덮개 닫힘 사용은 전원+외부 모니터+입력 장치(클램셸)뿐이고, 그 밖의 길은
문서에 없는 `pmset -a disablesleep 1`(커널 `SleepDisabled`) 하나입니다(`man pmset`에 없음, 이 Mac에서 확인).
Amphetamine(+Enhancer)·lidawake·Sleepless·Insomnia가 모두 이 스위치를 씁니다 — 차이는 **누가 root로 켜고, 앱이 죽으면 누가 끄느냐**입니다.

- **권한**: 처음 한 번 macOS 암호 창(`osascript … with administrator privileges`)으로 `/private/etc/sudoers.d/agentstoz-lid-awake`에
  `<사용자> ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1` **두 명령만** 둡니다(Sleepless 방식).
  root 셸이 규칙을 점(.)이 든 임시 이름으로 직접 쓰고 `visudo -c`로 검사한 뒤에만 제자리로 옮깁니다 — 사용자 쓰기 가능 파일을 root로 읽지 않습니다.
  lidawake식 SMAppService root 도우미는 Developer ID 서명이 필요한데 설치 앱이 ad-hoc 서명(Team ID 없음)이라 지금은 쓸 수 없습니다.
  「허용 지우기」가 규칙과 감시 항목을 지웁니다(덮개 닫힘 근무가 켜져 있으면 거절).
- **위험과 소유**: assertion과 달리 `SleepDisabled`는 앱이 죽어도, 재부팅해도 남습니다(가방 속 과열·방전). 그래서 앱은
  `<앱 데이터>/work-mode-closed-lid.owner` 표식(내용 = pid, 수정 시각 = 15초 심장박동)을 **먼저** 쓰고 스위치를 켠 뒤 다시 읽어 확인합니다.
  표식이 있을 때만 「우리가 켠 것」이고, 다른 앱이 이미 켜 둔 스위치(`external`)는 끄지 않습니다.
- **끄는 길**: 지금 퇴근·시간 만료·앱 정상 종료(worker) / 앱 크래시·멈춤·재부팅 — 사용자 LaunchAgent
  `com.intenet.agentstozbycs.lid-awake-guard`(로그인 시 + 30초마다)가 pid가 죽었거나 심장박동이 90초를 넘으면 `sudo -n pmset -a disablesleep 0`
  / 다음 앱 시작(남은 표식 복구). 끈 뒤 덮개가 닫혀 있고 Apple 정책상 잠들 상황(`AppleClamshellCausesSleep`)이면 `pmset sleepnow`.
- **안전 조건**(worker가 15초마다): 배터리로 도는 것 자체는 막지 않습니다(2026-10-24 결정 — 전원을 연결하지 않아도 계속 근무해야 한다).
  대신 **배터리가 5% 이하**(`pmset -g batt`, 전원일 때는 해당 없음)면 해제하고 `lowBattery`(세션은 계속, 충전하면 다시 켬) — 스위치가 켜진 동안에는
  macOS의 저전력 잠자기도 막히므로, 그대로 두면 0%에서 하드 종료되어 진행 중이던 작업이 사라집니다. 읽지 못하면 놓지 않습니다(열·감시 항목이 남아 있다). 열 압력 heavy 이상
  (`com.apple.system.thermalpressurelevel` ≥ 2 = `thermalState` serious)이면 해제하고 그 세션에서는 다시 켜지 않음(`hot`).
  해제가 실패하면 `active`와 오류를 그대로 보여 주고 다음 박동에 다시 시도합니다(표식이 남아 감시 항목도 재시도).
  박동마다 스위치를 다시 읽어, 감시 항목(멈춘 박동)이나 사람이 밖에서 끈 경우에는 다시 켜지 않고 오류로 알립니다 — 꺼진 스위치의 표식을 박동이 되살리지 않게.
- 덮개 닫힘 근무가 켜져 있는 동안에는 직접 잠자기(Apple 메뉴)도 되지 않습니다. 외부 모니터+전원이 있으면 macOS 자체 클램셸로 이미 깨어 있습니다.
- 휴대폰·웹·MCP에서는 여전히 켜고 끄지 않습니다. 덮개를 닫은 Mac은 기존 원격 제어(포털·LAN·릴레이)로 워크룸을 다룹니다 — 화면이 필요 없습니다.

### 검토: 덮개 닫힌 Mac을 아이폰·아이패드로 (블루투스)

- iOS 앱은 블루투스 HID(키보드·마우스)를 열 수 없습니다(CoreBluetooth가 HID 서비스를 막음) — 아이폰을 Mac 입력 장치로 쓰는 길은 없습니다.
- 블루투스로 화면 전송은 대역폭이 모자라 현실적이지 않습니다. BLE로 명령만 보내는 것은 가능하지만, 에이전트가 어차피 인터넷을 써야 하고
  인터넷이 되면 기존 원격 제어가 낫기 때문에 새 보안 면을 만들 이유가 없습니다.
- 화면이 꼭 필요하면 Jump Desktop·화면 공유를 Wi-Fi로 씁니다. 모니터 없이 덮개를 닫으면 검은 화면 보고가 많아(Jump도 공식 미지원)
  실측이 필요하고, 안 되면 가상 모니터(HDMI 더미 플러그 등)가 필요합니다. Sidecar가 덮개를 닫은 뒤에도 유지된다는 근거는 찾지 못했습니다.

참고: [Sleepless](https://github.com/Aboudjem/Sleepless) · [lidawake](https://github.com/zayco-it/lidawake) ·
[Insomnia 소개](https://www.bgr.com/2288592/insomnia-open-source-app-keep-mac-awake-with-lid-closed/) ·
[Jump Desktop 덮개 닫힘](https://support.jumpdesktop.com/hc/en-us/community/posts/4405077338381-Mac-Closed-Lid) ·
[iOS HID 제한](https://developer.apple.com/forums/thread/725238)

검사: `cargo test work_mode`(실제 Mac assertion 획득·해제, 덮개 규칙 — 전원·열·외부 소유·인계·실패 재시도 — 와 감시 스크립트의 판정,
`visudo -c`·`plutil -lint`·`sh -n`·`osacompile`로 생성물 검증 포함 — root와 실제 스위치는 건드리지 않음), `bun tests/work-mode-ui.mjs`
(Chromium/WebKit 화면·입력·실패·동기화·280px 배치·허용 취소/허용·덮개 상태). 실제 덮개를 닫는 확인은 설치 앱에서 사람이 합니다. Windows 실기 검증은 실제 Windows PC에서 수행합니다.
