/**
 * WP2 Supabase shim(scripts/emulator-e2e/supabaseShim.ts)을 격리 호스트로 띄우고 멈춘다 — 뒤 레인(j1-relay-*, j4-*)은
 * 오케스트레이터의 `ctx.startSupabaseShim`으로 쓴다.
 *
 * 설계 §2.3: 모든 호스트 프로세스는 WP1 샌드박스 아래서만 뜬다. 그래서 shim을 오케스트레이터 안에서 import해 띄우지
 * 않는다(그러면 shim이 sandbox_check로 재는 isolation이 not-sandboxed이고, PGlite·src/의 스키마가 오케스트레이터에
 * 실린다). `sandbox-exec -f <프로필> bun --env-file=/dev/null supabaseShim.ts serve …`로 별도 프로세스에 띄우고, 환경은
 * 허용 목록(ctx.allowlistedEnv), 스크래치·증거는 이 실행의 것이다. 이 파일은 shim을 타입으로만 가져온다.
 *
 * 준비: stdout의 `{"event":"ready"}` 한 줄(비밀 없음 — 키·OTP는 0600 credentials 파일에만 있고 credentials()가 읽는다).
 * 멈춤: SIGTERM → shim이 가린 덤프·보고서를 증거 폴더에 쓰고 끝난다. 종료 코드 0 깨끗함 · 3 모르는 경로/거절한 origin/
 * 내부 오류를 봤음 · 4 증거를 못 썼거나 깨끗이 못 멈춤 · 2 사용법/환경 거절. 하네스는 레인이 끝날 때 이 결과를 보고
 * 문제가 있으면(problems) 레인이 무엇을 돌려주든 실패로 바꾼다 — shim 문서의 「A lane must treat that as a failure」를
 * 레인이 잊어도 하네스가 집행한다.
 * https 문은 기본으로 임시 포트다(`--https-port 0`). 443이 필요한 레인만 `httpsPort: 443`을 주고, 묶지 못하면 shim이
 * ready의 httpsFallback에 그 사유를 적는다(`requireHttpsPort`면 시작이 실패한다).
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {RESERVED_LOOPBACK_PORTS} from './environment';
import {sandboxedArgv, type WrittenSandboxProfile} from './sandbox';
import type {ShimIsolation, SupabaseShimCredentials} from './supabaseShim';

export const SUPABASE_SHIM_SCRIPT = 'scripts/emulator-e2e/supabaseShim.ts';
/** PGlite 기동 + 정본 스키마 적용(측정: 단독 수 초). 무거운 기기·동시 실행을 감안한 상한이다. */
export const SUPABASE_SHIM_READY_TIMEOUT_MS = 90_000;
/** SIGTERM 뒤 shim이 요청을 비우고 증거를 쓰는 시간. 넘으면 SIGKILL(→ 결과는 문제로 남는다). */
export const SUPABASE_SHIM_STOP_TIMEOUT_MS = 30_000;
/** supabaseShim.ts의 SHIM_EXIT_*와 같은 값(런타임에 그 모듈을 import하지 않으려고 옮겨 적는다 — 테스트가 같음을 확인한다). */
export const SUPABASE_SHIM_EXIT = Object.freeze({clean: 0, usage: 2, unsupported: 3, stopFailed: 4});

const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface SupabaseShimHostOptions {
  repoRoot: string;
  /** 띄울 샌드박스(WP1 생성기의 프로필). LAN inbound 프로필은 받지 않는다 — shim은 loopback에만 묶는다. */
  profile: WrittenSandboxProfile;
  /** 허용 목록 환경(ctx.allowlistedEnv). shim이 다시 HOME·TMPDIR·앱 데이터·금지 키를 검사한다. */
  env: Record<string, string>;
  /** 이 shim의 스크래치(CA·credentials 파일). 실제 홈 밖, 프로필의 쓰기 허용 루트 안. */
  scratchDir: string;
  /** shim이 stop 때 가린 덤프·보고서를 쓰는 곳(새 폴더). 프로필의 쓰기 허용 루트 안. */
  evidenceDir: string;
  runId: string;
  label: string;
  members?: string[];
  outsiders?: string[];
  /** 기본 0(임시 포트). 443은 휴대폰 포털처럼 포트 없는 https origin이 필요한 레인만. */
  httpsPort?: number;
  requireHttpsPort?: boolean;
  /** 기본 true. */
  http?: boolean;
  /** 기본 true. */
  https?: boolean;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  log?: (message: string) => void;
  /** 자식 추적(하네스가 죽을 때 같이 멈춘다). 기본: 추적하지 않는다(shim도 부모가 사라지면 스스로 멈춘다). */
  track?: (child: Bun.Subprocess) => void;
}

/** shim의 ready 줄(supabaseShim.ts serveCli). 비밀은 없다. */
export interface SupabaseShimReady {
  runId: string;
  pid: number;
  httpUrl: string | null;
  httpsUrl: string | null;
  httpsPort: number | null;
  httpsFallback: string | null;
  caCertPath: string | null;
  caFingerprintSha256: string | null;
  credentialsPath: string;
  isolation: ShimIsolation;
}

export interface SupabaseShimStopped {
  exitCode: number | null;
  signalCode: string | null;
  /** shim의 `{"event":"stopped"}` 줄(없으면 null — 신호로 죽었거나 그 전에 끝났다). */
  stopped: Record<string, unknown> | null;
  /** 시간 안에 멈추지 않아 SIGKILL했다. */
  forced: boolean;
}

export interface RunningSupabaseShim {
  /** The owned sandbox child; its exit is checked separately from lane-result problems. */
  child: Bun.Subprocess;
  readonly label: string;
  readonly pid: number;
  readonly ready: SupabaseShimReady;
  /** 이 shim의 loopback 포트(http·https). 이 shim에 연결할 호스트 프로필의 `allowedLoopbackPorts`에 넣는다. */
  readonly loopbackPorts: number[];
  readonly evidenceDir: string;
  /** 0600 credentials 파일(anon·service 키, OTP 코드, 사용자, CA 경로). 증거에 옮겨 적지 않는다. */
  credentials(): SupabaseShimCredentials;
  /** 끝났으면 그 결과, 아니면 null. */
  result(): SupabaseShimStopped | null;
  /** 하네스 판정: 깨끗하지 않은 종료·샌드박스 밖·멈추지 않음. 멈춘 뒤에만 완전하다. */
  problems(): string[];
  /** 멈춘다(여러 번 불러도 같은 결과). */
  stop(): Promise<SupabaseShimStopped>;
}

/** `serve` 인자. 경로는 절대 경로여야 한다(shim이 다시 검사한다). */
export function supabaseShimServeArgs(options: Pick<SupabaseShimHostOptions, 'scratchDir' | 'evidenceDir' | 'runId' | 'members' | 'outsiders' | 'httpsPort' | 'requireHttpsPort' | 'http' | 'https'>): string[] {
  const args = ['serve', '--scratch', options.scratchDir, '--evidence', options.evidenceDir, '--run-id', options.runId];
  for (const email of options.members ?? []) args.push('--member', email);
  for (const email of options.outsiders ?? []) args.push('--outsider', email);
  if (options.http === false) args.push('--no-http');
  if (options.https === false) {
    if (options.httpsPort !== undefined || options.requireHttpsPort) throw new Error('supabase shim: httpsPort/requireHttpsPort contradict https: false');
    args.push('--no-https');
  } else {
    args.push('--https-port', String(options.httpsPort ?? 0));
    if (options.requireHttpsPort) args.push('--require-https-port');
  }
  if (options.http === false && options.https === false) throw new Error('supabase shim: http: false and https: false leave no door');
  return args;
}

function loopbackPort(url: string | null, door: 'http' | 'https'): number | null {
  if (url === null) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`supabase shim announced an invalid ${door} URL`); }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === 'localhost';
  if (parsed.protocol !== `${door}:` || !loopback) throw new Error(`supabase shim announced a non-loopback ${door} door (${parsed.protocol}//${parsed.hostname})`);
  const port = parsed.port ? Number(parsed.port) : door === 'https' ? 443 : 80;
  if ((RESERVED_LOOPBACK_PORTS as readonly number[]).includes(port)) throw new Error(`supabase shim announced reserved port ${port}`);
  return port;
}

/** ready 줄 → 검사한 ready와 loopback 포트. 모양이 틀리거나 loopback 밖이면 던진다. */
export function parseShimReady(event: Record<string, unknown>): {ready: SupabaseShimReady; loopbackPorts: number[]} {
  const text = (key: string): string | null => {
    const value = event[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new Error(`supabase shim ready: ${key} is not a string`);
    return value;
  };
  if (event.event !== 'ready') throw new Error('not a ready event');
  const pid = event.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) throw new Error('supabase shim ready: invalid pid');
  const credentialsPath = text('credentialsPath');
  if (!credentialsPath || !credentialsPath.startsWith('/')) throw new Error('supabase shim ready: invalid credentialsPath');
  const isolation = event.isolation as ShimIsolation | undefined;
  if (!isolation || typeof isolation !== 'object' || typeof isolation.status !== 'string') throw new Error('supabase shim ready: no isolation');
  const httpsPortValue = event.httpsPort;
  if (httpsPortValue !== null && httpsPortValue !== undefined && (typeof httpsPortValue !== 'number' || !Number.isInteger(httpsPortValue))) {
    throw new Error('supabase shim ready: invalid httpsPort');
  }
  const ready: SupabaseShimReady = {
    runId: text('runId') ?? '',
    pid,
    httpUrl: text('httpUrl'),
    httpsUrl: text('httpsUrl'),
    httpsPort: (httpsPortValue as number | null | undefined) ?? null,
    httpsFallback: text('httpsFallback'),
    caCertPath: text('caCertPath'),
    caFingerprintSha256: text('caFingerprintSha256'),
    credentialsPath,
    isolation,
  };
  if (!ready.httpUrl && !ready.httpsUrl) throw new Error('supabase shim ready: no door is open');
  const ports = [loopbackPort(ready.httpUrl, 'http'), loopbackPort(ready.httpsUrl, 'https')].filter((port): port is number => port !== null);
  return {ready, loopbackPorts: [...new Set(ports)]};
}

/** 하네스 판정(순수 함수 — 테스트가 같은 판정을 쓴다). */
export function shimProblems(ready: Pick<SupabaseShimReady, 'isolation'>, stopped: SupabaseShimStopped | null): string[] {
  const problems: string[] = [];
  if (ready.isolation.status !== 'sandboxed') problems.push(`ran ${ready.isolation.status} (design §2.3: every host runs under the WP1 sandbox)`);
  if (!stopped) return [...problems, 'still running'];
  if (stopped.forced) problems.push('did not stop within the grace period (SIGKILL)');
  if (stopped.exitCode !== SUPABASE_SHIM_EXIT.clean) {
    const why = stopped.exitCode === SUPABASE_SHIM_EXIT.unsupported ? 'unknown routes, rejected origins or internal errors were seen'
      : stopped.exitCode === SUPABASE_SHIM_EXIT.stopFailed ? 'evidence could not be written or the shim did not stop cleanly'
        : stopped.exitCode === null ? `killed by ${stopped.signalCode ?? 'a signal'}` : 'unexpected exit';
    const counts = stopped.stopped
      ? ` (unknown routes ${String(stopped.stopped.unknownRoutes ?? '?')}, rejected origins ${String(stopped.stopped.rejectedOrigins ?? '?')}, internal errors ${String(stopped.stopped.internalErrors ?? '?')})`
      : '';
    problems.push(`exited ${stopped.exitCode ?? stopped.signalCode}: ${why}${counts}`);
  }
  return problems;
}

/**
 * shim을 샌드박스 안에 띄우고 ready를 기다린다. ready 전에 끝나거나 시간을 넘기면 멈추고 던진다(stderr 끝부분 포함).
 * 이 함수는 경로·라벨·프로필만 검사한다 — 환경·경로의 실제 규칙은 shim이 다시 집행한다(사용법 2로 끝난다).
 */
export async function startSupabaseShimHost(options: SupabaseShimHostOptions): Promise<RunningSupabaseShim> {
  if (!LABEL_PATTERN.test(options.label)) throw new Error(`supabase shim label must match ${LABEL_PATTERN} (got ${JSON.stringify(options.label)})`);
  if (options.profile.lanInbound) throw new Error('the supabase shim binds loopback only — give it a profile without lanInbound');
  for (const [name, path] of [['scratchDir', options.scratchDir], ['evidenceDir', options.evidenceDir], ['repoRoot', options.repoRoot]] as const) {
    if (!path.startsWith('/')) throw new Error(`supabase shim ${name} must be absolute`);
  }
  if (existsSync(options.evidenceDir)) throw new Error(`supabase shim evidence folder ${options.evidenceDir} already exists (labels must be unique per lane)`);
  mkdirSync(options.evidenceDir, {recursive: true, mode: 0o700});
  const log = options.log ?? (() => {});
  const runId = `${options.runId}.${options.label}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  const argv = sandboxedArgv(options.profile, [process.execPath, '--env-file=/dev/null', join(options.repoRoot, SUPABASE_SHIM_SCRIPT),
    ...supabaseShimServeArgs({...options, runId})]);
  const stderrLog = join(options.scratchDir.replace(/\/+$/, ''), '..', `supabase-shim-${options.label}.stderr.log`);
  mkdirSync(join(stderrLog, '..'), {recursive: true, mode: 0o700});
  // 작업 폴더는 스크래치(.env가 있을 리 없는 곳) — --env-file=/dev/null과 함께 두 겹(CLAUDE.md 「에이전트 런타임 가드」).
  mkdirSync(options.scratchDir, {recursive: true, mode: 0o700});
  const child = Bun.spawn(argv, {cwd: options.scratchDir, env: options.env, stdin: 'ignore', stdout: 'pipe', stderr: Bun.file(stderrLog)});
  options.track?.(child);
  const eventsPath = join(options.evidenceDir, 'host-events.jsonl');
  const events: Array<Record<string, unknown>> = [];
  // 클로저가 바꾸는 값이라 객체에 담는다(TS가 null로 좁히지 않게).
  const listener: {onEvent: ((event: Record<string, unknown>) => void) | null} = {onEvent: null};
  // stdout은 끝까지 읽는다(아무도 안 읽으면 파이프가 차서 shim이 멈출 수 있다). 줄은 JSON 이벤트뿐이고 비밀이 없다.
  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, {stream: true});
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
        events.push(event);
        try { writeFileSync(eventsPath, `${JSON.stringify(event)}\n`, {flag: 'a', mode: 0o600}); } catch {}
        listener.onEvent?.(event);
      }
    }
  })().catch(() => undefined);
  let exit: {exitCode: number | null; signalCode: string | null} | null = null;
  const exited = child.exited.then(code => {
    exit = {exitCode: code, signalCode: child.signalCode ?? null};
    return exit;
  });
  const stderrTail = () => { try { return readFileSync(stderrLog, 'utf8').slice(-1_500); } catch { return ''; } };
  const readyTimeout = options.readyTimeoutMs ?? SUPABASE_SHIM_READY_TIMEOUT_MS;
  const stopTimeout = options.stopTimeoutMs ?? SUPABASE_SHIM_STOP_TIMEOUT_MS;

  let result: SupabaseShimStopped | null = null;
  let stopping: Promise<SupabaseShimStopped> | null = null;
  const stop = (): Promise<SupabaseShimStopped> => {
    if (result) return Promise.resolve(result);
    stopping ??= (async () => {
      let forced = false;
      if (!exit) {
        try { child.kill('SIGTERM'); } catch {}
        const done = await Promise.race([exited, Bun.sleep(stopTimeout).then(() => null)]);
        if (done === null) {
          forced = true;
          try { child.kill('SIGKILL'); } catch {}
          await exited;
        }
      }
      await Promise.race([pump, Bun.sleep(2_000)]);
      const final = exit as unknown as {exitCode: number | null; signalCode: string | null};
      result = {exitCode: final.exitCode, signalCode: final.signalCode, stopped: events.find(event => event.event === 'stopped') ?? null, forced};
      return result;
    })();
    return stopping;
  };

  const readyEvent = await new Promise<Record<string, unknown> | {failed: string}>(resolve => {
    const already = events.find(event => event.event === 'ready');
    if (already) { resolve(already); return; }
    const timer = setTimeout(() => resolve({failed: `no ready line within ${Math.round(readyTimeout / 1000)} s`}), readyTimeout);
    listener.onEvent = event => { if (event.event === 'ready') { clearTimeout(timer); resolve(event); } };
    void exited.then(code => { clearTimeout(timer); resolve({failed: `exited ${code ?? child.signalCode} before it was ready`}); });
  });
  listener.onEvent = null;
  if ('failed' in readyEvent) {
    await stop();
    throw new Error(`supabase shim ${options.label} did not start: ${readyEvent.failed}${stderrTail() ? ` — ${stderrTail()}` : ''}`);
  }
  let parsed: ReturnType<typeof parseShimReady>;
  try { parsed = parseShimReady(readyEvent); }
  catch (error) {
    await stop();
    throw new Error(`supabase shim ${options.label}: ${(error as Error).message}`);
  }
  if (parsed.ready.pid !== child.pid) {
    await stop();
    throw new Error(`supabase shim ${options.label}: ready came from pid ${parsed.ready.pid}, not the sandboxed child ${child.pid}`);
  }
  const {ready, loopbackPorts} = parsed;
  log(`supabase shim ${options.label}: pid ${child.pid} · ${[ready.httpUrl, ready.httpsUrl].filter(Boolean).join(' · ')} · isolation ${ready.isolation.status}${ready.httpsFallback ? ` · https fallback: ${ready.httpsFallback}` : ''}`);
  return {
    child,
    label: options.label,
    pid: child.pid,
    ready,
    loopbackPorts,
    evidenceDir: options.evidenceDir,
    credentials: () => JSON.parse(readFileSync(ready.credentialsPath, 'utf8')) as SupabaseShimCredentials,
    result: () => result,
    problems: () => shimProblems(ready, result),
    stop,
  };
}
