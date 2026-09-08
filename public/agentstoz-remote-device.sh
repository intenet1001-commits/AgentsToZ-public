#!/usr/bin/env bash
set -euo pipefail

AGENT_VERSION="4"
TOKEN=""
SUPABASE_URL=""
ANON_KEY=""
DEVICE_NAME=""
ENVIRONMENT_KIND="aws"
PROJECT_PATH=""
WORKSPACE_ROOT="/home/ubuntu/projects"
PROJECT_ACTION=""
PROJECT_NAME=""
REPOSITORY_URL=""
REQUESTED_MEMORY_ID=""
SYNC_ONLY=false
CONFIG_OVERRIDE=""
FORCE_NEW_DEVICE=false

fail() { printf 'AgentsToZ 원격 단말 등록 실패: %s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 명령이 필요합니다."; }

while [[ $# -gt 0 ]]; do
  if [[ "$1" != "--sync" && "$1" != "--force-new-device" && $# -lt 2 ]]; then
    fail "옵션 값이 필요합니다: $1"
  fi
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --supabase-url) SUPABASE_URL="${2:-}"; shift 2 ;;
    --anon-key) ANON_KEY="${2:-}"; shift 2 ;;
    --name) DEVICE_NAME="${2:-}"; shift 2 ;;
    --environment) ENVIRONMENT_KIND="${2:-}"; shift 2 ;;
    --project) PROJECT_PATH="${2:-}"; shift 2 ;;
    --workspace-root) WORKSPACE_ROOT="${2:-}"; shift 2 ;;
    --project-action) PROJECT_ACTION="${2:-}"; shift 2 ;;
    --project-name) PROJECT_NAME="${2:-}"; shift 2 ;;
    --repository-url) REPOSITORY_URL="${2:-}"; shift 2 ;;
    --memory-id) REQUESTED_MEMORY_ID="${2:-}"; shift 2 ;;
    --sync) SYNC_ONLY=true; shift ;;
    --config) CONFIG_OVERRIDE="${2:-}"; shift 2 ;;
    --force-new-device) FORCE_NEW_DEVICE=true; shift ;;
    *) fail "알 수 없는 인자입니다: $1" ;;
  esac
done

need curl
need python3

# 모든 원격 요청은 네트워크 단절 때 무한히 기다리지 않는다. 배열로 고정해
# 토큰·URL 같은 사용자 값이 curl 옵션으로 다시 해석되지 않게 한다.
REMOTE_CURL_ARGS=(--connect-timeout 10 --max-time 30)

agentstoz_api_ready() {
  local health_json
  health_json="$(curl --connect-timeout 1 --max-time 3 --fail --silent --show-error \
    http://127.0.0.1:3001/api/health 2>/dev/null)" || return 1
  HEALTH_JSON="$health_json" python3 - <<'PY'
import json, os, sys
try:
    health = json.loads(os.environ.get('HEALTH_JSON', ''))
    ok = (
        health.get('ok') is True
        and health.get('service') == 'agentstoz-api'
        and isinstance(health.get('schemaVersion'), int)
        and health['schemaVersion'] >= 10
    )
except Exception:
    ok = False
sys.exit(0 if ok else 1)
PY
}

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agentstoz"
IDENTITY_FILE="$CONFIG_DIR/remote-device.json"
CONFIG_FILE="${CONFIG_OVERRIDE:-$IDENTITY_FILE}"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

read_config_value() {
  local key="$1"
  [[ -f "$CONFIG_FILE" ]] || return 0
  python3 - "$CONFIG_FILE" "$key" <<'PY'
import json, sys
try:
    value = json.load(open(sys.argv[1], encoding='utf-8')).get(sys.argv[2], '')
    print(value if isinstance(value, str) else '')
except Exception:
    print('')
PY
}

read_config_flag() {
  local key="$1"
  [[ -f "$CONFIG_FILE" ]] || { printf 'false\n'; return 0; }
  python3 - "$CONFIG_FILE" "$key" <<'PY'
import json, sys
try:
    print('true' if bool(json.load(open(sys.argv[1], encoding='utf-8')).get(sys.argv[2], False)) else 'false')
except Exception:
    print('false')
PY
}

migrate_project_configs() {
  local current_id="$1" current_credential="$2" current_name="$3" rotation_from="${4:-}"
  [[ -d "$CONFIG_DIR/projects" ]] || return 0
  DEVICE_ID_VALUE="$current_id" CREDENTIAL_VALUE="$current_credential" NAME_VALUE="$current_name" \
    ROTATION_VALUE="$rotation_from" python3 - "$CONFIG_DIR/projects" <<'PY'
import glob, json, os, sys
for path in glob.glob(os.path.join(sys.argv[1], '*.json')):
    try:
        data = json.load(open(path, encoding='utf-8'))
        data['device_id'] = os.environ['DEVICE_ID_VALUE']
        data['credential'] = os.environ['CREDENTIAL_VALUE']
        data['device_name'] = os.environ['NAME_VALUE']
        data['config_migration_pending'] = True
        if os.environ['ROTATION_VALUE']:
            data['rotation_from_device_id'] = os.environ['ROTATION_VALUE']
        temporary = path + '.tmp'
        with open(temporary, 'w', encoding='utf-8') as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.write('\n')
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except Exception as error:
        raise SystemExit(f'기존 프로젝트 설정 갱신 실패: {path}: {error}')
PY
}

clear_recovery_state() {
  local rotation_complete="${1:-false}"
  ROTATION_COMPLETE="$rotation_complete" python3 - "$IDENTITY_FILE" "$CONFIG_DIR/projects" <<'PY'
import glob, json, os, sys
paths = [sys.argv[1], *glob.glob(os.path.join(sys.argv[2], '*.json'))]
for path in paths:
    if not os.path.isfile(path):
        continue
    data = json.load(open(path, encoding='utf-8'))
    data['config_migration_pending'] = False
    if os.environ['ROTATION_COMPLETE'] == 'true':
        data['rotation_from_device_id'] = ''
    temporary = path + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as output:
        json.dump(data, output, ensure_ascii=False, indent=2)
        output.write('\n')
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
PY
}

finalize_rotation() {
  local current_id="$1" current_credential="$2" previous_id="$3" body
  [[ -n "$previous_id" ]] || return 0
  body="$(DEVICE_ID_VALUE="$current_id" CREDENTIAL_VALUE="$current_credential" PREVIOUS_ID_VALUE="$previous_id" python3 - <<'PY'
import json, os
print(json.dumps({
  'p_device_id': os.environ['DEVICE_ID_VALUE'],
  'p_device_credential': os.environ['CREDENTIAL_VALUE'],
  'p_previous_device_id': os.environ['PREVIOUS_ID_VALUE'],
}))
PY
)"
  if ! curl "${REMOTE_CURL_ARGS[@]}" --fail-with-body --silent --show-error \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H 'Content-Type: application/json' \
    --data-binary "$body" "${SUPABASE_URL%/}/rest/v1/rpc/portmgr_finalize_remote_device_rotation" >/dev/null; then
    printf '경고: 새 단말 설정은 저장됐지만 이전 자격 폐기를 아직 확정하지 못했습니다. 다음 상태 갱신에서 재시도합니다.\n' >&2
    return 1
  fi
  return 0
}

confirm_claim() {
  local current_id="$1" current_credential="$2" body
  body="$(DEVICE_ID_VALUE="$current_id" CREDENTIAL_VALUE="$current_credential" python3 - <<'PY'
import json, os
print(json.dumps({
  'p_device_id': os.environ['DEVICE_ID_VALUE'],
  'p_device_credential': os.environ['CREDENTIAL_VALUE'],
}))
PY
)"
  if ! curl "${REMOTE_CURL_ARGS[@]}" --fail-with-body --silent --show-error \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H 'Content-Type: application/json' \
    --data-binary "$body" "${SUPABASE_URL%/}/rest/v1/rpc/portmgr_confirm_remote_device_claim" >/dev/null; then
    printf '경고: 로컬 identity는 저장됐지만 서버 확인은 다음 상태 갱신에서 재시도합니다.\n' >&2
    return 1
  fi
  python3 - "$IDENTITY_FILE" "$CONFIG_DIR/projects" <<'PY'
import glob, json, os, sys
for path in [sys.argv[1], *glob.glob(os.path.join(sys.argv[2], '*.json'))]:
    if not os.path.isfile(path):
        continue
    data = json.load(open(path, encoding='utf-8'))
    data['provisioning_confirmation_pending'] = False
    temporary = path + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as output:
        json.dump(data, output, ensure_ascii=False, indent=2)
        output.write('\n')
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
PY
}

cancel_unpersisted_claim() {
  local current_id="$1" current_credential="$2" body
  body="$(DEVICE_ID_VALUE="$current_id" CREDENTIAL_VALUE="$current_credential" python3 - <<'PY'
import json, os
print(json.dumps({
  'p_device_id': os.environ['DEVICE_ID_VALUE'],
  'p_device_credential': os.environ['CREDENTIAL_VALUE'],
}))
PY
)"
  curl "${REMOTE_CURL_ARGS[@]}" --fail-with-body --silent --show-error \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H 'Content-Type: application/json' \
    --data-binary "$body" "${SUPABASE_URL%/}/rest/v1/rpc/portmgr_cancel_remote_device_claim" >/dev/null
}

EXISTING_DEVICE_ID="$(read_config_value device_id)"
EXISTING_CREDENTIAL="$(read_config_value credential)"
EXISTING_SUPABASE_URL="$(read_config_value supabase_url)"
ROTATION_FROM_DEVICE_ID="$(read_config_value rotation_from_device_id)"
CONFIG_MIGRATION_PENDING="$(read_config_flag config_migration_pending)"
PROVISIONING_CONFIRMATION_PENDING="$(read_config_flag provisioning_confirmation_pending)"
MEMORY_ID=""

if [[ -n "$PROJECT_ACTION" ]]; then
  SUPABASE_URL="$(read_config_value supabase_url)"
  ANON_KEY="$(read_config_value anon_key)"
  DEVICE_NAME="$(read_config_value device_name)"
  ENVIRONMENT_KIND="$(read_config_value environment_kind)"
  [[ "$WORKSPACE_ROOT" != "/home/ubuntu/projects" ]] || WORKSPACE_ROOT="$(read_config_value workspace_root)"
  DEVICE_ID="$EXISTING_DEVICE_ID"
  DEVICE_CREDENTIAL="$EXISTING_CREDENTIAL"
fi

if [[ "$SYNC_ONLY" == true ]]; then
  SUPABASE_URL="$(read_config_value supabase_url)"
  ANON_KEY="$(read_config_value anon_key)"
  DEVICE_NAME="$(read_config_value device_name)"
  ENVIRONMENT_KIND="$(read_config_value environment_kind)"
  PROJECT_PATH="$(read_config_value project_path)"
  WORKSPACE_ROOT="$(read_config_value workspace_root)"
  DEVICE_ID="$EXISTING_DEVICE_ID"
  DEVICE_CREDENTIAL="$EXISTING_CREDENTIAL"
  MEMORY_ID="$(read_config_value memory_id)"
elif [[ -z "$PROJECT_ACTION" ]]; then
  [[ "$TOKEN" =~ ^[0-9a-f]{64}$ ]] || fail "등록 토큰이 없거나 형식이 올바르지 않습니다."
  if [[ "$EXISTING_SUPABASE_URL" != "${SUPABASE_URL%/}" ]]; then
    EXISTING_DEVICE_ID=""
    EXISTING_CREDENTIAL=""
  fi
fi

[[ -n "$WORKSPACE_ROOT" ]] || WORKSPACE_ROOT="$HOME/projects"

[[ "$SUPABASE_URL" == https://* ]] || fail "Supabase HTTPS 주소가 필요합니다."
[[ -n "$ANON_KEY" ]] || fail "Supabase anon key가 필요합니다."
[[ -n "$DEVICE_NAME" ]] || fail "단말 이름이 필요합니다."
[[ "$WORKSPACE_ROOT" == /* ]] || fail "작업 루트는 절대경로여야 합니다."
if [[ -n "$PROJECT_PATH" ]]; then
  [[ "$PROJECT_PATH" == /* ]] || fail "프로젝트 절대경로가 필요합니다."
  [[ -d "$PROJECT_PATH" ]] || fail "프로젝트 폴더가 없습니다: $PROJECT_PATH"
  [[ -f "$PROJECT_PATH/.agent-memory/config.json" ]] || fail ".agent-memory/config.json이 없습니다: $PROJECT_PATH"
fi
if [[ "$PROVISIONING_CONFIRMATION_PENDING" == true && \
  ( "$SYNC_ONLY" == true || -n "$PROJECT_ACTION" ) ]]; then
  confirm_claim "$DEVICE_ID" "$DEVICE_CREDENTIAL" || true
fi
if [[ ( "$CONFIG_MIGRATION_PENDING" == true || -n "$ROTATION_FROM_DEVICE_ID" ) && \
  ( "$SYNC_ONLY" == true || -n "$PROJECT_ACTION" ) ]]; then
  migrate_project_configs "$DEVICE_ID" "$DEVICE_CREDENTIAL" "$DEVICE_NAME" "$ROTATION_FROM_DEVICE_ID"
  if [[ -n "$ROTATION_FROM_DEVICE_ID" ]]; then
    if finalize_rotation "$DEVICE_ID" "$DEVICE_CREDENTIAL" "$ROTATION_FROM_DEVICE_ID"; then
      clear_recovery_state true
    fi
  else
    clear_recovery_state false
  fi
fi

HOSTNAME_VALUE="$(hostname 2>/dev/null || printf 'linux-host')"
OS_RELEASE="$(uname -srv 2>/dev/null || true)"
ARCHITECTURE="$(uname -m 2>/dev/null || true)"
PLATFORM="linux"
BUN_READY_CODE=0
API_READY_CODE=0
HERMES_READY_CODE=0
if command -v bun >/dev/null 2>&1 || [[ -x "$HOME/.bun/bin/bun" ]]; then
  BUN_READY_CODE=1
fi
if agentstoz_api_ready; then
  API_READY_CODE=1
fi
if command -v hermes >/dev/null 2>&1 \
  || command -v hermes-agent >/dev/null 2>&1 \
  || [[ -x "$HOME/.local/bin/hermes" ]]; then
  HERMES_READY_CODE=1
fi
# 기존 DB의 agent_version(40자)에 들어가는 후방 호환 확장이다. 예: 4|b1a0h1
# b=Bun, a=AgentsToZ API, h=Hermes. 자격·경로·환경변수는 절대 보고하지 않는다.
AGENT_REPORT_VERSION="${AGENT_VERSION}|b${BUN_READY_CODE}a${API_READY_CODE}h${HERMES_READY_CODE}"

if [[ "$SYNC_ONLY" == false && -z "$PROJECT_ACTION" ]]; then
  # 토큰을 소비하거나 identity를 바꾸기 전에 복구 가능한 최신 에이전트를 먼저 설치한다.
  # 이후 어느 단계가 실패해도 기존 timer/agentstoz-status가 v3로 재개할 수 있다.
  install -m 700 "$0" "$CONFIG_DIR/agentstoz-remote-device.sh"
  CLAIM_BODY="$(TOKEN_VALUE="$TOKEN" HOSTNAME_VALUE="$HOSTNAME_VALUE" PLATFORM_VALUE="$PLATFORM" \
  ENVIRONMENT_VALUE="$ENVIRONMENT_KIND" OS_RELEASE_VALUE="$OS_RELEASE" ARCH_VALUE="$ARCHITECTURE" \
  AGENT_VALUE="$AGENT_REPORT_VERSION" DEVICE_ID_VALUE="$EXISTING_DEVICE_ID" CREDENTIAL_VALUE="$EXISTING_CREDENTIAL" \
  FORCE_NEW_VALUE="$FORCE_NEW_DEVICE" \
  python3 - <<'PY'
import json, os
print(json.dumps({
  'p_token': os.environ['TOKEN_VALUE'],
  'p_hostname': os.environ['HOSTNAME_VALUE'],
  'p_platform': os.environ['PLATFORM_VALUE'],
  'p_environment_kind': os.environ['ENVIRONMENT_VALUE'],
  'p_os_release': os.environ['OS_RELEASE_VALUE'],
  'p_architecture': os.environ['ARCH_VALUE'],
  'p_agent_version': os.environ['AGENT_VALUE'],
  'p_existing_device_id': os.environ['DEVICE_ID_VALUE'] or None,
  'p_existing_credential': os.environ['CREDENTIAL_VALUE'] or None,
  'p_force_new': os.environ['FORCE_NEW_VALUE'] == 'true',
}))
PY
)"

  if [[ -n "$PROJECT_PATH" ]]; then
    CLAIM_RPC="portmgr_claim_remote_device_enrollment"
  else
    CLAIM_RPC="portmgr_claim_remote_host_enrollment"
  fi
  CLAIM_RESPONSE="$(curl "${REMOTE_CURL_ARGS[@]}" --fail-with-body --silent --show-error \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H 'Content-Type: application/json' \
  --data-binary "$CLAIM_BODY" "${SUPABASE_URL%/}/rest/v1/rpc/$CLAIM_RPC")" \
    || fail "등록 토큰을 사용할 수 없습니다. 만료되었으면 포털에서 새 명령을 만드세요."

  CLAIM_LINE="$(python3 - "$CLAIM_RESPONSE" <<'PY'
import json, sys
rows = json.loads(sys.argv[1])
row = rows[0] if isinstance(rows, list) and rows else rows
values = []
for key in ('device_id', 'device_credential', 'target_memory_id', 'device_name', 'previous_device_id'):
    value = row.get(key, '') if isinstance(row, dict) else ''
    cleaned = value.replace('\t', ' ').replace('\n', ' ') if isinstance(value, str) else ''
    values.append(cleaned or '__AGENTSTOZ_EMPTY__')
print('\t'.join(values))
PY
)"
  IFS=$'\t' read -r DEVICE_ID DEVICE_CREDENTIAL MEMORY_ID CLAIMED_DEVICE_NAME PREVIOUS_DEVICE_ID <<< "$CLAIM_LINE"
  [[ "$MEMORY_ID" != "__AGENTSTOZ_EMPTY__" ]] || MEMORY_ID=""
  [[ "$CLAIMED_DEVICE_NAME" != "__AGENTSTOZ_EMPTY__" ]] || CLAIMED_DEVICE_NAME="$DEVICE_NAME"
  [[ "$PREVIOUS_DEVICE_ID" != "__AGENTSTOZ_EMPTY__" ]] || PREVIOUS_DEVICE_ID=""
  [[ -n "$DEVICE_ID" && -n "$DEVICE_CREDENTIAL" ]] || fail "Supabase 등록 응답이 완전하지 않습니다."

  CLAIM_DURABLE=false
  cancel_claim_on_exit() {
    local code=$?
    trap - EXIT
    if [[ "$CLAIM_DURABLE" == false ]]; then
      cancel_unpersisted_claim "$DEVICE_ID" "$DEVICE_CREDENTIAL" \
        || printf '경고: 저장 전 등록 취소도 실패했습니다. 만료 후 포털이 자동 정리합니다.\n' >&2
    fi
    exit "$code"
  }
  trap cancel_claim_on_exit EXIT

  MIGRATION_NEEDED=false
  if [[ "$DEVICE_ID" != "$EXISTING_DEVICE_ID" && \
    ( -z "$EXISTING_SUPABASE_URL" || "$EXISTING_SUPABASE_URL" == "${SUPABASE_URL%/}" ) ]]; then
    MIGRATION_NEEDED=true
  fi

  TMP_CONFIG="$(mktemp "$CONFIG_DIR/remote-device.json.XXXXXX")"
  SUPABASE_VALUE="${SUPABASE_URL%/}" ANON_VALUE="$ANON_KEY" DEVICE_ID_VALUE="$DEVICE_ID" \
    CREDENTIAL_VALUE="$DEVICE_CREDENTIAL" MEMORY_VALUE="$MEMORY_ID" NAME_VALUE="$DEVICE_NAME" \
    ENVIRONMENT_VALUE="$ENVIRONMENT_KIND" PROJECT_VALUE="$PROJECT_PATH" WORKSPACE_VALUE="$WORKSPACE_ROOT" \
    ROTATION_VALUE="$PREVIOUS_DEVICE_ID" MIGRATION_VALUE="$MIGRATION_NEEDED" \
  python3 - "$TMP_CONFIG" <<'PY'
import json, os, sys
with open(sys.argv[1], 'w', encoding='utf-8') as f:
    json.dump({
      'schema_version': 2,
      'supabase_url': os.environ['SUPABASE_VALUE'],
      'anon_key': os.environ['ANON_VALUE'],
      'device_id': os.environ['DEVICE_ID_VALUE'],
      'credential': os.environ['CREDENTIAL_VALUE'],
      'memory_id': os.environ['MEMORY_VALUE'],
      'device_name': os.environ['NAME_VALUE'],
      'environment_kind': os.environ['ENVIRONMENT_VALUE'],
      'project_path': os.environ['PROJECT_VALUE'],
      'workspace_root': os.environ['WORKSPACE_VALUE'],
      'rotation_from_device_id': os.environ['ROTATION_VALUE'],
      'config_migration_pending': os.environ['MIGRATION_VALUE'] == 'true',
      'provisioning_confirmation_pending': True,
    }, f, ensure_ascii=False, indent=2)
    f.write('\n')
PY
  chmod 600 "$TMP_CONFIG"
  mv "$TMP_CONFIG" "$IDENTITY_FILE"
  CLAIM_DURABLE=true
  trap - EXIT
  confirm_claim "$DEVICE_ID" "$DEVICE_CREDENTIAL" || true

  # 새 identity를 먼저 원자 저장한다. 이후 프로젝트별 설정 쓰기가 중단되어도
  # rotation_from_device_id가 남아 다음 --sync가 이관을 재개할 수 있다.
  if [[ "$MIGRATION_NEEDED" == true ]]; then
    migrate_project_configs "$DEVICE_ID" "$DEVICE_CREDENTIAL" "$DEVICE_NAME" "$PREVIOUS_DEVICE_ID"
  fi

  PROJECT_CONFIG_DIR="$CONFIG_DIR/projects"
  mkdir -p "$PROJECT_CONFIG_DIR"
  chmod 700 "$PROJECT_CONFIG_DIR"
  if [[ -n "$MEMORY_ID" ]]; then
    PROJECT_KEY="${MEMORY_ID//[^a-zA-Z0-9._-]/_}"
    cp "$IDENTITY_FILE" "$PROJECT_CONFIG_DIR/$PROJECT_KEY.json"
    chmod 600 "$PROJECT_CONFIG_DIR/$PROJECT_KEY.json"
  fi

  if [[ -n "$PREVIOUS_DEVICE_ID" ]]; then
    if finalize_rotation "$DEVICE_ID" "$DEVICE_CREDENTIAL" "$PREVIOUS_DEVICE_ID"; then
      clear_recovery_state true
    fi
  elif [[ "$MIGRATION_NEEDED" == true ]]; then
    clear_recovery_state false
  fi

  LOCAL_BIN_DIR="${AGENTSTOZ_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$LOCAL_BIN_DIR"
  STATUS_COMMAND="$LOCAL_BIN_DIR/agentstoz-status"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -uo pipefail' \
    "agent_script='$CONFIG_DIR/agentstoz-remote-device.sh'" \
    "identity_file='$IDENTITY_FILE'" \
    "project_dir='$PROJECT_CONFIG_DIR'" \
    "lock_file='$CONFIG_DIR/status.lock'" \
    "lock_dir='$CONFIG_DIR/status.lock.d'" \
    'status=0' \
    'if command -v flock >/dev/null 2>&1; then' \
    '  exec 9>"$lock_file"' \
    '  flock -n 9 || { printf "다른 상태 갱신이 실행 중입니다.\\n"; exit 0; }' \
    'else' \
    '  mkdir "$lock_dir" 2>/dev/null || { printf "다른 상태 갱신이 실행 중입니다.\\n"; exit 0; }' \
    '  trap '\''rmdir "$lock_dir" 2>/dev/null || true'\'' EXIT' \
    'fi' \
    '"$agent_script" --sync --config "$identity_file" || status=$?' \
    'for project_config in "$project_dir"/*.json; do' \
    '  [[ -f "$project_config" ]] || continue' \
    '  "$agent_script" --sync --config "$project_config" || status=$?' \
    'done' \
    'exit "$status"' \
    > "$STATUS_COMMAND"
  chmod 700 "$STATUS_COMMAND"

  if command -v systemctl >/dev/null 2>&1; then
    SYSTEMD_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_DIR"
    chmod 700 "$SYSTEMD_DIR"
    cat > "$SYSTEMD_DIR/agentstoz-remote-host-sync.service" <<EOF
[Unit]
Description=AgentsToZ remote host project inventory
After=network-online.target

[Service]
Type=oneshot
ExecStart=$STATUS_COMMAND
TimeoutStartSec=4min
EOF
    cat > "$SYSTEMD_DIR/agentstoz-remote-host-sync.timer" <<'EOF'
[Unit]
Description=Refresh AgentsToZ remote host inventory every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true
Unit=agentstoz-remote-host-sync.service

[Install]
WantedBy=timers.target
EOF
    chmod 600 "$SYSTEMD_DIR/agentstoz-remote-host-sync.service" "$SYSTEMD_DIR/agentstoz-remote-host-sync.timer"
    if ! systemctl --user daemon-reload >/dev/null \
      || ! systemctl --user enable --now agentstoz-remote-host-sync.timer >/dev/null; then
      printf '경고: 자동 상태 갱신 타이머를 켜지 못했습니다. 수동으로 agentstoz-status를 실행할 수 있습니다.\n' >&2
    fi
  fi
fi

report_host_inventory() {
  local projects body response agent_body
  agent_body="$(DEVICE_ID_VALUE="$DEVICE_ID" CREDENTIAL_VALUE="$DEVICE_CREDENTIAL" AGENT_VALUE="$AGENT_REPORT_VERSION" python3 - <<'PY'
import json, os
print(json.dumps({
  'p_device_id': os.environ['DEVICE_ID_VALUE'],
  'p_device_credential': os.environ['CREDENTIAL_VALUE'],
  'p_agent_version': os.environ['AGENT_VALUE'],
}))
PY
)"
  curl "${REMOTE_CURL_ARGS[@]}" --fail-with-body --silent --show-error \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H 'Content-Type: application/json' \
    --data-binary "$agent_body" "${SUPABASE_URL%/}/rest/v1/rpc/portmgr_report_remote_device_agent_version" >/dev/null \
    || fail "원격 에이전트 버전을 보고하지 못했습니다."
  projects="$(API_READY_VALUE="$API_READY_CODE" python3 - "$WORKSPACE_ROOT" <<'PY'
import json, os, subprocess, sys, urllib.request

root = os.path.realpath(sys.argv[1])
paths = {}
topics = {}
bindings_file = os.path.join(
    os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'),
    'com.portmanager.portmanager', 'project-memory-thread-bindings.json')
try:
    registry = json.load(open(bindings_file, encoding='utf-8'))
    for binding in (registry.get('bindings') or {}).values():
        if not isinstance(binding, dict) or str(binding.get('platform', '')).lower() != 'telegram':
            continue
        path = binding.get('canonicalPath')
        if isinstance(path, str) and path:
            topics[os.path.realpath(path)] = {
                'telegram_chat_id': str(binding.get('chatId') or '') or None,
                'telegram_thread_id': str(binding.get('threadId') or '') or None,
            }
except Exception:
    pass
if os.environ.get('API_READY_VALUE') == '1':
    try:
        with urllib.request.urlopen('http://127.0.0.1:3001/api/ports', timeout=5) as opened:
            raw = json.load(opened)
        rows = raw.get('ports', raw) if isinstance(raw, dict) else raw
        for row in rows if isinstance(rows, list) else []:
            path = row.get('folderPath') or row.get('worktreePath')
            if isinstance(path, str) and os.path.isdir(path):
                paths[os.path.realpath(path)] = {
                    'name': str(row.get('name') or os.path.basename(path)),
                    'registered': True,
                }
    except Exception:
        pass

if os.path.isdir(root):
    for name in os.listdir(root):
        if name.startswith('.') or name == 'archive':
            continue
        path = os.path.realpath(os.path.join(root, name))
        if path.startswith(root + os.sep) and os.path.isdir(path):
            paths.setdefault(path, {'name': name, 'registered': False})

def git(path, *args):
    try:
        return subprocess.check_output(['git', '-C', path, *args], stderr=subprocess.DEVNULL, text=True, timeout=10).strip()
    except Exception:
        return ''

projects = []
for path in sorted(paths):
    info = paths[path]
    memory_id = ''
    config = os.path.join(path, '.agent-memory', 'config.json')
    if os.path.isfile(config):
        try:
            value = json.load(open(config, encoding='utf-8')).get('memoryId', '')
            memory_id = value if isinstance(value, str) else ''
        except Exception:
            pass
    is_git = git(path, 'rev-parse', '--is-inside-work-tree') == 'true'
    if not info['registered'] and not memory_id and not is_git:
        continue
    dirty = None
    if is_git:
        dirty = bool(git(path, 'status', '--porcelain=v1', '--untracked-files=normal'))
    projects.append({
        'project_path': path,
        'project_name': info['name'][:160],
        'memory_id': memory_id or None,
        'git_remote_url': git(path, 'remote', 'get-url', 'origin') or None,
        'git_head_sha': git(path, 'rev-parse', 'HEAD') or None,
        'git_branch': git(path, 'symbolic-ref', '--quiet', '--short', 'HEAD') or None,
        'git_dirty': dirty,
        'registered': bool(info['registered']),
        **topics.get(path, {'telegram_chat_id': None, 'telegram_thread_id': None}),
    })
print(json.dumps(projects, ensure_ascii=False, separators=(',', ':')))
PY
)"
  body="$(DEVICE_ID_VALUE="$DEVICE_ID" CREDENTIAL_VALUE="$DEVICE_CREDENTIAL" \
    WORKSPACE_VALUE="$WORKSPACE_ROOT" PROJECTS_VALUE="$projects" python3 - <<'PY'
import json, os
print(json.dumps({
  'p_device_id': os.environ['DEVICE_ID_VALUE'],
  'p_device_credential': os.environ['CREDENTIAL_VALUE'],
  'p_workspace_root': os.environ['WORKSPACE_VALUE'],
  'p_projects': json.loads(os.environ['PROJECTS_VALUE']),
}, ensure_ascii=False))
PY
)"
  response="$(curl "${REMOTE_CURL_ARGS[@]}" --fail-with-body --silent --show-error \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H 'Content-Type: application/json' \
    --data-binary "$body" "${SUPABASE_URL%/}/rest/v1/rpc/portmgr_report_remote_device_inventory")" \
    || fail "호스트 프로젝트 목록을 보고하지 못했습니다."
  python3 - "$response" <<'PY'
import json, sys
rows = json.loads(sys.argv[1])
row = rows[0] if isinstance(rows, list) and rows else rows
print(f"호스트 상태 갱신 완료 · 프로젝트 {row.get('project_count', 0)}개")
PY
  printf '  런타임: Bun %s · AgentsToZ API %s · Hermes %s(선택)\n' \
    "$([[ "$BUN_READY_CODE" == 1 ]] && printf '준비' || printf '필요')" \
    "$([[ "$API_READY_CODE" == 1 ]] && printf '실행 중' || printf '준비 필요')" \
    "$([[ "$HERMES_READY_CODE" == 1 ]] && printf '준비' || printf '미설치')"
}

if [[ -n "$PROJECT_ACTION" ]]; then
  [[ -n "${DEVICE_ID:-}" && -n "${DEVICE_CREDENTIAL:-}" ]] \
    || fail "먼저 Ubuntu 호스트를 등록하세요."
  [[ "$PROJECT_ACTION" == "clone" || "$PROJECT_ACTION" == "memory" || "$PROJECT_ACTION" == "new" ]] \
    || fail "프로젝트 작업은 clone, memory, new 중 하나여야 합니다."
  [[ -n "$PROJECT_NAME" ]] || fail "프로젝트 이름이 필요합니다."
  [[ "$PROJECT_NAME" != "." && "$PROJECT_NAME" != ".." && "$PROJECT_NAME" != *"/"* && "$PROJECT_NAME" != *"\\"* ]] \
    || fail "프로젝트 이름에는 경로 구분자를 사용할 수 없습니다."
  [[ "$PROJECT_ACTION" != "clone" || -n "$REPOSITORY_URL" ]] || fail "Git 저장소 URL이 필요합니다."
  if [[ "$PROJECT_ACTION" == "clone" ]]; then
    [[ "$REPOSITORY_URL" == https://github.com/*/* || "$REPOSITORY_URL" == git@github.com:*/* ]] \
      || fail "GitHub 저장소 URL만 복제할 수 있습니다."
  fi
  [[ "$PROJECT_ACTION" != "memory" || "$REQUESTED_MEMORY_ID" =~ ^[0-9a-fA-F-]{36}$ ]] \
    || fail "장기기억 ID 형식이 올바르지 않습니다."
  if ! agentstoz_api_ready; then
    printf '%s\n' \
      '프로젝트는 아직 만들지 않았습니다.' \
      '먼저 AWS 런타임 준비 안내를 AI에 붙여 넣고 AgentsToZ API를 실행한 뒤,' \
      '~/.local/bin/agentstoz-status 를 실행하고 이 프로젝트 명령을 다시 실행하세요.'
    exit 0
  fi
  # 최소 Ubuntu 호스트는 Git 없이도 먼저 등록하고 런타임 상태를 보고할 수 있다.
  # 실제 파일을 만드는 프로젝트 단계에서만 Git을 필수로 요구한다.
  need git
  mkdir -p "$WORKSPACE_ROOT"
  TARGET_PATH="$(python3 - "$WORKSPACE_ROOT" "$PROJECT_NAME" <<'PY'
import os, sys
root = os.path.realpath(sys.argv[1])
target = os.path.realpath(os.path.join(root, sys.argv[2]))
if not target.startswith(root + os.sep):
    raise SystemExit('프로젝트 경로가 작업 루트 밖입니다.')
print(target)
PY
)"
  [[ ! -e "$TARGET_PATH" ]] || fail "이미 있는 프로젝트 폴더입니다: $TARGET_PATH"
  ACTION_IN_PROGRESS=true
  STAGING_PATH=""
  recover_failed_action() {
    local code=$?
    local failed_source="$TARGET_PATH"
    [[ -n "$STAGING_PATH" && -e "$STAGING_PATH" ]] && failed_source="$STAGING_PATH"
    if [[ "$ACTION_IN_PROGRESS" == true && -e "$failed_source" ]]; then
      local failed_root="$WORKSPACE_ROOT/.agentstoz-failed"
      mkdir -p "$failed_root"
      local failed_path="$failed_root/${PROJECT_NAME}-$(date -u +%Y%m%dT%H%M%SZ)"
      mv -- "$failed_source" "$failed_path"
      printf '실패한 생성물을 복구 폴더로 이동했습니다: %s\n' "$failed_path" >&2
    fi
    exit "$code"
  }
  trap recover_failed_action ERR

  if [[ "$PROJECT_ACTION" == "clone" ]]; then
    STAGING_ROOT="$WORKSPACE_ROOT/.agentstoz-staging"
    mkdir -p "$STAGING_ROOT"
    STAGING_PATH="$STAGING_ROOT/${PROJECT_NAME}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    [[ ! -e "$STAGING_PATH" ]] || fail "복제 준비 경로가 이미 있습니다: $STAGING_PATH"
    if command -v timeout >/dev/null 2>&1; then
      timeout --signal=TERM 5m git clone -- "$REPOSITORY_URL" "$STAGING_PATH"
    else
      git clone -- "$REPOSITORY_URL" "$STAGING_PATH"
    fi
    mv -- "$STAGING_PATH" "$TARGET_PATH"
    STAGING_PATH=""
  else
    mkdir "$TARGET_PATH"
    git -C "$TARGET_PATH" init >/dev/null
    git -C "$TARGET_PATH" -c user.name=AgentsToZ -c user.email=agentstoz@local \
      commit --allow-empty -m "chore: initialize project" >/dev/null
  fi

  init_args=(--get --data-urlencode "folderPath=$TARGET_PATH" --data-urlencode "projectName=$PROJECT_NAME" \
    --data-urlencode "agent=claude" --data-urlencode "autoBackup=true")
  if [[ -n "$REQUESTED_MEMORY_ID" ]]; then
    init_args+=(--data-urlencode "memoryId=$REQUESTED_MEMORY_ID")
  fi
  INIT_RESPONSE="$(curl --connect-timeout 1 --max-time 60 --fail-with-body --silent --show-error -X POST "${init_args[@]}" \
    http://127.0.0.1:3001/api/project-memory/init)"
  curl --connect-timeout 1 --max-time 60 --fail-with-body --silent --show-error -X POST --get \
    --data-urlencode "folderPath=$TARGET_PATH" --data-urlencode "projectName=$PROJECT_NAME" \
    http://127.0.0.1:3001/api/project-memory/register-project >/dev/null
  # 폴더와 앱 등록이 끝난 뒤부터는 원격 기억 장애가 나도 프로젝트를 격리하지 않는다.
  # 그대로 두어 /memory_sync만 재시도할 수 있어야 ports.json에 고아 경로가 생기지 않는다.
  ACTION_IN_PROGRESS=false
  trap - ERR
  if [[ -n "$REQUESTED_MEMORY_ID" ]]; then
    if ! curl --connect-timeout 1 --max-time 120 --fail-with-body --silent --show-error -X POST --get \
      --data-urlencode "folderPath=$TARGET_PATH" --data-urlencode "projectName=$PROJECT_NAME" \
      http://127.0.0.1:3001/api/project-memory/pull >/dev/null; then
      report_host_inventory
      fail "프로젝트는 보존·등록했지만 장기기억 복원에 실패했습니다. /memory_sync를 재시도하세요: $TARGET_PATH"
    fi
  else
    if ! curl --connect-timeout 1 --max-time 120 --fail-with-body --silent --show-error -X POST --get \
      --data-urlencode "folderPath=$TARGET_PATH" --data-urlencode "projectName=$PROJECT_NAME" \
      http://127.0.0.1:3001/api/project-memory/push >/dev/null; then
      report_host_inventory
      fail "프로젝트는 보존·등록했지만 장기기억 백업에 실패했습니다. /memory_sync를 재시도하세요: $TARGET_PATH"
    fi
  fi
  report_host_inventory
  python3 - "$INIT_RESPONSE" "$TARGET_PATH" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
memory_id = (data.get('config') or {}).get('memoryId', '')
print('프로젝트 준비 완료')
print('  경로: ' + sys.argv[2])
print('  장기기억: ' + memory_id)
PY
  exit 0
fi

[[ -n "${DEVICE_ID:-}" && -n "${DEVICE_CREDENTIAL:-}" ]] \
  || fail "저장된 원격 호스트 설정이 없습니다. 포털에서 새 등록 명령을 실행하세요."
if [[ -z "$MEMORY_ID" ]]; then
  report_host_inventory
  if [[ "$SYNC_ONLY" == false ]]; then
    printf '호스트 등록 완료\n  단말: %s (%s)\n  작업 루트: %s\n' "$DEVICE_NAME" "$DEVICE_ID" "$WORKSPACE_ROOT"
  fi
  exit 0
fi

[[ -n "${DEVICE_ID:-}" && -n "${DEVICE_CREDENTIAL:-}" && -n "$MEMORY_ID" ]] \
  || fail "저장된 원격 단말 설정이 없습니다. 포털에서 새 등록 명령을 실행하세요."

MEMORY_SOURCE="$(python3 - "$PROJECT_PATH/.agent-memory/config.json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding='utf-8')).get('sourcePath', '')
print(value if isinstance(value, str) else '')
PY
)"
[[ -n "$MEMORY_SOURCE" ]] || fail "장기기억 sourcePath가 없습니다."

CONTENT_HASH="$(python3 - "$PROJECT_PATH" "$MEMORY_SOURCE" <<'PY'
import hashlib, json, os, sys
root, source = os.path.realpath(sys.argv[1]), sys.argv[2]
source_path = os.path.realpath(os.path.join(root, source))
if not source_path.startswith(root + os.sep) or not os.path.isfile(source_path):
    raise SystemExit('장기기억 파일이 프로젝트 밖이거나 없습니다.')
manifest_path = os.path.join(root, '.agent-memory', 'notes', 'manifest.json')
if os.path.isfile(manifest_path):
    manifest = json.load(open(manifest_path, encoding='utf-8'))
    chunks = []
    notes_root = os.path.realpath(os.path.join(root, '.agent-memory', 'notes'))
    for part in manifest.get('parts', []):
        part_path = os.path.realpath(os.path.join(notes_root, part.get('file', '')))
        if not part_path.startswith(notes_root + os.sep) or not os.path.isfile(part_path):
            raise SystemExit('장기기억 노트가 프로젝트 밖이거나 없습니다.')
        chunks.append(open(part_path, 'rb').read())
    content = b''.join(chunks)
else:
    content = open(source_path, 'rb').read()
print(hashlib.sha256(content).hexdigest())
PY
)"

GIT_HEAD=""; GIT_BRANCH=""; GIT_REMOTE=""; GIT_UPSTREAM=""; GIT_AHEAD=0; GIT_BEHIND=0
GIT_DIRTY=false; GIT_COMMIT_AT=""; GIT_FETCH_OK=true; GIT_FETCH_ERROR=""
if git -C "$PROJECT_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_HEAD="$(git -C "$PROJECT_PATH" rev-parse HEAD 2>/dev/null || true)"
  GIT_BRANCH="$(git -C "$PROJECT_PATH" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  GIT_REMOTE="$(git -C "$PROJECT_PATH" remote get-url origin 2>/dev/null || true)"
  if command -v timeout >/dev/null 2>&1; then
    FETCH_OUTPUT="$(timeout --signal=TERM 30s git -C "$PROJECT_PATH" fetch --quiet --prune origin 2>&1)" || GIT_FETCH_OK=false
  else
    FETCH_OUTPUT="$(git -C "$PROJECT_PATH" fetch --quiet --prune origin 2>&1)" || GIT_FETCH_OK=false
  fi
  if [[ "$GIT_FETCH_OK" == false ]]; then
    GIT_FETCH_ERROR="${FETCH_OUTPUT:0:500}"
  fi
  GIT_UPSTREAM="$(git -C "$PROJECT_PATH" rev-parse '@{u}' 2>/dev/null || true)"
  if [[ -n "$GIT_HEAD" && -n "$GIT_UPSTREAM" ]]; then
    COUNTS="$(git -C "$PROJECT_PATH" rev-list --left-right --count "$GIT_HEAD...$GIT_UPSTREAM" 2>/dev/null || printf '0 0')"
    GIT_AHEAD="${COUNTS%%[[:space:]]*}"
    GIT_BEHIND="${COUNTS##*[[:space:]]}"
  fi
  [[ -z "$(git -C "$PROJECT_PATH" status --porcelain=v1 --untracked-files=normal 2>/dev/null)" ]] || GIT_DIRTY=true
  GIT_COMMIT_AT="$(git -C "$PROJECT_PATH" show -s --format=%cI HEAD 2>/dev/null || true)"
fi

REPORT_BODY="$(DEVICE_ID_VALUE="$DEVICE_ID" CREDENTIAL_VALUE="$DEVICE_CREDENTIAL" MEMORY_VALUE="$MEMORY_ID" \
  PATH_VALUE="$PROJECT_PATH" HASH_VALUE="$CONTENT_HASH" HEAD_VALUE="$GIT_HEAD" BRANCH_VALUE="$GIT_BRANCH" \
  REMOTE_VALUE="$GIT_REMOTE" UPSTREAM_VALUE="$GIT_UPSTREAM" AHEAD_VALUE="$GIT_AHEAD" BEHIND_VALUE="$GIT_BEHIND" \
  DIRTY_VALUE="$GIT_DIRTY" COMMIT_VALUE="$GIT_COMMIT_AT" FETCH_OK_VALUE="$GIT_FETCH_OK" FETCH_ERROR_VALUE="$GIT_FETCH_ERROR" \
  python3 - <<'PY'
import json, os
def empty(value): return value or None
print(json.dumps({
  'p_device_id': os.environ['DEVICE_ID_VALUE'],
  'p_device_credential': os.environ['CREDENTIAL_VALUE'],
  'p_memory_id': os.environ['MEMORY_VALUE'],
  'p_source_path': os.environ['PATH_VALUE'],
  'p_content_hash': empty(os.environ['HASH_VALUE']),
  'p_git_head_sha': empty(os.environ['HEAD_VALUE']),
  'p_git_branch': empty(os.environ['BRANCH_VALUE']),
  'p_git_remote_url': empty(os.environ['REMOTE_VALUE']),
  'p_git_upstream_sha': empty(os.environ['UPSTREAM_VALUE']),
  'p_git_ahead': int(os.environ['AHEAD_VALUE'] or 0),
  'p_git_behind': int(os.environ['BEHIND_VALUE'] or 0),
  'p_git_dirty': os.environ['DIRTY_VALUE'] == 'true',
  'p_git_commit_at': empty(os.environ['COMMIT_VALUE']),
  'p_git_fetch_ok': os.environ['FETCH_OK_VALUE'] == 'true',
  'p_git_fetch_error': empty(os.environ['FETCH_ERROR_VALUE']),
}))
PY
)"

REPORT_RESPONSE="$(curl "${REMOTE_CURL_ARGS[@]}" --fail-with-body --silent --show-error \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H 'Content-Type: application/json' \
  --data-binary "$REPORT_BODY" "${SUPABASE_URL%/}/rest/v1/rpc/portmgr_report_remote_device_status")" \
  || fail "단말 상태를 보고하지 못했습니다."

if [[ "$SYNC_ONLY" == true ]]; then printf '상태 갱신 완료\n'; else printf '등록 완료\n'; fi
printf '  단말: %s (%s)\n' "$DEVICE_NAME" "$DEVICE_ID"
printf '  프로젝트: %s\n' "$PROJECT_PATH"
printf '  장기기억: %s\n' "$MEMORY_ID"
printf '  로컬 HEAD: %s\n' "${GIT_HEAD:-없음}"
printf '  원격 HEAD: %s\n' "${GIT_UPSTREAM:-없음}"
if [[ "$GIT_FETCH_OK" == false ]]; then printf '  Git fetch: 실패 — %s\n' "$GIT_FETCH_ERROR"; fi
if [[ "$SYNC_ONLY" == false ]]; then
  printf '  다음 상태 갱신: %s\n' "${STATUS_COMMAND:-$HOME/.local/bin/agentstoz-status}"
fi
python3 - "$REPORT_RESPONSE" <<'PY'
import json, sys
rows = json.loads(sys.argv[1])
row = rows[0] if isinstance(rows, list) and rows else rows
print('  장기기억 동기화: ' + ('최신 일치' if row.get('in_sync') else '확인 필요'))
PY
