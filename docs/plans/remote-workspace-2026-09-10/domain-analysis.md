# 도메인 분석: Mac 프로젝트에서 워크룸 작업과 Codex 앱 처음 열기

## 개요

Mac 네이티브 앱과 Vercel 원격웹의 기본 흐름을 `Mac 선택 → 프로젝트 생성/선택 → 기본 폴더 또는 워크트리 확인 → 워크룸에서 작업 / Codex 앱에서 열기`로 통일한다. 프로젝트를 만드는 행위, CLI를 실행하는 행위, 외부 앱에 프로젝트를 준비하는 행위의 결과를 각각 확인한다. 원격웹은 선택한 Mac에 요청하고 실제 파일과 실행 세션은 그 Mac에 남는다.

이번 문서는 계획이다. 소스·DB·실행 환경을 변경하거나 실제 AI·앱을 실행하지 않았다. 소스에서 확인한 구현과 실제 설치본 동작 증거를 분리한다. 구현 정본은 기존 `RemoteControlRegisteredTarget`, `RemoteControlCore`, `AiTerminalService`, `AiTerminalRequest`, `CodexFirstConversationLaunchCoordinator`를 유지한다. 새로운 일반 런타임이나 프로젝트 계층을 만들지 않는다.

최종 필수 범위는 Mac 네이티브·Vercel 원격웹·iOS 네이티브다. Mac+웹을 먼저 출하할 수 있지만 최종 완료와는 구분한다. iOS는 같은 Mac에 대해 `프로젝트 / 워크룸` 두 탭이 하나의 연결 수명을 공유하고 탭 전환에 새 QR을 요구하지 않는다. LAN 브라우저는 공유 프로토콜 변경의 회귀·동등성 확인에 포함한다.

## 확인한 현재 구조

| 사실 | 근거 | 계획에 미치는 영향 |
|---|---|---|
| 관리형 쓰기 작업은 출하 게이트가 꺼져 있고 읽기 전용 지속 대화는 별도 플래그다. | `src/agentRuntimeProtocol.ts:5-19` | 체크박스를 단순 활성화하지 않는다. 워크룸 CLI를 관리형 작업과 구분한다. |
| 워크룸 CLI는 기존 Bun PTY·일반 CLI 권한으로 파일 작업한다. | `src/aiTerminalService.ts:212-245`, `docs/runtime-execution.md:4` | 실제 작업의 기본 구현은 이 경로를 재사용한다. 관리형 격리 완성과 결합하지 않는다. |
| 프로젝트 상세에 터미널 실행, AgentsToZ 작업, 지속 대화, Codex 외부 앱 진입점이 분산돼 있다. | `src/App.tsx:12124`, `src/App.tsx:12173-12208` | 두 가지 핵심 선택을 우선 배치하고 기존 고급 실행 방식은 아래에 정리한다. |
| 원격 `agent.codex`는 Orca이고 `app.codex`는 외부 Codex 앱 경로다. | `src/remoteControlExternalLaunchRoute.ts:27-35` | `Codex 실행` 하나로 의미를 합치지 않는다. 워크룸 시작에는 기존 terminal 프로토콜을 쓴다. |
| 원격 프로젝트 생성 gateway는 결과를 버리고 core는 첫 페이지 목록을 반환한다. | `api-server.ts:11880-11887`, `src/remoteControlCore.ts:1113-1127` | 생성한 프로젝트를 첫 페이지/이름으로 추정하지 않고 정확한 등록 결과를 반환해야 한다. |
| 원격 터미널은 연결 활성·별도 동의·등록 대상 해석을 각각 검사한다. | `src/aiTerminalRemoteGateway.ts:5-16`, `src/aiTerminalService.ts:187-211` | 준비 화면을 통합해도 동의의 권한 범위는 유지한다. |
| 정상 LAN 끊김에는 프로젝트 제어 세션을 보존하고, 재접속 시 터미널 동의의 management id를 새로 발급한다. | `src/remoteControlLanServer.ts:523-528`, `src/remoteControlLanServer.ts:587-600` | 현재 구현은 재접속마다 다시 동의해야 한다. 최종안은 별도 device grant를 명시적으로 받은 유효 기기에는 재동의를 반복하지 않고 현재 socket 권한을 다시 검증한다. |
| 기존 Codex 첫 대화는 생성 직후 ID 보존·동시요청 합류·정확한 프로젝트 확인 뒤 복구를 지원한다. | `src/codexFirstConversationLaunch.ts:74-107`, `src/codexFirstConversationLaunch.ts:119-155` | 초기 대화 생성과 열기 재시도를 재사용하며 중복 대화를 만들지 않는다. |
| Mac 네이티브 브로커 진단은 `executionAuthorized`, `reusable`, `ready`가 모두 false다. | `src/macOSRuntimeNativeClient.ts:47-55`, `src/macOSRuntimeNativeClient.ts:87-89` | 등록·probe 완료만으로 관리형 실행이 준비됐다고 표시하지 않는다. |
| structured runtime supervisor 초기화와 PTY 서비스 생성 경로가 분리돼 있다. | `api-server.ts:7703-7711`, `api-server.ts:7737-7748`, `api-server.ts:7804-7811` | supervisor 장애가 워크룸·프로젝트 생성·외부 앱 열기를 전역 차단하지 않도록 한다. |

## 액터 (Actors)

| 액터 | 역할 | 유스케이스 |
|---|---|---|
| Mac 사용자 | 파일이 존재하는 Mac에서 직접 실행·권한 관리 | 프로젝트 생성/선택, 워크룸 시작/재개, Codex 앱 처음 열기, 준비 상태 확인 |
| 원격 사용자 | Vercel 또는 LAN 화면에서 승인된 Mac 제어 | 같은 프로젝트 흐름, 상태 확인, 재접속, 현재 연결 동의 요청 |
| Mac sidecar | 등록·파일 신원·CLI 세션·실행 결과의 정본 | 대상 재검증, 중복 방지, 상태 기록, 종료·해제 처리 |
| Codex 앱 | 최초 프로젝트 대화를 열어 사용자가 이후 작업할 외부 앱 | 정확한 프로젝트/대화 선택, 앱 열기 결과 확인 |
| 연결 계층 | LAN 또는 인증·암호화 릴레이로 요청 전달 | 현재 연결 증명, 결과 전달, 세션 복원 |

## 유스케이스 목록

1. **createRemoteControlProject — 프로젝트 만들고 바로 선택하기**
   - 선행조건: 온라인 Mac과 현재 연결에서 허용된 작업 루트 선택, 유효한 프로젝트 이름.
   - 주요 흐름: 기존 `createAgentsToZUseProject`로 생성 → 반환된 등록 ID를 보존 → 생성한 대상의 신원을 다시 확인 → 현재 연결용 임시 controlId와 프로젝트 카드 반환 → 해당 프로젝트가 선택된 두 가지 실행 선택 표시.
   - 예외 흐름: 같은 요청의 응답 유실은 결과 조회로 복구한다. 같은 이름의 다른 프로젝트·첫 페이지의 첫 행을 대체 선택하지 않는다. 생성 후 다음 단계 실패는 생성 성공을 유지하고 그 프로젝트에서 다시 시도한다. 폴더와 등록이 완료된 지점을 확인 가능한 완료 기준으로 정하고, 그 뒤 Git/기억/최근 방문/백업의 부가 실패는 `준비 중` 또는 경고로 분리한다. 이미 등록한 폴더를 부가 처리 실패 때문에 옮기거나 재생성하지 않는다. 근거는 부모가 확인한 `api-server.ts:2254-2352`이며 세부 트랜잭션 경계는 구현 전 재검증한다.

2. **RemoteControlCore — 기본 폴더/워크트리 선택하기**
   - 선행조건: 사용자가 Mac과 프로젝트를 선택함.
   - 주요 흐름: 등록 행·Git worktree를 조회 → `kind: main | worktree`, 표시 이름·브랜치 표시 → 사용자가 정확한 대상 확인 → 실행 직전 동일 등록·디렉터리 신원 재확인.
   - 예외 흐름: 등록 삭제·경로 교체·모호한 중복·해석 불가에는 다시 선택하도록 한다. 분리 HEAD나 브랜치 이름이 같다는 이유로 다른 checkout에 자동 연결하지 않는다.

3. **AiTerminalService.perform(start) — 워크룸에서 작업 시작하기**
   - 선행조건: 정확한 대상, 지원 OS와 해당 CLI, 원격이면 해당 Mac·기기·대상에 대한 유효한 별도 워크룸 grant와 현재 연결 증명.
   - 주요 흐름: AI 선택 및 선택적인 작업 요청 검토 → 기존 start 요청 1회 → 확인된 `AiTerminalSummary.id` 선택 → 출력과 입력 제공. `start` 응답은 PTY 세션 생성 확인이며 CLI 로그인·첫 요청 처리 완료를 뜻하지 않는다.
   - 예외 흐름: 인증·신뢰 확인은 워크룸에서 안내한다. CLI 없음·실행 실패·권한 해제는 원인과 다음 행동을 표시한다. 요청 확인 전 화면 닫힘·통신 유실은 새 start를 자동 발행하지 않고 원래 요청/세션을 조회한다.

4. **AiTerminalService.perform(list/read/input/close) — 같은 워크룸 이어가기**
   - 선행조건: 같은 Mac·정확한 대상에 묶인 실제 세션이 살아 있음.
   - 주요 흐름: 원래 세션 ID로 목록·상태 확인 → 유효 device grant 및 현재 연결 권한 재검증 → 마지막 확인 출력 cursor부터 읽기 → 사용자 입력 순서 보존.
   - 예외 흐름: Mac 전환·sidecar 재시작·이미 종료·권한 해제는 상태를 분리한다. 화면이 닫혔다는 이유로 CLI를 종료하지 않는다. 부재한 세션은 자동 복제하지 않는다. 출력이 잘렸으면 그 사실만 표시한다.

5. **CodexFirstConversationLaunchCoordinator.createAndOpen — Codex 앱에서 처음 열기**
   - 선행조건: 정확한 Mac 프로젝트, 설치된 Codex 앱, 첫 대화 준비에 필요한 확인 가능한 환경.
   - 주요 흐름: 기존 첫 대화 생성 경로와 준비용 고정 메시지를 재사용 → 생성된 정확한 threadId 즉시 보존 → 정확한 desktop membership 및 thread 결속 검증(cwd 일치만으로 대체하지 않음) → 그 threadId의 앱 열기 요청 → 확인 가능한 단계까지 결과 표시. 사용자는 그 후 Codex 앱에서 작업한다. 확인된 기존 연결이 있으면 버튼은 `Mac의 Codex 앱에서 이어 열기`, 확실히 없으면 `Mac의 Codex 앱에서 처음 열기`로 표시한다. 안내는 `프로젝트 연결용 첫 대화만 준비하며 실제 작업은 Mac Codex 앱에서 이어서 진행`으로 한다.
   - 예외 흐름: 대화 생성 뒤 앱 열기만 실패하면 동일 대화를 다시 연다. 생성 여부가 불명확하면 기록을 먼저 확인한다. 앱 열기 접수는 자동 작업 완료가 아니며, 접근성 권한·프로젝트 결속·앱 화면 확인이 불가하면 `Mac에서 확인 필요`를 표시한다. 임의 프로젝트 검색이나 새 대화 반복 생성으로 우회하지 않는다. 메타데이터 확인 불가 또는 첫 메시지 전송 여부 불명확이면 새 생성 없이 재확인한다. AI 호출 없는 `mode=new` deep link는 보조 `앱만 열기`로 둘 수 있으나 영구 프로젝트 연결 완료로 판정하지 않는다.

6. **준비 상태 확인 — 가능한 행동과 해결할 항목 보여주기**
   - 선행조건: 사용자가 Mac 또는 실행 방식을 선택함.
   - 주요 흐름: 연결/호스트, 프로젝트 접근, 워크룸 CLI, Codex 앱, 읽기 전용 대화, 관리형 작업을 독립 평가 → 해당 행동에 필요한 준비만 표시.
   - 예외 흐름: 오래된 supervisor 잠금은 진단 가능한 별도 복구 상태로 보여준다. PID가 없다는 이유만으로 잠금을 지우지 않는다. 수동 복구 정책의 근거는 `src/agentRuntimeSupervisor.ts:11-15`, `src/agentRuntimeSupervisor.ts:31-34`다. P0는 원인 노출과 안전한 복구 경로의 검증이며, 미검증 하위 프로세스가 남을 수 있는 상태에서 자동 복구를 보장하지 않는다.

7. **재접속/권한 변경 — 프로젝트 연결과 작업 권한을 구분하여 복원하기**
   - 선행조건: 유효한 승인 세션의 재연결 또는 사용자 동의 변경.
   - 주요 흐름: 프로젝트 제어 연결 복원 → Mac·선택 대상·기존 워크룸 존재 확인 → 별도 device grant의 host/controller/target/expiry/revision과 현재 socket epoch 검증 → 같은 세션 이어가기. 유효한 동일 기기는 최초 QR 1회와 별도 동의 후 최대 30일 동안 routine reconnect·백그라운드·탭 전환·브라우저/앱/sidecar 재시작마다 QR이나 Mac 승인을 반복하지 않는다. 만료·수동 철회·저장정보 명시 삭제 시 재연결 절차를 안내한다. Mac 주소가 바뀌면 pinned host identity를 검증해 locator만 갱신하며 QR을 재소비하지 않는다. PTY 프로세스 생존은 이 연결 유효기간과 별도다.
   - 예외 흐름: 승인 해제·만료·Mac 변경·새 pairing/controller는 새 동의가 필요하다. 기존 session-only terminal 권한과 QR task/conversation 권한을 persistent grant로 자동 승격하지 않는다. 별도로 저장한 device grant가 없는 기존 설치본은 다시 명시적으로 허용해야 한다. 터미널 접근 해제는 이후 원격 입출력을 막으며 로컬 사용자가 작업을 계속할 수 있다.

## 도메인 모델

### 기존 Aggregate: AiTerminalService의 Session

기존 내부 `Session`과 공개 `AiTerminalSummary`를 그대로 쓴다. 새 `WorkroomSession` 동의어를 만들지 않는다. UI에서 이 세션을 워크룸의 작업 세션이라고 부른다.

- Root ID: `AiTerminalSummary.id`.
- 상태: `running | exited`; 대상은 `targetId`, AI는 `agent`다.
- 수명: API 프로세스에 묶이며 화면/원격 연결 수명과 다르다.
- 불변식: 시작한 checkout 신원 고정, 권한 epoch 변경 뒤 대기 중 입력 거부, 요청 ID 충돌 거부, 종료 뒤 입력 거부, EOF 처리 뒤 종료 상태 표시.
- 근거: `src/aiTerminalService.ts:90-96`, `src/aiTerminalService.ts:108-121`, `src/aiTerminalService.ts:154-177`, `src/aiTerminalService.ts:187-211`, `src/aiTerminalService.ts:236-250`.
- 기존 `AiTerminalDependencies`와 메모리 Map을 재사용한다. 원시 PTY 핸들을 영속화하거나 종료된 프로세스를 복원했다고 주장하지 않는다.

### 별도 워크룸 기기 권한: RemoteTerminalGrant

최초 Mac 승인 화면에 기본 꺼짐의 `이 기기에서 워크룸 작업 허용`을 독립 opt-in으로 제시한다. 관리형 작업/읽기 전용 대화의 기존 동의를 재사용하지 않는다. 사용자가 허용한 프로젝트 범위와 유효기간을 함께 보여준다. 이 권한은 이후 같은 기기의 유효한 재접속에 재사용하되 매 연결의 실제 권한을 자동으로 인정하는 bearer receipt로 내보내지 않는다.

기존 인터넷 `RemoteControlHostSessionRecord`는 controllerId와 제한된 scopes를 영속화한다(`src/remoteControlHostVault.ts:59-68`, `:209-218`). 현재 parser는 task/conversation만 허용하므로 새 optional grant record를 versioned 방식으로 확장한다. LAN `RemoteControlLanSessionRecord`에는 token·시각만 있으므로(`src/remoteControlLanVault.ts:42-48`) 안정된 pairing principal과 host binding이 선행되어야 한다. IP/port를 host identity로 쓰지 않는다. 별도 신규 DB보다 기존 private vault의 atomic-write 어댑터를 우선 검토한다.

```ts
type RemoteTerminalGrantScope =
  | { kind: 'targets'; targetIds: readonly string[] }
  | { kind: 'controller-created-projects'; workspaceRoots: readonly {
      workspaceRootId: string; identityHash: string;
    }[] };

interface RemoteTerminalGrant {
  hostId: string;
  controllerId: string;
  scope: RemoteTerminalGrantScope;
  grantedAt: string;
  expiresAt: string;
  revision: number;
  revokedAt: string | null;
}

interface RemoteTerminalGrantStore {
  find(hostId: string, controllerId: string): Promise<RemoteTerminalGrant | null>;
  update(grant: RemoteTerminalGrant, expectedRevision: number | null): Promise<boolean>;
}
```

**OWNS:** 위 grant store 시그니처도 이 문서가 정본이다. `update(..., null)`은 부재 시 최초 생성, 숫자 revision은 CAS 갱신이다. 권한 확대와 철회는 Mac의 확인된 동작만 가능하다. revoked record의 revision을 보존해 오래된 복원본이 권한을 부활시키지 못하게 한다. scope는 선택 프로젝트 집합 또는 선택한 작업 루트에서 **이 기기가 만든 프로젝트 포함**의 concrete union이다. 후자를 권장하되 최초 화면에서 명시적으로 선택한다. 포함 여부는 현재 root의 stable identity, 같은 controller의 생성 receipt, 현재 등록/실제 checkout identity를 모두 확인한다. 같은 이름/경로·다른 controller·다른 root·기존 타인 프로젝트는 자동 포함하지 않는다. wire에는 서버용 등록 ID 대신 임시 controlId를 쓴다. 유효기간은 Mac의 최초 승인 시각(grantedAt)부터 정확히 30일이며 현재 승인 세션의 절대 만료시각을 넘지 않는다. 미사용 QR 발급일은 승인 시각과 다르다. 승인 후 29일 23:59에는 유효하고 정확히 30일 경계에는 만료한다. 29일 오프라인 뒤 연결과 Mac/iOS/브라우저 재시작은 이 만료시각을 줄이거나 연장하지 않는다.

연결 복원은 stable pairing/controller + host + scope + expiry + revocation revision을 확인하여 **현재 socket epoch**에만 기존 AiTerminalAuthority를 부여한다. 동일 기기 재접속은 재동의 없이 이어지지만 이전 socket, 폐기한 epoch, await 중 바뀐 grant revision, 지연 중인 출력/입력은 거부한다. CLI 세션 수명과 grant 수명은 다르다. 오래된 session-only 권한의 자동 이동·terminal 원문/키/토큰을 grant record에 추가하는 것은 금지한다.

### 추가 Aggregate: ProjectLaunchReceipt

`project.create`, 워크룸 start, Codex 앱 처음 열기의 중복 방지와 부분 성공 기록만 묶는다. 프로젝트/세션/외부 앱 자체를 소유하는 거대한 aggregate로 만들지 않는다. 기존 `actionId`/`requestId`를 재사용하며 동일 의미의 두 번째 요청 ID를 추가하지 않는다.

**Root Entity: ProjectLaunchReceipt**

```ts
type ProjectLaunchKey = {
  hostId: string;
  owner: string;
  requestId: string;
};

type ProjectLaunchTarget = {
  targetId: string;
  kind: 'main' | 'worktree';
  identityHash: string;
};

interface ProjectLaunchReceipt {
  key: ProjectLaunchKey;
  operation: 'project.create' | 'workroom.start' | 'app.codex.open';
  requestFingerprint: string;
  target: ProjectLaunchTarget | null;
  workspaceRoot: { workspaceRootId: string; identityHash: string } | null;
  status: 'requested' | 'confirmed' | 'unknown' | 'failed';
  stage: string;
  createdProjectId: string | null;
  terminalSessionId: string | null;
  threadId: string | null;
  revision: number;
  updatedAt: string;
}
```

위 타입은 서버 내부 정본이다. `stage`의 값은 기존 동작에 맞춘 제한된 값 집합으로 구현하며 원시 오류·자유 텍스트 로그를 저장하지 않는다. 문자열 필드는 기존 protocol ID/시각 검증 규칙과 유한한 길이를 적용한다. wire에 내부 등록 ID·identityHash·경로를 내보내지 않는다. 원격 응답은 해당 연결에 다시 매핑한 controlId와 표시용 상태만 갖는다.

**Value Objects와 identity 규칙**

- `ProjectLaunchKey`: 안정된 Mac 식별자 + 복원 가능한 승인 세션/컨트롤러를 나타내는 서버용 비밀 아닌 owner + 기존 요청 ID. LAN의 현재 terminal grant owner인 `lan:<management id>`를 이 owner와 동일시하지 않는다. 새 management id는 현재 socket 생존·권한 epoch 검사용이며 persistent grant 자체가 아니다(`src/remoteControlLanServer.ts:523-528`). 토큰·공개 웹 클라이언트의 자기 선언 값을 저장 키 권한 근거로 쓰지 않는다.
- `ProjectLaunchTarget`: 등록 대상, `main | worktree`, 서버가 계산한 검증된 디렉터리/Git 신원 지문. 브랜치 이름·화면 이름은 identity가 아니다. 기존 `bindAiTerminalTarget`과 등록 증거 계산을 재사용한다(`src/aiTerminalService.ts:23-78`).
- receipt는 실행 의도/확인 결과를 기록하며 실행 권한이 아니다. 재시도·조회에도 현재 연결과 현재 대상 권한을 다시 검사한다.

**불변식 (Invariants)**

1. 같은 key와 같은 requestFingerprint는 기존 결과에 합류한다. 같은 key에 다른 대상·AI·작업 내용은 충돌로 거부한다. 예약 기록 뒤에만 외부 효과를 시작한다.
2. `requested`는 접수/전달을 뜻한다. 통신 timeout은 `failed`의 증거가 아니며 `unknown`으로 남겨 결과 조회를 먼저 한다. 요청 payload 본문을 receipt에 저장하지 않고 bounded fingerprint와 결과 식별자만 보존한다.
3. `confirmed`의 의미는 operation별로 고정한다. 프로젝트 생성은 정확한 등록 결과, 워크룸은 해당 대상의 실제 PTY 세션 생성, Codex 앱은 검증된 프로젝트/대화 준비 결과다. 앱 활성화는 별도 단계이며 OS deep link 접수만으로 실제 화면 확인을 선언하지 않는다.
4. 생성할 projectId는 mkdir/registration 부작용 전에 reserved receipt의 createdProjectId에 먼저 보존한다. 이 필드는 registered 확인 전에는 예약 ID일 뿐 성공 증거가 아니다. workspaceRoot에는 원래 선택 root의 stable identity를 보존한다. 생성한 프로젝트·terminalSessionId·threadId는 확인 즉시 저장한다. 후속 열기 실패나 응답 유실이 앞 단계의 성공을 지우지 않는다. 기존 pending store를 중복 저장소와 경쟁시키지 않도록 어댑터로 연결하거나 단일 정본으로 이동한다.
5. `failed`는 해당 단계에서 외부 효과가 없거나 종료 결과가 확인된 경우다. sidecar가 예약 뒤 중단되면 새 실행 전에 현재 등록/세션/대화 기록으로 조정한다. 확인 불가 상태를 자동 재실행하지 않는다.
6. 과거 terminalSessionId는 sidecar 재시작 후 살아 있다고 간주하지 않는다. 현재 AiTerminalService 목록과 동일 Mac·대상으로 다시 확인하며 발견되지 않으면 `unknown` 또는 종료 확인으로 안내한다.
7. 결과가 확인되지 않은 receipt를 개수 예산 때문에 삭제해 요청을 새것으로 만들지 않는다. 완료 receipt의 보존·만료는 재시도 허용 수명과 일치시켜 오래된 요청이 다시 실행되지 않도록 한다. 본문·credential·원시 경로는 저장/전송하지 않는다.

**Domain Events**

별도 event bus를 도입하지 않는다. 다음은 receipt 전이와 기존 응답/상태 조회에서 관측할 사건의 의미다.

- 요청 접수: `requested` 예약이 저장됨. payload는 key·operation·검증한 대상 요약.
- 프로젝트 등록 확인: createdProjectId가 확인됨. 현재 연결의 created controlId를 반환.
- 워크룸 시작 확인: terminalSessionId와 target 결속이 확인됨. AiTerminalSummary를 반환.
- Codex 대화 준비 확인: threadId의 project 결속이 확인됨. 같은 대화를 여는 단계로 진행.
- 결과 확인 필요: 요청 전송 후 확인 불가. 기존 요청 결과 조회/같은 대화 다시 열기만 제공.

**Repository Interface**

> **OWNS:** 아래 인터페이스 시그니처 정본은 이 문서다. architecture.md는 그대로 인용·구체화한다. 저장 기술과 파일 배치는 architecture.md 소유다.

```ts
interface ProjectLaunchReceiptRepository {
  find(key: ProjectLaunchKey): Promise<ProjectLaunchReceipt | null>;
  reserve(receipt: ProjectLaunchReceipt): Promise<{
    receipt: ProjectLaunchReceipt;
    created: boolean;
  }>;
  update(receipt: ProjectLaunchReceipt, expectedRevision: number): Promise<boolean>;
}
```

- `reserve`는 원자적 unique key 예약이다. 기존 같은 fingerprint가 있으면 `created:false`; 다른 fingerprint면 typed conflict. `created:true`인 호출만 처음 효과를 시작한다.
- `update`는 revision 비교 후 원자 갱신이다. `true`는 단조 증가 revision 반영, `false`는 경쟁 갱신이므로 먼저 다시 읽는다. receipt 소유 identity/key 변경은 금지한다.
- 영속 어댑터는 기존 단말 app-data의 권한·직렬화 관례를 따른다. 프로젝트 자체에 실행 receipt를 커밋하거나 Supabase에 원문을 동기화하지 않는다.

## 도메인 서비스와 경계

- `RemoteControlCore`: 세션 권한과 controlId 해석, 현재 프로젝트 카드·생성 결과의 전달. 기존 action fingerprint 정책(`src/remoteControlCore.ts:971-1016`)과 receipt 예약을 연결한다.
- `createAiTerminalRemoteGateway`: 현재 owner·동의·등록 대상 변환의 경계. 기존 terminal 프로토콜을 그대로 재사용한다.
- `AiTerminalService`: 실제 CLI 시작/출력/입력/종료 정본. UI의 연결 상태를 프로세스 상태로 오인하지 않는다.
- `CodexFirstConversationLaunchCoordinator`: 첫 대화 생성과 정확한 대화 다시 열기의 정본. 새 coordinator를 나란히 만들지 않는다.
- 대상 inventory는 실패 대체 서비스에서도 기존 `targets: listAgentRuntimeTargets`를 제공하므로(`api-server.ts:7656`) 새 target endpoint를 만들지 않는다. 새 orchestration은 이 경계의 얇은 연결로 한정한다. App.tsx와 api-server.ts에 새 상태 머신 전체를 직접 넣지 않는다.

## Bounded Context

| 경계 | 소유하는 것 | 다른 경계에 넘기는 것 |
|---|---|---|
| 등록 프로젝트 | Mac의 등록 행, main/worktree 실제 신원, 작업 루트 | 검증한 opaque 실행 대상 |
| 워크룸 | CLI 프로세스·PTY 세션·입출력·종료 | AiTerminalSummary와 cursor 기반 출력 |
| 원격 연결 | 인증·SAS·연결·현재 동의·취소 | 현재 요청의 authority; 실행 권한의 영구 복제본 없음 |
| Codex 앱 연결 | 정확한 프로젝트 첫 대화 준비·확인·다시 열기 | threadId와 확인된 단계 |
| 실행 결과 | 요청 중복 방지·부분 성공·확인 필요 | 현재 권한으로 필터링한 결과 요약 |
| 관리형 작업/읽기 전용 대화 | 기존 supervisor·격리 게이트·지속 대화 | 각각 독립적인 준비 상태 |

## 유비쿼터스 언어 용어집

| 사용자 용어 | 의미와 코드 정본 |
|---|---|
| Mac | 프로젝트 파일과 실제 실행이 있는 host. Vercel 화면 자체는 실행 호스트가 아니다. |
| 프로젝트 | 등록된 프로젝트. 이름은 표시이고 등록 ID와 실제 폴더 신원으로 식별한다. |
| 기본 폴더 | `main` 대상. 이미 선택한 branch 이름으로 다른 대상을 추정하지 않는다. |
| 워크트리 | 연결된 별도 Git checkout인 `worktree` 대상. |
| 워크룸에서 작업 | 기존 AiTerminalService의 CLI 작업 세션을 앱/웹 안에서 사용하는 것. |
| Codex 앱에서 처음 열기 | 선택한 프로젝트의 첫 대화를 준비해 Mac의 Codex 앱에서 연 뒤 사용자가 작업하는 것. |
| 기존 작업 이어가기 | 같은 Mac·대상·세션 ID의 현재 실행을 확인하여 다시 선택하는 것. |
| 이 기기에서 워크룸 작업 허용 | Mac·승인 기기·허용 프로젝트·유효기간에 묶인 별도 지속 권한. 유효한 같은 기기 재접속은 다시 승인할 필요가 없다. |
| 요청 보냄 / 시작 확인 / 확인 필요 | `requested / confirmed / unknown`의 사용자 표현. 내부 requestId·owner·fingerprint·capability를 UI에 노출하지 않는다. |
| 지속 대화 | 읽기 전용 retained conversation. 워크룸의 파일 작업 또는 CLI 세션과 같은 의미로 쓰지 않는다. |

## 성공 기준

1. Mac/Vercel 모두 프로젝트 생성 후 페이지 위치와 관계없이 생성된 바로 그 프로젝트가 선택되고 두 실행 선택이 나온다.
2. 같은 이름·같은 branch·main/worktree가 공존해도 선택한 실제 checkout만 실행된다. 등록 삭제·경로 교체 시 실패를 설명하며 다른 프로젝트로 바뀌지 않는다.
3. 워크룸 선택은 설치된 CLI의 실제 세션을 시작하고, 현재 대상·AI·실행 상태·입력과 종료가 사용 가능하다. 관리형 플래그를 켜지 않아도 작동한다.
4. Codex 앱 처음 열기는 정확한 프로젝트의 준비용 대화로 연결되고 사용자가 이후 앱에서 작업한다. 앱 열기 응답 유실/부분 실패에 새 대화가 반복 생성되지 않는다.
5. double click·동시 요청·timeout·브라우저 재접속·호스트 전환·sidecar 재시작은 중복 생성/실행으로 이어지지 않는다. 확인 못 한 실행은 `확인 필요`로 표시된다.
6. 일시 LAN/인터넷 끊김은 기존 작업을 끄지 않는다. 재접속은 동일 작업 identity를 찾고 유효 device grant와 현재 socket epoch를 재검증한다. 같은 기기는 다시 승인하지 않아도 이어지며, 새 pairing·만료·revoke에는 새 동의가 필요하다. revoke 후 지연 입력·출력은 전달되지 않는다.
7. Mac 오프라인·CLI 없음·로그인 필요·Codex 앱 없음·supervisor 복구 필요를 분리해 다음 행동을 보여준다. 일부 기능의 실패가 다른 준비된 기능을 숨기지 않는다.
8. iOS에서 프로젝트와 워크룸 탭 전환은 같은 Mac·승인 연결을 유지하고 새 QR을 요구하지 않는다. 인터넷 인증 후 앱 복귀와 E2EE 세션 복원은 실제 기기에서 확인한다.
9. Vercel 포털·원격 프로젝트·워크룸은 공통 색/글꼴/간격/버튼/대화상자/오류/내비게이션을 사용한다. Mac/웹의 밝은/어두운 테마와 320–430px 휴대폰, 1024/1440px 데스크톱·125% 배율에서 실제 상호작용을 확인한다. xterm ANSI 표시의 별도 어두운 역할 색은 허용한다.
10. 네이티브 bridge/probe 소스 존재를 설치본의 준비 완료로 간주하지 않는다. 실제 Mac + 배포 Vercel에서 각각 확인한 설치/버전/행동 증거를 구현 완료 조건으로 남긴다.

## 발견·가정·미해결 항목

| 항목 | severity | confidence | evidence / 판단 |
|---|---|---|---|
| 생성 결과 target 식별이 원격 응답에서 사라짐 | 높음 | 높음 | `api-server.ts:11880-11887`, `src/remoteControlCore.ts:1118-1127`. 첫 페이지 반환만으로는 생성 프로젝트의 정확한 후속 선택 불가. |
| 앱 화면 활성화와 OS 열기 요청 성공을 구분할 증거 필요 | 높음 | 높음 | `src/codexFirstConversationLaunch.ts:146-155`, `api-server.ts:12233`. openThread 호출 뒤 pending을 지우는 구조. 실제 설치본 화면 확인은 이번 도메인 조사에서 수행하지 않음. |
| 관리형 실행 flag를 켜는 해결은 성립하지 않음 | 높음 | 높음 | `src/agentRuntimeProtocol.ts:5-19`, `src/macOSRuntimeNativeClient.ts:47-55`. 별도 PTY 경로가 이미 존재. |
| supervisor 복구 필요가 실제 워크룸 전체 실패 원인이라는 주장 미확정 | 높음 | 높음 | 부모의 로컬 관측을 전달받았으나 직접 로그/lock을 검사하지 않음. source는 `api-server.ts:7703-7711`과 `:7737-7748` 경로 분리를 증명. 설치본 PTY는 별도 검증 필요. |
| LAN 재접속 문서가 소스와 불일치 | 중간 | 높음 | `docs/runtime-execution.md:31`의 QR 폐기 설명과 `src/remoteControlLanServer.ts:587-600`의 세션 보존 및 `:523-528`의 새 동의 principal이 다름. |
| 외부 Codex 최초 생성과 단순 앱 열기의 결과를 UI에서 혼동할 수 있음 | 중간 | 높음 | `src/App.tsx:12189-12208`, `src/remoteControlExternalLaunchRoute.ts:27-35`, `api-server.ts:12215-12233`. 두 경로 명시 필요. |
| durable receipt의 정리 시점과 action retry 수명 합의 필요 | 중간 | 중간 | 현재 core action 결과와 PTY request Map은 메모리 기반(`src/remoteControlCore.ts:1016`, `src/aiTerminalService.ts:109-110`). 재시작 뒤 실행 결과 미확정에 대한 유한 보존 정책 필요. |
| 신규 receipt owner와 현재 terminal consent owner의 분리 필수 | 높음 | 높음 | `src/remoteControlLanServer.ts:523-528`, `src/aiTerminalRemoteGateway.ts:5-13`. 새 연결 management ID를 무조건 안정화하면 과거 동의가 부활함. |

`briefing_correction`:
- 추가 반증: `api-server.ts:8237-8245`의 saveLastVisitData는 일반 저장 오류를 내부에서 처리한다. outer creation try 안에 호출된다는 이유로 lastVisit IO 실패가 이미 등록한 폴더 이동을 일으킨다고 단정할 수 없다. 부가 어댑터를 추출할 때 등록 완료를 보존하는 계약은 예방·회귀 요구로 유지한다.
- `src/aiTerminalRemote.ts`는 없으며 실제 정본은 `src/aiTerminalRemoteGateway.ts`다.
- LAN 정상 소켓 종료는 최신 소스에서 프로젝트 제어 세션을 보존한다. 현재 session-only 구현은 재접속한 연결의 터미널 동의가 다시 필요하다. 최종 계획은 별도로 허용한 유효 device grant로 이 반복을 제거한다.

최종 사용성 보강: QR 1회·30일 유효 연결은 grant 복원과 host 신뢰를 함께 설계해야 한다. 현재 LAN 주소 기반 저장만으로 주소 변경을 안전하게 처리한다고 주장하지 않는다(`src/remoteControlLanVault.ts:22-26`). Vercel 스타일의 별도 dark/mint 설정과 포털의 warm theme가 혼재하는 근거는 부모 조사(`src/remote-control-portal.css:1-11`, `src/index.css:10`, `src/portal-main.tsx:1674`)이며 공통 토큰·appAppearance 재사용 계획으로 해결한다.

자원·복구 성공 기준: 예산 도달 시 새 작업 수락을 제한하되 기존 read/close·철회·미확정 receipt 확인을 계속 제공한다. dead PID만으로 supervisor를 복구하지 않으며 검증한 boot epoch와 지원되는 격리 종료 증거가 있는 경로만 단일 소유권을 회복한다. legacy/manual의 증거 미확정 상태는 별도 확인 필요로 유지한다.
