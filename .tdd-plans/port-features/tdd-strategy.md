# TDD 전략: 삭제 확인 팝업 + 포트별 메모 아코디언

## 개요

Tauri 2 + React 환경에서 두 기능을 Inside-Out(Value → State → UI) 순서로 TDD를 적용한다.
- **삭제 확인 팝업**: `deleteConfirmId` 상태 머신 중심 단위 테스트
- **메모 아코디언**: `memos` 상태 관리 + Supabase 연동 테스트

테스트 더블 전략: Supabase 클라이언트는 Mock, 순수 상태 변환 로직은 Real.

---

## 테스트 피라미드 분포

- Unit 테스트: 12개
- Integration 테스트: 4개
- E2E 테스트: 0개 (Tauri 환경 제약)

---

## Mock/Fake 전략

| 의존성 | 전략 | 이유 |
|--------|------|------|
| Supabase 클라이언트 | Mock (jest.fn / bun:test mock) | 외부 I/O — 격리 필수 |
| `Date.now()` / `new Date()` | Stub (고정 시각 주입) | 시간 의존 필드(`updatedAt`) 결정론적 검증 |
| React 컴포넌트 렌더링 | @testing-library/react (실제 렌더) | 상태 → UI 연결 검증 |
| Tauri `invoke` | Mock | 데스크탑 API — 테스트 환경에서 미지원 |

---

## 테스트 케이스 목록 (TDD 실행 순서)

### Phase 1: 순수 상태 변환 — 삭제 확인 상태 머신

#### deleteConfirmId 상태 테스트

**테스트 1: `deleteConfirmId_trashButtonClick_setsPortId`**
```
Given: deleteConfirmId = null, ports 배열에 id='port-1' 포트 존재
When:  port-1 카드의 휴지통 버튼 클릭 이벤트 발생 (setDeleteConfirmId('port-1') 호출)
Then:  deleteConfirmId === 'port-1'
```
> 구현 힌트: `useState<string | null>(null)` + setter 직접 호출 단위 테스트

**테스트 2: `deleteConfirmId_cancelButton_resetsToNull`**
```
Given: deleteConfirmId = 'port-1' (모달 열린 상태)
When:  취소 버튼 클릭 (setDeleteConfirmId(null) 호출)
Then:  deleteConfirmId === null
```

**테스트 3: `deleteConfirmId_confirmButton_removesPortAndResetsId`**
```
Given: ports = [{id:'port-1',...}, {id:'port-2',...}], deleteConfirmId = 'port-1'
When:  확인 버튼 클릭 → handleDeletePort('port-1') 실행
Then:  ports 배열에서 id='port-1' 제거됨, deleteConfirmId === null
```
> 구현 힌트: `setPorts(prev => prev.filter(p => p.id !== id))` 후 `setDeleteConfirmId(null)`

**테스트 4: `deleteConfirmId_outsideClick_resetsToNull`**
```
Given: deleteConfirmId = 'port-1' (모달 오버레이 표시)
When:  모달 외부 오버레이 클릭 (onClose 핸들러 실행)
Then:  deleteConfirmId === null  (취소와 동일 결과)
```

---

### Phase 2: 순수 상태 변환 — 메모 상태

#### memos 상태 관리 테스트

**테스트 5: `memoAccordion_toggleClick_showsTextarea`**
```
Given: expandedMemoId = null (모든 아코디언 닫힘)
When:  port-1 메모 토글 클릭 (setExpandedMemoId('port-1'))
Then:  expandedMemoId === 'port-1'  → textarea 표시됨
```

**테스트 6: `memoAccordion_toggleClickAgain_hidesTextarea`**
```
Given: expandedMemoId = 'port-1' (아코디언 열림)
When:  동일 토글 재클릭 (setExpandedMemoId(null))
Then:  expandedMemoId === null  → textarea 숨김
```

**테스트 7: `saveMemo_updatesContentAndTimestamp`**
```
Given: memos = {}, portId = 'port-1', now = new Date('2026-04-19T10:00:00')
When:  saveMemo('port-1', '테스트 메모') 실행 (Date 스텁 적용)
Then:  memos['port-1'].content === '테스트 메모'
       memos['port-1'].updatedAt === '2026-04-19 10:00:00'
```
> 구현 힌트: `updatedAt` 포맷: `YYYY-MM-DD HH:mm:ss` (패드 없이 `String(d.getSeconds()).padStart(2,'0')`)

**테스트 8: `formatUpdatedAt_validDate_returnsCorrectFormat`**
```
Given: date = new Date('2026-04-19T08:05:03')
When:  formatUpdatedAt(date) 호출
Then:  '2026-04-19 08:05:03' 반환  (월/일/시/분/초 2자리 패딩)
```
> 구현 힌트: 순수 함수로 추출 → 단위 테스트 용이

---

### Phase 3: Supabase 연동 — Pull (메모 복원)

**테스트 9: `pull_supabaseHasMemo_reflectsInMemosState`**
```
Given: Supabase mock → ports 테이블에 {id:'port-1', memo:'내용', memo_updated_at:'2026-04-19 09:00:00'} 반환
When:  handleRestoreFromSupabase() 실행
Then:  memos['port-1'].content === '내용'
       memos['port-1'].updatedAt === '2026-04-19 09:00:00'
```
> 구현 힌트: Pull 응답 매핑 `row.memo → memos[row.id]` 변환 로직 검증

**테스트 10: `pull_supabaseNoMemo_memosRemainEmpty`**
```
Given: Supabase mock → memo = null, memo_updated_at = null
When:  handleRestoreFromSupabase() 실행
Then:  memos['port-1'] === undefined  (또는 content = '')
```

---

### Phase 4: Supabase 연동 — Push (메모 저장)

**테스트 11: `push_portWithMemo_upsertsMemoColumns`**
```
Given: ports = [{id:'port-1', name:'앱'}], memos = {'port-1': {content:'메모', updatedAt:'2026-04-19 10:00:00'}}
       Supabase mock: upsert() → {data: [], error: null}
When:  handlePushToSupabase() 실행
Then:  supabase.from('ports').upsert 호출됨
       호출 인자에 {id:'port-1', memo:'메모', memo_updated_at:'2026-04-19 10:00:00'} 포함
```

**테스트 12: `push_portWithoutMemo_upsertsMemoAsNull`**
```
Given: ports = [{id:'port-2', name:'서버'}], memos = {} (port-2 메모 없음)
When:  handlePushToSupabase() 실행
Then:  upsert 인자에 {id:'port-2', memo: null, memo_updated_at: null} 포함
```

---

### Phase 5: UI 통합 — React 컴포넌트 렌더링 (Integration)

**테스트 13: `DeleteConfirmModal_rendersWhenDeleteConfirmIdSet`**
```
Given: deleteConfirmId = 'port-1' 상태로 컴포넌트 렌더링
When:  DOM 확인
Then:  '정말 삭제하시겠습니까?' (또는 확인 메시지) 텍스트가 DOM에 존재
       취소/확인 버튼이 각각 render됨
```

**테스트 14: `DeleteConfirmModal_notRenderedWhenNull`**
```
Given: deleteConfirmId = null
When:  DOM 확인
Then:  삭제 확인 모달 요소가 DOM에 없음
```

**테스트 15: `MemoAccordion_textareaVisibleWhenExpanded`**
```
Given: expandedMemoId = 'port-1'로 컴포넌트 렌더링
When:  DOM 확인
Then:  port-1 카드 내 textarea 요소가 visible (display !== 'none')
       다른 포트 카드의 textarea는 없거나 hidden
```

**테스트 16: `MemoAccordion_updatedAtDisplayFormat`**
```
Given: memos = {'port-1': {content:'메모', updatedAt:'2026-04-19 10:00:00'}}, expandedMemoId = 'port-1'
When:  DOM 확인
Then:  '2026-04-19 10:00:00' 텍스트가 메모 영역에 표시됨
```

---

## 엣지 케이스 목록

| 케이스 | 설명 | 예상 동작 |
|--------|------|---------|
| 빈 메모 저장 | content = '' 로 저장 | updatedAt 갱신, content = '' 허용 |
| Pull 시 memo_updated_at null | DB에 날짜 없음 | updatedAt = '' 또는 미표시 |
| 여러 포트 동시 메모 | port-1, port-2 각각 메모 | memos 객체에 각 키로 독립 저장 |
| 삭제 후 메모 잔존 | port-1 삭제 후 memos['port-1'] | 삭제 시 memos에서도 해당 키 제거 권장 |
| 모달 ESC 키 | 키보드 ESC 입력 | deleteConfirmId = null (취소와 동일) |
| Push 시 device_id 스코프 | 메모 upsert에도 device_id 포함 | ports push와 동일한 device_id 적용 |

---

## 테스트 데이터 전략

| 타입 | 유효한 예시 | 유효하지 않은 예시 |
|------|-----------|----------------|
| portId | `'port-abc123'`, `crypto.randomUUID()` | `''`, `null`, `undefined` |
| memo content | `'배포 시 npm run build 필요'`, `''` | — (빈 문자열 허용) |
| updatedAt | `'2026-04-19 10:00:00'` | `'2026-4-19'`, ISO 8601 형식 (DB와 불일치) |
| deleteConfirmId | `'port-abc123'` \| `null` | 다른 타입 |

---

## Supabase 스키마 변경 (필수 선행)

```sql
-- ports 테이블에 메모 컬럼 추가
ALTER TABLE ports ADD COLUMN memo text;
ALTER TABLE ports ADD COLUMN memo_updated_at text;
```

Push 매핑 추가 (CLAUDE.md `ports` 테이블 push 컬럼 목록에 반영):
```
id, name, port, command_path, terminal_command, folder_path,
deploy_url, github_url, device_id, memo, memo_updated_at
```
