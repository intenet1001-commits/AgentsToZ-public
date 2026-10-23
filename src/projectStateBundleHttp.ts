import type {ProjectStateBundleHost} from './projectStateBundleHost';
import {ProjectStateError} from './projectStateBundle';

export const PROJECT_STATE_PATH = '/api/agent-runtime/project-state';
export const PROJECT_STATE_CONTROL_BYTES = 4 * 1024;
export const PROJECT_STATE_RESPONSE_BYTES = 32 * 1024;

class RequestError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

async function readControl(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
    || req.headers.get('content-encoding') && req.headers.get('content-encoding') !== 'identity') {
    throw new RequestError('PROJECT_STATE_JSON_REQUIRED', 415);
  }
  const length = req.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > PROJECT_STATE_CONTROL_BYTES)) {
    throw new RequestError('PROJECT_STATE_BODY_TOO_LARGE', 413);
  }
  const reader = req.body?.getReader();
  if (!reader) throw new RequestError('PROJECT_STATE_INVALID_INPUT', 400);
  const bytes = new Uint8Array(PROJECT_STATE_CONTROL_BYTES);
  let size = 0, finished = false, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RequestError('PROJECT_STATE_BODY_TIMEOUT', 408)), 2_000);
    abort = () => reject(new RequestError('PROJECT_STATE_CANCELLED', 408));
    req.signal.addEventListener('abort', abort, {once: true});
    if (req.signal.aborted) abort();
  });
  try {
    const body = async () => {
      for (;;) {
        const part = await reader.read();
        if (stopped) throw new RequestError('PROJECT_STATE_CANCELLED', 408);
        if (part.done) break;
        if (size + part.value.byteLength > bytes.length) throw new RequestError('PROJECT_STATE_BODY_TOO_LARGE', 413);
        bytes.set(part.value, size); size += part.value.byteLength;
      }
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, size))); }
      catch { throw new RequestError('PROJECT_STATE_INVALID_INPUT', 400); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError('PROJECT_STATE_INVALID_INPUT', 400);
      return value as Record<string, unknown>;
    };
    const result = await Promise.race([body(), deadline]); finished = true;
    return result;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (abort) req.signal.removeEventListener('abort', abort);
    if (!finished) void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A cancelled pending read may still be settling. */ }
    bytes.fill(0);
  }
}

/** The app's exact local Agent Runtime capability/origin gate must run before this handler. */
export async function handleProjectStateBundleRequest(req: Request, host: Pick<ProjectStateBundleHost, 'preview' | 'prepare'>,
  owner: string, responseHeaders: HeadersInit = {}): Promise<Response> {
  const headers = new Headers(responseHeaders);
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  try {
    const url = new URL(req.url);
    if (url.pathname !== PROJECT_STATE_PATH || url.search || req.url.includes('?') || url.hash) throw new RequestError('PROJECT_STATE_ROUTE_DENIED', 404);
    if (req.method !== 'POST') throw new RequestError('PROJECT_STATE_METHOD_DENIED', 405);
    if (owner !== 'local') throw new RequestError('PROJECT_STATE_LOCAL_ONLY', 403);
    const {operation, ...input} = await readControl(req);
    const result = operation === 'preview' ? {bundle: await host.preview(owner, input as never, req.signal)}
      : operation === 'prepare' ? {prepared: await host.prepare(owner, input as never, req.signal)}
      : (() => { throw new RequestError('PROJECT_STATE_OPERATION_DENIED', 400); })();
    const body = JSON.stringify({success: true, ...result});
    if (new TextEncoder().encode(body).byteLength > PROJECT_STATE_RESPONSE_BYTES) throw new RequestError('PROJECT_STATE_RESPONSE_TOO_LARGE', 413);
    return new Response(body, {headers});
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      && /^PROJECT_STATE_[A-Z_]+$/.test(error.code) ? error.code : 'PROJECT_STATE_UNAVAILABLE';
    const status = error instanceof RequestError || error instanceof ProjectStateError
      ? error.status : 409;
    if (status === 405) headers.set('Allow', 'POST');
    if (status === 413 || status === 408) {
      headers.set('Connection', 'close');
      if (req.body && !req.body.locked) void req.body.cancel().catch(() => undefined);
    }
    return Response.json({success: false, code, error: '프로젝트 상태를 확인하지 못했습니다. 대상과 선택 항목을 확인하고 새로 조회하세요.'}, {status, headers});
  }
}
