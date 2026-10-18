/**
 * 「내가 한 말」의 Supabase 왕복을 줄이는 세 장치. 전부 순수 상태 기계라 시계를
 * 주입받는다 — 타이머도 네트워크도 여기에는 없다.
 *
 * 1. `WhatISaidRemoteBreaker` — 원격이 한 번 실패하면 일정 시간 원격을 건너뛴다.
 *    15초 순환 수집과 라이브러리 목록이 **같은 차단기**를 본다. 그렇지 않으면 장애 중에
 *    목록 요청마다 8초 타임아웃을 다시 기다리고, 순환 수집은 회복 중인 DB를 계속 두드린다.
 * 2. `WhatISaidTtlCache` — 제외 목록·클라우드 범위처럼 거의 안 바뀌는 메타데이터를
 *    짧게(60초) 들고 있는다. 실패는 캐시하지 않는다(fail-closed 는 호출부 책임).
 * 3. `WhatISaidRemotePushGate` — 새로 저장된 것이 없고 로컬 seq 도 올린 지점을 넘지
 *    않았으면 순환 수집이 원격 적재를 아예 시작하지 않는다. 한동안(기본 1시간)
 *    확인하지 않았으면 한 번 확인한다 — 다른 경로로 원격 커서가 뒤로 갔을 수 있다.
 */

export type Clock = () => number;

export interface WhatISaidRemoteBreakerOptions {
  baseMs?: number;
  maxMs?: number;
  now?: Clock;
}

export class WhatISaidRemoteBreaker {
  readonly #baseMs: number;
  readonly #maxMs: number;
  readonly #now: Clock;
  #failures = 0;
  #openUntil = 0;

  constructor(options: WhatISaidRemoteBreakerOptions = {}) {
    this.#baseMs = options.baseMs ?? 15_000;
    this.#maxMs = options.maxMs ?? 600_000;
    this.#now = options.now ?? Date.now;
  }

  /** 열려 있으면 원격을 부르지 않는다. */
  isOpen(): boolean {
    return this.#openUntil > this.#now();
  }

  /** 다시 시도할 수 있는 시각(ms). 닫혀 있으면 null. */
  retryAt(): number | null {
    return this.isOpen() ? this.#openUntil : null;
  }

  consecutiveFailures(): number {
    return this.#failures;
  }

  recordFailure(): void {
    this.#failures += 1;
    const exponent = Math.min(this.#failures - 1, 30);
    const delay = Math.min(this.#maxMs, this.#baseMs * 2 ** exponent);
    this.#openUntil = this.#now() + delay;
  }

  recordSuccess(): void {
    this.#failures = 0;
    this.#openUntil = 0;
  }
}

export class WhatISaidTtlCache<T> {
  readonly #ttlMs: number;
  readonly #now: Clock;
  #value: { at: number; value: T } | null = null;
  #inFlight: Promise<T> | null = null;
  #generation = 0;

  constructor(ttlMs: number, now: Clock = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /** 신선한 값이 있으면 돌려주고, 없으면 loader 를 한 번만 부른다(동시 호출 합류). */
  async get(loader: () => Promise<T>): Promise<T> {
    const cached = this.#value;
    if (cached && this.#now() - cached.at < this.#ttlMs) return cached.value;
    if (this.#inFlight) return this.#inFlight;
    const generation = this.#generation;
    let started: Promise<T>;
    try {
      started = loader();
    } catch (error) {
      return Promise.reject(error);
    }
    const pending: Promise<T> = started.then(
      value => {
        // 읽는 사이 무효화됐다면 이 값은 무효화 이전 상태일 수 있다 — 돌려주되 저장하지 않는다.
        if (generation === this.#generation) this.#value = { at: this.#now(), value };
        if (this.#inFlight === pending) this.#inFlight = null;
        return value;
      },
      error => {
        if (this.#inFlight === pending) this.#inFlight = null;
        throw error;
      },
    );
    this.#inFlight = pending;
    return pending;
  }

  invalidate(): void {
    this.#generation += 1;
    this.#value = null;
    this.#inFlight = null;
  }
}

function compareSeq(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a === b ? 0 : a > b ? 1 : -1;
}

const SEQ = /^(?:0|[1-9][0-9]*)$/;

export interface WhatISaidPushDecisionInput {
  /** 이번 수집에서 새로 저장한 행 수. */
  stored: number;
  /** 로컬 저장소의 최대 seq. 읽지 못했으면 null(=모름). */
  localMaxSeq: string | null;
}

export class WhatISaidRemotePushGate {
  readonly #verifyIntervalMs: number;
  readonly #now: Clock;
  readonly #state = new Map<string, { pushedThroughSeq: string | null; verifiedAt: number }>();

  constructor(options: { verifyIntervalMs?: number; now?: Clock } = {}) {
    this.#verifyIntervalMs = options.verifyIntervalMs ?? 3_600_000;
    this.#now = options.now ?? Date.now;
  }

  shouldPush(memoryId: string, input: WhatISaidPushDecisionInput): boolean {
    if (input.stored > 0) return true;
    const state = this.#state.get(memoryId);
    // 이 프로세스에서 한 번도 올린 적이 없다 — 재시작 직후 밀린 분이 있을 수 있다.
    if (!state) return true;
    if (this.#now() - state.verifiedAt >= this.#verifyIntervalMs) return true;
    // 모르면 확인 주기까지 기다린다. 손상된 저장소 하나가 15초마다 왕복을 만들면 안 된다.
    if (input.localMaxSeq === null || !SEQ.test(input.localMaxSeq)) return false;
    if (state.pushedThroughSeq === null) return input.localMaxSeq !== '0';
    return compareSeq(input.localMaxSeq, state.pushedThroughSeq) > 0;
  }

  /** 적재를 시작하기 **전에** 읽은 로컬 최대 seq 를 넘긴다. 적재 중 들어온 행은 다음에 잡힌다. */
  recordSuccess(memoryId: string, localMaxSeqAtStart: string | null): void {
    const valid = localMaxSeqAtStart !== null && SEQ.test(localMaxSeqAtStart) ? localMaxSeqAtStart : null;
    this.#state.set(memoryId, { pushedThroughSeq: valid, verifiedAt: this.#now() });
  }

  /** 실패하면 기록을 지운다 — 다음 기회에 다시 올린다(차단기가 간격을 정한다). */
  recordFailure(memoryId: string): void {
    this.#state.delete(memoryId);
  }

  invalidate(memoryId?: string): void {
    if (memoryId === undefined) this.#state.clear();
    else this.#state.delete(memoryId);
  }
}

/** 최소 간격 이상 지났을 때만 true — 만료분 정리 RPC 처럼 매번 할 필요 없는 일에 쓴다. */
export class WhatISaidIntervalGate {
  readonly #intervalMs: number;
  readonly #now: Clock;
  #lastAt: number | null = null;

  constructor(intervalMs: number, now: Clock = Date.now) {
    this.#intervalMs = intervalMs;
    this.#now = now;
  }

  tryEnter(): boolean {
    const now = this.#now();
    if (this.#lastAt !== null && now - this.#lastAt < this.#intervalMs) return false;
    this.#lastAt = now;
    return true;
  }
}

export interface WhatISaidPushOutcome {
  skipped: string | null;
  error: string | null;
  pushed: number;
  /** 실패가 이 Mac 안(로컬 저장소 읽기·복호화·레닥션)에서 났다. */
  localFailure?: boolean;
  /** 밀린 분을 끝까지 올렸다. 페이지 상한에서 멈췄으면 false. */
  complete?: boolean;
}

/**
 * 적재 결과를 차단기·게이트에 반영한다. 건너뛴 적재는 아무것도 증명하지 않는다.
 * - 로컬 실패는 원격 장애의 증거가 아니므로 **공유 차단기를 열지 않는다.** 열면 저장소
 *   하나의 문제가 라이브러리 전체를 「Supabase 가 응답하지 않는다」로 거짓 보고한다.
 * - 페이지 상한에서 멈춘 적재는 "여기까지 올렸다"로 기록하지 않는다. 기록하면 남은 분이
 *   확인 주기(1시간)까지 멈춘다.
 * 반환값: 원격이 성공적으로 응답했는가(호출부가 캐시 무효화 등에 쓴다).
 */
export function applyWhatISaidPushOutcome(
  targets: { breaker: WhatISaidRemoteBreaker; gate: WhatISaidRemotePushGate },
  memoryId: string,
  localMaxSeqAtStart: string | null,
  push: WhatISaidPushOutcome,
): boolean {
  if (push.error) {
    if (!push.localFailure) targets.breaker.recordFailure();
    targets.gate.recordFailure(memoryId);
    return false;
  }
  if (push.skipped) return false;
  targets.breaker.recordSuccess();
  if (push.complete === false) targets.gate.recordFailure(memoryId);
  else targets.gate.recordSuccess(memoryId, localMaxSeqAtStart);
  return true;
}
