/**
 * J1-RELAY-WEB(WP5)의 휴대폰 쪽 준비물: 운영 포털 번들 빌드와 그 번들을 `https://portal.test`에서 서빙할 때 쓰는 순수 도우미.
 *
 * - 빌드는 오케스트레이터 안에서 vite를 import하지 않는다(포털 설정이 src/를 끌어온다). 별도 bun 자식으로 vite의 build()를
 *   부르고, 환경은 빈 객체에서 만든다(PATH·HOME·TMPDIR·VITE_* 둘). envDir은 빈 스크래치 폴더라 작업 트리의 .env를 읽지 않는다.
 *   - web 변형: `VITE_SUPABASE_URL` = shim https origin(https://localhost:<port>), `VITE_SUPABASE_ANON_KEY` = shim anon 키.
 *   - bundled 변형: VITE_* 없이 빌드한다(mobile/ios/scripts/build-portal-web.ts와 같다) — 런타임에 window.agentstozBundledPortal로 주입.
 * - 서빙은 Playwright route로만 한다(설계 §3·위험 16: loopback origin에서 서빙한 포털은 `/api/supabase-proxy`(→3001)로 갈 수 있다).
 *   그래서 포털 origin은 loopback이 아니어야 하고(`assertPortalOrigin`), 이 레인의 어떤 파일도 포털을 로컬 서버로 띄우지 않는다
 *   (tests/emulator-relay-web.test.ts가 정적으로 확인한다).
 * - 운영 CSP의 connect-src는 `https://*.supabase.co`만 허용한다. shim은 https://localhost:<port>라 그대로는 막힌다. 서빙하는 HTML의
 *   CSP에 **정확히 그 shim origin 하나만** 더한다(`widenPortalCsp`) — 나머지 CSP(script-src 해시 등)는 그대로 집행된다. 이것은
 *   대역이고 증거의 labels.standIn에 적는다. 원문 CSP를 찾지 못하면 실패다(포털 CSP가 바뀐 것을 조용히 넘기지 않는다).
 * - QR(pairing URL) 도우미: 프래그먼트를 풀고·다시 싸고·다른 Supabase로 바꾸고(음성 사례), 비밀 없이 요약한다. 프래그먼트(#pair=)는
 *   증거·로그에 절대 적지 않는다.
 */
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';

export const PORTAL_ORIGIN = 'https://portal.test';
export const PORTAL_REMOTE_PATH = '/remote/';
/** 운영 포털(remote/index.html·vercel.json)의 connect-src 원문. */
export const PRODUCTION_CONNECT_SRC = "connect-src 'self' https://*.supabase.co wss://*.supabase.co";
/** 음성 사례의 「다른 사용자 Supabase」. 운영 프로젝트가 아니라 존재하지 않는 픽스처 이름이다(route가 어차피 끊는다). */
export const FOREIGN_SUPABASE_ORIGIN = 'https://friend-project.supabase.co';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/** 포털 origin 규칙: https, 경로·포트 없음, loopback·IP 아님. */
export function assertPortalOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.port) throw new Error(`portal origin must be a bare https origin (got ${origin})`);
  if (LOOPBACK_HOSTS.has(url.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.endsWith('.localhost')) {
    throw new Error(`portal origin ${origin} is loopback — a loopback-served portal can route Supabase through /api/supabase-proxy (3001)`);
  }
  return origin;
}

/** shim https origin 규칙: `https://localhost:<port>` 정확히(포털 빌드·CSP·라우팅이 같은 값을 쓴다). */
export function assertShimOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.hostname !== 'localhost' || !url.port || url.origin !== origin) {
    throw new Error(`shim origin must be https://localhost:<port> (got ${origin})`);
  }
  return origin;
}

/**
 * 서빙하는 HTML(또는 CSP 헤더 값)의 connect-src에 shim origin 하나를 더한다. 원문이 없으면 widened:false(레인은 실패로 다룬다).
 * `socket`이면 iPhone 앱(PortalSchemeHandler·BundledPortalConfig.servedHTML)처럼 `wss://<host>`도 더한다.
 */
export function widenPortalCsp(html: string, shimOrigin: string, options: {socket?: boolean} = {}): {html: string; widened: boolean; occurrences: number} {
  assertShimOrigin(shimOrigin);
  const occurrences = html.split(PRODUCTION_CONNECT_SRC).length - 1;
  if (occurrences === 0) return {html, widened: false, occurrences};
  const addition = options.socket ? `${shimOrigin} wss://${new URL(shimOrigin).host}` : shimOrigin;
  return {html: html.split(PRODUCTION_CONNECT_SRC).join(`${PRODUCTION_CONNECT_SRC} ${addition}`), widened: true, occurrences};
}

// ───────────────────────── 응답 헤더 ─────────────────────────

export interface VercelHeaderRule {source: string; headers: Array<{key: string; value: string}>}

/**
 * vercel.json `source`(path-to-regexp) → RegExp. 이 저장소가 쓰는 모양(리터럴 경로와 `(.*)`)만 받는다 — 다른 문법(`:param`·`*`·
 * 다른 괄호 묶음)은 던진다. 모르는 규칙을 조용히 빼고 서빙하면 운영 헤더와 다른 페이지를 시험하게 된다.
 */
export function vercelSourceRegExp(source: string): RegExp {
  if (!source.startsWith('/')) throw new Error(`vercel.json header source must start with / (got ${source})`);
  const parts = source.split('(.*)');
  for (const part of parts) if (/[():*?+[\]{}]/.test(part)) throw new Error(`vercel.json header source ${source} uses syntax this fixture does not emulate`);
  return new RegExp(`^${parts.map(part => part.replace(/[.\\/^$|]/g, '\\$&')).join('.*')}$`);
}

/**
 * 그 경로에 Vercel이 붙이는 응답 헤더. 맞는 규칙을 **순서대로 모두** 적용하고 같은 키는 뒤 규칙이 이긴다(운영 계약 —
 * tests/remote-control-internet-hosting.test.ts가 「좁은 규칙을 뒤에 둔다」로 지킨다). 키 이름은 원문 그대로 돌려준다.
 */
export function vercelHeadersFor(config: {headers?: VercelHeaderRule[]}, pathname: string): Record<string, string> {
  const merged = new Map<string, {key: string; value: string}>();
  for (const rule of config.headers ?? []) {
    if (!vercelSourceRegExp(rule.source).test(pathname)) continue;
    for (const header of rule.headers) merged.set(header.key.toLowerCase(), {key: header.key, value: header.value});
  }
  return Object.fromEntries([...merged.values()].map(header => [header.key, header.value]));
}

export interface ServedHeaders {
  headers: Record<string, string>;
  /** CSP 헤더가 있었고 그 connect-src에 shim origin을 더했다. */
  cspHeaderWidened: boolean;
  /** CSP 헤더가 있었는데 운영 connect-src 원문이 없어 넓히지 못했다(포털 CSP가 바뀐 것 — 레인은 실패로 다룬다). */
  cspHeaderUnwidened: boolean;
}

/**
 * 휴대폰이 받는 응답 헤더.
 * - web: vercel.json이 그 경로에 붙이는 헤더 전부(CSP·COOP·CORP·X-Frame-Options·Referrer-Policy …). CSP connect-src에는 shim
 *   origin 하나만 더한다(대역). Cache-Control은 운영 값을 그대로 둔다(규칙이 없는 경로는 no-store).
 * - bundled: iPhone 앱의 PortalSchemeHandler와 같은 집합 — 모든 파일에 nosniff·Cache-Control, HTML에는 /remote/의 운영 CSP에
 *   QR의 Supabase(https + wss)를 더한 CSP와 Referrer-Policy no-referrer(앱이 실제로 그렇게 넓힌다 — 대역이 아니다).
 */
export function portalResponseHeaders(input: {
  variant: PortalVariant; pathname: string; contentType: string; shimOrigin: string; vercel: {headers?: VercelHeaderRule[]};
}): ServedHeaders {
  const html = input.contentType.startsWith('text/html');
  if (input.variant === 'web') {
    const headers = vercelHeadersFor(input.vercel, input.pathname);
    let cspHeaderWidened = false;
    let cspHeaderUnwidened = false;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== 'content-security-policy') continue;
      const widened = widenPortalCsp(headers[key]!, input.shimOrigin);
      headers[key] = widened.html;
      if (widened.widened) cspHeaderWidened = true; else cspHeaderUnwidened = true;
    }
    if (!Object.keys(headers).some(key => key.toLowerCase() === 'cache-control')) headers['Cache-Control'] = 'no-store';
    return {headers, cspHeaderWidened, cspHeaderUnwidened};
  }
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': html ? 'no-store' : 'max-age=31536000, immutable',
  };
  if (!html) return {headers, cspHeaderWidened: false, cspHeaderUnwidened: false};
  const remoteCsp = Object.entries(vercelHeadersFor(input.vercel, PORTAL_REMOTE_PATH)).find(([key]) => key.toLowerCase() === 'content-security-policy')?.[1] ?? '';
  const widened = widenPortalCsp(remoteCsp, input.shimOrigin, {socket: true});
  headers['Content-Security-Policy'] = widened.html;
  headers['Referrer-Policy'] = 'no-referrer';
  return {headers, cspHeaderWidened: widened.widened, cspHeaderUnwidened: !widened.widened};
}

/** 저장소의 vercel.json(운영 헤더 정본)을 읽는다. 없거나 headers가 없으면 던진다 — 헤더 없이 서빙하면 운영과 다르다. */
export function readVercelConfig(repoRoot: string): {headers: VercelHeaderRule[]} {
  const config = JSON.parse(readFileSync(join(repoRoot, 'vercel.json'), 'utf8')) as {headers?: VercelHeaderRule[]};
  if (!Array.isArray(config.headers) || !config.headers.length) throw new Error('vercel.json has no headers');
  for (const rule of config.headers) vercelSourceRegExp(rule.source);
  return {headers: config.headers};
}

/** Playwright route 판정(순수 함수): 포털 파일 · shim으로 통과 · 끊기. */
export type PhoneRequestRoute = {kind: 'portal'; path: string} | {kind: 'shim'} | {kind: 'abort'; origin: string};

export function classifyPhoneRequest(rawUrl: string, shimOrigin: string): PhoneRequestRoute {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return {kind: 'abort', origin: 'invalid'}; }
  if (url.origin === PORTAL_ORIGIN) return {kind: 'portal', path: url.pathname};
  if (url.origin === shimOrigin) return {kind: 'shim'};
  return {kind: 'abort', origin: url.protocol === 'data:' || url.protocol === 'blob:' ? url.protocol : url.origin};
}

/** 포털 경로 → dist 안의 파일(밖으로 나가면 null). `/remote/` → remote/index.html. */
export function portalFilePath(dist: string, pathname: string): string | null {
  const root = resolve(dist);
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const relative = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const candidate = resolve(root, `.${relative}`);
  return candidate.startsWith(root + sep) ? candidate : null;
}

export const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
});

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  return CONTENT_TYPES[dot >= 0 ? path.slice(dot) : ''] ?? 'application/octet-stream';
}

// ───────────────────────── QR(pairing URL) ─────────────────────────

export interface DecodedPairingUrl {
  /** 프래그먼트 앞(예: https://portal.test/remote/). */
  base: string;
  payload: Record<string, unknown>;
}

const FRAGMENT = /^#pair=([A-Za-z0-9_-]+)$/;

export function decodePairingUrl(pairingUrl: string): DecodedPairingUrl {
  const url = new URL(pairingUrl);
  const match = url.hash.match(FRAGMENT);
  if (!match) throw new Error('pairing URL has no #pair= fragment');
  const payload = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')) as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('pairing fragment is not a JSON object');
  url.hash = '';
  return {base: url.toString(), payload: payload as Record<string, unknown>};
}

export function encodePairingUrl(base: string, payload: Record<string, unknown>): string {
  const url = new URL(base);
  url.hash = `pair=${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  return url.toString();
}

/** 프래그먼트 앞에 query를 넣는다(기존 e2e의 `?tab=workroom` 모양). */
export function withPortalQuery(pairingUrl: string, query: string): string {
  const url = new URL(pairingUrl);
  url.search = query.startsWith('?') ? query : `?${query}`;
  return url.toString();
}

/** QR의 supabase.url만 바꾼다(음성 사례: 다른 사용자 Supabase). anonKey는 둔다. */
export function withForeignSupabase(pairingUrl: string, foreignOrigin: string = FOREIGN_SUPABASE_ORIGIN): string {
  const {base, payload} = decodePairingUrl(pairingUrl);
  const supabase = payload.supabase as Record<string, unknown> | undefined;
  if (!supabase || typeof supabase !== 'object') throw new Error('pairing has no supabase field to replace');
  return encodePairingUrl(base, {...payload, supabase: {...supabase, url: foreignOrigin}});
}

/** 증거용 요약 — 비밀(pairingSecret·키)을 담지 않는다. */
export interface PairingSummary {
  base: string;
  keys: string[];
  hasSupabase: boolean;
  supabaseUrl: string | null;
  supabaseUrlMatchesShim: boolean;
  anonKeyMatchesShim: boolean;
  expiresAt: string | null;
}

export function summarizePairing(pairingUrl: string, shim: {url: string; anonKey: string}): PairingSummary {
  const {base, payload} = decodePairingUrl(pairingUrl);
  const supabase = payload.supabase && typeof payload.supabase === 'object' ? payload.supabase as Record<string, unknown> : null;
  const supabaseUrl = typeof supabase?.url === 'string' ? supabase.url : null;
  return {
    base,
    keys: Object.keys(payload).sort(),
    hasSupabase: !!supabase,
    supabaseUrl,
    supabaseUrlMatchesShim: supabaseUrl !== null && supabaseUrl === new URL(shim.url).origin,
    anonKeyMatchesShim: typeof supabase?.anonKey === 'string' && supabase.anonKey === shim.anonKey,
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
  };
}

// ───────────────────────── 빌드 ─────────────────────────

export type PortalVariant = 'web' | 'bundled';

export interface PortalBuildInput {
  repoRoot: string;
  /** 빌드 결과(새로 만든다). 실행 스크래치 안. */
  outDir: string;
  /** 비어 있는 envDir과 HOME·TMPDIR로 쓸 스크래치 폴더. */
  workDir: string;
  variant: PortalVariant;
  /** web 변형만: shim https origin과 anon 키. */
  supabaseUrl?: string;
  anonKey?: string;
  /** bundled 변형만: 번들에 들어가면 안 되는 shim origin·anon 키(앱이 런타임에 주입해야 한다). */
  mustNotContain?: string[];
  timeoutMs?: number;
}

export interface PortalBuildResult {
  variant: PortalVariant;
  outDir: string;
  durationMs: number;
  files: number;
  /** web 변형: 번들 JS에 shim origin이 들어갔는가 · bundled 변형: 어떤 VITE Supabase 값도 들어가지 않았는가. */
  supabaseConfigAsExpected: boolean;
  logTail: string;
}

/** 자식 bun이 평가할 빌드 스크립트(값은 환경 변수로만 받는다 — 문자열에 끼워 넣지 않는다). */
export const PORTAL_BUILD_SCRIPT = [
  "const {build} = await import('vite');",
  'await build({',
  "  configFile: process.env.AGENTSTOZ_EMULATOR_PORTAL_CONFIG, configLoader: 'runner', root: process.env.AGENTSTOZ_EMULATOR_PORTAL_ROOT,",
  "  envDir: process.env.AGENTSTOZ_EMULATOR_PORTAL_ENV_DIR, mode: 'production', logLevel: 'warn',",
  '  build: {outDir: process.env.AGENTSTOZ_EMULATOR_PORTAL_OUT, emptyOutDir: true},',
  '});',
].join('\n');

export function portalBuildEnv(input: PortalBuildInput, envDir: string): Record<string, string> {
  const home = join(input.workDir, 'home');
  const tmp = join(input.workDir, 'tmp');
  if (input.variant === 'web') {
    if (!input.supabaseUrl || !input.anonKey) throw new Error('the web portal variant needs the shim https origin and anon key');
    assertShimOrigin(input.supabaseUrl);
  } else if (input.supabaseUrl || input.anonKey) {
    throw new Error('the bundled portal variant is built without VITE_SUPABASE_* (the app injects them at runtime)');
  }
  return {
    PATH: '/usr/bin:/bin',
    HOME: home,
    TMPDIR: `${tmp}/`,
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    VITE_SUPABASE_URL: input.variant === 'web' ? input.supabaseUrl! : '',
    VITE_SUPABASE_ANON_KEY: input.variant === 'web' ? input.anonKey! : '',
    AGENTSTOZ_EMULATOR_PORTAL_CONFIG: join(input.repoRoot, 'vite.portal.config.ts'),
    AGENTSTOZ_EMULATOR_PORTAL_ROOT: input.repoRoot,
    AGENTSTOZ_EMULATOR_PORTAL_ENV_DIR: envDir,
    AGENTSTOZ_EMULATOR_PORTAL_OUT: input.outDir,
  };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out;
}

export async function buildPortalFixture(input: PortalBuildInput): Promise<PortalBuildResult> {
  const envDir = join(input.workDir, 'empty-env');
  for (const dir of [envDir, join(input.workDir, 'home'), join(input.workDir, 'tmp')]) mkdirSync(dir, {recursive: true, mode: 0o700});
  if (readdirSync(envDir).length) throw new Error(`portal envDir ${envDir} must be empty`);
  const env = portalBuildEnv(input, envDir);
  const logPath = join(input.workDir, `vite-${input.variant}.log`);
  const t0 = performance.now();
  const child = Bun.spawn([process.execPath, '--env-file=/dev/null', '-e', PORTAL_BUILD_SCRIPT], {
    cwd: input.repoRoot, env, stdout: Bun.file(logPath), stderr: 'pipe',
  });
  const timeoutMs = input.timeoutMs ?? 300_000;
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
  const stderrText = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  clearTimeout(timer);
  const durationMs = Math.round(performance.now() - t0);
  const logTail = `${existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''}${stderrText}`.slice(-2_000);
  if (exitCode !== 0) throw new Error(`portal ${input.variant} build failed (exit ${exitCode}, ${durationMs} ms): ${logTail}`);
  const remoteHtml = join(input.outDir, 'remote', 'index.html');
  if (!existsSync(remoteHtml)) throw new Error(`portal ${input.variant} build has no remote/index.html`);
  const files = listFiles(input.outDir);
  const scripts = files.filter(path => path.endsWith('.js')).map(path => readFileSync(path, 'utf8'));
  const supabaseConfigAsExpected = input.variant === 'web'
    ? scripts.some(text => text.includes(input.supabaseUrl!))
    // 번들에는 라이브러리의 무관한 localhost 문자열이 있다(실측: https://localhost:3000) — 이 실행의 값만 본다.
    : (input.mustNotContain ?? []).length > 0 && !scripts.some(text => input.mustNotContain!.some(value => value && text.includes(value)));
  return {variant: input.variant, outDir: input.outDir, durationMs, files: files.length, supabaseConfigAsExpected, logTail};
}

/** 사유·로그에 실릴 수 있는 문자열에서 QR 프래그먼트를 가린다(index.json은 #pair=를 담으면 쓰지 않는다). */
export function redactPairingText(text: string): string {
  return text.replace(/#pair=[A-Za-z0-9_-]+/g, '#pair=<redacted>');
}
