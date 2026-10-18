@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo 포트 관리 프로그램을 시작합니다...
echo.
echo 종료하려면 이 창을 닫거나 Ctrl+C를 누르세요.
echo.

:: API 서버 백그라운드 실행
echo API 서버를 시작하는 중...
start "API Server" /min bun api-server.ts

:: Vite 개발 서버 백그라운드 실행 (& 연산자는 Unix 전용 → vite 직접 실행)
echo 개발 서버를 시작하는 중...
start "Vite Dev Server" /min bun x vite --port 9000

:: 서버 시작 대기
timeout /t 4 /nobreak > nul

:: 브라우저 열기
echo Chrome 브라우저를 여는 중...
start chrome http://localhost:9000

:: 프로세스 유지 (창을 닫으면 종료)
echo.
echo 서버가 실행 중입니다. 이 창을 닫으면 서버가 종료됩니다.
pause > nul
