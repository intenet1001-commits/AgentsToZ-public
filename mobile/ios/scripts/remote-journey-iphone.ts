/**
 * Candidate-side remote journey on a real iPhone (benchmark track F11). Human-attended; never run unattended.
 *
 *   AGENTSTOZ_REMOTE_JOURNEY_DEVICE=attended \
 *   bun mobile/ios/scripts/remote-journey-iphone.ts --device <UDID> --project <워크룸 세션 탭의 프로젝트 이름 또는 탭 이름 전체> \
 *     [--metric workflow|wifi-change|lock-return|host-restart] [--duplicate-tap] [--record] [--deadline-ms 120000] \
 *     [--attempt <id>] [--out <dir>] [--appium http://127.0.0.1:4723] [--wda-derived-data <path>]
 *
 * What it does: drives ONLY the AgentsToZ dev app (com.intenet.agentstoz.mobile.dev) through a local Appium
 * server, opens the Workroom of an already paired Mac, submits one nonce request through the composer (the panel's
 * whole-request submission, terminal-submission-v1), watches the pending submission record and the terminal for the
 * nonce answer, asks the HUMAN to perform the scheduled perturbation (Wi‑Fi, lock, Mac app restart) and writes an
 * event log (src/remoteJourneyReducer.ts) plus a captureHash of the optional screen recording. For a recovery metric
 * the request is typed first and sent only after the human confirms the perturbation is over, so the clock measures
 * a request that had to cross back over it.
 *
 * What it never does: approve a pairing, a SAS code, a grant or a scope (the Mac approval screen is a consent
 * boundary — the run stops there); drive the Mac screen; open, inspect or touch any other app (an OpenAI app
 * included); change phone settings; send anything but the one nonce request (plus the scheduled duplicate tap).
 * Unknown outcomes are recorded, never retried automatically. The request goes only to the session whose tab label is
 * exactly `--project` (or `<project> · <agent>[ #n]` in full): a composer the phone was left on for another session is
 * never used, and a missing, ambiguous or unselectable session refuses before anything is typed. Which Mac tab the
 * portal shows is not checked — open the Mac you mean before running.
 *
 * Preconditions (see the iphone-ui-automation project note): phone unlocked and in hand for the first session,
 * prebuilt WebDriverAgent, Web Inspector on for the dev app (turn it off afterwards), the phone already paired.
 * ⚠️ Not yet run on a device — the Appium half is a skeleton. Reading the web view can fail when only NATIVE_APP
 * is listed (seen on TestFlight 712); the run refuses with WEBVIEW_UNAVAILABLE instead of guessing.
 */
import {homedir} from 'node:os';
import {join, relative, resolve, isAbsolute} from 'node:path';
import {mkdirSync, writeFileSync} from 'node:fs';
import {canonicalJson, sha256Hex} from '../../../src/voiceEvalCorpus';
import {
  parseRemoteJourneyLog, reduceRemoteJourney, type RemoteJourneyEvent, type RemoteJourneyLog, type RemoteJourneyMetric,
} from '../../../src/remoteJourneyReducer';

export const REMOTE_JOURNEY_DEV_BUNDLE_ID = 'com.intenet.agentstoz.mobile.dev';
export const REMOTE_JOURNEY_OPT_IN_ENV = 'AGENTSTOZ_REMOTE_JOURNEY_DEVICE';
/** The opt-in is a statement, not a switch: a person is holding the unlocked phone. */
export const REMOTE_JOURNEY_OPT_IN_VALUE = 'attended';
const SUPPORTED_METRICS = ['workflow','wifi-change','lock-return','host-restart'] as const;
const ALL_METRICS = [...SUPPORTED_METRICS,'sustained-1h'] as const;
const UDID = /^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40}|[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12})$/;
const ATTEMPT = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
const POLL_MS = 500, SETTLE_MS = 3_000, DUPLICATE_TAP_DELAY_MS = 150;
/** The harness does not know host target ids; receipts from the page carry none, so wrong-target stays unobserved. */
const WORKROOM_TARGET_REF = 'selected-workroom';
const PENDING_PREFIX = 'agentstoz:pending-submission:v1:';
const RECEIPT_STATES = ['prepared','write_started','written','unknown','rejected','held'] as const;
type ReceiptState = typeof RECEIPT_STATES[number];
type Cause = 'wifi'|'lock'|'host-restart';
const RECOVERY_CAUSE: Partial<Record<RemoteJourneyMetric, Cause>> = {'wifi-change':'wifi','lock-return':'lock','host-restart':'host-restart'};
const UNSUPPORTED_SUBMISSION_NOTICE = '이 기기는 전체 요청 제출을 아직 받지 않습니다';
const PROMPTS: Record<Cause, {start:string;end:string}> = {
  wifi: {start:'[사람 확인] 휴대폰의 Wi‑Fi를 끄세요(셀룰러로 바뀌게 둡니다). 끈 뒤 Enter를 누르세요. 이 스크립트는 휴대폰 설정을 바꾸지 않습니다.',
    end:'[사람 확인] Wi‑Fi를 다시 켜세요. 켠 뒤 Enter를 누르세요.'},
  lock: {start:'[사람 확인] 휴대폰 화면을 잠그세요(측면 버튼). 10초쯤 기다린 뒤 Enter를 누르세요.',
    end:'[사람 확인] 휴대폰 잠금을 해제하고 AgentsToZ 개발 앱을 앞으로 가져온 뒤 Enter를 누르세요.'},
  'host-restart': {start:'[사람 확인] Mac에서 AgentsToZ 앱을 직접 종료하세요(이 스크립트는 Mac을 조작하지 않습니다). 종료한 뒤 Enter를 누르세요.',
    end:'[사람 확인] Mac에서 AgentsToZ 앱을 다시 실행하세요. 창이 뜬 뒤 Enter를 누르세요.'},
};

export class RemoteJourneyRefusal extends Error {
  constructor(readonly code: string, message: string) {super(message);this.name='RemoteJourneyRefusal';}
}
export interface RemoteJourneyConfig {
  device:string;bundleId:typeof REMOTE_JOURNEY_DEV_BUNDLE_ID;project:string;metric:RemoteJourneyMetric;deadlineMs:number;
  duplicateTap:boolean;record:boolean;nonce:string;appiumUrl:string;outDir:string;attemptId:string;wdaDerivedDataPath:string;
}
const refuse = (code:string, message:string):never => {throw new RemoteJourneyRefusal(code,message);};
const VALUE_FLAGS = ['--device','--project','--metric','--deadline-ms','--bundle-id','--appium','--out','--attempt','--wda-derived-data'];
const BOOLEAN_FLAGS = ['--duplicate-tap','--record'];
function protectedRoots() {
  const home = homedir();
  return [join(home,'Library/Application Support/com.portmanager.portmanager'), join(home,'.codex'), join(home,'.claude')];
}
const inside = (path:string, root:string) => {const r = relative(root,path); return r === '' || !r.startsWith('..') && !isAbsolute(r);};
const freshNonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url');

/** Pure apart from the nonce: every refusal happens here, before Appium or the phone is touched. */
export function parseRemoteJourneyArgs(argv:readonly string[], env:Record<string,string|undefined>):RemoteJourneyConfig {
  const values = new Map<string,string>(), flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (BOOLEAN_FLAGS.includes(arg)) {flags.add(arg); continue;}
    if (!VALUE_FLAGS.includes(arg)) refuse('UNKNOWN_ARGUMENT', `알 수 없는 인자입니다: ${arg.slice(0,40)}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) refuse('UNKNOWN_ARGUMENT', `${arg}에 값이 없습니다.`);
    values.set(arg, value!);
  }
  const device = values.get('--device');
  if (!device) return refuse('DEVICE_REQUIRED', '--device <UDID>가 있어야 실행합니다. 이 스크립트는 사람이 들고 있는 실제 iPhone에서만 돕니다.');
  if (!UDID.test(device)) refuse('DEVICE_INVALID', '--device 값이 iPhone UDID 모양이 아닙니다.');
  if (env[REMOTE_JOURNEY_OPT_IN_ENV] !== REMOTE_JOURNEY_OPT_IN_VALUE)
    refuse('OPT_IN_REQUIRED', `${REMOTE_JOURNEY_OPT_IN_ENV}=${REMOTE_JOURNEY_OPT_IN_VALUE}로 사람이 휴대폰 앞에 있다고 밝혀야 실행합니다.`);
  const bundleId = values.get('--bundle-id') ?? REMOTE_JOURNEY_DEV_BUNDLE_ID;
  if (bundleId !== REMOTE_JOURNEY_DEV_BUNDLE_ID) refuse('BUNDLE_NOT_ALLOWED', `AgentsToZ 개발 앱(${REMOTE_JOURNEY_DEV_BUNDLE_ID})만 조작합니다.`);
  const project = values.get('--project')?.trim();
  if (!project) return refuse('PROJECT_REQUIRED', '--project <워크룸 프로젝트 이름>이 있어야 합니다. 일회용 프로젝트를 고르세요.');
  if (project.length > 80 || /[\u0000-\u001f\u007f]/.test(project)) refuse('PROJECT_REQUIRED', '--project 이름이 너무 길거나 제어 문자를 담고 있습니다.');
  const metric = values.get('--metric') ?? 'workflow';
  if (!(ALL_METRICS as readonly string[]).includes(metric)) refuse('METRIC_INVALID', `--metric은 ${SUPPORTED_METRICS.join('·')} 중 하나입니다.`);
  if (!(SUPPORTED_METRICS as readonly string[]).includes(metric)) refuse('METRIC_UNSUPPORTED', 'sustained-1h는 이 스크립트가 재지 않습니다(1시간 여정은 따로 설계).');
  const deadlineMs = Number(values.get('--deadline-ms') ?? 120_000);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 10_000 || deadlineMs > 3_600_000) refuse('DEADLINE_INVALID', '--deadline-ms는 10000~3600000 사이 정수입니다.');
  const appiumUrl = values.get('--appium') ?? 'http://127.0.0.1:4723';
  let appium: URL;
  try {appium = new URL(appiumUrl);} catch {return refuse('APPIUM_URL_NOT_LOCAL', '--appium 주소를 읽지 못했습니다.');}
  if (appium.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(appium.hostname) || appium.username || appium.password)
    refuse('APPIUM_URL_NOT_LOCAL', 'Appium은 이 Mac의 loopback 주소로만 씁니다.');
  const outDir = resolve(values.get('--out') ?? resolve(import.meta.dir, '../build/remote-journey-evidence'));
  if (protectedRoots().some(root => inside(outDir, root))) refuse('OUT_DIR_NOT_ALLOWED', '앱 데이터·~/.claude·~/.codex 아래에는 기록하지 않습니다.');
  const attemptId = values.get('--attempt') ?? `journey_${metric.replace(/-/g,'_')}_${Date.now()}`;
  if (!ATTEMPT.test(attemptId)) refuse('ATTEMPT_INVALID', '--attempt는 영문자로 시작하는 80자 이하 id입니다.');
  return {device, bundleId: REMOTE_JOURNEY_DEV_BUNDLE_ID, project, metric: metric as RemoteJourneyMetric, deadlineMs,
    duplicateTap: flags.has('--duplicate-tap'), record: flags.has('--record'), nonce: freshNonce(), appiumUrl: appium.origin,
    outDir, attemptId, wdaDerivedDataPath: resolve(values.get('--wda-derived-data') ?? join(homedir(),'Library/Developer/AgentsToZ-WDA'))};
}

/** The request the phone sends: it carries the nonce but never the answer marker itself, so an echo is not an answer. */
export const nonceRequestText = (nonce:string) =>
  `JOURNEY ${nonce}: 다른 작업은 하지 말고 한 줄로만 답하세요 — 영문 대문자 ACK, 하이픈 하나, 그리고 이 코드: ${nonce}`;
export const nonceAnswerMarker = (nonce:string) => `ACK-${nonce}`;

export type JourneyTapTarget = 'tab-workroom'|'workroom-session'|'workroom-send';
export interface JourneyObservation {
  screen:'workroom'|'approval'|'other';composerVisible:boolean;draft:string|null;
  pending:{id:string;state:string|null;storeId:string|null}[];unsupportedNotice:boolean;answerCount:number;connected:boolean;
  /** The selected Workroom session's tab label (`<project> · <agent>[ #n]`), or null when no session is shown. */
  activeSession:string|null;
}
export interface JourneyDriver {
  activate():Promise<void>;observe():Promise<JourneyObservation>;tap(target:JourneyTapTarget):Promise<void>;
  typeDraft(text:string):Promise<void>;startRecording():Promise<void>;stopRecording():Promise<Uint8Array|null>;close():Promise<void>;
}
export interface JourneyIo {now():number;sleep(ms:number):Promise<void>;prompt(message:string):Promise<void>}
interface QueryNode {value?:string;textContent?:string|null;getAttribute?(name:string):string|null}
interface QueryDocument {querySelector(selector:string):QueryNode|null}
interface TabNode {className?:string;disabled?:boolean;childNodes:ArrayLike<{nodeType:number;textContent:string|null}>;click():void}
interface TabDocument {querySelectorAll(selector:string):ArrayLike<TabNode>}

/**
 * Whether a Workroom session tab label (`<project> · <agent>`, ` #n` when two sessions share it) belongs to the
 * requested project. Exact only: the project part must equal the request, or the request names the whole label to
 * pick one of several. A substring never matches. Self-contained: shipped to the web view as source.
 */
export function journeySessionMatches(label:string|null, project:string):boolean {
  if (!label) return false;
  const full = label.trim();
  if (full === project) return true;
  const base = full.replace(/ #\d+$/, '');
  const cut = base.lastIndexOf(' · ');
  return cut > 0 && base.slice(0, cut) === project;
}

/**
 * Runs INSIDE the dev app's web view. Selects the one running session whose tab label matches `project`, reading the
 * label from the tab's own text node (the owner and state live in sibling spans and never count). Refuses rather than
 * guesses: no match → 'missing', more than one → 'ambiguous'. Self-contained; the matcher is passed in.
 */
export function selectJourneySession(doc:TabDocument, project:string, matches:(label:string|null, project:string)=>boolean):'selected'|'missing'|'ambiguous' {
  const buttons = doc.querySelectorAll('.ai-terminal-session-list button[role="tab"]');
  const found:TabNode[] = [];
  for (let i = 0; i < buttons.length; i++) {
    const button = buttons[i]!;
    if ((button.className || '').indexOf('ai-terminal-tab--ended') !== -1 || button.disabled) continue;
    let label = '';
    for (let j = 0; j < button.childNodes.length; j++) {
      const node = button.childNodes[j]!;
      if (node.nodeType === 3) label += node.textContent || '';
    }
    if (matches(label, project)) found.push(button);
  }
  if (found.length === 0) return 'missing';
  if (found.length > 1) return 'ambiguous';
  found[0]!.click();
  return 'selected';
}
interface QueryStorage {readonly length:number;key(index:number):string|null;getItem(key:string):string|null}

/**
 * Runs INSIDE the dev app's web view (shipped as source, so it references nothing outside its own body).
 * Reads only what the page already shows and stores: the screen, the composer, this origin's pending submission
 * records (ids and receipt states, never text), the terminal's answer markers and the connection pill.
 */
export function observeJourneyPage(doc:QueryDocument, storage:QueryStorage, marker:string, unsupportedNotice:string):JourneyObservation {
  const q = (selector:string) => doc.querySelector(selector);
  const main = q('main[data-workspace-tab]');
  const tab = main && main.getAttribute ? main.getAttribute('data-workspace-tab') : null;
  const screen = q('[data-testid="internet-remote-approval"]') ? 'approval' : tab === 'workroom' ? 'workroom' : 'other';
  const composer = q('textarea[aria-label="워크룸 입력"]');
  const draft = composer && composer.value ? composer.value : null;
  const pending:JourneyObservation['pending'] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || key.indexOf('agentstoz:pending-submission:v1:') !== 0) continue;
    try {
      const record = JSON.parse(storage.getItem(key) || 'null');
      if (!record || typeof record.id !== 'string') continue;
      const receipt = record.receipt && typeof record.receipt === 'object' ? record.receipt : null;
      pending.push({id: record.id, state: receipt && typeof receipt.state === 'string' ? receipt.state : null,
        storeId: receipt && typeof receipt.storeId === 'string' ? receipt.storeId : null});
    } catch {/* an unreadable record is not ours to interpret */}
  }
  const terminal = q('[data-testid="workroom-readable-screen"]') || q('.xterm-rows');
  const text = terminal && terminal.textContent ? terminal.textContent : '';
  let answerCount = 0;
  for (let at = text.indexOf(marker); marker && at !== -1; at = text.indexOf(marker, at + marker.length)) answerCount++;
  const notice = q('.ai-terminal-error, [role="alert"]');
  const pill = q('[data-testid="remote-connection-state"]');
  const current = q('.ai-terminal-current .ai-terminal-current-label');
  const activeSession = screen === 'workroom' && current && current.textContent ? current.textContent.trim() || null : null;
  return {screen, composerVisible: screen === 'workroom' && !!composer, draft, pending,
    unsupportedNotice: !!(notice && notice.textContent && notice.textContent.indexOf(unsupportedNotice) !== -1),
    answerCount, connected: !!(pill && pill.textContent && pill.textContent.indexOf('연결됨') !== -1), activeSession};
}

export interface RemoteJourneyRun {
  log:RemoteJourneyLog;aborted:null|'consent-boundary'|'workroom-not-ready'|'draft-lost'|'target-mismatch';captureHash:string|null;recording:Uint8Array|null;observeErrors:number;
}
type EventBody = RemoteJourneyEvent extends infer E ? E extends RemoteJourneyEvent ? Omit<E,'t'> : never : never;

/** One journey. Every tap is recorded as effort; the human performs every perturbation; nothing is retried. */
export async function runRemoteJourney(config:RemoteJourneyConfig, driver:JourneyDriver, io:JourneyIo):Promise<RemoteJourneyRun> {
  const events:RemoteJourneyEvent[] = [];
  let lastT = 0;
  const push = (body:EventBody) => {const t = Math.max(io.now(), lastT); lastT = t; events.push({t, ...body} as RemoteJourneyEvent);};
  const marker = nonceAnswerMarker(config.nonce), cause = RECOVERY_CAUSE[config.metric];
  let observeErrors = 0;
  const observe = async () => {
    try {return await driver.observe();} catch {observeErrors++; return null;}
  };
  await driver.activate();
  let o = await driver.observe();
  if (o.screen === 'approval')
    refuse('CONSENT_BOUNDARY', 'Mac 승인(6자리 확인) 화면입니다. 승인은 사람이 Mac에서 직접 합니다 — 이 스크립트는 여기서 멈춥니다.');
  const tap = async (target:JourneyTapTarget) => {
    // A refusal (no such project session, or two of them) is an answer, not a flaky tap: it stops the run.
    try {await driver.tap(target);} catch (error) {if (error instanceof RemoteJourneyRefusal) throw error; return false;}
    push({kind:'tap', target});
    return true;
  };
  // Only the requested project's session may receive the request — never whatever session the phone was left on.
  const onTarget = (seen:JourneyObservation) => seen.screen === 'workroom' && seen.composerVisible && journeySessionMatches(seen.activeSession, config.project);
  const navigate = async () => {
    if (o.screen === 'approval') return false;
    if (o.screen !== 'workroom') {if (!await tap('tab-workroom')) return false; o = (await observe()) ?? o;}
    if (!onTarget(o)) {if (!await tap('workroom-session')) return false; o = (await observe()) ?? o;}
    return o.screen === 'workroom' && o.composerVisible;
  };
  const targetMismatch = () => new RemoteJourneyRefusal('WORKROOM_TARGET_MISMATCH',
    `선택된 워크룸 세션(${(o.activeSession ?? '없음').slice(0, 80)})이 --project ${config.project}가 아닙니다. 아무것도 입력하지 않았습니다.`);
  let recording:Uint8Array|null = null, aborted:RemoteJourneyRun['aborted'] = null;
  if (config.record) await driver.startRecording();
  try {
    if (!await navigate()) {
      aborted = o.screen === 'approval' ? 'consent-boundary' : 'workroom-not-ready';
      if (!events.length) refuse('WORKROOM_NOT_READY', '워크룸 입력칸을 찾지 못했습니다. 휴대폰이 그 Mac에 연결돼 있고 프로젝트 세션이 실행 중인지 확인하세요.');
    } else {
      if (!onTarget(o)) throw targetMismatch();
      const text = nonceRequestText(config.nonce), digest = sha256Hex(text);
      const knownIds = new Set(o.pending.map(p => p.id)), ourIds:string[] = [], states = new Map<string,string>(), stores = new Map<string,string|null>();
      let lastDraft:string|null = o.draft === null ? null : sha256Hex(o.draft), connected = o.connected, answers = 0, perturbed = false;
      const absorb = (next:JourneyObservation) => {
        // A composer that is not on screen says nothing about the draft (locked phone, other tab).
        if (next.composerVisible) {
          const d = next.draft === null ? null : sha256Hex(next.draft);
          if (d !== lastDraft) {push({kind:'draft', digest:d, intentional:false}); lastDraft = d;}
        }
        if (next.connected !== connected) {
          push(next.connected ? {kind:'reconnect'} : {kind:'disconnect', cause: perturbed && cause ? cause : 'other'});
          connected = next.connected;
        }
        for (const id of ourIds) {
          const record = next.pending.find(p => p.id === id);
          if (record) {
            stores.set(id, record.storeId ?? stores.get(id) ?? null);
            if (!record.state || !(RECEIPT_STATES as readonly string[]).includes(record.state)) continue;
            const key = record.state + ':' + record.storeId;
            if (states.get(id) === key) continue;
            states.set(id, key);
            push({kind:'receipt', submissionId:id, storeId:record.storeId, state:record.state as ReceiptState, targetId:null});
          } else if (!states.get(id)?.startsWith('written') && !states.get(id)?.startsWith('rejected')) {
            // The panel removes its record only on a written receipt — or when an older Mac refused submission outright.
            const state:ReceiptState = next.unsupportedNotice ? 'rejected' : 'written';
            states.set(id, state + ':' + (stores.get(id) ?? null));
            push({kind:'receipt', submissionId:id, storeId:stores.get(id) ?? null, state, targetId:null});
          }
        }
        if (next.answerCount > answers) {answers = next.answerCount; push({kind:'answer', nonce:config.nonce, count:answers});}
      };
      const send = async () => {
        if (!onTarget(o)) {aborted = 'target-mismatch'; return false;}
        if (!await tap('workroom-send')) return false;
        const next = await observe();
        const fresh = next?.pending.find(p => !knownIds.has(p.id));
        if (fresh) {knownIds.add(fresh.id); ourIds.push(fresh.id);}
        // A tap that made no new record (the panel refused a second send) is still a submit attempt on the same request.
        push({kind:'submit', submissionId: fresh?.id ?? ourIds.at(-1) ?? null, draftDigest: digest, targetId: WORKROOM_TARGET_REF});
        if (next) {o = next; absorb(next);}
        return true;
      };
      const perturb = async (phase:'start'|'end') => {
        await io.prompt(PROMPTS[cause!][phase]);
        push({kind:'perturb', phase, cause:cause!});
        if (phase === 'start') perturbed = true;
      };
      await driver.typeDraft(text);
      push({kind:'draft', digest, intentional:false});
      lastDraft = digest;
      if (cause) {
        // Recovery is measured on a request that crosses back over the perturbation: the draft waits in the composer
        // while the human holds it, and it is sent only after the human says it is over. A request already in flight
        // could be answered during the perturbation and then first seen right after it — a ≈0 ms "recovery".
        await perturb('start');
        await perturb('end');
        const back = await observe();
        if (!back) aborted = 'workroom-not-ready';
        else {
          o = back;
          if (o.screen === 'approval') aborted = 'consent-boundary';
          else if (o.screen !== 'workroom' || !o.composerVisible) {
            push({kind:'reentry', reason: cause === 'lock' ? 'lock' : 'reconnect'});
            // navigate() replaces `o`; read it again rather than the narrowed value from before the taps.
            if (!await navigate()) aborted = (o as JourneyObservation).screen === 'approval' ? 'consent-boundary' : 'workroom-not-ready';
          }
          if (!aborted) {
            absorb(o);
            // A draft the perturbation took away is the finding; retyping it would hide it (and is not the user's draft).
            if (!onTarget(o)) aborted = 'target-mismatch';
            else if (o.draft === null || sha256Hex(o.draft) !== digest) aborted = 'draft-lost';
          }
        }
      }
      if (aborted) {/* nothing is sent after a consent boundary, a lost Workroom or a lost draft */}
      else if (!await send()) aborted ??= 'workroom-not-ready';
      else {
        if (config.duplicateTap) {await io.sleep(DUPLICATE_TAP_DELAY_MS); await send();}
        const deadlineAt = events[0]!.t + config.deadlineMs;
        let settledAt:number|null = null;
        while (!aborted && io.now() < deadlineAt) {
          await io.sleep(POLL_MS);
          const next = await observe();
          if (!next) continue;
          o = next;
          if (o.screen === 'approval') {aborted = 'consent-boundary'; break;}
          absorb(o);
          if (answers > 0) {settledAt ??= io.now(); if (io.now() - settledAt >= SETTLE_MS) break;}
        }
      }
    }
  } finally {
    if (config.record) recording = await driver.stopRecording().catch(() => null);
  }
  const log = parseRemoteJourneyLog({schemaVersion:1, metric:config.metric, nonce:config.nonce, deadlineMs:config.deadlineMs, events});
  return {log, aborted, captureHash: recording ? sha256Hex(recording) : null, recording, observeErrors};
}

interface AppiumBrowser {
  execute(script:string, ...args:unknown[]):Promise<unknown>;switchContext(id:string):Promise<unknown>;
  startRecordingScreen():Promise<unknown>;stopRecordingScreen():Promise<string>;deleteSession():Promise<void>;
}
const TAP_SCRIPT = `const target=arguments[0];let el=null;
if(target==='tab-workroom')el=document.querySelector('nav.workspace-navigation button[data-workspace-tab="workroom"]');
else if(target==='workroom-send')el=document.querySelector('.ai-terminal-command-field button.ai-terminal-start');
if(!el||el.disabled)return false;el.click();return true;`;
const SESSION_SCRIPT = `return (${selectJourneySession.toString()})(document, arguments[0], (${journeySessionMatches.toString()}));`;
const TYPE_SCRIPT = `const el=document.querySelector('textarea[aria-label="워크룸 입력"]');if(!el)return false;
Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,arguments[0]);
el.dispatchEvent(new Event('input',{bubbles:true}));return true;`;

/** The only device-facing code. Skeleton: not yet run against a phone (see the header). */
export async function createAppiumJourneyDriver(config:RemoteJourneyConfig):Promise<JourneyDriver> {
  if (config.bundleId !== REMOTE_JOURNEY_DEV_BUNDLE_ID) refuse('BUNDLE_NOT_ALLOWED', 'AgentsToZ 개발 앱만 조작합니다.');
  const {remote} = await import('webdriverio');
  const url = new URL(config.appiumUrl);
  const browser = await remote({hostname:url.hostname, port:Number(url.port || 4723), path:'/', logLevel:'warn', capabilities:{
    platformName:'iOS', 'appium:automationName':'XCUITest', 'appium:udid':config.device, 'appium:bundleId':REMOTE_JOURNEY_DEV_BUNDLE_ID,
    'appium:noReset':true, 'appium:usePrebuiltWDA':true, 'appium:derivedDataPath':config.wdaDerivedDataPath,
    'appium:updatedWDABundleId':'com.intenet.agentstoz.wda.runner', 'appium:additionalWebviewBundleIds':[REMOTE_JOURNEY_DEV_BUNDLE_ID],
  } as WebdriverIO.Capabilities}) as unknown as AppiumBrowser;
  const marker = nonceAnswerMarker(config.nonce);
  return {
    async activate() {
      await browser.execute('mobile: activateApp', {bundleId: REMOTE_JOURNEY_DEV_BUNDLE_ID});
      const contexts = await browser.execute('mobile: getContexts', {waitForWebviewMs: 8_000}) as {id:string;bundleId?:string}[];
      const webview = contexts.find(c => c.id.startsWith('WEBVIEW') && c.bundleId === REMOTE_JOURNEY_DEV_BUNDLE_ID);
      if (!webview) refuse('WEBVIEW_UNAVAILABLE', '개발 앱의 웹 화면을 읽지 못했습니다. 설정 → 앱 → Safari → 고급 → 웹 인스펙터를 켜고 다시 실행하세요(끝나면 끄세요).');
      await browser.switchContext(webview!.id);
    },
    async observe() {
      return await browser.execute(`return (${observeJourneyPage.toString()})(document, sessionStorage, arguments[0], arguments[1]);`,
        marker, UNSUPPORTED_SUBMISSION_NOTICE) as JourneyObservation;
    },
    async tap(target) {
      if (target === 'workroom-session') {
        const result = await browser.execute(SESSION_SCRIPT, config.project);
        if (result === 'missing') refuse('WORKROOM_SESSION_NOT_FOUND', `--project ${config.project}의 실행 중인 워크룸 세션이 없습니다. 탭 이름(「프로젝트 · AI」)과 정확히 같은 이름을 주세요.`);
        if (result === 'ambiguous') refuse('WORKROOM_SESSION_AMBIGUOUS', `--project ${config.project}에 맞는 세션이 둘 이상입니다. 탭 이름 전체(예: 「${config.project} · codex #2」)를 주세요.`);
        if (result !== 'selected') throw Error('TAP_TARGET_MISSING:' + target);
        return;
      }
      if (await browser.execute(TAP_SCRIPT, target) !== true) throw Error('TAP_TARGET_MISSING:' + target);
    },
    async typeDraft(text) {
      if (await browser.execute(TYPE_SCRIPT, text) !== true) throw Error('COMPOSER_MISSING');
    },
    async startRecording() {await browser.startRecordingScreen();},
    async stopRecording() {return new Uint8Array(Buffer.from(await browser.stopRecordingScreen(), 'base64'));},
    async close() {await browser.deleteSession().catch(() => undefined);},
  };
}

async function main() {
  let config:RemoteJourneyConfig;
  try {config = parseRemoteJourneyArgs(process.argv.slice(2), process.env);}
  catch (error) {
    if (error instanceof RemoteJourneyRefusal) {console.error(`${error.code}: ${error.message}`); process.exit(2);}
    throw error;
  }
  const {createInterface} = await import('node:readline/promises');
  const rl = createInterface({input:process.stdin, output:process.stdout});
  let driver:JourneyDriver|null = null;
  try {
    driver = await createAppiumJourneyDriver(config);
    const run = await runRemoteJourney(config, driver, {now:() => Date.now(), sleep:ms => Bun.sleep(ms), prompt:async message => {await rl.question(message + '\n');}});
    mkdirSync(config.outDir, {recursive:true, mode:0o700});
    const recordingFile = run.recording ? `${config.attemptId}.mp4` : null;
    if (run.recording) writeFileSync(join(config.outDir, recordingFile!), run.recording, {mode:0o600, flag:'wx'});
    const reduction = reduceRemoteJourney(run.log);
    writeFileSync(join(config.outDir, `${config.attemptId}.journey.json`), JSON.stringify({
      schema:'agentstoz-remote-journey-capture-v1', attemptId:config.attemptId, side:'candidate', bundleId:config.bundleId,
      metric:config.metric, log:run.log, logHash:sha256Hex(canonicalJson(run.log)), captureHash:run.captureHash, recordingFile,
      aborted:run.aborted, observeErrors:run.observeErrors, reduction,
    }, null, 2) + '\n', {mode:0o600, flag:'wx'});
    console.log(`${config.attemptId}: ${reduction.outcome} · latency ${reduction.latencyMs ?? '—'}ms · effort ${reduction.effortCount} · retries ${reduction.retryCount} · violations ${reduction.violations.join(',') || '없음'}${run.aborted ? ` · 중단: ${run.aborted}` : ''}`);
  } catch (error) {
    if (error instanceof RemoteJourneyRefusal) {console.error(`${error.code}: ${error.message}`); process.exitCode = 2; return;}
    throw error;
  } finally {
    await driver?.close();
    rl.close();
  }
}
if (import.meta.main) await main();
