# Portal Feature Design Document

## Executive Summary

| | |
|---|---|
| **Feature** | Portal — 웹사이트 & 로컬폴더 북마크 관리자 |
| **Phase** | Design (retroactive) |
| **Date** | 2026-03-22 |

### Value Delivered

| Perspective | Content |
|---|---|
| **Problem** | 자주 방문하는 웹사이트와 로컬 폴더를 매번 수동으로 찾아야 하는 비효율 |
| **Solution** | 카테고리별로 분류된 북마크 관리자 — 원클릭 접근, Supabase 클라우드 동기화 |
| **Function UX Effect** | 탭 전환으로 포털 진입, 좌측 카테고리 레일 + 카드 그리드로 직관적 탐색 |
| **Core Value** | 개발자의 일상 워크플로우를 단일 앱 안에서 완결 — 서버 관리 + 빠른 진입점 통합 |

---

## 1. 요구사항

### 1.1 핵심 기능

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| R1 | 웹사이트 URL 북마크 추가/수정/삭제 | Must |
| R2 | 로컬 폴더 경로 북마크 추가/수정/삭제 | Must |
| R3 | 카테고리별 분류 (커스텀 카테고리 생성/삭제) | Must |
| R4 | 고정(Pin) 기능 — 자주 사용하는 항목 상단 노출 | Must |
| R5 | 검색 필터 — 이름/설명/URL/경로 전체 검색 | Must |
| R6 | JSON 내보내기/불러오기 (로컬 백업) | Must |
| R7 | Supabase 동기화 (클라우드 적재) | Must |
| R8 | 방문 횟수 추적 (visitCount) | Should |
| R9 | Tauri 폴더 피커 (Browse 버튼) | Should |
| R10 | 탭 전환 — 기존 포트 관리 탭과 공존 | Must |

### 1.2 데이터 모델

```typescript
interface PortalItem {
  id: string;            // 고유 ID
  name: string;          // 표시 이름
  type: 'web' | 'folder'; // 항목 유형
  url?: string;          // 웹사이트 URL
  path?: string;         // 로컬 폴더 경로
  category: string;      // 카테고리 ID 참조
  description?: string;  // 선택 설명
  pinned: boolean;       // 고정 여부
  visitCount: number;    // 방문 횟수
  lastVisited?: string;  // 마지막 방문 ISO 날짜
  createdAt: string;     // 생성일 ISO 날짜
}

interface PortalCategory {
  id: string;     // 고유 ID
  name: string;   // 카테고리 이름
  color: ColorKey; // 색상 테마
  order: number;  // 정렬 순서
}

interface PortalData {
  items: PortalItem[];
  categories: PortalCategory[];
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  deviceId?: string;
  lastSynced?: string;
}
```

---

## 2. 아키텍처

### 2.1 컴포넌트 구조

```
App.tsx
  └── [탭 네비게이션] activeTab: 'ports' | 'portal'
        ├── 기존 포트 관리 (activeTab === 'ports')
        └── PortalManager (activeTab === 'portal')
              ├── Left Sidebar (카테고리 목록)
              ├── Top Bar (검색 + 액션 버튼)
              ├── ItemCard Grid (북마크 카드)
              ├── ItemModal (추가/수정 모달)
              ├── CategoryModal (카테고리 추가 모달)
              └── SettingsModal (Supabase 설정 모달)
```

### 2.2 데이터 흐름

```
[브라우저/Tauri 앱]
      ↓ load
  GET /api/portal  →  ~/Library/.../portal.json
      ↓ save
  POST /api/portal →  ~/Library/.../portal.json
      ↓ sync (선택)
  Supabase REST API → portal_items / portal_categories 테이블
```

### 2.3 API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/portal` | portal.json 로드 |
| POST | `/api/portal` | portal.json 저장 |

기존 Tauri 커맨드 재사용:
- `open_in_chrome(url)` — 웹 URL 열기
- `open_folder(folderPath)` — 폴더 열기
- `@tauri-apps/plugin-dialog` `open()` — 폴더 피커

---

## 3. UI 설계

### 3.1 탭 네비게이션

- 위치: `max-w-4xl` 컨테이너 최상단
- 스타일: `bg-[#18181b] border border-zinc-800 rounded-xl p-1`
- 탭: 프로젝트 관리 (Server 아이콘) | 포털 (BookMarked 아이콘)

### 3.2 포털 레이아웃

```
┌──────────────────────────────────────────────────────┐
│  [검색........]  [+추가] [☁동기화] [↓] [↑] [⚙]      │
├─────────────┬────────────────────────────────────────┤
│ 전체 (12)   │  ★ 고정됨                              │
│             │  ┌────┐ ┌────┐                         │
│ ● AI (4)    │  │Card│ │Card│                         │
│ ● 개발 (3)  │  └────┘ └────┘                         │
│ ● 업무 (2)  │                                        │
│ ● 폴더 (2)  │  ● AI 도구 (4)                         │
│ ● 기타 (1)  │  ┌────┐ ┌────┐ ┌────┐                 │
│             │  │    │ │    │ │    │                 │
│ + 카테고리  │  └────┘ └────┘ └────┘                 │
└─────────────┴────────────────────────────────────────┘
```

### 3.3 ItemCard 구조

- 헤더: 아이콘(web=Globe/folder=Folder) + 이름 + Pin 뱃지
- URL/경로 미리보기 (truncate)
- 호버 시 액션 버튼 표시: [열기 | Pin | 수정 | 삭제]
- 방문 횟수 배지 (우상단, visitCount > 0 시)

### 3.4 색상 시스템

10가지 색상 지원: blue, green, purple, amber, rose, cyan, orange, teal, indigo, pink
각 색상: `bg-{color}-500/10`, `text-{color}-400`, `border-{color}-500/30`, `bg-{color}-500` (dot)

---

## 4. 기본 카테고리

| ID | 이름 | 색상 | 순서 |
|----|------|------|------|
| cat-ai | AI 도구 | purple | 0 |
| cat-dev | 개발 | blue | 1 |
| cat-work | 업무 | green | 2 |
| cat-folder | 폴더 | amber | 3 |
| cat-misc | 기타 | teal | 4 |

---

## 5. Supabase 스키마

```sql
create table if not exists portal_items (
  id text primary key,
  device_id text,
  name text not null,
  type text not null,
  url text,
  path text,
  category text,
  description text,
  pinned boolean default false,
  visit_count integer default 0,
  last_visited text,
  created_at text,
  updated_at timestamptz default now()
);

create table if not exists portal_categories (
  id text primary key,
  device_id text,
  name text not null,
  color text not null,
  "order" integer default 0,
  updated_at timestamptz default now()
);
```

동기화 전략: Upsert (onConflict: 'id') — device_id로 기기 구분

---

## 6. 기존 앱 통합

- `showToast` prop을 통해 기존 Toast 시스템 공유
- `isTauri()` 유틸 재사용
- 기존 CLAUDE.md 지침 준수 (Bun, Tailwind CSS 3)
- App.tsx 변경 최소화: import 1줄 + state 1줄 + 탭 UI ~20줄

---

## 7. 구현 파일 목록

| 파일 | 변경 유형 | 설명 |
|------|---------|------|
| `src/PortalManager.tsx` | 신규 | 메인 컴포넌트 (~380줄) |
| `api-server.ts` | 수정 | GET/POST /api/portal 추가 |
| `src/App.tsx` | 수정 | 탭 네비게이션 + PortalManager 렌더 |
| `package.json` | 수정 | @supabase/supabase-js 추가 |
