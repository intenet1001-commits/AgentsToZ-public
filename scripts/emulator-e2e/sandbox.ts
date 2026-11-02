/**
 * 필수 sandbox-exec 프로필(설계 §2.3). 모든 호스트 프로세스는 이 프로필 아래서만 뜬다.
 *
 * 기반은 scripts/verify-mac-fresh-profile.py의 localhost 전용 정책이고, 여기에 실행·쓰기·읽기·신호·
 * 사용자 화면 서비스 거부를 더한다. SBPL 규칙의 우선순위는 문서화돼 있지 않다 — 이 Mac(Darwin 25.5)에서 잰
 * 결과는 이렇다(2026-11-01 측정, 아래 순서가 그 결과에 맞춘 것이다).
 *   - 필터가 있는 규칙끼리는 **나중 규칙이 이긴다**. 같은 포트의 허용 뒤 거부가 먹는다(curl·nc·Bun fetch 모두).
 *   - 그러나 필터 없는 `(deny network*)`로 시작하면 뒤의 포트 거부가 **먹지 않았다**. 그래서 네트워크는
 *     `(remote ip "*:*")`처럼 필터를 단 거부로 시작한다.
 *   - `(deny signal (target others))`는 부모에게 가는 신호를 막지 못했다. 필터 없는 `(deny signal)` 뒤에
 *     `(allow signal (target same-sandbox))`가 막았다.
 *   - 네트워크 주소의 호스트는 `*`나 `localhost`만 된다(`host must be * or localhost in network address`).
 *     그래서 「en0 주소에만 바인딩」은 SBPL로 쓸 수 없다 — LAN 호스트는 선언한 포트(보통 하나)로만 좁히고, 실제 바인딩 주소는
 *     **하네스의 LAN 바인딩 가드**(startLanBindingGuard — 선언한 포트마다 하나, 그 포트의 리스너를 lsof로 계속 보고, en0
 *     밖이면 멈추고 레인을 실패로 바꾼다)가 집행한다. 그 포트들을 여는 프로필은 포트마다 가드가 있을 때만 띄울 수 있다
 *     (sandboxedArgv). 가드는 선언한 포트만 본다 — 선언하지 않은 en0 포트의 리스너는 레인이 자기 프로세스 트리를
 *     lanListenerViolations로 따로 단언한다(j1-pty의 watchListeners).
 *   - **특정 포트의 outbound 허용 뒤에 다른 network-outbound 규칙이 오면 일부 포트 번호의 허용이 사라진다.**
 *     `(allow … "localhost:53243")` 뒤에 `(deny … "localhost:3001")`이나 unix 소켓 거부 한 줄만 와도 53243으로
 *     연결이 안 됐고(curl·Bun 모두, 매번 같은 포트), 53244는 됐다. 무작위 포트 300개 허용 중 16개(약 5%)가 그랬다.
 *     허용 목록을 마지막 network-outbound 규칙으로 두면 같은 측정에서 0개였다(누출도 0). 그래서 허용 목록이 맨 끝이다
 *     — 거부 포트는 애초에 허용 목록에 들어갈 수 없으므로(생성 시 거절) 순서를 바꿔도 거부가 풀리지 않는다.
 * **loopback outbound는 허용 목록이다.** `localhost:*`를 열고 3001·52741·4723만 막으면 설치 앱의 다른 리스너
 * (내장 Chromium의 원격 디버깅 포트 등)·Orca·adb에 닿는다. 그래서 이 실행이 소유한 포트만 연다
 * (`allowedLoopbackPorts` — 사이드카는 띄울 때 자기 포트를 더한다).
 * 프로필 파일은 어떤 쓰기 허용 루트에도 두지 않고, 띄우기 직전에 해시를 다시 잰다(sandboxedArgv) — 호스트가
 * 다음 호스트의 프로필을 고쳐 쓸 수 없다.
 * 판정은 정적 검사가 아니라 **카나리**로 한다(runSandboxCanaries). 카나리가 하나라도 통과하지 못하면
 * 그 실행의 호스트 레인은 모두 막힌다.
 *
 * 이 파일을 `--canary-probe`로 띄우면 샌드박스 안에서 카나리를 실행하는 자식이 된다.
 */
import {createHash} from 'node:crypto';
import {appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {RESERVED_LOOPBACK_PORTS, isWithin, realAppDataDir, realHome} from './environment';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** 샌드박스 안에서 실행할 수 없는 프로그램(설계 §2.3 + 화면·클립보드). */
export const DENIED_EXECUTABLES = Object.freeze([
  '/usr/bin/open',
  '/usr/bin/osascript',
  '/usr/bin/security',
  '/usr/bin/tccutil', // emulator-guard:forbidden-tool-declaration
  '/bin/launchctl',
  '/usr/bin/defaults',
  '/usr/sbin/screencapture',
  '/usr/bin/pbcopy',
  '/usr/bin/pbpaste',
  '/usr/bin/shortcuts',
]);

/**
 * 사람의 화면·권한·키체인으로 이어지는 시스템 서비스. 조회부터 막아 둔다(심층 방어 — 카나리로 재지는 않는다).
 * WindowServer를 막으면 CGEventPost 같은 입력 주입이, tccd를 막으면 권한 알림이 생길 길이 없다.
 */
export const DENIED_MACH_SERVICES = Object.freeze([
  'com.apple.windowserver.active',
  'com.apple.tccd',
  'com.apple.tccd.system',
  'com.apple.pasteboard.1',
  'com.apple.coreservices.launchservicesd',
  'com.apple.coreservices.appleevents',
  'com.apple.SecurityServer',
  'com.apple.securityd.xpc',
]);
export const DENIED_IOKIT_CLASSES = Object.freeze(['IOHIDParamUserClient', 'IOHIDLibUserClient']);

/** 실제 홈 아래에서 읽으면 안 되는 위치(설계 §2.3 읽기 금지 + 자격 증명 파일). */
export function sensitiveReadPaths(home: string = realHome()): {subpaths: string[]; literals: string[]} {
  return {
    subpaths: [
      realAppDataDir(home),
      join(home, 'Library', 'Application Support', 'AgentsToZ Screen'),
      join(home, '.claude'),
      join(home, '.codex'),
      join(home, '.hermes'),
      join(home, '.gemini'),
      join(home, 'Library', 'Keychains'),
      join(home, 'Library', 'CloudStorage'),
      join(home, '.ssh'),
      join(home, '.aws'),
      join(home, '.supabase'),
      join(home, '.config', 'gh'),
      join(home, '.config', 'git'),
    ],
    literals: [
      join(home, '.gitconfig'),
      join(home, '.git-credentials'),
      join(home, '.netrc'),
      join(home, '.npmrc'),
      join(home, '.zshrc'),
      join(home, '.zshenv'),
      join(home, '.zprofile'),
      join(home, '.zlogin'),
      join(home, '.bashrc'),
      join(home, '.bash_profile'),
      join(home, '.profile'),
    ],
  };
}

export interface SandboxProfileInput {
  /** 쓰기를 허용할 곳(스크래치·증거). 실제 경로여야 한다. */
  writableRoots: string[];
  home?: string;
  /**
   * 이 호스트가 연결해도 되는 loopback 포트(이 실행이 소유한 리스너: shim·다른 격리 호스트·자기 자신).
   * 이 목록 밖의 loopback 리스너(설치 앱·Screen·Orca·adb …)로는 연결할 수 없다. 거부 포트는 넣을 수 없다.
   */
  allowedLoopbackPorts?: number[];
  /** 3001·52741·4723 외에 더 막을 loopback 포트(카나리가 같은 생성기로 쓴다). */
  extraDeniedPorts?: number[];
  /**
   * LAN 레인 호스트만: 이 포트 하나의 inbound를 모든 인터페이스에서 연다. SBPL은 주소를 `*`/`localhost`로만 받으므로
   * en0 주소로 좁힐 수 없다 — 하네스의 LAN 바인딩 가드(포트마다 하나)가 실제 바인딩 주소를 집행한다(가드 없이는 띄울 수
   * 없다). outbound는 그대로 loopback 허용 목록뿐이다.
   * `extraPorts`: 같은 en0 주소에 다른 origin이 더 필요한 레인만(j1-pty의 「남의 origin」·리다이렉트 픽스처). 포트마다 한 줄씩
   * 열고, 각 포트는 같은 검사(유효·거부 포트 아님·중복 없음)를 받는다. 하네스는 이 포트마다 가드를 켠다.
   */
  lanInbound?: LanInbound;
}

export interface LanInbound {port: number; extraPorts?: number[]}

export interface SandboxProfile {
  text: string;
  sha256: string;
  deniedPorts: number[];
  allowedLoopbackPorts: number[];
  writableRoots: string[];
  lanInbound: LanInbound | null;
}

/** LAN inbound가 여는 포트 전부(주 포트 먼저). */
export function lanInboundPorts(lan: LanInbound): number[] {
  return [lan.port, ...(lan.extraPorts ?? [])];
}

/** SBPL 문자열 리터럴. 경로에 따옴표·역슬래시가 있으면 이스케이프한다. */
function q(value: string): string {
  if (value.includes('\0') || value.includes('\n')) throw new Error('sandbox path contains a control character');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function assertAbsoluteReal(path: string): string {
  if (!path.startsWith('/')) throw new Error(`sandbox root must be absolute: ${path}`);
  let real: string;
  try { real = realpathSync(path); } catch { throw new Error(`sandbox root must exist: ${path}`); }
  if (real === '/') throw new Error('sandbox root must not be /');
  return real;
}

export function buildSandboxProfile(input: SandboxProfileInput): SandboxProfile {
  const home = input.home ?? realHome();
  const writableRoots = [...new Set(input.writableRoots.map(assertAbsoluteReal))];
  if (!writableRoots.length) throw new Error('sandbox needs at least one writable root');
  for (const root of writableRoots) {
    if (root === home || isWithin(home, root)) throw new Error(`writable root ${root} would cover the real home`);
  }
  const validPort = (kind: string) => (port: number) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`invalid ${kind} port ${port}`);
    return port;
  };
  const extra = (input.extraDeniedPorts ?? []).map(validPort('denied'));
  const deniedPorts = [...new Set<number>([...RESERVED_LOOPBACK_PORTS, ...extra])];
  const allowedLoopbackPorts = [...new Set((input.allowedLoopbackPorts ?? []).map(validPort('allowed loopback')))].sort((a, b) => a - b);
  for (const port of allowedLoopbackPorts) {
    if (deniedPorts.includes(port)) throw new Error(`loopback port ${port} is denied and cannot be allowed`);
  }
  let lanInbound: LanInbound | null = null;
  if (input.lanInbound !== undefined) {
    const port = validPort('LAN inbound')(input.lanInbound.port);
    const given = input.lanInbound.extraPorts;
    if (given !== undefined && !Array.isArray(given)) throw new Error('invalid LAN inbound extraPorts');
    const extraPorts = (given ?? []).map(validPort('LAN inbound'));
    lanInbound = extraPorts.length ? {port, extraPorts} : {port};
    const ports = lanInboundPorts(lanInbound);
    for (const lanPort of ports) if (deniedPorts.includes(lanPort)) throw new Error(`LAN inbound port ${lanPort} is denied`);
    if (new Set(ports).size !== ports.length) throw new Error(`LAN inbound ports repeat: ${ports.join(', ')}`);
  }
  const read = sensitiveReadPaths(home);
  const lines: string[] = [
    '(version 1)',
    ';; AgentsToZ emulator e2e host sandbox — generated per run (scripts/emulator-e2e/sandbox.ts)',
    '(allow default)',
    '',
    ';; 실행 금지',
    `(deny process-exec ${DENIED_EXECUTABLES.map(path => `(literal ${q(path)})`).join(' ')})`,
    '',
    ';; 사람의 화면·권한·키체인 서비스, Apple Events, HID',
    `(deny mach-lookup ${DENIED_MACH_SERVICES.map(name => `(global-name ${q(name)})`).join(' ')})`,
    '(deny appleevent-send)',
    `(deny iokit-open ${DENIED_IOKIT_CLASSES.map(name => `(iokit-user-client-class ${q(name)})`).join(' ')})`,
    '',
    ';; 신호는 같은 샌드박스 안에서만(설치 앱·Screen·이 오케스트레이터에 신호를 보낼 수 없다)',
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    '',
    ';; 쓰기: 스크래치와 증거 폴더(+ /dev) 밖은 금지',
    '(deny file-write* (subpath "/"))',
    `(allow file-write* ${writableRoots.map(root => `(subpath ${q(root)})`).join(' ')} (subpath "/dev"))`,
    '',
    ';; 읽기 금지: 실제 앱 데이터·에이전트 설정·키체인·자격 증명·셸 rc·클라우드 저장소',
    `(deny file-read* ${read.subpaths.map(path => `(subpath ${q(path)})`).join(' ')} ${read.literals.map(path => `(literal ${q(path)})`).join(' ')})`,
    '',
    ';; 네트워크: localhost만. 필터 없는 (deny network*)는 쓰지 않는다(위 주석).',
    '(deny network-outbound (remote ip "*:*"))',
    '(deny network-bind (local ip "*:*"))',
    '(deny network-inbound (local ip "*:*"))',
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    ...(lanInbound ? [
      ';; LAN 레인 호스트만: 선언한 포트의 inbound만(SBPL은 en0 주소를 쓸 수 없다 — 바인딩 주소는 하네스의 LAN 바인딩 가드가 lsof로 집행)',
      ...lanInboundPorts(lanInbound).flatMap(port => [
        `(allow network-bind (local ip ${q(`*:${port}`)}))`,
        `(allow network-inbound (local ip ${q(`*:${port}`)}))`,
      ]),
    ] : []),
    ';; 거부 포트(설치 사이드카·실제 Screen·Appium) — bind·inbound 허용(localhost:*·LAN 포트)보다 뒤에 둔다',
    ...deniedPorts.map(port => `(deny network-outbound (remote ip ${q(`localhost:${port}`)}))`),
    ...deniedPorts.map(port => `(deny network-bind (local ip ${q(`*:${port}`)}))`),
    ...deniedPorts.map(port => `(deny network-inbound (local ip ${q(`*:${port}`)}))`),
    '',
    ';; unix 소켓: 스크래치 안의 것만(사람의 tmux·ssh-agent·docker 소켓에 붙지 않는다)',
    '(deny network-outbound (remote unix-socket (path-regex #"^/")))',
    `(allow network-outbound (remote unix-socket ${writableRoots.map(root => `(subpath ${q(root)})`).join(' ')}))`,
    '',
    ';; loopback outbound 허용 목록: 이 실행이 소유한 포트만. **반드시 마지막 network-outbound 규칙이다** — 특정 포트 허용 뒤에',
    ';; 다른 network-outbound 규칙(다른 포트의 거부, unix 소켓 거부)이 오면 일부 포트 번호의 허용이 사라진다(위 측정).',
    ...allowedLoopbackPorts.map(port => `(allow network-outbound (remote ip ${q(`localhost:${port}`)}))`),
    '',
  ];
  const text = lines.join('\n');
  return {text, sha256: sha256(text), deniedPorts, allowedLoopbackPorts, writableRoots, lanInbound};
}

export function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 그 포트가 막혀 있는가(정적 검사):
 *   - outbound: 거부 행이 있고, outbound가 허용 목록이며(profileOutboundIsAllowlist), 그 포트를 여는 허용 행이 없다.
 *     허용 목록은 마지막 규칙이지만 그 포트를 담지 않으므로 맨 앞의 `*:*` 거부와 이 거부가 그대로 먹는다.
 *   - bind·inbound: 거부 행이 와일드카드 허용(`localhost:*`)과 LAN 포트 허용보다 **뒤**에 있다 — 나중 규칙이 이긴다.
 * 실제 차단은 카나리가 판정한다.
 */
export function profileDeniesLoopbackPort(text: string, port: number): boolean {
  const lines = text.split('\n');
  const allowBind = lines.indexOf('(allow network-bind (local ip "localhost:*"))');
  const denyOutbound = lines.indexOf(`(deny network-outbound (remote ip "localhost:${port}"))`);
  const denyBind = lines.indexOf(`(deny network-bind (local ip "*:${port}"))`);
  const denyInbound = lines.indexOf(`(deny network-inbound (local ip "*:${port}"))`);
  const ipAllow = (line: string) => line.startsWith('(allow network-') && line.includes(' ip "');
  const localAllow = (line: string) => ipAllow(line) && (line.startsWith('(allow network-bind') || line.startsWith('(allow network-inbound'));
  const lastLocalAllow = lines.reduce((last, line, index) => localAllow(line) ? index : last, -1);
  const allowsPort = lines.some(line => ipAllow(line) && (line.includes(`"localhost:${port}"`) || line.includes(`"*:${port}"`)));
  return allowBind >= 0 && denyOutbound >= 0 && denyBind > lastLocalAllow && denyInbound > lastLocalAllow && !allowsPort
    && profileOutboundIsAllowlist(text)
    && !lines.some(line => line.trim() === '(deny network*)');
}

/**
 * loopback outbound가 허용 목록인가(정적 검사): `*:*` outbound 거부로 시작하고, 와일드카드 포트 outbound 허용이 없고,
 * 모든 outbound 허용이 `localhost:<포트>` 하나씩이며, 그 허용들이 **마지막 network-outbound 규칙**이다.
 * `localhost:*`를 열면 설치 앱의 다른 리스너에 닿고(검토 #2), 허용 뒤에 다른 outbound 규칙이 오면 일부 포트의
 * 허용이 사라진다(위 측정).
 */
export function profileOutboundIsAllowlist(text: string): boolean {
  const lines = text.split('\n');
  const outbound = lines.map((line, index) => ({line, index})).filter(entry => entry.line.startsWith('(allow network-outbound') || entry.line.startsWith('(deny network-outbound'));
  const ipAllows = outbound.filter(entry => entry.line.startsWith('(allow network-outbound') && !entry.line.includes('unix-socket'));
  if (outbound[0]?.line !== '(deny network-outbound (remote ip "*:*"))') return false;
  if (!ipAllows.every(entry => /^\(allow network-outbound \(remote ip "localhost:\d+"\)\)$/.test(entry.line))) return false;
  const firstAllow = ipAllows[0]?.index ?? Infinity;
  return outbound.every(entry => entry.index < firstAllow || ipAllows.includes(entry));
}

export interface WrittenSandboxProfile extends SandboxProfile {
  path: string;
  /** 프로필을 쓴 폴더(쓰기 허용 루트 밖). 런처가 같은 곳에 변형 프로필을 쓴다. */
  dir: string;
  /** 같은 생성기로 변형(예: 사이드카 자기 포트 추가)을 만들 때 쓰는 입력. */
  input: SandboxProfileInput;
}

/**
 * 프로필을 쓴다. 폴더가 그 프로필의 쓰기 허용 루트 안이면 거절한다 — 샌드박스 안의 호스트가 다음 호스트의 프로필을
 * 고쳐 쓸 수 있기 때문이다(검토 #4).
 */
export function writeSandboxProfile(dir: string, name: string, input: SandboxProfileInput): WrittenSandboxProfile {
  const profile = buildSandboxProfile(input);
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const realDir = realpathSync(dir);
  for (const root of profile.writableRoots) {
    if (isWithin(realDir, root)) throw new Error(`sandbox profile folder ${realDir} is inside the writable root ${root} — a host could rewrite it`);
  }
  const path = join(realDir, `${name.replace(/[^A-Za-z0-9_.-]/g, '-')}.sb`);
  writeFileSync(path, profile.text, {mode: 0o600});
  return {...profile, path, dir: realDir, input: {...input}};
}

/**
 * `sandbox-exec -f <profile> <argv…>` — sandbox-exec는 exec하므로 pid가 그대로다.
 * 띄우기 직전에 프로필 파일을 다시 해시한다. 기록한 sha256과 다르면(누가 고쳐 썼으면) 띄우지 않는다.
 * 비-loopback inbound를 여는 프로필(LAN 호스트)은 **그 포트를 지켜보는 LAN 바인딩 가드가 있을 때만** 띄운다(검토 #9) —
 * SBPL은 주소를 en0로 좁히지 못하므로 en0 밖 바인딩을 잡아 멈추는 것은 하네스의 가드다. 가드 없이 띄울 길을 두지 않는다.
 */
export function sandboxedArgv(profile: {path: string; sha256: string}, argv: readonly string[]): string[] {
  if (!argv.length) throw new Error('sandboxed command is empty');
  let bytes: Buffer;
  try { bytes = readFileSync(profile.path); } catch (error) { throw new Error(`sandbox profile ${profile.path} is unreadable: ${(error as Error).message}`); }
  const actual = sha256(bytes);
  if (actual !== profile.sha256) throw new Error(`sandbox profile ${profile.path} changed after it was written (sha256 ${actual} ≠ ${profile.sha256}) — refusing to start`);
  for (const port of profileLanInboundPorts(bytes.toString('utf8'))) {
    if (port === '*') throw new Error(`sandbox profile ${profile.path} opens inbound on every port of every interface — refusing to start`);
    if (!activeLanBindingGuard(port)) {
      throw new Error(`sandbox profile ${profile.path} opens LAN inbound port ${port} but no LAN binding guard watches it — start LAN hosts through the harness (ctx.sandboxProfile / ctx.startSidecar)`);
    }
  }
  return [SANDBOX_EXEC, '-f', profile.path, ...argv];
}

/** 프로필이 loopback 밖에서 bind·inbound를 여는 포트(`*`는 모든 포트). 생성기는 lanInboundPorts(주 포트 + extraPorts)만 쓴다. */
export function profileLanInboundPorts(text: string): Array<number | '*'> {
  const ports = new Set<number | '*'>();
  for (const line of text.split('\n')) {
    const match = /^\(allow network-(?:bind|inbound) \(local ip "(.+):([^":]+)"\)\)$/.exec(line.trim());
    if (!match || match[1] === 'localhost') continue;
    ports.add(match[2] === '*' ? '*' : Number(match[2]));
  }
  return [...ports];
}

// ───────────────────────── LAN 바인딩 관측·가드 ─────────────────────────

export interface ListenSocket {address: string; port: number; pid?: number}

/** `lsof … -iTCP -sTCP:LISTEN -Fpn` 출력의 리스너. pid는 바로 앞 `p` 행에서 온다(없으면 비운다). */
export function parseLsofListeners(text: string): ListenSocket[] {
  const out: ListenSocket[] = [];
  let pid: number | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('p')) {
      const value = Number(line.slice(1));
      pid = Number.isInteger(value) && value > 0 ? value : undefined;
      continue;
    }
    if (!line.startsWith('n')) continue;
    const match = /^n(.*):(\d+)$/.exec(line);
    if (match) out.push({address: match[1]!.replace(/^\[|\]$/g, ''), port: Number(match[2]), ...(pid ? {pid} : {})});
  }
  return out;
}

/** `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN -Fn` 출력의 이름 행(`n<주소>:<포트>`). */
export function parseLsofListenNames(text: string): Array<{address: string; port: number}> {
  return parseLsofListeners(text).map(({address, port}) => ({address, port}));
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackListenAddress(address: string): boolean {
  return LOOPBACK_ADDRESSES.has(address);
}

/**
 * LAN 호스트의 비-loopback 리스너가 `<en0 주소>:<포트>` 하나뿐인가(관측). SBPL이 en0 주소로 좁히지 못하므로
 * `*`(모든 인터페이스)·utun·브리지 주소에 바인딩했으면 위반이다(검토 #9). 빈 배열이면 통과.
 * `extraPorts`를 주면(프로필의 lanInbound와 같은 모양) 그 포트들도 같은 en0 주소에서만, 빠짐없이 들어야 한다.
 * `requireListening: false`는 「아직 안 떴다」를 위반으로 보지 않는다(가드의 감시가 쓴다 — 리스너는 레인이 켤 때 뜬다).
 */
export function lanListenerViolations(
  listeners: ReadonlyArray<{address: string; port: number}>,
  expected: {address: string} & LanInbound,
  options: {requireListening?: boolean} = {},
): string[] {
  const problems: string[] = [];
  const ports = lanInboundPorts(expected);
  const allowed = ports.map(port => `${expected.address}:${port}`).join(', ');
  const external = listeners.filter(entry => !isLoopbackListenAddress(entry.address));
  for (const entry of external) {
    if (entry.address !== expected.address || !ports.includes(entry.port)) problems.push(`listens on ${entry.address}:${entry.port} (only ${allowed} ${ports.length === 1 ? 'is' : 'are'} allowed)`);
  }
  if (options.requireListening ?? true) {
    for (const port of ports) {
      if (!external.some(entry => entry.address === expected.address && entry.port === port)) problems.push(`does not listen on ${expected.address}:${port}`);
    }
  }
  return problems;
}

/** 그 pid(들)의 TCP LISTEN 소켓(lsof 관측). 호스트가 자식에서 리스너를 열면 그 자식 pid도 넘긴다. */
export function listeningSockets(pid: number | readonly number[]): Array<{address: string; port: number}> {
  const pids = (typeof pid === 'number' ? [pid] : [...pid]).filter(value => Number.isInteger(value) && value > 0);
  if (!pids.length) return [];
  const out = Bun.spawnSync(['/usr/sbin/lsof', '-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fn'], {stdout: 'pipe', stderr: 'ignore', env: {PATH: '/usr/bin:/bin:/usr/sbin'}});
  return parseLsofListenNames(out.stdout.toString());
}

/**
 * 그 포트의 TCP LISTEN 소켓 전부 — 이 Mac 전체, 어느 프로세스든(샌드박스 안의 자손·부모를 잃은 고아까지).
 * lsof는 맞는 소켓이 없으면 1로 끝난다. 그 밖의 종료 코드, 또는 출력 없이 오류만 남긴 1은 관측 실패로 던진다.
 */
export async function listenersOnPort(port: number): Promise<ListenSocket[]> {
  const child = Bun.spawn(['/usr/sbin/lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], {stdout: 'pipe', stderr: 'pipe', env: {PATH: '/usr/bin:/bin:/usr/sbin'}});
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0 && code !== 1) throw new Error(`lsof exited ${code}: ${stderr.trim().slice(-200)}`);
  if (code === 1 && !stdout.trim() && stderr.trim()) throw new Error(`lsof failed: ${stderr.trim().slice(-200)}`);
  return parseLsofListeners(stdout).filter(entry => entry.port === port);
}

/** pid가 이 프로세스(하네스)의 자손인가(ps 관측). 자손이 아니면 신호를 보내지 않는다 — 사람의 다른 프로세스일 수 있다. */
export function isDescendantOfThisProcess(pid: number, root: number = process.pid): boolean {
  if (pid === root) return false;
  const out = Bun.spawnSync(['/bin/ps', '-axo', 'pid=,ppid='], {stdout: 'pipe', stderr: 'ignore', env: {PATH: '/usr/bin:/bin'}});
  const parentOf = new Map<number, number>();
  for (const line of out.stdout.toString().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) parentOf.set(Number(match[1]), Number(match[2]));
  }
  const seen = new Set<number>();
  for (let cursor = parentOf.get(pid); cursor !== undefined && cursor > 0 && !seen.has(cursor); cursor = parentOf.get(cursor)) {
    if (cursor === root) return true;
    seen.add(cursor);
  }
  return false;
}

export const LAN_GUARD_INTERVAL_MS = 500;

export interface LanBindingGuardOptions {
  /** 지켜볼 LAN inbound 포트(프로필의 lanInbound). */
  port: number;
  /** 허용하는 유일한 비-loopback 주소 — preflight가 샌드박스 자식 안에서 잰 en0 사설 IPv4. */
  expectedAddress: string;
  intervalMs?: number;
  /** 관측(기본: listenersOnPort — 그 포트의 이 Mac 전체 리스너). 테스트가 바꾼다. */
  observe?: (port: number) => Promise<ListenSocket[]>;
  /** 위반한 리스너의 pid를 멈추고 한 줄로 알린다(기본: 하네스의 자손이면 SIGKILL, 아니면 건드리지 않는다). */
  terminate?: (pid: number) => string;
  /** 위반을 볼 때마다(하네스가 그 포트의 사이드카를 멈춘다). */
  onViolation?: (lines: string[]) => void;
}

export interface LanBindingGuard {
  readonly port: number;
  readonly expectedAddress: string;
  /** 지금까지 본 위반(중복 없이 쌓인다). 하나라도 있으면 그 레인은 실패다. */
  readonly violations: readonly string[];
  /** 감시 중인가(멈춘 뒤에는 그 포트를 여는 프로필로 띄울 수 없다). */
  readonly active: boolean;
  /** 지금 한 번 본다. 이번 관측의 위반을 돌려준다(기록·멈춤은 감시와 같다). 던지지 않는다. */
  check(): Promise<string[]>;
  /** `<en0 주소>:<포트>`에 실제로 떠 있는가 — 레인의 기능 확인용(안전 판정은 violations가 한다). */
  listening(): Promise<boolean>;
  /** 감시를 멈추고 등록을 푼다. */
  stop(): Promise<void>;
}

const lanBindingGuards = new Map<number, LanBindingGuard>();

/** 그 포트를 지켜보는 가드(없으면 null). sandboxedArgv가 LAN 프로필을 띄우기 전에 묻는다. */
export function activeLanBindingGuard(port: number): LanBindingGuard | null {
  return lanBindingGuards.get(port) ?? null;
}

function defaultTerminate(pid: number): string {
  if (!isDescendantOfThisProcess(pid)) return `pid ${pid} is not a descendant of the harness — not signalled`;
  try { process.kill(pid, 'SIGKILL'); return `pid ${pid} stopped (SIGKILL)`; }
  catch (error) { return `pid ${pid} could not be stopped: ${(error as Error)?.message ?? error}`; }
}

/**
 * LAN 바인딩 가드(검토 #9). 그 포트의 TCP 리스너를 이 Mac 전체에서 주기적으로 본다. loopback과 `<en0 주소>:<포트>`가
 * 아닌 리스너(`*`·utun·브리지·다른 사설 주소)를 보면 위반으로 기록하고, 그 리스너 pid가 하네스의 자손이면 SIGKILL로
 * 멈춘다. 관측이 실패해도 위반이다(fail-closed). SBPL이 이 포트를 모든 인터페이스에 열어 두므로 이 가드가 en0 제한의
 * 실제 집행이다 — 감시 간격(기본 500ms — lsof 한 번이 CPU 약 40ms라 레인 내내 돌 때 한 코어의 10% 아래로 둔다) 동안의 노출은 남는다.
 */
export function startLanBindingGuard(options: LanBindingGuardOptions): LanBindingGuard {
  const port = options.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`invalid LAN guard port ${port}`);
  const expectedAddress = options.expectedAddress;
  if (typeof expectedAddress !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(expectedAddress) || expectedAddress.startsWith('127.') || expectedAddress === '0.0.0.0') {
    throw new Error(`a LAN binding guard needs the en0 IPv4 address (got ${String(expectedAddress)})`);
  }
  if (lanBindingGuards.has(port)) throw new Error(`a LAN binding guard already watches port ${port}`);
  const observe = options.observe ?? listenersOnPort;
  const terminate = options.terminate ?? defaultTerminate;
  const intervalMs = Math.max(20, options.intervalMs ?? LAN_GUARD_INTERVAL_MS);
  const violations: string[] = [];
  const report = (lines: string[]) => {
    for (const line of lines) if (!violations.includes(line)) violations.push(line);
    try { options.onViolation?.(lines); } catch { /* 기록은 이미 남았다 */ }
  };
  const observeOnce = async (): Promise<string[]> => {
    let listeners: ListenSocket[];
    try { listeners = await observe(port); }
    catch (error) {
      const lines = [`could not observe the listeners on port ${port} (${String((error as Error)?.message ?? error).slice(0, 200)}) — treated as a violation`];
      report(lines);
      return lines;
    }
    const problems = lanListenerViolations(listeners, {address: expectedAddress, port}, {requireListening: false});
    if (!problems.length) return [];
    const offenders = [...new Set(listeners
      .filter(entry => !isLoopbackListenAddress(entry.address) && (entry.address !== expectedAddress || entry.port !== port) && entry.pid)
      .map(entry => entry.pid!))];
    const actions = offenders.map(pid => {
      try { return terminate(pid); } catch (error) { return `pid ${pid} could not be stopped: ${(error as Error)?.message ?? error}`; }
    });
    const lines = [...problems, ...actions];
    report(lines);
    return lines;
  };
  let queue: Promise<unknown> = Promise.resolve();
  const check = (): Promise<string[]> => {
    const next = queue.then(observeOnce, observeOnce);
    queue = next.catch(() => undefined);
    return next;
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  const pause = () => new Promise<void>(resolve => {
    wake = resolve;
    timer = setTimeout(resolve, intervalMs);
    // 가드만으로 프로세스를 붙잡지 않는다(멈출 때 깨운다).
    (timer as {unref?: () => void}).unref?.();
  });
  let loop: Promise<void> = Promise.resolve();
  const guard: LanBindingGuard = {
    port,
    expectedAddress,
    get violations() { return [...violations]; },
    get active() { return !stopped; },
    check,
    listening: async () => (await observe(port)).some(entry => entry.address === expectedAddress && entry.port === port),
    stop: async () => {
      if (!stopped) {
        stopped = true;
        if (lanBindingGuards.get(port) === guard) lanBindingGuards.delete(port);
        if (timer) clearTimeout(timer);
        wake?.();
      }
      await loop;
    },
  };
  lanBindingGuards.set(port, guard);
  loop = (async () => {
    while (!stopped) {
      await check();
      if (stopped) break;
      await pause();
    }
  })();
  return guard;
}

// ───────────────────────── 카나리 ─────────────────────────

export type CanaryVerdict = 'blocked' | 'allowed' | 'inconclusive';

export const CANARY_IDS = Object.freeze([
  'exec-open', 'denied-port', 'foreign-listener', 'worktree-write', 'profile-write', 'real-app-data-read', 'signal-orchestrator',
] as const);
export type CanaryId = typeof CANARY_IDS[number];

export interface CanaryResult {
  id: CanaryId;
  description: string;
  expected: 'blocked';
  verdict: CanaryVerdict;
  /** 같은 자식에서 같은 종류의 허용 동작이 됐는가(막힌 게 샌드박스 때문인지 판정하려고). */
  controlPassed: boolean;
  detail: string;
  passed: boolean;
}

export interface CanaryReport {
  profileSha256: string;
  canaryProfileSha256: string;
  sandboxStarted: boolean;
  results: CanaryResult[];
  staticChecks: Array<{id: string; passed: boolean; detail: string}>;
  passed: boolean;
  error?: string;
}

interface ProbeArgs {
  deniedPort: number;
  foreignPort: number;
  controlPort: number;
  worktreeWritePath: string;
  scratchWritePath: string;
  profilePath: string;
  appDataDir: string;
  orchestratorPid: number;
}

type ProbeOutcome = {ok: boolean; code: string; detail: string};

function errorCode(error: unknown): string {
  const value = error as {code?: unknown; message?: unknown};
  if (typeof value?.code === 'string') return value.code;
  const message = String(value?.message ?? error);
  if (/EPERM|operation not permitted/i.test(message)) return 'EPERM';
  if (/EACCES/i.test(message)) return 'EACCES';
  return 'ERROR';
}

async function canaryProbe(args: ProbeArgs): Promise<void> {
  const out: Record<string, ProbeOutcome> = {};
  const attempt = async (name: string, fn: () => unknown | Promise<unknown>) => {
    try { const detail = await fn(); out[name] = {ok: true, code: 'OK', detail: String(detail ?? '')}; }
    catch (error) { out[name] = {ok: false, code: errorCode(error), detail: String((error as Error)?.message ?? error).slice(0, 200)}; }
  };
  // 1) `open -h`: 막히지 않아도 도움말만 출력한다.
  await attempt('execOpen', () => {
    const result = Bun.spawnSync(['/usr/bin/open', '-h'], {stdout: 'ignore', stderr: 'ignore'});
    return `exit=${result.exitCode}`;
  });
  await attempt('execControl', () => {
    const result = Bun.spawnSync(['/bin/echo', 'canary'], {stdout: 'pipe'});
    if (result.exitCode !== 0) throw new Error(`echo exit ${result.exitCode}`);
    return 'ok';
  });
  // 2) 같은 규칙 생성기로 막은 포트, 프로필이 언급하지 않는 「남의」 리스너 vs 허용 목록의 포트.
  const get = async (port: number) => {
    const response = await fetch(`http://127.0.0.1:${port}/canary`, {signal: AbortSignal.timeout(4_000)});
    return `status=${response.status}`;
  };
  await attempt('deniedPort', () => get(args.deniedPort));
  await attempt('foreignPort', () => get(args.foreignPort));
  await attempt('controlPort', () => get(args.controlPort));
  // 3) 워크트리의 비증거 경로 쓰기, 자기 프로필 고쳐 쓰기 vs 스크래치 쓰기.
  await attempt('worktreeWrite', () => { writeFileSync(args.worktreeWritePath, 'canary\n', {flag: 'wx'}); return 'wrote'; });
  await attempt('profileWrite', () => { appendFileSync(args.profilePath, '\n;; tampered by canary\n(allow network-outbound (remote ip "localhost:*"))\n'); return 'wrote'; });
  await attempt('scratchWrite', () => { writeFileSync(args.scratchWritePath, 'canary\n', {flag: 'wx'}); return 'wrote'; });
  // 4) 실제 앱 데이터 목록 읽기(이름은 출력하지 않고 개수만).
  await attempt('appDataRead', () => `entries=${readdirSync(args.appDataDir).length}`);
  await attempt('readControl', () => `entries=${readdirSync(dirname(args.scratchWritePath)).length}`);
  // 5) 신호 0(아무것도 전달하지 않는 권한 확인)을 오케스트레이터에 vs 자기 자신에.
  await attempt('signalOrchestrator', () => { process.kill(args.orchestratorPid, 0); return 'allowed'; });
  await attempt('signalSelf', () => { process.kill(process.pid, 0); return 'allowed'; });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

const isDenied = (outcome: ProbeOutcome | undefined) => !!outcome && !outcome.ok && (outcome.code === 'EPERM' || outcome.code === 'EACCES');

function verdictOf(outcome: ProbeOutcome | undefined, deniedMeansBlocked = isDenied(outcome)): CanaryVerdict {
  if (!outcome) return 'inconclusive';
  if (outcome.ok) return 'allowed';
  return deniedMeansBlocked ? 'blocked' : 'inconclusive';
}

/** 리스너가 요청을 받지 않았고 자식도 실패했으면 막힘. 받았거나 자식이 성공했으면 허용. */
function connectVerdict(hits: number, outcome: ProbeOutcome | undefined): CanaryVerdict {
  if (hits > 0 || outcome?.ok) return 'allowed';
  return outcome && !outcome.ok ? 'blocked' : 'inconclusive';
}

/** 실제 호스트 프로필에 대한 정적 검사(카나리와 같은 생성기 결과). */
export function hostProfileStaticChecks(text: string): Array<{id: string; passed: boolean; detail: string}> {
  const checks = RESERVED_LOOPBACK_PORTS.map(port => ({
    id: `static-deny-${port}`,
    passed: profileDeniesLoopbackPort(text, port),
    detail: `host profile has an ordered deny rule for localhost:${port} and no allow rule for it`,
  }));
  checks.push({
    id: 'static-exec-deny',
    passed: DENIED_EXECUTABLES.every(path => text.includes(`(literal "${path}")`)),
    detail: 'host profile denies every listed executable',
  });
  checks.push({
    id: 'static-loopback-outbound-allowlist',
    passed: profileOutboundIsAllowlist(text),
    detail: 'loopback outbound starts with a *:* deny and ends with an allowlist of run-owned ports (no localhost:* allow, no outbound rule after it)',
  });
  return checks;
}

export interface CanaryInput {
  /** 실제 호스트가 쓰는 프로필 입력. 카나리 프로필은 여기에 픽스처 거부 포트 하나와 대조 포트 하나만 더한다. */
  profileInput: SandboxProfileInput;
  /** 프로필을 쓸 곳(쓰기 허용 루트 밖이어야 한다 — writeSandboxProfile이 확인한다). */
  profileDir: string;
  /** 카나리 자식의 허용 목록 환경. */
  env: Record<string, string>;
  /** 쓰기가 허용되는 스크래치 안의 빈 경로를 만들 폴더. */
  scratchDir: string;
  repoRoot: string;
  /** 워크트리 안이지만 증거가 아닌 곳(기본: mobile/ios/build/emulator-canary-*). */
  worktreeProbeDir?: string;
  home?: string;
  bunExecutable?: string;
  timeoutMs?: number;
}

/**
 * 카나리 자기 시험(실행마다, 해롭지 않은 대상으로). 하나라도 「막힘」이 아니면 실패다.
 * 연결 카나리는 오케스트레이터가 띄운 픽스처 리스너 셋으로 잰다: 같은 생성기가 막은 포트와, 프로필이 언급하지 않는
 * 「남의」 리스너(설치 앱의 임의 포트 같은 것)로는 요청이 0건이어야 하고, 허용 목록의 포트로는 1건 이상 와야 한다
 * (막힘이 샌드박스 때문임을 보인다). 프로필 고쳐 쓰기 카나리는 자식이 자기 프로필 파일에 쓸 수 없음을 본다.
 */
export async function runSandboxCanaries(input: CanaryInput): Promise<CanaryReport> {
  const home = input.home ?? realHome();
  const hostProfile = buildSandboxProfile(input.profileInput);
  const staticChecks = hostProfileStaticChecks(hostProfile.text);
  let deniedHits = 0;
  let foreignHits = 0;
  let controlHits = 0;
  const denied = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => { deniedHits += 1; return new Response('reached'); }});
  const foreign = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => { foreignHits += 1; return new Response('reached'); }});
  const control = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => { controlHits += 1; return new Response('ok'); }});
  const worktreeDir = input.worktreeProbeDir ?? join(input.repoRoot, 'mobile', 'ios', 'build');
  const token = crypto.randomUUID();
  const worktreeWritePath = join(worktreeDir, `emulator-canary-${token}.txt`);
  const scratchWritePath = join(input.scratchDir, `canary-${token}.txt`);
  const report: CanaryReport = {
    profileSha256: hostProfile.sha256,
    canaryProfileSha256: '',
    sandboxStarted: false,
    results: [],
    staticChecks,
    passed: false,
  };
  let canaryProfilePath: string | null = null;
  try {
    mkdirSync(worktreeDir, {recursive: true});
    const canaryProfile = writeSandboxProfile(input.profileDir, `canary-${token}`, {
      ...input.profileInput,
      allowedLoopbackPorts: [...(input.profileInput.allowedLoopbackPorts ?? []), control.port!],
      extraDeniedPorts: [...(input.profileInput.extraDeniedPorts ?? []), denied.port!],
    });
    canaryProfilePath = canaryProfile.path;
    report.canaryProfileSha256 = canaryProfile.sha256;
    const args: ProbeArgs = {
      deniedPort: denied.port!,
      foreignPort: foreign.port!,
      controlPort: control.port!,
      worktreeWritePath,
      scratchWritePath,
      profilePath: canaryProfile.path,
      appDataDir: realAppDataDir(home),
      orchestratorPid: process.pid,
    };
    const child = Bun.spawn(sandboxedArgv(canaryProfile, [input.bunExecutable ?? process.execPath, '--env-file=/dev/null', import.meta.path, '--canary-probe', JSON.stringify(args)]), {
      cwd: input.scratchDir,
      env: input.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, input.timeoutMs ?? 30_000);
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timer);
    const line = stdout.trim().split('\n').pop() ?? '';
    let probe: Record<string, ProbeOutcome>;
    try { probe = JSON.parse(line); }
    catch {
      report.error = `canary probe did not report (exit=${exitCode}): ${stderr.trim().slice(-400)}`;
      return report;
    }
    report.sandboxStarted = true;
    const appDataExists = existsSync(realAppDataDir(home));
    const worktreeLeak = existsSync(worktreeWritePath);
    const profileTampered = sha256(readFileSync(canaryProfile.path)) !== canaryProfile.sha256;
    report.results = [
      {
        id: 'exec-open', description: '/usr/bin/open -h must not execute', expected: 'blocked',
        verdict: verdictOf(probe.execOpen), controlPassed: probe.execControl?.ok === true,
        detail: `${probe.execOpen?.code}: ${probe.execOpen?.detail}`, passed: false,
      },
      {
        id: 'denied-port', description: 'connection to a fixture port denied by the same rule generator must fail', expected: 'blocked',
        verdict: connectVerdict(deniedHits, probe.deniedPort),
        controlPassed: probe.controlPort?.ok === true && controlHits > 0,
        detail: `denied listener hits=${deniedHits}, control hits=${controlHits}; ${probe.deniedPort?.detail}`, passed: false,
      },
      {
        id: 'foreign-listener', description: 'connection to a loopback listener the profile does not name (another process\'s port) must fail', expected: 'blocked',
        verdict: connectVerdict(foreignHits, probe.foreignPort),
        controlPassed: probe.controlPort?.ok === true && controlHits > 0,
        detail: `foreign listener hits=${foreignHits}, control hits=${controlHits}; ${probe.foreignPort?.detail}`, passed: false,
      },
      {
        id: 'worktree-write', description: 'writing a non-evidence path inside the worktree must fail', expected: 'blocked',
        verdict: worktreeLeak ? 'allowed' : verdictOf(probe.worktreeWrite), controlPassed: probe.scratchWrite?.ok === true,
        detail: `${probe.worktreeWrite?.code}: ${probe.worktreeWrite?.detail}`, passed: false,
      },
      {
        id: 'profile-write', description: 'a sandboxed host must not be able to rewrite its own sandbox profile', expected: 'blocked',
        verdict: profileTampered ? 'allowed' : verdictOf(probe.profileWrite), controlPassed: probe.scratchWrite?.ok === true,
        detail: `${probe.profileWrite?.code}: ${probe.profileWrite?.detail}${profileTampered ? ' (profile hash changed)' : ''}`, passed: false,
      },
      {
        id: 'real-app-data-read', description: 'listing the real app data folder must fail', expected: 'blocked',
        verdict: appDataExists ? verdictOf(probe.appDataRead) : 'inconclusive', controlPassed: probe.readControl?.ok === true,
        detail: appDataExists ? `${probe.appDataRead?.code}` : 'real app data folder does not exist on this Mac — cannot prove the read rule',
        passed: false,
      },
      {
        id: 'signal-orchestrator', description: 'signal 0 to a process outside the sandbox must fail', expected: 'blocked',
        verdict: verdictOf(probe.signalOrchestrator), controlPassed: probe.signalSelf?.ok === true,
        detail: `${probe.signalOrchestrator?.code}: ${probe.signalOrchestrator?.detail}`, passed: false,
      },
    ];
    for (const result of report.results) result.passed = result.verdict === 'blocked' && result.controlPassed;
    report.passed = report.results.every(result => result.passed) && staticChecks.every(check => check.passed);
    return report;
  } catch (error) {
    report.error = String((error as Error)?.message ?? error);
    return report;
  } finally {
    denied.stop(true);
    foreign.stop(true);
    control.stop(true);
    // 샌드박스가 실패해 써졌다면 지운다(결과는 이미 「허용」으로 기록됐다).
    if (existsSync(worktreeWritePath)) rmSync(worktreeWritePath, {force: true});
    if (existsSync(scratchWritePath)) rmSync(scratchWritePath, {force: true});
    if (canaryProfilePath) rmSync(canaryProfilePath, {force: true});
  }
}

if (import.meta.main && process.argv[2] === '--canary-probe') {
  await canaryProbe(JSON.parse(process.argv[3] ?? '{}') as ProbeArgs);
}

export const SANDBOX_SOURCE = resolve(import.meta.path);
