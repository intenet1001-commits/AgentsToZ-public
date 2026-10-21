# 내가 한 말의 입력 출처

사용자 역할의 메시지가 곧 사람이 직접 작성한 문장이라는 뜻은 아니다. 예약 점검도
Codex의 완료된 `UserMessage`로 기록될 수 있다. 본문의 `<heartbeat>` 같은 태그,
`client_authored`, `retained_source.complete`만으로 작성자를 추정하지 않는다.

- `agentstoz`: 앱 복사 지문과 전송 시각이 기존 허용 구간 안에서 일치한다.
- `human`: 호환성을 위해 유지하는 wire 값이다. 화면에는 **일반 메시지**로 표시하며,
  실제 사람이 작성했거나 키보드로 입력했다는 증명이 아니다. 기존 행은 더 약한
  ‘앱 복사 지문이 없었다’는 기준으로 분류됐으므로 자동 전달이 섞일 수 있다.
- `unknown`: **입력 경로 미확인**이다. 기존 기록, 확인된 자동 전달, 입력 출처를
  제공하지 않는 CLI, 잘리거나 불일치하는 출처 증거가 포함될 수 있다.

새 Codex 수집은 producer의 `response_item`에 있는
`internal_chat_message_metadata_passthrough.content_item_kinds`와 retained message/turn ID를
검증한다. 바로 다음 완료된 메시지의 turn, 전체 본문 지문, 시각(10초 이내)이 모두
일치해야 증거를 적용한다. 정확한 `user.text`는 일반 메시지, `user.heartbeat`는 자동
전달이다. 없거나 모호한 증거는 미확인으로 남긴다. `response_item` 자체를 별도
사용자 기록으로 수집하지 않는다. Claude의 기존 명시적 user 행은 일반 메시지이며
명시적인 meta/sidechain 행은 미확인이다.

자동 전달은 원문을 보존하되 `unknown`으로 수집하며 가이드 추천 표본에서 제외한다.
사용자가 태그를 인용한 일반 메시지는 그 이유만으로 제외하거나 삭제하지 않는다.
복사 지문 불일치만으로 새 메시지를 일반 메시지로 승격하지 않는다.

수집 커서 앞의 마지막 완전한 JSONL 행만 최대 64 KiB까지 되읽는다. 이 읽기도
기존 scan byte budget에 포함하며, 일부만 읽힌 증거는 미확인으로 처리한다.
스캔 중 출처 상태는 한 행의 ID·시각·지문만 보관하고 별도 원문 파일이나 DB를 만들지 않는다.
기존 수집 동의, 원문 암호화, 보존 기간, cursor와 중복 제거는 그대로 적용한다.

기존 행의 원문·분류를 일괄 수정하거나 재수집하지 않는다. 기존 일반 메시지를 가이드로
만들 때는 사용자가 본문을 확인하고 초안으로 선택한 뒤 저장한다. 향후 사용자/CEO 기억도
이 wire 값만으로 실제 사용자 지시나 승인이라고 판단해서는 안 된다.

검사: `bun test ./tests/what-i-said-codex-delivery.test.ts ./tests/what-i-said-prompt-origin.test.ts`.
이 검사는 수집/추천 계약이며 실제 사람의 키보드 입력 검증을 대신하지 않는다.
