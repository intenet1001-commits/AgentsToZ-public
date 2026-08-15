# Dogfood 체크리스트

릴리스 전 / 포크 후 전체 동작을 3개 환경에서 확인.
`[ ]` 를 채워가며 체크하면 됩니다. 실패하는 항목은 `docs/ERRORS.md` 또는 이슈로 기록.

## macOS (Tauri 앱)

- [ ] `bun run tauri:dev` 로 앱 실행, 메인 화면 로드
- [ ] "+ 프로젝트 추가" → "기존 폴더 연결" → 폴더 선택 후 이름·포트 자동 채움 확인
- [ ] "+ 프로젝트 추가" → "새 폴더 만들기" → 작업루트 없을 때 인라인 "루트 추가" 노출 확인
- [ ] 작업루트 추가 → 새 폴더 생성 → 폴더가 실제 생성되고 목록에 항목 등록
- [ ] 포트 실행 / 중지 / 강제 재실행 / 로그 보기 동작
- [ ] "Chrome에서 열기" 버튼 동작
- [ ] Supabase Push → Pull 왕복 (데이터 유지)
- [ ] 포털 탭: 북마크 추가/편집/삭제/핀
- [ ] `bun run tauri:build:dmg` → DMG 생성 → "DMG 출시하기" 버튼으로 Desktop 복사

## Windows (Tauri 앱)

- [ ] `bun run tauri:dev` 실행 (관리자 권한 아니어도 OK)
- [ ] 백슬래시 경로(`C:\Users\...`)로 작업루트 추가, "새 폴더" 생성
- [ ] `.bat` 또는 `.cmd` 파일 연결 및 실행/중지
- [ ] WSL tmux 모드: "Claude (tmux)" 버튼 → Windows Terminal 탭 열림
- [ ] `bun run tauri:build:win` → `%USERPROFILE%\cargo-targets\portmanager\release\bundle\nsis\*.exe` 생성

## 로컬 웹 (localhost:9001)

- [ ] `bun run start` 실행 → 브라우저로 접속
- [ ] Tauri 전용 기능(DMG/Windows 빌드 등) 버튼이 웹에서 정상 렌더링
- [ ] `/api/pick-folder` 다이얼로그 정상 동작 (macOS osascript, Windows PowerShell)
- [ ] 포트 실행 / 중지 정상 동작 (api-server 경유)

## Vercel (portmanager-portal.vercel.app)

- [ ] "조회 전용 모드" 배너가 상단에 노출
- [ ] "프로젝트 추가" 버튼 **숨김**
- [ ] "작업루트" 섹션 **숨김**
- [ ] DMG/Windows 빌드 버튼 **숨김**
- [ ] 포털 탭: localStorage 기반 북마크 CRUD 정상 동작
- [ ] Supabase 설정 후 북마크 Push/Pull 정상 동작
- [ ] Supabase 미설정 상태에서도 포털이 크래시 없이 로드
- [ ] 포트 목록 조회는 Supabase에서 Pull (있으면)

## 포크 시뮬레이션 (새 PC 가정)

- [ ] 새 폴더에서 `git clone <fork-url>`
- [ ] `bun install` 에러 없음
- [ ] `bun run start` → 5분 내 동작
- [ ] `.env.example` 복사 → `.env` → `VITE_SUPABASE_URL` 등 채움 → `bun run build:portal` 성공
- [ ] `src-tauri/tauri.conf.json` identifier 교체 후 `bun run tauri:build` 정상 빌드
