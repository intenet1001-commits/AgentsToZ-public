import { isPreparationTool, ONBOARDING_PROGRESS_PATH } from './onboardingProgress';
import type { OnboardingProgressStore } from './onboardingProgressStore';
import type { OnboardingPlatform, OnboardingToolDiagnostic } from './onboardingInfrastructure';

export async function inputBody(req: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '') || req.headers.has('content-encoding')) throw new Error('ONBOARDING_INVALID_INPUT');
  const reader = req.body?.getReader();
  if (!reader) throw new Error('ONBOARDING_INVALID_INPUT');
  const bytes = new Uint8Array(4096);
  let size = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      for (;;) {
        const {value, done} = await reader.read();
        if (stopped) throw new Error('ONBOARDING_BODY_TIMEOUT');
        if (done) break;
        if (size + value.length > bytes.length) throw new Error('ONBOARDING_BODY_TOO_LARGE');
        bytes.set(value, size); size += value.length;
      }
      let input: unknown;
      try { input = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0,size))); }
      catch { throw new Error('ONBOARDING_INVALID_INPUT'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('ONBOARDING_INVALID_INPUT');
      return input as Record<string, unknown>;
    };
    return await Promise.race([read(), new Promise<never>((_,reject) => {
      timer = setTimeout(() => reject(new Error('ONBOARDING_BODY_TIMEOUT')), 5000);
    })]);
  } finally {
    stopped = true; clearTimeout(timer); bytes.fill(0);
    void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* pending cancel */ }
  }
}

/** Behind localhost Host/Origin middleware. Stores selections and read-only evidence,
 * not installation authority. A future installer needs its own capability gate. */
export async function handleOnboardingProgress(req: Request, options: {
  store: () => OnboardingProgressStore;
  platform: OnboardingPlatform;
  diagnose: () => Promise<OnboardingToolDiagnostic[]>;
}, responseHeaders: HeadersInit = {}): Promise<Response> {
  const headers = new Headers(responseHeaders);
  headers.set('Content-Type','application/json'); headers.set('Cache-Control','no-store');
  const json = (body: unknown, status=200) => new Response(JSON.stringify(body), {status,headers});
  try {
    const url = new URL(req.url);
    if (url.pathname !== ONBOARDING_PROGRESS_PATH || url.search || url.hash) throw new Error('ONBOARDING_INVALID_INPUT');
    if (req.method === 'GET') return json({success: true, progress: options.store().read()});
    if (req.method !== 'POST') {headers.set('Allow','GET, POST'); return json({error:'허용되지 않은 요청입니다.'},405);}
    const input = await inputBody(req);
    const keys = input.operation === 'plan' ? ['operation','expectedRevision','tools']
      : input.operation === 'defer' ? ['operation','expectedRevision','tool','deferred'] : ['operation','expectedRevision'];
    if (Object.keys(input).length !== keys.length || keys.some(k => !Object.hasOwn(input,k))
      || typeof input.expectedRevision !== 'string' || input.expectedRevision.length > 36) throw new Error('ONBOARDING_INVALID_INPUT');
    const store = options.store();
    if (input.operation === 'plan') return json({success:true, progress:store.plan(input.expectedRevision,options.platform,input.tools)});
    if (input.operation === 'defer' && isPreparationTool(input.tool) && typeof input.deferred === 'boolean') {
      return json({success:true, progress:store.defer(input.expectedRevision,input.tool,input.deferred)});
    }
    if (input.operation !== 'check') throw new Error('ONBOARDING_INVALID_INPUT');
    const started = store.beginCheck(input.expectedRevision);
    let diagnostics: OnboardingToolDiagnostic[];
    try { diagnostics = await options.diagnose(); } catch { diagnostics = []; }
    return json({success:true, progress:store.finishCheck(started,diagnostics)});
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const messages: Record<string,[number,string]> = {
      ONBOARDING_INVALID_INPUT:[400,'준비 요청을 확인하지 못했습니다.'],
      ONBOARDING_BODY_TOO_LARGE:[413,'준비 요청이 너무 큽니다.'],
      ONBOARDING_BODY_TIMEOUT:[408,'요청을 받는 시간이 초과됐습니다.'],
      ONBOARDING_REVISION_CONFLICT:[409,'다른 창에서 준비 상태가 바뀌었습니다. 다시 읽고 이어가세요.'],
      ONBOARDING_CHECK_RUNNING:[409,'이전 확인이 진행 중입니다. 잠시 후 상태를 다시 읽어 주세요.'],
      ONBOARDING_SCHEMA_UNSUPPORTED:[503,'더 새로운 준비 기록입니다. 앱을 업데이트해 주세요.'],
    };
    const [status, message] = messages[code] ?? [503,'준비 기록을 확인하지 못했습니다. 기존 기록은 유지됩니다.'];
    if (status === 408 || status === 413) headers.set('Connection','close');
    return json({success:false, code:messages[code]?code:'ONBOARDING_PROGRESS_UNAVAILABLE',error:message},status);
  }
}
