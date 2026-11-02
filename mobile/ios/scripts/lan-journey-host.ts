#!/usr/bin/env bun
/**
 * J1-LAN-APP's host (design docs/design/emulator-e2e-2026-11-01/DESIGN.md §3 J1-LAN-APP): the real AgentsToZMobile app in
 * an owned simulator pairs over the same-network QR path with this host and drives project list → start → workroom →
 * command → output → background (real socket drop) / restore → explicit disconnect → consumed-QR replay.
 *
 *   bun --env-file=/dev/null mobile/ios/scripts/lan-journey-host.ts probe [--address <en0 IPv4>]
 *       Whether the journey can run on this Mac, before anything is built: a private IPv4 on en0 and the macOS
 *       application firewall off (with it on, a bun listener on en0 may raise an 「incoming connections」 prompt that
 *       nobody may answer). Prints one JSON line {available, address?, reason?, firewall}. Exit 0 available, 78 blocked.
 *       Binds nothing.
 *   bun --env-file=/dev/null mobile/ios/scripts/lan-journey-host.ts supervise --evidence-dir <dir> [--address <en0 IPv4>] [--port <n>]
 *       What check-ui.py runs in its normal simulator lane, right before the tests. Unsandboxed and it imports **no host
 *       code** (src/): it re-checks en0 and the firewall, picks the port on <en0> at that moment (design §2.5; a port in use
 *       by the time the host binds is retried with a fresh one, up to MAX_PORT_ATTEMPTS), writes the WP1 sandbox profile
 *       (scripts/emulator-e2e/sandbox.ts — writes only to its scratch and the evidence folder, no outbound connection, LAN
 *       inbound on exactly that port), holds the LAN binding guard for it (the profile cannot name the en0 address; the
 *       guard stops anything listening on that port off <en0>), builds the allowlisted environment from empty, starts
 *       `serve` under sandbox-exec with a stdin pipe (the host stops when it closes), prints ONE ready line (no token) and
 *       stops the host when its own stdin closes (check-ui.py closes it, or dies). It then judges the receipts
 *       (evaluateJourneyReceipts) and writes host-verdict.json. Exit 0 clean, 1 failed, 78 blocked (no private IPv4 on
 *       en0 — no public/wildcard fallback — or the firewall is on).
 *   bun … lan-journey-host.ts serve --journey-dir <dir> --evidence-dir <dir> --address <ip> --port <n>
 *       The host itself. Refuses to start unless the OS confirms a sandbox that also refuses a write into the worktree.
 *       Real RemoteControlLanServer on <ip>:<port>, a recording gateway (fixture A: start/stop recorded, nothing runs;
 *       fixture B: no actions), AiTerminalService over a fake CLI in the scratch HOME, and a consent toggle the XCUITest
 *       drives through the control folder (scriptedApproval). The one-time pairing URL goes only to
 *       <journey>/pairing-url (0600); it never reaches stdout, a log or a receipt. A transport tap around the listener's
 *       own handlers records page loads, pair/restore/end messages and close codes (never a token). It stops on SIGTERM,
 *       when its stdin (the supervisor's pipe) closes, when its parent changes, or after HOST_LIFETIME_MS.
 *
 * Control protocol (the test runner in the simulator reads and writes these host paths): the test writes
 * `<journey>/control/NN-<phase>.json`; the host checks its own state for that phase (phaseProblems), acts (the
 * `consent-required` phase grants the workroom consent; `backgrounded` restarts the listener keeping its record, which
 * drops the page's socket with 1012 the way a Mac restart does) and answers `NN-<phase>.ack.json` = {phase, ok,
 * problems, snapshot}. Every step is a receipt in `<evidence>/host-receipts.jsonl`.
 */
import {appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {networkInterfaces} from 'node:os';
import {dirname, join, resolve} from 'node:path';

export const LAN_JOURNEY_SCRIPT = 'mobile/ios/scripts/lan-journey-host.ts';
export const BLOCKED_EXIT = 78;
/** serve's exit when its port was taken between the supervisor's pick and its own bind (EX_TEMPFAIL): try another. */
export const PORT_IN_USE_EXIT = 75;
export const MAX_PORT_ATTEMPTS = 3;
/** The host's own deadline for the phone's journey (check-ui's test step is 600 s; the host outlives it). */
export const PAIRING_TTL_MS = 30 * 60_000;
/** serve stops by itself this long after it started, whatever its supervisor does (en0 is open only while the run lasts). */
export const HOST_LIFETIME_MS = PAIRING_TTL_MS + 2 * 60_000;
export const FIXTURE_PROJECTS = Object.freeze({a: 'fixture-A', b: 'fixture-B'});
export const FIXTURE_NAMES = Object.freeze({a: 'Fixture project A', b: 'Fixture project B'});
/**
 * Fixture A's card port. The core drops a card that offers start/stop without a port (sanitizeRegisteredTargets), so A
 * carries one. It is a label only: the fixture gateway never binds, probes or connects to it, and it is none of the
 * harness's reserved ports.
 */
export const FIXTURE_DISPLAY_PORT = 45173;

/** The two registered projects the host lists: A can be started and stopped (fake gateway), B only opens a workroom. */
export function fixtureRegisteredProjects(running: boolean, folders: {a: string; b: string}) {
  return [
    {internalId: FIXTURE_PROJECTS.a, name: FIXTURE_NAMES.a, kind: 'main' as const, status: running ? 'running' as const : 'stopped' as const, port: FIXTURE_DISPLAY_PORT, command: null, folderPath: folders.a, actions: ['start', 'stop'] as const},
    {internalId: FIXTURE_PROJECTS.b, name: FIXTURE_NAMES.b, kind: 'main' as const, status: 'unknown' as const, port: null, command: null, folderPath: folders.b, actions: [] as const},
  ];
}
export const FAKE_CLI = '#!/bin/sh\nstty -echo\nprintf "REMOTE_READY\\n"\nwhile IFS= read -r line; do printf "RESULT:%s\\n" "$line"; done\n';
export const JOURNEY_COMMAND = 'hello';
export const JOURNEY_RESULT = `RESULT:${JOURNEY_COMMAND}`;
/**
 * The phases test20 walks through, in order. `backgrounded` is written while the app is in the background: the host
 * restarts its listener keeping its record (close 1012), so the page's socket really drops — a 3-second simulator
 * background never drops it by itself (LANWorkroomSession.end(.background) keeps the page) — and `resumed` can only pass
 * through the page's own session.restore.
 */
export const JOURNEY_PHASES = Object.freeze(['listed', 'started', 'consent-required', 'sent', 'output-seen', 'backgrounded', 'resumed', 'disconnected', 'replayed', 'done'] as const);
export type JourneyPhase = typeof JOURNEY_PHASES[number];
export const RECEIPTS_FILE = 'host-receipts.jsonl';
export const VERDICT_FILE = 'host-verdict.json';
export const SUMMARY_FILE = 'host-summary.json';

// ───────────────────────── pure parts (unit-tested) ─────────────────────────

const PAIR_TOKEN = /#pair=[^\s"'&]+/g;
export function redactPairTokens(text: string): string {
  return text.replace(PAIR_TOKEN, '#pair=<redacted>');
}

/** `NN-<phase>.json` (a request) → its sequence and phase. Acks, temporaries and unknown phases are not requests. */
export function parseControlRequestName(name: string): {sequence: number; phase: JourneyPhase} | null {
  const match = /^(\d{2})-([a-z-]+)\.json$/.exec(name);
  if (!match) return null;
  const phase = match[2] as JourneyPhase;
  if (!(JOURNEY_PHASES as readonly string[]).includes(phase)) return null;
  return {sequence: Number(match[1]), phase};
}

export function controlAckName(sequence: number, phase: JourneyPhase): string {
  return `${String(sequence).padStart(2, '0')}-${phase}.ack.json`;
}

const PRIVATE_IPV4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];
/** A cheap pre-check for the supervisor (no host code here). The sandboxed host re-checks with isPrivateRemoteControlIpv4. */
export function looksPrivateIpv4(address: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address) && PRIVATE_IPV4.some(pattern => pattern.test(address));
}

type InterfaceRows = Record<string, Array<{address: string; family: string | number; internal: boolean}> | undefined>;

/**
 * The en0 private IPv4 this journey binds to (design §2.5: found at run time, never hard-coded). A requested address
 * must be one of en0's. No en0 private address → null (blocked; no public or wildcard fallback).
 */
export function pickEn0Address(interfaces: InterfaceRows, requested?: string): {address: string | null; reason?: string} {
  const en0 = (interfaces.en0 ?? []).filter(row => (row.family === 'IPv4' || row.family === 4) && !row.internal && looksPrivateIpv4(row.address)).map(row => row.address);
  if (requested !== undefined) {
    if (!en0.includes(requested)) return {address: null, reason: `--address ${requested} is not a private IPv4 address of en0 (en0 has: ${en0.join(', ') || 'none'})`};
    return {address: requested};
  }
  if (!en0.length) return {address: null, reason: 'no private IPv4 address on en0: the LAN host has nothing to bind (no public or wildcard fallback)'};
  return {address: en0[0]!};
}

/** `socketfilterfw --getglobalstate` / `--getblockall` output (null: could not be read). Same shape as preflight's capabilities.firewall. */
export interface FirewallState {globalState: string | null; blockAll: string | null; stealthMode?: string | null}

/**
 * Why the journey must not bind en0 with this firewall state, or null when it may. With the macOS application firewall on,
 * a bun listener on en0 may raise an 「accept incoming connections」 prompt on the person's desktop; nobody answers Mac OS
 * prompts (design §2.6), so the run is blocked instead. Only a state that clearly reads off passes: an unreadable or
 * unrecognised one counts as on.
 */
export function firewallBlockReason(firewall: FirewallState | null | undefined): string | null {
  const global = firewall?.globalState ?? null;
  if (global === null) return 'the macOS application firewall state could not be read: binding en0 could raise a prompt nobody may answer';
  const state = /State\s*=\s*(\d+)/.exec(global)?.[1];
  const off = state !== undefined ? state === '0' : /\bdisabled\b/i.test(global) && !/\benabled\b|\bblocking\b/i.test(global);
  if (!off) return `the macOS application firewall is on (${global.trim().slice(0, 120)}): a listener on en0 may raise an incoming-connections prompt nobody may answer`;
  const blockAll = firewall?.blockAll ?? null;
  if (blockAll !== null && /\benabled\b/i.test(blockAll) && !/\bdisabled\b/i.test(blockAll)) {
    return `the macOS application firewall blocks all incoming connections (${blockAll.trim().slice(0, 120)})`;
  }
  return null;
}

/** Reads the application firewall (read-only; no sudo, no change). */
export function readFirewallState(): FirewallState {
  const tool = '/usr/libexec/ApplicationFirewall/socketfilterfw';
  if (process.platform !== 'darwin' || !existsSync(tool)) return {globalState: null, blockAll: null, stealthMode: null};
  const read = (flag: string) => {
    const out = Bun.spawnSync([tool, flag], {stdout: 'pipe', stderr: 'ignore', env: {PATH: '/usr/bin:/bin'}});
    return out.exitCode === 0 ? out.stdout.toString().trim() : null;
  };
  return {globalState: read('--getglobalstate'), blockAll: read('--getblockall'), stealthMode: read('--getstealthmode')};
}

export interface ProbeArgs {mode: 'probe'; address?: string}
export interface SuperviseArgs {mode: 'supervise'; evidenceDir: string; address?: string; port?: number; keepScratch: boolean}
export interface ServeArgs {mode: 'serve'; journeyDir: string; evidenceDir: string; address: string; port: number}

export function parseHostArgs(argv: readonly string[]): ProbeArgs | SuperviseArgs | ServeArgs {
  const [mode, ...rest] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index]!;
    if (key === '--keep-scratch') { flags.add(key); continue; }
    if (!['--evidence-dir', '--address', '--port', '--journey-dir'].includes(key)) throw new Error(`unknown argument ${key}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`);
    if (values.has(key)) throw new Error(`${key} given twice`);
    values.set(key, value);
    index++;
  }
  const port = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) throw new Error(`--port must be 1024–65535 (got ${value})`);
    if ([3001, 52741, 4723].includes(parsed)) throw new Error(`--port ${parsed} is reserved (installed sidecar / real Screen / Appium)`);
    return parsed;
  };
  if (mode === 'probe') {
    if (flags.size || [...values.keys()].some(key => key !== '--address')) throw new Error('probe takes only --address');
    const address = values.get('--address');
    if (address !== undefined && !looksPrivateIpv4(address)) throw new Error(`--address must be a private IPv4 address (got ${address})`);
    return {mode, ...(address ? {address} : {})};
  }
  const evidenceDir = values.get('--evidence-dir');
  if (!evidenceDir) throw new Error('--evidence-dir is required');
  if (mode === 'supervise') {
    if (values.has('--journey-dir')) throw new Error('--journey-dir belongs to serve');
    const address = values.get('--address');
    if (address !== undefined && !looksPrivateIpv4(address)) throw new Error(`--address must be a private IPv4 address (got ${address})`);
    return {mode, evidenceDir, ...(address ? {address} : {}), ...(values.has('--port') ? {port: port(values.get('--port'))} : {}), keepScratch: flags.has('--keep-scratch')};
  }
  if (mode === 'serve') {
    const journeyDir = values.get('--journey-dir');
    const address = values.get('--address');
    const servePort = port(values.get('--port'));
    if (!journeyDir || !address || servePort === undefined) throw new Error('serve needs --journey-dir, --address and --port');
    if (flags.size) throw new Error('--keep-scratch belongs to supervise');
    return {mode, journeyDir, evidenceDir, address, port: servePort};
  }
  throw new Error('usage: lan-journey-host.ts probe [--address <en0 IPv4>] | supervise --evidence-dir <dir> [--address <en0 IPv4>] [--port <n>] | serve …');
}

/** The host's state, as the control acks and the phase checks see it. */
export interface HostSnapshot {
  sessions: number;
  connected: number;
  /**
   * Distinct paired controllers seen so far (status().sessions[].controllerId — a hash of the session token, stable
   * across the socket restore after background/foreground). A second one means a second pairing was consumed.
   */
  controllers: number;
  /**
   * Distinct management ids seen. The host rotates one on every restore: the listener restart brings the session back
   * detached under a new id, and the page's session.restore moves it to its new socket under another.
   */
  managementIds: number;
  pairingPending: boolean;
  projectStarts: number;
  projectActions: number;
  terminalStarts: number;
  terminalInputs: number;
  bypassStarts: number;
  consentRefusals: number;
  consentGranted: boolean;
  transcriptHasResult: boolean;
  readDeliveredResult: boolean;
  /** Listener restarts that kept the record (the scripted drop during `backgrounded`). */
  restarts: number;
  /** From the transport tap: `/remote/` page loads the host served (200). */
  pageLoads: number;
  /** controller.pair messages (one per QR/URL the page presented). */
  pairAttempts: number;
  /** controller.pair sockets the host closed with 1008 and a pairing error (consumed, expired or wrong token). */
  pairRefusals: number;
  /** session.restore messages (the page resuming its stored session on a new socket). */
  restores: number;
  /** session.end messages (the page telling the Mac it is leaving for good). */
  sessionEnds: number;
}

/**
 * What the host must see at each phase. Empty = as expected. `earlier` holds the snapshot each earlier phase was judged
 * on: `resumed` and `replayed` are judged on what changed since `backgrounded` and `disconnected`.
 */
export function phaseProblems(phase: JourneyPhase, s: HostSnapshot, earlier: Partial<Record<JourneyPhase, HostSnapshot>> = {}): string[] {
  const problems: string[] = [];
  const expect = (condition: boolean, text: string) => { if (!condition) problems.push(text); };
  const oneController = () => {
    expect(s.controllers === 1, `expected exactly one paired controller so far, saw ${s.controllers}`);
  };
  const workUnchanged = (when: string) => expect(s.projectStarts === 1 && s.projectActions === 1 && s.terminalStarts === 1 && s.terminalInputs === 1,
    `${when} changed the execution counts (project starts ${s.projectStarts} in ${s.projectActions} action(s), terminal starts ${s.terminalStarts}, inputs ${s.terminalInputs})`);
  switch (phase) {
    case 'listed':
      expect(s.sessions === 1 && s.connected === 1, `expected one connected LAN session, saw ${s.sessions} (${s.connected} connected)`);
      oneController();
      expect(!s.pairingPending, 'the one-time pairing is still pending after the phone listed the projects');
      expect(s.projectActions === 0, `a project action ran before the phone asked (${s.projectActions})`);
      expect(s.pageLoads >= 1, 'the host served no /remote/ page');
      expect(s.pairAttempts === 1 && s.pairRefusals === 0, `expected one accepted pairing, saw ${s.pairAttempts} attempt(s) and ${s.pairRefusals} refusal(s)`);
      break;
    case 'started':
      expect(s.projectStarts === 1 && s.projectActions === 1, `expected exactly one fixture-A start, saw ${s.projectStarts} start(s) in ${s.projectActions} action(s)`);
      break;
    case 'consent-required':
      expect(s.consentRefusals >= 1, 'the phone reported 「허용 필요」 but the host refused no workroom request for missing consent');
      expect(!s.consentGranted, 'workroom consent was already granted before the phone showed it was needed');
      expect(s.terminalStarts === 0, `a terminal started before consent (${s.terminalStarts})`);
      break;
    case 'sent':
      expect(s.terminalStarts === 1, `expected exactly one terminal start, saw ${s.terminalStarts}`);
      expect(s.bypassStarts === 0, 'the terminal start asked for bypassPermissions');
      expect(s.terminalInputs === 1, `expected exactly one terminal input, saw ${s.terminalInputs}`);
      expect(s.transcriptHasResult, `the fake CLI transcript has no ${JOURNEY_RESULT}`);
      break;
    case 'output-seen':
      expect(s.readDeliveredResult, `no terminal read delivered ${JOURNEY_RESULT} to the phone`);
      break;
    case 'backgrounded':
      // Judged right after the restart: the session is kept (record) but no socket is attached — the drop is real.
      expect(s.restarts === 1, `expected exactly one listener restart while the app was in the background, saw ${s.restarts}`);
      expect(s.sessions === 1 && s.connected === 0, `after the restart expected the one session kept and detached, saw ${s.sessions} (${s.connected} connected)`);
      oneController();
      expect(s.pairAttempts === 1, `a pairing was attempted again before the restore (${s.pairAttempts} attempt(s))`);
      break;
    case 'resumed': {
      const before = earlier.backgrounded;
      expect(before !== undefined, 'resumed without a backgrounded phase (no real socket drop)');
      expect(s.restarts === 1, `expected exactly one listener restart, saw ${s.restarts}`);
      expect(s.sessions === 1 && s.connected === 1, `after background → foreground expected the same one session connected again, saw ${s.sessions} (${s.connected} connected)`);
      oneController();
      expect(s.pairAttempts === 1, `the resume presented a pairing again (${s.pairAttempts} attempt(s)); it must restore the stored session`);
      if (before) {
        expect(s.restores > before.restores, 'the page sent no session.restore after the drop');
        expect(s.managementIds > before.managementIds, 'no fresh management id since the drop (the session was not restored onto a new socket)');
      }
      workUnchanged('the resume');
      break;
    }
    case 'disconnected':
      expect(s.sessions === 0, `the explicit disconnect left ${s.sessions} host session(s)`);
      oneController();
      expect(s.sessionEnds >= 1, 'the app did not tell the Mac it was leaving (no session.end)');
      expect(s.pairRefusals === 0, `a pairing was refused before the replay (${s.pairRefusals})`);
      break;
    case 'replayed': {
      const before = earlier.disconnected;
      expect(before !== undefined, 'replayed without a disconnected phase');
      expect(s.sessions === 0, `the consumed QR opened a session (${s.sessions})`);
      oneController();
      if (before) {
        // The phone reached this host with the consumed URL and the host refused it — not a load failure on the phone.
        expect(s.pageLoads > before.pageLoads, 'the host served no /remote/ page for the replayed URL (the phone never reached it)');
        expect(s.pairAttempts > before.pairAttempts, 'the replayed URL presented no pairing to the host');
        expect(s.pairRefusals > before.pairRefusals, 'the host refused no pairing for the replayed URL');
      }
      workUnchanged('the replay');
      break;
    }
    case 'done':
      break;
  }
  return problems;
}

/** Phases whose condition may still be settling on the host when the phone gets there (bounded wait, then judged). */
export const PHASE_SETTLE_MS: Readonly<Partial<Record<JourneyPhase, number>>> = Object.freeze({
  listed: 5_000, started: 5_000, sent: 15_000, 'output-seen': 10_000, resumed: 20_000, disconnected: 10_000, replayed: 5_000,
});

export interface JourneyReceipt {seq: number; at: string; kind: string; [key: string]: unknown}

export interface JourneyVerdict {
  ok: boolean;
  problems: string[];
  counts: {
    receipts: number;
    projectActions: number;
    projectStartsA: number;
    terminalStarts: number;
    terminalInputs: number;
    consentGrants: number;
    consentRefusals: number;
    listenerRestarts: number;
    sessionRestores: number;
    pairAttempts: number;
    pairRefusals: number;
    phases: string[];
  };
}

/** The whole journey from the host's receipts (supervisor and the j1-lan lane both judge with this). */
export function evaluateJourneyReceipts(receipts: readonly JourneyReceipt[], rawText: string = receipts.map(receipt => JSON.stringify(receipt)).join('\n')): JourneyVerdict {
  const problems: string[] = [];
  const of = (kind: string) => receipts.filter(receipt => receipt.kind === kind);
  if (/#pair=[A-Za-z0-9_-]{8,}/.test(rawText)) problems.push('a #pair= token reached the receipts');
  const ready = of('host.ready');
  if (ready.length !== 1) problems.push(`expected one host.ready receipt, saw ${ready.length}`);
  else if (ready[0]!.sandboxed !== true) problems.push('the host did not confirm its sandbox');
  if (of('host.stopped').length !== 1) problems.push('the host did not stop cleanly (no host.stopped receipt)');
  for (const failure of of('host.error')) problems.push(`host error: ${String(failure.message ?? '').slice(0, 300)}`);

  const actions = of('gateway.action');
  const startsA = actions.filter(receipt => receipt.action === 'start' && receipt.target === FIXTURE_PROJECTS.a);
  if (startsA.length !== 1) problems.push(`expected exactly one fixture-A start, saw ${startsA.length}`);
  if (actions.length !== startsA.length) problems.push(`unexpected project actions: ${actions.filter(receipt => !startsA.includes(receipt)).map(receipt => `${receipt.action}→${receipt.target}`).join(', ')}`);
  const actionIds = new Map<string, number>();
  for (const receipt of actions) actionIds.set(String(receipt.actionId), (actionIds.get(String(receipt.actionId)) ?? 0) + 1);
  for (const [actionId, count] of actionIds) if (count > 1) problems.push(`action ${actionId} ran ${count} times (a request with an unknown outcome must not run twice)`);

  const terminal = of('terminal.request');
  const starts = terminal.filter(receipt => receipt.operation === 'start');
  const inputs = terminal.filter(receipt => receipt.operation === 'input');
  if (starts.length !== 1) problems.push(`expected exactly one terminal start, saw ${starts.length}`);
  if (starts.some(receipt => receipt.bypassPermissions === true)) problems.push('a terminal start carried bypassPermissions');
  if (starts.some(receipt => receipt.target !== FIXTURE_PROJECTS.a)) problems.push('the terminal started on another project than fixture A');
  if (inputs.length !== 1) problems.push(`expected exactly one terminal input, saw ${inputs.length}`);
  else if (inputs[0]!.containsCommand !== true) problems.push(`the terminal input did not carry "${JOURNEY_COMMAND}"`);

  const refusals = of('terminal.refused').filter(receipt => receipt.consent === true);
  const grants = of('consent.granted');
  if (!refusals.length) problems.push('no workroom request was refused for missing consent before the grant');
  if (grants.length !== 1) problems.push(`expected one scripted consent grant, saw ${grants.length}`);
  else {
    const grant = grants[0]!;
    if (grant.scriptedApproval !== true) problems.push('the consent grant is not marked scriptedApproval');
    if (!refusals.some(refusal => refusal.seq < grant.seq)) problems.push('the consent was granted before any refusal was shown');
    if (starts.some(start => start.seq < grant.seq)) problems.push('a terminal started before the consent grant');
  }
  if (!of('transcript').some(receipt => receipt.hasResult === true)) problems.push(`the fake CLI transcript never showed ${JOURNEY_RESULT}`);
  if (!of('terminal.read').some(receipt => receipt.deliveredResult === true)) problems.push(`no terminal read delivered ${JOURNEY_RESULT} to the phone`);

  const phases = of('control.phase');
  const seen = phases.map(receipt => String(receipt.phase));
  if (seen.join(',') !== JOURNEY_PHASES.join(',')) problems.push(`phases ${seen.join(' → ') || '(none)'} ≠ ${JOURNEY_PHASES.join(' → ')}`);
  for (const receipt of phases) {
    if (receipt.ok !== true) problems.push(`phase ${String(receipt.phase)}: ${Array.isArray(receipt.problems) ? receipt.problems.join('; ') : 'not ok'}`);
  }
  // Ordering facts the phase receipts cannot show on their own.
  const seqOf = (phase: JourneyPhase) => phases.find(receipt => receipt.phase === phase)?.seq ?? Number.POSITIVE_INFINITY;
  if (inputs.some(input => input.seq > seqOf('resumed'))) problems.push('a terminal input arrived after the resume (replayed input)');
  if (starts.some(start => start.seq > seqOf('sent'))) problems.push('a terminal start arrived after the command was sent');

  // The background drop is real: one listener restart (record kept, 1012) between the output and the resume, the session
  // detached and then connected again, and the page's own session.restore in between.
  const restarts = of('lan.restart');
  const messages = of('lan.message');
  if (restarts.length !== 1) problems.push(`expected exactly one listener restart (the background drop), saw ${restarts.length}`);
  else {
    const restart = restarts[0]!;
    if (!(restart.seq > seqOf('output-seen') && restart.seq < seqOf('resumed'))) problems.push('the listener restart did not fall between the output check and the resume');
    if (restart.closeCode !== 1012) problems.push(`the listener restart closed with ${String(restart.closeCode)}, not 1012 (a restorable restart)`);
    if (restart.restoredSessions !== 1) problems.push(`the restarted listener brought back ${String(restart.restoredSessions)} session(s), not 1`);
    const timeline = of('lan.sessions').filter(receipt => receipt.seq > restart.seq && receipt.seq < seqOf('resumed'));
    const detached = timeline.find(receipt => receipt.count === 1 && receipt.connected === 0);
    if (!detached || !timeline.some(receipt => receipt.seq > detached.seq && receipt.count === 1 && receipt.connected === 1)) {
      problems.push('the session timeline shows no detached → connected transition between the restart and the resume');
    }
    if (!messages.some(receipt => receipt.type === 'session.restore' && receipt.seq > restart.seq && receipt.seq < seqOf('resumed'))) {
      problems.push('the page sent no session.restore between the restart and the resume');
    }
  }
  // One pairing, used once: presented before the list, never again until the replay, and refused then.
  const pairs = messages.filter(receipt => receipt.type === 'controller.pair');
  const firstPairs = pairs.filter(receipt => receipt.seq < seqOf('listed')).length;
  if (firstPairs !== 1) problems.push(`expected exactly one pairing before the projects were listed, saw ${firstPairs}`);
  if (pairs.some(receipt => receipt.seq > seqOf('listed') && receipt.seq < seqOf('disconnected'))) problems.push('a pairing was presented again before the disconnect (the resume must restore, not pair)');
  if (!messages.some(receipt => receipt.type === 'session.end' && receipt.seq > seqOf('resumed') && receipt.seq < seqOf('disconnected'))) {
    problems.push('the app sent no session.end before the disconnect check');
  }
  const pairRefusals = of('lan.pair').filter(receipt => receipt.outcome === 'refused');
  const inReplay = (receipt: JourneyReceipt) => receipt.seq > seqOf('disconnected') && receipt.seq < seqOf('replayed');
  if (pairRefusals.some(receipt => receipt.seq < seqOf('disconnected'))) problems.push('a pairing was refused before the replay');
  if (!pairRefusals.some(inReplay)) problems.push('no refused-pair receipt for the replayed consumed URL (the host never refused it)');
  if (!of('lan.page').some(receipt => receipt.status === 200 && inReplay(receipt))) problems.push('the host served no page for the replayed URL (the phone never reached it)');

  return {
    ok: problems.length === 0,
    problems,
    counts: {
      receipts: receipts.length,
      projectActions: actions.length,
      projectStartsA: startsA.length,
      terminalStarts: starts.length,
      terminalInputs: inputs.length,
      consentGrants: grants.length,
      consentRefusals: refusals.length,
      listenerRestarts: restarts.length,
      sessionRestores: messages.filter(receipt => receipt.type === 'session.restore').length,
      pairAttempts: pairs.length,
      pairRefusals: pairRefusals.length,
      phases: seen,
    },
  };
}

export function parseReceipts(text: string): {receipts: JourneyReceipt[]; malformed: number} {
  const receipts: JourneyReceipt[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as JourneyReceipt;
      if (typeof parsed?.kind === 'string' && typeof parsed.seq === 'number') receipts.push(parsed); else malformed++;
    } catch { malformed++; }
  }
  return {receipts, malformed};
}

export function readJourneyVerdict(evidenceDir: string): JourneyVerdict & {malformed: number} {
  let text = '';
  try { text = readFileSync(join(evidenceDir, RECEIPTS_FILE), 'utf8'); } catch {}
  const {receipts, malformed} = parseReceipts(text);
  const verdict = evaluateJourneyReceipts(receipts, text);
  if (malformed) verdict.problems.push(`${malformed} malformed receipt line(s)`);
  return {...verdict, ok: verdict.problems.length === 0, malformed};
}

// ───────────────────────── transport tap (pure; the host installs it around the listener's handlers) ─────────────────────────

export const TAPPED_MESSAGE_TYPES = Object.freeze(['controller.pair', 'session.restore', 'session.end'] as const);
export type TappedMessageType = typeof TAPPED_MESSAGE_TYPES[number];
const PAGE_PATHS = new Set(['/remote/', '/remote/index.html']);

export type TransportEvent =
  | {kind: 'page'; path: string; status: number}
  | {kind: 'message'; socket: number; type: TappedMessageType}
  | {kind: 'close'; socket: number; code: number; reason: string; pairAttempt: boolean; restoreAttempt: boolean};

/** The `type` of a client frame when it is one the journey counts; nothing else of the frame is read (it carries tokens). */
export function tappedMessageType(raw: unknown): TappedMessageType | null {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(raw));
  else if (ArrayBuffer.isView(raw)) text = new TextDecoder().decode(raw);
  else return null;
  if (text.length > 64 * 1024) return null;
  try {
    const type = (JSON.parse(text) as {type?: unknown} | null)?.type;
    return (TAPPED_MESSAGE_TYPES as readonly unknown[]).includes(type) ? type as TappedMessageType : null;
  } catch { return null; }
}

/** A close reason is kept only when it is a short plain label (the server's error codes); anything else is `<other>`. */
export function closeReasonLabel(reason: unknown): string {
  return typeof reason === 'string' && /^[A-Za-z _.-]{0,64}$/.test(reason) ? reason : '<other>';
}

/** A refused pairing: a socket that presented a pairing and was closed by the host with 1008 and a pairing error. */
export function isPairRefusal(event: TransportEvent): boolean {
  return event.kind === 'close' && event.pairAttempt && event.code === 1008 && /PAIRING/.test(event.reason);
}

type ServeOptionsShape = {fetch?: unknown; websocket?: Record<string, unknown>};

/**
 * Bun.serve options with the same handlers, observed: `/remote/` page responses, the counted client frames and every
 * close (code, labelled reason, whether that socket presented a pairing or a restore). Behaviour is unchanged — each
 * wrapper calls the original with the same arguments and returns its result; an observer error is swallowed.
 */
export function tapServeOptions<T extends ServeOptionsShape>(options: T, onEvent: (event: TransportEvent) => void, ordinals: {next: number} = {next: 0}): T {
  const fetch = options.fetch;
  const websocket = options.websocket;
  if (typeof fetch !== 'function' || !websocket) return options;
  const emit = (event: TransportEvent) => { try { onEvent(event); } catch {} };
  const sockets = new WeakMap<object, {n: number; pair: boolean; restore: boolean}>();
  const entry = (socket: object) => {
    let found = sockets.get(socket);
    if (!found) { found = {n: ++ordinals.next, pair: false, restore: false}; sockets.set(socket, found); }
    return found;
  };
  const message = websocket.message as ((...args: unknown[]) => unknown) | undefined;
  const close = websocket.close as ((...args: unknown[]) => unknown) | undefined;
  return {
    ...options,
    fetch(this: unknown, request: Request, server: unknown) {
      const response = (fetch as (...args: unknown[]) => unknown).call(this, request, server);
      try {
        const path = new URL(request.url).pathname;
        if (PAGE_PATHS.has(path) && response instanceof Response) emit({kind: 'page', path, status: response.status});
      } catch {}
      return response;
    },
    websocket: {
      ...websocket,
      message(this: unknown, socket: object, raw: unknown) {
        const type = tappedMessageType(raw);
        if (type) {
          const found = entry(socket);
          if (type === 'controller.pair') found.pair = true;
          if (type === 'session.restore') found.restore = true;
          emit({kind: 'message', socket: found.n, type});
        }
        return message?.call(this, socket, raw);
      },
      close(this: unknown, socket: object, code: number, reason: unknown) {
        const found = entry(socket);
        emit({kind: 'close', socket: found.n, code, reason: closeReasonLabel(reason), pairAttempt: found.pair, restoreAttempt: found.restore});
        return close?.call(this, socket, code, reason);
      },
    },
  };
}

// ───────────────────────── supervise (unsandboxed, no host code) ─────────────────────────

const repoRoot = resolve(import.meta.dir, '../../..');

function writeJsonFile(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
  renameSync(temporary, path);
}

/**
 * A port free on <address> right now (bound and released at once). The host binds it moments later; a port taken in
 * between makes the host exit PORT_IN_USE_EXIT, which the supervisor retries with a fresh one.
 */
function pickFreeLanPort(address: string, reserved: readonly number[]): number {
  for (let attempt = 0; attempt < 20; attempt++) {
    const probe = Bun.serve({hostname: address, port: 0, fetch: () => new Response('')});
    const candidate = probe.port ?? 0;
    probe.stop(true);
    if (candidate >= 1024 && !reserved.includes(candidate)) return candidate;
  }
  throw new Error(`could not pick a free port on ${address} for the LAN host`);
}

/** check-ui.py's pre-build question: can the journey run here? Binds nothing. */
function probe(args: ProbeArgs): number {
  const picked = pickEn0Address(networkInterfaces() as InterfaceRows, args.address);
  const firewall = readFirewallState();
  const reason = picked.address ? firewallBlockReason(firewall) : (picked.reason ?? 'no private IPv4 address on en0');
  process.stdout.write(`${JSON.stringify({available: !reason, ...(picked.address ? {address: picked.address} : {}), ...(reason ? {reason} : {}), firewall})}\n`);
  return reason ? BLOCKED_EXIT : 0;
}

async function waitForReadyFile(child: {exitCode: number | null; signalCode: unknown}, readyFile: string, timeoutMs: number): Promise<'ready' | 'exited' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(readyFile)) {
    if (child.exitCode !== null || child.signalCode !== null) return 'exited';
    if (Date.now() > deadline) return 'timeout';
    await Bun.sleep(100);
  }
  return 'ready';
}

async function supervise(args: SuperviseArgs): Promise<number> {
  // Only the harness helpers (they import nothing from src/).
  const {createIsolatedProfile, createRunScratch, buildAllowlistedEnv, RESERVED_LOOPBACK_PORTS} = await import('../../../scripts/emulator-e2e/environment');
  const {writeSandboxProfile, sandboxedArgv, startLanBindingGuard} = await import('../../../scripts/emulator-e2e/sandbox');
  mkdirSync(args.evidenceDir, {recursive: true, mode: 0o700});
  const evidenceDir = realpathSync(args.evidenceDir);
  const supervisorFile = join(evidenceDir, 'supervisor.json');
  const record: Record<string, unknown> = {state: 'starting', startedAt: new Date().toISOString(), pid: process.pid};
  const save = () => writeJsonFile(supervisorFile, record);
  const say = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);
  const blocked = (reason: string): number => {
    Object.assign(record, {state: 'blocked', reason});
    save();
    say({ready: false, blocked: reason});
    return BLOCKED_EXIT;
  };
  const picked = pickEn0Address(networkInterfaces() as InterfaceRows, args.address);
  if (!picked.address) return blocked(picked.reason ?? 'no private IPv4 address on en0');
  const address = picked.address;
  // Again right before anything binds en0: the firewall may have been turned on since check-ui.py's probe.
  const firewall = readFirewallState();
  record.firewall = firewall;
  const firewallReason = firewallBlockReason(firewall);
  if (firewallReason) return blocked(firewallReason);
  const base = createRunScratch(`lanjourney-${process.pid}`);
  const work = join(base, 'work');
  const profileDir = join(base, 'sandbox');
  mkdirSync(work, {recursive: true, mode: 0o700});
  mkdirSync(profileDir, {recursive: true, mode: 0o700});
  const isolated = createIsolatedProfile(work, 'lan-journey-host');
  const journeyDir = join(work, 'journey');
  mkdirSync(join(journeyDir, 'control'), {recursive: true, mode: 0o700});
  const env = buildAllowlistedEnv({profile: isolated});
  const portAttempts: Array<Record<string, unknown>> = [];
  Object.assign(record, {address, environmentKeys: Object.keys(env).sort(), portAttempts});

  /** One try on one port: its own profile (LAN inbound on exactly that port), its own guard, the sandboxed host. */
  const launchOn = (port: number, attempt: number) => {
    const profile = writeSandboxProfile(profileDir, `lan-journey-host-${attempt}`, {writableRoots: [work, evidenceDir], lanInbound: {port}});
    writeFileSync(join(evidenceDir, 'host.sb'), profile.text, {mode: 0o600});
    const guard = startLanBindingGuard({port, expectedAddress: address});
    Object.assign(record, {port, profileSha256: profile.sha256, deniedPorts: profile.deniedPorts, allowedLoopbackPorts: profile.allowedLoopbackPorts});
    save();
    const argv = sandboxedArgv(profile, [process.execPath, '--env-file=/dev/null', join(repoRoot, LAN_JOURNEY_SCRIPT), 'serve',
      '--journey-dir', journeyDir, '--evidence-dir', evidenceDir, '--address', address, '--port', String(port)]);
    // Neutral working folder (no .env can sit there) plus --env-file=/dev/null: both layers (CLAUDE.md runtime guard).
    // stdin is a pipe the host reads to its end: when this supervisor goes away, however it goes, the host stops too.
    const child = Bun.spawn(argv, {cwd: isolated.root, env, stdin: 'pipe', stdout: Bun.file(join(evidenceDir, 'host.log')), stderr: Bun.file(join(evidenceDir, 'host.stderr.log'))});
    return {port, profile, guard, child};
  };
  let launch: ReturnType<typeof launchOn> | null = null;

  let stopping = false;
  const stopChild = async () => {
    const child = launch?.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill('SIGTERM'); } catch {}
    const exited = await Promise.race([child.exited, Bun.sleep(20_000).then(() => null)]);
    if (exited === null) { try { child.kill('SIGKILL'); } catch {} await child.exited; }
  };
  const finish = async (state: string, reason?: string): Promise<number> => {
    stopping = true;
    await stopChild();
    const guard = launch?.guard ?? null;
    const lastLook = guard ? await guard.check() : [];
    if (guard) await guard.stop();
    const verdict = readJourneyVerdict(evidenceDir);
    const problems = [...verdict.problems];
    if (guard?.violations.length) problems.unshift(...guard.violations.map(line => `LAN binding guard: ${line}`));
    if (reason) problems.unshift(reason);
    for (const name of ['host.log', 'host.stderr.log']) {
      try { if (/#pair=[A-Za-z0-9_-]{8,}/.test(readFileSync(join(evidenceDir, name), 'utf8'))) problems.push(`#pair= token in ${name}`); } catch {}
    }
    const ok = state === 'stopped' && problems.length === 0;
    writeJsonFile(join(evidenceDir, VERDICT_FILE), {ok, state, problems, counts: verdict.counts,
      guard: {port: launch?.port ?? null, address, violations: guard?.violations ?? [], lastLook}, portAttempts,
      childExit: launch?.child.exitCode ?? null, childSignal: launch?.child.signalCode ?? null, profileSha256: launch?.profile.sha256 ?? null});
    Object.assign(record, {state: ok ? 'passed' : 'failed', finishedAt: new Date().toISOString(), childExit: launch?.child.exitCode ?? null, problems});
    save();
    if (!args.keepScratch) rmSync(base, {recursive: true, force: true});
    return ok ? 0 : 1;
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void finish('stopped', `supervisor received ${signal}`).then(code => process.exit(code)); });

  // The port is chosen now, right before the host binds it (design §2.5), not when check-ui.py started minutes earlier.
  // Taken in the moment between the pick and the bind → the host exits PORT_IN_USE_EXIT and another port is tried.
  const readyFile = join(journeyDir, 'ready.json');
  const tries = args.port === undefined ? MAX_PORT_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    const current = launchOn(args.port ?? pickFreeLanPort(address, RESERVED_LOOPBACK_PORTS), attempt);
    launch = current;
    const outcome = await waitForReadyFile(current.child, readyFile, 90_000);
    if (outcome === 'ready') { portAttempts.push({port: current.port, outcome: 'listening'}); break; }
    if (outcome === 'timeout') return finish('failed', 'the sandboxed host was not ready within 90 s');
    const inUse = current.child.exitCode === PORT_IN_USE_EXIT;
    portAttempts.push({port: current.port, outcome: inUse ? 'in-use' : 'exited', exit: current.child.exitCode, guardViolations: [...current.guard.violations]});
    if (!inUse || attempt >= tries) {
      return finish('failed', inUse
        ? `the LAN port was taken before the host could bind it, ${attempt} time(s) (${portAttempts.map(entry => entry.port).join(', ')})`
        : `the sandboxed host exited before it was ready (exit ${current.child.exitCode}, signal ${current.child.signalCode}); see host.stderr.log`);
    }
    // Nothing of ours listened on that port: its guard goes, the next port gets its own profile and guard.
    await current.guard.stop();
    try { renameSync(join(evidenceDir, 'host.stderr.log'), join(evidenceDir, `host.attempt-${attempt}.stderr.log`)); } catch {}
    launch = null;
    save();
  }
  const {port, guard, profile, child} = launch!;
  // Ready: the host wrote ready.json, and the guard sees it listening on <en0>:<port> and nothing off en0.
  await guard.check();
  if (!(await guard.listening())) return finish('failed', `the host does not listen on ${address}:${port}`);
  if (guard.violations.length) return finish('failed', 'the host listened off en0');
  record.state = 'ready';
  save();
  say({ready: true, journeyDir, address, port, profileSha256: profile.sha256});
  // Run until the owner closes stdin (check-ui.py finished, or died) or the host dies.
  const stdinClosed = (async () => { try { for await (const _ of Bun.stdin.stream()) { /* the owner sends nothing */ } } catch {} })();
  const ended = await Promise.race([stdinClosed.then(() => 'stdin' as const), child.exited.then(() => 'child' as const)]);
  if (stopping) return 0;
  if (ended === 'child') return finish('failed', `the sandboxed host exited during the journey (exit ${child.exitCode}, signal ${child.signalCode})`);
  return finish('stopped');
}

// ───────────────────────── serve (sandboxed host) ─────────────────────────

async function serve(args: ServeArgs): Promise<void> {
  const {sandboxRefusal} = await import('./checkWorkroomSupport');
  const {realHome, isWithin, isForbiddenEnvKey} = await import('../../../scripts/emulator-e2e/environment');
  const receiptsPath = join(args.evidenceDir, RECEIPTS_FILE);
  let seq = 0;
  const receipt = (kind: string, fields: Record<string, unknown> = {}) => {
    const line = redactPairTokens(JSON.stringify({seq: ++seq, at: new Date().toISOString(), kind, ...fields}));
    appendFileSync(receiptsPath, `${line}\n`, {mode: 0o600});
  };
  const fail = (message: string): never => {
    try { receipt('host.error', {message: redactPairTokens(message).slice(0, 1_000)}); } catch {}
    console.error(`REFUSED: ${redactPairTokens(message)}`);
    process.exit(1);
  };
  const refusal = sandboxRefusal(repoRoot);
  if (refusal) fail(refusal);
  const home = realHome();
  const {homedir, tmpdir} = await import('node:os');
  const {resolveAppDataDir} = await import('../../../src/appDataDir');
  for (const [label, path] of [['home', homedir()], ['app data', resolveAppDataDir()], ['temporary directory', tmpdir()]] as const) {
    let real = path;
    try { real = realpathSync(path); } catch {}
    if (isWithin(real, home)) fail(`isolated ${label} ${path} is under the real home`);
  }
  const forbidden = Object.keys(process.env).filter(key => isForbiddenEnvKey(key));
  if (forbidden.length) fail(`refusing a non-isolated environment (forbidden: ${forbidden.sort().join(', ')})`);

  const {RemoteControlLanServer, isPrivateRemoteControlIpv4} = await import('../../../src/remoteControlLanServer');
  const {AiTerminalService} = await import('../../../src/aiTerminalService');
  const {createAiTerminalRemoteGateway} = await import('../../../src/aiTerminalRemoteGateway');
  if (!isPrivateRemoteControlIpv4(args.address)) fail(`${args.address} is not a private remote-control IPv4 address`);
  const en0 = (networkInterfaces().en0 ?? []).filter(row => row.family === 'IPv4' && !row.internal).map(row => row.address);
  if (!en0.includes(args.address)) fail(`${args.address} is not an address of en0 (${en0.join(', ') || 'none'})`);

  // Fake CLI in the scratch HOME; fixture project folders in the scratch.
  const cli = join(homedir(), '.local', 'bin', 'fake-agent');
  mkdirSync(dirname(cli), {recursive: true, mode: 0o700});
  writeFileSync(cli, FAKE_CLI, {mode: 0o700});
  chmodSync(cli, 0o700);
  const folders = {a: join(args.journeyDir, '..', 'project-a'), b: join(args.journeyDir, '..', 'project-b')};
  for (const folder of Object.values(folders)) mkdirSync(folder, {recursive: true, mode: 0o700});
  const runtime = {[FIXTURE_PROJECTS.a]: 'fixture-runtime-A', [FIXTURE_PROJECTS.b]: 'fixture-runtime-B'} as Record<string, string>;

  const service = new AiTerminalService({
    resolveTarget: async (id: string) => {
      if (id === 'fixture-runtime-A') return {cwd: folders.a};
      if (id === 'fixture-runtime-B') return {cwd: folders.b};
      throw new Error('Unknown fixture target');
    },
    executable: () => cli,
  } as ConstructorParameters<typeof AiTerminalService>[0]);

  // Host state the phases are judged against.
  let running = false;
  let consentGranted = false;
  let consentRefusals = 0;
  let projectActions = 0;
  let projectStarts = 0;
  let terminalStarts = 0;
  let terminalInputs = 0;
  let bypassStarts = 0;
  let readDeliveredResult = false;
  const terminalSessions = new Set<string>();
  const controllersSeen = new Set<string>();
  const managementIdsSeen = new Set<string>();
  /** Short, token-free labels for the receipts (the controller id is already a SHA-256 of the session token). */
  const short = (value: string) => value.slice(0, 12);
  const observe = (sessions: ReadonlyArray<{id: string; controllerId: string}>) => {
    for (const session of sessions) { controllersSeen.add(session.controllerId); managementIdsSeen.add(session.id); }
  };

  // What the transport tap saw (tapServeOptions around the listener's own handlers; never a token).
  let pageLoads = 0;
  let pairAttempts = 0;
  let pairRefusals = 0;
  let restores = 0;
  let sessionEnds = 0;
  let restarts = 0;
  const socketOrdinals = {next: 0};
  const onTransport = (event: TransportEvent) => {
    if (event.kind === 'page') {
      if (event.status === 200) pageLoads++;
      receipt('lan.page', {path: event.path, status: event.status});
    } else if (event.kind === 'message') {
      if (event.type === 'controller.pair') pairAttempts++;
      if (event.type === 'session.restore') restores++;
      if (event.type === 'session.end') sessionEnds++;
      receipt('lan.message', {socket: event.socket, type: event.type});
    } else {
      receipt('lan.close', {socket: event.socket, code: event.code, reason: event.reason, pairAttempt: event.pairAttempt, restoreAttempt: event.restoreAttempt});
      if (isPairRefusal(event)) {
        pairRefusals++;
        receipt('lan.pair', {outcome: 'refused', socket: event.socket, code: event.reason});
      }
    }
  };

  const gateway = createAiTerminalRemoteGateway({
    service,
    active: () => true,
    resolve: async bindings => bindings.map(binding => ({controlId: binding.controlId, runtimeTargetId: runtime[binding.target.internalId] ?? 'unknown'})),
    consent: async () => consentGranted
      ? {targetIds: new Set(['fixture-runtime-A', 'fixture-runtime-B']), isActive: () => consentGranted, requestOwner: 'fixture-paired-device'}
      : null,
  });
  /** What the listener would persist across a restart (session tokens: kept in memory only, never written or logged). */
  let lanRecord: {sessions: NonNullable<ConstructorParameters<typeof RemoteControlLanServer>[0]['restore']>['sessions']} | null = null;
  const makeServer = (restore?: NonNullable<ConstructorParameters<typeof RemoteControlLanServer>[0]['restore']>) => new RemoteControlLanServer({
    bindAddress: args.address,
    port: args.port,
    hostName: 'Isolated LAN journey host',
    pairingTtlMs: PAIRING_TTL_MS,
    ...(restore ? {restore} : {}),
    onRecordChanged: record => { if (record) lanRecord = {sessions: record.sessions}; },
    gateway: {
      listRegisteredProjects: () => fixtureRegisteredProjects(running, folders) as never,
      executeRegisteredProjectAction: action => {
        projectActions++;
        receipt('gateway.action', {action: action.action, target: action.target.internalId, actionId: action.actionId});
        if (action.target.internalId !== FIXTURE_PROJECTS.a || !['start', 'stop'].includes(action.action)) throw new Error('Fixture project action refused');
        if (action.action === 'start') { projectStarts++; running = true; } else running = false;
      },
      listWorkspaceRoots: () => [],
    },
    terminalGateway: async (request, bindings, owner, transportActive, device, receiptOwner) => {
      const r = request as {operation: string; agent?: string; targetId?: string; bypassPermissions?: boolean; data?: string; sessionId?: string};
      const target = r.targetId ? bindings.find(binding => binding.controlId === r.targetId)?.target.internalId : undefined;
      const fields: Record<string, unknown> = {operation: r.operation, ...(r.agent ? {agent: r.agent} : {}), ...(target ? {target} : {})};
      if (r.operation === 'start') { fields.bypassPermissions = r.bypassPermissions === true; }
      if (r.operation === 'input') { fields.containsCommand = typeof r.data === 'string' && r.data.includes(JOURNEY_COMMAND); fields.bytes = new TextEncoder().encode(r.data ?? '').length; }
      try {
        const response = await gateway(request as never, bindings, owner, transportActive, device, receiptOwner) as {session?: {id?: string}; chunks?: Array<{text?: string}>};
        // Reads and lists poll every few hundred ms; only the acting operations are receipts (after the host accepted them).
        if (!['read', 'list', 'resize'].includes(r.operation)) receipt('terminal.request', fields);
        if (r.operation === 'start') { terminalStarts++; if (r.bypassPermissions === true) bypassStarts++; if (response.session?.id) terminalSessions.add(response.session.id); }
        if (r.operation === 'input') terminalInputs++;
        if (r.operation === 'read' && !readDeliveredResult && response.chunks?.some(chunk => chunk.text?.includes(JOURNEY_RESULT))) {
          readDeliveredResult = true;
          receipt('terminal.read', {deliveredResult: true});
        }
        return response as never;
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        const consent = message.includes('워크룸 작업을 허용하세요');
        if (consent) consentRefusals++;
        // A refused list repeats while the page polls; one receipt per kind of refusal per state is enough.
        if (!consent || consentRefusals <= 3) receipt('terminal.refused', {...fields, consent, message: message.slice(0, 200)});
        throw error;
      }
    },
  });
  let server = makeServer();

  /** server.start() with the transport tap around the handlers it gives Bun.serve (only for that one call). */
  const startTapped = (target: InstanceType<typeof RemoteControlLanServer>) => {
    const holder = Bun as unknown as {serve: (options: unknown) => unknown};
    const realServe = holder.serve;
    holder.serve = (options: unknown) => realServe.call(Bun, tapServeOptions(options as ServeOptionsShape, onTransport, socketOrdinals));
    try { return target.start(); } finally { holder.serve = realServe; }
  };

  let started: ReturnType<typeof startTapped>;
  try { started = startTapped(server); }
  catch (error) {
    // Taken between the supervisor's pick and this bind: no receipt (nothing ran), a distinct exit, and the supervisor
    // tries a fresh port with its own profile and guard.
    if ((error as {code?: unknown})?.code === 'EADDRINUSE') {
      console.error(`PORT_IN_USE: ${args.address}:${args.port}`);
      process.exit(PORT_IN_USE_EXIT);
    }
    throw error;
  }
  const pairingFile = join(args.journeyDir, 'pairing-url');
  writeFileSync(pairingFile, started.pairing.pairingUrl, {mode: 0o600});
  const listener = started.status.listener;
  receipt('host.ready', {address: listener?.host, port: listener?.port, sandboxed: true, pid: process.pid, pairingExpiresAt: started.status.pairing?.expiresAt ?? null});
  writeJsonFile(join(args.journeyDir, 'ready.json'), {address: listener?.host, port: listener?.port});

  const transcriptHasResult = async (): Promise<boolean> => {
    for (const sessionId of terminalSessions) {
      try {
        const read = await service.perform({requestId: crypto.randomUUID(), operation: 'read', sessionId, after: 0}) as {chunks?: Array<{text?: string}>};
        if (read.chunks?.some(chunk => chunk.text?.includes(JOURNEY_RESULT))) return true;
      } catch {}
    }
    return false;
  };
  const snapshot = async (): Promise<HostSnapshot> => {
    const status = server.status();
    observe(status.sessions);
    return {
      sessions: status.sessions.length,
      connected: status.sessions.filter(session => session.connected).length,
      controllers: controllersSeen.size,
      managementIds: managementIdsSeen.size,
      pairingPending: status.pairing !== null,
      projectStarts, projectActions, terminalStarts, terminalInputs, bypassStarts, consentRefusals, consentGranted,
      transcriptHasResult: await transcriptHasResult(),
      readDeliveredResult,
      restarts, pageLoads, pairAttempts, pairRefusals, restores, sessionEnds,
    };
  };
  // Session timeline (no tokens): every change of the set of sessions and their attachment.
  let lastSessions = '';
  const sampleSessions = () => {
    try {
      const status = server.status();
      observe(status.sessions);
      const shape = JSON.stringify(status.sessions.map(session => [session.id, session.connected]));
      if (shape !== lastSessions) {
        lastSessions = shape;
        receipt('lan.sessions', {count: status.sessions.length, connected: status.sessions.filter(session => session.connected).length,
          sessions: status.sessions.map(session => ({id: short(session.id), controller: short(session.controllerId), connected: session.connected})),
          controllers: controllersSeen.size, managementIds: managementIdsSeen.size, pairingPending: status.pairing !== null});
      }
    } catch (error) { receipt('host.error', {message: String((error as Error)?.message ?? error).slice(0, 300)}); }
  };
  const sessionTimer = setInterval(sampleSessions, 200);

  /**
   * The background drop (phase `backgrounded`): stop the listener keeping its record — every socket closes with 1012 and
   * no session.closed, as on a Mac restart — and start it again on the same address and port with that record. The
   * session comes back detached under a new management id; only the page's own session.restore attaches it again. The
   * restarted listener issues a fresh one-time pairing of its own, which goes nowhere (no file, no receipt).
   */
  const restartKeepingRecord = (): Record<string, unknown> => {
    const sessions = lanRecord?.sessions ?? [];
    const connectedBefore = server.status().sessions.filter(session => session.connected).length;
    server.stop({keepRecord: true});
    server = makeServer({sessions});
    const restarted = startTapped(server);
    restarts++;
    const fields = {closeCode: 1012, connectedBefore, recordSessions: sessions.length, restoredSessions: restarted.status.sessions.length,
      samePort: restarted.status.listener?.port === args.port};
    receipt('lan.restart', fields);
    sampleSessions();
    return fields;
  };

  const controlDir = join(args.journeyDir, 'control');
  const handled = new Set<string>();
  /** The snapshot each phase was judged on (later phases are judged on what changed since). */
  const marks: Partial<Record<JourneyPhase, HostSnapshot>> = {};
  let busy = false;
  const handlePhase = async (sequence: number, phase: JourneyPhase) => {
    const before: string[] = [];
    if (phase === 'backgrounded') {
      const now = server.status().sessions;
      if (now.length !== 1 || now.filter(session => session.connected).length !== 1) {
        before.push(`before the restart expected one connected session, saw ${now.length} (${now.filter(session => session.connected).length} connected)`);
      }
      if (restarts === 0) restartKeepingRecord(); else before.push('the listener was already restarted once');
    }
    const settle = PHASE_SETTLE_MS[phase] ?? 0;
    const deadline = Date.now() + settle;
    let state = await snapshot();
    let problems = [...before, ...phaseProblems(phase, state, marks)];
    while (problems.length && Date.now() < deadline) {
      await Bun.sleep(200);
      state = await snapshot();
      problems = [...before, ...phaseProblems(phase, state, marks)];
    }
    marks[phase] = state;
    receipt('control.phase', {phase, sequence, ok: problems.length === 0, problems, snapshot: state});
    if (phase === 'consent-required') {
      // The person's 「허용」 on the Mac, scripted (design §2.6): this connection's workroom access, nothing wider.
      const sessions = server.status().sessions;
      if (sessions.length === 1) {
        consentGranted = true;
        service.setRemoteAccess(`lan:${sessions[0]!.id}`, true);
        receipt('consent.granted', {scriptedApproval: true, session: short(sessions[0]!.id), controller: short(sessions[0]!.controllerId)});
      } else {
        problems.push(`cannot grant consent: ${sessions.length} LAN sessions`);
      }
    }
    if (phase === 'sent' && state.transcriptHasResult) receipt('transcript', {hasResult: true});
    writeJsonFile(join(controlDir, controlAckName(sequence, phase)), {phase, sequence, ok: problems.length === 0, problems, snapshot: state});
  };
  const controlTimer = setInterval(() => {
    if (busy) return;
    let names: string[];
    try { names = readdirSync(controlDir).sort(); } catch { return; }
    const next = names.map(name => ({name, parsed: parseControlRequestName(name)})).find(entry => entry.parsed && !handled.has(entry.name));
    if (!next?.parsed) return;
    handled.add(next.name);
    busy = true;
    void handlePhase(next.parsed.sequence, next.parsed.phase)
      .catch(error => receipt('host.error', {message: String((error as Error)?.message ?? error).slice(0, 500)}))
      .finally(() => { busy = false; });
  }, 150);

  let stopped = false;
  const watchers: {parent?: ReturnType<typeof setInterval>; lifetime?: ReturnType<typeof setTimeout>} = {};
  const stop = async (signal: string) => {
    if (stopped) return;
    stopped = true;
    clearInterval(controlTimer);
    clearInterval(sessionTimer);
    clearInterval(watchers.parent);
    clearTimeout(watchers.lifetime);
    const final = await snapshot().catch(() => null);
    try { server.stop(); } catch (error) { receipt('host.error', {message: `server.stop: ${String((error as Error)?.message ?? error).slice(0, 300)}`}); }
    try { await service.shutdown(); } catch (error) { receipt('host.error', {message: `service.shutdown: ${String((error as Error)?.message ?? error).slice(0, 300)}`}); }
    // The one-time pairing file goes with the host.
    rmSync(pairingFile, {force: true});
    receipt('host.stopped', {signal, final});
    writeJsonFile(join(args.evidenceDir, SUMMARY_FILE), {stoppedBy: signal, final, receipts: seq});
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void stop(signal); });
  // Never outlive the run, whatever happens to the supervisor: its stdin pipe closing (it exited or was killed), a new
  // parent (it died and this process was re-parented), or the lifetime cap.
  const parent = process.ppid;
  watchers.parent = setInterval(() => { if (process.ppid !== parent) void stop('parent-gone'); }, 1_000);
  watchers.lifetime = setTimeout(() => { void stop('lifetime'); }, HOST_LIFETIME_MS);
  void (async () => {
    try { for await (const _ of Bun.stdin.stream()) { /* the supervisor sends nothing */ } } catch {}
    void stop('stdin-closed');
  })();
  console.log(`LAN journey host listening on ${listener?.host}:${listener?.port} (pairing in the journey folder only)`);
}

if (import.meta.main) {
  let parsed: ProbeArgs | SuperviseArgs | ServeArgs;
  try { parsed = parseHostArgs(process.argv.slice(2)); }
  catch (error) { console.error(String((error as Error)?.message ?? error)); process.exit(2); }
  if (parsed.mode === 'probe') process.exit(probe(parsed));
  if (parsed.mode === 'supervise') process.exit(await supervise(parsed));
  await serve(parsed);
}
