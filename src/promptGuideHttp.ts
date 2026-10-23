import { PromptGuideError, normalizePromptGuideSave, type PromptGuideStore } from './promptGuideStore';

// Includes expectedRevision and the JSON envelope; matches the native proxy ceiling.
export const PROMPT_GUIDES_HTTP_MAX_BYTES = 1024 * 1024;
export const PROMPT_GUIDES_HTTP_BODY_TIMEOUT_MS = 5_000;
const LIST_PATH = '/api/what-i-said/guides/list';
const SAVE_PATH = '/api/what-i-said/guides/save';
const errors: Readonly<Record<string, { status: number; error: string }>> = {
  PROMPT_GUIDES_NOT_FOUND: { status: 404, error: '프롬프트 가이드 요청 경로가 올바르지 않습니다.' },
  PROMPT_GUIDES_METHOD_NOT_ALLOWED: { status: 405, error: '프롬프트 가이드 요청은 POST 방식만 허용됩니다.' },
  PROMPT_GUIDES_INVALID_INPUT: { status: 400, error: '프롬프트 가이드 입력 형식이 올바르지 않습니다. 작성 중인 초안은 유지됩니다.' },
  PROMPT_GUIDES_JSON_REQUIRED: { status: 415, error: '프롬프트 가이드 요청은 압축하지 않은 JSON 형식이어야 합니다.' },
  PROMPT_GUIDES_BODY_TOO_LARGE: { status: 413, error: '프롬프트 가이드 요청 용량이 너무 큽니다. 작성 중인 초안은 유지됩니다.' },
  PROMPT_GUIDES_BODY_TIMEOUT: { status: 408, error: '프롬프트 가이드 요청 본문을 받는 시간이 초과되었습니다. 저장을 시작하지 않았습니다.' },
  PROMPT_GUIDES_LIMIT_EXCEEDED: { status: 413, error: '프롬프트 가이드 전체 저장 용량 1 MiB를 넘었습니다. 작성 중인 초안은 유지됩니다.' },
  PROMPT_GUIDES_CONFLICT: { status: 409, error: '다른 창에서 가이드 목록이 바뀌었습니다. 목록을 다시 읽어 비교해 주세요. 현재 초안은 유지됩니다.' },
  PROMPT_GUIDES_LOCKED: { status: 423, error: '다른 작업이 프롬프트 가이드를 저장하고 있습니다. 잠시 후 다시 시도해 주세요.' },
  PROMPT_GUIDES_LOCK_LOST: { status: 409, error: '프롬프트 가이드 저장 권한을 확인하지 못했습니다. 목록을 다시 읽어 주세요. 현재 초안은 유지됩니다.' },
  PROMPT_GUIDES_RESULT_UNCERTAIN: { status: 503, error: '프롬프트 가이드 저장 결과를 확인해야 합니다. 목록을 다시 읽어 비교해 주세요. 현재 초안은 유지됩니다.' },
  PROMPT_GUIDES_RECOVERY_REQUIRED: { status: 503, error: '프롬프트 가이드 저장소의 복구 확인이 필요합니다. 기존 파일과 현재 초안은 유지됩니다.' },
  PROMPT_GUIDES_CORRUPT: { status: 503, error: '저장한 프롬프트 가이드를 읽을 수 없습니다. 기존 파일과 현재 초안은 유지됩니다.' },
  PROMPT_GUIDES_SCHEMA_UNSUPPORTED: { status: 503, error: '더 새로운 프롬프트 가이드 저장 형식입니다. 앱을 업데이트해 주세요. 기존 파일은 유지됩니다.' },
  PROMPT_GUIDES_PATH_UNSAFE: { status: 503, error: '프롬프트 가이드 저장 경로를 확인할 수 없습니다. 기존 파일과 현재 초안은 유지됩니다.' },
  PROMPT_GUIDES_FILE_TOO_LARGE: { status: 503, error: '프롬프트 가이드 저장 파일의 크기를 확인해야 합니다. 기존 파일과 현재 초안은 유지됩니다.' },
  PROMPT_GUIDES_KEY_MISSING: { status: 503, error: '프롬프트 가이드 암호화 키를 찾을 수 없습니다. 기존 키나 파일을 새로 덮어쓰지 않습니다.' },
  PROMPT_GUIDES_KEY_UNAVAILABLE: { status: 503, error: '이 기기의 프롬프트 가이드 암호화 키에 접근할 수 없습니다. 잠금 상태를 확인한 뒤 다시 시도해 주세요.' },
  PROMPT_GUIDES_KEY_MALFORMED: { status: 503, error: '프롬프트 가이드 암호화 키를 확인할 수 없습니다. 기존 키와 파일은 유지됩니다.' },
  PROMPT_GUIDES_KEY_UNSUPPORTED: { status: 503, error: '이 운영체제에서는 프롬프트 가이드 암호화 저장을 지원하지 않습니다.' },
  PROMPT_GUIDES_UNAVAILABLE: { status: 503, error: '프롬프트 가이드 요청 결과를 확인하지 못했습니다. 목록을 다시 읽어 주세요. 현재 초안은 유지됩니다.' },
};

function fail(code: string): never { throw new PromptGuideError(code); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** Bound the raw request before JSON allocation, validation or OS credentials. */
async function readJson(req: Request, maximum: number): Promise<unknown> {
  const contentType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const encoding = req.headers.get('content-encoding')?.trim().toLowerCase();
  if (contentType !== 'application/json' || (encoding && encoding !== 'identity')) fail('PROMPT_GUIDES_JSON_REQUIRED');
  const declared = req.headers.get('content-length');
  let length: number | undefined;
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) fail('PROMPT_GUIDES_INVALID_INPUT');
    length = Number(declared);
    if (length > maximum) fail('PROMPT_GUIDES_BODY_TOO_LARGE');
  }
  const reader = req.body?.getReader();
  if (!reader) fail('PROMPT_GUIDES_INVALID_INPUT');
  // A million one-byte chunks still occupy one bounded buffer, not a million objects.
  const bytes = new Uint8Array(maximum);
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PromptGuideError('PROMPT_GUIDES_BODY_TIMEOUT')), PROMPT_GUIDES_HTTP_BODY_TIMEOUT_MS);
    aborted = () => reject(new PromptGuideError('PROMPT_GUIDES_INVALID_INPUT'));
    req.signal.addEventListener('abort', aborted, { once: true });
    if (req.signal.aborted) aborted();
  });
  let completed = false;
  let stopped = false;
  try {
    // Race once, rather than retaining a deadline reaction for every tiny chunk.
    const body = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (stopped) fail('PROMPT_GUIDES_INVALID_INPUT');
        if (done) break;
        if (size + value.byteLength > maximum) fail('PROMPT_GUIDES_BODY_TOO_LARGE');
        bytes.set(value, size); size += value.byteLength;
      }
      if (length !== undefined && length !== size) fail('PROMPT_GUIDES_INVALID_INPUT');
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
      catch { fail('PROMPT_GUIDES_INVALID_INPUT'); }
    };
    const value = await Promise.race([body(), deadline]);
    completed = true;
    return value;
  } catch (error) {
    if (error instanceof PromptGuideError) throw error;
    fail('PROMPT_GUIDES_INVALID_INPUT');
  } finally {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    if (aborted) req.signal.removeEventListener('abort', aborted);
    bytes.fill(0);
    if (!completed) void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* pending cancelled read must not delay the response */ }
  }
}

/** Called only after the existing What I Said management capability gate. */
export async function handlePromptGuideRequest(
  req: Request,
  store: Pick<PromptGuideStore, 'read' | 'save'>,
  responseHeaders: HeadersInit = {},
): Promise<Response> {
  const headers = new Headers(responseHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  try {
    const url = new URL(req.url);
    if (url.pathname !== LIST_PATH && url.pathname !== SAVE_PATH) fail('PROMPT_GUIDES_NOT_FOUND');
    if (req.method !== 'POST') fail('PROMPT_GUIDES_METHOD_NOT_ALLOWED');
    if (url.search || req.url.includes('?') || url.hash) fail('PROMPT_GUIDES_INVALID_INPUT');
    const input = await readJson(req, url.pathname === LIST_PATH ? 1024 : PROMPT_GUIDES_HTTP_MAX_BYTES);
    let snapshot;
    if (url.pathname === LIST_PATH) {
      if (!object(input) || Object.keys(input).length !== 0) fail('PROMPT_GUIDES_INVALID_INPUT');
      snapshot = await store.read();
    } else snapshot = await store.save(normalizePromptGuideSave(input));
    return new Response(JSON.stringify({ success: true, ...snapshot }), { headers });
  } catch (error) {
    const requestedCode = error instanceof PromptGuideError ? error.code : '';
    const code = Object.hasOwn(errors, requestedCode) ? requestedCode : 'PROMPT_GUIDES_UNAVAILABLE';
    const detail = errors[code]!;
    if (detail.status === 405) headers.set('Allow', 'POST');
    // A size rejection can precede body consumption. Do not pool this HTTP/1
    // connection with unread upload bytes: Bun can stall the next request on it.
    // A timed-out upload must not hold a reusable connection open either.
    if (detail.status === 413 || detail.status === 408) {
      headers.set('Connection', 'close');
      // Early Content-Length rejection has not acquired a reader. Tell the
      // transport to stop the upload as well; the response header alone can
      // leave Bun's incoming body pending and stall the next pooled request.
      if (req.body && !req.body.locked) void req.body.cancel().catch(() => {});
    }
    return new Response(JSON.stringify({ success: false, code, error: detail.error }), { status: detail.status, headers });
  }
}
