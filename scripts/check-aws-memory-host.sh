#!/usr/bin/env bash
set -euo pipefail

API_BASE="${AGENTSTOZ_API_BASE:-http://127.0.0.1:3001}"
HERMES_BIN="${HERMES_BIN:-$(command -v hermes || true)}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_JSON="${AGENTSTOZ_CONTEXT_API_CONTRACT:-$SCRIPT_DIR/../context-api-contract.json}"

if [[ -z "$HERMES_BIN" || ! -x "$HERMES_BIN" ]]; then
  printf 'AgentsToZ health: Hermes CLI executable not found\n' >&2
  exit 1
fi
if [[ ! -r "$CONTRACT_JSON" ]]; then
  printf 'AgentsToZ health: context API contract not readable: %s\n' "$CONTRACT_JSON" >&2
  exit 1
fi

HEALTH_JSON="$(mktemp)"
trap 'rm -f "$HEALTH_JSON"' EXIT

curl --fail-with-body --silent --show-error \
  --max-time 10 --retry 1 \
  "$API_BASE/api/health" >"$HEALTH_JSON"

python3 - "$HEALTH_JSON" "$CONTRACT_JSON" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
with open(sys.argv[2], encoding="utf-8") as handle:
    contract = json.load(handle)
required = set(contract.get("requiredCapabilities") or [])
expected_schema = contract.get("schemaVersion")
if not isinstance(expected_schema, int) or expected_schema < 1 or not required:
    raise SystemExit("AgentsToZ health: context API contract is invalid")
if payload.get("service") != "agentstoz-api":
    raise SystemExit("AgentsToZ health: unexpected API service identity")
if payload.get("schemaVersion", 0) < expected_schema:
    raise SystemExit("AgentsToZ health: context API schema is outdated")
missing = required - set(payload.get("capabilities") or [])
if missing:
    raise SystemExit("AgentsToZ health: context API capabilities are incomplete")
PY

if systemctl --user is-active --quiet hermes-gateway.service; then
  if ! "$HERMES_BIN" gateway status --deep >/dev/null 2>&1; then
    printf 'AgentsToZ health: active user Hermes gateway failed deep status\n' >&2
    exit 1
  fi
  GATEWAY_MODE="user"
elif systemctl is-active --quiet hermes-gateway.service; then
  if ! "$HERMES_BIN" gateway status --system --deep >/dev/null 2>&1; then
    printf 'AgentsToZ health: active system Hermes gateway failed deep status\n' >&2
    exit 1
  fi
  GATEWAY_MODE="system"
else
  printf 'AgentsToZ health: Hermes gateway service is not active\n' >&2
  exit 1
fi

printf 'AgentsToZ memory host health: PASS (gateway=%s)\n' "$GATEWAY_MODE"
