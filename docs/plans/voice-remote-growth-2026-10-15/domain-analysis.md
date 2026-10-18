# 도메인 분석: 음성·원격 작업·교정 학습

작성일: 2026-10-15. 읽기 기준 HEAD: `c85d644fcf5fcf8bbe4225c63472df9ce454f74c` (`git rev-parse HEAD` 실측). 이 문서는 현재 계약과 제안 계약을 구분하는 도메인 정본이다. 구현·출하·성능 통과를 선언하지 않는다.

## 개요와 확인한 현황

목표는 사용자가 정확한 대상에게 말하고, 휴대폰에서 같은 작업을 안전하게 이어 하며, 이전 교정의 원인을 다음 작업에서 다시 확인할 수 있게 만드는 것이다. 빠른 음성만으로 목표를 통과시키지 않는다. 잘못된 대상·부정 지시의 반대 실행·중복 실행은 각각 독립 실패다.

| 확인한 사실 | 의미·근거 |
| --- | --- |
| 앱은 로컬 서버·프로젝트·Workroom·OPS·프로젝트 기억을 함께 다룬다. | 대상과 기억의 소유 범위를 보존해야 한다. `README.md:45`, `README.md:57`, `README.md:65`, `README.md:94`. |
| 음성은 담당자 Workroom에 사용자의 말을 전달하고 AI 지시 초안은 확인 후 전송한다. | 현재 사용 흐름의 승인 계약을 신규 엔진에도 유지한다. `README.md:103`, `src/voiceSessionHost.ts:484`, `src/voiceSessionHost.ts:573`. |
| 현재 OpenAI 제공자는 Realtime calls·host sideband·최종 전사·function call을 사용한다. | 모델 이름만 바꾸는 이행은 계약을 깨뜨린다. `src/voiceRealtimeProvider.ts:28`, `src/voiceRealtimeProvider.ts:40`, `src/voiceRealtimeProvider.ts:58`, `src/voiceSessionHost.ts:530`, `src/voiceSessionHost.ts:550`. |
| 같은 voice owner 및 같은 binding의 동시 음성은 제한되고, 실행 전에 권한을 재검증한다. | 원격 단말과 로컬 단말의 음성도 같은 일관성 경계다. `src/voiceSessionHost.ts:119`, `src/voiceSessionHost.ts:124`, `src/voiceSessionHost.ts:385`, `src/voiceSessionHost.ts:393`. |
| 재연결은 grant 확대가 아니며 원격 기능과 기억 공개는 별도 범위다. | 사용 편의 개선이 권한 자동 부여를 뜻하지 않는다. `README.md:79`, `README.md:83`, `README.md:85`, `README.md:88`. |
| 원격 terminal admission은 queue를 제한하고 session token을 대기 전·후 확인한다. | 기존 세대 결속과 공정성을 재사용한다. `src/remoteControlRelayController.ts:93`, `src/remoteControlRelayController.ts:1499`, `src/remoteControlRelayController.ts:1537`, `src/remoteControlRelayController.ts:1553`, `src/remoteControlRelayController.ts:1567`. |
| Workroom 논리 대화와 실제 session이 분리되며 SQLite resume receipt가 있다. | 새로운 음성 영수증 DB로 기존 복구를 중복 구현하지 않는다. `src/workroomConversationProtocol.ts:7`, `src/workroomConversationJournal.ts:8`, `src/workroomConversationJournal.ts:17`, `src/workroomConversationJournal.ts:197`. |
| correction은 정확한 entry/body version에 결속하고 기존 claim을 회상에서 제외한다. | 보고된 대안은 확정 사실로 승격하지 않는다. `src/projectMemoryFeedback.ts:11`, `src/projectMemoryFeedback.ts:24`, `project-memory-server.ts:2648`, `project-memory-server.ts:2676`. |
| 매시간 점검은 deterministic disposable summary이며 AI·기억 수정이 없다. | 점검 시각은 학습 효과의 증거가 아니다. `src/projectMemoryCorrectionReview.ts:21`, `src/projectMemoryCorrectionReview.ts:42`, `src/projectMemoryCorrectionReview.ts:47`, `src/projectMemoryCorrectionReview.ts:53`, `api-server.ts:27483`. |
| 설치 v785 자동 영어 3233ms와 이전 Codex CLI 1318ms는 작은 서로 다른 조건의 관측이다. | 우위 미달·미검증이 현재 기준선이며 paired p95로 재해석하지 않는다. `.agentstoz/maintainer/voice-remote-installed-20261015/RESULT.md:21`, `.agentstoz/maintainer/voice-remote-installed-20261015/RESULT.md:37`. |
| 물리 iPhone 증거는 LAN health 읽기 30회이며 인증 후 조작·셀룰러·Codex UX는 아니다. | 기능별 분모와 provenance를 분리한다. `.agentstoz/maintainer/voice-remote-installed-20261015/RESULT.md:15`, `.agentstoz/maintainer/voice-remote-installed-20261015/RESULT.md:17`. |
| C/D/E는 긴 제출·원격 history·semantic events/초안/대기열 후속 범위다. | 기존 semantic runtime과 PTY history를 증거 없이 병합하지 않는다. `docs/plans/workroom-conversation-recovery-2026-10-13/EXECUTION.md:55`, `docs/plans/workroom-conversation-recovery-2026-10-13/DESIGN.md:82`. |

기술 조사: TypeScript/Bun/React 19/Tauri 2이며 조합 지점은 평평한 `src/*`와 `api-server.ts`다 (`package.json:13`, `package.json:25`, `package.json:98`, `package.json:111`, `api-server.ts:70`). Bun 테스트, Python maintainer, Rust 검증은 현재 verify에 연결되어 있다 (`package.json:26`, `package.json:27`, `package.json:28`, `package.json:33`). `wc -l src/App.tsx api-server.ts`에서 각각 16,693/27,774줄을 확인했다. 작은 순수 계약을 독립 모듈에 두고 이 두 조합 파일에 새 의미를 묻어 넣지 않는 것이 적합하다. 이는 설계 판단이며 새 폴더 계층이나 모든 Repository의 추상화가 필요하다는 뜻은 아니다.

## 액터 (Actors)

| 액터 | 역할·필요 | 유스케이스 |
| --- | --- | --- |
| OPS 사용자 | 프로젝트 간 대상을 정하고 운영 맥락을 확인한다. 프로젝트 기록과 운영 기록을 구분한다. | `StartVoice`, `SelectPartner`, `ReviewCommand`, `RecallCorrection` |
| 프로젝트 담당 사용자 | 현재 Workroom에 말·입력을 보내고 그 이후 출력만 듣는다. | `RelayReviewedInput`, `ObserveTaskReceipt`, `ReportCorrection` |
| 인증된 원격 기기 사용자 | 현재 grant의 프로젝트에서 작업을 이어 하고 끊긴 전송의 결과를 확인한다. | `ReconnectController`, `RecoverSubmission`, `ResumeConversation` |
| 공유 OPS 기억 검토자 | 인증된 사람이 현재 revision의 후보를 검토한다. | `ReviewOpsProposal` |
| 음성 제공자 | 음성·자막·위임 요청을 보내지만 대상/권한의 정본이 아니다. | `ReceiveVoiceEvents`, `CloseVoice` |
| 호스트 유지보수 tick | 기존 correction의 상태를 제한된 예산으로 확인한다. 별도 AI 액터가 아니다. | `ReviewCorrectionsHourly` |
| 검증 운영자 | 사전 고정 protocol로 모든 시도를 기록하고 제품 우위와 proxy 결과를 구분한다. | `RegisterBenchmarkProtocol`, `EvaluateBenchmark` |

액터 범위는 기존 README·DTO에서 도출했다 (`README.md:65`, `README.md:83`, `README.md:103`, `src/voiceSessionHost.ts:13`, `src/voiceSessionHost.ts:31`, `src/controlProfileStore.ts:259`). 유지보수 tick을 새 자율 AI로 바꾸지 않는다 (`src/projectMemoryCorrectionReview.ts:21`).

## 유스케이스 목록

1. **StartVoice / SelectPartner**: 기존 key 설정과 사용자 consent를 확인한 뒤 OPS 또는 현재 허용 Workroom에 연결한다. 전환 중 발언과 늦게 도착한 발언은 이전 대상에 전달하지 않는다. 대상 별칭이 중복되면 확정 대상 없이 실행하지 않는다. 전환 뒤 기록 소유자는 발언 시작 시 듣던 대상이다. 근거: `src/voiceSessionHost.ts:31`, `src/voiceSessionHost.ts:146`, `src/voiceSessionHost.ts:307`, `src/voiceSessionHost.ts:385`, `src/voiceSessionHost.ts:531`.
2. **ReviewCommand / RelayReviewedInput**: 기존 Realtime final transcript와 Live caption delta를 다른 증거로 취급한다. Live delta·무음 timer·delegation offset은 완전한 명령 증거가 아니다. 제안 `UtteranceCandidate`는 사용자 또는 검증된 명령 경계가 확정하기 전 외부 효과를 내지 않는다. 확정할 수 없는 Live 자동 전달은 지원하지 않는 상태로 남기고 legacy 경로를 유지한다. 기존 담당자 relay는 final transcript·listener identity·현재 binding을 확인한 기존 계약으로 계속한다. 근거: `src/voiceSessionHost.ts:484`, `src/voiceSessionHost.ts:530`, 아래 공식 문서.
3. **ObserveTaskReceipt / CloseVoice**: 전송 접수, 전체 PTY write, provider turn 시작, 작업 완료, 음성 종료를 구분해 보여 준다. 음성 종료는 작업 취소 요청이 아니며 작업 취소 요청은 완료 확인이 아니다. 접수 후 응답 유실은 상태 조회로 복구하며 자동 재실행하지 않는다. 근거: `src/voiceSessionHost.ts:125`, `src/voiceSessionHost.ts:585`, `src/voiceSessionHost.ts:638`, `src/remoteControlTaskProtocol.ts:72`, `docs/plans/workroom-conversation-recovery-2026-10-13/DESIGN.md:154`.
4. **ReconnectController / RecoverSubmission**: 유효한 연결 → grant → target/account/segment → receipt → snapshot/cursor → 입력 순서로 재접속한다. 옛 connection token으로 대기한 명령은 새 host에 보내지 않는다. unknown 또는 다른 저장소의 not-recorded는 실행하지 않았다는 증거가 아니다. 신규 긴 제출은 완전한 UTF-8·digest·revision·writer epoch 확인 후에만 쓰기를 예약한다. 이는 C/D/E 제안이며 현재 전부 구현된 기능이 아니다. 근거: `src/remoteControlRelayController.ts:1537`, `src/remoteControlRelayController.ts:1572`, `docs/plans/workroom-conversation-recovery-2026-10-13/DESIGN.md:128`, `docs/plans/workroom-conversation-recovery-2026-10-13/DESIGN.md:170`, `docs/plans/workroom-conversation-recovery-2026-10-13/DESIGN.md:184`.
5. **ResumeConversation**: 같은 logical conversation의 현재 provider/account/workspace를 검토하고 expectedRevision과 durable reservation으로 하나의 새 실행 구간만 연다. 이전 첫 프롬프트를 재전송하지 않는다. remote history read/resume는 새 scope 검토가 끝나야 하며 기존 terminal grant를 그대로 재사용하지 않는다. 근거: `src/workroomConversationProtocol.ts:25`, `src/workroomConversationJournal.ts:197`, `docs/plans/workroom-conversation-recovery-2026-10-13/EXECUTION.md:12`, `docs/plans/workroom-conversation-recovery-2026-10-13/DESIGN.md:188`.
6. **ReportCorrection / RecallCorrection**: 사용자 보고를 memoryId·entryKey·contentVersionHash·evidence에 결속하고 멱등 append한다. 다음 관련 작업의 bounded recall에 기존 claim 대신 reported correction·원인·다음 확인을 전달한다. body version 변경 뒤 옛 보고는 감사 기록이며 새 본문의 자동 오류 판정으로 적용하지 않는다. ledger가 읽히지 않으면 현재 claim 재사용을 보류한다. 근거: `src/projectMemoryFeedback.ts:24`, `src/projectMemoryFeedback.ts:294`, `project-memory-server.ts:2633`, `project-memory-server.ts:2652`, `project-memory-server.ts:2676`.
7. **ReviewCorrectionsHourly / ObserveCorrectionOutcome**: 기존 tick은 pending/changed/unbound를 유지하고, 제안 outcome은 해당 다음 작업의 독립 영수증·관측으로 연결한다. 회상 횟수와 시간 경과만으로 개선 성공을 표시하지 않는다. 실패 원인 보고와 실제 재발은 별도 상태다. 자동 저장·원문 수집의 동의는 별도이며 공유 OPS 후보를 스스로 승인하지 않는다. 근거: `src/projectMemoryCorrectionReview.ts:5`, `src/projectMemoryFeedback.ts:11`, `api-server.ts:27492`, `src/controlProfileStore.ts:270`.
8. **RegisterBenchmarkProtocol / EvaluateBenchmark**: 모든 시도와 실패를 등록한 같은 workload의 paired 결과를 평가한다. corpus/metric/consent/cleanup/provenance가 빠지면 미실행 또는 비교불가이며 통과가 아니다. unsafe 결과는 다른 지표의 우위에 앞서 실패시킨다. 현재 report의 heterogeneous 샘플과 Codex CLI adapter 2턴 benchmark는 입력 자료로만 보존한다. 근거: `.agentstoz/maintainer/voice-remote-installed-20261015/RESULT.md:21`, `benchmark-codex-conversation.ts:37`, `benchmark-codex-conversation.ts:103`, `benchmark-codex-conversation.ts:112`.

GPT-Live 공식 이행 문서는 음성을 지속 스트리밍하고 수동 commit/voice-turn trigger를 제거하며, 음성 응답별 `response.done` 대응 이벤트가 없다고 설명한다. 자막은 delta이며 앱의 표시 그룹과 재생 수명이 별도다. 따라서 실제 명령 경계를 증명하는 별도 spike가 이행 선행 조건이다. [OpenAI GPT-Live migration](https://developers.openai.com/api/docs/guides/live-migration#adapt-the-connection-and-audio-lifecycle). 공식 session 종료 확인은 `session.close` 뒤 `session.closed` 수신까지이며, 연결 실패·timeout이면 final usage는 미확정이다. [OpenAI WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live#handle-media-and-events).

## 도메인 모델

### Aggregate: VoiceSession — 현재 호스트의 음성 일관성 경계

**Root Entity:** 기존 `VoiceSessionHost`의 `Session`, ID `voice_*`. owner/authority, target/binding, active partner, draft, calls, receipts, record segments가 여기에 속한다 (`src/voiceSessionHost.ts:67`, `src/voiceSessionHost.ts:95`). provider network와 PTY 실행을 같은 DB transaction으로 묶는 Aggregate가 아니다.

**불변식:** 활성 권한과 binding은 await 뒤에도 재검증한다. 전환 중·listener 불일치 발언을 보내지 않는다. 동일 requestId+같은 payload는 기존 결과를 반환하고 payload 변경을 거절한다. target 전환·음성 reconnect는 이전 명령을 다시 실행할 권한이 아니다. session ended와 작업 완료는 다르다. 현재 구현은 session receipts가 메모리 안에 있으므로 앱 crash 뒤 durable submission 완료를 보장한다는 주장을 하지 않는다 (`src/voiceSessionHost.ts:124`, `src/voiceSessionHost.ts:373`, `src/voiceSessionHost.ts:493`, `src/voiceSessionHost.ts:531`, `src/voiceSessionHost.ts:638`).

**Value Objects:** 기존 `VoiceTarget`, `VoiceAuthority`, `VoiceDraft`, `VoiceReview`를 재사용한다 (`src/voiceSessionProtocol.ts:18`, `src/voiceSessionProtocol.ts:53`, `src/voiceSessionHost.ts:13`, `src/voiceSessionHost.ts:14`). 제안 `UtteranceCandidate`는 session/provider provenance·listener binding·후보 revision·부분/확정 증거를 갖는 비실행 자료다. 제안 `ReviewedCommand`는 표시하고 확인한 완전한 text digest·target binding·현재 draft/review ID·명시적 전송 의사를 결속한다. 이 이름은 새 provider event 이름이나 구현된 wire DTO를 뜻하지 않는다.

**Domain Events(의미 이름, 현재 wire 명세가 아님):** `VoicePrepared`, `PartnerSelected`, `UtteranceCandidateUpdated`, `CommandReviewed`, `SubmissionAcknowledged`, `VoiceCloseRequested`, `VoiceCloseConfirmed`. `TaskCompleted`를 제공자의 말이나 `VoiceCloseConfirmed`에서 합성하지 않는다.

**Repository:** VoiceSession은 ephemeral host 상태이며 새로운 영속 Repository를 만들지 않는다. crash/전송 복구가 필요한 범위는 아래 기존 Workroom journal 또는 C의 submission receipt에 맡긴다.

### Aggregate: WorkroomConversation — 논리 대화와 재개 예약

**Root Entity:** 기존 `WorkroomConversation` ID + storeInstanceId의 저장소 계보. 실제 terminal session은 별도 실행 구간이고 account/target/provider binding은 host-only 증거다 (`src/workroomConversationProtocol.ts:7`, `src/workroomConversationProtocol.ts:22`, `src/workroomConversationHost.ts:4`, `src/workroomConversationJournal.ts:8`).

**불변식:** expectedRevision·pending resume·같은 request digest 검증과 예약은 짧은 SQLite transaction에서 수행한다. network/provider 검사/CLI spawn은 밖에서 실행한다. prepared 이후 crash는 unknown이며 재개를 재실행하지 않는다. unknown receipt를 원래 account/target/boot/store 증거 없이 completed로 바꾸지 않는다 (`src/workroomConversationJournal.ts:190`, `src/workroomConversationJournal.ts:197`, `src/workroomConversationJournal.ts:208`, `docs/plans/workroom-conversation-recovery-2026-10-13/EXECUTION.md:11`).

**Value Objects:** `WorkroomResumeReceipt`, `WorkroomHistoryRequest`, 기존 revision/requestId/storeInstanceId. C 제안 `SubmissionReceipt`는 complete write를 나타내는 written과 unknown을 구분하며 task receipt와 다르다 (`src/workroomConversationJournal.ts:17`, `docs/plans/workroom-conversation-recovery-2026-10-13/DESIGN.md:154`).

**Domain Events:** `ResumeReviewed`, `ResumeReserved`, `ExecutionSegmentStarted`, `ResumeOutcomeUnknown`, `SubmissionWritten`. 이 의미 이름은 기존 runtime event와 검증된 mapping만으로 결속하며 새 wire event를 임의로 노출하지 않는다.

**Repository Interface — 기존 서명의 정본 재사용:**

```ts
// 도메인 분석용 port 표기. 새로운 저장 구현·폴더·generic repository는 만들지 않는다.
type WorkroomConversationRepository = Pick<WorkroomConversationJournal,
  'get' | 'list' | 'receipt' | 'prepareResume' | 'finishResume' | 'mutate'>;
// 기존 method signatures:
// get(id: string): StoredWorkroomConversation
// list(archived: boolean, before?: string)
// receipt(requestId: string, fingerprint?: string): WorkroomResumeReceipt | null
// prepareResume(id: string, revision: number, requestId: string, input: unknown)
// finishResume(requestId: string, state: 'completed'|'unknown'|'rejected', sessionId?: string)
// mutate(id: string, revision: number, requestId: string,
//        operation: 'rename'|'archive'|'unarchive', title?: string)
```

근거: `src/workroomConversationJournal.ts:131`, `src/workroomConversationJournal.ts:142`, `src/workroomConversationJournal.ts:190`, `src/workroomConversationJournal.ts:197`, `src/workroomConversationJournal.ts:208`, `src/workroomConversationJournal.ts:218`. 암호화 prompt/초안 본문이나 Supabase 동기화는 이 Repository의 현재 범위가 아니다 (`docs/plans/workroom-conversation-recovery-2026-10-13/EXECUTION.md:16`).

### Aggregate: ProjectMemoryFeedback — 정확한 기억 버전의 append-only 증거

**Root:** memoryId의 원본 feedback ledger. event identity는 id/originEventId이며 적용 범위는 entryKey+contentVersionHash다. canonical memory 문서와 해당 ledger가 여러 프로젝트에 임의 합쳐지는 경계가 아니다 (`src/projectMemoryFeedback.ts:24`, `src/projectMemoryFeedback.ts:47`, `src/projectMemoryFeedback.ts:53`).

**불변식:** negative correction은 같은 body version claim을 withdraw한다. positive self feedback은 promotion되지 않는다. 복사/재시도는 원본 event identity를 보존한다. 기존 event를 수정하거나 hourly summary 상한을 맞추기 위해 지우지 않는다. changed/unbound는 감사 대상으로 남고 적용 사실로 승격하지 않는다 (`src/projectMemoryFeedback.ts:11`, `src/projectMemoryFeedback.ts:27`, `src/projectMemoryFeedback.ts:315`, `src/projectMemoryCorrectionReview.ts:5`, `src/projectMemoryCorrectionReview.ts:53`).

**Value Objects:** 기존 `ProjectMemoryFeedbackEvent`, `CorrectionReview`; 제안 `CorrectionOutcome`은 correction event identity, 다음 관련 task receipt reference, 그 작업의 검증 근거와 `avoided | repeated | unknown`을 분리한다. task와 교정의 관련성을 확인하지 못하면 unknown이다. 이는 v1 ledger에 이미 저장되는 필드가 아니다 (`src/projectMemoryFeedback.ts:24`).

**Domain Events:** 기존 immutable correction event를 그대로 사용한다. 제안 outcome은 독립 근거로 append하고 positive feedback 재활용이나 원본 덮어쓰기를 하지 않는다.

**Repository Interface:** `readProjectMemoryFeedback(root)`와 `appendProjectMemoryFeedback(root,input)`/batch를 그대로 사용한다. root는 호스트가 검증한 canonical root이며 모바일이 보내는 임의 경로가 아니다 (`src/projectMemoryFeedback.ts:243`, `src/projectMemoryFeedback.ts:294`, `src/projectMemoryFeedback.ts:303`, `src/projectMemoryFeedback.ts:310`). 새로운 generic Repository와 자동 AI 호출은 필요하지 않다.

### 비교 계약: BenchmarkProtocol / BenchmarkTrial / BenchmarkEvaluation

이것은 부작용 없는 평가 계약이며 새 Aggregate DB나 Repository를 만들지 않는다. S0의 제안 구현 지점은 `src/voiceRemoteBenchmark.ts`와 읽기 전용 `benchmark-voice-remote.ts`다. 기존 `benchmark-codex-conversation.ts`는 CLI adapter 2턴 타이밍이며 그 관측 이름·분모를 유지한다 (`benchmark-codex-conversation.ts:26`, `benchmark-codex-conversation.ts:37`, `benchmark-codex-conversation.ts:103`).

- **BenchmarkProtocol:** 비교 목적(domain), metric, 사전 고정 corpus identity, 입력/문맥/관측/네트워크 조건, paired 순서, 최소 시도·유효 pair 수, 비교 허용 surface, 판단 기준, 원문·개인 음성/작업 사용 동의, cleanup 기준. 모델·제품 버전은 trial provenance에 남기고 숨기지 않는다. 각 metric condition별 비교 조건이 같아야 한다.
- **BenchmarkTrial:** 계획한 모든 시도, pairId·scenario/corpus 항목 identity, AgentsToZ 또는 comparator surface provenance, 시작·종료·첫 출력 관측, semantic success, 전사/실행 오류, provider/transport 오류, cleanup 확인. 실패·timeout도 denominator에 포함한다. missing latency를 0으로 만들거나 실패한 pair를 조용히 제외하지 않는다.
- **BenchmarkEvaluation:** `evaluatedScope: 'reported-evidence'`, `PASS | FAIL | BLOCKED | NOT_RUN`과 이유·전체 시도/오류/유효 pair/제외 수·관측 지표. unsafe 결과는 FAIL 우선, 부족한 조건은 PASS 금지, native 제품 비교에 CLI proxy만 있으면 BLOCKED, 시험 없음은 NOT_RUN. 개별 module/unit PASS가 제품 우위 PASS로 전파되지 않는다. JSON의 완전한 보고를 검증하는 gate이며 물리 실행 사실 자체를 증명하지 않는다.

의미 정답은 expected facts digest로 protocol/corpus에 결속하고, 독립 human 또는 deterministic score의 source를 trial에 남긴다. provider의 spoken claim을 actual tool 결과로 간주하지 않는다. synthetic → recorded → multi-turn 단계에서 intent → delegation → 실제 tool → state → spoken claim을 각각 대조하는 제안 평가 범위이며, 이를 위해 새로운 AI 평가자 호출을 추가하지 않는다.

Manifest는 측정 identity hash와 비민감 결과만 포함한다. raw audio/transcript, credential, SDP, stable device/user/provider ID, 로컬 경로는 포함하지 않는다. 필요한 원본 fixture는 별도 검증 환경에서 동의·보관 경계를 적용하며 hash를 DTO에서 대조한다. 현재 report도 이러한 비밀·원문을 제외한다 (`.agentstoz/maintainer/voice-remote-installed-20261015/RESULT.md:65`).

## 도메인 서비스와 Bounded Context

| Context | 기존 담당 모듈·서비스 | 경계 |
| --- | --- | --- |
| Voice | VoiceSessionHost + provider adapter + VoiceMediaClient | 제공자 자막/위임을 command authority로 승격하지 않는 anti-corruption mapping. host validate·review·receipt 재사용. `src/voiceSessionHost.ts:54`, `src/voiceRealtimeProvider.ts:3`. |
| Workroom Execution | terminal service, Workroom history journal/API, semantic runtime | logical conversation·segment·provider/account binding. PTY write와 semantic turn 완료의 mapping은 검증 후만. `src/workroomConversationHost.ts:4`, `src/workroomConversationProtocol.ts:22`. |
| Remote Access | relay controller·host dispatcher·프로젝트 grant | session token/operationId는 전송, requestId는 runtime 멱등성. scope와 store lineage 검증 뒤 실행. `src/remoteControlTaskProtocol.ts:64`, `src/remoteControlTaskProtocol.ts:86`. |
| Project Memory | recall + append-only feedback + bounded review | reported correction과 확정된 journal 증거를 구분. 공유 OPS 저장은 별도 human review. `project-memory-server.ts:2676`, `src/controlProfileStore.ts:270`. |
| Benchmark | S0 pure admission/evaluation gate | 위 contexts를 실행하지 않고 제출된 증거의 완전성·동등성을 판정. 계획 결과와 실제 제품 결과를 구분. |

`VoiceResolvedTarget`은 기존 대상·도구·review·observe port로서 재사용할 수 있는 정본이다. run(name,args,requestId)/validate/context/review 서명을 다른 계획에서 새로 창작하지 않는다 (`src/voiceSessionHost.ts:31`). CorrectionOutcome의 작업 근거는 runtime receipt를 참조하지만 기억과 실행 journal을 같은 transaction으로 묶지 않는다. 이것은 도메인 일관성 판단이며 구현 레이어·작업 순서의 소유권은 architecture/PLAN에 있다.

## 제안 완료 기준 — 아직 측정 결과가 아님

| Track | 사전 등록할 intended acceptance | 통과로 오해하면 안 되는 것 |
| --- | --- | --- |
| Voice | 한국어·영어·혼용·숫자·개발 용어·부정·중단/복귀 60개 distinct 발화 corpus, metric condition별 최소 30개 유효 pair. 같은 입력·문맥·관측의 응답 p95가 Codex의 0.70배 이하, semantic task 오류 비열등, 잘못된 대상·부정 반전·중복 실행 0. 실패·무응답은 분모에 포함. | 3개 Live feasibility 음원, prompt context가 다른 단일 시간, proxy 결과의 native 제품 주장. |
| Remote | 같은 30개 paired 작업 여정, 실제 인증 iPhone의 허용 프로젝트 조작·재접속·cellular 전환, 1시간 지속 사용. 무중복/무잘못대상 0, 결과 복구·명시적 상태 성공, 비교용 여정 시간·탭/재입력 수 개선의 기준 사전 고정. | health 30읽기, fixture UI, 새 grant 자동 승인, 실제 Codex 모바일 baseline 누락. |
| Correction growth | 기존 정확한 correction의 다음 관련 작업 recall에서 withdraw+reported warning 전달, 실제 task 결과의 avoided/repeated/unknown 관측. hourly review 갱신과 실제 재발 감소를 별도 지표로 보고. | summary checkedAt, pending 0, AI self confirmed, 다른 body version의 옛 실패를 새 오류로 계산. |

0.70 기준은 사용자 기대를 operationalize한 **계획 가정**이다. 비열등 판단의 margin·신뢰구간·sample adequacy는 테스트 전략에서 사전 고정해야 한다. 최소 30 pair의 단순 관측 PASS만으로 통계적 모집단 우위를 주장하지 않는다. 빠른 순수 admission/evaluation 회귀가 먼저 비교 불가능한 자료의 PASS를 막아야 한다. 측정 fixture 의미 정답을 timing보다 먼저 검증한다.

## 가정 목록

| 가정 | 상태·영향 |
| --- | --- |
| 현재 사용자 지시는 계획 후 개선 실행을 허용한다. 별도 새 human message/production scope/원문 수집 동의를 암시하지 않는다. | 세션 지시의 해석. 각 API 동의·grant 계약은 계속 검증한다. |
| Live는 별도 adapter+legacy fallback 후보이며 자동 기본값 교체는 현재 범위가 아니다. | 제안, 미검증. legacy model 설정은 현재 `gpt-realtime*`만 허용한다 (`src/voiceCredentials.ts:30`, `src/voiceCredentials.ts:36`). |
| Live caption delta/offset에서 완전한 명령을 추출할 수 있다. | **가정하지 않는다.** 아직 blocker. spike가 확정한 경계와 review contract 없이는 dispatch 금지. 공식 migration 및 `src/voiceSessionHost.ts:530`의 의존성 근거. |
| 기존 remote terminal grant로 remote history/새 cold resume를 실행해도 된다. | **가정하지 않는다.** D의 신규 scope 검토 필요 (`docs/plans/workroom-conversation-recovery-2026-10-13/DESIGN.md:188`). |
| 교정 효과의 해당 다음 task를 신뢰성 있게 식별하고 독립 결과를 확인할 수 있다. | 미검증. 실패 시 unknown 유지. v1은 독립 outcome receipt가 없고 positive promotion 금지 (`src/projectMemoryFeedback.ts:11`). |
| 모든 프로젝트가 정확히 60분 안에 재검토된다. | 미검증. 현재 tick당 최대8개·한 성공 target은1시간·summary128개이며 outage/다수 target 상한 고려 필요 (`src/projectMemoryCorrectionReview.ts:42`, `src/projectMemoryCorrectionReview.ts:47`, `src/projectMemoryCorrectionReview.ts:54`). backlog/overdue도 표시해야 한다. |
| native Codex 비교가 자동화 가능하다. | **가정하지 않는다.** 현재 safety 거절은 BLOCKED 근거이며 우회하지 않는다 (`.agentstoz/maintainer/voice-remote-installed-20261015/RESULT.md:49`). |
| 알려진 synthetic corpus 의미 정답으로 실제 mic 사용자 정확도를 대신할 수 있다. | **가정하지 않는다.** 설치 앱·실제 mic·실제 iPhone 여정은 별도 증거 (`.agentstoz/maintainer/voice-remote-installed-20261015/RESULT.md:21`, `.agentstoz/maintainer/voice-remote-installed-20261015/RESULT.md:53`). |

## 유비쿼터스 언어 용어집

| 정본 용어 | 의미 |
| --- | --- |
| `VoiceSession` | owner·대상·권한·미디어 수명을 가진 현재 호스트 세션. 작업 완료 단위가 아니다. |
| `VoiceTarget` / `VoiceResolvedTarget` | wire 대상과 호스트가 validate/tools/review로 확정한 실행 결속. provider의 말로 정하지 않는다. |
| `UtteranceCandidate` | 부분/확정 증거와 listener provenance를 가진 제안 발언 자료. 자동 실행 권한 없음. |
| `ReviewedCommand` | 완전한 명령 text·표시한 대상·현재 검토·사용자 전송 의사가 결속된 제안 실행 자료. |
| `VoiceDraft` / `VoiceReview` | 현재 초안과 기존 Workroom 검토/send/observe 계약. |
| `SubmissionReceipt` | 실제 입력 전달의 예약/write/unknown 결과. task 시작·완료와 분리. C의 durable 계약은 제안. |
| `TaskReceipt` | 실행 시스템이 같은 요청의 접수/시작/종료를 증명하는 결과를 가리키는 도메인 용어. 새 DB 형식이 아니다. |
| `VoiceCloseConfirmed` | Live에서는 session.closed 근거로 종료가 확정됨. 작업 취소·완료와 무관. |
| `WorkroomConversation` | 저장된 논리 대화. terminal session은 실제 실행 구간이며 재개에도 같은 logical ID를 유지. |
| `WorkroomResumeReceipt` | 같은 저장소·요청·digest의 prepared/completed/unknown/rejected 재개 결과. |
| `requestId` / `operationId` | runtime의 멱등 요청 키 / 원격 전송 요청·응답 대조 키. 서로 대체하지 않는다. |
| `ProjectMemoryFeedbackEvent` | 정확한 기억 버전의 immutable 보고 증거. correction은 verified replacement fact가 아니다. |
| `CorrectionReview` | pending/changed/unbound의 disposable summary. 효과·기억 수정·가중치 학습 아님. |
| `CorrectionOutcome` | 해당 교정 후 관련 task의 독립 근거로 확인한 avoided/repeated/unknown 제안 결과. |
| `BenchmarkProtocol` | 비교 목적·조건·metric·표본·동의·cleanup·판정 기준의 사전 고정 계약. |
| `BenchmarkTrial` | 실패까지 포함한 각 시도와 provenance/semantic result/관측. |
| `BenchmarkEvaluation` | protocol을 충족한 자료의 PASS/FAIL/BLOCKED/NOT_RUN 및 분모·이유. |
| `Codex CLI proxy` | 별도 public CLI app-server 비교 표면. native Codex desktop/mobile의 증거가 아니다. |

## 우려·확신·briefing_correction

| 우려 | Severity / Confidence | 근거·도메인 처리 |
| --- | --- | --- |
| Live delta를 final command로 바꾸면 부정·대상·긴 명령이 잘릴 수 있다. | 높음 / 높음 | 공식 migration의 event 차이, `src/voiceSessionHost.ts:530`. 확정 경계/review 미증명 시 해당 자동 실행은 지원 불가. |
| 현재 voice submit receipt는 crash durability가 없다. | 높음 / 높음 | `src/voiceSessionHost.ts:91`, `src/voiceSessionHost.ts:373`. C journal 계약 이전에는 crash 후 재실행 안전을 주장하지 않는다. |
| CLI·합성 음원·LAN health 결과만으로 native 제품 우위가 잘못 통과할 수 있다. | 높음 / 높음 | report:21/17/49. BenchmarkEvaluation에 provenance 및 native requirement 우선 gate. |
| hourly summary를 실제 반복 실패 감소로 표현할 수 있다. | 높음 / 높음 | `src/projectMemoryCorrectionReview.ts:21`, `src/projectMemoryFeedback.ts:11`. independent CorrectionOutcome 도입 전 효과는 NOT_RUN. |
| 신규 remote history 범위가 기존 grant로 자동 열릴 수 있다. | 높음 / 높음 | recovery DESIGN:188, 현재 remote conversation LAN=false (`src/remoteControlConversationProtocol.ts:27`). 추가 capability/scope 협상과 호스트 검증. |
| 유지보수 target 수와 outage에서 hourly 보장이 늦어진다. | 중간 / 높음 | review:42/47/54. 완료 시각뿐 아니라 due/backlog/오류 관측 정의 필요. |
| 최소 표본과 관측 비열등 기준이 통계적 우위처럼 표시될 수 있다. | 중간 / 높음 | report:21의 제한. protocol 사전 고정·실패 분모·불확실성 보고. |

`briefing_correction`: Workroom recovery 문서는 `DESIGN.md`와 `EXECUTION.md`이며 `PLAN.md`로 인용하지 않았다. briefing의 installed 측정은 해당 결과 문서의 제한과 함께 확인했다. 코드 검증에서는 queue token 이름이 실제 `#sessionToken`임을 확인했다 (`src/remoteControlRelayController.ts:1537`). 새로운 Aggregate 클래스, benchmark Repository, background AI는 현 도메인 필요로 도출되지 않았다. 원본 source 확인 외 미검증 가정은 위 표에 남겼다.
