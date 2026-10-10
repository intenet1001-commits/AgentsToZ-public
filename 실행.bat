@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo 포트 관리 프로그램을 시작합니다...
echo.

:: API 서버 백그라운드 실행
echo API 서버를 시작하는 중...
start "API Server" /min /d "%~dp0" cmd /c "bun api-server.ts"

:: Vite 개발 서버 백그라운드 실행
echo 개발 서버를 시작하는 중...
start "Vite Dev Server" /min /d "%~dp0" cmd /c "bunx vite"

:: 서버 시작 대기
timeout /t 4 /nobreak > nul

:: 브라우저 열기 (기본 브라우저로)
echo 브라우저를 여는 중...
start "" http://localhost:9000

echo.
echo 서버가 실행 중입니다. 이 창을 닫으면 서버가 종료됩니다.
pause > nul
