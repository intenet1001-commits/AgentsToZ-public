/** Background native control is independent of Screen pairing, OPS and browser grants. */
export const COMPUTER_USE_PATH = '/api/agent-runtime/computer-use';
export const COMPUTER_USE_AGENT_PATH = '/api/computer-use-agent';
export const COMPUTER_USE_LIMITS = {grants: 8, lifetimeMs: 600_000, observationMs: 15_000,
  elements: 500, receipts: 64, requestBytes: 16_000, responseBytes: 512_000} as const;
/** The worker answers `bind` with this version; any other worker (with older stop/refusal semantics) is refused. */
export const COMPUTER_USE_WORKER_PROTOCOL = 2;
/** Native Control management protocol; see native/computer-use/CONTRACT.md. */
export const COMPUTER_USE_CONTROL_PROTOCOL = 1;
/** The two operations a separately installed Control must advertise before they are offered. */
export const COMPUTER_USE_SCREEN_OPERATIONS = ['capture', 'click'] as const;
/**
 * Whether a Control `status` or `open-grant` answer lists capture and click in `operations`. A Control built before them
 * sends no list: fail closed, so a main app paired with an older Control.app never offers them as ready.
 */
export const controlAdvertisesScreen = (answer: Record<string, unknown>) => Array.isArray(answer.operations)
  && answer.operations.length <= 32 && COMPUTER_USE_SCREEN_OPERATIONS.every(op => (answer.operations as unknown[]).includes(op));
export interface ComputerTarget {bundleId: string; teamId: string; codeHash: string; pid: number; processStart: string; windowId: number}
export interface ComputerElement {id: string; role: string; label: string; value: string; enabled: boolean; settable: boolean}
export interface ComputerObservation {snapshotId: string; elements: ComputerElement[]; truncated: boolean}
/** `refused`: nothing reached the target app. `unknown`: it may have; never replayed, a person reviews it. */
export type ComputerActionState = 'confirmed' | 'dispatched-unverified' | 'unknown' | 'refused' | 'human-takeover';
/**
 * Why a request was refused before any native dispatch. Anything else a worker reports becomes `worker-refused`.
 * `coordinate-unavailable`: a click point that hit nothing this observation recorded exactly. The `screen-*` codes come
 * from capture (no screen-image consent for this grant, no macOS Screen Recording permission, an image over the cap).
 * `control-update-required`: the installed AgentsToZ Control predates capture/click (see controlAdvertisesScreen).
 */
export const COMPUTER_REFUSAL_REASONS = ['stale-observation', 'unsupported-action', 'human-active', 'human-using-target-app',
  'target-changed', 'target-refused', 'permission-or-secure-input', 'worker-halted', 'native-refused',
  'coordinate-unavailable', 'screen-consent-required', 'screen-permission-required', 'screen-image-too-large',
  'control-update-required'] as const;
export type ComputerRefusalReason = typeof COMPUTER_REFUSAL_REASONS[number] | 'worker-refused';
export interface ComputerReceipt {requestId: string; state: ComputerActionState; reason?: ComputerRefusalReason}
/**
 * The Workroom session and team lane an agent request comes from. Only an authenticated transport sets it
 * (see computerUseCaller.ts); a request body can never name or change its caller.
 */
export interface ComputerCaller {sessionId: string; lane: string}
export type ComputerAgentRequest = {grant: string; epoch: number} & (
  {operation: 'observe'} | {operation: 'request-human'} |
  {operation: 'capture'; observationId: string} |
  {operation: 'click'; requestId: string; observationId: string; x: number; y: number} |
  {operation: 'receipt'; requestId: string} |
  {operation: 'press' | 'set-value'; requestId: string; observationId: string; element: string; value?: string});
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bounded = (v: unknown, max: number) => typeof v === 'string' && Buffer.byteLength(v) <= max;
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v);
/**
 * Never a target, whatever a person approves: AgentsToZ itself (app, Screen and every helper, including the one
 * that runs this control), apps that run or approve other agents' work, the shells they run in, and system security
 * surfaces. Bundle IDs are the ones verified on a Mac (2026-10-27), not guesses about other apps; the helper's
 * native approval stays the primary gate. Mirrored by `RefusedTargets` in
 * native/computer-use/Sources/ComputerUseControlCore/ControlProtocol.swift; it also refuses everything the v2 scope
 * protects. Both sides must equal native/computer-use/Tests/ControlContract/protected-targets.json.
 */
export const COMPUTER_USE_REFUSED_BUNDLES: readonly string[] = [
  'com.intenet.agentstozbycs',
  'com.openai.codex', 'com.openai.atlas', 'com.anthropic.claudefordesktop', 'com.nousresearch.hermes',
  'com.google.antigravity', 'com.stablyai.orca', 'com.cmuxterm.app', 'com.googlecode.iterm2', 'com.apple.Terminal',
  'com.apple.systempreferences', 'com.apple.keychainaccess', 'com.apple.Passwords', 'com.apple.loginwindow',
  'com.apple.SecurityAgent', 'com.apple.SecurityAgentHelper.arm64', 'com.apple.SecurityAgentHelper.x86_64',
  'com.apple.authorizationhost', 'com.apple.WindowServer', 'com.apple.UserNotificationCenter',
  'com.apple.coreservices.uiagent', 'com.apple.LocalAuthentication.UIAgent', 'com.apple.LocalAuthenticationRemoteService',
  'com.apple.CertificateAssistant', 'com.apple.EscrowSecurityAlert', 'com.apple.security.Keychain-Circle-Notification'];
export const COMPUTER_USE_REFUSED_BUNDLE_PREFIXES: readonly string[] = ['com.intenet.agentstozbycs.', 'com.apple.SecurityAgent'];
/** The AgentsToZ Developer ID team: anything it signs (app, Screen, helpers) is refused by signature, not name. */
export const COMPUTER_USE_REFUSED_TEAMS: readonly string[] = ['DA8QKAQ2C9'];
export function isRefusedComputerTarget(t: {bundleId: string; teamId: string}) {
  const bundle = t.bundleId.toLowerCase();
  return COMPUTER_USE_REFUSED_BUNDLES.some(b => b.toLowerCase() === bundle)
    || COMPUTER_USE_REFUSED_BUNDLE_PREFIXES.some(p => bundle.startsWith(p.toLowerCase()))
    || COMPUTER_USE_REFUSED_TEAMS.includes(t.teamId);
}
export function parseComputerTarget(v: unknown): ComputerTarget {
  if (!plain(v) || Object.keys(v).some(k => !['bundleId','teamId','codeHash','pid','processStart','windowId'].includes(k))
    || !bounded(v.bundleId, 200) || !/^[A-Za-z0-9.-]+$/.test(v.bundleId as string)
    || typeof v.teamId !== 'string' || !/^(?:[A-Z0-9]{10})?$/.test(v.teamId)
    || typeof v.codeHash !== 'string' || !/^[a-f0-9]{40,64}$/.test(v.codeHash)
    || !Number.isSafeInteger(v.pid) || Number(v.pid) <= 0
    || typeof v.processStart !== 'string' || !/^[1-9][0-9]{0,19}$/.test(v.processStart)
    || !Number.isSafeInteger(v.windowId) || Number(v.windowId) <= 0 || Number(v.windowId) > 0xffffffff)
    throw Error('컴퓨터 제어 대상을 다시 선택하세요.');
  if (isRefusedComputerTarget(v as {bundleId: string; teamId: string}))
    throw Error('이 앱은 컴퓨터 제어 대상으로 허용하지 않습니다.');
  return v as unknown as ComputerTarget;
}
export function parseComputerCaller(v: unknown): ComputerCaller {
  if (!plain(v) || Object.keys(v).some(k => !['sessionId','lane'].includes(k))
    || typeof v.sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(v.sessionId)
    || typeof v.lane !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v.lane))
    throw Error('컴퓨터 제어를 요청한 작업 세션을 확인하지 못했습니다.');
  return {sessionId: v.sessionId, lane: v.lane};
}
export const sameComputerCaller = (a: ComputerCaller, b: ComputerCaller) => a.sessionId === b.sessionId && a.lane === b.lane;
export function parseComputerAgentRequest(v: unknown): ComputerAgentRequest {
  const invalid = () => {throw Error('컴퓨터 제어 요청이 올바르지 않습니다.');};
  if (!plain(v) || typeof v.grant !== 'string' || !/^[a-f0-9]{64}$/.test(v.grant)
    || !Number.isSafeInteger(v.epoch) || Number(v.epoch) < 1) return invalid();
  const base = ['grant','epoch','operation'];
  if (v.operation === 'observe' || v.operation === 'request-human') {
    if (Object.keys(v).some(k => !base.includes(k))) return invalid();
  } else if (v.operation === 'receipt') {
    if (!id(v.requestId) || Object.keys(v).some(k => ![...base,'requestId'].includes(k))) return invalid();
  } else if (v.operation === 'capture') {
    if (!id(v.observationId) || Object.keys(v).some(k => ![...base,'observationId'].includes(k))) return invalid();
  } else if (v.operation === 'click') {
    if (!id(v.requestId) || !id(v.observationId) || typeof v.x !== 'number' || typeof v.y !== 'number'
      || !Number.isFinite(v.x) || !Number.isFinite(v.y) || v.x < 0 || v.y < 0 || v.x > 100000 || v.y > 100000
      || Object.keys(v).some(k => ![...base,'requestId','observationId','x','y'].includes(k))) return invalid();
  } else if (v.operation === 'press' || v.operation === 'set-value') {
    if (!id(v.requestId) || !id(v.observationId) || !bounded(v.element, 160)
      || !/^[A-Za-z0-9_-]+$/.test(v.element as string)
      || Object.keys(v).some(k => ![...base,'requestId','observationId','element',...(v.operation === 'set-value' ? ['value'] : [])].includes(k))
      || v.operation === 'set-value' && (!bounded(v.value, 4000) || (v.value as string).includes('\0'))) return invalid();
  } else return invalid();
  return v as unknown as ComputerAgentRequest;
}
