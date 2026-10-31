import {createPublicKey, randomBytes, verify, type KeyObject} from 'node:crypto';
import {parseComputerCaller, parseComputerTarget, sameComputerCaller, type ComputerCaller, type ComputerTarget} from './computerUseProtocol';
import {computerCallerGeneration, isLiveComputerCallerGeneration, type AuthenticatedComputerCaller} from './computerUseCaller';

/** First line of the bytes the signed helper signs. Mirrored in native/computer-use/Sources/ComputerUseApproval. */
export const COMPUTER_USE_APPROVAL_VERSION = 'agentstoz-computer-use-approval/v1';
/** `approvalMs`: how long a request waits for the person (10 min; native ControlLimits.approvalMs). */
export const COMPUTER_USE_APPROVAL_LIMITS = {pending: 8, approvalMs: 600_000, skewMs: 5_000} as const;
const L = COMPUTER_USE_APPROVAL_LIMITS;
/** What the host asks the helper to show: one exact target for one authenticated caller, until `expiresAt`. */
export interface ComputerApprovalRequest {approvalId: string; target: ComputerTarget; caller: ComputerCaller; expiresAt: number}
/** The helper's answer after its own native confirmation and LocalAuthentication. */
export interface ComputerApproval extends ComputerApprovalRequest {issuedAt: number; signature: string}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const APPROVAL_KEYS = ['approvalId', 'target', 'caller', 'expiresAt', 'issuedAt', 'signature'];
const DENIED = '사람 승인을 확인하지 못했습니다. 컴퓨터 유즈 도우미에서 다시 승인해야 합니다.';
const NO_KEY = 'AgentsToZ Control의 승인 키를 확인하지 못해 허용하지 않았습니다. 승인 상태를 다시 읽은 뒤 시도하세요.';
export function parseComputerApproval(v: unknown): ComputerApproval {
  if (!plain(v) || Object.keys(v).length !== APPROVAL_KEYS.length || Object.keys(v).some(k => !APPROVAL_KEYS.includes(k))
    || typeof v.approvalId !== 'string' || !/^[a-f0-9]{64}$/.test(v.approvalId)
    || !Number.isSafeInteger(v.issuedAt) || Number(v.issuedAt) < 0 || !Number.isSafeInteger(v.expiresAt) || Number(v.expiresAt) <= 0
    || typeof v.signature !== 'string' || !/^[A-Za-z0-9+/]{16,200}={0,2}$/.test(v.signature)) throw Error(DENIED);
  return {approvalId: v.approvalId, target: parseComputerTarget(v.target), caller: parseComputerCaller(v.caller),
    issuedAt: Number(v.issuedAt), expiresAt: Number(v.expiresAt), signature: v.signature};
}
/**
 * The exact bytes signed. Every value is first validated to a closed character set (see the parsers), so no value
 * can add, remove or split a line. Field order is fixed.
 */
export function computerApprovalBytes(a: Omit<ComputerApproval, 'signature'>): Buffer {
  const t = parseComputerTarget(a.target), c = parseComputerCaller(a.caller);
  if (!/^[a-f0-9]{64}$/.test(a.approvalId) || !Number.isSafeInteger(a.issuedAt) || a.issuedAt < 0
    || !Number.isSafeInteger(a.expiresAt) || a.expiresAt <= 0) throw Error(DENIED);
  return Buffer.from([COMPUTER_USE_APPROVAL_VERSION, `approval=${a.approvalId}`, `bundle=${t.bundleId}`, `team=${t.teamId}`,
    `code=${t.codeHash}`, `pid=${t.pid}`, `start=${t.processStart}`, `window=${t.windowId}`, `session=${c.sessionId}`,
    `lane=${c.lane}`, `issued=${a.issuedAt}`, `expires=${a.expiresAt}`].join('\n') + '\n', 'utf8');
}
/** The helper's P-256 public key as its uncompressed X9.63 point (65 bytes), as `SecKeyCopyExternalRepresentation` gives it. */
export function computerApprovalKey(point: Uint8Array): KeyObject {
  const p = Buffer.from(point);
  if (p.length !== 65 || p[0] !== 4) throw Error('컴퓨터 유즈 도우미 공개키가 올바르지 않습니다.');
  return createPublicKey({key: {kty: 'EC', crv: 'P-256', x: p.subarray(1, 33).toString('base64url'),
    y: p.subarray(33).toString('base64url')}, format: 'jwk'});
}
export function verifyComputerApprovalSignature(a: ComputerApproval, key: KeyObject): boolean {
  try {return verify('sha256', computerApprovalBytes(a), {key, dsaEncoding: 'der'}, Buffer.from(a.signature, 'base64'));}
  catch {return false;}
}
const sameTarget = (a: ComputerTarget, b: ComputerTarget) =>
  (['bundleId', 'teamId', 'codeHash', 'pid', 'processStart', 'windowId'] as const).every(k => a[k] === b[k]);

/**
 * Host side of the human approval. `request` opens one approval for an authenticated caller and an exact target;
 * the signed helper resolves that target itself, shows its own native confirmation, asks LocalAuthentication and
 * signs the canonical bytes with a key that needs the person's presence. `redeem` accepts that answer once, before it
 * expires, only for the request it answers and only under the helper key given here. That key must come from the
 * code-signing-verified helper connection, never from disk, the environment or an agent. No boolean is evidence of
 * approval, and this class cannot prove the person saw the dialog: the helper and its installed signature do.
 */
export class ComputerApprovalVerifier {
  /** A fixed key is parsed at construction; a deferred one is read when a signature is checked (see constructor). */
  private readonly key: KeyObject | (() => Uint8Array);
  /** `generation` is the caller credential the request belongs to; a reused session ID has another one. */
  private requests = new Map<string, ComputerApprovalRequest & {label: string; generation: string}>();
  private used = new Map<string, number>();
  /**
   * `helperPublicKey`: the helper's approval key as its X9.63 point, or a function returning it. AgentsToZ Control
   * creates that key at the person's first approval and hands its public point over only in `approval-status`
   * answers of the code-signing-verified connection (native/computer-use/CONTRACT.md), so a deferred key is read
   * only at `redeem`'s signature check, after every other check, never at construction or `request`. The function
   * must return only that answer's key, never one from disk, the environment or an agent; a key it cannot give or
   * that does not parse refuses the approval.
   */
  constructor(private readonly options: {helperPublicKey: Uint8Array | (() => Uint8Array); now?: () => number}) {
    const key = options.helperPublicKey;
    this.key = typeof key === 'function' ? key : computerApprovalKey(key);
  }
  private helperKey(): KeyObject {
    if (typeof this.key !== 'function') return this.key;
    let point: unknown;
    try {point = this.key();} catch {throw Error(NO_KEY);}
    if (!(point instanceof Uint8Array)) throw Error(NO_KEY);
    try {return computerApprovalKey(point);} catch {throw Error(NO_KEY);}
  }
  private now() {return (this.options.now ?? Date.now)();}
  private prune() {
    const now = this.now();
    for (const [id, r] of this.requests)
      if (r.expiresAt + L.skewMs < now || !isLiveComputerCallerGeneration(r.generation)) this.requests.delete(id);
    for (const [id, expires] of this.used) if (expires + L.skewMs < now) this.used.delete(id);
  }
  request(caller: AuthenticatedComputerCaller, target: unknown, label: string): ComputerApprovalRequest {
    const generation = computerCallerGeneration(caller);
    if (!generation) throw Error('인증된 작업 세션이 필요합니다.');
    const t = parseComputerTarget(target);
    if (typeof label !== 'string' || !label.trim() || label.length > 100) throw Error('허용할 작업 이름을 확인하세요.');
    this.prune();
    if (this.requests.size >= L.pending) throw Error('승인을 기다리는 요청이 너무 많습니다. 기존 요청을 끝낸 뒤 다시 요청하세요.');
    const request: ComputerApprovalRequest = {approvalId: randomBytes(32).toString('hex'), target: {...t},
      caller: {sessionId: caller.sessionId, lane: caller.lane}, expiresAt: this.now() + L.approvalMs};
    this.requests.set(request.approvalId, {...request, target: {...t}, caller: {...request.caller}, label: label.trim(), generation});
    return {...request, target: {...request.target}, caller: {...request.caller}};
  }
  cancel(approvalId: string) {this.requests.delete(approvalId);}
  /** A Workroom session that ended takes its open approval requests with it; a later signature for one is refused. */
  cancelSession(sessionId: string) {for (const [id, r] of this.requests) if (r.caller.sessionId === sessionId) this.requests.delete(id);}
  /** Checks without spending the approval. Only a known pre-dispatch bind refusal may leave it pending. */
  verify(value: unknown): {approvalId: string; target: ComputerTarget; caller: ComputerCaller; label: string; generation: string} {
    if (typeof value === 'boolean') throw Error('사람 승인 서명이 필요합니다. 확인 여부 값만으로는 허용하지 않습니다.');
    const a = parseComputerApproval(value); this.prune();
    if (this.used.has(a.approvalId)) throw Error('이미 사용한 승인입니다. 새로 승인받아야 합니다.');
    const request = this.requests.get(a.approvalId);
    if (!request) throw Error('이 승인에 맞는 요청이 없습니다. 요청이 끝났거나 작업 세션이 끝났습니다.');
    const now = this.now();
    if (now > request.expiresAt || a.expiresAt !== request.expiresAt || a.issuedAt > now + L.skewMs
      || a.issuedAt < request.expiresAt - L.approvalMs - L.skewMs) throw Error('승인 시간이 지났거나 맞지 않습니다. 새로 승인받아야 합니다.');
    if (!sameTarget(a.target, request.target) || !sameComputerCaller(a.caller, request.caller))
      throw Error('승인한 대상이나 작업 세션이 요청과 다릅니다.');
    if (!verifyComputerApprovalSignature(a, this.helperKey())) throw Error(DENIED);
    return {approvalId: a.approvalId, target: {...request.target}, caller: {...request.caller}, label: request.label,
      generation: request.generation};
  }
  redeem(value: unknown) {
    const verified = this.verify(value);
    const request = this.requests.get(verified.approvalId)!;
    this.requests.delete(verified.approvalId); this.used.set(verified.approvalId, request.expiresAt);
    return verified;
  }
}
