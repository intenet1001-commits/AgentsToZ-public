# 여러 기기·총괄·프로젝트의 에이전트가 필요할 때 대화하기

2026-10-03 조사. 설계 검토 문서이며 기능 구현·DB 배포·다른 PC 작업은 아직 하지 않았다.

구체적인 V1 데이터 모델·MCP 계약·3자 검증 순서는 [구현 설계](../plans/cross-device-agent-dialogue-2026-10-03/IMPLEMENTATION.md)를 따른다.

## 결론

Mac↔Mac, Mac↔Windows, Mac·Mac·Windows 세 기기 이상에 같은 계약을 적용한다. 각 기기에서 LLM 세션을 이미 열고 사용자가 공동 개선을 지시한다면, 장기기억 에이전트를 상시 실행할 필요가 없다. **기기 + 총괄 또는 등록 프로젝트**마다 고유한 endpoint를 만들고 임시 그룹 대화방의 `보내기/기다리기` 도구로 질문·답변·진단 근거를 교환한다. 1호 총괄↔2호 총괄, 1호 총괄↔2호 B, 1호 A↔2호 B, 같은 기억의 1호 qq↔2호 qq 모두 가능하다. 장기기억 문서와 journal은 각 운영·프로젝트 영역의 검증된 최종 결론을 저장하는 층으로 유지한다.

현재 앱의 기억은 Supabase 리비전·journal/feedback 원장으로 기기 간 동기화된다. 이 구조는 공유 기억을 동기화하지만 한 에이전트가 다른 에이전트에게 지금 질문을 보내고 답을 기다리는 기능은 제공하지 않는다. 현재 AgentsToZ MCP에도 프로젝트 워크룸 지시 도구는 있지만 PC 간 에이전트 inbox/send 도구는 없다. `memoryId`가 같아도 접근 권한의 증명이 아니며, `memoryId`가 달라도 명시적 초대·수락이 있으면 협업할 수 있다.

## 최소 기능

1. 사용자가 한 기기의 총괄 또는 프로젝트에서 `다른 에이전트와 대화`를 시작한다. 앱은 발신자의 총괄 프로필 결속 또는 로컬 프로젝트 등록과 초대 대상의 `endpointId`들을 확인하고, 참여 기기·대상 종류·기억 관계·유효시간·허용 범위를 표시한다. 각 상대 PC에서도 **정확한 수신 총괄 또는 프로젝트**의 참여 요청을 확인한다. 같은 기억·다른 기억의 프로젝트뿐 아니라 기기별 총괄도 초대할 수 있다. 세 번째 참가자 추가·퇴장에도 참가자별 승인을 적용한다.
   - OPS 운영 프로필은 사용자 단위로 공유된다(`agentstoz-use-mcp-server.ts`의 Control 안내). 실행 중인 MCP·총괄 에이전트와 물리 기기 신원은 단말마다 별개다. 각 단말의 OPS 표시는 이미 있는 `deviceName` 변경·동기화 경로(`src/deviceName.ts`, `portmgr_devices.name`)를 재사용한다. 사용자가 `아젠투지 1호`, `아젠투지 2호`처럼 이름을 붙일 수 있다. 앱은 이름과 실제 device ID 및 총괄/프로젝트 종류를 함께 보여 주고, 수신자는 **고정 endpoint ID**로 결속한다. 등록된 OPS 폴더를 별도 프로젝트 endpoint로 중복 표시하지 않는다. 로컬 전용 프로필은 공유 Control에 연결하기 전까지 원격 대화에 게시하지 않는다.
2. 각 LLM에 같은 도구를 노출한다: `join_dialogue(sessionId)`, `send_dialogue_message(sessionId, requestId, type, text, toParticipantIds?)`, `wait_dialogue_messages(sessionId, afterSeq, timeout)`, `leave_dialogue(sessionId)`. 대상 생략은 승인된 대화방 참가자 모두에게 보내고, 지정한 대상도 현재 참가자 중에서만 선택한다. Codex·Claude 등 도구별 어댑터는 동일 계약을 사용한다. 첫 버전은 질문·답변·짧은 진단 요약만 전달한다.
   - 현재 `conversationTargetDirectory`/`resolveConversationTargetAlias`는 이 Mac의 OPS·DEV·프로젝트를 찾는다. `아젠투지 2호`는 그 목록에 조용히 섞거나 `아젠투지` 뒤의 `2호`를 작업 지시로 해석하지 않는다. 대화 세션 생성에서 **별도 총괄/프로젝트 endpoint 조회**를 수행하고 공유 profile·기기·대상 결속·중복 이름을 확인해 정확한 `endpointId`를 돌려준다. 기존 `target=ops` 호출은 계속 이 기기의 총괄이고, 원격 총괄은 반환된 endpoint ID로 고른다.
3. 참여자는 고정 `endpointId`와 방 안 `participantId`로 식별한다. 한 기기의 총괄과 프로젝트도 별개 참여자다. 메시지는 `sessionId + senderParticipantId + requestId`로 중복을 막는 별도 append-only inbox에 저장한다. 대화방 전체의 단조 증가 `seq`로 순서를 정하고, 참여자별 읽기 cursor/ack로 재접속 뒤 이어 읽는다. 참여 전 메시지 공개 범위, 참가·퇴장 기록, TTL과 종료·철회 상태를 명시한다. Supabase Realtime의 private Broadcast는 새 메시지 알림에만 쓰고, 알림 유실 시 inbox 조회로 복구한다. Presence는 접속 여부처럼 느리게 변하는 상태에만 사용한다. 활성 세션에서만 연결하며 나머지 시간에는 동기화가 필요할 때 조회한다.
4. 메시지는 명령이 아니라 다른 총괄/프로젝트 endpoint가 제출한 **불신 진단 자료**다. 자동 셸 실행·파일 수정·기억 쓰기 권한으로 승격하지 않는다. 수신 대상의 운영 기억·프로젝트 기억·파일에 대한 원격 직접 접근은 제공하지 않는다. 상대 에이전트가 실행할 진단은 해당 PC의 기존 사용자 권한과 검토 절차를 따른다. 비밀번호, API 키, 원본 클립보드, 전체 대화 기록은 기본 전송 대상에서 제외한다. V1 본문은 Supabase에 읽을 수 있게 저장하므로 별도 동의를 받고 보관 기간을 제한한다. 세션별 종단간 암호화는 후속 계약으로 검토한다. 메시지 접근은 endpoint 등록·기기 신원·세션 동의로 제한한다. service role은 각 기기의 sidecar 밖으로 전달하지 않는다.
5. 각 에이전트가 답변을 기다리는 동안 `wait_dialogue_messages`가 제한된 시간만 대기한다. 참가자별 온라인·대기·오프라인 상태를 표시하고, 멈춘 LLM에 새 지시를 임의로 만들어 재실행하지 않는다. 대화가 끝나면 필요할 때 각 PC가 **자기 총괄 또는 프로젝트**의 기억만 기존 저장 절차로 갱신한다. 대화했다는 이유로 운영 기억과 프로젝트 기억을 합치지 않는다.

`send`만으로 이미 끝난 일반 Codex/Claude 턴이 자동 재개된다고 가정하면 안 된다. 첫 버전은 참여 에이전트들이 활성 작업 중 `wait`를 호출하는 흐름으로 제한한다. 유휴 세션을 깨우는 기능이 필요해지면 각 실행 표면의 지원 범위와 사용자 권한을 따로 검증한다.

## 원격접속과키보드 프로젝트에 적용

이 프로젝트는 제어 Mac과 피제어 Mac의 상태가 모두 필요하다. 두 에이전트가 같은 실험 ID로 각 기기의 Jump 버전·접속 방식(Fluid/수동 VNC/Screen Sharing)·입력 소스·앞면 앱·Caps Lock 경로·pasteboard `changeCount`/형식/시각을 관찰하고 짧은 결과를 교환한다. 내용이 필요한 복사 실험에는 인공 테스트 문자열만 사용하고 실제 클립보드 내용은 대화방에 올리지 않는다. 제어 Mac 에이전트가 가설을 보내면 피제어 Mac 에이전트가 대응 관측을 답한다.

현재 프로젝트의 2026-09-13 진단은 미완료이고, 당시 Jump Fluid 연결은 프로젝트 스크립트의 지원 범위 밖이었다. 설치 버전과 설정은 다시 확인해야 한다. Jump 공식 지원 설명에 따르면 Mac↔Mac 수동 VNC의 원격→뷰어 클립보드는 자동 동기화가 아닌 `Remote > Get Pasteboard` 요청이 필요하고, Fluid는 자동 동기화를 제공한다. 따라서 실험을 방식별로 분리한다. 다른 에이전트와 대화해도 Jump 자체의 전송 제한이 없어지지는 않는다.

빠른 현장 해법은 현재 프로젝트의 양쪽 Mac SSH·진단 스크립트로 근거를 수집하고 사람이 두 보고를 비교하는 것이다. 대화방은 그 비교와 다음 실험 제안을 자동화하는 제품 기능이다. 물리 키 입력, 실제 원격 입력 결과, 양방향 복사 성공은 별도 실기 확인이 필요하다.

## Mac·Windows 앱 빌드에 적용

한 에이전트가 **정확한 Git commit SHA와 빌드 목적**을 보내고, Mac과 Windows가 각각 자기 플랫폼에서 동일 SHA를 확인한 뒤 빌드한다. 각 응답에는 실제 HEAD, clean 여부, source guard 판정, 빌드 목적(공식 릴리스 또는 검증 전용), 검증 명령 결과, 산출물 버전·해시·서명을 담는다. 한쪽의 성공은 다른 플랫폼의 성공으로 표시하지 않는다.

현재 macOS 공식 빌드는 clean worktree와 원격 기본 브랜치 HEAD 일치를 요구하고, Windows 수동 CI 검증 빌드는 디스패치 커밋 검증 예외가 있다(`AGENTS.md`의 출하 소스 가드). 따라서 검증 전용 Windows 산출물을 설치·배포 가능한 공식 산출물과 합치지 않는다. 여러 PC의 빌드는 병렬로 돌려도 버전 증가·릴리스 커밋·원격 Push의 소유권은 하나의 조정 단계에서 순서대로 처리한다. 메시지는 빌드 실행 권한이 아니라 요청과 영수증 전달이며, 각 기기의 로컬 승인·source guard를 우회하지 않는다.

## 구현 순서와 완료 기준

- 첫 단계: Mac 두 대와 Windows 한 대에 총괄/프로젝트 endpoint 신원과 그룹 참여 계약을 적용한다. 총괄↔총괄, 총괄↔프로젝트, 서로 다른 `memoryId`의 A↔B, 같은 `memoryId`의 qq↔qq 모두 명시적 세션 시작/참여·초대·퇴장, 제한된 메시지 저장·조회, 중복 방지·만료·철회를 구현한다. Windows는 별도 담당 PC에서 같은 와이어 계약으로 구현한다.
- 다음 단계: 활성 세션에 private Broadcast 알림과 제한된 `wait`를 붙인다. 알림 없이도 inbox 재조회로 모든 메시지를 회복한다.
- 마지막 단계: 키보드 프로젝트에서 두 실제 Mac의 에이전트가 질문→상대 진단 요약→추가 질문→최종 결론을 교환하고, AgentsToZ 빌드에서 Mac·Mac·Windows의 총괄/프로젝트 에이전트가 하나의 대화방에 참여해 같은 commit SHA에 대한 각 플랫폼 결과를 공유한다. 참가자 추가·퇴장, 오프라인 재접속, **초대되지 않은 총괄/프로젝트** 접근 거절, 한 기기의 총괄과 프로젝트 분리, 중복 요청, 중간 종료, 비밀/클립보드 원문 배제, 기존 기억 CAS 충돌을 각각 확인한다.

## 근거

- 코드: `src/projectMemoryJoin.ts`, `src/projectMemoryDeviceSync.ts`, `src/projectMemoryDirectory.ts`, `src/orchestrationMissionStore.ts`, `src/agentRuntimeConversationService.ts`, `supabase/migrations/20260823000700_remote_device_enrollment.sql`.
- 프로젝트: `/Users/gwanli/product_2026/원격접속과키보드/README.md`, `DIAGNOSTIC-2026-09-13.md`, `tools/clipboard-sync-check.sh`.
- Supabase: [Broadcast](https://supabase.com/docs/guides/realtime/broadcast), [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization), [Presence](https://supabase.com/docs/guides/realtime/presence).
- Jump Desktop: [Mac↔Mac VNC clipboard 동작과 Fluid 비교](https://support.jumpdesktop.com/hc/en-us/community/posts/4411570167181-2-way-clipboard).
