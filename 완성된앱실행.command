#!/bin/bash

# 현재 스크립트 디렉토리로 이동
cd "$(dirname "$0")"

echo "====================================="
echo "빌드된 Tauri 앱을 실행합니다..."
echo "====================================="
echo ""

# 앱 경로
APP_PATH="./src-tauri/target/release/bundle/macos/포트관리기.app"

# 앱이 존재하는지 확인
if [ ! -d "$APP_PATH" ]; then
    echo "❌ 오류: 앱이 빌드되지 않았습니다."
    echo ""
    echo "먼저 다음 중 하나를 실행하세요:"
    echo "1. Tauri 앱에서 '앱 빌드' 버튼 클릭"
    echo "2. 터미널에서 'bun run tauri:build' 실행"
    echo ""
    exit 1
fi

echo "✅ 앱을 찾았습니다."
echo "📂 위치: $APP_PATH"
echo ""
echo "앱을 실행합니다..."

# 앱 실행
open "$APP_PATH"

echo ""
echo "✨ 앱이 실행되었습니다!"
