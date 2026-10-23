# 압축 전 복구 저장과 기억 정리

이 문서는 memory-agent v32 소스의 계약이다. 설치된 앱·TestFlight 빌드에 반영됐다는 증거는 별도의 빌드 번호와 실기 영수증으로 확인한다.

## 서로 다른 저장 결과

- **기억 체크포인트**는 기존 명시적 opt-in 아래 완료 턴과 프로젝트 활동을 확인하고 AI로 프로젝트 기억을 정리한다. 사용률 경계는 50·70·75·90%다. 70%를 추가하되 75%를 보존한다. 한 관측에서 여러 경계를 넘으면 가장 높은 경계 한 번으로 처리한다.
- **복구 저장**은 별도 프로젝트 동의와 기존 Mac 암호화 키가 있어야 최근 원문 **최대 32,000 bytes의 조각**을 암호화한다. AI 호출, CORE 변경, remembered 기준 전진, 클라우드 백업은 하지 않는다. 읽기 검증과 영수증 기록 뒤에만 `localCheckpointSaved:true`를 돌려준다.
- **백업**은 기존 기억 저장 경로의 별도 결과다. 복구 조각은 이 Mac에만 남고 기존 Supabase/GitHub 백업으로 보내지 않는다.

실행 중 70% 교차는 내용 없는 SQLite latch에 남는다. 압축 뒤 사용률이 낮아지거나 호스트가 재시작돼도 완료 턴까지 보존한다. 완료 영수증·latch 소비·같은 턴 중복 방지는 동일 트랜잭션이다. 이 latch 자체는 원문 또는 기억 저장 완료가 아니다. 기존 활동 지문만으로 대화 정리를 증명할 수 없으므로, 잠금을 얻은 뒤 활동이 달라졌다면 가짜 성공 영수증을 만들지 않는다. 파일/활동 변화가 없는 대화의 AI 정리는 기존 V2 정책에서 별도 지원하며 legacy 체크포인트 전체를 대체하지 않는다.

## 제공자와 실행 표면

| 제공자 | 신호 | 호스트의 원본 검증 | 한계 |
|---|---|---|---|
| Codex | 공식 `PreCompact`, `Stop` | JSONL session ID·cwd·주 대화 | 제공자가 프로젝트 훅을 읽고 허용해야 한다. 이 프로젝트에서 새 훅을 설치해도 이미 열린 다른 앱 세션의 적용을 증명하지 않는다. |
| Claude | 공식 `PreCompact`, `Stop` | JSONL session ID·cwd·sidechain 제외 | 제공자가 아직 쓰지 않은 원문은 보존할 수 없다. |
| Hermes | `pre_api_request`, 완료·영속화 후 `on_session_end`, compression `pre_auxiliary_call` | provider SQLite session ID·cwd와 일관된 메시지 읽기 | 지원 버전과 로드된 plugin 필요. 턴 밖 수동 압축이 session ID 없이 보낸 auxiliary 신호는 저장하지 않는다. 기존 memory provider를 교체하지 않는다. |
| Antigravity | 공식 `PreInvocation` | 서버가 계산한 transcript 경로와 hook의 정확한 단일 workspace | 현 transcript에는 cwd가 없어 `provider-hook-workspace`라는 더 약한 근거를 표시한다. 공식 PreCompact·정확한 사용률 신호가 없어 모든 압축 직전 저장을 보장하지 않는다. |

공통 처리기는 Workroom과 외부 앱·CLI를 구분해 새 AI를 실행하지 않는다. 같은 등록 프로젝트·원본·호스트 저장 동의가 검증된 요청만 처리한다. 등록이 해제되거나 cwd/기억 ID가 바뀌면 읽기·저장을 중단한다. iPhone은 연결한 Mac 호스트의 설정을 사용한다. 현재 암호화 키 수명 계약에 맞춰 **설치형 Mac sidecar만 지원**하며 Windows/Linux의 실기 저장 완료를 주장하지 않는다.

공식 계약: [Codex PreCompact](https://learn.chatgpt.com/docs/hooks#precompact), [Claude hooks](https://code.claude.com/docs/en/hooks), [Hermes hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks), [Antigravity hooks](https://antigravity.google/docs/hooks).

## 기존 프로젝트 갱신

앱의 개별·일괄 에이전트 업데이트는 `upgrade-adapters`로 생성 지침·훅만 바꾼다. 기억 문서의 원본 bytes, 항목 ID, 연결 설정, 마지막 저장 기준과 journal은 보존한다. 어댑터 버전과 문서 형식 준비 상태는 별도 표시한다. 형식 검토가 남아 있어도 지침을 반복 갱신하지 않는다. 이 새 경로가 없는 구형 호스트에서는 오류를 표시하며, 문서를 마이그레이션하는 기존 `upgrade-agent`로 재시도하지 않는다.

## 동의·보관·복구

워크룸의 기억 상태에서 `압축 전 복구 저장`을 연다. 상태 조회는 DB/키를 만들지 않는다. 기존 암호화 키를 준비한 뒤 원문 보관에 별도 동의해야 켜진다. 기존 legacy/V2 opt-in, 프로젝트 기억 업그레이드, 훅 설치만으로 켜지지 않는다. 제공자의 훅 신뢰 확인은 기존 UI를 그대로 따른다.

기존 AES-GCM input store, app-data directory lease, 7일 TTL을 재사용한다. 복구 조각은 별도 `precompaction-inputs` 디렉터리의 64MiB·4096개 항목 예산을 사용하므로, 가득 차거나 만료 표식이 쌓여도 기존 AI 기억 정리의 `memory-save-inputs` 예산을 소모하지 않는다. 주기 요청은 세션당 120초에 한 번으로 제한하고 정확한 pre-compaction 신호는 그 제한을 우회한다. 같은 source digest·범위·정책 revision의 재전송은 같은 영수증으로 귀결한다. 키가 유실됐다고 새 키를 만들지 않는다. 60초 기존 유지보수 tick에서 만료된 암호문을 인증 후 제거하며 조각의 영수증은 남긴다.

Hermes의 첫 모델 요청에 사용자 행만 있으면 주기 저장을 요청하지 않는다. 완료·실패·중단 여부가 명시되고 같은 세션의 assistant 행이 영속화된 뒤 첫 주기 저장을 시도한다. 완료 훅도 기존 120초 제한과 별도 프로젝트 동의를 따른다. 이 제한 안의 후속 변경과 session ID 없는 수동 압축까지 보장하지 않으므로, 압축·초기화 전 실제 영수증 시각과 원문을 확인한다.

원문은 capability로 보호된 명시적 읽기에서만 반환하고 `historical-untrusted` 자료로 표시한다. 설정 열기·새로고침만으로 원문을 읽지 않는다. 다른 프로젝트로 바꾸면 원문과 동의 체크를 지우고 늦은 응답을 버린다. 만료 전 영수증도 파일 존재·복호화 성공을 증명하지 않으므로 실제 읽기로 확인한다.

로컬 hook endpoint는 원문/파일 경로를 받지 않는다. 16KiB 이하 metadata와 서버가 해석한 등록·원본만 사용한다. Python hook은 proxy/redirect를 쓰지 않으며 1초(주기)/8초(압축 전) 제한 안에서 실패를 알린다. 실패로 사용자 AI를 중단하거나 재시작하지 않는다. 제공자 장애나 전원 종료를 포함한 모든 압축 직전 저장을 보장하는 기능은 아니다.

JSONL 원본은 신원 확인용 앞부분 256KiB와 한정된 뒷부분만 읽는다. Claude는 실제 훅 로그가 대화 뒤에 수백 KiB씩 붙는 경우를 위해 뒤쪽 2MiB, Codex·Antigravity는 256KiB를 탐색한다. Claude의 압축 요약·로컬 명령 출력은 실제 대화로 세지 않으며, 선택한 원본의 연속 바이트 조각은 여전히 32,000 bytes 이하다. 탐색 한도 밖의 대화를 찾았다고 주장하거나 로그만 저장해 성공으로 표시하지 않는다.

## 충돌 보존

자동 병합 제안은 항목 밖의 원격 제목·설명·결정을 검토용 원문으로 함께 보존한다. 코드 예시 안의 가짜 heading/ID를 실제 항목으로 해석하지 않는다. 중복·잘못된 stable entry ID는 자동 재발급하지 않고 양쪽 원본을 남긴다. 충돌 확정 경로는 원격 CAS·백업·파일 쓰기 전에 모호한 ID를 거절한다. 현재 실제 기억이 동기화된 상태라면 과거 handoff의 충돌을 강제로 재현하거나 원본 ID를 바꾸지 않는다.

## 검증

`.agentstoz/maintainer.json`의 `precompaction-recovery-contracts`, `memory-journey-screen`이 실제 암호화 readback, 4개 원본 adapter, provider hook Python 실행, 격리 sidecar capability, Chromium/WebKit의 별도 동의·프로젝트 전환을 검사한다. 이 검사는 설치 앱·TestFlight·실제 provider 압축의 실기 판정과 별개다.

```sh
python3 scripts/agentstoz-maintainer.py run --root . --profile quick
python3 scripts/agentstoz-maintainer.py personas run --root .
bun run verify
```
