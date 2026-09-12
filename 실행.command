#!/bin/bash

set -u
cd "$(dirname "$0")"

API_PORT_VALUE="${API_PORT:-3001}"
VITE_PORT_VALUE="${PORT:-9000}"

echo "포트 관리 프로그램을 시작합니다..."
echo "API: ${API_PORT_VALUE} · Vite: ${VITE_PORT_VALUE}"
echo "종료하려면 Ctrl+C를 누르세요."
echo ""

if ! command -v bun >/dev/null 2>&1; then
    echo "✗ Bun을 찾을 수 없습니다. 새 터미널에서 bun --version을 확인해주세요."
    exit 1
fi

# API와 Vite를 따로 띄우면 API만 종료된 뒤에도 Vite가 살아 있어 구버전 또는
# 다른 API 인스턴스로 연결될 수 있다. dev.ts가 실제 환경 포트를 기준으로 기존
# 리스너를 정리하고, API 장애 시 재기동하며, 두 프로세스의 종료를 함께 관리한다.
bun dev.ts &
RUNNER_PID=$!

cleanup() {
    trap - INT TERM
    if kill -0 "$RUNNER_PID" 2>/dev/null; then
        kill -TERM "$RUNNER_PID" 2>/dev/null
        wait "$RUNNER_PID" 2>/dev/null
    fi
}
trap cleanup INT TERM EXIT

check_listener() {
    local port=$1
    local name=$2
    local attempts=0
    while [ "$attempts" -lt 40 ]; do
        if /usr/sbin/lsof -ti:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
            echo "✓ $name 서버 실행 중 (포트 $port)"
            return 0
        fi
        if ! kill -0 "$RUNNER_PID" 2>/dev/null; then
            echo "✗ 개발 서버가 시작 중 종료되었습니다."
            return 1
        fi
        sleep 0.25
        attempts=$((attempts + 1))
    done
    echo "✗ $name 서버 시작 시간 초과 (포트 $port)"
    return 1
}

if check_listener "$API_PORT_VALUE" "API" && check_listener "$VITE_PORT_VALUE" "Vite"; then
    echo "Chrome 브라우저로 http://localhost:${VITE_PORT_VALUE} 를 엽니다."
    open -a "Google Chrome" "http://localhost:${VITE_PORT_VALUE}"
fi

wait "$RUNNER_PID"
RUNNER_EXIT=$?
trap - EXIT
exit "$RUNNER_EXIT"
