# 도메인 분석: 삭제 확인 팝업 + 포트별 메모 아코디언

## 개요

포트 관리기(Tauri + React)에 두 가지 UX 개선 기능을 추가한다.

1. **삭제 확인 팝업**: 현재 `handleDeletePort(id)`는 즉시 삭제. 실수 방지를 위한 확인 대화상자 도입.
2. **포트별 메모 아코디언**: 포트 카드에 접이식 메모 입력 영역 추가. 내용과 최종 수정 일시를 Supabase `ports` 테이블과 동기화.

---

## 액터 (Actors)

| 액터 | 역할 | 유스케이스 |
|------|------|-----------|
| User | 포트 관리 앱 사용자 | 포트 삭제 요청, 삭제 확인/취소 |
| User | 포트 관리 앱 사용자 | 메모 아코디언 열기/닫기, 메모 저장 |
| Supabase | 외부 영속성 서비스 | 메모 Push/Pull 동기화 |

---

## 유스케이스 목록

### Feature 1: 삭제 확인 팝업

1. **RequestDelete** — 사용자가 삭제 버튼을 클릭한다.
   - 선행조건: 포트가 목록에 존재한다.
   - 주요 흐름: 삭제 버튼 클릭 → ConfirmationState가 `confirming`으로 전환 → 팝업에 포트명 표시
   - 예외 흐름: 해당 portId가 없으면 조용히 무시

2. **ConfirmDelete** — 사용자가 팝업에서 "삭제" 버튼을 누른다.
   - 선행조건: ConfirmationState === `confirming`
   - 주요 흐름: `deleting` 전환 → `handleDeletePort(id)` 실행 → `idle` 복귀 → 포트 목록 갱신
   - 예외 흐름: 삭제 중 에러 발생 → Toast 에러 알림 → `idle` 복귀

3. **CancelDelete** — 사용자가 팝업에서 "취소" 버튼 또는 ESC를 누른다.
   - 선행조건: ConfirmationState === `confirming`
   - 주요 흐름: `idle` 복귀 → 팝업 닫힘 → 포트 목록 변경 없음

### Feature 2: 포트별 메모 아코디언

4. **OpenMemoAccordion** — 사용자가 포트 카드의 메모 토글 버튼을 클릭한다.
   - 선행조건: 포트가 목록에 존재한다.
   - 주요 흐름: 해당 portId의 아코디언 열기 → 저장된 메모 내용 및 수정 일시분초 표시
   - 예외 흐름: 메모 없음 → 빈 textarea 표시

5. **SaveMemo** — 사용자가 메모를 입력 후 "저장" 버튼을 클릭하거나 포커스를 잃는다.
   - 선행조건: 아코디언이 열린 상태
   - 주요 흐름: content + updatedAt 갱신 → 로컬 상태 업데이트 → ports.json 저장
   - 예외 흐름: 내용 변경 없음 → 저장 스킵

6. **SyncMemoToSupabase** — 사용자가 Supabase Push를 실행한다.
   - 선행조건: Supabase credentials 설정됨
   - 주요 흐름: `memo` + `memo_updated_at` 컬럼을 포함한 upsert 실행
   - 예외 흐름: 네트워크 오류 → Toast 에러 알림

7. **PullMemoFromSupabase** — 사용자가 Supabase Pull을 실행한다.
   - 선행조건: Supabase credentials 설정됨, `device_id` 필터 적용
   - 주요 흐름: `memo` + `memo_updated_at` 수신 → 로컬 상태 + ports.json 갱신
   - 예외 흐름: Pull 결과에 해당 포트 없음 → 기존 메모 유지

---

## 도메인 모델

### Aggregate: DeleteConfirmation

이 Aggregate는 단일 삭제 요청의 생명주기를 관리한다.  
앱 전체에 하나의 인스턴스만 존재 (동시에 한 포트만 삭제 요청 가능).

**Value Object: `DeleteTarget`**
- `portId`: `string` — 삭제 대상 포트 식별자
- `portName`: `string` — 확인 팝업에 표시할 포트 이름
- 불변식: `portId`는 비어있을 수 없다. `portName`은 비어있을 수 없다.

**Value Object: `ConfirmationState`**
```typescript
type ConfirmationState = 'idle' | 'confirming' | 'deleting'
```
- `idle`: 삭제 요청 없음
- `confirming`: 팝업 표시 중, 사용자 응답 대기
- `deleting`: 삭제 실행 중 (버튼 비활성화)

**State Transition Rules (불변식)**
- `idle` → `confirming`: RequestDelete 시
- `confirming` → `deleting`: ConfirmDelete 시
- `confirming` → `idle`: CancelDelete 시
- `deleting` → `idle`: 삭제 완료 또는 에러 시

**Repository Interface**
```typescript
// 이 Aggregate는 메모리 전용 (영속성 불필요)
// React state로 관리: useState<{ state: ConfirmationState; target: DeleteTarget | null }>
```

---

### Aggregate: PortMemo

포트별 메모를 관리하는 Aggregate. `PortInfo` Aggregate의 속성 확장으로 구현.

**Root Entity: `PortInfo` (기존 확장)**
- 기존 필드: `id`, `name`, `port`, `commandPath`, `folderPath`, `isRunning`
- **신규 추가**:
  - `memo`: `string | undefined` — 메모 텍스트 (최대 2000자 권장)
  - `memoUpdatedAt`: `string | undefined` — ISO 8601 타임스탬프 (초 단위 표시)

**Value Object: `MemoContent`**
```typescript
interface MemoContent {
  text: string          // 실제 메모 내용
  updatedAt: Date       // 최종 수정 일시
}
```
- 불변식: `updatedAt`은 항상 현재 시각 이후일 수 없다 (미래 날짜 금지)
- `text`가 빈 문자열이면 `updatedAt` 갱신 스킵

**Domain Events**
- `MemoSaved`: 메모가 저장될 때 발행
  - 페이로드: `{ portId: string, content: string, updatedAt: string }`
- `MemoSyncedToSupabase`: Supabase Push 완료 시 발행
  - 페이로드: `{ portIds: string[], syncedAt: string }`

**Repository Interface**
```typescript
interface PortRepository {
  findAll(): Promise<PortInfo[]>
  findById(id: string): Promise<PortInfo | null>
  save(port: PortInfo): Promise<void>      // memo + memoUpdatedAt 포함
  saveAll(ports: PortInfo[]): Promise<void>
  // Supabase 확장
  pushToRemote(ports: PortInfo[], deviceId: string): Promise<void>
  pullFromRemote(deviceId: string): Promise<PortInfo[]>
}
```

---

## Supabase 스키마 변경

### `ports` 테이블 컬럼 추가

```sql
ALTER TABLE ports ADD COLUMN memo TEXT;
ALTER TABLE ports ADD COLUMN memo_updated_at TIMESTAMPTZ;
```

### Push 매핑 업데이트 (기존 + 신규)

```typescript
// api-server.ts 또는 App.tsx Push 핸들러
const row = {
  id, name, port, command_path, terminal_command,
  folder_path, deploy_url, github_url, device_id,
  memo: port.memo ?? null,                          // 신규
  memo_updated_at: port.memoUpdatedAt ?? null       // 신규
}
```

> **주의**: `worktree_path`, `ai_name`, `category`, `description` 컬럼 없음 — push 객체에 포함 금지 (400 에러 원인)

---

## UI 컴포넌트 설계

### DeleteConfirmModal

```
[팝업 오버레이]
  ┌─────────────────────────────┐
  │  ⚠️  포트 삭제              │
  │                             │
  │  "[portName]" 포트를        │
  │  삭제하시겠습니까?           │
  │  이 작업은 되돌릴 수 없습니다│
  │                             │
  │  [취소]      [삭제]         │
  └─────────────────────────────┘
```

- 상태 `confirming`일 때만 렌더링
- `deleting` 상태: "삭제" 버튼 로딩 스피너 + disabled
- ESC 키: CancelDelete 트리거
- 오버레이 클릭: CancelDelete 트리거

### MemoAccordion

```
[포트 카드 하단]
  ┌──────────────────────────────────────┐
  │  [메모 ▼]                            │
  ├──────────────────────────────────────┤
  │  ┌────────────────────────────────┐  │
  │  │ textarea (placeholder: 메모)   │  │
  │  └────────────────────────────────┘  │
  │  최종 수정: 2026-04-19 14:23:05  [저장] │
  └──────────────────────────────────────┘
```

- `expanded`: boolean — 아코디언 열림 상태 (portId별 Map으로 관리)
- 저장 트리거: "저장" 버튼 클릭 OR `onBlur` (선택)
- 수정 일시: `YYYY-MM-DD HH:mm:ss` 형식으로 표시

---

## 도메인 서비스

- **`MemoTimestampService`**: 메모 저장 시 현재 시각을 ISO 8601로 반환
  - 역할: `new Date().toISOString()` — 단순하지만 테스트 가능성을 위해 분리
  - 위치: `src/domain/MemoTimestampService.ts`

- **`DeleteConfirmationService`**: ConfirmationState 전환 로직 캡슐화
  - 역할: 상태 전환 유효성 검사 + 다음 상태 반환
  - 위치: `src/domain/DeleteConfirmationService.ts`

---

## Bounded Context

- **포트 관리 컨텍스트**: `PortInfo`, `PortMemo`, `DeleteConfirmation`, 모든 유스케이스
- **동기화 컨텍스트**: Supabase Push/Pull — Anti-corruption Layer 역할: `api-server.ts`의 Push/Pull 핸들러가 도메인 객체 ↔ DB row 변환 담당

컨텍스트 관계: **Customer-Supplier** (포트 관리 → Supabase)

---

## 유비쿼터스 언어 용어집

| 용어 | 의미 |
|------|------|
| Port (포트) | 로컬 개발 서버를 식별하는 단위. 번호 + 프로젝트명 + 실행 파일 경로로 구성 |
| DeleteConfirmation | 포트 삭제 전 사용자에게 의도를 재확인하는 상호작용 흐름 |
| DeleteTarget | 삭제 대상 포트의 식별 정보 (id + name) |
| ConfirmationState | 삭제 확인 팝업의 현재 상태 (idle/confirming/deleting) |
| Memo | 포트에 부착된 자유형 텍스트 메모 |
| MemoAccordion | 포트 카드에서 메모를 접고 펼칠 수 있는 UI 컴포넌트 |
| MemoUpdatedAt | 메모가 마지막으로 저장된 일시분초 |
| Push | 로컬 포트 데이터를 Supabase에 업서트하는 동기화 방향 |
| Pull | Supabase에서 로컬로 포트 데이터를 복원하는 동기화 방향 |
| DeviceId | 기기별 데이터 격리를 위한 UUID. `portal.json`에 영속 저장 |
