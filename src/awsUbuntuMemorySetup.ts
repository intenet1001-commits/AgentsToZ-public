import {
  CONTEXT_API_SCHEMA_VERSION,
  REQUIRED_CONTEXT_API_CAPABILITIES,
} from './contextApiVersion';
import { CURRENT_PROJECT_MEMORY_VERSION } from './projectMemoryVersion';

export interface AwsUbuntuMemorySetupInput {
  supabaseUrl: string;
  supabaseAnonKey: string;
  projectReference: string;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function safeRepositoryReference(value: string): string {
  const normalized = singleLine(value);
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol)) return normalized;
    url.username = '';
    url.password = '';
    // Query strings and fragments are not repository identity. Hosted Git URLs
    // commonly carry temporary access tokens there, so copied setup material
    // must drop both even when userinfo was already empty.
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return normalized;
  }
}

export function buildAwsUbuntuMemorySetupPrompt(input: AwsUbuntuMemorySetupInput): string {
  const supabaseUrl = singleLine(input.supabaseUrl);
  const supabaseAnonKey = singleLine(input.supabaseAnonKey);
  const projectReference = safeRepositoryReference(input.projectReference);
  const requiredContextCapabilities = REQUIRED_CONTEXT_API_CAPABILITIES
    .map(capability => JSON.stringify(capability))
    .join(',');
  return [
    'AWS Ubuntu에 clone한 프로젝트에서 세션 기억하기를 로컬 AgentsToZ 앱과 같은 Supabase 기억에 연결해줘.',
    '이것은 “앱 없는 PC용 로컬 기억” 설정이 아니다. Ubuntu에서 AgentsToZ API 서버와 Hermes gateway를 실행하고 topic 연결 → /remember_session 흐름을 사용한다.',
    '',
    '중요한 보안 경고:',
    '- service-role key는 장기기억 전용 키가 아니라 Supabase 프로젝트 전체의 RLS를 우회하는 관리자 키다. 이 Ubuntu 호스트가 침해되면 프로젝트 전체 데이터가 노출·변조될 수 있다.',
    '- 전용 비밀관리 또는 좁은 권한의 서버 프록시가 없다면 최소 권한의 전용 OS 사용자, SSH 제한, 보안 업데이트, 디스크 보호가 적용된 신뢰 가능한 호스트에서만 진행한다.',
    '- 아래 anon key만 이 프롬프트에 포함한다. service-role key는 Supabase Dashboard에서 다시 확인해 Ubuntu 터미널에 직접 입력하며 화면·로그·argv·Git에 출력하지 않는다.',
    '- portal.json, supabase-service.json, .env를 Git에 추가하거나 커밋하지 않는다.',
    '',
    '복사 가능한 연결 정보:',
    `SUPABASE_URL=${shellQuote(supabaseUrl)}`,
    `SUPABASE_ANON_KEY=${shellQuote(supabaseAnonKey)}`,
    projectReference
      ? `PROJECT_REFERENCE=${shellQuote(projectReference)}`
      : 'PROJECT_REFERENCE="$(git remote get-url origin)"',
    '',
    '두 저장소 경로를 먼저 구분한다:',
    '- AGENTSTOZ_ROOT: api-server.ts가 있는 AgentsToZ_byCS clone. 선택 프로젝트가 AgentsToZ_byCS 자체면 PROJECT_ROOT와 같아도 된다.',
    '- PROJECT_ROOT: 실제로 기억할 프로젝트 clone. API의 folderPath에는 반드시 이 경로를 전달한다.',
    '',
    'Ubuntu에서 수행할 절차:',
    '1. Bun 1.3.14를 확인하고 없으면 공식 설치 스크립트의 고정 버전으로 설치한다:',
    '   if ! command -v bun >/dev/null 2>&1; then curl --fail-with-body -fsSL https://bun.sh/install | bash -s -- bun-v1.3.14; export BUN_INSTALL="$HOME/.bun"; export PATH="$BUN_INSTALL/bin:$PATH"; fi',
    '   bun --version  # 1.3.14인지 확인한다',
    '',
    '2. AgentsToZ_byCS clone에서 서버 의존성을 설치한다:',
    '   AGENTSTOZ_ROOT="$(git -C /path/to/AgentsToZ_byCS rev-parse --show-toplevel)"',
    '   cd "$AGENTSTOZ_ROOT" && bun install --frozen-lockfile',
    '',
    '3. 설정 파일은 처음부터 비공개 권한으로 원자적으로 만든다:',
    '   umask 077',
    '   APP_DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/com.portmanager.portmanager"',
    '   install -d -m 700 "$APP_DATA_DIR"',
    '   export SUPABASE_URL SUPABASE_ANON_KEY',
    '   PORTAL_TMP="$(mktemp "$APP_DATA_DIR/.portal.json.XXXXXX")"',
    "   python3 -c 'import json,os,sys,uuid,socket; json.dump({\"supabaseUrl\":os.environ[\"SUPABASE_URL\"],\"supabaseAnonKey\":os.environ[\"SUPABASE_ANON_KEY\"],\"deviceId\":str(uuid.uuid4()),\"deviceName\":socket.gethostname()},sys.stdout,indent=2)' > \"$PORTAL_TMP\"",
    '   chmod 600 "$PORTAL_TMP" && mv -f "$PORTAL_TMP" "$APP_DATA_DIR/portal.json"',
    '',
    '4. service-role key는 숨김 입력으로 받고, argv나 파일의 공개 권한 구간 없이 저장한다:',
    '   read -rsp "Supabase service-role key: " SERVICE_ROLE_KEY; printf "\\n"',
    '   SERVICE_TMP="$(mktemp "$APP_DATA_DIR/.supabase-service.json.XXXXXX")"',
    "   printf '%s' \"$SERVICE_ROLE_KEY\" | python3 -c 'import json,sys; json.dump({\"serviceRoleKey\":sys.stdin.read()},sys.stdout)' > \"$SERVICE_TMP\"",
    '   unset SERVICE_ROLE_KEY',
    '   chmod 600 "$SERVICE_TMP" && mv -f "$SERVICE_TMP" "$APP_DATA_DIR/supabase-service.json"',
    '',
    '5. Supabase v9 계약을 사전 점검한다. service-role 파일을 읽는 로컬 스크립트로 PostgREST OpenAPI를 조회하고 키 자체는 출력하지 않는다:',
    "   python3 - \"$APP_DATA_DIR\" <<'PY'",
    'import json, pathlib, sys, urllib.request',
    'root = pathlib.Path(sys.argv[1])',
    'portal = json.loads((root / "portal.json").read_text())',
    'service = json.loads((root / "supabase-service.json").read_text())["serviceRoleKey"]',
    'req = urllib.request.Request(portal["supabaseUrl"].rstrip("/") + "/rest/v1/", headers={"apikey": service, "Authorization": "Bearer " + service})',
    'schema = urllib.request.urlopen(req, timeout=20).read().decode("utf-8")',
    'required = ["portmgr_claim_project_memory", "portmgr_append_project_memory_revision"]',
    'missing = [name for name in required if name not in schema]',
    'if missing: raise SystemExit("Supabase v9 RPC/migration 누락: " + ", ".join(missing))',
    'print("Supabase v9 RPC contract: PASS")',
    'PY',
    '',
    '6. AgentsToZ API를 같은 사용자·HOME·XDG 경로의 user systemd 서비스로 설치한다. 수동 SSH 프로세스로 두면 로그아웃 때 Telegram 기억 명령이 끊긴다:',
    '   BUN_BIN="$(command -v bun)"; test -x "$BUN_BIN"',
    '   install -d -m 700 "$HOME/.config/systemd/user"',
    '   API_UNIT_TMP="$(mktemp "$HOME/.config/systemd/user/.agentstoz-api.service.XXXXXX")"',
    "   python3 - \"$AGENTSTOZ_ROOT\" \"$BUN_BIN\" \"$HOME\" \"${XDG_CONFIG_HOME:-$HOME/.config}\" <<'PY' > \"$API_UNIT_TMP\"",
    'import json, sys',
    'root, bun, home, xdg = sys.argv[1:]',
    'q = json.dumps',
    'print("[Unit]\\nDescription=AgentsToZ local context API\\nWants=network-online.target\\nAfter=network-online.target\\nStartLimitIntervalSec=300\\nStartLimitBurst=10\\n\\n[Service]")',
    'print("Type=simple")',
    'print("WorkingDirectory=" + q(root))',
    'print("ExecStart=" + q(bun) + " api-server.ts")',
    'print("Environment=" + q("HOME=" + home))',
    'print("Environment=" + q("XDG_CONFIG_HOME=" + xdg))',
    'print("Restart=always\\nRestartSec=5\\n\\n[Install]\\nWantedBy=default.target")',
    'PY',
    '   chmod 600 "$API_UNIT_TMP" && mv -f "$API_UNIT_TMP" "$HOME/.config/systemd/user/agentstoz-api.service"',
    '   systemctl --user daemon-reload && systemctl --user enable --now agentstoz-api',
    '   sudo loginctl enable-linger "$USER"',
    '   systemctl --user --no-pager --full status agentstoz-api',
    '   정확한 thread API 계약까지 확인한다:',
    `   curl --fail-with-body -sS http://127.0.0.1:3001/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); req={${requiredContextCapabilities}}; assert d.get("schemaVersion",0)>=${CONTEXT_API_SCHEMA_VERSION} and req<=set(d.get("capabilities",[])), d; print("AgentsToZ context API contract: PASS")'`,
    '',
    '7. 실제 작업 프로젝트 clone을 초기화한다:',
    '   PROJECT_ROOT="$(git -C /path/to/project rev-parse --show-toplevel)"',
    '   PROJECT_REFERENCE="$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null || printf %s "$PROJECT_REFERENCE")"',
    '   curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$PROJECT_ROOT" --data-urlencode "projectName=$(basename "$PROJECT_ROOT")" --data-urlencode "agent=claude" --data-urlencode "autoBackup=true" http://127.0.0.1:3001/api/project-memory/init',
    '   이어서 이 clone을 Telegram topic resolver의 로컬 허용목록에 멱등 등록한다:',
    '   curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$PROJECT_ROOT" --data-urlencode "projectName=$(basename "$PROJECT_ROOT")" http://127.0.0.1:3001/api/project-memory/register-project | python3 -c \'import json,sys; d=json.load(sys.stdin); assert d.get("ok") and d.get("project",{}).get("memoryId"), d; print("Registered project memoryId:", d["project"]["memoryId"])\'',
    '',
    '8. 원격 기억을 Pull한다. HTTP 409면 덮어쓰지 말고 JSON body를 보존해 충돌 해결 절차를 먼저 밟는다:',
    '   curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$PROJECT_ROOT" --data-urlencode "githubUrl=$PROJECT_REFERENCE" http://127.0.0.1:3001/api/project-memory/pull',
    '',
    '9. Hermes CLI가 없으면 공식 headless 설치를 하고, 기존 설치가 있으면 그대로 보존한 채 진단한다:',
    '   if ! command -v hermes >/dev/null 2>&1; then curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-browser; export PATH="$HOME/.local/bin:$PATH"; fi',
    '   HERMES_BIN="$(command -v hermes)"; test -x "$HERMES_BIN"',
    "   MIN_HERMES_VERSION='0.20.0'",
    '   HERMES_VERSION_RAW="$("$HERMES_BIN" --version)"',
    "   python3 - \"$MIN_HERMES_VERSION\" \"$HERMES_VERSION_RAW\" <<'PY'",
    'import re, sys',
    'minimum = tuple(map(int, sys.argv[1].split(".")))',
    'match = re.search(r"(?:^|[^0-9])(\\d+)\\.(\\d+)\\.(\\d+)(?:[^0-9]|$)", sys.argv[2])',
    'if not match or tuple(map(int, match.groups())) < minimum:',
    '    raise SystemExit("Hermes >= " + sys.argv[1] + " is required; got " + sys.argv[2])',
    'print("Hermes version contract: PASS")',
    'PY',
    '   "$HERMES_BIN" doctor',
    '   모델 공급자나 Telegram bot/allowlist가 아직 설정되지 않은 경우에만 `"$HERMES_BIN" gateway setup`을 대화형으로 실행한다. Bot token은 .env에만 두고 출력하지 않는다.',
    '',
    '10. 실행 중인 AgentsToZ API로 Hermes topic 명령 어댑터를 설치하고, Telegram Bot API 최대 100개 메뉴 슬롯을 사용해 이 명령들을 노출한다:',
    `   curl --fail-with-body -sS -X POST http://127.0.0.1:3001/api/project-memory/install-hermes-adapter | python3 -c 'import json,sys; d=json.load(sys.stdin); req={"remember-session","memory-link","memory-sync","memory-status","memory-unlink","memory-start"}; assert d.get("ok") and d.get("externalDirRegistered") and req<=set(d.get("installed",[])) and d.get("installedVersion",0)>=${CURRENT_PROJECT_MEMORY_VERSION}, d; print("Hermes AgentsToZ adapter: PASS")'`,
    '   "$HERMES_BIN" config set platforms.telegram.extra.command_menu.max_commands 100',
    '   "$HERMES_BIN" config set gateway.systemd_watchdog_seconds 120',
    '   priority/priority_mode는 공개 문서 계약이 아니며 Hermes 버전별 내부 동작에 의존하므로 이 bootstrap의 필수 설정으로 사용하지 않는다.',
    '   저장소 integration test는 설치된 Hermes renderer에서 100개 cap 안에 memory 명령 6개가 모두 있는지 fail-closed 검사한다. 실제 gateway의 최종 완료 조건은 아래 `/commands` 확인이다.',
    '   이미 system-wide 서비스가 있으면 사용자 서비스를 중복 생성하지 말고 아래 system 명령을 사용한다:',
    '   sudo "$HERMES_BIN" gateway install --system --run-as-user "$USER" --force --start-now',
    '   sudo "$HERMES_BIN" gateway status --system --deep',
    '   그 외 AWS headless 기본 경로는 user service + linger다:',
    '   "$HERMES_BIN" gateway install --force --start-now --start-on-login',
    '   sudo loginctl enable-linger "$USER"',
    '   "$HERMES_BIN" gateway status --deep',
    '',
    '11. Claude/Codex 터미널에서는 생성된 스킬 하나만 실행한다:',
    '   - Claude: /remember-session',
    '   - Codex: $remember-session',
    '   이 스킬이 로컬 기억 업데이트 → mark → Supabase Push를 이미 순서대로 수행하므로 mark나 Push를 별도로 다시 호출하지 않는다.',
    '   스킬 결과에서 contentBackedUp, journalBackedUp, feedbackSynced, backupComplete를 각각 확인한다.',
    '',
    '12. AWS·Telegram Hermes에서는 먼저 `/commands`에 아래 명령이 보이는지 확인하고, 프로젝트별 topic에서 정식 명령을 실제 실행한다:',
    '   - 최초 연결: /memory_link <공유 memoryId>',
    '   - 평상시 저장: /remember_session',
    '   - 저장 없이 동기화만: /memory_sync',
    '   - 상태 확인: /memory_status',
    '   - topic 연결 해제: /memory_unlink',
    '   /memory_start는 현재 topic 전용 새 독립 기억 생성 명령이고, /memory_stop만 /memory_unlink의 호환 별칭으로 유지한다. /remember는 설치하지 않는다.',
    '',
    '   `/memory_status`가 연결 전에는 unbound를 명확히 보고하고, `/memory_link <memoryId>` 뒤에는 같은 memoryId와 canonical project path를 보여야 설치 완료다.',
    '   명령이 보이지 않으면 gateway를 중복 실행하지 말고 `"$HERMES_BIN" gateway status --deep`, `"$HERMES_BIN" skills list`, `~/.hermes/logs/gateway.log`를 확인한다.',
    '',
    '13. API schema/capability와 Hermes deep status를 5분마다 fail-closed 검사하는 user timer를 설치한다:',
    '   test -x "$AGENTSTOZ_ROOT/scripts/check-aws-memory-host.sh"',
    '   HEALTH_SERVICE_TMP="$(mktemp "$HOME/.config/systemd/user/.agentstoz-memory-host-health.service.XXXXXX")"',
    "   python3 - \"$AGENTSTOZ_ROOT\" <<'PY' > \"$HEALTH_SERVICE_TMP\"",
    'import json, sys',
    'probe = sys.argv[1] + "/scripts/check-aws-memory-host.sh"',
    'print("[Unit]\\nDescription=AgentsToZ memory host deep health\\nAfter=agentstoz-api.service\\n\\n[Service]\\nType=oneshot")',
    'print("ExecStart=" + json.dumps(probe))',
    'PY',
    '   chmod 600 "$HEALTH_SERVICE_TMP" && mv -f "$HEALTH_SERVICE_TMP" "$HOME/.config/systemd/user/agentstoz-memory-host-health.service"',
    '   HEALTH_TIMER_TMP="$(mktemp "$HOME/.config/systemd/user/.agentstoz-memory-host-health.timer.XXXXXX")"',
    "   python3 - <<'PY' > \"$HEALTH_TIMER_TMP\"",
    'print("[Unit]\\nDescription=Run AgentsToZ memory host deep health every 5 minutes\\n\\n[Timer]\\nOnBootSec=2min\\nOnUnitActiveSec=5min\\nPersistent=true\\nUnit=agentstoz-memory-host-health.service\\n\\n[Install]\\nWantedBy=timers.target")',
    'PY',
    '   chmod 600 "$HEALTH_TIMER_TMP" && mv -f "$HEALTH_TIMER_TMP" "$HOME/.config/systemd/user/agentstoz-memory-host-health.timer"',
    '   systemctl --user daemon-reload && systemctl --user enable --now agentstoz-memory-host-health.timer',
    '   systemctl --user start agentstoz-memory-host-health.service',
    '',
    '14. 업데이트는 현재 version/SHA를 기록하고 검토한 release SHA에서만 수행한다. `<검토한-release-SHA>`를 실제 검토한 commit으로 바꾸기 전에는 실행하지 않는다:',
    '   AGENTSTOZ_BEFORE="$(git -C "$AGENTSTOZ_ROOT" rev-parse HEAD)"',
    '   HERMES_BEFORE="$("$HERMES_BIN" --version)"',
    '   git -C "$AGENTSTOZ_ROOT" fetch --tags origin',
    '   git -C "$AGENTSTOZ_ROOT" checkout <검토한-release-SHA>',
    '   (cd "$AGENTSTOZ_ROOT" && bun install --frozen-lockfile && bun run typecheck && bun test)',
    '   systemctl --user restart agentstoz-api',
    '   "$HERMES_BIN" update',
    `   curl --fail-with-body -sS -X POST http://127.0.0.1:3001/api/project-memory/install-hermes-adapter | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") and d.get("installedVersion",0)>=${CURRENT_PROJECT_MEMORY_VERSION}, d'`,
    '   gateway는 처음 선택한 동일 service mode로 `gateway install --force`를 다시 실행하고, user/system 중 해당하는 `gateway status --deep`를 확인한다.',
    '   "$AGENTSTOZ_ROOT/scripts/check-aws-memory-host.sh"',
    '   앱 update 검증이 실패하면 새 Push를 수행하지 말고 `git -C "$AGENTSTOZ_ROOT" checkout "$AGENTSTOZ_BEFORE"` 후 frozen install, API restart, adapter 재설치, health probe를 반복한다. Hermes update 실패는 `$HERMES_BEFORE`를 함께 보고하고 성공으로 간주하지 않는다.',
    '',
    '15. 운영 복구와 외부 알림 경계:',
    '   - user gateway 로그: journalctl --user -u hermes-gateway --since "30 min ago"',
    '   - system gateway 로그: sudo journalctl -u hermes-gateway --since "30 min ago"',
    '   - Telegram adapter circuit breaker 상태: /platform list',
    '   - 원인을 해결한 뒤 Telegram만 재개: /platform resume telegram',
    '   - timer 실패: systemctl --user --failed; journalctl --user -u agentstoz-memory-host-health.service',
    '   - CloudWatch 경보, disk-space 경보, journald 보존기간은 이 저장소가 AWS 계정 권한 없이 강제할 수 없다. 실제 호스트에서 timer 실패와 디스크 임계치에 별도 경보를 연결해야 production 완료다.',
    '',
    '기존 로컬 기억이 원격에 아직 Push되지 않았다면 Ubuntu Pull 전에 로컬 앱에서 먼저 Push가 완료됐는지 확인해줘.',
  ].join('\n');
}
