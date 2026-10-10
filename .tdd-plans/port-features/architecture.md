# 아키텍처 설계: 삭제 확인 팝업 + 포트별 메모 아코디언

## 개요

두 기능 모두 `src/App.tsx` 단일 파일(4000+ 줄) 안에서 구현한다.
Clean Architecture 레이어를 엄격히 분리하는 대신, 기존 코드 패턴(useState + 인라인 핸들러 + JSX 컴포넌트 함수)을 그대로 따라 최소 변경 원칙을 적용한다.

핵심 결정:
- `DeleteConfirmModal`: 기존 `mergeConfirm` / `deleteWorktreeConfirm` 모달 패턴 재사용
- `MemoAccordion`: 기존 Toast/accordion 패턴 재사용, 별도 파일 추출 없음
- Supabase 컬럼 2개 추가 → Push/Pull 매핑 11개 컬럼으로 확장
- `memos` 상태는 `PortInfo` 내부가 아닌 별도 `Record` 상태로 관리 (단일책임)

---

## 레이어 구조

```
src/
└── App.tsx
    ├── [Domain] interface PortInfo           (line ~519)  ← memo 필드 추가 없음 (별도 상태)
    ├── [Domain] interface MemoState          (신규 타입)
    ├── [Application] deleteConfirmId state   (신규 useState)
    ├── [Application] memos state             (신규 useState)
    ├── [Application] handleDeleteConfirm()   (신규 핸들러)
    ├── [Application] handleSaveMemo()        (신규 핸들러)
    ├── [Adapter]  handlePushToSupabase()     (기존, memo 컬럼 추가)
    ├── [Adapter]  handleRestoreFromSupabase()(기존, memo 컬럼 읽기 추가)
    ├── [UI] DeleteConfirmModal component     (신규 인라인 컴포넌트)
    └── [UI] MemoAccordion component          (신규 인라인 컴포넌트)
```

---

## Domain Layer

### 신규 타입

```typescript
// App.tsx 상단 타입 선언부에 추가 (PortInfo 바로 아래)
interface MemoState {
  content: string;
  updatedAt: string; // ISO 8601
}
```

`PortInfo` 인터페이스는 변경하지 않는다.
메모 데이터는 `memos: Record<string, MemoState>` 상태로 분리 관리한다.

---

## Application Layer

### 신규 상태 (useState)

```typescript
const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
// null = 모달 닫힘, string = 삭제 대상 portId

const [memos, setMemos] = useState<Record<string, MemoState>>({});
// key: portId, value: { content, updatedAt }

const [openMemoIds, setOpenMemoIds] = useState<Set<string>>(new Set());
// 아코디언 열림 상태 (펼쳐진 portId 집합)
```

### Use Cases

| 유스케이스 | 트리거 | 입력 | 출력 | 사이드이펙트 |
|---|---|---|---|---|
| RequestDeletePort | 휴지통 버튼 클릭 | portId | `deleteConfirmId` 세팅 | 모달 표시 |
| ConfirmDeletePort | 모달 "확인" 클릭 | deleteConfirmId | ports 필터링 | 모달 닫힘 + auto-save |
| CancelDeletePort | 모달 "취소"/배경 클릭 | — | `deleteConfirmId = null` | 모달 닫힘 |
| ToggleMemoAccordion | 메모 버튼/헤더 클릭 | portId | `openMemoIds` 토글 | 아코디언 열림/닫힘 |
| SaveMemo | 저장 버튼 클릭 | portId, content | `memos` 업데이트 | `updatedAt` = now |

### 핸들러 시그니처

```typescript
// 삭제 확인 흐름
const requestDeletePort = (id: string) => setDeleteConfirmId(id);

const handleConfirmDelete = () => {
  if (!deleteConfirmId) return;
  setPorts(prev => prev.filter(p => p.id !== deleteConfirmId));
  setDeleteConfirmId(null);
  // auto-save는 기존 useEffect([ports]) 트리거로 처리
};

const handleCancelDelete = () => setDeleteConfirmId(null);

// 메모 저장
const handleSaveMemo = (portId: string, content: string) => {
  setMemos(prev => ({
    ...prev,
    [portId]: { content, updatedAt: new Date().toISOString() },
  }));
};

// 아코디언 토글
const toggleMemoAccordion = (portId: string) => {
  setOpenMemoIds(prev => {
    const next = new Set(prev);
    next.has(portId) ? next.delete(portId) : next.add(portId);
    return next;
  });
};
```

---

## Interface Adapters Layer

### Supabase Push 매핑 변경

`handlePushToSupabase` 내 `rows` 매핑 (기존 9개 → 11개 컬럼):

```typescript
const rows = ownedPorts.map(p => ({
  id: p.id,
  name: p.name,
  port: p.port ?? null,
  command_path: p.commandPath ?? null,
  terminal_command: p.terminalCommand ?? null,
  folder_path: p.folderPath ?? null,
  deploy_url: p.deployUrl ?? null,
  github_url: p.githubUrl ?? null,
  favorite: p.favorite ?? false,
  device_id: deviceId,
  device_name: deviceNameVal,
  // 신규 추가
  memo: memos[p.id]?.content ?? null,
  memo_updated_at: memos[p.id]?.updatedAt ?? null,
}));
```

### Supabase Pull 매핑 변경

`handleRestoreFromSupabase` 내 `remoteRows` 파싱 (line ~1193):

```typescript
const remoteRows: PortInfo[] = remoteData.map((row: any) => ({
  id: row.id,
  name: row.name,
  port: row.port,
  commandPath: row.command_path,
  terminalCommand: row.terminal_command,
  folderPath: row.folder_path,
  deployUrl: row.deploy_url,
  githubUrl: row.github_url,
  favorite: row.favorite ?? false,
  sourceDeviceId: row.device_id,
  // 신규: memo는 별도 memos 상태에 병합
}));

// Pull 후 memos 상태 업데이트
const pulledMemos: Record<string, MemoState> = {};
remoteData.forEach((row: any) => {
  if (row.memo != null) {
    pulledMemos[row.id] = {
      content: row.memo,
      updatedAt: row.memo_updated_at ?? new Date().toISOString(),
    };
  }
});
setMemos(prev => ({ ...prev, ...pulledMemos }));
```

---

## Infrastructure Layer

### DB 마이그레이션 SQL

```sql
ALTER TABLE ports ADD COLUMN IF NOT EXISTS memo TEXT;
ALTER TABLE ports ADD COLUMN IF NOT EXISTS memo_updated_at TIMESTAMPTZ;
```

### CLAUDE.md `ports` 테이블 push 컬럼 목록 업데이트

```
id, name, port, command_path, terminal_command, folder_path,
deploy_url, github_url, device_id, memo, memo_updated_at
(device_name은 upsert 포함되나 실제 컬럼 존재 여부 따라 fallback 처리)
```

---

## UI Components

### DeleteConfirmModal

```
props: {
  portName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

렌더링 조건: deleteConfirmId !== null
```

레이아웃 (기존 모달 패턴 동일):
```
fixed inset-0 bg-black/50 flex items-center justify-center z-50
  └─ div.bg-[#18181b] border border-zinc-700 rounded-xl p-6 w-80
       ├─ h3 "포트 삭제"
       ├─ p  "'{portName}'을(를) 삭제하시겠습니까?"
       └─ div.flex.gap-3.mt-4
            ├─ button "취소" → onCancel (bg-zinc-800)
            └─ button "삭제" → onConfirm (bg-red-600 hover:bg-red-700)
```

### MemoAccordion

```
props: {
  portId: string;
  isOpen: boolean;
  memo: MemoState | undefined;
  onToggle: () => void;
  onSave: (content: string) => void;
}
```

레이아웃 (포트 카드 하단에 삽입):
```
div.border-t.border-zinc-800
  ├─ button.flex.items-center.gap-1.text-xs (토글 버튼)
  │    ├─ ChevronDown/ChevronUp 아이콘
  │    └─ "메모" + (memo?.updatedAt → 날짜 표시)
  └─ [isOpen] div.p-2
       ├─ textarea.w-full.bg-zinc-900.text-zinc-300.text-xs.rounded.p-2
       │    (defaultValue=memo?.content, rows=3)
       └─ div.flex.justify-between.items-center.mt-1
            ├─ span.text-zinc-600.text-xs (수정일시)
            └─ button "저장" → onSave(textarea.value) (bg-blue-600)
```

---

## 아키텍처 결정사항 (ADR)

| 결정 | 선택 | 이유 |
|---|---|---|
| memo 상태 분리 | `Record<string, MemoState>` 별도 useState | PortInfo Pull 로직과 memo Pull 로직 분리, SRP 적용 |
| 컴포넌트 위치 | App.tsx 인라인 함수 컴포넌트 | 기존 4000줄 파일 패턴 유지, 파일 분리 시 import 체인 복잡도 증가 |
| 삭제 상태 | `string \| null` (portId) | 기존 `deleteWorktreeConfirm` 패턴과 동일, boolean 대신 id 저장으로 portName 표시 가능 |
| memo_updated_at | TIMESTAMPTZ (ISO string) | 다기기 동기화 시 최신 메모 우선 병합 가능 (향후 conflict 해결 기반) |
| Pull 후 memos 병합 | `prev => ({ ...prev, ...pulledMemos })` | 로컬 미저장 메모 유지, remote가 존재하는 portId만 덮어씀 |

---

## SOLID 체크리스트

- [x] SRP: `DeleteConfirmModal`은 확인/취소만, `MemoAccordion`은 메모 표시/편집만 담당
- [x] OCP: 기존 `handleDeletePort` 직접 호출 제거 → `requestDeletePort`로 교체, 기존 삭제 로직 수정 없음
- [x] LSP: `MemoAccordion`에 `memo: MemoState | undefined` 전달 — undefined 시 빈 상태로 표시
- [x] ISP: `MemoAccordion`은 memo 관련 props만, `DeleteConfirmModal`은 삭제 관련 props만 수신
- [x] DIP: 컴포넌트는 handler 함수(인터페이스 역할)에만 의존 — Supabase 직접 참조 없음
