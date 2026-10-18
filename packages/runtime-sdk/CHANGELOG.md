# Changelog

## 0.4.0 — 2026-10-18

- Share project-bound platform CLI accounts across connected agents and local SDK/CLI hosts.
- Export OS-backed account storage and isolated GitHub, Vercel, Supabase and Google Workspace execution adapters.
- Export reviewed GitHub push plans with exact account/repository/commit checks and durable retry receipts.
- Keep native AI account selection and existing remote execution permissions unchanged.

## 0.3.0 — 2026-10-18

- Share automatic/recommend/off effort policy with registered-project agent hosts outside Workroom windows.
- Export `createProjectAgentTerminal` for external terminal/IDE hosts using the existing validated CLI protocol and the same host preference.
- Export `ProjectAgentEffortController` for native agent integrations with session-scoped controls, live binding checks and observed application receipts.
- Preserve manual choices and expose recommendation-only support when an external app cannot change native effort.

## 0.2.0 — 2026-09-06

- 실제 CLI PTY 호스트: 등록 대상 검증, 입력 순서·재시도 중복 방지, 크기 변경, 유한 출력 보관, 종료.
- 도구 없는 이름 추천 작업: 취소·시간 제한, 결과 ID·형식 검증, 호스트 미리보기와 적용 분리.
- 기존 관리형 작업 실행 게이트 유지.

## 0.1.0 — 2026-09-06
- 기존 Codex app-server 어댑터와 작업·지속 대화 서비스를 Bun SDK로 패키징.
- 브라우저/Tauri 클라이언트를 별도 entry로 분리.
- 앱 런타임 서버와 UI가 SDK 공개 entry를 사용하도록 연결.
- 등록 프로젝트, 실행 권한, journal, 취소·중복 방지 계약 유지.
- 소스 해시 manifest와 독립 Git 버전 관리용 내보내기 제공.
