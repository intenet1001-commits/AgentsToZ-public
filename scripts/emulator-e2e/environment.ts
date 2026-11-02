/**
 * 에뮬레이터 종단 시험의 허용 목록 환경(설계 §2.2).
 *
 * 자식 프로세스(shim·사이드카·LAN 호스트·Screen 픽스처·Playwright·check-ui.py)는 **빈 환경에서 출발**한다.
 * 이 에이전트의 환경에는 APP_DATA_DIR·CODEX_HOME·AGENTSTOZ_CLI_SHIM_DIR 같은 실제 값이 이미 들어 있으므로
 * 상속 환경을 걸러 쓰지 않고, 여기서 정한 키만 새로 만든다. 레인이 꼭 필요한 값(PORTMGR_* 픽스처 권한,
 * 픽스처 shim의 VITE_SUPABASE_URL 등)은 `laneOverrides`로 이름을 밝혀서만 넣고, 그 값도 검사한다.
 *
 * 오케스트레이터 자신(HOME이 실제 홈)은 호스트 코드를 import하지 않는다. 그래서 「자식 안에서 본
 * os.homedir()·resolveAppDataDir()」는 이 파일을 `--probe-identity`로 따로 띄운 자식이 출력한다.
 */
import {chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync} from 'node:fs';
import {tmpdir, userInfo} from 'node:os';
import {join, resolve} from 'node:path';

export const REPO_ROOT = resolve(import.meta.dir, '..', '..');

let cachedRealHome: string | null = null;

/**
 * 실제 홈은 HOME이 아니라 디렉터리 서비스에서 읽는다. Bun의 `os.userInfo().homedir`는 HOME을 따른다
 * (2026-11-01 이 Mac에서 HOME을 스크래치로 바꾼 자식이 스크래치를 돌려받았다) — 그 값으로는 「실제 홈 아래인가」를
 * 판정할 수 없다.
 */
export function realHome(): string {
  if (cachedRealHome) return cachedRealHome;
  if (process.platform === 'darwin') {
    const user = Bun.spawnSync(['/usr/bin/id', '-un'], {stdout: 'pipe', stderr: 'ignore', env: {PATH: '/usr/bin:/bin'}}).stdout.toString().trim();
    if (/^[A-Za-z0-9._-]+$/.test(user)) {
      const record = Bun.spawnSync(['/usr/bin/dscl', '.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], {stdout: 'pipe', stderr: 'ignore', env: {PATH: '/usr/bin:/bin'}}).stdout.toString();
      const match = /NFSHomeDirectory:\s*(\/\S.*)$/m.exec(record);
      if (match?.[1]) return (cachedRealHome = match[1].trim());
    }
    throw new Error('could not resolve the real home from directory services');
  }
  return (cachedRealHome = userInfo().homedir);
}

/** 사용자 이름(계정 정보). 환경 USER는 믿지 않는다. */
export function accountName(): string {
  if (process.platform === 'darwin') {
    const user = Bun.spawnSync(['/usr/bin/id', '-un'], {stdout: 'pipe', stderr: 'ignore', env: {PATH: '/usr/bin:/bin'}}).stdout.toString().trim();
    if (/^[A-Za-z0-9._-]+$/.test(user)) return user;
  }
  return userInfo().username;
}

/** macOS 실제 앱 데이터(설치 앱·사이드카가 쓰는 곳). 쓰지도, 샌드박스 안에서 읽지도 않는다. */
export function realAppDataDir(home: string = realHome()): string {
  return join(home, 'Library', 'Application Support', 'com.portmanager.portmanager');
}

/** 운영 Supabase 프로젝트 ref. 어떤 자식 환경·픽스처 값에도 들어가면 안 된다(설계 §1). */
export const PRODUCTION_SUPABASE_REFS = Object.freeze(['yfbivsatsorbidfutkvb']);

/** 설치 사이드카(3001)·실제 AgentsToZ Screen(52741)·Appium(4723). 연결·바인딩·API_PORT 모두 금지. */
export const RESERVED_LOOPBACK_PORTS = Object.freeze([3001, 52741, 4723] as const);

/** 상속되면 안 되는 이름. 레인이 `laneOverrides`로 밝힌 경우에만 다시 들어갈 수 있다(값 검사 포함). */
export const FORBIDDEN_ENV_KEYS = Object.freeze([
  'CODEX_HOME',
  'AGENTSTOZ_CLI_SHIM_DIR',
  'AGENTSTOZ_USE_ENDPOINT',
  'AGENTSTOZ_IOS_PORTAL_URL',
  'CLAUDECODE',
  'API_PORT',
  'SSH_AUTH_SOCK',
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'DYLD_INSERT_LIBRARIES',
]);
export const FORBIDDEN_ENV_PREFIXES = Object.freeze([
  'PORTMGR_',
  'SUPABASE_',
  'VITE_',
  'CLAUDE_CODE_',
  'ORCA_',
  'CODEX_',
  'AGENTSTOZ_USE_',
  'DYLD_',
]);

/** 기본 허용 목록. 값은 모두 실행용 스크래치이거나 비밀이 아닌 고정값이다. */
export const BASE_ALLOWED_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL',
  'APP_DATA_DIR', 'APPDATA', 'USERPROFILE', 'HERMES_HOME',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'TMUX_TMPDIR', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT',
  'NODE_ENV', 'NO_COLOR',
  'AGENTSTOZ_SKIP_HERMES_SYNC', 'AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC',
  'AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP', 'AGENTSTOZ_SKIP_MCP_CONNECTION_SYNC',
]);
/** 입력으로 명시했을 때만 들어가는 키. */
export const OPTIONAL_ALLOWED_ENV_KEYS = Object.freeze(['API_PORT', 'PORT', 'NODE_EXTRA_CA_CERTS']);

/** 레인이 이름을 밝혀 다시 넣을 수 있는 접두사(값은 validateLaneOverride가 본다). */
export const LANE_OVERRIDE_PREFIXES = Object.freeze(['PORTMGR_', 'VITE_', 'SUPABASE_', 'AGENTSTOZ_EMULATOR_']);
export const LANE_OVERRIDE_KEYS = Object.freeze(['AGENTSTOZ_USE_ENDPOINT']);

const STATIC_PATH = Object.freeze(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);

export function isForbiddenEnvKey(key: string): boolean {
  return FORBIDDEN_ENV_KEYS.includes(key) || FORBIDDEN_ENV_PREFIXES.some(prefix => key.startsWith(prefix));
}

/** `path`가 `root`와 같거나 그 아래인가(문자열 비교 — 호출 쪽에서 실제 경로로 맞춘다). */
export function isWithin(path: string, root: string): boolean {
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  return path === base || path.startsWith(`${base}/`);
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

// ───────────────────────── 스크래치 ─────────────────────────

/**
 * 한 실행의 스크래치 루트. 실제 홈 밖이어야 한다 — macOS에서 앱 데이터 경로는 홈을 따른다(src/appDataDir.ts).
 * 반환값은 실제 경로(`/var` → `/private/var`)다. 샌드박스 subpath가 실제 경로로 비교하기 때문이다.
 */
export function createRunScratch(runId: string, options: {parents?: string[]; home?: string} = {}): string {
  const home = canonical(options.home ?? realHome());
  const parents = options.parents ?? [tmpdir(), '/private/tmp'];
  for (const parent of parents) {
    let base: string;
    try { base = realpathSync(parent); } catch { continue; }
    if (isWithin(base, home)) continue;
    const root = realpathSync(mkdtempSync(join(base, `atz-emu-${runId.replace(/[^A-Za-z0-9-]/g, '')}-`)));
    chmodSync(root, 0o700);
    if (isWithin(root, home)) throw new Error(`scratch ${root} resolved under the real home`);
    return root;
  }
  throw new Error('no scratch parent outside the real home is available');
}

/** 격리 프로세스 하나의 HOME·앱 데이터·캐시 배치. 모든 경로는 `root` 아래다. */
export interface IsolatedProfile {
  label: string;
  root: string;
  home: string;
  tmp: string;
  appDataDir: string;
  appDataRoaming: string;
  xdgConfig: string;
  xdgCache: string;
  xdgData: string;
  xdgState: string;
  hermesHome: string;
  tmuxDir: string;
  /** PATH 맨 앞. `bun` 심볼릭 링크만 둔다(실제 ~/.bun/bin·platform-cli shim·pyenv를 PATH에 넣지 않는다). */
  binDir: string;
  /** 가짜 CLI 자리($HOME/.local/bin). */
  localBin: string;
}

export function createIsolatedProfile(scratchRoot: string, label: string, bunExecutable: string = process.execPath): IsolatedProfile {
  const safeLabel = label.replace(/[^A-Za-z0-9_.-]/g, '-');
  const root = realpathSync(mkdtempSync(join(scratchRoot, `${safeLabel}-`)));
  const home = join(root, 'home');
  const profile: IsolatedProfile = {
    label: safeLabel,
    root,
    home,
    tmp: join(root, 'tmp'),
    appDataDir: join(root, 'app-data'),
    appDataRoaming: join(root, 'roaming'),
    xdgConfig: join(home, '.config'),
    xdgCache: join(home, '.cache'),
    xdgData: join(home, '.local', 'share'),
    xdgState: join(home, '.local', 'state'),
    hermesHome: join(home, '.hermes'),
    tmuxDir: join(root, 'tmux'),
    binDir: join(root, 'bin'),
    localBin: join(home, '.local', 'bin'),
  };
  for (const dir of [profile.home, profile.tmp, profile.appDataDir, profile.appDataRoaming, profile.xdgConfig,
    profile.xdgCache, profile.xdgData, profile.xdgState, profile.hermesHome, profile.tmuxDir, profile.binDir, profile.localBin]) {
    mkdirSync(dir, {recursive: true, mode: 0o700});
  }
  const bunLink = join(profile.binDir, 'bun');
  if (!existsSync(bunLink)) symlinkSync(bunExecutable, bunLink);
  return profile;
}

// ───────────────────────── 허용 목록 환경 ─────────────────────────

export interface AllowlistedEnvInput {
  profile: IsolatedProfile;
  /** 사이드카의 API_PORT. 3001·52741·4723은 거절한다. */
  apiPort?: number;
  /** 사이드카의 PORT(신뢰 웹 UI origin `http://localhost:$PORT`에만 쓰인다). */
  webUiPort?: number;
  /** 실행용 CA(스크래치 안). */
  extraCaCerts?: string;
  /** 레인이 이름을 밝힌 추가 값. */
  laneOverrides?: Record<string, string>;
  /** 상속 값과 같은 덮어쓰기를 거절하기 위한 비교 대상(기본: 이 프로세스 환경). */
  inherited?: Record<string, string | undefined>;
  home?: string;
}

const PRIVATE_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackUrl(value: string): {ok: boolean; port: number | null} {
  try {
    const url = new URL(value);
    if (!PRIVATE_LOOPBACK_HOSTS.has(url.hostname)) return {ok: false, port: null};
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : null);
    return {ok: true, port};
  } catch { return {ok: false, port: null}; }
}

export function mentionsProductionSupabase(value: string): boolean {
  return PRODUCTION_SUPABASE_REFS.some(ref => value.includes(ref));
}

/** 레인 덮어쓰기 하나를 검사한다. 문제가 없으면 null, 있으면 사유. */
export function validateLaneOverride(key: string, value: string, inherited: Record<string, string | undefined> = process.env): string | null {
  const named = LANE_OVERRIDE_KEYS.includes(key) || LANE_OVERRIDE_PREFIXES.some(prefix => key.startsWith(prefix));
  if (!named) return `${key} is not a lane-overridable name`;
  if (BASE_ALLOWED_ENV_KEYS.includes(key) || OPTIONAL_ALLOWED_ENV_KEYS.includes(key)) return `${key} is managed by the allowlist builder`;
  if (mentionsProductionSupabase(value)) return `${key} mentions the production Supabase project`;
  const parent = inherited[key];
  if (parent !== undefined && parent !== '' && parent === value) return `${key} copies the inherited value`;
  if (key === 'AGENTSTOZ_USE_ENDPOINT') {
    const url = isLoopbackUrl(value);
    if (!url.ok) return `${key} must be a loopback URL`;
    if (url.port !== null && (RESERVED_LOOPBACK_PORTS as readonly number[]).includes(url.port)) return `${key} targets a reserved port ${url.port}`;
  }
  if ((key.startsWith('VITE_') || key.startsWith('SUPABASE_')) && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const url = isLoopbackUrl(value);
    if (!url.ok) return `${key} must point at a loopback fixture`;
    if (url.port !== null && (RESERVED_LOOPBACK_PORTS as readonly number[]).includes(url.port)) return `${key} targets a reserved port ${url.port}`;
  }
  return null;
}

function assertPort(name: string, port: number | undefined): void {
  if (port === undefined) return;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${name} must be a positive TCP port`);
  if ((RESERVED_LOOPBACK_PORTS as readonly number[]).includes(port)) throw new Error(`${name} ${port} is reserved (installed sidecar / real Screen / Appium)`);
}

/** 빈 환경에서 허용 목록 환경을 만든다. 상속 값은 하나도 복사하지 않는다(USER·LOGNAME은 계정 정보에서). */
export function buildAllowlistedEnv(input: AllowlistedEnvInput): Record<string, string> {
  const {profile} = input;
  assertPort('API_PORT', input.apiPort);
  assertPort('PORT', input.webUiPort);
  const username = accountName();
  const env: Record<string, string> = {
    PATH: [profile.binDir, profile.localBin, ...STATIC_PATH].join(':'),
    HOME: profile.home,
    USER: username,
    LOGNAME: username,
    TMPDIR: `${profile.tmp}/`,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    APP_DATA_DIR: profile.appDataDir,
    APPDATA: profile.appDataRoaming,
    USERPROFILE: profile.home,
    HERMES_HOME: profile.hermesHome,
    XDG_CONFIG_HOME: profile.xdgConfig,
    XDG_CACHE_HOME: profile.xdgCache,
    XDG_DATA_HOME: profile.xdgData,
    XDG_STATE_HOME: profile.xdgState,
    // tmux 소켓은 HOME이 아니라 TMUX_TMPDIR(기본 /tmp/tmux-<uid>)를 따른다 — 사람의 tmux 서버에 붙지 않게.
    TMUX_TMPDIR: profile.tmuxDir,
    // 시스템 git 설정의 osxkeychain 자격 도우미를 읽지 않는다.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    NODE_ENV: 'test',
    NO_COLOR: '1',
    // 부팅 때 사용자 설정을 맞추는 작업은 격리 HOME에서 돌 이유가 없다(scripts/perf/sidecar.ts에서 옮김).
    AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1',
    AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP: '1',
    AGENTSTOZ_SKIP_MCP_CONNECTION_SYNC: '1',
  };
  if (input.apiPort !== undefined) env.API_PORT = String(input.apiPort);
  if (input.webUiPort !== undefined) env.PORT = String(input.webUiPort);
  if (input.extraCaCerts !== undefined) {
    if (!isWithin(canonical(input.extraCaCerts), profile.root) && !isWithin(canonical(input.extraCaCerts), canonical(resolve(profile.root, '..')))) {
      throw new Error('NODE_EXTRA_CA_CERTS must live in the run scratch');
    }
    env.NODE_EXTRA_CA_CERTS = input.extraCaCerts;
  }
  const inherited = input.inherited ?? process.env;
  for (const [key, value] of Object.entries(input.laneOverrides ?? {})) {
    const problem = validateLaneOverride(key, value, inherited);
    if (problem) throw new Error(`lane override rejected: ${problem}`);
    env[key] = value;
  }
  const violations = environmentViolations(env, {
    home: input.home,
    scratchRoots: [profile.root, canonical(resolve(profile.root, '..'))],
    declaredOverrides: Object.keys(input.laneOverrides ?? {}),
    inherited,
  });
  if (violations.length) throw new Error(`allowlisted environment rejected: ${violations.join('; ')}`);
  return env;
}

const SCRATCH_VALUED_KEYS = Object.freeze([
  'HOME', 'TMPDIR', 'APP_DATA_DIR', 'APPDATA', 'USERPROFILE', 'HERMES_HOME',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMUX_TMPDIR',
]);

export interface EnvironmentCheckOptions {
  home?: string;
  /** 경로 값이 있어야 하는 스크래치 루트들. */
  scratchRoots?: string[];
  declaredOverrides?: string[];
  inherited?: Record<string, string | undefined>;
}

/** 허용 목록 위반 사유 목록(빈 배열이면 통과). 테스트와 실행 직전 단언이 같은 함수를 쓴다. */
export function environmentViolations(env: Record<string, string | undefined>, options: EnvironmentCheckOptions = {}): string[] {
  const home = canonical(options.home ?? realHome());
  const declared = new Set(options.declaredOverrides ?? []);
  const inherited = options.inherited ?? process.env;
  const allowed = new Set<string>([...BASE_ALLOWED_ENV_KEYS, ...OPTIONAL_ALLOWED_ENV_KEYS, ...declared]);
  const problems: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!allowed.has(key)) problems.push(`${key} is not on the allowlist`);
    else if (isForbiddenEnvKey(key) && !declared.has(key) && key !== 'API_PORT') problems.push(`${key} is forbidden`);
    if (mentionsProductionSupabase(value)) problems.push(`${key} mentions the production Supabase project`);
  }
  if (env.API_PORT !== undefined) {
    const port = Number(env.API_PORT);
    if (!Number.isInteger(port) || port <= 0) problems.push('API_PORT is not a concrete port');
    else if ((RESERVED_LOOPBACK_PORTS as readonly number[]).includes(port)) problems.push(`API_PORT ${port} is reserved`);
    if (inherited.API_PORT !== undefined && inherited.API_PORT === env.API_PORT) problems.push('API_PORT copies the inherited value');
  }
  const roots = (options.scratchRoots ?? []).map(canonical);
  for (const key of SCRATCH_VALUED_KEYS) {
    const value = env[key];
    if (value === undefined) continue;
    const path = canonical(value.endsWith('/') && value.length > 1 ? value.slice(0, -1) : value);
    if (isWithin(path, home)) problems.push(`${key} resolves under the real home`);
    else if (roots.length && !roots.some(root => isWithin(path, root))) problems.push(`${key} is outside the run scratch`);
  }
  for (const entry of (env.PATH ?? '').split(':').filter(Boolean)) {
    const lowered = entry.toLowerCase();
    if (lowered.includes('pyenv') || lowered.includes('platform-cli') || lowered.includes('/shims')) problems.push(`PATH contains a shim directory ${entry}`);
    else if (inherited.AGENTSTOZ_CLI_SHIM_DIR && canonical(entry) === canonical(inherited.AGENTSTOZ_CLI_SHIM_DIR)) problems.push('PATH contains AGENTSTOZ_CLI_SHIM_DIR');
    else if (isWithin(canonical(entry), home)) problems.push(`PATH entry ${entry} is under the real home`);
  }
  return problems;
}

/** 값 없이 키 이름만(증거용). */
export function environmentKeyNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter(key => env[key] !== undefined).sort();
}

// ───────────────────────── xcodebuild·simctl용 환경 ─────────────────────────

/**
 * xcodebuild·simctl은 CoreSimulator 기기 집합 때문에 실제 HOME이 필요하다(설계 §2.2).
 * 그래도 빈 환경에서 출발하고 삭제 목록은 똑같이 적용한다 — 특히 AGENTSTOZ_IOS_PORTAL_URL을 넘기지 않는다.
 * 샌드박스 밖에서 돈다(호스트가 아니다).
 */
export function buildToolchainEnv(options: {inherited?: Record<string, string | undefined>; home?: string} = {}): Record<string, string> {
  const inherited = options.inherited ?? process.env;
  const username = accountName();
  const env: Record<string, string> = {
    PATH: STATIC_PATH.join(':'),
    HOME: options.home ?? realHome(),
    USER: username,
    LOGNAME: username,
    LANG: 'en_US.UTF-8',
  };
  if (inherited.TMPDIR) env.TMPDIR = inherited.TMPDIR;
  if (inherited.DEVELOPER_DIR) env.DEVELOPER_DIR = inherited.DEVELOPER_DIR;
  for (const key of Object.keys(env)) {
    if (isForbiddenEnvKey(key)) throw new Error(`toolchain environment would carry ${key}`);
  }
  return env;
}

export const TOOLCHAIN_ENV_KEYS = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'DEVELOPER_DIR']);

// ───────────────────────── 자식 안의 신원 확인 ─────────────────────────

export interface ChildIdentityReport {
  homedir: string;
  appDataDir: string;
  appDataDirFromEnvironment: string;
  tmpdir: string;
  cwd: string;
  /** en0의 사설 IPv4(isPrivateRemoteControlIpv4로 판정) — 실행 시 탐지(설계 §2.5). */
  en0PrivateIpv4: string | null;
  privateIpv4: Array<{name: string; address: string}>;
  forbiddenKeysPresent: string[];
}

/** 자식이 본 홈·앱 데이터가 실제 홈 아래면 거부한다(설계 §2.2 마지막 항). */
export function childIdentityViolations(report: ChildIdentityReport, options: {home?: string; profile?: IsolatedProfile} = {}): string[] {
  const home = canonical(options.home ?? realHome());
  const problems: string[] = [];
  for (const key of ['homedir', 'appDataDir', 'appDataDirFromEnvironment', 'tmpdir'] as const) {
    const value = canonical(report[key]);
    if (isWithin(value, home)) problems.push(`${key} ${report[key]} is under the real home`);
    else if (options.profile && !isWithin(value, canonical(options.profile.root))) problems.push(`${key} ${report[key]} is outside the isolated profile`);
  }
  if (report.forbiddenKeysPresent.length) problems.push(`child sees forbidden keys: ${report.forbiddenKeysPresent.join(', ')}`);
  return problems;
}

async function probeIdentity(): Promise<void> {
  // 자식(샌드박스·허용 목록 환경) 안에서만 호스트 소스를 읽는다.
  const {homedir, networkInterfaces, tmpdir: childTmpdir} = await import('node:os');
  const {resolveAppDataDir, resolveAppDataDirFromEnvironment} = await import('../../src/appDataDir');
  const {isPrivateRemoteControlIpv4} = await import('../../src/remoteControlLanServer');
  const privateIpv4: Array<{name: string; address: string}> = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateRemoteControlIpv4(entry.address)) privateIpv4.push({name, address: entry.address});
    }
  }
  const report: ChildIdentityReport = {
    homedir: homedir(),
    appDataDir: resolveAppDataDir(),
    appDataDirFromEnvironment: resolveAppDataDirFromEnvironment(),
    tmpdir: childTmpdir(),
    cwd: process.cwd(),
    en0PrivateIpv4: privateIpv4.find(entry => entry.name === 'en0')?.address ?? null,
    privateIpv4,
    forbiddenKeysPresent: Object.keys(process.env).filter(key => isForbiddenEnvKey(key) && key !== 'API_PORT'),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.main && process.argv[2] === '--probe-identity') {
  await probeIdentity();
}
