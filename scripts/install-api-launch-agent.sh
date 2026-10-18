#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.agentstoz.api"
UID_VALUE="$(id -u)"
BUN="$(command -v bun || true)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$ROOT/logs"
PORT="${API_PORT:-3001}"

if [[ -z "$BUN" || ! -x "$BUN" ]]; then
  echo "Bun을 찾지 못했습니다. 먼저 bun을 설치하세요." >&2
  exit 1
fi

mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"

# Do not take over an unrelated service. Only replace a listener whose cwd and
# command identify this repository's API server.
if command -v lsof >/dev/null 2>&1; then
  while read -r pid; do
    [[ -z "$pid" ]] && continue
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/{sub(/^n/, ""); print; exit}')"
    if [[ "$cwd" != "$ROOT" || "$command_line" != *"api-server.ts"* ]]; then
      echo "AGENTSTOZ_API_PORT_OCCUPIED: port ${PORT} is used by an unrelated process (pid ${pid})." >&2
      echo "working directory: ${cwd:-unknown}" >&2
      exit 2
    fi
    kill "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
  done < <(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BUN}</string>
    <string>api-server.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>API_PORT</key>
    <string>${PORT}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/api-launchd.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/api-launchd.error.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/${UID_VALUE}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/${UID_VALUE}" "$PLIST"
launchctl kickstart -k "gui/${UID_VALUE}/${LABEL}"

for _ in {1..40}; do
  if curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "AgentsToZ API launch agent is running on 127.0.0.1:${PORT}"
    exit 0
  fi
  sleep 0.25
done

echo "AgentsToZ API launch agent did not become healthy; see ${LOG_DIR}/api-launchd.error.log" >&2
exit 3
