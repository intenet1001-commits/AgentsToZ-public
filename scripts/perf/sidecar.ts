/**
 * (A) 사이드카 시작 → /api/health 첫 200, (D) 휴대폰이 기다리는 호스트 쪽 목록 비용.
 *
 * ⚠️ 실사용 사이드카(3001)와 실제 앱 데이터(~/Library/Application Support/com.portmanager.portmanager)를
 * 절대 쓰지 않는다. 사이드카마다 스크래치 HOME·APP_DATA_DIR·빈 포트를 주고, 상속 환경 대신 최소 환경만
 * 넘긴다(Codex Desktop처럼 설치 앱이 띄운 부모가 APP_DATA_DIR을 물려주는 경우가 있다 — tests/startTestApiServer.ts).
 * 떠 있는 동안 `lsof -p`로 그 프로세스가 실제 앱 데이터·~/.claude·~/.codex 아래 파일을 하나도 열지 않았는지
 * 확인하고, 열었으면 측정을 버리고 실패한다.
 *
 * (D)는 그 격리 사이드카에 합성 프로젝트 150개를 등록하고, 실제 휴대폰 LAN 경로(관리 API로 켜기 →
 * QR 토큰 → WebSocket `controller.pair` → `projects.list` 페이지 넘기기)를 그대로 돈다. 사설 IPv4가 없는
 * 기기에서는 건너뛴다(실제 리스너가 그것만 받는다). 리스너는 측정이 끝나면 끈다.
 */
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {homedir, networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {REMOTE_CONTROL_PROTOCOL_VERSION} from '../../src/remoteControlCore';
import {isPrivateRemoteControlIpv4} from '../../src/remoteControlLanServer';
import {REPO_ROOT, collect, log, now, record, recorder, sampled} from './environment';
import type {PerfMeasurement} from './stats';

export const REAL_APP_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'com.portmanager.portmanager');
const INSTALLED_SIDECAR = '/Applications/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-api-sidecar';
const FORBIDDEN_PREFIXES = [REAL_APP_DATA_DIR, join(homedir(), '.claude'), join(homedir(), '.codex'), join(homedir(), '.hermes'), join(homedir(), '.gemini')];
const MANAGEMENT_ORIGIN = 'http://localhost:9000';

/** 측정이 중단돼도(Ctrl-C·예외) 격리 사이드카를 남기지 않는다. */
const runningChildren = new Set<Bun.Subprocess>();
const killAll = () => { for (const child of runningChildren) { try { child.kill('SIGKILL'); } catch {} } };
process.on('exit', killAll);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { killAll(); process.exit(130); });

async function freePort(): Promise<number> {
  const probe = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('')});
  const port = probe.port;
  probe.stop(true);
  if (!port) throw new Error('no free port');
  return port;
}

export interface IsolatedRoot { root: string; home: string; appDataDir: string }

export function isolatedRoot(scratch: string, label: string): IsolatedRoot {
  const root = realpathSync(mkdtempSync(join(scratch, `sidecar-${label}-`)));
  const home = join(root, 'home');
  const appDataDir = join(root, 'app-data');
  mkdirSync(home, {recursive: true});
  mkdirSync(appDataDir, {recursive: true});
  return {root, home, appDataDir};
}

function isolatedEnv(root: IsolatedRoot, port: number): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root.home,
    USERPROFILE: root.home,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'en_US.UTF-8',
    APP_DATA_DIR: root.appDataDir,
    APPDATA: join(root.root, 'roaming'),
    XDG_CONFIG_HOME: join(root.home, '.config'),
    HERMES_HOME: join(root.home, '.hermes'),
    API_PORT: String(port),
    // 부팅 때 사용자 설정을 맞추는 작업은 격리 HOME에서도 돌 이유가 없다.
    AGENTSTOZ_SKIP_HERMES_SYNC: '1',
    AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1',
    AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP: '1',
    AGENTSTOZ_SKIP_MCP_CONNECTION_SYNC: '1',
  };
}

export interface RunningSidecar {
  child: Bun.Subprocess;
  baseUrl: string;
  readyMs: number;
  stop: () => Promise<void>;
}

/** 프로세스가 연 파일 중 금지된 위치가 있으면 그 경로들을 돌려준다. */
export function forbiddenOpenFiles(pid: number): string[] {
  const out = spawnSync('/usr/sbin/lsof', ['-p', String(pid), '-Fn'], {encoding: 'utf8'}).stdout ?? '';
  return out.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1))
    // A managed checkout may live under ~/.codex/worktrees. lsof reports the
    // sidecar's cwd there even when it opens no user data; keep every child
    // path subject to the guard so .env and other files are still detected.
    .filter(path => path !== REPO_ROOT && FORBIDDEN_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`)));
}

export async function startSidecar(root: IsolatedRoot, kind: 'source' | 'installed'): Promise<RunningSidecar> {
  const port = await freePort();
  const env = isolatedEnv(root, port);
  const command = kind === 'source'
    // --env-file=/dev/null: 작업 트리에 .env가 있어도 읽지 않는다(CLAUDE.md 「에이전트 런타임 가드」).
    ? [process.execPath, '--env-file=/dev/null', join(REPO_ROOT, 'api-server.ts')]
    : [INSTALLED_SIDECAR];
  // 파이프로 받으면 아무도 읽지 않는 동안 버퍼가 차서 사이드카가 멈출 수 있다 — 파일로 받는다.
  const stderrLog = join(root.root, `sidecar-${port}.stderr.log`);
  const t0 = now();
  const child = Bun.spawn(command, {cwd: kind === 'source' ? REPO_ROOT : root.root, env, stdout: 'ignore', stderr: Bun.file(stderrLog)});
  runningChildren.add(child);
  void child.exited.then(() => runningChildren.delete(child));
  const baseUrl = `http://127.0.0.1:${port}`;
  let exitCode: number | null = null;
  void child.exited.then(code => { exitCode = code; });
  let readyMs = -1;
  while (now() - t0 < 30_000) {
    if (exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.status === 200) { readyMs = now() - t0; break; }
    } catch { /* not listening yet */ }
    await Bun.sleep(5);
  }
  const stop = async () => {
    try { child.kill('SIGTERM'); } catch {}
    const exited = await Promise.race([child.exited, Bun.sleep(8_000).then(() => null)]);
    if (exited === null) { try { child.kill('SIGKILL'); } catch {} await child.exited; }
  };
  if (readyMs < 0) {
    const stderr = await Bun.file(stderrLog).text().catch(() => '');
    await stop();
    throw new Error(`isolated ${kind} sidecar never became healthy (exit=${exitCode}): ${stderr.slice(-1500)}`);
  }
  return {child, baseUrl, readyMs, stop};
}

async function assertIsolatedWhileRunning(sidecar: RunningSidecar, label: string) {
  const leaks = forbiddenOpenFiles(sidecar.child.pid);
  if (leaks.length) {
    await sidecar.stop();
    throw new Error(`${label}: isolated sidecar opened real user files: ${leaks.slice(0, 5).join(', ')}`);
  }
}

export async function measureSidecarStart(scratch: string, samples: number, projectsFixture: ProjectsFixture | null): Promise<Record<string, PerfMeasurement>> {
  const out: Record<string, PerfMeasurement> = {};
  const variants: Array<{id: string; kind: 'source' | 'installed'; fixture: ProjectsFixture | null; method: string; reproducible: boolean; notes: string}> = [
    {id: 'sidecar.start.source.empty', kind: 'source', fixture: null, reproducible: true,
      method: '`bun api-server.ts`(이 작업 트리 소스)를 격리 HOME·APP_DATA_DIR·빈 포트로 띄워 /api/health 첫 200까지(5ms 폴링). 같은 격리 폴더로 재시작(첫 실행 1회 버림).',
      notes: '앱 데이터가 빈 상태. 소스 모드라 TS 변환 비용이 들어간다 — 설치 앱은 컴파일된 바이너리다.'},
    ...(projectsFixture ? [{id: 'sidecar.start.source.150-projects', kind: 'source' as const, fixture: projectsFixture, reproducible: true,
      method: '위와 같되 합성 프로젝트 150개(git 저장소, 10개는 링크된 워크트리 1개씩)가 등록된 ports.json으로.',
      notes: '부팅 중 프로젝트 수에 비례하는 일이 health를 늦추는지 본다.'}] : []),
    ...(existsSync(INSTALLED_SIDECAR) ? [{id: 'sidecar.start.installed-binary.empty', kind: 'installed' as const, fixture: null, reproducible: false,
      method: '설치된 앱 번들의 컴파일된 사이드카를 격리 HOME·APP_DATA_DIR·빈 포트로 띄워 /api/health 첫 200까지. Tauri 창 생성은 포함하지 않는다.',
      notes: `설치본 ${installedBuildLabel()} — 앱을 다시 설치하면 바뀌므로 비교 대상이 아니다. 실제 앱 시작 = Tauri 부팅 + 이 값.`}] : []),
  ];
  for (const variant of variants) {
    log(`A ${variant.id}`);
    const root = isolatedRoot(scratch, variant.id.replaceAll('.', '-'));
    if (variant.fixture) variant.fixture.install(root);
    let checked = false;
    const values = await sampled(() => collect(async () => {
      const sidecar = await startSidecar(root, variant.kind);
      if (!checked) { await Bun.sleep(1_500); await assertIsolatedWhileRunning(sidecar, variant.id); checked = true; }
      await sidecar.stop();
      return sidecar.readyMs;
    }, {samples, warmup: 1, gapMs: 300}));
    out[variant.id] = record({method: variant.method, reproducible: variant.reproducible, notes: variant.notes,
      regressionFloor: 150, data: values});
  }
  return out;
}

function installedBuildLabel(): string {
  try {
    const plist = execFileSync('/usr/bin/defaults', ['read', '/Applications/AgentsToZ_byCS.app/Contents/Info.plist', 'CFBundleShortVersionString'], {encoding: 'utf8'}).trim();
    return `v${plist}`;
  } catch { return '버전 미상'; }
}

// ───────────────────────── 합성 프로젝트 150개 ─────────────────────────

export interface ProjectsFixture {
  count: number;
  worktrees: number;
  install(root: IsolatedRoot): void;
}

/** 실제 git 저장소 150개(빈 커밋 1개) + 그중 10개에 링크된 워크트리. 한 번 만들어 여러 사이드카가 공유한다. */
export function buildProjectsFixture(scratch: string, count = 150, worktrees = 10): ProjectsFixture {
  const base = realpathSync(mkdtempSync(join(scratch, 'projects-')));
  const gitEnv = {...process.env, GIT_AUTHOR_NAME: 'perf', GIT_AUTHOR_EMAIL: 'perf@example.invalid',
    GIT_COMMITTER_NAME: 'perf', GIT_COMMITTER_EMAIL: 'perf@example.invalid', GIT_CONFIG_NOSYSTEM: '1', HOME: base};
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = `perf-project-${String(i).padStart(3, '0')}`;
    const folder = join(base, name);
    mkdirSync(folder);
    writeFileSync(join(folder, 'package.json'), JSON.stringify({name, scripts: {dev: 'vite'}}));
    execFileSync('git', ['init', '-q', '-b', 'main', folder], {env: gitEnv});
    execFileSync('git', ['-C', folder, 'commit', '-q', '--allow-empty', '-m', 'init'], {env: gitEnv});
    if (i < worktrees) {
      execFileSync('git', ['-C', folder, 'worktree', 'add', '-q', '-b', `feature-${i}`, join(folder, 'worktrees', `feature-${i}`)], {env: gitEnv});
    }
    // 앞 100개는 포트가 있다(시작 명령 감지·lsof 상태가 카드마다 붙는다). 나머지는 폴더 전용 항목.
    const id = `${String(i).padStart(8, '0')}-perf-4aaa-8aaa-${String(i).padStart(12, '0')}`;
    rows.push({id, name, aiName: `Perf Alias ${i}`, folderPath: folder, ...(i < 100 ? {port: 41_000 + i} : {})});
  }
  return {
    count, worktrees,
    install(root) { writeFileSync(join(root.appDataDir, 'ports.json'), JSON.stringify(rows, null, 2)); },
  };
}

// ───────────────────────── (D) LAN 경로로 목록 받기 ─────────────────────────

function privateAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateRemoteControlIpv4(entry.address)) return entry.address;
    }
  }
  return null;
}

async function management(baseUrl: string, path: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: MANAGEMENT_ORIGIN}, body: JSON.stringify(body)});
  const json = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(`${path} → ${response.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

function openSocket(origin: string): Promise<{socket: WebSocket; next: (timeoutMs?: number) => Promise<any>}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace('http://', 'ws://')}/remote/ws`, {headers: {Origin: origin}} as unknown as string[]);
    const inbox: any[] = [];
    let waiting: ((value: any) => void) | null = null;
    socket.addEventListener('message', event => {
      const parsed = JSON.parse(String((event as MessageEvent).data));
      if (waiting) { const resume = waiting; waiting = null; resume(parsed); } else inbox.push(parsed);
    });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')));
    socket.addEventListener('open', () => resolve({
      socket,
      next: (timeoutMs = 20_000) => inbox.length ? Promise.resolve(inbox.shift()) : Promise.race([
        new Promise<any>(done => { waiting = done; }),
        new Promise<any>((_, fail) => setTimeout(() => fail(new Error(`host sent nothing within ${timeoutMs}ms`)), timeoutMs)),
      ]),
    }));
  });
}

export async function measureRemoteProjectList(scratch: string, samples: number, fixture: ProjectsFixture): Promise<Record<string, PerfMeasurement>> {
  const address = privateAddress();
  if (!address) { log('D 사설 IPv4 없음 — LAN 목록 측정을 건너뜀'); return {}; }
  log(`D 원격 목록(LAN 경로, 합성 프로젝트 ${fixture.count}개) — 격리 사이드카`);
  const root = isolatedRoot(scratch, 'remote-list');
  fixture.install(root);
  const sidecar = await startSidecar(root, 'source');
  const walkRec = recorder(['pairs', 'pageAfter', 'walks'] as const);
  const {pairs, pageAfter, walks} = walkRec.samples;
  const pollRec = recorder(['steady', 'afterIdle'] as const);
  const pageCounts: number[] = [], cardCounts: number[] = [];
  let walkData!: ReturnType<typeof walkRec.done>, pollData!: ReturnType<typeof pollRec.done>, coldFirstPoll = -1;
  try {
    await assertIsolatedWhileRunning(sidecar, 'remote-list');
    const interfaces = await management(sidecar.baseUrl, '/api/remote-control/interfaces');
    if (!(interfaces.interfaces as Array<{address: string}>).some(entry => entry.address === address)) throw new Error('sidecar does not offer the private address');
    await management(sidecar.baseUrl, '/api/remote-control/enable', {interfaceAddress: address});
    // 첫 표본은 버린다(목록 경로의 모듈·캐시 데우기) — 휴대폰이 두 번째 이후 여는 경우와 같다.
    for (let i = -1; i < samples; i += 1) {
      const pairing = await management(sidecar.baseUrl, '/api/remote-control/pairing/rotate');
      const url = new URL(String(pairing.pairingUrl));
      const token = new URLSearchParams(url.hash.slice(1)).get('pair') ?? '';
      const {socket, next} = await openSocket(url.origin);
      const t0 = now();
      socket.send(JSON.stringify({type: 'controller.pair', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, token}));
      const ready = await next();
      const tReady = now() - t0;
      if (ready.type !== 'session.ready') throw new Error(`pairing failed: ${JSON.stringify(ready).slice(0, 300)}`);
      let cards = (ready.projects as unknown[]).length;
      let page: number | null = ready.nextProjectPage ?? ready.nextPage ?? null;
      let pages = 1;
      const pageTimes: number[] = [];
      while (page !== null && page !== undefined) {
        const t = now();
        socket.send(JSON.stringify({type: 'action.request', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
          sessionToken: ready.sessionToken, actionId: crypto.randomUUID(), action: 'projects.list', page}));
        const result = await next();
        pageTimes.push(now() - t);
        if (!result.ok) throw new Error(`projects.list failed: ${JSON.stringify(result).slice(0, 300)}`);
        cards += (result.projects as unknown[]).length;
        page = result.nextPage ?? null;
        pages += 1;
      }
      const walk = now() - t0;
      socket.send(JSON.stringify({type: 'session.end', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, sessionToken: ready.sessionToken}));
      socket.close();
      if (i >= 0) {
        pairs.push(tReady);
        pageAfter.push(...pageTimes);
        walks.push(walk);
        pageCounts.push(pages);
        cardCounts.push(cards);
      }
      // 읽기 예산(10초당 20회)은 세션마다 따로다 — 새 QR이 곧 새 세션이라 예산에 걸리지 않는다.
      await Bun.sleep(300);
    }
    walkData = walkRec.done();
    // 워크룸 목록 폴링: 휴대폰의 워크룸 화면은 세션 목록·출력을 1초 남짓마다 읽는다. 그 한 번의 호스트 몫.
    {
      const pairing = await management(sidecar.baseUrl, '/api/remote-control/pairing/rotate');
      const url = new URL(String(pairing.pairingUrl));
      const token = new URLSearchParams(url.hash.slice(1)).get('pair') ?? '';
      const {socket, next} = await openSocket(url.origin);
      socket.send(JSON.stringify({type: 'controller.pair', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, token}));
      const ready = await next();
      if (ready.type !== 'session.ready') throw new Error('pairing for terminal poll failed');
      const status = await management(sidecar.baseUrl, '/api/remote-control/status');
      const row = (status.sessions as Array<{id: string; connected: boolean}>).find(entry => entry.connected);
      if (!row) throw new Error('no connected LAN session to grant terminal access');
      // 이 격리 사이드카 안에서만, 그 세션에 워크룸 접근을 허용한다(Mac 화면의 「허용」과 같은 관리 요청).
      const grant = await fetch(`${sidecar.baseUrl}/api/agent-runtime/terminals/access`, {method: 'POST',
        headers: {'Content-Type': 'application/json', Origin: MANAGEMENT_ORIGIN}, body: JSON.stringify({owner: `lan:${row.id}`, enabled: true})});
      if (!grant.ok) throw new Error(`terminal access grant failed: ${grant.status} ${(await grant.text()).slice(0, 200)}`);
      const poll = async () => {
        const t = now();
        socket.send(JSON.stringify({type: 'terminal.request', sessionToken: ready.sessionToken, request: {operation: 'list', requestId: crypto.randomUUID()}}));
        const result = await next();
        if (result.type !== 'terminal.result' || result.ok !== true) throw new Error(`terminal list failed: ${JSON.stringify(result).slice(0, 300)}`);
        return now() - t;
      };
      // 부팅 뒤 첫 워크룸 요청(등록 대상 인벤토리가 처음 만들어진다) — 한 번뿐이라 기록만 남긴다.
      coldFirstPoll = await poll();
      // 같은 세션의 연속 폴링(250ms 간격 — 휴대폰 기본 박자 0.7초~보다 촘촘하게).
      for (let i = 0; i < samples * 4; i += 1) { await Bun.sleep(250); pollRec.samples.steady.push(await poll()); }
      // 5초 넘게 쉬었다가 돌아온 폴링 — 읽기 전용 캐시(5초)가 모두 만료된 뒤의 한 번.
      for (let i = 0; i < Math.max(3, Math.ceil(samples / 2)); i += 1) { await Bun.sleep(5_500); pollRec.samples.afterIdle.push(await poll()); }
      pollData = pollRec.done();
      socket.send(JSON.stringify({type: 'session.end', protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, sessionToken: ready.sessionToken}));
      socket.close();
    }
    await management(sidecar.baseUrl, '/api/remote-control/disable').catch(() => undefined);
  } finally { await sidecar.stop(); }
  const where = `격리 사이드카(소스) + 합성 프로젝트 ${fixture.count}개(워크트리 ${fixture.worktrees}) + 실제 LAN 리스너·WebSocket(${REMOTE_CONTROL_PROTOCOL_VERSION}).`;
  return {
    'remote.list.pair-first-page': record({method: `${where} controller.pair 전송부터 session.ready(첫 페이지 카드 포함)까지. 첫 걸음은 버림.`, reproducible: true, regressionFloor: 100,
      notes: `카드 ${cardCounts[0] ?? '?'}장 / ${pageCounts[0] ?? '?'}페이지. pair는 등록 프로젝트 전체를 새로 읽어 카드를 만든다.`, data: walkData.pairs}),
    'remote.list.next-page': record({method: `${where} projects.list 한 페이지 요청→응답(page ≥1). 표본=모든 걸음의 모든 페이지.`, reproducible: true, regressionFloor: 50,
      notes: 'page 0이 만든 세션별 프로젝트 목록을 15초간 재사용한다. 시간이 지나면 등록 프로젝트 전체를 다시 열거한다(RemoteControlCore.#refreshProjectCards, lsof 포함).', data: walkData.pageAfter}),
    'remote.list.full-walk': record({method: `${where} pair부터 마지막 페이지까지(휴대폰이 목록을 다 받는 시간의 호스트 몫, 릴레이·네트워크 제외).`, reproducible: true, regressionFloor: 200,
      notes: `걸음당 페이지 ${pageCounts.join('/')}; 카드 ${cardCounts.join('/')}.`, data: walkData.walks}),
    'remote.workroom.list-poll': record({method: `${where} 워크룸 접근을 허용한 LAN 세션에서 terminal.request {operation:'list'} 왕복, 250ms 간격 연속 ${samples * 4}회(부팅 뒤 첫 요청 제외).`, reproducible: true, regressionFloor: 30,
      notes: `휴대폰 워크룸 화면의 세션 목록·출력 폴링 한 번의 호스트 몫. 부팅 뒤 첫 요청은 ${Math.round(coldFirstPoll)}ms(대상 인벤토리 첫 생성).`, data: pollData.steady}),
    'remote.workroom.list-poll-after-idle': record({method: `${where} 같은 세션에서 5.5초 쉬었다가 보내는 terminal list(읽기 전용 캐시 5초가 만료된 뒤).`, reproducible: true, regressionFloor: 100,
      notes: '바인딩(taskTargetBindings)과 대상 인벤토리를 다시 만드는 값 — 폴링이 5초마다 한 번씩 치르는 비용.', data: pollData.afterIdle}),
  };
}
