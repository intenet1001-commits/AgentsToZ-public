export interface GuideEntry {
  title: string;
  body: string;
  tip?: string;
}

export const GUIDE_CONTENT: Record<string, GuideEntry> = {
  'tab-ports': {
    title: '프로젝트·폴더 탭',
    body: '내가 자주 여는 .command 파일과 폴더 모음. 한 번에 dev 서버를 켜고 끌 수 있어요.',
    tip: '빈 카드를 누르면 새 항목을 추가할 수 있어요.',
  },
  'tab-portal': {
    title: '포털·북마크 탭',
    body: '자주 쓰는 웹사이트와 폴더 즐겨찾기. 모든 기기에서 공유돼요.',
  },
  'btn-run-port': {
    title: '포트 실행',
    body: '연결된 .command 파일을 실행해 dev 서버를 띄워요.',
    tip: '실행 중이면 같은 자리에 정지 버튼이 나와요.',
  },
  'btn-stop-port': {
    title: '포트 정지',
    body: '실행 중인 dev 서버를 종료해요. 안 죽으면 ⋮ 메뉴에서 강제 재실행을 써보세요.',
  },
  'btn-force-restart': {
    title: '강제 재실행',
    body: '응답하지 않는 프로세스 트리를 강제 종료하고 바로 다시 실행해요.',
  },
  'btn-open-folder': {
    title: '폴더 열기',
    body: 'Finder에서 프로젝트 폴더를 열어요.',
  },
  'btn-open-chrome': {
    title: 'Chrome에서 열기',
    body: '실행 중인 dev 서버 URL을 Chrome 브라우저로 열어요.',
  },
  'btn-cmux': {
    title: 'cmux Claude',
    body: 'cmux 터미널에서 Claude Code를 바로 띄워요.',
    tip: '↺가 붙은 버튼은 새 창으로 열어요.',
  },
  'btn-worktree': {
    title: '워크트리 패널',
    body: 'git worktree 여러 개를 동시에 관리해요. 브랜치마다 따로 dev 서버를 띄울 수 있어요.',
  },
  'btn-more-menu': {
    title: '더 보기 메뉴',
    body: '강제 재실행, 로그 보기, tmux/Claude 옵션 등 추가 액션이 들어 있어요.',
  },
  'btn-portal-push': {
    title: '포털 Push',
    body: '내 북마크/폴더 즐겨찾기를 Supabase에 올려요.',
  },
  'btn-portal-pull': {
    title: '포털 Pull',
    body: 'Supabase에서 내려받아 다른 기기와 동기화해요.',
  },
  'btn-portal-export': {
    title: '북마크 내보내기',
    body: '현재 북마크/카테고리를 JSON 파일로 저장해요. 백업용으로 좋아요.',
  },
  'btn-export-ports': {
    title: '프로젝트 내보내기',
    body: '내 포트 목록 전체를 JSON 파일로 저장해요. Supabase 없이 백업/복원 가능.',
  },
  'btn-import-ports': {
    title: '프로젝트 불러오기',
    body: 'JSON 파일에서 포트 목록을 복원해요.',
  },
  'btn-portal-import': {
    title: '북마크 불러오기',
    body: 'JSON 파일을 불러와서 북마크를 복원해요.',
  },
  'btn-portal-settings': {
    title: '포털 설정',
    body: 'Supabase 연결 정보, 기기 이름, 동기화 옵션을 설정해요.',
  },
  'btn-supabase-push': {
    title: '프로젝트 Push',
    body: '내 포트 목록을 Supabase에 백업해요.',
    tip: '저장 전에 자동으로 스냅샷이 만들어지니 안전해요.',
  },
  'btn-supabase-pull': {
    title: '프로젝트 Pull',
    body: '다른 기기에서 백업한 포트 목록을 가져와요.',
  },
  'btn-history': {
    title: '히스토리',
    body: '과거 Push 시점의 스냅샷으로 되돌릴 수 있어요.',
  },
  'btn-settings': {
    title: '설정',
    body: '기기 이름, Supabase 연결 정보, 동기화 옵션을 설정해요.',
  },
  'btn-bypass': {
    title: 'Bypass 권한 토글',
    body: 'Claude Code 자동 승인 모드를 켜고 끕니다. 켜면 매번 묻지 않아요.',
  },
  'btn-setup-wizard': {
    title: '세팅 마법사',
    body: '처음 쓸 때 한 번만 — Supabase URL/Key를 안내에 따라 설정해요.',
  },
  'btn-copy-log': {
    title: '로그 복사',
    body: '최근 빌드/오류 로그를 클립보드로 복사해요. 디버깅이나 이슈 제보 때 쓰세요.',
  },
  'btn-refresh': {
    title: '새로고침',
    body: '모든 포트의 실제 리스너 상태를 다시 확인해요.',
  },
  'btn-guide-toggle': {
    title: '가이드 모드',
    body: '지금 가이드 모드 안내예요! 다시 누르면 꺼져요.',
    tip: '켜진 동안 아무 버튼이나 눌러보면 그 기능 설명이 나와요.',
  },

  // ── 카드 기본 액션 (프로젝트 카드 내부) ───────────────────────────────
  'card-run-stop': {
    title: '실행 / 정지',
    body: '연결된 .command 파일로 dev 서버를 켜고 끕니다. 실행 중이면 같은 자리에 정지 버튼.',
  },
  'card-cmux': {
    title: 'cmux Claude',
    body: 'cmux 터미널을 띄워 이 프로젝트 폴더에서 Claude Code를 바로 실행해요.',
  },
  'card-cmux-new': {
    title: 'cmux 새 창',
    body: 'cmux를 새 창에서 열어요. 기존 세션과 독립적으로 작업.',
  },
  'card-worktree': {
    title: '워크트리 패널',
    body: 'git worktree 여러 개를 카드 아래에 펼쳐서 보여줘요. 브랜치마다 독립 dev 서버.',
  },
  'card-chrome': {
    title: 'localhost 열기',
    body: '실행 중인 dev 서버 URL(localhost:포트)을 Chrome 브라우저로 열어요. 노트북 아이콘으로 표시.',
  },
  'card-deploy': {
    title: '배포 주소 열기',
    body: '이 프로젝트의 배포된 URL(Vercel, Netlify 등)을 Chrome으로 열어요. 지구본 아이콘으로 표시.',
    tip: '카드 수정 → 배포 URL 필드에 주소를 넣으면 버튼이 나타나요.',
  },
  'card-github': {
    title: 'GitHub 열기',
    body: '이 프로젝트의 GitHub 저장소를 Chrome으로 열어요.',
    tip: '카드 수정 → GitHub URL 필드에 주소를 넣으면 버튼이 나타나요.',
  },
  'card-favorite': {
    title: '즐겨찾기',
    body: '별(★) 버튼을 누르면 즐겨찾기에 추가돼요. 즐겨찾기 항목은 목록 최상단에 고정되고, 왼쪽 사이드바 "Starred" 필터로 모아볼 수 있어요.',
    tip: '다시 누르면 즐겨찾기가 해제돼요.',
  },
  'card-more-menu': {
    title: '더 보기 메뉴',
    body: '카드별 추가 액션이 들어 있어요. 강제 재실행, 로그 보기, tmux/Claude 옵션 등.',
  },

  // ── 더보기 메뉴 항목 ──────────────────────────────────────────────────
  'menu-force-restart': {
    title: '강제 재실행',
    body: 'dev 서버가 종료되지 않을 때 프로세스 트리를 강제 종료한 뒤 즉시 재실행해요.',
    tip: '좀비 프로세스가 포트를 잡고 있을 때 유용.',
  },
  'menu-open-folder': {
    title: '폴더 열기',
    body: 'Finder에서 이 프로젝트 폴더를 열어요.',
  },
  'menu-view-log': {
    title: '로그 보기',
    body: 'Terminal을 열어 dev 서버 로그를 `tail -f`로 실시간 확인해요.',
  },
  'menu-cmux-terminal': {
    title: 'cmux 터미널 열기',
    body: 'Claude 없이 cmux 터미널만 이 폴더에서 띄워요.',
  },
  'menu-terminal-claude': {
    title: 'Terminal Claude',
    body: '시스템 Terminal에서 Claude Code를 실행해요 (cmux 안 씀).',
  },
  'menu-tmux': {
    title: 'tmux',
    body: 'tmux 세션 안에서 Claude Code를 실행해요. 분리/재연결 가능.',
  },
  'menu-tmux-new': {
    title: 'tmux 새 창',
    body: '새 tmux 세션을 띄워 Claude Code를 실행해요.',
  },
  'menu-cmux-mac': {
    title: 'cmux (Mac 전용)',
    body: 'macOS 전용 cmux 변형으로 Claude Code 실행. 환경 차이가 있을 때.',
  },
  'menu-cmux-mac-new': {
    title: 'cmux 새 창 (Mac 전용)',
    body: 'macOS 전용 cmux를 새 창에서 열어 Claude Code 실행.',
  },
  'menu-edit': {
    title: '카드 수정',
    body: '이 카드의 이름, 포트, 경로 등을 수정해요.',
  },
  'menu-delete': {
    title: '카드 삭제',
    body: '이 카드를 목록에서 삭제해요. dev 서버는 자동 정지.',
    tip: 'Supabase에 Push되어 있다면 다음 Push 때 삭제도 동기화돼요.',
  },

  // ── 왼쪽 사이드바 ─────────────────────────────────────────────────────
  'sidebar-search': {
    title: '프로젝트 검색',
    body: '카드 이름·포트·폴더 경로로 빠르게 필터링해요.',
    tip: '⌘+F 단축키로 즉시 포커스.',
  },
  'sidebar-all': {
    title: '전체 프로젝트',
    body: '모든 카드를 한 화면에서 보는 기본 뷰.',
  },
  'sidebar-running': {
    title: '실행 중',
    body: '현재 dev 서버가 켜져 있는 카드만 모아 봐요.',
  },
  'sidebar-recent': {
    title: '최근 사용',
    body: '7일 이내에 열었던 프로젝트를 최신 순으로 보여줘요. 포트 없는 폴더 항목도 포함돼요.',
    tip: '자주 쓰는 프로젝트를 빠르게 찾고 싶을 때 유용해요.',
  },
  'sidebar-starred': {
    title: '즐겨찾기',
    body: '즐겨찾기로 표시한 카드만 모아 봐요.',
  },
  'sidebar-worktrees': {
    title: '워크트리',
    body: 'git worktree가 등록된 카드만 모아 봐요.',
  },
  'sidebar-stale': {
    title: '오래된 항목',
    body: '오랫동안 실행하지 않은 카드를 모아 정리할 수 있어요.',
  },
  'sidebar-tags': {
    title: '태그',
    body: '카테고리/태그별로 카드를 그룹화해서 보여줘요.',
  },
  'workspace-roots': {
    title: '작업 루트 패널',
    body: '여러 작업 폴더를 등록해두고 카드들을 그룹별로 관리해요.',
  },
  'workspace-add-root': {
    title: '작업 루트 추가',
    body: '새 작업 폴더를 등록해요. Finder에서 폴더를 선택.',
  },
  'workspace-new-folder': {
    title: '새 폴더 만들기',
    body: '현재 작업 루트 안에 새 프로젝트 폴더를 생성해요.',
  },
  'sort-options': {
    title: '정렬 옵션',
    body: '이름/포트/실행 시각 등 기준으로 카드 순서를 바꿔요.',
  },
  'filter-options': {
    title: '필터 옵션',
    body: '특정 조건의 카드만 화면에 표시해요.',
  },

  // ── 포털 사이드바 ─────────────────────────────────────────────────────
  'portal-sidebar-all': {
    title: '전체 북마크',
    body: '모든 카테고리의 북마크를 한 화면에서 봐요.',
  },
  'portal-sidebar-category': {
    title: '카테고리',
    body: '북마크를 주제별로 모은 그룹. 클릭하면 그 카테고리 항목만 보여요.',
  },
  'portal-add-category': {
    title: '카테고리 추가',
    body: '새 카테고리를 만들어요. 색깔을 지정해서 구분 가능.',
  },
  'portal-sidebar-history': {
    title: '북마크 히스토리',
    body: '과거 Push 시점의 스냅샷으로 북마크를 되돌릴 수 있어요.',
  },
  'portal-sync-status': {
    title: '동기화 상태',
    body: '마지막으로 Supabase와 동기화한 시각을 보여줘요.',
  },

  // ── 프로젝트 카드 본체 + 섹션 구분자 ────────────────────────────────
  'card-body': {
    title: '프로젝트 카드',
    body: 'dev 서버를 켜고 끄는 단위. 카드 위에 마우스를 올리면 액션 버튼(폴더/cmux/Chrome/⋮)이 나타나요.',
    tip: '오른쪽의 :포트 또는 "폴더" 라벨로 종류를 구분할 수 있어요.',
  },
  'section-header-running': {
    title: 'Running 섹션',
    body: '현재 dev 서버가 실행 중인 카드 묶음. 옆 숫자는 개수.',
  },
  'section-header-idle': {
    title: 'Idle 섹션',
    body: '실행 중이 아닌(정지된) 카드 묶음. 옆 숫자는 개수.',
  },

  // ── All-Projects 뷰 헤더 (alt 툴바) ───────────────────────────────────
  'header-section-title': {
    title: '현재 섹션 이름',
    body: '왼쪽 사이드바에서 고른 섹션의 이름이에요. (All projects / Running / Starred / Worktrees / Stale)',
  },
  'header-project-count': {
    title: '프로젝트 수',
    body: '현재 섹션에 보이는 카드의 개수.',
  },
  'header-cmux-root': {
    title: 'cmux (작업 루트)',
    body: '현재 작업 루트 폴더에서 cmux 터미널을 열어요. macOS 전용.',
  },
  'header-build-app': {
    title: '앱 빌드 (.app)',
    body: 'Tauri 앱을 빌드해요. 결과는 ~/cargo-targets/portmanager/release/bundle/macos/',
    tip: '웹 모드에서만 보이는 버튼이에요.',
  },
  'header-build-dmg': {
    title: 'DMG 빌드',
    body: '배포용 DMG 파일을 빌드해요. 빌드 후 "DMG 출시하기"로 Desktop에 복사 가능.',
  },
  'header-new-project': {
    title: '+ 새 프로젝트',
    body: '새 프로젝트 폴더를 만들거나 기존 폴더를 등록해요.',
    tip: '새 폴더 만들기 / 기존 폴더 등록 두 탭이 있어요.',
  },
  'btn-ai-usage': {
    title: 'AI 사용량',
    body: 'Claude와 Codex의 한도 사용률을 한 창에서 확인해요.',
    tip: 'Claude는 실시간 조회(몇 초 소요), Codex는 마지막 세션 기록 기준이에요.',
  },
  'header-build-windows': {
    title: 'Windows 빌드 (.exe)',
    body: 'NSIS 설치 파일(.exe)을 빌드해요. Windows 머신에서 직접 실행해야 해요.',
    tip: '결과물: %USERPROFILE%\\cargo-targets\\portmanager\\release\\bundle\\nsis\\',
  },
  'header-terminal-root': {
    title: '터미널 (작업 루트)',
    body: '현재 선택된 작업 루트 폴더에서 터미널을 바로 열어요.',
    tip: '헤더의 터미널 종류(iTerm/Terminal/cmux/Orca) 설정을 따라가요.',
  },
  'header-cmux-agent-view': {
    title: 'cmux Agent View',
    body: 'cmux의 Agent View를 열어 실행 중인 AI 세션들을 한 화면에서 확인해요.',
    tip: 'Claude bg 모드로 띄운 세션이 여기에 모여요.',
  },

  // ── 포털 메인 영역 ────────────────────────────────────────────────────
  'portal-search': {
    title: '북마크 검색',
    body: '이름·URL·설명으로 북마크를 빠르게 찾아요.',
  },
  'portal-add-item': {
    title: '북마크 추가',
    body: '새 URL 북마크를 등록해요. 이름·URL·카테고리 입력.',
  },
  'portal-item-card': {
    title: '북마크 카드',
    body: '클릭하면 새 탭(Chrome)에서 URL을 열어요. 우측 메뉴로 수정/삭제 가능.',
  },
  'portal-pin-toggle': {
    title: '핀 고정',
    body: '자주 쓰는 북마크를 카테고리 최상단에 고정해요.',
  },
  'portal-item-actions': {
    title: '북마크 액션',
    body: '이 북마크를 수정하거나 삭제하는 메뉴.',
  },
  'portal-open': {
    title: '북마크 열기',
    body: '이 북마크 URL을 Chrome 새 탭에서 열어요.',
  },
  'btn-portal-history': {
    title: '포털 Push 기록',
    body: '북마크를 Supabase에 올린 이력(스냅샷)을 확인해요. 실수로 덮어썼을 때 되돌릴 근거가 돼요.',
  },
};

/** True when a curated entry exists — guide mode falls back to auto-generated text otherwise. */
export function hasGuideEntry(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(GUIDE_CONTENT, key);
}

export function getGuideEntry(key: string): GuideEntry {
  return (
    GUIDE_CONTENT[key] ?? {
      title: '아직 설명이 준비되지 않았어요',
      body: '이 요소에 대한 가이드는 아직 준비 중입니다.',
    }
  );
}
