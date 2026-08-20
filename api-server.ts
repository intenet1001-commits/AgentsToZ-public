import { spawn } from "bun";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { PORTMGR_TABLES, SCHEMA_TABLE_COUNT, migrationSqlForAllowedEmails } from "./src/schemaSql";
import {
  detectHermesProjectMemoryAdapter,
  detectProjectMemory,
  readMemoryDocument,
  initializeProjectMemory,
  installHermesProjectMemoryAdapter,
  ProjectMemoryError,
  listProjectMemoryRevisions,
  markProjectMemoryRemembered,
  inspectProjectMemory,
  recallProjectMemory,
  recordProjectMemoryFeedback,
  pullProjectMemory,
  pushProjectMemory,
  remoteProjectMemoryStatus,
  resolveProjectMemoryConflict,
  restoreProjectMemoryRevision,
  sessionEndProjectMemory,
  setProjectMemoryPreferredAgent,
  resolveSupabaseCli,
  upgradeProjectMemoryAgent,
  updateProjectMemory,
  type ProjectMemoryAgent,
} from "./project-memory-server";
import { isWorktreePortCandidate } from "./src/worktreePortScheme";
import { loadServiceRoleKey, serviceRoleKeyPath } from "./server-supabase-service";
import {
  describeSupabaseCliFailure,
  selectServiceRoleKey,
  supabaseProjectRefFromUrl,
} from "./src/supabaseServiceKeyCli";
import { normalizeVocAnchor, vocFileName } from "./src/vocAnchor";
import {
  MAX_VOC_COMMENT_LENGTH,
  checkRemoteVocAccess,
  loadVocAdminSettings,
  removeVocDeviceBlock,
  submitRemoteVoc,
  updateVocAdminSettings,
  upsertVocDeviceBlock,
} from "./voc-remote";
import { archiveFileName, archiveHeader, summarizeMemory } from "./src/memoryArchive";
import {
  HERMES_CLI_NOT_FOUND_CODE,
  HERMES_CLI_NOT_FOUND_MESSAGE,
  hermesCliPathFromResolved,
} from "./src/hermesCliPresence";
import {
  GIT_VOLATILE_ARTIFACT_PATHS,
  GIT_VOLATILE_ARTIFACT_PATHSPECS,
  isGitHubRemoteUrl,
  parseGitStatusPorcelainV2,
  type ParsedGitCheckoutStatus,
} from "./git-worktree-status";
import {
  parseGitWorktreePorcelain,
  resolvePrimaryWorktreeBranch,
} from "./git-worktree-list";
import { buildCodeAppDeepLink, type CodeAppAgent } from "./code-app-links";
import { mergeLegacyPortSave, mergePortSnapshots, type PortRecord } from "./src/ports-merge";
import { resolveRegisteredProjectMemory } from "./src/projectMemoryProjectResolver";
import { resolveProjectMemorySyncDirection } from "./src/projectMemorySyncState";
import {
  bindProjectMemoryThread,
  getProjectMemoryThreadBinding,
  unbindProjectMemoryThread,
  type ProjectMemoryThreadRoute,
} from "./src/projectMemoryThreadBindings";
import { selectMatchingDroppedPath, type DroppedPathKind } from "./src/dropped-path";
import {
  completeRepositoryFirstTask,
  detectRepositoryWorkflow,
  inspectWorktreeLaunch,
  inspectWorktreeSource,
  upgradeRepositoryWorkflow,
} from "./repository-workflow-server";
import {
  formatGitCommitDiagnostic,
  gitCommitFailureMessage,
  type DirtySubmoduleDiagnostic,
} from "./git-commit-diagnostics";
import {
  buildOrcaManagedFloatingTerminalTitle,
  buildOrcaFloatingCommand,
  buildWindowsCmdAgentCommand,
  buildWindowsCmdOrcaCommand,
  buildWindowsOrcaAgentCommand,
  isOrcaManagedFloatingTerminal,
  normalizeOrcaFloatingTerminalPath,
  orcaManagedFloatingTerminalMarker,
  ORCA_FLOATING_WORKTREE_ID,
  ORCA_FLOATING_WORKTREE_SELECTOR,
} from "./src/orcaFloatingTerminal";
import { inspectOrcaFloatingVisibility } from "./src/orcaFloatingVisibility";
import { windowsHermesExecutableCandidates } from "./src/windowsAgentExecutable";
import { classifyClaudeSessionOrigin, classifyCodexSessionOrigin } from "./src/sessionOrigin";
import { PROJECT_MEMORY_FEEDBACK_PROMOTION_ENABLED } from "./src/projectMemoryFeedback";
import {
  resolveClaudeSessionNavigation,
  resolveCodexSessionNavigation,
} from "./src/contextSessionNavigation";
import { findLiveOrcaTerminal, findOrcaSessionBinding } from "./src/orcaSessionLookup";
import {
  formatOrcaFloatingFallbackNotice,
  isOrcaWorktreeSelectorMissing,
  shouldFallBackToOrcaFloatingTerminal,
} from "./src/orcaWorktreeSupport";
import {
  codexTuiRuntimeState,
  codexTuiSurfacePresence,
  type CodexTuiRuntimeState,
} from "./src/codexProcessPresence";
import {
  claudeAgentRuntimeFacts,
  claudeAgentSurfacePresence,
  hasTerminalLaunchEvidence,
  resolveClaudeAgentInventory,
  parseClaudeAgentInventory,
  UNAVAILABLE_CLAUDE_AGENT_INVENTORY,
  type ClaudeAgentInventory,
} from "./src/claudeAgentInventory";
import {
  hasAtLeastOrcaTerminalCount,
  inspectCmuxSurfaceInWorkspace,
  inspectOrcaContextSessionPresence,
  isRecognizedCmuxTree,
  isDefinitivelyClosedCmuxRuntimeError,
  isDefinitivelyMissingCmuxTargetError,
  unboundOrcaContextSurfacePresence,
  type ContextSurfacePresence,
  type OrcaContextRuntimeState,
} from "./src/contextSessionPresence";
import {
  parseChatGptThreadMetadata,
  parseChatGptThreadTitles,
  parseClaudeSessionMetadata,
  type ContextSessionMetadata,
} from "./src/contextSessionMetadata";
import {
  classifyProjectCodexSession,
  selectProjectCodexVoiceThread,
  selectPendingProjectCodexVoiceThread,
  type ProjectCodexVoiceCandidate,
} from "./src/projectCodexVoice";
import {
  buildChatGptVoiceStartAppleScript,
  CHATGPT_GLOBAL_VOICE_START_LABELS,
  CHATGPT_NEW_VOICE_START_LABELS,
  CHATGPT_RESUME_VOICE_START_LABELS,
  classifyChatGptVoiceAutomationError,
  describeChatGptVoiceAutomationFailure,
  extractChatGptVoiceCandidateDiagnostic,
  type ChatGptVoiceAutomationMethod,
  type ChatGptVoiceStartSurface,
} from "./src/projectCodexVoiceLaunch";
import { normalizeCodexRateLimits, readCodexLiveRateLimits } from "./codex-rate-limits";
import {
  CONTEXT_API_SCHEMA_VERSION,
  REQUIRED_CONTEXT_API_CAPABILITIES,
  contextApiCapabilities,
  disabledContextApiCapabilities,
} from "./src/contextApiVersion";
import { resolveAppDataDir } from "./src/appDataDir";
import { tmuxSessionName } from "./src/tmuxSessionName";
import { pickCommandLauncher } from "./src/startCommandDetection";
import {
  buildChromeProfileLaunch,
  discoverChromeProfiles,
} from "./src/browserProfilesServer";
import {
  verifyOrcaBrowserPage,
  verifyOrcaManagedWorktree,
} from "./src/orcaResultVerification";
import { processPortEnvironment } from "./src/processPortEnvironment";
import { resolveProjectStartTarget } from "./src/projectStartLocation";
import { HERMES_POST_INSTALL_HINT } from "./src/hermesProjectMemoryAdapter";
import { PROJECT_DOCUMENT_EXTENSIONS } from "./src/projectDocumentPath";
import { windowsListenerPidsForPort, windowsListeningPorts } from "./src/windowsNetstat";
import { buildWindowsCommandLaunch, buildWindowsSupervisedLaunch, buildWindowsTerminalLaunch } from "./src/windowsCommandLaunch";
import { NativeOAuthRelay } from "./src/nativeOAuthRelay";
import { PortLaunchOwnership } from "./src/portLaunchOwnership";

/** Escape single quotes for use inside single-quoted shell strings: ' → '\'' */
const escapeSq = (s: string): string => s.replace(/'/g, "'\\''");

const IS_WIN = process.platform === 'win32';
// 디버그 로그 게이트: NODE_ENV 체크는 실사용 환경에서 사실상 항상 열려 있어,
// 10초 폴링류(per-poll) 로그가 자기 자신의 포트 로그 파일로 흘러들어
// 로그가 quadratic하게 자라는 문제가 있었음. DEBUG_PORTMGR=1일 때만 출력.
// 시작/에러 로그는 console.log / console.error를 직접 사용 (devLog 사용 금지).
const DEBUG = process.env.DEBUG_PORTMGR === '1';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const devLog = (...args: any[]) => { if (DEBUG) console.log(...args); };

const AGENTSTOZ_APP_NAME = 'AgentsToZ_byCS.app';
const AGENTSTOZ_APP_EXECUTABLE_SUFFIX = `/${AGENTSTOZ_APP_NAME}/Contents/MacOS/app`;

interface StagedMacosAppInstall {
  sourcePath: string;
  destinationPath: string;
  stagedPath: string;
  backupPath: string;
  logPath: string;
}

// Runs outside the app/sidecar process because installing an app that invoked this
// endpoint must be able to finish after that app exits. Paths and PIDs are passed as
// positional arguments, not interpolated into the shell program.
const MACOS_APP_INSTALL_HELPER = String.raw`
destination_path=$1
staged_path=$2
backup_path=$3
log_path=$4
shift 4

exec >>"$log_path" 2>&1
echo "[$(/bin/date '+%Y-%m-%d %H:%M:%S')] AgentsToZ install helper started"

# Let the HTTP/Tauri caller receive the scheduled result before its app exits.
/bin/sleep 1
/usr/bin/osascript -e 'tell application id "com.intenet.agentstozbycs" to quit' >/dev/null 2>&1 || true
/bin/sleep 1

is_agentstoz_pid() {
  running_command=$(/bin/ps -p "$1" -o command= 2>/dev/null || true)
  case "$running_command" in
    */AgentsToZ_byCS.app/Contents/MacOS/app) return 0 ;;
    *) return 1 ;;
  esac
}

for app_pid in "$@"; do
  if is_agentstoz_pid "$app_pid"; then
    /bin/kill -TERM "$app_pid" 2>/dev/null || true
  fi
done

wait_round=0
while [ "$wait_round" -lt 50 ]; do
  still_running=0
  for app_pid in "$@"; do
    if is_agentstoz_pid "$app_pid"; then
      still_running=1
      break
    fi
  done
  [ "$still_running" -eq 0 ] && break
  wait_round=$((wait_round + 1))
  /bin/sleep 0.2
done

if [ "$still_running" -ne 0 ]; then
  echo "Install aborted: an AgentsToZ app process did not exit. Existing app was not changed."
  exit 20
fi

had_destination=0
if [ -e "$destination_path" ]; then
  if ! /bin/mv "$destination_path" "$backup_path"; then
    echo "Install aborted: could not move existing app to backup."
    exit 30
  fi
  had_destination=1
fi

if /bin/mv "$staged_path" "$destination_path"; then
  echo "Install complete. Previous app backup: $backup_path"
  /usr/bin/open -n "$destination_path" || true
  exit 0
fi

echo "Install failed while activating staged app; attempting rollback."
if [ "$had_destination" -eq 1 ] && [ -e "$backup_path" ] && [ ! -e "$destination_path" ]; then
  if /bin/mv "$backup_path" "$destination_path"; then
    echo "Rollback complete."
  else
    echo "Rollback failed. Backup remains at: $backup_path"
  fi
fi
exit 40
`;

async function commandOutput(command: string[]): Promise<{ exitCode: number; output: string }> {
  const child = spawn({ cmd: command, stdout: 'pipe', stderr: 'pipe' });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exitCode = await child.exited;
  return { exitCode, output: `${await stdout}${await stderr}`.trim() };
}

async function runningAgentsTozAppPids(): Promise<number[]> {
  const result = await commandOutput(['/bin/ps', '-axo', 'pid=,command=']);
  if (result.exitCode !== 0) return [];
  const pids = new Set<number>();
  for (const line of result.output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    const pidText = match?.[1];
    const command = match?.[2];
    if (!pidText || !command?.trimEnd().endsWith(AGENTSTOZ_APP_EXECUTABLE_SUFFIX)) continue;
    const pid = Number(pidText);
    if (Number.isInteger(pid) && pid > 1) pids.add(pid);
  }
  return [...pids];
}

async function stageMacosAppInstall(): Promise<StagedMacosAppInstall> {
  const sourcePath = join(homedir(), 'cargo-targets', 'portmanager', 'release', 'bundle', 'macos', AGENTSTOZ_APP_NAME);
  const destinationPath = join('/Applications', AGENTSTOZ_APP_NAME);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
    throw new Error(`빌드된 앱을 찾을 수 없습니다: ${sourcePath}`);
  }

  const token = `${Date.now()}-${process.pid}`;
  const stagedPath = join('/Applications', `.AgentsToZ_byCS-installing-${token}.app`);
  const backupDir = join('/Applications', '.AgentsToZ_byCS-backups');
  const backupPath = join(backupDir, `AgentsToZ_byCS-${token}.app`);
  const logDir = join(homedir(), 'Library', 'Logs', 'AgentsToZ_byCS');
  const logPath = join(logDir, `install-${token}.log`);
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  if (existsSync(stagedPath) || existsSync(backupPath)) {
    throw new Error('설치 임시 경로가 이미 존재합니다. 잠시 후 다시 시도하세요.');
  }

  const copied = await commandOutput(['/usr/bin/ditto', sourcePath, stagedPath]);
  if (copied.exitCode !== 0) {
    rmSync(stagedPath, { recursive: true, force: true });
    throw new Error(`새 앱을 설치 준비 경로에 복사하지 못했습니다: ${copied.output || `exit ${copied.exitCode}`}`);
  }

  const stagedExecutable = join(stagedPath, 'Contents', 'MacOS', 'app');
  if (!existsSync(stagedExecutable)) {
    rmSync(stagedPath, { recursive: true, force: true });
    throw new Error('설치 준비된 앱에 실행 파일이 없습니다. 기존 앱은 변경하지 않았습니다.');
  }

  const verified = await commandOutput(['/usr/bin/codesign', '--verify', '--deep', '--strict', stagedPath]);
  if (verified.exitCode !== 0) {
    rmSync(stagedPath, { recursive: true, force: true });
    throw new Error(`설치 준비된 앱의 서명 검증에 실패했습니다: ${verified.output || `exit ${verified.exitCode}`}`);
  }

  return { sourcePath, destinationPath, stagedPath, backupPath, logPath };
}

async function scheduleMacosAppInstall(plan: StagedMacosAppInstall): Promise<number[]> {
  const appPids = await runningAgentsTozAppPids();
  try {
    const helper = spawn({
      cmd: [
        '/bin/sh',
        '-c',
        MACOS_APP_INSTALL_HELPER,
        'agentstoz-install-helper',
        plan.destinationPath,
        plan.stagedPath,
        plan.backupPath,
        plan.logPath,
        ...appPids.map(String),
      ],
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true,
    });
    helper.unref();
    return appPids;
  } catch (error) {
    rmSync(plan.stagedPath, { recursive: true, force: true });
    throw error;
  }
}

/** Git 바이너리 절대경로 — Tauri sandbox·다른 머신 호환성을 위해 PATH 대신 절대경로 사용 */
function resolveGitPath(): string {
  if (IS_WIN) {
    for (const p of ['C:/Program Files/Git/cmd/git.exe', 'C:/Program Files/Git/bin/git.exe', 'C:/Program Files (x86)/Git/cmd/git.exe']) {
      if (existsSync(p)) return p;
    }
    const r = Bun.spawnSync(['where', 'git'], { stdout: 'pipe', stderr: 'pipe' });
    const p = r.stdout.toString().trim().split(/\r?\n/)[0]?.trim();
    if (p) return p;
    return 'git';
  }
  if (existsSync('/usr/bin/git')) return '/usr/bin/git';
  if (existsSync('/opt/homebrew/bin/git')) return '/opt/homebrew/bin/git';
  if (existsSync('/usr/local/bin/git')) return '/usr/local/bin/git';
  return 'git';
}
const GIT_PATH = resolveGitPath();

/**
 * clone 은 네트워크 작업이라 끝을 보장할 수 없다. 무한정 매달려 있으면 사용자는 앱이
 * 죽은 것으로 읽는다. 큰 저장소도 통과할 만큼 넉넉하되 유한하게 둔다.
 */
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * git 의 stderr 를 그대로 보여주면 원인이 묻힌다. 가장 흔한 두 실패는 **없는 저장소**와
 * **인증**인데, private 저장소는 GitHub 이 존재 자체를 숨기므로 둘이 같은 메시지로 온다.
 * 그 사실을 감추지 않고 두 가능성을 함께 말한다.
 */
function describeCloneFailure(stderr: string): string {
  const text = stderr.trim();
  if (/could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied \(publickey\)/i.test(text)) {
    return `저장소에 접근하지 못했습니다. private 저장소라면 이 PC의 git 인증(SSH 키 또는 gh 로그인)을 먼저 설정하세요.\n${text}`;
  }
  if (/(repository .* not found|Could not resolve host|does not exist)/i.test(text)) {
    return `저장소를 찾지 못했습니다. 주소가 맞는지, private 저장소라면 접근 권한이 있는지 확인하세요.\n${text}`;
  }
  return text || "git clone 실패";
}

/**
 * Stage everything except volatile artifacts (playwright logs, .env, .DS_Store, memory backups).
 * `git add -A -- . <exclude pathspecs>` fails outright (non-zero exit, nothing staged) whenever
 * one of the excluded paths is *also* gitignored — git raises "paths ignored by .gitignore" and
 * refuses before staging anything, regardless of the exclude magic. Staging in two plain steps
 * (add everything, then unstage the volatile paths) sidesteps that git quirk.
 */
async function stageAllExceptVolatileArtifacts(cwd: string): Promise<{ exitCode: number; output: string }> {
  const add = Bun.spawn([GIT_PATH, "add", "-A", "--", "."], { cwd, stdout: "pipe", stderr: "pipe" });
  await add.exited;
  if (add.exitCode !== 0) {
    const output = `${await new Response(add.stdout).text()}${await new Response(add.stderr).text()}`.trim();
    return { exitCode: add.exitCode ?? 1, output };
  }
  const unstage = Bun.spawn(
    [GIT_PATH, "reset", "--quiet", "--", ...GIT_VOLATILE_ARTIFACT_PATHS],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  await unstage.exited;
  const output = `${await new Response(unstage.stdout).text()}${await new Response(unstage.stderr).text()}`.trim();
  return { exitCode: unstage.exitCode ?? 0, output };
}

/**
 * 링크된 워크트리에는 **커밋된 파일만** 실체화된다 — .gitignore된 로컬 설정은 따라오지 않는다.
 * 그래서 Codex는 `.codex/hooks.json`이 추적 파일이라 워크트리에서도 멀쩡한데, Claude는
 * `.claude/`가 gitignore라 활동 훅(settings.json)·권한 허용목록(settings.local.json)·
 * 스킬(/remember-session)이 통째로 빠진 반쪽 상태로 뜬다. `.env`도 마찬가지로 빠진다.
 *
 * node_modules를 자동 설치해주는 것과 같은 취지로 메인의 로컬 설정을 워크트리에 심어
 * 두 에이전트의 동작을 맞춘다. 이미 있는 파일은 덮어쓰지 않는다(워크트리에서 수정했을 수 있음).
 *
 * `.claude/worktrees/`는 반드시 제외한다 — 워크트리 자신이 그 아래 있어 재귀 복사가 된다.
 */
function seedWorktreeLocalConfig(mainPath: string, targetPath: string): void {
  const readEntries = (dir: string) => {
    try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  };
  const copyTree = (src: string, dest: string, depth: number): void => {
    if (depth > 8) return;
    for (const entry of readEntries(src)) {
      // depth 0 == .claude 바로 아래. 여기의 worktrees/ 가 재귀의 원인이다.
      if (depth === 0 && entry.name === "worktrees") continue;
      const from = join(src, entry.name);
      const to = join(dest, entry.name);
      if (entry.isDirectory()) {
        try { mkdirSync(to, { recursive: true }); } catch { continue; }
        copyTree(from, to, depth + 1);
      } else if (entry.isFile() && !existsSync(to)) {
        try { copyFileSync(from, to); } catch { /* 개별 파일 실패는 무시 */ }
      }
    }
  };
  try {
    const claudeSrc = join(mainPath, ".claude");
    if (existsSync(claudeSrc)) {
      const claudeDest = join(targetPath, ".claude");
      mkdirSync(claudeDest, { recursive: true });
      copyTree(claudeSrc, claudeDest, 0);
    }
  } catch { /* best-effort */ }
  try {
    for (const entry of readEntries(mainPath)) {
      if (!entry.isFile() || !/^\.env(\..+)?$/.test(entry.name)) continue;
      const to = join(targetPath, entry.name);
      if (!existsSync(to)) copyFileSync(join(mainPath, entry.name), to);
    }
  } catch { /* best-effort */ }
}

async function createInitialSnapshotCommit(folderPath: string): Promise<{ success: boolean; error?: string }> {
  const add = await stageAllExceptVolatileArtifacts(folderPath);
  if (add.exitCode !== 0) {
    return { success: false, error: add.output || "초기 프로젝트 파일을 스테이징하지 못했습니다." };
  }
  const commit = Bun.spawn(
    [GIT_PATH, "commit", "--allow-empty", "-m", "Initial commit"],
    { cwd: folderPath, stdout: "pipe", stderr: "pipe" },
  );
  await commit.exited;
  if (commit.exitCode !== 0) {
    const detail = `${await new Response(commit.stdout).text()}${await new Response(commit.stderr).text()}`.trim();
    return { success: false, error: detail || "초기 커밋을 만들지 못했습니다." };
  }
  return { success: true };
}

/** 앱이 워크트리를 만드는 기본 폴더(비숨김). 숨김 폴더면 Orca가 인식하지 못한다. */
const WORKTREE_DIR = 'worktrees';
/** 이전 기본 폴더 — 이미 만들어진 워크트리를 계속 앱 소유로 인식하기 위해 유지한다. */
const LEGACY_WORKTREE_REL = '.claude/worktrees';

/** Git이 반환한 경로와 API 입력 경로를 플랫폼에 맞게 정확히 비교한다. */
function normalizeWorktreePath(value: string): string {
  const normalized = resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return IS_WIN ? normalized.toLowerCase() : normalized;
}

/** 비ASCII 경로를 C 스타일 escape로 바꾸지 않아 실제 절대경로와 비교할 수 있게 한다. */
const gitWorktreeListArgs = (): string[] => [
  '-c',
  'core.quotePath=false',
  'worktree',
  'list',
  '--porcelain',
];

/** 경로가 앱이 만든 워크트리 영역(현행 또는 레거시) 안에 있는가. */
function isAppOwnedWorktreePath(folderPath: string, wtPath: string): boolean {
  const root = normalizeWorktreePath(folderPath);
  const target = normalizeWorktreePath(wtPath);
  return target.startsWith(`${root}/${WORKTREE_DIR}/`) || target.startsWith(`${root}/${LEGACY_WORKTREE_REL}/`);
}

/** 경로가 **레거시(숨김) 워크트리 폴더** 안에 있는가 — 숨김 폴더라 Orca가 스캔하지 않는다. */
function isLegacyWorktreePath(folderPath: string, wtPath: string): boolean {
  return normalizeWorktreePath(wtPath).startsWith(`${normalizeWorktreePath(folderPath)}/${LEGACY_WORKTREE_REL}/`);
}

async function ensureLocalWorktreeExclude(folderPath: string): Promise<void> {
  const result = Bun.spawnSync([GIT_PATH, "rev-parse", "--git-path", "info/exclude"], {
    cwd: folderPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) return;
  const rawPath = result.stdout.toString().trim();
  if (!rawPath) return;
  const excludePath = isAbsolute(rawPath) ? rawPath : join(folderPath, rawPath);
  let content = "";
  try { content = await Bun.file(excludePath).text(); } catch {}
  const patterns = ["/.claude/worktrees/", "/worktrees/", ".DS_Store", "/.agent-memory/backups/"];
  const existing = new Set(content.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  const missing = patterns.filter(pattern => !existing.has(pattern));
  if (missing.length === 0) return;
  mkdirSync(dirname(excludePath), { recursive: true });
  const suffix = `${missing.join("\n")}\n`;
  await Bun.write(excludePath, content ? `${content.trimEnd()}\n${suffix}` : suffix);
}

interface GitWorktreeStatus extends ParsedGitCheckoutStatus {
  hasUpstream: boolean;
  remoteBranchExists: boolean;
  githubConnected: boolean;
  statusError?: string;
}

async function runGitForStatus(
  cwd: string,
  args: string[],
  timeoutMs = 8_000,
): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
  // Bun 1.3.1의 spawn/spawnSync를 장시간 폴링에서 수천 번 호출하면 종료된
  // 핸들이 누적돼 API 프로세스가 SIGSEGV로 끝나는 것이 실측됐다. Node 호환
  // execFile callback은 자원을 회수하며, 전역 큐로 동시에 하나만 실행한다.
  const run = () => new Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }>((resolveRun) => {
    let settled = false;
    const finish = (value: { ok: boolean; stdout: string; stderr: string; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardStop);
      resolveRun(value);
    };
    const child = nodeExecFile(
      GIT_PATH,
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: timeoutMs,
        // ⚠️ 기본 killSignal(SIGTERM)은 git이 무시하면 콜백이 끝내 오지 않는다.
        // 이 호출은 전역 큐를 물고 있으므로, 하나가 안 죽으면 서버의 모든 git 조회가
        // 영구히 멈춘다. 상태 조회는 중단해도 안전하니 곧바로 SIGKILL을 쓴다.
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error: any, stdout: string, stderr: string) => {
        const timedOut = !!error && (error.killed === true || error.code === 'ETIMEDOUT');
        finish({
          ok: !error,
          stdout: String(stdout ?? '').trim(),
          stderr: String(stderr ?? error?.message ?? '').trim(),
          timedOut,
        });
      },
    );
    // 그래도 콜백이 오지 않는 경우(자식이 fd를 물려준 손자 프로세스를 남기는 등)를 대비한
    // 큐 차원의 최종 방어선 — 큐가 통째로 멈추는 것보다 이 호출 하나를 포기하는 게 낫다.
    const hardStop = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 이미 종료됨 */ }
      finish({ ok: false, stdout: '', stderr: 'git 응답 없음 — 호출을 중단했습니다.', timedOut: true });
    }, timeoutMs + 5_000);
    (hardStop as any).unref?.();
  });
  const task = gitStatusProcessQueue.then(run, run);
  gitStatusProcessQueue = task.then(() => undefined, () => undefined);
  return task;
}

/** 워크트리 생성 시각. git이 기록하지 않으므로 `.git` 표식의 생성 시각을 쓴다.
 *  연결 워크트리에서 `.git`은 생성 시점에 쓰이는 파일이라 정확하고,
 *  주 워크트리에서는 `.git` 디렉터리 = 저장소가 만들어진 시각이다.
 *  birthtime을 못 얻는 파일시스템에서는 ctime으로 물러선다. */
function readWorktreeCreatedAt(worktreePath: string): { createdAt?: string } {
  try {
    const marker = join(worktreePath, '.git');
    const stat = statSync(existsSync(marker) ? marker : worktreePath);
    const birth = stat.birthtime instanceof Date && stat.birthtime.getTime() > 0
      ? stat.birthtime
      : stat.ctime;
    return Number.isFinite(birth?.getTime?.()) ? { createdAt: birth.toISOString() } : {};
  } catch {
    return {};
  }
}

function readDirtySubmodules(worktreePath: string): DirtySubmoduleDiagnostic[] {
  const candidatePaths = new Set<string>();
  if (existsSync(join(worktreePath, '.gitmodules'))) {
    const configured = Bun.spawnSync(
      [GIT_PATH, 'config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
      { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe', timeout: 5_000 },
    );
    if (configured.success) {
      for (const line of configured.stdout.toString().split(/\r?\n/)) {
        const path = line.match(/^\S+\s+(.+)$/)?.[1]?.trim();
        if (path) candidatePaths.add(path);
      }
    }
  }
  // .gitmodules가 누락되거나 불완전해도 Git index의 160000(gitlink) 항목으로
  // 실제 서브모듈 경로를 복구한다.
  const gitlinks = Bun.spawnSync(
    [GIT_PATH, 'ls-files', '--stage'],
    { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe', timeout: 5_000 },
  );
  if (gitlinks.success) {
    for (const line of gitlinks.stdout.toString().split(/\r?\n/)) {
      const path = line.match(/^160000\s+[0-9a-f]+\s+\d+\t(.+)$/i)?.[1]?.trim();
      if (path) candidatePaths.add(path);
    }
  }

  const dirty: DirtySubmoduleDiagnostic[] = [];
  for (const path of candidatePaths) {
    if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) continue;
    const submodulePath = join(worktreePath, path);
    if (!existsSync(submodulePath) || !statSync(submodulePath).isDirectory()) continue;
    const status = Bun.spawnSync(
      [GIT_PATH, 'status', '--porcelain=v1', '--untracked-files=normal'],
      { cwd: submodulePath, stdout: 'pipe', stderr: 'pipe', timeout: 5_000 },
    );
    const output = status.stdout.toString().trim();
    if (output) dirty.push({ path, status: output });
    if (dirty.length >= 20) break;
  }
  return dirty;
}

async function readGitWorktreeStatus(path: string, branch?: string): Promise<GitWorktreeStatus> {
  const statusResult = await runGitForStatus(
    path,
    [
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=normal',
      '--',
      '.',
      ...GIT_VOLATILE_ARTIFACT_PATHSPECS,
    ],
  );
  if (!statusResult.ok) {
    return {
      changedFiles: 0,
      stagedFiles: 0,
      untrackedFiles: 0,
      conflictedFiles: 0,
      hasCommits: false,
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      remoteBranchExists: false,
      githubConnected: false,
      statusError: statusResult.timedOut ? 'Git 상태 확인 시간 초과' : (statusResult.stderr || 'Git 상태 확인 실패'),
    };
  }

  const parsed = parseGitStatusPorcelainV2(statusResult.stdout);
  const originResult = await runGitForStatus(path, ['remote', 'get-url', 'origin']);
  const githubConnected = originResult.ok && isGitHubRemoteUrl(originResult.stdout);
  const hasUpstream = !!parsed.upstream;
  let remoteBranchExists = hasUpstream;

  // Tracking 설정만 빠진 경우에도 로컬 origin/<branch> 참조가 있으면
  // Pull/Push 필요 상태를 계산할 수 있다.
  if (!parsed.upstream && branch) {
    const remoteRef = `refs/remotes/origin/${branch}`;
    const remoteResult = await runGitForStatus(path, ['show-ref', '--verify', '--quiet', remoteRef]);
    if (remoteResult.ok) {
      remoteBranchExists = true;
      const fallbackUpstream = `origin/${branch}`;
      const countsResult = await runGitForStatus(
        path,
        ['rev-list', '--left-right', '--count', `HEAD...${fallbackUpstream}`],
      );
      if (countsResult.ok) {
        const [aheadText = '0', behindText = '0'] = countsResult.stdout.split(/\s+/);
        parsed.ahead = Number.parseInt(aheadText, 10) || 0;
        parsed.behind = Number.parseInt(behindText, 10) || 0;
        parsed.upstream = fallbackUpstream;
      }
    }
  }

  return { ...parsed, hasUpstream, remoteBranchExists, githubConnected };
}

/** VS Build Tools (MSVC) 설치 여부 감지. 디렉터리 존재로 판정 — Bun.file().exists()는 디렉터리에 false를 반환하므로 existsSync 사용. */
function hasVsBuildTools(): boolean {
  const vsPaths = [
    'C:/Program Files/Microsoft Visual Studio/2022/BuildTools',
    'C:/Program Files/Microsoft Visual Studio/2022/Community',
    'C:/Program Files/Microsoft Visual Studio/2022/Professional',
    'C:/Program Files/Microsoft Visual Studio/2022/Enterprise',
    'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools',
    'C:/Program Files (x86)/Microsoft Visual Studio/2019/BuildTools',
    'C:/BuildTools',
  ];
  return vsPaths.some(p => existsSync(p + '/VC/Tools/MSVC'));
}

/** Windows 경로를 WSL /mnt/... 경로로 변환 */
function winToWslPath(winPath: string): string {
  if (winPath.length >= 2 && winPath[1] === ':') {
    const drive = winPath.charAt(0).toLowerCase();
    const rest = winPath.slice(2).replace(/\\/g, '/');
    return `/mnt/${drive}${rest}`;
  }
  return winPath.replace(/\\/g, '/');
}

const { spawnSync: nodeSpawnSync, execFile: nodeExecFile } = require('child_process');
let gitStatusProcessQueue: Promise<unknown> = Promise.resolve();

// ──────────────── cmux helpers (browser/web fallback path) ────────────────
// Tauri app uses Rust commands directly (src-tauri/src/lib.rs). For browser/
// localhost mode, we keep these helpers but use Node's child_process to
// sidestep the Bun.spawn degradation observed in long-running Bun.serve.

function resolveCmuxCli(): string | null {
  const bundled = '/Applications/cmux.app/Contents/Resources/bin/cmux';
  const homeBundled = `${homedir()}/Applications/cmux.app/Contents/Resources/bin/cmux`;
  const homebrew = '/opt/homebrew/bin/cmux';
  const usrLocal = '/usr/local/bin/cmux';
  if (existsSync(bundled)) return bundled;
  if (existsSync(homeBundled)) return homeBundled;
  if (existsSync(homebrew)) return homebrew;
  if (existsSync(usrLocal)) return usrLocal;
  return null;
}

function cmuxAppExists(): boolean {
  return existsSync('/Applications/cmux.app') || existsSync(`${homedir()}/Applications/cmux.app`);
}

/** Invoke cmux via `osascript do shell script` with a CLEANED env (no CMUX_*
 *  vars inherited from the api-server's parent shell) — Bun.serve's long-running
 *  process tree exhibits a degradation where cmux subprocess calls start
 *  failing with broken pipe after some time, even via bash/Node child_process.
 *  Using osascript routes through macOS's AppleScript engine (fully detached
 *  from Bun's subprocess state) and stripping CMUX_* prevents the daemon from
 *  treating the call as a stale-pane request. */
function nodeCmuxRun(cli: string, args: string[], timeoutMs = 8000): { ok: boolean; stderr: string; stdout: string } {
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const shellEscape = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const shellCmd = `${shellEscape(cli)} ${args.map(shellEscape).join(' ')}`;
  const appleScript = `do shell script "${escape(shellCmd)}"`;
  // Strip CMUX_* env vars — they reference panes that may not match the call context.
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('CMUX_') && v !== undefined) cleanEnv[k] = v;
  }
  const r = nodeSpawnSync('osascript', ['-e', appleScript], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: cleanEnv,
  });
  const spawnError = (r as any).error;
  const timeoutError = spawnError?.code === 'ETIMEDOUT'
    ? `cmux CLI 응답 시간 초과 (${Math.round(timeoutMs / 1000)}초)`
    : '';
  return {
    ok: r.status === 0 && !spawnError,
    stderr: timeoutError || (r.stderr ?? '').toString().trim() || spawnError?.message || '',
    stdout: (r.stdout ?? '').toString().trim(),
  };
}

/** The context-usage poll must not block Bun's request loop. Focus/create
 * actions retain the synchronous helper above for their existing sequencing,
 * while passive liveness checks use this non-blocking equivalent. */
async function nodeCmuxRunAsync(
  cli: string,
  args: string[],
  timeoutMs = 8000,
): Promise<{ ok: boolean; stderr: string; stdout: string }> {
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const shellEscape = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const shellCmd = `${shellEscape(cli)} ${args.map(shellEscape).join(' ')}`;
  const appleScript = `do shell script "${escape(shellCmd)}"`;
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('CMUX_') && v !== undefined) cleanEnv[k] = v;
  }
  return new Promise((resolveRun) => {
    nodeExecFile(
      'osascript',
      ['-e', appleScript],
      { encoding: 'utf-8', timeout: timeoutMs, env: cleanEnv, maxBuffer: 4 * 1024 * 1024 },
      (error: any, stdout: string, stderr: string) => {
        const timeoutError = error?.code === 'ETIMEDOUT'
          ? `cmux CLI 응답 시간 초과 (${Math.round(timeoutMs / 1000)}초)`
          : '';
        const detail = String(stderr ?? '').trim() || error?.message || '';
        resolveRun({
          ok: !error,
          stderr: timeoutError || detail,
          stdout: String(stdout ?? '').trim(),
        });
      },
    );
  });
}

/** A socket-policy denial does not prove that cmux is closed. When it occurs,
 * this separate read-only process check can still prove the inverse: no cmux
 * app process means no cmux surface exists. `null` preserves uncertainty when
 * macOS blocks process inspection. */
async function isCmuxAppProcessRunning(): Promise<boolean | null> {
  if (IS_WIN) return null;
  const script = "do shell script \"/usr/bin/pgrep -f '[c]mux\\.app/Contents/MacOS/cmux' >/dev/null 2>&1; /bin/echo $?\"";
  return new Promise((resolveCheck) => {
    nodeExecFile(
      'osascript',
      ['-e', script],
      { encoding: 'utf-8', timeout: 2_000 },
      (error: any, stdout: string) => {
        if (error) return resolveCheck(null);
        const code = String(stdout ?? '').trim();
        if (code === '0') return resolveCheck(true);
        if (code === '1') return resolveCheck(false);
        return resolveCheck(null);
      },
    );
  });
}

async function waitCmuxReadyNode(cli: string, totalMs = 10000): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // ping timeout: 2초로 제한 — 8초 기본값이면 10초 윈도우에서 1번밖에 못 시도
    if (nodeCmuxRun(cli, ['ping'], Math.min(2000, remaining)).ok) return true;
    await new Promise(res => setTimeout(res, 200));
  }
  return false;
}

/** Build the cmux workspace tab title — mirrors Rust `build_window_title` for the
 *  is_tmux=true / cmux flow: "⚡️ project › worktree" (bypass) or "🔷 project › worktree". */
function buildCmuxTitle(name: string, worktreePath: string | undefined, bypass: boolean): string {
  const wtBase = (worktreePath ?? '').split(',')[0]?.trim().split('/').pop() ?? '';
  const base = wtBase ? `${name} › ${wtBase}` : name;
  const prefix = bypass ? '⚡️ ' : '🔷 ';
  return prefix + base;
}

function cmuxAccessHelp(base: string): string {
  return `${base}\n\n💡 cmux 설정 확인: cmux 메뉴 → Settings → Socket Control → "Allow All"로 변경 후 재시도하세요. (현재 cmuxOnly 모드는 외부 앱의 호출을 차단)`;
}

async function cmuxSendNodeWithRetry(cli: string, payload: string): Promise<{ ok: boolean; stderr: string }> {
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = nodeCmuxRun(cli, ['send', payload]);
    if (r.ok) return { ok: true, stderr: '' };
    lastErr = r.stderr;
    if (!/Broken pipe|errno 32/i.test(lastErr)) break;
    if (attempt < 2) await new Promise(res => setTimeout(res, 300));
  }
  return { ok: false, stderr: lastErr || 'unknown' };
}

// ──────────────── Orca helpers (browser/web fallback path) ────────────────
// Orca(https://www.onorca.dev)는 Electron 앱 + VS Code 스타일 CLI 런처를 번들.
// 워크플로: orca open(런타임 대기, 멱등) → repo add(멱등) → terminal create.
// git 저장소만 등록 가능 — 비 git 폴더는 명확한 에러로 안내.

/** 모든 Orca CLI 호출을 직렬화하는 락. 실측: 더블클릭 등으로 요청 2~3개가 겹치면
 *  osascript 경유 nodeSpawnSync(완전 블로킹) 호출이 겹쳐 쌓이면서 Bun 자체가
 *  세그폴트로 죽는 것을 확인(Bun 1.3.1 자체 버그로 보이나 우리 쪽에서 유발).
 *  Orca 작업은 항상 이 락을 통해 한 번에 하나씩만 실행 — 동시 요청은 대기열로 직렬화. */
let orcaLock: Promise<unknown> = Promise.resolve();
function withOrcaLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = orcaLock.then(fn, fn);
  orcaLock = run.then(() => undefined, () => undefined);
  return run;
}

function resolveOrcaCli(): string | null {
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA ?? '';
    const pf = process.env['ProgramFiles'] ?? '';
    const candidates = [
      `${local}\\Programs\\orca\\resources\\bin\\orca.exe`,
      `${local}\\Programs\\Orca\\resources\\bin\\orca.exe`,
      `${pf}\\orca\\resources\\bin\\orca.exe`,
      `${pf}\\Orca\\resources\\bin\\orca.exe`,
    ];
    for (const p of candidates) if (existsSync(p)) return p;
    return null;
  }
  const candidates = [
    '/Applications/Orca.app/Contents/Resources/bin/orca',
    `${homedir()}/Applications/Orca.app/Contents/Resources/bin/orca`,
    '/opt/homebrew/bin/orca',
    '/usr/local/bin/orca',
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

/** Orca ignores hidden path segments when attaching visible worktree panes. */
function hasHiddenOrcaPathSegment(pathValue: string | null | undefined): boolean {
  if (!pathValue) return false;
  return pathValue.replace(/\\/g, '/').split('/').some((segment) => segment.length > 1 && segment.startsWith('.'));
}

/** Resolve a saved symlink before giving its path to Orca's sidebar selector. */
function resolveOrcaProjectPath(pathValue: string | null): string | null {
  if (!pathValue) return null;
  try { return realpathSync(pathValue); } catch { return pathValue; }
}

function hiddenOrcaWorktreeResponse(headers: Record<string, string>): Response {
  return new Response(JSON.stringify({
    success: false,
    code: 'ORCA_HIDDEN_WORKTREE_NOT_VISIBLE',
    error: '이 워크트리는 숨김 경로라 Orca 화면에 연결되지 않는 세션이 생성될 수 있습니다. WORKTREES의 “새 경로로 옮기기”를 먼저 실행하세요. 아무 세션도 생성하지 않았습니다.',
  }), { status: 409, headers });
}

/** macOS: osascript 우회(Bun.serve 프로세스 트리에서 직접 spawn 시 간헐 실패).
 *  Windows: 직접 execFile — osascript 없음, Bun.serve 트리 격리는 cleanEnv로 처리. */
async function nodeOrcaRun(
  cli: string,
  args: string[],
  timeoutMs = 40000,
): Promise<{ ok: boolean; stderr: string; stdout: string }> {
  // Windows: 직접 실행
  if (IS_WIN) {
    const cleanEnv: Record<string, string> = {
      APPDATA: process.env.APPDATA ?? '',
      LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
      USERPROFILE: process.env.USERPROFILE ?? homedir(),
      USERNAME: process.env.USERNAME ?? '',
      COMPUTERNAME: process.env.COMPUTERNAME ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? 'C:\\Windows',
      PATH: process.env.PATH ?? '',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? '',
    };
    return new Promise((resolveRun) => {
      nodeExecFile(
        cli,
        args,
        { encoding: 'utf8', timeout: timeoutMs, env: cleanEnv, maxBuffer: 4 * 1024 * 1024 },
        (error: any, stdout: string, stderr: string) => {
          const timedOut = !!error && (error.killed === true || error.code === 'ETIMEDOUT');
          resolveRun({
            ok: !error,
            stderr: timedOut
              ? `Orca CLI 응답 시간 초과 (${Math.round(timeoutMs / 1000)}초)`
              : String(stderr ?? error?.message ?? '').trim(),
            stdout: String(stdout ?? '').trim(),
          });
        },
      );
    });
  }
  // macOS: osascript 우회
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const shellEscape = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const shellCmd = `${shellEscape(cli)} ${args.map(shellEscape).join(' ')} 2>&1; exit 0`;
  const appleScript = `do shell script "${escape(shellCmd)}"`;
  const cleanEnv: Record<string, string> = {
    HOME: homedir(),
    USER: process.env.USER ?? '',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? '',
    SHELL: process.env.SHELL ?? '/bin/zsh',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  };
  return new Promise((resolveRun) => {
    nodeExecFile(
      'osascript',
      ['-e', appleScript],
      { encoding: 'utf8', timeout: timeoutMs, env: cleanEnv, maxBuffer: 4 * 1024 * 1024 },
      (error: any, stdout: string, stderr: string) => {
        const timedOut = !!error && (error.killed === true || error.code === 'ETIMEDOUT');
        resolveRun({
          ok: !error,
          stderr: timedOut
            ? `Orca CLI 응답 시간 초과 (${Math.round(timeoutMs / 1000)}초)`
            : String(stderr ?? error?.message ?? '').trim(),
          stdout: String(stdout ?? '').trim(),
        });
      },
    );
  });
}

/** Some Electron CLIs emit a diagnostic line on stderr before their JSON.  The
 * macOS osascript bridge intentionally combines stdout/stderr, so recover the
 * JSON document instead of treating harmless diagnostics as a runtime outage. */
function parseCliJsonOutput(stdout: string): any | null {
  try { return JSON.parse(stdout); } catch { /* try the first JSON document below */ }
  const starts = stdout.matchAll(/^[\t ]*([\[{])/gm);
  for (const match of starts) {
    const offset = (match.index ?? 0) + match[0].lastIndexOf(match[1]!);
    try { return JSON.parse(stdout.slice(offset).trim()); } catch { /* try the next line */ }
  }
  return null;
}

/** JSON 출력 커맨드 실행 — CLI는 실패도 exit 0 + {ok:false}로 반환하므로 둘 다 검사
 *  timeoutMs 기본값은 15s — 관측된 데몬 부하 스파이크(7~10s)보다 여유 있게 크지만,
 *  요청 하나가 open→repo add→terminal create→send→switch 5단계를 재시도까지 포함해
 *  순차 실행하므로 Bun.serve idleTimeout(90s로 상향, 아래 참고)을 넘기지 않도록 억제. */
async function nodeOrcaRunJson(
  cli: string,
  args: string[],
  timeoutMs = 15000,
): Promise<{ ok: boolean; error: string; result: any }> {
  const r = await nodeOrcaRun(cli, [...args, '--json'], timeoutMs);
  if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'unknown', result: null };
  const parsed = parseCliJsonOutput(r.stdout);
  if (!parsed) {
    return { ok: false, error: `JSON 파싱 실패: ${r.stdout.slice(0, 200)}`, result: null };
  }
  if (parsed?.ok === false) return { ok: false, error: parsed?.error?.message ?? 'unknown', result: null };
  return { ok: true, error: '', result: parsed?.result ?? null };
}

/**
 * Orca가 **자체 관리하는** 워크트리 경로 집합.
 *
 * Orca는 `orca worktree create`로 자기가 만든 워크트리만 사이드바 트리에 표시한다
 * (repo 메타데이터의 externalWorktreeVisibility 기본값이 "hide"). 그래서 이 앱이
 * `git worktree add`로 만든 워크트리는 **실행은 정상인데 Orca 목록에는 안 보인다**.
 * 사용자가 그 차이를 앱에서 바로 알 수 있도록 출처 배지를 붙이는 데 쓴다.
 *
 * Orca가 없거나 조회에 실패하면 available:false로 응답해 UI가 배지를 감추게 한다
 * (틀린 출처를 단정하지 않는다).
 */
let orcaWorktreeCache: { at: number; paths: string[] } | null = null;
const ORCA_WORKTREE_CACHE_MS = 15_000;

/**
 * project-memory 요청 파라미터 — JSON body와 쿼리스트링을 **둘 다** 받는다.
 *
 * 이 API는 앱 UI만 쓰는 게 아니라 AI(Claude/Codex)가 스킬에서 `curl --get`으로 직접 부른다.
 * 예전에는 엔드포인트마다 방식이 달라서 push/mark-remembered만 쿼리를 받고
 * detect/pull/remote-status/history는 body만 받았고, 그래서 **AI는 push는 할 수 있어도
 * pull은 할 수 없었다**(다른 PC에서 저장한 기억을 가져올 방법이 없었다).
 * body가 우선이고, 없으면 쿼리에서 읽는다.
 */
async function readMemoryParams(req: Request, url: URL): Promise<Record<string, any>> {
  let body: Record<string, any> = {};
  if (req.headers.get("content-type")?.includes("application/json")) {
    // Swallowing a failed body read here used to surface as "절대경로가 필요합니다",
    // which blames the caller for a path it actually sent. Report the real
    // condition instead so a dropped body is diagnosable rather than misleading.
    try {
      body = await req.json() as Record<string, any>;
    } catch (error: any) {
      throw new ProjectMemoryError(
        `요청 본문을 읽지 못했습니다: ${error?.message || String(error)}`,
        "REQUEST_BODY_UNREADABLE",
      );
    }
  }
  return { ...Object.fromEntries(url.searchParams.entries()), ...body };
}

function projectMemoryThreadRoute(body: Record<string, any>): ProjectMemoryThreadRoute {
  return {
    platform: typeof body.platform === "string" ? body.platform : "",
    chatId: typeof body.chatId === "string" ? body.chatId : "",
    threadId: typeof body.threadId === "string" && body.threadId.trim() ? body.threadId : null,
  };
}

async function verifiedProjectMemoryThreadBinding(body: Record<string, any>) {
  const storedBinding = await getProjectMemoryThreadBinding(
    PROJECT_MEMORY_THREAD_BINDINGS_FILE,
    projectMemoryThreadRoute(body),
  );
  if (!storedBinding) {
    throw new ProjectMemoryError(
      "현재 채팅/스레드는 프로젝트 장기기억과 연결되어 있지 않습니다.",
      "PROJECT_MEMORY_THREAD_NOT_BOUND",
    );
  }
  const registered = await loadPortsData() as Array<PortRecord & {
    name?: string;
    folderPath?: string;
    worktreePath?: string;
  }>;
  const resolution = resolveRegisteredProjectMemory(
    storedBinding.projectId,
    registered,
    alias => {
      const candidate = detectProjectMemory(alias);
      return candidate.exists && candidate.config ? candidate.projectRoot : null;
    },
  );
  if ("code" in resolution) {
    throw new ProjectMemoryError(
      "스레드에 연결된 프로젝트가 현재 AgentsToZ 등록 목록에서 유효하지 않습니다. 다시 연결하세요.",
      "PROJECT_MEMORY_THREAD_IDENTITY_MISMATCH",
    );
  }
  const status = detectProjectMemory(resolution.canonicalPath);
  if (!status.exists || !status.config || status.config.memoryId !== storedBinding.memoryId) {
    throw new ProjectMemoryError(
      "스레드에 저장된 프로젝트 장기기억 ID가 현재 저장소와 일치하지 않습니다. 다시 연결하세요.",
      "PROJECT_MEMORY_THREAD_IDENTITY_MISMATCH",
    );
  }
  const binding = await bindProjectMemoryThread(PROJECT_MEMORY_THREAD_BINDINGS_FILE, {
    ...projectMemoryThreadRoute(body),
    projectId: resolution.id,
    projectName: resolution.name,
    memoryId: status.config.memoryId,
    canonicalPath: status.projectRoot,
  });
  return { binding, status };
}

async function orcaManagedWorktreePaths(): Promise<{ available: boolean; paths: string[]; stale?: boolean }> {
  if (orcaWorktreeCache && Date.now() - orcaWorktreeCache.at < ORCA_WORKTREE_CACHE_MS) {
    return { available: true, paths: orcaWorktreeCache.paths };
  }
  // stale-while-error: 만료된 캐시라도 갖고 있으면, 조회 실패 시 그걸 그대로 돌려준다.
  // Orca 데몬이 잠깐 바쁠 때(= 사용자가 워크트리에서 AI를 띄우는 바로 그 순간) 배지가
  // 통째로 사라지는 것을 막는 것이 목적. 워크트리 경로는 초 단위로 변하지 않는다.
  const staleFallback = orcaWorktreeCache
    ? { available: true, paths: orcaWorktreeCache.paths, stale: true }
    : { available: false, paths: [] as string[] };
  // 목록 조회도 terminal create/send와 동일한 Orca CLI 프로세스를 사용한다. 앱 부팅 시
  // 여러 UI 요청이 동시에 들어오면 Bun.spawnSync(osascript)가 겹쳐 Bun 자체가 SIGSEGV로
  // 종료된 실측 사례가 있으므로 반드시 전역 락 안에서 실행한다. 락을 기다리는 동안 앞선
  // 요청이 캐시를 채웠을 수 있어 안에서 한 번 더 확인해 중복 CLI 호출도 제거한다.
  return withOrcaLock(async () => {
    if (orcaWorktreeCache && Date.now() - orcaWorktreeCache.at < ORCA_WORKTREE_CACHE_MS) {
      return { available: true, paths: orcaWorktreeCache.paths };
    }
    const cli = resolveOrcaCli();
    if (!cli) return staleFallback;
    // 읽기 전용 조회지만 데몬 부하 시 1회성 실패가 잦아 2회까지 짧은 백오프로 재시도한다.
    const r = await nodeOrcaRunJsonRetry(cli, ['worktree', 'list'], { attempts: 2, backoffMs: 400, timeoutMs: 8000 });
    if (!r.ok) return staleFallback;
    const items: any[] = Array.isArray(r.result?.worktrees) ? r.result.worktrees : [];
    const paths = items
      .map((w) => (typeof w?.path === 'string' ? w.path : null))
      .filter((p): p is string => !!p)
      .map((p) => { try { return realpathSync(p); } catch { return p; } });
    orcaWorktreeCache = { at: Date.now(), paths };
    return { available: true, paths };
  });
}

/** 확정적 실패(재시도해도 결과가 같음) — repo 등록 거부 등. 이 패턴이면 즉시 반환하고 재시도 안 함. */
const ORCA_TERMINAL_ERROR_RE = /not a valid git repository/i;

/** 데몬 부하로 인한 일시적 컨텐션(osascript/Apple Event 직렬화, 터미널 핸들 지연 등)을
 *  흡수하는 재시도 래퍼. 실측: 동시 요청 시 단일 CLI 호출이 정상 0.6~1.6s에서
 *  드물게 7~10s까지 튀며, 타임아웃/일시 실패로 이어짐 — 확정적 에러가 아니면 백오프 재시도. */
async function nodeOrcaRunJsonRetry(
  cli: string,
  args: string[],
  opts?: { timeoutMs?: number; attempts?: number; backoffMs?: number },
): Promise<{ ok: boolean; error: string; result: any }> {
  const attempts = opts?.attempts ?? 3;
  const backoffMs = opts?.backoffMs ?? 900;
  const timeoutMs = opts?.timeoutMs ?? 25000;
  let last = await nodeOrcaRunJson(cli, args, timeoutMs);
  for (let i = 1; i < attempts && !last.ok && !ORCA_TERMINAL_ERROR_RE.test(last.error); i++) {
    await new Promise((res) => setTimeout(res, backoffMs * i));
    last = await nodeOrcaRunJson(cli, args, timeoutMs);
  }
  return last;
}

/** Orca 앱 실행 + 런타임 대기 (`orca open`은 멱등 — 이미 떠 있으면 ~150ms에 반환)
 *
 *  기본 예산은 20s x 2회. 이미 떠 있으면 어차피 첫 시도가 곧바로 끝나므로 비용이 없고,
 *  콜드 스타트(부팅/종료 직후 첫 클릭)에서는 앱 기동을 기다릴 여지를 남긴다.
 *  5s 단발은 콜드 스타트를 못 버텨 사용자의 주 동선이 첫 클릭에서 실패했고,
 *  30s x 3회(=90s)는 Bun.serve idleTimeout과 같아 요청이 통째로 끊겼다. */
async function ensureOrcaReady(
  cli: string,
  opts: { timeoutMs?: number; attempts?: number; backoffMs?: number } = {},
): Promise<{ ok: boolean; error: string }> {
  const r = await nodeOrcaRunJsonRetry(cli, ['open'], {
    timeoutMs: opts.timeoutMs ?? 20000,
    attempts: opts.attempts ?? 2,
    backoffMs: opts.backoffMs ?? 500,
  });
  // 실패해도 앱은 앞으로 가져온다 — 콜드 스타트야말로 창이 떠야 하는 상황이고,
  // 사용자가 다시 눌렀을 때 성공할 확률을 높인다.
  if (!IS_WIN) nodeSpawnSync('open', ['-a', 'Orca'], { stdio: 'pipe' });
  if (!r.ok) {
    return {
      ok: false,
      error: 'Orca를 실행하는 중입니다. 앱 창이 뜨면 다시 시도해주세요.'
        + `\n(${r.error})`,
    };
  }
  return { ok: true, error: '' };
}

/** repo add — 멱등 (이미 등록된 경로면 기존 repo 반환). 비 git 폴더면 명확한 안내. */
async function orcaEnsureRepo(
  cli: string,
  repoPath: string,
  opts: { timeoutMs?: number; attempts?: number } = {},
): Promise<{ ok: boolean; error: string }> {
  const r = await nodeOrcaRunJsonRetry(cli, ['repo', 'add', '--path', repoPath], {
    timeoutMs: opts.timeoutMs,
    attempts: opts.attempts,
  });
  if (r.ok) return { ok: true, error: '' };
  if (ORCA_TERMINAL_ERROR_RE.test(r.error)) {
    return { ok: false, error: `Orca는 git 저장소만 지원합니다 (${repoPath})\n일반 폴더는 cmux/iterm 터미널을 사용하세요.` };
  }
  return { ok: false, error: `Orca repo 등록 실패: ${r.error}` };
}

/** terminal send 직전 준비 대기 — 고정 sleep(300ms)은 데몬이 느릴 때 입력이 유실되고
 *  빠를 때는 불필요한 지연이 된다. `terminal read`로 출력이 잡힐 때까지 200ms 간격으로
 *  최대 10회(총 ~2.5s) 폴링하고, 준비되지 않아도 그냥 send로 진행한다.
 *  → 폴링 실패가 요청 실패로 이어지지 않는다. */
async function waitOrcaTerminalReady(cli: string, handle: string, maxWaitMs = 2500): Promise<void> {
  const started = Date.now();
  for (let i = 0; i < 10; i++) {
    if (Date.now() - started >= maxWaitMs) return;
    const r = await nodeOrcaRunJson(cli, ['terminal', 'read', '--terminal', handle], 3000);
    const res: any = r.result;
    const text = typeof res === 'string'
      ? res
      : (res?.output ?? res?.tail ?? res?.terminal?.output ?? res?.terminal?.tail ?? '');
    if (r.ok && String(text ?? '').trim()) return;
    await new Promise((done) => setTimeout(done, 200));
  }
}

/**
 * Cmd+T는 공식 문서상 현재 worktree에 terminal을 만들기 때문에 사용하지 않는다.
 * Orca가 제공하는 global-floating-terminal selector로 전용 Floating tab을 직접 만든다.
 */
async function createOrcaFloatingTerminal(cli: string, title: string): Promise<{ ok: boolean; handle?: string; worktreeId?: string; hostPlatform?: string; error: string }> {
  const created = await nodeOrcaRunJsonRetry(cli, [
    'terminal', 'create',
    '--worktree', ORCA_FLOATING_WORKTREE_SELECTOR,
    '--title', title,
  ], { attempts: 3, backoffMs: 700 });
  if (!created.ok) return { ok: false, error: `Orca Floating Terminal 생성 실패: ${created.error}` };
  const handle = created.result?.terminal?.handle;
  const worktreeId = created.result?.terminal?.worktreeId;
  if (typeof handle !== 'string' || !handle.trim() || worktreeId !== ORCA_FLOATING_WORKTREE_ID) {
    return { ok: false, error: 'Orca가 전용 Floating Terminal 핸들을 반환하지 않았습니다. 일반 프로젝트 터미널에는 명령을 보내지 않았습니다.' };
  }
  await waitOrcaTerminalReady(cli, handle, 3000);
  return { ok: true, handle, worktreeId, hostPlatform: created.result?.terminal?.hostPlatform, error: '' };
}

type OrcaListedTerminal = {
  handle: string;
  hostPlatform?: string;
};

type OrcaFloatingTerminalLookup = {
  terminal: OrcaListedTerminal | null;
  error: string | null;
};

/**
 * `terminal list` has varied slightly between Orca releases (`terminals` vs.
 * nested terminal objects). Walk the JSON defensively, but accept only a tab
 * with our private title marker and the Floating Workspace worktree id.
 */
function findManagedOrcaFloatingTerminal(
  result: unknown,
  agent: string,
  folderPath: string,
  legacyTitle: string,
): OrcaListedTerminal | null {
  let latestMatch: OrcaListedTerminal | null = null;
  const legacyMatches: OrcaListedTerminal[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const handle = record.handle;
    const worktreeId = record.worktreeId;
    if (typeof handle === 'string' && handle.trim() && worktreeId === ORCA_FLOATING_WORKTREE_ID) {
      const candidate = {
        handle,
        hostPlatform: typeof record.hostPlatform === 'string' ? record.hostPlatform : undefined,
      };
      if (isOrcaManagedFloatingTerminal(record.title, agent, folderPath)) {
        latestMatch = candidate;
      } else if (record.title === legacyTitle) {
        legacyMatches.push(candidate);
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(result);
  // Before the marker existed, AgentsToZ used only "project · agent" titles.
  // Reuse an old tab only when that legacy title occurs exactly once: it is a
  // migration aid, never a command target, and avoids guessing among collisions.
  return latestMatch ?? (legacyMatches.length === 1 ? legacyMatches[0]! : null);
}

/** Find one exact terminal handle in a `terminal show` response. The response
 * shape has changed across Orca releases, so use the same defensive walk as
 * terminal list, while requiring the global Floating Workspace worktree. */
function findOrcaFloatingTerminalByHandle(
  result: unknown,
  expectedHandle: string,
): OrcaListedTerminal | null {
  let match: OrcaListedTerminal | null = null;
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (visited.has(value)) return;
    visited.add(value);
    const record = value as Record<string, unknown>;
    if (record.handle === expectedHandle && record.worktreeId === ORCA_FLOATING_WORKTREE_ID) {
      match = {
        handle: expectedHandle,
        hostPlatform: typeof record.hostPlatform === 'string' ? record.hostPlatform : undefined,
      };
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(result);
  return match;
}

async function findExistingOrcaFloatingTerminal(
  cli: string,
  agent: string,
  folderPath: string,
  legacyTitle: string,
): Promise<OrcaFloatingTerminalLookup> {
  const listed = await nodeOrcaRunJsonRetry(cli, [
    'terminal', 'list',
    '--worktree', ORCA_FLOATING_WORKTREE_SELECTOR,
  ], { attempts: 2, backoffMs: 500, timeoutMs: 8000 });
  if (!listed.ok) return { terminal: null, error: listed.error };
  return {
    terminal: findManagedOrcaFloatingTerminal(listed.result, agent, folderPath, legacyTitle),
    error: null,
  };
}

/** 해당 Orca 프로젝트/워크트리 안에 일반 터미널을 만든다. */
async function createOrcaWorktreeTerminal(cli: string, title: string, worktreePath: string): Promise<{ ok: boolean; handle?: string; worktreeId?: string; hostPlatform?: string; error: string }> {
  const created = await nodeOrcaRunJsonRetry(cli, [
    'terminal', 'create',
    '--worktree', `path:${worktreePath}`,
    '--title', title,
  ], { attempts: 3, backoffMs: 700 });
  if (!created.ok) return { ok: false, error: `Orca 워크트리 터미널 생성 실패: ${created.error}` };
  const handle = created.result?.terminal?.handle;
  const worktreeId = created.result?.terminal?.worktreeId;
  if (typeof handle !== 'string' || !handle.trim() || worktreeId === ORCA_FLOATING_WORKTREE_ID) {
    return { ok: false, error: 'Orca가 워크트리 내부 터미널 핸들을 반환하지 않았습니다. Floating Workspace에는 명령을 보내지 않았습니다.' };
  }
  await waitOrcaTerminalReady(cli, handle, 3000);
  return { ok: true, handle, worktreeId, hostPlatform: created.result?.terminal?.hostPlatform, error: '' };
}

/** `terminal switch`/`tab show`는 Floating Workspace가 최소화된 경우 패널을 열지 않는다.
 *  실제 Orca 접근성 상태를 읽고 닫힌 경우에만 공식 computer click으로 표시한다. */
async function revealOrcaFloatingWorkspace(cli: string): Promise<{ ok: boolean; error: string }> {
  const maximizeWithMacShortcut = (): { ok: boolean; error: string } => {
    if (IS_WIN) {
      return { ok: false, error: 'Orca 화면 제어 API를 사용할 수 없습니다.' };
    }
    // Orca의 macOS 기본 `floatingWorkspace.maximize` 단축키다. toggle이 아니므로
    // 이미 열린 패널을 실수로 닫지 않는다. CLI computer 런타임이 비활성인 앱에서도 동작한다.
    const script = [
      'tell application "Orca" to activate',
      'delay 0.15',
      'tell application "System Events" to keystroke "a" using {command down, option down, shift down}',
    ].join('\n');
    const result = nodeSpawnSync('osascript', ['-e', script], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    if (result.status === 0) return { ok: true, error: '' };
    const detail = String(result.stderr || result.stdout || result.error?.message || 'unknown').trim();
    const permissionDenied = /1002|not allowed to send keystrokes|assistive access/i.test(detail);
    if (permissionDenied) {
      nodeSpawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], {
        stdio: 'ignore',
        timeout: 3000,
      });
    }
    return {
      ok: false,
      error: `Orca 플로팅 최대화 단축키 전송 실패: ${detail}. macOS 손쉬운 사용 설정${permissionDenied ? '을 열었습니다. ' : '에서 '}AgentsToZ_byCS를 허용해주세요.`,
    };
  };

  const readState = async () => nodeOrcaRunJsonRetry(cli, [
    'computer', 'get-app-state',
    '--app', 'Orca',
    '--restore-window',
    '--no-screenshot',
  ], { attempts: 2, backoffMs: 300, timeoutMs: 8000 });

  const before = await readState();
  if (!before.ok) {
    const fallback = maximizeWithMacShortcut();
    return fallback.ok ? fallback : { ok: false, error: `Orca 화면 상태 확인 실패: ${before.error}; ${fallback.error}` };
  }
  const visibility = inspectOrcaFloatingVisibility(before.result);
  if (visibility.open) return { ok: true, error: '' };
  if (visibility.toggleElementIndex === null) {
    const fallback = maximizeWithMacShortcut();
    return fallback.ok ? fallback : { ok: false, error: `Orca에서 “Show floating workspace” 버튼을 찾지 못했습니다. ${fallback.error}` };
  }

  const clicked = await nodeOrcaRunJsonRetry(cli, [
    'computer', 'click',
    '--app', 'Orca',
    '--element-index', String(visibility.toggleElementIndex),
    '--restore-window',
    '--no-screenshot',
  ], { attempts: 2, backoffMs: 300, timeoutMs: 8000 });
  if (!clicked.ok) {
    const fallback = maximizeWithMacShortcut();
    return fallback.ok ? fallback : { ok: false, error: `Orca 플로팅 패널 표시 실패: ${clicked.error}; ${fallback.error}` };
  }

  const after = await readState();
  if (!after.ok || !inspectOrcaFloatingVisibility(after.result).open) {
    return { ok: false, error: 'Orca 터미널은 생성됐지만 플로팅 패널이 열린 것을 확인하지 못했습니다.' };
  }
  return { ok: true, error: '' };
}

/** Orca.app이 없을 때 — 설치를 "시작"시켜 준다. Orca CLI는 앱 번들에만 포함되어
 *  있고 정식 배포 채널(brew cask 'orca'는 완전히 다른 앱 — plotly의 이미지 툴)이
 *  없으므로 headless 자동 설치는 불가능. 대신 공식 다운로드 페이지를 자동으로 열어
 *  사용자가 바로 설치를 이어갈 수 있게 한다 (파일 다운로드/실행은 사용자가 직접). */
function bootstrapOrcaInstall(): string {
  if (IS_WIN) {
    nodeSpawnSync('cmd', ['/c', 'start', 'https://www.onorca.dev/download'], { stdio: 'pipe' });
  } else {
    nodeSpawnSync('open', ['https://www.onorca.dev'], { stdio: 'pipe' });
  }
  return 'Orca가 설치되지 않아 다운로드 페이지를 열었습니다 (https://www.onorca.dev/download).\n설치 후 다시 시도해주세요.';
}

/** WSL distro 목록 캐시 (빈 결과도 캐시해서 registry 반복 쿼리 방지) */
let _cachedDistros: string[] | null = null;
let _distrosCached = false;

/** WSL registry에서 distro 목록 조회 (reg.exe 사용 — powershell보다 훨씬 빠르고 안정적) */
function listWslDistros(): string[] {
  if (_distrosCached) return _cachedDistros ?? [];
  const r = nodeSpawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s', '/v', 'DistributionName'],
    { timeout: 5000, stdio: 'pipe' });
  const stdout = r.stdout?.toString('utf8') ?? '';
  if (r.status !== 0 || r.error) {
    console.error('[listWslDistros] failed:', { status: r.status, error: r.error?.message });
    _cachedDistros = []; _distrosCached = true;
    return [];
  }
  // reg output format: "    DistributionName    REG_SZ    <name>"
  const distros = [...stdout.matchAll(/DistributionName\s+REG_SZ\s+(.+)/g)]
    .map((m) => (m[1] ?? '').trim())
    .filter((n: string) => n && !n.toLowerCase().includes('docker'));
  devLog('[listWslDistros] found:', distros);
  _cachedDistros = distros;
  _distrosCached = true;
  return distros;
}

/** docker-desktop 제외한 WSL distro 이름 반환 (bash 테스트 없이 목록만 확인 — 빠름) */
function findWslDistro(): string | null {
  const distros = listWslDistros();
  return distros[0] ?? null;
}

/** 터미널/탭 타이틀: ⚡️ tmux+bypass  🔷🆕 tmux+fresh  🔷 tmux  🛡️ bypass  🪟 normal */
function buildWindowTitle(sessionName: string, worktreePath?: string | null, tags?: string | string[] | null, branchHint?: string | null): string {
  const wtRaw = worktreePath?.split(',')[0]?.trim();
  const wtName = branchHint || (wtRaw ? wtRaw.split(/[\\/]/).filter(Boolean).pop() : undefined);
  // Strip "-branchName" suffix from sessionName: "project-design" → "project \u203A design"
  const displaySession = wtName && sessionName.endsWith(`-${wtName}`)
    ? sessionName.slice(0, -(wtName.length + 1))
    : sessionName;
  const base = wtName ? `${displaySession} \u203A ${wtName}` : sessionName;
  const tagList = Array.isArray(tags) ? tags : tags ? [tags] : [];
  const isTmux = tagList.includes('tmux');
  const isBypass = tagList.includes('bypass');
  const isFresh = tagList.includes('fresh');
  let prefix: string;
  if (isTmux && isBypass) prefix = '\u26A1\uFE0F ';
  else if (isTmux && isFresh) prefix = '\u{1F537}\u{1F195} ';
  else if (isTmux) prefix = '\u{1F537} ';
  else if (isBypass) prefix = '\u{1F6E1}\uFE0F ';
  else prefix = '\u{1FA9F} ';
  return `${prefix}${base}`;
}

/** WSL tmux bash 명령 문자열 생성 (외부에서 bash -c로 실행됨 — WSL default PATH가 Windows npm 포함) */
function buildWslTmuxBashCmd(sessionName: string, folderPath: string | null, worktreePath: string | null, fresh: boolean, bypass: boolean): string {
  const rawPath = worktreePath?.split(',')[0]?.trim() || folderPath;
  const wslPath = rawPath ? winToWslPath(rawPath) : null;
  const cdPart = wslPath ? `cd '${escapeSq(wslPath)}' && ` : '';
  // 세션명 규칙은 tmuxSessionName() 한 곳뿐 — 여기 리터럴로 복제하면
  // 워크트리 접미사가 빠져 메인트리와 워크트리가 한 세션을 공유한다.
  const sess = escapeSq(tmuxSessionName(sessionName, worktreePath, bypass));
  const claudeArgs = bypass ? 'claude --dangerously-skip-permissions' : 'claude';
  // ⚠️ 세미콜론(;) 금지 — wt.exe가 subcommand 구분자로 취급해서 명령줄이 쪼개짐
  // ⚠️ 쌍따옴표(") 금지 — cmd.exe가 \"를 몰라서 명령이 중간에 끊김
  // ⚠️ printf OSC 타이틀 금지 — bash single-quote 안에서 \; 가 literal로 출력되어 터미널에 깨진 문자 남김
  //    → 터미널 타이틀은 `wt --title`로 충분, Claude가 추후 자체 OSC로 덮어씀
  // Safety net: claude 실패 시 tmux 안에서 login shell로 fallback → 에러 메시지 확인 가능
  const inner = `${claudeArgs} || bash -l`;
  if (fresh) {
    // kill-session이 실패해도(세션 없음) 계속 진행하도록 || : 로 감쌈 (세미콜론 대체)
    return `${cdPart}(tmux kill-session -t '${sess}' 2>/dev/null || :) && tmux new-session -s '${sess}' '${inner}'`;
  }
  return `${cdPart}tmux new-session -A -s '${sess}' '${inner}'`;
}

/** Resolved Windows Terminal alias path (cached to avoid `where` per click). */
let _cachedWindowsTerminalPath: string | null | undefined;
function windowsTerminalPath(): string | null {
  if (_cachedWindowsTerminalPath !== undefined) return _cachedWindowsTerminalPath;
  const found = Bun.spawnSync(['where', 'wt.exe'], { stdout: 'pipe', stderr: 'pipe' });
  _cachedWindowsTerminalPath = found.exitCode === 0
    ? found.stdout.toString().split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null
    : null;
  return _cachedWindowsTerminalPath;
}

let _cachedWindowsProcessSupervisor: string | null | undefined;
function windowsProcessSupervisorScript(): string {
  if (_cachedWindowsProcessSupervisor !== undefined) {
    if (_cachedWindowsProcessSupervisor) return _cachedWindowsProcessSupervisor;
    throw new Error('Windows process supervisor resource를 찾을 수 없습니다. 앱을 다시 빌드하세요.');
  }
  const executableDir = dirname(process.execPath);
  const candidates = [
    process.env.AGENTSTOZ_PROCESS_SUPERVISOR,
    join(import.meta.dir, 'src-tauri', 'resources', 'windows-process-supervisor.ps1'),
    join(import.meta.dir, 'resources', 'windows-process-supervisor.ps1'),
    join(executableDir, 'windows-process-supervisor.ps1'),
    join(executableDir, 'resources', 'windows-process-supervisor.ps1'),
    join(executableDir, '..', 'Resources', 'windows-process-supervisor.ps1'),
  ].filter((value): value is string => Boolean(value));
  _cachedWindowsProcessSupervisor = candidates.find(candidate => existsSync(candidate)) ?? null;
  if (!_cachedWindowsProcessSupervisor) {
    throw new Error('Windows process supervisor resource를 찾을 수 없습니다. 앱을 다시 빌드하세요.');
  }
  return _cachedWindowsProcessSupervisor;
}

function windowsProcessSupervisorAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    windowsProcessSupervisorScript();
    return true;
  } catch {
    return false;
  }
}

/** WSL tmux 세션 열기 (Windows Terminal 우선, 없으면 cmd 폴백) */
function spawnWslTmux(bashCmd: string, title?: string): void {
  const distro = findWslDistro();
  if (!distro) throw new Error('WSL Ubuntu distro를 찾을 수 없습니다.');
  // bash -c (기본) → WSL의 default PATH가 Windows PATH를 import하므로 npm global(claude.exe 등)도 자동 접근
  // -i (interactive) 플래그는 WSL pty 레이어에서 hang 유발 가능 → 사용 금지
  const wt = windowsTerminalPath();
  const command = wt
    ? [wt, ...(title ? ['--title', title] : []), '--', 'wsl.exe', '-d', distro, '--', 'bash', '-c', bashCmd]
    : ['wsl.exe', '-d', distro, '--', 'bash', '-c', bashCmd];
  // Direct argv + detached console: title/bash values never cross an outer cmd
  // expansion pass, so `%TEMP%` and metacharacters stay literal.
  const child = spawn({ cmd: command, stdout: 'ignore', stderr: 'ignore', detached: true });
  child.unref();
}

/** 포트를 **LISTEN 중인** PID 목록 반환 (Windows/macOS 공용)
 * WHY: Windows에서 PowerShell Get-NetTCPConnection은 기동 오버헤드 ~300-500ms.
 * netstat -ano 파싱은 ~50ms로 6배 빠름.
 *
 * ⚠️ 반드시 리스너만 반환해야 한다. 호출부는 여기서 받은 PID를 자손 트리째
 * SIGKILL 하므로(`killProcessTree`), 포트에 단지 **접속만** 한 프로세스가 섞이면
 * 그것까지 죽는다. `lsof -ti :3001`은 실측으로 앱 자신의 WebKit 렌더러를 함께
 * 반환한다 — 강제 재실행이 자기 UI/서버를 죽여서 진행 중이던 요청이
 * "TypeError: Failed to fetch"로 끊기던 원인이다. dev.ts는 같은 이유로 이미
 * `-sTCP:LISTEN`을 쓰고 있었지만, 정작 stop/force-restart 경로에는 빠져 있었다. */
async function getPidsByPort(port: number): Promise<string[]> {
  // 포트 값 검증 — Supabase 동기화 등 외부 데이터가 들어올 수 있으므로 인젝션 방지
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return [];
  if (IS_WIN) {
    // `-p tcp`는 IPv4만 나열한다 — Vite/Node가 localhost를 [::1]로 바인딩하면
    // 리스너를 통째로 놓쳐 "중지됨"으로 오판하고 stop도 PID를 못 찾는다.
    // 프로토콜 필터 없이 받아 TCP/TCPv6를 모두 본다.
    const proc = spawn({
      cmd: ['netstat', '-ano'],
      stdout: 'pipe', stderr: 'pipe',
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    return windowsListenerPidsForPort(out, p);
  } else {
    const proc = spawn({
      cmd: ['/usr/sbin/lsof', '-ti', `:${p}`, '-sTCP:LISTEN'],
      stdout: 'pipe', stderr: 'pipe',
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    return out.trim().split('\n').filter(p => p.length > 0);
  }
}

/** LISTEN 중인 모든 TCP 포트를 단 1회 spawn으로 수집 (Windows/macOS 공용).
 * 배경: 프론트의 10초 폴링이 포트당 lsof를 1회씩 spawn(~35개 = 틱당 ~35 spawn)
 * 하면서 장시간 실행 시 메모리/프로세스 압박 — 스냅샷 1회로 전부 응답한다.
 * WHY: Windows에서 PowerShell 대신 netstat 사용 — 기동 오버헤드 6배 감소 (300ms → 50ms). */
async function getListeningPortsSnapshot(): Promise<Set<number>> {
  const listening = new Set<number>();
  try {
    if (IS_WIN) {
      // `-p tcp`는 IPv4 전용 — [::1] 바인딩(Vite 등)을 놓치므로 프로토콜 필터 없이 받는다.
      const proc = spawn({
        cmd: ['netstat', '-ano'],
        stdout: 'pipe', stderr: 'pipe',
      });
      await proc.exited;
      const out = await new Response(proc.stdout).text();
      windowsListeningPorts(out).forEach(port => listening.add(port));
    } else {
      const proc = spawn({ cmd: ['/usr/sbin/lsof', '-nP', '-iTCP', '-sTCP:LISTEN'], stdout: 'pipe', stderr: 'pipe' });
      await proc.exited;
      const out = await new Response(proc.stdout).text();
      for (const line of out.split('\n')) {
        // NAME 컬럼: *:3001 / 127.0.0.1:5173 / [::1]:8080 (LISTEN) — 마지막 콜론 뒤가 포트
        const m = line.match(/:(\d+)\s+\(LISTEN\)\s*$/);
        if (m) {
          const n = Number(m[1]);
          if (n >= 1 && n <= 65535) listening.add(n);
        }
      }
    }
  } catch (e) {
    console.error('[CheckPortsBatch] listening snapshot failed:', e);
  }
  return listening;
}

async function killWindowsProcessTree(pid: string): Promise<void> {
  const proc = spawn({
    cmd: ['taskkill', '/F', '/T', '/PID', pid],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  await proc.exited;
  const detail = `${await stdout}\n${await stderr}`.trim();
  if (proc.exitCode !== 0) {
    throw new Error(`taskkill failed for PID ${pid} (exit ${proc.exitCode ?? 'unknown'}): ${detail || 'no diagnostic'}`);
  }
}

/** PID 종료 (Windows/macOS 공용) */
async function killPid(pid: string, force = false): Promise<void> {
  if (IS_WIN) {
    await killWindowsProcessTree(pid);
  } else {
    const sig = force ? '-9' : '-15';
    const p = spawn({ cmd: ['kill', sig, pid], stdout: 'inherit', stderr: 'inherit' });
    await p.exited;
  }
}

/** macOS/Linux: `pgrep -P` BFS로 rootPid의 모든 자손 PID 수집.
 * 루트를 먼저 죽이면 자손이 launchd(1)로 reparent되어 추적 불가하므로,
 * 종료 전에 반드시 트리를 먼저 수집해야 한다. */
async function collectDescendantPids(rootPid: number | string): Promise<string[]> {
  const out: string[] = [];
  let frontier = [String(rootPid)];
  // 안전 상한: 비정상적으로 큰 트리(폭주)에서 무한 루프 방지
  while (frontier.length > 0 && out.length < 4096) {
    const next: string[] = [];
    for (const pid of frontier) {
      try {
        const proc = spawn({ cmd: ['pgrep', '-P', pid], stdout: 'pipe', stderr: 'pipe' });
        await proc.exited;
        const children = (await new Response(proc.stdout).text())
          .trim().split('\n').map(s => s.trim()).filter(s => /^\d+$/.test(s));
        for (const c of children) { out.push(c); next.push(c); }
      } catch { /* pgrep 실패 시 해당 가지 스킵 */ }
    }
    frontier = next;
  }
  return out;
}

/** 프로세스 + 자손 트리 전체 종료 (Windows/macOS 공용).
 * 배경: stop이 lsof로 포트 리스너 PID만 죽이면, .command가 띄운 자식
 * 프로세스들(dev server의 node helper 등)이 살아남아 누적된다.
 * macOS에는 setsid가 없어 프로세스 그룹 분리가 어려우므로,
 * pgrep -P BFS로 자손을 전부 수집한 뒤 SIGTERM → (생존 시) SIGKILL 처리.
 * Windows는 taskkill /T가 트리 종료를 네이티브 지원. */
async function killProcessTree(rootPid: number | string, force = false): Promise<void> {
  const pidStr = String(rootPid);
  if (!/^\d+$/.test(pidStr)) return;
  if (IS_WIN) {
    await killWindowsProcessTree(pidStr);
    return;
  }
  const descendants = await collectDescendantPids(pidStr);
  const all = [pidStr, ...descendants];
  for (const pid of all) await killPid(pid, force);
  if (!force) {
    await new Promise(r => setTimeout(r, 200));
    for (const pid of all) {
      const check = spawn({ cmd: ['kill', '-0', pid], stdout: 'pipe', stderr: 'pipe' });
      await check.exited;
      if (check.exitCode === 0) await killPid(pid, true);
    }
  }
}

/** 폴더/파일 열기 (Windows/macOS 공용)
 * WHY: Windows에서 PowerShell Start-Process 대신 explorer.exe 직접 호출 — 기동 오버헤드 제거 (~300ms → 즉시). */
function openPath(target: string): void {
  if (IS_WIN) {
    const winPath = target.replace(/\//g, '\\');
    spawn({ cmd: ['explorer.exe', winPath], stdout: 'pipe', stderr: 'pipe' });
  } else {
    spawn({ cmd: ['open', target], stdout: 'inherit', stderr: 'inherit' });
  }
}

// Resolve claude binary path once at startup.
// GUI 앱 환경에서는 Bun.spawnSync PATH가 제한적이므로 login shell로
// 사용자 셸 프로파일을 로드한 뒤 command -v를 실행한다. 셸이 없는 플랫폼에서는
// Bun.spawnSync가 throw하므로 이 경로가 API 서버 기동 자체를 막아서는 안 된다.
function resolveClaudeThroughLoginShell(shell: string): string | null {
  try {
    const result = Bun.spawnSync([shell, '-l', '-c', 'command -v claude'], {
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (!result.success) return null;
    const candidate = (result.stdout.toString().trim().split(/\r?\n/)[0] ?? '').trim();
    return candidate && existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function resolveClaudePath(): string | null {
  const isWin = process.platform === 'win32';
  if (isWin) {
    // Prefer the actual .exe inside the npm package — avoids Unix shebang file and cmd.exe chain.
    // npm install -g places the real binary at: %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
    const npmExe = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(npmExe)) return npmExe;
    // Fallback: unwrap claude.cmd → actual .exe (avoids direct .cmd spawn via Bun)
    const npmCmd = join(process.env.APPDATA ?? '', 'npm', 'claude.cmd');
    if (existsSync(npmCmd)) {
      try {
        const content = readFileSync(npmCmd, 'utf8');
        const dir = dirname(npmCmd);
        const match = content.match(/"([^"]+\.exe)"\s*%\*/i);
        if (match?.[1]) {
          const exePath = match[1].replace(/%dp0%/gi, dir);
          const resolved = isAbsolute(exePath) ? exePath : join(dir, exePath);
          if (existsSync(resolved)) return resolved;
        }
      } catch { /* fall through */ }
    }
    // Last resort: where.exe — only accept .exe (skip Unix shebang and .cmd)
    const r = Bun.spawnSync(['where', 'claude'], { env: { ...process.env } });
    for (const line of r.stdout.toString().trim().split(/\r?\n/)) {
      const p = line.trim();
      if (p && p.toLowerCase().endsWith('.exe') && existsSync(p) && !p.includes('WindowsApps')) return p;
    }
    return null;
  }
  // macOS GUI 앱의 기본 로그인 셸은 zsh다. Linux에는 zsh가 기본 설치되지
  // 않을 수 있으므로 macOS에서만 시도하고, 공통 fallback은 bash로 둔다.
  if (process.platform === 'darwin') {
    const fromZsh = resolveClaudeThroughLoginShell('zsh');
    if (fromZsh) return fromZsh;
  }
  const fromBash = resolveClaudeThroughLoginShell('bash');
  if (fromBash) return fromBash;
  // 알려진 고정 경로 탐색 (cmux 번들 포함)
  const home = process.env.HOME ?? '';
  for (const p of [
    '/Applications/cmux.app/Contents/Resources/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${home}/.npm-global/bin/claude`,
    `${home}/.npm/bin/claude`,
    `${home}/.local/bin/claude`,
    `${home}/.claude/local/bin/claude`,
  ]) {
    if (p && existsSync(p)) return p;
  }
  return null;
}
const CLAUDE_PATH = resolveClaudePath();

/**
 * One-shot Claude call for short generated text (commit titles, project aliases).
 *
 * Three things here are load-bearing:
 *  1. `--tools ''` disables the agent loop. Without it `claude -p` treats the prompt
 *     as a task, goes off reading the repo, and answers with narration like
 *     "변경 내용을 확인하겠습니다" instead of the one line we asked for — measured
 *     against a real 16KB diff. Tool loops are also what makes these calls slow
 *     enough to hit the timeout.
 *  2. The prompt goes over stdin on every platform, not as an argv entry. `--tools`
 *     is variadic, so a trailing positional prompt gets swallowed by it ("Input must
 *     be provided either through stdin or as a prompt argument"), and argv also has
 *     length limits on Windows.
 *  3. Timeout is tracked with an explicit flag. Bun reports our own `proc.kill()` as
 *     `exitCode === null` + `signalCode === 'SIGTERM'`, but a process terminated by
 *     someone else (an app restart, the OS) surfaces as plain `exit 143`, which the
 *     old inference read as an ordinary failure and reported as a confusing
 *     "AI 메시지 생성 실패 (exit 143)".
 */
async function runClaudePrompt(
  prompt: string,
  opts: { timeoutMs: number; cwd?: string; label: string },
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!CLAUDE_PATH) {
    return { ok: false, error: 'claude CLI를 찾을 수 없습니다. Claude Code를 설치했는지 확인해주세요.' };
  }
  const proc = Bun.spawn(
    [CLAUDE_PATH, '--safe-mode', '-p', '--model', 'haiku', '--tools', ''],
    {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: { ...process.env, ...(IS_WIN ? {} : { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }) },
      stdin: Buffer.from(prompt),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs);
  await proc.exited;
  clearTimeout(timeoutId);
  const text = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();
  if (proc.exitCode === 0) return { ok: true, text };

  const detail = stderr || text || `(exitCode=${proc.exitCode}, signal=${proc.signalCode ?? 'none'})`;
  // 143 = 128+SIGTERM, 137 = 128+SIGKILL — the process was terminated from outside.
  const killedExternally = !timedOut && (proc.exitCode === 143 || proc.exitCode === 137 || proc.signalCode != null);
  const error = timedOut
    ? `AI 응답 시간 초과 (${Math.round(opts.timeoutMs / 1000)}초): ${detail}`
    : killedExternally
      ? `AI 프로세스가 외부에서 종료되었습니다 (exit ${proc.exitCode}). 앱이나 API 서버가 재시작되지 않았는지 확인 후 다시 시도해주세요: ${detail}`
      : `AI 메시지 생성 실패 (exit ${proc.exitCode}): ${detail}`;
  console.error(`[${opts.label}]`, error);
  return { ok: false, error };
}

// ──────────────── 에이전트 CLI 바이너리 해석 (claude / codex / agy) ────────────────
// agy는 ~/.local/bin/agy 에 설치되는데, 이 경로는
//  - osascript로 넘기는 clean env PATH(/opt/homebrew/bin:/usr/local/bin:/usr/bin:...)
//  - Orca/cmux가 띄우는 셸의 PATH
// 어디에도 없다 → bare `agy`로 실행하면 "command not found"로 조용히 실패한다.
// 그래서 실행 명령 문자열에 바이너리를 박아 넣을 때는 항상 절대경로로 해석해서 넣는다.
const AGENT_BIN_CACHE = new Map<string, string>();

type AgentName = 'claude' | 'codex' | 'agy' | 'hermes';

/** bypass 플래그 — 각 CLI에서 실제 유효한 값 (변경 금지) */
const AGENT_BYPASS_FLAG: Record<AgentName, string> = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  agy: '--dangerously-skip-permissions',
  hermes: '',
};

function runningHermesDesktop(): { pid: number; executable: string } | null {
  if (process.platform !== 'darwin') return null;
  const listing = Bun.spawnSync(['ps', 'ax', '-o', 'pid=,command='], {
    stdout: 'pipe', stderr: 'ignore',
  }).stdout.toString();
  const marker = '/Contents/MacOS/Hermes';
  for (const line of listing.split(/\r?\n/)) {
    const markerAt = line.indexOf(marker);
    if (markerAt < 0) continue;
    const prefix = line.slice(0, markerAt + marker.length).trim();
    const match = prefix.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const executable = match[2]!;
    if (Number.isInteger(pid) && existsSync(executable)) return { pid, executable };
  }
  return null;
}

async function verifyHermesDesktopRunning(
  readyFile: string,
  expectedCwd: string,
  childPid: number,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(childPid, 0);
    } catch {
      return false;
    }
    try {
      const receipt = JSON.parse(readFileSync(readyFile, 'utf8')) as {
        schemaVersion?: unknown;
        ready?: unknown;
        pid?: unknown;
        cwd?: unknown;
      };
      if (
        receipt.schemaVersion === 1
        && receipt.ready === true
        && Number.isInteger(receipt.pid)
        && Number(receipt.pid) > 0
        && typeof receipt.cwd === 'string'
        && realpathSync(receipt.cwd) === realpathSync(expectedCwd)
      ) {
        process.kill(Number(receipt.pid), 0);
        return true;
      }
    } catch { /* wait for an atomic readiness receipt */ }
    await Bun.sleep(250);
  }
  return false;
}

function unwrapWindowsAgentShim(shimPath: string, name: AgentName): string | null {
  if (shimPath.toLowerCase().endsWith('.exe') && existsSync(shimPath)) return shimPath;
  const shimDir = dirname(shimPath);
  try {
    const cmdPath = shimPath.toLowerCase().endsWith('.cmd') ? shimPath : `${shimPath}.cmd`;
    if (existsSync(cmdPath)) {
      const content = readFileSync(cmdPath, 'utf8');
      const directExe = content.match(/"([^"]+\.exe)"\s+%\*/i)?.[1];
      if (directExe) {
        const expanded = directExe.replace(/%dp0%/gi, shimDir).replace(/%~dp0/gi, shimDir);
        const resolved = isAbsolute(expanded) ? expanded : resolve(shimDir, expanded);
        if (existsSync(resolved)) return resolved;
      }
    }
  } catch { /* try package-layout candidates below */ }

  if (name === 'codex') {
    const nodeModules = basename(shimDir).toLowerCase() === '.bin' ? dirname(shimDir) : shimDir;
    const arch = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const pkg = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
    const candidate = join(nodeModules, '@openai', pkg, 'vendor', arch, 'bin', 'codex.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const ORCA_AGENT_START_ERROR_RE = /command not found|no such file or directory|cannot execute|permission denied|the system cannot find the path specified|is not recognized as an internal or external command/i;

/** A fresh terminal must not be reported as launched when its shell immediately rejected the command. */
async function verifyOrcaAgentStarted(cli: string, handle: string): Promise<{ ok: boolean; error: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((done) => setTimeout(done, 350));
    const read = await nodeOrcaRunJson(cli, ['terminal', 'read', '--terminal', handle], 3000);
    if (!read.ok) continue;
    const terminal = read.result?.terminal ?? read.result;
    const raw = terminal?.tail ?? terminal?.output ?? '';
    const text = Array.isArray(raw) ? raw.join('\n') : String(raw ?? '');
    const match = text.match(ORCA_AGENT_START_ERROR_RE);
    if (match) {
      const tail = text.split(/\r?\n/).slice(-8).join('\n').slice(-1200);
      return { ok: false, error: `${match[0]}\n${tail}` };
    }
    if (text.trim()) return { ok: true, error: '' };
  }
  // Orca accepted the bytes but some full-screen TUIs do not expose readable tail output.
  return { ok: true, error: '' };
}

/** 에이전트 실행 파일 절대경로 해석 (name별 1회만 계산 후 캐시).
 *  Windows Orca는 WSL 셸을 사용하지만 Windows .exe interop은 지원한다. 따라서
 *  PATH에 우연히 들어온 npm shim을 믿지 않고 실제 실행 파일을 찾아 반환한다. */
function resolveAgentBin(name: AgentName): string {
  const cached = AGENT_BIN_CACHE.get(name);
  if (cached) return cached;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? '';
    const localAppData = process.env.LOCALAPPDATA ?? '';
    const userProfile = process.env.USERPROFILE ?? '';
    const knownCandidates: Record<AgentName, string[]> = {
      claude: [
        join(userProfile, '.local', 'bin', 'claude.exe'),
        join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
        join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'node_modules', '@anthropic-ai', 'claude-code-win32-x64', 'claude.exe'),
      ],
      codex: [],
      agy: [join(localAppData, 'agy', 'bin', 'agy.exe')],
      hermes: windowsHermesExecutableCandidates({
        localAppData,
        hermesHome: process.env.HERMES_HOME,
      }),
    };
    for (const candidate of knownCandidates[name]) {
      if (candidate && existsSync(candidate)) {
        AGENT_BIN_CACHE.set(name, candidate);
        return candidate;
      }
    }

    // where.exe 결과가 .cmd/extensionless shim이면 패키지 내부 실제 .exe로 해석한다.
    const r = Bun.spawnSync(['where', name], { stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode === 0) {
      for (const found of r.stdout.toString().trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
        const executable = unwrapWindowsAgentShim(found, name);
        if (executable) {
          AGENT_BIN_CACHE.set(name, executable);
          return executable;
        }
      }
    }
    AGENT_BIN_CACHE.set(name, name);
    return name;
  }
  const home = homedir();
  const candidates = [
    ...(name === 'codex' ? [
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
    ] : []),
    `${home}/.local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `${home}/.bun/bin/${name}`,
    `${home}/.npm-global/bin/${name}`,
    `${home}/.volta/bin/${name}`,
  ];
  let found = candidates.find((p) => existsSync(p)) ?? null;
  if (!found) {
    // login shell 폴백 — 사용자 프로파일(PATH 확장)을 로드한 뒤 탐색
    try {
      const r = nodeSpawnSync('zsh', ['-lc', `command -v ${name}`], { encoding: 'utf-8', timeout: 5000 });
      const p = ((r.stdout ?? '').toString().trim().split('\n')[0] ?? '').trim();
      if (p && existsSync(p)) found = p;
    } catch { /* ignore — bare 이름으로 폴백 */ }
  }
  const resolved = found ?? name;
  AGENT_BIN_CACHE.set(name, resolved);
  return resolved;
}

/**
 * Hermes 실행 파일의 절대경로. 없으면 null.
 *
 * `resolveAgentBin`은 못 찾으면 이름 그대로를 돌려주는데, 그 값을 spawn하면 사용자에게
 * `Executable not found in $PATH`라는 원시 오류가 그대로 노출된다. 실행 전에 이 함수로
 * 미설치를 먼저 판정하고, 어댑터 상태도 같은 값을 보게 해서 "설정 폴더는 있는데 CLI는
 * 없는" 기기에서 실행 버튼이 뜨는 일을 막는다.
 */
function hermesCliPath(): string | null {
  return hermesCliPathFromResolved(resolveAgentBin('hermes'));
}

/** 셸 문자열에 박아 넣을 때만 따옴표 — 공백 없는 절대경로는 그대로 둔다.
 *  (tmux 명령은 `'zsh -l -c "<cmd>"'` 처럼 중첩 인용이라 불필요한 따옴표가 오히려 깨진다) */
function shQuoteIfNeeded(p: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}

/** Orca의 Windows 터미널은 WSL bash다. 실제 Windows .exe를 /mnt/<drive>/...로
 *  변환하면 npm shim/PATH 차이 없이 WSL interop으로 세 CLI를 동일하게 실행할 수 있다. */
function agentCliForWsl(name: AgentName, bypass: boolean): string | null {
  const resolved = resolveAgentBin(name);
  if (resolved === name || !/^[A-Za-z]:[\\/]/.test(resolved)) return null;
  return buildWindowsOrcaAgentCommand(name, resolved, bypass);
}

function agentCliForWindowsCmd(name: AgentName, bypass: boolean): string | null {
  const resolved = resolveAgentBin(name);
  if (resolved === name || !/^[A-Za-z]:[\\/]/.test(resolved)) return null;
  return buildWindowsCmdAgentCommand(name, resolved, bypass);
}

/** 에이전트 실행 명령 문자열 (절대경로 + bypass 플래그) */
function agentCli(name: AgentName, bypass: boolean): string {
  const bin = shQuoteIfNeeded(resolveAgentBin(name));
  return bypass ? `${bin} ${AGENT_BYPASS_FLAG[name]}` : bin;
}

/** Commands handed to native cmd.exe must use Windows quoting, never the
 * POSIX single quotes used by zsh/tmux. Fail before opening a terminal when
 * discovery did not prove an executable path, rather than reporting a fake
 * successful launch for a bare command that cmd.exe cannot resolve. */
function terminalAgentCli(name: AgentName, bypass: boolean): string {
  if (!IS_WIN) return agentCli(name, bypass);
  const command = agentCliForWindowsCmd(name, bypass);
  if (command) return command;
  if (name === 'hermes') throw new Error(HERMES_CLI_NOT_FOUND_MESSAGE);
  throw new Error(`${name} CLI 실행 파일을 찾을 수 없습니다. 설치 후 AgentsToZ를 다시 시작해주세요.`);
}

type CodexUsagePayload = {
  rateLimits: ReturnType<typeof normalizeCodexRateLimits>;
  checkedAt: string;
  source: 'live-app-server';
  cached?: boolean;
};

const CODEX_LIVE_RATE_LIMIT_CACHE_MS = 30_000;
let codexLiveRateLimitCache: { expiresAt: number; payload: CodexUsagePayload } | null = null;
let codexLiveRateLimitInFlight: Promise<CodexUsagePayload> | null = null;

/** Query the authenticated Codex app-server, never `codex exec`: the latter
 * starts an agent turn while this JSON-RPC method only reads account limits. */
async function getLiveCodexRateLimits(force = false): Promise<CodexUsagePayload> {
  const now = Date.now();
  if (!force && codexLiveRateLimitCache && codexLiveRateLimitCache.expiresAt > now) {
    return { ...codexLiveRateLimitCache.payload, cached: true };
  }
  if (codexLiveRateLimitInFlight) return codexLiveRateLimitInFlight;

  const task = readCodexLiveRateLimits(resolveAgentBin('codex')).then(result => {
    const payload: CodexUsagePayload = {
      rateLimits: result.rateLimits,
      checkedAt: result.checkedAt,
      source: 'live-app-server',
    };
    codexLiveRateLimitCache = { expiresAt: Date.now() + CODEX_LIVE_RATE_LIMIT_CACHE_MS, payload };
    return payload;
  });
  codexLiveRateLimitInFlight = task;
  try {
    return await task;
  } finally {
    if (codexLiveRateLimitInFlight === task) codexLiveRateLimitInFlight = null;
  }
}

const executableProcesses = new Map<string, any>();
const portLaunchOwnership = new PortLaunchOwnership();
let buildProcess: any = null;
let buildStatus = { isBuilding: false, type: '', output: [] as string[], exitCode: null as number | null };

// 빌드/배포 로그 버퍼 상한 — 장시간 빌드(최대 60분 Windows 빌드 등)에서 output 배열이
// 무한히 커지는 것을 방지. 최근 N개 항목만 유지 (UI는 어차피 최근 로그만 표시).
const MAX_LOG_BUFFER_ENTRIES = 2000;
function pushLogBounded(arr: string[], text: string): void {
  arr.push(text);
  if (arr.length > MAX_LOG_BUFFER_ENTRIES) {
    arr.splice(0, arr.length - MAX_LOG_BUFFER_ENTRIES);
  }
}

let deployProcess: any = null;
let deployStatus = {
  isDeploying: false,
  output: [] as string[],
  exitCode: null as number | null,
  url: null as string | null,
};

// GitHub Actions 설정 — 포크한 저장소 정보는 환경변수로 override 가능
const GITHUB_OWNER = process.env.PORTMGR_GITHUB_OWNER || 'intenet1001-commits';
const GITHUB_REPO = process.env.PORTMGR_GITHUB_REPO || 'portmanagement';
const GITHUB_WORKFLOW = process.env.PORTMGR_GITHUB_WORKFLOW || 'build-windows.yml';

// 포트 데이터 파일 - Tauri와 동일한 위치 사용 (플랫폼별)
// macOS: ~/Library/Application Support/com.portmanager.portmanager
// Windows: %APPDATA%\com.portmanager.portmanager
// Linux/AWS Ubuntu: ${XDG_CONFIG_HOME:-~/.config}/com.portmanager.portmanager
const APP_DATA_DIR = resolveAppDataDir();
const PORTS_DATA_FILE = join(APP_DATA_DIR, "ports.json");
const PORTS_BACKUP_FILE = join(APP_DATA_DIR, "ports.json.bak");
const PORTS_LOCK_FILE = join(APP_DATA_DIR, "ports.json.lock");
const PORTS_AUDIT_FILE = join(APP_DATA_DIR, "ports-save-audit.jsonl");
const WORKSPACE_ROOTS_FILE = join(APP_DATA_DIR, "workspace-roots.json");
const LAST_VISITS_FILE = join(APP_DATA_DIR, "last-visits.json");
const PORTAL_DATA_FILE = join(APP_DATA_DIR, "portal.json");
const PROJECT_MEMORY_THREAD_BINDINGS_FILE = join(APP_DATA_DIR, "project-memory-thread-bindings.json");
const STANDALONE_PROJECT_MEMORIES_DIR = join(APP_DATA_DIR, "project-memories");
const ORCA_FLOATING_TERMINALS_FILE = join(APP_DATA_DIR, "orca-floating-terminals.json");
const ORCA_FLOATING_TERMINALS_LOCK_FILE = join(APP_DATA_DIR, "orca-floating-terminals.json.lock");
const ORCA_LOCAL_SESSION_FILE = join(
  homedir(),
  'Library/Application Support/orca/profiles/local-default/orca-data.json',
);

const CONTEXT_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ContextSessionFocusOutcome = {
  success: boolean;
  code?: string;
  error?: string;
  message?: string;
  exact?: boolean;
};

/** Only UUID session identifiers ever become a local file name or a custom URL.
 * The browser sends no cwd, terminal handle, URL, or surface identifiers. */
function isSafeContextSessionId(value: unknown): value is string {
  return typeof value === 'string' && CONTEXT_SESSION_ID_RE.test(value);
}

type ContextMetadataFileStamp = { mtimeMs: number; size: number } | null;

const contextMetadataFileStamp = (filePath: string): ContextMetadataFileStamp => {
  try {
    const stat = statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
};

const sameContextMetadataFileStamp = (
  left: ContextMetadataFileStamp,
  right: ContextMetadataFileStamp,
): boolean => (
  left?.mtimeMs === right?.mtimeMs && left?.size === right?.size
);

const CHATGPT_CODEX_STATE_FILE = join(homedir(), '.codex', '.codex-global-state.json');
const CHATGPT_CODEX_SESSION_INDEX_FILE = join(homedir(), '.codex', 'session_index.jsonl');

const normalizedChatGptWorkspacePath = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
};

const isSameChatGptWorkspacePath = (left: string | null | undefined, right: string): boolean => (
  normalizedChatGptWorkspacePath(left) === normalizedChatGptWorkspacePath(right)
);

/** Parsed head/tail of one Codex rollout, keyed by path and invalidated by the
 * file's own stamp. The context panel polls every 5s and the scan reads a 64KB
 * head plus a 512KB tail from up to 96 rollouts, then JSON.parses every line —
 * tens of megabytes re-read and re-parsed per poll, almost all of it from files
 * that had not changed since the previous one. A rollout only ever grows by
 * appending, so an unchanged (mtimeMs, size) means the parse is still valid. */
type CodexRolloutSummary = { meta: any; turn: any; tokenEvent: any };
const codexRolloutSummaryCache = new Map<string, {
  stamp: ContextMetadataFileStamp;
  summary: CodexRolloutSummary | null;
}>();

function readCodexRolloutSummary(
  filePath: string,
  stamp: ContextMetadataFileStamp,
  parse: () => CodexRolloutSummary | null,
): CodexRolloutSummary | null {
  const cached = codexRolloutSummaryCache.get(filePath);
  if (cached && sameContextMetadataFileStamp(cached.stamp, stamp)) return cached.summary;
  const summary = parse();
  codexRolloutSummaryCache.set(filePath, { stamp, summary });
  // The directory listing is already capped at 96 entries per poll, but rollouts
  // accumulate across days; bound the map so a long-lived server cannot grow it
  // without limit.
  if (codexRolloutSummaryCache.size > 512) {
    for (const key of [...codexRolloutSummaryCache.keys()].slice(0, 256)) {
      codexRolloutSummaryCache.delete(key);
    }
  }
  return summary;
}
let chatGptThreadMetadataCache: {
  stateStamp: ContextMetadataFileStamp;
  indexStamp: ContextMetadataFileStamp;
  metadata: Map<string, ContextSessionMetadata>;
} | null = null;

type ChatGptThreadMetadataAvailability = 'fresh' | 'cached' | 'unavailable';

function readChatGptThreadMetadataSnapshot(): {
  metadata: Map<string, ContextSessionMetadata>;
  availability: ChatGptThreadMetadataAvailability;
} {
  const stateStamp = contextMetadataFileStamp(CHATGPT_CODEX_STATE_FILE);
  const indexStamp = contextMetadataFileStamp(CHATGPT_CODEX_SESSION_INDEX_FILE);
  if (!stateStamp) {
    return chatGptThreadMetadataCache
      ? { metadata: chatGptThreadMetadataCache.metadata, availability: 'cached' }
      : { metadata: new Map<string, ContextSessionMetadata>(), availability: 'unavailable' };
  }
  if (chatGptThreadMetadataCache
    && sameContextMetadataFileStamp(chatGptThreadMetadataCache.stateStamp, stateStamp)
    && sameContextMetadataFileStamp(chatGptThreadMetadataCache.indexStamp, indexStamp)) {
    return { metadata: chatGptThreadMetadataCache.metadata, availability: 'fresh' };
  }

  try {
    const globalState = JSON.parse(readFileSync(CHATGPT_CODEX_STATE_FILE, 'utf-8'));
    const titles = indexStamp
      ? parseChatGptThreadTitles(readFileSync(CHATGPT_CODEX_SESSION_INDEX_FILE, 'utf-8'))
      : new Map<string, string>();
    const metadata = parseChatGptThreadMetadata(globalState, titles);
    chatGptThreadMetadataCache = { stateStamp, indexStamp, metadata };
    return { metadata, availability: 'fresh' };
  } catch {
    return chatGptThreadMetadataCache
      ? { metadata: chatGptThreadMetadataCache.metadata, availability: 'cached' }
      : { metadata: new Map<string, ContextSessionMetadata>(), availability: 'unavailable' };
  }
}

/**
 * ChatGPT Desktop keeps a compact title/project assignment index separately
 * from rollout JSONL. It is an optional local read only; a partial Electron
 * write keeps the last valid cache rather than making context rows disappear.
 */
function readChatGptThreadMetadata(): Map<string, ContextSessionMetadata> {
  return readChatGptThreadMetadataSnapshot().metadata;
}

/**
 * A blank local task is not always persisted in thread-project-assignments
 * until the first Voice/text turn. ChatGPT does persist the chosen local
 * project immediately, so it is a safe secondary readiness signal after the
 * explicit `?path=` deep link has had time to activate.
 */
function isChatGptSelectedProject(folderPath: string): boolean {
  try {
    const state = JSON.parse(readFileSync(CHATGPT_CODEX_STATE_FILE, 'utf-8')) as Record<string, unknown>;
    const selected = state['selected-project'];
    const localProjects = state['local-projects'];
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)) return false;
    if (!localProjects || typeof localProjects !== 'object' || Array.isArray(localProjects)) return false;
    const selectedRecord = selected as Record<string, unknown>;
    if (selectedRecord.type !== 'local' || typeof selectedRecord.projectId !== 'string') return false;
    const project = (localProjects as Record<string, unknown>)[selectedRecord.projectId];
    if (!project || typeof project !== 'object' || Array.isArray(project)) return false;
    const rootPaths = (project as Record<string, unknown>).rootPaths;
    return Array.isArray(rootPaths)
      && rootPaths.some((path) => typeof path === 'string' && isSameChatGptWorkspacePath(path, folderPath));
  } catch {
    return false;
  }
}

/**
 * A path deep link is asynchronous. Before sending ChatGPT's Voice command,
 * wait for its local project-assignment index to record a *new* empty task for
 * this folder. Empty tasks can defer that record until their first turn, so a
 * settled selected-project state is a constrained fallback. Without either
 * proof the command could run in whichever task was previously frontmost.
 */
async function waitForChatGptProjectReady(
  folderPath: string,
  existingThreadIds: ReadonlySet<string>,
  timeoutMs = 6_000,
): Promise<{ projectTaskId: string | null; readiness: 'new-task' | 'selected-project' } | null> {
  const selectedProjectEarliestAt = Date.now() + 900;
  const deadline = Date.now() + timeoutMs;
  do {
    const metadata = readChatGptThreadMetadata();
    for (const [sessionId, entry] of metadata) {
      if (existingThreadIds.has(sessionId)) continue;
      if (entry.projectHint?.moveState !== 'applied') continue;
      if (isSameChatGptWorkspacePath(entry.projectHint.path, folderPath)) {
        return { projectTaskId: sessionId, readiness: 'new-task' };
      }
    }
    if (Date.now() >= selectedProjectEarliestAt && isChatGptSelectedProject(folderPath)) {
      return { projectTaskId: null, readiness: 'selected-project' };
    }
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  return null;
}

/** A bounded, metadata-only cache for ChatGPT Desktop rollout headers. The
 * context panel polls every five seconds, so re-reading every historical JSONL
 * header would make a manually moved Voice chat expensive to discover. */
const chatGptVoiceCandidateHeaderCache = new Map<string, {
  stamp: ContextMetadataFileStamp;
  candidate: ProjectCodexVoiceCandidate | null;
}>();

function parseChatGptVoiceCandidateHeader(
  filePath: string,
  size: number,
  modifiedAtMs: number,
): ProjectCodexVoiceCandidate | null {
  const headSize = Math.min(size, 64 * 1024);
  if (!headSize) return null;
  const fd = openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(headSize);
    readSync(fd, head, 0, headSize, 0);
    let meta: Record<string, unknown> | null = null;
    for (const line of head.toString('utf8').split('\n')) {
      try {
        const row = JSON.parse(line);
        if (row.type === 'session_meta' && row.payload && typeof row.payload === 'object') {
          meta = row.payload as Record<string, unknown>;
          break;
        }
      } catch {
        // A concurrent append can leave the last bounded row incomplete.
      }
    }
    if (!meta) return null;
    const sessionId = typeof meta.id === 'string'
      ? meta.id
      : typeof meta.session_id === 'string' ? meta.session_id : null;
    if (!sessionId) return null;

    let latestTurnCwd: string | null = null;
    // A Voice's actual workspace is useful only for a Voice rollout. Read a
    // small tail and only decode `turn_context.cwd`; never inspect messages or
    // audio-derived content.
    if (meta.originator === 'Codex Desktop' && meta.thread_source === 'realtime_voice') {
      const tailSize = Math.min(size, 128 * 1024);
      const tail = Buffer.alloc(tailSize);
      readSync(fd, tail, 0, tailSize, Math.max(0, size - tailSize));
      for (const line of tail.toString('utf8').split('\n')) {
        try {
          const row = JSON.parse(line);
          if (row.type !== 'turn_context' || !row.payload || typeof row.payload !== 'object') continue;
          const cwd = (row.payload as Record<string, unknown>).cwd;
          if (typeof cwd === 'string' && cwd) latestTurnCwd = cwd;
        } catch {
          // The tail can start midway through one JSONL record.
        }
      }
    }

    return {
      sessionId,
      originator: typeof meta.originator === 'string' ? meta.originator : null,
      threadSource: typeof meta.thread_source === 'string' ? meta.thread_source : null,
      modifiedAtMs,
      latestTurnCwd,
    };
  } finally {
    closeSync(fd);
  }
}

/** Read only rollout headers plus a Voice turn's current working folder. This
 * is deliberately content-free and returns availability separately from an
 * empty result so the UI never turns an unreadable local cache into “no Voice
 * session”. */
function readChatGptVoiceCandidateSnapshot(
  minModifiedAtMs = Number.NEGATIVE_INFINITY,
): { candidates: ProjectCodexVoiceCandidate[]; available: boolean } {
  const sessionsDir = join(homedir(), '.codex', 'sessions');
  if (!existsSync(sessionsDir)) return { candidates: [], available: true };

  const candidates: ProjectCodexVoiceCandidate[] = [];
  const seenPaths = new Set<string>();
  try {
    for (const relative of readdirSync(sessionsDir, { recursive: true }) as string[]) {
      if (!relative.endsWith('.jsonl')) continue;
      const filePath = join(sessionsDir, relative);
      seenPaths.add(filePath);
      let stat: ReturnType<typeof statSync>;
      try { stat = statSync(filePath); } catch { continue; }
      const stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
      let cached = chatGptVoiceCandidateHeaderCache.get(filePath);
      // The launch confirmation loop only cares about new/changed rollouts.
      // Leave untouched historical headers for the later context-panel scan.
      if (!cached && stat.mtimeMs < minModifiedAtMs) continue;
      if (!cached || !sameContextMetadataFileStamp(cached.stamp, stamp)) {
        let candidate: ProjectCodexVoiceCandidate | null = null;
        try {
          candidate = parseChatGptVoiceCandidateHeader(filePath, stat.size, stat.mtimeMs);
        } catch {
          // Keep a missing/partially written header retryable: the next file
          // stamp change reparses it instead of treating it as a valid non-Voice.
        }
        cached = { stamp, candidate };
        chatGptVoiceCandidateHeaderCache.set(filePath, cached);
      }
      if (cached.candidate && cached.candidate.modifiedAtMs >= minModifiedAtMs) {
        candidates.push(cached.candidate);
      }
    }
    for (const filePath of chatGptVoiceCandidateHeaderCache.keys()) {
      if (!seenPaths.has(filePath)) chatGptVoiceCandidateHeaderCache.delete(filePath);
    }
    return { candidates, available: true };
  } catch {
    return { candidates: [], available: false };
  }
}

function readChatGptVoiceCandidates(minModifiedAtMs = Number.NEGATIVE_INFINITY): ProjectCodexVoiceCandidate[] {
  return readChatGptVoiceCandidateSnapshot(minModifiedAtMs).candidates;
}

/**
 * The desktop Voice command can create a fresh rollout or resume the most
 * recent Voice conversation. Both are observable without reading chat text:
 * a fresh session gets a new id, while a resumed one updates its rollout file.
 */
async function waitForChatGptVoiceLaunch(
  existingStamps: ReadonlyMap<string, number>,
  startedAtMs: number,
  timeoutMs = 12_000,
): Promise<{ kind: 'created' | 'resumed'; voice: ProjectCodexVoiceCandidate } | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const candidates = readChatGptVoiceCandidates(startedAtMs - 5_000)
      .filter((entry) => (
        entry.originator === 'Codex Desktop'
        && entry.threadSource === 'realtime_voice'
        && entry.modifiedAtMs >= startedAtMs - 5_000
      ))
      .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);

    const created = candidates.find((entry) => !existingStamps.has(entry.sessionId));
    if (created) return { kind: 'created', voice: created };

    const resumed = candidates.find((entry) => {
      const previousStamp = existingStamps.get(entry.sessionId);
      return previousStamp !== undefined && entry.modifiedAtMs > previousStamp;
    });
    if (resumed) return { kind: 'resumed', voice: resumed };

    await Bun.sleep(350);
  } while (Date.now() < deadline);
  return null;
}

/** ChatGPT can write the rollout before its local project-assignment index.
 * Give that small metadata write a chance to settle before classifying a fresh
 * Voice as unbound, while still failing closed if it never arrives. */
async function waitForFreshChatGptVoiceProjectState(
  folderPath: string,
  voice: ProjectCodexVoiceCandidate,
  timeoutMs = 2_000,
): Promise<{
  projectBound: boolean;
  pending: { sessionId: string; appliedPath: string | null } | null;
}> {
  const deadline = Date.now() + timeoutMs;
  do {
    const metadata = readChatGptThreadMetadata();
    const projectBound = selectProjectCodexVoiceThread(folderPath, [voice], metadata) === voice.sessionId;
    const pending = selectPendingProjectCodexVoiceThread(folderPath, [voice], metadata);
    if (projectBound || pending) return { projectBound, pending };
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  return { projectBound: false, pending: null };
}

function openChatGptDeepLink(deepLink: string): void {
  const command = IS_WIN
    ? ['rundll32.exe', 'url.dll,FileProtocolHandler', deepLink]
    : process.platform === 'darwin'
      ? ['open', deepLink]
      : ['xdg-open', deepLink];
  const openResult = Bun.spawnSync(command, { stdout: 'ignore', stderr: 'pipe', timeout: 5_000 });
  if (!openResult.success) {
    const detail = openResult.stderr?.toString().trim();
    throw new Error(detail || 'ChatGPT 앱 URL 핸들러를 실행하지 못했습니다.');
  }
}

async function runVoiceAutomation(
  command: string[],
  timeoutMs: number,
): Promise<{ success: boolean; output: string; detail: string }> {
  const proc = Bun.spawn({ cmd: command, stdout: 'pipe', stderr: 'pipe' });
  // Begin draining both streams immediately: an accessibility error can be
  // verbose enough to fill a pipe while the process is still running.
  const outputPromise = new Response(proc.stdout).text().catch(() => '');
  const detailPromise = new Response(proc.stderr).text().catch(() => '');
  const exitCode = await Promise.race([
    proc.exited,
    Bun.sleep(timeoutMs).then(() => null),
  ]);
  if (exitCode === null) {
    try { proc.kill(9); } catch {}
    await proc.exited.catch(() => null);
  }
  const [output, detail] = await Promise.all([outputPromise, detailPromise]);
  return {
    success: exitCode === 0,
    output: output.trim(),
    detail: detail.trim(),
  };
}

async function startChatGptVoice(
  labels: readonly string[],
  options: { surface?: ChatGptVoiceStartSurface; attempts?: number } = {},
): Promise<{ ok: true; method: ChatGptVoiceAutomationMethod } | { ok: false; code: string; error: string }> {
  if (process.platform === 'darwin') {
    const surface = options.surface ?? 'project-composer';
    const expectedOutput = surface === 'global'
      ? 'accessibility-global-button'
      : 'accessibility-button';
    const script = buildChatGptVoiceStartAppleScript({
      labels,
      surface,
      attempts: options.attempts,
    });
    const result = await runVoiceAutomation(['osascript', '-e', script], 15_000);
    if (result.success && result.output === expectedOutput) {
      return {
        ok: true,
        method: surface === 'global' ? 'accessibility-global-button' : 'accessibility-button',
      };
    }
    const detail = result.detail || result.output;
    const code = classifyChatGptVoiceAutomationError(detail);
    const candidateDiagnostic = extractChatGptVoiceCandidateDiagnostic(detail);
    // Keep AX candidates out of the HTTP error/UI. This compact record is
    // intentionally machine-readable so a renamed or hidden Voice control can
    // be diagnosed from the sidecar log without collecting conversation text.
    if (candidateDiagnostic) {
      console.warn('[ChatGPT Voice AX diagnostic]', JSON.stringify({
        code,
        candidates: candidateDiagnostic,
      }));
    }
    return {
      ok: false,
      code,
      error: describeChatGptVoiceAutomationFailure(code, detail),
    };
  }

  if (IS_WIN) {
    return {
      ok: false,
      code: 'VOICE_AUTOMATION_UNSUPPORTED_PLATFORM',
      error: 'Windows에서는 ChatGPT Voice 시작 버튼을 안정적으로 자동화할 수 없습니다. ChatGPT에서 Voice를 직접 시작해 주세요.',
    };
  }

  return {
    ok: false,
    code: 'VOICE_AUTOMATION_UNSUPPORTED_PLATFORM',
    error: '이 운영체제에서는 ChatGPT Voice 자동 시작을 지원하지 않습니다.',
  };
}

// ChatGPT permits one active Voice conversation. Keep the UI driver global to
// this sidecar so two cards or browser windows cannot launch overlapping Voice
// workflows and mistake each other's rollout for success.
let chatGptVoiceAutomationInFlight = false;

/** Read only the rollout header: project Voice routing never needs messages or
 * prompts. The scan runs on an explicit button click, not the polling path. */
function findProjectCodexVoiceThread(folderPath: string):
  { sessionId: string; movePending: boolean; appliedPath: string | null } | null {
  const candidates = readChatGptVoiceCandidates();
  if (candidates.length === 0) return null;

  const metadata = readChatGptThreadMetadata();
  const applied = selectProjectCodexVoiceThread(folderPath, candidates, metadata);
  if (applied) return { sessionId: applied, movePending: false, appliedPath: null };
  // Asking a voice chat to move into a project records the assignment but the
  // workspace transition can stay pending forever, still executing in the
  // scratch directory. That is not "no linked voice chat" — the user saw the
  // move happen — so report it as its own state.
  const pending = selectPendingProjectCodexVoiceThread(folderPath, candidates, metadata);
  if (pending) return { sessionId: pending.sessionId, movePending: true, appliedPath: pending.appliedPath };
  return null;
}

const CLAUDE_SESSION_METADATA_DIR = join(homedir(), '.claude', 'projects');
const CLAUDE_SESSION_METADATA_INDEX_TTL_MS = 30_000;
const CLAUDE_SESSION_METADATA_TAIL_BYTES = 512 * 1024;
let claudeSessionMetadataPathIndex: { checkedAt: number; paths: Map<string, string> } | null = null;
const claudeSessionMetadataCache = new Map<string, {
  filePath: string;
  stamp: ContextMetadataFileStamp;
  metadata: ContextSessionMetadata;
}>();

function refreshClaudeSessionMetadataPathIndex(force = false): Map<string, string> {
  const now = Date.now();
  if (!force && claudeSessionMetadataPathIndex
    && now - claudeSessionMetadataPathIndex.checkedAt < CLAUDE_SESSION_METADATA_INDEX_TTL_MS) {
    return claudeSessionMetadataPathIndex.paths;
  }

  const paths = new Map<string, { filePath: string; mtimeMs: number }>();
  try {
    for (const entry of readdirSync(CLAUDE_SESSION_METADATA_DIR, { recursive: true }) as string[]) {
      if (!entry.endsWith('.jsonl')) continue;
      const filePath = join(CLAUDE_SESSION_METADATA_DIR, entry);
      const sessionId = basename(filePath, '.jsonl');
      if (!isSafeContextSessionId(sessionId)) continue;
      const stamp = contextMetadataFileStamp(filePath);
      if (!stamp) continue;
      const previous = paths.get(sessionId);
      if (!previous || stamp.mtimeMs >= previous.mtimeMs) {
        paths.set(sessionId, { filePath, mtimeMs: stamp.mtimeMs });
      }
    }
  } catch {
    // Claude metadata is optional. Keep any last successful index on a
    // temporary filesystem/read race instead of suppressing current rows.
    return claudeSessionMetadataPathIndex?.paths ?? new Map<string, string>();
  }

  const indexed = new Map([...paths].map(([sessionId, value]) => [sessionId, value.filePath]));
  claudeSessionMetadataPathIndex = { checkedAt: now, paths: indexed };
  return indexed;
}

function readClaudeSessionMetadataTail(filePath: string, size: number): string {
  const readSize = Math.min(size, CLAUDE_SESSION_METADATA_TAIL_BYTES);
  const buffer = Buffer.alloc(readSize);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buffer, 0, readSize, Math.max(0, size - readSize));
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf-8');
}

function readClaudeSessionMetadata(sessionId: string): ContextSessionMetadata | null {
  let filePath = refreshClaudeSessionMetadataPathIndex().get(sessionId);
  if (!filePath) filePath = refreshClaudeSessionMetadataPathIndex(true).get(sessionId);
  if (!filePath) return null;

  const stamp = contextMetadataFileStamp(filePath);
  if (!stamp) return null;
  const cached = claudeSessionMetadataCache.get(sessionId);
  if (cached && cached.filePath === filePath && sameContextMetadataFileStamp(cached.stamp, stamp)) {
    return cached.metadata;
  }

  try {
    const parsed = parseClaudeSessionMetadata(readClaudeSessionMetadataTail(filePath, stamp.size));
    // A long live transcript can push a previously observed relocation event
    // out of the bounded tail. Keep the last known title/relocation for this
    // process until a newer metadata event replaces it.
    const metadata: ContextSessionMetadata = {
      threadTitle: parsed.threadTitle ?? cached?.metadata.threadTitle ?? null,
      projectHint: parsed.projectHint ?? cached?.metadata.projectHint ?? null,
    };
    claudeSessionMetadataCache.set(sessionId, { filePath, stamp, metadata });
    return metadata;
  } catch {
    return cached?.metadata ?? null;
  }
}

function isRuntimeUuid(value: unknown): value is string {
  return typeof value === 'string' && RUNTIME_UUID_RE.test(value);
}

function readClaudeContextSnapshot(sessionId: string): Record<string, any> | null {
  if (!isSafeContextSessionId(sessionId)) return null;
  const file = join(APP_DATA_DIR, 'context', `${sessionId}.json`);
  try {
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    return snapshot?.sessionId === sessionId ? snapshot : null;
  } catch {
    return null;
  }
}

type ClaudeContextSurfaceCandidate = {
  sessionId: string;
  launchContext: Record<string, any> | null | undefined;
};

type OrcaContextSurfaceInspection = {
  presence: Map<string, ContextSurfacePresence>;
  runtimeState: OrcaContextRuntimeState;
};

const ORCA_CONTEXT_TERMINAL_LIMIT = 1_000;

/** Passive runtime probe for the context list.  Unlike the navigation action,
 * this must never start, reveal, focus, create, or send anything to Orca. */
async function inspectOrcaContextSurfacePresence(
  targets: readonly ClaudeContextSurfaceCandidate[],
  options?: { probeRuntimeWhenEmpty?: boolean },
): Promise<OrcaContextSurfaceInspection> {
  if (!targets.length && !options?.probeRuntimeWhenEmpty) {
    return { presence: new Map(), runtimeState: 'unverified' };
  }
  const cli = resolveOrcaCli();
  if (!cli) {
    return {
      presence: inspectOrcaContextSessionPresence(targets, { kind: 'unverified' }),
      runtimeState: 'unverified',
    };
  }

  return withOrcaLock(async () => {
    const status = await nodeOrcaRunJson(cli, ['status'], 5_000);
    if (!status.ok) {
      return {
        presence: inspectOrcaContextSessionPresence(targets, { kind: 'unverified' }),
        runtimeState: 'unverified',
      };
    }
    const appRunning = status.result?.app?.running;
    const runtimeReachable = status.result?.runtime?.reachable;
    const graphState = status.result?.graph?.state;
    // A stopped app is conclusive: a historical local snapshot/registry record
    // cannot represent a currently open Orca surface. A running app with an
    // unavailable graph can be in startup/recovery, so keep that state
    // unverified rather than hiding a potentially open terminal.
    if (appRunning === false) {
      return {
        presence: inspectOrcaContextSessionPresence(targets, { kind: 'stopped' }),
        runtimeState: 'stopped',
      };
    }
    if (appRunning !== true || runtimeReachable !== true || graphState === 'not_running') {
      return {
        presence: inspectOrcaContextSessionPresence(targets, { kind: 'unverified' }),
        runtimeState: 'unverified',
      };
    }

    let sessionState: unknown;
    try {
      sessionState = JSON.parse(readFileSync(ORCA_LOCAL_SESSION_FILE, 'utf8'));
    } catch {
      return {
        presence: inspectOrcaContextSessionPresence(targets, { kind: 'unverified' }),
        runtimeState: 'unverified',
      };
    }
    const listed = await nodeOrcaRunJson(cli, ['terminal', 'list', '--limit', String(ORCA_CONTEXT_TERMINAL_LIMIT)], 8_000);
    if (!listed.ok) {
      return {
        presence: inspectOrcaContextSessionPresence(targets, { kind: 'unverified' }),
        runtimeState: 'unverified',
      };
    }
    return {
      presence: inspectOrcaContextSessionPresence(targets, {
        kind: 'running',
        sessionState,
        terminals: listed.result,
        terminalListMayBeTruncated: hasAtLeastOrcaTerminalCount(listed.result, ORCA_CONTEXT_TERMINAL_LIMIT),
      }),
      runtimeState: 'running',
    };
  });
}

type CmuxContextRuntimeProbe =
  | { kind: 'gone' }
  | { kind: 'unverified' }
  | { kind: 'tree'; tree: unknown; cli: string };

const CMUX_CONTEXT_PROBE_CACHE_MS = 3_000;
let cmuxContextProbeCache: { at: number; probe: CmuxContextRuntimeProbe } | null = null;
let cmuxContextProbeInFlight: Promise<CmuxContextRuntimeProbe> | null = null;

async function cmuxFailureProbe(error: string): Promise<CmuxContextRuntimeProbe> {
  if (isDefinitivelyClosedCmuxRuntimeError(error)) return { kind: 'gone' };
  // Socket-control policy can reject an otherwise running cmux. If the app
  // process itself is absent, however, that is still a conclusive closed state.
  return (await isCmuxAppProcessRunning()) === false ? { kind: 'gone' } : { kind: 'unverified' };
}

/** One passive cmux runtime observation, cached briefly and shared across
 * overlapping panel polls. It never opens cmux, focuses a workspace, or sends
 * terminal input. */
async function readCmuxContextRuntimeProbe(): Promise<CmuxContextRuntimeProbe> {
  const cached = cmuxContextProbeCache;
  if (cached && Date.now() - cached.at < CMUX_CONTEXT_PROBE_CACHE_MS) return cached.probe;
  if (cmuxContextProbeInFlight) return cmuxContextProbeInFlight;

  const request = (async (): Promise<CmuxContextRuntimeProbe> => {
    const cli = resolveCmuxCli();
    if (!cli) {
      if (!cmuxAppExists()) return { kind: 'gone' };
      return (await isCmuxAppProcessRunning()) === false ? { kind: 'gone' } : { kind: 'unverified' };
    }

    const ping = await nodeCmuxRunAsync(cli, ['ping'], 2_000);
    if (!ping.ok) return cmuxFailureProbe(ping.stderr || ping.stdout);

    const tree = await nodeCmuxRunAsync(cli, ['--json', '--id-format', 'uuids', 'tree', '--all'], 5_000);
    if (!tree.ok) return cmuxFailureProbe(tree.stderr || tree.stdout);
    const treeJson = parseCliJsonOutput(tree.stdout);
    return treeJson && isRecognizedCmuxTree(treeJson)
      ? { kind: 'tree', tree: treeJson, cli }
      : { kind: 'unverified' };
  })();
  cmuxContextProbeInFlight = request;
  try {
    const probe = await request;
    cmuxContextProbeCache = { at: Date.now(), probe };
    return probe;
  } finally {
    if (cmuxContextProbeInFlight === request) cmuxContextProbeInFlight = null;
  }
}

const CMUX_CONTEXT_CONFIRM_CACHE_MS = 3_000;
const cmuxContextConfirmCache = new Map<string, { at: number; presence: ContextSurfacePresence }>();
const cmuxContextConfirmInFlight = new Map<string, Promise<ContextSurfacePresence>>();

async function cmuxTargetFailurePresence(error: string): Promise<ContextSurfacePresence> {
  if (isDefinitivelyMissingCmuxTargetError(error)) return 'gone';
  const runtime = await cmuxFailureProbe(error);
  return runtime.kind === 'gone' ? 'gone' : 'unverified';
}

/** A tree only narrows candidates. `identify` asks the cmux daemon to resolve
 * the exact workspace/surface pair, avoiding a false live result when the
 * same UUID-looking value appears in unrelated pane metadata. */
async function confirmCmuxContextSurface(
  cli: string,
  workspaceId: string,
  surfaceId: string,
): Promise<ContextSurfacePresence> {
  const key = `${cli}\u0000${workspaceId}\u0000${surfaceId}`;
  const cached = cmuxContextConfirmCache.get(key);
  if (cached && Date.now() - cached.at < CMUX_CONTEXT_CONFIRM_CACHE_MS) return cached.presence;
  const pending = cmuxContextConfirmInFlight.get(key);
  if (pending) return pending;

  const request = (async (): Promise<ContextSurfacePresence> => {
    const identified = await nodeCmuxRunAsync(cli, [
      '--json', 'identify', '--workspace', workspaceId, '--surface', surfaceId, '--no-caller',
    ], 5_000);
    if (!identified.ok) return cmuxTargetFailurePresence(identified.stderr || identified.stdout);
    const body = parseCliJsonOutput(identified.stdout);
    if (!body) return 'unverified';
    if (body?.ok === false) {
      return cmuxTargetFailurePresence(body?.error?.message ?? 'cmux identify rejected the target');
    }
    return hasJsonValue(body, workspaceId) && hasJsonValue(body, surfaceId) ? 'live' : 'unverified';
  })();
  cmuxContextConfirmInFlight.set(key, request);
  try {
    const presence = await request;
    cmuxContextConfirmCache.set(key, { at: Date.now(), presence });
    return presence;
  } finally {
    if (cmuxContextConfirmInFlight.get(key) === request) cmuxContextConfirmInFlight.delete(key);
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Passive cmux probe. `tree --all` is one current daemon snapshot shared by
 * every row; it avoids N focus/identify calls during the five-second poll. */
async function inspectCmuxContextSurfacePresence(
  targets: readonly ClaudeContextSurfaceCandidate[],
): Promise<Map<string, ContextSurfacePresence>> {
  const result = new Map<string, ContextSurfacePresence>();
  if (!targets.length) return result;
  const probe = await readCmuxContextRuntimeProbe();
  if (probe.kind !== 'tree') {
    for (const target of targets) result.set(target.sessionId, probe.kind);
    return result;
  }
  const candidates: Array<{ target: ClaudeContextSurfaceCandidate; workspaceId: string; surfaceId: string }> = [];
  for (const target of targets) {
    const workspaceId = target.launchContext?.cmuxWorkspaceId;
    const surfaceId = target.launchContext?.cmuxSurfaceId;
    if (typeof workspaceId !== 'string' || typeof surfaceId !== 'string') {
      result.set(target.sessionId, 'unverified');
    } else {
      const treePresence = inspectCmuxSurfaceInWorkspace(probe.tree, workspaceId, surfaceId);
      if (treePresence === 'live') {
        candidates.push({ target, workspaceId, surfaceId });
      } else {
        result.set(target.sessionId, treePresence);
      }
    }
  }
  const confirmed = await mapWithConcurrency(candidates, 3, ({ workspaceId, surfaceId }) => (
    confirmCmuxContextSurface(probe.cli, workspaceId, surfaceId)
  ));
  for (let index = 0; index < candidates.length; index++) {
    result.set(candidates[index]!.target.sessionId, confirmed[index]!);
  }
  return result;
}

const CODEX_TUI_PROBE_CACHE_MS = 5_000;
let codexTuiProbeCache: { at: number; state: CodexTuiRuntimeState } | null = null;
let codexTuiProbeInFlight: Promise<CodexTuiRuntimeState> | null = null;

/** Read-only process listing. A Codex CLI session cannot outlive its process,
 * so an empty listing is the one conclusive answer available for those rows. */
async function readCodexTuiRuntimeState(): Promise<CodexTuiRuntimeState> {
  if (IS_WIN) return 'unverified';
  const cached = codexTuiProbeCache;
  if (cached && Date.now() - cached.at < CODEX_TUI_PROBE_CACHE_MS) return cached.state;
  if (codexTuiProbeInFlight) return codexTuiProbeInFlight;

  const request = new Promise<CodexTuiRuntimeState>((resolveState) => {
    nodeExecFile(
      '/bin/ps',
      ['-Ao', 'command='],
      { encoding: 'utf-8', timeout: 4_000, maxBuffer: 8 * 1024 * 1024 },
      (error: any, stdout: string) => {
        if (error) return resolveState('unverified');
        resolveState(codexTuiRuntimeState(String(stdout ?? '').split('\n')));
      },
    );
  }).then((state) => {
    codexTuiProbeCache = { at: Date.now(), state };
    codexTuiProbeInFlight = null;
    return state;
  });
  codexTuiProbeInFlight = request;
  return request;
}

const CLAUDE_AGENT_INVENTORY_CACHE_MS = 5_000;
/**
 * How long a successful listing keeps answering after a later call fails.
 *
 * A single failed `claude agents` call used to drop the whole list to
 * "unavailable", which makes every background-agent row fall back to an
 * unidentified one — so a finished agent visibly reappeared for a poll or two
 * and then vanished again. The listing changes slowly compared with the panel's
 * five-second poll, so reusing the last good answer across a brief failure is
 * both steadier and closer to the truth than forgetting everything.
 */
const CLAUDE_AGENT_INVENTORY_GRACE_MS = 60_000;
let claudeAgentInventoryCache: { at: number; inventory: ClaudeAgentInventory } | null = null;
let claudeAgentLastGoodInventory: { at: number; inventory: ClaudeAgentInventory } | null = null;
let claudeAgentInventoryInFlight: Promise<ClaudeAgentInventory> | null = null;

/** `claude agents --json --all` listing, cached and de-duplicated across
 * overlapping panel polls. It only prints local daemon bookkeeping — no model
 * call, no session mutation. */
async function readClaudeAgentInventory(): Promise<ClaudeAgentInventory> {
  const cached = claudeAgentInventoryCache;
  if (cached && Date.now() - cached.at < CLAUDE_AGENT_INVENTORY_CACHE_MS) return cached.inventory;
  if (claudeAgentInventoryInFlight) return claudeAgentInventoryInFlight;

  const request = new Promise<ClaudeAgentInventory>((resolveInventory) => {
    const bin = resolveAgentBin('claude');
    nodeExecFile(
      bin,
      ['agents', '--json', '--all'],
      // The CLI competes with whatever else the machine is doing; a short
      // timeout here is the failure this grace period exists to absorb.
      { encoding: 'utf-8', timeout: 12_000, maxBuffer: 8 * 1024 * 1024 },
      (error: any, stdout: string) => {
        if (error) return resolveInventory(UNAVAILABLE_CLAUDE_AGENT_INVENTORY);
        try {
          resolveInventory(parseClaudeAgentInventory(JSON.parse(String(stdout ?? ''))));
        } catch {
          resolveInventory(UNAVAILABLE_CLAUDE_AGENT_INVENTORY);
        }
      },
    );
  }).then((fresh) => {
    const now = Date.now();
    // Only a fresh success renews the grace period; reusing a remembered
    // listing must never extend how long it may be reused.
    if (fresh.kind === 'listed') claudeAgentLastGoodInventory = { at: now, inventory: fresh };
    const resolved = resolveClaudeAgentInventory(fresh, claudeAgentLastGoodInventory, now, CLAUDE_AGENT_INVENTORY_GRACE_MS);
    claudeAgentInventoryCache = { at: now, inventory: resolved };
    claudeAgentInventoryInFlight = null;
    return resolved;
  });
  claudeAgentInventoryInFlight = request;
  return request;
}

/** Add a runtime existence state only for integrations that expose a stable
 * session-to-surface identity.  Generic terminal and ChatGPT JSONL records
 * remain recent snapshots; they are never claimed to be verified-open. */
async function inspectClaudeContextSurfacePresence(
  candidates: readonly ClaudeContextSurfaceCandidate[],
  options?: { probeOrcaRuntimeWhenEmpty?: boolean },
): Promise<{
  presence: Map<string, ContextSurfacePresence>;
  orcaRuntimeState: OrcaContextRuntimeState;
  agentInventory: ClaudeAgentInventory;
}> {
  const presence = new Map<string, ContextSurfacePresence>();
  const orcaTargets = candidates.filter(({ launchContext }) => !!launchContext?.orcaWorktreeId);
  const cmuxTargets = candidates.filter(({ launchContext }) => (
    !launchContext?.orcaWorktreeId && !!(launchContext?.cmuxWorkspaceId || launchContext?.cmuxSurfaceId)
  ));
  // Only a session with no terminal identifier at all can be a background
  // agent, so the listing is read exactly when it can change an answer.
  const needsAgentInventory = candidates.some(({ launchContext }) => (
    !launchContext?.orcaWorktreeId && !launchContext?.cmuxWorkspaceId && !launchContext?.cmuxSurfaceId
  ));
  const [orca, cmux, agentInventory] = await Promise.all([
    inspectOrcaContextSurfacePresence(orcaTargets, {
      probeRuntimeWhenEmpty: options?.probeOrcaRuntimeWhenEmpty,
    }),
    inspectCmuxContextSurfacePresence(cmuxTargets),
    needsAgentInventory ? readClaudeAgentInventory() : Promise.resolve(UNAVAILABLE_CLAUDE_AGENT_INVENTORY),
  ]);
  for (const target of candidates) {
    const agentPresence = claudeAgentSurfacePresence(agentInventory, target.sessionId, {
      hasTerminalEvidence: hasTerminalLaunchEvidence(target.launchContext),
    });
    presence.set(
      target.sessionId,
      orca.presence.get(target.sessionId)
        ?? cmux.get(target.sessionId)
        // 'not-applicable' here means "not a known background agent", so it
        // must not outrank the terminal probes above.
        ?? (agentPresence === 'not-applicable' ? undefined : agentPresence)
        ?? 'not-applicable',
    );
  }
  return { presence, orcaRuntimeState: orca.runtimeState, agentInventory };
}

/** A Codex desktop deep link is allowed only after the server independently
 * finds the rollout's desktop origin. This prevents a web caller from using
 * this localhost endpoint to open arbitrary codex:// URLs. */
function isRecordedChatGptCodexSession(sessionId: string): boolean {
  if (!isSafeContextSessionId(sessionId)) return false;
  const sessionsDir = join(homedir(), '.codex', 'sessions');
  if (!existsSync(sessionsDir)) return false;
  try {
    const files = (readdirSync(sessionsDir, { recursive: true }) as string[])
      .filter(file => file.endsWith('.jsonl'))
      .map(file => {
        const full = join(sessionsDir, file);
        try { return { full, mtimeMs: statSync(full).mtimeMs }; } catch { return null; }
      })
      .filter((file): file is { full: string; mtimeMs: number } => file !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 48);
    for (const file of files) {
      const fd = openSync(file.full, 'r');
      const bytes = Buffer.alloc(Math.min(64 * 1024, statSync(file.full).size));
      try {
        readSync(fd, bytes, 0, bytes.length, 0);
      } finally {
        closeSync(fd);
      }
      for (const line of bytes.toString('utf8').split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const row = JSON.parse(line);
          if (row.type !== 'session_meta') continue;
          const meta = row.payload ?? {};
          if ((meta.id === sessionId || meta.session_id === sessionId) && meta.originator === 'Codex Desktop') {
            return true;
          }
        } catch { /* a bounded final JSONL line may be incomplete */ }
      }
    }
  } catch { /* unavailable session history is not a reason to guess */ }
  return false;
}

function hasJsonValue(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some(item => hasJsonValue(item, expected));
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>)
    .some(item => hasJsonValue(item, expected));
  return false;
}

async function focusCmuxContextSession(context: Record<string, any>): Promise<ContextSessionFocusOutcome> {
  const workspaceId = context.cmuxWorkspaceId;
  const surfaceId = context.cmuxSurfaceId;
  if (!isRuntimeUuid(workspaceId) || !isRuntimeUuid(surfaceId)) {
    return { success: false, code: 'CMUX_TARGET_UNAVAILABLE', error: 'cmux 세션 식별자가 완전하지 않습니다.' };
  }
  const cli = resolveCmuxCli();
  if (!cli && !cmuxAppExists()) {
    return { success: false, code: 'CMUX_NOT_INSTALLED', error: 'cmux가 설치되어 있지 않습니다.' };
  }
  if (cmuxAppExists()) nodeSpawnSync('open', ['-a', 'cmux'], { stdio: 'pipe' });
  const cliPath = cli ?? 'cmux';
  if (!(await waitCmuxReadyNode(cliPath))) {
    return { success: false, code: 'CMUX_NOT_READY', error: cmuxAccessHelp('cmux 소켓 준비 대기 시간 초과') };
  }

  // `identify` asks the daemon to resolve this exact workspace+surface pair
  // before we change focus. A stale pair must not fall back to a same-cwd tab.
  const identified = nodeCmuxRun(cliPath, ['--json', 'identify', '--workspace', workspaceId, '--surface', surfaceId, '--no-caller']);
  if (!identified.ok) {
    return { success: false, code: 'CMUX_TARGET_STALE', error: cmuxAccessHelp(`cmux 세션 확인 실패: ${identified.stderr || '대상을 찾지 못했습니다.'}`) };
  }
  let identifyJson: unknown;
  try { identifyJson = JSON.parse(identified.stdout); } catch {
    return { success: false, code: 'CMUX_TARGET_UNVERIFIED', error: 'cmux가 세션 확인 결과를 읽을 수 있는 형식으로 반환하지 않았습니다. 이동하지 않았습니다.' };
  }
  if (!hasJsonValue(identifyJson, workspaceId) || !hasJsonValue(identifyJson, surfaceId)) {
    return { success: false, code: 'CMUX_TARGET_UNVERIFIED', error: 'cmux가 이 workspace와 surface의 연결을 확인하지 못했습니다. 이동하지 않았습니다.' };
  }

  const selected = nodeCmuxRun(cliPath, ['select-workspace', '--workspace', workspaceId]);
  if (!selected.ok) {
    return { success: false, code: 'CMUX_WORKSPACE_FOCUS_FAILED', error: cmuxAccessHelp(`cmux 워크스페이스 이동 실패: ${selected.stderr || 'unknown'}`) };
  }
  const focused = nodeCmuxRun(cliPath, ['focus-panel', '--panel', surfaceId, '--workspace', workspaceId]);
  if (!focused.ok) {
    return { success: false, code: 'CMUX_SURFACE_FOCUS_FAILED', error: cmuxAccessHelp(`cmux 패널 이동 실패: ${focused.stderr || 'unknown'}`) };
  }
  return { success: true, message: 'cmux의 해당 세션 창으로 이동했습니다.', exact: true };
}

async function focusOrcaWorktreeContextSession(
  sessionId: string,
  context: Record<string, any>,
): Promise<ContextSessionFocusOutcome> {
  const paneKey = typeof context.orcaPaneKey === 'string' ? context.orcaPaneKey : null;
  const snapshotWorktreeId = context.orcaWorktreeId;
  if (!paneKey || typeof snapshotWorktreeId !== 'string' || !snapshotWorktreeId) {
    return { success: false, code: 'ORCA_TARGET_UNAVAILABLE', error: 'Orca 세션 식별자가 완전하지 않습니다.' };
  }
  let state: unknown;
  try { state = JSON.parse(readFileSync(ORCA_LOCAL_SESSION_FILE, 'utf8')); } catch {
    return { success: false, code: 'ORCA_TARGET_UNAVAILABLE', error: 'Orca의 현재 세션 정보를 읽지 못했습니다. 이동하지 않았습니다.' };
  }
  const binding = findOrcaSessionBinding(state, sessionId, paneKey);
  if (!binding || binding.worktreeId !== snapshotWorktreeId) {
    return { success: false, code: 'ORCA_TARGET_STALE', error: 'Orca의 저장된 세션과 현재 컨텍스트가 일치하지 않습니다. 이동하지 않았습니다.' };
  }
  const cli = resolveOrcaCli();
  if (!cli) return { success: false, code: 'ORCA_NOT_INSTALLED', error: bootstrapOrcaInstall() };

  return withOrcaLock(async () => {
    const ready = await ensureOrcaReady(cli);
    if (!ready.ok) return { success: false, code: 'ORCA_NOT_READY', error: ready.error };
    const listed = await nodeOrcaRunJsonRetry(cli, ['terminal', 'list', '--limit', '200'], {
      attempts: 2, backoffMs: 400, timeoutMs: 8000,
    });
    if (!listed.ok) {
      return { success: false, code: 'ORCA_TARGET_UNAVAILABLE', error: `Orca 터미널 목록을 확인하지 못했습니다. 이동하지 않았습니다.\n(${listed.error})` };
    }
    const live = findLiveOrcaTerminal(listed.result, binding);
    if (!live) {
      return { success: false, code: 'ORCA_TARGET_STALE', error: 'Orca의 현재 터미널에서 해당 세션을 하나로 확인하지 못했습니다. 이동하지 않았습니다.' };
    }
    const shown = await nodeOrcaRunJsonRetry(cli, ['terminal', 'show', '--terminal', live.handle], {
      attempts: 2, backoffMs: 300, timeoutMs: 8000,
    });
    const verified = shown.ok ? findLiveOrcaTerminal(shown.result, binding) : null;
    if (!verified || verified.handle !== live.handle) {
      return { success: false, code: 'ORCA_TARGET_STALE', error: 'Orca 터미널을 다시 검증하지 못했습니다. 이동하지 않았습니다.' };
    }
    const switched = await nodeOrcaRunJsonRetry(cli, ['terminal', 'switch', '--terminal', live.handle], {
      attempts: 2, backoffMs: 300, timeoutMs: 5000,
    });
    if (!switched.ok) {
      return { success: false, code: 'ORCA_FOCUS_FAILED', error: `Orca 세션 이동 실패: ${switched.error}` };
    }
    return { success: true, message: 'Orca의 해당 세션 창으로 이동했습니다.', exact: true };
  });
}

async function revealOrcaFloatingContextSession(): Promise<ContextSessionFocusOutcome> {
  const cli = resolveOrcaCli();
  if (!cli) return { success: false, code: 'ORCA_NOT_INSTALLED', error: bootstrapOrcaInstall() };
  return withOrcaLock(async () => {
    const ready = await ensureOrcaReady(cli);
    if (!ready.ok) return { success: false, code: 'ORCA_NOT_READY', error: ready.error };
    const revealed = await revealOrcaFloatingWorkspace(cli);
    if (!revealed.ok) return { success: false, code: 'ORCA_FLOATING_REVEAL_FAILED', error: revealed.error };
    return {
      success: true,
      message: 'Orca 플로팅 작업공간을 열었습니다. 개별 탭 자동 선택은 Orca의 안전한 공개 API가 지원되면 추가됩니다.',
      exact: false,
    };
  });
}

type OrcaFloatingTerminalRecord = {
  agent: string;
  folderPath: string;
  handle: string;
  title: string;
  updatedAt: number;
};

type OrcaFloatingTerminalRegistry = {
  version: 1;
  terminals: Record<string, OrcaFloatingTerminalRecord>;
};

const emptyOrcaFloatingTerminalRegistry = (): OrcaFloatingTerminalRegistry => ({
  version: 1,
  terminals: {},
});

function orcaFloatingTerminalRegistryKey(agent: string, folderPath: string): string {
  return orcaManagedFloatingTerminalMarker(agent, normalizeOrcaFloatingTerminalPath(folderPath));
}

/** Read the small cross-process registry defensively. A malformed local file
 * must never make us target an arbitrary terminal; it is treated as an empty
 * registry and the marker migration lookup will still be attempted. */
function readOrcaFloatingTerminalRegistry(): OrcaFloatingTerminalRegistry {
  if (!existsSync(ORCA_FLOATING_TERMINALS_FILE)) return emptyOrcaFloatingTerminalRegistry();
  try {
    const parsed = JSON.parse(readFileSync(ORCA_FLOATING_TERMINALS_FILE, 'utf8')) as {
      terminals?: unknown;
    };
    if (!parsed?.terminals || typeof parsed.terminals !== 'object' || Array.isArray(parsed.terminals)) {
      return emptyOrcaFloatingTerminalRegistry();
    }
    const terminals: Record<string, OrcaFloatingTerminalRecord> = {};
    for (const [key, value] of Object.entries(parsed.terminals as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      if (
        typeof record.agent !== 'string' || !record.agent.trim()
        || typeof record.folderPath !== 'string' || !record.folderPath.trim()
        || typeof record.handle !== 'string' || !record.handle.trim()
      ) continue;
      const folderPath = normalizeOrcaFloatingTerminalPath(record.folderPath);
      if (key !== orcaFloatingTerminalRegistryKey(record.agent, folderPath)) continue;
      terminals[key] = {
        agent: record.agent,
        folderPath,
        handle: record.handle,
        title: typeof record.title === 'string' ? record.title : '',
        updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
          ? record.updatedAt
          : 0,
      };
    }
    return { version: 1, terminals };
  } catch (error) {
    console.warn('[Orca Floating] terminal registry read failed; using marker migration lookup:', error);
    return emptyOrcaFloatingTerminalRegistry();
  }
}

async function acquireOrcaFloatingTerminalsFileLock(): Promise<() => void> {
  if (!existsSync(APP_DATA_DIR)) mkdirSync(APP_DATA_DIR, { recursive: true });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const fd = openSync(ORCA_FLOATING_TERMINALS_LOCK_FILE, 'wx');
      return () => {
        try { closeSync(fd); } catch {}
        try { unlinkSync(ORCA_FLOATING_TERMINALS_LOCK_FILE); } catch {}
      };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(ORCA_FLOATING_TERMINALS_LOCK_FILE).mtimeMs > 15_000) {
          unlinkSync(ORCA_FLOATING_TERMINALS_LOCK_FILE);
          continue;
        }
      } catch {}
      await Bun.sleep(20);
    }
  }
  throw new Error('Orca Floating Terminal 레지스트리 잠금을 3초 안에 획득하지 못했습니다.');
}

function atomicWriteOrcaFloatingTerminalRegistry(registry: OrcaFloatingTerminalRegistry): void {
  if (!existsSync(APP_DATA_DIR)) mkdirSync(APP_DATA_DIR, { recursive: true });
  const temporaryFile = `${ORCA_FLOATING_TERMINALS_FILE}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporaryFile, JSON.stringify(registry, null, 2));
    renameSync(temporaryFile, ORCA_FLOATING_TERMINALS_FILE);
  } finally {
    if (existsSync(temporaryFile)) {
      try { unlinkSync(temporaryFile); } catch {}
    }
  }
}

function rememberedOrcaFloatingTerminal(agent: string, folderPath: string): OrcaFloatingTerminalRecord | null {
  const normalizedPath = normalizeOrcaFloatingTerminalPath(folderPath);
  return readOrcaFloatingTerminalRegistry().terminals[orcaFloatingTerminalRegistryKey(agent, normalizedPath)] ?? null;
}

async function rememberOrcaFloatingTerminal(
  agent: string,
  folderPath: string,
  handle: string,
  title: string,
): Promise<void> {
  const normalizedPath = normalizeOrcaFloatingTerminalPath(folderPath);
  const key = orcaFloatingTerminalRegistryKey(agent, normalizedPath);
  const release = await acquireOrcaFloatingTerminalsFileLock();
  try {
    const registry = readOrcaFloatingTerminalRegistry();
    registry.terminals[key] = {
      agent,
      folderPath: normalizedPath,
      handle,
      title,
      updatedAt: Date.now(),
    };
    atomicWriteOrcaFloatingTerminalRegistry(registry);
  } finally {
    release();
  }
}

/** Remove only the stale handle we just checked. A concurrent newer launch
 * may have already stored a replacement, which must be left intact. */
async function forgetOrcaFloatingTerminal(
  agent: string,
  folderPath: string,
  handle: string,
): Promise<void> {
  const normalizedPath = normalizeOrcaFloatingTerminalPath(folderPath);
  const key = orcaFloatingTerminalRegistryKey(agent, normalizedPath);
  const release = await acquireOrcaFloatingTerminalsFileLock();
  try {
    const registry = readOrcaFloatingTerminalRegistry();
    if (registry.terminals[key]?.handle !== handle) return;
    delete registry.terminals[key];
    atomicWriteOrcaFloatingTerminalRegistry(registry);
  } finally {
    release();
  }
}

type RememberedOrcaFloatingTerminalVerification =
  | { state: 'valid'; terminal: OrcaListedTerminal }
  | { state: 'stale' }
  | { state: 'unavailable'; error: string };

const ORCA_STALE_FLOATING_TERMINAL_ERROR_RE = /(?:terminal[_ -]?handle[_ -]?stale|unknown terminal|terminal[^\n]*(?:not found|does not exist|missing)|no such terminal|invalid terminal)/i;

/** A successful `terminal show` is the source of truth for a remembered
 * handle. We never trust the saved handle on its own or send it a command. */
async function verifyRememberedOrcaFloatingTerminal(
  cli: string,
  record: OrcaFloatingTerminalRecord,
): Promise<RememberedOrcaFloatingTerminalVerification> {
  const shown = await nodeOrcaRunJsonRetry(cli, [
    'terminal', 'show',
    '--terminal', record.handle,
  ], { attempts: 2, backoffMs: 500, timeoutMs: 8000 });
  if (!shown.ok) {
    if (ORCA_STALE_FLOATING_TERMINAL_ERROR_RE.test(shown.error)) return { state: 'stale' };
    return { state: 'unavailable', error: shown.error };
  }
  const terminal = findOrcaFloatingTerminalByHandle(shown.result, record.handle);
  return terminal ? { state: 'valid', terminal } : { state: 'stale' };
}

function orcaFloatingLookupUnavailableError(detail: string): string {
  return '기존 Orca Floating Terminal을 확인하지 못했습니다. 새 탭을 만들지 않았습니다. '
    + `Orca가 준비된 뒤 다시 시도해주세요.\n(${detail})`;
}

// ──────────────── 포트 로그 회전 + append fd ────────────────
const LOG_ROTATE_MAX_BYTES = 10 * 1024 * 1024; // 10MB 초과 시 회전
const LOG_ROTATE_KEEP_BYTES = 1024 * 1024;     // 마지막 ~1MB만 유지

/** portId를 파일명/프로세스 맵 키로 쓰기 안전한지 검증 (경로 탈출·메모리 남용 방지). */
const isSafeLogId = (id: unknown): id is string => (
  typeof id === 'string'
  && id.length > 0
  && id.length <= 128
  && /^[A-Za-z0-9._-]+$/.test(id)
);

/** logs/{portId}.log가 10MB 초과면 마지막 ~1MB만 남기고 truncate.
 * Rust 측(execute_command)의 동일 가드 미러 — 무한 append로 디스크/메모리
 * (read-log 폴링이 파일을 읽음)가 폭주하지 않도록 spawn 전에 호출한다. */
async function rotateLogIfNeeded(portId: string): Promise<void> {
  try {
    if (!isSafeLogId(portId)) return;
    const logFile = join(APP_DATA_DIR, 'logs', `${portId}.log`);
    const f = Bun.file(logFile);
    if (!(await f.exists())) return;
    const size = f.size;
    if (size <= LOG_ROTATE_MAX_BYTES) return;
    // tail 부분만 읽어 재작성 — 전체 파일을 메모리에 올리지 않음
    const tail = await f.slice(size - LOG_ROTATE_KEEP_BYTES).arrayBuffer();
    await Bun.write(logFile, tail);
    devLog(`[LogRotate] ${portId}.log: ${size} bytes → kept last ${tail.byteLength} bytes`);
  } catch (e) {
    console.error('[LogRotate] rotation failed:', e);
  }
}

/** logs/{portId}.log를 append 모드로 열어 fd 반환 (spawn stdout/stderr 리다이렉트용).
 * 실패 시 null — 호출부는 'inherit'로 폴백. spawn 직후 parent 쪽 fd는 닫을 것. */
function openLogAppendFd(portId: string): number | null {
  try {
    if (!isSafeLogId(portId)) return null;
    const logsDir = join(APP_DATA_DIR, 'logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    return openSync(join(logsDir, `${portId}.log`), 'a');
  } catch (e) {
    console.error('[LogRotate] failed to open log fd:', e);
    return null;
  }
}

// 다른 기기에서 동기된 경로를 현재 기기 경로로 자동 수정
function remapPathsToCurrentUser(ports: any[]): { ports: any[]; changed: boolean } {
  const home = homedir();
  const homeMatch = home.match(/^\/Users\/([^/]+)/);
  if (!homeMatch) return { ports, changed: false };
  const currentUser = homeMatch[1];

  let changed = false;
  const remapped = ports.map((p: any) => {
    const fix = (path?: string) => {
      if (!path || !path.startsWith('/Users/')) return path;
      const m = path.match(/^\/Users\/([^/]+)(\/.*)?$/);
      if (!m || m[1] === currentUser) return path;
      const candidate = `/Users/${currentUser}${m[2] ?? ''}`;
      if (existsSync(candidate)) { changed = true; return candidate; }
      return path;
    };
    return { ...p, folderPath: fix(p.folderPath), commandPath: fix(p.commandPath) };
  });
  return { ports: remapped, changed };
}

function normalizePortsPayload(payload: unknown): PortRecord[] {
  if (Array.isArray(payload)) return payload;
  // One development HMR transition briefly paired the new frontend request
  // envelope with the previous API process. Recover that non-destructively.
  if (
    payload
    && typeof payload === 'object'
    && Array.isArray((payload as { ports?: unknown }).ports)
  ) {
    console.warn('[Data] Recovering ports array from a wrapped save payload');
    return (payload as { ports: PortRecord[] }).ports;
  }
  throw new Error('ports.json 형식이 배열이 아닙니다.');
}

// 포트 데이터 로드
async function loadPortsData() {
  try {
    const file = Bun.file(PORTS_DATA_FILE);
    if (await file.exists()) {
      const data = normalizePortsPayload(await file.json());
      const { ports: remapped, changed } = remapPathsToCurrentUser(data);
      if (changed) {
        // Reads must stay read-only. Writing this snapshot here can race with a
        // project created by another browser tab or the Tauri application.
        devLog('[Data] Auto-remapped paths to current user home dir');
      }
      return remapped;
    }
  } catch (error) {
    console.error("[Data] Error loading ports data:", error);
  }
  return [];
}

type DetectedStartCommand = {
  command: string | null;
  framework: 'next' | 'vite' | 'other';
};

/** 실행 명령 감지의 단일 원본. 실행 API의 허용목록과 감지 API가 같은 결과를 사용한다. */
async function detectStartCommandAt(folderPath: string): Promise<DetectedStartCommand> {
  const pkgPath = join(folderPath, 'package.json');
  const detectFramework = (scriptContent: string | undefined): DetectedStartCommand['framework'] => {
    if (!scriptContent) return 'other';
    const trimmed = scriptContent.trim();
    if (/^next\s+dev\b/.test(trimmed)) return 'next';
    if (/^vite\b/.test(trimmed)) return 'vite';
    return 'other';
  };
  if (existsSync(pkgPath)) {
    try {
      const pkg = await Bun.file(pkgPath).json() as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      if ('dev' in scripts) return { command: 'bun run dev', framework: detectFramework(scripts.dev) };
      if ('start' in scripts) return { command: 'bun run start', framework: detectFramework(scripts.start) };
    } catch {}
    return { command: 'bun run dev', framework: 'other' };
  }
  if (existsSync(join(folderPath, 'pyproject.toml'))) {
    return { command: 'uv run python main.py', framework: 'other' };
  }
  if (existsSync(join(folderPath, 'Cargo.toml'))) {
    return { command: 'cargo run', framework: 'other' };
  }
  // No manifest at the root: fall back to a `.command` launcher if the folder
  // has one. Monorepos whose runnable parts sit in subfolders are started this
  // way, and picking one subfolder's manifest instead would run half the app.
  try {
    const launcher = pickCommandLauncher(readdirSync(folderPath));
    if (launcher.fileName) {
      return { command: join(folderPath, launcher.fileName), framework: 'other' };
    }
  } catch {}
  return { command: null, framework: 'other' };
}

/** Normal start and force-restart must repair the same missing local dependencies.
 * Keep this in one helper so a worktree cannot start successfully once and then
 * fail merely because the user chose the restart control. */
async function ensureDependenciesForLaunch(isFilePath: boolean, folderPath: unknown): Promise<void> {
  if (isFilePath || typeof folderPath !== 'string' || !folderPath || !existsSync(folderPath)) return;
  const enrichedPath = IS_WIN
    ? process.env.PATH ?? ""
    : `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homedir()}/.bun/bin:${homedir()}/.local/bin:${homedir()}/.cargo/bin:${process.env.PATH ?? ""}`;
  const instEnv = { ...process.env, PATH: enrichedPath };
  if (existsSync(join(folderPath, 'package.json')) && !existsSync(join(folderPath, 'node_modules', '.bin'))) {
    devLog(`[ProcessLaunch] node_modules 없음 → bun install (sync) @ ${folderPath}`);
    try { Bun.spawnSync(['bun', 'install'], { cwd: folderPath, env: instEnv, stdout: 'ignore', stderr: 'ignore' }); }
    catch (error) { console.error('[ProcessLaunch] bun install 실패(무시):', error); }
  } else if (existsSync(join(folderPath, 'pyproject.toml')) && !existsSync(join(folderPath, '.venv'))) {
    devLog(`[ProcessLaunch] .venv 없음 → uv sync (sync) @ ${folderPath}`);
    try { Bun.spawnSync(['uv', 'sync'], { cwd: folderPath, env: instEnv, stdout: 'ignore', stderr: 'ignore' }); }
    catch (error) { console.error('[ProcessLaunch] uv sync 실패(무시):', error); }
  }
}

type PortRegistrationValidation =
  | { ok: true; record: Record<string, unknown>; storedFolderPath?: string; storedPort?: number }
  | { ok: false; status: number; code: string; error: string };

async function validateRegisteredPortControl(
  portId: string,
  requestedPort: unknown,
): Promise<PortRegistrationValidation> {
  const ports = await loadPortsData();
  const registered = ports.find(port => port.id === portId) as (PortRecord & Record<string, unknown>) | undefined;
  if (!registered) {
    return {
      ok: false,
      status: 403,
      code: 'PORT_NOT_REGISTERED',
      error: '등록된 프로젝트 ID가 아니므로 로컬 프로세스를 제어할 수 없습니다.',
    };
  }
  const storedPort = typeof registered.port === 'number' ? registered.port : undefined;
  // 기존 stop API는 포트가 없는 프로젝트를 0으로 전달한다. 0은 "포트 없음" 센티널로만 허용한다.
  const normalizedRequestedPort = requestedPort === 0
    ? undefined
    : typeof requestedPort === 'number'
      ? requestedPort
      : undefined;
  if (requestedPort !== undefined && requestedPort !== null && requestedPort !== 0
    && (typeof requestedPort !== 'number' || !Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_PORT',
      error: 'port는 1~65535 범위의 정수여야 합니다.',
    };
  }
  if (storedPort !== normalizedRequestedPort) {
    return {
      ok: false,
      status: 403,
      code: 'PORT_REGISTRATION_MISMATCH',
      error: '요청 포트가 등록된 프로젝트 포트와 일치하지 않습니다.',
    };
  }
  return {
    ok: true,
    record: registered,
    storedFolderPath: typeof registered.folderPath === 'string' ? registered.folderPath : undefined,
    storedPort,
  };
}

async function validateRegisteredExecution(
  portId: string,
  commandPath: unknown,
  folderPath: unknown,
  port: unknown,
): Promise<PortRegistrationValidation> {
  const registration = await validateRegisteredPortControl(portId, port);
  if (!registration.ok) return registration;
  if (typeof commandPath !== 'string' || !commandPath) {
    return { ok: false, status: 400, code: 'INVALID_COMMAND', error: '실행 명령이 올바르지 않습니다.' };
  }

  const requestedFolderPath = typeof folderPath === 'string' && folderPath ? folderPath : undefined;
  const storedFolderPath = registration.storedFolderPath;
  const folderMatches = storedFolderPath === undefined
    ? requestedFolderPath === undefined
    : requestedFolderPath !== undefined
      && isAbsolute(storedFolderPath)
      && isAbsolute(requestedFolderPath)
      && normalizeWorktreePath(storedFolderPath) === normalizeWorktreePath(requestedFolderPath);
  if (!folderMatches) {
    return {
      ok: false,
      status: 403,
      code: 'FOLDER_REGISTRATION_MISMATCH',
      error: '요청 작업 폴더가 등록된 프로젝트 경로와 일치하지 않습니다.',
    };
  }

  const allowedCommands = new Set<string>();
  if (typeof registration.record.commandPath === 'string') allowedCommands.add(registration.record.commandPath);
  if (typeof registration.record.terminalCommand === 'string') allowedCommands.add(registration.record.terminalCommand);
  if (storedFolderPath) {
    const detected = await detectStartCommandAt(storedFolderPath);
    if (detected.command) allowedCommands.add(detected.command);
    const isWorktree = typeof registration.record.worktreePath === 'string' && !!registration.record.worktreePath;
    if (isWorktree && registration.storedPort) {
      if (detected.framework === 'vite') allowedCommands.add(`bunx vite --port ${registration.storedPort}`);
      if (detected.framework === 'next') allowedCommands.add(`bunx next dev -p ${registration.storedPort}`);
    }
  }
  if (!allowedCommands.has(commandPath)) {
    return {
      ok: false,
      status: 403,
      code: 'COMMAND_NOT_REGISTERED',
      error: '등록되거나 서버가 감지한 실행 명령이 아니므로 실행을 차단했습니다.',
    };
  }
  return registration;
}

async function acquirePortsFileLock(): Promise<() => void> {
  if (!existsSync(APP_DATA_DIR)) mkdirSync(APP_DATA_DIR, { recursive: true });

  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const fd = openSync(PORTS_LOCK_FILE, 'wx');
      return () => {
        try { closeSync(fd); } catch {}
        try { unlinkSync(PORTS_LOCK_FILE); } catch {}
      };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(PORTS_LOCK_FILE).mtimeMs > 15_000) {
          unlinkSync(PORTS_LOCK_FILE);
          continue;
        }
      } catch {}
      await Bun.sleep(20);
    }
  }
  throw new Error('ports.json 저장 잠금을 3초 안에 획득하지 못했습니다.');
}

async function readPortsFileStrict(): Promise<PortRecord[]> {
  if (!existsSync(PORTS_DATA_FILE)) return [];
  return normalizePortsPayload(JSON.parse(await Bun.file(PORTS_DATA_FILE).text()));
}

function atomicWritePorts(data: PortRecord[]): void {
  if (!existsSync(APP_DATA_DIR)) mkdirSync(APP_DATA_DIR, { recursive: true });
  const temporaryFile = `${PORTS_DATA_FILE}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    if (existsSync(PORTS_DATA_FILE)) copyFileSync(PORTS_DATA_FILE, PORTS_BACKUP_FILE);
    writeFileSync(temporaryFile, JSON.stringify(data, null, 2));
    renameSync(temporaryFile, PORTS_DATA_FILE);
  } finally {
    if (existsSync(temporaryFile)) {
      try { unlinkSync(temporaryFile); } catch {}
    }
  }
}

type PortsSaveRequest = {
  ports: PortRecord[];
  basePorts?: PortRecord[];
  source?: string;
};

// Cross-window/process safe save: lock → latest read → 3-way merge → backup → rename.
async function savePortsData(request: PortsSaveRequest): Promise<PortRecord[]> {
  const release = await acquirePortsFileLock();
  try {
    const current = await readPortsFileStrict();
    const merged = Array.isArray(request.basePorts)
      ? mergePortSnapshots(request.basePorts, request.ports, current)
      : mergeLegacyPortSave(request.ports, current);
    atomicWritePorts(merged);
    appendFileSync(PORTS_AUDIT_FILE, JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      source: request.source ?? (request.basePorts ? 'three-way' : 'legacy'),
      baseCount: request.basePorts?.length ?? null,
      desiredCount: request.ports.length,
      previousCount: current.length,
      savedCount: merged.length,
    }) + '\n');
    devLog("[Data] Ports data saved safely to:", PORTS_DATA_FILE);
    return merged;
  } catch (error) {
    console.error("[Data] Error saving ports data:", error);
    throw error;
  } finally {
    release();
  }
}

async function registerProjectMemoryProject(input: {
  folderPath: string;
  projectName?: string;
}) {
  const status = detectProjectMemory(input.folderPath);
  if (!status.exists || !status.config?.memoryId) {
    throw new ProjectMemoryError(
      "장기기억을 먼저 초기화한 프로젝트만 등록할 수 있습니다.",
      "PROJECT_MEMORY_NOT_INITIALIZED",
    );
  }
  const canonicalPath = status.projectRoot;
  const projectName = (typeof input.projectName === "string" ? input.projectName : "")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || basename(canonicalPath);
  const deterministicId = `project-memory-${status.config.memoryId}`;
  const registered = await readPortsFileStrict();
  const matching = registered.filter((candidate) => {
    if (candidate.id === deterministicId) return true;
    const record = candidate as PortRecord & { folderPath?: unknown; worktreePath?: unknown };
    for (const value of [record.folderPath, record.worktreePath]) {
      if (typeof value !== "string" || !value.trim() || !existsSync(value)) continue;
      try {
        if (realpathSync(resolve(value)) === canonicalPath) return true;
      } catch { /* an unreadable stale row is not a match */ }
    }
    return false;
  });
  if (matching.length > 1) {
    throw new ProjectMemoryError(
      "같은 프로젝트 경로 또는 기억 ID를 가리키는 등록 행이 여러 개입니다.",
      "PROJECT_REGISTRATION_AMBIGUOUS",
    );
  }
  const existing = matching[0] as (PortRecord & Record<string, unknown>) | undefined;
  const project = existing
    ? { ...existing, name: projectName, folderPath: canonicalPath }
    : {
        id: deterministicId,
        name: projectName,
        folderPath: canonicalPath,
        category: "장기기억",
        description: "AWS Ubuntu에서 등록한 프로젝트 장기기억",
      };
  const desired = existing
    ? registered.map(candidate => candidate.id === existing.id ? project as PortRecord : candidate)
    : [...registered, project as PortRecord];
  await savePortsData({
    basePorts: registered,
    ports: desired,
    source: "project-memory-register-project",
  });
  return {
    ok: true,
    created: !existing,
    project: {
      id: project.id,
      name: projectName,
      folderPath: canonicalPath,
      memoryId: status.config.memoryId,
    },
  };
}

// 마지막 실행/방문 시각 로드 — 웹/앱이 동일 파일을 공유
async function loadLastVisitsData(): Promise<Record<string, number>> {
  try {
    const file = Bun.file(LAST_VISITS_FILE);
    if (await file.exists()) return await file.json();
  } catch (error) {
    console.error("[Data] Error loading last visits data:", error);
  }
  return {};
}

// 포트 하나의 마지막 방문 시각 upsert (더 최신 값만 반영 — 동시 기록 시 과거 값으로 덮어쓰지 않음)
async function saveLastVisitData(portId: string, timestamp: number): Promise<Record<string, number>> {
  const data = await loadLastVisitsData();
  if (!data[portId] || timestamp > data[portId]) data[portId] = timestamp;
  try {
    if (!existsSync(APP_DATA_DIR)) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(APP_DATA_DIR, { recursive: true });
    }
    await Bun.write(LAST_VISITS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("[Data] Error saving last visits data:", error);
  }
  return data;
}

// 작업 루트 데이터 로드
async function loadWorkspaceRootsData() {
  try {
    const file = Bun.file(WORKSPACE_ROOTS_FILE);
    if (await file.exists()) return await file.json();
  } catch (e) { console.error("[Data] Error loading workspace roots:", e); }
  return [];
}

// 작업 루트 데이터 저장
async function saveWorkspaceRootsData(data: any) {
  try {
    if (!existsSync(APP_DATA_DIR)) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(APP_DATA_DIR, { recursive: true });
    }
    await Bun.write(WORKSPACE_ROOTS_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (e) { console.error("[Data] Error saving workspace roots:", e); return false; }
}

// Windows: 서버 시작 시 WSL distro + wt.exe 미리 감지 (첫 버튼 클릭 cold start 제거)
if (IS_WIN) {
  listWslDistros();
  windowsTerminalPath();
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const LOCAL_WEB_UI_PORT = Number(process.env.PORT) || 9000;
const nativeOAuthRelay = new NativeOAuthRelay();
const TRUSTED_WEB_ORIGINS = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  `http://localhost:${LOCAL_WEB_UI_PORT}`,
  `http://127.0.0.1:${LOCAL_WEB_UI_PORT}`,
  `http://[::1]:${LOCAL_WEB_UI_PORT}`,
  // 배포 포털은 Supabase와 직접 통신한다. localhost의 프로세스 실행 API까지
  // 기본 허용하면 포털/XSS가 ports.json을 바꾼 뒤 임의 명령을 등록할 수 있으므로 제외한다.
  // 별도 로컬 통합이 꼭 필요한 관리 환경만 PORTMGR_ALLOWED_ORIGINS로 명시 opt-in 한다.
  ...(process.env.PORTMGR_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
]);

function isAllowedApiHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

function isAllowedApiOrigin(origin: string | null): boolean {
  // Native sidecar probes and local CLI calls do not send Origin. Browser
  // callers always do, so an absent Origin is not a CORS bypass for a web page.
  if (!origin) return true;
  return TRUSTED_WEB_ORIGINS.has(origin);
}

const server = Bun.serve({
  port: Number(process.env.API_PORT) || 3001,
  hostname: "127.0.0.1",
  // 기본 10s — Orca 재시도 체인(repo add → terminal create → send → switch, 각 단계
  // 블로킹 spawnSync + 최대 3회 재시도)이 데몬 부하 시 이를 넘겨 연결이 끊길 수 있어 상향.
  idleTimeout: 90,
  async fetch(req) {
    const url = new URL(req.url);

    const requestOrigin = req.headers.get('origin');
    if (!isAllowedApiHost(req.headers.get('host')) || !isAllowedApiOrigin(requestOrigin)) {
      return new Response(JSON.stringify({
        success: false,
        code: 'LOCAL_API_ORIGIN_DENIED',
        error: '허용되지 않은 로컬 API 요청입니다.',
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Vary': 'Origin' },
      });
    }

    // 정확한 로컬/Tauri/공식 포털 Origin만 반사한다. 와일드카드 CORS는
    // 임의 웹사이트가 localhost의 명령 실행 API를 호출할 수 있게 하므로 금지한다.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (requestOrigin) headers["Access-Control-Allow-Origin"] = requestOrigin;

    // OPTIONS 요청 처리 (CORS preflight)
    if (req.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    // API 라우팅
    if (url.pathname === "/api/auth/native/start" && req.method === "POST") {
      try {
        const body = await req.json();
        nativeOAuthRelay.register(typeof body?.requestId === 'string' ? body.requestId : '');
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...headers, 'Cache-Control': 'no-store' },
        });
      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }), { status: 400, headers: { ...headers, 'Cache-Control': 'no-store' } });
      }
    }

    const nativeOAuthCallbackPrefix = "/api/auth/native/callback/";
    if (url.pathname.startsWith(nativeOAuthCallbackPrefix) && req.method === "GET") {
      let requestId = '';
      try {
        requestId = decodeURIComponent(url.pathname.slice(nativeOAuthCallbackPrefix.length));
      } catch {}
      const code = url.searchParams.get('code') ?? '';
      const providerError = url.searchParams.get('error');
      const accepted = !providerError && nativeOAuthRelay.acceptCallback(requestId, code);
      if (providerError) nativeOAuthRelay.cancel(requestId);
      const html = accepted
        ? '<!doctype html><meta charset="utf-8"><title>AgentsToZ 로그인 완료</title><body style="font:16px system-ui;background:#0a0a0b;color:#f4f4f5;padding:40px"><h1>로그인 완료</h1><p>AgentsToZ_byCS 앱으로 돌아가세요. 이 창은 닫아도 됩니다.</p></body>'
        : '<!doctype html><meta charset="utf-8"><title>AgentsToZ 로그인 실패</title><body style="font:16px system-ui;background:#0a0a0b;color:#f4f4f5;padding:40px"><h1>로그인 실패</h1><p>요청이 만료됐거나 올바르지 않습니다. 앱에서 다시 시도하세요.</p></body>';
      return new Response(html, {
        status: accepted ? 200 : 400,
        headers: {
          ...headers,
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        },
      });
    }

    if (url.pathname === "/api/auth/native/result" && req.method === "GET") {
      const code = nativeOAuthRelay.consume(url.searchParams.get('request') ?? '');
      return new Response(JSON.stringify(code ? { success: true, code } : { success: false, pending: true }), {
        status: code ? 200 : 202,
        headers: { ...headers, 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === "/api/health" && req.method === "GET") {
      return new Response(JSON.stringify({
        ok: true,
        service: "agentstoz-api",
        // 3: context sessions also carry a separately resolved project/title
        // identity and relocation state. The app adopts whatever already
        // answers on this port, so a sidecar left running by a previous version
        // keeps serving old answers under a new UI — the UI compares this number
        // and says so instead of looking broken.
        schemaVersion: CONTEXT_API_SCHEMA_VERSION,
        capabilities: contextApiCapabilities(
          PROJECT_MEMORY_FEEDBACK_PROMOTION_ENABLED,
          process.platform,
          windowsProcessSupervisorAvailable(),
        ),
        disabledCapabilities: disabledContextApiCapabilities(
          PROJECT_MEMORY_FEEDBACK_PROMOTION_ENABLED,
          process.platform,
          windowsProcessSupervisorAvailable(),
        ),
      }), { headers });
    }

    if (url.pathname === "/api/ports" && req.method === "GET") {
      try {
        const data = await loadPortsData();
        return new Response(JSON.stringify(data), { headers });
      } catch (error: any) {
        console.error("[API] Error loading ports:", error);
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers }
        );
      }
    }

    if (url.pathname === "/api/ports/merge" && req.method === "POST") {
      try {
        const body = await req.json();
        const request: PortsSaveRequest = {
          ports: body?.ports,
          basePorts: body?.basePorts,
          source: body?.source,
        };
        if (!Array.isArray(request.ports)) {
          return new Response(
            JSON.stringify({ error: "ports must be an array" }),
            { status: 400, headers },
          );
        }
        const ports = await savePortsData(request);
        return new Response(
          JSON.stringify({ success: true, count: ports.length }),
          { headers },
        );
      } catch (error: any) {
        console.error("[API] Error saving ports:", error);
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers }
        );
      }
    }

    if (url.pathname === "/api/ports" && req.method === "POST") {
      try {
        const body = await req.json();
        if (!Array.isArray(body)) {
          return new Response(
            JSON.stringify({ error: "legacy /api/ports expects an array" }),
            { status: 400, headers },
          );
        }
        const ports = await savePortsData({ ports: body, source: 'legacy-client' });
        return new Response(JSON.stringify({ success: true, count: ports.length }), { headers });
      } catch (error: any) {
        console.error("[API] Error saving legacy ports:", error);
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers },
        );
      }
    }

    if (url.pathname === "/api/last-visits" && req.method === "GET") {
      try {
        const data = await loadLastVisitsData();
        return new Response(JSON.stringify(data), { headers });
      } catch (error: any) {
        console.error("[API] Error loading last visits:", error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/last-visits" && req.method === "POST") {
      try {
        const { portId, timestamp } = await req.json();
        if (!portId || typeof timestamp !== "number") {
          return new Response(JSON.stringify({ error: "Missing portId or timestamp" }), { status: 400, headers });
        }
        const data = await saveLastVisitData(portId, timestamp);
        return new Response(JSON.stringify(data), { headers });
      } catch (error: any) {
        console.error("[API] Error saving last visit:", error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    // ──────────────── 프로젝트 로컬 장기기억 + Supabase 리비전 백업 ────────────────
    if (url.pathname === "/api/project-memory/register-project" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        const result = await registerProjectMemoryProject({
          folderPath: body.folderPath,
          projectName: typeof body.projectName === "string" ? body.projectName : undefined,
        });
        return new Response(JSON.stringify(result), { headers });
      } catch (error: any) {
        const status = error?.code === "PROJECT_REGISTRATION_AMBIGUOUS" ? 409 : 400;
        return new Response(JSON.stringify({ ok: false, error: error.message, code: error.code }), { status, headers });
      }
    }

    if (url.pathname === "/api/project-memory/thread/create" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        const route = projectMemoryThreadRoute(body);
        if (route.platform !== "telegram" || !route.chatId || !route.threadId) {
          return new Response(JSON.stringify({
            ok: false,
            code: "PROJECT_MEMORY_TOPIC_REQUIRED",
            error: "새 독립 장기기억은 Telegram DM topic에서만 만들 수 있습니다.",
          }), { status: 400, headers });
        }
        const existing = await getProjectMemoryThreadBinding(PROJECT_MEMORY_THREAD_BINDINGS_FILE, route);
        if (existing) {
          return new Response(JSON.stringify({
            ok: false,
            code: "PROJECT_MEMORY_THREAD_BINDING_EXISTS",
            error: "현재 Telegram topic은 이미 장기기억과 연결되어 있습니다. /memory_unlink 후 새 기억을 만드세요.",
            binding: existing,
          }), { status: 409, headers });
        }

        const requestedName = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
        const projectName = (requestedName || `Telegram topic ${route.threadId}`).slice(0, 120);
        const projectId = `telegram-memory-${crypto.randomUUID()}`;
        const folderPath = join(STANDALONE_PROJECT_MEMORIES_DIR, projectId);
        mkdirSync(STANDALONE_PROJECT_MEMORIES_DIR, { recursive: true });
        mkdirSync(folderPath, { recursive: false });

        let memory;
        try {
          memory = initializeProjectMemory({
            folderPath,
            projectName,
            agent: body.agent === "codex" ? "codex" : "claude",
            autoBackup: true,
          });
          const registered = await readPortsFileStrict();
          await savePortsData({
            basePorts: registered,
            ports: [...registered, {
              id: projectId,
              name: projectName,
              folderPath: memory.projectRoot,
              category: "장기기억",
              description: "Telegram DM topic에서 생성한 독립 장기기억",
            } as PortRecord],
            source: "project-memory-thread-create",
          });
        } catch (error) {
          rmSync(folderPath, { recursive: true, force: true });
          throw error;
        }

        const binding = await bindProjectMemoryThread(PROJECT_MEMORY_THREAD_BINDINGS_FILE, {
          ...route,
          projectId,
          projectName,
          memoryId: memory.config!.memoryId,
          canonicalPath: memory.projectRoot,
        });
        try {
          const backup = await pushProjectMemory({
            portalDataFile: PORTAL_DATA_FILE,
            folderPath: memory.projectRoot,
            projectName,
          });
          const supabaseSaved = backup.success === true && backup.contentBackedUp === true;
          return new Response(JSON.stringify({
            ok: supabaseSaved,
            created: true,
            localCreated: true,
            supabaseSaved,
            binding,
            backup,
          }), { status: supabaseSaved ? 200 : 502, headers });
        } catch (error: any) {
          return new Response(JSON.stringify({
            ok: false,
            created: true,
            localCreated: true,
            supabaseSaved: false,
            binding,
            code: error?.code,
            error: error?.message ?? String(error),
          }), { status: 502, headers });
        }
      } catch (error: any) {
        return new Response(JSON.stringify({ ok: false, error: error.message, code: error.code }), { status: 400, headers });
      }
    }

    // `/project_start` — 작업 루트 아래에 **사람이 읽는 이름의 실제 프로젝트 폴더**를 만든다.
    // thread/create 와의 차이는 위치뿐이다: 저쪽은 앱 데이터 폴더 아래 uuid 폴더라 코드를
    // 둘 수 없고, 이쪽은 사용자가 등록한 작업 루트 아래라 그 폴더에서 바로 작업할 수 있다.
    if (url.pathname === "/api/project-memory/thread/create-project" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        const route = projectMemoryThreadRoute(body);
        if (route.platform !== "telegram" || !route.chatId || !route.threadId) {
          return new Response(JSON.stringify({
            ok: false,
            code: "PROJECT_MEMORY_TOPIC_REQUIRED",
            error: "새 프로젝트는 Telegram DM topic에서만 만들 수 있습니다.",
          }), { status: 400, headers });
        }
        const existing = await getProjectMemoryThreadBinding(PROJECT_MEMORY_THREAD_BINDINGS_FILE, route);
        if (existing) {
          return new Response(JSON.stringify({
            ok: false,
            code: "PROJECT_MEMORY_THREAD_BINDING_EXISTS",
            error: "현재 Telegram topic은 이미 장기기억과 연결되어 있습니다. /memory_unlink 후 다시 시도하세요.",
            binding: existing,
          }), { status: 409, headers });
        }

        const roots = await loadWorkspaceRootsData();
        const target = resolveProjectStartTarget({
          name: typeof body.name === "string" ? body.name : "",
          rootPath: typeof body.rootPath === "string" ? body.rootPath : null,
          roots: Array.isArray(roots) ? roots : [],
          homeDir: homedir(),
        });
        // 루트를 고르지 못한 상태는 실패가 아니라 **되물어야 하는 상태**다. 스킬이 이
        // 목록을 그대로 보여주고 사용자의 선택을 받아 다시 호출한다.
        if (target.status === "need-root") {
          return new Response(JSON.stringify({
            ok: false, code: "PROJECT_START_ROOT_REQUIRED", needsRoot: true, roots: target.roots,
            error: "작업 루트를 골라 주세요.",
          }), { status: 409, headers });
        }
        if (target.status !== "ok") {
          return new Response(JSON.stringify({ ok: false, code: target.code, error: target.error }), { status: 400, headers });
        }
        if (existsSync(target.folderPath)) {
          return new Response(JSON.stringify({
            ok: false, code: "PROJECT_START_FOLDER_EXISTS",
            error: `이미 있는 폴더입니다: ${target.folderPath}`, folderPath: target.folderPath,
          }), { status: 409, headers });
        }

        const projectName = target.folderName;
        const projectId = `telegram-project-${crypto.randomUUID()}`;
        // 루트가 하나도 없는 headless 호스트의 기본값은 ~/projects/<name> 이다.
        // 새 AWS 계정에는 ~/projects 자체가 없는 것이 정상인데, 자식만 non-recursive로
        // 만들면 /project_start의 가장 중요한 첫 실행이 ENOENT로 실패한다. 사용자가
        // 등록한/지정한 루트는 기존 경로여야 하지만, 서버가 고른 기본 루트만 여기서 만든다.
        if (target.rootWasDefaulted && !existsSync(target.rootPath)) {
          mkdirSync(target.rootPath, { recursive: true });
        }
        mkdirSync(target.folderPath, { recursive: false });

        // 앱의 「새 프로젝트」와 같은 순서로 만든다: 폴더 → git(초기 커밋 + 저장소 워크플로)
        // → 등록 → 장기기억. git 없이 폴더만 두면 이 앱의 절반이 동작하지 않는다 —
        // 워크트리·커밋 활동 기반 유휴 판정·정리 검토가 전부 저장소를 전제한다.
        // 초기 커밋은 `--allow-empty`라 빈 폴더에서도 성립한다.
        let git: { initialized: boolean; hasCommit: boolean; error?: string; repositoryWorkflow?: unknown } = {
          initialized: false, hasCommit: false,
        };
        try {
          const initProc = Bun.spawn([GIT_PATH, "init"], { cwd: target.folderPath, stdout: "pipe", stderr: "pipe" });
          await initProc.exited;
          if (initProc.exitCode !== 0) {
            git.error = (await new Response(initProc.stderr).text()).trim() || "git init failed";
          } else {
            git.initialized = true;
            const snapshot = await createInitialSnapshotCommit(target.folderPath);
            git.hasCommit = snapshot.success;
            if (!snapshot.success) git.error = snapshot.error;
            // 앱과 같이 **커밋이 있을 때만** 워크플로를 얹는다.
            else git.repositoryWorkflow = upgradeRepositoryWorkflow(target.folderPath);
          }
        } catch (error: any) {
          // git 실패가 프로젝트 생성을 되돌리지는 않는다. 폴더와 기억은 그대로 쓸모가 있고,
          // 사용자는 나중에 앱에서 「Git 저장소 만들기」로 채울 수 있다. 대신 결과에 실어 보낸다.
          git.error = error?.message ?? String(error);
        }

        let memory;
        try {
          memory = initializeProjectMemory({
            folderPath: target.folderPath,
            projectName,
            agent: body.agent === "codex" ? "codex" : "claude",
            autoBackup: true,
          });
          const registered = await readPortsFileStrict();
          await savePortsData({
            basePorts: registered,
            ports: [...registered, {
              id: projectId,
              name: projectName,
              folderPath: memory.projectRoot,
              description: "Telegram DM topic에서 만든 프로젝트",
            } as PortRecord],
            source: "project-memory-thread-create-project",
          });
          // 방금 만든 프로젝트를 "활동 기록 없음"으로 두지 않는다. 유휴/오래됨 판정은
          // max(방문, git 활동)을 보므로, 기록이 없으면 갓 만든 프로젝트가 정리 검토의
          // 삭제 후보로 올라올 수 있다.
          await saveLastVisitData(projectId, Date.now());
        } catch (error) {
          // 방금 우리가 만든 폴더만 되돌린다. 위에서 기존 폴더를 이미 거절했으므로
          // 사용자의 기존 작업을 지울 수 없다.
          rmSync(target.folderPath, { recursive: true, force: true });
          throw error;
        }

        const binding = await bindProjectMemoryThread(PROJECT_MEMORY_THREAD_BINDINGS_FILE, {
          ...route,
          projectId,
          projectName,
          memoryId: memory.config!.memoryId,
          canonicalPath: memory.projectRoot,
        });
        try {
          const backup = await pushProjectMemory({
            portalDataFile: PORTAL_DATA_FILE,
            folderPath: memory.projectRoot,
            projectName,
          });
          const supabaseSaved = backup.success === true && backup.contentBackedUp === true;
          return new Response(JSON.stringify({
            ok: supabaseSaved, created: true, localCreated: true, supabaseSaved,
            folderPath: memory.projectRoot, rootPath: target.rootPath,
            rootWasDefaulted: target.rootWasDefaulted, git, binding, backup,
          }), { status: supabaseSaved ? 200 : 502, headers });
        } catch (error: any) {
          return new Response(JSON.stringify({
            ok: false, created: true, localCreated: true, supabaseSaved: false,
            folderPath: memory.projectRoot, rootPath: target.rootPath,
            rootWasDefaulted: target.rootWasDefaulted, git, binding,
            code: error?.code, error: error?.message ?? String(error),
          }), { status: 502, headers });
        }
      } catch (error: any) {
        return new Response(JSON.stringify({ ok: false, error: error.message, code: error.code }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/thread/start" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        const registered = await loadPortsData() as Array<PortRecord & {
          name?: string;
          folderPath?: string;
          worktreePath?: string;
        }>;
        const resolution = resolveRegisteredProjectMemory(
          typeof body.project === "string" ? body.project : "",
          registered,
          alias => {
            const candidate = detectProjectMemory(alias);
            return candidate.exists && candidate.config ? candidate.projectRoot : null;
          },
          { requireInitialized: false },
        );
        if ("code" in resolution) {
          return new Response(JSON.stringify(resolution), {
            status: resolution.code === "PROJECT_AMBIGUOUS" ? 409 : 404,
            headers,
          });
        }
        const route = projectMemoryThreadRoute(body);
        const existing = await getProjectMemoryThreadBinding(PROJECT_MEMORY_THREAD_BINDINGS_FILE, route);
        if (existing && existing.projectId !== resolution.id) {
          return new Response(JSON.stringify({
            ok: false,
            code: "PROJECT_MEMORY_THREAD_BINDING_EXISTS",
            error: "현재 Telegram topic은 이미 다른 프로젝트와 연결되어 있습니다. /memory_unlink 후 다시 연결하세요.",
            binding: existing,
          }), { status: 409, headers });
        }
        let status = detectProjectMemory(resolution.canonicalPath);
        const initialized = !status.exists || !status.config;
        if (initialized) {
          status = initializeProjectMemory({
            folderPath: resolution.canonicalPath,
            projectName: resolution.name,
            agent: body.agent === "codex" ? "codex" : "claude",
            autoBackup: body.autoBackup !== false,
          });
        }
        if (!status.config?.memoryId) throw new Error("초기화 후 장기기억 ID를 찾지 못했습니다.");
        const binding = await bindProjectMemoryThread(PROJECT_MEMORY_THREAD_BINDINGS_FILE, {
          ...route,
          projectId: resolution.id,
          projectName: resolution.name,
          memoryId: status.config.memoryId,
          canonicalPath: status.projectRoot,
        });
        return new Response(JSON.stringify({ ok: true, initialized, binding }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ ok: false, error: error.message, code: error.code }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/thread/status" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        const { binding, status } = await verifiedProjectMemoryThreadBinding(body);
        return new Response(JSON.stringify({
          ok: true,
          binding,
          memory: {
            exists: status.exists,
            contentHash: status.contentHash ?? null,
            lastSyncedHash: status.config?.lastSyncedHash ?? null,
            autoBackup: status.config?.autoBackup !== false,
            needsRemember: status.activity.needsRemember,
          },
        }), { headers });
      } catch (error: any) {
        const status = error?.code === "PROJECT_MEMORY_THREAD_NOT_BOUND" ? 404 : error?.code === "PROJECT_MEMORY_THREAD_IDENTITY_MISMATCH" ? 409 : 400;
        return new Response(JSON.stringify({ ok: false, error: error.message, code: error.code }), { status, headers });
      }
    }

    if (url.pathname === "/api/project-memory/thread/stop" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        const removed = await unbindProjectMemoryThread(
          PROJECT_MEMORY_THREAD_BINDINGS_FILE,
          projectMemoryThreadRoute(body),
        );
        return new Response(JSON.stringify({ ok: true, removed }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ ok: false, error: error.message, code: error.code }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/thread/sync" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        const { binding, status } = await verifiedProjectMemoryThreadBinding(body);
        const remote = await remoteProjectMemoryStatus({
          portalDataFile: PORTAL_DATA_FILE,
          folderPath: binding.canonicalPath,
        });
        const direction = resolveProjectMemorySyncDirection({
          localExists: status.exists,
          localUpdatedAt: status.modifiedAt || status.config?.lastUpdatedAt || null,
          localContentHash: status.contentHash ?? null,
          lastSyncedHash: status.config?.lastSyncedHash ?? null,
          autoBackup: true,
          remote: { kind: "ready", status: remote },
        });
        if (direction === "conflict") {
          const result = await pullProjectMemory({
            portalDataFile: PORTAL_DATA_FILE,
            folderPath: binding.canonicalPath,
            projectName: binding.projectName,
          });
          return new Response(JSON.stringify({ ...result, ok: false, binding, direction, action: "none", conflict: true }), { status: 409, headers });
        }
        if (direction === "synced") {
          return new Response(JSON.stringify({ ok: true, binding, direction, action: "none", remote }), { headers });
        }
        if (direction === "push") {
          const result = await pushProjectMemory({
            portalDataFile: PORTAL_DATA_FILE,
            folderPath: binding.canonicalPath,
            projectName: binding.projectName,
          });
          return new Response(JSON.stringify({ ok: result.success === true, binding, direction, action: "push", result }), {
            status: (result as any).conflict ? 409 : result.success === true ? 200 : 502,
            headers,
          });
        }
        if (direction === "pull") {
          const result = await pullProjectMemory({
            portalDataFile: PORTAL_DATA_FILE,
            folderPath: binding.canonicalPath,
            projectName: binding.projectName,
          });
          return new Response(JSON.stringify({ ok: result.success === true, binding, direction, action: "pull", result }), {
            status: (result as any).conflict ? 409 : result.success === true ? 200 : 502,
            headers,
          });
        }
        return new Response(JSON.stringify({ ok: false, binding, direction, action: "none", error: "동기화 방향을 안전하게 결정하지 못했습니다." }), { status: 409, headers });
      } catch (error: any) {
        const status = error?.code === "PROJECT_MEMORY_THREAD_NOT_BOUND" ? 404 : error?.code === "PROJECT_MEMORY_THREAD_IDENTITY_MISMATCH" ? 409 : 500;
        return new Response(JSON.stringify({ ok: false, error: error.message, code: error.code }), { status, headers });
      }
    }

    if (url.pathname === "/api/project-memory/sync" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        const local = detectProjectMemory(body.folderPath);
        if (!local.exists || !local.config) {
          return new Response(JSON.stringify({ ok: false, code: "PROJECT_MEMORY_NOT_INITIALIZED", error: "프로젝트 장기기억이 초기화되지 않았습니다." }), { status: 404, headers });
        }
        const remote = await remoteProjectMemoryStatus({
          portalDataFile: PORTAL_DATA_FILE,
          folderPath: local.projectRoot,
          githubUrl: body.githubUrl,
        });
        const direction = resolveProjectMemorySyncDirection({
          localExists: true,
          localUpdatedAt: local.modifiedAt || local.config.lastUpdatedAt || null,
          localContentHash: local.contentHash ?? null,
          lastSyncedHash: local.config.lastSyncedHash ?? null,
          autoBackup: true,
          remote: { kind: "ready", status: remote },
        });
        if (direction === "conflict") {
          const result = await pullProjectMemory({
            portalDataFile: PORTAL_DATA_FILE,
            folderPath: local.projectRoot,
            projectName: body.projectName,
            githubUrl: body.githubUrl,
          });
          return new Response(JSON.stringify({ ...result, ok: false, direction, action: "none", conflict: true }), { status: 409, headers });
        }
        if (direction === "synced") {
          return new Response(JSON.stringify({ ok: true, direction, action: "none", remote }), { headers });
        }
        if (direction === "push") {
          const result = await pushProjectMemory({
            portalDataFile: PORTAL_DATA_FILE,
            folderPath: local.projectRoot,
            projectName: body.projectName,
            githubUrl: body.githubUrl,
          });
          return new Response(JSON.stringify({ ok: result.success === true, direction, action: "push", result }), {
            status: (result as any).conflict ? 409 : result.success === true ? 200 : 502,
            headers,
          });
        }
        if (direction === "pull") {
          const result = await pullProjectMemory({
            portalDataFile: PORTAL_DATA_FILE,
            folderPath: local.projectRoot,
            projectName: body.projectName,
            githubUrl: body.githubUrl,
          });
          return new Response(JSON.stringify({ ok: result.success === true, direction, action: "pull", result }), {
            status: (result as any).conflict ? 409 : result.success === true ? 200 : 502,
            headers,
          });
        }
        return new Response(JSON.stringify({ ok: false, direction, action: "none", error: "동기화 방향을 안전하게 결정하지 못했습니다." }), { status: 409, headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ ok: false, error: error.message, code: error.code }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/project-memory/resolve-project" && req.method === "POST") {
      try {
        const body = await req.json() as { project?: unknown };
        const registered = await loadPortsData() as Array<PortRecord & {
          name?: string;
          folderPath?: string;
          worktreePath?: string;
        }>;
        const resolution = resolveRegisteredProjectMemory(
          typeof body.project === "string" ? body.project : "",
          registered,
          alias => {
            const candidate = detectProjectMemory(alias);
            return candidate.exists && candidate.config ? candidate.projectRoot : null;
          },
        );
        if ("code" in resolution) {
          return new Response(JSON.stringify(resolution), {
            status: resolution.code === "PROJECT_AMBIGUOUS" ? 409 : 404,
            headers,
          });
        }
        const status = detectProjectMemory(resolution.canonicalPath);
        if (!status.exists || !status.config) {
          return new Response(JSON.stringify({
            ok: false,
            code: "PROJECT_MEMORY_NOT_INITIALIZED",
            error: "등록된 프로젝트이지만 장기기억이 초기화되지 않았습니다.",
            candidates: [{ id: resolution.id, name: resolution.name, path: resolution.canonicalPath }],
          }), { status: 409, headers });
        }
        return new Response(JSON.stringify({
          ...resolution,
          canonicalPath: resolution.canonicalPath,
          memoryId: status.config.memoryId,
          agent: status.config.agent,
          autoBackup: status.config.autoBackup,
        }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/memory-ids" && req.method === "POST") {
      try {
        const body = await req.json() as { folderPaths?: unknown };
        const paths = Array.isArray(body.folderPaths)
          ? body.folderPaths.filter((value): value is string => typeof value === "string" && !!value.trim())
          : [];
        // Push 는 폴더 하나당 왕복하면 안 된다 — 프로젝트가 100개를 넘는 기기가 있다.
        // 로컬 config 를 읽는 것뿐이라 한 번에 처리해도 싸다.
        const result: Record<string, string | null> = {};
        for (const folderPath of paths) {
          try {
            const status = detectProjectMemory(folderPath);
            result[folderPath] = status.exists ? (status.config?.memoryId ?? null) : null;
          } catch {
            // 폴더가 사라졌거나 읽을 수 없는 경우 — 그 프로젝트만 비워 두고 계속한다.
            result[folderPath] = null;
          }
        }
        return new Response(JSON.stringify({ memoryIds: result }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/detect" && req.method === "POST") {
      try {
        const { folderPath } = await readMemoryParams(req, url);
        return new Response(JSON.stringify(detectProjectMemory(folderPath)), { headers });
      } catch (error: any) {
        // Keep the code so the client can distinguish a folder that is gone
        // for good from a failure that is worth retrying.
        return new Response(JSON.stringify({ error: error.message, code: error.code }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/init" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        const result = initializeProjectMemory({
          folderPath: body.folderPath,
          projectName: body.projectName,
          agent: body.agent === "codex" ? "codex" : "claude",
          autoBackup: body.autoBackup !== false,
          memoryId: typeof body.memoryId === "string" ? body.memoryId : null,
        });
        return new Response(JSON.stringify(result), { headers });
      } catch (error: any) {
        // 붙여넣은 ID가 틀렸다는 것은 재시도 가능한 사용자 입력 오류다. 코드를 실어
        // 프런트가 "형식이 아님"과 "이미 다른 기억이 있음"을 구분해 안내하게 한다.
        return new Response(JSON.stringify({ error: error.message, code: error.code }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/update" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const result = await updateProjectMemory({
          folderPath: body.folderPath,
          projectName: body.projectName,
          agent: (body.agent === "codex" ? "codex" : "claude") as ProjectMemoryAgent,
        });
        return new Response(JSON.stringify(result), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/project-memory/upgrade-agent" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const result = upgradeProjectMemoryAgent({ folderPath: body.folderPath });
        return new Response(JSON.stringify(result), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    // ── Supabase service_role 키 ────────────────────────────────────────────
    // v9 마이그레이션(20260812000200)이 장기기억 테이블의 쓰기 권한을 service_role
    // 하나로 좁혔다. 그래서 이 키가 없으면 장기기억 Push/Pull이 전부 401이 된다.
    // 키는 portal.json에 넣지 않는다 — /api/portal 응답으로 나가면 웹 번들에 실린다.
    if (url.pathname === "/api/supabase-service-key" && req.method === "GET") {
      const fromEnv = !!(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
      const path = serviceRoleKeyPath(APP_DATA_DIR);
      return new Response(JSON.stringify({
        // 값은 절대 돌려주지 않는다. 있는지 여부만 알려준다.
        present: !!loadServiceRoleKey(APP_DATA_DIR),
        source: fromEnv ? "env" : existsSync(path) ? "file" : null,
        path,
      }), { headers });
    }

    if (url.pathname === "/api/supabase-service-key" && req.method === "POST") {
      try {
        const body = await req.json() as { serviceRoleKey?: unknown };
        const key = typeof body.serviceRoleKey === "string" ? body.serviceRoleKey.trim() : "";
        const path = serviceRoleKeyPath(APP_DATA_DIR);
        if (!key) {
          // 빈 값 = 삭제. 잘못 넣은 키를 앱 안에서 되돌릴 수 있어야 한다.
          if (existsSync(path)) unlinkSync(path);
          return new Response(JSON.stringify({ saved: true, present: false }), { headers });
        }
        const anonKey = existsSync(PORTAL_DATA_FILE)
          ? (JSON.parse(readFileSync(PORTAL_DATA_FILE, "utf8"))?.supabaseAnonKey ?? "")
          : "";
        // 가장 흔한 실수는 대시보드에서 anon 키를 복사해 오는 것이다. 그 값은 지금도
        // 이미 갖고 있으므로 저장해봐야 같은 401이 반복된다 — 저장 시점에 막는다.
        if (key === anonKey) {
          return new Response(JSON.stringify({
            error: "anon 키가 입력됐습니다. Supabase 대시보드의 service_role(secret) 키가 필요합니다.",
          }), { status: 400, headers });
        }
        mkdirSync(dirname(path), { recursive: true });
        // 최종 위치에 넓은 권한으로 존재하는 순간이 없도록 임시 파일에 쓰고 권한을 좁힌 뒤 옮긴다.
        const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
        writeFileSync(tmp, `${JSON.stringify({ serviceRoleKey: key })}\n`, { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, path);
        return new Response(JSON.stringify({ saved: true, present: true, path }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    // 이미 로그인·링크된 Supabase CLI에게 키를 물어본다. 대시보드를 열어 복사하는
    // 단계가 통째로 사라지고, 키가 브라우저를 거치지 않아 붙여넣기보다 노출면도 좁다.
    if (url.pathname === "/api/supabase-service-key/from-cli" && req.method === "POST") {
      try {
        const portal = existsSync(PORTAL_DATA_FILE)
          ? JSON.parse(readFileSync(PORTAL_DATA_FILE, "utf8"))
          : {};
        const ref = supabaseProjectRefFromUrl(portal?.supabaseUrl);
        if (!ref) {
          return new Response(JSON.stringify({
            error: "Supabase URL에서 프로젝트 ref를 읽지 못했습니다. 설정의 Supabase URL을 확인하세요.",
          }), { status: 400, headers });
        }
        let cli: string;
        try {
          cli = resolveSupabaseCli();
        } catch {
          return new Response(JSON.stringify({
            error: "이 PC에서 Supabase CLI를 찾지 못했습니다. 설치 후 다시 시도하거나 키를 직접 붙여넣으세요.",
            code: "SUPABASE_CLI_NOT_FOUND",
          }), { status: 409, headers });
        }
        const run = Bun.spawnSync([cli, "projects", "api-keys", "--project-ref", ref, "-o", "json"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        if (run.exitCode !== 0) {
          return new Response(JSON.stringify({
            error: describeSupabaseCliFailure(run.stderr.toString(), run.exitCode ?? 1),
          }), { status: 400, headers });
        }
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(run.stdout.toString());
        } catch {
          return new Response(JSON.stringify({ error: "Supabase CLI 응답을 해석하지 못했습니다." }), { status: 400, headers });
        }
        const key = selectServiceRoleKey(parsed);
        if (!key) {
          return new Response(JSON.stringify({
            error: "CLI 응답에 service_role(secret) 키가 없습니다. 키를 직접 붙여넣으세요.",
          }), { status: 400, headers });
        }
        const path = serviceRoleKeyPath(APP_DATA_DIR);
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
        writeFileSync(tmp, `${JSON.stringify({ serviceRoleKey: key })}\n`, { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, path);
        // 키 자체는 응답에 싣지 않는다.
        return new Response(JSON.stringify({ saved: true, present: true, source: "cli", projectRef: ref }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    // Hermes의 `/remember_session`·`/memory_*`는 기기당 하나인 게이트웨이 명령이라
    // 프로젝트별 어댑터와 달리 folderPath를 받지 않는다.
    if (url.pathname === "/api/project-memory/hermes-adapter" && (req.method === "POST" || req.method === "GET")) {
      try {
        return new Response(JSON.stringify(detectHermesProjectMemoryAdapter({ hermesCliPath: hermesCliPath() })), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/install-hermes-adapter" && req.method === "POST") {
      try {
        return new Response(
          JSON.stringify({ ok: true, ...installHermesProjectMemoryAdapter({ hermesCliPath: hermesCliPath() }) }),
          { headers },
        );
      } catch (error: any) {
        return new Response(
          JSON.stringify({ error: error.message, code: error.code }),
          { status: error.code === "HERMES_NOT_INSTALLED" ? 409 : 400, headers },
        );
      }
    }

    // ── 버전이 붙은 기능의 일괄 갱신 ────────────────────────────────────────
    // 장기기억 에이전트와 저장소 워크플로는 둘 다 installed/current 버전을 갖는다.
    // 기능을 개선해 버전을 올리면 이미 설치된 프로젝트 전부가 한꺼번에 뒤처지는데,
    // 갱신 버튼은 프로젝트 패널 안에만 있어서 실측 66건(기억 30 + 워크플로 36)을
    // 갱신하려면 패널을 66번 열어야 했다. 상태 조회와 갱신을 모두 서버에서 한 번에
    // 돌려 왕복 94회를 1회로 줄인다.
    if (url.pathname === "/api/upgrade-status" && req.method === "POST") {
      try {
        const body = await req.json() as { folderPaths?: unknown; githubMissing?: unknown };
        const folderPaths = Array.isArray(body.folderPaths)
          ? [...new Set(body.folderPaths.filter((p): p is string => typeof p === "string" && isAbsolute(p)))]
          : [];
        // 이 스윕은 이미 모든 프로젝트 폴더를 방문한다. GitHub 주소가 비어 있는 폴더의
        // origin을 같은 자리에서 함께 읽어, 프로젝트마다 왕복하는 스캔을 새로 만들지 않는다.
        const githubMissing = Array.isArray(body.githubMissing)
          ? [...new Set(body.githubMissing.filter((p): p is string => typeof p === "string" && isAbsolute(p)))]
          : [];
        const github: Array<{ folderPath: string; remoteUrl: string }> = [];
        for (const folderPath of githubMissing) {
          if (!existsSync(folderPath)) continue;
          try {
            const origin = await runGitForStatus(folderPath, ["remote", "get-url", "origin"]);
            const url = origin.ok ? origin.stdout.trim() : "";
            if (url && isGitHubRemoteUrl(url)) github.push({ folderPath, remoteUrl: url });
          } catch { /* 이 폴더의 remote 조회만 건너뛴다 */ }
        }
        const memory: Array<{ folderPath: string; installedVersion: number; currentVersion: number }> = [];
        const workflow: Array<{ folderPath: string; installedVersion: number; currentVersion: number }> = [];
        const missing: string[] = [];
        for (const folderPath of folderPaths) {
          // A folder that is gone is reported, not silently dropped: a count the
          // user cannot reconcile with their project list reads as a bug.
          if (!existsSync(folderPath)) { missing.push(folderPath); continue; }
          try {
            const status = detectProjectMemory(folderPath);
            if (status.exists && status.memoryAgent?.updateAvailable) {
              memory.push({
                folderPath,
                installedVersion: status.memoryAgent.installedVersion,
                currentVersion: status.memoryAgent.currentVersion,
              });
            }
          } catch { /* 이 폴더의 기억 상태만 건너뛴다 */ }
          try {
            const status = detectRepositoryWorkflow(folderPath);
            if (status.isGit && status.updateAvailable) {
              workflow.push({
                folderPath,
                installedVersion: status.installedVersion,
                currentVersion: status.currentVersion,
              });
            }
          } catch { /* 이 폴더의 워크플로 상태만 건너뛴다 */ }
        }
        // Hermes 어댑터는 프로젝트당이 아니라 기기당 하나다. 배열이 아니라 단일 항목으로
        // 싣되, 같은 스윕에서 함께 보고해야 백로그 배지가 이 항목을 빠뜨리지 않는다.
        let hermes: { installedVersion: number; currentVersion: number } | null = null;
        try {
          const status = detectHermesProjectMemoryAdapter({ hermesCliPath: hermesCliPath() });
          if (status.hermesPresent && status.updateAvailable) {
            hermes = { installedVersion: status.installedVersion, currentVersion: status.currentVersion };
          }
        } catch { /* Hermes 상태 실패가 프로젝트 스윕 결과를 버리게 두지 않는다 */ }
        return new Response(JSON.stringify({ memory, workflow, hermes, github, missing, checked: folderPaths.length }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/upgrade-batch" && req.method === "POST") {
      try {
        const body = await req.json() as { folderPaths?: unknown; target?: unknown };
        const target = body.target === "workflow"
          ? "workflow"
          : body.target === "memory"
            ? "memory"
            : body.target === "hermes" ? "hermes" : null;
        if (!target) {
          return new Response(JSON.stringify({ error: "target은 'memory', 'workflow', 'hermes' 중 하나여야 합니다." }), { status: 400, headers });
        }
        // 기기당 하나뿐이라 folderPaths를 쓰지 않는다.
        if (target === "hermes") {
          try {
            installHermesProjectMemoryAdapter({ hermesCliPath: hermesCliPath() });
            return new Response(JSON.stringify({ target, upgraded: 1, failed: 0, results: [] }), { headers });
          } catch (error: any) {
            return new Response(JSON.stringify({
              target, upgraded: 0, failed: 1, results: [], error: error?.message || String(error),
            }), { headers });
          }
        }
        const folderPaths = Array.isArray(body.folderPaths)
          ? [...new Set(body.folderPaths.filter((p): p is string => typeof p === "string" && isAbsolute(p)))]
          : [];
        // Serial on purpose: both upgrades do synchronous filesystem work and
        // write generated files into the user's repositories.
        const results: Array<{ folderPath: string; ok: boolean; error?: string }> = [];
        for (const folderPath of folderPaths) {
          try {
            if (target === "memory") upgradeProjectMemoryAgent({ folderPath });
            else upgradeRepositoryWorkflow(folderPath);
            results.push({ folderPath, ok: true });
          } catch (error: any) {
            results.push({ folderPath, ok: false, error: error?.message || String(error) });
          }
        }
        const failed = results.filter(r => !r.ok);
        return new Response(JSON.stringify({
          target,
          upgraded: results.length - failed.length,
          failed: failed.length,
          results,
        }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/preferred-agent" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const result = setProjectMemoryPreferredAgent({
          folderPath: body.folderPath,
          agent: body.agent === "codex" ? "codex" : "claude",
        });
        return new Response(JSON.stringify(result), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/recall" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        if (typeof body.query !== "string") throw new Error("회상 query가 필요합니다.");
        const result = recallProjectMemory({
          folderPath: body.folderPath,
          query: body.query,
          limit: typeof body.limit === "number" ? body.limit : undefined,
        });
        return new Response(JSON.stringify(result), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/quality" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        return new Response(JSON.stringify(inspectProjectMemory({ folderPath: body.folderPath })), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/feedback" && req.method === "POST") {
      if (!PROJECT_MEMORY_FEEDBACK_PROMOTION_ENABLED) {
        return new Response(JSON.stringify({
          error: "프로젝트 기억 피드백 승격은 독립적인 작업·세션·결과 증거 계약이 완성될 때까지 비활성화되어 있습니다.",
          code: "PROJECT_MEMORY_FEEDBACK_DISABLED",
        }), { status: 503, headers });
      }
      try {
        const body = await readMemoryParams(req, url);
        const kinds = new Set(["applied", "confirmed", "corrected", "contradicted"]);
        if (!kinds.has(body.kind)) throw new Error("피드백 kind는 applied, confirmed, corrected, contradicted 중 하나여야 합니다.");
        const result = recordProjectMemoryFeedback({
          folderPath: body.folderPath,
          entryKey: body.entryKey,
          contentVersionHash: body.contentVersionHash,
          kind: body.kind,
          evidence: typeof body.evidence === "string" ? body.evidence : null,
          eventId: typeof body.eventId === "string" ? body.eventId : undefined,
        });
        return new Response(JSON.stringify(result), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message, code: error.code }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/mark-remembered" && req.method === "POST") {
      try {
        const body = req.headers.get("content-type")?.includes("application/json")
          ? await req.json() as any
          : {};
        const folderPath = body.folderPath ?? url.searchParams.get("folderPath");
        // The journal records commits and churn on its own, but "what was
        // learned" only exists in the session that just did the work. The agent
        // already holds it, so passing a line here costs no model call and is
        // the difference between raw material a compiler can use and a list of
        // commit subjects. Accepted from the query string too, so the documented
        // `curl --get` form can carry it.
        const narrative = body.narrative ?? url.searchParams.get("narrative");
        const result = markProjectMemoryRemembered({ folderPath, narrative });
        return new Response(JSON.stringify(result), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    // ──────────────── 버전형 Git 저장소 작업 흐름 ────────────────
    if (url.pathname === "/api/repository-workflow/status" && req.method === "POST") {
      try {
        const { folderPath } = await req.json() as any;
        return new Response(JSON.stringify(detectRepositoryWorkflow(folderPath)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/repository-workflow/upgrade" && req.method === "POST") {
      try {
        const { folderPath } = await req.json() as any;
        return new Response(JSON.stringify(upgradeRepositoryWorkflow(folderPath)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/repository-workflow/complete-first-task" && req.method === "POST") {
      try {
        const { folderPath } = await req.json() as any;
        return new Response(JSON.stringify(completeRepositoryFirstTask(folderPath)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/repository-workflow/worktree-source" && req.method === "POST") {
      try {
        const { folderPath } = await req.json() as any;
        return new Response(JSON.stringify(inspectWorktreeSource(folderPath, GIT_PATH)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/repository-workflow/worktree-launch" && req.method === "POST") {
      try {
        const { folderPath, worktreePath } = await req.json() as any;
        const status = inspectWorktreeLaunch(folderPath, worktreePath, GIT_PATH);
        // 앱이 만들지 않은 워크트리(Orca의 ~/orca/workspaces/…, 터미널에서 직접 만든 것)는
        // 생성 시점 시딩을 거치지 않아 .claude(훅·권한·스킬)와 .env가 없다. 모든 AI 실행 경로가
        // 이 검사를 공통으로 거치므로 여기서 채워 넣어야 Claude가 워크트리에서도 반쪽이 되지 않는다.
        // 이미 있는 파일은 덮어쓰지 않으므로 매 실행 호출돼도 안전(멱등).
        if (status.ready && status.mainWorktreePath !== status.targetPath) {
          seedWorktreeLocalConfig(status.mainWorktreePath, status.targetPath);
        }
        return new Response(JSON.stringify(status), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/remote-status" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        const result = await remoteProjectMemoryStatus({
          portalDataFile: PORTAL_DATA_FILE,
          folderPath: body.folderPath,
          githubUrl: body.githubUrl,
        });
        return new Response(JSON.stringify(result), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/project-memory/push" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        const result = await pushProjectMemory({
          portalDataFile: PORTAL_DATA_FILE,
          folderPath: body.folderPath,
          projectName: body.projectName,
          githubUrl: body.githubUrl,
          force: body.force === true,
        });
        return new Response(JSON.stringify(result), {
          status: (result as any).conflict ? 409 : 200,
          headers,
        });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/project-memory/pull" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        const result = await pullProjectMemory({
          portalDataFile: PORTAL_DATA_FILE,
          folderPath: body.folderPath,
          projectName: body.projectName,
          githubUrl: body.githubUrl,
          force: body.force === true,
        });
        return new Response(JSON.stringify(result), {
          status: (result as any).conflict ? 409 : 200,
          headers,
        });
      } catch (error: any) {
        // 코드를 버리면 호출자가 문구를 정규식으로 맞혀야 한다. 특히 REMOTE_BACKUP_MISSING은
        // clone 직후의 **정상 상태**라, 오류로만 보이면 Pull 먼저 시도하는 경로가 막힌다.
        return new Response(JSON.stringify({ error: error.message, code: error.code }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/project-memory/history" && req.method === "POST") {
      try {
        const body = await readMemoryParams(req, url);
        const result = await listProjectMemoryRevisions({
          portalDataFile: PORTAL_DATA_FILE,
          folderPath: body.folderPath,
          githubUrl: body.githubUrl,
        });
        return new Response(JSON.stringify({ revisions: result }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/project-memory/restore-revision" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const result = await restoreProjectMemoryRevision({
          portalDataFile: PORTAL_DATA_FILE,
          folderPath: body.folderPath,
          revisionId: body.revisionId,
          projectName: body.projectName,
        });
        return new Response(JSON.stringify(result), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/project-memory/resolve-conflict" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        if (body.strategy !== "keep-local" && body.strategy !== "use-remote" && body.strategy !== "merged") {
          return new Response(JSON.stringify({ error: "충돌 해결 방식이 올바르지 않습니다." }), { status: 400, headers });
        }
        if (body.strategy === "merged" && typeof body.mergedContent !== "string") {
          return new Response(JSON.stringify({ error: "병합할 장기기억 본문이 필요합니다." }), { status: 400, headers });
        }
        if (typeof body.expectedLocalHash !== "string" || typeof body.expectedRemoteRevisionId !== "string") {
          return new Response(JSON.stringify({ error: "비교한 로컬·원격 버전 정보가 필요합니다. 다시 비교해주세요." }), { status: 400, headers });
        }
        const result = await resolveProjectMemoryConflict({
          portalDataFile: PORTAL_DATA_FILE,
          folderPath: body.folderPath,
          projectName: body.projectName,
          githubUrl: body.githubUrl,
          strategy: body.strategy,
          mergedContent: body.strategy === "merged" ? body.mergedContent : undefined,
          expectedLocalHash: body.expectedLocalHash,
          expectedRemoteRevisionId: body.expectedRemoteRevisionId,
          expectedRemoteContentHash: typeof body.expectedRemoteContentHash === "string" ? body.expectedRemoteContentHash : null,
        });
        return new Response(JSON.stringify(result), {
          status: (result as any).conflict ? 409 : 200,
          headers,
        });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/project-memory/session-end" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const result = await sessionEndProjectMemory({
          portalDataFile: PORTAL_DATA_FILE,
          folderPath: body.folderPath,
          projectName: body.projectName,
          githubUrl: body.githubUrl,
          agent: (body.agent === "codex" ? "codex" : "claude") as ProjectMemoryAgent,
          autoBackup: body.autoBackup !== false,
          preservePreferredAgent: body.preservePreferredAgent === true,
        });
        return new Response(JSON.stringify(result), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/detect-port" && req.method === "POST") {
      try {
        const { filePath } = await req.json();

        if (!filePath) {
          return new Response(
            JSON.stringify({ error: "Missing filePath" }),
            { status: 400, headers }
          );
        }

        // 파일 읽기
        const file = Bun.file(filePath);
        if (!(await file.exists())) {
          return new Response(
            JSON.stringify({ error: "File not found" }),
            { status: 404, headers }
          );
        }

        const content = await file.text();
        let detectedPort = null;

        // localhost:포트 패턴 검색
        const localhostMatch = content.match(/localhost:(\d+)/);
        if (localhostMatch) {
          detectedPort = parseInt(localhostMatch[1]!);
        } else {
          // PORT=포트 또는 port=포트 패턴 검색
          const portMatch = content.match(/(?:PORT|port)\s*=\s*(\d+)/);
          if (portMatch) {
            detectedPort = parseInt(portMatch[1]!);
          }
        }

        // 폴더 경로 추출 (Windows \ 및 POSIX / 모두 지원)
        let folderPath = null;
        const lastSepIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
        if (lastSepIndex !== -1) {
          folderPath = filePath.substring(0, lastSepIndex);
        }

        // 프로젝트 이름 추출 (.command/.sh/.bat/.cmd/.ps1 제거)
        let projectName = null;
        if (lastSepIndex !== -1) {
          const fileName = filePath.substring(lastSepIndex + 1);
          projectName = fileName.replace(/\.(command|sh|bat|cmd|ps1)$/i, '');
        }

        devLog(`[DetectPort] File: ${filePath}, Port: ${detectedPort}, Folder: ${folderPath}, Name: ${projectName}`);

        return new Response(
          JSON.stringify({
            detectedPort,
            folderPath,
            projectName,
            commandPath: filePath
          }),
          { headers }
        );
      } catch (error: any) {
        console.error(`[DetectPort] Error:`, error);
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers }
        );
      }
    }

    // GET /api/detect-start-command?path=<folderPath>
    if (url.pathname === "/api/detect-start-command" && req.method === "GET") {
      const folderPath = url.searchParams.get('path');
      if (!folderPath) return new Response(JSON.stringify({ error: 'Missing path' }), { status: 400, headers });
      return new Response(JSON.stringify(await detectStartCommandAt(folderPath)), { headers });
    }

    if (url.pathname === "/api/execute-command" && req.method === "POST") {
      let claimedPortId: string | null = null;
      try {
        const { portId, commandPath, folderPath, port } = await req.json();

        devLog(`[Execute] Received request for portId: ${portId}, path: ${commandPath}`);

        if (!commandPath || !portId) {
          return new Response(
            JSON.stringify({ error: "Missing portId or commandPath" }),
            { status: 400, headers }
          );
        }
        if (!isSafeLogId(portId)) {
          return new Response(
            JSON.stringify({
              code: "INVALID_PORT_ID",
              error: "portId는 1~128자의 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 사용할 수 있습니다.",
            }),
            { status: 400, headers },
          );
        }
        if (!portLaunchOwnership.tryClaim(portId)) {
          return new Response(JSON.stringify({
            success: false,
            code: 'PORT_LAUNCH_IN_PROGRESS',
            error: '이 프로젝트의 실행 또는 재실행이 이미 진행 중입니다.',
          }), { status: 409, headers });
        }
        claimedPortId = portId;
        const registration = await validateRegisteredExecution(portId, commandPath, folderPath, port);
        if (!registration.ok) {
          return new Response(JSON.stringify({
            success: false,
            code: registration.code,
            error: registration.error,
          }), { status: registration.status, headers });
        }
        const launchPort = registration.storedPort ?? port;

        // 기존 프로세스가 실행 중이면 종료
        const existingProc = executableProcesses.get(portId);
        if (existingProc) {
          devLog(`[Execute] Killing existing process tree for portId: ${portId}`);
          try {
            // 자손 트리까지 종료 — 리스너만 죽이고 helper 프로세스가 남는 누수 방지
            if (existingProc.pid) await killProcessTree(existingProc.pid, true);
            existingProc.kill();
          } catch (e) {
            console.error(`[Execute] Error killing process:`, e);
            throw e;
          }
        }

        // .html 파일은 브라우저로 열기
        if (commandPath.toLowerCase().endsWith('.html')) {
          if (IS_WIN) {
            spawn({ cmd: ['explorer.exe', commandPath], stdout: 'inherit', stderr: 'inherit' });
          } else {
            try { Bun.spawnSync(['open', '-a', 'Google Chrome', commandPath]); }
            catch { Bun.spawnSync(['open', commandPath]); }
          }
          return new Response(JSON.stringify({ success: true, message: 'Opened HTML in browser' }), { headers });
        }

        // 파일 경로 vs raw 커맨드 판별
        const isFilePath = IS_WIN
          ? /^([A-Za-z]:[\\\/]|\\\\|~)/.test(commandPath)
          : commandPath.startsWith('/') || commandPath.startsWith('~');
        // 파일 경로인 경우 존재 여부 확인
        if (isFilePath && !existsSync(commandPath)) {
          return new Response(
            JSON.stringify({ error: `파일을 찾을 수 없습니다: ${commandPath}` }),
            { status: 400, headers }
          );
        }
        const windowsLaunch = IS_WIN
          ? buildWindowsSupervisedLaunch(
              windowsProcessSupervisorScript(),
              buildWindowsCommandLaunch({ commandPath, isFilePath, folderPath }),
            )
          : null;
        const cmd = windowsLaunch?.cmd
          ?? (isFilePath ? ['/bin/bash', commandPath] : ['/bin/bash', '-c', commandPath]);
        devLog(`[Execute] Starting managed process: ${cmd[0]}`);

        await ensureDependenciesForLaunch(isFilePath, folderPath);

        // 자식 출력을 logs/{portId}.log로 리다이렉트 (Rust 측과 동일 경로).
        // append 전에 10MB 초과 시 tail ~1MB만 남기고 회전 — 무한 append 방지.
        await rotateLogIfNeeded(portId);
        const logFd = openLogAppendFd(portId);

        const proc = spawn({
          cmd,
          cwd: (!IS_WIN && !isFilePath && folderPath) ? folderPath : undefined,
          stdout: logFd ?? "inherit",
          stderr: logFd ?? "inherit",
          stdin: "ignore",
          env: {
            ...process.env,
            ...processPortEnvironment(launchPort),
            ...windowsLaunch?.env,
          },
        });
        // 자식이 fd를 상속받았으므로 parent 쪽 복사본은 즉시 닫는다 (fd 누수 방지)
        if (logFd !== null) { try { closeSync(logFd); } catch { /* already closed */ } }

        executableProcesses.set(portId, proc);

        devLog(`[Execute] Process started successfully with PID: ${proc.pid}`);

        // 프로세스 종료 시 처리
        proc.exited.then((code) => {
          devLog(`[Execute] Process for portId ${portId} exited with code: ${code}`);
          // 재시작으로 새 프로세스가 등록된 경우 기존 핸들러가 지우지 않도록 가드
          if (executableProcesses.get(portId) === proc) executableProcesses.delete(portId);
        });

        return new Response(
          JSON.stringify({
            success: true,
            message: "Command started",
            portId,
            pid: proc.pid,
          }),
          { headers }
        );
      } catch (error: any) {
        console.error(`[Execute] Error:`, error);
        return new Response(
          JSON.stringify({
            error: error.message,
          }),
          { status: 500, headers }
        );
      } finally {
        if (claimedPortId) portLaunchOwnership.release(claimedPortId);
      }
    }

    if (url.pathname === "/api/stop-command" && req.method === "POST") {
      let claimedPortId: string | null = null;
      try {
        const { portId, port } = await req.json();

        devLog(`[Stop] Received stop request for portId: ${portId}, port: ${port}`);

        if (!portId) {
          return new Response(
            JSON.stringify({ error: "Missing portId" }),
            { status: 400, headers }
          );
        }
        if (!isSafeLogId(portId)) {
          return new Response(
            JSON.stringify({
              code: "INVALID_PORT_ID",
              error: "portId는 1~128자의 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 사용할 수 있습니다.",
            }),
            { status: 400, headers },
          );
        }
        if (!portLaunchOwnership.tryClaim(portId)) {
          return new Response(JSON.stringify({
            success: false,
            code: 'PORT_LAUNCH_IN_PROGRESS',
            error: '이 프로젝트의 실행, 중지 또는 재실행이 이미 진행 중입니다.',
          }), { status: 409, headers });
        }
        claimedPortId = portId;
        const registration = await validateRegisteredPortControl(portId, port);
        if (!registration.ok) {
          return new Response(JSON.stringify({
            success: false,
            code: registration.code,
            error: registration.error,
          }), { status: registration.status, headers });
        }

        const killedPids: string[] = [];

        // Map에서 프로세스 제거
        const proc = executableProcesses.get(portId);
        if (proc) {
          devLog(`[Stop] Killing process tree from map for portId: ${portId}, PID: ${proc.pid}`);
          try {
            // 직접 spawn한 .command의 자손 트리 전체 종료 (포트 리스너가 아닌
            // helper 프로세스들도 함께 정리) — SIGTERM → SIGKILL 에스컬레이션 포함
            if (proc.pid) {
              await killProcessTree(proc.pid, false);
              killedPids.push(String(proc.pid));
            }
            try { proc.kill(); } catch { /* checked tree termination already succeeded */ }
            executableProcesses.delete(portId);
            devLog(`[Stop] Process tree killed successfully`);
          } catch (e) {
            console.error(`[Stop] Error killing process:`, e);
            throw e;
          }
        }

        // 포트로 실행 중인 모든 프로세스 찾기
        if (port) {
          devLog(`[Stop] Searching for all processes on port: ${port}`);
          try {
            const pids = await getPidsByPort(port);
            if (pids.length > 0) {
              devLog(`[Stop] Found ${pids.length} PIDs on port ${port}:`, pids);
              for (const pid of pids) {
                // 리스너 PID뿐 아니라 그 자손 트리까지 종료
                // (SIGTERM → 생존 확인 → SIGKILL 에스컬레이션은 killProcessTree 내부 처리)
                await killProcessTree(pid, false);
                if (!killedPids.includes(pid)) killedPids.push(pid);
              }
              devLog(`[Stop] Successfully killed ${killedPids.length} process(es)`);
            } else {
              devLog(`[Stop] No process found on port ${port}`);
            }
          } catch (e) {
            console.error(`[Stop] Error finding/killing process by port:`, e);
            throw e;
          }
        }

        return new Response(
          JSON.stringify({
            success: true,
            message: killedPids.length > 0
              ? `Stopped ${killedPids.length} process(es)`
              : "No process running (already stopped)",
            killedPids,
          }),
          { headers }
        );
      } catch (error: any) {
        console.error(`[Stop] Error:`, error);
        return new Response(
          JSON.stringify({
            error: error.message,
          }),
          { status: 500, headers }
        );
      } finally {
        if (claimedPortId) portLaunchOwnership.release(claimedPortId);
      }
    }

    if (url.pathname === "/api/force-restart-command" && req.method === "POST") {
      let claimedPortId: string | null = null;
      try {
        const { portId, port, commandPath, folderPath } = await req.json();

        devLog(`[ForceRestart] Received request for portId: ${portId}, port: ${port}, path: ${commandPath}`);

        if (!portId || !commandPath) {
          return new Response(
            JSON.stringify({ error: "Missing portId or commandPath" }),
            { status: 400, headers }
          );
        }
        if (!isSafeLogId(portId)) {
          return new Response(
            JSON.stringify({
              code: "INVALID_PORT_ID",
              error: "portId는 1~128자의 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 사용할 수 있습니다.",
            }),
            { status: 400, headers },
          );
        }
        if (!portLaunchOwnership.tryClaim(portId)) {
          return new Response(JSON.stringify({
            success: false,
            code: 'PORT_LAUNCH_IN_PROGRESS',
            error: '이 프로젝트의 실행 또는 재실행이 이미 진행 중입니다.',
          }), { status: 409, headers });
        }
        claimedPortId = portId;
        const registration = await validateRegisteredExecution(portId, commandPath, folderPath, port);
        if (!registration.ok) {
          return new Response(JSON.stringify({
            success: false,
            code: registration.code,
            error: registration.error,
          }), { status: registration.status, headers });
        }

        const launchPort = registration.storedPort ?? port;

        // Preflight before killing the old server. A missing launcher or dependency
        // repair must never turn a recoverable restart request into downtime.
        const isFilePath = IS_WIN
          ? /^([A-Za-z]:[\\\/]|\\\\|~)/.test(commandPath)
          : commandPath.startsWith('/') || commandPath.startsWith('~');
        if (isFilePath && !existsSync(commandPath)) {
          return new Response(
            JSON.stringify({ error: `파일을 찾을 수 없습니다: ${commandPath}` }),
            { status: 400, headers }
          );
        }
        await ensureDependenciesForLaunch(isFilePath, folderPath);

        // 1단계: 포트로 실행 중인 모든 프로세스 강제 종료
        devLog(`[ForceRestart] Killing all processes on port ${port}`);

        // Map에서도 제거
        const proc = executableProcesses.get(portId);
        if (proc) {
          devLog(`[ForceRestart] Killing process tree from map, PID: ${proc.pid}`);
          try {
            // 자손 트리까지 강제 종료 — helper 프로세스 누적 방지
            if (proc.pid) await killProcessTree(proc.pid, true);
            proc.kill();
            executableProcesses.delete(portId);
          } catch (e) {
            console.error(`[ForceRestart] Error killing process from map:`, e);
            throw e;
          }
        }

        // 포트가 있는 프로젝트만 listener를 조회한다. 폴더 전용 프로젝트는
        // 추적 PID 트리만 종료하고 PORT/API_PORT 환경변수를 만들지 않는다.
        const listenerPort = Number(processPortEnvironment(launchPort).PORT) || undefined;
        try {
          const pids = listenerPort ? await getPidsByPort(listenerPort) : [];
          if (pids.length > 0) {
            devLog(`[ForceRestart] Found PIDs on port ${listenerPort}:`, pids);
            for (const pid of pids) {
              // 리스너 PID + 자손 트리 전체 강제 종료
              await killProcessTree(pid, true);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
            devLog(`[ForceRestart] Successfully killed all processes on port ${listenerPort}`);
          } else {
            devLog(`[ForceRestart] No listener process found${listenerPort ? ` on port ${listenerPort}` : ''}`);
          }
        } catch (e) {
          console.error(`[ForceRestart] Error finding/killing process by port:`, e);
          throw e;
        }

        // 2단계: 새로운 프로세스 시작 (파일 경로 vs raw 커맨드 판별)
        const windowsLaunch = IS_WIN
          ? buildWindowsSupervisedLaunch(
              windowsProcessSupervisorScript(),
              buildWindowsCommandLaunch({ commandPath, isFilePath, folderPath }),
            )
          : null;
        const restartCmd = windowsLaunch?.cmd
          ?? (isFilePath ? ['/bin/bash', commandPath] : ['/bin/bash', '-c', commandPath]);
        devLog(`[ForceRestart] Starting new managed process: ${restartCmd[0]}`);

        // execute-command와 동일: 로그 회전 후 logs/{portId}.log로 append 리다이렉트
        await rotateLogIfNeeded(portId);
        const restartLogFd = openLogAppendFd(portId);

        const newProc = spawn({
          cmd: restartCmd,
          cwd: (!IS_WIN && !isFilePath && folderPath) ? folderPath : undefined,
          stdout: restartLogFd ?? "inherit",
          stderr: restartLogFd ?? "inherit",
          stdin: "ignore",
          env: {
            ...process.env,
            ...processPortEnvironment(launchPort),
            ...windowsLaunch?.env,
          },
        });
        if (restartLogFd !== null) { try { closeSync(restartLogFd); } catch { /* already closed */ } }

        executableProcesses.set(portId, newProc);

        devLog(`[ForceRestart] Process restarted successfully with PID: ${newProc.pid}`);

        // 프로세스 종료 시 처리
        newProc.exited.then((code) => {
          devLog(`[ForceRestart] Process for portId ${portId} exited with code: ${code}`);
          // 재시작으로 새 프로세스가 등록된 경우 기존 핸들러가 지우지 않도록 가드
          if (executableProcesses.get(portId) === newProc) executableProcesses.delete(portId);
        });

        return new Response(
          JSON.stringify({
            success: true,
            message: listenerPort ? `Force restarted on port ${listenerPort}` : 'Force restarted tracked process',
            portId,
            pid: newProc.pid,
          }),
          { headers }
        );
      } catch (error: any) {
        console.error(`[ForceRestart] Error:`, error);
        return new Response(
          JSON.stringify({
            error: error.message,
          }),
          { status: 500, headers }
        );
      } finally {
        if (claimedPortId) portLaunchOwnership.release(claimedPortId);
      }
    }

    if (url.pathname === "/api/check-port-status" && req.method === "POST") {
      try {
        const { port } = await req.json();

        if (!port) {
          return new Response(
            JSON.stringify({ success: false, error: "Missing port" }),
            { status: 400, headers }
          );
        }

        // 포트 상태 확인 (Windows/macOS 공용)
        const pids = await getPidsByPort(port);
        const isRunning = pids.length > 0;

        devLog(`[CheckPortStatus] Port ${port} is ${isRunning ? 'RUNNING' : 'NOT running'}`);

        return new Response(
          JSON.stringify({
            success: true,
            isRunning,
          }),
          { headers }
        );
      } catch (error: any) {
        console.error(`[CheckPortStatus] Error:`, error);
        return new Response(
          JSON.stringify({
            success: false,
            error: error.message,
          }),
          { status: 500, headers }
        );
      }
    }

    // 일괄 포트 상태 확인 — lsof 1회 스냅샷으로 N개 포트를 모두 응답.
    // 10초 폴링이 포트당 /api/check-port-status를 호출하던 spawn 폭주의 대체 경로.
    // (기존 per-port 엔드포인트는 legacy shim 규칙에 따라 유지)
    if (url.pathname === "/api/check-ports-batch" && req.method === "POST") {
      try {
        const { ports } = await req.json();
        if (!Array.isArray(ports) || ports.length > 500 ||
            !ports.every((p: unknown) => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535)) {
          return new Response(
            JSON.stringify({ success: false, error: "ports must be an array of integers 1-65535 (max 500)" }),
            { status: 400, headers }
          );
        }
        const listening = await getListeningPortsSnapshot();
        const results = (ports as number[]).map((port) => ({ port, isRunning: listening.has(port) }));
        return new Response(JSON.stringify({ success: true, results }), { headers });
      } catch (error: any) {
        console.error(`[CheckPortsBatch] Error:`, error);
        return new Response(
          JSON.stringify({ success: false, error: error.message }),
          { status: 500, headers }
        );
      }
    }

    // 워크트리 폴더 경로와 CWD가 일치하는 프로세스의 실제 리스닝 포트 반환
    if (url.pathname === "/api/find-worktree-port" && req.method === "POST") {
      // 이 읽기 전용 조회는 여러 워크트리에 동시에 실행된다. Bun이 동시 POST body를
      // 간헐적으로 잘못 읽는 환경을 피하기 위해 신규 클라이언트는 query를 사용하고,
      // 기존 JSON 클라이언트만 호환용 fallback으로 파싱한다.
      let folderPath = url.searchParams.get("folderPath")?.trim() ?? "";
      // 메인 포트를 알면 배정 규칙(slot*10000+mainPort)에 맞는 포트만 인정한다.
      // 없으면 레거시 해시 범위만 인정 — 구버전 클라이언트 호환.
      const mainPortRaw = Number(url.searchParams.get("mainPort"));
      const mainPort = Number.isInteger(mainPortRaw) && mainPortRaw > 0 ? mainPortRaw : null;
      if (!folderPath) {
        try {
          const rawBody = await req.text();
          const body = rawBody ? JSON.parse(rawBody) as { folderPath?: unknown } : {};
          folderPath = typeof body.folderPath === "string" ? body.folderPath.trim() : "";
        } catch {
          return new Response(
            JSON.stringify({ success: false, port: null, error: "invalid JSON request body" }),
            { status: 400, headers }
          );
        }
      }
      try {
        if (!folderPath || IS_WIN) {
          return new Response(JSON.stringify({ success: true, port: null }), { headers });
        }
        // 1) LISTEN 중인 포트+PID 수집 — 레거시 path-hash 범위(10001-10499)와
        //    신규 slot*10000+mainPort 범위(대략 11000-59999)를 한 번에 스캔
        const r1 = Bun.spawnSync(['/usr/sbin/lsof', '-iTCP:10001-59999', '-sTCP:LISTEN', '-P', '-n', '-F', 'pn'], { stderr: 'pipe' });
        const lines1 = r1.stdout.toString().split('\n');
        const pidPortPairs: { pid: string; port: number }[] = [];
        let curPid = '';
        for (const line of lines1) {
          if (line.startsWith('p')) { curPid = line.slice(1); }
          else if (line.startsWith('n') && curPid) {
            const m = line.match(/:(\d+)$/);
            if (m) pidPortPairs.push({ pid: curPid, port: parseInt(m[1]!) });
          }
        }
        // 2) 각 고유 PID의 CWD가 folderPath 와 일치하는지 확인
        // 워크트리 서버는 항상 spawn 시 cwd: folderPath로 기동되므로(execute-command/
        // force-restart-command 참고) 프로세스 cwd는 folderPath와 같거나 그 하위(모노레포
        // 서브패키지)여야 한다. 반대 방향(folderPath가 cwd의 하위, 즉 cwd가 folderPath의
        // 조상)까지 허용하면 folderPath와 무관한 프로세스(cwd가 상위 디렉터리인 아무 백그라운드
        // 프로세스)가 넓어진 lsof 포트 범위(10001-59999)에서 false-positive로 매칭될 수 있어 제외.
        const uniquePids = [...new Set(pidPortPairs.map(e => e.pid))];
        for (const pid of uniquePids) {
          const r2 = Bun.spawnSync(['/usr/sbin/lsof', '-a', '-p', pid, '-d', 'cwd', '-Fn'], { stderr: 'pipe' });
          const cwdLine = r2.stdout.toString().split('\n').find(l => l.startsWith('n'));
          if (!cwdLine) continue;
          const cwd = cwdLine.slice(1).trim();
          if (cwd === folderPath || cwd.startsWith(folderPath + '/')) {
            const port = pidPortPairs.find(e => e.pid === pid)?.port ?? null;
            // ⚠️ cwd 일치만으로는 부족하다. 같은 디렉터리에서 뜬 MCP 서버/LSP도 걸린다
            //    (실측: Serena MCP가 :24285로 잡혀 「중지」가 Serena를 죽이는 상태였음).
            //    앱이 실제로 배정할 수 있는 포트인지까지 확인한다.
            if (port && !isWorktreePortCandidate(port, mainPort)) {
              devLog(`[FindWorktreePort] ${folderPath} → :${port} 무시 (배정 규칙 불일치, pid ${pid})`);
              continue;
            }
            if (port) {
              devLog(`[FindWorktreePort] ${folderPath} → port ${port} (pid ${pid} cwd=${cwd})`);
              return new Response(JSON.stringify({ success: true, port }), { headers });
            }
          }
        }
        return new Response(JSON.stringify({ success: true, port: null }), { headers });
      } catch (error: any) {
        console.error('[FindWorktreePort] Error:', error);
        return new Response(JSON.stringify({ success: false, port: null, error: error.message }), { headers });
      }
    }

    if (url.pathname === "/api/open-add-command" && req.method === "POST") {
      try {
        const scriptPath = join(import.meta.dir, "포트에추가.command");

        devLog(`[OpenAddCommand] Attempting to open: ${scriptPath}`);

        // 파일 존재 여부 확인
        const file = Bun.file(scriptPath);
        const fileExists = await file.exists();

        if (!fileExists) {
          console.error(`[OpenAddCommand] File not found: ${scriptPath}`);
          return new Response(
            JSON.stringify({
              success: false,
              error: `파일을 찾을 수 없습니다: ${scriptPath}`,
            }),
            { status: 404, headers }
          );
        }

        devLog(`[OpenAddCommand] File exists, opening...`);

        openPath(scriptPath);

        return new Response(
          JSON.stringify({
            success: true,
            message: "Opened 포트에추가.command",
          }),
          { headers }
        );
      } catch (error: any) {
        console.error(`[OpenAddCommand] Error:`, error);
        return new Response(
          JSON.stringify({
            success: false,
            error: error.message,
          }),
          { status: 500, headers }
        );
      }
    }

    if (url.pathname === "/api/build" && req.method === "POST") {
      try {
        const { type } = await req.json(); // type: 'build' or 'dmg'

        if (buildStatus.isBuilding) {
          return new Response(
            JSON.stringify({ error: "빌드가 이미 진행 중입니다" }),
            { status: 400, headers }
          );
        }

        if (IS_WIN) {
          return new Response(JSON.stringify({
            success: false,
            error: 'macOS 전용 기능입니다. Windows 빌드는 /api/build-windows를 사용하세요.',
          }), { status: 400, headers });
        }

        buildStatus = { isBuilding: true, type, output: [], exitCode: null };

        const buildCommand = type === 'dmg' ? 'tauri:build:dmg' : 'tauri:build';

        devLog(`[Build] Starting ${type} build...`);

        // bash를 통해 cargo 환경을 설정하고 실행
        buildProcess = spawn({
          cmd: ["/bin/bash", "-c", `[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"; cd "${import.meta.dir}" && bun run ${buildCommand}`],
          stdout: "pipe",
          stderr: "pipe",
        });

        // 출력 스트림 읽기 (스트림이 완전히 드레인된 후 상태 업데이트)
        const readStream = async (stream: any, isStderr = false) => {
          const decoder = new TextDecoder();
          for await (const chunk of stream) {
            const text = decoder.decode(chunk, { stream: true });
            pushLogBounded(buildStatus.output, text);
            if (isStderr) {
              console.error(`[Build] ${text}`);
            } else {
              devLog(`[Build] ${text}`);
            }
          }
        };

        const stdoutDone = readStream(buildProcess.stdout, false);
        const stderrDone = readStream(buildProcess.stderr, true);

        // 프로세스 종료 대기 - 스트림이 모두 닫힌 후에 상태 업데이트
        buildProcess.exited.then(async (code: number) => {
          await Promise.all([stdoutDone, stderrDone]); // 스트림 완전 드레인 후
          buildStatus.exitCode = code;
          buildStatus.isBuilding = false;
          devLog(`[Build] Process exited with code: ${code}`);
        });

        return new Response(
          JSON.stringify({ success: true, message: `${type} 빌드가 시작되었습니다` }),
          { headers }
        );
      } catch (error: any) {
        console.error(`[Build] Error:`, error);
        buildStatus.isBuilding = false;
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers }
        );
      }
    }

    if (url.pathname === "/api/build-status" && req.method === "GET") {
      return new Response(
        JSON.stringify(buildStatus),
        { headers }
      );
    }

    if (url.pathname === "/api/build-reset" && req.method === "POST") {
      if (buildProcess) {
        try { buildProcess.kill(); } catch {}
      }
      buildStatus = { isBuilding: false, type: '', output: ['⚠️ 빌드가 강제 초기화되었습니다.'], exitCode: null };
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // ─── Vercel 포털 자동 배포 ──────────────────────────────────────────────
    if (url.pathname === "/api/deploy-portal" && req.method === "POST") {
      try {
        if (deployStatus.isDeploying) {
          return new Response(
            JSON.stringify({ error: "배포가 이미 진행 중입니다" }),
            { status: 400, headers }
          );
        }
        deployStatus = { isDeploying: true, output: [], exitCode: null, url: null };
        devLog(`[Deploy] Starting portal deployment...`);

        // Windows에서는 cmd, 그 외는 bash
        const isWin = process.platform === 'win32';
        const cmd = isWin
          ? ["cmd", "/c", `cd /d "${import.meta.dir}" && bun run build:portal && npx vercel --prod --yes`]
          : ["/bin/bash", "-c", `cd "${import.meta.dir}" && bun run build:portal && npx vercel --prod --yes`];

        deployProcess = spawn({ cmd, stdout: "pipe", stderr: "pipe" });

        const readStream = async (stream: any, isStderr = false) => {
          const decoder = new TextDecoder();
          for await (const chunk of stream) {
            const text = decoder.decode(chunk, { stream: true });
            pushLogBounded(deployStatus.output, text);
            // URL 파싱: https://xxxxx.vercel.app
            const m = text.match(/https:\/\/[a-zA-Z0-9-]+\.vercel\.app/);
            if (m && !deployStatus.url) {
              deployStatus.url = m[0];
              devLog(`[Deploy] Detected URL: ${m[0]}`);
            }
            if (isStderr) console.error(`[Deploy] ${text}`);
            else devLog(`[Deploy] ${text}`);
          }
        };

        const stdoutDone = readStream(deployProcess.stdout, false);
        const stderrDone = readStream(deployProcess.stderr, true);

        deployProcess.exited.then(async (code: number) => {
          await Promise.all([stdoutDone, stderrDone]);
          deployStatus.exitCode = code;
          deployStatus.isDeploying = false;
          devLog(`[Deploy] Process exited with code: ${code}, url: ${deployStatus.url}`);
        });

        return new Response(
          JSON.stringify({ success: true, message: "배포가 시작되었습니다" }),
          { headers }
        );
      } catch (error: any) {
        console.error(`[Deploy] Error:`, error);
        deployStatus.isDeploying = false;
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/deploy-portal-status" && req.method === "GET") {
      return new Response(JSON.stringify(deployStatus), { headers });
    }

    if (url.pathname === "/api/deploy-portal-reset" && req.method === "POST") {
      if (deployProcess) {
        try { deployProcess.kill(); } catch {}
      }
      deployStatus = { isDeploying: false, output: ['⚠️ 배포가 강제 초기화되었습니다.'], exitCode: null, url: null };
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // Vercel 로그인 체크: whoami
    if (url.pathname === "/api/vercel-whoami" && req.method === "GET") {
      try {
        const isWin = process.platform === 'win32';
        const cmd = isWin ? ["cmd", "/c", "npx vercel whoami"] : ["/bin/bash", "-c", "npx vercel whoami"];
        const proc = spawn({ cmd, stdout: "pipe", stderr: "pipe" });
        const out = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        const loggedIn = code === 0 && out.trim().length > 0 && !err.includes('Error');
        return new Response(
          JSON.stringify({ loggedIn, user: loggedIn ? out.trim() : null, message: loggedIn ? out.trim() : err.trim() }),
          { headers }
        );
      } catch (e: any) {
        return new Response(JSON.stringify({ loggedIn: false, message: e.message }), { headers });
      }
    }

    if (url.pathname === "/api/open-build-folder" && req.method === "POST") {
      try {
        const home = process.env.USERPROFILE || process.env.HOME || "";
        // Windows: nsis 폴더, macOS: dmg 폴더
        const bundleFolder = IS_WIN
          ? join(home, "cargo-targets", "portmanager", "release", "bundle", "nsis")
          : join(home, "cargo-targets", "portmanager", "release", "bundle", "dmg");

        devLog(`[OpenBuildFolder] Attempting to open: ${bundleFolder}`);
        openPath(bundleFolder);

        return new Response(
          JSON.stringify({
            success: true,
            message: "빌드 폴더를 열었습니다",
          }),
          { headers }
        );
      } catch (error: any) {
        console.error(`[OpenBuildFolder] Error:`, error);
        return new Response(
          JSON.stringify({
            success: false,
            error: error.message,
          }),
          { status: 500, headers }
        );
      }
    }

    if (url.pathname === "/api/project-path" && req.method === "GET") {
      return new Response(JSON.stringify({ path: process.cwd() }), { headers });
    }

    if (url.pathname === "/api/validate-folder" && req.method === "POST") {
      try {
        const { folderPath } = await req.json() as { folderPath?: string };
        if (!folderPath || !isAbsolute(folderPath)) {
          return new Response(JSON.stringify({ error: "절대 폴더 경로가 필요합니다." }), { status: 400, headers });
        }
        const normalizedPath = folderPath.replace(/[/\\]+$/, "");
        if (!existsSync(normalizedPath) || !statSync(normalizedPath).isDirectory()) {
          return new Response(JSON.stringify({ error: "드롭한 경로가 폴더가 아니거나 존재하지 않습니다." }), { status: 400, headers });
        }
        return new Response(JSON.stringify({ path: normalizedPath }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message || String(error) }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/validate-file" && req.method === "POST") {
      try {
        const { filePath } = await req.json() as { filePath?: string };
        if (!filePath || !isAbsolute(filePath)) {
          return new Response(JSON.stringify({ error: "실행 파일의 절대경로가 필요합니다." }), { status: 400, headers });
        }
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          return new Response(JSON.stringify({ error: "드롭한 경로가 파일이 아니거나 존재하지 않습니다." }), { status: 400, headers });
        }
        return new Response(JSON.stringify({ path: filePath }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message || String(error) }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/pick-folder" && req.method === "GET") {
      try {
        let picked = '';
        if (IS_WIN) {
          // Windows: PowerShell FolderBrowserDialog
          const ps = Bun.spawn({
            cmd: ['powershell', '-NoProfile', '-NonInteractive', '-Command',
              `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = '폴더 선택'; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }`],
            stdout: 'pipe', stderr: 'pipe',
          });
          await ps.exited;
          picked = (await new Response(ps.stdout).text()).trim();
        } else {
          const scriptPath = `/tmp/pick-folder-${Date.now()}.applescript`;
          await Bun.write(scriptPath, `try
  set chosen to choose folder with prompt "폴더를 선택하세요"
  return POSIX path of chosen
on error
  return ""
end try`);
          const proc = Bun.spawn({
            cmd: ['osascript', scriptPath],
            stdout: 'pipe', stderr: 'pipe',
          });
          await proc.exited;
          picked = (await new Response(proc.stdout).text()).trim();
          Bun.file(scriptPath).exists().then(() => Bun.spawn({ cmd: ['rm', scriptPath] })).catch(() => {});
        }
        if (!picked) {
          return new Response(JSON.stringify({ error: 'cancelled' }), { status: 400, headers });
        }
        return new Response(JSON.stringify({ path: picked }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/resolve-dropped-path" && req.method === "POST") {
      try {
        if (process.platform !== 'darwin') {
          return new Response(JSON.stringify({
            error: '이 브라우저에서는 드롭한 항목의 실제 경로를 확인할 수 없습니다. 오른쪽 선택 버튼을 사용해주세요.',
          }), { status: 501, headers });
        }
        const body = await req.json().catch(() => ({}));
        const pathKind = body.pathKind as DroppedPathKind;
        const names = Array.isArray(body.names)
          ? body.names.filter((name: unknown): name is string => typeof name === 'string').slice(0, 20)
          : [];
        if (!['file', 'folder'].includes(pathKind) || names.length === 0) {
          return new Response(JSON.stringify({ error: '드롭 항목 정보가 올바르지 않습니다.' }), {
            status: 400,
            headers,
          });
        }

        const script = [
          'ObjC.import("AppKit");',
          'const pb=$.NSPasteboard.pasteboardWithName($.NSPasteboardNameDrag);',
          'const value=pb.propertyListForType("NSFilenamesPboardType");',
          'value ? ObjC.deepUnwrap(value).join("\\n") : "";',
        ].join(' ');
        const proc = Bun.spawn({
          cmd: ['/usr/bin/osascript', '-l', 'JavaScript', '-e', script],
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const exitCode = await proc.exited;
        const stdout = (await new Response(proc.stdout).text()).trim();
        const stderr = (await new Response(proc.stderr).text()).trim();
        if (exitCode !== 0) throw new Error(stderr || 'macOS 드래그 경로를 읽지 못했습니다.');

        const candidates = stdout.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
        const path = selectMatchingDroppedPath(candidates, names, pathKind, candidate => {
          try {
            const info = lstatSync(candidate);
            if (info.isFile()) return 'file';
            if (info.isDirectory()) return 'folder';
            return 'other';
          } catch {
            return null;
          }
        });
        if (!path) {
          return new Response(JSON.stringify({
            error: '드롭한 항목의 경로를 확인하지 못했습니다. 다시 드롭하거나 오른쪽 선택 버튼을 사용해주세요.',
          }), { status: 404, headers });
        }
        return new Response(JSON.stringify({ path }), { headers });
      } catch (error) {
        return new Response(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/pick-file" && req.method === "GET") {
      try {
        let picked = '';
        const documentMode = url.searchParams.get('kind') === 'document';
        if (IS_WIN) {
          // Windows: PowerShell OpenFileDialog
          // 문서 필터는 검증과 같은 목록에서 만든다(src/projectDocumentPath.ts).
          const docGlobs = PROJECT_DOCUMENT_EXTENSIONS.map(ext => `*.${ext}`).join(";");
          const filter = documentMode
            ? `Document Files (${docGlobs})|${docGlobs}|All Files (*.*)|*.*`
            : 'Executable Files (*.bat;*.cmd;*.ps1;*.html)|*.bat;*.cmd;*.ps1;*.html|All Files (*.*)|*.*';
          const ps = Bun.spawn({
            cmd: ['powershell', '-NoProfile', '-NonInteractive', '-Command',
              `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = '${filter}'; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.FileName }`],
            stdout: 'pipe', stderr: 'pipe',
          });
          await ps.exited;
          picked = (await new Response(ps.stdout).text()).trim();
        } else {
          const scriptPath = `/tmp/pick-file-${Date.now()}.applescript`;
          await Bun.write(scriptPath, `try
  set chosen to choose file with prompt "${documentMode ? '매뉴얼 또는 로그 관리 파일을 선택하세요' : '실행 파일을 선택하세요'}"
  return POSIX path of chosen
on error
  return ""
end try`);
          const proc = Bun.spawn({
            cmd: ['osascript', scriptPath],
            stdout: 'pipe', stderr: 'pipe',
          });
          await proc.exited;
          picked = (await new Response(proc.stdout).text()).trim();
          Bun.file(scriptPath).exists().then(() => Bun.spawn({ cmd: ['rm', scriptPath] })).catch(() => {});
        }
        if (!picked) {
          return new Response(JSON.stringify({ error: 'cancelled' }), { status: 400, headers });
        }
        return new Response(JSON.stringify({ path: picked }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/expand-path" && req.method === "POST") {
      try {
        const { path: inputPath } = await req.json();
        const home = process.env.HOME || homedir();
        const expanded = (inputPath as string).replace(/^~/, home);
        return new Response(JSON.stringify({ path: expanded }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/open-folder" && req.method === "POST") {
      try {
        let { folderPath } = await req.json();

        devLog(`[OpenFolder] Attempting to open: ${folderPath}`);

        if (!folderPath) {
          return new Response(
            JSON.stringify({ error: "Missing folderPath" }),
            { status: 400, headers }
          );
        }

        // ~ 확장 및 상대 경로(. 또는 .claude 등) → 홈 디렉토리 기준으로 변환
        const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
        if (folderPath.startsWith('~/') || folderPath === '~') {
          folderPath = HOME + folderPath.slice(1);
        } else if (!IS_WIN && !folderPath.startsWith('/')) {
          // 상대 경로: 홈 디렉토리 기준으로 확장
          folderPath = `${HOME}/${folderPath}`;
        }

        // 절대 경로 확인 (Windows: C:\... or \\..., macOS: /...)
        const isAbsolute = IS_WIN
          ? /^([A-Za-z]:[\\\/]|\\\\)/.test(folderPath)
          : folderPath.startsWith('/');
        if (!isAbsolute) {
          return new Response(
            JSON.stringify({ error: `절대 경로가 필요합니다: "${folderPath}"` }),
            { status: 400, headers }
          );
        }

        // 경로 존재 여부 확인
        if (!existsSync(folderPath)) {
          return new Response(
            JSON.stringify({ error: `경로를 찾을 수 없습니다: "${folderPath}"` }),
            { status: 404, headers }
          );
        }

        openPath(folderPath);

        return new Response(
          JSON.stringify({
            success: true,
            message: "경로를 열었습니다",
          }),
          { headers }
        );
      } catch (error: any) {
        console.error(`[OpenFolder] Error:`, error);
        return new Response(
          JSON.stringify({
            success: false,
            error: error.message,
          }),
          { status: 500, headers }
        );
      }
    }

    if (url.pathname === "/api/open-code-app" && req.method === "POST") {
      try {
        const { agent, folderPath } = await req.json() as {
          agent?: CodeAppAgent;
          folderPath?: string;
        };
        if (agent !== 'codex' && agent !== 'claude' && agent !== 'hermes') {
          return new Response(JSON.stringify({ error: 'agent must be codex, claude, or hermes' }), { status: 400, headers });
        }
        if (!folderPath || !isAbsolute(folderPath)) {
          return new Response(JSON.stringify({ error: '절대 폴더 경로가 필요합니다.' }), { status: 400, headers });
        }
        if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
          return new Response(JSON.stringify({ error: `폴더를 찾을 수 없습니다: ${folderPath}` }), { status: 400, headers });
        }

        if (agent === 'hermes') {
          // Hermes is single-instance by default. When it is already running,
          // launch a separate project-scoped instance so --cwd is not discarded.
          const running = runningHermesDesktop();
          // 이미 떠 있는 인스턴스가 있으면 그 실행 파일을 쓰므로 CLI가 없어도 된다.
          // 그렇지 않을 때만 CLI가 필요하고, 없으면 spawn 전에 판정해 원시 오류 대신
          // 무엇을 해야 하는지 말한다.
          if (!running && hermesCliPath() === null) {
            return new Response(
              JSON.stringify({ error: HERMES_CLI_NOT_FOUND_MESSAGE, code: HERMES_CLI_NOT_FOUND_CODE }),
              { status: 409, headers },
            );
          }
          const projectUserData = join(homedir(), '.hermes', 'desktop-projects', Buffer.from(folderPath).toString('base64url'));
          mkdirSync(projectUserData, { recursive: true, mode: 0o700 });
          try { chmodSync(projectUserData, 0o700); } catch { /* Windows ACLs own access control */ }
          const projectDirFile = join(projectUserData, 'project-dir.json');
          writeFileSync(
            projectDirFile,
            JSON.stringify({ dir: folderPath }, null, 2),
            { encoding: 'utf8', mode: 0o600 },
          );
          try { chmodSync(projectDirFile, 0o600); } catch { /* Windows ACLs own access control */ }
          const readyFile = join(projectUserData, `launch-ready-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
          const env = {
            ...process.env,
            HERMES_DESKTOP_CWD: folderPath,
            HERMES_DESKTOP_READY_FILE: readyFile,
          };
          const child = running
            ? Bun.spawn([running.executable, `--user-data-dir=${projectUserData}`], {
                cwd: folderPath,
                env,
                stdout: 'ignore', stderr: 'ignore',
              })
            : Bun.spawn([resolveAgentBin('hermes'), 'desktop', '--cwd', folderPath], {
                cwd: folderPath,
                env,
                stdout: 'ignore', stderr: 'ignore',
              });
          child.unref();
          const verified = await verifyHermesDesktopRunning(readyFile, folderPath, child.pid);
          try { unlinkSync(readyFile); } catch { /* receipt may not have been created */ }
          if (!verified) {
            return new Response(JSON.stringify({ error: 'Hermes Desktop 프로세스를 확인하지 못했습니다.' }), { status: 500, headers });
          }
          return new Response(JSON.stringify({ success: true, agent, folderPath, confirmationRequired: false }), { headers });
        }

        const deepLink = buildCodeAppDeepLink(agent, folderPath);
        const command = IS_WIN
          ? ['rundll32.exe', 'url.dll,FileProtocolHandler', deepLink.url]
          : process.platform === 'darwin'
            ? ['open', deepLink.url]
            : ['xdg-open', deepLink.url];
        const openResult = Bun.spawnSync(command, {
          stdout: 'ignore',
          stderr: 'pipe',
          timeout: 5_000,
        });
        if (!openResult.success) {
          const detail = openResult.stderr?.toString().trim();
          return new Response(
            JSON.stringify({ error: detail || `${agent} 앱 URL 핸들러를 실행하지 못했습니다.` }),
            { status: 500, headers },
          );
        }
        return new Response(JSON.stringify({
          success: true,
          agent,
          folderPath,
          confirmationRequired: deepLink.confirmationRequired,
        }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message || String(error) }), { status: 500, headers });
      }
    }

    // Prefer the exact existing Voice conversation that is already applied to
    // this local project. When none exists, open an empty project task and
    // trigger ChatGPT's actual "Start new voice chat" control. The fresh Voice
    // thread is verified from rollout metadata before we report it as created.
    // A Voice runtime can still resume a recent unbound thread or lose project
    // context, so scope is always verified from its recorded assignment.
    if (url.pathname === "/api/open-project-codex-voice" && req.method === "POST") {
      try {
        const { folderPath } = await req.json() as { folderPath?: string };
        if (!folderPath || !isAbsolute(folderPath)) {
          return new Response(JSON.stringify({ error: '절대 폴더 경로가 필요합니다.' }), { status: 400, headers });
        }
        if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
          return new Response(JSON.stringify({ error: `폴더를 찾을 수 없습니다: ${folderPath}` }), { status: 400, headers });
        }

        const found = findProjectCodexVoiceThread(folderPath);
        const sessionId = found?.sessionId ?? null;
        if (found?.movePending) {
          // The assignment exists and points here, but the workspace transition
          // was never committed: execution is still in the scratch directory.
          // Opening it as a project session would be a false guarantee.
          return new Response(JSON.stringify({
            success: false,
            code: 'PROJECT_VOICE_MOVE_PENDING',
            sessionId,
            appliedPath: found.appliedPath,
            error: '이 프로젝트로 이동이 요청된 Voice 대화가 있지만 ChatGPT가 아직 적용하지 않았습니다. 실행 폴더는 여전히 임시 폴더입니다.',
          }), { status: 409, headers });
        }

        if (chatGptVoiceAutomationInFlight) {
          return new Response(JSON.stringify({
            success: false,
            code: 'VOICE_START_IN_PROGRESS',
            error: '다른 Codex Voice 시작 또는 재개 요청을 확인하고 있습니다. 잠시 후 다시 시도해 주세요.',
          }), { status: 409, headers });
        }
        chatGptVoiceAutomationInFlight = true;
        try {
          if (sessionId) {
            openChatGptDeepLink(`codex://threads/${sessionId}`);
            // An already applied Voice thread can be reopened safely. Try its
            // resume button as a convenience, but do not turn a failed UI click
            // into a false claim that the microphone is live.
            const automation = await startChatGptVoice(CHATGPT_RESUME_VOICE_START_LABELS);
            return new Response(JSON.stringify({
              success: true,
              folderPath,
              sessionId,
              mode: 'resumed',
              projectBound: true,
              voiceStartRequested: automation.ok,
              ...(automation.ok
                ? { automation: automation.method }
                : { automationError: automation.error, automationCode: automation.code }),
            }), { headers });
          }

          // Voice must begin in a new, empty ChatGPT task. Open the documented
          // project-path task first, then wait for its local assignment before
          // invoking its exact composer control. This avoids starting Voice in
          // whatever unrelated task happened to be frontmost.
          const existingProjectTaskIds = new Set(readChatGptThreadMetadata().keys());
          const existingVoiceStamps = new Map(
            readChatGptVoiceCandidates().map((entry) => [entry.sessionId, entry.modifiedAtMs]),
          );
          const startedAtMs = Date.now();
          openChatGptDeepLink(buildCodeAppDeepLink('codex', folderPath).url);
          const projectReady = await waitForChatGptProjectReady(folderPath, existingProjectTaskIds);
          if (!projectReady) {
            return new Response(JSON.stringify({
              success: false,
              code: 'VOICE_PROJECT_TASK_NOT_READY',
              error: 'ChatGPT에서 선택 프로젝트 문맥을 확인하지 못해 Voice 시작을 보내지 않았습니다. ChatGPT가 열려 있는지 확인한 뒤 다시 시도하세요.',
            }), { status: 409, headers });
          }

          const automation = await startChatGptVoice(CHATGPT_NEW_VOICE_START_LABELS, {
            attempts: 12,
          });
          if (!automation.ok) {
            return new Response(JSON.stringify({
              success: false,
              code: automation.code,
              error: automation.error,
              dispatch: 'not-attempted',
            }), { status: 409, headers });
          }

          const voiceLaunch = await waitForChatGptVoiceLaunch(existingVoiceStamps, startedAtMs);
          if (!voiceLaunch) {
            return new Response(JSON.stringify({
              success: false,
              code: 'VOICE_START_NOT_CONFIRMED',
              error: 'ChatGPT의 프로젝트 Voice 시작 버튼을 눌렀지만 새 Voice 생성 또는 기존 Voice 재개 기록을 확인하지 못했습니다. ChatGPT에서 Voice 상태와 마이크 권한을 확인해 주세요.',
              dispatch: 'button-pressed',
              automation: automation.method,
              confirmation: 'not-observed',
            }), { status: 409, headers });
          }

          const projectState = await waitForFreshChatGptVoiceProjectState(folderPath, voiceLaunch.voice);
          return new Response(JSON.stringify({
            success: true,
            folderPath,
            sessionId: voiceLaunch.voice.sessionId,
            projectTaskId: projectReady.projectTaskId,
            projectReadiness: projectReady.readiness,
            mode: voiceLaunch.kind === 'created'
              ? (projectState.projectBound ? 'started-project' : 'started-unbound')
              : 'resumed-unbound',
            voiceThreadCreated: voiceLaunch.kind === 'created',
            voiceThreadResumed: voiceLaunch.kind === 'resumed',
            // A resumed result may be the most recent global Voice thread.
            // Never treat it as scoped to this folder just because a project
            // task was opened immediately before the command.
            projectBound: voiceLaunch.kind === 'created' && projectState.projectBound,
            movePending: !!projectState.pending,
            appliedPath: projectState.pending?.appliedPath ?? null,
            automation: automation.method,
          }), { headers });
        } finally {
          chatGptVoiceAutomationInFlight = false;
        }
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message || String(error) }), { status: 500, headers });
      }
    }

    // A global Voice start is intentionally a separate, explicit action. The
    // ChatGPT avatar can reopen a recent projectless Voice, so this endpoint
    // never claims project scope and never runs automatically after a project
    // composer control is unavailable.
    if (url.pathname === "/api/start-global-codex-voice" && req.method === "POST") {
      try {
        const { folderPath } = await req.json() as { folderPath?: string };
        if (!folderPath || !isAbsolute(folderPath) || !existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
          return new Response(JSON.stringify({ error: '연결할 프로젝트의 절대 폴더 경로가 필요합니다.' }), { status: 400, headers });
        }
        if (chatGptVoiceAutomationInFlight) {
          return new Response(JSON.stringify({
            success: false,
            code: 'VOICE_START_IN_PROGRESS',
            error: '다른 Codex Voice 시작 또는 재개 요청을 확인하고 있습니다. 잠시 후 다시 시도해 주세요.',
          }), { status: 409, headers });
        }
        chatGptVoiceAutomationInFlight = true;
        try {
          const existingVoiceStamps = new Map(
            readChatGptVoiceCandidates().map((entry) => [entry.sessionId, entry.modifiedAtMs]),
          );
          const startedAtMs = Date.now();
          const automation = await startChatGptVoice(CHATGPT_GLOBAL_VOICE_START_LABELS, {
            surface: 'global',
            attempts: 12,
          });
          if (!automation.ok) {
            const globalControlUnavailable = automation.code === 'VOICE_START_CONTROL_UNAVAILABLE';
            return new Response(JSON.stringify({
              success: false,
              code: globalControlUnavailable ? 'VOICE_GLOBAL_START_CONTROL_UNAVAILABLE' : automation.code,
              error: globalControlUnavailable
                ? 'ChatGPT의 전역 Voice 시작/재개 컨트롤도 현재 사용할 수 없습니다. ChatGPT를 열어 Voice를 직접 시작해 주세요.'
                : automation.error,
              dispatch: 'not-attempted',
            }), { status: 409, headers });
          }
          const voiceLaunch = await waitForChatGptVoiceLaunch(existingVoiceStamps, startedAtMs);
          if (!voiceLaunch) {
            return new Response(JSON.stringify({
              success: false,
              code: 'VOICE_START_NOT_CONFIRMED',
              error: 'ChatGPT의 전역 Voice 버튼을 눌렀지만 새 Voice 생성 또는 최근 Voice 재개 기록을 확인하지 못했습니다. ChatGPT에서 Voice 상태와 마이크 권한을 확인해 주세요.',
              dispatch: 'global-button-pressed',
              automation: automation.method,
              confirmation: 'not-observed',
            }), { status: 409, headers });
          }
          return new Response(JSON.stringify({
            success: true,
            folderPath,
            sessionId: voiceLaunch.voice.sessionId,
            mode: voiceLaunch.kind === 'created' ? 'started-global' : 'resumed-global',
            voiceThreadCreated: voiceLaunch.kind === 'created',
            voiceThreadResumed: voiceLaunch.kind === 'resumed',
            projectBound: false,
            automation: automation.method,
          }), { headers });
        } finally {
          chatGptVoiceAutomationInFlight = false;
        }
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message || String(error) }), { status: 500, headers });
      }
    }

    // This is a manual handoff, not a simulated Voice start. It is shown only
    // after both verified AX routes are unavailable, so users can use the
    // normal ChatGPT Voice control they already have permission to operate.
    if (url.pathname === "/api/open-chatgpt-voice" && req.method === "POST") {
      try {
        const { folderPath } = await req.json() as { folderPath?: string };
        if (!folderPath || !isAbsolute(folderPath) || !existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
          return new Response(JSON.stringify({ error: '연결할 프로젝트의 절대 폴더 경로가 필요합니다.' }), { status: 400, headers });
        }
        if (process.platform !== 'darwin') {
          return new Response(JSON.stringify({
            success: false,
            error: '현재 운영체제에서는 ChatGPT 데스크톱 앱을 직접 열 수 없습니다.',
          }), { status: 409, headers });
        }
        const opened = Bun.spawnSync(['open', '-a', 'ChatGPT'], { stdout: 'ignore', stderr: 'pipe', timeout: 5_000 });
        if (!opened.success) {
          const detail = opened.stderr?.toString().trim();
          throw new Error(detail || 'ChatGPT 앱을 열지 못했습니다.');
        }
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message || String(error) }), { status: 500, headers });
      }
    }

    // ── Terminal/tmux helper (Windows: wt.exe or cmd, macOS: iTerm) ─────────
    /** 터미널 실행 결과. `verified:false`는 실패가 아니라 "아직 확인되지 않음"이다. */
    type TerminalLaunchOutcome = { verified: boolean; warning?: string };

    /** iTerm/Terminal이 멈춰 있으면(main run loop wedge) `create window`/`do script`
     *  AppleEvent가 수십 초 이상 반환되지 않는다. 실측(2026-08-02): 같은 앱이
     *  `get version`은 0.05s에 답하면서 `count windows`/`create window`는 25s+ 무응답.
     *  대기 전체를 요청 처리에 묶으면 사용자는 창도 못 보고 15초 뒤 500 에러만 받는다 —
     *  이전의 fire-and-forget 가짜 성공보다 오히려 나쁘다.
     *
     *  1) 짧은 deadline 안에 종료 → exit code로 정직하게 판정 (권한 거부 -1743 등은 즉시 종료).
     *  2) deadline 초과 → **죽이지 않는다.** 전달 중인 AppleEvent가 창을 열 수도 있으므로
     *     프로세스는 백그라운드에 두고 `verified:false` + 경고만 반환한다.
     *  3) backstop까지 살아 있으면 그때 SIGKILL — 좀비 osascript 누적만 방지. */
    async function runAppleScriptChecked(
      script: string,
      opts: { deadlineMs?: number; backstopMs?: number } = {},
    ): Promise<TerminalLaunchOutcome> {
      const deadlineMs = opts.deadlineMs ?? 4_000;
      const backstopMs = opts.backstopMs ?? 120_000;
      const proc = Bun.spawn({ cmd: ['osascript', '-e', script], stdout: 'pipe', stderr: 'pipe' });
      const settled = await Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(deadlineMs).then(() => false),
      ]);
      if (settled) {
        const stderr = (await new Response(proc.stderr).text()).trim();
        if (proc.exitCode !== 0) {
          throw new Error(stderr || `터미널 자동화 실패 (exit ${proc.exitCode})`);
        }
        return { verified: true };
      }
      void (async () => {
        const backstop = setTimeout(() => { try { proc.kill(9); } catch {} }, backstopMs);
        try {
          // stderr를 계속 비워둬야 파이프가 차서 osascript가 멈추는 일이 없다.
          await Promise.all([proc.exited, new Response(proc.stderr).text().catch(() => '')]);
        } catch {
          /* 백그라운드 정리 실패는 무시 */
        } finally {
          clearTimeout(backstop);
        }
      })();
      return {
        verified: false,
        warning: `터미널이 ${Math.round(deadlineMs / 1000)}초 안에 응답하지 않아 실행 여부를 확인하지 못했습니다. 창이 열리지 않으면 iTerm/Terminal을 재시작한 뒤 다시 시도해주세요.`,
      };
    }

    /** 확인되지 않은 실행에는 경고를 붙여 정직한 응답을 만든다. */
    function launchPayload(message: string, outcome: TerminalLaunchOutcome, extra: Record<string, unknown> = {}) {
      return outcome.verified
        ? { success: true, verified: true, message, ...extra }
        : { success: true, verified: false, warning: outcome.warning, message: `${message} — ${outcome.warning}`, ...extra };
    }

    async function spawnWindowsTerminalChecked(
      command: string[],
      env: Record<string, string> = {},
      detached = false,
    ): Promise<TerminalLaunchOutcome> {
      const child = spawn({
        cmd: command,
        env: { ...process.env, ...env },
        stdout: 'ignore',
        stderr: 'pipe',
        detached,
      });
      const stderrPromise = new Response(child.stderr).text().catch(() => '');
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(4_000).then(() => null),
      ]);
      if (exitCode === null) {
        child.unref();
        void Promise.all([child.exited, stderrPromise]).catch(() => undefined);
        return {
          verified: false,
          warning: 'Windows 터미널 실행 handoff가 4초 안에 끝나지 않아 창 생성 여부를 확인하지 못했습니다.',
        };
      }
      const stderr = (await stderrPromise).trim();
      if (exitCode !== 0) {
        throw new Error(stderr || `Windows 터미널 실행 실패 (exit ${exitCode})`);
      }
      return { verified: true };
    }

    async function openTerminalWithCmd(shellCmd: string, folderPath: string | null, title: string, terminalApp: 'iterm' | 'terminal' = 'iterm'): Promise<TerminalLaunchOutcome> {
      if (IS_WIN) {
        const plan = buildWindowsTerminalLaunch({
          windowsTerminalPath: windowsTerminalPath(),
          shellCommand: shellCmd,
          folderPath,
          title,
        });
        return await spawnWindowsTerminalChecked(plan.cmd, plan.env, plan.detached);
      }
      // 임시 스크립트 파일 방식: write text 클립보드 오염 없이 명령 실행
      const fullCmd = folderPath
        ? `cd '${escapeSq(folderPath)}' && ${shellCmd}`
        : shellCmd;
      const scriptPath = `/tmp/portmanager_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.sh`;
      await Bun.write(scriptPath, `#!/bin/zsh -l\nrm -f "$0"\n${fullCmd}\n`);
      Bun.spawnSync(['chmod', '+x', scriptPath]);
      // 스크립트는 실행되면 스스로 지우지만(`rm -f "$0"`), 터미널이 끝내 뜨지 않으면
      // /tmp에 남는다. 넉넉한 지연 후 한 번 더 지워 누수를 막는다.
      const sweep = setTimeout(() => { rmSync(scriptPath, { force: true }); }, 10 * 60_000);
      (sweep as any).unref?.();
      const sqPath = scriptPath.replace(/'/g, "'\\''");
      const launchCommand = `/bin/zsh -l '${sqPath}'`;
      const script = terminalApp === 'terminal'
        ? `tell application "Terminal"\n  activate\n  do script "${launchCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`
        : `tell application "iTerm"\n  activate\n  create window with default profile command "${launchCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
      try {
        return await runAppleScriptChecked(script);
      } catch (error) {
        clearTimeout(sweep);
        rmSync(scriptPath, { force: true });
        throw error;
      }
    }

    if (url.pathname === "/api/open-tmux-claude" && req.method === "POST") {
      try {
        const { sessionName, folderPath, worktreePath, branch, terminalApp = 'iterm' } = await req.json();
        // sessionName은 접미사 없는 기본 이름이다 — 접미사는 명령을 만드는 여기서 한 번만 붙인다.
        const session = tmuxSessionName(sessionName, worktreePath ?? null, false);
        const title = buildWindowTitle(sessionName, worktreePath, 'tmux', branch ?? null);
        let launch: TerminalLaunchOutcome = { verified: true };
        if (IS_WIN) {
          spawnWslTmux(buildWslTmuxBashCmd(sessionName, folderPath ?? null, worktreePath ?? null, false, false), title);
        } else {
          const esc = escapeSq(session);
          const winName = escapeSq(title);
          const claudeBin = agentCli('claude', false);
          const claudeCmd = `tmux new-session -d -s '${esc}' -n '${winName}' '${claudeBin}' 2>/dev/null; tmux set-option -g set-titles on 2>/dev/null; tmux set-option -g set-titles-string '#W' 2>/dev/null; tmux set-window-option -t '${esc}' automatic-rename off 2>/dev/null; tmux rename-window -t '${esc}' '${winName}' 2>/dev/null; tmux attach-session -t '${esc}'`;
          const cdPath = worktreePath ? worktreePath.split(',')[0].trim() : (folderPath ?? null);
          launch = await openTerminalWithCmd(claudeCmd, cdPath, title, terminalApp === 'terminal' ? 'terminal' : 'iterm');
        }
        return new Response(JSON.stringify(launchPayload(`Claude 실행 중 (세션: ${session})`, launch)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-tmux-claude-fresh" && req.method === "POST") {
      try {
        const { sessionName, folderPath, worktreePath, branch, bypass = false, terminalApp = 'iterm' } = await req.json();
        const session = tmuxSessionName(sessionName, worktreePath ?? null, bypass === true);
        const claudeCli = agentCli('claude', bypass);
        const tags: string[] = bypass ? ['tmux', 'fresh', 'bypass'] : ['tmux', 'fresh'];
        const title = buildWindowTitle(sessionName, worktreePath, tags, branch ?? null);
        let launch: TerminalLaunchOutcome = { verified: true };
        if (IS_WIN) {
          spawnWslTmux(buildWslTmuxBashCmd(sessionName, folderPath ?? null, worktreePath ?? null, true, bypass), title);
        } else {
          // Same naming rule as the reuse path below — "새 창" must replace the
          // session "실행" would have joined, not a differently-named one.
          const esc = escapeSq(session);
          const winName = escapeSq(title);
          const claudeCmd = `tmux kill-session -t '${esc}' 2>/dev/null; tmux new-session -d -s '${esc}' -n '${winName}' 'zsh -l -c "${claudeCli}"'; tmux set-option -g set-titles on 2>/dev/null; tmux set-option -g set-titles-string '#W' 2>/dev/null; tmux set-window-option -t '${esc}' automatic-rename off 2>/dev/null; tmux rename-window -t '${esc}' '${winName}' 2>/dev/null; tmux attach-session -t '${esc}'`;
          const cdPath = worktreePath ? worktreePath.split(',')[0].trim() : (folderPath ?? null);
          launch = await openTerminalWithCmd(claudeCmd, cdPath, title, terminalApp === 'terminal' ? 'terminal' : 'iterm');
        }
        return new Response(JSON.stringify(launchPayload(`Claude 새 세션 시작 (${session})`, launch)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-tmux-claude-bypass" && req.method === "POST") {
      try {
        const { sessionName, folderPath, worktreePath, branch, bypass = false, terminalApp = 'iterm' } = await req.json();
        const session = tmuxSessionName(sessionName, worktreePath ?? null, bypass === true);
        const claudeCli = agentCli('claude', bypass);
        const title = buildWindowTitle(sessionName, worktreePath, bypass ? ['tmux', 'bypass'] : ['tmux'], branch ?? null);
        let launch: TerminalLaunchOutcome = { verified: true };
        if (IS_WIN) {
          spawnWslTmux(buildWslTmuxBashCmd(sessionName, folderPath ?? null, worktreePath ?? null, false, bypass), title);
        } else {
          const bypassSess = escapeSq(session);
          const winName = escapeSq(title);
          const claudeCmd = `tmux new-session -d -s '${bypassSess}' -n '${winName}' 'zsh -l -c "${claudeCli}"' 2>/dev/null || true; tmux set-option -g set-titles on 2>/dev/null; tmux set-option -g set-titles-string '#W' 2>/dev/null; tmux set-window-option -t '${bypassSess}' automatic-rename off 2>/dev/null; tmux rename-window -t '${bypassSess}' '${winName}' 2>/dev/null; tmux attach-session -t '${bypassSess}'`;
          const cdPath = worktreePath ? worktreePath.split(',')[0].trim() : (folderPath ?? null);
          launch = await openTerminalWithCmd(claudeCmd, cdPath, title, terminalApp === 'terminal' ? 'terminal' : 'iterm');
        }
        return new Response(JSON.stringify(launchPayload(`Claude${bypass ? ' bypass' : ''} 실행 중 (${session})`, launch)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    // cmux endpoints — used by browser/localhost mode; Tauri app prefers
    // invoke('open_cmux_claude') / invoke('open_cmux_claude_new') in Rust
    // (see src-tauri/src/lib.rs). These HTTP fallbacks use Node's
    // child_process to avoid the Bun.spawn degradation in long-running Bun.serve.
    if (url.pathname === "/api/open-cmux-claude" && req.method === "POST") {
      if (IS_WIN) return new Response(JSON.stringify({ error: 'cmux는 맥에서만 가능합니다' }), { status: 400, headers });
      try {
        const { folderPath, worktreePath, bypass = false, name = '' } = await req.json();
        const cdPath = (worktreePath ? worktreePath.split(',')[0].trim() : null) || folderPath;
        if (!cdPath) {
          return new Response(JSON.stringify({ success: false, error: '프로젝트 경로가 없습니다.' }), { status: 400, headers });
        }
        const claudeCli = agentCli('claude', bypass);
        const title = buildCmuxTitle(name || 'claude', worktreePath, bypass);

        const cli = resolveCmuxCli();
        if (!cli && !cmuxAppExists()) {
          return new Response(JSON.stringify({ error: 'cmux가 설치되지 않았습니다.\n설치: brew tap manaflow-ai/cmux && brew install --cask cmux' }), { status: 400, headers });
        }
        if (cmuxAppExists()) nodeSpawnSync('open', ['-a', 'cmux'], { stdio: 'pipe' });
        const cliPath = cli ?? 'cmux';
        if (!(await waitCmuxReadyNode(cliPath))) {
          return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp('cmux 소켓 준비 대기 시간 초과 (10초)') }), { status: 500, headers });
        }
        const ws = nodeCmuxRun(cliPath, ['new-workspace', '--cwd', cdPath, '--command', claudeCli, '--name', title]);
        if (!ws.ok) {
          return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp(`cmux new-workspace 실패: ${ws.stderr || 'unknown'}`) }), { status: 500, headers });
        }
        return new Response(JSON.stringify({ success: true, message: `cmux Claude${bypass ? ' bypass' : ''} 실행 중` }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-cmux-codex" && req.method === "POST") {
      if (IS_WIN) return new Response(JSON.stringify({ error: 'cmux는 맥에서만 가능합니다' }), { status: 400, headers });
      try {
        const { folderPath, worktreePath, name = '', bypass = false } = await req.json();
        const cdPath = (worktreePath ? worktreePath.split(',')[0].trim() : null) || folderPath;
        if (!cdPath) return new Response(JSON.stringify({ success: false, error: '프로젝트 경로가 없습니다.' }), { status: 400, headers });
        const codexCmd = agentCli('codex', bypass);
        const title = buildCmuxTitle(name || 'codex', worktreePath, bypass);
        const cli = resolveCmuxCli();
        if (!cli && !cmuxAppExists()) return new Response(JSON.stringify({ error: 'cmux가 설치되지 않았습니다.\n설치: brew tap manaflow-ai/cmux && brew install --cask cmux' }), { status: 400, headers });
        if (cmuxAppExists()) nodeSpawnSync('open', ['-a', 'cmux'], { stdio: 'pipe' });
        const cliPath = cli ?? 'cmux';
        if (!(await waitCmuxReadyNode(cliPath))) return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp('cmux 소켓 준비 대기 시간 초과 (10초)') }), { status: 500, headers });
        const ws = nodeCmuxRun(cliPath, ['new-workspace', '--cwd', cdPath, '--command', codexCmd, '--name', title]);
        if (!ws.ok) return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp(`cmux new-workspace 실패: ${ws.stderr || 'unknown'}`) }), { status: 500, headers });
        return new Response(JSON.stringify({ success: true, message: `cmux Codex${bypass ? ' ⚡' : ''} 실행 중` }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-cmux-agy" && req.method === "POST") {
      if (IS_WIN) return new Response(JSON.stringify({ error: 'cmux는 맥에서만 가능합니다' }), { status: 400, headers });
      try {
        const { folderPath, worktreePath, name = '', bypass = false } = await req.json();
        const cdPath = (worktreePath ? worktreePath.split(',')[0].trim() : null) || folderPath;
        if (!cdPath) return new Response(JSON.stringify({ success: false, error: '프로젝트 경로가 없습니다.' }), { status: 400, headers });
        const agyCli = agentCli('agy', bypass);
        const title = buildCmuxTitle(name || 'antigravity', worktreePath, bypass);
        const cli = resolveCmuxCli();
        if (!cli && !cmuxAppExists()) return new Response(JSON.stringify({ error: 'cmux가 설치되지 않았습니다.\n설치: brew tap manaflow-ai/cmux && brew install --cask cmux' }), { status: 400, headers });
        if (cmuxAppExists()) nodeSpawnSync('open', ['-a', 'cmux'], { stdio: 'pipe' });
        const cliPath = cli ?? 'cmux';
        if (!(await waitCmuxReadyNode(cliPath))) return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp('cmux 소켓 준비 대기 시간 초과 (10초)') }), { status: 500, headers });
        const ws = nodeCmuxRun(cliPath, ['new-workspace', '--cwd', cdPath, '--command', agyCli, '--name', title]);
        if (!ws.ok) return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp(`cmux new-workspace 실패: ${ws.stderr || 'unknown'}`) }), { status: 500, headers });
        return new Response(JSON.stringify({ success: true, message: `cmux Antigravity${bypass ? ' ⚡' : ''} 실행 중` }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-cmux-hermes" && req.method === "POST") {
      if (IS_WIN) return new Response(JSON.stringify({ error: 'cmux는 맥에서만 가능합니다' }), { status: 400, headers });
      try {
        const { folderPath, worktreePath, name = '' } = await req.json();
        const cdPath = (worktreePath ? worktreePath.split(',')[0].trim() : null) || folderPath;
        if (!cdPath) return new Response(JSON.stringify({ success: false, error: '프로젝트 경로가 없습니다.' }), { status: 400, headers });
        const hermesCmd = agentCli('hermes', false);
        const title = buildCmuxTitle(name || 'hermes', worktreePath, false);
        const cli = resolveCmuxCli();
        if (!cli && !cmuxAppExists()) return new Response(JSON.stringify({ error: 'cmux가 설치되지 않았습니다.\n설치: brew tap manaflow-ai/cmux && brew install --cask cmux' }), { status: 400, headers });
        if (cmuxAppExists()) nodeSpawnSync('open', ['-a', 'cmux'], { stdio: 'pipe' });
        const cliPath = cli ?? 'cmux';
        if (!(await waitCmuxReadyNode(cliPath))) return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp('cmux 소켓 준비 대기 시간 초과 (10초)') }), { status: 500, headers });
        const ws = nodeCmuxRun(cliPath, ['new-workspace', '--cwd', cdPath, '--command', hermesCmd, '--name', title]);
        if (!ws.ok) return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp(`cmux new-workspace 실패: ${ws.stderr || 'unknown'}`) }), { status: 500, headers });
        return new Response(JSON.stringify({ success: true, message: 'cmux Hermes 실행 중' }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    // Orca endpoint — terminalApp='orca' 선택 시 Claude/Codex/agy를 Orca 터미널로 실행.
    // Tauri 앱은 invoke('open_orca_agent') (src-tauri/src/lib.rs)를 우선 사용.
    // 워크트리 출처 배지용 — Orca가 자체 관리하는 워크트리 경로 목록
    if (url.pathname === "/api/orca-worktrees" && req.method === "GET") {
      return new Response(JSON.stringify(await orcaManagedWorktreePaths()), { headers });
    }

    if (url.pathname === "/api/open-orca-agent" && req.method === "POST") {
      try {
        const { agent = 'claude', folderPath, worktreePath, name = '', bypass = false, floating = true, newWindow = false } = await req.json();
        const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
        const repoPath = resolveOrcaProjectPath(folderPath ? expand(String(folderPath).trim()) : null);
        const wtRaw = worktreePath ? (String(worktreePath).split(',')[0] ?? '').trim() : '';
        const wtFirst = resolveOrcaProjectPath(wtRaw ? expand(wtRaw) : null);
        const cdPath = wtFirst || repoPath;
        if (!cdPath) return new Response(JSON.stringify({ success: false, error: '프로젝트 경로가 없습니다.' }), { status: 400, headers });
        const cli = resolveOrcaCli();
        if (!cli) return new Response(JSON.stringify({ success: false, error: bootstrapOrcaInstall() }), { status: 400, headers });

        // 동시 요청(더블클릭 등)이 겹치면 블로킹 CLI 호출이 쌓이며 Bun 자체가 죽는 현상을
        // 확인 — Orca 작업 전체를 락으로 직렬화해 한 번에 하나씩만 실행되게 한다.
        return await withOrcaLock(async () => {
          const ready = await ensureOrcaReady(cli);
          if (!ready.ok) return new Response(JSON.stringify({ success: false, error: ready.error }), { status: 500, headers });

          const agentMap: Record<string, { agentName: AgentName | null; label: string; suffix?: string }> = {
            claude: { agentName: 'claude', label: 'Claude' },
            codex: { agentName: 'codex', label: 'Codex' },
            agy: { agentName: 'agy', label: 'Antigravity' },
            hermes: { agentName: 'hermes', label: 'Hermes' },
            agents: { agentName: 'claude', label: 'agents', suffix: 'agents' },
            terminal: { agentName: null, label: '터미널' },
          };
          const managedAgent = typeof agent === 'string' && agentMap[agent] ? agent : 'claude';
          const spec = agentMap[managedAgent]!;
          const displayName = typeof name === 'string' && name.trim() ? name.trim() : 'AgentsToZ';
          const legacyTitle = `${displayName} · ${spec.label}`;
          // Orca can refuse a worktree selector for a path it does not track. The
          // launch then falls back to the repo-independent floating workspace, so
          // both the surface and its title are decided as the request proceeds.
          let effectiveFloating: boolean = floating;
          let fallbackNotice: string | null = null;
          const titleForSurface = (asFloating: boolean): string => (asFloating
            ? buildOrcaManagedFloatingTerminalTitle(name, spec.label, managedAgent, cdPath)
            : legacyTitle);
          let terminalTitle = titleForSurface(floating);
          const reuseExistingFloatingTerminal = async (
            existing: OrcaListedTerminal,
            registryWarning: string | null = null,
          ): Promise<Response> => {
            // 생성 경로와 달리 **재사용에는 Orca의 자동 포커스가 없다.** 워크스페이스만
            // 띄우면 직전에 보던 다른 프로젝트 탭이 그대로 앞에 있어, 사용자에게는
            // "아무것도 안 열림"으로 보인다(VOC 2026-08-14). 실제로 이 기기의 floating
            // 탭 5개는 Claude가 제목을 자기 세션 요약으로 바꿔 둔 상태라 어느 탭이 어느
            // 프로젝트인지 눈으로 고를 수도 없었다. 그래서 재사용할 탭을 명시적으로 띄운다.
            //
            // 생성 경로에서 switch를 피하는 이유(메인 워크트리 패널이 빈 저장소를 그리는
            // 부작용)는 여기서도 유효하지만, 그쪽은 Orca가 새 탭을 알아서 포커스하므로
            // switch가 부작용만 남는 반면 이쪽은 그것 말고 탭을 앞으로 낼 방법이 없다.
            const switched = await nodeOrcaRunJsonRetry(
              cli,
              ['terminal', 'switch', '--terminal', existing.handle],
              { timeoutMs: 5000, attempts: 2 },
            );
            // 전환 실패가 재사용 자체를 실패로 만들지는 않는다 — 탭은 살아 있다.
            const switchWarning = switched.ok
              ? null
              : `재사용할 탭을 앞으로 가져오지 못했습니다. Orca Floating Workspace에서 직접 선택하세요. (${switched.error})`;
            const revealed = await revealOrcaFloatingWorkspace(cli);
            const revealWarning = revealed.ok ? null : revealed.error;
            const warnings = [fallbackNotice, registryWarning, switchWarning, revealWarning].filter((warning): warning is string => !!warning);
            return new Response(JSON.stringify({
              success: true,
              message: `Orca Floating Terminal의 기존 ${spec.label} 탭을 재사용했습니다`
                + (warnings.length > 0
                  ? `\n${warnings.map((warning) => `⚠ ${warning}`).join('\n')}`
                  : '')
                + (revealWarning ? ' Orca에서 Cmd/Ctrl+Alt+A를 눌러 확인하세요.' : ''),
              terminalHandle: existing.handle,
              orcaSurface: 'floating',
              worktreeId: ORCA_FLOATING_WORKTREE_ID,
              hostPlatform: existing.hostPlatform ?? null,
              reused: true,
              switchWarning,
              revealWarning,
              registryWarning,
              fallbackNotice,
            }), { headers });
          };

          // 일반 “실행”은 이미 AgentsToZ가 만든 같은 프로젝트·에이전트 탭이 있으면
          // 그 탭을 그대로 보여준다. 실행 중인 TUI에 명령을 다시 보내면 프롬프트 입력으로
          // 오인될 수 있으므로, 재사용 경로에서는 terminal send를 절대 호출하지 않는다.
          // 워크트리 폴백도 같은 규칙을 써야 클릭할 때마다 플로팅 탭이 늘어나지 않는다.
          const tryReuseFloatingTerminal = async (): Promise<Response | null> => {
            const remembered = rememberedOrcaFloatingTerminal(managedAgent, cdPath);
            if (remembered) {
              const verified = await verifyRememberedOrcaFloatingTerminal(cli, remembered);
              if (verified.state === 'valid') {
                return reuseExistingFloatingTerminal(verified.terminal);
              }
              if (verified.state === 'unavailable') {
                return new Response(JSON.stringify({
                  success: false,
                  code: 'ORCA_FLOATING_TERMINAL_LOOKUP_UNAVAILABLE',
                  error: orcaFloatingLookupUnavailableError(verified.error),
                }), { status: 503, headers });
              }
              try {
                await forgetOrcaFloatingTerminal(managedAgent, cdPath, remembered.handle);
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                return new Response(JSON.stringify({
                  success: false,
                  code: 'ORCA_FLOATING_TERMINAL_REGISTRY_UNAVAILABLE',
                  error: `오래된 Orca Floating Terminal 기록을 정리하지 못했습니다. 새 탭을 만들지 않았습니다.\n(${detail})`,
                }), { status: 503, headers });
              }
            }

            // Registry was introduced after existing titles. Use the private
            // title marker exactly once as a migration path, then persist the
            // discovered handle so later launches do not depend on its title.
            const lookup = await findExistingOrcaFloatingTerminal(cli, managedAgent, cdPath, legacyTitle);
            if (lookup.error) {
              return new Response(JSON.stringify({
                success: false,
                code: 'ORCA_FLOATING_TERMINAL_LOOKUP_UNAVAILABLE',
                error: orcaFloatingLookupUnavailableError(lookup.error),
              }), { status: 503, headers });
            }
            if (lookup.terminal) {
              let registryWarning: string | null = null;
              try {
                await rememberOrcaFloatingTerminal(managedAgent, cdPath, lookup.terminal.handle, terminalTitle);
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                console.error('[Orca Floating] failed to persist migrated terminal handle:', error);
                registryWarning = `다음 재사용용 터미널 핸들을 저장하지 못했습니다 (${detail})`;
              }
              return reuseExistingFloatingTerminal(lookup.terminal, registryWarning);
            }
            return null;
          };

          if (floating && newWindow !== true) {
            const reused = await tryReuseFloatingTerminal();
            if (reused) return reused;
          }
          if (spec.agentName && resolveAgentBin(spec.agentName) === spec.agentName) {
            return new Response(JSON.stringify({
              success: false,
              code: 'ORCA_AGENT_EXECUTABLE_NOT_FOUND',
              error: `${spec.label} 실행 파일을 찾지 못했습니다. 설치 경로와 로그인 셸 PATH를 확인한 뒤 다시 시도해주세요.`,
            }), { status: 400, headers });
          }
          if (!floating) {
            if (wtFirst && hasHiddenOrcaPathSegment(wtFirst)) return hiddenOrcaWorktreeResponse(headers);
            const reg = await orcaEnsureRepo(cli, repoPath ?? cdPath);
            if (!reg.ok) return new Response(JSON.stringify({ success: false, error: reg.error }), { status: 400, headers });
          }
          let created = floating
            ? await createOrcaFloatingTerminal(cli, terminalTitle)
            : await createOrcaWorktreeTerminal(cli, terminalTitle, cdPath);
          // Orca tracks no worktree for this path (an ordinary folder, or a repo
          // it has not indexed). The floating workspace is not bound to a
          // repository, so open there instead of failing the launch — and say so.
          if (!created.ok && !floating && shouldFallBackToOrcaFloatingTerminal(created.error)) {
            effectiveFloating = true;
            terminalTitle = titleForSurface(true);
            fallbackNotice = formatOrcaFloatingFallbackNotice(cdPath);
            if (newWindow !== true) {
              const reused = await tryReuseFloatingTerminal();
              if (reused) return reused;
            }
            created = await createOrcaFloatingTerminal(cli, terminalTitle);
          }
          if (!created.ok || !created.handle) {
            return new Response(JSON.stringify({
              success: false,
              code: effectiveFloating ? 'ORCA_FLOATING_TERMINAL_CREATE_FAILED' : 'ORCA_WORKTREE_TERMINAL_CREATE_FAILED',
              error: created.error,
            }), { status: 500, headers });
          }
          const handle = created.handle;
          // Windows Orca의 Floating은 Linux/WSL 셸이지만 worktree-owned terminal은 cmd.exe다.
          // 반환된 hostPlatform을 기준으로 경로·환경변수·인용 문법을 정확히 분리한다.
          const usesWindowsCmd = IS_WIN && created.hostPlatform !== 'linux';
          const baseAgentCommand = spec.agentName
            ? usesWindowsCmd
              ? agentCliForWindowsCmd(spec.agentName, bypass)
              : IS_WIN
                ? agentCliForWsl(spec.agentName, bypass)
                : agentCli(spec.agentName, bypass)
            : null;
          const agentCommand = baseAgentCommand && spec.suffix ? `${baseAgentCommand} ${spec.suffix}` : baseAgentCommand;
          const terminalCommand = usesWindowsCmd
            ? buildWindowsCmdOrcaCommand(cdPath, agentCommand)
            : buildOrcaFloatingCommand(IS_WIN ? winToWslPath(cdPath) : cdPath, agentCommand);
          const s = await nodeOrcaRunJsonRetry(cli, ['terminal', 'send', '--terminal', handle, '--text', terminalCommand, '--enter']);
          const surfaceLabel = effectiveFloating ? 'Floating Terminal' : '워크트리 터미널';
          if (!s.ok) return new Response(JSON.stringify({ success: false, error: `Orca ${surfaceLabel} 명령 전송 실패: ${s.error}` }), { status: 500, headers });
          if (agentCommand) {
            const launched = await verifyOrcaAgentStarted(cli, handle);
            if (!launched.ok) {
              return new Response(JSON.stringify({
                success: false,
                code: 'ORCA_AGENT_LAUNCH_FAILED',
                error: `Orca ${surfaceLabel}에서 ${spec.label} 실행 실패: ${launched.error}`,
                terminalHandle: handle,
              }), { status: 500, headers });
            }
          }
          // `terminal switch` points Orca's MAIN window at a terminal tab. In floating
          // mode the handle belongs to the `global-floating-terminal` pseudo-worktree,
          // so switching makes the main worktree pane render a worktree with no repo
          // behind it — the floating terminal opens fine while the worktree area goes
          // blank. Floating is surfaced by revealOrcaFloatingWorkspace() below instead.
          if (!effectiveFloating) {
            const switched = await nodeOrcaRunJsonRetry(cli, ['terminal', 'switch', '--terminal', handle], { timeoutMs: 5000, attempts: 2 });
            if (!switched.ok) {
              return new Response(JSON.stringify({ success: false, error: `Orca ${surfaceLabel} 화면 전환 실패: ${switched.error}` }), { status: 500, headers });
            }
          }
          const revealed = effectiveFloating
            ? await revealOrcaFloatingWorkspace(cli)
            : { ok: true, error: '' };
          const revealWarning = revealed.ok ? null : revealed.error;
          let registryWarning: string | null = null;
          if (effectiveFloating) {
            try {
              // Persist only after the command (and, for an AI, launch
              // verification) succeeded. A failed launch must never turn an
              // empty shell into the next click's reusable agent tab.
              await rememberOrcaFloatingTerminal(managedAgent, cdPath, handle, terminalTitle);
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              console.error('[Orca Floating] failed to persist created terminal handle:', error);
              registryWarning = `다음 재사용용 터미널 핸들을 저장하지 못했습니다 (${detail})`;
            }
          }
          const warnings = [fallbackNotice, registryWarning, revealWarning].filter((warning): warning is string => !!warning);
          return new Response(JSON.stringify({
            success: true,
            message: `Orca ${surfaceLabel}에 ${spec.label}${bypass && agentCommand ? ' ⚡' : ''} 명령 전송 완료`
              + (warnings.length > 0
                ? `\n${warnings.map((warning) => `⚠ ${warning}`).join('\n')}`
                : '')
              + (revealWarning ? ' Orca에서 Cmd/Ctrl+Alt+A를 눌러 확인하세요.' : ''),
            terminalHandle: handle,
            orcaSurface: effectiveFloating ? 'floating' : 'worktree',
            worktreeId: created.worktreeId ?? null,
            hostPlatform: created.hostPlatform ?? null,
            reused: false,
            revealWarning,
            registryWarning,
            fallbackNotice,
          }), { headers });
        });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    // Orca localhost — 선택한 프로젝트/워크트리 안에 브라우저 탭을 생성한다.
    // `repo add`는 멱등이므로 기존 프로젝트는 그대로 재사용하고, 등록되지 않은
    // 프로젝트만 Orca에 추가한다. "최근 프로젝트" 추측 대신 사용자가 누른
    // 프로젝트를 정확히 지정해 엉뚱한 워크스페이스에 탭이 생기지 않게 한다.
    if (url.pathname === "/api/open-orca-localhost" && req.method === "POST") {
      try {
        const { port, folderPath, worktreePath, floating = false } = await req.json();
        // `floating`은 v198 이하 클라이언트 호환용으로 받는다. Orca의
        // global-floating-terminal은 터미널 전용이라 browser tab selector로 쓸 수 없다.
        // 브라우저는 사용자가 누른 프로젝트/워크트리에 정확히 연결한다.
        const requestedFloating = floating === true;
        const portNumber = Number(port);
        if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
          return new Response(JSON.stringify({ success: false, error: '올바른 포트 번호가 필요합니다.' }), { status: 400, headers });
        }
        const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
        const repoPath = resolveOrcaProjectPath(folderPath ? expand(String(folderPath).trim()) : null);
        const wtRaw = worktreePath ? (String(worktreePath).split(',')[0] ?? '').trim() : '';
        const wtFirst = resolveOrcaProjectPath(wtRaw ? expand(wtRaw) : null);
        const cdPath = wtFirst || repoPath;
        if (!cdPath) {
          return new Response(JSON.stringify({ success: false, error: '프로젝트 경로가 없습니다.' }), { status: 400, headers });
        }
        if (wtFirst && hasHiddenOrcaPathSegment(wtFirst)) return hiddenOrcaWorktreeResponse(headers);

        const cli = resolveOrcaCli();
        if (!cli) return new Response(JSON.stringify({ success: false, error: bootstrapOrcaInstall() }), { status: 400, headers });

        return await withOrcaLock(async () => {
          const ready = await ensureOrcaReady(cli);
          if (!ready.ok) return new Response(JSON.stringify({ success: false, error: ready.error }), { status: 500, headers });

          const worktreeSelector = `path:${cdPath}`;
          const reg = await orcaEnsureRepo(cli, repoPath ?? cdPath, { timeoutMs: 5000, attempts: 1 });
          if (!reg.ok) return new Response(JSON.stringify({ success: false, error: reg.error }), { status: 400, headers });

          const localhostUrl = `http://localhost:${portNumber}`;
          const created = await nodeOrcaRunJsonRetry(
            cli,
            ['tab', 'create', '--url', localhostUrl, '--worktree', worktreeSelector],
            { attempts: 1, timeoutMs: 8000 },
          );
          if (!created.ok) {
            return new Response(JSON.stringify({ success: false, error: `Orca localhost 탭 생성 실패: ${created.error}` }), { status: 500, headers });
          }
          const browserPageId = created.result?.browserPageId;
          if (typeof browserPageId !== 'string' || !browserPageId.trim()) {
            return new Response(JSON.stringify({
              success: false,
              code: 'ORCA_BROWSER_PAGE_ID_MISSING',
              error: 'Orca가 브라우저 page ID를 반환하지 않아 탭 생성을 확인할 수 없습니다.',
            }), { status: 500, headers });
          }

          // `tab create`가 {ok:true,browserPageId}를 반환한 뒤 실제 페이지를 등록하지 않는
          // Orca 외부-worktree 경로가 있다. 반환값만 믿지 않고 exact page를 다시 조회한다.
          const shown = await nodeOrcaRunJsonRetry(
            cli,
            ['tab', 'show', '--page', browserPageId],
            { attempts: 2, backoffMs: 200, timeoutMs: 2000 },
          );
          const verifiedPage = shown.ok
            ? verifyOrcaBrowserPage(created.result, shown.result, localhostUrl)
            : null;
          if (!verifiedPage) {
            // 부분 생성된 페이지가 있으면 exact ID로만 정리한다. not-found는 멱등 성공 취급.
            await nodeOrcaRunJsonRetry(
              cli,
              ['tab', 'close', '--page', browserPageId],
              { attempts: 1, timeoutMs: 5000 },
            ).catch(() => undefined);
            return new Response(JSON.stringify({
              success: false,
              code: 'ORCA_BROWSER_TAB_NOT_VERIFIED',
              error: 'Orca가 성공을 반환했지만 실제 브라우저 탭을 확인하지 못했습니다. 이 워크트리가 Orca 사이드바에 표시되는지 확인하거나 Orca 관리 워크트리로 다시 만들어주세요.',
            }), { status: 409, headers });
          }
          return new Response(JSON.stringify({
            success: true,
            browserPageId: verifiedPage.browserPageId,
            message: `Orca 프로젝트에서 localhost:${portNumber} 열림`
              + (requestedFloating
                ? '\n브라우저 탭은 선택한 프로젝트에 연결했습니다. 플로팅 설정은 AI 터미널에만 적용됩니다.'
                : ''),
            revealWarning: null,
          }), { headers });
        });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    // Orca app endpoint — terminalApp='orca' 선택 시 Orca.app만 열기 (repo/terminal 생성 없음)
    if (url.pathname === "/api/open-orca-app" && req.method === "POST") {
      try {
        const cli = resolveOrcaCli();
        if (!cli) return new Response(JSON.stringify({ success: false, error: bootstrapOrcaInstall() }), { status: 400, headers });

        return await withOrcaLock(async () => {
          const ready = await ensureOrcaReady(cli);
          if (!ready.ok) return new Response(JSON.stringify({ success: false, error: ready.error }), { status: 500, headers });

          return new Response(JSON.stringify({ success: true, message: 'Orca 워크스페이스를 열었습니다' }), { headers });
        });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    // tmux codex/agy endpoints — iterm/terminal 모드에서 tmux 세션으로 실행
    if (url.pathname === "/api/open-tmux-codex" && req.method === "POST") {
      try {
        const { sessionName, folderPath, worktreePath, branch, bypass = false, terminalApp = 'iterm', fresh = false } = await req.json();
        // Claude와 같은 규칙 — 예전엔 Codex만 bare 이름을 써서 메인트리·워크트리가
        // 한 세션을 공유했고 ⚡가 일반 세션에 조용히 attach 됐다.
        const session = tmuxSessionName(sessionName, worktreePath ?? null, bypass === true);
        const codexCli = terminalAgentCli('codex', bypass);
        const tags: string[] = bypass ? ['tmux', 'bypass'] : ['tmux'];
        if (fresh === true) tags.splice(1, 0, 'fresh');
        const title = buildWindowTitle(sessionName, worktreePath, tags, branch ?? null);
        let launch: TerminalLaunchOutcome = { verified: true };
        if (IS_WIN) {
          // WSL tmux 미지원 → openTerminalWithCmd()로 자동 폴백
          const cdPath = worktreePath ? worktreePath.split(',')[0].trim() : (folderPath ?? null);
          const windowsLaunch = await openTerminalWithCmd(codexCli, cdPath, title);
          return new Response(JSON.stringify(launchPayload(`Codex${bypass ? ' ⚡' : ''} 실행 중 (Windows Terminal)`, windowsLaunch)), { headers });
        } else {
          const esc = escapeSq(session);
          const winName = escapeSq(title);
          // "새 창"은 같은 이름의 기존 세션을 먼저 없애야 실제로 새 세션이 된다.
          // 기본 실행은 new-session 실패를 무시하고 attach — 있으면 기존 창, 없으면 새 창.
          const killFirst = fresh === true ? `tmux kill-session -t '${esc}' 2>/dev/null; ` : '';
          const tmuxCmd = `${killFirst}tmux new-session -d -s '${esc}' -n '${winName}' 'zsh -l -c "${codexCli}"' 2>/dev/null; tmux set-option -g set-titles on 2>/dev/null; tmux set-option -g set-titles-string '#W' 2>/dev/null; tmux set-window-option -t '${esc}' automatic-rename off 2>/dev/null; tmux rename-window -t '${esc}' '${winName}' 2>/dev/null; tmux attach-session -t '${esc}'`;
          const cdPath = worktreePath ? worktreePath.split(',')[0].trim() : (folderPath ?? null);
          launch = await openTerminalWithCmd(tmuxCmd, cdPath, title, terminalApp === 'terminal' ? 'terminal' : 'iterm');
        }
        return new Response(JSON.stringify(launchPayload(`Codex${bypass ? ' ⚡' : ''} ${fresh === true ? '새 세션 시작' : '실행 중'} (세션: ${session})`, launch)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-tmux-agy" && req.method === "POST") {
      try {
        const { sessionName, folderPath, worktreePath, branch, bypass = false, terminalApp = 'iterm', fresh = false } = await req.json();
        // Codex와 같은 규칙 — 세션명 계산은 tmuxSessionName() 하나뿐이다.
        const session = tmuxSessionName(sessionName, worktreePath ?? null, bypass === true);
        const agyCli = terminalAgentCli('agy', bypass);
        const tags: string[] = bypass ? ['tmux', 'bypass'] : ['tmux'];
        if (fresh === true) tags.splice(1, 0, 'fresh');
        const title = buildWindowTitle(sessionName, worktreePath, tags, branch ?? null);
        let launch: TerminalLaunchOutcome = { verified: true };
        if (IS_WIN) {
          // WSL tmux 미지원 → openTerminalWithCmd()로 자동 폴백
          const cdPath = worktreePath ? worktreePath.split(',')[0].trim() : (folderPath ?? null);
          const windowsLaunch = await openTerminalWithCmd(agyCli, cdPath, title);
          return new Response(JSON.stringify(launchPayload(`Antigravity${bypass ? ' ⚡' : ''} 실행 중 (Windows Terminal)`, windowsLaunch)), { headers });
        } else {
          const esc = escapeSq(session);
          const winName = escapeSq(title);
          const killFirst = fresh === true ? `tmux kill-session -t '${esc}' 2>/dev/null; ` : '';
          const tmuxCmd = `${killFirst}tmux new-session -d -s '${esc}' -n '${winName}' 'zsh -l -c "${agyCli}"' 2>/dev/null; tmux set-option -g set-titles on 2>/dev/null; tmux set-option -g set-titles-string '#W' 2>/dev/null; tmux set-window-option -t '${esc}' automatic-rename off 2>/dev/null; tmux rename-window -t '${esc}' '${winName}' 2>/dev/null; tmux attach-session -t '${esc}'`;
          const cdPath = worktreePath ? worktreePath.split(',')[0].trim() : (folderPath ?? null);
          launch = await openTerminalWithCmd(tmuxCmd, cdPath, title, terminalApp === 'terminal' ? 'terminal' : 'iterm');
        }
        return new Response(JSON.stringify(launchPayload(`Antigravity${bypass ? ' ⚡' : ''} ${fresh === true ? '새 세션 시작' : '실행 중'} (세션: ${session})`, launch)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-cmux-claude-new" && req.method === "POST") {
      if (IS_WIN) return new Response(JSON.stringify({ error: 'cmux는 맥에서만 가능합니다' }), { status: 400, headers });
      try {
        const { folderPath, worktreePath, bypass = false, name = '' } = await req.json();
        const cdPath = (worktreePath ? worktreePath.split(',')[0].trim() : null) || folderPath;
        if (!cdPath) {
          return new Response(JSON.stringify({ success: false, error: '프로젝트 경로가 없습니다.' }), { status: 400, headers });
        }
        const claudeCli = agentCli('claude', bypass);
        const title = buildCmuxTitle(name || 'claude', worktreePath, bypass);

        const cli = resolveCmuxCli();
        if (!cli && !cmuxAppExists()) {
          return new Response(JSON.stringify({ error: 'cmux가 설치되지 않았습니다.\n설치: brew tap manaflow-ai/cmux && brew install --cask cmux' }), { status: 400, headers });
        }
        if (cmuxAppExists()) nodeSpawnSync('open', ['-a', 'cmux'], { stdio: 'pipe' });
        const cliPath = cli ?? 'cmux';
        if (!(await waitCmuxReadyNode(cliPath))) {
          return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp('cmux 소켓 준비 대기 시간 초과 (10초)') }), { status: 500, headers });
        }
        const ws = nodeCmuxRun(cliPath, ['new-workspace', '--cwd', cdPath, '--command', claudeCli, '--name', title]);
        if (!ws.ok) {
          return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp(`cmux new-workspace 실패: ${ws.stderr || 'unknown'}`) }), { status: 500, headers });
        }
        return new Response(JSON.stringify({ success: true, message: `cmux 새창${bypass ? ' bypass' : ''} 시작 ↺` }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-cmux-terminal" && req.method === "POST") {
      if (IS_WIN) return new Response(JSON.stringify({ error: 'cmux는 맥에서만 가능합니다' }), { status: 400, headers });
      try {
        const { folderPath, name = '' } = await req.json();
        // Empty/missing path → fall back to $HOME (root area).
        const cdPath = (folderPath && String(folderPath).trim()) || homedir() || '/';
        const cli = resolveCmuxCli();
        if (!cli && !cmuxAppExists()) {
          return new Response(JSON.stringify({ error: 'cmux가 설치되지 않았습니다.\n설치: brew tap manaflow-ai/cmux && brew install --cask cmux' }), { status: 400, headers });
        }
        if (cmuxAppExists()) nodeSpawnSync('open', ['-a', 'cmux'], { stdio: 'pipe' });
        const cliPath = cli ?? 'cmux';
        if (!(await waitCmuxReadyNode(cliPath))) {
          return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp('cmux 소켓 준비 대기 시간 초과 (10초)') }), { status: 500, headers });
        }
        const baseName = (name && String(name).trim()) || cdPath.split('/').filter(Boolean).pop() || 'terminal';
        const title = `🪟 ${baseName}`;
        const ws = nodeCmuxRun(cliPath, ['new-workspace', '--cwd', cdPath, '--name', title]);
        if (!ws.ok) {
          return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp(`cmux new-workspace 실패: ${ws.stderr || 'unknown'}`) }), { status: 500, headers });
        }
        return new Response(JSON.stringify({ success: true, message: 'cmux 터미널 열림' }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-cmux-localhost" && req.method === "POST") {
      if (IS_WIN) return new Response(JSON.stringify({ error: 'cmux는 맥에서만 가능합니다' }), { status: 400, headers });
      try {
        const { port, name = '' } = await req.json();
        if (!port) return new Response(JSON.stringify({ success: false, error: '포트 번호가 없습니다.' }), { status: 400, headers });
        const targetUrl = `http://localhost:${port}`;
        const cli = resolveCmuxCli();
        if (!cli && !cmuxAppExists()) {
          return new Response(JSON.stringify({ error: 'cmux가 설치되지 않았습니다.\n설치: brew tap manaflow-ai/cmux && brew install --cask cmux' }), { status: 400, headers });
        }
        if (cmuxAppExists()) nodeSpawnSync('open', ['-a', 'cmux'], { stdio: 'pipe' });
        const cliPath = cli ?? 'cmux';
        if (!(await waitCmuxReadyNode(cliPath))) {
          return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp('cmux 소켓 준비 대기 시간 초과 (10초)') }), { status: 500, headers });
        }
        const result = nodeCmuxRun(cliPath, ['new-pane', '--type', 'browser', '--url', targetUrl, '--focus', 'true']);
        if (!result.ok) {
          return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp(`cmux browser open 실패: ${result.stderr || 'unknown'}`) }), { status: 500, headers });
        }
        return new Response(JSON.stringify({ success: true, message: `cmux 브라우저로 localhost:${port} 열림` }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-cmux-tmux" && req.method === "POST") {
      if (IS_WIN) return new Response(JSON.stringify({ error: 'cmux는 맥에서만 가능합니다' }), { status: 400, headers });
      try {
        const { folderPath, worktreePath, bypass = false, name = '', fresh = false } = await req.json();
        const cdPath = (worktreePath ? worktreePath.split(',')[0].trim() : null) || folderPath;
        if (!cdPath) return new Response(JSON.stringify({ success: false, error: '프로젝트 경로가 없습니다.' }), { status: 400, headers });
        const claudeCli = agentCli('claude', bypass);
        const sessionName = (name || cdPath.split('/').filter(Boolean).pop() || 'port').replace(/[^a-zA-Z0-9_-]/g, '_');
        const tmuxCmd = fresh
          ? `tmux kill-session -t ${sessionName} 2>/dev/null; tmux new-session -s ${sessionName} -c '${cdPath}' ${claudeCli}`
          : `tmux new-session -A -s ${sessionName} -c '${cdPath}' ${claudeCli}`;
        const title = buildCmuxTitle((name || sessionName) + ' (tmux)', worktreePath, bypass);
        const cli = resolveCmuxCli();
        if (!cli && !cmuxAppExists()) return new Response(JSON.stringify({ error: 'cmux가 설치되지 않았습니다.' }), { status: 400, headers });
        if (cmuxAppExists()) nodeSpawnSync('open', ['-a', 'cmux'], { stdio: 'pipe' });
        const cliPath = cli ?? 'cmux';
        if (!(await waitCmuxReadyNode(cliPath))) return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp('cmux 소켓 준비 대기 시간 초과') }), { status: 500, headers });
        const ws = nodeCmuxRun(cliPath, ['new-workspace', '--cwd', cdPath, '--command', tmuxCmd, '--name', title]);
        if (!ws.ok) return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp(`cmux tmux 실패: ${ws.stderr || 'unknown'}`) }), { status: 500, headers });
        return new Response(JSON.stringify({ success: true, message: `cmux tmux${bypass ? ' bypass' : ''} 실행 중` }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-cmux-agent-view" && req.method === "POST") {
      // Windows: WSL fallback
      if (IS_WIN) {
        try {
          const { bypass = false } = await req.json().catch(() => ({}));
          const claudeCmd = bypass ? 'claude --dangerously-skip-permissions agents' : 'claude agents';
          spawnWslTmux(claudeCmd, '🤖 Agent View');
          return new Response(JSON.stringify({ success: true, message: 'WSL에서 claude agents 열림' }), { headers });
        } catch (e: any) {
          return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers });
        }
      }
      try {
        const cli = resolveCmuxCli();
        if (!cli && !cmuxAppExists()) {
          return new Response(JSON.stringify({ error: 'cmux가 설치되지 않았습니다.\n설치: brew tap manaflow-ai/cmux && brew install --cask cmux' }), { status: 400, headers });
        }
        if (cmuxAppExists()) nodeSpawnSync('open', ['-a', 'cmux'], { stdio: 'pipe' });
        const cliPath = cli ?? 'cmux';
        if (!(await waitCmuxReadyNode(cliPath))) {
          return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp('cmux 소켓 준비 대기 시간 초과 (10초)') }), { status: 500, headers });
        }
        const { bypass = false } = await req.json().catch(() => ({}));
        const cdPath = homedir() || '/';
        const claudeCmd = bypass ? `${CLAUDE_PATH ?? 'claude'} --dangerously-skip-permissions agents` : `${CLAUDE_PATH ?? 'claude'} agents`;
        const ws = nodeCmuxRun(cliPath, ['new-workspace', '--cwd', cdPath, '--command', claudeCmd, '--name', '🤖 Agent View']);
        if (!ws.ok) {
          return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp(`cmux new-workspace 실패: ${ws.stderr || 'unknown'}`) }), { status: 500, headers });
        }
        return new Response(JSON.stringify({ success: true, message: 'cmux Agent View 열림' }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-terminal-agent-view" && req.method === "POST") {
      try {
        const { terminalApp = 'iterm', bypass = false, folderPath, name = '' } = await req.json().catch(() => ({}));
        const rawPath = folderPath && String(folderPath).trim();
        const targetPath = rawPath === '~'
          ? homedir()
          : rawPath?.startsWith('~/')
            ? join(homedir(), rawPath.slice(2))
            : rawPath || homedir();
        if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) {
          throw new Error(`폴더를 찾을 수 없습니다: ${targetPath}`);
        }
        const baseName = (name && String(name).trim()) || targetPath.split(/[/\\]/).filter(Boolean).pop() || 'project';
        const title = `🤖 ${baseName} agents`;
        const selectedTerminal = terminalApp === 'terminal' ? 'terminal' : 'iterm';
        const command = `${terminalAgentCli('claude', bypass === true)} agents`;
        const outcome = await openTerminalWithCmd(command, targetPath, title, selectedTerminal);
        const terminalLabel = IS_WIN ? 'Windows Terminal' : selectedTerminal === 'terminal' ? 'Terminal' : 'iTerm';
        return new Response(JSON.stringify(launchPayload(`${terminalLabel}에서 Claude Agents 실행 (${baseName})`, outcome)), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-cmux-project-agents" && req.method === "POST") {
      // Windows: WSL fallback
      if (IS_WIN) {
        try {
          const { folderPath, name = '', bypass = false } = await req.json();
          const rawPath = folderPath && String(folderPath).trim();
          const resolvedPath = rawPath === '~'
            ? homedir()
            : rawPath?.startsWith('~/')
              ? join(homedir(), rawPath.slice(2))
              : rawPath;
          const wslPath = resolvedPath ? winToWslPath(resolvedPath) : null;
          const cdPart = wslPath ? `cd '${escapeSq(wslPath)}' && ` : '';
          const baseName = (name && String(name).trim()) || (resolvedPath?.split(/[/\\]/).filter(Boolean).pop()) || 'project';
          const claudeCmd = bypass ? `${cdPart}claude --dangerously-skip-permissions agents` : `${cdPart}claude agents`;
          spawnWslTmux(claudeCmd, `🤖 ${baseName} agents`);
          return new Response(JSON.stringify({ success: true, message: `WSL에서 claude agents 열림 (${baseName})` }), { headers });
        } catch (e: any) {
          return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers });
        }
      }
      try {
        const { folderPath, name = '', bypass = false } = await req.json();
        const rawPath = folderPath && String(folderPath).trim();
        const cdPath = rawPath === '~'
          ? homedir()
          : rawPath?.startsWith('~/')
            ? join(homedir(), rawPath.slice(2))
            : rawPath || homedir() || '/';
        if (!existsSync(cdPath) || !statSync(cdPath).isDirectory()) {
          throw new Error(`폴더를 찾을 수 없습니다: ${cdPath}`);
        }
        const cli = resolveCmuxCli();
        if (!cli && !cmuxAppExists()) {
          return new Response(JSON.stringify({ error: 'cmux가 설치되지 않았습니다.\n설치: brew tap manaflow-ai/cmux && brew install --cask cmux' }), { status: 400, headers });
        }
        if (cmuxAppExists()) nodeSpawnSync('open', ['-a', 'cmux'], { stdio: 'pipe' });
        const cliPath = cli ?? 'cmux';
        if (!(await waitCmuxReadyNode(cliPath))) {
          return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp('cmux 소켓 준비 대기 시간 초과 (10초)') }), { status: 500, headers });
        }
        const baseName = (name && String(name).trim()) || cdPath.split('/').filter(Boolean).pop() || 'project';
        const title = `🤖 ${baseName} agents`;
        const claudeCmd2 = bypass ? `${CLAUDE_PATH ?? 'claude'} --dangerously-skip-permissions agents` : `${CLAUDE_PATH ?? 'claude'} agents`;
        const ws = nodeCmuxRun(cliPath, ['new-workspace', '--cwd', cdPath, '--command', claudeCmd2, '--name', title]);
        if (!ws.ok) {
          return new Response(JSON.stringify({ success: false, error: cmuxAccessHelp(`cmux new-workspace 실패: ${ws.stderr || 'unknown'}`) }), { status: 500, headers });
        }
        return new Response(JSON.stringify({ success: true, message: `cmux Agent View 열림 (${baseName})` }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-claude-bg" && req.method === "POST") {
      // Windows: WSL에서 claude --bg 실행
      if (IS_WIN) {
        try {
          const { folderPath, name = '', bypass = false } = await req.json();
          const rawPath = folderPath && String(folderPath).trim();
          const wslPath = rawPath ? winToWslPath(rawPath) : null;
          const cdPart = wslPath ? `cd '${escapeSq(wslPath)}' && ` : '';
          const label = (name && String(name).trim()) || (rawPath?.split(/[/\\]/).filter(Boolean).pop()) || 'project';
          const bgArgs = bypass
            ? `claude --dangerously-skip-permissions --bg '${escapeSq(label)} 작업 시작'`
            : `claude --bg '${escapeSq(label)} 작업 시작'`;
          // --bg는 claude가 백그라운드 에이전트를 spawn하고 바로 종료 → async spawn으로 이벤트 루프 blocking 방지
          const distro = findWslDistro();
          if (!distro) throw new Error('WSL Ubuntu distro를 찾을 수 없습니다. wsl 모드 설정 후 다시 시도하세요.');
          spawn({ cmd: ['wsl', '-d', distro, '--', 'bash', '-lc', `${cdPart}${bgArgs}`], stdout: 'pipe', stderr: 'pipe' });
          return new Response(JSON.stringify({ success: true, message: `WSL에서 claude --bg 시작 (${label})` }), { headers });
        } catch (e: any) {
          return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers });
        }
      }
      try {
        const { folderPath, name = '', bypass = false } = await req.json();
        const rawPath = folderPath && String(folderPath).trim();
        // ~ 확장: existsSync('~/.claude')는 false이므로 미리 절대경로로 치환
        const expandedPath = rawPath?.startsWith('~/') ? `${homedir()}/${rawPath.slice(2)}` : rawPath === '~' ? homedir() : rawPath;
        // cwd가 없으면 posix_spawn이 binary ENOENT로 오해하는 Node.js quirk 방지
        const cdPath = (expandedPath && existsSync(expandedPath)) ? expandedPath : homedir();
        const claudeCli = CLAUDE_PATH ?? 'claude';
        const label = (name && String(name).trim()) || cdPath.split('/').filter(Boolean).pop() || 'project';
        const bgArgs = bypass
          ? ['--dangerously-skip-permissions', '--bg', `${label} 작업 시작`]
          : ['--bg', `${label} 작업 시작`];
        // claude --bg는 내부적으로 다른 claude 프로세스를 PATH에서 찾아 spawn한다.
        // GUI 앱 환경에서는 PATH가 제한적이므로, claude 바이너리 디렉토리를 PATH에 명시적으로 추가한다.
        const claudeDir = claudeCli.includes('/') ? claudeCli.substring(0, claudeCli.lastIndexOf('/')) : '';
        const enhancedPath = claudeDir
          ? `${claudeDir}:${process.env.PATH || '/usr/bin:/bin'}`
          : process.env.PATH;
        const r = nodeSpawnSync(claudeCli, bgArgs, {
          cwd: cdPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 15000,
          env: { ...process.env, PATH: enhancedPath },
        });
        if (r.error || r.status !== 0) {
          const spawnErr = r.error?.message ?? '';
          const stderr = (r.stderr ?? '').trim();
          const stdout = (r.stdout ?? '').trim();
          const detail = spawnErr || stderr || stdout || '알 수 없는 오류';
          // bypass + disclaimer 미동의 → bypass 없이 자동 재시도
          if (bypass && detail.includes('disclaimer')) {
            const r2 = nodeSpawnSync(claudeCli, ['--bg', `${label} 작업 시작`], {
              cwd: cdPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
              timeout: 15000, env: { ...process.env, PATH: enhancedPath },
            });
            if (!r2.error && r2.status === 0) {
              return new Response(JSON.stringify({
                success: true,
                message: `agent view에 등록됨: ${label} (bypass 미동의 — 일반 모드로 실행됨)`,
                output: (r2.stdout || '').trim(),
              }), { headers });
            }
          }
          return new Response(JSON.stringify({ success: false, error: detail }), { status: 500, headers });
        }
        const output = (r.stdout || '').trim();
        return new Response(JSON.stringify({ success: true, message: `agent view에 등록됨: ${label}`, output }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname.startsWith("/api/open-log/") && req.method === "GET") {
      let portId = '';
      try {
        portId = decodeURIComponent(url.pathname.slice("/api/open-log/".length));
      } catch {
        return new Response(JSON.stringify({ code: 'INVALID_PORT_ID', error: 'portId 인코딩이 올바르지 않습니다.' }), { status: 400, headers });
      }
      if (!isSafeLogId(portId)) {
        return new Response(JSON.stringify({
          code: 'INVALID_PORT_ID',
          error: 'portId는 1~128자의 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 사용할 수 있습니다.',
        }), { status: 400, headers });
      }
      try {
        const logsDir = join(APP_DATA_DIR, "logs");
        const logFile = join(logsDir, `${portId}.log`);
        if (!existsSync(logFile)) {
          await Bun.write(logFile, "로그가 아직 생성되지 않았습니다.\n");
        }
        const sqEscaped = logFile.replace(/'/g, "'\\''");
        if (!IS_WIN) {
          // `create window ... command` 방식은 클립보드를 사용하지 않음 (write text 클립보드 오염 방지)
          const script = `tell application "iTerm"\n  activate\n  create window with default profile command "tail -f '${sqEscaped}'"\nend tell`;
          await runAppleScriptChecked(script);
        } else {
          const psEscaped = logFile.replace(/'/g, "''");
          await openTerminalWithCmd(`powershell -Command "Get-Content -Path '${psEscaped}' -Wait -Tail 50"`, null, `Log: ${portId}`);
        }
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    // GET /api/log-content/:portId?offset=N — read log file content with optional offset
    if (url.pathname.startsWith("/api/log-content/") && req.method === "GET") {
      let portId = '';
      try {
        portId = decodeURIComponent(url.pathname.slice("/api/log-content/".length));
      } catch {
        return new Response(JSON.stringify({ code: 'INVALID_PORT_ID', error: 'portId 인코딩이 올바르지 않습니다.' }), { status: 400, headers });
      }
      if (!isSafeLogId(portId)) {
        return new Response(JSON.stringify({
          code: 'INVALID_PORT_ID',
          error: 'portId는 1~128자의 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 사용할 수 있습니다.',
        }), { status: 400, headers });
      }
      try {
        const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
        const logsDir = join(APP_DATA_DIR, "logs");
        const logFile = join(logsDir, `${portId}.log`);
        if (!existsSync(logFile)) {
          return new Response(JSON.stringify({ content: '', size: 0, exists: false }), { headers });
        }
        // Use byte-based offset (consistent with stat.size and Tauri's read_log_content).
        // 메모리 안전: 전체 파일을 절대 메모리에 올리지 않는다 — stat으로 size만 확인하고,
        // 필요한 바이트 범위만 file.slice()로 읽는다. 1초 폴링 steady state(offset == size)
        // 에서는 빈 응답을 반환 (기존 코드는 이 경우 전체 파일을 반환하는 off-by-one 버그).
        const MAX_TAIL_BYTES = 256 * 1024; // 응답 1회당 최대 256KB
        const file = Bun.file(logFile);
        const size = file.size; // stat only — no read
        let content = '';
        if (offset >= size) {
          // steady state(offset == size) 또는 파일 truncation(offset > size).
          // truncation은 클라이언트가 size < offset을 보고 자체 리셋하므로 빈 내용 + 실제 size 반환.
          content = '';
        } else if (offset > 0) {
          // 델타 읽기 — 델타가 MAX_TAIL_BYTES보다 크면 마지막 MAX_TAIL_BYTES만 읽기
          const start = size - offset > MAX_TAIL_BYTES ? size - MAX_TAIL_BYTES : offset;
          content = await file.slice(start).text();
          if (start > offset) {
            // 중간에서 잘랐으면 UTF-8/라인 경계가 깨질 수 있어 첫 부분 라인 제거
            const nl = content.indexOf('\n');
            if (nl !== -1) content = content.slice(nl + 1);
          }
        } else {
          // offset === 0: 첫 요청은 tail만 반환 (전체 파일 금지)
          const start = Math.max(0, size - MAX_TAIL_BYTES);
          content = await file.slice(start).text();
          if (start > 0) {
            const nl = content.indexOf('\n');
            if (nl !== -1) content = content.slice(nl + 1);
          }
        }
        // 항상 실제 size를 반환 — 클라이언트는 이 값으로 다음 offset을 전진시킴
        return new Response(JSON.stringify({ content, size, exists: true, offset }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/send-tmux-keys" && req.method === "POST") {
      try {
        const { sessionName, text } = await req.json();
        if (IS_WIN) {
          const wslCmd = `tmux send-keys -t '${escapeSq(sessionName)}' '${escapeSq(text)}' Enter`;
          Bun.spawnSync(['wsl', '--', 'bash', '-c', wslCmd], { stdout: 'pipe', stderr: 'pipe' });
        } else {
          const result = Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, text, 'Enter'], { stdout: 'pipe', stderr: 'pipe' });
          if (result.exitCode !== 0) {
            const err = new TextDecoder().decode(result.stderr).trim();
            throw new Error(`tmux send-keys 실패: ${err}`);
          }
        }
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/check-wsl" && req.method === "GET") {
      if (!IS_WIN) return new Response(JSON.stringify({ status: 'ready' }), { headers });
      try {
        const wslExists = Bun.spawnSync(['where', 'wsl.exe'], { stdout: 'pipe', stderr: 'pipe' }).exitCode === 0;
        if (!wslExists) return new Response(JSON.stringify({ status: 'not_installed' }), { headers });
        const distro = findWslDistro();
        if (!distro) return new Response(JSON.stringify({ status: 'no_distro' }), { headers });
        // bash timeout이 Windows/WSL에서 불가능 → 목록 확인만으로 판단
        return new Response(JSON.stringify({ status: 'ready' }), { headers });
      } catch {
        return new Response(JSON.stringify({ status: 'not_installed' }), { headers });
      }
    }

    if (url.pathname === "/api/check-claude" && req.method === "GET") {
      try {
        const cmd = IS_WIN ? ['where', 'claude'] : ['which', 'claude'];
        const result = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
        const path = new TextDecoder().decode(result.stdout).trim();
        return new Response(JSON.stringify({ installed: result.exitCode === 0, path }), { headers });
      } catch {
        return new Response(JSON.stringify({ installed: false, path: '' }), { headers });
      }
    }

    if (url.pathname === "/api/check-tmux" && req.method === "GET") {
      try {
        const cmd = IS_WIN ? ['wsl', '--', 'which', 'tmux'] : ['which', 'tmux'];
        const result = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
        const path = new TextDecoder().decode(result.stdout).trim();
        return new Response(JSON.stringify({ installed: result.exitCode === 0, path }), { headers });
      } catch {
        return new Response(JSON.stringify({ installed: false, path: '' }), { headers });
      }
    }

    if (url.pathname === "/api/install-wsl-tmux" && req.method === "POST") {
      if (!IS_WIN) return new Response(JSON.stringify({ success: true }), { headers });
      try {
        const distro = findWslDistro();
        if (!distro) return new Response(JSON.stringify({ success: false, error: 'Ubuntu WSL distro를 찾을 수 없습니다.' }), { status: 500, headers });
        const whoami = Bun.spawnSync(['wsl', '-d', distro, '--', 'bash', '-c', 'whoami'], { stdout: 'pipe', stderr: 'pipe' });
        const isRoot = new TextDecoder().decode(whoami.stdout).trim() === 'root';
        const installCmd = isRoot
          ? 'apt-get update -qq && apt-get install -y tmux'
          : 'sudo apt-get update -qq && sudo apt-get install -y tmux';
        const out = Bun.spawnSync(['wsl', '-d', distro, '--', 'bash', '-c', installCmd], { stdout: 'pipe', stderr: 'pipe', timeout: 120000 });
        if (out.exitCode === 0) return new Response(JSON.stringify({ success: true }), { headers });
        return new Response(JSON.stringify({ success: false, error: new TextDecoder().decode(out.stderr) }), { status: 500, headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/run-claude-with-prompt" && req.method === "POST") {
      try {
        const { folderPath, prompt } = await req.json();
        const claudeCmd = terminalAgentCli('claude', false);
        await openTerminalWithCmd(claudeCmd, folderPath ?? null, 'Claude');
        // Windows: prompt auto-send not supported via wt.exe (no stdin injection)
        const msg = IS_WIN
          ? 'Claude 실행됨 (Windows — 프롬프트 자동 전송 불가, 직접 입력하세요)'
          : 'Claude 실행 + 프롬프트 자동 전송';
        return new Response(JSON.stringify({ success: true, message: msg }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-terminal-claude" && req.method === "POST") {
      try {
        const { folderPath, name, worktreePath, terminalApp = 'iterm' } = await req.json();
        const cdPath = worktreePath ? worktreePath.split(',')[0].trim() : (folderPath ?? null);
        const claudeCmd = terminalAgentCli('claude', false);
        const launch = await openTerminalWithCmd(claudeCmd, cdPath, buildWindowTitle(name || 'Claude', worktreePath), terminalApp === 'terminal' ? 'terminal' : 'iterm');
        return new Response(JSON.stringify(launchPayload(`${terminalApp === 'terminal' ? 'Terminal' : 'iTerm'}에서 Claude 실행`, launch)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-terminal-codex" && req.method === "POST") {
      try {
        const { folderPath, name, worktreePath, bypass = false, terminalApp = 'iterm' } = await req.json();
        const cdPath = worktreePath ? worktreePath.split(',')[0].trim() : (folderPath ?? null);
        const codexCmd = terminalAgentCli('codex', bypass);
        const launch = await openTerminalWithCmd(codexCmd, cdPath, buildWindowTitle(name || 'Codex', worktreePath, bypass ? 'bypass' : undefined), terminalApp === 'terminal' ? 'terminal' : 'iterm');
        return new Response(JSON.stringify(launchPayload(`${terminalApp === 'terminal' ? 'Terminal' : 'iTerm'}에서 Codex${bypass ? ' ⚡' : ''} 실행`, launch)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-terminal-agy" && req.method === "POST") {
      try {
        const { folderPath, name, worktreePath, bypass = false, terminalApp = 'iterm' } = await req.json();
        const cdPath = worktreePath ? worktreePath.split(',')[0].trim() : (folderPath ?? null);
        const agyCli = terminalAgentCli('agy', bypass);
        const launch = await openTerminalWithCmd(agyCli, cdPath, buildWindowTitle(name || 'Antigravity', worktreePath, bypass ? 'bypass' : undefined), terminalApp === 'terminal' ? 'terminal' : 'iterm');
        return new Response(JSON.stringify(launchPayload(`${terminalApp === 'terminal' ? 'Terminal' : 'iTerm'}에서 Antigravity${bypass ? ' ⚡' : ''} 실행`, launch)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-terminal-hermes" && req.method === "POST") {
      try {
        const { folderPath, name, worktreePath, terminalApp = 'iterm' } = await req.json();
        const cdPath = worktreePath ? worktreePath.split(',')[0].trim() : (folderPath ?? null);
        const effectiveTerminalApp: 'iterm' | 'terminal' = terminalApp === 'iterm' && !existsSync('/Applications/iTerm.app')
          ? 'terminal'
          : terminalApp === 'terminal' ? 'terminal' : 'iterm';
        const hermesCmd = terminalAgentCli('hermes', false);
        const launch = await openTerminalWithCmd(hermesCmd, cdPath, buildWindowTitle(name || 'Hermes', worktreePath), effectiveTerminalApp);
        return new Response(JSON.stringify(launchPayload(`${effectiveTerminalApp === 'terminal' ? 'Terminal' : 'iTerm'}에서 Hermes 실행`, launch)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-terminal-claude-bypass" && req.method === "POST") {
      try {
        const { folderPath, name, worktreePath, bypass = false, terminalApp = 'iterm' } = await req.json();
        const claudeCmd = terminalAgentCli('claude', bypass);
        const cdPath = worktreePath ? worktreePath.split(',')[0].trim() : (folderPath ?? null);
        const title = buildWindowTitle(name || 'Claude', worktreePath, bypass ? 'bypass' : undefined);
        const launch = await openTerminalWithCmd(claudeCmd, cdPath, title, terminalApp === 'terminal' ? 'terminal' : 'iterm');
        return new Response(JSON.stringify(launchPayload(`${terminalApp === 'terminal' ? 'Terminal' : 'iTerm'}에서 Claude${bypass ? ' (bypass)' : ''} 실행`, launch)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/supabase-login" && req.method === "POST") {
      try {
        const isWindows = process.platform === "win32";
        if (isWindows) {
          // Windows: PowerShell 창 열고 supabase login 실행
          const supabaseBin = join(homedir(), ".bun/install/global/node_modules/supabase/bin/supabase.exe");
          const cmd = existsSync(supabaseBin) ? `& "${supabaseBin}" login` : "supabase login";
          spawn({
            cmd: ["powershell.exe", "-NoExit", "-Command", cmd],
            stdout: "inherit",
            stderr: "inherit",
          });
        } else {
          // macOS: Terminal 창 열고 supabase login 실행
          const script = `tell application "Terminal"\n  activate\n  do script "supabase login"\nend tell`;
          await runAppleScriptChecked(script);
        }
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-terminal-git-pull" && req.method === "POST") {
      try {
        const { folderPath, name, githubUrl } = await req.json();
        const workDir = folderPath as string;
        const baseName = (name || 'git-pull') as string;
        const title = `[git-pull] ${baseName}`;
        if (IS_WIN) {
          // cmd 구문: `2>nul` 로 stderr 버리고, `||` 로 실패 시 remote add 수행
          const remoteCmd = githubUrl
            ? `(git remote set-url origin "${githubUrl}" 2>nul || git remote add origin "${githubUrl}") && `
            : '';
          await openTerminalWithCmd(`${remoteCmd}git pull`, workDir, title);
        } else {
          const escTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const remoteCmd = githubUrl
            ? `git remote set-url origin '${escapeSq(githubUrl as string)}' 2>/dev/null || git remote add origin '${escapeSq(githubUrl as string)}'; `
            : '';
          const cmd = `cd '${escapeSq(workDir)}' && ${remoteCmd}git pull`;
          const escapedCmd = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const script = `tell application "iTerm"\n  activate\n  set newWindow to create window with default profile\n  tell current session of newWindow\n    write text "${escapedCmd}"\n    delay 0.5\n    set name to "${escTitle}"\n  end tell\nend tell`;
          await runAppleScriptChecked(script);
        }
        return new Response(JSON.stringify({ success: true, message: "터미널에서 git pull 실행" }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-terminal-git-push" && req.method === "POST") {
      try {
        const { folderPath, name, githubUrl } = await req.json();
        const workDir = folderPath as string;
        const baseName = (name || 'git-push') as string;
        const title = `[git-push] ${baseName}`;
        if (IS_WIN) {
          // cmd 구문: 최초 push 시 upstream 없으면 `-u origin HEAD`로 폴백 (bash의 `$(git branch --show-current)` 대체)
          const remoteCmd = githubUrl
            ? `(git remote set-url origin "${githubUrl}" 2>nul || git remote add origin "${githubUrl}") && `
            : '';
          await openTerminalWithCmd(`${remoteCmd}(git push || git push -u origin HEAD)`, workDir, title);
        } else {
          const escTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const remoteCmd = githubUrl
            ? `git remote set-url origin '${escapeSq(githubUrl as string)}' 2>/dev/null || git remote add origin '${escapeSq(githubUrl as string)}'; `
            : '';
          const cmd = `cd '${escapeSq(workDir)}' && ${remoteCmd}git push || git push --set-upstream origin $(git branch --show-current)`;
          const escapedCmd = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const script = `tell application "iTerm"\n  activate\n  set newWindow to create window with default profile\n  tell current session of newWindow\n    write text "${escapedCmd}"\n    delay 0.5\n    set name to "${escTitle}"\n  end tell\nend tell`;
          await runAppleScriptChecked(script);
        }
        return new Response(JSON.stringify({ success: true, message: "터미널에서 git push 실행" }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-terminal-git-commit" && req.method === "POST") {
      try {
        const { worktreePath, folderPath, name } = await req.json();
        // 커밋은 worktreePath 우선, 없으면 folderPath
        const workDir = (worktreePath as string | undefined) || (folderPath as string);
        const baseName = (name || 'git-commit') as string;
        const worktreeName = worktreePath
          ? (worktreePath as string).replace(/[\\/]+$/, '').split(/[\\/]/).pop()
          : null;
        const displayName = worktreeName ? `${baseName}(${worktreeName})` : baseName;
        const title = `[git-commit] ${displayName}`;
        if (IS_WIN) {
          // cmd.exe: set /p 로 입력 받고 %msg% 로 참조. git status로 변경 확인 후 메시지 입력
          const shellCmd = `git add -A && git status && echo. && set /p msg=커밋 메시지: && git commit -m "%msg%"`;
          await openTerminalWithCmd(shellCmd, workDir, title);
        } else {
          const escTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const cmd = `cd '${escapeSq(workDir)}' && git add -A && git status && echo "" && read -p "커밋 메시지: " msg && git commit -m "$msg"`;
          const escapedCmd = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const script = `tell application "iTerm"\n  activate\n  set newWindow to create window with default profile\n  tell current session of newWindow\n    write text "${escapedCmd}"\n    delay 0.5\n    set name to "${escTitle}"\n  end tell\nend tell`;
          await runAppleScriptChecked(script);
        }
        return new Response(JSON.stringify({ success: true, message: "터미널에서 git commit 실행" }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/browser-profiles" && req.method === "GET") {
      try {
        return new Response(JSON.stringify({ success: true, profiles: discoverChromeProfiles() }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message, profiles: [] }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-in-chrome" && req.method === "POST") {
      try {
        const { url: targetUrl, profileId } = await req.json();
        if (!targetUrl) return new Response(JSON.stringify({ error: "url required" }), { status: 400, headers });
        if (profileId) {
          const profile = discoverChromeProfiles().find(candidate => candidate.id === profileId);
          if (!profile) {
            return new Response(JSON.stringify({
              success: false,
              error: "선택한 Chrome 프로필을 이 기기에서 찾을 수 없습니다. 배포 브라우저를 다시 선택해주세요.",
            }), { status: 400, headers });
          }
          const launch = buildChromeProfileLaunch({ profile, url: String(targetUrl) });
          const child = spawn({ cmd: [launch.command, ...launch.args], stdout: "ignore", stderr: "ignore" });
          child.unref();
        } else if (IS_WIN) {
          spawn({ cmd: ["rundll32.exe", "url.dll,FileProtocolHandler", targetUrl as string], stdout: "inherit", stderr: "inherit" });
        } else {
          spawn({ cmd: ["open", "-a", "Google Chrome", targetUrl as string], stdout: "inherit", stderr: "inherit" });
        }
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-terminal-worktree-run" && req.method === "POST") {
      try {
        const { worktreePath, name, terminalCommand, port, folderPath } = await req.json();
        if (!worktreePath) {
          return new Response(JSON.stringify({ error: "worktreePath required" }), { status: 400, headers });
        }
        const workDir = worktreePath as string;
        const baseName = (name || 'run') as string;
        const wtName = workDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || baseName;
        const portLabel = port ? `(${port})` : '';
        const title = `[run] ${baseName}${portLabel}(${wtName})`;
        let launch: TerminalLaunchOutcome = { verified: true };
        const mainFolder = folderPath as string | undefined;
        const targetPort = port as number | undefined;

        // 패키지 매니저 감지 — 메인 프로젝트 lockfile 기준 (워크트리는 lockfile 없을 수 있음)
        const detectPkgMgr = (dir: string): 'bun' | 'pnpm' | 'yarn' | 'npm' => {
          if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) return 'bun';
          if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
          if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
          return 'npm';
        };
        const pkgMgr = mainFolder && existsSync(join(mainFolder, 'package.json'))
          ? detectPkgMgr(mainFolder)
          : detectPkgMgr(workDir);

        // run 커맨드 결정
        let runCmd = (terminalCommand as string | undefined) || '';
        const hasPackageJson = existsSync(join(workDir, 'package.json'));
        const hasNextConfig = ['next.config.ts', 'next.config.js', 'next.config.mjs'].some(f => existsSync(join(workDir, f)));
        const hasViteConfig = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'].some(f => existsSync(join(workDir, f)));
        if (!runCmd) {
          if (hasPackageJson) {
            // Next.js → next dev -p N (binary에 직접 포트 전달)
            // Vite → vite --port N (binary 직접 실행, npm/bun run dev 스크립트 우회)
            //   이유: bun on Windows는 `a & b` 백그라운드 연산자 미지원 → 복잡한 dev 스크립트 실패
            //   bunx/npx로 바로 호출하면 스크립트 설정 의존성 제거 + 포트 커스터마이즈 가능
            if (hasNextConfig) {
              const runner = pkgMgr === 'bun' ? 'bunx' : pkgMgr === 'npm' ? 'npx' : pkgMgr === 'pnpm' ? 'pnpm dlx' : 'yarn dlx';
              runCmd = targetPort ? `${runner} next dev -p ${targetPort}` : `${runner} next dev`;
            } else if (hasViteConfig) {
              const runner = pkgMgr === 'bun' ? 'bunx' : pkgMgr === 'npm' ? 'npx' : pkgMgr === 'pnpm' ? 'pnpm dlx' : 'yarn dlx';
              runCmd = targetPort ? `${runner} vite --port ${targetPort}` : `${runner} vite`;
            } else {
              runCmd = `${pkgMgr} run dev`;
            }
          } else if (existsSync(join(workDir, 'pyproject.toml'))) {
            runCmd = 'uv run python app.py';
          } else if (existsSync(join(workDir, 'Cargo.toml'))) {
            runCmd = 'cargo run';
          }
        } else if (targetPort) {
          // 기존 커맨드에 -p NNNN 가 있으면 교체, --port NNNN 도 교체
          runCmd = runCmd.replace(/-p\s+\d+/, `-p ${targetPort}`).replace(/--port(?:=|\s+)\d+/, `--port ${targetPort}`);
        }

        // node_modules 준비 — 워크트리에 없으면 메인 것 공유(junction/symlink) 또는 설치
        const hasWtDeps = existsSync(join(workDir, 'node_modules'));
        const mainHasRealDeps = !!(mainFolder && existsSync(join(mainFolder, 'node_modules', '.package-lock.json')) ||
                                    mainFolder && existsSync(join(mainFolder, 'node_modules', 'react')));
        const canShare = !hasWtDeps && mainHasRealDeps;
        // 메인에도 실제 deps 없으면 워크트리에서 직접 install 필요
        const needsInstall = !hasWtDeps && !mainHasRealDeps && hasPackageJson;

        if (IS_WIN) {
          // cmd.exe용 체인. `set "PORT=N"` 으로 trailing space 버그 회피
          // mklink /J 가 실패해도 계속 진행(||), 그래야 사용자가 원인을 볼 수 있음
          const linkSetup = canShare
            ? `(if not exist node_modules (mklink /J node_modules "${mainFolder}\\node_modules")) & `
            : '';
          const installSetup = needsInstall ? `${pkgMgr} install && ` : '';
          // next 바이너리가 -p 를 받으므로 PORT 중복 skip
          const isNextDev = /\bnext\s+dev\b/.test(runCmd);
          const isViteDev = /\bvite\b/.test(runCmd) || (hasViteConfig && /run\s+dev/.test(runCmd));
          const portPrefix = (targetPort && !isNextDev && !isViteDev) ? `set "PORT=${targetPort}" && ` : '';
          const shellCmd = runCmd
            ? `${linkSetup}${installSetup}${portPrefix}${runCmd}`
            : 'echo 작업 디렉터리 열림';
          launch = await openTerminalWithCmd(shellCmd, workDir, title);
        } else {
          const escTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const linkSetup = canShare
            ? `(test -e node_modules || ln -s '${escapeSq(join(mainFolder as string, 'node_modules'))}' node_modules) && `
            : '';
          const installSetup = needsInstall ? `${pkgMgr} install && ` : '';
          const isNextDev = /\bnext\s+dev\b/.test(runCmd);
          const isViteDev = /\bvite\b/.test(runCmd) || (hasViteConfig && /run\s+dev/.test(runCmd));
          const portPrefix = (targetPort && !isNextDev && !isViteDev) ? `PORT=${targetPort} ` : '';
          const cmd = runCmd
            ? `cd '${escapeSq(workDir)}' && ${linkSetup}${installSetup}${portPrefix}${runCmd}`
            : `cd '${escapeSq(workDir)}'`;
          const escapedCmd = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const script = `tell application "iTerm"\n  activate\n  set newWindow to create window with default profile\n  tell current session of newWindow\n    write text "${escapedCmd}"\n    delay 0.5\n    set name to "${escTitle}"\n  end tell\nend tell`;
          launch = await runAppleScriptChecked(script);
        }
        return new Response(JSON.stringify(launchPayload("워크트리 터미널 실행", launch, { pkgMgr, runCmd })), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/install-app" && req.method === "POST") {
      if (IS_WIN) {
        return new Response(JSON.stringify({ success: false, error: 'macOS 전용 기능입니다.' }), { status: 400, headers });
      }
      try {
        const plan = await stageMacosAppInstall();
        const appPids = await scheduleMacosAppInstall(plan);
        devLog(`[InstallApp] staged ${plan.sourcePath} -> ${plan.stagedPath}; app pids=${appPids.join(',') || 'none'}`);

        return new Response(
          JSON.stringify({
            success: true,
            pending: true,
            message: "새 앱 검증을 마쳤습니다. 실행 중인 AgentsToZ를 종료한 뒤 안전하게 교체하고 다시 엽니다.",
            backupPath: plan.backupPath,
            logPath: plan.logPath,
          }),
          { status: 202, headers }
        );
      } catch (error: any) {
        console.error(`[InstallApp] Error:`, error);
        return new Response(
          JSON.stringify({
            success: false,
            error: error.message,
          }),
          { status: 500, headers }
        );
      }
    }

    if (url.pathname === "/api/export-dmg" && req.method === "POST") {
      if (IS_WIN) {
        return new Response(JSON.stringify({ success: false, error: 'macOS 전용 기능입니다.' }), { status: 400, headers });
      }
      try {
        devLog(`[ExportDMG] Starting...`);
        // .cargo/config.toml의 target-dir 설정과 동일한 경로 (iCloud 밖)
        const bundleDir = join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), "cargo-targets/portmanager/release/bundle");

        // DMG 파일 찾기
        const dmgPaths = [
          join(bundleDir, "dmg"),
          join(bundleDir, "dmg 2"),
          join(bundleDir, "macos"),
        ];

        let dmgFile: string | null = null;

        for (const dmgDir of dmgPaths) {
          devLog(`[ExportDMG] Checking directory: ${dmgDir}`);
          if (existsSync(dmgDir)) {
            const { readdirSync } = await import("node:fs");
            const files = readdirSync(dmgDir);
            devLog(`[ExportDMG] Files found:`, files);

            for (const file of files) {
              if (file.endsWith('.dmg') && !file.startsWith('rw.')) {
                dmgFile = join(dmgDir, file);
                devLog(`[ExportDMG] Found DMG: ${dmgFile}`);
                break;
              }
            }
          }
          if (dmgFile) break;
        }

        if (!dmgFile) {
          console.error(`[ExportDMG] No DMG found`);
          return new Response(
            JSON.stringify({
              success: false,
              error: "DMG 파일을 찾을 수 없습니다. 먼저 빌드를 실행하세요.",
            }),
            { status: 404, headers }
          );
        }

        const home = process.env.HOME || homedir();
        const desktop = join(home, "Desktop");

        // 원본 파일명 추출 (버전 정보 포함)
        const { basename } = await import("node:path");
        const dmgFilename = basename(dmgFile);
        const destPath = join(desktop, dmgFilename);

        devLog(`[ExportDMG] Copying from: ${dmgFile} to: ${destPath}`);

        // 기존 파일이 있으면 삭제
        if (existsSync(destPath)) {
          const { unlinkSync } = await import("node:fs");
          unlinkSync(destPath);
        }

        // DMG 복사
        const { copyFileSync } = await import("node:fs");
        copyFileSync(dmgFile, destPath);

        devLog(`[ExportDMG] Copy successful`);

        // Desktop 폴더 열기
        openPath(desktop);

        return new Response(
          JSON.stringify({
            success: true,
            message: `DMG를 Desktop에 복사했습니다`,
          }),
          { headers }
        );
      } catch (error: any) {
        console.error(`[ExportDMG] Error:`, error);
        return new Response(
          JSON.stringify({
            success: false,
            error: error.message,
          }),
          { status: 500, headers }
        );
      }
    }

    if (url.pathname === "/api/scan-command-files" && req.method === "POST") {
      try {
        const { folderPath } = await req.json();
        if (!folderPath) return new Response(JSON.stringify({ files: [] }), { headers });
        const { readdirSync, existsSync } = await import("node:fs");
        if (!existsSync(folderPath)) return new Response(JSON.stringify({ files: [] }), { headers });
        const EXEC_EXTS = ['.command', '.bat', '.cmd', '.ps1', '.sh', '.html'];
        const files = readdirSync(folderPath)
          .filter((f: string) => {
            const lower = f.toLowerCase();
            return EXEC_EXTS.some(ext => lower.endsWith(ext));
          })
          .map((f: string) => `${folderPath}/${f}`);
        return new Response(JSON.stringify({ files }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ files: [], error: e.message }), { headers });
      }
    }

    if (url.pathname === "/api/open-app-data-dir" && req.method === "POST") {
      try {
        openPath(APP_DATA_DIR);
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/workspace-roots" && req.method === "GET") {
      const data = await loadWorkspaceRootsData();
      return new Response(JSON.stringify(data), { headers });
    }

    if (url.pathname === "/api/workspace-roots" && req.method === "POST") {
      try {
        const data = await req.json();
        await saveWorkspaceRootsData(data);
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/create-folder" && req.method === "POST") {
      try {
        const { folderPath } = await req.json();
        if (!folderPath) {
          return new Response(JSON.stringify({ success: false, error: "Missing folderPath" }), { status: 400, headers });
        }
        const isAbsoluteCreate = IS_WIN ? /^([A-Za-z]:[\\\/]|\\\\)/.test(folderPath) : folderPath.startsWith('/');
        if (!isAbsoluteCreate) {
          return new Response(JSON.stringify({ success: false, error: "절대경로가 필요합니다" }), { status: 400, headers });
        }
        const { mkdirSync, existsSync } = await import("node:fs");
        if (existsSync(folderPath)) {
          return new Response(JSON.stringify({ success: false, error: "이미 존재하는 폴더입니다" }), { status: 400, headers });
        }
        mkdirSync(folderPath, { recursive: true });
        devLog(`[CreateFolder] Created: ${folderPath}`);
        openPath(folderPath);
        return new Response(JSON.stringify({ success: true, path: folderPath }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/clone-repository" && req.method === "POST") {
      try {
        const { repositoryUrl, folderPath } = await req.json() as {
          repositoryUrl?: unknown;
          folderPath?: unknown;
        };
        const cloneUrl = typeof repositoryUrl === "string" ? repositoryUrl.trim() : "";
        const target = typeof folderPath === "string" ? folderPath.trim() : "";
        if (!cloneUrl || !target) {
          return new Response(JSON.stringify({ success: false, error: "repositoryUrl과 folderPath가 모두 필요합니다" }), { status: 400, headers });
        }
        // 옵션 모양의 주소는 `git clone --upload-pack=…` 같은 인자 주입이 된다. UI가 거쳐가는
        // 정규화에서는 나올 수 없는 값이지만, 이 엔드포인트는 그 정규화를 안 거친 입력도 받는다.
        if (cloneUrl.startsWith("-")) {
          return new Response(JSON.stringify({ success: false, error: "저장소 주소가 올바르지 않습니다" }), { status: 400, headers });
        }
        const isAbsoluteTarget = IS_WIN ? /^([A-Za-z]:[\\\/]|\\\\)/.test(target) : target.startsWith("/");
        if (!isAbsoluteTarget) {
          return new Response(JSON.stringify({ success: false, error: "절대경로가 필요합니다" }), { status: 400, headers });
        }
        if (existsSync(target)) {
          return new Response(JSON.stringify({ success: false, error: "이미 존재하는 폴더입니다" }), { status: 400, headers });
        }
        // 자격증명 프롬프트가 GUI에는 뜨지 않는다. 물어보게 두면 요청이 그냥 매달려 있다가
        // 타임아웃으로 죽고, 사용자는 이유를 알 수 없다. 물어보지 말고 즉시 실패시킨다.
        const proc = Bun.spawn([GIT_PATH, "clone", "--", cloneUrl, target], {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: "",
            SSH_ASKPASS: "",
            GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new",
          },
        });
        const timeout = setTimeout(() => { try { proc.kill(); } catch { /* 이미 끝났다 */ } }, CLONE_TIMEOUT_MS);
        await proc.exited;
        clearTimeout(timeout);
        if (proc.exitCode !== 0) {
          const stderr = (await new Response(proc.stderr).text()).trim();
          // 부분 생성된 폴더를 남기면 다음 시도가 "이미 존재하는 폴더입니다"로 막힌다.
          // 이 요청이 만든 경로일 때만 지운다 — 위에서 부재를 확인하고 들어왔다.
          try { rmSync(target, { recursive: true, force: true }); } catch { /* 정리 실패가 오류를 덮지 않게 둔다 */ }
          return new Response(JSON.stringify({
            success: false,
            error: describeCloneFailure(stderr),
          }), { status: 500, headers });
        }
        devLog(`[CloneRepository] Cloned ${cloneUrl} → ${target}`);
        return new Response(JSON.stringify({ success: true, path: target }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/build-windows" && req.method === "POST") {
      // 로컬 Windows 빌드 — /api/build?type=windows 와 동일한 방식
      if (buildStatus.isBuilding) {
        return new Response(JSON.stringify({ error: "빌드가 이미 진행 중입니다" }), { status: 400, headers });
      }
      // Windows 빌드 사전 요구사항 확인
      const cargoCheck = await Bun.$`cargo --version`.quiet().nothrow();
      const missing: string[] = [];
      if (cargoCheck.exitCode !== 0) missing.push('Rust (cargo)');

      if (process.platform === 'win32') {
        if (!hasVsBuildTools()) missing.push('Visual Studio C++ Build Tools (MSVC)');
      }

      if (missing.length > 0) {
        return new Response(JSON.stringify({
          error: `❌ Windows 빌드에 필요한 도구가 설치되지 않았습니다:\n${missing.map(m => '  • ' + m).join('\n')}\n\n👉 "자동 설치하기" 버튼으로 한 번에 설치할 수 있습니다 (약 20~40분 소요).`,
          missingTools: missing,
          canAutoInstall: process.platform === 'win32',
        }), { status: 400, headers });
      }
      buildStatus = { isBuilding: true, type: 'windows', output: [], exitCode: null };
      buildProcess = spawn({
        cmd: ["bun", "run", "tauri:build:win"],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const readWinStream = async (stream: any) => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
          pushLogBounded(buildStatus.output, decoder.decode(chunk, { stream: true }));
        }
      };
      const wo = readWinStream(buildProcess.stdout);
      const we = readWinStream(buildProcess.stderr);
      buildProcess.exited.then(async (code: number) => {
        await Promise.all([wo, we]);
        buildStatus.exitCode = code;
        buildStatus.isBuilding = false;
      });
      return new Response(JSON.stringify({ success: true, message: 'Windows 로컬 빌드가 시작되었습니다' }), { headers });
    }

    if (url.pathname === "/api/windows-build-status" && req.method === "GET") {
      // 로컬 빌드 상태는 /api/build-status 와 동일한 buildStatus 공유
      return new Response(JSON.stringify(buildStatus), { headers });
    }

    if (url.pathname === "/api/install-windows-prereqs" && req.method === "POST") {
      if (process.platform !== 'win32') {
        return new Response(JSON.stringify({ error: "Windows에서만 지원됩니다" }), { status: 400, headers });
      }
      if (buildStatus.isBuilding) {
        return new Response(JSON.stringify({ error: "다른 작업이 진행 중입니다" }), { status: 400, headers });
      }
      buildStatus = { isBuilding: true, type: 'install-prereqs', output: [], exitCode: null };

      (async () => {
        const log = (s: string) => pushLogBounded(buildStatus.output, s + '\n');
        let prereqTempDir = '';
        try {
          log('📦 Windows 빌드 사전 요구사항 자동 설치 시작');
          prereqTempDir = mkdtempSync(join(tmpdir(), 'agentstoz-build-prereqs-'));

          // Step 1: VS Build Tools 확인 및 설치
          if (!hasVsBuildTools()) {
            log('\n=== 1/2: Visual Studio Build Tools 설치 ===');
            log('다운로드 중... (4.5MB)');
            const vsInstaller = join(prereqTempDir, 'vs_BuildTools.exe');
            const dl1 = await Bun.$`curl -fsSL -o ${vsInstaller} https://aka.ms/vs/17/release/vs_BuildTools.exe`.quiet().nothrow();
            if (dl1.exitCode !== 0) throw new Error('VS Build Tools 다운로드 실패');
            log('✅ 다운로드 완료');
            log('⏳ 설치 중... (15~30분, 3~5GB 다운로드)');
            const install1 = Bun.spawn({
              cmd: [vsInstaller, '--quiet', '--wait', '--norestart', '--nocache',
                    '--installPath', 'C:/BuildTools',
                    '--add', 'Microsoft.VisualStudio.Workload.VCTools',
                    '--add', 'Microsoft.VisualStudio.Component.Windows11SDK.22621',
                    '--includeRecommended'],
              stdout: 'pipe', stderr: 'pipe',
            });
            const readPromise = (async () => {
              const decoder = new TextDecoder();
              for await (const chunk of install1.stdout) log(decoder.decode(chunk, { stream: true }).trim());
            })();
            const readErr = (async () => {
              const decoder = new TextDecoder();
              for await (const chunk of install1.stderr) log(decoder.decode(chunk, { stream: true }).trim());
            })();
            const code1 = await install1.exited;
            await Promise.all([readPromise, readErr]);
            if (code1 !== 0 && code1 !== 3010) throw new Error(`VS Build Tools 설치 실패 (exit ${code1})`);
            log('✅ VS Build Tools 설치 완료');
          } else {
            log('✅ VS Build Tools 이미 설치됨 (건너뜀)');
          }

          // Step 2: Rust 확인 및 설치
          const cargoCheck = await Bun.$`cargo --version`.quiet().nothrow();
          if (cargoCheck.exitCode !== 0) {
            log('\n=== 2/2: Rust 설치 ===');
            log('다운로드 중...');
            const rustupPath = join(prereqTempDir, 'rustup-init.exe');
            const dl2 = await Bun.$`curl -fsSL -o ${rustupPath} https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe`.quiet().nothrow();
            if (dl2.exitCode !== 0) throw new Error('rustup 다운로드 실패');
            log('✅ 다운로드 완료');
            log('⏳ Rust 설치 중... (약 2~5분)');
            const install2 = Bun.spawn({
              cmd: [rustupPath, '-y', '--default-toolchain', 'stable', '--profile', 'default'],
              stdout: 'pipe', stderr: 'pipe',
            });
            const r1 = (async () => { const d = new TextDecoder(); for await (const c of install2.stdout) log(d.decode(c).trim()); })();
            const r2 = (async () => { const d = new TextDecoder(); for await (const c of install2.stderr) log(d.decode(c).trim()); })();
            const code2 = await install2.exited;
            await Promise.all([r1, r2]);
            if (code2 !== 0) throw new Error(`Rust 설치 실패 (exit ${code2})`);
            log('✅ Rust 설치 완료');
          } else {
            log('✅ Rust 이미 설치됨 (건너뜀)');
          }

          log('\n🎉 모든 사전 요구사항 설치 완료!');
          log('💡 앱을 재시작하거나 "Windows 빌드" 버튼을 다시 누르세요.');
          buildStatus.exitCode = 0;
        } catch (err: any) {
          log(`\n❌ 설치 실패: ${err.message}`);
          buildStatus.exitCode = 1;
        } finally {
          if (prereqTempDir) rmSync(prereqTempDir, { recursive: true, force: true });
          buildStatus.isBuilding = false;
        }
      })();

      return new Response(JSON.stringify({ success: true, message: '자동 설치 시작' }), { headers });
    }

    if (url.pathname === "/api/git-pull" && req.method === "POST") {
      let folderPath: string | undefined;
      try {
        ({ folderPath } = await req.json() as { folderPath: string });
        if (!folderPath) return new Response(JSON.stringify({ success: false, error: "folderPath 필요" }), { headers });

        const branchProc = Bun.spawn([GIT_PATH, "rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: folderPath, stdout: "pipe", stderr: "pipe",
        });
        await branchProc.exited;
        const branch = (await new Response(branchProc.stdout).text()).trim();
        const branchError = (await new Response(branchProc.stderr).text()).trim();
        if (branchProc.exitCode !== 0 || !branch) {
          return new Response(JSON.stringify({
            success: false,
            error: branchError || '현재 워크트리의 브랜치를 확인하지 못했습니다. 워크트리를 새로고침한 뒤 다시 시도하세요.',
          }), { headers });
        }
        if (branch === 'HEAD') {
          return new Response(JSON.stringify({
            success: false,
            code: 'DETACHED_HEAD',
            error: '현재 워크트리는 분리된 HEAD 상태라 Pull할 수 없습니다. 브랜치를 체크아웃하거나 “새 브랜치”로 연결한 뒤 다시 시도하세요.',
          }), { headers });
        }

        const proc = Bun.spawn([GIT_PATH, "pull", "origin", branch], {
          cwd: folderPath,
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const output = (stdout + stderr).trim();
        if (proc.exitCode !== 0) {
          return new Response(JSON.stringify({ success: false, error: output }), { headers });
        }
        return new Response(JSON.stringify({ success: true, output }), { headers });
      } catch (e: any) {
        const msg = String(e);
        const err = msg.includes('ENOENT') ? `폴더 접근 불가 (Google Drive/iCloud 미동기화 가능성): ${folderPath}` : msg;
        return new Response(JSON.stringify({ success: false, error: err }), { headers });
      }
    }

    if (url.pathname === "/api/git-push" && req.method === "POST") {
      let folderPath: string | undefined;
      try {
        ({ folderPath } = await req.json() as { folderPath: string });
        if (!folderPath) return new Response(JSON.stringify({ success: false, error: "folderPath 필요" }), { headers });

        const originResult = await runGitForStatus(folderPath, ["remote", "get-url", "origin"]);
        if (!originResult.ok) {
          return new Response(JSON.stringify({
            success: false,
            error: "GitHub 원격(origin)이 연결되지 않아 푸시할 수 없습니다. 프로젝트 수정에서 GitHub 주소를 확인하고 origin을 연결해주세요.",
          }), { headers });
        }
        if (!isGitHubRemoteUrl(originResult.stdout)) {
          return new Response(JSON.stringify({
            success: false,
            error: "origin 원격이 GitHub 주소가 아니어서 푸시하지 않았습니다.",
          }), { headers });
        }

        const branchProc = Bun.spawn([GIT_PATH, "rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: folderPath, stdout: "pipe", stderr: "pipe",
        });
        await branchProc.exited;
        const branch = (await new Response(branchProc.stdout).text()).trim();
        const branchError = (await new Response(branchProc.stderr).text()).trim();
        if (branchProc.exitCode !== 0 || !branch) {
          return new Response(JSON.stringify({
            success: false,
            error: branchError || '현재 워크트리의 브랜치를 확인하지 못했습니다. 워크트리를 새로고침한 뒤 다시 시도하세요.',
          }), { headers });
        }
        if (branch === 'HEAD') {
          return new Response(JSON.stringify({
            success: false,
            code: 'DETACHED_HEAD',
            error: '현재 워크트리는 분리된 HEAD 상태라 Push할 수 없습니다. 브랜치를 체크아웃하거나 “새 브랜치”로 연결한 뒤 다시 시도하세요.',
          }), { headers });
        }

        const proc = Bun.spawn([GIT_PATH, "push", "--set-upstream", "origin", branch], {
          cwd: folderPath,
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const output = (stdout + stderr).trim();
        if (proc.exitCode !== 0) {
          return new Response(JSON.stringify({ success: false, error: output }), { headers });
        }
        return new Response(JSON.stringify({ success: true, output }), { headers });
      } catch (e: any) {
        const msg = String(e);
        const err = msg.includes('ENOENT') ? `폴더 접근 불가 (Google Drive/iCloud 미동기화 가능성): ${folderPath}` : msg;
        return new Response(JSON.stringify({ success: false, error: err }), { headers });
      }
    }

    if (url.pathname === "/api/git-commit-message" && req.method === "POST") {
      try {
        const { worktreePath } = await req.json() as { worktreePath?: string };
        if (!worktreePath || !isAbsolute(worktreePath) || !existsSync(worktreePath)) {
          return new Response(
            JSON.stringify({ error: "유효한 워크트리 경로가 필요합니다." }),
            { status: 400, headers },
          );
        }
        if (!CLAUDE_PATH) {
          return new Response(
            JSON.stringify({ error: "Claude CLI를 찾을 수 없습니다." }),
            { status: 503, headers },
          );
        }

        const statusResult = await runGitForStatus(worktreePath, [
          "status",
          "--short",
          "--untracked-files=normal",
          "--",
          ".",
          ...GIT_VOLATILE_ARTIFACT_PATHSPECS,
        ]);
        if (!statusResult.ok) {
          return new Response(
            JSON.stringify({ error: statusResult.stderr || "Git 변경 상태를 읽지 못했습니다." }),
            { status: 400, headers },
          );
        }
        if (!statusResult.stdout.trim()) {
          return new Response(
            JSON.stringify({ error: "커밋할 변경 사항이 없습니다." }),
            { status: 400, headers },
          );
        }

        const diffResult = await runGitForStatus(worktreePath, [
          "diff",
          "--no-ext-diff",
          "--unified=1",
          "HEAD",
          "--",
          ".",
          ...GIT_VOLATILE_ARTIFACT_PATHSPECS,
        ], 15_000);
        const evidence = [
          `변경 파일:\n${statusResult.stdout}`,
          diffResult.ok && diffResult.stdout
            ? `변경 내용:\n${diffResult.stdout.slice(0, 16_000)}`
            : "",
        ].filter(Boolean).join("\n\n");
        // The "도구를 쓸 수 없다" framing matters: with tools disabled the model otherwise
        // stalls narrating that it needs to inspect the files instead of answering.
        const prompt = `너는 Git 커밋 제목 생성기다. 파일을 열거나 명령을 실행할 수 없고, 아래에 제공된 내용만이 유일한 정보다.
아래 변경 내역만 근거로 커밋 제목 한 줄을 한국어로 작성해줘.
- 변경의 핵심 목적이 드러나게 작성
- 가능하면 72자 이내
- 마크다운, 따옴표, 설명, 서론, 줄바꿈 없이 제목 한 줄만 출력

${evidence}`;
        // 16KB diffs measured at ~24s, so 30s left almost no margin.
        const run = await runClaudePrompt(prompt, { timeoutMs: 60_000, cwd: worktreePath, label: 'git-commit-message' });
        if (!run.ok) {
          return new Response(JSON.stringify({ error: run.error }), { status: 500, headers });
        }
        const message = run.text
          .split(/\r?\n/)
          .map(line => line.replace(/^```[a-z]*|```$/gi, "").trim())
          .find(Boolean)
          ?.replace(/^["'`]+|["'`]+$/g, "")
          .trim()
          .slice(0, 120);
        if (!message) {
          return new Response(
            JSON.stringify({ error: "AI가 커밋 메시지를 반환하지 않았습니다." }),
            { status: 500, headers },
          );
        }
        return new Response(JSON.stringify({ message }), { headers });
      } catch (e: any) {
        return new Response(
          JSON.stringify({ error: e?.message || String(e) }),
          { status: 500, headers },
        );
      }
    }

    if (url.pathname === "/api/git-commit" && req.method === "POST") {
      try {
        const { worktreePath, message } = await req.json() as {
          worktreePath: string;
          message: string;
        };
        if (!worktreePath) return new Response(JSON.stringify({ success: false, error: "worktreePath 필요" }), { headers });
        if (!message?.trim()) return new Response(JSON.stringify({ success: false, error: "커밋 메시지 필요" }), { headers });

        const addProc = await stageAllExceptVolatileArtifacts(worktreePath);
        if (addProc.exitCode !== 0) {
          return new Response(JSON.stringify({
            success: false,
            code: 'git_add_failed',
            error: '변경 파일을 스테이징하지 못했습니다. 상세 진단 로그를 확인하세요.',
            diagnostic: formatGitCommitDiagnostic({
              worktreePath,
              exitCode: addProc.exitCode,
              commitOutput: addProc.output,
              parentStatus: '',
              dirtySubmodules: readDirtySubmodules(worktreePath),
            }),
          }), { headers });
        }

        const proc = Bun.spawn(
          [GIT_PATH, "commit", "-m", message.trim()],
          { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
        );
        await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const output = (stdout + stderr).trim();
        if (proc.exitCode !== 0) {
          const parentStatusResult = await runGitForStatus(
            worktreePath,
            ['status', '--short', '--ignore-submodules=none'],
          );
          const dirtySubmodules = readDirtySubmodules(worktreePath);
          return new Response(JSON.stringify({
            success: false,
            code: dirtySubmodules.length > 0 ? 'dirty_submodule' : 'git_commit_failed',
            error: gitCommitFailureMessage(dirtySubmodules),
            diagnostic: formatGitCommitDiagnostic({
              worktreePath,
              exitCode: proc.exitCode ?? 1,
              commitOutput: output,
              parentStatus: parentStatusResult.stdout || parentStatusResult.stderr,
              dirtySubmodules,
            }),
            submodulePaths: dirtySubmodules.map(item => item.path),
          }), { headers });
        }
        return new Response(JSON.stringify({ success: true, output }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ success: false, error: String(e) }), { headers });
      }
    }

    if (url.pathname === "/api/detect-git-remote" && req.method === "POST") {
      try {
        const { folderPath } = await req.json() as { folderPath?: string };
        if (!folderPath || !isAbsolute(folderPath)) {
          return new Response(JSON.stringify({ error: "절대 폴더 경로가 필요합니다." }), { status: 400, headers });
        }
        const result = await runGitForStatus(folderPath, ["remote", "-v"]);
        if (!result.ok) {
          return new Response(JSON.stringify({ error: result.stderr || "Git 저장소를 확인할 수 없습니다." }), { status: 400, headers });
        }
        const remotes = result.stdout
          .split(/\r?\n/)
          .map(line => line.trim().match(/^(\S+)\s+(\S+)\s+\(fetch\)$/))
          .filter((match): match is RegExpMatchArray => !!match)
          .map(match => ({ name: match[1]!, url: match[2]! }))
          .filter(remote => isGitHubRemoteUrl(remote.url));
        const detected = remotes.find(remote => remote.name === "origin") ?? remotes[0];
        if (!detected) {
          return new Response(JSON.stringify({ error: "연결된 GitHub 원격 저장소가 없습니다." }), { status: 404, headers });
        }
        return new Response(JSON.stringify({ success: true, url: detected.url, remote: detected.name }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/list-git-worktrees" && req.method === "POST") {
      try {
        const { folderPath, fetchRemote = false } = await req.json();
        if (!folderPath) {
          return new Response(JSON.stringify({ error: "folderPath required" }), { status: 400, headers });
        }
        if (!isAbsolute(folderPath)) {
          return new Response(JSON.stringify({
            success: false,
            code: 'PROJECT_ROOT_INVALID',
            error: '프로젝트 폴더는 절대경로여야 합니다.',
          }), { status: 400, headers });
        }
        if (!existsSync(folderPath)) {
          return new Response(JSON.stringify({
            success: false,
            code: 'PROJECT_ROOT_MISSING',
            error: `프로젝트 폴더가 없습니다: ${folderPath}`,
          }), { status: 400, headers });
        }
        if (!statSync(folderPath).isDirectory()) {
          return new Response(JSON.stringify({
            success: false,
            code: 'PROJECT_ROOT_INVALID',
            error: `프로젝트 경로가 폴더가 아닙니다: ${folderPath}`,
          }), { status: 400, headers });
        }
        let remoteRefreshError: string | undefined;
        let remoteRefreshState: 'fetched' | 'no-origin' | undefined;
        if (fetchRemote) {
          const originResult = await runGitForStatus(folderPath, ['remote', 'get-url', 'origin']);
          if (originResult.ok) {
            const fetchResult = await runGitForStatus(folderPath, ['fetch', '--prune', 'origin'], 15_000);
            if (!fetchResult.ok) {
              remoteRefreshError = fetchResult.timedOut
                ? '원격 상태 확인 시간 초과'
                : (fetchResult.stderr || '원격 상태 확인 실패');
            } else {
              remoteRefreshState = 'fetched';
            }
          } else {
            // origin이 없는 로컬 저장소도 커밋/상태 갱신은 정상이다. 이를 오류로 보내면
            // 성공한 커밋 직후 UI가 실패 토스트를 띄우고 자동 폴링도 계속 재시도한다.
            remoteRefreshState = 'no-origin';
          }
        }
        const worktreeListResult = await runGitForStatus(
          folderPath,
          gitWorktreeListArgs(),
        );
        if (!worktreeListResult.ok) {
          // git 저장소가 아닌 폴더는 실패가 아니라 "워크트리 없음"이다. 여기서 500 + git stderr를
          // 그대로 올리면 폴더만 등록해 둔 프로젝트마다 오류 리포트가 쌓인다.
          // stderr 문자열 매칭 대신 rev-parse로 판정한다(로케일 무관).
          // ⚠️ 폴더 자체가 없을 때는 git이 cwd 때문에 실패하므로 "저장소 아님"으로 삼키면 안 된다.
          if (!worktreeListResult.timedOut && existsSync(folderPath)) {
            const insideRepo = await runGitForStatus(folderPath, ['rev-parse', '--is-inside-work-tree']);
            if (!insideRepo.ok) {
              return new Response(JSON.stringify({
                success: true,
                worktrees: [],
                notGitRepo: true,
                ...(remoteRefreshError ? { remoteRefreshError } : {}),
                ...(remoteRefreshState ? { remoteRefreshState } : {}),
              }), { headers });
            }
          }
          return new Response(JSON.stringify({
            success: false,
            code: worktreeListResult.timedOut ? 'GIT_WORKTREE_LIST_TIMEOUT' : 'GIT_WORKTREE_LIST_FAILED',
            error: worktreeListResult.timedOut
              ? 'Git 워크트리 목록 확인 시간이 초과되었습니다. 기존 목록을 유지합니다.'
              : (worktreeListResult.stderr || 'Git 워크트리 목록을 확인하지 못했습니다. 기존 목록을 유지합니다.'),
          }), { status: 500, headers });
        }
        const parsedWorktrees = parseGitWorktreePorcelain(worktreeListResult.stdout);
        const worktrees = parsedWorktrees.map(({ isMain, ...worktree }) => ({
          ...worktree,
          // Existing frontend/Tauri payloads use snake case for this one legacy field.
          is_main: isMain,
        }));

        // `git worktree list`가 돌려준 항목은 전부 이 저장소의 워크트리다. 프로젝트 폴더
        // 바깥이라는 이유로 숨기면 Orca가 만든 워크트리(~/orca/workspaces/…)나 터미널에서
        // 직접 만든 워크트리가 앱에 아예 보이지 않아 관리가 불가능해진다. 물리 디렉터리가
        // 남아 있는 것만 표시한다(orphan 메타 숨김).
        // ⚠️ 물리 삭제(cleanup-stale-worktrees)는 여전히 .claude/worktrees/ 하위로만 제한할 것 —
        //    앱이 만들지 않은 외부 경로 워크트리를 앱이 지워서는 안 된다.
        const validWorktrees = worktrees.filter(wt => {
          try { return statSync(wt.path).isDirectory(); }
          catch { return false; }
        });

        // 메인 브랜치 대비 머지 안 된 커밋 수 (0 = 이미 머지됨) — non-main 워크트리만 계산
        // `folderPath` itself can be a persisted linked-worktree row.  Resolving HEAD
        // there makes that linked branch look like the main branch after a refresh.
        // Git's first porcelain record is the only authoritative primary worktree.
        const mainBranchName = resolvePrimaryWorktreeBranch(parsedWorktrees);
        const withMergeStatus = await Promise.all(validWorktrees.map(async wt => {
          if (wt.is_main || !wt.branch || !mainBranchName || wt.branch === mainBranchName) return wt;
          const countResult = await runGitForStatus(
            folderPath,
            ["rev-list", "--count", `${mainBranchName}..${wt.branch}`],
          );
          if (!countResult.ok) return wt;
          const aheadCount = parseInt(countResult.stdout, 10);
          return { ...wt, aheadCount: Number.isFinite(aheadCount) ? aheadCount : undefined };
        }));

        // 브랜치별 마지막 커밋 시각 — 워크트리마다 git을 부르면 직렬 큐가 길어지므로
        // for-each-ref 한 번으로 전부 가져온다.
        const branchDates = new Map<string, string>();
        const refDatesResult = await runGitForStatus(
          folderPath,
          ['for-each-ref', '--format=%(refname:short)%09%(committerdate:iso-strict)', 'refs/heads'],
        );
        if (refDatesResult.ok) {
          for (const line of refDatesResult.stdout.split('\n')) {
            const [branch, date] = line.split('\t');
            if (branch && date) branchDates.set(branch, date);
          }
        }

        const withGitStatus = await Promise.all(withMergeStatus.map(async wt => ({
          ...wt,
          ...(await readGitWorktreeStatus(wt.path, wt.branch)),
          ...readWorktreeCreatedAt(wt.path),
          ...(wt.branch && branchDates.has(wt.branch) ? { lastCommitAt: branchDates.get(wt.branch) } : {}),
          ...(remoteRefreshError ? { remoteRefreshError } : {}),
          ...(remoteRefreshState ? { remoteRefreshState } : {}),
        })));

        return new Response(JSON.stringify({ success: true, worktrees: withGitStatus }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({
          success: false,
          code: 'GIT_WORKTREE_LIST_FAILED',
          error: e?.message ?? String(e),
        }), { status: 500, headers });
      }
    }

    // 레거시(숨김) 워크트리를 현행 비숨김 경로로 이동 — Orca가 인식하게 만든다.
    // 대상 경로(to)는 **서버가 재계산**한다(클라이언트 값 신뢰 금지 = path traversal 차단).
    // src-tauri/src/lib.rs 의 git_worktree_move 와 동작이 일치해야 한다(웹/앱 동일 결과).
    // 잠긴 워크트리를 앱에서 풀 수 있게 한다. 지금까지는 삭제만 막아두고 푸는 수단이
    // 없어서, `세션 사용 중` 워크트리는 앱 안에서 아무것도 할 수 없는 막다른 길이었다.
    if (url.pathname === "/api/git-worktree-unlock" && req.method === "POST") {
      try {
        const { folderPath, worktreePath } = await req.json();
        if (typeof folderPath !== 'string' || !folderPath || typeof worktreePath !== 'string' || !worktreePath) {
          return new Response(JSON.stringify({ error: "folderPath and worktreePath required" }), { status: 400, headers });
        }
        if (!isAbsolute(folderPath) || !isAbsolute(worktreePath)) {
          return new Response(JSON.stringify({ error: "folderPath and worktreePath must be absolute" }), { status: 400, headers });
        }
        // 삭제와 동일하게, 요청 경로가 아니라 Git이 등록했다고 보고한 워크트리만 인정한다.
        const listed = await runGitForStatus(folderPath, gitWorktreeListArgs());
        if (!listed.ok) {
          return new Response(JSON.stringify({ code: 'GIT_WORKTREE_LIST_FAILED', error: listed.stderr || 'Git 워크트리 목록을 확인하지 못했습니다.' }), { status: 500, headers });
        }
        const registered = parseGitWorktreePorcelain(listed.stdout);
        const primaryPath = registered[0]?.path;
        const normalizedTarget = normalizeWorktreePath(worktreePath);
        if (primaryPath && normalizeWorktreePath(primaryPath) === normalizedTarget) {
          return new Response(JSON.stringify({ code: 'PRIMARY_WORKTREE', error: '주 워크트리는 잠금 대상이 아닙니다.' }), { status: 409, headers });
        }
        const target = registered.find(e => normalizeWorktreePath(e.path) === normalizedTarget);
        if (!target) {
          return new Response(JSON.stringify({ code: 'WORKTREE_NOT_REGISTERED', error: '이 저장소에 등록된 워크트리 경로가 아닙니다.' }), { status: 404, headers });
        }
        if (!target.locked) {
          return new Response(JSON.stringify({ success: true, alreadyUnlocked: true }), { headers });
        }
        const unlocked = await runGitForStatus(folderPath, ['worktree', 'unlock', target.path]);
        if (!unlocked.ok) {
          return new Response(JSON.stringify({ code: 'GIT_WORKTREE_UNLOCK_FAILED', error: unlocked.stderr || '잠금을 해제하지 못했습니다.' }), { status: 500, headers });
        }
        // 자기보고를 믿지 않고 목록을 다시 읽어 실제로 풀렸는지 확인한다.
        const verify = await runGitForStatus(folderPath, gitWorktreeListArgs());
        const stillLocked = verify.ok && parseGitWorktreePorcelain(verify.stdout)
          .some(e => normalizeWorktreePath(e.path) === normalizedTarget && e.locked);
        if (stillLocked) {
          return new Response(JSON.stringify({ code: 'GIT_WORKTREE_STILL_LOCKED', error: '잠금 해제 후에도 여전히 잠긴 상태입니다.' }), { status: 500, headers });
        }
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 워크트리를 지우지 않고 새 브랜치로 갈아끼운다. 머지가 끝난 워크트리를 재사용하는 길이
    // 없어서, 다음 작업 때마다 삭제 → 재생성 → node_modules 수만 개 재설치를 반복해야 했다.
    if (url.pathname === "/api/git-worktree-switch-branch" && req.method === "POST") {
      try {
        const { folderPath, worktreePath, branchName, baseRef } = await req.json();
        if (typeof folderPath !== 'string' || !folderPath || typeof worktreePath !== 'string' || !worktreePath
          || typeof branchName !== 'string' || !branchName.trim()) {
          return new Response(JSON.stringify({ error: "folderPath, worktreePath, branchName required" }), { status: 400, headers });
        }
        if (!isAbsolute(folderPath) || !isAbsolute(worktreePath)) {
          return new Response(JSON.stringify({ error: "folderPath and worktreePath must be absolute" }), { status: 400, headers });
        }
        // 브랜치명은 git이 거부하는 문자만 치환한다(한글 등 유니코드는 허용 — 생성 로직과 동일 규칙).
        const safeBranch = branchName.replace(/[\s~^:?*\[\\]/g, '-').replace(/\.{2,}/g, '-').replace(/^[-.]|[-.]$/g, '');
        if (!safeBranch) {
          return new Response(JSON.stringify({ code: 'INVALID_BRANCH_NAME', error: '사용할 수 없는 브랜치명입니다.' }), { status: 400, headers });
        }
        const listed = await runGitForStatus(folderPath, gitWorktreeListArgs());
        if (!listed.ok) {
          return new Response(JSON.stringify({ code: 'GIT_WORKTREE_LIST_FAILED', error: listed.stderr || 'Git 워크트리 목록을 확인하지 못했습니다.' }), { status: 500, headers });
        }
        const registered = parseGitWorktreePorcelain(listed.stdout);
        const primaryPath = registered[0]?.path;
        const normalizedTarget = normalizeWorktreePath(worktreePath);
        if (primaryPath && normalizeWorktreePath(primaryPath) === normalizedTarget) {
          return new Response(JSON.stringify({ code: 'PRIMARY_WORKTREE', error: '주 워크트리의 브랜치는 이 기능으로 바꾸지 않습니다.' }), { status: 409, headers });
        }
        const target = registered.find(e => normalizeWorktreePath(e.path) === normalizedTarget);
        if (!target) {
          return new Response(JSON.stringify({ code: 'WORKTREE_NOT_REGISTERED', error: '이 저장소에 등록된 워크트리 경로가 아닙니다.' }), { status: 404, headers });
        }
        if (target.locked) {
          return new Response(JSON.stringify({ code: 'WORKTREE_LOCKED', error: '세션 사용 중(잠김)인 워크트리는 브랜치를 바꾸지 않습니다. 먼저 잠금을 해제하세요.' }), { status: 409, headers });
        }
        if (!existsSync(target.path)) {
          return new Response(JSON.stringify({ code: 'WORKTREE_MISSING', error: '워크트리 폴더가 없습니다.' }), { status: 409, headers });
        }
        // 브랜치를 갈아끼우면 작업 내용이 새 브랜치로 딸려간다. 커밋 안 된 게 있으면 거부.
        const dirty = await runGitForStatus(target.path, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.']);
        if (!dirty.ok) {
          return new Response(JSON.stringify({ code: 'GIT_WORKTREE_STATUS_FAILED', error: dirty.stderr || '워크트리 상태를 확인하지 못했습니다.' }), { status: 500, headers });
        }
        if (dirty.stdout.trim()) {
          return new Response(JSON.stringify({ code: 'WORKTREE_DIRTY', error: '미커밋 변경이 있는 워크트리는 브랜치를 바꾸지 않습니다. 먼저 커밋하거나 정리하세요.' }), { status: 409, headers });
        }
        const exists = await runGitForStatus(folderPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${safeBranch}`]);
        if (exists.ok && exists.stdout.trim()) {
          return new Response(JSON.stringify({ code: 'BRANCH_EXISTS', error: `이미 있는 브랜치입니다: ${safeBranch}` }), { status: 409, headers });
        }
        // base가 없으면 주 워크트리의 현재 브랜치를 기준으로 딴다(= 보통 머지 직후의 main).
        let base = typeof baseRef === 'string' && baseRef.trim() ? baseRef.trim() : '';
        if (!base) {
          const head = await runGitForStatus(folderPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
          base = head.ok && head.stdout.trim() ? head.stdout.trim() : 'HEAD';
        }
        const switched = await runGitForStatus(target.path, ['checkout', '-b', safeBranch, base]);
        if (!switched.ok) {
          return new Response(JSON.stringify({ code: 'GIT_CHECKOUT_FAILED', error: switched.stderr || '브랜치를 전환하지 못했습니다.' }), { status: 500, headers });
        }
        const now = await runGitForStatus(target.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
        return new Response(JSON.stringify({
          success: true,
          branch: now.ok ? now.stdout.trim() : safeBranch,
          base,
          renamedFrom: safeBranch !== branchName ? branchName : undefined,
        }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/move-git-worktree" && req.method === "POST") {
      try {
        const { folderPath, from } = await req.json();
        if (!folderPath || !isAbsolute(String(folderPath)) || !from || !isAbsolute(String(from))) {
          return new Response(JSON.stringify({ success: false, error: "folderPath/from 절대경로가 필요합니다." }), { status: 400, headers });
        }
        const root = String(folderPath).replace(/\/+$/, '');
        const src = String(from).replace(/\/+$/, '');
        // 앱이 만든 레거시 워크트리만 이동 허용 — Orca/외부 워크트리는 앱이 옮기면 안 된다.
        if (!isAppOwnedWorktreePath(root, src) || !isLegacyWorktreePath(root, src)) {
          return new Response(JSON.stringify({ success: false, code: "NOT_LEGACY_APP_WORKTREE", error: "이 앱이 만든 구경로(.claude/worktrees/) 워크트리만 옮길 수 있습니다." }), { status: 400, headers });
        }
        const name = src.split('/').filter(Boolean).pop() || '';
        if (!name || name.includes('..')) {
          return new Response(JSON.stringify({ success: false, error: "워크트리 이름을 확인할 수 없습니다." }), { status: 400, headers });
        }
        const to = join(root, WORKTREE_DIR, name);
        // ⚠️ 대상이 이미 있으면 git worktree move가 rc=0으로 그 **안에** 중첩시킨다(실측). 반드시 선차단.
        if (existsSync(to)) {
          return new Response(JSON.stringify({ success: false, code: "TARGET_EXISTS", error: `이미 ${to} 가 존재합니다. 먼저 정리한 뒤 다시 시도하세요.` }), { status: 409, headers });
        }
        const lockCheck = await runGitForStatus(root, gitWorktreeListArgs());
        if (lockCheck.ok) {
          const block = lockCheck.stdout.split('\n\n').find(b => b.includes(`worktree ${src}`));
          if (block && /(^|\n)locked/.test(block)) {
            return new Response(JSON.stringify({ success: false, code: "WORKTREE_LOCKED", error: "세션이 사용 중(locked)인 워크트리는 옮길 수 없습니다. 세션을 종료한 뒤 다시 시도하세요." }), { status: 409, headers });
          }
        }
        mkdirSync(join(root, WORKTREE_DIR), { recursive: true });
        const moveResult = await runGitForStatus(root, ["worktree", "move", src, to], 60_000);
        if (!moveResult.ok) {
          return new Response(JSON.stringify({ success: false, error: moveResult.stderr || "워크트리 이동에 실패했습니다." }), { status: 500, headers });
        }
        // 빈 레거시 폴더 잔재 정리 (비어 있을 때만)
        try {
          const { rmdirSync } = await import('fs');
          rmdirSync(join(root, LEGACY_WORKTREE_REL));
        } catch {}
        await ensureLocalWorktreeExclude(root);
        try { seedWorktreeLocalConfig(root, to); } catch {}
        orcaWorktreeCache = null; // 이동 직후 Orca 인식 여부를 새로 조회하도록 캐시 무효화
        return new Response(JSON.stringify({ success: true, from: src, to }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ success: false, error: String(e?.message ?? e) }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/git-init" && req.method === "POST") {
      try {
        const { folderPath, checkOnly = false } = await req.json();
        if (!folderPath || !isAbsolute(folderPath as string)) {
          return new Response(JSON.stringify({ error: "folderPath must be absolute" }), { status: 400, headers });
        }
        if (!existsSync(folderPath as string) || !statSync(folderPath as string).isDirectory()) {
          return new Response(JSON.stringify({ error: `프로젝트 폴더가 없습니다: ${folderPath}` }), { status: 400, headers });
        }
        // 이미 git repo인지 확인
        const checkProc = Bun.spawn([GIT_PATH, "rev-parse", "--git-dir"], { cwd: folderPath, stdout: "pipe", stderr: "pipe" });
        await checkProc.exited;
        const isGit = checkProc.exitCode === 0;
        if (isGit) {
          const logProc = Bun.spawn([GIT_PATH, "log", "--oneline", "-1"], { cwd: folderPath, stdout: "pipe", stderr: "pipe" });
          await logProc.exited;
          const hasCommit = logProc.exitCode === 0;
          if (checkOnly) return new Response(JSON.stringify({ alreadyGit: true, hasCommit }), { headers });
          if (hasCommit) return new Response(JSON.stringify({ alreadyGit: true, hasCommit: true }), { headers });
          // git repo지만 커밋 없음 — 현재 프로젝트 파일을 초기 기준점으로 저장
          const snapshot = await createInitialSnapshotCommit(folderPath as string);
          return new Response(JSON.stringify({ alreadyGit: true, hasCommit: snapshot.success, error: snapshot.error }), { headers });
        }
        // checkOnly 모드: git 아닌 것만 보고
        if (checkOnly) return new Response(JSON.stringify({ alreadyGit: false, hasCommit: false }), { headers });
        // git init
        const initProc = Bun.spawn([GIT_PATH, "init"], { cwd: folderPath, stdout: "pipe", stderr: "pipe" });
        await initProc.exited;
        if (initProc.exitCode !== 0) {
          const err = await new Response(initProc.stderr).text();
          return new Response(JSON.stringify({ error: err.trim() || "git init failed" }), { status: 500, headers });
        }
        const snapshot = await createInitialSnapshotCommit(folderPath as string);
        const workflow = upgradeRepositoryWorkflow(folderPath as string);
        return new Response(JSON.stringify({ initialized: true, hasCommit: snapshot.success, error: snapshot.error, repositoryWorkflow: workflow }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/git-reinitialize" && req.method === "POST") {
      try {
        const { folderPath, confirmed = false } = await req.json();
        if (!folderPath || !isAbsolute(folderPath as string)) {
          return new Response(JSON.stringify({ error: "folderPath must be absolute" }), { status: 400, headers });
        }
        if (!existsSync(folderPath as string) || !statSync(folderPath as string).isDirectory()) {
          return new Response(JSON.stringify({ error: `프로젝트 폴더가 없습니다: ${folderPath}` }), { status: 400, headers });
        }
        if (!confirmed) {
          return new Response(JSON.stringify({ error: "explicit confirmation required" }), { status: 400, headers });
        }
        const gitPath = join(folderPath as string, ".git");
        if (existsSync(gitPath)) {
          const stat = lstatSync(gitPath);
          // .git 파일은 다른 저장소에 연결된 worktree이므로 삭제하면 원본 저장소가 손상될 수 있다.
          if (!stat.isDirectory() || stat.isSymbolicLink()) {
            return new Response(JSON.stringify({ error: "Git worktree 또는 심볼릭 링크는 초기화할 수 없습니다." }), { status: 400, headers });
          }
          rmSync(gitPath, { recursive: true, force: false });
        }
        const initProc = Bun.spawn([GIT_PATH, "init"], { cwd: folderPath, stdout: "pipe", stderr: "pipe" });
        await initProc.exited;
        if (initProc.exitCode !== 0) {
          const err = await new Response(initProc.stderr).text();
          return new Response(JSON.stringify({ error: err.trim() || "git init failed" }), { status: 500, headers });
        }
        const snapshot = await createInitialSnapshotCommit(folderPath as string);
        const workflow = upgradeRepositoryWorkflow(folderPath as string);
        return new Response(JSON.stringify({ initialized: true, hasCommit: snapshot.success, error: snapshot.error, repositoryWorkflow: workflow }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/git-worktree-add" && req.method === "POST") {
      try {
        const { folderPath, branchName, worktreePath, orcaManaged = false } = await req.json();
        if (typeof folderPath !== 'string' || !folderPath || typeof branchName !== 'string' || !branchName) {
          return new Response(JSON.stringify({ error: "folderPath and branchName required" }), { status: 400, headers });
        }
        if (!isAbsolute(folderPath)) {
          return new Response(JSON.stringify({ error: "folderPath must be absolute" }), { status: 400, headers });
        }
        if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
          return new Response(JSON.stringify({ error: `프로젝트 폴더가 없습니다: ${folderPath}` }), { status: 400, headers });
        }

        // 어떤 연결 워크트리에서 요청하더라도 Git이 보고하는 첫 번째(주) 워크트리를
        // 유일한 생성 기준점으로 삼아, 워크트리 안에 다시 worktrees/가 중첩되지 않게 한다.
        const listed = await runGitForStatus(folderPath, gitWorktreeListArgs());
        if (!listed.ok) {
          return new Response(JSON.stringify({
            code: listed.timedOut ? 'GIT_WORKTREE_LIST_TIMEOUT' : 'GIT_WORKTREE_LIST_FAILED',
            error: listed.stderr || 'Git 워크트리 목록을 확인하지 못했습니다.',
          }), { status: 500, headers });
        }
        const registeredWorktrees = parseGitWorktreePorcelain(listed.stdout);
        const primaryPath = registeredWorktrees[0]?.path;
        if (!primaryPath || !isAbsolute(primaryPath)) {
          return new Response(JSON.stringify({
            code: 'GIT_PRIMARY_WORKTREE_NOT_FOUND',
            error: 'Git 주 워크트리 경로를 확인하지 못했습니다.',
          }), { status: 409, headers });
        }

        await ensureLocalWorktreeExclude(primaryPath);
        const source = inspectWorktreeSource(primaryPath, GIT_PATH);
        if (!source.ready) {
          return new Response(JSON.stringify({
            success: false,
            code: "WORKTREE_SOURCE_DIRTY",
            error: source.message,
            changedPaths: source.changedPaths,
          }), { status: 409, headers });
        }
        // Allow Unicode (Korean etc.) — only strip truly invalid git branch chars
        const safeBranch = branchName.replace(/[\s~^:?*\[\\]/g, '-').replace(/\.{2,}/g, '-').replace(/^[-.]|[-.]$/g, '') || 'branch';
        // Directory name must be ASCII-only — claude -w rejects non-ASCII paths
        const dirSafeBranch = safeBranch.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[-.]|[-.]$/g, '') || `wt${Date.now().toString(36).slice(-6)}`;
        if (orcaManaged === true) {
          if (worktreePath !== undefined && worktreePath !== null && worktreePath !== '') {
            return new Response(JSON.stringify({
              code: 'ORCA_WORKTREE_PATH_IS_MANAGED',
              error: 'Orca 관리 워크트리는 Orca가 안전한 경로를 선택하므로 별도 worktreePath를 지정할 수 없습니다.',
            }), { status: 400, headers });
          }
          const cli = resolveOrcaCli();
          if (!cli) {
            return new Response(JSON.stringify({ success: false, error: bootstrapOrcaInstall() }), { status: 400, headers });
          }
          const existingPath = registeredWorktrees.find(entry => entry.branch === safeBranch)?.path ?? null;
          if (existingPath) {
            return new Response(JSON.stringify({
              code: 'WORKTREE_BRANCH_ALREADY_CHECKED_OUT',
              error: `브랜치 '${safeBranch}'가 이미 다른 워크트리에서 사용 중입니다: ${existingPath}`,
              existingPath,
            }), { status: 409, headers });
          }
          const branchRefExists = Bun.spawnSync(
            [GIT_PATH, 'rev-parse', '--verify', '--quiet', `refs/heads/${safeBranch}`],
            { cwd: primaryPath },
          ).exitCode === 0;
          const managedName = branchRefExists ? `${dirSafeBranch}-${Date.now().toString(36).slice(-4)}` : dirSafeBranch;
          // 주 워크트리의 현재 브랜치를 base로 쓴다. detached HEAD 등으로 브랜치 이름을
          // 못 얻었을 때 'main' 문자열로 넘겨버리면 사용자가 보고 있는 커밋이 아니라
          // 엉뚱한 main에서 갈라진다 — 이 경우엔 차라리 명확히 실패시킨다.
          const primaryBranch = (registeredWorktrees[0]?.branch || '').replace(/^refs\/heads\//, '');
          if (!primaryBranch) {
            return new Response(JSON.stringify({
              success: false,
              code: 'ORCA_WORKTREE_BASE_BRANCH_UNKNOWN',
              error: '주 워크트리가 브랜치에 있지 않아(detached HEAD 등) Orca 관리 워크트리의 기준 브랜치를 정할 수 없습니다. 브랜치를 체크아웃한 뒤 다시 시도해주세요.',
            }), { status: 409, headers });
          }
          const baseBranch = primaryBranch;
          return await withOrcaLock(async () => {
            const ready = await ensureOrcaReady(cli);
            if (!ready.ok) {
              return new Response(JSON.stringify({ success: false, error: ready.error }), { status: 500, headers });
            }
            const reg = await orcaEnsureRepo(cli, primaryPath);
            if (!reg.ok) {
              return new Response(JSON.stringify({ success: false, error: reg.error }), { status: 400, headers });
            }
            const created = await nodeOrcaRunJsonRetry(cli, [
              'worktree', 'create',
              '--repo', `path:${primaryPath}`,
              '--name', managedName,
              '--base-branch', baseBranch,
              '--setup', 'inherit',
              '--no-parent',
            ], { attempts: 2, backoffMs: 700, timeoutMs: 30_000 });
            const worktree = created.result?.worktree;
            const createdPath = typeof worktree?.path === 'string' ? worktree.path : '';
            const createdBranch = typeof worktree?.branch === 'string'
              ? worktree.branch.replace(/^refs\/heads\//, '')
              : managedName;
            if (!created.ok || !createdPath || !isAbsolute(createdPath) || !existsSync(createdPath)) {
              return new Response(JSON.stringify({
                success: false,
                code: 'ORCA_WORKTREE_CREATE_NOT_VERIFIED',
                error: `Orca 관리 워크트리 생성을 확인하지 못했습니다: ${created.error || '경로 없음'}`,
              }), { status: 500, headers });
            }
            // ⚠️ 여기서 "안 보임"으로 잘못 판정하면 **방금 만든 워크트리를 지운다.**
            // nodeOrcaRunJsonRetry는 CLI 호출이 실패할 때만 재시도하므로, 호출은 성공했는데
            // 목록 반영이 아직 안 된 순간을 잡지 못한다. 등장할 때까지 직접 다시 조회한다.
            let verifiedWorktree: ReturnType<typeof verifyOrcaManagedWorktree> = null;
            for (let attempt = 0; attempt < 4 && !verifiedWorktree; attempt++) {
              if (attempt > 0) await new Promise((res) => setTimeout(res, 400 * attempt));
              const listedByOrca = await nodeOrcaRunJsonRetry(
                cli,
                ['worktree', 'list', '--repo', `path:${primaryPath}`],
                { attempts: 2, backoffMs: 300, timeoutMs: 10_000 },
              );
              if (listedByOrca.ok) {
                verifiedWorktree = verifyOrcaManagedWorktree(created.result, listedByOrca.result);
              }
            }
            if (!verifiedWorktree) {
              const rolledBack = await nodeOrcaRunJsonRetry(
                cli,
                ['worktree', 'rm', '--worktree', `path:${createdPath}`, '--force'],
                { attempts: 1, timeoutMs: 15_000 },
              ).catch(() => ({ ok: false, error: '되돌리기 호출 실패', result: null }));
              // 되돌렸다고 단정하지 않는다 — 실제로 사라졌는지 보고 사실대로 알린다.
              const rollbackDone = rolledBack.ok && !existsSync(createdPath);
              return new Response(JSON.stringify({
                success: false,
                code: 'ORCA_WORKTREE_NOT_VISIBLE',
                rolledBack: rollbackDone,
                leftoverPath: rollbackDone ? undefined : createdPath,
                error: rollbackDone
                  ? '워크트리는 만들어졌지만 Orca 목록 노출을 확인하지 못해 생성 작업을 되돌렸습니다.'
                  : `워크트리는 만들어졌지만 Orca 목록 노출을 확인하지 못했고, 되돌리기도 완료하지 못했습니다. 남은 경로를 직접 확인해주세요: ${createdPath}`,
              }), { status: 409, headers });
            }
            orcaWorktreeCache = null;
            seedWorktreeLocalConfig(primaryPath, createdPath);
            try {
              const wtEnrichedPath = `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homedir()}/.bun/bin:${homedir()}/.local/bin:${homedir()}/.cargo/bin:${process.env.PATH ?? ''}`;
              const wtInstEnv = { ...process.env, PATH: wtEnrichedPath };
              if (existsSync(join(createdPath, 'package.json'))) {
                Bun.spawn(['bun', 'install'], { cwd: createdPath, env: wtInstEnv, stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
              } else if (existsSync(join(createdPath, 'pyproject.toml'))) {
                Bun.spawn(['uv', 'sync'], { cwd: createdPath, env: wtInstEnv, stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
              }
            } catch {}
            // ⚠️ `renamedFrom`을 쓰지 않는다 — 프론트에서 그 필드는 "옛 브랜치에 main에 없는
            // 커밋이 있어 보존했다"는 뜻이고, 여기선 사실이 아니다. Orca가 이름을 정하므로
            // (ASCII 강제, 중복 시 접미사) 사용자가 입력한 이름과 다를 때만 그 사실을 알린다.
            const finalBranch = verifiedWorktree.branch || createdBranch;
            return new Response(JSON.stringify({
              success: true,
              path: verifiedWorktree.path,
              branch: finalBranch,
              orcaManaged: true,
              requestedBranch: finalBranch === safeBranch ? undefined : safeBranch,
            }), { headers });
          });
        }
        const isICloud = primaryPath.includes('com~apple~CloudDocs') || primaryPath.includes('Mobile Documents');
        // 워크트리 기본 위치는 항상 {주 워크트리}/worktrees/{dirSafeBranch}로 고정한다.
        // ⚠️ `.claude/` 같은 **숨김 폴더 아래에 두면 Orca가 스캔에서 제외**해 사이드바에 뜨지 않는다
        //    (실측: 같은 저장소라도 worktrees/x 는 Orca가 인식, .claude/worktrees/x 는 인식 못 함).
        //    비숨김 `worktrees/`로 두면 Orca가 자동 인식하고, .gitignore에 `worktrees`가 있어 커밋에도 안 잡힌다.
        //    기존 `.claude/worktrees/` 워크트리는 그대로 계속 인식/관리된다(하위호환).
        const targetPath = join(primaryPath, WORKTREE_DIR, dirSafeBranch);
        if (worktreePath !== undefined && worktreePath !== null && worktreePath !== '') {
          if (typeof worktreePath !== 'string' || !isAbsolute(worktreePath)) {
            return new Response(JSON.stringify({ error: 'worktreePath must be absolute' }), { status: 400, headers });
          }
          if (normalizeWorktreePath(worktreePath) !== normalizeWorktreePath(targetPath)) {
            return new Response(JSON.stringify({
              code: 'WORKTREE_TARGET_MUST_USE_PRIMARY',
              error: `워크트리는 주 워크트리 아래의 지정 경로에만 만들 수 있습니다: ${targetPath}`,
              expectedPath: targetPath,
            }), { status: 409, headers });
          }
        }

        const existingPath = registeredWorktrees.find(entry => entry.branch === safeBranch)?.path ?? null;
        if (existingPath) {
          const isAscii = (s: string) => /^[\x00-\x7F]*$/.test(s);
          if (normalizeWorktreePath(existingPath) === normalizeWorktreePath(targetPath) && isAscii(existingPath)) {
            seedWorktreeLocalConfig(primaryPath, existingPath);
            return new Response(JSON.stringify({ success: true, path: existingPath, existing: true }), { headers });
          }
          return new Response(JSON.stringify({
            code: 'WORKTREE_BRANCH_ALREADY_CHECKED_OUT',
            error: `브랜치 '${safeBranch}'가 이미 다른 워크트리에서 사용 중입니다: ${existingPath}`,
            existingPath,
          }), { status: 409, headers });
        }
        // 워크트리 없이 브랜치 참조만 남아있는 경우(과거 워크트리를 삭제했지만 브랜치는 그대로인 상태) —
        // 그대로 재사용하면 main이 그 뒤로 아무리 진행돼도 항상 그 시점 스냅샷으로 고정된 워크트리가
        // 생성돼, "지우고 다시 만들어도 계속 오래된 상태"인 버그가 재현된다.
        // main에 이미 반영된(ancestor) 브랜치라면 잃을 게 없으니 HEAD로 안전하게 되감고,
        // main에 없는 고유 커밋이 있다면(진짜 진행 중이던 작업) 건드리지 않고 새 이름으로 우회한다.
        let effectiveBranch = safeBranch;
        let renamedFrom: string | undefined;
        {
          const revParse = Bun.spawnSync([GIT_PATH, "rev-parse", "--verify", "--quiet", `refs/heads/${effectiveBranch}`], { cwd: primaryPath });
          const branchExists = revParse.exitCode === 0;
          if (branchExists) {
            const isAncestor = Bun.spawnSync(
              [GIT_PATH, "merge-base", "--is-ancestor", effectiveBranch, "HEAD"],
              { cwd: primaryPath },
            );
            if (isAncestor.exitCode === 0) {
              // main에 이미 포함된 오래된 브랜치 — 되감아도 유실되는 커밋 없음
              Bun.spawnSync([GIT_PATH, "branch", "-f", effectiveBranch, "HEAD"], { cwd: primaryPath });
            } else {
              // main에 없는 고유 커밋 보유 — 기존 작업 보존을 위해 새 브랜치명으로 우회
              renamedFrom = effectiveBranch;
              effectiveBranch = `${effectiveBranch}-${Date.now().toString(36).slice(-4)}`;
            }
          }
        }
        // iCloud 경로: --no-checkout으로 add 후 target에서 checkout (SIGBUS 우회)
        const addFlags = isICloud ? ["--no-checkout"] : [];
        // Try existing branch first, then create new branch
        let proc = Bun.spawn([GIT_PATH, "worktree", "add", ...addFlags, targetPath, effectiveBranch], {
          cwd: primaryPath, stdout: "pipe", stderr: "pipe",
        });
        await proc.exited;
        if (proc.exitCode !== 0) {
          proc = Bun.spawn([GIT_PATH, "worktree", "add", ...addFlags, "-b", effectiveBranch, targetPath], {
            cwd: primaryPath, stdout: "pipe", stderr: "pipe",
          });
          await proc.exited;
        }
        const stderr = await new Response(proc.stderr).text();
        if (proc.exitCode !== 0) {
          return new Response(JSON.stringify({ error: stderr.trim() || "git worktree add failed" }), { status: 500, headers });
        }
        // iCloud: checkout from target dir (outside iCloud) to actually populate files
        if (isICloud) {
          const coProc = Bun.spawn([GIT_PATH, "checkout"], { cwd: targetPath, stdout: "pipe", stderr: "pipe" });
          await coProc.exited;
          // non-fatal: proceed even if checkout fails
        }
        // gitignore된 로컬 설정(.claude 훅/권한/스킬, .env)은 워크트리에 따라오지 않는다 — 심어준다
        seedWorktreeLocalConfig(primaryPath, targetPath);
        // 새 워크트리에는 node_modules/.venv가 없어 dev 서버가 즉시 ENOENT로 죽는 문제를 방지 —
        // 실행 버튼을 기다리지 않고 백그라운드로 의존성 설치를 미리 시작해둔다
        try {
          // GUI/최소 PATH 환경에서도 bun/uv를 찾도록 PATH 보강 (Rust spawn_dependency_install과 동일 취지)
          const wtEnrichedPath = IS_WIN
            ? process.env.PATH ?? ""
            : `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homedir()}/.bun/bin:${homedir()}/.local/bin:${homedir()}/.cargo/bin:${process.env.PATH ?? ""}`;
          const wtInstEnv = { ...process.env, PATH: wtEnrichedPath };
          if (existsSync(join(targetPath, 'package.json'))) {
            Bun.spawn(["bun", "install"], { cwd: targetPath, env: wtInstEnv, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
          } else if (existsSync(join(targetPath, 'pyproject.toml'))) {
            Bun.spawn(["uv", "sync"], { cwd: targetPath, env: wtInstEnv, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
          }
        } catch {}
        return new Response(JSON.stringify({ success: true, path: targetPath, branch: effectiveBranch, renamedFrom }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/git-worktree-remove" && req.method === "POST") {
      try {
        const { folderPath, worktreePath, orcaManaged = false } = await req.json();
        if (typeof folderPath !== 'string' || !folderPath || typeof worktreePath !== 'string' || !worktreePath) {
          return new Response(JSON.stringify({ error: "folderPath and worktreePath required" }), { status: 400, headers });
        }
        if (!isAbsolute(folderPath) || !isAbsolute(worktreePath)) {
          return new Response(JSON.stringify({ error: "folderPath and worktreePath must be absolute" }), { status: 400, headers });
        }
        if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
          return new Response(JSON.stringify({ error: `프로젝트 폴더가 없습니다: ${folderPath}` }), { status: 400, headers });
        }

        // 요청 경로 자체나 .git 파일을 신뢰하지 않는다. 제공된 저장소에서 Git이
        // 등록했다고 보고한 정확한 연결 워크트리만 제거 대상으로 인정한다.
        const listed = await runGitForStatus(folderPath, gitWorktreeListArgs());
        if (!listed.ok) {
          return new Response(JSON.stringify({
            code: listed.timedOut ? 'GIT_WORKTREE_LIST_TIMEOUT' : 'GIT_WORKTREE_LIST_FAILED',
            error: listed.stderr || 'Git 워크트리 목록을 확인하지 못했습니다.',
          }), { status: 500, headers });
        }
        const registered = parseGitWorktreePorcelain(listed.stdout);
        const primaryPath = registered[0]?.path;
        if (!primaryPath || !isAbsolute(primaryPath)) {
          return new Response(JSON.stringify({
            code: 'GIT_PRIMARY_WORKTREE_NOT_FOUND',
            error: 'Git 주 워크트리 경로를 확인하지 못했습니다.',
          }), { status: 409, headers });
        }
        const normalizedTarget = normalizeWorktreePath(worktreePath);
        if (normalizedTarget === normalizeWorktreePath(primaryPath)) {
          return new Response(JSON.stringify({
            code: 'PRIMARY_WORKTREE_REMOVE_DENIED',
            error: '주 워크트리는 이 기능으로 삭제할 수 없습니다.',
          }), { status: 409, headers });
        }
        const target = registered.find(entry => normalizeWorktreePath(entry.path) === normalizedTarget);
        if (!target) {
          return new Response(JSON.stringify({
            code: 'WORKTREE_NOT_REGISTERED',
            error: '이 저장소에 정확히 등록된 워크트리 경로가 아닙니다.',
          }), { status: 404, headers });
        }
        if (target.locked) {
          return new Response(JSON.stringify({
            code: 'WORKTREE_LOCKED',
            error: `잠긴 워크트리는 자동으로 잠금을 해제하거나 삭제하지 않습니다: ${target.path}`,
          }), { status: 409, headers });
        }

        // 물리 폴더가 외부에서 이미 사라진 경우에만 stale 메타데이터를 prune한다.
        // 존재하는 폴더에는 prune이나 재귀 삭제 폴백을 절대 적용하지 않는다.
        if (!existsSync(target.path)) {
          const prune = await runGitForStatus(primaryPath, ["worktree", "prune", "--expire", "now"]);
          if (!prune.ok) {
            return new Response(JSON.stringify({
              code: 'GIT_WORKTREE_PRUNE_FAILED',
              error: prune.stderr || '사라진 워크트리 메타데이터를 정리하지 못했습니다.',
            }), { status: 500, headers });
          }
          const verified = await runGitForStatus(primaryPath, gitWorktreeListArgs());
          if (!verified.ok) {
            return new Response(JSON.stringify({
              code: 'GIT_WORKTREE_VERIFY_FAILED',
              error: verified.stderr || '워크트리 제거 결과를 확인하지 못했습니다.',
            }), { status: 500, headers });
          }
          const stillRegistered = parseGitWorktreePorcelain(verified.stdout)
            .some(entry => normalizeWorktreePath(entry.path) === normalizedTarget);
          if (stillRegistered) {
            return new Response(JSON.stringify({
              code: 'GIT_WORKTREE_PRUNE_INCOMPLETE',
              error: '워크트리 폴더는 없지만 Git 등록이 남아 있습니다. 잠금 여부를 직접 확인해주세요.',
            }), { status: 500, headers });
          }
          return new Response(JSON.stringify({ success: true, recovered: true }), { headers });
        }

        // `--force`는 확인 모달 한 번으로 미커밋 파일까지 지워 버린다. 실제 Git 상태를
        // 백엔드에서 다시 확인하고, 변경이 있으면 사용자가 먼저 커밋/정리하도록 거부한다.
        const dirty = await runGitForStatus(
          target.path,
          ['status', '--porcelain=v1', '--untracked-files=all', '--', '.'],
        );
        if (!dirty.ok) {
          return new Response(JSON.stringify({
            code: dirty.timedOut ? 'GIT_WORKTREE_STATUS_TIMEOUT' : 'GIT_WORKTREE_STATUS_FAILED',
            error: dirty.stderr || '삭제 전 워크트리 상태를 확인하지 못했습니다.',
          }), { status: 500, headers });
        }
        if (dirty.stdout.trim()) {
          return new Response(JSON.stringify({
            code: 'WORKTREE_DIRTY',
            error: '미커밋 변경 또는 추적되지 않은 파일이 있는 워크트리는 삭제하지 않습니다. 먼저 커밋하거나 직접 정리하세요.',
          }), { status: 409, headers });
        }

        // Orca 관리 워크트리는 Orca CLI로 지워야 Orca 그래프에도 반영된다.
        // 다만 **Orca를 못 쓴다고 해서 사용자의 삭제 자체가 막히면 안 된다** —
        // Orca 미설치/미기동/CLI 실패는 일반 `git worktree remove`로 이어서 진행한다.
        // (더티/잠금/주 워크트리 가드는 이 지점 이전에 이미 통과했으므로 덜 안전해지지 않는다.)
        let orcaFallbackReason = '';
        if (orcaManaged === true) {
          const cli = resolveOrcaCli();
          const orcaOutcome = cli
            ? await withOrcaLock(async (): Promise<{ done: boolean; reason: string }> => {
              const ready = await ensureOrcaReady(cli);
              if (!ready.ok) return { done: false, reason: ready.error };
              const removedByOrca = await nodeOrcaRunJsonRetry(
                cli,
                ['worktree', 'rm', '--worktree', `path:${target.path}`, '--force'],
                { attempts: 2, backoffMs: 500, timeoutMs: 20_000 },
              );
              return removedByOrca.ok
                ? { done: true, reason: '' }
                : { done: false, reason: removedByOrca.error };
            })
            : { done: false, reason: 'Orca CLI를 찾을 수 없습니다.' };

          if (orcaOutcome.done) {
            const verified = await runGitForStatus(primaryPath, gitWorktreeListArgs());
            const stillRegistered = verified.ok && parseGitWorktreePorcelain(verified.stdout)
              .some(entry => normalizeWorktreePath(entry.path) === normalizedTarget);
            if (!verified.ok || stillRegistered || existsSync(target.path)) {
              return new Response(JSON.stringify({
                code: 'ORCA_WORKTREE_REMOVE_INCOMPLETE',
                error: !verified.ok
                  ? (verified.stderr || 'Orca 제거 후 Git 상태를 확인하지 못했습니다.')
                  : 'Orca 관리 워크트리 제거 후 경로 또는 Git 등록이 남아 있습니다.',
              }), { status: 500, headers });
            }
            orcaWorktreeCache = null;
            return new Response(JSON.stringify({ success: true, orcaManaged: true }), { headers });
          }
          orcaFallbackReason = orcaOutcome.reason;
        }

        const removed = await runGitForStatus(primaryPath, ["worktree", "remove", target.path], 30_000);
        if (!removed.ok) {
          return new Response(JSON.stringify({
            code: removed.timedOut ? 'GIT_WORKTREE_REMOVE_TIMEOUT' : 'GIT_WORKTREE_REMOVE_FAILED',
            error: removed.stderr || 'git worktree remove 실패',
          }), { status: 500, headers });
        }

        const verified = await runGitForStatus(primaryPath, gitWorktreeListArgs());
        if (!verified.ok) {
          return new Response(JSON.stringify({
            code: 'GIT_WORKTREE_VERIFY_FAILED',
            error: verified.stderr || '워크트리 제거 결과를 확인하지 못했습니다.',
          }), { status: 500, headers });
        }
        const stillRegistered = parseGitWorktreePorcelain(verified.stdout)
          .some(entry => normalizeWorktreePath(entry.path) === normalizedTarget);
        if (stillRegistered || existsSync(target.path)) {
          return new Response(JSON.stringify({
            code: 'GIT_WORKTREE_REMOVE_INCOMPLETE',
            error: stillRegistered
              ? 'Git 워크트리 등록이 아직 남아 있습니다.'
              : `Git 등록은 제거됐지만 폴더가 남아 있습니다. 자동 재귀 삭제는 수행하지 않았습니다: ${target.path}`,
          }), { status: 500, headers });
        }
        // Orca 목록에 사라진 경로가 남지 않도록 캐시를 비워 다음 조회에서 다시 스캔한다.
        if (orcaFallbackReason) orcaWorktreeCache = null;
        return new Response(JSON.stringify(
          orcaFallbackReason
            ? { success: true, orcaFallback: true, orcaFallbackReason }
            : { success: true },
        ), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/cleanup-stale-worktrees" && req.method === "POST") {
      try {
        const { folderPath } = await req.json();
        if (typeof folderPath !== 'string' || !folderPath || !isAbsolute(folderPath)) {
          return new Response(JSON.stringify({ error: 'folderPath must be absolute' }), { status: 400, headers });
        }
        if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
          return new Response(JSON.stringify({ success: true, skipped: true }), { headers });
        }
        // 시작 시 모든 프로젝트 카드에 대해 호출된다. .git 표식이 없는 일반 폴더는
        // Git 프로세스를 만들 필요 없이 즉시 건너뛰어 콘솔 500과 subprocess churn을 막는다.
        if (!existsSync(join(folderPath, '.git'))) {
          return new Response(JSON.stringify({ success: true, skipped: true, reason: 'not-a-git-repository' }), { headers });
        }
        // Git 자체 prune만 사용한다. 잠긴 항목은 자동 해제하지 않고, 존재하는
        // 미등록 폴더도 재귀 삭제하지 않는다. 실제 폴더가 사라진 stale 메타만 정리된다.
        const listed = await runGitForStatus(folderPath, gitWorktreeListArgs());
        if (!listed.ok) {
          if (/not a git repository|not a git repo/i.test(listed.stderr)) {
            return new Response(JSON.stringify({
              success: true,
              skipped: true,
              reason: 'not-a-git-repository',
            }), { headers });
          }
          return new Response(JSON.stringify({
            success: false,
            code: 'GIT_WORKTREE_LIST_FAILED',
            error: listed.stderr || 'Git 워크트리 목록을 확인하지 못했습니다.',
          }), { status: 500, headers });
        }
        const primaryPath = parseGitWorktreePorcelain(listed.stdout)[0]?.path;
        if (!primaryPath) {
          return new Response(JSON.stringify({ success: false, code: 'GIT_PRIMARY_WORKTREE_NOT_FOUND', error: 'Git 주 워크트리를 찾지 못했습니다.' }), { status: 409, headers });
        }
        const prune = await runGitForStatus(primaryPath, ["worktree", "prune"]);
        if (!prune.ok) {
          return new Response(JSON.stringify({ success: false, code: 'GIT_WORKTREE_PRUNE_FAILED', error: prune.stderr || 'Git 워크트리 정리에 실패했습니다.' }), { status: 500, headers });
        }
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/git-merge-preview" && req.method === "POST") {
      try {
        const { folderPath, branchName } = await req.json();
        if (!folderPath || !branchName) return new Response(JSON.stringify({ error: "missing params" }), { status: 400, headers });
        // 진행 중인 머지가 있는지 확인 (MERGE_HEAD)
        const mergeInProgress = existsSync(`${folderPath}/.git/MERGE_HEAD`);
        if (mergeInProgress) {
          return new Response(JSON.stringify({
            error: "이미 진행 중인 머지가 있습니다.\n충돌을 해결하고 'git add' 후 커밋하거나, 'Abort Merge'로 취소하세요.",
            hasMergeInProgress: true
          }), { status: 409, headers });
        }
        // 메인 브랜치 이름 파악
        const mainProc = Bun.spawn([GIT_PATH, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: folderPath, stdout: "pipe", stderr: "pipe" });
        await mainProc.exited;
        const mainBranch = (await new Response(mainProc.stdout).text()).trim();
        // 머지될 커밋 목록
        const logProc = Bun.spawn([GIT_PATH, "log", `${mainBranch}..${branchName}`, "--oneline", "--no-decorate"], { cwd: folderPath, stdout: "pipe", stderr: "pipe" });
        await logProc.exited;
        const commits = (await new Response(logProc.stdout).text()).trim();
        // 파일 변경 통계
        const statProc = Bun.spawn([GIT_PATH, "diff", "--stat", `${mainBranch}...${branchName}`], { cwd: folderPath, stdout: "pipe", stderr: "pipe" });
        await statProc.exited;
        const stat = (await new Response(statProc.stdout).text()).trim();
        // 워킹 트리 dirty 여부 (경고용, 차단 아님 — --autostash로 자동 처리됨)
        const statusProc = Bun.spawn([GIT_PATH, "status", "--porcelain"], { cwd: folderPath, stdout: "pipe", stderr: "pipe" });
        await statusProc.exited;
        const isDirty = (await new Response(statusProc.stdout).text()).trim().length > 0;
        return new Response(JSON.stringify({ mainBranch, commits, stat, isDirty }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/git-merge-abort" && req.method === "POST") {
      try {
        const { folderPath, force } = await req.json();
        const proc = Bun.spawn([GIT_PATH, "merge", "--abort"], { cwd: folderPath, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        if (proc.exitCode !== 0) {
          if (force) {
            // fallback: reset --merge to clean up stuck state
            const resetProc = Bun.spawn([GIT_PATH, "reset", "--merge"], { cwd: folderPath, stdout: "pipe", stderr: "pipe" });
            await resetProc.exited;
            const resetStderr = await new Response(resetProc.stderr).text();
            if (resetProc.exitCode !== 0) return new Response(JSON.stringify({ error: resetStderr.trim() || stderr.trim() }), { status: 500, headers });
            return new Response(JSON.stringify({ success: true, method: "reset-merge" }), { headers });
          }
          return new Response(JSON.stringify({ error: stderr.trim() }), { status: 500, headers });
        }
        return new Response(JSON.stringify({ success: true, method: "merge-abort" }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/git-conflicts" && req.method === "POST") {
      try {
        const { folderPath } = await req.json();
        const proc = Bun.spawn([GIT_PATH, "diff", "--name-only", "--diff-filter=U"], { cwd: folderPath, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        const stdout = (await new Response(proc.stdout).text()).trim();
        const files = stdout ? stdout.split("\n").filter(Boolean) : [];
        return new Response(JSON.stringify({ files }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ files: [], error: error.message }), { headers });
      }
    }

    // 폴더별 마지막 git 커밋 시각(ms) 일괄 조회 — 앱 버튼 클릭이 아닌 터미널/에디터에서
    // 직접 작업한 경우에도 "마지막 실행"이 실제 작업 시점에 가깝게 보이도록 보정하는 용도
    if (url.pathname === "/api/last-git-activity" && req.method === "POST") {
      try {
        const { items } = await req.json() as { items: { portId: string; folderPath: string }[] };
        const results = await Promise.all((items || []).map(async ({ portId, folderPath }) => {
          if (!folderPath) return [portId, null] as const;
          try {
            const proc = Bun.spawn([GIT_PATH, "log", "-1", "--format=%ct"], { cwd: folderPath, stdout: "pipe", stderr: "pipe" });
            await proc.exited;
            if (proc.exitCode !== 0) return [portId, null] as const;
            const out = (await new Response(proc.stdout).text()).trim();
            const sec = parseInt(out, 10);
            return [portId, Number.isFinite(sec) ? sec * 1000 : null] as const;
          } catch {
            return [portId, null] as const;
          }
        }));
        return new Response(JSON.stringify(Object.fromEntries(results)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-terminal-at-folder" && req.method === "POST") {
      try {
        const { folderPath, title: titleArg, terminalApp = 'iterm' } = await req.json();
        const expandedPath = folderPath === '~' ? homedir() : String(folderPath).startsWith('~/') ? `${homedir()}/${String(folderPath).slice(2)}` : String(folderPath);
        if (!isAbsolute(expandedPath) || !existsSync(expandedPath) || !statSync(expandedPath).isDirectory()) {
          return new Response(JSON.stringify({ success: false, error: `폴더를 찾을 수 없습니다: ${expandedPath}` }), { status: 400, headers });
        }
        if (IS_WIN) {
          const launch = await openTerminalWithCmd('', expandedPath, titleArg || expandedPath, 'terminal');
          return new Response(JSON.stringify(launchPayload('터미널 열림', launch)), { headers });
        }
        const title = (titleArg || expandedPath).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const cmd = `cd '${escapeSq(expandedPath)}' && printf '\\033]0;${title}\\007'`;
        const escapedCmd = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const script = terminalApp === 'terminal'
          ? `tell application "Terminal"\n  activate\n  do script "${escapedCmd}"\nend tell`
          : `tell application "iTerm"\n  activate\n  set newWindow to create window with default profile\n  tell current session of newWindow\n    write text "${escapedCmd}"\n    delay 0.3\n    set name to "${title}"\n  end tell\nend tell`;
        const launch = await runAppleScriptChecked(script);
        return new Response(JSON.stringify(launchPayload(`${terminalApp === 'terminal' ? 'Terminal' : 'iTerm'} 터미널 열림`, launch)), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/open-terminal-git-merge" && req.method === "POST") {
      try {
        const { folderPath, branchName, name } = await req.json();
        const label = (name || branchName) as string;
        const title = `[git-merge] ${label}`;
        if (IS_WIN) {
          // cmd.exe: 변수 이스케이프 걱정 없이 큰따옴표로 감싸면 됨
          const shellCmd = `git merge --no-ff --autostash "${(branchName as string).replace(/"/g, '""')}"`;
          await openTerminalWithCmd(shellCmd, folderPath as string, title);
        } else {
          const escTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const cmd = `cd '${escapeSq(folderPath as string)}' && git merge --no-ff --autostash '${escapeSq(branchName as string)}'`;
          const escapedCmd = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const script = `tell application "iTerm"\n  activate\n  set newWindow to create window with default profile\n  tell current session of newWindow\n    write text "${escapedCmd}"\n    delay 0.5\n    set name to "${escTitle}"\n  end tell\nend tell`;
          await runAppleScriptChecked(script);
        }
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/git-merge-branch" && req.method === "POST") {
      let folderPath: string | undefined;
      try {
        let branchName: string | undefined;
        ({ folderPath, branchName } = await req.json());
        if (!folderPath || !branchName) {
          return new Response(JSON.stringify({ error: "folderPath and branchName required" }), { status: 400, headers });
        }
        if (!isAbsolute(folderPath as string)) {
          return new Response(JSON.stringify({ error: "folderPath must be absolute" }), { status: 400, headers });
        }
        // --autostash: 변경 사항 자동 스태시 후 머지, 이후 자동 팝
        const proc = Bun.spawn([GIT_PATH, "merge", "--no-ff", "--no-edit", "--autostash", branchName], {
          cwd: folderPath, stdout: "pipe", stderr: "pipe",
          env: { ...process.env, GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0" },
        });
        await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        if (proc.exitCode !== 0) {
          const msg = stderr.trim() || stdout.trim() || "git merge failed";
          const friendly = msg.includes('signal: 10') || msg.includes('SIGBUS')
            ? `iCloud 동기화로 머지 실패. Finder에서 iCloud 다운로드를 강제하거나 메인 레포를 iCloud 밖으로 이동하세요.`
            : msg.includes('CONFLICT') ? `충돌 발생: ${msg}\n→ git merge --abort 로 취소 가능`
            : msg;
          return new Response(JSON.stringify({ error: friendly }), { status: 500, headers });
        }
        return new Response(JSON.stringify({ success: true, output: stdout.trim() }), { headers });
      } catch (e: any) {
        const msg = String(e.message || e);
        const err = msg.includes('ENOENT')
          ? `폴더를 찾을 수 없습니다 (iCloud/Google Drive 동기화 문제?): ${folderPath}`
          : msg;
        return new Response(JSON.stringify({ error: err }), { status: 500, headers });
      }
    }

    // Portal 데이터 로드
    if (url.pathname === "/api/portal" && req.method === "GET") {
      try {
        const { hostname } = await import("node:os");
        const file = Bun.file(PORTAL_DATA_FILE);
        const base = { _hostname: hostname() };
        if (await file.exists()) {
          const data = await file.json();
          return new Response(JSON.stringify({ ...base, ...data }), { headers });
        }
        return new Response(JSON.stringify({ ...base, items: [], categories: [] }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // Portal 데이터 저장
    // ── 장기기억 아카이브 ───────────────────────────────────────────────────
    // 프로젝트를 지워도 거기서 얻은 노하우는 남긴다. 원본을 **복사**만 하므로 아카이브가
    // 실패해도 삭제를 막지 않고, 성공하면 폴더가 사라져도 내용이 남는다.
    if (url.pathname === "/api/memory-archive" && req.method === "POST") {
      try {
        const body = await req.json() as {
          folderPath?: unknown; projectName?: unknown; projectCode?: unknown; reason?: unknown;
        };
        const folderPath = typeof body.folderPath === "string" ? body.folderPath : "";
        if (!folderPath || !isAbsolute(folderPath)) {
          return new Response(JSON.stringify({ error: "절대 폴더 경로가 필요합니다." }), { status: 400, headers });
        }
        const status = detectProjectMemory(folderPath);
        if (!status.exists || !status.memoryPath) {
          // 기억이 없는 프로젝트는 오류가 아니다 — 보관할 것이 없을 뿐이다.
          return new Response(JSON.stringify({ archived: false, reason: "NO_MEMORY" }), { headers });
        }
        // 분해된 문서는 색인만 읽으면 본문을 잃는다. 반드시 이 경로로 합쳐 읽는다.
        const content = readMemoryDocument(status.projectRoot, status.memoryPath);
        const archivedAt = new Date().toISOString();
        const meta = {
          id: crypto.randomUUID(),
          projectName: typeof body.projectName === "string" && body.projectName.trim()
            ? body.projectName.trim().slice(0, 120)
            : basename(folderPath),
          projectCode: typeof body.projectCode === "string" ? body.projectCode.slice(0, 32) : "",
          sourcePath: folderPath,
          archivedAt,
          reason: typeof body.reason === "string" ? body.reason.slice(0, 60) : "manual",
          bytes: Buffer.byteLength(content, "utf8"),
          summary: summarizeMemory(content),
          file: "",
        };
        const dir = join(APP_DATA_DIR, "memory-archive");
        mkdirSync(dir, { recursive: true });
        let name = archiveFileName(meta);
        for (let n = 2; existsSync(join(dir, name)); n += 1) {
          name = archiveFileName(meta).replace(/\.md$/, `-${n}.md`);
        }
        meta.file = name;
        writeFileSync(join(dir, name), `${archiveHeader(meta)}${content}`, "utf8");
        writeFileSync(join(dir, name.replace(/\.md$/, ".json")), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
        return new Response(JSON.stringify({ archived: true, ...meta }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/memory-archive" && req.method === "GET") {
      try {
        const dir = join(APP_DATA_DIR, "memory-archive");
        if (!existsSync(dir)) return new Response(JSON.stringify({ items: [], dir }), { headers });
        const wanted = url.searchParams.get("file");
        if (wanted) {
          // 목록에 있는 이름만 연다 — 경로 조각이 섞인 값은 거절한다.
          if (wanted.includes("/") || wanted.includes("\\") || !wanted.endsWith(".md")) {
            return new Response(JSON.stringify({ error: "잘못된 파일명" }), { status: 400, headers });
          }
          const path = join(dir, wanted);
          if (!existsSync(path)) return new Response(JSON.stringify({ error: "없는 아카이브" }), { status: 404, headers });
          return new Response(JSON.stringify({ file: wanted, content: readFileSync(path, "utf8") }), { headers });
        }
        const items = readdirSync(dir)
          .filter(name => name.endsWith(".json"))
          .sort()
          .reverse()
          .map(name => {
            try { return JSON.parse(readFileSync(join(dir, name), "utf8")); }
            catch { return { file: name.replace(/\.json$/, ".md"), unreadable: true }; }
          });
        return new Response(JSON.stringify({ items, dir }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // ── VOC(개선 요청) ─────────────────────────────────────────────────────
    // 로컬 파일이 언제나 정본이다. 사용자가 명시적으로 전송을 선택한 건만 공개 Edge
    // Function으로 보내며, 실패/한도 초과가 로컬 저장을 롤백하지 않는다.
    if (url.pathname === "/api/voc/access" && req.method === "GET") {
      try {
        return new Response(JSON.stringify(await checkRemoteVocAccess({ appDataDir: APP_DATA_DIR })), { headers });
      } catch {
        // 네트워크/receiver 장애로 정상 사용자를 잠그지 않는다. 명시적인 app 차단 응답만
        // 프런트가 사용 중지 화면으로 바꾼다.
        return new Response(JSON.stringify({ configured: true, blocked: false, scope: null, unverified: true }), { headers });
      }
    }

    if (url.pathname === "/api/voc" && req.method === "POST") {
      try {
        const body = await req.json() as {
          comment?: unknown;
          anchor?: unknown;
          tab?: unknown;
          appVersion?: unknown;
          sendRemote?: unknown;
        };
        const comment = typeof body.comment === "string" ? body.comment.trim() : "";
        if (!comment) {
          return new Response(JSON.stringify({ error: "내용이 비어 있습니다." }), { status: 400, headers });
        }
        if (comment.length > MAX_VOC_COMMENT_LENGTH) {
          return new Response(JSON.stringify({
            error: `내용은 ${MAX_VOC_COMMENT_LENGTH.toLocaleString()}자 이하로 입력해주세요.`,
          }), { status: 400, headers });
        }
        const anchor = normalizeVocAnchor(body.anchor);
        const record: import('./src/vocAnchor').VocRecord & {
          delivery?: { requested: boolean; attemptedAt?: string; status: string; remaining?: number; dailyLimit?: number; error?: string };
        } = {
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          appVersion: typeof body.appVersion === "string" ? body.appVersion : "",
          tab: typeof body.tab === "string" ? body.tab : "",
          anchor,
          comment,
          status: "open" as const,
        };
        const dir = join(APP_DATA_DIR, "voc");
        mkdirSync(dir, { recursive: true });
        const name = vocFileName(record);
        // 같은 분에 같은 요소를 두 번 남길 수 있다. 덮어쓰면 방금 쓴 글이 사라지므로
        // 비어 있는 이름을 찾을 때까지 접미사를 붙인다.
        let file = join(dir, name);
        for (let n = 2; existsSync(file); n += 1) {
          file = join(dir, name.replace(/\.json$/, `-${n}.json`));
        }
        writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");

        const requested = body.sendRemote === true;
        const delivery = requested
          ? await submitRemoteVoc({ appDataDir: APP_DATA_DIR, record })
          : { status: 'local_only' as const };
        record.delivery = {
          requested,
          ...(requested ? { attemptedAt: new Date().toISOString() } : {}),
          ...delivery,
        };
        // 전송 결과까지 로컬 기록에 남겨 나중에 "받았는지"를 추측하지 않게 한다.
        writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
        return new Response(JSON.stringify({ success: true, file, id: record.id, delivery }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/voc" && req.method === "GET") {
      try {
        const dir = join(APP_DATA_DIR, "voc");
        if (!existsSync(dir)) return new Response(JSON.stringify({ items: [], dir }), { headers });
        const items = readdirSync(dir)
          .filter(name => name.endsWith(".json"))
          .sort()
          .reverse()
          .map(name => {
            try { return { file: name, ...JSON.parse(readFileSync(join(dir, name), "utf8")) }; }
            catch { return { file: name, unreadable: true }; }
          });
        return new Response(JSON.stringify({ items, dir }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 공개 VOC 수집 설정은 receiver 프로젝트의 service_role 키가 있는 운영자 PC에서만
    // 관리한다. 엔드포인트 주소는 공개값이지만 service_role 값은 응답하지 않는다.
    if (url.pathname === "/api/voc-admin/settings" && req.method === "GET") {
      try {
        const serviceRoleKey = loadServiceRoleKey(APP_DATA_DIR);
        if (!serviceRoleKey) {
          return new Response(JSON.stringify({ error: "service_role 키가 필요합니다." }), { status: 403, headers });
        }
        return new Response(JSON.stringify(await loadVocAdminSettings({ serviceRoleKey })), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers });
      }
    }

    if (url.pathname === "/api/voc-admin/settings" && req.method === "PUT") {
      try {
        const serviceRoleKey = loadServiceRoleKey(APP_DATA_DIR);
        if (!serviceRoleKey) {
          return new Response(JSON.stringify({ error: "service_role 키가 필요합니다." }), { status: 403, headers });
        }
        const body = await req.json() as { accepting?: unknown; dailyLimit?: unknown };
        const result = await updateVocAdminSettings({
          serviceRoleKey,
          accepting: body.accepting === true,
          dailyLimit: Number(body.dailyLimit),
        });
        return new Response(JSON.stringify(result), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/voc-admin/block" && req.method === "POST") {
      try {
        const serviceRoleKey = loadServiceRoleKey(APP_DATA_DIR);
        if (!serviceRoleKey) {
          return new Response(JSON.stringify({ error: "service_role 키가 필요합니다." }), { status: 403, headers });
        }
        const body = await req.json() as {
          deviceHash?: unknown;
          scope?: unknown;
          operatorNote?: unknown;
          expiresAt?: unknown;
        };
        await upsertVocDeviceBlock({
          serviceRoleKey,
          deviceHash: String(body.deviceHash ?? ''),
          scope: body.scope === 'app' ? 'app' : 'voc',
          operatorNote: String(body.operatorNote ?? ''),
          expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
        });
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/voc-admin/block" && req.method === "DELETE") {
      try {
        const serviceRoleKey = loadServiceRoleKey(APP_DATA_DIR);
        if (!serviceRoleKey) {
          return new Response(JSON.stringify({ error: "service_role 키가 필요합니다." }), { status: 403, headers });
        }
        await removeVocDeviceBlock({ serviceRoleKey, deviceHash: url.searchParams.get('deviceHash') ?? '' });
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400, headers });
      }
    }

    if (url.pathname === "/api/portal" && req.method === "POST") {
      try {
        const data = await req.json();
        if (!existsSync(APP_DATA_DIR)) {
          const { mkdirSync } = await import("node:fs");
          mkdirSync(APP_DATA_DIR, { recursive: true });
        }
        await Bun.write(PORTAL_DATA_FILE, JSON.stringify(data, null, 2));
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // Port visits: record a click/action
    if (url.pathname === "/api/port-visits" && req.method === "POST") {
      try {
        const { portId, deviceId, supabaseUrl, supabaseKey } = await req.json() as {
          portId: string; deviceId: string; supabaseUrl: string; supabaseKey: string;
        };
        if (!supabaseUrl || !supabaseKey) return new Response(JSON.stringify({ error: 'no_credentials' }), { status: 400, headers });
        const res = await fetch(`${supabaseUrl}/rest/v1/port_visits`, {
          method: 'POST',
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ port_id: portId, device_id: deviceId }),
        });
        if (!res.ok) throw new Error(await res.text());
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // Port visits: get top ports by window (alltime | weekly | daily)
    if (url.pathname === "/api/port-visits" && req.method === "GET") {
      try {
        const supabaseUrl = url.searchParams.get('supabaseUrl') || '';
        const supabaseKey = url.searchParams.get('supabaseKey') || '';
        const window = url.searchParams.get('window') || 'alltime';
        const deviceId = url.searchParams.get('deviceId') || '';
        if (!supabaseUrl || !supabaseKey) return new Response(JSON.stringify([]), { headers });
        let filter = `device_id=eq.${encodeURIComponent(deviceId)}`;
        if (window === 'daily') {
          const since = new Date(Date.now() - 86400000).toISOString();
          filter += `&visited_at=gte.${encodeURIComponent(since)}`;
        } else if (window === 'weekly') {
          const since = new Date(Date.now() - 7 * 86400000).toISOString();
          filter += `&visited_at=gte.${encodeURIComponent(since)}`;
        }
        const res = await fetch(`${supabaseUrl}/rest/v1/port_visits?select=port_id&${filter}`, {
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
        });
        if (!res.ok) throw new Error(await res.text());
        const rows = await res.json() as { port_id: string }[];
        const counts: Record<string, number> = {};
        for (const r of rows) counts[r.port_id] = (counts[r.port_id] || 0) + 1;
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([portId, count]) => ({ portId, count }));
        return new Response(JSON.stringify(sorted), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify([]), { headers });
      }
    }

    // AI: suggest category for a single project
    // AI: batch name + category for multiple ports in ONE claude call
    if (url.pathname === "/api/suggest-batch" && req.method === "POST") {
      try {
        const { ports: batchPorts } = await req.json() as { ports: Array<{ id: string; folderPath: string; name: string }> };
        if (!CLAUDE_PATH) {
          return new Response(JSON.stringify({ error: 'claude_not_found' }), { status: 503, headers });
        }
        if (!Array.isArray(batchPorts) || batchPorts.length === 0) {
          return new Response(JSON.stringify({ results: [] }), { headers });
        }
        const { readdirSync, readFileSync } = await import("node:fs");

        // Build project summaries for prompt
        const summaries = (batchPorts as Array<{ id: string; folderPath: string; name: string; aiName?: string }>).map((p, i) => {
          let files = '', pkg = '';
          try {
            if (existsSync(p.folderPath)) {
              files = readdirSync(p.folderPath).slice(0, 15).join(', ');
              const pkgPath = join(p.folderPath, 'package.json');
              if (existsSync(pkgPath)) pkg = readFileSync(pkgPath, 'utf-8').slice(0, 200);
            }
          } catch {}
          const displayName = p.aiName || p.name;
          return `${i + 1}. id="${p.id}" display_name="${displayName}" raw_name="${p.name}" files=[${files}]${pkg ? ` pkg=${pkg.replace(/\n/g, ' ')}` : ''}`;
        }).join('\n');

        const prompt = `Analyze these ${batchPorts.length} projects and return a JSON array ONLY (no markdown, no explanation).
IMPORTANT: derive the "name" and "category" primarily from display_name (the human-readable name), not from raw file listings.
category must be a single lowercase word that describes WHAT this project does (e.g. converter, dashboard, manager, tracker, bot, guide, calculator, automation, monitor, generator, etc.)

Return format:
[{"id":"...","name":"2-4 word English alias","category":"single lowercase word"},...]

Projects:
${summaries}`;

        const run = await runClaudePrompt(prompt, { timeoutMs: 90_000, label: 'suggest-batch' });
        if (!run.ok) {
          return new Response(JSON.stringify({ results: [], error: run.error }), { headers });
        }
        const raw = run.text;
        const match = raw.match(/\[[\s\S]*\]/);
        if (!match) {
          console.error("[suggest-batch] no JSON array in output:", raw.slice(0, 300));
          return new Response(JSON.stringify({ results: [] }), { headers });
        }
        const parsed: Array<{ id: string; name: string; category: string }> = JSON.parse(match[0]);
        return new Response(JSON.stringify({ results: parsed }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // AI: suggest-category (legacy, kept for backward compat)
    if (url.pathname === "/api/suggest-category" && req.method === "POST") {
      try {
        const { folderPath, name } = await req.json();
        const res = await fetch(`http://localhost:${server.port}/api/suggest-name-and-category`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath, name }),
        });
        const d = await res.json() as any;
        return new Response(JSON.stringify({ category: d.category ?? null }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // AI: suggest-name (legacy, kept for backward compat)
    if (url.pathname === "/api/suggest-name" && req.method === "POST") {
      try {
        const { folderPath } = await req.json();
        const res = await fetch(`http://localhost:${server.port}/api/suggest-name-and-category`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath }),
        });
        const d = await res.json() as any;
        return new Response(JSON.stringify({ suggestions: d.name ? [d.name] : [] }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // AI: name + category in ONE claude call (fast path)
    if (url.pathname === "/api/suggest-name-and-category" && req.method === "POST") {
      try {
        const { folderPath, name } = await req.json();
        if (!CLAUDE_PATH) {
          return new Response(JSON.stringify({ error: 'claude_not_found' }), { status: 503, headers });
        }
        if (!folderPath || !existsSync(folderPath)) {
          return new Response(JSON.stringify({ error: 'invalid_folder' }), { status: 400, headers });
        }
        const { readdirSync, readFileSync } = await import("node:fs");
        const files = readdirSync(folderPath).slice(0, 30).join(', ');
        let pkgJson = '';
        const pkgPath = join(folderPath, 'package.json');
        if (existsSync(pkgPath)) {
          try { pkgJson = readFileSync(pkgPath, 'utf-8').slice(0, 400); } catch {}
        }
        const prompt = `Project name hint: ${name || 'unknown'}
Files: ${files}
package.json excerpt: ${pkgJson}

Analyze this project and reply with JSON only (no markdown, no explanation):
{"name":"2-4 word English alias","category":"one short topic word that best describes this project (e.g. converter, dashboard, automation, chatbot, portfolio, tracker, etc.)"}`;
        const run = await runClaudePrompt(prompt, { timeoutMs: 30_000, label: 'suggest-name-and-category' });
        if (!run.ok) {
          return new Response(JSON.stringify({ name: null, category: null, error: run.error }), { headers });
        }
        const raw = run.text;
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
          console.error("[suggest-name-and-category] no JSON object in output:", raw.slice(0, 300));
          return new Response(JSON.stringify({ name: null, category: null }), { headers });
        }
        const parsed = JSON.parse(match[0]);
        return new Response(JSON.stringify({
          name: typeof parsed.name === 'string' ? parsed.name.slice(0, 60) : null,
          category: typeof parsed.category === 'string' ? parsed.category.slice(0, 30).toLowerCase() : null,
        }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // AI: generate project description from folder
    if (url.pathname === "/api/generate-description" && req.method === "POST") {
      try {
        const { folderPath, name } = await req.json();

        if (!CLAUDE_PATH) {
          return new Response(JSON.stringify({ error: 'claude_not_found' }), { status: 503, headers });
        }
        if (!folderPath || !existsSync(folderPath)) {
          return new Response(JSON.stringify({ error: 'invalid_folder' }), { status: 400, headers });
        }
        const { readdirSync, readFileSync } = await import("node:fs");
        const files = readdirSync(folderPath).slice(0, 30).join(', ');
        let pkgJson = '';
        const pkgPath = join(folderPath, 'package.json');
        if (existsSync(pkgPath)) {
          try { pkgJson = readFileSync(pkgPath, 'utf-8').slice(0, 500); } catch {}
        }
        const prompt = `Project name: ${name || 'unknown'}\nFiles: ${files}\npackage.json: ${pkgJson}\n\nWrite a one-sentence project description (max 100 chars, English). Reply with plain text only, no quotes.`;
        const run = await runClaudePrompt(prompt, { timeoutMs: 30_000, label: 'generate-description' });
        if (!run.ok) {
          return new Response(JSON.stringify({ description: "", error: run.error }), { headers });
        }
        const description = run.text.slice(0, 120);
        return new Response(JSON.stringify({ description }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // ── AI 사용량 조회 ────────────────────────────────────────────────────────
    // Claude: `claude -p "/usage"` prints the same report as the interactive command.
    if (url.pathname === "/api/ai-usage/claude" && req.method === "GET") {
      try {
        const run = await runClaudePrompt('/usage', { timeoutMs: 60_000, label: 'ai-usage-claude' });
        if (!run.ok) {
          return new Response(JSON.stringify({ error: run.error }), { status: 500, headers });
        }
        return new Response(JSON.stringify({ report: run.text, checkedAt: new Date().toISOString() }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // A context row navigates by its server-verified session ID only.  Never
    // accept a client-provided handle, cwd, app name, or deep-link URL here.
    if (url.pathname === "/api/context-sessions/navigate" && req.method === "POST") {
      try {
        const body = await req.json().catch(() => ({})) as { sessionId?: unknown; sourceAgent?: unknown };
        const sessionId = body.sessionId;
        const sourceAgent = body.sourceAgent;
        if (!isSafeContextSessionId(sessionId) || (sourceAgent !== 'claude' && sourceAgent !== 'codex')) {
          return new Response(JSON.stringify({
            success: false,
            code: 'INVALID_CONTEXT_SESSION',
            error: '올바른 세션 식별자가 필요합니다.',
          }), { status: 400, headers });
        }

        let outcome: ContextSessionFocusOutcome;
        if (sourceAgent === 'codex') {
          if (!isRecordedChatGptCodexSession(sessionId)) {
            outcome = {
              success: false,
              code: 'CODEX_SESSION_UNAVAILABLE',
              error: '현재 ChatGPT 데스크톱 Codex 세션으로 확인되지 않아 이동하지 않았습니다.',
            };
          } else if (IS_WIN) {
            outcome = {
              success: false,
              code: 'CHATGPT_THREAD_NAVIGATION_UNSUPPORTED',
              error: '현재 Windows에서는 ChatGPT Codex 작업 이동을 지원하지 않습니다.',
            };
          } else {
            // The installed ChatGPT app owns the `codex` scheme. This is the
            // existing-thread route, deliberately not `threads/new`.
            const opened = nodeSpawnSync('open', ['-a', 'ChatGPT', `codex://threads/${sessionId}`], { stdio: 'pipe' });
            const detail = String((opened as any).stderr ?? '').trim() || (opened as any).error?.message;
            outcome = opened.status === 0 && !(opened as any).error
              ? { success: true, exact: true, message: 'ChatGPT 앱의 해당 Codex 작업으로 이동했습니다.' }
              : { success: false, code: 'CHATGPT_THREAD_FOCUS_FAILED', error: `ChatGPT 작업을 열지 못했습니다.${detail ? ` (${detail})` : ''}` };
          }
        } else {
          const snapshot = readClaudeContextSnapshot(sessionId);
          if (!snapshot) {
            outcome = {
              success: false,
              code: 'CLAUDE_SESSION_UNAVAILABLE',
              error: '현재 컨텍스트 스냅샷을 찾지 못했습니다. 세션이 종료됐거나 오래된 정보일 수 있습니다.',
            };
          } else {
            const navigation = resolveClaudeSessionNavigation(snapshot.launchContext);
            if (!navigation.available || !navigation.kind) {
              outcome = { success: false, code: 'SESSION_NAVIGATION_UNSUPPORTED', error: navigation.detail };
            } else if (navigation.kind === 'cmux-surface') {
              outcome = await focusCmuxContextSession(snapshot.launchContext ?? {});
            } else if (navigation.kind === 'orca-worktree-terminal') {
              outcome = await focusOrcaWorktreeContextSession(sessionId, snapshot.launchContext ?? {});
            } else if (navigation.kind === 'orca-floating-workspace') {
              outcome = await revealOrcaFloatingContextSession();
            } else {
              outcome = { success: false, code: 'SESSION_NAVIGATION_UNSUPPORTED', error: '지원하지 않는 세션 이동 방식입니다.' };
            }
          }
        }
        return new Response(JSON.stringify(outcome), { status: outcome.success ? 200 : 409, headers });
      } catch (error: any) {
        return new Response(JSON.stringify({
          success: false,
          code: 'CONTEXT_SESSION_NAVIGATION_FAILED',
          error: error?.message || String(error),
        }), { status: 500, headers });
      }
    }

    // Live context-window readings for Claude sessions.
    //
    // Claude Code hands its status line a `context_window` block on every render
    // (size, current usage, used/remaining %). A capture shim in the user's
    // statusline script drops each payload into <appData>/context/<session_id>.json,
    // so this endpoint is a plain directory read — no transcript parsing, no tokens,
    // and no guessing the window size (the 1M variant reports 1000000 correctly).
    if (url.pathname === "/api/context-usage" && req.method === "GET") {
      try {
        const dir = join(APP_DATA_DIR, 'context');
        const now = Date.now();
        const claudeSnapshotRows = existsSync(dir) ? readdirSync(dir)
          .filter((f: string) => f.endsWith('.json'))
          .map((f: string) => {
            const full = join(dir, f);
            try {
              const snap = JSON.parse(readFileSync(full, 'utf-8'));
              const cw = snap.contextWindow ?? {};
              const capturedAt = snap.capturedAt ?? new Date(statSync(full).mtimeMs).toISOString();
              const ageMs = now - new Date(capturedAt).getTime();
              return {
                launchContext: snap.launchContext ?? null,
                session: {
                  sessionId: snap.sessionId,
                  sourceAgent: 'claude',
                  cwd: snap.cwd ?? null,
                  projectDir: snap.projectDir ?? null,
                  modelId: snap.model?.id ?? null,
                  modelName: snap.model?.display_name ?? null,
                  windowSize: cw.context_window_size ?? null,
                  usedPercent: cw.used_percentage ?? null,
                  remainingPercent: cw.remaining_percentage ?? null,
                  usedTokens: cw.current_usage
                    ? (cw.current_usage.input_tokens ?? 0)
                      + (cw.current_usage.cache_creation_input_tokens ?? 0)
                      + (cw.current_usage.cache_read_input_tokens ?? 0)
                    : null,
                  costUsd: snap.cost?.total_cost_usd ?? null,
                  capturedAt,
                  ageMs,
                  // Origin and navigation are resolved after the runtime probes
                  // below: a session with an empty launch context is only
                  // recognizable as a background agent from the agent listing.
                  // The status line only re-renders while the session is being used, so a
                  // stale file is a finished or idle session, not a live reading.
                  state: ageMs < 5 * 60_000 ? 'active' : ageMs < 6 * 60 * 60_000 ? 'idle' : 'stale',
                },
              };
            } catch { return null; }
          })
          .filter((row): row is NonNullable<typeof row> => (
            row !== null && !!row.session.sessionId && row.session.usedPercent !== null
          ))
          : [];

        // Codex stores session metadata at the start of each rollout and the current
        // context count near its tail. Read bounded head/tail slices so the five-second
        // UI poll never loads multi-megabyte transcripts or prompt bodies into memory.
        const codexSessions: any[] = [];
        const chatGptThreadMetadataSnapshot = readChatGptThreadMetadataSnapshot();
        const chatGptThreadMetadata = chatGptThreadMetadataSnapshot.metadata;
        // This compact metadata scan includes project-bound Voice threads even
        // when they have no token-count event, which is normal for a Voice
        // conversation. Its stamp cache keeps the 5s panel poll inexpensive.
        const chatGptVoiceSnapshot = readChatGptVoiceCandidateSnapshot();
        const voiceBindingStateFor = (candidate: ProjectCodexVoiceCandidate) => {
          // A cached project assignment is useful for keeping the row visible,
          // but not proof that this Voice is still safe to attach to durable
          // project memory. Fail closed until the current desktop state parses.
          if (chatGptThreadMetadataSnapshot.availability !== 'fresh' || !chatGptVoiceSnapshot.available) {
            return 'unverifiable';
          }
          const entry = chatGptThreadMetadata.get(candidate.sessionId);
          const hint = entry?.projectHint;
          const folderPath = hint?.pendingPath ?? hint?.assignedPath ?? hint?.path ?? null;
          if (!folderPath) {
            return 'not-associated';
          }
          return classifyProjectCodexSession({
            folderPath,
            candidates: [candidate],
            metadata: chatGptThreadMetadata,
            projectMetadataAvailable: true,
            rolloutHeadersAvailable: true,
          }).voice.state;
        };
        const sessionsDir = join(homedir(), '.codex', 'sessions');
        if (existsSync(sessionsDir)) {
          const files = (readdirSync(sessionsDir, { recursive: true }) as string[])
            .filter(f => f.endsWith('.jsonl'))
            .map(f => {
              const full = join(sessionsDir, f);
              try {
                const stat = statSync(full);
                return { full, size: stat.size, mtimeMs: stat.mtimeMs };
              } catch { return null; }
            })
            .filter((x): x is { full: string; size: number; mtimeMs: number } => x !== null)
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            // Subagents are intentionally hidden below. Inspect a wider recent
            // window first so a burst of implementation rollouts cannot crowd
            // out the user's desktop/voice chat from this panel.
            .slice(0, 96);

          for (const file of files) {
            try {
              const summary = readCodexRolloutSummary(
                file.full,
                { mtimeMs: file.mtimeMs, size: file.size },
                () => {
                  const headSize = Math.min(file.size, 64 * 1024);
                  const tailSize = Math.min(file.size, 512 * 1024);
                  const fd = openSync(file.full, 'r');
                  const head = Buffer.alloc(headSize);
                  const tail = Buffer.alloc(tailSize);
                  try {
                    readSync(fd, head, 0, headSize, 0);
                    readSync(fd, tail, 0, tailSize, Math.max(0, file.size - tailSize));
                  } finally {
                    closeSync(fd);
                  }
                  const lines = `${head.toString('utf-8')}\n${tail.toString('utf-8')}`.split('\n');
                  let meta: any = null;
                  let turn: any = null;
                  let tokenEvent: any = null;
                  for (const line of lines) {
                    if (!line.trim().startsWith('{')) continue;
                    try {
                      const row = JSON.parse(line);
                      if (row.type === 'session_meta' && !meta) meta = row.payload;
                      else if (row.type === 'turn_context') turn = row.payload;
                      else if (row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload?.info) tokenEvent = row;
                    } catch { /* bounded slices may begin/end inside a JSON line */ }
                  }
                  return { meta, turn, tokenEvent };
                },
              );
              const meta = summary?.meta ?? null;
              const turn = summary?.turn ?? null;
              const tokenEvent = summary?.tokenEvent ?? null;
              // Subagent rollouts are implementation detail and would swamp the human
              // session list. Their parent Codex app session remains visible.
              if (!meta || meta.thread_source === 'subagent') continue;
              const sessionId = typeof meta.id === 'string'
                ? meta.id
                : typeof meta.session_id === 'string' ? meta.session_id : null;
              if (!sessionId) continue;
              const isDesktopVoice = meta.originator === 'Codex Desktop'
                && meta.thread_source === 'realtime_voice';
              const info = tokenEvent?.payload?.info ?? null;
              const usedTokens = typeof info?.last_token_usage?.total_tokens === 'number'
                ? info.last_token_usage.total_tokens
                : null;
              const windowSize = typeof (info?.model_context_window ?? meta.context_window) === 'number'
                ? (info?.model_context_window ?? meta.context_window) as number
                : null;
              const hasUsageReading = usedTokens !== null && windowSize !== null && windowSize > 0;
              // Voice rollouts commonly do not emit a token-count event. They
              // still need a context row when ChatGPT records a project move;
              // ordinary no-usage rollouts remain hidden to avoid turning this
              // panel into a raw session-history dump.
              if (!hasUsageReading && !isDesktopVoice) continue;
              const usedPercent = hasUsageReading
                ? Math.min(100, Math.round((usedTokens / windowSize) * 1000) / 10)
                : null;
              const capturedAt = tokenEvent?.timestamp ?? new Date(file.mtimeMs).toISOString();
              const ageMs = now - new Date(capturedAt).getTime();
              const cwd = turn?.cwd ?? meta.cwd ?? null;
              const origin = classifyCodexSessionOrigin({
                originator: meta.originator,
                source: meta.source,
                cwd,
                threadSource: meta.thread_source,
              });
              const desktopMetadata = meta.originator === 'Codex Desktop' && typeof sessionId === 'string'
                ? chatGptThreadMetadata.get(sessionId) ?? null
                : null;
              const voiceCandidate = isDesktopVoice
                ? chatGptVoiceSnapshot.candidates.find((candidate) => candidate.sessionId === sessionId) ?? null
                : null;
              codexSessions.push({
                sessionId,
                sourceAgent: 'codex',
                cwd,
                initialCwd: meta.cwd ?? null,
                projectDir: null,
                threadSource: typeof meta.thread_source === 'string' ? meta.thread_source : null,
                threadTitle: desktopMetadata?.threadTitle ?? null,
                projectHint: desktopMetadata?.projectHint ?? null,
                modelId: turn?.model ?? null,
                modelName: turn?.model ?? (isDesktopVoice ? 'Codex Voice' : 'Codex'),
                windowSize,
                usedPercent,
                remainingPercent: usedPercent === null ? null : Math.max(0, Math.round((100 - usedPercent) * 10) / 10),
                usedTokens,
                costUsd: null,
                capturedAt,
                ageMs,
                ...origin,
                originator: meta.originator ?? null,
                voiceBindingState: voiceCandidate ? voiceBindingStateFor(voiceCandidate) : undefined,
                navigation: resolveCodexSessionNavigation(origin),
                // Codex rollout JSONL has no public foreground-window signal.
                // Keep it as a recent record rather than claiming a live surface.
                surfacePresence: 'not-applicable' as ContextSurfacePresence,
                state: ageMs < 5 * 60_000 ? 'active' : ageMs < 6 * 60 * 60_000 ? 'idle' : 'stale',
              });
              if (codexSessions.length >= 24) break;
            } catch { /* skip an unreadable rollout */ }
          }
        }

        // A project-bound Voice conversation can be older than the recent 96
        // rollout window, or have no token-count event at all. Add those
        // records explicitly so a user who moved a Voice chat into a project
        // can still find it in AI usage and continue that project's memory.
        const displayedCodexSessionIds = new Set(
          codexSessions
            .map((session) => typeof session.sessionId === 'string' ? session.sessionId : null)
            .filter((sessionId): sessionId is string => !!sessionId),
        );
        let addedProjectVoiceRows = 0;
        for (const candidate of chatGptVoiceSnapshot.candidates
          .filter((entry) => entry.originator === 'Codex Desktop' && entry.threadSource === 'realtime_voice')
          .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)) {
          if (displayedCodexSessionIds.has(candidate.sessionId)) continue;
          const desktopMetadata = chatGptThreadMetadata.get(candidate.sessionId) ?? null;
          if (!desktopMetadata?.projectHint) continue;
          const cwd = candidate.latestTurnCwd ?? desktopMetadata.projectHint.appliedPath ?? null;
          const origin = classifyCodexSessionOrigin({
            originator: candidate.originator,
            source: null,
            cwd,
            threadSource: candidate.threadSource,
          });
          const ageMs = Math.max(0, now - candidate.modifiedAtMs);
          codexSessions.push({
            sessionId: candidate.sessionId,
            sourceAgent: 'codex',
            cwd,
            initialCwd: null,
            projectDir: null,
            threadSource: candidate.threadSource,
            threadTitle: desktopMetadata.threadTitle,
            projectHint: desktopMetadata.projectHint,
            modelId: null,
            modelName: 'Codex Voice',
            windowSize: null,
            usedPercent: null,
            remainingPercent: null,
            usedTokens: null,
            costUsd: null,
            capturedAt: new Date(candidate.modifiedAtMs).toISOString(),
            ageMs,
            ...origin,
            originator: candidate.originator,
            voiceBindingState: voiceBindingStateFor(candidate),
            navigation: resolveCodexSessionNavigation(origin),
            surfacePresence: 'not-applicable' as ContextSurfacePresence,
            state: ageMs < 5 * 60_000 ? 'active' : ageMs < 6 * 60 * 60_000 ? 'idle' : 'stale',
          });
          displayedCodexSessionIds.add(candidate.sessionId);
          addedProjectVoiceRows += 1;
          if (addedProjectVoiceRows >= 24) break;
        }

        // The filesystem snapshot proves only when the usage was captured. For
        // Orca/cmux it must agree with the live runtime before the UI treats a
        // row as an open surface. Probe only rows that could be displayed; old
        // history remains on disk without spending a CLI call every poll.
        //
        // Codex's rollout has no persisted Orca pane/session binding, but its
        // origin can still say it came from Orca. Run the same single passive
        // Orca status probe in that case so a stopped Orca cannot leave a
        // falsely-current "Orca 플로팅" Codex row in the list.
        const hasCodexOrcaSurface = codexSessions.some((session) => (
          session.state !== 'stale'
          && (session.surfaceKind === 'orca-floating' || session.surfaceKind === 'orca-worktree')
        ));
        const claudeSurfaceInspection = await inspectClaudeContextSurfacePresence(
          claudeSnapshotRows
            .filter(({ session }) => session.state !== 'stale')
            .map(({ session, launchContext }) => ({ sessionId: session.sessionId, launchContext })),
          { probeOrcaRuntimeWhenEmpty: hasCodexOrcaSurface },
        );
        const claudeSessions = claudeSnapshotRows.map(({ session, launchContext }) => {
          const runtimeFacts = claudeAgentRuntimeFacts(
            claudeSurfaceInspection.agentInventory,
            session.sessionId,
          );
          const metadata = readClaudeSessionMetadata(session.sessionId);
          return {
            ...session,
            // `projectDir` is the repository root, while `cwd` may legitimately
            // be a subdirectory. Preserve the actual initial cwd so the UI does
            // not report a project move just because Claude started in /src.
            initialCwd: session.cwd ?? session.projectDir ?? null,
            threadSource: null,
            threadTitle: metadata?.threadTitle ?? null,
            projectHint: metadata?.projectHint ?? null,
            ...classifyClaudeSessionOrigin(launchContext, runtimeFacts),
            navigation: resolveClaudeSessionNavigation(launchContext, runtimeFacts),
            surfacePresence: claudeSurfaceInspection.presence.get(session.sessionId) ?? 'not-applicable',
          };
        });
        // A Codex CLI session lives in a process; when none exists the row is a
        // finished session, not a window we failed to locate.
        const hasCodexCliSession = codexSessions.some((session) => (
          session.originator === 'codex-tui' && session.state !== 'stale'
        ));
        const codexCliState = hasCodexCliSession
          ? await readCodexTuiRuntimeState()
          : 'unverified';
        for (const session of codexSessions) {
          if (session.surfaceKind === 'orca-floating' || session.surfaceKind === 'orca-worktree') {
            session.surfacePresence = unboundOrcaContextSurfacePresence(
              claudeSurfaceInspection.orcaRuntimeState,
            );
          } else if (session.originator === 'codex-tui') {
            session.surfacePresence = codexTuiSurfacePresence(codexCliState);
          }
        }

        const sessions = [...claudeSessions, ...codexSessions].sort((a, b) => a.ageMs - b.ageMs);

        return new Response(JSON.stringify({
          sessions,
          captureInstalled: existsSync(dir),
          codexCaptureAvailable: existsSync(sessionsDir),
        }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message, sessions: [] }), { status: 500, headers });
      }
    }

    // Codex app-server exposes the same authenticated account rate limits used by
    // its UI. `codex exec` is deliberately never used here because it creates an
    // agent turn. A rollout snapshot remains a fast offline/older-CLI fallback.
    if (url.pathname === "/api/ai-usage/codex" && req.method === "GET") {
      let liveError: unknown = null;
      try {
        const live = await getLiveCodexRateLimits(url.searchParams.get('fresh') === '1');
        return new Response(JSON.stringify(live), { headers });
      } catch (error) {
        liveError = error;
        devLog('[CodexUsage] live app-server read failed; falling back to rollout snapshot:', error);
      }

      try {
        const sessionsDir = join(homedir(), '.codex', 'sessions');
        if (!existsSync(sessionsDir)) {
          return new Response(JSON.stringify({
            error: 'Codex 실시간 한도 조회에 실패했고 세션 기록(~/.codex/sessions)도 없습니다. Codex에 로그인한 뒤 다시 시도해주세요.',
          }), { status: 404, headers });
        }
        const { readdirSync, statSync } = await import('node:fs');
        const files = readdirSync(sessionsDir, { recursive: true } as any)
          .filter((f: any) => typeof f === 'string' && f.endsWith('.jsonl'))
          .map((f: any) => {
            const full = join(sessionsDir, f as string);
            try { return { full, mtime: statSync(full).mtimeMs }; } catch { return null; }
          })
          .filter((x): x is { full: string; mtime: number } => x !== null)
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 8);

        // rate_limits is nested inside token_count events and its own shape has nested
        // objects, so parse each JSONL line and walk it rather than pattern-matching text.
        const findRateLimits = (node: any, depth = 0): { rateLimits: any; capturedAt?: string } | null => {
          if (!node || typeof node !== 'object' || depth > 6) return null;
          if (node.rate_limits && typeof node.rate_limits === 'object') {
            return {
              rateLimits: node.rate_limits,
              capturedAt: typeof node.timestamp === 'string' ? node.timestamp : undefined,
            };
          }
          for (const value of Object.values(node)) {
            const hit = findRateLimits(value, depth + 1);
            if (hit) return hit;
          }
          return null;
        };

        for (const f of files) {
          const text = await Bun.file(f.full).text().catch(() => '');
          if (!text) continue;
          let found: { rateLimits: any; capturedAt?: string } | null = null;
          for (const line of text.split('\n')) {
            if (!line.includes('rate_limits')) continue;
            try { found = findRateLimits(JSON.parse(line)) ?? found; } catch { /* skip bad line */ }
          }
          if (found) {
            const rateLimits = normalizeCodexRateLimits(found.rateLimits);
            if (!rateLimits) continue;
            return new Response(JSON.stringify({
              rateLimits,
              source: 'session-log',
              sourceFile: f.full.replace(homedir(), '~'),
              checkedAt: found.capturedAt ?? new Date(f.mtime).toISOString(),
            }), { headers });
          }
        }
        return new Response(JSON.stringify({
          error: 'Codex 실시간 한도 조회에 실패했고 최근 세션 기록에서도 사용량 정보를 찾지 못했습니다.',
        }), { status: 404, headers });
      } catch (e: any) {
        const detail = liveError instanceof Error ? liveError.message : e?.message || String(e);
        return new Response(JSON.stringify({ error: `Codex 한도 조회 실패: ${detail}` }), { status: 500, headers });
      }
    }

    // ── Supabase CLI helpers ──────────────────────────────────────────────────
    if (url.pathname === "/api/supabase-cli/status" && req.method === "GET") {
      try {
        const isWin = process.platform === "win32";
        const home = isWin
          ? process.env.USERPROFILE ?? process.env.HOME ?? ""
          : process.env.HOME ?? process.env.USERPROFILE ?? "";
        const appData = process.env.APPDATA ?? "";
        const localAppData = process.env.LOCALAPPDATA ?? "";

        // Candidate paths (macOS/Linux + Windows Scoop/winget)
        const candidatePaths = isWin ? [
          `${home}\\scoop\\apps\\supabase\\current\\supabase.exe`,
          `${localAppData}\\Microsoft\\WinGet\\Packages\\Supabase.CLI\\supabase.exe`,
          `${home}\\.local\\bin\\supabase.exe`,
          "C:\\Program Files\\supabase\\supabase.exe",
        ] : [
          `${home}/.local/bin/supabase`,
          "/opt/homebrew/bin/supabase",
          "/usr/local/bin/supabase",
        ];
        let cliPath = "";
        for (const p of candidatePaths) {
          if (p && existsSync(p)) { cliPath = p; break; }
        }

        // PATH-resolved fallback: `where` on Windows, `which` on Unix
        if (!cliPath) {
          const whichCmd = isWin ? ["where", "supabase"] : ["which", "supabase"];
          try {
            const w = Bun.spawn(whichCmd, { stdout: "pipe", stderr: "pipe" });
            await w.exited;
            if (w.exitCode === 0) {
              const out = (await new Response(w.stdout).text()).trim();
              cliPath = (out.split(/\r?\n/)[0] ?? '').trim(); // first line only
            }
          } catch { /* ignore */ }
        }

        if (!cliPath) {
          const loginCmd = isWin
            ? "bun install -g supabase  # 설치 후: supabase login"
            : "brew install supabase/tap/supabase  # 설치 후: supabase login";
          return new Response(JSON.stringify({ installed: false, loginCmd }), { headers });
        }

        const extraPath = isWin
          ? `${home}\\scoop\\shims;${process.env.PATH ?? ""}`
          : `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${home}/.local/bin:${process.env.PATH ?? ""}`;

        const proc = Bun.spawn([cliPath, "projects", "list"], {
          stdout: "pipe", stderr: "pipe",
          env: { ...process.env, PATH: extraPath },
        });
        await proc.exited;
        const out = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();

        if (proc.exitCode !== 0 || /not logged in|unauthorized|login/i.test(out + err)) {
          return new Response(JSON.stringify({
            installed: true, loggedIn: false, cliPath,
            loginCmd: `${cliPath} login`,
          }), { headers });
        }

        // parse table rows: LINKED | ORG ID | REFERENCE ID | NAME | REGION | CREATED AT
        const projects = out.split("\n")
          .filter(l => l.includes("|") && !l.includes("REFERENCE ID") && !l.includes("------"))
          .map(line => {
            const parts = line.split("|").map(p => p.trim());
            return { ref: parts[2], name: parts[3], region: parts[4] };
          })
          .filter(p => p.ref && p.name);

        return new Response(JSON.stringify({ installed: true, loggedIn: true, projects, cliPath }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ installed: false, error: e.message }), { headers });
      }
    }

    if (url.pathname === "/api/supabase-cli/apikeys" && req.method === "GET") {
      const ref = url.searchParams.get("ref");
      if (!ref) return new Response(JSON.stringify({ error: "ref required" }), { status: 400, headers });
      try {
        const isWin = process.platform === "win32";
        const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
        const appData = process.env.APPDATA ?? "";
        let token = "";

        if (!isWin) {
          // macOS: try Keychain first
          try {
            const kc = Bun.spawn(["security", "find-generic-password", "-s", "Supabase CLI", "-a", "supabase", "-w"], {
              stdout: "pipe", stderr: "pipe",
            });
            await kc.exited;
            if (kc.exitCode === 0) token = (await new Response(kc.stdout).text()).trim();
          } catch { /* not available */ }
        }

        // File-based token — macOS: ~/.supabase/access-token, Windows: %APPDATA%\supabase\access-token
        if (!token) {
          const tokenPaths = isWin
            ? [`${appData}\\supabase\\access-token`, `${home}\\.supabase\\access-token`]
            : [`${home}/.supabase/access-token`];
          for (const tp of tokenPaths) {
            if (!tp) continue;
            const f = Bun.file(tp);
            if (await f.exists()) { token = (await f.text()).trim(); break; }
          }
        }

        if (!token) {
          return new Response(JSON.stringify({ error: "no_token" }), { status: 401, headers });
        }

        // macOS Keychain base64 encoding
        if (token.startsWith("go-keyring-base64:")) {
          token = Buffer.from(token.slice("go-keyring-base64:".length), "base64").toString("utf-8").trim();
        }

        const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          return new Response(JSON.stringify({ error: "api_error", status: res.status }), { status: res.status, headers });
        }
        const keys = await res.json() as Array<{ name: string; api_key: string }>;
        const anonKey = keys.find(k => k.name === "anon")?.api_key ?? "";
        return new Response(JSON.stringify({ anonKey, projectUrl: `https://${ref}.supabase.co` }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // ─── Supabase CLI: link project + create tables ──────────────────────────

    if (url.pathname === "/api/supabase-cli/link" && req.method === "POST") {
      try {
        const { ref } = await req.json() as any;
        if (!ref) return new Response(JSON.stringify({ error: "ref 필수" }), { status: 400, headers });

        const statusRes = await fetch(`http://localhost:${server.port}/api/supabase-cli/status`);
        const statusData = await statusRes.json() as any;
        if (!statusData.cliPath) return new Response(JSON.stringify({ error: "Supabase CLI 미설치" }), { status: 400, headers });

        const cliPath = statusData.cliPath;
        const extraPath = IS_WIN
          ? `${homedir()}\\scoop\\shims;${process.env.PATH ?? ""}`
          : `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homedir()}/.local/bin:${process.env.PATH ?? ""}`;

        const p = Bun.spawn([cliPath, "link", "--project-ref", ref, "--experimental"], {
          stdout: "pipe", stderr: "pipe",
          env: { ...process.env, PATH: extraPath },
          stdin: "pipe",
        });
        await p.exited;
        const out = await new Response(p.stdout).text();
        const err = await new Response(p.stderr).text();
        const combined = out + err;

        if (p.exitCode !== 0 && !combined.includes("linked")) {
          return new Response(JSON.stringify({ error: `링크 실패: ${err.slice(0, 200)}` }), { status: 500, headers });
        }
        return new Response(JSON.stringify({ success: true, ref, message: `프로젝트 ${ref} 링크 완료` }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/supabase-cli/create-tables" && req.method === "POST") {
      try {
        const { ref, allowedEmails } = await req.json() as any;
        if (!ref) return new Response(JSON.stringify({ error: "ref 필수" }), { status: 400, headers });
        if (!Array.isArray(allowedEmails) || allowedEmails.length === 0) {
          return new Response(JSON.stringify({ error: "서버 RLS에 등록할 허용 이메일 필수" }), { status: 400, headers });
        }

        const statusRes = await fetch(`http://localhost:${server.port}/api/supabase-cli/status`);
        const statusData = await statusRes.json() as any;
        const cliPath = statusData.cliPath ?? "supabase";
        const extraPath = IS_WIN
          ? `${homedir()}\\scoop\\shims;${process.env.PATH ?? ""}`
          : `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homedir()}/.local/bin:${process.env.PATH ?? ""}`;

        // 모든 설치 경로가 같은 정본 SQL에 owner membership만 추가한다.
        let ddl: string;
        try {
          ddl = migrationSqlForAllowedEmails(allowedEmails);
        } catch (error) {
          return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), { status: 400, headers });
        }

        // 임시 SQL 파일 저장
        const sqlFile = IS_WIN
          ? `${process.env.TEMP ?? "C:\\Temp"}\\portmgr_schema.sql`
          : `/tmp/portmgr_schema.sql`;
        await Bun.write(sqlFile, ddl);

        // supabase db query --linked --file /tmp/portmgr_schema.sql
        const p = Bun.spawn([cliPath, "db", "query", "--linked", "--file", sqlFile], {
          stdout: "pipe", stderr: "pipe",
          env: { ...process.env, PATH: extraPath, SUPABASE_PROJECT_REF: ref },
        });
        await p.exited;
        const out = await new Response(p.stdout).text();
        const err = await new Response(p.stderr).text();

        if (p.exitCode !== 0) {
          return new Response(JSON.stringify({ error: `테이블 생성 실패: ${err.slice(0, 300)}`, sql: ddl }), { status: 500, headers });
        }
        return new Response(JSON.stringify({ success: true, message: `${SCHEMA_TABLE_COUNT}개 테이블 자동 생성 완료`, tables: SCHEMA_TABLE_COUNT }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // ─── GitHub CLI ──────────────────────────────────────────────────────────

    if (url.pathname === "/api/github-cli/status" && req.method === "GET") {
      try {
        const whichCmd = IS_WIN ? ["where", "gh"] : ["which", "gh"];
        let installed = false;
        let ghPath = "";
        try {
          const w = Bun.spawn(whichCmd, { stdout: "pipe", stderr: "pipe" });
          await w.exited;
          if (w.exitCode === 0) {
            ghPath = (await new Response(w.stdout).text()).trim().split(/\r?\n/)[0] ?? '';
            installed = true;
          }
        } catch {}
        if (!installed) return new Response(JSON.stringify({ installed: false }), { headers });

        const p = Bun.spawn([ghPath, "auth", "status"], { stdout: "pipe", stderr: "pipe" });
        await p.exited;
        const out = await new Response(p.stdout).text();
        const err = await new Response(p.stderr).text();
        const combined = out + err;
        const loggedIn = /Logged in to|✓ Logged in/.test(combined);
        const userMatch = combined.match(/account\s+(\S+)\s+\(/) ?? combined.match(/as\s+(\S+)/);
        return new Response(JSON.stringify({ installed: true, loggedIn, user: userMatch?.[1] ?? "" }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ installed: false, error: e.message }), { headers });
      }
    }

    if (url.pathname === "/api/github-cli/login" && req.method === "POST") {
      try {
        let launch: TerminalLaunchOutcome = { verified: true };
        if (IS_WIN) {
          nodeSpawnSync("powershell.exe", ["-NoExit", "-Command", "gh auth login --web"], { stdio: "inherit" });
        } else {
          const script = `tell application "Terminal"\n  activate\n  do script "gh auth login --web"\nend tell`;
          launch = await runAppleScriptChecked(script);
        }
        return new Response(JSON.stringify(launchPayload('Terminal에서 gh auth login 실행', launch)), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers });
      }
    }

    // ─── Vercel CLI status/login ─────────────────────────────────────────────

    if (url.pathname === "/api/vercel-cli/status" && req.method === "GET") {
      try {
        const cmd = IS_WIN ? ["cmd", "/c", "npx vercel whoami"] : ["/bin/bash", "-c", "npx vercel whoami"];
        const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
        await p.exited;
        const out = (await new Response(p.stdout).text()).trim();
        const err = (await new Response(p.stderr).text()).trim();
        if (p.exitCode !== 0 || /not logged in|error/i.test(err)) {
          return new Response(JSON.stringify({ installed: true, loggedIn: false }), { headers });
        }
        return new Response(JSON.stringify({ installed: true, loggedIn: true, user: out }), { headers });
      } catch {
        return new Response(JSON.stringify({ installed: false, loggedIn: false }), { headers });
      }
    }

    if (url.pathname === "/api/vercel-cli/login" && req.method === "POST") {
      try {
        let launch: TerminalLaunchOutcome = { verified: true };
        if (IS_WIN) {
          nodeSpawnSync("powershell.exe", ["-NoExit", "-Command", "npx vercel login"], { stdio: "inherit" });
        } else {
          const script = `tell application "Terminal"\n  activate\n  do script "npx vercel login"\nend tell`;
          launch = await runAppleScriptChecked(script);
        }
        return new Response(JSON.stringify(launchPayload('Terminal에서 vercel login 실행', launch)), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/setup/init-tables" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const sbUrl: string = body.supabaseUrl ?? "";
        const sbKey: string = body.supabaseAnonKey ?? "";
        const allowedEmails: unknown = body.allowedEmails;
        if (!sbUrl || !sbKey) return new Response(JSON.stringify({ error: "supabaseUrl, supabaseAnonKey 필수" }), { status: 400, headers });
        if (!Array.isArray(allowedEmails) || allowedEmails.length === 0) {
          return new Response(JSON.stringify({ error: "서버 RLS에 등록할 허용 이메일 필수" }), { status: 400, headers });
        }
        let ddl: string;
        try {
          ddl = migrationSqlForAllowedEmails(allowedEmails);
        } catch (error) {
          return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), { status: 400, headers });
        }

        const { createClient } = await import("@supabase/supabase-js");
        const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });

        // DDL을 Supabase REST /rpc 또는 직접 실행 불가 (anon key 제한)
        // 대신 각 테이블에 더미 select를 시도해서 존재 여부 확인 후 안내 반환
        const tables = [...PORTMGR_TABLES];
        const results: Record<string, boolean> = {};
        for (const t of tables) {
          const { error } = await sb.from(t).select("id").limit(1);
          results[t] = !error || !error.message.includes("does not exist");
        }
        const missing = Object.entries(results).filter(([, exists]) => !exists).map(([t]) => t);
        const existing = Object.entries(results).filter(([, exists]) => exists).map(([t]) => t);

        if (missing.length === 0) {
          return new Response(JSON.stringify({ success: true, created: 0, message: "모든 테이블이 이미 존재합니다", tables: existing }), { headers });
        }

        return new Response(JSON.stringify({
          success: false,
          needsManualDDL: true,
          missing,
          existing,
          ddl,
          message: `${missing.length}개 테이블이 없습니다. Supabase SQL 에디터에서 DDL을 실행해주세요.`,
        }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    if (url.pathname === "/api/setup/push-credentials" && req.method === "POST") {
      return new Response(JSON.stringify({
        success: false,
        code: 'CREDENTIAL_CLOUD_SYNC_DISABLED',
        error: 'CLI 토큰의 클라우드 백업은 보안상 비활성화되었습니다. GitHub, Vercel, Supabase CLI는 각 기기에서 직접 로그인하세요.',
      }), { status: 410, headers });
    }

    if (url.pathname === "/api/setup/pull-credentials" && req.method === "GET") {
      return new Response(JSON.stringify({
        success: false,
        code: 'CREDENTIAL_CLOUD_SYNC_DISABLED',
        error: 'CLI 토큰의 클라우드 복원은 보안상 비활성화되었습니다. 공개 Supabase 프로젝트 설정은 설정 화면에서 직접 입력할 수 있습니다.',
      }), { status: 410, headers });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers,
    });
  },
});

// 시작 배너는 항상 출력 (devLog 게이트 무관)
console.log(`🚀 API Server running at http://localhost:${server.port}`);

// 설치형 Tauri 앱이 시작한 사이드카는 부모 앱이 강제 종료돼도 고아 프로세스로
// 남지 않아야 한다. 일반 개발 서버에는 이 환경변수가 없으므로 영향을 주지 않는다.
const embeddedParentPid = Number(process.env.PORTMGR_PARENT_PID);
if (Number.isInteger(embeddedParentPid) && embeddedParentPid > 1) {
  setInterval(() => {
    try {
      process.kill(embeddedParentPid, 0);
    } catch {
      console.log(`[Sidecar] parent ${embeddedParentPid} exited — shutting down`);
      process.exit(0);
    }
  }, 2_000);
}

// ──────────────── RSS self-watchdog ────────────────
// 장시간 실행 중 메모리 폭주(수십 GB) 최후 방어선. supervisor가 없으므로
// 자동 종료(exit)는 하지 않는다 — 경고 + 강제 GC만 수행. 경고는 5분에 1회.
const RSS_WARN_BYTES = 1.5 * 1024 * 1024 * 1024;
const RSS_CRITICAL_BYTES = 2.5 * 1024 * 1024 * 1024;
const gb = (n: number) => (n / 1024 ** 3).toFixed(2);
let lastRssWarnAt = 0;
setInterval(() => {
  try {
    const rss = process.memoryUsage().rss;
    if (rss <= RSS_WARN_BYTES) return;
    const now = Date.now();
    if (now - lastRssWarnAt < 5 * 60 * 1000) return;
    lastRssWarnAt = now;
    console.error(`[MemWatchdog] RSS ${gb(rss)}GB > ${gb(RSS_WARN_BYTES)}GB — running Bun.gc(true)`);
    Bun.gc(true);
    const after = process.memoryUsage().rss;
    if (after > RSS_CRITICAL_BYTES) {
      console.error(`[MemWatchdog] CRITICAL: RSS still ${gb(after)}GB after GC — server is in an abnormal state. restart via 실행.command`);
    }
  } catch { /* watchdog must never crash the server */ }
}, 60_000);

// ──────────────── Hermes 명령 어댑터 자동 맞춤 ────────────────
// AgentsToZ가 깔려 있고 Hermes가 있으면 Telegram 명령이 그냥 동작해야 한다.
// 예전에는 새 명령을 추가할 때마다 사용자가 스스로 낡았음을 눈치채고 앱 패널의
// 버튼을 눌러야 했다. 화면이 없는 호스트(AWS gateway)에는 그 버튼이 아예 없어서,
// 거기서는 갱신 경로가 "사용자가 알아서 curl 을 친다" 뿐이었다.
//
// 판정은 `updateAvailable` 하나로 충분하다 — 그 값이 파일 누락·config 미등록·
// 메뉴 plugin 미설치/미활성·cap<100·버전 뒤처짐을 모두 덮는다. 그리고 그 값은
// `hermesPresent`(홈 **과** 실행 파일)를 전제하므로, Hermes가 없는 기기에서는
// 아무 일도 하지 않는다 — 여기서 `~/.hermes`를 만들면 CLI 없는 기기가 "설치됨"으로
// 잘못 판정되던 옛 버그가 되살아난다.
if (process.env.AGENTSTOZ_SKIP_HERMES_SYNC !== "1") {
  // 부팅을 막지 않는다. 이 경로는 hermes CLI를 spawn 하므로 수 초가 걸릴 수 있고,
  // 그동안 API가 응답하지 못하면 헬스체크가 먼저 깨진다.
  queueMicrotask(() => {
    try {
      const status = detectHermesProjectMemoryAdapter({ hermesCliPath: hermesCliPath() });
      if (!status.updateAvailable) return;
      const from = status.installedVersion;
      installHermesProjectMemoryAdapter({ hermesCliPath: hermesCliPath() });
      // ⚠️ "게이트웨이를 재시작하라"고 안내하지 말 것. **셸로** 그렇게 하면 Hermes가 막는다 —
      // "cannot restart or stop the gateway from inside the gateway process".
      // 그 대화를 돌리는 것이 바로 그 게이트웨이라 SIGTERM 이 명령 자신에게 전파된다.
      // 그렇게 안내하면 사용자가 SSH 로 내몰리는데, 화면 없는 호스트에서 그건 사실상 막힌 길이다.
      //
      // 무중단으로 되는 길은 `/reload_skills` 다. 게이트웨이 core 명령이고 스킬 디렉터리를
      // 인프로세스로 다시 스캔한다(`agent.skill_commands.reload_skills`). 갱신되지 않는 것은
      // Telegram BotCommand 자동완성 목록뿐인데(그 어댑터에는 `refresh_skill_group` 이 없다),
      // 그것은 표시의 문제이고 명령을 직접 입력하면 실행된다.
      console.log(`[Hermes] Telegram 명령 어댑터를 v${from} → v${status.currentVersion}로 맞췄습니다. ${HERMES_POST_INSTALL_HINT}`);
    } catch (error: any) {
      // 어댑터 맞춤 실패가 API 서버를 죽이지 않는다. 앱 패널의 설치 버튼과
      // `/api/upgrade-batch`가 그대로 남아 있으므로 수동 복구 경로가 있다.
      console.error(`[Hermes] Telegram 명령 어댑터 자동 맞춤 실패: ${error?.message ?? String(error)}`);
    }
  });
}
