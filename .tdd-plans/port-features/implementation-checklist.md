# 구현 체크리스트: 삭제 확인 팝업 + 포트별 메모 아코디언

## 환경 설정

- [ ] 작업 브랜치 생성 (`git checkout -b feature/delete-confirm-memo`)
- [ ] 개발 서버 확인 (`bun run tauri:dev`)

---

## Phase 1: DB 마이그레이션 (Supabase)

**실행 위치**: Supabase 대시보드 → SQL Editor

```sql
ALTER TABLE ports ADD COLUMN IF NOT EXISTS memo TEXT;
ALTER TABLE ports ADD COLUMN IF NOT EXISTS memo_updated_at TIMESTAMPTZ;
```

- [ ] SQL Editor에서 위 마이그레이션 실행
- [ ] `ports` 테이블 스키마 확인 (`memo`, `memo_updated_at` 컬럼 존재)
- [ ] RLS 정책 영향 없음 확인 (기존 anon 정책 유지)

**Phase 1 완료 기준**
- [ ] Supabase Table Editor에서 두 컬럼 확인 가능

---

## Phase 2: 상태 관리 (App.tsx)

**파일**: `src/App.tsx`

### 2-1. deleteConfirmId 상태

**🔴 RED: `deleteConfirmId` 상태 동작 검증**
- [ ] 🔴 RED: 삭제 버튼 클릭 시 즉시 삭제되지 않고 `deleteConfirmId`가 세팅되는지 확인용 콘솔 로그 추가
- [ ] 🟢 GREEN: `const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)` 추가
- [ ] 🟢 GREEN: `handleDeletePort(id)` 수정 — `setDeleteConfirmId(id)` 로 변경 (실제 삭제 제거)
- [ ] 🟢 GREEN: `handleConfirmDelete(id)` 함수 추가:
  ```ts
  const handleConfirmDelete = (id: string) => {
    setPorts(prev => prev.filter(p => p.id !== id));
    setDeleteConfirmId(null);
    // 기존 삭제 로직 (저장 포함)
  };
  ```
- [ ] 🔵 RFCT: `handleDeletePort` 이름 → `handleRequestDelete`로 변경 검토 (명확성)

### 2-2. memos 상태

**🔴 RED: `memos` 상태 및 저장 동작 검증**
- [ ] 🔴 RED: 메모 저장 후 상태가 올바르게 업데이트되는지 콘솔 확인
- [ ] 🟢 GREEN: `const [memos, setMemos] = useState<Record<string, { content: string; updatedAt: string }>>({})` 추가
- [ ] 🟢 GREEN: `handleSaveMemo(portId: string, content: string)` 함수 추가:
  ```ts
  const handleSaveMemo = (portId: string, content: string) => {
    setMemos(prev => ({
      ...prev,
      [portId]: { content, updatedAt: new Date().toISOString() }
    }));
  };
  ```
- [ ] 🔵 RFCT: `updatedAt`을 `new Date().toLocaleString('ko-KR')` vs ISO string — 저장은 ISO, 표시는 포맷팅으로 분리

**Phase 2 완료 기준**
- [ ] 삭제 버튼 클릭 시 즉시 삭제 안 되고 `deleteConfirmId` 세팅됨
- [ ] `handleSaveMemo` 호출 시 `memos` 상태 업데이트됨
- [ ] `handleConfirmDelete` 호출 시 포트 삭제 + `deleteConfirmId` 초기화됨

---

## Phase 3: DeleteConfirmModal 컴포넌트

**파일**: `src/components/DeleteConfirmModal.tsx` (신규)

### 3-1. 컴포넌트 기본 구조

**🔴 RED: 모달 렌더링 확인**
- [ ] 🔴 RED: `deleteConfirmId !== null` 일 때 모달이 화면에 표시되는지 수동 확인
- [ ] 🟢 GREEN: 컴포넌트 생성:
  ```tsx
  interface Props {
    portName: string;
    onConfirm: () => void;
    onCancel: () => void;
  }
  export function DeleteConfirmModal({ portName, onConfirm, onCancel }: Props)
  ```
- [ ] 🟢 GREEN: 오버레이 배경 (`fixed inset-0 bg-black/60 z-50`)
- [ ] 🟢 GREEN: 포트 이름 표시 (`"{portName}" 포트를 삭제하시겠습니까?`)
- [ ] 🟢 GREEN: 확인 버튼 (빨간색) + 취소 버튼

**🔴 RED: 배경 클릭 닫기 확인**
- [ ] 🔴 RED: 배경 클릭 시 `onCancel` 호출되는지 확인
- [ ] 🟢 GREEN: 오버레이 `onClick={onCancel}`, 모달 내부 `onClick={e => e.stopPropagation()}`
- [ ] 🔵 RFCT: `z-index` 레이어 충돌 없는지 확인 (기존 모달과 비교)

**🔴 RED: App.tsx 통합 확인**
- [ ] 🔴 RED: `deleteConfirmId`가 세팅되면 모달이 실제로 뜨는지 UI 확인
- [ ] 🟢 GREEN: App.tsx에 `<DeleteConfirmModal>` 조건부 렌더링 추가:
  ```tsx
  {deleteConfirmId && (
    <DeleteConfirmModal
      portName={ports.find(p => p.id === deleteConfirmId)?.name ?? ''}
      onConfirm={() => handleConfirmDelete(deleteConfirmId)}
      onCancel={() => setDeleteConfirmId(null)}
    />
  )}
  ```
- [ ] 🔵 RFCT: 다크 테마 스타일 통일 (`#18181b` 배경, white 텍스트)

**Phase 3 완료 기준**
- [ ] 삭제 버튼 → 모달 팝업 표시
- [ ] 확인 → 포트 삭제 + 모달 닫힘
- [ ] 취소 또는 배경 클릭 → 모달만 닫힘 (포트 유지)

---

## Phase 4: MemoAccordion 컴포넌트

**파일**: `src/components/MemoAccordion.tsx` (신규)

### 4-1. 아코디언 토글

**🔴 RED: 토글 동작 확인**
- [ ] 🔴 RED: 메모 버튼 클릭 시 textarea가 펼쳐지고 접히는지 확인
- [ ] 🟢 GREEN: 컴포넌트 생성:
  ```tsx
  interface Props {
    portId: string;
    memo?: { content: string; updatedAt: string };
    onSave: (portId: string, content: string) => void;
  }
  export function MemoAccordion({ portId, memo, onSave }: Props)
  ```
- [ ] 🟢 GREEN: `const [open, setOpen] = useState(false)` 로컬 상태
- [ ] 🟢 GREEN: 토글 버튼 (`메모 ▾` / `메모 ▴`)

### 4-2. 메모 입력 및 저장

**🔴 RED: 저장 후 updatedAt 표시 확인**
- [ ] 🔴 RED: 저장 버튼 클릭 후 수정 일시가 올바르게 갱신되는지 확인
- [ ] 🟢 GREEN: `const [draft, setDraft] = useState(memo?.content ?? '')` 로컬 draft 상태
- [ ] 🟢 GREEN: `<textarea>` (최소 3줄, 리사이즈 가능)
- [ ] 🟢 GREEN: 저장 버튼 → `onSave(portId, draft)` 호출
- [ ] 🟢 GREEN: 수정 일시 표시:
  ```tsx
  {memo?.updatedAt && (
    <span>{new Date(memo.updatedAt).toLocaleString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    })}</span>
  )}
  ```
- [ ] 🔵 RFCT: 저장 전 draft !== memo?.content 일 때만 저장 버튼 활성화 검토

**🔴 RED: App.tsx 통합 확인**
- [ ] 🔴 RED: 각 포트 카드에 `MemoAccordion` 렌더링 확인
- [ ] 🟢 GREEN: 포트 카드 내 `<MemoAccordion portId={p.id} memo={memos[p.id]} onSave={handleSaveMemo} />` 추가
- [ ] 🔵 RFCT: 아코디언 열릴 때 textarea에 자동 포커스 (`autoFocus` 또는 ref)

**Phase 4 완료 기준**
- [ ] 각 포트 카드에 메모 버튼 표시
- [ ] 클릭 시 textarea 펼쳐짐
- [ ] 저장 버튼 클릭 → `memos` 상태 업데이트 + 수정 일시 표시
- [ ] 다시 클릭 시 접힘 (내용 유지)

---

## Phase 5: Supabase 연동

**파일**: `src/App.tsx` — `handlePushToSupabase`, `handleRestoreFromSupabase`

### 5-1. Push (memo, memo_updated_at 포함)

**🔴 RED: Push 후 Supabase Table Editor에서 memo 컬럼 확인**
- [ ] 🔴 RED: Push 전 memo가 있는 포트의 `memo` 컬럼이 null인지 확인
- [ ] 🟢 GREEN: push 매핑에 `memo`, `memo_updated_at` 추가:
  ```ts
  const row = {
    id: p.id,
    name: p.name,
    port: p.port,
    command_path: p.commandPath ?? null,
    terminal_command: p.terminalCommand ?? null,
    folder_path: p.folderPath ?? null,
    deploy_url: p.deployUrl ?? null,
    github_url: p.githubUrl ?? null,
    device_id: deviceId,
    memo: memos[p.id]?.content ?? null,
    memo_updated_at: memos[p.id]?.updatedAt ?? null,
  };
  ```
- [ ] 🔴 RED: Push 후 Supabase에서 `memo` 컬럼 값 확인
- [ ] 🔵 RFCT: `check-supabase-columns` 커맨드로 컬럼 정합성 재검증

### 5-2. Pull (memo, memo_updated_at → memos 상태)

**🔴 RED: Pull 후 memos 상태 세팅 확인**
- [ ] 🔴 RED: Pull 전 `memos` 상태 비어있는지 확인
- [ ] 🟢 GREEN: Pull 후 `memos` 상태 재구성:
  ```ts
  const restoredMemos: Record<string, { content: string; updatedAt: string }> = {};
  data.forEach((row: any) => {
    if (row.memo) {
      restoredMemos[row.id] = {
        content: row.memo,
        updatedAt: row.memo_updated_at ?? new Date().toISOString(),
      };
    }
  });
  setMemos(restoredMemos);
  ```
- [ ] 🔴 RED: Pull 후 포트 카드에 기존 메모 내용이 복원되는지 UI 확인
- [ ] 🔵 RFCT: `portalConfigRef` staleness 패턴 주의 — push/pull 핸들러에서 최신 `memos` 스냅샷 사용 확인

**Phase 5 완료 기준**
- [ ] Push → Supabase `ports` 테이블 `memo`, `memo_updated_at` 컬럼에 데이터 저장
- [ ] Pull → `memos` 상태 복원 + UI 반영
- [ ] 기존 push 컬럼 (`worktree_path` 없음) 정합성 유지

---

## Phase 6: 통합 검증

### 6-1. 삭제 확인 팝업 E2E
- [ ] 포트 추가 → 삭제 버튼 클릭 → 모달 팝업 확인
- [ ] "취소" 클릭 → 포트 유지 확인
- [ ] "확인" 클릭 → 포트 삭제 + Toast 알림 확인
- [ ] 배경(오버레이) 클릭 → 모달 닫힘 확인

### 6-2. 메모 아코디언 E2E
- [ ] 포트 카드 → "메모" 버튼 클릭 → textarea 펼쳐짐
- [ ] 내용 입력 → "저장" 클릭 → 수정 일시 표시 (`YYYY-MM-DD HH:mm:ss` 형식)
- [ ] 다시 접기 → 다시 펼치기 → 내용 유지 확인
- [ ] Push → Pull → 메모 복원 확인

### 6-3. 회귀 테스트
- [ ] 기존 포트 실행/중지/강제재실행 정상 동작
- [ ] Supabase Push/Pull 기존 컬럼 데이터 정상
- [ ] Toast 알림 정상 동작
- [ ] 포트 정렬 정상 동작

---

## 최종 Definition of Done

- [ ] `deleteConfirmId` 상태로 삭제 확인 팝업 동작 완료
- [ ] `memos` 상태로 포트별 메모 저장/표시 완료
- [ ] `DeleteConfirmModal` 컴포넌트 — 배경 클릭 닫기 포함
- [ ] `MemoAccordion` 컴포넌트 — 수정 일시 `YYYY-MM-DD HH:mm:ss` 표시
- [ ] Supabase `memo`, `memo_updated_at` Push/Pull 연동
- [ ] `check-supabase-columns` 커맨드 통과 (허용되지 않은 컬럼 없음)
- [ ] 다크 테마 스타일 통일 (기존 디자인과 일관성)
- [ ] 회귀 테스트 통과 (기존 기능 정상)
- [ ] 커밋 후 `main` 브랜치 머지

---

## 빠른 시작 명령어

```bash
# 개발 서버 시작
bun run tauri:dev

# Supabase 컬럼 정합성 확인
# Claude Code에서: /check-supabase-columns

# 빌드 검증
bun run build
```
