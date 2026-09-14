# 앱 자원 관리 기준

이 문서는 RAM·타이머·대기열의 수명과 반복 검증 기준이다. 프로젝트 장기기억의 원본, 저장 실패 작업, 사용자 로그 파일을 메모리 절감을 위해 삭제하지 않는다. 화면이나 캐시에서 제거한 내용은 원본에서 다시 읽을 수 있어야 한다.

## 수명과 예산

| 영역 | 현재 기준 | 해제·복구 경로 |
|---|---|---|
| 웹 공통 북마크 조회 | 페이지 500개, 전체 10,000개·JSON UTF-8 8 MiB 상한 | 인증된 동일 자료 범위에서 기기 선택과 독립 조회. 중간 실패·중복 ID·한도 초과는 부분 결과로 교체하지 않고 기존 목록 보존. 조회는 자료 이관·삭제를 수행하지 않음 |
| 모바일 작업 공간 | 요청자 최대16개·분당60회, 응답8,500 bytes, 기록 페이지3개·본문1,500 codepoints, 화면 저장 상태 조회3초 | 비활성 화면의 상태 조회 중지, 문서 숨김/연결 종료 시 기록 본문 해제. 원본 기록은 삭제하지 않음. 같은 호스트 탭은 연결 객체를 유지 |
| 모바일 기억 저장 영수증 | 0600 원자적 파일 최대128개·실행1개, 영수증 읽기4 KiB | 승인된 접수는 모바일 연결과 독립 실행. 재전송은 같은 영수증 반환, 재시작 시 미확정 작업은 복구 필요로 유지. 한도 도달 시 새 접수 거부, 자동 삭제/재실행 없음 |
| 모바일 워크트리 정리 검토 | 메모리 토큰 최대64개·5분 | 실행 직전 등록/디렉터리/Git 상태 재검증, 삭제 시도 전에 토큰 소모. 재시작 뒤 새 검토 필요, 강제 삭제 없음 |
| 공통 기억 저장 dispatcher(API 연결) | sidecar당 실행1개·대기16개·대기30초, root 최대17개, 대기당 timer/abort listener1개 | 수동 우선3회 뒤 background 순번. 같은 canonical root 중복 거부, 대기 중 workspace lease 없음. 대기 취소/초과/시작 때 timer/listener 제거. UI 연결 종료는 시작된 저장을 중단하지 않음. 앱 종료는 저장 CLI 종료 증명 후 lease 반환. 영속 기록은 기존 terminal/checkpoint/session store에 유지 |
| V2 암호화 키 준비(워크룸·로컬 API 연결) | marker/next 각각4 KiB, credential stdout/stderr 각각256 bytes·명령당5초, directory lease당 준비1개 | 상태 조회는 OS 인증을 호출하지 않음. 준비에서만 detached stdin으로 새 키를 추가하고 exact fingerprint 재조회. raw key는 argv/metadata/API에 넣지 않고 buffer를 비움. ready 키 유실은 복원 필요로 남기며 초기 설정 복구는 저장 이력 없는 경우만 허용 |
| 장기기억 CLI 출력 | stdout/stderr 각각2 MiB 상한, 기본300초 | pipe를 동시에 읽고 초과·오류·timeout·앱 종료 취소 때 CLI/process group 종료를 확인한 뒤 lease 반환. Codex 프롬프트는 argv에 남기지 않고 stdin으로 전달 |
| V2 통합 저장 실행 함수(설치 Mac opt-in 연결) | 실제 프롬프트48,000 bytes, 제안 및 host 문서/state 새 내용256 KiB, 동일 staging lease 실행1개 | 호출 전 source·동의·quota·키·디스크 검사, 시작 시점 활동/HEAD 유지. 실행 intent 이후 실패는 영구 fence로 남기며 자동 재호출 금지. input/key buffer는 종료 시 비우지만 JS 문자열의 안전 삭제를 주장하지 않음 |
| 포트 로그 화면 | 최근 500줄, 추정 문자열 512 KiB; 조회는 한 번에 1개 | 닫기·다른 로그 선택·문서 숨김·unmount 때 조회 수명 종료. 늦은 응답은 무시. 다시 열면 원본 tail 조회 |
| 작업 이벤트 화면 | 작업 화면이 보일 때만 조회 | 대화 화면·다른 탭·숨은 문서에서는 중지하고 재표시 때 cursor부터 재개. 작업 실행 자체는 계속 유지 |
| 작업 projection 캐시 | 최대 10개, 추정 8 MiB | 최근 접근 순서로 비활성 캐시 제거. 활성 작업 하나는 보존하며, 그 하나가 예산보다 크면 다른 캐시를 제거. 재선택하면 durable journal부터 다시 읽음 |
| 장기기억 journal 캐시 | 전체 추정 8 MiB, 최대 32개 root | 파일 stamp가 바뀌면 재조회. 예산보다 큰 단일 journal은 읽기 결과만 반환하고 캐시하지 않음 |
| 세션 저장용 transcript | 64 KiB씩 읽기, JSONL 레코드 최대 4 MiB, 선택 본문 48,000 bytes | 최신 시간순 본문만 제한된 accumulator에 보관. 소유권이 확인된 파일의 기록을 읽지 못하면 저장완료 기준을 전진시키지 않음 |
| 내가 한 말 자동 수집 | 서버 시작 및 15초마다 등록 기억 하나씩 순환, 동시 자동 작업 1개, 기존 8 MiB 읽기 예산 | 전체 저장 opt-in과 종료 상태를 발견 전·후 확인. 프로젝트별 수집 직전 정책 재확인. 부분 수집은 다음 순환에 재개하고 실패한 대상도 순번을 넘김. 원본·cursor는 보존 |
| 내가 한 말 파일 분류 | 256개씩 DB 조회·저장; 기존 읽기 예산 8 MiB | 분류를 저장한 뒤 배치 cursor를 CAS로 갱신. 중간 중단은 중복 방지 receipt로 재수집 |
| 워크룸 기기 권한 | 단말당 승인 기록 최대 256개, JSON 512 KiB, 범위별 대상 256개 또는 작업 루트 64개 | 프로세스 간 소유 잠금 아래 CAS·0600 atomic write(50회·20ms 대기 상한). 죽은 소유자의 잠금을 자동 삭제하지 않음. 철회 revision과 만료 기록을 축출하지 않으며 한도 도달 시 새 승인만 거부. 페어링 만료를 넘지 않는 최대 30일, 매 요청·대기 작업에서 현재 기기·소켓·revision·root 신원 재검증. 손상된 저장소는 권한을 새로 만들지 않고 해당 접근만 거부 |
| 워크룸 요청 | 기존 요청 이력 100,000개 상한; 대기 mutation 256개 | 실행 중 입력의 재전송 방지 유지. 세션 종료 때 그 세션의 input/resize 이력 회수. 종료 요청은 별도 경로로 허용 |
| 워크룸 화면 요청 큐 | 로컬·원격 대기 요청 최대 256개 | 종료는 세션당 한 요청으로 합치고 전송 대기 입력을 취소. 종료가 기존 입력 응답 뒤에서 기다리지 않도록 별도 전송 |
| 워크룸 세션 저장 큐 | SQLite cache 256 KiB, tick 한 건, 상태 페이지 최대 256건(API 128건), 성공 표시 이력 128건 | 미해결 작업과 성공 중복 방지 ID는 디스크에 보존. legacy JSON은 최대 8 MiB까지 한 번 검증·이전하고 원본 보존. 더 큰 입력·손상·future version은 덮어쓰지 않음 |
| V2 저장 기반(설치 Mac opt-in 연결) | 관측·작업 keyset 페이지 128건, 예약 구간 128개, SQLite cache 256 KiB·busy 100ms, 각 연산 후 연결 닫기 | 본문·경로·타이머 없음. 완료 구간과 실행 fence는 디스크에 보존하며 이력 크기로 축출하지 않음. 모델 호출·비용 및 디스크 admission은 AI 통합 전 필수 후속 작업 |
| V2 자동 호출 admission(설치 Mac opt-in 연결) | rolling24시간8회·같은 memoryId30분1회·전역 미확정 시도1개, quota 조회 최대8행·프로젝트 최근1행, 제외 memoryId 최대1024개 | schema3의 동의 CAS·활성화 시각/관찰 sequence 경계·provider binding·quota·시도 intent를 같은 DB에서 확인. quota와 intent를 단일 transaction으로 예약하며 실패·SIGKILL·설정 재활성화로 환불/초기화하지 않음. 미확정 시도와 사용 이력은 원본 fence와 함께 보존. host 시계 퇴행에서는 실행 차단·opt-out 허용 |
| V2 디스크 사전 검사(실행 경로 미연결) | app-data와 기억 volume 여유2 GiB+예상 쓰기량(암호문 envelope 최대70,000 bytes 포함); 두 관찰/저장 DB와 journal/WAL/SHM 합계250 MiB 경고·1 GiB 차단, WAL/SHM64 MiB 초과 차단; 입력64 MiB·manifest/백업 및 host session DB+저널/WAL/SHM 합계512 MiB | 읽기 전용·비삭제 검사. 디렉터리별 buffer32, 전체4096 entries·깊이8, 특별 파일/변경 감지 시 불완전으로 차단. reserve32 MiB의 실제 할당·0600·inode/ready receipt 확인. lease/등록 재검증과5초 신선도 확인 뒤 기존 자동 admission 호출. 이 검사는 공간 예약이 아니며 reserve 수명은 아래 모듈을 사용한다. 실제 단일 writer/설치 통합은 후속 |
| V2 임시 입력 키 조회(설치 경로 미연결) | macOS 전용·비동기 `/usr/bin/security` 조회, timeout5초·출력256 bytes, 캐시 없음 | 별도 service와 기존 installation identity의 hash account만 사용. missing/locked/오류/잘못된32-byte base64 구분, 키 생성·다른 키 fallback·재시도 없음. stdout/stderr buffer 정리, 반환 키는 호출자 수명. 키 생성·복구·실제 Keychain 접근 검증은 별도 통합 |
| V2 입력 원문 재검증(실행 경로 미연결) | 최대128개 완료 턴, 읽기 합계8 MiB·헤더256 KiB/파일, FD 동시1개, 전체 JSON 입력48,000 bytes | sourceKey 정렬로 DB coverage와 대조하고 파일의 정확한 구간·UTF-8/JSONL 경계·완료 판정·SHA-256 재검증. 과거 전체 파일을 읽지 않고 offset seek. 원문 record를 잘라내거나 새 대화 tail로 대체하지 않으며 한도 초과는 전체 그룹 보류. 등록/lease와 파일·cwd·부모 경로를 읽기 전후 확인 |
| V2 암호화 임시 입력(실행/키 관리 미연결) | 평문48,000 bytes, AES-256-GCM envelope70,000 bytes 이하·총64 MiB, 보관7일, 폴더 목록4096개·buffer32 | 별도 OS 키를 받는 내부 모듈. app-data lease·동일 lease 단일 쓰기, 비동기 inventory, 파일0600·한정 읽기·변조 검사. 만료 marker fsync 후 암호문만 제거하며 같은 saveId 재보관 금지. 키 유실·손상·부분 쓰기는 보존하고 원본/실행 fence를 삭제하지 않음. marker도 예산에 포함해 장기 포화 때 신규 admission 중단; 색인 기반 정리는 후속 |
| V2 호스트 파일 적용(자동 AI 경로 미연결) | host 제안의 document/state 새 내용256 KiB 이하; root당 미해결 plan1개, 영구 binding/receipt는 표시 이력과 별도 | exact saveId·attemptId·plan/root/before/after digest와 등록/lease를 재검증. 문서·journal·저장 기준 적용 후 receipt/outbox부터 확정하고 host plan 정리. host schema2로 구버전 복구 writer 차단. 기존 host payload 자체의20 MiB 상한과512 MiB admission 예산도 유지; 원본/미해결 plan은 축출하지 않음 |
| V2 비상 reserve 수명(설치 경로 미연결) | 32 MiB, 고정64 KiB buffer의 비동기 쓰기, receipt/pending 각각4096 bytes 이하 | 호스트 app-data directory lease와 동일 lease의 단일 mutation 슬롯 필요. preparing→ready, consumed 기록 fsync 후 소유 inode만 truncate. host 복구 확인 뒤 새 generation으로 rearm. pending은 정확한 parent hash/전이/소유 파일 검증 후에만 승격. unknown 파일·손상·죽은 manual lease는 자동 삭제/인수하지 않음 |
| V2 단일 snapshot adapter(진단용) | 한 snapshot 8 MiB 이하, JSONL record 4 MiB 이하, 64 KiB 비동기 읽기, 완료 metadata 최대128턴 | 정확한 byte range와 hash만 저장. 읽는 중 파일·등록 변경, partial EOF, 미완료 턴은 성공 coverage로 전진시키지 않음. 큰 이력에는 아래 증분 adapter를 사용 |
| V2 증분 관찰(설치 sidecar) | header·anchor를 포함한 한 slice 읽기8 MiB 이하, head256 KiB·anchor4 KiB, 완료128턴; 커서 DB cache256 KiB, 관찰은128행 이하 단일 transaction | 파일 신원·축소·header/anchor 변경 때 cursor를 재검증하고 기존 observation/fence는 보존. observation 이후 cursor CAS가 실패하면 멱등 재읽기. 한 턴 자체가 slice 예산을 넘으면 건너뛰지 않고 미해결로 둠 |
| V2 관찰 coordinator(설치 sidecar) | 기존15초 tick당 등록 target 하나·source slice 하나, hint64개·project 상태128개·source 상태256개 | 힌트와 일반 root 순환 교대, source도 순환. 변경 없는/미완료 source는60초, invalid/unavailable은5분 대기. size/mtime 변경은 source 대기를 해제. 동시 tick·종료 후 신규 관찰 차단 |
| V2 최근 source discovery | Codex 최근96개 후보·header 읽기 tick당2 MiB·분리 복사한 metadata cache128개/60초, Claude 현재·과거 slug별 최근16개 | 본문 캐시 없음. 최종 후보는 provider별16개. 기존 비동기 directory 순회의 비용은 O(전체 파일 수)이며 오래된 전체 이력 backfill을 보장하지 않음 |
| 워크룸 완료 대화 상태 | 기존 화면3초 조회에 선택 target 하나만 추가; read-only SQLite cache256 KiB·busy100ms, indexed pending 범위129행 이하 조회·128행 집계 | 새 DB·installation ID·AI 작업을 만들지 않음. 등록·canonical memory 소유권 재검증 후 건수와 제한 여부만 반환. fragment는 완료 대화로 세지 않으며 전체 이력·기존 저장 큐와의 통합 건수를 주장하지 않음. 숨김·unmount 때 조회 중지·늦은 응답 무시 |
| 자동 저장 실패 중복 방지 | 세션 ID별 SQLite 조회, 연결 cache 256 KiB·busy wait 100ms, 작업마다 연결 닫기 | 실패한 완료 턴의 fence는 개수 제한으로 삭제하지 않음. 기존 JSON 시도 기록을 이관하고 성공·새 턴·명시적 opt-in 변경 때 해당 정책에 따라 해제 |
| Codex 최근 세션 발견 | 비동기 디렉터리 순회, 최근 파일 96개·깊이 16·디렉터리 버퍼 32개 | 동시 스캔만 공유하고 완료 후 Promise 회수. 전체 파일 목록을 메모리에 만들지 않음. 파일 발견 비용은 여전히 O(파일 수) |
| 자동 세션 저장 프로젝트 조회 | tick당 최대 48개 관측, 등록 경로별 비동기 identity 조회 1회·동시 4개, 대상별 활동 검사 1회 | 캐시는 tick 종료 때 회수. 저장 lease 안에서는 등록·canonical root·memoryId를 새로 검증하며, 대기 중 opt-out은 해당 tick의 저장 권한을 취소 |
| 워크트리 포트 탐색 | 동시 요청은 진행 중 snapshot만 공유, lsof 최대 2회·명령당 2초(강제 정리 여유 250ms)·stdout/stderr 각각 1 MiB·PID 2,048개·포트 16,384개 | 조회 완료·실패 때 snapshot 회수. 경로 및 배정 포트 규칙은 요청별 검사. 예산 초과는 불완전 결과로 프로세스를 선택하지 않고 실패 처리 |
| LAN 원격 메시지 | 처리 프레임 16 KiB, Bun 수신 한도 32 KiB, 초당 10회, 대기 20개·256 KiB | 비동기 처리 대기열에 넣기 전에 검사. 초과 연결을 종료하고 입력 직전에도 연결 권한을 재확인 |

문자열 예산은 UTF-16과 객체 비용의 추정치다. V8/JSC·WebKit·Bun allocator의 실제 물리 메모리 한도와 같지 않다. 작업 이벤트 하나의 서버 JSON 한도는 64 KiB이고 화면당 이벤트는 500개이므로, 활성 작업 예외 역시 입력 계약의 상한을 가진다.

## 반복 검증

```sh
bun run test:resources
bun run verify
bun run test:smoke
node tests/frontend-observation-lifecycle.e2e.mjs
node tests/workroom-input-lifecycle.e2e.mjs
```

`test:resources`는 격리된 합성 데이터와 더미 PTY·연결을 사용한다. 전송 계약 회귀는 사설 IPv4가 있을 때 테스트 서버의 실제 WebSocket으로 실행하며 사용자의 설치 서버·컨트롤러와 연결하지 않는다. 해당 Bun 테스트는 `verify`의 전체 테스트에도 포함된다. 브라우저 회귀는 실제 React 컴포넌트를 mock API로 마운트하며 별도 실행한다. frontend 회귀는 자체 9123 Vite를 열고 닫으며, workroom 회귀는 실행 중인 9000 Vite가 필요하다. smoke는 테스트 전용 API·빈 앱 데이터를 사용하고 실제 단말의 설정·기억·세션에 쓰지 않는다.

검증할 경계:

- 로그 최초 응답 전에 닫기, 역순 응답, 반복 열기·닫기, 파일 rotation, 긴 한 줄과 많은 줄.
- 대화/작업/숨은 문서 전환 뒤 조회 중지와 재개, 초안 보존, 캐시 제거 후 재선택.
- 캐시 예산보다 큰 여러 프로젝트, 외부 journal 수정, 기존 항목 중복 append 방지와 원본 불변.
- 큰 transcript, UTF-8 chunk 경계, CRLF/EOF, 초과 레코드, 최신 본문의 순서와 저장완료 가드.
- 10,002개 transcript 분류, warm 재조회, 뒤늦은 append, byte cursor 재개와 프로젝트 소유권 재검증.
- 100,000개 터미널 요청 후 종료·자원 회수, 중복 입력 거절, 대기열 포화, 세션 저장 실패 보존.
- 느린 원격 인증 중 메시지 폭주, 크기·속도·대기 예산 초과와 다른 연결의 정상 처리.
- 저장 큐 타이머는 API 시작과 의존성 초기화 뒤에 등록한다. 실제 supervisor lock으로 3초 초기화를 지연해도 health와 첫 큐 tick이 동작하고, 종료 중에는 새 tick을 실행하지 않는다.
- V2 저장 기반 모듈의 20,000개 관측 구간 keyset 조회, 두 프로세스의 단일 시도 획득, SIGKILL 뒤 재실행 거부, 부분 구간 보존, receipt·백업 outbox transaction 실패 rollback. 이 검사는 전체 자동 저장 정책의 설치본 동작이나 수개월간의 무누수 증거가 아니다.
- 자동 저장의 132개 프로젝트·48개 관측에서 중복 identity/활동 검사 억제, 느린 Git 조회 중 health 응답, 다음 tick의 새 조회, 대기 중 등록·symlink·memoryId 변경 및 opt-out 차단.
- 여러 워크트리의 동시 포트 탐색, 느린 lsof 중 health 응답, 출력/PID/시간 예산 초과와 자식 종료, CWD의 조상 경로 거부, 한 PID의 복수 포트와 배정 규칙 일치.

## 설치본 측정

개발 Vite는 `**/release/**` 전체를 파일 감시에서 제외한다. 버전별
`release/v407/dmg-stage/Applications` 링크를 따라 설치된 앱 파일을 감시하면서
연속 reload와 JavaScript heap OOM이 발생했으므로, 공개 저장소 스냅샷 두 폴더만
제외하는 설정으로 돌아가지 않는다. 소스의 symlink 감시는 그대로 유지한다.
`vite-release-watch.test.ts`는 실제 Vite watcher에 작은 합성 앱 폴더 링크를 연결해
기존·새 릴리즈의 감시 항목과 변경 이벤트가 없고 일반 소스·소스 링크·`release-notes`
변경은 계속 감지되는지 확인한다. 실제 `/Applications`를 순회하거나 데이터 원본을 삭제하지 않는다.

의존성 사전 탐색은 파일 감시와 별개여서 `watch.ignored`를 적용하지 않는다.
빈 캐시의 기본 `**/*.html` 탐색이 DMG 링크를 따라 설치 앱의 HTML까지 읽고
의존성 해석 실패와 반복 reload를 일으킨 사례를 확인했다. 개발 설정의
`optimizeDeps.entries`는 실제 진입점 `index.html`, `portal.html`, `setup.html`,
`remote/index.html`, `guide.html`로 제한한다. `vite-dependency-scan.test.ts`는
빈 캐시와 합성 릴리즈 링크에서 실제 Vite scanner가 다섯 진입점과 소스 의존성을
처리하면서 릴리즈·외부 앱·보관용 문서는 읽지 않는지 검증한다.

배포마다 설치 plist 버전, 정확한 `/Applications/AgentsToZ_byCS.app` 프로세스와 그 sidecar, `/api/health`, 실제 설치 UI를 확인한다. macOS 기본 창 1000×1050과 저장된 125% 배율에서도 확인한다. Mac이 잠겨 있으면 설치 UI 확인을 완료한 것으로 보고하지 않는다.

프로세스 메모리는 `ps`의 RSS와 `footprint`의 physical footprint를 구분해 기록한다. 시작 직후와 같은 사용 시나리오 반복 후 수치를 비교하며, 유휴 상태에서 계속 증가하는지 본다. 앱 본체·sidecar만 측정한 값을 전체 앱 사용량이라고 부르지 않는다. WebKit과 CLI는 별도 프로세스이므로 소유 관계가 확인된 프로세스만 합산한다. 사후 GC로 수치가 줄었다는 이유만으로 누수가 없다고 결론 내리지 않는다.

## 확장 시 남은 경계

- Codex 파일 발견은 아직 전체 파일 경로·HMAC ID를 정렬하므로 파일 수에 비례한다. 분류 본문과 DB 쓰기는 배치로 제한했지만 디렉터리 발견까지 상수 메모리·시간인 것은 아니다. 수십만 파일은 영속 발견 인덱스와 증분 작업으로 옮기기 전 별도 실측한다.
- journal 최초 읽기와 전체 내보내기는 원본 크기에 비례한다. 캐시 예산은 보존량을 제한하며, 최초 파싱의 피크까지 제거하지 않는다. 대규모 화면 조회에는 기존 SQLite 검색·페이지 조회를 우선 사용한다.
- 원격 회귀는 지연과 폭주를 합성한 검증이다. 실제 여러 모바일 단말과 여러 호스트의 장기간 연결·OS 메모리 압박은 별도의 기기 실측이 필요하다.
- 새 기능의 장수 Map·배열·구독·타이머·Promise 대기열에는 생성 주체, 최대량, 종료 시점, 오류 후 회수, 영속 원본의 위치를 함께 정한다. 자동 세션 저장 같은 백그라운드 업무를 UI visibility에 묶어 중단시키지 않는다.

## 자동 저장 점검 (2026-09-07)

자동 체크포인트는 opt-in 이후 완료되는 턴에서 사용률 50·75·90%를 넘고 기억 변경이 있을 때 실행한다. 임계값 미만의 짧은 대화나 종료 증거가 없는 턴의 최종 저장을 보장하지 않는다. 자동 저장을 켰다는 사실과 실제 로컬 저장 성공은 다르며 상태 API의 saved/failed 및 backupWarning으로 구분한다.

한 tick의 checkpoint 호출 상한 1개는 유지하되 마지막 시도 다음 세션부터 순환한다. 잠긴 프로젝트 하나가 매 tick 첫 슬롯을 차지하거나 한 프로젝트의 기억 조회 오류가 나머지 세션 점검을 중단하지 않게 한다. 대기 순번과 실제 workspace busy 메시지도 구분한다.

manual 정책 잠금의 소유 프로세스가 종료된 경우는 단순 busy와 별도 `WORKSPACE_LEASE_RECOVERY_REQUIRED`로 보고한다. 원래 프로세스의 자식이 살아 있을 수 있으므로 자동 삭제하지 않는다. 종료 확인과 정확한 소유권 검증을 거친 복구가 필요하며, 이 상태를 자동 저장 성공으로 표시하거나 계속 30초 재시도하지 않는다.

회귀 검증은 300개 실패 세션의 재시작 후 중복 방지, 잠긴/읽기 실패 프로젝트와 정상 프로젝트의 동시 대기, 2,000개 파일 탐색 중 HTTP 응답 및 최신 96개 선택을 포함한다. 실제 수개월 실행·수십만 파일의 전체 지연/physical footprint는 별도 실측 영역이다. SQLite 실패 fence는 원본을 보존하므로 디스크 크기는 실패한 세션 수에 비례한다.

체크포인트 성공 기록도 같은 SQLite의 `receipts`로 이전한다. JSON의 최근 256개 제한은 더 이상 성공 여부의 정본이 아니며, 기록은 세션 ID로 조회해 전체 이력을 메모리에 올리지 않는다. v1 DB·JSON은 한 번만 이전하고 원본 JSON은 다음 설정 저장까지 보존한다. 명시적 재활성화에는 시각과 별개의 임의 정책 ID를 발급한다.

체크포인트 호출 전에 `intents`를 커밋하고, 성공 영수증 저장과 intent 제거를 한 SQLite 트랜잭션으로 처리한다. 호출 중 종료·응답 불명·로컬 저장 확인 실패·성공 영수증 쓰기 실패는 `recovery-required`로 남긴다. 설정을 껐다 켜도 이 기록은 삭제하지 않는다. 호스트가 기억 작업 시작 전 실패를 입증한 경우에만 기존 busy/다음 턴 재시도 정책을 적용한다. 이 보강은 자동 체크포인트에 적용되며, 수동·터미널 저장과의 통합 coverage 원장과 파일 commit manifest를 통한 복구 확인은 후속 구현이다. 자동 체크포인트 백업 대기열의 현재 범위는 아래 DB v3 항목을 따른다. 복구 UI가 준비되기 전에는 불명 상태의 자동 재실행을 허용하지 않는다.

후속 구현에서 DB v3의 `outcomes`와 `backups`를 추가했다. 자동 체크포인트는 호스트가 로컬 저장을 마친 뒤 완료 증거와 백업 대기 항목을 함께 커밋하고 네트워크 백업을 분리한다. 다음 tick은 최대 24개 완료 증거를 AI 없이 영수증으로 복구한다. 이전 버전의 intent만 남은 작업은 완료 증거가 없으므로 그대로 보류한다. 로컬 파일 적용 직후부터 outcome 커밋 전까지의 중단은 아직 이 방식으로 자동 복구할 수 없다.

백업은 기존 15초 tick에서 별도 단일 Promise로 실행하며 AI 저장 tick을 네트워크 대기로 막지 않는다. 한 번에 한 작업, 네트워크 요청 전체에 60초 AbortSignal, 60초부터 최대 1시간까지 지수 대기, 최대 8회 시도를 적용한다. workspace busy는 시도 횟수를 돌려주고 30초 뒤 다시 확인한다. 각 재시도 전에 프로젝트 등록·canonical 경로·memoryId·내용 해시·Supabase URL/기기 fingerprint·원격 부모를 검증한다. 내용·연결·계보 변경, 자동 백업 opt-out, 원격 충돌, 재시도 상한에서는 `blocked`로 보존한다. 자동 체크포인트를 꺼도 이미 요청한 백업은 프로젝트별 자동 백업 동의가 유지되는 동안 처리한다.

이 대기열은 저장 당시의 **검증 메타데이터**를 보존한다. 본문 불변 사본을 가진 완전한 revision outbox는 아니므로 이후 내용이 바뀐 과거 리비전을 자동 재전송하지 않는다. guarded Push는 AI·curated 기억 재작성·자동 계보 변경·원격 과거 리비전 삭제를 수행하지 않는다. 기존 journal/feedback 동기화와 동기화 config 갱신은 유지하며 모든 구성요소가 완료돼야 백업 완료다. 상세 로컬 경로·해시·credential은 상태 DTO에 포함하지 않고 최대 24개 이름·상태만 표시한다. metadata는 항목당 16 KiB 이하, 완료 대기열 이력은 최근 128개이며 미해결 항목은 삭제하지 않는다. 누적 미해결 항목의 디스크 상한·불변 본문 outbox·수동/터미널 통합 coverage와 파일 manifest 복구는 여전히 후속 범위다.

워크룸 종료 저장은 작업공간 사용 중 오류만 30초 후 재시도한다. 복구 필요와 일반 실패는 자동 재호출하지 않는다. 저장 도중 프로세스가 끝났거나 완료 영수증을 기록하지 못한 경우에는 실제 기억 갱신 여부가 불명확하므로 `recovery-required`로 보존한다. 아직 시작하지 않은 pending 작업은 재시작 후 계속한다. 새 전역 타이머는 추가하지 않고 기존 tick·화면 visibility 주기를 사용한다.

대기열의 미해결 작업·성공 ID fence는 디스크에서 증가할 수 있다. 한 번의 JSON 이전은 크기에 비례하는 일회성 메모리가 필요하며 8 MiB 상한을 둔다. 상태 목록은 페이지 단위이고 전체 건수 계산과 오래된 페이지 OFFSET 비용은 누적 행 수에 영향을 받으므로 수십만 건 규모에서는 추가 실측과 cursor 조회를 검토한다. 현재 회귀는 미해결 8,000건·기존 성공 1,000건, 이전 원본 보존, 중단 저장 비재실행, receipt 쓰기 실패, symlink/future-version 거부를 포함한다.


## 기억 문서 쓰기 중단 복구 (2026-09-07)

`writeMemoryDocument`는 변경할 notes·notes manifest·CORE 파일의 이전/다음 UTF-8 본문을 프로젝트 내부 `.agent-memory/backups/.pending-document-write.json`에 먼저 준비한다. 대상은 최대 128개 파일, 개별 본문 2 MiB, 직렬화한 복구 기록 16 MiB다. 크기·UTF-8·중복 경로·allowlist를 파일 변경 전에 검사한다. 변경 없는 파일은 쓰지 않아 활동 지문을 불필요하게 갱신하지 않는다. 원본 대화나 credential을 새로 수집하지 않으며 이 기록은 기존 Git 제외 backups 경계에 남는다.

준비 파일은 0600 임시 파일을 fsync한 뒤 배타적으로 게시하고, 각 문서 파일은 임시 파일 교체 방식으로 적용한다. POSIX에서는 디렉터리도 fsync한다. Windows에서는 디렉터리 fsync를 생략하므로 동일한 전원 손실 내구성을 주장하지 않으며 실제 Windows 검증은 별도다. 여러 파일이 동시에 바뀌는 파일시스템 트랜잭션은 아니다. 준비 기록이 남으면 호스트의 문서 읽기·쓰기·기억 완료 표시·백업을 막아 부분 문서를 정본으로 전파하지 않는다.

상태 조회는 기록이 없으면 파일 존재 확인으로 끝난다. 기록이 있으면 위 크기 한도 안에서 파일별 해시를 비교하며 새 타이머나 재시도 worker를 만들지 않는다. UI에서 사용자가 재개하면 등록 프로젝트·canonical root·memoryId·sourcePath·정확한 transaction ID를 검증하고 기존 workspace lease 안에서 복구한다. 전체 파일 사전 검사와 파일별 검사에서 현재 값이 이전/다음 값 중 하나와 일치해야 한다. 다른 수정, symlink, 손상 기록, 미래 버전은 자동 덮어쓰기 없이 보류한다. 완료 상태를 다시 확인한 뒤에만 준비 기록을 제거한다.

workspace lease를 따르는 호스트 쓰기 사이의 복구이며 외부 편집기를 강제 잠그지 않는다. 외부 도구는 중간 파일 상태를 볼 수 있고, 마지막 검사와 파일 교체 사이의 외부 동시 변경까지 원자적으로 비교·교체하는 것은 아니다. 기록이나 충돌을 강제로 지우는 UI는 제공하지 않는다.

문서 복구 결과는 `documentRecovered: true`, `sessionCompletionVerified: false`다. journal·config·호스트 outcome까지 하나의 원자적 저장으로 묶지 않으며 문서만 복구된 작업의 자동 체크포인트 intent를 성공으로 승격하지 않는다. 불변 본문 revision outbox, 미해결 자동 작업 전체의 사용자 복구, 수동/터미널 통합 coverage는 후속 범위다.

검증은 파일별 중단, 별도 프로세스 즉시 종료 후 복구, 외부 수정과 신원 변경, stale ID, 손상·미래 기록, 크기 한도, symlink, 변경 없는 문서의 수정 시각 보존을 포함한다. 실제 운영 API 3001과 데이터는 사용하지 않는다. UI는 실제 패널에 네트워크 fixture를 연결해 데스크톱 1000×900·모바일 390×844에서 확인하며, 이 결과를 실제 설치본·운영 DB 복구의 증거로 취급하지 않는다.


## 세션 적용 계획과 워크룸 회복 (2026-09-07)

호스트 `memory-session-recovery.sqlite` v1은 canonical root당 미완료 계획 하나를 보존한다. 검증된 문서의 파일별 이전/다음 값, 고정 일지 항목, 공유 config와 기기 state의 이전/다음 값, 백업 대상 guard, 원래 자동 저장/워크룸 작업 신원을 준비한 뒤 문서 쓰기를 시작한다. 계획 하나는 최대 20 MiB이고 문서 manifest의 128파일·개별 2 MiB·합계 16 MiB 제한을 함께 적용한다. 프롬프트·원본 대화·credential은 추가 수집하지 않는다. 완료 계획 본문은 제거하고 최근 128개 ID/root/memoryId/hash 완료 기록만 유지한다. 미완료 계획은 삭제하지 않으므로 미해결 프로젝트 수에 비례하는 디스크 비용은 남는다.

단계는 document → journal → state → outcome이다. SQLite FULL 동기화와 기존 fsync 파일 적용을 사용한다. 재개 시 state 대상도 먼저 비교하므로 설정 충돌을 발견한 상태에서 문서를 먼저 바꾸지 않는다. 일지는 준비 당시 hash/시각으로 멱등 append하고 state는 준비 당시 기준만 복원하여 복구 시각 사이의 새 활동을 저장 완료로 덮지 않는다. 문서·신원·설정이 달라지면 보존 후 중단한다. SQL 상태 조회는 root 인덱스로 ID/단계만 가져오며 계획 본문은 준비·재개 때만 읽는다. 새 백그라운드 타이머나 자동 AI 재실행은 없다.

자동 저장 DB v4의 completion_contexts는 실행 전에 원래 intent/epoch/root/memoryId와 영수증 초안을 결속한다. 이 호스트 근거가 있는 계획의 로컬 적용을 확인한 뒤에만 기존 outcome/백업 큐를 만들 수 있다. 완료 context는 본문 초안을 비우고 작은 신원 fence로 남아, 최신 세션 영수증이 다른 저장으로 갱신돼도 오래된 계획 정리가 이를 되돌리지 않는다. fence의 디스크 비용은 완료 저장 수에 비례하며 메모리 전체 로딩이나 전수 검색은 하지 않는다. 이전 버전의 bare intent는 복구 근거로 승격하지 않는다.

워크룸 종료 저장도 준비 계획에 원래 sessionId/targetId/cwd/agent를 결속한다. 로컬 저장 확인 직후 해당 큐 행에 saved 또는 backup-pending을 기록하고, 이후 네트워크 백업 결과를 분리한다. 원래 작업 신원이 다르면 복구 결과를 적용하지 않는다. 저장 완료와 큐 결과 기록 사이의 중단은 호스트 계획으로 재개하며, 직접 CLI가 파일을 편집하는 기존 mark-remembered 경로의 통합 coverage까지 완료한 것은 아니다.

백업 전체를 파일 시스템 트랜잭션에 넣지 않는다. 자동 저장은 기존 네트워크 예산을 갖는 queue를 사용한다. 수동/워크룸 복구는 로컬 완료를 먼저 확정하고 저장 당시 guard로 한 번 Push한다. 백업 실패가 로컬 완료를 취소하지 않으며, 수동 백업의 불변 본문 outbox는 후속 범위다. 제안을 준비하기 전의 provider 중단, 프로젝트 파일을 직접 읽는 외부 도구와의 강제 동시 쓰기, 시스템 전원 손실 전체, Windows 설치본은 이 검증만으로 보장하지 않는다.

워크룸의 목록·원격 권한 조회는 각 읽기 자원에 하나의 진행 Promise만 유지한다. 느린 응답 동안 2초/5초 타이머나 수동 새로고침이 추가 네트워크 요청을 쌓지 않는다. 프로젝트 목록은 실패가 끝난 뒤 5초부터 최대 30초까지 대기하여 재조회하고 화면 종료 시 다음 타이머를 취소한다. 연결 오류와 사용자 실행 오류를 분리하여 정상 목록 응답은 연결 오류만 지운다. 500개 동시 읽기의 병합·실패 뒤 슬롯 회수·다른 읽기 자원의 독립성을 검사한다. 실제 패널 fixture에서 자동 재연결 후 시작·출력·입력·종료를 확인했지만 설치 앱의 실제 CLI/네트워크 장애 해결 증거와 구분한다.

출력 조회는 새 출력이 있을 때 로컬 120ms·원격 700ms 간격을 사용하고, 남은 출력이 있으면 즉시 이어 읽는다. 출력 없는 조회가 반복되면 로컬 최대 2초·원격 최대 5초로 늘린다. 실패는 500ms부터 지수 대기하여 로컬 최대 5초·원격 최대 8초로 제한한다. 입력 전송 성공은 다음 조회를 즉시 깨우고, 이미 진행 중인 조회가 있으면 완료 직후 한 번만 깨운다. 입력 자체를 재전송하지 않는다. 출력 오류는 정상 출력 응답이나 세션 변경으로만 해제하고 사용자 동작 오류와 분리한다. 화면 종료·전환 시 기존 generation과 타이머 정리 계약을 유지한다.


## V2 선택·동의·유지보수 연결 (2026-09-08)

- 워크룸 시작·입력·종료는 등록 root와 AI 종류만 관찰 대기열에 알린다. 최대 64개인 hint 대기열의
  차례에는 해당 AI의 가장 최근에 변경된 세션을 먼저 관찰한다. 다른 AI의 진행 중 세션이나 과거
  세션 해시 순서 때문에 방금 끝난 대화가 밀리지 않도록 한다. 일반 순환과 hint는 번갈아 처리하며,
  과거 기록·부분 읽기에는 기존 cursor 순환을 유지한다. tick당 한 source slice와 기존 읽기 예산은
  늘리지 않으며, hint 자체는 저장·모델 호출·완료 판정 권한이 아니다.
- 설치 Mac의 기존 15초 tick에서 target 하나를 순환한다. pending metadata는 128행+다음 페이지 1행,
  후보는 최근 32개 이하, 선택은 8턴·원문 20,000 bytes다. 전체 대화나 전체 원장을 RAM에 적재하지 않는다.
  target scan/result cache는 각각 128개다. 완료·동의 시점·등록 소유권·정확한 byte/hash를 재검증하며,
  파일 변경이 없어도 완료 대화는 처리한다. 자동 정리는 120초 idle을 기다리고 수동 V2는 idle 대기를
  생략한다. 기존 8회/24시간·30분 quota는 수동 V2에도 적용한다.
- provider 검사에는 빈 프로젝트 설정·도구/MCP off·별도 0700 cwd·환경 allowlist를 사용한다.
  인증 조회·연결 검사·기억 정리 자식 프로세스에는 `DISABLE_AUTOUPDATER=1`을 고정해 실행 중 자체
  CLI 갱신을 막는다. 사용자 전역 설정은 바꾸지 않으며 다른 프로세스의 갱신 가능성 때문에
  실행 전후 binary/account 일치 검사도 유지한다. CLI의 이 설정은
  [공식 환경 변수 문서](https://code.claude.com/docs/en/env-vars)를 따른다.
  계정 상태 stdout 8 KiB/10초, canary 64 KiB·제안 300 KiB/300초 상한이다. 계정은 salted hash로만
  보관하고 raw key/계정/실행 경로는 UI에 반환하지 않는다. CLI fingerprint는 파일 metadata이며
  암호학적 바이너리 attestation이나 sandbox proof가 아니다. 실제 계정 canary는 이 구현 검증에서 실행하지 않았다.
- 설정 조회는 화면 표시 동안 15초·single-flight이며 숨기면 종료한다. 서버 저장·만료·백업은 화면과
  무관하다. status는 Keychain을 부르지 않는다. prepare-provider 1회와 별도 동의/CAS/configurationId가
  모두 맞아야 활성화된다. 모델 입력이 바뀌면 동의가 해제되고 이전 모델 결속으로 켤 수 없다.
- schema 6 입력 결속은 본문 없는 immutable metadata다. 60초 유지보수는 만료 기한에 도달한 행을
  (expired,createdAt,sequence) 색인으로 바로 찾아 최대 9행 조회·8행 처리한다. 최근 입력을 먼저
  훑지 않으며 (createdAt,sequence) advisory cursor로 실패행 이후도 처리하고 다음 순환에서 재검사한다.
  같은 시각의 행은 sequence 범위로 먼저 찾고 다음 시각의 행을 이어 조회한다. SQLite의 tuple 범위가
  같은 시각의 앞선 행을 반복 훑는 것을 피하며 두 조회의 결과 합계는9행 이하를 유지한다.
  실제 삭제 기한은 암호화 파일의 인증된 header로 다시 확인한다. 만료 marker 인증/fsync 후 암호문
  제거가 성공한 행만 expired로 기록한다. 키/파일 문제가 있으면 원본을 보존하며, 뒤쪽 묶음만 성공했다고
  폐기 경고를 해제하지 않는다. 전체 순환이 성공해야 경고를 해제한다. V2를 꺼도 유지보수는 계속된다.
- v5→v6은 입력·작업·백업 본문과 중복 실행 방지 기록을 보존하고 두 색인만 트랜잭션으로 교체한다.
  최초 업그레이드의 색인 생성 비용은 누적 행 수에 비례한다. 이후 만료/백업 조회는 별도 전체 정렬 없이
  제한된 결과를 반환한다. 상태 읽기 전용 조회는 v5/v6을 모두 읽으며 DB를 업그레이드하지 않는다.
- backup outbox는 동시에 1건, 시도/다음 시각을 전송 전에 durable 예약하고 30초부터 최대 1시간·20회 상한이다.
  (state,retryAt,saveId) 색인은 재시도 시각이 같은 행이 많아도 별도 정렬을 피한다. 고정 내용 해시/목적지/부모
  guard가 바뀌면 blocked, 일시 전송 실패는 같은 guard만 retry하며 AI는 호출하지 않는다.
  상태는 pending/blocked 128건+hasMore이고 완료행은 집계 조회에서 제외한다. 최신 job 조회는 memoryId/sequence
  색인 1행이며 재시작 후 saved/recovery 상태를 복원한다. 이는 역사적 receipt이며 현재 파일 무결성 증명을 대신하지 않는다.

장기 실행의 남은 경계: source/receipt/fence/만료 marker는 중복 방지 증거라 자동 삭제하지 않는다.
입력 폴더 4096 entries/64 MiB와 DB 1 GiB admission에 도달하면 새 AI를 보류한다. 만료 marker도 entries에
포함되므로 현재 7일 암호문 폐기만으로 무기한 운영을 보장하지 않는다. 색인 기반 보관/압축과 실제 7일/수개월
footprint 실측은 후속이다. 긴 완료 턴/최근 발견 범위 밖의 과거 source도 자동으로 잘라 저장하지 않는다.
새 암호문을 만들 때는 생성할 파일 자체까지 4096 entries 예산에 포함한다. 4096개가 이미 존재하면
기존 파일을 제거하지 않고 신규 staging을 보류하며, 동일 파일의 검증된 재조회는 허용한다.

### 프로젝트 한정 V2 시험

정책 schema 7은 단일 `scopeMemoryId`와 등록 대상 힌트 하나만 저장한다. 대상 힌트로
등록 inventory의 같은 프로젝트·worktree만 순회하므로 다른 100여 개 프로젝트의
차례를 기다리지 않는다. 힌트는 실행 권한이 아니며 매 실행에서 기억 ID와 등록을
검증한다. 범위 밖 프로젝트는 dispatcher·workspace lease·대화 탐색 전에 제외한다.
새 타이머나 무제한 캐시는 추가하지 않으며 기존 호출·디스크·재시도 상한을 유지한다.
프로젝트 한정 실행 중에도 전역 미확정 시도와 quota는 유지하고, 제외나 재활성화로
완료 구간·복구 fence를 지우지 않는다.

### 워크룸 저장 연결 보정 (2026-09-09)

- 테스트 러너에도 `bunfig.toml`의 `test.root = "./tests"`를 적용한다. 필터형 명령이 릴리즈 DMG의 `Applications` 링크를 따라 설치 앱 전체를 탐색하던 사례를 재현했고, 합성 외부 앱 링크 fixture로 루트·`--cwd tests` 실행의 탐색 격리를 검증한다. 이 설정은 [Bun의 공식 test root](https://bun.sh/docs/test/configuration)를 사용하며 테스트 자체를 제외하거나 약화하지 않는다.

- `revalidate-provider`는 켜진 정책의 정확한 revision/configurationId로 같은 계정·설치·모델·추론 수준의 연결만 AI 1회로 재확인한다. workspace → app-data lease와 dispatcher 아래에서 검사하며 미완료·복구 대기 저장이 있으면 거부한다. 새 CLI 결속과 정책 revision만 원자적으로 갱신하고 동의 시각·관찰 sequence 경계·범위·제외·호출 이력·저장 영수증을 보존한다. 끄기/켜기로 미저장 대화를 건너뛰지 않는다. 상태 조회나 백그라운드 tick은 연결 검사를 자동 실행하지 않는다.
- 모델 연결 검사 전체는 60초로 제한한다. 정확한 준비·재확인 요청만 네이티브 응답 75초·웹 80초 예산을 사용하고 일반 요청 20초·15초 및 기존 건강 확인은 유지한다. 대기열·연결 장애로 결과가 불확실하면 상태 재확인을 안내하며 검사 실패를 동의 초기화나 즉시 재실행으로 해결하지 않는다. 실제 장기기억 제안 호출의 기존 300초 상한은 별개다.
- 자동 저장 입력은 `conversation-v1`로 표현한다. 원본 완료 구간의 전체 byte range·해시·소유권을 검증한 뒤 사용자와 AI의 대화 텍스트를 순서대로 보존한다. 형식이 알려진 도구·추론·CLI 메타데이터는 종류별 제외 수를 명시하며 대화 텍스트를 잘라내지 않는다. 알 수 없는 메시지 형식·이미지 등 미지원 콘텐츠는 원본을 저장 완료로 처리하지 않는다. 원본 coverage digest와 실제 AI 입력 digest는 별개로 유지한다.
- 선택 단계의 사전 검증과 실행 직전 재검증은 각각 최대 4 MiB, 합계 최대 8 MiB 읽기로 제한한다. 실패한 후보도 읽기 예산에 포함한다. 최대 8턴·대화 입력 JSON 20,000 bytes·최종 프롬프트 48,000 bytes 상한을 유지한다. 단일 발화가 실제 한도를 넘으면 보류하고 같은 페이지의 다른 작은 완료 대화는 계속 검토한다. 원본 삭제나 크기 제한의 무조건 확대는 하지 않는다.
- ‘내가 한 말’ 수집 힌트는 실제 worktree cwd를 tick당 최대 1개만 현재 등록 대상·Git 경로·canonical memoryId로 재검증해 연결한다. 키 입력마다 Git 탐색을 추가하지 않으며 기존 64개 힌트 상한과 15초 tick, 일반 순환과 우선 수집의 교대를 유지한다. 화면의 라이브러리 재조회는 화면 진입 또는 명시적 새로고침이며 실시간 push가 아니다.


### Native iOS LAN client

`mobile/ios/AgentsToZCore` holds one ephemeral URLSession/WebSocket and one in-flight request. Inbound and outbound messages are capped at 16 KiB; each exchange has a 15-second deadline and task cancellation closes the socket. A generation check prevents a prior connection's reply from replacing the current session. The UI holds at most 500 project cards, uses bounded increasing pages, shows the last observation time, and refreshes only on user request or after an action. There is no background polling or automatic action replay.

QR and session token are memory-only and are cleared on disconnect; the scene's background transition cancels the connection. Native Foundation errors and QR/token values are not printed. `bun run test:ios` verifies real native-to-Bun pairing, listing, exactly one fixture action, one-use QR rejection, redirect refusal, unanswered-request cancellation and host session cleanup. iOS background/camera/network-permission behavior still needs physical-device testing with Xcode.


### 자주 쓰는 프롬프트 가이드

- 상단 가이드는 최초 한 번 저장 목록을 읽고, 이후 명시적인 다시 읽기·저장·추천 요청만 수행한다. 숨은 주기 조회나 외부 AI 호출을 만들지 않는다. 저장본은 기기별 최대 100개, 제목 120자, 본문 16,384자/64 KiB, 전체 평문 JSON 1 MiB 이하다. 편집 초안도 최대 100개이며 종료하지 않은 초안은 오류·대화상자 닫기 뒤 유지한다.
- 추천은 기존 What I Said 보호 경로에서 `human`으로 분류된 입력 기록을 적재순으로 최대 100개씩 5페이지 읽는다. 이는 물리적인 키 입력 증명이 아니라 기존 출처 분류다. 동기화 원본과 로컬 대체 조회를 구분하고 원본 조회의 미완료 상태·표본 밖 기록·제외 이유를 표시한다. AI 전송 동의를 켜거나 원본 기록을 변경하지 않는다.
- 각 페이지를 즉시 분석해 최대 500개/기록당 2 KiB/누적 128 KiB 범위를 지킨다. 현재 수신 페이지 JSON은 별도이며 기존 100×64 KiB 상한에서 약 6.25 MiB일 수 있다. 5페이지 전체 원문을 누적 보유하지 않는다. 최근 입력은 같은 개인정보·원문 제한을 통과한 표본에서 입력 시각순으로 최대 10개/8 KiB를 보관한다. 같은 본문은 최신 1개만 표시한다. 추천 최대 20개와 최근 입력을 합한 표시 텍스트는 16 KiB 이하이며, 대화상자를 닫으면 비우고 진행 중 다음 페이지 조회를 취소한다. 시스템 작업 알림은 두 결과에서 제외하며 짧은 지시 포함은 명시적 옵션이다. 적재순 표본을 전체 입력의 최신순이나 의미 기반 AI 추천으로 설명하지 않는다. 취소할 수 없는 네이티브 invoke는 실제 완료 전 새 원본 조회를 막는다.
- 저장한 제목·본문·고정 상태는 별도 AES-256-GCM 파일에 기록하며 macOS Keychain 또는 Windows CurrentUser DPAPI로 보관한 전용 키를 쓴다. 파일이 없을 때 단순 조회로 키를 만들지 않는다. revision CAS, 검증된 이전 암호문 1개 백업, 파일 fsync/원자적 rename 및 POSIX 디렉터리 fsync를 사용한다. 최종 rename 뒤 durability 실패는 저장 결과 불확실로 표시하며 재조회 전 추가 저장을 보류한다. Windows 디렉터리 fsync와 실제 Windows UI는 macOS 검증에 포함되지 않는다.
- 신규 가이드 잠금은 소유 PID의 종료와 관련 파일의 안전성을 확인한 경우만 복구한다. 살아 있는 PID와 기존 수동 복구 잠금은 건드리지 않으며, 키 유실·손상·지원하지 않는 버전은 원본을 보존하고 오류로 표시한다. 장기기억·세션 자동 저장·공유 DB 테이블과 별개의 로컬 저장소다.
- 복사는 실제 클립보드 쓰기 완료로 성공 여부를 판단한다. 앱이 만든 프롬프트의 출처 등록은 최대 64 KiB, 진행 1개+최신 대기 1개로 제한하고 웹 요청은 5초에 취소한다. 취소를 무시하는 요청이나 네이티브 invoke는 실제 완료까지 슬롯을 유지한다. 중간 등록 생략·장애에서는 출처 확인이 누락될 수 있으며 복사 원문을 로그에 남기지 않는다.

### VOC 작업·실패 진단의 수명

- AI 작업의 실행 요청은 UTF-8 24,000바이트/NUL 금지 계약을 공유한다. 편집 초안은 1 MiB까지 유지해 초과 내용을 직접 줄일 수 있다. 지연된 이전 실행은 새 초안을 지우거나 다른 탭으로 이동시키지 않는다. 이전 결과 안내는 최대 1개이며 실제 세션 목록은 호스트가 보관한다.
- LAN 모바일 터미널은 세션에 고정한 입력 묶음 하나를 최대 32 KiB 보관하며 요청 대기열은 128건이다. 세션 전환·종료·연결 종료 때 아직 보내지 않은 입력은 취소한다. 종료 요청은 느린 출력 조회의 응답을 기다리지 않고 기존 180ms 전송 간격 아래 전송된다. 시작 응답을 확인하지 못해도 자동 재전송하지 않는다.
- 세션 저장 schema 8은 기존 작업·coverage·정책·쿼터와 별도로 saveId당 최초 실패 진단 1개(512자 이하)를 둔다. 허용된 단계·코드·시각·AI 호출 가능성만 저장하며 원문·모델 응답·경로·error.message/stack은 저장하지 않는다. 기존 미확정이나 catch 없이 종료된 실행의 원인은 unknown으로 남기고 자동 재실행하지 않는다. 진단 쓰기 실패도 기존 작업과 실제 완료 영수증을 변경하지 않는다.


### 미확정 저장의 명시적 후속 시도

설치 Mac의 복구 검토는 원래 완료 대화 최대 8개·동일 byte/hash 전체를 읽으며, 검토와 실행 각각의 원본 읽기 예산은4 MiB다. 검토 원문을 React·SQLite·상태 캐시에 남기지 않는다. parent당 미소비 승인 한 행(최대4 KiB), 5분 유효기간을 사용하고 재검토는 그 행을 교체한다. 소비한 승인·후속 결정과 원래 시도는 감사 기록으로 보존한다.

별도 동의 후 successor 하나만 허용한다. 기존8회/24시간·기억별30분 예산에 이전 시도와 새 시도를 모두 계산하고 실패를 환불하지 않는다. 새 시도도 미확정이면 재귀적으로 successor를 생성하지 않는다. 원격 검토는 GET만 사용하며 원본이 바뀌는 Pull이나 스키마 복구는 하지 않는다. 기존 provider 결속이 바뀌면 아래 전용 연결 전환 증거 없이 정리하지 않는다.

schema10의 복구용 CLI 연결 검사는 별도 명시적 동의와 rolling24시간8회 상한을 적용한다. 60초 canary 한 번의 claim/결과를 불변 원장에 남기며 실패·프로세스 유실도 환불하지 않는다. parent당 검토 한 행(5분 TTL), 각 payload8 KiB, parent/time 인덱스의 최신 결과1행·quota최대8행, 독립 clock high-water를 사용한다. 성공 proof는 매 사용 시 현재 binary/account/설치/정확한 모델·effort 및 원래 정책/등록을 확인하여 불필요한 재검사 AI를 피한다. 같은 token 재전송은 AI를 재호출하지 않는다. 새 검토+별도 동의로 추가 검사할 때도 이전 미확정 호출의 비용 가능성을 표시하고 기록은 보존한다. 상태조회는 기존15초 주기를 사용하고 새 타이머/원문 캐시를 추가하지 않는다. 모델 전환은 실제 successor admission과 같은 트랜잭션에서만 반영하며 동의 시점·원본대화·기존 정리 quota를 초기화하지 않는다.

상세 계약과 crash·중복 승인 검증은 `docs/design/memory-save-ambiguous-recovery.md`, `tests/memory-save-recovery-successor.test.ts`, `tests/memory-save-recovery-executor.test.ts`를 참고한다.

## CS 대직 검색 자료 (2026-09-10)

- 자료 목록/본문 조회는 서비스당 1개, 색인 생성은 1개만 실행한다. 대기 요청은 쌓지 않고 재시도를 안내한다.
  작업 상태는 최대 64개 프로젝트에 한정한다. 생성은 60초, 탐색은 30초·폴더 500개·엔트리 10,000개 상한이다.
- 문서 후보 최대 200개·깊이 3, 기억 목록 최대 1,000항목, 최종 선택 최대 200개·항목당 200KB·본문 합계 20MiB다.
  선택 집합 밖의 원문은 색인에 넣지 않는다. 미승인 후보는 하나만 유지하고 업데이트 때 변경 없는 구간은 재사용한다.
- 보관된 본문 예산은 호스트 전체 100MiB, SQLite 파일은 최대 512MiB(4KiB page 기준), 자료 버전당 최대 20,000구간이다.
  자료 생성은 작은 묶음마다 event loop에 제어를 돌려주고, 예산 초과 시 기존 승인판을 보존한 채 실패한다.
  worker 프로세스를 추가하지 않았으며 대용량 생성 중 health·취소 회귀로 응답성을 검사한다.
- 승인판과 미승인 후보를 구분한다. 창 닫기는 생성 취소가 아니고 명시적 취소·앱 종료는 작업을 중단한다.
  재시작은 미승인 후보만 정리한다. 공유 철회는 해당 사본·색인을 제거하지만 프로젝트 원본을 삭제하지 않는다.
- 매 5초 상태 조회는 DB의 작은 metadata만 읽으며 원본을 열거나 색인을 만들지 않는다. 질문은 최대 6구간·16KiB를
  조회한다. 출처 확인용 원본 읽기는 사용자가 목록·업데이트를 요청하거나 ON 전 변경을 확인할 때만 수행한다.

- PDF 추출은 macOS PDFKit을 고정 JXA 프로그램으로 실행한다. 검증된 파일 바이트만 stdin으로 보내며 파일 경로나 문서 내용을 명령으로 평가하지 않는다.
  PDF 입력 50MiB·300쪽, 추출 본문 200KB, subprocess 15초·출력 512KiB 상한이다. 자료 탐색의 30초 signal과 생성 취소를 함께 적용한다.
  문서 목록에 있는 PDF를 순차 추출하며 별도 상주 프로세스나 OCR·외부 서비스를 추가하지 않는다. 원본 질문 처리에는 PDF를 재추출하지 않는다.
- 카카오톡 감시는 프로젝트마다 같은 방을 중복 읽지 않고 방 단위로 5초 tick을 순회한다. 방당 최대 8개 연결·호스트 전체 최대 8개 ON과 기존 50개 메시지 읽기 상한을 유지한다.
  각 프로젝트의 ON 기준점과 24시간 예산을 보존하고, AI 없는 선택 안내도 기존 100회 시도 예산 안에서 처리한다. 대화형 선택 대기나 별도 사용자별 캐시는 만들지 않는다.

- CS duty N:N connections keep the existing 64 saved / 8 active / 8 per room limits and add 8 rooms per project. Additional connection IDs only map to a registered project; source grants, budgets and baselines remain independent. The app-private Swift KakaoTalk transport is a bounded subprocess with the existing time/output limits, not another daemon. Original global kmsg installation is unchanged.

### 시작 도우미의 GitHub 준비 실행

`onboardingGithubHost.ts`는 단말당 한 실행만 유지하고 SQLite revision/소유 프로세스로
중복 설치를 막는다. 고정 arm64 recipe의 ZIP은 14,212,224 bytes, binary는 40,024,608 bytes다.
다운로드 120초, 정확한 ZIP 항목 추출 15초와 출력 상한, 일반 CLI 조회 3초를 적용한다.
압축 항목의 경로를 파일시스템으로 직접 풀지 않는다. 이 recipe의 private cache 두 파일과
설치본 한 개만 사용하며 손상 캐시 복구가 기존 설치본 삭제로 이어지지 않는다.

로그인 guard는 최대 10분, 원문 수신 총 64 KiB와 파싱 창 2 KiB로 제한한다. 원문은 전달하거나
디스크에 저장하지 않고 코드 한 개만 활성 작업의 메모리에 둔다. 부모 파이프/250ms 부모 감시로
부모 종료를 감지하면 소유 group을 정리한다. UI 상태 조회는 활성 단계에서만 2초 간격이며
화면이 숨겨지면 요청을 멈추고 component 해제 시 타이머를 제거한다. UI 해제는 실제 작업을
재시작하거나 취소하지 않는다. 상세 검증 경계는
[GitHub 대표 경로](plans/beginner-onboarding-2026-09-11/GITHUB-EXECUTION.md)를 따른다.

### 시작 도우미의 Codex 설치 실행

`onboardingCodexInstallHost.ts`는 recipe별 SQLite 영수증/소유 PID와 한 개의 실행을 유지한다.
상태 조회는 영수증만 읽고 CLI·다운로드를 시작하지 않는다. 활성 화면만 2초 간격으로 조회하고,
숨김/해제 때 조회 타이머를 정리한다. 실제 설치는 화면 수명과 독립이며 명시 취소/앱 종료 signal을 따른다.

0.154.0 arm64 패키지는 112,327,068 bytes이며 고정 5개 파일 합계는 290,226,216 bytes다.
다운로드 180초, 각 고정 tar entry 추출 30초, CLI 검사 3초와 64KiB 출력 상한을 적용한다.
다운로드/추출/해시는 스트리밍하며 해당 파일의 정확한 크기를 넘는 입력을 거부한다.
압축 경로는 직접 추출하지 않고 고정 entry의 바이트만 exclusive 임시 파일에 기록한다.
검증 패키지와 archive를 유지하고 각 파일당 고정 `.part` 하나만 사용한다. 재시도는 소유권과
상한을 확인한 중단 임시 파일만 정리하며 사용자 설치/인증/설정/기억은 삭제하지 않는다.
새 recipe의 이전 설치/캐시 정리는 별도 업그레이드 정책이 필요하다.
전체 출하 경계는 [Codex 설치 실행 기록](plans/beginner-onboarding-2026-09-11/CODEX-INSTALL-EXECUTION.md)을 따른다.

### 시작 도우미의 Codex 로그인 실행

별도 SQLite 영수증 한 개(최대 4KiB), 호스트 실행 한 개와 private URL 한 개만 유지한다.
로그인 guard는 최대 10분, 원문 총 64KiB/파싱 창 8KiB, 호스트 pipe 8KiB로 제한한다.
CLI 조회는 3초/64KiB이며 고정 codex-login.log를 private `/dev/null` 링크로 버린다.
250ms 부모 감시·파이프 EOF·취소·provider exit에서 소유 process group을 정리한다.
UI는 활성·보이는 화면에서만 2초 조회하고 해제 시 타이머를 없앤다. 새로고침은 실행을 재시도하지 않는다.
[로그인 실행 기록](plans/beginner-onboarding-2026-09-11/CODEX-LOGIN-EXECUTION.md)의 신규 계정 검증 경계를 따른다.
