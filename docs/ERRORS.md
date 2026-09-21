# 에러 카탈로그

실사용에서 발생하는 주요 에러와 복구 방법을 한 줄씩 정리했습니다.
더 깊은 디버깅은 README의 섹션별 링크 참조.

| 증상 / 메시지 | 발생 위치 | 복구 |
|---|---|---|
| `절대 경로가 필요합니다` | 작업루트 추가 · 폴더 생성 모달 | 네이티브 "폴더 선택"으로 고르거나 `/Users/...` · `C:\Users\...` 같은 절대경로 직접 입력. |
| `이미 추가된 작업루트입니다` | 작업루트 추가 | 중복 경로. 기존 루트를 지우거나 다른 폴더 선택. |
| `포트 <n>은 이미 "<name>"에서 사용 중입니다` | 프로젝트 추가 / 편집 | 포트 번호 변경 또는 기존 프로젝트 제거. |
| `포트 번호는 1~65535 사이여야 합니다` | 프로젝트 추가 / 편집 | 유효한 숫자 입력. |
| `Supabase not configured` / Push 실패 | 설정 → 동기화 | SetupWizard 재실행 또는 설정 모달에서 URL / anon key 입력. |
| `/api/...` 404 (Vercel) | 배포본에서 filesystem 기능 호출 | Vercel에는 api-server가 없음. 기능을 쓰려면 로컬 데스크톱 앱 실행. |
| `fs\|write_text_file not allowed by ACL` | Tauri v2 | `src-tauri/capabilities/default.json` 에 `fs:allow-write-text-file` 추가 후 재빌드. |
| Windows 빌드 시 `os error 2/5` | `bun run tauri:build:win` | 프로젝트가 `C:\Windows\System32\...`에 있음. `build-win.ts`가 자동으로 홈 디렉터리로 리다이렉트하므로 재실행. |
| Vercel 빌드 성공 but 포털 오픈 시 "URL/KEY 없음" | 배포 설정 | Vercel 대시보드에서 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` 환경변수 확인 후 재배포. |
| `$HOME not set` | api-server DMG export | 정상 macOS/Linux 셸에서 실행하면 자동 해결. 자동화 환경이면 `HOME=/path` 설정. |
| 포트 실행 중인데 "정지 안 됨" | 포트 목록 → 중지 | **강제 재실행** 버튼(SIGKILL). 여전히 안 되면 터미널에서 `lsof -ti:<port> \| xargs kill -9`. |
| `프로젝트 폴더 자동감지 실패` (포트/실행파일 미채움) | "프로젝트 추가" 모달 → 폴더 선택 | 해당 폴더에 `.command`/`.bat`/`package.json`이 없음. 포트 번호를 수동 입력하거나 실행 파일 경로 지정. |

## 디버깅 팁

- **콘솔 열기**: Tauri `Cmd/Ctrl+Option+I` (dev 모드) / 웹 브라우저 DevTools.
- **API 서버 로그**: `bun run start` 실행 중인 터미널에 실시간 출력.
- **프로세스 로그 파일**: `~/Library/Application Support/com.portmanager.portmanager/logs/<portId>.log` (macOS) / `%APPDATA%\com.portmanager.portmanager\logs\<portId>.log` (Windows).
- **Supabase 쿼리 확인**: supabase 대시보드 → SQL editor 에서 `select count(*) from ports where device_id = '<my-uuid>';`
