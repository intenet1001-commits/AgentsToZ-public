/**
 * J1-RELAY-WEB(WP5, 무인): 운영 포털 번들(Playwright WebKit 402×874, https://portal.test) ↔ https PGlite shim ↔ 샌드박스 격리
 * 사이드카(실제 api-server.ts, 인터넷 릴레이 호스트). 설계 docs/design/emulator-e2e-2026-11-01/DESIGN.md §3 J1-RELAY-WEB.
 *
 * 여정(양 끝을 함께 단언한다 — 휴대폰 화면과 호스트 영수증):
 *   1. shim(https) → 포털 빌드 2벌(web: VITE_* = shim · bundled: VITE_* 없음) → 픽스처 호스트(포트 프로젝트 alpha, 폴더 프로젝트 beta,
 *      portal.json = shim https origin + anon 키, supabase-service.json = service 키, 가짜 AI CLI) → 사이드카.
 *   2. 호스트 관리 API로 인터넷 원격을 켠다 → QR에 `supabase`(shim origin·anon 키)가 있어야 한다(운영 경로).
 *   3. 휴대폰: QR을 열고 이메일 코드로 로그인(shim GoTrue) → 휴대폰 SAS == 호스트 SAS → Mac 승인은 관리 API로 스크립트
 *      (영수증 scriptedApproval:true) → 「연결됨」.
 *   4. 프로젝트 alpha 시작·정지: 휴대폰 카드 버튼 ↔ 호스트 영수증(픽스처 서버의 기동 기록·LISTEN 소켓).
 *   5. 워크룸: Mac 쪽 허용은 관리 API로 스크립트(scriptedApproval:true) → 휴대폰 「새 작업」(beta · 가짜 CLI) → 입력 왕복 ↔ 가짜
 *      CLI 기록(입력이 정확히 한 번).
 *   6. 음성 사례: 로그인된 기기에 다른 Supabase를 담은 QR → 거절 화면, shim 요청 0건(claim RPC 0건).
 *   7. 재시작 뒤 재개: 사이드카를 멈추고 같은 앱 데이터로 다시 띄운다 → 같은 세션이 승인 상태로 복원 → QR 없이 alpha 시작·정지가
 *      다시 왕복(재시작 뒤에도 claim 추가 0). 휴대폰 표시는 5초 정지 동안 「연결됨」에서 바뀌지 않는다(실측) — 그래서 「연결됨」은
 *      재개의 증거가 아니고, 증거는 왕복·claim 0·릴레이 순번 건너뛰기다.
 *   8. 번들 포털 변형 한 번: window.agentstozBundledPortal 주입, 새 QR을 **그대로**(앱의 pageURL처럼 `?tab=` 없이) 연다 → 홈 →
 *      「원격 작업」 탭 → 로그인 → SAS 일치 → 승인 → 「연결됨」 → 프로젝트 목록.
 *   9. 정리 뒤: 남은 픽스처 서버 정리(호스트는 종료할 때 프로젝트 서버를 멈추지 않는다) · shim 보고서(모르는 경로 0·거절 origin 0·
 *      claim RPC = 휴대폰 claim 수) · relay-db.json 순번 감사(재사용 0, 단조 증가, 복원 세션의 호스트 순번이 재시작에서
 *      RELAY_RESTART_MIN_SKIP 이상 건너뜀) · 휴대폰(끊긴 origin 0, 메타·헤더 CSP를 넓혔음, 페이지 오류 0) · 카드 따라오기(허용 밖 탭 0).
 *
 * 레인은 src/ 호스트 코드를 import하지 않는다. QR 프래그먼트(#pair=)는 증거·로그·사유에 적지 않는다.
 * 대역은 labels.standIn에 적는다(아래 STAND_IN_LABELS). 막힘·건너뜀은 통과가 아니다.
 */
import {existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {LaneContext, LaneDefinition} from '../emulator-e2e';
import type {LaneOutcome, PathLabels} from './evidence';
import {isolatedRoot, listenerOwnedBy, managementRequest, readSideEffectLog, reserveLoopbackPort, writeSidecarFixtures, type RunningSidecar} from './isolatedSidecar';
import {
  FOREIGN_SUPABASE_ORIGIN,
  PORTAL_ORIGIN,
  PORTAL_REMOTE_PATH,
  assertShimOrigin,
  buildPortalFixture,
  readVercelConfig,
  redactPairingText,
  summarizePairing,
  withForeignSupabase,
  withPortalQuery,
  type PortalBuildResult,
} from './portalFixtureBuild';
import {Phone, PhoneBlockedError, launchPhoneBrowser, type PhoneBrowser} from './relayWebPhone';
import type {RunningSupabaseShim} from './supabaseShimHost';

export const LANE_ID = 'j1-relay-web' as const;
export const CLAIM_RPC = 'portmgr_remote_control_claim_pairing';
export const PROJECT_ALPHA = 'relay-alpha';
export const PROJECT_BETA = 'relay-beta';
export const WORKROOM_AGENT = 'claude';
/**
 * alpha의 실행 명령. 절대 경로로 시작하면 호스트의 /api/execute-command가 「.command 파일 경로」로 보고 그 문자열 전체를
 * 파일로 찾다가 400을 낸다(실측: 휴대폰에 ACTION_NOT_AVAILABLE). 그래서 PATH 기준 `bun`이다(격리 PATH의 bin에 bun이 있다).
 */
export const ALPHA_TERMINAL_COMMAND = 'bun server.ts';
/** 가짜 AI CLI를 둘 이름 — 하나라도 빠지면 호스트가 /opt/homebrew/bin 등 실제 CLI를 찾을 수 있다. */
export const FAKE_AGENT_NAMES = Object.freeze(['claude', 'codex', 'hermes', 'agy']);

export const REAL_LABELS: readonly string[] = Object.freeze([
  'production portal bundle (vite.portal.config.ts, remote/index.html) in Playwright WebKit 402x874',
  'phone ↔ shim: the browser itself calls the shim (route.continue) for GoTrue email-code login and relay RPCs',
  'Mac host = sandboxed isolated source sidecar (api-server.ts) with its real internet relay agent and E2EE pairing/claim/SAS',
  'relay database = canonical relay schema (src/schemaSql.ts) with RLS/grants on PGlite',
  'project start/stop through the registered-project gateway (fixture server bound on loopback, observed with lsof)',
  'workroom PTY through the host AiTerminalService (fake CLI behind it)',
  'host restart = new sidecar process on the same app data (relay vault restore); the host’s first sequence after it skips ≥ 1024 (relay audit)',
  'bundled phone: opens the QR as scanned (no query, like the app’s pageURL) and gets the app’s CSP widening (QR Supabase https + wss)',
]);

export const STAND_IN_LABELS: readonly string[] = Object.freeze([
  'Supabase → PGlite shim at https://localhost:<port> with a per-run fixture CA (WebKit ignoreHTTPSErrors; host NODE_EXTRA_CA_CERTS)',
  'portal origin https://portal.test served by a Playwright route (not Vercel) with the response headers vercel.json gives each path (CSP, COOP, CORP, X-Frame-Options, Referrer-Policy …)',
  'web variant: CSP connect-src (meta and header) widened by exactly the shim origin (production allows only *.supabase.co)',
  'Mac-side SAS approval and workroom grant scripted through the fixture host management API (scriptedApproval:true)',
  'email inbox → the shim’s fixed per-run OTP code',
  'AI CLI → fake shell CLI that echoes input',
  'iOS Safari / app WKWebView → desktop Playwright WebKit',
  'Playwright WebKit runs with the real HOME (design §2.2 asks for a scratch HOME; WebKit’s WebContent sandbox hangs the page under one — measured 2026-11-01); ephemeral context, run-scratch TMPDIR, 4-key env',
  'web and foreign-QR phones open the QR with `?tab=workroom` added (a camera scan has no query); the bundled phone opens its QR unmodified, lands on 홈 (no sign-in shown there) and taps 원격 작업 like a person',
  'bundled portal variant served at https://portal.test instead of agentstoz-app://portal, with the app’s PortalSchemeHandler headers and an injected supabaseUrl that has a port (the app’s BundledPortalConfig accepts only port-less https; 127.0.0.1:443 is not bindable here)',
  'PATH-relative `ps` in the host → empty stub in $HOME/.local/bin (setuid /bin/ps is refused inside sandbox-exec: EPERM)',
]);

/**
 * 재시작 뒤 호스트의 첫 순번이 건너뛰어야 하는 최소 폭. 정본은 src/remoteControlInternetAgent.ts의
 * REMOTE_CONTROL_SEND_SEQUENCE_RECOVERY_GAP(복원한 세션은 저장한 순번 + 1024에서 시작한다, write-ahead라 저장값 ≥ 마지막으로 보낸 값).
 * 레인은 src/를 import하지 않으므로 값을 옮겨 적고, 단위 시험이 원문과 같은지 본다.
 */
export const RELAY_RESTART_MIN_SKIP = 1024;

/**
 * 알려진 제품 문제(이 레인이 처음 관측, 2026-11-01): 「실행」에 대한 호스트의 답은 서버가 포트를 열기 전의 카드다(remoteControlCore
 * `#refreshProjectCards`가 동작 직후에 읽는다). 그래서 카드가 스스로 「실행 중」으로 따라오지 않고 사람이 「새로고침」을 한 번 눌러야 한다.
 * 레인은 그 탭을 허용하되 이 이름으로 결과(details.knownIssues·labels.standIn)에 올린다. 다른 전환에서 탭이 필요하거나 허용보다 많으면 실패다.
 */
export const KNOWN_CARD_FOLLOW_ISSUE = 'card-does-not-follow-start';
export type CardTransition = 'before' | 'start' | 'stop';
/** 전환마다 허용하는 「새로고침」 탭 수. start만 알려진 문제로 1번까지. */
export const CARD_FOLLOW_TAP_ALLOWANCE: Readonly<Record<CardTransition, number>> = Object.freeze({before: 0, start: 1, stop: 0});
/** 카드 하나가 따라오기를 기다리는 시도 수(눌렀든 못 눌렀든 센다 — 휴대폰이 오프라인이면 버튼이 없어 탭이 늘지 않는다). */
export const CARD_FOLLOW_MAX_ATTEMPTS = 3;
/** 카드 하나를 기다리는 전체 한도 — 이 안에 끝나지 않으면 실패다(레인이 멈추지 않는다). */
export const CARD_FOLLOW_DEADLINE_MS = 150_000;

/**
 * 호스트 샌드박스 안에서는 setuid인 /bin/ps를 실행할 수 없다(EPERM). api-server의 runningHermesDesktops가 PATH 기준 `ps`를
 * try 없이 spawnSync해서, 그 예외가 원격 프로젝트 목록 전체를 GATEWAY_UNAVAILABLE로 만들었다(실측 2026-11-01). 격리 PATH의
 * $HOME/.local/bin에 빈 출력 `ps`를 둔다 — 「실행 중인 Hermes 데스크톱 없음」(격리 세계에서 사실)이다. 절대 경로 /bin/ps를
 * 부르는 다른 호출에는 영향이 없다. 대역이고 labels.standIn에 적는다.
 */
export const SANDBOX_PS_STUB = '#!/bin/sh\n# emulator stand-in: /bin/ps is setuid and cannot run inside sandbox-exec\nexit 0\n';

// ───────────────────────── 순수 판정(단위 시험) ─────────────────────────

export interface RelayAuditRow {
  relay_seq: number | string;
  session_id: string;
  direction: string;
  sender_sequence: number | string;
  created_at: string;
}

export interface RelaySequenceAudit {
  rows: number;
  /** 같은 (세션, 방향)에서 같은 sender_sequence가 두 번 이상(재사용). */
  reused: number;
  /** relay_seq 순서로 봤을 때 sender_sequence가 줄거나 같은 경우(재사용 포함). */
  nonMonotonic: number;
  relaySeqDuplicates: number;
  groups: Array<{session: string; direction: string; count: number; min: number; max: number; jumpAcrossRestart: number | null}>;
}

export interface SideEffectSummary {count: number; guardInstalled: number; byCommand: Record<string, number>; refused: string[]}

/**
 * 사이드카 관측 기록(tests/fixtures/side-effect-guard-entry.ts의 JSONL — 실행 파일 이름·결과만, 인자 없음)을 요약한다.
 * `refused-by-wrapper`는 호스트가 사람의 데스크톱을 건드리는 실행을 **시도했다**는 뜻이라 따로 모은다.
 */
export function summarizeSideEffects(entries: ReadonlyArray<Record<string, unknown>>): SideEffectSummary {
  const byCommand: Record<string, number> = {};
  const refused: string[] = [];
  let guardInstalled = 0;
  for (const entry of entries) {
    // 관측 래퍼가 사이드카 기동마다 남기는 「설치됨」 표식 — 실행이 아니다.
    if (entry.api === 'guard' && entry.outcome === 'installed') { guardInstalled += 1; continue; }
    const command = typeof entry.command === 'string' && entry.command ? entry.command : '(unknown)';
    const outcome = typeof entry.outcome === 'string' && entry.outcome ? entry.outcome : '(unknown)';
    const key = `${command}:${outcome}`;
    byCommand[key] = (byCommand[key] ?? 0) + 1;
    if (outcome === 'refused-by-wrapper') refused.push(`${command} via ${typeof entry.api === 'string' ? entry.api : '?'}`);
  }
  return {count: entries.length - guardInstalled, guardInstalled, byCommand, refused};
}

/**
 * relay-db.json의 audit.relay_messages를 감사한다. `restartAt`(ISO)이 있으면 그 시각 전후의 첫 순번 차이(재시작 건너뛰기)를 적는다.
 * 세션 id는 증거에 실리는 값이라 앞 8자만 쓴다.
 */
export function auditRelaySequences(rows: readonly RelayAuditRow[], restartAt: string | null = null): RelaySequenceAudit {
  const sorted = [...rows].sort((a, b) => Number(a.relay_seq) - Number(b.relay_seq));
  const relaySeqs = new Set<number>();
  let relaySeqDuplicates = 0;
  for (const row of sorted) {
    const seq = Number(row.relay_seq);
    if (relaySeqs.has(seq)) relaySeqDuplicates += 1;
    relaySeqs.add(seq);
  }
  const byGroup = new Map<string, RelayAuditRow[]>();
  for (const row of sorted) {
    const key = `${row.session_id}\u0000${row.direction}`;
    const list = byGroup.get(key) ?? [];
    list.push(row);
    byGroup.set(key, list);
  }
  let reused = 0;
  let nonMonotonic = 0;
  const restartMs = restartAt ? Date.parse(restartAt) : NaN;
  const groups: RelaySequenceAudit['groups'] = [];
  for (const [key, list] of byGroup) {
    const [session, direction] = key.split('\u0000') as [string, string];
    const seen = new Set<number>();
    let previous = -Infinity;
    let lastBefore: number | null = null;
    let firstAfter: number | null = null;
    for (const row of list) {
      const value = Number(row.sender_sequence);
      if (seen.has(value)) reused += 1;
      seen.add(value);
      if (!(value > previous)) nonMonotonic += 1;
      previous = value;
      if (Number.isFinite(restartMs)) {
        const at = Date.parse(row.created_at);
        if (at < restartMs) lastBefore = value;
        else if (firstAfter === null) firstAfter = value;
      }
    }
    const values = list.map(row => Number(row.sender_sequence));
    groups.push({
      session: session.slice(0, 8), direction, count: list.length, min: Math.min(...values), max: Math.max(...values),
      jumpAcrossRestart: lastBefore !== null && firstAfter !== null ? firstAfter - lastBefore : null,
    });
  }
  return {rows: rows.length, reused, nonMonotonic, relaySeqDuplicates, groups};
}

export interface ShimReportJudgement {
  problems: string[];
  claimCalls: number;
  claimOk: number;
  unknownRoutes: number;
  rejectedOrigins: number;
}

/** shim 보고서 판정: 모르는 경로·거절 origin 0, claim RPC 호출 = 기대한 휴대폰 claim 수(모두 성공). */
export function judgeShimReport(report: {unknownRoutes?: unknown[]; rejectedOrigins?: unknown[]; rpcCalls?: Record<string, Record<string, number>>; ok?: boolean}, expectedClaims: number): ShimReportJudgement {
  const problems: string[] = [];
  const unknownRoutes = Array.isArray(report.unknownRoutes) ? report.unknownRoutes.length : -1;
  const rejectedOrigins = Array.isArray(report.rejectedOrigins) ? report.rejectedOrigins.length : -1;
  if (unknownRoutes !== 0) problems.push(`shim unknown routes ${unknownRoutes}`);
  if (rejectedOrigins !== 0) problems.push(`shim rejected origins ${rejectedOrigins}`);
  const buckets = report.rpcCalls?.[CLAIM_RPC] ?? {};
  const claimCalls = Object.values(buckets).reduce((sum, count) => sum + count, 0);
  const claimOk = Object.entries(buckets).filter(([key]) => /:2\d\d$/.test(key)).reduce((sum, [, count]) => sum + count, 0);
  if (claimCalls !== expectedClaims) problems.push(`claim RPC calls ${claimCalls} ≠ expected ${expectedClaims} (one per phone that paired; the foreign QR must add 0)`);
  if (claimOk !== expectedClaims) problems.push(`successful claim RPC calls ${claimOk} ≠ expected ${expectedClaims}`);
  if (report.ok === false && !problems.length) problems.push('shim report ok=false');
  return {problems, claimCalls, claimOk, unknownRoutes, rejectedOrigins};
}

/**
 * 재시작 건너뛰기 판정(설계 §2.7 · CLAUDE.md 「보낸 릴레이 순번은 다시 쓰지 않는다」): 복원된 세션의 host_to_controller 묶음에서
 * 재시작 전 마지막 순번과 뒤 첫 순번의 차이가 RELAY_RESTART_MIN_SKIP 이상이어야 한다. 묶음이 없거나 재시작 양쪽에 메시지가 없으면
 * (null) 그것도 실패다 — 재개를 증명하지 못한 것이다.
 */
export function judgeRestartSkip(audit: RelaySequenceAudit, sessionPrefix: string): {problems: string[]; jump: number | null} {
  const group = audit.groups.find(entry => entry.session === sessionPrefix.slice(0, 8) && entry.direction === 'host_to_controller');
  if (!group) return {problems: [`relay audit has no host_to_controller messages for the restored session ${sessionPrefix.slice(0, 8)}`], jump: null};
  if (group.jumpAcrossRestart === null) return {problems: [`the restored session ${group.session} has no host message on both sides of the restart (cannot see the sequence skip)`], jump: null};
  if (group.jumpAcrossRestart < RELAY_RESTART_MIN_SKIP) {
    return {problems: [`host sequence across the restart jumped by ${group.jumpAcrossRestart}, expected ≥ ${RELAY_RESTART_MIN_SKIP} (write-ahead + restart skip)`], jump: group.jumpAcrossRestart};
  }
  return {problems: [], jump: group.jumpAcrossRestart};
}

/**
 * 카드 하나가 호스트를 따라오기를 기다린다: 먼저 스스로 따라오는지 보고(15초), 아니면 「새로고침」을 눌러 본다. 시도 수는 **눌렀든 못
 * 눌렀든** 센다 — 버튼은 휴대폰이 online이고 바쁘지 않을 때만 있어서(remote-control-portal-main.tsx `remote-refresh`), 탭 수로 세면
 * 호스트가 죽거나 휴대폰이 오프라인일 때 끝나지 않았다(검토 #1). 전체 한도도 있다. 휴대폰 경고는 checkAlert가 바로 던진다.
 */
export async function followCard(probes: {
  waitEnabled: (timeoutMs: number) => Promise<boolean>;
  tapRefresh: (timeoutMs: number) => Promise<boolean>;
  checkAlert: () => Promise<void>;
}, limits: {maxAttempts?: number; deadlineMs?: number; firstWaitMs?: number; waitMs?: number; now?: () => number} = {}): Promise<{followed: boolean; refreshTaps: number; attempts: number}> {
  const now = limits.now ?? Date.now;
  const deadline = now() + (limits.deadlineMs ?? CARD_FOLLOW_DEADLINE_MS);
  const maxAttempts = limits.maxAttempts ?? CARD_FOLLOW_MAX_ATTEMPTS;
  const remaining = (cap: number) => Math.max(1_000, Math.min(cap, deadline - now()));
  let refreshTaps = 0;
  let attempts = 0;
  let followed = await probes.waitEnabled(remaining(limits.firstWaitMs ?? 15_000));
  while (!followed && attempts < maxAttempts && now() < deadline) {
    attempts += 1;
    await probes.checkAlert();
    if (await probes.tapRefresh(remaining(limits.waitMs ?? 30_000))) refreshTaps += 1;
    followed = await probes.waitEnabled(remaining(limits.waitMs ?? 30_000));
  }
  return {followed, refreshTaps, attempts};
}

export interface CardFollowEntry {step: string; transition: CardTransition; refreshTaps: number; attempts?: number; followed: boolean; status?: string}

export interface CardFollowJudgement {
  problems: string[];
  /** 허용 안에서 탭이 필요했던 단계 — 알려진 문제로 결과에 올린다. 없으면 null. */
  knownIssue: {id: string; summary: string; occurrences: Array<{step: string; taps: number}>} | null;
}

/** 휴대폰 카드가 호스트를 따라왔는가: 전환별 허용 탭 수를 넘으면 실패, 허용 안의 탭은 알려진 문제로 이름을 붙여 올린다. */
export function judgeCardFollow(entries: readonly CardFollowEntry[]): CardFollowJudgement {
  const problems: string[] = [];
  const occurrences: Array<{step: string; taps: number}> = [];
  for (const entry of entries) {
    const allowed = CARD_FOLLOW_TAP_ALLOWANCE[entry.transition];
    if (!entry.followed) { problems.push(`${entry.step}: the phone card never followed the host`); continue; }
    if (entry.refreshTaps > allowed) problems.push(`${entry.step}: the phone card followed the host only after ${entry.refreshTaps} 새로고침 tap(s), allowed ${allowed}`);
    else if (entry.refreshTaps > 0) occurrences.push({step: entry.step, taps: entry.refreshTaps});
  }
  return {
    problems,
    knownIssue: occurrences.length ? {
      id: KNOWN_CARD_FOLLOW_ISSUE,
      summary: 'after 실행 the host answers with the card captured before the server bound its port; the card did not turn 실행 중 by itself and needed one 새로고침 tap',
      occurrences,
    } : null,
  };
}

export interface PhoneJudgementInput {
  label: string;
  aborted: readonly string[];
  csp: {widened: number; headerWidened: number; missing: number};
  /** 이 휴대폰이 /remote/ 문서를 받았는가. */
  loadedRemote: boolean;
  pageErrors: readonly string[];
}

/**
 * 휴대폰 사후 판정: 포털·shim 밖으로 나가려던 요청(끊긴 origin — 3001·*.supabase.co 포함)이 하나라도 있으면 실패, /remote/를 연
 * 휴대폰은 메타 CSP와 CSP 헤더를 둘 다 넓혔어야 하고, 넓히지 못한 문서·헤더(missing)가 있으면 실패, 페이지 오류도 실패다.
 */
export function judgePhones(phones: readonly PhoneJudgementInput[]): string[] {
  const problems: string[] = [];
  for (const phone of phones) {
    if (phone.aborted.length) problems.push(`${phone.label}: requests left the portal and the shim (cut by the route): ${phone.aborted.slice(0, 5).join(', ')}`);
    if (phone.csp.missing) problems.push(`${phone.label}: ${phone.csp.missing} HTML document(s)/CSP header(s) without the production connect-src (portal CSP changed or missing?)`);
    if (phone.loadedRemote && phone.csp.widened < 1) problems.push(`${phone.label}: loaded /remote/ but no meta CSP was found to widen`);
    if (phone.loadedRemote && phone.csp.headerWidened < 1) problems.push(`${phone.label}: loaded /remote/ but no CSP response header was served`);
    if (phone.pageErrors.length) problems.push(`${phone.label}: page errors: ${phone.pageErrors.slice(0, 3).join(' | ')}`);
  }
  return problems;
}

/** 픽스처 서버 기동 기록(`<iso> pid=<n> port=<n>`)의 pid들. */
export function parseStartedPids(text: string): number[] {
  return text.split('\n').map(line => /\bpid=(\d+)\b/.exec(line)?.[1]).filter((value): value is string => !!value).map(Number).filter(pid => pid > 1);
}

/**
 * 휴대폰 브라우저(WebKit) 환경. 호스트가 아니라 시험 도구라 허용 목록 환경 대신 이 네 키만 준다. HOME만은 실제 값이다:
 * Playwright WebKit은 ~/Library/Caches/ms-playwright에 있고 WebKit의 WebContent 샌드박스가 HOME 기준으로 허용 경로를 잡아서,
 * 스크래치 HOME(실행 스크래치·실제 홈 아래 새 폴더 모두)이면 페이지가 멈춘다(실측 2026-11-01: body 읽기·스크린샷 시간 초과).
 * context는 임시(ephemeral)라 프로필을 남기지 않는다. TMPDIR은 이 실행의 스크래치다.
 */
export function phoneBrowserEnv(realHomeDir: string, scratchTmp: string): Record<string, string> {
  return {HOME: realHomeDir, TMPDIR: `${scratchTmp.replace(/\/+$/, '')}/`, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'ko_KR.UTF-8'};
}

/** 픽스처 서버(포트 프로젝트 alpha). 기동마다 한 줄을 남기고 loopback에만 묶는다. */
export function fixtureServerSource(startsFile: string, port: number): string {
  return [
    "import {appendFileSync} from 'node:fs';",
    `const port = Number(process.env.PORT) || ${port};`,
    `appendFileSync(${JSON.stringify(startsFile)}, \`\${new Date().toISOString()} pid=\${process.pid} port=\${port}\\n\`);`,
    "Bun.serve({hostname: '127.0.0.1', port, fetch: () => new Response('relay-alpha fixture')});",
    '',
  ].join('\n');
}

/** 가짜 AI CLI: 준비 줄을 찍고, 받은 줄을 기록 파일에 남기고 되돌려 준다. */
export function fakeAgentCliSource(transcript: string, agent: string): string {
  return [
    '#!/bin/sh',
    'stty -echo 2>/dev/null',
    `printf 'START ${agent} %s\\n' "$$" >> '${transcript.replace(/'/g, "'\\''")}'`,
    'printf "REMOTE_READY\\n"',
    `while IFS= read -r line; do printf 'INPUT:%s\\n' "$line" >> '${transcript.replace(/'/g, "'\\''")}'; printf "RESULT:%s\\n" "$line"; done`,
    '',
  ].join('\n');
}

// ───────────────────────── 레인 ─────────────────────────

interface Step {name: string; ok: boolean; ms: number; detail?: unknown; error?: string}

class StepFailure extends Error {}
/** 기다릴 필요가 없는 실패(휴대폰이 이미 오류를 보였다) — until이 다시 시도하지 않고 바로 올린다. */
class SettledFailure extends StepFailure {}
class StepBlocked extends Error {}

function lineCount(path: string, needle?: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').filter(line => line && (!needle || line.includes(needle))).length;
}

const LSOF_ENV = {PATH: '/usr/bin:/bin:/usr/sbin'};

/** 그 포트의 LISTEN 소켓을 가진 pid들(관측: lsof). */
function listenerPids(port: number): number[] {
  const out = Bun.spawnSync(['/usr/sbin/lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {stdout: 'pipe', stderr: 'ignore', env: LSOF_ENV});
  return [...new Set(out.stdout.toString().split('\n').map(line => Number(line.trim())).filter(pid => Number.isInteger(pid) && pid > 1))];
}

/** 픽스처 서버의 마지막 기동 pid(기동 기록의 마지막 줄). 없으면 null. */
function latestStartedPid(startsFile: string): number | null {
  if (!existsSync(startsFile)) return null;
  return parseStartedPids(readFileSync(startsFile, 'utf8')).at(-1) ?? null;
}

/**
 * 이 실행이 띄운 픽스처 서버(기동 기록의 마지막 pid)가 그 포트에서 듣고 있는가 — 「어느 pid든」이 아니다. 포트는 예약한 뒤 놓았다가
 * 몇 분 뒤에야 묶이므로 그 사이 다른 프로세스가 잡으면 시작·정지 판정을 속일 수 있다(검토 #8).
 */
function fixtureListening(startsFile: string, port: number): {listening: boolean; pid: number | null; listeners: number[]} {
  const pid = latestStartedPid(startsFile);
  const listeners = listenerPids(port);
  return {listening: pid !== null && listenerOwnedBy(pid, port), pid, listeners};
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** 그 pid의 현재 작업 폴더(lsof -d cwd). 모르면 null. */
function pidCwd(pid: number): string | null {
  const out = Bun.spawnSync(['/usr/sbin/lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {stdout: 'pipe', stderr: 'ignore', env: LSOF_ENV}).stdout.toString();
  return out.split('\n').find(line => line.startsWith('n'))?.slice(1) ?? null;
}

/**
 * 정리: 호스트는 /api/execute-command로 띄운 프로젝트 서버를 종료할 때 함께 멈추지 않는다(api-server.ts의 executableProcesses는
 * 종료 정리가 없다). 그래서 「실행」과 성공한 「중지」 사이에서 레인이 실패하면 사이드카를 멈춘 뒤에도 서버가 사람의 Mac에서
 * 127.0.0.1:<port>를 듣고 있다. 기동 기록의 pid마다 **이 실행의 것임을 확인한 뒤에만**(그 포트의 리스너이거나 작업 폴더가 alpha
 * 폴더) SIGTERM → 3초 → SIGKILL. 남긴 것은 증거에 적는다.
 */
export async function reapFixtureServers(startsFile: string, port: number, alphaDir: string): Promise<{started: number[]; killed: number[]; stillAlive: number[]; skipped: number[]}> {
  const started = existsSync(startsFile) ? parseStartedPids(readFileSync(startsFile, 'utf8')) : [];
  let realAlpha = alphaDir;
  try { realAlpha = realpathSync(alphaDir); } catch {}
  const listeners = listenerPids(port);
  const ours = started.filter(pid => pidAlive(pid) && (listeners.includes(pid) || [alphaDir, realAlpha].includes(pidCwd(pid) ?? '')));
  const skipped = started.filter(pid => pidAlive(pid) && !ours.includes(pid));
  for (const pid of ours) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && ours.some(pidAlive)) await Bun.sleep(100);
  for (const pid of ours.filter(pidAlive)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await Bun.sleep(200);
  return {started, killed: ours, stillAlive: ours.filter(pidAlive), skipped};
}

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value as T;
    } catch (error) {
      if (error instanceof SettledFailure) throw error;
      last = error;
    }
    await Bun.sleep(intervalMs);
  }
  throw new StepFailure(`${what}: not within ${Math.round(timeoutMs / 1000)}s${last ? ` (last error: ${(last as Error).message})` : ''}`);
}

/** 휴대폰이 경고를 띄웠으면 바로 실패(코드·문구를 사유에 싣는다), 아니면 false — 「90초 안 됨」 대신 실제 원인이 남는다. */
async function failOnPhoneAlert(phone: Phone): Promise<false> {
  const alert = await phone.alert();
  if (alert) throw new SettledFailure(`the phone shows an error instead: ${alert.code || '(no code)'} — ${alert.message}`);
  return false;
}

interface InternetSession {sessionId: string; approvalState: string; sasCode: string | null; controllerId: string}

async function internetStatus(sidecar: RunningSidecar): Promise<{enabled: boolean; state: string; sessions: InternetSession[]}> {
  const response = await managementRequest(sidecar, '/api/remote-control/internet/status', {});
  if (response.status !== 200) throw new Error(`internet status HTTP ${response.status}: ${String(response.json.code ?? response.json.error ?? '')}`);
  const status = response.json.status ?? {};
  return {enabled: !!status.enabled, state: String(status.state ?? ''), sessions: Array.isArray(status.sessions) ? status.sessions : []};
}

export async function runRelayWebJourney(ctx: LaneContext): Promise<LaneOutcome> {
  const started = Date.now();
  const steps: Step[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const artifacts: string[] = [];
  const evidenceDir = ctx.evidence.path('relay-web');
  mkdirSync(evidenceDir, {recursive: true, mode: 0o700});
  const shotPath = (name: string) => { const path = join(evidenceDir, `${name}.png`); artifacts.push(ctx.evidence.relative(path)); return path; };
  const receipt = (entry: Record<string, unknown>) => {
    const record = {at: new Date().toISOString(), ...entry};
    receipts.push(record);
    ctx.evidence.appendJsonl('relay-web/host-receipts.jsonl', record);
  };
  const labels: PathLabels = {real: [...REAL_LABELS], standIn: [...STAND_IN_LABELS]};
  const phones: Phone[] = [];
  let phoneBrowser: PhoneBrowser | null = null;
  let shim: RunningSupabaseShim | null = null;
  let sidecar: RunningSidecar | null = null;
  let restartAt: string | null = null;
  let hostAppDataDir: string | null = null;
  const sideEffectLogs: string[] = [];
  let expectedClaims = 0;
  const builds: PortalBuildResult[] = [];
  const details: Record<string, unknown> = {};
  let outcome: LaneOutcome | null = null;
  const cardFollow: CardFollowEntry[] = [];
  /** 정리 때 남은 픽스처 서버를 찾는 데 쓴다(실행 전에 실패하면 null). */
  let fixture: {startsFile: string; port: number; alphaDir: string} | null = null;
  /** 복원된(재시작을 건넌) 세션 — 재시작 건너뛰기 판정 대상. */
  let restoredSessionId: string | null = null;

  const step = async <T>(name: string, run: () => Promise<T>, describe?: (value: T) => unknown): Promise<T> => {
    const t0 = Date.now();
    ctx.log(`j1-relay-web: ${name} …`);
    try {
      const value = await run();
      steps.push({name, ok: true, ms: Date.now() - t0, ...(describe ? {detail: describe(value)} : {})});
      return value;
    } catch (error) {
      const message = redactPairingText((error as Error)?.message ?? String(error)).slice(0, 1_500);
      steps.push({name, ok: false, ms: Date.now() - t0, error: message});
      if (error instanceof StepBlocked || error instanceof PhoneBlockedError) throw new StepBlocked(`${name}: ${message}`);
      throw new StepFailure(`${name}: ${message}`);
    }
  };

  try {
    // ── 1. shim · 포털 빌드 · 호스트 ──
    shim = await step('start supabase shim (https)', () => ctx.startSupabaseShim({label: 'relay-web'}), value => ({httpsUrl: value.ready.httpsUrl, httpsFallback: value.ready.httpsFallback, isolation: value.ready.isolation}));
    const credentials = shim.credentials();
    if (!credentials.https || !shim.ready.caCertPath) throw new StepBlocked('the shim has no https door — the QR would omit `supabase` and skip the production path');
    const shimOrigin = assertShimOrigin(new URL(credentials.https.url).origin);
    const member = credentials.users.find(user => user.member);
    if (!member) throw new StepFailure('the shim has no member user');

    const buildRoot = join(ctx.scratchRoot, 'relay-web-portal');
    builds.push(await step('build production portal (VITE_SUPABASE_URL = shim)', () => buildPortalFixture({
      repoRoot: ctx.repoRoot, outDir: join(buildRoot, 'web'), workDir: join(buildRoot, 'web-work'), variant: 'web', supabaseUrl: shimOrigin, anonKey: credentials.anonKey,
    }), value => ({durationMs: value.durationMs, files: value.files, supabaseConfigAsExpected: value.supabaseConfigAsExpected})));
    builds.push(await step('build bundled portal (no VITE_SUPABASE_*)', () => buildPortalFixture({
      repoRoot: ctx.repoRoot, outDir: join(buildRoot, 'bundled'), workDir: join(buildRoot, 'bundled-work'), variant: 'bundled',
      mustNotContain: [shimOrigin, credentials.anonKey],
    }), value => ({durationMs: value.durationMs, files: value.files, supabaseConfigAsExpected: value.supabaseConfigAsExpected})));
    for (const build of builds) if (!build.supabaseConfigAsExpected) throw new StepFailure(`portal ${build.variant} build: Supabase config not as expected`);

    const root = isolatedRoot(ctx.scratchRoot, 'relay-web');
    hostAppDataDir = root.appDataDir;
    const projectsDir = join(ctx.scratchRoot, 'relay-web-projects');
    const alphaDir = join(projectsDir, PROJECT_ALPHA);
    const betaDir = join(projectsDir, PROJECT_BETA);
    for (const dir of [alphaDir, betaDir]) mkdirSync(dir, {recursive: true, mode: 0o700});
    const alphaPort = reserveLoopbackPort();
    const startsFile = join(projectsDir, 'alpha-starts.log');
    const transcript = join(root.root, 'fake-agent-transcript.log');
    fixture = {startsFile, port: alphaPort, alphaDir};
    writeFileSync(join(alphaDir, 'server.ts'), fixtureServerSource(startsFile, alphaPort), {mode: 0o600});
    writeFileSync(join(betaDir, 'README.md'), '# relay-beta fixture (folder-only project)\n', {mode: 0o600});
    writeSidecarFixtures(root, {
      ports: [
        {id: PROJECT_ALPHA, name: PROJECT_ALPHA, port: alphaPort, folderPath: alphaDir, terminalCommand: ALPHA_TERMINAL_COMMAND},
        {id: PROJECT_BETA, name: PROJECT_BETA, folderPath: betaDir},
      ],
      portal: {supabaseUrl: shimOrigin, supabaseAnonKey: credentials.anonKey},
      fakeClis: {...Object.fromEntries(FAKE_AGENT_NAMES.map(name => [name, fakeAgentCliSource(transcript, name)])), ps: SANDBOX_PS_STUB},
    }, {scratchRoot: ctx.scratchRoot});
    writeFileSync(join(root.appDataDir, 'supabase-service.json'), JSON.stringify({serviceRoleKey: credentials.serviceRoleKey}), {mode: 0o600});
    const hostProfile = ctx.sandboxProfile('relay-web-host', {allowedLoopbackPorts: [...shim.loopbackPorts, alphaPort]});
    // 재시작마다 사이드카 포트가 바뀌고 관측 기록도 포트별 파일이다 — 두 기록을 모두 읽는다.
    const startHost = async () => {
      const started = await ctx.startSidecar(root, 'source', {profile: hostProfile, extraCaCerts: shim!.ready.caCertPath!, observeSideEffects: true, checkOpenFiles: true, healthTimeoutMs: 90_000});
      if (started.sideEffectLog) sideEffectLogs.push(started.sideEffectLog);
      return started;
    };
    sidecar = await step('start sandboxed host sidecar', startHost, value => ({readyMs: Math.round(value.readyMs), sandboxed: value.sandboxed, allowedLoopbackPorts: value.sandboxProfile?.allowedLoopbackPorts.length}));

    // ── 2. 인터넷 원격 켜기 · QR ──
    const enabled = await step('host enables internet remote control', async () => {
      const response = await managementRequest(sidecar!, '/api/remote-control/internet/enable', {controllerOrigin: PORTAL_ORIGIN});
      if (response.status !== 200 || typeof response.json.pairing?.pairingUrl !== 'string') {
        throw new StepFailure(`enable HTTP ${response.status}: ${String(response.json.code ?? '')} ${String(response.json.error ?? '').slice(0, 200)}`);
      }
      return response.json.pairing.pairingUrl as string;
    });
    const firstPairing = summarizePairing(enabled, {url: shimOrigin, anonKey: credentials.anonKey});
    receipt({step: 'enable', controllerOrigin: PORTAL_ORIGIN, pairing: firstPairing});
    details.pairing = firstPairing;
    if (firstPairing.base !== `${PORTAL_ORIGIN}${PORTAL_REMOTE_PATH}`) throw new StepFailure(`QR base is ${firstPairing.base}, not ${PORTAL_ORIGIN}${PORTAL_REMOTE_PATH}`);
    if (!firstPairing.hasSupabase || !firstPairing.supabaseUrlMatchesShim || !firstPairing.anonKeyMatchesShim) {
      throw new StepFailure(`QR must carry supabase = shim origin + anon key (hasSupabase ${firstPairing.hasSupabase}, url match ${firstPairing.supabaseUrlMatchesShim}, key match ${firstPairing.anonKeyMatchesShim})`);
    }

    // ── 3. 휴대폰: 로그인 · SAS · 승인 ──
    const profile = ctx.isolatedProfile('relay-web-phone');
    phoneBrowser = await step('launch WebKit phone', () => launchPhoneBrowser(phoneBrowserEnv(ctx.home, profile.tmp)), value => ({webkit: value.version}));
    details.phoneBrowserEnv = {keys: Object.keys(phoneBrowserEnv(ctx.home, profile.tmp)).sort(), home: 'real (WebKit WebContent sandbox needs it — scratch HOME hangs the page)', context: 'ephemeral'};
    const webDist = builds[0]!.outDir;
    const vercel = readVercelConfig(ctx.repoRoot);
    const phone = await Phone.open(phoneBrowser, {label: 'web', dist: webDist, shimOrigin, vercel});
    phones.push(phone);
    /**
     * `asScanned`: QR을 그대로 연다(카메라·앱의 pageURL — `?tab=` 없음). 그러면 「홈」에서 시작하고, 로그인·SAS·연결 상태는 모두
     * 「원격 작업」 탭의 workspace-host-content 안에 있어(`hidden={workspaceTab!=='workroom'}`) 홈에는 보이지 않는다(실측 2026-11-01 —
     * 홈에는 로그인 안내가 없다). 그래서 사람처럼 「원격 작업」 탭을 누른 뒤 로그인한다. 아니면 기존 e2e 모양대로 `?tab=workroom`을
     * 붙인다(대역 — labels.standIn).
     */
    const pair = async (target: Phone, pairingUrl: string, label: string, options: {asScanned?: boolean} = {}) => {
      if (options.asScanned) {
        await step(`${label}: open the QR as scanned (no query) → 홈 → phone taps 원격 작업`, async () => {
          await target.goto(pairingUrl);
          await target.screenshot(shotPath(`${label}-landing`));
          details[`${label}Landing`] = {tab: await target.currentWorkspaceTab(), loginVisible: await target.loginVisible()};
          await target.openWorkspaceTab('workroom');
        });
      }
      await step(`${label}: ${options.asScanned ? '' : 'open the QR with ?tab=workroom and '}sign in with the email code`, async () => {
        if (!options.asScanned) await target.goto(withPortalQuery(pairingUrl, '?tab=workroom'));
        await target.login(member.email, credentials.otpCode);
      });
      const phoneSas = await step(`${label}: phone shows the SAS`, () => target.waitForSas(90_000));
      const hostSession = await step(`${label}: host sees the pending session`, () => until('pending session with a SAS on the host', 60_000, async () => {
        const status = await internetStatus(sidecar!);
        return status.sessions.find(session => session.approvalState === 'pending' && session.sasCode) ?? null;
      }), value => ({sessionId: value.sessionId.slice(0, 8)}));
      await target.screenshot(shotPath(`${label}-sas`));
      if (!/^\d{6}$/.test(phoneSas) || phoneSas !== hostSession.sasCode) throw new StepFailure(`${label}: phone SAS ${phoneSas || '(none)'} ≠ host SAS ${hostSession.sasCode}`);
      await step(`${label}: Mac approves (scripted, SAS matched)`, async () => {
        const response = await managementRequest(sidecar!, '/api/remote-control/internet/sessions/approve', {sessionId: hostSession.sessionId, expectedSasCode: hostSession.sasCode});
        if (response.status !== 200) throw new StepFailure(`approve HTTP ${response.status}: ${String(response.json.code ?? '')}`);
      });
      receipt({step: `${label}-approve`, scriptedApproval: true, sessionId: hostSession.sessionId.slice(0, 8), phoneSasEqualsHostSas: true});
      expectedClaims += 1;
      await step(`${label}: phone says 연결됨`, () => target.waitForPill('연결됨', 90_000));
      await target.screenshot(shotPath(`${label}-connected`));
      return hostSession;
    };
    const session = await pair(phone, enabled, 'web');
    details.claimRequestsFromWebPhone = phone.rpcCalls(CLAIM_RPC);

    // ── 4. 시작·정지 ──
    details.cardFollow = cardFollow;
    /**
     * 호스트가 실제로 바뀐 뒤(포트 관측) 휴대폰 카드가 따라오는가. 호스트는 동작 직후의 카드를 돌려주므로(remoteControlCore
     * `#refreshProjectCards` — 서버가 포트를 열기 전일 수 있다) 카드가 옛 상태로 남으면 사람처럼 「새로고침」을 누른다.
     * 시도 수는 눌렀든 못 눌렀든 센다(휴대폰이 오프라인·바쁨이면 버튼이 없어 탭이 늘지 않는다 — 예전에는 그때 끝없이 돌았다, 검토 #1)
     * 그리고 전체 한도(CARD_FOLLOW_DEADLINE_MS)가 있다. 누른 횟수는 사후에 judgeCardFollow가 전환별 허용 수로 판정한다.
     */
    const cardFollows = async (label: string, transition: CardTransition) => {
      const action = transition === 'start' ? 'stop' : 'start';
      const {followed, refreshTaps, attempts} = await followCard({
        waitEnabled: ms => phone.waitForProjectAction(PROJECT_ALPHA, action, ms).then(() => true, () => false),
        tapRefresh: ms => phone.tapRefresh(ms),
        checkAlert: () => failOnPhoneAlert(phone).then(() => undefined),
      });
      cardFollow.push({step: label, transition, refreshTaps, attempts, followed, status: await phone.projectStatus(PROJECT_ALPHA)});
      if (!followed) throw new StepFailure(`the phone card never offered 「${action}」 (${attempts} attempt(s), ${refreshTaps} 새로고침 tap(s), pill ${await phone.pillText() || '(none)'})`);
      return refreshTaps;
    };
    const alphaListening = () => fixtureListening(startsFile, alphaPort);
    const startStop = async (label: string, expectedStarts: number) => {
      await step(`${label}: open 프로젝트 관리`, async () => { await phone.openProjects(); await cardFollows(`${label}-before`, 'before'); });
      await step(`${label}: phone taps 실행 → host starts ${PROJECT_ALPHA}`, async () => {
        await phone.clickProjectAction(PROJECT_ALPHA, 'start');
        // 이 탭이 띄운 서버(기동 기록의 마지막 pid)가 듣고 있어야 한다 — 기동 줄이 기대 수에 이르기 전의 리스너는 셈하지 않는다.
        await until(`${PROJECT_ALPHA} (the fixture server this tap started) listening on its port`, 90_000,
          async () => (lineCount(startsFile) >= expectedStarts && alphaListening().listening) || await failOnPhoneAlert(phone));
        await cardFollows(`${label}-start`, 'start');
      });
      const starts = lineCount(startsFile);
      const running = alphaListening();
      receipt({step: `${label}-start`, project: PROJECT_ALPHA, listeningPidIsStartedPid: running.listening, fixtureBootLines: starts, phoneStatus: await phone.projectStatus(PROJECT_ALPHA)});
      if (starts !== expectedStarts) throw new StepFailure(`${label}: the fixture server booted ${starts} time(s), expected ${expectedStarts} (one tap = one execution)`);
      if (!running.listening) throw new StepFailure(`${label}: the port ${alphaPort} listener is not the fixture server this tap started (listeners ${running.listeners.length})`);
      await phone.screenshot(shotPath(`${label}-running`));
      await step(`${label}: phone taps 중지 → host stops ${PROJECT_ALPHA}`, async () => {
        await phone.clickProjectAction(PROJECT_ALPHA, 'stop');
        await until(`${PROJECT_ALPHA} (the started pid) no longer listening`, 90_000, async () => !alphaListening().listening || await failOnPhoneAlert(phone));
        await cardFollows(`${label}-stop`, 'stop');
      });
      const stopped = alphaListening();
      receipt({step: `${label}-stop`, project: PROJECT_ALPHA, listeningPidIsStartedPid: stopped.listening, listenersOnPort: stopped.listeners.length, fixtureBootLines: lineCount(startsFile), phoneStatus: await phone.projectStatus(PROJECT_ALPHA)});
    };
    await startStop('web', 1);

    // ── 5. 워크룸 ──
    const targets = await step('host lists workroom targets', async () => {
      const response = await managementRequest(sidecar!, '/api/agent-runtime/targets', {}, 'GET');
      const list = Array.isArray(response.json.targets) ? response.json.targets as Array<Record<string, unknown>> : [];
      if (response.status !== 200 || !list.length) throw new StepFailure(`targets HTTP ${response.status}, ${list.length} target(s)`);
      return list.map(target => String(target.targetId)).filter(Boolean);
    }, value => ({count: value.length}));
    await step('Mac allows this phone in the workroom (scripted)', async () => {
      const response = await managementRequest(sidecar!, '/api/agent-runtime/terminals/access', {owner: `internet:${session.sessionId}`, enabled: true, rememberDevice: true, workspaceScopes: [], targetIds: targets});
      if (response.status !== 200) throw new StepFailure(`terminal access HTTP ${response.status}: ${String(response.json.error ?? '').slice(0, 200)}`);
    });
    receipt({step: 'workroom-grant', scriptedApproval: true, owner: 'internet', targets: targets.length, rememberDevice: true});
    const token = `relay-web-${ctx.runId.slice(-6).toLowerCase()}`;
    await step('phone opens the workroom and starts a task', async () => {
      await phone.openWorkroom();
      await phone.startWorkroomTask(PROJECT_BETA, WORKROOM_AGENT, 90_000);
      await phone.waitForWorkroomText('REMOTE_READY', 90_000);
    });
    await step('phone types into the workroom → fake CLI echoes', async () => {
      await phone.sendWorkroomInput(token);
      await phone.waitForWorkroomText(`RESULT:${token}`, 60_000);
    });
    await phone.screenshot(shotPath('web-workroom'));
    const inputs = lineCount(transcript, `INPUT:${token}`);
    receipt({step: 'workroom-input', agent: WORKROOM_AGENT, cliStarts: lineCount(transcript, 'START '), inputLinesWithToken: inputs});
    if (inputs !== 1) throw new StepFailure(`the fake CLI received the workroom input ${inputs} time(s), expected exactly 1`);

    // ── 6. 음성 사례: 다른 Supabase QR ──
    const foreignPairing = await step('host issues a second QR (for the foreign rewrite)', async () => {
      const response = await managementRequest(sidecar!, '/api/remote-control/internet/pairing/issue', {});
      if (response.status !== 200 || typeof response.json.pairing?.pairingUrl !== 'string') throw new StepFailure(`issue HTTP ${response.status}: ${String(response.json.code ?? '')}`);
      return response.json.pairing.pairingUrl as string;
    });
    const signedIn = await phone.context.storageState();
    const foreign = await Phone.open(phoneBrowser, {label: 'foreign', dist: webDist, shimOrigin, vercel, storageState: signedIn});
    phones.push(foreign);
    const guard = await step('signed-in phone opens a QR for another Supabase project', async () => {
      await foreign.goto(withPortalQuery(withForeignSupabase(foreignPairing, FOREIGN_SUPABASE_ORIGIN), '?tab=workroom'));
      const title = await foreign.foreignGuardTitle(30_000);
      await foreign.page.waitForTimeout(2_000);
      return title;
    });
    await foreign.screenshot(shotPath('foreign-guard'));
    const foreignShimRequests = foreign.shimRequests();
    details.foreign = {guardTitle: guard, shimRequests: foreignShimRequests, claimRequests: foreign.rpcCalls(CLAIM_RPC), aborted: foreign.aborted(), fragmentLeftInAddressBar: foreign.hasFragmentInAddressBar()};
    if (!guard.includes('다른 사용자의 AgentsToZ')) throw new StepFailure(`foreign QR guard title unexpected: ${guard}`);
    if (foreignShimRequests !== 0) throw new StepFailure(`the foreign QR page sent ${foreignShimRequests} request(s) to the shim (must be 0, claim RPC 0)`);
    if (foreign.hasFragmentInAddressBar()) throw new StepFailure('the foreign QR page left the #pair fragment in the address bar');
    await foreign.close();

    // ── 7. 재시작 뒤 재개 ──
    details.pillBeforeRestart = await phone.pillText();
    await step('stop the host sidecar', () => sidecar!.stop());
    restartAt = new Date().toISOString();
    await Bun.sleep(5_000);
    details.pillWhileStopped = await phone.pillText();
    sidecar = await step('restart the host on the same app data', startHost, value => ({readyMs: Math.round(value.readyMs)}));
    await step('host restores the approved session', () => until('restored internet host with the same approved session', 90_000, async () => {
      const status = await internetStatus(sidecar!);
      return status.enabled && status.sessions.some(entry => entry.sessionId === session.sessionId && entry.approvalState === 'approved') ? status : null;
    }, 1_000), value => ({state: value.state, sessions: value.sessions.length}));
    receipt({step: 'restart', sameSessionApproved: true, sessionId: session.sessionId.slice(0, 8)});
    restoredSessionId = session.sessionId;
    // 표시는 5초 정지 동안 「연결됨」에서 바뀌지 않는다(pillWhileStopped, 실측) — 이 단계는 재개의 증거가 아니라 다음 왕복의 전제다.
    // 재개의 증거: 같은 세션으로 시작·정지 왕복(기동 2번째) · 이 휴대폰의 claim 추가 0 · 릴레이 순번 건너뛰기(사후 judgeRestartSkip).
    await step('phone shows 연결됨 after the restart (precondition only — no new QR, no re-claim)', () => phone.waitForPill('연결됨', 120_000));
    await startStop('after-restart', 2);
    details.claimRequestsFromWebPhoneAfterRestart = phone.rpcCalls(CLAIM_RPC);
    if (phone.rpcCalls(CLAIM_RPC) !== details.claimRequestsFromWebPhone) throw new StepFailure('the phone claimed again after the host restart (resume must not need a new QR)');

    // ── 8. 번들 포털 변형 ──
    const bundledPairing = await step('host issues a QR for the bundled-portal phone', async () => {
      const response = await managementRequest(sidecar!, '/api/remote-control/internet/pairing/issue', {});
      if (response.status !== 200 || typeof response.json.pairing?.pairingUrl !== 'string') throw new StepFailure(`issue HTTP ${response.status}: ${String(response.json.code ?? '')}`);
      return response.json.pairing.pairingUrl as string;
    });
    const bundled = await Phone.open(phoneBrowser, {
      label: 'bundled', dist: builds[1]!.outDir, shimOrigin, vercel,
      bundled: {portalOrigin: PORTAL_ORIGIN, supabaseUrl: shimOrigin, supabaseAnonKey: credentials.anonKey},
    });
    phones.push(bundled);
    // 앱은 스캔한 QR의 프래그먼트를 그대로 자기 /remote/ 페이지에 붙여 연다(BundledPortalConfig.pageURL — 쿼리 없음).
    await pair(bundled, bundledPairing, 'bundled', {asScanned: true});
    await step('bundled: project list reaches the phone', async () => { await bundled.openProjects(); await bundled.waitForProjectAction(PROJECT_ALPHA, 'start', 60_000); });
    await bundled.screenshot(shotPath('bundled-projects'));
    const hostAfter = await internetStatus(sidecar!);
    details.hostSessions = hostAfter.sessions.map(entry => ({session: entry.sessionId.slice(0, 8), approvalState: entry.approvalState}));
    if (hostAfter.sessions.filter(entry => entry.approvalState === 'approved').length !== expectedClaims) {
      throw new StepFailure(`host has ${hostAfter.sessions.filter(entry => entry.approvalState === 'approved').length} approved session(s), expected ${expectedClaims} (the foreign QR must not have produced one)`);
    }
    outcome = {status: 'pass'};
  } catch (error) {
    const message = redactPairingText((error as Error)?.message ?? String(error)).slice(0, 1_500);
    outcome = error instanceof StepBlocked ? {status: 'blocked', reason: message} : {status: 'fail', reason: message};
    for (const phone of phones) await phone.screenshot(shotPath(`failure-${phone.label}`));
  }

  // ── 9. 정리 · 사후 판정 ──
  const phoneSummaries = phones.map(phone => ({
    label: phone.label,
    shimRequests: phone.shimRequests(),
    claimRequests: phone.rpcCalls(CLAIM_RPC),
    portalRequests: phone.ledger.filter(entry => entry.kind === 'portal').length,
    aborted: phone.aborted(),
    csp: {...phone.csp},
    loadedRemote: phone.ledger.some(entry => entry.kind === 'portal' && (entry.target === PORTAL_REMOTE_PATH || entry.target === '/remote')),
    pageErrors: phone.pageErrors.slice(0, 10),
    dialogs: phone.dialogs.slice(0, 10),
  }));
  for (const phone of phones) {
    ctx.evidence.writeJson(`relay-web/phone-ledger-${phone.label}.json`, phone.ledger);
    await phone.close();
  }
  if (phoneBrowser) await phoneBrowser.close().catch(() => {});
  if (sidecar) {
    if (outcome?.status !== 'pass') {
      try {
        const tail = readFileSync(sidecar.stderrLog, 'utf8').slice(-6_000);
        const redacted = redactPairingText(tail).split(shim?.credentials().serviceRoleKey ?? '\u0000').join('[service-key]');
        ctx.evidence.writeText('relay-web/host-stderr-tail.log', redacted);
      } catch {}
      // 픽스처 프로젝트의 실행 로그(호스트가 APP_DATA_DIR/logs/<id>.log로 돌린 출력)와 기동 기록 — 실패 진단용.
      if (hostAppDataDir) {
        for (const id of [PROJECT_ALPHA]) {
          const log = join(hostAppDataDir, 'logs', `${id}.log`);
          try { if (existsSync(log)) ctx.evidence.writeText(`relay-web/project-${id}.log`, redactPairingText(readFileSync(log, 'utf8').slice(-4_000))); } catch {}
        }
      }
    }
    await sidecar.stop();
  }
  const postProblems: string[] = [];
  // 사이드카를 멈춘 뒤에도 남은 픽스처 서버(호스트는 종료할 때 프로젝트 서버를 멈추지 않는다 — 검토 #2)를 이 실행의 것임을 확인하고 멈춘다.
  if (fixture) {
    const reaped = await reapFixtureServers(fixture.startsFile, fixture.port, fixture.alphaDir);
    details.fixtureServers = {started: reaped.started.length, killedAfterHostStop: reaped.killed, stillAlive: reaped.stillAlive, aliveButNotOurs: reaped.skipped};
    if (reaped.killed.length) ctx.log(`j1-relay-web: stopped ${reaped.killed.length} fixture server(s) the host left running (pid ${reaped.killed.join(', ')})`);
    if (reaped.stillAlive.length) postProblems.push(`fixture server pid ${reaped.stillAlive.join(', ')} survived SIGKILL`);
    if (reaped.killed.length) postProblems.push(`${reaped.killed.length} fixture server(s) were still running after the journey and the host stopped (killed by the lane)`);
  }
  // 사이드카를 멈춘 뒤에 읽는다(마지막 기록까지). 실행 파일 이름·결과만 담기므로 그대로 증거에 싣는다.
  const sideEffects = sideEffectLogs.flatMap(path => readSideEffectLog({sideEffectLog: path}));
  if (sideEffects.length) ctx.evidence.writeJson('relay-web/host-side-effects.json', sideEffects);
  const sideEffectSummary = summarizeSideEffects(sideEffects);
  if (sideEffectSummary.refused.length) postProblems.push(`the host tried desktop side effects during the journey (refused by the guard): ${sideEffectSummary.refused.join(', ')}`);
  if (shim) {
    const stopped = await shim.stop();
    const reportPath = join(shim.evidenceDir, 'supabase-shim-report.json');
    const relayPath = join(shim.evidenceDir, 'relay-db.json');
    if (existsSync(reportPath)) {
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      const judged = judgeShimReport(report, expectedClaims);
      details.shim = {exitCode: stopped.exitCode, ...judged, requestCount: report.requestCount, authEvents: report.authEvents};
      if (outcome?.status === 'pass') postProblems.push(...judged.problems);
    } else postProblems.push('the shim wrote no report');
    if (existsSync(relayPath)) {
      const dump = JSON.parse(readFileSync(relayPath, 'utf8'));
      const rows = (dump?.audit?.relay_messages ?? []) as RelayAuditRow[];
      const audit = auditRelaySequences(rows, restartAt);
      details.relaySequences = audit;
      if (audit.reused || audit.nonMonotonic || audit.relaySeqDuplicates) postProblems.push(`relay sequence audit: reused ${audit.reused}, non-monotonic ${audit.nonMonotonic}, duplicate relay_seq ${audit.relaySeqDuplicates}`);
      if (outcome?.status === 'pass' && !audit.rows) postProblems.push('relay audit has no messages');
      // 재시작 건너뛰기(검토 #3): 재사용·순서는 릴레이 RPC가 이미 거절하므로, 건너뛰기를 지운 회귀는 이것만 잡는다.
      if (outcome?.status === 'pass') {
        const skip = restoredSessionId ? judgeRestartSkip(audit, restoredSessionId) : {problems: ['no restored session to judge the restart skip'], jump: null};
        details.restartSkip = {session: restoredSessionId?.slice(0, 8) ?? null, jump: skip.jump, minimum: RELAY_RESTART_MIN_SKIP};
        postProblems.push(...skip.problems);
      }
    } else postProblems.push('the shim wrote no relay-db.json');
    for (const problem of shim.problems()) postProblems.push(`shim: ${problem}`);
  }
  // 휴대폰(검토 #5): 끊긴 origin(3001·*.supabase.co 포함) 0, /remote/를 연 휴대폰은 메타·헤더 CSP를 모두 넓혔어야 한다.
  postProblems.push(...judgePhones(phoneSummaries));
  // 카드 따라오기(검토 #4): 허용 밖 탭은 실패, 허용 안의 탭은 알려진 문제로 이름을 붙여 결과에 올린다(details만이 아니라).
  const cards = judgeCardFollow(cardFollow);
  if (outcome?.status === 'pass') postProblems.push(...cards.problems);
  const knownIssues = cards.knownIssue ? [cards.knownIssue] : [];
  if (cards.knownIssue) {
    const taps = cards.knownIssue.occurrences.reduce((sum, entry) => sum + entry.taps, 0);
    labels.standIn.push(`known issue ${cards.knownIssue.id}: ${taps} manual 새로고침 tap(s) stood in for the card following the host by itself (${cards.knownIssue.occurrences.map(entry => entry.step).join(', ')})`);
  }
  details.knownIssues = knownIssues;
  if (outcome?.status === 'pass' && postProblems.length) outcome = {status: 'fail', reason: `post-run checks: ${postProblems.join('; ')}`.slice(0, 1_500)};

  const summary = {
    durationMs: Date.now() - started,
    steps,
    receipts: receipts.length,
    phones: phoneSummaries,
    builds: builds.map(build => ({variant: build.variant, durationMs: build.durationMs, files: build.files, supabaseConfigAsExpected: build.supabaseConfigAsExpected})),
    sideEffects: sideEffectSummary,
    expectedClaims,
    restartAt,
    postProblems,
    ...details,
  };
  ctx.evidence.writeJson('relay-web/summary.json', summary);
  artifacts.push('relay-web/summary.json', 'relay-web/host-receipts.jsonl', 'supabase-shim/relay-web/relay-db.json', 'supabase-shim/relay-web/supabase-shim-report.json');
  const final = outcome ?? {status: 'fail', reason: 'no outcome'};
  return {
    ...final,
    labels,
    artifacts,
    details: {
      durationMs: summary.durationMs,
      stepsPassed: steps.filter(entry => entry.ok).length,
      stepsTotal: steps.length,
      failedStep: steps.find(entry => !entry.ok)?.name ?? null,
      expectedClaims,
      shim: details.shim ?? null,
      relaySequences: details.relaySequences ?? null,
      restartSkip: details.restartSkip ?? null,
      knownIssues,
      cardFollow: cardFollow.map(entry => ({step: entry.step, refreshTaps: entry.refreshTaps, attempts: entry.attempts ?? 0, followed: entry.followed})),
      fixtureServers: details.fixtureServers ?? null,
      foreign: details.foreign ?? null,
      phones: phoneSummaries.map(phone => ({label: phone.label, shimRequests: phone.shimRequests, claimRequests: phone.claimRequests, aborted: phone.aborted, csp: phone.csp, loadedRemote: phone.loadedRemote})),
      postProblems,
    },
  };
}

export const lane: LaneDefinition = {
  id: LANE_ID,
  title: 'J1-RELAY-WEB — production portal ↔ https shim ↔ real host agent',
  run: runRelayWebJourney,
};
