# PLAN: 삭제 확인 팝업 + 포트별 메모 아코디언

## Executive Summary

| 관점 | 내용 |
|---|---|
| 문제 | 삭제가 즉시 실행되어 실수 복구 불가. 포트별 메모 기능 없어 프로젝트 맥락 기록 불가 |
| 해결 | 삭제 시 확인 팝업 + 포트 카드 아코디언 메모 (Supabase Push/Pull 연동) |
| UX 효과 | 실수 삭제 방지 + 포트별 런타임 메모로 팀 협업 품질 향상 |
| 핵심 가치 | 2개 상태(deleteConfirmId, memos) + 2개 컴포넌트 추가, 기존 코드 최소 변경 |

## 구현 순서 (Inside-Out)

### Step 0: DB 마이그레이션 (Supabase SQL Editor에서 실행)
```sql
ALTER TABLE ports ADD COLUMN IF NOT EXISTS memo TEXT;
ALTER TABLE ports ADD COLUMN IF NOT EXISTS memo_updated_at TIMESTAMPTZ;
```

### Step 1: App.tsx 상태 추가
- `deleteConfirmId: string | null`
- `memos: Record<string, { content: string; updatedAt: string }>`
- `handleDeletePort` → `setDeleteConfirmId(id)` (즉시 삭제 제거)
- `handleConfirmDelete(id)` 추가
- `handleSaveMemo(portId, content)` 추가

### Step 2: DeleteConfirmModal 컴포넌트 (App.tsx 인라인)
- `deleteConfirmId !== null` 시 렌더
- 포트 이름 표시, 확인(빨강)/취소 버튼
- 오버레이 클릭 = 취소

### Step 3: MemoAccordion 컴포넌트 (App.tsx 인라인)
- 포트 카드 하단에 삽입
- 로컬 open 상태, textarea draft
- 저장 버튼 → onSave → updatedAt 갱신
- 수정 일시 `YYYY-MM-DD HH:mm:ss` 표시

### Step 4: Supabase Push/Pull 연동
- Push: `memo`, `memo_updated_at` 컬럼 추가
- Pull: `row.memo` → `memos` 상태 복원

## 파일 변경 범위
| 파일 | 변경 |
|---|---|
| `src/App.tsx` | 상태 2개, 핸들러 3개, 컴포넌트 2개, Push/Pull 매핑 |
| Supabase DB | `memo`, `memo_updated_at` 컬럼 추가 |
| `CLAUDE.md` | push 컬럼 목록 업데이트 |
