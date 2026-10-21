# 첫 단계 구현 기록

2026-10-15 · codex/voice-remote-growth-plan · 기준 c85d644fcf5fcf8bbe4225c63472df9ce454f74c.

계획의 첫 단계 S0를 구현했다. strict schema, 사전 고정한 예정 pair, 독립 의미 채점,
실패 분모, 조건/설치 버전 결속, nearest-rank p95와 native/CLI 구분의 순수 판정기다.
read-only 파일 CLI와 Quick 검사를 연결했다. [입력·출력·한도](BENCHMARK.md)를 따른다.

RED scaffold에서는 정확한 정본23개가 모두 실패했다. 구현 후23개가 통과했고
Domain coverage는99% 이상/함수100%였다. 소스 전체 판정은 아래 로컬 영수증이 정본이며
이 파일의 초기 대표 검사를 전체 소스/설치 제품 성공으로 확대하지 않는다.

실제 검토에서 같은 음원을 여러 case ID로 복제하는 경로와 0ms 기준선의 상대 감소
판정을 추가 차단했다. 숨겨진 toJSON/accessor/배열 속성도 입력 schema를 우회하지 못한다.
whole pair 누락은 예정표를 기준으로 검출한다. 편집 중 TypeScript fixture의 의도적
invalid input과 optional index 타입 오류는 생산 타입을 낮추지 않고 fixture에서 수정했다.

독립 계획 대조에서 합계 실패율이 의미 오류율 악화를 가릴 수 있는 결함을 발견했다.
candidate30정답+10오답과 reference30정답+10무응답의40pair가 잘못 PASS하는 것을
22pass/1fail 회귀로 재현했다. 의미 오류·provider/transport 오류·전체 실패를 각각
margin0으로 검사하고 양방향 상쇄 회귀를 추가했다. 이전 Quick 영수증은 수정 전 소스로 보존하며
수정 후 Quick·persona·verify를 다시 실행한다.

부분 답변 뒤 연결 오류가 나면 관측된 의미 결과가 오류에 가려지는 경우도 같은 회귀에서
실패 재현했다. 독립적으로 채점한 부분 결과를 outcome 오류와 별도로 보존·검증한다.
수정 전 persona의 SDK/terminal 화면은 UI 단정·exit0 이후 process-cleanup-unconfirmed로
blocked였으며 해당 영수증을 보존한다. 종료 guard를 낮추지 않고 수정 후 공식 runner로 재검사한다.

Quick·중복 제외한16개 persona·전체 verify는 source freeze 후 실행하고 결과/실패/blocked를
`.agentstoz/maintainer/voice-remote-growth-20261015/RESULT.md`에 저장한다.
검사 중 tracked 문서를 수정하지 않는다. 후보 catalog cap64는 우회하지 않는다.

S0의 PASS는 보고된 증거의 기준 충족이다. 모든 report에 productGoalVerified=false,
learning=NOT_RUN을 남긴다. 설치 v785의 실제 음성/원격/교정 수명을 변경하는 코드가 아니라
후속 개선의 검증 기반이며, 앱 전체 우위와 hourly efficacy는 PLAN의 미완료 gate를 유지한다.
S1 명령/lifecycle spike, S2 음성, S3-C/D/E 원격 복구, S4 교정 결과 연결, S5 native 실측이
후속 실행 순서다. 기존 설치본의 수치와 이번 synthetic 회귀를 합쳐 새 제품 성능으로 표시하지 않는다.
