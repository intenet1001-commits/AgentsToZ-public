#!/bin/bash

# 진도표 생성기 실행 스크립트

# 현재 스크립트가 있는 디렉토리로 이동
cd "$(dirname "$0")"

echo "🚀 진도표 생성기를 시작합니다..."

# 기존 포트 9001 프로세스 종료
lsof -ti:9001 | xargs kill -9 2>/dev/null
sleep 1

# Bun 서버 백그라운드 실행
bun --hot --port 9001 index.html > /dev/null 2>&1 &
SERVER_PID=$!

echo "⏳ 서버 시작 중..."
sleep 3

# 브라우저 열기
echo "🌐 브라우저를 엽니다..."
open http://localhost:9001

echo ""
echo "✅ 진도표 생성기가 실행되었습니다!"
echo "📍 주소: http://localhost:9001"
echo ""
echo "종료하려면 이 창을 닫거나 Ctrl+C를 누르세요"

# 서버 프로세스 유지
wait $SERVER_PID
