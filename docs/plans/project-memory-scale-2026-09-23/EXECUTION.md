# 누적 규모 개선 실행 기록

2026-09-23. 계획 전체의 완료 보고가 아니라 첫 구현 묶음과 남은 출하 조건을 구분한다.

## 적용한 변경

- C의 호환 reader: `projectMemoryJournalStream.ts`는 64KiB 청크로 v2를 읽는다. v1 marker-first/heading-first와 혼합 파일은 기존 v2 우선순위를 유지한다. UTF-8 경계, 잘못된 프레임, 미완료 tail을 시험했다. 한 줄 또는 v1 블록 2MiB 초과는 원본을 남기고 명시적으로 중단한다. 읽는 도중 inode/크기/mtime/ctime이 달라져도 완료로 반환하지 않는다.
- 기존 배열 reader도 이 reader를 사용한다. 순서 정렬·중복 제거·전체 배열 반환의 O(N) 비용은 남아 있다. 스트리밍 reader만으로 영속 색인·백그라운드 worker가 완성된 것은 아니다.
- G: transaction 후보 검사는 4,096파일·합산 before+after 64MiB, 실제 변경은 기존 128파일·복구 manifest 16MiB·파일당 2MiB 제한을 유지한다. 변경 없는 파일은 쓰기 예산에 포함하지 않는다. 기존 제목별 파일명을 유지하므로 앞쪽 주제 삽입으로 나머지 노트를 전부 다시 쓰지 않는다. 같은 제목은 기존 등장 순서로 연결한다. 주제 rename의 영구 ID나 노트별 CAS로 변경한 것은 아니다.
- F 일부: 실제 sync 호출은 1,000행 페이지의 원본 append/fsync 뒤 SQLite ACK와 cursor를 확정한다. 다음 네트워크 요청 전에 checkpoint가 존재하며, 이미 확정된 ACK를 응답 배열에 계속 누적하지 않는다. 1회 최대20페이지·페이지 경계에서30초, 수신 페이지16MiB를 적용한다. 상한 도달은 `ledgerHasMore`와 기존 오류 경로로 미완료를 알리며 다음 호출에서 재개한다. 네트워크 수신 전 byte cap·서버 snapshot upper sequence는 아직 없다. 원본 비교·Push의 전체 배열 비용도 남는다.
- A: fixture 생성과 stream/read/recall 측정을 별도 프로세스로 분리했다. 생성기는 제한된 배치로 최대100만 건·본문64~8192bytes를 생성한다. 앱 초기화가 만든 별도 일지는 합성 fixture에서 제거해 실제 건수를 대조한다. 원본/정제된 문서/최종 행 hash를 확인하며 임시 자료를 정리한다.

## 측정 방법과 결과

Apple M5, macOS arm64, Bun1.3.14. 합성 일지 한 달 파일, 기록별 본문1,024bytes, 요약·JSON/base64 프레임 포함 기록당1,979bytes. 각 규모/작업1회이며 p95나 디스크 cold-cache 시험이 아니다. fixture 생성 과정의 RSS는 제외했다. 측정 worker 시작 후 module import 시간은 포함한다.

Bun1.3.14 macOS의 `process.resourceUsage().maxRSS` 단위는 bytes임을 별도128MiB allocation과 `/usr/bin/time -l`로 확인했다. Node의 KiB 단위와 혼동하지 않는다. 다른 runtime/platform은 별도 보정한다.

| 작업 | 건수 | 파일 bytes | 시간 | worker 최대 RSS |
|---|---:|---:|---:|---:|
| 스트리밍 읽기 | 10,000 | 19,790,000 | 59ms | 86.5MB |
| 스트리밍 읽기 | 100,000 | 197,900,000 | 590ms | 89.2MB |
| 스트리밍 읽기 | 1,000,000 | 1,979,000,000 | 5,353ms | 94.9MB |
| 기존 전체 배열 반환 | 100,000 | 197,900,000 | 620ms | 799.5MB |
| 전체 recall 경로 | 100,000 | 197,900,000 | 최초6,445ms / 반복731ms | 1,641.3MB |

100만 건 시험은 스트리밍 reader의 메모리 개선 증거다. 온라인 검색/동기화/복원을100만 건에서 완료했다는 증거가 아니다. 전체 recall은 본문1KiB 조건에서 여전히 큰 메모리를 사용하므로 D/E가 필요하다. 과거 짧은 본문의 fixture 생성 포함1.225GB와 직접 전후 비교하지 않는다.

재현:

```sh
bun scripts/benchmark-project-memory-scale.ts 10000 100000 1000000 --body-bytes=1024
bun scripts/benchmark-project-memory-scale.ts 100000 --modes=read,recall --body-bytes=1024
```

## 검증과 미완료 범위

- source 회귀: 1,000 notes에서 한 note 변경과 앞쪽 주제 추가, 실제129개 변경 거부, 중단 복구·외부 충돌, v1/v2 호환과 source 변경, 페이지별 durable ACK, 중단 재개, 과대 응답 거부.
- 현재 DB는 실제 Pull에서 `full-fallback`을 보고했다. 이번 작업은 운영 migration을 적용하거나 설치 sidecar를 교체하지 않는다.
- B: 실제 연결 대상/RPC 권한·schema/cache를 확정하고 격리 Postgres의 두 연결 동시성·backfill을 검증한 뒤 별도 운영 출하가 필요하다.
- C/D/E: 영속 source/segment index, 재개 가능한 worker, 후보 원문 위치 조회, 한국어 bigram, freshness API, health/100만 건 전체 검색 성능은 미완료다.
- F: snapshot upper sequence, 로컬 ACK coverage와 Push를 영속 색인으로 전환하는 부분은 미완료다.
- H/I/J: 제한된 주제 routing, 노트별 CAS, 증분 archive·revision 정리, 설치본/두 기기/Windows/Ubuntu, 실제24시간·7일 운용은 미검증이다.

원본 파일 형식·entry identity·기존 recovery manifest v1은 유지한다. 되돌리기는 캐시/코드 경로만 대상으로 하며 정본·미해결 작업을 삭제하지 않는다. 최종 소스 검증은 maintainer의 이번 실행 보고서로 확인한다.

## 공개 설명

`AgentsToZ-memory`의 SDK0.1.0은 이 앱과 독립 릴리스다. 256,000bytes 정제 문서와 전체 리비전 스냅샷을 사용한다. 앱 reader 측정값을 SDK 성능으로 옮겨 적지 않는다. 공개 자료에는 합성 통계와 이미 공개된 API/형식만 포함하며 개인 기억·원본 대화·운영 연결값은 포함하지 않는다.

## 최종 검증 영수증

- Maintainer `verify`: `20260923T120459Z-758c6478`, passed, `sourceUnchanged: true`,335.222초. TypeScript 오류0, Bun4,400 pass/0 fail(594파일), Rust60 pass/0 fail.
- 첫 전체 실행의 실패1건은 옛 파서 변수명을 찾던 source-text 검사였다. 실제 파일의 v2 프레임·전체 payload·캐시 제거 후 동일 기록 복원 검사로 교체하고 위 전체 실행을 통과했다.
- 독립 SDK: Node 테스트29 pass/0 fail, 패키지 allowlist·offline 설치·TypeScript 소비자 검사 통과. 약23KB 문서, 리비전1,000/10,000에서 별도 프로세스로 조회를 측정했다. 상세 결과와 재현기는 독립 저장소의 `docs/longevity.ko.md`, `scripts/benchmark-history.mjs`에 있다.
- 공개 README/수명 설명/에세이는 독립 저장소 로컬 커밋 `2eefa8e`에 준비했다. 현재 GitHub 계정의 대상 저장소 쓰기 권한 부족(403)으로 원격 Push는 미완료이며 사용자에게 게시 경로를 확인 중이다. 릴리스 tarball·설치 앱·운영 DB는 갱신하지 않았다.
