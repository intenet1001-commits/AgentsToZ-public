# 포트 관리 앱 디자인 시스템 가이드

미국 테크 스타일의 모던하고 세련된 다크 테마 디자인 시스템입니다.

## 📐 디자인 철학

- **미니멀리즘**: 불필요한 요소 제거, 핵심 기능에 집중
- **고대비**: 명확한 텍스트 가독성 (white/zinc 대비)
- **컴팩트함**: 작은 폰트, 타이트한 간격으로 정보 밀도 최대화
- **미묘한 상호작용**: 투명도 기반 호버 효과, 부드러운 트랜지션

---

## 🎨 색상 팔레트

### 배경 색상
```css
/* 메인 배경 - 가장 어두운 검정 */
background: #0a0a0b;

/* 카드/컨테이너 배경 - 약간 밝은 검정 */
background: #18181b;

/* 인풋/버튼 배경 - 투명 검정 */
background: rgba(0, 0, 0, 0.3); /* black/30 */

/* 호버 상태 - 미묘한 회색 */
background: #27272a; /* zinc-800 */
hover:background: #3f3f46; /* zinc-700 */
```

### 텍스트 색상
```css
/* 주요 텍스트 - 순백색 */
color: #ffffff; /* white */

/* 보조 텍스트 - 밝은 회색 */
color: #d4d4d8; /* zinc-300 */

/* 부가 설명 - 중간 회색 */
color: #a1a1aa; /* zinc-400 */

/* 약한 텍스트 - 어두운 회색 */
color: #71717a; /* zinc-500 */

/* 극히 약한 텍스트 - 매우 어두운 회색 */
color: #52525b; /* zinc-600 */
```

### 테두리 색상
```css
/* 기본 테두리 */
border-color: #27272a; /* zinc-800 */

/* 약한 테두리 */
border-color: #3f3f46; /* zinc-700 */

/* 포커스 테두리 */
border-color: #3b82f6; /* blue-500 */
```

### 상태 색상 (투명도 기반)

#### 성공 (초록)
```css
/* 배경 */
background: rgba(34, 197, 94, 0.1);   /* green-500/10 */
background: rgba(34, 197, 94, 0.15);  /* green-500/15 */
background: rgba(34, 197, 94, 0.2);   /* green-500/20 */

/* 테두리 */
border-color: rgba(34, 197, 94, 0.3);  /* green-500/30 */
border-color: rgba(34, 197, 94, 0.4);  /* green-500/40 */
border-color: rgba(34, 197, 94, 0.5);  /* green-500/50 */

/* 텍스트 */
color: #4ade80; /* green-400 */
color: #22c55e; /* green-500 */
```

#### 에러 (빨강)
```css
/* 배경 */
background: rgba(239, 68, 68, 0.1);   /* red-500/10 */
background: rgba(239, 68, 68, 0.2);   /* red-500/20 */

/* 테두리 */
border-color: rgba(239, 68, 68, 0.3);  /* red-500/30 */
border-color: rgba(239, 68, 68, 0.5);  /* red-500/50 */

/* 텍스트 */
color: #f87171; /* red-400 */
```

#### 경고 (노랑)
```css
/* 배경 */
background: rgba(234, 179, 8, 0.1);   /* yellow-500/10 */
background: rgba(234, 179, 8, 0.2);   /* yellow-500/20 */

/* 테두리 */
border-color: rgba(234, 179, 8, 0.3);  /* yellow-500/30 */

/* 텍스트 */
color: #facc15; /* yellow-400 */
```

#### 정보 (파랑)
```css
/* 배경 */
background: rgba(59, 130, 246, 0.1);   /* blue-500/10 */
background: rgba(59, 130, 246, 0.15);  /* blue-500/15 */
background: rgba(59, 130, 246, 0.25);  /* blue-500/25 */

/* 테두리 */
border-color: rgba(59, 130, 246, 0.3);  /* blue-500/30 */
border-color: rgba(59, 130, 246, 0.4);  /* blue-500/40 */
border-color: rgba(59, 130, 246, 0.6);  /* blue-500/60 */

/* 텍스트 */
color: #60a5fa; /* blue-400 */
color: #3b82f6; /* blue-500 */
```

#### 보조 (보라)
```css
/* 배경 */
background: rgba(168, 85, 247, 0.15);  /* purple-500/15 */

/* 테두리 */
border-color: rgba(168, 85, 247, 0.4);  /* purple-500/40 */

/* 텍스트 */
color: #c084fc; /* purple-300 */
```

#### 강조 (주황)
```css
/* 배경 */
background: rgba(249, 115, 22, 0.1);   /* orange-500/10 */

/* 테두리 */
border-color: rgba(249, 115, 22, 0.3);  /* orange-500/30 */

/* 텍스트 */
color: #fb923c; /* orange-400 */
```

#### 중립 (황금)
```css
/* 배경 */
background: rgba(245, 158, 11, 0.1);   /* amber-500/10 */

/* 테두리 */
border-color: rgba(245, 158, 11, 0.3);  /* amber-500/30 */

/* 텍스트 */
color: #fbbf24; /* amber-400 */
```

---

## 📏 간격 시스템

```css
/* 여백 (Padding) */
p-1     → 0.25rem  (4px)
p-1.5   → 0.375rem (6px)
p-2     → 0.5rem   (8px)
p-2.5   → 0.625rem (10px)
p-3     → 0.75rem  (12px)
p-4     → 1rem     (16px)
p-6     → 1.5rem   (24px)
p-8     → 2rem     (32px)

/* 간격 (Gap) */
gap-1   → 0.25rem  (4px)
gap-1.5 → 0.375rem (6px)
gap-2   → 0.5rem   (8px)
gap-2.5 → 0.625rem (10px)
gap-3   → 0.75rem  (12px)
gap-4   → 1rem     (16px)
```

---

## 🔤 타이포그래피

### 폰트 크기
```css
/* 매우 작은 텍스트 (보조 정보) */
font-size: 0.6875rem;  /* 11px */
line-height: 1.5;

/* 작은 텍스트 (라벨, 캡션) */
font-size: 0.75rem;    /* 12px - text-xs */
line-height: 1rem;

/* 일반 텍스트 (본문) */
font-size: 0.875rem;   /* 14px - text-sm */
line-height: 1.25rem;

/* 중간 텍스트 (강조) */
font-size: 1rem;       /* 16px - text-base */
line-height: 1.5rem;

/* 큰 텍스트 (제목) */
font-size: 1.125rem;   /* 18px - text-lg */
line-height: 1.75rem;

/* 매우 큰 텍스트 (메인 제목) */
font-size: 1.25rem;    /* 20px - text-xl */
line-height: 1.75rem;
```

### 폰트 두께
```css
/* 일반 */
font-weight: 400; /* font-normal */

/* 중간 */
font-weight: 500; /* font-medium */

/* 두껍게 */
font-weight: 600; /* font-semibold */

/* 매우 두껍게 */
font-weight: 700; /* font-bold */
```

### 특수 폰트
```css
/* 코드/로그용 모노스페이스 */
font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
```

---

## 🎯 컴포넌트 스타일

### 1. 카드/컨테이너
```css
.card {
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 0.75rem; /* rounded-xl */
  padding: 1.5rem;        /* p-6 */
}

.card-hover {
  transition: background-color 200ms;
}

.card-hover:hover {
  background: rgba(39, 39, 42, 0.3); /* zinc-900/30 */
}
```

### 2. 버튼

#### 기본 버튼
```css
.btn {
  padding: 0.375rem 0.75rem; /* px-3 py-1.5 */
  font-size: 0.75rem;         /* text-xs */
  font-weight: 500;           /* font-medium */
  border-radius: 0.5rem;      /* rounded-lg */
  transition: all 200ms;
}
```

#### 주요 액션 버튼 (파랑)
```css
.btn-primary {
  background: #3b82f6;  /* blue-500 */
  color: white;
}

.btn-primary:hover {
  background: #2563eb;  /* blue-600 */
}
```

#### 성공 버튼 (초록)
```css
.btn-success {
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.3);
  color: #4ade80;
}

.btn-success:hover {
  background: rgba(34, 197, 94, 0.2);
  border-color: rgba(34, 197, 94, 0.5);
}
```

#### 위험 버튼 (빨강)
```css
.btn-danger {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #f87171;
}

.btn-danger:hover {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.5);
}
```

#### 중립 버튼 (회색)
```css
.btn-neutral {
  background: #27272a;  /* zinc-900 */
  border: 1px solid #3f3f46;
  color: #d4d4d8;
}

.btn-neutral:hover {
  background: #3f3f46;  /* zinc-800 */
  border-color: #52525b;
}
```

#### 아이콘 버튼
```css
.btn-icon {
  padding: 0.5rem;      /* p-2 */
  border-radius: 0.5rem;
}

.btn-icon:hover {
  background: #27272a;
}
```

### 3. 입력 필드
```css
.input {
  padding: 0.5rem 0.75rem;  /* px-3 py-2 */
  font-size: 0.875rem;       /* text-sm */
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid #3f3f46;
  color: white;
  border-radius: 0.5rem;
  transition: all 200ms;
}

.input::placeholder {
  color: #71717a;  /* zinc-500 */
}

.input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 1px #3b82f6;
}
```

### 4. 배지/태그
```css
.badge {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.5rem;  /* px-2 py-0.5 */
  font-size: 0.75rem;         /* text-xs */
  font-weight: 500;
  border-radius: 0.375rem;    /* rounded-md */
  background: #27272a;
  border: 1px solid #3f3f46;
  color: #d4d4d8;
}
```

### 5. 토스트 알림
```css
/* 성공 토스트 */
.toast-success {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.625rem 1rem;
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.3);
  color: #4ade80;
  border-radius: 0.5rem;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
  backdrop-filter: blur(8px);
}

/* 에러 토스트 */
.toast-error {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
  color: #f87171;
}
```

### 6. 모달
```css
/* 모달 오버레이 */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(4px);
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

/* 모달 컨텐츠 */
.modal-content {
  background: #18181b;
  border: 1px solid #27272a;
  border-radius: 0.75rem;
  width: 100%;
  max-width: 56rem;     /* max-w-4xl */
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

/* 모달 헤더 */
.modal-header {
  padding: 1.5rem;
  border-bottom: 1px solid #27272a;
}

/* 모달 본문 */
.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
}

/* 모달 푸터 */
.modal-footer {
  padding: 1rem;
  border-top: 1px solid #27272a;
  background: rgba(39, 39, 42, 0.5);
}
```

### 7. 아이콘 컨테이너
```css
.icon-container {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem;
  background: #27272a;
  border: 1px solid #3f3f46;
  border-radius: 0.5rem;
}
```

---

## ✨ 애니메이션 & 트랜지션

### 기본 트랜지션
```css
/* 빠른 트랜지션 */
transition: all 200ms ease-in-out;

/* 표준 트랜지션 */
transition: all 300ms ease-in-out;

/* 느린 트랜지션 */
transition: all 500ms ease-in-out;
```

### 호버 효과
```css
/* 미묘한 배경 변화 */
.hover-subtle:hover {
  background: rgba(255, 255, 255, 0.05);
}

/* 명확한 배경 변화 */
.hover-clear:hover {
  background: #27272a;
}

/* 투명도 변화 */
.hover-opacity:hover {
  opacity: 0.8;
}
```

### 커스텀 애니메이션
```css
/* 슬라이드 인 (우측에서) */
@keyframes slide-in-right {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.animate-slide-in-right {
  animation: slide-in-right 300ms ease-in-out;
}

/* 펄스 (깜빡임) */
.animate-pulse {
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

/* 스핀 (회전) */
.animate-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
```

---

## 📱 레이아웃

### 컨테이너
```css
.container {
  max-width: 56rem;  /* max-w-4xl - 896px */
  margin: 0 auto;
  padding: 2rem;
}
```

### 그리드
```css
/* 2열 그리드 */
.grid-2 {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
}

/* 3열 그리드 */
.grid-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
}
```

### 플렉스
```css
/* 가로 정렬 */
.flex-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* 양끝 정렬 */
.flex-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* 세로 정렬 */
.flex-col {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
```

---

## 🎨 Tailwind CSS 클래스 참조

포트 관리 앱은 Tailwind CSS를 사용합니다. 위의 스타일을 Tailwind 클래스로 사용하려면:

### 배경
```
bg-[#0a0a0b]      - 메인 배경
bg-[#18181b]      - 카드 배경
bg-black/30       - 투명 검정
bg-zinc-900       - 회색 배경
bg-zinc-800       - 호버 배경
```

### 테두리
```
border-zinc-800   - 기본 테두리
border-zinc-700   - 약한 테두리
rounded-lg        - 작은 둥근 모서리 (8px)
rounded-xl        - 큰 둥근 모서리 (12px)
```

### 텍스트
```
text-white        - 순백색
text-zinc-200     - 밝은 회색
text-zinc-300     - 보조 텍스트
text-zinc-400     - 부가 설명
text-zinc-500     - 약한 텍스트
text-xs           - 12px
text-sm           - 14px
text-base         - 16px
text-lg           - 18px
```

### 상태별 색상
```
text-green-400    border-green-500/30    bg-green-500/10
text-red-400      border-red-500/30      bg-red-500/10
text-blue-400     border-blue-500/30     bg-blue-500/10
text-yellow-400   border-yellow-500/30   bg-yellow-500/10
text-purple-300   border-purple-500/40   bg-purple-500/15
text-orange-400   border-orange-500/30   bg-orange-500/10
text-amber-400    border-amber-500/30    bg-amber-500/10
```

---

## 🚀 사용 예시

### 예시 1: 기본 카드
```html
<div class="bg-[#18181b] rounded-xl border border-zinc-800 p-6">
  <h2 class="text-lg font-semibold text-white mb-2">제목</h2>
  <p class="text-sm text-zinc-400">설명 텍스트</p>
</div>
```

### 예시 2: 성공 버튼
```html
<button class="px-3 py-1.5 bg-green-500/10 hover:bg-green-500/20
               text-green-400 text-xs font-medium rounded-lg
               border border-green-500/30 hover:border-green-500/50
               transition-all duration-200">
  실행
</button>
```

### 예시 3: 토스트 알림
```html
<div class="flex items-center gap-2.5 px-4 py-2.5 rounded-lg shadow-xl
            backdrop-blur-sm bg-green-500/10 border border-green-500/30
            text-green-400">
  <span class="flex-1 font-medium text-sm">성공적으로 저장되었습니다</span>
  <button class="hover:bg-white/10 rounded-md p-1 transition-colors">×</button>
</div>
```

### 예시 4: 입력 필드
```html
<input type="text"
       placeholder="프로젝트 이름"
       class="px-3 py-2 text-sm bg-black/30 border border-zinc-700
              text-white placeholder-zinc-500 rounded-lg
              focus:outline-none focus:ring-1 focus:ring-blue-500
              focus:border-blue-500 transition-all">
```

---

## 💡 디자인 팁

1. **일관성**: 항상 동일한 간격 시스템 사용 (4px 단위)
2. **대비**: 텍스트는 white 또는 zinc-300 이상 사용
3. **투명도**: 배경색에는 /10, /15, /20 같은 투명도 사용
4. **호버**: 미묘한 변화 (배경 약간 밝게, 테두리 약간 강하게)
5. **트랜지션**: 200-300ms 사용으로 부드럽지만 반응적인 느낌
6. **둥근 모서리**: 작은 요소는 rounded-lg, 큰 요소는 rounded-xl
7. **그림자**: 거의 사용하지 않음 (토스트나 모달에만 제한적 사용)
8. **폰트 크기**: 대부분 text-xs 또는 text-sm 사용으로 컴팩트함 유지

---

© 2025 CS & Company Design System
