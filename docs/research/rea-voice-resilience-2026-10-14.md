# 음성과 원격제어: 추가 연구와 장애 회귀

2026-10-14 · 기준 소스 `d06c23934a450ebddb7b2636db8b97b2efe1b454`

사용자 목표는 음성의 성능과 원격제어의 편의·안정성에서 Codex를 뚜렷하게 앞서는 것이다.
이번에는 [어제의 연구](rea-chatgpt-sessions-remote-2026-10-13.md)를 현재 설치 앱의 작은 음성 모듈로
확장하고, AgentsToZ의 실제 실패를 먼저 재현해 수정했다. **제품 간 우위는 아직 실측하지 않았다.**

## 연구 범위와 방법

현재 Mac의 `/Applications/ChatGPT.app`은 `26.1007.30912`, build `20156`이다. 어제 다른 단말에서
분석한 버전과 같다고 가정하지 않았다. ASAR 안에서 음성 모듈 5개, 총 21,882 bytes를 골라 각각의
선언 SHA-256과 실제 bytes가 일치하는지 확인했다. 추출 코드는 실행하거나 저장소에 넣지 않았다.

REA 6.4.0으로 작은 입력 묶음을 정적으로 분석했다. JavaScript 5개 모두 파싱됐고 이 입력의
application graph는 `complete`다. 제외된 의존성과 동적 경로를 포함한 semantic coverage는
`unknown`이며 unknown 1,300개가 남았다. 전체 앱의 기능·성능 검증으로 해석하지 않는다.
해시, evidence ID, 범위와 제한은 [증거 JSON](rea-voice-resilience-2026-10-14.evidence.json)에 있다.

[REA 방법](https://rea.tools/guides/javascript/)에 따라 기능 경로를 좁히고, 정적 발견을 독립적인
장애 시험으로 확인했다. 동일한 API·이름의 존재만으로 실행·안정성·권한 보장을 추정하지 않았다.

| 정적 발견 | 적용 또는 후속 질문 |
| --- | --- |
| 입력 worklet에 준비 중 버퍼, 무음 정리, mute 시 메모리 삭제와 phase 보고가 있다 | 첫 발언 유실과 연결 준비 중 안내를 별도 측정해야 한다. 이번 변경은 시작 전 오디오 버퍼를 추가하지 않는다. |
| prewarm은 마이크 사용 조건을 확인하고 abort를 await 이후에도 검사한다 | AgentsToZ의 늦은 응답과 마이크 획득에 세션·입력 세대 검사를 적용했다. 사전 마이크 수집이나 유료 연결은 추가하지 않았다. |
| handoff target의 sequence는 표시 애니메이션에 쓰인다 | 파일명만 보고 실행 기기의 handoff 구현이라고 결론 내리지 않았다. |

공개 Codex 원격 transport도 당시 `main`의 정확한 커밋
[`7a08c5f6271e818d832eb9061dac935936e2b539`](https://github.com/openai/codex/blob/7a08c5f6271e818d832eb9061dac935936e2b539/codex-rs/app-server-transport/src/transport/remote_control/websocket.rs)을
읽었다. stream별 ACK, 재접속 backoff, 비활성화·인증 소유자 변경 시 대기 취소를 확인했다.
이는 공개 host 코드의 관찰이며 모바일·relay 서버 전체의 보장을 입증하지 않는다.

OpenAI Realtime의 WebRTC는 서버가 재생하지 않은 음성을 interruption 때 정리한다고
[공식 문서](https://developers.openai.com/api/docs/guides/realtime-conversations#interruption-and-truncation)가 설명한다.
따라서 임의 truncate나 사용자 지시 재전송을 추가하지 않고, 기존 peer의 짧은 단절을 복구한다.

## 수정한 실패 경로

| 문제 | 변경과 확인 근거 |
| --- | --- |
| 종료된 음성의 늦은 `say` 결과가 새 대화 상대·자막에 섞임 | 현재 세션 세대일 때만 응답을 적용. 수정 전 실패 재현, 교체 후 상태·자막 유지 검사 |
| 이전 Mac의 caption 미지원 응답이 새 대화 번역을 끔 | capability 변경에도 같은 세대 검사 적용. 수정 전 재현 |
| 마이크 다시 켜기를 연속으로 누르면 여러 stream을 획득 | 획득 요청 병합, 취소된 input 세대의 stream 해제. 권한창·종료 경합 검사 |
| 중복 종료가 host stop을 두 번 전송 | 같은 클라이언트 종료를 한 번 처리. CLI 작업 종료와 분리 |
| Gemini 종료 뒤 늦은 audio/transcript를 소비 | 닫힌 소비자에 결과 적용 금지. 수정 전 재현 |
| Gemini의 마지막 PCM 조각을 버리거나 `media.end`가 추월 | 이미 잡은 조각을 전부 순서대로 drain한 다음 end. 수정 전 재현 |
| PCM 대기열 초과 시 발화를 조용히 버림 | 기존 예산에서 한 번 실패를 알리고 손실을 숨기지 않음. 수정 전 재현 |
| Gemini 입력 ACK가 출력이 올 때까지 최대 180ms 대기 | append/end는 nonblocking media drain, 출력 read만 long poll 유지. provider·host 계약 검사 |
| 상태 조회 한 번의 네트워크 오류로 음성이 종료 | read-only 조회에 재시도 2회. 권한·만료·protocol 거절은 재시도하지 않음 |
| WebRTC `disconnected` 즉시 종료 | 같은 peer를 5초 유지하며 안내. 복귀 시 timer 제거, 실패 시 종료. 새 prepare나 지시 재전송 없음 |
| 원격 사용자의 입력이 대기 중인 배경 조회 뒤에서 지연 | 진행 중 요청을 보존하고 사용자 입력을 우선. 네 번 우선 처리 후 가장 오래된 대기 요청에 양보 |
| host 재시작 뒤 예전 대기 작업이 새 token으로 실행 | admission과 await 이후 token 재검사. 이전 작업은 보내지 않고 화면 확인 안내 |

음성 마이크·실행·저장 동의, 프로젝트·기기 grant, E2EE와 미확정 결과의 자동 재실행 금지 경계를 유지한다.
`test:voice`와 기존 Quick·페르소나의 실제 검사에 새 회귀를 포함했다. 복구 안내는 패널과 도크의
접근성 상태에 함께 표시한다.

## 제품 비교의 완료 기준

다음은 **합의 가능한 목표값을 정하기 위한 초기 기준**이며 달성 결과가 아니다. 제품 버전,
선택한 음성 모델, Mac/iPhone·마이크, 언어와 네트워크를 기록한다. 각 제품에 같은 입력을
번갈아 적용하고 실패도 분모에 넣는다. fixture 결과와 실제 provider 결과를 섞지 않는다.

| 비교 항목 | 완료 판정에 필요한 증거 |
| --- | --- |
| 한국어·영어 혼용, 프로젝트·AI 이름 인식 | 고정 문장 60개 이상. 첫 단어 유실 0, 이름·실행 대상 오류 0. 인식 오류율이 Codex보다 낮음 |
| 답변 시작·끼어들기·재개 | 각 30회 이상, p50/p95와 실패율. 주요 지연 p95가 Codex보다 최소 30% 낮고 실패율이 증가하지 않음 |
| 음성으로 프로젝트 선택→워크룸 지시→실제 결과 확인 | 같은 과제 30회 이상. 잘못된 기기·프로젝트 0, 접수와 완료 구분, 클릭·수동 재시도 횟수 감소 |
| Wi-Fi 전환·잠금 복귀·host 재시작 | 조건별 30회 이상. 중복 실행·초안 손실·유효 권한의 불필요한 QR 재등록 0. 복구 p95가 Codex보다 최소 30% 낮음 |
| 한 시간 연속 사용 | 마이크·타이머·queue가 계속 증가하지 않음. 접속·재생·입력 상태가 실제 동작과 일치 |

표본이 없거나 상대 버전·입력·환경이 다른 경우 우위를 판정하지 않는다. 평균만 낮고 p95 또는
오류율이 나빠진 경우도 목표 달성으로 표시하지 않는다. 현재 접근 가능한 Codex UI/실제 음성,
개인 인터넷 relay와 물리 iPhone의 비교 영수증이 필요하다.

## 아직 남은 범위

- 실제 provider의 인식·지연과 셀룰러 전환 비교는 이번 격리 검사에 포함되지 않았다.
- Gemini의 인터넷 relay PCM 처리량은 별도 실측이 필요하다. 기존 프레임 크기·대기 예산을
  늘려 문제를 숨기지 않는다. 느린 연결의 포화는 현재 명시적 오류다.
- 시작 중 첫 발언 버퍼와 동의된 사전 준비는 비용·마이크 수명·취소 증거를 갖춘 별도 구현이다.
- 어제 설계의 영속 제출 영수증·writer lease(C), 원격 저장 history(D), semantic queue·암호화 초안(E)은
  이번 수정으로 완료되지 않았다. [기존 구현 범위](../plans/workroom-conversation-recovery-2026-10-13/EXECUTION.md)를 유지한다.
- 설치 앱 교체·개인 relay 배포는 이번 코드 검증과 별도다.

실행 결과와 현재 제약은 [이번 실행 기록](../plans/voice-remote-resilience-2026-10-14/EXECUTION.md)에 기록한다.
