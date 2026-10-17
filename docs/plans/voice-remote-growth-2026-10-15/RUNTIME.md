# 설치 동작 개선: 음성 종료·전체 요청 제출·다음 작업 교정 문맥

2026-10-15. 기준 `da0013cab8cee59056a99d687c39351fc4d66c65`, 브랜치 `codex/voice-remote-runtime-growth`.
**구현·검증 중이며 설치·제품 우위·교정 efficacy의 완료가 아니다.** 소스 고정 이후의 실제 영수증은 `.agentstoz/maintainer/runtime-growth-20261015/`에 둔다.

## 음성

호스트 stop은 AbortSignal을 먼저 취소한다. 기존 Realtime close는 취소 listener가 hangup을 시작하면 두 번째 close가 boolean만 보고 반환해 제공자 종료를 기다리지 않았다. 두 호출이 동일한 Promise를 공유하도록 고쳤다. 소유한 고정 call URL에서 HTTP 성공을 확인하며 실패는 최대2회·각2.5초·간격300ms로 제한한다. 응답 본문과 credential-bearing 예외는 내보내지 않는다. 로컬 sideband와 media 권한은 종료하고, 제공자 종료 미확정은 기존 notice로 구분하며 기록 마무리는 계속한다.

검토된 음성 지시는 지원되는 호스트에서 아래 전체 제출을 재사용한다. 초안마다 동일한 제출 식별자를 유지하며, 내용·참조 digest가 바뀌면 기존 영수증을 성공으로 재사용하지 않는다. 기존 입력 revision·질문/exit 방어·대상/계정/권한을 유지한다. 수신·입력·AI 작업 완료를 같은 것으로 표시하지 않는다. Live의 partial transcript와 delegation metadata를 final command로 합성하지 않았고 모델·음성·VAD 기본값·사용자 키 설정도 자동 변경하지 않았다.

v789 설치 시험에서 peer를 먼저 닫으면 제공자 종료 확인이 미확정이고, 호스트 종료를 먼저 기다리면 확인되는 순서 의존성을 재현했다. 후속 클라이언트 수정은 **Tauri의 직접 로컬 transport**에서 연결된 OpenAI 대화를 정상 종료할 때만 적용한다. 마이크·스피커·화면 listener는 즉시 해제하고, peer 하나만 호스트 응답 또는 최대10초까지 유지한다. 시간 초과는 종료 확인 실패로 표시한다. 새 대화 시작은 이전 peer를 즉시 회수하고 이전 응답은 새 대화를 변경하지 못한다. 원격 transport·오류·백그라운드·화면 이탈·준비 중 연결은 즉시 해제를 유지한다. 설치본 재검증 전에는 이 후속 수정의 실제 성공으로 표기하지 않는다.

## 전체 요청 제출

사용자 관점 시험에서 보관 초안의 첫 반영 중 빈값과 `#` 참조 선택 직후 첫 글자가 앞에 끼는 경합을 재현했다. 새 초안과 자동완성 커서는 DOM 반영 직후 layout 단계에서 적용한다. 기본 프로젝트 선택은 최신 값이 비어 있을 때만 적용해, 복원한 명시 대상이 알 수 없는 프로젝트여도 덮어쓰지 않는다. 커서 요청은 값·기기 scope·세션이 일치할 때만 적용하며 다음 입력 뒤의 지연 frame이 커서를 되돌리지 않게 한다.

기존 terminal-v1 raw input은 키·이미지·구형 호스트 경로에 유지한다. 새 작성칸은 `list(capabilities:true)`로 `terminal-submission-v1`을 확인한다. 일반 list 요청의 기존 응답 모양은 바꾸지 않는다. 구형 호스트는 명시적 unknown-request 오류에만 read-only list로 한 번 내려간다. 새 기능의 전송 도중에는 raw fallback·자동 retry가 없다.

| 단계 | 계약 |
| --- | --- |
| begin | 같은 owner/session/target/계정 결속·현재 input revision·manifest를 영속 prepared 메타데이터로 예약 |
| chunk | 전체24,000 UTF-8 bytes, 조각4,000 raw bytes·최대6개, canonical base64·정확한 길이·동일 index 중복 대조 |
| commit | 전체 digest·strict UTF-8·마지막 Enter·현재 권한/epoch/revision을 확인한 뒤 write_started를 동기 영속 기록 |
| written/unknown | 실제 전체 PTY 쓰기 반환 또는 부분 쓰기/오류를 구분. 몸통→settling→Enter 사이에도 권한/close를 재확인 |
| status | 같은 호스트 저장소 계보의 영수증만 조회. 미확정·없음·다른 계보는 자동 재실행 근거가 아님 |

4,000-byte 이하 요청은 `single` 한 번으로 같은 검증·영속 경계를 통과한다. 긴 요청은 begin에 첫 조각을 포함하고 마지막 chunk에서 commit하여, payload 조각 수보다 준비/확정 왕복을 추가하지 않는다. 독립 begin/chunk/commit도 같은 검증 경로를 사용한다. 가장 가까운 만료 시각의 timer 하나가 후속 요청이 없는 assembly도 회수하고, 쓰기 직전에 만료 여부를 다시 확인한다.

본문은 최대8개 assembly·각30초의 휘발 메모리에만 둔다. 다른 raw 입력은 조립 예약 중 거절하고, close는 기다리는 입력을 끊을 수 있다. metadata journal은 최대20,000개에 도달하면 새 제출을 거절하며 미완료 기록을 삭제하지 않는다. 원격 참조는 기존 gateway에서 현재 허용 ID를 해석하고 실제 폴더 설명·교정 문맥을 더한 뒤에도 최종24,000-byte 한도를 확인한다. 새 조각은 일반 UUID ID에서 기존8,500-byte 암호화 message 예산 안에 들어간다.

기존 `workroom-history-v1/history.sqlite`의 v1→v2 트랜잭션 migration이 제출 metadata와 target index를 추가하며 store instance와 기존 대화/재개 기록을 보존한다. 재시작한 write_started는 unknown이다. 본문·credential·환경·음성 원문은 새 metadata에 저장하지 않는다. SQLite와 PTY는 원자적 단일 자원이 아니며 CLI exactly-once 또는 AI 접수/완료를 보장하지 않는다. v1 앱으로 rollback할 때에는 배포 전 history DB 사본도 함께 복원해야 하며, v2 원본을 버리지 않는다.

브라우저는 raw 본문 없이 제출 ID·session·영수증만 sessionStorage에 최대32개 보존한다. 응답 유실 때 작성칸을 유지하고, 새로고침 뒤 결과 확인 배너를 복원한다. 새 자연어 제출은 미확정 결과 확인까지 보류한다. 명시적 사용자 확인만 그 배너를 해제하며 원격 자동 동작을 승인하지 않는다. 탭 종료 후 raw 초안의 암호화 보관과 reconnect/history/cursor는 S3-D/E의 별도 미완료 범위다.

현재 새 계약은 **이미 실행 중인 세션의 plain text 작성칸과 검토된 음성 지시**에 적용한다. 이미지·새 세션 첫 요청·다른 기기로 보내는 `@` 경로는 기존 계약을 유지하며 같은 receipt 보장을 주장하지 않는다.
여러 줄 요청은 CLI의 bracketed-paste 준비가 확인된 경우에만 새 제출로 쓴다. 준비되지 않은 LF를 보냈다가 앞줄이 먼저 실행되는 일을 막고 초안을 유지한다. 자동 교정 문맥 자체는 한 줄로 접어 붙이며 새 키 입력을 만들지 않는다.

## 교정 문맥과 시간별 점검

등록된 DEV 프로젝트의 전체 제출 직전에 관련 correction 최대3개·원문 최대6,000bytes를 결정적으로 회상한다. 현재 본문 버전의 철회된 claim은 넣지 않고 보고된 실패 원인/다음 처리만 넣는다. 제공자에게 보내기 전 민감 패턴을 제거/보류하고, 현재 교정 버전을 다시 검증한다. OPS/shared Control은 이 자동 경로에서 제외하며 원본 기억·긍정 승격·공유 후보 승인을 변경하지 않는다.

실제 쓰기 경계에 memoryId·entry/body version·report 식별 해시·전달 context digest를 같은 제출 영수증에 남긴다. 원문을 metadata에 복사하지 않는다. 최근 local128개 제출의 전달/미확정/민감 원문 보류와 독립 결과 대기 수를 구분한다. `efficacyVerified=false`이며 전달 수·checkedAt을 avoided로 바꾸지 않는다. 독립 avoided/repeated outcome과 실제 장기 반복률 비교는 S4 미완료다.

128개 요약 캐시와 최대1,000개 등록 target의 점검 시각을 분리했다. 캐시 eviction이 한 시간 내 반복 점검을 만들지 않는다. 기존8 targets/minute·target/hour·128 summaries 한도를 유지하며 대기·지연·실패·읽기 불가를 표시한다. 많은 프로젝트에서 한 시간 내 전부 점검할 수 없음을 지연 수로 드러내고 AI 추가 호출·원본 삭제로 해결하지 않는다.

## 검증과 설치 gate

공통 runner1.7.1은 종료 신호의 권한 오류 뒤 그룹 상태를 한 번만 보던 경로를 기존2초 정리 유예 안에서 다시 관측한다. 실제로 그룹이 없거나 zombie만 남은 상태를 확인해야 정리를 인정한다. 살아 있는 그룹·관측 실패는 계속 차단하고 이 경로에서 추가 신호를 보내지 않는다. 기존1.7.0 원본 hash도 업그레이드 계보에 보존한다.

공유 Mac의 반복 전체 검사에서 실제 Git·암호화 fixture·fsync를 준비하는 통합 테스트 5개가 Bun 기본5초를 넘겼다. 해당5개만 실행 예산20초를 명시한다. 권한·복구 단정과 별도25,000-entry 보관의45초 성능 단정·60초 시험 예산은 유지한다. 기존 실패/중단 기록을 보존하며 변경된 시험 소스까지 다시 고정해 Quick·persona·전체 검사를 실행한다.

회귀는 UTF-8/전체 해시/누락·중복 chunk, SQLite 재시작/계보·migration, lost ack/unknown, short write/권한 철회/Enter 대기, 음성 close single-flight, 교정 버전 교체/민감 정보/캐시 eviction을 확인한다. 별도 rendered fixture에서는 긴 한글·이모지 요청의 응답 유실→초안 유지→status 조회→reload 뒤 쓰기0회를 관측했다. synthetic fixture를 설치 Mac·휴대폰 실측으로 표기하지 않는다.

설치 전 Quick(12개)·중복 제외 구성 persona16개·verify를 같은 source freeze로 실행한다. 검증한 private main을 실제 origin HEAD와 대조한 normal macOS build·서명·bundle/sidecar hash·기존 bundle/history 백업→설치/재실행→소유한 실제 세션 시험 순서를 따른다. 현재 Codex native UI 자동 제어의 안전 차단은 유지한다. 실제 mic·인증 iPhone/cellular·1시간·paired native 비교 및 교정 효과가 충족되기 전 전체 목표는 완료가 아니다.
