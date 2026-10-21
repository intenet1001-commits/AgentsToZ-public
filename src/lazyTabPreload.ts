/**
 * 자주 여는 lazy 탭의 청크를 첫 화면이 뜬 뒤 유휴 시간에 미리 데운다.
 *
 * 왜: 탭을 처음 누르면 `React.lazy`가 Suspense로 멈추고, React 19는 폴백을 보인 뒤 내용 공개를
 * 300ms 늦춘다(FALLBACK_THROTTLE_MS). 청크 자체는 ~10ms에 도착하는데 북마크 첫 카드가 326ms에
 * 떴다(2026-10-08 `bun run perf:baseline -- --only ui`, `ui.bookmarks.first-card`).
 *
 * ⚠️ **모듈을 미리 import 하는 것만으로는 아무 것도 바뀌지 않는다**(실측: 5초 미리 데워도 328ms).
 * `React.lazy`는 첫 렌더에 팩토리를 부르고 그 반환값이 `.then` 콜백을 **그 자리에서** 부르지 않으면
 * 멈춘다(react 19.2 `lazyInitializer`: `ctor().then(cb)` 직후 `_status`를 본다). 새 `import()`
 * promise 는 이미 풀린 모듈이라도 콜백을 다음 마이크로태스크에 부르므로 매번 멈춘다. 그래서
 * `preloadableModule`은 받아 둔 모듈을 **동기 thenable**로 돌려준다 — lazy 가 받는 공개 계약
 * (thenable)만 쓰고 React 내부 필드는 건드리지 않는다.
 *
 * ⚠️ 컴포넌트를 바꿔 끼우지 않는다 — lazy 에 넘기는 팩토리가 같은 모듈을 돌려줄 뿐이다.
 * 열려 있는 동안 컴포넌트 종류가 바뀌면 React가 그 트리를 다시 마운트한다.
 * 실패는 삼킨다: 미리 데우기는 최적화일 뿐이고, 실제 탭 진입이 같은 로더를 다시 부른다.
 */
export type PreloadLoader = () => Promise<unknown>;

export type PreloadableModule<T> = {
  /** 유휴 미리 데우기가 부른다. 같은 요청을 공유하고, 실패하면 다음 호출이 다시 시도한다. */
  preload: () => Promise<T>;
  /** `lazy(module.factory)` — 받아 둔 뒤에는 동기 thenable 이라 첫 렌더가 멈추지 않는다. */
  factory: () => Promise<T>;
  /** 테스트용: 모듈을 이미 받아 두었는가. */
  ready: () => boolean;
};

export function preloadableModule<T>(loader: () => Promise<T>): PreloadableModule<T> {
  let loaded: {value: T} | null = null;
  let inflight: Promise<T> | null = null;
  const preload = () => {
    if (loaded) return Promise.resolve(loaded.value);
    inflight ??= loader().then(
      value => { loaded = {value}; return value; },
      error => { inflight = null; throw error; },
    );
    return inflight;
  };
  const factory = () => {
    if (!loaded) return preload();
    const value = loaded.value;
    // React.lazy 는 반환값의 `.then`만 쓴다. 콜백을 즉시 불러 첫 렌더에서 바로 내용을 받게 한다.
    const settled = {then: (onFulfilled?: (v: T) => unknown) => (onFulfilled ? onFulfilled(value) : value)};
    return settled as unknown as Promise<T>;
  };
  return {preload, factory, ready: () => loaded !== null};
}

export type IdleHost = {
  requestIdleCallback?: (callback: () => void, options?: {timeout: number}) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/** requestIdleCallback이 없으면(WebKit 일부) 이만큼 기다렸다가 부른다. */
export const PRELOAD_FALLBACK_DELAY_MS = 1_500;
/** 유휴가 오지 않아도 이 시간 안에는 부른다. */
export const PRELOAD_IDLE_TIMEOUT_MS = 4_000;

/**
 * 로더를 하나씩, 앞의 것이 끝난 뒤 다음 유휴 시간에 부른다(한꺼번에 부르면 첫 화면 직후의
 * 메인 스레드를 여러 청크 평가가 동시에 차지한다). 반환값은 아직 부르지 않은 것을 취소한다.
 */
export function scheduleIdlePreload(loaders: readonly PreloadLoader[], host: IdleHost = globalThis as unknown as IdleHost): () => void {
  let cancelled = false;
  let pending: {idle?: number; timer?: unknown} = {};
  const wait = (next: () => void) => {
    if (typeof host.requestIdleCallback === 'function') {
      pending = {idle: host.requestIdleCallback(next, {timeout: PRELOAD_IDLE_TIMEOUT_MS})};
    } else {
      pending = {timer: host.setTimeout(next, PRELOAD_FALLBACK_DELAY_MS)};
    }
  };
  const step = (index: number) => {
    if (cancelled || index >= loaders.length) return;
    wait(() => {
      if (cancelled) return;
      let settled: Promise<unknown>;
      try { settled = Promise.resolve(loaders[index]!()); } catch { settled = Promise.resolve(); }
      settled.catch(() => undefined).finally(() => step(index + 1));
    });
  };
  step(0);
  return () => {
    cancelled = true;
    if (pending.idle !== undefined) host.cancelIdleCallback?.(pending.idle);
    if (pending.timer !== undefined) host.clearTimeout(pending.timer);
  };
}
