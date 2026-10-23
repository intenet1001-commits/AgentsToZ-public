# 근무 모드

본창의 AgentsToZ 이름 아래 또는 「아젠투지 호출」 창 상단의 커피 버튼에서 켭니다.
30분·1/2/4/8/24시간을 선택하거나 1–1440분을 직접 지정하고 **근무 시작**을 누릅니다.
**연중무휴**를 고르면 종료 시각 없이 **지금 퇴근**을 누르거나 앱을 완전히 종료할 때까지 유지합니다.
현재 시점부터 시간을 다시 시작할 수 있으며 **지금 퇴근**은 즉시 해제합니다.
자동 잠자기만 막으며 **화면도 계속 켜 두기**를 선택하면 화면의 자동 꺼짐도 막습니다.

두 창은 같은 컴퓨터의 모드 하나를 공유합니다. 창을 닫거나 숨겨도 타이머는 유지되고,
시간 만료·앱 완전 종료 시 해제됩니다. 앱 재시작 시에는 꺼져 있습니다.
노트북 덮개 닫기·사용자가 직접 선택한 잠자기·배터리 부족·운영체제 전원 정책을 우회하지 않습니다.
24시간은 반복 일정이나 AI 자동 실행이 아니라 한 번의 절전 방지 시간입니다.
연중무휴도 저장하지 않습니다 — 앱을 다시 열면 꺼져 있고, 기한이 없는 세션은 worker가 만료시키지 않습니다.

Mac은 프로세스 소유 IOKit assertion, Windows는 Power Request handle을 사용합니다.
OS가 프로세스 종료 시 요청을 회수합니다. 전역 전원 설정·보안 잠금·사용자 입력은 수정하지 않습니다.
웹 포털·iPhone에서 호스트 전원을 제어하지 않으며 Linux 데스크톱은 미지원으로 표시합니다.

타이머는 Rust 단일 worker가 소유하고 renderer와 독립적으로 만료됩니다. 유휴 worker는 condition
variable에서 대기하고, 실행 중 최대 30초 단위로 벽시계·monotonic deadline을 확인합니다.
화면은 이벤트·다시 포커스 시 조회와 실행 중 보이는 창의 30초 조회만 사용합니다.
요청 실패 시 기존 모드를 보존하며 결과 revision이 오래된 화면 응답은 버립니다.

플랫폼 계약: [Apple IOKit](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridlesystemsleep),
[Windows PowerSetRequest](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest).

검사: `cargo test work_mode`(실제 Mac assertion 획득·해제 포함), `bun tests/work-mode-ui.mjs`
(Chromium/WebKit 화면·입력·실패·동기화·280px 배치). Windows 실기 검증은 실제 Windows PC에서 수행합니다.
