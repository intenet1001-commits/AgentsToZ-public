# 워크룸 컨텍스트·세션 기억·종료

워크룸 하단은 선택한 **현재 CLI 세션**에 연결됩니다. 새 터미널용 프로젝트 선택을 바꿔도 현재 세션의 저장 대상은 바뀌지 않습니다.

- 컨텍스트: 새 Codex CLI는 해당 실행에만 `tui.status_line=["context-remaining"]`을 지정하고 실제 터미널 하단의 남은 비율을 사용 비율로 바꿔 표시합니다. 이 표시는 자동 저장 판단에 사용하지 않습니다. 새 Claude Code는 워크룸 UUID를 `--session-id`로 전달하고 동일 ID·경로·생성 시각 이후의 statusline 측정만 표시합니다. 이전 세션이나 측정이 없는 Hermes/Antigravity에는 추정값 대신 ‘확인 불가’를 표시합니다.
- 마지막 기억 저장: 프로젝트의 확인된 `lastRememberedAt`과 이 화면에서 요청한 저장 영수증의 완료 시각을 사용합니다. 초기화·파일 수정 시각이나 백업 완료를 로컬 저장으로 오인하지 않습니다. V2 선택 구간의 이전 저장이 프로젝트 전체 기준을 전진시키지 않은 경우 그 시각은 표시되지 않을 수 있습니다.
- 지금 저장: 기존 기억 저장 dispatcher와 한도·복구 처리를 사용합니다. 런타임 자체에 저장 문구를 타이핑하지 않습니다. 원격에서는 프로젝트별 `memory.save` 권한이 필요합니다. 이 버튼이 모든 CLI의 원문 대화 수집 지원을 추가하지는 않습니다.
- 세션 종료: ‘저장하고 종료 / 저장 없이 종료 / 취소’를 먼저 표시합니다. 완료되지 않은 AI 작업은 먼저 마친 뒤 저장하세요. 동일 저장 요청의 로컬 성공 영수증, 입력 리비전, 저장 요청 전후의 프로젝트 활동 지문을 호스트가 확인해야 종료합니다. 실패·미확정·새 활동이면 CLI를 유지합니다. 백업 대기와 로컬 저장은 별도입니다.
- 저장 없이 종료: 이 명시적 종료의 후속 자동 저장 훅을 생략합니다. 이미 접수된 저장·체크포인트나 기존 복구 기록을 삭제하지 않습니다. 취소는 종료 의도만 취소하며 접수된 저장은 계속됩니다.

연결이 끊겨 응답이 없으면 같은 요청 ID로 결과만 조회합니다. 요청 ID는 해당 호스트·세션의 `sessionStorage`에 보존하며 저장 자체는 호스트의 durable receipt에 남습니다. 다른 세션·기기·요청의 성공으로 현재 터미널을 종료하지 않습니다. 화면이 숨겨지면 하단 조회를 멈추고, 표시 중에도 조회를 하나씩 실행합니다.

V2는 선택 구간 저장 후에도 예전 전체 프로젝트의 미저장 표시가 남을 수 있으므로, 종료 판단에는 그 표시 대신 저장 접수 당시와 현재의 활동 지문을 비교합니다. 저장 중 새 작업이 생기면 다시 저장하도록 안내합니다.

기존 50·75·90% 자동 체크포인트의 명시적 설정과 지원 범위는 변경하지 않습니다. 컨텍스트 표시가 있다고 자동 저장이 활성화되거나 Hermes/Antigravity의 임계값 감지가 추가되는 것은 아닙니다.

## 검증

- 실제 PTY 회귀: 명시적 저장 생략의 종료·shutdown 훅, 저장 확인 실패 시 CLI 유지, 입력 리비전 확인, 실행 인자와 shell 비보간.
- 영수증 회귀: 재시작, 요청 재전송, owner·target·session·request 결속, 완료 시각, 별도 원격 기억 권한.
- `node tests/workroom-session-footer.e2e.mjs`: Chromium/WebKit 각각 모바일 393×852 화면에서 저장 후 종료, 복구, 취소, 저장 생략, 응답 유실, 권한 없음, 저장 후 새 활동 7개씩.
- `node tests/workroom-input-lifecycle.e2e.mjs`: 실제 React+xterm 입력·출력·종료·세션 전환 12개. 격리된 API를 사용하며 모델을 호출하거나 실제 기억을 수정하지 않습니다.

이 변경의 브라우저 검증은 실제 iPhone USB 또는 셀룰러 전환 검증을 대신하지 않습니다. 이전 USB 검증과 설치 버전은 모바일 안정화 실행 기록에서 별도로 확인합니다.

## Mobile key delivery

The relay controller serializes bounded Workroom requests from the terminal and
memory footer before they share the encrypted cursor. Queued requests are not
resent after uncertain delivery, and a changed session token rejects old queued
input. Virtual keys flush preceding typed text, then send individually. Arrow
keys use xterm's current application-cursor mode. Number keys and a keyboard
focus button avoid relying on tapping terminal text, which is not an HTML menu.

Coverage includes simultaneous workspace status and keys, queue overflow and
release after failure, real React/xterm input ordering, and a mobile WebKit touch
fixture. USB inspection of the connected iPhone 13 Pro Max found the first-run
portal-entry screen, so that inspection does not establish delivery to the user's
pictured remote CLI session. No hook trust selection was submitted during tests.
